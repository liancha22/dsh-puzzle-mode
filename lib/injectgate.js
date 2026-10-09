/**
 * 注入闸门：**七条注入共用一道闸，防它们叠成噪音**。
 *
 * ## 为什么需要它（用户裁定）
 *
 * 拼图插件原本有三条注入（工作流触发 / 熔断 / 催促），加上说话纠正与
 * 集成进来的文件观察守卫（四个触发点），一共有**七条**会往同一轮上下文里塞话。
 * 每条单独看都克制，但它们**互不知情**——同一轮里可能同时来三四条，
 * 叠起来就是用户抱怨过的「一大堆字」。
 *
 * 用户对这一条的裁定是：「共存，各自独立注入，**并一起降低注入频次**」。
 * 所以本文件做两件事，且**只做这两件**：
 *
 *   1. **每轮预算**：一轮（turn）里最多放行 `INJECT_BUDGET_PER_TURN` 条。
 *      超出的**丢掉而不是排队**——排到下一轮时上下文已经变了，
 *      那条提醒多半已经无意义（这正是「决定过密」那条注入自己坚持的语义：
 *      落空就作废，绝不跨步补发）。
 *   2. **同种冷却**：同一类注入（`kind`）在 `INJECT_COOLDOWN_STEPS` 步内只放行一次。
 *      各类**独立计数**，所以「工作流触发」被压住不影响「先读再改」。
 *
 * ## 为什么按「轮」而不是按「步」算预算
 *
 * 步是工具调用级的，一轮里可能有十几步；按步算预算等于没有预算。
 * 用户感知到的「吵」是按**轮**的——他读一次回复，里面塞了几条提醒。
 * 所以预算的单位取轮。
 *
 * ## 什么不占预算
 *
 * **不注入任何东西**的判定当然不占。此外：
 *   - 「先 read 再重试」是**唯一有对照组**的动作（98.3% vs 0%），
 *     它一占预算就可能被别的话挤掉——所以它**永远放行**，不占额度。
 *   - 说话纠正（整句英文 / 复读）也永远放行：它治的是「这一轮已经发生的事实错误」，
 *     延到下一轮就没意义了（用户为它专门提过两次需求）。
 *
 * 本文件是**纯逻辑**：不碰 fs、不碰 ctx、无 import。
 */

/** 一轮里最多放行几条注入（不含永远放行的两类）。 */
export const INJECT_BUDGET_PER_TURN = 2

/** 同一类注入在这个步数内只放行一次。 */
export const INJECT_COOLDOWN_STEPS = 6

/**
 * 拿不到 `turn` 时，靠步号跨度推断「换轮」的阈值。
 *
 * 取 12：一轮里通常没这么多步，而取小了会把「一轮里步数多」误判成多轮、
 * 预算形同虚设。详见 {@link noteProgress} 的注释（那里记着实测踩到的坑）。
 */
export const INJECT_TURN_FALLBACK_STEPS = 12

/** 跟踪的会话数上限，超了丢最旧的（防长跑进程撑大内存）。 */
export const INJECT_MAX_SESSIONS = 500

/**
 * **永远放行**的注入种类：它们不占预算、不受冷却。
 *
 * 判据是「延到下一轮就失效」——错误纠正类都属于这种：
 *   - `retry`：唯一有对照组的动作（98.3% vs 0%），被别的话挤掉就等于没有它；
 *   - `speech`：治的是「这一轮已经发生的事实错误」（说英文 / 复读），延后无意义。
 */
export const INJECT_ALWAYS = Object.freeze(['retry', 'speech'])

/**
 * **自带节流**的种类：过预算，但**不受同类冷却**。
 *
 * ## 为什么它们必须豁免冷却（实测踩到）
 *
 * 熔断与催促各自已经有确定的节流节奏：
 *   - 熔断：到阈值报一次，之后每 `LOOP_ESCALATE_EVERY`（3）步**重报并加码**；
 *   - 催促：每 `NUDGE_EVERY`（6）步催一次，档位随表现加码。
 *
 * 而闸门的同类冷却是 6 步——**它不比熔断的重报间隔短**，于是会把熔断的
 * 「第 2 次、第 3 次」整个吃掉：模型被点名一次之后再也听不到升级文案，
 * 链条照样原地空转。这不是「少说一句」，是**把一条已经验证过的机制弄失效**。
 *
 * 实测证据：接上闸门后 `60-loopguard` 那条「不改动作时钩子必须重复注入」
 * 当场变红——而那条断言存在的理由正是「只注入一次 = 熔断后没人推，
 * 用户得手工接着跑」（v0.27.0 修的就是这个）。
 *
 * 所以它们只过**轮预算**（一轮最多 2 条），不过冷却。轮预算仍然有效：
 * 它防的是「一轮里塞进好几条**不同的**提醒」，那才是用户抱怨的「吵」；
 * 而熔断/催促的重复是**同一条**在升级，性质不同。
 */
export const INJECT_SELF_PACED = Object.freeze(['loop', 'nudge'])

/** 这次放行 / 拦下的原因（面板与测试都读它）。 */
export const INJECT_REASON_OK = 'ok'
export const INJECT_REASON_BUDGET = 'budget'
export const INJECT_REASON_COOLDOWN = 'cooldown'

/** 每个会话的闸门状态。 */
const states = new Map()

function emptyState() {
  return {
    turn: -1,
    step: 0,
    /** 上次清零预算时的步号（拿不到 turn 时用它推断换轮）。 */
    lastBudgetStep: 0,
    /** 本轮的已用额度。 */
    used: 0,
    /** 兜底计数：轮号与步号都不可得时用它推进预算。 */
    requests: 0,
    /** kind → 上次放行的步号。 */
    lastAt: new Map(),
    /** 统计：放行 / 因预算拦 / 因冷却拦。 */
    stats: { allowed: 0, budget: 0, cooldown: 0 },
  }
}

function stateOf(sessionId) {
  const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : ''
  if (key === '') return null
  let state = states.get(key)
  if (state === undefined) {
    state = emptyState()
    states.set(key, state)
    if (states.size > INJECT_MAX_SESSIONS) {
      const oldest = states.keys().next().value
      if (oldest !== undefined && oldest !== key) states.delete(oldest)
    }
  }
  return state
}

/**
 * 推进轮 / 步的计数。
 *
 * **轮换了就把额度清零**——预算的单位是轮，不跨轮累计
 * （跨轮累计会让「上一轮用得省」变成「这一轮可以多塞」，那不是节制）。
 *
 * ## ⚠️ 没有轮信息时的兜底（实测踩到两次）
 *
 * `step/start` 事件里带 `turn`，但**不是每条通路都收得到它**。第一版只在拿到
 * `turn` 时清零，于是 `turn` 恒为 -1 时**预算永远用满、第 3 条起全被挡死**。
 *
 * 第二版改用「步号跨度 ≥ 12 就当作换轮」——**还是不够**：完全不发 `step/start` 的
 * 通路里步号恒为 0，跨度永远是 0，兜底同样不触发。
 *
 * 所以再加一条**按请求次数**的兜底：既然轮号与步号都不可得，就用「这个会话
 * 已经请求过多少次」来推进。取 `INJECT_BUDGET_PER_TURN * 3` 次——
 * 那是「预算该翻篇了」的下限估计，宁可多给几次也不要把一条注入永久堵死。
 *
 * 两条兜底都不如真实的轮号准，但它们的作用是**防死锁**，不是精确计数。
 */
export function noteProgress(sessionId, options = {}) {
  const state = stateOf(sessionId)
  if (state === null) return null
  if (Number.isSafeInteger(options.step) && options.step > 0) {
    const previous = state.step
    state.step = options.step
    // 兜底一：拿不到 turn 时，靠步号跨度推断换轮。
    if (Number.isSafeInteger(options.turn) && options.turn >= 0) {
      if (options.turn !== state.turn) {
        state.turn = options.turn
        state.used = 0
      }
    } else if (previous > 0 && state.step - state.lastBudgetStep >= INJECT_TURN_FALLBACK_STEPS) {
      state.used = 0
    }
    state.lastBudgetStep = state.step
  }
  return { turn: state.turn, step: state.step, used: state.used }
}

/**
 * 请求放行一条注入。
 *
 * @param {string} sessionId
 * @param {string} kind 注入种类（`retry` / `pre-write` / `pre-edit` / `dense` /
 *   `workflow` / `loop` / `nudge` / `speech` …）
 * @returns {{allow:boolean, reason:string, used:number}}
 *   `allow === false` 时调用方**不要注入**（但也不必报错——那是正常节制）。
 */
export function requestInject(sessionId, kind) {
  const name = typeof kind === 'string' && kind !== '' ? kind : ''
  if (name === '') return { allow: false, reason: INJECT_REASON_BUDGET, used: 0 }
  const state = stateOf(sessionId)
  if (state === null) return { allow: false, reason: INJECT_REASON_BUDGET, used: 0 }

  // 永远放行的两类：不占预算、不受冷却（理由见文件头）。
  if (INJECT_ALWAYS.includes(name)) {
    state.stats.allowed += 1
    state.lastAt.set(name, state.step)
    return { allow: true, reason: INJECT_REASON_OK, used: state.used }
  }

  // 同种冷却：同类话在冷却窗口内只放行一次。
  // 自带节流的种类豁免冷却（理由见 `INJECT_SELF_PACED` 的注释）。
  //
  // ⚠️ **只在「步号可信」时才用冷却拦**：判据同样是 `state.turn >= 0`
  // （收到过 `step/start` 才会推进步号）。
  //
  // 为什么：无步信息时 `state.step` 恒为 0，`0 - 0 < 6` **恒真** → 第一次之后的
  // 同类注入**全部**被冷却挡死。实测症状：`120-workflowguard` 那条
  // 「连着 6 步改同一类文件只该注入 1 次，实际 0 次」——连第一次之后的都进不来，
  // 而去重逻辑本身是对的（纯函数层 21 项全过）。
  //
  // 与预算那条同一个取舍：**多注入是噪音，误拦是功能失效**。
  if (state.turn >= 0 && !INJECT_SELF_PACED.includes(name)) {
    const last = state.lastAt.get(name)
    if (last !== undefined && state.step - last < INJECT_COOLDOWN_STEPS) {
      state.stats.cooldown += 1
      return { allow: false, reason: INJECT_REASON_COOLDOWN, used: state.used }
    }
  }

  // 每轮预算。
  //
  // ⚠️ **只在「轮信息可信」时才用预算拦**。判据是 `state.turn >= 0`——
  // 那说明这个会话真的收到过 `step/start`，轮号是真的。
  //
  // ## 为什么无信息时必须放行（实测踩到两次，第二次才想清）
  //
  // 第一版只在拿到 `turn` 时清零 → `turn` 恒为 -1 的通路里预算**永久堵死**。
  // 第二版加了「步号跨度 ≥12 当作换轮」的兜底，**还是堵死**：完全不发 `step/start`
  // 的通路里步号恒为 0，跨度永远是 0。
  // 第三版加「按请求次数推进」，仍然是在**猜**轮边界。
  //
  // 想清之后：这些兜底都在做一件做不到的事——**用不可得的信息判断轮边界**。
  // 判错了的后果是不对称的：
  //   - 多注入一条 = 噪音（可容忍，用户能忽略）；
  //   - 误拦一条 = **功能失效**（熔断的升级路径被吃掉、用户得手工接着跑）。
  //
  // 所以信息不足时**放行**，把节制交给各条注入**自带的节流**
  // （熔断每 3 步、催促每 6 步、工作流去重 6 步、守卫同类 6 步冷却）。
  // 那些节流不依赖轮号，是可靠的。闸门只在**能算准**的时候才额外收紧。
  if (state.turn < 0) {
    state.used += 1
    state.stats.allowed += 1
    state.lastAt.set(name, state.step)
    return { allow: true, reason: INJECT_REASON_OK, used: state.used }
  }
  if (state.used >= INJECT_BUDGET_PER_TURN) {
    state.stats.budget += 1
    return { allow: false, reason: INJECT_REASON_BUDGET, used: state.used }
  }

  state.used += 1
  state.requests = 0
  state.stats.allowed += 1
  state.lastAt.set(name, state.step)
  return { allow: true, reason: INJECT_REASON_OK, used: state.used }
}

/** 这个会话的闸门状态（诊断 / 测试用）。 */
export function injectGateOf(sessionId) {
  const state = states.get(typeof sessionId === 'string' ? sessionId : '')
  if (state === undefined) return null
  return { turn: state.turn, step: state.step, used: state.used, stats: { ...state.stats }, lastAt: new Map(state.lastAt) }
}

/** 清一个会话（测试用）。 */
export function clearInjectGate(sessionId) {
  return states.delete(typeof sessionId === 'string' ? sessionId : '')
}

/** 清全部（测试用）。 */
export function resetInjectGate() {
  states.clear()
}

/**
 * 被拦下时的一句话说明（**不注入**，只给面板/日志看）。
 *
 * 为什么不把这句话也塞进上下文：用户要的是**少注入**。每次拦下都补一句
 * 「这条我帮你省了」，等于把省下来的噪音又加回去——那正是要治的病。
 */
export function injectSkipText(reason, kind) {
  if (reason === INJECT_REASON_COOLDOWN) {
    return `（${kind} 在 ${INJECT_COOLDOWN_STEPS} 步内已提示过，本轮跳过）`
  }
  if (reason === INJECT_REASON_BUDGET) {
    return `（本轮注入已达上限 ${INJECT_BUDGET_PER_TURN} 条，${kind} 跳过）`
  }
  return ''
}
