---
name: dsh-codebase-impact-analysis
description: Use DSH dsh-codebase-memory for pre-change impact, safe renames, caller and callee tracing, business-flow analysis, dead-code checks, and diff risk. Trigger on 谁调用X, 改X影响哪些地方, 重命名风险, 调用链, 架构图, 死代码. Index via code_index and query cbm_* through mcp__cbm__mcp.
whenToUse: |
  Use inside DSH when the dsh-codebase-memory plugin is installed and the question needs graph-backed code analysis:
  - "改这个函数影响哪些地方", "这个函数谁在调用", "这个改动风险大不大"
  - "重命名 XXX 会不会漏改", "某个符号是不是死代码"
  - "理清业务流程 / 调用链 / 入口到实现路径"
  - "画模块架构、路由、包结构、入口点"
  Do not use for a single file read or a literal config value unless the graph is only a secondary check.
---

# DSH Codebase Impact Analysis

This skill is the DSH-aware successor to the older `codebase-impact-analysis` skill. It is written for the `dsh-codebase-memory` host bundle, not for a raw `codebase-memory-mcp` MCP client.

The model-facing tool surface is:

| Need | Tool | Why |
|---|---|---|
| Build or refresh the current workspace graph | `code_index` | Binds indexing to the current session workspace and returns the authoritative `project` name. |
| Resolve a symbol → qualified name, file, line range, source | `code_find` | Wrapped high-frequency path; the plugin fills `project` from the session workspace. Prefer it over grep-for-definitions. |
| Trace callers / callees of one symbol | `code_callers` | Wraps `cbm_trace_path` (default `inbound`). |
| Repair or inspect plugin chain | `code_setup` | Reports adapter, cbm binary, manifest, sync status, and trigger-layer counters. |
| Run cbm graph queries | `mcp__cbm__mcp` | The plugin compresses cbm MCP tools into a proxy tool. |
| Batch multi-step cbm queries | `mcp__cbm__mcpScript` | Use when a workflow needs repeated graph calls and you want to avoid round trips. |

Raw cbm tools are still available conceptually, but their names are prefixed and must be passed through the proxy:

```jsonc
{"tool": "cbm_search_graph", "args": {"project": "<project>", "query": "<symbol or business term>"}}
{"tool": "cbm_get_code_snippet", "args": {"project": "<project>", "qualified_name": "<qn>", "format": "json"}}
{"tool": "cbm_trace_path", "args": {"project": "<project>", "function_name": "<qn>", "direction": "inbound", "depth": 3}}
{"tool": "cbm_check_index_coverage", "args": {"project": "<project>", "paths": ["relative/path.ts"]}}
```

`cbm_index_repository` and `cbm_delete_project` are deliberately excluded from the model-facing surface. Do not call them. Indexing another repo requires opening that repo as a DSH workspace or running a human-approved CLI command.

## Hard rules

1. **Current workspace first.** If the target code is in the current session workspace, run `code_index` before structural graph queries. Use its returned `project`; do not infer the project from the folder name.

2. **All graph queries go through `mcp__cbm__mcp`.** Use `tool: "cbm_*"` and object `args`. If a tool shape is unclear, ask the proxy with `{"describe": "cbm_search_graph"}` or `{"server": "cbm"}` rather than guessing.

3. **Always pass `project` where accepted.** Cross-project indexes share the graph store. A missing `project` can silently query the wrong project. (`code_find` / `code_callers` deliberately take no `project` — the plugin resolves it from the session workspace.)

4. **Use JSON for source snippets.** Always include `format: "json"` in `cbm_get_code_snippet`. The default tree format is a layout envelope and can change line whitespace.

5. **Verify line coordinates before treating them as edit anchors.** `cbm_index_status` can report `ready` while file coordinates are stale after unindexed edits. Before citing or editing `file:line`, run `cbm_check_index_coverage` on the cited paths. If it reports `freshness=metadata_changed`, `recommended_action=read_source_and_reindex`, or the git worktree is dirty and the line range is load-bearing, refresh with `code_index` and then read disk bytes with `read` for the edit anchor.

6. **Do not silently degrade to grep/read.** Structural code queries must prefer `code_index` and `cbm_*` tools. Use `grep`/`read` only for literals, non-graph files, explicit user-approved fallback, or after a verified graph failure. If you fall back, begin the answer with the tool path and graph status, for example:

   ```text
   [工具路径] dsh-codebase-memory cbm graph；code_index=<project>, coverage=<clean|metadata_changed|not-checked>
   ```

7. **External repositories are not model-indexed.** If a sibling repo or another service is not present in `cbm_list_projects`, do not attempt `index_repository`. Tell the user which project is missing and whether the conclusion is limited. Use the human-approved CLI path only when the user explicitly asks for it.

## Preferred tools

| Task | Prefer |
|---|---|
| Resolve symbol, qualified name, file, line | `code_find` (no `project` needed); for filters (`label`, `name_pattern`, `file_pattern`, paging) use `cbm_search_graph` with `project` + `query`. |
| Read function source | `cbm_get_code_snippet` with `qualified_name` and `format: "json"`. |
| Find callers or callees | `code_callers` (default `inbound`); for `depth`/`mode`/paging use `cbm_trace_path` with `function_name`, `project`. |
| Find text references, configs, strings, generated API names | `cbm_search_code` with `project`, `pattern`, usually no narrow `file_pattern` for config fields. |
| Map uncommitted diff | `cbm_detect_changes` with `project`, `scope: "impact"` when needed. |
| High-level flow start points | `cbm_get_architecture` with aspects such as `entry_points`, `routes`, `packages`, `clusters`. |
| Multi-hop or aggregate graph query | `cbm_query_graph` after checking labels via `cbm_get_graph_schema`. |
| File-level index freshness | `cbm_check_index_coverage` with `paths`. |
| Project inventory | `cbm_list_projects` with `detail: "identity"`. |

## Step 0 — DSH gate

For work in the current session workspace:

1. Run `code_index({mode:"full"})` unless the same session already indexed the workspace with no subsequent substantial edits.
   - Use `mode: "fast"` only for a small refresh where semantic similarity is unnecessary.
   - `code_index` is blocking and returns `project`, `status`, `nodes`, `edges`, and `root`.

2. If `code_index` fails, run `code_setup` and report the failure. Do not continue as if graph analysis ran.

3. For an already indexed external project, discover it with:

   ```jsonc
   {"tool": "cbm_list_projects", "args": {"format": "json", "detail": "identity"}}
   ```

4. Before using any `file:line` as a report locator or edit anchor, check freshness for the cited paths:

   ```jsonc
   {"tool": "cbm_check_index_coverage", "args": {"project": "<project>", "paths": ["relative/path.ext"]}}
   ```

5. If the workspace has uncommitted changes and the analysis depends on exact line content, prefer reading the file from disk for edit anchors after the graph has told you which symbol/path matters. The graph decides *where to look*; `read` supplies *the exact bytes to edit*.

## Core workflow

### Workflow 1 — pre-change impact

Goal: before changing a function, know what breaks.

1. Resolve the symbol with `cbm_search_graph`.
2. Run `cbm_trace_path(direction: "inbound", depth: 3)` for direct and transitive callers.
3. Add `direction: "outbound"` if the change may alter the function's call behavior or return contract.
4. If local edits already exist, add `cbm_detect_changes`.
5. If callers cross service boundaries, treat a cross-service edge as insufficient proof; trace into the receiving project or mark downstream behavior unverified.
6. Pull only representative caller snippets with `cbm_get_code_snippet(format: "json")`.

Output a short risk report: direct callers, transitive depth, cross-service edges, test scenarios, and risk verdict. Every behavioral claim needs a `file:line` or `qualified_name` locator.

### Workflow 2 — safe rename

Goal: no missed references.

1. Resolve the exact symbol and disambiguate overloads with `cbm_search_graph`.
2. Run `cbm_trace_path(direction: "inbound", depth: 5)` for graph-confirmed references.
3. Run `cbm_search_code` on the old name to catch strings, configs, docs, dynamic dispatch, and unsupported language edges.
4. Union the two sets. Text-only matches are manual-review items, not automatically safe graph matches.
5. After the rename, refresh with `code_index` and search the old name again; it should have zero graph hits.

### Workflow 3 — business flow tracing

Goal: reconstruct a request or command path.

1. Start with `cbm_get_architecture` to find entry points, routes, packages, and hotspots.
2. Use `cbm_search_graph` or `cbm_search_code` to locate the feature entry.
3. Use `cbm_trace_path(direction: "outbound", depth: 3)` from the entry point, widening only when needed.
4. For cross-service paths, use `cbm_query_graph` or multiple `cbm_trace_path` hops. State each hop as verified, inferred, or unverified.
5. Pull key hop source with `cbm_get_code_snippet(format: "json")`.

## Deep rules

When the task involves multi-repo analysis, cross-branch/worktree analysis, frontend/generated API impact, deployment or async workflows, protection coverage, or per-change test-type verdicts, load:

```text
references/deep-rules.md
```

Do not load it for a simple local caller lookup unless the conditions above apply.

## Post-analysis memory

If the `memory_save` tool is available and a conclusion has passed verification gates, store the stable conclusion, not the working state. Use `type: "project"` and a title that names the function or domain. Do not store `file:line`, risk verdicts, or raw trace results; those change with the code.

Example:

```text
memory_save(type="project", title="UpdateData deployment-path classification", content="Verified conclusion: UpdateData sits on the upgrade/deployment path; its output feeds stage execution.", importance=3)
```
