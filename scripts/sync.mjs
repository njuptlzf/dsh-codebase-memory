/**
 * 把仓库里的插件同步进**所有已安装它的** profile。
 *
 *   node scripts/sync.mjs            # 全部已安装的 profile
 *   node scripts/sync.mjs <profile>  # 只同步指定 profile
 *
 * 为什么需要它：pnpm 对 `file:` 目录依赖按 lockfile 判定，内容变化不会被发现——
 * `dsh plugin --profile <p> add file:...` 与 `pnpm install --force` 都不会重新拷贝。
 * 首次安装走：
 *   dsh plugin --profile <p> add file:<repo>
 * 之后每次改完代码跑这个脚本，再重启 profile 才生效。
 *
 * 不用 pnpm 做同步：实测在依赖较多的 profile 里 `dsh plugin add` 会长时间不返回
 * （10 分钟被超时杀掉），而插件只需要"文件在 node_modules 里 + 名字在
 * dsh.profile.bundles 里"，直接拷贝更可控。
 *
 * 用 node 而不是 PowerShell：仓库里凡带中文的 .ps1 在 PowerShell 5.1 下会被按
 * ANSI 读取（无 BOM 时），中文字符串直接解析失败。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE, '.dsh')
const profilesDir = join(dshHome, 'profiles')
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '')

const installedIn = (profile) => join(profilesDir, profile, 'node_modules', 'dsh-codebase-memory')
const profileArg = process.argv[2]

const profiles = existsSync(profilesDir)
  ? readdirSync(profilesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(installedIn(name)))
  : []

const targets = profileArg ? [profileArg] : profiles
if (targets.length === 0) {
  throw new Error(`还没有任何 profile 装过这个插件。先跑：\ndsh plugin --profile <name> add file:${repo}`)
}

const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** 仓库内目录 bundle 的扁平文件清单；用于把 skills/ 同步到用户 skill 根。 */
function listFiles(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(p, base))
    else if (entry.isFile()) out.push({ src: p, rel: relative(base, p) })
  }
  return out
}

function syncSkills() {
  const skillsRepo = join(repo, 'skills')
  if (!existsSync(skillsRepo)) return 0
  const skillsUser = join(dshHome, 'skills')
  mkdirSync(skillsUser, { recursive: true })

  let changed = 0
  for (const { src, rel } of listFiles(skillsRepo, skillsRepo)) {
    const dst = join(skillsUser, rel)
    mkdirSync(dirname(dst), { recursive: true })
    if (existsSync(dst) && statSync(dst).isFile() && digest(src) === digest(dst)) continue
    copyFileSync(src, dst)
    if (digest(src) !== digest(dst)) throw new Error(`同步 skill 后哈希不一致：${rel}`)
    console.log(`skill copied  ${rel}`)
    changed++
  }
  if (changed === 0) console.log('\nskills unchanged')
  return changed
}

let changedTotal = 0
for (const profile of targets) {
  const dest = installedIn(profile)
  if (!existsSync(dest)) throw new Error(`profile ${profile} 里没有安装：${dest}`)
  console.log(`\n[${profile}] -> ${dest}`)

  for (const file of ['index.js', 'cordis.patch.yml', 'package.json', 'lib/client.js']) {
    const src = join(repo, file)
    const dst = join(dest, file)
    if (!existsSync(src)) throw new Error(`仓库里缺少 ${file}（bundle 装载依赖它）`)
    // 只动有差异的文件：运行中的 host 会盯着已注册 bundle 的 composition，
    // 无差别覆盖会撞上文件占用（实测 cordis.patch.yml 被锁）。
    if (existsSync(dst) && digest(src) === digest(dst)) {
      console.log(`  unchanged ${file}`)
      continue
    }
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    if (digest(src) !== digest(dst)) throw new Error(`同步后哈希不一致：${profile}/${file}`)
    console.log(`  copied    ${file}`)
    changedTotal++
  }
}

const skillChangedTotal = syncSkills()

console.log(`\nsynced ${changedTotal} plugin file(s) across ${targets.length} profile(s)`)
console.log(`synced ${skillChangedTotal} skill file(s) to ${join(dshHome, 'skills')}`)
console.log('插件运行时改动需重启对应 profile；skill 目录由 filesystem watcher 自动发现。')