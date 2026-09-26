/**
 * dsh-puzzle-mode —— 纯逻辑层（无 Cordis 依赖，可单独测试）。
 *
 * 这一层定义「拼图文档」的唯一契约：目录布局、主文档小节、模块文档模板、
 * 以及确定性的**项目健康性**算法。工具面（lib/index.js）与 UI 面（lib/client.js）
 * 读的都是同一份数据，所以健康性在任何地方都不会出现两个口径。
 *
 * 目录布局（项目名由用户给或按当天日期生成）：
 *   <项目根>/<项目名>/拼图/主文档.md
 *   <项目根>/<项目名>/拼图/模块/<模块名>.md
 *
 * 不变量：
 *   - 模块名经过 slug 过滤，且解析后的路径必须仍在「拼图/」内（路径守卫）。
 *   - 所有写盘都是「临时文件 + rename」的原子写。
 *   - front-matter 中的 `计划模块:` 是模块清单的权威来源，UI 据此显示「未建」图块。
 *   - 「模式」是**项目级**设置，只存在于主文档；模块文档只记 `模块:`。
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

/**
 * 只拼不写模式下仍然允许的工具。
 *
 * 拦截点是 `tools/pre-execute`（可返回 `{kind:'deny'}`）——不是 `agent/pre-step`：
 * 后者的 `decision.messages` 契约是 `UserMessage[]`，里面根本没有 tool-call，
 * 在那上面做「剔除 assistant 消息」的拦截是死代码。
 *
 * 注意：文档写入**只能**走 `puzzle_mode` 工具（它做 slug 过滤与路径守卫）。
 * `write` / `edit` 不在白名单里，是有意的——它们能绕过守卫写到拼图目录之外。
 */
export const PUZZLE_ONLY_ALLOWED_TOOLS = ['puzzle_mode', 'read', 'grep', 'glob', 'ask_user_question', 'todo_write']

/* ------------------------------- 项目健康性 ------------------------------- */

/**
 * 五个健康性维度。**全部越高越好**（含「维护系数」——高分表示维护负担轻）。
 *
 * `derive` 是该维度的证据推导：模型没在文档里显式写分数时，用它从文档内容推。
 * 设计原则：**健康性反映的是「已经写在文档里的证据」，不是模型凭感觉打的印象分**。
 * 所以没有文档就没有健康性——空模块五维全 0，而不是"看起来还行给 60"。
 */
export const HEALTH_DIMENSIONS = [
  {
    key: 'complexity',
    name: '任务复杂度',
    /** 复杂度是中性事实：只有真的记下来了才拿得到分。 */
    hint: '模块实际承担的任务量；记下的要点与细节越多越完整',
    derive: (evidence) => clampPercent((evidence.points * 12) + (evidence.detail * 10)),
  },
  {
    key: 'extensibility',
    name: '可拓展性',
    hint: '还能往哪里长：悬而未决与已定的决策越多，扩展空间越清晰（模块自己的 + 主文档的）',
    // 主文档的悬而未决/已定对每个模块都算数——与 quality 用主文档的「坑」对称。
    // 否则主文档写了 5 条已定、这一维仍是 0，数字与文档事实矛盾。
    derive: (evidence) => clampPercent(
      ((evidence.pending ?? 0) + (evidence.projectPending ?? 0)) * 20
      + ((evidence.decided ?? 0) + (evidence.projectDecided ?? 0)) * 20,
    ),
  },
  {
    key: 'maintenance',
    name: '维护系数',
    hint: '维护负担轻的程度（高分 = 好维护）：要点写清了才敢改',
    derive: (evidence) => clampPercent((evidence.points * 18) + (evidence.detail * 8)),
  },
  {
    key: 'quality',
    name: '代码质量',
    hint: '坑与决策的沉淀程度：踩过的坑记下来了，质量才站得住',
    derive: (evidence) => clampPercent((evidence.pit * 25) + (evidence.decided * 15)),
  },
  {
    key: 'reusability',
    name: '可复用性',
    hint: '有多少可被别处复用的东西（共享模块、公共接口、抽象）',
    derive: (evidence) => clampPercent((evidence.shared * 30) + (evidence.points * 10)),
  },
]
export const HEALTH_KEYS = HEALTH_DIMENSIONS.map((dimension) => dimension.key)

/** 维度名的别名 → 规范名。`维护成本` 是反向量，见 parseHealthDeclarations。 */
const HEALTH_ALIASES = new Map([
  ['任务复杂度', 'complexity'],
  ['复杂度', 'complexity'],
  ['可拓展性', 'extensibility'],
  ['可扩展性', 'extensibility'],
  ['拓展性', 'extensibility'],
  ['维护系数', 'maintenance'],
  ['维护成本', 'maintenance'],
  ['代码质量', 'quality'],
  ['质量', 'quality'],
  ['可复用性', 'reusability'],
  ['复用性', 'reusability'],
])

/** 反向维度：写的是成本，取值要翻过来（100 − x）才是「越高越好」。 */
const INVERSE_LABELS = new Set(['维护成本'])

/** 主文档里的健康性汇总小节（项目级五维）。 */
export const HEALTH_HEADING = '## 健康性'

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
export const MODULE_SECTION_KEYS = ['health', 'progress', 'points', 'related', 'detail']
export const MODULE_SECTION_HEADINGS = {
  health: HEALTH_HEADING,
  progress: '## 进度',
  points: '## 要点',
  related: '## 与本模块相关的悬而未决 / 已定 / 撤销',
  detail: '## 详细记录',
}

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

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) return 0
  return clampPercent(values.reduce((sum, value) => sum + value, 0) / values.length)
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
  const word = slugify(typeof text === 'string' ? text.replace(/[\s，。,.、:：;；!！?？]/g, '/').trim().slice(0, 12) : '')
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

/**
 * 写一段 front-matter。
 *
 * 主文档：`项目 / 模式 / 计划模块`；模块文档：`项目 / 模块`。
 * 「模式」是项目级设置，模块文档不带它（早先模板误抄了 `模式:`，已去掉）。
 * 模块列表走 JSON，避免与 `、` 之类的分隔符冲突。
 */
export function formatFrontMatter(fields) {
  const modules = Array.isArray(fields.modules) ? fields.modules : []
  const lines = [
    '---',
    `puzzle: ${fields.puzzle ?? 1}`,
    `项目: ${fields.project ?? ''}`,
  ]
  if (typeof fields.module === 'string' && fields.module !== '') {
    lines.push(`模块: ${fields.module}`)
  } else {
    lines.push(`模式: ${fields.mode ?? DEFAULT_MODE}`)
    lines.push(`计划模块: ${JSON.stringify(modules)}`)
  }
  lines.push(`更新时间: ${fields.updated ?? timestamp()}`, '---')
  return lines.join('\n')
}

/** 读一份文档开头的 front-matter；没有则返回一个空对象。 */
export function parseFrontMatter(text) {
  const out = { fields: {}, body: text }
  if (typeof text !== 'string') return out
  const normalized = text.replace(/^\uFEFF/, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(normalized)
  if (match === null) return out
  const parsed = {}
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    parsed[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return { fields: parsed, body: normalized.slice(match[0].length) }
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

/* --------------------------------- 健康性解析 --------------------------------- */

/** 五维各一行，`维度: 分数`。这是模型可以直接写、人也能一眼看懂的格式。 */
export function healthLines(scores) {
  return HEALTH_DIMENSIONS
    .map((dimension) => `- ${dimension.name}: ${clampPercent(scores[dimension.key] ?? 0)}`)
    .join('\n')
}

/**
 * 模板里的健康性小节：**只列维度名、不写数字**。
 *
 * 早先的模板直接写 `任务复杂度: 0`，结果那五行被当成「显式声明 0」，
 * 推导永远不生效——空文档看起来像是"评估过了，全是 0"。
 * 留空则解析不出声明，推导正常工作，模型想覆盖再填数字。
 */
export function healthTemplateLines() {
  return HEALTH_DIMENSIONS
    .map((dimension) => `- ${dimension.name}: `)
    .join('\n')
}

/**
 * 解析文档里显式写的维度分数。
 *
 * 接受 `任务复杂度: 80`、`- 可拓展性：75`、`**维护系数**: 90` 等写法；
 * `维护成本: 30` 会被翻成 `维护系数: 70`（成本型 → 越高越好）。
 */
export function parseHealthDeclarations(text) {
  const declared = {}
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    // 顺序要紧：先去掉 `**粗体**`，再去列表符。
    // 反过来会把 `**维护系数**: 90` 开头的 `*` 当成列表符吃掉一个，
    // 剩下 `*维护系数: 90` 就再也匹配不上维度名了。
    const line = raw
      .replace(/\*\*/g, '')
      .replace(/^\s*[-*]\s*/, '')
      .trim()
    const match = /^([\u4e00-\u9fa5]{2,8})\s*[:：]\s*(\d{1,3})\s*$/.exec(line)
    if (match === null) continue
    const key = HEALTH_ALIASES.get(match[1])
    if (key === undefined) continue
    const value = clampPercent(Number(match[2]))
    declared[key] = INVERSE_LABELS.has(match[1]) ? clampPercent(100 - value) : value
  }
  return declared
}

/**
 * 从一份模块文档算出五维分数。
 *
 * 显式写了就用显式值（模型有上下文，比公式准）；没写则由证据推导。
 * `return` 里带 `sources`，说明每一维是显式还是推导来的——面板据此标注，
 * 免得把"公式推出来的"当成"模型评估过的"。
 */
export function healthOf(moduleText, projectText) {
  const text = typeof moduleText === 'string' ? moduleText : ''
  const body = text === '' ? '' : parseFrontMatter(text).body
  const projectBody = typeof projectText === 'string' && projectText !== '' ? parseFrontMatter(projectText).body : ''

  const pointsText = getSection(body, MODULE_SECTION_HEADINGS.points) ?? ''
  const detailText = getSection(body, MODULE_SECTION_HEADINGS.detail) ?? ''
  const relatedText = getSection(body, MODULE_SECTION_HEADINGS.related) ?? ''
  const sharedText = getSection(body, '## 可复用') ?? ''
  // 主文档的两节决策。**主文档用普通 `-` 列表，不写勾选框**（勾选框只在模块文档里
  // 用来区分「未决 / 已定」），所以这里按节直接计数，不要再按 `[ ]` 过滤一次——
  // 早先按勾选框过滤，导致主文档写了 5 条已定、可拓展性仍是 0。
  const projectPendingText = getSection(projectBody, SECTION_HEADINGS.pending) ?? ''
  const projectDecidedText = getSection(projectBody, SECTION_HEADINGS.decided) ?? ''

  const evidence = {
    points: countItems(pointsText),
    detail: countItems(detailText),
    pending: countItems(relatedText.split(/\r?\n/).filter((line) => /^\s*[-*]\s*\[ \]/.test(line)).join('\n')),
    decided: countItems(relatedText.split(/\r?\n/).filter((line) => /^\s*[-*]\s*\[[xX]\]/.test(line)).join('\n')),
    pit: countItems(getSection(projectBody, SECTION_HEADINGS.pit)),
    shared: countItems(sharedText),
    // 项目级决策：主文档的悬而未决 / 已定，供可拓展性使用（见 HEALTH_DIMENSIONS）。
    projectPending: countItems(projectPendingText),
    projectDecided: countItems(projectDecidedText),
  }

  const declaredModule = parseHealthDeclarations(getSection(body, HEALTH_HEADING) ?? '')
  const declaredProject = parseHealthDeclarations(getSection(projectBody, HEALTH_HEADING) ?? '')
  const scores = {}
  const sources = {}
  for (const dimension of HEALTH_DIMENSIONS) {
    if (Object.hasOwn(declaredModule, dimension.key)) {
      scores[dimension.key] = declaredModule[dimension.key]
      sources[dimension.key] = 'module'
    } else if (Object.hasOwn(declaredProject, dimension.key)) {
      scores[dimension.key] = declaredProject[dimension.key]
      sources[dimension.key] = 'project'
    } else {
      scores[dimension.key] = dimension.derive(evidence)
      sources[dimension.key] = 'derived'
    }
  }
  return { scores, sources, evidence, health: average(HEALTH_KEYS.map((key) => scores[key])) }
}

/** 项目健康性 = 各模块健康性的均值（没有模块就是 0）。 */
export function projectHealthOf(modules) {
  if (!Array.isArray(modules) || modules.length === 0) return 0
  return average(modules.map((module) => (module.health === undefined ? 0 : module.health)))
}

/** 五维在项目层面的均值（面板顶部的五个维度块用它）。 */
export function dimensionAverages(modules) {
  const out = {}
  for (const key of HEALTH_KEYS) {
    out[key] = average((Array.isArray(modules) ? modules : []).map((module) => (
      module.healthScores === undefined ? 0 : module.healthScores[key] ?? 0
    )))
  }
  return out
}

/* --------------------------------- 审查 --------------------------------- */

/**
 * 审查 = 客观事实（本文件算）+ 一针见血的评价（模型写）。
 *
 * 这里只做前半段：把「文档里能数出来的事实」摆齐，每条带一个可执行的下一步。
 * 评价不在这里生成——规则写不出人话，而「一针见血」恰恰要上下文：这个项目在
 * 干什么、哪条证据本该有却没有。所以 `op:'audit'` 返回事实 + `AUDIT_PROMPT`，
 * 由模型照着写点评（用户选定：审查正文只由模型自由点评）。
 */

/** 一个维度「本该有」的证据来自哪些计数。 */
const DIMENSION_EVIDENCE = {
  complexity: ['points', 'detail'],
  extensibility: ['pending', 'decided', 'projectPending', 'projectDecided'],
  maintenance: ['points', 'detail'],
  quality: ['pit', 'decided'],
  reusability: ['shared', 'points'],
}

/** 每一维「怎么提高」的具体动作（审查建议的落点，不是泛泛而谈）。 */
export const DIMENSION_FIX = {
  complexity: '把该模块的关键结论写进 ## 要点（一行一条事实），需要时补 ## 详细记录。',
  extensibility: '把还没定的写进「悬而未决」、定了的写进「已定」——两项都是 0 就没有扩展空间可言。',
  maintenance: '要点写清了才敢改：先补 ## 要点，再补模块之间的依赖关系。',
  quality: '把踩过的坑写进主文档 ## 坑，把结论写进 ## 已定。',
  reusability: '把可被别处复用的接口 / 共享模块单独写出来（模块文档的 ## 可复用）。',
}

/** 给模型照着写点评的指令。**不生成点评本身**——那是模型的事。 */
export const AUDIT_PROMPT = [
  '现在按五维写审查。要求：',
  '1. 先点名**最弱的一维**、它落在哪个模块，再逐条列问题；每条问题后面必须带数字或文档事实（例如「完成度 100，要点 0 条」）。',
  '2. 允许直说：写「这是在装样子」「这一维的分数是自己封的」都不过分，只要事实对得上。',
  '3. 每条问题配一条**可执行的下一步**（动哪个 op、写哪一节），不要「建议持续完善」这类空话。',
  '4. 最后一句整体判断：这个项目现在最该补的一件事是什么。',
].join('\n')

function dimensionName(key) {
  const found = HEALTH_DIMENSIONS.find((dimension) => dimension.key === key)
  return found === undefined ? key : found.name
}

/** 一个维度的证据总量（用它判断「手写分数有没有依据」）。 */
function evidenceOf(evidence, key) {
  const list = DIMENSION_EVIDENCE[key] ?? []
  return list.reduce((sum, name) => sum + (evidence?.[name] ?? 0), 0)
}

/** 主文档各节的证据条数（去掉空行与模板占位）。 */
export function sectionCounts(body) {
  const out = {}
  for (const key of SECTION_ORDER) out[key] = countItems(getSection(body, SECTION_HEADINGS[key]) ?? '')
  return out
}

/** 五维按分数升序排列——审查先说最弱的那一维。 */
export function dimensionRanking(dimensions) {
  const source = dimensions !== null && typeof dimensions === 'object' ? dimensions : {}
  return HEALTH_KEYS
    .map((key) => ({ key, name: dimensionName(key), value: source[key] ?? 0 }))
    .sort((left, right) => left.value - right.value)
}

function finding(id, level, dimension, scope, fact, fix) {
  return { id, level, dimension, scope, fact, fix }
}

/**
 * 把当前状态过一遍，输出**客观发现清单**。只陈述事实，不做评价。
 *
 * 不抛错：状态缺字段一律按 0 处理（未初始化的项目也会走到这里）。
 */
export function auditOf(state) {
  const safe = state !== null && typeof state === 'object' ? state : {}
  const modules = Array.isArray(safe.modules) ? safe.modules : []
  const sections = safe.sections !== null && typeof safe.sections === 'object' ? safe.sections : {}
  const dimensions = safe.dimensions !== null && typeof safe.dimensions === 'object' ? safe.dimensions : {}
  const findings = []

  if (modules.length === 0) {
    findings.push(finding('no_modules', 'blocker', null, 'project',
      '项目里一个模块都没有，五维无从算起，项目健康性是 0。',
      '用 op:init 带 modules 一次建齐，或用 op:module 建第一个模块。'))
  }

  // 主文档三节是所有模块共用的项目级证据。
  if ((sections.pit ?? 0) === 0) {
    findings.push(finding('pit_empty', 'warn', 'quality', 'project',
      '主文档「坑」0 条：踩过的坑没有沉淀下来，代码质量这一维只能靠「已定」撑。',
      DIMENSION_FIX.quality))
  }
  if ((sections.decided ?? 0) === 0) {
    findings.push(finding('decided_empty', 'warn', 'quality', 'project',
      '主文档「已定」0 条：这一轮到底定了什么，文档里查不到。',
      '把已确认的结论用 op:main section:decided 写进去（- [x] …）。'))
  }
  if ((sections.pending ?? 0) === 0) {
    findings.push(finding('pending_empty', 'warn', 'extensibility', 'project',
      '主文档「悬而未决」0 条：没有未决项，说明还没问到真正卡住决定的地方。',
      '把卡住决定的点写成 - [ ] …；确认项目确实收口了也可以，但要在文档里说清。'))
  }
  if ((sections.quote ?? 0) === 0) {
    findings.push(finding('quote_empty', 'info', null, 'project',
      '主文档「用户原话」0 条：拍板时的原话没留痕。',
      '把用户拍板的那句话原样写进 op:main section:quote。'))
  }

  // 「五维全靠公式推」的模块先收集起来：全都如此时只报一条，免得刷屏。
  const unreviewed = []
  for (const module of modules) {
    const name = String(module.name ?? '?')
    const counts = module.counts ?? {}
    const evidence = module.evidence ?? {}
    const progress = module.progress

    if (module.exists !== true) {
      findings.push(finding('module_missing:' + name, 'warn', null, name,
        '模块「' + name + '」只有图块、没有文档，五维全 0。',
        '用 op:module name:' + name + ' section:points 写下第一段事实。'))
      continue
    }

    const content = (counts.points ?? 0) + (evidence.detail ?? 0) + (counts.pending ?? 0) + (counts.decided ?? 0)
    if (content === 0) {
      findings.push(finding('module_empty:' + name, 'blocker', null, name,
        '模块「' + name + '」文档里 0 条要点、0 条详细记录、0 条决策：五维全 0。',
        '先补 ## 要点（2-3 条事实），再补 ## 详细记录；空文档没有健康性可谈。'))
    } else if ((counts.pending ?? 0) === 0 && (counts.decided ?? 0) === 0
      && (sections.pending ?? 0) === 0 && (sections.decided ?? 0) === 0) {
      findings.push(finding('no_open_questions:' + name, 'warn', 'extensibility', name,
        '模块「' + name + '」既没有悬而未决也没有已定，主文档也没有：可拓展性拿不到分。',
        DIMENSION_FIX.extensibility))
    }

    if (typeof progress === 'number' && progress >= 80 && (counts.points ?? 0) === 0) {
      findings.push(finding('progress_no_points:' + name, 'blocker', 'maintenance', name,
        '模块「' + name + '」完成度写 ' + progress + '，但要点 0 条。',
        '要么把要点补上（完成度才有依据），要么把完成度改成真实值。'))
    }

    for (const dimension of HEALTH_DIMENSIONS) {
      const source = (module.healthSources ?? {})[dimension.key]
      if (source !== 'module' && source !== 'project') continue
      if (evidenceOf(evidence, dimension.key) > 0) continue
      const score = (module.healthScores ?? {})[dimension.key] ?? 0
      findings.push(finding('declared_without_evidence:' + name + ':' + dimension.key, 'warn', dimension.key, name,
        '模块「' + name + '」的「' + dimension.name + '」手写了 ' + score + ' 分，但对应证据 0 条。',
        DIMENSION_FIX[dimension.key]))
    }

    const allDerived = HEALTH_KEYS.every((key) => (module.healthSources ?? {})[key] === 'derived')
    if (allDerived && module.health > 0) unreviewed.push(name)
  }

  if (unreviewed.length > 0) {
    const scope = unreviewed.length === modules.length && modules.length > 0 ? 'project' : unreviewed.join('、')
    findings.push(finding('never_reviewed', 'info', null, scope,
      unreviewed.length + ' 个模块的五维全是公式推出来的，没有一处人工判断：' + unreviewed.join('、') + '。',
      '对最弱的一维写显式分数并说明理由（## 健康性 里写「维度名: 分数」）。'))
  }

  const ranking = dimensionRanking(dimensions)
  if (modules.length > 0 && ranking[0].value < 100) {
    findings.push(finding('weakest_dimension', 'info', ranking[0].key, 'project',
      '最弱一维是「' + ranking[0].name + '」= ' + ranking[0].value + '%（跨模块均值）。',
      DIMENSION_FIX[ranking[0].key]))
  }

  return findings
}

/* --------------------------------- 模板 --------------------------------- */

export function mainTemplate(project, modules, goal, mode = DEFAULT_MODE) {
  const lines = [
    formatFrontMatter({ project, mode, modules, updated: timestamp() }),
    `# ${project} · 主文档`,
    '',
    '> 本文件只做检索、坑、原话与三类决策；细节一律在 `模块/` 下。',
    `> 项目健康性由模块文档的五维分数汇总得出，不在本文件手写总分。`,
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
    formatFrontMatter({ project: module, module, updated: timestamp() }),
    `# ${module}`,
    '',
    HEALTH_HEADING,
    healthTemplateLines(),
    '- （五维都是 0-100、**越高越好**；留空则由文档内容推导，想覆盖就填数字）',
    '',
    MODULE_SECTION_HEADINGS.progress,
    '完成度: 0',
    '',
    MODULE_SECTION_HEADINGS.points,
    '- （该模块的关键结论，只留事实）',
    '',
    MODULE_SECTION_HEADINGS.related,
    '- [ ] （待补）',
    '',
    MODULE_SECTION_HEADINGS.detail,
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

/**
 * 列出项目根下每个拼图项目的摘要（供 `op:'list'` 用）。
 *
 * 存在的意义：`op:'read'` 不给 `project` 时只能取「最新」那个，多项目工作区里
 * 模型看不出自己选错了。有了这个 op，模型可以先列出来再显式指定。
 */
export function projectSummaries(projectRoot) {
  return listProjects(projectRoot).map((entry) => {
    const state = readState(projectRoot, entry.name)
    return {
      name: entry.name,
      project: state.project,
      mode: state.mode,
      health: state.health,
      dimensions: state.dimensions,
      moduleCount: state.modules.length,
      builtModuleCount: state.modules.filter((module) => module.exists).length,
      updated: state.updated ?? null,
      updatedAt: new Date(entry.mtimeMs).toISOString(),
      degraded: state.degraded === true,
    }
  })
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

/* --------------------------------- 计数 --------------------------------- */

/**
 * 模板自带的说明性占位行——**只认这几种固定说法**。
 *
 * 早先的实现把「整行就是一对括号」一律当占位，于是用户写的
 * 「（见模块 auth-flow）」这类真内容会被误判为空、少算条数。
 */
const PLACEHOLDER_PATTERNS = [
  /^（?待补）?$/,
  /^[（(][^）)]*待补[^）)]*[）)]$/,
  /^[（(][^）)]*(尚未拆分模块)[^）)]*[）)]$/,
  /^[（(][^）)]*(一句话职责)[^）)]*[）)]$/,
  /^[（(][^）)]*(该模块的关键结论|只留事实)[^）)]*[）)]$/,
  /^[（(][^）)]*(细化记录|主文档只留一行索引)[^）)]*[）)]$/,
  /^[（(][^）)]*五维都是[^）)]*[）)]$/,
]

/** 剔掉空行与模板占位行。同时剥掉列表符与勾选框，好让 `- [ ] （待补）` 也认得出是占位。 */
function nonEmptyLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, '').replace(/^\[[ xX]\]\s*/, '').trim())
    .filter((line) => line !== '' && !PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(line)))
}

function countItems(text) {
  return nonEmptyLines(text).length
}

/* --------------------------------- 状态读取 --------------------------------- */

function moduleEntries(puzzleDir, modules, projectText) {
  return modules.map((name) => {
    const file = join(puzzleDir, MODULE_DIR, `${name}.md`)
    const text = isFile(file) ? readText(file) : null
    const health = text === null
      ? { scores: Object.fromEntries(HEALTH_KEYS.map((key) => [key, 0])), sources: {}, evidence: {}, health: 0 }
      : healthOf(text, projectText)
    const body = text === null ? '' : parseFrontMatter(text).body
    const related = text === null ? '' : getSection(body, MODULE_SECTION_HEADINGS.related) ?? ''
    const progress = text === null ? null : getSection(body, MODULE_SECTION_HEADINGS.progress)
    const progressMatch = progress === null ? null : /完成度\s*[:：]\s*(\d{1,3})/.exec(progress)
    return {
      name,
      file,
      exists: text !== null,
      health: health.health,
      healthScores: health.scores,
      healthSources: health.sources,
      evidence: health.evidence,
      progress: progressMatch === null ? null : clampPercent(Number(progressMatch[1])),
      counts: {
        points: health.evidence.points ?? 0,
        pending: related.split(/\r?\n/).filter((line) => /^\s*[-*]\s*\[ \]/.test(line)).length,
        decided: related.split(/\r?\n/).filter((line) => /^\s*[-*]\s*\[[xX]\]/.test(line)).length,
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
    modeSource: 'default',
    modules: [],
    dimensions: Object.fromEntries(HEALTH_KEYS.map((key) => [key, 0])),
    health: 0,
    sections: {},
    findings: [],
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

  const modules = moduleEntries(puzzleDir, planned, text)
  const declaredMode = MODES.includes(fields['模式']) ? fields['模式'] : null
  const dimensions = dimensionAverages(modules)

  const state = {
    ...base,
    initialized: true,
    degraded: base.degraded,
    project: typeof fields['项目'] === 'string' && fields['项目'].trim() !== '' ? fields['项目'].trim() : slug,
    mode: declaredMode ?? DEFAULT_MODE,
    modeSource: declaredMode === null ? 'default' : 'front-matter',
    updated: fields['更新时间'] ?? null,
    modules,
    dimensions,
    health: projectHealthOf(modules),
    sections: sectionCounts(body),
    planned,
    goal: (body.split(/\r?\n/).find((line) => line.startsWith('> 目标：')) ?? '').replace(/^>\s*目标：/, '').trim(),
  }
  // 审查发现要同时看模块证据与主文档小节，所以在状态装配完成后再算。
  state.findings = auditOf(state)
  return state
}

/**
 * 读某个模块文档的正文小节（供 UI 点开图块看详情，以及模型按需回读）。
 * 文件不存在时返回 exists:false，不抛错、不建文件。
 */
export function readModuleDetail(projectRoot, projectName, moduleName) {
  const slug = slugify(moduleName)
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (slug === null) return { ok: false, error: '模块名不合法' }
  if (puzzleDir === null) return { ok: false, error: '项目名不合法' }
  const file = safeJoin(puzzleDir, MODULE_DIR, `${slug}.md`)
  if (file === null) return { ok: false, error: '模块路径越界' }

  const mainDoc = join(puzzleDir, MAIN_FILE)
  const projectText = isFile(mainDoc) ? readText(mainDoc) : null
  if (!isFile(file)) {
    return {
      ok: true,
      name: slug,
      exists: false,
      file,
      health: 0,
      dimensions: Object.fromEntries(HEALTH_KEYS.map((key) => [key, 0])),
      points: null,
      related: null,
      detail: null,
    }
  }
  const text = readText(file)
  if (text === null) return { ok: false, error: '模块文档读不出来' }
  const { body } = parseFrontMatter(text)
  const health = healthOf(text, projectText)
  return {
    ok: true,
    name: slug,
    exists: true,
    file,
    health: health.health,
    dimensions: health.scores,
    sources: health.sources,
    points: (getSection(body, MODULE_SECTION_HEADINGS.points) ?? '').trim(),
    related: (getSection(body, MODULE_SECTION_HEADINGS.related) ?? '').trim(),
    detail: (getSection(body, MODULE_SECTION_HEADINGS.detail) ?? '').trim(),
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
    modules: patch.modules ?? safePlanned(fields),
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
    const mainCreated = !isFile(mainDoc)
    if (mainCreated) atomicWrite(mainDoc, mainTemplate(slug, names, goal, mode))
    const created = []
    for (const name of names) {
      const file = join(puzzleDir, MODULE_DIR, `${name}.md`)
      if (isFile(file)) continue
      atomicWrite(file, moduleTemplate(name))
      created.push(name)
    }
    return {
      ok: true,
      project: slug,
      puzzleDir,
      mainDoc,
      mainCreated,
      created,
      modules: names,
      existing: names.filter((name) => !created.includes(name)),
    }
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
    planned = [...new Set([...safePlanned(fields), ...names])]
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
    text = applySection(text, MODULE_SECTION_HEADINGS.progress, `完成度: ${percent}`, false)
  } else if (section === 'health') {
    // 只接受五个已知维度名；其余行（说明文字）原样保留在正文里。
    const merged = applySection(text, HEALTH_HEADING, content, append !== false)
    text = merged
  } else {
    text = applySection(text, MODULE_SECTION_HEADINGS[section], content, append !== false)
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
      const planned = safePlanned(fields)
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

/**
 * 写主文档的「健康性」汇总小节（项目级五维）。
 *
 * 这不是总分——总分由模块汇总而来，写在这里的只是给人看的维度快照。
 * 项目级显式分数会被 `healthOf` 当作模块缺省值使用。
 */
export function updateProjectHealth(projectRoot, projectName, content, append = true) {
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: '项目尚未创建', hint: '先执行 op=init' }
  const text = readText(mainDoc)
  if (text === null) return { ok: false, error: '主文档读不出来', hint: '检查文件权限' }
  try {
    atomicWrite(mainDoc, applySection(text, HEALTH_HEADING, content, append !== false))
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return { ok: true, mainDoc, section: 'health' }
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

/** 每次返回都带上的固定收尾问（三处口径一致：提示段 / 工具返回 / UI 模板）。 */
function pauseFields() {
  return { askPause: true, pauseQuestion: PAUSE_QUESTION, pauseOptions: PAUSE_OPTIONS }
}

/** 五维的元信息（名字 + 方向），让模型知道每一维是什么、往哪边算好。 */
export function dimensionMeta() {
  return HEALTH_DIMENSIONS.map((dimension) => ({ key: dimension.key, name: dimension.name, hint: dimension.hint }))
}

/** 工具返回给模型的最小事实集（不序列化任何宿主对象）。 */
export function summarize(state, extra = {}) {
  if (state.initialized !== true) {
    return {
      ok: true,
      initialized: false,
      projectRoot: state.projectRoot,
      error: state.error ?? null,
      hint: `尚无拼图项目：在项目根下用 op=init 一次创建主文档与模块文档（目录 ${'<项目名>/' + PUZZLE_DIR}/）`,
      dimensions: dimensionMeta(),
      findingCount: 0,
      ...pauseFields(),
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
    modeSource: state.modeSource ?? 'default',
    /** 项目健康性 = 各模块五维健康性的均值。 */
    health: state.health,
    dimensions: state.dimensions,
    dimensionMeta: dimensionMeta(),
    /**
     * 审查发现**不塞进这里**：`op:read` 是模型每轮都会调的，要精简。
     * 想看完整发现走 `op:audit`；面板则走 RPC 的 `state`（它自己附上）。
     * 这里只给一个数量，好让模型知道「有东西可审」。
     */
    findingCount: Array.isArray(state.findings) ? state.findings.length : 0,
    sections: state.sections ?? {},
    modules: state.modules.map((module) => ({
      name: module.name,
      exists: module.exists,
      health: module.health,
      dimensions: module.healthScores,
      sources: module.healthSources,
      progress: module.progress,
      counts: module.counts,
    })),
    updated: state.updated ?? null,
    canExecute: state.mode === MODE_PUZZLE_WRITE,
    ...pauseFields(),
    ...extra,
  }
}

/** `op:'list'` 的返回：所有项目 + 哪个是「不给 project 时的默认」。 */
export function summarizeList(projectRoot, projects) {
  return {
    ok: true,
    initialized: projects.length > 0,
    projectRoot,
    projectCount: projects.length,
    projects,
    defaultProject: projects.length > 0 ? projects[0].name : null,
    hint: projects.length > 0
      ? '多个项目并存时请在调用里显式给 project，否则默认用最新的那个。'
      : '项目根下还没有拼图项目，用 op=init 新建。',
    ...pauseFields(),
  }
}

export function isExecutableMode(mode) {
  return mode === MODE_PUZZLE_WRITE
}
