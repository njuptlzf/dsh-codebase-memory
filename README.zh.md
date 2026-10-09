# dsh-codebase-memory

[English](README.md) | 简体中文

把 [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) 接进 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的 host bundle：**为当前会话的工作区建代码知识图谱，让模型按图检索代码，而不是逐文件 grep/read**。

## 目录

- [链路与分工](#链路与分工)
- [为什么需要它](#为什么需要它这个插件存在的全部理由)
- [安装](#安装)
- [怎么用](#怎么用)（含[话术清单](#3-话术清单实测有效)、[AGENTS.md 模板](#4-怎么写-agentsmd一劳永逸)与 [SKILL 随插件维护](#5-skill-随插件仓库维护)）
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

### ①b 可选：语义检索层（zvec-grep，默认关）

cbm 图谱**不做向量检索**（0.11.0 实测：`search_graph` 是 BM25/正则，`search_code` 是 graph-ranked text）。要"用自然语言搜代码/文档"就补一层 [zvec-grep](https://github.com/zvec-ai/zvec-grep)——插件把它接成第二个 MCP server，**默认关**，因为它 ~430MB：

```powershell
npm run install:zg          # 一次性：npm 安装并裁剪（删 transformers.js 不用的推理后端），430MB，约 3 分钟
# 然后在 profile 的 cordis.patch.yml 里给 codebase-memory 行的 config: 加 zgEnabled: true，重启宿主
```

开启后 `code_setup` 报表多出 `语义层(zg): ready`，清单（`cbm.json`）里注册 `zg` server（lifecycle `lazy`：首次使用才拉起本地守护进程，约 2.2s，之后热查询 1.4s），模型侧只暴露一个工具 **`zg_zvec_grep_search`**（`agent` 工具集——rg/索引/守护进程管理留在 CLI 侧；**注意代理工具名带 server 键前缀**，直连叫 `zvec_grep_search`，经代理必须叫 `zg_zvec_grep_search`）。调用**必须传 `root`**（工作区绝对路径），没有会报 `root: Invalid input`。索引产物落在被索引仓库的 `.zvec-grep/`（建议加进 gitignore——本仓库已经加了）。裁剪安全性有门禁：`install:zg` 末尾会 `--version` 自检；索引新鲜度复用脏台账链路——`dirtyTracking` 开着时，写文件后的后台补刷会连 `zg index` 一起跑（增量约 2s）。


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

看到 `status: OK`、`清单: ...cbm.json`（不是"(未写)"）即链路全通。压缩层②会在首次 boot 时自动 `npm install` 进 `$DSH_HOME/vendor/mcp-adapter`，无需干预。

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

高频的两个动作已经包成原生工具，**project 由插件从会话工作区填**，模型不用传路由键：

```
code_index（建索引 / 改完代码后刷新）
→ code_find("符号名")            → qualified_name + 文件 + 行区间 + 源码
→ code_callers("<qualified_name>") → 调用者（inbound，默认）/ 被调方（outbound），逐跳
→ 长尾走代理：cbm_check_index_coverage（验鲜）、cbm_query_graph（多跳）、
  cbm_get_architecture、cbm_detect_changes…
```

长尾仍走代理工具 `mcp__cbm__mcp`，`args` **直接传对象**：

```jsonc
{"tool": "cbm_check_index_coverage", "args": {"project": "<project>", "paths": ["apps/server/src/x.ts"]}}
{"tool": "cbm_get_code_snippet", "args": {"project": "<project>", "qualified_name": "<qn>", "format": "json"}}
{"tool": "cbm_query_graph", "args": {"project": "<project>", "cypher": "…"}}
```

> `format` 不带就是 `tree`——那是排版信封，会给每行贴固定前导空格，照抄当锚点必不匹配（详见[已知限制](#已知限制与不做)）。

多步查询用 `mcp__cbm__mcpScript` 一次跑完（实测两次 `search_graph` 合计 73ms），别拆成多次往返。

#### 触发层（该由插件负责的事，不该靠你话术）

"让模型用索引"是软约束，下面几层是**干预**。每层独立开关，钩子一律 `try/catch` + **fail-open**（证明不了索引可信就放行 grep）：

| 层 | 挂点 | 默认 | 做什么 |
|---|---|---|---|
| ① 封装工具 | `ctx.tools.register` | 开 | `code_find` / `code_callers`。schema 成本实测 **1651 字节 ≈ 每请求 413 tokens**，换来的是代理省下的 ~3200 tokens 不必被话术消耗 |
| ② 拦截 | `tools/pre-execute` | `off`（不拦） | `enforce: deny-once`/`deny` 时（开关在 **设置 → 插件 → dsh-codebase-memory → `codebase-memory` 行「配置」**，改完即时生效不用重启）：pattern 像**符号**的 grep，**同会话同符号只拦一次**，且 deny 的 `reason` 里已经带上 `search_graph` 命中——模型这一轮就拿到答案。代码图对这个符号**无命中时直接放行**：拦一条索引本来就没答案的搜索纯粹是挡路 |
| ②b 替换 | `tools/post-execute` | 关（`enforce: off`） | `enforce: replace` 时：符号形 grep **照常执行、照常成功**，但模型看到的输出被整体换成图谱命中（图谱无命中时轮到 zg 语义检索；两边都没有就保留原输出）。走宿主 post-execute 的 accept+content 替换通道（"accept keeps the call successful (replacing content when given)"），**不产生 isError**；pre-execute 改不了参数（宿主契约："Input rewriting is excluded"，实参 deepFreeze），所以替换只能后置。脏台账会话**不换**——拿可能过期的坐标替换就是骗人 |
| ⑤ 写后记账 | `tools/post-execute` + 会话写入台账 | 开 | 按会话记 `write`/`edit` 的路径（不逐文件建索引），并把**写过代码的会话当作过期**：拦截改为放行，`code_find`/`code_callers` 把结果标成 `stale` 且点名路径，同时调度带冷却的后台补刷。台账**只在补刷真的重建了索引之后**才清空——被闸门挡下等于什么都没做，这时清账就是撒谎。为什么用台账而不是引擎的逐路径结论：引擎 0.11.0 实测，**全量重索引之后**立刻查一个没改过的文件，仍返回 `freshness=metadata_changed` / `read_source_and_reindex`，与改过的完全一样——那是项目代际信号，不是逐路径过期信号。拿它当门的结果是拦截永久失效，外加每条被拦的 grep 调度一次约 20s 重索引。`check_index_coverage` 仍留在 prompt 里当人工证据，只是不再当钩子的门 |
| ③ 条件注入 | `systemPrompt.context`（order 130） | 开 | 只在上一条用户消息像"谁调用 / 定义在哪 / 重命名 / 影响范围"时注入一行：project + 新鲜度 + 用 code_find。其余轮次一个字符都不占 |

①②⑤ 走宿主**已连接**的代理链路（热了实测 29–64ms），刻意不 spawn `codebase-memory-mcp cli`——同一台机器上它单次 5.5–8.3s。

与宿主自带的 `dsh-repeat-tool-reminder` 分工不同：那个只看**参数完全相同的连续重复**（默认阈值 3/5/8），不评价该用哪个工具；层 ② 看的是 **pattern 形态**，不管重复，且 deny 走的是工具错误、不是 `additionalContexts`——通道也不同，互不重叠。（原 ④ 软提示与它共用那条通道，已于 2026-10-08 验收撤回。）

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

- 路由键是 `project`：`code_find` / `code_callers` 会由插件自动填，其余调用先跑 `code_index`，返回值即 project 名。
- 定位符号：`code_find("X")` 一次给 qualified_name + 文件 + 行区间 + 源码；长尾再走 `mcp__cbm__mcp` → `cbm_search_graph`（args 直接传对象）。
- 读实现：`cbm_get_code_snippet` 只取那一段，别整文件 Read。
- 追关系：`code_callers("<qualified_name>")`（默认 inbound=调用者）；分页与改动影响面用 `cbm_trace_path` / `cbm_detect_changes`。
- 多仓库工作区必须收窄：`file_pattern="**/<仓库>/**"`；同名符号用返回的 `qualified_name` 消歧。
- 多步查询用 `mcp__cbm__mcpScript` 一次跑完，别多次往返。
- 只有查字面量（字符串/配置值/日志文案）或索引明确没覆盖时，才用 grep/Read。
- **工作区要指向仓库本身**（非 git 的父目录永远不会被 watch）。
- 改完代码用 `code_index` 刷新（墙钟约 20–30s，主要是不随文件数增长的固定开销——它**不是**全量重解析）。
```

写 AGENTS.md 的三条经验：

1. **写规则，不写说明书**——「分析代码前先按此路径走」比「可以用索引」有效得多；模型默认走 grep 不是因为不知道，是因为没人禁止。（v0.3 起"没人禁止"这一条可以由插件自己执行：`enforce=deny-once`；默认 `off` 不拦——先让 telemetry 证明误拦率可接受再开。）
2. **给出口**——"只有 X 才用 grep"比"永远别 grep"更对，字面量检索确实是 grep 的活。
3. **把最大的坑写死**——project 名怎么拿、多仓库怎么收窄，这两条不写，模型试错一次就退回 grep。

### 5. SKILL 随插件仓库维护

本仓库把配套 SKILL 放在 `skills/` 下，和插件代码一起版本化：

- `skills/dsh-codebase-impact-analysis/SKILL.md`：改前影响、安全重命名、调用链/业务流程分析；细节规则在 `references/deep-rules.md` 按需加载。
- `skills/dsh-cbm-investigate/SKILL.md`：把 root-cause debugging 与影响分析编排起来；仓库内置 `references/investigation-core.md` 作为可移植精华版，因此不硬依赖本机是否另有全局 `investigate` skill。如果用户已经安装了更完整的 `investigate`，可以选择加载它，但这只是可选增强，不是前提。

`node scripts/sync.mjs` 除了同步插件运行时三件套，也会把 `skills/` 同步到 `$DSH_HOME/skills`。DSH 的 skill filesystem watcher 会发现新增/修改的 skill；插件运行时改动仍需重启 profile。这样做的目的不是省几个文件，而是避免**插件 prompt、README、SKILL 三者各说各话**：cbm 工具名、`code_index`、验鲜规则一旦变，改仓库即可同步到本地 skill。

如果想把 skill 做成“随包发现”而不是复制到用户根目录，可以把 `@deepseek-ai/dsh-skill-filesystem` 的 `bundledSkillDir` 指向已安装插件的 `skills/` 目录；当前默认开发流仍是复制到 `$DSH_HOME/skills`，因为 watcher 能热发现，不需要重启。

## DSH 怎么找到它，模型又怎么开始用它

**被加载是 per-host 的，不是 per-workspace 的。** 一旦装进某个 profile，插件对**每个会话**都生效，与打开哪个仓库无关。把 git 仓库当工作区打开，改变的是**索引能不能保鲜**（watcher 终于轮询得到它——见 §1），不是插件是否被加载。

识别是**两侧各一个标记**，而且都不是 `systemPrompt`：

| 侧 | 标记 | 含义 |
|---|---|---|
| 本包 | `package.json` → `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，以及 `exports` 暴露 `index.js` 与 patch | "我是 DSH bundle，加载时打这个补丁" |
| profile | `~/.dsh/profiles/<p>/package.json` → ①`dependencies["dsh-codebase-memory"]` ②`dsh.profile.bundles[]` 里有这个名字 | ①文件在 `node_modules` 里 ②**这才是"启用"** |

`dsh plugin --profile <p> add file:<repo>` 一次写全这两处。之后开发循环是 `node scripts/sync.mjs` → **重启 host**（`cordis.yml` 在加载时按 bundle 列表组合；而 pnpm 把 `file:` 依赖当不可变对象——`sync.mjs` 就是为此存在）。**`code_setup` 会替你把漂移报出来**：拷贝与仓库一致时显示 `同步状态: 一致`，不一致时给一行 ⚠ 并点名三个运行时文件（`index.js` / `cordis.patch.yml` / `package.json`）里到底哪个不同。它覆盖"改了仓库忘了 sync"；**测不出**"sync 了但没重启"——运行中的代码没有对自己加载字节的哈希。

**采纳（让模型真的用 cbm 搜代码）**以前是个更弱的问题，因为手里只有"劝"这一件工具。v0.3 起本插件自己就有"干涉"能力，而且走**原生订阅**——不装桥接包、不写 `hooks.json`、不改 profile 的 bundle 列表，只改这个 bundle 的 config 行：

1. **prompt 段（仍在）**：`inject: ['systemPrompt']` → `ctx.systemPrompt.section({ name: 'codebase-memory', order: 850, text: usageSection(state) })`。内容只留常驻不变的部分（长尾动线与两个坑），并且**有预算**：断言 ≤1150 字符，实测 863。
2. **仓库自己的 `AGENTS.md`（推荐，零安装）**：按项目生效、可版本化、更贴近"这个仓库该怎么干活"。§4 有可复制模板，`ruankao-ai/AGENTS.md` 就是实际用例。
3. **触发层**（[docs/design-v2.md](docs/design-v2.md)）：封装工具 ①、拦截 ②、条件注入 ③、软提示 ④、写后验鲜 ⑤——见[触发层](#触发层该由插件负责的事不该靠你话术)。

为什么用原生订阅而不是官方桥接包：`dsh-hooks-claude-code` 在本机**任何 profile 都没装**（模块只在 DSH 安装树里，`.dsh-module-fallback` 不带 `@deepseek-ai/*`），挂它 = 装包 + 加 bundle 行 + 写 `hooks.json` + 重启；而外部 shell 钩子按生态自己的说法"能观察、能否决，但没法把文本交回模型"。在插件内部我们既能 deny，又能把**答案本身**写进 deny 的 reason，还能读到 project、索引新鲜度与本会话脏路径——这些正是钩子成立的前提。

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

改配置有两条路。**设置 → 插件 → dsh-codebase-memory → `codebase-memory` 行 → 「配置」** 管三个热字段（`enforce`、`telemetry`、`interceptBudgetMs`——页面上只画了前两个，budget 仍要手改配置文件），**不用重启就生效**：宿主把新值推进拦截钩子正在读的那个 volatile 引用，所以会话中途把 `off` 翻成 `deny-once`，下一条 grep 就按新模式判定。其余字段照旧写在 composition 的 `codebase-memory` 行的 `config:` 里（**要重启**：配置文档在 boot 时组合）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `bootstrap` | `background` | `blocking` / `background` / `manual`（manual = 只探测不下载） |
| `adapterVersion` | `2.29.0-0.0.4` | 钉死；**唯一升级入口** |
| `adapterDir` | `$DSH_HOME/vendor/mcp-adapter` | 压缩层与 `cbm.json` 的落点 |
| `cbmPath` | 自动探测 | 留空则按 官方安装位 → vendor → PATH 探测 |
| `autoIndex` | `true` | 自举时把引擎的 `auto_index` 对齐到该值（先读后写，值相同不重复写）。**作用域警告**：它落在机器级共享的 `~/.cache/codebase-memory-mcp/_config.db`，同机所有 MCP client 共用——不想让本插件替你决定就设成 `false`。实测语义：只给**尚无索引**的项目在会话启动时补一次全量，**不刷新陈旧坐标**，所以它不是防漂移手段（防漂移仍是 `code_index` + `check_index_coverage`） |
| `sessionRefresh` | `true` | 会话启动（`agent/session-start`）时后台刷新**会话工作区**的索引，闸门为（git 状态变了）∧（该项目已索引过）∧（5 分钟冷却）。用来补引擎 watcher 在多工作区宿主下覆盖不到的洞——见[已知限制](#已知限制与不做)。设 `false` 关闭 |
| `wrapperTools` | `true` | 层 ①：注册 `code_find` / `code_callers`。设 `false` 只剩代理工具 |
| `enforce` | `off` | **热改**（设置页）。层 ②/②b：`off` / `deny-once`（符号类 grep 每会话每符号拒一次）/ `deny`（每次都拒）/ `replace`（grep 照常跑，模型看到的输出换成图谱/语义命中，不出错误）。**replace 是"硬替换"的正经档位**：不跟模型打"先查索引"的嘴仗，直接把结果摆它面前。要升 `deny` 先拿遥测证明误拦率可接受。（原 `advise`——post-execute 软提示注入——已于 2026-10-08 撤回；旧配置写 `advise` 会回落到 `off` 并在报表里提示） |
| `interceptTools` | `grep,glob` | 逗号分隔的内置工具名（裸名小写；`glob` 的 pattern 基本不会被判成符号） |
| `interceptBudgetMs` | `2500` | **热改**（ volatile，但设置页没画它，只能改配置文件）。钩子里 cbm 查询的时间预算。实测热链路 29–34ms，这个数是为冷连接留余量；**超预算就放行 grep** |
| `contextHint` | `true` | 层 ③：按 query 条件注入一行 `systemPrompt.context`。极简 agent 预设会整块压制 runtime-context，那时它不送达（①②⑤ 不受影响） |
| `dirtyTracking` | `true` | 层 ⑤：按会话记 `write`/`edit` 路径。**台账本身就是过期信号**（见触发层 ⑤——引擎那个逐路径结论并不是，理由见下表 ⑤ 行）；只有 `code_index`，或**真的跑完的**后台补刷，才会清空它 |
| `dirtyRefreshCooldownSec` | `120` | 脏路径触发的后台补刷冷却（复用 `sessionRefresh` 那条带闸门的链路，同回合多次写入自然并成一次） |
| `zgEnabled` | `false` | 语义检索层（①b）。`true` 时清单多注册一个 `zg` server（lifecycle `lazy`），prompt 多三行工具路由。**要重启**：`cbm.json` 在适配层进程启动时才读，热改无意义——所以它（连 `zgToolset`/`zgVendorDir`）**刻意不标 volatile**，设置页画了反而是说谎。前置：`npm run install:zg` 已跑过，否则报表 `语义层(zg): missing` 并提示补跑 |
| `zgToolset` | `agent` | 传给 `zg server --mcp-toolset` 的工具集：`agent`（只露 `zvec_grep_search`，索引检索一条）/ `full`（另露受管 rg 直通与 4 个索引/状态工具——一般不必给模型） |
| `zgVendorDir` | `$DSH_HOME/vendor/zvec-grep` | `install:zg` 的落点；CLI 路径 = `<该目录>/node_modules/@zvec/zvec-grep/dist/cli/index.js` |
| `telemetry` | `true` | **热改**（设置页）。每次拦截 / 放行 / 记账 / 补刷写一行 JSON 到 `$DSH_HOME/vendor/mcp-adapter/telemetry.log`，并在 `code_setup` 里给出计数。要不要升 `deny-once`，靠这个数据拍 |

回滚按杠杆来：`{"enforce":"off","contextHint":false,"dirtyTracking":false,"wrapperTools":false}` 就退回 v0.2 的行为，新开会话即生效。

**为什么页面是一段自己写的代码。** DSH 的设置服务只暴露 schema 里标了 `.volatile()` 的字段，而且**明确不替它们生成页面**（`@deepseek-ai/dsh-settings` README：“Each form reports `autoGenerate` … **no shipped client does so yet**”）。所以可改的三个字段在 `Config` 里标 volatile，`lib/client.js` —— 一段手写的 `__ModuleLoader__` bundle，没有构建步骤，形状照官方 `dsh-client-ui-settings-agent-loop` —— 把它注册进 `plugins.row.config` 槽，key 是 `<包名>#<row id>`。写入走宿主自己的 `ctx.configForms`/`remote.settings` 通道，落盘位置就是 profile 的 `cordis.patch.yml`。两个后果值得知道，因为它决定了以后能不能往页面上加字段：**没标 volatile 的字段结构上就看不见**（`describe()` 直接跳过没有任何 volatile 字段的条目——这就是当初那个开关"设置里找不到"的原因）；**标了 volatile 的字段必须在决策点用 `.get()` 读**，在 `apply` 里取快照会让页面变成谎言。`lib/client.js` 在 `RUNTIME_FILES` 里，所以客户端副本过期会和 `index.js` 过期一样被 `code_setup` 报出来。

## 验收

```powershell
npm run check   # = check:patch + check:client + check:plugin + check:chain + check:tokens
```

| 检查 | 证明什么 |
|---|---|
| `check-patch.mjs` | `cordis.patch.yml` 里 3 个 `!!js` 表达式按 Loader 原语义能求值，且指向真实文件；`DSH_HOME` 缺失时的回退同值 |
| `check-client.mjs` | 不开浏览器也验设置页：在 `node:vm` 里用桩 `__ModuleLoader__` / react / primitives / ctx 加载 `lib/client.js`，断言 package.json 里 `dsh.client`、`exports["./client"]`、`files` 三处声明齐全，**槽 key = `<包名>#<row id>` 是从 `cordis.patch.yml` 反解出来的**（改行 id 忘了改 key，按钮就不出现，而且 GUI 一声不响），served namespace 等于宿主 entry id，`require` 的名字全在宿主 baseline 内（名字打错同样是不出现，不是报错），中英词典覆盖 `ENFORCE_MODES` 的每个模式，五种快照态（ready / writable:false / loading / unavailable / summary）渲染正确，点一下真的落到 `form.set('enforce', …)` / `form.unset(…)` |
| `check-plugin.mjs` | 假 ctx（镜像真实服务的前提校验，含 `tools.execute` 与 `systemPrompt.section/context`）真实跑 `apply` 与**每一条触发层**：链路就绪、工作区来自会话 cwd、不同工作区→不同 project、cbm 缺失时 throw 并给出安装命令；`classifyPattern` 用 12 个符号类 + 21 个字面量类正反例证伪（**误拦必须为 0**）；`deny-once` 拦一次后放行；超预算 / 未索引 / 坐标过期一律 **fail-open**；post-execute 不再追加任何上下文（advise 注入已撤回，臂 G7 断言的就是这一点）；脏路径惰性记账且工作区外不入集合；条件注入命中给一行、不命中给 `""`；**臂 Z**：默认清单**不含** `zg`、prompt 不含 zvec 路由，`zgEnabled` 后临时清单里 `zg` 以 `lazy` 注册且 prompt 出现 `zg_zvec_grep_search`，vendor 缺失只报表提示 `install:zg`（**绝不自动装**——430MB 是人的决定），非法 `zgToolset` 回落 `agent` 并留 note；**臂 R**（`enforce=replace`）：符号形 grep 照常执行成功、模型看到的输出被整体换成图谱命中（无 `additionalContexts`、查询走代理不 spawn CLI），字面量 / 失败结果 / 图谱语义都无命中 / 脏台账会话一律**原样放行**，volatile 开关热翻立即开合替换通道，报表计数 `intercept-replace` 可见；**热改契约**：三个可改字段确实标了 volatile（且没有多余字段被标——标错等于把需要重启的东西伪装成热改），拦截钩子在 `enforce: off` 时**照样注册但直接放行**，把 volatile 引用在已挂载的插件上从 `off` 翻到 `deny` 再翻回来，判定立刻跟着变 |
| `check-chain.mjs` | 真拉起 adapter → cbm 做 MCP 握手：代理工具就位、懒连接被唤醒、`search_graph` 返回真实行、**阶段 3.5 实测钩子的时间预算**，最后 `describe` 出 prompt 承诺的参数形状 |
| `check-tokens.mjs` | **消融臂**：直连 cbm vs 经代理的 `tools/list` 实际体积；代理不比直连小就 throw |

本机实测：

```
PATCH OK
174/174 臂通过（tauri + web 两个 profile）   PLUGIN OK
CHAIN OK — 阶段3.5 代理链路延迟 ms: min=28 中位=32 max=34；配了 zg 的临时清单另跑 阶段2b：桥接 + 语义检索返回真实结果
臂A 直连 cbm            : 17 工具, 17308 B ≈ 4327 tokens
臂B 代理·冷缓存         :  2 工具,  4278 B ≈ 1070 tokens  （省 4.0x）
臂C 代理·缓存含resources:  3 工具,  4871 B ≈ 1218 tokens  （省 3.6x）
封装工具 schema（code_find + code_callers）: 1651 B ≈ 413 tokens  ← 层 ① 的代价
cbm CLI 同一台机器单次 search_graph        : 5491 / 6526 / 8280 ms  ← 钩子里绝不 spawn 它的原因
```

> `check-plugin.mjs` 会对本仓库真建一次索引（project 落在 `~/.cache`，不在仓库里）。想只验某个 profile：`node checks/check-plugin.mjs <profile>`。

## 排错

| 症状 | 原因与处置 |
|---|---|
| `zg_zvec_grep_search` 报 `root: Invalid input: expected string` | `root` 是**必填**——工作区绝对路径（守护进程可见的那个）。代理不替模型填参数：让模型用它已知的会话工作目录传入即可 |
| 模型调 `zvec_grep_search` 报 tool_not_found | 代理把 MCP 工具名**按 mcpServers 键加前缀**：经本插件的清单它叫 `zg_zvec_grep_search`（zg 直连才叫裸名）。usage prompt 已给对名字——看到裸名说明会话里是旧 bundle，`npm run sync` + 重启 |
| 某次 grep 返回 `Error: dsh-codebase-memory：…` | 这是层 ② 的**拦截**，不是故障：默认 `enforce=off` 根本不拦，只有你显式设成 `deny-once`/`deny` 才会出现；`deny-once` 对同一会话同一符号**只拦一次**，reason 里已带 `search_graph` 命中。想彻底关掉：设置页一键，或 `{"enforce":"off"}` |
| grep 的"结果"变成几行索引命中、没有文件内容 | 不是故障：`enforce=replace`（层 ②b）把符号形 grep 的模型可见输出换成了图谱/语义命中，调用本身照常成功、不出错误。想回到原始输出：设置页把 enforce 翻回 `off`，即时生效。本会话台账脏（刚写过代码）时替换会自动让路，这时又是原输出——两种都正常 |
| 设置页改了 `enforce`，但 grep 照样不被拦 | 先分清是"没生效"还是"合法放行"。`code_setup` 触发层那行现在报的是**实时值**，跟着设置页变就说明钩子每次调用都在重读配置（报表跟着变本身就是证据）。仍不拦的三种合法情形：pattern 被分成**字面量**（层 ② 只拦符号形）、代码图对该符号**无命中**、当前会话没有可绑定的工作区（cwd 不是路径，比如远程会话）。要确认钩子有没有跑，看 `telemetry.log` 里的 `intercept-*` 行 |
| `codebase-memory` 行**没有「配置」按钮**（设置 → 插件） | 按钮由 `lib/client.js` 注册，且三个条件同时成立才出现——**每一个失败都不报错**，所以这条单独列出：① 宿主只有在 `describe()` 发现该 entry 有 volatile 字段时才 serve 命名空间，装进去的 `index.js` 若没有 `.volatile()` 就没有按钮（`node scripts/sync.mjs` 后重启）；② 槽 key 必须严格等于 `<包名>#<row id>`（本包是 `dsh-codebase-memory#codebase-memory`），只改 `cordis.patch.yml` 的行 id 不改 key，按钮就消失——所以 `npm run check:client` 从 patch 反解 key，不信 bundle 里的常量；③ bundle 必须是开着的（`@deepseek-ai/dsh-client-ui-plugin-manager` README：“The bundle's patch must declare the row under that id, and the registration exists while the bundle is on”）。客户端副本装歪会被 `code_setup` 的 `fileDrift` 报出来（`lib/client.js` 在 `RUNTIME_FILES` 里），但它不会告诉你按钮不见了。**页面上没有的字段**（`wrapperTools`/`interceptTools`/`contextHint`/`dirtyTracking`/`sessionRefresh`/`autoIndex`/`bootstrap`/`zgEnabled`/`zgToolset`/`zgVendorDir`）仍是 composition 级：改 patch，重启宿主 |
| `code_find` 提示"坐标很可能已过期" | 层 ⑤ 的自检生效了：返回的源码里没有那个符号名（上游 issue #1750 的静默错位）。跑一次 `code_index`；插件已经在后台补刷，但**别在补刷完成前信这些行号** |
| 当前会话工具清单里没有 `code_index`/`code_setup`，但 `code_setup` 能调通 | 工具清单是**会话级快照**：新开的对话才看得到。"没列出"≠"没注册" |
| `code_setup` 报 `status: NOT READY` | 看它给的缺失项与安装命令，照做后再调一次（它会重试自举，不用重启） |
| `清单: (未写)` | bootstrap 在写 `cbm.json` 前抛错了——把 `error:` 行原样报给维护者 |
| 检索报 `ambiguous` + 候选列表 | 工作区里多个仓库有同名符号。用候选里的 `qualified_name`，或加 `file_pattern` 收窄 |
| 明明改了代码检索结果还是旧的 | **先查工作区选择**（§1）：若会话工作区是非 git 的父目录，则**根本没有任何 watch**，等多久都没用。否则，先说好消息——**会话活着时引擎确实会自愈**——会话会拉起 `session-managed` daemon（`codebase-memory-mcp daemon status` 可查），它的 **git watcher 会自己重索引**；在临时仓库实测，**未提交**的改动 **约 30 秒**就被感知。但要三个前提同时成立，而 DSH 里通常缺两个：① watcher 只认**服务进程 cwd 对应的那个 project**——`auto_watch` 是 *git* watcher，而我们的清单**没有设 `cwd`**，于是它盯的是宿主 cwd 而非会话工作区；② 那个根目录得真是 git 仓库（像 `C:\Users\kingdee\work` 就不是）；③ `lifecycle: "lazy"` 会让服务在 adapter 默认 **10 分钟**空闲后被回收（`idleTimeout` 默认 10，只有 `eager`/`lazy-keep-alive` 会归零），daemon 与 watcher 一起没——这就是索引能旧好几天的原因。所以：`check_index_coverage --paths` 负责发现，`code_index` 负责保证。`auto_index` 只管"从没索引过的项目" |
| 从片段里复制的锚点，`edit` 死活匹配不上 | 默认的 `tree` 渲染给每行贴了固定前导空格（`get_code_snippet` +2、`search_code --mode full` +8），照抄的文本不是文件字节。**调用时传 `format: "json"`**——它的 `source` 逐字节等于文件；或者锚点走 `read` |
| 片段返回的代码不是它声称的那个符号 | 行号来自索引、正文来自磁盘：文件在上次 `code_index` 之后行号漂移过，你拿到的就是**邻居**——却仍带着正确的 `name`/`source_mode`，**不报错**。用 `check_index_coverage --paths <文件>` 检出（`freshness = metadata_changed`），再 `code_index`；`index_status` 一直报 `ready`，看不出来 |
| 某个目录/文件死活搜不到 | 十有八九被 `.gitignore` 排除了（索引引擎尊重 gitignore + 默认跳过 `node_modules` 等）。`code_index` 返回里的 `excluded`/`not_indexed_files` 会列出原因 |
| 桌面端装了但没生效 | 大概率装错了 profile。`--dump-config` 里搜 `codebase-memory` 确认进没进组合 |
| `dsh plugin add .` 装出来的不是你的 clone | 相对路径按**调用目录**解析——在别的目录跑 `add .` 链的就是那个目录。回到仓库目录里执行，或传绝对路径 |
| `dsh plugin …` 秒退、日志为空 | Windows PowerShell 5.1 + stderr 重定向 + `$ErrorActionPreference='Stop'` 把 shim 在 pnpm 启动前打死。换交互终端（或 PowerShell 7）执行 |

## 工程备注（给要改它的人）

- **boot 绝不 throw**：依赖缺失只记进状态（`code_setup` 报），boot 抛错会炸掉整个 profile，爆炸半径太大。前提检查全部落在工具调用点——"前提不成立即 throw"。钩子里同理：每个 listener 都 `try/catch` 且任何可疑情况 `return next()`，因为 pre-execute 里抛错等于把那次工具调用打成失败。
- **同一工作区一次只跑一个索引任务，被中止就重试一次。** 同一仓库并发跑两次 `index_repository` 不会都活：引擎杀掉一个，退出码 1 + `status:"aborted_previous_preserved"`（它自己的 hint 就写着 "Retry"）。正常用法就能撞上——层 ⑤ 的后台补刷、`code_index`、引擎 watcher 都可能同时要动同一个工作区。所以两条路都过"按 cwd 排队"的在飞锁，被中止的那次重试一次并**记账**（遥测 `index-retry-contention`）。`check-plugin.mjs` 臂 G9 在假 subprocess 层复刻这条中止——只在生产环境才触发的修复，等于没人验证的修复。
- **触发层依赖的宿主契约**（对着本机装的 `0.1.5-rc.2` dist 逐条核过：`dsh-tool-cordis` 带完整事件/服务目录，`dsh-tools`、`dsh-system-prompt` 是实现；假 ctx 也照抄了这些形状）：
  - `tools/pre-execute`：waterfall `(exec, next) → PreToolDecision`。`deny` 短路所有 guard，其 `reason` 是模型唯一看到的输出（`Error: <reason>` + `isError`）；**被拒的调用仍会走 post-execute**（只跑写入记账）。
  - `tools/post-execute`：`(exec, result, next) → accept | block`；`additionalContexts: UserMessage[]` 是官方"给下一个请求附上下文"的通道——插件**已不再用它**（advise 软提示注入于 2026-10-08 撤回），post-execute 只记账，原样透传 `next()` 的决策。
  - **`ctx.tools.execute(input)` 是公开方法**（`tools` 服务方法表里有）。①② 能用起来的前提就是它：走 keep-alive 长连接（实测 29–64ms），不 spawn CLI（5.5–8.3s）。入参 `{callId, name, arguments, agent?, signal}`。
  - `systemPrompt.context({name, order, text})`：`text` 必须是**字符串或同步函数**（异步/`undefined` 触发装配不变量），返回 `""` 才是"本轮不注入"；contexts 不进提示词，而是投影成一条 user 角色的 runtime-context 快照，`suppressRuntimeContext()`（极简预设）会**全量**丢掉它。
  - 提示词文本走严格的 `{{variable}}` 插值，任何引擎/用户来源文本都不能凑成合法的未注册变量（`noVars` 兜一层）。
  - 本宿主**同时**有 `agent/created` 与 `agent/session-start`（后者由 `dsh-agent-loop` 在首个回合前 emit，带 `source`），且 `agent.inject(message)` 才是会话开始时喂模型可见上下文的正路——方案里"会话开始事件不可注入"只对 emit 的返回值成立。
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
