/**
 * front-matter 解析/生成、小节读写、文档格式版本。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */
import { join } from 'node:path'
import { DEFAULT_MODE, SOURCE_ROOT_FIELD, PUZZLE_VERSION, HEADING_BY_KEY, HEADING_SUFFIX_SEPARATOR, SIZE_FIELD, DEFAULT_SIZE, normalizeSize } from './constants.js'
import { slugify, timestamp } from './util.js'


/* ------------------------------- front-matter ------------------------------- */

/**
 * 写一段 front-matter。
 *
 * 主文档：`项目 / 模式 / 计划模块 / 规模 / 源码根 / 更新时间`；
 * 模块文档：`项目 / 模块 / 更新时间`。
 * 「模式」是项目级设置，模块文档不带它（早先模板误抄了 `模式:`，已去掉）。
 * 模块列表走 JSON，避免与 `、` 之类的分隔符冲突。
 *
 * ⚠️ **v8 起这里不再写 `会话:` / `当前会话:`**（插件全局化，项目与会话解绑）。
 * 老文档里那两行由 `op=rebuild` 的 v7→v8 迁移删掉；本函数只管「不再写回去」。
 */
export function formatFrontMatter(fields) {
  const modules = Array.isArray(fields.modules) ? fields.modules : []
  const lines = [
    '---',
    `puzzle: ${fields.puzzle ?? PUZZLE_VERSION}`,
    `项目: ${fields.project ?? ''}`,
  ]
  if (typeof fields.module === 'string' && fields.module !== '') {
    lines.push(`模块: ${fields.module}`)
  } else {
    lines.push(`模式: ${fields.mode ?? DEFAULT_MODE}`)
    lines.push(`计划模块: ${JSON.stringify(modules)}`)
    // 规模档位（小 / 中 / 大）：决定「同一个项目写多细」（条数上限与字数上限）。
    // **只在非默认档时写这一行**——`中` 是默认值，写出来就是一行噪音，
    // 而且会让存量文档在任意一次写入后凭空多出一个字段。读侧认不出就当 `中`。
    const size = normalizeSize(fields.size)
    if (size !== null && size !== DEFAULT_SIZE) lines.push(`${SIZE_FIELD}: ${size}`)
    // 源码根：**文档目录与源码目录常常不在一处**（本项目就是：文档在
    // /sdcard/dsha222/拼图模式插件/拼图/，源码在 /root/.dsh/plugin-src/dsh-puzzle-mode/）。
    // 记在文档里，审查的源码体检才知道去哪看；没记就退回「项目目录」。
    const sourceRoot = typeof fields.sourceRoot === 'string' ? fields.sourceRoot.trim() : ''
    if (sourceRoot !== '') lines.push(`${SOURCE_ROOT_FIELD}: ${sourceRoot}`)
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

/**
 * 读主文档 front-matter 里的 `源码根:`；缺失返回空串（= 用默认规则去找）。
 *
 * **不抛错**：坏值当没写，退回默认源码根。
 */
export function parseSourceRoot(fields) {
  const raw = fields !== null && typeof fields === 'object' ? fields[SOURCE_ROOT_FIELD] : undefined
  return typeof raw === 'string' ? raw.trim() : ''
}

/* --------------------------------- 小节读写 --------------------------------- */

/** 取出某个 `## 标题` 小节的正文（到下一个 `## ` 为止）。 */


/* --------------------------------- 小节读写 --------------------------------- */

/**
 * 判断一行是不是「某个规范标题」的小节头，允许后面跟一段说明。
 *
 * `## 源码索引（src/，共 110 文件）` 要能匹配 `## 源码索引`——否则那一节读不出来，
 * 写的时候还会另起一个空节，原文永远看不见（实测 bug）。
 * 但只容忍**分隔符开头**的后缀：`## 坑与决策` 不是 `## 坑`，
 * 否则会把两个不同的小节误合并。
 */
export function headingMatches(line, heading) {
  const text = String(line ?? '').trim()
  const want = String(heading ?? '').trim()
  if (text === want) return true
  if (!text.startsWith(want)) return false
  return HEADING_SUFFIX_SEPARATOR.test(text.slice(want.length))
}

/** 取出某个 `## 标题` 小节的正文（到下一个 `## ` 为止）。 */
export function getSection(text, heading) {
  const lines = String(text ?? '').split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (headingMatches(lines[i], heading)) {
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

/**
 * 找出文档里**规范之外**的小节标题。
 *
 * 判定用 `headingMatches`：`## 源码索引（src/…）` 不算多余（它属于 `## 源码索引`），
 * 而 `## 模块 → 文档` 算多余。审查与 rebuild 共用这一份判定，
 * 免得「一个说要删、另一个说不算」。
 */
export function extraSectionsIn(body, canonicalHeadings) {
  const seen = []
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (!/^##\s/.test(line)) continue
    const heading = line.trim()
    if (seen.includes(heading)) continue
    seen.push(heading)
  }
  return seen.filter((heading) => !canonicalHeadings.some((known) => headingMatches(heading, known)))
}

/**
 * 替换/插入一个小节。返回值直接写盘，所以只在这里做一次行级拼装：
 * 找到 `## 标题` 就替换它的正文，找不到就插到最后一个已知小节之后（没有就插到文末）。
 */
export function withSection(text, heading, content) {
  const body = String(content ?? '').replace(/^\n+/, '').replace(/\s+$/, '')
  const lines = String(text ?? '').split(/\r?\n/)
  // 用容忍后缀的匹配：`## 源码索引（src/…）` 要原地替换，而不是另起一个空节。
  const at0 = lines.findIndex((line) => headingMatches(line, heading))
  const start = at0
  const block = body === '' ? [] : body.split('\n')

  if (start >= 0) {
    let end = lines.length
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^##\s/.test(lines[i])) {
        end = i
        break
      }
    }
    // 标题本身也归一化成规范写法：说明后缀（「（src/，共 110 文件）」）是旧文档的
    // 残留，写一次就顺手清掉，免得同一节长期存在两种标题。
    // 小节之间保留一个空行：`block` 后面紧跟下一个 `## ` 会让标题贴着上一条，
    // 渲染出来是一个大段落。只有当后面**确实还有内容**（end < lines.length）时才补。
    const tail = end < lines.length ? [''] : []
    return [...lines.slice(0, start), heading, ...block, ...tail, ...lines.slice(end)].join('\n')
  }

  let insertAt = lines.length
  for (const [, known] of HEADING_BY_KEY) {
    const at = lines.findIndex((line) => headingMatches(line, known))
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


/* ------------------------------- 版本与迁移 ------------------------------- */

/** 读一份文档的 front-matter 版本；缺失或坏值都按 1（最早的那版）。 */
export function docVersion(text) {
  const { fields } = parseFrontMatter(typeof text === "string" ? text : "")
  const raw = fields.puzzle
  const value = Number.parseInt(typeof raw === "string" ? raw : "", 10)
  if (!Number.isFinite(value) || value < 1) return 1
  return value
}

/**
 * 迁移链：每一步把文档从 `from` 版改到 `to` 版。
 *
 * 只在**形状**上动手（front-matter 字段、小节是否存在与顺序），不动用户写的正文；
 * 唯一一处"造内容"是 v1→v2 把旧完成度折算成五维，且只在推导拿不到分时才填。
 * `changes` 里逐条说明改了什么，dry-run 与落盘共用同一份结果。
 */


/** 旧模板的说明行（整行完全一致才替换），迁移时换成当前版的说明。 */
export const OLD_PREAMBLE_LINES = new Set([
  '> 本文件只做检索、坑、原话与三类决策；细节一律在 `模块/` 下。',
  // v3 时代的四节说明。**漏了它是个真 bug**（本项目自己的文档就中招）：那份文档
  // 停在这一行、正文却早就是五节，而迁移认不出它 → 「只有四节」永远挂在文件头上，
  // 与正文自相矛盾。判据是「整行完全一致才替换」，所以旧写法必须**逐条**列全——
  // 少一条，那一版的老文档就永远修不好。
  //
  // v9 起这一行**又是当前写法**了（主文档收敛回四节），所以它同时出现在
  // `PREAMBLE_LINES` 里——两边都列，`stale` 才算得对（见 `migrate.js`）。
  '> 只有四节：模块索引 / 源码索引 / 工具索引 / 坑。决策与轮汇报在 `模块/` 下。',
  '> 项目健康性由模块文档的五维分数汇总得出，不在本文件手写总分。',
  '> 只有五节：模块索引 / 源码索引 / 工具索引 / 坑 / 工作流。决策与轮汇报在 `模块/` 下。',
  '> 每条一句话 + 出处（源码: 文件:行）；查找方向固定为 主文档 → 源码。',
  '> `## 工作流` 约束模型在特定操作下别做别的事（≤5 条，可在面板删除与恢复）。',
  '> `## 工作流` 是**标准化流水线**：一条一个 `### 名字` 块，块内按顺序写步骤（≤5 条 / 每条 ≤12 步）。',
])

/**
 * 模板的说明行（v9 起是三行）。
 *
 * v6 起最后一行曾写明「工作流是流水线」；v9 把工作流整体删掉，那一行随之退场，
 * 并放进 `OLD_PREAMBLE_LINES`，迁移时整行替换——否则老文档会永远留着一句
 * 指向已不存在小节的自述。
 */
export const PREAMBLE_LINES = [
  '> 只有四节：模块索引 / 源码索引 / 工具索引 / 坑。决策与轮汇报在 `模块/` 下。',
  '> 每条一句话 + 出处（源码: 文件:行）；查找方向固定为 主文档 → 源码。',
  '> 项目健康性由模块文档的五维分数汇总得出，不在本文件手写总分。',
]

/**
 * 把正文拆成 `## ` 小节：前导部分 + 标题 → 内容行。
 *
 * 同名小节**合并**而不是丢弃——重复标题是老文档里真实出现过的
 * （手工编辑留下的第二份），丢掉第二份就是静默删内容。
 */


/* --------------------------------- 写入 --------------------------------- */

/** 从 front-matter 里安全读出模块清单（坏 JSON 当空数组）。 */
export function safePlanned(fields) {
  try {
    const parsed = JSON.parse(fields['计划模块'] ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => slugify(item)).filter((item) => item !== null)
  } catch (_error) {
    return []
  }
}

/** 只改主文档的行为字段（模式 / 模块清单），保留其余内容。 */
