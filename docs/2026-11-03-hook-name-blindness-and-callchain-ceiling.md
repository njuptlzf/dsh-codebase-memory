# grep 钩子为什么瞎了，以及调用链为什么不做成 100% 钩子

- 日期：2026-11-03
- 版本：dsh-codebase-memory v0.23.1（本文写作时的工作树状态）
- 状态：**第一步已实施（2026-11-03）**——名单默认值、`outputMode` 闸门、失配读数、回归断言四处全落，见 §10；本文 index.js 行号已按改后代码校准
- 起因：用户提出「参考 dsh-ops，能不能基于事件钩子——每次系统调用 grep 后用 dsh-cbm 查调用链，这样 100% 会用上」

## 0. 结论（TL;DR）

1. **钩子不需要新建，它已经在跑，但它今天一次都没看见 grep。** `tools/pre-execute`（deny 系）与 `tools/post-execute`（replace 系）都是宿主真实发射的事件，本机 profile 也开着 `enforce: replace`。断点在入口第一道闸：`isGrepLike(exec.name, cfg.interceptTools)` 是**精确名单**，默认 `'grep,glob'`（改前；第一步已把默认扩成四项，见 §7）（index.js:125 / index.js:1271）；本机 dsh-ops 把内置 grep/glob 收走、发布 `ops_grep` / `ops_glob`，两个名字都不在名单里 ⇒ 整条通道静默。
2. **断点不止一处，是同一道闸的三个消费者**：deny 钩子（index.js:2342）、replace 钩子（index.js:2428 → `interceptPremises` index.js:1898）、近失遥测（index.js:1942）。今天本机既没有 `intercept-*` 也没有 `near-miss-symbol`，而写入记账 `dirty-record` 正常（5 条）——因为 dsh-ops 只替换 read/glob/grep，`write`/`edit` 仍是宿主原名（`WRITE_TOOLS` index.js:89 无恙）。**这正是"名字闸失配"的指纹：同一份名单，过的过、瞎的瞎。**
3. **切档时刻可定位**：最后一次 `intercept-replace` 是 2026-11-02 13:55（本机时区），最后一次 `near-miss-symbol` 是 14:02；`profiles/tauri/node_modules/dsh-ops/package.json` 落盘 15:29，profile 备份 15:15。此后 11-03 全天 intercept=0。插件没改，宿主工具身份改了。
4. **「每次 grep 都查调用链」被否。** 钩子能承诺的 100% 只有一句：符号形 grep 的**输出**必然来自图谱。调用链要 `qualified_name`、要看意图、要付 N 倍查询与 token，这三件事钩子都不具备（§6）。
5. **最终形成"能落地的两步"**：第一步是名单与闸门的三处小改（可当场做完）；第二步不是"上调用链"，而是"先测出基线"——今天连符号形 grep 占多少都不知道，任何 100% 的诉求都没有可验收的形状。

## 1. 来龙去脉

| 时间 | 发生了什么 | 结果 |
|---|---|---|
| 13:44 | 用户问（m00001）：参考 dsh-ops，能否在 grep 后用钩子调 cbm 查调用链，"这样 100% 会用上" | 核对代码：钩子已存在（杠杆 ②/②b），但今天遥测 0 intercept |
| 13:57 | 用户追问（m00078）：钩子看到 grep 到底调 `cbm_*` 还是 `code_find`/`code_callers`？是不是名单从 `grep,glob` 变成 `ops_grep` 才对不上 | 答：只调 `cbm_search_graph` 一发；名单是精确匹配，实测 `ops_grep → false` |
| 14:00 | 用户追问（m00111）：`cbm_search_graph` 和 `code_find`/`code_callers` 有什么区别、谁决定调用、"由模型决定？那还不如做成事件钩子 100% 触发" | 分层澄清（§5）+ 否掉调用链钩子化（§6）+ 给出两步（§7） |
| 14:04 | 用户要求：先把优化文档落盘，按来龙去脉说明为什么收敛成两步 | 本文 |
| 11-03 14:12 | 用户批准（m00157）"开工第一步" | 四处改动落地：index.js +55、checks +30，默认名单/聚合闸/失配读数/回归断言 |
| 11-04 09:44 | 用户说"继续"（m00421）：定性首轮红灯 | 6 条既有 flake + 2 条我写错的断言（详见 §10）；修正后全量 plugin 套件 tauri/web 各 **198/198** |

一句话概括这条演进线：**问题从"要不要新建一个钩子"开始，查到中途发现钩子早就在，只是被一道名字闸挡在门外；于是"100% 触发"的诉求被拆成两半——能 100% 的那半（符号形 grep 的输出来源）先修闸，不能 100% 的那半（调用链）退回模型按需。**

## 2. 证据链

### 2.1 遥测（`~/.dsh/vendor/mcp-adapter/telemetry-*.log`，按 event 计数）

| 日期 | intercept-replace | near-miss-symbol | dirty-record | wrapper-call |
|---|---|---|---|---|
| 10-30 | 1 | 26 | 39 | 2 |
| 10-31 | 0 | 2 | 3 | 0 |
| 11-02 | 4 | 20 | 74 | 2 |
| **11-03（切档后）** | **0** | **0** | **5** | 0 |

11-03 本轮会话里我自己发过多次 `ops_grep`，其中两次 pattern 是纯标识符（`classifyPattern`、`pre-execute|post-execute|…`），事件面**一条都没多**。

### 2.2 可复现的最小判定（在 profile 安装的那份包里直接 import）

```
cd ~/.dsh/profiles/tauri && node --input-type=module -e "
import { isGrepLike, classifyPattern } from './node_modules/dsh-codebase-memory/index.js'
const list = ['grep','glob']
for (const n of ['grep','ops_grep','ops_glob','glob']) console.log(n, '->', isGrepLike(n, list))
console.log('with ops:', isGrepLike('ops_grep', ['grep','glob','ops_grep','ops_glob']))
console.log('classify:', JSON.stringify(classifyPattern('classifyPattern','index.js')))"

grep      -> true
ops_grep  -> false
ops_glob  -> false
glob      -> true
with ops  -> true
classify  -> {"kind":"symbol","symbol":"classifyPattern"}
```

分类器判它是符号（`kind: symbol`），名字闸判它不是 grep。**断点在闸，不在判据。**

### 2.3 配置现场

- `~/.dsh/profiles/tauri/cordis.patch.yml:195` 只有 `enforce: replace` 与 `telemetry: true`，**没有覆盖 `interceptTools`** ⇒ 用默认 `'grep,glob'`。
- dsh-ops 侧：`lib/policy.js:20` `publicToolName = 'ops_' + raw`；`lib/capabilities/replacements.js:2-4` 可替换的官方工具只有 `read / glob / grep`；`lib/official-tool-config.js:28` 的报错原文就写着 "choose read, glob or grep"。

## 3. 代码现场：同一道闸的三个消费者

| 消费者 | 入口闸 | 失效表现 |
|---|---|---|
| deny / deny-once 钩子 | `index.js:2340` 注册，`index.js:2342` 判 `isGrepLike(exec.name, cfg.interceptTools)` | 永不 deny，模型照常拿 grep 原文 |
| replace 钩子（本机档位） | `index.js:2424` 注册，`index.js:2425` 判档位，`index.js:2428` → `interceptPremises` `index.js:1898` 判名字 | 永不替换横幅，`intercept-replace` 计数归零 |
| 近失遥测 | `index.js:1942` 同样过 `isGrepLike` | `near-miss-symbol` 归零 ⇒ 失去"符号意图被整条放行"的观测口 |

对照：写入记账在 `index.js:1925` 走 `WRITE_TOOLS = ['write','edit']`（index.js:89），dsh-ops 不替换 write/edit，所以 `dirty-record` 今天仍然有 5 条。**这条没坏，恰好证明"坏的不是链路，是名单"。**

## 4. 根因

### R1 名单是"宿主工具身份"的启动期假设，而身份是别的插件可以改的

`interceptTools` 的语义是"哪些工具算搜索工具"，实现却是精确字符串比对。DSH 里工具身份不是宿主独占的：dsh-ops 通过 `replaceTools` 显式收走官方 read/glob/grep 并发布 `ops_*`。插件此前只在"宿主提供内置 grep"的世界里验证过（10-30 至 11-02 上午的遥测全绿），换身份就整条静默，且**不报任何错**——这是最糟的失效形态：设置页显示 `enforce=replace`，读数面板一片干净，实际通道为零。

### R2 失效不可见：没有"闸没对上名字"的自检

`code_setup` 与报表会报链路（adapter/引擎/project），但没有任何一行说"当前宿主发布的搜索工具是 X/Y，你的名单是 grep/glob，一个都不匹配"。R1 的失配之所以能存活一整天，缺的是这一行读数，不是缺代码。

### R3 这次不是新需求，是旧通道的回归

用户提议"基于事件钩子，grep 之后用 cbm 查调用链"时，设计文档里杠杆 ② 的定义就是"符号类 grep 可拦截（deny 系）或直接把输出换成图谱命中（replace）"（index.js:1180-1183）。所以这次讨论的增量只有一件事：**把"钩子能不能查调用链"这个边界画清楚**（§6），其余是把已有通道恢复供电。

## 5. 三层工具的分工（澄清为什么会想到"100% 钩子"）

| | 是什么 | 打给引擎的底层调用 | 模型拿到什么 | 谁发起 |
|---|---|---|---|---|
| `cbm_search_graph` | 引擎原生 BM25 符号检索（长尾工具，经 `mcp__cbm__mcp` 代理，args 自带 project） | 它自己就是底层 | qualified_name / file / lines 候选行 | 模型，或钩子（index.js:2371、index.js:2462） |
| `code_find` | 封装动词（index.js:2214） | `search_graph`(format=json) → `get_code_snippet`（index.js:2236、index.js:2248） | 候选 + 首条源码 + 两道新鲜度告警（脏台账 / digest behind） | **只有模型** |
| `code_callers` | 封装动词（index.js:2290） | `trace_path`（inbound/outbound/both，depth 1–6）（index.js:2313） | 调用边逐跳 | **只有模型** |

也就是说：**钩子用的是最底层那一发检索，两个封装动词完全在钩子之外，由模型自己选**（工具描述 + 常驻段 + 条件 hint 三个软性推手，见 docs/2026-11-01-tool-hit-rate.md）。这个"由模型决定"的事实，正是用户提出"那还不如做成事件钩子 100% 触发"的动因——问题不在分层错，而在封装动词的触发率不可控。

## 6. 为什么"每次 grep 都查调用链"不成立

1. **钩子看不到意图，只看得到 pattern。** grep `McpServerDecl` 可能是在找定义，也可能是在数引用点。`trace_path` 对前者是多余噪声，对后者才是答案；而 replace 通道是**丢弃原文**的硬替换（index.js:1772 "grep 的原始输出已丢弃"），把带偏的内容换上去，模型分不清这是事实还是猜测。deny 档也救不了：宿主契约里 `pre-execute` 只能 allow/deny/cancel/ask，**不能改写参数**（index.js:1189，实参在钩子前已 deepFreeze），所以钩子无法替模型把"我要调用链"这件事问清楚。
2. **钩子手里没有 `qualified_name`。** `search_graph` 一次返回 5 个候选，`trace_path` 要的是其中一个。逐个 trace = 每次符号 grep 多 N 发查询。热路径实测代理单发 30–60ms（index.js:2333），但预算上限是 `DEFAULT_GRAPH_BUDGET_MS = 8000`（index.js:63），N 发串起来就是最坏 8s 量级，还在每次工具调用的关键路径上——当年正因为这个才把 `cli`（冷启动 5.5–8.3s，index.js:1200）永久排除在钩子外。token 侧同样翻倍：调用边表要进上下文，而它服务的是"改这里会不会炸"，不是"这符号在哪"。
3. **成本位置不对。** 调用链的真实消费者是改前评估（低频、场景明确），把它做成每次 grep 的默认附属，等于对 90% 的查找收 10% 场景的税。封装动词 `code_callers` 已经存在且 project 自动填，需要时一次调用就能拿全——这已经是"最低摩擦"的形态，钩子再加一层只会加延迟和噪声。

**能承诺的 100% 只有一句**：修好名字闸之后，**符号形 grep 的输出 100% 来自图谱**（deny-once 是同符号一次、replace 是每次）。做不到的是"所有代码提问 100% 走图谱"，也做不到"每次 grep 附带调用链"。

## 7. 能落地的两步

### 第一步（已实施 2026-11-03）：恢复供电，并把闸门做对

| # | 改动 | 落点 | 理由 |
|---|---|---|---|
| 1 | 默认名单加 `ops_grep,ops_glob` | 常量 `DEFAULT_INTERCEPT_TOOLS`（index.js:56）→ `Config.interceptTools`（index.js:125）与 normalize 回退（index.js:268）共用它 | 任何装了 dsh-ops 的宿主开箱可用；volatile 字段，设置页改完即生效，无需重启。**两处默认原来各写各的 `'grep,glob'`，只改 Config 会被 normalize 打回** |
| 2 | `outputMode` 非 `content`/`paths` 时不替换 | `wantsAggregateOutput`（index.js:1282），消费点：`interceptPremises`（index.js:1901，管 replace + near-miss）与 deny 钩子（index.js:2343） | `ops_grep` 有 `outputMode: content/count/files_with_matches/summary/details`；模型要"几个文件用到"时换成图谱表就是答非所问，且是丢原文的硬替换。allowlist 语义（不认识的模式一律当聚合放行）= 未来新增聚合值默认不破坏原文。`paths` 也算放行是因为 `ops_glob` 从不出现 `content`，否则整条通道对 glob 失效 |
| 3 | 名字失配自检一行 | 报表行 `名单核对`（index.js:804），数据来自 `observeCall` 采集（index.js:1919）+ `SEARCH_NAME_RE`（index.js:1291）+ `state.searchNames`（index.js:1965） | 治 R2：把"宿主实发了什么搜索工具名 vs 名单里有什么"变成可见读数，下次换身份当场看见。采集闸是**正则**（`grep\d*$/glob\d*$`，只观测不决策），刻意不复用拦截名单，否则读数跟着盲区一起瞎 |
| 4 | 回归断言 | `checks/check-plugin.mjs`：G 臂聚合判定正反例、R 臂 4 条（默认名单照换 ops_grep、`outputMode=count` 不换、窄名单时报表点名 ops_grep、窄名单原文不被偷换） | 默认名单、聚合放行、失配读数三件事都有可失败断言，下次改名不再靠人查 |

不改的部分：`replace` 的查询仍然是**一发** `search_graph`，不追加 `trace_path`；`classifyPattern` 判据不动（保守归字面量是对的，误拦一次配置搜索比漏拦一次符号搜索贵，index.js:1207）。

### 第二步（不是"上调用链"，是"先有基线"）

第一步生效后跑一到两周，用遥测回答三个还没数据的问题：

- 符号形 grep 在全部搜索里占多少（分母）；
- `intercept-replace` / `replace-pass-*` / `near-miss-symbol` 的比例（替换率与逃逸口）；
- 模型在替换之后是否真的接着调 `code_callers`（`wrapper-call` 计数）。

**开工条件**（防止凭感觉重开，格式照搬 docs/2026-11-02-poll-vs-watch-decision.md §6.3）：只有当遥测显示**被替换的符号查询里相当比例随后又自己去 trace 调用边**，才做条件式扩展；形态二选一，都不做"每次 grep 默认附带"：

- **条件式**：最近一条用户话术命中影响面词（谁调用/影响/改/破/break/impact，即 `CODE_QUESTION` 的那一支，index.js:1782）时，对**首条**命中追加一发 `trace_path`；
- **动词式**：加 `code_impact`（trace both + 受影响文件），即原 docs/2026-11-01-tool-hit-rate.md 的 P2-1，由模型按需调用，代价是每个请求 +200–300 token 的 schema 税。

## 8. 取舍与风险

- **为什么不自动探测宿主工具名**（例如按 schema 形状识别"这是 grep 类"）：形状匹配会把别的插件的搜索工具也吞进来，误拦一次的代价是模型白多一个往返并失去对插件的信任（index.js:1207 的原话）。名单 + 可见读数比聪明匹配更可控。
- **`ops_grep` 的 `pattern` 与内置 grep 语义有差**：`glob` 过滤是数组、`path` 锚在会话 cwd、且 `limit` 语义不同。`coversWorkspace`（index.js:1315）按 `path` 判越界的逻辑对 `ops_grep` 同样成立，但验收臂要各测一次，不能只测内置那份。
- **风险仍在不可见**：如果哪天 dsh-ops 把 `ops_grep` 换成别的名字，同样的静默会重演。所以第一步第 3 项（读数）与第 1 项同等重要，别只做配置。
- **不做什么**：不把调用链塞进钩子；不为命中率再加动词（每加一个都收 schema 税，且不解决"想到"的问题）；不把 hint 写长。

## 9. 验收指标

| 指标 | 诊断时（11-03） | 第一步后目标 | 第一步后实测 |
|---|---|---|---|
| `intercept-replace` 日计数 | 0 | 与当日符号形 grep 数一致（>0 即恢复供电） | **恢复**：重启后真宿主（pid 74272）跑一发 `ops_grep` 即出 `intercept-replace:1` + `intercept-replace:graph:1`，R 臂 stub 亦 =1 |
| `near-miss-symbol` 日计数 | 0 | 恢复 10-30 量级（20+） | 记账通道**已复通**（判据在 index.js:1942，走的是同一道 `isGrepLike`，名单修好后它就能看见 `ops_grep`）。今天读数仍是 1，因为近失的定义是"**字面形但含符号形支**"（`q.kind==='literal' && q.nearMiss`，即混合交替式 / 超 4 支）——纯符号形现在被拦下换成图谱，计成 `intercept-replace` 而不是近失。10-30 那天是 20+，取决于当天有多少这种写法，不该拿来当本机基线 |
| 默认名单覆盖 `ops_grep/ops_glob` | 否 | 是（checks 锁死） | **是**，R 臂「ops_grep 在默认名单下照样被换」PASS |
| `outputMode != content` 被替换的次数 | 未测（通道全盲） | 恒为 0 | **恒为 0**，G 臂 + R 臂「聚合读数不被偷换」PASS |
| `code_setup` 里"宿主搜索工具名 vs 名单"读数 | 无 | 有，且失配时明说 | **有**，R 臂「名单核对点名 ops_grep」PASS（断言同时验"窄名单时原文没被偷换"） |
| 调用链是否进钩子 | 否 | **否**（本文明确不做，除非 §7 第二步开工条件成立） | 否，未动 |

## 10. 实施状态

- **第一步四处改动已落地**（2026-11-03 写码 / 11-04 跑绿）：`index.js` +53/−4、`checks/check-plugin.mjs` +38/−1，本文行号即改后行号；已 `node scripts/sync.mjs`，装包与仓库字节一致。
- `npm run check` 五路全绿（日志 %TEMP%/cbm-full.log）：PATCH OK / CLIENT OK / **PLUGIN 198/198 × tauri、198/198 × web** / CHAIN OK / TOKENS OK（臂 B 代理冷缓存 1270 tokens，省 3057/请求）。新增 4 条断言（G 聚合判定 + R ops_grep 照换 + R 聚合不换 + R 名单核对点名）全绿。
- 首轮全量（11-03）：tauri 192/198、web 195/198。红的一共 6 条（tauri）/3 条（web），其中 **2 条是我写的断言自身有问题**（见下两条），剩下 4 条是既有的时序 flake：D hint-behind（两 profile 都挂）、S 轮扫×2、M1 pending×1（只 tauri）。判定依据：同一轮里走“现算 digest”的兄弟断言是绿的，只有靠 `digestVerdict` 异步缓存那条挂；11-04 复跑 198/198 双向全绿，四条一次都没复现。首轮还先撞了个前置事故：没 `sync` 就跑，新导出在装包里不存在，套件崩在 `TypeError: wantsAggregateOutput is not a function`。
- **踩到的测试坑（记下来，下次写钩子断言别再犯）**：宿主 `tools/post-execute` 是**数组、按注册序执行**，本插件注册了两条——[0] 记账 `observeCall`（index.js:2407）、[1] replace 硬替换（index.js:2424）。只取 `[1]` 的测试永远喂不到 `state.searchNames`，报表就成了"本进程还没跑过搜索"。断言要按序把两条都发（见 R 臂 `rbObserve`/`rbSwap`）。
- **第二条测试坑**：近失/替换计数是 mount 级 `state.counts` 进程内累计，借用了已有 mount 的新断言会把老断言的 `intercept-replace=1` 顶成 2。新断言一律独立 mount + 独立 stub project（R 臂的 `ro`）。
- **checks 跑的是 profile 安装副本**（`checks/check-plugin.mjs` 里的 `installedIn(profile)`），仓库改完必须先 `node scripts/sync.mjs`，否则 `TypeError: wantsAggregateOutput is not a function`。sync 提示"插件运行时改动需重启对应 profile"⇒ 本机宿主进程里的插件还是旧默认名单。
- **热验证已过（2026-11-04 重启 tauri profile 后，真宿主 pid 74272）**：① `ops_grep(pattern="wantsAggregateOutput", path=<本仓>)` 的模型可见输出被整体换成图谱横幅「【替换自 结构层(图谱) · 仓 dsh-codebase-memory · 8 行】grep … 的原始输出已丢弃」，命中 `…wantsAggregateOutput Function index.js 1282-1285`——新默认名单在活进程里生效；② 同一 pattern 加 `outputMode="count"` 时**原文保留**（checks 4 / docs 3 / index.js 3）——`wantsAggregateOutput` 闸门生效；③ `code_setup` 报表现场读数：`触发层: … intercept=grep+glob+ops_grep+ops_glob`、新行 `名单核对: 实发搜索工具=ops_grep  名单=grep+glob+ops_grep+ops_glob  ok`、`遥测计数 … intercept-replace=1 intercept-replace:graph=1`、仓库表 `替换=1 拒绝=0`；当日 `telemetry-2026-11-04.log` 多出 `intercept-replace`（ts 2026-11-04T02:32:17.703Z）。
- 随发布同步：`package.json` 0.23.1 → **0.23.2**，README.md:345 / README.zh.md:338 的 `interceptTools` 默认值行改写（含 ops_* 来由与聚合放行），README.md:373 / README.zh.md:366 的臂 R 说明补三条新断言 + 「post-execute 臂要按注册序把每条处理器都发一遍」这条测试口径，两版 README 的安装 tag 行跟着版本号走（仓库惯例：release commit 同时改 README/README.zh/package.json）。
- **发布产物装机验证（2026-11-04 17:36）**：两个 profile 的 pin 之前**一直停在 `#v0.21.0`**（三个版本没跟，此前全靠 `scripts/sync.mjs` 覆盖 4 个运行时文件撑着）。已把 `~/.dsh/profiles/{tauri,web}/package.json` 的 pin 改成 `#v0.23.2` 并用宿主自带 pnpm 11.7.0（`AppData/Roaming/dsh-tauri/dependencies/pnpm/bin/pnpm.cjs`，本机 PATH 上没有 `dsh`/`pnpm`）各装一遍；lock 现指向 `codeload.github.com/njuptlzf/dsh-codebase-memory/tar.gz/76f1a78…`，安装副本 `index.js`/`lib/client.js`/`cordis.patch.yml` 与仓库 sha256 前 12 位逐一相同（`feaca207d564`/`8ae236d0f780`/`6e9e7faf5b66`）。**发布副本（不是 sync 过的 4 文件）跑 `node checks/check-plugin.mjs tauri` = 198/198**，快四路 PATCH/CLIENT/CHAIN/TOKENS 全绿。备份：`package.json.bak-v0232-20261104-1736`、`pnpm-lock.yaml.bak-v0232-20261104-1736`。
- **新踩到的一条，值得记**：装完当场复核，`code_setup` 报表里**没有 `名单核对` 行、也没有 `轮扫` 行**（两行的有无是版本指纹：`轮扫` 自 v0.23.0 起才有），同时 `ops_grep(pattern="usageSection", path=index.js, outputMode="count")` **仍被整体换成图谱**（v0.23.2 应当放行原文）⇒ 给这个会话执行工具的进程吃的是 **v0.23.0 之前的模块**。同一条报表里 `intercept=grep+glob+ops_grep+ops_glob` 并不是新默认生效的证据：`profiles/tauri/cordis.patch.yml:197` 有一行 `interceptTools: grep,glob,ops_grep,ops_glob` 的持久覆盖（先前测设置页热字段时落盘的），旧模块读它也能凑出四个名字。**教训：`sync` 只换磁盘上的文件，插件模块在宿主进程 boot 时 import 一次；判断"活进程吃的是哪版"要靠报表自身的版本指纹（哪几行存在），不能看某个字段的值——那个值可能被 profile 里的覆盖项顶着。** 复核口径（重启整个应用后应同时成立）：`code_setup` 出现 `名单核对: 实发搜索工具=… ok` 行，且 `outputMode=count` 的符号形 grep 原文保留。
- 第二步（基线读数 → 条件式 `trace_path` 或 `code_impact` 动词）**未开工**，开工条件见 §7。
- 参考：docs/2026-11-01-tool-hit-rate.md（触发面三层与 P2-1 `code_impact`）、docs/2026-11-02-lifecycle-wiring-audit.md（§1.4 宿主真实事件面、§2 dsh-ops 五个做法）、docs/2026-11-02-poll-vs-watch-decision.md（§6.3 开工触发条件的写法）。
