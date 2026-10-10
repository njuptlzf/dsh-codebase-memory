/**
 * check:client — 在没有浏览器的情况下跑一遍 lib/client.js。
 *
 * 为什么要它：客户端半部的失败模式全是"静默"的——require 到一个宿主没注入的模块、
 * 槽 key 拼错、namespace 对不上，宿主只是什么都不渲染，设置页连「配置」按钮都不出现，
 * 人在 GUI 里根本分不清是"没接上"还是"接错了"。这里把 __ModuleLoader__ 与 client ctx
 * 都做成 stub，于是那三类错当场就能被断出来。
 *
 *   node checks/check-client.mjs        （由 npm run check 串起来）
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..').replace(/[\\/]+$/, '')
const read = (f) => readFileSync(join(repo, f), 'utf8')

let failed = 0
const ok = (cond, label, detail) => {
  if (cond) console.log(`  ok    ${label}`)
  else {
    failed++
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/* ---- 1. package.json 的声明与 bundle 对得上 ---- */
const pkg = JSON.parse(read('package.json'))
const clientBundle = 'lib/client.js'
console.log('\n[package.json]')
ok(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform = web', JSON.stringify(pkg.dsh?.client))
ok(typeof pkg.exports?.['./client'] === 'string', 'exports["./client"] 是字符串（宿主只认字符串或 {default}）')
ok(pkg.exports?.['./client'] === `./${clientBundle}`, `exports["./client"] = ./${clientBundle}`, pkg.exports?.['./client'])
ok((pkg.files || []).includes(clientBundle), 'files 里有 lib/client.js（否则 npm pack 会漏掉）')
ok((pkg.dsh?.client?.inject || []).includes('@deepseek-ai/dsh-client-ui-settings'), 'dsh.client.inject 声明了提供 configForms 的包')

/* ---- 2. 槽 key / namespace 必须等于 `${包名}#${row id}` 与 profile entry id ---- */
const patch = read('cordis.patch.yml')
const rows = []
for (const m of patch.matchAll(/-\s+id:\s*([\w-]+)\s*\n\s+name:\s*'?([^'\n]+)'?/g)) rows.push({ id: m[1], name: m[2].trim() })
const rowId = rows.find((r) => r.name === pkg.name)?.id
ok(!!rowId, `cordis.patch.yml 里有 name: ${pkg.name} 的 row（解析到 ${rows.map((r) => r.id).join(', ')}）`, rowId)
const expectedKey = `${pkg.name}#${rowId}`
console.log(`  info  row id = ${rowId} → plugins.row.config 的 key = ${expectedKey}，settings namespace = ${rowId}`)

const hostConfig = read('index.js')
const modes = [...(hostConfig.match(/ENFORCE_MODES\s*=\s*\[([^\]]*)\]/) || ['', ''])[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
ok(modes.length > 0, '从 index.js 解析出 ENFORCE_MODES', modes.join('|'))

/* ---- 3. 在 stub 的 __ModuleLoader__ 里装载 bundle ---- */
const required = []
// 组件桩要按名字缓存：proxy 每次返回新函数的话，断言里的恒等比较（t === primitives.SegmentedControl）就全废了。
const components = new Map()
const stubComponent = (name) => {
  if (!components.has(name)) components.set(name, () => null)
  return components.get(name)
}
const primitives = new Proxy({}, {
  get: (_t, prop) => (typeof prop === 'string' ? stubComponent(prop) : undefined),
  has: () => true,
})
const makeRequire = () => (id) => {
  required.push(id)
  if (id === 'react') return reactStub
  if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`bundle require 了宿主隐式 baseline 之外的模块：${id}（要写进 dsh.client.external）`)
}

// useSyncExternalStore 的 fake：每次 render 直接取当前快照；useState 的 setter 记录最后一次值。
const hooks = { state: new Map() }
let storeSnapshot = null
const reactStub = {
  useSyncExternalStore: (subscribe, getSnapshot) => { subscribe(() => {}); return getSnapshot() },
  useState: (init) => [init, () => {}],
  useEffect: () => {},
  createElement: (type, props, ...children) => ({ type, props: { ...(props || {}), children } }),
  Fragment: 'Fragment',
}

const events = []
const registrations = []
const dicts = []
let whileServedArgs = null
const calls = { set: [], unset: [] }
const form = {
  subscribe: (l) => (typeof l === 'function' ? events.push('subscribe') : 0),
  getSnapshot: () => storeSnapshot,
  set: (field, value) => { calls.set.push([field, value]); return Promise.resolve(true) },
  unset: (field) => { calls.unset.push(field); return Promise.resolve(true) },
  dispose: () => events.push('dispose'),
}
const ctx = {
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : undefined },
  locale: { bind: () => (key) => key, register: (ns, dict) => dicts.push({ ns, dict }) },
  configForms: {
    get: (entryId) => { events.push(`get:${entryId}`); return form },
    whileServed: (namespaces, register) => { whileServedArgs = { namespaces, register }; return register(true) },
    describe: () => ({ namespaces: [] }),
  },
  slots: {
    inject: (name, factory) => { events.push(`inject:${name}`); return factory() },
    register: (options, component) => { registrations.push({ ...options, component }); return () => events.push('unregistered') },
  },
}

const source = read(clientBundle)
let plugin = null
try {
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => { sandbox.__loaded = entry } } },
    console,
    Promise,
    Object,
    JSON,
    React: reactStub,
  }
  vm.createContext(sandbox)
  new vm.Script(source, { filename: clientBundle }).runInContext(sandbox)
  const entry = sandbox.__loaded
  ok(!!entry, 'bundle 调用了 window.__ModuleLoader__.load')
  ok(entry?.id === pkg.name, `load id === 包名（${pkg.name}）`, entry?.id)
  ok(typeof entry?.factory === 'function', 'factory 是函数')
  plugin = entry.factory(makeRequire())
} catch (err) {
  failed++
  console.log(`  FAIL  装载 lib/client.js 抛错：${err && err.message}`)
}
console.log(`\n[装载] require: ${required.join(', ')}`)
ok(typeof plugin?.apply === 'function', 'exports.apply 是函数')
ok(Array.isArray(plugin?.inject) && plugin.inject.length > 0, 'exports.inject 是非空数组（client 侧服务名）', JSON.stringify(plugin?.inject))
for (const name of ['slots', 'locale', 'configForms']) {
  ok((plugin?.inject || []).includes(name), `exports.inject 里有 ${name}`)
}

if (!plugin?.apply) {
  console.log(`\n${failed} 项失败`)
  process.exit(1)
}

/* ---- 4. 跑 apply，检查注册参数 ---- */
try { plugin.apply(ctx) } catch (err) { failed++; console.log(`  FAIL  apply(ctx) 抛错：${err && err.message}`) }
const panel = registrations.find((r) => r.name === 'plugins.row.config')
console.log('\n[注册]')
ok(!!panel, '注册了 plugins.row.config 槽')
ok(panel?.key === expectedKey, `槽 key = ${expectedKey}`, panel?.key)
ok(JSON.stringify(whileServedArgs?.namespaces || []) === JSON.stringify([rowId]), `whileServed([${rowId}]) —— 与 host 侧 settings namespace 必须一致`, JSON.stringify(whileServedArgs?.namespaces))
ok(events.includes(`get:${rowId}`), `configForms.get('${rowId}')`, events.join('|'))
ok(typeof panel?.component === 'function', '槽带组件函数')
ok(typeof panel?.label === 'function', '槽带 label（宿主导航列表要用）')

const dictEntry = dicts[0]
ok(!!dictEntry, '注册了 locale 字典')
ok(!!dictEntry && dictEntry.ns === panel?.locale, 'locale 字典的 NS 与 register({locale}) 一致', `${dictEntry?.ns} vs ${panel?.locale}`)
for (const lang of ['zh', 'en']) ok(!!dictEntry?.dict?.[lang], `字典有 ${lang}`)
const keys = Object.keys(dictEntry?.dict?.zh || {})
for (const key of ['title', 'summary', 'loading', 'unavailable', 'enforce.label', 'telemetry.label', 'resetField', 'saveFailed', 'foot',
  'stats.label', 'stats.empty', 'stats.replaced', 'stats.denied', 'stats.dirty', 'stats.lever', 'stats.index', 'stats.updated',
  'stats.r.graph', 'stats.r.zg',
  'hint.label', 'hint.hint', 'dirty.label', 'dirty.hint', 'interceptBudgetMs.label', 'interceptBudgetMs.hint',
  'interceptTools.label', 'interceptTools.hint',
  'sec.soft', 'sec.soft.hint', 'sec.hard', 'sec.hard.hint', 'sec.layers', 'sec.layers.hint',
  'sec.aux', 'sec.aux.hint', 'sec.params', 'sec.params.hint',
  'layer.graph', 'layer.graph.on', 'layer.zg', 'layer.zg.off', 'layer.zg.ready', 'layer.zg.missing', 'layer.zg.unknown',
  'layer.zg.installed', 'layer.zg.installing', 'layer.zg.pending-on', 'layer.zg.pending-off',
  'zg.label', 'zg.hint', 'zg.confirm.title', 'zg.confirm.body', 'zg.confirm.yes', 'zg.confirm.no']) {
  ok(keys.includes(key), `字典有 key ${key}`)
}
for (const key of ['hint.label', 'dirty.label', 'interceptBudgetMs.label', 'interceptTools.label', 'resetField',
  'sec.soft', 'sec.hard', 'sec.layers', 'sec.aux', 'sec.params',
  'layer.graph', 'layer.zg', 'layer.zg.off', 'layer.zg.ready', 'layer.zg.missing', 'layer.zg.unknown',
  'layer.zg.installed', 'layer.zg.installing', 'layer.zg.pending-on', 'layer.zg.pending-off',
  'zg.label', 'zg.hint', 'zg.confirm.title', 'zg.confirm.body', 'zg.confirm.yes', 'zg.confirm.no']) {
  ok(Object.keys(dictEntry?.dict?.en || {}).includes(key), `en 字典有 key ${key}`)
}
// 确认面板是"人点头"的那一环：文案必须把真实代价写全（v0.11.0 验收要求含 gitignore 提醒）。
for (const lang of ['zh', 'en']) {
  const body = dictEntry?.dict?.[lang]?.['zg.confirm.body'] || ''
  ok(/1230MB/.test(body) && /430MB/.test(body) && /32MiB/.test(body) && /\.zvec-grep\//.test(body) && /gitignore/i.test(body) && /install-zg/.test(body),
    `${lang} 确认文案写足代价（全装/净体积/模型/.zvec-grep→gitignore/装包路线）`, body.slice(0, 60))
}
ok(!keys.includes('reset'), '没有裸「恢复默认」key——每个字段的恢复按钮必须叫「恢复此项」', keys.filter((k) => k.startsWith('reset')).join('|'))
for (const mode of modes) {
  ok(keys.includes(`enforce.${mode}`) && keys.includes(`enforce.${mode}.hint`), `字典覆盖模式 ${mode}`)
  ok(Object.keys(dictEntry?.dict?.en || {}).includes(`enforce.${mode}`), `en 字典同样覆盖 ${mode}`)
}

/* ---- 5. 渲染两态 + 点击写路径 ---- */
const flatten = (node, out = []) => {
  if (node === null || node === undefined || typeof node === 'string') return out
  out.push(node)
  const kids = node.props?.children
  if (Array.isArray(kids)) kids.forEach((k) => flatten(k, out))
  else if (kids && typeof kids === 'object') flatten(kids, out)
  return out
}
const findType = (tree, pred) => flatten(tree).find((node) => pred(node))
const props = { t: (key) => key, view: 'page' }

storeSnapshot = { status: 'ready', value: { enforce: 'deny-once', telemetry: true }, base: {}, user: {}, writable: true, revision: 7 }
let tree = panel.component({ ...props })
const seg = findType(tree, (n) => n.type === primitives.SegmentedControl)
console.log('\n[交互]')
ok(!!seg, 'ready 态渲染出 SegmentedControl（enforce）')
const segValues = (seg?.props?.options || []).map((o) => o.value)
ok(JSON.stringify(segValues) === JSON.stringify(modes), '分段控件的选项 = ENFORCE_MODES 且同序', segValues.join('|'))
ok(seg?.props?.value === 'deny-once', '分段控件当前值取自主机快照', seg?.props?.value)
ok(seg?.props?.disabled === false, 'writable 时控件可用')
const switches = flatten(tree).filter((n) => n.type === primitives.Switch)
ok(switches.length === 3, '渲染出 3 个 Switch（contextHint / dirtyTracking / telemetry——按层排布）', String(switches.length))
const texts185 = flatten(tree).map((n) => (typeof n.props?.children === 'string' ? n.props.children : '')).filter(Boolean)
ok(['sec.soft', 'sec.hard', 'sec.layers', 'sec.aux', 'sec.params'].every((k) => texts185.includes(k)),
  '五个分层标题按序在场（软引导→硬拦截→检索两层→记账遥测→参数）', texts185.filter((t) => t.startsWith('sec.')).join('|'))
ok(texts185.includes('layer.graph.on') && texts185.includes('layer.zg.unknown'),
  '检索两层状态行常驻；没数时语义层明说「状态未知」', texts185.filter((t) => t.startsWith('layer.')).join('|'))
ok(switches[2]?.props?.checked === true, 'telemetry=true → checked', String(switches[2]?.props?.checked))
ok(switches[0]?.props?.checked === true && switches[1]?.props?.checked === true,
  'contextHint / dirtyTracking 缺省即开（!== false 判定）', `${switches[0]?.props?.checked}|${switches[1]?.props?.checked}`)
ok(flatten(tree).some((n) => n.type === 'span' && n.props?.children === 'telemetry.label'),
  '开关标签与控件同行（span 自铺，不依赖 Switch 的 label prop 渲染）')

// 点击：改写宿主表单，而不是本地状态。
seg.props.onChange('deny')
switches[2].props.onChange(false)
ok(JSON.stringify(calls.set) === JSON.stringify([['enforce', 'deny'], ['telemetry', false]]), 'onChange 直接 form.set(字段, 值)', JSON.stringify(calls.set))
ok(findType(tree, (n) => n.type === primitives.Button) === undefined, 'user 层为空 → 不显示任何「恢复此项」')

storeSnapshot = { status: 'ready', value: { enforce: 'deny', telemetry: true }, base: {}, user: { enforce: 'deny' }, writable: true, revision: 8 }
tree = panel.component({ ...props })
const buttons = flatten(tree).filter((n) => n.props && typeof n.props.onClick === 'function')
ok(buttons.length >= 1, 'user 层有 enforce → 出现「恢复此项」按钮', String(buttons.length))
buttons[0].props.onClick()
ok(JSON.stringify(calls.unset) === JSON.stringify(['enforce']), '按钮走 form.unset（回到 bundle 默认值）', JSON.stringify(calls.unset))

storeSnapshot = { status: 'ready', value: { enforce: 'off', telemetry: false }, base: {}, user: {}, writable: false, revision: 9 }
tree = panel.component({ ...props })
ok(findType(tree, (n) => n.type === primitives.SegmentedControl)?.props?.disabled === true, 'writable=false → 控件禁用', JSON.stringify(findType(tree, (n) => n.type === primitives.SegmentedControl)?.props?.disabled))

/* ---- 5b. v0.9.0 新控件：contextHint/dirtyTracking 开关 + 预算/名单 blur 输入 ---- */
storeSnapshot = { status: 'ready', value: { enforce: 'off', telemetry: true, contextHint: false, dirtyTracking: true, interceptBudgetMs: 2500, interceptTools: 'grep,glob' }, base: {}, user: { contextHint: false }, writable: true, revision: 15 }
tree = panel.component({ ...props })
const sw2 = flatten(tree).filter((n) => n.type === primitives.Switch)
calls.set.length = 0
sw2[0].props.onChange(true)
ok(sw2[0].props.checked === false, 'contextHint=false → 开关显示关（缺省开只属于 !== false）', String(sw2[0].props.checked))
const inputs = flatten(tree).filter((n) => n.type === primitives.Input)
ok(inputs.length === 2, '两个输入框（interceptBudgetMs / interceptTools）', String(inputs.length))
ok(inputs[0]?.props?.type === 'number' && inputs[0]?.props?.defaultValue === 2500
  && inputs[1]?.props?.defaultValue === 'grep,glob', '输入框回填主机快照当前值', `${inputs[0]?.props?.defaultValue}|${inputs[1]?.props?.defaultValue}`)
inputs[0].props.onBlur({ target: { value: '1800' } })
ok(JSON.stringify(calls.set) === JSON.stringify([['contextHint', true], ['interceptBudgetMs', 1800]]),
  '开关即时写；blur 且值合法才写表单（数字已解析）', JSON.stringify(calls.set))
const badNum = { value: 'abc' }
const badCsv = { value: '   ' }
inputs[0].props.onBlur({ target: badNum })
inputs[1].props.onBlur({ target: badCsv })
ok(calls.set.length === 2 && badNum.value === '2500' && badCsv.value === 'grep,glob',
  '非法/空值一个字节都不写，输入框拨回当前值', `${badNum.value}|${badCsv.value}`)
let blurred = 0
const fakeTarget = { blur: () => { blurred += 1 } }
inputs[1].props.onKeyDown({ key: 'Enter', currentTarget: fakeTarget })
inputs[1].props.onKeyDown({ key: 'a', currentTarget: fakeTarget })
ok(blurred === 1, '回车即提交（走 blur），普通按键不打扰表单', String(blurred))
calls.unset.length = 0
const btns2 = flatten(tree).filter((n) => n.props && typeof n.props.onClick === 'function')
ok(btns2.length === 1, 'user 层只有 contextHint ⇒ 恰一个「恢复此项」', String(btns2.length))
btns2[0].props.onClick()
ok(JSON.stringify(calls.unset) === JSON.stringify(['contextHint']), '新字段的恢复默认同样走 form.unset', JSON.stringify(calls.unset))

/* ---- 5c. v0.11.0 语义层开关：两步确认 + 三轴状态行（页面不撒谎）---- */
console.log('\n[语义层开关]')
const layerText = (v) => {
  storeSnapshot = { status: 'ready', value: { enforce: 'off', telemetry: true, ...v }, base: {}, user: {}, writable: true, revision: 16 }
  return flatten(panel.component({ ...props })).map((n) => (typeof n.props?.children === 'string' ? n.props.children : '')).filter(Boolean)
}
ok(layerText({ zgEnabled: false, stats: JSON.stringify({ zg: 'off', zgWant: false, zgInstalled: false }) }).includes('layer.zg.off'),
  '开关关 + 清单 off ⇒ 状态行「未启用」')
ok(layerText({ zgEnabled: true, stats: JSON.stringify({ zg: 'off' }) }).includes('layer.zg.pending-on'),
  '开关已开、清单未重建 ⇒ pending-on（诚实说「重启后生效」，不谎称已开启）')
ok(layerText({ zgEnabled: false, stats: JSON.stringify({ zg: 'ready' }) }).includes('layer.zg.pending-off'),
  '开关已关、清单还带着 ⇒ pending-off')
ok(layerText({ zgEnabled: true, stats: JSON.stringify({ zg: 'missing', zgInstalled: true }) }).includes('layer.zg.installed'),
  '清单说 missing 但包实测在 ⇒ installed 待重启（两轴分开报，不合成一个谎）')
ok(layerText({ zgEnabled: true, stats: JSON.stringify({ zg: 'installing' }) }).includes('layer.zg.installing'),
  'agent 正在装（volatile 推帧）⇒ installing')

storeSnapshot = { status: 'ready', value: { enforce: 'off', telemetry: true, zgEnabled: false, stats: JSON.stringify({ zg: 'off' }) }, base: {}, user: {}, writable: true, revision: 17 }
tree = panel.component({ ...props })
const zgEl = findType(tree, (n) => typeof n.type === 'function' && n.type.name === 'ZgToggle')
ok(!!zgEl, '「检索两层」段渲染出语义层开关组件（ZgToggle）')
const writes = []
const zgProps = { ...zgEl.props, onWrite: (v) => writes.push(v) }
const idleTexts = flatten(zgEl.type(zgProps)).map((n) => (typeof n.props?.children === 'string' ? n.props.children : '')).filter(Boolean)
ok(idleTexts.includes('zg.label') && !idleTexts.includes('zg.confirm.title'), '未点击时只有开关行，没有确认面板')
const zgSwitch = flatten(zgEl.type(zgProps)).find((n) => n.type === primitives.Switch)
ok(!!zgSwitch && zgSwitch.props.checked === false, '开关态取自 zgEnabled（不是清单事实）', String(zgSwitch?.props?.checked))
zgSwitch.props.onChange(true)
ok(writes.length === 0, '点「开」不当场写表单——先停在确认这一步', JSON.stringify(writes))
reactStub.useState = (init) => [true, () => {}] // 强制 confirming=true，看确认面板
const confirmTree = zgEl.type(zgProps)
const cTexts = flatten(confirmTree).map((n) => (typeof n.props?.children === 'string' ? n.props.children : '')).filter(Boolean)
const cBtns = flatten(confirmTree).filter((n) => n.props && typeof n.props.onClick === 'function')
ok(cTexts.includes('zg.confirm.title') && cTexts.includes('zg.confirm.body'), '确认面板在场：标题 + 代价文案')
ok(cBtns.length === 2, '确认面板两个按钮（确认开启 / 取消）', String(cBtns.length))
cBtns[1].props.onClick()
ok(writes.length === 0, '点「取消」一个字节都不写', JSON.stringify(writes))
cBtns[0].props.onClick()
ok(JSON.stringify(writes) === JSON.stringify([true]), '点「确认开启」才写 zgEnabled=true', JSON.stringify(writes))
reactStub.useState = (init) => [init, () => {}]
writes.length = 0
flatten(zgEl.type(zgProps)).find((n) => n.type === primitives.Switch)?.props.onChange(false)
ok(JSON.stringify(writes) === JSON.stringify([false]), '关闭不经过确认，直接写（关没有开销）', JSON.stringify(writes))

storeSnapshot = { status: 'loading', value: {}, base: {}, user: {}, writable: false, revision: 0 }
tree = panel.component({ ...props })
ok(flatten(tree).some((n) => typeof n.props?.children === 'string' && n.props.children === 'loading'), 'loading 态有占位文案')

storeSnapshot = { status: 'unavailable', value: {}, base: {}, user: {}, writable: false, revision: 0 }
tree = panel.component({ ...props })
ok(flatten(tree).some((n) => typeof n.props?.children === 'string' && n.props.children === 'unavailable'), 'unavailable 态有说明文案（宿主没 serve 时不白屏）')

ok(panel.component({ ...props, view: 'summary' }) === 'summary', 'summary 态返回一行文案（RowDetail 用）')

/* ---- 6. 读数卡片（stats 只读，样式参考 dsh-mneme 状态页）---- */
const statsJson = JSON.stringify({
  at: 1791531188925,
  zg: 'ready',
  replace: { hit: 8, graph: 6, zg: 2, passDirty: 2, passNoHit: 0, error: 0 },
  deny: { blocked: 3, passDirty: 1, passNoHit: 2, passQueryFailed: 0, skipSeen: 4, error: 0 },
  dirty: { record: 9, refreshScheduled: 5, refreshDone: 4, refreshFail: 1 },
  lever: { wrapperCalls: 12, hintInjected: 3 },
  index: { retryContention: 1, zgIndexFail: 0 },
})
storeSnapshot = { status: 'ready', value: { enforce: 'replace', telemetry: true, zgEnabled: true, stats: statsJson }, base: {}, user: {}, writable: true, revision: 11 }
tree = panel.component({ ...props })
const texts = flatten(tree).map((n) => (typeof n.props?.children === 'string' ? n.props.children : '')).filter(Boolean)
console.log('\n[读数]')
ok(texts.includes('80%'), '命中率大数字 = hit/(hit+让路+无命中+出错)', texts.find((t) => t.endsWith('%')))
ok(texts.includes('8/10'), '被替换行 = hit/den', texts.filter((t) => /^\d+\/\d+$/.test(t)).join('|'))
ok(['stats.replaced', 'stats.denied', 'stats.dirty', 'stats.lever', 'stats.index'].every((k) => texts.includes(k)), '五张卡片都在')
ok(texts.includes('stats.r.graph') && texts.includes('stats.r.zg'), '占比条题注区分结构层/语义层（两层并存，不是二选一）')
ok(texts.includes('layer.zg.ready'), '状态行的语义层取自 stats.zg（有数时用实测状态，不再「未知」）', texts.filter((t) => t.startsWith('layer.')).join('|'))
ok(flatten(tree).filter((n) => n.type === primitives.SegmentedControl).length === 1
  && flatten(tree).filter((n) => n.props && typeof n.props.onClick === 'function').length === 0, '读数块不新增交互件（卡片全只读）')
storeSnapshot = { status: 'ready', value: { enforce: 'off', telemetry: true, stats: '{坏' }, base: {}, user: {}, writable: true, revision: 12 }
tree = panel.component({ ...props })
const textsBad = flatten(tree).map((n) => (typeof n.props?.children === 'string' ? n.props.children : '')).filter(Boolean)
ok(textsBad.includes('stats.replaced') && textsBad.includes('—') && !textsBad.includes('stats.empty'),
  '坏 JSON + 遥测开 ⇒ 零值卡片常驻（大数字破折号），不进空态')
storeSnapshot = { status: 'ready', value: { enforce: 'off', telemetry: true, stats: '' }, base: {}, user: {}, writable: true, revision: 13 }
tree = panel.component({ ...props })
const textsZero = flatten(tree).map((n) => (typeof n.props?.children === 'string' ? n.props.children : '')).filter(Boolean)
ok(['stats.replaced', 'stats.denied', 'stats.dirty', 'stats.lever', 'stats.index'].every((k) => textsZero.includes(k))
  && textsZero.includes('0/0'), '遥测开但 host 没推过数 ⇒ 五张零值卡（0/0），mneme 式常驻')
storeSnapshot = { status: 'ready', value: { enforce: 'off', telemetry: false, stats: '' }, base: {}, user: {}, writable: true, revision: 14 }
tree = panel.component({ ...props })
ok(flatten(tree).some((n) => n.props?.children === 'stats.empty'), '空态只属于"关了遥测"')

console.log(`\n${failed === 0 ? 'check:client 全过' : `${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
