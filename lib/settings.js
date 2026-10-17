/**
 * 全局设置：拼图模式**唯一的持久化状态文件**（`$DSH_HOME/.dsh-puzzle-mode.json`）。
 *
 * 插件是**全局的工作台**（面板不绑会话、项目独立存在），所以「属于谁、放在哪、打开着哪个」
 * 这些事实**没有会话可依**，只能落到插件自己的全局文件里。文件里七组字段，
 * **互不相干、必须互不覆盖**：
 *
 * | 字段 | 管什么 | 作用域 |
 * |---|---|---|
 * | `disabledSessions` | 哪些会话不要拼图模式 | 按会话（记 ID 名单） |
 * | `wiredSessions` | 哪些会话被装过插件 | 按会话（记 ID 名单） |
 * | `askPause` | 固定收尾问要不要问 | 全局 |
 * | `workspaceId` / `workspacePath` | **数据工作区**：拼图文档与任务单住在哪 | 全局 |
 * | `openProject` | 面板**当前打开的项目** | 全局 |
 * | `codeWorkspace` | **代码工作区**：派单出去的 AI 在哪个目录改代码 | 全局 + 单项目覆盖 |
 * | `dispatchModels` | 派单系统四处模型（分解 / 大脑 / 澄清器 / 执行） | 全局 |
 *
 * ⚠️ **写入纪律**：这个文件是共享的，任何一处写入都必须**带上它没碰的字段**
 * （早先 `setAskPause` 只写 `{askPause}`，把禁用名单整个抹掉过）。所以本文件
 * **只有一条写路径** `patchSettings()`：读全 → 合并补丁 → 整份写回。
 *
 * ## 读侧纪律
 *
 * `readSettings()` **从不抛错**：文件缺失、读不出来、JSON 坏掉一律当作「什么都没配」。
 * 宁可退回默认，也不要因为一个坏文件让整个插件用不了。它走**每一次工具调用**与
 * **每一个 step**，所以按 `mtimeMs + size` 指纹缓存解析结果。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { atomicWrite, readTextCached } from './docfs.js'
import { logFailure } from './plog.js'

/** 设置文件名（放在 DSH_HOME 根下）。 */
export const SETTINGS_FILE = '.dsh-puzzle-mode.json'

/** 禁用名单上限：防长期使用把它撑成无限大。超了丢最旧的。 */
export const MAX_DISABLED_SESSIONS = 200

/**
 * 「已装插件的会话」名单上限（v2.1.1）。
 *
 * v2.1.1 起插件**默认不往任何会话注入**：`puzzle_mode` 工具与那段拼图规则
 * 只在**插件自己起的派单子会话**（澄清器 / 执行会话）里注册。这个名单记的就是
 * 「哪些会话被装过」，用途有两个：
 *   ① 面板一级页回答「插件现在影响到哪几个会话」；
 *   ② 注入类钩子（首轮判定 / 熔断 / 催促 / 说话纠正 / 文件观察守卫）
 *      只对名单里的会话生效——**普通会话一个钩子都不进**。
 *
 * 名字取 `wired`（接线）而不是 `injected`：它描述的是「这个会话被接上了本插件」，
 * 而不只是「某一次注入了什么」。
 */
export const MAX_WIRED_SESSIONS = 200

/**
 * 固定收尾问的**默认值：开**。
 *
 * 语义是「默认行为」而不是「新特性」——它一直是开着的，用户要的只是**一条关掉它的路**。
 * 所以缺字段、坏值、读不出来一律按「开」处理：**默认保持原有行为**，
 * 只有用户显式关过才变。反过来的默认（缺字段=关）会让所有老用户的提问突然不再收尾，
 * 那是静默的行为变更。
 */
export const ASK_PAUSE_DEFAULT = true

/**
 * 代码工作区的两档作用域。
 *
 * - `global`（默认）：一个根给**所有项目**共用，每个拼图项目的代码落在
 *   该根下的**同名子目录**里（`<globalPath>/<项目名>`，C1 自动推导）；
 * - `perProject`：允许 `perProject[项目名]` **单独覆盖**全局推导。
 *
 * ⚠️ 注意这不是「两选一」：`perProject` 是**覆盖表**，`global` 是**默认推导源**。
 * 解析顺序 `perProject[项目名] → globalPath/项目名 → 未配置`。
 */
export const CODE_WORKSPACE_MODES = ['global', 'perProject']

/** 代码工作区默认档：全局。用户不配也能用，且多数情况下代码本来就在一个仓库根下。 */
export const DEFAULT_CODE_WORKSPACE_MODE = 'global'

/**
 * 派单系统里**四处会用到模型**的地方。
 *
 * 每处的选择**可缺省**：缺省 = 跟随全局默认模型（`agentDefaultModel.currentSelection()`）。
 * ⚠️ **缺省时不要在写卡时把当时的默认值写死进去**——那会让「我换了默认模型，
 * 派单却还用旧的」变成一个查不出来的怪现象。
 *
 * ## `brain` 为什么单独一个槽（v2.2.0）
 *
 * 全局大脑是**常驻**的：它一个项目一个会话、会被反复追问、每次都要带着
 * 整个项目的文档。它与澄清器（一次性、只问一张卡）的负载完全不同，
 * 用户很可能想给大脑配一个更强的模型。共用一个槽就把这个选择拿掉了。
 */
export const DISPATCH_MODEL_SLOTS = ['decompose', 'brain', 'clarifier', 'executor']

/** 设置目录：优先 `$DSH_HOME`，拿不到就退回 `~/.dsh`（与插件管理器的口径一致）。 */
export function settingsDir() {
  const home = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return home !== '' ? home : join(homedir(), '.dsh')
}

export function settingsPath() {
  return join(settingsDir(), SETTINGS_FILE)
}

/** 认一个「provider/model」选择对象；坏形状一律当「没选」（= 跟随全局默认）。 */
function normalizeSelection(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (provider === '' || model === '') return null
  const out = { provider, model }
  const effort = typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.trim() : ''
  if (effort !== '') out.reasoningEffort = effort
  return out
}

/**
 * 一份**完整**设置的形状（含默认值）。
 *
 * 为什么要收成一个函数：读设置的地方有三处（提示段、工具返回、面板），
 * 每处各自拼默认值就会漂移——`askPause` 这种「缺字段=开」的语义最容易在某一处写成「缺=关」。
 * 写侧也复用它：`patchSettings` 先归一、再合并，保证**写回去的永远是完整形状**。
 */
function normalizeSettings(raw) {
  const out = {
    disabledSessions: [],
    /**
     * 已装插件的会话名单（v2.1.1）。
     *
     * ## 为什么与 `disabledSessions` 是**两件事**，不能合并
     *
     * `disabledSessions` 是 opt-out：默认所有会话都带拼图模式，用户手动关掉某几个。
     * `wiredSessions` 是 opt-in：**默认一个都不带**，只有插件自己起派单子会话时
     * 才加进去。两者的默认值相反，合并成一个名单必然把其中一个的语义写反。
     *
     * 而且它们回答的问题也不同：前者是「用户不想让哪个会话带拼图规则」，
     * 后者是「插件实际影响了哪几个会话」——后者是**事实记录**，由插件写，不由用户写。
     */
    wiredSessions: [],
    askPause: ASK_PAUSE_DEFAULT,
    // 数据工作区：两个都存。`workspaceId` 用于精确寻址，`workspacePath` 用于
    // 工作区被删 / 重注册后仍能显示与兜底（路径是用户能看懂的，id 不是）。
    workspaceId: '',
    workspacePath: '',
    // 面板当前打开的项目名（一级列表点进去的那一个）。落盘后刷新 / 重启都停在原地。
    openProject: '',
    codeWorkspace: { mode: DEFAULT_CODE_WORKSPACE_MODE, globalPath: '', perProject: {} },
    dispatchModels: { decompose: null, brain: null, clarifier: null, executor: null },
    /**
     * **全局大脑的会话登记**（v2.2.0）：`项目名 → 会话 id`。
     *
     * 为什么落在**全局设置**而不是项目文档里：它是「这台机器上，这个项目的大脑
     * 是哪个会话」——会话属于本机、本 profile，而项目文档可能被复制到别的机器。
     * 写进文档会让「换台机器打开同一个项目」时指向一个不存在的会话。
     *
     * 与 `dispatchModels` 同一条纪律：**用户不写、由插件写**。
     */
    brainSessions: {},
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out

  if (Array.isArray(raw.disabledSessions)) {
    // 去重 + 只留非空字符串：坏数据不要带进内存。
    const seen = new Set()
    for (const item of raw.disabledSessions) {
      if (typeof item !== 'string' || item === '' || seen.has(item)) continue
      seen.add(item)
      out.disabledSessions.push(item)
    }
  }
  // 只有**显式的布尔**才算数：`"false"` / `0` / `null` 一律当没写（按默认「开」）。
  if (typeof raw.askPause === 'boolean') out.askPause = raw.askPause
  if (Array.isArray(raw.wiredSessions)) {
    // 与 `disabledSessions` 同一条纪律：去重 + 只留非空字符串。
    const seenWired = new Set()
    for (const item of raw.wiredSessions) {
      if (typeof item !== 'string' || item === '' || seenWired.has(item)) continue
      seenWired.add(item)
      out.wiredSessions.push(item)
    }
  }
  if (typeof raw.workspaceId === 'string') out.workspaceId = raw.workspaceId.trim()
  if (typeof raw.workspacePath === 'string') out.workspacePath = raw.workspacePath.trim()
  if (typeof raw.openProject === 'string') out.openProject = raw.openProject.trim()

  const code = raw.codeWorkspace
  if (code !== null && typeof code === 'object' && !Array.isArray(code)) {
    // 认不出的档位回落到 `global`——它是默认，也是「不配也能用」的那一档。
    if (typeof code.mode === 'string' && CODE_WORKSPACE_MODES.includes(code.mode.trim())) {
      out.codeWorkspace.mode = code.mode.trim()
    }
    if (typeof code.globalPath === 'string') out.codeWorkspace.globalPath = code.globalPath.trim()
    if (code.perProject !== null && typeof code.perProject === 'object' && !Array.isArray(code.perProject)) {
      for (const [key, value] of Object.entries(code.perProject)) {
        const name = typeof key === 'string' ? key.trim() : ''
        const path = typeof value === 'string' ? value.trim() : ''
        if (name === '' || path === '') continue
        out.codeWorkspace.perProject[name] = path
      }
    }
  }

  const models = raw.dispatchModels
  if (models !== null && typeof models === 'object' && !Array.isArray(models)) {
    for (const slot of DISPATCH_MODEL_SLOTS) {
      out.dispatchModels[slot] = normalizeSelection(models[slot])
    }
  }

  const brains = raw.brainSessions
  if (brains !== null && typeof brains === 'object' && !Array.isArray(brains)) {
    for (const [key, value] of Object.entries(brains)) {
      const name = typeof key === 'string' ? key.trim() : ''
      const id = typeof value === 'string' ? value.trim() : ''
      if (name === '' || id === '') continue
      out.brainSessions[name] = id
    }
  }
  return out
}

let settingsCache = null

export function readSettings() {
  const file = settingsPath()
  let stat = null
  try {
    stat = statSync(file)
  } catch (_error) {
    // 文件不存在 / 读不到：按「什么都没配」处理，并清掉可能过期的缓存。
    settingsCache = null
    return normalizeSettings(null)
  }
  const fingerprint = `${stat.mtimeMs}:${stat.size}`
  if (settingsCache !== null && settingsCache.file === file && settingsCache.fingerprint === fingerprint) {
    return settingsCache.value
  }
  const text = readTextCached(file)
  if (text === null) {
    settingsCache = null
    return normalizeSettings(null)
  }
  let value = normalizeSettings(null)
  try {
    value = normalizeSettings(JSON.parse(text))
  } catch (error) {
    // 坏设置文件 → 全部退回默认。后果是「用户配过的代码工作区 / 模型选择
    // 全都变回默认」，而界面上看不出为什么——必须留痕。
    logFailure('设置:读取', '设置文件 JSON 坏了，按默认处理', error, { file, bytes: text.length })
    value = normalizeSettings(null)
  }
  settingsCache = { file, fingerprint, value }
  return value
}

/**
 * **唯一的写路径**：读全 → 合并补丁 → 整份写回。
 *
 * `patch` 支持顶层字段与两个嵌套对象（`codeWorkspace` / `dispatchModels`）的**浅合并**，
 * 嵌套里传 `null` 表示「清掉这一项」（例如把某个模型选择恢复成「跟随全局默认」）。
 *
 * 为什么不给每个字段各写一个 setter 各自拼对象：那正是本文件头说的老坑
 * （一个开关的写路径漏带另一个字段 → 把它整个抹掉）。这里只有一个出口，
 * 「漏带」在结构上就不可能发生。
 */
export function patchSettings(patch) {
  const prev = readSettings()
  const next = normalizeSettings(prev)
  if (patch !== null && typeof patch === 'object') {
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'codeWorkspace' && value !== null && typeof value === 'object') {
        next.codeWorkspace = normalizeSettings({ ...prev, codeWorkspace: { ...prev.codeWorkspace, ...value } }).codeWorkspace
        continue
      }
      if (key === 'dispatchModels' && value !== null && typeof value === 'object') {
        const merged = { ...prev.dispatchModels }
        for (const [slot, selection] of Object.entries(value)) {
          if (!DISPATCH_MODEL_SLOTS.includes(slot)) continue
          merged[slot] = selection === null ? null : (normalizeSelection(selection) ?? merged[slot])
        }
        next.dispatchModels = normalizeSettings({ dispatchModels: merged }).dispatchModels
        continue
      }
      if (!Object.hasOwn(next, key)) continue
      if (value === undefined) continue
      next[key] = value
    }
  }
  const full = normalizeSettings(next)
  atomicWrite(settingsPath(), JSON.stringify(full, null, 2) + '\n')
  // 写完立刻失效：`atomicWrite` 的 rename 在同一毫秒内可能让指纹看起来没变，
  // 而同进程紧接着读必须看到新值（用户点开关 → 下一轮立即生效，这条不能破）。
  settingsCache = null
  return full
}

/**
 * 这个会话是否被禁用。
 *
 * 判定只认**会话 ID**——拿不到 ID 时返回 `false`（不禁用）：这是个 opt-in 的开关，
 * 判定不了就别拦；漏拦一个会话，比误伤一个正在干活的会话代价小得多。
 */
export function isSessionDisabled(sessionId, settings = readSettings()) {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  const list = settings === null || settings === undefined ? null : settings.disabledSessions
  if (!Array.isArray(list)) return false
  return list.includes(sessionId)
}

/**
 * 固定收尾问当前是否要问（**全局**，与项目、会话都无关）。
 *
 * 为什么不按会话：用户要的是「别每次都问」——同一台机器上逐个会话去关，
 * 等于把一件事做成 N 件事。它记在 DSH_HOME 下，跨 profile、跨项目、跨会话一致。
 */
export function isAskPauseEnabled(settings = readSettings()) {
  if (settings === null || settings === undefined) return ASK_PAUSE_DEFAULT
  return settings.askPause !== false
}

/** 开关固定收尾问。返回改后状态与「是否真的变了」。 */
export function setAskPause(enabled) {
  const value = enabled !== false
  const prev = readSettings()
  const changed = prev.askPause !== value
  patchSettings({ askPause: value })
  return { ok: true, askPause: value, changed }
}

/** 禁用**这一个**会话。重复调用是幂等的。 */
export function disableSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, error: '缺少会话 ID，无法禁用' }
  }
  const prev = readSettings()
  if (prev.disabledSessions.includes(sessionId)) {
    return { ok: true, sessionId, alreadyDisabled: true, disabledSessions: prev.disabledSessions }
  }
  // 满了就丢最旧的那个（数组头部），保证名单有界。
  const next = [...prev.disabledSessions, sessionId]
  while (next.length > MAX_DISABLED_SESSIONS) next.shift()
  patchSettings({ disabledSessions: next })
  return { ok: true, sessionId, alreadyDisabled: false, disabledSessions: next }
}

/** 恢复**这一个**会话。其余会话的禁用状态不受影响。 */
export function enableSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, error: '缺少会话 ID，无法恢复' }
  }
  const prev = readSettings()
  if (!prev.disabledSessions.includes(sessionId)) {
    return { ok: true, sessionId, wasDisabled: false, disabledSessions: prev.disabledSessions }
  }
  const next = prev.disabledSessions.filter((id) => id !== sessionId)
  patchSettings({ disabledSessions: next })
  return { ok: true, sessionId, wasDisabled: true, disabledSessions: next }
}

/* ------------------------------ 已装会话名单（v2.1.1） ------------------------------ */

/**
 * 这个会话**被装上了本插件**吗。
 *
 * ## 这是 v2.1.1 的那道总闸
 *
 * 用户原话：「把插件与普通会话的关系全部切断，普通会话不要有插件的工具、
 * 不要受插件影响」。落地方式就是这一个判断：
 *
 *   - 根作用域**不再**注册 `puzzle_mode`、**不再**注入 policy 段；
 *   - 五个注入类钩子（首轮判定 / 熔断 / 催促 / 说话纠正 /
 *     文件观察守卫）**第一行**都问这个函数，名单外的会话直接放行——
 *     等于钩子对普通会话完全不存在；
 *   - 名单里只有插件自己起的**派单子会话**（澄清器 / 执行会话），
 *     由 `markWired(id)` 在装工具时写进去。
 *
 * ⚠️ 拿不到 sessionId 时返回 **false**（不装）：这是 opt-in 的开关，
 * 判定不了就别装。与 `isSessionDisabled` 的兜底方向**正好相反**，
 * 因为两者的默认值相反——那条是 opt-out，这条是 opt-in。
 */
export function isSessionWired(sessionId, settings = readSettings()) {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  const list = settings === null || settings === undefined ? null : settings.wiredSessions
  if (!Array.isArray(list)) return false
  return list.includes(sessionId)
}

/** 把一个会话记进「已装插件」名单。幂等；满了丢最旧的。 */
export function markWired(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, error: '缺少会话 ID，无法登记' }
  }
  const prev = readSettings()
  if (prev.wiredSessions.includes(sessionId)) {
    return { ok: true, sessionId, alreadyWired: true, wiredSessions: prev.wiredSessions }
  }
  const next = [...prev.wiredSessions, sessionId]
  while (next.length > MAX_WIRED_SESSIONS) next.shift()
  patchSettings({ wiredSessions: next })
  return { ok: true, sessionId, alreadyWired: false, wiredSessions: next }
}

/* ------------------------------ 数据工作区 ------------------------------ */

/**
 * 绑定 / 解绑**数据工作区**（拼图文档与任务单住哪）。
 *
 * 为什么绑的是「工作区」而不是裸路径：宿主的工作区有 `workspaceId`，
 * 它是**精确寻址**用的（同名路径可以注册成两个工作区、路径会被改名）；
 * 而 `workspacePath` 是给人看的、也是工作区被删 / 重注册之后的兜底。
 * 两个都存，缺一个都会在某个场景下说不清「我现在在看哪个根」。
 *
 * 传空串 = 解绑（回到「还没绑定工作区」的空态）。
 */
export function setWorkspaceBinding(workspaceId, workspacePath) {
  const id = typeof workspaceId === 'string' ? workspaceId.trim() : ''
  const path = typeof workspacePath === 'string' ? workspacePath.trim() : ''
  const prev = readSettings()
  const changed = prev.workspaceId !== id || prev.workspacePath !== path
  // 换工作区时**顺手清掉 openProject**：那是上一个根下的项目名，
  // 留着会让面板打开一个在新根下根本不存在的项目（表现为「进去一片空白」）。
  patchSettings({ workspaceId: id, workspacePath: path, openProject: changed ? '' : prev.openProject })
  return { ok: true, workspaceId: id, workspacePath: path, changed }
}

/**
 * 解析**当前数据工作区根**。没有绑定就是空串。
 *
 * ⚠️ **绝不退回 `process.cwd()`**：那会把文档悄悄写到进程目录（可能是 `/` 或用户家目录），
 * 而且用户完全看不出来。未绑定就是未绑定——面板显示「绑定一个工作区」的空态，
 * 工具返回 `projectRoot: ''` 并提示去绑。这是「写错地方」与「明确说没配」之间的取舍，
 * 选后者。
 */
export function dataWorkspaceRoot(settings = readSettings()) {
  if (settings === null || settings === undefined) return ''
  const path = typeof settings.workspacePath === 'string' ? settings.workspacePath.trim() : ''
  return path
}

/** 面板当前打开的项目名；空串 = 停在项目列表首页。 */
export function openProjectOf(settings = readSettings()) {
  if (settings === null || settings === undefined) return ''
  return typeof settings.openProject === 'string' ? settings.openProject.trim() : ''
}

/** 切换面板当前打开的项目（传空串 = 回到项目列表）。 */
export function setOpenProject(projectName) {
  const name = typeof projectName === 'string' ? projectName.trim() : ''
  const prev = readSettings()
  const changed = prev.openProject !== name
  patchSettings({ openProject: name })
  return { ok: true, openProject: name, changed }
}

/* ------------------------------ 代码工作区 ------------------------------ */

/**
 * 写代码工作区配置（`mode` / `globalPath` / `perProject` 的浅合并）。
 *
 * `perProject` 里某个项目名传 `null` = **删掉那条覆盖**（回到全局推导）。
 * 这条必须支持，否则「单项目绑错了想改回全局」就无路可走。
 */
export function setCodeWorkspace(patch) {
  const prev = readSettings()
  const next = { ...prev.codeWorkspace }
  if (patch !== null && typeof patch === 'object') {
    if (typeof patch.mode === 'string' && CODE_WORKSPACE_MODES.includes(patch.mode.trim())) {
      next.mode = patch.mode.trim()
    }
    if (typeof patch.globalPath === 'string') next.globalPath = patch.globalPath.trim()
    if (patch.perProject !== null && typeof patch.perProject === 'object' && !Array.isArray(patch.perProject)) {
      const table = { ...next.perProject }
      for (const [key, value] of Object.entries(patch.perProject)) {
        const name = typeof key === 'string' ? key.trim() : ''
        if (name === '') continue
        if (value === null) {
          delete table[name]
          continue
        }
        const path = typeof value === 'string' ? value.trim() : ''
        if (path === '') continue
        table[name] = path
      }
      next.perProject = table
    }
  }
  patchSettings({ codeWorkspace: next })
  return { ok: true, codeWorkspace: readSettings().codeWorkspace }
}

/* ------------------------------ 派单模型 ------------------------------ */

/**
 * 写某一处（或几处）派单模型选择。传 `null` = 恢复成「跟随全局默认模型」。
 *
 * 返回**改后的全部槽位完整状态**，面板据此重画选择器——只回被改的那一处，
 * 面板就得自己拼其余几处，那是「两处各存一份状态」的开始。
 */
export function setDispatchModel(slot, selection) {
  if (!DISPATCH_MODEL_SLOTS.includes(slot)) {
    return { ok: false, error: `未知的模型槽位 ${String(slot)}`, hint: `可用：${DISPATCH_MODEL_SLOTS.join(' / ')}` }
  }
  patchSettings({ dispatchModels: { [slot]: selection === null ? null : selection } })
  return { ok: true, dispatchModels: readSettings().dispatchModels }
}

/* --------------------------- 全局大脑的会话 --------------------------- */

/** 这个项目的全局大脑是哪个会话（没登记过就是空串）。 */
export function brainSessionOf(project, settings = readSettings()) {
  const name = typeof project === 'string' ? project.trim() : ''
  if (name === '') return ''
  const table = settings !== null && settings !== undefined && settings.brainSessions !== null && settings.brainSessions !== undefined
    ? settings.brainSessions
    : {}
  const id = table[name]
  return typeof id === 'string' ? id : ''
}

/**
 * 记下「这个项目的大脑是哪个会话」。
 *
 * 为什么走 `patchSettings` 而不是自己写文件：本文件只有一个写出口，
 * 那个出口保证「写回去的永远是完整形状」——自己写一份就会漏掉别的字段
 * （本文件头记过这个坑）。
 */
export function setBrainSession(project, sessionId) {
  const name = typeof project === 'string' ? project.trim() : ''
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (name === '' || id === '') return { ok: false, error: '项目和会话 id 都不能为空' }
  const next = { ...readSettings().brainSessions, [name]: id }
  patchSettings({ brainSessions: next })
  return { ok: true, brainSessions: readSettings().brainSessions }
}

/** 忘掉这个项目的大脑登记（会话已经不在了 / 用户要重置）。 */
export function forgetBrainSession(project) {
  const name = typeof project === 'string' ? project.trim() : ''
  if (name === '') return { ok: false, error: '项目名不能为空' }
  const next = { ...readSettings().brainSessions }
  delete next[name]
  patchSettings({ brainSessions: next })
  return { ok: true, brainSessions: readSettings().brainSessions }
}
