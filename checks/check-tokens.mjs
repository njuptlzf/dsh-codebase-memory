/**
 * 消融臂：直挂 cbm 17 个工具  vs  经 mcp-adapter 代理，量 tools/list 的实际体积。
 *
 *   node check-tokens.mjs
 *
 * 论点是"代理把 N 份 schema 压成 1 个"，所以臂 A（直连 cbm）必须显著大于臂 B
 * （经 adapter）。不成立就 throw——消融臂的意义就是给主结论一个能塌的前提。
 */
import { spawn } from 'node:child_process'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE, '.dsh')
const CBM = process.env.CBM_PATH || join(dshHome, 'vendor', 'codebase-memory-mcp', 'bin', 'codebase-memory-mcp.exe')
const ADAPTER = join(dshHome, 'vendor', 'mcp-adapter', 'node_modules', '@njuptlzf', 'mcp-adapter', 'mcp-server.mjs')
const CONFIG = join(dshHome, 'vendor', 'mcp-adapter', 'cbm.json')

for (const [what, path] of [['cbm', CBM], ['adapter', ADAPTER], ['config', CONFIG]]) {
  if (!existsSync(path)) throw new Error(`${what} not found: ${path}`)
}

/** 一个极小的 MCP stdio 客户端：够用就好，不做协议封装。 */
async function listTools(argv, env) {
  const child = spawn(argv[0], argv.slice(1), {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      const resolve = pending.get(message.id)
      if (resolve) { pending.delete(message.id); resolve(message) }
    }
  })
  let id = 0
  const call = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 240000)
    pending.set(myId, (message) => {
      clearTimeout(timer)
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
      else resolve(message.result)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n')
  })
  try {
    await call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'dsh-cbm-token-check', version: '0.1.0' },
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    const result = await call('tools/list', {})
    const tools = result.tools ?? []
    return {
      count: tools.length,
      bytes: Buffer.byteLength(JSON.stringify(tools), 'utf8'),
      names: tools.map((t) => t.name),
    }
  } finally {
    child.kill()
  }
}

const direct = await listTools([CBM], { CBM_LOG_LEVEL: 'none' })

// adapter 的工具面由元数据缓存决定（~/.pi/agent/mcp-cache.json）：缓存里一旦记录了
// 服务器的 resources，就会多出一个常驻资源工具。所以消融臂必须分别报冷/热两种状态，
// 否则数字随历史而不稳定。冷缓存测量会临时移开缓存，finally 里原样放回。
const CACHE = join(process.env.USERPROFILE, '.pi', 'agent', 'mcp-cache.json')
const CACHE_BAK = CACHE + '.dsh-check-bak'
let cold
try {
  if (existsSync(CACHE)) renameSync(CACHE, CACHE_BAK)
  cold = await listTools([process.execPath, ADAPTER, '--config', CONFIG], {})
} finally {
  if (existsSync(CACHE_BAK)) {
    rmSync(CACHE, { force: true })
    renameSync(CACHE_BAK, CACHE)
  }
}
const warm = await listTools([process.execPath, ADAPTER, '--config', CONFIG], {})

const approx = (bytes) => Math.round(bytes / 4)
const row = (label, r) => `${label}: ${r.count} 个工具, ${r.bytes} 字节 ≈ ${approx(r.bytes)} tokens`
const saving = (r) => `${approx(direct.bytes - r.bytes)} tokens/请求 (${(direct.bytes / Math.max(r.bytes, 1)).toFixed(1)}x)`

console.log(row('臂A 直连 cbm          ', direct))
console.log(row('臂B 代理·冷缓存      ', cold) + `   省 ${saving(cold)}`)
console.log(row('臂C 代理·缓存含resources', warm) + `   省 ${saving(warm)}`)

for (const [label, r] of [['冷缓存', cold], ['热缓存', warm]]) {
  if (!(r.bytes < direct.bytes)) throw new Error(`消融臂不成立（${label}）：代理并没有比直连更小，主结论的前提塌了`)
}
if (direct.count < 5) throw new Error(`直连 cbm 的工具数不符合预期：${direct.count}`)
if (cold.count > 3 || warm.count > 3) throw new Error(`代理工具数不符合预期：冷 ${cold.count} / 热 ${warm.count}`)
console.log('\nTOKENS OK')