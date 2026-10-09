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
 * 只读 / 只写 `enforce` 与 `telemetry`：host 侧 Config 里没标 `.volatile()` 的字段，
 * dsh-settings 的 write() 会直接抛 "not volatile"，所以这个面板有意只暴露可热改的那几项。
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
    const MODES = ['off', 'deny-once', 'deny']

    const DICTIONARY = {
      zh: {
        title: '代码索引拦截',
        summary: '可在此热改 grep 硬拦截模式与遥测记录，无需重启。',
        loading: '正在读取配置…',
        unavailable: '当前宿主没有暴露该插件的配置项（需重启 DSH 让配置文档重新组合）。',
        'enforce.label': 'grep 硬拦截',
        'enforce.off': '关闭',
        'enforce.off.hint': '不拦 grep：只靠索引工具与提示词软引导。',
        'enforce.deny-once': '拒一次',
        'enforce.deny-once.hint': '符号形 pattern 首次 grep 被拒并回给你图谱命中；同一会话同一符号不再拦。',
        'enforce.deny': '持续拒绝',
        'enforce.deny.hint': '符号形 pattern 每次 grep 都被拒。误报代价最高，先看遥测再上。',
        'telemetry.label': '记录拦截遥测',
        'telemetry.hint': '拦截/放行计数写进插件自己的存储，code_setup 会报出来；关掉只是不再记数，不影响拦截本身。',
        reset: '恢复默认',
        saveFailed: '保存失败：配置已被改动或不可写，请重试或改配置文件。',
        foot: '其余字段（interceptTools、contextHint、wrapperTools、dirtyTracking…）仍需改 profile 的 cordis.patch.yml 并重启。',
      },
      en: {
        title: 'Index enforcement',
        summary: 'Grep interception mode and telemetry, live-editable without a restart.',
        loading: 'Loading configuration…',
        unavailable: 'This host does not expose the plugin settings yet (restart DSH to recompose the document).',
        'enforce.label': 'Grep interception',
        'enforce.off': 'Off',
        'enforce.off.hint': 'Never deny grep; the graph only guides through tool hints.',
        'enforce.deny-once': 'Deny once',
        'enforce.deny-once.hint': 'The first symbol-shaped grep is denied and answered with graph hits; later ones pass.',
        'enforce.deny': 'Always deny',
        'enforce.deny.hint': 'Every symbol-shaped grep is denied. Highest false-positive cost — check telemetry first.',
        'telemetry.label': 'Record interception telemetry',
        'telemetry.hint': 'Counters land in the plugin store and show up in code_setup; turning it off stops counting, not interception.',
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
        failed ? jsx('div', { style: FAILED, children: props.t('saveFailed') }) : null,
        jsx('div', { style: HINT, children: props.t('foot') }),
      ] })
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
