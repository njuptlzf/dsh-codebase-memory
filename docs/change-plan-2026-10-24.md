# 改动清单：结构层与语义层解耦 + 预热结果复用 + 预算分项

> 候选版本 v0.15.0 · 2026-10-24 · 只描述改什么与怎么验，不含实现
>
> 触发来源：本仓 `dsh-codebase-memory` 的 grep 自动替换在本工作区长期不生效的实测归因  
> （见 `.workbuddy-ai/memory/2026-10-24.md`）。

---

## 0 摘要

| #  | 改动项       | 一句话                                                   | 量级    | 依赖    |
| -- | --------- | ----------------------------------------------------- | ----- | ----- |
| M1 | 预热结果复用    | 开机那一发 `list_projects` 的返回体别扔，热路径先查它                   | ~25 行 | 无     |
| M2 | 预算分项      | 图谱腿与语义腿各一个预算，不再共用 2500ms                              | ~15 行 | 无     |
| M3 | 计数分腿      | `replace-pass-failed` 拆成 `:graph` / `:zg`，面板能看出是哪条腿失败 | ~20 行 | M2    |
| M4 | 两腿按触发源二选一 | 符号型问题走图谱、意图型走语义，**互不为兜底**                             | ~40 行 | M2    |
| M5 | 文案分层      | 语义近似结果要说清"不是字面命中、不是编辑锚点"                              | ~15 行 | M4    |
| M6 | 面板读数      | 新增两行失败读数；enforce 说明改成两腿分工                             | ~25 行 | M3    |
| M7 | 技能文档      | 补输出改写判读、`code_setup` 两个 action、`code_index` 三件事       | ~60 行 | M4 M5 |
| M8 | 验收闸门      | `check-plugin.mjs` 加 11 条断言，锁住以上全部语义                  | ~90 行 | M1–M7 |

**一句话目标**：让「搜代码」这件事在 enforce=replace 下真的能换出结果，而不是每个符号类 grep 白等 5 秒再拿回原始输出。

---

## 实施记录（2026-10-24，v0.15.0）

**已落地：M1 + M2 + 对应的验收闸门（M8 的 1–5 条）。**

| 项 | 落点 | 结果 |
|---|---|---|
| M1 预热结果复用 | `index.js` `refreshProjectsListing()` + `projectFor()` 四级查找 + `state.projectsListing` | 热路径不再现查 `list_projects`；验收臂 M1 三条通过 |
| M2 预算分项 | `graphBudgetMs` / `zgBudgetMs`（volatile）+ `budgetGraph()` / `budgetZg()` | 慢引擎 3000ms 在 4000ms 预算内成功替换；`graphBudgetMs=0` 正确回落到整体预算 |
| M8 闸门 | `checks/check-plugin.mjs` 臂 M1/M2 五条 | 含"预热失败不缓存、回落现查"的反向断言 |

**与计划的偏差（两处，都比原方案更保守）**

1. **预算语义反过来了**：计划里写的是"未设 `graphBudgetMs` 时取 `interceptBudgetMs`"。实际实现是
   `具体项 > 0 → 用它；否则旧的整体预算 > 0 → 用它；否则用各自默认`。
   原因：`interceptBudgetMs` 是老字段，老 profile **显式设过它**（有人把检索等压到 60ms），
   新默认值不能把它顶掉。为了让它"显式"可判定，它自己的默认从 `2500` 改成 `0`（=未设）。
2. **两个新字段默认 `0`**（而不是 6000/4000）：`0` = 未设 → 走代码里的常量默认。
   好处是老配置一眼能看出"没设过"，页面上也不用假装有个用户值。

**顺带修掉的 5 个既有 bug**（都是跑闸门时被红灯逼出来的，与 M1/M2 无因果关系）

| # | 症状 | 根因 | 影响 |
|---|---|---|---|
| 1 | 日志永不轮转、`recent` 不截尾、未替换标记永远不生效 | v0.14.0 的三个 volatile 字段（`logRetentionDays` / `recentLimit` / `markPassthrough`）**没被 `normalize` 搬进 `cfg`**，运行时恒 `undefined` | 页面能改、代码不读——三个"静默洞" |
| 2 | 按仓库计数里替换事件记进了 deny 桶 | `repoBump` 按 `intercept-` 前缀分流，而替换事件恰好叫 `intercept-replace` | 面板的"替换/拒绝"分列永远错 |
| 3 | 页面读数永远慢一条 | `telemetry()` 在 `repoBump`/`pushRecent` **之前**推 stats 快照 | 「效果」环形与按仓库计数缺最后一条 |
| 4 | 验收 W2 臂 ENOENT 崩、G 重试计数恒 0 | 断言还在读旧文件名 `telemetry.log`（v0.14.0 已改按天轮转） | 闸门本身失效 |
| 5 | O3/O4 用 `sym0`..`sym4` 当符号样例 | 4–5 字符且无大写/下划线 ⇒ `classifyPattern` 判**字面量**（设计如此） | 测的其实是"字面量不替换" |

另：`checks/check-plugin.mjs` 现在只验**真正接线**的 profile（`cordis.yml` 里注册过 bundle）。
`web` profile 装过但没注册，验它只会产生"链路 NOT READY / 清单里多出 zg"的假红灯
（清单是跨 profile 共享的，谁最后 bootstrap 就写谁那份）。跳过时会打印原因。

**验收**

```
npm run check
PATCH OK / check:client 全过 / 164/164 臂通过（tauri）/ PLUGIN OK
```

替换链路的实证（R 臂遥测行）：`cbm-warm=1 list-projects:cache-hit=1 intercept-replace=1 intercept-replace:graph=1`
—— `intercept-replace:graph` 第一次非 0，说明图谱腿真的被走到了。

**生效条件**：已 `node scripts/sync.mjs` 进 tauri / web 两个 profile，但**当前运行的宿主仍是旧代码**
（adapter 进程 pid 43376 自 10-21 起没重启过）。要看到真实效果需重启该 profile 的 DSH 宿主。

**M6 也已落地**（见下）。原计划里的 M1–M8 全部完成。

### M6 面板读数（同日收尾）

| 读数 | 落点 | 为什么值得占一行 |
|---|---|---|
| `stats.r.qfailgraph` | 「替换命中率」卡新增一行：失败里属于**图谱腿**的条数 | M3 的分腿计数必须能在页上看见，否则排障还是得翻 `telemetry.log` |
| `stats.budget` | 同卡页脚：`预算 图谱 {graph}ms / 语义 {zg}ms`（值取自 `stats.budget`，即生效值而非配置值） | 「为什么慢」和「预算给错了」是两件事，页上要能分开看 |
| `stats.r.codesearch` | 「软引导」卡：`code_search` 调用次数 | 语义层退出钩子后的**唯一入口**，它的采纳率就是这一层的有效性读数 |
| `stats.r.lpc` / `stats.r.lph` | 「索引」卡：命中预热清单 / 热路径现查 | M1 的验收读数——`hot` 稳态应为 0，不降就是预热没生效 |

配套：`renderStats` 的 `lever` 加 `codeSearch`（来自 `code-search` 事件），`index.js` 的 `code_search` 每次调用记一条。`check-client.mjs` 加四条断言（分腿行、预算行、`code_search` 行、清单缓存行），并把 6 个新键纳入字典覆盖检查。

---

## 实施记录 2（2026-10-24 下午，v0.15.0 续）

**已落地：M3 + M4′（改设计）+ M5′ + M4b + M7 + 两份 README 的用法节。**

### M4 改了设计（原方案作废）

原计划给 `classifyPattern` 加 `phrase` 档（含空格的多词 ⇒ 走语义腿）。**这个判据会把 `hello world` 这类字面短语误判成意图查询**，然后把精确命中的 grep 输出换成语义近似片段——比不换更糟。

改成 **M4′：语义层退出替换钩子，只走显式入口**。三条理由（也写进了 `index.js` 的 replace 路径注释与两份 README）：

1. 钩子拿到的输入是从 grep pattern 抽出的**裸标识符**——对图谱是正确输入，对向量检索是最差输入；
2. "图谱没答案才试语义"只在语义最不可能给准答案的时刻启动；
3. 6s（图谱）+ 4s（语义）= 一次符号类 grep 白等 10s，然后多半还是拿回原输出。

### 各项落点

| 项 | 落点 | 结果 |
|---|---|---|
| M3 计数分腿 | `telemetry(..., {source:'graph'})` 复用既有 `event:source` 机制；`stats.replace` 加 `passFailedGraph` / `passFailedZg` | 汇总键保留（旧面板不空白）+ 分腿键可排障；臂 R3 新增一条断言 |
| M4′ 拆兜底 | `index.js` replace 路径删掉 zg 分支 | 臂 R 改写为"包就绪 + 有索引也不查 zg"；M2 那条断言从"语义腿仍能替换"翻成"zg 一枪不发" |
| M5′ 文案分层 | `renderReplacement` 两层文案不再同构（结构层给坐标、语义层写明"近似片段、不是锚点"）；usage 段改成两腿分工 | 面板 `enforce.replace.hint` / `sec.layers.hint` 中英各改一版 |
| M4b `code_search` | 与 `code_find` 同族的封装：`root`/`limit` 由插件填；未开启/无索引**直接 throw 并给处方** | 新臂 C 三条断言（代理调用带 root、输出自称非锚点、无索引给处方） |
| M7 技能 | 两个 `SKILL.md` + `investigation-core.md`：输出改写四种横幅的判读、会话台账优先、`code_setup` 两个 action、`code_index` 三件事、语义命中不是锚点 | `scripts/sync.mjs` 已把 3 个技能文件同步到 `~/.dsh/skills` |
| README | 中英各新增「语义层怎么用（v0.15.0）」小节 + 选层速查表改写 + ②b 行 + 排错表新增一行 + 热字段数（9→11、seven→thirteen） | 回答"是 skill 显式唤醒还是硬拦截替换 zg"：**显式唤醒**，理由写在正文 |

### 验收

```
npm run check
PATCH OK / check:client 全过 / 168/168 臂通过（tauri）/ PLUGIN OK / CHAIN OK / TOKENS OK
```

### 实施记录 3（2026-10-24 18:0x，重启验证）

用户重启宿主后核对实机，**发现一个真缺陷**：

| 证据 | 结论 |
|---|---|
| adapter 新进程 pid 49580 @18:01:30；cbm 53280/19980 @18:01:31/34（老的 48220/38556 已退） | 宿主确实重启，加载的是 0.15.0 |
| `cbm-warm ok:false ms:55`（18:01:31.5，进程起来 0.5s） | **启动竞态**：适配层的 cbm 连接是懒建的，第一发打在加载窗口上，55ms 回错 |
| 重启后没有任何 `list-projects:*` 计数 | 该进程的清单缓存是空的 ⇒ M1 在这一次启动里等于没做 |

**为什么严重**：`state.warm` 在调用前就置 true，失败不重试；而 `projectFor` 只在"清单存在但过期"时刷新。于是清单空 ⇒ 每次符号 grep 都现查（10.8s > 6s 预算）⇒ 图谱腿照样进不去。

**修法（四道）**：
1. 第一发**延后 1.5s**（`WARM_DELAY_MS`，测试缝 `DSH_CBM_WARM_DELAY_MS`），避开启动加载窗口；
2. 失败**重试** 5s / 15s / 45s（`LISTING_RETRY_DELAYS_MS`，测试缝 `DSH_CBM_LISTING_RETRY_MS`），定时器 unref；
3. `projectFor` 在清单**为空**时也踢一发后台刷新（原来只管"过期"）；
4. `cbm-warm` 失败时记录错误原文（`err` 字段）——这次只有 `ok:false/55ms`，只能靠时间线反推。

新断言：`M1 预热失败会重试（启动竞态能自愈，不把 M1 钉死）`（桩里 1 → 3 次调用）。

**另外两个顺手修掉的闸门问题**：
- `wired()` 原来读 `cordis.yml`，而新版宿主把它重写成空 `[]`（bundle 清单在 `package.json` 的 `dsh.profile.bundles`）⇒ 两个 profile 全被误判"未接线"。改成两处都认。
- 同一进程连跑多个 profile 会互相污染（共享 adapterDir 与 `cbm.json`：前一个的臂会把清单写成带 zg、把引擎占住）⇒ 一串假红灯。改成**一个 profile 一个进程**（`spawnSync` 自调）。实测：同进程 tauri+web = 假红灯；各自独立 = 169/169 × 2。

**最终闸门**：`169/169`（tauri）+ `169/169`（web）+ PATCH/CLIENT/CHAIN/TOKENS 全过。

**仍需一次重启**：本次启动的清单缓存是空的（预热已失败），要看到 `cbm-warm ok:true` 与新读数，得再重启一次。

### 实施记录 4（19:0x 第二次重启 + 直连引擎实测）

| 检查 | 数据 |
|---|---|
| 进程 | adapter `55740 @19:06:55`；cbm `52964 @19:06:57` / `49480 @19:07:00` |
| 清单 | `cbm.json` 19:06 重写，`servers=[cbm,zg]`，`scriptMode:true` |
| **预热** | `cbm-warm ok:true ms:41126` —— 冷启动把 7 个项目的图谱库全开一遍（`work.db` 156MB），`budget=0` 等真实 settle 是必须的 |
| `list_projects`（经引擎 UI `/rpc` 直连） | **8.65s** —— 与 10.8s 同量级；这就是钩子预算永远付不起、必须靠清单缓存的原因 |
| 图谱读取 `get_code_snippet` | 冷 0.56s → **热 13ms**（三次 13.5 / 14.2 / 12.7ms） |
| `projectFromListing`（真实清单 + 反斜杠 cwd） | 解析出 `C-Users-kingdee-work-dsh-codebase-memory` ✓；未知路径返回 `''` ✓ |

**结论**：6000ms 的图谱预算对热引擎是三个数量级的富余；真正贵的是"开库"（8.65s），而那笔钱预热已经付过、M1 把它留成了缓存。剩下的唯一未验证环节是"宿主工具管线里那次真实 grep 的替换"——它无法从进程外驱动（桌面 app 不监听端口，钩子只在该宿主的 `tools/post-execute` 里跑），需要一次真实会话。

---

## 1 现状症状（带证据）

| 症状             | 证据                                                                              |
| -------------- | ------------------------------------------------------------------------------- |
| 图谱腿**一次都没被调用** | 全部遥测里 `intercept-replace:graph` 恒为 0；`intercept-replace:zg` 11 次                |
| 热路径白等 5 秒      | 符号类 grep 实测 5387ms = 2500(projectFor) + 2500(zg) + ~340(grep)；被替换那条 2895ms      |
| 引擎开库成本被重复付     | `list_projects` 实测 10.8–13.4s（钩子预算只有 2500ms）；但 `code_find` 的封装预算是 20000ms，能过    |
| 预热的钱白花了        | `index.js:645-651` 的 warm-up 发了 `list_projects`（budget 0），**只留 `ok` 和耗时，返回体丢弃** |
| 失败原因混在一个计数里    | `failed` 由任一腿置位，而代码注释自己写着"这两个占比的含义相反，不能混一个计数"（`index.js:1994-1996`）             |

因果链（现状）：

```
grep(pattern) ──► classifyPattern ──► symbol?
                                    ├─ projectFor(2500ms) ──► list_projects(实耗 10.8s) ──► 超时 ──► project=''
                                    │                                                    └─► if(project) 守卫拦下 ⇒ search_graph 从未被调用
                                    └─ zvec_grep_search(2500ms) ──► 冷 3.3s 超时 / 热 376ms 命中
```

---

## 2 改动项

### M1 预热结果复用（**第一因，优先做**）

- **位置**：`index.js:645-651`（warm-up）、`index.js:1161-1179`（`projectFor`）、`index.js:1554`（state 初始化）
- **现状**：warm-up 已经付掉了开库成本（budget 0，无秒表），但只把 `r.ok` 和耗时写进遥测，返回体丢掉。`projectFor` 于是每次在热路径现查 `list_projects`，用 2500ms 预算去等一个 10.8s 的查询。
- **改后语义**：
  1. `state.projectsListing`（字符串）缓存最近一次 `list_projects` 的文本。
  2. warm-up 成功后写入 `state.projectsListing = r.text`。
  3. `projectFor` 的查找顺序改为：  
     ① `session.project` → ② `state.projectsByCwd` → ③ **从 `state.projectsListing` 用既有 `projectFromListing(text, cwd)`（`index.js:1145`）解析** → ④ 仍找不到才现查 `list_projects`。
  4. 现查成功时回填 `state.projectsByCwd` 与 `state.projectsListing`。
  5. listing 有 TTL（建议 10 分钟）或为空 ⇒ 回落现查（避免长时间后 root_path 变了仍用旧表）。
- **为什么这么改**：不新增任何引擎调用，只是把**已经付过的钱**用上。命中后 `project` 非空 ⇒ `index.js:1997` 的守卫放行 ⇒ `search_graph` 第一次真正被执行。
- **验收**：新增计数 `list-projects:hot`（热路径现查次数）。修复后稳态应为 **0**；`intercept-replace:graph` 从 0 变为非 0。

### M2 预算分项

- **位置**：`index.js:72-118`（Config）、`index.js:194-215`（normalize / `defineLive`）、`index.js:1998` 与 `2010`（两腿调用点）
- **改后语义**：
  | 字段                  | 默认    | 用途                 | 备注                                                       |
  | ------------------- | ----- | ------------------ | -------------------------------------------------------- |
  | `graphBudgetMs`     | 6000  | `search_graph`     | 新增，volatile（可热改）                                         |
  | `zgBudgetMs`        | 4000  | `zvec_grep_search` | 新增，volatile；冷启 3.3s 要装得下                                 |
  | `interceptBudgetMs` | 2500  | —                  | 保留为兼容别名：未显式设 `graphBudgetMs` 时取它；面板标注"已并入 graphBudgetMs" |
  | `WRAPPER_BUDGET_MS` | 20000 | 封装工具               | **不动**（`code_find`/`code_callers` 这条路本来就通）               |
- **验收**：验收脚本用 `slow: true, slowMs: 4000` 的桩（慢引擎），符号类 grep 在 enforce=replace 下应**替换成功**（现状必失败）。

### M3 计数分腿

- **位置**：`index.js:2016-2024`（事件发射）、`index.js:1267`（`renderStats`）、`lib/client.js:540`（分母求和）
- **改后语义**：
  - 遥测事件：`replace-pass-failed` → **`replace-pass-failed:graph`** / **`replace-pass-failed:zg`**；同时保留 `replace-pass-failed` 作为两者之和（旧面板不至于空白）。
  - `stats.replace` 新增 `passFailedGraph` / `passFailedZg` 两个键（`stats` 的键名是面板契约，改键必须同步 `lib/client.js`）。
  - `recent` 列表的 outcome 增加 `failed-graph` / `failed-zg` 两态，并补中英 i18n 键（`lib/client.js:108-116` / `227-235`）。
- **验收**：`npm run check` 后，遥测里能直接分辨"图谱腿超时"与"语义腿超时"。

### M4 两腿按触发源二选一（**语义修正，不是重构**）

- **位置**：`index.js:1014-1034`（`classifyPattern`）、`index.js:1991-2026`（replace 路径）
- **现状的问题**：`q.symbol` 是从 grep pattern 里正则抽出的**裸标识符**，被同时喂给两个语义不同的引擎 —— 对图谱是对的输入，对向量检索是最差的输入（单个标识符的 embedding 几乎没有语义信号）。而"图谱失败才试 zg"这个兜底，恰好在图谱确实没有该符号时启动，正是语义近似最容易给噪声的时候。
- **改后语义**：
  1. `classifyPattern` 的 `kind` 扩一档：`symbol` | **`phrase`** | `literal`。
     - **phrase 新规则**：pattern 不含正则元字符（`| ( ) [ ] { } ^ $ * + ? \ .`）**且**含至少两个空白分隔的词、每词 ≥2 字符 ⇒ 判为 `phrase`（意图型查询）。
     - 现有 symbol / literal 规则**一字不改**（保守优先，误判成本更高的是把字面量搜索当语义查询）。
  2. replace 路径改为**三选一**：
     - `symbol` → **结构腿**：`projectFor` → `search_graph`
     - `phrase` → **语义腿**：`zvec_grep_search`，**query 取 pattern 原文**（不再是抽出来的标识符）
     - `literal` → 放行（不变）
  3. **两条腿互不为兜底**：结构腿失败就是失败，不自动转语义腿；语义腿只在判据命中时启动。
  4. deny 档（`deny-once`/`deny`）判据同步扩一档：`phrase` 不拦（语义近似不能用来"拒绝"一次合法搜索），只拦 `symbol`。
- **为什么这么改**：语义层的价值输入是自然语言问题与非代码文件，这些**不以 grep pattern 形态出现**；锁在"替换 grep"里，它的主力用法就被砍掉了。两腿解耦之后，各自的成败可独立归因。
- **验收**：`classifyPattern('retry logic').kind === 'phrase'`；`classifyPattern('a|b').kind === 'literal'`；`classifyPattern('cbmCall').kind === 'symbol'`。

### M4b（可选，强烈建议）新增语义层封装工具 `code_search`

- **位置**：`index.js:1781-1885`（封装工具注册块）
- **语义**：与 `code_find`/`code_callers` 同族 —— `code_search(query)`，`root`（工作区绝对路径）与 `limit` 由插件填，模型只管说自然语言问题。内部调 `zg_zvec_grep_search`。
- **理由**：`code_find` 已经证明"把路由键从模型手里拿走"这条路是通的；而 `zg_zvec_grep_search` 现在要求模型自己知道工具名、带 `root`、还得自己判断本仓有没有 `.zvec-grep` —— 三个负担都是模型容易出错的地方（实测 `code_find` 调用 0 次，说明"工具在手"不等于"会被用"）。
- **风险**：语义层默认关闭、需人点头 ⇒ 工具存在但链路未就绪时必须给出诚实的报错（照抄 `code_index` 的纪律：前提不成立即 throw，不静默降级成 grep）。

### M5 文案分层

- **位置**：`index.js:1375-1384`（`renderReplacement`）、`1354-1361`（`renderPassthroughMark`）、`1334-1341`（`renderInterceptHint`）、`877-884`（usage 段的语义路由段）、`lib/client.js:65 / 184`（enforce 说明）
- **现状问题**：`replace` 档把 zg 的命中与图谱命中用同一套文案呈现（`【替换自 语义层(zg) …】`），但 zg 返回的是**语义近似片段**，既不是符号定义，也没有 `qualified_name`/坐标。模型会拿近似结果当精确命中用。
- **改后语义**：
  - 语义层横幅必须写明：**这是语义近似命中，不是字面匹配、不是符号定义、不能当 `file:line` 锚点**；下一步指引改成"要坐标就 `code_find`，要调用关系就 `code_callers`"。
  - 结构层横幅保持现状并补一句"坐标来自索引，动手前先 `code_index`"。
  - 未替换标记（`markPassthrough`）区分"结构腿没命中"与"语义腿没命中"。
  - usage 段的语义路由段从"三层各有分工"改成两腿分工的表述，并把 `code_search`（若采纳 M4b）列进首选动词。

### M6 面板读数

- **位置**：`lib/client.js:65 / 108-116 / 142 / 184 / 227-235 / 540`
- **改后语义**：新增两行读数（结构腿失败次数 / 语义腿失败次数）；命中率分母按腿分开算（`540` 那行求和要跟着改，否则总数会算错）；enforce.replace.hint 文案改成两腿分工描述（中英各一版）。

### M7 技能文档（与 M4/M5 同批落地，否则模型读不到新语义）

| 文件                                                            | 补什么                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills/dsh-cbm-investigate/SKILL.md`                         | ① 新增「插件可能改写你的输出」小节：`【替换自 结构层(图谱)】`/`【替换自 语义层(zg)】`/`【未替换 · 原始 grep 输出】`/deny 拦截提示 四种横幅的判读与应对；② `code_setup {action:"install-zg"}`（~430MB，需人点头）与 `{action:"restart-adapter"}`（秒级重拉清单）；③ `code_index` 一次做三件事（建图 + 写 project 缓存 + 清脏台账）；④ 「zg 的命中不是编辑锚点」 |
| `skills/dsh-codebase-impact-analysis/SKILL.md`                | ① 硬规则 5 增补：插件会话台账（write/edit 记账）是新鲜度的第一权威，`cbm_check_index_coverage` 只能算逐路径证据；② Step 0 增补 `code_index` 的三重作用；③ Preferred tools 表 zg 行加「返回语义片段，不是锚点」；④ 补 `code_setup` 两个 action                                                                        |
| `skills/dsh-cbm-investigate/references/investigation-core.md` | DSH-specific guardrails 增补：输出改写横幅的判读、zg 命中禁当锚点                                                                                                                                                                                                        |

### M8 验收闸门（`checks/check-plugin.mjs`）

> 注意：该脚本验的是**已安装进 profile 的插件**（`profiles/<p>/node_modules/dsh-codebase-memory`），不是工作区副本 ⇒ 改完必须 `node scripts/sync.mjs <profile>` 再跑。

新增断言（用既有 `record(label, ok, detail)` 与 `makeStubProxy` 桩）：

| #  | 断言                              | 桩/手段                                                                          |                     |
| -- | ------------------------------- | ----------------------------------------------------------------------------- | ------------------- |
| 1  | 预热结果被复用：热路径不再现查 `list_projects` | 桩记 `calls`，断言 replace 路径后 `cbm_list_projects` 未被调用；计数 `list-projects:hot` = 0 |                     |
| 2  | 命中缓存 listing 时 `project` 非空     | 预置 `state.projectsListing`，断言 `search_graph` 被调用                              |                     |
| 3  | listing 过期/为空 ⇒ 回落现查            | 清空 listing，断言现查发生一次                                                           |                     |
| 4  | 慢引擎（4000ms）在 graph 预算内能替换成功     | `slow: true, slowMs: 4000` + `graphBudgetMs: 6000`                            |                     |
| 5  | 两腿预算互不串用                        | 语义腿慢时不应占用图谱预算（分别断言调用耗时上界）                                                     |                     |
| 6  | 失败计数分腿                          | 断言遥测同时出现 `replace-pass-failed:graph` 与 `:zg`，且汇总 = 两者之和                       |                     |
| 7  | `phrase` 判据                     | `classifyPattern('retry logic') === 'phrase'`                                 |                     |
| 8  | 元字符仍判 literal                   | \`classifyPattern('a                                                          | b') === 'literal'\` |
| 9  | 语义层横幅写明"不是锚点"                   | 断言 `renderReplacement(source='zg')` 文案含锚点禁令                                   |                     |
| 10 | 语义腿不与结构腿互为兜底                    | 结构腿失败时**不**调用语义腿（桩里断言调用序列）                                                    |                     |
| 11 | 技能文档不再漂                         | 断言两个 `SKILL.md` 均含 `替换自` / `install-zg` / `restart-adapter` / `code_index`    |                     |

---

## 3 契约变更对照

| 契约               | 现状                                             | 改后                                                                 | 连带                              |
| ---------------- | ---------------------------------------------- | ------------------------------------------------------------------ | ------------------------------- |
| 遥测事件             | `replace-pass-failed`                          | `+ :graph` / `+ :zg`（保留汇总）                                         | `renderStats` / `lib/client.js` |
| `stats.replace`  | 7 键                                            | 9 键（+`passFailedGraph` +`passFailedZg`）                            | 面板渲染                            |
| `recent.outcome` | 6 态                                            | 8 态（+`failed-graph` `failed-zg`）                                   | i18n 中英各 8 条                    |
| Config           | —                                              | +`graphBudgetMs` +`zgBudgetMs`（volatile）；`interceptBudgetMs` 降级为别名 | `normalize` / `defineLive` / 面板 |
| 工具面              | `code_index/code_find/code_callers/code_setup` | （M4b 可选）`+ code_search`                                            | usage 段、两个 SKILL.md             |
| 模型可见文案           | 两种横幅同构                                         | 结构层/语义层文案分层                                                        | `lib/client.js` i18n            |

---

## 4 向后兼容

- 全部新增字段是 **volatile**，设置页可热改，不需要重启宿主。
- `interceptBudgetMs` 保留可读；未显式设 `graphBudgetMs` 时以它为值 ⇒ 旧 profile 行为不变（想升级图谱预算去页面改 `graphBudgetMs`）。
- 遥测只增不改：旧键保留，面板不会因统计文件里没有新键而空白。
- `classifyPattern` 是导出函数且被 `check-plugin.mjs` 引用 ⇒ 新增 `phrase` 档属于**扩展**，旧断言（symbol/literal 的具体用例）不受影响。

---

## 5 验收流程

```bash
# 1. 改完工作区
node scripts/sync.mjs tauri          # 同步进 profile（技能文件也一并同步到用户 skill 根）
# 2. 重启该 profile 的 DSH 宿主，让插件与清单重新装载
# 3. 静态闸门
npm run check                        # patch/client/plugin/chain/tokens 五道
# 4. 动态观察（读数面板 + 遥测）
cat ~/.dsh/vendor/mcp-adapter/telemetry.counts.json
tail -f ~/.dsh/vendor/mcp-adapter/telemetry-$(date +%Y-%m-%d).log
```

**期望读数（修复后）**

| 指标                                         | 现在      | 目标                      |
| ------------------------------------------ | ------- | ----------------------- |
| `intercept-replace:graph`                  | 0       | > 0（结构腿真正参与）            |
| `list-projects:hot`                        | （新增）    | 稳态 0                    |
| `replace-pass-failed:graph` / `:zg`        | 混在一个键   | 各自可辨                    |
| 符号类 grep 端到端时延                             | 5387ms  | < 1500ms（项目已入缓存 + 预算分项） |
| `intercept-replace` / `replace-pass-dirty` | 12 / 75 | 台账改文件级后 dirty 比值下降      |

---

## 6 执行顺序与工作量

| 批次               | 内容                          | 理由                                          |
| ---------------- | --------------------------- | ------------------------------------------- |
| **第 1 批**（当天可完成） | M1 + M2                     | 这两项合起来就能让 `search_graph` 第一次真正跑起来；其余都建立在它上面 |
| **第 2 批**        | M3 + M4                     | 计数与判据；M4 需要 M2 的预算分项                        |
| **第 3 批**        | M5 + M7                     | 文案与技能必须同批，否则模型按旧语义理解新输出                     |
| **第 4 批**        | M6 + M8                     | 面板与闸门收口                                     |
| **可选**           | M4b + 台账文件级 + 重启前清孤儿 daemon | 前者是产品面新增，后两者是运维与语义深化                        |

---

## 7 明确不做（non-goals）

- 不动 `mcp-adapter`、`codebase-memory-mcp`、`zvec-grep` 三个上游组件。
- 不动 compaction 与 mneme 两条链（它们与本问题无关）。
- 不让插件自动安装 zg：430MB 必须人点头，`code_setup {action:"install-zg"}` 是显式入口，不进任何自动路径。
- 不把 `enforce` 的档位语义改掉：`off / deny-once / deny / replace` 四档与热改行为保持原样。
- 不引入新的后台常驻进程来解决"开库慢"——预热复用（M1）已经把这件事消掉了。

---

## 实施记录 5（19:19 会话日志核对后的三条修复）

用户按建议在 DSH 里问了一句「classifyPattern 在哪定义的？」，日志（`session.v4.log`）把因果链照得很清楚：

| 时刻 | 事件 | 耗时 |
|---|---|---|
| 19:18:40.0 | 宿主进程 53156 启动 → 预热 `list_projects` 开始 | — |
| 19:19:07 → 19:19:27 | **第一次 `code_find` → 失败**：`list_projects 查询失败（超时）：(空输出)` | **20.0s**（整点撞预算） |
| 19:19:21.8 | 预热完成 | 41s |
| 19:19:31 → 19:19:42 | `code_index`（模型自己走的）→ 709 节点 / 1604 边 | 10.8s |
| 19:19:47 → 19:19:52 | 第二次 `code_find` → 命中 | 5.1s |
| 19:20:01 → 19:20:06 | `code_callers` → 4 个 inbound | 5.1s |

**根因**：预热那一发 `list_projects`（41s，要开 7 个项目库）正在跑，热路径**又发了一发** live 查询（20s 预算）——两发抢同一个守护进程，后到的排队，20s 整点超时。所以这次失败与"重启宿主"强相关（重启后 ~45s 内的第一次查询必撞），与"新开 session"无关。

### 三条修复

| # | 改动 | 落点 | 断言 |
|---|---|---|---|
| 1 | **共享在飞的预热 promise**：`refreshProjectsListing` 把 promise 存进 `state.listingPromise`；`projectFor` 发现清单空且有在飞的一发时**等它**（`withBudget`）而不是再发一次。预算内没等到 ⇒ 返回**可执行处方**（"引擎正在预热，已跑 Ns——先跑 code_index，或稍后重试"），不再让模型等满 20s 换一句"超时" | `index.js` | `M1 预热在飞时共享那一发（不并发第二发 list_projects）`：桩里 `list_projects` 只被调 1 次，且 `code_find` 在预热期间就拿到了清单 |
| 2 | **图谱预算默认 6000 → 8000**：实测经适配层代理的一次图谱查询要 **5.1s**（引擎自己答 13ms —— 那 5s 是代理层固定开销），6000 只剩 900ms 余量 | `index.js` `DEFAULT_GRAPH_BUDGET_MS` | 面板读数同步 |
| 3 | **报表报出预热在飞**：`warm=pending` → `warm=pending(Ns)`，状态不再隐形（"还有多久"是模型该知道的） | `index.js` `report()` | `M1 预热在飞时报表报出 pending(Ns)` |

**顺带记录的两条实测**：`list_projects` 8.65s（开 7 个项目库，`work.db` 156MB）；引擎自身图谱读取热态 13ms。

---

## 实施记录 6（10-25，A：按命中过滤 + B：遥测隔离）

### A. 脏台账从"整会话让路"改成"按命中文件过滤"

现场依据：`replace-pass-dirty` 95 : `intercept-replace` 12 —— 编辑会话里等于把替换永久关闭，而绝大多数命中落在**没改过**的文件里。

| 改动 | 落点 |
|---|---|
| 新增 `dropDirtyRows(text, sess, cwd)`：解析 `search_graph` 的 JSON 行，按 `cols.file` 丢掉落在 `sess.dirty` 里的行；非 JSON（表格文本）原样返回，绝不误删 | `index.js` |
| 替换路径不再 `return next()`，而是先查图谱再过滤；**全被过滤**才记 `replace-pass-dirty` 并放行（语义从"会话脏"变成"有答案但都不可信"） | `index.js` replace 路径 |
| 横幅新增一行 `（已过滤 N 条本会话改过的文件…）`；`intercept-replace` 事件带 `dropped` | `renderReplacement` |
| 后台补刷照旧调度（过滤只是别把没改过的文件陪葬，坐标最终还得靠重索引） | 同上 |

断言：原「本会话写过代码 ⇒ 不换」改写成「写过**命中所在的文件** ⇒ 不换」（编辑 `index.js`，桩的命中也在 `index.js`），另加一条「脏的是别的文件 ⇒ 命中照换」（编辑 `some-other-file.ts`）。

### B. 验收不再污染真实遥测

现场依据：真实 `telemetry-2026-10-24.log` 里 **283 条 `intercept-replace` 全是 `project:"stub-*"`** —— 验收的桩写进了生产日志，现场归因不可读。

| 改动 | 落点 |
|---|---|
| 新增 `telemetryDir(cfg)` = `DSH_CBM_TELEMETRY_DIR` ‖ `cfg.adapterDir`；`telemetry()` / `sweepTelemetry()` / `telemetryPath()` 全走它 | `index.js` |
| `mount()` 默认把缝指到临时目录；显式传 `adapterDir` 的臂（W2/U5/O1）指回自己的目录；G9 的重试计数用第 5 参钉住自己的目录 | `checks/check-plugin.mjs` |

验证：跑完一轮验收后，真实 `telemetry-2026-10-24.log` 大小/mtime **未变**（240006 / 21:09），当天文件只有宿主自己的一条 `cbm-warm ok:true ms:41497`。

**已知残留**：`cbm.json` 仍写在真实 adapterDir（A 臂要验真实链路），验收会让宿主的清单 watcher 重拉一次适配层进程（几秒）。彻底隔离需要给每个臂配临时 adapterDir + 真 cbm 路径，留作后续。

---

## 实施记录 7（10-25 11:5x，现场第一次真实替换 + 两处修补）

重启后（宿主 18408 @11:40），agent-chat 会话 `f2a0fb7b` 里出现了**第一次真实图谱替换**：

```
11:57:22  intercept-replace  symbol=Memory  source=graph  project=C-Users-kingdee-work-agent-chat
会话日志： 【替换自 结构层(图谱) · 仓 agent-chat · 14 行】grep "Memory" 的原始输出已丢弃…
```

`intercept-replace:graph` 从 0 变 1 —— 从 10-16 起一直为 0 的那个计数，终于动了。

**同会话暴露的新问题**：3 次 symbol 决策里 2 次 `replace-pass-failed`（`ServerDeps` 11:53:34、`RunLogStore` 11:57:36）。第一次正好落在后台补刷窗口（`dirty-refresh-scheduled` 11:53:26 → `dirty-refresh-done` 11:54:15）——引擎在重建索引，图谱查询排队超时。

| 修补 | 落点 |
|---|---|
| 引擎正在为本工作区重建索引时**直接放行**，记 `replace-pass-refreshing`（新增 `state.refreshing.has(cwd)` 守卫） | replace 路径 |
| `replace-pass-failed` 带 `err` 原文（`(超时)` 或代理返回的错误文本） | 同上 |
| `stats.replace.passRefreshing` + 面板 `recent.pass-refreshing` 文案 | `renderStats` / `lib/client.js` |

**关于「grep 没被替换成 zg」**：那条 pattern 是 `"(admin|bank)", "bank", "read", *` —— 引号、括号、竖线、星号、空格俱全，分类器判 **literal**（用真函数复核过）。字面量/正则一律放行是设计：那类搜索里 grep 才是对的工具。另外 v0.15.0 起**语义层已不在替换通道**，替换源只有图谱——"替换成 zg"这个预期本身已经不成立。

---

### 一句话总结现在的真实语义

`enforce=replace` 只换**符号类** grep，换的是**图谱命中**；语义层不参与替换，改由 `code_search` 显式调用，回来的片段明确标注"不是锚点"。

## 附：台账文件级（第二优先级的语义深化，未列入上表批次）

现状 `ledgerStale`（`index.js:1195`）只看"本会话有没有 write/edit 过"，会话一脏，**所有**检索都被放行——在开发本插件的会话里等于把替换永久关闭（实测 `replace-pass-dirty` 75 : `intercept-replace` 12）。

改成文件级：`grep` 的 `path` 命中 `sess.dirty` 才放行；未命中的路径坐标仍然可信。涉及 `interceptPremises`（`index.js:1509-1518`）与 `coversWorkspace`（`index.js:1063-1070`）的顺序，需要一并决定"path 缺省（全仓搜索）"时怎么办 —— 建议**缺省按脏处理**（保守），因为无法证明目标文件没被改过。
