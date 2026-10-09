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
 * **「我的意思是干什么都四步催一次」**——要的是**节拍**，不是「只读」这个特征。
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
 * ## ⚠️ 文案为什么**必须短**（v1.1.2，用户报的「复读机」）
 *
 * 第一版文案是多行模板（4 行），而且里面写着「**一句话报进度** + 直接做下一步」。
 * 两个后果实测都出现了：
 *
 *   1. **模型照做了**——每到一个节拍就写一句「进度播报」。这些播报句式几乎一样
 *      （「数据出来了」「数据坐实了」「关键事实到齐了」），用户看到的正是
 *      **一串相似的话**。催促是**节拍器**，它该做的是把人推去做下一步，
 *      而不是命令对方先汇报一句。所以「报进度」这条指令被**撤掉**了。
 *   2. 模板越长，同一段话被重复注入时的体积越大。一条催促正文压到**一行**，
 *      同样的条数下，用户读到的字少了四分之三。
 *
 * 现在第 1 档就是一行：**报步数 + 催 + 指一个动作**。
 *
 * 本文件是**纯逻辑**：不碰 fs、不碰 ctx、无 import，只做「这一步算不算一个节拍」
 * 与「注入什么文本」。这样它能被单独 import 测试，hook 本体保持薄。
 */

/**
 * 每多少次工具调用催一次。
 *
 * 先是「干什么都四步催一次」，随后用户改为 6；v1.1.2 起改为 **12**。
 *
 * 为什么再放宽一倍：用户报「一直跟个复读机一样说相似的话」，而催促是
 * **确定会重复**的那一条（每到一个节拍必注入一次）。6 步的节拍在长任务里
 * 意味着几十条内容几乎相同的注入。放宽到 12 让条数直接减半，
 * 而「每 N 步」这个语义没变——它仍然是纯节拍。
 */
export const NUDGE_EVERY = 12

/**
 * 催促语气的档位上限。第 1 档是一行轻推，第 2 档禁掉只读工具，
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
 * 催促的**标志性那句**（用户指定原文：加进催促里）。
 *
 * 单独抽成常量有两个理由：
 *   1. 测试与面板引用它，改文案不会让断言漂移；
 *   2. 它是这条注入的**身份**——三档文案都带它，用户一眼能认出「又是那句催促」。
 */
export const NUDGE_PUSH = '你怎么这么慢，快点做啊'

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
 * ## 三条硬规则（都是实测换来的）
 *
 * 1. **每条都必须落到一个动作上**：只骂不给出路的催促，模型只能干看着。
 *    所以每档都写着「下一步做什么」。
 * 2. **第 1 档只有一行**（v1.1.2）：它是出现次数最多的一档，体积必须最小。
 * 3. **不许叫模型「报进度」**（v1.1.2）：那正是「复读机」的来源——
 *    每个节拍命令它写一句进度，写出来的就是十几句几乎相同的话。
 *    催促是节拍器，它推的是**动作**，不是汇报。
 *
 * 三档的加码方式是**撤出口**，与熔断同一个手法：
 *   第 1 档一行轻推；第 2 档直接禁掉只读工具；第 3 档只留「写结论 + 执行下一步」。
 */
export function nudgeText(reason, count, level = 1, target = '') {
  const steps = Number.isSafeInteger(count) && count > 0 ? count : NUDGE_EVERY
  const rank = Number.isSafeInteger(level) && level > 0 ? Math.min(level, NUDGE_MAX_LEVEL) : 1
  const file = typeof target === 'string' ? target : ''

  if (reason === NUDGE_REASON_REPEAT) {
    const where = file === '' ? '同一个文件' : `\`${file}\``
    return `${NUDGE_MARK}（分段读） ${where} 你已经在读了（第 ${NUDGE_SAME_FILE} 次）——`
      + '一次读全：把 `limit` 给足；还有别的文件要一起看，就**同一步里并行发多个 read**，别串着等。'
  }

  if (rank <= 1) {
    // 一行。出现次数最多的一档，体积最小。
    return `${NUDGE_MARK} 第 ${steps} 步了——${NUDGE_PUSH}。直接做下一步。`
  }

  if (rank === 2) {
    return `${NUDGE_MARK}（第 ${rank} 次） ${steps} 步了，这几步**全是只读**、一行产出都没有——${NUDGE_PUSH}。`
      + `用**手上已有**的信息做最小可交付的一步：改一个文件、跑一条命令、给一个结论。`
      + `⚠️ **不许再调 ${READ_ONLY_TOOLS.join(' / ')}**——真缺信息就用一句话说清缺哪一条。`
  }

  return `${NUDGE_MARK}（第 ${rank} 次） ${steps} 步了还在原地打转——${NUDGE_PUSH}。`
    + '立刻交付：把结论写出来 + 执行下一步动作。再读一次文件就是又一次空转。'
}
