/**
 * patch 自检：cordis.patch.yml 里的 !!js 表达式必须能求值，而且指向真实文件。
 *
 *   node check-patch.mjs
 *
 * Loader 用 `new Function("ctx","expr","with (ctx) { return eval(expr) }")` 求值
 * （见 cordis-plugin-loader lib/types/config/utils.js），这里复用同一语义，
 * 不自己发明一套解析。`--dump-config` 只把表达式原样打印，所以它证明不了求值，
 * 这个脚本才是那条证据。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const text = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const exprs = [...text.matchAll(/!!js\s+(.+?)\s*$/gm)].map((m) => m[1])
if (exprs.length !== 3) {
  throw new Error(`cordis.patch.yml 里应有 3 个 !!js 表达式（mjs 路径、cbm.json 路径、cwd），实际 ${exprs.length}`)
}

const evaluate = new Function('ctx', 'expr', 'with (ctx) { return eval(expr) }')
const evalAll = () => exprs.map((expr) => {
  const value = evaluate({}, expr)
  if (typeof value !== 'string' || !value) throw new Error(`表达式未产出非空字符串：${expr} -> ${JSON.stringify(value)}`)
  return value
})

const [mjs, cfgJson, cwd] = evalAll()
const adapterDir = join(cwd, 'vendor', 'mcp-adapter')

const checks = [
  ['cwd 表达式 = DSH_HOME', () => cwd.endsWith('.dsh')],
  ['mjs 路径与 cwd 一致', () => mjs === join(adapterDir, 'node_modules', '@njuptlzf', 'mcp-adapter', 'mcp-server.mjs')],
  ['清单路径与 cwd 一致', () => cfgJson === join(adapterDir, 'cbm.json')],
  ['压缩层文件存在', () => existsSync(mjs)],
  ['清单文件存在', () => existsSync(cfgJson)],
  ['清单里的 cbm 指向真实 .exe', () => {
    const doc = JSON.parse(readFileSync(cfgJson, 'utf8'))
    const command = doc?.mcpServers?.cbm?.command
    return typeof command === 'string' && command.toLowerCase().endsWith('.exe') && existsSync(command)
  }],
  ['DSH_HOME 缺失时回退到 %USERPROFILE%\\.dsh 且同值', () => {
    const saved = process.env.DSH_HOME
    delete process.env.DSH_HOME
    try {
      return evalAll().every((v, i) => v === [mjs, cfgJson, cwd][i])
    } finally {
      if (saved !== undefined) process.env.DSH_HOME = saved
    }
  }],
]

let failed = 0
for (const [label, check] of checks) {
  let ok = false
  let reason = ''
  // 原来这里写的是 `catch (error) { label + ': ' + error.message }`——表达式结果被丢掉，
  // 异常只会显示成 FAIL 而看不到原因（诊断信息白拼了）。
  try {
    ok = check() === true
  } catch (error) {
    reason = String(error?.message ?? error)
  }
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !reason ? '' : '  ' + reason}`)
  if (!ok) failed++
}
if (failed) {
  console.error(`\n${failed} 项不成立；求值结果:\n  mjs=${mjs}\n  cfg=${cfgJson}\n  cwd=${cwd}`)
  process.exit(1)
}
console.log('\nPATCH OK')