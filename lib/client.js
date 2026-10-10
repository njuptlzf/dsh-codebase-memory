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
 * 写路径是六个可热改字段（enforce / telemetry / interceptBudgetMs / interceptTools /
 * contextHint / dirtyTracking，v0.9.0 起全部 volatile 且决策点现读）；`stats` 是 host 推来的**只读读数**（volatile 字段
 * 里的 JSON 字符串，dsh-settings describe 的 plainConfig 实时解引用，不落配置文档）——
 * 面板渲染它但不给编辑控件。读数用卡片栅格（大数字 + 指标行 + 占比条），样式抄
 * dsh-mneme 状态页（@modusensus/dsh-mneme lib/client.js 的 status.css）：只用宿主
 * --dsw-alias-* 变量，亮暗主题免适配。host 侧 Config 里没标 `.volatile()` 的字段，
 * dsh-settings 的 write() 会直接抛 "not volatile"，所以这个面板有意只暴露可热改的那几项。
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
        summary: '拦截模式、工具名单、检索预算、软引导与脏台账都可在此热改，运行读数常驻，无需重启。',
        loading: '正在读取配置…',
        unavailable: '当前宿主没有暴露该插件的配置项（需重启 DSH 让配置文档重新组合）。',
        'enforce.label': 'grep 硬拦截',
        'enforce.off': '关闭',
        'enforce.off.hint': '不拦 grep：只靠索引工具与提示词软引导。',
        'enforce.deny-once': '拒一次',
        'enforce.deny-once.hint': '符号形 pattern 首次 grep 被拒并回给你图谱命中；同一会话同一符号不再拦。',
        'enforce.deny': '持续拒绝',
        'enforce.deny.hint': '符号形 pattern 每次 grep 都被拒。误报代价最高，先看遥测再上。',
        'enforce.replace': '换成检索',
        'enforce.replace.hint': '符号形 pattern 的 grep 照常执行，但模型看到的输出整体替换成两层检索的命中：结构层（代码图谱）先答，没命中由语义层（zvec-grep）补位；两层都没有就保留原输出。不产生报错，硬替换。code_find / zvec_grep_search 等常规工具不受本设置影响，两层始终并存。',
        'telemetry.label': '记录拦截遥测',
        'telemetry.hint': '拦截/放行计数写进插件自己的存储，code_setup 会报出来；关掉只是不再记数，不影响拦截本身。',
        'hint.label': '注入「先查图谱」提示',
        'hint.hint': '软引导层：会话问题像代码查找时，往系统提示注入一次索引提示。与替换/拦截互不影响。',
        'dirty.label': '写后脏台账',
        'dirty.hint': '记录本会话改过的代码文件；替换/拦截现读，脏了先放行并调度刷新。关掉后不再让路，坐标过期风险自担。',
        'interceptBudgetMs.label': '检索预算（毫秒）',
        'interceptBudgetMs.hint': '替换前现查图谱/语义层的等待上限，超时保留原输出。改完按回车或离开输入框生效。',
        'interceptTools.label': '拦截工具名单',
        'interceptTools.hint': '逗号分隔，默认 grep,glob。只有名单内工具的符号形 pattern 会被替换或拦截。',
        'stats.label': '运行读数',
        'stats.empty': '遥测已关 ⇒ 不计数、不推送，读数冻结；重新打开后卡片会随事件刷新。',
        'stats.replaced': '替换命中率',
        'stats.denied': '拒绝对照',
        'stats.dirty': '脏台账',
        'stats.lever': '软引导',
        'stats.index': '索引',
        'stats.r.hit': '被替换',
        'stats.r.den': '符号 grep 尝试',
        'stats.r.graph': '结构层命中',
        'stats.r.zg': '语义层命中',
        'stats.r.dirty': '脏让路',
        'stats.r.nohit': '无命中',
        'stats.r.err': '出错',
        'stats.r.blocked': '拦下',
        'stats.r.qfail': '查询失败',
        'stats.r.seen': '已提示过',
        'stats.r.record': '写入记账',
        'stats.r.sched': '已调度',
        'stats.r.done': '已刷新',
        'stats.r.fail': '刷新失败',
        'stats.r.pending': '未刷',
        'stats.r.calls': '封装调用',
        'stats.r.hints': '提示注入',
        'stats.r.retry': '并发重试',
        'stats.r.zgfail': '语义索引失败',
        'stats.updated': '{time} 更新 · 跨重启累计（关掉遥测则冻结）',
        reset: '恢复默认',
        saveFailed: '保存失败：配置已被改动或不可写，请重试或改配置文件。',
        foot: '其余字段（wrapperTools、zgEnabled、sessionRefresh…）仍需改 profile 的 cordis.patch.yml 并重启。',
      },
      en: {
        title: 'Search interception',
        summary: 'Interception mode, tool list, query budget, soft levers and staleness tracking — all editable here without a restart; runtime counters stay on the page.',
        loading: 'Loading configuration…',
        unavailable: 'This host does not expose the plugin settings yet (restart DSH to recompose the document).',
        'enforce.label': 'Grep interception',
        'enforce.off': 'Off',
        'enforce.off.hint': 'Never deny grep; the graph only guides through tool hints.',
        'enforce.deny-once': 'Deny once',
        'enforce.deny-once.hint': 'The first symbol-shaped grep is denied and answered with graph hits; later ones pass.',
        'enforce.deny': 'Always deny',
        'enforce.deny.hint': 'Every symbol-shaped grep is denied. Highest false-positive cost — check telemetry first.',
        'enforce.replace': 'Swap in retrieval',
        'enforce.replace.hint': 'Symbol-shaped greps still run, but the model-visible output is swapped for hits from the two retrieval layers: the structure layer (code graph) answers first, the semantic layer (zvec-grep) covers its misses; original output kept when both miss. No error raised — a true swap. Regular tools (code_find / zvec_grep_search) are unaffected; both layers stay available.',
        'telemetry.label': 'Record interception telemetry',
        'telemetry.hint': 'Counters land in the plugin store and show up in code_setup; turning it off stops counting, not interception.',
        'hint.label': 'Inject "search the graph first" hint',
        'hint.hint': 'Soft lever: when a question looks like a code lookup, inject one graph hint into the system prompt. Independent of swapping/denying.',
        'dirty.label': 'Write-after staleness ledger',
        'dirty.hint': 'Tracks code files this session edited; swaps and denials yield while dirty and schedule a refresh. Off means no yielding — staleness risk on you.',
        'interceptBudgetMs.label': 'Query budget (ms)',
        'interceptBudgetMs.hint': 'How long a swap waits for the index layers before keeping the original output. Applies on Enter or blur.',
        'interceptTools.label': 'Intercepted tools',
        'interceptTools.hint': 'Comma-separated, default grep,glob. Only listed tools get symbol-shaped searches swapped or denied.',
        'stats.label': 'Runtime counters',
        'stats.empty': 'Telemetry is off: nothing is counted or pushed, counters stay frozen. Turn it back on and the cards update live.',
        'stats.replaced': 'Swap hit rate',
        'stats.denied': 'Deny (comparison)',
        'stats.dirty': 'Dirty ledger',
        'stats.lever': 'Soft levers',
        'stats.index': 'Index',
        'stats.r.hit': 'swapped',
        'stats.r.den': 'symbol greps',
        'stats.r.graph': 'structure layer',
        'stats.r.zg': 'semantic layer',
        'stats.r.dirty': 'stale pass',
        'stats.r.nohit': 'no hit',
        'stats.r.err': 'errors',
        'stats.r.blocked': 'denied',
        'stats.r.qfail': 'query failed',
        'stats.r.seen': 'already seen',
        'stats.r.record': 'writes marked',
        'stats.r.sched': 'scheduled',
        'stats.r.done': 'refreshed',
        'stats.r.fail': 'refresh failed',
        'stats.r.pending': 'pending',
        'stats.r.calls': 'wrapper calls',
        'stats.r.hints': 'hints injected',
        'stats.r.retry': 'retries',
        'stats.r.zgfail': 'semantic index fails',
        'stats.updated': 'updated {time} · cumulative across restarts (freezes when telemetry is off)',
        reset: 'Reset',
        saveFailed: 'Save failed: the configuration changed or is not writable. Retry, or edit the config file.',
        foot: 'Other fields (wrapperTools, zgEnabled, sessionRefresh…) still require the profile cordis.patch.yml plus a restart.',
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
      const row = (children) => jsx('div', { style: ROW, children })
      // 非受控输入只在 blur/回车且值真变了时写表单；非法值把 DOM 拨回当前值，
      // 不替用户写一次他没要求的默认值。
      const parseNum = (raw) => { const n = Number.parseInt(raw, 10); return Number.isFinite(n) && n >= 50 ? n : null }
      const parseCsv = (raw) => { const s = String(raw ?? '').trim(); return s.length > 0 ? s : null }
      const commitField = (field, fallback, parse) => (e) => {
        const cur = value[field] ?? fallback
        const next = parse(e.target?.value)
        if (next === null) { if (e.target) e.target.value = String(cur) }
        else if (next !== cur) write(field, next)
      }
      const enterToBlur = (e) => { if (e.key === 'Enter') e.currentTarget?.blur?.() }
      const switchRow = (key, field) => row(jsxs('div', { style: LINE, children: [
        jsx(p.Switch, {
          label: props.t(`${key}.label`),
          title: props.t(`${key}.hint`),
          checked: value[field] !== false,
          disabled: !snap.writable || busy,
          onChange: (next) => write(field, next),
        }),
        field in user ? jsx(p.Button, { variant: 'ghost', size: 'sm', onClick: () => reset(field), children: props.t('reset') }) : null,
      ] }))
      const inputRow = (field, fallback, parse, opts) => row(jsxs('div', { style: LINE, children: [
        jsx('span', { style: HINT, children: props.t(`${field}.label`) }),
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
        field in user ? jsx(p.Button, { variant: 'ghost', size: 'sm', onClick: () => reset(field), children: props.t('reset') }) : null,
      ] }))

      return jsxs('div', { style: ROW, children: [
        row(jsxs('div', { style: LINE, children: [
          jsx(p.SegmentedControl, {
            id: `${ROW_KEY}-enforce`,
            label: props.t('enforce.label'),
            value: mode,
            disabled: !snap.writable || busy,
            options: MODES.map((m) => ({ value: m, label: props.t(`enforce.${m}`), title: props.t(`enforce.${m}.hint`) })),
            onChange: (next) => write('enforce', next),
          }),
          'enforce' in user ? jsx(p.Button, { variant: 'ghost', size: 'sm', onClick: () => reset('enforce'), children: props.t('reset') }) : null,
        ] })),
        jsx('div', { style: HINT, children: props.t(`enforce.${mode}.hint`) }),
        switchRow('telemetry', 'telemetry'),
        jsx('div', { style: HINT, children: props.t('telemetry.hint') }),
        switchRow('hint', 'contextHint'),
        jsx('div', { style: HINT, children: props.t('hint.hint') }),
        switchRow('dirty', 'dirtyTracking'),
        jsx('div', { style: HINT, children: props.t('dirty.hint') }),
        inputRow('interceptBudgetMs', 2500, parseNum, { type: 'number', min: 50, step: 100 }),
        jsx('div', { style: HINT, children: props.t('interceptBudgetMs.hint') }),
        inputRow('interceptTools', 'grep,glob', parseCsv, { type: 'text', style: INPUT_WIDE }),
        jsx('div', { style: HINT, children: props.t('interceptTools.hint') }),
        jsx('div', { style: ROW, children: statsBlock(props, value) }),
        failed ? jsx('div', { style: FAILED, children: props.t('saveFailed') }) : null,
        jsx('div', { style: HINT, children: props.t('foot') }),
      ] })
    }

    /** host 推来的只读读数（value.stats = volatile 字段里的 JSON 字符串）。
     *  卡片栅格照 dsh-mneme 状态页：每卡一个大数字 + 若干指标行，命中率卡带
     *  结构层/语义层占比条。纯展示，无编辑控件。遥测开着时卡片常驻：host 开机
     *  即推一帧零值快照，坏 JSON / 缺字段也按零渲染；空态只属于"关了遥测"。 */
    function statsBlock(props, value) {
      let s = null
      try { s = value.stats ? JSON.parse(value.stats) : null } catch { /* 坏 JSON 当没数 */ }
      const head = jsx('div', { style: HINT, children: props.t('stats.label') })
      if (!s || typeof s !== 'object') {
        if (value.telemetry === false) return [head, jsx('div', { style: HINT, children: props.t('stats.empty') })]
        // 遥测开着 ⇒ 卡片常驻（mneme 式）：没数就全零，空态只留给"关了遥测"。
        s = {}
      }
      const num = (v) => (typeof v === 'number' ? v : 0)
      const rp = s.replace || {}; const dn = s.deny || {}; const dy = s.dirty || {}; const lv = s.lever || {}; const ix = s.index || {}
      const den = num(rp.hit) + num(rp.passDirty) + num(rp.passNoHit) + num(rp.passFailed) + num(rp.error)
      const pct = den ? `${Math.round((num(rp.hit) / den) * 100)}%` : '—'
      const card = (title, big, rows, extra) => jsxs('div', { style: CARD, children: [
        jsx('h3', { style: CARD_TITLE, children: props.t(title) }),
        jsx('div', { style: NUM, children: String(big) }),
        jsx('div', { style: ROWS, children: rows.map(([k, v]) => jsxs('div', { style: RROW, children: [
          jsx('span', { children: props.t(k) }),
          jsx('span', { style: RVAL, children: String(v) }),
        ] }, k)) }),
        extra || null,
      ] })
      const seg = (n, background) => (n > 0 ? jsx('div', { style: { flex: n, minWidth: 2, background } }) : null)
      const bar = num(rp.graph) + num(rp.zg) > 0 ? jsxs('div', { children: [
        jsxs('div', { style: BAR, children: [
          seg(num(rp.graph), 'var(--dsw-alias-state-warning, #d97706)'),
          seg(num(rp.zg), 'var(--dsw-alias-label-tertiary, #888)'),
        ] }),
        jsx('div', { style: FOOT, children: [
          jsx('span', { children: props.t('stats.r.graph') }), jsx('span', { children: ` ${num(rp.graph)} · ` }),
          jsx('span', { children: props.t('stats.r.zg') }), jsx('span', { children: ` ${num(rp.zg)}` }),
        ] }),
      ] }) : null
      return [head, jsxs('div', { style: GRID, children: [
        card('stats.replaced', pct, [
          ['stats.r.hit', `${num(rp.hit)}/${den}`],
          ['stats.r.dirty', num(rp.passDirty)],
          ['stats.r.nohit', num(rp.passNoHit)],
          ['stats.r.qfail', num(rp.passFailed)],
          ['stats.r.err', num(rp.error)],
        ], bar),
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
          ['stats.r.hints', num(lv.hintInjected)],
        ]),
        card('stats.index', num(ix.retryContention), [
          ['stats.r.zgfail', num(ix.zgIndexFail)],
        ]),
      ] }),
      typeof s.at === 'number' ? jsx('div', { style: FOOT, children: props.t('stats.updated').split('{time}').join(new Date(s.at).toLocaleString()) }) : null,
      ].filter(Boolean)
    }

    const ROW = { display: 'grid', gap: '10px' }
    const LINE = { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }
    const HINT = { fontSize: '12px', opacity: 0.7, lineHeight: 1.5 }
    const INPUT = { width: '120px' }
    const INPUT_WIDE = { width: '220px' }
    const FAILED = { fontSize: '12px', color: 'crimson' }
    // ── 读数卡片样式：变量与尺寸取自 dsh-mneme 状态页 status.css（宿主 --dsw-alias-*）──
    const GRID = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px', marginTop: '8px' }
    const CARD = { minWidth: 0, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '12px', padding: '14px 14px 12px' }
    const CARD_TITLE = { margin: '0 0 8px', fontSize: '12px', fontWeight: 500, color: 'var(--dsw-alias-label-tertiary)' }
    const NUM = { fontSize: '24px', fontWeight: 600, lineHeight: '32px', color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums' }
    const ROWS = { marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '4px' }
    const RROW = { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', fontSize: '12px', lineHeight: '17px', color: 'var(--dsw-alias-label-tertiary)' }
    const RVAL = { color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }
    const BAR = { display: 'flex', height: '6px', borderRadius: '3px', overflow: 'hidden', marginTop: '12px', background: 'var(--dsw-alias-interactive-bg-hover)' }
    const FOOT = { marginTop: '8px', fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-dimmed)' }

    exports.apply = apply
    exports.inject = ['slots', 'locale', 'configForms']
    return module.exports
  },
})
