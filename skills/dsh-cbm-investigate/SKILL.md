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

## DSH tool surface

When this skill is active:

- Index current workspace code with `code_index`, not raw `index_repository`.
- Structural cbm queries use `mcp__cbm__mcp` with `cbm_*` tools.
- **Never hunt symbols with grep alternation.** `grep "a|b|c"` over several symbol names is the single most common escape hatch away from the index (audited: one session ran 110 greps vs 6 graph calls; the model even noted in its own log that "alternation didn't trigger a replace"). A multi-symbol structural question is NOT a text search — call `code_find`/`code_callers` once per symbol (or one `cbm_query_graph`/trace covering the chain). grep keeps exactly one job here: exact literals, log lines, config keys, regex over prose. If a pattern mixes symbol branches with literal branches, keep the literal hunt in grep and route every symbol branch through the graph — do not "keep it together" by letting the symbols ride the grep.
- Source snippets use `cbm_get_code_snippet` with `format: "json"`.
- File coordinates used as edit anchors must be freshness-checked with `cbm_check_index_coverage`; when the worktree is dirty or coverage is not clean, re-read disk bytes before editing.
- External or sibling repositories are not auto-indexed by the model. If a needed project is missing, state partial scope and ask the user to open that workspace or approve CLI indexing.
- If cbm queries fail, run `code_setup`. Do not silently fall back to grep/read.
- When `zg_zvec_grep_search` is present (opt-in semantic layer), it answers natural-language questions ("code that handles X") and hits non-code files the graph does not index; always pass `root` = absolute workspace path. Prefer the wrapper `code_search("<natural language>")` when the plugin exposes it — it fills `root`/`limit` for you. Symbols and callers still go through `code_find`/`code_callers`, exact literals still go through `grep` — three layers, distinct jobs, no substitution. Semantic hits are **leads, not coordinates**: they carry no qualified name and no `file:line`, so never cite them as an edit anchor. A first query in a repo without `.zvec-grep/` fails with `INDEX_MISSING` (upstream authorization gate, not a fault): keep investigating with the other layers and ask the user before building the index. But `Failed to open zvec collection storage` / `ZVEC_OPEN_FAILED` on a repo that **has** `.zvec-grep/` is a different thing — a dead-handle fault with a known self-heal path; go to「zg 语义层：坏死自诊与自动修复」, do not silently fall back to grep.

## 输出可能被插件改写（先读这一段）

`dsh-codebase-memory` 会在 `tools/post-execute` 上改写 grep 的**输出**（grep 本身照常执行、照常成功）。看到下面几种开头，先认出来再动手，别把它当成工具坏了：

| 首行 | 含义 | 该怎么办 |
|---|---|---|
| `【替换自 结构层(图谱) · 仓 X · N 行】…原始输出已丢弃` | 你 grep 的是符号，插件把输出换成了图谱命中。**原始 grep 结果不在了** | 直接用这些命中（有 qualified_name + 文件 + 行范围）；要源码就 `code_find`，要调用者就 `code_callers`。别再 grep 一次同样的 pattern |
| 同上，但第二行是 `（已过滤 N 条本会话改过的文件…）` | 这个会话用 write/edit 改过那些文件，它们的坐标可能过期，**被剔除了**；你看到的是剩下的、仍然可信的命中 | 要那 N 条就先 `code_index` 再查；别把过滤当成"图里没有" |
| `【替换自 语义层(zg) · …】` | 语义近似片段，**不是**符号定义、没有坐标 | 只当线索；要坐标回 `code_find` |
| `【未替换 · 原始 grep 输出 · 仓 X】…没被换掉：<原因>` | 插件想换但放弃了（台账脏 / 查询失败 / 无命中），下面是**真的原始 grep 输出** | 原因写在那行里：`台账脏` ⇒ 先 `code_index`；`检索层查询失败` ⇒ `code_setup` 看链路；`无命中` ⇒ 图里确实没有，grep 才是对的工具 |
| `dsh-codebase-memory：grep 找符号 "X" 已被拦下…` | `enforce=deny` 档的硬拦截（同一会话同一符号只拦一次）。这是**插件**说的，不是工具报错 | 换 `code_find` / `code_callers`，别重试 grep |

替换**只发生在符号类 pattern** 上：字面量、正则、配置值、日志片段一律原样返回。语义层**不参与**替换——它答的是问题，不是正则。

## 索引与链路的三件事

- `code_index` 一次做三件事：建/刷新图谱、**返回并缓存权威 `project`**、清空本会话的脏台账。所以"改完代码先 `code_index`"不是礼节——它同时让坐标变新、让替换通道重新打开。
- `code_setup` 的两个动作：`{action:"install-zg"}`（装可选语义层，约 430MB，**必须先问用户**）、`{action:"restart-adapter"}`（重拉适配层清单，秒级；语义层开关切换后必须走这一步才生效，不必重启宿主）。
- 本会话用 `write`/`edit` 改过文件时，`code_find`/`code_callers` 的输出会带 `⚠ 本会话…这些改动还没进索引`。看到它就先把 `code_index` 跑了再采信行号——插件自己的会话台账比 `cbm_index_status` 可信（后者在引擎 0.11.0 上是全局代际判定，不是逐路径判定）。
- **陈旧提示是命令不是参考**：系统提示行里出现「本会话改了 N 个文件（坐标可能过期）」或上面那个 ⚠ 台账标记时，任何拿图谱坐标当编辑锚点之前必须先 `code_index`，成功后再 `cbm_check_index_coverage` 验鲜。不许用"整文件重读磁盘"绕开陈旧——实测一次 194 次编辑的会话就是这么烧掉 162 次全文 read、只调了 2 次 `code_index` 的。

## zg 语义层：坏死自诊与自动修复（修复免确认；首建仍须问）

**触发签名**（任一命中即进入本节，不要静默退回 grep 继续干活）：

- `code_search` / replace 补位报 `Failed to open zvec collection storage`、`ZVEC_OPEN_FAILED`，或 status 里出现 `ZVEC_PERMISSION_DENIED`；
- `code_setup` 遥测 `zg-index-failed` 在涨、或 `replace-pass-failed` 高企；
- 查询"成功"但 hits=0 且 Coverage 数字长期不动（索引冻在旧代际）。

区分：`INDEX_MISSING`（本仓没有 `.zvec-grep/`）是上游授权门不是故障——**首建索引仍须用户同意**（430MB 包/opt-in 决策链）。本节只处理"已有索引但坏死"的自动修复：rebuild 是本地 embedding 重算，无网络、无密钥、分钟级，属于可逆修复，直接做。

**核心认知（为什么 daemon 活着却全灭）**：`zg server status: ready` ≠ collection 可开。healthz 只证明进程活着；zvec 的 Windows 锁语义是 **readOnly open 也要排他 LOCK**——长命 daemon 持有 collection 句柄后，它自己的 query/index job 再 open 同一 collection = 自我碰撞，每个 job 必败（8 次重试 ≈4.5s）而 daemon 静默 ready（实测案例：17 天无人察觉，攒了 1800+ 个 0 字节 WAL，268 文件 upsert 全被拒）。

**诊断（成本从低到高，确认即停）**——`$cli` = `code_setup` 报告「语义层(zg)」行给出的 CLI 路径，命令在 workspace 根跑：

1. `node $cli status` —— Coverage 冻在低值 + Queue failed>0 + Problem 含 `OPEN_FAILED`/`UPSERT_FAILED … PERMISSION_DENIED` ⇒ 坏死坐实，直接进修复。
2. 签名不明时看 daemon 日志（`~\.zvec-grep\daemon\logs\server.log` 尾部）：`"event":"job.finished","state":"failed","error_code":"ZVEC_GREP.ENGINE.STORAGE.ZVEC_OPEN_FAILED"` ⇒ 同上坐实。
3. 佐证（可选）：`.zvec-grep\index.zvec\` 下 0 字节 `.log` 计数 >100 = WAL 风暴（每次失败 open 产一个）。

**修复（按序执行，全部可逆）**：

1. `node $cli server off` —— 杀坏死 daemon。担心殃及共享它的其他仓？坏死 daemon 对所有仓的 job 都已失败，殃及无损失；存疑先做上面第 2 步看日志。
2. `node $cli index --rebuild` —— 重建本仓索引；模型缺失等失败 ⇒ 报告原因并停，不循环重试。
3. `code_setup {action:"restart-adapter"}` —— 让 stdio proxy 重连并自动拉起新 daemon。
4. `code_search` 复验：**第一次可能因 daemon 冷启动超时（budget 4s），重试一次再下结论**。hits>0 且相关 ⇒ 修复完成。

修完向用户报告证据（修复前后 Coverage / failed 计数），并把「daemon ready ≠ collection 可开」这条写进结论——否则用户会以为监控全绿就是没事。

## Step 0 — preflight

1. Confirm the `dsh-codebase-memory` plugin chain.
   - If a structural query is needed, run `code_index` first.
   - If `code_index` or `mcp__cbm__mcp` fails, run `code_setup` and report the concrete failure.
   - If `code_search` fails with `ZVEC_OPEN_FAILED`-class errors on a repo that has `.zvec-grep/`, that is a dead-handle fault: run the「zg 语义层：坏死自诊与自动修复」flow before concluding the semantic layer is unusable.

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
| 语义层 zg | code_search / zg_zvec_grep_search | N |
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
