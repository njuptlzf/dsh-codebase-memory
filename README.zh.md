# dsh-codebase-memory

[English](README.md) | 简体中文

把 [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) 接进 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的 host bundle：**为当前会话的工作区建代码知识图谱，让模型按图检索代码，而不是逐文件 grep/read**。

## 目录

- [链路与分工](#链路与分工)
- [为什么需要它](#为什么需要它这个插件存在的全部理由)
- [安装](#安装)
- [怎么用](#怎么用)（含[话术清单](#3-话术清单实测有效)与 [AGENTS.md 模板](#4-怎么写-agentsmd一劳永逸)）
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

```powershell
# 每个 project 一个库文件，索引全在这里（不进代码仓库，重产物归缓存）：
Get-ChildItem ~/.cache/codebase-memory-mcp -Filter *.db
```

实测参考量级（本机，普通笔记本）：中型 TS 仓库（~700 文件）首建 10-13s、图 1700 节点上下；刷新一次约 8s（引擎是全量重解析，不是增量）；单次检索 <100ms。

### 2. 标准动线

```
code_index（建索引 / 改完代码后刷新）→ 拿到 project
→ cbm_search_graph 定位符号 → cbm_get_code_snippet 读那一段
→ 需要关系时 cbm_trace_path / cbm_detect_changes
```

检索一律走代理工具 `mcp__cbm__mcp`，`args` **直接传对象**（不需要 JSON 字符串）：

```jsonc
{"tool": "cbm_search_graph", "args": {"project": "<project>", "query": "符号名", "limit": 10}}
{"tool": "cbm_get_code_snippet", "args": {"project": "<project>", "qualified_name": "<search_graph 给的 qn>"}}
{"tool": "cbm_trace_path", "args": {"project": "<project>", "function_name": "X", "direction": "callers"}}
```

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
- 改完代码用 `code_index` 刷新（全量重解析，约 8 秒，值得等）。
```

写 AGENTS.md 的三条经验：

1. **写规则，不写说明书**——「分析代码前先按此路径走」比「可以用索引」有效得多；模型默认走 grep 不是因为不知道，是因为没人禁止。
2. **给出口**——"只有 X 才用 grep"比"永远别 grep"更对，字面量检索确实是 grep 的活。
3. **把最大的坑写死**——project 名怎么拿、多仓库怎么收窄，这两条不写，模型试错一次就退回 grep。

## 配置（可选）

在 composition 里给 `codebase-memory` 行加 `config:`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `bootstrap` | `background` | `blocking` / `background` / `manual`（manual = 只探测不下载） |
| `adapterVersion` | `2.29.0-0.0.4` | 钉死；**唯一升级入口** |
| `adapterDir` | `$DSH_HOME/vendor/mcp-adapter` | 压缩层与 `cbm.json` 的落点 |
| `cbmPath` | 自动探测 | 留空则按 官方安装位 → vendor → PATH 探测 |

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
| 明明改了代码检索结果还是旧的 | `code_index` 刷一次（约 8s）。MCP 模式下 daemon 也会 watch，但**动手前刷一次最便宜** |
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

- **平台**：当前实现按 Windows 写死（`.exe` 探测、`USERPROFILE` 回退、npm-cli.js 候选）。Linux/macOS 用户欢迎提 PR 或 issue。
- **刷新是全量的**：`code_index` 每次重解析整个工作区（中型仓库约 8s）。图新鲜度以你最后一次调用为准。
- 数据类文件不进索引：`.gitignore` 命中的目录（题库、sqlite、构建产物）本来就不该由**代码**索引来管。
- **不做**：移植 mcp-adapter、自研索引引擎、自写下载器、自建 watcher、把索引产物入库、索引状态侧栏 UI、跨项目智能路由（理由见[为什么需要它](#为什么需要它这个插件存在的全部理由)——工作区选择本来就是人的决定）。

## License

[MIT](LICENSE)
