/**
 * 所有对外契约常量：目录布局、小节标题、条目限长、五维定义。改这里等于改契约。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */


/** 文档文件夹固定名。 */
export const PUZZLE_DIR = '拼图'

export const MAIN_FILE = '主文档.md'

export const MODULE_DIR = '模块'

/** 三种执行模式。 */


/**
 * 三种执行模式。
 *
 * v5 起从两种拆成三种（用户裁定）：
 *   - `只拼不写`：只提问 + 更新文档，越权工具被宿主 deny；
 *   - `写后再拼`：**旧的「边拼边写」改名而来**——一轮做完才问；
 *   - `边拼边写`：**新名给高强度版**——每个写动作（write/edit/bash…）之前先问，
 *     用户点头才动手。名字与旧的相反是用户刻意要的：旧名名不副实（做完才问），
 *     真·边拼边写才配这个名字。
 *
 * 改名是**破坏性改动**：文档里 `模式: 边拼边写` 在 v4 及更早表示「写后再拼」，
 * 所以 v4→v5 的迁移必须改写它，`normalizeMode()` 负责这件事。
 */
export const MODE_PUZZLE_ONLY = '只拼不写'

export const MODE_PUZZLE_AFTER = '写后再拼'

export const MODE_PUZZLE_WRITE = '边拼边写'

export const MODES = [MODE_PUZZLE_ONLY, MODE_PUZZLE_AFTER, MODE_PUZZLE_WRITE]

/** v5 起「可执行」的模式：除了只拼不写，两个都是。 */
export const EXECUTABLE_MODES = [MODE_PUZZLE_AFTER, MODE_PUZZLE_WRITE]

export const DEFAULT_MODE = MODE_PUZZLE_ONLY

/**
 * 固定收尾问：**每一次提问都必须带上它**。
 * 选项顺序就是建议顺序——「停下」在前且为推荐项。
 */
export const PAUSE_QUESTION = '要不要先停下？'

export const PAUSE_OPTIONS = ['停下，等我看过再说', '继续，不用停']

/**
 * 一轮提问的**问题条数上限**与**每题选项上限**。
 *
 * 为什么要有这两个数、为什么是 10：原先提示段只写「最多 5 问」而**完全不提选项**，
 * 结果模型倾向每题只给 2–3 个选项，用户能点的面太窄——「提问不够全面」就是这么来的。
 * 用户裁定：问题放开到 10 个、选项也放开到 10 个。
 *
 * 这两条**只是提示给模型的软上限**，不是工具侧校验：`ask_user_question` 在 DSH 核心
 * （`dsh-tool-ask-user` / `dsh-user-questions`）里**没有任何数量校验**，UI 也是
 * `options.map(...)` 全渲染、卡片 `max-height: min(60vh, 520px)` 可滚。
 * 所以这里**不写拦截**——真拦了反而会在宿主升级后变成误报。
 * 唯一从这两个数派生的硬约束是收尾问：见 `PAUSE_LINE`，它固定两项。
 */
export const ASK_MAX_QUESTIONS = 10

export const ASK_MAX_OPTIONS = 10

/**
 * 主文档 front-matter 里的会话绑定字段：**v8 起已废弃，只在读老文档与迁移时认它**。
 *
 * v8 把插件改成全局（面板不绑会话、项目独立），这两个字段**停止写入**，
 * 并且 `op=rebuild` 迁移时会把它们**删掉**。常量保留下来有两个用处：
 *   ① 迁移要认出它们才能删（`MIGRATIONS` 的 v7→v8 那一步）；
 *   ② 老文档还没迁移时读进来不能报错（读到就丢，不参与任何判定）。
 *
 * ⚠️ 不要再新增任何「写这两个字段」的路径——写了就是格式回退。
 */
export const SESSION_FIELD = '会话'

/**
 * 主文档 front-matter 里的**当前会话**字段：**v8 起同样废弃**（见上一条）。
 *
 * 它原本是「这几个绑定里，工具不给 project 时落在哪个」的落盘标记。
 * v8 之后「当前打开的项目」记在**插件全局设置**的 `openProject` 里，
 * 与文档无关——同一份文档在不同面板实例上可以打开着不同的项目。
 */
export const CURRENT_SESSION_FIELD = '当前会话'

/**
 * 绑定数超过它就在面板上提醒——**v8 起已无绑定，这个常量只服务读老文档的兼容路径**。
 *
 * 保留它是因为契约测试与老文档的读取路径仍在引它；v8 的面板不再有「绑太多了」
 * 这条提醒（项目列表列出全部项目，没有「绑定」这个中间概念）。
 */
export const BINDING_WARN_THRESHOLD = 8

/**
 * 主文档 front-matter 里的**源码根**字段。
 *
 * 为什么需要它：文档目录与源码目录常常不是同一处。本项目实测：文档在
 * `/sdcard/dsha222/拼图模式插件/拼图/`，源码却在 `/root/.dsh/plugin-src/dsh-puzzle-mode/`。
 * 审查要做源码体检（文件行数、巨函数、目录分层），必须先知道**去哪看代码**。
 * 没记这个字段就退回「拼图目录的上一级」，找不到就如实说「没查到」，不假装干净。
 */
export const SOURCE_ROOT_FIELD = '源码根'

/**
 * 当前文档格式版本（front-matter 的 `puzzle:` 字段）。
 *
 * **破坏性改动必须 +1，并在 MIGRATIONS 里补一步**——版本号不 +1 的破坏性改动
 * 就是「旧文档静默降级」：读得出来、不报错，但形状已经对不上。
 *
 * v1：`进度/完成度` 单一维度；模块 front-matter 带 `模式:`/`计划模块:`；无 `## 健康性`。
 * v2：五维健康性；模块 front-matter 只留 `项目:`/`模块:`；主文档加 `会话:` 绑定。
 * v3：主文档收敛为四节（模块索引 / 源码索引 / 工具索引 / 坑）；模块拆出
 *     `## 悬而未决`（≤4 条）与 `## 已定`（≤10 条）、去掉勾选框；`## 撤销` 取消；
 *     每条条目限字数且必须带源码出处。
 * v4：主文档加**第五节 `## 工作流`**（≤5 条，超了删最旧）：工作流是**约束模型在特定
 *     操作下不去做别的事**的规则，随提示段注入；被删的条目进 front-matter 的
 *     `工作流归档:`（≤10 条），面板可一键恢复单条。
 * v5：执行模式**两种拆三种**并改名——`边拼边写`（旧·一轮做完才问）改名 `写后再拼`，
 *     新 `边拼边写` 表示「每个写动作前先问」。旧文档的 `模式: 边拼边写` 在 v4 及更早
 *     一律按 `写后再拼` 读（`normalizeMode()`），迁移时改写落盘。
 * v6：`## 工作流` **从「扁平约束清单」重定义为「标准化流水线」**（用户原话：工作流就是
 *     工作流程——为完成特定任务，把重复步骤、工具、规则按顺序串成的标准化流水线）。
 *     一条工作流 = 一个 `### 名字` 块，块内逐行有序步骤；不再是 `- 一句话` 的扁平条目。
 *     每条工作流是**一条独立的路**（不互相依赖），所以「改一条」就改那一块，
 *     而不是新加一条。上限 5 条 / 每块 ≤12 步。
 * v7：**一个会话可同时绑多个项目**（用户裁定：一个会话同时操作几个项目）。主文档新增
 *     `当前会话:` 字段标记「工具不给 project 时落到哪个项目」（不变量：⊆ `会话:`）。
 *     连带三处语义变化：拦截按**全部绑定**里最严的那个算（多项目联动）；
 *     工作流触发按**命中的项目**注入（一个动作可能命中多个绑定项目，各自注入各自的流程）；
 *     面板的项目切换条从「原生下拉 + 改绑」改成「绑定组内切换 + 单独加绑」。
 * v8：**插件改为全局，项目与会话解绑**（用户裁定，v2.0.0）。三件事一起发生：
 *     ① `会话:` / `当前会话:` **停止写入**，迁移时**删掉**（绑定逻辑整体退场）；
 *     ② 项目根不再来自「会话 cwd」，改成插件全局设置里的**绑定的工作区**
 *        （`$DSH_HOME/.dsh-puzzle-mode.json` 的 `workspaceId` / `workspacePath`）；
 *     ③ 面板变成工作台：一级项目列表、二级两个子页（文档信息 / 派单系统）。
 *     ⚠️ 代价如实记：删字段后**不能回退到 v1.x**（旧版读不到绑定，全部项目表现为「未绑定」）。
 * v9：**工作流功能整体删除**（用户裁定）。主文档从五节收敛为**四节**——`## 工作流`
 *     整节删掉，front-matter 的 `工作流归档:` 字段也删掉；随之退场的还有
 *     `lib/workflowguard.js`（注入去重/节流）、`op=workflow`、面板的工作流图块与归档操作。
 *     迁移（v8→v9）**真的删内容**：那一节里的流水线步骤与归档里的历史条目都不再保留。
 *     ⚠️ 代价如实记：删节后**不能回退到 v8 及更早**——旧版会把「没有 `## 工作流`」
 *     读成「缺小节」，`op=rebuild` 又会给它补一个空节回来；旧版更读不到已删的归档。
 */
export const PUZZLE_VERSION = 9

/**
 * `边拼边写` 这个名字**换过含义**的那一版。
 *
 * 低于它的文档里 `模式: 边拼边写` 表示「一轮做完才问」（= 现在的 `写后再拼`）；
 * 达到它之后才是「每个写动作前先问」。所有读 `模式:` 的地方都必须带上版本来判定，
 * 否则旧项目会在升级那一刻**静默变成高强度模式**——每次写文件都停下来问，而用户没同意过。
 */
export const MODE_RENAME_VERSION = 5

/**
 * 旧「完成度」折算成五维时的统一折扣。
 *
 * 完成度只说明**做过**，不足以给高分——它是单维自评，而五维问的是复杂度、可拓展性、
 * 可维护性、质量沉淀、可复用性。统一 ×0.5 是刻意的保守，且**不用伪造逐维精度**：
 * 五个不同的系数看着更"准"，其实是凭空编的比例。折算值只是起点，等真实证据写进来就该被替换。
 */
export const PROGRESS_TO_HEALTH = 0.5

/**
 * 只拼不写模式下仍然允许的工具。
 *
 * 拦截点是 `tools/pre-execute`（可返回 `{kind:'deny'}`）——不是 `agent/pre-step`：
 * 后者的 `decision.messages` 契约是 `UserMessage[]`，里面根本没有 tool-call，
 * 在那上面做「剔除 assistant 消息」的拦截是死代码。
 *
 * 注意：文档写入**只能**走 `puzzle_mode` 工具（它做 slug 过滤与路径守卫）。
 * `write` / `edit` 不在白名单里，是有意的——它们能绕过守卫写到拼图目录之外。
 */
export const PUZZLE_ONLY_ALLOWED_TOOLS = ['puzzle_mode', 'read', 'grep', 'glob', 'ask_user_question', 'todo_write']

/* ------------------------------- 项目健康性 ------------------------------- */

/**
 * 五个健康性维度。**全部越高越好**（含「维护系数」——高分表示维护负担轻）。
 *
 * `derive` 是该维度的证据推导：模型没在文档里显式写分数时，用它从文档内容推。
 * 设计原则：**健康性反映的是「已经写在文档里的证据」，不是模型凭感觉打的印象分**。
 * 所以没有文档就没有健康性——空模块五维全 0，而不是"看起来还行给 60"。
 */


/** 模块文档里的健康性小节（项目级五维汇总也写在这里）。 */
export const HEALTH_HEADING = '## 健康性'

/**
 * 主文档固定小节，顺序即模板顺序。
 *
 * v9 起是**四节**：模块索引 / 源码索引 / 工具索引 / 坑。
 * （v4 曾加第五节 `## 工作流`，v9 连同 front-matter 的 `工作流归档:` 一起删除。）
 * 用户原话、悬而未决、已定、撤销一律不写进主文档（用户原话不再入库，
 * 决策写在模块文档里，撤销项直接删除）；轮汇报写进模块文档的 `## 详细记录`。
 */
export const SECTION_ORDER = ['index', 'source', 'tools', 'pit']

export const SECTION_HEADINGS = {
  index: '## 模块索引',
  source: '## 源码索引',
  tools: '## 工具索引',
  pit: '## 坑',
}

export const HEADING_BY_KEY = SECTION_ORDER.map((key) => [key, SECTION_HEADINGS[key]])

export const SECTION_KEYS = new Set(SECTION_ORDER)

/** v2 的合并小节：迁移时按勾选框拆成 `## 悬而未决` / `## 已定`。 */
export const RELATED_HEADING = '## 与本模块相关的悬而未决 / 已定 / 撤销'

/** 模块文档固定小节，顺序即模板顺序（**不再有勾选框**）。 */
export const MODULE_SECTION_KEYS = ['health', 'progress', 'points', 'pending', 'decided', 'reuse', 'detail']

export const MODULE_SECTION_HEADINGS = {
  health: HEALTH_HEADING,
  progress: '## 进度',
  points: '## 要点',
  pending: '## 悬而未决',
  decided: '## 已定',
  reuse: '## 可复用',
  detail: '## 详细记录',
}

export const MODULE_SECTION_ORDER = MODULE_SECTION_KEYS.map((key) => MODULE_SECTION_HEADINGS[key])

/**
 * 一个「规范标题」后面允许跟的说明分隔符。
 *
 * 为什么需要它：文档里出现过 `## 源码索引（src/，共 110 文件 / 18,218 行）` 这种
 * **规范标题 + 说明后缀**的写法。`getSection` 原本是精确匹配，于是它**读不到**那一节，
 * `op:main` 写 `source` 时会另起一个空的 `## 源码索引`——原来的内容还在文件里，
 * 却永远读不出来。所以匹配要容忍后缀，但**只容忍分隔符开头**的：
 * `## 坑与决策` 不会被当成 `## 坑`（`与` 不是分隔符），避免误合并。
 */
export const HEADING_SUFFIX_SEPARATOR = /^[\s（(：:—\-–·]/

/**
 * 单条条目的字数上限（一个字算 1，标点也算）。
 *
 * 计数只算「一句话」，**源码出处不占额度**：条目格式固定为
 *   `- <一句话>（源码: <文件>[:<行>]）`
 * `（源码…` 之前的部分才计入。超限就**拒绝写入**（不是截断）——
 * 截断会把半句话落进文档，比让模型重写一遍更糟。
 */
export const ENTRY_LIMITS = { index: 50, source: 50, tools: 50, pit: 20, points: 20, pending: 20, decided: 20, reuse: 20, detail: 50 }

/**
 * 每模块的条数上限：超了**删最旧**。
 *
 * 条目是追加写的，列表最前面就是最早的，所以保留末尾 N 条。
 */


/**
 * 条数上限：超了**删最旧**。
 *
 * 条目是追加写的，列表最前面就是最早的，所以保留末尾 N 条。
 */
export const ENTRY_CAPS = { pending: 4, decided: 10 }

/* ------------------------------ 项目规模（小 / 中 / 大） ------------------------------ */

/**
 * 项目规模档位：**同一个项目，写多少条**由它决定。
 *
 * 为什么需要它：固定上限对两头都不合适——小项目（几百行脚本）的模块文档里
 * 「已定 10 条」根本写不满，而大项目（几万行、十几个模块）四条「悬而未决」
 * 一上午就顶满了，于是**最旧的决策被静默挤掉**，而那正是文档存在的意义。
 * 所以把「写多细」交给用户按项目体量选，而不是全仓一个数。
 *
 * 存哪：主文档 front-matter 的 `规模:` 字段（跟着项目走，换会话 / 换机器都在）。
 * 没写就是 `中`——**存量文档一个都不用改**，默认行为与升级前完全一致。
 *
 * 三档的取法（中档 = 升级前的值，所以「什么都不做」不会变）：
 *   - `小`：条目数**收紧**（悬而未决 4 / 已定 6），坑 **10 条**——
 *     小项目里堆 136 条坑只会淹掉真正重要的那几条；
 *   - `中`：`ENTRY_CAPS` 原值（4 / 10），坑不限（历史行为）；
 *   - `大`：条目数**放宽**（12 / 30），字数也放宽（见 `SIZE_ENTRY_LIMITS`）。
 */
export const SIZE_SMALL = '小'
export const SIZE_MEDIUM = '中'
export const SIZE_LARGE = '大'
export const SIZES = [SIZE_SMALL, SIZE_MEDIUM, SIZE_LARGE]
export const DEFAULT_SIZE = SIZE_MEDIUM

/** 主文档 front-matter 里记规模的那一行。没写就是 `中`（存量文档一个都不用改）。 */
export const SIZE_FIELD = '规模'

/** 认规模名：`小` / `中` / `大`，别名 `s`/`m`/`l` 与 `small`/`medium`/`large` 也认。 */
export function normalizeSize(raw) {
  if (typeof raw !== 'string') return null
  const key = raw.trim().toLowerCase()
  if (key === '') return null
  const table = {
    小: SIZE_SMALL, s: SIZE_SMALL, small: SIZE_SMALL,
    中: SIZE_MEDIUM, m: SIZE_MEDIUM, medium: SIZE_MEDIUM,
    大: SIZE_LARGE, l: SIZE_LARGE, large: SIZE_LARGE,
  }
  return table[key] ?? null
}

/**
 * 各档的**条数**上限。
 *
 * 三节之外还有 `pit`（主文档的坑）——它是唯一按规模限条数的主文档小节。
 * `null` 表示**不限**。
 *
 * ⚠️ **`大` 的 pit 也是 `null`，这不是漏写**（实测发现并修正）：
 * 原先写的是 `大: 60`，而中档是 `null`（不限）。后果是**切到大档反而收紧**——
 * 实测：中档写 70 条坑全部留下，大档写同样 70 条**被砍到 60、静默丢 10 条**。
 * 这恰好违反了分档的初衷（大项目更不该丢内容），而且「坑」是**只增不减的踩坑记录**，
 * 被静默删掉比决策类更可惜。
 *
 * 单调性要求：`小 ≤ 中 ≤ 大`。中档是「不限」，大档就不可能比它更严——
 * 要么大档也不限，要么把中档也设成有限值（那会让存量中档项目下次写坑被砍）。
 * 选了前者：小档仍收紧（10），中/大都不限。
 */
export const SIZE_CAPS = {
  [SIZE_SMALL]: { pending: 4, decided: 6, pit: 10 },
  [SIZE_MEDIUM]: { pending: 4, decided: 10, pit: null },
  [SIZE_LARGE]: { pending: 12, decided: 30, pit: null },
}

/**
 * 各档的**字数**上限（只放宽 `大`，`小` 与 `中` 相同）。
 *
 * 为什么小档不收紧字数：字数上限管的是「一句话有没有写清」，
 * 与项目体量无关——小项目的一句结论同样需要 20 字。
 * 而大项目里「已定」的条目常常要写下一句带取舍的结论，20 字确实不够。
 */
export const SIZE_ENTRY_LIMITS = {
  [SIZE_SMALL]: { ...ENTRY_LIMITS },
  [SIZE_MEDIUM]: { ...ENTRY_LIMITS },
  [SIZE_LARGE]: { ...ENTRY_LIMITS, points: 40, pending: 40, decided: 40, reuse: 40, detail: 80, pit: 40, index: 80, source: 80, tools: 80 },
}

/** 取某一档的条数上限（认不出的档位回落到 `中`）。 */
export function capsOfSize(size) {
  return SIZE_CAPS[normalizeSize(size) ?? DEFAULT_SIZE]
}

/** 取某一档的字数上限（认不出的档位回落到 `中`）。 */
export function limitsOfSize(size) {
  return SIZE_ENTRY_LIMITS[normalizeSize(size) ?? DEFAULT_SIZE]
}

/**
 * 面板提示词模板要用到的**全部上限**，随每次 state / 回执下发给客户端。
 *
 * 为什么必须下发（v0.20.5 修的真实脱节）：面板的 9 个提示词模板里原先**又抄了一份数字**
 * （`var ASK_MAX_QUESTIONS = 10`、正文里的「坑 20 字 / ≤4 条 / 最多 12 步、每步 ≤80 字」）。
 * 改这里的上限时，模板不会跟着变——而模板是**填进输入框、直接决定模型怎么写文档**的，
 * 于是模型按过期数字写，写入被拒。这违反本项目自己那条「只改一处即可」。
 *
 * 客户端半是**手写的 module-loader 包**（factory 内只有 `require('react')`），
 * 拿不到这里的 ESM 导出，所以只能随数据下发，不能在客户端 import。
 * `lib/client.js` 里的 `FALLBACK_LIMITS` 是**首次数据到达前**的兜底，两者由契约测试钉住相等。
 */
export const PANEL_LIMITS = {
  askQuestions: ASK_MAX_QUESTIONS,
  askOptions: ASK_MAX_OPTIONS,
  entryLimits: ENTRY_LIMITS,
  entryCaps: ENTRY_CAPS,
  bindingWarnThreshold: BINDING_WARN_THRESHOLD,
  // 三档的条数上限整份下发：面板要在**没绑项目 / 切档位之前**就显示「小/中/大各是多少」。
  sizeCaps: SIZE_CAPS,
  sizes: SIZES,
}

/**
 * 某一档的**完整 limits**——与 `PANEL_LIMITS` 同形状，但条目上限按档算。
 *
 * 为什么要有它（而不是让调用方自己拼）：提示段为了**缓存稳定**不写死数字，
 * 只说「按项目规模，看返回里的 limits」。于是**返回里的 limits 必须是真的**——
 * 模型照它写、写入侧也照它校验，两边必须由同一个函数算出来。这里就是那个唯一口径。
 */
export function limitsFor(size) {
  const name = normalizeSize(size) ?? DEFAULT_SIZE
  return {
    ...PANEL_LIMITS,
    size: name,
    entryLimits: limitsOfSize(name),
    entryCaps: capsOfSize(name),
  }
}

/** 条目里源码出处的起始标记。 */
export const SOURCE_MARK = '（源码'

/**
 * 把 front-matter 里读到的 `模式:` 归一成当前三种之一；认不出来就返回 `null`。
 *
 * **必须带版本来判定**（`version` 缺省按当前版）：v4 及更早的 `边拼边写` 是
 * 「一轮做完才问」的旧含义，等于现在的 `写后再拼`。不带版本直接 `MODES.includes()`
 * 会让每个旧项目在插件升级那一刻**静默跳进高强度模式**——模型每次写文件都停下来问，
 * 而用户从没同意过。这条坑是「名字复用」的必然代价，所以判定集中在这一个函数里。
 */
export function normalizeMode(raw, version = PUZZLE_VERSION) {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (value === '') return null
  if (value === MODE_PUZZLE_WRITE && version < MODE_RENAME_VERSION) return MODE_PUZZLE_AFTER
  return MODES.includes(value) ? value : null
}

/* ---------------------------------- 小工具 ---------------------------------- */
