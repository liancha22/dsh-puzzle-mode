/**
 * 澄清器：**固定纪律 + 专属检索工具**。
 *
 * 用户拍板两条：① 纪律走**子会话的 systemPrompt 注入**（不是并进用户消息）；
 * ② 新写一个**专属检索工具**，让它一条命令拿到「主文档 / 模块 / 命中行」，
 * 而不是自己去自由 grep。
 *
 * ## 两件事写在一个文件里
 *
 * 它们共用同一个前提：**agent 的 scoped ctx**。`agent.ctx.systemPrompt` 与
 * `agent.ctx.tools` 是同一个作用域上的两个口子，注册进它只影响这个子会话，
 * 对父会话与兄弟会话不可见（先例：`dsh-experimental-tool-agent-team` 的 `install()`、
 * `dsh-subagent` 的 `applyChildComposition()`）。分成两个文件会让「注册进哪个 scope」
 * 出现两份，迟早漂移。
 *
 * ## 检索是纯函数，注入才有副作用
 *
 * `clarifierLookup` 不碰盘、不碰 Cordis：给它输入与一份 source，它给文本——于是
 * 「命中怎么裁、关键词怎么匹配」能被直接测，不需要起会话。`installClarifier` 才碰 agent，
 * 且**任何一步失败都不抛错**，返回 `{ok:false, reason}` 由调用方决定退回哪条路。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CLARIFIER_SYSTEM } from './dispatch.js'

/** 专属检索工具名。**不是 `puzzle_mode`**：那个是全局文档工具，这个是澄清器的窄口子。 */
export const CLARIFIER_TOOL_NAME = 'puzzle_context'

/**
 * 注入用的 systemPrompt section 名与序号。
 *
 * 序号取 `10130`：紧挨本插件自己的提示段（`10120`），但**不是同一个号**——
 * 同号时宿主按段名比较来决定顺序，那是给「协商」用的，这里要的是确定的一条。
 */
export const CLARIFIER_SECTION_NAME = 'puzzle-mode:clarifier'

export const CLARIFIER_SECTION_ORDER = 10130

/** 一次检索最多返回多少条命中。超了截断并**明说截断了**，不让它以为这就是全部。 */
export const LOOKUP_MAX_HITS = 40

/** 一条命中行的最大长度（代码行可能很长，截断避免一次吐回整份文件）。 */
export const LOOKUP_LINE_MAX = 200

/**
 * 一次调用最多读几份模块文档 / 搜几个检索词。
 *
 * 为什么必须有上限：`names` / `queries` 是**模型填的数组**，它可能一口气填 30 个名字。
 * 一份模块文档几百到几千字，30 份就是一次把上下文塞满——那不是用户要的「一次读多处」，
 * 是把会话撑爆。超出的部分**不静默丢**：返回里点名「哪几个没读」。
 */
export const LOOKUP_MAX_NAMES = 8
export const LOOKUP_MAX_QUERIES = 6

/** 一批模块文档的**总字数**上限；到顶后剩下的不读，并在返回里说明。 */
export const LOOKUP_MAX_DOC_CHARS = 40000

/** 一批检索的**总命中条数**上限（每个检索词各自还有 `LOOKUP_MAX_HITS`）。 */
export const LOOKUP_MAX_TOTAL_HITS = 120

/**
 * `source` 上的字段可能是**值**也可能是**函数**（thunk）。
 *
 * 为什么允许 thunk：`code` 那一项要把源码全读一遍，而绝大多数调用是 `op:'main'`。
 * 传数组就等于每次调用都读全量代码；传 thunk 就只有真要检索时才读。
 * 纯函数仍然纯——thunk 由调用方给，本文件不碰盘。
 */
function resolveField(value) {
  return typeof value === 'function' ? value() : value
}

/**
 * 把「复数数组 + 旧单数」合成一份待办列表（去重、去空）。
 *
 * ## 为什么两个都要认
 *
 * `names` / `queries` 是这次新加的批量参数，而 `name` / `query` 是**已经在用**的老参数
 * （面板提示词、老会话、既有调用都按它写）。只认新的就等于把老调用打回「参数不全」，
 * 那是兼容性事故。两者都给就并成一批，重复的只做一次。
 *
 * 复数传一个 = 单数：所以下面的单数形状返回分支只按「解析后有几个」判，不按「传的是哪个字段」判。
 */
function stringList(rawList, rawSingle) {
  const out = []
  if (Array.isArray(rawList)) {
    for (const one of rawList) {
      if (typeof one !== 'string') continue
      const text = one.trim()
      if (text !== '' && !out.includes(text)) out.push(text)
    }
  }
  if (typeof rawSingle === 'string') {
    const text = rawSingle.trim()
    if (text !== '' && !out.includes(text)) out.push(text)
  }
  return out
}

/** 把一份 `[{file, text}]` 按关键词过滤成命中行。大小写不敏感。 */
function grepFiles(files, query, limit) {
  const list = Array.isArray(files) ? files : []
  const needle = query.toLowerCase()
  const hits = []
  let truncated = false
  for (const one of list) {
    if (one === null || one === undefined || typeof one.text !== 'string') continue
    const lines = one.text.split('\n')
    for (let at = 0; at < lines.length; at += 1) {
      if (!lines[at].toLowerCase().includes(needle)) continue
      if (hits.length >= limit) {
        truncated = true
        break
      }
      const body = lines[at].trim()
      hits.push(`${one.file}:${at + 1}: ${body.length > LOOKUP_LINE_MAX ? body.slice(0, LOOKUP_LINE_MAX) + '…' : body}`)
    }
    if (truncated) break
  }
  return { hits, truncated }
}

/**
 * 多个检索词扫**同一份**文件列表。
 *
 * 为什么把它和 `grepFiles` 分开：`files` 由调用方给，取它可能是 thunk（`code` 要把源码
 * 递归读一遍）。一次调用搜 3 个词就取 3 次源码是**纯浪费**——所以这里在循环外取一次，
 * 这也是「一次多处 + 提速」在这一侧的那一半。
 *
 * 每个词各自受 `limit` 约束，整批再受 `totalCap` 约束：到顶后剩下的词**明说没搜**，
 * 而不是让模型以为「搜过了，没有」。
 */
function grepFilesMulti(files, queries, limit, totalCap) {
  const list = Array.isArray(files) ? files : []
  const sections = []
  const skipped = []
  let total = 0
  let truncated = false
  for (const query of queries) {
    if (total >= totalCap) {
      skipped.push(query)
      continue
    }
    const found = grepFiles(list, query, Math.min(limit, totalCap - total))
    total += found.hits.length
    if (found.truncated) truncated = true
    sections.push({ query, hits: found.hits, truncated: found.truncated })
  }
  return { sections, skipped, total, truncated }
}

/** 渲染一批检索结果：一个词一段，段头点名是哪个词。 */
function searchText(sections, where, limit) {
  const blocks = []
  for (const one of sections) {
    if (one.hits.length === 0) {
      blocks.push(`## 「${one.query}」\n（${where}里没有一行命中「${one.query}」。）`)
      continue
    }
    const body = one.hits.join('\n')
    blocks.push(`## 「${one.query}」\n${body}${one.truncated ? `\n…（只给前 ${limit} 条，还有更多命中；把 query 写细一点。）` : ''}`)
  }
  return blocks.join('\n\n')
}

/**
 * **澄清器的专属检索**（纯函数）。
 *
 * 五种 op 对应它真正会做的五件事：
 *   - `main`    主文档全文——那是「这个项目已经定了什么」的先验；
 *   - `modules` 模块索引——模块 → 一句话职责 → 文件；
 *   - `module`  某些模块的正文（`names` 数组，或旧的单个 `name`）；
 *   - `search`  在**拼图文档**里搜关键词（`queries` 数组，或旧的单个 `query`）；
 *   - `code`    在**源码**里搜关键词（同上）——只查「这个改动碰到什么」。
 *
 * 参数不全时**报错并给下一步**，不返回空文本：空文本会让模型以为「查过了，没有」。
 *
 * ## 只取该 op 需要的 thunk（⑥ 提速的那一半）
 *
 * `source` 上的每一项都可能是一次全量读盘（`modules` 要循环读全部模块文档，
 * `code` 要递归读源码，`docs` 要连主文档一起读）。所以每个 op **只取自己那一项**：
 * `op:main` 一个都不多取，`op:module` 不取 `docs`，`op:search` 不取 `modules`。
 * 早先的写法是把整个 source 当值用，取数口一次就把全部文档读进内存——文档越大越慢，
 * 而 `op:main` 根本用不上它们。
 *
 * ## 批量读的总量上限
 *
 * `names` / `queries` 由模型填，可能一次填很多。超上限的部分**不静默丢**：
 * 返回里点名「哪几个没读」，并让模型知道要分次调。
 */
export function clarifierLookup(input, source) {
  const i = input !== null && input !== undefined ? input : {}
  const s = source !== null && source !== undefined ? source : {}
  const op = typeof i.op === 'string' ? i.op : ''
  const rawLimit = Number.isSafeInteger(i.limit) && i.limit > 0 ? i.limit : LOOKUP_MAX_HITS
  const limit = Math.min(rawLimit, LOOKUP_MAX_HITS)

  if (op === 'main') {
    const text = resolveField(s.mainDoc)
    return { ok: true, op, title: '主文档全文', text: typeof text === 'string' && text !== '' ? text : '（主文档是空的——这个项目还没写任何已定事实。）' }
  }
  if (op === 'modules') {
    const text = resolveField(s.moduleIndex)
    return { ok: true, op, title: '模块索引', text: typeof text === 'string' && text !== '' ? text : '（模块索引是空的——主文档还没写「模块索引」一节。）' }
  }
  if (op === 'module') {
    const names = stringList(i.names, i.name)
    if (names.length === 0) return { ok: false, error: 'op:module 要带 name（或 names 数组）', hint: '先用 op:modules 看有哪些模块，名字要与索引里完全一致。' }
    /**
     * ## 取数口：优先**按名字逐个取**，退而求其次才取整张表
     *
     * `s.moduleOf(name)` 是「读**这一个**模块」的口子——取数口有它就只读被点名的那些文件，
     * 取 1 个模块就真的只读 1 个（这是 ⑥ 提速的关键：`s.modules()` 一旦被调，
     * 取数口就得把**全部**模块文档读进来建表，文档越多越慢，而这里根本用不上其余 N 份）。
     *
     * 没有 `moduleOf` 才退回 `s.modules()`：那是兼容老取数口的退路，不是首选。
     */
    const oneOf = typeof s.moduleOf === 'function' ? s.moduleOf : null
    const modules = oneOf === null ? resolveField(s.modules) : null
    const table = modules !== null && modules !== undefined && typeof modules === 'object' ? modules : {}
    const namesOfTable = () => oneOf === null
      ? (Object.keys(table).join('、') || '（一个都没有）')
      : '（这个取数口不提供模块清单，先用 op:modules 看索引）'
    const picked = names.slice(0, LOOKUP_MAX_NAMES)
    const skipped = names.slice(LOOKUP_MAX_NAMES)
    const blocks = []
    const missing = []
    let chars = 0
    const truncated = []
    for (const name of picked) {
      const text = oneOf === null ? table[name] : oneOf(name)
      if (typeof text !== 'string' || text === '') {
        missing.push(name)
        continue
      }
      // 总量上限：到顶后剩下的**不读**，并在返回里点名——不假装给全了。
      if (chars + text.length > LOOKUP_MAX_DOC_CHARS && blocks.length > 0) {
        truncated.push(name)
        continue
      }
      chars += text.length
      blocks.push({ name, text })
    }
    if (blocks.length === 0) {
      // 一个都没读到：把「没有这个模块」与「有名字但读不出来」分开说，可用名单照旧给全。
      if (missing.length === 0 && truncated.length === 0) {
        return { ok: false, error: '没有这个模块：' + picked.join('、'), hint: '可用：' + namesOfTable() }
      }
      const parts = []
      if (missing.length > 0) parts.push('没有这些模块：' + missing.join('、'))
      if (truncated.length > 0) parts.push('这些没读（单次总量上限）：' + truncated.join('、'))
      return { ok: false, error: parts.join('；'), hint: '可用：' + namesOfTable() }
    }
    /**
     * **恰好一份且没有别的要说时，返回形状与旧的单数调用逐字一致**——
     * `text` 就是那份模块文档的正文，不带任何本文件加的段头。
     * 这是向后兼容的硬要求：老调用方（面板提示词、老会话）拿到的是纯正文，
     * 多一个 `## 名字` 段头就可能被它们当正文的一部分再写回文档。
     * 所以段头只在**真的读了两份以上**（或有缺失/截断要说明）时出现。
     * 正文直接取循环里已经拿到的那一份，**不再去取数口要第二遍**。
     */
    if (blocks.length === 1 && missing.length === 0 && truncated.length === 0 && skipped.length === 0) {
      return { ok: true, op, title: '模块文档：' + blocks[0].name, text: blocks[0].text, read: 1 }
    }
    const title = `模块文档（${blocks.length} 份）`
    const notes = []
    if (missing.length > 0) notes.push(`没有这些模块：${missing.join('、')}`)
    if (truncated.length > 0) notes.push(`这些没读（单次总量上限 ${LOOKUP_MAX_DOC_CHARS} 字）：${truncated.join('、')}——再调一次只取它们`)
    if (skipped.length > 0) notes.push(`超出单次 ${LOOKUP_MAX_NAMES} 份上限、没读的：${skipped.join('、')}——再调一次只取它们`)
    const text = blocks.map((one) => `## ${one.name}\n\n${one.text}`).join('\n\n---\n\n') + (notes.length > 0 ? `\n\n…（${notes.join('；')}）` : '')
    return {
      ok: true,
      op,
      title,
      text,
      read: blocks.length,
      ...missing.length > 0 ? { missing } : {},
      ...truncated.length + skipped.length > 0 ? { skipped: [...truncated, ...skipped] } : {},
    }
  }
  if (op === 'search' || op === 'code') {
    const queries = stringList(i.queries, i.query)
    if (queries.length === 0) return { ok: false, error: op + ' 要带 query（或 queries 数组）', hint: '给一个检索词：函数名 / 文件名 / 一句短语。' }
    /**
     * 没配代码根时**明说没配**，不要返回「没有一行命中」——
     * 后者会被读成「我查过了，代码里没有这件事」，而事实是**根本没查**。
     */
    if (op === 'code' && s.codeAvailable === false) {
      return { ok: false, error: '没配代码根，查不了源码', hint: '主文档的「源码根」还没记，或它指的目录不存在。只按文档澄清即可。' }
    }
    // 只在真搜的时候取那一项：`op:search` 不碰源码，`op:code` 不碰文档正文。
    const files = resolveField(op === 'search' ? s.docs : s.code)
    const where = op === 'search' ? '拼图文档' : '源码'
    const asked = queries.slice(0, LOOKUP_MAX_QUERIES)
    const overQueries = queries.slice(LOOKUP_MAX_QUERIES)
    const found = grepFilesMulti(files, asked, limit, LOOKUP_MAX_TOTAL_HITS)
    /**
     * **只有一个检索词、也没有截断要说明时，返回形状与旧的单数调用逐字一致**：
     * `text` 就是命中行本身，**不加 `## 「词」` 段头**。
     * 段头是批量才需要的东西（用来区分是哪个词的那一段）；老调用方拿到的是裸命中行，
     * 平白多一行 markdown 标题会改变它们的解析结果。所以段头只在**真的搜了两个以上**时出现。
     */
    if (asked.length === 1 && overQueries.length === 0 && found.skipped.length === 0) {
      const one = found.sections[0]
      if (one.hits.length === 0) {
        return { ok: true, op, title: `在${where}里搜「${asked[0]}」`, text: `（${where}里没有一行命中「${asked[0]}」。）` }
      }
      return {
        ok: true,
        op,
        title: `在${where}里搜「${asked[0]}」`,
        text: one.hits.join('\n') + (one.truncated ? `\n…（只给前 ${limit} 条，还有更多命中；把 query 写细一点。）` : ''),
        hits: one.hits.length,
        truncated: one.truncated,
      }
    }
    const notes = []
    if (found.skipped.length > 0) notes.push(`这些词没搜（单次总命中上限 ${LOOKUP_MAX_TOTAL_HITS} 条）：${found.skipped.join('、')}`)
    if (overQueries.length > 0) notes.push(`超出单次 ${LOOKUP_MAX_QUERIES} 个词上限、没搜的：${overQueries.join('、')}——再调一次只搜它们`)
    const tail = notes.length > 0 ? `\n\n…（${notes.join('；')}）` : ''
    return {
      ok: true,
      op,
      title: `在${where}里搜 ${asked.length} 个词`,
      text: searchText(found.sections, where, limit) + tail,
      hits: found.total,
      truncated: found.truncated,
      ...overQueries.length + found.skipped.length > 0 ? { skipped: [...found.skipped, ...overQueries] } : {},
    }
  }
  return { ok: false, error: '未知 op：' + String(op), hint: '可用：main / modules / module / search / code' }
}

/** 工具描述：写清「什么时候用哪一个 op」，否则模型会拿 main 当万能答案。 */
const CLARIFIER_TOOL_DESCRIPTION = [
  '澄清器的专属检索：一条命令拿到这个项目**已经定了什么**，不用自己去自由 grep。',
  'op=main 取主文档全文（先读它，那是已定事实的先验）；',
  'op=modules 取模块索引（模块 → 一句话职责 → 文件）；',
  'op=module 并给 names 取那几份模块文档的正文（一次多份；旧的 name 单数也认）；',
  'op=search 并给 queries 在拼图文档里搜命中行（一次多个词，各给一段；旧的 query 单数也认）；',
  'op=code 并给 queries 在源码里搜命中行（只查「这个改动会碰到什么」，不要通读）。',
  '一次能取多处就一次取完——别为同一件事连调三次；但单次有总量上限，超了返回里会点名哪些没读。',
  '文档可能已被改过，而你记得的版本可能过期——拿不准就重新调一次。',
].join('')

/**
 * 把工作指引、文档段与专属工具**注册进这个子会话的作用域**。
 *
 * ## 为什么失败不抛错
 *
 * 这台部署的 agent 未必带 `ctx.systemPrompt` / `ctx.tools`（不同版本、不同预设）。
 * 抛错会把「澄清会话已经建好了」这件事一起炸掉，用户看到的是失败、磁盘上却有个会话。
 * 所以这里如实返回 `{ok:false, reason}`，由调用方降级——降级也要说清走的是哪条路。
 *
 * ## 顺序
 *
 * 先注册 section 再注册工具：section 失败就整个降级（纪律是重点），
 * 工具失败只降工具那一半（`tool:false`），纪律仍然到位。
 *
 * ## `docSection`（v2.2.0）
 *
 * 澄清器是从全局大脑 `fork` 出来的，而 `fork` **只继承事件日志、不继承
 * systemPrompt 段**（段是每个 agent 作用域各自注册的）。所以调用方要把
 * 「这个项目的文档」那一段**再注入一次**，否则澄清器只剩对话历史、
 * 没有那份「项目已定什么」的事实——而它正是澄清的依据。
 *
 * 没给 `docSection` 就不注册（老路径：文档内联在首轮消息里）。
 */
export function installClarifier(agent, options) {
  const o = options !== null && options !== undefined ? options : {}
  const ctx = agent !== null && agent !== undefined ? agent.ctx : undefined
  const prompt = ctx !== null && ctx !== undefined ? ctx.systemPrompt : undefined
  if (prompt === null || prompt === undefined || typeof prompt.section !== 'function') {
    return { ok: false, reason: '这个会话拿不到 agent 作用域的 systemPrompt，固定纪律注入不进去' }
  }
  try {
    prompt.section({
      name: CLARIFIER_SECTION_NAME,
      order: CLARIFIER_SECTION_ORDER,
      text: typeof o.system === 'string' && o.system !== '' ? o.system : CLARIFIER_SYSTEM,
    })
  } catch (error) {
    const raw = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
    return { ok: false, reason: '注册固定纪律失败：' + raw }
  }

  /**
   * 文档段：**注入失败只降这一段**（`doc:false`），纪律与工具照旧。
   * 与大脑那个段同名同序，所以两边的文本结构永远一致。
   */
  let doc = false
  let docReason = ''
  const section = o.docSection
  if (section !== null && section !== undefined && typeof section.text === 'string') {
    try {
      prompt.section({ name: section.name, order: section.order, text: section.text })
      doc = true
    } catch (error) {
      docReason = '注册文档段失败：' + (error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error))
    }
  }

  const tools = ctx !== null && ctx !== undefined ? ctx.tools : undefined
  if (tools === null || tools === undefined || typeof tools.register !== 'function') {
    return { ok: true, section: true, tool: false, reason: '这个会话拿不到 agent 作用域的 tools，专属检索工具没装上（纪律已到位）' }
  }
  const lookup = o.lookup
  if (typeof lookup !== 'function') {
    return { ok: true, section: true, doc, docReason, tool: false, reason: '没给 lookup，专属检索工具没装上（纪律已到位）' }
  }
  try {
    tools.register(defineTool({
      name: CLARIFIER_TOOL_NAME,
      description: CLARIFIER_TOOL_DESCRIPTION,
      parameters: {
        op: {
          type: 'string',
          required: true,
          enum: ['main', 'modules', 'module', 'search', 'code'],
          description: 'main 主文档全文 / modules 模块索引 / module 某些模块（给 names）/ search 搜拼图文档（给 queries）/ code 搜源码（给 queries）',
        },
        name: { type: 'string', description: 'op:module 时的**单个**模块名（旧写法，仍可用）；要一次读多份就用 names' },
        names: {
          type: 'array',
          items: { type: 'string' },
          description: `op:module 时的模块名列表，一次读多份（单次最多 ${LOOKUP_MAX_NAMES} 份）；名字要与模块索引里完全一致`,
        },
        query: { type: 'string', description: 'op:search / op:code 时的**单个**检索词（旧写法，仍可用）；要一次搜多个词就用 queries' },
        queries: {
          type: 'array',
          items: { type: 'string' },
          description: `op:search / op:code 时的检索词列表，一次搜多个（单次最多 ${LOOKUP_MAX_QUERIES} 个词），返回里一个词一段`,
        },
        limit: { type: 'number', description: `每个检索词最多返回多少条命中；默认与上限都是 ${LOOKUP_MAX_HITS}` },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(args) {
        return clarifierLookup(args, typeof lookup === 'function' ? lookup() : {})
      },
    }))
  } catch (error) {
    const raw = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
    return { ok: true, section: true, doc, docReason, tool: false, reason: '注册专属检索工具失败：' + raw }
  }
  return { ok: true, section: true, doc, docReason, tool: true, toolName: CLARIFIER_TOOL_NAME }
}
