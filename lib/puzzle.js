/**
 * dsh-puzzle-mode —— 纯逻辑层（无 Cordis 依赖，可单独测试）。
 *
 * 这一层定义「拼图文档」的唯一契约：目录布局、主文档小节、模块文档模板、
 * 以及确定性的完整度算法。工具面（lib/index.js）与 UI 面（lib/client.js）
 * 读的都是同一份数据，所以完整度在任何地方都不会出现两个口径。
 *
 * 目录布局（项目名由用户给或按当天日期生成）：
 *   <项目根>/<项目名>/拼图/主文档.md
 *   <项目根>/<项目名>/拼图/模块/<模块名>.md
 *
 * 不变量：
 *   - 模块名经过 slug 过滤，且解析后的路径必须仍在「拼图/」内（路径守卫）。
 *   - 所有写盘都是「临时文件 + rename」的原子写。
 *   - front-matter 中的 `计划模块:` 是模块清单的权威来源，UI 据此显示「未建」图块。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** 文档文件夹固定名。 */
export const PUZZLE_DIR = '拼图'
export const MAIN_FILE = '主文档.md'
export const MODULE_DIR = '模块'

/** 两种执行模式。 */
export const MODE_PUZZLE_ONLY = '只拼不写'
export const MODE_PUZZLE_WRITE = '边拼边写'
export const MODES = [MODE_PUZZLE_ONLY, MODE_PUZZLE_WRITE]
export const DEFAULT_MODE = MODE_PUZZLE_ONLY

/**
 * 固定收尾问：**每一次提问都必须带上它**。
 * 选项顺序就是建议顺序——「停下」在前且为推荐项。
 */
export const PAUSE_QUESTION = '要不要先停下？'
export const PAUSE_OPTIONS = ['停下，等我看过再说', '继续，不用停']

/** 只拼不写模式下仍然允许的工具（其余工具会被 agent/pre-step 拦下）。 */
export const PUZZLE_ONLY_ALLOWED_TOOLS = ['puzzle_mode', 'read', 'grep', 'glob', 'ask_user_question', 'todo_write']

/** 主文档固定小节，顺序即模板顺序。 */
export const SECTION_ORDER = ['index', 'pit', 'quote', 'pending', 'decided', 'revoked']
export const SECTION_HEADINGS = {
  index: '## 检索索引',
  pit: '## 坑',
  quote: '## 用户原话',
  pending: '## 悬而未决',
  decided: '## 已定',
  revoked: '## 撤销',
}
const HEADING_BY_KEY = SECTION_ORDER.map((key) => [key, SECTION_HEADINGS[key]])
const SECTION_KEYS = new Set(SECTION_ORDER)
export const MODULE_SECTION_KEYS = ['progress', 'points', 'related', 'detail']

/** 每个图块的满分（用于 UI 显示 得分/满分）。 */
export const PIECE_MAX = 100

/* ---------------------------------- 小工具 ---------------------------------- */

function listFiles(dir) {
  try {
    return readdirSync(dir)
  } catch (_error) {
    return []
  }
}

function isFile(file) {
  try {
    return statSync(file).isFile()
  } catch (_error) {
    return false
  }
}

function isDir(dir) {
  try {
    return statSync(dir).isDirectory()
  } catch (_error) {
    return false
  }
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** 解析一个安全 slug；返回 null 表示这个名字不能用。 */
export function slugify(raw) {
  if (typeof raw !== 'string') return null
  const cleaned = raw
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[\\/:*?"<>|#%&{}$!'@`+=~^[\];,]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 64)
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return null
  return cleaned
}

/** 今天的日期前缀，形如 2026-09-19。 */
export function defaultProjectName(text, now = new Date()) {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
  const word = slugify(typeof text === 'string' ? text.replace(/[\s，。,.、:：;；!！?？]/g, ' ').trim().slice(0, 12) : '')
  const tail = word === null || word === '' ? '项目' : word.split('-').filter(Boolean).slice(0, 2).join('-')
  return `${stamp}-${tail}`
}

export function timestamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return [
    now.getFullYear(), '-', pad(now.getMonth() + 1), '-', pad(now.getDate()),
    ' ', pad(now.getHours()), ':', pad(now.getMinutes()), ':', pad(now.getSeconds()),
  ].join('')
}

/* ------------------------------- front-matter ------------------------------- */

/** 写一段 front-matter（模块列表走 JSON，避免分隔符冲突）。 */
export function formatFrontMatter(fields) {
  const modules = Array.isArray(fields.modules) ? fields.modules : []
  const lines = [
    '---',
    `puzzle: ${fields.puzzle ?? 1}`,
    `项目: ${fields.project ?? ''}`,
    `模式: ${fields.mode ?? DEFAULT_MODE}`,
    `计划模块: ${JSON.stringify(modules)}`,
    `更新时间: ${fields.updated ?? timestamp()}`,
    '---',
  ]
  return lines.join('\n')
}

/** 读一份文档开头的 front-matter；没有则返回一个空对象。 */
export function parseFrontMatter(text) {
  const out = { fields: {}, body: text }
  if (typeof text !== 'string') return out
  const normalized = text.replace(/^\uFEFF/, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(normalized)
  if (match === null) return out
  const out2 = {}
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    out2[key] = value
  }
  return { fields: out2, body: normalized.slice(match[0].length) }
}

/* --------------------------------- 小节读写 --------------------------------- */

/** 取出某个 `## 标题` 小节的正文（到下一个 `## ` 为止）。 */
export function getSection(text, heading) {
  const lines = String(text ?? '').split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === heading.trim()) {
      start = i + 1
      break
    }
  }
  if (start < 0) return null
  let end = lines.length
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

/** 按 KEY → 标题 读出全部小节。 */
export function sectionMap(text) {
  const out = {}
  for (const [key, heading] of HEADING_BY_KEY) out[key] = getSection(text, heading)
  return out
}

/**
 * 替换/插入一个小节。返回值直接写盘，所以只在这里做一次行级拼装：
 * 找到 `## 标题` 就替换它的正文，找不到就插到最后一个已知小节之后（没有就插到文末）。
 */
export function withSection(text, heading, content) {
  const body = String(content ?? '').replace(/^\n+/, '').replace(/\s+$/, '')
  const lines = String(text ?? '').split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === heading.trim())
  const block = body === '' ? [] : body.split('\n')

  if (start >= 0) {
    let end = lines.length
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^##\s/.test(lines[i])) {
        end = i
        break
      }
    }
    return [...lines.slice(0, start + 1), ...block, ...lines.slice(end)].join('\n')
  }

  let insertAt = lines.length
  for (const [, known] of HEADING_BY_KEY) {
    const at = lines.findIndex((line) => line.trim() === known.trim())
    if (at >= 0) insertAt = Math.max(insertAt, at + 1)
  }
  // insertAt 落在已存在的最后一个已知小节标题之后：把新小节标题插到那里。
  // 为了不和该小节正文交错，先找到它的正文结束位置。
  if (insertAt < lines.length) {
    let end = lines.length
    for (let i = insertAt; i < lines.length; i += 1) {
      if (/^##\s/.test(lines[i])) {
        end = i
        break
      }
    }
    insertAt = end
  }
  return [...lines.slice(0, insertAt), '', heading, ...block, ...lines.slice(insertAt)].join('\n')
}

/** 覆盖或追加一个小节。 */
export function applySection(text, heading, content, append) {
  const current = getSection(text, heading)
  if (append === true && current !== null && current.trim() !== '') {
    const merged = `${current.replace(/\s+$/, '')}\n${String(content ?? '').replace(/^\n+/, '').replace(/\s+$/, '')}`
    return withSection(text, heading, merged)
  }
  return withSection(text, heading, content)
}

/* --------------------------------- 模板 --------------------------------- */

export function mainTemplate(project, modules, goal, mode = DEFAULT_MODE) {
  const lines = [
    formatFrontMatter({ project, mode, modules, updated: timestamp() }),
    `# ${project} · 主文档`,
    '',
    '> 本文件只做检索、坑、原话与三类决策；细节一律在 `模块/` 下。',
  ]
  if (typeof goal === 'string' && goal.trim() !== '') lines.push('', `> 目标：${goal.trim().replace(/\n+/g, ' ')}`)
  lines.push('', SECTION_HEADINGS.index)
  if (modules.length === 0) lines.push('- （尚未拆分模块）')
  for (const module of modules) lines.push(`- 模块：${module} —— （一句话职责） —— 模块/${module}.md`)
  for (const key of SECTION_ORDER.slice(1)) lines.push('', SECTION_HEADINGS[key], '- （待补）')
  return `${lines.join('\n')}\n`
}

export function moduleTemplate(module) {
  return [
    formatFrontMatter({ project: module, mode: DEFAULT_MODE, modules: [], updated: timestamp() }),
    `# ${module}`,
    '',
    '## 进度',
    '完成度: 0',
    '',
    '## 要点',
    '- （该模块的关键结论，只留事实）',
    '',
    '## 与本模块相关的悬而未决 / 已定 / 撤销',
    '- [ ] （待补）',
    '',
    '## 详细记录',
    '- （细化记录；主文档只留一行索引）',
    '',
  ].join('\n')
}

/* --------------------------------- 路径与落盘 --------------------------------- */

/** 把相对路径拼到 root 下，并确认结果没有逃出 root。 */
export function safeJoin(root, ...parts) {
  const target = resolve(root, ...parts)
  const base = resolve(root)
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}

/** 解析项目根下的 拼图/ 目录；不在项目根内则返回 null。 */
export function puzzleDirOf(projectRoot, projectName) {
  if (typeof projectRoot !== 'string' || projectRoot === '') return null
  const slug = slugify(projectName)
  if (slug === null) return null
  return safeJoin(projectRoot, slug, PUZZLE_DIR)
}

/** 扫出项目根下所有已有拼图项目（按修改时间倒序）。 */
export function listProjects(projectRoot) {
  const found = []
  for (const entry of listFiles(projectRoot)) {
    const main = join(projectRoot, entry, PUZZLE_DIR, MAIN_FILE)
    if (!isFile(main)) continue
    let mtimeMs = 0
    try {
      mtimeMs = statSync(main).mtimeMs
    } catch (_error) {
      mtimeMs = 0
    }
    found.push({ name: entry, dir: join(projectRoot, entry, PUZZLE_DIR), mainDoc: main, mtimeMs })
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found
}

/** 原子写：先写同目录临时文件再 rename，避免读到半截文档。 */
export function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (_error) {
    return null
  }
}

/* --------------------------------- 计分 --------------------------------- */

/** 剔掉空行与占位行（模板自带的「（待补）」一类，不能算内容）。 */
function nonEmptyLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter((line) => {
      if (line === '') return false
      if (/^（?待补）?$/.test(line)) return false
      // 模板里的说明性占位：整行就是一对括号（可选前缀「（」后的说明文字）
      if (/^[（(][^）)]*[）)]$/.test(line)) return false
      return true
    })
}

function countItems(text) {
  const lines = nonEmptyLines(text)
  const bullets = lines.filter((line) => /^[-*]\s+\S/.test(line))
  if (bullets.length > 0) return bullets.length
  return lines.length
}

/**
 * 模块完整度：以 `完成度:` 为准；模板自带的 `完成度: 0` 视为「尚未填」，
 * 这时按要点与详细记录条数推算，避免新建模块一写完却仍显示 0%。
 */
function moduleScoreOf(text) {
  const progress = getSection(text, '## 进度')
  const match = progress === null ? null : /完成度\s*[:：]\s*(\d{1,3})/.exec(progress)
  const declared = match === null ? 0 : clampPercent(Number(match[1]))
  if (declared > 0) return declared
  const detail = countItems(getSection(text, '## 详细记录'))
  const points = countItems(getSection(text, '## 要点'))
  return clampPercent(points * 15 + detail * 10)
}

function scoreSection(key, raw) {
  if (raw === null || raw.trim() === '') return 0
  const items = countItems(raw)
  const lines = nonEmptyLines(raw).length
  switch (key) {
    case 'index':
      return clampPercent(lines * 20)
    case 'pit':
      return clampPercent(items * 25)
    case 'quote':
      return clampPercent(items * 25)
    case 'pending':
      return clampPercent(items * 20)
    case 'decided':
      return clampPercent(items * 20)
    case 'revoked':
      return clampPercent(items * 50)
    default:
      return 0
  }
}

/** 所有小节齐全 + 模块文档齐全 → 初始化图块满分。 */
function initScore(sections, modules, hasMain) {
  if (!hasMain) return 0
  const present = SECTION_ORDER.filter((key) => sections[key] !== null && sections[key].trim() !== '').length
  const planned = modules.length
  const built = modules.filter((module) => isFile(module.file)).length
  const moduleRatio = planned === 0 ? 0 : (built / planned) * 25
  return clampPercent(10 + (present / SECTION_ORDER.length) * 65 + moduleRatio)
}

function pieceOf(id, kind, name, score, extra = {}) {
  return {
    id,
    kind,
    name,
    score: clampPercent(score),
    max: PIECE_MAX,
    ...extra,
  }
}

/* --------------------------------- 状态读取 --------------------------------- */

function moduleEntries(puzzleDir, modules) {
  return modules.map((name) => {
    const file = join(puzzleDir, MODULE_DIR, `${name}.md`)
    const text = isFile(file) ? readText(file) : null
    const sections = text === null ? { progress: null, points: null, related: null, detail: null } : {
      progress: getSection(text, '## 进度'),
      points: getSection(text, '## 要点'),
      related: getSection(text, '## 与本模块相关的悬而未决 / 已定 / 撤销'),
      detail: getSection(text, '## 详细记录'),
    }
    return {
      name,
      file,
      exists: text !== null,
      score: text === null ? 0 : moduleScoreOf(text),
      counts: {
        points: countItems(sections.points),
        pending: (sections.related ?? '').split(/\r?\n/).filter((line) => /^\s*[-*]\s*\[ \]/.test(line)).length,
        decided: (sections.related ?? '').split(/\r?\n/).filter((line) => /^\s*[-*]\s*\[[xX]\]/.test(line)).length,
      },
    }
  })
}

/**
 * 读一个项目的最新状态。**从不抛错、从不写盘**：
 * 目录不存在 → initialized:false；主文档坏 → 记 degraded 并继续尽力解析。
 */
export function readState(projectRoot, projectName) {
  const slug = typeof projectName === 'string' ? slugify(projectName) : null
  const puzzleDir = slug === null ? null : puzzleDirOf(projectRoot, slug)
  const mainDoc = puzzleDir === null ? null : join(puzzleDir, MAIN_FILE)
  const base = {
    initialized: false,
    degraded: false,
    projectRoot: typeof projectRoot === 'string' ? projectRoot : '',
    project: slug ?? '',
    puzzleDir: puzzleDir ?? '',
    mainDoc: mainDoc ?? '',
    mode: DEFAULT_MODE,
    modules: [],
    pieces: [],
    overall: 0,
    planned: [],
    error: null,
  }
  if (mainDoc === null || !isFile(mainDoc)) return base

  const text = readText(mainDoc)
  if (text === null) return { ...base, error: '主文档存在但读不出来' }

  const { fields, body } = parseFrontMatter(text)
  let planned = []
  const rawModules = fields['计划模块']
  if (typeof rawModules === 'string' && rawModules.trim() !== '') {
    try {
      const parsed = JSON.parse(rawModules)
      if (Array.isArray(parsed)) planned = parsed.filter((item) => typeof item === 'string')
    } catch (_error) {
      base.degraded = true
    }
  }
  if (planned.length === 0) {
    for (const entry of listFiles(join(puzzleDir, MODULE_DIR))) {
      if (entry.endsWith('.md')) planned.push(entry.slice(0, -3))
    }
  }
  planned = [...new Set(planned.map((item) => slugify(item)).filter((item) => item !== null))]

  const sections = sectionMap(body)
  const modules = moduleEntries(puzzleDir, planned)
  const missingSections = SECTION_ORDER.filter((key) => sections[key] === null)

  const pieces = [
    pieceOf('init', 'init', '初始化', initScore(sections, modules, true)),
    ...SECTION_ORDER.map((key) => pieceOf(key, 'main', SECTION_HEADINGS[key].replace(/^##\s*/, ''), scoreSection(key, sections[key]), {
      counts: { items: sections[key] === null ? 0 : countItems(sections[key]) },
    })),
    ...modules.map((module) => pieceOf(`module:${module.name}`, 'module', module.name, module.score, {
      exists: module.exists,
      counts: module.counts,
    })),
  ]
  const overall = pieces.length === 0 ? 0 : clampPercent(pieces.reduce((sum, piece) => sum + piece.score, 0) / pieces.length)

  return {
    ...base,
    initialized: true,
    degraded: base.degraded,
    project: typeof fields['项目'] === 'string' && fields['项目'].trim() !== '' ? fields['项目'].trim() : slug,
    mode: MODES.includes(fields['模式']) ? fields['模式'] : DEFAULT_MODE,
    updated: fields['更新时间'] ?? null,
    modules,
    planned,
    missingSections,
    pieces,
    overall,
    goal: (body.split(/\r?\n/).find((line) => line.startsWith('> 目标：')) ?? '').replace(/^>\s*目标：/, '').trim(),
  }
}

/* --------------------------------- 写入 --------------------------------- */

/** 从 front-matter 里安全读出模块清单（坏 JSON 当空数组）。 */
function safePlanned(fields) {
  try {
    const parsed = JSON.parse(fields['计划模块'] ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => slugify(item)).filter((item) => item !== null)
  } catch (_error) {
    return []
  }
}

/** 只改主文档的行为字段（模式 / 模块清单），保留其余内容。 */
export function setMainFields(text, patch) {
  const { fields, body } = parseFrontMatter(text)
  const next = {
    puzzle: fields.puzzle ?? 1,
    project: patch.project ?? fields['项目'] ?? '',
    mode: patch.mode ?? fields['模式'] ?? DEFAULT_MODE,
    modules: patch.modules ?? JSON.parse(fields['计划模块'] ?? '[]'),
    updated: timestamp(),
  }
  if (!Array.isArray(next.modules)) next.modules = []
  if (!MODES.includes(next.mode)) next.mode = DEFAULT_MODE
  return `${formatFrontMatter(next)}\n${body.replace(/^\n+/, '')}`
}

/** 建目录 + 主文档 + N 份模块文档（已存在的模块文档不覆盖）。 */
export function createProject(projectRoot, projectName, goal, modules, mode = DEFAULT_MODE) {
  const slug = slugify(projectName)
  if (slug === null) return { ok: false, error: '项目名不合法', hint: '换一个不含路径符号的名字' }
  const projectDir = safeJoin(projectRoot, slug)
  if (projectDir === null) return { ok: false, error: '项目路径越界', hint: '项目名不能包含 ../' }
  const puzzleDir = join(projectDir, PUZZLE_DIR)
  const mainDoc = join(puzzleDir, MAIN_FILE)
  const names = []
  for (const raw of Array.isArray(modules) ? modules : []) {
    const name = slugify(raw)
    if (name === null) continue
    if (!names.includes(name)) names.push(name)
  }

  try {
    mkdirSync(join(puzzleDir, MODULE_DIR), { recursive: true })
    if (!isFile(mainDoc)) atomicWrite(mainDoc, mainTemplate(slug, names, goal, mode))
    const created = []
    for (const name of names) {
      const file = join(puzzleDir, MODULE_DIR, `${name}.md`)
      if (isFile(file)) continue
      atomicWrite(file, moduleTemplate(name))
      created.push(name)
    }
    return { ok: true, project: slug, puzzleDir, mainDoc, created, modules: names, existing: names.filter((name) => !created.includes(name)) }
  } catch (error) {
    return { ok: false, error: '创建文档失败', hint: String(error && error.message ? error.message : error) }
  }
}

/** 更新主文档的一个小节；index 小节同时刷新 front-matter 的模块清单。 */
export function updateMainSection(projectRoot, projectName, section, content, append = true) {
  if (!SECTION_KEYS.has(section)) {
    return { ok: false, error: `未知小节 ${section}`, hint: `可用：${SECTION_ORDER.join(' / ')}` }
  }
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: '项目尚未创建', hint: '先执行 op=init' }
  const text = readText(mainDoc)
  if (text === null) return { ok: false, error: '主文档读不出来', hint: '检查文件权限' }

  const { fields, body } = parseFrontMatter(text)
  const nextBody = applySection(body, SECTION_HEADINGS[section], content, append !== false)
  let planned = null
  if (section === 'index') {
    // 检索索引里出现过的模块名，同步进 front-matter 的模块清单（UI 的图块据此建出来）。
    const names = []
    for (const line of String(content ?? '').split(/\r?\n/)) {
      const match = /模块\s*[:：]\s*([^\s—\-–]+)/.exec(line) ?? /模块\/([^\s./]+)\.md/.exec(line)
      if (match === null) continue
      const name = slugify(match[1])
      if (name !== null && !names.includes(name)) names.push(name)
    }
    let previous = []
    try {
      const parsed = JSON.parse(fields['计划模块'] ?? '[]')
      if (Array.isArray(parsed)) previous = parsed
    } catch (_error) {
      previous = []
    }
    planned = [...new Set([...previous, ...names])]
  }
  const next = [
    formatFrontMatter({
      puzzle: fields.puzzle ?? 1,
      project: fields['项目'] ?? projectName,
      mode: MODES.includes(fields['模式']) ? fields['模式'] : DEFAULT_MODE,
      modules: planned ?? safePlanned(fields),
      updated: timestamp(),
    }),
    nextBody.replace(/^\n+/, ''),
  ].join('\n')
  try {
    atomicWrite(mainDoc, next)
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return { ok: true, mainDoc, section }
}

/** 更新（必要时创建）模块文档的一个小节。 */
export function updateModuleSection(projectRoot, projectName, moduleName, section, content, append = true) {
  if (!MODULE_SECTION_KEYS.includes(section)) {
    return { ok: false, error: `未知模块小节 ${section}`, hint: `可用：${MODULE_SECTION_KEYS.join(' / ')}` }
  }
  const slug = slugify(moduleName)
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (slug === null) return { ok: false, error: '模块名不合法', hint: '换一个不含路径符号的名字' }
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const file = safeJoin(puzzleDir, MODULE_DIR, `${slug}.md`)
  if (file === null) return { ok: false, error: '模块路径越界', hint: '模块名不能包含 ../' }

  let text = isFile(file) ? readText(file) : null
  const created = text === null
  if (text === null) text = moduleTemplate(slug)

  if (section === 'progress') {
    const percent = clampPercent(Number(String(content).replace(/[^\d]/g, '')))
    text = applySection(text, '## 进度', `完成度: ${percent}`, false)
  } else {
    const heading = {
      points: '## 要点',
      related: '## 与本模块相关的悬而未决 / 已定 / 撤销',
      detail: '## 详细记录',
    }[section]
    text = applySection(text, heading, content, append !== false)
  }

  try {
    mkdirSync(join(puzzleDir, MODULE_DIR), { recursive: true })
    atomicWrite(file, text)
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }

  // 模块第一次出现时，把它补进主文档 front-matter 的模块清单。
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (isFile(mainDoc)) {
    const mainText = readText(mainDoc)
    if (mainText !== null) {
      const { fields } = parseFrontMatter(mainText)
      let planned = []
      try {
        planned = JSON.parse(fields['计划模块'] ?? '[]')
      } catch (_error) {
        planned = []
      }
      if (!Array.isArray(planned)) planned = []
      if (!planned.includes(slug)) {
        try {
          atomicWrite(mainDoc, setMainFields(mainText, { modules: [...planned, slug] }))
        } catch (_error) {
          /* 补清单失败不影响模块文档本身的写入结果 */
        }
      }
    }
  }

  return { ok: true, file, created, section }
}

/** 写模式（主文档 front-matter）。 */
export function setMode(projectRoot, projectName, mode) {
  if (!MODES.includes(mode)) return { ok: false, error: `未知模式 ${mode}`, hint: `可用：${MODES.join(' / ')}` }
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: '项目尚未创建', hint: '先执行 op=init' }
  const text = readText(mainDoc)
  if (text === null) return { ok: false, error: '主文档读不出来', hint: '检查文件权限' }
  try {
    atomicWrite(mainDoc, setMainFields(text, { mode }))
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return { ok: true, mode, mainDoc }
}

/* --------------------------------- 汇总输出 --------------------------------- */

/** 工具返回给模型的最小事实集（不序列化任何宿主对象）。 */
export function summarize(state, extra = {}) {
  if (state.initialized !== true) {
    return {
      ok: true,
      initialized: false,
      projectRoot: state.projectRoot,
      error: state.error ?? null,
      hint: `尚无拼图项目：在项目根下用 op=init 一次创建主文档与模块文档（目录 ${'<项目名>/' + PUZZLE_DIR}/）`,
      askPause: true,
      pauseQuestion: PAUSE_QUESTION,
      pauseOptions: PAUSE_OPTIONS,
      ...extra,
    }
  }
  return {
    ok: true,
    initialized: true,
    degraded: state.degraded === true,
    projectRoot: state.projectRoot,
    projectDir: state.puzzleDir,
    mainDoc: state.mainDoc,
    project: state.project,
    mode: state.mode,
    modules: state.modules.map((module) => ({
      name: module.name,
      exists: module.exists,
      score: module.score,
      counts: module.counts,
    })),
    pieces: state.pieces,
    overall: state.overall,
    missingSections: state.missingSections ?? [],
    updated: state.updated ?? null,
    canExecute: state.mode === MODE_PUZZLE_WRITE,
    askPause: true,
    pauseQuestion: PAUSE_QUESTION,
    pauseOptions: PAUSE_OPTIONS,
    ...extra,
  }
}

export function isExecutableMode(mode) {
  return mode === MODE_PUZZLE_WRITE
}
