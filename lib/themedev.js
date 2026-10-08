/**
 * 主题开发：**做一套自己的皮肤，然后让别人也能用上**。
 *
 * ## 三件事，对应三条用户裁定
 *
 *   1. **一键开发**（「一键进入自主开发此插件主题风格」）——在工作区建出脚手架目录
 *      `themes/<id>/{manifest.json,theme.css}`，并把一份开发提示词送进输入框。
 *      为什么必须建目录：不建的话，用户每开一次新会话都要重新交代「目录长什么样、
 *      有哪些令牌、校验规则是什么」，而那份交代正是这个函数要固化的东西。
 *
 *   2. **一键上传**（「可一键上传」，且用户明确「上传是让别人能够分享自己做的主题风格」）
 *      ——写文件 → 重算 `index.json` → `git push`。**插件不读任何令牌**：凭据由 git
 *      自己的凭据链（credential helper / SSH agent）取，插件代码里没有令牌路径。
 *      这比「读 `~/.dsh/.github-token` 调 Contents API」安全一个量级——后者一旦
 *      被插件拿到，就等于把「写你所有仓库」的能力交出去了。
 *
 *   3. **单文件主题包**（用户追加裁定「要：导出单文件主题包 + 一键导入」）——
 *      不依赖 git、不依赖网络源的第二条分享路：导出成一个 `.json` 文本，发给对方
 *      粘贴即用。为什么是 JSON 而不是 zip：**一个可校验的文本**比一个二进制包更好传
 *      （聊天窗口、剪贴板、issue 都能贴），而且能内联 sha256 让导入端验伪。
 *
 * ## 与 `lib/themes.js` 的分工
 *
 * `themes.js` 管**消费**（下载、校验、应用、卸载），本文件管**生产**（写、导、传）。
 * 两边共用同一个 `validateThemeCss` —— 生产端必须用**消费端那把尺子**量，
 * 否则会出现「本地过了、用户装不上」这种最难查的漂移。
 *
 * ## 为什么上传不直接改用户工作区之外的仓库
 *
 * 目标仓库默认是**工作区里的检出**（`<工作区>/dsh-puzzle-themes` 或用户指定路径）。
 * 找不到检出就**不猜**——如实回一句「没找到主题仓库的检出」，并给出克隆命令。
 * 「猜一个路径然后往上推」是这类功能最容易闯的祸。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { atomicWrite } from './docfs.js'
import { DEFAULT_THEME_REPO, MAX_THEME_BYTES, THEME_API_VERSION, THEME_ID_RE, sha256Hex, validateThemeCss } from './themes.js'

/** 单文件主题包的格式版本。导入端按它判断「这个包我认不认」。 */
export const THEME_PACK_VERSION = 1

/** 主题包的文件后缀（导出时用它命名）。 */
export const THEME_PACK_EXT = '.dshpz-theme.json'

/** 主题包体积上限：比单个 CSS 宽一倍，够放 manifest 与说明。 */
export const MAX_PACK_BYTES = MAX_THEME_BYTES * 2

/** 主题仓库检出的默认目录名（在会话工作区下找）。 */
export const THEME_REPO_DIRNAME = 'dsh-puzzle-themes'

/** `git push` 的超时（毫秒）。网络慢时别把面板拖死。 */
export const GIT_TIMEOUT_MS = 60000

/** 脚手架里那份 CSS 的令牌清单（**从 client.js 的 THEME_HUD 逐项抄来**）。 */
export const THEME_TOKENS = Object.freeze([
  'accent', 'accent-hi', 'accent-lo', 'on-accent',
  'glass', 'glass-sheen', 'grid', 'glow', 'shadow',
  'radius-sm', 'radius-md', 'radius-lg',
  'font-ui', 'font-mono',
  'dur-in', 'dur-fast', 'ease-out', 'ease-std',
])

/**
 * 主题 id 规范化：小写、空格与下划线转 `-`、剔掉非法字符、截到 64。
 *
 * 为什么要它：用户输入的是「我的主题 My Theme!」，而 id 要当**目录名**用。
 * 不规范化就会在 Windows 上建出带空格与感叹号的目录，`git push` 时还要再踩一次。
 * 规范化后仍不合法（比如全是中文）就返回空串，由调用方报错——**不硬凑一个 id**。
 */
export function themeIdOf(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (text === '') return ''
  const ascii = text.replace(/[\s_]+/g, '-').replace(/[^a-z0-9._-]/g, '')
  const trimmed = ascii.replace(/^[^a-z0-9]+/, '').replace(/-+$/g, '').slice(0, 64)
  return THEME_ID_RE.test(trimmed) ? trimmed : ''
}

/**
 * 脚手架：`manifest.json` 的正文。
 *
 * `name` 用用户给的原名（中文可以），`id` 才是目录名——两者分开是刻意的：
 * 主题列表里显示的是 `name`，磁盘上的是 `id`。
 */
export function manifestTemplate(id, name, options = {}) {
  const author = typeof options.author === 'string' && options.author.trim() !== '' ? options.author.trim() : ''
  const description = typeof options.description === 'string' && options.description.trim() !== ''
    ? options.description.trim()
    : '（一句话说清这套皮肤的气质——它会显示在主题列表里）'
  return JSON.stringify({
    name: typeof name === 'string' && name.trim() !== '' ? name.trim() : id,
    author,
    description,
    version: '1.0.0',
    accent: '#7dd3fc',
  }, null, 2) + '\n'
}

/**
 * 脚手架：`theme.css` 的正文。
 *
 * 为什么给一份**能直接生效**的模板而不是空文件：空文件装上去「什么也没变」，
 * 用户会以为功能坏了。这份模板只改颜色与圆角，装上去立刻能看出差别——
 * 那是「改这里 → 那里变」的因果链，作者要的正是它。
 *
 * ## ⚠️ 注释里**绝不能出现被禁的关键字**（实测踩过，是这一版抓到的真缺陷）
 *
 * 校验器 `validateThemeCss` 对 `@import` / `javascript:` / `expression(` 是
 * **文本包含**匹配（不解析语法，见 `lib/themes.js` 那段理由：宁可严一点）。
 * 第一版模板在注释里写着「不许 @import / url(http…) / javascript: / expression()」，
 * 结果**模板自己撞了自己的规则**——作者拿到脚手架，第一步就装不上，
 * 而报错还指着一段注释，看起来莫名其妙。
 *
 * 所以规则只写在**开发提示词**里（`themeDevPrompt`，那是给模型读的，不经过校验器），
 * 这份 CSS 里一个字都不提。这条也解释了为什么下面只有一句泛指的话。
 */
export function cssTemplate(id, name) {
  const label = typeof name === 'string' && name.trim() !== '' ? name.trim() : id
  return [
    '/**',
    ` * ${label} —— 在这里改你的皮肤。`,
    ' *',
    ' * 只改 `--dshpz-*` 变量，或写命中 `.dshpz-*` 的选择器。',
    ' * 具体能写什么、不能写什么，见对话里那份开发提示词。',
    ' */',
    '',
    ':root {',
    '  /* 主色三档：亮 / 中 / 暗。`on-accent` 是**主色之上的前景色**——',
    '     主色是亮色时它必须写深色，否则实心按钮上的字读不出来。 */',
    '  --dshpz-accent: #7dd3fc;',
    '  --dshpz-accent-hi: #bae6fd;',
    '  --dshpz-accent-lo: #0369a1;',
    '  --dshpz-on-accent: #062033;',
    '',
    '  /* 面板叠加层的光晕。支持 `color-mix` 的浏览器才有，不支持时整层消失。 */',
    '  --dshpz-glass-sheen: linear-gradient(135deg, color-mix(in srgb, #7dd3fc 10%, transparent), transparent 60%);',
    '',
    '  /* 网格与发光。发光只给「当前状态」用，满屏发光会很吵。 */',
    '  --dshpz-grid: color-mix(in srgb, #7dd3fc 8%, transparent);',
    '  --dshpz-glow: 0 0 0 1px #7dd3fc, 0 0 18px -6px #7dd3fc;',
    '  --dshpz-shadow: 0 2px 4px rgba(0, 0, 0, .35), 0 24px 60px -14px rgba(0, 0, 0, .6);',
    '',
    '  /* 圆角与动效：辨识度主要来自这两组。 */',
    '  --dshpz-radius-sm: 8px;',
    '  --dshpz-radius-md: 14px;',
    '  --dshpz-radius-lg: 20px;',
    '  --dshpz-dur-in: 260ms;',
    '  --dshpz-dur-fast: 120ms;',
    '}',
    '',
    '/* 想改结构就写命中插件类名的规则（类名前缀一律 `.dshpz-`）。 */',
    '.dshpz-tlogo {',
    '  background: linear-gradient(135deg, var(--dshpz-accent-hi), var(--dshpz-accent-lo));',
    '}',
    '',
  ].join('\n')
}

/**
 * 给模型看的开发提示词（面板「一键进入开发」把它填进输入框）。
 *
 * 内容刻意**写全**：目录、令牌、规则、验收命令。用户点一次就能开工，
 * 不必先解释一遍上下文——这正是「一键」的全部意义。
 */
export function themeDevPrompt(id, options = {}) {
  const repo = typeof options.repoPath === 'string' && options.repoPath !== '' ? options.repoPath : ''
  const target = repo !== '' ? repo : '主题仓库检出'
  return [
    `帮我开发一套拼图模式主题，id 是 \`${id}\`。`,
    '',
    '**目录**：' + target + '/themes/' + id + '/{manifest.json,theme.css}',
    '（脚手架已经建好，直接改这两个文件就行。）',
    '',
    '**能改什么**：只能改 `--dshpz-*` 变量（下面这份是全部可用令牌），',
    '或写命中 `.dshpz-*` 类名的选择器。',
    '',
    THEME_TOKENS.map((token) => '`--dshpz-' + token + '`').join('、'),
    '',
    '**不能写**：`@import`、`url(http...)`（只允许 `url(data:image/...)`）、',
    '`javascript:`、`expression()`、`</`。选择器不能碰 `:root` / `html` 以外的宿主元素。',
    '',
    '**改完请跑这三条**（顺序别换）：',
    '1. `node tools/build-index.mjs` —— 重算清单，sha256 必须由脚本现算；',
    '2. `node tools/build-index.mjs --check` —— 确认清单与文件一致；',
    '3. 在插件仓库里跑 `npm run verify:themes -- ' + (repo !== '' ? repo : '<主题仓库路径>') + '` —— 用插件自己的校验器验一遍。',
    '',
    '**验收**：三条都过，且主题在面板的「主题」页里能下载、能应用、界面确实变了样。',
  ].join('\n')
}

/**
 * 在工作区建主题脚手架。
 *
 * 返回 `{ ok, id, dir, files, created, skipped }`。
 * **已存在的文件不覆盖**（`skipped`）——用户可能已经改了一半，
 * 覆盖等于把他的工作删了，这是这类「一键生成」最常见的破坏性事故。
 */
export function createThemeScaffold(workspaceRoot, id, options = {}) {
  const themeId = themeIdOf(id)
  if (themeId === '') {
    return { ok: false, error: '主题 id 不合法：只能用小写字母、数字、`.` `_` `-`，且以字母或数字开头' }
  }
  const root = typeof workspaceRoot === 'string' && workspaceRoot.trim() !== '' ? workspaceRoot : ''
  if (root === '') return { ok: false, error: '不知道往哪个工作区建（拿不到会话工作目录）' }
  const repoPath = typeof options.repoPath === 'string' && options.repoPath.trim() !== ''
    ? options.repoPath.trim()
    : join(root, THEME_REPO_DIRNAME)
  const dir = join(repoPath, 'themes', themeId)
  const manifestPath = join(dir, 'manifest.json')
  const cssPath = join(dir, 'theme.css')
  const created = []
  const skipped = []
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    return { ok: false, error: '建目录失败：' + String(error && error.message ? error.message : error), dir }
  }
  const name = typeof options.name === 'string' && options.name.trim() !== '' ? options.name.trim() : themeId
  for (const [file, text] of [
    [manifestPath, manifestTemplate(themeId, name, options)],
    [cssPath, cssTemplate(themeId, name)],
  ]) {
    if (existsSync(file)) {
      skipped.push(file)
      continue
    }
    try {
      atomicWrite(file, text)
      created.push(file)
    } catch (error) {
      return { ok: false, error: '写文件失败：' + String(error && error.message ? error.message : error), dir, created }
    }
  }
  return {
    ok: true,
    id: themeId,
    name,
    dir,
    repoPath,
    manifestPath,
    cssPath,
    created,
    skipped,
    // 已经存在就不算新建：面板据此说「脚手架已就绪」而不是「已创建」。
    isNew: created.length > 0,
  }
}

/**
 * 重算主题仓库的 `index.json`。
 *
 * **为什么在这里重新实现一遍**：`tools/build-index.mjs` 是主题仓库里的脚本，
 * 而插件不能假设那个脚本一定在（用户可能只克隆了 `themes/`，或用的是自己的仓库）。
 * 算法与那份脚本**逐条对齐**（同一个 API_VERSION、同一份 sha256 算法、同样的排序），
 * 并且这里额外用**插件自己的** `validateThemeCss` 验一遍——那才是权威的尺子。
 */
export function rebuildThemeIndex(repoPath) {
  const root = typeof repoPath === 'string' ? repoPath.trim() : ''
  if (root === '') return { ok: false, error: '主题仓库路径为空' }
  const themesDir = join(root, 'themes')
  if (!existsSync(themesDir)) return { ok: false, error: '找不到 themes/ 目录：' + themesDir }
  let ids = []
  try {
    ids = readdirSync(themesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    return { ok: false, error: '读 themes/ 失败：' + String(error && error.message ? error.message : error) }
  }
  const themes = []
  const problems = []
  for (const id of ids) {
    if (!THEME_ID_RE.test(id)) {
      problems.push(`themes/${id}：目录名不是合法主题 id`)
      continue
    }
    const manifestPath = join(themesDir, id, 'manifest.json')
    const cssPath = join(themesDir, id, 'theme.css')
    if (!existsSync(manifestPath)) {
      problems.push(`themes/${id}：缺 manifest.json`)
      continue
    }
    if (!existsSync(cssPath)) {
      problems.push(`themes/${id}：缺 theme.css`)
      continue
    }
    let manifest = null
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      problems.push(`themes/${id}/manifest.json：不是合法 JSON —— ${String(error && error.message ? error.message : error)}`)
      continue
    }
    const css = readFileSync(cssPath, 'utf8')
    // **用插件自己的校验器**：这里过的，用户那边一定也过。
    const valid = validateThemeCss(css)
    if (valid.ok !== true) {
      problems.push(`themes/${id}/theme.css：${valid.error}`)
      continue
    }
    themes.push({
      id,
      name: typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : id,
      author: typeof manifest.author === 'string' ? manifest.author : '',
      description: typeof manifest.description === 'string' ? manifest.description : '',
      version: typeof manifest.version === 'string' ? manifest.version : '',
      accent: typeof manifest.accent === 'string' ? manifest.accent : '',
      file: `themes/${id}/theme.css`,
      sha256: sha256Hex(css),
    })
  }
  if (problems.length > 0) return { ok: false, error: '主题仓库有问题', problems }
  const next = { apiVersion: THEME_API_VERSION, updatedAt: new Date().toISOString().slice(0, 10), themes }
  const indexPath = join(root, 'index.json')
  const text = JSON.stringify(next, null, 2) + '\n'
  const before = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : ''
  const changed = before !== text
  if (changed) {
    try {
      atomicWrite(indexPath, text)
    } catch (error) {
      return { ok: false, error: '写 index.json 失败：' + String(error && error.message ? error.message : error) }
    }
  }
  return { ok: true, indexPath, count: themes.length, changed, themes: themes.map((theme) => theme.id) }
}

/**
 * 主题包（单文件分享格式）的形状校验。
 *
 * 判据是**双向**的：既要认得出合法包，也要挡得住「看起来像但其实缺字段」的包——
 * 导入端一旦放半个包进来，用户会得到一个装不上的主题，而错误会出现在很远的地方。
 */
export function validateThemePack(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '主题包不是一个对象' }
  }
  if (parsed.kind !== 'dshpz-theme-pack') {
    return { ok: false, error: '这不是一个拼图模式主题包（缺 kind 标记）' }
  }
  if (parsed.packVersion !== THEME_PACK_VERSION) {
    return { ok: false, error: `主题包版本 ${String(parsed.packVersion)}，本插件只认 ${THEME_PACK_VERSION}` }
  }
  const id = themeIdOf(parsed.id)
  if (id === '') return { ok: false, error: '主题包里的 id 不合法' }
  const css = typeof parsed.css === 'string' ? parsed.css : ''
  const valid = validateThemeCss(css)
  if (valid.ok !== true) return { ok: false, error: '主题包里的 CSS 未通过安全校验：' + valid.error }
  const declared = typeof parsed.sha256 === 'string' ? parsed.sha256.trim().toLowerCase() : ''
  const actual = sha256Hex(css)
  // 包里带 hash 就一定要对：它是「内容没被改过」的凭据。
  if (declared !== '' && declared !== actual) {
    return {
      ok: false,
      error: '主题包的 sha256 与内容不符（可能被改动过）',
      hint: `包写 ${declared.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`,
    }
  }
  const manifest = parsed.manifest !== null && typeof parsed.manifest === 'object' && !Array.isArray(parsed.manifest)
    ? parsed.manifest
    : {}
  return {
    ok: true,
    id,
    css,
    sha256: actual,
    manifest: {
      name: typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : id,
      author: typeof manifest.author === 'string' ? manifest.author : '',
      description: typeof manifest.description === 'string' ? manifest.description : '',
      version: typeof manifest.version === 'string' ? manifest.version : '',
      accent: typeof manifest.accent === 'string' ? manifest.accent : '',
    },
  }
}

/** 把已装主题导出成单文件包文本（发给别人用）。 */
export function exportThemePack(theme, options = {}) {
  if (theme === null || typeof theme !== 'object') return { ok: false, error: '没有可导出的主题' }
  const id = themeIdOf(theme.id)
  if (id === '') return { ok: false, error: '主题 id 不合法，无法导出' }
  const css = typeof theme.css === 'string' ? theme.css : ''
  const valid = validateThemeCss(css)
  if (valid.ok !== true) return { ok: false, error: '主题 CSS 未通过安全校验，不导出：' + valid.error }
  const pack = {
    kind: 'dshpz-theme-pack',
    packVersion: THEME_PACK_VERSION,
    id,
    exportedAt: new Date().toISOString(),
    // 导出时**现算** sha256：从状态文件里抄一个旧的，导出的包会被导入端判成「被改过」。
    sha256: sha256Hex(css),
    manifest: {
      name: typeof theme.name === 'string' && theme.name !== '' ? theme.name : id,
      author: typeof theme.author === 'string' ? theme.author : '',
      description: typeof theme.description === 'string' ? theme.description : '',
      version: typeof theme.version === 'string' ? theme.version : '',
      accent: typeof theme.accent === 'string' ? theme.accent : '',
    },
    css,
    note: typeof options.note === 'string' ? options.note : '',
  }
  const text = JSON.stringify(pack, null, 2) + '\n'
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_PACK_BYTES) return { ok: false, error: `导出的包超过 ${MAX_PACK_BYTES} 字节` }
  return { ok: true, id, text, bytes, sha256: pack.sha256, filename: id + THEME_PACK_EXT }
}

/** 解析主题包文本 → `{ ok, id, css, manifest, sha256 }`。 */
export function importThemePack(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw === '') return { ok: false, error: '主题包内容是空的' }
  const bytes = Buffer.byteLength(raw, 'utf8')
  if (bytes > MAX_PACK_BYTES) return { ok: false, error: `主题包超过 ${MAX_PACK_BYTES} 字节` }
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, error: '主题包不是合法 JSON：' + String(error && error.message ? error.message : error) }
  }
  return validateThemePack(parsed)
}

/**
 * 把主题包装到本机（写进主题目录并记状态）。
 *
 * 为什么**不覆盖已装主题**：用户导入一个同 id 的包时，如果直接覆盖，
 * 他原来那套就没了。这里返回 `exists: true` 让面板问一句「要替换吗」——
 * 只有 `options.overwrite === true` 才真的写。
 */
export function installThemePack(text, options = {}) {
  const parsed = importThemePack(text)
  if (parsed.ok !== true) return parsed
  const { readThemeState, themesDir, themeCssPath } = options.fs ?? {}
  if (typeof readThemeState !== 'function' || typeof themeCssPath !== 'function' || typeof themesDir !== 'function') {
    return { ok: false, error: '内部错误：缺少主题存储接口' }
  }
  const state = readThemeState()
  if (state.installed[parsed.id] !== undefined && options.overwrite !== true) {
    return { ok: false, error: '本机已经装过同 id 的主题：' + parsed.id, exists: true, id: parsed.id }
  }
  try {
    mkdirSync(themesDir(), { recursive: true })
    atomicWrite(themeCssPath(parsed.id), parsed.css)
  } catch (error) {
    return { ok: false, error: '写主题文件失败：' + String(error && error.message ? error.message : error) }
  }
  return { ok: true, id: parsed.id, manifest: parsed.manifest, sha256: parsed.sha256, bytes: Buffer.byteLength(parsed.css, 'utf8') }
}

/** 主题仓库检出目录是否像一个主题仓库（有 `themes/`）。 */
export function isThemeRepo(path) {
  const root = typeof path === 'string' ? path.trim() : ''
  if (root === '') return false
  try {
    return statSync(join(root, 'themes')).isDirectory()
  } catch (_error) {
    return false
  }
}

/**
 * 在会话工作区里找主题仓库检出。
 *
 * 找法**只有一种**：工作区根下的 `dsh-puzzle-themes`（以及它的一层子目录里同名者）。
 * 找不到返回空串——**不猜**。猜错的后果是「往一个不相干的仓库里推了主题」，
 * 而这类事故的代价远高于「让用户手动填一次路径」。
 */
export function findThemeRepo(workspaceRoot) {
  const root = typeof workspaceRoot === 'string' && workspaceRoot.trim() !== '' ? workspaceRoot : ''
  if (root === '') return ''
  const direct = join(root, THEME_REPO_DIRNAME)
  if (isThemeRepo(direct)) return direct
  // 工作区里常见一层包装目录（`<工作区>/<项目名>/<仓库>`），扫一层。
  let names = []
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (_error) {
    return ''
  }
  for (const name of names) {
    const nested = join(root, name, THEME_REPO_DIRNAME)
    if (isThemeRepo(nested)) return nested
  }
  return ''
}

/**
 * 跑一条 git 命令。
 *
 * **为什么用 `spawnSync` 而不是 `execSync`**：参数要一个个传（`git`、`add`、`-A`…），
 * 拼成一个字符串就会踩到引号与空格（路径里有空格时行为完全不同）。
 *
 * 凭据：**什么都不传**。git 会走它自己的凭据链（credential helper / SSH agent /
 * 环境变量），插件从头到尾不读、不存、不转发任何令牌。
 */
export function gitRun(repoPath, args, options = {}) {
  const cwd = typeof repoPath === 'string' ? repoPath : ''
  const list = Array.isArray(args) ? args.filter((item) => typeof item === 'string') : []
  if (cwd === '' || list.length === 0) return { ok: false, error: 'git 参数为空' }
  const timeout = Number.isSafeInteger(options.timeout) && options.timeout > 0 ? options.timeout : GIT_TIMEOUT_MS
  let result = null
  try {
    result = spawnSync('git', list, { cwd, encoding: 'utf8', timeout, windowsHide: true })
  } catch (error) {
    return { ok: false, error: '跑 git 失败：' + String(error && error.message ? error.message : error) }
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  if (result.error !== undefined && result.error !== null) {
    const code = result.error.code
    return {
      ok: false,
      error: code === 'ETIMEDOUT' ? 'git 超时' : '跑 git 失败：' + String(result.error.message ?? result.error),
      stdout,
      stderr,
    }
  }
  if (result.status !== 0) {
    return { ok: false, error: `git ${list[0]} 退出码 ${String(result.status)}`, stdout, stderr }
  }
  return { ok: true, stdout, stderr }
}

/** `git status --porcelain` 的解析：回 `[{ status, path }]`。 */
export function parseGitStatus(text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue
    const status = line.slice(0, 2).trim()
    const path = line.slice(3).trim()
    if (path === '') continue
    out.push({ status, path })
  }
  return out
}

/**
 * 上传一套主题到主题仓库：写文件 → 重算清单 → 提交 → 推送。
 *
 * ## 每一步为什么都不可省
 *
 *   - **重算清单**：不重算，用户下载时 sha256 对不上，会看到「sha256 不匹配，拒绝安装」——
 *     那正是主题仓库脚本注释里记着的老事故。所以这里**先**校验（用插件自己的尺子），
 *     再过就重算，任何一步不过就整条中止，不推半个状态上去。
 *   - **提交信息带上主题名**：`git log` 是别人了解「这套皮肤是怎么来的」的唯一线索。
 *   - **推送前查 remote**：没有 remote 就明确说「这里推不出去」，
 *     而不是让 `git push` 吐一段英文错误。
 *
 * 返回里带每一步的输出，面板把它原样显示——本仓老教训：
 * **诊断行写死会让误报与真错同形**。
 */
export function uploadTheme(repoPath, id, options = {}) {
  const themeId = themeIdOf(id)
  if (themeId === '') return { ok: false, error: '主题 id 不合法' }
  const root = typeof repoPath === 'string' ? repoPath.trim() : ''
  if (root === '') return { ok: false, error: '没找到主题仓库的检出目录', hint: `把主题仓库克隆到工作区里名为 ${THEME_REPO_DIRNAME} 的目录下，或在面板里填路径` }
  if (!isThemeRepo(root)) return { ok: false, error: '这个目录不像主题仓库（缺 themes/）：' + root }
  const cssPath = join(root, 'themes', themeId, 'theme.css')
  if (!existsSync(cssPath)) return { ok: false, error: '这套主题的 theme.css 还不存在：' + cssPath, hint: '先点「开发主题」建脚手架并写好 CSS' }
  // 上传前**最后一道**校验：用插件自己的尺子量一遍。不合格就绝不推上去——
  // 推上去的坏主题会让**所有**用户装不上，那比本地报错严重得多。
  let css = ''
  try {
    css = readFileSync(cssPath, 'utf8')
  } catch (error) {
    return { ok: false, error: '读 theme.css 失败：' + String(error && error.message ? error.message : error) }
  }
  const valid = validateThemeCss(css)
  if (valid.ok !== true) return { ok: false, error: 'theme.css 未通过安全校验，拒绝上传：' + valid.error }
  const rebuilt = rebuildThemeIndex(root)
  if (rebuilt.ok !== true) {
    return { ok: false, error: rebuilt.error, problems: rebuilt.problems }
  }
  const steps = []
  steps.push({ step: 'index', ok: true, detail: `清单已重算（${rebuilt.count} 套主题${rebuilt.changed ? '，有变化' : '，无变化'}）` })

  const add = gitRun(root, ['add', '-A'])
  if (add.ok !== true) return { ok: false, error: 'git add 失败：' + add.error, steps, stderr: add.stderr }
  steps.push({ step: 'add', ok: true, detail: 'git add -A' })

  const status = gitRun(root, ['status', '--porcelain'])
  const changes = status.ok === true ? parseGitStatus(status.stdout) : []
  if (changes.length === 0) {
    return {
      ok: false,
      error: '没有任何改动可提交（这套主题和仓库里的已经一模一样）',
      steps,
      repoPath: root,
      hint: '改点东西再传，或者你其实已经传过了',
    }
  }
  steps.push({ step: 'status', ok: true, detail: `待提交 ${changes.length} 个文件` })

  const name = typeof options.name === 'string' && options.name.trim() !== '' ? options.name.trim() : themeId
  const message = typeof options.message === 'string' && options.message.trim() !== ''
    ? options.message.trim()
    : `feat(theme): ${name}（${themeId}）`
  const commit = gitRun(root, ['-c', 'user.name=dsh-puzzle-mode', '-c', 'user.email=agent@local', 'commit', '-m', message])
  if (commit.ok !== true) {
    // 「没东西可提交」不是失败，但前面已经用 status 挡过了；这里真的是错。
    return { ok: false, error: 'git commit 失败：' + commit.error, steps, stderr: commit.stderr }
  }
  steps.push({ step: 'commit', ok: true, detail: message })

  const remotes = gitRun(root, ['remote'])
  const remoteNames = remotes.ok === true ? remotes.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '') : []
  if (remoteNames.length === 0) {
    return {
      ok: false,
      error: '提交好了，但这个仓库没有 remote，推不出去',
      steps,
      repoPath: root,
      committed: true,
      hint: '先 `git remote add origin <你的主题仓库地址>`，再点一次上传',
    }
  }
  const branchResult = gitRun(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = branchResult.ok === true ? branchResult.stdout.trim() : ''
  const pushArgs = branch === '' || branch === 'HEAD' ? ['push'] : ['push', '-u', 'origin', branch]
  const push = gitRun(root, pushArgs, { timeout: typeof options.timeout === 'number' ? options.timeout : GIT_TIMEOUT_MS })
  if (push.ok !== true) {
    return {
      ok: false,
      error: 'git push 失败：' + push.error,
      steps,
      repoPath: root,
      committed: true,
      stderr: push.stderr,
      hint: '提交已经在本机了，推送失败不影响它。检查网络或凭据后重试推送即可',
    }
  }
  steps.push({ step: 'push', ok: true, detail: `已推送到 origin${branch === '' ? '' : '/' + branch}` })
  return {
    ok: true,
    id: themeId,
    repoPath: root,
    branch,
    commit: commit.stdout.split(/\r?\n/)[0] ?? '',
    files: changes.length,
    count: rebuilt.count,
    steps,
    // 推上去之后，别人**怎么**看到它：这里如实说清，用户才知道分享成功没有。
    hint: `已推送。别人在主题页点「刷新列表」就能看到「${name}」并一键安装。`,
  }
}

/** 分享路径的两种形态（面板上说明用）。 */
export const THEME_SHARE_MODES = Object.freeze([
  { key: 'repo', label: '推到主题仓库', detail: '别人刷新主题列表就能看到、一键安装' },
  { key: 'pack', label: '导出单文件主题包', detail: '发给对方粘贴导入，不依赖 git 与网络源' },
])

/** 默认主题仓库地址（面板上显示「推到哪里」用）。 */
export function themeRepoSshHint(repo = DEFAULT_THEME_REPO) {
  return `https://github.com/${repo}.git`
}

/** 主题目录里所有主题的 id（导入时用来判断重名）。 */
export function installedThemeIds(themeState) {
  const installed = themeState !== null && typeof themeState === 'object' && themeState.installed !== null && typeof themeState.installed === 'object'
    ? themeState.installed
    : {}
  return Object.keys(installed).filter((id) => THEME_ID_RE.test(id)).sort()
}

/** 主题包的目录（导出到哪）。 */
export function themePackDir(workspaceRoot) {
  const root = typeof workspaceRoot === 'string' && workspaceRoot.trim() !== '' ? workspaceRoot : ''
  return root === '' ? '' : join(root, 'themes-out')
}

/** 把主题包写到磁盘（导出用）。 */
export function writeThemePack(workspaceRoot, pack) {
  const dir = themePackDir(workspaceRoot)
  if (dir === '') return { ok: false, error: '拿不到工作区目录' }
  if (pack === null || typeof pack !== 'object' || typeof pack.text !== 'string') {
    return { ok: false, error: '没有可写的主题包' }
  }
  const filename = typeof pack.filename === 'string' && pack.filename !== '' ? pack.filename : 'theme' + THEME_PACK_EXT
  const path = join(dir, filename)
  try {
    mkdirSync(dir, { recursive: true })
    atomicWrite(path, pack.text)
  } catch (error) {
    return { ok: false, error: '写主题包失败：' + String(error && error.message ? error.message : error) }
  }
  return { ok: true, path, bytes: Buffer.byteLength(pack.text, 'utf8') }
}

/** 主题包目录里现有的包文件（诊断用）。 */
export function listThemePacks(workspaceRoot) {
  const dir = themePackDir(workspaceRoot)
  if (dir === '') return []
  let names = []
  try {
    names = readdirSync(dir)
  } catch (_error) {
    return []
  }
  return names.filter((name) => name.endsWith(THEME_PACK_EXT)).sort()
}

/** 主题仓库的 git 状态摘要（面板「上传」区显示）。 */
export function themeRepoStatus(repoPath) {
  const root = typeof repoPath === 'string' ? repoPath.trim() : ''
  if (root === '' || !isThemeRepo(root)) {
    return { ok: false, found: false, path: root, hint: `没找到主题仓库检出。把它克隆到工作区下名为 ${THEME_REPO_DIRNAME} 的目录里。` }
  }
  const branchResult = gitRun(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const statusResult = gitRun(root, ['status', '--porcelain'])
  const remoteResult = gitRun(root, ['remote', 'get-url', 'origin'])
  const changes = statusResult.ok === true ? parseGitStatus(statusResult.stdout) : []
  return {
    ok: true,
    found: true,
    path: root,
    branch: branchResult.ok === true ? branchResult.stdout.trim() : '',
    remote: remoteResult.ok === true ? remoteResult.stdout.trim() : '',
    dirty: changes.length > 0,
    changes: changes.length,
    files: changes.slice(0, 20),
  }
}

/** 主题仓库里现有的主题 id（面板判断「已存在」用）。 */
export function repoThermIds(repoPath) {
  const root = typeof repoPath === 'string' ? repoPath.trim() : ''
  if (root === '') return []
  let names = []
  try {
    names = readdirSync(join(root, 'themes'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch (_error) {
    return []
  }
  return names.filter((id) => THEME_ID_RE.test(id)).sort()
}

/** 路径的父目录（面板显示「写到哪」用）。 */
export function parentOf(path) {
  const value = typeof path === 'string' ? path : ''
  return value === '' ? '' : dirname(value)
}

/** 读一个主题仓库里的主题（导出包时用）。 */
export function readRepoTheme(repoPath, id) {
  const themeId = themeIdOf(id)
  if (themeId === '') return { ok: false, error: '主题 id 不合法' }
  const root = typeof repoPath === 'string' ? repoPath.trim() : ''
  if (root === '') return { ok: false, error: '主题仓库路径为空' }
  const manifestPath = join(root, 'themes', themeId, 'manifest.json')
  const cssPath = join(root, 'themes', themeId, 'theme.css')
  if (!existsSync(cssPath)) return { ok: false, error: '这个主题没有 theme.css：' + cssPath }
  let css = ''
  let manifest = {}
  try {
    css = readFileSync(cssPath, 'utf8')
  } catch (error) {
    return { ok: false, error: '读 theme.css 失败：' + String(error && error.message ? error.message : error) }
  }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (_error) {
    manifest = {}
  }
  return {
    ok: true,
    id: themeId,
    css,
    name: typeof manifest.name === 'string' && manifest.name !== '' ? manifest.name : themeId,
    author: typeof manifest.author === 'string' ? manifest.author : '',
    description: typeof manifest.description === 'string' ? manifest.description : '',
    version: typeof manifest.version === 'string' ? manifest.version : '',
    accent: typeof manifest.accent === 'string' ? manifest.accent : '',
  }
}

/** 写出一个主题文件（导入主题包时用；`overwrite` 由调用方先问过）。 */
export function writeRepoTheme(repoPath, id, css, manifest) {
  const themeId = themeIdOf(id)
  if (themeId === '') return { ok: false, error: '主题 id 不合法' }
  const root = typeof repoPath === 'string' ? repoPath.trim() : ''
  if (root === '') return { ok: false, error: '主题仓库路径为空' }
  const valid = validateThemeCss(css)
  if (valid.ok !== true) return { ok: false, error: 'CSS 未通过安全校验：' + valid.error }
  const dir = join(root, 'themes', themeId)
  try {
    mkdirSync(dir, { recursive: true })
    atomicWrite(join(dir, 'theme.css'), css)
    atomicWrite(join(dir, 'manifest.json'), JSON.stringify({
      name: typeof manifest?.name === 'string' && manifest.name !== '' ? manifest.name : themeId,
      author: typeof manifest?.author === 'string' ? manifest.author : '',
      description: typeof manifest?.description === 'string' ? manifest.description : '',
      version: typeof manifest?.version === 'string' && manifest.version !== '' ? manifest.version : '1.0.0',
      accent: typeof manifest?.accent === 'string' ? manifest.accent : '',
    }, null, 2) + '\n')
  } catch (error) {
    return { ok: false, error: '写主题失败：' + String(error && error.message ? error.message : error) }
  }
  return { ok: true, id: themeId, dir }
}
