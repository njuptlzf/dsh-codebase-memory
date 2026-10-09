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
 * 写路径只有 `enforce` 与 `telemetry`；`stats` 是 host 推来的**只读读数**（volatile 字段
 * 里的 JSON 字符串，dsh-settings describe 的 plainConfig 实时解引用，不落配置文档）——
 * 面板渲染它但不给编辑控件。host 侧 Config 里没标 `.volatile()` 的字段，dsh-settings
 * 的 write() 会直接抛 "not volatile"，所以这个面板有意只暴露可热改的那几项。
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
        title: '代码索引拦截',
        summary: '可在此热改 grep 硬拦截模式与遥测记录，并查看运行读数，无需重启。',
        loading: '正在读取配置…',
        unavailable: '当前宿主没有暴露该插件的配置项（需重启 DSH 让配置文档重新组合）。',
        'enforce.label': 'grep 硬拦截',
        'enforce.off': '关闭',
        'enforce.off.hint': '不拦 grep：只靠索引工具与提示词软引导。',
        'enforce.deny-once': '拒一次',
        'enforce.deny-once.hint': '符号形 pattern 首次 grep 被拒并回给你图谱命中；同一会话同一符号不再拦。',
        'enforce.deny': '持续拒绝',
        'enforce.deny.hint': '符号形 pattern 每次 grep 都被拒。误报代价最高，先看遥测再上。',
        'enforce.replace': '换成索引',
        'enforce.replace.hint': '符号形 pattern 的 grep 照常执行，但模型看到的输出整体替换成图谱命中（图谱没答案时用语义检索；都没有就保留原输出）。不产生报错，硬替换。',
        'telemetry.label': '记录拦截遥测',
        'telemetry.hint': '拦截/放行计数写进插件自己的存储，code_setup 会报出来；关掉只是不再记数，不影响拦截本身。',
        'stats.label': '运行读数',
        'stats.empty': '暂无读数：开着遥测跑几天，第一次符号 grep / 写文件后这里自动刷新。',
        'stats.replace': '换成索引：{hit}/{den} 被替换（{pct}%）· 图谱 {graph} · 语义 {zg} · 脏让路 {dirty} · 无命中 {nohit} · 出错 {err}',
        'stats.deny': '持续拒绝：拦下 {blocked} · 脏让路 {dirty} · 无命中 {nohit} · 查询失败 {qfail} · 已提示过 {seen} · 出错 {err}',
        'stats.dirty': '脏台账：记录 {record} 次 · 刷新 {done}/{sched} · 失败 {fail}（未刷 = {sched}−{done}−{fail}）',
        'stats.lever': '软引导：封装工具调用 {calls} 次 · 提示注入 {hints} 次',
        'stats.index': '索引：并发重试 {retry} · 语义索引失败 {zgfail}',
        'stats.updated': '更新于 {time}（关掉遥测则冻结在这里）',
        reset: '恢复默认',
        saveFailed: '保存失败：配置已被改动或不可写，请重试或改配置文件。',
        foot: '其余字段（interceptTools、contextHint、wrapperTools、dirtyTracking…）仍需改 profile 的 cordis.patch.yml 并重启。',
      },
      en: {
        title: 'Index enforcement',
        summary: 'Grep interception mode, telemetry and runtime counters, live-editable without a restart.',
        loading: 'Loading configuration…',
        unavailable: 'This host does not expose the plugin settings yet (restart DSH to recompose the document).',
        'enforce.label': 'Grep interception',
        'enforce.off': 'Off',
        'enforce.off.hint': 'Never deny grep; the graph only guides through tool hints.',
        'enforce.deny-once': 'Deny once',
        'enforce.deny-once.hint': 'The first symbol-shaped grep is denied and answered with graph hits; later ones pass.',
        'enforce.deny': 'Always deny',
        'enforce.deny.hint': 'Every symbol-shaped grep is denied. Highest false-positive cost — check telemetry first.',
        'enforce.replace': 'Swap in index hits',
        'enforce.replace.hint': 'Symbol-shaped greps still run, but the model-visible output is replaced with graph hits (semantic search when the graph misses; original output kept when both miss). No error raised — a true swap.',
        'telemetry.label': 'Record interception telemetry',
        'telemetry.hint': 'Counters land in the plugin store and show up in code_setup; turning it off stops counting, not interception.',
        'stats.label': 'Runtime counters',
        'stats.empty': 'No data yet: keep telemetry on — the first symbol grep or file edit fills this in.',
        'stats.replace': 'Swapped: {hit}/{den} ({pct}%) · graph {graph} · semantic {zg} · stale-pass {dirty} · no-hit {nohit} · errors {err}',
        'stats.deny': 'Denied: {blocked} · stale-pass {dirty} · no-hit {nohit} · query-failed {qfail} · already-seen {seen} · errors {err}',
        'stats.dirty': 'Dirty ledger: {record} marks · refreshes {done}/{sched} · failed {fail} (pending = {sched}−{done}−{fail})',
        'stats.lever': 'Soft levers: {calls} wrapper calls · {hints} hints injected',
        'stats.index': 'Index: {retry} contention retries · {zgfail} semantic failures',
        'stats.updated': 'Updated {time} (freezes once telemetry is off)',
        reset: 'Reset',
        saveFailed: 'Save failed: the configuration changed or is not writable. Retry, or edit the config file.',
        foot: 'Other fields (interceptTools, contextHint, wrapperTools, dirtyTracking…) still require the profile cordis.patch.yml plus a restart.',
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
        row(jsxs('div', { style: LINE, children: [
          jsx(p.Switch, {
            label: props.t('telemetry.label'),
            title: props.t('telemetry.hint'),
            checked: value.telemetry !== false,
            disabled: !snap.writable || busy,
            onChange: (next) => write('telemetry', next),
          }),
          'telemetry' in user ? jsx(p.Button, { variant: 'ghost', size: 'sm', onClick: () => reset('telemetry'), children: props.t('reset') }) : null,
        ] })),
        jsx('div', { style: HINT, children: props.t('telemetry.hint') }),
        jsx('div', { style: ROW, children: statsBlock(props, value) }),
        failed ? jsx('div', { style: FAILED, children: props.t('saveFailed') }) : null,
        jsx('div', { style: HINT, children: props.t('foot') }),
      ] })
    }

    /** host 推来的只读读数（value.stats = volatile 字段里的 JSON 字符串）。纯展示，无编辑控件。 */
    function statsBlock(props, value) {
      let s = null
      try { s = value.stats ? JSON.parse(value.stats) : null } catch { /* 坏 JSON 当没数 */ }
      const line = (key, vars) => {
        let text = props.t(key)
        for (const name of Object.keys(vars || {})) text = text.split(`{${name}}`).join(String(vars[name]))
        return jsx('div', { style: HINT, children: text })
      }
      if (!s || typeof s !== 'object') return [line('stats.label'), line('stats.empty')]
      const num = (v) => (typeof v === 'number' ? v : 0)
      const rp = s.replace || {}; const dn = s.deny || {}; const dy = s.dirty || {}; const lv = s.lever || {}; const ix = s.index || {}
      const den = num(rp.hit) + num(rp.passDirty) + num(rp.passNoHit) + num(rp.error)
      return [line('stats.label'),
        line('stats.replace', { hit: num(rp.hit), den, pct: den ? Math.round((num(rp.hit) / den) * 100) : '—', graph: num(rp.graph), zg: num(rp.zg), dirty: num(rp.passDirty), nohit: num(rp.passNoHit), err: num(rp.error) }),
        line('stats.deny', { blocked: num(dn.blocked), dirty: num(dn.passDirty), nohit: num(dn.passNoHit), qfail: num(dn.passQueryFailed), seen: num(dn.skipSeen), err: num(dn.error) }),
        line('stats.dirty', { record: num(dy.record), done: num(dy.refreshDone), sched: num(dy.refreshScheduled), fail: num(dy.refreshFail) }),
        line('stats.lever', { calls: num(lv.wrapperCalls), hints: num(lv.hintInjected) }),
        line('stats.index', { retry: num(ix.retryContention), zgfail: num(ix.zgIndexFail) }),
        typeof s.at === 'number' ? line('stats.updated', { time: new Date(s.at).toLocaleString() }) : null,
      ].filter(Boolean)
    }

    const ROW = { display: 'grid', gap: '10px' }
    const LINE = { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }
    const HINT = { fontSize: '12px', opacity: 0.7, lineHeight: 1.5 }
    const FAILED = { fontSize: '12px', color: 'crimson' }

    exports.apply = apply
    exports.inject = ['slots', 'locale', 'configForms']
    return module.exports
  },
})
