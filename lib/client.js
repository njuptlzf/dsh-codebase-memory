/* dsh-codebase-memory — 客户端半部：把 host Config 的 volatile 字段挂到设置页。
 *
 * 形态照抄官方最小先例 @deepseek-ai/dsh-client-ui-settings-agent-loop 的 lib/client.js：
 * 一个手写的 `window.__ModuleLoader__.load({ id, factory })` bundle，**没有构建步骤**
 * （@deepseek-ai/dsh-client-modules 原样读盘、算 rev、走 combo 路由发出去）。
 * `react` / `react/jsx-runtime` / `@deepseek-ai/dsh-client-ui-primitives` 是宿主注入的
 * 隐式 baseline，可以直接 require；其余模块要写进 package.json 的 `dsh.client.external`。
 *
 * 挂的槽是 `plugins.row.config`，key = `${包名}#${row id}`（见 cordis.patch.yml 的 row id
 * `codebase-memory`）。plugin-manager 只在 ledger 里有这个 key 时才在那一行渲染「配置」按钮，
 * 并且只有当 host 的 `settings/describe` 里存在同名 namespace 时才把 form 传进来 —— 所以外层
 * 用 `ctx.configForms.whileServed([ENTRY])` 兜住：host 没 compose 这个 bundle 时页面不留痕迹。
 *
 * 写路径是九个页面可写字段：八个即时热改（enforce / telemetry / interceptBudgetMs /
 * interceptTools / contextHint / dirtyTracking / graphBudgetMs / zgBudgetMs，v0.9.0 起全部 volatile 且决策点现读；
 * v0.15.0 起两条检索腿各自定价，interceptBudgetMs 降级为「跟随基准」）
 * + zgEnabled（v0.11.0，页内开关两步确认；清单重拉靠 code_setup {action:"restart-adapter"}
 * ——v0.12.0 起不必重启宿主——诚实靠 stats 三轴状态行 + stats.adapter 进程轴异常行；
 * 开关开着时 .zvec-grep/ 的 gitignore 提示常驻）；
 * `stats` 是 host 推来的**只读读数**（volatile 字段
 * 里的 JSON 字符串，dsh-settings describe 的 plainConfig 实时解引用，不落配置文档）——
 * 面板渲染它但不给编辑控件。读数用卡片栅格（大数字 + 指标行 + 占比条），样式抄
 * dsh-mneme 状态页（@modusensus/dsh-mneme lib/client.js 的 status.css）：只用宿主
 * --dsw-alias-* 变量，亮暗主题免适配。host 侧 Config 里没标 `.volatile()` 的字段，
 * dsh-settings 的 write() 会直接抛 "not volatile"，所以这个面板有意只暴露可热改的那几项。
 *
 * 布局纪律（v0.10.0，用户验收 m03734）：①标签与控件**同行**——primitives.Switch 的
 * label prop 在宿主上不渲染可见文字，说明文字孤零零挂在下面根本分不清归谁，所以行内
 * 自铺 span 标签；②恢复按钮叫「恢复此项」并紧贴自己的控件，杜绝和别处的恢复默认
 * 混淆；③页面按限制强度分层重排：软引导层 → 硬拦截层 → 检索两层（语义层开关 +
 * 状态行——状态由 stats.zg 清单事实 × zgEnabled 页面开关 × stats.zgInstalled 包实测
 * 三轴推导，轴间差写成待办动作）→ 记账与遥测 → 检索参数。
 *
 * 措辞纪律（v0.8.0 验收）：codebase-memory（结构层）与 zvec-grep（语义层）是**并存的
 * 两层能力**——replace 档只是单次替换内的取数顺序（图谱先答、语义补位），文案不得
 * 写成二选一。
 */
window.__ModuleLoader__.load({
  id: 'dsh-codebase-memory',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { jsx, jsxs } = require('react/jsx-runtime')
    const p = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'codebaseMemory'
    const ENTRY = 'codebase-memory' // host 侧 settings namespace = profile entry id
    const ROW_KEY = 'dsh-codebase-memory#codebase-memory' // plugins.row.config 的 key
    const MODES = ['off', 'deny-once', 'deny', 'replace']

    const DICTIONARY = {
      zh: {
        title: '代码检索拦截',
        summary: '按层配置：软引导 → 硬拦截 → 检索两层 → 记账与遥测 → 检索参数。六个字段即时热改，语义层开关页内可改（重启进清单）；运行读数常驻，无需重启。',
        loading: '正在读取配置…',
        unavailable: '当前宿主没有暴露该插件的配置项（需重启 DSH 让配置文档重新组合）。',
        'enforce.label': '触发模式',
        'enforce.off': '关闭',
        'enforce.off.hint': '不拦 grep：只靠索引工具与提示词软引导。',
        'enforce.deny-once': '拒一次',
        'enforce.deny-once.hint': '符号形 pattern 首次 grep 被拒并回给你图谱命中；同一会话同一符号不再拦。',
        'enforce.deny': '持续拒绝',
        'enforce.deny.hint': '符号形 pattern 每次 grep 都被拒。误报代价最高，先看遥测再上。',
        'enforce.replace': '换成检索',
        'enforce.replace.hint': '符号形 pattern 的 grep 照常执行，但模型看到的输出整体替换成**结构层（代码图谱）**的命中；图谱没命中或超时就保留原输出。语义层（zvec-grep）不参与替换——它答的是自然语言问题，走 code_search 显式调用（v0.15.0 起）。不产生报错，硬替换。',
        'markPassthrough.label': '未替换也标记',
        'markPassthrough.hint': 'replace 档下没换成的 grep（无命中 / 台账脏 / 查询失败）默认原样放行。打开后保留原输出但在前头盖一个「未替换」徽标，说明是哪一种让路——默认关，因为原输出带个前缀标签可能反而干扰模型。',
        'telemetry.label': '记录拦截遥测',
        'telemetry.hint': '拦截/放行计数写进插件自己的存储，code_setup 会报出来；关掉只是不再记数，不影响拦截本身。',
        'hint.label': '注入「先查图谱」提示',
        'hint.hint': '会话问题像代码查找时，往系统提示注入一次索引提示。与硬拦截层互不影响。',
        'dirty.label': '写后脏台账',
        'dirty.hint': '记录本会话改过的代码文件；替换时按**命中文件**过滤——落在这些文件里的命中会被剔除（横幅注明条数），其余照换。关掉后不再过滤，坐标过期风险自担。',
        'logRetentionDays.label': '日志保留（天）',
        'logRetentionDays.hint': '遥测日志按天分文件（telemetry-YYYY-MM-DD.log），超过这个天数的旧文件自动删除；当天文件不动。填 0 表示只保留当天。改完按回车或离开输入框生效，下一次记日志时清理。',
        'interceptBudgetMs.label': '整体检索预算（毫秒）',
        'interceptBudgetMs.hint': '旧的整体预算。0 = 未设，两条腿各按自己的默认走（结构层 6000 / 语义层 4000）。显式设了它就优先于下面两条——老 profile 的设定不会被默认值顶掉。',
        'graphBudgetMs.label': '图谱层预算（毫秒）',
        'graphBudgetMs.hint': '结构层（search_graph）的等待上限。实测一次图谱查询约 5000ms，低于它就必然超时、图谱腿整段被跳过。0 = 跟随整体预算。',
        'zgBudgetMs.label': '语义层预算（毫秒）',
        'zgBudgetMs.hint': '语义层（zvec_grep_search）的等待上限。它冷启动约 3300ms、热态约 400ms，低于 3500 时会话里第一条必然超时。0 = 跟随整体预算。',
        'interceptTools.label': '拦截工具名单',
        'interceptTools.hint': '逗号分隔，默认 grep,glob。只有名单内工具的符号形 pattern 会被替换或拦截。',
        'sec.soft': '软引导层',
        'sec.soft.hint': '只往系统提示注入一次「先查图谱」，不改任何工具结果——最轻的一层，与硬拦截层互不影响。',
        'sec.hard': '硬拦截层',
        'sec.hard.hint': '约束力度从左到右递增：关闭（不拦）→ 拒一次（同一符号只拦首次）→ 持续拒绝（每次都报错）→ 换成检索（不报错，模型看到的输出整体替换成下面两层的命中）。',
        'sec.layers': '检索两层',
        'sec.layers.hint': '两层是**并列入口**，不按先后走：结构层答符号/调用坐标（code_find / code_callers，也是替换钩子的唯一来源）；语义层答自然语言问题与非代码文件（code_search，v0.15.0 起不再参与 grep 替换）。',
        'layer.graph': '结构层 · codebase-memory 图谱',
        'layer.graph.on': '常驻——工作区索引后即答',
        'sec.repos': '仓库索引状态',
        'sec.repos.hint': '本进程见过的仓库各一行：结构层看它有没有入图（project 名），语义层看该仓有没有 .zvec-grep 目录。替换/拒绝次数按仓库拆分——只在本进程内累计，宿主重启归零。',
        'sec.repos.empty': '本进程还没见过任何仓库（没跑过会话或没建索引）。',
        'sec.repos.cbm': '结构层',
        'sec.repos.cbm.no': '未入图',
        'sec.repos.zg': '语义层',
        'sec.repos.zg.yes': '有索引',
        'sec.repos.zg.no': '无索引',
        'sec.repos.replaced': '被替换',
        'sec.repos.denied': '拦下',
        'sec.repos.pass': '让路',
        'sec.filter': '过滤读数',
        'sec.filter.all': '全部仓库',
        'sec.filter.hint': '下面的「最近替换效果」只列所选仓库（本进程内累计）。上面的五张总卡是全量——脏台账/软引导/索引那几个数不按仓库细分。',
        'sec.effect': '最近替换效果',
        'sec.effect.hint': '最近若干条替换/拒绝决策，带命中文本片段——「换成 zg 到底返回了什么」看这里。只记替换类决策，不录记账类高频事件；环形缓冲，超出上限从最旧开始丢。',
        'sec.effect.empty': '还没有替换或拒绝事件（拦截关着，或本会话还没触发符号形 grep）。',
        'sec.effect.sym': '符号',
        'sec.effect.layer.graph': '结构层',
        'sec.effect.layer.zg': '语义层',
        'recent.replaced-graph': '已替换 · 结构层',
        'recent.replaced-zg': '已替换 · 语义层',
        'recent.denied': '已拒绝',
        'recent.pass-no-hit': '未替换 · 无命中',
        'recent.pass-failed': '未替换 · 查询失败',
        'recent.pass-dirty': '未替换 · 台账脏',
        'recent.pass-refreshing': '未替换 · 引擎重建索引中',
        'recent.deny-pass-dirty': '放行 · 台账脏',
        'recent.deny-pass-failed': '放行 · 查询失败',
        'recent.deny-pass-no-hit': '放行 · 无命中',
        'recent.near-miss': '近失 · 含符号支已放行',
        'layer.zg': '语义层 · zvec-grep',
        'layer.zg.off': '未启用——用上方开关开启；装包让 agent 调 code_setup {action:"install-zg"} 或手动 npm run install:zg',
        'layer.zg.ready': '已启用——图谱没答中的语义查询由它补位',
        'layer.zg.missing': '开关已开但包没装——让 agent 调 code_setup {action:"install-zg"}（或跑 npm run install:zg），装完重拉清单',
        'layer.zg.installed': '包已装好——重拉清单（code_setup {action:"restart-adapter"}）后会加入它',
        'layer.zg.installing': 'install-zg 正在下载安装（几百 MB，约 3 分钟）……完成后重拉清单生效',
        'layer.zg.pending-on': '开关已开、清单未重建——对 agent 说「重启适配层」（code_setup {action:"restart-adapter"}，几秒）即可生效',
        'layer.zg.pending-off': '开关已关、清单未移除——重启适配层后生效',
        'layer.zg.unknown': '状态未知——开遥测后由宿主实时推送（未开遥测时以配置文件为准）',
        'layer.zg.gitignore': 'zg 会在每个被索引仓库里生成 .zvec-grep/ 缓存目录——把它加进各仓库的 .gitignore。安装的那个工作区可能根本不是仓库、你的仓库也多是以后才来，所以这条提示常驻在这里。',
        'layer.adapter.stale': '⚠ 清单已重写，活着的适配层进程还没加载它——新版（≥0.0.6）自带清单监听，几秒内自愈；还没自愈或是老包，对 agent 说「重启适配层」：code_setup {action:"restart-adapter"}，几秒，不必重启宿主。',
        'layer.adapter.noproc': '没有在跑的适配层进程——宿主会在会话启动时拉起；若宿主正开着而代理工具报 not found，对 agent 说「重启适配层」。',
        'zg.label': '启用语义检索层',
        'zg.hint': '这个开关不装包、也不即刻生效：装包请对 agent 说「装语义检索层」（它来执行安装命令），装完对 agent 说「重启适配层」一次。差哪一步看下面状态行。',
        'zg.confirm.title': '确认开启语义检索层？',
        'zg.confirm.body': '开关不装包——要装，请开启后对 agent 说「装语义检索层」，由它执行 code_setup {action:"install-zg"}（约 430MB、约 3 分钟）；也可以在终端自己跑 npm run install:zg。另注意：首次使用再拉约 32MiB 嵌入模型；索引产物 .zvec-grep/ 会落进每个被索引仓库——务必加进 .gitignore；装完对 agent 说「重启适配层」（code_setup {action:"restart-adapter"}）即可生效，不必重启宿主。',
        'zg.confirm.yes': '确认开启',
        'zg.confirm.no': '取消',
        'sec.aux': '记账与遥测',
        'sec.aux.hint': '脏台账决定索引变脏时替换/拦截让不让路；遥测决定读数和 code_setup 报表还计不计。',
        'sec.params': '检索参数',
        'sec.params.hint': '都只作用于硬拦截层的现查动作。',
        'stats.label': '运行读数',
        'sec.log': '日志与环形上限',
        'stats.empty': '遥测已关 ⇒ 不计数、不推送，读数冻结；重新打开后卡片会随事件刷新。',
        'stats.replaced': '替换命中率',
        'stats.denied': '拒绝对照',
        'stats.dirty': '脏台账',
        'stats.lever': '软引导',
        'stats.index': '索引',
        'stats.r.hit': '被替换',
        'stats.r.den': '符号 grep 尝试',
        'stats.r.dirty': '脏让路',
        'stats.r.nohit': '无命中',
        'stats.r.err': '出错',
        'stats.r.blocked': '拦下',
        'stats.r.qfail': '查询失败',
        'stats.r.qfailgraph': '└ 图谱腿',
        'stats.r.codesearch': 'code_search 调用',
        'stats.r.lph': '现查清单（应趋零）',
        'stats.r.lpc': '命中预热清单',
        'stats.budget': '预算 图谱 {graph}ms / 语义 {zg}ms',
        'stats.r.seen': '已提示过',
        'stats.r.record': '写入记账',
        'stats.r.sched': '已调度',
        'stats.r.done': '已刷新',
        'stats.r.fail': '刷新失败',
        'stats.r.pending': '未刷',
        'stats.r.calls': '封装调用',
        'stats.r.hints': '提示注入',
        'stats.r.nearmiss': '近失 grep（符号支放行）',
        'stats.r.stalewarn': '陈旧旁路注入',
        'stats.r.retry': '并发重试',
        'stats.r.zgfail': '语义索引失败',
        'stats.updated': '{time} 更新 · 跨重启累计（关掉遥测则冻结）',
        resetField: '恢复此项',
        saveFailed: '保存失败：配置已被改动或不可写，请重试或改配置文件。',
        foot: '其余字段（wrapperTools、sessionRefresh…）仍需改 profile 的 cordis.patch.yml 并重启；语义层开关在页上，清单重拉（code_setup {action:"restart-adapter"}）才重建。',
      },
      en: {
        title: 'Search interception',
        summary: 'Layered by strength: soft hint → hard interception → retrieval layers → bookkeeping & telemetry → query params. Six fields hot-editable; the semantic-layer toggle is on-page too (manifest rebuilds on restart); runtime counters always on the page.',
        loading: 'Loading configuration…',
        unavailable: 'This host does not expose the plugin settings yet (restart DSH to recompose the document).',
        'enforce.label': 'Trigger mode',
        'enforce.off': 'Off',
        'enforce.off.hint': 'Never deny grep; the graph only guides through tool hints.',
        'enforce.deny-once': 'Deny once',
        'enforce.deny-once.hint': 'The first symbol-shaped grep is denied and answered with graph hits; later ones pass.',
        'enforce.deny': 'Always deny',
        'enforce.deny.hint': 'Every symbol-shaped grep is denied. Highest false-positive cost — check telemetry first.',
        'enforce.replace': 'Swap in retrieval',
        'enforce.replace.hint': 'Symbol-shaped greps still run, but the model-visible output is swapped for **structure layer (code graph)** hits; the original output is kept when the graph misses or times out. The semantic layer (zvec-grep) no longer takes part in swaps — it answers natural-language questions through the explicit code_search tool (since v0.15.0). No error raised — a true swap.',
        'markPassthrough.label': 'Mark passes too',
        'markPassthrough.hint': 'Under replace, a grep that was not swapped (no hit / stale ledger / query failure) passes through untouched by default. On, it keeps the original output but stamps a "not swapped" badge explaining which yield happened. Default off: a label prefix may distract the model.',
        'telemetry.label': 'Record interception telemetry',
        'telemetry.hint': 'Counters land in the plugin store and show up in code_setup; turning it off stops counting, not interception.',
        'hint.label': 'Inject "search the graph first" hint',
        'hint.hint': 'Soft lever: when a question looks like a code lookup, inject one graph hint into the system prompt. Independent of swapping/denying.',
        'dirty.label': 'Write-after staleness ledger',
        'dirty.hint': 'Tracks code files this session edited; swaps filter **per hit** — hits inside those files are dropped (the banner says how many) while the rest are swapped, and a refresh is scheduled. Off means no filtering — staleness risk on you.',
        'logRetentionDays.label': 'Log retention (days)',
        'logRetentionDays.hint': 'Telemetry logs are one file per day (telemetry-YYYY-MM-DD.log); files older than this are deleted automatically. Today’s file is never touched. 0 = keep today only. Applies on Enter or blur, at the next write.',
        'interceptBudgetMs.label': 'Overall query budget (ms)',
        'interceptBudgetMs.hint': 'The legacy single budget. 0 = unset, so each leg uses its own default (structure 6000 / semantic 4000). An explicit value wins over the two below, so old profile settings are never overridden by defaults.',
        'graphBudgetMs.label': 'Graph layer budget (ms)',
        'graphBudgetMs.hint': 'Wait limit for the structure layer (search_graph). A graph query measures ~5000ms, so anything lower always times out and the graph leg is skipped entirely. 0 = follow the overall budget.',
        'zgBudgetMs.label': 'Semantic layer budget (ms)',
        'zgBudgetMs.hint': 'Wait limit for the semantic layer (zvec_grep_search). It cold-starts in ~3300ms and is hot in ~400ms, so below 3500 the first query of a session always times out. 0 = follow the overall budget.',
        'interceptTools.label': 'Intercepted tools',
        'interceptTools.hint': 'Comma-separated, default grep,glob. Only listed tools get symbol-shaped searches swapped or denied.',
        'sec.soft': 'Soft guidance layer',
        'sec.soft.hint': 'Injects one "search the graph first" hint into the system prompt without touching any tool output — the lightest layer, independent of the hard one below.',
        'sec.hard': 'Hard interception layer',
        'sec.hard.hint': 'Strength increases left to right: Off → Deny once (first grep per symbol only) → Always deny (error every time) → Swap in retrieval (no error; the model-visible output is replaced by hits from the two layers below).',
        'sec.layers': 'Retrieval layers',
        'sec.layers.hint': 'Two parallel entry points, not a sequence: the structure layer answers symbol/call lookups (code_find / code_callers, and the only source of swap hits); the semantic layer answers natural-language questions and non-code files (code_search, no longer part of grep swaps since v0.15.0).',
        'layer.graph': 'Structure layer · codebase-memory graph',
        'layer.graph.on': 'always on once the workspace is indexed',
        'sec.repos': 'Index status per repo',
        'sec.repos.hint': 'One row per repo this process has seen: structure layer = whether it is indexed (project name), semantic layer = whether the repo has a .zvec-grep directory. Swap/deny counts split by repo — in-process only, reset on host restart.',
        'sec.repos.empty': 'This process has not seen any repo yet (no session run, or nothing indexed).',
        'sec.repos.cbm': 'structure',
        'sec.repos.cbm.no': 'not indexed',
        'sec.repos.zg': 'semantic',
        'sec.repos.zg.yes': 'indexed',
        'sec.repos.zg.no': 'no index',
        'sec.repos.replaced': 'swapped',
        'sec.repos.denied': 'denied',
        'sec.repos.pass': 'yields',
        'sec.filter': 'Filter counters',
        'sec.filter.all': 'all repos',
        'sec.filter.hint': '“Recent swap results” below lists only the selected repo (in-process totals). The five summary cards above are aggregate — dirty ledger / soft levers / index are not split per repo.',
        'sec.effect': 'Recent swap results',
        'sec.effect.hint': 'The last few swap/deny decisions with hit snippets — this is where “what did zg actually return” lives. Swap decisions only, not bookkeeping noise; ring buffer, oldest dropped past the limit.',
        'sec.effect.empty': 'No swap or deny events yet (interception off, or no symbol grep this session).',
        'sec.effect.sym': 'symbol',
        'sec.effect.layer.graph': 'structure layer',
        'sec.effect.layer.zg': 'semantic layer',
        'recent.replaced-graph': 'swapped · structure',
        'recent.replaced-zg': 'swapped · semantic',
        'recent.denied': 'denied',
        'recent.pass-no-hit': 'not swapped · no hit',
        'recent.pass-failed': 'not swapped · query failed',
        'recent.pass-dirty': 'not swapped · stale',
        'recent.pass-refreshing': 'not swapped · re-indexing',
        'recent.deny-pass-dirty': 'passed · stale',
        'recent.deny-pass-failed': 'passed · query failed',
        'recent.deny-pass-no-hit': 'passed · no hit',
        'recent.near-miss': 'near-miss · symbol branch passed',
        'sec.log': 'Log & ring limits',
        'sec.log.hint': 'Telemetry logs live one file per day; the ring limit caps how many entries “Recent swap results” keeps (oldest dropped past the limit). Both hot-editable.',
        'layer.zg': 'Semantic layer · zvec-grep',
        'layer.zg.off': 'disabled — flip the toggle above; install via agent code_setup {action:"install-zg"} or npm run install:zg',
        'layer.zg.ready': 'enabled — covers semantic queries the graph misses',
        'layer.zg.missing': 'toggle on but package not installed — agent code_setup {action:"install-zg"} (or npm run install:zg), then reload the manifest',
        'layer.zg.installed': 'package installed — reload the manifest (code_setup {action:"restart-adapter"}) to add it',
        'layer.zg.installing': 'install-zg is downloading (hundreds of MB, ~3 minutes)… reload the manifest afterwards',
        'layer.zg.pending-on': 'toggle on, manifest not rebuilt — say "restart the adapter" to the agent (code_setup {action:"restart-adapter"}, seconds)',
        'layer.zg.pending-off': 'toggle off, manifest still lists it — cleared after restarting the adapter',
        'layer.zg.unknown': 'status unknown — pushed live by the host when telemetry is on (otherwise check the config file)',
        'layer.zg.gitignore': 'zg creates a .zvec-grep/ cache directory inside every indexed repo — add it to each repo’s .gitignore. The install workspace may not even be a git repo, and your repos mostly arrive later, so this hint stays here permanently.',
        'layer.adapter.stale': '⚠ The manifest was rewritten, but the running adapter process has not loaded it — the new adapter (≥0.0.6) watches the manifest and self-heals within seconds; if it has not healed yet or the package is older, say "restart the adapter" to the agent: code_setup {action:"restart-adapter"}, seconds, no host restart needed.',
        'layer.adapter.noproc': 'No adapter process is running — the host spawns one at session start; if the host is up and proxy tools report not found, ask the agent to restart the adapter.',
        'zg.label': 'Enable semantic retrieval layer',
        'zg.hint': 'This toggle installs nothing and does not take effect instantly: ask the agent to install the semantic layer (it runs the install command), then ask it to restart the adapter once. The status line below shows what is missing.',
        'zg.confirm.title': 'Enable the semantic retrieval layer?',
        'zg.confirm.body': 'The toggle never downloads: to actually enable the layer, ask the agent to "install the semantic layer" so it runs code_setup {action:"install-zg"} (~430MB, ~3 minutes), or run npm run install:zg yourself in a terminal. Also note: a ~32MiB embedding model is fetched on first use; the index output .zvec-grep/ lands in every indexed repo — add it to .gitignore; afterwards say "restart the adapter" (code_setup {action:"restart-adapter"}) — no host restart needed.',
        'zg.confirm.yes': 'Confirm',
        'zg.confirm.no': 'Cancel',
        'sec.aux': 'Bookkeeping & telemetry',
        'sec.aux.hint': 'The staleness ledger decides whether swaps/denials yield while the index is dirty; telemetry decides whether counters are kept at all.',
        'sec.params': 'Query parameters',
        'sec.params.hint': 'Both only affect the hard layer\u2019s live lookups.',
        'stats.label': 'Runtime counters',
        'stats.empty': 'Telemetry is off: nothing is counted or pushed, counters stay frozen. Turn it back on and the cards update live.',
        'stats.replaced': 'Swap hit rate',
        'stats.denied': 'Deny (comparison)',
        'stats.dirty': 'Dirty ledger',
        'stats.lever': 'Soft levers',
        'stats.index': 'Index',
        'stats.r.hit': 'swapped',
        'stats.r.den': 'symbol greps',
        'stats.r.dirty': 'stale pass',
        'stats.r.nohit': 'no hit',
        'stats.r.err': 'errors',
        'stats.r.blocked': 'denied',
        'stats.r.qfail': 'query failed',
        'stats.r.qfailgraph': '└ graph leg',
        'stats.r.codesearch': 'code_search calls',
        'stats.r.lph': 'live lookups (→ 0)',
        'stats.r.lpc': 'warm-listing hits',
        'stats.budget': 'budget graph {graph}ms / semantic {zg}ms',
        'stats.r.seen': 'already seen',
        'stats.r.record': 'writes marked',
        'stats.r.sched': 'scheduled',
        'stats.r.done': 'refreshed',
        'stats.r.fail': 'refresh failed',
        'stats.r.pending': 'pending',
        'stats.r.calls': 'wrapper calls',
        'stats.r.hints': 'hints injected',
        'stats.r.nearmiss': 'near-miss greps (symbol branch passed)',
        'stats.r.stalewarn': 'stale-bypass injections',
        'stats.r.retry': 'retries',
        'stats.r.zgfail': 'semantic index fails',
        'stats.updated': 'updated {time} · cumulative across restarts (freezes when telemetry is off)',
        resetField: 'Reset this',
        saveFailed: 'Save failed: the configuration changed or is not writable. Retry, or edit the config file.',
        foot: 'Other fields (wrapperTools, sessionRefresh…) still require the profile cordis.patch.yml plus a restart; the semantic-layer toggle is on-page, and its manifest rebuilds after restarting the adapter (code_setup {action:"restart-adapter"}).',
      },
    }

    // ConfigForms 按 entryId 缓存同一个 controller；这里只留引用，不重复 dispose。
    let form = null
    const subscribe = (notify) => form.subscribe(notify)
    const getSnapshot = () => form.getSnapshot()

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, DICTIONARY), 'dsh-codebase-memory locale')
      form = ctx.configForms.get(ENTRY)
      ctx.effect(() => ctx.configForms.whileServed([ENTRY], () =>
        ctx.slots.inject('plugins.row.config', () =>
          ctx.slots.register(
            { name: 'plugins.row.config', key: ROW_KEY, label: () => t('title'), locale: NS },
            ConfigPanel,
          )),
      ), 'dsh-codebase-memory row config panel')
    }

    function ConfigPanel(props) {
      const snap = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
      const [failed, setFailed] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      if (props.view === 'summary') return props.t('summary')
      if (!snap || snap.status !== 'ready') return jsx('div', { style: HINT, children: props.t(snap && snap.status === 'loading' ? 'loading' : 'unavailable') })

      const value = snap.value || {}
      const user = snap.user || {}
      const mode = MODES.includes(value.enforce) ? value.enforce : 'off'
      const [repoSel, setRepoSel] = React.useState('') // '' = 全部仓库；只影响「最近替换效果」
      // 只读读数（host 推来的 JSON 字符串）。坏 JSON / 空串当没数，不炸面板。
      let statsFor = null
      try { statsFor = value.stats ? JSON.parse(value.stats) : null } catch { /* 坏 JSON 当没数 */ }
      if (statsFor && typeof statsFor !== 'object') statsFor = null
      const run = (action) => {
        setFailed(false)
        setBusy(true)
        Promise.resolve(action()).then((ok) => {
          setBusy(false)
          setFailed(ok === false)
        })
      }
      const write = (field, next) => run(() => form.set(field, next))
      const reset = (field) => run(() => form.unset(field))
      // 非受控输入只在 blur/回车且值真变了时写表单；非法值把 DOM 拨回当前值，
      // 不替用户写一次他没要求的默认值。
      const parseNum = (raw) => { const n = Number.parseInt(raw, 10); return Number.isFinite(n) && n >= 50 ? n : null }
      const parseDays = (raw) => { const n = Number.parseInt(raw, 10); return Number.isFinite(n) && n >= 0 ? n : null }
      const parseLimit = (raw) => { const n = Number.parseInt(raw, 10); return Number.isFinite(n) && n >= 1 ? n : null }
      const parseCsv = (raw) => { const s = String(raw ?? '').trim(); return s.length > 0 ? s : null }
      const commitField = (field, fallback, parse) => (e) => {
        const cur = value[field] ?? fallback
        const next = parse(e.target?.value)
        if (next === null) { if (e.target) e.target.value = String(cur) }
        else if (next !== cur) write(field, next)
      }
      const enterToBlur = (e) => { if (e.key === 'Enter') e.currentTarget?.blur?.() }
      // 标签与控件同行：primitives.Switch 的 label prop 在宿主上不渲染可见文字
      // （v0.10.0 验收截图证实），说明文字单独挂在下面就会分不清归谁——行内自铺。
      const labelSpan = (key) => jsx('span', { style: LABEL, children: props.t(`${key}.label`) })
      const resetBtn = (field) => (field in user ? jsx(p.Button, { variant: 'ghost', size: 'sm', onClick: () => reset(field), children: props.t('resetField') }) : null)
      const switchRow = (key, field) => jsxs('div', { children: [
        jsxs('div', { style: LINE, children: [
          labelSpan(key),
          jsx(p.Switch, {
            label: props.t(`${key}.label`),
            title: props.t(`${key}.hint`),
            checked: value[field] !== false,
            disabled: !snap.writable || busy,
            onChange: (next) => write(field, next),
          }),
          resetBtn(field),
        ] }),
        jsx('div', { style: HINT, children: props.t(`${key}.hint`) }),
      ] })
      const inputRow = (field, fallback, parse, opts) => jsxs('div', { children: [
        jsxs('div', { style: LINE, children: [
          labelSpan(field),
          jsx(p.Input, {
            key: `${field}-${value[field] ?? fallback}`,
            defaultValue: value[field] ?? fallback,
            'aria-label': props.t(`${field}.label`),
            title: props.t(`${field}.hint`),
            disabled: !snap.writable || busy,
            style: INPUT,
            onBlur: commitField(field, fallback, parse),
            onKeyDown: enterToBlur,
            ...opts,
          }),
          resetBtn(field),
        ] }),
        jsx('div', { style: HINT, children: props.t(`${field}.hint`) }),
      ] })
      const section = (key, children) => jsxs('div', { style: SECTION, children: [
        jsx('div', { style: SEC_TITLE, children: props.t(key) }),
        jsx('div', { style: HINT, children: props.t(`${key}.hint`) }),
        ...children,
      ] })

      return jsxs('div', { style: ROW, children: [
        section('sec.soft', [switchRow('hint', 'contextHint')]),
        section('sec.hard', [jsxs('div', { children: [
          jsxs('div', { style: LINE, children: [
            labelSpan('enforce'),
            jsx(p.SegmentedControl, {
              id: `${ROW_KEY}-enforce`,
              label: props.t('enforce.label'),
              value: mode,
              disabled: !snap.writable || busy,
              options: MODES.map((m) => ({ value: m, label: props.t(`enforce.${m}`), title: props.t(`enforce.${m}.hint`) })),
              onChange: (next) => write('enforce', next),
            }),
            resetBtn('enforce'),
          ] }),
          jsx('div', { style: HINT, children: props.t(`enforce.${mode}.hint`) }),
          jsxs('div', { style: LINE, children: [
            labelSpan('markPassthrough'),
            jsx(p.Switch, {
              label: props.t('markPassthrough.label'),
              title: props.t('markPassthrough.hint'),
              checked: value.markPassthrough === true,
              disabled: !snap.writable || busy,
              onChange: (next) => write('markPassthrough', next),
            }),
            resetBtn('markPassthrough'),
          ] }),
          jsx('div', { style: HINT, children: props.t('markPassthrough.hint') }),
        ] })]),
        section('sec.layers', layersBlock(props, value, { writable: snap.writable, busy, user, write, reset })),
        section('sec.aux', [switchRow('dirty', 'dirtyTracking'), switchRow('telemetry', 'telemetry')]),
        section('sec.params', [
          inputRow('interceptBudgetMs', 0, parseNum, { type: 'number', min: 0, step: 100 }),
          inputRow('graphBudgetMs', 0, parseNum, { type: 'number', min: 0, step: 500 }),
          inputRow('zgBudgetMs', 0, parseNum, { type: 'number', min: 0, step: 500 }),
          inputRow('interceptTools', 'grep,glob', parseCsv, { type: 'text', style: INPUT_WIDE }),
        ]),
        section('sec.repos', reposBlock(props, statsFor)),
        section('sec.effect', [repoFilter(props, statsFor, repoSel, setRepoSel), recentBlock(props, statsFor, repoSel)]),
        jsx('div', { style: ROW, children: statsBlock(props, value, statsFor) }),
        section('sec.log', [
          inputRow('logRetentionDays', 7, parseDays, { type: 'number', min: 0, step: 1 }),
          inputRow('recentLimit', 100, parseLimit, { type: 'number', min: 1, step: 10 }),
        ]),
        failed ? jsx('div', { style: FAILED, children: props.t('saveFailed') }) : null,
        jsx('div', { style: HINT, children: props.t('foot') }),
      ] })
    }

    /** 「检索两层」：语义层开关（两步确认）+ 两层状态行。状态行由三轴推导——
     *  stats.zg = 清单事实（bootstrap 时定）、zgEnabled = 页面开关、stats.zgInstalled =
     *  包实测；轴间差写成「重启 / 装包」待办，页面不撒谎。结构层恒在。
     *
     *  颜色分三档：off/ready 常态走默认灰，pending-on / pending-off / installed /
     *  installing 走警示橙，missing 走报错红——否则五态全是同一色文本，「开关已开、
     *  清单未重建」看起来和「已启用」一模一样（用户看不出待重启）。 */
    function layersBlock(props, value, ctl) {
      let zg = null
      let zgInstalled = null
      let adapter = null
      try {
        const s = value.stats ? JSON.parse(value.stats) : null
        if (s && typeof s.zg === 'string') zg = s.zg
        if (s && typeof s.zgInstalled === 'boolean') zgInstalled = s.zgInstalled
        if (s && typeof s.adapter === 'string') adapter = s.adapter
      } catch { /* 坏 JSON 当没数 */ }
      const want = value.zgEnabled === true
      let st
      if (zg === 'installing') st = 'installing'
      else if (zg === null) st = 'unknown'
      else if (want && zg === 'off') st = 'pending-on'
      else if (!want && (zg === 'ready' || zg === 'missing')) st = 'pending-off'
      else if (zg === 'missing') st = zgInstalled === true ? 'installed' : 'missing'
      else st = zg
      // 三档：红色 = 用户配了但页面没生效或缺包（真异常，需要动作）；橙色 = 配置与清单
      // 不一致的良性差（待重启清理、包在装），off/ready 常态 ⇒ 默认灰。
      // pending-on 归红是因为 zgEnabled: true 但清单没重建，等于用户配置没生效；
      // pending-off 归橙是因为关掉后残留的清单条目不影响功能。
      const tone = st === 'pending-on' || st === 'missing' || st === 'unknown' ? 'error'
        : st === 'pending-off' || st === 'installed' || st === 'installing' ? 'warn'
        : null
      const line = (k, v, t) => jsxs('div', { style: RROW, children: [
        jsx('span', { children: props.t(k) }),
        jsx('span', { style: t === 'error' ? RVAL_ERROR : t === 'warn' ? RVAL_WARNING : RVAL, children: props.t(v) }),
      ] })
      return [
        jsx(ZgToggle, {
          key: 'zg-toggle',
          t: props.t,
          want,
          writable: ctl.writable,
          busy: ctl.busy || zg === 'installing',
          onWrite: (next) => ctl.write('zgEnabled', next),
        }),
        line('layer.graph', 'layer.graph.on'),
        line('layer.zg', `layer.zg.${st}`, tone),
        // 常驻提示（v0.12.0）：开关一开就要一直看到——装包工作区未必是 git 仓库，
        // 用户真正被索引的仓库多是以后才来的，写进一次性弹窗等于没人看见。
        want ? jsx('div', { key: 'zg-gitignore', style: HINT, children: props.t('layer.zg.gitignore') }) : null,
        // 进程轴异常才出声（fresh/no-manifest 不打扰）；数据来自 stats.adapter，
        // 遥测关时不推新帧 ⇒ 这行跟着冻结，与页面其余读数同一契约。
        adapter === 'stale' || adapter === 'no-process'
          ? jsx('div', { key: 'adapter-warn', style: WARNLINE, children: props.t(`layer.adapter.${adapter === 'stale' ? 'stale' : 'noproc'}`) })
          : null,
      ]
    }

    /** 开启要两步确认：开关本身不下载，但它是几百 MB 链路的第一环，点头放在点击时；
     *  关闭无开销，直接写。checked=want||confirming：确认中显示目标态，取消即回弹。
     *  刻意没有「恢复此项」：布尔关掉就是默认，再放一个恢复按钮只会让人以为
     *  开关背后还压着别的状态（v0.11.x 验收）。 */
    function ZgToggle({ t, want, writable, busy, onWrite }) {
      const [confirming, setConfirming] = React.useState(false)
      return jsxs('div', { children: [
        jsxs('div', { style: LINE, children: [
          jsx('span', { style: LABEL, children: t('zg.label') }),
          jsx(p.Switch, {
            label: t('zg.label'),
            title: t('zg.hint'),
            checked: want || confirming,
            disabled: !writable || busy,
            onChange: (next) => { if (next) setConfirming(true); else { setConfirming(false); onWrite(false) } },
          }),
        ] }),
        confirming ? jsxs('div', { style: CONFIRM, children: [
          jsx('div', { style: SEC_TITLE, children: t('zg.confirm.title') }),
          jsx('div', { style: HINT, children: t('zg.confirm.body') }),
          jsxs('div', { style: LINE, children: [
            jsx(p.Button, { size: 'sm', onClick: () => { setConfirming(false); onWrite(true) }, children: t('zg.confirm.yes') }),
            jsx(p.Button, { variant: 'ghost', size: 'sm', onClick: () => setConfirming(false), children: t('zg.confirm.no') }),
          ] }),
        ] }) : null,
        jsx('div', { style: HINT, children: t('zg.hint') }),
      ] })
    }

    /** host 推来的只读读数（value.stats = volatile 字段里的 JSON 字符串）。stats 由
     *  ConfigPanel 解析后传进来（仓库选择器要读同一份），这里不再自己 JSON.parse。
     *  卡片栅格照 dsh-mneme 状态页：每卡一个大数字 + 若干指标行，命中率卡带
     *  预算行。纯展示，无编辑控件。遥测开着时卡片常驻：host 开机
     *  即推一帧零值快照，坏 JSON / 缺字段也按零渲染；空态只属于"关了遥测"。 */
    function statsBlock(props, value, stats) {
      let s = stats
      const head = jsx('div', { style: HINT, children: props.t('stats.label') })
      if (!s || typeof s !== 'object') {
        if (value.telemetry === false) return [head, jsx('div', { style: HINT, children: props.t('stats.empty') })]
        // 遥测开着 ⇒ 卡片常驻（mneme 式）：没数就全零，空态只留给"关了遥测"。
        s = {}
      }
      const num = (v) => (typeof v === 'number' ? v : 0)
      const rp = s.replace || {}; const dn = s.deny || {}; const dy = s.dirty || {}; const lv = s.lever || {}; const ix = s.index || {}; const nm = s.nearMiss || {}
      // v0.15.0 M6：分腿计数（M3）与两条腿的预算（M2）上页面——排障时要能一眼看出
      // "是哪一腿失败"和"它到底有多少时间"，而不是去翻 telemetry.log。
      const lp = s.listProjects || {}; const bd = s.budget || {}
      const den = num(rp.hit) + num(rp.passDirty) + num(rp.passNoHit) + num(rp.passFailed) + num(rp.error)
      const pct = den ? `${Math.round((num(rp.hit) / den) * 100)}%` : '—'
      const budgetLine = (bd.graph || bd.zg)
        ? jsx('div', { style: FOOT, children: props.t('stats.budget').split('{graph}').join(String(num(bd.graph))).split('{zg}').join(String(num(bd.zg))) })
        : null
      const card = (title, big, rows, extra) => jsxs('div', { style: CARD, children: [
        jsx('h3', { style: CARD_TITLE, children: props.t(title) }),
        jsx('div', { style: NUM, children: String(big) }),
        jsx('div', { style: ROWS, children: rows.map(([k, v]) => jsxs('div', { style: RROW, children: [
          jsx('span', { children: props.t(k) }),
          jsx('span', { style: RVAL, children: String(v) }),
        ] }, k)) }),
        extra || null,
      ] })
      return [head, jsxs('div', { style: GRID, children: [
        card('stats.replaced', pct, [
          ['stats.r.hit', `${num(rp.hit)}/${den}`],
          ['stats.r.dirty', num(rp.passDirty)],
          ['stats.r.nohit', num(rp.passNoHit)],
          ['stats.r.qfail', num(rp.passFailed)],
          ['stats.r.qfailgraph', num(rp.passFailedGraph)],
          ['stats.r.err', num(rp.error)],
        ], budgetLine || null),
        card('stats.denied', num(dn.blocked), [
          ['stats.r.dirty', num(dn.passDirty)],
          ['stats.r.nohit', num(dn.passNoHit)],
          ['stats.r.qfail', num(dn.passQueryFailed)],
          ['stats.r.seen', num(dn.skipSeen)],
          ['stats.r.err', num(dn.error)],
        ]),
        card('stats.dirty', num(dy.record), [
          ['stats.r.sched', num(dy.refreshScheduled)],
          ['stats.r.done', num(dy.refreshDone)],
          ['stats.r.fail', num(dy.refreshFail)],
          ['stats.r.pending', Math.max(0, num(dy.refreshScheduled) - num(dy.refreshDone) - num(dy.refreshFail))],
        ]),
        card('stats.lever', num(lv.wrapperCalls), [
          ['stats.r.codesearch', num(lv.codeSearch)],
          ['stats.r.hints', num(lv.hintInjected)],
          // v0.16：近失=含符号支但照旧放行的 grep（逃逸通道读数）；陈旧旁路=台账
          // 攒够后无视问句闸门注入的提醒次数。
          ['stats.r.nearmiss', num(nm.symbol)],
          ['stats.r.stalewarn', num(lv.staleWarn)],
        ]),
        card('stats.index', num(ix.retryContention), [
          ['stats.r.lpc', num(lp.cacheHit)],
          ['stats.r.lph', num(lp.hot)],
          ['stats.r.zgfail', num(ix.zgIndexFail)],
        ]),
      ] }),
      typeof s.at === 'number' ? jsx('div', { style: FOOT, children: props.t('stats.updated').split('{time}').join(new Date(s.at).toLocaleString()) }) : null,
      ].filter(Boolean)
    }

    /** 「仓库索引状态」：本进程见过的仓库各一行，结构层=有没有入图，语义层=有没有
     *  .zvec-grep 目录，右侧是该仓的替换/拒绝/让路计数。只读；数据来自 stats.repos
     *  （进程内累计，宿主重启归零）。表头行 + 数据行，列宽固定，不依赖宿主组件。 */
    function reposBlock(props, stats) {
      const reps = Array.isArray(stats?.repos) ? stats.repos : []
      const base = (cwd) => cwd.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
      if (reps.length === 0) return [jsx('div', { style: HINT, children: props.t('sec.repos.empty') })]
      const head = jsx('div', { style: TROW, children: [
        jsx('div', { style: { width: '42%' }, children: props.t('sec.repos') }),
        jsx('div', { style: TC, children: props.t('sec.repos.cbm') }),
        jsx('div', { style: TC, children: props.t('sec.repos.zg') }),
        jsx('div', { style: TV, children: props.t('sec.repos.replaced') }),
        jsx('div', { style: TV, children: props.t('sec.repos.denied') }),
        jsx('div', { style: TV, children: props.t('sec.repos.pass') }),
      ] })
      const rows = reps.map((r) => {
        const rp = r.replace || {}; const dn = r.deny || {}
        const g = (o, k) => (typeof o[k] === 'number' ? o[k] : 0)
        const cbm = r.project ? String(r.project) : props.t('sec.repos.cbm.no')
        const pass = g(rp, 'replace-pass-dirty') + g(rp, 'replace-pass-no-hit') + g(rp, 'replace-pass-failed')
          + g(dn, 'intercept-pass-dirty') + g(dn, 'intercept-pass-no-hit') + g(dn, 'intercept-pass-query-failed')
        return jsx('div', { style: TROW, title: String(r.cwd), children: [
          jsx('div', { style: { width: '42%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: base(String(r.cwd)) }),
          jsx('div', { style: TC, children: cbm }),
          jsx('div', { style: TC, children: r.zg ? props.t('sec.repos.zg.yes') : props.t('sec.repos.zg.no') }),
          jsx('div', { style: TV, children: String(g(rp, 'intercept-replace')) }),
          jsx('div', { style: TV, children: String(g(dn, 'intercept-deny')) }),
          jsx('div', { style: TV, children: pass ? String(pass) : '—' }),
        ] }, String(r.cwd))
      })
      return [head, ...rows]
    }

    /** 仓库选择器：只有「仓库索引状态」里出现过的仓库才能选——没见过的仓库本插件
     *  无从谈起。选择是页面本地状态，不写进配置（它是视图偏好，不是插件行为）。
     *  空选 = 全部；选中后「最近替换效果」只列该仓。 */
    function repoFilter(props, stats, sel, setSel) {
      const reps = Array.isArray(stats?.repos) ? stats.repos : []
      if (reps.length === 0) return null
      const base = (cwd) => cwd.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
      const all = [{ value: '', label: props.t('sec.filter.all') }]
      const opts = reps.map((r) => ({ value: String(r.cwd), label: base(String(r.cwd)), title: String(r.cwd) }))
      return jsxs('div', { children: [
        jsxs('div', { style: LINE, children: [
          jsx('span', { style: LABEL, children: props.t('sec.filter') }),
          jsx(p.SegmentedControl, {
            id: `${ROW_KEY}-repo`,
            label: props.t('sec.filter'),
            value: sel,
            options: [...all, ...opts],
            onChange: (next) => setSel(next),
          }),
        ] }),
        jsx('div', { style: HINT, children: props.t('sec.filter.hint') }),
      ] })
    }

    /** 「最近替换效果」：最近 N 条替换/拒绝决策 + 命中文本片段。片段用 <details> 折叠
     *  ——展开即得「换成 zg 返回了什么」，收起时页面只占标题行。列表按 cwd 过滤，
     *  与上面的仓库选择器共用同一个选择值。outcome 徽标走 Tag 三档色：替换成 success、
     *  拒绝成 warning、未替换/放行成 neutral。条目 key 用 ts+symbol，同秒同符号极少见，
     *  撞了也只是多渲一帧，不影响正确性。 */
    function recentBlock(props, stats, cwd) {
      const list = (Array.isArray(stats?.recent) ? stats.recent : []).filter((e) => !cwd || e.cwd === cwd)
      const layer = (src) => (src === 'zg' ? props.t('sec.effect.layer.zg') : src === 'graph' ? props.t('sec.effect.layer.graph') : '')
      if (list.length === 0) return [jsx('div', { style: HINT, children: props.t('sec.effect.empty') })]
      return list.slice(-30).map((e, i) => {
        const ok = e.outcome.startsWith('replaced') || e.outcome === 'denied'
        const tone = ok ? (e.outcome === 'denied' ? 'warning' : 'success') : 'neutral'
        return jsxs('details', { style: { margin: '2px 0' }, children: [
          jsxs('summary', { style: SUMMARY, children: [
            jsx(p.Tag, { tone, children: props.t(`recent.${e.outcome}`) }),
            jsx('span', { style: { fontFamily: 'var(--dsw-mono-font-family, monospace)', color: 'var(--dsw-alias-label-primary)' }, children: e.symbol }),
            layer(e.source) ? jsx('span', { children: '·' + layer(e.source) }) : null,
            jsx('span', { style: { opacity: 0.6 }, children: new Date(e.ts).toLocaleTimeString() }),
          ] }),
          e.snippet ? jsx('pre', { style: SNIP, children: e.snippet }) : null,
        ] }, `${e.ts}-${e.symbol}-${i}`)
      })
    }

    const ROW = { display: 'grid', gap: '10px' }
    const LINE = { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }
    const HINT = { fontSize: '12px', opacity: 0.7, lineHeight: 1.5 }
    const LABEL = { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' }
    const SECTION = { display: 'grid', gap: '8px', paddingTop: '6px' }
    const SEC_TITLE = { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' }
    const INPUT = { width: '120px' }
    const INPUT_WIDE = { width: '220px' }
    const FAILED = { fontSize: '12px', color: 'crimson' }
    // ── 读数卡片样式：变量与尺寸取自 dsh-mneme 状态页 status.css（宿主 --dsw-alias-*）──
    const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px', marginTop: '8px' }
    const CARD = { minWidth: 0, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '12px', padding: '14px 14px 12px' }
    const CONFIRM = { marginTop: '8px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '12px', padding: '12px 14px', display: 'grid', gap: '8px' }
    const CARD_TITLE = { margin: '0 0 8px', fontSize: '12px', fontWeight: 500, color: 'var(--dsw-alias-label-tertiary)' }
    const NUM = { fontSize: '24px', fontWeight: 600, lineHeight: '32px', color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums' }
    const ROWS = { marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '4px' }
    const RROW = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', fontSize: '12px', lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)' }
    const RVAL = { color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }
    // 三档色：常态走默认灰；警示（待重启/待装包/安装中）用 --dsw-alias-warning；
    // 报错（包缺失、状态未知）用 --dsw-alias-error。宿主变量未定义时退回字面色兜底，
    // 与 FAILED 用 'crimson' 字面色同策——变量名猜错不能让状态行退回常态色。
    const RVAL_WARNING = { color: 'var(--dsw-alias-warning, #d97706)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }
    // 整行警示文本（进程轴 stale 行用）：右对齐的值色撑不下一句话，字面色兜底同 FAILED。
    const WARNLINE = { fontSize: '12px', lineHeight: '1.5', color: 'var(--dsw-alias-warning, #d97706)' }
    const RVAL_ERROR = { color: 'var(--dsw-alias-error, crimson)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }
    const FOOT = { marginTop: '8px', fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-dimmed)' }
    // ── 仓库/效果面板：表格行与片段块（同样只用宿主 --dsw-alias-* 变量）──
    const TROW = { display: 'grid', gridTemplateColumns: '42% repeat(2, minmax(0,1fr)) repeat(3, 44px)', gap: '8px', alignItems: 'baseline', fontSize: '12px', lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)', borderBottom: '1px solid var(--dsw-alias-border-l2)', paddingBottom: '4px' }
    const TC = { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    const TV = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    const SUMMARY = { listStyle: 'none', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12px', lineHeight: '19px', cursor: 'pointer' }
    const SNIP = { margin: '6px 0 2px', padding: '8px 10px', fontFamily: 'var(--dsw-mono-font-family, monospace)', fontSize: '11px', lineHeight: '15px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--dsw-alias-interactive-bg-hover)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px', color: 'var(--dsw-alias-label-secondary)' }

    exports.apply = apply
    exports.inject = ['slots', 'locale', 'configForms']
    return module.exports
  },
})
