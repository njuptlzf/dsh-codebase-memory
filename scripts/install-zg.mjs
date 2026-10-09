/**
 * 一次性安装语义检索层（@zvec/zvec-grep）到 DSH vendor 目录。幂等。
 *
 *   npm run install:zg            # 装到 <DSH_HOME>/vendor/zvec-grep
 *   node scripts/install-zg.mjs <dir>
 *
 * 为什么要有"裁剪"这一步（0.2.2 / win32-x64 实测）：
 *   完整安装 1230MB，但我们的路线是 local/potion-code-16m-v2（transformers.js +
 *   onnxruntime-node），`node-llama-cpp`（llama.cpp 后端，743MB）与 `onnxruntime-web`
 *   （浏览器构建，90MB）永远不会被加载。删掉三者后 `--version`、`index`、daemon、
 *   查询全部实测通过，vendor 落到 **430MB**。
 *   不用 `--omit=optional`：@zvec/zvec 的 win32-x64 原生绑定也在 optionalDependencies
 *   里，跳了就没得跑了。先全装再点名删。
 *
 * 装完还要开配置才生效：profile 的 cordis.patch.yml 写 `zgEnabled: true`（或设置页
 * 文件层），然后重启——它决定 cbm.json 里有没有第二个 server，不是热改字段。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = '@zvec/zvec-grep'
const VERSION = '0.2.2' // 与第 0 步实测数据钉在一起；升版要重跑基准再改这里。
const PRUNE = ['node_modules/node-llama-cpp', 'node_modules/@node-llama-cpp', 'node_modules/onnxruntime-web']

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const vendor = process.argv[2] || join(dshHome, 'vendor', 'zvec-grep')
const cli = join(vendor, 'node_modules', PKG, 'dist', 'cli', 'index.js')

const log = (...a) => console.log('[install-zg]', ...a)

function npmCliEntry() {
  // 同 index.js 的道理：Windows 上 PATH 上的 npm 是 .cmd，Node 直接 spawn 会被拒；
  // DSH 自带 node 旁边也可能没有 npm，所以按候选探测 npm-cli.js。
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(process.env.APPDATA || '', 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  return candidates.find((p) => p && existsSync(p)) ?? ''
}

const versionOf = () => {
  if (!existsSync(cli)) return ''
  const r = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', timeout: 60000 })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n')[0] ?? ''
}

if (versionOf() === VERSION) {
  log(`已就位（${PKG}@${VERSION}），跳过安装。`)
} else {
  mkdirSync(vendor, { recursive: true })
  const pkgJson = join(vendor, 'package.json')
  if (!existsSync(pkgJson)) {
    writeFileSync(pkgJson, JSON.stringify({ name: 'zg-vendor', private: true, version: '0.0.0' }, null, 2) + '\n', 'utf8')
  }
  const npm = npmCliEntry()
  if (!npm) throw new Error(`找不到 npm-cli.js，无法安装。手动：npm install --prefix "${vendor}" ${PKG}@${VERSION}`)
  log(`npm install ${PKG}@${VERSION} → ${vendor}（全装约 1230MB，3 分钟上下）`)
  const r = spawnSync(process.execPath, [npm, 'install',
    '--prefix', vendor, '--no-audit', '--no-fund', '--loglevel=error', `${PKG}@${VERSION}`], {
    stdio: 'inherit', cwd: vendor, timeout: 20 * 60 * 1000,
  })
  if (!existsSync(cli)) throw new Error(`npm install 退出码 ${r.status}，但 ${cli} 还是不存在`)
}

for (const rel of PRUNE) {
  const p = join(vendor, rel)
  if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); log(`裁剪 ${rel}`) }
}

const v = versionOf()
if (v !== VERSION) throw new Error(`裁剪后自检失败：--version 得到 "${v}"（期望 ${VERSION}）。别再用 --omit=optional。`)
const sizeMB = (dir) => {
  let sum = 0
  const walk = (d) => {
    let entries = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else sum += statSync(full).size
    }
  }
  walk(dir)
  return Math.round(sum / 1024 / 1024)
}
log(`完成：${PKG}@${v}，vendor ${sizeMB(vendor)}MB。`)
log('下一步：profile cordis.patch.yml 加 zgEnabled: true，然后跑 npm run sync && 重启；首次使用会在项目根建 .zvec-grep/（记得 gitignore）。')
