/**
 * 派单系统：**会话接线层**——把「卡」真的接到一个跑起来的会话上。
 *
 * ## 正确链路：三跳，全在进程内
 *
 * ```text
 * sessionController.create({cwd})      → { sessionId }        // 建会话
 * sessionController.resolveAgent(id)   → Agent                // 拿 live Agent
 * goals.create(agent, {objective,…})   → GoalView             // 挂 goal
 * sessionController.prompt({…})        → { accepted: true }   // 投首轮消息
 * ```
 *
 * `resolveAgent` 是关键的一跳：`create` 内部走 `ensureSession` 把 agent 发布出来，
 * `resolveAgent` 再把它取回。**不需要新工具，也不需要任何 Remote 端点。**
 * （`connection` 上**没有 `call`**，只有 `rpc`/`fetch`/`operator`/`requestRejection`/
 * `admit`/`authorizeIndex`/`authenticatedUrl`——照 `connection.call` 写会得到 undefined。）
 *
 * ## 依赖全走参数、不 import Cordis
 *
 * 这一层要碰四个宿主服务，而它们**真会起会话、真会花钱**。塞进 `index.js` 的话测试
 * 只能靠起真会话来验，既慢又贵还依赖网络。所以服务全部由调用方打包成 `deps` 传进来，
 * 测试传假对象即可驱动**全部**分支（含三条失败路径）。
 *
 * ## 红线：写盘只走 `writeBoard`
 *
 * 任务单在 `拼图/` 下，受插件自己的文档锁保护。这里**从不直接写文件**——只调调用方
 * 给的 `writeBoard`（内部走 `atomicWrite`）。绕过去会被自己的锁拦下，也会绕过
 * `mkdirSync`（`<工作区>/拼图/` 可能还不存在）。
 */
import {
  CLARIFIER_MAX_ROUNDS,
  dispatchVerdict,
  clarifyVerdict,
  goalRequestOf,
  firstPromptOf,
  clarifierPromptOf,
  CLARIFIER_SYSTEM,
  pushHistory,
} from './dispatch.js'
import { brainDocHolder, brainDocText, brainPromptOf, BRAIN_CONTEXT_SECTION_NAME, BRAIN_CONTEXT_SECTION_ORDER } from './brain.js'
import { projectFolderOf } from './docfs.js'
import { dataWorkspaceRoot } from './settings.js'

/** 澄清器要重新注入的那一段：与大脑的文档段**同名同序**（它就是同一份文本）。 */
const BRAIN_DOC_SECTION = { name: BRAIN_CONTEXT_SECTION_NAME, order: BRAIN_CONTEXT_SECTION_ORDER }

/**
 * 现在盘上的文档文本（重新读一遍）。
 *
 * 为什么澄清器要**重读**而不是继承大脑那份冻结快照：大脑那份是「上次压缩时」
 * 的版本，而澄清器是**现在**开始问的——它必须看到此刻的事实，
 * 否则会拿一份过期文档去问用户（那正是大脑文件头警告的「别拿记忆当现状」）。
 */
function currentDocText(deps) {
  const source = typeof deps.clarifierSource === 'function' ? deps.clarifierSource() : {}
  const s = source !== null && source !== undefined ? source : {}
  return brainDocText(
    typeof s.mainDoc === 'function' ? s.mainDoc() : s.mainDoc,
    typeof s.moduleIndex === 'function' ? s.moduleIndex() : s.moduleIndex,
  )
}

/**
 * **从大脑分叉一个子会话**（v2.2.0）：澄清器继承上下文的落点。
 *
 * ## 为什么用 `sessionController.fork` 而不是自己复制消息
 *
 * 宿主那个 `fork` 是**真分叉**：它读源会话的事件日志、取到最后一个完整轮次的
 * 边界（`latestCompletedPrefixBoundary`）、用 `buildForkSeed` 复制那段前缀并
 * 给开着的 turn 补上合成收尾，然后 `agents.create({seed, inheritedEventCount,
 * meta:{parentSession}})` 建出一个**带父子关系**的真会话。
 * 自己复制消息做不到这些（尤其是「开着 turn 的收尾」与父会话记账）。
 *
 * ## 失败为什么要如实报错、而不是退回「新建一个」
 *
 * 用户要的语义就是「继承上下文」。fork 失败时新建一个**不继承**的会话，
 * 会让用户以为澄清器记得住——而它其实什么都不知道。那比直接报错更坏：
 * 报错他还能重试，静默降级他会在几轮对话之后才发现澄清器在自说自话。
 *
 * ## 边界：大脑一个完整轮次都还没有时 fork 不了
 *
 * `fork` 的默认边界是「最后一个完整轮次」。大脑刚建出来、首轮消息还在跑时
 * 就没有这个边界，宿主会回 `session/fork-unavailable`。这条**如实报出来**，
 * 并告诉用户出路（等大脑答完一轮再点，或直接在大脑里说）。
 */
async function forkSession(deps, sourceId) {
  const controller = deps.sessionController
  if (controller === null || controller === undefined || typeof controller.fork !== 'function') {
    return {
      ok: false,
      error: '这台部署的 sessionController 没有 fork 方法',
      hint: '澄清器要继承全局大脑的上下文，靠的就是它。没有它只能新建一个没有上下文的会话。',
    }
  }
  let forked
  try {
    forked = await controller.fork({ sessionId: sourceId, increaseTitle: false })
  } catch (error) {
    const raw = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
    return {
      ok: false,
      error: '从全局大脑分叉失败：' + raw,
      hint: '最常见的原因是大脑**还没有跑完一个完整轮次**（刚建出来时就是这样）。'
        + '先去大脑里说一句话、等它答完，再回来点「开始澄清」。',
    }
  }
  const sessionId = sessionIdOf(forked)
  if (sessionId === '') {
    return { ok: false, error: 'fork 没有返回会话 id', hint: '这台部署的 fork 返回形状与预期不符。' }
  }
  const alive = await agentOfSession(deps, sessionId)
  if (alive.ok !== true) {
    return {
      ok: false,
      error: '分叉出来的会话拿不到 agent：' + String(alive.reason || ''),
      hint: '会话 ' + sessionId + ' 已经存在，但它没有活跃 agent。',
      sessionId,
    }
  }
  return { ok: true, sessionId, agent: alive.agent, forked: true }
}


/**
 * 从 sessionController 的返回值里取 sessionId——**两种形状都认**。
 *
 * `create` 直接返回 `{sessionId}`；而某些部署里它可能是 `{value:{sessionId}}`。
 * 认两种而不是只认一种：猜错的代价是「创建成功了但插件说失败」，
 * 于是用户重试，最后建出一堆孤儿会话。
 */
function sessionIdOf(created) {
  if (created === null || created === undefined || typeof created !== 'object') return ''
  if (typeof created.sessionId === 'string' && created.sessionId !== '') return created.sessionId
  const inner = created.value
  if (inner !== null && inner !== undefined && typeof inner === 'object') {
    if (typeof inner.sessionId === 'string' && inner.sessionId !== '') return inner.sessionId
  }
  return ''
}

/**
 * 把 `sessionController.create` 的失败翻译成**用户能照着做的话**。
 *
 * 为什么要翻译而不是把原始错误抛给用户：这个接口的失败几乎全是**环境问题**
 * （没绑工作区、目录不存在、会话已被占用），而它们的原始报错是
 * `RemoteError: session/conflict` 这种——用户看到它不知道该动哪里。
 */
function createFailure(error) {
  const raw = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
  const code = error !== null && error !== undefined && typeof error.code === 'string' ? error.code : ''
  if (code === 'session/conflict' || raw.includes('cwd')) {
    return { error: '建会话失败：工作目录对不上', hint: '这个会话 id 已经被另一个目录的会话占用了。换一张卡重试，或先核对面板「派单设置」里显示的执行工作区。' }
  }
  if (code === 'session/writer-held') {
    return { error: '建会话失败：这个会话 id 已经被占用', hint: '另一个进程正拿着它。等它释放后重试。' }
  }
  return { error: '建会话失败：' + raw, hint: '执行工作区默认是 `<数据工作区>/<项目名>`；核对面板「派单设置」里显示的那个路径是不是真实存在。' }
}

/**
 * 取这张卡的**执行工作区**（派单会话的 cwd）**以及它是怎么来的**。
 *
 * ## 解析顺序（v2.4.2 起有了第三档默认值）
 *
 * ```text
 * ① perProject[项目名]                      —— 用户显式指定的单项目覆盖
 * ② globalPath/项目名                        —— 用户显式指定的全局根
 * ③ <数据工作区>/<项目名>   ← **默认**（v2.4.2）
 * ④ 空                                     —— 连数据工作区都没绑
 * ```
 *
 * ## 为什么 ③ 是这一版改的东西
 *
 * 用户拍板：「执行工作区机制改为默认在拼图项目文件夹内」。
 *
 * 原先 ③ 不存在——没配就是空，派单**当场失败**（「还没配代码工作区，派出去没地方改代码」）。
 * 而「这个项目的活就在这个项目的文件夹里干」本来就是最自然的默认：拼图文档住在
 * `<数据工作区>/<项目名>/拼图/`，代码与文档同处一个项目文件夹，AI 一眼就能同时看见
 * 两边（文档说「改 auth 模块」时它不用跨目录找代码）。
 *
 * ## ④ 仍然如实报错，**不兜底成别的目录**
 *
 * 没绑数据工作区时连 `<项目名>` 都拼不出来。这时退回 `process.cwd()` 之类的
 * 猜测会让 AI 在一个用户看不见的目录里改代码——比明确报错坏得多。
 *
 * @returns `{path, source}`；`source` ∈ `perProject` / `global` / `projectFolder` / `none`
 */
export function codeRootInfoOf(settings, project) {
  const s = settings !== null && settings !== undefined ? settings : {}
  const code = s.codeWorkspace !== null && s.codeWorkspace !== undefined ? s.codeWorkspace : {}
  const name = typeof project === 'string' ? project.trim() : ''
  const perProject = code.perProject !== null && code.perProject !== undefined && typeof code.perProject === 'object' ? code.perProject : {}
  if (name !== '' && typeof perProject[name] === 'string' && perProject[name].trim() !== '') {
    return { path: perProject[name].trim(), source: 'perProject' }
  }
  const globalPath = typeof code.globalPath === 'string' ? code.globalPath.trim() : ''
  if (globalPath !== '') {
    if (name === '') return { path: globalPath, source: 'global' }
    const sep = globalPath.endsWith('/') || globalPath.endsWith('\\') ? '' : '/'
    return { path: globalPath + sep + name, source: 'global' }
  }
  /**
   * 默认档：**拼图项目文件夹**。与 `puzzleDirOf` 用的是同一个 `projectFolderOf`，
   * 所以「文档在哪」与「代码在哪」不可能漂移（v2.4.2 把这层收成了一份）。
   */
  if (name === '') return { path: '', source: 'none' }
  const folder = projectFolderOf(dataWorkspaceRoot(s), name)
  if (folder === null) return { path: '', source: 'none' }
  return { path: folder, source: 'projectFolder' }
}

/**
 * 取这张卡的**执行工作区**（只要路径）。没配时落到拼图项目文件夹。
 *
 * 保留这个薄壳是因为调用点有四处，而只有面板需要知道「它怎么来的」。
 */
export function codeRootOf(settings, project) {
  return codeRootInfoOf(settings, project).path
}

/**
 * 把「会话已经建出来了」这件事**落盘**，然后原样返回那个失败结论。
 *
 * ## 为什么失败路径也必须写盘
 *
 * `openSession` 的前两跳之间失败时（建会话成功、拿 agent 失败），会话**已经真的存在**。
 * 不写盘的话用户看到「失败」，而磁盘上留着一个没人知道的会话，重试还会再建一个。
 *
 * 这条**不是理论风险**：本模块的测试里就抓到过一次——第一版直接在失败分支
 * `return opened`，于是 `resolveAgent` 抛错时会话 id 只出现在提示文字里、
 * 没进看板。用户关掉提示就再也找不回那个会话了。
 */
function stampFailure(deps, cards, at, field, sessionId, outcome) {
  if (typeof sessionId !== 'string' || sessionId === '') return outcome
  cards[at] = { ...cards[at], [field]: sessionId, updatedAt: Date.now() }
  const written = deps.writeBoard(cards)
  if (written !== undefined && written !== null && written.ok === false) {
    return { ...outcome, hint: String(outcome.hint || '') + '（另外：看板写不进去——' + String(written.error) + '）' }
  }
  return { ...outcome, sessionId, recorded: true }
}

/**
 * 起一个会话并拿回它的 live Agent（**三跳里的前两跳**，两处共用）。
 *
 * 抽出来是因为澄清器与派单执行**必须走同一条路**：两条各写一遍的话，
 * 迟早一条修了 bug 另一条没修（本仓记过多次「同一件事两处各写一份会漂移」）。
 *
 * 失败时**尽量带上 `sessionId`**：只要会话建出来了，调用方就有责任把它落盘。
 */
async function openSession(deps, input) {
  const controller = deps.sessionController
  if (controller === null || controller === undefined) {
    return { ok: false, error: '这台部署没有 sessionController 服务', hint: '起会话是宿主能力；缺它就没法把卡派出去。' }
  }
  if (typeof controller.create !== 'function' || typeof controller.resolveAgent !== 'function') {
    return { ok: false, error: 'sessionController 缺 create / resolveAgent', hint: '这台部署的会话服务接口与预期不符。' }
  }
  let created
  try {
    created = await controller.create(input.create)
  } catch (error) {
    return { ok: false, ...createFailure(error) }
  }
  const sessionId = sessionIdOf(created)
  if (sessionId === '') {
    return { ok: false, error: '建会话没有返回会话 id', hint: '这台部署的 create 返回形状与预期不符——没有 id 就没法继续。' }
  }
  let resolved
  try {
    resolved = await controller.resolveAgent(sessionId)
  } catch (error) {
    const raw = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
    return {
      ok: false,
      error: '会话建好了但拿不到它的 agent',
      hint: '会话 ' + sessionId + ' 已经存在，但没有活跃 agent（' + raw + '）。它可能是空会话——先在界面上打开它一次，再重试。',
      sessionId,
    }
  }
  /**
   * ## `resolveAgent` 返回的是**信封**，不是 agent 本身（v2.1.6 修的真 bug）
   *
   * 症状（用户报「它自己不知道在搞什么飞机」）：会话建出来了、提示词也投进去了，
   * 但浮窗底部报 `⚠️ puzzle_mode 没装上（这个会话拿不到 agent 作用域）`——
   * 于是模型手里**没有** `puzzle_mode`，只能去翻源码找 `op:init`、`isSessionWired`
   * 这些字符串，看起来就是「瞎搞」。
   *
   * 根因：`sessionController.resolveAgent(id)` 的返回值是
   * `{ agent }` / `{ error }` 这两种**信封**，**从来不是** agent 本身
   * （`dsh-api-session-controller/lib/index.js:375`：
   * `return hasApiSessionSubagentOwner(…) ? { error: … } : { agent }`）。
   *
   * 宿主自己的取值代码就是范本（`:187-190`）：
   * ```js
   * const found = await this.resolveAgent(sessionId)
   * if ('error' in found) throw found.error
   * return found.agent
   * ```
   *
   * 我原先直接把返回值当成 agent 用，于是 `agent.ctx` 恒为 `undefined`
   * → `installSessionTools` 立刻走「拿不到 agent 作用域」那条 → 工具装不上。
   *
   * ⚠️ 这条**同时**坏掉了派单：`goals.create(opened.agent, …)` 拿到的也是信封。
   * 所以这不是「新建项目」独有的事，是 `openSession` 这一处共用的缺陷。
   */
  if (resolved !== null && resolved !== undefined && 'error' in resolved) {
    const raw = resolved.error !== null && resolved.error !== undefined && resolved.error.message !== undefined
      ? String(resolved.error.message)
      : String(resolved.error)
    return {
      ok: false,
      error: '会话建好了但拿不到它的 agent',
      hint: '会话 ' + sessionId + ' 已经存在，但没有可用的 agent（' + raw + '）。',
      sessionId,
    }
  }
  const agent = resolved === null || resolved === undefined ? undefined : resolved.agent
  if (agent === null || agent === undefined) {
    return { ok: false, error: '会话建好了但 agent 是空的', hint: '会话 ' + sessionId + ' 没有活跃 agent，无法挂 goal。', sessionId }
  }
  return { ok: true, sessionId, agent }
}

/**
 * 往会话里投**首轮消息**。
 *
 * `mode:'queue'` 而不是 `'steer'`：这些会话是**刚建的、空跑的**，
 * 没有正在进行的轮次可供 steer；用 steer 会静默丢弃（或者更糟——塞进一个
 * 不存在的中断点）。queue 的语义是「排进 inbox」，正是我们要的。
 *
 * `requestId` 由调用方给且**每张卡唯一**：接口按它做幂等
 * （`hasPromptRequest(agent, requestId)`），重复投递同一条会被识别为已收。
 * 所以重试安全，但也意味着**同一张卡不能复用它**——否则第二次派单的消息会被吞掉。
 */
async function sendPrompt(deps, sessionId, text, requestId) {
  const controller = deps.sessionController
  if (typeof controller.prompt !== 'function') {
    return { ok: false, error: 'sessionController 没有 prompt 方法', hint: '会话建好了，但这台部署没法往里投消息。' }
  }
  /**
   * ## `signal` 是**必填**的（v2.1.5 修的真 bug）
   *
   * 症状：点「快速建空壳 / 采访后再建」报
   * `Cannot read properties of undefined (reading 'throwIfAborted')`，
   * 会话建出来了、`puzzle_mode` 也装上了，**只有首轮消息没投进去**——
   * 于是那个会话是个空壳，AI 什么也没干，浮窗也不会弹（浮窗只在投递成功后开）。
   *
   * 根因：`sessionController.prompt(request, signal)` 的**第二个参数是必填的**。
   * 宿主实现第一行就是 `signal.throwIfAborted()`（`dsh-api-session-controller/lib/index.js:3097`），
   * 不传就解引用 `undefined` 直接抛。契约里它也确实是必填
   * （typert 声明 `cancellation: { parameter: 'signal' }`）。
   *
   * ⚠️ 这条**只影响 `prompt`**：`create` 与 `resolveAgent` 都不收 signal
   * （`:2971` / `:2930`）。所以前两跳一直是好的，坏的只有第三跳——
   * 这也正是错误信息说「会话建好了但首轮消息没投进去」的原因。
   *
   * 传「一个永不中止的信号」是**如实表达「本调用方没有取消来源」**：
   * 这个 RPC 处理器是 `(req, res)`，宿主不给它生命周期 signal。
   * 不写超时——投递失败宿主会自己抛，凭空加一个超时是发明新的失败模式。
   */
  try {
    await controller.prompt({
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, new AbortController().signal)
  } catch (error) {
    const raw = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
    return {
      ok: false,
      error: '会话建好了但首轮消息没投进去',
      hint: '会话 ' + sessionId + ' 已经存在（' + raw + '）。它是个空会话，可以手动打开它接着用。',
      sessionId,
    }
  }
  return { ok: true }
}

/**
 * **派单执行**：把「未接单」的卡真的派出去。
 *
 * ## 写盘顺序为什么是这样
 *
 * `sessionId` 一拿到就**立刻写盘**，而不是等 goal 挂完一起写。
 * 理由：挂 goal 或投消息都可能失败，而那时会话**已经真的建出来了**。
 * 不写盘的话，用户看到的是「派单失败」，但磁盘上留着一个没人知道的孤儿会话，
 * 而且重试会再建一个。先落 `sessionId`，失败路径才能告诉用户
 * 「会话 X 建出来了，卡上记着它」——可追溯比「干净」重要。
 */
export async function runDispatch(deps, input) {
  const board = deps.readBoard()
  const cards = Array.isArray(board.cards) ? board.cards.slice() : []
  const at = cards.findIndex((item) => item.id === input.cardId)
  if (at < 0) return { ok: false, error: '找不到卡片 ' + String(input.cardId) }
  const card = cards[at]

  const verdict = dispatchVerdict(card)
  if (verdict.ok !== true) return { ok: false, error: verdict.error, hint: verdict.hint }

  const goal = goalRequestOf(card.plan, card.maxGoalRounds)
  if (goal.ok !== true) return { ok: false, error: goal.error, hint: goal.hint }
  const code = codeRootInfoOf(deps.settings, deps.project)
  const codeRoot = code.path
  if (codeRoot === '') {
    /**
     * ⚠️ v2.4.2 起这条**几乎只剩一种触发方式**：没绑数据工作区（或没给项目名）。
     *
     * 默认档已经是「拼图项目文件夹」，所以「没配执行工作区」不再是一个需要用户
     * 先去配的独立状态——文案必须跟着改，否则用户会去「派单设置」里找一个
     * **不配也能用**的东西。那条路现在是「想覆盖默认时用」。
     */
    return {
      ok: false,
      error: '派不出去：拼不出执行工作区',
      hint: '默认执行工作区是 `<数据工作区>/<项目名>`。现在拼不出来，通常是**还没绑数据工作区**'
        + '（那就先在一级页绑一个），或者这张卡没有项目名。'
        + '若确实要指到别处，去「派单设置」里覆盖。',
    }
  }

  /**
   * **`goals` 的可用性必须在建会话之前查**。
   *
   * 这条是接线层测试之外的第二次修正：第一版把它放在 `openSession` 之后，
   * 于是「这台部署没有 goals」这条路上，点一次「派出去」就会**先建出一个真会话**
   * 再报错——那个会话没有任何 goal 驱动它，永远不会干活，却真的占着资源。
   *
   * 判据很直接：**能力缺失是前置条件，不是运行期错误**。缺它就压根不该动手，
   * 与「没配代码工作区」同一类（那条一开始就放在前面，是对的）。
   */
  const goals = deps.goals
  if (goals === null || goals === undefined || typeof goals.create !== 'function') {
    return {
      ok: false,
      error: '这台部署没有 goals 服务，派出去也没人驱动它',
      hint: '没有 goal 就没有「做完了没有」的判据，所以这一步不会假装成功——也不会先建一个没人管的会话。',
    }
  }

  const opened = await openSession(deps, { create: { cwd: codeRoot } })
  if (opened.ok !== true) return stampFailure(deps, cards, at, 'sessionId', opened.sessionId, opened)

  /**
   * **先落 sessionId**：会话已经真的存在了，无论后面成败都必须可追溯。
   *
   * 同时落 `project`（v2.2.9）：卡上记下它属于哪个项目。而「执行完成后汇报全局大脑」
   * 必须知道投给哪个项目的大脑（大脑是项目级的）——不落这一笔，那条汇报就只能放弃。
   * 这是**唯一**知道「这张卡属于哪个项目」的时刻（派单请求里带着 project）。
   *
   * ⚠️ v2.4.3 起看板**本身**就是项目级的，v2.4.9 起**一张卡一个文件**（`<数据工作区>/拼图/<项目名>/派单/<卡 id>.json`），
   * 所以「卡属于哪个项目」从看板路径就能推出来。卡上这一笔仍然保留：
   * `goal/changed` 钩子只拿得到 `sessionId`，要靠扫各项目的看板反查项目
   * （见 `index.js` 的 `registerGoalWatch`），而汇报大脑时也需要它。
   */
  const stamped = { ...card, sessionId: opened.sessionId, project: String(deps.project || ''), updatedAt: Date.now() }
  cards[at] = stamped
  const firstWrite = deps.writeBoard(cards)
  if (firstWrite !== undefined && firstWrite !== null && firstWrite.ok === false) {
    return { ok: false, error: '会话已建好但看板写不进去：' + String(firstWrite.error), hint: '会话 ' + opened.sessionId + ' 已经存在，但它没被记到卡上。' }
  }

  let view
  try {
    view = goals.create(opened.agent, goal.request)
  } catch (error) {
    const raw = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
    return {
      ok: false,
      error: '挂 goal 失败：' + raw,
      hint: '会话 ' + opened.sessionId + ' 已建好并记在卡上，但没有 goal——派单不算成功。',
      sessionId: opened.sessionId,
    }
  }
  const goalId = view !== null && view !== undefined && typeof view.id === 'string' ? view.id : ''
  const revision = view !== null && view !== undefined && Number.isSafeInteger(view.revision) ? view.revision : null

  /**
   * **专属工具（T1–T4）：只给派单会话**。
   *
   * 装在 `resolveAgent` 之后、`sendPrompt` 之前——首轮消息就是模型第一次看见工具清单的时刻，
   * 装晚了第一轮就得用原版那套大 schema（而且 `restrict` 对已开始的轮次是否生效没法保证）。
   *
   * ## 装不上为什么**不拦派单**
   *
   * 用户拍板的取舍：**宁可功能少一点，也不要整件事失败**。装不上只是「这轮贵一点」，
   * 而不派单是「活没干」。所以这里降级继续，只在回报里如实写 `scopedTools` 字段——
   * 含糊的「成功」会让「专属工具已生效」这个承诺变成空话。
   *
   * ## 为什么 `runClarify` 不装
   *
   * 澄清器走 `puzzle_context`（另一套窄口子，检索专用），它要读的是拼图文档而不是代码。
   * 给它装一套写代码的工具，与「你不写代码」那条纪律直接矛盾。
   */
  const scopedInstaller = typeof deps.installScopedTools === 'function' ? deps.installScopedTools : null
  const scoped = scopedInstaller !== null
    ? scopedInstaller(opened.agent, { cwd: codeRoot })
    : { ok: false, registered: [], denied: [], reason: '调用方没提供 installScopedTools' }

  /**
   * **执行会话不装 `puzzle_mode`**（v2.4.15，用户拍板）。
   *
   * 用户原话：「执行会话后面不应该是向全局大脑汇报吗？怎么有拼图文档读写的工具？」
   *
   * 这条问得对，而且指出了一个**职责重叠**：v2.1.1 起执行会话被装上了
   * `puzzle_mode`（读写拼图文档），可文档本来该由**全局大脑**独占——
   * 它手上才有冻结的文档段、整个项目的已定事实、以及 `puzzle_brain`。
   * 两处都能写文档，冲突是迟早的事：执行会话按自己这一轮的局部视角改一处，
   * 而大脑手上是全局，下一次刷新就把它的改动覆盖或写歪。
   *
   * 拍板后的分工（一列一件事的同一原则）：
   *
   * | 会话 | 干什么 | 手上有什么 |
   * |---|---|---|
   * | 执行会话 | **改代码** | 六个 `pz_*`（沙箱内读写代码） |
   * | 全局大脑 | **写文档** | `puzzle_mode` + `puzzle_brain` + 冻结文档段 |
   * | 澄清器 | 问方案、写任务单 | `puzzle_mode` + `puzzle_context` + `puzzle_task` |
   *
   * 执行做完之后由 `completion.js` 把结论**投一条汇报给大脑**，由它回写文档——
   * 那条路本来就写好了，这里只是把「执行会话也能自己写」这个旁路去掉。
   *
   * ## 为什么仍然要 `markWired`
   *
   * 不装 `puzzle_mode` **不等于**「这个会话不受插件管」：它还挂着 `pz_*`，
   * 而 `tools/post-execute` 的**越界提醒**（T4）正是按 `isSessionWired` 判断
   * 「这个会话要不要提醒」的。不记名单，执行会话的越界写就没人提醒了。
   * 所以名单照记，只是不注册文档工具与文档规则段。
   */
  const wireInstaller = typeof deps.markSessionWired === 'function' ? deps.markSessionWired : null
  if (wireInstaller !== null) wireInstaller(opened.agent)

  /**
   * **首轮消息必须带上「做完自己标完成」**（v2.4.15，用户报「做完了面板不移动任务卡」的根因）。
   *
   * ## 为什么这一句是必须的
   *
   * 「做完了」这件事**只有执行会话自己知道**。而面板上「在做 → 已做」的自动搬卡、
   * 清掉 goal、向全局大脑汇报——**三件事全部挂在 goal 变成 `complete` 这一个事件上**
   * （见 `completion.js` 的 `applyGoalChange` 与 `index.js` 的 `registerGoalWatch`）。
   *
   * 会话不标完成 ⇒ goal 永远停在 `active` ⇒ 那三件事一件都不发生：
   * 卡烂在「在做」列、goal 一直挂着烧轮次预算、大脑永远收不到汇报。
   * 用户报的第 ③ 条（做完了不去除目标）与第 ⑤ 条（做完面板不搬卡）**是同一个根因**。
   *
   * ## 真机证据（2026-10-16，卡 task-0001）
   *
   * 卡在 20:22:41 被派出去（`history` 里有 `by:'auto'` 的「派单执行」，说明
   * `sendPrompt` 成功了——那一笔写在它**之后**），此后 44 分钟没有任何自动痕迹，
   * 最后是用户**手动**把它移到「失败」。
   * 而插件故障日志里 `钩子:执行完成搬卡` **一条都没有**——说明 `goal/changed`
   * 从来没携带过 `complete`/`blocked` 相位。也就是说：**不是插件搬错了，
   * 是根本没人告诉它做完了。**
   *
   * ## 为什么加在这里而不是 `firstPromptOf`
   *
   * `firstPromptOf(plan)` 的契约是「把 plan 投影成一段文字」，它是**纯函数**、
   * 有测试逐字钉着（`bare === '**目标**：ONLY_OBJECTIVE'`）。
   * 而「做完要标完成」不是 plan 的内容，是**派单这件事的收尾纪律**——
   * 它依赖 goal（`goalId` / revision），只有这一层知道。
   * 塞进 `firstPromptOf` 会把一个与 plan 无关的常量混进纯投影，还会打破那条测试。
   */
  const firstPrompt = firstPromptOf(card.plan) + [
    '',
    '---',
    '',
    '**做完请自己收尾**（很重要，否则面板不会动）：',
    '- 全部做完、且上面的验收判据都满足之后，调 `update_goal` 把本 goal 标成 `complete`'
      + '（`action: "complete"`，带上当前 goal 的 id 与 revision）。',
    '- 这一步**不能省**：面板上「在做 → 已做」的搬卡、goal 的清除、以及向全局大脑的汇报，'
      + '三件事都只由它触发。不标完成，这张卡会一直停在「在做」。',
    '- 确实做不成（被卡住、重试也过不去）就标 `blocked` 并写清 `blocked_reason`，'
      + '卡会落到「失败」列——不要既不标完成也不标失败就停下。',
  ].join('\n')
  const prompt = await sendPrompt(deps, opened.sessionId, firstPrompt, 'puzzle-dispatch-' + String(card.id))
  if (prompt.ok !== true) {
    return {
      ok: false,
      error: prompt.error,
      hint: prompt.hint + '（goal ' + goalId + ' 已经挂上了）',
      sessionId: opened.sessionId,
      goalId,
    }
  }

  const moved = pushHistory(
    {
      ...stamped,
      goalId,
      goalRevision: revision,
      roundsStarted: Number.isSafeInteger(view.roundsStarted) ? view.roundsStarted : 0,
      maxGoalRounds: goal.request.maxGoalRounds,
      failure: null,
    },
    card.column,
    'doing',
    'auto',
    '派单执行',
  )
  cards[at] = moved
  const written = deps.writeBoard(cards)
  if (written !== undefined && written !== null && written.ok === false) {
    return { ok: false, error: '派单成功但看板写不进去：' + String(written.error), hint: '会话 ' + opened.sessionId + ' 与 goal ' + goalId + ' 都已经真的存在了。' }
  }
  /**
   * `scopedTools` 三态，照 `systemWired` 的先例：**含糊的「成功」会让承诺变成空话**。
   *   - `'installed'`：六个工具装上、原版已遮；
   *   - `'partial'`：装上了但没遮成原版（此时实现内部已整体回退，所以实际等于没装）；
   *   - `'failed'`：压根没装上，附 `scopedReason`。
   */
  const scopedState = scoped.ok === true ? 'installed' : 'failed'
  return {
    ok: true,
    result: {
      card: moved,
      sessionId: opened.sessionId,
      goalId,
      goalRevision: revision,
      /**
       * **实际用了哪个执行工作区，以及它怎么来的**（v2.4.2）。
       *
       * 回报它是为了「可核」：默认档下这个路径不是用户填的，而是推导出来的
       * （`<数据工作区>/<项目名>`）。不回的话，用户看到 AI 改了项目文件夹里的东西
       * 只能猜「它为什么在那儿干活」。
       */
      codeRoot,
      codeRootSource: code.source,
      scopedTools: scopedState,
      scopedRegistered: Array.isArray(scoped.registered) ? scoped.registered : [],
      scopedDenied: Array.isArray(scoped.denied) ? scoped.denied : [],
      scopedReason: scoped.ok === true ? '' : String(scoped.reason || ''),
      /**
       * ⚠️ **执行会话没有 `puzzle_mode`**（v2.4.15，用户拍板）。
       *
       * 面板靠这两个字段显示「这个会话手上有什么」。旧版这里是「装没装上
       * `puzzle_mode`」的三态；现在**故意不装**，所以如实回报 `'by-design'`，
       * 让面板说「文档由大脑写」而不是报警说「没装上」——
       * 把设计说成故障，用户会去修一个不存在的问题。
       */
      wired: 'by-design',
      wiredSection: false,
      wiredTool: false,
      wiredReason: '',
      board: deps.readBoard(),
    },
    hint: '已派出去：会话 ' + opened.sessionId + '，goal 上限 ' + goal.request.maxGoalRounds + ' 轮。'
      + '它在 `' + codeRoot + '` 里干活'
      + (code.source === 'projectFolder' ? '（默认：拼图项目文件夹）' : '（你在派单设置里指定的）') + '。'
      + '做完会自动落到「已做」（标未验收），并把结论汇报给全局大脑，由它回写文档。'
      + (scoped.ok === true
        ? '专属工具已生效（' + (scoped.registered || []).length + ' 个 pz_*，遮掉 ' + (scoped.denied || []).length + ' 个原版）。'
        : '⚠️ 专属工具**没装上**（' + String(scoped.reason || '未知原因') + '），这一轮用的是宿主原版工具。')
      + '这个会话**不装文档工具**（v2.4.15 拍板）：文档只由全局大脑写。',
  }
}

/**
 * **起一个「建项目」会话**（v2.1.2）：把一级页的「快速建空壳 / 采访后再建」接上。
 *
 * ## 为什么这两颗按钮需要真会话
 *
 * 它们要干的事是「让 AI 去读工作区、按真实分层拆模块、再调 `op:init`」——
 * 那是**模型**的活，面板算不出来。面板能做的只有把提示词拼好（模板在浏览器半，
 * 是**唯一**一份），再请宿主起一个会话把那段话投进去。
 *
 * ## 为什么提示词由调用方给，而不是在这里拼
 *
 * 模板住在 `lib/client.js`（浏览器半），宿主半 import 不到它。在宿主再抄一份
 * 就会有两个真相：改了一边另一边不跟随，而症状是「AI 照旧规则干活」——
 * 不报错、只是慢慢做错。所以这里**只收一段现成文本**，原样投出去。
 *
 * ## cwd 是**数据工作区**（与澄清器同一条理由）
 *
 * 项目文档要落在 `<数据工作区>/<项目名>/拼图/`，而 `op:init` 的相对路径判断、
 * 模型的 read / grep 全部相对 cwd。拿别处的目录当 cwd，模型就看不见工作区里
 * 已有的东西——那正是「照现有项目搭文档」这条路的全部依据。
 *
 * ## 装不上 `puzzle_mode` 为什么**不拦**
 *
 * 与派单同一条取舍：宁可功能少一点，也不要整件事失败。只是这个会话里
 * 模型**没有** `puzzle_mode`，它建不了项目——所以 `wired` 必须如实回报，
 * 面板要把它显示出来，而不是说一句含糊的「已起会话」。
 */
export async function runBuildSession(deps, input) {
  const prompt = typeof input.prompt === 'string' ? input.prompt : ''
  if (prompt.trim() === '') {
    return { ok: false, error: '提示词是空的', hint: '面板会按表单拼好提示词；手调 RPC 时要自己给 prompt。' }
  }
  const dataRoot = typeof deps.dataWorkspace === 'string' ? deps.dataWorkspace.trim() : ''
  if (dataRoot === '') {
    return {
      ok: false,
      error: '还没绑数据工作区，建出来的文档没地方放',
      hint: '先在一级页「数据工作区」绑定一个工作区：项目文档会落在 <工作区>/<项目名>/拼图/。',
    }
  }

  const opened = await openSession(deps, { create: { cwd: dataRoot } })
  if (opened.ok !== true) return opened

  const wireInstaller = typeof deps.installSessionTools === 'function' ? deps.installSessionTools : null
  const wired = wireInstaller !== null
    ? wireInstaller(opened.agent)
    : { ok: false, section: false, tool: false, reason: '调用方没提供 installSessionTools' }

  /**
   * `requestId` 必须**每次唯一**：宿主按它做幂等，重复投同一条会被当成已收。
   * 所以带上调用方给的值（面板每次点击生成一个），缺了就退回时间戳 + 计数。
   */
  const requestId = typeof input.requestId === 'string' && input.requestId !== ''
    ? input.requestId
    : 'puzzle-build-' + Date.now() + '-' + (buildSeq += 1)
  const sent = await sendPrompt(deps, opened.sessionId, prompt, requestId)
  if (sent.ok !== true) return sent

  return {
    ok: true,
    result: {
      sessionId: opened.sessionId,
      wired: wired.ok !== true ? 'failed' : (wired.section && wired.tool ? 'both' : 'partial'),
      wiredTool: wired.tool === true || wired.already === true,
      wiredReason: wired.ok === true ? '' : String(wired.reason || ''),
    },
    hint: '已起会话 ' + opened.sessionId + '，提示词已经投进去了。'
      + (wired.tool === true || wired.already === true
        ? '`puzzle_mode` 已装上，它可以真的把项目建出来。'
        : '⚠️ `puzzle_mode` **没装上**（' + String(wired.reason || '未知原因') + '），这个会话建不了项目。'),
  }
}

/** `runBuildSession` 的 requestId 兜底计数（见那里对幂等的说明）。 */
let buildSeq = 0

/**
 * **呼出全局大脑**（v2.2.0）：一个项目一个会话，已存在就复用。
 *
 * ## 为什么不是每次新起一个
 *
 * 用户拍板「一个项目一个，已存在就复用」。理由不只是省钱：
 * 大脑的全部价值在于**它记得住**——每次新起一个就等于每次从零开始，
 * 而「常驻」这个词本身要求同一个会话被反复回到。
 *
 * ## 复用前为什么要问一次 `resolveAgent`
 *
 * 会话 id 是从设置里读出来的，而它**可能已经不存在了**（用户删了会话、
 * 换了 profile、转录被清）。直接把它交给面板，症状是浮窗里
 * `sessions.retain: unknown session` —— 用户看到「点不开」而不知道原因。
 * 所以这里先问一句「它还有活跃 agent 吗」，没有就**另起一个并如实说明**。
 * 这是真实失败路径，不是假想兜底。
 *
 * ## 复用时不投首轮消息
 *
 * 首轮消息是「你现在是 X 项目的全局大脑」——它只在会话刚建出来时需要。
 * 复用时再投一遍，等于把同一段自我介绍反复塞进对话里。
 */
export async function runBrain(deps, input) {
  const dataRoot = typeof deps.dataWorkspace === 'string' ? deps.dataWorkspace.trim() : ''
  if (dataRoot === '') {
    return {
      ok: false,
      error: '还没绑数据工作区，大脑没有文档可读',
      hint: '先在一级页「数据工作区」绑定一个工作区：大脑读的就是 <工作区>/<项目名>/拼图/。',
    }
  }
  const project = typeof deps.project === 'string' ? deps.project.trim() : ''
  if (project === '') {
    return { ok: false, error: '没有打开的项目', hint: '先在项目列表里点进一个项目——大脑是**项目级**的。' }
  }

  const previous = typeof deps.brainSessionOf === 'function' ? deps.brainSessionOf(project) : ''
  if (typeof previous === 'string' && previous !== '') {
    const alive = await agentOfSession(deps, previous)
    if (alive.ok === true) {
      /**
       * ## 复用时**必须补装一次**（这里踩过的一个真坑）
       *
       * 「已存在就复用」只保证**会话**还在，不保证**这个进程里的注入**还在。
       * `systemPrompt` 的段与 `tools` 的注册都是**挂在 agent 作用域上的运行时对象**：
       * 它们随进程消失，而会话 id 是落在设置文件里的、会活过重启。
       *
       * 于是「重启 DSH → 点全局大脑」这条路若不补装，用户会得到一个
       * **没有人设、没有文档段、没有 `puzzle_brain` 工具**的空壳会话——
       * 而面板显示的是「已复用」，看起来一切正常。
       *
       * 补装靠 `brainInstalledIn` 那张进程内名单去重：同一个作用域上
       * 同名 section 注册第二次会**抛错**（`dsh-scope` 的 `NamedEntries.insert`），
       * 不是覆盖。所以只在「本进程还没给它装过」时装。
       */
      const installedNow = typeof deps.brainInstalledIn === 'function' && deps.brainInstalledIn(previous) === true
      let reinstalled = null
      if (!installedNow) reinstalled = installBrainInto(deps, previous, alive.agent)
      return {
        ok: true,
        result: {
          sessionId: previous,
          reused: true,
          project,
          reinstalled: reinstalled !== null,
          /**
           * ⚠️ **这里必须直接给「文档段进去没有」这个布尔**，不能让面板去解释 `brain` 那个词。
           *
           * 踩过的坑（v2.2.0 真机首报）：复用且本进程已装过时 `brain` 是 `'kept'`——
           * 那是个**成功**态（会话本身没动、注入还在），而面板当时按
           * `brain !== 'both'` 判，于是把 `'kept'` 当成「没完全注入」，
           * 而这条路的 `brainReason` 是空串 → 界面上显示「没完全注入（未知原因）」。
           *
           * 根因不是某个词写错，是**同一规则写在两处**：宿主一套状态词、
           * 客户端一套「什么算好」。所以现在宿主把结论（`brainDoc` 布尔）
           * 直接给出，客户端只显示、不再解释。
           */
          brainDoc: reinstalled === null ? true : reinstalled.installed.doc === true,
          brain: reinstalled === null ? 'kept' : (reinstalled.installed.ok === true ? 'both' : 'partial'),
          brainTool: reinstalled === null ? true : reinstalled.installed.tool === true,
          brainReason: reinstalled === null ? '' : (reinstalled.installed.ok === true ? String(reinstalled.installed.docReason || '') : String(reinstalled.installed.reason || '')),
        },
        hint: reinstalled === null
          ? '这个项目已经有一个全局大脑了（' + previous + '），没有再起一个。'
          : '这个项目已经有一个全局大脑了（' + previous + '），没有另起一个；'
            + '本进程此前还没给它装过人设与文档段，刚补装了一次（会话本身没动）。',
      }
    }
    /**
     * 旧会话已经不在：**如实说**，然后另起一个。
     * 不说的话用户会以为「还是原来那个」，而其实记忆已经重置。
     */
    if (typeof deps.forgetBrain === 'function') deps.forgetBrain(project)
  }

  const opened = await openSession(deps, { create: { cwd: dataRoot } })
  if (opened.ok !== true) return opened

  // 先落盘：会话已经真的存在了（与派单同一条理由，失败也不留孤儿）。
  if (typeof deps.rememberBrain === 'function') deps.rememberBrain(project, opened.sessionId)

  const wireInstaller = typeof deps.installSessionTools === 'function' ? deps.installSessionTools : null
  const wired = wireInstaller !== null
    ? wireInstaller(opened.agent)
    : { ok: false, section: false, tool: false, reason: '调用方没提供 installSessionTools' }

  const installed = installBrainInto(deps, opened.sessionId, opened.agent)

  const sent = await sendPrompt(
    deps,
    opened.sessionId,
    brainPromptOf({
      project,
      dataWorkspace: dataRoot,
      codeWorkspace: codeRootOf(deps.settings, project),
    }),
    'puzzle-brain-' + opened.sessionId,
  )
  if (sent.ok !== true) {
    return { ok: false, error: sent.error, hint: sent.hint, sessionId: opened.sessionId }
  }

  return {
    ok: true,
    result: {
      sessionId: opened.sessionId,
      reused: false,
      project,
      reinstalled: false,
      brainDoc: installed.installed.doc === true,
      brain: installed.installed.ok !== true ? 'failed' : (installed.installed.doc === true && installed.installed.tool === true ? 'both' : 'partial'),
      brainTool: installed.installed.tool === true,
      brainReason: installed.installed.ok === true ? String(installed.installed.docReason || '') : String(installed.installed.reason || ''),
      wired: wired.ok !== true ? 'failed' : (wired.section && wired.tool ? 'both' : 'partial'),
      wiredTool: wired.tool === true || wired.already === true,
      wiredReason: wired.ok === true ? '' : String(wired.reason || ''),
    },
    hint: '全局大脑已起：' + opened.sessionId + '。'
      + (installed.installed.ok === true
        ? '人设与「冻结文档段」都注入进它的系统提示了。'
        : '⚠️ 人设**没能注入**（' + String(installed.installed.reason || '未知原因') + '）。'),
  }
}

/**
 * 把大脑的人设 / 冻结文档段 / 专属工具装进一个 agent，并**登记进进程内名单**。
 *
 * 抽出来是因为**两条路都要用**：新建会话时装一次，复用一个「重启前建的」会话时
 * 再补装一次（见 `runBrain` 里那段）。两份各写一遍的必然结果是某一份忘了
 * 把 holder 与 lookup 接上，而那种缺陷不报错——只是大脑读不到文档。
 */
function installBrainInto(deps, sessionId, agent) {
  const source = typeof deps.clarifierSource === 'function' ? deps.clarifierSource() : {}
  const initial = brainDocText(
    typeof source.mainDoc === 'function' ? source.mainDoc() : source.mainDoc,
    typeof source.moduleIndex === 'function' ? source.moduleIndex() : source.moduleIndex,
  )
  const holder = brainDocHolder(initial, deps.clarifierSource)
  const brainInstaller = typeof deps.installBrain === 'function' ? deps.installBrain : null
  const installed = brainInstaller !== null
    ? brainInstaller(agent, {
      sessionId,
      holder,
      lookup: deps.clarifierSource,
      reports: deps.readBoard,
      liveGoalOf: deps.liveGoalOf,
    })
    : { ok: false, reason: '调用方没提供 installBrain' }
  if (installed.ok === true && typeof deps.noteBrainInstalled === 'function') deps.noteBrainInstalled(sessionId)
  return { installed, holder }
}

/**
 * 问一句「这个会话现在还有活跃 agent 吗」。
 *
 * 与 `openSession` 共用 `resolveAgent` 的信封约定（见那里那条 v2.1.6 的教训）。
 * 失败**不抛**：调用方要的是「能不能用」，不是「为什么不能用」。
 */
async function agentOfSession(deps, sessionId) {
  const controller = deps.sessionController
  if (controller === null || controller === undefined || typeof controller.resolveAgent !== 'function') {
    return { ok: false, reason: '这台部署没有 sessionController' }
  }
  try {
    const resolved = await controller.resolveAgent(sessionId)
    if (resolved !== null && resolved !== undefined && 'error' in resolved) return { ok: false, reason: '没有活跃 agent' }
    const agent = resolved === null || resolved === undefined ? undefined : resolved.agent
    if (agent === null || agent === undefined) return { ok: false, reason: 'agent 是空的' }
    return { ok: true, agent }
  } catch (error) {
    const raw = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
    return { ok: false, reason: raw }
  }
}

/**
 * **呼出澄清器**：把「未澄清」的卡接上一个固定的澄清器。
 *
 * ## v2.2.0：澄清器是**全局大脑分叉出来的子代理**
 *
 * 用户拍板：「澄清器就是全局大脑当前上下文的延伸，相当于一个继承上下文的子代理」。
 * 落地方式就是宿主的 `sessionController.fork({sessionId})`——它按**事件前缀**
 * 复制一份真会话（`buildForkSeed` 会把开着的 turn 收尾），于是澄清器
 * **开口就继承了大脑那段对话**，而不是拿一份快照重新自我介绍。
 *
 * ⚠️ **fork 继承的是事件日志，不是系统提示**：`systemPrompt` 的段是**每个 agent
 * 作用域**各自注册的，分叉出来的子会话会重新装配自己的提示。所以大脑的
 * 「冻结文档段」必须**再注入一次**（`docSection`）——不注入的话，澄清器就只剩
 * 对话历史、没有那份「这个项目已定什么」的文档，而它正是澄清的依据。
 *
 * ## 澄清器的上下文 = 大脑上下文 + 未澄清任务单 + 工作指引
 *
 * 三段各有落点，缺一不可：
 *   1. **大脑上下文**：fork 继承的对话 + 重新注入的文档段；
 *   2. **未澄清任务单**：首轮消息里的需求原文（`clarifierPromptOf`）；
 *   3. **工作指引**：`CLARIFIER_SYSTEM`，走子会话 systemPrompt 注入。
 *
 * ## 为什么没有大脑时仍然能用（`brainSessionOf` 缺席时走老路）
 *
 * 调用方没接大脑时（老调用方 / 测试假件），这里的行为与 v2.1.x **一字不差**：
 * 建一个新会话。这不是「防御性兜底」——**没有可继承的东西**时，分叉这个动作
 * 本身就没有对象，建新会话是唯一可能的语义。生产路径（`index.js`）永远接大脑。
 *
 * ## 已经在澄清中的卡**不重复起会话**
 *
 * 重复起会造出两个澄清会话、各自冻结出互相矛盾的方案，而用户只看到一张卡。
 * 所以 `clarifyVerdict` 返回 `reuse` 时直接复用，把已有会话 id 回给面板。
 */
export async function runClarify(deps, input) {
  const board = deps.readBoard()
  const cards = Array.isArray(board.cards) ? board.cards.slice() : []
  const at = cards.findIndex((item) => item.id === input.cardId)
  if (at < 0) return { ok: false, error: '找不到卡片 ' + String(input.cardId) }
  const card = cards[at]

  const verdict = clarifyVerdict(card)
  if (verdict.ok !== true) return { ok: false, error: verdict.error, hint: verdict.hint }
  if (verdict.reuse !== '') {
    return {
      ok: true,
      result: { card, sessionId: verdict.reuse, reused: true, board: deps.readBoard() },
      hint: '这张卡已经有一个澄清会话了（' + verdict.reuse + '），没有再起一个。',
    }
  }

  const dataRoot = typeof deps.dataWorkspace === 'string' ? deps.dataWorkspace.trim() : ''
  if (dataRoot === '') {
    return { ok: false, error: '还没绑数据工作区', hint: '澄清器要读拼图文档，得先告诉它文档在哪：面板一级页绑定一个工作区。' }
  }

  /**
   * 先确保有大脑，再从它分叉。
   *
   * 「先有大脑」这条不是可选的：用户要的是「澄清器继承大脑上下文」，
   * 没有大脑就没有可继承的上下文。大脑起不来时**如实失败**，而不是
   * 悄悄退回「一个没有上下文的澄清器」——那会让用户以为继承生效了。
   */
  const brainAware = typeof deps.brainSessionOf === 'function'
  let brainId = ''
  if (brainAware) {
    const brain = await runBrain(deps, {})
    if (brain.ok !== true) {
      return {
        ok: false,
        error: '起不了全局大脑，澄清器没有可继承的上下文：' + String(brain.error || ''),
        hint: brain.hint,
      }
    }
    brainId = String(brain.result.sessionId || '')
  }

  const opened = brainId !== ''
    ? await forkSession(deps, brainId)
    : await openSession(deps, { create: { cwd: dataRoot } })
  if (opened.ok !== true) return stampFailure(deps, cards, at, 'clarifySessionId', opened.sessionId, opened)

  // 先落 clarifySessionId——与派单同一条理由：会话已经真的存在了。
  const stamped = { ...card, clarifySessionId: opened.sessionId, updatedAt: Date.now() }
  cards[at] = stamped
  const firstWrite = deps.writeBoard(cards)
  if (firstWrite !== undefined && firstWrite !== null && firstWrite.ok === false) {
    return { ok: false, error: '会话已建好但看板写不进去：' + String(firstWrite.error), hint: '会话 ' + opened.sessionId + ' 已经存在。' }
  }

  /**
   * 澄清器**不挂 goal**：它是交互式的（一问一答），而 goal 的语义是
   * 「无人值守地自动续行」。给澄清器挂 goal 会让它在用户还没回答时
   * 自己往下推轮次——那正是用户说的「这个澄清器是固定的」的反面。
   */

  /**
   * **工作指引 + 文档段 + 专属工具走子会话作用域注入**（用户拍板的第一条）。
   *
   * ## 为什么不能只把它拼进首轮消息
   *
   * 拼进消息的话它就是**用户说的话**，模型可以把它当「用户转述的一份说明」，
   * 而系统提示是它**必须服从**的那一层。用户要的是「固定的全局大脑」，
   * 「固定」指的正是这一层不变。
   *
   * ## 注入失败为什么要降级而不是报错
   *
   * 会话**已经建出来了**。这时报错等于「失败 + 留一个孤儿会话」，
   * 是这一层最不想要的形状。降级到「并进首轮消息」纪律仍然到位，
   * 只是层级低一点——所以 `systemWired` 要如实回报是哪一条路，
   * 面板与用户都能看见差别，而不是含糊地说「成功了」。
   */
  const docSection = brainAware
    ? { name: BRAIN_DOC_SECTION.name, order: BRAIN_DOC_SECTION.order, text: currentDocText(deps) }
    : null
  const installer = typeof deps.installClarifier === 'function' ? deps.installClarifier : null
  const installed = installer !== null
    ? installer(opened.agent, { system: CLARIFIER_SYSTEM, lookup: deps.clarifierSource, docSection })
    : { ok: false, reason: '调用方没提供 installClarifier，纪律只能并进首轮消息' }
  const wiredBySection = installed !== null && installed.ok === true && installed.section === true

  /**
   * **澄清会话也要装上 `puzzle_mode`**（v2.1.1）。
   *
   * 澄清器的专属检索工具（`puzzle_context`）是它的**窄口子**——读拼图文档。
   * 但澄清做完要把结论**写回文档**（那是拼图模式的核心动作），而写回只能走
   * `puzzle_mode`。v2.1.1 起根作用域不再注册它，所以这里必须装。
   *
   * 装的结果单独回报（`wired` 字段）：与上面那条纪律走的是两件事，
   * 一个失败不该让另一个看起来也失败了。
   */
  const wireInstaller = typeof deps.installSessionTools === 'function' ? deps.installSessionTools : null
  const wired = wireInstaller !== null
    ? wireInstaller(opened.agent)
    : { ok: false, section: false, tool: false, reason: '调用方没提供 installSessionTools' }

  /**
   * **写任务单的专属工具**（v2.2.0，用户拍板「他有单独的工具用于写任务单」）。
   *
   * 它只能改**这一张**卡的四个字段，落盘走与面板同一个 `writeBoard`。
   * 装不上只降这一半：澄清器仍能把方案写在对话里，用户手填。
   */
  const taskWriter = typeof deps.installTaskWriter === 'function' ? deps.installTaskWriter : null
  const writer = taskWriter !== null
    ? taskWriter(opened.agent, { cardId: String(card.id) })
    : { ok: false, tool: false, reason: '调用方没提供 installTaskWriter' }

  const body = clarifierPromptOf({
    request: card.sourceRequest !== '' ? card.sourceRequest : card.plan !== null && card.plan !== undefined ? card.plan.description : '',
    project: deps.project,
    dataWorkspace: dataRoot,
    codeWorkspace: codeRootOf(deps.settings, deps.project),
    moduleIndex: deps.moduleIndex,
    mainDoc: deps.mainDoc,
    /**
     * ⚠️ v2.2.0：主文档**不再内联**到首轮消息里（`brainAware` 那条路）。
     *
     * 它已经走文档段进了系统提示（与大脑用的是同一份文本）。再内联一份就是
     * 同一份内容付两次费，而且两份会漂移。老路径（没有大脑）仍然内联——
     * 那时系统提示里没有文档段，内联是它唯一的来源。
     */
    inlineMainDoc: !brainAware,
    taskTitle: card.title,
    hasWriter: writer.tool === true,
  })
  // 降级路径：指引并进首轮消息，至少不是「指引根本没到」。
  const text = wiredBySection ? body : CLARIFIER_SYSTEM + '\n\n---\n\n' + body
  const prompt = await sendPrompt(deps, opened.sessionId, text, 'puzzle-clarify-' + String(card.id))
  if (prompt.ok !== true) {
    return { ok: false, error: prompt.error, hint: prompt.hint, sessionId: opened.sessionId }
  }
  const note = wiredBySection
    ? '工作指引已注入该会话的系统提示，专属检索工具' + String(installed.toolName || '') + (installed.tool === true ? '已装上' : '没装上（' + String(installed.reason || '') + '）') + '。'
    : '⚠️ 工作指引**没能注入系统提示**（' + String(installed.reason || '未知原因') + '），已降级为并进首轮消息。'
  return {
    ok: true,
    result: {
      card: stamped,
      sessionId: opened.sessionId,
      reused: false,
      maxRounds: CLARIFIER_MAX_ROUNDS,
      /**
       * `inherited` 如实回报「它到底有没有继承大脑」：`fork` 成功才有，
       * 老路径（没有大脑）是 `false`。不回报的话用户没法分辨
       * 「澄清器记不住上下文」是设计如此还是接线断了。
       */
      inherited: brainId !== '' && opened.forked === true,
      brainSessionId: brainId,
      // 如实回报走了哪条路——含糊的「成功」会让「固定」这个承诺变成空话。
      systemWired: wiredBySection ? 'section' : 'message',
      systemReason: wiredBySection ? '' : String(installed.reason || ''),
      clarifierTool: installed !== null && installed.tool === true ? String(installed.toolName || '') : '',
      taskTool: writer.tool === true ? String(writer.toolName || '') : '',
      taskToolReason: writer.tool === true ? '' : String(writer.reason || ''),
      wired: wired.ok !== true ? 'failed' : (wired.section && wired.tool ? 'both' : 'partial'),
      wiredTool: wired.tool === true || wired.already === true,
      wiredReason: wired.ok === true ? '' : String(wired.reason || ''),
      board: deps.readBoard(),
    },
    hint: '澄清会话已起：' + opened.sessionId + '。' + note
      + (brainId !== '' && opened.forked === true
        ? '它是从全局大脑（' + brainId + '）分叉出来的，继承了那份上下文。'
        : '⚠️ 它**没有**从全局大脑分叉——上下文是新建的。')
      + (writer.tool === true
        ? '写任务单的工具 ' + String(writer.toolName || '') + ' 已装上：它会把标题 / 目标 / 描述 / 具体执行提示词直接写回这张卡。'
        : '⚠️ 写任务单的工具**没装上**（' + String(writer.reason || '未知原因') + '），它只能把方案写在对话里。')
      + (wired.tool === true || wired.already === true
        ? 'puzzle_mode 已装上，澄清完可以直接写回文档。'
        : '⚠️ puzzle_mode **没装上**（' + String(wired.reason || '未知原因') + '），这一轮澄清完写不回文档。'),
  }
}
