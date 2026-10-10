# dsh-codebase-memory

English | [简体中文](README.zh.md)

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) host bundle that wires [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) into your agent sessions: **it builds a code knowledge graph of the current session workspace and lets the model retrieve code through the graph — instead of grepping file by file**.

## Table of contents

- [How the chain is composed](#how-the-chain-is-composed)
- [Why this plugin exists](#why-this-plugin-exists)
- [Install](#install)
- [Usage](#usage) — including [trigger layers](#trigger-layers-why-you-should-not-have-to-prompt-for-this), [prompting recipes](#3-prompting-recipes-what-actually-triggers-it), an [AGENTS.md template](#4-encoding-it-in-agentsmd-make-it-permanent), and [versioned skills](#5-skills-live-in-this-repo)
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

### 1b. Optional: the semantic-search layer (zvec-grep, off by default)

The cbm graph **does no vector search** (verified on 0.11.0: `search_graph` is BM25/regex, `search_code` is graph-ranked text search). If you want "search code and docs in natural language", bolt on [zvec-grep](https://github.com/zvec-ai/zvec-grep) — the plugin registers it as a second MCP server, **off by default** because it costs ~430MB:

```powershell
npm run install:zg          # one-time: npm install + prune (drops inference backends transformers.js never loads), 430MB, ~3 min
# then add `zgEnabled: true` to the codebase-memory row's config: in the profile's cordis.patch.yml, and restart the host
```

Once enabled, `code_setup` gains a `语义层(zg): ready` line, the manifest registers the `zg` server (lifecycle `lazy`: the local daemon starts on first use, ~2.2s, then warm queries run 1.4s), and the model sees exactly one tool: **`zg_zvec_grep_search`** (the `agent` toolset — rg passthrough, indexing and server admin stay CLI-side; **proxied tool names carry the mcpServers key as a prefix** — direct it is `zvec_grep_search`, through this manifest it is `zg_zvec_grep_search`). Calls **must pass `root`** (the absolute workspace path); omitting it fails validation with `root: Invalid input`. Index artifacts land in `.zvec-grep/` inside the indexed repo (gitignore it — this repo already does). The prune is gate-checked: `install:zg` ends with a `--version` self-test; freshness reuses the dirty ledger — with `dirtyTracking` on, the background refresh also runs `zg index` (incremental, ~2s).

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

Two verbs cover the high-frequency path and need **no routing key from you** — `project` is filled by the plugin from the session workspace:

```
code_index (build / refresh after edits)
→ code_find("symbolName")            → qualified_name + file + line range + the source
→ code_callers("<qualified_name>")   → callers (inbound) / callees (outbound), hop by hop
→ long tail via the proxy: cbm_check_index_coverage (freshness), cbm_query_graph (multi-hop),
  cbm_get_architecture, cbm_detect_changes, …
```

The rest of the graph stays reachable through `mcp__cbm__mcp`; pass `args` **as a plain object** (no JSON-string double encoding):

```jsonc
{"tool": "cbm_check_index_coverage", "args": {"project": "<project>", "paths": ["apps/server/src/x.ts"]}}
{"tool": "cbm_get_code_snippet",     "args": {"project": "<project>", "qualified_name": "<qn>", "format": "json"}}
{"tool": "cbm_query_graph",          "args": {"project": "<project>", "cypher": "…"}}
```

> Omitting `format` gives you `tree` — a typesetting envelope that rewrites leading whitespace on every line, so copied text never matches the file. See [known limitations](#known-limitations--non-goals).

For multi-step lookups, run them in one `mcp__cbm__mcpScript` call instead of round-tripping (measured: two `search_graph` calls in 73 ms total).

#### Trigger layers (why you should not have to prompt for this)

Telling the model "use the index" is a soft constraint; these layers intervene instead. Each one is an independent switch, every hook is `try/catch` + **fail-open** (a hook that cannot prove the index is trustworthy lets `grep` run), and nothing at boot ever throws:

| Layer | Mount point | Default | What it does |
|---|---|---|---|
| ① wrapped verbs | `ctx.tools.register` | on | `code_find` / `code_callers` — schema cost measured: **1651 B ≈ 413 tokens per request**, against ~3200 tokens saved by the proxy |
| ② intercept | `tools/pre-execute` | `off` (no interception) | with `enforce: deny-once`/`deny` (switch: **Settings → Plugins → dsh-codebase-memory → `codebase-memory` → Configure**, no restart): a grep whose pattern looks like a **symbol** is denied **once per symbol per session**, and the deny `reason` already contains the `search_graph` hits, so the model gets an answer in the same round. It also **passes** whenever the graph has nothing for that symbol — intercepting a search the index cannot answer is just obstruction |
| ②b swap | `tools/post-execute` | off (`enforce: off`) | with `enforce: replace`: a symbol-shaped grep **runs normally and succeeds** — but the model-visible output is swapped wholesale for hits from the two retrieval layers: the structure layer (code graph) answers first, the semantic layer (zvec-grep) covers its misses; if neither answers, the original output stays. The layers are complementary and always coexist — this setting only rewrites what a grep shows, regular tools stay available. It rides the host's post-execute accept+content channel ("accept keeps the call successful (replacing content when given)"), so **no isError** is ever produced; pre-execute cannot rewrite arguments (host contract: "Input rewriting is excluded", the args are deep-frozen), which is exactly why the swap is post-hoc. Sessions with a dirty write ledger are **never swapped** — replacing from possibly-stale coordinates would be lying |
| ⑤ dirty tracking | `tools/post-execute` + per-session write ledger | on | records `write`/`edit` paths per session (no per-file indexing) and treats **a session that has written code as stale**: interception lets the grep through, `code_find`/`code_callers` mark their answer `stale` and name the paths, and a cooled background refresh is scheduled. The ledger is cleared **only when that refresh actually rebuilt the index** — a gated skip means nothing was rebuilt, so clearing would be a lie. Why the ledger instead of the engine's per-path verdict: measured on engine 0.11.0, immediately after a *full reindex* an **untouched** file still reports `freshness=metadata_changed` / `read_source_and_reindex`, identical to an edited one — it is a project-generation signal, not per-path staleness. Gating on it would disable interception permanently while scheduling a ~20 s reindex for every intercepted grep. `check_index_coverage` stays in the prompt as manual evidence, just not as a hook gate |
| ③ conditional context | `systemPrompt.context` (order 130) | on | when the last user message looks like "who calls / where is X defined / rename / impact", inject one line: project + freshness + "use code_find". Nothing else is injected — the standing section stays constant |

①②⑤ go through the host's **live** proxy connection (measured 29–34 ms per query warm); they deliberately never spawn `codebase-memory-mcp cli`, which measures **5.5–8.3 s per call** on the same machine.

Note the difference from the host's own `dsh-repeat-tool-reminder`: that plugin fires on *byte-identical consecutive calls* (default thresholds 3/5/8) and says nothing about which tool to use; layer ② fires on the **shape of the pattern** and says nothing about repetition. Different triggers, different channels (deny `reason` vs `additionalContexts`), no overlap. The old ④ `advise` soft hint — which did share the reminder's channel — was removed at the 2026-10-08 acceptance.

### 3. Prompting recipes (what actually triggers it)

Since v0.3 the plugin stops relying on your phrasing for the common case (see [trigger layers](#trigger-layers-why-you-should-not-have-to-prompt-for-this)); these recipes are what's left for the long tail — naming the step still beats hoping.

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

- The routing key is `project`; the plugin fills it for `code_find` / `code_callers`, and `code_index`'s return value *is* the project name for everything else.
- Locate symbols: `code_find("X")` — qualified name, file, line range, source in one call. Long tail: `mcp__cbm__mcp` → `cbm_search_graph` (pass `args` as a plain object).
- Read implementations: `cbm_get_code_snippet` for that exact range — no whole-file Reads.
- Trace relationships: `code_callers("<qualified_name>")`, or `cbm_trace_path` / `cbm_detect_changes` for paging and diff impact.
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

**Adoption — getting the model to actually search with cbm** — used to be a separate, weaker problem, because persuasion was the only tool available. Since v0.3 the plugin also has *interference*, mounted natively (no extra package, no `hooks.json`, no profile edit beyond this bundle's config row):

1. **Prompt section (still there).** `inject: ['systemPrompt']` → `ctx.systemPrompt.section({ name: 'codebase-memory', order: 850, text: usageSection(state) })`: the standing flow, kept constant within a session so the prefix cache stays warm. Budgeted and asserted (`≤ 1150` chars; measured 863).
2. **The repo's own `AGENTS.md` (recommended, zero install).** Per-project, versionable, closer to "how this repo wants to be worked on". §4 has a copy-paste template.
3. **The trigger layers** ([docs/design-v2.md](docs/design-v2.md)): wrapped verbs ①, intercept ②, conditional context ③, soft hint ④, staleness tracking ⑤ — see [trigger layers](#trigger-layers-why-you-should-not-have-to-prompt-for-this).

Why native subscription instead of the bridge package: `dsh-hooks-claude-code` is **not installed in any profile here** (its module only exists in the DSH install tree, and `.dsh-module-fallback` carries no `@deepseek-ai/*`), so mounting it would mean installing a package into every profile, adding a bundle row, writing a `hooks.json`, and restarting — for a shell hook that, per the hook ecosystem, "can observe and veto but cannot hand text back to the model". Inside the plugin we can deny *and* put the answer in the denial reason, and we already know the project, the index freshness and the session's dirty paths.

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

Two ways to change it. **Settings → Plugins → dsh-codebase-memory → the `codebase-memory` row → Configure** edits the six hot writable fields (`enforce`, `telemetry`, `interceptBudgetMs`, `interceptTools`, `contextHint`, `dirtyTracking`) and shows a **read-only runtime counter block** (intercept / replace / dirty-ledger counts, refreshed by events — see the `stats` row). Changes take effect **without a restart**: the host pushes new values into the same volatile references the intercept hook reads, so flipping `off → deny-once` mid-session is enough to make the next grep be judged; switches write immediately, text/number inputs commit on Enter or blur (invalid values are never written). Everything else is a `config:` block on the `codebase-memory` row of the composition (**restart required**, the document is composed at boot):
| Field | Default | Meaning |
|---|---|---|
| `bootstrap` | `background` | `blocking` / `background` / `manual` (manual = probe only, never download) |
| `adapterVersion` | `2.29.0-0.0.4` | pinned; **the single upgrade entry point** |
| `adapterDir` | `$DSH_HOME/vendor/mcp-adapter` | where layer ② and `cbm.json` live |
| `cbmPath` | auto-probe | leave empty to probe official → vendor → PATH |
| `autoIndex` | `true` | Aligns the engine's `auto_index` at bootstrap (read-first, write only if it differs). **Scope warning:** this lands in the machine-wide `~/.cache/codebase-memory-mcp/_config.db`, shared with every other MCP client on this box — set it to `false` if you don't want this plugin deciding that. Measured semantics: it indexes projects that have **no** index yet when a session starts; it does **not** refresh stale coordinates, so it is not drift protection (`code_index` + `check_index_coverage` still are) |
| `sessionRefresh` | `true` | On `agent/session-start`, refresh the **session workspace's** index in the background, gated on (git state changed) ∧ (project already indexed) ∧ (5-min cooldown). Compensates for the engine's watcher, which cannot cover a multi-workspace host — see [known limitations](#known-limitations--non-goals). `false` opts out |
| `wrapperTools` | `true` | Layer ①: register `code_find` / `code_callers`. `false` leaves only the proxy tool |
| `enforce` | `off` | **hot** (Settings page). Layers ②/②b: `off` / `deny-once` (block a symbol-shaped grep **once per session per symbol**) / `deny` (block every time) / `replace` (the grep runs and succeeds; only the model-visible output is swapped for graph/semantic hits — no error ever surfaces). `replace` is the honest "hard replacement" tier: instead of arguing with the model about checking the index first, it just puts the answer in front of it. Move `off → deny-once` only when telemetry says the false-positive rate is acceptable. (The old `advise` mode — a post-execute soft hint — was removed on 2026-10-08; an `enforce: advise` in existing config falls back to `off` with a note) |
| `interceptTools` | `grep,glob` | **hot** (Settings page). Comma-separated built-in tool names to consider (bare lowercase names; `glob` patterns almost never classify as symbols) |
| `interceptBudgetMs` | `2500` | **hot** (Settings page). Time budget for the in-hook cbm queries (`list_projects`, `search_graph`). Measured warm cost is 29–34 ms, so this is head-room for a cold connection; **exceeding it lets the grep run** |
| `contextHint` | `true` | **hot** (Settings page). Layer ③: conditional one-line `systemPrompt.context`. Not delivered under minimal agent presets (they suppress the whole runtime-context snapshot) — ①②⑤ are not affected |
| `dirtyTracking` | `true` | **hot** (Settings page). Layer ⑤: record `write`/`edit` paths per session. **The ledger is the staleness signal** (see trigger layers, ⑤ — the engine's own per-path verdict is not one); only `code_index`, or a background refresh that really rebuilt the index, clears it |
| `dirtyRefreshCooldownSec` | `120` | Cooldown for the background refresh that a stale check schedules (same gated `sessionRefresh` path, so several edits in one turn collapse into one refresh) |
| `zgEnabled` | `false` | Semantic layer (1b). `true` registers a `lazy` `zg` server in the manifest and adds three routing lines to the prompt. **Restart required**: `cbm.json` is read when the adapter process starts, so hot-editing would lie — which is exactly why this key (and `zgToolset`/`zgVendorDir`) is deliberately **not marked volatile** and absent from the Configure page. Prerequisite: `npm run install:zg`, otherwise the report shows `语义层(zg): missing` and the note tells you to run it |
| `zgToolset` | `agent` | Passed to `zg server --mcp-toolset`: `agent` (only `zvec_grep_search`) / `full` (adds managed rg plus the four index/status tools — rarely worth exposing to a model) |
| `zgVendorDir` | `$DSH_HOME/vendor/zvec-grep` | Where `install:zg` puts the package; CLI path = `<that dir>/node_modules/@zvec/zvec-grep/dist/cli/index.js` |
| `telemetry` | `true` | **hot** (Settings page). Append one JSON line per intercept / dirty-record / refresh event to `$DSH_HOME/vendor/mcp-adapter/telemetry.log`, and show counters in `code_setup`. This is the only way to decide whether `deny-once` is safe. Counts are **cumulative across restarts**: each push max-merges them into `telemetry.counts.json` next to the log, and the next boot seeds from that file ("run replace for a few days and watch the ratio" must not reset on every restart). The Configure page's runtime counters ride the **same gate**: telemetry off ⇒ no log, no persistence, counting freezes and the block stays at its last push (it does not clear) |
| `stats` | `""` | **written by the plugin — don't configure it**. Data source of the page's runtime counter block: the full counter JSON pushed into a volatile reference. `describe()` reads `ref.get()` directly, so runtime data reaches the page **without touching the persisted document** (the fingerprint only covers document-layer values — no revision churn); every push emits `settings/document-updated` to make the browser re-fetch its mirror, coalesced on a 2 s window. It is a **direction-reversed volatile** (plugin → page); anything written into it in the document is overwritten by the next event's full rebuild. **A frame is pushed at boot** (while telemetry is on), seeded from the cumulative `telemetry.counts.json`: a freshly restarted page shows five cards carrying **history**, not a "no data" line — only a genuinely fresh machine shows zeros (design-v2 §6.6/§6.7) |

Rollback is per lever: `{"enforce":"off","contextHint":false,"dirtyTracking":false,"wrapperTools":false}` restores exactly the pre-v0.3 behaviour, no restart needed for a new session.

**Why the page exists as code.** DSH's settings service only ever exposes fields the schema marks `.volatile()`, and it explicitly does **not** build a page for them (`@deepseek-ai/dsh-settings` README: "Each form reports `autoGenerate` … **no shipped client does so yet**"). So the six hot writable fields plus the **reverse** read channel `stats` — seven volatile fields in `Config`; `stats` flows the other way, plugin → page: volatile is the only thing `describe()` unwraps (`ref.get()`), which is how runtime data reaches the page without touching the persisted document — and `lib/client.js` — a hand-written `__ModuleLoader__` bundle with no build step, same shape as the official `dsh-client-ui-settings-agent-loop` — registers it into the `plugins.row.config` slot keyed `<package name>#<row id>`. Writing goes through the host's own `ctx.configForms`/`remote.settings` path, which is what persists to the profile's `cordis.patch.yml` — and `@deepseek-ai/dsh-config-editor`'s `edit()` then reconciles **just that entry** (`reconcileProfilePatches(root, patches, "dsh", [entry.id])`), which is what makes a volatile change live without a restart. Writing a value equal to the inherited one deletes the `config:` key instead of pinning it, so "reset" really means "back to the composition". Two consequences worth knowing before you extend it: a field that is not volatile is invisible to the page by construction (`describe()` skips entries with no volatile field — that is why the toggle used to be unfindable), and a field that *is* volatile must be read through `.get()` at decision time, never snapshotted in `apply`, or the page will lie — when v0.9.0 promoted `interceptTools`/`contextHint`/`dirtyTracking` onto the page, their **registration-time gates moved into the listener bodies** (listeners always register; the first line of each callback reads the live value), and arm T asserts exactly that: flip the ref, the behaviour changes without a remount. `lib/client.js` is in `RUNTIME_FILES`, so a stale client copy is reported by `code_setup` like a stale `index.js`.

## Verification

```powershell
npm run check   # = check:patch + check:client + check:plugin + check:chain + check:tokens
```

| Check | What it proves |
|---|---|
| `check-patch.mjs` | the three `!!js` expressions in `cordis.patch.yml` evaluate under the Loader's exact semantics and point at real files; the `DSH_HOME`-missing fallback yields identical values |
| `check-client.mjs` | the settings page without a browser: loads `lib/client.js` under a stubbed `__ModuleLoader__` / `react` / `primitives` and asserts the slot key is `<package name>#<row id>` **derived from `cordis.patch.yml`**, the served namespace equals the host entry id, every `require` is inside the host's implicit baseline (a typo there fails silently in the GUI — the button just never appears), the locale dictionaries cover every `ENFORCE_MODES` value in both languages, and clicking a control really calls `form.set('enforce', …)` / `form.unset(…)` in the `ready` / `writable:false` / `loading` / `unavailable` / `summary` states; the counter block renders a dsh-mneme-style card grid that is **always present while telemetry is on** — a zero frame is pushed at boot and missing/broken JSON renders as zeros; the empty-state line belongs to telemetry-off only. One big number per card plus metric rows; the hit-rate card carries a structure-layer/semantic-layer share bar; no interactive controls beyond the existing ones (the readout is read-only). Since v0.9.0 there are three switches (telemetry / contextHint / dirtyTracking) and two blur-commit inputs (interceptBudgetMs / interceptTools): invalid or empty values write nothing and snap the box back to the current value, Enter commits, and a per-field "Reset" appears only when that field is in the user layer |
| `check-plugin.mjs` | a fake ctx — mirroring the real service's preconditions (`subprocess` validation, `tools.execute`, `systemPrompt.section/context`) — actually runs `apply`/`code_index`/`code_setup` **and every trigger-layer hook**: chain ready, workspace bound to session cwd, different workspaces → different projects, missing engine throws with a copy-pasteable install command, `classifyPattern` falsified against 12 symbol + 21 literal cases (**0 false positives**), `deny-once` denies once then allows, budget overrun / unindexed workspace / stale coordinates all **fail open**, post-execute attaches nothing (the old advise injection is asserted *gone*), dirty writes recorded lazily and out-of-workspace paths ignored, conditional context renders or returns `""`, **arm Z** for the zg layer (default manifest has **no** `zg` server and the prompt no zvec routing; with `zgEnabled` the temp manifest registers `zg` as `lazy` and the prompt shows `zg_zvec_grep_search`; a missing vendor only reports `install:zg` — **never auto-installs**, 430MB is a human decision; an illegal `zgToolset` falls back to `agent` with a note); **arm R** for `enforce: replace` (a symbol-shaped grep runs, succeeds, and comes back swapped — content present, no `additionalContexts`, the query rides the proxy and never spawns the CLI; literals / failed results / no-hit anywhere / dirty-ledger sessions all pass through untouched; a volatile `off → replace` flip opens the channel immediately; the `intercept-replace` counter shows up in the report); **arm S** for the settings-page read channel (after a replace event the volatile `stats` ref holds a **full rebuild from the counters** — `replace.hit` / graph split / `at` timestamp — followed by exactly one `settings/document-updated` emit: string ns as the first argument, otherwise cordis filters it as `thisArg`, and the browser ignores the args anyway — the event itself is the refresh trigger; wrapper calls and hint injections show up in the readout too; a **zero frame is pushed at boot** while telemetry is on (a freshly restarted page shows zero cards, not the empty state), and with **telemetry off nothing is pushed and nothing is emitted, boot included**); **arm R2** (scope, v0.8.2): a grep whose `path` points **outside** the workspace passes through untouched and the two layers are never queried — graph and zg are workspace-scoped, so swapping would fabricate coordinates from another repo (while an in-workspace `path` still swaps normally); **arm R3** (error text, v0.8.2): when the proxy wraps an underlying MCP error into ordinary text (`isError` stays false) the result counts as a **query failure** — no swap, and it increments `replace-pass-failed`, not no-hit (soaking, these two ratios mean opposite things); **arm S2** (cumulative counters, v0.8.2): boot seeds from the counts file (file says 7 ⇒ the first frame reads 7) and new events **max-merge** onto disk (7→8, never overwrite) — the harness gives every mount its own file via the `DSH_CBM_COUNTS_FILE` test seam so exact-number assertions stay uncontaminated; and the **hot-config contract**: the hot fields plus the read channel `stats` — seven in all — are marked `.volatile()` (nothing else is — marking a restart-required field would make the page lie), the intercept hook stays registered at `enforce: off` and lets the grep through, and flipping the volatile reference `off → deny → off` on an already-mounted plugin changes the verdict immediately; **arm T** (v0.9.0) proves the same contract for the newly promoted fields without any remount: flipping `dirtyTracking` opens/closes bookkeeping live (off ⇒ a new session's edit never enters the ledger and swaps stop yielding), flipping `contextHint` collapses the hint callback from a line to `""`, flipping `interceptTools` from `grep` to `grep,glob` makes a glob call get swapped on the spot — listeners resident, fields read at decision time |
| `check-chain.mjs` | really spawns adapter → engine over MCP stdio: proxy tool present, lazy connection woken up, `search_graph` returns real rows, **stage 3.5 measures the in-hook latency budget**, then `describe`s the exact tool shapes the prompt promises |
| `check-tokens.mjs` | **ablation arm**: direct engine vs proxied `tools/list` byte size; throws if the proxy is not smaller — the main claim must have a falsifiable premise |

Measured on the author's machine:

```
PATCH OK
202/202 arms passed (two profiles)   PLUGIN OK
CHAIN OK — in-hook proxy latency ms: min=28 median=32 max=34; with a zg-enabled temp manifest, stage 2b additionally bridges zg and a real semantic query returns hits
arm A direct engine            : 17 tools, 17308 B ≈ 4327 tokens
arm B proxied, cold cache      :  2 tools,  4278 B ≈ 1070 tokens  (4.0x)
arm C proxied, cache w/ resour.:  3 tools,  4871 B ≈ 1218 tokens  (3.6x)
wrapper schemas (code_find + code_callers): 1651 B ≈ 413 tokens  ← the price of layer ①
cbm CLI, same machine, one search_graph   : 5491 / 6526 / 8280 ms  ← why no hook ever spawns it
```

> `check-plugin.mjs` really indexes *this* repo once (the project lands in `~/.cache`, never in the repo). To verify a single profile: `node checks/check-plugin.mjs <profile>`.

## Troubleshooting

| Symptom | Cause & action |
|---|---|
| `code_index`/`code_setup` missing from the current session's tool list, yet calling them works | The tool list is a **per-session snapshot**: only newly opened conversations see it. "not listed" ≠ "not registered" |
| `zg_zvec_grep_search` fails with `root: Invalid input: expected string` | `root` is **required** — the absolute workspace root as visible to the daemon. The proxy does not fill arguments for the model: it already knows the session's working directory, so have it pass that |
| A model calls `zvec_grep_search` and gets tool_not_found | Proxied MCP tool names are **prefixed with the mcpServers key**: through this manifest the tool is `zg_zvec_grep_search` (the bare name only exists on a direct zg connection). The usage prompt gives the right name — seeing the bare name means the session is running a stale bundle: `npm run sync` + restart |
| A `grep` returned `Error: dsh-codebase-memory: …` | That is layer ② **intercepting**, not a fault: the default `enforce=off` never blocks, so this only appears if you set `deny-once`/`deny`. `deny-once` blocks a given symbol at most once per session and the reason already carries the `search_graph` hits. To turn it off: the Configure page, or `{"enforce":"off"}` |
| A `grep` "result" is a few index-hit lines instead of file content | Not a fault: `enforce=replace` (layer ②b) swapped the model-visible output of a symbol-shaped grep for graph/semantic hits — the call itself ran and succeeded, no error. Want the raw output back: flip enforce to `off` in the Configure page, effective immediately. Right after this session wrote code the swap steps aside (dirty ledger), so raw output there is also normal — both behaviours are intended |
| I changed `enforce` in the Configure page but greps still aren't blocked | First tell "not applied" from "legitimately allowed". The `触发层` line in `code_setup` reports the **live** value, so if it moved with the page, the hook is re-reading config on every call — that movement is the proof. Three passes stay legal regardless of mode: the pattern classified as a **literal** (② only blocks symbol-shaped searches), the graph has **no hit** for that symbol, or the session has no bindable workspace (cwd is not a path — e.g. a remote session). To see whether the hook ran at all, look for `intercept-*` lines in `telemetry.log` |
| The page's runtime counters are all zeros / have not moved for a while | The cards are always present (a frame is pushed at boot, seeded from the cumulative counts file), so **all zeros means no events since this boot and no history file**: no symbol-shaped grep, no code written. Telemetry off freezes the counts — the block stays at its last push and the footer says so. Writing a config value makes the host reset volatile refs to the document default — **not data loss**: the next event pushes the full readout back. Note the readout is **cumulative across restarts** (`telemetry.counts.json`): to start soaking from zero, delete that file and restart |
| There is **no Configure button** on the `codebase-memory` row under Settings → Plugins | The button comes from `lib/client.js`, and it appears only when all three of these hold — each one fails **silently**, which is why this row exists: ① the host serves the namespace only when `describe()` finds a volatile field on that entry, so an installed `index.js` **without** `.volatile()` means no button (`node scripts/sync.mjs`, then restart); ② the slot key must be exactly `<package name>#<row id>` (`dsh-codebase-memory#codebase-memory` here) — change the row id in `cordis.patch.yml` without changing the key and the button vanishes, which is why `npm run check:client` derives the key from the patch instead of trusting the bundle; ③ the bundle has to be switched on — the registration exists only while it is (`@deepseek-ai/dsh-client-ui-plugin-manager` README: "The bundle's patch must declare the row under that id, and the registration exists while the bundle is on"). `code_setup`'s `fileDrift` will name a stale client copy (`lib/client.js` is in `RUNTIME_FILES`), but it cannot tell you the button is missing. **Fields the page does not show** (`wrapperTools` / `sessionRefresh` / `autoIndex` / `bootstrap` / `dirtyRefreshCooldownSec` / `zgEnabled` / `zgToolset` / `zgVendorDir`) stay composition-level: edit the patch, restart the host — `wrapperTools` and `zg*` are **structurally** not hot-editable (tool registration has no unregister; the adapter manifest is read at process start), not merely unfinished |
| `code_find` warns "coordinates are probably stale" | Layer ⑤'s self-check fired: the returned source does not contain the symbol name (upstream issue #1750, the silent neighbour read). Run `code_index`; the plugin already scheduled a background refresh, but **do not trust those line ranges until it finished** |
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

- **Never throw at boot**: missing dependencies only update the reported state (`code_setup`), because a boot throw kills the whole profile. All precondition checks live at the tool-call site — "precondition unmet ⇒ throw" applies to calls, not startup. The same rule applies inside hooks: every listener is `try/catch` and returns `next()` on any doubt, because a hook exception on `tools/pre-execute` becomes a failed tool call for the model.
- **Host contracts the trigger layer leans on** — each verified against the installed `0.1.5-rc.2` dist (`@deepseek-ai/dsh-tool-cordis` carries the whole event/service catalogue; `dsh-tools/lib/index.js` and `dsh-system-prompt/lib/index.js` are the implementations), and each mirrored by the fake ctx in `check-plugin.mjs`:
  - `tools/pre-execute`: waterfall `(exec, next) → PreToolDecision`. `deny` short-circuits guards, and its `reason` becomes the *only* thing the model sees (`Error: <reason>`, `isError`). Denied calls **still reach post-execute**, where only write bookkeeping runs.
  - `tools/post-execute`: waterfall `(exec, result, next) → accept | block`; `additionalContexts: UserMessage[]` is the official "attach context for the next request" channel — the plugin **no longer uses it** (the `advise` soft-hint injection was removed on 2026-10-08); post-execute is bookkeeping-only and passes `next()`'s decision through unchanged.
  - **`ctx.tools.execute(input)` is public** (it is in the `tools` service's documented method list). That is what makes layers ①② usable: they reuse the keep-alive MCP connection (29–64 ms measured) instead of spawning `codebase-memory-mcp cli` (5.5–8.3 s measured). Input shape: `{callId, name, arguments, agent?, signal}`.
  - `systemPrompt.context({name, order, text})`: `text` must be a **string or a synchronous function** (async or `undefined` violates the assembly invariant) and `""` means "skip this turn". Contexts are not in the prompt text — they are projected as a user-role *runtime context snapshot* per model step, so `suppressRuntimeContext()` (minimal agent preset) drops them all; the standing `section()` is unaffected.
  - Text rendered into the prompt goes through strict `{{variable}}` interpolation, so anything user/engine-derived must not form a valid unregistered variable (`noVars`).
  - This host emits **both** `agent/created` and `agent/session-start`; the latter is what `sessionRefresh` listens on, and `agent.inject(message)` is the documented way to seed context from it (the emit's return value is indeed not consumed by the host).
- **Two real contracts of `ctx.subprocess.spawn`** (this plugin shipped a bug past each of them once; the acceptance fake ctx now mirrors both):
  1. `cwd` is required — the implementation evaluates `spec.cwd.includes('\0')`, so `undefined` throws TypeError;
  2. `collected.stdout.readFrom(n)` returns `{ text, nextOffset, lossy }`, not a string — `String()` of it is `"[object Object]"`.
- **One index job per workspace, and one retry when the engine aborts.** Two concurrent `index_repository` runs on the same repo do not both succeed: the engine kills one with exit code 1 and `status: "aborted_previous_preserved"` (its own hint says "Retry"). This is reachable in normal operation — layer ⑤'s background refresh, `code_index`, and the engine's own watcher can all want the same workspace at once. So both paths go through a per-cwd in-flight lock, and an aborted run is retried once and *counted* (`index-retry-contention` in telemetry). `check-plugin.mjs` arm G9 reproduces the abort in the fake subprocess layer, because a fix that only ever triggers in production is a fix nobody verifies.
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
