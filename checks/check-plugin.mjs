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
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
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
function makeCtx(tools, sections) {
  return {
    effect: (fn) => fn(),
    on: () => {},
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
  const { apply, name, inject } = mod
  if (name !== 'dsh-codebase-memory') throw new Error(`unexpected plugin name: ${name}`)
  record('装载', true, `name=${name}  inject=${inject.join(',')}`)

  const mount = async (config) => {
    const tools = new Map()
    const sections = []
    await apply(makeCtx(tools, sections), config)
    if (!tools.has('code_index') || !tools.has('code_setup')) {
      throw new Error(`期望注册 code_index + code_setup，实际 ${[...tools.keys()].join(',')}`)
    }
    return { tools, sections }
  }

  // ── 臂 A：链路就绪 ──────────────────────────────────────────────────────────
  const a = await mount({})
  const setup = await a.tools.get('code_setup').execute({}, withSignal(REPO))
  record('A 链路就绪', /status: OK/.test(setup), setup.split('\n')[0])
  record('A prompt 段就位', a.sections.some((s) => s.name === 'codebase-memory' && s.order === 850))
  record('A prompt 段已就绪文案', /code_index/.test(a.sections.at(-1).text()))

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