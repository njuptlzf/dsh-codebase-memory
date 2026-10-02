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
 *   E lifecycle + 会话启动补偿刷新的闸门
 *   G 触发层（docs/design-v2.md 杠杆 ①②③⑤）：分类器正反例、封装工具、
 *     deny-once 只拦一次、前提不满足/超预算一律 fail-open、advise 追加上下文、
 *     写后记账与坐标过期改放行、按 query 条件注入。走假代理工具，不依赖真引擎。
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

/**
 * 假代理工具：把 `mcp__cbm__mcp` 的形状照抄下来（content[0].text = cbm 的返回），
 * 但不起真引擎——这样封装工具 / 拦截 / advise 的**决策逻辑**可证伪，而不用等
 * 一次真索引。真实链路（延迟、json 形状、坐标过期行为）由 check-chain.mjs 量。
 * 每个响应都进 `calls`，断言"钩子里到底查没查 cbm"就不靠猜。
 */
function makeStubProxy(calls, opts = {}) {
  const project = opts.project ?? 'stub-project'
  const root = opts.root ?? REPO
  const stale = () => (opts.freshness ?? 'fresh') === 'stale'
  return {
    name: 'mcp__cbm__mcp',
    async execute(args) {
      const tool = String(args?.tool ?? '')
      const q = args?.args ?? {}
      calls.push({ tool, args: q })
      if (opts.slow && tool === 'cbm_search_graph') {
        await new Promise((r) => setTimeout(r, opts.slowMs ?? 400))
      }
      switch (tool) {
        case 'cbm_list_projects':
          return { content: [{ type: 'text', text: `projects: 1  (cols: name root_path branch)\n  ${project} ${root.replace(/\\/g, '/')} main` }] }
        case 'cbm_search_graph':
          return { content: [{ type: 'text', text: JSON.stringify({ cols: ['qn', 'label', 'file', 'lines', 'rank'], rows: [[`${project}.stubSymbol`, 'Function', 'index.js', '42-44', -1.2]], total: 1, returned: 1, has_more: false }) }] }
        case 'cbm_get_code_snippet':
          return { content: [{ type: 'text', text: JSON.stringify({ name: 'stubSymbol', qualified_name: `${project}.stubSymbol`, file_path: 'x/index.js', start_line: 42, end_line: 44, source: 'function stubSymbol() {\n  return 1;\n}\n' }) }] }
        case 'cbm_check_index_coverage':
          return { content: [{ type: 'text', text: stale()
            ? `project: ${project}\npaths: 1  (cols: requested_path path status freshness recommended_action coverage)\n  ${q.paths?.[0] ?? 'index.js'} index.js no_recorded_issue metadata_changed read_source_and_reindex []`
            : `project: ${project}\npaths: 1  (cols: requested_path path status freshness recommended_action coverage)\n  ${q.paths?.[0] ?? 'index.js'} index.js no_recorded_issue fresh none []` }] }
        case 'cbm_trace_path':
          return { content: [{ type: 'text', text: `function: ${q.function_name}\ndirection: ${q.direction ?? 'inbound'}\ncallers: 1  (cols: qn hop)\n  ${project}.callerOfStub 1` }] }
        default:
          return { content: [{ type: 'text', text: '{}' }] }
      }
    },
  }
}

/** 把 ctx.subprocess 接到真的 node:child_process 上，其余服务用最小替身。 */
function makeCtx(tools, sections, events = {}, contexts = [], proxy = null, opts = {}) {
  if (proxy) tools.set('mcp__cbm__mcp', proxy)
  // opts.abortOnce：复刻真实引擎在并发索引下的行为——第一次 index_repository
  // 退出码 1 + `status:"aborted_previous_preserved"`，第二次才成功。没有这颗牙，
  // "被并发中止后重试一次"这条修复就永远只在生产环境里被观察到。
  let abortedOnce = false
  return {
    effect: (fn) => fn(),
    // 记录监听器而不是吞掉：H2 的会话启动刷新挂在 'agent/session-start' 上，验收要能调到它。
    on: (name, fn) => { (events[name] ??= []).push(fn) },
    tools: {
      register: (tool) => tools.set(tool.name, tool),
      // 宿主实装的公开方法（工具目录里有 execute）：封装工具与钩子都靠它复用长连接。
      // 这里照抄"按名字找定义再执行"的最小语义，返回 {content, isError}。
      async execute(exec) {
        const tool = tools.get(exec.name)
        if (!tool) return { content: [{ type: 'text', text: `unknown tool: ${exec.name}` }], isError: true }
        const out = await tool.execute(exec.arguments, { ...exec, callId: exec.callId ?? 'fake-call' })
        return typeof out === 'string' ? { content: [{ type: 'text', text: out }], isError: false } : out
      },
    },
    systemPrompt: {
      section: (section) => { sections.push(section); return section },
      context: (context) => { contexts.push(context); return context },
    },
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
        if (opts.abortOnce && !abortedOnce && request.argv.some((a) => String(a).includes('index_repository'))) {
          abortedOnce = true
          const payload = `{"project":"x","status":"aborted_previous_preserved","hint":"Indexing aborted before publication; the previous index is intact and still serving. Retry; if it repeats, check the run log."}`
          return {
            done: Promise.resolve({ exitCode: 1, signal: null }),
            collected: {
              stdout: { readFrom: () => ({ text: payload, nextOffset: payload.length, lossy: false }) },
              stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
            },
          }
        }
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
  const { apply, name, inject, engineVerdict, fileDrift, classifyPattern, truncateCodepoints, isGrepLike, normPath, projectFromListing } = mod
  if (name !== 'dsh-codebase-memory') throw new Error(`unexpected plugin name: ${name}`)
  record('装载', true, `name=${name}  inject=${inject.join(',')}`)

  const mount = async (config, proxy = null, ctxOpts = null) => {
    const tools = new Map()
    const sections = []
    const contexts = []
    const events = {}
    await apply(makeCtx(tools, sections, events, contexts, proxy, ctxOpts ?? {}), config)
    if (!tools.has('code_index') || !tools.has('code_setup')) {
      throw new Error(`期望注册 code_index + code_setup，实际 ${[...tools.keys()].join(',')}`)
    }
    return { tools, sections, contexts, events }
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

  record('A code_setup 报出「同步状态」', /^同步状态: /m.test(setup), /^同步状态:.*$/m.exec(setup)?.[0]?.slice(0, 170) ?? '(没有 同步状态 行)')
  // 漂移判定对两个临时目录证伪：一致→[]；改一个文件→只命中它；读不到→null（不许误报成"不一致"）
  const driftA = join(tmpdir(), `cbm-drift-a-${process.pid}`)
  const driftB = join(tmpdir(), `cbm-drift-b-${process.pid}`)
  mkdirSync(driftA, { recursive: true }); mkdirSync(driftB, { recursive: true })
  for (const f of ['index.js', 'cordis.patch.yml', 'package.json']) {
    writeFileSync(join(driftA, f), 'same', 'utf8'); writeFileSync(join(driftB, f), 'same', 'utf8')
  }
  const cleanDrift = typeof fileDrift === 'function' ? fileDrift(driftA, driftB) : undefined
  writeFileSync(join(driftB, 'index.js'), 'changed', 'utf8')
  const oneDrift = typeof fileDrift === 'function' ? fileDrift(driftA, driftB) : undefined
  const missingDrift = typeof fileDrift === 'function' ? fileDrift(driftA, join(driftB, 'nope')) : undefined
  record('A 漂移判定可证伪（一致→[]；改一个→只命中它；读不到→null）',
    typeof fileDrift === 'function' && Array.isArray(cleanDrift) && cleanDrift.length === 0
      && Array.isArray(oneDrift) && oneDrift.length === 1 && oneDrift[0] === 'index.js' && missingDrift === null,
    typeof fileDrift !== 'function' ? '插件未导出 fileDrift' : `一致→${JSON.stringify(cleanDrift)} 改index.js→${JSON.stringify(oneDrift)} 读不到→${missingDrift}`)
  rmSync(driftA, { recursive: true, force: true }); rmSync(driftB, { recursive: true, force: true })
  record('A prompt 段就位', a.sections.some((s) => s.name === 'codebase-memory' && s.order === 850))
  record('A prompt 段已就绪文案', /code_index/.test(a.sections.at(-1).text()))

  // ── prompt 契约（动线齐 / args 形状对 / 不埋过期常量）──────────────────────────
  const prompt = a.sections.at(-1).text()
  // 高频动线已由封装工具接管（杠杆 ①），常驻段只需要留下"长尾怎么走"的证据：
  // 取原文与验鲜这两个仍然要手填 project 的动作，加上两个封装动词本身。
  const needCallables = ['code_find', 'code_callers', 'cbm_get_code_snippet', 'cbm_check_index_coverage']
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

  // ── 臂 G：触发层（杠杆 ①②③⑤ 的决策逻辑，走假代理工具，不依赖真引擎）────────
  const next = async () => ({ kind: 'allow' })
  const nextPost = async () => ({ kind: 'accept' }) // 宿主 post-execute 的默认决策
  const fakeAgent = (id, cwd, events) => ({
    session: {
      header: { id, cwd },
      ...(events ? { snapshotEvents: () => events } : {}),
    },
  })
  const sig = () => AbortSignal.timeout(60000)
  const grepExec = (agent, pattern, extra = {}) => ({ name: 'grep', arguments: { pattern, ...extra }, agent, signal: sig() })

  // G1 分类器：符号类与字面量类的正反例。判据是**误拦为 0**，不是召回率。
  const symbolCases = [
    'usageSection', 'classifyPattern', 'refreshSessionWorkspace', 'ensureAdapter',
    'usage_section', 'npmCliEntry', 'DshProfileBundles',
    'function ensureAdapter', 'class FooBar', 'def hello_world', 'const someValue', 'svc.doThing',
  ]
  const literalCases = [
    'TODO: fix later', 'hello world', '"quoted"', 'https://example.com/a', 'SELECT * FROM t',
    '.*\\d{3}', 'maxBytes: 1024', 'ERROR', 'MAX_RETRIES', 'id', 'name', 'mode', 'api', 'foo',
    '{"tool":"cbm_search_graph"', 'error: cannot find module', 'dsh.profile.bundles',
    'config.some.value', 'a.b.c', 'src/index', 'package.name',
  ]
  const badSymbols = symbolCases.filter((p) => classifyPattern(p)?.kind !== 'symbol')
  const falsePositives = literalCases.filter((p) => classifyPattern(p)?.kind === 'symbol')
  record('G 分类器：符号类正例全部识别', badSymbols.length === 0, badSymbols.join(', ') || `${symbolCases.length}/${symbolCases.length}`)
  record('G 分类器：字面量类误拦为 0', falsePositives.length === 0, falsePositives.join(', ') || `${literalCases.length}/${literalCases.length}`)
  record('G 分类器：限定到非代码路径时一律放行', classifyPattern('usageSection', 'package.json').kind === 'literal' && classifyPattern('usageSection', 'notes.md').kind === 'literal')
  record('G 内置工具名判定（裸名小写，MCP 带前缀不算）', isGrepLike('grep', ['grep', 'glob']) && isGrepLike('GLOB', ['grep', 'glob']) && !isGrepLike('mcp__cbm__mcp', ['grep', 'glob']))
  // 码点截断：dsh-mneme #334 的教训——按 UTF-16 单元切会切出孤立代理对，宿主每个请求 400。
  const cut = truncateCodepoints('ab😀cd', 3)
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut)
  record('G 截断按码点、不切坏代理对', !loneSurrogate && Array.from(cut).length === 4, `${JSON.stringify(cut)} 孤立代理对=${loneSurrogate}`)
  record('G 路径归一（反斜杠 / 工作区前缀 / Windows 盘符大小写）',
    normPath('C:\\repo\\src\\a.ts', 'c:/repo') === 'src/a.ts' && normPath('src/a.ts', 'C:/repo') === 'src/a.ts',
    `${normPath('C:\\repo\\src\\a.ts', 'c:/repo')} | ${normPath('src/a.ts', 'C:/repo')}`)
  record('G project 按 root_path 匹配（不重算引擎命名）',
    projectFromListing('projects: 2  (cols: name root_path branch)\n  P-A C:/x/y main\n  P-B C:/z main', 'C:\\x\\y') === 'P-A'
      && projectFromListing('  P-B C:/z main', 'C:/nope') === '')

  const gCalls = []
  const gProxy = makeStubProxy(gCalls, { project: `stub-${process.pid}`, root: REPO })
  const g = await mount({ telemetry: false }, gProxy)
  await g.tools.get('code_setup').execute({}, withSignal(REPO)) // 真自举一次：state.ok 才为 true
  record('G 默认注册封装工具', g.tools.has('code_find') && g.tools.has('code_callers'), [...g.tools.keys()].join(','))
  const noWrapper = await mount({ wrapperTools: false, telemetry: false }, gProxy)
  record('G wrapperTools=false 时确实不注册', !noWrapper.tools.has('code_find') && !noWrapper.tools.has('code_callers'))
  const findParams = Object.keys(g.tools.get('code_find').parameters?.properties ?? {})
  record('G code_find 不接受 project / 路径参数', !findParams.some((k) => /project|path|repo/i.test(k)), `参数=${findParams.join(',')}`)

  // token 成本是**契约**而不是风格：这两个 schema 会进每一次模型请求。
  // 上限按实测基线放宽一档；超了就是要重新权衡"封装工具换来 4x 压缩还剩多少"。
  const schemaBytes = ['code_find', 'code_callers']
    .reduce((n, tool) => n + Buffer.byteLength(JSON.stringify({
      name: tool,
      description: g.tools.get(tool).description,
      parameters: g.tools.get(tool).parameters,
    }), 'utf8'), 0)
  record('G 封装工具 schema 体积在预算内', schemaBytes <= 2200, `${schemaBytes} 字节 ≈ ${Math.round(schemaBytes / 4)} tokens/请求（预算 2200 字节）`)

  // G2 杠杆 ①：project 由插件填，模型不传也能拿到 qualified_name + 源码。
  const agentG = fakeAgent(`sess-${process.pid}-find`, REPO)
  const found = await g.tools.get('code_find').execute({ query: 'stubSymbol' }, { agent: agentG, signal: sig() })
  record('G code_find 返回 qualified_name 与源码', /stubSymbol/.test(found.text) && /function stubSymbol/.test(found.text) && found.project === `stub-${process.pid}`, found.text.split('\n')[1] ?? '')
  record('G code_find 内部确实走了代理工具（不是 spawn CLI）', gCalls.some((c) => c.tool === 'cbm_search_graph') && gCalls.some((c) => c.tool === 'cbm_get_code_snippet'), gCalls.map((c) => c.tool).join(','))
  const traced = await g.tools.get('code_callers').execute({ name: 'stub-project.stubSymbol' }, { agent: agentG, signal: sig() })
  record('G code_callers 默认 inbound 并返回调用者', /callerOfStub/.test(traced.text) && /direction: inbound/.test(traced.text), traced.text.split('\n')[1] ?? '')

  // G3 杠杆 ②：deny-once —— 同一符号只拦一次，第二次放行。
  const dCalls = []
  const d = await mount({ enforce: 'deny-once' }, makeStubProxy(dCalls, { project: `stub-${process.pid}-deny` }))
  await d.tools.get('code_setup').execute({}, withSignal(REPO))
  const preDeny = (d.events['tools/pre-execute'] ?? [])[0]
  record('G deny-once 注册了 tools/pre-execute 监听', typeof preDeny === 'function', `handlers=${(d.events['tools/pre-execute'] ?? []).length}`)
  const agentD = fakeAgent(`sess-${process.pid}-deny`, REPO)
  const first = await preDeny(grepExec(agentD, 'usageSection'), next)
  const second = await preDeny(grepExec(agentD, 'usageSection'), next)
  const literalPass = await preDeny(grepExec(agentD, 'TODO: fix later'), next)
  record('G deny-once 首次拦截符号类 grep 且 reason 里带命中结果',
    first?.kind === 'deny' && /code_find/.test(first.reason) && /stubSymbol/.test(first.reason), JSON.stringify(first).slice(0, 140))
  record('G deny-once 同符号第二次放行（误拦最多贵一个往返）', second?.kind === 'allow', JSON.stringify(second))
  record('G deny-once 字面量类永不拦', literalPass?.kind === 'allow')
  const denyReport = await d.tools.get('code_setup').execute({}, withSignal(REPO))
  record('G 报表里能看到触发层开关与遥测计数', /触发层:.*enforce=deny-once/.test(denyReport) && /intercept-deny=1/.test(denyReport),
    [/触发层:.*$/m, /遥测计数:.*$/m].map((re) => re.exec(denyReport)?.[0] ?? '(缺行)').join(' | ').slice(0, 220))

  // G4 前提不满足即放行：索引未就绪（project 查不到）。
  const uCalls = []
  const u = await mount({ enforce: 'deny', telemetry: false }, makeStubProxy(uCalls, { project: 'other-project', root: 'C:/not-this' }))
  await u.tools.get('code_setup').execute({}, withSignal(REPO))
  const preUn = (u.events['tools/pre-execute'] ?? [])[0]
  const unindexed = await preUn(grepExec(fakeAgent(`sess-${process.pid}-un`, REPO), 'usageSection'), next)
  record('G 工作区没索引时直接放行（fail-open）', unindexed?.kind === 'allow', JSON.stringify(unindexed))

  // G5 时间预算：查询超时 ⇒ 放行，钩子绝不把工具调用卡死。
  const bCalls = []
  const b = await mount({ enforce: 'deny', interceptBudgetMs: 60, telemetry: false }, makeStubProxy(bCalls, { project: `stub-${process.pid}-b`, slow: true, slowMs: 400 }))
  await b.tools.get('code_setup').execute({}, withSignal(REPO))
  const budgetOut = await (b.events['tools/pre-execute'] ?? [])[0](grepExec(fakeAgent(`sess-${process.pid}-b`, REPO), 'usageSection'), next)
  record('G 查询超预算时放行', budgetOut?.kind === 'allow', JSON.stringify(budgetOut))

  // G6 杠杆 ⑤：写入记账 → 脏路径让拦截改走放行 + 后台补刷。
  const tRepo = join(tmpdir(), `cbm-check-dirty-${process.pid}`)
  rmSync(tRepo, { recursive: true, force: true })
  mkdirSync(tRepo, { recursive: true })
  const fCalls = []
  const f = await mount({ enforce: 'deny-once', telemetry: false }, makeStubProxy(fCalls, { project: `stub-${process.pid}-f`, root: tRepo, freshness: 'stale' }))
  await f.tools.get('code_setup').execute({}, withSignal(REPO))
  const postF = (f.events['tools/post-execute'] ?? [])[0]
  const agentF = fakeAgent(`sess-${process.pid}-f`, tRepo)
  await postF({ name: 'edit', arguments: { file_path: join(tRepo, 'probe.ts') }, agent: agentF, signal: sig() }, { content: [], isError: false }, nextPost)
  const dirtyRecorded = fCalls.length // 记账本身不查 cbm：这里应仍为 0 次
  const beforeIntercept = fCalls.filter((c) => c.tool === 'cbm_check_index_coverage').length
  const stalePass = await (f.events['tools/pre-execute'] ?? [])[0](grepExec(agentF, 'probeSymbol'), next)
  const coverageArgs = fCalls.find((c) => c.tool === 'cbm_check_index_coverage')?.args
  record('G 脏路径记账不触发即时索引（惰性）', dirtyRecorded === 0 && beforeIntercept === 0, `记账后 cbm 调用数=${dirtyRecorded}`)
  record('G 坐标过期时拦截改为放行 + 按路径验鲜', stalePass?.kind === 'allow' && Array.isArray(coverageArgs?.paths) && coverageArgs.paths.includes('probe.ts'), JSON.stringify(coverageArgs))
  await postF({ name: 'edit', arguments: { file_path: join(tmpdir(), `cbm-check-dirty-${process.pid}-outside`, 'outside.ts') }, agent: agentF, signal: sig() }, { content: [], isError: false }, nextPost)
  await (f.events['tools/pre-execute'] ?? [])[0](grepExec(agentF, 'probeSymbol2'), next)
  const lastCoverage = fCalls.filter((c) => c.tool === 'cbm_check_index_coverage').at(-1)?.args?.paths ?? []
  record('G 工作区外的写入不进脏集合', lastCoverage.length === 1 && lastCoverage[0] === 'probe.ts', JSON.stringify(lastCoverage))

  // G7 advise：不阻断，只在 post-execute 追加一条上下文（每符号一次）。
  const vCalls = []
  const v = await mount({ telemetry: false }, makeStubProxy(vCalls, { project: `stub-${process.pid}-adv` }))
  await v.tools.get('code_setup').execute({}, withSignal(REPO))
  record('G 默认 enforce=advise 时不注册 pre-execute 拦截', (v.events['tools/pre-execute'] ?? []).length === 0, `handlers=${(v.events['tools/pre-execute'] ?? []).length}`)
  const postV = (v.events['tools/post-execute'] ?? [])[0]
  const agentV = fakeAgent(`sess-${process.pid}-adv`, REPO)
  const adv1 = await postV(grepExec(agentV, 'usageSection'), { content: [{ type: 'text', text: 'grep 结果' }], isError: false }, nextPost)
  const adv2 = await postV(grepExec(agentV, 'usageSection'), { content: [{ type: 'text', text: 'grep 结果' }], isError: false }, nextPost)
  const advLiteral = await postV(grepExec(agentV, 'TODO: fix later'), { content: [], isError: false }, nextPost)
  const msg = adv1?.additionalContexts?.[0]
  record('G advise 追加上下文而不是阻断', adv1?.kind === 'accept' && Array.isArray(adv1?.additionalContexts) && /code_find/.test(msg?.content?.[0]?.text ?? ''), JSON.stringify(adv1).slice(0, 160))
  record('G advise 消息带自有 source.kind（宿主 V4 准入）', msg?.source?.kind === 'plugin' && msg?.source?.plugin === 'dsh-codebase-memory', JSON.stringify(msg?.source))
  record('G advise 同一符号只提一次，字面量不提', !adv2?.additionalContexts?.length && !advLiteral?.additionalContexts?.length, `第二次=${JSON.stringify(adv2).slice(0, 80)}`)
  const advDenied = await postV(grepExec(agentV, 'otherSymbol'), { content: [{ type: 'text', text: 'Error: 被拦下了' }], isError: true }, nextPost)
  record('G 已被拒绝的调用不再追加 advise（不重复教育）', !advDenied?.additionalContexts?.length, JSON.stringify(advDenied).slice(0, 100))

  // G8 杠杆 ③：按 query 条件注入；不像在查代码结构就一个字符都不占。
  const hint = (v.contexts ?? []).find((c) => c.name === 'codebase-memory:hint')
  const codeAsk = [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '谁调用 normalize 这个函数？' }] } }]
  const proseAsk = [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把 README 的措辞改顺一点' }] } }]
  const hintText = typeof hint?.text === 'function' ? hint.text({ agent: fakeAgent(`sess-${process.pid}-hint`, REPO, codeAsk) }) : ''
  const hintEmpty = typeof hint?.text === 'function' ? hint.text({ agent: fakeAgent(`sess-${process.pid}-hint`, REPO, proseAsk) }) : 'x'
  const hintPlanted = typeof hint?.text === 'function' ? hint.text({ agent: fakeAgent(`sess-${process.pid}-hint2`, REPO, codeAsk) }) : 'x'
  record('G 注册了 systemPrompt.context（order 130，不挤进常驻段）', !!hint && hint.order === 130, `order=${hint?.order}`)
  record('G 条件注入：像查代码结构时给 1–2 行状态', typeof hintText === 'string' && hintText.length > 0 && /code_find/.test(hintText) && !/\{\{/.test(hintText), hintText.slice(0, 140))
  record('G 条件注入：project 来自同 cwd 的缓存（跨会话复用，渲染保持同步）',
    typeof hintText === 'string' && hintText.includes(`stub-${process.pid}-adv`), hintText.slice(0, 80))
  record('G 条件注入：不像时返回空串（宿主按空串跳过）', hintEmpty === '', JSON.stringify(hintEmpty))
  record('G 注入文本不含宿主会插值的 {{var}}', !/[{]{2}[a-z][a-z0-9_]*[}]{2}/.test(hintPlanted + hintText), '')
  // G9 索引任务串行化 + 被并发中止后重试（这条臂来自一次真实失败：后台补刷与
  // code_index 撞上引擎 watcher ⇒ 退出码 1 + aborted_previous_preserved）。
  const telemetryPath = join(ADAPTER_DIR, 'telemetry.log')
  const retryCount = () => (existsSync(telemetryPath) ? readFileSync(telemetryPath, 'utf8').split('\n').filter((l) => /index-retry-contention/.test(l)).length : 0)
  const beforeRetries = retryCount()
  const c = await mount({ enforce: 'off', dirtyTracking: false, contextHint: false }, null, { abortOnce: true })
  await c.tools.get('code_setup').execute({}, withSignal(REPO))
  const retried = await c.tools.get('code_index').execute({}, withSignal(REPO))
  record('G 索引第一次被并发中止时自动重试并成功', typeof retried?.project === 'string' && retried.project.length > 0, `project=${retried?.project} status=${retried?.status}`)
  record('G 重试被记进遥测（不静默自愈）', retryCount() > beforeRetries, `index-retry-contention ${beforeRetries} → ${retryCount()}`)
  rmSync(tRepo, { recursive: true, force: true })

  // ── 臂 B：工作区绑定 ────────────────────────────────────────────────────────
  const indexTool = a.tools.get('code_index')
  const paramKeys = Object.keys(indexTool.parameters?.properties ?? {})
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