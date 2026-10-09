/**
 * 文件观察守卫：**纠正思考与文件系统之间的那本错账**。
 *
 * 这一模块的判据、阈值与文案全部来自 `dsh-cot-guard`（v0.2.0），
 * 按用户要求**集成进拼图插件**而不是另装一个插件。移植时保留原始实测依据，
 * 因为「为什么取这个数」比数本身值钱——下一个改它的人得知道代价。
 *
 * ## 它治什么（以及明确不治什么）
 *
 * 需求原话是「思维链修正」。但 cot-guard 动手前把 69 个会话、514 次工具错误翻了一遍，
 * 结论是**思维链本身不是病因**——原报告七条判据里有四条过不了零模型对照
 * （决定下得太早：标记随机撒是 75.4%，比实测的 54.8% 还高；重开多与步长 r²=0.777，
 * 是长步本来就更长；主题词重合 52.5% vs 零模型 50.0%；只有 33.1% 归纳根因 vs
 * 正常步基线 28.4%）。按一个被证伪的指标做触发条件，只会往每步 prompt 里灌噪音。
 *
 * 真正拦路的是**文件观察状态**：`FS_STALE_VERSION` 51.6% + `FS_NOT_OBSERVED` 18.9%
 * + `FS_IO_ERROR` 8.2% = **78.7% 的工具错误**，与推理无关。
 * 而它有一条**有对照组**的修法：
 *
 * | 重试方式 | 例数 | 成功 |
 * |---|---|---|
 * | 先 `read` 再重试 | 181 | **98.3%** |
 * | 不 read 直接重试 | 15 | **0.0%** |
 *
 * 根因（源码级）：`bash` 改过的文件**不登记 `fs/observed`**，
 * 而 `fs-observation-policy` 只认这个事件，于是策略层永远以为文件是旧版本。
 *
 * 本文件是**纯逻辑**：不碰 fs、不碰 ctx、无 import，只做判定与文案。
 */

/** 只对这些工具做「写前观察」判断。读、跑测试、查日志一概不管。 */
export const WRITE_TOOLS = Object.freeze(['edit', 'write'])

/** 触发「读前状态已失效」的 FS 错误码。 */
export const STALE_CODES = Object.freeze(['FS_STALE_VERSION', 'FS_NOT_OBSERVED'])

/**
 * 距上次「观察」多少步算过期。
 *
 * 这里说的**观察**是 `read` **或成功的 `edit`/`write`**——对齐宿主真实口径：
 * `dsh-tool-fs` 的 read / write / edit 三个分支落盘后**都会** `emit("fs/observed")`，
 * 只有 `bash` 一次都不发。第一版只记 `read`，会在「刚成功改过的文件」上误报。
 *
 * ## 这个数是**离线回放扫出来的**，不是按「报错率最高」挑的
 *
 * 第一版取 50，依据是「报错率 78.8% 最吓人」。放进回放跑 1,803 次真实写操作后：
 * **预防路径只触发 6 次（0.3%）**，而 219 次注入全在错误发生**之后**——
 * 它在最没价值的尾巴上使劲，没在做「省一步」。
 *
 * 扫描结果（1,804 次写，基线 14.8%）：
 *
 * | 阈值 | 触发率 | 精确率 | 提升 | 召回 |
 * |---|---|---|---|---|
 * | **5** | **11.4%** | **32.0%** | **2.16x** | **25%** |
 * | 10 | 6.8% | 32.0% | 2.16x | 15% |
 * | 25 | 2.6% | 44.7% | 3.02x | 8% |
 * | 50 | 0.6% | 40.0% | 2.70x | 1% |
 *
 * 关键在**窗口分布**：gap 5–10 报错率 32.1%，gap 30–50 才 44.4%，但样本量差 3 倍——
 * 高精确率的尾巴上没量。而 gap 0–5 只有 **9.4%**，是真正的安全区，不该碰。
 *
 * 取 5 之后预防触发 6 → **141 次**（23 倍）。
 */
export const STALE_AFTER_STEPS = 5

/**
 * 单步内决定宣告次数达到多少算「决定开得太密」。
 *
 * ⚠️ **同步相关成立，前瞻不成立**：
 *
 * | | 决定 ≥8 次 | 决定 1–7 次 |
 * |---|---|---|
 * | **同步**报错率 | **8.6%** | 2.7% |
 * | **下一步**报错率 | 3.3% | 2.4% |
 *
 * 同步差 3 倍，前瞻几乎没差。所以这条注入**不是**「预言下一步会错」，
 * 而是把「决定开得太密」这件事本身点出来——**行为纠正，不是错误预防**。
 */
export const DECISION_DENSE_THRESHOLD = 8

/**
 * 「决定 / 动手」宣告的模式。
 *
 * ⚠️ **不要在这个正则末尾加 `\b`**。踩过的坑：`Decision:` 与 `Settled:` 都以
 * **冒号**结尾，而 `:` 是非单词字符 ⇒ 尾部 `\b` 要求「单词→非单词」的边界，
 * 在 `Decision: ` 里冒号后面已是空格，**整条模式永远匹配不到**。
 * 实测：带尾部 `\b` 时 `'Decision: x'` 计数为 **0**；去掉后为 **1**。
 */
const DECISION_PATTERN = /\b(?:Decision:|I'?ll go with|Let me decide|Settled:|I'?ll use|I'?ll implement|I'?ll do it|Let me write|Let me start writing|Time to write|Let me just do|I'?ll now|Let me now write)/g

/** 数一段思考里的「决定/动手」宣告次数。纯函数，可单测。 */
export function countDecisions(reasoningText) {
  if (typeof reasoningText !== 'string' || reasoningText === '') return 0
  // 正则带 g 标志，必须每次重置 lastIndex，否则跨调用会漏计。
  DECISION_PATTERN.lastIndex = 0
  const m = reasoningText.match(DECISION_PATTERN)
  return m === null ? 0 : m.length
}

/**
 * 从 `post-execute` 拿到的 `result` 里取稳定错误码。
 *
 * ⚠️ **这里踩过一次真坑**：会话日志里的 `tool/result` 事件，`error` 字段是
 * `{ name, code }`；而 `tools/post-execute` 钩子拿到的 `result.error` 是
 * `{ message, info: { name, code } }`——**码在 `info` 里，不在顶层**。
 *
 * cot-guard 第一版按日志的形状写 `result.error.code`，**接线测试也跟着用了错的形状**，
 * 于是 31 项全绿而真实运行时永远取不到码。所以两种形状都认。
 */
export function errorCodeOf(result) {
  const error = result !== null && result !== undefined && typeof result === 'object' ? result.error : null
  if (error === null || typeof error !== 'object') return null
  // 真实钩子形状：{ message, info: { name, code } }
  const nested = error.info !== undefined && error.info !== null ? error.info.code : undefined
  if (typeof nested === 'string' && nested !== '') return nested
  // 日志形状（也认，便于离线回放脚本直接喂事件）
  if (typeof error.code === 'string' && error.code !== '') return error.code
  return null
}

/** 这个错误码是不是「观察记录失效」类。 */
export function isStaleCode(code) {
  return typeof code === 'string' && STALE_CODES.includes(code)
}

/* --------------------------------- 文案 --------------------------------- */

/**
 * 出错后的**重试提示**：本模块唯一有「对照组」的动作。
 *
 * 实测：先 read 再重试 98.3% 成功（181 例），不 read 直接重试 0.0%（15 例）。
 * 而且 FS 错会连串——**92.8%** 的 FS 错后面紧跟的下一个错还是 FS 类。
 */
export function retryText(displayPath) {
  return [
    `⚠️ \`${displayPath}\` 的文件观察记录已失效，这次操作被拒。`,
    '',
    '**下一步必须做且只做这件事**：先 `read` 这个文件，再重放刚才的调用。',
    '',
    '为什么必须这样（实测，不是建议）：',
    '- 先 `read` 再重试：**98.3%** 一次通过（181 例）',
    '- 不 read 直接重试：**0%** 通过（15 例，全部再失败一次）',
    '',
    '根因：`bash` 改过的文件不会登记 `fs/observed`，策略层仍以为它是旧版本；',
    '`read` 是唯一能刷新观察记录的动作。**直接重放原调用必然再失败一次**，',
    '而 FS 类错误有 92.8% 的概率连串出现——一次不治，后面会跟着错。',
  ].join('\n')
}

/**
 * 写之前的**预防提示**：该文件已经很久没被观察过，这一写大概率被拒。
 *
 * 与 {@link retryText} 的区别：这是**预防**（还没错），所以语气更短，
 * 也不下「必须」——因为观察表可能因压缩/重启而与实际不同步，留一点余地。
 */
export function preWriteText(displayPath, stepsSinceRead) {
  return [
    `提示：\`${displayPath}\` 上次被读/改是在 **${stepsSinceRead} 步之前**，观察记录可能已失效。`,
    '直接改它有一定概率收到 `FS_STALE_VERSION`。**先 `read` 一次再改**，可以省掉一次失败调用。',
    `（实测：距上次读/改 ≥${STALE_AFTER_STEPS} 步的文件，编辑报错率 32.0%，基线是 14.8%）`,
  ].join('\n')
}

/**
 * 「没查证就动手」的行为纠正。
 *
 * ## 它**不是**预测器（这条 cot-guard 推翻过自己的第一版）
 *
 * 第一版把它做成「写前预防」，依据是「未观察就 edit → 100% 报错，观察过的只有 15%」。
 * 这个数字看着极强，但**它是同义反复**：未观察的 25 次 edit，错误码
 * `FS_NOT_OBSERVED` 25 次、其它 0 次——而 `FS_NOT_OBSERVED` 的定义就是「没读过就改」。
 * 所以两个集合**是同一个**，不是预测关系。拿它做「写前预防」等于在错误已经要发生时
 * 再说一遍「你要错了」，**零提前量**。
 *
 * 它真正能做的是**把机制错误升格为行为纠正**：工具只说「文件没读过」，
 * 不说这是违反了哪条约定、为什么那条约定值钱。
 *
 * ## 为什么只对 `edit` 不对 `write`
 *
 * `write` 新建文件时本来就没有观察记录，报 `FS_NOT_OBSERVED` 是**误报**性质。
 * 只对 `edit` 说「你没查证」才准确。
 */
export function preEditText(displayPath) {
  return [
    `⚠️ \`${displayPath}\` 没有观察记录就被直接修改 —— 这属于「没查证就动手」。`,
    '',
    '工具只告诉你「先读再改」，但没告诉你这条约定为什么值钱：',
    '- 实测：首个「决定/动手」宣告**之后**，仍然写掉了 **54.8%** 的思考字符；',
    '- 而这些重开里 **93.6% 确实改变了结论** —— 反过来读：',
    '  **第一个结论有 93.6% 的概率是错的**。',
    '',
    '**先 `read` 这个文件，再重放刚才的修改。**',
    '（注意：这不是「预测」，是同一条事实的两种说法——未读就改**必然**触发它。）',
  ].join('\n')
}

/**
 * 「决定开得太密」的提醒。
 *
 * ⚠️ **时态必须说准**：`additionalContexts` 是在**下一步**才被模型读到的，
 * 所以文案说的是「你**刚才那一步**」，不是「你现在这一步」——写错时态会让模型
 * 去改一个已经结束的步骤，等于白说。
 */
export function denseDecisionText(count, toolCallCount) {
  return [
    `⚠️ 你**刚才那一步**宣布了 **${count} 次「决定/动手」**（约定是 1 次）。`,
    '',
    `实测：决定 ≥${DECISION_DENSE_THRESHOLD} 次的步，报错率 **8.6%**；决定 1–7 次的步是 **2.7%**——差 3 倍。`,
    `那一步你只调了 ${toolCallCount} 次工具。`,
    '',
    '**别再宣布了，直接动手。** 若要改主意，先 `read`/`grep` 看一眼事实再改，',
    '而不是在同一段思考里换套说法重推——实测这类重推的逐字相似度只有 3.4%，',
    '但主题词重合中位 52.5%：**读起来信息量很足，其实没推进任何新结论**。',
  ].join('\n')
}

/* ------------------------------- 会话状态 ------------------------------- */

/** 会话上限：防泄漏，不是功能限制（会话对象被回收后拿不到通知）。 */
export const FSGUARD_MAX_SESSIONS = 500

/**
 * 会话级的观察表：记录每个文件「最后一次被观察」的步号，以及是否已经提示过。
 *
 * 为什么不复用 `fs-observation-policy` 的内部状态：那是宿主私有 `WeakMap`，
 * 插件读不到；而且它**只认 fs 工具的观察**，正是出问题的那个口径。
 * 这里独立记一份「模型视角的观察表」，用来判断「模型以为它读过、其实工具不认」。
 */
export class ObservationLog {
  constructor() {
    /** @type {Map<string, number>} targetKey → 步号 */
    this.readAt = new Map()
    /** @type {Set<string>} 已提示过「过期」的文件，read 之后才重新武装 */
    this.warned = new Set()
    /** @type {Set<string>} 已提示过「从未观察」的文件，只报一次 */
    this.warnedEdit = new Set()
  }

  /** 记录一次观察（read **或成功的写**）。同时清掉「已提示」标记——观察过就不再唠叨。 */
  noteRead(targetKey, step) {
    this.readAt.set(targetKey, step)
    this.warned.delete(targetKey)
    this.warnedEdit.delete(targetKey)
  }

  /**
   * **只刷新观察时间，不动「已提示」标记**。
   *
   * ## 为什么必须与 `noteRead` 分开（实测踩到）
   *
   * 两者语义不同：
   *   - `noteRead` = 「模型**真的读了**这个文件」→ 该重新武装，清掉提示标记；
   *   - `refresh`  = 「这个文件**变新鲜了**」（成功的写会让宿主登记 `fs/observed`）
   *     → 时间要更新（防误报），但**提示标记必须保留**（防刷屏）。
   *
   * 第二版在「成功的写」路径上用了 `noteRead`，于是同一档反复提示——
   * 实测症状：测试里「同一文件同一档只提示一次」当场变红。
   * 把两个语义合成一个方法，就是逼调用方在「防误报」与「防刷屏」之间二选一，
   * 而这两个目标**本来可以同时满足**。
   */
  refresh(targetKey, step) {
    this.readAt.set(targetKey, step)
  }

  /** 该文件距上次观察过了多少步；从未观察过返回 `null`。 */
  stepsSinceRead(targetKey, step) {
    if (!this.readAt.has(targetKey)) return null
    return step - this.readAt.get(targetKey)
  }

  /** 该文件在本会话里是否被观察过。 */
  wasObserved(targetKey) {
    return this.readAt.has(targetKey)
  }

  /**
   * 「没查证就动手」的判据：只在**本会话从未观察过**这个文件时返回 `true`，
   * 且同一文件只报一次（报过就闭嘴，避免连续编辑同一个未读文件时刷屏）。
   *
   * 为什么不复用 {@link shouldWarnBeforeWrite}：那个判据是「隔太久」，
   * 这个判据是「**从来没有过**」——两者证据强度差一个量级
   * （15.0% vs **100.0%**），文案与阈值都该分开。
   */
  shouldWarnBeforeEdit(targetKey) {
    if (this.warnedEdit.has(targetKey)) return false
    if (this.wasObserved(targetKey)) return false
    this.warnedEdit.add(targetKey)
    return true
  }

  /**
   * 判断「现在要写这个文件，是否值得先提醒一句」。
   *
   * 三条都不满足就**不要提示**（宁可漏报）：从未观察过的不提醒——那种情况
   * 工具本身会给 `FS_NOT_OBSERVED`，届时由 {@link retryText} 兜底，
   * 提前猜反而会误伤「新建文件」这类正常操作。
   */
  shouldWarnBeforeWrite(targetKey, step) {
    if (this.warned.has(targetKey)) return null
    const since = this.stepsSinceRead(targetKey, step)
    if (since === null) return null
    if (since < STALE_AFTER_STEPS) return null
    this.warned.add(targetKey)
    return since
  }
}

/** 每个会话一份观察表与步号。 */
const states = new Map()

function emptyState() {
  return {
    log: new ObservationLog(),
    step: 0,
    stats: { stale: 0, preWrite: 0, preEdit: 0, dense: 0 },
    /** 本步数出来的「决定过密」结论，等下一个工具结果落地时注入一次。 */
    pendingDense: null,
    callsThisStep: 0,
  }
}

function stateOf(sessionId) {
  const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : ''
  if (key === '') return null
  let state = states.get(key)
  if (state === undefined) {
    state = emptyState()
    states.set(key, state)
    if (states.size > FSGUARD_MAX_SESSIONS) {
      const oldest = states.keys().next().value
      if (oldest !== undefined && oldest !== key) states.delete(oldest)
    }
  }
  return state
}

/** 记一次「步开始」：推进步号、清掉上一步的暂存。 */
export function noteStepStart(sessionId, step) {
  const state = stateOf(sessionId)
  if (state === null) return
  state.step = Number.isSafeInteger(step) && step > 0 ? step : state.step + 1
  // §5 的结论只在**紧接着的下一个工具结果**上注入，落空就作废，绝不跨步补发
  //（补发时上下文已经变了，说了也没用）。
  state.pendingDense = null
  state.callsThisStep = 0
}

/** 记一段思考里的决定宣告次数（只记「过密」，且每步只记一次）。 */
export function noteReasoning(sessionId, reasoningText) {
  const state = stateOf(sessionId)
  if (state === null) return
  const count = countDecisions(reasoningText)
  if (count >= DECISION_DENSE_THRESHOLD && state.pendingDense === null) {
    state.pendingDense = { count, calls: state.callsThisStep }
  }
}

/** 记一次工具调用，返回**这次该注入什么**。 */
export function noteToolCall(sessionId, toolName, args, result) {
  const state = stateOf(sessionId)
  if (state === null) return { kind: '', text: '' }
  state.callsThisStep += 1

  // ---- 决定过密：借**第一个落地的工具结果**注入一次，然后作废 ----
  // 为什么挂在工具结果上而不是 `assistant/message`：`session/event` 是纯通知
  // （emit），没有 `additionalContexts` 这种回传通道；`tools/post-execute` 才是
  // 唯一能「不拦、不打断、只提醒一句」的钩子。
  const dense = state.pendingDense
  if (dense !== null) {
    state.pendingDense = null
    state.stats.dense += 1
    return { kind: 'dense', text: denseDecisionText(dense.count, dense.calls) }
  }

  // ---- ① read：刷新观察记录。这是全部判断的唯一真源 ----
  if (toolName === 'read') {
    const path = typeof args?.file_path === 'string' ? args.file_path : ''
    if (path !== '') state.log.noteRead(path, state.step)
    return { kind: '', text: '' }
  }

  // ---- ② 写类工具：只在 edit / write 上判断 ----
  if (!WRITE_TOOLS.includes(toolName)) return { kind: '', text: '' }
  const path = typeof args?.file_path === 'string' ? args.file_path : ''
  if (path === '') return { kind: '', text: '' }

  // 情况 A：刚刚被拒 —— 注入「先 read 再重试」。
  const code = errorCodeOf(result)
  if (isStaleCode(code)) {
    state.stats.stale += 1
    const extra = []
    // `FS_NOT_OBSERVED` 是「没查就动手」的**必然结果**（不是预测）。
    // 只对 `edit` 附加：`write` 新建文件本就没有观察记录，说它「没查证」不准确。
    if (code === 'FS_NOT_OBSERVED' && toolName === 'edit' && state.log.shouldWarnBeforeEdit(path)) {
      state.stats.preEdit += 1
      extra.push({ kind: 'pre-edit', text: preEditText(path) })
    }
    return { kind: 'retry', text: retryText(path), extra }
  }

  // 情况 B：还没错，但观察记录很可能已过期 —— 提示一句，省掉一次失败调用。
  if (result !== null && result !== undefined && result.isError === true) return { kind: '', text: '' }

  /**
   * ⚠️ **顺序很关键：先判定，再刷新观察表**（第一版反了，实测被测试抓住）。
   *
   * 为什么反了会出错：`shouldWarnBeforeWrite` 会**把该文件标成「已提示」**并返回
   * `since`，然后这里 `return` —— 于是那次**成功的写**根本走不到刷新语句。
   * 后果：刚成功写过的文件在几步后被当成「很久没读」而**误报**，
   * 而它其实一直是新鲜的（宿主 `dsh-tool-fs` 的 write/edit 分支落盘后**都会**
   * `emit("fs/observed")`）。
   */
  let outcome = { kind: '', text: '' }
  const since = state.log.shouldWarnBeforeWrite(path, state.step)
  if (since !== null) {
    state.stats.preWrite += 1
    outcome = { kind: 'pre-write', text: preWriteText(path, since) }
  }
  /**
   * 成功的 edit/write 自己也会登记 `fs/observed`，这里同步刷新观察时间。
   *
   * ## ⚠️ 必须用 `refresh()` 而不是 `noteRead()`（第二版在这里栽过）
   *
   * `noteRead()` 会**清掉「已提示」标记**——那是 `read` 的语义（用户真的读了，
   * 该重新武装）。但「成功的写」不是「用户读了」：它只是让文件变新鲜，
   * **不该把提示标记清掉**。第二版用了 `noteRead`，后果是同一档反复提示
   * （实测：测试里「同一文件同一档只提示一次」当场变红）。
   *
   * 两个目标要分开：**刷新观察时间**（防误报）与**保留提示标记**（防刷屏）。
   */
  state.log.refresh(path, state.step)
  return outcome
}

/** 这个会话的计数（诊断 / 测试用）。 */
export function fsGuardStatsOf(sessionId) {
  const state = states.get(typeof sessionId === 'string' ? sessionId : '')
  if (state === undefined) return null
  return { ...state.stats, step: state.step, callsThisStep: state.callsThisStep }
}

/** 这个会话的观察表快照（诊断 / 测试用）。 */
export function fsGuardLogOf(sessionId) {
  const state = states.get(typeof sessionId === 'string' ? sessionId : '')
  if (state === undefined) return null
  return {
    readAt: new Map(state.log.readAt),
    warned: new Set(state.log.warned),
    warnedEdit: new Set(state.log.warnedEdit),
  }
}

/** 清一个会话（测试用）。 */
export function clearFsGuard(sessionId) {
  return states.delete(typeof sessionId === 'string' ? sessionId : '')
}

/** 清全部会话（测试用）。 */
export function resetFsGuard() {
  states.clear()
}
