/**
 * 文档格式迁移与重建：只改形状，正文一字不动。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */
import { join } from 'node:path'
import { MAIN_FILE, MODULE_DIR, DEFAULT_MODE, MODE_PUZZLE_WRITE, MODE_PUZZLE_AFTER, SESSION_FIELD, CURRENT_SESSION_FIELD, PUZZLE_VERSION, MODE_RENAME_VERSION, normalizeMode, PROGRESS_TO_HEALTH, HEALTH_HEADING, SECTION_ORDER, SECTION_HEADINGS, RELATED_HEADING, MODULE_SECTION_HEADINGS, MODULE_SECTION_ORDER, ENTRY_CAPS } from './constants.js'
import { listFiles, isFile, clampPercent, slugify, timestamp } from './util.js'
import { safeJoin, puzzleDirOf, atomicWrite, readText } from './docfs.js'
import { formatFrontMatter, parseFrontMatter, parseSourceRoot, docVersion, headingMatches, OLD_PREAMBLE_LINES, PREAMBLE_LINES, safePlanned } from './frontmatter.js'
import { countItems, entryLines } from './entries.js'
import { HEALTH_DIMENSIONS, healthOf } from './health.js'


/**
 * 迁移链：每一步把文档从 `from` 版改到 `to` 版。
 *
 * 只在**形状**上动手（front-matter 字段、小节是否存在与顺序），不动用户写的正文；
 * 唯一一处"造内容"是 v1→v2 把旧完成度折算成五维，且只在推导拿不到分时才填。
 * `changes` 里逐条说明改了什么，dry-run 与落盘共用同一份结果。
 */
export const MIGRATIONS = [
  {
    from: 1,
    to: 2,
    label: "v1 → v2：模块 front-matter 去 模式:/计划模块: 并补 模块:；补 ## 健康性（旧完成度折算）；主文档补 会话:",
  },
  {
    from: 2,
    to: 3,
    label: "v2 → v3：主文档收敛为 模块索引/源码索引/工具索引/坑 四节（用户原话·悬而未决·已定·撤销整节删除）；模块的合并小节拆成 ## 悬而未决（≤4）与 ## 已定（≤10）并去掉勾选框",
  },
  {
    from: 3,
    to: 4,
    label: "v3 → v4：主文档加第五节 ## 工作流（约束模型在特定操作下别做别的事，≤5 条，超了删最旧、删掉的进 front-matter 工作流归档可恢复）",
  },
  {
    from: 4,
    to: 5,
    label: "v4 → v5：执行模式两种拆三种——旧 `边拼边写`（一轮做完才问）改名 `写后再拼`，新 `边拼边写` 表示每个写动作前先问",
  },
  {
    from: 5,
    to: 6,
    label: "v5 → v6：`## 工作流` 从「扁平约束清单」重定义为「标准化流水线」——旧的一行条约束被搬进一个 `### 名字` 块（块名「迁移自 v5」），块内每行成为一步；front-matter 的 `工作流归档:` 从字符串数组升级成 `{name,steps}` 对象数组",
  },
  {
    from: 6,
    to: 7,
    label: "v6 → v7：一个会话可同时绑多个项目——主文档补 `当前会话:` 字段（取 `会话:` 的第一个），把「工具不给 project 时落在哪个项目」从「唯一绑定」改成「显式标记的当前项目」",
  },
  {
    from: 7,
    to: 8,
    label: "v7 → v8：插件改为全局——主文档**删掉** `会话:` 与 `当前会话:` 两个字段（项目与会话不再绑定，绑定逻辑整体退场；⚠️ 删后不可回退到 v1.x）",
  },
  {
    from: 8,
    to: 9,
    label: "v8 → v9：**工作流功能整体删除**——主文档 `## 工作流` 整节**删掉**、front-matter 的 `工作流归档:` 字段**删掉**（主文档收敛为四节；⚠️ 那一节里的流水线与归档历史都不再保留，删后不可回退到 v8 及更早）",
  },
]


export function pendingMigrations(version) {
  return MIGRATIONS.filter((step) => step.from >= version)
}

/**
 * v2 及更早版本里主文档有、v3 已取消的小节（整节删除，内容不外迁）。
 *
 * `## 健康性` 也在列：v3 起项目级健康性不再写进文档（它是模块均值，写下来只会与事实矛盾）。
 */
export const DROPPED_MAIN_SECTIONS = ['## 用户原话', '## 悬而未决', '## 已定', '## 撤销', '## 健康性']

/** 旧模板的说明行（整行完全一致才替换），迁移时换成 v3 的三行说明。 */


/**
 * 把正文拆成 `## ` 小节：前导部分 + 标题 → 内容行。
 *
 * 同名小节**合并**而不是丢弃——重复标题是老文档里真实出现过的
 * （手工编辑留下的第二份），丢掉第二份就是静默删内容。
 */
export function splitSections(body) {
  const lines = String(body ?? '').split(/\r?\n/)
  const preamble = []
  const groups = new Map()
  const order = []
  let current = null
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      const heading = line.trim()
      if (!groups.has(heading)) {
        groups.set(heading, [])
        order.push(heading)
      }
      current = heading
      continue
    }
    if (current === null) preamble.push(line)
    else groups.get(current).push(line)
  }
  return { preamble, groups, order }
}

/** 按给定顺序把拆出来的小节拼回去；未列出的小节按原顺序附在末尾。 */
export function joinSections(preamble, groups, order, headings) {
  const parts = []
  const head = preamble.join('\n').replace(/\s+$/, '')
  if (head.trim() !== '') parts.push(head)
  const emitted = new Set()
  const push = (heading) => {
    emitted.add(heading)
    const lines = groups.get(heading) ?? []
    parts.push([heading, ...lines].join('\n').replace(/\s+$/, ''))
  }
  for (const heading of headings) if (groups.has(heading)) push(heading)
  // `order` 里可能还留着**已被删除**的标题（删的是 groups 里的键，order 没跟着动）。
  // 必须再查一次 groups，否则删掉的小节会以空标题的形式重新出现——实测就是这么错的。
  for (const heading of order) if (!emitted.has(heading) && groups.has(heading)) push(heading)
  return parts.join('\n\n') + '\n'
}

/**
 * 迁移期的条目搬移：**只去勾选框、只按上限删最旧，不校验字数与出处**。
 *
 * 为什么不能用 `normalizeEntries`：它会要求每条都带 `（源码: …）`，
 * 而老文档里的条目本来就没有出处——那会让整段内容**静默变成「（待补）」**。
 * 迁移只改形状，正文不能因为新规则而被抹掉；新规则从下一次写入开始生效。
 */
export function migrateEntries(lines, cap) {
  const out = entryLines(lines.join('\n'))
  const overflow = cap !== undefined && out.length > cap ? out.slice(0, out.length - cap) : []
  return { kept: overflow.length > 0 ? out.slice(out.length - cap) : out, dropped: overflow }
}

/**
 * 主文档的规范化：front-matter 补版本，并把它收敛成**四节**。
 *
 * v3 起主文档只留规范小节（v4–v8 是五节，v9 起是四节）。旧版的
 * 用户原话 / 悬而未决 / 已定 / 撤销 **整节删除**（用户裁定：用户原话不再入库，
 * 撤销项直接删除，决策只写在模块文档里）——所以这一步会真的丢内容，
 * dry-run 预览里逐条列出来，落盘前能看清。
 */
export function migrateMainDoc(text, projectName, planned) {
  const { fields, body } = parseFrontMatter(text)
  const changes = []
  const version = docVersion(text)
  if (version < PUZZLE_VERSION) changes.push("版本 " + version + " → " + PUZZLE_VERSION)
  // v7 → v8：**删掉** `会话:` / `当前会话:` 两个字段（插件全局化，项目与会话不再绑定）。
  //
  // 这是本迁移链上第一处真的删数据，也是「不可回退到 v1.x」的由来——
  // 字段没了，旧版读不到绑定，全部项目表现为「未绑定」。代价如实写进 CHANGELOG。
  //
  // 为什么判据是「字段存在」而不是「版本 < 8」：v8 文档里本来就不该有这两行，
  // 但手工编辑 / 旧版写回都可能把它们带回来。**只要存在就删**才是幂等的正确形状：
  // 第一次删掉报改动，第二次没有字段可删 → 0 改动。
  const rawSessions = fields[SESSION_FIELD]
  const rawCurrent = fields[CURRENT_SESSION_FIELD]
  if (typeof rawSessions === 'string' && rawSessions.trim() !== '') {
    changes.push("删除 front-matter " + SESSION_FIELD + ":（v8：插件全局化，项目与会话不再绑定）")
  }
  if (typeof rawCurrent === 'string' && rawCurrent.trim() !== '') {
    changes.push("删除 front-matter " + CURRENT_SESSION_FIELD + ":（v8：当前项目改记在插件全局设置的 openProject）")
  }
  // v8 → v9：**删掉** front-matter 的 `工作流归档:`（工作流功能整体删除）。
  //
  // 与上面两个字段同一个形状：判据是「字段存在」而不是「版本 < 9」，因为手工编辑 /
  // 旧版写回都可能把它带回来；**只要存在就删**才幂等——第一次删掉报改动，
  // 第二次没有字段可删 → 0 改动。
  //
  // ⚠️ 这是**真的删数据**：归档里记着「删过哪些工作流」，删了就再也回不来。
  // 之所以还是删：用户裁定工作流整体退场，留一个没人读的字段只会让格式自相矛盾。
  const rawArchive = fields['工作流归档']
  if (typeof rawArchive === 'string' && rawArchive.trim() !== '') {
    changes.push("删除 front-matter 工作流归档:（v9：工作流功能整体删除，归档不再保留）")
  }

  // 用「拆分 → 改 → 按规范顺序拼回」而不是逐个 withSection：
  // withSection 找不到小节时会**追加到末尾**，于是 `## 坑` 会被插到 `## 模块索引` 之前、
  // `## 详细记录` 会被插到 `## 悬而未决` 之前——实测 v2 备份迁移后顺序就是乱的。
  const main = splitSections(body)
  // 旧的「检索索引」改名成「模块索引」：内容合并进新标题，旧标题消失。
  if (main.groups.has('## 检索索引')) {
    const old = main.groups.get('## 检索索引')
    if (main.groups.has(SECTION_HEADINGS.index)) main.groups.get(SECTION_HEADINGS.index).push(...old)
    else main.groups.set(SECTION_HEADINGS.index, old)
    main.groups.delete('## 检索索引')
    changes.push("小节改名 ## 检索索引 → " + SECTION_HEADINGS.index)
  }
  // 说明段：旧模板的措辞（"原话与三类决策"）在 v3 已是错的。
  // 做法是**先摘掉全部说明行再按新顺序补回**，而不是「缺哪行补哪行」——
  // 后者会把新说明追加到旧说明之后，顺序变成 [第3行, 第1行, 第2行]，看着像没改干净。
  // 同时只把**确实过时**的行算作改动：第 3 行新旧完全一致，算成改动会让幂等永远不成立。
  const stale = new Set([...OLD_PREAMBLE_LINES].filter((line) => !PREAMBLE_LINES.includes(line)))
  const hasStale = main.preamble.some((line) => stale.has(line.trim()))
  // 只有真的要改时才动说明行：已经是 v3 说明的文档必须原样保留，
  // 否则「先摘掉再补回」在幂等那次会把三行说明整个删掉。
  const keptPreamble = hasStale
    ? main.preamble.filter((line) => {
      const trimmed = line.trim()
      return !stale.has(trimmed) && !PREAMBLE_LINES.includes(trimmed)
    })
    : main.preamble.slice()
  if (hasStale) {
    // 说明行统一放在标题（与它后面的空行）之后，顺序固定。
    let at = keptPreamble.findIndex((line) => /^#\s/.test(line))
    at = at < 0 ? keptPreamble.length : at + 1
    while (at < keptPreamble.length && keptPreamble[at].trim() === '') at += 1
    keptPreamble.splice(at, 0, ...PREAMBLE_LINES)
    // 说明块与紧随其后的内容（通常是 `> 目标：…`）之间补一个空行：
    // 不补的话两者会贴在一起，`> 目标：` 会被当成说明行的续行（引用块吃进去）。
    if (keptPreamble[at + PREAMBLE_LINES.length] !== undefined && keptPreamble[at + PREAMBLE_LINES.length].trim() !== '') {
      keptPreamble.splice(at + PREAMBLE_LINES.length, 0, '')
    }
    changes.push("更新文件头说明（v9 起写明主文档只有四节）")
  }
  // 标题与说明之间可能留下连续空行（删行后残留），压成一个。
  const compact = []
  for (const line of keptPreamble) {
    if (line.trim() === '' && compact.length > 0 && compact[compact.length - 1].trim() === '') continue
    compact.push(line)
  }
  main.preamble.length = 0
  main.preamble.push(...compact)
  for (const heading of DROPPED_MAIN_SECTIONS) {
    if (!main.groups.has(heading)) continue
    const count = countItems(main.groups.get(heading).join('\n'))
    main.groups.delete(heading)
    changes.push("删除小节 " + heading + "（v3 已取消，含 " + count + " 条）")
  }
  // v8 → v9：**删掉整个 `## 工作流` 节**（工作流功能整体删除）。
  //
  // 为什么单独写一步而不是留给下面那个「非规范小节一律删」的循环：
  // 那条路会把它报成「非规范小节」（像是用户手写多了个标题），而这里是**格式决定的**
  // 破坏性删除——`## 工作流` 曾是规范第五节。报错文案必须说清是哪一版删的、
  // 删的是什么，否则用户看到自己写的流水线没了，只会以为是 bug。
  //
  // 幂等：`headingMatches` 只在**真的存在**这个标题时才删，没有就 0 改动。
  // 用 `headingMatches` 而不是全等，是为了连 `## 工作流（…）` 这种带说明后缀的
  // 写法一起收掉——`getSection` 当年就是靠它读出来的，只删精确标题会留下读不出的残节。
  //
  // 标题只能写字面量：`SECTION_HEADINGS.workflow` 已随功能一起删掉，
  // 而这个标题只在本步（与 `OLD_PREAMBLE_LINES` 里那句旧说明）出现，不值得再立一个常量。
  for (const heading of main.order.slice()) {
    if (!main.groups.has(heading)) continue
    if (!headingMatches(heading, '## 工作流')) continue
    const count = countItems(main.groups.get(heading).join('\n'))
    main.groups.delete(heading)
    changes.push("删除小节 " + heading + "（v9：工作流功能整体删除，含 " + count + " 条；⚠️ 不再保留）")
  }
  // 先归一化**带说明后缀的规范标题**：`## 源码索引（src/，共 110 文件）` 的内容
  // 合并进 `## 源码索引`。必须在删非规范小节**之前**做，否则它会被当成多余小节删掉
  // ——那正是「内容还在但读不出来」的另一半。
  for (const heading of main.order.slice()) {
    if (!main.groups.has(heading)) continue
    const key = SECTION_ORDER.find((k) => headingMatches(heading, SECTION_HEADINGS[k]))
    if (key === undefined) continue
    const canonical = SECTION_HEADINGS[key]
    if (heading === canonical) continue
    const lines = main.groups.get(heading)
    main.groups.delete(heading)
    if (main.groups.has(canonical)) main.groups.get(canonical).push(...lines)
    else main.groups.set(canonical, lines)
    changes.push("小节标题归一化 " + heading + " → " + canonical)
  }
  // 规范清单之外的小节一律删掉：主文档**只允许**规范里的那几节。
  //
  // 这是「删不掉的小节」那个 bug 的根：早先只删固定白名单，其它标题被 joinSections
  // 原样附回末尾——于是 `## 模块 → 文档` 这类小节永远活着。
  // 白名单天生跟不上实际写法，所以改成**白名单的反面**：不在规范里就删。
  for (const heading of main.order.slice()) {
    if (!main.groups.has(heading)) continue
    if (SECTION_ORDER.some((key) => headingMatches(heading, SECTION_HEADINGS[key]))) continue
    const count = countItems(main.groups.get(heading).join('\n'))
    main.groups.delete(heading)
    changes.push("删除非规范小节 " + heading + "（主文档只允许 " + SECTION_ORDER.length + " 节，含 " + count + " 条）")
  }
  for (const key of SECTION_ORDER) {
    const heading = SECTION_HEADINGS[key]
    if (main.groups.has(heading)) continue
    // 缺的小节补成占位行：形状补全是重建的目的，内容仍由人写。
    const placeholder = key === 'index' ? '- （尚未拆分模块）' : '- （待补）'
    main.groups.set(heading, [placeholder])
    changes.push("补小节 " + heading)
  }
  const nextBody = joinSections(main.preamble, main.groups, main.order, SECTION_ORDER.map((key) => SECTION_HEADINGS[key]))
  // 模式要**按文档自己的版本**读：`version` 是这份文档迁到当前版之前的版本，
  // v4 及更早的 `边拼边写` 是「一轮做完才问」的旧含义。用当前版规则去读它，
  // 会把每个老项目在重建那一刻静默升级成高强度模式（每次写文件都停下来问）。
  const mode = normalizeMode(fields["模式"], version) ?? DEFAULT_MODE
  if (version < MODE_RENAME_VERSION && typeof fields["模式"] === 'string' && fields["模式"].trim() === MODE_PUZZLE_WRITE) {
    changes.push("模式改名 " + MODE_PUZZLE_WRITE + " → " + MODE_PUZZLE_AFTER + "（旧含义是「一轮做完才问」）")
  }
  const head = formatFrontMatter({
    puzzle: PUZZLE_VERSION,
    project: fields["项目"] ?? projectName,
    mode,
    modules: planned,
    sourceRoot: parseSourceRoot(fields),
    updated: timestamp(),
  })
  return { text: [head, nextBody.replace(/^\n+/, "")].join("\n"), changes, version }
}

/**
 * 模块文档的规范化：front-matter 只留 项目:/模块:，缺 ## 健康性 就补，
 * 并把 v2 的合并小节 `## 与本模块相关的悬而未决 / 已定 / 撤销` 拆成
 * `## 悬而未决` / `## 已定` 两个小节（去掉勾选框、按上限删最旧）。
 *
 * 补健康性时：**该维已经有推导分就不填数字**（填了就变成"显式声明"，反而把推导冻住）；
 * 推导为 0 且文档里有旧「完成度」时，按 PROGRESS_TO_HEALTH 折算一个起点，
 * 并在小节里留一行说明——它不是评估结果，是迁移值。
 */
export function migrateModuleDoc(text, name, projectText) {
  const { fields, body } = parseFrontMatter(text)
  const changes = []
  const version = docVersion(text)
  if (version < PUZZLE_VERSION) changes.push("版本 " + version + " → " + PUZZLE_VERSION)
  if (fields["模块"] !== name) changes.push("front-matter 补 模块: " + name)
  if (Object.hasOwn(fields, "模式")) changes.push("去掉模块文档上多余的 模式:（模式是项目级设置）")
  if (Object.hasOwn(fields, "计划模块")) changes.push("去掉模块文档上多余的 计划模块:")

  const mod = splitSections(body)
  // 拆分合并小节：`[ ]` → 悬而未决，`[x]` → 已定，其余（说明行）丢掉。
  if (mod.groups.has(RELATED_HEADING)) {
    const lines = mod.groups.get(RELATED_HEADING)
    const pending = lines.filter((raw) => /^\s*[-*]\s*\[ \]/.test(raw))
    const decided = lines.filter((raw) => /^\s*[-*]\s*\[[xX]\]/.test(raw))
    mod.groups.delete(RELATED_HEADING)
    const splitPending = migrateEntries(pending, ENTRY_CAPS.pending)
    const splitDecided = migrateEntries(decided, ENTRY_CAPS.decided)
    // 合并进已有的同名小节（老文档可能已经有 `## 已定`），不覆盖。
    const mergeInto = (heading, kept) => {
      if (kept.length === 0) return
      if (mod.groups.has(heading)) mod.groups.get(heading).push(...kept)
      else mod.groups.set(heading, kept)
    }
    mergeInto(MODULE_SECTION_HEADINGS.pending, splitPending.kept)
    mergeInto(MODULE_SECTION_HEADINGS.decided, splitDecided.kept)
    // 报**真的搬过去**的条数：`- [ ] （待补）` 这类占位行会被 entryLines 丢掉，
    // 按原始行数报就会说「1 + 0 条」而实际一条也没搬——文案与结果不符。
    changes.push("拆分小节 " + RELATED_HEADING + " → " + MODULE_SECTION_HEADINGS.pending
      + " / " + MODULE_SECTION_HEADINGS.decided
      + "（搬了 " + splitPending.kept.length + " + " + splitDecided.kept.length + " 条"
      + (splitPending.dropped.length + splitDecided.dropped.length > 0
        ? "，按上限删了 " + (splitPending.dropped.length + splitDecided.dropped.length) + " 条旧项"
        : "")
      + "）")
  }

  // 旧格式里条目还挂着勾选框；v3 起按小节区分，勾选框一律去掉。
  for (const key of ["pending", "decided", "points", "detail"]) {
    const heading = MODULE_SECTION_HEADINGS[key]
    if (!mod.groups.has(heading)) continue
    const lines = mod.groups.get(heading)
    if (!lines.some((raw) => /^\s*[-*]\s*\[[ xX]\]/.test(raw))) continue
    const cleaned = migrateEntries(lines, ENTRY_CAPS[key]).kept
    mod.groups.set(heading, cleaned)
    changes.push("去掉 " + heading + " 里的勾选框（v3 用两个小节区分）")
  }

  for (const key of ["progress", "points", "pending", "decided", "reuse", "detail"]) {
    const heading = MODULE_SECTION_HEADINGS[key]
    if (mod.groups.has(heading)) continue
    mod.groups.set(heading, [key === "progress" ? "完成度: 0" : "- （待补）"])
    changes.push("补小节 " + heading)
  }

  // 模块文档同样只允许规范小节：`## 可复用` 这类没有写入通道的小节会被删掉。
  // （`## 可复用` 曾是「可复用性」的证据来源，但没有任何 op 能写它——
  //  等于一条只能靠手改文档才能维持的分。见 health.js 的说明。）
  for (const heading of mod.order.slice()) {
    if (!mod.groups.has(heading)) continue
    if (MODULE_SECTION_ORDER.some((known) => headingMatches(heading, known))) continue
    const count = countItems(mod.groups.get(heading).join('\n'))
    mod.groups.delete(heading)
    changes.push("删除非规范小节 " + heading + "（模块文档只允许 " + MODULE_SECTION_ORDER.length + " 节，含 " + count + " 条）")
  }

  if (!mod.groups.has(HEALTH_HEADING)) {
    const progressText = mod.groups.get(MODULE_SECTION_HEADINGS.progress).join("\n")
    const match = /完成度\s*[:：]\s*(\d{1,3})/.exec(progressText)
    const progress = match === null ? null : clampPercent(Number(match[1]))
    const derived = healthOf(text, projectText)
    const lines = HEALTH_DIMENSIONS.map((dimension) => "- " + dimension.name + ": ")
    let filled = 0
    if (progress !== null && progress > 0) {
      const seeded = clampPercent(Math.round(progress * PROGRESS_TO_HEALTH))
      for (let i = 0; i < HEALTH_DIMENSIONS.length; i += 1) {
        const dimension = HEALTH_DIMENSIONS[i]
        // 推导拿得到分的维度不填：一填就变「显式声明」，反而把推导冻在折算值上。
        const hasEvidence = (derived.sources[dimension.key] === "derived" && (derived.scores[dimension.key] ?? 0) > 0)
          || derived.sources[dimension.key] === "module"
        if (hasEvidence) continue
        lines[i] = "- " + dimension.name + ": " + seeded
        filled += 1
      }
      // 说明行只在**真的填了数字**时加：一个都没填却挂着「折算为 N」就是文案与事实矛盾。
      if (filled > 0) {
        lines.push("- （迁移：旧「完成度 " + progress + "」×" + PROGRESS_TO_HEALTH + " = " + seeded + " 分，填给了 " + filled + " 个还拿不到证据的维度；这是起点不是评估，请按真实情况修正）")
      }
    }
    mod.groups.set(HEALTH_HEADING, lines)
    changes.push(filled > 0
      ? "补小节 " + HEALTH_HEADING + "（按旧完成度 " + progress + " 折算，填了 " + filled + " 维）"
      : "补小节 " + HEALTH_HEADING + "（留空；旧完成度缺省或为 0）")
  }

  // 顺序按当前模板：标题 → 健康性 → 进度 → 要点 → 悬而未决 → 已定 → 详细记录。
  const nextBody = joinSections(mod.preamble, mod.groups, mod.order, MODULE_SECTION_ORDER)
  const head = formatFrontMatter({ puzzle: PUZZLE_VERSION, project: fields["项目"] ?? name, module: name, updated: timestamp() })
  return { text: [head, nextBody.replace(/^\n+/, "")].join("\n"), changes, version }
}

/** 磁盘上真的有文件的模块名（不依赖 front-matter 声明）。 */
export function modulesOnDisk(puzzleDir) {
  const out = []
  for (const entry of listFiles(join(puzzleDir, MODULE_DIR))) {
    if (!entry.endsWith(".md")) continue
    const name = slugify(entry.slice(0, -3))
    if (name !== null && !out.includes(name)) out.push(name)
  }
  return out
}

/**
 * 算「重建要做哪些改动」，**只读不写**。dry-run 与落盘的产物是同一份，
 * 所以「预览里看到的」就是「落盘会做的」。
 */
export function planRebuild(projectRoot, projectName) {
  const slug = slugify(projectName)
  if (slug === null) return { ok: false, error: "项目名不合法", hint: "检查项目名" }
  const puzzleDir = puzzleDirOf(projectRoot, slug)
  if (puzzleDir === null) return { ok: false, error: "项目路径越界", hint: "检查项目名" }
  const mainDoc = join(puzzleDir, MAIN_FILE)
  if (!isFile(mainDoc)) return { ok: false, error: "项目尚未创建", hint: "先执行 op=init" }
  const mainText = readText(mainDoc)
  if (mainText === null) return { ok: false, error: "主文档读不出来", hint: "检查文件权限" }

  const { fields } = parseFrontMatter(mainText)
  // 计划模块取「声明 ∪ 磁盘」：声明了但没建的要留着（还没写），磁盘上有但没声明的也要迁。
  const declared = safePlanned(fields)
  const onDisk = modulesOnDisk(puzzleDir)
  const names = [...declared]
  for (const name of onDisk) if (!names.includes(name)) names.push(name)

  const main = migrateMainDoc(mainText, slug, names)
  const files = [{
    kind: "main",
    name: slug,
    file: mainDoc,
    version: main.version,
    changes: main.changes,
    text: main.text,
  }]

  for (const name of names) {
    const file = safeJoin(puzzleDir, MODULE_DIR, name + ".md")
    if (file === null || !isFile(file)) {
      files.push({ kind: "module", name, file: file ?? "", version: 0, missing: true, changes: ["模块文档不存在（只有图块）；要用 op:module 写第一段内容才会建出来"], text: null })
      continue
    }
    const text = readText(file)
    if (text === null) {
      files.push({ kind: "module", name, file, version: 0, changes: ["文档存在但读不出来"], text: null })
      continue
    }
    const done = migrateModuleDoc(text, name, mainText)
    files.push({ kind: "module", name, file, version: done.version, changes: done.changes, text: done.text })
  }

  const touched = files.filter((item) => item.changes.length > 0 && typeof item.text === "string")
  return {
    ok: true,
    project: slug,
    puzzleDir,
    mainDoc,
    version: docVersion(mainText),
    targetVersion: PUZZLE_VERSION,
    outdated: docVersion(mainText) < PUZZLE_VERSION,
    migrations: pendingMigrations(docVersion(mainText)).map((step) => step.label),
    files,
    totalChanges: files.reduce((sum, item) => sum + item.changes.length, 0),
    writable: touched.map((item) => item.name),
  }
}

/**
 * 重建一个项目的文档：默认**只报计划**，`apply:true` 才落盘。
 *
 * 为什么默认 dry-run：重建是破坏性的（重写 front-matter、补小节）。
 * 本项目**不自动备份**（工作区通常已在 git 里），所以预览这一道就是唯一的刹车。
 */
export function rebuildProject(projectRoot, projectName, apply = false) {
  const plan = planRebuild(projectRoot, projectName)
  if (plan.ok !== true) return plan
  if (apply !== true) return { ...plan, applied: false }

  const written = []
  const failed = []
  for (const item of plan.files) {
    if (item.changes.length === 0 || typeof item.text !== "string") continue
    try {
      atomicWrite(item.file, item.text)
      written.push(item.name)
    } catch (error) {
      failed.push(item.name + "：" + String(error && error.message ? error.message : error))
    }
  }
  return { ...plan, applied: true, written, failed }
}

/* --------------------------------- 模板 --------------------------------- */

/**
 * 主文档模板：**只有规范里的那几节**（v9 起是四节：模块索引 / 源码索引 / 工具索引 / 坑）。
 *
 * 条目格式固定为「一句话（源码: 文件[:行]）」——查找方向是 主文档 → 源码，
 * 所以每条都得能回查。字数上限见 `ENTRY_LIMITS`（写入时校验，超了报错）。
 */
