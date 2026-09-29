# dsh-codebase-memory

[English](README.md) | 简体中文

把 [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) 接进 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的 host bundle：**为当前会话的工作区建代码知识图谱，让模型按图检索代码，而不是逐文件 grep/read**。

## 目录

- [链路与分工](#链路与分工)
- [为什么需要它](#为什么需要它这个插件存在的全部理由)
- [安装](#安装)
- [怎么用](#怎么用)（含[话术清单](#3-话术清单实测有效)与 [AGENTS.md 模板](#4-怎么写-agentsmd一劳永逸)）
- [DSH 怎么找到它，模型又怎么开始用它](#dsh-怎么找到它模型又怎么开始用它)
- [引擎兼容性（codebase-memory-mcp 变了会怎样）](#引擎兼容性codebase-memory-mcp-变了会怎样)
- [配置](#配置可选)
- [验收](#验收)
- [排错](#排错)
- [工程备注](#工程备注给要改它的人)
- [已知限制与不做](#已知限制与不做)

## 链路与分工

```
DSH host 组合（本 bundle 的 cordis.patch.yml 插两行）
├─ ④ dsh-codebase-memory          本插件：依赖自举 + 把会话工作区钉死 + 给模型写使用说明
└─ ③ @deepseek-ai/dsh-mcp-client  官方 MCP 桥 → 模型只看到一个 mcp__cbm__mcp
      └─ ② @njuptlzf/mcp-adapter  token 压缩层：17 份 schema 压成 1 个代理工具（插件自举，钉死版本）
            └─ ① codebase-memory-mcp  索引引擎：162 语言 tree-sitter + Hybrid LSP + 知识图谱（手动安装）
```

四个都是既有件，**没有任何一个被 fork 或修改**。本插件只做三件事：自举②、给③配好清单、把①的入口按会话工作区钉死。

## 为什么需要它（这个插件存在的全部理由）

**DSH 是多会话宿主，而一个 MCP server 进程只有一个 cwd。**

codebase-memory-mcp 自带 `auto_index` / `auto_watch`，但它只能看见**自己那个进程的 cwd**。DSH 里所有会话共享同一个 MCP 进程——哪个会话的工作区该被索引？引擎自己无法回答。

所以 `repo_path` 只能由一个**活在 DSH 进程里、能读到会话头**的角色注入。这就是本插件：

```js
// index.js — 全插件唯一决定"索引什么"的地方
const cwd = exec.agent?.session?.header?.cwd
```

模型永远**拿不到也传不了** `repo_path`（`code_index` 没有这个参数，`index_repository` 从工具面剔除）——索引路径不可能被幻觉带偏，这是整个设计里最重要的一条约束。

## 安装

### ① 索引引擎（手动，一次性）

二进制不自动下载：可执行文件的安全水位高于包。官方脚本自带 checksums 校验：

```powershell
irm https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1 -OutFile install.ps1
Unblock-File .\install.ps1; .\install.ps1 --skip-config
```

装完后插件会按 官方安装位 → `$DSH_HOME/vendor/codebase-memory-mcp/bin` → PATH 的顺序探测；也可以用 `cbmPath` 配置指死。

### ② 把 bundle 挂进 profile（②③④全自动）

```powershell
git clone https://github.com/njuptlzf/dsh-codebase-memory
dsh plugin --profile <你的profile> add file:<clone 出来的绝对路径>
```

> **先确认目标 profile。** profile 是随 app 走的——桌面端跑自己的（官方桌面包叫 `tauri`），web 跑另一个（`web`）；桌面安装不认识的 profile 名会被直接拒绝。不确定就 `dsh --profile <name> --dump-config` 搜 `codebase-memory`。
>
> `dsh plugin` 的本质是在 profile 目录里跑 pnpm，随后**自动对账 `dsh.profile.bundles`——但仅在 pnpm 干净退出之后**：声明了 `dsh.bundle` 的依赖进层栈，被移除的出层栈。插件生效 = "文件在 node_modules 里 + 名字在 bundles 里"。
>
> CLI 的四个行为值得提前知道：
>
> - **`add .` 是坑**——相对路径按**调用目录**解析，在别的目录跑 `add .` 会静默链到那个目录。在 clone 的仓库目录里执行、或直接传绝对 `file:` 路径才是安全的。
> - **git 装法会触发构建**——pnpm 默认拦截 `prepare` 脚本：把它打印的那个键加进 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 再跑一遍。
> - **首次执行可能要几分钟**——插件多的 profile 里 pnpm 解析慢，是等待不是卡死。
> - **别在 Windows PowerShell 5.1 里带 stderr 重定向地脚本化调用**——启动 shim（`$ErrorActionPreference='Stop'`）会把任何一行 stderr（pnpm 进度、node 警告）升级成终止错误，死在 pnpm 启动之前：exit 1、日志空、状态半吊子。用交互终端（或 PowerShell 7）执行；之后刷新代码用插件自带的 sync 脚本。

### ③ 重启，然后验证

重启 profile 后对模型说一句：

```
跑一下 code_setup，把结果原样贴给我
```

看到 `status: OK`、`清单(⑤): ...cbm.json`（不是"(未写)"）即链路全通。压缩层②会在首次 boot 时自动 `npm install` 进 `$DSH_HOME/vendor/mcp-adapter`，无需干预。

## 怎么用

### 1. 先理解索引单位：一个会话工作区 = 一个 project

这是用好它的全部前提，**三句话**：

1. `code_index` 索引的**永远是当前会话的工作区**——工作区选到仓库根，该仓库就是一个独立 project；工作区选到多个仓库的上层目录，它们就**塌进同一个 project**。
2. project 名由路径推导（非字母数字换成 `-`，如 `D:/code/repo-a` → `D-code-repo-a`），但**以 `code_index` 返回的为准**。
3. 之后所有检索，`project` 是**唯一的**路由键——每个工具调用都必须带上它。插件不做、也做不了"猜你这次问的是哪个仓库"。

> ### ⚠ 工作区必须指向 **git 仓库本身**，不要用非 git 的父目录
>
> 这是唯一一个会**静默**拖垮一切的选择：cbm 的变更检测是**按 project** 的，而在多工作区宿主里"project 就是会话工作区"（引擎取的是 MCP 客户端的 cwd）。用父目录的实测后果：
>
> - 父目录不是 git 仓库 ⇒ `watcher.baseline … strategy=none` ⇒ **完全不轮询**（`watcher.changed` 从不触发）；
> - 子仓库**永远不会**被 watch：watch 只为"**创建 session-managed daemon 的那个客户端**"的 cwd 注册；只是**加入**已有 daemon 的客户端什么都注册不上（用一个长期存活、cwd 指向子仓库的客户端实测两次：`watcher.watch`/`baseline`/`changed`/`unwatch` = **0/0/0/0**）；
> - 而子仓库的符号仍留在**父目录那张图**里，于是 `get_code_snippet` 给出的是**陈旧坐标**，`index_status` 却一直报 `ready` —— 是**静默的错误答案**，不是报错。
>
> 选错的实测代价：真实仓库抽检 **59 个符号里 20 个**返回的区域不含该符号。修法：把**仓库根**作为工作区（它自成 project，watcher 会轮询它），或对该 project 显式刷新（`codebase-memory-mcp cli index_repository --repo-path <repo>`）。

```powershell
# 每个 project 一个库文件，索引全在这里（不进代码仓库，重产物归缓存）：
Get-ChildItem ~/.cache/codebase-memory-mcp -Filter *.db
```

实测参考量级（本机）：中型仓库（1,946 节点）首建 **约 30s**；刷新一次墙钟相近（**1000 文件 21s**、**300 文件 18s**）——但它**不是**全量重解析：节点 id 级实测，零改动刷新**什么都不动**（所有 id 与 `sqlite_sequence` 不变），只改 1 个文件时只重插该文件的节点（**19/19** 未改动文件 id 分毫不动）。墙钟主要花在每次运行的固定开销上，几乎不随文件数增长。单次检索 <100ms。

### 2. 标准动线

按**任务顺序**记，四步就够（与注入 prompt 的文案同构，两处改了要一起改）：

```
code_index（建索引 / 改完代码后刷新）→ 拿到 project
→ 定位   cbm_search_graph   → qualified_name 与 file+行号
→ 取原文 cbm_get_code_snippet（带 format:"json"，才是逐字节原文）
→ 验鲜   cbm_check_index_coverage（freshness=metadata_changed ⇒ 先 code_index 再动手）
→ 需要关系时 cbm_trace_path
```

检索一律走代理工具 `mcp__cbm__mcp`，`args` **直接传对象**：

```jsonc
{"tool": "cbm_search_graph", "args": {"project": "<project>", "query": "符号名", "limit": 10}}
{"tool": "cbm_get_code_snippet", "args": {"project": "<project>", "qualified_name": "<qn>", "format": "json"}}
{"tool": "cbm_check_index_coverage", "args": {"project": "<project>", "paths": ["apps/server/src/x.ts"]}}
{"tool": "cbm_trace_path", "args": {"project": "<project>", "function_name": "X", "direction": "callers"}}
```

> `format` 不带就是 `tree`——那是排版信封，会给每行贴固定前导空格，照抄当锚点必不匹配（详见[已知限制](#已知限制与不做)）。

多步查询用 `mcp__cbm__mcpScript` 一次跑完（实测两次 `search_graph` 合计 73ms），别拆成多次往返。

### 3. 话术清单（实测有效）

**能不能触发，取决于你问的问题是不是"图形的强项"。** 下面这些句式实测能把模型推向索引：

| 这样问 | 为什么灵 |
|---|---|
| 「**谁调用了** `X`？改它会影响哪些调用方？」 | `CALLS` 边直接答；grep 只能找到字符串出现处，不是调用 |
| 「`X` 的定义在哪、哪个行区间？」 | 精确区间，省掉整个文件的 Read |
| 「这个模块的**入口点 / 路由 / 包结构**有哪些？」 | `get_architecture` 一次给全景 |
| 「用索引查：先 `search_graph` 定位，再 `get_code_snippet` 读那段，**别 grep**」 | 点名步骤 + 关掉替代方案，触发率最高 |
| 「用 `project=<名>` 查」 | 直接给路由键，省掉摸索 |
| 「只在 `**/<仓库>/**` 里找」 | `file_pattern` 收窄，多仓库工作区必备 |
| 「把这几个符号的实现**一次**查回来」 | 逼它用 `mcpScript` 批量 |

反例——这样问**不会**也不该触发索引：「帮我看看这个文件」（Read 的甜区）、「这个报错什么意思」「这个配置值是多少」（字面量，`search_code`/grep 更对）。

怎么判断它**真的**走了索引：工具卡出现 `mcp__cbm__mcp`，回答里带 `qualified_name` + 精确行区间（`index.js 238-261`）；如果它直接贴了半屏文件原文，那就是 grep/Read。

### 4. 怎么写 AGENTS.md（一劳永逸）

提示词段只是路标，**跟仓库走的 AGENTS.md 才是常驻规则**。DSH 的 `dsh-agent-instructions` 会把工作区（及祖先链）里的 `AGENTS.md` / `CLAUDE.md` 在**首个请求前**注入为 baseline context——新开会话即生效，改完不用重启。放在仓库根、或所有会话共同的上层目录：

```markdown
## 代码分析走索引，不逐文件读

本工作区已建代码索引（dsh-codebase-memory）。分析代码前先按此路径走：

- 路由键是 `project`：值 = 本工作区对应的项目名（拿不准先跑 `code_index`，返回值即 project 名）。
- 定位符号：`mcp__cbm__mcp` → `cbm_search_graph`（args 直接传对象）。
- 读实现：`cbm_get_code_snippet` 只取那一段，别整文件 Read。
- 追关系：`cbm_trace_path`（谁调用/被调用）、`cbm_detect_changes`（改动影响面）。
- 多仓库工作区必须收窄：`file_pattern="**/<仓库>/**"`；同名符号用返回的 `qualified_name` 消歧。
- 多步查询用 `mcp__cbm__mcpScript` 一次跑完，别多次往返。
- 只有查字面量（字符串/配置值/日志文案）或索引明确没覆盖时，才用 grep/Read。
- **工作区要指向仓库本身**（非 git 的父目录永远不会被 watch）。
- 改完代码用 `code_index` 刷新（墙钟约 20–30s，主要是不随文件数增长的固定开销——它**不是**全量重解析）。
```

写 AGENTS.md 的三条经验：

1. **写规则，不写说明书**——「分析代码前先按此路径走」比「可以用索引」有效得多；模型默认走 grep 不是因为不知道，是因为没人禁止。
2. **给出口**——"只有 X 才用 grep"比"永远别 grep"更对，字面量检索确实是 grep 的活。
3. **把最大的坑写死**——project 名怎么拿、多仓库怎么收窄，这两条不写，模型试错一次就退回 grep。

## DSH 怎么找到它，模型又怎么开始用它

**被加载是 per-host 的，不是 per-workspace 的。** 一旦装进某个 profile，插件对**每个会话**都生效，与打开哪个仓库无关。把 git 仓库当工作区打开，改变的是**索引能不能保鲜**（watcher 终于轮询得到它——见 §1），不是插件是否被加载。

识别是**两侧各一个标记**，而且都不是 `systemPrompt`：

| 侧 | 标记 | 含义 |
|---|---|---|
| 本包 | `package.json` → `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，以及 `exports` 暴露 `index.js` 与 patch | "我是 DSH bundle，加载时打这个补丁" |
| profile | `~/.dsh/profiles/<p>/package.json` → ①`dependencies["dsh-codebase-memory"]` ②`dsh.profile.bundles[]` 里有这个名字 | ①文件在 `node_modules` 里 ②**这才是"启用"** |

`dsh plugin --profile <p> add file:<repo>` 一次写全这两处。之后开发循环是 `node scripts/sync.mjs` → **重启 host**（`cordis.yml` 在加载时按 bundle 列表组合；而 pnpm 把 `file:` 依赖当不可变对象——`sync.mjs` 就是为此存在）。

**采纳（让模型真的用 cbm 搜代码）**是另一个更弱的问题，三档杠杆，越靠后越硬：

1. **prompt 段（已接线）**：`inject: ['systemPrompt']` → `ctx.systemPrompt.section({ name: 'codebase-memory', order: 850, text: usageSection(state) })`，内容就是那 4 步动线（定位 → 取原文 `format:"json"` → 验鲜）＋"比逐文件 grep/read 省一个数量级 token"的论证。
2. **仓库自己的 `AGENTS.md`（推荐，零安装）**：按项目生效、可版本化、更贴近"这个仓库该怎么干活"。§4 有可复制模板，`ruankao-ai/AGENTS.md` 就是实际用例。
3. **`PreToolUse` 钩子（强制档，需额外装包）**：DSH 钩子匹配的是**模型看到的工具名**（`ctx.on("tools/pre-execute", … runPoint("PreToolUse", exec.name, …))`），所以能匹配 `grep|glob|read`，命中后可以"附加上下文"或"拦下并给理由"。这是唯一能**干涉**而不只是说服的一档，代价是环境改动：本机**两个 profile 都没装** `dsh-hooks-claude-code`（它的模块只在 DSH 安装树里，`.dsh-module-fallback` 又没有 `@deepseek-ai/*`），所以挂它 = 往 profile 装这个包 + 加进 `dsh.profile.bundles` + 给它一个 `configPath` 指向 `hooks.json` + 重启。只有在模型持续无视索引时才值得付。

## 引擎兼容性（codebase-memory-mcp 变了会怎样）

**本插件按"契约"依赖引擎，不按包版本**——它从不 import cbm，只 shell 它的二进制（单独安装、运行期才发现版本，`code_setup` 会打印）。所以上游升级**不会**在安装期报错，只可能在**使用期**坏在我们依赖的东西上：

```
1 二进制发现：PATH / 官方安装位 / vendor；--version
2 CLI：cli --quiet --json <tool>；config get|set；daemon start|stop|status；index_repository --repo-path
3 MCP 工具与形状：search_graph；get_code_snippet + format:"json"；
  check_index_coverage --paths → freshness / recommended_action；trace_path；list_projects；index_status
4 行为语义：watch 注册规则（只有创建者）、非 git 时 strategy=none、刷新的增量性、
  tree vs json 排版、CRLF→LF 归一
```

- **运行期守卫（插件内）**：`package.json → dsh.testedEngine` 是"我们实测通过哪个版本"的唯一事实源。`code_setup` 会打印 `引擎实测: 实测通过 <tested>；当前 <version>`，超出该范围时追加警告——**只警告，不 throw**。
- **定时 CI（`.github/workflows/upstream-compat.yml`）**：每周（+手动触发）问上游最新 release，与 `dsh.testedEngine` 比 minor；不一致时**钉版本**装那个 release（用 `CBM_DOWNLOAD_URL` 覆盖官方安装脚本的下载基址）并跑 `npm run check`（patch → plugin → chain → tokens），然后开/更新 issue，给出结论：✅ 兼容 ⇒ 只需把 `testedEngine` 升上去；❌ 失败 ⇒ 契约变了，插件需要改。
- **上游变更何时才需要发新插件版本？** 只有上面四条里哪条动了才需要。引擎内部改进（新语言、提速、新工具）**无需**发插件版本——用户自己 `codebase-memory-mcp update` 即可。CI 的作用就是告诉你这次属于哪一种。MCP adapter 是**另一条独立的升级轴**，仍然钉死在 `DEFAULT_ADAPTER_VERSION`。

## 配置（可选）

在 composition 里给 `codebase-memory` 行加 `config:`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `bootstrap` | `background` | `blocking` / `background` / `manual`（manual = 只探测不下载） |
| `adapterVersion` | `2.29.0-0.0.4` | 钉死；**唯一升级入口** |
| `adapterDir` | `$DSH_HOME/vendor/mcp-adapter` | 压缩层与 `cbm.json` 的落点 |
| `cbmPath` | 自动探测 | 留空则按 官方安装位 → vendor → PATH 探测 |
| `autoIndex` | `true` | 自举时把引擎的 `auto_index` 对齐到该值（先读后写，值相同不重复写）。**作用域警告**：它落在机器级共享的 `~/.cache/codebase-memory-mcp/_config.db`，同机所有 MCP client 共用——不想让本插件替你决定就设成 `false`。实测语义：只给**尚无索引**的项目在会话启动时补一次全量，**不刷新陈旧坐标**，所以它不是防漂移手段（防漂移仍是 `code_index` + `check_index_coverage`） |
| `sessionRefresh` | `true` | 会话启动（`agent/session-start`）时后台刷新**会话工作区**的索引，闸门为（git 状态变了）∧（该项目已索引过）∧（5 分钟冷却）。用来补引擎 watcher 在多工作区宿主下覆盖不到的洞——见[已知限制](#已知限制与不做)。设 `false` 关闭 |

## 验收

```powershell
npm run check   # = check:patch + check:plugin + check:chain + check:tokens
```

| 检查 | 证明什么 |
|---|---|
| `check-patch.mjs` | `cordis.patch.yml` 里 3 个 `!!js` 表达式按 Loader 原语义能求值，且指向真实文件；`DSH_HOME` 缺失时的回退同值 |
| `check-plugin.mjs` | 假 ctx 真实调用 `apply`/`code_index`/`code_setup`：链路就绪、工作区来自会话 cwd、不同工作区→不同 project、cbm 缺失时 throw 并给出安装命令 |
| `check-chain.mjs` | 真拉起 adapter → cbm 做 MCP 握手：代理工具就位、懒连接被唤醒、`search_graph` 返回真实行 |
| `check-tokens.mjs` | **消融臂**：直连 cbm vs 经代理的 `tools/list` 实际体积；代理不比直连小就 throw |

本机实测：

```
PATCH OK
20/20 臂通过（tauri + web 两个 profile）   PLUGIN OK
CHAIN OK（代理工具 mcp，cbm 15 工具被发现）
臂A 直连 cbm            : 17 工具, 17308 B ≈ 4327 tokens
臂B 代理·冷缓存         :  2 工具,  4278 B ≈ 1070 tokens  （省 4.0x）
臂C 代理·缓存含resources:  3 工具,  4871 B ≈ 1218 tokens  （省 3.6x）
```

> `check-plugin.mjs` 会对本仓库真建一次索引（project 落在 `~/.cache`，不在仓库里）。想只验某个 profile：`node checks/check-plugin.mjs <profile>`。

## 排错

| 症状 | 原因与处置 |
|---|---|
| 当前会话工具清单里没有 `code_index`/`code_setup`，但 `code_setup` 能调通 | 工具清单是**会话级快照**：新开的对话才看得到。"没列出"≠"没注册" |
| `code_setup` 报 `status: NOT READY` | 看它给的缺失项与安装命令，照做后再调一次（它会重试自举，不用重启） |
| `清单(⑤): (未写)` | bootstrap 在写 `cbm.json` 前抛错了——把 `error:` 行原样报给维护者 |
| 检索报 `ambiguous` + 候选列表 | 工作区里多个仓库有同名符号。用候选里的 `qualified_name`，或加 `file_pattern` 收窄 |
| 明明改了代码检索结果还是旧的 | **先查工作区选择**（§1）：若会话工作区是非 git 的父目录，则**根本没有任何 watch**，等多久都没用。否则，先说好消息——**会话活着时引擎确实会自愈**——会话会拉起 `session-managed` daemon（`codebase-memory-mcp daemon status` 可查），它的 **git watcher 会自己重索引**；在临时仓库实测，**未提交**的改动 **约 30 秒**就被感知。但要三个前提同时成立，而 DSH 里通常缺两个：① watcher 只认**服务进程 cwd 对应的那个 project**——`auto_watch` 是 *git* watcher，而我们的清单**没有设 `cwd`**，于是它盯的是宿主 cwd 而非会话工作区；② 那个根目录得真是 git 仓库（像 `C:\Users\kingdee\work` 就不是）；③ `lifecycle: "lazy"` 会让服务在 adapter 默认 **10 分钟**空闲后被回收（`idleTimeout` 默认 10，只有 `eager`/`lazy-keep-alive` 会归零），daemon 与 watcher 一起没——这就是索引能旧好几天的原因。所以：`check_index_coverage --paths` 负责发现，`code_index` 负责保证。`auto_index` 只管"从没索引过的项目" |
| 从片段里复制的锚点，`edit` 死活匹配不上 | 默认的 `tree` 渲染给每行贴了固定前导空格（`get_code_snippet` +2、`search_code --mode full` +8），照抄的文本不是文件字节。**调用时传 `format: "json"`**——它的 `source` 逐字节等于文件；或者锚点走 `read` |
| 片段返回的代码不是它声称的那个符号 | 行号来自索引、正文来自磁盘：文件在上次 `code_index` 之后行号漂移过，你拿到的就是**邻居**——却仍带着正确的 `name`/`source_mode`，**不报错**。用 `check_index_coverage --paths <文件>` 检出（`freshness = metadata_changed`），再 `code_index`；`index_status` 一直报 `ready`，看不出来 |
| 某个目录/文件死活搜不到 | 十有八九被 `.gitignore` 排除了（索引引擎尊重 gitignore + 默认跳过 `node_modules` 等）。`code_index` 返回里的 `excluded`/`not_indexed_files` 会列出原因 |
| 桌面端装了但没生效 | 大概率装错了 profile。`--dump-config` 里搜 `codebase-memory` 确认进没进组合 |
| `dsh plugin add .` 装出来的不是你的 clone | 相对路径按**调用目录**解析——在别的目录跑 `add .` 链的就是那个目录。回到仓库目录里执行，或传绝对路径 |
| `dsh plugin …` 秒退、日志为空 | Windows PowerShell 5.1 + stderr 重定向 + `$ErrorActionPreference='Stop'` 把 shim 在 pnpm 启动前打死。换交互终端（或 PowerShell 7）执行 |

## 工程备注（给要改它的人）

- **boot 绝不 throw**：依赖缺失只记进状态（`code_setup` 报），boot 抛错会炸掉整个 profile，爆炸半径太大。前提检查全部落在工具调用点——"前提不成立即 throw"。
- **Windows 三连坑**（都已绕开）：PATH 上的 `npm.cmd` 不能无 shell spawn → 探测 `npm-cli.js` 直跑；cbm 的 `.cmd` shim 同理 → 清单里写绝对 `.exe`；PowerShell 5.1 按 ANSI 读无 BOM 的中文 `.ps1` → 仓库脚本一律 `.mjs` 用 node 跑。
- **`ctx.subprocess.spawn` 的两条真实契约**（本版插件曾各栽一次，验收的假 ctx 现在照抄了它们）：
  1. `cwd` 必填——真实实现对 `spec.cwd.includes('\0')` 求值，`undefined` 直接 TypeError；
  2. `collected.stdout.readFrom(n)` 返回 `{ text, nextOffset, lossy }`，不是字符串。
- **改完代码必须 sync 再重启**：pnpm 对 `file:` 依赖按 lockfile 判定，内容变化不重拷贝。`node scripts/sync.mjs` 直拷到各 profile；不能用 `link:`（Node 按 realpath 解析，仓库路径下裸导入 `@deepseek-ai/*` 会加载失败）。运行中的 host 锁着 composition，sync 只拷有差异的文件。
- **验收必须能自证伪**：补强检查后，先对**未同步的旧代码**跑一遍——能复现线上同一条错误才算有牙，再修再绿。

## 已知限制与不做

- **要真实字节就向引擎要 `format: "json"`**（0.11.0 实测）。两个独立性质，本插件不渲染片段、在这里修不掉：
  1. *`tree` 是排版信封，不是源码*：默认渲染对**每一行**机械贴固定前导空格——`get_code_snippet` +2、`search_code --mode full` +8（偏移量随信封嵌套层数增长）。本来就顶格（col 0）的行和空行**照样**被贴，可见它是 `"  " + line` 而非 dedent/重排，照抄当锚点必不匹配；好在失败**很响**（`old_string was not found`），不可能静默改坏文件。**`format: "json"` 返回的是原文字节**：类方法（磁盘 `2/4/2` → json `2/4/2`，tree 却是 `4/6/4`）与顶层 interface（磁盘 `0` → json `0`，tree `2`）双格式对照通过，再从索引库直接枚举符号随机抽样、不经 `search_graph` 的 14/14 也全部逐字节相同。`get_code_snippet` 与 `search_code` 都支持。
  2. *坐标仍可能过期——这条才真危险*：`start_line`/`end_line` 取自索引、正文取自磁盘，所以未重新索引的改动之后，片段会**静默返回偏移过的、看着像真的但是错的区域**——`name` 和 `source_mode: full` 照旧、不报错。[上游 issue #1750](https://github.com/DeusData/codebase-memory-mcp/issues/1750) 记的就是它（仍 open）。`index_status` **看不出来**（一直报 `ready`），但 `check_index_coverage --paths <文件>` 能：`freshness = metadata_changed`、`recommended_action = read_source_and_reindex`——那是**信号**、不是修复。所以改完就 `code_index`，动手前用 `read` 取锚点。
  片段把 CRLF 归一成 LF **不算坑**：DSH 的 `edit` 是行尾感知的（LF 锚点能命中 CRLF 文件，写回时 CRLF 原样保留）。
- **会话启动刷新——为什么插件要做一件"引擎本来就有"的事。** 引擎的自动更新建立在三个本宿主不成立的假设上：被监视的 project 是**MCP 服务进程 cwd** 那一个（单一、静态），watcher 只认 **git**（其他情况日志里是 `watcher.baseline strategy=none`），且它只活在**客户端会话**期间（实测：即便跑着 permanent daemon，会话结束后改动 **165s 仍不被感知**）。DSH 是一个 server 进程服务多个工作区各异的会话，所以引擎结构上跟不住会话工作区——而坐标一陈旧，`get_code_snippet` 就会**静默返回邻居的代码却标着正确的符号名**（实测真实仓库 59 个符号里 20 个）。于是有了 `sessionRefresh`：会话启动时，只要 git 状态变了、该项目已索引过、且过了 5 分钟冷却，就后台刷一次。真触发时的代价：约 15–30s 后台 CPU（1000 文件仓库 ≈ 21s；ruankao-ai ≈ 28–30s——墙钟主要是每次运行的固定开销，不是解析量）；git 状态没变的会话只需几十毫秒跳过。诚实的缺口：`agent/session-start` 是 **detached**，会话最初几次查询仍可能与刷新竞态；会话**中途**被别的会话改动不管；非 git 工作区刻意跳过。
- **`lifecycle` 用 `keep-alive`，理由是启动竞态。** 服务在 extension load 时即连接（`init.ts:290-295`：只有 `keep-alive`/`eager` 进 `startupServers`），并打 keep-alive 标记、带健康检查重连。它规避两个毛病：普通 `lazy` 会在 adapter 默认 **10 分钟**空闲后被回收（`idleTimeout` 默认 10，只有 `eager`/`lazy-keep-alive` 会归零），一回收就把 cbm 的 session-managed daemon 与 watcher 一起带走；而 `lazy` 与 `lazy-keep-alive` 都是"**首次使用才连**"，于是 cbm 的 `auto_index` 与 watcher baseline 会与**第一次工具调用并发**——这正是 Claude Code 没有的启动竞态（它在会话启动时就连接已配置的 MCP server）。不用 `eager` 是因为它**没有自动重连**。**它不修的**：变更仍靠 git 轮询（实测 18–30s 才感知），且只覆盖"**服务进程 cwd**"那一个 project——会话中途的改动、别的工作区、非 git 根目录，仍归 `sessionRefresh` 与 `code_index` 管。代价：DSH host 启动即常驻一个 cbm 进程（实测约 17MB RSS）。
- **平台**：当前实现按 Windows 写死（`.exe` 探测、`USERPROFILE` 回退、npm-cli.js 候选）。Linux/macOS 用户欢迎提 PR 或 issue。
- **刷新是增量的——墙钟耗时主要花在固定开销上，而不是重解析。** 用节点 id 在临时 git 仓库上实测：**零改动**的 `code_index` **什么都不动**（每个节点 id 与 `sqlite_sequence` 完全一致）；**只改 1 个文件**时，只有**那个文件**的节点被换了 id——**19/19 未改动文件 id 分毫不动**。所以它并不是"每次重解析整个工作区"。你真正付的是每次运行的固定开销（进程启动、开库、变更检测）：1000 文件仓库约 21s、ruankao-ai 28–30s，而且几乎不随文件数增长（300 文件 ≈ 18s → 1000 文件 ≈ 21s）。**watcher** 是另一条代码路径：改 1 个文件后它还会把靠后的文件**重编号**（实测 `[18,53,54] → [18,54,55]`，而全局只多了 1 个 id），所以它的写入面比 CLI 路径宽。图新鲜度以你最后一次调用为准。
- 数据类文件不进索引：`.gitignore` 命中的目录（题库、sqlite、构建产物）本来就不该由**代码**索引来管。
- **不做**：移植 mcp-adapter、自研索引引擎、自写下载器、自建 watcher、把索引产物入库、索引状态侧栏 UI、跨项目智能路由（理由见[为什么需要它](#为什么需要它这个插件存在的全部理由)——工作区选择本来就是人的决定）。

## License

[MIT](LICENSE)
