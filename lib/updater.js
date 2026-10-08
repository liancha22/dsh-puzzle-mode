/**
 * 自动更新：查有没有新版本、把更新日志拉下来讲清楚、把新版下到暂存区。
 *
 * ## 为什么只做到「暂存」而不是「自己装上」（用户裁定）
 *
 * 备选方案是让宿主直接跑 `pnpm add` 把新版装进 profile。那是真正的「一键」，
 * 但它有一个**不可接受**的失败模式：装坏了，插件本身就加载不了——面板随之消失，
 * 用户只剩「手改 `package.json`」这一条路，而那时他连界面都没有。
 *
 * 所以边界划在：**插件只写自己的缓存目录**（`$DSH_HOME/puzzle-mode-updates/`），
 * 一个字节都不碰 profile；装不装、什么时候装，由用户执行那一条命令决定。
 * 代价是多一次复制粘贴，换来的是「更新失败 = 面板照旧能用」。
 *
 * ## 通道为什么是这几条（2026-10-08 实测，不是猜的）
 *
 * | 通道 | 结果 |
 * | --- | --- |
 * | `api.github.com` | **通**（615ms）——拿版本号、正文、附件地址 |
 * | `cdn.jsdelivr.net` | **通**（1430ms）——拿仓库里的 `package.json` / `CHANGELOG.md` |
 * | `gh-proxy.com` | **通**（690ms）——代理任意 github 地址 |
 * | `raw.githubusercontent.com` | **不通**（DNS 解析失败） |
 *
 * 所以顺序是：先 GitHub API（信息最全：正文、附件、发布时间一次到手），
 * 失败再退到 jsDelivr 拉 `package.json` + `CHANGELOG.md`（够回答「有没有新版、改了啥」，
 * 但**拿不到附件地址**，因此只能提示去 Release 页手动下载）。
 *
 * 本仓老教训：诊断行写死会让误报与真错同形——所以每条通道失败的原因都带回去。
 *
 * ## 「校验」到底验什么
 *
 * 网上流传的「下载完比一下 sha256」在这里有个陷阱：**哈希本身从哪来？**
 * 若哈希也从同一个被劫持的通道取，那只是把信任问题挪了个位置。
 *
 * 做法是：发版时把 tgz 的 sha256 写进 **Release 正文**（正文与附件是两条不同的
 * 下载路径，且正文同时进 git 历史）。更新器从正文里解析出这个锚点，再比对下载到的字节。
 * 正文里没有哈希（老版本）时，退化成**结构校验**：gzip 解得开、tar 里有
 * `package/package.json`、其中的 `name` 与 `version` 与这次要装的版本一致。
 * 这一档**明确标成「未校验哈希」**，不假装验过了。
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { atomicWrite } from './docfs.js'
import { settingsDir } from './settings.js'

/**
 * 本插件**当前装着的**版本号（从自己的 `package.json` 读）。
 *
 * 为什么不写成常量：写常量就要在每次发版时记得改两处，而忘改的后果是
 * 「永远显示有更新」——用户点了更新、装完还是同一个版本号，那是最烦人的一类假报。
 * 从包里读，`npm pack` 装的是哪一版就报哪一版，机制上不可能漂移。
 *
 * 读不到返回空串：调用方据此说「不知道当前版本」，而不是编一个 `0.0.0`。
 */
export function pluginVersion() {
  let text = null
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    text = readFileSync(join(here, '..', 'package.json'), 'utf8')
  } catch (_error) {
    return ''
  }
  try {
    const json = JSON.parse(text)
    return json !== null && typeof json === 'object' ? normalizeVersion(json.version) : ''
  } catch (_error) {
    return ''
  }
}

/** 插件自己的仓库（`owner/name`）。更新只认它。 */
export const UPDATE_REPO = 'liancha22/dsh-puzzle-mode'

/** 本插件的包名。结构校验时用它核对「下到的确实是这个插件」。 */
export const UPDATE_PACKAGE_NAME = 'dsh-puzzle-mode'

/** 单次网络请求超时（毫秒）。比主题那条宽松：Release 正文可能很长。 */
export const UPDATE_FETCH_TIMEOUT_MS = 12000

/**
 * 「各个版本的更新日志」一次列多少个（用户裁定：从 Release 列表 API 拉）。
 *
 * 取 20：够翻到「我装的那版和现在的差别」，又不至于让面板一次渲染几百条。
 */
export const RELEASE_LIST_LIMIT = 20

/**
 * 面板上每版摘要最多显示几行（用户裁定「每版最多 3 行摘要，不展开」）。
 *
 * 为什么在**宿主半**截、而不是在面板截：面板只管渲染，截断规则属于
 * 「这份数据长什么样」，放在这里就能被测试直接钉住（`130-updater` 断言行数与省略标记）。
 * 在面板截的话，那条规则只有真机点开才验得到。
 */
export const RELEASE_SUMMARY_LINES = 3

/** 下载 tgz 的超时：附件约 450KB，给足时间。 */
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 60000

/** tgz 体积上限。正常约 450KB；超过 8MB 只可能是下到了别的东西（比如 HTML 错误页）。 */
export const MAX_TARBALL_BYTES = 8 * 1024 * 1024

/** 暂存目录名（在 `$DSH_HOME` 下）。 */
export const UPDATE_DIR_NAME = 'puzzle-mode-updates'

/** 检查结果里的状态取值。 */
export const UPDATE_STATE_NEWER = 'newer'
export const UPDATE_STATE_LATEST = 'latest'
export const UPDATE_STATE_AHEAD = 'ahead'

/**
 * 取文本的通道顺序。第一个成功即返回，失败的记进 `tried`。
 *
 * `kind` 只影响**怎么解析**：`api` 回 JSON、`jsdelivr` 回仓库里的原文。
 */
export const UPDATE_INFO_CHANNELS = [
  {
    key: 'api',
    label: 'GitHub API',
    kind: 'release',
    url: (repo) => `https://api.github.com/repos/${repo}/releases/latest`,
  },
  {
    key: 'gh-proxy-api',
    label: 'gh-proxy 镜像',
    kind: 'release',
    url: (repo) => `https://gh-proxy.com/https://api.github.com/repos/${repo}/releases/latest`,
  },
]

/**
 * 取**版本列表**的通道（用户裁定「要有个地方看各个版本的更新日志」，来源是 Release 列表 API）。
 *
 * 与 `UPDATE_INFO_CHANNELS` 分开：那个要的是 `releases/latest`（单个对象），
 * 这个要的是 `releases`（数组）。地址不同、解析不同，混用一个函数会让两边都难读。
 */
export const RELEASE_LIST_CHANNELS = [
  {
    key: 'api',
    label: 'GitHub API',
    url: (repo, limit) => `https://api.github.com/repos/${repo}/releases?per_page=${limit}`,
  },
  {
    key: 'gh-proxy-api',
    label: 'gh-proxy 镜像',
    url: (repo, limit) => `https://gh-proxy.com/https://api.github.com/repos/${repo}/releases?per_page=${limit}`,
  },
]

/** 下载附件的通道顺序（`{url}` 是原始附件地址）。 */
export const ASSET_CHANNELS = [
  { key: 'direct', label: 'GitHub 直连', url: (url) => url },
  { key: 'gh-proxy', label: 'gh-proxy 镜像', url: (url) => `https://gh-proxy.com/${url}` },
]

/** jsDelivr 回退：拿仓库文件（`main` 分支）。 */
export function jsdelivrUrl(relPath, repo = UPDATE_REPO) {
  return `https://cdn.jsdelivr.net/gh/${repo}@main/${relPath}`
}

/** 更新暂存根目录。 */
export function updatesDir() {
  return join(settingsDir(), UPDATE_DIR_NAME)
}

/** 某个版本的暂存目录。`version` 已过 `normalizeVersion`，不含路径符号。 */
export function stagedDirOf(version) {
  return join(updatesDir(), normalizeVersion(version))
}

/** 某个版本暂存下来的 tgz 路径。 */
export function stagedTarballPath(version) {
  return join(stagedDirOf(version), `${UPDATE_PACKAGE_NAME}-${normalizeVersion(version)}.tgz`)
}

/**
 * 版本号规范化：去掉前导 `v`、去掉 `+build` 后缀。
 *
 * 为什么必须收口：Release 的 `tag_name` 是 `v1.0.0`，而 `package.json` 的 `version`
 * 是 `1.0.0`。两者不规范化就直接比，会把同一个版本判成「有更新」——那是最烦人的
 * 一类假报（用户点了更新，装完发现还是同一个版本）。
 */
export function normalizeVersion(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const stripped = text.replace(/^[vV]/, '')
  const plus = stripped.indexOf('+')
  return plus >= 0 ? stripped.slice(0, plus) : stripped
}

/**
 * 版本号比较。返回 `-1` / `0` / `1`。
 *
 * 为什么自己写而不是引依赖：本插件零运行时依赖是硬约束，而这里要的语义很窄——
 * `major.minor.patch` 数值比较，预发布段（`-alpha.1`）**小于**同号正式版。
 * 比较不出来（形状不认识）时返回 `0`：宁可判「一样」，也不要凭空报一个「有新版」。
 */
export function compareVersions(a, b) {
  const parse = (value) => {
    const text = normalizeVersion(value)
    if (text === '') return null
    const dash = text.indexOf('-')
    const core = dash >= 0 ? text.slice(0, dash) : text
    const pre = dash >= 0 ? text.slice(dash + 1) : ''
    const nums = core.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : NaN))
    if (nums.length === 0 || nums.some((n) => Number.isNaN(n))) return null
    return { nums, pre }
  }
  const left = parse(a)
  const right = parse(b)
  if (left === null || right === null) return 0
  const len = Math.max(left.nums.length, right.nums.length)
  for (let i = 0; i < len; i += 1) {
    const l = left.nums[i] ?? 0
    const r = right.nums[i] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  // 正式版 > 预发布版：`1.0.0` 比 `1.0.0-rc.1` 新。
  if (left.pre === '' && right.pre !== '') return 1
  if (left.pre !== '' && right.pre === '') return -1
  if (left.pre === right.pre) return 0
  return left.pre < right.pre ? -1 : 1
}

/** `latest` 是否比 `current` 新。 */
export function isNewerVersion(latest, current) {
  return compareVersions(latest, current) > 0
}

/**
 * 从 Release 正文里解析发版时写下的 sha256 锚点。
 *
 * 认两种写法（发版脚本写的是第一种，宽松一点也认第二种，方便手工补）：
 *   `sha256: 0502bffa...`（64 位十六进制）
 *   `sha256=<64 位十六进制>`
 *
 * **大小写都要认**（正则带 `i` 标志），且结果统一回小写。
 * 关键字与十六进制两处都得宽：GitHub 的附件字段给的是大写十六进制，
 * 发版脚本手写时关键字也可能写成 `SHA256:`。任一处只认小写，锚点就会解析成空串——
 * 那会**静默退化**成「未校验哈希」，看起来一切正常，实际少了一道校验。
 *
 * 找不到返回空串——调用方据此退化成结构校验，并**如实标成未校验**。
 */
export function sha256FromNotes(body) {
  const text = typeof body === 'string' ? body : ''
  const match = text.match(/sha256\s*[:=]\s*([0-9a-fA-F]{64})/i)
  return match === null ? '' : match[1].toLowerCase()
}

/**
 * 把 GitHub API 的 `releases/latest` 响应规范化。
 *
 * 只取要用的字段，且每个都做形状校验——响应是**外部输入**，缺字段时不能让它
 * 一路飘到面板上去渲染 `undefined`。
 */
export function releaseInfoOf(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, error: 'Release 响应不是一个对象' }
  }
  const tag = typeof json.tag_name === 'string' ? json.tag_name.trim() : ''
  if (tag === '') return { ok: false, error: 'Release 响应缺 tag_name' }
  const assets = []
  if (Array.isArray(json.assets)) {
    for (const raw of json.assets) {
      if (raw === null || typeof raw !== 'object') continue
      const name = typeof raw.name === 'string' ? raw.name : ''
      const url = typeof raw.browser_download_url === 'string' ? raw.browser_download_url : ''
      if (name === '' || url === '') continue
      assets.push({
        name,
        url,
        size: typeof raw.size === 'number' && Number.isFinite(raw.size) ? raw.size : 0,
        sha256: typeof raw.sha256 === 'string' ? raw.sha256.toLowerCase() : '',
      })
    }
  }
  return {
    ok: true,
    tag,
    version: normalizeVersion(tag),
    name: typeof json.name === 'string' ? json.name.trim() : '',
    body: typeof json.body === 'string' ? json.body : '',
    htmlUrl: typeof json.html_url === 'string' ? json.html_url : '',
    publishedAt: typeof json.published_at === 'string' ? json.published_at : '',
    prerelease: json.prerelease === true,
    draft: json.draft === true,
    assets,
  }
}

/**
 * 从 `CHANGELOG.md` 全文里取出**某个版本那一节**。
 *
 * 本仓 CHANGELOG 的形状是 `### v0.30.0 · 标题` 起、到下一个 `### ` 或 `## ` 止。
 * 取不到就返回空串（面板显示「这一版没有单独的更新说明」），不要瞎猜一段贴上去。
 */
export function changelogSectionOf(text, version) {
  const wanted = normalizeVersion(version)
  if (wanted === '' || typeof text !== 'string') return ''
  const lines = text.split(/\r?\n/)
  const isHeading = (line) => /^#{2,4}\s/.test(line)
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (!isHeading(lines[i])) continue
    const found = lines[i].match(/v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/)
    if (found === null) continue
    if (normalizeVersion(found[1]) !== wanted) continue
    start = i
    break
  }
  if (start < 0) return ''
  const out = [lines[start]]
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isHeading(lines[i])) break
    out.push(lines[i])
  }
  return out.join('\n').trim()
}

/**
 * 解析 tar 归档（**纯函数**，不碰 fs）。
 *
 * 为什么自己解而不用 `tar` 命令：本插件零运行时依赖，且 `tar` 在 Windows 上
 * 是 Windows 10 1803+ 才自带——少一个平台假设就少一类「在我机器上能用」。
 * tar 的头部格式很窄（512 字节块 + 八进制长度），够用且可测。
 *
 * 只认普通文件（`0` / `\0`）与目录（`5`）。**符号链接 / 硬链接一律不认**——
 * 它们是「解包逃逸」最经典的载体（先建一个指向 `/` 的软链，再往里写）。
 */
export function parseTar(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  const entries = []
  let offset = 0
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    // 全零块 = 归档结束（标准 tar 用两个空块收尾）。
    let allZero = true
    for (const byte of header) {
      if (byte !== 0) {
        allZero = false
        break
      }
    }
    if (allZero) break

    const readString = (from, to) => {
      const slice = header.subarray(from, to)
      const end = slice.indexOf(0)
      return slice.subarray(0, end < 0 ? slice.length : end).toString('utf8').trim()
    }
    const name = readString(0, 100)
    const sizeText = readString(124, 136).replace(/\0/g, '').trim()
    const typeFlag = String.fromCharCode(header[156] || 48)
    // 前缀字段（ustar）：长路径被拆成 prefix + name。
    const prefix = readString(345, 500)
    const fullName = prefix === '' ? name : `${prefix}/${name}`
    const size = /^[0-7]+$/.test(sizeText) ? parseInt(sizeText, 8) : 0

    const bodyStart = offset + 512
    const bodyEnd = bodyStart + size
    if (bodyEnd > buf.length) {
      return { ok: false, error: 'tar 归档被截断（头部声明的长度超过了实际字节数）' }
    }
    if (typeFlag === '0' || typeFlag === '\u0000' || typeFlag === '') {
      entries.push({ name: fullName, size, type: 'file', data: buf.subarray(bodyStart, bodyEnd) })
    } else if (typeFlag === '5') {
      entries.push({ name: fullName, size: 0, type: 'dir', data: buf.subarray(0, 0) })
    } else if (typeFlag === '1' || typeFlag === '2') {
      return { ok: false, error: `tar 归档里有链接项（${typeFlag === '1' ? '硬链接' : '符号链接'}），拒绝解包` }
    }
    // 其它类型（PAX 扩展头 `x` / `g`、GNU 长名 `L`）跳过：npm 打的包用不到它们，
    // 真出现了也不该被当成文件内容写下去。
    offset = bodyStart + Math.ceil(size / 512) * 512
  }
  return { ok: true, entries }
}

/**
 * 判断一个 tar 里的条目名能不能安全地落到 `destDir` 下。
 *
 * 这是整个更新路径上**唯一的攻击面**（解压一个从网上下来的归档），所以逐条拦：
 *   - 绝对路径（`/x`、`C:\x`）——会写到解压目录之外；
 *   - `..` 段——最经典的穿越；
 *   - 反斜杠——Windows 上 `..\..\` 同样是穿越，只查 `/` 会漏掉；
 *   - 空名 / 只剩 `/`——写出来是个目录，没有意义。
 *
 * 返回 `true` 表示安全。判定放在一个函数里，是为了让它能被单独测（含变异验证）。
 */
export function isSafeTarPath(name) {
  if (typeof name !== 'string' || name.trim() === '') return false
  const raw = name.replace(/\\/g, '/')
  if (raw.startsWith('/')) return false
  if (/^[A-Za-z]:/.test(raw)) return false
  const parts = raw.split('/')
  for (const part of parts) {
    if (part === '..') return false
  }
  return true
}

/**
 * 把 tgz 解到目标目录。
 *
 * 顺序：**先全量校验路径，再落盘**。先解一半再发现有问题，就会留下半个目录
 * （本仓对「装了一半」的态度一贯是：宁可不写，也不要留脏状态）。
 */
export function extractTarball(gzBuffer, destDir) {
  let tar = null
  try {
    tar = gunzipSync(gzBuffer)
  } catch (_error) {
    return { ok: false, error: '不是合法的 gzip 数据（可能下到了 HTML 错误页）' }
  }
  const parsed = parseTar(tar)
  if (parsed.ok !== true) return parsed
  for (const entry of parsed.entries) {
    if (!isSafeTarPath(entry.name)) {
      return { ok: false, error: `归档里的路径不安全，拒绝解包：${String(entry.name).slice(0, 80)}` }
    }
  }
  const files = []
  for (const entry of parsed.entries) {
    // npm 打的包里顶层是 `package/`，剥掉它，落盘就是插件目录本身。
    const rel = entry.name.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.').join('/')
    const stripped = rel.startsWith('package/') ? rel.slice('package/'.length) : rel
    if (stripped === '') continue
    const target = join(destDir, stripped.split('/').join(sep))
    // 二次确认：拼出来的绝对路径必须仍在 destDir 里。`isSafeTarPath` 已经拦过，
    // 这里是「哪怕前面判断写错了也兜得住」的那一道（`join` 会规范化，可能改变层级）。
    const resolved = normalize(target)
    const base = normalize(destDir)
    if (resolved !== base && !resolved.startsWith(base + sep)) {
      return { ok: false, error: `归档条目会写到暂存目录之外，拒绝解包：${String(entry.name).slice(0, 80)}` }
    }
    if (entry.type === 'dir') {
      mkdirSync(target, { recursive: true })
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.data)
    files.push(stripped)
  }
  return { ok: true, files, count: files.length }
}

/** 十六进制 sha256（对字节）。 */
export function sha256OfBytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * 带超时取二进制。**不抛错**，失败一律 `{ok:false}` 带原因。
 *
 * 先看 `content-length` 再读：`MAX_TARBALL_BYTES` 的意义是「别把内存吃光」，
 * 等读完再判体积就已经晚了——那正是本仓记过的「先全读进来再检查大小」的错法。
 */
async function fetchBinary(url, maxBytes, timeoutMs) {
  let response = null
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/octet-stream,application/gzip,*/*' },
    })
  } catch (error) {
    const name = error && error.name ? String(error.name) : ''
    const message = error && error.message ? String(error.message) : String(error)
    return { ok: false, error: name === 'TimeoutError' || name === 'AbortError' ? '请求超时' : '请求失败：' + message }
  }
  if (response.status !== 200) return { ok: false, error: 'HTTP ' + response.status }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, error: `体积超限（${declared} > ${maxBytes} 字节）` }
  }
  let buffer = null
  try {
    buffer = Buffer.from(await response.arrayBuffer())
  } catch (_error) {
    return { ok: false, error: '读响应失败' }
  }
  if (buffer.length > maxBytes) {
    return { ok: false, error: `体积超限（${buffer.length} > ${maxBytes} 字节）` }
  }
  return { ok: true, buffer }
}

/** 带超时取文本（Release 正文可能很长，上限单独给）。 */
async function fetchTextAt(url, maxBytes, timeoutMs) {
  let response = null
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json,text/plain,*/*' },
    })
  } catch (error) {
    const name = error && error.name ? String(error.name) : ''
    const message = error && error.message ? String(error.message) : String(error)
    return { ok: false, error: name === 'TimeoutError' || name === 'AbortError' ? '请求超时' : '请求失败：' + message }
  }
  if (response.status !== 200) return { ok: false, error: 'HTTP ' + response.status }
  let text = ''
  try {
    text = await response.text()
  } catch (_error) {
    return { ok: false, error: '读响应失败' }
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > maxBytes) return { ok: false, error: `体积超限（${bytes} > ${maxBytes} 字节）` }
  return { ok: true, text }
}

/**
 * 查有没有新版本。**从不抛错**。
 *
 * 返回形状（面板直接渲染）：
 *   `{ ok, current, latest, state, hasUpdate, notes, notesSource, htmlUrl, publishedAt, assets, channel, tried, error }`
 *
 * `state` 三档：`newer`（有新版）/ `latest`（已是最新）/ `ahead`（本机比线上新，
 * 说明装的是未发布的提交——如实说出来，不要报成「有更新」）。
 */
export async function checkUpdate(options = {}) {
  const repo = typeof options.repo === 'string' && options.repo.trim() !== '' ? options.repo.trim() : UPDATE_REPO
  const current = normalizeVersion(options.current)
  const tried = []

  for (const channel of UPDATE_INFO_CHANNELS) {
    const url = channel.url(repo)
    const got = await fetchTextAt(url, 512 * 1024, UPDATE_FETCH_TIMEOUT_MS)
    if (got.ok !== true) {
      tried.push({ channel: channel.key, url, error: got.error })
      continue
    }
    let json = null
    try {
      json = JSON.parse(got.text)
    } catch (_error) {
      tried.push({ channel: channel.key, url, error: '响应不是合法 JSON' })
      continue
    }
    const info = releaseInfoOf(json)
    if (info.ok !== true) {
      tried.push({ channel: channel.key, url, error: info.error })
      continue
    }
    const cmp = compareVersions(info.version, current)
    const state = cmp > 0 ? UPDATE_STATE_NEWER : cmp < 0 ? UPDATE_STATE_AHEAD : UPDATE_STATE_LATEST
    const tarball = info.assets.find((asset) => asset.name.endsWith('.tgz')) ?? null
    return {
      ok: true,
      current,
      latest: info.version,
      tag: info.tag,
      state,
      hasUpdate: state === UPDATE_STATE_NEWER,
      notes: info.body,
      notesSource: 'release',
      anchorSha256: sha256FromNotes(info.body),
      htmlUrl: info.htmlUrl,
      publishedAt: info.publishedAt,
      prerelease: info.prerelease,
      tarball,
      assets: info.assets,
      channel: channel.key,
      tried,
      checkedAt: new Date().toISOString(),
    }
  }

  // 回退：jsDelivr 拉仓库里的 package.json + CHANGELOG.md。够回答「有没有新版、
  // 改了啥」，但**没有附件地址**——面板要如实说「去 Release 页下载」，不能给个死按钮。
  const pkgUrl = jsdelivrUrl('package.json', repo)
  const pkg = await fetchTextAt(pkgUrl, 256 * 1024, UPDATE_FETCH_TIMEOUT_MS)
  if (pkg.ok !== true) {
    tried.push({ channel: 'jsdelivr', url: pkgUrl, error: pkg.error })
    return { ok: false, error: '所有通道都失败了', current, tried, repo }
  }
  let parsedPkg = null
  try {
    parsedPkg = JSON.parse(pkg.text)
  } catch (_error) {
    parsedPkg = null
  }
  const latest = normalizeVersion(parsedPkg !== null && typeof parsedPkg === 'object' ? parsedPkg.version : '')
  if (latest === '') {
    return { ok: false, error: 'jsDelivr 上的 package.json 里读不到 version', current, tried, repo }
  }
  const clUrl = jsdelivrUrl('CHANGELOG.md', repo)
  const cl = await fetchTextAt(clUrl, 1024 * 1024, UPDATE_FETCH_TIMEOUT_MS)
  let notes = ''
  if (cl.ok === true) notes = changelogSectionOf(cl.text, latest)
  else tried.push({ channel: 'jsdelivr-changelog', url: clUrl, error: cl.error })
  const cmp = compareVersions(latest, current)
  const state = cmp > 0 ? UPDATE_STATE_NEWER : cmp < 0 ? UPDATE_STATE_AHEAD : UPDATE_STATE_LATEST
  return {
    ok: true,
    current,
    latest,
    tag: 'v' + latest,
    state,
    hasUpdate: state === UPDATE_STATE_NEWER,
    notes,
    notesSource: notes === '' ? 'none' : 'changelog',
    anchorSha256: '',
    htmlUrl: `https://github.com/${repo}/releases`,
    publishedAt: '',
    prerelease: false,
    // 这条通道拿不到附件：面板据此只给「打开 Release 页」，不给「下载」。
    tarball: null,
    assets: [],
    channel: 'jsdelivr',
    tried,
    checkedAt: new Date().toISOString(),
    hint: '这条通道只能看到版本与更新日志，下载请打开 Release 页',
  }
}

/**
 * 下载并解包到暂存区。**不安装**（见文件头）。
 *
 * 校验顺序刻意是「先比哈希、再解包」：解包是唯一会写盘的一步，在它之前把
 * 字节定死，就不存在「解了一个不该解的包」。
 *
 * 返回里的 `verified` 三档：
 *   - `sha256`：正文里有锚点且比对通过（**强校验**）；
 *   - `structural`：正文里没有锚点，退化成「gzip 能解 + 包名与版本对得上」；
 *   - `''`：没验（只有 `ok:false` 时才可能出现）。
 */
export async function downloadUpdate(version, options = {}) {
  const target = normalizeVersion(version)
  if (target === '') return { ok: false, error: '版本号为空' }
  const repo = typeof options.repo === 'string' && options.repo.trim() !== '' ? options.repo.trim() : UPDATE_REPO
  const info = options.info !== undefined && options.info !== null ? options.info : null
  const assetUrl = typeof options.assetUrl === 'string' && options.assetUrl !== ''
    ? options.assetUrl
    : info !== null && info.tarball !== null && info.tarball !== undefined ? info.tarball.url : ''
  const expectedSize = info !== null && info.tarball !== null && info.tarball !== undefined ? info.tarball.size : 0
  if (assetUrl === '') {
    return { ok: false, error: '没有附件地址', hint: '这条通道拿不到 tgz，请打开 Release 页手动下载' }
  }
  const tried = []
  let buffer = null
  let usedChannel = ''
  for (const channel of ASSET_CHANNELS) {
    const url = channel.url(assetUrl)
    const got = await fetchBinary(url, MAX_TARBALL_BYTES, UPDATE_DOWNLOAD_TIMEOUT_MS)
    if (got.ok === true) {
      buffer = got.buffer
      usedChannel = channel.key
      break
    }
    tried.push({ channel: channel.key, url, error: got.error })
  }
  if (buffer === null) return { ok: false, error: '所有通道都失败了', tried, repo }

  const actual = sha256OfBytes(buffer)
  const anchor = typeof options.anchorSha256 === 'string' ? options.anchorSha256.toLowerCase() : ''
  if (anchor !== '') {
    if (actual !== anchor) {
      return {
        ok: false,
        error: 'sha256 与 Release 正文里的锚点不符，拒绝解包',
        hint: `正文写 ${anchor.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`,
        sha256: actual,
        tried,
      }
    }
  }
  // 结构校验：解包前先看 gzip 能不能开、包里是不是这个插件、版本对不对。
  let tar = null
  try {
    tar = gunzipSync(buffer)
  } catch (_error) {
    return { ok: false, error: '不是合法的 gzip 数据（可能下到了 HTML 错误页）', sha256: actual, tried }
  }
  const parsed = parseTar(tar)
  if (parsed.ok !== true) return { ok: false, error: parsed.error, sha256: actual, tried }
  const pkgEntry = parsed.entries.find((entry) => entry.type === 'file' && /^package\/package\.json$/.test(entry.name.replace(/\\/g, '/')))
  if (pkgEntry === undefined) {
    return { ok: false, error: '归档里没有 package/package.json，不像是本插件的发布包', sha256: actual, tried }
  }
  let pkg = null
  try {
    pkg = JSON.parse(pkgEntry.data.toString('utf8'))
  } catch (_error) {
    return { ok: false, error: '归档里的 package.json 不是合法 JSON', sha256: actual, tried }
  }
  const name = pkg !== null && typeof pkg === 'object' ? String(pkg.name ?? '') : ''
  const got = normalizeVersion(pkg !== null && typeof pkg === 'object' ? pkg.version : '')
  if (name !== UPDATE_PACKAGE_NAME) {
    return { ok: false, error: `归档里的包名是 ${name || '(空)'}，不是 ${UPDATE_PACKAGE_NAME}`, sha256: actual, tried }
  }
  if (got !== target) {
    return { ok: false, error: `归档里的版本是 ${got || '(空)'}，与要装的 ${target} 不一致`, sha256: actual, tried }
  }
  if (Number.isFinite(expectedSize) && expectedSize > 0 && buffer.length !== expectedSize) {
    return {
      ok: false,
      error: `字节数与 Release 声明的不符（${buffer.length} ≠ ${expectedSize}）`,
      sha256: actual,
      tried,
    }
  }

  // 落盘：先把暂存目录清干净（半旧的目录比空目录更难查）。
  const dir = stagedDirOf(target)
  try {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    return { ok: false, error: '建暂存目录失败：' + String(error && error.message ? error.message : error), sha256: actual }
  }
  const tarballPath = stagedTarballPath(target)
  try {
    writeFileSync(tarballPath, buffer)
  } catch (error) {
    return { ok: false, error: '写 tgz 失败：' + String(error && error.message ? error.message : error), sha256: actual }
  }
  const extracted = extractTarball(buffer, dir)
  if (extracted.ok !== true) {
    return { ok: false, error: extracted.error, sha256: actual, dir }
  }
  atomicWrite(
    join(dir, 'update.json'),
    JSON.stringify({
      version: target,
      sha256: actual,
      anchorSha256: anchor,
      verified: anchor === '' ? 'structural' : 'sha256',
      channel: usedChannel,
      repo,
      url: assetUrl,
      bytes: buffer.length,
      downloadedAt: new Date().toISOString(),
    }, null, 2) + '\n',
  )
  return {
    ok: true,
    version: target,
    dir,
    tarballPath,
    bytes: buffer.length,
    sha256: actual,
    anchorSha256: anchor,
    verified: anchor === '' ? 'structural' : 'sha256',
    channel: usedChannel,
    files: extracted.count,
    tried,
  }
}

/**
 * 找出**装着本插件的那个 profile 目录**。
 *
 * 为什么需要它：更新命令必须在 profile 目录里跑（`pnpm add` 改的是那个
 * `package.json`）。让用户自己找路径，等于把「一键」变成「先做一道题」。
 *
 * 扫 `$DSH_HOME/profiles/<名字>/package.json`，看哪个的 dependencies 里有本插件。
 * 找不到返回空串——面板据此给出**不带 cd 的命令**并说明原因，而不是编一个路径。
 */
export function profileDirOf() {
  const base = join(settingsDir(), 'profiles')
  let names = []
  try {
    names = readdirSync(base)
  } catch (_error) {
    return ''
  }
  const found = []
  for (const name of names) {
    const file = join(base, name, 'package.json')
    let text = null
    try {
      text = readFileSync(file, 'utf8')
    } catch (_error) {
      continue
    }
    let json = null
    try {
      json = JSON.parse(text)
    } catch (_error) {
      continue
    }
    const deps = json !== null && typeof json === 'object' && json.dependencies !== null && typeof json.dependencies === 'object'
      ? json.dependencies
      : {}
    if (Object.prototype.hasOwnProperty.call(deps, UPDATE_PACKAGE_NAME)) found.push(join(base, name))
  }
  // 多于一个时取**路径字典序最后**的那个：DSH 的 profile 目录名通常带环境后缀，
  // 排在后面的一般是更晚建的。这里不猜「哪个在用」——面板会把路径原样显示出来，
  // 用户一眼能看出对不对，猜错了也只是复制粘贴前改一个字。
  found.sort()
  return found.length === 0 ? '' : found[found.length - 1]
}

/**
 * 生成安装命令（**纯函数**，便于测试与变异验证）。
 *
 * 用 `github:` 规格而不是本地 tgz 路径：profile 里原本就是
 * `github:liancha22/dsh-puzzle-mode#<sha>`，沿用同一族规格，升级后
 * `package.json` 的形状不变；若改成 `file:` 路径，那个路径一被清理
 * 依赖就悬空了，下次 `pnpm install` 直接失败。
 */
export function installCommandOf(version, options = {}) {
  const tag = typeof options.tag === 'string' && options.tag.trim() !== '' ? options.tag.trim() : 'v' + normalizeVersion(version)
  const repo = typeof options.repo === 'string' && options.repo.trim() !== '' ? options.repo.trim() : UPDATE_REPO
  const profile = typeof options.profile === 'string' ? options.profile : ''
  const spec = `${UPDATE_PACKAGE_NAME}@github:${repo}#${tag}`
  const lines = []
  if (profile !== '') lines.push(`cd "${profile}"`)
  lines.push(`pnpm add ${spec}`)
  return { spec, tag, profile, command: lines.join('\n'), text: lines.join('\n') }
}

/**
 * 暂存区里现在有哪些版本（诊断用）。只读，坏目录跳过。
 */
export function stagedVersions() {
  let names = []
  try {
    names = readdirSync(updatesDir())
  } catch (_error) {
    return []
  }
  const out = []
  for (const name of names) {
    const dir = join(updatesDir(), name)
    let isDir = false
    try {
      isDir = statSync(dir).isDirectory()
    } catch (_error) {
      continue
    }
    if (!isDir) continue
    let meta = null
    try {
      meta = JSON.parse(readFileSync(join(dir, 'update.json'), 'utf8'))
    } catch (_error) {
      meta = null
    }
    out.push({ version: name, dir, meta })
  }
  out.sort((a, b) => compareVersions(a.version, b.version))
  return out
}

/* --------------------------- 各版本更新日志（v1.0.1） --------------------------- */

/**
 * 把一段 markdown 压成**最多 N 行**的摘要（用户裁定「每版最多 3 行摘要，不展开」）。
 *
 * ## 为什么必须在这里做，而不是把正文整段丢给面板
 *
 * 用户的原话是「**要洁简，不要一大堆字**」。v1.0.0 的更新页把整篇 Release 正文
 * 原样铺出来（实测 6194 字符），一屏放不下一个版本——那不叫看日志，那叫读文档。
 *
 * 规则（每条都有理由）：
 *   - 丢掉**标题行**（`#` 开头）：列表里已经有版本号与标题了，重复一次纯占地方；
 *   - 丢掉空行与**分隔线**（`---`）：它们只是排版，压成摘要后没意义；
 *   - 丢掉纯图片行：`![...](...)` 在纯文本摘要里就是一行乱码；
 *   - 表格行**保留**但压平（`| a | b |` → `a · b`）：发版正文里的关键信息常在表里，
 *     整行丢掉会漏掉「改了什么」；压平后还能读。
 *   - 列表符号统一成 `·`：`-` / `*` / `1.` 混着出现时视觉很乱。
 *
 * 超出行数时**不静默截断**——末尾加一句「…（还有 N 行，点开看全文）」。
 * 静默截断会让人以为这版就这么点内容。
 */
export function summarizeNotes(body, maxLines = RELEASE_SUMMARY_LINES) {
  const text = typeof body === 'string' ? body : ''
  const limit = Number.isSafeInteger(maxLines) && maxLines > 0 ? maxLines : RELEASE_SUMMARY_LINES
  const lines = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('#')) continue
    if (/^-{3,}$/.test(line) || /^\*{3,}$/.test(line)) continue
    if (/^!\[/.test(line)) continue
    let clean = line
    if (clean.startsWith('|')) {
      // 表格行：拆单元格、去掉分隔行（`|---|---|`）、用 ` · ` 连起来。
      const cells = clean.split('|').map((one) => one.trim()).filter((one) => one !== '')
      if (cells.every((one) => /^:?-{2,}:?$/.test(one))) continue
      clean = cells.join(' · ')
    }
    clean = clean.replace(/^[-*+]\s+/, '· ').replace(/^\d+\.\s+/, '· ')
    // 行内 markdown 记号在纯文本里只是噪音：`**粗**` → `粗`、`` `代码` `` → `代码`。
    clean = clean.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
    if (clean === '') continue
    lines.push(clean)
  }
  const head = lines.slice(0, limit)
  const rest = lines.length - head.length
  return { lines: head, total: lines.length, rest, truncated: rest > 0 }
}

/**
 * 把 Release 列表响应规范化成「每个版本一条」。
 *
 * 只取要用的字段，且每个都做形状校验——响应是**外部输入**，缺字段不能让它
 * 一路飘到面板上渲染 `undefined`。`draft`（草稿）直接丢掉：它不是给用户看的版本。
 */
export function releaseListOf(json, options = {}) {
  if (!Array.isArray(json)) return { ok: false, error: 'Release 列表不是一个数组' }
  const current = normalizeVersion(options.current)
  const maxLines = Number.isSafeInteger(options.maxLines) ? options.maxLines : RELEASE_SUMMARY_LINES
  const releases = []
  for (const raw of json) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    if (raw.draft === true) continue
    const tag = typeof raw.tag_name === 'string' ? raw.tag_name.trim() : ''
    if (tag === '') continue
    const version = normalizeVersion(tag)
    const notes = summarizeNotes(typeof raw.body === 'string' ? raw.body : '', maxLines)
    releases.push({
      tag,
      version,
      name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : tag,
      // 摘要（面板默认显示的就是它）与原文（点开才要）都给，面板不必再解析 markdown。
      summary: notes.lines,
      summaryTotal: notes.total,
      summaryRest: notes.rest,
      summaryTruncated: notes.truncated,
      body: typeof raw.body === 'string' ? raw.body : '',
      publishedAt: typeof raw.published_at === 'string' ? raw.published_at : '',
      htmlUrl: typeof raw.html_url === 'string' ? raw.html_url : '',
      prerelease: raw.prerelease === true,
      anchorSha256: sha256FromNotes(typeof raw.body === 'string' ? raw.body : ''),
      // 面板据此把「当前装的那版」标出来——列表里没有这个标记，用户就得自己找。
      current: current !== '' && version === current,
    })
  }
  releases.sort((a, b) => compareVersions(b.version, a.version))
  return { ok: true, releases, count: releases.length }
}

/**
 * 拉各版本的更新日志（Release 列表 API，带镜像回退）。
 *
 * **从不抛错**：失败一律 `{ok:false, error, tried}`，面板据此显示「拉不到 + 各通道报了什么」。
 * 本仓老教训：诊断行写死会让误报与真错同形。
 */
export async function fetchReleaseList(options = {}) {
  const repo = typeof options.repo === 'string' && options.repo.trim() !== '' ? options.repo.trim() : UPDATE_REPO
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : RELEASE_LIST_LIMIT
  const current = normalizeVersion(options.current)
  const tried = []
  for (const channel of RELEASE_LIST_CHANNELS) {
    const url = channel.url(repo, limit)
    const got = await fetchTextAt(url, 2 * 1024 * 1024, UPDATE_FETCH_TIMEOUT_MS)
    if (got.ok !== true) {
      tried.push({ channel: channel.key, url, error: got.error })
      continue
    }
    let json = null
    try {
      json = JSON.parse(got.text)
    } catch (_error) {
      tried.push({ channel: channel.key, url, error: '响应不是合法 JSON' })
      continue
    }
    const parsed = releaseListOf(json, { current, maxLines: options.maxLines })
    if (parsed.ok !== true) {
      tried.push({ channel: channel.key, url, error: parsed.error })
      continue
    }
    return { ok: true, releases: parsed.releases, count: parsed.count, channel: channel.key, tried, repo, fetchedAt: new Date().toISOString() }
  }
  return { ok: false, error: '所有通道都失败了', tried, repo }
}

/* ------------------------------- 谁来装（v1.0.1） ------------------------------- */

/** 更新器的文件名（它会被复制到 `$DSH_HOME` 下再执行）。 */
export const UPDATER_SCRIPT = 'dsh-puzzle-update.mjs'

/**
 * 更新器脚本在本机的位置（`$DSH_HOME/puzzle-mode-updates/`）。
 *
 * ## 为什么必须复制出去再跑（这是这一版最关键的一个设计）
 *
 * 这个脚本要干的事是「替换插件自己的文件」。如果它住在插件目录里，就会出现一个
 * **无法自救的死局**：装到一半 `node_modules/dsh-puzzle-mode` 被写坏 → 脚本自己也跟着没了
 * → 回退逻辑不复存在，用户只剩手改 `package.json`。
 *
 * 所以每次运行前先把它复制到 `$DSH_HOME` 下（那不属于任何包，装什么都不会动它），
 * 再从那里执行。
 */
export function updaterScriptPath() {
  return join(updatesDir(), UPDATER_SCRIPT)
}

/** 运行结果文件（面板轮询它拿进度与结论）。 */
export function updateResultPath() {
  return join(updatesDir(), 'last-run.json')
}

/** 插件包里那份更新器的源文件路径。 */
export function updaterSourcePath() {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', 'tools', UPDATER_SCRIPT)
}

/**
 * 把更新器复制到 `$DSH_HOME` 下（跑之前必须做）。
 *
 * 返回 `{ ok, path, bytes }`。复制失败**不抛错**——调用方据此说「更新器没准备好」，
 * 而不是让面板显示一个连接错误。
 */
export function stageUpdaterScript() {
  const source = updaterSourcePath()
  const target = updaterScriptPath()
  let text = null
  try {
    text = readFileSync(source, 'utf8')
  } catch (error) {
    return { ok: false, error: '找不到更新器脚本：' + source, hint: String(error && error.message ? error.message : error) }
  }
  try {
    mkdirSync(updatesDir(), { recursive: true })
    writeFileSync(target, text)
  } catch (error) {
    return { ok: false, error: '复制更新器失败：' + String(error && error.message ? error.message : error) }
  }
  return { ok: true, path: target, bytes: Buffer.byteLength(text, 'utf8') }
}

/** 拼出更新器的命令行（**纯函数**，便于测试与变异验证）。 */
export function updaterArgsOf(options = {}) {
  const profile = typeof options.profile === 'string' ? options.profile : ''
  const tag = typeof options.tag === 'string' ? options.tag : ''
  const version = normalizeVersion(options.version)
  const args = ['--profile', profile, '--tag', tag, '--expect-version', version, '--result', updateResultPath()]
  if (typeof options.pnpm === 'string' && options.pnpm !== '') args.push('--pnpm', options.pnpm)
  return args
}

/**
 * 启动更新器（**独立子进程，不阻塞面板**）。
 *
 * `detached + unref`：面板的 RPC 请求要立刻返回（装包可能跑几十秒，卡在请求里
 * 会让浏览器超时），进度由面板轮询 `last-run.json` 拿。
 *
 * `stdio: 'ignore'`：子进程的输出进不了面板（它可能比父进程活得久），
 * 所以结论一律走结果文件。
 */
export function spawnUpdater(options = {}) {
  const staged = stageUpdaterScript()
  if (staged.ok !== true) return staged
  const profile = typeof options.profile === 'string' ? options.profile : ''
  if (profile === '') return { ok: false, error: '没找到装着本插件的 profile 目录，无法自动安装' }
  const args = updaterArgsOf({
    profile,
    tag: options.tag,
    version: options.version,
    pnpm: typeof options.pnpm === 'string' ? options.pnpm : '',
  })
  // 先把上一次的结果删掉：否则面板会把**上一轮**的结论当成这一轮的
  // （「点了更新，界面立刻说更新成功」——那是很坏的一种假象）。
  try {
    rmSync(updateResultPath(), { force: true })
  } catch (_error) {
    /* 删不掉就让时间戳去判：结果文件里带 startedAt */
  }
  let child = null
  try {
    child = spawn(process.execPath, [staged.path, ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: updatesDir(),
    })
    child.unref()
  } catch (error) {
    return { ok: false, error: '启动更新器失败：' + String(error && error.message ? error.message : error) }
  }
  return {
    ok: true,
    pid: child.pid,
    script: staged.path,
    args,
    resultPath: updateResultPath(),
    profile,
    tag: args[args.indexOf('--tag') + 1],
  }
}

/** 读上一次运行的结论（面板轮询它）。没有就返回 `null`。 */
export function readUpdateRun() {
  let text = null
  try {
    text = readFileSync(updateResultPath(), 'utf8')
  } catch (_error) {
    return null
  }
  let json = null
  try {
    json = JSON.parse(text)
  } catch (_error) {
    return null
  }
  if (json === null || typeof json !== 'object') return null
  // 只挑要用的字段，别把整个日志（可能几千字）每次轮询都发给面板。
  return {
    ok: json.ok === true,
    stage: typeof json.stage === 'string' ? json.stage : '',
    /**
     * 安装器**正在跑**（v1.0.1 实测补上）。
     *
     * 没有这个标记时，面板分不清「正在装」与「根本没起来」——两种情况下
     * 结果文件都不存在，用户不知道该等还是该重来。实测就是这个问题：
     * 进程在跑，面板什么都看不到。
     */
    running: json.running === true,
    pid: Number.isSafeInteger(json.pid) ? json.pid : 0,
    phase: typeof json.phase === 'string' ? json.phase : '',
    error: typeof json.error === 'string' ? json.error : '',
    rolledBack: json.rolledBack === true,
    rollback: json.rollback !== undefined && json.rollback !== null && typeof json.rollback === 'object'
      ? { ok: json.rollback.ok === true, steps: Array.isArray(json.rollback.steps) ? json.rollback.steps : [] }
      : null,
    checks: Array.isArray(json.checks) ? json.checks : [],
    beforeVersion: typeof json.beforeVersion === 'string' ? json.beforeVersion : '',
    afterVersion: typeof json.afterVersion === 'string' ? json.afterVersion : '',
    startedAt: typeof json.startedAt === 'string' ? json.startedAt : '',
    finishedAt: typeof json.finishedAt === 'string' ? json.finishedAt : '',
    backupDir: typeof json.backupDir === 'string' ? json.backupDir : '',
    hint: typeof json.hint === 'string' ? json.hint : '',
  }
}

/** 备份目录列表（最近几份，面板显示「可回退到哪」）。 */
export function listBackups() {
  let names = []
  try {
    names = readdirSync(updatesDir()).filter((name) => name.startsWith('backup-'))
  } catch (_error) {
    return []
  }
  const out = []
  for (const name of names.sort().reverse()) {
    let meta = null
    try {
      meta = JSON.parse(readFileSync(join(updatesDir(), name, 'manifest.json'), 'utf8'))
    } catch (_error) {
      meta = null
    }
    out.push({
      name,
      dir: join(updatesDir(), name),
      at: meta !== null && typeof meta.at === 'string' ? meta.at : '',
      fromVersion: meta !== null && typeof meta.fromVersion === 'string' ? meta.fromVersion : '',
      toTag: meta !== null && typeof meta.toTag === 'string' ? meta.toTag : '',
    })
  }
  return out
}
