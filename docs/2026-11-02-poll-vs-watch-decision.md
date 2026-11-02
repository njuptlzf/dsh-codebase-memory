# 轮询 vs watch：为什么自动保鲜选了更便宜的那条腿

- 日期：2026-11-02
- 版本：dsh-codebase-memory v0.23.1（本文决策时点）；DSH 宿主为 Windows（`C:\Users\kingdee`）
- 状态：决策记录（不产生代码改动）；升级路径已设计、明确**暂不实施**，附开工触发条件
- 触发：v0.23.1 发布后的设计追问（m01715「为什么不用 inotify 这种 watch」「参考 k8s client-go 的 list-watch 能不能用」「宿主机的 inotify 机制好用吗」「正统借法具体是怎样的」，m01715–m01763）
- 关联：[2026-11-02-lifecycle-wiring-audit.md](./2026-11-02-lifecycle-wiring-audit.md)（§7 P20 轮扫方案的落地实况）；README「DSH 生命周期介入表」

## 0. 结论（TL;DR）

1. **我们的陈旧判据不是"文件变了"，是 git 状态变了**（`HEAD + git status --porcelain` digest）。文件事件与这个判据之间隔着一次 git 语义翻译；而 digest 对比本身就是 reconcile——百毫秒级、无句柄、跨平台同语义。**事件是提示，状态是真相；轮询便宜到不需要加速器。**
2. **client-go 式"一次 LIST 之后全 WATCH"在我们域内缺的不是工程，是物理前提。** k8s 敢把 watch 当主通道，因为所有写必经 apiserver 落进 etcd 版本化日志（RV 单调、可断点续传、410 Gone 可证伪→全量 relist）。我们的写方是 IDE 直接落盘、外部 git 进程——**没有任何组件坐在所有写入的上游**，不存在可当 watch 源的日志。注意 informer 自己也没信纯事件：410→relist 与 resync period 都是它的内置件。
3. **这台宿主上 inotify 连"不好用"都排不上，是不存在**；Windows 对应物 ReadDirectoryChangesW 溢出即整段事件作废（`ERROR_NOTIFY_ENUM_DIR`）。Linux 上 inotify 好用，但配额（`max_user_watches`）、目录树自爬、队列溢出丢段、NFS/SMB 不出事件，而且整个生态（webpack `usePolling`、VS Code polling fallback、chokidar interval 模式、air 轮询档，以及我们自己的 config-watch #34：3 秒 sha256 轮询）最终都偷偷留了一条 poll 腿。
4. **正统的借法已经设计好，但留在梯子上**：`.git` 元数据（HEAD / logs / refs / packed-refs / index）watch，句柄 O(仓)，事件只允许举手说"现在查这仓"，**不解读内容、不当裁判**；digest 链路一行不动。开工触发条件写在 §6.3，遥测可判。

## 1. 现状形状（v0.23.1 实际在跑的）

| 部件 | 代码坐标 | 职责 |
|---|---|---|
| 工作区身份 | `repoRootOf`（index.js:877） | `git rev-parse --show-toplevel`，60s 缓存；stamp 键按仓根归一，多会话同仓天然去重 |
| 真相判据 | `workspaceDigest`（:906） | `HEAD|porcelain长度|hash`；`stamp.digest ≠ 现场 digest` ⇒ behind |
| 调和循环 | `refreshSessionWorkspace`（:955） | digest→5 分钟冷却→in-flight→`withIndexLock` 串行→重建→写 stamp |
| 轮扫 | `sweepPlan`（:894）/ `runWorkspaceSweep`（:1038） | 候选 = stamps ∪ projects ∪ 本进程见过；热仓（30min 内碰过）优先，冷仓游标 round-robin 每轮 6；per-target try/catch + failed 落账 |
| 踢发点 | `kickWorkspaceSweep`（:1060，300s 节流） | `agent/created`、`agent/pre-step`、注入段渲染、`runCbmFlow`——四个**宿主真事件**，零 setInterval |
| 显式化 | behind 第四态（v0.22.0） | 漏检时注入段直接告诉模型"先 code_index 再采信行号"——陈旧可见，不等轮扫收敛 |

v0.23.1 活体一笔（2026-11-02 重启验收）：新进程 `workspace-sweep {checked:5, refreshed:3, failed:0}`；9 月 checks 留下的两条蒸发目录 stamp 被 `existsSync` 预筛挡在候选外——**候选集里有不可达目标毁掉整轮观测**这个形状，watch-first 设计与 naive 轮扫是同病房的，我们的答案是结构性耐受（预筛 + per-target catch + failed 记账，三行代码），watcher 版本要的是句柄失效回收 + 溢出重扫 + 跨进程去重三套子系统。

## 2. 为什么"只 LIST 一次、后续全 WATCH"不适用于此域（client-go 拆解）

| client-go 机制 | 它成立的前提 | 我们的对应物 |
|---|---|---|
| Reflector：LIST 建基线 + WATCH 续传 | 写必经 apiserver→etcd，事件流是写的必经之路 | 只有 LIST 半：digest 对比。文件系统给不出可续传流 |
| resourceVersion（单调、可证明看完/没看完） | etcd 保存全量历史直到压缩 | digest 是**状态指纹**：能判"变没变"，答不了"错过了什么"——无历史日志 |
| 410 Gone → 全量 relist | server 知道自己丢到哪 | 毒条目/spawn 失败 → failed++、behind 标 unknown，不拖垮整轮（v0.23.1） |
| Resync period | 作者就不信纯事件 | `workspaceSweepSec=300` 轮扫 + 冷仓游标 |
| workqueue 限速 + 单 controller | 库自带 | 5 分钟冷却 + `withIndexLock` 同仓串行 |
| 事件当 wake-up、controller level-triggered | 调和循环是真相本体，事件只提早触发 | 四个宿主事件踢发点 = 我们的"事件面"（来自生命周期而非 fs） |

一句话：**按 informer 术语，这个插件已经是 level-triggered 调和循环 + 可插拔 wake-up；唯一缺的件（可续传无损流）在此域造不出来，而它的摊销前提（LIST 贵）在这里恰好不成立——LIST ≈ 两个 git 调用，全候选串行 ~1s。**

## 3. 平台机制现状（inotify / RDCW / FSEvents）

- **inotify(7)**（Linux）：边缘触发、无历史、watch 按目录计费。刺：`max_user_instances` 128 / `max_user_watches` 常 8192（monorepo 直接 ENOSPC，webpack/VS Code 文档教人拉 524288）；队列溢出 `IN_Q_OVERFLOW` 只知道丢过、不知道丢了哪段；NFS/SMB/FUSE 不出事件；recursive 是应用层收 `IN_ISDIR` 自爬树（chokidar 大半个库就是这棵树）。本土定位：最好的低延迟**提示器**——注意所有人拿它当提示器用。
- **ReadDirectoryChangesW**（本机唯一原生选项）：一个句柄递归盯整棵树，API 反而简单；刺：缓冲溢出时挂起调用只回 `ERROR_NOTIFY_ENUM_DIR`，该窗口全部事件作废、必须重新枚举；网络盘不可靠、杀软可吞事件；node `fs.watch` 就是包的这个。
- **FSEvents**（macOS）：三者里唯一带日志味的（合并事件 + `sinceEventID` 追补），但目录级粒度、追补窗口有限；苹果把它做成可续传了，文档仍建议周期性 verify。
- **生态共同行为**：webpack Docker 挂载推荐 `usePolling`；VS Code 有 watcher 排除表 + polling 兜底；chokidar 自带 interval 模式；air 可关 watcher 改轮询；本仓邻居经验 config-watch（#34）最终形态 = **3 秒 sha256 内容轮询，漂移即退出让 supervisor 重拉**——低频、必须绝对不丢、丢了无法自证的判定，轮询就是最短正确路径。inotify 的甜区（毫秒级连续流、丢事件只是延迟不是错误）与我们的场景（分钟级、漏检即错误坐标、跨进程重启）在两端。

## 4. 正统升级路径（设计完毕，暂不实施）

定性：给 `refreshSessionWorkspace` 多接一个门铃。**watcher 只被授权说"现在查这仓"，永远不被授权说"变了什么"；语义判断全部留给 digest。**

```js
const wake = debounce((root) => {              // 1.5s：checkout 瞬时几十个事件
  void refreshSessionWorkspace(ctx, cfg, state, null, ac.signal,
       { cwd: root, by: 'watch' });            // 现有链路原样：digest→stamp→冷却→锁→重建
}, 1500);
for (const root of hotRepos(state)) {          // 只挂热集，上限 N；会话不活跃就不挂
  fs.watch(gitMetaDir(root), { recursive: false }, (ev, file) => {
    if (/^(HEAD|index|packed-refs|logs|refs)/.test(file)) wake(root);   // 只看动没动，不读内容
  }).on('error', () => dropWatcher(root));     // 句柄失效 → 扔，退回纯轮扫
}
// 溢出(ERROR_NOTIFY_ENUM_DIR) → 直接 runWorkspaceSweep() 全量 digest 一轮：
// 溢出重扫子系统 = 现有 sweep 本体，不另写
```

盯什么、捕获什么（每仓）：

| 目标 | 捕获 | 故意不捕获 | 句柄 |
|---|---|---|---|
| `.git/HEAD` | checkout / rebase / detached↔attached | — | 1 |
| `.git/logs/`（reflog） | commit/merge/reset/pull 的 append-only 痕迹——git 里唯一"像 etcd 日志"的部件；被 gc 清/关 `core.logAllRefUpdates` 也无妨，最坏退回 5 分钟窗口 | 外部 fetch 进 bare 仓 | 1–2 |
| `.git/refs/**` + `packed-refs` | `update-ref` 类直接改 ref | —（gc 重写风暴无害） | 1+1 |
| `.git/index` | staging 变化（digest 输入之一） | 工作区编辑本身（不碰 .git） | 1 |
| 工作区树（可选档 `watchWorktree`） | 外部 IDE 未提交编辑 | —；但句柄换回 O(目录)（Linux）+编辑器噪音，默认不开 | Win 1 递归 / Linux O(dirs) |

- **没有新故障模式**：多进程撞车由共享 stamp + 锁仲裁；断档（重启丢事件）由下次任意踢发点的全量 digest 自愈；毒目录由 error→drop 吸收。收益：检测延迟 5 分钟 → ~2 秒。
- 配置面草图：`gitWatch: false`（默认关）、`wakeDebounceMs: 1500`、`watchCooldownSec: 60`（watch 路允许比轮扫短——人工 commit 低频且确定是真信号）。
- **reflog 的诚实用法只有一种**：问"动没动"。拿它读 SHA 增量去推断变化，等于处理 packed-refs/gc/worktree 一整层 git 内部表示——那场仗 `git status` 已经替我们打赢了。

## 5. 为什么不把 digest 内容换成 reflog 解析（顺手堵住的岔路）

digest 里塞 `git rev-parse HEAD` 已经覆盖 ref 侧真相，`porcelain` 覆盖工作区侧；reflog 解析换来的只是"知道为什么变"——而消费者（behind 提示、code_index 建议）不需要原因。为用不上的信息引入 git 内部表示的维护面，负资产。

## 6. 为什么暂时选择更便宜的轮询机制（本档主题）

### 6.1 收益侧已被现有分层盖住大半

| 变化源 | 现在的覆盖路径 | 残余延迟 |
|---|---|---|
| agent 自己的 write/edit | dirty 旁路（本会话脏文件计数，不看问法触发 hint） | 秒级 |
| 新会话/重开宿主碰到本仓 | `agent/created` 补偿刷新 | 秒级 |
| commit/pull（含外部） | 下一次任意踢发点的 digest 对比 | ≤ 5 分钟 |
| 上述全漏网的 | **behind 第四态把陈旧显式化**：注入段直接说"图建于 HH:MM，之后 git 变过，先 code_index" | 0（漏检代价从"错答案"降为"多一次工具调用"） |

watch 加速的只剩窄缝：**外部 IDE 连续编辑未提交 + 恰好此刻想问代码**（工作区树不碰 .git，git-meta watch 也照不到它；开 `watchWorktree` 才能盖，代价见 §4 表末行）。

### 6.2 成本侧不对称

轮询：零常驻件、零句柄、新故障面为零（v0.23.0/1 两次事故都发生在**已有**机制的边界上且已结构化修复）。watch：常驻句柄生命周期 × 平台分叉（Windows 递归句柄 O(仓) vs Linux 元数据文件非递归）× 溢出重扫 × 多 profile 去重 × 验收臂与配置面 ≈ 百来行起步，全是要养的钱。这台 Windows 宿主上，收益/成本算不拢；这正是"文件事件是提示"论断的量化形态。

### 6.3 开工触发条件（防止将来凭感觉重开）

遥测 `workspace-sweep` / hint 注入计数按周聚合：**"commit 后首次代码查询命中 behind"占比可观**（即 behind 不只是偶发兜底、而是反复打断查询节奏）时，把 §4 方案从梯子搬进主线——先只做 Linux 之外最小的 `.git` 元数据 watch（Win 单递归句柄），`gitWatch` 默认关、验收臂走临时 git 仓 + 真 fs.watch。在此之前，任何"上 watcher"的提议请先回答 §2 表第一列：谁坐在所有写入的上游。

## 7. 决策记录（供 changelog 引用）

> 2026-11-02，v0.23.1：多工作区自动保鲜维持**活动驱动轮询 + digest 调和**；经 client-go list-watch、inotify/RDCW 两轮对照复盘，确认"可续传无损事件流"在本域物理不存在、"LIST 贵"的摊销前提不成立，watch-as-wake-up（.git 元数据，句柄 O(仓)）归档为 §4 设计 + §6.3 触发条件，暂不实施。
