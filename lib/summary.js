/**
 * 给工具面与 UI 面的精简摘要。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */
import { PUZZLE_DIR, EXECUTABLE_MODES, PAUSE_QUESTION, PAUSE_OPTIONS, PUZZLE_VERSION, PANEL_LIMITS, DEFAULT_SIZE, limitsFor } from './constants.js'
import { isAskPauseEnabled } from './settings.js'
import { HEALTH_DIMENSIONS } from './health.js'
import { hasFired, FIRST_RUN_CONDITIONS } from './firstrun.js'


/* --------------------------------- 汇总输出 --------------------------------- */

/**
 * 每次返回都带上的固定收尾问（三处口径一致：提示段 / 工具返回 / UI 模板）。
 *
 * **全局关闭后这里回 `askPause:false` 且不再带 `pauseQuestion` / `pauseOptions`**：
 * 留着那两个字段比不带更糟——模型看到「收尾问文案在这里」就会继续问，
 * 于是「关掉了」变成一句空话。字段在不在，本身就是给模型的信号。
 *
 * 判定读的是**全局设置**（`$DSH_HOME` 下的 `askPause`），与项目、会话都无关。
 */
export function pauseFields() {
  if (!isAskPauseEnabled()) return { askPause: false }
  return { askPause: true, pauseQuestion: PAUSE_QUESTION, pauseOptions: PAUSE_OPTIONS }
}

/**
 * 首轮自动判定的状态（诊断用，随每次返回给出）。
 *
 * 为什么要把「注入了没」显式回报：注入是一条**看不见的上下文**——
 * 不回报的话，模型与用户都不知道「采访流程是被自动触发的」还是「模型自己决定问的」，
 * 出了问题（比如该触发没触发）也无从排查。
 */
export function firstRunState(extra = {}) {
  const sessionId = typeof extra.sessionId === 'string' ? extra.sessionId : ''
  return {
    fired: sessionId === '' ? false : hasFired(sessionId),
    // 触发条件从 firstrun.js 的**唯一文案来源**取，不在这里重写一份——
    // 判据改过一次而这份 note 没跟上，面板显示的规则就与真实判据矛盾了。
    note: '本会话是否已触发「新会话直接发需求 → 采访后再建」的首轮注入。'
      + `触发条件是：${FIRST_RUN_CONDITIONS}。`,
  }
}

/** 五维的元信息（名字 + 方向），让模型知道每一维是什么、往哪边算好。 */


/** 五维的元信息（名字 + 方向），让模型知道每一维是什么、往哪边算好。 */
export function dimensionMeta() {
  return HEALTH_DIMENSIONS.map((dimension) => ({ key: dimension.key, name: dimension.name, hint: dimension.hint }))
}

/**
 * **写操作回执**：确认「改了什么」，而不是回吐「现在全部是什么」。
 *
 * 为什么需要它（实测数字）：原先每个写操作（main / module / health / workflow /
 * mode / source / settings / bind / unbind）都 `return summarize(readState(...))`，
 * 也就是**把整份项目状态再序列化一遍**。10 个模块的项目里那是 **7026 字符**，
 * 其中 `modules` 一项就占 4936（70%）——而写操作真正需要的确认信息不到 200 字符。
 * 一次「写一条要点」花掉 7KB，**浪费 35 倍**；写 8 次就是 56KB 纯噪音。
 *
 * 这条缺陷是**通用的**，不是某个字段写错：返回体积 ∝ **项目规模**，
 * 而不是 ∝ **本次改变了什么**。项目越大，每次写操作越贵——
 * 偏偏拼图模式的项目就是靠模块数增长的，等于「越用越贵」。
 *
 * 回执里保留的：本次改了什么（section / name / entries / dropped）+ 全局几个数
 * （健康性、各模块**只留名字与分数**、五节条数、工作流）。
 * 要看模块的五维明细，那是 `op:read` 的事，不该由写操作顺带捎上。
 */
export function receipt(state, extra = {}) {
  const modules = Array.isArray(state.modules) ? state.modules : []
  return {
    ok: true,
    initialized: state.initialized === true,
    project: state.project ?? '',
    // 只留「名字 + 健康性」：用来确认改动有没有反映到总分上，10 个模块约 300 字符。
    modules: modules.map((module) => ({ name: module.name, health: module.health })),
    moduleCount: modules.length,
    health: state.health,
    sections: state.sections ?? {},
    /**
     * 工作流**照旧每轮都给**：它是每个项目自己的规则（提示段只讲通用规则），
     * 模型看不到就等于这条功能不存在。它不是「项目规模的函数」，所以不裁。
     */
    workflow: Array.isArray(state.workflow) ? state.workflow : [],
    workflowArchiveCount: Array.isArray(state.workflowArchive) ? state.workflowArchive.length : 0,
    updated: state.updated ?? null,
    // 诊断字段与收尾问照旧（口径与 summarize 一致，别让两条路各说各话）。
    firstRun: firstRunState(extra),
    ...pauseFields(),
    ...extra,
  }
}

/**
 * 工具返回给模型的最小事实集（不序列化任何宿主对象）。
 *
 * `brief: true` 是**接续会话用的精简档**：去掉每模块的五维明细与来源、去掉五维元信息表，
 * 只留「有哪些模块、各自健康性、健康性总分、下一步该读什么」。
 * 本项目实测：全量 2916 字符 → 精简档约 1000 字符（模块明细占原本的 67%）。
 * 要明细再 `op:show` 看单个模块，不必一次把六个模块的分数全塞进上下文。
 */
export function summarize(state, extra = {}, brief = false) {
  if (state.initialized !== true) {
    return {
      ok: true,
      initialized: false,
      projectRoot: state.projectRoot,
      error: state.error ?? null,
      // `project` 即使为空也要给：面板靠它区分「未绑定」与「绑定的项目名叫空」。
      project: state.project ?? '',
      hint: `本会话还没绑定拼图项目：用 op=init 并显式给 project 一次创建（目录 ${'<工作区>/<项目名>/' + PUZZLE_DIR}/），或用面板的建项目按钮`,
      dimensions: dimensionMeta(),
      findingCount: 0,
      /**
       * 面板提示词模板要用的上限，**随每次返回下发**（见 `PANEL_LIMITS` 的注释）。
       * 只加在 `summarize`（面板走这条），**不加在 `receipt`**（模型走那条）——
       * 模型的上限已经写在提示段里了，每轮再塞一份是重复计费。
       */
      limits: PANEL_LIMITS,
      /**
       * 首轮自动判定状态（诊断用）：`fired` 为真表示本会话已经触发过
       * 「直接发需求 → 采访后再建」的注入。让模型与面板都能看见，
       * 而不是「悄悄注入了一条上下文」。
       */
      firstRun: firstRunState(extra),
      ...pauseFields(),
      ...extra,
    }
  }
  const modules = state.modules.map((module) => (brief
    ? { name: module.name, exists: module.exists, health: module.health, progress: module.progress }
    : {
      name: module.name,
      exists: module.exists,
      health: module.health,
      dimensions: module.healthScores,
      sources: module.healthSources,
      progress: module.progress,
      counts: module.counts,
    }))
  return {
    ok: true,
    initialized: true,
    degraded: state.degraded === true,
    projectRoot: state.projectRoot,
    projectDir: state.puzzleDir,
    mainDoc: state.mainDoc,
    project: state.project,
    /** 文档格式版本与「是否旧格式」：旧格式要 op:rebuild 迁移，别当它是当前形状。 */
    version: state.version ?? PUZZLE_VERSION,
    outdated: state.outdated === true,
    mode: state.mode,
    modeSource: state.modeSource ?? 'default',
    /** 项目规模档位（小 / 中 / 大）：面板按它高亮当前档并显示对应上限。 */
    size: state.size ?? DEFAULT_SIZE,
    /**
     * front-matter 里写的是**旧名字**（v4 及更早的 `边拼边写` = 一轮做完才问），
     * 已按 `写后再拼` 读。面板与模型都该看见它——否则用户会以为「我选的是边拼边写」。
     */
    modeRenamed: state.modeRenamed === true,
    /** 项目健康性 = 各模块五维健康性的均值。 */
    health: state.health,
    // 精简档用**中文维度名**：说明表（dimensionMeta）在精简档里被去掉了，
    // 再给英文 key 就等于给了数字不给图例。全量档保持英文 key（面板按 key 取数）。
    dimensions: brief
      ? Object.fromEntries(HEALTH_DIMENSIONS.map((dimension) => [dimension.name, (state.dimensions ?? {})[dimension.key] ?? 0]))
      : state.dimensions,
    // 五维元信息表有 372 字符，作用是给第一次接触的模型解释「每维什么意思」；
    // 接续会话的精简档不需要，省下来。
    ...(brief ? {} : { dimensionMeta: dimensionMeta() }),
    /**
     * 审查发现**不塞进这里**：`op:read` 是模型每轮都会调的，要精简。
     * 想看完整发现走 `op:audit`；面板则走 RPC 的 `state`（它自己附上）。
     * 这里只给一个数量，好让模型知道「有东西可审」。
     */
    findingCount: Array.isArray(state.findings) ? state.findings.length : 0,
    sections: state.sections ?? {},
    /**
     * **当前项目**的真实上限（按规模档位算）。
     *
     * 为什么给的是「当前档」而不是 `PANEL_LIMITS`：提示段为了缓存稳定**不写死数字**
     * （它只说「按项目规模，看返回里的 limits」），所以这里必须给出**这个项目**的值，
     * 否则模型只能猜。档位没写就是 `中`（= 升级前的上限），与写入侧同一个函数算出来。
     */
    limits: limitsFor(state.size),
    size: state.size ?? DEFAULT_SIZE,
    /**
     * 工作流：主文档 `## 工作流` 的**流水线块**（`[{name, steps}]`）。
     *
     * 必须**每轮都给**（不进 brief 的裁剪）：提示段只讲规则、不讲具体流程，
     * 而工作流是每个项目自己的。模型看不到它，这条功能就等于不存在。
     */
    workflow: Array.isArray(state.workflow) ? state.workflow : [],
    workflowArchiveCount: Array.isArray(state.workflowArchive) ? state.workflowArchive.length : 0,
    modules,
    updated: state.updated ?? null,
    canExecute: isExecutableMode(state.mode),
    // 接续会话的第一步就是「按需读」：把该读什么直接写进返回，省一次摸索。
    ...(brief
      ? {
        readNext: [
          '只读主文档（查找入口，五节：模块索引 / 源码索引 / 工具索引 / 坑 / 工作流）：' + (state.mainDoc ?? ''),
          '再按本轮要动的地方只读一个模块文档；不确定读哪个就问用户，别通读模块目录。',
          '需要看实现时按主文档的「源码索引」直接跳源码。',
        ],
        hint: '这是精简档（brief）。要每模块的五维明细用 op:read 且不带 brief；单个模块的正文用 op:show。',
      }
      : {}),
    /**
     * 首轮自动判定状态（诊断用）：`fired` 为真表示本会话已经触发过
     * 「直接发需求 → 采访后再建」的注入。让模型与面板都能看见，
     * 而不是「悄悄注入了一条上下文」。
     *
     * ⚠️ 必须放在 `...extra` **之前**：`extra` 由 `located()` 造，里面也带
     * `sessionId`，放后面会被它盖掉（踩过——诊断字段整个消失）。
     */
    firstRun: firstRunState(extra),
    ...pauseFields(),
    ...extra,
  }
}

/** `op:'list'` 的返回：所有项目 + 哪个是「不给 project 时的默认」。 */


/** `op:'list'` 的返回：所有项目 + 哪个是「不给 project 时的默认」。 */
export function summarizeList(projectRoot, projects) {
  return {
    ok: true,
    initialized: projects.length > 0,
    projectRoot,
    projectCount: projects.length,
    projects,
    defaultProject: projects.length > 0 ? projects[0].name : null,
    hint: projects.length > 0
      ? '多个项目并存时请在调用里显式给 project，否则默认用最新的那个。'
      : '项目根下还没有拼图项目，用 op=init 新建。',
    ...pauseFields(),
  }
}


/**
 * 这个模式能不能动手。**三模式**（v5 起）：只有 `只拼不写` 不行。
 *
 * 两个可执行模式的差别不在「能不能执行」，而在**什么时候问**：
 * `写后再拼` 一轮做完才问，`边拼边写` 每个写动作前先问。所以这里只答第一层问题，
 * 「问的节奏」由提示段交给模型（宿主不去数它问了没——那是行为约束，不是权限）。
 */
export function isExecutableMode(mode) {
  return EXECUTABLE_MODES.includes(mode)
}
