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
 *     deny-once 只拦一次、前提不满足/超预算一律 fail-open、
 *     写后记账与坐标过期改放行、按 query 条件注入。走假代理工具，不依赖真引擎。
 *   R2/R3/S2 泡数据完整性（v0.8.2，两个遥测里抓到的真 bug 的回归锁）：越界 grep
 *     不替换、底层错误文本不算命中（失败与无命中分开计数）、累计计数跨重启播种+落盘。
 *   W 冷启动契约（v0.10.1）：bootstrap 会话外预热恰好一发；projectFor 查不到时
 *     错误消息区分"不在表里/查询失败"并带出代理原文。
 *   V 适配层版本对账（v0.13.0）：实装 ≠ 钉 ⇒ 自动重装并带 note + adapter-upgrade
 *     计数；= 钉 ⇒ 零安装；manual ⇒ 不碰网络只记差距；清单写 settings.scriptMode。
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

// 生产里 volatile 引用由 loader 造（cosmokit createVolatile）；验收环境没装 cosmokit，
// 用 Symbol.for('cosmokit.volatile.write') 手捏同形状引用——isVolRef 认的是全局
// symbol 注册表（cosmokit 跨副本同一），形状对了语义就对了。
const mkVolRef = (v) => { let cur = v; return { get: () => cur, [Symbol.for('cosmokit.volatile.write')]: (next) => { cur = next } } }

/**
 * 假代理工具：把 `mcp__cbm__mcp` 的形状照抄下来（content[0].text = cbm 的返回），
 * 但不起真引擎——这样封装工具 / 拦截 / 记账的**决策逻辑**可证伪，而不用等
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
          // v0.10.1 臂 W：代理把底层失败包成 Error 文本（isError 不置真）的样子。
          if (opts.listError) return { content: [{ type: 'text', text: 'Error: MCP server not running' }] }
          // v0.12.0 臂 X：0-server 活进程的真实返回形态——以 Tool 开头，不是 Error。
          if (opts.listNotFound) return { content: [{ type: 'text', text: 'Tool "cbm_list_projects" not found. Use mcp({ server: "name" }) to list tools, mcp({ search: "..." }) to search' }] }
          // v0.13.2 臂 W：慢引擎——预热不带秒表后，结论必须在真实 settle 处落账。
          if (opts.warmSlowMs) await new Promise((r) => setTimeout(r, opts.warmSlowMs))
          return { content: [{ type: 'text', text: `projects: 1  (cols: name root_path branch)\n  ${project} ${root.replace(/\\/g, '/')} main` }] }
        case 'cbm_search_graph':
          // 代理工具会把底层 MCP 错误包成**普通文本**（isError 不置真）——实测
          // zg 打不开 collection 时返回 "Error: Failed to open…"。错误文本不是命中。
          if (opts.errorSearch) return { content: [{ type: 'text', text: 'Error: Failed to open zvec collection storage\n\nExpected parameters:\n  root (string) *required*' }] }
          return { content: [{ type: 'text', text: JSON.stringify(opts.emptySearch
            ? { cols: ['qn', 'label', 'file', 'lines', 'rank'], rows: [], total: 0, returned: 0, has_more: false }
            : { cols: ['qn', 'label', 'file', 'lines', 'rank'], rows: [[`${project}.stubSymbol`, 'Function', 'index.js', '42-44', -1.2]], total: 1, returned: 1, has_more: false }) }] }
        case 'zg_zvec_grep_search':
          // 模拟上游守门（v0.13.3 实证的形状）：root 下没有 .zvec-grep 时，activate()
          // 在读任何参数之前就 throw INDEX_MISSING——文本以 Error 开头，cbmCall 的
          // 错误嗅探判失败；有目录才返回命中。这样"缺索引别白打"的守卫臂是真命题。
          if (opts.zgGate && !existsSync(join(String(q.root ?? ''), '.zvec-grep')))
            return { content: [{ type: 'text', text: 'Error: INDEX_MISSING: no persistent index under this root. Creating or rebuilding a persistent index requires explicit user authorization (CLI: index).' }] }
          return { content: [{ type: 'text', text: 'results: 1\n#1 [global_fill] matchedBy=fts+vector stub/index.js:42-44' }] }
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
    // emit 同样记账而不抛 "not a function"：读数通道的节流 emit 要靠它断言。
    emit: (...args) => { (opts.emits ??= []).push(args) },
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
        // v0.12.0 臂 X：进程枚举走罐头数据。绝不真起 powershell/ps——真起既慢，又会
        // 枚举到开发机/CI 上的真 adapter 进程，断言就成了看机器脸色的薛定谔结论。
        // opts.procTable 可为字符串或 () => string（restart 臂要按调用次序换答案）。
        if (file === 'powershell.exe' || file === 'ps') {
          const text = String(typeof opts.procTable === 'function' ? opts.procTable() : (opts.procTable ?? ''))
          return {
            done: Promise.resolve({ exitCode: 0, signal: null }),
            collected: {
              stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
              stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
            },
          }
        }
        // 臂 V（v0.13.0）：适配层安装的罐头版。真 npm install 依赖网络且十秒起步，
        // 钉死对账臂要断言的是"取了哪个版本"这一确定性动作；opts.npmInstall(cwd, version)
        // 由臂写假包并记账，返回形状与真分支完全一致。
        if (opts.npmInstall && String(request.argv[1] ?? '').endsWith('npm-cli.js') && request.argv.includes('install')) {
          const spec = String(request.argv[request.argv.length - 1])
          opts.npmInstall(request.cwd, spec.slice(spec.lastIndexOf('@') + 1))
          return {
            done: Promise.resolve({ exitCode: 0, signal: null }),
            collected: {
              stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
              stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
            },
          }
        }
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
  const { apply, name, inject, engineVerdict, fileDrift, classifyPattern, truncateCodepoints, isGrepLike, normPath, projectFromListing, Config, parseAdapterProcsWin, parseAdapterProcsPosix, DEFAULT_ADAPTER_VERSION } = mod
  if (name !== 'dsh-codebase-memory') throw new Error(`unexpected plugin name: ${name}`)
  record('装载', true, `name=${name}  inject=${inject.join(',')}`)

  // 累计计数文件是**跨挂载存活**的用户数据；harness 若共享一份，前面的臂会把计数
  // 泡进后面臂的播种里，精确数字断言全废。所以每次 mount 默认换一个新文件
  // （DSH_CBM_COUNTS_FILE 是插件侧的测试缝），只有持久化臂显式共用同一份。
  const countsDir = join(tmpdir(), `cbm-counts-${process.pid}-${profile}`)
  mkdirSync(countsDir, { recursive: true })
  let countsSeq = 0
  const mount = async (config, proxy = null, ctxOpts = null, countsFile = null) => {
    process.env.DSH_CBM_COUNTS_FILE = countsFile ?? join(countsDir, `c${(countsSeq += 1)}.json`)
    const tools = new Map()
    const sections = []
    const contexts = []
    const events = {}
    const emits = []
    await apply(makeCtx(tools, sections, events, contexts, proxy, { ...(ctxOpts ?? {}), emits }), config)
    if (!tools.has('code_index') || !tools.has('code_setup')) {
      throw new Error(`期望注册 code_index + code_setup，实际 ${[...tools.keys()].join(',')}`)
    }
    return { tools, sections, contexts, events, emits }
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
  // 清单含嵌套的 lib/client.js——客户端半部漏同步的话设置页会整块消失，必须能被比出来。
  const driftA = join(tmpdir(), `cbm-drift-a-${process.pid}`)
  const driftB = join(tmpdir(), `cbm-drift-b-${process.pid}`)
  mkdirSync(driftA, { recursive: true }); mkdirSync(driftB, { recursive: true })
  mkdirSync(join(driftA, 'lib'), { recursive: true }); mkdirSync(join(driftB, 'lib'), { recursive: true })
  for (const f of ['index.js', 'cordis.patch.yml', 'package.json', 'lib/client.js']) {
    writeFileSync(join(driftA, f), 'same', 'utf8'); writeFileSync(join(driftB, f), 'same', 'utf8')
  }
  const cleanDrift = typeof fileDrift === 'function' ? fileDrift(driftA, driftB) : undefined
  writeFileSync(join(driftB, 'index.js'), 'changed', 'utf8')
  const oneDrift = typeof fileDrift === 'function' ? fileDrift(driftA, driftB) : undefined
  writeFileSync(join(driftB, 'lib/client.js'), 'changed', 'utf8')
  const nestedDrift = typeof fileDrift === 'function' ? fileDrift(driftA, driftB) : undefined
  const missingDrift = typeof fileDrift === 'function' ? fileDrift(driftA, join(driftB, 'nope')) : undefined
  record('A 漂移判定可证伪（一致→[]；改一个→只命中它；读不到→null）',
    typeof fileDrift === 'function' && Array.isArray(cleanDrift) && cleanDrift.length === 0
      && Array.isArray(oneDrift) && oneDrift.length === 1 && oneDrift[0] === 'index.js' && missingDrift === null,
    typeof fileDrift !== 'function' ? '插件未导出 fileDrift' : `一致→${JSON.stringify(cleanDrift)} 改index.js→${JSON.stringify(oneDrift)} 读不到→${missingDrift}`)
  record('A 嵌套的 lib/client.js 也参与比对（漏同步要能报出来）',
    Array.isArray(nestedDrift) && nestedDrift.length === 2 && nestedDrift.includes('lib/client.js'),
    JSON.stringify(nestedDrift))
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
  // v0.13.0：臂 A 的 bootstrap 就在真 vendor 上跑过——真清单必须带上 scriptMode 显式准入
  // （上游 #744：5.x 起 mcpScript 不再默认注册，插件的 usageSection 却把它当事实）。
  record('E 真清单带 settings.scriptMode（缺席 ⇒ 臂 A bootstrap 没按新代码重写清单）',
    manifest.settings?.scriptMode === true, `实际=${JSON.stringify(manifest.settings ?? null)}`)

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

  // ── 臂 Z：语义检索层（zg）——清单接线与降级，全在临时目录，不碰真引擎 ─────────
  // 引擎没有任何向量工具（0.11.0 实测 15 工具面），zg 是补位；这组臂证明
  // "zgEnabled ⇒ cbm.json 出现第二个 server"以及所有降级路径，且默认关时清单干净。
  record('Z 默认（真实清单）没有 zg server', manifest.mcpServers?.zg === undefined,
    `实际: ${JSON.stringify(manifest.mcpServers?.zg ?? null)}`)
  record('Z 默认 prompt 不提 zg（未装不画饼）', !prompt.includes('zvec_grep_search'))
  const zgHome = join(tmpdir(), `cbm-check-zg-${process.pid}`)
  rmSync(zgHome, { recursive: true, force: true })
  const zgAdapter = join(zgHome, 'adapter')
  const zgVendor = join(zgHome, 'vendor')
  mkdirSync(join(zgAdapter, 'node_modules', '@njuptlzf', 'mcp-adapter'), { recursive: true })
  mkdirSync(join(zgVendor, 'node_modules', '@zvec', 'zvec-grep', 'dist', 'cli'), { recursive: true })
  writeFileSync(join(zgAdapter, 'node_modules', '@njuptlzf', 'mcp-adapter', 'mcp-server.mjs'), '', 'utf8')
  // v0.13.0：版本对账看的是包元数据——没有这份 package.json，固件会被当成"实装 ''"
  // 而触发真 npm install（依赖网络，还把它覆盖成实包）。钉版本从插件导出取，升 pin 不改这里。
  writeFileSync(join(zgAdapter, 'node_modules', '@njuptlzf', 'mcp-adapter', 'package.json'),
    `{"name":"@njuptlzf/mcp-adapter","version":"${DEFAULT_ADAPTER_VERSION}"}`, 'utf8')
  writeFileSync(join(zgVendor, 'node_modules', '@zvec', 'zvec-grep', 'dist', 'cli', 'index.js'), '', 'utf8')
  // cbm 探测只验 existsSync，但 bootstrap 会真的 spawn 它——0 字节假 exe 会让
  // --version 当场抛错、清单永远写不出来。cmd.exe 是"存在的合法可执行文件"的最小
  // 形态：喂给它 --version/config 只会快速非零退出，没有任何副作用。
  const fakeExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
  const zgBase = { adapterDir: zgAdapter, cbmPath: fakeExe }
  const zReady = await mount({ ...zgBase, zgEnabled: true, zgVendorDir: zgVendor })
  const zSetup = await zReady.tools.get('code_setup').execute({}, withSignal(REPO))
  record('Z 就绪报表列出语义层状态', /语义层\(zg\): ready/.test(zSetup), /^语义层\(zg\):.*$/m.exec(zSetup)?.[0]?.slice(0, 120) ?? '(没有 zg 行)')
  record('Z 就绪报表三轴齐全（清单事实 / 包实测 / 页面开关）', /ready  包=已装  页面开关=on/.test(zSetup), /^语义层\(zg\):.*$/m.exec(zSetup)?.[0]?.slice(0, 140) ?? '(没有 zg 行)')
  record('Z 就绪 prompt 给出 zvec_grep_search 路由', /zvec_grep_search/.test(zReady.sections.map((s) => s.text?.()).join('\n')))
  const zDoc = JSON.parse(readFileSync(join(zgAdapter, 'cbm.json'), 'utf8'))
  record('Z 清单第二 server 走自带 stdio 桥', zDoc.mcpServers?.zg?.args?.includes('--stdio') === true
    && zDoc.mcpServers?.zg?.args?.includes('server') === true, JSON.stringify(zDoc.mcpServers?.zg?.args ?? null))
  record('Z zg 用 lazy（无启动竞态，daemon 按需起）', zDoc.mcpServers?.zg?.lifecycle === 'lazy'
    && zDoc.mcpServers?.cbm?.lifecycle === 'keep-alive', `zg=${zDoc.mcpServers?.zg?.lifecycle} cbm=${zDoc.mcpServers?.cbm?.lifecycle}`)
  record('Z 清单写 settings.scriptMode（mcpScript 显式准入，与真清单同源同构）',
    zDoc.settings?.scriptMode === true, `实际=${JSON.stringify(zDoc.settings ?? null)}`)
  const zOff = await mount({ ...zgBase })
  await zOff.tools.get('code_setup').execute({}, withSignal(REPO)) // bootstrap 是惰性的：不跑一次工具，清单还是上一条写的
  const zOffDoc = JSON.parse(readFileSync(join(zgAdapter, 'cbm.json'), 'utf8'))
  record('Z zgEnabled=false 清单只有 cbm', Object.keys(zOffDoc.mcpServers).join() === 'cbm')
  const zMissing = await mount({ ...zgBase, zgEnabled: true, zgVendorDir: join(zgHome, 'nope') })
  const zMSetup = await zMissing.tools.get('code_setup').execute({}, withSignal(REPO))
  record('Z 装了开关但没装包 ⇒ missing + 指路 install:zg',
    /语义层\(zg\): missing/.test(zMSetup) && /install:zg/.test(zMSetup),
    /^语义层\(zg\):.*$/m.exec(zMSetup)?.[0]?.slice(0, 100) ?? '(没有 zg 行)')
  const zBad = await mount({ ...zgBase, zgEnabled: true, zgVendorDir: zgVendor, zgToolset: 'turbo' })
  const zBadSetup = await zBad.tools.get('code_setup').execute({}, withSignal(REPO))
  record('Z 非法 toolset 降级 agent 且留 note', /zgToolset="turbo" 非法/.test(zBadSetup) && /已按 agent/.test(zBadSetup))

  // ── v0.11.0：三轴读数 / 页面开关的延迟态 / agent 安装路线（全在临时目录，already 分支不触网）──
  const zWantRef = mkVolRef(false)
  const zStats = mkVolRef('')
  const zPend = await mount({ ...zgBase, zgEnabled: zWantRef, zgVendorDir: join(zgHome, 'nope'), stats: zStats })
  let zp = null
  try { zp = JSON.parse(String(zStats.get())) } catch { /* 下一条断言会报出来 */ }
  record('Z stats 载荷三轴齐全（zg / zgWant / zgInstalled）',
    !!zp && typeof zp.zg === 'string' && typeof zp.zgWant === 'boolean' && typeof zp.zgInstalled === 'boolean', String(zStats.get()).slice(0, 140))
  await zPend.tools.get('code_setup').execute({}, withSignal(REPO)) // 先跑一次：清单按"开关=关"定成 off
  zWantRef[Symbol.for('cosmokit.volatile.write')](true) // 再模拟页面开关：loader 把新值推进同一引用
  const zPendSetup = await zPend.tools.get('code_setup').execute({}, withSignal(REPO))
  record('Z 开关已开而清单未重建 ⇒ 报表明说「重拉清单后才生效」并指路 install-zg',
    /页面已开启.*(重拉|重启)/.test(zPendSetup) && /restart-adapter/.test(zPendSetup) && /install-zg/.test(zPendSetup) && /包=未装  页面开关=on/.test(zPendSetup),
    /^语义层\(zg\):.*$/m.exec(zPendSetup)?.[0]?.slice(0, 150) ?? '(没有 zg 行)')
  const zgVendor2 = join(zgHome, 'vendor2')
  mkdirSync(join(zgVendor2, 'node_modules', '@zvec', 'zvec-grep', 'dist', 'cli'), { recursive: true })
  writeFileSync(join(zgVendor2, 'node_modules', '@zvec', 'zvec-grep', 'dist', 'cli', 'index.js'), "console.log('0.2.2')\n", 'utf8')
  const zAlready = await mount({ ...zgBase, zgEnabled: true, zgVendorDir: zgVendor2 })
  const zIns = await zAlready.tools.get('code_setup').execute({ action: 'install-zg' }, withSignal(REPO))
  record('Z install-zg 探到包已就位 ⇒ 不重复下载（already + zg-install-skip 计数）',
    /已就位/.test(zIns) && /zg-install-skip=1/.test(zIns) && !/npm install/.test(zIns), zIns.slice(0, 110))
  record('Z install-zg 结果文案带重启与 .zvec-grep gitignore 提醒', /\.gitignore/.test(zIns) && /重启/.test(zIns), zIns.split('\n')[0]?.slice(0, 90) ?? '')
  let zActErr = ''
  try { await zAlready.tools.get('code_setup').execute({ action: 'nope' }, withSignal(REPO)) } catch (e) { zActErr = String(e?.message ?? e) }
  record('Z 未知 action 直接抛错（绝不静默走回检查路线）', /未知 action/.test(zActErr), zActErr.slice(0, 90))
  const idxSrc = readFileSync(join(REPO, 'index.js'), 'utf8')
  const scrSrc = readFileSync(join(REPO, 'scripts', 'install-zg.mjs'), 'utf8')
  const idxPkg = /const ZG_PKG = '([^']+)'/.exec(idxSrc)?.[1]
  const scrPkg = /const PKG = '([^']+)'/.exec(scrSrc)?.[1]
  const idxVer = /const ZG_VERSION = '([^']+)'/.exec(idxSrc)?.[1]
  const scrVer = /const VERSION = '([^']+)'/.exec(scrSrc)?.[1]
  const idxPrune = (/const ZG_PRUNE = \[([^\]]*)\]/.exec(idxSrc)?.[1] ?? '').replace(/\s/g, '')
  const scrPrune = (/const PRUNE = \[([^\]]*)\]/.exec(scrSrc)?.[1] ?? '').replace(/\s/g, '')
  record('Z 两条安装路线钉同一版本（index.js ↔ install-zg.mjs 三对字面量一致）',
    idxPkg === scrPkg && idxVer === scrVer && idxPrune === scrPrune,
    `index=${idxPkg}@${idxVer} script=${scrPkg}@${scrVer} prune 一致=${idxPrune === scrPrune}`)
  rmSync(zgHome, { recursive: true, force: true })

  // ── 臂 V（v0.13.0）：适配层版本对账——"唯一升级入口"必须真的生效 ──────────────
  // 升 pin 后若只看 bundle 存在，机器会停在旧包（没有 watcher、没有 scriptMode）而
  // 报表报 ready——那是 6 小时卡死的另一面：状态没撒谎，只是不知道。三臂锁死对账。
  const vAdapter = join(tmpdir(), `cbm-check-vpin-${process.pid}`)
  rmSync(vAdapter, { recursive: true, force: true })
  const vPkgDir = join(vAdapter, 'node_modules', '@njuptlzf', 'mcp-adapter')
  mkdirSync(vPkgDir, { recursive: true })
  writeFileSync(join(vPkgDir, 'mcp-server.mjs'), '', 'utf8')
  writeFileSync(join(vPkgDir, 'package.json'), '{"name":"@njuptlzf/mcp-adapter","version":"0.0.1-fake"}', 'utf8')
  const vInstalls = []
  const npmStub = (cwd, version) => {
    vInstalls.push(version)
    const dir = join(cwd, 'node_modules', '@njuptlzf', 'mcp-adapter')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'mcp-server.mjs'), '', 'utf8')
    writeFileSync(join(dir, 'package.json'), `{"name":"@njuptlzf/mcp-adapter","version":"${version}"}`, 'utf8')
  }
  const vUp = await mount({ adapterDir: vAdapter, cbmPath: fakeExe }, null, { npmInstall: npmStub })
  const vSetup = await vUp.tools.get('code_setup').execute({}, withSignal(REPO))
  record('V 实装 ≠ 钉 ⇒ 自动重装到钉版本（note 说破重拉 + adapter-upgrade 计数）',
    vInstalls.length === 1 && vInstalls[0] === DEFAULT_ADAPTER_VERSION
      && /适配层已从 0\.0\.1-fake 升到/.test(vSetup) && /adapter-upgrade=1/.test(vSetup),
    `installs=${JSON.stringify(vInstalls)}  ${(/notes: .*/.exec(vSetup)?.[0] ?? '(没有 note)').slice(0, 130)}`)
  vInstalls.length = 0
  const vSame = await mount({ adapterDir: vAdapter, cbmPath: fakeExe }, null, { npmInstall: npmStub })
  const vSameSetup = await vSame.tools.get('code_setup').execute({}, withSignal(REPO))
  record('V 实装 = 钉 ⇒ 零安装（幂等，不重复拉包）',
    vInstalls.length === 0 && /压缩层\(②\): ready/.test(vSameSetup) && !/升到/.test(vSameSetup),
    `installs=${JSON.stringify(vInstalls)}`)
  writeFileSync(join(vPkgDir, 'package.json'), '{"name":"@njuptlzf/mcp-adapter","version":"0.0.1-fake"}', 'utf8')
  const vMan = await mount({ adapterDir: vAdapter, cbmPath: fakeExe, bootstrap: 'manual' }, null, { npmInstall: npmStub })
  const vManSetup = await vMan.tools.get('code_setup').execute({}, withSignal(REPO))
  record('V manual + 旧实装 ⇒ 不碰网络：保留 ready，差距只进 note',
    vInstalls.length === 0 && /压缩层\(②\): ready/.test(vManSetup) && /bootstrap=manual 不自动升级/.test(vManSetup),
    `installs=${JSON.stringify(vInstalls)}  ${(/notes: .*/.exec(vManSetup)?.[0] ?? '(没有 note)').slice(0, 110)}`)
  rmSync(vAdapter, { recursive: true, force: true })

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
    [/触发层:.*$/m, /遥测计数.*$/m].map((re) => re.exec(denyReport)?.[0] ?? '(缺行)').join(' | ').slice(0, 220))

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

  // G5.5 图里没有这个符号 ⇒ 放行：拦一条"索引本来就没答案"的搜索，等于把模型
  // 唯一走得通的路也挡掉，而 reason 里除了"(无命中)"什么也没给。
  const nCalls = []
  const n = await mount({ enforce: 'deny', telemetry: false }, makeStubProxy(nCalls, { project: `stub-${process.pid}-nohit`, emptySearch: true }))
  await n.tools.get('code_setup').execute({}, withSignal(REPO))
  const noHitPass = await (n.events['tools/pre-execute'] ?? [])[0](grepExec(fakeAgent(`sess-${process.pid}-nohit`, REPO), 'usageSection'), next)
  record('G 代码图无命中时放行 grep（不是每次都拦）', noHitPass?.kind === 'allow', JSON.stringify(noHitPass))
  const noHitFind = await n.tools.get('code_find').execute({ query: 'ghostSymbol' }, { agent: fakeAgent(`sess-${process.pid}-nohit`, REPO), signal: sig() })
  record('G code_find 无命中时给明确 status 而不是假装有结果', noHitFind?.status === 'empty' && /没有匹配/.test(noHitFind?.text ?? ''), JSON.stringify(noHitFind).slice(0, 140))

  // G6 杠杆 ⑤：写后记账 = **只用本会话自己的写入台账**判坐标可信度。
  // 为什么不用引擎的 check_index_coverage 当门：实测（引擎 0.11.0）全量重索引之后，
  // 一个**没改过**的文件照样报 freshness=metadata_changed / action=read_source_and_reindex，
  // 和改过的文件一模一样——那是项目级的代际信号，不是逐路径的过期信号。拿它当门的结果
  // 是拦截永久失效 + 每条被拦的 grep 都调度一次 20s 重索引。所以这里反过来断言：
  // 热路径上**不该出现**覆盖查询。
  const tRepo = join(tmpdir(), `cbm-check-dirty-${process.pid}`)
  rmSync(tRepo, { recursive: true, force: true })
  mkdirSync(tRepo, { recursive: true })
  const fCalls = []
  const f = await mount({ enforce: 'deny', telemetry: false }, makeStubProxy(fCalls, { project: `stub-${process.pid}-f`, root: tRepo }))
  await f.tools.get('code_setup').execute({}, withSignal(REPO))
  const postF = (f.events['tools/post-execute'] ?? [])[0]
  const preF = (f.events['tools/pre-execute'] ?? [])[0]
  const agentF = fakeAgent(`sess-${process.pid}-f`, tRepo)
  const agentClean = fakeAgent(`sess-${process.pid}-clean`, tRepo)
  const callsBeforeRecord = fCalls.length // v0.10.1 起 bootstrap 预热会留下一发 list_projects——基线差值才等于"记账触发的调用"
  await postF({ name: 'edit', arguments: { file_path: join(tRepo, 'probe.ts') }, agent: agentF, signal: sig() }, { content: [], isError: false }, nextPost)
  const callsAfterRecord = fCalls.length - callsBeforeRecord // 记账本身不查 cbm（惰性：等查询来了再说）
  const dirtyPass = await preF(grepExec(agentF, 'probeSymbol'), next)
  record('G 脏路径记账不触发任何即时 cbm 调用（惰性）', callsAfterRecord === 0, `记账后 cbm 调用数=${callsAfterRecord}`)
  record('G 本会话写过代码 ⇒ 拦截改为放行', dirtyPass?.kind === 'allow', JSON.stringify(dirtyPass))
  record('G 热路径上不再发覆盖查询（0.11.0 的信号是项目级的，不能当门）',
    !fCalls.some((x) => x.tool === 'cbm_check_index_coverage'), fCalls.map((x) => x.tool).join(','))
  const cleanDeny = await preF(grepExec(agentClean, 'probeSymbol'), next)
  record('G 没写过的会话照常拦截（台账是按会话的，不互相拖累）', cleanDeny?.kind === 'deny', JSON.stringify(cleanDeny).slice(0, 90))
  await postF({ name: 'edit', arguments: { file_path: join(tmpdir(), `cbm-check-dirty-${process.pid}-outside`, 'outside.ts') }, agent: agentClean, signal: sig() }, { content: [], isError: false }, nextPost)
  const outsideDeny = await preF(grepExec(agentClean, 'anotherSymbol'), next)
  record('G 工作区外的写入不进脏集合（不该把拦截关掉）', outsideDeny?.kind === 'deny', JSON.stringify(outsideDeny).slice(0, 90))
  const staleFind = await f.tools.get('code_find').execute({ query: 'probeSymbol' }, { agent: agentF, signal: sig() })
  record('G code_find 按台账给出过期警告', staleFind?.status === 'stale' && /probe\.ts/.test(staleFind?.text ?? ''), JSON.stringify(staleFind).slice(0, 150))

  // G7 撤回验证：④ advise 事件注入已于 2026-10-08 验收撤回。默认 enforce=off 时拦截
   // 钩子照常注册（enforce 是 volatile 字段，设置页改了要立刻生效），但必须原样放行；
   // post-execute 只剩写入记账——既不追加上下文，也仍要把坐标标脏。
  const vCalls = []
  const v = await mount({ telemetry: false }, makeStubProxy(vCalls, { project: `stub-${process.pid}-adv` }))
  await v.tools.get('code_setup').execute({}, withSignal(REPO))
  const preV = (v.events['tools/pre-execute'] ?? [])[0]
  record('G 默认 enforce=off 时拦截钩子常驻但原样放行', typeof preV === 'function' && (await preV(grepExec(fakeAgent(`sess-${process.pid}-offv`, REPO), 'usageSection'), next))?.kind === 'allow',
    `handlers=${(v.events['tools/pre-execute'] ?? []).length}`)
  const vReport = await v.tools.get('code_setup').execute({}, withSignal(REPO))
  record('G 报表默认 enforce=off（advise 模式已撤回）', /触发层:.*enforce=off/.test(vReport), /触发层:.*$/m.exec(vReport)?.[0]?.slice(0, 130) ?? '(缺行)')
  const postV = (v.events['tools/post-execute'] ?? [])[0]
  const agentV = fakeAgent(`sess-${process.pid}-adv`, REPO)
  const symGrep = await postV(grepExec(agentV, 'usageSection'), { content: [{ type: 'text', text: 'grep 结果' }], isError: false }, nextPost)
  record('G 符号类 grep 不再追加任何上下文（注入机制已删除）', symGrep?.kind === 'accept' && !symGrep?.additionalContexts?.length, JSON.stringify(symGrep).slice(0, 80))
  await postV({ name: 'edit', arguments: { file_path: join(REPO, 'index.js') }, agent: agentV, signal: sig() }, { content: [], isError: false }, nextPost)
  const dirtyFind = await v.tools.get('code_find').execute({ query: 'stubSymbol' }, { agent: agentV, signal: sig() })
  record('G 默认 off 下写后记账照常工作（台账仍会把坐标标脏）', dirtyFind?.status === 'stale' && /index\.js/.test(dirtyFind?.text ?? ''), JSON.stringify(dirtyFind?.status))

  // G7.5 volatile 契约（设置页的写路径 + 读数通道）：七个设置页可写字段（enforce / interceptTools /
  // interceptBudgetMs / contextHint / telemetry / dirtyTracking / zgEnabled——最后一个页内可写
  // 但清单重启才重建）必须①在 schema 上标 volatile——dsh-settings 只把 volatile 字段放进表单，写非 volatile
  // 字段直接抛 "Config field ... is not volatile"；②在钩子里读**引用当前值**——apply 时
  // 快照的话，UI 改了、拦截行为还是旧的，那比没有 UI 更糟。这里用假引用模拟 loader 的
  // _commitVolatile（它就是把新快照 updateVolatile 进同一个引用）。
  // stats 方向相反：不是用户可写项，是插件→页面的只读读数通道，但它同样必须 volatile
  // ——describe() 只把 volatile 字段解引用进快照，标错（或漏标）页面就永远看不到读数。
  const VOLATILE_KEYS = ['enforce', 'interceptTools', 'interceptBudgetMs', 'contextHint', 'telemetry', 'dirtyTracking', 'stats', 'zgEnabled']
  // schemastery 的字段表在 `Config.dict`（宿主 dsh-settings 的 volatileForm 也是递归它）。
  const marked = VOLATILE_KEYS.filter((k) => Config?.dict?.[k]?.meta?.volatile === true)
  record('G 六个即时热改字段 + zgEnabled（延迟生效）+ 读数通道在 Config 里标了 volatile（宿主才肯 serve/写）', marked.length === 8, `标了的是 ${marked.join(',') || '(无)'}`)
  const extra = Object.keys(Config?.dict ?? {}).filter((k) => Config.dict[k]?.meta?.volatile === true && !VOLATILE_KEYS.includes(k))
  record('G 没有把需要重启的字段标成 volatile（标错等于对 UI 撒谎）', extra.length === 0, extra.join(','))

  let flipMode = 'off'
  const f2Calls = []
  const f2 = await mount(
    // 只有 enforce 传引用：顺带证明 getter 对裸值同样成立（向后兼容老配置与别的臂）。
    { enforce: { get: () => flipMode }, telemetry: false },
    makeStubProxy(f2Calls, { project: `stub-${process.pid}-flip` }),
  )
  await f2.tools.get('code_setup').execute({}, withSignal(REPO))
  const preF2 = (f2.events['tools/pre-execute'] ?? [])[0]
  const agentF2 = fakeAgent(`sess-${process.pid}-flip`, REPO)
  const flipStep = async () => (await preF2(grepExec(agentF2, 'usageSection'), next))?.kind
  const flipOff = await flipStep()
  flipMode = 'deny'
  const flipDeny = await flipStep()
  flipMode = 'off'
  const flipBack = await flipStep()
  record('G 挂载后翻 volatile enforce 立即改变拦截（读的是引用当前值）',
    flipOff === 'allow' && flipDeny === 'deny' && flipBack === 'allow', `off→${flipOff} deny→${flipDeny} off→${flipBack}`)

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
  // G8.5 语义层缺包注入句（v0.11.3）：只在「开关已开 + 包没装」这一具体状态注入，
  // 任一条件变化自动消失——它是纠正动作不是状态播报（播报归设置页状态行）。
  // 三臂都传临时 adapterDir + zgVendorDir：bootstrap 会写 cbm.json / 找 vendor 包，绝不许碰真机目录。
  const zgmDir = join(tmpdir(), `cbm-zgm-${process.pid}`)
  mkdirSync(zgmDir, { recursive: true })
  // 缺包/有包用 zgVendorDir 表达（zgCli 是派生值，不是可配置字段——传了会被 zod 剥掉）。
  const zgmAbsent = join(zgmDir, 'no-such-vendor')
  const zgmVendor = join(zgmDir, 'vendor')
  mkdirSync(join(zgmVendor, 'node_modules', '@zvec', 'zvec-grep', 'dist', 'cli'), { recursive: true })
  writeFileSync(join(zgmVendor, 'node_modules', '@zvec', 'zvec-grep', 'dist', 'cli', 'index.js'), '', 'utf8')
  const zgmCalls = []
  const zHintOf = (m) => (m.contexts ?? []).find((c) => c.name === 'codebase-memory:hint')
  const zm = await mount({ telemetry: false, adapterDir: zgmDir, zgEnabled: true, zgVendorDir: zgmAbsent }, makeStubProxy(zgmCalls, { project: `stub-${process.pid}-zgm` }), { npmInstall: npmStub })
  const zgmSetup = await zm.tools.get('code_setup').execute({}, withSignal(REPO))
  const zTextMissing = zHintOf(zm)?.text?.({ agent: fakeAgent(`sess-${process.pid}-zgm1`, REPO, codeAsk) }) ?? 'x'
  record('G zg 缺包+开关开 ⇒ 注入句让 agent 征求同意后时代装（写明体积与重启）',
    typeof zTextMissing === 'string' && /code_setup \{action:"install-zg"\}/.test(zTextMissing) && /430MB/.test(zTextMissing) && /重启/.test(zTextMissing),
    `setup=${String(zgmSetup).split('\n').filter((l) => /语义层|status|热改/.test(l)).join(' | ').slice(0, 220)}  hint=${zTextMissing.slice(-110)}`)
  const zo = await mount({ telemetry: false, adapterDir: zgmDir, zgEnabled: false, zgVendorDir: zgmAbsent }, makeStubProxy(zgmCalls, { project: `stub-${process.pid}-zgm` }))
  await zo.tools.get('code_setup').execute({}, withSignal(REPO))
  const zTextOff = zHintOf(zo)?.text?.({ agent: fakeAgent(`sess-${process.pid}-zgm2`, REPO, codeAsk) }) ?? 'x'
  record('G zg 开关关 ⇒ 不注入缺包句（包真缺也不越权）', typeof zTextOff === 'string' && !/install-zg/.test(zTextOff), zTextOff.slice(-80))
  const zi = await mount({ telemetry: false, adapterDir: zgmDir, zgEnabled: true, zgVendorDir: zgmVendor }, makeStubProxy(zgmCalls, { project: `stub-${process.pid}-zgm` }))
  await zi.tools.get('code_setup').execute({}, withSignal(REPO))
  const zTextReady = zHintOf(zi)?.text?.({ agent: fakeAgent(`sess-${process.pid}-zgm3`, REPO, codeAsk) }) ?? 'x'
  record('G zg 包已装 ⇒ 注入句自动消失（不留常驻唠叨）', typeof zTextReady === 'string' && !/install-zg/.test(zTextReady), zTextReady.slice(-80))
  // G8.6 缺索引注入句 + replace 守卫（v0.13.3）：包已装、清单 ready，但**本仓从未建过
  // 语义索引**——上游 activate() 在读 freshness/autoUpdate 任何参数之前就 throw
  // INDEX_MISSING（0.2.2 源码实证：参数救不了首建，唯一入口是 CLI index）。事前一句
  // 话带处方（先点头、后代建、产物进 gitignore），比首查撞墙便宜；replace 通道则
  // 干脆跳过这一发注定失败的查询。工作区用临时目录造两种状态，不依赖仓库自身。
  const zgNoWs = join(zgmDir, 'ws-no-index')
  const zgYesWs = join(zgmDir, 'ws-indexed')
  mkdirSync(zgNoWs, { recursive: true })
  mkdirSync(join(zgYesWs, '.zvec-grep'), { recursive: true })
  const zTextNoIdx = zHintOf(zi)?.text?.({ agent: fakeAgent(`sess-${process.pid}-zgnoidx1`, zgNoWs, codeAsk) }) ?? 'x'
  record('G zg ready 且本仓无 .zvec-grep ⇒ 注入句事前报 INDEX_MISSING 并给带点头前置的代建 CLI',
    typeof zTextNoIdx === 'string' && /INDEX_MISSING/.test(zTextNoIdx) && /node .* index/.test(zTextNoIdx) && /\.gitignore/.test(zTextNoIdx),
    String(zTextNoIdx).slice(-150))
  const zTextHasIdx = zHintOf(zi)?.text?.({ agent: fakeAgent(`sess-${process.pid}-zgnoidx2`, zgYesWs, codeAsk) }) ?? 'x'
  record('G 本仓有 .zvec-grep ⇒ 缺索引句自动消失（不唠叨已建好的仓）', typeof zTextHasIdx === 'string' && !/INDEX_MISSING/.test(zTextHasIdx), String(zTextHasIdx).slice(-70))
  record('G 缺包句与缺索引句互斥（包没装时只谈装包，不两条处方打架）', typeof zTextMissing === 'string' && !/INDEX_MISSING/.test(zTextMissing), zTextMissing.slice(-60))
  const zrCalls = []
  const zr = await mount({ enforce: 'replace', dirtyTracking: false, telemetry: false, zgEnabled: true, adapterDir: zgmDir, zgVendorDir: zgmVendor }, makeStubProxy(zrCalls, { project: `stub-${process.pid}-zrguard`, zgGate: true }))
  await zr.tools.get('code_setup').execute({}, withSignal(REPO))
  const postZr = (zr.events['tools/post-execute'] ?? [])[1]
  const zgSkip = await postZr(grepExec(fakeAgent(`sess-${process.pid}-zrguard-a`, zgNoWs), 'usageSection'), { content: [{ type: 'text', text: '原始 grep 输出' }], isError: false }, nextPost)
  record('R replace 对本仓无索引的 grep 直接保留原输出（不发注定 INDEX_MISSING 的白枪）',
    zgSkip?.kind === 'accept' && zgSkip?.content === undefined && !zrCalls.some((x) => x.tool === 'zg_zvec_grep_search'),
    `calls=${zrCalls.map((x) => x.tool).join(',') || '(无)'}`)
  const zgSwap = await postZr(grepExec(fakeAgent(`sess-${process.pid}-zrguard-b`, zgYesWs), 'usageSection'), { content: [{ type: 'text', text: '原始 grep 输出' }], isError: false }, nextPost)
  record('R 有 .zvec-grep 目录时 replace 照常查 zg 并替换（守卫不误伤正路）',
    /语义层/.test(zgSwap?.content?.[0]?.text ?? '') && zrCalls.some((x) => x.tool === 'zg_zvec_grep_search'),
    String(zgSwap?.content?.[0]?.text ?? '(没换)').slice(0, 70))
  rmSync(zgmDir, { recursive: true, force: true })
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

  // ── 臂 R：enforce=replace —— 成功 grep 的**输出**换成图谱命中 ─────────────────
  // 通道是 post-execute 的 accept+content（宿主契约 dsh-tools index.d.ts:465-479
  // "accept keeps the call successful (replacing content when given)"；pre-execute
  // 不能改写参数——"Input rewriting is excluded", index.d.ts:442-443，实参
  // deepFreeze）。语义：grep 照常跑、照常成功；换的只是模型看到的内容。前提不满足
  // /失败结果/图谱无命中 ⇒ 保留原输出，且全程不出 isError。记账监听器常驻
  // （v0.9.0 热翻契约）⇒ post-execute 索引 0 永远是记账，replace 在 1。
  const rCalls = []
  const r = await mount({ enforce: 'replace', dirtyTracking: false }, makeStubProxy(rCalls, { project: `stub-${process.pid}-rep` }))
  await r.tools.get('code_setup').execute({}, withSignal(REPO))
  const preR = (r.events['tools/pre-execute'] ?? [])[0]
  const postR = (r.events['tools/post-execute'] ?? [])[1]
  const agentR = fakeAgent(`sess-${process.pid}-rep`, REPO)
  const rAllow = await preR(grepExec(agentR, 'usageSection'), next)
  record('R replace 档不拦截：grep 照常执行（替换是后置的）', rAllow?.kind === 'allow', JSON.stringify(rAllow))
  const swapped = await postR(grepExec(agentR, 'usageSection'), { content: [{ type: 'text', text: '原始 grep 输出' }], isError: false }, nextPost)
  record('R 符号类 grep 的成功输出被换成图谱命中（原输出不再出现）',
    swapped?.kind === 'accept' && /stubSymbol/.test(swapped?.content?.[0]?.text ?? '') && !/原始 grep 输出/.test(swapped?.content?.[0]?.text ?? '') && !swapped?.additionalContexts?.length,
    JSON.stringify(swapped).slice(0, 160))
  record('R 替换文案标明结构层（两层并存措辞纪律，不再说"索引命中"）',
    /结构层/.test(swapped?.content?.[0]?.text ?? '') && !/索引命中/.test(swapped?.content?.[0]?.text ?? ''),
    (swapped?.content?.[0]?.text ?? '').slice(0, 80))
  record('R 替换确实查的是图谱（search_graph 走代理，没 spawn CLI）',
    rCalls.some((x) => x.tool === 'cbm_search_graph' && x.args.query === 'usageSection'), rCalls.map((x) => x.tool).join(','))
  const rLiteral = await postR(grepExec(agentR, 'TODO: fix later'), { content: [{ type: 'text', text: '原始 grep 输出' }], isError: false }, nextPost)
  record('R 字面量类 pattern 不替换', rLiteral?.kind === 'accept' && rLiteral?.content === undefined, JSON.stringify(rLiteral).slice(0, 90))
  const rErr = await postR(grepExec(agentR, 'usageSection'), { content: [], isError: true, error: { message: 'boom' } }, nextPost)
  record('R 失败结果不替换（被 deny 物化的错误不该再被改写）', rErr?.kind === 'accept' && rErr?.content === undefined, JSON.stringify(rErr).slice(0, 90))
  const rnCalls = []
  const rn = await mount({ enforce: 'replace', dirtyTracking: false, telemetry: false }, makeStubProxy(rnCalls, { project: `stub-${process.pid}-rnohit`, emptySearch: true }))
  await rn.tools.get('code_setup').execute({}, withSignal(REPO))
  const rNoHit = await (rn.events['tools/post-execute'] ?? [])[1](grepExec(fakeAgent(`sess-${process.pid}-rnohit`, REPO), 'usageSection'), { content: [{ type: 'text', text: '原始 grep 输出' }], isError: false }, nextPost)
  record('R 图谱无命中时保留原输出：没答案就不换，grep 才是对的工具', rNoHit?.kind === 'accept' && rNoHit?.content === undefined, JSON.stringify(rNoHit).slice(0, 90))
  const rdCalls = []
  const rd = await mount({ enforce: 'replace' }, makeStubProxy(rdCalls, { project: `stub-${process.pid}-rdirty` }))
  await rd.tools.get('code_setup').execute({}, withSignal(REPO))
  const rdBook = (rd.events['tools/post-execute'] ?? [])[0]
  const rdRep = (rd.events['tools/post-execute'] ?? [])[1]
  const agentRd = fakeAgent(`sess-${process.pid}-rdirty`, REPO)
  await rdBook({ name: 'edit', arguments: { file_path: join(REPO, 'index.js') }, agent: agentRd, signal: sig() }, { content: [], isError: false }, nextPost)
  const dirtySwap = await rdRep(grepExec(agentRd, 'usageSection'), { content: [{ type: 'text', text: '原始 grep 输出' }], isError: false }, nextPost)
  record('R 本会话写过代码 ⇒ 不换（台账脏=坐标可能过期，拿旧图替换就是骗人）',
    dirtySwap?.kind === 'accept' && dirtySwap?.content === undefined, JSON.stringify(dirtySwap).slice(0, 90))
  let flipRep = 'off'
  const rf = await mount({ enforce: { get: () => flipRep }, dirtyTracking: false, telemetry: false }, makeStubProxy([], { project: `stub-${process.pid}-rflip` }))
  await rf.tools.get('code_setup').execute({}, withSignal(REPO))
  const postRf = (rf.events['tools/post-execute'] ?? [])[1]
  const flipBefore = await postRf(grepExec(fakeAgent(`sess-${process.pid}-rflip`, REPO), 'usageSection'), { content: [{ type: 'text', text: 'O' }], isError: false }, nextPost)
  flipRep = 'replace'
  const flipAfter = await postRf(grepExec(fakeAgent(`sess-${process.pid}-rflip`, REPO), 'usageSection'), { content: [{ type: 'text', text: 'O' }], isError: false }, nextPost)
  record('R 热翻 volatile enforce 立即作用于替换通道（不用重启）',
    flipBefore?.content === undefined && /stubSymbol/.test(flipAfter?.content?.[0]?.text ?? ''), `off→${JSON.stringify(flipBefore).slice(0, 40)} replace→${JSON.stringify(flipAfter).slice(0, 60)}`)
  const rReport = await r.tools.get('code_setup').execute({}, withSignal(REPO))
  record('R 遥测计数里能看到 intercept-replace', /intercept-replace=1/.test(rReport), /遥测计数.*$/m.exec(rReport)?.[0]?.slice(0, 220) ?? '(缺行)')

  // ── 臂 S：设置页读数通道 —— counts → volatile stats 引用 + 节流 emit ────────────
  const sRef = mkVolRef('')
  const sCalls = []
  const s = await mount({ enforce: 'replace', dirtyTracking: false, stats: sRef }, makeStubProxy(sCalls, { project: `stub-${process.pid}-stats` }))
  let spBoot = null
  try { spBoot = JSON.parse(String(sRef.get())) } catch { /* 下一条断言报出来 */ }
  record('S 开机遥测开 ⇒ 先推一帧零值快照（刚重启的设置页也是卡片常驻，不是空态）',
    !!spBoot && typeof spBoot.at === 'number' && (spBoot.replace?.hit ?? -1) === 0, String(sRef.get()).slice(0, 60))
  await s.tools.get('code_setup').execute({}, withSignal(REPO))
  const agentS = fakeAgent(`sess-${process.pid}-stats`, REPO)
  await (s.events['tools/post-execute'] ?? [])[1](grepExec(agentS, 'usageSection'), { content: [{ type: 'text', text: '原始 grep 输出' }], isError: false }, nextPost)
  await s.tools.get('code_find').execute({ query: 'stubSymbol' }, { agent: agentS, signal: sig() })
  const sHint = (s.contexts ?? []).find((c) => c.name === 'codebase-memory:hint')
  sHint?.text({ agent: fakeAgent(`sess-${process.pid}-stats`, REPO, codeAsk) })
  let sp = null
  try { sp = JSON.parse(String(sRef.get())) } catch { /* 下一行断言会把它报出来 */ }
  record('S 替换事件把全量读数推进 volatile stats 引用（hit + graph 拆分 + zg 状态 + at）',
    sp?.replace?.hit === 1 && sp?.replace?.graph === 1 && sp?.zg === 'off' && typeof sp?.at === 'number', String(sRef.get()).slice(0, 170))
  const sEmit = (s.emits ?? []).find((x) => x[0] === 'settings/document-updated')
  record('S 推送后 emit settings/document-updated（首参是字符串 ns，cordis 才不会把它当 thisArg 过滤）',
    !!sEmit && sEmit[1] === 'codebase-memory' && typeof sEmit[2] === 'number', JSON.stringify(sEmit ?? null))
  record('S 软杠杆也在数：封装调用 + 提示注入进读数',
    (sp?.lever?.wrapperCalls ?? 0) >= 1 && (sp?.lever?.hintInjected ?? 0) >= 1, `lever=${JSON.stringify(sp?.lever ?? null)}`)
  const sOff = mkVolRef('')
  const so = await mount({ enforce: 'replace', dirtyTracking: false, telemetry: false, stats: sOff }, makeStubProxy([], { project: `stub-${process.pid}-soff` }))
  await so.tools.get('code_setup').execute({}, withSignal(REPO))
  await (so.events['tools/post-execute'] ?? [])[1](grepExec(fakeAgent(`sess-${process.pid}-soff`, REPO), 'usageSection'), { content: [{ type: 'text', text: 'O' }], isError: false }, nextPost)
  record('S 遥测关 ⇒ 不推读数也不 emit（页面与日志同一开关，冻结在最后值）',
    sOff.get() === '' && !(so.emits ?? []).some((x) => x[0] === 'settings/document-updated'), String(sOff.get()).slice(0, 40))

  // ── 臂 R2/R3：泡数据完整性两修（遥测里抓到的真 bug 的回归锁）──────────────────
  // R2 越界：图谱/zg 都是工作区级的，path 指到工作区外的 grep 被替换=伪造坐标
  //     （实测遥测：path=AppData\… 的 grep 换成了本仓命中）。
  const r2Calls = []
  const r2 = await mount({ enforce: 'replace', dirtyTracking: false, telemetry: false }, makeStubProxy(r2Calls, { project: `stub-${process.pid}-rscope` }))
  await r2.tools.get('code_setup').execute({}, withSignal(REPO))
  const postR2 = (r2.events['tools/post-execute'] ?? [])[1]
  const agentR2 = fakeAgent(`sess-${process.pid}-rscope`, REPO)
  const outSwap = await postR2(grepExec(agentR2, 'usageSection', { path: ADAPTER_DIR }), { content: [{ type: 'text', text: '原始 grep 输出' }], isError: false }, nextPost)
  record('R2 搜工作区之外的 grep 原样保留（不查两层、不换）',
    outSwap?.kind === 'accept' && outSwap?.content === undefined && !r2Calls.some((x) => x.tool === 'cbm_search_graph'),
    `${JSON.stringify(outSwap).slice(0, 50)} calls=${r2Calls.map((x) => x.tool).join(',') || '(无)'}`)
  const inSwap = await postR2(grepExec(agentR2, 'usageSection', { path: join(REPO, 'index.js') }), { content: [{ type: 'text', text: '原始 grep 输出' }], isError: false }, nextPost)
  record('R2 工作区内指定文件的 grep 照换（作用域门不误伤正路）', /stubSymbol/.test(inSwap?.content?.[0]?.text ?? ''), JSON.stringify(inSwap).slice(0, 60))
  // R3 错误文本：代理把底层 MCP 错误包成普通文本返回（isError 假），错误被当命中
  //     替换了原输出（实测遥测 source=zg）。且「查询失败」与「无命中」分开计数——
  //     泡数据时这两个占比含义相反。
  const r3Ref = mkVolRef('')
  const r3 = await mount({ enforce: 'replace', dirtyTracking: false, stats: r3Ref }, makeStubProxy([], { project: `stub-${process.pid}-rerr`, errorSearch: true }))
  await r3.tools.get('code_setup').execute({}, withSignal(REPO))
  const r3Swap = await (r3.events['tools/post-execute'] ?? [])[1](grepExec(fakeAgent(`sess-${process.pid}-rerr`, REPO), 'usageSection'), { content: [{ type: 'text', text: '原始 grep 输出' }], isError: false }, nextPost)
  let r3Stats = null
  try { r3Stats = JSON.parse(String(r3Ref.get())) } catch { /* 下一条断言报出来 */ }
  record('R3 Error 文本判为失败：不替换，且计成 passFailed 而非 noHit',
    r3Swap?.content === undefined && (r3Stats?.replace?.passFailed ?? 0) === 1 && (r3Stats?.replace?.hit ?? 0) === 0 && (r3Stats?.replace?.passNoHit ?? 1) === 0,
    String(r3Ref.get()).slice(0, 170))

  // ── 臂 S2：累计计数跨重启（「跑几天看占比」不能每次重启归零）─────────────────
  const seedFile = join(countsDir, 's2-shared.json')
  writeFileSync(seedFile, JSON.stringify({ 'intercept-replace': 7, 'intercept-replace:graph': 5 }))
  const s2Ref = mkVolRef('')
  const s2 = await mount({ enforce: 'replace', dirtyTracking: false, stats: s2Ref }, makeStubProxy([], { project: `stub-${process.pid}-s2` }), null, seedFile)
  let s2Boot = null
  try { s2Boot = JSON.parse(String(s2Ref.get())) } catch { /* 下一条断言报出来 */ }
  record('S2 重启不归零：开机从累计文件播种，第一帧读数就带历史数',
    (s2Boot?.replace?.hit ?? 0) === 7 && (s2Boot?.replace?.graph ?? 0) === 5, String(s2Ref.get()).slice(0, 120))
  await s2.tools.get('code_setup').execute({}, withSignal(REPO))
  await (s2.events['tools/post-execute'] ?? [])[1](grepExec(fakeAgent(`sess-${process.pid}-s2`, REPO), 'usageSection'), { content: [{ type: 'text', text: 'O' }], isError: false }, nextPost)
  const s2File = JSON.parse(String(readFileSync(seedFile, 'utf8')))
  record('S2 新事件落盘：与文件 max 合并（7→8），不是覆盖也不是只留内存',
    (s2File['intercept-replace'] ?? 0) === 8 && (s2File['intercept-replace:graph'] ?? 0) === 6, JSON.stringify(s2File).slice(0, 170))

  // ── 臂 T：v0.9.0 新上设置页三字段的**热翻契约**——监听器常驻、字段在决策点现读。
  // 这是"页面不说谎"的机器证明：翻引用不重挂载，行为当场跟着变。
  let flipDt = true
  let flipHint = true
  let flipTools = 'grep'
  const t = await mount({
    enforce: 'replace', telemetry: false, stats: mkVolRef(''),
    dirtyTracking: { get: () => flipDt },
    contextHint: { get: () => flipHint },
    interceptTools: { get: () => flipTools },
  }, makeStubProxy([], { project: `stub-${process.pid}-hot` }))
  await t.tools.get('code_setup').execute({}, withSignal(REPO))
  const tBook = (t.events['tools/post-execute'] ?? [])[0]
  const tRep = (t.events['tools/post-execute'] ?? [])[1]
  const editExec = (agent) => ({ name: 'edit', arguments: { file_path: join(REPO, 'index.js') }, agent, signal: sig() })
  const agentT1 = fakeAgent(`sess-${process.pid}-hot1`, REPO)
  await tBook(editExec(agentT1), { content: [], isError: false }, nextPost)
  const yieldDirty = await tRep(grepExec(agentT1, 'usageSection'), { content: [{ type: 'text', text: 'O' }], isError: false }, nextPost)
  flipDt = false
  const agentT2 = fakeAgent(`sess-${process.pid}-hot2`, REPO)
  await tBook(editExec(agentT2), { content: [], isError: false }, nextPost)
  const swapAfterOff = await tRep(grepExec(agentT2, 'usageSection'), { content: [{ type: 'text', text: 'O' }], isError: false }, nextPost)
  record('T 热翻 dirtyTracking 立即开合记账：开着脏台账让路，关了不再入册',
    yieldDirty?.content === undefined && /stubSymbol/.test(swapAfterOff?.content?.[0]?.text ?? ''),
    `on→${JSON.stringify(yieldDirty).slice(0, 30)} off→${JSON.stringify(swapAfterOff).slice(0, 40)}`)
  const tHint = (t.contexts ?? []).find((c) => c.name === 'codebase-memory:hint')
  const hintAgent = fakeAgent(`sess-${process.pid}-hot3`, REPO, codeAsk)
  const hintOn = typeof tHint?.text === 'function' ? tHint.text({ agent: hintAgent }) : 'x'
  flipHint = false
  const hintOff = typeof tHint?.text === 'function' ? tHint.text({ agent: hintAgent }) : 'x'
  record('T 热翻 contextHint 立即静音注入（监听器常驻，回调里现读）',
    /code_find/.test(String(hintOn)) && hintOff === '', `on=${String(hintOn).slice(0, 40)} off=${JSON.stringify(hintOff)}`)
  const agentT4 = fakeAgent(`sess-${process.pid}-hot4`, REPO)
  const globExec = { name: 'glob', arguments: { pattern: 'usageSection' }, agent: agentT4, signal: sig() }
  const globNarrow = await tRep(globExec, { content: [{ type: 'text', text: 'O' }], isError: false }, nextPost)
  flipTools = 'grep,glob'
  const globWide = await tRep(globExec, { content: [{ type: 'text', text: 'O' }], isError: false }, nextPost)
  record('T 热翻 interceptTools 立即开合名单：glob 不在名单不碰，进了名单照换',
    globNarrow?.content === undefined && /stubSymbol/.test(globWide?.content?.[0]?.text ?? ''),
    `['grep']→${JSON.stringify(globNarrow).slice(0, 30)} ['grep,glob']→${JSON.stringify(globWide).slice(0, 40)}`)

  // ── 臂 W：v0.10.1 冷启动预热 + projectFor 的诚实原因 ──────────────────────
  // 验收实测：宿主重启后第一次 list_projects 撞上引擎冷启动，旧版把"查询失败"
  // 报成"还没进代码图"，指人去跑 code_index。两条契约：预热每进程恰好一发；
  // 查不到 project 时错误消息必须区分"不在表里"与"查询失败"并带出代理原文。
  const wCalls = []
  const w = await mount({ enforce: 'off', dirtyTracking: false, telemetry: false },
    makeStubProxy(wCalls, { project: `stub-${process.pid}-warm` }))
  await w.tools.get('code_setup').execute({}, withSignal(REPO))
  await w.tools.get('code_setup').execute({}, withSignal(REPO)) // 第二次不许再预热
  const warmShots = wCalls.filter((c) => c.tool === 'cbm_list_projects').length
  record('W bootstrap 在会话外预热恰好一发（重复 code_setup 不叠加）', warmShots === 1, `list_projects 调用数=${warmShots}`)
  const wReport = await w.tools.get('code_setup').execute({}, withSignal(REPO))
  record('W 报告行报出预热状态', /warm=(ok|pending)/.test(wReport), /代理工具:.*warm=\w+/.exec(wReport)?.[0]?.slice(0, 140) ?? '(没有 warm 字段)')
  // v0.13.2：预热秒表退役——race 超时只是放弃等待、不杀调用，引擎实际还在被焐热，
  // 旧代码却把报表钉成 failed。契约改为按真实 settle 落账：慢一发（超过旧 20s 预算
  // 的语义等价物=任何延迟）仍在完成时报 ok，遥测行带耗时 ms（旧行没有 ms ⇒ 可证伪）。
  const w2Dir = join(tmpdir(), `cbm-w2-${process.pid}-${profile}`)
  const rmW2 = () => { try { rmSync(w2Dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }) } catch { /* 尽力，目录名带 pid 唯一 */ } }
  rmW2()
  mkdirSync(w2Dir, { recursive: true })
  writeFileSync(join(w2Dir, 'mcp-server.mjs'), '', 'utf8')
  writeFileSync(join(w2Dir, 'package.json'), `{"version":"${DEFAULT_ADAPTER_VERSION}"}`, 'utf8')
  try {
    const w2Calls = []
    const w2 = await mount({ telemetry: true, adapterDir: w2Dir, cbmPath: fakeExe },
      makeStubProxy(w2Calls, { project: `stub-${process.pid}-w2`, warmSlowMs: 60 }), { procTable: '' })
    await w2.tools.get('code_setup').execute({}, withSignal(REPO)) // 点火：慢预热在后台跑
    const w2Mid = await w2.tools.get('code_setup').execute({}, withSignal(REPO))
    await new Promise((r) => setTimeout(r, 300)) // 等真实 settle（stub 60ms）
    const w2Report = await w2.tools.get('code_setup').execute({}, withSignal(REPO))
    const w2Warm = readFileSync(join(w2Dir, 'telemetry.log'), 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter((l) => l?.event === 'cbm-warm').pop()
    record('W 预热按真实 settle 落账：慢一发完成后 warm=ok 且遥测带 ok+ms（v0.13.2，旧 race 无 ms 必挂）',
      /warm=(ok|pending)/.test(w2Mid) && /warm=ok/.test(w2Report) && w2Warm?.ok === true && typeof w2Warm?.ms === 'number' && w2Warm.ms >= 40,
      `点火中=${/warm=(\w+)/.exec(w2Mid)?.[1]} 落账=${/warm=(\w+)/.exec(w2Report)?.[1]} 行=${JSON.stringify(w2Warm ?? null).slice(0, 120)}`)
  } finally { rmW2() }
  const wn = await mount({ enforce: 'off', dirtyTracking: false, telemetry: false },
    makeStubProxy([], { project: `stub-${process.pid}-nowhere`, root: 'C:/nowhere-else' }))
  await wn.tools.get('code_setup').execute({}, withSignal(REPO))
  let wnErr = '(未抛错)'
  try { await wn.tools.get('code_find').execute({ query: 'stubSymbol' }, { agent: fakeAgent(`sess-${process.pid}-nowhere`, REPO), signal: sig() }) } catch (error) { wnErr = String(error?.message ?? error) }
  record('W 表里真没有时报"项目表里没有"并指向 code_index', /项目表里没有/.test(wnErr) && /code_index/.test(wnErr), wnErr.slice(0, 110))
  const wf = await mount({ enforce: 'off', dirtyTracking: false, telemetry: false },
    makeStubProxy([], { project: `stub-${process.pid}-fail`, listError: true }))
  await wf.tools.get('code_setup').execute({}, withSignal(REPO))
  let wfErr = '(未抛错)'
  try { await wf.tools.get('code_find').execute({ query: 'stubSymbol' }, { agent: fakeAgent(`sess-${process.pid}-fail`, REPO), signal: sig() }) } catch (error) { wfErr = String(error?.message ?? error) }
  record('W 查询失败时报"查询失败"并带出代理原文（冷启动不再谎称没索引）', /查询失败/.test(wfErr) && /MCP server not running/.test(wfErr), wfErr.slice(0, 130))

  // ── 臂 X：v0.12.0 进程轴（清单写了 ≠ 活进程加载了）+ restart-adapter ────────
  // 事故原型：宿主开机拉起 adapter 时 cbm.json 还没出生 → 活进程 0-server，
  // 引擎装好后也不自愈；code_setup 只看盘报"就绪"，warm=ok 跟着撒谎。契约：
  // ① 报表有进程轴（fresh/stale/no-process 三判词，stale 指路 restart-adapter）；
  // ② restart-action 杀进程等新进程复活（监督器重拉），杀的是枚举到的那批 pid；
  // ③ not-found 错误文本（以 Tool 开头，旧嗅探放过当成功）判失败并指路；
  // ④ stats 载荷带 adapter 轴。进程枚举走 makeCtx 罐头（opts.procTable），绝不真起 powershell。
  const procLine = (pid, ageMs) => {
    if (process.platform === 'win32') return `${pid}|${new Date(Date.now() - ageMs).toISOString()}`
    const s = Math.max(1, Math.floor(ageMs / 1000))
    const pad = (n) => String(n).padStart(2, '0')
    const et = s >= 86400
      ? `${Math.floor(s / 86400)}-${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
      : `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s % 60))}:${pad(s % 60)}`
    return `${String(pid).padStart(6)} ${et} node /tmp/vendor/mcp-adapter/node_modules/@njuptlzf/mcp-adapter/mcp-server.mjs --config /tmp/vendor/mcp-adapter/cbm.json`
  }
  const xWin = parseAdapterProcsWin(`7|${new Date(Date.parse('2020-01-01T00:00:00Z')).toISOString()}\n垃圾行\n`)
  record('X Windows 枚举解析：pid|ISO 提取，垃圾行跳过',
    xWin?.length === 1 && xWin[0].pid === 7 && xWin[0].startMs === Date.parse('2020-01-01T00:00:00Z'), JSON.stringify(xWin))
  const xPosix = parseAdapterProcsPosix('  12 01:23:45 node /a/mcp-server.mjs --config /a/cbm.json\n  13 00:00:10 node /a/mcp-server.mjs --config /a/other.json\n', 1_000_000_000_000)
  record('X POSIX 枚举解析：etime 换算启动时刻，非 cbm.json 进程滤掉',
    xPosix?.length === 1 && xPosix[0].pid === 12 && xPosix[0].startMs === 1_000_000_000_000 - 5_025_000, JSON.stringify(xPosix))
  const xStale = await mount({ telemetry: false }, null, { procTable: () => procLine(41001, 10 * 60 * 1000) })
  const xStaleReport = await xStale.tools.get('code_setup').execute({}, withSignal(REPO))
  record('X 清单新于活进程 ⇒ 报表进程轴报 stale 并指路 restart-adapter',
    /适配层进程: ⚠ stale/.test(xStaleReport) && /restart-adapter/.test(xStaleReport),
    /适配层进程:.*$/m.exec(xStaleReport)?.[0]?.slice(0, 150) ?? '(没有适配层进程行)')
  const xFresh = await mount({ telemetry: false }, null, { procTable: () => procLine(41002, 0) })
  const xFreshReport = await xFresh.tools.get('code_setup').execute({}, withSignal(REPO))
  record('X 进程在清单之后启动 ⇒ fresh（不吓唬人）', /适配层进程: fresh/.test(xFreshReport),
    /适配层进程:.*$/m.exec(xFreshReport)?.[0]?.slice(0, 100) ?? '(没有适配层进程行)')
  const xNone = await mount({ telemetry: false }, null, { procTable: '' })
  const xNoneReport = await xNone.tools.get('code_setup').execute({}, withSignal(REPO))
  record('X 没有在跑的进程 ⇒ 报 no-process（宿主未起不算 stale）', /适配层进程: ⚠ 没有在跑的 adapter 进程/.test(xNoneReport),
    /适配层进程:.*$/m.exec(xNoneReport)?.[0]?.slice(0, 100) ?? '(没有适配层进程行)')
  const killFile = join(tmpdir(), `cbm-kill-${process.pid}-x.txt`)
  rmSync(killFile, { force: true })
  process.env.DSH_CBM_KILL_STUB_FILE = killFile
  try {
    // procTable 以"杀没杀过"为轴换答案：枚举次数多一发少一发都不影响结论
    // （后台 bootstrap 也会枚举一次，纯计数器会被它错位）。
    const xR = await mount({ telemetry: true }, null, { procTable: () => existsSync(killFile) ? procLine(42002, 0) : procLine(41001, 10 * 60 * 1000) })
    await xR.tools.get('code_setup').execute({}, withSignal(REPO)) // 先走一次常规 bootstrap：进程轴应为 stale
    const xRestart = await xR.tools.get('code_setup').execute({ action: 'restart-adapter' }, withSignal(REPO))
    const killed = existsSync(killFile) ? readFileSync(killFile, 'utf8') : '(没写杀进程)'
    record('X restart-adapter：杀掉老 pid、等到新进程、报表转 fresh',
      /已重启适配层/.test(xRestart) && /41001/.test(killed) && /42002/.test(xRestart) && /适配层进程: fresh/.test(xRestart),
      `${xRestart.split('\n')[0]?.slice(0, 90)} | killed=${killed.trim()}`)
    record('X restart-adapter 记遥测计数（restart-adapter=1）', /restart-adapter=1/.test(xRestart),
      /遥测计数.*$/m.exec(xRestart)?.[0]?.slice(0, 120) ?? '(没有遥测计数行)')
  } finally {
    delete process.env.DSH_CBM_KILL_STUB_FILE
    rmSync(killFile, { force: true })
  }
  const xnf = await mount({ enforce: 'off', dirtyTracking: false, telemetry: false },
    makeStubProxy([], { project: `stub-${process.pid}-nf`, listNotFound: true }))
  await xnf.tools.get('code_setup').execute({}, withSignal(REPO))
  let xnfErr = '(未抛错)'
  try { await xnf.tools.get('code_find').execute({ query: 'stubSymbol' }, { agent: fakeAgent(`sess-${process.pid}-nf`, REPO), signal: sig() }) } catch (error) { xnfErr = String(error?.message ?? error) }
  record('X not-found 签名判失败（warm 不再睁眼说 ok），错误文本指路 restart-adapter',
    /不在活进程里/.test(xnfErr) && /restart-adapter/.test(xnfErr), xnfErr.slice(0, 150))
  const xStatsRef = mkVolRef('')
  const xStats = await mount({ telemetry: true, stats: xStatsRef }, null, { procTable: () => procLine(41001, 10 * 60 * 1000) })
  await xStats.tools.get('code_setup').execute({}, withSignal(REPO))
  let xStatsJson = null
  try { xStatsJson = JSON.parse(String(xStatsRef.get())) } catch { /* 下一条断言报 */ }
  record('X stats 载荷带 adapter 进程轴（设置页 stale 行的数据源）',
    xStatsJson?.adapter === 'stale', String(xStatsRef.get()).slice(0, 140))

  // ── 臂 U：v0.13.1 报表面三处（冻结 pid 行 / kill ESRCH 作废 / telemetry pid 归因）──
  // 事故原型（2026-10-14 验收）：监督器级联换了进程，本会话 code_setup 9 分钟仍报
  // 09:46 的开机快照——adapterFreshness 只在 bootstrap await、state.ok 后没人重量。
  // 契约：① code_setup 自带量取（TTL 压 0 后连打两报 pid 跟着现场变）；
  // ② 快照过期时报表标年龄；③ kill ESRCH 容错且作废在 kill 前；
  // ④ 计数读侧 lift（别的实例写的大值本报表可见）；⑤ telemetry 行带发出 pid。
  // 全部走 makeCtx 罐头枚举 + 临时目录，绝不真起 powershell、绝不碰真机 vendor。
  const pidOfLine = (t) => Number(/pid=(\d+)/.exec(t)?.[1] ?? -1)

  // U1：TTL=0 ⇒ 每次 code_setup 都重量，枚举表按次序换 pid ⇒ 冻结不可能再发生
  process.env.DSH_CBM_FRESH_TTL_MS = '0'
  try {
    let uSeq = 0
    const u1 = await mount({ telemetry: false }, null, { procTable: () => procLine(41100 + (++uSeq), 0) })
    const u1a = await u1.tools.get('code_setup').execute({}, withSignal(REPO))
    const u1b = await u1.tools.get('code_setup').execute({}, withSignal(REPO))
    const ua = pidOfLine(u1a); const ub = pidOfLine(u1b)
    record('U code_setup 自带量取：TTL=0 时连打两报 pid 跟着现枚举变（不再复用开机快照）',
      ua > 0 && ub > ua, `第一报 pid=${ua} → 第二报 pid=${ub}`)
  } finally { delete process.env.DSH_CBM_FRESH_TTL_MS }

  // U2：快照过期 ⇒ 报表标年龄（默认 TTL 命中缓存时能看出"这是 2 秒前量的"）
  process.env.DSH_CBM_FRESH_TTL_MS = '120000' // 拉长窗口，第二次报必走缓存
  try {
    let uSeq2 = 0
    const u2 = await mount({ telemetry: false }, null, { procTable: () => procLine(41200 + (++uSeq2), 0) })
    await u2.tools.get('code_setup').execute({}, withSignal(REPO)) // 量取一次，f.at≈现在
    await new Promise((r) => setTimeout(r, 2200)) // 让快照"过期"到 ≥2s
    const u2b = await u2.tools.get('code_setup').execute({}, withSignal(REPO))
    record('U 进程轴快照 ≥2s 时报表标"量取 Ns 前"（缓存结论带年龄，不再像实时）',
      /量取 \d+s 前/.test(u2b), /适配层进程:.*$/m.exec(u2b)?.[0]?.slice(0, 130) ?? '(没有适配层进程行)')
  } finally { delete process.env.DSH_CBM_FRESH_TTL_MS }

  // U3：kill ESRCH 容错 + 作废在 kill 前（监督器级联重启时进程枚举到 kill 之间已死）
  const killFileU = join(tmpdir(), `cbm-kill-${process.pid}-u.txt`)
  rmSync(killFileU, { force: true })
  process.env.DSH_CBM_KILL_STUB_FILE = killFileU
  process.env.DSH_CBM_KILL_ESRCH_PIDS = '41301'
  try {
    // 第一次枚举两个老 pid（其中 41301 kill 时抛 ESRCH），杀掉后换一个新 pid 复活
    let u3n = 0
    const u3 = await mount({ telemetry: false }, null, { procTable: () => {
      u3n += 1
      return u3n === 1 ? procLine(41301, 0)
        : existsSync(killFileU) && u3n > 2 ? procLine(41302, 0)
          : procLine(41301, 0)
    } })
    let u3err = ''
    let u3out = ''
    try { u3out = await u3.tools.get('code_setup').execute({ action: 'restart-adapter' }, withSignal(REPO)) }
    catch (e) { u3err = String(e?.message ?? e) }
    record('U kill 撞 ESRCH 不崩：restart-adapter 吞掉已死进程、照常作废快照等新进程',
      !u3err && /清单加载|已重启|没有在跑|fresh|no-process|stale/.test(u3out) && !/ESRCH/.test(u3out),
      u3err ? `抛错：${u3err.slice(0, 120)}` : u3out.split('\n')[0]?.slice(0, 120) ?? '(空)')
  } finally {
    delete process.env.DSH_CBM_KILL_ESRCH_PIDS
    delete process.env.DSH_CBM_KILL_STUB_FILE
    rmSync(killFileU, { force: true })
  }

  // U4：计数读侧 lift——别的实例写了更大值，本实例报表读之前先捞回来
  const countsU = join(tmpdir(), `cbm-counts-${process.pid}-u.json`)
  rmSync(countsU, { force: true })
  writeFileSync(countsU, JSON.stringify({ 'lift-probe-key': 1 }), 'utf8')
  try {
    const u4 = await mount({ telemetry: true }, null, null, countsU) // 播种 1
    await u4.tools.get('code_setup').execute({}, withSignal(REPO))
    writeFileSync(countsU, JSON.stringify({ 'lift-probe-key': 4242 }), 'utf8') // 外部实例抬到 4242
    const u4b = await u4.tools.get('code_setup').execute({}, withSignal(REPO))
    record('U 计数读侧 lift：外部写的大值在 code_setup 报表可见（「跨重启累计」读侧兑现）',
      /lift-probe-key=4242/.test(u4b), /遥测计数.*$/m.exec(u4b)?.[0]?.slice(0, 160) ?? '(没有计数行)')
  } finally { rmSync(countsU, { force: true }) }

  // U5：telemetry 日志行带发出进程 pid（多宿主并跑才能对账归因）
  const u5Dir = join(tmpdir(), `cbm-u5-${process.pid}-${profile}`)
  // 尽力清理：mount 无 dispose 接口、后台收尾写句柄与删除真竞态（重试等不到）；
  // 目录名带 pid 唯一，删不掉就静默留给系统 temp 回收
  const rmU5 = () => { try { rmSync(u5Dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }) } catch { /* 见上 */ } }
  rmU5()
  mkdirSync(u5Dir, { recursive: true })
  writeFileSync(join(u5Dir, 'mcp-server.mjs'), '', 'utf8')
  writeFileSync(join(u5Dir, 'package.json'), `{"version":"${DEFAULT_ADAPTER_VERSION}"}`, 'utf8')
  try {
    const u5 = await mount({ telemetry: true, adapterDir: u5Dir, cbmPath: fakeExe }, null, { procTable: '' })
    await u5.tools.get('code_setup').execute({ action: 'restart-adapter' }, withSignal(REPO)) // 必发一条遥测
    const u5line = JSON.parse(readFileSync(join(u5Dir, 'telemetry.log'), 'utf8').trim().split('\n').filter(Boolean).pop())
    record('U telemetry 日志行带发出 pid=本进程（log 与计数对不上账时能归因）',
      u5line.pid === process.pid && u5line.event === 'restart-adapter', JSON.stringify(u5line).slice(0, 150))
  } finally { rmU5() }

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