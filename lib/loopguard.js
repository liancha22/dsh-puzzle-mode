/**
 * 重复思考熔断：模型**绕着圈走**时，把一条「别重复了」的提示送到它面前。
 *
 * 为什么需要它：长任务里模型会陷进「同一步反复做同一件事」——反复读同一个文件、
 * 反复跑同一条命令、反复用同样的参数调同一个工具。每一轮都把整个上下文重发一遍，
 * 所以**空转的每一轮都是真金白银**，而且模型自己往往出不来（它看不到「我刚做过」）。
 * 这个模块就是那道熔断：连续撞同一个动作 N 次，就注入一条提示把它推出去。
 *
 * ## 为什么挂在 `tools/post-execute`，而不是 `agent/pre-step`
 *
 * 这是本仓已经用**假绿**换来的教训（见 `test/40-pre-execute.test.mjs` 开头）：
 * `agent/pre-step` 的 `decision.messages` 契约是 **`UserMessage[]`**，
 * **里面根本没有 tool-call**。想从 pre-step 的「消息」里认出「模型刚才调了什么工具」
 * 是**读不到的**——旧测试伪造了一条带 tool-call 的 assistant 消息，于是断言全绿，
 * 而真实运行时永远走不到那个分支。
 *
 * 真实的工具调用只在 `ToolExecution` 上（`exec.name` / `exec.arguments`），
 * 那是 `tools/pre-execute` / `tools/post-execute` 的入参。本模块用后者，
 * 因为 `post-execute` 的 `additionalContexts` 是**唯一**能「不拦、不打断、
 * 只提醒一句」的通道（`pre-execute` 的 allow 分支会忽略 reason 字段）。
 *
 * ## 判据为什么是「工具调用签名」而不是「推理文本」
 *
 * 抓思维链要读模型输出的 reasoning，形状随模型/版本变，拿不稳；而「重复思考」
 * 在**动作层**有确定性指纹：同名工具 + 同参数。这个口径可纯函数测试，
 * 也正是用户裁定选它的原因。
 *
 * ## 误报防线（宁可漏报，不可误伤）
 *
 * 1. **无参调用一律不计**：`android_get_state` / `job_list` / 截图这类「轮询」工具
 *    反复调是**正常行为**，不是绕圈。参数为空即跳过。
 * 2. **阈值 3**：连续 2 次相同调用是极常见的正当行为（改完再跑一次测试），
 *    留一步容错。
 * 3. **同一段连击只报一次**：报过之后要等签名**变了**才重新武装，
 *    否则第 4、5、6 次会各报一条，比不报更烦。
 *
 * 本文件是**纯逻辑**：不碰 fs、不碰 ctx、无 import，只做「这个动作算不算重复」
 * 与「注入什么文本」。这样它能被单独 import 测试，hook 本体保持薄。
 */

/** 连续多少次相同签名算绕圈。用户裁定为 3。 */
export const LOOP_REPEAT_THRESHOLD = 3

/**
 * 熔断**之后**每隔多少次再报一次（升级提醒）。
 *
 * 为什么必须有这个数：最初的实现是「同一段连击只报一次」，报完就永久闭嘴——
 * 实测的后果是**模型被点名后没改，后面第 4、5、6…次全部静默放行**，
 * 链条要么原地空转、要么模型挑那条「停下来说清」把球踢回用户，
 * 两种结局都得人工再推一把。一次提醒不是熔断，**持续推动才是**。
 *
 * 取 3 与阈值同量级：既不会每轮都刷屏，也不会让一段长连击无人看管。
 */
export const LOOP_ESCALATE_EVERY = 3

/**
 * 升级提醒的档位上限。第 1 档是「三选一」，第 2 档起是硬指令，第 3 档最硬。
 * 到顶之后**仍按 {@link LOOP_ESCALATE_EVERY} 继续重报**（只是文案不再加码）——
 * 沉默比重复更贵：沉默等于放任空转。
 */
export const LOOP_MAX_LEVEL = 3

/** 签名长度上限：参数里塞了整个文件内容时，别把内存撑爆。 */
const SIGNATURE_MAX = 400

/** 单个字符串参数在签名里的长度上限（超了截断，只留前缀做指纹）。 */
const ARG_TEXT_MAX = 120

/** 递归深度上限：参数结构异常深时不再往下走。 */
const ARG_DEPTH_MAX = 4

/** 跟踪的会话数上限，超了丢最旧的，防止长跑进程把它撑成无限大。 */
export const LOOPGUARD_MAX_SESSIONS = 500

/** 注入文本的标记，便于在会话里认出这条是谁加的。 */
export const LOOP_BREAK_MARK = '【拼图模式 · 重复思考熔断】'

/**
 * 稳定序列化：**键排序**后再拼，保证「同参数不同键序」算出同一个签名。
 *
 * 为什么要排序：模型每次生成工具参数时键序可能不同（`{a,b}` 与 `{b,a}`），
 * 若按原样 JSON.stringify，同一件事会算出两个签名，连击永远数不到 3——
 * 熔断就成了**永不触发的死代码**。
 */
export function stableStringify(value, depth = 0) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') {
    return JSON.stringify(value.length > ARG_TEXT_MAX ? `${value.slice(0, ARG_TEXT_MAX)}…` : value)
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return String(value)
  if (typeof value !== 'object') return 'null'
  if (depth >= ARG_DEPTH_MAX) return '"…"'
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, depth + 1)).join(',')}]`
  }
  const keys = Object.keys(value).sort()
  const body = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key], depth + 1)}`)
  return `{${body.join(',')}}`
}

/**
 * 算出一次工具调用的**动作签名**；返回空串表示「这次调用不计入连击」。
 *
 * 返回空串的两种情况：
 *   - 工具名缺失——认不出动作，没法比；
 *   - **参数为空**——轮询类工具（`job_list` / 截图 / 读状态）反复调是正常的，
 *     把它们算成绕圈会把熔断变成噪音源。
 */
export function actionSignature(toolName, args) {
  if (typeof toolName !== 'string' || toolName === '') return ''
  if (args === null || args === undefined || typeof args !== 'object') return ''
  if (Array.isArray(args)) return ''
  if (Object.keys(args).length === 0) return ''
  const signature = `${toolName} ${stableStringify(args)}`
  return signature.length > SIGNATURE_MAX ? signature.slice(0, SIGNATURE_MAX) : signature
}

/**
 * 会话级的连击计数（只存内存）。
 *
 * 为什么只存内存、不落盘：进程重启后连击清零是**安全**的——重启本身就把
 * 「模型刚才在绕圈」这个事实打断了，而且新进程的第一步没有历史可比。
 */
const streaks = new Map()

/**
 * 记一次动作，返回这次要不要熔断。
 *
 * 返回 `{ signature, count, shouldFire, level, toolName }`：
 *   - `signature === ''` → 这次不计（无参 / 认不出），`count` 恒为 0；
 *   - `shouldFire === true` → 调用方应注入一条熔断提示；
 *   - `level` → 这是**这一段连击的第几次**提醒（1 起）。1 = 三选一，
 *     2 起 = 硬指令。文案按它加码（见 {@link loopBreakText}）。
 *
 * ## 报一次的旧行为为什么被推翻（v0.27.0）
 *
 * 旧实现是「同一段连击只报一次」：`fired` 置位后签名不变就永远不再报。
 * 当时的理由是「第 4、5、6 次各报一条比不报更烦」——**防噪音防过了头**：
 * 模型没改的时候，后面每一次重复都是**静默放行**，于是链条原地空转，
 * 或者模型挑「停下来说清」把球踢回用户，最后还得人工推一把。
 *
 * 现在的语义是**升级重报**：到阈值报第一次，之后每 {@link LOOP_ESCALATE_EVERY}
 * 次再报一次，文案随 `level` 变硬。噪音由「间隔」控制，不由「永久闭嘴」控制。
 *
 * 参数 `threshold` 可覆盖（测试与将来按工具分档用）。
 */
export function noteAction(sessionId, toolName, args, threshold = LOOP_REPEAT_THRESHOLD) {
  const signature = actionSignature(toolName, args)
  if (signature === '') return { signature: '', count: 0, shouldFire: false, level: 0, toolName: '' }
  const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : ''
  if (key === '') return { signature, count: 1, shouldFire: false, level: 0, toolName: String(toolName) }
  const limit = Number.isSafeInteger(threshold) && threshold > 0 ? threshold : LOOP_REPEAT_THRESHOLD
  const previous = streaks.get(key)
  // 签名变了 = 模型换了动作 → 连击从 1 重新数（这是「连续」二字的落点），
  // 提醒次数也归零：换了动作就是新的一段，该重新给一次温和的提醒。
  const same = previous !== undefined && previous.signature === signature
  const count = same ? previous.count + 1 : 1
  const reported = same ? previous.reported : 0
  // 第一次到阈值报；之后每 LOOP_ESCALATE_EVERY 次**再报一次**（升级）。
  const firstTime = count >= limit && reported === 0
  const escalate = reported > 0 && count - previous.reportedAt >= LOOP_ESCALATE_EVERY
  const shouldFire = firstTime || escalate
  // level 到顶后不再加码，但**仍然按间隔重报**——沉默比重复更贵。
  const level = shouldFire ? Math.min(reported + 1, LOOP_MAX_LEVEL) : Math.min(reported, LOOP_MAX_LEVEL)
  streaks.set(key, {
    signature,
    count,
    reported: shouldFire ? reported + 1 : reported,
    // 记下「上次是在第几次报的」，升级间隔从它算起（不是从 1 算）。
    reportedAt: shouldFire ? count : (same ? previous.reportedAt : 0),
    level,
  })
  if (streaks.size > LOOPGUARD_MAX_SESSIONS) {
    const oldest = streaks.keys().next().value
    if (oldest !== key) streaks.delete(oldest)
  }
  return { signature, count, shouldFire, level, toolName: String(toolName) }
}

/** 这个会话当前的连击状态（诊断 / 测试用）。 */
export function streakOf(sessionId) {
  const state = streaks.get(typeof sessionId === 'string' ? sessionId : '')
  return state === undefined ? null : { ...state }
}

/** 清掉一个会话的连击（换轮 / 用户重新说话时用；测试也要能重置）。 */
export function clearStreak(sessionId) {
  return streaks.delete(typeof sessionId === 'string' ? sessionId : '')
}

/** 清空全部会话（测试用）。 */
export function resetLoopGuard() {
  streaks.clear()
}

/**
 * 生成熔断提示文本。
 *
 * 语气刻意是**陈述事实 + 给出口**，不是训斥：模型不是「不听话」，而是它**看不到**
 * 自己刚做过同一件事（历史里每轮都重发，重复的动作混在长上下文里不显眼）。
 * 所以这条提示要做的第一件事就是把事实摆出来（「你已经连续 N 次用同样的参数调了 X」），
 * 第二件事是给三条具体出路——只说「别重复」等于没给信息。
 *
 * ## 按 level 加码（v0.27.0）
 *
 * `level === 1`（刚撞阈值）：三选一，语气是提醒。
 * `level >= 2`（报了之后还在重复）：**撤掉「停下来说清」这条出路**，改成硬指令。
 *
 * 为什么必须撤掉它：那条出路原本是给「真的缺权限 / 工具坏了」准备的，
 * 但实测里它成了**最省力的逃逸口**——模型一被点名就挑它，把问题原样抛回用户，
 * 于是「熔断」变成了「转人工」。第一次提醒时留着它是合理的（确实可能真卡住）；
 * 第二次还在原地重复，就说明它不是真卡住，而是**没在推进**——这时候：
 *
 * 1. 先**捋一遍已经拿到的事实**（把上下文里现有信息列成结论），
 * 2. 再**基于事实下结论 / 动手**，不许再确认一遍，
 * 3. 只有连「基于已有信息的最小下一步」都做不了时，才允许说卡住——
 *    而且必须**说清卡在哪一步、缺哪一条具体信息**，不许笼统地「需要你确认」。
 */
export function loopBreakText(toolName, count, threshold = LOOP_REPEAT_THRESHOLD, level = 1) {
  const name = typeof toolName === 'string' && toolName !== '' ? toolName : '同一个工具'
  const times = Number.isSafeInteger(count) && count > 0 ? count : threshold
  const rank = Number.isSafeInteger(level) && level > 0 ? level : 1
  const head = [
    LOOP_BREAK_MARK,
    '',
    `你已经**连续 ${times} 次**用**同样的参数**调用 \`${name}\`——这一步没有产生新信息。`,
    '同一轮上下文会被重复发送，空转的每一轮都是实打实的成本。',
  ]
  // 第一档：给三条出路（温和，且允许「确实卡住」）。
  if (rank <= 1) {
    return [
      ...head,
      '**现在就跳出这个循环**，三选一：',
      '',
      '1. **换输入**：参数里有什么不同（换个路径 / 换个关键词 / 换条命令），让这次调用真的带回新东西；',
      '2. **换动作**：这一步要的信息已经拿到了——直接用它**下结论 / 动手改**，不要再确认一遍；',
      '3. **停下来说清**：确实卡住了（缺权限 / 缺信息 / 工具坏了），就**把卡点讲给用户**，别硬试。',
      '',
      '**不要**再原样调一次。',
    ].join('\n')
  }
  // 第二档起：硬指令，撤掉「转人工」这个逃逸口。
  return [
    ...head,
    '',
    `**这是第 ${rank} 次提醒了——上次让你换输入 / 换动作，你没有换。**`,
    '「停下来说清」这条路**现在不适用**：重复到这个次数，说明你不是缺权限，是**没有推进**。',
    '按顺序做，不要跳步：',
    '',
    '1. **先捋事实**：把上下文里**已经拿到**的信息列出来（文件里读到的、命令输出的、文档里写的），写成几条结论；',
    '2. **再基于事实下结论**：从这些结论里直接给出判断或动手改，**不要再调一次工具去确认**；',
    '3. 只有连「基于已有信息的最小下一步」都做不了时，才允许说卡住——而且必须说清**卡在哪一步、缺哪一条具体信息**，不许笼统地说「需要你确认」。',
    '',
    `**不要**再原样调用 \`${name}\`。如果你正打算问用户，先检查一遍：上面第 1 步的事实，你是不是已经全都拿到了？`,
  ].join('\n')
}
