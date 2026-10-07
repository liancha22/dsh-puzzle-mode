/**
 * dsh-puzzle-mode —— 宿主半（Host）。
 *
 * 四件事，全部挂在当前插件的 Fiber 上，卸载即撤销：
 *   1) systemPrompt 一段静态规则 `puzzle-mode:policy`：提问节奏（含固定收尾问）、
 *      建项目时机、文档结构、三种执行模式的许可边界；
 *   2) 模型工具 `puzzle_mode`：列项目 / 读状态 / 读模块详情 / 建项目 / 改小节 / 切模式；
 *   3) `tools/pre-execute` Waterfall 监听：项目处于「只拼不写」时 `deny` 越权工具；
 *   4) webServer 路由 `/puzzle-mode-rpc`：浏览器半唯一的数据通道（与 dsh-session-health 同模式）。
 *
 * 拦截点为什么是 `tools/pre-execute` 而不是 `agent/pre-step`：
 * 后者的 `decision.messages` 契约是 `UserMessage[]`——里面**没有 tool-call**，
 * 在它上面「剔除 assistant 消息里的 tool-call」是永远不生效的死代码。
 * `tools/pre-execute` 是运行时给出的、可返回 `{kind:'deny',reason}` 的官方钩子，
 * deny 的 reason 会作为该次调用的错误回到模型，正好用来让它改走文档路径。
 *
 * 平面：宿主组成。工具、提示段、路由都必须进程内唯一，所以整行放宿主机，不进 preset。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  AUDIT_PROMPT,
  DEFAULT_MODE,
  WORKFLOW_NAME_LIMIT,
  WORKFLOW_STEP_LIMIT,
  WORKFLOW_MAX_STEPS,
  SESSION_FIELD,
  CURRENT_SESSION_FIELD,
  BINDING_WARN_THRESHOLD,
  addBinding,
  bindSession,
  boundProject,
  boundProjects,
  setCurrentProject,
  unbindOne,
  HEALTH_DIMENSIONS,
  HEALTH_HEADING,
  MODES,
  MODE_PUZZLE_ONLY,
  MODE_PUZZLE_AFTER,
  MODE_PUZZLE_WRITE,
  MODE_RENAME_VERSION,
  MODULE_SECTION_KEYS,
  PAUSE_OPTIONS,
  PAUSE_QUESTION,
  ASK_MAX_QUESTIONS,
  ASK_MAX_OPTIONS,
  PUZZLE_ONLY_ALLOWED_TOOLS,
  PUZZLE_DIR,
  PUZZLE_VERSION,
  SECTION_HEADINGS,
  SECTION_ORDER,
  docMutationTarget,
  docVersion,
  isPuzzleDocPath,
  planRebuild,
  rebuildProject,
  createProject,
  defaultProjectName,
  dimensionMeta,
  dimensionRanking,
  auditOf,
  fixPlanOf,
  recheckPlan,
  internEvidence,
  indexVerdicts,
  isExecutableMode,
  inspectSource,
  listProjects,
  scanUnpuzzled,
  projectSummaries,
  readMainDoc,
  parseFrontMatter,
  getSection,
  parseWorkflowBlocks,
  workflowsTriggeredBy,
  readModuleDetail,
  readState,
  readProjectMode,
  removeWorkflowItem,
  restoreWorkflowItem,
  dropWorkflowArchiveItem,
  setMode,
  setSourceRoot,
  sizeOfProject,
  setSize,
  SIZES,
  capsOfSize,
  limitsOfSize,
  slugify,
  summarize,
  summarizeList,
  receipt,
  trueHealthOf,
  unbindSession,
  updateMainSection,
  updateModuleSection,
  disableSession,
  enableSession,
  isSessionDisabled,
  isAskPauseEnabled,
  setAskPause,
  pauseFields,
  readSettings,
  settingsPath,
  detectFirstRun,
  firstRunHint,
  FIRST_RUN_CONDITIONS,
  isDelegatedSession,
  makeContextMessage,
  hasFired,
  markFired,
  noteAction,
  loopBreakText,
  LOOP_REPEAT_THRESHOLD,
  LOOP_ESCALATE_EVERY,
  noteCall,
  nudgeText,
  NUDGE_EVERY,
  listThemes,
  installTheme,
  applyTheme,
  resetTheme,
  uninstallTheme,
  loadThemeCss,
  themeOverview,
  setThemeRepo,
  THEME_API_VERSION,
  DEFAULT_THEME_REPO,
} from './puzzle.js'

export const name = 'dsh-puzzle-mode'
export const inject = ['tools', 'systemPrompt', 'webServer']

const SECTION_NAME = 'puzzle-mode:policy'
/**
 * 提示段段序（跨插件共存用）。
 *
 * 为什么是可覆盖的、为什么默认 10120：
 *   - 本段原先写死 10500，排在 `dsh-infinite-gen-5` 的「真末位锚点」（order 10150）**之后**——
 *     而对方那句「本载荷是整份系统提示的最后一段」在本机就不成立了。两边同装时，
 *     段序应当是一个**双方都声明、可核对**的数字，而不是单方面占位。
 *   - 10120 的取法：① 小于无限五代末位锚点 10150（于是它的末位声明成立）；
 *     ② **不落在 DSH 内置段序表的任何取值上**——内置表里有 `WEB_SURFACE: 10100`，
 *     同号时段序相同时按**段名**比较，位置就不再由协商决定（撞号的坑实测过）。
 *   - 需要放回末位或任何位置时用环境变量覆盖：
 *       PUZZLE_SECTION_ORDER=10500 dsh ...   # 恢复旧行为（本段在 persona suffix 之后）
 *       PUZZLE_SECTION_ORDER=10000 dsh ...   # 更靠前
 *   - 契约由 `compat.json` 声明、`tools/verify-cross-plugin.mjs` 双向核对；
 *     对方侧同一组数字记在无限五代的 `data/arbitration.mjs`。
 */
const DEFAULT_SECTION_ORDER = 10120
const ORDER = (() => {
  const n = Number.parseInt(process.env.PUZZLE_SECTION_ORDER ?? '', 10)
  return Number.isFinite(n) && n !== 0 ? n : DEFAULT_SECTION_ORDER
})()
export const SECTION_ORDER_VALUE = ORDER
const MAX_BODY = 16384
const OPS = ['list', 'scan', 'read', 'show', 'main-doc', 'workflow', 'init', 'bind', 'bindings', 'unbind', 'current', 'rebuild', 'main', 'module', 'health', 'audit', 'source', 'mode', 'size', 'settings']

/**
 * 提问规则那几行（提示段用）。
 *
 * 为什么收成常量：这两个数原先散在多处各写一份（提示段、首轮注入、面板模板 ×3、
 * README、UI.md），改一次「5 问」就得满仓库找——漏一处就变成两套规则打架。
 * 改上限只改 `constants.js` 的 `ASK_MAX_*`（那是唯一数字来源），文案引用它。
 *
 * 为什么首轮注入那份不直接复用本常量：`firstrun.js` 是**纯逻辑层**（不碰 ctx、
 * 可单独 import），从它反向 import 宿主半的 `index.js` 会把依赖方向倒过来。
 * 所以 `firstRunHint` 自己拼那一行——**数字**仍取自 `ASK_MAX_*`，只是措辞各写一份。
 *
 * 为什么带「反例 / 正例」而不只是给一句「多给选项」：v0.19.4 只写了「别只给两三个」，
 * 但**没有说清一个选项该长什么样**——模型照着字面做，很容易凑出四个都没信息量的选项
 * （「改 / 不改 / 再看看 / 都行」）。给一个能照抄的骨架，比给一句形容词有用。
 * 广度 = 下面那五个维度（一次决策通常问得出 2–3 个）；深度 = 每个选项必带取舍。
 */
const ASK_RULE_LINES = [
  `- 你**主动提问**，不要等用户想起来才问：一轮 **最多 ${ASK_MAX_QUESTIONS} 问**、`
    + `**每题最多 ${ASK_MAX_OPTIONS} 个选项**。能用选项就用选项，问的是真正卡住决定的点。`,
  '- **每题给 3–6 个真岔路，每个配一句取舍**（`options[].description`）。只说「① 改 ② 不改」'
    + '等于没问——用户看不到代价就没法选。',
  '- 找岔路从这五个维度问：**做法**（走哪条路）、**范围**（改多大 / 动几处）、'
    + '**时机**（现在做还是先记下）、**代价**（出问题怎么退、多花什么）、'
    + '**取舍**（快 vs 稳、通用 vs 专用）。一个决策通常问得出 2–3 个维度。',
  '- 反例（太窄）：`要不要改 A？` ① 改 ② 不改 —— 没问出「怎么改、改多大」。',
  '- 正例（问全）：`A 的改法走哪条？` ① 就地改（推荐）：改动最小，但 A 的旧行为消失；'
    + '② 加开关并存：两套都留，代价是多一个配置项与两条路径；'
    + '③ 抽新模块替换：A 退役，但要改 5 处调用点；'
    + '④ 先不改，只把问题写进文档：零风险，但问题留着。',
  '- **同一件事只有一种做法时别硬凑选项**——那不是岔路，写进正文说明即可。',
]

/** 提示段里反复引用的固定收尾问原文（工具返回里也带同一份）。 */
const PAUSE_LINE = `提问的最后一项固定问「${PAUSE_QUESTION}」，选项固定两项：① ${PAUSE_OPTIONS[0]}：只回写文档 + 一句话说明，**本轮立即结束**，不执行任何动作；② ${PAUSE_OPTIONS[1]}：按当前模式继续。这一问也要用 ask_user_question 提交，不要只在正文里列。`

/** 五维清单（提示段与工具描述共用一份）。 */
const DIMENSION_LINE = HEALTH_DIMENSIONS
  .map((dimension) => `\`${dimension.name}\`（${dimension.hint}）`)
  .join('；')

/** 拒绝时的理由：一句话说清「为什么被拦 + 现在该做什么」。 */
function denyReason(toolName, project, allBound = null) {
  const where = typeof project === 'string' && project !== '' ? `（项目「${project}」）` : ''
  // 多绑定时说清「是哪一个项目拦的、还绑着哪些」：不说的话用户会以为整个会话都被锁死，
  // 而实际上只要把那个项目放开（或解绑它）就能继续。
  const others = Array.isArray(allBound) && allBound.length > 1
    ? `本会话还绑着：${allBound.filter((name) => name !== project).join(' / ')}（多绑定联动，任一项目是「${MODE_PUZZLE_ONLY}」就拦）。`
    : ''
  return `[拼图模式 · ${MODE_PUZZLE_ONLY}] 已拦下工具「${toolName}」${where}：本模式只提问与更新拼图文档，`
    + `不执行任何动作（不跑命令、不改代码）。当前允许：${PUZZLE_ONLY_ALLOWED_TOOLS.join(' / ')}。`
    + others
    + `文档更新请用 puzzle_mode（它带路径守卫），不要用 write / edit。`
    // 收尾问被全局关掉时不再复述它——拒绝理由里继续要求「最后问一次」，
    // 等于用一个提示把用户的设置又打开了一遍。
    + (isAskPauseEnabled()
      ? `请改为：把本轮结论写进文档 → 提出下一次提问 → 最后问一次「${PAUSE_QUESTION}」`
        + `（① ${PAUSE_OPTIONS[0]} ② ${PAUSE_OPTIONS[1]}）。`
      : '请改为：把本轮结论写进文档 → 提出下一次提问（固定收尾问已全局关闭，不要再问）。')
    + `用户想执行就把模式切到「${MODE_PUZZLE_AFTER}」（一轮做完才问）或「${MODE_PUZZLE_WRITE}」`
    + `（每个写动作前先问）（puzzle_mode{op:'mode'} 或面板按钮）。`
}

/**
 * 文档锁的拒绝理由：**与执行模式无关**，任何模式改拼图文档都走这条路。
 *
 * 为什么连「边拼边写」也拦：文档形状由 `puzzle_mode` 统一维护（条目限长、
 * 条数上限、slug 过滤、路径守卫）。绕过去用 `write` 直接覆盖，等于把这些规则全跳过——
 * 一次就能写出超长条目或越界路径，而校验再也不会发生。
 */
function docLockReason(toolName, target) {
  return `[拼图模式 · 文档锁] 已拦下工具「${toolName}」对拼图文档的改动：${target}`
    + `。拼图文档（\`${PUZZLE_DIR}/\` 下的主文档与模块文档）**只能通过 \`puzzle_mode\` 改**：`
    + `主文档用 op:main（section: ${SECTION_ORDER.join(' / ')}），模块文档用 op:module（section: ${MODULE_SECTION_KEYS.join(' / ')}）。`
    // ⚠️ 这里**不写具体数字**：条目限长与条数上限都**随项目规模（小 / 中 / 大）变**，
    // 写死中档值会在大档项目上给出错的尺子（大档要点是 40 字，不是 20）。
    // 真实上限从 op:read / op:size 返回的 `limits` 取。
    + `直接写会绕过条目限长、条数上限（都**随项目规模变**，以 op:read 返回的 \`limits\` 为准）、`
    + `slug 过滤与路径守卫。`
    + `只读请用 read / grep / op:show。`
}

/**
 * 提示段文本。**按会话判定**：被禁用的会话不再注入任何拼图规则。
 *
 * `text` 支持函数形式（宿主 `assemble` 会把 `context` 传进来），所以这里能拿到
 * `context.agent.session.id`。宿主**每个 step 都重新 assemble**
 * （`dsh-agent-loop` 的 `preStep`），所以关掉当前会话后**下一轮立即生效**。
 */
function policyText(context) {
  const session = context !== null && context !== undefined && context.agent !== null && context.agent !== undefined
    ? context.agent.session
    : undefined
  const sessionId = session !== undefined && session !== null && typeof session.id === 'string' ? session.id : ''
  if (isSessionDisabled(sessionId)) return ''
  // 固定收尾问被**全局关掉**时，换成一份「没有收尾问」的正文。
  // 为什么不是「把那一行删掉」：提示段是拼好的常量（见 POLICY_BODY 的注释），
  // 每次 assemble 去删一行会把它重新变回逐轮拼接。两份常量 + 一次布尔判断，
  // 既保住「拼一次」的性能，也让「关掉了」这件事在提示段里说得清清楚楚——
  // 否则模型会照着自己上一次的收尾问继续问，关掉就成了一句空话。
  return isAskPauseEnabled() ? POLICY_BODY : POLICY_BODY_NO_PAUSE
}

/**
 * 提示段正文（**常量，只构造一次**）。
 *
 * 为什么要提到模块级：宿主**每个 step 都重新 assemble** 提示段，而这段正文
 * 是**纯字面量**（不随会话 / 项目 / 时间变化），原先每次调用都重新拼一个 6042 字符的
 * 数组再 `join`——实测 **2.1ms/step**，20 步就是 43ms 纯浪费。拼一次存下来，
 * 之后每步只做「是否被禁用」那一次判断（<1µs）。
 *
 * 唯一随会话变化的是「要不要注入」（`isSessionDisabled`），那一步留在 `policyText` 里，
 * 所以关掉拼图模式仍然**下一轮立即生效**——这条语义没有被缓存改掉。
 */
const POLICY_BODY = [
    '## 拼图模式',
    '',
    '本会话启用了「拼图模式」：把项目拆成一份**主文档**加若干**模块文档**，用提问把不确定项变成已定项。',
    '',
    '### 提问',
    ...ASK_RULE_LINES,
    '- **提问必须调 `ask_user_question` 工具**：在正文里写「① ② ③」**不算提问**——用户看不到可点选项，只能在聊天里手打。有选项就填 `options`（推荐选项放第一项并在标签后加「（推荐）」）。',
    '- 固定收尾问「' + PAUSE_QUESTION + '」同样是提问，同样走 `ask_user_question`。',
    '- ' + PAUSE_LINE,
    '- 提问与文档回写**在同一步完成**：先问、再把问答写进文档，不要只问不写、也不要攒到最后一起写。',
    '',
    '### 项目',
    '**一个会话可以同时绑多个项目**，但**当前项目只有一个**（绑定记在主文档 front-matter 的 `会话:` / `当前会话:` 里，随文档走）。',
    '- 解析顺序只有三步：显式 `project` > 本会话的**当前项目** > **空**。没绑定就是空，**不会**自动占用别的项目。',
    `- 先看有哪些项目：\`puzzle_mode{op:'list'}\`。新会话第一件事：\`op:'read'\` 看绑定；返回 \`projectSource: 'none'\` 就是还没绑。`,
    `- 建项目：\`op:'init'\` 并**显式给 \`project\` 与 \`modules\`**，一次把工作区文件夹、主文档与每个模块文档都建出来（建完**追加**一个绑定，**不会**解绑已有的）。不要只建主文档。`,
    `- **新会话直接发需求 → 自动走「采访后再建」**（插件命中 ${FIRST_RUN_CONDITIONS} 时会注入一条同样的提示，这里是第二道）：`,
    `  本会话还没绑项目、而用户第一条消息就是需求时，按这个顺序做，**不要跳步**：`,
    `  ① 先 \`op:'list'\` 看工作区里有没有已有项目；`,
    `  ② **有** → 先用 \`ask_user_question\` 问用户「绑定已有的哪个，还是新建一个」，等他回答，不要替他决定；`,
    `  ③ **没有**（或用户选了新建）→ 采访（最多 ${ASK_MAX_QUESTIONS} 问、每题最多 ${ASK_MAX_OPTIONS} 个选项；目标 / 模块怎么划 / 边界在哪），**不要提前 \`op:init\`**；`,
    `  ④ 拿到回答后 \`op:'init'\` 一次建齐。`,
    `  用户说「别采访 / 直接建 / 不用问」时跳过采访，直接 \`op:init\` 建空壳。`,
    `  用户只是在打招呼（「你好」）时不要触发这套流程。`,
    `- 已有项目：\`op:'bind'\` 并给 \`project\` 把本会话绑过去（**替换全部绑定**——原先绑的会被解绑；只想再加一个用面板的「＋ 绑定项目」）；要换成不绑任何项目用 \`op:'unbind'\`。面板里也有建项目 / 绑定 / 解绑入口。`,
    `- 目录固定为 \`<会话工作区>/<项目名>/${PUZZLE_DIR}/主文档.md\` 与 \`${PUZZLE_DIR}/模块/<模块名>.md\`。`,
    '',
    '### 文档分工',
    '- **主文档只有五节**：`## 模块索引`（模块 → 一句话职责 → 文件）、`## 源码索引`、`## 工具索引`、`## 坑`、`## 工作流`。**除这五节外禁止写任何内容**（用户原话 / 悬而未决 / 已定 / 撤销都不再写进主文档）。',
    // ⚠️ 字数上限**不在这里写死**（它随项目规模变）——第 281 行已说明「以返回里的 limits 为准」。
    // 原先这里写 `≤${ENTRY_LIMITS.index} 字`（中档值），与大档（80 字）矛盾，
    // 于是提示段自己两说并存：一行说死数字、下一行说别信死数字。
    '- 主文档每条是**规整的轮汇报式条目**：一句话 + `（源码: 文件[:行]）`；字数上限**随规模变**，见下。',
    `- 细节一律下沉到模块文档：\`${HEALTH_HEADING}\`、\`## 进度\`（\`完成度: 0-100\`）、\`## 要点\`、\`## 悬而未决\`、\`## 已定\`、\`## 详细记录\`（轮汇报）。`,
    `- **各节的条数与字数上限随项目规模（小 / 中 / 大）变化**，不是一个固定数：动手写之前先 \`op:'read'\`（或 \`op:'size'\`）看返回里的 \`limits\`——那是**这个项目当前**的真实上限，照它写。改档位用 \`op:'size'\` 或面板「规模」三档。`,
    '- **每条都要带源码出处** `（源码: 文件:行）`：查找方向固定为 **主文档 → 源码**，出处不占字数额度。',
    '- 条目**不用勾选框、不用图标**：悬而未决与已定靠小节区分。超过条数上限时**写入会自动删最旧**的，不论旧项有没有澄清。',
    '- **提问等非重要轮不写进文档**；提问的回答只以几句精简结论入库，**不存用户原话、不做解释说明**。撤销项直接删除（不再有「撤销」小节）。',
    '- **一律不得用其他工具改动拼图文档**：`write` / `edit` / `str_replace_editor` 只要目标是 `拼图/` 下的文件就会被宿主拒绝（所有模式生效）。文档只能走 `puzzle_mode`。',
    '',
    '### 工作流（主文档第五节 = 标准化流水线）',
    `- \`## 工作流\` 是**标准化流水线**：为完成某个特定任务，把重复的步骤、工具、规则**按顺序**串成一条可复用的路。一条工作流 = 一个 \`### 名字\` 块，块内**逐行按顺序**写步骤。条数上限见 \`limits\`，每条 ≤${WORKFLOW_MAX_STEPS} 步。`,
    `- 写法：\`### 名字\`（≤${WORKFLOW_NAME_LIMIT} 字，名字是这条路的标识）+ 块内每行一步（≤${WORKFLOW_STEP_LIMIT} 字）。序号由文档自动重排成 \`1. 2. 3.\`，你写 \`- \` 或纯文本都行。`,
    '- 一步要写清**谁 + 用什么工具 + 做什么 + 产出什么**（例如「先跑 \`node --check lib/*.js\` 确认语法，再提交」）。它是可执行的步骤，不是口号。',
    '- **每条工作流是并列的一条独立的路**：两条工作流之间**不应该有依赖**（A 不是 B 的前置）。若两条其实是一条，就把它们合成一条；若一条要分叉，就是两条。',
    '- **要改一条就改那一块**，不要新加一条。原来的整条流程就直接编辑它，不要写成「补充规则」式的第二条。超上限时**写入会自动删最旧的一条**（整条删，进归档可恢复）。',
    `- **步骤超 ${WORKFLOW_MAX_STEPS} 步是报错，不删步骤**：步骤是一条有序的路，中间少一步整条就断了。报错时把重复的合并，或拆成两条独立的工作流。`,
    '- 它**不要求源码出处**（它约束的是流程，不是对代码事实的断言），也**不写业务目标**——目标是 `> 目标：` 那一行。',
    `- 写：\`puzzle_mode{op:'main', section:'workflow', content:'### 名字\\n1. 步骤一\\n2. 步骤二'}\`（追加；\`append:false\` 覆盖整节）。删整条 / 恢复 / 永久删除走面板，或 \`op:'workflow'\`。`,
    '- 每次 `op:read` 的返回里都带 `workflow` 数组（每项是 `{name, steps}`）——**它是当前生效的流程，必须遵守**；改工作流前先问用户。',
    '',
    '### 项目健康性（五维）',
    `- 每个模块文档的 \`${HEALTH_HEADING}\` 里记五维，**每一维 0-100、越高越好**：${DIMENSION_LINE}。`,
    '- 写法：`任务复杂度: 80`（一行一维，维度名用上面的名字）。**维护系数高分 = 维护负担轻**；若你想写成本，写成 `维护成本: 30` 也会被自动翻成 `维护系数: 70`。',
    '- **没写就用文档内容推导**：有 `## 要点` / `## 详细记录` / `## 悬而未决` / `## 已定` 才有分，空文档五维全 0。所以健康性是「文档里有多少证据」，不是印象分——想让它涨，就真的把内容写进去。',
    `- 项目健康性 = 各模块健康性的均值，由宿主汇总，**不要在文档里手写总分**。想看就调 \`puzzle_mode{op:'read'}\` 或看面板。`,
    '- 每轮提问收尾时，顺手把本轮的结论落到对应维度（例如新定了方案 → 更新模块的 `可拓展性` 与 `## 已定`）。',
    '',
    '### 审查（op:audit）',
    '- 用户问「有什么没完善的 / 可以拓展的 / 这个项目怎么样」，或每过几轮，就调 `puzzle_mode{op:\'audit\'}`：它返回 `fixPlan`（**可执行修复清单**，每条带 `key`）、`findings`（客观发现，带 level/scope/fact/fix）、`ranking`（**按真实值**升序）、`evidenceTable`（证据去重表，`reasons` 里的 `evidence:[下标]` 指它）。审查指令**就在本节**（返回里默认不回吐，要原文给 `verbose:true`）。',
    '- **返回体积纪律（写代码时守住）**：写操作只回**回执**（改了什么 + 全局几个数），不回吐整份状态——实测回吐 7026 字符而回执 1192（省 83%）。同一批事实**不许在每个模块下各存一份**：证据句要抽成 `evidenceTable` 去重（实测 114 次出现、仅 12 条唯一）。固定说明放提示段（缓存友好），别塞进每次返回。判据：返回体积应当 ∝ **本次改变了什么**，而不是 ∝ **项目有多大**。',
    '- **审查是执行方，不是评论员**：产出是「改哪个文件、怎么改、预期效果」的清单。插件给的 `fixPlan` 覆盖文档与结构问题；**漏洞与冗余**体检读不到函数体语义，要你读源码后补，并用 `additions` **回传**（每条 `文件:行` + fact/fix/expect，缺一退回）——不回传它们就进不了清单，复测也无从核对。改完重跑时带 `previousKeys`，看 `recheck.resolved` / `remaining`。',
    '- **动手边界（硬规则）**：先给用户看清单 → 用 `ask_user_question` 问「哪些现在就改」→ **用户点了才改源码** → 改完**必须重跑一次 `op:audit` 复测**，没消失就说没消失。审查轮本身不改源码。',
    '- 允许直说：完成度写满而要点为空，就是「在装样子」；手写高分而证据 0 条，就是「自己封的分」。只要事实对得上，就不要和稀泥。',
    '- 禁止空话：「整体不错」「建议持续完善」「保持当前节奏」这类一律不要。最后一句说清**现在最该补的一件事**。',
    `- **条目级发现优先**：\`entry_issue:*\` / \`main_entry_issue:*\` 说明条目本身不合规格（超字数上限——**随项目规模变**，以 \`op:read\` 的 \`limits\` 为准；或缺 \`（源码: …）\`）。这类必须先清，它们让「条数很多」变成假象。`,
    '',
    '### 文档格式版本（puzzle）',
    `- 主文档 front-matter 的 puzzle: 是**文档格式版本**（当前 ${PUZZLE_VERSION}）。op:read 返回的 outdated: true 表示这份文档是旧格式。`,
    '- 旧格式要迁移：调 puzzle_mode 的 op:rebuild 先看预览（**默认 dry-run**，逐文件列出将要改什么），确认后再 apply:true 落盘。面板的「迁移/重构」按钮会把整套提示词填进输入框。',
    '- 重建**只改形状**（front-matter 字段、缺失的小节、拆 悬而未决/已定），**正文一字不动**；唯一"造内容"的地方是把旧完成度折算成五维起点，且只填拿不到证据的维度。',
    '- **迁移不追溯老条目**：已经写下的超长 / 无出处条目不会被 rebuild 清理，只能由你按规格**逐节重写**（`append:false`）。用户点「迁移/重构」时要两件都做：先 rebuild 落盘，再重写正文，最后再跑一次 op:audit 确认条目级发现清零。',
    '- **本项目不自动备份**：工作区通常在 git 里，但若不在，先自行备份再 apply:true。',

    '### 会话与多绑定（v7）',
    `- **一个会话可以同时绑多个项目**。主文档 front-matter 的 \`${SESSION_FIELD}:\` 是「绑了哪些」，\`${CURRENT_SESSION_FIELD}:\` 是「当前是哪个」（不变量：当前 ⊆ 绑定）。`,
    '- 工具不给 `project` 时落在**当前项目**；看全部绑定用 `puzzle_mode{op:\'bindings\'}`（返回每个绑定的模式与健康性 + `currentProject`）。',
    '- 三者分工别混：`op:bind` = **替换全部绑定**（「就绑这一个」）；`op:current` = 在已绑的之间**只换当前**；追加第二个绑定走面板的「＋ 绑定项目」。`op:unbind` 带 `project` 只解那一个，不带则全解。',
    `- **多绑定联动**：\`${MODE_PUZZLE_ONLY}\` 拦截按**全部绑定里最严的那个**算——只要有一个绑定的项目是只拼不写，写动作就被拦（不是只看当前项目）。工作流触发按**命中的项目**各自注入，注入时会点名属于哪个项目。`,
    `- 绑定超过 ${BINDING_WARN_THRESHOLD} 个只提醒、不阻断：绑定是用户的意图，插件不替他设硬上限。`,
    '',
    '### 三种执行模式',
    `- **${MODE_PUZZLE_ONLY}**：只提问 + 更新文档；不执行任何动作（越权工具会被宿主 deny，错误里会说明原因）。`,
    `- **${MODE_PUZZLE_AFTER}**：可以动手，但**一轮做完才问**——把这一轮改完、再一起汇报与提问（这是旧的「${MODE_PUZZLE_WRITE}」改名而来）。`,
    `- **${MODE_PUZZLE_WRITE}**：可以动手，但**每个写动作之前先问**——动 write / edit / bash 等会改变世界的工具之前，先用 ask_user_question 说清「要改哪个文件、改成什么」，用户点头才动手；一次点头只覆盖它对应的那个动作。`,
    `- 当前模式由 \`puzzle_mode{op:'read'}\` 返回的 \`mode\` / \`canExecute\` 给出，每次动手前先看它；模式只允许 \`${MODES.join('` / `')}\`。`,
    `- 模式名在文档格式 v${MODE_RENAME_VERSION} 改过含义：v4 及更早的 \`${MODE_PUZZLE_WRITE}\` 一律按 \`${MODE_PUZZLE_AFTER}\` 读（迁移会改写落盘），别把它当成高强度模式。`,
    '',
    `**重复思考熔断**：同一个工具**连续 ${LOOP_REPEAT_THRESHOLD} 次**用同样的参数调用，宿主会注入一条提示把你推出去。看到那条提示就**换输入 / 换动作 / 直接下结论**，别原样再调一次。判定由 hook 做（不依赖模型自觉），这条只是第二道。`,
    `**它不是只报一次**：如果你没换动作，每再重复 ${LOOP_ESCALATE_EVERY} 次会**再报一次**，第二次起文案会变硬——撤掉「把问题抛回用户」这条出路，要求你**先捋清已有事实、再基于事实下结论**。所以看到第二次提醒时不要试图问用户，那正是它要拦的行为。`,
    '',
    '### 说话与干活',
    '- **一律用中文**：正文、结论、工具参数说明、代码注释都写中文。英文只留给标识符、路径、命令与报错原文——**不要**用英文整段陈述。',
    '- **同一件事只说一遍**：结论写完就往下走，不要换个说法再讲一次。反复重述同一个意思（尤其连续几轮都在讲「我准备要做什么」）是纯成本，用户看得见。',
    '- 每轮开头不要复述上一轮已经说过的内容；直接给**这一轮的新结论或新动作**。',
    `- **读文件一次读全**：\`read\` 把 \`limit\` 给足（整份读完，或一次读到你真正要的范围），**不要一段一段读同一个文件**。要看好几个文件就**同一步里并行发多个 \`read\`**，别串着等。`,
    `- **每 ${NUDGE_EVERY} 步会被催一次**：不管这几步在干什么（读、写、跑命令都算），每 ${NUDGE_EVERY} 次工具调用宿主就注入一条催促——**一句话报进度 + 直接做下一步**。这是纯节拍，不是「你哪里做错了」。`,
    `- 这几步**全是只读**（read / grep / glob）、一行产出都没有时，催促会逐次变硬：第 2 档**不许再调只读工具**，第 3 档只留「写结论 + 执行下一步」。同一个文件被读第二次也会被单独点名为「分段读」。`,
    '- 看到催促不要解释、不要道歉：**直接报进度并动手**。它要的是下一步动作，不是一段说明。',
    '',
    '若本会话被压缩成 checkpoint，checkpoint 的 `## Critical Context` 必须原样保留本节规则。',
].join('\n')

/* --------------------------------- 会话与项目定位 --------------------------------- */

/**
 * 造「你正在做的事有对应的工作流」那条上下文（`tools/post-execute` 用）。
 *
 * 为什么**原文照抄步骤**而不做摘要：工作流是用户/模型自己写的流程，摘要等于二次创作，
 * 一旦摘歪了，模型照着错流程做比不知道更糟。这里只加一个抬头说明「为什么现在给你看」。
 *
 * 为什么**不落盘、只注入上下文**：它是一次性的提醒，不是文档内容。
 * 写进文档会污染条目规格（条目要带出处、有字数上限），而它不是事实陈述。
 */
function workflowTriggerText(project, blocks, multi = false) {
  const lines = [
    '【拼图模式 · 工作流触发】',
    '',
    `你刚才这次工具调用命中了项目「${project}」的 ${blocks.length} 条工作流。`,
  ]
  // 多绑定时额外点名「这是哪个项目的流程」：不说的话，模型会把 A 项目的流程
  // 套到 B 项目的文件上——两份流程混着读，比不注入更糟。
  if (multi) {
    lines.push('', `⚠️ 本会话同时绑了多个项目，这段流程**只属于「${project}」**，别套到别的项目上。`)
  }
  lines.push('**请按它的步骤做**（这是这个项目自己定的流程）：')
  for (const block of blocks) {
    lines.push('', `### ${block.name}`, ...block.steps.map((step, index) => `${index + 1}. ${step}`))
  }
  return lines.join('\n')
}

/**
 * 取会话工作目录。
 *
 * 返回 `source` 是刻意的：拿不到会话 cwd 时会退回进程工作目录（可能是 `/root`），
 * 那是「文档可能写错地方」的信号，必须让模型和 UI 都能看见，而不是静默发生。
 */
function sessionCwd(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions !== undefined && typeof sessionId === 'string' && sessionId !== '') {
    try {
      const live = sessions.get(sessionId)
      const cwd = live !== undefined && live !== null && live.header !== undefined ? live.header.cwd : undefined
      if (typeof cwd === 'string' && cwd !== '') return { cwd, source: 'session' }
    } catch (_error) {
      /* 会话已不在内存里：退回进程工作目录，但要标出来 */
    }
  }
  try {
    return { cwd: process.cwd(), source: 'process' }
  } catch (_error) {
    return { cwd: '/', source: 'fallback' }
  }
}

/**
 * 定位本次调用要操作的项目。解析顺序**只有三步**：
 *   显式给了 project → 用它（source: 'explicit'，不存在也算显式，如实回报未初始化）；
 *   否则本会话绑定的项目 → 用它（source: 'bound'）；
 *   否则 → **空**（source: 'none'，project 为 ''）。
 *
 * 「空」是刻意的：不再回退「项目根下最新的那个」。那条回退会把新会话塞进上一个会话的项目，
 * 越写越混——这正是「一个会话只绑一个项目」要根治的问题。
 *
 * v7 起一个会话可绑多个项目，但**这一步仍然只答一个问题**：「工具不给 project 时落到哪」。
 * 答案仍是唯一的一个（`当前会话:` 标出来的那个），所以本函数不变——
 * 多出来的「还绑着谁」由 `located` 附在返回里，与「落在哪」是两件事。
 */
function locate(projectRoot, sessionId, requested) {
  const slug = typeof requested === 'string' && requested.trim() !== '' ? slugify(requested) : null
  if (slug !== null) {
    return { project: slug, source: 'explicit', exists: listProjects(projectRoot).some((item) => item.name === slug) }
  }
  const bound = boundProject(projectRoot, sessionId)
  if (bound !== null) return { project: bound, source: 'bound', exists: true }
  return { project: '', source: 'none', exists: false }
}

/** 把定位结果并进返回，让「用的是哪个项目、项目根从哪来」始终可见。 */
function located(ctx, sessionId, requested) {
  const resolved = sessionCwd(ctx, sessionId)
  const where = locate(resolved.cwd, sessionId, requested)
  // 本会话绑定的**全部**项目（当前项目排第一）。模型靠它知道「除了当前这个，还绑着谁」，
  // 不用先 op:bindings 再猜——每次返回都带，是因为「我绑了几个项目」这件事
  // 会影响它怎么规划（要不要切、改的文件属于哪个项目）。
  const boundAll = boundProjects(resolved.cwd, sessionId)
  const extra = {
    projectRoot: resolved.cwd,
    cwdSource: resolved.source,
    projectRequested: where.project,
    projectSource: where.source,
    // 只有多绑定时才带这两个字段：单绑定 / 未绑定时它等于 `[project]`，
    // 每次返回都重复一遍纯属噪音（这条返回在**每次工具调用**上都在）。
    //
    // 字段名刻意**不叫 `bindings`**：`op:bindings` 那个返回里 `bindings` 是**对象数组**
    // （带健康性/模式），这里是**名字数组**。同名不同形会让「谁盖谁」变成隐蔽 bug——
    // 实测踩过一次（`...extra` 放后面，把对象数组盖成了 `[undefined, undefined]`）。
    ...(boundAll.length > 1 ? { boundProjects: boundAll, currentProject: boundAll[0] } : {}),
    // 首轮自动判定的诊断要用它：`summarize` 据此回报「本会话注入了没」。
    sessionId: typeof sessionId === 'string' ? sessionId : '',
  }
  if (resolved.source !== 'session') {
    extra.hint = `拿不到会话工作目录，已退回进程目录 ${resolved.cwd}——文档可能写到了这里而不是你的工作区。请确认项目根。`
  } else if (where.source === 'none') {
    extra.hint = '本会话还没绑定拼图项目（新会话默认空，不会自动占用别人的项目）。'
      + '新建：op:init 并显式给 project 与 modules，一次把工作区文件夹、主文档与每个模块文档都建出来；'
      + '已有项目：op:bind 并给 project；也可以直接在面板里建项目或绑定。'
  } else if (boundAll.length > 1) {
    extra.hint = `本会话绑了 ${boundAll.length} 个项目（当前是「${boundAll[0]}」）。`
      + '不给 project 就落在当前项目；要换当前用 op:current 并给 project。'
  }
  return { project: where.project, projectRoot: resolved.cwd, extra }
}

/* --------------------------------- 工具 --------------------------------- */

const TOOL_DESCRIPTION = [
  '拼图模式：把项目拆成主文档 + 模块文档，用提问把不确定项变成已定项。',
  'op=list 列出现有项目；op=scan 列出**工作区里还没有拼图文档**的顶层目录（建文档前的候选）；op=read 读状态（带 brief:true 是精简档）；op=show 读某个模块文档的详情；op=main-doc 读主文档全文（只读）；op=init 一次创建主文档与每个模块一份文档；op=bind 绑定已有项目（**替换全部绑定**）；op=bindings 列出本会话绑定的全部项目与当前项目；op=unbind 解绑本会话（带 project 只解那一个，不带则全解）；op=current 在已绑项目间切换当前项目；op=rebuild 重建/迁移文档格式（默认 dry-run；all:true 遍历本会话**全部绑定**）；op=main 更新主文档五节之一；op=module 更新（必要时创建）模块文档；op=workflow 删整条/恢复/永久删除归档（可回滚）；op=health 写五维健康性；op=audit 审查（返回**可执行修复清单** fixPlan + 五维**真实值**与源码体检，见下）；op=source 记/查源码根；op=mode 切换执行模式。',
  `**主文档只有五节**：${SECTION_ORDER.map((key) => SECTION_HEADINGS[key]).join(' / ')}——除这五节外禁止写任何内容。`,
  `条目格式固定为「一句话（源码: 文件:行）」，查找方向是 主文档 → 源码；限长**随项目规模（小 / 中 / 大）变**，以 \`op:read\` / \`op:size\` 返回的 \`limits\` 为准（出处不占额度，超了报错不截断）。`,
  `条数与字数的上限**随项目规模（小 / 中 / 大）变化**：动手写之前看 op:read / op:size 返回里的 \`limits\`（那是这个项目当前的真实上限），或看 \`## 规模\` 说明。超条数上限时写入自动删最旧（每条工作流是一整块流水线，被顶掉的是整条）。`,
  `**## 工作流**是主文档第五节的**标准化流水线**：为完成某个特定任务，把重复的步骤、工具、规则**按顺序**串成一条可复用的路。一条 = 一个 \`### 名字\`（≤${WORKFLOW_NAME_LIMIT} 字）块，块内逐行是步骤（≤${WORKFLOW_MAX_STEPS} 步、每步 ≤${WORKFLOW_STEP_LIMIT} 字）。**每条工作流是并列的一条独立的路，两条之间不应有依赖**；要改一条就**改那一块**，不要新加一条。**步骤超限是报错而不是删步骤**（一条有序的路少一步就断了）。op:read 每次返回都带 \`workflow\` 数组（每项 \`{name, steps}\`），那是当前生效的流程。删整条进归档、可 \`op:workflow action:restore\` 恢复、\`action:drop\` 永久删除；面板上也能删/恢复/永久删。`,
  `文档格式有版本号（当前 puzzle: ${PUZZLE_VERSION}）。op=read 里 \`outdated: true\` 表示这份文档是旧格式，用 \`op=rebuild\` 迁移——它默认只给预览，加 apply:true 才落盘（本项目不自动备份）。`,
  'op=audit 审查：**审查是执行方，不是评论员**。返回 `fixPlan`（可执行修复清单：文件:行 + 现状事实 + 具体改法 + 预期效果 + `key`）、五维真实值、`inflation` 虚高清单、`ranking`（**按真实值**升序）、源码体检事实、findings 与 prompt。清单里 `structure` / `doc` / `health` 由插件算；**`vulnerability`（漏洞）与 `redundancy`（冗余）插件测不出来**（体检读不到函数体语义），要你读源码后补，并用 `additions` **回传**——插件校验后合并进 `fixPlan`，于是它们真的进清单、真的能复测。改完重跑时把上一轮各条的 `key` 用 `previousKeys` 传回，返回 `recheck.resolved` / `recheck.remaining` 告诉你哪条消失了、哪条还在。**动手边界**：先把清单给用户看并用 ask_user_question 问「哪些现在就改」，用户点了才改源码，改完必须重跑一次 op:audit 复测。',
  `**一个会话可以同时绑多个项目**（v7）：不给 project 时用**当前项目**（主文档 \`${CURRENT_SESSION_FIELD}:\` 标出的那个，通常是最近绑/切的那个）；没绑定就是空（projectSource: none），不会自动占用别的项目。看全部绑定用 op:bindings，在已绑的之间换当前用 op:current（只切、不动绑定集合），op:bind 是**替换全部绑定**（要追加第二个绑定走面板的「＋ 绑定项目」）。**多绑定联动**：只拼不写拦截按全部绑定里最严的那个算，工作流触发按命中的项目各自注入。绑定超过 ${BINDING_WARN_THRESHOLD} 个只提醒、不阻断。`,
  `项目健康性由五维决定：${HEALTH_DIMENSIONS.map((d) => d.name).join(' / ')}，每维 0-100、**越高越好**（维护系数高分 = 维护负担轻）。`,
  '写法：在模块文档的 `## 健康性` 里一行一维，如 `任务复杂度: 80`；不写则由文档内容推导（空文档全 0）。项目健康性 = 各模块均值，不要手写总分（主文档也没地方写）。',
  '**拼图文档一律不得用其他工具改动**：write / edit / str_replace_editor 只要目标是 `' + PUZZLE_DIR + '/` 下的文件就会被宿主拒绝（所有模式生效）；只读请用 read / grep / op:show。',
  `每次调用返回都带 askPause:true——**每一次提问的最后都要问「${PAUSE_QUESTION}」，两个选项：${PAUSE_OPTIONS.join(' / ')}**；用户选第一项时只回写文档并结束本轮，不执行任何动作。`,
  `当前模式见返回的 mode/canExecute：${MODE_PUZZLE_ONLY} 只提问与更新文档（越权工具会被 deny）；${MODE_PUZZLE_AFTER} 可执行且一轮做完才问；${MODE_PUZZLE_WRITE} 可执行且每个写动作前先问。`,
  // 跨插件分工（与 dsh-infinite-gen-5 同装时生效）：把「谁在什么场景下说了算」写成
  // 可判规则，免得两份载荷各说一套。数值与对方 data/arbitration.mjs 一致，
  // 由 compat.json + tools/verify-cross-plugin.mjs 双向核对。
  `跨插件分工（与 dsh-infinite-gen-5 同装时生效；本段 order ${ORDER}，早于它的末位锚点 10150）：**交付物内容与形态**（写什么、给多少、四态、可跑件）归无限五代；**拼图文档与采访节奏**（主文档 / 模块文档、首轮采访、审查清单）归本插件——两域不重叠，各管各的。`,
  '整批题在场时（题库 / `[qNNN]` 清单 / 编号 ≥20 条）本插件**不做打断者**：批量交付优先，不采访、不回问、不中停；拼图文档只在该轮结束后**幂等回写**，不得把交付切成两半。',
  `提问额度按轮的**实际目的**取：采访轮与审查确认轮用本插件的额度（≤${ASK_MAX_QUESTIONS} 问、每题 3–6 岔路 + 固定收尾问）；其余场景按无限五代的口径（同一轮最多一问、2–5 个互斥选项）。用户说「别问 / 自己定」时全局静默，本插件的固定收尾问也不问。`,
  '用户选「停下」时**只停动作**：本轮不执行写动作、立即结束，但已交付的产物、结论与拍板**不回退**（无限五代的长程规则不被它触发）。',
  '**拼图文档只走 puzzle_mode**（write / edit 指向拼图目录会被宿主拒）；其它工具的结构化参数（如审查回传的 additions）按各自 schema 给——无限五代的「参数扁平」只约束自造载荷，不改别人的 schema。',
  'op=settings 是**按会话**开关：`disabled:true` 让**调用它的这个会话**不再注入拼图规则、也不再拦工具（下一轮立即生效），其余会话照旧；`disabled:false` 恢复本会话；不给参数只查询本会话状态。它存在 DSH_HOME 下，跨项目一致。',
].join('\n')

/**
 * 关掉固定收尾问之后的提示段正文。
 *
 * 做法是**从 POLICY_BODY 派生**，而不是再手抄一份：
 * 两份正文只在「收尾问」那几行上不同，抄一份出来必然漂移——本仓记过
 * 「同一套文案多处各写一份会漂移」，提示段尤其致命（模型读到的规则两说并存）。
 *
 * 替换是**按整行精确匹配**（`^...$` 多行），不是子串替换：子串替换会误伤正文里
 * 提到同一句话的其它行（比如「用户说『别问』时收尾问也不问」那条），
 * 而那些行在关掉之后**仍然是对的**，不该被改。
 */
const POLICY_BODY_NO_PAUSE = POLICY_BODY
  .split('\n')
  .map((line) => {
    if (line === `- 固定收尾问「${PAUSE_QUESTION}」同样是提问，同样走 \`ask_user_question\`。`) {
      return '- 固定收尾问已**全局关闭**（用户设置）：不要再问「' + PAUSE_QUESTION + '」，也不要自己造一个类似的收尾问。'
    }
    if (line === '- ' + PAUSE_LINE) {
      return '- 提问到**实质问题问完就结束**，不要再追加一轮「要不要停下」；用户想停会自己说。'
    }
    if (line === `每次调用返回都带 askPause:true——**每一次提问的最后都要问「${PAUSE_QUESTION}」，两个选项：${PAUSE_OPTIONS.join(' / ')}**；用户选第一项时只回写文档并结束本轮，不执行任何动作。`) {
      return '每次调用返回里的 `askPause` 是**当前开关状态**：现在是 `false`——**提问不要带固定收尾问**。'
    }
    return line
  })
  .join('\n')

function failure(error, hint) {
  return { ok: false, error, hint }
}

export function apply(ctx) {
  // `text` 传**函数**（不是调用结果）：宿主 assemble 时按会话求值，
  // 被禁用的新会话拿到空串，空 section 会被宿主丢掉，等于没注入。
  ctx.systemPrompt.section({ name: SECTION_NAME, order: ORDER, text: policyText })

  ctx.tools.register(defineTool({
    name: 'puzzle_mode',
    description: TOOL_DESCRIPTION,
    parameters: {
      op: {
        type: 'string',
        required: true,
        description: 'list 列项目 / read 读状态 / show 读模块详情 / main-doc 读主文档全文（只读，供面板）/ init 新建项目（并绑定本会话）/ bind 绑定已有项目（替换全部绑定）/ bindings 列出本会话全部绑定与当前项目 / unbind 解绑本会话（带 project 只解一个）/ current 切换当前项目 / rebuild 重建文档格式（默认 dry-run）/ main 主文档小节 / module 模块文档小节 / health 写五维健康性 / workflow 删整条/恢复/永久删除归档（可回滚）/ audit 按五维审查并出可执行修复清单 / mode 切换模式',
        enum: OPS,
      },
      project: { type: 'string', description: '项目名；省略时用本会话绑定的项目（没绑定就是空）。init 要求显式给（它会成为工作区里的文件夹名），bind 必须给' },
      goal: { type: 'string', description: 'init：这个项目要达成什么（一句话）' },
      modules: {
        type: 'array',
        description: 'init：要同时创建的模块名列表（每个模块一份文档）',
        items: { type: 'string' },
      },
      section: { type: 'string', description: `main：${SECTION_ORDER.join('/')}（主文档只有这五节）；module：${MODULE_SECTION_KEYS.join('/')}` },
      name: { type: 'string', description: 'module / show：模块名（module 时不存在则创建）' },
      content: { type: 'string', description: `要写入的正文（markdown 片段）；health 时为 \`维度名: 0-100\` 若干行。**条目式**小节（${SECTION_ORDER.filter((key) => key !== 'workflow').join('/')}）每条必须是「一句话（源码: 文件:行）」；**字数上限随项目规模（小 / 中 / 大）变**，以 \`op:read\` / \`op:size\` 返回的 \`limits\` 为准（模块索引不要求出处）。**${SECTION_HEADINGS.workflow} 不是条目式**：它是 \`### 名字\`（≤${WORKFLOW_NAME_LIMIT} 字）+ 有序步骤（≤${WORKFLOW_MAX_STEPS} 步、每步 ≤${WORKFLOW_STEP_LIMIT} 字，这两个数与规模无关），**不要求出处**，别拿条目的字数上限去砍合法步骤。超了报错不截断` },
      append: { type: 'boolean', description: 'true 追加到小节末尾，false 覆盖该小节；默认追加' },
      apply: { type: 'boolean', description: 'rebuild：true 才落盘；不给或 false 只给预览（dry-run）' },
      all: { type: 'boolean', description: 'rebuild：true = 作用于本会话**全部绑定**的项目（多绑定时迁移是全局动作）；不给只作用于当前项目' },
      brief: { type: 'boolean', description: 'read：true 返回接续会话用的精简档（去掉每模块五维明细与五维说明表，附 readNext 指路），省上下文；默认 false 给全量' },
      source: { type: 'boolean', description: 'audit：默认 true，把源码体检（文件行数 / 最长函数 / 目录分层）算进五维真实值与修复清单；项目还没代码时给 false 跳过' },
      path: { type: 'string', description: 'source：源码根目录的绝对路径（写进主文档 front-matter 的 源码根:）。传空串清掉。' },
      sourceRoot: { type: 'string', description: 'audit：源码根目录的绝对路径。默认取「拼图目录的上一级」，但文档目录与源码目录常常不在一处（例如文档在 /sdcard/…/<项目>/拼图/、源码在 /root/.dsh/plugin-src/<包名>/），这时必须显式给，否则查不到源码' },
      additions: {
        type: 'array',
        description: 'audit：模型读源码后自补的 vulnerability / redundancy 条目，插件校验后合并进 fixPlan 并参与复测。每条要 kind（vulnerability/redundancy）、severity（high/medium/low）、target（**必须带行号**，如 lib/source.js:136）、fact、fix、expect；缺一即整条退回（rejected 里给原因）',
        items: {
          type: 'object',
          // dsh-tools 的 schema 编译器要求显式声明；缺了会**拒绝注册整个工具**
          // （实测报 UNSUPPORTED_SCHEMA: additionalProperties must be explicitly true or false）。
          additionalProperties: false,
          properties: {
            kind: { type: 'string', description: 'vulnerability（漏洞）或 redundancy（冗余）' },
            severity: { type: 'string', description: 'high / medium / low' },
            target: { type: 'string', description: '文件:行，例如 lib/source.js:136' },
            fact: { type: 'string', description: '现状事实（带数字）' },
            fix: { type: 'string', description: '具体改法（动哪个函数、加什么守卫）' },
            expect: { type: 'string', description: '预期效果' },
          },
        },
      },
      verbose: { type: 'boolean', description: 'audit：true 时把完整的审查指令原文也放进返回（默认不回吐——同一套规则已在提示段里，见 promptIn）' },
      previousKeys: {
        type: 'array',
        description: 'audit：复测用——把上一轮 fixPlan 里各条的 key 原样传回来，返回的 recheck 会分出已消失（resolved）与仍在（remaining）',
        items: { type: 'string' },
      },
      mode: { type: 'string', description: `mode：${MODES.join(' / ')}`, enum: MODES },
      action: { type: 'string', description: 'workflow：remove 删掉整条工作流（进归档，可恢复）/ restore 把归档里第 index 条整条恢复 / drop 把归档里第 index 条永久删除（不可恢复）', enum: ['remove', 'restore', 'drop'] },
      index: { type: 'number', description: 'workflow：1 起的序号（remove 指工作流里的第几条；restore / drop 指归档里的第几条）' },
      expected: { type: 'string', description: 'workflow remove：你看到的**那条工作流的名字**（身份校验）。带上它可防止列表过期时误删：与当前第 index 条的名字不一致就直接拒绝' },
      disabled: { type: 'boolean', description: 'settings：true = 禁用**本会话**的拼图模式（下一轮立即生效）；false = 恢复本会话。不给则只查询当前状态' },
      askPause: {
        type: 'boolean',
        description: 'settings：true = 每轮提问末尾带固定收尾问「' + PAUSE_QUESTION + '」（默认）；'
          + 'false = **全局**关掉它（写进 DSH_HOME，跨会话跨项目一致）。不给则只查询当前状态',
      },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      const sessionId = exec !== undefined && exec.agent !== undefined && exec.agent !== null && exec.agent.session !== undefined
        ? exec.agent.session.id
        : undefined
      const resolved = located(ctx, sessionId, args.project)
      const projectRoot = resolved.projectRoot
      const project = resolved.project
      const append = args.append !== false

      if (args.op === 'list') {
        return summarizeList(projectRoot, projectSummaries(projectRoot))
      }

      if (args.op === 'scan') {
        /**
         * 列出工作区里**还没有拼图文档**的顶层目录（用户需求 v0.21.0：
         * 「自动判断此会话是否有多个项目」）。
         *
         * 为什么要有它：模型看不到真实文件树时只能凭项目名猜，而「该给哪几个目录
         * 建文档」是个客观事实。宿主扫一次、连证据（目录里前几个文件名）一起给，
         * 模型据此 op:init 才是确定的。面板的空态也走这条路。
         */
        const candidates = scanUnpuzzled(projectRoot)
        return {
          ...resolved.extra,
          ok: true,
          projectRoot,
          candidates,
          candidateCount: candidates.length,
          alreadyPuzzled: listProjects(projectRoot).map((item) => item.name),
          hint: candidates.length === 0
            ? '工作区里每个顶层目录都已经有拼图文档了。'
            : `扫到 ${candidates.length} 个还没有拼图文档的目录。要给某几个建文档，就分别 op:init；`
              + '一次建多个时**最后一个成为当前项目**，其余照旧绑着（op:init 是追加绑定）。',
          ...pauseFields(),
        }
      }

      // read / audit / init / bind / settings 自己处理「没绑定」，其余写操作必须先有项目。
      // settings 按**会话**判定、与项目无关，所以也必须放行：否则「刚新建、还没绑定
      // 任何项目」的会话会被下面这句挡住，而它恰恰是最想关掉拼图模式的场景。
      if (project === '' && !['read', 'scan', 'audit', 'init', 'bind', 'bindings', 'unbind', 'current', 'settings', 'main-doc', 'workflow'].includes(args.op)) {
        return failure('本会话还没绑定拼图项目', `先用 op:init 建一个（显式给 project 与 modules），或用 op:bind 绑已有项目；当前 op=${args.op} 需要项目`)
      }

      if (args.op === 'read') {
        // `brief:true` 是接续会话用的精简档：新会话不必把六个模块的五维明细全拉进上下文。
        return summarize(readState(projectRoot, project), resolved.extra, args.brief === true)
      }

      if (args.op === 'main-doc') {
        // 主文档全文：**只读**。面板的「主文档」入口走 RPC 的 `main`，
        // 这个 op 是给模型用的（例如用户贴了一段主文档要对照时，不必猜路径去 read）。
        const doc = readMainDoc(projectRoot, project)
        if (doc.ok !== true) return failure(doc.error, doc.hint)
        return {
          ok: true,
          project,
          mainDoc: doc.mainDoc,
          text: doc.text,
          workflow: doc.workflow,
          workflowArchive: doc.workflowArchive,
          version: doc.version,
          outdated: doc.outdated,
          hint: '这是主文档**原文**（只读）。改它请用 op:main（五节之一），不要用 write / edit。',
          ...resolved.extra,
          ...pauseFields(),
        }
      }

      if (args.op === 'workflow') {
        // 删整条 / 恢复整条 / 永久删除归档项：这是「一键删除（可回滚）」的模型侧入口。
        // 面板走 RPC 的同名 method，两者共用 project.js 里的同一份实现。
        if (args.action !== 'remove' && args.action !== 'restore' && args.action !== 'drop') {
          return failure(`未知 action ${String(args.action)}`, '可用：remove（删整条工作流，进归档）/ restore（把归档第 index 条整条恢复）/ drop（把归档第 index 条永久删除）')
        }
        const done = args.action === 'remove'
          ? removeWorkflowItem(projectRoot, project, args.index, args.expected)
          : args.action === 'restore'
            ? restoreWorkflowItem(projectRoot, project, args.index)
            : dropWorkflowArchiveItem(projectRoot, project, args.index)
        if (done.ok !== true) return failure(done.error, done.hint)
        return {
          ...receipt(readState(projectRoot, project), resolved.extra),
          action: args.action,
          changed: done.changed,
          evicted: done.evicted ?? [],
          evictedRecoverable: done.evictedRecoverable === true,
          workflow: done.workflow,
          workflowArchive: done.workflowArchive,
          hint: args.action === 'remove'
            ? '已删掉整条工作流并进归档；要撤销就 action:restore 同序号（归档是 1 起的）。'
            : args.action === 'drop'
              ? '已从归档永久删除，不可恢复。'
              : (done.evicted ?? []).length > 0
                ? '已恢复。工作流原本已满，最旧的一条被挤回**归档**（不是丢掉），可在归档里再恢复。'
                : '已恢复到工作流。',
        }
      }

      if (args.op === 'show') {
        if (typeof args.name !== 'string' || args.name === '') return failure('缺少 name', '给出模块名，例如 auth-flow')
        const detail = readModuleDetail(projectRoot, project, args.name)
        if (detail.ok !== true) return failure(detail.error, '检查项目名与模块名')
        return { ...detail, ...resolved.extra, ...pauseFields() }
      }

      if (args.op === 'init') {
        // 没给 project 就用「日期-关键词」兜底，免得因为缺名字而建不出来。
        const name = project !== '' ? project : defaultProjectName(args.goal ?? '')
        const created = createProject(projectRoot, name, args.goal ?? '', args.modules ?? [], DEFAULT_MODE, sessionId ?? '')
        if (created.ok !== true) return failure(created.error, created.hint)
        const rebound = created.rebound === true
        return receipt(readState(projectRoot, created.project), {
          ...resolved.extra,
          // 真实归属：新建时顺带绑了 → bound；项目本来就在、这次没动绑定 → 按实际（通常 none）。
          projectSource: rebound ? 'bound' : 'none',
          created: true,
          mainCreated: created.mainCreated === true,
          createdModules: created.created,
          existingModules: created.existing,
          // **只在新建时**才顺带绑本会话。项目已存在时不动绑定——否则用户刚解绑的会话
          // 会因为一次「确保存在」式的 op:init 被重新绑回去（就是「解绑后又自动绑定」）。
          rebound,
          bound: created.bound === true,
          released: created.released ?? [],
          bindError: created.bindError ?? null,
          hint: rebound
            ? '项目已建好，并已把本会话绑过来（原先绑的项目已解绑）。'
            : '项目已存在：**本次没有改动绑定**。要改绑用 op:bind 并给 project。',
          next: `现在开始一轮提问（最多 ${ASK_MAX_QUESTIONS} 问、每题最多 ${ASK_MAX_OPTIONS} 个选项），并在最后问一次要不要先停下`,
        })
      }

      if (args.op === 'bind') {
        if (project === '') return failure('缺少 project', 'bind 需要给出要绑定的项目名')
        if (typeof sessionId !== 'string' || sessionId === '') {
          return failure('拿不到会话 ID', '绑定是按会话记的，没有会话 ID 无法绑定')
        }
        const bound = bindSession(projectRoot, project, sessionId)
        if (bound.ok !== true) return failure(bound.error, bound.hint)
        return receipt(readState(projectRoot, bound.project), {
          ...resolved.extra,
          projectSource: 'bound',
          bound: true,
          currentProject: bound.project,
          // `op:bind` 是**替换全部**绑定（不是追加）：说清这一点，否则模型会以为
          // 绑第二个项目时第一个还在——那正是「面板 ＋ 才追加」的分工。
          bindings: [bound.project],
          released: bound.released ?? [],
          hint: `已把本会话**只**绑到「${bound.project}」（替换全部绑定，当前项目也是它）。`
            + '要**追加**第二个绑定，用面板的「＋ 绑定项目」；要在这几个之间换当前，用 op:current。',
        })
      }

      if (args.op === 'bindings') {
        // 本会话绑了哪些项目、哪个是当前、各自健康性与模式。
        // 为什么要有这个 op：多绑定后模型**看不到**自己还绑着谁（`op:read` 只答当前项目），
        // 于是「切到另一个项目」只能靠用户口头说。有了它，模型能自己判断该不该切。
        if (typeof sessionId !== 'string' || sessionId === '') {
          return failure('拿不到会话 ID', '绑定是按会话记的，没有会话 ID 查不到绑定')
        }
        const names = boundProjects(projectRoot, sessionId)
        return {
          // ⚠️ `...resolved.extra` 必须放**前面**：它里面也有一个 `bindings`
          // （那是「本会话绑了哪些项目」的名字数组，每次返回都带）。放后面会把这个 op
          // 精心构造的对象数组盖成一串字符串——实测踩过：面板拿到 `[undefined, undefined]`。
          ...resolved.extra,
          ok: true,
          bindings: names.map((name) => {
            const state = readState(projectRoot, name)
            return {
              project: name,
              current: name === names[0],
              mode: state.mode,
              health: state.health,
              moduleCount: state.modules.length,
              initialized: state.initialized === true,
            }
          }),
          currentProject: names.length > 0 ? names[0] : null,
          count: names.length,
          hint: names.length === 0
            ? '本会话还没绑任何项目：op:init 建新的，或 op:bind 绑已有的。'
            : '不给 project 就落在 currentProject；要换当前用 op:current 并给 project。',
          ...pauseFields(),
        }
      }

      if (args.op === 'current') {
        // 切当前项目（**只切，不改绑定集合**）。与 op:bind 分工：bind 是「就绑这一个」
        // （会解绑别处），current 是「在已绑的这几个里换一个当前」。
        if (project === '') return failure('缺少 project', 'current 需要给出要切过去的项目名')
        if (typeof sessionId !== 'string' || sessionId === '') {
          return failure('拿不到会话 ID', '绑定是按会话记的，没有会话 ID 无法切换')
        }
        const moved = setCurrentProject(projectRoot, project, sessionId)
        if (moved.ok !== true) return failure(moved.error, moved.hint)
        return {
          ...receipt(readState(projectRoot, moved.project), {
            ...resolved.extra,
            projectSource: 'bound',
            currentProject: moved.project,
            bindings: boundProjects(projectRoot, sessionId),
            switched: true,
          }),
          hint: `当前项目已切到「${moved.project}」。`,
        }
      }

      if (args.op === 'unbind') {
        if (typeof sessionId !== 'string' || sessionId === '') {
          return failure('拿不到会话 ID', '绑定是按会话记的，没有会话 ID 无法解绑')
        }
        // 面板的每项 `×` 会带 project（只解这一个）；不带就是「全解」。
        // 两者语义不同，所以走两个函数：`unbindOne` 只动一个项目，
        // `unbindSession` 扫全量——把「只解一个」做成扫全量再过滤，会误伤别的项目。
        if (args.project !== undefined && String(args.project).trim() !== '') {
          const one = unbindOne(projectRoot, String(args.project), sessionId)
          if (one.ok !== true) return failure(one.error, one.hint)
          const left = boundProjects(projectRoot, sessionId)
          return receipt(readState(projectRoot, one.current ?? ''), {
            ...resolved.extra,
            projectSource: left.length > 0 ? 'bound' : 'none',
            unbound: true,
            unboundProject: one.project,
            released: [one.project],
            bindings: left,
            currentProject: left.length > 0 ? left[0] : null,
            hint: left.length > 0
              ? `已解绑「${one.project}」；本会话还绑着 ${left.length} 个（当前是「${left[0]}」）。`
              : '已解绑最后一个项目，本会话回到「没绑定」。',
          })
        }
        const cut = unbindSession(projectRoot, sessionId)
        if (cut.ok !== true) return failure(cut.error, cut.hint)
        // 解绑后本会话没有项目，所以返回未初始化的状态——如实回报，不要顺手绑一个。
        return receipt(readState(projectRoot, ''), {
          ...resolved.extra,
          projectSource: 'none',
          unbound: true,
          released: cut.released ?? [],
          bindings: [],
          currentProject: null,
        })
      }

      if (args.op === 'rebuild') {
        // 默认 dry-run：`apply` 不显式给 true 就只报计划。重建会重写 front-matter 与补小节，
        // 本项目不自动备份（工作区通常在 git 里），所以预览就是唯一的刹车。
        //
        // `all:true` = 作用于本会话**全部绑定**（用户需求 v0.21.0：多绑定时迁移是全局动作）。
        // 为什么这是对的：迁移是「把这份文档升到当前格式」，与「我现在在看哪个项目」无关——
        // 多绑几个项目时，只迁当前那个等于留下几个格式不一致的文档，下次打开还要再迁一遍。
        if (args.all === true) {
          if (typeof sessionId !== 'string' || sessionId === '') {
            return failure('拿不到会话 ID', 'all:true 要按会话找全部绑定，没有会话 ID 做不到')
          }
          const names = boundProjects(projectRoot, sessionId)
          if (names.length === 0) return failure('本会话还没绑定拼图项目', '先用 op:init 建一个，或用 op:bind 绑已有项目')
          const results = names.map((name) => {
            const one = rebuildProject(projectRoot, name, args.apply === true)
            return {
              project: name,
              ok: one.ok === true,
              error: one.ok === true ? null : one.error,
              version: one.version,
              targetVersion: one.targetVersion,
              outdated: one.outdated,
              totalChanges: one.totalChanges,
              written: one.written ?? [],
              failed: one.failed ?? [],
            }
          })
          return {
            ...resolved.extra,
            ok: true,
            all: true,
            boundProjects: names,
            applied: args.apply === true,
            results,
            totalChanges: results.reduce((sum, one) => sum + (one.totalChanges ?? 0), 0),
            hint: args.apply === true
              ? `已对全部 ${names.length} 个绑定项目重建；用 op:read 逐个复核。`
              : `这是**全部 ${names.length} 个绑定项目**的预览（dry-run）。确认后加 apply:true 落盘。`,
            ...pauseFields(),
          }
        }
        const result = rebuildProject(projectRoot, project, args.apply === true)
        if (result.ok !== true) return failure(result.error, result.hint)
        return {
          ok: true,
          project: result.project,
          puzzleDir: result.puzzleDir,
          mainDoc: result.mainDoc,
          version: result.version,
          targetVersion: result.targetVersion,
          outdated: result.outdated,
          migrations: result.migrations,
          totalChanges: result.totalChanges,
          applied: result.applied === true,
          written: result.written ?? [],
          failed: result.failed ?? [],
          files: result.files.map((item) => ({
            kind: item.kind,
            name: item.name,
            file: item.file,
            version: item.version,
            changes: item.changes,
            willWrite: item.changes.length > 0 && typeof item.text === "string",
          })),
          hint: result.applied === true
            ? "已重建，用 op:read 复核；正文一字未动，只改了 front-matter 形状与缺失的小节。"
            : "这是预览（dry-run）。确认无误后加 apply:true 落盘；预览与实际落盘做的是同一件事。",
          ...resolved.extra,
          ...pauseFields(),
        }
      }

      if (args.op === 'main') {
        if (typeof args.section !== 'string' || args.section === '') return failure('缺少 section', `可用：${SECTION_ORDER.join(' / ')}（主文档只有这五节）`)
        const result = updateMainSection(projectRoot, project, args.section, args.content ?? '', append)
        if (result.ok !== true) return failure(result.error, result.hint)
        return receipt(readState(projectRoot, project), {
          ...resolved.extra,
          section: args.section,
          entries: result.entries ?? 0,
          // 超上限时如实回报删了几条——与模块侧（op:module）对齐。
          // 少了它，模型写工作流触发「删最旧」时**看不见被删的是哪条**，
          // 只能从返回的 workflow 数组长度间接猜；那是「静默裁剪」，不是「可追溯的裁剪」。
          dropped: Array.isArray(result.dropped) ? result.dropped.length : 0,
          droppedEntries: Array.isArray(result.dropped) ? result.dropped : [],
        })
      }

      if (args.op === 'module') {
        if (typeof args.name !== 'string' || args.name === '') return failure('缺少 name', '给出模块名，例如 auth-flow')
        if (typeof args.section !== 'string' || args.section === '') return failure('缺少 section', `可用：${MODULE_SECTION_KEYS.join(' / ')}`)
        const result = updateModuleSection(projectRoot, project, args.name, args.section, args.content ?? '', append)
        if (result.ok !== true) return failure(result.error, result.hint)
        return receipt(readState(projectRoot, project), {
          ...resolved.extra,
          module: args.name,
          section: args.section,
          created: result.created,
          entries: result.entries ?? 0,
          // 超上限时如实回报删了几条（悬而未决 4 / 已定 10，删最旧）。
          dropped: Array.isArray(result.dropped) ? result.dropped.length : 0,
          droppedEntries: Array.isArray(result.dropped) ? result.dropped : [],
          // ③ 写「已定 / 悬而未决」时回显现有条目：让模型自己判有没有被取代的旧决定。
          // 不做自动判冲突——实测字面算法拿不到可用阈值（真冲突只 1 分），
          // 详见 `conflictDigest` 的注释。
          ...result.conflicts === null || result.conflicts === undefined ? {} : { conflicts: result.conflicts },
        })
      }

      if (args.op === 'health') {
        // 五维只写在模块文档上：项目级健康性由宿主按模块均值汇总，写进文档只会与事实矛盾。
        if (typeof args.name !== 'string' || args.name === '') {
          return failure('health 需要 name', '给出模块名：五维写在模块文档的 ## 健康性 里；项目健康性由宿主按模块均值汇总，不要手写')
        }
        const result = updateModuleSection(projectRoot, project, args.name, 'health', args.content ?? '', append)
        if (result.ok !== true) return failure(result.error, result.hint)
        return receipt(readState(projectRoot, project), { ...resolved.extra, module: args.name, section: 'health', created: result.created })
      }

      if (args.op === 'audit') {
        // 只读：把客观事实摆齐（含**五维真实值**），改值由模型按 prompt 执行。
        // 本插件**不生成评价正文**，也不代改分数——它只回答「真实值是多少、差在哪」。
        const state = readState(projectRoot, project)
        if (state.initialized !== true) {
          return failure('尚无拼图项目', '先用 op:init 建出主文档与模块文档，再审查')
        }
        // 源码体检：审查「真实值」需要它。`source:false` 可跳过（项目还没代码时）。
        // `sourceRoot` 用于「文档目录 ≠ 源码目录」的真实情况（本项目就是如此）。
        const inspection = args.source === false ? null : inspectSource(projectRoot, project, args.sourceRoot ?? '')
        const hasSource = inspection !== null && inspection.ok === true && inspection.fileCount > 0
        // 体检实际存在的源码文件（相对路径）：模块级「测到没测到」要拿它判，
        // 否则「引用了 4 个不存在的文件」也会被当成「源码侧测过、很干净」。
        const existingFiles = hasSource ? (inspection.files ?? []).map((item) => item.name) : []
        // 全局（项目级）：证据取所有模块之和，声明值取各模块声明值的均值。
        const mergedEvidence = {}
        for (const key of ['points', 'detail', 'pending', 'decided', 'shared']) {
          mergedEvidence[key] = state.modules.reduce((sum, module) => sum + ((module.evidence ?? {})[key] ?? 0), 0)
        }
        mergedEvidence.pit = state.sections?.pit ?? 0
        const mergedDeclared = {}
        for (const dimension of HEALTH_DIMENSIONS) {
          const values = state.modules.map((module) => module.healthScores?.[dimension.key]).filter((v) => typeof v === 'number')
          if (values.length > 0) mergedDeclared[dimension.key] = Math.round(values.reduce((a, b) => a + b, 0) / values.length)
        }
        const projectTrue = trueHealthOf({ evidence: mergedEvidence, inspection, declared: mergedDeclared, hasSource })
        // 每个模块各算一份真实值（模块范围）。
        const moduleTruth = state.modules.map((module) => {
          const declared = {}
          for (const dimension of HEALTH_DIMENSIONS) {
            if (module.healthSources?.[dimension.key] === 'module') declared[dimension.key] = module.healthScores[dimension.key]
          }
          const truth = trueHealthOf({
            evidence: module.evidence ?? {},
            inspection,
            declared,
            hasSource,
            files: module.citedFiles ?? [],
            existing: existingFiles,
          })
          return {
            name: module.name,
            declaredHealth: module.health,
            trueHealth: truth.health,
            declared: module.healthScores,
            trueValues: truth.scores,
            reasons: truth.reasons,
          }
        })
        // 虚高清单：模型自评高于真实值的地方，逐条摆出来（这是「虚假提高」的直接证据）。
        const inflation = []
        for (const [key, reason] of Object.entries(projectTrue.reasons)) {
          if (reason.inflation === undefined) continue
          inflation.push({
            scope: 'project',
            dimension: key,
            name: HEALTH_DIMENSIONS.find((d) => d.key === key)?.name ?? key,
            declared: reason.inflation.declared,
            trueValue: reason.inflation.trueValue,
            gap: reason.inflation.gap,
            // 刻意**不再带 `because`**：它逐字等于对应 reasons 里的 verdicts，
            // 一份 43KB 的返回里它是 6712 字符的纯副本（实测）。要看证据去 reasons。
          })
        }
        for (const item of moduleTruth) {
          for (const [key, reason] of Object.entries(item.reasons)) {
            if (reason.inflation === undefined) continue
            inflation.push({
              scope: item.name,
              dimension: key,
              name: HEALTH_DIMENSIONS.find((d) => d.key === key)?.name ?? key,
              declared: reason.inflation.declared,
              trueValue: reason.inflation.trueValue,
              gap: reason.inflation.gap,
              // 同上：不带 `because` 副本。
            })
          }
        }
        // 源码体检的发现并进 findings：这样一份 op:audit 返回里既有文档问题、也有代码问题。
        // 不在 readState 里做体检——`op:read` 每轮都调，不该每次去扫源码树。
        const sourceFindings = hasSource
          ? inspection.findings.map((item) => ({
            id: 'source:' + item.id,
            level: item.level === 'fail' ? 'blocker' : (item.level === 'warn' ? 'warn' : 'info'),
            dimension: item.id === 'source_long_function' ? 'maintenance' : 'extensibility',
            scope: 'project',
            /**
             * `file` **要么是字符串，要么根本不存在**——不能写成 `file: item.file`。
             *
             * `source_flat`（「N 个文件全在同一层目录」）与「另有 N 个函数超长」这两条是
             * **项目级**发现，本来就没有单个文件，`item.file` 是 `undefined`。
             * 无条件赋值会得到一个**显式的** `undefined` 属性，而宿主对工具返回做
             * 「无损 JSON」校验时，显式 `undefined` **无法往返**：
             * `{file: undefined}` → stringify → `{}` → 不等于原值，于是整次调用被判失败——
             * 报 `tool "puzzle_mode" returned invalid output: value is not lossless JSON`。
             * 后果是 **`op:audit` 带源码体检（也就是它的主用法）完全用不了**，
             * 只有显式 `source:false` 能跑。**一次实测踩到的真故障。**
             */
            ...(typeof item.file === 'string' && item.file !== '' ? { file: item.file } : {}),
            fact: item.fact,
            fix: item.fix,
          }))
          : []
        // 最弱一维按**真实值**算：同一份返回里 `ranking` / `trueDimensions` 都是真实值口径，
        // 最弱维却按手写值算的话，三个数字讲三个故事，还会引导模型去修一个已满分的维度。
        const stateFindings = auditOf(state, projectTrue.scores)
        // 清单：插件能测的 + 模型回传的漏洞 / 冗余（后者校验后合并，真的进清单、真的能复测）。
        const planResult = fixPlanOf(state, inspection, args.additions)
        const recheck = recheckPlan(args.previousKeys, planResult.plan)
        /**
         * 证据去重（省 4KB / 81%）：同一句巨函数描述在这份返回里曾出现 39 次，
         * 全部证据句 114 次出现、只有 12 条唯一。这里把它抽成顶部的 `evidenceTable`，
         * `reasons` 各处只留 `evidence: [下标]`。
         * 模型读到的信息**一字不少**——同一句话只说一遍，其余给下标。
         */
        const intern = internEvidence([
          ...Object.values(projectTrue.reasons ?? {}).flatMap((reason) => reason.verdicts ?? []),
          ...moduleTruth.flatMap((item) => Object.values(item.reasons ?? {})
            .flatMap((reason) => reason.verdicts ?? [])),
        ])
        indexVerdicts(projectTrue.reasons, intern)
        for (const item of moduleTruth) indexVerdicts(item.reasons, intern)
        return {
          ok: true,
          /**
           * 证据表：`reasons` / `dimensionReasons` 里的 `evidence: [3,7]`
           * 指的是这张表的下标。**先读表再看下标**，别把下标当分数。
           */
          evidenceTable: intern.table,
          project: state.project,
          projectDir: state.puzzleDir,
          mainDoc: state.mainDoc,
          // 全局范围
          scope: 'project',
          declaredHealth: state.health,
          trueHealth: projectTrue.health,
          declaredDimensions: state.dimensions,
          trueDimensions: projectTrue.scores,
          dimensionMeta: dimensionMeta(),
          // 真实值怎么来的：文档那一侧 vs 源码那一侧（含「没有源码可查」的诚实标注）
          dimensionReasons: projectTrue.reasons,
          ranking: dimensionRanking(projectTrue.scores),
          declaredRanking: dimensionRanking(state.dimensions),
          // 最弱一维（与 ranking 同口径）
          weakest: dimensionRanking(projectTrue.scores)[0] ?? null,
          // 模块范围
          modules: moduleTruth,
          // 虚高清单（模型自评 > 真实值）——审查要据此改值
          inflation,
          // 源码体检原始事实（工程化问题的证据）
          source: hasSource
            ? {
              fileCount: inspection.fileCount,
              totalLines: inspection.totalLines,
              avgLines: inspection.avgLines,
              largest: inspection.largest,
              dirs: inspection.dirs,
              longestFunction: inspection.longestFunction,
              longFunctions: inspection.longFunctions,
              deadExports: inspection.deadExports,
              oversized: inspection.oversized,
              findings: inspection.findings,
            }
            : { skipped: true, note: args.source === false ? '按 source:false 跳过' : '这个项目目录下没有源码文件' },
          findings: [...stateFindings, ...sourceFindings],
          /**
           * 可执行修复清单：审查的**主线产物**（用户裁定：审查要上升到执行方）。
           *
           * 这里把体检结果一起传进去，所以清单里既有文档问题（条目不合规、规范外小节、
           * 虚高分），也有结构问题（巨函数、大文件里的超长函数、目录不分层、疑似死导出）。
           * `source:false` 时 `inspection` 是 `null`，函数会如实出「没查到源码」，不编代码问题。
           *
           * `vulnerability` / `redundancy` 两类插件**不编**（体检读不到函数体），但**能收**：
           * 模型读源码后按 prompt 用 `additions` 回传，这里校验后合并进清单——
           * 于是它们真的进清单、也真的能参与复测（老实现只存在于模型的口头回答里）。
           */
          fixPlan: planResult.plan,
          /** 模型回传里被接收的条目（已并入 fixPlan）与被退回的（带原因）。 */
          additions: { accepted: planResult.additions, rejected: planResult.rejected },
          /** 复测：传了 `previousKeys` 才有；`resolved` 只表示清单里不再有这条，不等于改对了。 */
          recheck,
          sections: state.sections,
          /**
           * 审查指令**默认不回吐**（省 2628 字符 / 每次）。
           *
           * 为什么：这套规则在**提示段的「### 审查（op:audit）」一节里已经有一份**，
           * 而提示段每步都在、走的是缓存友好的固定前缀；放在返回里却是**每次新增
           * 2628 字符的全额计费内容**。同一套规则写两遍、且贵的那一份每轮都发，
           * 这正是本轮要修的那条通用缺陷。
           *
           * 需要原文时给 `verbose:true` 显式要（老行为可复现）。
           */
          ...(args.verbose === true ? { prompt: AUDIT_PROMPT } : {}),
          promptIn: '提示段的「### 审查（op:audit）」一节（要原文给 verbose:true）',
          ...resolved.extra,
          ...pauseFields(),
        }
      }

      if (args.op === 'source') {
        // 记源码根：审查做源码体检要知道去哪看代码（文档目录与源码目录常不在一处）。
        // 传空串 = 清掉，回到默认规则（拼图目录的上一级）。
        if (args.path === undefined && args.sourceRoot === undefined) {
          const state = readState(projectRoot, project)
          const current = state.sourceRoot ?? ''
          const probe = inspectSource(projectRoot, project)
          return {
            ok: true,
            sourceRoot: current,
            effective: probe.ok === true ? probe.base : null,
            fileCount: probe.fileCount ?? 0,
            totalLines: probe.totalLines ?? 0,
            largest: probe.largest ?? null,
            dirs: probe.dirs ?? [],
            sourceFindings: probe.findings ?? [],
            note: current === ''
              ? '还没记源码根，正按默认规则找（拼图目录的上一级）。' + (probe.ok === true && probe.fileCount > 0 ? '' : '没找到源码——用 op:source 带 path 记一下。')
              : '已记源码根。',
            ...resolved.extra,
            ...pauseFields(),
          }
        }
        const target = args.path ?? args.sourceRoot
        const result = setSourceRoot(projectRoot, project, target ?? '')
        if (result.ok !== true) return failure(result.error, result.hint)
        const after = inspectSource(projectRoot, project)
        return receipt(readState(projectRoot, project), {
          ...resolved.extra,
          sourceRoot: result.sourceRoot,
          fileCount: after.fileCount ?? 0,
          totalLines: after.totalLines ?? 0,
          sourceFindings: after.findings ?? [],
        })
      }

      if (args.op === 'mode') {
        if (typeof args.mode !== 'string' || !MODES.includes(args.mode)) return failure(`未知模式 ${String(args.mode)}`, `可用：${MODES.join(' / ')}`)
        const result = setMode(projectRoot, project, args.mode)
        if (result.ok !== true) return failure(result.error, result.hint)
        return receipt(readState(projectRoot, project), { ...resolved.extra, modeChanged: args.mode })
      }

      if (args.op === 'size') {
        // **项目规模**：同一个项目写多细（条数上限与字数上限）由它定。
        // 不给 size = 查询；给了就写进主文档 front-matter 的 `规模:` 并回报新上限。
        if (args.size === undefined) {
          const current = sizeOfProject(projectRoot, project)
          return {
            ok: true,
            size: current,
            sizes: SIZES,
            caps: capsOfSize(current),
            entryLimits: limitsOfSize(current),
            note: `当前规模「${current}」：悬而未决 ≤${capsOfSize(current).pending} 条、已定 ≤${capsOfSize(current).decided} 条、工作流 ≤${capsOfSize(current).workflow} 条，`
              + (capsOfSize(current).pit === null ? '坑不限条数。' : `坑 ≤${capsOfSize(current).pit} 条。`)
              + `改规模：op:size 带 size（${SIZES.join(' / ')}）。`,
            ...resolved.extra,
            ...pauseFields(),
          }
        }
        const result = setSize(projectRoot, project, args.size)
        if (result.ok !== true) return failure(result.error, result.hint)
        return receipt(readState(projectRoot, project), { ...resolved.extra, sizeChanged: result.size, caps: result.caps })
      }

      if (args.op === 'settings') {
        // 这个 op 管**两个互不相干的开关**，别把它们混成一个：
        //   `disabled`  —— **按会话**：本会话不再注入拼图规则、也不再拦工具（会话 ID 名单）；
        //   `askPause`  —— **全局**：固定收尾问要不要问（DSH_HOME 下一个布尔，跨会话跨项目）。
        // 为什么不做成一个 op 一个开关：它们本来就是两件事（「这个会话别管我」vs
        // 「所有会话都别再问那句」），合成一个就得靠参数组合去猜用户想改哪个。
        const target = typeof sessionId === 'string' && sessionId !== '' ? sessionId : ''
        const settings = readSettings()
        // 两个都给了：**同时改**，一次返回把两项结果都带上。面板的「全局设置」区
        // 会一次提交两个开关，分两次调用会让中间态被轮询看到（闪一下旧值）。
        if (args.disabled !== undefined || args.askPause !== undefined) {
          const changes = []
          if (args.askPause !== undefined) {
            const pause = setAskPause(args.askPause === true)
            changes.push(pause.changed
              ? (pause.askPause ? '已开启固定收尾问。' : '已**全局关闭**固定收尾问：此后所有会话的提问都不再带它。')
              : '固定收尾问本来就是' + (pause.askPause ? '开着的' : '关着的') + '，无需重复操作。')
          }
          if (args.disabled !== undefined) {
            const result = args.disabled === true ? disableSession(target) : enableSession(target)
            if (result.ok !== true) return failure(result.error ?? '设置失败', '检查 DSH_HOME 是否可写')
            changes.push(args.disabled === true
              ? (result.alreadyDisabled === true
                ? '本会话此前已禁用，无需重复操作。'
                : '已禁用**本会话**的拼图模式：下一轮起不再注入拼图规则、也不再拦工具；其他会话不受影响。'
                  + '随时可用 op:settings disabled:false 恢复。')
              : (result.wasDisabled === true
                ? '已恢复**本会话**的拼图模式。其他会话的禁用状态不受影响。'
                : '本会话本来就没禁用，无需恢复。'))
          }
          const after = readSettings()
          return {
            ok: true,
            sessionId: target,
            disabled: isSessionDisabled(target, after),
            askPause: isAskPauseEnabled(after),
            disabledCount: after.disabledSessions.length,
            disabledSessions: after.disabledSessions,
            settingsFile: settingsPath(),
            note: changes.join(''),
            ...pauseFields(),
            ...resolved.extra,
          }
        }
        const off = isSessionDisabled(target, settings)
        return {
          ok: true,
          sessionId: target,
          disabled: off,
          askPause: isAskPauseEnabled(settings),
          disabledCount: settings.disabledSessions.length,
          disabledSessions: settings.disabledSessions,
          settingsFile: settingsPath(),
          note: target === ''
            ? '拿不到当前会话 ID，无法判定——请从会话内调用。'
            : (off
              ? '本会话已禁用拼图模式：不再注入拼图规则、也不再拦工具。'
              : '本会话未禁用：照常带拼图模式。'),
          ...pauseFields(),
          ...resolved.extra,
        }
      }

      return failure(`未知 op ${String(args.op)}`, `可用：${OPS.join(' / ')}`)
    },
  }), 'dsh-puzzle-mode: puzzle_mode tool')

  /* --------------------- 只拼不写：deny 越权工具（tools/pre-execute） --------------------- */

  if (typeof ctx.on === 'function') {
    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      // 已经有人拒了就别插话；没有 agent 的派发（如子流程）一律放行。
      if (decision !== null && typeof decision === 'object' && decision.kind === 'deny') return decision
      if (exec === null || typeof exec !== 'object') return decision
      const toolName = typeof exec.name === 'string' ? exec.name : ''
      if (toolName === '' || PUZZLE_ONLY_ALLOWED_TOOLS.includes(toolName)) return decision

      // 文档锁：**先于会话判断、也先于模式判断**，且与两者都无关。
      // 拼图文档只能由 puzzle_mode 改，否则条目限长 / 条数上限 / slug 过滤 / 路径守卫
      // 会被一次 write 全部绕过。没绑定的会话、两个可执行模式，同样拦。
      const target = docMutationTarget(toolName, exec.arguments)
      if (target !== null && isPuzzleDocPath(target)) {
        return { kind: 'deny', reason: docLockReason(toolName, target) }
      }

      const agent = exec.agent
      const sessionId = agent !== undefined && agent !== null && typeof agent.id === 'string' ? agent.id : ''
      if (sessionId === '') return decision

      // 被禁用拼图模式的会话**完全不受拼图影响**：不拦工具、也不注入提示段。
      // 它就是个普通会话。判定只认会话 ID，所以只影响被点名的那个会话。
      if (isSessionDisabled(sessionId)) return decision

      const resolved = sessionCwd(ctx, sessionId)

      // 只看本会话**绑定**的项目：没绑定就不拦，免得误伤其他会话的普通工作。
      //
      // **多绑定联动**（v7，用户裁定）：模式管的是**全部绑定的项目**——只要有一个是
      // 「只拼不写」，写动作就被拦。为什么取最严而不是「只看当前项目」：
      // 一个会话同时操作几个项目时，模型随时可能在它们之间跳着改文件，
      // 「当前项目」只是默认落点，不是「这轮只许动它」的承诺。按当前项目判会漏掉
      // 「切到 A（可执行）却去改 B（只拼不写）」——那正是约束最该生效的时刻。
      // 代价如实说：另绑一个松散项目也会被连带拦住，想动手就得把那个项目也放开。
      const bound = boundProjects(resolved.cwd, sessionId)
      if (bound.length === 0) return decision
      // **热路径**：这里在每一次工具调用上跑，所以只读「项目存不存在 + 什么模式」，
      // 不调 `readState`（那会把全部模块文档读一遍并算健康性/条目合规/工作流，
      // 实测单次阻塞 86–127ms，而结果只用得到 mode 一个字段）。见 `readProjectMode`。
      const strictest = bound.find((name) => {
        const state = readProjectMode(resolved.cwd, name)
        return state.initialized === true && !isExecutableMode(state.mode)
      })
      if (strictest === undefined) return decision

      return { kind: 'deny', reason: denyReason(toolName, strictest, bound.length > 1 ? bound : null) }
    }, 'dsh-puzzle-mode: 只拼不写拦截 + 文档锁')
  }

  /* ------------------ 首轮自动判定：直接发需求 → 采访后再建 ------------------ */

  /**
   * 判定点为什么是 `agent/pre-step`：它是**每步进入模型之前**唯一能改 `decision.messages`
   * 的钩子，而且能拿到 `step` 与本步认领到的消息——「新会话首条需求」只有在这里
   * 才能确定性地判出来。`tools/pre-execute` 不行：那时模型已经想好要调工具了，
   * 而且首条需求可能压根不调工具（只是聊天）。
   *
   * 与 `只拼不写拦截` 的分工：那个管「模型想动手时拦不拦」，这个管「模型还没动时先提醒」。
   * 两者互不影响：这里只**追加一条上下文**，从不 reject、从不 deny。
   */
  if (typeof ctx.on === 'function') {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        if (decision === null || typeof decision !== 'object' || decision.kind === 'reject') return decision
        const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
        if (agent === undefined || agent === null) return decision
        const sessionId = typeof agent.id === 'string' && agent.id !== ''
          ? agent.id
          : (agent.session !== undefined && agent.session !== null && typeof agent.session.id === 'string' ? agent.session.id : '')
        if (sessionId === '') return decision
        // 子代理（subagent 工具 / teammate）没有用户可问，注入「去采访用户」纯属污染。
        // 它的首条 prompt 同样是 role:'user' + source.kind:'user'，光看消息分不出来。
        if (isDelegatedSession(agent)) return decision
        // 被禁用拼图模式的会话完全不受影响（与提示段、拦截同一条口径）。
        if (isSessionDisabled(sessionId)) return decision
        // 同一个会话只注入一次：重试 / 恢复路径会对同一步重复派发。
        if (hasFired(sessionId)) return decision
        // 必须同时给 turn：`step === 1` 只是「本轮第一步」（每个 turn 都会归零），
        // 只有 `turn === 1 && step === 1` 才是「本会话第一轮」。
        const detected = detectFirstRun(payload.messages, payload.step, payload.turn)
        if (detected.trigger !== true) return decision
        // 还没绑项目才触发；已绑的会话是「继续做项目」，不该再被采访流程打断。
        const resolved = sessionCwd(ctx, sessionId)
        if (boundProject(resolved.cwd, sessionId) !== null) return decision
        // 先把上下文**造好**，再落闸——顺序反了会造出「报了 fired 但其实没注入」的假状态：
        // markFired 之后这几步（listProjects / firstRunHint / makeContextMessage）任一抛错，
        // 都会被下面的 catch 吞掉并原样放行，而闸门已经关上，本会话再也不会重试。
        // 「报 fired=true」必须等价于「真的注入了」。
        const existing = listProjects(resolved.cwd).map((item) => item.name)
        const context = makeContextMessage(firstRunHint(existing))
        if (!markFired(sessionId)) return decision
        // 插在**认领到的消息之后**：需求在前、提示紧随其后，模型读到的是「需求 + 怎么做」。
        return { ...decision, messages: [...decision.messages, context] }
      } catch (_error) {
        // 首轮判定**绝不能**因为自身出错而挡住用户的需求：出任何问题就按原样放行。
        return decision
      }
    }, 'dsh-puzzle-mode: 首轮自动判定（采访后再建）')
  }

  /* --------------------- 工作流触发：把规则送到它管的那一刻 --------------------- */

  /**
   * 为什么挂 `tools/post-execute` 而不是 `tools/pre-execute`（v0.19.9 的设计取舍）：
   *
   * `pre-execute` 的返回值只有 `allow` / `deny` / `ask` 三种——
   *   - `deny` 会把工具**拦下来**（改个 package.json 就报错，太粗暴）；
   *   - `ask` 会**弹审批框**（每写一个文件都问一次，比不提醒更烦）；
   *   - `allow` **不能附带任何信息**（核心代码里 `decision.kind === 'allow'` 时
   *     只读 `guardReason`，`reason` 字段被忽略）。
   * 所以「非阻塞地提醒一条规则」在 `pre-execute` 上**做不到**。
   *
   * `post-execute` 恰好有这个通道：返回 `{ kind:'accept', additionalContexts:[...] }`
   * —— 工具**照常成功**，附带的上下文被 agent-loop 收下、下一轮喂给模型。
   * 这正是「规则绑触发点」需要的语义：不拦、不打断，只是让规则在该出现时出现。
   *
   * 实测教训（这条改动的由来）：`PUBLISH.md` 里早就写着「description 别堆版本历史」，
   * 但我第一次改 `package.json` 时撞不见它，照样违反。`## 工作流` 原先只是纯文本，
   * 注入给模型读，却**不绑定任何动作**——规则躺在那儿，等你做到那一步时不会自己冒出来。
   */
  if (typeof ctx.on === 'function') {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      try {
        // 别人已经 block 了就別插话（block 是错误路径，再塞上下文会让人看不懂）。
        if (decision === null || typeof decision !== 'object' || decision.kind !== 'accept') return decision
        if (exec === null || typeof exec !== 'object') return decision
        const toolName = typeof exec.name === 'string' ? exec.name : ''
        if (toolName === '' || toolName === 'puzzle_mode') return decision
        const agent = exec.agent
        const sessionId = agent !== undefined && agent !== null && typeof agent.id === 'string' ? agent.id : ''
        if (sessionId === '' || isSessionDisabled(sessionId)) return decision
        const resolved = sessionCwd(ctx, sessionId)
        // **多绑定自动匹配**（v7，用户裁定）：一个动作可能同时命中几个绑定项目的工作流，
        // 逐个查、各自注入各自的流程。为什么不是「只查当前项目」：多绑定的意义就是
        // 一个会话同时干几个项目的活，而「当前项目」只是默认落点——改 B 的文件时
        // 只查 A 就会漏掉 B 的流程，那正是规则最该出现的时刻。
        const bound = boundProjects(resolved.cwd, sessionId)
        if (bound.length === 0) return decision
        const injected = []
        for (const name of bound) {
          // ⚠️ `readMainDoc` 返回的是**对象**（`{ ok, mainDoc, text, workflow, … }`），不是字符串。
          // 它已经把工作流解析好放在 `workflow` 里（且命中内容缓存），直接用，别再解析一遍。
          // 实测踩过：按字符串用 → `typeof !== 'string'` 直接 return，整条钩子成了**死代码**
          // （功能看着写完了，其实永不触发）。
          const doc = readMainDoc(resolved.cwd, name)
          if (doc === null || doc === undefined || doc.ok !== true) continue
          const blocks = Array.isArray(doc.workflow) ? doc.workflow : []
          const hit = workflowsTriggeredBy(blocks, toolName, exec.arguments)
          if (hit.length === 0) continue
          injected.push(workflowTriggerText(name, hit, bound.length > 1))
        }
        if (injected.length === 0) return decision
        return {
          ...decision,
          additionalContexts: [
            ...(decision.additionalContexts ?? []),
            makeContextMessage(injected.join('\n\n'), 'puzzle-workflow-trigger'),
          ],
        }
      } catch (_error) {
        // 与首轮判定同一条原则：提醒失败**绝不能**影响工具结果，出任何问题原样放行。
        return decision
      }
    }, 'dsh-puzzle-mode: 工作流触发注入')
  }

  /* --------------------- 重复思考熔断：绕圈时把模型推出去 --------------------- */

  /**
   * 为什么挂在 `tools/post-execute`（与「工作流触发」同一个通道、同一个理由）：
   *
   * 真实的工具调用只在 `ToolExecution` 上（`exec.name` / `exec.arguments`）——
   * `agent/pre-step` 的 `decision.messages` 契约是 `UserMessage[]`，**读不到 tool-call**
   * （本仓踩过这个假绿，见 `test/40-pre-execute.test.mjs` 开头）。而 `post-execute`
   * 的 `additionalContexts` 是唯一能「不拦、不打断、只提醒一句」的通道。
   *
   * 分工：这个钩子管「模型**已经**绕了几步，把它推出去」；「工作流触发」管
   * 「这个动作命中了某条流程，把流程送过去」。两者互不影响，各自独立注入。
   *
   * ## 为什么现在会**反复**注入，而不是只报一次（v0.27.0）
   *
   * 旧行为是「同一段连击只报一次」：报过就永久闭嘴。实测的后果是**熔断不生效**——
   * 模型被点名后若没换动作，第 4、5、6…次全部静默放行，链条要么原地空转、
   * 要么模型挑「停下来说清」把球踢回用户，最后**还得人工再推一把**。
   *
   * 现在改成**升级重报**：到阈值报第 1 次（三选一），之后每 `LOOP_ESCALATE_EVERY`
   * 次再报一次，文案随 `level` 加码（第 2 档起撤掉「转人工」这条逃逸口，改成
   * 「先捋事实、再下结论」的硬指令）。噪音由**间隔**控制，而不是靠永久沉默。
   */
  if (typeof ctx.on === 'function') {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      try {
        // 与工作流触发同口径：别人 block 了就别插话；工具没成功时也不提醒
        // （失败的重试是正当行为，不是绕圈）。
        if (decision === null || typeof decision !== 'object' || decision.kind !== 'accept') return decision
        if (exec === null || typeof exec !== 'object') return decision
        const toolName = typeof exec.name === 'string' ? exec.name : ''
        if (toolName === '' || toolName === 'puzzle_mode') return decision
        const agent = exec.agent
        const sessionId = agent !== undefined && agent !== null && typeof agent.id === 'string' ? agent.id : ''
        if (sessionId === '') return decision
        // 被禁用拼图模式的会话完全不受影响（与提示段、拦截、工作流同一条口径）。
        if (isSessionDisabled(sessionId)) return decision
        const note = noteAction(sessionId, toolName, exec.arguments)
        if (note.shouldFire !== true) return decision
        return {
          ...decision,
          additionalContexts: [
            ...(decision.additionalContexts ?? []),
            makeContextMessage(loopBreakText(toolName, note.count, LOOP_REPEAT_THRESHOLD, note.level), 'puzzle-loop-break'),
          ],
        }
      } catch (_error) {
        // 与首轮判定同一条原则：提醒失败**绝不能**影响工具结果，出任何问题原样放行。
        return decision
      }
    }, 'dsh-puzzle-mode: 重复思考熔断')
  }

  /* --------------------- 催促：每 NUDGE_EVERY 步催一次 --------------------- */

  /**
   * 为什么单独一个钩子、而不是并进熔断：
   *
   * 两者判的是**两件事**。熔断问「你是不是在用同样的参数调同一个工具」（原地绕圈），
   * 催促问「你走了几步了」（节拍）。前者可能一次都不触发，而模型照样能走二十步
   * 不出活——那正是用户报的「干活磨磨唧唧」。
   * 合成一个钩子就得在一个函数里判两套状态，任一侧改口径都会牵动另一侧。
   *
   * 通道与熔断相同（`tools/post-execute` 的 `additionalContexts`）：
   * 不拦、不打断，只是把话说到模型面前。
   *
   * **判据是纯节拍**（用户裁定「干什么都四步催一次」）：每 `NUDGE_EVERY` 次工具调用
   * 催一次，**不分读写**。工具名只用来决定**语气轻重**——这几步里出现过非只读调用
   * 就算「有产出」，档位停在第 1 档（轻推报进度），不会把正在干活的人当磨蹭的人骂。
   * 见 `lib/nudge.js` 的两条触发与加码规则。
   */
  if (typeof ctx.on === 'function') {
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      try {
        // 与另两个钩子同口径：别人 block 了就别插话；失败的重试是正当行为，不是磨蹭。
        if (decision === null || typeof decision !== 'object' || decision.kind !== 'accept') return decision
        if (exec === null || typeof exec !== 'object') return decision
        const toolName = typeof exec.name === 'string' ? exec.name : ''
        if (toolName === '' || toolName === 'puzzle_mode') return decision
        const agent = exec.agent
        const sessionId = agent !== undefined && agent !== null && typeof agent.id === 'string' ? agent.id : ''
        if (sessionId === '') return decision
        // 被禁用拼图模式的会话完全不受影响（与提示段、拦截、工作流、熔断同一条口径）。
        if (isSessionDisabled(sessionId)) return decision
        const note = noteCall(sessionId, toolName, exec.arguments)
        if (note.shouldNudge !== true) return decision
        return {
          ...decision,
          additionalContexts: [
            ...(decision.additionalContexts ?? []),
            makeContextMessage(nudgeText(note.reason, note.count, note.level, note.target), 'puzzle-nudge'),
          ],
        }
      } catch (_error) {
        // 与首轮判定同一条原则：催促失败**绝不能**影响工具结果，出任何问题原样放行。
        return decision
      }
    }, `dsh-puzzle-mode: 催促（每 ${NUDGE_EVERY} 步一次）`)
  }

  /* ------------------------------ 浏览器通道 ------------------------------ */

  ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/puzzle-mode-rpc',
      handler: async (req, res) => {
        const rejection = webCtx.connection.requestRejection(req)
        if (rejection !== undefined) {
          respond(res, rejection, { ok: false, error: '需要当前浏览器鉴权' })
          return
        }
        if (req.method !== 'POST') {
          respond(res, 405, { ok: false, error: 'POST required' })
          return
        }
        let body
        try {
          body = JSON.parse(await readBody(req))
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('bad body')
        } catch (_error) {
          respond(res, 400, { ok: false, error: '请求正文必须是 { method, sessionId } 对象' })
          return
        }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') {
          respond(res, 400, { ok: false, error: '缺少 sessionId' })
          return
        }
        // 面板可以显式指定项目；不给就用默认（最新的那个）。
        const requested = typeof body.project === 'string' ? body.project : undefined
        const resolved = located(ctx, sessionId, requested)
        const projectRoot = resolved.projectRoot
        const project = resolved.project

        if (body.method === 'state') {
          // 绑定组：切换条要渲染「绑了哪几个、当前是哪个」。每次 state 都带上，
          // 因为面板轮询只拉 state——放在单独一个 method 里，切换条就得自己再轮询一次。
          const panelState = readState(projectRoot, project)
          respond(res, 200, {
            ok: true,
            result: {
              ...summarize(panelState, resolved.extra),
              findings: Array.isArray(panelState.findings) ? panelState.findings : [],
              ranking: dimensionRanking(panelState.dimensions),
              // 面板也要看到工作流的**归档明细**（不是只有数量）——「恢复」按钮按它渲染。
              workflowArchive: Array.isArray(panelState.workflowArchive) ? panelState.workflowArchive : [],
              // 切换条的数据源（与 `mode` / `size` 写操作共用同一个函数，见 `bindingPanel`）。
              ...bindingPanel(projectRoot, project, sessionId, panelState),
              // 主题：`state` 只带**当前生效的 CSS 与已装清单**（本地读盘，毫秒级），
              // 不带远端清单——那要联网，塞进 8 秒轮询会让断网时面板每轮卡死。
              theme: themeOverview(),
              themeCss: activeThemeCss(),
            },
          })
          return
        }
        if (body.method === 'main') {
          // 面板的「主文档」只读查看：回原文 + 工作流 + 归档。
          // 未绑定 / 项目不存在时返回 `{ok:false,error}`（面板渲染成红字），不抛异常。
          const doc = readMainDoc(projectRoot, project)
          if (doc.ok !== true) {
            respond(res, 200, { ok: false, error: doc.error ?? '读不到主文档' })
            return
          }
          respond(res, 200, {
            ok: true,
            result: {
              project,
              mainDoc: doc.mainDoc,
              text: doc.text,
              workflow: doc.workflow,
              workflowArchive: doc.workflowArchive,
              version: doc.version,
              outdated: doc.outdated,
            },
          })
          return
        }
        if (body.method === 'workflow') {
          // 面板的一键删除（可回滚）：删整条进归档、把归档第 index 条整条恢复、或永久删除归档项。
          // 成功时回**完整状态摘要**——面板把这个 result 整体当作新 data（同 writeMode），
          // 缺字段会让其它区块渲染不出来。
          if (body.action !== 'remove' && body.action !== 'restore' && body.action !== 'drop') {
            respond(res, 400, { ok: false, error: `未知 action ${String(body.action)}` })
            return
          }
          const done = body.action === 'remove'
            ? removeWorkflowItem(projectRoot, project, body.index, body.expected)
            : body.action === 'restore'
              ? restoreWorkflowItem(projectRoot, project, body.index)
              : dropWorkflowArchiveItem(projectRoot, project, body.index)
          if (done.ok !== true) {
            respond(res, 200, { ok: false, error: done.error, hint: done.hint })
            return
          }
          const after = readState(projectRoot, project)
          respond(res, 200, {
            ok: true,
            result: {
              ...summarize(after, resolved.extra),
              // 与 `mode` / `size` / `current` 同一条纪律：项目级写操作都回绑定组。
              // 这里其实**不改**绑定集合（只增删一条工作流），但仍要回——理由是
              // `health` / `moduleCount` 会随文档内容变，而胶囊的 title 与 `%` 渲染它们。
              ...bindingPanel(projectRoot, project, sessionId, after),
              findings: Array.isArray(after.findings) ? after.findings : [],
              ranking: dimensionRanking(after.dimensions),
              action: body.action,
              changed: done.changed,
              evicted: done.evicted ?? [],
              evictedRecoverable: done.evictedRecoverable === true,
              workflow: done.workflow,
              workflowArchive: done.workflowArchive,
            },
          })
          return
        }
        if (body.method === 'create') {
          const name = typeof body.project === 'string' && body.project.trim() !== '' ? body.project : defaultProjectName(body.goal ?? '')
          const created = createProject(
            projectRoot, name, typeof body.goal === 'string' ? body.goal : '',
            Array.isArray(body.modules) ? body.modules : [], DEFAULT_MODE, sessionId,
          )
          if (created.ok !== true) {
            respond(res, 200, { ok: false, error: created.error })
            return
          }
          respond(res, 200, {
            ok: true,
            result: {
              // 建完之后真实归属是「绑定」（新建时顺带绑了），不是 explicit。
              // 报 explicit 会让面板以为「项目名是外面传进来的」，掩盖绑定状态。
              ...summarize(readState(projectRoot, created.project), {
                ...resolved.extra,
                projectSource: created.rebound === true ? 'bound' : 'none',
              }),
              createdModules: created.created,
              mainCreated: created.mainCreated === true,
              rebound: created.rebound === true,
              released: created.released ?? [],
              // 项目已存在 → 这次没动绑定。必须说清，否则用户会以为「解绑又被绑回去了」。
              hint: created.mainCreated === true
                ? '项目已建好并绑定本会话。'
                : '项目已存在，**没有改动绑定**（要改绑用 op:bind 或面板「项目」区的绑定切换条）。',
            },
          })
          return
        }
        if (body.method === 'bind') {
          // `projects: [...]`（v7 多绑定模式的多选）：一次追加多个，**最后一个**成为当前
          // ——「我勾了 A、B、C 然后点绑定」，落在最后勾的那个最符合直觉。
          //
          // ⚠️ 这段**必须在 `project` 的入参守卫之前**。实测 bug（用户报「选中以后点绑定
          // 会闪红框」）：多选那条请求只带 `projects`、**没有 `project` 字段**，
          // 而守卫写成了「没有 project 就 400」——于是它永远被挡在门外，
          // 面板显示「缺少 project」。守卫的语义是「**两个都没给**才算缺参数」。
          const many = Array.isArray(body.projects) ? body.projects.filter((n) => typeof n === 'string' && n.trim() !== '') : []
          if (many.length === 0 && (typeof body.project !== 'string' || body.project.trim() === '')) {
            respond(res, 400, { ok: false, error: '缺少 project（或 projects 数组）' })
            return
          }
          // 面板的「＋ 绑定项目」走 `add`（追加，不动已有绑定）；
          // 老的「绑定」按钮走默认的替换全部语义。两者语义不同，不能合成一个：
          // 追加却清掉了别的绑定，用户看到的是「我点 ＋ 结果别的没了」。
          if (many.length > 0) {
            const added = []
            for (const name of many) {
              const one = addBinding(projectRoot, name, sessionId)
              if (one.ok !== true) {
                respond(res, 200, { ok: false, error: `绑定「${name}」失败：${one.error}` })
                return
              }
              added.push(one.project)
            }
            const last = added[added.length - 1]
            respond(res, 200, { ok: true, result: { ...summarize(readState(projectRoot, last), { ...resolved.extra, projectSource: 'bound' }), added, addedCount: added.length } })
            return
          }
          const bound = body.add === true
            ? addBinding(projectRoot, body.project, sessionId)
            : bindSession(projectRoot, body.project, sessionId)
          if (bound.ok !== true) {
            respond(res, 200, { ok: false, error: bound.error })
            return
          }
          respond(res, 200, { ok: true, result: { ...summarize(readState(projectRoot, bound.project), { ...resolved.extra, projectSource: 'bound' }), released: bound.released ?? [], added: body.add === true, already: bound.already === true } })
          return
        }
        if (body.method === 'current') {
          if (typeof body.project !== 'string' || body.project.trim() === '') {
            respond(res, 400, { ok: false, error: '缺少 project' })
            return
          }
          const moved = setCurrentProject(projectRoot, body.project, sessionId)
          if (moved.ok !== true) {
            respond(res, 200, { ok: false, error: moved.error })
            return
          }
          // 与 `mode` / `size` 同形：回一份**重读过盘**的绑定组。这里尤其要紧——
          // `current` 只改「当前是哪个」，绑定集合本身没变，客户端原先只能靠
          // `markCurrentLocal` 就地改 `current` 标记兜底，而那个兜底**自己承认没有断言**
          // （见 client.js 那段诚实说明）。宿主把真值直接给出来，兜底才不必独挑大梁。
          const afterCurrent = readState(projectRoot, moved.project)
          respond(res, 200, {
            ok: true,
            result: {
              ...summarize(afterCurrent, { ...resolved.extra, projectSource: 'bound' }),
              ...bindingPanel(projectRoot, moved.project, sessionId, afterCurrent),
              switched: true,
            },
          })
          return
        }
        if (body.method === 'unbind') {
          // 面板每项那个 `×` 带 project（只解这一个）；不带就是「全解」。
          if (typeof body.project === 'string' && body.project.trim() !== '') {
            const one = unbindOne(projectRoot, body.project, sessionId)
            if (one.ok !== true) {
              respond(res, 200, { ok: false, error: one.error })
              return
            }
            const left = boundProjects(projectRoot, sessionId)
            respond(res, 200, {
              ok: true,
              result: {
                ...summarize(readState(projectRoot, one.current ?? ''), { ...resolved.extra, projectSource: left.length > 0 ? 'bound' : 'none' }),
                unbound: true,
                unboundProject: one.project,
                released: [one.project],
                currentProject: left.length > 0 ? left[0] : null,
              },
            })
            return
          }
          const cut = unbindSession(projectRoot, sessionId)
          if (cut.ok !== true) {
            respond(res, 200, { ok: false, error: cut.error })
            return
          }
          respond(res, 200, { ok: true, result: { ...summarize(readState(projectRoot, ''), { ...resolved.extra, projectSource: 'none' }), unbound: true, released: cut.released ?? [], currentProject: null } })
          return
        }
        if (body.method === 'rebuild') {
          // `all:true` = 作用于本会话**全部绑定**（面板「迁移/仅迁移格式」在多绑定下是全局动作）。
          if (body.all === true) {
            const names = boundProjects(projectRoot, sessionId)
            if (names.length === 0) {
              respond(res, 200, { ok: false, error: '本会话还没绑定拼图项目' })
              return
            }
            const results = names.map((name) => {
              const one = rebuildProject(projectRoot, name, body.apply === true)
              return {
                project: name,
                ok: one.ok === true,
                error: one.ok === true ? null : one.error,
                version: one.version,
                targetVersion: one.targetVersion,
                outdated: one.outdated,
                totalChanges: one.totalChanges,
                written: one.written ?? [],
                failed: one.failed ?? [],
                // 预览要逐文件列出「将要改什么」——面板复用 rebuildBlock 的渲染。
                files: one.ok === true
                  ? one.files.map((item) => ({
                    kind: item.kind,
                    name: item.name,
                    file: item.file,
                    version: item.version,
                    changes: item.changes,
                    willWrite: item.changes.length > 0 && typeof item.text === 'string',
                  }))
                  : [],
              }
            })
            respond(res, 200, {
              ok: true,
              result: {
                ...summarize(readState(projectRoot, names[0]), resolved.extra),
                all: true,
                boundProjects: names,
                applied: body.apply === true,
                results,
                totalChanges: results.reduce((sum, one) => sum + (one.totalChanges ?? 0), 0),
              },
            })
            return
          }
          const result = rebuildProject(projectRoot, project, body.apply === true)
          if (result.ok !== true) {
            respond(res, 200, { ok: false, error: result.error })
            return
          }
          respond(res, 200, {
            ok: true,
            result: {
              ...summarize(readState(projectRoot, project), resolved.extra),
              version: result.version,
              targetVersion: result.targetVersion,
              outdated: result.outdated,
              totalChanges: result.totalChanges,
              applied: result.applied === true,
              written: result.written ?? [],
            },
          })
          return
        }
        if (body.method === 'list') {
          respond(res, 200, { ok: true, result: summarizeList(projectRoot, projectSummaries(projectRoot)) })
          return
        }
        if (body.method === 'scan') {
          // 工作区里还没拼图文档的顶层目录（面板空态「一次建多个项目文档」的数据源）。
          const candidates = scanUnpuzzled(projectRoot)
          respond(res, 200, {
            ok: true,
            result: {
              ...summarize(readState(projectRoot, project), resolved.extra),
              candidates,
              candidateCount: candidates.length,
              alreadyPuzzled: listProjects(projectRoot).map((item) => item.name),
            },
          })
          return
        }
        if (body.method === 'audit') {
          // 面板要显示**真实值**（不只是声明值），所以这里给一份轻量审查结果：
          // 五维真实值 + 虚高清单 + 源码体检摘要。不返回完整 findings（那个走 op:audit）。
          const state = readState(projectRoot, project)
          if (state.initialized !== true) {
            respond(res, 200, { ok: false, error: '尚无拼图项目' })
            return
          }
          const inspection = inspectSource(projectRoot, project)
          const hasSource = inspection.ok === true && inspection.fileCount > 0
          const mergedEvidence = {}
          for (const key of ['points', 'detail', 'pending', 'decided', 'shared']) {
            mergedEvidence[key] = state.modules.reduce((sum, module) => sum + ((module.evidence ?? {})[key] ?? 0), 0)
          }
          mergedEvidence.pit = state.sections?.pit ?? 0
          const mergedDeclared = {}
          for (const dimension of HEALTH_DIMENSIONS) {
            const values = state.modules.map((module) => module.healthScores?.[dimension.key]).filter((v) => typeof v === 'number')
            if (values.length > 0) mergedDeclared[dimension.key] = Math.round(values.reduce((a, b) => a + b, 0) / values.length)
          }
          const truth = trueHealthOf({ evidence: mergedEvidence, inspection, declared: mergedDeclared, hasSource })
          const inflation = []
          for (const [key, reason] of Object.entries(truth.reasons)) {
            if (reason.inflation === undefined) continue
            inflation.push({
              dimension: key,
              name: HEALTH_DIMENSIONS.find((d) => d.key === key)?.name ?? key,
              declared: reason.inflation.declared,
              trueValue: reason.inflation.trueValue,
              gap: reason.inflation.gap,
            })
          }
          respond(res, 200, {
            ok: true,
            result: {
              project: state.project,
              declaredHealth: state.health,
              trueHealth: truth.health,
              declaredDimensions: state.dimensions,
              trueDimensions: truth.scores,
              reasons: truth.reasons,
              inflation,
              // 面板也要看得到可执行修复清单（结构类 + 文档类）。
              // 面板不传 additions（模型回传走 op:audit），所以只取 plan。
              fixPlan: fixPlanOf(state, inspection).plan,
              // 最弱一维与 ranking 同口径（真实值），面板不再另算一套。
              ranking: dimensionRanking(truth.scores),
              weakest: dimensionRanking(truth.scores)[0] ?? null,
              source: hasSource
                ? {
                  base: inspection.base,
                  fileCount: inspection.fileCount,
                  totalLines: inspection.totalLines,
                  largest: inspection.largest,
                  dirs: inspection.dirs,
                  findings: inspection.findings,
                }
                : { skipped: true, note: inspection.ok === true ? inspection.note : inspection.error },
            },
          })
          return
        }
        if (body.method === 'module') {
          if (typeof body.name !== 'string' || body.name === '') {
            respond(res, 400, { ok: false, error: '缺少 name' })
            return
          }
          const detail = readModuleDetail(projectRoot, project, body.name)
          if (detail.ok !== true) {
            respond(res, 200, { ok: false, error: detail.error })
            return
          }
          respond(res, 200, { ok: true, result: { ...detail, ...resolved.extra } })
          return
        }
        if (body.method === 'mode') {
          if (!MODES.includes(body.mode)) {
            respond(res, 400, { ok: false, error: `未知模式 ${String(body.mode)}` })
            return
          }
          const result = setMode(projectRoot, project, body.mode)
          if (result.ok !== true) {
            respond(res, 200, { ok: false, error: result.error })
            return
          }
          // **必须带上绑定组**（修的真实 bug）：`mode` 的返回原先只有 `summarize`，
          // 里面没有 `bindings`，客户端便沿用旧数组 → 切换条上的模式停在改动前那个值，
          // 用户看到的是「点了模式又自己弹回去」。写完立刻回一份**重读过盘**的绑定组。
          const afterMode = readState(projectRoot, project)
          respond(res, 200, {
            ok: true,
            result: { ...summarize(afterMode, resolved.extra), ...bindingPanel(projectRoot, project, sessionId, afterMode) },
          })
          return
        }
        if (body.method === 'size') {
          // 面板的三档按钮：写主文档 front-matter 的 `规模:`。
          // 与 `mode` 同形——改完回整份 state + 绑定组，面板按新值重画上限说明与胶囊。
          const result = setSize(projectRoot, project, body.size)
          if (result.ok !== true) {
            respond(res, 200, { ok: false, error: result.error })
            return
          }
          const afterSize = readState(projectRoot, project)
          respond(res, 200, {
            ok: true,
            result: { ...summarize(afterSize, resolved.extra), ...bindingPanel(projectRoot, project, sessionId, afterSize) },
          })
          return
        }
        if (body.method === 'settings') {
          // 面板的设置通道，管**两个互不相干的开关**：
          //   `disabled` —— **按会话**：哪些会话不要拼图模式（会话 ID 名单，与项目无关）；
          //   `askPause` —— **全局**：固定收尾问要不要问（DSH_HOME 下一个布尔，跨会话跨项目）。
          // 不给任何参数 = 只查询；给了才改。
          if (body.disabled === undefined && body.askPause === undefined) {
            const settings = readSettings()
            respond(res, 200, {
              ok: true,
              result: {
                sessionId,
                disabled: isSessionDisabled(sessionId, settings),
                askPause: isAskPauseEnabled(settings),
                disabledCount: settings.disabledSessions.length,
                settingsFile: settingsPath(),
              },
            })
            return
          }
          // 两个都给时**一次改完再回**：面板的「全局设置」区一次提交两个开关，
          // 分两次调用会让 8 秒轮询拍到中间态（用户看到开关自己闪一下）。
          if (body.askPause !== undefined) {
            const pause = setAskPause(body.askPause === true)
            if (pause.ok !== true) {
              respond(res, 200, { ok: false, error: pause.error ?? '收尾问开关写入失败' })
              return
            }
          }
          if (body.disabled !== undefined) {
            const result = body.disabled === true ? disableSession(sessionId) : enableSession(sessionId)
            if (result.ok !== true) {
              respond(res, 200, { ok: false, error: result.error ?? '开关写入失败' })
              return
            }
          }
          const after = readSettings()
          respond(res, 200, {
            ok: true,
            result: {
              sessionId,
              disabled: isSessionDisabled(sessionId, after),
              askPause: isAskPauseEnabled(after),
              disabledCount: after.disabledSessions.length,
              settingsFile: settingsPath(),
            },
          })
          return
        }
        if (body.method === 'theme') {
          // 主题：**与项目无关**（用户裁定「全局记忆，所有会话生效」），所以这里
          // 既不读也不写项目文档——主题是插件自己的皮肤，不是项目数据。
          //
          // 为什么列表与 CSS 分成两个 action：`state` 每 8 秒轮询一次，
          // 而 `list` 要联网（最坏 8 秒超时 ×3 个镜像）。把它们塞进 `state`
          // 会让面板在断网时每轮卡住。列表只在**打开主题页**时拉一次。
          const action = typeof body.action === 'string' ? body.action : 'overview'
          if (action === 'overview') {
            respond(res, 200, { ok: true, result: themeOverview() })
            return
          }
          if (action === 'css') {
            const loaded = loadThemeCss(typeof body.id === 'string' ? body.id : '')
            if (loaded.ok !== true) {
              respond(res, 200, { ok: false, error: loaded.error ?? '读主题失败', hint: loaded.hint })
              return
            }
            respond(res, 200, { ok: true, result: loaded })
            return
          }
          if (action === 'list') {
            const listed = await listThemes({
              repo: typeof body.repo === 'string' ? body.repo : undefined,
              base: typeof body.base === 'string' ? body.base : undefined,
            })
            if (listed.ok !== true) {
              respond(res, 200, { ok: false, error: listed.error ?? '拉主题清单失败', tried: listed.tried, repo: listed.repo })
              return
            }
            respond(res, 200, { ok: true, result: listed })
            return
          }
          if (action === 'install') {
            // 「一个『下载并应用』」：装完直接生效，用户不用再点第二次。
            const installed = await installTheme(String(body.id ?? ''))
            if (installed.ok !== true) {
              respond(res, 200, { ok: false, error: installed.error ?? '安装失败', hint: installed.hint, tried: installed.tried })
              return
            }
            const applied = applyTheme(installed.id)
            if (applied.ok !== true) {
              respond(res, 200, { ok: false, error: applied.error ?? '应用失败' })
              return
            }
            respond(res, 200, { ok: true, result: { ...installed, css: applied.css, theme: themeOverview() } })
            return
          }
          if (action === 'apply') {
            const applied = applyTheme(String(body.id ?? ''))
            if (applied.ok !== true) {
              respond(res, 200, { ok: false, error: applied.error ?? '应用失败', hint: applied.hint })
              return
            }
            respond(res, 200, { ok: true, result: { ...applied, theme: themeOverview() } })
            return
          }
          if (action === 'reset') {
            resetTheme()
            respond(res, 200, { ok: true, result: { id: '', css: '', theme: themeOverview() } })
            return
          }
          if (action === 'uninstall') {
            const removed = uninstallTheme(String(body.id ?? ''))
            if (removed.ok !== true) {
              respond(res, 200, { ok: false, error: removed.error ?? '卸载失败' })
              return
            }
            respond(res, 200, { ok: true, result: { ...removed, theme: themeOverview() } })
            return
          }
          if (action === 'repo') {
            const saved = setThemeRepo(typeof body.repo === 'string' ? body.repo : '')
            if (saved.ok !== true) {
              respond(res, 200, { ok: false, error: saved.error ?? '保存主题源失败', hint: saved.hint })
              return
            }
            respond(res, 200, { ok: true, result: { ...saved, theme: themeOverview() } })
            return
          }
          respond(res, 400, { ok: false, error: `未知 theme action ${String(body.action)}` })
          return
        }
        respond(res, 400, { ok: false, error: `未知 method ${String(body.method)}` })
      },
    }), 'dsh-puzzle-mode: rpc route')
  })
}

/**
 * 当前生效主题的 CSS 文本（没装主题就是空串）。
 *
 * 为什么收成一个小函数而不是内联在 `state` 里：`loadThemeCss` 会读盘并做一次
 * 安全校验，返回的是 `{ok,css,error}` 三态。`state` 是每 8 秒轮询一次的路径，
 * 它**不该因为一份坏主题而整个失败**——坏主题的后果是「退回默认皮肤」，
 * 而不是「面板打不开」。这里把三态压成一个字符串，坏主题静默退回空串。
 */
function activeThemeCss() {
  const loaded = loadThemeCss('')
  return loaded.ok === true ? loaded.css : ''
}

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = ''
    let bytes = 0
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > MAX_BODY) {
        rejectPromise(new Error('请求过大'))
        req.destroy()
        return
      }
      data += chunk
    })
    req.on('end', () => {
      resolvePromise(data)
    })
    req.on('error', rejectPromise)
    req.on('aborted', () => {
      rejectPromise(new Error('请求已取消'))
    })
  })
}

/**
 * 面板的**绑定组**：切换条 / 胶囊要的「绑了哪几个、当前是哪个、各自什么模式」。
 *
 * 为什么抽出来、而不是只在 `method:'state'` 里算一份（修的真实 bug）：
 * `mode` / `size` 这类**写操作**的返回原先只有 `summarize(...)`，里面**没有 `bindings`**。
 * 而客户端 `mergePanelData` 只在「新值缺这个键」时保留旧值——于是写完模式后，
 * 切换条上那个项目的模式仍是**改动前**那个，看起来就是「点了又自己弹回去」。
 *
 * 实测（真实 RPC，不是推断）：点「边拼边写」后返回
 * `bindings: undefined` / `currentProject: undefined`，只有 `state` 带这两项。
 * 所以**凡是要让面板重画的项目级写操作，都必须回同一份绑定组**。
 */
function bindingPanel(projectRoot, project, sessionId, panelState) {
  const names = boundProjects(projectRoot, sessionId)
  return {
    bindings: names.map((name) => {
      // 当前项目直接用调用方已经读好的那份，别重复读一遍盘。
      const state = name === project && panelState !== undefined && panelState !== null
        ? panelState
        : readState(projectRoot, name)
      return {
        project: name,
        current: name === names[0],
        mode: state.mode,
        health: state.health,
        moduleCount: Array.isArray(state.modules) ? state.modules.length : 0,
        initialized: state.initialized === true,
      }
    }),
    currentProject: names.length > 0 ? names[0] : null,
    bindingWarnThreshold: BINDING_WARN_THRESHOLD,
  }
}

function respond(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

export { policyText, summarize, denyReason, dimensionMeta }
