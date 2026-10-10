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
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-codebase-memory'
export const inject = ['tools', 'subprocess', 'systemPrompt']

/** 钉死的压缩层版本；升级只改这里（也是唯一升级入口）。 */
const DEFAULT_ADAPTER_VERSION = '2.29.0-0.0.4'
const ADAPTER_PKG = '@njuptlzf/mcp-adapter'
const CBM_EXE = 'codebase-memory-mcp.exe'
const BOOTSTRAP_MODES = ['blocking', 'background', 'manual']
const INDEX_MODES = ['full', 'moderate', 'fast', 'cross-repo-intelligence']
const PROXY_TOOL = 'mcp__cbm__mcp'

/** 触发层（docs/design-v2.md）的常量。跨平台：内置工具是裸名小写（官方 tool-fs-search README 与实装一致）。 */
const ENFORCE_MODES = ['off', 'deny-once', 'deny', 'replace']
/** 语义检索层（zvec-grep）的 MCP 工具集：agent 只暴露 zvec_grep_search；rg/index/status 走 CLI 与我们的后台补刷。 */
const ZG_TOOLSETS = ['agent', 'full']
/** 会写文件的内置工具（官方 tool-fs README：路径字段统一 snake_case `file_path`）。 */
const WRITE_TOOLS = ['write', 'edit']
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|c|h|cc|cpp|hpp|cs|rb|php|swift|scala|vue|svelte|sql|sh|bash|ps1)$/i
const NON_CODE_PATH = /\.(json|ya?ml|toml|ini|env|lock|md|txt|csv|log|svg|png|pdf)$/i
/** 注入文本里片段的上限：按码点截断，绝不按 UTF-16 单元（dsh-mneme #334 的教训：切进代理对 ⇒ 每个请求 400）。 */
const HINT_MAX_CODEPOINTS = 900
const SNIPPET_MAX_CODEPOINTS = 2000

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
  autoIndex: z.boolean().default(true),
  sessionRefresh: z.boolean().default(true),
  // ── 触发层（docs/design-v2.md 4.8）：每个杠杆独立开关，全部可回滚 ──────────
  wrapperTools: z.boolean().default(true),
  // enforce / interceptTools / interceptBudgetMs / contextHint / telemetry /
  // dirtyTracking / stats 标了 volatile：宿主的设置表单只暴露 volatile 字段
  // （dsh-settings 写非 volatile 字段直接 throw），并且改动由 loader 推进同一个
  // 引用、**不用重启**就生效。标 volatile 的前提是**决策点现读**（normalize 里挂
  // getter，钩子每次调用重读）——注册期快照的字段标了就是让页面说谎，所以
  // wrapperTools（tools.register 只在 apply 跑一次，没有反注册）与 zg*（清单是
  // bootstrap 写的）等仍留在文件级。其余普通字段改了要重启。
  enforce: z.string().default('off').volatile(),
  interceptTools: z.string().default('grep,glob').volatile(),
  interceptBudgetMs: z.number().default(2500).volatile(),
  contextHint: z.boolean().default(true).volatile(),
  telemetry: z.boolean().default(true).volatile(),
  // stats 是**插件→设置页**的读数通道，不是用户配置：pushStats 把计数推进这个引用，
  // 宿主 describe() 用 plainConfig 读同一引用（dsh-settings/lib/index.js:98,436），
  // 浏览器收到转发的 settings/document-updated 后重读。写成 JSON 字符串是为了让
  // zod 校验始终成立（volatileForm 也会带上它，但面板只读、不渲染输入框）。不落盘。
  stats: z.string().default('').volatile(),
  dirtyTracking: z.boolean().default(true).volatile(),
  dirtyRefreshCooldownSec: z.number().default(120),
  // ── 语义检索层（zvec-grep，可选，docs/design-v2.md 第 9 节）─────────────────
  // zgEnabled 有意不标 volatile：它决定 cbm.json 里有没有第二个 server，而清单是
  // bootstrap 写的、adapter 进程只在启动时读——热改不会生效，标了反而骗人。
  zgEnabled: z.boolean().default(false),
  zgToolset: z.string().default('agent'),
  zgVendorDir: z.string().default(''),
})

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')

/** 逗号分隔的名单（配置写字符串最省事，也避免 profile YAML 里数组的解析歧义）。 */
const csv = (s) => String(s ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)

/**
 * volatile 字段在运行时是宿主持有的**稳定引用**（loader 热更新时把新值推进同一个
 * 引用，见 cordis-plugin-loader 的 `_commitVolatile`），所以读它必须每次 `.get()`；
 * 普通字段（以及验收里直接传的裸值）原样返回。
 */
const live = (value) => (value && typeof value.get === 'function' ? value.get() : value)

/** 把 volatile 字段挂成 getter：读点永远拿到当前值，而不是 apply 时的快照。 */
const defineLive = (cfg, key, read) => Object.defineProperty(cfg, key, { get: read, enumerable: true, configurable: true })

/**
 * cosmokit 的 volatile 引用写符号。Symbol.for 走全局注册表，跨模块副本同键
 * （cosmokit lib/index.js:83,116 的设计），所以**不必把 cosmokit 声明成依赖**，
 * 拿引用对象上的这个方法就是宿主自己的写协议。引用被 Object.freeze，但 freeze
 * 挡不住调用闭包方法——loader 的 updateVolatile 同样是 target[write](...)。
 */
const VOL_WRITE = Symbol.for('cosmokit.volatile.write')
const isVolRef = (v) => !!v && typeof v === 'object' && typeof v.get === 'function' && VOL_WRITE in v

/** 读数推送的合并窗口（ms）：dirty-record 每次 write/edit 都会触发，必须节流 emit。 */
const STATS_PUSH_MS = 2000

/** 正整数配置（含 0 = 关闭）；非法值降级为默认并记 note，绝不 throw。 */
function positiveInt(key, raw, fallback, notes) {
  const n = typeof raw === 'number' ? Math.floor(raw) : Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n < 0) {
    notes.push(`${key}="${raw}" 非法，已按 ${fallback} 处理`)
    return fallback
  }
  return n
}

/** 布尔配置：字符串 'true'/'false' 也接受（profile YAML 里写成一行的情况）。 */
function boolOf(value, fallback, notes, key) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const s = String(value).toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
  notes.push(`${key}="${value}" 非法，已按 ${fallback} 处理`)
  return fallback
}

/** 归一化配置；非法值不 throw（boot 不许抛），只降级并记进 cfg.notes。 */
function normalize(config = {}) {
  const cfg = {
    bootstrap: config.bootstrap ?? 'background',
    adapterVersion: config.adapterVersion || DEFAULT_ADAPTER_VERSION,
    adapterDir: config.adapterDir || join(dshHome(), 'vendor', 'mcp-adapter'),
    cbmPath: config.cbmPath || '',
    autoIndex: config.autoIndex ?? true,
    sessionRefresh: config.sessionRefresh ?? true,
    notes: [],
  }
  if (!BOOTSTRAP_MODES.includes(cfg.bootstrap)) {
    cfg.notes.push(`bootstrap="${cfg.bootstrap}" 非法，已按 background 处理（可选：${BOOTSTRAP_MODES.join('|')}）`)
    cfg.bootstrap = 'background'
  }
  // 触发层
  cfg.wrapperTools = boolOf(config.wrapperTools, true, cfg.notes, 'wrapperTools')
  cfg.dirtyRefreshCooldownSec = positiveInt('dirtyRefreshCooldownSec', config.dirtyRefreshCooldownSec, 120, cfg.notes)
  // 语义检索层：非法值一律降级 + note，boot 不抛（与其余字段同一纪律）。
  cfg.zgEnabled = boolOf(config.zgEnabled, false, cfg.notes, 'zgEnabled')
  if (config.zgToolset !== undefined && config.zgToolset !== '' && !ZG_TOOLSETS.includes(config.zgToolset)) {
    cfg.notes.push(`zgToolset="${config.zgToolset}" 非法，已按 agent 处理（可选：${ZG_TOOLSETS.join('|')}）`)
  }
  cfg.zgToolset = ZG_TOOLSETS.includes(config.zgToolset) ? config.zgToolset : 'agent'
  cfg.zgVendorDir = config.zgVendorDir || join(dshHome(), 'vendor', 'zvec-grep')
  cfg.zgCli = join(cfg.zgVendorDir, 'node_modules', '@zvec', 'zvec-grep', 'dist', 'cli', 'index.js')
  // 设置页可写字段（enforce/interceptTools/budget/contextHint/telemetry/dirtyTracking）
  // 全部留成 getter 而不是快照：快照一次就等于"UI 里改了、钩子还在用旧值"。
  // 非法值只在归一化这一次记进 notes——getter 会被反复读，往里 push 会把 notes 灌满。
  const enforceRaw = live(config.enforce)
  if (enforceRaw !== undefined && !ENFORCE_MODES.includes(enforceRaw)) {
    cfg.notes.push(`enforce="${enforceRaw}" 非法，已按 off 处理（可选：${ENFORCE_MODES.join('|')}；advise 的事件注入已于 2026-10-08 撤回）`)
  }
  positiveInt('interceptBudgetMs', live(config.interceptBudgetMs), 2500, cfg.notes)
  boolOf(live(config.telemetry), true, cfg.notes, 'telemetry')
  boolOf(live(config.contextHint), true, cfg.notes, 'contextHint')
  boolOf(live(config.dirtyTracking), true, cfg.notes, 'dirtyTracking')
  defineLive(cfg, 'enforce', () => (ENFORCE_MODES.includes(live(config.enforce)) ? live(config.enforce) : 'off'))
  defineLive(cfg, 'interceptBudgetMs', () => positiveInt('interceptBudgetMs', live(config.interceptBudgetMs), 2500, []))
  defineLive(cfg, 'telemetry', () => boolOf(live(config.telemetry), true, [], 'telemetry'))
  // v0.9.0：这三个也上了设置页 ⇒ 同一纪律。interceptTools 是决策点现读的名单
  // （csv 对任何字符串都成立，非法只可能是"写错工具名"，那本来就是空名单语义）。
  defineLive(cfg, 'interceptTools', () => csv(live(config.interceptTools) || 'grep,glob'))
  defineLive(cfg, 'contextHint', () => boolOf(live(config.contextHint), true, [], 'contextHint'))
  defineLive(cfg, 'dirtyTracking', () => boolOf(live(config.dirtyTracking), true, [], 'dirtyTracking'))
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

/**
 * 语义检索层探测：只查 vendor 里的 CLI 在不在，**不自动安装**。
 * 与 ensureAdapter 的差别是有意的：装 zg 要拖 ~430MB 依赖 + 首次下载嵌入模型，
 * 那是用户的一次显式决定（`npm run install:zg`），后台 bootstrap 不许替用户花带宽。
 */
function resolveZg(cfg, state) {
  if (!cfg.zgEnabled) { state.zg = 'off' }
  else if (existsSync(cfg.zgCli)) { state.zg = 'ready' }
  else {
    state.zg = 'missing'
    push(state, `zgEnabled=true 但找不到 ${cfg.zgCli}——先跑 npm run install:zg`)
  }
  // 页面「检索两层」状态行消费这个字段：探测完立刻推一帧，别等下一个遥测事件。
  // 遥测关时一帧都不推——「关了就冻结」是 S 臂锁住的契约（页面与日志同一开关）。
  if (cfg.telemetry && state.pushStats) state.pushStats()
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
        // keep-alive：**启动即连接**（adapter 源码 init.ts:290-295 —— 只有 keep-alive/eager 进
        // startupServers）并打 keep-alive 标记（init.ts:264 markKeepAlive，带健康检查重连）。
        //   · 不用 lazy / lazy-keep-alive：那两者是"首次使用才连"，于是 cbm 的 auto_index 与
        //     watcher baseline 会与**第一次工具调用并发**——这正是 DSH 有启动竞态、Claude Code
        //     没有的原因（后者在会话启动时连接已配置的 MCP server）。
        //   · 不用 eager：CHANGELOG 明写 eager 是 "connect at startup, no auto-reconnect"。
        //   · 它消除的是**启动竞态**，不是陈旧窗口：变更仍靠 git 轮询（实测 18–30s 才感知），
        //     且只盯"服务进程 cwd"那一个 project——多工作区仍靠 sessionRefresh 补。
        // 代价：DSH host 一启动就常驻一个 cbm 进程（实测约 17MB RSS）。
        lifecycle: 'keep-alive',
        // cbm 不暴露 MCP resources；开着只会多一个常驻工具定义（实测 3→2 个工具）。
        exposeResources: false,
        excludeTools: EXCLUDE_TOOLS,
      },
    },
  }
  // 语义检索层（可选）。`server --stdio` 是 zg 自带的 MCP 桥——"安全地拉起或复用共享
  // daemon，代理完 MCP 后让 daemon 继续活着"——所以生命周期零代码。lifecycle 用 lazy
  // 而不是 cbm 那条 keep-alive：zg 没有 auto_index/watcher 会抢跑，不存在启动竞态，
  // 换来的是 daemon（含模型池）只在第一次用时才起（实测 2.2s），不常驻吃内存。
  // toolset=agent：只暴露 1 个 zvec_grep_search；rg/index/status 是 CLI 与后台补刷的，不给模型。
  if (state.zg === 'ready') {
    doc.mcpServers.zg = {
      command: process.execPath,
      args: [cfg.zgCli, 'server', '--stdio', '--mcp-toolset', cfg.zgToolset],
      lifecycle: 'lazy',
      exposeResources: false,
    }
  }
  mkdirSync(cfg.adapterDir, { recursive: true })
  writeFileSync(cfg.adapterConfig, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  state.configPath = cfg.adapterConfig
}

const push = (state, note) => { if (note) state.notes.push(note) }

/**
 * 把引擎的 auto_index 对齐到本插件的配置值（默认开）。
 *
 * 实测语义（0.11.0，两臂对照）：auto_index **只在 MCP 会话启动、且该项目还没有索引时**补一次
 * 全量；对"已索引但坐标陈旧"的项目**一次都不重建**（indexed_at 前后不变）。所以它买的是
 * "新工作区开箱即用"，**不是"防漂移"**——防漂移仍然只有 code_index + check_index_coverage。
 *
 * 作用域是**机器级**：配置存在 ~/.cache/codebase-memory-mcp/_config.db，同机其它 MCP client
 * 共用一份。因此先读再写（幂等、值相同不重复写），且失败只记 note——boot 绝不 throw。
 */
async function ensureAutoIndex(ctx, cfg, state, signal) {
  const want = cfg.autoIndex ? 'true' : 'false'
  try {
    const cur = await run(ctx, [state.cbmPath, 'config', 'get', 'auto_index'], { maxBytes: 8 * 1024, signal })
    const have = (cur.stdout || '').trim().split('\n').pop()
    if (cur.exitCode === 0 && have === want) {
      state.autoIndex = want
      return
    }
    const set = await run(ctx, [state.cbmPath, 'config', 'set', 'auto_index', want], { maxBytes: 8 * 1024, signal })
    if (set.exitCode === 0) state.autoIndex = want
    else push(state, `auto_index 没能设为 ${want}（退出码 ${set.exitCode}）：${(set.stderr || set.stdout).trim().slice(-160)}`)
  } catch (error) {
    push(state, `auto_index 设置异常，已忽略：${String(error?.message ?? error).slice(0, 160)}`)
  }
}

/** 幂等自举：成功过一次就不再重复；未就绪时每次都重试（补装后无需重启）。 */
async function bootstrap(ctx, cfg, state, signal, { force = false } = {}) {
  if (state.ok && !force) return state
  await ensureAdapter(ctx, cfg, state, signal)
  await resolveCbm(ctx, cfg, state)
  resolveZg(cfg, state)
  if (state.cbm === 'ready') {
    const r = await run(ctx, [state.cbmPath, '--version'], { maxBytes: 64 * 1024, signal })
    state.cbmVersion = (r.stdout || r.stderr).trim().split('\n')[0]
    writeAdapterConfig(cfg, state)
    await ensureAutoIndex(ctx, cfg, state, signal)
  }
  state.ok = state.adapter === 'ready' && state.cbm === 'ready'
  return state
}

/**
 * 同一工作区的索引任务串行化。实测并发跑两次 `index_repository`（我们的后台补刷
 * 与引擎 watcher 自己那一次撞上）会被引擎中止其一：退出码 1 +
 * `status:"aborted_previous_preserved"`，hint 原文就是 "Retry"。所以：
 * ① 插件内部先排队（后台补刷与 code_index 互不踩），② 仍被外部撞掉时重试一次。
 */
async function withIndexLock(state, cwd, work) {
  const pending = state.indexJobs.get(cwd)
  if (pending) { try { await pending } catch { /* 前一次失败不阻塞这一次 */ } }
  const job = Promise.resolve().then(work)
  state.indexJobs.set(cwd, job)
  try {
    return await job
  } finally {
    if (state.indexJobs.get(cwd) === job) state.indexJobs.delete(cwd)
  }
}

const abortedByContention = (r) => /aborted_previous_preserved/i.test(`${r?.stdout ?? ''}${r?.stderr ?? ''}`)

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

/**
 * 本插件实测通过的引擎版本。**唯一事实源是 package.json 的 `dsh.testedEngine`**——
 * 定时兼容性 CI（.github/workflows/upstream-compat.yml）读的是同一个字段，避免两处漂移。
 */
function testedEngine() {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))?.dsh?.testedEngine ?? ''
  } catch {
    return ''
  }
}

/**
 * 引擎版本判定：`'ok'`（同一 minor）/ `'untested'`（超出实测范围）/ `''`（版本拿不到）。
 * 导出是为了让验收能直接证伪这条逻辑，而不必伪造一个"未实测的引擎"。
 */
export function engineVerdict(version, tested = testedEngine()) {
  const pick = (v) => String(v ?? '').match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? ''
  const got = pick(version)
  const want = pick(tested)
  if (!got || !want) return ''
  const minor = (v) => v.split('.').slice(0, 2).join('.')
  return minor(got) === minor(want) ? 'ok' : 'untested'
}

/**
 * 运行时三件套 = 与 `scripts/sync.mjs` 的拷贝清单一致。
 * 为什么需要漂移告警：profile 以 `file:` 引用本插件，而 pnpm 把它当**不可变**依赖——
 * 仓库里改了 index.js，除非跑 sync.mjs，profile 里的拷贝**不会**变。症状是"改了没生效"，
 * 而且是静默的。这里把两份拷贝按哈希比出来，把静默失败变成一行可见的话。
 * 注意它的能力边界：能测「仓库 ≠ 拷贝」（该 sync），**测不出**「sync 了但 host 没重启」
 * （运行中的代码没有对自己加载字节的哈希）。
 */
const RUNTIME_FILES = ['index.js', 'cordis.patch.yml', 'package.json', 'lib/client.js']

/** 本模块被加载的位置（= profile 里的那份拷贝）所在的包目录。 */
const loadedPackageDir = () => dirname(fileURLToPath(import.meta.url))

/** 从 profile 的 package.json 反解仓库路径（`dependencies[dsh-codebase-memory] = "file:…"`）。 */
function repoPathFromProfile() {
  try {
    const profileDir = dirname(dirname(loadedPackageDir())) // <profile>/node_modules/<pkg> → <profile>
    const spec = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))?.dependencies?.['dsh-codebase-memory'] ?? ''
    return /^file:(.+)$/.exec(String(spec))?.[1] ?? ''
  } catch {
    return ''
  }
}

/**
 * 比较两份拷贝里同名文件的 sha256，返回不一致的文件名数组。
 * 任一侧读不到就返回 `null`（"无法判定"），绝不 throw——也不把读不到误报成"不一致"。
 * 导出是为了让验收能对两个临时目录直接证伪这条逻辑，而不必去动真实的 profile。
 */
export function fileDrift(packageDir, repoDir, files = RUNTIME_FILES) {
  if (!packageDir || !repoDir) return null
  const differing = []
  try {
    for (const f of files) {
      const digest = (dir) => createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')
      if (digest(packageDir) !== digest(repoDir)) differing.push(f)
    }
  } catch {
    return null
  }
  return differing
}

/** 给 code_setup 报表用的一行。四种结果，都不抛。 */
function syncStatusLine() {
  const repo = repoPathFromProfile()
  if (!repo) return '同步状态: (无法判定：profile 的 package.json 里没有 file: 依赖，或不可读)'
  const drift = fileDrift(loadedPackageDir(), repo)
  if (drift === null) return '同步状态: (无法判定：读不到 ' + RUNTIME_FILES.join(' / ') + ' 之一)'
  if (drift.length === 0) return '同步状态: 一致（拷贝 = 仓库；已重启则为最新代码）'
  return `同步状态: ⚠ ${drift.join(' / ')} 与仓库不一致——通常是改完仓库没跑 sync（node scripts/sync.mjs）；sync 后**仍需重启 host** 才生效`
}

function report(cfg, state) {
  const lines = [
    `status: ${state.ok ? 'OK' : 'NOT READY'}`,
    `压缩层(②): ${state.adapter}  ${cfg.adapterMjs}`,
    `索引引擎(①): ${state.cbm}  ${state.cbmPath || '(未找到)'}${state.cbmVersion ? '  ' + state.cbmVersion : ''}`,
    `引擎实测: 实测通过 ${testedEngine() || '(未声明)'}；当前 ${state.cbmVersion || '(未探测)'}${engineVerdict(state.cbmVersion) === 'untested' ? '  ⚠ 超出实测范围——工具面可能已变，跑 npm run check' : ''}`,
    `清单: ${state.configPath ?? '(未写)'}  exclude=${JSON.stringify(EXCLUDE_TOOLS)}`,
    `代理工具: ${PROXY_TOOL}  bootstrap=${cfg.bootstrap}  adapterVersion=${cfg.adapterVersion}`,
    `触发层: wrapper=${cfg.wrapperTools ? 'on' : 'off'}  enforce=${cfg.enforce}  intercept=${cfg.interceptTools.join('+') || '(无)'}  budget=${cfg.interceptBudgetMs}ms  dirty=${cfg.dirtyTracking ? 'on' : 'off'}(冷却 ${cfg.dirtyRefreshCooldownSec}s)  context=${cfg.contextHint ? 'on' : 'off'}`,
    `语义层(zg): ${state.zg}  toolset=${cfg.zgToolset}  ${cfg.zgCli}`,
    // 只说 UI 真的能改的东西：volatile 是必要条件，页面只画了 enforce / telemetry。
    '热改: enforce / telemetry → 设置 → 插件 → dsh-codebase-memory → codebase-memory 行「配置」（不用重启）；interceptBudgetMs 也是 volatile，但只能改配置文件',
    `遥测计数(跨重启累计): ${Object.entries(state.counts).map(([k, v]) => `${k}=${v}`).join(' ') || '(无事件)'}`,
    `auto_index: ${state.autoIndex || '(未设置)'}（期望 ${cfg.autoIndex ? 'true' : 'false'}；机器级共享配置，只补"无索引的新项目"，不刷新陈旧坐标）`,
    syncStatusLine(),
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
  const lines = [
    '本工作区已接入 codebase-memory 代码索引（经 mcp-adapter 压成单个代理工具）。',
    '',
    '**首选封装动词**（project 与参数形状由插件填，你只管说要找什么）：',
    '- `code_find("符号")` → qualified_name + 文件 + 行范围 + 源码，代替"用 grep 猜定义在哪"。',
    '- `code_callers("qualified_name", direction?)` → 调用者/被调方，代替手工数调用点。',
    '字符串、日志、配置值、正则文本仍然用 grep——图索引对它们没用。',
    '',
    '索引：`code_index`——repo_path 已绑本会话工作区，不要自传；返回的 `project` 供长尾调用。',
    `长尾都走代理工具 \`${PROXY_TOOL}\`，args 直接传对象；多步用 mcpScript 一趟跑完：`,
    '- 验鲜 {"tool":"cbm_check_index_coverage","args":{"project":"<p>","paths":["<相对路径>"]}}',
    '- 取原文 {"tool":"cbm_get_code_snippet","args":{"project":"<p>","qualified_name":"<qn>","format":"json"}}',
    '- 多跳 {"tool":"cbm_query_graph",...}；{"server":"cbm"} 列工具，{"describe":"..."} 看参数',
    '',
    '两个坑性质相反，处置不同：',
    '- **取原文务必带 format:"json"**：默认 tree 是排版信封，照抄当锚点必不匹配，但会当场报错。',
    '- **行号来自索引**：代码改过没重建，片段会**静默**返回邻居内容且不报错。所以动手前验鲜：',
    '  freshness=metadata_changed ⇒ 先 code_index。',
    '',
    '偏移量、实测样本与上游 issue 见本仓库 README 的「已知限制」。',
  ]
  // 语义路由段只在 zg 真的 ready 时出现：图谱引擎（0.11.0 实测）没有任何向量检索，
  // 这段是唯一能说出"自然语言/文档检索"的地方——zg 没装就一个字都不提，不画饼。
  if (state.zg === 'ready') {
    lines.push(
      '',
      '**语义/文档检索**（图谱不做向量，这是补位不是重复）：代理工具调 `zg_zvec_grep_search`，',
      'args {"root":"<工作区绝对路径>","query":"自然语言描述","limit":8}——root 必填；非代码文件（md/配置）也能命中。',
      '找符号与调用关系仍用 code_find / code_callers，精确字面量仍用 grep——三者各有分工，别互相顶替。',
    )
  }
  return lines.join('\n')
}

// ── H2：会话启动时的补偿刷新 ─────────────────────────────────────────────────
// 为什么需要：引擎的自动更新依赖"服务进程 cwd 那个 project 的 git watcher"，而一个 MCP server
// 进程只有一个静态 cwd，且 watcher 随客户端会话存活（实测：会话一断，permanent daemon 在也不
// 工作）。DSH 是多会话、工作区可变，所以那条路结构上覆盖不到会话工作区——后果是坐标陈旧时
// get_code_snippet **静默返回邻居代码**（实测真实仓库 59 个符号里 20 个错位，见 README）。
// 闸门唯一理由是成本：一次 index_repository 墙钟主要是固定开销（300 文件 18s / 1000 文件 21s），
// 所以"每次会话都刷"不可接受，而"git 状态没变就跳过"只要几十毫秒。

const REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000

/** 同一工作区的 git 状态摘要；非 git 工作区返回 null（与引擎 auto_watch 的 git-only 行为一致）。 */
async function workspaceDigest(ctx, cwd, signal) {
  const head = await run(ctx, ['git', 'rev-parse', 'HEAD'], { cwd, maxBytes: 16 * 1024, signal })
  if (head.exitCode !== 0) return null
  const dirty = await run(ctx, ['git', 'status', '--porcelain'], { cwd, maxBytes: 256 * 1024, signal })
  if (dirty.exitCode !== 0) return null
  const text = dirty.stdout || ''
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0
  return `${(head.stdout || '').trim()}|${text.length}|${hash}`
}

/** 该项目是否已在图里：按 root_path 精确匹配，不自己重算 cbm 的命名规则。 */
async function alreadyIndexed(ctx, state, cwd, signal) {
  const listing = await run(ctx, [state.cbmPath, 'cli', '--quiet', 'list_projects'], { cwd, maxBytes: 256 * 1024, signal })
  if (listing.exitCode !== 0) return false
  const norm = (p) => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return (listing.stdout || '').split('\n').some((line) => {
    const parts = line.trim().split(/\s+/)
    return parts.length >= 2 && norm(parts[1]) === norm(cwd)
  })
}

/** detached 刷新的 stdout 没人看，不留日志就无从排障。写不了日志也绝不打扰会话。 */
function refreshLog(cfg, line) {
  try {
    mkdirSync(cfg.adapterDir, { recursive: true })
    writeFileSync(join(cfg.adapterDir, 'refresh.log'), `${new Date().toISOString()} ${line}\n`, { flag: 'a' })
  } catch { /* 忽略 */ }
}

const readStamps = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} } }

/**
 * 会话启动补偿刷新：闸门 → 后台跑。全程不抛、不 await（调用方是同步监听器）。
 * 只有"git 状态变了 且 该项目已索引过"才会真的付出那次 ~15–30s 的后台开销。
 *
 * 返回值是给杠杆 ⑤ 用的：`'refreshed'` 才允许清脏集合，`'skipped:*'` 必须留着——
 * 被闸门挡下意味着**什么都没重建**，这时清账等于宣称"改动已进索引"，那正是我们要
 * 防的静默错位。
 */
async function refreshSessionWorkspace(ctx, cfg, state, agent, signal) {
  const cwd = agent?.session?.header?.cwd
  if (!cwd) { refreshLog(cfg, 'skip (无会话 cwd)'); return 'skipped:no-cwd' }
  if (state.cbm !== 'ready') { refreshLog(cfg, `skip ${cwd}: 引擎未就绪`); return 'skipped:engine' }
  const stampPath = join(cfg.adapterDir, 'refresh-stamps.json')
  const stamps = readStamps(stampPath)
  const last = stamps[cwd]
  if (last && Date.now() - (last.at ?? 0) < REFRESH_MIN_INTERVAL_MS) { refreshLog(cfg, `skip ${cwd}: 冷却中`); return 'skipped:cooldown' }
  if (state.refreshing.has(cwd)) { refreshLog(cfg, `skip ${cwd}: 已有一次刷新在跑`); return 'skipped:in-flight' }
  const digest = await workspaceDigest(ctx, cwd, signal)
  if (digest === null) { refreshLog(cfg, `skip ${cwd}: 非 git 工作区（与引擎 auto_watch 一致）`); return 'skipped:not-git' }
  if (last && last.digest === digest) { refreshLog(cfg, `skip ${cwd}: git 状态未变`); return 'skipped:unchanged' }
  if (!(await alreadyIndexed(ctx, state, cwd, signal))) { refreshLog(cfg, `skip ${cwd}: 尚未索引过（不替用户制造索引）`); return 'skipped:not-indexed' }
  state.refreshing.add(cwd)
  refreshLog(cfg, `refresh ${cwd}（git 状态变了）`)
  try {
    const runIndex = () => run(ctx, [state.cbmPath, 'cli', '--quiet', 'index_repository', '--repo-path', cwd], {
      cwd, maxBytes: 1024 * 1024, graceMs: 60000, signal,
    })
    let r = await withIndexLock(state, cwd, runIndex)
    if (r.exitCode !== 0 && abortedByContention(r)) {
      refreshLog(cfg, `retry ${cwd}（被并发中止）`)
      r = await withIndexLock(state, cwd, runIndex)
    }
    refreshLog(cfg, `done ${cwd} exit=${r.exitCode}`)
    if (r.exitCode === 0) {
      writeFileSync(stampPath, JSON.stringify({ ...stamps, [cwd]: { at: Date.now(), digest } }, null, 2), 'utf8')
      return 'refreshed'
    }
    return 'failed'
  } catch (error) {
    refreshLog(cfg, `fail ${cwd}: ${String(error?.message ?? error).slice(0, 160)}`)
    return 'failed'
  } finally {
    state.refreshing.delete(cwd)
  }
}

/**
 * ── 触发层（docs/design-v2.md 杠杆 ①②③⑤）────────────────────────────────────
 *
 * 一句话：把"该用代码图"从**劝**变成**给结果**——高频动线包成原生工具（①）、
 * 符号类 grep 可拦截（②，deny 系）或直接把输出换成两层检索的命中（replace，
 * 见下：结构层=代码图谱先答，语义层=zvec-grep 补位——两层是并存能力，不是二选一）、
 * 按 query 注入 1–2 行状态（③）、写后记账保证前两者的结果可信（⑤）。
 * 每一条都可关，且全部 fail-open：hook 里出错一律放行。
 *
 * 三个经源码核实的宿主契约（宿主 0.1.5-rc.2 实装，见 docs/design-v2.md 4.3）：
 *   - `tools/pre-execute` 是 waterfall：`(exec, next) => PreToolDecision`，只能
 *     allow/deny/cancel/ask，**放行时不能附带上下文**；deny 的 `reason` 会被原样
 *     物化成 `Error: <reason>` 给模型看，且 denied 调用仍会走 post-execute。
 *     注意：pre-execute **不能改写参数**（宿主契约原文 "Input rewriting is
 *     excluded because arguments are already logged and presented"；实参在钩子
 *     运行前已被 deepFreeze，index.d.ts:442-443 / index.js:3163-3167）。
 *   - `tools/post-execute` 是 waterfall：`(exec, result, next) => PostToolDecision`。
 *     除写入记账（⑤）外，enforce=replace 时它还是**硬替换**通道：accept 分支带
 *     `content` 即整体替换模型可见输出（index.d.ts:461-479 "accept keeps the
 *     call successful (replacing content when given)"，L130-133 "Policy
 *     replacements remain authoritative"）；advise 事件注入（④）已于 2026-10-08
 *     验收撤回，不回 additionalContexts。
 *   - `ctx.tools.execute(input)` 是**公开方法**（宿主工具目录：presentAs/register/
 *     restrict/guard/get/schemas/executionMode/execute），所以封装工具直接复用
 *     keep-alive 的代理链路，不必 spawn CLI —— 实测 `cli` 单次 5.5–8.3s，而
 *     pre-execute 在每次工具调用的关键路径上，那个数字根本不能出现在钩子里。
 */

/**
 * 纯函数：这条 grep/glob 查询像"找符号"还是像"找字面量"？
 *
 * 判据一律**保守**：误拦一次字面量搜索的代价是模型白白多一个往返、并对插件失去
 * 信任，所以默认归 literal（=放行），只有明确像标识符的才算 symbol。可单测。
 *
 * 与宿主自带的 `repeat-tool-reminder` 不重叠：那个只看"参数完全相同的连续重复"，
 * 换一个 pattern 就归零；这里看的是**语义**（标识符形态）。
 */
export function classifyPattern(pattern, path = '') {
  const p = String(pattern ?? '').trim()
  if (!p) return { kind: 'literal', symbol: '' }
  // 明确限定到非代码文件/目录：那是字面量与配置的领域，一律放行。
  if (path && NON_CODE_PATH.test(String(path))) return { kind: 'literal', symbol: '' }
  const def = /^(?:@\s*)?(?:export\s+(?:default\s+)?)?(?:class|def|fn|func|function|interface|type|enum|struct|trait|impl|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(p)
  if (def) return { kind: 'symbol', symbol: def[1] }
  // 纯标识符（可含限定符 . : #）；任何正则元字符、空格、引号、URL 都直接落回 literal。
  if (!/^[A-Za-z_$][\w$.:#]*$/.test(p)) return { kind: 'literal', symbol: '' }
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(p)) return { kind: 'literal', symbol: '' } // 配置键风格 MAX_RETRIES
  // 限定名：`svc.doThing` 找的是 doThing；但 `dsh.profile.bundles` 这种**全小写点分链**
  // 是配置键的形态，不是符号——误拦一次配置搜索比漏拦一次符号搜索贵得多。
  if (/[.:#]/.test(p) && !p.split(/[.:#]/).some((s) => /[A-Z]/.test(s) || (s.includes('_') && s.length >= 4))) {
    return { kind: 'literal', symbol: '' }
  }
  // 限定名取**最后一段**做本体：`svc.doThing` 找的是 doThing，`a.b` 太短就没意义。
  const bare = p.split(/[.:#]/).pop() ?? p
  if (bare.length < 4) return { kind: 'literal', symbol: '' } // foo / api / id 这类太通用
  if (bare.length < 6 && !/[A-Z_]/.test(bare)) return { kind: 'literal', symbol: '' } // name / mode
  return { kind: 'symbol', symbol: bare }
}

/** 内置搜索工具是裸名小写（`grep` / `glob`），MCP 工具才带 `mcp__` 前缀。 */
export function isGrepLike(name, tools = []) {
  return tools.includes(String(name ?? '').toLowerCase())
}

/** 按码点截断（UTF-16 单元截断会切出孤立代理对，宿主对每个请求返回 400）。 */
export function truncateCodepoints(text, max) {
  const chars = Array.from(String(text ?? ''))
  return chars.length <= max ? String(text ?? '') : `${chars.slice(0, max).join('')}…`
}

/** Windows 大小写不敏感 + 斜杠混用：脏路径集合必须归一，否则同一文件记两次。 */
export function normPath(p, cwd = '') {
  let s = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (cwd) {
    const base = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '')
    if (s.toLowerCase().startsWith(`${base.toLowerCase()}/`)) s = s.slice(base.length + 1)
  }
  return /^[a-z]:\//.test(s) ? s[0].toLowerCase() + s.slice(1) : s
}

/**
 * 搜索目标是否落在本工作区内：没有 path 参数 = 全仓搜索（属工作区）；给了 path
 * 只有解析后仍在工作区内才算。图谱与 zg 都是**工作区级**的，越界的 grep（比如
 * 去搜宿主依赖目录）它们答不了——替换=拿本仓的命中伪造越界文件的坐标（实测
 * 遥测：path=AppData\… 的 grep 被换成本仓图谱命中）。导出以便验收直接证伪。
 */
export function coversWorkspace(args, cwd) {
  const raw = String(args?.path ?? '').trim()
  if (!raw) return true
  const norm = (p) => String(p).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  const target = norm(resolve(String(cwd ?? ''), raw))
  const base = norm(cwd)
  return !!base && (target === base || target.startsWith(base + '/'))
}

/** 会话键：优先 session id（resume/多标签下 cwd 可能相同），退回 cwd。 */
const sessionKey = (agent) => agent?.session?.header?.id ?? agent?.session?.header?.cwd ?? ''

/** 每会话状态：project 缓存、脏路径、已拦过的符号（同符号只拦一次）。 */
function sessionOf(state, key) {
  let s = state.sessions.get(key)
  if (!s) {
    s = { project: '', dirty: new Set(), blocked: new Set(), lastRefreshAt: 0 }
    state.sessions.set(key, s)
  }
  return s
}

/** 时间预算：超时返回 null，钩子里绝不因为查询把工具调用卡死。 */
async function withBudget(ms, work) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms) }),
    ])
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 代理工具的返回是 text 块；两种形状（value / content）都接住。 */
function resultText(res) {
  if (!res) return ''
  const blocks = (res.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text)
  if (blocks.length) return blocks.join('\n')
  const v = res.value
  if (typeof v === 'string') return v
  return v === undefined ? '' : JSON.stringify(v)
}

/**
 * 经宿主工具管线调一次 cbm（`mcp__cbm__mcp` 是 keep-alive 的那条长连接）。
 * 返回 `{ ok, text }`；链路不健康 / 被隐藏 / 超时都 `ok:false`，由调用方决定放行。
 */
async function cbmCall(ctx, exec, tool, args, budgetMs, namePrefix = 'cbm') {
  if (typeof ctx?.tools?.execute !== 'function') return { ok: false, text: '' }
  const signal = exec?.signal ?? new AbortController().signal
  const input = {
    callId: randomUUID(),
    name: PROXY_TOOL,
    arguments: { tool: `${namePrefix}_${tool}`, args },
    signal,
    ...(exec?.agent ? { agent: exec.agent } : {}),
  }
  const outcome = await withBudget(budgetMs, () => ctx.tools.execute(input))
  if (!outcome) return { ok: false, text: '', timeout: true }
  if (outcome.isError) return { ok: false, text: resultText(outcome) }
  const text = resultText(outcome)
  // 代理工具会把**底层 MCP 工具的错误包成普通文本**返回（outcome.isError 仍是 false）：
  // 实测 zg 守护打不开 collection 时返回 "Error: Failed to open zvec collection storage…"，
  // 若不识别，错误文本会被当成命中去替换原始输出（遥测里 source=zg 的 intercept-replace）。
  // Error 开头的文本 = 失败，由调用方放行；图谱树以 project:/total:/rows 或 JSON 开头，安全。
  if (/^\s*error\b/i.test(text)) return { ok: false, text }
  return { ok: true, text }
}

/** 从 list_projects 的文本表里按 root_path 找 project 名（不自己重算引擎的命名规则）。 */
export function projectFromListing(text, cwd) {
  const norm = (p) => String(p).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  for (const line of String(text ?? '').split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 2 && norm(parts[1]) === norm(cwd)) return parts[0]
  }
  return ''
}

/** project 名：会话缓存 → code_index 落过的记录 → 现查 list_projects。查不到返回 ''。 */
async function projectFor(ctx, exec, cfg, state, session, cwd, budgetMs = cfg.interceptBudgetMs) {
  if (session.project) return session.project
  const cached = state.projectsByCwd.get(cwd)
  if (cached) { session.project = cached; return cached }
  const r = await cbmCall(ctx, exec, 'list_projects', {}, budgetMs)
  const found = r.ok ? projectFromListing(r.text, cwd) : ''
  if (found) { session.project = found; state.projectsByCwd.set(cwd, found) }
  return found
}

/**
 * 本会话的坐标可信度：**只按自己的写入台账判**，不信 `check_index_coverage`。
 *
 * 为什么不信（引擎 0.11.0 实测，本机）：把当前状态全量重索引之后，立刻对一个
 * **改动都没改过**的文件验鲜，返回的仍是
 * `status=no_recorded_issue / freshness=metadata_changed / action=read_source_and_reindex`
 * ——和改动过的文件一模一样。也就是说这个信号在 0.11.0 上是"项目元数据代际变了"
 * 的全局判定，不是逐路径的过期判定。拿它当拦截前提的后果：拦截永久失效（每次都
 * 判 stale 而放行），并且每条被拦的 grep 都会调度一次 18–30s 的后台重索引。
 *
 * 我们确实知道的只有：本会话用 write/edit 动过哪些文件（`sess.dirty`）。所以
 * ① 拦截与封装工具的警告都按台账判；② 逐路径验鲜留给模型自己按 prompt 里的
 * 动线手动调用（那是给人/给模型看的证据，不是钩子里的门）。
 */
const ledgerStale = (sess) => (sess.dirty.size > 0 ? 'stale' : 'fresh')

/** 遥测：一行 JSON。写失败绝不影响会话（与 refreshLog 同一原则）。 */
const TELEMETRY_MAX_BYTES = 512 * 1024

/**
 * 累计计数文件 = telemetry.log 同目录的 telemetry.counts.json。「开 replace 跑几天
 * 看占比」要熬得过宿主重启：启动播种、每次推送与文件 max 合并。
 * DSH_CBM_COUNTS_FILE 是测试缝——验收 harness 必须把它指到临时文件，否则会污染
 * 用户的真实累计数；宿主不会设置这个变量。
 */
const countsPath = (cfg) => process.env.DSH_CBM_COUNTS_FILE || join(cfg.adapterDir, 'telemetry.counts.json')
function loadCounts(cfg) {
  try {
    const parsed = JSON.parse(readFileSync(countsPath(cfg), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * state.counts → 设置页读数（JSON 字符串）。**每次全量重建**：用户任何一次配置写
 * 都会让 loader 把这个 volatile 字段复位成 schema 默认（_commitVolatile 只认文档
 * 层），下一个事件回填，所以绝不能做增量。键名是面板的契约，改键要同步 lib/client.js。
 */
function renderStats(state) {
  const n = (k) => state.counts[k] ?? 0
  return JSON.stringify({
    at: Date.now(),
    zg: state.zg,
    replace: { hit: n('intercept-replace'), graph: n('intercept-replace:graph'), zg: n('intercept-replace:zg'), passDirty: n('replace-pass-dirty'), passNoHit: n('replace-pass-no-hit'), passFailed: n('replace-pass-failed'), error: n('replace-error') },
    deny: { blocked: n('intercept-deny'), passDirty: n('intercept-pass-dirty'), passNoHit: n('intercept-pass-no-hit'), passQueryFailed: n('intercept-pass-query-failed'), skipSeen: n('intercept-skip-seen'), error: n('intercept-error') },
    dirty: { record: n('dirty-record'), refreshScheduled: n('dirty-refresh-scheduled'), refreshDone: n('dirty-refresh-done'), refreshFail: n('dirty-refresh-fail') },
    lever: { wrapperCalls: n('wrapper-call'), hintInjected: n('hint-injected') },
    index: { retryContention: n('index-retry-contention'), zgIndexFail: n('zg-index-fail') },
  })
}

function telemetry(cfg, state, event, fields = {}) {
  if (!cfg.telemetry) return
  try {
    mkdirSync(cfg.adapterDir, { recursive: true })
    const path = join(cfg.adapterDir, 'telemetry.log')
    // ponytail: 追加式 JSONL，唯一的保鲜手段是"超上限就整份重来"（计数还在内存里，
    // 报表不依赖文件）。要长期分析就换成按天分文件 + 定期清理。
    try { if (statSync(path).size > TELEMETRY_MAX_BYTES) rmSync(path, { force: true }) } catch { /* 还不存在最好 */ }
    writeFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`, { flag: 'a' })
  } catch { /* 忽略 */ }
  state.counts[event] = (state.counts[event] ?? 0) + 1
  // 带 source 的事件额外记一份 "event:source" 计数（intercept-replace 的图谱/语义
  // 占比就靠它）。code_setup 的计数行会多列一个键，属预期；文件行格式不变。
  if (typeof fields.source === 'string') state.counts[`${event}:${fields.source}`] = (state.counts[`${event}:${fields.source}`] ?? 0) + 1
  state.pushStats?.()
}

/** 只进计数不进日志的软杠杆计数（提示注入每轮装配都可能触发，写文件会淹掉日志）。 */
function bumpCount(cfg, state, event) {
  if (!cfg.telemetry) return
  state.counts[event] = (state.counts[event] ?? 0) + 1
  state.pushStats?.()
}

/** deny 的 reason：模型这一轮就要拿到可用结果，而不是一句说教。 */
function renderInterceptHint(symbol, project, hits) {
  return truncateCodepoints([
    `dsh-codebase-memory：grep 找符号 "${symbol}" 已被拦下（同一会话同一符号只拦一次）。代码图里有现成答案，别再用正则猜定义在哪。`,
    `project=${project} 的 search_graph 命中：`,
    (hits || '(无命中)').trim(),
    `下一步：code_find("${symbol}") 拿源码，或 code_callers("<qualified_name>") 拿调用者。`,
  ].join('\n'), HINT_MAX_CODEPOINTS)
}

/**
 * replace 档（enforce=replace）的模型可见内容：原始 grep 输出整体换成两层检索的
 * 命中（结构层优先、语义层补位是**单次替换内**的取数顺序，不代表两层能力二选一——
 * code_find 与 zvec_grep_search 作为常规工具始终并存可用，本档只改 grep 的可见输出）。
 * 走的是宿主 post-execute 的 accept+content 替换通道（契约：dsh-tools
 * index.d.ts PostToolDecision——"accept keeps the call successful (replacing
 * content when given)"；pre-execute 不能改写参数，参数在执行前已被 deepFreeze）。
 * 不留原输出是刻意的：两者都给，模型（和人）的习惯会赢回 grep——用户验收结论
 * （m00773"还是软限制"）要的是换了就真换了。
 */
function renderReplacement(symbol, source, project, hits) {
  return truncateCodepoints([
    `dsh-codebase-memory（enforce=replace）：grep "${symbol}" 的原始输出已替换为${source === 'graph' ? '结构层（代码图谱）' : '语义层（zvec-grep）'}命中。要看原始 grep 结果，把 enforce 改回 off。`,
    `${source === 'graph' ? `project=${project} 的 search_graph` : 'zvec_grep_search'} 命中：`,
    (hits || '(无命中)').trim(),
    source === 'graph' ? `下一步：code_find("${symbol}") 拿源码，或 code_callers("<qualified_name>") 拿调用者。` : '下一步：code_find / code_callers 走图谱，或继续 zg 检索。',
  ].join('\n'), HINT_MAX_CODEPOINTS)
}

/** 像"查代码结构"的用户问题（杠杆 ③ 的触发词，中英各一批）。 */
const CODE_QUESTION = /(谁调用|调用链|引用了|被谁用|定义在哪|在哪定义|哪些地方|哪几处|影响(范围|面|哪些|什么)|重命名|rename|call\s?graph|callers?|callees?|where is .{0,24}defined|what (calls|uses)|impact of)/i

/** 最近一条人类消息（同步、从已物化的会话事件里取；宿主对 context 的渲染不支持异步）。 */
function lastUserQuery(agent) {
  try {
    const session = agent?.session
    const events = session?.snapshotEvents?.() ?? session?.events
    if (!Array.isArray(events)) return ''
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e?.type !== 'user/message') continue
      const kind = e.data?.source?.kind
      if (kind !== undefined && kind !== 'user') continue
      const parts = e.data?.content
      if (!Array.isArray(parts) || parts.length === 0) continue
      return truncateCodepoints(parts.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).filter(Boolean).join('\n'), 400)
    }
  } catch { /* 会话内部结构拿不到：退化成"没有 query"，不注入 */ }
  return ''
}

/** 注入文本里不能出现宿主认识的 `{{name}}`：插值器对未注册变量会抛。 */
const noVars = (s) => String(s).replace(/\{\{/g, '{ {')

/** 封装工具走的是模型主动等待的路径，预算给到 20s（实测代理查询 ~30–60ms，冷路径更高）。 */
const WRAPPER_BUDGET_MS = 20000

const tryJson = (text) => { try { return JSON.parse(String(text ?? '')) } catch { return null } }

/** `format:"json"` 的表形状是 {cols, rows}；形状一变就退回原文，绝不静默丢结果。 */
function parseRows(text) {
  const j = tryJson(text)
  if (!j || !Array.isArray(j.rows) || !Array.isArray(j.cols)) return null
  return j.rows.map((row) => Object.fromEntries(j.cols.map((c, i) => [c, row[i]])))
}

/**
 * search_graph 到底有没有命中。钩子里拿的是默认 tree 文本（reason 要给人读），
 * 所以两种形状都认：JSON 的 `rows: []`，tree 的 `total: 0` / 空输出。
 */
function noHits(text) {
  const rows = parseRows(text)
  if (rows !== null) return rows.length === 0
  const s = String(text ?? '').trim()
  return s === '' || /(?:^|\n)(?:results|total):\s*0\b/.test(s)
}

const formatRows = (rows) => rows
  .map((r, i) => `${i + 1}. ${r.qn ?? r.qualified_name ?? '?'}  [${r.label ?? '?'}]  ${r.file ?? ''} ${r.lines ?? ''}`.trimEnd())
  .join('\n')

/**
 * 封装工具的公共前提：会话工作区 → 链路就绪 → project 解析。
 * 与 code_index 同样的纪律：**前提不成立即 throw**，不静默降级成 grep。
 */
async function runCbmFlow(ctx, cfg, state, exec, work) {
  // 杠杆 ① 的采纳率读数：模型真的在用封装动词吗？两个封装工具共用这条动线，
  // 所以计一次点在这里，而不是各自的 execute 里。
  telemetry(cfg, state, 'wrapper-call', {})
  const cwd = exec?.agent?.session?.header?.cwd
  if (!cwd) throw new Error('封装工具需要会话工作区：exec.agent.session.header.cwd 为空')
  await bootstrap(ctx, cfg, state, exec.signal).catch((error) => {
    state.lastError = String(error?.message ?? error)
    state.ok = false
  })
  if (state.adapter !== 'ready') throw new Error('压缩层(②)未就绪，检索无法工作：\n' + report(cfg, state))
  if (state.cbm !== 'ready') throw new Error(cbmInstallHint(state))
  const sess = sessionOf(state, sessionKey(exec.agent))
  const project = await projectFor(ctx, exec, cfg, state, sess, cwd, WRAPPER_BUDGET_MS)
  if (!project) throw new Error(`本工作区还没进代码图（project 表里没有 cwd=${cwd}）。第一步：code_index，然后再来用封装工具。`)
  return work({ project, sess, cwd })
}

/**
 * 双驱动台账的后半：同一份"本会话写过代码"的事实，图谱补刷之外也喂给 zg 的增量
 * index（实测 18 文件 ~2s；首次全量 22.7s）。不进图谱那条 withIndexLock——两条索引
 * 互不相干，撞车的代价只是多跑一次 CLI。失败静默：查询会退回 eventual freshness，
 * 结果里的 freshness 行自己会说话，不假装刷新过。
 */
async function refreshZgIndex(ctx, cfg, cwd, signal) {
  const r = await run(ctx, [process.execPath, cfg.zgCli, 'index'], {
    cwd, maxBytes: 256 * 1024, graceMs: 120000, signal,
  })
  return r.exitCode === 0
}

/**
 * 脏路径触发的后台补刷：冷却期内合并（同回合的多次写入自然并成一次）。
 * 复用 H2 那条带闸门的 refreshSessionWorkspace——它自己会验 git 状态是否真变了。
 */
function scheduleDirtyRefresh(ctx, cfg, state, sess, exec) {
  const now = Date.now()
  if (now - sess.lastRefreshAt < cfg.dirtyRefreshCooldownSec * 1000) return
  sess.lastRefreshAt = now
  const paths = [...sess.dirty]
  telemetry(cfg, state, 'dirty-refresh-scheduled', { paths: paths.length })
  // zg 那半边不看 git 闸门：台账里有写入就值得刷（工作区甚至可以不是 git 仓库）。
  const zgCwd = exec?.agent?.session?.header?.cwd
  if (state.zg === 'ready' && zgCwd) {
    void refreshZgIndex(ctx, cfg, zgCwd, state.abortSignal)
      .then((ok) => telemetry(cfg, state, ok ? 'zg-index-done' : 'zg-index-failed', { paths: paths.length }))
      .catch((error) => telemetry(cfg, state, 'zg-index-fail', { message: String(error?.message ?? error).slice(0, 200) }))
  }
  void refreshSessionWorkspace(ctx, cfg, state, exec?.agent, state.abortSignal)
    .then((outcome) => {
      // 只有**真的重建过**才清账：被闸门挡下（非 git / 冷却 / 未索引）等于什么都没做，
      // 这时清脏集合就是宣称"改动已进索引"——正是要防的静默错位。
      if (outcome === 'refreshed') {
        sess.dirty.clear()
        telemetry(cfg, state, 'dirty-refresh-done', { paths: paths.length })
      } else {
        telemetry(cfg, state, `dirty-refresh-${outcome || 'failed'}`, { paths: paths.length })
      }
    })
    .catch((error) => telemetry(cfg, state, 'dirty-refresh-fail', { message: String(error?.message ?? error).slice(0, 200) }))
}

/**
 * 会话前提检查（replace 档后置监听用；deny 档因夹带 deny-once 的已拦集合，
 * 保留内联判序）：工具在拦截名单里、pattern 判为符号、拿得到会话 key 与 cwd、
 * 引擎就绪。返回 null = 前提不满足（调用方一律放行 / 不替换）。
 */
function interceptPremises(exec, cfg, state) {
  if (!isGrepLike(exec?.name, cfg.interceptTools)) return null
  const q = classifyPattern(exec?.arguments?.pattern, exec?.arguments?.path)
  if (q.kind !== 'symbol') return null
  const key = sessionKey(exec?.agent)
  const cwd = exec?.agent?.session?.header?.cwd
  if (!key || !cwd || !state.ok) return null
  if (!coversWorkspace(exec?.arguments, cwd)) return null
  return { q, key, cwd, sess: sessionOf(state, key) }
}

/**
 * post-execute 的观察：写入类工具记进会话脏集合（不触发 refresh，纯记账）。
 * advise 事件注入（原杠杆 ④）已于 2026-10-08 验收撤回：不返回任何消息；
 * replace 档的内容替换走独立注册的后置监听（enforce=replace），不在这里。
 */
function observeCall(ctx, cfg, state, exec, result) {
  const key = sessionKey(exec?.agent)
  const cwd = exec?.agent?.session?.header?.cwd
  if (!key || !cwd) return
  const sess = sessionOf(state, key)
  const name = String(exec?.name ?? '').toLowerCase()
  if (cfg.dirtyTracking && WRITE_TOOLS.includes(name) && !result?.isError) {
    const raw = exec?.arguments?.file_path
    if (typeof raw === 'string' && raw) {
      const rel = normPath(raw, cwd)
      // 只记工作区内的代码文件：绝对路径没被前缀吃掉 = 在工作区外；非代码扩展名图里没有。
      const inside = !rel.startsWith('/') && !/^[a-z]:\//i.test(rel)
      if (inside && CODE_FILE.test(rel)) {
        sess.dirty.add(rel)
        telemetry(cfg, state, 'dirty-record', { session: key, path: rel, total: sess.dirty.size })
      }
    }
  }
}

/**
 * ── 触发层结束，以下原有骨架不变 ────────────────────────────────────────────
 */

export async function apply(ctx, config) {
  const cfg = normalize(config)
  const state = {
    adapter: 'unknown', cbm: 'unknown', ok: false, autoIndex: '', refreshing: new Set(), notes: [], lastError: '',
    zg: 'off',
    sessions: new Map(), projectsByCwd: new Map(), counts: {}, indexJobs: new Map(),
  }
  // 开机播种累计计数：重启不是归零（写侧与文件 max 合并，见 pushStats）。
  // 遥测关着就不播种——否则 code_setup 的计数行会报上一轮的旧数，像还在记。
  if (cfg.telemetry) for (const [k, v] of Object.entries(loadCounts(cfg))) if (typeof v === 'number') state.counts[k] = v

  const ac = new AbortController()
  state.abortSignal = ac.signal
  ctx.effect(() => () => ac.abort(), 'dsh-codebase-memory.abort')

  // ── 设置页读数通道（docs/design-v2.md 第 6.4 节）────────────────────────────
  // 把 state.counts 全量重建进 volatile `stats` 引用，节流 emit
  // 'settings/document-updated' 让浏览器 mirror 重新 describe 读到新值。
  // 读的是 config 传进来的**同一个引用**（生产是 cosmokit volatile ref；验收里
  // 传裸对象 → isVolRef 为假就静默跳过，不影响别的臂）。emit 首参必须是字符串
  // （ns），否则 cordis dispatch 会把它当 thisArg 过滤掉监听器。
  state.statsRef = config.stats
  let statsTimer = null
  let statsWritten = ''
  const doStatsEmit = () => { try { ctx.emit('settings/document-updated', 'codebase-memory', Date.now()) } catch { /* 没有转发器就算了 */ } }
  state.pushStats = () => {
    const ref = state.statsRef
    if (isVolRef(ref)) { try { ref[VOL_WRITE](renderStats(state)) } catch { /* 绝不影响会话 */ } }
    // 累计落盘：只在计数变了时写；先与文件 max 合并再写——tauri/web 两宿主并跑时
    // 各自只见自己的增量，max 是最接近跨进程总数的廉价做法（真总数要 per-pid 文件+读侧聚合，不值）。
    if (cfg.telemetry) {
      const snap = JSON.stringify(state.counts)
      if (snap !== statsWritten) {
        statsWritten = snap
        try {
          const f = loadCounts(cfg)
          for (const [k, v] of Object.entries(state.counts)) if (typeof v === 'number' && v > (typeof f[k] === 'number' ? f[k] : 0)) f[k] = v
          if (!process.env.DSH_CBM_COUNTS_FILE) mkdirSync(cfg.adapterDir, { recursive: true })
          writeFileSync(countsPath(cfg), JSON.stringify(f))
        } catch { /* 绝不影响会话 */ }
      }
    }
    if (statsTimer) return // 合并窗口内：只等尾随那一次，页面拿到窗口末的最新值
    doStatsEmit()
    statsTimer = setTimeout(() => { statsTimer = null; doStatsEmit() }, STATS_PUSH_MS)
    if (typeof statsTimer.unref === 'function') statsTimer.unref()
  }
  ctx.effect(() => () => { if (statsTimer) clearTimeout(statsTimer) }, 'dsh-codebase-memory.stats-push')
  // 开机先推一帧全零快照（仅遥测开时）：mneme 式读数是"卡片常驻"，刚重启还没
  // 事件的宿主打开设置页也该看到零值卡片，而不是"暂无读数"空态。
  if (cfg.telemetry) state.pushStats()

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

  // H2：会话启动补偿刷新。监听器必须**同步且绝不抛**——它跑在 agent 启动的发布路径上，
  // 所以这里只做特性探测 + 启动后台任务（`on` 不存在就静默降级，不违"boot 绝不 throw"）。
  if (cfg.sessionRefresh && typeof ctx.on === 'function') {
    ctx.on('agent/session-start', (payload) => {
      try {
        const cwd = payload?.agent?.session?.header?.cwd
        // 绝不静默吞掉失败：detached 的后台任务没人看 stdout，只有日志能事后定位。
        void refreshSessionWorkspace(ctx, cfg, state, payload?.agent, ac.signal)
          .catch((error) => refreshLog(cfg, `fail ${cwd ?? '(无 cwd)'}: 未捕获 ${String(error?.message ?? error).slice(0, 160)}`))
      } catch (error) {
        push(state, `会话启动刷新未能启动（已忽略）：${String(error?.message ?? error).slice(0, 120)}`)
      }
    })
  }

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
      const spec = { cwd, maxBytes: 1024 * 1024, graceMs: 20000, signal: exec.signal }
      let r = await withIndexLock(state, cwd, () => run(ctx, argv, spec))
      if (r.exitCode !== 0 && abortedByContention(r)) {
        // 引擎自己的 hint：并发或瞬态 ⇒ Retry。后台补刷 / 引擎 watcher 都可能撞上来。
        telemetry(cfg, state, 'index-retry-contention', { cwd })
        r = await withIndexLock(state, cwd, () => run(ctx, argv, spec))
      }
      if (r.exitCode !== 0) {
        throw new Error(`index_repository 退出码 ${r.exitCode}：${(r.stderr || r.stdout).trim().slice(-600)}`)
      }
      let info
      try {
        info = JSON.parse(r.stdout)
      } catch {
        throw new Error(`index_repository 输出不是 JSON：${r.stdout.slice(0, 400)}`)
      }
      // 记进会话状态：封装工具与拦截都要 project，不能每次都去问 list_projects。
      // 刚重建完索引 ⇒ 本会话记账的脏路径已经反映在图里，清空集合。
      state.projectsByCwd.set(cwd, info.project)
      const sess = sessionOf(state, sessionKey(exec.agent))
      sess.project = info.project
      sess.dirty.clear()
      return {
        project: info.project,
        status: info.status ?? 'unknown',
        nodes: info.nodes ?? 0,
        edges: info.edges ?? 0,
        root: cwd,
      }
    },
  }))

  // ── 杠杆 ①：原生封装工具 ────────────────────────────────────────────────────
  // 存在的理由只有一个：把"路由键"从模型手里拿走。project、args 形状、四步动线
  // 都由插件填，模型只管说要找什么。长尾能力仍然走 `mcp__cbm__mcp`，不重复造。
  if (cfg.wrapperTools) {
    ctx.tools.register(defineTool({
      name: 'code_find',
      description: 'Locate a SYMBOL (function / class / method / route) in this workspace by name: returns the qualified name, file, line range and the source itself from the code graph. Use it INSTEAD of grep when the question is "where is X defined / what does X look like". NOT for string literals, log messages, config values, URLs or regex over text — keep using grep for those. Returns "not indexed" when the workspace has no graph yet: run code_index first.',
      parameters: {
        query: { type: 'string', required: true, description: 'Symbol name or a short keyword phrase (BM25 over the graph). Prefer the exact identifier.' },
        limit: { type: 'integer', description: 'Max candidate symbols (default 3, cap 10).' },
        with_source: { type: 'boolean', description: 'Also read the source of the top candidate (default true).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            project: { type: 'string', required: true },
            status: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const out = await runCbmFlow(ctx, cfg, state, exec, async ({ project, sess }) => {
          const limit = Math.min(Math.max(Number.isInteger(args.limit) ? args.limit : 3, 1), 10)
          const search = await cbmCall(ctx, exec, 'search_graph', { project, query: String(args.query ?? ''), limit, format: 'json' }, WRAPPER_BUDGET_MS)
          if (!search.ok) throw new Error(`search_graph 调用失败（链路或引擎异常）：${(search.text || '超时').slice(0, 300)}`)
          const rows = parseRows(search.text)
          if (rows === null) return { status: 'ok', text: truncateCodepoints(search.text, SNIPPET_MAX_CODEPOINTS), project } // 形状变了也不吞结果
          if (rows.length === 0) return { status: 'empty', text: `代码图（project=${project}）里没有匹配 "${args.query}" 的符号。\n字符串 / 日志 / 配置值本来就该用 grep；确实是符号的话，换个关键词或先 code_index。` }
          const lines = [`code_find project=${project}  命中 ${rows.length} 个候选：`]
          lines.push(formatRows(rows, project))
          let staleNote = ''
          if (args.with_source !== false) {
            const top = rows[0]
            const qn = top.qualified_name ?? top.qn ?? ''
            if (qn) {
              const snip = await cbmCall(ctx, exec, 'get_code_snippet', { project, qualified_name: qn, format: 'json' }, WRAPPER_BUDGET_MS)
              const parsed = snip.ok ? tryJson(snip.text) : null
              if (parsed?.source) {
                // 便宜的自检：坐标过期时引擎会**静默**返回邻居代码（上游 issue #1750）。
                // 名字对不上就是邻居，别当定义交出去。
                const name = String(parsed.name ?? qn.split('.').pop() ?? '')
                const holds = parsed.source.includes(name)
                lines.push(`\n—— ${qn}（${parsed.file_path ?? ''} ${parsed.start_line ?? '?'}-${parsed.end_line ?? '?'}）${holds ? '' : ' ⚠ 返回的源码里没有这个符号名，坐标很可能已过期'}`)
                lines.push(truncateCodepoints(parsed.source, SNIPPET_MAX_CODEPOINTS))
                if (!holds) staleNote = '\n⚠ 索引坐标与本会话的编辑不一致：先跑 code_index 再采信上面的行号。'
              } else {
                lines.push(`\n—— ${qn}\n${truncateCodepoints(snip.text || '(取源码失败)', SNIPPET_MAX_CODEPOINTS)}`)
              }
            }
          }
          const fresh = ledgerStale(sess)
          const warn = fresh === 'stale'
            ? `\n⚠ 本会话用 write/edit 改过 ${sess.dirty.size} 个文件（${[...sess.dirty].slice(0, 5).join(', ')}${sess.dirty.size > 5 ? ' …' : ''}），而这些改动还没进索引：上面的行号与片段可能落到邻居代码。建议先 code_index（已在后台补刷）。逐路径证据可自己跑 cbm_check_index_coverage。`
            : ''
          if (fresh === 'stale') scheduleDirtyRefresh(ctx, cfg, state, sess, exec)
          return { status: fresh === 'stale' ? 'stale' : 'ok', text: truncateCodepoints(lines.join('\n') + warn + staleNote, 6000), project }
        })
        return out
      },
    }))

    ctx.tools.register(defineTool({
      name: 'code_callers',
      description: 'Who calls a symbol (direction=inbound, the default) or what it calls (outbound), hop by hop, from the code graph. Use it INSTEAD of grepping the identifier to eyeball call sites: it follows the CALLS/USAGE edges and gives qualified names. Argument is the qualified_name from code_find (or a bare symbol name that exists in the graph).',
      parameters: {
        name: { type: 'string', required: true, description: 'Qualified name (preferred) or symbol name to trace.' },
        direction: { type: 'string', description: 'inbound (callers, default) | outbound (callees) | both.' },
        depth: { type: 'integer', description: 'Hops to expand (default 1).' },
        limit: { type: 'integer', description: 'Max rows (default 20).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            project: { type: 'string', required: true },
            status: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const dir = ['inbound', 'outbound', 'both'].includes(args.direction) ? args.direction : 'inbound'
        return runCbmFlow(ctx, cfg, state, exec, async ({ project, sess }) => {
          const trace = await cbmCall(ctx, exec, 'trace_path', {
            project,
            function_name: String(args.name ?? ''),
            direction: dir,
            ...(Number.isInteger(args.depth) ? { depth: Math.min(Math.max(args.depth, 1), 6) } : {}),
            ...(Number.isInteger(args.limit) ? { limit: Math.min(Math.max(args.limit, 1), 100) } : {}),
          }, WRAPPER_BUDGET_MS)
          if (!trace.ok) throw new Error(`trace_path 调用失败：${(trace.text || '超时').slice(0, 300)}`)
          const fresh = ledgerStale(sess)
          if (fresh === 'stale') scheduleDirtyRefresh(ctx, cfg, state, sess, exec)
          return {
            status: fresh === 'stale' ? 'stale' : 'ok',
            text: truncateCodepoints(trace.text + (fresh === 'stale' ? `\n⚠ 本会话用 write/edit 改过 ${sess.dirty.size} 个文件，这些改动还没进索引，调用边可能滞后；先 code_index 再采信。` : ''), 6000),
            project,
          }
        })
      },
    }))
  }

  // ── 杠杆 ②：tools/pre-execute 拦截符号类 grep/glob（仅 deny-once / deny）──────
  // 关键路径上的同步钩子：只做纯本地判断，必要才查（实测代理查询 ~30–60ms，
  // 而 cbm CLI 冷启动实测 5.5–8.3s —— 绝不能在钩子里 spawn CLI）。任何不满足
  // 前提 / 超时 / 出错的情形一律放行。
  // 常驻注册：enforce 是 volatile 字段，设置页改完当场生效——钩子按启动时的值条件
  // 注册的话，"打开拦截"就得重启，那正是这次要消掉的东西。off 时第一行就放行，
  // 代价只有一次属性读。
  if (typeof ctx.on === 'function') {
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        if (cfg.enforce === 'off' || cfg.enforce === 'replace' || !isGrepLike(exec.name, cfg.interceptTools)) return next()
        const q = classifyPattern(exec.arguments?.pattern, exec.arguments?.path)
        if (q.kind !== 'symbol') return next()
        const key = sessionKey(exec.agent)
        const cwd = exec.agent?.session?.header?.cwd
        if (!key || !cwd || !state.ok) return next()
        if (!coversWorkspace(exec.arguments, cwd)) return next() // 越界搜索：图谱答不了，拦了就是伪造坐标
        const sess = sessionOf(state, key)
        if (cfg.enforce === 'deny-once' && sess.blocked.has(q.symbol)) {
          telemetry(cfg, state, 'intercept-skip-seen', { session: key, symbol: q.symbol })
          return next()
        }
        const project = await projectFor(ctx, exec, cfg, state, sess, cwd)
        if (!project) return next()
        const fresh = ledgerStale(sess)
        if (fresh !== 'fresh') {
          // 本会话写过代码 ⇒ 图里的坐标不可信，这时拦截就是在骗人：放行 + 后台补刷。
          telemetry(cfg, state, 'intercept-pass-dirty', { session: key, symbol: q.symbol, dirty: sess.dirty.size })
          scheduleDirtyRefresh(ctx, cfg, state, sess, exec)
          return next()
        }
        const hits = await cbmCall(ctx, exec, 'search_graph', { project, query: q.symbol, limit: 5 }, cfg.interceptBudgetMs)
        if (!hits.ok) {
          telemetry(cfg, state, 'intercept-pass-query-failed', { session: key, symbol: q.symbol, timeout: !!hits.timeout })
          return next()
        }
        // 图里没有这个符号 ⇒ grep 才是对的工具。拦一条"索引本来就没答案"的搜索，
        // 既没教育到东西，还把模型唯一能走通的路挡了——所以命中为空就放行。
        if (noHits(hits.text)) {
          telemetry(cfg, state, 'intercept-pass-no-hit', { session: key, symbol: q.symbol })
          return next()
        }
        sess.blocked.add(q.symbol)
        telemetry(cfg, state, 'intercept-deny', { session: key, symbol: q.symbol, enforce: cfg.enforce })
        // reason 是模型唯一看得到的部分；info 只进结构化错误元数据（宿主契约：info.reason 不进模型内容）。
        return {
          kind: 'deny',
          reason: renderInterceptHint(q.symbol, project, hits.text),
          info: { name: 'SymbolSearchIntercept', code: 'cbm-symbol-intercept' },
        }
      } catch (error) {
        telemetry(cfg, state, 'intercept-error', { message: String(error?.message ?? error).slice(0, 200) })
        return next() // fail-open
      }
    })
  }

  // ── 杠杆 ⑤：写后记账（tools/post-execute）。只记账，绝不回 additionalContexts
  // ——④ advise 事件注入已于 2026-10-08 验收撤回。监听器常驻，dirtyTracking
  // 在 observeCall 里现读：设置页热翻立即开合记账通道（v0.9.0）。────────────────
  if (typeof ctx.on === 'function') {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      try {
        observeCall(ctx, cfg, state, exec, result)
      } catch (error) {
        telemetry(cfg, state, 'post-execute-error', { message: String(error?.message ?? error).slice(0, 200) })
      }
      return next()
    })
  }

  // ── 杠杆 ②b：replace 档——符号类 grep 的**输出**整体换成两层检索命中（enforce=replace）
  // 通道是 post-execute 的 accept+content 替换（宿主契约见触发层总注）：grep 照常
  // 执行、照常成功，模型拿到的内容已是图谱命中——不再依赖模型"自觉"，也不给
  // isError 假错误。常驻注册：enforce 是 volatile 字段，热切换不能靠重启；非
  // replace 时第一行就 next()，代价一次属性读。注册在记账之后：waterfall 按注册序
  // 执行，记账永远先看原始 exec，替换只决定模型看到什么。
  if (typeof ctx.on === 'function') {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      if (cfg.enforce !== 'replace') return next()
      try {
        if (result?.isError) return next() // 失败结果（含被 deny 物化的）不换：替换只针对成功输出
        const prem = interceptPremises(exec, cfg, state)
        if (!prem) return next()
        const { q, key, cwd, sess } = prem
        if (ledgerStale(sess) !== 'fresh') {
          // 台账脏 ⇒ 图里的坐标不可信，替换就是骗人：保留原 grep 输出 + 后台补刷。
          telemetry(cfg, state, 'replace-pass-dirty', { session: key, symbol: q.symbol, dirty: sess.dirty.size })
          scheduleDirtyRefresh(ctx, cfg, state, sess, exec)
          return next()
        }
        const project = await projectFor(ctx, exec, cfg, state, sess, cwd)
        let source = ''
        let text = ''
        // 区分"索引本来没答案"与"层查询失败"（超时/底层错误文本）：前者 grep 才是对的
        // 工具，后者是基础设施问题——泡数据时这两个占比的含义相反，不能混一个计数。
        let failed = false
        if (project) {
          const hits = await cbmCall(ctx, exec, 'search_graph', { project, query: q.symbol, limit: 5 }, cfg.interceptBudgetMs)
          if (hits.ok && !noHits(hits.text)) { source = 'graph'; text = hits.text }
          else if (!hits.ok) failed = true
        }
        // 图谱没答案才轮到 zg 语义层；root 由钩子补上——模型忘填必填参数的坑就此消掉。
        // ponytail: zg 冷启动实测 3.3s，超过默认 2500ms 预算 ⇒ 会话里第一条被换的
        // 符号搜索会超时退回原输出，之后热（1.4s）能换。宁缺勿塞，升级路径是常驻
        // daemon 或独立 zgReplaceBudgetMs 配置。
        if (!text && state.zg === 'ready') {
          const z = await cbmCall(ctx, exec, 'zvec_grep_search', { query: q.symbol, root: cwd, limit: 5 }, cfg.interceptBudgetMs, 'zg')
          if (z.ok && !noHits(z.text)) { source = 'zg'; text = z.text }
          else if (!z.ok) failed = true
        }
        if (!text) {
          telemetry(cfg, state, failed ? 'replace-pass-failed' : 'replace-pass-no-hit', { session: key, symbol: q.symbol })
          return next() // 索引本来没答案 ⇒ grep 才是对的工具
        }
        telemetry(cfg, state, 'intercept-replace', { session: key, symbol: q.symbol, source })
        return { kind: 'accept', content: [{ type: 'text', text: renderReplacement(q.symbol, source, project, text) }] }
      } catch (error) {
        telemetry(cfg, state, 'replace-error', { message: String(error?.message ?? error).slice(0, 200) })
      }
      return next() // fail-open：拿不准就保留原始 grep 输出
    })
  }

  // ── 杠杆 ③：按 query 条件注入（易变状态进 context，绝不进常驻段）──────────────
  // 监听器常驻、contextHint 在回调里现读：设置页热翻立即开合注入通道
  // （v0.9.0——注册期快照的话页面就会说谎）。
  if (ctx.systemPrompt?.context) {
    ctx.effect(() => ctx.systemPrompt.context({
      name: 'codebase-memory:hint',
      order: 130, // 宿主已占的槽位是 110/115/120（sandbox/approval/delegation）
      text: (assembly) => {
        try {
          if (!cfg.contextHint) return '' // 关着：一行都不注入，也不计数
          if (!state.ok) return '' // 链路没就绪就别推荐
          const agent = assembly?.agent
          const cwd = agent?.session?.header?.cwd
          const key = sessionKey(agent)
          if (!key || !cwd) return ''
          const query = lastUserQuery(agent)
          if (!query || !CODE_QUESTION.test(query)) return '' // 不像在查代码结构：不注入
          const sess = sessionOf(state, key)
          // 渲染是同步的，所以只能用**已缓存**的 project（同 cwd 解析过就有）。
          const project = sess.project || state.projectsByCwd.get(cwd) || ''
          const dirty = sess.dirty.size
          const head = `codebase-memory: project=${project || '(未索引：先 code_index)'}, ${dirty ? `本会话改了 ${dirty} 个文件（坐标可能过期）` : '索引新鲜'}.`
          const tail = project
            ? '找定义/调用关系用 code_find / code_callers；字符串、日志、配置值仍用 grep。'
            : '第一步：code_index。'
          // 只数真正注入的那一次（每轮装配都调这个回调，注入与否是 ③ 的有效性读数）。
          bumpCount(cfg, state, 'hint-injected')
          return noVars(`${head} ${tail}`)
        } catch {
          return ''
        }
      },
    }), 'dsh-codebase-memory.context-hint')
  }
}