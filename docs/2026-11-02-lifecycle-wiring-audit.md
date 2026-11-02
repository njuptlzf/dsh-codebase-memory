# 生命周期接线审计：为什么"自动更新"从未在生产发生

- 日期：2026-11-02
- 版本：dsh-codebase-memory v0.22.0（审计对象）；DSH 宿主为 `dsh-tauri` 内置运行时
- 状态：审计完成；P20 修复方案已定、**未落码**
- 关联：[2026-11-01-tool-hit-rate.md](./2026-11-01-tool-hit-rate.md)（P0-5 第四态 behind 即本次审计的触发点）

## 0. 结论（TL;DR）

1. **通道①是死代码。** 插件在 `index.js:1832` 注册的是 `ctx.on('agent/session-start', …)`，而 DSH 宿主**从不发出这个事件**——整个安装树里唯一出现 `agent/session-start` 的地方就是插件自己。所谓"会话启动补偿刷新"在生产环境一次都没跑过，`refresh.log` 的实证与此吻合。
2. **真正的会话起点是 `agent/created`。** 宿主在 `dsh-agent/lib/index.js:581` 经 `ctx.serial(entry.carrier, "agent/created", {agent, source, signal})` 广播，`source ∈ fresh | resume | clear | compaction`。插件从没订阅过它。
3. **第二条自动通道先天狭窄。** `scheduleDirtyRefresh`（`index.js:1677-1695`）只认"本会话 write/edit 过的文件"，shell 编辑、其他会话、编辑器、`git pull` 全在视野外；本条会话 `dirty=0`，所以通道②也不会触发。两条通道同时失效，用户看到的就是"重启了，分析还是旧的"。
4. **dsh-ops 之所以"完美贴合"，只是因为它只挂真实存在的事件。** 它用 `agent/created` / `agent/disposed` / `agent/pre-step` / `session/event` / `system-prompt/assemble` / `tools/pre-execute` / `llm/stream`，每个 agent 一份 entry，cwd 在调用时从 `session.header.cwd` 现取（`dsh-ops/lib/session-shells.js:70-110`），从不假设"进程 cwd = 会话工作区"。没有任何特权。
5. **184/184 全绿给出了假信心。** 验收替身 `makeCtx` 只把监听器按事件名收进一个对象，测试再手工调用 `events['agent/session-start'][0](…)`（`checks/check-plugin.mjs` 臂 G2b）——事件名写错也照样绿。要补一条静态断言：插件里所有 `ctx.on('…')` 的事件名必须在宿主真实事件白名单内。

## 1. 证据链

### 1.1 时间线与现场

| 时间（本地） | 事件 | 结果 |
|---|---|---|
| 14:32:54 | 最后一次 `refresh.log` 写入（跑 `checks/check-plugin.mjs` 时） | `skip …\dsh-codebase-memory: 冷却中` |
| 14:38:40 | `refresh-stamps.json` 为 `C:\Users\kingdee\work\dsh-codebase-memory` 写入 stamp（跑套件时的 `code_index`） | digest `5df9be0f…\|68\|1604920869` |
| ~15:57 | 用户重启 DSH 宿主，加载 v0.22.0 | — |
| 15:57 → 16:32 | 用户正常使用（本会话） | `refresh.log` **0 行**；`refresh-stamps.json` mtime 停留在 14:38 |

结论：重启后通道①一次都没进入 `refreshSessionWorkspace`，连"冷却中"都没有——不是被冷却挡住，而是监听器根本没被触发。用户贴出的观察（"连一条 agent-chat 都没有"）与此一致。

### 1.2 代码现场

`index.js:1829-1842`：

```js
// H2：会话启动补偿刷新。监听器必须**同步且绝不抛**……
if (cfg.sessionRefresh && typeof ctx.on === 'function') {
  ctx.on('agent/session-start', (payload) => {
    try {
      const cwd = payload?.agent?.session?.header?.cwd
      void refreshSessionWorkspace(ctx, cfg, state, payload?.agent, ac.signal)
        .catch((error) => refreshLog(cfg, `fail ${cwd ?? '(无 cwd)'}: 未捕获 …`))
    } catch (error) {
      push(state, `会话启动刷新未能启动（已忽略）：…`)
    }
  })
}
```

注释里的防御（"同步且绝不抛""降级不违 boot 绝不 throw"）全是针对"事件会来"的前提写的；前提本身不成立，防御也就没有意义。

### 1.3 全树核对

```bash
# 在 DSH 安装树里找发射方（排除 .on 订阅与类型声明）
grep -rn '"agent/session-start"' node_modules/@deepseek-ai --include=*.js | grep -v '\.on('
# → 无输出
grep -rn 'agent/session-start' node_modules/@deepseek-ai
# → 无输出（唯一命中在 profile 的 dsh-codebase-memory/index.js）
```

对照：`agent/created` 的发射点是 `node_modules/@deepseek-ai/dsh-agent/lib/index.js:581`（`announce()` 内部），载荷见 1.4。

### 1.4 DSH 真实事件面（本审计核对过的）

| 事件 | 发射点（宿主安装树内） | 载荷 / 语义 |
|---|---|---|
| `agent/created` | `@deepseek-ai/dsh-agent/lib/index.js:581`（`announce()`） | `{agent, source, signal}`；`source` 为 `fresh`/`resume`/`clear`/`compaction` |
| `agent/disposed` | `@deepseek-ai/dsh-agent/lib/index.js:552`（`emitDisposed()`） | `{agent}` |
| `agent/pre-step` | `@deepseek-ai/dsh-agent-loop/lib/index.js:909`（`waterfall`） | `{agent, messages, signal, step}` + `next()`；每步模型请求前一次 |
| `agent/request` | `@deepseek-ai/dsh-agent-loop/lib/index.js:1191`（`waterfall`） | 请求级决策，可改写路由/模型 |
| `system-prompt/assemble` | `@deepseek-ai/dsh-system-prompt/lib/index.js:398`（`waterfall`） | `(assembly, context, next)`；每次系统提示组装 |
| `tools/pre-execute` | `@deepseek-ai/dsh-tools/lib/index.js:3321`（`waterfall`） | `(exec, next)`；可返回 `{kind:'deny'}` |
| `session/event` | `@deepseek-ai/dsh-session/lib/index.js:1587` | `(session, event)`；`event.type` 如 `step/end` |
| `session/created` | `@deepseek-ai/dsh-session/lib/index.js:1917` | 新会话落库 |
| `workspace/session-activity` | `@deepseek-ai/dsh-workspace/lib/index.js:531`（`waterfall`） | `({sessionId}, next)`，用于归档准入的活动上报 |
| `llm/stream` | `@deepseek-ai/dsh-llm/lib/index.js:2397`（`waterfall`） | 流式请求拦截 |

要点：这些是**按会话/按步**的事件，天然带 `agent` 或 `session` 对象；插件不需要"知道有哪些工作区"，它从事件里拿到当前会话，再从 `agent.session.header.cwd` 读工作区。

## 2. dsh-ops 的五个做法（可复用的范式）

dsh-ops 0.4.4，路径 `C:\Users\kingdee\.dsh\profiles\tauri\node_modules\dsh-ops`。

1. **只挂真事件**：`lib/index.js:61`（`agent/created`）、`:64`（`agent/disposed`）、`:76`（`tools/pre-execute`）、`lib/discovery/index.js:244`（`agent/created`）、`:245`（`agent/pre-step`）、`:258`（`agent/disposed`）、`:302`（`system-prompt/change`）、`:308`（`internal/update`）、`:322`（`system-prompt/assemble`）、`:350`（`session/event`）、`lib/modes/native/read-dedup.js:121`（`llm/stream`）。
2. **作用域跟着 agent 走**：`Map<agent, entry>`；`agent/created` 里建 entry，并把能力挂到该 agent 名下——`entry.fiber = agent.ctx.plugin({ inject: ['tools'], apply(scoped) { … } })`（`lib/discovery/index.js:240`）。
3. **cwd 永远现取**：`sessionWorkdir(args, session)` 读 `session.header.cwd`；相对路径锚在会话工作区，绝不落到 helper 进程的 cwd；按工作区拼写判 win/posix（`lib/session-shells.js:54-110`）。
4. **心跳在每一步**：`agent/pre-step` 里 `await attach(payload.agent)`，再按需 reconcile（`lib/discovery/index.js:245-256`）。能力目录、会话 bash 层都在一步内收敛，不依赖"启动时一次性时机"。
5. **要服务就 inject，不猜**：`ctx.inject(['tools'])`、`ctx.inject(['sandbox', 'subprocess'])`、`ctx.get('agents')?.list()`（`lib/session-shells.js:344`）、`ctx.effect()` 统一卸载。

## 3. 我们与它的逐项对照

| 维度 | dsh-ops | dsh-codebase-memory（v0.22.0） |
|---|---|---|
| 生命周期事件 | `agent/created` / `agent/disposed` / `agent/pre-step` / `session/event` / `system-prompt/assemble` / `tools/pre-execute` / `llm/stream` | `agent/session-start`（**不存在**）/ `tools/pre-execute` / `tools/post-execute`（后两个是真的） |
| 作用域 | 每 agent 一个 entry，`agent.ctx.plugin` 挂到该 agent | 全局 `sessions` / `dirty`，键是 session id + cwd 字符串 |
| cwd 来源 | 调用时读 `session.header.cwd` | 建索引/写 stamp 用会话 cwd 原文，不归一 git toplevel |
| 同仓多子目录 | 不适用（它按会话隔离） | 被当成两个"仓库"；`alreadyIndexed`（`index.js:871-879`）拿会话 cwd 比对 `root_path` 永不命中 |
| 清理 | `agent/disposed` + `ctx.effect` 回收 fiber / worker / 临时层 | 仅 Map 自然过期 |
| 心跳 | `agent/pre-step` 每步一次 | 只有 dirty 台账（同会话 write/edit）与 `code_find` 现场核 digest |

## 4. 为什么 184/184 全绿也没抓到

`checks/check-plugin.mjs` 的 `makeCtx`（`:154-276`）把监听器收进 `events[name]`，测试自己调用：

```js
g.events['agent/session-start'][0]({ agent: probeAgent, source: 'startup' })
```

替身对事件名不做校验——写错的事件名在测试里照样"能触发"，在宿主里则永远沉默。这是"替身比宿主宽容"的典型：测试验证了监听器**内部逻辑**，却验证不了**它是否被宿主调用**。

补法（P20 验收臂之一）：静态断言——扫描 `index.js` 源码里所有 `ctx.on('…')` 的事件名，必须落在宿主真实事件白名单内（白名单随宿主版本演进，写在 checks 里并注明来源坐标）。这样"猜事件名"这类错误会在 CI 当场红。

## 5. 解决方案：P20 多工作区自动保鲜

### 5.1 设计前提

引擎的 git watcher 绑在 MCP 进程的静态 cwd 上（`index.js:850-856` 的注释自认），是引擎架构决定的；改它等于重写引擎。而 DSH 里唯一知道"这一步属于哪个工作区"的一方是插件——`agent.session.header.cwd`。所以分工是：

- **插件**：枚举工作区、巡检 digest、决定何时踢引擎重建（唯一有多会话视野的一方）；
- **引擎**：对给定 repo 建图（它本来就干这个）。

### 5.2 第一层：接线修复（把死代码接回真实事件）

| 旧 | 新 | 语义 |
|---|---|---|
| `agent/session-start`（不存在） | `agent/created`（`{agent, source, signal}`） | `fresh` → 首建；`resume`/`clear`/`compaction` → 补偿刷新 |
| — | `agent/pre-step` | 心跳：每步给一次巡检机会（节流后多数为空操作） |
| — | `agent/disposed` | 清理 per-agent 状态 |
| 已有 `tools/pre-execute` | 保留 + 顺便 kick 一次巡检 | 工具动线天然带 cwd |
| `runCbmFlow` | 保留 + kick | 查询命中即视为"该工作区活跃" |
| hint `text()` | 保留 + kick（在 `if (!cfg.contextHint) return ''` 之前） | 每轮装配都会调用 |

注意：`agent/created` 的监听器要**同步返回**（宿主对创建监听器串行等待）；重活一律 `void` 后台跑，并 `.catch` 落 `refresh.log`——现有注释里的防御可以保留，只是换成会真的事件。

### 5.3 第二层：工作区身份按 git toplevel 归一

- `git rev-parse --show-toplevel` 取仓库根；`state.repoRoots` 缓存，失败回退会话 cwd；
- stamp 键、`alreadyIndexed` 比对、hint 的 behind 判定、`projectsByCwd` 全部改用仓库根；
- 收益：同一仓库的不同子目录会话合并为一个工作区；`alreadyIndexed` 能真实命中，不再白跑或误跳。

### 5.4 第三层：多工作区轮扫（引擎 watcher 的插件层替代）

- **候选集**：`refresh-stamps.json` 的键 ∪ `state.projectsByCwd.keys()` ∪ 本次进程见过的仓库；
- **热度分层**：30 分钟内活跃过（`SWEEP_HOT_WINDOW_MS`）为热仓，每轮都查；其余冷仓按游标 round-robin，每轮 `SWEEP_COLD_PER_ROUND = 6`；
- **纯函数**：`sweepPlan({eligible, seen, now, hotWindowMs, coldPerRound, cursor}) → {order, cursor, hot, cold}`，导出以便断言；
- **执行**：串行 `await refreshSessionWorkspace(..., {quietSkip: true})`，复用 `withIndexLock`（`index.js:654-664`）；`quietSkip` 时不写"未变/冷却"噪声行，`refresh.log` 加体量护栏；
- **触发**：活动驱动节流，不养 `setInterval`——kick 点见 5.2，节流字段 `workspaceSweepSec`（volatile，默认 300，0 = 关）。

成本上界：每 5 分钟最多 6 个冷仓 × 2 次 git 子进程；热仓数量由实际活跃会话数决定，通常 ≤ 3。

### 5.5 观测

- 遥测事件 `workspace-sweep`：`checked / hot / cold / refreshed / behind / skipped`；
- `state.lastSweep`：最近一次巡检的时间、候选数、结果分布；
- `code_setup` 报表加一行摘要（"上次巡检：14:38，7 仓，1 个 behind"）；
- `refresh.log` 只在真的重建/失败时写行。

### 5.6 验收臂（新增，全部走真实事件名）

1. `sweepPlan` 纯函数：热/冷分配、游标推进、空集、全热；
2. 三道门：`workspaceSweepSec=0` 关档、节流窗口内不重复踢、`state.cbm !== 'ready'` 不踢；
3. 两个假仓集成：A 仓 stamp 与现场 digest 不同 → 触发一次 `index_repository`；B 仓相同 → `skipped:unchanged` 且不 spawn；
4. toplevel 归一：子目录会话命中同一仓库根，stamp 只写一条；
5. `quietSkip`：巡检不发噪声行，重建才发；
6. **事件白名单静态臂**：`ctx.on('…')` 的事件名 ⊆ 宿主真实事件清单。

## 6. 取舍与风险

- **为什么不在引擎里改**：引擎是独立二进制，watcher 的 cwd 是进程属性；让引擎支持"多根监听"需要跨进程协议，收益远小于插件层巡检。
- **为什么不养定时器**：DSH 插件生命周期由宿主管理，常驻定时器在空闲宿主上白烧；活动驱动 + 节流在"有会话在用"时才有成本。
- **冷仓轮转的代价**：极端情况下（> 6 个冷仓）最久可能几轮才轮到一次；这是有意的成本上界，`sweepPlan` 的 `cursor` 保证公平轮转而非饿死。
- **兼容性**：`workspaceSweepSec=0` 即回到 v0.22.0 行为，配置可关。

## 7. 附：如何自查一个事件是否真实存在

```bash
# 1) 找发射点（订阅不算）
grep -rn '"agent/created"' node_modules/@deepseek-ai --include=*.js | grep -v '\.on('
# 2) 找测试替身里是否只手工调用（说明它没被真实驱动过）
grep -rn "events\['agent/" checks/check-plugin.mjs
# 3) 看宿主版本差异：事件名在 dsh-* 的 lib/types 里通常有声明，可作交叉验证
```
## 8. 实施状态（v0.23.0）

> 2026-11-02 已实施并发布 **v0.23.0**：tauri 193/193、web 193/193（串行），quick 四套件全过（client 输入框 6 个，volatile 契约含 `workspaceSweepSec` 且设置页有对应控件）。生效前提同前两版：`node scripts/sync.mjs` + 重启宿主。

方案已落码，与 §5 的偏差如实记录：

- **接线**：`agent/session-start` 已删除；`agent/created`（补偿刷新 + 踢轮扫）、`agent/pre-step`（踢轮扫后 `next()`）、`agent/disposed`（清会话缓存）三个真事件挂上。
- **仓库身份**：新增 `repoRootOf()`（`git rev-parse --show-toplevel`，60s 缓存），补偿刷新、`projectFor`、`selfHealIndex`、`runCbmFlow` 四处统一归一；`hint` 渲染路径只读缓存、不同步 spawn git。
- **轮扫**：`sweepPlan()` 导出纯函数（热仓每轮 + 冷仓游标 round-robin ≤6）、`runWorkspaceSweep()` 串行复用同一套闸门、`kickWorkspaceSweep()` 活动驱动节流（无定时器）。配置 `workspaceSweepSec` 默认 300、`0` 关档。
- **观测**：`state.lastSweep` + `code_setup` 的 `轮扫:` 行 + 遥测 `workspace-sweep`；`refresh.log` 加 512KB 轮转，轮扫的冷却/未变行按 `quiet` 不写。
- **验收臂**（实际落地，比 §5.6 少两条、多一条）：
  - S1 `sweepPlan` 纯函数三例（热仓优先、三轮轮到 3 个冷仓、空集）；
  - S2 toplevel 归一：真 git 仓库的 `checks/` 子目录当会话 cwd，断言日志只记仓库根；
  - S3 轮扫端到端：真事件踢发 → 候选走 5 分钟冷却短路（不真跑 `index_repository`）→ 报表 `上轮 checked=1 … refreshed=0`；
  - E 新增**事件白名单静态臂**：读 `index.js` 原文，任何 `ctx.on('…')` 不在宿主真实事件清单即红——这是"假事件"的回归锁。
  - 未做 §5.6 的"两个假仓真触发 `index_repository`"：验收不该让套件付一次真索引；它验证的"digest 变了才重建"由纯函数 + 冷却/未变闸门的两条既有断言覆盖。§5.6 的"节流窗口内不重复踢"也未单独立臂——踢发被 5 分钟冷却与 `sweepRunning` 双重挡住，`S3` 的 `checked=1` 已经证明一次事件只产生一轮。

## 9. 活体验收与 v0.23.1 补丁（同日 18:12 重启后）

用户重启宿主做活体验收（"重启完了，重新验收"），两条通道结果相反：

- **通道① `agent/created` 补偿刷新：通过。** `refresh.log` 出现 `10:12:28Z refresh …\dsh-codebase-memory（git 状态变了）` → `10:12:46Z done exit=0`——18 秒自动重建，不需要任何手动 `code_index`。这正是 m00794 抱怨"分析没有自动更新"要的效果，真事件接线在活宿主里成立。behind 第四态同场验证：18:12 重建后我继续改文件，会话注入段立刻打出"索引落后于工作区：图建于 18:12，之后 git 状态变过；先 code_index"——无手动触发。
- **通道② 轮扫：崩溃。** 遥测 `workspace-sweep-fail: spawn git ENOENT`（pid 20504@10:05:33、pid 37868@10:11:47）。

**根因**：真实 `ADAPTER_DIR`（`C:\Users\kingdee\.dsh\vendor\mcp-adapter`）的 `refresh-stamps.json` 里躺着 **9 月验收跑残留的两条死条目**（`%TEMP%\cbm-check-refresh-60628-tauri/-web`，目录早已蒸发）。轮扫的 eligible 取自 stamp keys ∪ projects ∪ workspaces，死路径进候选后，`repoRootOf` 对不存在的 cwd `spawn git`——Windows 直接 ENOENT——**一条毒条目让整轮 reject**：`lastSweep` 不落账，同文件里 5 条活仓（ruankao-ai / obsidian-daily-report / agent-chat / selfheal-fixture / 本仓）一条都没查。

这一课只有活体能教：跨进程污染（别的进程、别的版本的 checks 往共享目录写过的路径后来被删）是轮扫的**运行现实**，不是理论边界；测试替身里的候选永远"活着"，193/193 看不见它。

**修复（三处，全部往"单条失败不得传染整轮"收敛）**：

1. `runWorkspaceSweep`：eligible 先 `existsSync` 滤掉已消失的路径（stamp 条目保留不删——目录可能回来，记账是另一回事）；
2. 循环体 per-target `try/catch`，新增 `failed` 计数进 `lastSweep` 与遥测（报表行格式不变）；
3. `repoRootOf`：`run()` 抛错（目录消失 / git 起不来）时 catch 回退 cwd——同一防护自动覆盖 `projectFor`、`selfHealIndex`、`runCbmFlow` 三个调用方。

**回归臂 S4**：往 stamp 混一条 ghost 目录 + 活仓（`at=now` 走冷却短路）→ 断言报表出现 `上轮 checked=1`（ghost 被滤、本轮完成落账）且本进程 pid 名下无 `workspace-sweep-fail`。遥测行是逐行 JSON，**按 `pid` 字段精确过滤**——活宿主的旧 bundle 每 5 分钟仍在同一份共享遥测里写 fail 行，子串匹配会误伤假红。修复前该臂必红（报表停在"还没跑过"），修复后绿，判别力成立。

> 2026-11-02 已发布 **v0.23.1**：版本 bump 后串行复跑 tauri 194/194、web 194/194，quick 四件套全过。生效前提同上：`node scripts/sync.mjs` + 重启宿主（profile pin 升 tag 仍受 `minimumReleaseAge` 阻塞，走 sync 通路）。
