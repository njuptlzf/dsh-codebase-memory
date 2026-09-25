# dsh-codebase-memory

English | [简体中文](README.zh.md)

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) host bundle that wires [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) into your agent sessions: **it builds a code knowledge graph of the current session workspace and lets the model retrieve code through the graph — instead of grepping file by file**.

## Table of contents

- [How the chain is composed](#how-the-chain-is-composed)
- [Why this plugin exists](#why-this-plugin-exists)
- [Install](#install)
- [Usage](#usage) — including [prompting recipes](#3-prompting-recipes-what-actually-triggers-it) and an [AGENTS.md template](#4-encoding-it-in-agentsmd-make-it-permanent)
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

> **Confirm the target profile first.** Desktop and web are separate profiles; installing into the wrong one fails in a very quiet way — after restart the tools simply never appear. When unsure: `dsh --profile <name> --dump-config` and search for `codebase-memory`.
>
> `dsh plugin add` may hang for a long time in dependency-heavy profiles (observed: >10 min). It is really two steps: pnpm installs the package, then the CLI adds the name to `dsh.profile.bundles`. If it stalls, do the second step by hand — the plugin goes live given "files in node_modules + name in bundles":
>
> ```jsonc
> "dsh": { "profile": { "bundles": [ /* ... */, "dsh-codebase-memory" ] } }
> ```

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

```powershell
# one sqlite per project, all under the cache (nothing lands in your repo):
Get-ChildItem ~/.cache/codebase-memory-mcp -Filter *.db
```

Measured order of magnitude (mid-size TS repo, ~700 files): first build 10–13 s, ~1,700 nodes; a refresh costs ~8 s (the engine re-parses fully — it is not incremental); a single query < 100 ms.

### 2. The standard flow

```
code_index (build / refresh after edits) → you have the project name
→ cbm_search_graph to locate symbols → cbm_get_code_snippet to read exactly that range
→ for relationships: cbm_trace_path / cbm_detect_changes
```

All retrieval goes through the proxy tool `mcp__cbm__mcp`; pass `args` **as a plain object** (no JSON-string double encoding):

```jsonc
{"tool": "cbm_search_graph",     "args": {"project": "<project>", "query": "symbolName", "limit": 10}}
{"tool": "cbm_get_code_snippet", "args": {"project": "<project>", "qualified_name": "<qn from search_graph>"}}
{"tool": "cbm_trace_path",       "args": {"project": "<project>", "function_name": "X", "direction": "callers"}}
```

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
- After edits, refresh with `code_index` (~8 s full re-parse; worth it).
```

Three rules of thumb for writing this kind of instruction:

1. **Write rules, not manuals** — "before reading code, follow this path" beats "you may use the index". The model defaults to grep not because it doesn't know better, but because nobody said otherwise.
2. **Leave an exit** — "grep only for literals" is more correct than "never grep". Literal-string search genuinely belongs to grep.
3. **Hard-code the two biggest traps** — how to obtain the project name, and how to scope a multi-repo workspace. Omit these and the model falls back to grep after one failed attempt.

## Configuration (optional)

Add `config:` to the `codebase-memory` row in the composition:

| Field | Default | Meaning |
|---|---|---|
| `bootstrap` | `background` | `blocking` / `background` / `manual` (manual = probe only, never download) |
| `adapterVersion` | `2.29.0-0.0.4` | pinned; **the single upgrade entry point** |
| `adapterDir` | `$DSH_HOME/vendor/mcp-adapter` | where layer ② and `cbm.json` live |
| `cbmPath` | auto-probe | leave empty to probe official → vendor → PATH |

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
| Results look stale right after edits | Refresh with `code_index` (~8 s). In MCP mode the daemon also watches, but refreshing before acting is the cheap, deterministic option |
| A file/directory never shows up | Nine times out of ten `.gitignore` excludes it (the engine honors gitignore + skips `node_modules` etc. by default). The `excluded` / `not_indexed_files` fields in `code_index` output list why |
| Installed on desktop, nothing happens | Wrong profile, most likely. Confirm with `--dump-config` that `codebase-memory` is in the composition |

## Engineering notes (for whoever modifies it)

- **Never throw at boot**: missing dependencies only update the reported state (`code_setup`), because a boot throw kills the whole profile. All precondition checks live at the tool-call site — "precondition unmet ⇒ throw" applies to calls, not startup.
- **Two real contracts of `ctx.subprocess.spawn`** (this plugin shipped a bug past each of them once; the acceptance fake ctx now mirrors both):
  1. `cwd` is required — the implementation evaluates `spec.cwd.includes('\0')`, so `undefined` throws TypeError;
  2. `collected.stdout.readFrom(n)` returns `{ text, nextOffset, lossy }`, not a string — `String()` of it is `"[object Object]"`.
- **Windows trio**, all worked around explicitly in code: PATH's `npm.cmd` cannot be spawned without a shell → probe `npm-cli.js` and run it under node; the engine's `.cmd` shim, same story → the manifest always points at the absolute `.exe`; PowerShell 5.1 reads BOM-less Chinese `.ps1` as ANSI → every script here is `.mjs` run by node.
- **After edits: sync, then restart.** pnpm treats `file:` dependencies as immutable by lockfile — content changes are never re-copied. `node scripts/sync.mjs` copies straight into each installed profile and re-hashes to verify. `link:` (junction) is *not* an option: Node resolves realpath, and bare `@deepseek-ai/*` imports fail from the repo path. A running host locks the composition, so sync only touches files that differ.
- **Checks must be falsifiable**: after hardening a check, run it against the *old, unsynced* code first — only reproducing the exact production error (FAIL, exit 1) proves it has teeth; then fix, then go green.

## Known limitations & non-goals

- **Platform**: the current implementation hardcodes Windows (`USERPROFILE` fallback, `.exe` probing, npm-cli.js candidates). Linux/macOS users: issues and PRs welcome.
- **Refresh is full**: `code_index` re-parses the whole workspace every time (~8 s for a mid-size repo). Graph freshness = your last call.
- Data-ish files are simply not code: anything your `.gitignore` excludes (databases, build output, question banks) will never appear in the graph — by design.
- **Explicit non-goals**: porting the MCP adapter, writing an indexing engine, rolling our own downloader, building a watcher, committing index artifacts to repos, an index-status sidebar UI, and smart cross-project routing (see [why](#why-this-plugin-exists) — choosing the workspace is, and should remain, a human decision).

## License

[MIT](LICENSE)
