# 工具命中率复盘：为什么 code_find / cbm_* 叫不出来

- 日期：2026-11-01
- 版本：dsh-codebase-memory v0.20.1
- 状态：复盘完成；最小根治集 C+D+F 已实施、全量 174/174 验收，发布为 v0.20.1（bump 并入 fix 提交，未 push/tag）；其余 P0（P0-1/2/4）未实施

## 0. 结论（TL;DR）

1. **链路没坏，选择没发生。** 本次审计 `code_find` 只被调用 2 次，grep 110+、read 162；但同一场会话里 grep 钩子仍然工作（`enforce: replace` 把符号形 grep 换成了图谱命中）。工具是能用的，模型没想到用。
2. 三个触发面都有缺口：
   - **描述**（每次请求都在）：`code_find` 的能力段之后紧跟一句 `keep using grep for those`。在"有没有用到 X"这种场景里，这句话把模型推回 grep。
   - **注入**（每轮）：只在 `CODE_QUESTION` 命中时注入；"查代码 / 有没有用到 / 看看这个功能"都不命中 → 绝大多数轮次 0 个 cbm 字样。
   - **钩子**（执行时）：只覆盖"符号形" pattern；字面量 grep 不拦——这是对的，但也没有任何"你本来可以用图"的反馈。
3. 重启后还有一个**文案事故**：hint 的 project 只读会话缓存（`sess.project` / `projectsByCwd`），重启后为空，于是显示 `project=(未索引：先 code_index), 索引新鲜` 和 `第一步：code_index`；而同一时刻钩子里的 `projectFor()` 能解析出 project（本次 `runCbmFlow` 的替换就是证据）。**这是误报，不是真的没索引。**
4. 改进顺序：先改**描述**（零新增注入成本，直接作用于每次工具选择），再加**常驻短段**（常量、缓存友好），再修 **project 与新鲜度的三态模型**（P0-5，最小根治集 C+D+F），最后才扩门闩 / 加长尾工具。
5. **"未索引"和"索引新鲜"是同一类错误的两处症状**：渲染层在替数据层下结论。根治的判据不是多打补丁，而是结构上不可能把 unknown 渲染成断言——删字段（C）+ 三态不变量与测试（D）+ 有范围的事实措辞（F）。A 是过渡，B/E 是可选项。

## 1. 来龙去脉

### 1.1 时间线

| 时间 | 事件 | 结果 |
|---|---|---|
| 21:27 | 用户："查询插件还有没有用到zg的代码" | 模型走 grep/read；0 次 cbm |
| 22:55 | 用户："为什么没走索引" | 归因：字面量存在性清点；`CODE_QUESTION` 不命中 → 0 注入 |
| 23:0x | 用户："规则定义在哪 / 何时注入" | `index.js:1547`、`index.js:2198-2242`；注册在 apply、求值每轮 |
| 23:1x | 用户要求改文案 | `index.js:2233-2235` 新 tail，去掉 grep 句 |
| 23:13 | 用户重启；"根本没法调用到…一点也不好用" | 运行时 hint 显示 `project=(未索引：先 code_index)…第一步：code_index` |
| 23:3x | 方案收敛：拆两轴 + 三态 + 事件时判定 | 最小根治集 C+D+F（P0-5） |

### 1.2 本次实测证据

- **钩子在工作**：对 `runCbmFlow|selfHealIndex` 的 grep 被替换成图谱结果，横幅为"替换自 结构层(图谱)"；对 `projectFromListing` 的 grep 同样被替换。说明 adapter、引擎、project 解析在钩子路径上都是通的。
- **hint 在误报**：同一时刻 hint 却写"未索引"。两条路径的 project 解析不同（见 §3 R4）。
- **封装工具可用**：`code_find("cbmCall")`、`code_find("projectFromListing")` 正常返回 `qualified_name` + 行号。
- **计数**：审计阶段 `code_find` = 2，grep 110+，read 162。

## 2. 触发链现状

模型每次做代码任务，只有三个地方能改变它的工具选择：

```
① 工具描述（静态，随工具清单每次请求发送）
        ↓
② 系统提示注入（每轮装配；cbm 目前是条件式的）
        ↓
③ 执行钩子（模型已经选了 grep/read 之后）
```

| 触发面 | cbm 的实现 | 现状 |
|---|---|---|
| ① 描述 | `ctx.tools.register` 的 `description`（index.js:1927 / 1988 / 1843 / 1799） | 有能力段 + 排除段，缺"何时用"；排除段是祈使句 `keep using grep` |
| ② 注入 | `systemPrompt.context` order 130，条件 `CODE_QUESTION`（index.js:2198-2242） | 只在结构话术命中时注入；重启后 project 误报 |
| ③ 钩子 | `tools/post-execute` replace（index.js:2142-2187），配置 `enforce: replace` | 只覆盖符号形 pattern；能兜底但不能"教" |

## 3. 根因

### R1 描述自伤（最高杠杆）

[index.js:1927](../index.js) 原文：

> Locate a SYMBOL (function / class / method / route) in this workspace by name: returns the qualified name, file, line range and the source itself from the code graph. Use it INSTEAD of grep when the question is "where is X defined / what does X look like". **NOT for string literals, log messages, config values, URLs or regex over text — keep using grep for those.**

问题不在"边界"本身，而在**顺序和语气**：

- 边界写在能力之后，且用祈使句 `keep using grep`——模型读到的最后一条指令是"用 grep"。
- 缺"何时用"的正向场景（"查一下这个功能在哪实现"、"插件里还有没有用到 X"、"改这个函数影响哪些地方"）。
- Anthropic 的工具选择原则：模型只看 `name` / `description` / `inputSchema`；描述要像给新同事讲清楚"什么时候该找你"。

### R2 门闩太窄

`CODE_QUESTION`（index.js:1547）约 24 个分支，全是"谁调用 / 定义在哪 / 影响面 / 重命名 / 架构"这类结构话术。实际用户会说：

- "查代码"、"看看这个功能"、"搜一下"、"有没有用到"、"清理一下"、"重构前评估"、"这个插件怎么实现的"。

这些一个都不命中 → `normalGate=false`；旁路要求 `dirty>=8` → 本次 0 注入。

### R3 注入是条件式，不是常驻

对照 dsh-mneme：它有两条常驻承载位——`systemPrompt.section` order 150（常量总则）+ `systemPrompt.context` order 90（每轮记忆块），还有 `TOOL_GUIDE` 追加到工具描述。cbm 只有一条**条件式** `context`，且文本每轮变化（project / dirty），既不稳定也不常驻。

### R4 project 解析误报（重启后）

- hint 渲染是同步的，只能读 `sess.project || state.projectsByCwd.get(cwd)`（index.js:2212-2213）。
- 重启后两者都是空；但 `projectFor()`（index.js:1265）还有第三条路：`state.projectsListing`（预热清单，`projectFromListing()` 同步解析，index.js:1202-1209）和 `list_projects`。
- 结果：hint 说"未索引 / 第一步 code_index"，钩子却能解析到 project。**文案把用户和模型都带偏了。**
- 同一处还有第二个谎言：`dirty=0` 时 head 写"索引新鲜"（index.js:2230）。`dirty=0` 只证明"本会话没改文件"，而且只覆盖 `write/edit` 的代码文件（index.js:1680-1687）；shell 编辑、别的会话、编辑器、`git pull` 都看不见。`dirty=0` 推不出索引新鲜。
- 两处错误的共同结构：**同步渲染层拿局部缓存替数据层下结论**。所以修复按"轴 + 三态"收敛（P0-5），而不是各打一个补丁。

### R5 首建摩擦

`code_find` 本来会自愈：`runCbmFlow` 在 `notIndexed && autoSelfHeal` 时同步 `selfHealIndex`（index.js:1616-1624），实测小仓 ~2s。但 hint 让模型"先 code_index"（更重、要读报错、要等约 10s）。正确文案应是"直接 code_find，会自动建图"。

### R6 元工具的选择成本

`cbm_*` 走 `mcp__cbm__mcp`，模型必须知道工具名 + 自传 project。这是"能力有了、选择更难"：代理工具是元工具，不教选择。封装动词正是为消掉这个成本而存在（index.js:1921-1924 注释：把路由键从模型手里拿走）。

### R7 没有反馈闭环

- 非符号 grep 不被替换，也没有一行"若在找定义/调用，code_find 更快"的提示。
- telemetry 有 `wrapper-call`、`intercept-replace`，但没有"本会话 grep N 次 / code_find M 次"的对照读数，改进无法验收。

## 4. 其他插件对照

| 插件 | 工具 | 为什么会被用 | 可复用的做法 |
|---|---|---|---|
| dsh-mneme | memory_* | ① 唯一能力，无平替；② 常驻 `memory-guide`（order 150，常量、英文、带 `[dsh-mneme memory]` 前缀）；③ `TOOL_GUIDE` 追加"何时用"；④ 每轮记忆块（order 90） | 常驻常量段 + 描述里的 when-to-use + 英文单正本 |
| dsh-genui | render_ui | 描述里 `USE THIS whenever ...` + 场景枚举 + "do NOT write as markdown"；且是唯一渲染通道 | 祈使句 + 场景枚举 + 明确替代关系 |
| browser | browser_* | 唯一能力（读页面 / 操作标签） | 无平替，不需要抢 |
| dsh-cbm | code_find / code_callers | 与 grep/read **直接竞争**；条件注入；描述含排除祈使句；project 解析脆弱 | 必须靠"描述 + 常驻段 + 钩子"三件套 |

结论：**唯一能力型插件靠能力就够；替代型插件必须主动抢选择。** cbm 属于后者，但目前只有钩子这一件是硬的。

## 5. 原理

### 5.1 模型怎么选工具

- 选择信号只有三处：工具名、描述、参数 schema（Anthropic）。系统提示里的其他文字是"上下文"，不是"工具清单"的一部分，但会影响决策。
- grep/read 在预训练分布内，是默认先验；cbm 是新工具，默认不会被想到。要改默认，必须在**决策点**给信号：每次请求（描述 / 常驻段）、每次执行（钩子）。
- 描述里的"否定句"会被当成指令执行："不要用我，用 grep" → 模型记住了 grep。

### 5.2 MCP 与 schema 经济

- MCP 工具清单随请求发送，每个工具的 JSON schema 都是固定税。十几个引擎工具 ≈ 3200 tokens/请求；代理压成 1 个 ≈ 250 tokens。
- 封装动词再 +413 tokens/请求（`code_find` + `code_callers` 实测 1651 字节）。这笔税只有"被用"才划算。
- 所以：**不能靠加工具解决命中率**，只会加税。

### 5.3 前缀缓存

- 常驻段必须是**常量**：同会话内每轮变化会作废其后的前缀缓存（mneme `guide.js:9-12` 明确写了这条约束）。
- cbm 的 hint 文本含 project / dirty，天然每轮变；它放在 order 130（靠后），代价小，但也因此不适合当"常驻总则"。
- 若要加常驻段：放在变量 hint **之前**（更小的 order），且文本纯常量。

### 5.4 行为改变的三层

1. **能力层**：工具真的能答（cbm 已具备）。
2. **选择层**：描述 / 常驻段让模型在决策点想到（cbm 最弱）。
3. **兜底层**：钩子在模型选错后纠正（cbm 最强，但只覆盖符号形）。

## 6. 改进方案

### P0（止血，改动小）

#### P0-1 重写三个封装工具的 description

目标：把"何时用"放在"边界"之前；边界改成事实陈述，不用祈使句；补用户话术级例子。

建议文案（英文，模型面）：

`code_find`：

> Find a symbol (function / class / method / route) in THIS workspace and return its qualified name, file, exact line range, and source. **Use this whenever the question is about code structure**: where is X defined, what does X look like, which file implements Y, show me the implementation of Z, find the handler for route R. It searches the code graph and reads the top match's source in one call, so prefer it over grep+read for a named symbol. Argument: the symbol name or a short keyword phrase. The graph indexes symbols only — literal strings, log lines and config values are not in it.

`code_callers`：

> Trace who calls a symbol (inbound, default) or what it calls (outbound) from the code graph, hop by hop, with qualified names. **Use this for impact and call-chain questions**: who calls X, what breaks if I change X, trace the call chain of X, find all callers of X. Prefer it over grepping the identifier: grep finds text, this follows CALLS/USAGE edges. Accepts the qualified_name from code_find or a bare symbol name.

`code_index`：

> Index or refresh THIS session workspace into the code graph and return its project name. **You usually do not need to call this first**: code_find / code_callers auto-build the graph on first use in a git workspace (~2s). Call it explicitly after large edits, or when a result says the coordinates may be stale.

注意：最后一句"literal strings ... are not in it"是**能力边界**，不是"去用 grep"；把"该用 grep"留到空结果里说（index.js:1952 已经有这句话），让模型在失败时学到，而不是在选择前被劝退。

#### P0-2 加一条常驻短段（常量）

- 位置：`systemPrompt.section`，order 125（在变量 hint 130 之前；宿主占 110/115/120）。
- 文本常量，同会话不变；开关沿用 `contextHint`。
- 草案（~70 tokens）：

> [dsh-codebase-memory] Code questions: prefer the graph. For a named symbol or an implementation question, call code_find first — one call returns qualified name, file, line range and source, and auto-builds the graph on first use. For callers/callees, impact or call chains, call code_callers. Long-tail graph queries (multi-hop, snippet by qualified_name, freshness, architecture, diff, BM25) go through mcp__cbm__mcp with a cbm_* tool and an explicit project.

- 不要在这段里写"字面量用 grep"（用户明确不要；也让描述承担边界）。

#### P0-3 修 project 解析与文案

最终定稿见 **P0-5**（最小根治集 C+D+F）。这里只留两个可选数据源动作：

- A（过渡）：index.js:2213 增加同步回退 `|| projectFromListing(state.projectsListing, cwd)`。C 落地后 hint 不再显示 project，A 可跳过。
- E（可选）：session-start 时补一发 `refreshProjectsListing`（已有 `agent/session-start` 钩子，index.js:1785）；对 `projectFor()` 冷启动有价值，但不是 hint 正确性的前提。
- 首建文案属于 F：改成"直接 code_find 即可（首次会自动建图，约 2s）；要显式建图/刷新用 code_index。"

#### P0-4 空结果教学

`code_find` 的 empty 文案（index.js:1952）保留"字符串 / 日志 / 配置值本来就该用 grep"——这是**失败时**的教学，比选择前的否定有效。可再加一句"若这是符号，换关键词或直接 code_index"。

#### P0-5 根治：project 与新鲜度拆两轴、三态、事件时判定（C+D+F）

> 这是在 P0-1..4 之上的结构定稿。只做这一节也能关掉本次的两个误报；P0-1/2/4 解决的是"叫不出来"，二者不冲突。

**为什么不是"全都做"**：A–F 六项里，C 删掉 hint 的 project 字段后，A 修的字段没有消费方，B 状态机也失去主要消费者；六处补丁 = 六个可以各自漂移的地方。根治的判据是**结构上不可能把 unknown 渲染成已知**，不是改了几处。

最小根治集：

- **C 删字段**：hint 不再显示 project。封装动词自动填 project，模型不需要知道名字；只有 `cbm_*` 长尾才需要，那时在结果里带。没有字段，就没有字段可以撒谎。
- **D 真实性不变量**：任何 project / 新鲜度断言，只在对应状态为 `ready` / `verified` 时输出；`unknown` 一律沉默或明说未知。加 3 条断言测试（见下）。
- **F 改措辞**：删掉"索引新鲜"，换成有范围的事实；首建文案改成"直接 code_find，会自动建图"。

**两条轴分开，各三态**：

| 轴 | 三态 | 允许的说法 | 数据来源 |
|---|---|---|---|
| project | unknown / ready / not-indexed | ready 才允许把 project 带进长尾提示；unknown 沉默 | sess.project / projectsByCwd / projectsListing / list_projects |
| freshness | verified / possibly-stale / unknown | 见下表 | stamp + dirty + digest |

**freshness 三态**：

| 状态 | 判定条件（事件时计算并缓存） | 允许说的话 |
|---|---|---|
| verified-fresh | `stamp.digest == 当前 digest` 且 `dirty` 为空 | "图建于 HH:MM；最近一次校验时 git 状态与建图时一致" |
| possibly-stale | `dirty > 0`，或 `digest ≠ stamp`，或有 project 但无 stamp | "可能过期：本会话改了 N 个文件 / git 状态已变" |
| unknown | 非 git / 引擎未就绪 / 无 stamp / project 未知 | "新鲜度未知（code_find 会自动建图）" |

**流程图**：

```mermaid
flowchart TD
  subgraph 现状：一个字符串混三条事实
    A1[重启后 sess.project / projectsByCwd 为空] --> A2[hint 渲染 project=（未索引：先 code_index）]
    A3[dirty=0] --> A4[head 写：索引新鲜]
    A2 --> A5[未知被渲染成已知]
    A4 --> A5
  end
  subgraph 方案：事件时判定 + 拆两轴 + 三态
    B1[事件源：session 启动 / write-edit / code_index / selfHeal 成功] --> B2[状态缓存：projectState + freshnessState]
    B2 --> C1{project 轴}
    C1 -->|ready| C2[允许 cbm_* 长尾带 project]
    C1 -->|unknown 或 not-indexed| C3[沉默，或说 code_find 会自动建图]
    B2 --> C4{freshnessOf：stamp / dirty / digest}
    C4 -->|verified| C5[图建于 HH:MM；最近校验 git 状态一致]
    C4 -->|possibly-stale| C6[可能过期：本会话改了 N 个文件]
    C4 -->|unknown| C7[新鲜度未知]
    C2 --> D1[describe 只输出三态话术]
    C3 --> D1
    C5 --> D1
    C6 --> D1
    C7 --> D1
    D1 --> E1[hint 只拼接，不再自己判断]
  end
  A5 -.->|C 删字段 + D 不变量 + F 措辞| E1
  E1 --> F1{3 条验收测试}
  F1 -->|通过| G1[结构上不可能把未知渲染成已知]
```

**实现要点**：

1. 一个纯函数 `freshnessOf({ stamp, dirty, project, digestVerdict }) → 'verified' | 'possibly-stale' | 'unknown'`，判定逻辑只此一处。
2. 判定在**事件时**算一次并缓存：session start（算 digest 比 stamp）、write/edit 后（dirty）、`code_index`/`selfHeal` 成功后（写 stamp → verified）。渲染层只读缓存——这解决的正是"同步渲染 vs 异步事实"的结构矛盾。
3. hint 只做拼接：两条轴各自 describe，禁止在渲染里再拼字符串判断。
4. 措辞按范围说："本会话**未通过 write/edit** 改过代码文件"，不说"没改文件"；"**git 状态**未变"，不说"索引新鲜"。

**为什么现有数据不够**：

- `dirty` 台账只覆盖 `WRITE_TOOLS` + `CODE_FILE` + `file_path`（index.js:1680-1687）；shell 编辑、别的会话、编辑器、`git pull` 都不可见。
- `workspaceDigest` = HEAD + `git status --porcelain` 的长度/哈希（index.js:861-870），只反映**脏路径集合**，不反映内容：已脏文件再改一次内容，porcelain 文本不变、digest 也不变。所以 digest 相等只能说"git 状态集合未变"。
- `check_index_coverage` 在引擎 0.11.0 有已知问题（全量重索引后仍报 `metadata_changed`），只作证据，不作门（README.zh.md:175）。

**3 条验收测试**（可写成断言，锁死不变量）：

1. 空缓存 + 列表有 → 不渲染 project，也不出现"未索引"/"第一步"（C 定稿：字段已删）。
2. 空缓存 + 列表无 → 只说"新鲜度未知（code_find 会自动建图）"，不得出现"第一步 code_index"。
3. 缓存有 + `dirty>0` → 必须说"本会话改了 N 个文件"，不得出现"索引新鲜"。

### P1（行为层，1 周）

#### P1-1 门闩分两档

- 强档（现有 `CODE_QUESTION`）：注入完整 project + 工具动线。
- 弱档（新增 `CODEISH`）：只注入一行"可用 code_find / code_callers 查符号与调用"。
- 弱档草案：`/(代码|源码|函数|方法|类|模块|插件|仓库|实现|定义|调用|引用|依赖|符号|接口|路由)/` 且 `/(查|找|看|搜|哪些|哪里|在哪|谁|怎么|什么|有没有|是否|清理|重构|删|改)/`。
- 风险：误注入；用冷却（同 `staleWarnMinIntervalSec`）+ telemetry 计数控制。

#### P1-2 grep 后置提示（不替换）

- 对非符号形 grep（字面量），若命中数 > N，通过 `additionalContexts` 追加一行："若在找定义 / 调用，code_find 一次给行区间与源码"。
- 通道：宿主 `dsh-repeat-tool-reminder` 已在用 `additionalContexts`（README.zh.md:180 提到）。
- 只加一行，不改变 grep 结果；失败即 fail-open。

#### P1-3 度量

- telemetry 增加会话级计数：`grep-calls`、`code-find-calls`、`replace-hits`、`hint-injected`。
- `code_setup` 报表加一行："本会话 code_find N / grep M / replace K"。
- 没有这个读数，P0/P1 无法验收。

### P2（结构层，1 月）

- **P2-1 长尾封装**：`code_impact`（trace_path both + 受影响文件）、`code_arch`（get_architecture）。每个 +200–300 tokens schema；先用 P1-3 的度量证明长尾真的被用，再决定。
- **P2-2 评测集**：`checks/eval-prompts.md`，20 条真实问法（结构 / 字面量 / 混合），人工跑两版描述，统计首次工具选择。Anthropic 的做法就是"评测驱动描述迭代"。
- **P2-3 skill / AGENTS.md**：README 第 4 节已有模板；skill 是补充，不是触发器。

### 不建议做

- 把所有 grep 都替换成图谱：字面量搜索本来就是 grep 的甜区，替换会答错。
- 为了命中率再加动词：每加一个 +schema 税，且不解决"想到"的问题。
- 把 hint 写长：每轮都付 token，且变量文本破坏缓存。

## 7. 验收指标

| 指标 | 现状 | 目标 |
|---|---|---|
| 结构类问题首轮 code_find 命中 | 低（本次 0） | ≥70% |
| 代码类问题 hint 注入率 | 仅结构话术 | ≥90%（弱档） |
| 重启后首次 code_find 成功率 | 未测（应自愈） | 100%（git 仓） |
| 每 100 次代码提问 code_find 次数 | ~2 | ≥30 |
| 常驻成本 | 413 tokens（封装工具） | +~70 tokens（常驻段），可接受 |
| 重启后 hint 误报数 | 2（"未索引" + "索引新鲜"） | 0（3 条测试锁死） |
| 新鲜度断言的证据 | 无（dirty=0 当 fresh） | 仅 verified-fresh 才允许断言 |

## 8. 本次改动与待办

- **已发布 v0.20.1**（bump 并入 fix 提交，沿用本仓「版本进 commit 标题」惯例；未 push、未 tag）：
  - 本提交 `fix(v0.20.1): hint can no longer render unknown as known (P0-5 C+D+F)`：`index.js` hint 删 project 字段、`freshnessOf` 三态纯函数 + `digestVerdict` 事件缓存（session start / code_index / selfHeal 落账，code_index 首次补写 stamp）、hint 只拼接三态话术；`checks/check-plugin.mjs` 加 3 条断言（C 不渲染 project、D 三态、F dirty 措辞）并新增 `self-heal-skip` 遥测；README.zh.md 同步；本档入仓。全量 174/174 绿（run2，N4 瞬态红定性为引擎争用）。
  - v0.20.1 仅版本号 + 本文档状态 + .gitignore（`.workbuddy-ai/`），无行为改动。
- 生效方式：`node scripts/sync.mjs` 同步进 profile → 重启宿主（index.js 在 apply 时加载一次）。
- 待实施：P0-1/2/4（描述、常驻段、空结果教学）；P0-3 的 A/E 降为可选。
- 已知风险：常驻段 +70 tokens/请求；门闩扩面可能误注入；描述改动需回归 `checks/check-plugin.mjs` 的 schema 预算（2200 字节）。

## 9. 参考

- Anthropic, *Writing effective tools for agents*: https://www.anthropic.com/engineering/writing-tools-for-agents
- MCP Tools spec: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- 本仓 `README.zh.md` 第 3 节（触发层）
- dsh-mneme `src/guide.js`、`src/inject.js`、`src/tools.js`
- dsh-genui `src/plugin/tool.ts`