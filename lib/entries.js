/**
 * 条目规格：限长、必须带源码出处、超条数删最旧。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */
import { join } from 'node:path'
import { SECTION_ORDER, SECTION_HEADINGS, MODULE_SECTION_HEADINGS, ENTRY_LIMITS, limitsOfSize, SOURCE_MARK } from './constants.js'
import { getSection } from './frontmatter.js'


/* --------------------------------- 计数 --------------------------------- */

/**
 * 模板自带的说明性占位行——**只认这几种固定说法**。
 *
 * 早先的实现把「整行就是一对括号」一律当占位，于是用户写的
 * 「（见模块 auth-flow）」这类真内容会被误判为空、少算条数。
 */
export const PLACEHOLDER_PATTERNS = [
  /^（?待补）?$/,
  /^[（(][^）)]*待补[^）)]*[）)]$/,
  /^[（(][^）)]*(尚未拆分模块)[^）)]*[）)]$/,
  /^[（(][^）)]*(一句话职责)[^）)]*[）)]$/,
  /^[（(][^）)]*(该模块的关键结论|只留事实)[^）)]*[）)]$/,
  /^[（(][^）)]*(细化记录|主文档只留一行索引)[^）)]*[）)]$/,
  /^[（(][^）)]*五维都是[^）)]*[）)]$/,
  // v3 模板的说明行。**必须整行是括号**才认占位——真实的条目形如
  // `- 主文档改为轮汇报条目（源码: …）`，它不以括号开头，所以不会被误判成占位。
  // （早先「整行是一对括号就当占位」的写法把「（见模块 auth-flow）」这类真内容吃掉了。）
  /^[（(][^）)]*(最多 \d+ 条)[^）)]*[）)]$/,
  /^[（(][^）)]*轮汇报[：:][^）)]*[）)]$/,
  // `## 可复用` 的模板说明行。**必须单独列一条**：它长得像真条目
  // （「可被别处复用的接口 / 共享模块…」），不认出来就会被算成 1 条证据，
  // 于是新建的模块可复用性直接有 30 分——凭空来的分。
  /^[（(][^）)]*(可被别处复用)[^）)]*[）)]$/,
]

/** 剔掉空行与模板占位行。同时剥掉列表符与勾选框，好让 `- [ ] （待补）` 也认得出是占位。 */


/** 剔掉空行与模板占位行。同时剥掉列表符与勾选框，好让 `- [ ] （待补）` 也认得出是占位。 */
export function nonEmptyLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, '').replace(/^\[[ xX]\]\s*/, '').trim())
    .filter((line) => line !== '' && !PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(line)))
}


export function countItems(text) {
  return nonEmptyLines(text).length
}

/* ------------------------------- 条目规整与限长 ------------------------------- */

/**
 * 把一段正文拆成条目行（保留 `- ` 前缀，供回写用）。
 *
 * 与 `nonEmptyLines` 的区别：这里**保留原始行**，因为限长与截断要按行回写，
 * 不能只拿剥掉标记的文本。空行与模板占位行仍然剔除。
 */


/* ------------------------------- 条目规整与限长 ------------------------------- */

/**
 * 把一段正文拆成条目行（保留 `- ` 前缀，供回写用）。
 *
 * 与 `nonEmptyLines` 的区别：这里**保留原始行**，因为限长与截断要按行回写，
 * 不能只拿剥掉标记的文本。空行与模板占位行仍然剔除。
 */
export function entryLines(text) {
  const out = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (trimmed === '') continue
    const bare = trimmed.replace(/^\s*[-*]\s*/, '').replace(/^\[[ xX]\]\s*/, '').trim()
    if (bare === '' || PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(bare))) continue
    // 勾选框一律去掉：v3 用 `## 悬而未决` / `## 已定` 两个小节区分，不再用 `[ ]`。
    out.push('- ' + bare)
  }
  return out
}

/** 条目正文里「源码出处」之前的那部分——限长只算它，出处不占额度。 */


/** 条目正文里「源码出处」之前的那部分——限长只算它，出处不占额度。 */
export function entryBody(line) {
  const bare = String(line ?? '').trim().replace(/^\s*[-*]\s*/, '').trim()
  const at = bare.indexOf(SOURCE_MARK)
  return at < 0 ? bare : bare.slice(0, at).trim()
}

/** 字数：按 Unicode 码点算，一个汉字算 1。 */


/** 字数：按 Unicode 码点算，一个汉字算 1。 */
export function charCount(text) {
  return [...String(text ?? '')].length
}

/**
 * 「可复验的度量」单位：性能（ms/µs/ns）、体量（KB/MB）、倍数（倍/×）。
 *
 * **刻意只收这些**，不收「条 / 个 / 处 / 行」这类**规格与计数**——
 * 「悬而未决 ≤4 条」「五节」「12 步」是**规定**，不需要测法；
 * 把它们也纳入会满屏误报，规则立刻没人看。
 * 只认「同一个数字换台机器就会变」的那类。
 */
const MEASURE_UNIT = /(\d+(?:\.\d+)?)\s*(ms|µs|us|ns|KB|MB|GB|倍|×)/i

/**
 * 「测法」的标记词：说了怎么测的，数字就可复验。
 *
 * 这是 ② 的核心——**数字必须带测法**。
 *
 * 由来（v0.19.9）：我发布过「127ms → **1.3µs**（~100000×）」，真实是 0.9ms（~140×）——
 * **错了约 500 倍**。根因不是算错，而是那个数字**没有测法**，所以没人能复验它。
 * 有测法（「中位数 / 20 次」）的话，读的人当场就能问「你怎么量的」。
 */
const MEASURE_METHOD = /(实测|测得|中位数|平均|基准|bench|样本|复现|p50|p95|p99|取样|重复\s*\d|次数)/i

/**
 * 这条条目是不是「报了数字但没给测法」。
 *
 * 返回 `null` 表示没问题，否则返回那个可疑的数字片段（供报错文案点名）。
 * 纯函数、不抛错——它同时被 `checkEntry`（写入时拦）与 `entryIssuesIn`（审查时报）用。
 */
export function measureWithoutMethod(text) {
  const body = String(text ?? '')
  const hit = MEASURE_UNIT.exec(body)
  if (hit === null) return null
  if (MEASURE_METHOD.test(body)) return null
  return hit[0]
}

/**
 * 校验一条条目：限长 +（可选）必须带源码出处。
 *
 * 返回 `{ ok:true }` 或 `{ ok:false, error, hint }`。**不截断**——
 * 半句话落进文档比报错更糟，模型收到错误后会自己重写。
 *
 * `requireSource` 只在「这条指向源码」时才为真：模块索引指向的是模块文档
 * （`模块/X.md` 本身就是回查路径），所以只限长、不要求 `（源码: …）`。
 */
export function checkEntry(line, limit, requireSource = true) {
  const bare = String(line ?? '').trim().replace(/^\s*[-*]\s*/, '').trim()
  if (bare === '') return { ok: false, error: '空条目', hint: '一条一句话，不要写空行' }
  const body = entryBody(bare)
  if (body === '') return { ok: false, error: '条目只有源码出处、没有正文', hint: '先写一句话，再在末尾加「' + SOURCE_MARK + ': 文件:行）」' }
  const count = charCount(body)
  if (count > limit) {
    return {
      ok: false,
      error: `条目 ${count} 字，超过上限 ${limit} 字`,
      hint: `精简到 ${limit} 字以内（只算「${SOURCE_MARK}…」之前的那句话；出处不占额度）：${body}`,
    }
  }
  if (requireSource && !bare.includes(SOURCE_MARK)) {
    return {
      ok: false,
      error: '条目缺少源码出处',
      hint: `每条都要能回查源码，末尾加「${SOURCE_MARK}: lib/xxx.js:123）」。查找方向固定为 主文档 → 源码。`,
    }
  }
  // ② 数字要带测法：**只警告、不拒绝**（v0.19.9）。
  //
  // 为什么不拦：这是**语义**判断，启发式再好也会有假阳性（例如「快了 3 倍」这种
  // 读者不需要复验的表述）。拦下来会让正常写入失败，模型只能删数字——
  // 那是「把证据删掉」，比留着更糟。
  // 所以：写入放行 + 回一句提醒；真正的强制在审查（`entryIssuesIn` 报 warn）。
  const measure = measureWithoutMethod(body)
  if (measure !== null) {
    return {
      ok: true,
      body,
      count,
      warning: `条目里的数字「${measure}」没给测法，别人无法复验。`
        + `建议补上怎么测的（如「实测中位数 / 20 次」）——本项目发布过把 async 函数当同步计时、`
        + `错约 500 倍的数字，就是因为它没有测法。`,
    }
  }
  return { ok: true, body, count }
}

/**
 * 写「已定 / 悬而未决」时，把**现有条目**摊出来给模型对照（③，v0.19.9）。
 *
 * ## 为什么是「回显」而不是「自动判冲突」
 *
 * 我先试过自动判：按 2-gram 重叠打分，重叠 ≥2 算可疑。**实测失败了**——
 * 真实冲突「不写测试不跑测试」vs「本项目测试要跑要维护」只拿到 **1 分**
 * （唯一共享的是「测试」两字），阈值设 2 就漏掉这个**真冲突**；
 * 降到 1 又会误报（「介绍字段…」也拿 1 分）。
 *
 * 根因：**「矛盾」是语义关系，不是字面关系**。「不写测试」与「要跑测试」字面只差两个字，
 * 意思正好相反；而「发版走 tag」与「不建 Release」字面很像却互不矛盾。
 * 字面算法在这件事上**没有可用的阈值**——不是调参问题，是方向错了。
 *
 * 所以这里只做**确定能做对**的那一半：把同小节的旧条目原样摊出来，
 * 让**读得懂语义的模型**自己判「哪条被我取代了」。零误报，且不假装自己判得准。
 *
 * 由来：我写「放开测试约定」时只追加了新条目，没发现「已定」里还挂着
 * 「不写测试不跑测试」——**文档写着和现实相反的规则**，比漏写更糟，
 * 因为下个会话会照着它做。
 *
 * @param {string} sectionKey 小节 key（只对 `decided` / `pending` 有意义）
 * @param {Array<string>} existing 该小节现有条目（纯正文，不含 `- ` 前缀与出处）
 * @param {Array<string>} incoming 本次要写入的条目
 * @param {number} cap 条数上限（用于预告会挤出哪几条）
 * @returns {object|null} 有旧条目时返回提示对象，否则 null
 */
export function conflictDigest(sectionKey, existing, incoming, cap) {
  const old = Array.isArray(existing) ? existing.filter((item) => typeof item === 'string' && item !== '') : []
  if (old.length === 0) return null
  const added = Array.isArray(incoming) ? incoming.length : 0
  // 预告「谁会被挤掉」：追加模式下超上限时删最旧（数组头部）。
  const total = old.length + added
  const evicted = cap !== undefined && total > cap ? old.slice(0, total - cap) : []
  return {
    section: sectionKey,
    existing: old,
    existingCount: old.length,
    incomingCount: added,
    evicted,
    hint: '写入前先对照上面的**现有条目**：本次要写的结论若与某条**矛盾或取代**了它，'
      + '请用 append:false 重写整节（把被取代的删掉），**不要只追加**——'
      + '留着反向的旧条目比漏写更糟，下一个会话会照着旧条目做。'
      + (evicted.length > 0 ? `另外超上限会挤掉最旧的 ${evicted.length} 条（已在 evicted 里列出）。` : ''),
  }
}

/**
 * 把要写入的条目规整成最终文本：逐条校验 + 按上限**删最旧**。
 *
 * `cap` 是条数上限（悬而未决 4 / 已定 10）；旧条目在前、新条目在后，
 * 超限保留末尾 `cap` 条。返回 `dropped` 让调用方如实回报删了几条。
 */
export function normalizeEntries(content, limit, cap, requireSource = true) {
  const incoming = entryLines(content)
  for (const line of incoming) {
    const checked = checkEntry(line, limit, requireSource)
    if (checked.ok !== true) return { ok: false, error: checked.error, hint: checked.hint }
  }
  const dropped = cap !== undefined && incoming.length > cap ? incoming.slice(0, incoming.length - cap) : []
  const kept = dropped.length > 0 ? incoming.slice(incoming.length - cap) : incoming
  return { ok: true, text: kept.join('\n'), dropped, kept: kept.length, incoming: incoming.length }
}

/**
 * 扫一份文档正文里**不合规的条目**，按小节汇总。
 *
 * 为什么要有它：`ENTRY_LIMITS` / 源码出处只在**写入时**拦，老文档里已经存在的
 * 长条目与无出处条目不会被追溯。审查如果不看这些，就会说「要点 15 条，很充实」，
 * 而实际上 15 条全都超过 20 字、全都没有出处——数字漂亮，规格全破。
 *
 * `spec` 是「小节 key → {heading, limit, requireSource}」；主文档与模块文档各传一份。
 */
export function entryIssuesIn(body, spec) {
  const out = []
  for (const [key, entry] of Object.entries(spec)) {
    let tooLong = 0
    let noSource = 0
    let noMethod = 0
    let sample = ''
    for (const line of entryLines(getSection(body, entry.heading) ?? '')) {
      const checked = checkEntry(line, entry.limit, entry.requireSource !== false)
      // ② 数字没测法：**ok:true 但带 warning**，所以先单独收。
      if (checked.warning !== undefined) {
        noMethod += 1
        if (sample === '') sample = entryBody(line).slice(0, 24)
      }
      if (checked.ok === true) continue
      if (checked.error.includes('超过上限')) tooLong += 1
      else if (checked.error.includes('缺少源码出处')) noSource += 1
      else continue
      if (sample === '') sample = entryBody(line).slice(0, 24)
    }
    if (tooLong === 0 && noSource === 0 && noMethod === 0) continue
    out.push({ key, heading: entry.heading, limit: entry.limit, tooLong, noSource, noMethod, sample })
  }
  return out
}

/**
 * 从文档正文里抽出**被引用到的源码文件路径**（`（源码: lib/x.js:12）` → `lib/x.js`）。
 *
 * 为什么要它：审查要给「模块级」源码真实值，但源码体检是**项目级**的。
 * 不做映射的话，每个模块都会拿到同一份项目级硬伤——8 个模块的分一模一样，
 * 而且会把「client.js 1303 行」算到「会话绑定」头上：那是编出来的因果。
 *
 * 三条口径（每条都对应一个真实缺陷）：
 *  1. **保留相对路径，不只留 basename**：`src/a/index.ts` 与 `src/b/index.ts`
 *     必须能区分，否则两条被去重成一条，命中一个文件的扣分会错误地摊给另一个模块。
 *  2. **反引号包裹也要认**：`` `src/gi/pool.ts:30` `` 是 markdown 里的主流写法，
 *     老实现把反引号一起捕获，结尾不是 `.ts`，整条静默丢弃。
 *  3. **「待建 / TODO / 计划」这类前缀的引用要剔除**：它们指的是**还不存在**的文件，
 *     算进「测过」会把没开工的模块抬成源码侧满分（方向性错误）。
 *
 * 抽不到任何文件（文档没写出处）时返回空数组——调用方据此判定「这个模块没指到代码」，
 * 应当**只用文档证据**算分，而不是拿全项目硬伤去扣。
 */
export function citedSourceFiles(body) {
  const out = new Set()
  // 允许反引号/空格包裹路径；路径里不允许出现冒号（`:行号` 与 Windows 盘符都排除）。
  const re = /（源码[:：]\s*`?\s*([^:：）`]+?)\s*`?(?:[:：]\s*\d+)?\s*）/g
  let match = re.exec(body)
  while (match !== null) {
    const raw = match[1].trim()
    // 「待建 / 计划 / TODO / 未建」开头的引用指的是不存在的文件，不算已测量。
    // ⚠️ **不能用 `\b`**：汉字不是 `\w`，`/待建\b/` 永远不匹配（踩过）——
    // 用「后面跟空白或结束」代替词边界。
    if (/^(待建|计划|规划|未建|未开工|todo|planned|tbd)(\s|$)/i.test(raw)) {
      match = re.exec(body)
      continue
    }
    // 只认像源码文件的（带扩展名），排除 `模块/x.md` 这类文档自身引用。
    if (/\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|rb|sh)$/i.test(raw)) {
      out.add(raw.replace(/\\/g, '/').replace(/^\.\//, ''))
    }
    match = re.exec(body)
  }
  return [...out].sort()
}

/**
 * 主文档五节的条目规格。
 *
 * `index` 指向模块文档（`模块/X.md` 本身就是回查路径），所以只限长、不要求出处。
 * `workflow` **不强制出处**：它约束的是「完成某任务的流程」，不是对代码事实的断言——
 * 强行要求 `（源码: …）` 只会逼出编造的出处。
 *
 * ⚠️ **v6 起 `workflow` 不再走本表**：它是 `### 块 + 步骤` 结构，不是「一行一条」，
 * 所以 `updateMainSection` 里对 workflow 单独走 `normalizeWorkflowEntries`。
 * 这里保留它的键（`limit` 只是占位，无实际校验作用），是为了让 `SECTION_ORDER`
 * 的每一项在本表里都有对应项——少一项会让按 key 取规格的旧调用点读到 `undefined`。
 * 其余三节（源码索引 / 工具索引 / 坑）必须能回查源码。
 */
/**
 * 主文档里**条目式**小节的规格。`## 工作流` **不在列**——这是刻意的。
 *
 * 为什么必须把它排除（实测 bug，v0.20.1 修）：`## 工作流` 的内容不是「一句话条目」，
 * 而是流水线块（`### 名字` + 有序步骤）。条目规格会拿 `ENTRY_LIMITS.workflow = 50`
 * 去量**每一行**，而步骤的合法上限是 `WORKFLOW_STEP_LIMIT = 80`——
 * 于是 51–80 字的**完全合法**的步骤被报成「超长」，审查里长期挂着 7 条假发现。
 * 上限对不上只是表象；根因是**它不是条目小节**，不该套条目的尺子。
 *
 * `## 工作流` 的形状校验在 `checkWorkflowBlocks`（名字限长 / 步数 / 每步限长），
 * 那才是它该走的那把尺子。
 */
export const MAIN_ENTRY_SPEC = Object.fromEntries(
  SECTION_ORDER.filter((key) => key !== 'workflow').map((key) => [key, {
    heading: SECTION_HEADINGS[key],
    limit: ENTRY_LIMITS[key],
    requireSource: key !== 'index',
  }]),
)

/** 模块文档四个条目式小节的规格。 */


/**
 * 模块文档的条目式小节规格（`## 可复用` 也在此列：它是「可复用性」的证据来源）。
 *
 * `limit` **不做 `?? 默认值` 兜底**：早先写成 `ENTRY_LIMITS[key] ?? ENTRY_LIMITS.points`，
 * 于是 `ENTRY_LIMITS` 漏了 `pending` / `decided` 时静默退化成「用 points 的上限」，
 * 更早的一版则直接传 `undefined`——`count > undefined` 恒为 `false`，
 * 「悬而未决 / 已定 ≤20 字」这条规格**从来没生效过**，而且一声不吭。
 * 现在缺上限会直接抛错，宁可炸在启动时，也不要静默放过。
 */
export const MODULE_ENTRY_SPEC = Object.fromEntries(['points', 'pending', 'decided', 'reuse', 'detail'].map((key) => {
  const limit = ENTRY_LIMITS[key]
  if (typeof limit !== 'number') throw new Error('ENTRY_LIMITS 缺少 ' + key + ' 的上限')
  return [key, { heading: MODULE_SECTION_HEADINGS[key], limit, requireSource: true }]
}))

/* --------------------- 按规模档位取条目规格（审查用） --------------------- */

/**
 * 按**项目规模档位**造主文档 / 模块文档的条目规格。
 *
 * 为什么需要它（真 bug，v0.24.2 修）：`MAIN_ENTRY_SPEC` / `MODULE_ENTRY_SPEC` 是
 * 用 `ENTRY_LIMITS`（= **中档**字长）算出来的常量，而**写入侧**走的是
 * `limitsOfSize(档位)`。于是大档项目（要点 / 已定放宽到 40 字）写进去完全合法，
 * **审查却拿中档的 20 字去量**——每条合法条目都被报成「超长」。
 *
 * 这是本仓记过的「两把尺子」：**写入放行、审查报警**。同一份规格必须两边同源。
 *
 * 认不出的档位回落到 `中`（与 `limitsOfSize` 同口径），所以旧调用点行为不变。
 */
export function mainEntrySpecOf(size) {
  const limits = limitsOfSize(size)
  return Object.fromEntries(
    SECTION_ORDER.filter((key) => key !== 'workflow').map((key) => [key, {
      heading: SECTION_HEADINGS[key],
      limit: limits[key],
      requireSource: key !== 'index',
    }]),
  )
}

/** 模块文档的条目规格，按档位取字长。 */
export function moduleEntrySpecOf(size) {
  const limits = limitsOfSize(size)
  return Object.fromEntries(['points', 'pending', 'decided', 'reuse', 'detail'].map((key) => {
    const limit = limits[key]
    if (typeof limit !== 'number') throw new Error('SIZE_ENTRY_LIMITS 缺少 ' + key + ' 的上限')
    return [key, { heading: MODULE_SECTION_HEADINGS[key], limit, requireSource: true }]
  }))
}
