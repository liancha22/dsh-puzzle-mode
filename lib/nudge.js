/**
 * 干活催促：模型**只看不动**时，注入一条语气犀利的催促，把它推向产出。
 *
 * 为什么需要它（用户原话：「干活都磨磨唧唧的，加一个自动注入语音犀利的催促的功能」）：
 * 模型在长任务里会陷进「读读读」——连续十几次 read / grep / glob，一行产出都没有。
 * 每一轮上下文都要重发一遍，所以磨蹭的每一步都是实打实的成本；而模型自己感觉不到
 * 「我已经看了六轮」——它只看见「我再确认一下就好」。
 *
 * ## 为什么判据是「连续只读调用」而不是「花了多少时间」
 *
 * 时间在这个钩子上**拿不到**：`tools/post-execute` 的入参只有这次调用本身，
 * 没有 step 起点、没有 turn 时长。而「连续 N 次只读调用、中间没有任何产出动作」
 * 是**确定性指纹**，可以纯函数测试——这与熔断选「工具调用签名」是同一个理由。
 *
 * ## 两条触发
 *
 *   1. **只读连击**：连续 {@link NUDGE_READ_STREAK} 次只读调用都没有产出。
 *      之后每 {@link NUDGE_ESCALATE_EVERY} 次再催一次，语气逐级加硬。
 *   2. **分段读**：同一个文件被读第二次（见 {@link NUDGE_SAME_FILE}）。
 *      这正是用户说的「读文件老是分段读」——`limit` 一次给足就够，
 *      一段一段读同一个文件纯属磨蹭。
 *
 * ## 误报防线（宁可漏催，不可误催）
 *
 * 1. **未知工具一律当「产出」并重置连击**：只读白名单只有 read / grep / glob。
 *    正经的只读任务（大审查）会被催一次，但绝不会把「刚写完文件」当成磨蹭。
 * 2. **阈值 {@link NUDGE_READ_STREAK}**：连着读五个文件是正常调研，
 *    第六个还没动手才值得开口。
 * 3. **催促必须给出口**：只骂「你太慢了」等于没给信息——每条催促都要说清
 *    「现在就该做什么」（改文件 / 跑命令 / 给结论）。
 *
 * 本文件是**纯逻辑**：不碰 fs、不碰 ctx、无 import，只做「这次算不算磨蹭」
 * 与「注入什么文本」。这样它能被单独 import 测试，hook 本体保持薄。
 */

/**
 * 连续多少次**只读**调用没有产出，就开始催。
 *
 * 取 6 是刻意的保守值：连着读 5 个文件属于正常调研（一次审查就要读十几个），
 * 第 6 次还没动手才说明它在原地翻。宁可漏催一次，也不要把正经的只读任务打断。
 */
export const NUDGE_READ_STREAK = 6

/**
 * 催过之后每隔多少次再催一次。
 *
 * 与熔断同一个道理：**沉默比重复更贵**。催一次就闭嘴，等于模型被点名后
 * 后面每次磨蹭都无人过问，链条继续空转。
 */
export const NUDGE_ESCALATE_EVERY = 4

/**
 * 催促语气的档位上限。第 1 档是「先产出一步」，第 2 档禁掉只读工具，
 * 第 3 档最硬。到顶之后仍按 {@link NUDGE_ESCALATE_EVERY} 继续催（只是文案不再加码）。
 */
export const NUDGE_MAX_LEVEL = 3

/**
 * 同一个文件被读第几次就算「分段读」。
 *
 * 取 2：第一次读一个文件永远正常；**读第二次**就是一段一段读同一个文件，
 * 正是用户抱怨的那个动作。修法写在催促里——一次把 limit 给足。
 */
export const NUDGE_SAME_FILE = 2

/** 记住的「读过的文件」条数上限：只读长跑时别把内存撑大。 */
export const NUDGE_FILE_KEYS_MAX = 200

/** 跟踪的会话数上限，超了丢最旧的，防止长跑进程把它撑成无限大。 */
export const NUDGE_MAX_SESSIONS = 500

/** 注入文本的标记，便于在会话里认出这条是谁加的。 */
export const NUDGE_MARK = '【拼图模式 · 催促】'

/**
 * **只读**工具白名单——只有它们算「没有产出」。
 *
 * 白名单之外的一切（write / edit / pwsh / bash / puzzle_mode / ask_user_question…）
 * 都算产出并重置连击。这是刻意的保守：漏催一个磨蹭的会话，代价是慢一轮；
 * 误催一个正在写代码的会话，代价是把它从正经活上打断。
 */
export const READ_ONLY_TOOLS = Object.freeze(['read', 'grep', 'glob'])

/** 触发原因：连续只读调用没有产出。 */
export const NUDGE_REASON_STREAK = 'read-streak'

/** 触发原因：同一个文件被读第二次（分段读）。 */
export const NUDGE_REASON_REPEAT = 'repeat-read'

/** 这个工具名算不算「只读探查」。 */
export function isReadOnlyTool(toolName) {
  return typeof toolName === 'string' && READ_ONLY_TOOLS.includes(toolName)
}

/**
 * 这次调用在读哪个文件。只有 `read` 有单一目标；`grep` / `glob` 是范围检索，
 * 没有「同一个文件」这个概念，所以返回空串（不参与分段读判定）。
 */
export function readTargetOf(toolName, args) {
  if (toolName !== 'read') return ''
  const input = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const value = typeof input.file_path === 'string' ? input.file_path.trim() : ''
  return value
}

/**
 * 会话级的只读连击状态（只存内存）。
 *
 * 为什么只存内存、不落盘：进程重启后清零是**安全**的——重启本身就把
 * 「模型刚才在磨蹭」这个事实打断了，而且新进程的第一步没有历史可比。
 */
const states = new Map()

function emptyState() {
  return { streak: 0, reported: 0, reportedAt: 0, files: new Map(), nudged: new Set() }
}

const IDLE = Object.freeze({ streak: 0, shouldNudge: false, reason: '', level: 0, target: '' })

/**
 * 记一次调用，返回这次要不要催、以及催什么。
 *
 * 返回 `{ streak, shouldNudge, reason, level, target }`：
 *   - `shouldNudge === false` → 调用方原样放行；
 *   - `reason` → {@link NUDGE_REASON_STREAK}（只读连击）或
 *     {@link NUDGE_REASON_REPEAT}（分段读），文案由 {@link nudgeText} 按它选；
 *   - `level` → 只读连击是**这一段连击的第几次**催促（1 起）；
 *     分段读恒为 0（它有自己的专属文案，不吃档位）。
 *
 * 参数 `args` 是工具入参原文，只有 `read` 会用到（取 `file_path`）。
 */
export function noteCall(sessionId, toolName, args) {
  const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : ''
  if (key === '') return IDLE
  // 不是只读调用 = 有产出（或至少是别的动作）→ 连击归零，状态直接丢掉。
  // 「丢掉」而不是「置零保留」：files / nudged 是这一段连击的上下文，
  // 留着只会让下一次连击继承上一段的「读过的文件」，把分段读判定变成跨段误报。
  if (!isReadOnlyTool(toolName)) {
    states.delete(key)
    return IDLE
  }
  const previous = states.get(key) ?? emptyState()
  const streak = previous.streak + 1
  const target = readTargetOf(toolName, args)

  const files = new Map(previous.files)
  if (target !== '') files.set(target, (files.get(target) ?? 0) + 1)
  while (files.size > NUDGE_FILE_KEYS_MAX) {
    const oldest = files.keys().next().value
    files.delete(oldest)
  }

  // 触发一：同一个文件读到第 NUDGE_SAME_FILE 次 = 分段读。
  // **每个文件只催一次**（`nudged` 记住已经催过的），否则同一个文件读十次会催九次。
  const repeat = target !== ''
    && (files.get(target) ?? 0) >= NUDGE_SAME_FILE
    && !previous.nudged.has(target)

  // 触发二：连续只读到阈值，且离上次催够远。
  const streakHit = streak >= NUDGE_READ_STREAK
    && (previous.reportedAt === 0 || streak - previous.reportedAt >= NUDGE_ESCALATE_EVERY)

  const nudged = new Set(previous.nudged)
  if (repeat) nudged.add(target)

  if (repeat) {
    // 分段读**不消耗**连击的节流：两条触发各有各的节流（这里是「每个文件一次」）。
    // 合用一个计数会让先到的分段读把后面的只读连击顶掉，那正是最该催的那一次。
    states.set(key, { ...previous, streak, files, nudged })
    if (states.size > NUDGE_MAX_SESSIONS) {
      const oldest = states.keys().next().value
      if (oldest !== key) states.delete(oldest)
    }
    return { streak, shouldNudge: true, reason: NUDGE_REASON_REPEAT, level: 0, target }
  }

  if (!streakHit) {
    states.set(key, { ...previous, streak, files, nudged })
    if (states.size > NUDGE_MAX_SESSIONS) {
      const oldest = states.keys().next().value
      if (oldest !== key) states.delete(oldest)
    }
    return { streak, shouldNudge: false, reason: '', level: 0, target }
  }

  const reported = previous.reported + 1
  const level = Math.min(reported, NUDGE_MAX_LEVEL)
  states.set(key, { streak, reported, reportedAt: streak, files, nudged })
  if (states.size > NUDGE_MAX_SESSIONS) {
    const oldest = states.keys().next().value
    if (oldest !== key) states.delete(oldest)
  }
  return { streak, shouldNudge: true, reason: NUDGE_REASON_STREAK, level, target }
}

/** 这个会话当前的催促状态（诊断 / 测试用）。 */
export function nudgeStateOf(sessionId) {
  const state = states.get(typeof sessionId === 'string' ? sessionId : '')
  if (state === undefined) return null
  return { ...state, files: new Map(state.files), nudged: new Set(state.nudged) }
}

/** 清掉一个会话的催促状态（测试 / 用户重新说话时用）。 */
export function clearNudge(sessionId) {
  return states.delete(typeof sessionId === 'string' ? sessionId : '')
}

/** 清空全部会话（测试用）。 */
export function resetNudge() {
  states.clear()
}

/**
 * 生成催促文本。
 *
 * 语气刻意**犀利**（用户点名要的），但每条都必须落到一个动作上：
 * 「现在就产出」+ 具体产出什么。只骂不给出路的催促，模型只能干看着。
 *
 * 三档的加码方式是**撤出口**，与熔断同一个手法：
 *   第 1 档还允许「说清你在找什么」；第 2 档直接禁掉只读工具；
 *   第 3 档只留「写结论 + 执行下一步」。
 */
export function nudgeText(reason, streak, level = 1, target = '') {
  const times = Number.isSafeInteger(streak) && streak > 0 ? streak : NUDGE_READ_STREAK
  const rank = Number.isSafeInteger(level) && level > 0 ? Math.min(level, NUDGE_MAX_LEVEL) : 1
  const file = typeof target === 'string' ? target : ''

  if (reason === NUDGE_REASON_REPEAT) {
    return [
      `${NUDGE_MARK}（分段读）`,
      '',
      file === ''
        ? `同一个文件你已经在读了——这是它第 ${NUDGE_SAME_FILE} 次被 read。`
        : `\`${file}\` 你已经在读了——这是它第 ${NUDGE_SAME_FILE} 次被 read。`,
      '**一次读全**：把 `limit` 给足（整份读完，或一次读到你真正要的范围），'
        + '不要一段一段读同一个文件；读完就用，别回头再翻。',
      '',
      '手上还有几个文件要一起看？**同一步里并行发多个 read**，别一个一个串着等。',
    ].join('\n')
  }

  const head = [
    rank <= 1 ? NUDGE_MARK : `${NUDGE_MARK}（第 ${rank} 次）`,
    '',
  ]
  if (rank <= 1) {
    return [
      ...head,
      `你已经**连续 ${times} 次只读调用**（${READ_ONLY_TOOLS.join(' / ')}），一行产出都没有。`,
      '**现在停止检索，先产出一步**：写下你已经确定的结论，或直接动手改那个文件 / 跑那条命令。',
      '',
      '还在翻下一个文件？先说清它要回答哪一个**具体**问题——说不出，那就是在拖。',
    ].join('\n')
  }
  if (rank === 2) {
    return [
      ...head,
      `又 ${NUDGE_ESCALATE_EVERY} 次只读调用过去了，还是没产出。这不是谨慎，是磨蹭。`,
      '用你**手上已有**的信息做最小可交付的一步：改一个文件、跑一条命令、给一个结论。现在就做。',
      '',
      `⚠️ **不许再调 ${READ_ONLY_TOOLS.join(' / ')}**。真缺信息，就用一句话说清缺哪一条——别再「再看看」。`,
    ].join('\n')
  }
  return [
    ...head,
    `第 ${rank} 次了。你在原地打转，用户看得见。`,
    '立刻交付：把现在的结论写出来 + 执行下一步动作。没有别的选项。',
    '',
    '再读一次文件就是又一次空转——这一轮的每一秒都在烧成本。',
  ].join('\n')
}
