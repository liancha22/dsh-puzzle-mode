/**
 * 拼图文档的**批量写入**：一次调用写多处，且**一个文件只读一次、只解析一次、只落盘一次**。
 *
 * ## 为什么必须有这个文件（⑦ 与 ⑧ 的同一个根因）
 *
 * `project.js` 的 `updateMainSection` / `updateModuleSection` 是**一次一节**的：
 * 每写一节就走一遍「读整份文档 → 解析 front-matter → 渲染 → 原子落盘」。
 * 于是写 N 节 = N 次全量往返，而每次往返的代价**随文档规模增长**——
 * 这正是用户说的「全局大脑写大文档慢」：主文档越大，每多写一节的边际成本越高，
 * 而大脑经常一次要落好几条结论。
 *
 * 批量计划把这件事压成：**同一文件的 N 节合并成一次「读→解析→渲染→落盘」**。
 * 文档多大都只付一次解析与一次写盘的钱，多出来的只有内存里的字符串拼接。
 *
 * ## 纯逻辑
 *
 * 不 import Cordis、**不碰盘**：当前正文由调用方用 `ctx.readText` 给（传 `readTextCached`
 * 即可，它自带 mtime 指纹缓存）。于是「分组对不对、合并后文本对不对、上限怎么裁」
 * 都能直接测，不需要起会话、也不需要真的建一个项目。
 *
 * ## 校验是逐条的，不搞连坐
 *
 * 一条错不能丢全部：模型一次写五节，其中一节超字数，另外四节是好的——
 * 把五节全退回去等于让它把好的四节再猜一遍。所以每条错误单独进 `errors`
 * （带 `index` 指回它原文里的位置），其余照写。
 *
 * ## 与 `project.js` 的关系（v9：主文档四节，无工作流）
 *
 * 这里的逐节合并**复刻** `updateMainSection` / `updateModuleSection` 的语义
 * （同一条 `normalizeEntries` 校验、同一套规模档位上限、同一套 front-matter 透传）。
 * 复刻而不是复用的原因：那两个函数把「读」和「写」焊在一起，批量场景下没法只借渲染那半。
 * 若要彻底消掉这份复刻，需要 `project.js` 导出**文本级**的两个纯函数（见 task-2 报告）。
 */
import { join } from 'node:path'
import {
  MAIN_FILE,
  MODULE_DIR,
  MODULE_SECTION_KEYS,
  MODULE_SECTION_HEADINGS,
  HEALTH_HEADING,
  SECTION_KEYS,
  SECTION_HEADINGS,
  SIZE_FIELD,
  DEFAULT_SIZE,
  PUZZLE_VERSION,
  normalizeSize,
  capsOfSize,
  limitsOfSize,
} from './constants.js'
import { slugify, timestamp, clampPercent } from './util.js'
import { puzzleDirOf } from './docfs.js'
import { parseFrontMatter, formatFrontMatter, parseSourceRoot, getSection, withSection, applySection, docVersion, safePlanned } from './frontmatter.js'
import { normalizeEntries, entryLines, entryBody, conflictDigest } from './entries.js'
import { moduleTemplate } from './templates.js'
import { modeOfFields } from './project.js'

/**
 * 单次批量写入最多几节。
 *
 * 为什么要有上限：`writes` 是模型填的数组，它可能一次填五十节。每节都要过一遍
 * 条目校验与字符串拼接，而**没有任何一次写入需要五十节**——真正的批量是
 * 「一个文件的好几节」，不是「把整个文档重写一遍」。超出的部分不静默丢，
 * 逐条进 `errors` 说明「分两次调」。
 */
export const DOCIO_MAX_WRITES = 20

/** 一条写入的形状是否合法（只做**不需要读盘**的那一半校验）。 */
function shapeOf(one) {
  if (one === null || one === undefined || typeof one !== 'object') {
    return { ok: false, error: '这一条不是一个对象', hint: '每条要形如 { target, section, content, name? }' }
  }
  const target = one.target === 'main' ? 'main' : (one.target === 'module' ? 'module' : '')
  if (target === '') {
    return { ok: false, error: 'target 只能是 main 或 module', hint: 'main = 主文档的一节；module = 某个模块文档的一节（要带 name）' }
  }
  const section = typeof one.section === 'string' ? one.section.trim() : ''
  if (section === '') {
    return { ok: false, error: '缺少 section', hint: target === 'main' ? `可用：${[...SECTION_KEYS].join(' / ')}` : `可用：${MODULE_SECTION_KEYS.join(' / ')}` }
  }
  const content = typeof one.content === 'string' ? one.content : ''
  const append = one.append !== false
  if (target === 'main') {
    if (!SECTION_KEYS.has(section)) {
      return { ok: false, error: `未知小节 ${section}`, hint: `可用：${[...SECTION_KEYS].join(' / ')}（主文档只有这几节）` }
    }
    return { ok: true, target, section, name: '', content, append }
  }
  const rawName = typeof one.name === 'string' ? one.name.trim() : ''
  if (rawName === '') {
    return { ok: false, error: 'op target:module 要带 name', hint: '给出模块名，例如 auth-flow' }
  }
  const name = slugify(rawName)
  if (name === null) {
    return { ok: false, error: '模块名不合法', hint: '换一个不含路径符号的名字' }
  }
  if (!MODULE_SECTION_KEYS.includes(section)) {
    return { ok: false, error: `未知模块小节 ${section}`, hint: `可用：${MODULE_SECTION_KEYS.join(' / ')}` }
  }
  return { ok: true, target, section, name, content, append }
}

/**
 * 按**内容**校验一条写入（不读盘）：条目式小节走 `normalizeEntries`，其余原样。
 *
 * 返回 `{ok, normalized, incoming, dropped}` 或 `{ok:false, error, hint}`。
 * `dropped` 只包含「本次写入自己就超了条数上限」的那部分（追加后与旧条目合并再裁
 * 是渲染时的事，那时才有旧条目可看）。
 */
function contentOf(write, sizeLimits, sizeCaps) {
  if (write.target === 'main') {
    // 模块索引指向的是模块文档，所以只限长、不要求出处；其余三节必须能回查源码。
    const requireSource = write.section !== 'index'
    const checked = normalizeEntries(write.content, sizeLimits[write.section], undefined, requireSource)
    if (checked.ok !== true) return { ok: false, error: checked.error, hint: checked.hint }
    return { ok: true, normalized: checked.text, incoming: checked.incoming, dropped: checked.dropped }
  }
  if (write.section === 'progress') {
    // 进度只认数字：正文里出现什么别的都按「抽出来的那个数」写。
    const percent = clampPercent(Number(String(write.content).replace(/[^\d]/g, '')))
    return { ok: true, normalized: `完成度: ${percent}`, incoming: 0, dropped: [] }
  }
  if (write.section === 'health') {
    // 五维只接受已知维度名，其余说明行原样保留在正文里（`healthOf` 自己会过滤）。
    return { ok: true, normalized: write.content, incoming: 0, dropped: [] }
  }
  const checked = normalizeEntries(write.content, sizeLimits[write.section], sizeCaps[write.section])
  if (checked.ok !== true) return { ok: false, error: checked.error, hint: checked.hint }
  return { ok: true, normalized: checked.text, incoming: checked.incoming, dropped: checked.dropped }
}

/** 从「模块索引」那一节的正文里抽模块名（与 `updateMainSection` 同一套正则）。 */
function moduleNamesIn(content, into) {
  for (const line of String(content ?? '').split(/\r?\n/)) {
    const match = /模块\s*[:：]\s*([^\s—\-–]+)/.exec(line) ?? /模块\/([^\s./]+)\.md/.exec(line)
    if (match === null) continue
    const name = slugify(match[1])
    if (name !== null && !into.includes(name)) into.push(name)
  }
  return into
}

/**
 * 渲染**一个文件**的全部写入（纯函数，不碰盘）。
 *
 * 调用方给的是「当前正文」（`text`，主文档必给；模块文档可以是 `null` = 还不存在）
 * 与已经校验过的 `writes`，这里按顺序在**内存里**逐节应用，最后交出整份新正文。
 * 一次调用 = 一次解析 = 一份新正文 = 调用方一次落盘。
 */
export function renderGroup(group, ctx) {
  const c = ctx !== null && ctx !== undefined ? ctx : {}
  const size = normalizeSize(c.size) ?? DEFAULT_SIZE
  const sizeCaps = capsOfSize(size)
  const sizeLimits = limitsOfSize(size)

  if (group.target === 'module') {
    // 「新建」的判据与 `updateModuleSection` 一致：**文件读不出来**才算新建（空文件不算）。
    const created = typeof group.text !== 'string'
    let text = created ? moduleTemplate(group.name) : group.text
    const out = []
    for (const write of group.writes) {
      if (write.section === 'progress') {
        text = applySection(text, MODULE_SECTION_HEADINGS.progress, write.normalized, false)
        out.push({ section: write.section, entries: 0, dropped: [] })
        continue
      }
      if (write.section === 'health') {
        text = applySection(text, HEALTH_HEADING, write.normalized, write.append)
        out.push({ section: write.section, entries: 0, dropped: [] })
        continue
      }
      /**
       * ③ 决策类小节在**改写之前**读现有条目：只对「悬而未决 / 已定」做。
       * 批量下这个「之前」是**逐条**的——第二条写入看到的旧条目已经含第一条写进去的，
       * 与「连着调两次单节写入」看到的东西完全一致（否则批量与单节的语义就分家了）。
       */
      let conflicts = null
      if (write.section === 'pending' || write.section === 'decided') {
        const before = entryLines(getSection(parseFrontMatter(text).body, MODULE_SECTION_HEADINGS[write.section]) ?? '')
          .map((line) => entryBody(line))
        conflicts = conflictDigest(write.section, before, entryLines(write.content).map((line) => entryBody(line)), sizeCaps[write.section])
      }
      const merged = applySection(text, MODULE_SECTION_HEADINGS[write.section], write.normalized, write.append)
      const cap = sizeCaps[write.section]
      let dropped = write.dropped
      if (cap === undefined || cap === null) {
        text = merged
      } else {
        // 条数上限是硬规则：先按 append 合并新旧，再整体裁到末尾 N 条（最旧的先删）。
        const all = entryLines(getSection(parseFrontMatter(merged).body, MODULE_SECTION_HEADINGS[write.section]) ?? '')
        const overflow = all.length > cap ? all.slice(0, all.length - cap) : []
        if (overflow.length > 0) {
          dropped = overflow
          text = withSection(merged, MODULE_SECTION_HEADINGS[write.section], all.slice(all.length - cap).join('\n'))
        } else {
          text = merged
        }
      }
      out.push({ section: write.section, entries: write.incoming, dropped, ...conflicts === null ? {} : { conflicts } })
    }
    return { ok: true, file: group.file, target: group.target, name: group.name, created, text, writes: out }
  }

  // ---- 主文档：正文逐节应用，最后**整份重写一次 front-matter** ----
  const { fields, body } = parseFrontMatter(group.text)
  let nextBody = body
  const out = []
  for (const write of group.writes) {
    nextBody = applySection(nextBody, SECTION_HEADINGS[write.section], write.normalized, write.append)
    out.push({ section: write.section, entries: write.incoming, dropped: [] })
  }
  /**
   * 「坑」是唯一按规模限条数的主文档小节（小 10 / 中·大 不限），超了删最旧。
   *
   * ⚠️ **只有这一批真的写了 `pit` 才裁**：单节路径里这个上限挂在
   * 「section === 'pit'」那个分支下，写 `source` 时一次都不碰坑。
   * 批量下如果无条件裁，就会出现「只写源码索引、却把超过 10 条的坑删掉」——
   * 那是**静默删数据**，而且单节路径从来不会这么干。
   */
  const wrotePit = group.writes.some((one) => one.section === 'pit')
  const pitCap = sizeCaps.pit
  if (wrotePit && pitCap !== undefined && pitCap !== null) {
    const all = entryLines(getSection(nextBody, SECTION_HEADINGS.pit) ?? '')
    if (all.length > pitCap) {
      const overflow = all.slice(0, all.length - pitCap)
      nextBody = withSection(nextBody, SECTION_HEADINGS.pit, all.slice(all.length - pitCap).join('\n'))
      for (const one of out) if (one.section === 'pit') one.dropped = overflow
    }
  }
  /**
   * 模块清单（front-matter 的 `计划模块:`）要跟着走：
   *   - 「模块索引」小节里出现过的名字同步进去（UI 的图块据此建出来）；
   *   - 这次**新写的模块文档**也补进去——这一步在单节路径里是
   *     `updateModuleSection` 写完模块文档后回头再改一次主文档，
   *     批量下它被并进主文档这**同一次**渲染，省掉一整次主文档往返。
   * 只增不减（与单节路径一致）：覆盖写索引也不会把模块从清单里摘掉。
   */
  const names = []
  for (const write of group.writes) {
    if (write.section === 'index') moduleNamesIn(write.content, names)
  }
  const registered = Array.isArray(group.registerModules) ? group.registerModules : []
  const carried = safePlanned(fields)
  const planned = names.length > 0 || registered.length > 0
    ? [...new Set([...carried, ...names, ...registered])]
    : null
  const next = [
    formatFrontMatter({
      puzzle: PUZZLE_VERSION,
      project: fields['项目'] ?? c.project ?? '',
      mode: modeOfFields(fields, docVersion(group.text)),
      modules: planned ?? carried,
      sourceRoot: parseSourceRoot(fields),
      // ⚠️ 规模档位必须透传：漏一次，`规模: 大` 就被抹成默认「中」→ 下次上限更严
      // → **超出的条目在下一次写入被静默删除**（这是本仓记过的真丢数据 bug）。
      size: fields[SIZE_FIELD],
      updated: timestamp(),
    }),
    nextBody.replace(/^\n+/, ''),
  ].join('\n')
  return { ok: true, file: group.file, target: group.target, name: '', created: false, text: next, writes: out }
}

/**
 * **批量写入计划**：分组 + 逐条校验 + 渲染。
 *
 * ## 一次调用读几个文件
 *
 * 每个**目标文件**只读一次（两个模块各写两节 = 2 次读，不是 4 次）；模块写入还要
 * 读一次主文档取规模档位（与 `sizeOfProject` 同一条规则），而它若同时也是目标，
 * 就**共用那一份已读文本**——不会为「取档位」再读一遍。
 *
 * @param {Array} ops 形如 `[{ target:'main'|'module', section, name?, content, append? }]`
 * @param {object} ctx `{ projectRoot, project, readText(file) -> string|null }`
 *   `readText` 传 `docfs.js` 的 `readTextCached`：它按 `mtimeMs + size` 指纹缓存，
 *   同一批里重复的路径不会真的再读一次盘。
 * @returns {{ok:boolean, groups:Array, errors:Array}} `groups` 里每项含
 *   `{ file, target, name, text（原正文）, next（渲染后的新正文）, writes:[…] }`；
 *   调用方对每个 group 做**一次** `atomicWrite(group.file, group.next)` 即可。
 */
export function planWrites(ops, ctx) {
  const c = ctx !== null && ctx !== undefined ? ctx : {}
  const list = Array.isArray(ops) ? ops : []
  const projectRoot = typeof c.projectRoot === 'string' ? c.projectRoot : ''
  const project = typeof c.project === 'string' ? c.project : ''
  const readText = typeof c.readText === 'function' ? c.readText : null
  const errors = []
  const puzzleDir = puzzleDirOf(projectRoot, project)
  if (puzzleDir === null) {
    return { ok: false, groups: [], errors: [{ index: -1, target: '', section: '', error: '项目名不合法', hint: '检查项目名' }] }
  }
  if (list.length === 0) {
    return { ok: false, groups: [], errors: [{ index: -1, target: '', section: '', error: '没有要写的节', hint: 'writes 是一个数组，每项形如 { target, section, content, name? }' }] }
  }

  // ---- ① 形状校验（不读盘）：能判的先判掉，读盘只为真正要写的文件付 ----
  const shaped = []
  for (let at = 0; at < list.length; at += 1) {
    if (at >= DOCIO_MAX_WRITES) {
      errors.push({ index: at, target: '', section: '', error: `单次最多写 ${DOCIO_MAX_WRITES} 节`, hint: '把这一批拆成两次调用；同一个文件的多节仍然只解析一次。' })
      continue
    }
    const one = shapeOf(list[at])
    if (one.ok !== true) {
      errors.push({ index: at, target: '', section: '', error: one.error, hint: one.hint })
      continue
    }
    shaped.push({ index: at, ...one })
  }
  if (shaped.length === 0) return { ok: false, groups: [], errors }

  // ---- ② 每个目标文件只读一次 ----
  const mainDoc = join(puzzleDir, MAIN_FILE)
  const fileOf = (write) => write.target === 'main' ? mainDoc : join(puzzleDir, MODULE_DIR, `${write.name}.md`)
  const wanted = new Map()
  for (const write of shaped) {
    const file = fileOf(write)
    if (!wanted.has(file)) wanted.set(file, write)
  }
  // 模块写入要主文档的 `规模:` 才能定上限；主文档若已是目标就共用这份文本。
  if (!wanted.has(mainDoc) && shaped.some((write) => write.target === 'module')) wanted.set(mainDoc, null)
  const texts = new Map()
  if (readText !== null) {
    for (const file of wanted.keys()) texts.set(file, readText(file))
  } else {
    for (const file of wanted.keys()) texts.set(file, null)
  }
  const mainText = texts.get(mainDoc)
  const size = typeof mainText === 'string' && mainText !== ''
    ? (normalizeSize(parseFrontMatter(mainText).fields[SIZE_FIELD]) ?? DEFAULT_SIZE)
    : DEFAULT_SIZE
  const sizeCaps = capsOfSize(size)
  const sizeLimits = limitsOfSize(size)

  // ---- ③ 逐条内容校验：一条错只丢那一条 ----
  const accepted = []
  for (const write of shaped) {
    if (write.target === 'main' && (typeof mainText !== 'string' || mainText === '')) {
      errors.push({ index: write.index, target: 'main', section: write.section, error: '主文档读不出来（项目可能还没建）', hint: '先执行 op:init；或检查文件权限。' })
      continue
    }
    const checked = contentOf(write, sizeLimits, sizeCaps)
    if (checked.ok !== true) {
      errors.push({ index: write.index, target: write.target, section: write.section, error: checked.error, hint: checked.hint })
      continue
    }
    accepted.push({ ...write, normalized: checked.normalized, incoming: checked.incoming, dropped: checked.dropped })
  }
  if (accepted.length === 0) return { ok: false, groups: [], errors }

  // ---- ④ 按目标文件分组（同一文件的 N 节 → 一个 group = 一次读解析渲染落盘）----
  const groups = []
  const byFile = new Map()
  for (const write of accepted) {
    const file = fileOf(write)
    let group = byFile.get(file)
    if (group === undefined) {
      group = {
        file,
        target: write.target,
        name: write.target === 'module' ? write.name : '',
        text: texts.get(file),
        writes: [],
      }
      byFile.set(file, group)
      groups.push(group)
    }
    group.writes.push(write)
  }

  /**
   * 新写的模块要补进主文档的 `计划模块:`。单节路径下这是「写完模块文档再回头改主文档」，
   * 批量下并进主文档那一次渲染；主文档**不在**这一批里时才为它单独开一个 group
   * （仍然只有一次主文档往返，与模块个数无关）。
   */
  const planned = typeof mainText === 'string' && mainText !== '' ? safePlanned(parseFrontMatter(mainText).fields) : []
  const fresh = []
  for (const group of groups) {
    if (group.target !== 'module') continue
    if (!planned.includes(group.name) && !fresh.includes(group.name)) fresh.push(group.name)
  }
  if (fresh.length > 0) {
    const existing = byFile.get(mainDoc)
    if (existing !== undefined) existing.registerModules = fresh
    else {
      const group = { file: mainDoc, target: 'main', name: '', text: mainText, writes: [], registerModules: fresh }
      byFile.set(mainDoc, group)
      groups.push(group)
    }
  }

  // ---- ⑤ 渲染：每个 group 一次，交出可直接落盘的整份正文 ----
  const rendered = groups.map((group) => {
    const done = renderGroup(group, { project, size })
    return {
      file: group.file,
      target: group.target,
      name: group.name,
      text: group.text,
      next: done.text,
      created: done.created,
      writes: done.writes,
      ...Array.isArray(group.registerModules) ? { registerModules: group.registerModules } : {},
    }
  })
  return { ok: true, groups: rendered, errors }
}

/**
 * 给人看的写入摘要（纯函数）。
 *
 * 存在的理由：一次批量写多处之后，「到底写了几个文件、哪几条被拒」不能只留在
 * 结构化返回里——模型读摘要比读 JSON 数组快，而且**被拒的那几条**必须显眼，
 * 否则它会以为全都写进去了。
 */
export function describePlan(plan) {
  const p = plan !== null && plan !== undefined ? plan : {}
  const groups = Array.isArray(p.groups) ? p.groups : []
  const errors = Array.isArray(p.errors) ? p.errors : []
  const total = groups.reduce((sum, group) => sum + group.writes.length, 0)
  const lines = []
  if (groups.length === 0) {
    lines.push('没有可写入的节。')
  } else {
    lines.push(`${total} 节写入 → ${groups.length} 个文件（每文件一次读、一次解析、一次落盘）`)
    const where = groups.map((group) => {
      if (group.target === 'main') {
        return group.writes.length === 0 ? '主文档（只补模块清单）' : `主文档（${group.writes.map((one) => one.section).join('/')}）`
      }
      return `模块 ${group.name}（${group.writes.map((one) => one.section).join('/')}）`
    })
    lines.push('落点：' + where.join('、'))
  }
  if (errors.length > 0) {
    lines.push(`${errors.length} 条被拒：` + errors.map((one) => `#${one.index} ${one.error}`).join('；'))
  }
  return lines.join('\n')
}
