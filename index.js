/**
 * dsh-codebase-memory —— 把 codebase-memory-mcp 接进 DSH 的最小适配层。
 *
 * 这个插件只做三件事，索引引擎与 token 压缩都不归它：
 *   ① codebase-memory-mcp          索引引擎（外部二进制，手动安装）
 *   ② @njuptlzf/mcp-adapter        token 压缩层（本插件自举，钉死版本）
 *   ③ @deepseek-ai/dsh-mcp-client  MCP 桥（cordis.patch.yml 里的一行）
 *   ④ 本插件                       依赖自举 + 把会话工作区钉死 + 告诉模型怎么用
 *
 * 三条硬规矩：
 *   - **boot 绝不 throw**。依赖缺失只记录状态；boot 抛错会让整个 DSH profile
 *     起不来，爆炸半径太大。前提检查落在工具执行里（"前提不成立即 throw" 落
 *     在调用点，不落在启动点）。
 *   - **不自己写下载器**。包用 npm、二进制用官方 install.ps1，都自带校验与解包。
 *   - **工作区必须显式绑定**。DSH 是多会话宿主，而一个 MCP server 进程只有一个
 *     cwd，所以 cbm 的 auto_index 无法按会话工作区工作；repo_path 只能由本插件
 *     从 exec.agent.session.header.cwd 取，不能交给模型填。
 *
 * Windows 坑都在代码里显式绕开了，见各自注释：.cmd shim、npm 入口位置、
 * 二进制绝对路径、stderr 噪声。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-codebase-memory'
export const inject = ['tools', 'subprocess', 'systemPrompt']

/** 钉死的压缩层版本；升级只改这里（也是唯一升级入口）。 */
const DEFAULT_ADAPTER_VERSION = '2.29.0-0.0.4'
const ADAPTER_PKG = '@njuptlzf/mcp-adapter'
const CBM_EXE = 'codebase-memory-mcp.exe'
const BOOTSTRAP_MODES = ['blocking', 'background', 'manual']
const INDEX_MODES = ['full', 'moderate', 'fast', 'cross-repo-intelligence']
const PROXY_TOOL = 'mcp__cbm__mcp'

/**
 * 从 adapter 的工具面里摘掉两个：
 *   - index_repository：避免与 code_index 形成两条索引路径（模型会传错 repo_path）
 *   - delete_project：破坏性操作，不该由模型隐式触发
 * 其余一律保留——代理模式下"多留一个工具"几乎不花 token（元数据缓存着，
 * 只有 search/describe 才展示），所以收窄的动机是冲突与安全，不是省 token。
 */
const EXCLUDE_TOOLS = ['index_repository', 'delete_project']

export const Config = z.object({
  bootstrap: z.string().default('background'),
  adapterVersion: z.string().default(DEFAULT_ADAPTER_VERSION),
  adapterDir: z.string().default(''),
  cbmPath: z.string().default(''),
})

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')

/** 归一化配置；非法值不 throw（boot 不许抛），只降级并记进 cfg.notes。 */
function normalize(config = {}) {
  const cfg = {
    bootstrap: config.bootstrap ?? 'background',
    adapterVersion: config.adapterVersion || DEFAULT_ADAPTER_VERSION,
    adapterDir: config.adapterDir || join(dshHome(), 'vendor', 'mcp-adapter'),
    cbmPath: config.cbmPath || '',
    notes: [],
  }
  if (!BOOTSTRAP_MODES.includes(cfg.bootstrap)) {
    cfg.notes.push(`bootstrap="${cfg.bootstrap}" 非法，已按 background 处理（可选：${BOOTSTRAP_MODES.join('|')}）`)
    cfg.bootstrap = 'background'
  }
  cfg.adapterMjs = join(cfg.adapterDir, 'node_modules', '@njuptlzf', 'mcp-adapter', 'mcp-server.mjs')
  cfg.adapterConfig = join(cfg.adapterDir, 'cbm.json')
  return cfg
}

/**
 * 找 npm 的 JS 入口而不是 PATH 上的 npm.cmd / npm.ps1：
 * 我们从 host 进程直接 spawn，绕开 .cmd 是必须的（Node 在 Windows 上默认拒绝
 * 无 shell 启动 .cmd）。DSH 自带 node 旁边没有 npm，所以要按候选探测。
 */
function npmCliEntry() {
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(process.env.APPDATA || '', 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  return candidates.find((p) => p && existsSync(p)) ?? ''
}

/** 受控子进程：显式 argv、绑定输出上限、可取消。 */
async function run(ctx, argv, opts = {}) {
  const handle = ctx.subprocess.spawn({
    argv,
    // cwd 是必填：subprocess-local 的 targetEnvironment 会执行 spec.cwd.includes('\0')，
    // 传 undefined 直接 TypeError（这个 bug 就是这样漏过第一版验收的）。
    // env 同样必须按对象处理。
    cwd: opts.cwd ?? process.cwd(),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: opts.maxBytes ?? 1024 * 1024 },
      stderr: { maxBytes: 256 * 1024 },
    },
    graceMs: opts.graceMs ?? 10000,
    env: opts.env ?? {},
    signal: opts.signal,
  })
  const { exitCode } = await handle.done
  // readFrom 返回 SubprocessOutputRead（{ text, nextOffset, lossy }），不是字符串：
  // String() 一个对象得到 "[object Object]"，于是 code_index 永远报"输出不是 JSON"。
  return {
    exitCode,
    stdout: handle.collected?.stdout?.readFrom(0)?.text ?? '',
    stderr: handle.collected?.stderr?.readFrom(0)?.text ?? '',
  }
}

/** 幂等地把钉死版本的压缩层装进 vendor 目录。 */
async function ensureAdapter(ctx, cfg, state, signal) {
  if (existsSync(cfg.adapterMjs)) {
    state.adapter = 'ready'
    return
  }
  if (cfg.bootstrap === 'manual') {
    state.adapter = 'missing'
    push(state, 'bootstrap=manual，未自动下载压缩层')
    return
  }
  const npm = npmCliEntry()
  if (!npm) {
    state.adapter = 'missing'
    push(state, `找不到 npm-cli.js，无法自举；请手动安装 ${ADAPTER_PKG}`)
    return
  }
  mkdirSync(cfg.adapterDir, { recursive: true })
  const r = await run(ctx, [
    process.execPath, npm, 'install',
    '--prefix', cfg.adapterDir,
    '--no-audit', '--no-fund', '--loglevel=error',
    `${ADAPTER_PKG}@${cfg.adapterVersion}`,
  ], { cwd: cfg.adapterDir, maxBytes: 512 * 1024, signal })
  if (!existsSync(cfg.adapterMjs)) {
    state.adapter = 'missing'
    push(state, `npm install 退出码 ${r.exitCode}：${(r.stderr || r.stdout).trim().slice(-400)}`)
    return
  }
  state.adapter = 'ready'
}

/** 探测索引引擎。二进制不自动下载：可执行文件的安全水位高于包。 */
async function resolveCbm(ctx, cfg, state) {
  const candidates = [
    cfg.cbmPath,
    join(process.env.LOCALAPPDATA || '', 'Programs', 'codebase-memory-mcp', CBM_EXE),
    join(dshHome(), 'vendor', 'codebase-memory-mcp', 'bin', CBM_EXE),
  ].filter(Boolean)
  const hit = candidates.find((p) => existsSync(p))
  if (hit) {
    state.cbmPath = hit
    state.cbm = 'ready'
    return
  }
  try {
    const resolved = await ctx.subprocess.resolveExecutable('codebase-memory-mcp')
    if (resolved) {
      state.cbmPath = resolved
      state.cbm = 'ready'
      return
    }
  } catch {
    // 不在 PATH 上：落到下面统一报缺失
  }
  state.cbm = 'missing'
}

/** 写 adapter 的服务器清单。二进制用绝对 .exe，绕开 .cmd shim。 */
function writeAdapterConfig(cfg, state) {
  const doc = {
    mcpServers: {
      cbm: {
        command: state.cbmPath,
        args: [],
        // 二进制默认往 stderr 写 warn，会污染诊断；none 让它安静。
        env: { CBM_LOG_LEVEL: 'none' },
        lifecycle: 'lazy',
        // cbm 不暴露 MCP resources；开着只会多一个常驻工具定义（实测 3→2 个工具）。
        exposeResources: false,
        excludeTools: EXCLUDE_TOOLS,
      },
    },
  }
  mkdirSync(cfg.adapterDir, { recursive: true })
  writeFileSync(cfg.adapterConfig, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  state.configPath = cfg.adapterConfig
}

const push = (state, note) => { if (note) state.notes.push(note) }

/** 幂等自举：成功过一次就不再重复；未就绪时每次都重试（补装后无需重启）。 */
async function bootstrap(ctx, cfg, state, signal, { force = false } = {}) {
  if (state.ok && !force) return state
  await ensureAdapter(ctx, cfg, state, signal)
  await resolveCbm(ctx, cfg, state)
  if (state.cbm === 'ready') {
    const r = await run(ctx, [state.cbmPath, '--version'], { maxBytes: 64 * 1024, signal })
    state.cbmVersion = (r.stdout || r.stderr).trim().split('\n')[0]
    writeAdapterConfig(cfg, state)
  }
  state.ok = state.adapter === 'ready' && state.cbm === 'ready'
  return state
}

/** 缺 cbm 时给人的可复制补救步骤（也是断言失败时的证据）。 */
function cbmInstallHint(state) {
  return [
    'codebase-memory-mcp 未安装（二进制不自动下载：可执行文件的安全水位高于包）。',
    '一次性安装（官方脚本自带 checksums.txt 校验）：',
    '  irm https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1 -OutFile install.ps1',
    '  Unblock-File .\\install.ps1; .\\install.ps1 --skip-config',
    '已下载过脚本时也可直接跑：' + join(dshHome(), 'vendor', 'codebase-memory-mcp', 'install.ps1') + ' --skip-config',
  ].join('\n')
}

function report(cfg, state) {
  const lines = [
    `status: ${state.ok ? 'OK' : 'NOT READY'}`,
    `压缩层(②): ${state.adapter}  ${cfg.adapterMjs}`,
    `索引引擎(①): ${state.cbm}  ${state.cbmPath || '(未找到)'}${state.cbmVersion ? '  ' + state.cbmVersion : ''}`,
    `清单(⑤): ${state.configPath ?? '(未写)'}  exclude=${JSON.stringify(EXCLUDE_TOOLS)}`,
    `代理工具: ${PROXY_TOOL}  bootstrap=${cfg.bootstrap}  adapterVersion=${cfg.adapterVersion}`,
  ]
  if (cfg.notes.length) lines.push('notes: ' + cfg.notes.join(' / '))
  if (state.notes.length) lines.push('notes: ' + state.notes.join(' / '))
  if (state.lastError) lines.push('error: ' + state.lastError)
  if (state.cbm !== 'ready') lines.push('', cbmInstallHint(state))
  return lines.join('\n')
}

/** 给模型的使用说明；只声明真实可用的事，链路没就绪时直接说没就绪。 */
function usageSection(state) {
  if (!state.ok) {
    return [
      '本工作区的 codebase-memory 代码索引**尚未就绪**。',
      '先调用 `code_setup` 查看缺什么，按它给出的命令补齐后再用索引检索。',
    ].join('\n')
  }
  return [
    '本工作区已接入 codebase-memory 代码索引（经 mcp-adapter 压成单个代理工具）。',
    '',
    '索引：调用 `code_index`——repo_path 已由插件绑定到本会话工作区，不要自己传路径。',
    '它返回的 `project` 是后续所有检索要用的项目名。',
    '',
    `检索：都用代理工具 \`${PROXY_TOOL}\`，arguments 是 JSON 对象：`,
    '- 发现工具：{"server":"cbm"} 列出全部；{"search":"关键词"} 搜；{"describe":"cbm_search_graph"} 看参数',
    '- 找符号：{"tool":"cbm_search_graph","args":"{\\"project\\":\\"<project>\\",\\"query\\":\\"关键词\\"}"}',
    '- 读源码：{"tool":"cbm_get_code_snippet","args":"{\\"project\\":\\"<project>\\",\\"qualified_name\\":\\"<qn>\\"}"}',
    '- 追调用链：{"tool":"cbm_trace_path","args":"{\\"project\\":\\"<project>\\",\\"function_name\\":\\"...\\"}"}',
    '',
    'graph 优先：先 search_graph 定位符号，再 get_code_snippet 只读那一段，比逐文件',
    'grep/read 省一个数量级 token。改完代码后用 code_index 刷新（增量）。',
    '不要用 cbm_index_repository（已从工具面移除）：索引一律走 `code_index`。',
  ].join('\n')
}

/**
 * @param ctx - host 上下文（tools + subprocess + systemPrompt）。
 * @param config - 见 Config。
 */
export async function apply(ctx, config) {
  const cfg = normalize(config)
  const state = { adapter: 'unknown', cbm: 'unknown', ok: false, notes: [], lastError: '' }

  const ac = new AbortController()
  ctx.effect(() => () => ac.abort(), 'dsh-codebase-memory.abort')

  // 后台自举：绝不 await 成 boot 失败；失败只落在 state.lastError。
  const work = Promise.resolve()
    .then(() => bootstrap(ctx, cfg, state, ac.signal))
    .catch((error) => {
      state.lastError = String(error?.message ?? error)
      state.ok = false
      return state
    })
  if (cfg.bootstrap === 'blocking') await work

  // 每步渲染，所以链路状态变化（自举完成 / 补装二进制）会自动反映，不用重启。
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'codebase-memory',
    order: 850,
    text: () => usageSection(state),
  }), 'dsh-codebase-memory.usage-section')

  ctx.tools.register(defineTool({
    name: 'code_setup',
    description: 'Check and repair the codebase-memory code-index chain for this DSH host: the pinned mcp-adapter token-compression layer (auto-bootstrapped) and the codebase-memory-mcp binary (manual install). Reports exact paths, versions and a copy-pasteable install command when something is missing. Only side effect is installing the pinned adapter package when it is absent.',
    parameters: {},
    output: {
      // 顶层标量 schema 不接受 required（value schema DSL 只支持 properties.* 里写）。
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      await bootstrap(ctx, cfg, state, ac.signal).catch((error) => {
        state.lastError = String(error?.message ?? error)
        state.ok = false
      })
      return report(cfg, state)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'code_index',
    description: 'Index or refresh THIS session workspace into the codebase-memory knowledge graph, then return the graph `project` name required by the search tools. The repository path is bound to the session workspace by the plugin and is deliberately not a parameter. Incremental when the project is already indexed. Run it before searching a repository for the first time, and again after substantial edits.',
    parameters: {
      mode: {
        type: 'string',
        description: `Index mode (default full). One of: ${INDEX_MODES.join(' | ')}. full/moderate add semantic search.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: { type: 'string', required: true },
          status: { type: 'string', required: true },
          nodes: { type: 'integer', required: true },
          edges: { type: 'integer', required: true },
          root: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{
          type: 'text',
          text: `已索引工作区 ${value.root}\nproject=${value.project}  status=${value.status}  nodes=${value.nodes}  edges=${value.edges}\n检索时请带上 project="${value.project}"。`,
        }]
      },
    },
    async execute(args, exec) {
      // R1 的落点：工作区只能来自会话本身。
      const cwd = exec.agent?.session?.header?.cwd
      if (!cwd) throw new Error('code_index 需要会话工作区：exec.agent.session.header.cwd 为空')

      await bootstrap(ctx, cfg, state, exec.signal).catch((error) => {
        state.lastError = String(error?.message ?? error)
        state.ok = false
      })

      // 前提不成立即 throw——不静默降级成 grep。
      if (state.adapter !== 'ready') throw new Error('压缩层(②)未就绪，索引与检索都无法工作：\n' + report(cfg, state))
      if (state.cbm !== 'ready') throw new Error(cbmInstallHint(state))
      if (args.mode !== undefined && !INDEX_MODES.includes(args.mode)) {
        throw new Error(`mode 必须是 ${INDEX_MODES.join('|')} 之一，收到 ${JSON.stringify(args.mode)}`)
      }

      const argv = [state.cbmPath, 'cli', 'index_repository', '--repo-path', cwd]
      if (args.mode) argv.push('--mode', args.mode)
      // index_repository 不支持 --format：它的 stdout 本来就是 JSON。
      const r = await run(ctx, argv, {
        cwd,
        maxBytes: 1024 * 1024,
        graceMs: 20000,
        signal: exec.signal,
      })
      if (r.exitCode !== 0) {
        throw new Error(`index_repository 退出码 ${r.exitCode}：${(r.stderr || r.stdout).trim().slice(-600)}`)
      }
      let info
      try {
        info = JSON.parse(r.stdout)
      } catch {
        throw new Error(`index_repository 输出不是 JSON：${r.stdout.slice(0, 400)}`)
      }
      return {
        project: info.project,
        status: info.status ?? 'unknown',
        nodes: info.nodes ?? 0,
        edges: info.edges ?? 0,
        root: cwd,
      }
    },
  }))
}