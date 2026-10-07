/**
 * 干活催促：**每 N 步催一次**，把模型从磨蹭里推出来。
 *
 * 为什么需要它（用户原话：「干活都磨磨唧唧的，加一个自动注入语音犀利的催促的功能」）：
 * 模型在长任务里会陷进「一直动但不出活」——读读读、试试试，用户在旁边干等。
 * 每一轮上下文都要重发一遍，所以磨蹭的每一步都是实打实的成本；
 * 而模型自己感觉不到「我已经走了十几步」——它只看见「我再确认一下就好」。
 *
 * ## 判据为什么是「纯节奏」而不是「连续只读」
 *
 * 第一版做的是「连续 N 次**只读**调用才催」，用户当场纠正：
 * **「我的意思是干什么都四步催一次」**（该值随后由用户改为 6）——要的是**节拍**，不是「只读」这个特征。
 * 于是改成纯计数：**每 {@link NUDGE_EVERY} 次工具调用就催一次**，不分读写。
 *
 * 这个口径还有个实际好处：它不依赖「什么算只读」这张白名单。
 * 白名单一改（多一个工具、少一个工具），触发点就漂移；而纯计数是确定的。
 * 白名单仍然保留，但只用来决定**语气轻重**（见下），不再决定**要不要催**。
 *
 * ## 两条触发
 *
 *   1. **节拍**：每 {@link NUDGE_EVERY} 次工具调用催一次（主触发，用户要的就是它）。
 *   2. **分段读**：同一个文件被读第二次（{@link NUDGE_SAME_FILE}）额外点名一次。
 *      这正是用户说的「读文件老是分段读」——`limit` 一次给足就够。
 *
 * ## 语气怎么加码
 *
 * 节拍的**档位**看「这几步里有没有产出」：
 *   - 中间有产出（写过文件 / 跑过命令）→ 每次都停在**第 1 档**：轻推一句「报进度 + 做下一步」。
 *     干活的人不该被骂，只该被提醒别攒着不报。
 *   - 一直只读、一行产出都没有 → 档位逐次加硬（第 2 档禁掉只读工具，第 3 档只留交付）。
 *
 * 于是「每 {@link NUDGE_EVERY} 步一催」是**确定**的，而「催得多凶」是**看表现**的——两者分开，
 * 既不漏催，也不至于把正在写代码的人当磨蹭的人骂。
 *
 * 本文件是**纯逻辑**：不碰 fs、不碰 ctx、无 import，只做「这一步算不算一个节拍」
 * 与「注入什么文本」。这样它能被单独 import 测试，hook 本体保持薄。
 */

/**
 * 每多少次工具调用催一次。**用户裁定为 6**（先是「干什么都四步催一次」，随后改为 6 步）。
 *
 * 这是纯节拍：不管这 6 步是读、是写、是跑命令，到点就催。
 */
export const NUDGE_EVERY = 6

/**
 * 催促语气的档位上限。第 1 档是「报进度 + 做下一步」，第 2 档禁掉只读工具，
 * 第 3 档只留「写结论 + 执行下一步」。到顶后仍按节拍继续催（只是文案不再加码）。
 */
export const NUDGE_MAX_LEVEL = 3

/**
 * 同一个文件被读第几次就算「分段读」。
 *
 * 取 2：第一次读一个文件永远正常；**读第二次**就是一段一段读同一个文件，
 * 正是用户抱怨的那个动作。修法写在催促里——一次把 `limit` 给足。
 */
export const NUDGE_SAME_FILE = 2

/** 记住的「读过的文件」条数上限：只读长跑时别把内存撑大。 */
export const NUDGE_FILE_KEYS_MAX = 200

/** 跟踪的会话数上限，超了丢最旧的，防止长跑进程把它撑成无限大。 */
export const NUDGE_MAX_SESSIONS = 500

/** 注入文本的标记，便于在会话里认出这条是谁加的。 */
export const NUDGE_MARK = '【拼图模式 · 催促】'

/**
 * **只读**工具名单——它**不再决定要不要催**（节拍决定），只决定**语气轻重**：
 * 这几步里只要出现过名单之外的调用，就算「有产出」，档位停在第 1 档。
 *
 * 名单刻意短：`write` / `edit` / `pwsh` / `bash` / `puzzle_mode`… 都算产出。
 * 宁可把「有产出」判宽一点（少骂一句），也不要误判成磨蹭（骂错人）。
 */
export const READ_ONLY_TOOLS = Object.freeze(['read', 'grep', 'glob'])

/** 触发原因：到了节拍（每 NUDGE_EVERY 次工具调用）。 */
export const NUDGE_REASON_CADENCE = 'cadence'

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
 * 会话级的催促状态（只存内存）。
 *
 * 为什么只存内存、不落盘：进程重启后计数清零是**安全**的——重启本身就把
 * 「模型刚才在磨蹭」这个事实打断了，而且新进程的第一步没有历史可比。
 */
const states = new Map()

function emptyState() {
  return { count: 0, level: 0, produced: false, files: new Map(), nudged: new Set() }
}

const IDLE = Object.freeze({ count: 0, shouldNudge: false, reason: '', level: 0, target: '' })

/**
 * 记一次调用，返回这次要不要催、以及催什么。
 *
 * 返回 `{ count, shouldNudge, reason, level, target }`：
 *   - `shouldNudge === false` → 调用方原样放行；
 *   - `count` → 本会话累计的工具调用步数（节拍的分母）；
 *   - `reason` → {@link NUDGE_REASON_CADENCE}（到节拍）或
 *     {@link NUDGE_REASON_REPEAT}（分段读），文案由 {@link nudgeText} 按它选；
 *   - `level` → 节拍的档位（1 起，看这几步有没有产出）；分段读恒为 0
 *     （它有自己的专属文案，不吃档位）。
 *
 * 参数 `args` 是工具入参原文，只有 `read` 会用到（取 `file_path`）。
 */
export function noteCall(sessionId, toolName, args) {
  const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : ''
  if (key === '') return IDLE
  const name = typeof toolName === 'string' ? toolName : ''
  if (name === '') return IDLE

  const previous = states.get(key) ?? emptyState()
  const count = previous.count + 1
  const target = readTargetOf(name, args)
  // 「这几步有没有产出」：出现任何一个非只读工具就算有。它在节拍命中时被消费并复位。
  const produced = previous.produced || !isReadOnlyTool(name)

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

  // 触发二：到节拍。**纯计数**，不看工具类型——用户要的就是「干什么都每 N 步催一次」。
  const cadence = count % NUDGE_EVERY === 0

  const nudged = new Set(previous.nudged)
  if (repeat) nudged.add(target)

  const save = (next) => {
    states.set(key, next)
    if (states.size > NUDGE_MAX_SESSIONS) {
      const oldest = states.keys().next().value
      if (oldest !== key) states.delete(oldest)
    }
  }

  if (repeat) {
    // 分段读**不消费节拍**：两条触发各有各的节流（这里是「每个文件一次」）。
    // 合用一个计数会让先到的分段读把节拍顶掉，那正是最该催的那一次。
    // `produced` 也不在这里复位——它只由节拍消费。
    save({ count, level: previous.level, produced, files, nudged })
    return { count, shouldNudge: true, reason: NUDGE_REASON_REPEAT, level: 0, target }
  }

  if (!cadence) {
    save({ count, level: previous.level, produced, files, nudged })
    return { count, shouldNudge: false, reason: '', level: 0, target }
  }

  // 到节拍：有产出 → 停在第 1 档（轻推，别骂干活的人）；一直只读 → 逐次加硬。
  const level = produced ? 1 : Math.min(previous.level + 1, NUDGE_MAX_LEVEL)
  save({ count, level, produced: false, files, nudged })
  return { count, shouldNudge: true, reason: NUDGE_REASON_CADENCE, level, target }
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
 * 「报进度」+「做下一步」。只骂不给出路的催促，模型只能干看着。
 *
 * 节拍的三档加码方式是**撤出口**，与熔断同一个手法：
 *   第 1 档还允许「说清你在找什么」；第 2 档直接禁掉只读工具；
 *   第 3 档只留「写结论 + 执行下一步」。
 */
export function nudgeText(reason, count, level = 1, target = '') {
  const steps = Number.isSafeInteger(count) && count > 0 ? count : NUDGE_EVERY
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
      `已经走了 **${steps} 步**工具调用（每 ${NUDGE_EVERY} 步提醒一次）。`,
      '**一句话报进度 + 直接做下一步**：现在到哪了、下一步是什么，然后立刻动手。'
        + '别攒着不报，也别停在原地反复确认。',
      '',
      '还在翻下一个文件？先说清它要回答哪一个**具体**问题——说不出，那就是在拖。',
    ].join('\n')
  }
  if (rank === 2) {
    return [
      ...head,
      `${steps} 步了，而且这几步**全是只读**——一行产出都没有。这不是谨慎，是磨蹭。`,
      '用你**手上已有**的信息做最小可交付的一步：改一个文件、跑一条命令、给一个结论。现在就做。',
      '',
      `⚠️ **不许再调 ${READ_ONLY_TOOLS.join(' / ')}**。真缺信息，就用一句话说清缺哪一条——别再「再看看」。`,
    ].join('\n')
  }
  return [
    ...head,
    `${steps} 步，第 ${rank} 次催了。你在原地打转，用户看得见。`,
    '立刻交付：把现在的结论写出来 + 执行下一步动作。没有别的选项。',
    '',
    '再读一次文件就是又一次空转——这一轮的每一秒都在烧成本。',
  ].join('\n')
}
