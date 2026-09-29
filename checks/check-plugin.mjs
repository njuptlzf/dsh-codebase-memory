/**
 * 插件验收：不重启 DSH profile 也能跑插件真实逻辑。
 *
 *   node check-plugin.mjs            # 每个装了插件的 profile 都验一遍
 *   node check-plugin.mjs <profile>  # 只验指定 profile
 *
 * 从 profile 的 node_modules 里导入**已安装**的那份 index.js（仓库路径裸导入
 * `@deepseek-ai/*` 会失败，只有 profile 里的位置能解析——Junction 装法也会因
 * realpath 解析而失败，所以必须 file: copy 装法），再用一个假 ctx 把
 * apply/execute 真的跑起来。
 *
 * 四臂（每个 profile 跑一遍）：
 *   A 链路就绪        code_setup 报 OK
 *   B 工作区绑定      code_index 不接受路径参数，repo_path 来自会话 cwd
 *   C 两工作区区分    两个不同工作区 → 两个不同 project（R1 的判据）
 *   D 前提自证伪      cbm 找不到时必须 throw 并给出安装命令，不静默降级
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE, '.dsh')
const PROFILES_DIR = join(DSH_HOME, 'profiles')
// 仓库根从本文件位置推导，不写死机器路径——公开仓库里不该出现个人绝对路径。
const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')
const ADAPTER_DIR = join(DSH_HOME, 'vendor', 'mcp-adapter')
const CBM_EXE = join(DSH_HOME, 'vendor', 'codebase-memory-mcp', 'bin', 'codebase-memory-mcp.exe')

const installedIn = (profile) => join(PROFILES_DIR, profile, 'node_modules', 'dsh-codebase-memory')
const profileArg = process.argv[2]

const profiles = existsSync(PROFILES_DIR)
  ? readdirSync(PROFILES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(installedIn(name), 'index.js')))
  : []

const targets = profileArg ? [profileArg] : profiles
if (targets.length === 0) {
  throw new Error(`没有任何 profile 装了插件。先跑：dsh plugin --profile <name> add file:${REPO}`)
}

const results = []
const record = (label, ok, detail = '') => {
  results.push(ok)
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`)
}

/** 把 ctx.subprocess 接到真的 node:child_process 上，其余服务用最小替身。 */
function makeCtx(tools, sections, events = {}) {
  return {
    effect: (fn) => fn(),
    // 记录监听器而不是吞掉：H2 的会话启动刷新挂在 'agent/session-start' 上，验收要能调到它。
    on: (name, fn) => { (events[name] ??= []).push(fn) },
    tools: { register: (tool) => tools.set(tool.name, tool) },
    systemPrompt: { section: (section) => { sections.push(section); return section } },
    subprocess: {
      async resolveExecutable(executable) {
        throw new Error(`${executable} not on PATH (fake)`)
      },
      spawn(request) {
        // 镜像真实 subprocess-local 的前置校验（validateSubprocessSpec + targetEnvironment）。
        // 少了这段，假 ctx 会放行真实服务拒绝的 spec —— 尤其 cwd: undefined：
        // 真实实现会做 spec.cwd.includes('\0')，undefined 直接 TypeError 抛错，
        // 这个 bug 就是这样从四臂验收底下溜过去的。
        if (!Number.isFinite(request.graceMs) || request.graceMs <= 0) {
          throw new Error('subprocess graceMs must be a positive finite number')
        }
        const [file, ...args] = request.argv
        if (file === undefined || file.length === 0) {
          throw new Error('invalid argv: expected a non-empty program name at argv[0]')
        }
        request.argv.forEach((value) => value.includes('\0'))
        request.cwd.includes('\0')
        for (const value of Object.values(request.env ?? {})) value.includes('\0')
        const child = spawn(file, args, {
          cwd: request.cwd,
          env: { ...process.env, ...(request.env ?? {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => { stdout += chunk })
        child.stderr.on('data', (chunk) => { stderr += chunk })
        const done = new Promise((resolve) => child.on('close', (exitCode) => resolve({ exitCode, signal: null })))
        return {
          done,
          collected: {
            // 同样照抄真实形状：readFrom 返回 { text, nextOffset, lossy } 而不是字符串。
            // 返回裸字符串时，插件里 String(readFrom(0)) 的写法会假通过，真机上却是
            // "[object Object]" —— 这颗牙不补，验收就永远抓不住这类错误。
            stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
            stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
          },
        }
      },
    },
  }
}

const withSignal = (cwd) => ({ agent: { session: { header: { cwd } } }, signal: AbortSignal.timeout(300000) })
const listProjects = () => new Promise((resolve) => {
  const child = spawn(CBM_EXE, ['cli', 'list_projects', '--format', 'json'], {
    env: { ...process.env, CBM_LOG_LEVEL: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.on('close', () => resolve(JSON.parse(out)))
})

async function verify(profile) {
  const installed = join(installedIn(profile), 'index.js')
  console.log(`\n[${profile}] ${installed}`)

  const mod = await import(pathToFileURL(installed).href)
  const { apply, name, inject, engineVerdict } = mod
  if (name !== 'dsh-codebase-memory') throw new Error(`unexpected plugin name: ${name}`)
  record('装载', true, `name=${name}  inject=${inject.join(',')}`)

  const mount = async (config) => {
    const tools = new Map()
    const sections = []
    const events = {}
    await apply(makeCtx(tools, sections, events), config)
    if (!tools.has('code_index') || !tools.has('code_setup')) {
      throw new Error(`期望注册 code_index + code_setup，实际 ${[...tools.keys()].join(',')}`)
    }
    return { tools, sections, events }
  }

  // ── 臂 A：链路就绪 ──────────────────────────────────────────────────────────
  const a = await mount({})
  const setup = await a.tools.get('code_setup').execute({}, withSignal(REPO))
  record('A 链路就绪', /status: OK/.test(setup), setup.split('\n')[0])
  record('A auto_index 默认开且已落进引擎配置', /^auto_index: true/m.test(setup), /auto_index:.*$/m.exec(setup)?.[0] ?? '(报表里没有 auto_index 行)')
  record('A code_setup 报出引擎实测范围', /^引擎实测: 实测通过 \d/m.test(setup), /^引擎实测:.*$/m.exec(setup)?.[0]?.slice(0, 150) ?? '(没有 引擎实测 行)')
  // 版本判定直接调用导出函数证伪，不必伪造一个"未实测的引擎"
  record('A 版本判定可证伪（同 minor=ok / 跨 minor=untested / 空=未声明）',
    typeof engineVerdict === 'function'
      && engineVerdict('0.11.0', '0.11') === 'ok' && engineVerdict('0.12.0', '0.11') === 'untested' && engineVerdict('', '0.11') === '',
    typeof engineVerdict !== 'function' ? '插件未导出 engineVerdict' : `0.11.0→${engineVerdict('0.11.0', '0.11')}  0.12.0→${engineVerdict('0.12.0', '0.11')}  空→'${engineVerdict('', '0.11')}'`)
  record('A prompt 段就位', a.sections.some((s) => s.name === 'codebase-memory' && s.order === 850))
  record('A prompt 段已就绪文案', /code_index/.test(a.sections.at(-1).text()))

  // ── prompt 契约（动线齐 / args 形状对 / 不埋过期常量）──────────────────────────
  const prompt = a.sections.at(-1).text()
  const needCallables = ['cbm_search_graph', 'cbm_get_code_snippet', 'cbm_check_index_coverage']
  const missing = needCallables.filter((needle) => !prompt.includes(needle))
  record('A prompt 动线含可调用工具名', missing.length === 0, missing.length ? `缺 ${missing.join(', ')}` : '')
  record('A prompt 取原文示例带 format:json', /"format":"json"/.test(prompt))
  // args 必须是对象形状：出现 \" 说明示例写成了转义 JSON 字符串，与 README 的教法语义冲突
  record('A prompt args 用对象形状', !/\\"/.test(prompt), /\\"/.test(prompt) ? '渲染文本里有 \\"，即示例把 args 写成了字符串' : '')
  record('A prompt 不含易过期常量', !/0\.1\d\.\d|\+\d\s*空格|逃不掉/.test(prompt))
  // 预算：这段文本会注入本工作区**每一次模型调用**，所以长度是成本契约（非风格偏好）。
  // 基线（接入说明最初版）约 843 字符；放宽到 1150 给两处静默/响亮坑的说明留空间。
  record('A prompt 段不过预算', prompt.length <= 1150, `${prompt.length} 字符（上限 1150）`)

  // ── 臂 E：A 的 lifecycle + H2 的会话启动补偿刷新 ──────────────────────────────
  const manifest = JSON.parse(readFileSync(join(ADAPTER_DIR, 'cbm.json'), 'utf8'))
  record('E 清单用 keep-alive（启动即连接，消除会话启动竞态）',
    manifest.mcpServers?.cbm?.lifecycle === 'keep-alive', String(manifest.mcpServers?.cbm?.lifecycle))

  const startHandlers = a.events['agent/session-start'] ?? []
  record('E 注册了 agent/session-start 监听', startHandlers.length === 1, `handlers=${startHandlers.length}`)
  const off = await mount({ sessionRefresh: false })
  record('E sessionRefresh=false 时确实不注册监听', (off.events['agent/session-start'] ?? []).length === 0)

  // 非 git 工作区必须被闸门挡下：既证明监听器跑通了，也证明它没为无意义的仓库付索引开销。
  const nonGit = join(tmpdir(), `cbm-check-nongit-${process.pid}`)
  mkdirSync(nonGit, { recursive: true })
  let syncThrow = null
  try {
    startHandlers[0]?.({ agent: { session: { header: { cwd: nonGit } } }, source: 'startup' })
  } catch (error) {
    syncThrow = String(error?.message ?? error)
  }
  record('E 监听器同步返回且不抛（不会 veto 会话启动）', syncThrow === null, syncThrow ?? '')
  await new Promise((resolve) => setTimeout(resolve, 6000))
  const refreshLogPath = join(ADAPTER_DIR, 'refresh.log')
  const logText = existsSync(refreshLogPath) ? readFileSync(refreshLogPath, 'utf8') : ''
  const mine = logText.split('\n').filter((line) => line.includes(String(process.pid)))
  record('E 非 git 工作区被闸门跳过', mine.some((line) => /非 git 工作区/.test(line)), (mine.at(-1) ?? '(日志里没有本次记录)').slice(0, 130))
  rmSync(nonGit, { recursive: true, force: true })

  // ── 臂 F（可选，CBM_CHECK_REFRESH=1）：H2 的**正向**路径真的会刷新 ────────────
  // 默认不跑：它要建 git 仓库、真跑一次 index_repository（约 20–40s）。但它是这条链上
  // 唯一能证明"闸门放行后会真的刷新且第二次不再重复"的检查，所以留在仓库里可随时跑。
  if (process.env.CBM_CHECK_REFRESH === '1') {
    const repo = join(tmpdir(), `cbm-check-refresh-${process.pid}-${profile}`)
    rmSync(repo, { recursive: true, force: true })
    mkdirSync(repo, { recursive: true })
    const runSync = (argv, opts = {}) => execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', maxBuffer: 1 << 26, ...opts })
    const gitc = (args) => runSync(['git', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] })
    try {
      writeFileSync(join(repo, 'r.ts'), 'export function before(n: number): number {\n  return n;\n}\n', 'utf8')
      gitc(['init', '-q']); gitc(['add', '-A']); gitc(['-c', 'user.email=c@x', '-c', 'user.name=c', 'commit', '-qm', 'init'])
      const project = repo.replace(/[:\\/]+/g, '-')
      runSync([CBM_EXE, 'cli', '--quiet', 'index_repository', '--repo-path', repo])
      const projBefore = /indexed_at: (\S+)/.exec(runSync([CBM_EXE, 'cli', '--quiet', 'index_status', '--project', project]))?.[1]
      // 未提交改动 ⇒ git 摘要变化 ⇒ 闸门应放行
      writeFileSync(join(repo, 'r.ts'), 'export function before(n: number): number {\n  return n;\n}\nexport function h2probe(z: number): number {\n  return z + 1;\n}\n', 'utf8')
      // 清掉这个路径的历史 stamp：冷却闸门会读它，测试必须可控，否则重跑会命中 5 分钟冷却
      const stampPath = join(ADAPTER_DIR, 'refresh-stamps.json')
      try {
        const st = JSON.parse(readFileSync(stampPath, 'utf8'))
        delete st[repo]
        writeFileSync(stampPath, JSON.stringify(st, null, 2), 'utf8')
      } catch { /* 没有 stamp 文件就正好 */ }
      const countRuns = () => (readFileSync(refreshLogPath, 'utf8')
        .match(new RegExp(`^\\S+ refresh ${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gm')) ?? []).length

      // ① 第一次触发：闸门应放行并**真的**刷新
      const runsBefore = countRuns()
      startHandlers[0]?.({ agent: { session: { header: { cwd: repo } } }, source: 'startup' })
      let done = false
      for (let i = 0; i < 30 && !done; i++) {
        await new Promise((r) => setTimeout(r, 4000))
        done = new RegExp(`done .*${process.pid}[^\\n]*-${profile}[^\\n]*exit=0`).test(readFileSync(refreshLogPath, 'utf8'))
      }
      const projAfter = /indexed_at: (\S+)/.exec(runSync([CBM_EXE, 'cli', '--quiet', 'index_status', '--project', project]))?.[1]
      const searchable = !/results: 0/.test(runSync([CBM_EXE, 'cli', '--quiet', 'search_graph', '--project', project, '--query', 'h2probe']))
      record('F 闸门放行后真的刷新了索引', done && countRuns() === runsBefore + 1 && projAfter !== projBefore, `indexed_at ${projBefore} → ${projAfter}`)
      record('F 刷新后新符号可检索', searchable)

      // ② 立刻再触发：git 摘要没变 ⇒ 只能走廉价路径，不能真跑第二次。
      // 只数"真跑"的行（refresh <repo>）：诊断性的 skip 行本身会新增，不该算进去。
      const runsBeforeSecond = countRuns()
      startHandlers[0]?.({ agent: { session: { header: { cwd: repo } } }, source: 'startup' })
      await new Promise((r) => setTimeout(r, 5000))
      record('F 二次触发不再真跑刷新（未变化闸门）', countRuns() === runsBeforeSecond, `实际刷新次数 ${runsBeforeSecond} → ${countRuns()}`)
    } finally {
      try { runSync([CBM_EXE, 'cli', '--quiet', 'delete_project', '--project', repo.replace(/[:\\/]+/g, '-')]) } catch { /* 忽略 */ }
      rmSync(repo, { recursive: true, force: true })
    }
  }

  // ── 臂 B：工作区绑定 ────────────────────────────────────────────────────────
  const indexTool = a.tools.get('code_index')
  const paramKeys = Object.keys(indexTool.parameters ?? {})
  record('B code_index 不接受路径参数', !paramKeys.some((key) => /path|repo/i.test(key)), `参数=${paramKeys.join(',') || '(无)'}`)
  const indexed = await indexTool.execute({}, withSignal(REPO))
  record('B repo_path 来自会话 cwd', indexed.root === REPO, `project=${indexed.project} nodes=${indexed.nodes} edges=${indexed.edges}`)

  // ── 臂 C：两个不同工作区 → 两个不同 project ───────────────────────────────
  const names = ((await listProjects()).projects ?? []).map((p) => p.name)
  record('C 本工作区出现在项目表', names.includes(indexed.project), names.join(' | '))
  record('C 另一个工作区是另一个 project', names.length >= 2 && names.some((n) => n !== indexed.project), `共 ${names.length} 个`)

  // ── 臂 D：前提不成立即 throw（不静默降级）──────────────────────────────────
  const savedHome = process.env.DSH_HOME
  const savedLocal = process.env.LOCALAPPDATA
  process.env.DSH_HOME = join(process.env.TEMP ?? '.', 'dsh-no-such-home')
  delete process.env.LOCALAPPDATA
  let thrown = '(未抛错)'
  try {
    const d = await mount({ adapterDir: ADAPTER_DIR, cbmPath: 'C:\\no-such-dir\\no-such-cbm.exe', bootstrap: 'manual' })
    await d.tools.get('code_index').execute({}, withSignal(REPO))
  } catch (error) {
    thrown = String(error?.message ?? error)
  } finally {
    if (savedHome !== undefined) process.env.DSH_HOME = savedHome
    if (savedLocal !== undefined) process.env.LOCALAPPDATA = savedLocal
  }
  record('D 找不到 cbm 时 throw', thrown !== '(未抛错)', thrown.split('\n')[0])
  record('D 错误里带可复制安装命令', /install\.ps1/.test(thrown) && /--skip-config/.test(thrown))
}

for (const profile of targets) await verify(profile)

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} 臂通过（${targets.length} 个 profile：${targets.join(', ')}）`)
if (failed) process.exit(1)
console.log('PLUGIN OK')