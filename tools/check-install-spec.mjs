/**
 * 检查「面板显示的命令」与「安装器实际执行的 spec」是否一致。
 *
 *   node tools/check-install-spec.mjs
 *
 * ## 为什么需要这个检查（两次真机自更新失败换来的）
 *
 * **第一次**（v1.0.3 → v1.1.0）失败在 `github:` 简写：
 *
 * ```
 * pnpm: Command failed with exit code 128:
 *   git ls-remote "git+ssh://git@github.com/liancha22/dsh-puzzle-mode.git" v1.1.0
 * Host key verification failed.
 * ```
 *
 * pnpm 的简写会**按环境挑协议**，挑中 `git+ssh` 就必然失败。
 *
 * **第二次**改成显式 `git+https://github.com/...` 又失败：
 *
 * ```
 * fatal: unable to access 'https://github.com/...': Failed to connect to github.com:443
 * ```
 *
 * 本机实测可达性（2026-10-09）：
 *
 * | 域名 | 443 |
 * |---|---|
 * | `api.github.com` | 通 |
 * | `codeload.github.com` | 通 |
 * | **`github.com`** | **不通** |
 *
 * pnpm 装 git 依赖第一步就是在 `github.com` 上 `git ls-remote` 解析 tag → SHA，
 * 所以**任何要碰 `github.com` 的规格都装不上**。解法是把那一步挪到插件里
 * （走可达的 api 拿 SHA），再把 SHA 版 codeload URL 交给 pnpm——
 * 那正是 pnpm 自己写进锁文件的形式。
 *
 * 两处（插件里的面板命令、独立安装器脚本）分处两个文件，靠人记着同步必然漂移，
 * 所以把「逐字一致」钉成机械检查。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let bad = 0

/** 断言，失败只记账不抛（一次看完所有问题比逐个修快）。 */
function check(label, condition, detail) {
  if (condition) {
    console.log(`✓ ${label}`)
  } else {
    bad += 1
    console.log(`✗ ${label}${detail ? ' —— ' + detail : ''}`)
  }
}

const installerRaw = readFileSync(join(root, 'tools', 'dsh-puzzle-update.mjs'), 'utf8')
const updaterRaw = readFileSync(join(root, 'lib', 'updater.js'), 'utf8')

/**
 * **剥掉注释**再查代码。
 *
 * ## 为什么要这一步（第一版在这里假红）
 *
 * 第一版直接对整个文件做「不许出现 `git+https://github.com/`」，结果**红了**——
 * 而那两处出现都在**注释里**（我正在解释「为什么不用它」）。
 *
 * 一个把「解释为什么不用它」也判成违规的检查，会逼着人删掉那些解释——
 * 而删掉之后，下一个人就会**重新把它加回来**。检查该盯的是**会执行的代码**。
 *
 * 实现上只需处理行注释与块注释；字符串里的 `//` 不构成问题
 * （本仓的 URL 都是 `https://`，`//` 前是 `:`，不会被误当成注释起点——
 * 为稳妥起见只在**行首或空白后**认 `//`）。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .split('\n')
    .map((line) => {
      const m = line.match(/(^|\s)\/\//)
      return m === null ? line : line.slice(0, m.index + m[1].length)
    })
    .join('\n')
}

const installer = stripComments(installerRaw)
const updater = stripComments(updaterRaw)

// ---- 1) 安装器：必须走 codeload，且不能残留要碰 github.com 的规格 ----
check('安装器用 codeload 拼 spec',
  installer.includes('codeloadUrl(REPO_SLUG, sha)'),
  '找不到 `codeloadUrl(REPO_SLUG, sha)`')
check('安装器不再用 github: 简写',
  !/@github:\$\{/.test(installer),
  '仍残留 `@github:${...}` —— 简写会按环境挑协议，SSH 环境下必然失败')
check('安装器不再用 git+https://github.com/',
  !/git\+https:\/\/github\.com\//.test(installer),
  '仍残留 `git+https://github.com/` —— 实测直连 github.com:443 不通')
check('安装器定义了 REPO_SLUG', /const REPO_SLUG = '/.test(installer))
check('安装器会解析 tag → SHA',
  installer.includes('resolveTagSha(args.tag)'),
  '找不到 `resolveTagSha(args.tag)` —— 不解析就拼不出 codeload 的 SHA 版 URL')
check('安装器能接 --sha（面板解析过的直接传）',
  installer.includes("'--sha'"),
  "找不到 `'--sha'` 参数")

// ---- 2) 插件侧：面板显示的命令同样要走 codeload ----
check('面板命令用 codeload',
  updater.includes('https://codeload.github.com/${repo}/tar.gz/'),
  '找不到 `https://codeload.github.com/${repo}/tar.gz/`')
check('面板命令不再用 github: 简写',
  !/@github:\$\{repo\}/.test(updater),
  '仍残留 `@github:${repo}` —— 与安装器会跑出不同结果')
check('面板命令不再用 git+https://github.com/',
  !/git\+https:\/\/github\.com\//.test(updater),
  '仍残留 `git+https://github.com/`')
check('插件能解析 tag → SHA',
  /export async function resolveTagSha\(/.test(updater),
  '找不到 `export async function resolveTagSha(`')

// ---- 3) 两处仓库 slug 一致（两个文件，靠人记必然漂移） ----
const slugOf = (text, pattern) => {
  const m = text.match(pattern)
  return m === null ? '' : m[1]
}
const installerSlug = slugOf(installer, /const REPO_SLUG = '([^']+)'/)
const updaterSlug = slugOf(updater, /export const UPDATE_REPO = '([^']+)'/)
check('两处仓库 slug 一致',
  installerSlug !== '' && installerSlug === updaterSlug,
  `安装器 ${installerSlug || '(缺)'} vs 插件 ${updaterSlug || '(缺)'}`)

console.log('')
if (bad > 0) {
  console.log(`✗ ${bad} 项不一致 —— 面板显示的命令与实际执行的不是同一条，用户照抄会得到不同结果`)
  process.exit(1)
}
console.log('✓ 面板命令与安装器 spec 同源：都走 codeload 的 SHA 版 URL（不需要 github.com）')
