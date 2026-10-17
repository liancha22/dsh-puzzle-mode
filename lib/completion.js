/**
 * 执行完成 / 失败 → 搬卡 + 汇报全局大脑。
 *
 * ## 这个文件补的是什么
 *
 * `dispatch.js` 里早有 `verdictOf` / `observeOf`（判「这张卡该不该搬列」），
 * 但**全仓没有任何地方调用它们**——`verdictOf` 只被 `index.js` import 进去就没了下文。
 * 也就是说界面上写的那句「做完自动落到「已做」」**从来没有实现过**：
 * 卡派出去之后就永远停在「在做」，成败都看不出来。
 *
 * 所以这里做三件事，缺一不可：
 *   1. 把 `verdictOf` 真正接上宿主事件（`goal/changed`），让卡会自己搬；
 *   2. 搬完之后**把结论投给全局大脑**，由它回写文档（用户点名要求的那条）；
 *   3. 完成之后**把 goal 本身清掉**（`goals.clear`）：搬卡只把卡挪到「已做」，
 *      goal 仍作为「当前 goal」留在 agent 上（`goals.get(agent)` 照样返回它，
 *      界面上那个目标也照样挂着）——这正是用户报的「做完了不去除目标」。
 *      ⚠️ 宿主在相位变 `complete` 时**已经 disarm**（不会继续自动续轮），
 *      所以清 goal 要解决的不是「还在跑」，而是「还在那儿」。
 *
 * ## 为什么听 `goal/changed` 而不是轮询
 *
 * 宿主 `dsh-goal` 在每次 goal 变更后 emit `goal/changed`（`{agent, change}`，
 * `change.goal.phase` 就是我们要的相位）；DSH 自己的 `dsh-goal-round-driver`
 * 也是这么听的（`ctx.on('goal/changed', ({agent, change}) => …)`）。
 * 轮询要自己算「多久查一次」，而这个事件是**变更即达**——没有延迟也没有空转。
 *
 * ⚠️ 它**不在** `session/event` 里：goal 变更走的是 agent 作用域的事件总线，
 * 与本插件其它钩子（`session/event` / `tools/*`）不是同一条。
 *
 * ## 为什么汇报是「投消息」而不是「自己写文档」
 *
 * 写文档是**大脑的活**（它手上才有 `puzzle_brain`、有冻结的文档段、有整个项目的
 * 已定事实）。这里替它写就等于长出第二套写文档的逻辑，两份必然漂移。
 * 所以只投一条汇报，让它按自己的职责回写。
 *
 * 本文件**不 import 任何 Cordis 东西**（与 `dispatchrun.js` 同一条纪律）：
 * 能力全走 `deps`，否则会造出 `index → completion → index` 的循环。
 */
import { pushHistory, verdictOf } from './dispatch.js'

/** 只处理这两个相位：其余（`active` / `paused`）不构成「该搬卡」的结论。 */
const MOVING_PHASES = ['complete', 'blocked']

/**
 * 由一次 `goal/changed` 算出「这张卡该搬去哪」（纯函数）。
 *
 * 返回 `null` 表示**不动**（相位无关、或算出来的列就是它现在所在的列）。
 *
 * 复用 `verdictOf` 而不是在这里另写一套判据：那张表（完成 > blocked >
 * agent-error > 卡死超时）是 Q7 拍板过的优先级，抄一份出来必然漂移。
 */
export function goalMoveOf(card, change) {
  if (card === null || card === undefined || typeof card !== 'object') return null
  const goal = change !== null && change !== undefined && typeof change.goal === 'object' ? change.goal : null
  const phase = goal !== null && typeof goal.phase === 'string' ? goal.phase : ''
  if (!MOVING_PHASES.includes(phase)) return null
  const reason = goal.blockedReason
  const verdict = verdictOf(card, {
    phase,
    blockedCode: reason !== null && reason !== undefined ? reason.code : '',
    blockedMessage: reason !== null && reason !== undefined ? reason.message : '',
  })
  // 列没变 = 不需要搬（比如已经「已做」的卡又收到一次 complete）。
  if (verdict.column === card.column) return null
  return verdict
}

/**
 * 把一次搬列落进卡片（纯函数，返回新卡）。
 *
 * `history` 记 `by:'auto'`——与手动搬的痕迹**格式一致**（`pushHistory` 那条注释
 * 说的就是这个），事后追查时能分清「谁搬的」。
 */
export function movedCardOf(card, verdict, note) {
  const moved = pushHistory(card, card.column, verdict.column, 'auto', note)
  return {
    ...moved,
    failure: verdict.failure !== undefined && verdict.failure !== null ? verdict.failure : null,
    // 完成 = 待验收；用户点「验收」才置 true。
    verified: verdict.column === 'done' ? false : moved.verified,
  }
}

/**
 * 投给全局大脑的**汇报正文**（纯函数）。
 *
 * 为什么要带上目标与执行提示词：大脑的上下文里**没有这张卡**——
 * 它是常驻会话，卡是后建的。不带的话它得先去 `puzzle_brain op=reports` 查一遍
 * 才知道说的是哪件事，多一次往返且可能查错。
 */
export function reportTextOf(card, verdict, extras = {}) {
  const plan = card.plan !== null && card.plan !== undefined ? card.plan : {}
  const text = (value) => (typeof value === 'string' ? value.trim() : '')
  const lines = []
  const ok = verdict.column === 'done'
  lines.push(ok ? '【执行汇报】这张任务单**做完了**。' : '【执行汇报】这张任务单**失败了**。')
  lines.push('')
  lines.push('- 任务单：' + text(card.title) + '（' + String(card.id) + '）')
  const objective = text(plan.objective)
  if (objective !== '') lines.push('- 目标：' + objective)
  const execution = text(plan.executionPrompt)
  if (execution !== '') lines.push('- 具体执行提示词：' + execution)
  if (typeof extras.sessionId === 'string' && extras.sessionId !== '') {
    lines.push('- 执行会话：' + extras.sessionId)
  }
  if (typeof extras.goalId === 'string' && extras.goalId !== '') {
    lines.push('- goal：' + extras.goalId)
  }
  const failure = verdict.failure
  if (failure !== null && failure !== undefined) {
    lines.push('- 失败原因：' + String(failure.code || '') + ' ' + String(failure.message || ''))
  }
  lines.push('')
  lines.push(ok
    ? '请按你的职责把这次执行的结果**回写进拼图文档**（该更新的模块文档 / 主文档），并判断是否需要新的任务单。'
    : '请判断：是重派、改方案，还是先问用户。')
  return lines.join('\n')
}

/**
 * 应用一次 goal 变更：搬卡 + （完成时）清 goal + （完成时）汇报大脑。
 *
 * ## 为什么搬卡与汇报**互不牵连**
 *
 * 搬卡是本地写盘（必成），汇报要起会话/投消息（可能失败）。把两者绑在一起的话，
 * 「大脑不在」会让卡**永远停在「在做」**——那是把一条旁路的失败升级成了主功能的失败。
 * 所以先搬卡落盘，再尝试汇报；汇报失败只记日志（`logFailure`），不回滚。
 *
 * ## 清 goal 只做在**完成**列，且同样不回滚搬卡
 *
 * 见 `clearGoalOf`：完成（`done`）清掉，失败（`failed`）保留。
 * 清 goal 失败也**不回滚搬卡**——搬卡是本地写盘（必成），清 goal 要走宿主服务（可能失败），
 * 两者不是一笔事务；把搬卡回滚掉只会让用户连「这张卡做完了」都看不到。
 * 失败只在返回结构里如实写 `cleared: false` + `reason`，由调用方（`index.js`）接 `logFailure`。
 *
 * @param {object} deps 见 `index.js` 的 `registerGoalWatch`
 * @returns {Promise<{moved: boolean, cleared: boolean, reported: boolean, skipped: boolean, reason: string, clearReason: string}>}
 *   `skipped: true` = **有意不做**（还没建大脑、或这是失败列），不是错误。
 *   调用方据此决定「要不要记日志」——把「用户还没点过全局大脑」记成故障，
 *   会让真故障淹在噪音里。
 *   `reason` 是**单条**字符串：搬卡失败时是搬卡的原因，否则是汇报/清 goal 的原因
 *   （调用方按 `moved` / `cleared` / `reported` 三个布尔决定这条 reason 算谁的账）。
 *   `clearReason` 单独给清 goal 的失败原因（没失败时是 `''`），见函数末尾的注释。
 */
export async function applyGoalChange(deps, agent, change) {
  const d = deps !== null && deps !== undefined ? deps : {}
  const sessionId = agent !== null && agent !== undefined && typeof agent.id === 'string' ? agent.id : ''
  if (sessionId === '') return { moved: false, cleared: false, reported: false, skipped: false, reason: '这次 goal 变更没带会话 id', clearReason: '' }
  if (typeof d.readBoard !== 'function' || typeof d.writeBoard !== 'function') {
    return { moved: false, cleared: false, reported: false, skipped: false, reason: '调用方没给看板读写口', clearReason: '' }
  }

  const board = d.readBoard()
  const cards = Array.isArray(board.cards) ? board.cards.slice() : []
  /**
   * 按 `sessionId` 找卡：一张卡被派出去时就把执行会话 id 记在卡上
   * （`runDispatch` 的「先落 sessionId」那条），所以这里是**确定**的对应关系，
   * 不靠标题或时间猜。
   */
  const at = cards.findIndex((item) => item !== null && item !== undefined && item.sessionId === sessionId)
  if (at < 0) return { moved: false, cleared: false, reported: false, skipped: false, reason: '看板上没有卡挂着这个会话', clearReason: '' }

  const card = cards[at]
  const verdict = goalMoveOf(card, change)
  if (verdict === null) return { moved: false, cleared: false, reported: false, skipped: true, reason: '相位不构成搬列，或列没变', clearReason: '' }

  // `ref` 从事件的 `change.ref` 取（理由见 `clearGoalOf` 的注释），**只透传不重算**。
  const ref = change !== null && change !== undefined ? change.ref : null
  return settleVerdict(d, agent, sessionId, cards, at, card, verdict, ref)
}

/**
 * 应用一次**观测**：搬卡 + （完成时）清 goal + （完成时）汇报大脑。
 *
 * ## 这条路补的是什么
 *
 * `applyGoalChange` 只在宿主发出 `goal/changed` 时走，而**模型不调 `update_goal`
 * 时那个事件永远不会来**（真机 2026-10-16 卡 task-0001：派出后 44 分钟零条自动痕迹，
 * goal 停在 `active`）。执行会话的每一轮结束都会发 `session/event` 的 `turn/end`，
 * 所以那条路是「模型忘了标」的兜底。
 *
 * ## 为什么直接 `verdictOf` 而不过 `goalMoveOf`
 *
 * `goalMoveOf` 有一道 `MOVING_PHASES` 门（只认 `complete` / `blocked`），
 * 于是 `verdictOf` 的判据③（会话级报错）与④（卡死超时）**永远为假**。
 * 兜底要的恰恰是这两条，所以这里把观测原样喂给 `verdictOf`——
 * 判据仍是 Q7 那张表（`dispatch.js` 里那一份），没有第二套。
 *
 * ## 列没变就不写盘
 *
 * 「列没变」在这条路上是**常态**（卡在「在做」、goal 正常推进），
 * 而写盘会平白改 `updatedAt`、并可能被别处当成一次变更。所以只在真换列时写。
 *
 * ## 返回结构
 *
 * 与 `applyGoalChange` 同一组字段（`moved/cleared/reported/skipped/reason/clearReason`），
 * 语义也一致：`skipped: true` = **有意不做**（不是错误），调用方据此决定要不要留痕。
 * 唯一一处差别在「看板上没有卡挂着这个会话」：`applyGoalChange` 那条路上它意味着
 * 出了岔子，而这条路上它是**常态**——装了插件的会话不止派单会话（澄清器 / 全局大脑
 * 也在 `wiredSessions` 名单里），它们的每一轮结束都会走到这里，所以如实报 `skipped: true`，
 * 否则故障日志会被噪音淹掉。
 *
 * @param {object} deps 与 `applyGoalChange` 同一份（见 `index.js` 的 `registerGoalWatch`）
 * @param {object} agent 执行会话的 agent（它的 `id` 就是卡上的 `sessionId`）
 * @param {object} observed `observeOf` 产出的观测
 * @param {object|null} ref 可选：清 goal 要的**期望当前 revision**（`GoalRef`）。
 *   这条路上没有 `goal/changed` 事件可借 `change.ref`，而宿主契约里
 *   `GoalView extends GoalSnapshot extends GoalRef`——`goals.get(agent)` 现读的那个视图
 *   **本身就是当前 ref**，所以调用方把它的 `{id, revision}` 传进来即可。
 *   **不传就不清 goal**（如实返回 `cleared:false` + `clearReason`），不猜 revision。
 * @returns {Promise<{moved: boolean, cleared: boolean, reported: boolean, skipped: boolean, reason: string, clearReason: string}>}
 */
export async function applyObserved(deps, agent, observed, ref = null) {
  const d = deps !== null && deps !== undefined ? deps : {}
  const sessionId = agent !== null && agent !== undefined && typeof agent.id === 'string' ? agent.id : ''
  if (sessionId === '') return { moved: false, cleared: false, reported: false, skipped: false, reason: '这次观测没带会话 id', clearReason: '' }
  if (typeof d.readBoard !== 'function' || typeof d.writeBoard !== 'function') {
    return { moved: false, cleared: false, reported: false, skipped: false, reason: '调用方没给看板读写口', clearReason: '' }
  }

  const board = d.readBoard()
  const cards = Array.isArray(board.cards) ? board.cards.slice() : []
  // 找卡逻辑与 `applyGoalChange` 同一条：卡上的 `sessionId` 是派单时落下的，是**确定**的对应关系。
  const at = cards.findIndex((item) => item !== null && item !== undefined && item.sessionId === sessionId)
  if (at < 0) {
    return { moved: false, cleared: false, reported: false, skipped: true, reason: '看板上没有卡挂着这个会话（这条会话不是派单会话）', clearReason: '' }
  }

  const card = cards[at]
  const verdict = verdictOf(card, observed)
  if (verdict.column === card.column) {
    return { moved: false, cleared: false, reported: false, skipped: true, reason: '这次观测不构成搬列，或列没变', clearReason: '' }
  }
  return settleVerdict(d, agent, sessionId, cards, at, card, verdict, ref)
}

/**
 * `applyGoalChange` 与 `applyObserved` 的**公共尾部**：搬卡落盘 → （完成时）清 goal → 汇报。
 *
 * 抽出来只为少一份漂移：两段的三条旁路关系（搬卡必成、清 goal 与汇报互不牵连、
 * 失败不回滚搬卡）是同一套语义，抄第二份迟早会走样。
 *
 * ## 失败（`failed` 列）**不**清 goal，也不汇报
 *
 * 见 `clearGoalOf`：失败不是「目标结束了」，而是「目标没做成」，用户要能点开看到它。
 * 这一支如实返回 `skipped: true`——「有意不做」不是错误。
 *
 * ## 清 goal 与汇报**互不牵连**
 *
 * 清 goal 失败也不许影响汇报：两者是两条旁路，搬卡（本地写盘，必成）已经落盘，
 * 旁路失败只如实回报，由调用方留痕。
 */
async function settleVerdict(d, agent, sessionId, cards, at, card, verdict, ref) {
  const note = verdict.reason === 'complete' ? '执行完成（自动）' : '执行失败：' + String(verdict.reason)
  const moved = movedCardOf(card, verdict, note)
  cards[at] = moved
  const written = d.writeBoard(cards)
  if (written !== undefined && written !== null && written.ok === false) {
    return { moved: false, cleared: false, reported: false, skipped: false, reason: '搬列写盘失败：' + String(written.error), clearReason: '' }
  }

  // 失败（`failed` 列）**不**清 goal：见 `clearGoalOf` 的理由。
  if (verdict.column !== 'done') {
    return { moved: true, cleared: false, reported: false, skipped: true, reason: '已搬到失败列，失败不清 goal、不汇报', clearReason: '' }
  }

  const cleared = await clearGoalOf(d, agent, ref)
  const reported = await reportToBrain(d, moved, verdict, sessionId)
  return {
    moved: true,
    cleared: cleared.ok,
    reported: reported.ok,
    skipped: reported.skipped === true,
    reason: cleared.ok ? reported.reason : cleared.reason,
    /**
     * 单独给出清 goal 的失败原因：`reason` 只有一个字段，而清 goal 与汇报是**两条**
     * 旁路——当汇报被 `skipped`（用户还没建大脑）时，调用方不能因为 `skipped` 就把
     * 清 goal 的失败一起吞掉。想让调用方分账就得分开给。
     * 只有**真尝试过清**（完成列）时才有这个字段；失败列/没搬列时是 `''`。
     */
    clearReason: cleared.ok ? '' : cleared.reason,
  }
}

/**
 * 完成之后把 goal 本身清掉（用户报的「做完了不去除目标」）。
 *
 * ## 为什么调 `clear` 而不是 `complete`
 *
 * 契约（`goals` 服务）里两个方法都在，但语义不同：
 *   - `complete(agent, ref): GoalView` —— 「Mark a current non-complete goal complete
 *     and disarm it.」它把相位留在 `complete`，`goals.get(agent)` **照样返回它**，
 *     目标仍然挂在 agent 上——这正是用户抱怨的现象，所以不能用它。
 *   - `clear(agent, ref): GoalRef` —— 「Clear the current goal while retaining a durable
 *     tombstone and history.」清掉之后当前 goal 就不存在了，`get` 返回 `undefined`；
 *     历史与墓碑仍在，可追溯。**这才是「去除目标」**。
 *
 * 另外宿主在相位变 `complete` 时**已经 disarm**（`complete` 的契约原文就是
 * 「and disarm it」），所以清 goal 不需要先 pause，也不存在「清掉一个正在跑的
 * goal」——它已经不跑了。
 *
 * ## 失败（`failed` 列）为什么**不**清
 *
 * 失败不是「这个目标结束了」，而是「这个目标**没做成**」：用户要能点开看到
 * 那个目标还在、再决定重派还是改方案。契约里 `block` 的语义也是「Mark an active
 * goal blocked **and disarm it**」——blocked 的 goal 已经 disarm，不会再自动跑轮次，
 * 留着不烧钱；而清掉会把「失败了哪件事」的唯一记录也抹掉。所以失败保留 goal，
 * 由用户显式处理（重派时 `create` 会要求先 clear/resume，那一步由用户驱动）。
 *
 * ## 纪律：清 goal 失败**不回滚搬卡**
 *
 * 与 `reportToBrain` 同一条：搬卡是本地写盘必成，清 goal 走宿主服务可能失败。
 * 这里只如实返回 `{ok, reason}`，由调用方决定留痕。
 *
 * ## 为什么 ref 直接取事件里的 `change.ref`
 *
 * `goals.clear(agent, ref)` 的 `ref` 是**乐观并发前置条件**（「expected current
 * revision」）：宿主 `expectCurrent` 拿 `ref.revision` 与**当前** `state.goal.revision`
 * 严格相等比对，不等就抛 `GOAL_STALE_REVISION`。
 *
 * 而 `goal/changed` 事件里的 `change.ref` 正是**这次变更提交后**的 ref
 * （宿主 `commit()` 里 `goalChangeRef(change)` 取的就是新快照的 `goal.revision`，
 * 而 `state.goal` 提交后就是那个新快照），所以 `change.ref` **就是当前 revision**，
 * 直接传即可——不要 ±1。（`change.goal.revision` 与它同值；`clear` 操作没有
 * `goal` 字段，所以用 `change.ref` 更稳。）
 *
 * 本函数因此只接**已经解出来的 ref**：`applyGoalChange` 从 `change.ref` 取，
 * `applyObserved` 从现读的 `goals.get(agent)` 视图取（契约里
 * `GoalView extends GoalSnapshot extends GoalRef`，视图本身就是当前 ref）。
 * 两处都不重算 revision。
 *
 * ## 拿不到 ref 就不清（不猜）
 *
 * ref 缺失时不猜 revision——宁可不做，也不要用错版本号去撞宿主的并发检查。
 * 这种情况返回 `ok: false` 并写明原因，由调用方留痕。
 */
async function clearGoalOf(d, agent, ref) {
  if (typeof d.clearGoal !== 'function') {
    return { ok: false, reason: '调用方没给清 goal 的口（deps.clearGoal）' }
  }
  if (ref === null || ref === undefined || typeof ref.id !== 'string' || !Number.isSafeInteger(ref.revision)) {
    return { ok: false, reason: '没有可用的 ref（id/revision），不敢猜 revision，跳过清除' }
  }
  try {
    // 契约保证返回墓碑 `GoalRef`；抛错才是失败（`GOAL_NOT_FOUND` / `GOAL_STALE_REVISION`）。
    await d.clearGoal(agent, { id: ref.id, revision: ref.revision })
    return { ok: true, reason: '' }
  } catch (error) {
    const raw = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
    return { ok: false, reason: '清 goal 失败：' + raw }
  }
}

/**
 * 把汇报投进这个项目的全局大脑。
 *
 * ## 三道「不做」的闸门
 *
 * 1. **项目名拿不到就不投**：大脑是项目级的，没有项目名就不知道该投给谁。
 * 2. **这个项目还没有大脑会话就不投**：`runBrain` 才有建会话的权限，
 *    这里**不自动建**——那会在用户没要求的时候起一个真会话并花模型钱。
 * 3. **投递失败不回滚搬列**：卡已经搬好了，汇报只是一条旁路（见 `applyGoalChange`）。
 */
async function reportToBrain(d, card, verdict, sessionId) {
  const project = typeof card.project === 'string' ? card.project.trim() : ''
  if (project === '') return { ok: false, skipped: false, reason: '这张卡没记项目名，不知道投给哪个大脑' }
  if (typeof d.brainSessionOf !== 'function') return { ok: false, skipped: false, reason: '调用方没给大脑登记口' }
  const brainId = String(d.brainSessionOf(project) || '')
  // 「还没建过大脑」是**正常状态**（用户没点过），不是故障 → skipped。
  if (brainId === '') return { ok: false, skipped: true, reason: '项目「' + project + '」还没有全局大脑，跳过汇报' }
  const controller = d.sessionController
  if (controller === null || controller === undefined || typeof controller.prompt !== 'function') {
    return { ok: false, skipped: false, reason: '这台部署没有 sessionController.prompt，投不了汇报' }
  }
  const text = reportTextOf(card, verdict, { sessionId, goalId: String(card.goalId || '') })
  try {
    /**
     * `mode:'queue'` 与派单首轮同一条路（那段的理由同样适用：这不是打断，
     * 是「排进 inbox」）。`signal` 是必填的——不传宿主第一行就解引用 `undefined`。
     *
     * `requestId` 含卡 id 与 goal id：同一张卡重复汇报会被宿主按幂等识别为已收，
     * 不会把同一件事说两遍。
     */
    await controller.prompt({
      requestId: 'puzzle-report-' + String(card.id) + '-' + String(card.goalId || ''),
      sessionId: brainId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, new AbortController().signal)
  } catch (error) {
    const raw = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
    return { ok: false, skipped: false, reason: '投汇报给大脑失败：' + raw }
  }
  return { ok: true, skipped: false, reason: '' }
}
