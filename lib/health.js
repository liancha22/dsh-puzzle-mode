/**
 * 五维健康性：显式声明优先，否则按文档证据推导。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */
import { join } from 'node:path'
import { HEALTH_HEADING, SECTION_ORDER, SECTION_HEADINGS, MODULE_SECTION_HEADINGS } from './constants.js'
import { clampPercent, average } from './util.js'
import { parseFrontMatter, getSection } from './frontmatter.js'
import { countItems } from './entries.js'


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
    // 可拓展性的证据只来自**模块文档**的悬而未决 / 已定：
    // v3 起主文档不再有决策小节（只剩四个索引 + 坑），项目级决策没有载体了。
    derive: (evidence) => clampPercent(
      ((evidence.pending ?? 0) + (evidence.decided ?? 0)) * 20,
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
export const HEALTH_ALIASES = new Map([
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
export const INVERSE_LABELS = new Set(['维护成本'])

/** 模块文档里的健康性小节（项目级五维汇总也写在这里）。 */


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
  // v3 起悬而未决 / 已定是模块文档里的**两个独立小节**，不再靠勾选框区分。
  // 旧格式（v2）的合并小节在迁移时会被拆开，所以这里只认新小节。
  const pendingText = getSection(body, MODULE_SECTION_HEADINGS.pending) ?? ''
  const decidedText = getSection(body, MODULE_SECTION_HEADINGS.decided) ?? ''
  const sharedText = getSection(body, MODULE_SECTION_HEADINGS.reuse) ?? ''
  // 主文档的「坑」是所有模块共用的项目级证据（主文档只留规范小节，坑是其中之一）。
  const projectPitText = getSection(projectBody, SECTION_HEADINGS.pit) ?? ''

  const evidence = {
    points: countItems(pointsText),
    detail: countItems(detailText),
    pending: countItems(pendingText),
    decided: countItems(decidedText),
    pit: countItems(projectPitText),
    shared: countItems(sharedText),
  }

  const declaredModule = parseHealthDeclarations(getSection(body, HEALTH_HEADING) ?? '')
  // 项目级显式分数已取消：v3 的主文档只剩四个索引 + 坑，没有 `## 健康性` 的容身处。
  // 五维一律来自模块文档（显式或推导），项目健康性 = 各模块均值。
  const scores = {}
  const sources = {}
  for (const dimension of HEALTH_DIMENSIONS) {
    if (Object.hasOwn(declaredModule, dimension.key)) {
      scores[dimension.key] = declaredModule[dimension.key]
      sources[dimension.key] = 'module'
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

/** 一个维度「本该有」的证据来自哪些计数。 */
export const DIMENSION_EVIDENCE = {
  complexity: ['points', 'detail'],
  extensibility: ['pending', 'decided'],
  maintenance: ['points', 'detail'],
  quality: ['pit', 'decided'],
  reusability: ['shared', 'points'],
}

export function dimensionName(key) {
  const found = HEALTH_DIMENSIONS.find((dimension) => dimension.key === key)
  return found === undefined ? key : found.name
}

/**
 * 五维按分数**升序**排列——最弱的一维排最前。
 *
 * ⚠️ v2.1.1 从 `audit.js` 搬来这里：审查功能整体删除后，这个纯排序函数
 * 与审查没关系了（它只看五维数字），而 `health.js` 才是五维的家。
 * 原本它在 `audit.js` 里只是为了给审查「先说最弱那维」用。
 */
export function dimensionRanking(dimensions) {
  const source = dimensions !== null && typeof dimensions === 'object' ? dimensions : {}
  return HEALTH_KEYS
    .map((key) => ({ key, name: dimensionName(key), value: source[key] ?? 0 }))
    .sort((left, right) => left.value - right.value)
}

/**
 * 主文档各节的证据条数（去掉空行与模板占位）。
 *
 * ⚠️ 同样从 `audit.js` 搬来（v2.1.1）：`readState` 每轮都要它，
 * 与审查无关——审查删了它也得留着。
 */
export function sectionCounts(body) {
  const out = {}
  for (const key of SECTION_ORDER) out[key] = countItems(getSection(body, SECTION_HEADINGS[key]) ?? '')
  return out
}
