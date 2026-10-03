/**
 * 项目级读写：建/绑/解绑、写小节、写健康性、汇总状态。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PUZZLE_DIR, MAIN_FILE, MODULE_DIR, MODES, DEFAULT_MODE, PUZZLE_VERSION, MODE_PUZZLE_WRITE, MODE_RENAME_VERSION, normalizeMode, HEALTH_HEADING, SECTION_ORDER, SECTION_HEADINGS, SECTION_KEYS, MODULE_SECTION_KEYS, MODULE_SECTION_HEADINGS, MODULE_SECTION_ORDER, ENTRY_LIMITS, ENTRY_CAPS, WORKFLOW_ARCHIVE_CAP, WORKFLOW_NAME_LIMIT, WORKFLOW_STEP_LIMIT, WORKFLOW_MAX_STEPS, SIZE_FIELD, DEFAULT_SIZE, normalizeSize, capsOfSize, limitsOfSize, SIZES } from './constants.js'
import { listFiles, isFile, isDir, isSkippableDirName, clampPercent, slugify, timestamp } from './util.js'
import { safeJoin, puzzleDirOf, atomicWrite, readTextCached, currentDocEpoch } from './docfs.js'
import { formatFrontMatter, parseFrontMatter, normalizeSessions, parseSessionList, parseCurrentSessionList, parseSourceRoot, parseWorkflowArchive, getSection, withSection, applySection, docVersion, safePlanned, extraSectionsIn } from './frontmatter.js'
import { entryLines, entryBody, normalizeEntries, conflictDigest, charCount, entryIssuesIn, citedSourceFiles, MAIN_ENTRY_SPEC, MODULE_ENTRY_SPEC, mainEntrySpecOf, moduleEntrySpecOf } from './entries.js'
import { HEALTH_KEYS, healthOf, projectHealthOf, dimensionAverages } from './health.js'
import { sectionCounts, auditOf, fixPlanOf } from './audit.js'
import { collectSourceFiles } from './source.js'
import { mainTemplate, moduleTemplate } from './templates.js'


/**
 * 读一个项目的**规模档位**（主文档 front-matter 的 `规模:`）。
 *
 * 认不出 / 没写 → `中`。存量文档一个都不用改：`中` 档就是升级前的所有上限。
 * 读不出来（文档不在 / 权限）也回 `中`——规模只影响「能写多少条」，
 * 不该因为它让一次写入失败。
 */
export function sizeOfProject(projectRoot, projectName) {
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (puzzleDir === null) return DEFAULT_SIZE
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return DEFAULT_SIZE
  const text = readTextCached(mainDoc)
  if (text === null) return DEFAULT_SIZE
  const { fields } = parseFrontMatter(text)
  return normalizeSize(fields[SIZE_FIELD]) ?? DEFAULT_SIZE
}

/** 扫出项目根下所有已有拼图项目（按修改时间倒序）。 */
export function listProjects(projectRoot) {  const found = []
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
 * 扫出工作区里**还没有拼图文档**的顶层目录（供面板「一次建多个项目文档」用）。
 *
 * 用户需求（v0.21.0）：「造着项目建文档加一个自动判断此会话是否有多个项目，
 * 若有多个项目则自动新建多个项目文档并绑定多个。」
 *
 * 为什么由**宿主**扫而不是让模型自己读工作区：目录清单是个客观事实，
 * 让模型去 `ls` 再自己数，不同轮次会给出不同答案；而且它看不到真实文件树时
 * 只能编。宿主扫一次、把结果连名字带证据交给面板与模型，判定才是确定的。
 *
 * 判定「是不是一个项目」刻意**宽松**：顶层目录 + 不是噪音目录（见 `isSkippableDirName`）
 * + 自己还没有 `拼图/主文档.md`。不做「必须有 package.json」这种判断——
 * 纯数据目录、脚本集合、笔记库也都是用户眼里的「项目」，漏掉比多列糟得多。
 * 用户还会在面板上勾选（他选的才算），所以这里宁多勿少。
 *
 * 每条带上 `entries`（顶层前几个名字）当**证据**：让用户一眼看出这是哪个目录，
 * 而不是只看一个可能重名的项目名。
 */
export function scanUnpuzzled(projectRoot, limit = 200) {
  const existing = new Set(listProjects(projectRoot).map((item) => item.name))
  const out = []
  for (const entry of listFiles(projectRoot)) {
    if (isSkippableDirName(entry)) continue
    if (existing.has(entry)) continue
    const dir = join(projectRoot, entry)
    if (!isDir(dir)) continue
    let entries = []
    try {
      entries = listFiles(dir)
        .filter((name) => !name.startsWith('.'))
        .slice(0, 5)
    } catch (_error) {
      entries = []
    }
    out.push({
      name: entry,
      // `slugify` 后的名字才是能落盘的目录名；与已有项目重名时面板会拦下来。
      slug: slugify(entry),
      entries,
    })
    if (out.length >= limit) break
  }
  return out
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


/* --------------------------------- 工作流 --------------------------------- */

/**
 * 工作流的**模板占位行**——只有这一种，而且是精确前缀匹配。
 *
 * 为什么不用 `entries.js` 的 `PLACEHOLDER_PATTERNS`：那套正则是为**模块文档**设计的
 * （「待补」「轮汇报」「可被别处复用」…），拿它过滤工作流会把**以括号开头的合法步骤**
 * 静默吞掉——例如「（最多 3 条规则同时生效）」这种真步骤会读成 0 条，且一声不吭。
 * 工作流的占位行只有模板/迁移写下的这一句，所以只认它，多一个都不认。
 */
const WORKFLOW_PLACEHOLDER = '（在这里写你的流水线'

/** v5 及更早的占位行。读旧文档时要一并认出来，否则会凭空多一条工作流。 */
const WORKFLOW_PLACEHOLDER_LEGACY = '（约束模型在特定操作下别做别的事'

/** 步骤行前缀：`1. ` / `1、` / `1) ` / `- ` / `* ` 都算，读的时候统一剥掉。 */
const STEP_PREFIX = /^\s*(?:\d+\s*[.、)]|[-*])\s*/

/**
 * 触发行的前缀：`触发: xxx` / `触发：xxx`（块内**第一行**才认）。
 *
 * 为什么要有它（v0.19.9，用户问「怎么增强约束」后定的方案）：
 * 实测教训——`PUBLISH.md` 里早就写着「description 别堆版本历史」，
 * 但我第一次改 `package.json` 时**撞不见它**，于是照样违反。
 * 根因是：`## 工作流` 是**纯文本**，注入给模型读，却**不绑定任何动作**——
 * 规则躺在那儿，等你做到那一步时它不会自己冒出来。
 *
 * 所以给工作流块一个可选的触发声明：写了 `触发:` 的块，会在**匹配到该动作时**
 * 单独注入（见 `index.js` 的 `tools/post-execute`）。没写的块照旧只在提示段常驻。
 */
const TRIGGER_PREFIX = /^触发\s*[:：]\s*/

/**
 * 把一段 markdown 解析成**工作流块**数组：`### 名字` 开头，块内逐行是步骤。
 *
 * 这是 v6 的核心形状（用户原话：工作流就是工作流程——为完成特定任务，把重复步骤、
 * 工具、规则按顺序串成的标准化流水线）。一条工作流 = 一个块，块内步骤**有序**。
 *
 * 两个刻意的设计：
 *   1. **`###` 之下、下一个 `###` 之前的非空行都是步骤**，不强制 `- ` 前缀——
 *      模型顺手写 `1. …` 也认，写 `- …` 也认，写纯文本也认（前缀由 `STEP_PREFIX` 剥）；
 *   2. 没有 `###` 的散行**不算工作流**（该行被忽略）。因为一条没有名字的流水线
 *      在面板上列不出、在归档里标识不了；宁可读成 0 条，也不造无名块。
 *
 * v0.19.9 起，块内**第一行**若是 `触发: <关键词>`，它算**触发声明**而不是步骤
 * （见 `TRIGGER_PREFIX` 的说明）；其余位置出现的 `触发:` 仍当普通步骤，不当声明。
 */
export function parseWorkflowBlocks(content) {
  const blocks = []
  let current = null
  for (const raw of String(content ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    const heading = /^###\s+(.*)$/.exec(line)
    if (heading !== null) {
      const name = heading[1].trim()
      if (name !== '') {
        current = { name, steps: [], trigger: '' }
        blocks.push(current)
      }
      continue
    }
    if (current === null) continue
    const bare = line.replace(STEP_PREFIX, '').trim()
    if (bare === '') continue
    if (bare.startsWith(WORKFLOW_PLACEHOLDER) || bare.startsWith(WORKFLOW_PLACEHOLDER_LEGACY)) continue
    // 触发声明只在**块内还没出现任何步骤**时认（也就是紧跟 `### 名字` 的那一行）。
    // 这样步骤正文里出现的「触发: xxx」不会被误吃成声明。
    if (current.steps.length === 0 && current.trigger === '' && TRIGGER_PREFIX.test(bare)) {
      current.trigger = bare.replace(TRIGGER_PREFIX, '').trim()
      continue
    }
    current.steps.push(bare)
  }
  return blocks
}

/**
 * 挑出「本次工具调用触发了哪些工作流」——供 `tools/post-execute` 注入。
 *
 * 匹配规则**刻意简单**：`触发:` 后面写的是关键词，命中「工具名」或「参数里的路径/命令」
 * 就算触发（大小写不敏感）。不搞正则表达式那种复杂语法——规则是给模型写、给人看的，
 * 复杂了没人写、也读不懂。
 *
 * @param {Array} blocks `parseWorkflowBlocks` 的结果
 * @param {string} toolName 工具名（如 `write`）
 * @param {object} args 工具参数
 * @returns {Array} 命中的工作流块
 */
export function workflowsTriggeredBy(blocks, toolName, args) {
  const list = Array.isArray(blocks) ? blocks : []
  const tool = typeof toolName === 'string' ? toolName.toLowerCase() : ''
  if (tool === '') return []
  // 把参数拍平成一个可搜索的字符串（只看值，不看键名）。
  const input = args !== null && typeof args === 'object' ? args : {}
  const haystack = Object.values(input)
    .filter((value) => typeof value === 'string')
    .join('\n')
    .toLowerCase()
  const out = []
  for (const block of list) {
    const trigger = typeof block.trigger === 'string' ? block.trigger.trim().toLowerCase() : ''
    if (trigger === '') continue
    // 关键词可以是逗号/顿号分隔的多个，命中任一即可。
    const keys = trigger.split(/[,，、]/).map((item) => item.trim()).filter((item) => item !== '')
    if (keys.length === 0) continue
    const hit = keys.some((key) => tool.includes(key) || haystack.includes(key))
    if (hit) out.push(block)
  }
  return out
}

/**
 * 读主文档 `## 工作流` 小节里的**工作流块**（`[{ name, steps }]`）。
 *
 * 为什么要有「工作流」这一节：它是主文档里唯一一节**写给模型看的行为流程**，
 * 随提示段一起注入，模型每一步都读得到。其余四节是「查回来的事实」，用途完全不同。
 *
 * 占位行先整行剔掉再解析：占位行没有 `###`，本来就被挡在块外；显式过滤防的是
 * 「占位行被手改进某个块的步骤里」这种形状——那会让它变成一条莫名其妙的步骤。
 */
export function readWorkflow(body) {
  const section = String(getSection(body, SECTION_HEADINGS.workflow) ?? '')
  const kept = section.split(/\r?\n/).filter((line) => {
    const t = line.trim()
    return !(t.startsWith(WORKFLOW_PLACEHOLDER) || t.startsWith(WORKFLOW_PLACEHOLDER_LEGACY))
  })
  return parseWorkflowBlocks(kept.join('\n'))
}

/**
 * 把一条工作流块渲染成 markdown（`### 名字` + 可选的 `触发:` 行 + 有序步骤）。
 *
 * `触发:` 行必须**写回**（v0.19.9）：它是块的触发声明，不是步骤。
 * 丢了它，`parseWorkflowBlocks` 下次就读不出来——机制看着实现了，实际是死的
 * （实测踩过：写回后触发声明变成第 1 步，钩子永远不触发）。
 */
function renderWorkflowBlock(block) {
  const steps = Array.isArray(block.steps) ? block.steps : []
  const trigger = typeof block.trigger === 'string' && block.trigger.trim() !== '' ? block.trigger.trim() : ''
  const head = [`### ${block.name}`]
  if (trigger !== '') head.push(`触发: ${trigger}`)
  return [...head, ...steps.map((step, i) => `${i + 1}. ${step}`)].join('\n')
}

/**
 * 把工作流块数组写回 `## 工作流` 小节；空数组写成一行说明占位。
 *
 * 步骤**统一重排成 `1. 2. 3.`**：顺序就是流水线的语义（「把重复步骤按顺序串」），
 * 所以编号由文档形状保证，不靠模型自觉写对序号。
 *
 * 写空时**不留空标题**：留一个光秃秃的 `## 工作流` 看着像坏了，
 * 而占位行能被 `WORKFLOW_PLACEHOLDER` 识别，不会被当成一条工作流。
 */
export function writeWorkflow(text, items) {
  const list = Array.isArray(items)
    ? items.filter((item) => item !== null && typeof item === 'object' && typeof item.name === 'string' && item.name.trim() !== '')
    : []
  const content = list.length === 0
    ? '- ' + WORKFLOW_PLACEHOLDER + '；最多 ' + ENTRY_CAPS.workflow + ' 条，每条是独立的一条路，'
      + '每条 ≤' + WORKFLOW_MAX_STEPS + ' 步。要改一条就改那一块，不要新加一条）'
    : list.map(renderWorkflowBlock).join('\n\n')
  return withSection(text, SECTION_HEADINGS.workflow, content)
}

/**
 * 工作流的写入侧规整：解析成块 + 逐条校验（名字限长、步数上限、每步限长）。
 *
 * 为什么不能复用 `normalizeEntries`（模块文档那套）：它按**行**当条目，会把
 * `### 名字` 和它下面的步骤当成互不相干的两条，把一条流水线拆碎。工作流是**块**结构。
 *
 * **步数超限报错，不删最旧**——与 `## 悬而未决` / `## 已定` 相反：步骤是一条有序的
 * 流水线，中间少一步整条路就断了，静默删步比拒绝写入危险得多（见 `WORKFLOW_MAX_STEPS`）。
 */
export function normalizeWorkflowEntries(content) {
  const blocks = parseWorkflowBlocks(content)
  for (const block of blocks) {
    const nameCount = charCount(block.name)
    if (nameCount > WORKFLOW_NAME_LIMIT) {
      return {
        ok: false,
        error: `工作流名字 ${nameCount} 字，超过上限 ${WORKFLOW_NAME_LIMIT} 字`,
        hint: `把「${block.name}」精简到 ${WORKFLOW_NAME_LIMIT} 字以内：名字是这条路的标识，面板图块与归档都靠它。`,
      }
    }
    if (block.steps.length === 0) {
      return {
        ok: false,
        error: `工作流「${block.name}」一步都没有`,
        hint: '块内至少写一步：每条工作流是一条流水线，没有步骤就不成流程。',
      }
    }
    if (block.steps.length > WORKFLOW_MAX_STEPS) {
      return {
        ok: false,
        error: `工作流「${block.name}」有 ${block.steps.length} 步，超过上限 ${WORKFLOW_MAX_STEPS} 步`,
        hint: `**不要删步骤**（中间少一步整条路就断了）——把重复的合并，或拆成两条独立的工作流。`,
      }
    }
    for (const step of block.steps) {
      const count = charCount(step)
      if (count > WORKFLOW_STEP_LIMIT) {
        return {
          ok: false,
          error: `步骤 ${count} 字，超过上限 ${WORKFLOW_STEP_LIMIT} 字`,
          hint: `精简到 ${WORKFLOW_STEP_LIMIT} 字以内，一步写清「谁 + 用什么工具 + 做什么 + 产出什么」：${step}`,
        }
      }
    }
  }
  const text = blocks.length === 0 ? '' : blocks.map(renderWorkflowBlock).join('\n\n')
  return { ok: true, text, incoming: blocks.length, blocks }
}

/**
 * 只改主文档的**工作流**（正文小节 + front-matter 归档），其余内容一字不动。
 *
 * `nextItems` / `nextArchive` 都由调用方算好，这里只负责落盘与透传：
 * front-matter 必须整份重写（`formatFrontMatter` 的契约），所以项目 / 模式 / 模块清单 /
 * 会话绑定 / 源码根 / 归档**六个字段一个都不能漏**——漏一个就是静默丢数据。
 */
export function writeWorkflowDoc(mainDoc, text, nextItems, nextArchive) {
  const { fields, body } = parseFrontMatter(text)
  const next = [
    formatFrontMatter({
      puzzle: PUZZLE_VERSION,
      project: fields['项目'] ?? '',
      // 用**带版本**的归一：v4 文档里的 `边拼边写` 是旧含义，透传成新名字（写后再拼）。
      // 不带版本直接 includes 判定，旧值会被当成「不是合法模式」而退回默认（只拼不写），
      // 等于用户改一次工作流就被静默降级成只拼不写。
      mode: modeOfFields(fields, docVersion(text)),
      modules: safePlanned(fields),
      sessions: parseSessionList(fields),
      // 当前会话必须一起透传：只透传绑定而不透传当前，一次改工作流 / 改小节
      // 就会把「我切到哪个项目了」清掉，下一次工具调用漂回扫描顺序里的第一个。
      currentSessions: parseCurrentSessionList(fields),
      sourceRoot: parseSourceRoot(fields),
      // ⚠️ **规模档位必须透传**（v0.23.3 修的真丢数据 bug）：漏了它，写一次工作流就把
      // `规模: 大` 抹掉 → 下次读按中档 → 上限更严 → **超出的条目在下一次写入被静默删除**。
      // 实测代价：主文档「坑」149 条被砍到 60 条，丢了 93 条。
      size: fields[SIZE_FIELD],
      workflowArchive: normalizeArchiveCapped(nextArchive),
      updated: timestamp(),
    }),
    writeWorkflow(body, nextItems).replace(/^\n+/, ''),
  ].join('\n')
  atomicWrite(mainDoc, next)
  return { ok: true, mainDoc, workflow: nextItems, workflowArchive: normalizeArchiveCapped(nextArchive) }
}

/**
 * front-matter 里的模式 → 当前三种之一。
 *
 * **版本必给**（默认当前版）：v4 及更早的 `边拼边写` 表示「一轮做完才问」，
 * 归一成 `写后再拼`。见 `constants.normalizeMode` 与 `MODE_RENAME_VERSION`。
 */
export function modeOfFields(fields, version = PUZZLE_VERSION) {
  const raw = fields !== null && fields !== undefined ? fields['模式'] : undefined
  return normalizeMode(raw, version) ?? DEFAULT_MODE
}

/**
 * 「整份重写 front-matter」时，**模式与版本这两个字段**该怎么写。
 *
 * 凡是要重写 front-matter 的写入路径（写小节 / 写会话 / 改模块清单 / 写工作流）都得走这里，
 * 否则 `模式: 边拼边写` 的旧文档会在某一次无关的写入里被静默改成 `只拼不写`
 * ——因为旧名字不在 `MODES` 里，随手写的 `MODES.includes(x) ? x : DEFAULT_MODE`
 * 就会把它替换掉。归一后名字变了，版本必须跟着到当前版，否则下次读又按旧含义解释。
 */
export function passThroughFields(fields, text) {
  const docVer = docVersion(text)
  const raw = typeof fields['模式'] === 'string' ? fields['模式'].trim() : ''
  const renamed = raw === MODE_PUZZLE_WRITE && docVer < MODE_RENAME_VERSION
  return {
    puzzle: renamed ? PUZZLE_VERSION : (fields.puzzle ?? 1),
    mode: modeOfFields(fields, docVer),
  }
}

/**
 * 归档裁剪：**按名字**去重保序 + 只保留最近 `WORKFLOW_ARCHIVE_CAP` 条（超了删最旧）。
 *
 * 为什么按名字去重而不是按整块：名字是这条工作流的**标识**（面板图块、恢复时的身份校验
 * 都用它）。同名的两条归档在界面上无法区分，用户点「恢复」时也不知道回的是哪一条；
 * 保留**最近删掉的那一版**（同名覆盖）比留两份同名更符合「账本」的直觉。
 *
 * 同时把 v5 及更早的**字符串**归档项升级成 `{name, steps:[]}`：旧归档里存的是
 * 一句约束（不是流水线），形状对不上块模型，但**不能丢**——那是用户删过的记录。
 */
export function normalizeArchiveCapped(list) {
  const out = []
  const index = new Map()
  for (const raw of Array.isArray(list) ? list : []) {
    const item = typeof raw === 'string'
      // 旧版（v5 及更早）的归档项是纯字符串：当「只有名字、没有步骤」的块收下。
      ? { name: raw.trim(), steps: [] }
      : (raw !== null && typeof raw === 'object' && typeof raw.name === 'string'
        ? { name: raw.name.trim(), steps: Array.isArray(raw.steps) ? raw.steps.filter((s) => typeof s === 'string' && s.trim() !== '') : [] }
        : null)
    if (item === null || item.name === '') continue
    if (index.has(item.name)) {
      // 同名：用新的那一份覆盖旧的（保序——留在原位置，不挪到末尾）。
      out[index.get(item.name)] = item
      continue
    }
    index.set(item.name, out.length)
    out.push(item)
  }
  return out.length > WORKFLOW_ARCHIVE_CAP ? out.slice(out.length - WORKFLOW_ARCHIVE_CAP) : out
}

/**
 * 删掉 `## 工作流` 的第 `index` 条（**1 起**），**整条工作流**进归档。
 *
 * 为什么要「进归档」而不是直接删（用户原话：工作流可在面版一键删除（可回滚））：
 * 面板一键删除是唯一会改主文档的 UI 动作，误点的代价必须是可撤销的。
 * 归档与正文分离存放，所以归档**不占用 5 条上限**，删了 10 条也不会把工作流挤空。
 *
 * 序号越界一律**报错而不猜**：面板传的是它渲染出来的序号，错位说明界面已过期，
 * 这时候「尽力而为地删一条」比拒绝更危险——用户会以为删的是他点的那条。
 *
 * `expected` 是**身份校验**（可选但强烈建议调用方给）：面板把它渲染出来的那个**名字**传进来，
 * 与当前第 `at` 条不一致就拒绝。为什么需要它：`index` 是**位置**语义，不是身份语义——
 * 同一次渲染里连点两次「删除」（或一次重试）在旧实现下会**多删一条**
 * （第一次删掉第 2 条后，原来的第 3 条补位成了第 2 条）。带上名字就把位置语义升级成身份语义。
 */
export function removeWorkflowItem(projectRoot, projectName, index, expected) {
  const at = Number(index)
  if (!Number.isInteger(at) || at < 1) {
    return { ok: false, error: '序号必须是 1 起的整数', hint: '面板按渲染出来的编号传 index' }
  }
  const located = workflowTarget(projectRoot, projectName)
  if (located.ok !== true) return located
  const { mainDoc, text } = located
  const { fields, body } = parseFrontMatter(text)
  const items = readWorkflow(body)
  if (at > items.length) {
    return { ok: false, error: `工作流只有 ${items.length} 条，删不了第 ${at} 条`, hint: '面板可能已过期，重新打开面板再试' }
  }
  const changed = items[at - 1]
  if (typeof expected === 'string' && expected.trim() !== '' && expected.trim() !== changed.name) {
    return {
      ok: false,
      error: `第 ${at} 条已经不是你点的那条了（现在是「${changed.name}」）`,
      hint: '面板显示的列表已过期：重新打开面板再删，避免误删。',
    }
  }
  const nextItems = items.filter((_item, i) => i !== at - 1)
  const nextArchive = [...parseWorkflowArchive(fields), changed]
  try {
    writeWorkflowDoc(mainDoc, text, nextItems, nextArchive)
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return { ok: true, mainDoc, changed: changed.name, workflow: nextItems, workflowArchive: normalizeArchiveCapped(nextArchive) }
}

/**
 * 把归档里第 `index` 条（**1 起**）**整条**恢复回 `## 工作流`。
 *
 * 恢复时若工作流已满 5 条，会挤掉最旧的一条。**被挤掉的那条要重新进归档**——
 * 这是本函数唯一容易写错的地方（v0.14.0 初版就在这里丢过数据）：
 * 被挤掉的是**工作流里的活条目**，它从来不在归档里，所以「它本来就在归档里」是错的，
 * 直接丢弃 = 用户点一下「恢复」就永久少一条工作流，而且界面上什么都不会说。
 * 现在的做法：挤掉谁就把谁追加回归档（归档本身有 ≤10 条上限，满了会顶掉最旧的归档项，
 * 这是有界账本应有的行为），并在返回值里如实报 `evicted` 让面板显示出来。
 */
export function restoreWorkflowItem(projectRoot, projectName, index) {
  const at = Number(index)
  if (!Number.isInteger(at) || at < 1) {
    return { ok: false, error: '序号必须是 1 起的整数', hint: '面板按渲染出来的编号传 index' }
  }
  const located = workflowTarget(projectRoot, projectName)
  if (located.ok !== true) return located
  const { mainDoc, text } = located
  const { fields, body } = parseFrontMatter(text)
  const archive = parseWorkflowArchive(fields)
  if (at > archive.length) {
    return { ok: false, error: `归档只有 ${archive.length} 条，恢复不了第 ${at} 条`, hint: '面板可能已过期，重新打开面板再试' }
  }
  const restored = archive[at - 1]
  const items = readWorkflow(body)
  if (items.some((item) => item.name === restored.name)) {
    return { ok: false, error: '这条已经在工作流里了', hint: '同一条不重复恢复' }
  }
  const merged = [...items, restored]
  const evicted = merged.length > ENTRY_CAPS.workflow ? merged.slice(0, merged.length - ENTRY_CAPS.workflow) : []
  const nextItems = evicted.length > 0 ? merged.slice(merged.length - ENTRY_CAPS.workflow) : merged
  // 先摘掉被恢复的那条，再把被挤掉的追加回去：被挤掉的工作流回到「可恢复」状态。
  const nextArchive = [...archive.filter((_item, i) => i !== at - 1), ...evicted]
  try {
    writeWorkflowDoc(mainDoc, text, nextItems, nextArchive)
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return {
    ok: true,
    mainDoc,
    changed: restored.name,
    evicted: evicted.map((item) => item.name),
    // 归档里现在有它 → 面板可以告诉用户「被挤掉的那条已回到归档，还能恢复」。
    evictedRecoverable: evicted.length > 0,
    workflow: nextItems,
    workflowArchive: normalizeArchiveCapped(nextArchive),
  }
}

/**
 * 把归档里第 `index` 条（**1 起**）**永久删除**。
 *
 * 与「恢复」并列的第二个出口。为什么需要它：归档是**有界账本**（≤10 条），
 * 若只能恢复不能删，用户想彻底丢掉一条旧流水线时，唯一办法是把它恢复出来、
 * 挤掉一条好的、再删掉——绕一大圈还会误伤。用户原话：归档可恢复可删除。
 *
 * 归档**不可展开看细节**（用户裁定）：它是「删过什么」的账，不是当前的流程，
 * 所以面板只显示名字与步数，不提供展开。
 */
export function dropWorkflowArchiveItem(projectRoot, projectName, index) {
  const at = Number(index)
  if (!Number.isInteger(at) || at < 1) {
    return { ok: false, error: '序号必须是 1 起的整数', hint: '面板按渲染出来的编号传 index' }
  }
  const located = workflowTarget(projectRoot, projectName)
  if (located.ok !== true) return located
  const { mainDoc, text } = located
  const { fields, body } = parseFrontMatter(text)
  const archive = parseWorkflowArchive(fields)
  if (at > archive.length) {
    return { ok: false, error: `归档只有 ${archive.length} 条，删不了第 ${at} 条`, hint: '面板可能已过期，重新打开面板再试' }
  }
  const changed = archive[at - 1]
  const nextArchive = archive.filter((_item, i) => i !== at - 1)
  try {
    writeWorkflowDoc(mainDoc, text, readWorkflow(body), nextArchive)
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return { ok: true, mainDoc, changed: changed.name, workflow: readWorkflow(body), workflowArchive: normalizeArchiveCapped(nextArchive) }
}

/** 定位主文档并读出来；项目不存在或读不出来时返回 `{ ok:false }`（不抛错）。 */
function workflowTarget(projectRoot, projectName) {
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: '项目尚未创建', hint: '先执行 op=init' }
  const text = readTextCached(mainDoc)
  if (text === null) return { ok: false, error: '主文档读不出来', hint: '检查文件权限' }
  return { ok: true, mainDoc, text }
}

/**
 * 读主文档全文（供面板的「主文档」只读查看）。
 *
 * 面板查看是**只读**的（用户裁定）：主文档的形状由 `puzzle_mode` 统一维护，
 * 面板给一个能编辑的框就等于开了第二条写入通道，条目限长 / 条数上限 / slug 过滤
 * 全部会被绕过——那正是「文档锁」要防的事。所以这里只回原文，不回任何编辑入口。
 */
export function readMainDoc(projectRoot, projectName) {
  const located = workflowTarget(projectRoot, projectName)
  if (located.ok !== true) return located
  const { mainDoc, text } = located
  const { fields, body } = parseFrontMatter(text)
  return {
    ok: true,
    mainDoc,
    text,
    workflow: readWorkflow(body),
    workflowArchive: parseWorkflowArchive(fields),
    version: docVersion(text),
    outdated: docVersion(text) < PUZZLE_VERSION,
  }
}

/* --------------------------------- 状态读取 --------------------------------- */

export function moduleEntries(puzzleDir, modules, projectText, size = DEFAULT_SIZE) {
  // 条目规格**按档位取**（不是固定的中档字长）：大档的要点 / 已定放宽到 40 字，
  // 拿中档的 20 字去量会把每条合法条目都报成「超长」——写入放行、审查报警的「两把尺子」。
  const moduleSpec = moduleEntrySpecOf(size)
  return modules.map((name) => {
    const file = join(puzzleDir, MODULE_DIR, `${name}.md`)
    const text = isFile(file) ? readTextCached(file) : null
    const health = text === null
      ? { scores: Object.fromEntries(HEALTH_KEYS.map((key) => [key, 0])), sources: {}, evidence: {}, health: 0 }
      : healthOf(text, projectText)
    const body = text === null ? '' : parseFrontMatter(text).body
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
      // 该模块文档**自己引用到的源码文件**（从 `（源码: lib/x.js:12）` 里抽）。
      // 审查做模块级源码判决时据此过滤：只拿这个模块真的指到的文件去扣分，
      // 否则每个模块都会继承同一份项目级硬伤，8 个模块的分会被拉平成一模一样。
      citedFiles: text === null ? [] : citedSourceFiles(body),
      // 不合规条目（超长 / 无出处）：审查据此点名，而不是只看条数。
      entryIssues: text === null ? [] : entryIssuesIn(body, moduleSpec),
      // 计数直接来自 health 的证据：悬而未决 / 已定是独立小节，不再按勾选框过滤。
      counts: {
        points: health.evidence.points ?? 0,
        pending: health.evidence.pending ?? 0,
        decided: health.evidence.decided ?? 0,
      },
    }
  })
}

/**
 * 只读「项目是否存在 + 它是什么模式」——**热路径专用**，别拿它当 `readState` 用。
 *
 * 为什么必须单独有一个（实测数字，2026-10-02）：`tools/pre-execute` 挂在**每一次工具调用**上，
 * 而它只为回答一个问题——「本会话绑定的项目是不是『只拼不写』」。原先它调 `readState`，
 * 那会把主文档 + **全部模块文档**读一遍并算健康性 / 条目合规 / 工作流 / 引用源码，
 * 单次阻塞实测 **86–127ms**（工作区 9 项目 / 10 模块）。这个函数只读**一份主文档的
 * front-matter**，配合 `readTextCached` 后热路径降到 ~25ms。
 *
 * 语义与 `readState` 在这两个字段上**完全一致**（`initialized` / `mode`），因为它复用
 * 同一条模式判定链（`docVersion` + `normalizeMode`）——旧名字按版本归一这条规则不能漏，
 * 漏了会让 v4 及更早的文档在插件升级那一刻静默跳进高强度模式。
 *
 * 不返回的东西（有意）：健康性、模块、条目合规、工作流、归档。热路径一个都用不上。
 */
export function readProjectMode(projectRoot, projectName) {
  const slug = slugify(projectName)
  const puzzleDir = slug === null ? null : puzzleDirOf(projectRoot, slug)
  const mainDoc = puzzleDir === null ? null : join(puzzleDir, MAIN_FILE)
  if (mainDoc === null) return { initialized: false, mode: DEFAULT_MODE, mainDoc: '' }
  const text = readTextCached(mainDoc)
  if (text === null) return { initialized: false, mode: DEFAULT_MODE, mainDoc }
  const fields = parseFrontMatter(text).fields
  return { initialized: true, mode: normalizeMode(fields['模式'], docVersion(text)) ?? DEFAULT_MODE, mainDoc }
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
    /** 项目规模档位：没写就是 `中`（升级前的所有上限）。 */
    size: DEFAULT_SIZE,
    modules: [],
    dimensions: Object.fromEntries(HEALTH_KEYS.map((key) => [key, 0])),
    health: 0,
    sections: {},
    findings: [],
    planned: [],
    sessions: [],
    /** 文档格式版本；base 里给当前值，未初始化就没有「旧格式」可言。 */
    version: PUZZLE_VERSION,
    outdated: false,
    error: null,
  }
  if (mainDoc === null || !isFile(mainDoc)) return base

  const text = readTextCached(mainDoc)
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

  const modules = moduleEntries(puzzleDir, planned, text, normalizeSize(fields[SIZE_FIELD]) ?? DEFAULT_SIZE)
  // 模式判定**必须带文档版本**：v4 及更早的 `边拼边写` 是「一轮做完才问」的旧含义，
  // 归一成 `写后再拼`。不带版本会让每个旧项目在插件升级那一刻静默跳进高强度模式。
  const docVer = docVersion(text)
  const rawMode = normalizeMode(fields['模式'], docVer)
  const declaredMode = rawMode === null ? null : rawMode
  // 旧名字被归一过（`模式: 边拼边写` 但文档是 v4）→ 如实标出来，
  // 面板与工具返回都能看见「这个项目其实还没迁移」，而不是悄悄换个名字继续跑。
  const modeRenamed = declaredMode !== null && typeof fields['模式'] === 'string' && fields['模式'].trim() !== declaredMode
  const dimensions = dimensionAverages(modules)

  const state = {
    ...base,
    initialized: true,
    degraded: base.degraded,
    project: typeof fields['项目'] === 'string' && fields['项目'].trim() !== '' ? fields['项目'].trim() : slug,
    mode: declaredMode ?? DEFAULT_MODE,
    modeSource: declaredMode === null ? 'default' : 'front-matter',
    // 规模档位：认不出 / 没写 → `中`。存量文档一个都不用改。
    size: normalizeSize(fields[SIZE_FIELD]) ?? DEFAULT_SIZE,
    /** true 表示 front-matter 里写的是旧名字，已按旧含义（写后再拼）读。 */
    modeRenamed,
    updated: fields['更新时间'] ?? null,
    modules,
    dimensions,
    health: projectHealthOf(modules),
    sections: sectionCounts(body),
    planned,
    sessions: parseSessionList(fields),
    /**
     * 本会话**当前项目**是不是它（v7）。面板的切换条靠它决定哪个胶囊高亮；
     * 没有它就分不出「绑了 5 个」与「当前在这一个」。
     */
    currentSessions: parseCurrentSessionList(fields),
    /** 源码根（front-matter 的 `源码根:`）；空串表示按默认规则找。 */
    sourceRoot: parseSourceRoot(fields),
    version: docVersion(text),
    outdated: docVersion(text) < PUZZLE_VERSION,
    /** 主文档五节里不合规的条目（超长 / 无出处），供审查点名。 */
    mainEntryIssues: entryIssuesIn(body, mainEntrySpecOf(normalizeSize(fields[SIZE_FIELD]) ?? DEFAULT_SIZE)),
    /**
     * `## 工作流` 的条目（纯文本，已去 `- ` 前缀）与归档。
     *
     * 面板直接拿这两份渲染，模型也靠它知道「这个项目现在有哪些行为约束」——
     * 提示段只讲规则，具体约束是每个项目自己的，必须从文档读。
     *
     * 归档走 `normalizeArchiveCapped` **在读取侧也裁一次**：≤10 是契约，
     * 手改文档（或旧版本写进来的）可能超限，读出来就超限等于契约在读取侧不成立。
     */
    workflow: readWorkflow(body),
    workflowArchive: normalizeArchiveCapped(parseWorkflowArchive(fields)),
    // 规范之外的小节（主文档 + 各模块）：审查据此报 unknown_section。
    // 它们既读不进任何 op、也不会被写入覆盖，只能靠 rebuild 清掉——
    // 所以必须**可见**，否则就是「删不掉又看不见」（实测踩过）。
    extraMainSections: extraSectionsIn(body, SECTION_ORDER.map((key) => SECTION_HEADINGS[key])),
    extraModuleSections: modules.flatMap((module) => (
      extraSectionsIn(readTextCached(module.file) ?? '', MODULE_SECTION_ORDER)
        .map((heading) => ({ name: module.name, heading }))
    )),
    goal: (body.split(/\r?\n/).find((line) => line.startsWith('> 目标：')) ?? '').replace(/^>\s*目标：/, '').trim(),
  }
  // 审查发现要同时看模块证据与主文档小节，所以在状态装配完成后再算。
  state.findings = auditOf(state)
  /**
   * 可执行修复清单：把客观发现翻译成「改哪个文件、怎么改、预期效果」。
   *
   * 审查已从「拆代码 / 看文档真实值」升级成**执行方**（用户裁定）：先出清单、
   * 用 `ask_user_question` 问过用户，再动手改源码。
   *
   * 这里传 `null` 作为体检结果：`readState` 是**每个 op 都会走的热路径**，
   * 而源码体检要递归遍历源码目录。所以状态里只带「文档级」清单（条目不合规、
   * 规范外小节、虚高分），**结构级清单**（大文件、巨函数、目录分层）由 `op:audit`
   * 单独算——那一轮本来就要做体检，顺手把清单算全，不额外付一次遍历。
   */
  state.fixPlan = fixPlanOf(state, null).plan
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
  const projectText = isFile(mainDoc) ? readTextCached(mainDoc) : null
  if (!isFile(file)) {
    return {
      ok: true,
      name: slug,
      exists: false,
      file,
      health: 0,
      dimensions: Object.fromEntries(HEALTH_KEYS.map((key) => [key, 0])),
      points: null,
      pending: null,
      decided: null,
      reuse: null,
      detail: null,
    }
  }
  const text = readTextCached(file)
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
    pending: (getSection(body, MODULE_SECTION_HEADINGS.pending) ?? '').trim(),
    decided: (getSection(body, MODULE_SECTION_HEADINGS.decided) ?? '').trim(),
    reuse: (getSection(body, MODULE_SECTION_HEADINGS.reuse) ?? '').trim(),
    detail: (getSection(body, MODULE_SECTION_HEADINGS.detail) ?? '').trim(),
  }
}

/* --------------------------------- 写入 --------------------------------- */

/** 从 front-matter 里安全读出模块清单（坏 JSON 当空数组）。 */


/** 只改主文档的行为字段（模式 / 模块清单），保留其余内容。 */
export function setMainFields(text, patch) {
  const { fields, body } = parseFrontMatter(text)
  const carried = passThroughFields(fields, text)
  const next = {
    puzzle: carried.puzzle,
    project: patch.project ?? fields['项目'] ?? '',
    mode: patch.mode ?? carried.mode,
    modules: patch.modules ?? safePlanned(fields),
    // 绑定必须透传：这两个函数会整份重写 front-matter，漏一次就把绑定丢了。
    sessions: patch.sessions ?? parseSessionList(fields),
    // 当前会话同理必须透传：漏一次，「我切到哪个项目了」就在一次改模式之后静默丢失，
    // 下一次工具调用漂回扫描顺序里的第一个——用户看到的是「切了又自己跳回去」。
    currentSessions: patch.currentSessions ?? parseCurrentSessionList(fields),
    // 源码根同理必须透传：漏一次，审查就找不到源码（退化成「查不到」）。
    sourceRoot: patch.sourceRoot ?? parseSourceRoot(fields),
    // 归档同理：漏一次，「一键删除可回滚」就在任意一次改模式 / 改源码根之后失效。
    workflowArchive: patch.workflowArchive ?? parseWorkflowArchive(fields),
    // 规模档位同理必须透传：漏一次，用户选的「大」就在改一次模式之后静默掉回「中」，
    // 而「中」的条数上限更小 → 下一次写入会**删掉超出的条目**。这种丢失是静默的。
    size: patch.size ?? fields[SIZE_FIELD],
    updated: timestamp(),
  }
  if (!Array.isArray(next.modules)) next.modules = []
  // patch.mode 是调用方给的**当前名字**（setMode 已按 MODES 校验过），所以按当前版判。
  if (normalizeMode(next.mode) === null) next.mode = DEFAULT_MODE
  return `${formatFrontMatter(next)}\n${body.replace(/^\n+/, '')}`
}

/**
 * 会话绑定的读侧：扫项目根，返回这个会话绑定的**全部**项目名（v7 起可多绑定）。
 *
 * **只认 front-matter，不猜**：找不到就是空数组。早先「回退到最新项目」正是文档混成一团的根因。
 *
 * ## 顺序 = 「当前项目」优先
 *
 * 返回的第一个元素就是**当前项目**（`boundProject` 直接取它）。判定依据是主文档里的
 * `当前会话:` 字段，**不是**列表顺序、也不是 mtime：多绑定后「当前」是一个**状态**，
 * 用户从面板切到项目 B，下一次工具调用就该落在 B。靠 mtime 会让「我刚往 A 写了一行」
 * 把当前项目偷偷拽回 A——那种漂移没有可见的起因，用户只会觉得插件「不听话」。
 *
 * 没有任何项目标了当前（手工编辑、或 v6 老文档还没迁移）时退回扫描顺序，
 * 并**不**在这里自愈写盘：读函数写盘会让「读」产生副作用，热路径上尤其危险。
 * 自愈交给迁移与 `setCurrentProject`。
 *
 * ## 为什么要缓存（实测数字，2026-10-02）
 *
 * 本函数在**每一次工具调用**上跑（经 `tools/pre-execute`）。原实现每次 `readdir` +
 * 对**每个条目** `statSync` 一次（试 `<条目>/拼图/主文档.md`）——实测**开销正比于
 * 当前工作目录的条目数**：37 个条目 → 36 次 statSync。`/sdcard` 是 FUSE，
 * 单次 stat 约 0.8ms，于是**每次工具调用白交 10ms 以上**，比一次 20KB 文件写
 * （实测 0.27ms）还贵 30 倍。工作区越乱越慢，这就是「装了插件什么都变慢」的机制。
 *
 * 多绑定没有改变这个量级：稳态下记住的是**已绑的那几个**（通常 1–3 个），
 * 过期时逐个验证，仍不是全扫。
 *
 * ## 失效靠两条，都不需要全扫
 *
 * 1. **文档纪元**（`currentDocEpoch()`）：本进程经 `atomicWrite` 的每次写盘都 +1。
 *    所以**插件自己**改绑 / 解绑 / 切模式之后，记忆当场失效——这条覆盖了正常路径。
 * 2. **短 TTL**：兜住**外部改动**（手工编辑文档、别的进程）。纪元只认本进程的写入，
 *    手工改文档不会 +1，所以必须有个时间兜底。
 *
 * 过期后**不立刻全扫**：先用**每个记忆项一次** stat 验证（`readTextCached` 命中缓存时
 * 只花一次 statSync）。全部通过就续期，只有验证失败才真的全扫。
 * 于是稳态下每 TTL 只花「绑定数」次 stat，而不是 36 次。
 *
 * ## 代价（明确写出来，不藏着）
 *
 * 手工编辑文档把绑定搬到另一个项目时，**可见性从「立刻」变成「最多 TTL 之后」**。
 * 正常改绑走 `op:bind`（纪元 +1）仍是**立刻**。TTL 取 1s（有绑定）/ 5s（无绑定），
 * 无绑定那条更长是因为它是「没在用插件」的常见情况，而手工绑定很少见。
 */
const lastBound = new Map()

/** 正向记忆（记住了项目名）的存活时间：过期后逐个 stat 重新验证。 */
const BOUND_TTL_HIT = 1000

/** 负向记忆（未绑定）的存活时间：过期后全扫一次。取长一点，因为它是常见情况且手工绑定很少。 */
const BOUND_TTL_MISS = 5000

/** 记忆条数上限：防长跑进程把 Map 撑成无限大（会话数只增不减）。超了丢最旧的。 */
const BOUND_MEMO_MAX = 500

/** 把「扫到的绑定」排成「当前项目在前」；没有当前就保持扫描顺序。 */
function orderByCurrent(found) {
  const current = found.filter((item) => item.current)
  if (current.length === 0) return found.map((item) => item.name)
  return [...current, ...found.filter((item) => item.current !== true)].map((item) => item.name)
}

/** 一个项目的主文档里，这个会话是不是「当前」（读 `当前会话:`）。 */
function isCurrentIn(projectRoot, name, sessionId) {
  const dir = puzzleDirOf(projectRoot, name)
  const mainDoc = dir === null ? null : join(dir, MAIN_FILE)
  const text = mainDoc === null ? null : readTextCached(mainDoc)
  if (text === null) return null
  const fields = parseFrontMatter(text).fields
  if (!parseSessionList(fields).includes(sessionId)) return null
  return parseCurrentSessionList(fields).includes(sessionId)
}

export function boundProjects(projectRoot, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return []
  const memoKey = `${projectRoot}\u0000${sessionId}`
  const now = Date.now()
  const memo = lastBound.get(memoKey)
  const epoch = currentDocEpoch()

  // 快路径：纪元没变、且没过 TTL —— **完全不碰文件系统**。
  if (memo !== undefined && memo.epoch === epoch) {
    const ttl = memo.names.length === 0 ? BOUND_TTL_MISS : BOUND_TTL_HIT
    if (now - memo.at < ttl) return memo.names.slice()
  }

  // 过期或纪元变了：先用「每个记忆项一次读」验证，全部通过就续期（不做全扫）。
  if (memo !== undefined && memo.names.length > 0) {
    const kept = []
    let valid = true
    for (const name of memo.names) {
      const current = isCurrentIn(projectRoot, name, sessionId)
      if (current === null) {
        valid = false
        break
      }
      kept.push({ name, current })
    }
    if (valid && kept.length > 0) {
      const names = orderByCurrent(kept)
      lastBound.set(memoKey, { names, epoch, at: now })
      return names.slice()
    }
    lastBound.delete(memoKey)
  }

  // 全扫：**不用 `listProjects`**——那个函数为了按 mtime 倒序，要对每个候选项目
  // `statSync` 一次。本函数只要「哪些项目绑了这个会话」，扫到即收，**不需要排序**。
  const found = []
  for (const entry of listFiles(projectRoot)) {
    const text = readTextCached(join(projectRoot, entry, PUZZLE_DIR, MAIN_FILE))
    if (text === null) continue
    const fields = parseFrontMatter(text).fields
    if (!parseSessionList(fields).includes(sessionId)) continue
    found.push({ name: entry, current: parseCurrentSessionList(fields).includes(sessionId) })
  }
  const names = orderByCurrent(found)
  lastBound.set(memoKey, { names, epoch: currentDocEpoch(), at: now })
  while (lastBound.size > BOUND_MEMO_MAX) lastBound.delete(lastBound.keys().next().value)
  return names.slice()
}

/**
 * 本会话的**当前项目**：绑定的那几个里的第一个（`当前会话:` 标了它）。
 *
 * 保留这个名字与签名，是因为它在热路径（`tools/pre-execute`）与所有既有调用点上
 * 都是「一个项目」的语义。多绑定改变的是**有哪些**，不是「工具默认落在哪」——
 * 后者仍然只能有一个答案。
 */
export function boundProject(projectRoot, sessionId) {
  const names = boundProjects(projectRoot, sessionId)
  return names.length > 0 ? names[0] : null
}

/** 清掉某个会话的全部记忆（`bindings` 变动后调用；写盘也会自动让纪元失效）。 */
export function forgetBound(projectRoot, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  lastBound.delete(`${projectRoot}\u0000${sessionId}`)
}

/**
 * 把主文档的会话绑定改成给定的一份（其余 front-matter 字段原样保留）。
 *
 * `currentSessions` 不给就**从旧值里保留仍在 `sessions` 里的那些**——
 * 这条默认值让「只改绑定、不动当前」的调用点不必关心当前字段，
 * 同时保证不变量 `当前会话 ⊆ 会话`（被解绑的会话自动从当前里消失）。
 */
export function writeSessionList(mainDoc, text, sessions, currentSessions) {
  try {
    const { fields, body } = parseFrontMatter(text)
    const carried = passThroughFields(fields, text)
    const nextSessions = normalizeSessions(sessions)
    const nextCurrent = currentSessions === undefined
      ? parseCurrentSessionList(fields).filter((id) => nextSessions.includes(id))
      : normalizeSessions(currentSessions).filter((id) => nextSessions.includes(id))
    const next = [
      formatFrontMatter({
        puzzle: carried.puzzle,
        project: fields["项目"] ?? "",
        mode: carried.mode,
        modules: safePlanned(fields),
        sessions: nextSessions,
        currentSessions: nextCurrent,
        sourceRoot: parseSourceRoot(fields),
        // ⚠️ **规模档位必须透传**（v0.23.3 修的真丢数据 bug）：漏了它，改一次会话绑定
        // 就把 `规模: 大` 抹掉 → 下次读按中档 → 上限更严 → 超出的条目被静默删除。
        size: fields[SIZE_FIELD],
        workflowArchive: parseWorkflowArchive(fields),
        updated: timestamp(),
      }),
      body.replace(/^\n+/, ""),
    ].join("\n")
    atomicWrite(mainDoc, next)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) }
  }
}

/**
 * 解绑一个会话：把它从**所有**项目的 `会话:` 与 `当前会话:` 里摘掉，回到「没绑定」。
 *
 * 为什么扫全量而不是只改「当前绑定的那个」：绑定是文档里的一行文本，可能因为手工编辑、
 * 或旧版本插件而被写成多处命中。解绑的语义是「这个会话不再绑任何项目」，必须扫全量。
 * 返回被摘掉的项目名列表，好让调用方如实回报。
 */
export function unbindSession(projectRoot, sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") {
    return { ok: false, error: "缺少会话 ID", hint: "解绑需要一个会话 ID" }
  }
  // 不用手动清「上次绑定」的记忆：下面的 `writeSessionList` 走 `atomicWrite`，
  // 每次写盘都会 +1 文档纪元，记忆因此自动失效（见 `boundProjects` 的说明）。
  const released = []
  for (const entry of listProjects(projectRoot)) {
    const text = readTextCached(entry.mainDoc)
    if (text === null) continue
    const fields = parseFrontMatter(text).fields
    const list = parseSessionList(fields)
    const current = parseCurrentSessionList(fields)
    if (!list.includes(sessionId) && !current.includes(sessionId)) continue
    const cut = writeSessionList(
      entry.mainDoc, text,
      list.filter((item) => item !== sessionId),
      current.filter((item) => item !== sessionId),
    )
    if (cut.ok !== true) {
      return { ok: false, error: "解绑失败：" + entry.name, hint: cut.error }
    }
    released.push(entry.name)
  }
  forgetBound(projectRoot, sessionId)
  return { ok: true, released }
}

/**
 * 解绑**单个**项目上的绑定（面板每项那个 `×`）。
 *
 * 与 `unbindSession` 分开：那个的语义是「本会话不再绑任何项目」，扫全量是对的；
 * 这个只该动一个项目，动了别的项目就是越权。
 *
 * 解完之后如果本会话还有别的绑定、却一个都没标当前（刚删掉的正好是当前那个），
 * 就把第一个绑定补标成当前——否则「绑定还在、当前却没了」，
 * 工具不给 project 时会落回扫描顺序，用户看到的是「切的项目自己变了」。
 */
export function unbindOne(projectRoot, projectName, sessionId) {
  const slug = slugify(projectName)
  if (slug === null) return { ok: false, error: "项目名不合法", hint: "检查项目名" }
  if (typeof sessionId !== "string" || sessionId === "") {
    return { ok: false, error: "缺少会话 ID", hint: "解绑需要一个会话 ID" }
  }
  const puzzleDir = puzzleDirOf(projectRoot, slug)
  if (puzzleDir === null) return { ok: false, error: "项目路径越界", hint: "检查项目名" }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  const text = readTextCached(mainDoc)
  if (text === null) return { ok: false, error: "项目尚未创建", hint: "先执行 op=init" }
  const fields = parseFrontMatter(text).fields
  const list = parseSessionList(fields)
  if (!list.includes(sessionId)) {
    return { ok: false, error: "本会话没绑这个项目", hint: "刷新面板看最新绑定" }
  }
  const cut = writeSessionList(
    mainDoc, text,
    list.filter((item) => item !== sessionId),
    parseCurrentSessionList(fields).filter((item) => item !== sessionId),
  )
  if (cut.ok !== true) return { ok: false, error: "解绑失败", hint: cut.error }
  forgetBound(projectRoot, sessionId)
  const ensured = ensureCurrentProject(projectRoot, sessionId)
  return { ok: true, project: slug, current: ensured.current }
}

/**
 * 把本会话的**当前项目**切到 `projectName`（面板切换条、`op:bind` 都走它）。
 *
 * 三件事必须一起做，缺一件就出现「两个项目都以为自己是当前」：
 *   1. 目标项目：把本会话写进 `会话:`（没绑就先绑上）与 `当前会话:`；
 *   2. 其它**绑定了本会话**的项目：把本会话从它们的 `当前会话:` 里摘掉；
 *   3. 没绑定本会话的项目：不动（它们与这次切换无关）。
 *
 * 第 2 步扫的是 `boundProjects` 而不是全量项目：切换是高频动作，
 * 全扫要读每个项目的主文档；而「会与本会话争当前」的只可能是已绑的那几个。
 */
export function setCurrentProject(projectRoot, projectName, sessionId) {
  const slug = slugify(projectName)
  if (slug === null) return { ok: false, error: "项目名不合法", hint: "检查项目名" }
  if (typeof sessionId !== "string" || sessionId === "") {
    return { ok: false, error: "缺少会话 ID", hint: "切换当前项目需要一个会话 ID" }
  }
  const puzzleDir = puzzleDirOf(projectRoot, slug)
  if (puzzleDir === null) return { ok: false, error: "项目路径越界", hint: "检查项目名" }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: "项目尚未创建", hint: "先执行 op=init" }

  const others = boundProjects(projectRoot, sessionId).filter((name) => name !== slug)
  const text = readTextCached(mainDoc)
  if (text === null) return { ok: false, error: "主文档读不出来", hint: "检查文件权限" }
  const fields = parseFrontMatter(text).fields
  const list = parseSessionList(fields)
  if (!list.includes(sessionId)) list.push(sessionId)
  const written = writeSessionList(mainDoc, text, list, [sessionId])
  if (written.ok !== true) return { ok: false, error: "切换当前项目失败", hint: written.error }

  for (const name of others) {
    const dir = puzzleDirOf(projectRoot, name)
    const otherDoc = dir === null ? null : join(dir, MAIN_FILE)
    const otherText = otherDoc === null ? null : readTextCached(otherDoc)
    if (otherText === null) continue
    const otherFields = parseFrontMatter(otherText).fields
    const otherCurrent = parseCurrentSessionList(otherFields)
    if (!otherCurrent.includes(sessionId)) continue
    const cut = writeSessionList(otherDoc, otherText, parseSessionList(otherFields), otherCurrent.filter((id) => id !== sessionId))
    if (cut.ok !== true) return { ok: false, error: "切换当前项目失败：" + name, hint: cut.error }
  }
  forgetBound(projectRoot, sessionId)
  return { ok: true, project: slug, sessions: normalizeSessions(list), droppedFrom: others }
}

/**
 * 追加一个绑定（面板那个 `＋`），并把它设为当前。
 *
 * 与 `bindSession` 的差别是**要不要动已有的绑定**：这个只加、不删；
 * `bindSession` 的语义是「本会话就绑这一个」，会先把别处摘干净。
 * 两者都在改绑后把目标设为当前——「刚绑上」本来就意味着「接下来要看它」。
 */
export function addBinding(projectRoot, projectName, sessionId) {
  const slug = slugify(projectName)
  if (slug === null) return { ok: false, error: "项目名不合法", hint: "检查项目名" }
  if (typeof sessionId !== "string" || sessionId === "") {
    return { ok: false, error: "缺少会话 ID", hint: "绑定需要一个会话 ID" }
  }
  const puzzleDir = puzzleDirOf(projectRoot, slug)
  if (puzzleDir === null) return { ok: false, error: "项目路径越界", hint: "检查项目名" }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: "项目尚未创建", hint: "先执行 op=init" }
  const before = boundProjects(projectRoot, sessionId)
  if (before.includes(slug)) {
    // 已经绑了就只切当前：重复点「＋」不该在数组里塞第二份（`normalizeSessions` 会去重，
    // 但先在这里挡住，调用方才能拿到「本来就绑着」这个事实去提示用户）。
    const moved = setCurrentProject(projectRoot, slug, sessionId)
    if (moved.ok !== true) return moved
    return { ...moved, already: true }
  }
  const moved = setCurrentProject(projectRoot, slug, sessionId)
  if (moved.ok !== true) return moved
  return { ...moved, already: false, bindings: boundProjects(projectRoot, sessionId) }
}

/**
 * 保证「有绑定就一定有当前」：没有的话把第一个绑定补标成当前。
 *
 * 这条不变量只能在这里补，因为它是**删除的副作用**：解绑当前项目之后，
 * 剩下的绑定里没人标当前。不补的话工具不给 project 时落回扫描顺序——
 * 顺序取决于 `readdir`，用户看到的就是「当前项目自己跳了」。
 */
function ensureCurrentProject(projectRoot, sessionId) {
  const names = boundProjects(projectRoot, sessionId)
  if (names.length === 0) return { ok: true, current: null }
  for (const name of names) {
    if (isCurrentIn(projectRoot, name, sessionId) === true) return { ok: true, current: name }
  }
  const fixed = setCurrentProject(projectRoot, names[0], sessionId)
  return { ok: fixed.ok === true, current: fixed.ok === true ? names[0] : null }
}

/**
 * 把一个会话绑到某个项目：目标项目写进本会话，**其他项目上先解绑**。
 *
 * 「先解绑再绑定」是这条不变量的唯一执行点：`op:bind` 的语义是
 * 「本会话就绑这一个项目」（替换全部，不是追加）——模型说「绑到 B」时，
 * 它要的是**只有 B**，不是「B 也在列表里」。要追加第二个绑定，走面板的 `＋`
 * （`addBinding`）。两条路语义分开，模型就不会因为一次 `op:bind` 意外丢掉别的绑定。
 */
export function bindSession(projectRoot, projectName, sessionId) {
  const slug = slugify(projectName)
  if (slug === null) return { ok: false, error: "项目名不合法", hint: "检查项目名" }
  if (typeof sessionId !== "string" || sessionId === "") {
    return { ok: false, error: "缺少会话 ID", hint: "绑定需要一个会话 ID" }
  }
  const puzzleDir = puzzleDirOf(projectRoot, slug)
  if (puzzleDir === null) return { ok: false, error: "项目路径越界", hint: "检查项目名" }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: "项目尚未创建", hint: "先执行 op=init" }

  // 先把本会话从**所有**项目上摘掉（含目标项目，随后重新加上），再绑目标项目。
  // 复用 unbindSession 而不是自己写一遍循环：解绑语义只有一处实现。
  const cut = unbindSession(projectRoot, sessionId)
  if (cut.ok !== true) return { ok: false, error: cut.error, hint: cut.hint }
  const released = cut.released.filter((name) => name !== slug)

  const text = readTextCached(mainDoc)
  if (text === null) return { ok: false, error: "主文档读不出来", hint: "检查文件权限" }
  const list = parseSessionList(parseFrontMatter(text).fields)
  if (!list.includes(sessionId)) list.push(sessionId)
  // 唯一绑定 = 它当然就是当前项目（v7 起两者一起写）。
  const written = writeSessionList(mainDoc, text, list, [sessionId])
  if (written.ok !== true) return { ok: false, error: "写入绑定失败", hint: written.error }
  forgetBound(projectRoot, sessionId)
  return { ok: true, project: slug, mainDoc, sessions: normalizeSessions(list), current: [sessionId], released }
}

/** 建目录 + 主文档 + N 份模块文档（已存在的模块文档不覆盖）。 */


/** 建目录 + 主文档 + N 份模块文档（已存在的模块文档不覆盖）。 */
export function createProject(projectRoot, projectName, goal, modules, mode = DEFAULT_MODE, sessionId = '') {
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
    const bindTo = typeof sessionId === 'string' && sessionId !== '' ? [sessionId] : []
    // 新建时顺手绑定：`会话:` 与 `当前会话:` 一起写（v7）。只写绑定不写当前的话，
    // 新项目建完却「不是当前项目」，下一次工具调用还落在原来那个项目上——
    // 用户看到的正是「刚建的项目没切过去」。
    if (mainCreated) atomicWrite(mainDoc, mainTemplate(slug, names, goal, mode, bindTo, bindTo))
    const created = []
    for (const name of names) {
      const file = join(puzzleDir, MODULE_DIR, `${name}.md`)
      if (isFile(file)) continue
      atomicWrite(file, moduleTemplate(name))
      created.push(name)
    }
    // 主文档建好后立刻落绑定：即使后续模块创建失败，绑定关系也已经成立。
    //
    // **只在主文档是这次新建的时候才绑**：项目已经存在时再走一次 `op:init`（模型很常见：
    // 「建项目」被当成幂等的「确保存在」），无条件绑定会把用户刚解绑的会话
    // **重新写回 `会话:` 行** —— 表现就是「解绑了过一会又自动绑定」。
    // 已有项目要改绑，走 `op:bind`（显式意图）或面板切换条。
    //
    // v7 起用 `addBinding`（**追加** + 设为当前）而不是 `bindSession`（替换全部）：
    // 一个会话可以同时操作几个项目，新建第三个项目时把前两个的绑定一起抹掉是**静默丢绑定**。
    // 这条与 `op:bind` 的分工是刻意的——`op:bind` 是模型显式说「就绑这一个」，
    // `op:init` 只是「建个项目」，「建」不该顺带解绑别的东西。
    const shouldBind = mainCreated && bindTo.length > 0
    const bound = shouldBind ? addBinding(projectRoot, slug, bindTo[0]) : null
    return {
      ok: true,
      project: slug,
      puzzleDir,
      mainDoc,
      mainCreated,
      created,
      modules: names,
      existing: names.filter((name) => !created.includes(name)),
      // `rebound: false` 明确告诉调用方「项目已存在，这次没有动绑定」，别把它当成绑成功。
      bound: bound !== null && bound.ok === true,
      rebound: shouldBind,
      // `addBinding` 不删任何绑定，所以 `released` 恒为空——保留字段是为了让调用方
      // 不必区分「用了哪条绑定路径」，读到空数组就知道这次没解绑任何项目。
      released: bound !== null && bound.ok === true ? (bound.released ?? []) : [],
      bindError: bound !== null && bound.ok !== true ? bound.error : null,
    }
  } catch (error) {
    return { ok: false, error: '创建文档失败', hint: String(error && error.message ? error.message : error) }
  }
}

/**
 * 更新主文档的一个小节；index 小节同时刷新 front-matter 的模块清单。
 *
 * v4 起五节都有**字数上限**；除 `index`（指向模块文档）与 `workflow`（约束模型行为）外，
 * 每条还必须带源码出处（`ENTRY_LIMITS`）：
 * 校验不过就整次拒绝（不截断——半句话落进文档比报错更糟）。
 * `index` 小节是模块清单，条目格式不同，只做字数校验。
 */
export function updateMainSection(projectRoot, projectName, section, content, append = true) {
  if (!SECTION_KEYS.has(section)) {
    return { ok: false, error: `未知小节 ${section}`, hint: `可用：${SECTION_ORDER.join(' / ')}（主文档只有这五节）` }
  }
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: '项目尚未创建', hint: '先执行 op=init' }
  const text = readTextCached(mainDoc)
  if (text === null) return { ok: false, error: '主文档读不出来', hint: '检查文件权限' }

  const { fields, body } = parseFrontMatter(text)
  // **规模档位**：同一个项目写多细由它定（没写 = `中`，即升级前的所有上限）。
  // 字数上限按档取——`大` 档放宽（已定 / 要点这类常要写下一句带取舍的结论）。
  const size = normalizeSize(fields[SIZE_FIELD]) ?? DEFAULT_SIZE
  const sizeLimits = limitsOfSize(size)

  // 模块索引指向的是模块文档（`模块/X.md` 就是回查路径），所以只限长、不强制 `（源码: …）`。
  // `workflow` 同理不强制出处，而且**连占位过滤都要用自己的那一套**（见 normalizeWorkflowEntries）：
  // 复用模块文档的 `normalizeEntries` 会把以括号开头的合法规则静默吞掉。
  const requireSource = section !== 'index' && section !== 'workflow'
  const checked = section === 'workflow'
    ? normalizeWorkflowEntries(content)
    : normalizeEntries(content, sizeLimits[section], undefined, requireSource)
  if (checked.ok !== true) return { ok: false, error: checked.error, hint: checked.hint }

  let nextBody = applySection(body, SECTION_HEADINGS[section], checked.text, append !== false)
  let dropped = []
  // 工作流的 5 条上限与 `## 悬而未决`（4 条）同属硬规则：超了**删最旧**。
  // 与模块小节不同，这里**不把删掉的条目进归档**——走 `op:main` 写工作流是模型的行为，
  // 模型看得见自己写了几条；「一键删除可回滚」是面板那条路（`op:workflow` / RPC workflow）。
  // 两条路的语义分开，免得「模型追加一条」意外把用户删掉的旧条目捞回归档。
  //
  // 规模档位在这里起作用：`坑` 是唯一按规模限条数的主文档小节
  // （`小` 10 / `中` 不限 / `大` 60），工作流条数也随档变（3 / 5 / 12）。
  const sizeCaps = capsOfSize(size)
  const cap = section === 'workflow' ? sizeCaps.workflow : (section === 'pit' ? sizeCaps.pit : undefined)
  if (cap !== undefined && cap !== null) {
    // **数条目必须用「这一节自己的规则」**：工作流用 `readWorkflow`（解析 `### 块`），
    // 其余小节用 `entryLines`。这里曾经对工作流也调 `entryLines`，而它带着**模块文档**的
    // `PLACEHOLDER_PATTERNS`（「待补」「轮汇报」「可被别处复用」「最多 N 条」）——后果有两个，
    // 都很糟：① 以括号开头的合法内容被当成占位行，数出 0 条 → 整节被替换成占位行，
    // 内容**静默消失**，而返回值还报 `ok:true`；② 8 条里 3 条被当占位 → 只数到 5 条，
    // 判定「没超上限」→ 5 条硬上限被绕过（实测留下 8 条）。
    const all = section === 'workflow'
      ? readWorkflow(parseFrontMatter(nextBody).body)
      : entryLines(getSection(parseFrontMatter(nextBody).body, SECTION_HEADINGS[section]) ?? '')
    if (all.length > cap) {
      const kept = all.slice(all.length - cap)
      // 工作流被顶掉的是**整条流水线**，所以 `dropped` 报名字（面板 / 模型据此知道删了哪条）。
      dropped = section === 'workflow'
        ? all.slice(0, all.length - cap).map((block) => block.name)
        : all.slice(0, all.length - cap).map((line) => (line.startsWith('- ') ? line : '- ' + line))
      // 工作流走 `writeWorkflow`：它保证「写空」与「新建」得到同一种形状（占位行）。
      nextBody = section === 'workflow'
        ? writeWorkflow(nextBody, kept)
        : withSection(nextBody, SECTION_HEADINGS[section], kept.join('\n'))
    } else if (all.length === 0) {
      // 空工作流**不能留一个光秃秃的 `## 工作流`**：那看着像坏了，而且 `op:rebuild`
      // 只在「小节不存在」时补占位——标题已经在，它就永远修不回来。
      // 这里复用 `writeWorkflow` 的占位逻辑，保证「写空」和「新建」得到同一种形状。
      nextBody = section === 'workflow'
        ? writeWorkflow(nextBody, [])
        : nextBody
    }
  }
  let planned = null
  if (section === 'index') {
    // 模块索引里出现过的模块名，同步进 front-matter 的模块清单（UI 的图块据此建出来）。
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
      puzzle: PUZZLE_VERSION,
      project: fields['项目'] ?? projectName,
      mode: modeOfFields(fields, docVersion(text)),
      modules: planned ?? safePlanned(fields),
      sessions: parseSessionList(fields),
      // 当前会话必须一起透传：只透传绑定而不透传当前，一次改工作流 / 改小节
      // 就会把「我切到哪个项目了」清掉，下一次工具调用漂回扫描顺序里的第一个。
      currentSessions: parseCurrentSessionList(fields),
      sourceRoot: parseSourceRoot(fields),
      // ⚠️ **规模档位必须透传**（v0.23.3 修的真丢数据 bug）：
      // 漏了它，追加一条「坑」就把 `规模: 大` 抹掉 → 下次读按中档 → 上限更严 →
      // **超出的条目在下一次写入被静默删除**。实测：坑 149 条被砍到 60 条，丢 93 条。
      // 这条路径就是当初把我 93 条数据删掉的那一条。
      size: fields[SIZE_FIELD],
      workflowArchive: parseWorkflowArchive(fields),
      updated: timestamp(),
    }),
    nextBody.replace(/^\n+/, ''),
  ].join('\n')
  try {
    atomicWrite(mainDoc, next)
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return { ok: true, mainDoc, section, entries: checked.incoming, dropped }
}

/**
 * 更新（必要时创建）模块文档的一个小节。
 *
 * `points` / `pending` / `decided` / `detail` 都是**条目式**小节：
 * 每条限字数、必须带源码出处；`pending` ≤4、`decided` ≤10，超限**删最旧**。
 */
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

  let text = isFile(file) ? readTextCached(file) : null
  const created = text === null
  if (text === null) text = moduleTemplate(slug)

  // **规模档位**：同一个项目写多细由主文档的 `规模:` 定（没写 = `中`）。
  // 模块文档自己不带这个字段——它是**项目级**决定，一个项目里的模块不该各写各的。
  const size = sizeOfProject(projectRoot, projectName)
  const sizeCaps = capsOfSize(size)
  const sizeLimits = limitsOfSize(size)

  let dropped = []
  let entries = 0
  /** ③ 写入「已定 / 悬而未决」时，把现有条目摊出来供模型对照（v0.19.9）。 */
  let conflicts = null
  if (section === 'progress') {
    const percent = clampPercent(Number(String(content).replace(/[^\d]/g, '')))
    text = applySection(text, MODULE_SECTION_HEADINGS.progress, `完成度: ${percent}`, false)
  } else if (section === 'health') {
    // 只接受五个已知维度名；其余行（说明文字）原样保留在正文里。
    text = applySection(text, HEALTH_HEADING, content, append !== false)
  } else {
    const checked = normalizeEntries(content, sizeLimits[section], sizeCaps[section])
    if (checked.ok !== true) return { ok: false, error: checked.error, hint: checked.hint }
    entries = checked.incoming
    dropped = checked.dropped
    // ③ 在**改写之前**读现有条目：只对「决策类」小节做（悬而未决 / 已定）——
    // 它们是「当前有效的决定」，被取代却不删就会变成反向规则（实测踩过）。
    // 要点 / 详细记录 / 可复用 是事实与记录，追加即可，不需要对照。
    if (section === 'pending' || section === 'decided') {
      const before = entryLines(getSection(parseFrontMatter(text).body, MODULE_SECTION_HEADINGS[section]) ?? '')
        .map((line) => entryBody(line))
      conflicts = conflictDigest(section, before, entryLines(content).map((line) => entryBody(line)), sizeCaps[section])
    }
    // 条数上限是**硬规则**：先按 append 合并新旧，再整体裁到末尾 N 条（最旧的先删）。
    const merged = applySection(text, MODULE_SECTION_HEADINGS[section], checked.text, append !== false)
    const cap = sizeCaps[section]
    if (cap === undefined || cap === null) {
      text = merged
    } else {
      const all = entryLines(getSection(parseFrontMatter(merged).body, MODULE_SECTION_HEADINGS[section]) ?? '')
      const overflow = all.length > cap ? all.slice(0, all.length - cap) : []
      if (overflow.length > 0) {
        dropped = overflow
        text = withSection(merged, MODULE_SECTION_HEADINGS[section], all.slice(all.length - cap).join('\n'))
      } else {
        text = merged
      }
    }
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
    const mainText = readTextCached(mainDoc)
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

  return { ok: true, file, created, section, entries, dropped, conflicts }
}

/**
 * 写模块文档的「健康性」小节。
 *
 * **项目级健康性不写进文档**（主文档只留规范小节，没有它的容身处）：
 * 项目健康性 = 各模块健康性的均值，由宿主汇总，手写只会与事实矛盾。
 */
export function updateProjectHealth() {
  return {
    ok: false,
    error: '项目级健康性不再写进文档',
    hint: '主文档只有 模块索引 / 源码索引 / 工具索引 / 坑 / 工作流 五节。五维请用 op:health 并给 name 写到对应模块文档，项目健康性由宿主按模块均值汇总。',
  }
}

/** 写模式（主文档 front-matter）。 */


/** 写模式（主文档 front-matter）。 */
/**
 * 写主文档的**规模档位**（front-matter 的 `规模:`）。
 *
 * 为什么要有它：固定上限对两头都不合适——小项目的「已定 10 条」写不满，
 * 大项目的「悬而未决 4 条」一上午就顶满，于是**最旧的决策被静默挤掉**。
 * 规模让用户按项目体量选，而不是全仓一个数。
 *
 * 写 `中` 时**把这一行删掉**（它是默认值，留着是噪音）；读侧认不出就当 `中`，
 * 所以存量文档一个都不用改。
 */
export function setSize(projectRoot, projectName, size) {
  const value = normalizeSize(size)
  if (value === null) {
    return { ok: false, error: `未知规模 ${size}`, hint: `可用：${SIZES.join(' / ')}（也可以给 s / m / l）` }
  }
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: '项目尚未创建', hint: '先执行 op=init' }
  const text = readTextCached(mainDoc)
  if (text === null) return { ok: false, error: '主文档读不出来', hint: '检查文件权限' }
  try {
    atomicWrite(mainDoc, setMainFields(text, { size: value }))
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return { ok: true, size: value, caps: capsOfSize(value), entryLimits: limitsOfSize(value), mainDoc }
}

export function setMode(projectRoot, projectName, mode) {
  if (!MODES.includes(mode)) return { ok: false, error: `未知模式 ${mode}`, hint: `可用：${MODES.join(' / ')}` }
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: '项目尚未创建', hint: '先执行 op=init' }
  const text = readTextCached(mainDoc)
  if (text === null) return { ok: false, error: '主文档读不出来', hint: '检查文件权限' }
  try {
    atomicWrite(mainDoc, setMainFields(text, { mode }))
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return { ok: true, mode, mainDoc }
}

/**
 * 写主文档的**源码根**（front-matter 的 `源码根:`）。
 *
 * 为什么要有它：审查要做源码体检（文件行数、巨函数、目录分层），而文档目录与源码目录
 * 常常不在一处。把它记进文档，之后每次审查都知道去哪看代码，不必每次手填。
 * 传空串 = 清掉这一行（回到默认规则：拼图目录的上一级）。
 */
export function setSourceRoot(projectRoot, projectName, sourceRoot) {
  const value = typeof sourceRoot === 'string' ? sourceRoot.trim() : ''
  const puzzleDir = puzzleDirOf(projectRoot, projectName)
  if (puzzleDir === null) return { ok: false, error: '项目名不合法', hint: '检查项目名' }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: '项目尚未创建', hint: '先执行 op=init' }
  // 给了路径就校验它确实存在——写进去一个不存在的路径，等于给审查埋一个「查不到」。
  if (value !== '') {
    let ok = false
    try {
      ok = statSync(value).isDirectory()
    } catch (_error) {
      ok = false
    }
    if (!ok) return { ok: false, error: '源码目录不存在或读不了：' + value, hint: '给一个存在的绝对路径' }
    const found = collectSourceFiles(value)
    if (found.length === 0) {
      return { ok: false, error: '该目录下没有源码文件：' + value, hint: '确认路径指向的是源码目录（不是只有文档或产物的目录）' }
    }
  }
  const text = readTextCached(mainDoc)
  if (text === null) return { ok: false, error: '主文档读不出来', hint: '检查文件权限' }
  try {
    atomicWrite(mainDoc, setMainFields(text, { sourceRoot: value }))
  } catch (error) {
    return { ok: false, error: '写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return { ok: true, sourceRoot: value, mainDoc }
}

/* --------------------------------- 汇总输出 --------------------------------- */

/** 每次返回都带上的固定收尾问（三处口径一致：提示段 / 工具返回 / UI 模板）。 */
