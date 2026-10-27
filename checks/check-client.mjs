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
  'stats.r.qfailgraph', 'stats.r.lph', 'stats.r.lpc', 'stats.r.shdone', 'stats.r.shfail', 'stats.r.shnotgit', 'stats.budget',
  'selfHeal.label', 'selfHeal.hint',
  'hint.label', 'hint.hint', 'dirty.label', 'dirty.hint', 'interceptBudgetMs.label', 'interceptBudgetMs.hint',
  'interceptTools.label', 'interceptTools.hint',
  'sec.soft', 'sec.soft.hint', 'sec.hard', 'sec.hard.hint', 'sec.layers', 'sec.layers.hint',
  'sec.aux', 'sec.aux.hint', 'sec.params', 'sec.params.hint',
  'layer.graph', 'layer.graph.on', 'layer.adapter.stale', 'layer.adapter.noproc']) {
  ok(keys.includes(key), `字典有 key ${key}`)
}
for (const key of ['hint.label', 'dirty.label', 'interceptBudgetMs.label', 'interceptTools.label', 'resetField',
  'sec.soft', 'sec.hard', 'sec.layers', 'sec.aux', 'sec.params',
  'selfHeal.label', 'stats.r.shdone', 'stats.r.shnotgit',
  'layer.graph', 'layer.adapter.stale', 'layer.adapter.noproc']) {
  ok(Object.keys(dictEntry?.dict?.en || {}).includes(key), `en 字典有 key ${key}`)
}
// v0.17.0：语义层整体移除——zg 字典键若回潮（复制粘贴旧块），下面这条锁先炸。
ok(!keys.some((k) => k.startsWith('layer.zg') || k.startsWith('zg.')), 'zg.* / layer.zg.* 字典键不得回潮', keys.filter((k) => k.startsWith('layer.zg') || k.startsWith('zg.')).join('|'))
ok(!keys.includes('reset'), '没有裸「恢复默认」key——每个字段的恢复按钮必须叫「恢复此项」', keys.filter((k) => k.startsWith('reset')).join('|'))
for (const mode of modes) {
  ok(keys.includes(`enforce.${mode}`) && keys.includes(`enforce.${mode}.hint`), `字典覆盖模式 ${mode}`)
  ok(Object.keys(dictEntry?.dict?.en || {}).includes(`enforce.${mode}`), `en 字典同样覆盖 ${mode}`)
}

/* ---- 5. 渲染两态 + 点击写路径 ---- */
const flatten = (node, out = []) => {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { node.forEach((k) => flatten(k, out)); return out }
  if (typeof node === 'string' || typeof node === 'number') return out
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
ok(switches.length === 5, '渲染出 5 个 Switch（contextHint / markPassthrough / dirtyTracking / autoSelfHeal / telemetry——按层排布）', String(switches.length))
const texts185 = flatten(tree).map((n) => (typeof n.props?.children === 'string' ? n.props.children : '')).filter(Boolean)
ok(['sec.soft', 'sec.hard', 'sec.layers', 'sec.aux', 'sec.params'].every((k) => texts185.includes(k)),
  '五个分层标题按序在场（软引导→硬拦截→图谱层→记账遥测→参数）', texts185.filter((t) => t.startsWith('sec.')).join('|'))
ok(texts185.includes('layer.graph.on'),
  '图谱层状态行常驻（语义层移除后没有「状态未知」这一行了）', texts185.filter((t) => t.startsWith('layer.')).join('|'))
ok(switches[4]?.props?.checked === true, 'telemetry=true → checked', String(switches[4]?.props?.checked))
ok(switches[0]?.props?.checked === true && switches[2]?.props?.checked === true,
  'contextHint / dirtyTracking 缺省即开（!== false 判定）', `${switches[0]?.props?.checked}|${switches[2]?.props?.checked}`)
ok(switches[3]?.props?.checked === true, 'autoSelfHeal 缺省即开（fixture 未写该字段，!== false 判定为开）', String(switches[3]?.props?.checked))
ok(flatten(tree).some((n) => n.type === 'span' && n.props?.children === 'telemetry.label'),
  '开关标签与控件同行（span 自铺，不依赖 Switch 的 label prop 渲染）')

// 点击：改写宿主表单，而不是本地状态。
seg.props.onChange('deny')
switches[4].props.onChange(false)
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
ok(sw2[1].props.checked === false, 'markPassthrough 缺省关（!== true 判定）', String(sw2[1].props.checked))
sw2[1].props.onChange(true)
ok(JSON.stringify(calls.set) === JSON.stringify([['contextHint', true], ['markPassthrough', true]]),
  'markPassthrough 开关即时写（不写进 enforce=off 的默认里）', JSON.stringify(calls.set))
calls.set.length = 0
const inputs = flatten(tree).filter((n) => n.type === primitives.Input)
ok(inputs.length === 5, '五个输入框（interceptBudgetMs / graphBudgetMs / interceptTools / logRetentionDays / recentLimit——zgBudgetMs 随语义层删除）', String(inputs.length))
ok(inputs[0]?.props?.type === 'number' && inputs[0]?.props?.defaultValue === 2500
  && inputs[1]?.props?.defaultValue === 0
  && inputs[2]?.props?.defaultValue === 'grep,glob'
  && inputs[3]?.props?.defaultValue === 7 && inputs[4]?.props?.defaultValue === 100,
  '输入框回填主机快照当前值', `${inputs[0]?.props?.defaultValue}|${inputs[1]?.props?.defaultValue}|${inputs[2]?.props?.defaultValue}|${inputs[3]?.props?.defaultValue}|${inputs[4]?.props?.defaultValue}`)
inputs[0].props.onBlur({ target: { value: '1800' } })
ok(JSON.stringify(calls.set) === JSON.stringify([['interceptBudgetMs', 1800]]),
  'blur 且值合法才写表单（数字已解析）', JSON.stringify(calls.set))
const badNum = { value: 'abc' }
const badCsv = { value: '   ' }
inputs[0].props.onBlur({ target: badNum })
inputs[2].props.onBlur({ target: badCsv })
// 追加三输入（graphBudgetMs / logRetentionDays / recentLimit）也走 blur 才写；坏值一律不写并拨回默认
const badDays = { value: 'x' }
const badLimit = { value: '0' }
inputs[3].props.onBlur({ target: badDays })
inputs[4].props.onBlur({ target: badLimit })
ok(calls.set.length === 1 && badNum.value === '2500' && badCsv.value === 'grep,glob'
  && badDays.value === '7' && badLimit.value === '100',
  '非法/空值一个字节都不写，输入框拨回当前值', `${badNum.value}|${badCsv.value}|${badDays.value}|${badLimit.value}`)
let blurred = 0
const fakeTarget = { blur: () => { blurred += 1 } }
inputs[2].props.onKeyDown({ key: 'Enter', currentTarget: fakeTarget })
inputs[2].props.onKeyDown({ key: 'a', currentTarget: fakeTarget })
ok(blurred === 1, '回车即提交（走 blur），普通按键不打扰表单', String(blurred))
calls.unset.length = 0
const btns2 = flatten(tree).filter((n) => n.props && typeof n.props.onClick === 'function')
ok(btns2.length === 1, 'user 层只有 contextHint ⇒ 恰一个「恢复此项」', String(btns2.length))
btns2[0].props.onClick()
ok(JSON.stringify(calls.unset) === JSON.stringify(['contextHint']), '新字段的恢复默认同样走 form.unset', JSON.stringify(calls.unset))

/* ---- 5c. v0.17.0：图谱层状态行（语义层移除后不再有开关与五态推导）---- */
console.log('\n[图谱层状态]')
const layerText = (v) => {
  storeSnapshot = { status: 'ready', value: { enforce: 'off', telemetry: true, ...v }, base: {}, user: {}, writable: true, revision: 16 }
  return flatten(panel.component({ ...props })).map((n) => (typeof n.props?.children === 'string' ? n.props.children : '')).filter(Boolean)
}

/* ---- 5c2. v0.12.0（v0.17.0 收缩为进程轴）：适配层警示行 ---- */
ok(layerText({ stats: JSON.stringify({ adapter: 'stale' }) }).includes('layer.adapter.stale'),
  '进程轴 stale ⇒ 警示行（数据来自 stats.adapter）')
ok(layerText({ stats: JSON.stringify({ adapter: 'no-process' }) }).includes('layer.adapter.noproc'),
  'no-process ⇒ 另一句人话（宿主没起不是故障，别拿 stale 文案吓人）')
ok(!layerText({ stats: JSON.stringify({ adapter: 'fresh' }) }).some((t) => String(t).startsWith('layer.adapter.')),
  'fresh ⇒ 一行都不加（没病别呻吟）')
for (const lang of ['zh', 'en']) {
  const st = dictEntry?.dict?.[lang]?.['layer.adapter.stale'] || ''
  ok(/restart-adapter/.test(st), `${lang} stale 警示行指路 restart-adapter（不是只会喊重启宿主）`, st.slice(0, 60))
}

// v0.17.0：原 zgColor 五态三档色断言整段删除（ZgToggle 已死）；图谱行常态色由
// 上面 layer.graph.on 在场断言兜住。
storeSnapshot = { status: 'ready', value: { enforce: 'off', telemetry: true, stats: JSON.stringify({ adapter: 'fresh' }) }, base: {}, user: {}, writable: true, revision: 17 }
tree = panel.component({ ...props })
{
  const uTexts = flatten(tree).map((n) => (typeof n.props?.children === 'string' ? n.props.children : '')).filter(Boolean)
  ok(!uTexts.includes('layer.zg.ready') && !uTexts.some((t) => String(t).startsWith('zg.')),
    'zg 状态行与开关文案彻底不在场（防回潮）', uTexts.filter((t) => t.startsWith('zg.') || t.startsWith('layer.zg')).join('|'))
}

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
  replace: { hit: 8, graph: 6, passDirty: 2, passNoHit: 0, passFailed: 0, passFailedGraph: 0, error: 0 },
  deny: { blocked: 3, passDirty: 1, passNoHit: 2, passQueryFailed: 0, skipSeen: 4, error: 0 },
  dirty: { record: 9, refreshScheduled: 5, refreshDone: 4, refreshFail: 1 },
  lever: { wrapperCalls: 12, hintInjected: 3 },
  listProjects: { hot: 0, cacheHit: 5 },
  budget: { graph: 6000 },
  index: { retryContention: 1, selfHealStart: 4, selfHealDone: 2, selfHealFailed: 1, selfHealSkipNotGit: 1 },
})
storeSnapshot = { status: 'ready', value: { enforce: 'replace', telemetry: true, stats: statsJson }, base: {}, user: {}, writable: true, revision: 11 }
tree = panel.component({ ...props })
const texts = flatten(tree).map((n) => (typeof n.props?.children === 'string' ? n.props.children : '')).filter(Boolean)
console.log('\n[读数]')
ok(texts.includes('80%'), '命中率大数字 = hit/(hit+让路+无命中+出错)', texts.find((t) => t.endsWith('%')))
ok(texts.includes('8/10'), '被替换行 = hit/den', texts.filter((t) => /^\d+\/\d+$/.test(t)).join('|'))
ok(['stats.replaced', 'stats.denied', 'stats.dirty', 'stats.lever', 'stats.index'].every((k) => texts.includes(k)), '五张卡片都在')
// v0.16 死码清理：语义腿自 v0.15.0 M4' 退出替换通道，占比条随 zg/passFailedZg 两计数一并撤下（历史数在 telemetry JSONL 可翻）
// v0.17.0：语义层整体移除，leg/zg 读数不复存在——图谱腿、预算单腿、缓存命中都要在页上。
ok(texts.includes('stats.r.qfailgraph'), '失败计数按腿分开（图谱腿行在场）', texts.filter((t) => t.startsWith('stats.r.qfail')).join('|'))
ok(texts.includes('stats.r.lpc') && texts.includes('stats.r.lph'), '清单缓存命中/现查进索引卡（M1 的验收读数）')
// v0.18.0 O2：自愈首建的三个结果读数进索引卡（成功/失败/非 git 跳过）。
ok(texts.includes('stats.r.shdone') && texts.includes('stats.r.shfail') && texts.includes('stats.r.shnotgit'), '自动首建读数三行进索引卡', texts.filter((t) => t.startsWith('stats.r.sh')).join('|'))
// 夹具的 t() 原样返回 key（不查字典），所以这里断言"渲染了这一行"，
// 模板占位符由下面的字典断言单独锁（只剩 {graph}；{zg} 若回潮此锁先炸）。
ok(texts.includes('stats.budget') && /\{graph\}/.test(dictEntry?.dict?.zh?.['stats.budget'] ?? '') && !/\{zg\}/.test(dictEntry?.dict?.zh?.['stats.budget'] ?? ''),
  '图谱预算在页上（占位符只有 {graph}）', texts.filter((t) => /budget/.test(t)).join('|').slice(0, 80))
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

/* ---- 7. 仓库索引状态 + 最近替换效果 + 日志与环形上限（v0.14.0 新段落）---- */
console.log('\n[仓库 / 效果 / 日志]')
// 无 stats：两个新段落都要有各自的空态
storeSnapshot = { status: 'ready', value: { enforce: 'off', telemetry: true }, base: {}, user: {}, writable: true, revision: 20 }
tree = panel.component({ ...props })
const textsNoStats = flatten(tree).map((n) => (typeof n.props?.children === 'string' ? n.props.children : '')).filter(Boolean)
ok(textsNoStats.includes('sec.repos.empty') && textsNoStats.includes('sec.effect.empty'),
  '无 stats ⇒ 仓库表与最近效果都出各自的空态', textsNoStats.filter((t) => t.startsWith('sec.')).join('|'))
ok(textsNoStats.includes('sec.log'), '「日志与环形上限」段常驻')
ok(textsNoStats.includes('logRetentionDays.label') && textsNoStats.includes('recentLimit.label'),
  '两个新输入框的标签在场')

// 有 repos + recent：表格按 cwd 分列；outcome 徽标按 recent 键渲染；snippet 折叠在场
const statsWithRepos = JSON.stringify({
  at: 1791531188925,
  replace: { hit: 1, graph: 1, passDirty: 0, passNoHit: 0, error: 0 },
  deny: { blocked: 0, passDirty: 0, passNoHit: 0, passQueryFailed: 0, skipSeen: 0, error: 0 },
  dirty: { record: 0, refreshScheduled: 0, refreshDone: 0, refreshFail: 0 },
  lever: { wrapperCalls: 0, hintInjected: 0 },
  index: { retryContention: 0 },
  repos: [
    { cwd: 'C:/repoA', project: 'repo-a', replace: { 'intercept-replace': 3 }, deny: { 'intercept-deny': 1 } },
    { cwd: 'C:/repoB', project: '', replace: {}, deny: {} },
  ],
  recent: [
    { ts: 1791531188925, cwd: 'C:/repoA', project: 'repo-a', symbol: 'foo', source: 'graph', outcome: 'replaced-graph', snippet: 'results: 1\n#1 [foo]' },
    { ts: 1791531188924, cwd: 'C:/repoB', project: '', symbol: 'bar', source: 'graph', outcome: 'denied', snippet: 'results: 2\n#1 [bar]\n#2 [baz]' },
  ],
})
storeSnapshot = { status: 'ready', value: { enforce: 'replace', telemetry: true, stats: statsWithRepos }, base: {}, user: {}, writable: true, revision: 21 }
tree = panel.component({ ...props })
const textsRepos = flatten(tree).map((n) => (typeof n.props?.children === 'string' ? n.props.children : '')).filter(Boolean)
ok(textsRepos.some((t) => /repoA/.test(t)) && textsRepos.some((t) => /repoB/.test(t)),
  '仓库表按 cwd 列出两个仓库（basename 或末两级路径）',
  textsRepos.filter((t) => /repo[AB]/.test(t)).join('|'))
ok(textsRepos.includes('sec.repos.cbm'), '仓库表有 cbm project 列头')
ok(!textsRepos.includes('sec.repos.zg.yes') && !textsRepos.includes('sec.repos.zg.no'),
  'zg 列不得回潮（v0.17.0 语义层移除）', textsRepos.filter((t) => t.startsWith('sec.repos.')).join('|'))
ok(textsRepos.includes('recent.replaced-graph') && textsRepos.includes('recent.denied'),
  '最近效果区渲染 outcome 徽标（replaced-graph / denied）')
ok(!textsRepos.includes('sec.repos.empty') && !textsRepos.includes('sec.effect.empty'),
  '有数据时两个空态都不出现')
// snippet 用 <details>/<summary> 折叠——渲染出 <pre> 承载片段文本
const preNodes = flatten(tree).filter((n) => n.type === 'pre')
ok(preNodes.length >= 1 && /results: 1/.test(String(preNodes[0]?.props?.children)),
  '片段文本进 <pre>（折叠后展开可见）', JSON.stringify(preNodes[0]?.props?.children ?? '').slice(0, 60))
const repoSegs = flatten(tree).filter((n) => n.type === primitives.SegmentedControl)
ok(repoSegs.length === 2,
  '仓库筛选器是第二段 segmented（enforce + repo）',
  String(repoSegs.length))
ok(repoSegs[1]?.props?.options?.[0]?.label === 'sec.filter.all',
  '仓库筛选器首项为「全部」（值为空字符串），后续每项对应一个 cwd',
  JSON.stringify(repoSegs[1]?.props?.options ?? []).slice(0, 120))
// 输入框总数应为 5：interceptBudgetMs / graphBudgetMs / interceptTools / logRetentionDays / recentLimit
ok(flatten(tree).filter((n) => n.type === primitives.Input).length === 5,
  '总输入框数 = 5（整体预算 + 图谱预算 + 名单 + 保留天数/环形上限；zgBudgetMs 已删）',
  String(flatten(tree).filter((n) => n.type === primitives.Input).length))

console.log(`\n${failed === 0 ? 'check:client 全过' : `${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
