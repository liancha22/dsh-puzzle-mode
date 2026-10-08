/**
 * 工作流注入去重：同一条流程别反复往上下文里塞。
 *
 * ## 为什么需要它（用户原话）
 *
 * 「工作流注入去重，加最小注入间隔」。
 *
 * 背景：工作流钩子挂在 `tools/post-execute` 上，**每一次**工具调用都会重新算一遍
 * 命中了哪几条流程。而模型干活是连续的——改 `lib/index.js` 之后紧接着改
 * `lib/client.js`，两次都命中「发版并同步文档」那条（触发词含 `package.json` /
 * `lib/`），于是同一份 11 步流程被原样塞进上下文两遍、三遍、十遍。
 *
 * 代价有两层：
 *   1. **纯浪费**——每一步的上下文都要重发，重复注入等于按步数收费；
 *   2. **反效果**——同一段规则刷屏之后，模型会开始**忽略**它（这仓的老教训：
 *      规则躺在那儿不绑定动作等于没有，而绑定得太频繁等于噪音）。
 *
 * ## 判据：一条规则，两个副作用
 *
 * 决策只有一句话：**「这个命中集合，在最近 {@link WORKFLOW_MIN_INTERVAL} 步内注入过吗？」**
 * 注入过就不注入，没注入过就注入。它同时给出用户要的两件事：
 *
 *   - **命中集合没变就不重复注入**：连着改同一类文件，第二次、第三次直接跳过；
 *   - **换了阶段立刻重新注入**：命中集合一变，那个集合从没在近期出现过 → 立刻注入。
 *
 * 为什么不用「每条工作流每会话只注入一次」：那样长会话里第二次改到同一类文件就
 * 再也不提醒，规则形同虚设。也不是「每轮一次」：同一轮里换了工作阶段也不提醒，
 * 而那正是流程最该出现的时刻。
 *
 * ## 为什么按「集合」而不是按「单条」记
 *
 * 一次工具调用可能同时命中几条流程（同一个项目的多条，或多个绑定项目各自的）。
 * 若按单条记，A+B 命中后只命中 A，A 会被判成「没变」而跳过——但这次的注入内容
 * 其实变了（少了 B）。按**整个命中集合**记，签名一变就是一次新注入，不会漏。
 *
 * ## 为什么额外挡住「来回横跳」
 *
 * 只按「签名变没变」判，会有一个洞：A、B、A、B 交替命中时每一步都算「变了」，
 * 于是每一步都注入——比去重之前还吵。所以判据统一成「**这个签名**在最近 N 步内
 * 注入过没有」：横跳回一个刚注入过的签名同样被挡住，而真正的新阶段（没见过的签名）
 * 仍然立刻注入。这一条不改变用户裁定的语义，只是把它补完整。
 *
 * 本文件是**纯逻辑**：不碰 fs、不碰 ctx、无 import，只做「这一步要不要注入」。
 */

/**
 * 最小注入间隔（步）。
 *
 * 取 6 与催促的节拍同值（{@link NUDGE_EVERY}）：两者都是「模型走了几步」这个尺度，
 * 数值不同只会让人记混。语义是「同一个命中集合，至少隔 6 步才会被再注入一次」。
 */
export const WORKFLOW_MIN_INTERVAL = 6

/** 跟踪的会话数上限，超了丢最旧的，防止长跑进程把它撑成无限大。 */
export const WORKFLOW_MAX_SESSIONS = 500

/** 每个会话记住的「最近注入过的签名」条数上限。 */
export const WORKFLOW_MAX_SIGNATURES = 24

/** 注入文本的标记（与 `lib/index.js` 里那条抬头一致，便于在会话里认出是谁加的）。 */
export const WORKFLOW_MARK = '【拼图模式 · 工作流触发】'

/** 没注入过这个签名（第一次见）→ 注入。 */
export const WORKFLOW_REASON_FIRST = 'first'

/** 这个签名在最近 {@link WORKFLOW_MIN_INTERVAL} 步内没注入过（隔够了）→ 注入。 */
export const WORKFLOW_REASON_INTERVAL = 'interval'

/** 这个签名刚注入过 → 跳过。 */
export const WORKFLOW_REASON_DEDUPED = 'deduped'

/**
 * 把「命中的工作流」压成一个稳定的签名字符串。
 *
 * 输入形状刻意宽容：`[{ project, blocks }]`，`blocks` 是 `parseWorkflowBlocks` 的块
 * 或任何带 `name` 的对象。名字排序后拼接——**顺序不该影响判定**：同一个集合
 * 以不同顺序算出来必须是同一个签名，否则「没变」会被误判成「变了」。
 *
 * 空集合（一条都没命中）返回空串，调用方据此直接放行（这一步不算一次注入）。
 */
export function workflowSignature(hits) {
  const list = Array.isArray(hits) ? hits : []
  const parts = []
  for (const hit of list) {
    if (hit === null || typeof hit !== 'object') continue
    const project = typeof hit.project === 'string' ? hit.project : ''
    const blocks = Array.isArray(hit.blocks) ? hit.blocks : []
    const names = []
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue
      const name = typeof block.name === 'string' ? block.name.trim() : ''
      if (name !== '') names.push(name)
    }
    if (names.length === 0) continue
    names.sort()
    parts.push(project + '#' + names.join('+'))
  }
  parts.sort()
  return parts.join(';;')
}

/**
 * 会话级状态（只存内存）。
 *
 * 为什么只存内存、不落盘：进程重启后「刚注入过」这个事实就该失效——新进程的
 * 第一步没有历史可比，宁可贵一次（多注入一遍）也不要漏掉规则。
 *
 * `lastAt` 记的是**签名 → 第几步注入的**。`steps` 是本会话累计的工具调用步数。
 */
const states = new Map()

function emptyState() {
  return { steps: 0, lastAt: new Map(), injected: 0, skipped: 0 }
}

const IDLE = Object.freeze({ inject: false, reason: '', steps: 0, gap: 0, signature: '' })

/**
 * 记一次工具调用，返回这次要不要注入工作流。
 *
 * **每一次工具调用都必须调它**（命中与否都要）：`steps` 是间隔的分母，
 * 只在命中时调会让「隔了 6 步」永远算不准。
 *
 * @param {string} sessionId 会话 ID
 * @param {string} signature {@link workflowSignature} 的结果；空串表示这次没命中任何流程
 * @returns {{inject:boolean, reason:string, steps:number, gap:number, signature:string}}
 *   `inject` 为 `true` 时调用方才去拼注入文本；`gap` 是距上次注入该签名的步数
 *   （从没注入过是 `Infinity`，面板与测试用它解释「为什么这次跳过了」）。
 */
export function noteWorkflowTrigger(sessionId, signature) {
  const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : ''
  if (key === '') return IDLE
  const sig = typeof signature === 'string' ? signature : ''

  const previous = states.get(key) ?? emptyState()
  const steps = previous.steps + 1

  const save = (next) => {
    states.set(key, next)
    if (states.size > WORKFLOW_MAX_SESSIONS) {
      const oldest = states.keys().next().value
      if (oldest !== key) states.delete(oldest)
    }
  }

  // 没命中任何流程：只推进步数，不碰 `lastAt`（没注入过就没什么可记的）。
  if (sig === '') {
    save({ steps, lastAt: previous.lastAt, injected: previous.injected, skipped: previous.skipped })
    return { inject: false, reason: '', steps, gap: 0, signature: '' }
  }

  const last = previous.lastAt.get(sig)
  const gap = last === undefined ? Infinity : steps - last
  if (gap < WORKFLOW_MIN_INTERVAL) {
    save({ steps, lastAt: previous.lastAt, injected: previous.injected, skipped: previous.skipped + 1 })
    return { inject: false, reason: WORKFLOW_REASON_DEDUPED, steps, gap, signature: sig }
  }

  // 注入：记下这个签名是在第几步注入的，并淘汰最旧的记录（保持有界）。
  const lastAt = new Map(previous.lastAt)
  lastAt.set(sig, steps)
  while (lastAt.size > WORKFLOW_MAX_SIGNATURES) {
    let oldestKey = null
    let oldestStep = Infinity
    for (const [name, at] of lastAt) {
      if (at < oldestStep) {
        oldestStep = at
        oldestKey = name
      }
    }
    if (oldestKey === null) break
    lastAt.delete(oldestKey)
  }
  save({ steps, lastAt, injected: previous.injected + 1, skipped: previous.skipped })
  return {
    inject: true,
    reason: last === undefined ? WORKFLOW_REASON_FIRST : WORKFLOW_REASON_INTERVAL,
    steps,
    gap,
    signature: sig,
  }
}

/** 这个会话当前的去重状态（诊断 / 测试用）。 */
export function workflowGuardStateOf(sessionId) {
  const state = states.get(typeof sessionId === 'string' ? sessionId : '')
  if (state === undefined) return null
  return { ...state, lastAt: new Map(state.lastAt) }
}

/** 清掉一个会话的去重状态（测试用）。 */
export function clearWorkflowGuard(sessionId) {
  return states.delete(typeof sessionId === 'string' ? sessionId : '')
}

/** 清空全部会话（测试用）。 */
export function resetWorkflowGuard() {
  states.clear()
}

/**
 * 生成「跳过注入」时的一句话说明（**不注入**，只给面板 / 日志看）。
 *
 * 为什么不把这句话也塞进上下文：用户要的是**少注入**。每次跳过都补一句
 * 「这条你已经看过了」，等于把省下来的噪音又加回去——那正是要治的病。
 */
export function workflowSkipText(reason, gap, signature) {
  if (reason !== WORKFLOW_REASON_DEDUPED) return ''
  const sig = typeof signature === 'string' ? signature : ''
  const name = sig === '' ? '这条流程' : sig.split(';;')[0].split('#').slice(1).join('#')
  const n = Number.isFinite(gap) ? String(gap) : '0'
  return `${WORKFLOW_MARK}（跳过重复注入）\n\n「${name}」在最近 ${n} 步内已经注入过，这一轮不再重复。`
}
