---
name: dsh-cbm-investigate
description: Self-contained DSH cbm workflow combining root-cause debugging with codebase impact analysis. Use when debugging needs blast-radius checks, impact analysis finds a defect to fix, or design discussion needs graph-backed structure. Embeds a portable investigation core and queries cbm_* through mcp__cbm__mcp.
whenToUse: |
  Use when a task straddles bug investigation and structural cbm analysis:
  - "debug this, but check who else calls this function before changing it"
  - "trace this flow; if the logic is wrong, fix it"
  - "设计讨论 / 先看现状 / 分析影响范围后再决定改不改"
  Pure structural impact questions can use dsh-codebase-impact-analysis alone.
  A global investigate skill is optional; do not stop when it is absent.
---

# DSH cbm Investigate

This skill is a self-contained DSH workflow. It combines:

- a reduced, DSH-safe investigation core in `references/investigation-core.md`;
- `dsh-codebase-impact-analysis` for cbm graph queries, blast radius, freshness, and anti-degradation rules;
- optional global `investigate` when it is installed and the user explicitly wants that richer gstack-style process.

The plugin repo must remain usable on another DSH install without copying `investigate`. Therefore `investigate` is not a dependency. If `investigate` is missing, continue with this skill. If `investigate` is present, use it only as an optional extension, not as a gate.

## Tool contract — delegated, not restated

This skill owns **routing and process** (Step 0, Entry A/B/C, the output-rewrite decode table, the closing count table). The tool-surface rules — which layer answers what, the grep-alternation discipline, `format: "json"`, freshness gates, the stale-ledger directive, the three-layer no-substitution rule — have exactly one written home: **`dsh-codebase-impact-analysis`** (Hard rules 1–7, Preferred tools, Step 0 gate). Step 0 loads it before any structural query. When plugin behavior changes, update that skill and the plugin's injected `usageSection` together — never restate rules here, duplicated rules drift (this file once carried a pre-v0.16 alternation clause while the impact skill and classifier had both moved on).

## 输出可能被插件改写（先读这一段）

`dsh-codebase-memory` 会在 `tools/post-execute` 上改写 grep 的**输出**（grep 本身照常执行、照常成功）。看到下面几种开头，先认出来再动手，别把它当成工具坏了：

| 首行 | 含义 | 该怎么办 |
|---|---|---|
| `【替换自 结构层(图谱) · 仓 X · N 行】…原始输出已丢弃` | 你 grep 的是符号，插件把输出换成了图谱命中。**原始 grep 结果不在了** | 直接用这些命中（有 qualified_name + 文件 + 行范围）；要源码就 `code_find`，要调用者就 `code_callers`。别再 grep 一次同样的 pattern |
| 同上，但第二行是 `（已过滤 N 条本会话改过的文件…）` | 这个会话用 write/edit 改过那些文件，它们的坐标可能过期，**被剔除了**；你看到的是剩下的、仍然可信的命中 | 要那 N 条就先 `code_index` 再查；别把过滤当成"图里没有" |
| `【未替换 · 原始 grep 输出 · 仓 X】…没被换掉：<原因>` | 插件想换但放弃了（台账脏 / 查询失败 / 无命中），下面是**真的原始 grep 输出** | 原因写在那行里：`台账脏` ⇒ 先 `code_index`；`检索层查询失败` ⇒ `code_setup` 看链路；`无命中` ⇒ 图里确实没有，grep 才是对的工具 |
| `dsh-codebase-memory：grep 找符号 "X" 已被拦下…` | `enforce=deny` 档的硬拦截（同一会话同一符号只拦一次）。这是**插件**说的，不是工具报错 | 换 `code_find` / `code_callers`，别重试 grep |

替换**只发生在符号类 pattern** 上：字面量、正则、配置值、日志片段一律原样返回。v0.17.0 起图谱是替换的唯一来源（可选语义层已删除）。

## Step 0 — preflight

1. Confirm the `dsh-codebase-memory` plugin chain.
   - If a structural query is needed, run `code_index` first.
   - If `code_index` or `mcp__cbm__mcp` fails, run `code_setup` and report the concrete failure.

2. Load `dsh-codebase-impact-analysis` before structural code queries.
   - This skill owns routing.
   - `dsh-codebase-impact-analysis` owns the cbm tool table, freshness gate, blast-radius workflow, rename workflow, flow tracing, and deep rules.

3. Choose the investigation process:
   - Default: use this skill's `references/investigation-core.md`.
   - Optional: if a global `investigate` skill exists and the user explicitly asks for it, load it and follow its process.
   - If global `investigate` is absent, do not stop. Continue with `references/investigation-core.md`.

## Entry A — symptom-driven debugging with impact awareness

Use when the user starts with a bug but the fix should not land without blast-radius awareness.

1. Run root-cause investigation using `references/investigation-core.md` Phase 1 to Phase 3, but delegate all structured code queries to `dsh-codebase-impact-analysis`:
   - Definition lookup: `code_find`, or `cbm_search_graph` when you need label/name/file filters — not raw grep.
   - Source reading: `cbm_get_code_snippet(format:"json")`, not full-file `read` unless context beyond the symbol is needed.
   - Caller/callee lookup: `code_callers`, or `cbm_trace_path` for depth/mode control — not grep for function names.
   - Text/config/dynamic references: `cbm_search_code`, with at least one search not restricted to a single file type when hunting configuration values.

2. **Anti-anchoring check.** Before committing to a single potential cause, ask whether the value was already wrong before it reached that point. Trace the value lifecycle with three questions:
   - Definition: where is the value produced? Check `.go`, `.sql`, `.yaml`, `.yml`, templates, `{{.}}`, config, and generated files when relevant.
   - Transformation: what renders, merges, filters, overrides, or persists it along the way? Note priority order.
   - Re-generation: is there a later render or rebuild step that overwrites the saved value with a definition-time default?

   If the definition or a later regeneration already produces the wrong value, the downstream suspect may not be the root cause.

3. **Early impact gate.** If you are about to dismiss a gap because one consumer path has a guard, run impact analysis before accepting that conclusion:
   - Find the function whose output carries the gap.
   - Run `cbm_trace_path(direction: "inbound")` on that function.
   - Check every consumer path.
   - If any consumer lacks the guard, the gap is real.

4. Before implementation, run `dsh-codebase-impact-analysis` Workflow 1 on the functions the fix will touch:
   - `code_find` resolves the target (use `cbm_search_graph` for filtered resolution).
   - `code_callers("<qualified_name>")`, or `cbm_trace_path(direction: "inbound", depth: 3)` at minimum.
   - Widen to depth 5 or add `direction: "outbound"` when contracts or fan-out change.
   - Add architecture/route/cross-service checks when an HTTP, gRPC, queue, workflow, or CloudEvent boundary is involved.

5. Feed the blast-radius result into the investigation core's >5-file gate. If the graph already shows a wide or cross-service radius, surface it up front.

6. Hand off to `references/investigation-core.md` Phase 4 and Phase 5, or to the optional global `investigate` if it was loaded. Use graph-backed queries for any further code lookup.

## Entry B — structure-driven analysis that finds a defect

Use when impact analysis or flow tracing unexpectedly reveals an actual defect.

1. Load and run `dsh-codebase-impact-analysis` Workflow 1 or 3.
   - Every structural claim needs a locator.
   - Cross-service edges alone are not far-side proof.
   - If the chain crosses repos, verify each project or mark the missing side unverified.

2. If the result is only "risky to change", stop with the impact report. Do not force a debugging workflow.

3. If the result shows a concrete defect, ask the user whether to fix it now.

4. If the user confirms a fix, skip root-cause Phase 1 to Phase 3. The root cause is already established by code structure. State the finding in the standard form:

   ```text
   Root cause hypothesis: [defect] — [project/file:line]
   ```

5. Hand off directly to the investigation core Phase 4 and Phase 5, or to optional global `investigate` if present and requested.

## Entry C — design discussion or structural exploration

Use when the user wants code-graph understanding before deciding whether to change anything.

1. Run `dsh-codebase-impact-analysis`:
   - locate symbols with `code_find` (or `cbm_search_graph` for filtered searches),
   - map relationships with `code_callers` / `cbm_trace_path`,
   - summarize entry points or modules with `cbm_get_architecture`,
   - pull key source with `cbm_get_code_snippet(format:"json")`.

2. Present the structural result. This entry is read-only by default. Do not patch code and do not start the investigation implementation phases unless the user explicitly asks.

3. After presenting findings, ask whether the user wants to proceed to changes:
   - If yes, hand off to the investigation core Phase 4 and Phase 5, or optional global `investigate` if available.
   - If the user only wanted understanding, stop.
   - If they want a different trace, loop back to step 1 with the new target.

## 收尾：分层报数表（本 skill 激活时必须交付）

任务收尾的最终回复里放一张四行计数表（参照 dsh-GenUI 的结论卡做法：宿主有 GenUI 渲染时优先出 ```dsh-ui 的 table 围栏，发前过 validate_dsh_ui；无 GenUI 或校验不过就降级成下面的 markdown 表——不硬依赖插件），让"有没有真走索引"在会话内直接可见，而不是事后翻日志：

| 层 | 通道 | 次数 |
|---|---|---|
| 结构层·包装动词 | code_find / code_callers / code_index | N |
| 结构层·mcp 代理 | mcp__cbm__mcp 的 cbm_* 长尾（mcpScript 内每次 tools.call 也计入） | N |
| 字面量层 | grep / read | N |

- 次数按本会话实际调用自计；不得美化，0 就写 0（写 0 恰恰是复盘信号）。
- 表下补一行交叉校验口径：「插件设置页遥测（intercept-replace / near-miss-symbol / dirty record）为准，本表为模型自报」——两边对不上就是行为问题，指给用户看。
- 若字面量层次数显著高于结构层且本任务含符号问题，表格后必须给一句原因（新会话未 code_index / 图无该符号 / 纯字面量任务），否则视为漏走索引。

## Optional global investigate

If the host has a richer global `investigate` skill and the user wants that workflow:

- Load it only after this skill's DSH tool surface is clear.
- Let it own Phase 1 to Phase 5, telemetry, voice, scope lock, hooks, or project-specific review behavior if those exist.
- Override only its structured code queries: definitions, callers, blast radius, flow tracing, and graph-backed impact must follow `dsh-codebase-impact-analysis`.
- Do not hard-depend on it. Do not treat it as absent-proof.

The default path is `references/investigation-core.md`, so another user who installs this plugin still gets a usable debugging + cbm workflow.
