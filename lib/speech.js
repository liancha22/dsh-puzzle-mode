/**
 * 说话纠正：模型**整句说英文**、或**逐字复述输入**时，下一步注入一条纠正。
 *
 * 为什么需要它（用户原话：「强化防复读效果，就说输出陈述时不要复读输入的内容」
 * 「陈述中文化强化搞一个最硬的约束，现在还是会说英文」）：
 *
 * v0.28.0 起提示段里就写着「一律用中文」「同一件事只说一遍」，**用户实测仍然说英文**。
 * 结论很直接：**光写规则不管用**——提示段是每轮都发，但它是「背景」，模型在长上下文里
 * 不会每句都回头对照。所以这里加一道**检测 + 当场纠正**：
 *   1. 每次陈述发出后扫一遍（`session/event` 的 `assistant/message`）；
 *   2. 命中就记账，在**下一个 step 之前**注入一条纠正（`agent/pre-step` 能改 messages）。
 *
 * 与「重复思考熔断」「催促」的分工：
 *   - 熔断管**动作重复**（同样的工具同样的参数）；
 *   - 催促管**节拍**（走几步了）；
 *   - 本模块管**说话**（用什么语言、是不是在复读）。
 *   三件事判据完全不同，各一个钩子，互不影响。
 *
 * ## 检测口径（宁可漏判，不可误判）
 *
 * **英文**：先剥掉代码块与行内代码（那里本来就该是英文），再看**纯英文行**——
 * 一行里 ≥ {@link ENGLISH_LINE_MIN_WORDS} 个拉丁词、且**一个汉字都没有**，才算英文行；
 * 全篇英文词累计 ≥ {@link ENGLISH_MIN_WORDS} 才判违规。
 * 这样「报错原文：Cannot find module …」这类**引用**不会被误判（它有汉字，且总量不够）。
 *
 * **复读**：把输入（用户消息 / 刚读到的内容）与陈述都压平空白，在陈述里按
 * {@link ECHO_STEP} 步进取 {@link ECHO_WINDOW} 长的窗口，看它是否**逐字**出现在输入里。
 * 命中就是「抄了一段」。
 *
 * 本文件是**纯逻辑**：不碰 fs、不碰 ctx、无 import，只做「这段话算不算违规」
 * 与「注入什么文本」。这样它能被单独 import 测试，hook 本体保持薄。
 */

/** 注入文本的标记，便于在会话里认出这条是谁加的。 */
export const SPEECH_MARK = '【拼图模式 · 说话纠正】'

/**
 * 一行里至少几个拉丁词才算「英文行」。
 *
 * 取 5：`git status`（2 词）、`npm test`（2 词）这类**命令**不该被当成英文句子。
 */
export const ENGLISH_LINE_MIN_WORDS = 5

/**
 * 全篇累计多少个英文词才判违规。
 *
 * 取 12：单条引用（如 `Cannot find module '@deepseek-ai/dsh-tools'`，7 词）不判，
 * 一整句英文（十几个词）才判。**误判比漏判更糟**——误判会打断正在干活的人。
 */
export const ENGLISH_MIN_WORDS = 12

/** 复读检测的窗口长度（字符）。逐字复制 ≥ 这么长才算「抄了一段」。 */
export const ECHO_WINDOW = 24

/**
 * 窗口取样步进。
 *
 * 为什么不是 1：窗口 24、正文几千字时，逐字符做 `includes` 是几十毫秒级的浪费。
 * 步进取 4 的代价是**恰好 24–26 字符的复制可能漏掉**（≥27 字符必中），
 * 这对「宁可漏判」的口径是可以接受的。
 */
export const ECHO_STEP = 4

/** 单条输入参与比对的最大长度：长文件不整份参与，免得一次比对拖慢钩子。 */
export const ECHO_MAX_INPUT = 20000

/** 保留的用户消息条数（最近几条才算「刚说的话」）。 */
export const SPEECH_USER_KEEP = 2

/** 保留的工具输出条数。 */
export const SPEECH_TOOL_KEEP = 3

/** 单条工具输出保留的字符数（只留开头，够判复读即可）。 */
export const SPEECH_TOOL_TEXT_MAX = 4000

/** 跟踪的会话数上限，超了丢最旧的，防止长跑进程把它撑成无限大。 */
export const SPEECH_MAX_SESSIONS = 500

/** 拉丁词（含连字符 / 撇号，覆盖 `don't` / `well-known` 这类）。 */
const LATIN_WORD = /[A-Za-z][A-Za-z'’-]*/g

/** 汉字（含扩展 A 与兼容区）。**只要有一个，这一行就不算纯英文行。** */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g

/** markdown 标题行（`#` 到 `######`）。标题**天然是陈述**，不是代码，所以单独一条更严的规则。 */
const HEADING = /^\s{0,3}#{1,6}\s+/

/**
 * 英文标题的判据：≥ 2 个词、字母总数 ≥ 8、且**有词首大写**。
 *
 * 三个下界各自的由来（都是实测反例）：
 *   - 字母数 ≥ 8：`## op:read` 只有 6 个字母，是**标识符**，要放行；
 *   - 词数 ≥ 2：单个词的标题（`## Progress`）可能只是技术名词，不判；
 *   - **词首大写**：`## git status` 与 `## Next Steps` 都是 2 词 9 字母，
 *     唯一的差别是**大小写**——英文散文标题会大写，而命令引用是小写的。
 *     没有这条就会把「## git status」这种正常的命令标题判成违规。
 */
export const ENGLISH_HEADING_MIN_WORDS = 2
export const ENGLISH_HEADING_MIN_LETTERS = 8

/** 注入文本的两种原因。 */
export const SPEECH_KIND_ENGLISH = 'english'
export const SPEECH_KIND_ECHO = 'echo'

/**
 * 剥掉代码块与行内代码。
 *
 * 为什么必须先剥：代码里本来就该是英文（`const foo = bar`），
 * 拿它去判「说英文」会把每一段带代码的回复都判违规。
 */
export function stripCode(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
}

/** 压平空白：复读检测不该因为换行 / 缩进差异就漏判。 */
export function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 找出**纯英文行**：一行里 ≥ {@link ENGLISH_LINE_MIN_WORDS} 个拉丁词、且无汉字。
 *
 * 另有一条**更严的标题规则**：markdown 标题（`## …`）只要 ≥
 * {@link ENGLISH_HEADING_MIN_WORDS} 个词且字母数 ≥ {@link ENGLISH_HEADING_MIN_LETTERS}
 * 就算——标题天然是陈述，而「英文小标题」正是最容易被漏掉的一种（实测漏过
 * `## Next Steps`：2 个词，够不上正文那 5 词的门槛）。
 *
 * 返回 `{ lines, total }`——`lines` 每条带行号（1 起）与词数，`total` 是全篇英文词数。
 */
export function englishProse(text) {
  const prose = stripCode(text)
  const lines = []
  let total = 0
  const raw = prose.split(/\r?\n/)
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i].trim()
    if (line === '') continue
    // 有汉字 = 中文里夹了个英文词（技术名词 / 引用），不是「整句英文」。
    if ((line.match(CJK) ?? []).length > 0) continue
    const words = line.match(LATIN_WORD) ?? []
    const letters = words.join('').length
    const isHeading = HEADING.test(line)
    const bodyHit = words.length >= ENGLISH_LINE_MIN_WORDS
    // 词首大写：英文散文标题会大写（`Next Steps`），命令引用不会（`git status`）。
    const capitalized = words.some((word) => /^[A-Z]/.test(word))
    const headingHit = isHeading
      && words.length >= ENGLISH_HEADING_MIN_WORDS
      && letters >= ENGLISH_HEADING_MIN_LETTERS
      && capitalized
    if (!bodyHit && !headingHit) continue
    lines.push({ at: i + 1, line, words: words.length })
    total += words.length
  }
  return { lines, total }
}

/**
 * 这段陈述是不是「整句说英文」。`ok: true` 表示**违规**。
 *
 * 两条独立的触发（任一命中即违规）：
 *   1. 全篇英文词累计 ≥ {@link ENGLISH_MIN_WORDS}；
 *   2. **有英文标题**——标题天然是陈述，且它往往只有两三个词，
 *      够不到 (1) 的门槛（实测漏过 `## Next Steps`）。
 */
export function detectEnglish(text) {
  const { lines, total } = englishProse(text)
  const headings = lines.filter((item) => HEADING.test(item.line))
  if (headings.length > 0) {
    return { ok: true, words: total, sample: headings[0].line.slice(0, 80), heading: true }
  }
  if (total < ENGLISH_MIN_WORDS) return { ok: false, words: total, sample: '', heading: false }
  return { ok: true, words: total, sample: lines.length > 0 ? lines[0].line.slice(0, 80) : '', heading: false }
}

/**
 * 这段陈述是不是**逐字复述**了某条输入。
 *
 * `inputs` 是 `[{ source, text }]`（source 是 `'user'` / `'tool'`，只用于文案）。
 * 返回 `{ ok, run, sample, source }`——`ok: true` 表示**违规**。
 */
export function detectEcho(assistantText, inputs = []) {
  const prose = collapse(stripCode(assistantText))
  if (prose.length < ECHO_WINDOW) return { ok: false, run: 0, sample: '', source: '' }
  const list = Array.isArray(inputs) ? inputs : []
  for (const raw of list) {
    const item = raw !== null && typeof raw === 'object' ? raw : {}
    const source = typeof item.source === 'string' ? item.source : ''
    const text = collapse(item.text)
    if (text === '') continue
    const hay = text.slice(0, ECHO_MAX_INPUT)
    if (hay.length < ECHO_WINDOW) continue
    for (let i = 0; i + ECHO_WINDOW <= prose.length; i += ECHO_STEP) {
      const window = prose.slice(i, i + ECHO_WINDOW)
      if (hay.includes(window)) {
        return { ok: true, run: ECHO_WINDOW, sample: window.slice(0, 80), source }
      }
    }
  }
  return { ok: false, run: 0, sample: '', source: '' }
}

/**
 * 综合判定。**英文优先**——它是用户点名「最硬的约束」的那一条。
 *
 * 返回 `{ violation, kind, words, run, sample, source }`。
 */
export function speechViolation(text, inputs = []) {
  const english = detectEnglish(text)
  if (english.ok === true) {
    return { violation: true, kind: SPEECH_KIND_ENGLISH, words: english.words, run: 0, sample: english.sample, source: '' }
  }  const echo = detectEcho(text, inputs)
  if (echo.ok === true) {
    return { violation: true, kind: SPEECH_KIND_ECHO, words: 0, run: echo.run, sample: echo.sample, source: echo.source }
  }
  return { violation: false, kind: '', words: 0, run: 0, sample: '', source: '' }
}

/* ------------------------------ 会话级状态（只存内存） ------------------------------ */

/**
 * 为什么只存内存、不落盘：进程重启后清零是**安全**的——重启本身就把
 * 「模型刚才说了句英文」这个事实打断了，新进程第一步没有历史可比。
 */
const traces = new Map()
const pending = new Map()

function emptyTrace() {
  return { users: [], tools: [] }
}

function save(map, key, value) {
  map.set(key, value)
  if (map.size > SPEECH_MAX_SESSIONS) {
    const oldest = map.keys().next().value
    if (oldest !== key) map.delete(oldest)
  }
}

/**
 * 记一条**输入**（用户消息或工具输出），供后续复读比对。
 *
 * `source` 只认 `'user'` / `'tool'`；空文本不记。
 */
export function rememberInput(sessionId, source, text) {
  const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : ''
  const body = String(text ?? '').trim()
  if (key === '' || body === '') return false
  const trace = traces.get(key) ?? emptyTrace()
  const list = source === 'tool' ? trace.tools : trace.users
  list.push(source === 'tool' ? body.slice(0, SPEECH_TOOL_TEXT_MAX) : body)
  const keep = source === 'tool' ? SPEECH_TOOL_KEEP : SPEECH_USER_KEEP
  while (list.length > keep) list.shift()
  save(traces, key, trace)
  return true
}

/** 这个会话当前记着的输入（诊断 / 测试用）。 */
export function inputsOf(sessionId) {
  const trace = traces.get(typeof sessionId === 'string' ? sessionId : '')
  if (trace === undefined) return []
  return [
    ...trace.users.map((text) => ({ source: 'user', text })),
    ...trace.tools.map((text) => ({ source: 'tool', text })),
  ]
}

/**
 * 记一条**陈述**；违规就挂起一条待注入的纠正。
 *
 * 返回判定结果（`{ violation, kind, … }`），调用方一般不用管返回值。
 */
export function noteStatement(sessionId, text) {
  const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : ''
  if (key === '') return { violation: false, kind: '', words: 0, run: 0, sample: '', source: '' }
  const result = speechViolation(text, inputsOf(key))
  if (result.violation === true) save(pending, key, result)
  return result
}

/** 看一眼挂起的违规（**不消费**）——用于「先把上下文造好、再落闸」。 */
export function peekViolation(sessionId) {
  return pending.get(typeof sessionId === 'string' ? sessionId : '') ?? null
}

/**
 * 消费掉挂起的违规。
 *
 * 调用顺序必须是**先 peek → 造上下文 → 再 take**：反了的话，
 * 造上下文那一步万一抛错，纠正就永远丢了（本仓在首轮判定上踩过同一个坑）。
 */
export function takeViolation(sessionId) {
  const key = typeof sessionId === 'string' ? sessionId : ''
  const value = pending.get(key) ?? null
  pending.delete(key)
  return value
}

/** 清掉一个会话的全部状态（测试 / 诊断用）。 */
export function clearSpeech(sessionId) {
  const key = typeof sessionId === 'string' ? sessionId : ''
  traces.delete(key)
  return pending.delete(key)
}

/** 清空全部会话（测试用）。 */
export function resetSpeech() {
  traces.clear()
  pending.clear()
}

/**
 * 生成纠正文本。
 *
 * 语气刻意**硬**（用户点名要「最硬的约束」），但每条都落到动作上：
 * 用中文重说 / 只写新结论。只骂不给出路的纠正，模型只能干看着。
 */
export function speechFixText(violation) {
  const item = violation !== null && typeof violation === 'object' ? violation : {}
  const sample = typeof item.sample === 'string' && item.sample !== '' ? item.sample : ''
  if (item.kind === SPEECH_KIND_ECHO) {
    const source = item.source === 'tool' ? '刚读到的内容' : (item.source === 'user' ? '用户说的话' : '输入内容')
    return [
      `${SPEECH_MARK}（复读）`,
      '',
      `你刚才的陈述里**逐字复述**了${source}（连续 ${item.run ?? ECHO_WINDOW} 个字符）：`,
      sample === '' ? '' : `> ${sample}`,
      '',
      '**不许复读输入**：用户说的话、刚读到的文件内容 / 命令输出，都不要抄进陈述。',
      '陈述只写**你新得出的结论**与**下一步动作**；要引用原文就给位置（`文件:行`），别整段搬。',
      '',
      '不要解释、不要道歉——直接给新结论。',
    ].filter((line) => line !== '').join('\n')
  }
  return [
    `${SPEECH_MARK}（英文）`,
    '',
    `你刚才那段陈述里有**整句英文**（共 ${item.words ?? 0} 个英文词）：`,
    sample === '' ? '' : `> ${sample}`,
    '',
    '**立刻改用中文重说。** 正文、结论、进度、解释、列表、标题——**全部中文**。',
    '英文只允许出现在四种位置：**代码 / 标识符 / 文件路径 / 命令与报错原文**。',
    '',
    '不要解释、不要道歉——直接用中文继续。',
  ].filter((line) => line !== '').join('\n')
}
