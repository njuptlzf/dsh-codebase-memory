# dsh-codebase-memory 主动触发改造方案

> 目标：让模型在"查代码"时优先走 codebase-memory-mcp（cbm）的代码图索引，而不是默认 Grep。
> 依据：DSH 的插件与工具执行机制，以及 dsh-mneme 的多层触发做法。
> 状态：已落地为 v0.3.0（杠杆 ①③⑤；② 的 deny-once/deny 已实现但默认不启用）。**2026-10-08 验收：`advise` 事件注入（② 的 advise 分支，即 ④ 软提示）整体撤回**——`tools/post-execute` 不再向会话追加任何上下文，`enforce` 的合法值与默认都去掉了 `advise`（配置里写了会回落 `off` 并提示）。下文凡描述 advise/软提示的段落均为历史设计记录，不代表当前行为。标注「待核实」的接口全部按本机安装宿主 0.1.5-rc.2 复核过，**与原方案的差异见 6.1**——落地以 6.1 为准。
> 资料范围：dsh-codebase-memory 与 dsh-mneme 的 README、PR / Issue 讨论，公开的 DSH 介绍文章，以及本机 `profiles/node_modules/@deepseek-ai` 的实装（含 `dsh-tool-cordis` 的事件/服务目录与 `dsh-hooks-claude-code` 这个官方参考实现）。

---

## 1. 背景与问题

当前 [dsh-codebase-memory](https://github.com/njuptlzf/dsh-codebase-memory) 的"让模型用 cbm"主要靠两条软约束：

1. `ctx.systemPrompt.section({ name: 'codebase-memory', order: 850, text })`，静态的四步流程说明；
2. 仓库自带的 `AGENTS.md` 模板（README 第 4 节）。

README 自己把"采用率（adoption）"定性为一个"separate, weaker problem"，并把唯一能干预而非劝说的手段——`PreToolUse` 钩子——列为"需要额外装包、只有模型一直无视索引时才值得做"。同时 README 的 prompting recipes 里，触发率最高的是用户明确说"don't grep"，说明当前效果依赖用户措辞。

我们认为这种方式效率低、不稳定，原因有四：

| # | 问题 | 说明 |
|---|---|---|
| 1 | 载体太弱 | 提示放在 section 末位（order 850）、静态文本，且模型眼里的 cbm 只是一个名为 `mcp` 的通用代理工具，描述里看不出"查符号 / 找调用者"这类具体能力 |
| 2 | 首次调用有摩擦 | 要先拿到 `project` 名（通常要先 `code_index`），`args` 要传对象，失败一次后模型容易退回 Grep；Grep 一次调用就有结果 |
| 3 | 无干预能力 | 提示只能"劝"，模型调了 Grep 之后插件完全无感知 |
| 4 | 无度量 | 不知道改了提示后采用率有没有变化 |

---

## 2. DSH 机制原理

> DSH（DeepSeek Harness）是 DeepSeek 开源的 agent harness，仓库：<https://github.com/deepseek-ai/deepseek-harness>。
> 注意：它目前是 Developer Preview，文章明确提示会有破坏兼容性的变更（见 [权限与沙箱解析](https://dev.to/ahab_indieseek/deepseek-harness-permissions-and-sandbox-trace-every-tool-call-before-granting-access-4451)）。所有依赖下列接口的改造都应放在独立开关之后。

### 2.1 一切皆插件：`ctx` 是唯一入口

DSH 里工具、命令、MCP 连接、钩子都是"调用 `ctx` 的代码"。介绍文章给出的对应关系：

| 想做的事 | 对应机制 |
|---|---|
| 给模型一个可调用的工具 | `ctx.tools.register()` |
| 接入 MCP server 的工具 | 每个 MCP server 一个插件，经 `ctx.tools.register()` 注册其工具 |
| 钩住 agent / 工具生命周期 | 监听扩展点，如 `agent/pre-step`、`tools/pre-execute` |

来源：[What is DeepSeek-Harness: a complete introduction](https://dev.to/justin3go/what-is-deepseek-harness-a-complete-introduction-4e5f)。

此外 `dsh-mcp-client` 只桥接 MCP 的 Tools，Resources 和 Prompts 尚无 harness 侧消费者（见 [DSH vs Claude Code 对比](https://dev.to/justin3go/deepseek-harness-vs-claude-code-architecture-plugins-mcp-2nj7)）。这对 dsh-cbm 意味着：cbm 的能力对模型只以"工具"形态出现，没有其他暴露面可用。

### 2.2 插件如何被加载：bundle + profile

- 插件在 `package.json` 里声明 `dsh.bundle`（含 patch 文件），profile 的 `dsh.profile.bundles[]` 里有这个名字才算启用；`dsh plugin --profile <p> add <spec>` 会同时写这两处。
- 这是 dsh-cbm 现有的做法，详见其 [README 的 "How DSH finds it"](https://github.com/njuptlzf/dsh-codebase-memory#how-dsh-finds-it-and-how-the-model-starts-using-it)。

### 2.3 向模型注入内容的两个面：`systemPrompt.section` 与 `systemPrompt.context`

| 面 | 用途 | 特点 |
|---|---|---|
| `systemPrompt.section({name, order, text})` | 一次性、稳定的规则 / 说明 | 常驻，按 order 排序 |
| `systemPrompt.context({name, order, text})` | 每轮渲染的内容块 | 可随 query 变化 |

dsh-mneme 的设计提案对这两个面和约束有清晰总结：能挂 hook 的内容不进常驻段（常驻系统提示会影响前缀缓存）；常驻段里的内容在同一会话内必须稳定。见 [Issue #249 注入形态设计提案](https://github.com/slow-stack/dsh-mneme/issues/249) 的"挂载点"与"硬约束"两节。

**一个已知的覆盖盲区：** dsh-mneme 的 README 指出，极简模式（minimal agent preset）会把整条系统提示词钉死、压制全部 runtime context，因此记忆注入在该模式下完全不送达模型，过渡方案是把内容写进 `AGENTS.md`（走 agent-instructions 的 section 路径）。来源：[dsh-mneme README，"已知边界"一节](https://github.com/slow-stack/mneme/blob/main/dsh-mneme/README.md)。dsh-cbm 目前同样依赖 `systemPrompt.section`，在极简模式下会同样失效，这也是只靠提示词的又一个理由不可靠。

### 2.4 事件扩展点

综合 mneme 提案、dsh-cbm README 与 DSH 介绍文章，已知的扩展点有（能力边界经 hookkit README 原文与官方文档核实）：

| 事件 | 时机 | 已知用法 | 能力（已核实） |
|---|---|---|---|
| `agent/created`（会话开始；官方事件面无 `agent/session-start` 这个名字） | 会话开始 | dsh-cbm 用它做 `sessionRefresh`（detached，不阻塞） | 已核实：serial，source 区分 startup/resume/clear/compact，监听器返回值类型为 `undefined`——返回值不被宿主消费、不可注入 |
| `agent/pre-step` | 每步之前 | dsh-mneme 的 `continuity.js` 用它向当前轮追加插件消息 | 可注入；每步一次，可限定每回合首步（firstStep）/ 每会话首回合（firstTurn） |
| `agent/turn-stopping` | 回合结束前 | loop 在回合结束时 serial 调用 | 已核实：监听器签名 `Promise<void> | void`，无决策——不可注入 / 不可 deny |
| `system-prompt/assemble` | 系统提示装配期 | 提案中的候选挂载点 | 提案列出的空闲 seam，暂无能力实证 |
| `turn/end` | 回合结束 | dsh-mneme 用它做会话蒸馏 | 仅观察（observe-only，不被 agent 循环 await） |
| `tools/pre-execute` | 工具执行前 | 权限 / 拦截；下一节展开 | 只能 deny，不能注入；deny 时 handler 的 stdout 成为模型看到的 reason |
| `tools/post-execute` | 工具执行后 | 追加上下文 / 替换结果 | 可注入（attach 到下一个请求）；官方文档还允许 accept / block / replace |

hookkit README 还列出以下**仅观察事件**（不可注入、不可 deny、不被 agent 循环 await，但 handler 仍可经 `do.tool` 触发工具）：`turn/start`、`step/start`、`step/end`、`tool/call`、`tool/result`、`compaction/start`、`compaction/summary`、`compaction/end`、`user/message`、`approval/asked`。

hookkit README 同时确认：**DSH 自身没有声明式 hook 层**——"dsh has no declarative hook layer of its own. The seams exist (...) but reaching them means shipping a plugin"，即接缝只能经插件监听（见 2.6）。

来源：[Issue #249](https://github.com/slow-stack/dsh-mneme/issues/249)（§7 挂载点表与两条硬约束，原文已读）、[dsh-mneme README](https://github.com/slow-stack/mneme/blob/main/dsh-mneme/README.md)、[DSH 介绍](https://dev.to/justin3go/what-is-deepseek-harness-a-complete-introduction-4e5f)、[hookkit README](https://awesome-dsh-plugin.com/p/CREAIT-nl/dsh-plugins--hookkit/)（事件能力表，原文已读）。

补充：官方桥接包把 Claude Code 风格的 hook 事件映射到上面的扩展点。外部草案给出的映射为 `SessionStart → agent/session-start`、`UserPromptSubmit → agent/pre-step`、`PreToolUse → tools/pre-execute`、`PostToolUse → tools/post-execute`、`Stop → agent/turn-stopping`。**已部分核实**：官方 discussion [#1595](https://github.com/deepseek-ai/deepseek-harness/discussions/1595) 确认 `dsh-hooks-claude-code` 支持 Claude Code 30 个事件中的 7 个——`SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop、SubagentStart、SubagentStop`（草案未列后两个）；且 **Stop 每回合触发**（"Stop fires every turn, not just once at session end"），与映射到 `agent/turn-stopping` 的每回合语义吻合。但每个事件到内部扩展点的逐一对应关系仍无源码级证据，该项保留「未核实」。`agent/pre-step` 的触发粒度见 2.5 的 hookkit 说明（每步一次，可限定每回合 / 每会话首次）。

### 2.5 工具执行管线（本方案的核心依据）

官方文档 [tool-execution-pipeline.md](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/docs/tool-execution-pipeline.md)（原文已读）给出的完整流程：

```
tools/pre-execute waterfall（hooks + 权限 + 沙箱）: allow | deny | ask
  -> monotonic guards : deny 或 abstain（只能收紧，identity 受保护；与 hook 是两层机制）
  -> ask 走 ctx.approval 一次性询问（无应答 / 拒绝即 deny）
  -> tools/execute    : timeout / retry / metrics 包装
  -> 工具体 -> fs/write-intent、fs/edit-intent 文件门
  -> tools/post-execute : accept / block / replace / add context
  -> finalizeContent -> tools/result（同步通知，冻结最终结果）
```

（[DSH 权限与沙箱解析](https://dev.to/ahab_indieseek/deepseek-harness-permissions-and-sandbox-trace-every-tool-call-before-granting-access-4451)一文的说法与官方文档一致。）

对 dsh-cbm 的含义：

- **`tools/pre-execute` 是唯一能"在 Grep 执行之前"介入的位置**，决策可以是 deny。官方文档虽允许 post-execute `block`，但那时工具体已经执行完，故"把授权放在 `tools/post-execute`"仍是反模式，阻断逻辑不要放在 post 阶段。
- **`tools/post-execute` 可以"追加上下文"**，适合做不阻断的软提示（advise 模式）。
- **三个扩展点的能力边界**（来自社区插件 [hookkit 的 README](https://awesome-dsh-plugin.com/p/CREAIT-nl/dsh-plugins--hookkit/)，原文已读；具体 API 签名仍需在目标 DSH 版本实测）：
  - `tools/pre-execute`：**能 deny，不能注入上下文**（官方契约 `PreToolDecision` 四个变体均无上下文字段，源码级确认）；deny 时 handler 的 stdout 成为模型看到的 reason（原文："the handler's stdout becomes the reason the model sees"）；
  - `agent/pre-step`：能注入，每步触发一次，可限定每回合首步（firstStep）或每会话首回合（firstTurn）；
  - `tools/post-execute`：能注入（原文："context attaches to the next request"）。
  - 该 README 还说明 DSH 自身没有声明式 hook 层，接缝存在但要通过插件使用，并提供 `failOpen`（handler 出错不影响回合，默认开启）；handler 三种：in-process 工具（含 MCP，仍走正常工具管线）、shell 命令（stdin 收 JSON，exit 0 = allow）、HTTP 端点（2xx = allow）。
  - 对本方案的含义：放行时不能在 pre-execute 里附带提示；软提示只能走 post-execute 或 pre-step；拦截的 `reason` 对模型可见这一点已由 hookkit 原文与官方源码双重确认（deny 契约见 4.3）。
- 官方设计文档（固定到某个提交）：[tool-execution-pipeline.md](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/docs/tool-execution-pipeline.md)、[permission-presets.md](https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/docs/subsystems/permission-presets.md)。

### 2.6 钩子的两种接入方式：桥接包与原生订阅

- **桥接包**：DSH 官方提供 `dsh-hooks-claude-code`、`dsh-hooks-codex`，把现成的 Claude Code / Codex `hooks.json` 翻译成 DSH 的扩展点监听（见 [DSH vs Claude Code 对比](https://dev.to/justin3go/deepseek-harness-vs-claude-code-architecture-plugins-mcp-2nj7)）。这也是 dsh-cbm README 里"需要额外装包"的那条路。**已核实**：官方 discussion [#1595](https://github.com/deepseek-ai/deepseek-harness/discussions/1595) 确认 `dsh-hooks-claude-code` 支持 7 个事件（`SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop、SubagentStart、SubagentStop`，另 23 个不支持），事件列表定义于 `packages/hooks/hooks-claude-code/src/config.ts` 的 `CLAUDE_EVENTS` 数组（出处见该 discussion）。
- **原生订阅**：社区插件 [dsh-plugin-hooks](https://dsh-plugin.org/plugins/truelove-dreamer/dsh-plugin-hooks)（另见 [插件目录页](https://dshpluginhub.ai/en/plugins/dsh-plugin-hooks)）说明了更直接的做法：通过 `ctx.on("tools/pre-execute" | "tools/post-execute")` 接入，pre 阶段需要阻断时返回 `{ kind: "deny", reason }`，与 dsh-tools 的 deny 决策契约一致；hook 命令经 shell 服务执行（不递归触发工具事件）。**已核实**其机制（目录页原文）：JSON 配置（默认 `$DSH_HOME/hooks.json`），pre-tool 非零退出 = 阻断（deny），post-tool 只记日志不影响结果，支持热重载（`/hooks-reload`）；其 FAQ 自述 v1 只覆盖工具生命周期事件，会话级事件"官方 API 尚未暴露"。
- **名称易混淆的几个包**：官方 `@deepseek-ai/dsh-hooks-claude-code` / `dsh-hooks-codex`（桥接）；社区 `dsh-plugin-hooks`（truelove-dreamer，shell 命令钩子）；社区 hookkit（CREAIT-nl/dsh-plugins，声明式 YAML，带 `failOpen` 与 `when` 匹配，handler 支持 in-process 工具 / shell / HTTP）。三者的定位区别（hookkit 原文的对照表）：shell 钩子进程外执行，"can observe and veto but cannot hand text back to the model"——只有 hookkit 能贡献模型可见上下文（contribute model-visible context）。另有资料提到的 npm 包名 `dsh-hooks-plugin`（已核实：KYinCode/dsh-hooks-plugin，产品名 dsh-hooks，Claude Code 风格 shell 钩子，配置 `.dsh/hooks.json`）是第四个社区包，与上述三者均不同。选型前先确认。
- 结论：dsh-cbm 完全可以在自己的插件里直接 `ctx.on("tools/pre-execute", ...)`，不必依赖桥接包；而且在插件内部能直接读到 project、索引新鲜度等状态，比外部 shell 钩子更合适（shell 钩子无法把文本交回模型，这正是 hookkit 对比表 "contribute model-visible context" 一行的含义）。签名已核实（见 4.3）。

### 2.7 宿主对插件写入消息的准入（V4）

DSH 0.1.7-alpha.1 起，V4 写入准入会拒绝 `source.kind` 缺失、空串或恰好等于 `"plugin"` 的消息，要求使用生产者自有的 kind（如 `plugin:dsh-mneme`）。dsh-mneme 因此改了 16 处写入点，并在读侧用白名单（只认 kind 缺省或 `"user"`）避免把插件自己的消息当成用户输入。见 [PR #327](https://github.com/slow-stack/mneme/pull/327)。

对 dsh-cbm 的含义：若以后通过 `agent/pre-step` 追加提醒消息，必须使用 `plugin:dsh-codebase-memory` 作为 kind。

---

## 3. dsh-mneme 做法原理

> 项目：<https://github.com/slow-stack/mneme>；插件包文档：[dsh-mneme/README.md](https://github.com/slow-stack/mneme/blob/main/dsh-mneme/README.md)。

dsh-mneme 要解决的是同一类问题的另一个面：怎么让模型"自然而然地用上"外部能力。它的做法不是押注单一提示，而是多层叠加。

### 3.1 内容侧：每轮渲染，按 query 注入

- 注入器挂在 `systemPrompt` 的渲染回调上，每轮发生。[PR #276](https://github.com/slow-stack/dsh-mneme/pull/276) 的说明明确写到"跨会话记忆已由 inject 每轮自动注入系统提示词"。
- 注入是 query 感知的：有 query 时先走语义召回再重排；`injectUncertaintyAdaptive` 等选项只看查询本身来决定注入多少（见 [README 配置表](https://github.com/slow-stack/mneme/blob/main/dsh-mneme/README.md)）。
- 注入器会旁路缓存最近一帧组装结果（条目、字符数、生效参数），供面板"注入预览"读取，做到可观测。见 [PR #265](https://github.com/slow-stack/dsh-mneme/pull/265)。

### 3.2 载体侧：能力说明放在工具描述里，常驻段保持稳定

- 能力说明的第一承载位是工具描述，提案调研里写明两个生产实现都这样做；常驻 section 只放稳定说明（order 150）。见 [Issue #249](https://github.com/slow-stack/dsh-mneme/issues/249)。
- 注入开关收成两级：`autoInject` 是父开关，能力说明归入基础档并默认开。见 [PR #297](https://github.com/slow-stack/dsh-mneme/pull/297)、[PR #266](https://github.com/slow-stack/dsh-mneme/pull/266)。

### 3.3 工具侧：用"曝光"和"描述纪律"管理调用行为

- 弱 / 慢模型会顺手乱调工具，每次调用都是一次串行往返。dsh-mneme 为此加了 `disableMemorySearch` / `disableMemoryArchive`：在工具注册循环里按配置隐藏对应工具，"模型看不到就不会调，比在描述里劝它少调用更可靠"。同时在描述里补充使用纪律。见 [PR #276](https://github.com/slow-stack/dsh-mneme/pull/276)。
- 一个实现细节：live patch reload 时，已注册的工具不会被宿主反注册，隐藏只对新会话生效。同一个 PR 里有说明。

### 3.4 时机侧：`agent/pre-step` 上的续接干预

dsh-mneme 的 `continuity.js` 在压缩边缘触发时，把一条插件消息塞进 `agent/pre-step` 的 decision；先落库提案、再注入、边缘消费即删。这说明 `agent/pre-step` 是可写入消息的有效干预点，也说明这条链路对宿主的消息准入非常敏感（见 [PR #327](https://github.com/slow-stack/mneme/pull/327)）。

### 3.5 健壮性与可观测性

- **特性开关 + 面板回滚**：几乎所有增强默认关，且走 feature flag，面板可启停，等于线上回滚开关（README 配置表）。
- **fail-safe**：LLM 输出非法时跳过该条并应用合法子集；每个阶段独立 try/catch。
- **审计**：每次后台 LLM 调用写 `llm_audit_logs`，召回写 `recall_runs`，整理写 `dream_runs`。
- **教训**：注入链路按 UTF-16 长度截断时切到 emoji 代理对中间，会产生非法 UTF-8，导致 API 对每个请求返回 400，且畸形文本被持久化进会话历史。见 [Issue #334](https://github.com/slow-stack/mneme/issues/334)。任何对注入文本的截断都要按码点而不是 UTF-16 单元。

### 3.6 dsh 事件 → dsh-mneme 做法 → dsh-cbm 可借鉴点

| dsh 事件（挂载点） | dsh-mneme 做法 | dsh-cbm 对应改造 |
|---|---|---|
| `ctx.tools.register`（工具描述，非事件） | 能力说明放在工具描述 | 给 cbm 增加原生封装工具，描述里写明"代替 grep 查符号 / 调用者" |
| `systemPrompt.context`（每轮装配；关联 `system-prompt/assemble`） | 每轮、按 query 注入 | 只在问题像"谁调用 / 定义在哪 / 影响范围"时注入一两行状态 |
| `systemPrompt.section` / `systemPrompt.context`（装配面） | 常驻段稳定，易变内容进 context | 保留现有 section 不变，把新鲜度等易变状态放 context 块 |
| `agent/pre-step` | `agent/pre-step` 干预 | 低优先级备选：连续 grep 时追加提醒消息 |
| `ctx.tools.register`（注册循环，非事件） | 工具曝光开关 | 封装工具与拦截都做成独立开关，默认可关 |
| 全部 hook 事件（`failOpen` 设计） | 特性开关 + fail-safe | 所有 hook try/catch 并 fail-open |
| `tools/pre-execute` / `tools/post-execute`（拦截与放行记账） | 审计与预览 | 记录拦截 / 放行 / 采用，供度量 |
| `systemPrompt.context`（注入路径） | 截断教训 | 拦截提示里嵌入的命中摘要按码点截断 |

---

## 4. 改造方案

### 4.1 总体分层

| 杠杆 | 机制 | 强度 | 风险 |
|---|---|---|---|
| ① 原生封装工具 | `ctx.tools.register` | 中高，消除摩擦 | 增加工具 schema，稀释"约 4x 省 token"的收益 |
| ② 拦截 Grep / Glob | `tools/pre-execute` | 最强，唯一能干预 | 误拦；需放行逻辑与遥测 |
| ③ 条件注入提示（含可选精简架构摘要） | `systemPrompt.context` | 中，补充用 | 受极简模式限制；摘要有 token 成本 |
| ④ 软提示 | `tools/post-execute` 追加上下文 | 弱到中，不阻断 | 模型已拿到 grep 结果 |
| ⑤ 写后失效标记 | `tools/post-execute` 记脏路径 + 查询前新鲜度检查 | 中，保证 ①② 的结果可信 | 写入工具已核实（write/edit，路径字段 `file_path`，4.6）；检查有额外开销 |

各事件上的 dsh-cbm 行为汇总如下（与上表的杠杆视角互补；能力边界见 2.4 / 2.5，未列事件一律不挂监听）：

| dsh 事件（挂载点） | dsh-cbm 行为 | 落点 / 要点 |
|---|---|---|
| `agent/created`（会话开始；dsh-cbm 现状称 session-start） | 沿用现有 `sessionRefresh`（detached，不阻塞） | 现状保持；封装工具内部等待其完成（带超时，4.2） |
| `ctx.tools.register` | 注册封装工具 `code_find` / `code_callers`，project 由插件自填 | 杠杆 ①（4.2） |
| `systemPrompt.section` | 保留 order 850 稳定文本不变 | 现状保持（2.3） |
| `systemPrompt.context` | 问题形似“谁调用 / 定义在哪 / 影响范围”时注入 1–2 行状态；可选精简架构摘要（默认关） | 杠杆 ③（4.4） |
| `tools/pre-execute` | 拦截符号类 Grep / Glob（仅 `enforce=deny-once/deny`）：分类 + 前提检查 + 时间预算；deny 的 reason 内嵌 search_graph top 命中；同符号只拦一次 | 杠杆 ②（4.3） |
| `tools/post-execute` | ① `advise` 模式软提示（`enforce=advise` 时对符号类 Grep 追加上下文，不阻断）；② 记写入类工具的路径进会话脏集合（不触发 refresh） | 杠杆 ② advise 分支（4.3）+ 杠杆 ⑤（4.6） |
| `agent/pre-step` | 备选：检测到上一步是标识符 grep，追加一次性提醒（`plugin:dsh-codebase-memory` kind，去重） | 杠杆 ④（4.5），仅 ②③ 效果不足时启用 |
| `agent/turn-stopping` | 不使用 | 已核实：serial、无决策（2.4） |
| `system-prompt/assemble` | 不使用 | 同上 |
| `turn/end` 及其余观察类事件 | 不使用；遥测在 pre/post-execute 内联记录，无需挂在观察事件上 | 观察类事件清单见 2.4 |

### 4.2 杠杆 ①：原生封装工具，把“路由键”从模型手里拿走

- 注册 1–2 个高频动词，代理工具 `mcp__cbm__mcp` 保留给长尾能力：
  - `code_find(query, kind?, file_pattern?)`：内部 `search_graph` → `get_code_snippet(format:"json")`，返回 `qualified_name`、文件、行范围、源码片段；
  - `code_callers(name, direction)`：包装 `trace_path`。
- 描述首句直接写用途边界，例如："定位函数 / 类 / 路由的定义与调用关系时用它代替 grep；字符串字面量、日志、配置值不适用。"
- `project` 由插件从 session cwd 与 `code_index` 的返回值缓存后自动填入，模型无需传。这与现有"模型不能传 `repo_path`"的安全约束一致，project 依然由插件决定。
- 工具内部保证索引可用：未建索引则先建（返回明确状态）；等待会话开始事件（官方名 `agent/created`，dsh-cbm 现状称 session-start）里 detached 的 refresh 完成（带超时），缓解 README 已承认的"首个查询与 refresh 竞争"。
- 返回前做便宜的一致性校验：片段是否包含该符号名；`check_index_coverage` 给出 `freshness=metadata_changed` 时自动重建或明确提示。这针对的是 README 中记录的"索引坐标过期时返回邻居代码却不报错"问题（上游 [issue #1750](https://github.com/DeusData/codebase-memory-mcp/issues/1750)）。
- token 代价需要实测：现有 `check-tokens.mjs` 的 ablation 臂可直接扩展出"代理 + 封装工具"一档。

### 4.3 杠杆 ②：在 `tools/pre-execute` 拦截 Grep（一次性软拦截）

依据见 2.5 与 2.6。

**拦截对象（官方 [tool-fs-search README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/tool-fs-search/README.md)）：** 内置搜索工具裸名小写 `grep` / `glob`（无前缀，MCP 工具才带 `mcp__`）；`grep` 参数 `pattern`（必需，ripgrep 正则）、`path?`、`include?`（单个正向 glob，逗号列表与取反直接拒绝）；`glob` 参数 `pattern`（必需）、`path?`。`isGrepLike(name)` 与 `classify(args.pattern)` 据此写死；两者自带输出上限（`grepMaxMatches` 250、`globMaxResults` 100），超限走 spill 不报错。

**分类规则（纯函数，可单测）：**

- 视为符号查询：pattern 为纯标识符（形如 `^[A-Za-z_$][\w$.:]*$`），或 `class X` / `def X` / `func X` / `function X` 这类定义形态。
- 一律放行：含空格、引号、URL、重度正则元字符、看起来像报错文本或配置键的 pattern；已明确限定到非代码路径的搜索。

**前提条件（全部满足才拦，否则放行）：**

1. 工作区是 git 仓库；
2. 当前 project 已索引；
3. 索引不过期（`check_index_coverage` 结果带短缓存）；
4. 引擎与代理链路健康；
5. 本会话没有未同步的脏路径（见 4.6）。

任何一项不满足或 hook 内出错，都放行（fail-open）。

**延迟预算：** `tools/pre-execute` 在工具调用的关键路径上同步执行，所以拦截逻辑必须轻量：

- 先做纯本地判断（分类、会话状态、缓存的索引状态），确认有必要才去查 cbm；
- 查 cbm 走已有的长连接（dsh-cbm 已设为 `keep-alive`，避免冷启动），整个查询套一个时间预算，**超时即放行**；
- 预算数值需实测（README 实测单次查询小于 100 ms，但冷路径会更高），配置项见 4.8。

**注意：** `pre-execute` 只能 allow / deny / ask，放行时不能附带提示（见 2.5）。需要软提示时走 post-execute（advise 模式）。

**deny 契约（已核实，官方源码 `packages/core/tools/src/index.ts`）：** 决策类型 `PreToolDecision = allow | deny | cancel | ask`，`deny` 为 `{ kind:'deny'; reason: string; info?: ToolErrorInfo }`，官方 JSDoc 明确 `deny` “materializes its **model-facing** reason”。调度器把拒绝直接物化为失败工具结果 `content: [{type:'text', text:'Error: ' + reason}]`（isError）——**reason 原样（仅加 `Error: ` 前缀）成为模型唯一看到的输出**；denied 调用跳过工具体，但仍走 post-execute（post-result）再物化。`cancel` 物化为 `Error: tool call aborted`（不呈现策略拒绝）；`ask` 无审批服务时降级为 deny（reason 为 `ask.reason` 或 “requires approval”）。`info`（name / code / reason?）是结构化错误元数据，其中 `info.reason` 不进模型内容——拦截时遥测码放 `info.code`，模型可见文案放 `reason`。

**post-execute 契约（已核实，官方源码同文件）：** `PostToolDecision = accept（可选 `content` 替换投影 / `value` 替换值，均可带 `additionalContexts`）| block（`feedback` 转 error 结果，可带 `additionalContexts`）`；官方 JSDoc：“accept, replace one projection, **attach context for the next request**, or block”。**追加上下文的官方形态是 `additionalContexts?: UserMessage[]`**——advise 模式返回 `{ kind:'accept', additionalContexts:[msg] }` 即可不阻断地给下一个请求附上下文（管线文档：“Active-batch additionalContexts FIFO，injected user/message after recorded tool results”）；消息必须带 `source.kind`（见 2.7）。另有一条工具体内部路径 `exec.deferContext()`（仅工具体运行时可用，hook listener 不能调）。`block` 的 feedback 文本成为 error 结果（兜底文案 “tool result blocked by post-execute policy”）——post 可 block，但工具体已执行完（见 2.5 反模式）。

**监听签名与 guard 合并（已核实，官方源码 `packages/core/agent/src/runtime-types.ts` 与 `packages/core/tools/src/index.ts`）：** `tools/pre-execute` 为 waterfall：`ctx.on('tools/pre-execute', (exec, next) => Promise<PreToolDecision>)`，`next()` 委托给默认 `{ kind:'allow' }`；`exec` 含 name / 已解析冻结的 arguments / callId / agent / signal。调度器合并顺序：`denialReason = decision.kind === 'allow' ? guardReason(exec) : decision.reason`——**pre-execute 的 deny 短路所有 guard，仅在放行时才求值 guard**。guard 经 `tools.guard((exec) => string | undefined)` 注册（同步、identity 受保护、只能 deny 或 abstain、无 allow），按 global → scope 链取第一个非空 reason。scope 过滤：agent-scoped listener 只收到该 agent 的调用。

**拦截行为：**

1. 拦截时在 hook 里直接跑一次 `search_graph`，把 top 命中写进 `reason`，让模型这一轮就拿到可用结果，而不是只被教育一句；
2. 同一会话内对同一符号只拦一次，第二次放行，误拦的代价最多多一个往返，也避免模型反复重试同一调用；
3. 提示中嵌入的文本按码点截断（见 3.5 的教训）。

**配置：** `enforce: off | advise | deny-once | deny`，默认 `advise`，数据证明误拦率可接受后再升到 `deny-once`。`advise` 模式走 `tools/post-execute` 追加上下文，不阻断。

**示意（伪代码，契约签名已核实见上文）：**

```js
ctx.on('tools/pre-execute', async (exec) => {
  try {
    if (cfg.enforce === 'off') return;
    if (!isGrepLike(exec.name)) return;               // 内置工具名：grep / glob（官方 README 已核实）
    const q = classify(exec.args);                    // {kind:'symbol'|'literal', symbol}
    if (q.kind !== 'symbol') return;
    if (!(await state.indexReady(session))) return;   // fail-open
    if (state.hasDirty(session)) return;              // 有未同步的写入时放行（见 4.6）
    if (state.alreadyBlocked(session, q.symbol)) return;
    const hits = await withBudget(cfg.interceptBudgetMs, () =>
      cbm.searchGraph(state.project(session), q.symbol, { limit: 5 }));  // 超时返回 null
    if (!hits) return;                                // 超时 / 失败：放行
    state.markBlocked(session, q.symbol);
    telemetry.record('intercept', { symbol: q.symbol, hits: hits.length });
    return { kind: 'deny', reason: renderHint(q.symbol, hits) };  // 按码点截断
  } catch (e) {
    telemetry.record('intercept-error', { message: String(e) });
    return; // fail-open
  }
});
```

### 4.4 杠杆 ③：按 query 条件注入，易变状态进 context

- 保留现有 `systemPrompt.section`（order 850）的稳定文本；
- 新增 `systemPrompt.context` 块，仅当最近一条用户消息像"谁调用 / 定义在哪 / 影响范围 / 重命名 / 调用链"时，注入 1–2 行状态（如 `project=…，索引新鲜，优先用 code_find`）；其余轮次不注入；
- 约束同 2.3：不把易变内容放进常驻段，避免影响前缀缓存；
- 注意极简模式下该注入不会送达（见 2.3），拦截和封装工具不受该限制，这也是它们优先级更高的原因。

**可选子项：精简架构摘要**（受外部草案的"会话开始注入架构概览"启发，已收窄）：

- 内容：只含 project 名和少量入口点 / 顶层模块（来自 `get_architecture`），固定字符上限，按码点截断；
- 时机：索引就绪后后台生成并缓存；仅在会话早期的 context 块注入，之后不重复；索引未就绪则不注入；
- 通道：走 `systemPrompt.context`，**不依赖会话开始事件的返回值**。已核实（官方 `runtime-types.ts`）：官方事件面没有 `agent/session-start` 这个名字，会话开始事件是 `agent/created`（serial，source = startup/resume/clear/compact），监听器返回值类型为 `undefined`——返回值不被宿主消费、不可注入；
- 收益边界：它主要帮模型知道"该用哪个 project、入口在哪"，对精确符号查找帮助有限，所以默认关闭，用数据决定是否开启。

### 4.5 杠杆 ④（可选）：`agent/pre-step` 提醒消息

只在 ②③ 之后仍然采用率不足时考虑：检测到上一步是标识符 grep，则在下一步前追加一条一次性提醒。必须使用 `plugin:dsh-codebase-memory` 作为 `source.kind`，读侧用白名单避免被当成用户输入，并做去重。依据见 2.7 与 3.4。

API（已核实，官方源码 `packages/core/agent/src/runtime-types.ts` + `packages/core/agent-loop/src/agent.ts`）：`agent/pre-step` 为 waterfall，payload `{ agent, messages, turn, step, signal }`，决策 `PreStepDecision = { kind:'reject' } | { kind:'enter'; messages; startsRequestSeries? }`——追加提醒 = 返回 `{ kind:'enter', messages:[...payload.messages, 提醒] }`；decision.messages 由 loop 以 `user/message` 落盘（surfaceOp append），故必须带 `source.kind`（见 2.7）。`reject` 可中止本步。

### 4.6 杠杆 ⑤：写后失效标记（脏路径 + 查询前新鲜度检查）

**动机。** 杠杆 ①② 的前提是"索引可信"，但现状有缺口（均见 dsh-cbm 的 [Known limitations](https://github.com/njuptlzf/dsh-codebase-memory#known-limitations--non-goals)）：

- `sessionRefresh` 只在会话开始事件（官方名 `agent/created`，dsh-cbm 现状称 session-start）触发，**本会话中途的编辑不覆盖**；
- 引擎自带的 watcher 只管服务端进程 cwd 对应的 git 项目，在多工作区的 DSH 里覆盖不到会话工作区；
- 坐标过期时 `get_code_snippet` 会在正确的符号名下返回邻居代码，`index_status` 仍是 `ready`，不报错（上游 [issue #1750](https://github.com/DeusData/codebase-memory-mcp/issues/1750)）。

**为什么不能"每次写文件就触发增量索引"。** README 实测一次 refresh 的固定开销约 18–30 秒，即使增量也是如此（主要是固定开销，不是重新解析）。逐文件触发会堆积后台任务，所以改成"先记账、查询前再检查"。

**做法：**

1. 在 `tools/post-execute` 监听写入类工具（已核实，官方 tool-fs README：`write`（`file_path`, `content`）与 `edit`（`file_path`, `old_string`, `new_string`, `replace_all?`），路径字段统一为 snake_case `file_path`；沙箱模式下另有 `sandbox_permissions` / `justification` 附加字段），只把路径记入会话状态里的脏集合，不触发 refresh；只记录工作区内的代码文件（按扩展名与 `.gitignore` 规则过滤），路径做规范化（Windows 大小写、斜杠）；
2. 每次 cbm 查询前（封装工具、拦截的前提检查），若脏集合非空，对这些路径调用 `check_index_coverage --paths`（带时间预算）；
3. 结果不是 fresh 时：触发后台 refresh（合并去重，带冷却）；本次封装工具的返回里附"索引可能过期"的警告，拦截则直接放行（见 4.3 前提 5）；
4. refresh 完成后清空对应路径；失败则保留并记入遥测；
5. 处理时机采用惰性：同一回合内的多次写入自然合并，不在每次写入时处理。

**与 `sessionRefresh` 的关系：** 互补。`sessionRefresh` 管"上次会话之后的外部改动"，本杠杆管"本会话内自己的改动"。

**边界：** 非 git 工作区仍不处理（沿用 README 的立场）；其他会话对同一仓库的改动不在覆盖范围内；refresh 进行期间的查询，等待有限时间后放行。

### 4.7 度量与测试

沿用 dsh-cbm 工程笔记里的"检查必须可证伪"原则：

- **分类器单测**：一组符号类与字面量类正反例，断言字面量类误拦为 0；可以放进现有 `npm run check` 流程，不依赖 LLM。
- **运行时遥测**：记录每次拦截 / 放行 / 出错；拦截后模型是否随后调用了 cbm；是否紧接着再次 grep（即误拦信号）。思路对应 dsh-mneme 的审计表与注入预览（[PR #265](https://github.com/slow-stack/dsh-mneme/pull/265)）。
- **失效相关遥测**：脏路径数、查询前检查命中"过期"的次数、因脏路径而放行的拦截次数、后台 refresh 的耗时与失败次数；
- **离线评测**：一组固定问题（图形态与字面量形态各一批）人工跑一遍，统计"首个检索工具是 cbm"的比例，对比改造前后。

### 4.8 配置项（v0.3.0 落地值）

| 字段 | 默认 | 含义 |
|---|---|---|
| `wrapperTools` | `true` | 是否注册 `code_find` / `code_callers` |
| `enforce` | `advise` | `off` / `advise` / `deny-once` / `deny` |
| `interceptTools` | `grep,glob` | 逗号分隔的内置工具名（裸名小写）；实现用字符串是为了避开 profile YAML 里数组的歧义 |
| `interceptBudgetMs` | `2500` | 钩子里 cbm 查询的时间预算，超时放行（实测热链路 29–64ms，余量给冷连接） |
| `contextHint` | `true` | 是否启用条件注入（杠杆 ③） |
| `dirtyTracking` | `true` | 是否启用写后失效标记（杠杆 ⑤） |
| `dirtyRefreshCooldownSec` | `120` | 脏路径触发后台 refresh 的冷却时间 |
| `telemetry` | `true` | 是否记录拦截 / 放行 / 记账 / 补刷（`$adapterDir/telemetry.log`，一行 JSON） |

未落地的可选项：`archDigest` / `archDigestMaxChars`（4.4 的"可选子项"）与杠杆 ④。三者的取舍依据见 6.1 末段——advise 已覆盖"不阻断地给提示"，而宿主自带的 `dsh-repeat-tool-reminder` 已经负责重复循环，摘要则要等数据证明它值那点 token。

### 4.9 落地顺序

0. **第 0 步（可选）：原型验证规则。** 用现成的外部 hook 包（先确认是哪个包，见 2.6）配一条只针对 Grep 的 pre-tool 规则，先只记录不拦截，量出"符号类 vs 字面量类"的比例和误拦率，再写成原生订阅。外部 shell 钩子拿不到插件内状态、每次调用要起进程（Windows PowerShell 5.1 的坑 README 已记录），所以只作原型，不作最终方案；
1. **第一步：杠杆 ①。** 风险最低、收益最直接，不涉及阻断；
2. **第二步：杠杆 ⑤。** 与 ① 同步或紧随其后，因为 ① 返回结果的可信度依赖它；
3. **第三步：杠杆 ② 的 `advise` 模式 + 遥测。** 先看数据；
4. **第四步：数据稳定后升 `deny-once`；**
5. **第五步：补杠杆 ③**（含可选的架构摘要）；④ 视效果再定。

---

## 5. 风险

- **宿主不稳定**：DSH 是 Developer Preview，扩展点和决策契约可能变化。对策：每个杠杆独立开关、hook 内 try/catch 并 fail-open、沿用 dsh-cbm 现有的"启动阶段永不抛错"原则。
- **误拦**：把字面量搜索拦掉会伤害体验。对策：保守分类、一次性拦截、前提不满足即放行、遥测监控。
- **token 取舍**：封装工具会增加 schema，需要用 `check-tokens` 量化后再决定保留几个。
- **不建议隐藏内置 Grep**：字面量搜索确实属于 grep（README 的"留出口"原则同样适用）。
- **平台**：当前实现硬编码 Windows，拦截逻辑与路径处理需一并考虑跨平台。
- **hook 包选型混乱**：多个社区包名字相近、能力不同（见 2.6），原型阶段先确认再用，最终方案以原生订阅为准。
- **写入追踪依赖工具名**：杠杆 ⑤ 需要知道哪些工具会写文件、路径在哪个参数里，宿主改名会让它静默失效；对策是遥测里记录"本会话是否观察到写入事件"，长期为零时告警。
- **摘要的成本与过期**：架构摘要占用 token 且可能随编辑过期，所以默认关闭、限长、只注入一次。

---

## 6. 待核实清单（落地前必须确认）

状态说明：**已核实** = 官方源码 / 官方文档确认；**未核实** = 没有任何来源；**部分验证** = 有第三方文档佐证，但未在目标 DSH 版本实测。

| # | 待核实项 | 状态 | 为什么重要 | 建议核实方式 |
|---|---|---|---|---|
| 1 | 封装工具引入后的真实 token 增量 | **已测** | 决定 ① 的取舍 | `check-plugin.mjs` 臂 G 断言 schema 体积 ≤2200 字节；实测 `code_find` + `code_callers` = **1651 字节 ≈ 413 tokens/请求**（代理省下的 ~3200 tokens 的 13%） |
| 2 | `check_index_coverage --paths` 的耗时、并发与按路径调用的行为 | **已测，结论是"不能当门"** | 杠杆 ⑤ 与拦截前提 3 的开销 | 经代理单路径 **29–90 ms**。但 `freshness` **不是逐路径判定**：把当前状态全量重索引之后，立刻查一个没改过的文件，仍返回 `status=no_recorded_issue / freshness=metadata_changed / action=read_source_and_reindex`，与改过的文件一模一样（引擎 0.11.0，本机）。它是"项目元数据代际变了"的全局信号 ⇒ 拿它当门 = 拦截永久失效 + 每条被拦的 grep 调度一次约 20s 重索引。落地改用本会话写入台账（见 6.1） |
| 3 | 拦截时间预算的合理阈值与冷启动延迟 | **已测** | 决定 `interceptBudgetMs` 默认值 | **代理链路（keep-alive）热了 29–64 ms**；`codebase-memory-mcp cli` 单次 `search_graph` 实测 **5491 / 6526 / 8280 ms**。默认 `interceptBudgetMs=2500` 是给冷连接留余量，超时放行 |

---

## 6.1 落地时的核实结果（v0.3.0，宿主 0.1.5-rc.2 实装）

方案里标"待核实"的接口，这次全部按**本机安装的宿主 dist** 核对过（`@deepseek-ai/dsh-tool-cordis` 里带完整事件与服务目录，`dsh-tools/lib/index.js`、`dsh-system-prompt/lib/index.js` 是实现）。与原方案的差异如下，落地以这一节为准：

| 原方案的说法 | 实装里的真相 | 对本次落地的影响 |
|---|---|---|
| 会话开始事件官方名是 `agent/created`，没有 `agent/session-start` | **两个都有**：`agent/created`（agent 实例创建）与 `agent/session-start`（`dsh-agent-loop` 在首个回合前 emit，带 `source`） | 现有 `sessionRefresh` 的监听名不用改；臂 E 继续以"真收到监听器调用"为准 |
| 会话开始事件的返回值不被宿主消费、不可注入 | 正确（emit），**但 payload 里的 `agent` 有 `agent.inject(message)`**，官方事件说明原文就是 "Use `agent.inject()` to seed model-facing context" | 4.4"可选精简架构摘要"因此有一条更直接的送达路径；本次仍未实现（默认关、等数据） |
| 插件侧只能经 `mcp__cbm__mcp` 让模型自己查 | `ctx.tools.execute(exec)` 在宿主的 `tools` 服务方法表里是**公开方法**，走完整策略管线 | 封装工具与拦截都改成经它复用 keep-alive 长连接（30–60ms），不 spawn CLI（5.5–8.3s，那个数字让 4.3 原写法不可行） |
| `systemPrompt.context` 的 text 可以是异步 | text 必须是**字符串或同步函数**；返回 `undefined`/Promise 触发装配不变量，返回 `""` 才是"本轮不注入" | ③ 只能读**已缓存**的 project（同 cwd 解析过就有），绝不在渲染里查 |
| 注入的 runtime context 进系统提示词 | 不进 prompt：contexts 被投影成一条 **user 角色的 runtime-context 快照**，且 `suppressRuntimeContext()`（极简预设 / `includeRuntimeContext:false`）**全量**丢弃 | ③ 的已知盲区确认存在；①②④⑤ 不受影响，这也是它们优先级更高的原因 |
| 消息要带 `source.kind`（V4） | 宿主自家桥接包用的形状是 `{kind:'plugin', plugin:'<生产者名>', form:'notice', summary:'…'}` | advise 消息照这个形状手写，不 import `createUserMessage`（少一个 boot 期硬依赖） |
| 4.5 的 pre-step 提醒（杠杆 ④） | 可用，但宿主已另有 `dsh-repeat-tool-reminder`（默认阈值 3/5/8，只看**参数完全相同的连续重复**） | **未实现**：advise 已覆盖"不阻断地给提示"，而重复循环由宿主那个包负责。两者按语义/按重复分工，不冲突 |
| 4.3 需要在钩子里跑 search_graph | 可行，且必须走代理链路 | 已实现，且 reason 里嵌的就是命中行（按码点截断 900） |
| 4.6 做法第 2–3 步「每次 cbm 查询前对脏路径调用 `check_index_coverage`，非 fresh 就补刷」 | 这个信号在引擎 0.11.0 上**不是逐路径判定**：把当前状态全量重索引之后，立刻查一个没改过的文件，仍返回 `metadata_changed` / `read_source_and_reindex`（第 6 节 #2） | 落地改成**只用本会话写入台账**判过期（`ledgerStale`）：写过代码 ⇒ 拦截放行、结果标 `stale` 并点名路径、调度带冷却的补刷；覆盖查询退出钩子，仍作为人工证据留在 prompt 动线。另外 `refreshSessionWorkspace` 改为返回 `refreshed / skipped:* / failed`，**只有 `refreshed` 才清台账**——被闸门挡下等于什么都没重建，清账就是宣称"改动已进索引" |

另外三条实现期学到的规则，写进了分类器与测试表：

- `dsh.profile.bundles` 这种**全小写点分链**是配置键形态 ⇒ 判 literal（放行）。限定名里至少要有一段带大写或带下划线，才认为是在找符号（`svc.doThing` ⇒ `doThing`）。
- 被 deny 的调用**仍会走 post-execute**（宿主调度器的 `post-result` 分支），所以 advise 分支必须跳过 `result.isError`，否则拦截和软提示会一起打在模型身上。
- **图里没有这个符号就必须放行**（4.3 的前提清单漏了这条）。reason 里嵌命中是这层的全部价值；命中为空还拦，等于把模型唯一走得通的路挡了、只剩一句说教。实现按两种返回形状判空（json 的 `rows: []`、tree 的 `total: 0`），遥测记 `intercept-pass-no-hit`。

落地时才暴露的一条（方案没写、必须写回来）：**同一工作区的索引任务不能并发**。`code_index`、层 ⑤ 的后台补刷、引擎自带 watcher 都可能同时要跑 `index_repository`，引擎的处理是让其中一个**退出码 1 + `status:"aborted_previous_preserved"`**（hint 原文 "Retry; if it repeats, check the run log"），前一份索引保持可用。这就是 4.6"refresh 进行期间的查询，等待有限时间后放行"那一行的具体形态，只是等待对象不是查询而是索引任务本身。处置：① 插件内按 cwd 排队（在飞锁），② 被中止的一次自动重试一次并记遥测 `index-retry-contention`，③ `check-plugin.mjs` 臂 G9 在假 subprocess 层复刻这条中止。

落地位次（对照 4.9）：① + ⑤ + ③ 已实现并纳入 `npm run check`（臂 G）；② 的 `deny-once` / `deny` 已实现但**默认不启用**，等 telemetry 说话；④ 与架构摘要未做。**补记（2026-10-08）：曾以"② 的 advise 分支"落地的 post-execute 事件注入经用户验收撤回**（注入的上下文噪声大于价值）；`additionalContexts` 通道不再使用，臂 G7 改为断言"默认 `enforce=off`、符号类 grep 不追加任何上下文、写后记账仍在"。

---

## 6.2 语义检索层内置的核实结果（v0.5.0，接入 zvec-grep）

用户验收 2026-10-09 判触发层"**还是软限制**"，要求研究把 [zvec-grep](https://github.com/zvec-ai/zvec-grep)（rg+BM25+向量的统一本地检索，阿里 Zvec 团队，Apache-2.0）内置进本插件。先跑了第 0 步（vendor 装包 + 真索引 + 延迟/命中基准），数据支持"内置"而不是"另起炉灶"，于是 v0.5.0 落**接入层**，v0.6.0 落**替换档**。核实出来的事实与据此的决策：

| 事实（本机实测） | 决策 |
|---|---|
| 装包 190 pkg / 3min / **1230MB**，其中 `node-llama-cpp` 743MB + `onnxruntime-web` 90MB 是服务端推理后端，transformers.js 路径**根本不加载**；裁掉后 `--version` / 增量 `index`（2s）/ `query` 全过 | `install:zg` 装完即裁，**末尾 --version 自检**当门禁（裁剪装坏就报错并提示别用 `--omit=optional`）；vendor 净 **430MB** |
| 引擎 0.11.0 的 15 工具面**没有向量检索**（`search_graph`=BM25/正则，`search_code`=graph-ranked text）；zg 对 `observeCall` 给出精确 span、对已漂移的 `scheduleDirtyRefresh` 坐标**比旧图更新鲜**、`.md` 非代码文件也能语义命中 | zg 定位是**补位不是重复**：语义/文档检索走 `zg_zvec_grep_search`，符号与调用关系仍走图谱，精确字面量仍走 grep——prompt 里三行路由就是这么写的 |
| 查询延迟：守护进程冷起（含 32MiB 模型池）2.2s、热查询 symbol 1.42s / semantic 1.37s，rg 基线 1.09s；首次查询 3.3s | 清单里 zg 用 **`lazy`**（与 cbm 的 keep-alive 相反）：不需要 `auto_index`/watcher 抢启动，首用 2.2s 可接受，不常驻进程 |
| 代理把工具名**按 mcpServers 键加前缀**：裸名 `zvec_grep_search` 经清单不可调，可调用名 `zg_zvec_grep_search`（实测 tool_not_found 的 suggest 就是它） | prompt 示例、check-chain 阶段 2b、README 全部用带前缀名 |
| `root` 参数**必填**（"Absolute workspace root visible to the daemon"），缺省报 `root: Invalid input` | prompt 示例带 `"root":"<工作区绝对路径>"`；**替换档（v0.6.0）的卖点之一**：钩子调用可以拿会话 cwd 预填，模型一个字都不用填 |
| `--mcp-toolset agent` 只露 1 个检索工具；`full` 另露受管 rg 与 4 个索引/状态工具 | 默认 `agent`：索引/守护进程管理留 CLI 与脏台账补刷链路，不给模型多余按钮 |
| `cbm.json` 在 adapter **进程启动时**读取；zg 索引产物落仓库的 `.zvec-grep/` | `zgEnabled`/`zgToolset`/`zgVendorDir` **刻意不标 volatile、不进设置页**（页面画了就等于说谎，理由与 6.1"volatile 必须在决策点 `.get()`"同源反用）；要重启。`.zvec-grep/` 进 gitignore（本仓库已加） |
| vendor 装包=430MB+32MiB 模型下载，属于"要人点头"的开销 | `resolveZg` 缺包只报 `missing` + 提示 `npm run install:zg`，**绝不自动装**（臂 Z 断言）；开关默认 `false`，关掉时清单/prompt/行为与 v0.4.0 完全一致 |

新鲜度不另建 watcher：`dirtyTracking` 的后台补刷现在**两条腿**——图谱 `code_index`（git 闸门）+ `zg index`（不看 git，非 git 工作区也刷），遥测行 `zg-index-done/failed`。

**v0.6.0（替换档）待核实的宿主问题**：`tools/pre-execute` 的 waterfall 能否**改写 exec 参数**后放行（真透明替换），还是只能 deny+reason（答案随拒绝送达）。前者要先在本机宿主 dist 里核 `PreToolDecision` 的实现，再定替换语义（符号形 grep → zg/graph 结果直通）。


---

## 6.3 替换档（replace）的核实结果（v0.6.0，宿主 0.1.5 实装）

6.2 留的那个"待核实宿主问题"，这次照本机安装的宿主 dist（`@deepseek-ai/dsh-tools` 的 `lib/types/index.d.ts` 与 `lib/index.js`）核死了，答案决定架构：

| 核实的点（原文证据） | 结论与落地 |
|---|---|
| pre-execute 能否改写参数？`PreToolDecision = allow \| deny{reason,info?} \| cancel \| ask`（index.d.ts:445-459），且文档注释逐字写着 **"Input rewriting is excluded because arguments are already logged and presented"**；实参在进钩子前被 `deepFreeze`（lib/index.js:3163-3167） | **透明改写不可能**，原方案的"pre-execute 换参数"直接放弃。钩子里改 `exec.arguments` 只会 throw（frozen）或静默失效 |
| post-execute 的 `accept` 语义：`PostToolDecision = accept{content? \| value?} \| block{feedback}`（index.d.ts:465-479），文档逐字 **"accept keeps the call successful (replacing content when given)"**，且 "Policy replacements remain authoritative"（L130-133） | **替换走 post-execute**：grep 照常执行、照常成功，监听器返回 `accept + content:[TextBlock]` 把模型可见输出整体换成图谱/语义命中。**不产生 isError**——这正是 advise 撤回后剩下的唯一"硬"通道：软提示是往旁边加话，替换是把答案本身放进它必须看的位置 |
| 监听器 throw 会被外层 catch 成 **isError**（postExecute 文档 L828-839） | 替换监听器全函数 try/catch，任何异常 `next()` 原样放行——替换失败绝不能把成功的 grep 变成失败 |
| 脏台账规则（6.1）在替换下更危险：拿可能过期的坐标**冒充**搜索结果 | **台账脏 ⇒ 不换**，只调度补刷（遥测 `replace-pass-dirty`）。和 deny 路径同一条正确性规则，但代价更高：替换是"说谎"，拦截只是"晚一步" |
| 命中来源优先级 | 图谱 `search_graph`（29–64ms 热链）→ 无命中且 `state.zg==='ready'` 才试 `zg_zvec_grep_search`（钩子用会话 cwd **预填 root**——6.2 预告的卖点落地）→ 两边都没有就保留原输出（`replace-pass-no-hit`）。**没答案就不换**，与 deny 的"图里没这符号必须放行"同源 |
| zg 冷守护进程 3.3s > `interceptBudgetMs`（2500ms） | 接受：预算内起不来就本轮放行、后台把守护进程焐热，下一符好。注释标注了这个取舍（ponytail），升级路径=加大 budget 或 zg 改 keep-alive |
| 换掉的原输出要不要留一份？ | **刻意不留**：两者都给，模型照样顺着原始 grep 的习惯走——"还是软限制"的根源就在这。行首一行写明"原始输出已替换 + 想看回去改 enforce off"，反悔成本是一次热开关 |
| 设置页能不能直接开？ | 能。`enforce` 本就是 volatile 三件套之一，`replace` 进 `ENFORCE_MODES` 后设置页分段控件自动多出「换成索引」，**改完即时生效不用重启**；臂 R 专门断言 volatile 热翻立即开合替换通道 |

顺带修正 6.2 排期里的一处纸面计划：验收目标曾写"check:chain 15→17 工具断言"——链门本来就是计数无关的（`tools/list` ≥5 行 + 阶段 2b 真实检索），替换档不新增 MCP 工具、不碰工具数；真正新增的可证伪性是 check-plugin **臂 R** 的 9 条（含"查询走代理不 spawn CLI"与四条合法放行），总数 156→174。

---

## 6.4 设置页读数通道的核实结果（v0.7.0）

6.3 收尾时留了下一个问题：replace 要"跑几天看 `replace-pass-dirty`/`no-hit` 占比"，可计数只躺在 `telemetry.log` 里——不看日志就没人知道占比。这一节把"插件往设置页推进数据"这条通道的每一步都照宿主源码核死（`@deepseek-ai/dsh-settings`、`@deepseek-ai/cordis-plugin-loader`、`@deepseek-ai/dsh-client-ui-settings`、cosmokit，均本机安装的 dist）。

| 核实的点（原文证据） | 结论与落地 |
|---|---|
| 设置页显示的 `value` 从哪来？`describe()` 算的是 `projectForm(form, plainConfig(entry.fiber.config))`（dsh-settings `lib/index.js:413` 起），`plainConfig` 对 volatile 节点做 `isVolatile(v) ? v.get() : v`（`lib/index.js:98`） | **volatile 字段是双向的**：不只是"页面写→插件热生效"，`ref.get()` 的值也会被 describe 原样读给页面——插件把自己算好的 JSON 推进 `config.stats` 这个 volatile 引用，页面就能看到**运行期数据而不碰持久化文档**。指纹 `raw=[uid, schema.toJSON(), entry.options.config]` 只含文档层值，不含 ref 值 ⇒ 推读数**不涨 revision、不触发写栅栏** |
| 推完怎么让页面刷新？浏览器侧 `ctx.remote.$on("settings/document-updated", () => mirror.load())`（dsh-client-ui-settings `lib/client.js:1512`）——**参数被忽略**，任何一次该事件的到线都会重拉整个 describe 镜像 | 插件推完 ref 后 `ctx.emit('settings/document-updated', <ns>, <revision>)` 即触发刷新。推送做节流：首个事件立即 emit，之后 2s 窗口合并（`STATS_PUSH_MS`），窗口内的计数只更新 ref 不发线——读数是聚合值，晚 2 秒到页面没有任何代价 |
| 插件写的 ref 会不会被宿主覆盖？`_commitVolatile`（cordis-plugin-loader `lib/index.js:393-414`）在任何用户配置写入后把 volatile 引用按**文档解析值**逐个 `updateVolatile` 复位 | 会被复位——**接受**：复位只发生在人动配置的那一刻，插件在下一个事件就全量重建推回去。所以推送的必须是**从 `state.counts` 全量重建的完整 JSON**，绝不能做增量改写（增量遇上复位就永久错位）。这也定死了 stats 字段的归属：它是**插件所有的草稿区**，人在文档里写什么都无意义 |
| 写引用要不要 `import { createVolatile } from '@deepseek-ai/cosmokit'`？ | **不加依赖**。cosmokit 的 write 通道是 `Symbol.for('cosmokit.volatile.write')`——**全局符号注册表**，跨包副本天然同键（cosmokit `lib/index.js:83`）。插件侧 `isVolRef`/写入直接用这个全局符号即可；宿主自己的官方插件（dsh-llm-deepseek）是直接 import 的，但我们 `package.json` 没有 dependencies 字段，运行时靠的是宿主已解析的同一条 `require` 链——引一个没声明的包，不如引一个协议级全局符号 |
| 计数要不要和遥测开关解耦？`telemetry()` 第一行就是 `if (!cfg.telemetry) return` | **同一道门**：关遥测 = 计数冻结（不是清零），页面读数停在最后一次推送并标注"关遥测即冻结"。另开一条 always-on 计数路径要多一套门闩和测试，换来的只是"关了遥测还能看数"——这本来就是用户明确不要的可见性，不值得 |
| 页面上要展示什么？（指标审计结论） | 用户拍板的那条：替换命中率 `intercept-replace / (replace + pass-dirty + pass-no-hit + replace-error)` 及**按来源拆分**——`fields.source` 以前只进日志行字段，现在事件名伴生键 `${event}:${fields.source}`（如 `intercept-replace:graph`/`:zg`）进计数，图谱/语义两条腿的占比直接可见。同时补了两个此前完全没数的软杠杆：封装工具真实调用数（`runCbmFlow` 里记 `wrapper-call`）与提示注入次数（`hint-injected`）——杠杆 ①③ 有没有人在用，是"要不要继续花钱养它们"的决策数据。deny 侧三件套、脏台账积压（sched−done−fail）、索引争用重试一并上页；**没答案的行不展示占位**（`at` 时间戳缺失整块显示"暂无读数"） |

验收：check-plugin **臂 S**（×2 profile，共 8 条）——替换事件后 volatile ref 里是 `replace.hit===1 && replace.graph===1` 的全量 JSON、emit 恰好带 `('settings/document-updated', 'codebase-memory', <数字 revision>)`、软杠杆两项都进了读数、**遥测关时不推不 emit**；G7.5 的 volatile 白名单从三件套扩成四件套（`stats` 的 volatile 是方向反转的通道，不标则 describe 根本不解引用）。总数 174→182。

---

## 6.5 v0.7.0 验收的两处修正（v0.8.0）

用户对着设置页截图提了两条（m02473）：

1. **措辞把两层能力写成了非 A 即 B。**「换成索引」+「整体替换成图谱命中（图谱没答案时用语义检索）」读起来 zg 只是图谱的备胎——而 6.2 的研究结论恰恰是**结构层与语义层互补并存**。事实是：replace 档只改"一次 grep 的输出换成谁的命中"（取数顺序：结构层先答、语义层补位），`code_find` 与 `zvec_grep_search` 作为常规工具不受该设置影响。修正落在四处：模式 label「换成检索」、hint 与模型可见文案明写「结构层（代码图谱）/语义层（zvec-grep）… 两层始终并存」、触发层 docblock 与 ②b 注释加措辞纪律。**措辞纪律和逻辑一样要可证伪**：check-plugin 臂 R 新增断言——替换文案必须含「结构层」且不再出现「索引命中」。
2. **读数照 dsh-mneme 状态页卡片化。**词典模板一行塞六个数字没法扫。改为五张卡片（替换命中率 / 拒绝对照 / 脏台账 / 软引导 / 索引），每卡一个大数字（24px/600 tabular-nums）+ 指标行，命中率卡带**结构层/语义层占比条**；样式变量与尺寸取自 mneme 的 status.css，只用宿主 `--dsw-alias-*`，亮暗主题免适配。数据通道不动（仍是 volatile `stats` JSON），只换渲染层；check-client 补 6 条读数断言（`80%` 大数字、hit/den、五卡齐全、占比条题注区分两层、不新增交互件、坏 JSON 占位）。

总数 182→184。

---

## 6.6 读数卡片的"空态"本身是 bug（v0.8.1）

v0.8.0 验收截图（m02738）：措辞已生效，但运行读数仍是一行"暂无读数"——**没看到任何零值卡片**。根因：stats 通道是纯事件驱动的，刚重启的宿主还没发生符号 grep / 写文件 ⇒ volatile `stats` 引用保持 schema 默认 `''` ⇒ 页面走空态分支。而 mneme 状态页的语义是**卡片常驻，零就显示零**——"没数据"根本不该是一种展示态。修正三处：

1. **服务端开机先推一帧零值快照**（`apply` 里 `cfg.telemetry` 为真时立即 `pushStats()`）；遥测关仍不推不 emit（与臂 S 的冻结语义同门）。
2. **客户端遥测开 ⇒ 零值卡兜底**：`stats` 缺失或坏 JSON 时按全零渲染（大数字 `—`、`0/0`），不再进空态。这同时覆盖了"用户改一次配置，loader 把 volatile 引用复位成文档默认"的窗口期——复位后到下一个事件之间页面也是零值卡，不是空行。
3. **空态只属于"关了遥测"**，文案照此改写（中英）。

教训：可观测性面板的缺省态必须是"有结构的零"，不是"无结构的文案"——否则验收期根本分不清"没发生"与"没接上"。臂 S +1（开机零值快照，双臂 ×2），check-client 读数断言净 +2（坏 JSON 臂改为"零值卡常驻"，新增"空 stats+遥测开⇒五张零值卡"与"空态仅遥测关"）。总数 184→186。

---

## 6.7 泡数据的地基：计数要活过重启，替换不能撒谎（v0.8.2）

用户拿 0.8.1 的页面去执行"开 replace 跑几天看占比"（m01536 的原始目的），一轮下来发现三个问题，全部由**这次验收本身**暴露——读数通道上线前，这些是看不见的：

1. **重启即归零**。计数只在 `state.counts`（进程内存），宿主一重启页面就回到全零——"跑几天"根本没法跑。决定：计数落盘为**累计值**，写在 `telemetry.counts.json`（`adapterDir` 同目录，与 telemetry.log 并排）。语义选择：
   - **max 合并而非累加落盘**——内存计数是单调的，写文件时与文件旧值逐键取大，天然幂等：多宿主进程（tauri+web 同时在跑）各写各的也不会互相抹掉，也不会把同一事件记两次；代价是"删文件清零"成为唯一的重置手段（排错表已写）。
   - **开机播种**：`apply` 里遥测开时先 `loadCounts()` 灌回 `state.counts`，再推首帧——首帧就带历史。遥测关不播种（否则 `code_setup` 会把冻结的历史数当活数报）。
   - **`DSH_CBM_COUNTS_FILE` 测试缝**：宿主从不设置；harness 每次 mount 指一个新文件，否则"intercept-replace=1"这类精确断言会被前序臂的历史污染。生产路径（env 未设 ⇒ `adapterDir` 可写）由臂 S2 的落盘断言覆盖。
2. **越界替换（bug A）**：telemetry.log 里 `path` 指向工作区外（如宿主依赖目录）的 grep 也被换成了**本仓库**的图谱命中——图谱和 zg 都是工作区级的，这不是"换个答案"，是**伪造坐标**。修在 `coversWorkspace(args, cwd)`：`interceptPremises` 与 deny 钩子各加一道，`path` 解析到工作区外 ⇒ 原样放行、连查询都不发。空 `path` = 工作区根，照拦。
3. **错误文本当命中（bug B）**：代理层把底层 MCP 错误包成**普通文本**返回（`isError` 不置真），zg 打不开 collection 时的 `Error: Failed to open zvec collection storage…` 整段被当成检索命中替换了 grep 输出。修在 `cbmCall` 单一咽喉：文本以 `error` 开头 ⇒ 判 `ok:false`。同时把"查询失败"从 no-hit 里**拆出来单独计数**（`replace-pass-failed`）：泡数据时"两层都答不上来"（该考虑调 pattern 面）与"链路坏了"（该修环境）含义相反，混在一个占比里两个结论都拍不了。替换卡的占比分母与行随之加上这一项。

教训：**给决策者看的每个数，先问它会不会说谎**。会伪造坐标的替换比不替换更坏；会把故障混进"无命中率"的占比比没有占比更坏。臂 R2/R3/S2（+5，双臂 ×2，186→196）就是这三问的回归锁。

## 6.8 其余字段上设置页：能热改才配被热改（v0.9.0）

用户（m02897）指着 0.8.2 页脚那行"其余字段仍需改 cordis.patch.yml 并重启"问：能不能也放到设置页？答案是分三类，判据只有一条——**宿主写路径（dsh-settings `write()`）物理拒绝非 volatile 字段，而 volatile 的语义承诺是"改了当场算数"**。所以"上页面"不是画控件，是把字段改到配得上被标 volatile：

1. **本来就热、页面漏画**：`interceptBudgetMs`（v0.7.0 起就是 volatile，钩子每次 `.get()` 现读）——补个输入框了事。
2. **语义可热、实现说了谎**：`interceptTools` / `contextHint` / `dirtyTracking` 原本在 **apply 期取快照 + 注册期门闸**（`if (cfg.dirtyTracking) ctx.on(...)`、`if (cfg.contextHint) ctx.systemPrompt.context(...)`）——直接标 volatile 会得到一个"页面上能翻、下个会话才生效"的假开关。改法：监听器**常驻注册**，门闸挪进回调第一行现读（deny 钩子 v0.3.0 就是这个形状，照抄）。代价如实记录：记账监听器从此永远占 post-execute[0]，replace 监听器一律后移到 [1]——harness 12 处索引引用逐一审计（8 处改、4 处不变），臂 T 三条断言（翻 `dirtyTracking` 记账当场开合 / 翻 `contextHint` 回调变 `''` / 翻 `interceptTools` glob 当场被换）就是"不重挂载、当场变"的回归锁。
3. **结构上热不了，别装**：`wrapperTools`（`tools.register` 无注销）、`zgEnabled`/`zgToolset`/`zgVendorDir`（`cbm.json` 清单在适配层进程启动时才读）、`bootstrap`/`adapterDir`/`cbmPath`/`autoIndex`/`sessionRefresh`（apply 期语义）。这些留在配置文件，页脚文案点名它们，并写明**为什么**不能热——页面的诚实比页面的字段数重要。

顺带两个小决定：输入框只在 blur/回车且值合法时写（非法值拨回当前值，一个字节都不写）——开关即时写是既有语义，文本框逐键写会把一次编辑变成一串文档写；`dirtyRefreshCooldownSec` 有热读语义但刻意不上页（调优参数，不是决策参数，页面每多一个控件就多一份维护契约）。臂数 196→202。

---

## 6.9 页面的分层语法：标签、恢复、状态行（v0.10.0）

用户（m03734）对着 0.9.0 的页面提了三条：①开关和说明的归属"根本看不懂"；②"恢复默认"和分段控件上方的恢复按钮撞名；③页面把"软引导/硬拦截"和"两层检索"混成一列，看不出 cbm 图谱层与 zvec-grep 语义层是**并存的两层**而非二选一。三条背后是同一个教训：**控件语义要靠版式表达，词典措辞替不了它**。

- **标签行内自铺**。`primitives.Switch` 的 `label` prop 在宿主上不渲染可见文字（截图实证），说明文字孤悬其下就成了无主文本。改法：每行 `span 标签 + 控件 + 恢复按钮` 同行、hint 在行下；check-client 断言 span 在场，锁死"不依赖控件自带 label"。
- **恢复是逐字段的**。全局"恢复默认"按钮删除，词典里禁止裸 `reset` key（臂守卫）；字段出现在 user 层时行内长出一个"恢复此项"，走 `form.unset(field)`。
- **按层分节**：软引导 → 硬拦截 → 检索两层 → 记账与遥测 → 参数。enforce 的 hint 文案改为"力度从左到右递增"，不再暗示模式之间与检索层有关。
- **「检索两层」状态行**（只读）：结构层恒在（索引后即可答），语义层显示实测状态——`stats` 载荷顶层新增 `zg`（off/ready/missing），`resolveZg` 探测完立即补推一帧，没数明说"状态未知"。zgEnabled 依旧不上页（v0.9.0 的判定不变）：状态行给的是**结果**，不是开关——开关会撒谎，结果不会。
- **推帧通道服从遥测开关**。resolveZg 的无条件推帧当场撞掉臂 S 的"遥测关 ⇒ 一帧不推（含开机）"契约（200/202）——页面与日志是同一个开关管着的，冻结语义必须完整。修复：`cfg.telemetry &&` 门住。这条是 v0.8.1 开机快照的镜像教训：**每加一个推帧点，都要重问一遍"遥测关了它推不推"**。

臂数不变（202/202 双臂 + check-client 布局断言若干），改动全部被既有 S 臂与新加的 185 臂接住。

---

## 6.10 验收抓出的冷启动谎言：查询失败不是"没索引"（v0.10.1）

用户（m04070）要求完整验收。重启宿主后第一条 `code_find` 报「本工作区还没进代码图，第一步：code_index」——可 `list_projects` 明明白白列着这个 project。探针复查：预热后同一条查询立刻返回真命中。**谎言的构造**：`projectFor` 把 `cbmCall` 的失败（引擎冷启动：第一发要等 MCP server 进程起来加载全部 project 的图谱库）和"表里真没有"折叠成同一个 `''`，还把代理返回的错误原文直接丢弃——排障的人被指去跑一次 20–30s 的 code_index，而真正的原因一个字都没露。

- **错误消息是唯一的诊断面**。"查询失败"必须报成"查询失败"并带出原文（前 120 字符），"不在表里"才指向 code_index。这和 v0.8.2 臂 R3 的"失败与无命中不混一个计数"同源：泡数据时这两种状态的含义相反，折叠一次，后面所有占比都白泡。
- **冷启动成本挪到会话外**。bootstrap 成功后在会话外打一发 `list_projects` 预热（20s 预算，每进程恰好一次，`code_setup` 报告行 `warm=ok/failed/pending`，遥测 `cbm-warm`）。会话里的第一发查询不再付这笔钱；预热失败不重试——计数会说话。
- **热路径多一发调用 ⇒ 全查"零调用"断言**。预热让既有臂 G6（"脏记账不触发任何 cbm 调用"）当场红：它数的是绝对值。改成基线差值。教训成文：**任何新增的启动期调用都要过一遍所有 calls.length 断言**，否则 gate 会替你把修复标记成回归。
- **报表行也是诊断面**。顺手修掉 `code_setup` 热改行的 v0.8 时代残留（"只有 enforce/telemetry 在页面上"——v0.9.0 起是六个字段）：文档说谎和代码说谎一样要验收来抓。

臂 W 四条契约（预热恰好一发 / 重复 code_setup 不叠加 / 两种失败各有其文 / 报告可见 warm），202→210。G6 基线化、双语 README 排错表新增"冷启动 vs 没索引"分辨行。

---

## 7. 参考链接

**DSH**
- 仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 介绍：<https://dev.to/justin3go/what-is-deepseek-harness-a-complete-introduction-4e5f>
- 与 Claude Code 对比（含 hooks 桥接）：<https://dev.to/justin3go/deepseek-harness-vs-claude-code-architecture-plugins-mcp-2nj7>
- 官方桥接包事件列表核实（支持 7/30 个事件、SessionEnd 缺口讨论）：<https://github.com/deepseek-ai/deepseek-harness/discussions/1595>
- 工具管线 deny 契约源码（`PreToolDecision` 与拒绝物化）：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/index.ts>
- 官方 agent 事件词汇表（`agent/created` / `agent/pre-step` / `agent/turn-stopping` 等签名）：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/src/runtime-types.ts>
- 官方 loop 实现（pre-step 决策落盘、turn-stopping serial 调用）：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/src/agent.ts>
- 内置文件工具 schema 核实（`read` / `write` / `edit` 参数）：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/tool-fs/README.md>
- dsh-hooks-plugin（KYinCode，第四个社区包，npm 包名已确认）：<https://github.com/KYinCode/dsh-hooks-plugin>
- 内置搜索工具 schema 核实（`grep` / `glob` 工具名与 `pattern` / `path` / `include` 参数）：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/tool-fs-search/README.md>、<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-catalog.md>
- 权限与沙箱解析（工具执行管线）：<https://dev.to/ahab_indieseek/deepseek-harness-permissions-and-sandbox-trace-every-tool-call-before-granting-access-4451>
- 工具执行管线文档（固定提交）：<https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/docs/tool-execution-pipeline.md>
- 权限预设文档（固定提交）：<https://github.com/deepseek-ai/deepseek-harness/blob/141eb6fef83422698aef7a981029e843e8161534/docs/subsystems/permission-presets.md>
- dsh-plugin-hooks（原生订阅示例）：<https://dsh-plugin.org/plugins/truelove-dreamer/dsh-plugin-hooks>、<https://dshpluginhub.ai/en/plugins/dsh-plugin-hooks>
- hookkit（扩展点能力边界：谁能 deny、谁能 inject）：<https://awesome-dsh-plugin.com/p/CREAIT-nl/dsh-plugins--hookkit/>
- DSH 架构背景（Cordis、dsh.bundle 清单约定）：<https://www.dshbase.com/blog/deepseek-harness-architecture/>

**dsh-mneme**
- 仓库：<https://github.com/slow-stack/mneme>
- 插件文档：<https://github.com/slow-stack/mneme/blob/main/dsh-mneme/README.md>
- 注入形态设计提案（挂载点与硬约束）：<https://github.com/slow-stack/dsh-mneme/issues/249>
- 注入开关两级化：<https://github.com/slow-stack/dsh-mneme/pull/297>
- 能力说明与分池注入：<https://github.com/slow-stack/dsh-mneme/pull/266>
- 工具曝光开关与描述纪律：<https://github.com/slow-stack/dsh-mneme/pull/276>
- 注入预览与旁路快照：<https://github.com/slow-stack/dsh-mneme/pull/265>
- V4 写入准入与 `source.kind`：<https://github.com/slow-stack/mneme/pull/327>
- 注入截断导致持续 400：<https://github.com/slow-stack/mneme/issues/334>

**dsh-codebase-memory 与 cbm**
- 本插件：<https://github.com/njuptlzf/dsh-codebase-memory>
- 本插件的已知限制（session-start refresh、坐标过期等）：<https://github.com/njuptlzf/dsh-codebase-memory#known-limitations--non-goals>
- 引擎 codebase-memory-mcp：<https://github.com/DeusData/codebase-memory-mcp>
- 引擎已知问题（索引坐标过期返回邻居代码）：<https://github.com/DeusData/codebase-memory-mcp/issues/1750>


