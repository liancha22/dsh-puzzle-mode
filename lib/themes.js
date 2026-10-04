/**
 * 主题：从**远程主题仓库**按需下载并应用面板皮肤。
 *
 * 为什么单独成文件：主题是唯一一条「插件会去网上取东西」的路径，它自带一整套
 * 安全边界（白名单校验 / sha256 / 体积上限 / 落盘位置）。把它和文档逻辑混在一起，
 * 会让「本插件不访问网络」这条对用户的承诺变得无法一眼核对。
 *
 * 三条硬约束（用户裁定）：
 *   1) **主题不在打包里**——`package.json` 的 `files` 不含任何主题；只有默认皮肤
 *      （`client.js` 的 `THEME_HUD`）随包走。想换皮必须点一下、从仓库下。
 *   2) **主题只能是 CSS**——上一轮用户先选「允许带 JS」又改口「不要 JS，只 CSS」，
 *      以后者为准。所以这里**没有**任何 JS 求值路径，`validateThemeCss` 会拒绝
 *      `url(` / `@import` / `expression(`，从机制上堵死「点一下就从网上执行代码」。
 *   3) **下载必须能验伪**——清单里带 `sha256`，下完先比对再落盘；不符就拒绝，
 *      并且**不覆盖**已经装好的同名主题（否则一次中间人劫持就能把好主题换掉）。
 *
 * 为什么走 HTTP 而不是 npm：主题要能「点一下就有」，而 npm 装包要重启 profile；
 * 本插件的宿主半是 `patchReload: startup`，装完必须重启——那就不叫换肤了。
 *
 * 为什么默认走 jsDelivr 而不是 raw.githubusercontent：本机实测 GitHub 直连超时、
 * raw 也常被墙；jsDelivr 有全球缓存且国内可达性最好。多镜像顺序回退（见
 * `themeChannelsFor`）保证单一镜像挂掉时不至于整个功能不可用。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from './docfs.js'
import { settingsDir } from './settings.js'

/** 主题清单/主题文件的**契约版本**。主题里写 `apiVersion`，不匹配就整批拒绝。 */
export const THEME_API_VERSION = 1

/**
 * 默认主题仓库（`owner/name`）。
 *
 * 为什么与插件分仓：主题迭代频率远高于插件本体，分仓后加一套皮肤**不用发插件版本**。
 * 代价是两仓版本要各自兼容——所以清单里带 `apiVersion`，插件只认自己支持的那一档。
 */
export const DEFAULT_THEME_REPO = 'liancha22/dsh-puzzle-themes'

/** 主题仓库的默认分支。 */
export const DEFAULT_THEME_BRANCH = 'main'

/** 单个主题 CSS 的体积上限。皮肤是文本，超过 256KB 只可能是打错了包。 */
export const MAX_THEME_BYTES = 256 * 1024

/** 主题清单的体积上限。 */
export const MAX_INDEX_BYTES = 128 * 1024

/** 主题 id 的合法形状：小写字母数字开头，允许 `. _ -`，最长 64。 */
export const THEME_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** 单次网络请求超时（毫秒）。 */
export const THEME_FETCH_TIMEOUT_MS = 8000

/**
 * 下载通道顺序表。
 *
 * 每个通道是一个函数：给 `(repo, branch, path, base)` 返回绝对 URL。
 * 顺序即优先级——前一个抛错/超时/非 200 就换下一个。
 * `custom` 在**用户填了 base** 时排到最前（自己的源自己最清楚）。
 */
export const THEME_CHANNELS = [
  {
    key: 'jsdelivr',
    label: 'jsDelivr CDN',
    url: (repo, branch, path) => `https://cdn.jsdelivr.net/gh/${repo}@${branch}/${path}`,
  },
  {
    key: 'gh-proxy',
    label: 'gh-proxy 镜像',
    url: (repo, branch, path) => `https://gh-proxy.com/https://raw.githubusercontent.com/${repo}/${branch}/${path}`,
  },
  {
    key: 'raw',
    label: 'raw.githubusercontent',
    url: (repo, branch, path) => `https://raw.githubusercontent.com/${repo}/${branch}/${path}`,
  },
]

/** 主题缓存目录：放 `$DSH_HOME` 下，跨工作区、跨会话共享（用户裁定「全局记忆」）。 */
export function themesDir() {
  return join(settingsDir(), 'puzzle-mode-themes')
}

/** 主题状态文件（当前主题、已装清单、自定义源）。 */
export function themesStatePath() {
  return join(settingsDir(), '.dsh-puzzle-mode-themes.json')
}

/** 主题 CSS 落盘路径。id 已过 `THEME_ID_RE`，不会带路径符号。 */
export function themeCssPath(id) {
  return join(themesDir(), id + '.css')
}

function emptyState() {
  return { current: '', installed: {}, repo: DEFAULT_THEME_REPO, base: '' }
}

/**
 * 读主题状态。**从不抛错**：坏文件按「没装过主题」处理。
 *
 * 与 `settings.js` 同一个理由——这类文件坏了，宁可用默认皮肤，也不能让面板打不开。
 */
export function readThemeState() {
  let text = null
  try {
    text = readFileSync(themesStatePath(), 'utf8')
  } catch (_error) {
    return emptyState()
  }
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch (_error) {
    return emptyState()
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyState()
  const installed = {}
  const rawInstalled = parsed.installed
  if (rawInstalled !== null && typeof rawInstalled === 'object' && !Array.isArray(rawInstalled)) {
    for (const id of Object.keys(rawInstalled)) {
      if (!THEME_ID_RE.test(id)) continue
      const entry = rawInstalled[id]
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      installed[id] = {
        name: typeof entry.name === 'string' ? entry.name : id,
        version: typeof entry.version === 'string' ? entry.version : '',
        sha256: typeof entry.sha256 === 'string' ? entry.sha256 : '',
        accent: typeof entry.accent === 'string' ? entry.accent : '',
        installedAt: typeof entry.installedAt === 'string' ? entry.installedAt : '',
      }
    }
  }
  const current = typeof parsed.current === 'string' && THEME_ID_RE.test(parsed.current) ? parsed.current : ''
  return {
    // 当前主题必须**同时**在已装清单里：状态文件被手改成「当前=某未装主题」时，
    // 面板不该去读一个不存在的 CSS（会静默退回默认皮肤，看起来像主题坏了）。
    current: installed[current] === undefined ? '' : current,
    installed,
    repo: typeof parsed.repo === 'string' && parsed.repo.trim() !== '' ? parsed.repo.trim() : DEFAULT_THEME_REPO,
    base: typeof parsed.base === 'string' ? parsed.base.trim() : '',
  }
}

function writeThemeState(state) {
  mkdirSync(themesDir(), { recursive: true })
  atomicWrite(themesStatePath(), JSON.stringify(state, null, 2) + '\n')
}

/** 记下自定义主题源（空串 = 回到默认仓库）。 */
export function setThemeRepo(repo) {
  const value = typeof repo === 'string' ? repo.trim() : ''
  const state = readThemeState()
  if (value === '') {
    state.repo = DEFAULT_THEME_REPO
    state.base = ''
    writeThemeState(state)
    return { ok: true, repo: state.repo, base: state.base }
  }
  // 允许两种写法：`owner/name`（走内置镜像），或一个 http(s) base（走自建源）。
  if (/^https?:\/\//i.test(value)) {
    state.base = value.replace(/\/+$/, '')
    writeThemeState(state)
    return { ok: true, repo: state.repo, base: state.base }
  }
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)) {
    return { ok: false, error: '主题源要写成 owner/name 或一个 http(s) 地址', hint: '例如 liancha22/dsh-puzzle-themes' }
  }
  state.repo = value
  state.base = ''
  writeThemeState(state)
  return { ok: true, repo: state.repo, base: state.base }
}

/**
 * 列出这次实际要试的通道。填了自建 base 就把它放最前（自己的源优先）。
 */
export function themeChannelsFor(base) {
  const channels = THEME_CHANNELS.slice()
  const custom = typeof base === 'string' ? base.trim() : ''
  if (custom !== '') {
    channels.unshift({
      key: 'custom',
      label: '自定义源',
      url: (repo, branch, path) => `${custom.replace(/\/+$/, '')}/${path}`,
    })
  }
  return channels
}

/**
 * 带超时的取文本。**不抛错**，失败一律返回 `{ ok:false }` 并带原因。
 *
 * 为什么不用 `AbortSignal.timeout` 之外的花样：这个函数在浏览器半的请求线程之外、
 * 由宿主进程调用，超时是最重要的——一个卡死的镜像会把面板轮询拖住 8 秒。
 */
async function fetchText(url, maxBytes) {
  let response = null
  try {
    response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(THEME_FETCH_TIMEOUT_MS),
      headers: { accept: 'text/plain,application/json,text/css,*/*' },
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
  // 用**字节数**而不是字符数卡上限：中文主题的字符数会低估体积。
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > maxBytes) return { ok: false, error: `体积超限（${bytes} > ${maxBytes} 字节）` }
  return { ok: true, text, bytes }
}

/**
 * 依次试通道取一个文件。返回**第一个成功**的通道结果，并把失败的通道记进 `tried`。
 *
 * `tried` 会一路带回面板：主题拉不到时，用户需要看到「三个镜像分别报了什么」，
 * 而不是一句笼统的「下载失败」——本仓的老教训是「诊断行写死致误报与真错同形」。
 */
export async function fetchThemeFile(relPath, options = {}) {
  const state = readThemeState()
  const repo = typeof options.repo === 'string' && options.repo.trim() !== '' ? options.repo.trim() : state.repo
  const base = typeof options.base === 'string' ? options.base : state.base
  const branch = typeof options.branch === 'string' && options.branch.trim() !== '' ? options.branch.trim() : DEFAULT_THEME_BRANCH
  const maxBytes = typeof options.maxBytes === 'number' ? options.maxBytes : MAX_THEME_BYTES
  const channels = themeChannelsFor(base)
  const tried = []
  for (const channel of channels) {
    const url = channel.url(repo, branch, relPath)
    const result = await fetchText(url, maxBytes)
    if (result.ok === true) return { ok: true, text: result.text, channel: channel.key, url, tried }
    tried.push({ channel: channel.key, url, error: result.error })
  }
  return { ok: false, error: '所有镜像都失败了', tried, repo, branch }
}

/** 十六进制 sha256。 */
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 主题 CSS 的**安全白名单**校验。
 *
 * 为什么必须逐条拦（这是本功能唯一的攻击面）：主题是「用户点一下就注入到页面里的
 * 第三方文本」。放开了就等于把 XSS 与「偷偷请求外部地址」的入口一起打开。所以：
 *
 *   - `@import` / `url(...)`：能把外部资源拉进页面（跟踪像素、远程字体、甚至
 *     用 `url()` 侧信道外带数据）。只放行 `data:image/` 内联图。
 *   - `expression(...)`：老 IE 的 CSS 表达式，等于在 CSS 里执行 JS。
 *   - `javascript:`：任何出现在 CSS 里的这个协议都不该存在。
 *   - `</` ：能提前闭合 `<style>` 标签，把后面的内容变成 HTML——这是最直接的注入。
 *   - 花括号不配平：会让后续规则跑到别的规则里，静默破坏宿主样式。
 *   - **选择器必须落在插件自己的类上**：`:root` / `html`（只允许声明 `--dshpz-*`）
 *     或含 `.dshpz-` 的选择器。否则一份主题就能重排整个 DSH 界面——
 *     用户裁定的是「面板 + 小按钮」，不是「全站换肤」。
 *   - 必须真的声明至少一个 `--dshpz-*` 变量：否则这份主题什么也不做，
 *     却会被标成「已应用」，用户只会以为功能坏了。
 */
export function validateThemeCss(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: '主题 CSS 是空的' }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_THEME_BYTES) return { ok: false, error: `主题 CSS 超过 ${MAX_THEME_BYTES} 字节` }
  const lower = text.toLowerCase()
  if (lower.includes('@import')) return { ok: false, error: '主题 CSS 不允许 @import' }
  if (lower.includes('javascript:')) return { ok: false, error: '主题 CSS 里不允许 javascript: 协议' }
  if (lower.includes('expression(')) return { ok: false, error: '主题 CSS 里不允许 expression()' }
  if (text.includes('</')) return { ok: false, error: '主题 CSS 里不允许出现 `</`（会提前闭合 style 标签）' }
  const urls = text.match(/url\(\s*['"]?([^'")]*)/gi) || []
  for (const raw of urls) {
    const inner = raw.replace(/^url\(\s*['"]?/i, '').trim()
    if (!/^data:image\//i.test(inner)) {
      return { ok: false, error: '主题 CSS 只允许 url(data:image/...) 内联图，不允许外部地址：' + inner.slice(0, 40) }
    }
  }
  // 去掉注释再数括号：注释里的 `{` 不该影响配平判断。
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '')
  let depth = 0
  for (const ch of stripped) {
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth < 0) return { ok: false, error: '主题 CSS 花括号不配平（多了一个 }）' }
    }
  }
  if (depth !== 0) return { ok: false, error: '主题 CSS 花括号不配平' }
  const checked = checkSelectors(stripped)
  if (checked.ok !== true) return checked
  if (!/--dshpz-[a-z0-9-]+\s*:/.test(stripped)) {
    return { ok: false, error: '主题 CSS 没有声明任何 --dshpz-* 变量，应用了也不会有变化' }
  }
  return { ok: true, bytes }
}

/**
 * 逐块检查选择器。
 *
 * 递归处理 `@media` / `@supports`（它们里面还是普通规则），对普通规则按逗号拆开逐个判。
 * 判定只有两条：命中插件自己的类名；或整块是 `:root`/`html` 且只声明变量。
 */
function checkSelectors(css) {
  const blocks = splitBlocks(css)
  for (const block of blocks) {
    const selector = block.head.trim()
    if (selector === '') continue
    if (selector.startsWith('@')) {
      // 只放行条件组；`@keyframes` 里的百分比选择器不是 DOM 选择器，单独放过。
      const name = selector.slice(1).split(/[\s(]/)[0].toLowerCase()
      if (name === 'keyframes' || name === '-webkit-keyframes') continue
      if (name === 'media' || name === 'supports' || name === 'layer' || name === 'container') {
        const inner = checkSelectors(block.body)
        if (inner.ok !== true) return inner
        continue
      }
      return { ok: false, error: '主题 CSS 不允许 at-rule：@' + name }
    }
    for (const one of selector.split(',')) {
      const part = one.trim()
      if (part === '') continue
      /**
       * 只有**整个选择器恰好是** `:root` 或 `html` 才按「变量声明块」处理。
       *
       * 这里刻意用全等而不是 `/^html\b/` 这类前缀判断：`html.dark{...}`、
       * `html[data-theme=x]{...}` 都是**宿主级**选择器，能按条件给整个 DSH 界面
       * 重定颜色——那已经越过「面板 + 小按钮」的作用域了。前缀判断会放它们过去，
       * 这是实测抓到的一个白名单缺口（`html.dark` 曾被判为合法）。
       */
      const isRoot = part === ':root' || part === 'html'
      if (isRoot) {
        // `:root` / `html` 上**只准声明变量**——不然一份主题就能给整个 DSH 界面
        // 重定颜色字体，那已经越过「面板 + 小按钮」的边界了。
        for (const decl of block.body.split(';')) {
          const prop = decl.split(':')[0].trim()
          if (prop === '' || prop.startsWith('/*')) continue
          if (!prop.startsWith('--dshpz-')) {
            return { ok: false, error: '`' + part + '` 里只能声明 --dshpz-* 变量，不能改 ' + prop }
          }
        }
        continue
      }
      if (!part.includes('.dshpz-')) {
        return { ok: false, error: '选择器必须命中插件自己的类（.dshpz-*）或 :root：' + part.slice(0, 60) }
      }
    }
  }
  return { ok: true }
}

/** 把 CSS 拆成「头 + 体」的一层块。体里若还有块，交给 `checkSelectors` 递归。 */
function splitBlocks(css) {
  const out = []
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open < 0) break
    const head = css.slice(i, open)
    let depth = 1
    let j = open + 1
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth += 1
      else if (css[j] === '}') depth -= 1
      j += 1
    }
    out.push({ head, body: css.slice(open + 1, j - 1) })
    i = j
  }
  return out
}

/**
 * 校验主题清单的形状。
 *
 * 为什么清单也要严查：清单里的 `sha256` 是**信任锚**。清单本身若能被塞进
 * 一条坏记录（比如缺 hash、id 带路径符号），后面的校验就形同虚设。
 */
export function validateThemeIndex(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '主题清单不是一个对象' }
  }
  if (parsed.apiVersion !== THEME_API_VERSION) {
    return {
      ok: false,
      error: `主题清单的 apiVersion=${String(parsed.apiVersion)}，本插件只认 ${THEME_API_VERSION}`,
      hint: '升级插件，或换一个与本插件版本匹配的主题仓库',
    }
  }
  if (!Array.isArray(parsed.themes)) return { ok: false, error: '主题清单缺 themes 数组' }
  const themes = []
  const seen = new Set()
  for (const raw of parsed.themes) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!THEME_ID_RE.test(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    const sha = typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : ''
    themes.push({
      id,
      name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : id,
      author: typeof raw.author === 'string' ? raw.author.trim() : '',
      description: typeof raw.description === 'string' ? raw.description.trim() : '',
      version: typeof raw.version === 'string' ? raw.version.trim() : '',
      accent: typeof raw.accent === 'string' ? raw.accent.trim() : '',
      // 缺 hash 的主题**保留在列表里但标成不可装**：直接丢掉会让用户以为仓库里没这套皮肤。
      sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : '',
      file: typeof raw.file === 'string' && raw.file.trim() !== '' ? raw.file.trim() : `themes/${id}/theme.css`,
    })
  }
  return { ok: true, themes, updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '' }
}

/**
 * 拉主题清单。失败时**回退到上次成功的缓存**（用户裁定：用上次缓存 + 一条提示）。
 *
 * 缓存清单存在主题目录下的 `index.json`，与状态文件分开：清单是「远端事实的快照」，
 * 状态是「本机选择」，两者生命周期不同（换源要重拉清单，但不该丢当前主题）。
 */
export async function listThemes(options = {}) {
  const state = readThemeState()
  const repo = typeof options.repo === 'string' && options.repo.trim() !== '' ? options.repo.trim() : state.repo
  const base = typeof options.base === 'string' ? options.base : state.base
  const cacheFile = join(themesDir(), 'index.json')
  const fetched = await fetchThemeFile('index.json', { repo, base, maxBytes: MAX_INDEX_BYTES })
  if (fetched.ok === true) {
    let parsed = null
    try {
      parsed = JSON.parse(fetched.text)
    } catch (_error) {
      parsed = null
    }
    const validated = validateThemeIndex(parsed)
    if (validated.ok === true) {
      mkdirSync(themesDir(), { recursive: true })
      atomicWrite(cacheFile, JSON.stringify({ repo, fetchedAt: new Date().toISOString(), raw: parsed }, null, 2) + '\n')
      return { ok: true, themes: validated.themes, repo, base, channel: fetched.channel, cached: false, updatedAt: validated.updatedAt }
    }
    return { ok: false, error: validated.error, hint: validated.hint, repo, tried: fetched.tried }
  }
  let cachedRaw = null
  try {
    cachedRaw = JSON.parse(readFileSync(cacheFile, 'utf8'))
  } catch (_error) {
    cachedRaw = null
  }
  if (cachedRaw !== null && cachedRaw.raw !== undefined) {
    const validated = validateThemeIndex(cachedRaw.raw)
    if (validated.ok === true) {
      return {
        ok: true,
        themes: validated.themes,
        repo,
        base,
        channel: 'cache',
        cached: true,
        offline: true,
        fetchedAt: typeof cachedRaw.fetchedAt === 'string' ? cachedRaw.fetchedAt : '',
        error: fetched.error,
        tried: fetched.tried,
      }
    }
  }
  return { ok: false, error: fetched.error, tried: fetched.tried, repo, base }
}

/**
 * 下载并安装一个主题。
 *
 * 顺序刻意如此：**先下 CSS → 校验 → 比 sha256 → 再落盘**。
 * 任何一步失败都不写盘，所以「装了一半」的状态不存在——面板读到的要么是旧主题，
 * 要么是完整的新主题。
 */
export async function installTheme(id, options = {}) {
  const state = readThemeState()
  if (typeof id !== 'string' || !THEME_ID_RE.test(id.trim())) {
    return { ok: false, error: '主题 id 不合法' }
  }
  const themeId = id.trim()
  const listed = await listThemes(options)
  if (listed.ok !== true) return { ok: false, error: listed.error, tried: listed.tried }
  const meta = listed.themes.find((theme) => theme.id === themeId)
  if (meta === undefined) return { ok: false, error: '主题仓库里没有这个主题：' + themeId }
  if (meta.sha256 === '') {
    return { ok: false, error: '主题清单里这条缺 sha256，拒绝安装', hint: '主题仓库需要补上 hash（跑生成脚本）' }
  }
  const fetched = await fetchThemeFile(meta.file, { ...options, maxBytes: MAX_THEME_BYTES })
  if (fetched.ok !== true) return { ok: false, error: fetched.error, tried: fetched.tried }
  const actual = sha256Hex(fetched.text)
  if (actual !== meta.sha256) {
    return {
      ok: false,
      error: 'sha256 不匹配，拒绝安装',
      hint: `清单写 ${meta.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…（可能被改动过，或主题仓库忘了跑生成脚本）`,
    }
  }
  const valid = validateThemeCss(fetched.text)
  if (valid.ok !== true) return { ok: false, error: '主题 CSS 未通过安全校验：' + valid.error }
  mkdirSync(themesDir(), { recursive: true })
  atomicWrite(themeCssPath(themeId), fetched.text)
  const after = readThemeState()
  after.installed[themeId] = {
    name: meta.name,
    version: meta.version,
    sha256: meta.sha256,
    accent: meta.accent,
    installedAt: new Date().toISOString(),
  }
  writeThemeState(after)
  return { ok: true, id: themeId, name: meta.name, channel: fetched.channel, bytes: valid.bytes, cached: listed.cached === true }
}

/** 应用已安装的主题（只写状态，不碰网络）。 */
export function applyTheme(id) {
  const state = readThemeState()
  if (typeof id !== 'string' || state.installed[id] === undefined) {
    return { ok: false, error: '这个主题还没下载：' + String(id), hint: '先点「下载并应用」' }
  }
  state.current = id
  writeThemeState(state)
  const loaded = loadThemeCss(id)
  if (loaded.ok !== true) return loaded
  return { ok: true, id, name: state.installed[id].name, css: loaded.css }
}

/** 回到默认皮肤（`client.js` 内置的 HUD），并清掉当前主题记录。 */
export function resetTheme() {
  const state = readThemeState()
  state.current = ''
  writeThemeState(state)
  return { ok: true, id: '' }
}

/** 卸载一个主题。卸的正好是当前主题时**顺带回默认**，避免留下「当前指向不存在」。 */
export function uninstallTheme(id) {
  const state = readThemeState()
  if (typeof id !== 'string' || state.installed[id] === undefined) {
    return { ok: false, error: '这个主题本来就没装：' + String(id) }
  }
  delete state.installed[id]
  let resetCurrent = false
  if (state.current === id) {
    state.current = ''
    resetCurrent = true
  }
  writeThemeState(state)
  try {
    rmSync(themeCssPath(id), { force: true })
  } catch (_error) {
    /* 文件删不掉不影响状态：下次安装会覆盖 */
  }
  return { ok: true, id, resetCurrent }
}

/**
 * 读当前生效主题的 CSS（面板每次 `state` 都会带上它）。
 *
 * 这里**不缓存**：主题文件只在安装时写一次，读它是毫秒级的小文件；
 * 而缓存会引入「卸载后还生效」这类只在真机上复现的脏读。
 */
export function loadThemeCss(id) {
  const state = readThemeState()
  const themeId = typeof id === 'string' && id !== '' ? id : state.current
  if (themeId === '' || state.installed[themeId] === undefined) return { ok: true, id: '', css: '' }
  let css = ''
  try {
    css = readFileSync(themeCssPath(themeId), 'utf8')
  } catch (_error) {
    return { ok: false, error: '主题文件读不出来（可能被手工删了）', id: themeId, hint: '重新下载一次这个主题' }
  }
  // 读盘时**再校验一次**：文件可能被用户手工改过（比如从别处拷了一份 CSS 进来）。
  // 落盘时校验过、读回时不再校验，等于给「手工替换」留了一条绕过白名单的路。
  const valid = validateThemeCss(css)
  if (valid.ok !== true) return { ok: false, error: '主题文件没通过安全校验：' + valid.error, id: themeId }
  return { ok: true, id: themeId, css, name: state.installed[themeId].name, accent: state.installed[themeId].accent }
}

/**
 * 面板要用的主题概览：当前主题 + 已装清单 + 源。
 *
 * 刻意**不在这里拉清单**（那要联网、要 8 秒超时）：`state` 是每 8 秒轮询一次的路径，
 * 把网络请求塞进去会让面板在断网时每轮卡 8 秒。清单由主题页打开时单独拉。
 */
export function themeOverview() {
  const state = readThemeState()
  const installed = Object.keys(state.installed).map((id) => ({ id, ...state.installed[id] }))
  installed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const current = state.current
  let currentName = ''
  if (current !== '' && state.installed[current] !== undefined) currentName = state.installed[current].name
  return {
    current,
    currentName,
    installed,
    installedCount: installed.length,
    repo: state.repo,
    base: state.base,
    apiVersion: THEME_API_VERSION,
    dir: themesDir(),
    // 主题目录是否存在，用于面板上如实区分「没装过」与「装过又被删了」。
    dirExists: existsDir(themesDir()),
  }
}

function existsDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch (_error) {
    return false
  }
}

/** 主题缓存目录里现在有哪些 `.css`（排查「状态文件与磁盘不一致」用）。 */
export function themeFilesOnDisk() {
  try {
    return readdirSync(themesDir()).filter((name) => name.endsWith('.css'))
  } catch (_error) {
    return []
  }
}
