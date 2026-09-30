# dsh-codebase-memory

English | [简体中文](README.zh.md)

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) host bundle that wires [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) into your agent sessions: **it builds a code knowledge graph of the current session workspace and lets the model retrieve code through the graph — instead of grepping file by file**.

## Table of contents

- [How the chain is composed](#how-the-chain-is-composed)
- [Why this plugin exists](#why-this-plugin-exists)
- [Install](#install)
- [Usage](#usage) — including [prompting recipes](#3-prompting-recipes-what-actually-triggers-it), an [AGENTS.md template](#4-encoding-it-in-agentsmd-make-it-permanent), and [versioned skills](#5-skills-live-in-this-repo)
- [How DSH finds it, and how the model starts using it](#how-dsh-finds-it-and-how-the-model-starts-using-it)
- [Engine compatibility (what happens when codebase-memory-mcp changes)](#engine-compatibility-what-happens-when-codebase-memory-mcp-changes)
- [Configuration](#configuration-optional)
- [Verification](#verification)
- [Troubleshooting](#troubleshooting)
- [Engineering notes](#engineering-notes-for-whoever-modifies-it)
- [Known limitations & non-goals](#known-limitations--non-goals)

## How the chain is composed

```
DSH host composition (two rows inserted by this bundle's cordis.patch.yml)
├─ ④ dsh-codebase-memory          this plugin: bootstraps dependencies, pins the indexed
│                                 workspace to the session, and tells the model how to use it
└─ ③ @deepseek-ai/dsh-mcp-client  the official MCP bridge → the model sees exactly one proxy tool
      └─ ② @njuptlzf/mcp-adapter  token-compression layer: 17 tool schemas → 1 proxy tool
            │                     (auto-bootstrapped by the plugin, version-pinned)
            └─ ① codebase-memory-mcp  the engine: 162-language tree-sitter + Hybrid LSP + knowledge graph
                                      (installed manually)
```

All four are existing components — **none of them is forked or modified**. The plugin only bootstraps ②, writes ③'s server manifest, and pins ①'s entry point to the session workspace.

## Why this plugin exists

**DSH is a multi-session host, but an MCP server process has exactly one cwd.**

codebase-memory-mcp ships `auto_index` / `auto_watch`, yet they can only ever see *their own process cwd*. In DSH every session shares one MCP process — which session's workspace should be indexed? The engine cannot answer that by itself.

So `repo_path` must be injected by something that lives inside the DSH process and can read the session header. That is the entire reason this plugin exists:

```js
// index.js — the single place that decides "what gets indexed"
const cwd = exec.agent?.session?.header?.cwd
```

The model **never gets to pass `repo_path`**: `code_index` has no such parameter, and `index_repository` is removed from the tool surface (`excludeTools`). A hallucinated path cannot poison the index — this is the most important constraint in the whole design.

## Install

### 1. The indexing engine (manual, one-time)

Binaries are never auto-downloaded — the security bar for executables is higher than for packages. The official script verifies checksums itself:

```powershell
irm https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1 -OutFile install.ps1
Unblock-File .\install.ps1; .\install.ps1 --skip-config
```

Afterwards the plugin probes, in order: the official install location → `$DSH_HOME/vendor/codebase-memory-mcp/bin` → `PATH`. Or pin it explicitly via the `cbmPath` config.

### 2. Mount the bundle into a profile (②③④ are fully automatic)

```powershell
git clone https://github.com/njuptlzf/dsh-codebase-memory
dsh plugin --profile <your-profile> add file:<absolute-path-to-the-clone>
```

> **Confirm the target profile.** Profiles are per-app — the desktop build runs its own (`tauri` in the official desktop package), the web build another (`web`) — and a profile name unknown to your desktop install is rejected up front. The right profile is simply the one your app boots with; when unsure: `dsh --profile <name> --dump-config` and search for `codebase-memory`.
>
> `dsh plugin` runs pnpm in the profile directory, then **reconciles `dsh.profile.bundles` for you** — but only when pnpm exits cleanly: a dependency declaring `dsh.bundle` joins the layer stack, a removed one leaves it. The plugin is live given "files in node_modules + name in bundles".
>
> Four behaviors from the CLI worth knowing:
>
> - **`add .` is a trap** — relative specs are re-anchored to your *invoking* directory, so `add .` from elsewhere silently links *that* directory instead. From inside the cloned repo (or with an absolute `file:` path) it's safe.
> - **Git-hosted installs build on install** — pnpm blocks `prepare` scripts until you allow them; add the printed key to `allowBuilds` in the profile's `pnpm-workspace.yaml`, then re-run.
> - **First run can take minutes** on a profile with many plugins — that is pnpm resolution, not a hang.
> - **Don't script it with redirected stderr under Windows PowerShell 5.1** — the launcher shim (`$ErrorActionPreference='Stop'`) promotes any stderr line (pnpm progress, a node warning) into a fatal error *before* pnpm starts: exit 1, empty log, half-done state. Run it in an interactive terminal (or PowerShell 7); to refresh code afterwards, use the plugin's own sync script instead.

### 3. Restart, then verify

Restart the profile and tell the model:

```
run code_setup and paste the output verbatim
```

`status: OK` — and the manifest line pointing at a real `cbm.json` (not `(not written)`) — means the whole chain is alive. Layer ② installs itself into `$DSH_HOME/vendor/mcp-adapter` on first boot; no manual steps.

## Usage

### 1. The unit of indexing: one session workspace = one project

This is the prerequisite for everything else — in three sentences:

1. `code_index` **always indexes the current session's workspace**. Choose the repo root as the workspace and the repo is its own project; choose a parent directory and all repos under it **collapse into one project**.
2. The project name is derived from the path (non-alphanumerics → `-`, e.g. `D:/code/repo-a` → `D-code-repo-a`), but **the `code_index` return value is the source of truth**.
3. For every search afterwards, `project` is the **only routing key** — pass it explicitly on every call. The plugin does not, and structurally cannot, guess "which repo is this question about".

> ### ⚠ Point the workspace at the **git repo itself** — not at a non-git parent directory
>
> This is the one setup mistake that silently degrades everything, because cbm's change detection is **per project**, and in a multi-workspace host the project is whatever the session workspace is (the engine takes it from the MCP client's cwd). Measured consequences of using a parent directory:
>
> - the parent is not a git repo ⇒ `watcher.baseline … strategy=none` ⇒ **no polling at all** (`watcher.changed` never fires);
> - nested repos are **never** watched: a watch is registered only for the project at the **client that creates the session-managed daemon**; clients that merely *join* an active daemon register nothing (probed twice with a long-lived client whose cwd was a nested repo: `watcher.watch` / `baseline` / `changed` / `unwatch` = 0 / 0 / 0 / 0);
> - the nested repos' symbols still live inside the *parent's* graph, so `get_code_snippet` hands back **stale coordinates** for them while `index_status` keeps reporting `ready` — a silent wrong answer, not an error.
>
> Measured cost of getting this wrong: on a real repo, **20 of 59** sampled symbols returned a range that does not contain the named symbol. Fix: open the **repo root** as the workspace (then the repo is its own project and the watcher polls it), or refresh that project explicitly (`codebase-memory-mcp cli index_repository --repo-path <repo>`).

```powershell
# one sqlite per project, all under the cache (nothing lands in your repo):
Get-ChildItem ~/.cache/codebase-memory-mcp -Filter *.db
```

Measured on this machine: a first build of a mid-size repo (1,946 nodes) took **~30 s**; a refresh costs about the same wall clock (**21 s** for a 1,000-file repo, **18 s** for 300 files) — but it is **not** a full re-parse. At the node-id level a no-change refresh touches nothing (every id and `sqlite_sequence` unchanged), and a one-file change reissues ids only for that file's nodes (19/19 untouched files kept theirs). Most of the wall clock is fixed per-run overhead, which barely moves with file count. A single query < 100 ms.

### 2. The standard flow

Learn it as **four task-ordered steps** (this mirrors the text injected into the system prompt — change both or neither):

```
code_index (build / refresh after edits) → you have the project name
→ locate:  cbm_search_graph        → qualified_name + file + line range
→ read:    cbm_get_code_snippet     (pass format:"json" — that's the byte-exact source)
→ verify:  cbm_check_index_coverage (freshness=metadata_changed ⇒ re-run code_index first)
→ for relationships: cbm_trace_path
```

All retrieval goes through the proxy tool `mcp__cbm__mcp`; pass `args` **as a plain object** (no JSON-string double encoding):

```jsonc
{"tool": "cbm_search_graph",         "args": {"project": "<project>", "query": "symbolName", "limit": 10}}
{"tool": "cbm_get_code_snippet",     "args": {"project": "<project>", "qualified_name": "<qn from search_graph>", "format": "json"}}
{"tool": "cbm_check_index_coverage", "args": {"project": "<project>", "paths": ["apps/server/src/x.ts"]}}
{"tool": "cbm_trace_path",           "args": {"project": "<project>", "function_name": "X", "direction": "callers"}}
```

> Omitting `format` gives you `tree` — a typesetting envelope that rewrites leading whitespace on every line, so copied text never matches the file. See [known limitations](#known-limitations--non-goals).

For multi-step lookups, run them in one `mcp__cbm__mcpScript` call instead of round-tripping (measured: two `search_graph` calls in 73 ms total).

### 3. Prompting recipes (what actually triggers it)

Whether the model uses the graph depends on whether your question is a **graph-shaped question**. These phrasings were observed to work:

| Ask like this | Why it works |
|---|---|
| "**Who calls** `X`? What breaks if I change it?" | `CALLS` edges answer this directly; grep only finds string occurrences, not call sites |
| "Where is `X` defined, and in which line range?" | Exact ranges — saves the whole-file Read |
| "What are this module's entry points / routes / package structure?" | `get_architecture` returns the panorama in one call |
| "Use the index: `search_graph` first, then `get_code_snippet` for that range — **don't grep**" | Names the steps and turns off the fallback; highest trigger rate |
| "Search with `project=<name>`" | Hands over the routing key; no fumbling |
| "Only inside `**/<repo>/**`" | `file_pattern` scoping — essential in multi-repo workspaces |
| "Fetch these five implementations **in one call**" | Forces `mcpScript` batching |

Counter-examples — these should **not** trigger the index: "look at this file" (Read's sweet spot), "what does this error mean", "what is this config value" (literals → `search_code`/grep).

How to tell it *really* used the index: the tool card shows `mcp__cbm__mcp`, and the answer cites `qualified_name` + exact line ranges (`index.js 238-261`). If it pastes half a screen of raw file text, it just Read the file.

### 4. Encoding it in AGENTS.md (make it permanent)

The prompt section is only a signpost; **an AGENTS.md that travels with the repo is the standing rule**. DSH's `dsh-agent-instructions` injects `AGENTS.md` / `CLAUDE.md` from the workspace (and its ancestor chain) as baseline context **before the first request** — a new session picks it up automatically; no restart needed. Put it at the repo root, or in a directory shared by all your sessions:

```markdown
## Analyze code through the index, not file by file

This workspace is code-indexed (dsh-codebase-memory). Before reading code:

- The routing key is `project`; run `code_index` once when unsure — its return value *is* the project name.
- Locate symbols: `mcp__cbm__mcp` → `cbm_search_graph` (pass `args` as a plain object).
- Read implementations: `cbm_get_code_snippet` for that exact range — no whole-file Reads.
- Trace relationships: `cbm_trace_path` (callers/callees), `cbm_detect_changes` (impact of a diff).
- Multi-repo workspaces must scope: `file_pattern="**/<repo>/**"`; resolve duplicate names via `qualified_name`.
- Batch multi-step lookups with `mcp__cbm__mcpScript` instead of many round trips.
- Use grep/Read only for literals (strings / config values / log text) or where the index clearly misses the path.
- Point the **workspace at the repo itself** (a non-git parent directory is never watched).
- After edits, refresh with `code_index` (wall clock ~20–30 s, mostly fixed per-run overhead — it is not a full re-parse).
```

Three rules of thumb for writing this kind of instruction:

1. **Write rules, not manuals** — "before reading code, follow this path" beats "you may use the index". The model defaults to grep not because it doesn't know better, but because nobody said otherwise.
2. **Leave an exit** — "grep only for literals" is more correct than "never grep". Literal-string search genuinely belongs to grep.
3. **Hard-code the two biggest traps** — how to obtain the project name, and how to scope a multi-repo workspace. Omit these and the model falls back to grep after one failed attempt.

### 5. Skills live in this repo

The repo also carries the companion skills under `skills/`, versioned with the plugin:

- `skills/dsh-codebase-impact-analysis/SKILL.md`: impact analysis, safe renames, caller/callee traces, business-flow analysis; deep rules are loaded from `references/deep-rules.md` only when needed.
- `skills/dsh-cbm-investigate/SKILL.md`: orchestration between root-cause debugging and impact analysis. It includes a portable `references/investigation-core.md` distilled from the classic investigate flow, so it does not hard-depend on a global `investigate` skill. If a richer `investigate` skill is installed, it can be used as an optional extension.

`node scripts/sync.mjs` now copies `skills/` to `$DSH_HOME/skills` as well as syncing the runtime plugin files. DSH's filesystem skill provider watches the user skills root, so skill changes are discoverable without restarting the host; plugin runtime changes still require a profile restart. The point is to keep the plugin prompt, README, and skills from drifting into three different truths.

## How DSH finds it, and how the model starts using it

**Being loaded is per host, not per workspace.** Once installed into a profile, the plugin is active for *every* session regardless of which repo is opened. Opening a git repo as the workspace changes **whether the index stays fresh** (the watcher can finally poll it — see §1), not whether the plugin is loaded.

Recognition is two-sided, and neither side is `systemPrompt`:

| Side | Marker | Meaning |
|---|---|---|
| this package | `package.json` → `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, plus `exports` for `index.js` + the patch | "I am a DSH bundle; apply this patch when loading me" |
| the profile | `~/.dsh/profiles/<p>/package.json` → ①`dependencies["dsh-codebase-memory"]` ②`dsh.profile.bundles[]` contains the name | ① files are present in `node_modules` ② **this is what "enabled" means** |

`dsh plugin --profile <p> add file:<repo>` writes both. Then the dev loop is `node scripts/sync.mjs` → **restart the host** (`cordis.yml` is composed from the bundle list at load; `file:` deps are immutable to pnpm, which is exactly why `sync.mjs` exists). **`code_setup` reports the drift for you**: `同步状态: 一致` when the loaded copy matches the repo, or a ⚠ line naming the differing files of the three runtime files (`index.js` / `cordis.patch.yml` / `package.json`). That covers "edited the repo, forgot to sync" — it cannot detect "synced but did not restart", because running code has no hash of its own loaded bytes.

**Adoption — getting the model to actually search with cbm** — is a separate, weaker problem. Three levers, strongest last:

1. **Prompt section (already wired).** `inject: ['systemPrompt']` → `ctx.systemPrompt.section({ name: 'codebase-memory', order: 850, text: usageSection(state) })`. That text is the 4-step flow (locate → read with `format:"json"` → verify freshness) plus the token argument for preferring the graph over file-by-file Reads.
2. **The repo's own `AGENTS.md` (recommended, zero install).** Per-project, versionable, and closer to "how this repo wants to be worked on". §4 has a copy-paste template. `ruankao-ai/AGENTS.md` is a real example of this in use.
3. **A `PreToolUse` hook (enforcement, needs an extra package).** DSH hooks are matched on **the tool name the model sees** (`ctx.on("tools/pre-execute", … runPoint("PreToolUse", exec.name, …))`), so a hook can match `grep|glob|read` and either append context or block with a reason. This is the only lever that can *interfere* rather than persuade — and it costs an environment change: `dsh-hooks-claude-code` is **not installed in any profile here** (its module is only in the DSH install tree, and `.dsh-module-fallback` carries no `@deepseek-ai/*`), so mounting it means installing that package into the profile, adding it to `dsh.profile.bundles`, pointing its `configPath` at a `hooks.json`, and restarting. Only worth it if the model keeps ignoring the index.

## Engine compatibility (what happens when codebase-memory-mcp changes)

**This plugin depends on the engine by contract, not by package version** — it never imports cbm, it shells the binary (installed separately; its version is discovered at runtime and printed by `code_setup`). So an upstream bump will not fail at install time; it can only break at *use* time, if something we rely on moved:

```
1 binary discovery: PATH / official install dir / vendor; --version
2 CLI: cli --quiet --json <tool>; config get|set; daemon start|stop|status; index_repository --repo-path
3 MCP tools & shapes: search_graph; get_code_snippet + format:"json";
  check_index_coverage --paths → freshness / recommended_action; trace_path; list_projects; index_status
4 behaviour: watch registration (creator-only), strategy=none for non-git, incremental refresh,
  tree vs json rendering, CRLF→LF normalisation
```

- **Runtime guard (in this plugin).** `package.json → dsh.testedEngine` is the single source of truth for the version we have actually verified. `code_setup` prints `引擎实测: 实测通过 <tested>；当前 <version>` and appends a warning when the running engine is outside that range. It warns; it never throws.
- **Scheduled CI (`.github/workflows/upstream-compat.yml`).** Weekly (plus manual dispatch) it asks upstream for the latest release, compares the minor version with `dsh.testedEngine`, and — when they differ — installs *that* release (`CBM_DOWNLOAD_URL` pins the official installer to the tag) and runs `npm run check` (patch → plugin → chain → tokens). It then opens or updates an issue with the verdict: ✅ compatible → just bump `testedEngine`; ❌ failing → the contract moved and this plugin needs a change.
- **When does upstream change require a new plugin release?** Only when one of the four lines above moved. Engine-internal improvements (new languages, speed, new tools) need **no** plugin release — users just run `codebase-memory-mcp update`. The CI exists to tell you which of the two you are in. The MCP adapter is a *separate* upgrade axis and stays pinned to `DEFAULT_ADAPTER_VERSION`.

## Configuration (optional)

Add `config:` to the `codebase-memory` row in the composition:

| Field | Default | Meaning |
|---|---|---|
| `bootstrap` | `background` | `blocking` / `background` / `manual` (manual = probe only, never download) |
| `adapterVersion` | `2.29.0-0.0.4` | pinned; **the single upgrade entry point** |
| `adapterDir` | `$DSH_HOME/vendor/mcp-adapter` | where layer ② and `cbm.json` live |
| `cbmPath` | auto-probe | leave empty to probe official → vendor → PATH |
| `autoIndex` | `true` | Aligns the engine's `auto_index` at bootstrap (read-first, write only if it differs). **Scope warning:** this lands in the machine-wide `~/.cache/codebase-memory-mcp/_config.db`, shared with every other MCP client on this box — set it to `false` if you don't want this plugin deciding that. Measured semantics: it indexes projects that have **no** index yet when a session starts; it does **not** refresh stale coordinates, so it is not drift protection (`code_index` + `check_index_coverage` still are) |
| `sessionRefresh` | `true` | On `agent/session-start`, refresh the **session workspace's** index in the background, gated on (git state changed) ∧ (project already indexed) ∧ (5-min cooldown). Compensates for the engine's watcher, which cannot cover a multi-workspace host — see [known limitations](#known-limitations--non-goals). `false` opts out |

## Verification

```powershell
npm run check   # = check:patch + check:plugin + check:chain + check:tokens
```

| Check | What it proves |
|---|---|
| `check-patch.mjs` | the three `!!js` expressions in `cordis.patch.yml` evaluate under the Loader's exact semantics and point at real files; the `DSH_HOME`-missing fallback yields identical values |
| `check-plugin.mjs` | a fake ctx — mirroring the real service's preconditions — actually runs `apply`/`code_index`/`code_setup`: chain ready, workspace bound to session cwd, different workspaces → different projects, missing engine throws with a copy-pasteable install command |
| `check-chain.mjs` | really spawns adapter → engine over MCP stdio: proxy tool present, lazy connection woken up, `search_graph` returns real rows |
| `check-tokens.mjs` | **ablation arm**: direct engine vs proxied `tools/list` byte size; throws if the proxy is not smaller — the main claim must have a falsifiable premise |

Measured on the author's machine:

```
PATCH OK
20/20 arms passed (two profiles)   PLUGIN OK
CHAIN OK (proxy tool `mcp`, 15 engine tools discovered)
arm A direct engine            : 17 tools, 17308 B ≈ 4327 tokens
arm B proxied, cold cache      :  2 tools,  4278 B ≈ 1070 tokens  (4.0x)
arm C proxied, cache w/ resour.:  3 tools,  4871 B ≈ 1218 tokens  (3.6x)
```

> `check-plugin.mjs` really indexes *this* repo once (the project lands in `~/.cache`, never in the repo). To verify a single profile: `node checks/check-plugin.mjs <profile>`.

## Troubleshooting

| Symptom | Cause & action |
|---|---|
| `code_index`/`code_setup` missing from the current session's tool list, yet calling them works | The tool list is a **per-session snapshot**: only newly opened conversations see it. "not listed" ≠ "not registered" |
| `code_setup` says `status: NOT READY` | Follow the missing-piece hints it prints, then call it again (it re-bootstraps; no restart needed) |
| Manifest line shows `(not written)` | bootstrap threw before writing `cbm.json` — hand the `error:` line to a maintainer verbatim |
| Search returns `ambiguous` + candidates | Multiple repos in the workspace define the same symbol name. Use one candidate's `qualified_name`, or scope with `file_pattern` |
| Results look stale right after edits | **First check the workspace choice** (§1): if the session workspace is a non-git parent directory, nothing is watched at all and no amount of waiting helps. Otherwise, the good news — the engine *does* auto-repair while a session is alive: a session-managed daemon starts (`codebase-memory-mcp daemon status` → `active (session-managed)`) and its **git watcher re-indexes on its own**; measured on a scratch repo, an **uncommitted** edit was picked up in **~30 s**. Three conditions must all hold, and in DSH two of them usually don't: ① the watched project is the one at the **server process's cwd** — `auto_watch` is a *git* watcher and our manifest pins no `cwd`, so it watches the host's cwd, not the session workspace; ② that root must actually be a git repo (workspace roots like `C:\Users\kingdee\work` are not); ③ `lifecycle: "lazy"` reaps the server after the adapter's default **10 min** idle (`idleTimeout` default 10, and only `eager`/`lazy-keep-alive` zero it), which takes the daemon and watcher with it — that is why an index can sit stale for days. So: `check_index_coverage --paths` to detect, `code_index` to guarantee. `auto_index` only covers projects that have no index yet |
| An edit anchor copied from a snippet never matches | The `tree` rendering prepends a fixed indent to every line (`get_code_snippet` +2, `search_code --mode full` +8), so copied text isn't file bytes. **Call with `format: "json"`** — its `source` is byte-exact — or take anchors from `read` |
| A snippet shows code that isn't the symbol it names | Line ranges come from the index while the text is read live off disk: if the file moved lines since the last `code_index`, you get the *neighbours* under the right `name`/`source_mode`, **with no error**. Detect it with `check_index_coverage --paths <file>` (`freshness = metadata_changed`), then re-run `code_index` — `index_status` stays `ready` and won't tell you |
| A file/directory never shows up | Nine times out of ten `.gitignore` excludes it (the engine honors gitignore + skips `node_modules` etc. by default). The `excluded` / `not_indexed_files` fields in `code_index` output list why |
| Installed on desktop, nothing happens | Wrong profile, most likely. Confirm with `--dump-config` that `codebase-memory` is in the composition |
| `dsh plugin add .` installed something — but not your clone | Relative specs anchor to the *invoking* directory. Re-run from inside the repo, or pass an absolute path |
| `dsh plugin …` exits 1 immediately with an empty log | Windows PowerShell 5.1 + stderr redirection + `$ErrorActionPreference='Stop'` killed the launcher shim before pnpm ran. Use an interactive terminal or PowerShell 7 |

## Engineering notes (for whoever modifies it)

- **Never throw at boot**: missing dependencies only update the reported state (`code_setup`), because a boot throw kills the whole profile. All precondition checks live at the tool-call site — "precondition unmet ⇒ throw" applies to calls, not startup.
- **Two real contracts of `ctx.subprocess.spawn`** (this plugin shipped a bug past each of them once; the acceptance fake ctx now mirrors both):
  1. `cwd` is required — the implementation evaluates `spec.cwd.includes('\0')`, so `undefined` throws TypeError;
  2. `collected.stdout.readFrom(n)` returns `{ text, nextOffset, lossy }`, not a string — `String()` of it is `"[object Object]"`.
- **Windows trio**, all worked around explicitly in code: PATH's `npm.cmd` cannot be spawned without a shell → probe `npm-cli.js` and run it under node; the engine's `.cmd` shim, same story → the manifest always points at the absolute `.exe`; PowerShell 5.1 reads BOM-less Chinese `.ps1` as ANSI → every script here is `.mjs` run by node.
- **After edits: sync, then restart.** pnpm treats `file:` dependencies as immutable by lockfile — content changes are never re-copied. `node scripts/sync.mjs` copies straight into each installed profile and re-hashes to verify. `link:` (junction) is *not* an option: Node resolves realpath, and bare `@deepseek-ai/*` imports fail from the repo path. A running host locks the composition, so sync only touches files that differ.
- **Checks must be falsifiable**: after hardening a check, run it against the *old, unsynced* code first — only reproducing the exact production error (FAIL, exit 1) proves it has teeth; then fix, then go green.

## Known limitations & non-goals

- **Ask the engine for `format: "json"` when you need real bytes.** Two independent things, neither fixable here because this plugin does not render snippets:
  1. *The `tree` format is a typesetting envelope, not source.* The default rendering prepends a fixed indent to **every** line — `get_code_snippet` +2, `search_code --mode full` +8 (it grows with envelope nesting depth). Lines already at column 0 and blank lines get it too, which proves it is a mechanical `"  " + line` rather than a dedent/reindent. So copied `tree` text never matches the file, and `edit` fails **loudly** (`old_string was not found`) — never silently. **`format: "json"` returns the original bytes**: verified on a class method (disk `2/4/2` → json `2/4/2`, tree `4/6/4`) and a top-level interface (disk `0` → json `0`, tree `2`), and on 14/14 randomly sampled symbols enumerated straight from the index DB (no search-result bias). Pass it to `get_code_snippet` and `search_code` alike.
  2. *Coordinates can still be stale — this is the dangerous one.* `start_line`/`end_line` come from the index while the text is sliced off disk, so after an un-indexed edit a snippet returns a shifted, plausible-but-wrong region carrying the correct `name` and `source_mode: full`. [Upstream issue #1750](https://github.com/DeusData/codebase-memory-mcp/issues/1750) documents it (open). `index_status` will **not** tell you (it stays `ready`), but `check_index_coverage --paths <file>` does: `freshness = metadata_changed`, `recommended_action = read_source_and_reindex` — a *signal*, not a repair. So `code_index` after edits, and take anchors from `read`.
  The engine's CRLF→LF normalization in snippets is *not* a hazard: DSH's `edit` is line-ending aware (an LF anchor matched a CRLF file and the CRLF was preserved on write).
- **Session-start refresh — why the plugin does a job the engine "already" does.** The engine's auto-update rests on three assumptions this host breaks: the watched project is whatever sits at the **MCP server process's cwd** (a single, static path), the watcher is **git**-only (`watcher.baseline strategy=none` for anything else), and it lives only as long as the **client session** (measured: with a *permanent* daemon running, a change after the session ended went unseen for 165 s). In DSH one server process serves many sessions with different workspaces, so the engine structurally cannot follow the session workspace — and when coordinates go stale, `get_code_snippet` returns a **neighbour's code under the right name, silently** (measured: 20 of 59 symbols in a real repo). Hence `sessionRefresh`: on `agent/session-start` the plugin refreshes the session workspace when git state changed, the project was already indexed, and the 5-minute cooldown has passed. Cost when it actually fires: ~15–30 s of background CPU (1000-file repo ≈ 21 s; ruankao-ai ≈ 28–30 s — the wall clock is mostly fixed per-run overhead, not parse volume); a session whose git state is unchanged skips in tens of milliseconds. Honest gaps: `agent/session-start` is **detached**, so a session's first queries can still race the refresh; edits made *during* a session by another session are not covered; and non-git workspaces are deliberately skipped.
- **`lifecycle` is `keep-alive`, and the reason is the startup race.** The server connects at extension load (`init.ts:290-295` — only `keep-alive`/`eager` are in `startupServers`) and is marked keep-alive with health-check reconnects. Two defects it avoids: a plain `lazy` server is reaped after the adapter's default **10-minute** idle (`idleTimeout` default 10; only `eager`/`lazy-keep-alive` zero it), which kills cbm's session-managed daemon *and* watcher; and both `lazy` and `lazy-keep-alive` connect only **on first use**, so cbm's `auto_index` and watcher baseline fire *concurrently with your first tool call* — precisely the race Claude Code does not have, because it connects configured MCP servers when a session starts. `eager` is not used: it has **no auto-reconnect**. **What this does *not* fix** — updates are still git-polled (measured 18–30 s to notice an edit) and still cover only the project at the *server's* cwd, so mid-session edits, other workspaces and non-git roots remain `sessionRefresh`'s and `code_index`'s problem. Cost: one resident cbm process per host (~17 MB RSS).
- **Platform**: the current implementation hardcodes Windows (`USERPROFILE` fallback, `.exe` probing, npm-cli.js candidates). Linux/macOS users: issues and PRs welcome.
- **Refresh is incremental — the wall-clock cost is mostly fixed overhead, not re-parsing.** Measured at the node-id level on a scratch git repo: a **no-change** `code_index` touches nothing (every node id *and* `sqlite_sequence` identical), and a **one-file** change reissues ids only for that file's nodes — **19/19 untouched files kept their exact ids**. So it does not re-parse the whole workspace. What you pay is a per-run fixed cost (process start, DB open, change detection): ~21 s for a 1000-file repo, 28–30 s for ruankao-ai, and it barely moves with file count (300 files ≈ 18 s → 1000 files ≈ 21 s). The **watcher** path is a different code path: after a one-file change it also *renumbered* ids of later files (observed `[18,53,54] → [18,54,55]` with only +1 new id), so its write set is broader than the CLI path's. Graph freshness = your last call.
- Data-ish files are simply not code: anything your `.gitignore` excludes (databases, build output, question banks) will never appear in the graph — by design.
- **Explicit non-goals**: porting the MCP adapter, writing an indexing engine, rolling our own downloader, building a watcher, committing index artifacts to repos, an index-status sidebar UI, and smart cross-project routing (see [why](#why-this-plugin-exists) — choosing the workspace is, and should remain, a human decision).

## License

[MIT](LICENSE)
