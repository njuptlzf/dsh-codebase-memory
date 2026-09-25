/**
 * 链路自检：DSH 使用的三级链路是否真的通。
 *
 *   node check-chain.mjs <adapter-config.json> [project]
 *
 * 复制 DSH host 侧的行为——用 stdio 拉起 mcp-adapter 的 universal 入口
 * (`mcp-server.mjs --config <cfg>`)，做 MCP 握手，然后：
 *   阶段1 代理工具存在（token 压缩层就位）
 *   阶段2 mcp({server:"cbm"}) 能列出 cbm 的工具（懒连接被真正唤醒）
 *   阶段3 给出 project 时，用 mcp({tool:"search_graph"}) 取回真实行
 *
 * 任何阶段不成立就 throw（前提不成立即失败，不静默降级）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE, '.dsh')
const [argAdapter, argConfig, project] = process.argv.slice(2)
const adapterPath = argAdapter || join(dshHome, 'vendor', 'mcp-adapter', 'node_modules', '@njuptlzf', 'mcp-adapter', 'mcp-server.mjs')
const configPath = argConfig || join(dshHome, 'vendor', 'mcp-adapter', 'cbm.json')
if (!adapterPath || !configPath) {
  console.error('usage: node check-chain.mjs <mcp-server.mjs> <config.json> [project]')
  process.exit(2)
}
for (const [what, p] of [['adapter', adapterPath], ['config', configPath]]) {
  if (!existsSync(p)) throw new Error(`${what} not found: ${p}`)
}

const child = spawn(process.execPath, [adapterPath, '--config', configPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
})

let stderr = ''
child.stderr.on('data', (b) => { stderr += b })

const pending = new Map()
let buf = ''
child.stdout.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    const resolve = pending.get(msg.id)
    if (resolve) { pending.delete(msg.id); resolve(msg) }
  }
})

const send = (payload) => child.stdin.write(JSON.stringify(payload) + '\n')
let id = 0
const call = (method, params, timeoutMs = 240000) => {
  const myId = ++id
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(myId)
      reject(new Error(`${method} timed out after ${timeoutMs}ms\n--- adapter stderr ---\n${stderr}`))
    }, timeoutMs)
    pending.set(myId, (msg) => {
      clearTimeout(timer)
      if (msg.error) reject(new Error(`${method} failed: ${JSON.stringify(msg.error)}`))
      else resolve(msg.result)
    })
    send({ jsonrpc: '2.0', id: myId, method, params })
  })
}

/** MCP tools/call 结果是 content 数组；取文本并解析出内层 JSON。 */
const textOf = (result) => (result?.content ?? [])
  .filter((b) => b.type === 'text')
  .map((b) => b.text)
  .join('\n')

const fail = (stage, why) => {
  console.error(`FAIL ${stage}: ${why}`)
  if (stderr.trim()) console.error(`--- adapter stderr ---\n${stderr.trim()}`)
  child.kill()
  process.exit(1)
}

try {
  await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dsh-codebase-memory-check', version: '0.1.0' },
  }, 60000)
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  // 阶段 1：代理工具就位
  const { tools } = await call('tools/list', {}, 60000)
  const names = (tools ?? []).map((t) => t.name)
  const proxy = names.find((n) => n === 'mcp') ?? names.find((n) => n.endsWith('_mcp')) ?? names.find((n) => n.endsWith('mcp'))
  if (!proxy) fail('阶段1 代理工具', `no proxy tool in tools/list: ${JSON.stringify(names)}`)
  console.log(`PASS 阶段1 代理工具就位: ${proxy}（adapter 自身工具数 ${names.length}）`)

  // 阶段 2：懒连接被唤醒，能列出 cbm 的工具
  // 懒服务器未连接时不出现在 server 列表里，所以先显式 connect（这正是唤醒点）。
  await call('tools/call', { name: proxy, arguments: { connect: 'cbm' } }, 300000)
  const listed = textOf(await call('tools/call', { name: proxy, arguments: { server: 'cbm' } }))
  const toolLines = listed.split('\n').map((s) => s.trim()).filter(Boolean)
  if (toolLines.length < 5) fail('阶段2 列出 cbm 工具', `only ${toolLines.length} line(s):\n${listed.slice(0, 800)}`)
  console.log(`PASS 阶段2 列出 cbm 工具: ${toolLines.length} 行`)
  console.log(toolLines.map((l) => '      ' + l).join('\n'))

  // 阶段 3：真调用一次，取回真实检索行
  if (project) {
    const out = textOf(await call('tools/call', {
      name: proxy,
      arguments: {
        tool: 'cbm_search_graph',
        args: JSON.stringify({ project, query: 'function', limit: 3 }),
      },
    }, 300000))
    if (!/qn|Function|search_mode|rows/i.test(out)) fail('阶段3 search_graph', `unexpected payload:\n${out.slice(0, 800)}`)
    console.log('PASS 阶段3 search_graph 返回真实结果')
    console.log('      ' + out.replace(/\s+/g, ' ').slice(0, 300))

    // 阶段 4：把要写进 prompt 段的工具参数名核实下来（不靠猜）
    for (const t of ['cbm_search_graph', 'cbm_get_code_snippet', 'cbm_trace_path']) {
      const desc = textOf(await call('tools/call', { name: proxy, arguments: { describe: t } }, 120000))
      console.log(`--- describe ${t} ---`)
      console.log(desc.replace(/\n{2,}/g, '\n').slice(0, 900))
    }
  } else {
    console.log('SKIP 阶段3（未给 project）')
  }
  console.log('\nCHAIN OK')
  child.kill()
  process.exit(0)
} catch (error) {
  fail('异常', error.message)
}