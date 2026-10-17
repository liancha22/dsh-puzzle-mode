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
import { statSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_MODE,
  SESSION_FIELD,
  CURRENT_SESSION_FIELD,
  BINDING_WARN_THRESHOLD,
  boundProject,
  boundProjects,
  openProjectIn,
  setOpenProjectIn,
  locate,
  readSettings,
  patchSettings,
  setWorkspaceBinding,
  dataWorkspaceRoot,
  openProjectOf,
  setOpenProject,
  setCodeWorkspace,
  setDispatchModel,
  CODE_WORKSPACE_MODES,
  DEFAULT_CODE_WORKSPACE_MODE,
  DISPATCH_MODEL_SLOTS,
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
  isExecutableMode,
  inspectSource,
  listProjects,
  scanUnpuzzled,
  projectSummaries,
  readMainDoc,
  parseFrontMatter,
  getSection,
  readModuleDetail,
  readState,
  readTextCached,
  collectSourceFiles,
  puzzleDirOf,
  MAIN_FILE,
  atomicWrite,
  DOCIO_MAX_WRITES,
  planWrites,
  describePlan,
  readProjectMode,
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
  updateMainSection,
  updateModuleSection,
  disableSession,
  enableSession,
  isSessionDisabled,
  isSessionWired,
  markWired,
  MAX_WIRED_SESSIONS,
  brainSessionOf,
  setBrainSession,
  forgetBrainSession,
  isAskPauseEnabled,
  setAskPause,
  pauseFields,
  settingsPath,
  makeContextMessage,
  toolArgs,
  docTargetOf,
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
  checkUpdate,
  downloadUpdate,
  installCommandOf,
  profileDirOf,
  stagedVersions,
  normalizeVersion,
  createThemeScaffold,
  rebuildThemeIndex,
  findThemeRepo,
  themeRepoStatus,
  readRepoTheme,
  writeRepoTheme,
  exportThemePack,
  importThemePack,
  installThemePack,
  writeThemePack,
  listThemePacks,
  uploadTheme,
  themeIdOf,
  themeDevPrompt,
  repoThermIds,
  THEME_REPO_DIRNAME,
  pluginVersion,
  localVersion,
  resolveTagSha,
  updatesDir,
  readThemeState,
  themesDir,
  themeCssPath,
  fetchReleaseList,
  readUpdateRun,
  listBackups,
  spawnUpdater,
  BOARD_COLUMNS,
  COLUMN_LABELS,
  FORBIDDEN_JUMPS,
  DECOMPOSE_SYSTEM,
  readBoard,
  writeBoard,
  emptyCard,
  nextCardId,
  pushHistory,
  moveVerdict,
  verdictOf,
  observeOf,
  firstPromptOf,
  freezeCheck,
  freezeCard,
  groupByColumn,
  shortTitle,
  parseDecompose,
  CLARIFIER_SYSTEM,
} from './puzzle.js'
import { runDispatch, runClarify, runBrain, runBuildSession, codeRootOf, codeRootInfoOf } from './dispatchrun.js'
import { installClarifier } from './clarifier.js'
import { applyGoalChange, applyObserved } from './completion.js'
import { installBrain, installTaskWriter, refreshBrainDoc, isBrainSession, forgetBrainHolder } from './brain.js'
import { installScopedTools, SCOPED_TOOL_NAMES, pathOfScopedCall, outsideWorkspaceOf, outsideNotice } from './scopedtools.js'
import { logFailure, logPath } from './plog.js'

export const name = 'dsh-puzzle-mode'
/**
 * 本插件的注入面。
 *
 * ## 为什么不把 `llm` / `agentDefaultModel` 加进来（与升级方案的一处**有意偏离**）
 *
 * 升级方案 §U3 改动清单第 13 条写的是「加 `llm` 与 `agentDefaultModel`」。
 * 落地时改成**懒取**（`ctx.get('llm')`，见 `method:'decompose'` 分支），原因：
 *
 * `inject` 是**激活闸门**，不是「我需要这个能力」的声明——它列出的服务**必须全部存在**，
 * 否则整行插件**加载失败**（`dsh-puzzle-mode` 是宿主平面的一行，加载不了就是
 * 「拼图模式整个消失」，而不是「分解功能不可用」）。
 *
 * 而 `llm` 只服务**一个可选功能**（新建任务单的「一键分解」）。为它把整个插件
 * 绑死在「这个部署必须有 llm 服务」上，代价与收益完全不成比例——
 * 分解拿不到 llm 时正确的行为是**如实报「这台部署没有 llm 服务，请手填三个框」**，
 * 而不是让面板打不开。`agentDefaultModel` 同理（拿不到就报「拿不到默认模型」）。
 *
 * 判据：**缺了它，插件还能不能正常用？** 能（其余功能全在）→ 懒取，不进 `inject`。
 *
 * ⚠️ 按这条判据，`fs` 也**不进** `inject`：专属工具体拿不到它时是
 * 「这个会话没有沙箱工具」，而面板、文档、看板全都照常——见 `scopedtools.js`
 * 里那句 `ctx.get('fs')` 与它的降级分支。
 */
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
/**
 * RPC 正文上限。
 *
 * 从 16KB 提到 **1MB**（v1.0.0）：面板要能把一份**单文件主题包**贴进来导入，
 * 而主题包上限是 512KB（`MAX_PACK_BYTES` = 2 × 256KB）。原先那个 16KB 是给
 * 「几个字段的表单」定的，导入功能一上就会被它静默拒掉——而且拒绝发生在
 * 读正文那一步，面板只会看到一句「请求过大」，完全联想不到是上限太小。
 *
 * 1MB 是 512KB 的两倍：留出 JSON 转义（`\n`、中文转义）的膨胀余量。
 */
const MAX_BODY = 1048576
const OPS = ['list', 'scan', 'read', 'show', 'main-doc', 'init', 'bind', 'bindings', 'unbind', 'current', 'rebuild', 'main', 'module', 'write', 'health', 'source', 'mode', 'size', 'settings', 'workspace']

/**
 * 提问规则那几行（提示段用）。
 *
 * 为什么收成常量：这两个数原先散在多处各写一份（提示段、面板模板 ×3、
 * README、UI.md），改一次「5 问」就得满仓库找——漏一处就变成两套规则打架。
 * 改上限只改 `constants.js` 的 `ASK_MAX_*`（那是唯一数字来源），文案引用它。
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
 * 提示段文本。**只对装上了插件的会话求值**（v2.1.1）。
 *
 * ## v2.1.1 改了什么
 *
 * 原先这里判 `isSessionDisabled(sessionId)`：拼图模式默认对**所有**会话生效，
 * 用户逐个关掉不想要的。现在反过来——插件默认**一个会话都不碰**，
 * 只有派单子会话被 `installSessionTools` 装上，那时的 section 才存在。
 *
 * ## 为什么还要保留 `isSessionDisabled` 这一道
 *
 * 因为它仍然能救回一个场景：某个会话装上了插件（进了名单）、用户随后
 * 在面板里把它关掉——那时下一轮就该停止注入。少这一道，用户关了却还在注入。
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
    '**v2.0.0 起插件是全局的**：拼图项目**不再与会话绑定**，一个工作区里的项目对所有会话一视同仁；「当前项目」指的是**面板现在打开着的那一个**（记在插件的全局设置里，与文档无关）。',
    '- 解析顺序只有两步：显式 `project` > **面板当前打开的项目** > **空**。没有就是空，**不会**自动占用别的项目。',
    '- 文档与任务单住在**数据工作区**里：`op:workspace` 绑/查它（面板一级页也有入口）。**没绑就是没绑**——插件不会退回进程目录，那会把文档写到你看不见的地方。',
    `- 先看有哪些项目：\`puzzle_mode{op:'list'}\`；看「有哪些 + 当前打开哪个」用 \`op:'bindings'\`。`,
    `- 建项目：\`op:'init'\` 并**显式给 \`project\` 与 \`modules\`**，一次把项目文件夹、主文档与每个模块文档都建出来。不要只建主文档。`,
    `- **新会话直接发需求 → 走「采访后再建」**：`,
    `  这个工作区里还没有项目、而用户第一条消息就是需求时，按这个顺序做，**不要跳步**：`,
    `  ① 先 \`op:'list'\` 看工作区里有没有已有项目；`,
    `  ② **有** → 先用 \`ask_user_question\` 问用户「打开已有的哪个，还是新建一个」，等他回答，不要替他决定；`,
    `  ③ **没有**（或用户选了新建）→ 采访（最多 ${ASK_MAX_QUESTIONS} 问、每题最多 ${ASK_MAX_OPTIONS} 个选项；目标 / 模块怎么划 / 边界在哪），**不要提前 \`op:init\`**；`,
    `  ④ 拿到回答后 \`op:'init'\` 一次建齐。`,
    `  用户说「别采访 / 直接建 / 不用问」时跳过采访，直接 \`op:init\` 建空壳。`,
    `  用户只是在打招呼（「你好」）时不要触发这套流程。`,
    `- 打开已有项目：\`op:'current'\` 并给 \`project\`（= 面板一级列表点一行）。⚠️ \`op:'bind'\` / \`op:'unbind'\` **已废弃**，调了会得到明确的废弃提示，不要再用。`,
    `- 目录固定为 \`<数据工作区>/<项目名>/${PUZZLE_DIR}/主文档.md\` 与 \`${PUZZLE_DIR}/模块/<模块名>.md\`。`,
    '',
    '### 文档分工',
    '- **主文档只有四节**：`## 模块索引`（模块 → 一句话职责 → 文件）、`## 源码索引`、`## 工具索引`、`## 坑`。**除这四节外禁止写任何内容**（用户原话 / 悬而未决 / 已定 / 撤销都不再写进主文档；工作流功能已在文档格式 v9 整体删除）。',
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
    '### 项目健康性（五维）',
    `- 每个模块文档的 \`${HEALTH_HEADING}\` 里记五维，**每一维 0-100、越高越好**：${DIMENSION_LINE}。`,
    '- 写法：`任务复杂度: 80`（一行一维，维度名用上面的名字）。**维护系数高分 = 维护负担轻**；若你想写成本，写成 `维护成本: 30` 也会被自动翻成 `维护系数: 70`。',
    '- **没写就用文档内容推导**：有 `## 要点` / `## 详细记录` / `## 悬而未决` / `## 已定` 才有分，空文档五维全 0。所以健康性是「文档里有多少证据」，不是印象分——想让它涨，就真的把内容写进去。',
    `- 项目健康性 = 各模块健康性的均值，由宿主汇总，**不要在文档里手写总分**。想看就调 \`puzzle_mode{op:'read'}\` 或看面板。`,
    '- 每轮提问收尾时，顺手把本轮的结论落到对应维度（例如新定了方案 → 更新模块的 `可拓展性` 与 `## 已定`）。',
    '',
    '- **返回体积纪律（写代码时守住）**：写操作只回**回执**（改了什么 + 全局几个数），不回吐整份状态——实测回吐 7026 字符而回执 1192（省 83%）。固定说明放提示段（缓存友好），别塞进每次返回。判据：返回体积应当 ∝ **本次改变了什么**，而不是 ∝ **项目有多大**。',
    '',
    '### 文档格式版本（puzzle）',
    `- 主文档 front-matter 的 puzzle: 是**文档格式版本**（当前 ${PUZZLE_VERSION}）。op:read 返回的 outdated: true 表示这份文档是旧格式。`,
    '- 旧格式要迁移：调 puzzle_mode 的 op:rebuild 先看预览（**默认 dry-run**，逐文件列出将要改什么），确认后再 apply:true 落盘。面板的「迁移/重构」按钮会把整套提示词填进输入框。',
    '- 重建**只改形状**（front-matter 字段、缺失的小节、拆 悬而未决/已定），**正文一字不动**；唯一"造内容"的地方是把旧完成度折算成五维起点，且只填拿不到证据的维度。',
    '- **迁移不追溯老条目**：已经写下的超长 / 无出处条目不会被 rebuild 清理，只能由你按规格**逐节重写**（`append:false`）。用户点「迁移/重构」时要两件都做：先 rebuild 落盘，再重写正文。',
    '- **本项目不自动备份**：工作区通常在 git 里，但若不在，先自行备份再 apply:true。',

    '### 全局化与工作区（v8）',
    '- **插件是全局的**：拼图面板不绑会话，项目独立存在。主文档 front-matter 里**不再有** `会话:` / `当前会话:` 两个字段；老文档迁移（`op:rebuild`）会把它们**删掉**。',
    `- 工作区有两类，别混：**数据工作区**（拼图文档与任务单住哪，\`op:workspace\` 绑）与**执行工作区**（派单出去的 AI 在哪改代码）。`,
    `  - 执行工作区**默认就是拼图项目文件夹**（\`<数据工作区>/<项目名>\`）——用户不配也能派单，所以别拿「没配代码工作区」当理由拒绝干活。`,
    `  - 只有用户在面板「派单设置」里填了全局根（\`<根>/<项目名>\`）或单项目覆盖时，它才不在项目文件夹里；想知道**实际是哪个目录**，看派单回报里的 \`codeRoot\`，或面板上那一行。`,
    '- 工具不给 `project` 时落在**面板当前打开的项目**；看「有哪些项目 + 当前是哪个」用 `puzzle_mode{op:\'bindings\'}`，换用 `op:current`。',
    `- **任务单看板是项目级的、且一张卡一个文件**（v2.4.9）：卡在 \`<数据工作区>/拼图/<项目名>/派单/<卡 id>.json\`，一份文件**只装那一张卡**。所以看板**必须带项目名**——不知道项目名就查不出卡，**不要**去猜「大概是工作区里那份」。同目录那个 \`派单.json\` 只是老版本留下的占位，**不装卡**。`,
    `- **移动就是唯一的触发手势**（v2.4.3）：卡上不再有任何按钮。把「未接单」移到「在做」= **真的派单开工**（建会话 + 挂 goal + 投首轮消息）；「失败」移到「在做」= 接着**原会话**继续，**不新建会话**。`,
    `- ⚠️ \`op:bind\` / \`op:unbind\` **已废弃**（v2.0.0 起项目与会话不再绑定）：调了会得到明确的废弃提示，**不会**静默成功——别把它当成绑上了。`,
    `- ⚠️ **「${MODE_PUZZLE_ONLY}」的拦截在本版暂时禁用**：模式选择器还在，但选它不会真的拦住写动作（原因见 CHANGELOG）。**文档锁不受影响**，继续拦「直接改拼图文档」。`,
    '',
    '### 三种执行模式',
    `- **${MODE_PUZZLE_ONLY}**：只提问 + 更新文档；不执行任何动作（越权工具会被宿主 deny，错误里会说明原因）。`,
    `- **${MODE_PUZZLE_AFTER}**：可以动手，但**一轮做完才问**——把这一轮改完、再一起汇报与提问（这是旧的「${MODE_PUZZLE_WRITE}」改名而来）。`,
    `- **${MODE_PUZZLE_WRITE}**：可以动手，但**每个写动作之前先问**——动 write / edit / bash 等会改变世界的工具之前，先用 ask_user_question 说清「要改哪个文件、改成什么」，用户点头才动手；一次点头只覆盖它对应的那个动作。`,
    `- 当前模式由 \`puzzle_mode{op:'read'}\` 返回的 \`mode\` / \`canExecute\` 给出，每次动手前先看它；模式只允许 \`${MODES.join('` / `')}\`。`,
    `- 模式名在文档格式 v${MODE_RENAME_VERSION} 改过含义：v4 及更早的 \`${MODE_PUZZLE_WRITE}\` 一律按 \`${MODE_PUZZLE_AFTER}\` 读（迁移会改写落盘），别把它当成高强度模式。`,
    '',
    '### 说话与干活',
    // ⚠️ 这一节是**硬约束**，不是「建议」。原先这里写着「一律用中文」而模型实测仍然
    // 说英文，当时的做法是再加一道检测钩子（`lib/speech.js` + 两个注入钩子）。
    // 那些注入钩子已整体删除，所以本节**只剩规则本身**——不再有「宿主会检查你」的
    // 承诺，因为那已经是一句假话。
    '- **【最硬约束 · 中文】所有陈述必须是中文。** 正文、结论、进度、解释、列表、标题、表格、工具参数说明、代码注释——**全部中文**。这一条优先于本提示段的其它一切风格要求。',
    '  - **只有四种东西可以是英文**：代码本身、标识符（函数名 / 变量名 / 类名）、文件路径、命令与报错原文。除此之外**任何**英文句子、英文短语、英文小标题、英文连接词都算违规。',
    '  - **不许**先写一句英文再补一句中文；**不许**用英文写「思路 / 计划 / 总结」；**不许**把中文句子写成英文再翻译回来。',
    '- **【最硬约束 · 不复读】陈述里不许复述输入的内容。** 用户说的话、刚读到的文件内容、命令输出——**一个字都不要抄进你的陈述**。',
    '  - 陈述只写**你新得出的结论**与**下一步动作**。要引用原文就**给位置**（`文件:行`），不要整段搬。',
    '  - **同一件事只说一遍**：不要换个说法再讲一次；不要复述上一轮说过的内容；每轮开头直接给**这一轮的新结论或新动作**。',
    // ⚠️ v1.1.2（用户报「一直跟个复读机一样说相似的话」，且点名「两个都烦」）：
    // 上面治的是**逐字复读**，但实测里更烦的是**同一种动作重复**——每一步工具调用之后
    // 都写一小段「我刚发现了什么」，句式各不相同（「数据出来了」「数据坐实了」
    // 「关键事实到齐了」），可**读起来是同一件事**：都是播报，都没有新结论。
    // 逐字比对抓不到它（字面确实不同），所以这里用一条**行为规则**来治：
    // 工具调用之间不写话，除非要改计划。
    '- **【别做进度播报】工具调用之间不要写「我刚发现了什么」**：连着几步工具调用时，中间那几句「数据出来了」「查到了」「关键事实到齐了」**都是噪音**——用户要的是结果，不是过程直播。',
    '  - 判据：**这句话改变了下一步做什么吗？** 没有就别写，直接调下一个工具。',
    '  - 要说话就说**结论**或**改计划**（「A 路走不通，改走 B」）——那是新信息；「我正在查 X」不是。',
    '  - 一整轮结束才写总结；中间不需要旁白。**同一个发现不许换个说法再讲一遍。**',
    `- **读文件一次读全**：\`read\` 把 \`limit\` 给足（整份读完，或一次读到你真正要的范围），**不要一段一段读同一个文件**。要看好几个文件就**同一步里并行发多个 \`read\`**，别串着等。`,
    // ⚠️ 这里原先写着「每 N 步会被催一次」并引用催促文案常量。催促功能已整体删除
    // （`lib/nudge.js` + 它的注入钩子），所以那句承诺不再成立——留着就是骗模型。
    // 但「别做进度播报」这条**行为规则本身仍然有效**（它是用户的真实要求，不依赖钩子），
    // 所以只删掉「宿主会催」的机制描述，保留规则。
    '',
    '若本会话被压缩成 checkpoint，checkpoint 的 `## Critical Context` 必须原样保留本节规则。',
].join('\n')

/* --------------------------------- 会话与项目定位 --------------------------------- */

/**
 * 取**数据工作区根**——拼图文档与任务单住在哪。
 *
 * ## v8 换掉了什么（这是本版最核心的一条改动）
 *
 * v7 及更早：项目根 = **会话的 `header.cwd`**，拿不到就退回 `process.cwd()`。
 * v8 起：项目根 = 用户在**一级面板绑定的工作区**（全局设置里的 `workspacePath`）。
 *
 * 为什么必须换：面板变成全局工作台之后**没有会话可依**——用户不打开任何会话
 * 也能点开拼图面板看项目列表。而 `process.cwd()` 兜底是**更坏**的选择：
 * 那会把文档悄悄写到进程目录（可能是 `/` 或用户家目录），用户完全看不出来。
 * 所以未绑定就是**空串**：面板显示「绑定一个工作区」的空态，工具如实回报
 * `projectSource: 'none'` 并提示去绑。**明确说没配**比**写错地方**好得多。
 *
 * `source` 字段保留下来（`'workspace'` / `'none'`），让调用方与模型都能看见
 * 「这个根是从哪来的」——诊断行写死会让真错与假错同形，那是本仓记过的坑。
 */
function workspaceRoot() {
  const path = dataWorkspaceRoot()
  if (path !== '') return { cwd: path, source: 'workspace' }
  return { cwd: '', source: 'none' }
}

/**
 * 定位本次调用要操作的项目。解析顺序**只有两步**（v8）：
 *   显式给了 project → 用它（source: 'explicit'，不存在也算显式，如实回报未初始化）；
 *   否则**面板当前打开的项目** → 用它（source: 'open'）；
 *   否则 → **空**（source: 'none'，project 为 ''）。
 *
 * 「空」是刻意的：不再回退「项目根下最新的那个」。那条回退会把一次调用塞进
 * 用户没在看的项目，越写越混——这正是「当前项目只有一个」要根治的问题。
 *
 * v8 去掉了 v7 的「本会话绑定」那一档：会话不再参与定位（见 `workspaceRoot`）。
 */
function located(requested) {
  const resolved = workspaceRoot()
  const where = locate(resolved.cwd, requested)
  const all = boundProjects(resolved.cwd)
  const extra = {
    projectRoot: resolved.cwd,
    cwdSource: resolved.source,
    projectRequested: where.project,
    projectSource: where.source,
    // 有多个项目时才带这两个字段：只有一个 / 一个都没有时它等于 `[project]`，
    // 每次返回都重复一遍纯属噪音（这条返回在**每次工具调用**上都在）。
    //
    // 字段名刻意**不叫 `bindings`**：`op:bindings` 那个返回里 `bindings` 是**对象数组**
    // （带健康性/模式），这里是**名字数组**。同名不同形会让「谁盖谁」变成隐蔽 bug——
    // 实测踩过一次（`...extra` 放后面，把对象数组盖成了 `[undefined, undefined]`）。
    ...(all.length > 1 ? { boundProjects: all, currentProject: all[0] } : {}),
    sessionId: '',
  }
  if (resolved.source === 'none') {
    extra.hint = '还没绑定**数据工作区**（拼图文档与任务单住在哪个工作区）：'
      + '在面板一级页绑定一个工作区；绑好之后 op:init 就能建项目了。'
      + '插件**不会**退回进程目录——那会把文档写到你看不见的地方。'
  } else if (where.source === 'none') {
    extra.hint = '这个工作区里还没有拼图项目，或面板当前没打开任何项目。'
      + '新建：op:init 并显式给 project 与 modules，一次把项目文件夹、主文档与每个模块文档都建出来；'
      + '打开已有项目：在面板一级列表点一行，或 op:current 给 project。'
  } else if (all.length > 1) {
    /**
     * ⚠️ **这里刻意不写 `hint`，改写 `projectHint`**（v8 修的真实 bug）。
     *
     * `located()` 的返回值会被 `...resolved.extra` 铺进**每一个** op 的返回里，
     * 而多数 op 自己也有一个 `hint`（「怎么落盘」「去哪个 op」）。`extra` 铺在后面，
     * 于是这条「工作区里有几个项目」的**说明性**文案会把那个**操作性**的 hint 整个盖掉。
     *
     * v7 时它没暴露，是因为判据是「本会话绑了 >1 个项目」——只有多绑定会话才触发；
     * v8 换成「工作区里有 >1 个项目」之后，**只要有第二个项目就会触发**，
     * 于是 `op:rebuild` 的「加 apply:true 落盘」被盖成了「不给 project 就落在它上面」。
     * 实测（30-rpc 的 rebuild 用例）就是这么红的。
     *
     * 修法不是调顺序（那会让别的 op 反过来盖掉这条），而是**换一个不冲突的字段名**：
     * 说明性信息归 `projectHint`，操作性信息归 `hint`，两者互不覆盖。
     */
    extra.projectHint = `这个工作区里有 ${all.length} 个项目（面板当前打开的是「${all[0]}」）。`
      + '不给 project 就落在它上面；要换用 op:current 并给 project。'
  }
  return { project: where.project, projectRoot: resolved.cwd, extra }
}

/* --------------------------------- 工具 --------------------------------- */

const TOOL_DESCRIPTION = [
  '拼图模式：把项目拆成主文档 + 模块文档，用提问把不确定项变成已定项。',
  'op=list 列出现有项目；op=scan 列出**工作区里还没有拼图文档**的顶层目录（建文档前的候选）；op=read 读状态（带 brief:true 是精简档）；op=show 读某个模块文档的详情；op=main-doc 读主文档全文（只读）；op=init 一次创建主文档与每个模块一份文档；op=bind 已废弃（v2.0.0 起插件全局，项目与会话不再绑定，调用会得到明确的废弃提示）；op=bindings 列出工作区里的全部项目与面板当前打开的那个；op=unbind 已废弃（同上）；op=current 切换**面板当前打开的项目**（即一级列表里「点一行进下一级」）；op=workspace 绑/查**数据工作区**（拼图文档与任务单住哪）；op=rebuild 重建/迁移文档格式（默认 dry-run；all:true 遍历工作区**全部项目**）；op=main 更新主文档四节之一；op=module 更新（必要时创建）模块文档；**op=write 一次写多处**（writes 数组；要写两节以上一律用它——同一文件的多节合并成一次读→解析→落盘，写大文档时明显更快）；op=health 写五维健康性；op=source 记/查源码根；op=mode 切换执行模式。',
  `**主文档只有四节**：${SECTION_ORDER.map((key) => SECTION_HEADINGS[key]).join(' / ')}——除这四节外禁止写任何内容。`,
  `条目格式固定为「一句话（源码: 文件:行）」，查找方向是 主文档 → 源码；限长**随项目规模（小 / 中 / 大）变**，以 \`op:read\` / \`op:size\` 返回的 \`limits\` 为准（出处不占额度，超了报错不截断）。`,
  `条数与字数的上限**随项目规模（小 / 中 / 大）变化**：动手写之前看 op:read / op:size 返回里的 \`limits\`（那是这个项目当前的真实上限），或看 \`## 规模\` 说明。超条数上限时写入自动删最旧。`,
  `文档格式有版本号（当前 puzzle: ${PUZZLE_VERSION}）。op=read 里 \`outdated: true\` 表示这份文档是旧格式，用 \`op=rebuild\` 迁移——它默认只给预览，加 apply:true 才落盘（本项目不自动备份）。`,
  `**插件是全局的**（v8）：项目与会话不再绑定，工具不给 project 时落在**面板当前打开的项目**；没有就是空（projectSource: none），不会自动占用别的项目。看有哪些项目用 op:bindings，换当前用 op:current。⚠️ **op:bind / op:unbind 已废弃**（调了给明确提示，不静默成功）。数据工作区用 op:workspace 绑——**没绑就不会退回进程目录**，那会把文档写到你看不见的地方。`,
  `项目健康性由五维决定：${HEALTH_DIMENSIONS.map((d) => d.name).join(' / ')}，每维 0-100、**越高越好**（维护系数高分 = 维护负担轻）。`,
  '写法：在模块文档的 `## 健康性` 里一行一维，如 `任务复杂度: 80`；不写则由文档内容推导（空文档全 0）。项目健康性 = 各模块均值，不要手写总分（主文档也没地方写）。',
  '**拼图文档一律不得用其他工具改动**：write / edit / str_replace_editor 只要目标是 `' + PUZZLE_DIR + '/` 下的文件就会被宿主拒绝（所有模式生效）；只读请用 read / grep / op:show。',
  `每次调用返回都带 askPause:true——**每一次提问的最后都要问「${PAUSE_QUESTION}」，两个选项：${PAUSE_OPTIONS.join(' / ')}**；用户选第一项时只回写文档并结束本轮，不执行任何动作。`,
  `当前模式见返回的 mode/canExecute：${MODE_PUZZLE_AFTER} 可执行且一轮做完才问；${MODE_PUZZLE_WRITE} 可执行且每个写动作前先问。⚠️ **${MODE_PUZZLE_ONLY} 的越权拦截在 v2.0.0 暂时禁用**（模式选择器还在，但选它不会真的拦住写动作；**文档锁不受影响**，继续拦「直接改拼图文档」）。`,
  // 跨插件分工（与 dsh-infinite-gen-5 同装时生效）：把「谁在什么场景下说了算」写成
  // 可判规则，免得两份载荷各说一套。数值与对方 data/arbitration.mjs 一致，
  // 由 compat.json + tools/verify-cross-plugin.mjs 双向核对。
  `跨插件分工（与 dsh-infinite-gen-5 同装时生效；本段 order ${ORDER}，早于它的末位锚点 10150）：**交付物内容与形态**（写什么、给多少、四态、可跑件）归无限五代；**拼图文档与采访节奏**（主文档 / 模块文档、首轮采访、审查清单）归本插件——两域不重叠，各管各的。`,
  '整批题在场时（题库 / `[qNNN]` 清单 / 编号 ≥20 条）本插件**不做打断者**：批量交付优先，不采访、不回问、不中停；拼图文档只在该轮结束后**幂等回写**，不得把交付切成两半。',
  `提问额度按轮的**实际目的**取：采访轮与审查确认轮用本插件的额度（≤${ASK_MAX_QUESTIONS} 问、每题 3–6 岔路 + 固定收尾问）；其余场景按无限五代的口径（同一轮最多一问、2–5 个互斥选项）。用户说「别问 / 自己定」时全局静默，本插件的固定收尾问也不问。`,
  '用户选「停下」时**只停动作**：本轮不执行写动作、立即结束，但已交付的产物、结论与拍板**不回退**（无限五代的长程规则不被它触发）。',
  '**拼图文档只走 puzzle_mode**（write / edit 指向拼图目录会被宿主拒）；其它工具的结构化参数按各自 schema 给——无限五代的「参数扁平」只约束自造载荷，不改别人的 schema。',
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

/**
 * 「一键分解」的输出上限。
 *
 * ## 为什么是 16000 而不是 1000（v2.4.10）
 *
 * 这个数原先写 1000，理由写的是「够写三段话」。**那个理由漏了一件事**：
 * 上限是**思考与正文共用**的。这台部署的默认模型开着思考（`high`），模型先把
 * 预算花在思考上——1000 个 token 经常在它还没写第一个 `{` 时就用完，于是返回
 * 零个文本 chunk，面板上看到的是「模型没有返回 JSON 对象」。那句错话把
 * 「预算不够」说成了「模型不听话」，用户只会一直重试同一个必然失败的调用。
 *
 * ## 调大它不增加花费
 *
 * `maxTokens` 是**上限**不是账单：正常答完就停，花的是实际产出的量。
 * 所以取值只需覆盖「思考 + 三段正文」，按最贵的模型留余量。
 * （`@linxin666/dsh-client-ui-task-board` 的裁判用 16384、
 * `@deepblend/dsh-blender-host` 的视觉审查用 24000，都是同一个理由。）
 */
const DECOMPOSE_MAX_TOKENS = 16000

/**
 * 取宿主的**模型目录**（`sessionController.modelCatalog()`）。
 *
 * ## 为什么要用这个而不是自己拼 provider 列表
 *
 * 「设置里已经配置好的模型」这件事，宿主自己最清楚：它已经把 adapter 注册、
 * key 可用性、routable 判定都算过一遍了（`ModelCatalog` 的 `routableProviders`
 * 与 `groups[].models[]`）。插件自己按配置文件的形状拼一份，宿主改一次形状
 * 就会漂移——而漂移的后果是「下拉里列出一个选了就会报错的模型」。
 *
 * ## 返回形状（照宿主 `ModelCatalog` 原样收窄）
 *
 * ```text
 * { ok:true, default:{provider,model,reasoningEffort?},
 *   routableProviders:['qzl','qz'],
 *   groups:[{id,name,models:[{id,name,description?}]}] }
 * ```
 *
 * ⚠️ **拿不到就返回 `{ok:false, error}`，绝不返回空列表**：空列表会被面板读成
 * 「这台部署一个模型都没有」，而事实是「读不到目录」——两件事在界面上必须分开
 * （用户拍板：读不到就报错并禁掉保存）。
 */
async function modelCatalogOf(ctx) {
  let service = null
  try {
    service = ctx.get('sessionController')
  } catch (_error) {
    service = null
  }
  if (service === null || service === undefined || typeof service.modelCatalog !== 'function') {
    return { ok: false, error: '这台部署的 sessionController 没有 modelCatalog，读不到模型目录' }
  }
  let raw = null
  try {
    raw = await service.modelCatalog()
  } catch (error) {
    const text = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
    return { ok: false, error: '读模型目录失败：' + text }
  }
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return { ok: false, error: '模型目录返回了非对象' }
  }
  const groups = []
  const list = Array.isArray(raw.groups) ? raw.groups : []
  for (const group of list) {
    if (group === null || group === undefined || typeof group !== 'object') continue
    const id = typeof group.id === 'string' ? group.id : ''
    if (id === '') continue
    const models = []
    for (const one of Array.isArray(group.models) ? group.models : []) {
      if (one === null || one === undefined || typeof one !== 'object') continue
      const modelId = typeof one.id === 'string' ? one.id : ''
      if (modelId === '') continue
      models.push({
        id: modelId,
        name: typeof one.name === 'string' && one.name !== '' ? one.name : modelId,
        description: typeof one.description === 'string' ? one.description : '',
      })
    }
    groups.push({ id, name: typeof group.name === 'string' && group.name !== '' ? group.name : id, models })
  }
  const fallback = defaultModelSelection(ctx)
  return {
    ok: true,
    // 一个模型组都没有时仍然是「读到了目录，只是它是空的」——面板据此显示
    // 「宿主没有可路由的模型」，而不是「读不到目录」。这两句话的动作不同：
    // 前者要去配 provider，后者要去看宿主接口。
    groups,
    routableProviders: Array.isArray(raw.routableProviders) ? raw.routableProviders.filter((one) => typeof one === 'string') : [],
    default: fallback,
  }
}

/**
 * 取宿主的**默认模型选择**（`agentDefaultModel.currentSelection()`）。
 *
 * 为什么懒取、不进 `inject`：见 `inject` 上面那段注释。
 * 拿不到时返回 `null`，调用方如实报错——**不写死一个模型名兜底**：
 * 写死会让「这台部署没配默认模型」变成「用了某个你从没选过的模型」，
 * 而后者用户根本不知道自己在花谁的钱。
 */
function defaultModelSelection(ctx) {
  try {
    const service = ctx.get('agentDefaultModel')
    if (service === undefined || service === null || typeof service.currentSelection !== 'function') return null
    const selection = service.currentSelection()
    if (selection === null || selection === undefined) return null
    const provider = typeof selection.provider === 'string' ? selection.provider.trim() : ''
    const model = typeof selection.model === 'string' ? selection.model.trim() : ''
    if (provider === '' || model === '') return null
    const out = { provider, model }
    if (typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== '') {
      out.reasoningEffort = selection.reasoningEffort
    }
    return out
  } catch (_error) {
    return null
  }
}

/**
 * 把 `ctx.llm.stream()` 的流**收成一段正文 + 结束原因**。
 *
 * ## 为什么要自己收，而不是找一个现成的组装器
 *
 * 升级方案提到 `dsh-session-title-llm` 用 `BlockAssembler` 组装 token 流。
 * 但那是**另一个插件的内部类**，本插件不该 import 它的私有模块
 * （那是一条没有契约的依赖，对方改一次内部结构就炸）。
 * 而我们要的东西**比它简单得多**：只要正文，不要 block 结构、不要 tool-call。
 *
 * ## 容错策略（这一条决定它会不会因为宿主版本差异而静默返回空串）
 *
 * 流里每个 chunk 的形状**不保证**：可能是 `{type:'text-delta', text}`、
 * 可能是 `{delta:{text}}`、也可能是纯字符串。所以这里**逐个形状试**，
 * 试不出来就跳过——**宁可少收几个 token，也不要因为一个不认识的 chunk 抛错**。
 *
 * ## 为什么必须同时收 `finish`（v2.4.10）
 *
 * 只收正文时，「模型想完了但一个字没来得及说」与「模型说了，但不是 JSON」
 * 在调用方看来**完全一样**——都是空串。前者是**输出被截断**，该做的是调大
 * 上限；后者是模型没照格式说，该做的是重试。报成后者，用户就会一直重试
 * 同一个必然失败的调用。`@deepblend/dsh-blender-host` 为同一个坑写过同样的
 * 守卫（空答案抛错，而不是当成「审查通过」），这里是同一个理由。
 */
async function streamToText(llm, options) {
  const stream = await llm.stream(options)
  if (stream === null || stream === undefined) return { text: '', finish: null }
  let out = ''
  let finish = null
  const eat = (chunk) => {
    if (chunk !== null && chunk !== undefined && typeof chunk === 'object' && chunk.type === 'finish') {
      finish = finishOf(chunk)
      return
    }
    out += textOfChunk(chunk)
  }
  // 有的实现返回 async iterable，有的返回带 `.text` 的 promise。两种都认。
  if (typeof stream[Symbol.asyncIterator] === 'function') {
    for await (const chunk of stream) eat(chunk)
    return { text: out, finish }
  }
  if (typeof stream.text === 'string') return { text: stream.text, finish: null }
  if (typeof stream.then === 'function') {
    const value = await stream
    if (typeof value === 'string') return { text: value, finish: null }
    if (value !== null && value !== undefined && typeof value.text === 'string') return { text: value.text, finish: null }
    if (value !== null && value !== undefined && typeof value[Symbol.asyncIterator] === 'function') {
      for await (const chunk of value) eat(chunk)
      return { text: out, finish }
    }
  }
  return { text: out, finish }
}

/**
 * `finish` chunk 的结束原因，**带上失败详情**。
 *
 * ## 为什么不能只返回 `kind`（v2.4.11）
 *
 * v2.4.10 只取了 `kind`，于是真机上报出来的是「模型调用中断了（error）」——
 * 那句话只说清了「失败了」，没说**为什么**。宿主 `LlmFailure` 里本来就有
 * `message` / `code` / `status`，丢掉它们等于把用户推回「盲猜」，
 * 而那正是第十五宗罪要治的病。
 *
 * 返回 `{kind, detail}`：`detail` 是一句话（能取到多少取多少），取不到就是空串。
 * 认不出形状时 `kind` 为 `null`，调用方**不猜**，仍按解析错误报。
 */
function finishOf(chunk) {
  const reason = chunk.reason
  if (reason === null || reason === undefined || typeof reason !== 'object') return { kind: null, detail: '' }
  const kind = typeof reason.kind === 'string' ? reason.kind : null
  const failure = reason.failure
  if (failure === null || failure === undefined || typeof failure !== 'object') return { kind, detail: '' }
  // 按「用户/我们最需要先看到哪个」排序：消息 → 码 → HTTP 状态 → 请求 id。
  const parts = []
  if (typeof failure.message === 'string' && failure.message.trim() !== '') parts.push(failure.message.trim())
  if (typeof failure.code === 'string' && failure.code.trim() !== '') parts.push('code=' + failure.code.trim())
  if (typeof failure.status === 'number') parts.push('HTTP ' + String(failure.status))
  if (typeof failure.requestId === 'string' && failure.requestId !== '') parts.push('requestId=' + failure.requestId)
  return { kind, detail: parts.join(' · ') }
}

/** 从一个流式 chunk 里尽量取出**正文**；认不出来就返回空串（**不抛错**）。 */
function textOfChunk(chunk) {
  if (typeof chunk === 'string') return chunk
  if (chunk === null || chunk === undefined || typeof chunk !== 'object') return ''
  // **思考不是正文**（v2.4.10）：`reasoning-delta` 与 `text-delta` **都带 `.text`**，
  // 只按 `.text` 取就会把思考过程当正文拼进来。思考里模型常常把 JSON 草稿先画一遍，
  // 而 `parseDecompose` 取的是「第一个 `{` 到最后一个 `}`」——切到草稿上之后，
  // 报出来的字段会是用户从没写过的东西。
  if (chunk.type === 'reasoning-delta' || chunk.type === 'reasoning') return ''
  if (typeof chunk.text === 'string') return chunk.text
  if (chunk.delta !== null && chunk.delta !== undefined) {
    if (typeof chunk.delta === 'string') return chunk.delta
    if (typeof chunk.delta.text === 'string') return chunk.delta.text
  }
  // OpenAI 风格的 `choices[].delta.content`
  if (Array.isArray(chunk.choices) && chunk.choices.length > 0) {
    const first = chunk.choices[0]
    if (first !== null && first !== undefined) {
      if (first.delta !== null && first.delta !== undefined && typeof first.delta.content === 'string') {
        return first.delta.content
      }
      if (typeof first.text === 'string') return first.text
    }
  }
  return ''
}

/**
 * **把拼图模式装进一个会话的作用域**（v2.1.1）。
 *
 * ## 这一版为什么要有它（用户原话）
 *
 * 「把插件与普通会话的关系全部切断，把那些插件里关于注入的全删了，
 * 普通会话不要有插件的工具，不要受插件影响」。
 *
 * 落地方式：`apply(ctx)` **不再**做下面任何一件事，
 *   - ~~`ctx.systemPrompt.section(...)`~~ → 搬到这里；
 *   - ~~`ctx.tools.register(puzzle_mode)`~~ → 搬到这里；
 *   - 所有**注入类钩子**（说话纠正 / 文件观察守卫 / 首轮判定 / 熔断 / 催促等，
 *     后来这些功能已整体删除，只剩文档锁与派单边界提醒）**第一行**都问
 *     `isSessionWired(sessionId)`，名单外的会话直接放行——等于对普通会话完全不存在。
 *
 * 于是「普通会话」与「装了插件的会话」之间只差一件事：**有没有调过这个函数**。
 *
 * ## 它注册进哪个作用域
 *
 * `target` 传 **agent** 时注册进 `agent.ctx`（子会话作用域，只影响那一个会话）；
 * 传 **rootCtx** 时注册进插件根作用域（等于 v2.0.0 的老行为）。
 * 两条路走的是同一份代码，所以「装了什么」不会因为作用域不同而漂移。
 *
 * ## 为什么工具与提示段必须同进同出
 *
 * 只装工具不装提示段，模型拿到 `puzzle_mode` 却不知道什么时候该用、上限是多少；
 * 只装提示段不装工具，它会照着规则去调一个不存在的工具。两者是一个整体。
 *
 * ⚠️ **段序不重复注册**：同名 section 注册两次时宿主的行为是实现细节，
 * 所以这里先记 `installedTools` / `installedSections`，同一个作用域只装一次。
 */
const installedScopes = new WeakSet()

function installInto(scope, options) {
  const o = options !== null && options !== undefined ? options : {}
  if (scope === null || scope === undefined) {
    return { ok: false, reason: '没有可注册的作用域' }
  }
  if (installedScopes.has(scope)) {
    return { ok: true, already: true, section: true, tool: true, toolName: 'puzzle_mode' }
  }

  // 1) 提示段。用**函数**形式（不是调用结果）：宿主 assemble 时按会话求值，
  //    拿到空串时宿主会丢掉这个 section。
  let section = false
  const prompt = scope.systemPrompt
  if (prompt !== null && prompt !== undefined && typeof prompt.section === 'function') {
    try {
      prompt.section({ name: SECTION_NAME, order: ORDER, text: o.policy === undefined ? policyText : o.policy })
      section = true
    } catch (_error) {
      section = false
    }
  }

  // 2) 工具。
  let tool = false
  const tools = scope.tools
  if (tools !== null && tools !== undefined && typeof tools.register === 'function') {
    try {
      tools.register(puzzleModeTool())
      tool = true
    } catch (_error) {
      tool = false
    }
  }

  installedScopes.add(scope)
  return { ok: section || tool, already: false, section, tool, toolName: 'puzzle_mode' }
}

/**
 * 把拼图模式装进**派单子会话**（澄清器 / 执行会话）。
 *
 * 这是 v2.1.1 之后**唯一**会自动装上插件的路径。装成功后把会话 id 记进
 * 「已装会话」名单——那一步是必须的：六个钩子靠它判断「这个会话要不要管」，
 * 而钩子拿不到 agent 的作用域，只能靠 id 查名单。
 *
 * ## 为什么记名单在**装成功之后**
 *
 * 顺序反了会造出「名单里有、实际没装」的假记录：钩子于是会管一个
 * 根本没有 `puzzle_mode` 的会话，注入一堆「去调 op:list」的规则——
 * 模型照做，然后撞上「工具不存在」。**先装，装成了再记。**
 */
export function installSessionTools(agent) {
  if (agent === null || agent === undefined || agent.ctx === null || agent.ctx === undefined) {
    return { ok: false, reason: '这个会话拿不到 agent 作用域', section: false, tool: false }
  }
  const installed = installInto(agent.ctx, {})
  if (installed.ok !== true) return installed
  const sessionId = typeof agent.id === 'string' && agent.id !== ''
    ? agent.id
    : (agent.session !== null && agent.session !== undefined && typeof agent.session.id === 'string' ? agent.session.id : '')
  if (sessionId !== '') markWired(sessionId)
  return installed
}

/**
 * `puzzle_mode` 工具的定义（v2.1.1 起**不再**在 `apply` 里注册）。
 *
 * 抽成函数而不是常量：`defineTool` 的返回值是**实例**，同一份实例注册进两个
 * 作用域会让宿主的注册表里出现同一个对象两次（宿主可能按对象身份去重，
 * 那时第二个会话会拿不到工具）。每次调用造一份新的，最省心。
 */
function puzzleModeTool() {
  return defineTool({
    name: 'puzzle_mode',
    description: TOOL_DESCRIPTION,
    parameters: {
      op: {
        type: 'string',
        required: true,
        description: 'list 列项目 / read 读状态 / show 读模块详情 / main-doc 读主文档全文（只读，供面板）/ init 新建项目（并绑定本会话）/ bind 绑定已有项目（替换全部绑定）/ bindings 列出本会话全部绑定与当前项目 / unbind 解绑本会话（带 project 只解一个）/ current 切换当前项目 / rebuild 重建文档格式（默认 dry-run）/ main 主文档小节 / module 模块文档小节 / write **一次写多处**（要写两节以上就用它，比逐节调快得多）/ health 写五维健康性 / mode 切换模式',
        enum: OPS,
      },
      project: { type: 'string', description: '项目名；省略时用本会话绑定的项目（没绑定就是空）。init 要求显式给（它会成为工作区里的文件夹名），bind 必须给' },
      goal: { type: 'string', description: 'init：这个项目要达成什么（一句话）' },
      modules: {
        type: 'array',
        description: 'init：要同时创建的模块名列表（每个模块一份文档）',
        items: { type: 'string' },
      },
      section: { type: 'string', description: `main：${SECTION_ORDER.join('/')}（主文档只有这四节）；module：${MODULE_SECTION_KEYS.join('/')}` },
      name: { type: 'string', description: 'module / show：模块名（module 时不存在则创建）' },
      content: { type: 'string', description: `要写入的正文（markdown 片段）；health 时为 \`维度名: 0-100\` 若干行。**条目式**小节（${SECTION_ORDER.join('/')}）每条必须是「一句话（源码: 文件:行）」；**字数上限随项目规模（小 / 中 / 大）变**，以 \`op:read\` / \`op:size\` 返回的 \`limits\` 为准（模块索引不要求出处）。超了报错不截断` },
      append: { type: 'boolean', description: 'true 追加到小节末尾，false 覆盖该小节；默认追加' },
      writes: {
        type: 'array',
        description: 'op:write：**一次写多处**。每条形如 `{ target:"main"|"module", section, name?, content, append? }`。'
          + '同一文件的多节会合并成**一次**读→解析→落盘（写大文档时比逐节调用快得多）。'
          + `一次最多 ${DOCIO_MAX_WRITES} 条；超出的逐条进 errors 并提示分次调。`
          + '某一条校验失败**不影响**其余条（逐条报错，不连坐）。',
        items: {
          type: 'object',
          // ⚠️ 宿主 `defineTool` 的 schema DSL 对 `items` 有两条硬要求，**必须都写**，
          // 否则它在构造时抛 `unsupported JSON schema`——而抛错发生在
          // `puzzleModeTool()` 里，`installSessionTools` 会把它 catch 成 `tool:false`，
          // 表现是「工具静默没装上」，非常难查（实测踩过）：
          //   1. **不能写 `required`**（DSL 不支持 items.required）；
          //   2. **`additionalProperties` 必须显式** true/false。
          // 必填校验交给 `planWrites`（它逐条给 error/hint，比 schema 拒绝更有用）。
          additionalProperties: true,
          properties: {
            target: { type: 'string', enum: ['main', 'module'], description: 'main 主文档 / module 模块文档' },
            section: { type: 'string', description: '要写的小节名（与 op:main / op:module 的 section 同一套）' },
            name: { type: 'string', description: 'target:"module" 时的模块名' },
            content: { type: 'string', description: '该节正文（与 op:main / op:module 的 content 同一套规格）' },
            append: { type: 'boolean', description: '该条是追加还是覆盖；默认追加' },
          },
        },
      },
      apply: { type: 'boolean', description: 'rebuild：true 才落盘；不给或 false 只给预览（dry-run）' },
      all: { type: 'boolean', description: 'rebuild：true = 作用于本会话**全部绑定**的项目（多绑定时迁移是全局动作）；不给只作用于当前项目' },
      brief: { type: 'boolean', description: 'read：true 返回接续会话用的精简档（去掉每模块五维明细与五维说明表，附 readNext 指路），省上下文；默认 false 给全量' },
      source: { type: 'boolean', description: 'source：查/记源码根时用。源码体检（文件行数 / 最长函数 / 目录分层）只在 op:source 返回里给出' },
      path: { type: 'string', description: 'source：源码根目录的绝对路径（写进主文档 front-matter 的 源码根:）。传空串清掉。' },
      sourceRoot: { type: 'string', description: 'source：源码根目录的绝对路径。默认取「拼图目录的上一级」，但文档目录与源码目录常常不在一处（例如文档在 /sdcard/…/<项目>/拼图/、源码在 /root/.dsh/plugin-src/<包名>/），这时必须显式给，否则查不到源码' },
      mode: { type: 'string', description: `mode：${MODES.join(' / ')}`, enum: MODES },
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
      /**
       * `sessionId` **只服务 `op:settings`**（按会话禁用名单需要知道「是哪个会话」）。
       *
       * v8 起项目定位**不再用它**（面板全局化，项目与会话解绑）——所以它在这里是
       * 「一个 op 的可选参数」，不是「整条工具的身份」。这也是升级方案 §U3 里
       * 「客户端 sessionId 从面板的身份降级为一个可选参数」在宿主半的对应改动。
       */
      const sessionId = exec !== undefined && exec.agent !== undefined && exec.agent !== null
        && exec.agent.session !== undefined && exec.agent.session !== null
        ? exec.agent.session.id
        : undefined
      const resolved = located(args.project)
      const projectRoot = resolved.projectRoot
      const project = resolved.project
      const append = args.append !== false

      if (args.op === 'list') {
        return puzzleOpList({ args, sessionId, resolved, projectRoot, project, append })
      }

      if (args.op === 'workspace') {
        return puzzleOpWorkspace({ args, sessionId, resolved, projectRoot, project, append })
      }

      if (args.op === 'scan') {
        return puzzleOpScan({ args, sessionId, resolved, projectRoot, project, append })
      }

      // read / init / bind / settings 自己处理「没绑定」，其余写操作必须先有项目。
      // settings 按**会话**判定、与项目无关，所以也必须放行：否则「刚新建、还没绑定
      // 任何项目」的会话会被下面这句挡住，而它恰恰是最想关掉拼图模式的场景。
      if (project === '' && !['read', 'scan', 'init', 'bind', 'bindings', 'unbind', 'current', 'settings', 'workspace', 'main-doc'].includes(args.op)) {
        return failure(
          projectRoot === '' ? '还没绑定数据工作区' : '这个工作区里没有可用的拼图项目',
          projectRoot === ''
            ? '先用 op:workspace 并给 path 绑一个数据工作区（或在面板一级页绑定）；当前 op=' + args.op + ' 需要项目'
            : `先用 op:init 建一个（显式给 project 与 modules），或用 op:current 打开已有项目；当前 op=${args.op} 需要项目`,
        )
      }

      if (args.op === 'read') {
        return puzzleOpRead({ args, sessionId, resolved, projectRoot, project, append })
      }

      if (args.op === 'main-doc') {
        return puzzleOpMainDoc({ args, sessionId, resolved, projectRoot, project, append })
      }

      if (args.op === 'show') {
        return puzzleOpShow({ args, sessionId, resolved, projectRoot, project, append })
      }

      if (args.op === 'init') {
        return puzzleOpInit({ args, sessionId, resolved, projectRoot, project, append })
      }

      /**
       * `op:bind` / `op:unbind`：**v2.0.0 起已废弃**，但**不能静默忽略**。
       *
       * 为什么必须给明确提示而不是直接删掉这个 op：模型（尤其是长上下文里带着
       * 旧版提示段的那些）会照着老习惯调它。静默成功会让它以为「绑好了」，
       * 而实际上什么都没发生——那种假成功比报错难查得多。
       * 所以这里返回 `ok:false` + 一句说清「这条 op 已废弃、现在该用什么」。
       */
      if (args.op === 'bind') {
        return puzzleOpBind({ args, sessionId, resolved, projectRoot, project, append })
      }

      if (args.op === 'bindings') {
        return puzzleOpBindings({ args, sessionId, resolved, projectRoot, project, append })
      }

      if (args.op === 'current') {
        return puzzleOpCurrent({ args, sessionId, resolved, projectRoot, project, append })
      }

      if (args.op === 'rebuild') {
        return puzzleOpRebuild({ args, sessionId, resolved, projectRoot, project, append })
      }

      if (args.op === 'main') {
        return puzzleOpMain({ args, sessionId, resolved, projectRoot, project, append })
      }

      if (args.op === 'module') {
        return puzzleOpModule({ args, sessionId, resolved, projectRoot, project, append })
      }

      if (args.op === 'write') {
        return puzzleOpWrite({ args, sessionId, resolved, projectRoot, project, append })
      }

      if (args.op === 'health') {
        return puzzleOpHealth({ args, sessionId, resolved, projectRoot, project, append })
      }

      if (args.op === 'source') {
        return puzzleOpSource({ args, sessionId, resolved, projectRoot, project, append })
      }

      if (args.op === 'mode') {
        return puzzleOpMode({ args, sessionId, resolved, projectRoot, project, append })
      }

      if (args.op === 'size') {
        return puzzleOpSize({ args, sessionId, resolved, projectRoot, project, append })
      }

      if (args.op === 'settings') {
        return puzzleOpSettings({ args, sessionId, resolved, projectRoot, project, append })
      }

      return failure(`未知 op ${String(args.op)}`, `可用：${OPS.join(' / ')}`)
    },
  })
}

/* ------------------------- 会话接线层的依赖装配 ------------------------- */

/**
 * **本进程已经给哪些会话装过大脑**（v2.2.0）。
 *
 * ## 为什么需要它（这条不是假想兜底，是重启后的真路径）
 *
 * 「一个项目一个大脑、已存在就复用」里的那个会话 id **落在设置文件里**，
 * 所以它会活过 DSH 重启；而人设段、冻结文档段、`puzzle_brain` 工具都是
 * **挂在 agent 作用域上的运行时对象**，重启后一律消失。
 *
 * 于是「重启 → 点全局大脑」若直接复用，用户拿到的是一个**没有灵魂的空壳**，
 * 而面板显示「已复用」——看起来完全正常。这就是为什么复用那条路要补装一次。
 *
 * ## 为什么用一张名单去重，而不是「装了就不管」
 *
 * `dsh-scope` 的 `NamedEntries.insert` 对**同层同名**是直接抛错的
 * （`prompt section "x" is already registered in this scope`）。
 * 也就是说同一作用域上重复注册不是覆盖、是异常。所以补装前必须先问一句
 * 「本进程给它装过没有」——只有没装过才装。
 *
 * 与 `installedScopes`（`WeakSet`）的分工：那个防的是**同一作用域对象**
 * 重复装 `puzzle_mode`，这个是按**会话 id** 记录「大脑装过没有」——
 * 重启后作用域是新的对象，而 id 还是老的那个，两者回答的问题不同。
 */
const brainInstalledSessions = new Set()

/**
 * **把澄清结果写回那一张卡**（v2.2.0）：`puzzle_task` 工具的落点。
 *
 * ## 为什么只改这四个字段
 *
 * 澄清器的产物就是「标题 / 目标 / 描述 / 具体执行提示词」四样（用户拍板）。
 * 它**不搬卡、不建卡、不动别的卡**——那些是用户与全局大脑的事。
 * 所以这里只在这四处赋值，其余字段整份保留（`{...card}`）。
 *
 * ## 为什么 `frozenAt` 不在这里写
 *
 * 冻结是「用户拍板开工」的动作（`freezeCheck` 的判据是目标 + 执行交代）。
 * 让澄清器自己冻结等于**替用户决定开工**——而冻结之后这张卡就能被派出去花钱。
 * 所以它只写方案，冻结仍由用户在面板上点。
 *
 * ## 落盘为什么走 `writeBoard`
 *
 * 卡在 `<工作区>/拼图/<项目名>/派单/<卡 id>.json`（**项目级 + 一卡一文件**，v2.4.9），
 * 受插件自己的文档锁保护（`isPuzzleDocPath` 会拦 `write` / `edit`）。绕过去会被自己的锁拦下，
 * 而且会绕过 `mkdirSync`。
 */
function writeClarifiedPlan(projectRoot, project, cardId, fields) {
  const board = readBoard(projectRoot, project)
  const cards = Array.isArray(board.cards) ? board.cards.slice() : []
  const at = cards.findIndex((item) => item.id === cardId)
  if (at < 0) return { ok: false, error: '找不到这张任务单：' + String(cardId), hint: '它可能已经被删掉了。' }
  const card = cards[at]
  const plan = card.plan !== null && card.plan !== undefined ? { ...card.plan } : {}
  const text = (value) => (typeof value === 'string' ? value.trim() : '')
  const title = text(fields.title)
  const objective = text(fields.objective)
  const description = text(fields.description)
  const execution = text(fields.executionPrompt)
  if (execution === '') {
    return { ok: false, error: '具体执行提示词是空的', hint: '它是执行会话唯一的起点，不能空着写回。' }
  }
  if (title !== '') {
    card.title = shortTitle(title, 60)
    plan.title = card.title
  }
  if (objective !== '') plan.objective = objective
  if (description !== '') plan.description = description
  plan.executionPrompt = execution
  card.plan = plan
  card.updatedAt = Date.now()
  cards[at] = card
  const written = writeBoard(projectRoot, project, cards)
  if (written !== undefined && written !== null && written.ok === false) {
    return { ok: false, error: '写看板失败：' + String(written.error), hint: written.hint }
  }
  return {
    ok: true,
    card: { id: card.id, title: card.title, objective: plan.objective, executionPrompt: plan.executionPrompt },
    hint: '已经写回任务单 ' + card.id + '。这一轮澄清到此结束。',
  }
}

/**
 * 组装 `dispatchrun.js` 要的 `deps`（澄清器 / 派单 / 全局大脑**共用一份**）。
 *
 * ## 为什么抽出来（v2.2.0）
 *
 * 大脑那条 RPC 与 `task` 的 clarify / dispatch 需要**同一批**能力
 * （取数口、注入器、会话服务、看板读写）。三处各拼一份的必然结果是
 * 「某一条路少给了一个键」，而那种缺陷不报错——只是某个能力静默缺失
 * （比如大脑没有汇报通道、澄清器没有文档段）。一份装配、三处调用。
 *
 * ## `project` 为什么由调用方给
 *
 * `brain` 那条 RPC 走的是「面板当前打开的项目」，而 clarify / dispatch 用的是
 * 请求里解析出来的那个。两者来源不同（一个来自设置、一个来自请求体），
 * 所以不能在这里自己解析——那会把两条路的语义混成一个。
 */
function dispatchDepsOf(ctx, projectRoot, project, settings) {
  const mainRead = readMainDoc(projectRoot, project)
  const mainText = mainRead.ok === true ? mainRead.text : ''
  const indexText = mainText === ''
    ? ''
    : (getSection(parseFrontMatter(mainText).body, SECTION_HEADINGS.index) ?? '')
  return {
    readBoard: () => readBoard(projectRoot, project),
    writeBoard: (cards) => writeBoard(projectRoot, project, cards),
    settings,
    project,
    dataWorkspace: dataWorkspaceRoot(settings),
    moduleIndex: indexText,
    mainDoc: mainText,
    /**
     * **专属检索工具的取数口**（用户拍板第二条）。
     *
     * ## 全部字段都是 thunk，而且**只读自己那一份**
     *
     * 这里原先的写法是「一进来就 `readState` + 循环读全部模块文档」，把 `modules`
     * （全部模块正文）与 `docs`（全部文档正文）都建出来——**文档越大越慢**，
     * 而 `op:main`（绝大多数调用）根本用不上它们。用户报的「读拼图文档慢」与
     * 「大脑写文档受规模影响」都指向这里。
     *
     * 现在每个 thunk 各自惰性：`mainDoc` 只读主文档、`moduleOf(name)` 只读那**一个**
     * 模块（`clarifierLookup` 优先用它，取 1 个就真只读 1 个）、`modules` / `docs`
     * 只在对应 op 真的需要全表时才建。
     *
     * ## `codeAvailable` 为什么是**值**不是 thunk
     *
     * 它必须在**检索之前**就能回答「这台部署查不查得了代码」，否则「没配代码根」
     * 会被报成「代码里没有这件事」。判据只是 `statSync` 一次，不读文件内容。
     */
    clarifierSource: () => {
      /**
       * `state` 也惰性：它本身会循环读全部模块文档（`moduleEntries`），
       * 而 `op:main` / `op:module` 只需要主文档与个别模块。只在要全表时才取。
       */
      let stateCache = null
      const stateOf = () => {
        if (stateCache === null) stateCache = readState(projectRoot, project)
        return stateCache
      }
      let mainCache
      const mainOf = () => {
        if (mainCache === undefined) {
          const full = readTextCached(join(puzzleDirOf(projectRoot, slugify(project)), MAIN_FILE))
          mainCache = typeof full === 'string' ? full : ''
        }
        return mainCache
      }
      /** 读**一个**模块：先查 `state`（有文件路径），没有就按约定路径拼。 */
      const moduleFileOf = (name) => {
        const wanted = typeof name === 'string' ? name : ''
        if (wanted === '') return ''
        const hit = stateOf().modules.find((one) => one.name === wanted)
        return hit !== undefined && typeof hit.file === 'string' ? hit.file : ''
      }
      const codeRootOf = () => {
        const root = stateOf().sourceRoot
        return typeof root === 'string' ? root : ''
      }
      let codeOk
      const codeAvailableOf = () => {
        if (codeOk === undefined) {
          const root = codeRootOf()
          if (root === '') codeOk = false
          else {
            try {
              codeOk = statSync(root).isDirectory()
            } catch (_error) {
              codeOk = false
            }
          }
        }
        return codeOk
      }
      return {
        mainDoc: () => mainOf(),
        moduleIndex: () => {
          const text = mainOf()
          return text === '' ? '' : (getSection(parseFrontMatter(text).body, SECTION_HEADINGS.index) ?? '')
        },
        // **按名字读一个**：`clarifierLookup` 优先用它，取 1 个模块就真只读 1 个文件。
        moduleOf: (name) => {
          const file = moduleFileOf(name)
          if (file === '') return undefined
          const text = readTextCached(file)
          return typeof text === 'string' ? text : undefined
        },
        modules: () => {
          const out = {}
          for (const one of stateOf().modules) {
            const text = readTextCached(one.file)
            if (typeof text !== 'string') continue
            out[one.name] = text
          }
          return out
        },
        docs: () => {
          const out = []
          for (const one of stateOf().modules) {
            const text = readTextCached(one.file)
            if (typeof text !== 'string') continue
            out.push({ file: one.file, text })
          }
          const full = mainOf()
          if (full !== '') out.push({ file: stateOf().mainDoc, text: full })
          return out
        },
        code: () => collectSourceFiles(codeRootOf()),
        codeAvailable: codeAvailableOf(),
      }
    },
    installClarifier,
    installBrain,
    /**
     * **写任务单的落点**（v2.2.0）：澄清器的 `puzzle_task` 工具走这里。
     *
     * 闭包住 `projectRoot`，所以工具只能改**这个项目**看板上的那一张卡；
     * `cardId` 由 `runClarify` 在装工具时给（它知道自己是谁派出去的）。
     * 落盘走与面板同一个 `writeBoard`——同一份原子写、同一份卡片形状。
     */
    installTaskWriter: (agent, options) => {
      const cardId = options !== null && options !== undefined && typeof options.cardId === 'string' ? options.cardId : ''
      return installTaskWriter(agent, { write: (fields) => writeClarifiedPlan(projectRoot, project, cardId, fields) })
    },
    // v2.1.1：把 `puzzle_mode` 与拼图规则装进派单子会话。
    // 这是**唯一**会自动装上插件的路径（根作用域不再注册任何东西）。
    installSessionTools,
    /**
     * **只记「已装会话」名单，不注册任何东西**（v2.4.15，用户拍板）。
     *
     * 执行会话**不装 `puzzle_mode`**（文档只由全局大脑写），但它仍然挂着
     * `pz_*`，而 `tools/post-execute` 的越界提醒（T4）靠 `isSessionWired`
     * 判断「这个会话要不要提醒」。所以名单要记，工具不装。
     *
     * 与 `installSessionTools` 分开两个口子，而不是给它加个开关参数：
     * 两件事的**语义不同**（一个装、一个只登记），共用一个函数会让
     * 「到底装没装」变成调用方要记住的事——而那是最容易记错的地方。
     */
    markSessionWired: (agent) => {
      const sessionId = agent !== null && agent !== undefined && typeof agent.id === 'string' ? agent.id : ''
      if (sessionId === '') return { ok: false, reason: '这个会话拿不到 id' }
      markWired(sessionId)
      return { ok: true }
    },
    // T1–T4：派单会话的专属工具（`runClarify` **不用**它，见 scopedtools.js 文件头）。
    installScopedTools,
    // 大脑登记（v2.2.0）：一个项目一个会话，跨面板重开保持。
    brainSessionOf: (name) => brainSessionOf(name, readSettings()),
    rememberBrain: (name, id) => setBrainSession(name, id),
    forgetBrain: (name) => forgetBrainSession(name),
    // 「本进程给它装过大脑没有」：复用那条路要据此决定补不补装（见那张名单的注释）。
    brainInstalledIn: (sessionId) => brainInstalledSessions.has(sessionId),
    noteBrainInstalled: (sessionId) => brainInstalledSessions.add(sessionId),
    /**
     * 「这张卡的 goal 现在什么状态」——大脑的汇报要用。
     *
     * 拿不到就返回 `undefined`，由 `taskReports` 如实写成「拿不到实时 goal」。
     * 这里**不抛错**：汇报是一条只读的旁路，它失败不该让工具调用整个失败。
     */
    liveGoalOf: (sessionId) => {
      try {
        const goals = ctx.get('goals')
        const agents = ctx.get('agents')
        if (goals === null || goals === undefined || typeof goals.get !== 'function') return undefined
        if (agents === null || agents === undefined || typeof agents.get !== 'function') return undefined
        const agent = agents.get(sessionId)
        if (agent === null || agent === undefined) return undefined
        return goals.get(agent)
      } catch (_error) {
        return undefined
      }
    },
    // 懒取：拿不到就是 undefined，由 dispatchrun 如实报错。
    sessionController: ctx.get('sessionController'),
    goals: ctx.get('goals'),
    agentOf: (id) => {
      const agents = ctx.get('agents')
      if (agents === null || agents === undefined || typeof agents.get !== 'function') return undefined
      return id === '' ? undefined : agents.get(id)
    },
  }
}

/**
 * 全局大脑那条 RPC 的 deps：项目取「面板当前打开的那个」。
 *
 * 为什么与 `dispatchDepsOf` 分开一个入口而不是传空 project：
 * 大脑**必须有项目**（它是项目级的），而 clarify / dispatch 的 project 来自请求。
 * 这里自己解析一次，缺项目时由 `runBrain` 如实拒绝。
 *
 * ⚠️ `ctx` **必须由调用方传**：本函数在 `apply(ctx)` 之外，捕获不到那个参数。
 */
function brainDeps(ctx) {
  const settings = readSettings()
  const projectRoot = dataWorkspaceRoot(settings)
  const project = openProjectOf(settings)
  return dispatchDepsOf(ctx, projectRoot, project, settings)
}


export function apply(ctx) {
  registerBrainCompaction(ctx)
  registerDocLock(ctx)
  registerDispatchBoundary(ctx)
  registerGoalWatch(ctx)
  registerRpcChannel(ctx)
}

/**
 * **执行完成 → 搬卡 + 汇报全局大脑**（v2.2.9）。
 *
 * ## 补的是什么
 *
 * 界面上写着「做完自动落到「已做」」，但 `verdictOf` / `observeOf`
 * **从来没有被调用过**——派出去之后的卡永远停在「在做」，成败都看不出来。
 * 这一段把那条断掉的线接上，并在成功时把结论投给大脑（由它回写文档）。
 *
 * ## 为什么听 `goal/changed`
 *
 * 宿主 `dsh-goal` 在每次 goal 变更后 emit 它（`{agent, change}`，相位在
 * `change.goal.phase`）；DSH 自己的 `dsh-goal-round-driver` 就是这么听的。
 * 它**变更即达**，比轮询既快又不空转。
 *
 * ⚠️ 它不是 `session/event`：goal 变更走 agent 作用域的事件总线。
 *
 * ## 失败为什么只记日志
 *
 * 搬卡是本地写盘，汇报要投消息（可能失败）。这条钩子是 emit 监听，
 * **抛错会被宿主记成监听器异常**；而且「汇报失败」不该让用户看到一条
 * 与看板无关的红字。所以整段包 try/catch，失败走 `logFailure` 留痕。
 */
function registerGoalWatch(ctx) {
  if (typeof ctx.on !== 'function') return
  /**
   * `goals` / `agents` 都是**懒取**：本钩子在 `apply` 期注册，
   * 而那两个服务可能还没就绪（拿不到就什么都不做，下一轮事件还会来）。
   *
   * ## v2.4.3：看板变成项目级之后，这里必须**先找出这张卡属于哪个项目**
   *
   * 事件里只有 `agent`（于是只有 `sessionId`），没有项目名。而看板现在
   * 一份只装一个项目，所以「读哪一份」成了必须先回答的问题。
   *
   * 答案是**按 sessionId 扫一遍全部项目的看板**：卡上的 `sessionId` 是派单时
   * 落下的（`runDispatch` 的「先落 sessionId」），所以这是**确定**的对应关系，
   * 不靠标题或时间猜——`applyGoalChange` 内部本来也是按它找卡的。
   *
   * 扫不到时（卡被删了、项目被删了、事件来自别的插件的 goal）返回 `null`，
   * 由 `applyGoalChange` 走它原有的「看板上没有卡挂着这个会话」那条路。
   * **不退回工作区级旧路径**——那条路已经不存在了，硬退回只会读到空看板。
   */
  const boardOfSession = (sessionId) => {
    const root = dataWorkspaceRoot()
    if (root === '' || sessionId === '') return null
    for (const name of boundProjects(root)) {
      const board = readBoard(root, name)
      if (board.cards.some((card) => card !== null && card !== undefined && card.sessionId === sessionId)) {
        return { root, project: name, board }
      }
    }
    return null
  }
  const depsOf = (sessionId) => {
    const found = boardOfSession(sessionId)
    return {
      readBoard: () => (found === null ? { ok: true, file: '', cards: [], empty: true } : found.board),
      writeBoard: (cards) => (found === null
        ? { ok: false, error: '找不到这张卡属于哪个项目' }
        : writeBoard(found.root, found.project, cards)),
      sessionController: ctx.get('sessionController'),
      brainSessionOf: (name) => brainSessionOf(name, readSettings()),
      /**
       * **清掉当前 goal**（v2.4.15，用户报「做完了不去除目标」）。
       *
       * 契约（`Service` 检查器原文）：`clear(agent, ref): GoalRef` ——
       * 「Clear the current goal while retaining a durable tombstone and history」。
       * `ref` 是**期望的当前 revision**，不符会抛 `GOAL_STALE_REVISION`。
       *
       * `ref` 由 `completion.js` 从事件的 `change.ref` 造好（那是提交后的新快照，
       * 正是当前 revision），所以这里**只透传、不重算**——两处各算一次必然漂移。
       *
       * 拿不到 `goals`（或它没有 `clear`）时返回 `undefined`：调用方如实报
       * `cleared:false`，**不抛**——「这台部署没有 clear」不该让搬卡那条路崩掉。
       */
      clearGoal: (agent, ref) => {
        const goals = ctx.get('goals')
        if (goals === null || goals === undefined || typeof goals.clear !== 'function') return undefined
        return goals.clear(agent, ref)
      },
    }
  }
  ctx.on('goal/changed', ({ agent, change }) => {
    try {
      const sessionId = sessionIdOf(agent)
      const result = applyGoalChange(depsOf(sessionId), agent, change)
      // `applyGoalChange` 是 async（要投消息），失败必须自己接住——
      // 未处理的 rejection 在 emit 监听里会被宿主记成异常。
      Promise.resolve(result).then((outcome) => {
        /**
         * 只在**真出问题**时留痕。`skipped` 的那些是常态（相位无关、
         * 已搬到失败列、用户还没建过大脑）——把它们也记成故障，真故障会淹在噪音里。
         */
        if (outcome.skipped !== true && outcome.moved !== true) {
          logFailure('钩子:执行完成搬卡', 'goal 变更没能搬卡', outcome.reason, {
            sessionId: sessionIdOf(agent),
          })
        }
        if (outcome.moved === true && outcome.reported !== true && outcome.skipped !== true) {
          logFailure('钩子:执行完成汇报', '搬卡成功但没汇报给大脑', outcome.reason, {
            sessionId: sessionIdOf(agent),
          })
        }
        /**
         * ⚠️ 清 goal 单独分账，**不能拿 `skipped` 判**（v2.4.15）：
         * 卡完成、用户还没建过大脑时 `skipped === true`（那是「汇报跳过」），
         * 与「清 goal 失败」会同时成立。所以只认 `cleared` 这个真值。
         */
        if (outcome.moved === true && outcome.cleared !== true) {
          logFailure('钩子:执行完成清 goal', '搬卡成功但没清掉 goal', outcome.clearReason || outcome.reason, {
            sessionId: sessionIdOf(agent),
          })
        }
      }).catch((error) => {
        logFailure('钩子:执行完成搬卡', '处理 goal 变更时抛错', error, { sessionId: sessionIdOf(agent) })
      })
    } catch (error) {
      logFailure('钩子:执行完成搬卡', '处理 goal 变更时同步抛错', error, { sessionId: sessionIdOf(agent) })
    }
  }, 'dsh-puzzle-mode: 执行完成搬卡 + 汇报大脑')

  /**
   * **兜底**：`goal/changed` 之外，再听一次**每轮结束**。
   *
   * ## 为什么必须有它
   *
   * 上面那条钩子只在 `goal/changed` 上走，而**模型不调 `update_goal` 时那个事件
   * 永远不会来**：真机 2026-10-16 卡 task-0001 派出后 44 分钟零条自动痕迹，
   * goal 停在 `active`，于是搬卡 / 清 goal / 汇报三件事一件都没发生。
   * 执行会话每一轮结束都会发 `session/event` 的 `turn/end`，那条是**一定会到**的。
   *
   * ## 为什么每轮都触发却不会误搬
   *
   * 判据全在 `verdictOf`（Q7 那张表）里，这里**不另写**任何判据：
   *   - 相位还是 `active` 且 goal 仍 `armed`、或 agent 在跑 → 列不变 → 不写盘；
   *   - 只有 ①完成 / ②blocked / ③本轮是 `error` 结束 / ④`active + disarmed +
   *     不运行` 已持续超过 `STALL_MS`（10 分钟）这四种才换列。
   * 也就是说「每轮触发」只增加**检查次数**，不放松任何一条判据。
   *
   * ## `stoppedForMs` 怎么算（判据④要的「已停止多久」）
   *
   * 卡上的 `columnChangedAt` / `updatedAt` 是**派单时刻**，不是停止时刻，不能拿来当它。
   * 这里用本进程内的一张表 `idleSince`：某轮结束时**第一次**看到这个会话
   * 「不在跑」就记下那一刻，之后每轮再看到「不在跑」才把
   * `Date.now() - idleSince` 当作已停止时长交给 `verdictOf`。
   * 语义是**「本进程连续观测到它不在跑」的时长**——它是真实停止时长的一个**下界**，
   * 不是猜出来的数；一次都没观测到不在跑就**不传**这个字段（判据④不触发）。
   * 会话重新在跑时立刻把那条记录删掉（连续观测中断，重新计时）。
   *
   * ⚠️ 按宿主源码，这个分支目前**几乎不会成立**：`turn/end` 是在
   * `dsh-agent-loop` 的 `turn()` 里 append 的，而 agent 的相位要到 `kick()` 的
   * `finally`（`turn()` 返回**之后**）才落回 `idle`，所以这条钩子跑的时候
   * `agent.status` 仍是 `'running'`。因此判据④是「宁可漏一次」的那一侧，
   * 真正兜住的是判据③（见下）。
   *
   * ## `lastAgentError` 从 `turn/end` 的结束原因取
   *
   * 判据③要的「会话级报错」在宿主里对应 `agent/error`，而 `agent/error`
   * **不是** `session/event`（它是 agent 作用域的事件），这条钩子拿不到。
   * 但 `turn/end` 的 `data.reason` 在会话报错时就是
   * `{kind:'error', error: LlmFailure}`（`dsh-agent-loop` 的 `turnEnds`），
   * 所以取 `reason.error.message` 喂给 `observeOf` 的 `lastAgentError`——
   * 那是**同一件事在日志里的那一份**，不是另造判据。
   * 只有 `kind === 'error'` 才算：`aborted`（用户按停）与 `interrupted` 不算失败，
   * 用户还可能 resume 接着做。
   *
   * ## 清 goal 的 ref
   *
   * `goals.get(agent)` 现读的视图按契约就是**当前** ref
   * （`GoalView extends GoalSnapshot extends GoalRef`），直接把它传下去；
   * 这条路上没有 `goal/changed` 事件可借 `change.ref`（见 `completion.js` 的说明）。
   *
   * ## 常态不记故障
   *
   * 装了插件的会话不止派单会话（澄清器 / 全局大脑也在 `wiredSessions` 名单里），
   * 它们的每一轮结束都会走到这里，而看板上没有卡挂着它们——那是**常态**，
   * `applyObserved` 如实报 `skipped`，这里据此**不写**故障日志，否则真故障会淹掉。
   */
  const idleSince = new Map()
  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = sessionIdOf(session)
      if (sessionId === '' || !isSessionWired(sessionId)) return
      if (event === null || event === undefined || typeof event !== 'object') return
      if (event.type !== 'turn/end') return

      const agents = ctx.get('agents')
      const agent = agents !== null && agents !== undefined && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
      if (agent === null || agent === undefined) return

      const goals = ctx.get('goals')
      if (goals === null || goals === undefined || typeof goals.get !== 'function') return
      let view
      try {
        view = goals.get(agent)
      } catch (_error) {
        // `goals.get` 对「不是本注册表那个 live 实例」的 agent 会抛 `GoalError`
        // （见 `liveOf` 的同一条注释）——那是常态，不是故障，什么都不做。
        return
      }
      if (view === null || view === undefined) return

      const running = agent.status === 'running'
      const now = Date.now()
      const options = {}
      if (running) {
        idleSince.delete(sessionId)
      } else {
        const since = idleSince.get(sessionId)
        if (since !== undefined) options.stoppedForMs = now - since
        else idleSince.set(sessionId, now)
      }
      const data = event.data !== null && event.data !== undefined && typeof event.data === 'object' ? event.data : {}
      const reason = data.reason !== null && data.reason !== undefined && typeof data.reason === 'object' ? data.reason : {}
      if (reason.kind === 'error') {
        const failure = reason.error
        const message = failure !== null && failure !== undefined && typeof failure.message === 'string' ? failure.message : ''
        options.lastAgentError = message !== '' ? message : String(failure)
      }

      const observed = observeOf(view, { running }, options)
      const result = applyObserved(depsOf(sessionId), agent, observed, { id: view.id, revision: view.revision })
      // 与上面那条钩子同一条纪律：async 失败必须自己接住，未处理的 rejection
      // 在 emit 监听里会被宿主记成异常。
      Promise.resolve(result).then((outcome) => {
        /**
         * 真搬了列就把这条计时放掉：这张卡已经离开「在做」，之后它的 `turn/end`
         * 只会走 `verdict.column === card.column` 那条（列没变）。留着就是一条
         * 只增不减的记录。
         */
        if (outcome.moved === true) idleSince.delete(sessionId)
        // `skipped` 是常态（列没变 / 没有卡挂着这个会话 / 已搬到失败列），不记故障。
        if (outcome.skipped !== true && outcome.moved !== true) {
          logFailure('钩子:兜底搬卡', '轮次结束时没能搬卡', outcome.reason, { sessionId })
        }
        if (outcome.moved === true && outcome.reported !== true && outcome.skipped !== true) {
          logFailure('钩子:兜底汇报', '兜底搬卡成功但没汇报给大脑', outcome.reason, { sessionId })
        }
        if (outcome.moved === true && outcome.cleared !== true) {
          logFailure('钩子:兜底清 goal', '兜底搬卡成功但没清掉 goal', outcome.clearReason || outcome.reason, { sessionId })
        }
      }).catch((error) => {
        logFailure('钩子:兜底搬卡', '处理轮次结束时抛错', error, { sessionId })
      })
    } catch (error) {
      logFailure('钩子:兜底搬卡', '处理轮次结束时同步抛错', error, { sessionId: sessionIdOf(session) })
    }
  }, 'dsh-puzzle-mode: 轮次结束兜底搬卡')
}


/** 见本文件顶部对这一段职责的说明。 */
function registerBrainCompaction(ctx) {
/* ------------------ 全局大脑：压缩时刷新那一段文档 ------------------ */

/**
 * **用户拍板的语义**：「全局大脑的上下文中拼图文档那一块没压缩时是冻结的，
 * 直到压缩时才重新更新上下文中的拼图文档段。」
 *
 * ## 为什么监听的是 `session/event` 里的 `compaction/end`
 *
 * 压缩是宿主的事（`dsh-compaction` 的 `compaction/start` → `summary` → `end`），
 * 插件**只听**，不自己数 token、不自己算阈值——那会造出第二套判据，
 * 而两套判据迟早不一致（表现是「该更新的时候没更新」）。
 *
 * 选 `compaction/end` 而不是 `start`：`end` 是「压缩真的做完了」的那一刻，
 * 此时读盘拿到的就是压缩后的现状。在 `start` 时读会读到压缩**前**的文档，
 * 而那与它接下来要用的上下文并不对应。
 *
 * ⚠️ **`error` 字段**：`compaction/end` 带上 `error` 时表示这次压缩失败了。
 * 失败就不刷新——文档段保持原样（旧的冻结快照），这与「没压缩」是同一种状态。
 *
 * ## 为什么这条钩子**不**过 `isSessionWired`
 *
 * 大脑会话**本来就是**已装会话（`runBrain` 会调 `installSessionTools`），
 * 所以名单判断在这里是多余的。真正决定「管不管」的是 `isBrainSession`——
 * 只有登记过 holder 的会话才有那一段可刷新。别的会话即使被压缩，
 * 这里也什么都不做。
 */
if (typeof ctx.on === 'function') {
  ctx.on('session/event', (session, event) => {
    try {
      if (session === null || session === undefined || typeof session !== 'object') return
      const sessionId = typeof session.id === 'string' ? session.id : ''
      if (sessionId === '' || !isBrainSession(sessionId)) return
      if (event === null || event === undefined || typeof event !== 'object') return
      if (event.type !== 'compaction/end') return
      const data = event.data !== null && event.data !== undefined && typeof event.data === 'object' ? event.data : {}
      // 压缩失败不刷新：文档段保持旧的冻结快照，与「没压缩」是同一种状态。
      if (typeof data.error === 'string' && data.error !== '') return
      /**
       * 重读用的是**这个会话登记时存下的取数口**（holder 自己记着），
       * 因为压缩事件里没有项目上下文。读的是**当前打开的项目**——
       * 与大脑当初建出来时的项目一致（它是项目级的，不会跟着面板切换而变）。
       */
      /**
       * `refreshBrainDoc` **自己不抛错**（它跑在 emit 监听里，抛错会被宿主记成
       * 监听器异常），失败以 `{ok:false, reason}` 返回。所以这里必须看返回值——
       * 不看的话「压缩后文档段还是旧的」就是一条**完全静默**的失败。
       */
      const refreshed = refreshBrainDoc(sessionId)
      if (refreshed.ok !== true) {
        logFailure('钩子:大脑文档段刷新', '压缩后重读文档段没成功', refreshed.reason, { sessionId })
      }
    } catch (error) {
      // 观察失败绝不影响会话：漏一次刷新而已，下一次压缩还会来。
      // 但它**必须留痕**——「压缩后文档段还是旧的」在界面上看不出来。
      logFailure('钩子:大脑文档段刷新', '压缩后重读文档段失败', error, { sessionId: sessionIdOf(session) })
    }
  }, 'dsh-puzzle-mode: 全局大脑文档段（压缩时刷新）')

  /**
   * 会话被回收时清掉登记：`brainSessions` 里那条 id 仍留着（下次呼出时
   * `runBrain` 会探活并另起一个），但进程内的 holder 必须放掉——
   * 不放就是一条永久的内存引用，而它的键是一个已经不存在的会话。
   */
  ctx.on('session/disposed', (session) => {
    const disposedId = session !== null && session !== undefined && typeof session.id === 'string' ? session.id : ''
    try {
      if (disposedId === '') return
      forgetBrainHolder(disposedId)
      // 「装过没有」那张名单也要清：会话没了，它的作用域也就没了。
      brainInstalledSessions.delete(disposedId)
    } catch (error) {
      /* 清理失败不该影响会话销毁 */
      logFailure('钩子:大脑登记清理', '会话销毁时清登记失败', error, { sessionId: disposedId })
    }
  }, 'dsh-puzzle-mode: 全局大脑登记清理')
}

}

/** 见本文件顶部对这一段职责的说明。 */
function registerDocLock(ctx) {
/* --------------- 文档锁（保留） + 只拼不写拦截（v2.0.0 暂时禁用） --------------- */

if (typeof ctx.on === 'function') {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    // 已经有人拒了就别插话；没有 agent 的派发（如子流程）一律放行。
    if (decision !== null && typeof decision === 'object' && decision.kind === 'deny') return decision
    if (exec === null || typeof exec !== 'object') return decision
    const toolName = typeof exec.name === 'string' ? exec.name : ''
    if (toolName === '' || PUZZLE_ONLY_ALLOWED_TOOLS.includes(toolName)) return decision

    /**
     * ⚠️ **这条钩子是全插件唯一不加「已装会话」判断的注入类钩子**（v2.1.1 拍板）。
     *
     * ## 为什么它必须例外
     *
     * 用户要的是「普通会话不要有插件的工具、不要受插件影响」——指的是**模型面**：
     * 别让模型多看见一个工具、多读一段规则。文档锁不是那件事。
     *
     * 它是**数据完整性**：拼图文档只能由 `puzzle_mode` 改，否则条目限长 /
     * 条数上限 / slug 过滤 / 路径守卫会被一次普通 `write` 全部绕过。
     * 加了名单判断就等于：任何**没装插件的会话**都能随手把 `拼图/主文档.md`
     * 覆写成一个任意形状的文件，而插件下一次读它就会崩或被静默绕过。
     * 「没装插件」恰恰是最常见的状态——那道防线会变成一条默认关闭的线。
     *
     * ## 代价（如实写）
     *
     * 一个完全不知道拼图模式存在的会话，写 `拼图/` 下的文件时会收到一句
     * 「拼图文档只能由 puzzle_mode 改」——它可能觉得莫名其妙。
     * 这个代价换的是「文档不会被绕过锁改写」，**取值明显更大**。
     * 而且被拦的条件很窄：路径落在**已绑定数据工作区的某个项目的 `拼图/` 下**。
     */
    const target = docTargetOf(toolName, exec.arguments)
    // 拼图文档只能由 puzzle_mode 改，否则条目限长 / 条数上限 / slug 过滤 / 路径守卫
    // 会被一次 write 全部绕过。没绑定的会话、两个可执行模式，同样拦。
    //
    // ⚠️ **必须用 `docTargetOf`（收原始入参）而不是 `docMutationTarget`（收已解析对象）**：
    // 实测（2026-10-08 会话日志）`exec.arguments` 是**字符串**（248/248 条），
    // 而 `docMutationTarget` 内部按对象读 → `typeof '...' === 'object'` 为假 →
    // 一律当空对象 → **这条防线从来没生效过**。它不报错，只是静默放行。
    if (target !== '') {
      return { kind: 'deny', reason: docLockReason(toolName, target) }
    }

    /**
     * ⚠️ **「只拼不写」的越权拦截在 v2.0.0 起禁用**（用户拍板）。
     *
     * 原判据是 `boundProjects(cwd, sessionId)`，而 v8 把绑定整体退场后它**没有等价替代**：
     * 按文件路径判会误伤同工作区里不知情的会话，按 cwd 判仍是隐式生效。误伤是用户当场
     * 撞上的，所以**先关掉**。代价：「只拼不写」这个模式下约束消失（选择器还在，拦不住写）。
     *
     * 重建路径（不在本版做）：全局设置里维护「哪些工作区受约束」/ 项目级开关 /
     * 进入项目时显式挑一个会话承担约束。
     *
     * ⚠️ **上面的文档锁必须原样保留**：它与绑定无关，继续拦「直接改拼图文档」。
     */
    return decision
  }, 'dsh-puzzle-mode: 文档锁（+ 只拼不写拦截，v2.0.0 起禁用）')
}

}


/** 见本文件顶部对这一段职责的说明。 */
function registerDispatchBoundary(ctx) {
/* --------------------- 派单边界提醒（T4） --------------------- */

  /**
   * **派单边界提醒（T4）**：六个 pz_* 的越界判定，**一处**统一。
   *
   * ## 为什么放这里而不是放进六个工具体内部
   *
   * 用户给的理由就是答案：**放工具内部浪费 token**。判定要取路径，就得让 schema
   * 跟着走，而 schema 压到最小正是 T1–T4 的目的。放这一处，六个工具的 schema
   * 一个字段都不用多。
   *
   * ## 行为：**提醒，不拦**（与 C4 一致）
   *
   * 落在这个会话工作目录之外时只附一句上下文，不 block。真正的写入边界由
   * ctx.fs 的沙箱层负责（writeText / ditText 内部会再判一道，拒绝时抛
   * FS_SANDBOX_DENIED）——**插件的提醒不是边界，沙箱才是**。
   *
   * ## 为什么不并进任何一条按步算额度的注入
   *
   * 边界提醒是**每次都该说**的：一次越界写被冷却吃掉，用户就永远不知道它越界了。
   */
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      if (decision === null || typeof decision !== 'object' || decision.kind !== 'accept') return decision
      if (exec === null || typeof exec !== 'object') return decision
      const toolName = typeof exec.name === 'string' ? exec.name : ''
      // 只有专属工具体走这条路；原版工具不归 T4 管（普通会话一律不动）。
      if (!SCOPED_TOOL_NAMES.includes(toolName)) return decision
      const agent = exec.agent
      const sessionId = agent !== undefined && agent !== null && typeof agent.id === 'string' ? agent.id : ''
      if (sessionId === '' || isSessionDisabled(sessionId)) return decision
      // v2.1.1 总闸：名单外的会话不该有 `pz_*`（它们只装进派单子会话），
      // 走不到这里就是名单丢了——宁可漏一次提醒，也不要按「它装了」去判。
      if (!isSessionWired(sessionId)) return decision
      const cwd = agent.session !== undefined && agent.session !== null
        && agent.session.header !== undefined && agent.session.header !== null
        && typeof agent.session.header.cwd === 'string'
        ? agent.session.header.cwd
        : ''
      const requested = pathOfScopedCall(toolName, toolArgs(exec.arguments))
      if (!outsideWorkspaceOf(requested, cwd)) return decision
      return {
        ...decision,
        additionalContexts: [
          ...(decision.additionalContexts ?? []),
          makeContextMessage(outsideNotice(requested, cwd), 'puzzle-dispatch-boundary'),
        ],
      }
    } catch (error) {
      // 与其余监听同一条原则：提醒失败**绝不能**影响工具结果。
      logFailure('钩子:派单边界提醒', '注入越界提醒失败', error, { sessionId: sessionIdOf(exec.agent), tool: toolNameOf(exec) })
      return decision
    }
  }, 'dsh-puzzle-mode: 派单边界提醒')
}

/** 见本文件顶部对这一段职责的说明。 */
function registerRpcChannel(ctx) {
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
        respond(res, 400, { ok: false, error: '请求正文必须是 { method, … } 对象' })
        return
      }
      /**
       * `sessionId` **v2.0.0 起是可选的**（用户拍板，见升级方案 §U3）。
       *
       * 为什么不再强制：面板是**全局**的——它属于「绑定的数据工作区」，不属于任何会话。
       * 用户不打开任何会话也能点开面板看项目列表，那时根本没有 sessionId 可传。
       * 原先「缺了直接 400」会把这种完全合法的用法挡在门外。
       *
       * 那它还剩什么用：`settings`（按会话禁用）需要它；「挑一个会话填草稿」那条
       * 新建流程也需要它。所以**保留但降级为可选参数**——需要的方法自己校验。
       */
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
      // 面板可以显式指定项目；不给就用「面板当前打开的那个」。
      const requested = typeof body.project === 'string' ? body.project : undefined
      const resolved = located(requested)
      const projectRoot = resolved.projectRoot
      const project = resolved.project

      const handler = RPC_HANDLERS[body.method]
      if (handler !== undefined) {
        /**
         * ⚠️ **必须 `await`**：多数 handler 是 `async`（`task` 的 delete / clarify /
         * dispatch、`brain`、`deleteSession` …），而它们**自己**负责 `respond()`。
         * 不 await 的话，handler 抛错会变成一条**浮空的 rejection**：响应永远不发，
         * 浏览器那边就是「点了没反应」，一直挂到超时——比报错难查得多
         * （本仓记过「静默失败比失败更糟」）。
         *
         * v2.4.0 起这条尤其要紧：`task action:'delete'` 会去 await
         * `workspaceRegistry.deleteSession`，那是一次**外部服务调用**，真会抛
         * （会话不存在 / 归档管理器没装 / 服务出错）。
         *
         * catch 里如实回 500 并留痕：**不吞**。吞掉就成了上面那种静默挂起。
         */
        try {
          await handler({ ctx, body, res, projectRoot, project, resolved, sessionId })
        } catch (error) {
          logFailure('RPC:' + String(body.method), '处理器抛错', error, { project, projectRoot })
          respond(res, 500, {
            ok: false,
            error: String(body.method) + ' 处理器出错：' + messageOf(error),
            hint: '这是宿主侧的异常，不是你的参数问题。日志在插件的故障日志里（见面板「日志」）。',
          })
        }
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
 * 面板的**项目列表**：一级页要的「有哪些项目、当前打开哪个、各自什么模式 / 健康性」。
 *
 * 为什么抽出来、而不是只在 `method:'state'` 里算一份（修的真实 bug）：
 * `mode` / `size` 这类**写操作**的返回原先只有 `summarize(...)`，里面**没有 `bindings`**。
 * 而客户端 `mergePanelData` 只在「新值缺这个键」时保留旧值——于是写完模式后，
 * 列表上那个项目的模式仍是**改动前**那个，看起来就是「点了又自己弹回去」。
 *
 * 实测（真实 RPC，不是推断）：点「边拼边写」后返回
 * `bindings: undefined` / `currentProject: undefined`，只有 `state` 带这两项。
 * 所以**凡是要让面板重画的项目级写操作，都必须回同一份项目列表**。
 *
 * ⚠️ **字段名 `bindings` / `currentProject` 保持不变**（v8 也没改名）：
 * 客户端半、契约测试、面板渲染全都按这两个名字取数。改名的收益只是「名字更贴切」，
 * 代价是一次横跨浏览器半与宿主半的重命名——那是纯风险，没有功能收益。
 * 语义已经在 v8 换了（从「本会话绑定」变成「工作区里的全部项目」），
 * 名字与语义的这层错位在这里说清即可。
 */
function projectPanel(projectRoot, project, panelState) {
  const names = boundProjects(projectRoot)
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
    /** 数据工作区：面板一级页要显示「文档放哪」并给绑定入口。 */
    workspace: {
      workspaceId: readSettings().workspaceId,
      workspacePath: readSettings().workspacePath,
      bound: readSettings().workspacePath !== '',
      projectRoot,
    },
  }
}

/**
 * 从一个会话对象里取 id，取不到回空串。
 *
 * 为什么单独一个函数：日志要记「哪个会话出的问题」，而 `session/event` 与
 * `session/disposed` 的入参在宿主版本之间可能少字段。抛错会让**日志本身**
 * 变成新的故障点，那就本末倒置了。
 */
function sessionIdOf(session) {
  return session !== null && session !== undefined && typeof session.id === 'string' ? session.id : ''
}

/** 从一个 ToolExecution 里取工具名（日志定位用），取不到回空串。 */
function toolNameOf(exec) {
  return exec !== null && exec !== undefined && typeof exec.name === 'string' ? exec.name : ''
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


/** RPC method → 处理函数。每个函数只负责一个 method，见各自文件内的说明。 */
const RPC_HANDLERS = {
  state: rpcState,
  main: rpcMain,
  create: rpcCreate,
  build: rpcBuild,
  deleteSession: rpcDeleteSession,
  bind: rpcBind,
  current: rpcCurrent,
  workspace: rpcWorkspace,
  dispatch: rpcDispatch,
  brain: rpcBrain,
  models: rpcModels,
  board: rpcBoard,
  live: rpcLive,
  task: rpcTask,
  decompose: rpcDecompose,
  rebuild: rpcRebuild,
  list: rpcList,
  scan: rpcScan,
  module: rpcModule,
  mode: rpcMode,
  size: rpcSize,
  settings: rpcSettings,
  theme: rpcTheme,
  update: rpcUpdate,
}


async function rpcState({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
  // 项目组：一级列表要渲染「有哪些项目、当前打开哪个、各自健康性」。
  // 每次 state 都带上，因为面板轮询只拉 state——放在单独一个 method 里，
  // 列表就得自己再轮询一次。
  const panelState = readState(projectRoot, project)
  respond(res, 200, {
    ok: true,
    result: {
      ...summarize(panelState, resolved.extra),
      // 项目列表的数据源（与 `mode` / `size` / `current` 写操作共用同一个函数）。
      ...projectPanel(projectRoot, project, panelState),
      // 主题：`state` 只带**当前生效的 CSS 与已装清单**（本地读盘，毫秒级），
      // 不带远端清单——那要联网，塞进 8 秒轮询会让断网时面板每轮卡死。
      theme: themeOverview(),
      themeCss: activeThemeCss(),
    },
  })
  return
}

async function rpcMain({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
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
      version: doc.version,
      outdated: doc.outdated,
    },
  })
  return
}

async function rpcCreate({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
  const name = typeof body.project === 'string' && body.project.trim() !== '' ? body.project : defaultProjectName(body.goal ?? '')
  const created = createProject(
    projectRoot, name, typeof body.goal === 'string' ? body.goal : '',
    Array.isArray(body.modules) ? body.modules : [], DEFAULT_MODE,
  )
  if (created.ok !== true) {
    respond(res, 200, { ok: false, error: created.error })
    return
  }
  respond(res, 200, {
    ok: true,
    result: {
      // 建完之后真实归属是「面板当前打开的项目」（真新建时顺手切过去了），不是 explicit。
      // 报 explicit 会让面板以为「项目名是外面传进来的」，掩盖「现在打开着它」这件事。
      ...summarize(readState(projectRoot, created.project), {
        ...resolved.extra,
        projectSource: created.rebound === true ? 'open' : 'none',
      }),
      createdModules: created.created,
      mainCreated: created.mainCreated === true,
      rebound: created.rebound === true,
      opened: created.opened ?? null,
      released: [],
      // 项目已存在 → 这次没动「当前打开的项目」。必须说清。
      hint: created.mainCreated === true
        ? '项目已建好，并已设为面板当前打开的项目。'
        : '项目已存在，**没有改动「当前打开的项目」**（要打开它用面板列表点一行）。',
    },
  })
  return
}

async function rpcBuild({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
  const outcome = await runBuildSession({
    dataWorkspace: dataWorkspaceRoot(readSettings()),
    // 只这两样：建会话 + 往会话里装 puzzle_mode。不挂 goal（那是派单的事），
    // 也不需要 goals / agents——它建完项目就交给用户接着对话。
    sessionController: ctx.get('sessionController'),
    installSessionTools,
  }, {
    prompt: typeof body.prompt === 'string' ? body.prompt : '',
    requestId: typeof body.requestId === 'string' ? body.requestId : '',
  })
  respond(res, 200, outcome)
  return
}

async function rpcDeleteSession({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
  if (sessionId === '') {
    respond(res, 400, { ok: false, error: '要删哪个会话？没给 sessionId。' })
    return
  }
  const registry = ctx.get('workspaceRegistry')
  if (registry === null || registry === undefined || typeof registry.deleteSession !== 'function') {
    respond(res, 200, {
      ok: false,
      error: '这台部署没有「永久删除会话」的能力',
      hint: '官方 DSH 只提供归档，不提供删除。要真删，需要装 '
        + '`@michengai/dsh-archive-manager`（它接管 workspace 服务并补上 deleteSession）。'
        + '在那之前，浮窗上的 ✕ 只能把会话移出侧边栏。',
    })
    return
  }
  try {
    const outcome = await registry.deleteSession(sessionId)
    respond(res, 200, {
      ok: true,
      result: { sessionId, deleted: outcome === null || outcome === undefined || outcome.deleted !== false },
      hint: '会话 ' + sessionId + ' 已永久删除（转录目录、附件、工作区记账一并清掉）。这一步不可撤销。',
    })
  } catch (error) {
    const raw = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
    respond(res, 200, {
      ok: false,
      error: '删除会话失败：' + raw,
      hint: '会话 ' + sessionId + ' 还在。可能是它正在被别的进程打开，或转录目录被占用——关掉再试。',
    })
  }
  return
}

async function rpcBind({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
  respond(res, 200, {
    ok: false,
    error: `method:${body.method} 已废弃（v2.0.0 起插件改为全局，项目与会话不再绑定）`,
    hint: '现在：项目列表 = 数据工作区下的全部项目；「当前项目」= 面板打开的那一个（method:current）。',
  })
  return
}

async function rpcCurrent({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
  if (typeof body.project !== 'string' || body.project.trim() === '') {
    respond(res, 400, { ok: false, error: '缺少 project' })
    return
  }
  const moved = setOpenProjectIn(projectRoot, body.project)
  if (moved.ok !== true) {
    respond(res, 200, { ok: false, error: moved.error })
    return
  }
  // 与 `mode` / `size` 同形：回一份**重读过盘**的项目列表。这里尤其要紧——
  // `current` 只改「当前打开哪个」，项目集合本身没变，客户端原先只能靠
  // `markCurrentLocal` 就地改 `current` 标记兜底，而那个兜底**自己承认没有断言**
  // （见 client.js 那段诚实说明）。宿主把真值直接给出来，兜底才不必独挑大梁。
  const afterCurrent = readState(projectRoot, body.project)
  respond(res, 200, {
    ok: true,
    result: {
      ...summarize(afterCurrent, { ...resolved.extra, projectSource: 'open' }),
      ...projectPanel(projectRoot, body.project, afterCurrent),
      switched: true,
    },
  })
  return
}

async function rpcWorkspace({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
  if (typeof body.path === 'string' && body.path.trim() !== '') {
    const wanted = body.path.trim()
    let isDir = false
    try {
      isDir = statSync(wanted).isDirectory()
    } catch (_error) {
      isDir = false
    }
    if (!isDir) {
      respond(res, 200, { ok: false, error: `目录不存在或不是目录：${wanted}` })
      return
    }
    setWorkspaceBinding(typeof body.workspaceId === 'string' ? body.workspaceId : '', wanted)
  }
  const settings = readSettings()
  respond(res, 200, {
    ok: true,
    result: {
      workspaceId: settings.workspaceId,
      workspacePath: settings.workspacePath,
      bound: settings.workspacePath !== '',
      openProject: settings.openProject,
      codeWorkspace: settings.codeWorkspace,
      dispatchModels: settings.dispatchModels,
      projectRoot: settings.workspacePath,
      projectCount: listProjects(settings.workspacePath).length,
      ...effectiveCodeRootOf(settings),
    },
  })
  return
}

async function rpcDispatch({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
  if (body.codeWorkspace !== undefined && body.codeWorkspace !== null) {
    setCodeWorkspace(body.codeWorkspace)
  }
  if (body.dispatchModels !== undefined && body.dispatchModels !== null) {
    for (const [slot, selection] of Object.entries(body.dispatchModels)) {
      if (!DISPATCH_MODEL_SLOTS.includes(slot)) continue
      setDispatchModel(slot, selection === null ? null : selection)
    }
  }
  const settings = readSettings()
  respond(res, 200, {
    ok: true,
    result: {
      codeWorkspace: settings.codeWorkspace,
      dispatchModels: settings.dispatchModels,
      codeWorkspaceModes: CODE_WORKSPACE_MODES,
      defaultCodeWorkspaceMode: DEFAULT_CODE_WORKSPACE_MODE,
      /**
       * **这张卡实际会在哪个目录里干活**（v2.4.2）。
       *
       * 面板必须显示它，而不是只显示用户填的那个根：默认档下 `globalPath` 是空的，
       * 而实际路径是 `<数据工作区>/<项目名>`——不显示的话，用户看到空输入框
       * 会以为「没配＝不能用」，而其实它**不配就能用**。
       */
      ...effectiveCodeRootOf(settings),
    },
  })
  return
}

/**
 * 当前（面板打开的项目）的**实际执行工作区**，给面板显示用。
 *
 * `source` 一起回：面板要按它说清「这是默认推导的」还是「你配的」——
 * 只回一个路径字符串的话，用户没法知道改动那个输入框会覆盖掉什么。
 */
function effectiveCodeRootOf(settings) {
  const info = codeRootInfoOf(settings, openProjectOf(settings))
  return {
    effectiveCodeRoot: info.path,
    effectiveCodeRootSource: info.source,
    effectiveCodeRootProject: openProjectOf(settings),
  }
}

async function rpcBrain({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
  const outcome = await runBrain(brainDeps(ctx), {})
  respond(res, 200, outcome)
  return
}

async function rpcModels({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
  const catalog = await modelCatalogOf(ctx)
  respond(res, 200, catalog.ok === true ? { ok: true, result: catalog } : { ok: false, error: catalog.error })
  return
}

/**
 * **一个会话现在到底在不在干活**（v2.3.x）。
 *
 * ## 为什么必须有它，而不是让面板拿「卡在哪一列」当判据
 *
 * 面板上「在做」只说明**这张卡被派出去了**，它是一个历史事实。真正的问题是
 * 「此刻那个 agent 在跑吗、goal 到第几轮了」——而这两样都只存在于宿主进程里：
 * `agents.get(id).status`（`'idle' | 'running'`）与 `goals.get(agent)`（相位 + 轮次）。
 *
 * 卡上虽然冗余了 `roundsStarted` / `goalRevision`，但它们是**派单那一刻**的快照
 * （见 `dispatchrun.js` 的「先落 sessionId」那一段），此后不再更新。
 * 拿它当「轮 3/10」显示会一直停在「轮 0/10」——那是**显示一个假事实**，
 * 比不显示更糟。所以实时值一律现读，由这里统一给。
 *
 * ## 为什么读不到时回 `status:''` 而不是抛错
 *
 * 它是**只读的旁路**：会话可能已经被删、agent 可能已卸载、goal 可能压根没挂。
 * 这些都不是故障，而是「没有可报的状态」。抛错会让整个看板 RPC 失败——
 * 那等于让一条装饰性信息把主功能弄挂。
 */
function liveOf(ctx, sessionId) {
  const out = { status: '', phase: '', roundsStarted: null, maxGoalRounds: null, revision: null }
  if (typeof sessionId !== 'string' || sessionId === '') return out
  const agents = ctx.get('agents')
  const agent = agents !== null && agents !== undefined && typeof agents.get === 'function'
    ? agents.get(sessionId)
    : undefined
  if (agent === undefined || agent === null) return out
  if (typeof agent.status === 'string') out.status = agent.status
  const goals = ctx.get('goals')
  if (goals === null || goals === undefined || typeof goals.get !== 'function') return out
  try {
    const view = goals.get(agent)
    if (view === null || view === undefined) return out
    if (typeof view.phase === 'string') out.phase = view.phase
    if (Number.isSafeInteger(view.roundsStarted)) out.roundsStarted = view.roundsStarted
    if (Number.isSafeInteger(view.maxGoalRounds)) out.maxGoalRounds = view.maxGoalRounds
    if (Number.isSafeInteger(view.revision)) out.revision = view.revision
  } catch (_error) {
    /**
     * `goals.get` 对「不是本注册表那个 live 实例」的 agent 会抛（`GoalError`）。
     * 那种情况下状态就是读不到——保留已经拿到的 `status`，相位留空。
     */
    return out
  }
  return out
}

/** 只读一条：`{method:'live', ids:[…]}` → 每个会话的实时状态。面板浮窗靠它显示「在跑」。 */
async function rpcLive({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
  const ids = Array.isArray(body.ids) ? body.ids.filter((one) => typeof one === 'string' && one !== '') : []
  const sessions = {}
  for (const id of ids) sessions[id] = liveOf(ctx, id)
  respond(res, 200, { ok: true, result: { sessions } })
  return
}

async function rpcBoard({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
  const board = readBoard(projectRoot, project)
  respond(res, 200, {
    ok: true,
    result: {
      ...board,
      columns: BOARD_COLUMNS,
      labels: COLUMN_LABELS,
      grouped: groupByColumn(board.cards),
      /**
       * 禁跳表**随看板一起下发**（v2.4.5）。
       *
       * 为什么必须下发而不是让面板自己写一份：拖拽时的「这一列不接收」高亮
       * 需要在**松手之前**就知道答案，而那份规则住在 `moveVerdict` 里。
       * 面板自己抄一份 = 两套规则，迟早漂移成「高亮说能放、松手却被拒」。
       * 本仓对这类「客户端猜宿主规则」有明确戒心（浮窗开关那次就是这么修的）。
       */
      forbidden: FORBIDDEN_JUMPS,
    },
  })
  return
}

/** 从任意抛出物里取一句人能读的话（宿主抛的不一定是 Error）。 */
function messageOf(error) {
  return error !== null && error !== undefined && error.message !== undefined
    ? String(error.message)
    : String(error)
}

/**
 * 宿主 `WorkspaceActiveSessionError` 带一个 `activity` 数组，说明**什么还在跑**
 * （`turn` / `job` / `schedule` / `subagent` 之类，由各 provider 的
 * `workspace/session-activity` 监听器报上来）。
 *
 * 为什么要把这一段挑出来显示：光一句「会话还活着」用户不知道该去停什么。
 * 这一段正是宿主的答案——所以原样转述，不自己编一套说法。
 */
function activityNoteOf(error) {
  const activity = error !== null && error !== undefined && Array.isArray(error.activity) ? error.activity : null
  if (activity === null || activity.length === 0) return ''
  const kinds = activity
    .map((entry) => String(entry !== null && entry !== undefined && entry.kind !== undefined ? entry.kind : ''))
    .filter((one) => one !== '')
  return kinds.length === 0 ? '' : '宿主说这个会话上还有在跑的东西：' + kinds.join(' / ') + '。'
}

/**
 * **删掉一个会话**（v2.3.x：删卡时连带删掉卡上挂的会话）。
 *
 * ## 两条路，以及为什么优先真删
 *
 * 1. `workspaceRegistry.deleteSession` —— 官方 `WorkspaceRegistry` **只有**
 *    archive / unarchive，这个方法由 `@michengai/dsh-archive-manager` 接管
 *    `workspaceRegistry` 之后补上（它真的删转录目录、清投影缓存、级联删子会话、
 *    写墓碑防「删了又回来」）。用户说的是「会话也删」，这一条正是那个语义。
 * 2. `workspaceRegistry.archiveSession(sessionId, {stopActivity:true})` ——
 *    官方 API（`dsh-workspace/lib/index.js` 的 `archiveSession`）。它把会话
 *    移出侧边栏并落进归档集合，**不删转录目录**。
 *
 * ## 为什么退回归档时必须在 hint 里说清
 *
 * 本仓明令禁止「把归档说成删除」（见 client.js `deleteBuildSession` 那段）。
 * 但这里与那个 ✕ 不同：**用户点的主对象是「删卡」**，会话只是它的附带清理。
 * 因为本部署没有永久删除能力就整条拒绝，用户连卡都删不掉——那是把
 * 「能力差异」升级成了「主功能不可用」。所以退到归档，但
 * **如实把用的哪条路写进回包**（`mode`）与 `hint`，由面板原样显示。
 *
 * ## `stopActivity:true` 的含义
 *
 * 不带它时宿主会先问 `workspace/session-activity`，**只要还有东西在跑就拒绝**
 * （`WorkspaceActiveSessionError`）。而这里的动作就是「删掉这张已完成的卡」，
 * 用户的意思明确包含「把它的活停掉」。带它则跳过那道闸门，宿主随后通过
 * `workspace/session-stop` 让各 provider 停掉（`dsh-agent` 会 `agent.cancel`）。
 *
 * @returns `{ok:true, mode:'deleted'|'archived'}` 或 `{ok:false, error, hint}`
 */
async function removeSessionOf(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === null || registry === undefined) {
    return {
      ok: false,
      error: '拿不到宿主的 workspaceRegistry 服务，没法删会话 ' + sessionId,
      hint: '卡片**没有**删——会话与卡是一起删的，先删会话才不会留下孤儿会话。',
    }
  }
  if (typeof registry.deleteSession === 'function') {
    try {
      await registry.deleteSession(sessionId)
      return { ok: true, mode: 'deleted' }
    } catch (error) {
      return {
        ok: false,
        error: '删除会话 ' + sessionId + ' 失败：' + messageOf(error),
        hint: '卡片**没有**删。' + activityNoteOf(error) + '再点一次「删除」可以重试（已经删掉的会话不会被重复处理）。',
      }
    }
  }
  if (typeof registry.archiveSession === 'function') {
    try {
      await registry.archiveSession(sessionId, { stopActivity: true })
      return { ok: true, mode: 'archived' }
    } catch (error) {
      return {
        ok: false,
        error: '归档会话 ' + sessionId + ' 失败：' + messageOf(error),
        hint: '卡片**没有**删。' + activityNoteOf(error) + '再点一次「删除」可以重试。',
      }
    }
  }
  return {
    ok: false,
    error: '这台部署的 workspaceRegistry 既没有 deleteSession 也没有 archiveSession，删不了会话 ' + sessionId,
    hint: '卡片**没有**删。装 `@michengai/dsh-archive-manager` 可以得到永久删除能力。',
  }
}

/** 删卡回包里那句「会话那边到底做了什么」——**按实际走的路说**，不笼统写「已删除」。 */
function sessionRemovalHint(removed) {
  if (removed.length === 0) return '（这张卡没挂会话，没有要清理的）'
  const deleted = removed.filter((one) => one.mode === 'deleted')
  const archived = removed.filter((one) => one.mode === 'archived')
  const parts = []
  if (deleted.length > 0) {
    parts.push('永久删除 ' + String(deleted.length) + ' 个会话（' + deleted.map((one) => one.sessionId).join('、') + '）')
  }
  if (archived.length > 0) {
    parts.push(
      '把 ' + String(archived.length) + ' 个会话移出侧边栏并归档（' + archived.map((one) => one.sessionId).join('、')
      + '）——这台部署没有「永久删除会话」的能力，装 `@michengai/dsh-archive-manager` 才是真删',
    )
  }
  return '，并' + parts.join('；')
}

async function rpcTask({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
  const action = typeof body.action === 'string' ? body.action : ''
  if (action === 'create') {
    const board = readBoard(projectRoot, project)
    const id = nextCardId(board.cards)
    const card = emptyCard(id, shortTitle(body.title ?? '', 60) || '（未命名任务）')
    card.plan.title = card.title
    card.plan.objective = typeof body.objective === 'string' ? body.objective : ''
    card.plan.description = typeof body.description === 'string' ? body.description : ''
    // **需求原文一字不改**（Q10）：分解产物是模型的解释，原文才是事实。
    card.sourceRequest = typeof body.request === 'string' ? body.request : ''
    card.plan.sourceRequest = card.sourceRequest
    const written = writeBoard(projectRoot, project, [...board.cards, card])
    if (written.ok !== true) {
      respond(res, 200, { ok: false, error: written.error, hint: written.hint })
      return
    }
    respond(res, 200, { ok: true, result: { card, board: readBoard(projectRoot, project) } })
    return
  }
  /**
   * **删除一张「已做」的任务单，连同它挂着的会话**（v2.3.x）。
   *
   * ## 为什么判据在宿主而不是面板
   *
   * 「只有已做能删」是**数据规则**（其它列还在流转中，删掉等于把在跑的事丢了），
   * 而本仓的纪律是判据只写一处。所以面板照常给按钮、照常发请求，
   * 被拒时把这里那句错话原样显示出来——客户端不预判。
   *
   * ## 为什么先删会话再写看板（顺序不能反）
   *
   * 用户点的是「删除」，产物应当是「卡和会话一起没」。若先删卡再删会话，
   * 会话删失败时看板上已经**没有这张卡**了——用户既看不到失败关联在哪，
   * 也没有第二次重试的入口（卡没了，按钮也没了）。
   *
   * 反过来（先会话、后写盘）失败时卡还在，用户可以再点一次。而且这一步
   * **天然可重试**：`deleteSession` 对已不存在的会话返回成功（它的
   * `sessionKnown` 为假时走 `cleanupUnknownArchivedSession` 后仍报 deleted）。
   * 于是「删掉第一个、第二个失败」这种半途状态，重试一次就能收敛。
   */
  if (action === 'delete') {
    const board = readBoard(projectRoot, project)
    const at = board.cards.findIndex((item) => item.id === body.id)
    if (at < 0) {
      respond(res, 200, { ok: false, error: `找不到卡片 ${String(body.id)}` })
      return
    }
    const card = board.cards[at]
    if (card.column !== 'done') {
      respond(res, 200, {
        ok: false,
        error: '只有「已做」列的任务单能删除',
        hint: `这张卡现在在「${COLUMN_LABELS[card.column] || card.column}」列。要删先把它移到「已做」。`,
      })
      return
    }
    /**
     * 两个会话 id 分开删：`sessionId` 是派单执行会话、`clarifySessionId` 是澄清会话。
     * 空串表示「这条没起过」，跳过——不拿空 id 去问宿主（那必然是一句
     * 「找不到这个会话」，而它并不是故障）。
     */
    const targets = [card.sessionId, card.clarifySessionId]
      .filter((id) => typeof id === 'string' && id !== '')
    const removed = []
    for (const id of targets) {
      const one = await removeSessionOf(ctx, id)
      if (one.ok !== true) {
        respond(res, 200, { ok: false, error: one.error, hint: one.hint })
        return
      }
      removed.push({ sessionId: id, mode: one.mode })
    }
    const cards = board.cards.filter((item) => item.id !== card.id)
    const written = writeBoard(projectRoot, project, cards)
    if (written !== undefined && written !== null && written.ok === false) {
      respond(res, 200, {
        ok: false,
        error: '会话删掉了，但看板写不进去：' + String(written.error),
        hint: String(written.hint || '') + '（重试一次即可：会话那一步已经收敛。）',
      })
      return
    }
    respond(res, 200, {
      ok: true,
      result: { id: card.id, sessions: removed, board: readBoard(projectRoot, project) },
      hint: '已删除任务单「' + String(card.title) + '」' + sessionRemovalHint(removed) + '。这一步不可恢复。',
    })
    return
  }
  /**
   * **冻结方案**（v2.3.0）：把「未接单」的卡定稿（写 `frozenAt`，**不搬列**）。
   *
   * ## 为什么需要它（补的是待办 B）
   *
   * `plan.frozenAt` 原先**没有任何写入点**——澄清器按拍板不自己冻结
   * （`writeClarifiedPlan` 那段注释写着「冻结仍由用户在面板上点」），
   * 而面板上根本没有那颗按钮。于是 `dispatchVerdict` 的第一道闸门
   * （「方案还没冻结，不能派出去」）**永远拦着**，卡永远派不出去。
   *
   * 判据全在 `freezeCard` 里（纯函数）：这里只负责「找卡 → 调它 → 落盘」。
   */
  if (action === 'freeze') {
    const board = readBoard(projectRoot, project)
    const at = board.cards.findIndex((item) => item.id === body.id)
    if (at < 0) {
      respond(res, 200, { ok: false, error: `找不到卡片 ${String(body.id)}` })
      return
    }
    const frozen = freezeCard(board.cards[at])
    if (frozen.ok !== true) {
      respond(res, 200, { ok: false, error: frozen.error, hint: frozen.hint })
      return
    }
    const cards = board.cards.slice()
    cards[at] = frozen.card
    const written = writeBoard(projectRoot, project, cards)
    if (written !== undefined && written !== null && written.ok === false) {
      respond(res, 200, { ok: false, error: '冻结后写看板失败：' + String(written.error), hint: written.hint })
      return
    }
    respond(res, 200, {
      ok: true,
      result: { card: frozen.card, board: readBoard(projectRoot, project) },
      hint: '已冻结。把它移到「在做」才会真的开工（那一步起会话、花钱）。',
    })
    return
  }
  /**
   * **停掉这张卡的执行会话**（v2.4.15，用户报「执行会话人为停止不了」）。
   *
   * ## 用户报的现象
   *
   * 卡派出去之后在「在做」列跑着，面板上**没有任何停的入口**——浮窗右上角
   * 那个 ✕ 只收起浮窗（它自己的 title 就这么写的），会话照跑、goal 照烧轮次。
   * 用户只能等它自己跑完，或者把整张卡删掉（那是「连卡一起丢」，代价不对等）。
   *
   * ## 用哪一条 API
   *
   * `sessionController.cancel({sessionId})` —— 契约原文：
   * 「**Cancel one active Agent turn without dropping its pending inbox.**」
   * 这正是「人为停止」的语义：停当前这一轮，但不把待处理的消息队列丢掉
   * （丢掉队列会让「停一下再继续」变成「永远接不上」）。
   *
   * ## 为什么不顺手把 goal 也清了
   *
   * 停 ≠ 放弃。用户按下这个按钮的意图通常是「先别跑了」，而不是「这件事不做了」。
   * goal 一清，那张卡的方案就作废、轮次预算归零——想接着做得重新派一次单。
   * 所以这里**只停轮次**，goal 与卡都留在原地；真要结束，用户下一步会走
   * 「移到失败」或「删卡」，那时才谈得上清 goal。
   *
   * ## 为什么不改卡上的列
   *
   * 停在「在做」是**真实状态**：它派出去过、现在被用户按停了，既没做完也没失败。
   * 把它挪到别的列会编出一个假结论（而看板最不能出的错就是假结论）。
   */
  if (action === 'stop') {
    const board = readBoard(projectRoot, project)
    const at = board.cards.findIndex((item) => item.id === body.id)
    if (at < 0) {
      respond(res, 200, { ok: false, error: `找不到卡片 ${String(body.id)}` })
      return
    }
    const card = board.cards[at]
    const sessionId = typeof card.sessionId === 'string' ? card.sessionId : ''
    if (sessionId === '') {
      respond(res, 200, {
        ok: false,
        error: '这张卡没有执行会话，没什么可停的',
        hint: '它还没被派出去过。要开工请把它移到「在做」。',
      })
      return
    }
    const controller = ctx.get('sessionController')
    if (controller === null || controller === undefined || typeof controller.cancel !== 'function') {
      respond(res, 200, {
        ok: false,
        error: '这台部署的 sessionController 没有 cancel，停不了会话',
        hint: '会话 ' + sessionId + ' 还在跑。可以把它移到「失败」列，或删掉这张卡（那会连会话一起清理）。',
      })
      return
    }
    try {
      controller.cancel({ sessionId })
    } catch (error) {
      respond(res, 200, {
        ok: false,
        error: '停会话失败：' + messageOf(error),
        hint: '会话 ' + sessionId + ' 可能已经不在跑了。刷新一次看板确认它的状态。',
      })
      return
    }
    respond(res, 200, {
      ok: true,
      result: { card, board: readBoard(projectRoot, project) },
      hint: '已请求停掉执行会话 ' + sessionId + ' 当前这一轮。**goal 还在、卡也没动**——'
        + '想接着做就再派一次；想结束就把它移到「失败」或删掉这张卡。',
    })
    return
  }
  if (action === 'verify') {
    const board = readBoard(projectRoot, project)
    const at = board.cards.findIndex((item) => item.id === body.id)
    if (at < 0) {
      respond(res, 200, { ok: false, error: `找不到卡片 ${String(body.id)}` })
      return
    }
    const card = { ...board.cards[at], verified: true, verifiedAt: Date.now() }
    const cards = board.cards.slice()
    cards[at] = card
    writeBoard(projectRoot, project, cards)
    respond(res, 200, { ok: true, result: { card, board: readBoard(projectRoot, project) } })
    return
  }
  if (action === 'move') {
    const board = readBoard(projectRoot, project)
    const at = board.cards.findIndex((item) => item.id === body.id)
    if (at < 0) {
      respond(res, 200, { ok: false, error: `找不到卡片 ${String(body.id)}` })
      return
    }
    const card = board.cards[at]
    const to = typeof body.to === 'string' ? body.to : ''
    const frozen = card.plan !== null && card.plan !== undefined && card.plan.frozenAt !== null && card.plan.frozenAt !== undefined
    const verdict = moveVerdict(card.column, to, frozen)
    if (verdict.ok !== true) {
      respond(res, 200, { ok: false, error: verdict.error, hint: verdict.hint })
      return
    }

    /**
     * ## 移到「未接单」= **开始澄清**（v2.4.4，用户报的 bug）
     *
     * 用户原话：「末澄清拖到未接单没有自动开始弹出澄清浮窗」。
     *
     * 原先这里走的是**通用 advance 分支**：只搬列 + 写 history，没有任何副作用。
     * 于是「未澄清 → 未接单」拖过去**只搬了列**——不起澄清会话、不弹浮窗，
     * 用户看到的是一张卡静静躺在「未接单」而什么都没发生。
     * 只有 `pending → doing` 被特判过（v2.4.3），这条被漏了。
     *
     * ## 为什么是「起澄清」而不是「冻结」
     *
     * 「未接单」的列语义是「已冻结成执行方案、等着派出去」，而 `freezeCard`
     * 要求 `freezeCheck` 通过（目标 + 执行交代都得有）。刚建出来的草稿**两样都没有**，
     * 直接冻只会被拒。所以「拖过去」要接的是**这一列的入口动作**——
     * 让澄清器把方案问出来，问完再冻结。
     *
     * ## 为什么委托给 `runClarify` 而不是自己起会话
     *
     * 与 `pending → doing` 委托 `runDispatch` 同一条理由：起会话那一套（拿大脑 →
     * fork → 装专属工具 → 投首轮消息）已经有唯一实现，这里再写一遍必然漂移。
     * 而且 `runClarify` 自己会**复用已在澄清中的会话**（`clarifyVerdict.reuse`），
     * 所以重复拖不会造出两个澄清器。
     *
     * ⚠️ **卡仍要落到「未接单」**：用户拖到哪列就是哪列，这是他的手势意图。
     * 只是此刻 `plan.frozenAt` 还没写——派单闸门会以「方案还没冻结」拦住
     * `pending → doing`，那句 hint 会告诉他去冻结。这与「卡在未接单但方案未定」
     * 是**真实状态**，不假装它已经就绪。
     */
    if (card.column === 'unclarified' && to === 'pending') {
      const settings = readSettings()
      const deps = dispatchDepsOf(ctx, projectRoot, project, settings)
      const outcome = await runClarify(deps, { cardId: String(card.id) })
      if (outcome.ok !== true) {
        respond(res, 200, outcome)
        return
      }
      /**
       * 澄清会话起好了，**再把卡搬到「未接单」**。
       *
       * 顺序与 `pending → doing` 相反（那条由 `runDispatch` 自己搬列）：
       * `runClarify` 的闸门 `clarifyVerdict` 要求卡**还在「未澄清」**，
       * 所以必须**先澄清、后搬列**。反过来的话澄清会被自己的闸门拒掉，
       * 而卡已经躺在「未接单」——正是 v2.4.3 修过的那种「卡动了、活没开始」。
       */
      const after = readBoard(projectRoot, project)
      const nowAt = after.cards.findIndex((item) => item.id === card.id)
      if (nowAt < 0) {
        respond(res, 200, outcome)
        return
      }
      const movedCard = pushHistory(after.cards[nowAt], 'unclarified', 'pending', 'manual', '移到未接单（自动开始澄清）')
      const cards = after.cards.slice()
      cards[nowAt] = movedCard
      const written = writeBoard(projectRoot, project, cards)
      if (written !== undefined && written !== null && written.ok === false) {
        respond(res, 200, {
          ok: false,
          error: '澄清会话已起好但看板写不进去：' + String(written.error),
          hint: '会话 ' + String(outcome.result !== undefined && outcome.result !== null ? outcome.result.sessionId : '') + ' 已经存在了。',
        })
        return
      }
      respond(res, 200, {
        ok: true,
        result: {
          ...outcome.result,
          card: movedCard,
          board: readBoard(projectRoot, project),
          // 面板按这三个字段搬列、播飞入、弹澄清浮窗，与「开始澄清」按钮同一套形状。
          effect: 'advance',
          label: '移到未接单（自动开始澄清）',
          autoClarified: true,
        },
        hint: outcome.hint,
      })
      return
    }

    /**
     * ## 移到「在做」= **真的开工**（v2.4.3，用户报的 bug）
     *
     * 用户原话：「将未执行移动至在做没有自动触发执行」。
     *
     * ## 为什么必须**委托**给 `runDispatch`，而不是「先搬列再派单」
     *
     * `runDispatch` 自己就会把卡搬到「在做」（它最后一步 `pushHistory(…,'doing','auto')`），
     * 而它的第一道闸门 `dispatchVerdict` 要求**卡还在「pending」**。
     * 所以先搬再派 = 派单当场被自己的闸门拒掉，而卡已经躺在「在做」——
     * 那正是用户看到的现象：**卡动了，活没开始**，而且没有任何报错。
     *
     * 委托过去之后三件事一次做完：建会话 → 挂 goal → 投首轮消息 → 自动搬列。
     * 搬列的 `history.by` 是 `auto`（派单做的），而不是 `manual`——这是事实。
     *
     * ## 为什么只对 `pending → doing` 生效
     *
     * `failed → doing` 的语义是「接着**原会话**继续」（`resume`），会话已经在了，
     * 再走一次派单会新建一个会话，把原来那份上下文丢掉。两条路分开走。
     */
    if (card.column === 'pending' && to === 'doing') {
      const settings = readSettings()
      const deps = dispatchDepsOf(ctx, projectRoot, project, settings)
      const outcome = await runDispatch(deps, { cardId: String(card.id) })
      if (outcome.ok !== true) {
        respond(res, 200, outcome)
        return
      }
      respond(res, 200, {
        ok: true,
        result: {
          ...outcome.result,
          // 面板按这两个字段播飞入动画与显示回执，与手动搬卡**同一套形状**。
          effect: 'advance',
          label: '移到在做（自动开工）',
          autoDispatched: true,
        },
        hint: outcome.hint,
      })
      return
    }

    /**
     * 两条路径**合流**：宽屏拖拽与窄屏按钮都到这里，由这一处
     * 「左移口子白名单检查 → 自动流转副作用 → 写 history → 落盘」。
     * U4 明确禁止按钮另写一套搬运逻辑——两条路径迟早漂移成两种语义。
     */
    const moved = pushHistory(card, card.column, to, 'manual', verdict.label)
    const cards = board.cards.slice()
    cards[at] = moved
    writeBoard(projectRoot, project, cards)
    respond(res, 200, {
      ok: true,
      result: { card: moved, effect: verdict.effect, label: verdict.label, board: readBoard(projectRoot, project) },
      // 重铸 / 接着澄清 / 重做这三条左移口子各自的后续动作**如实说清**，
      // 而不是假装搬完就完事了（它们各自要在批次 3 的会话层接上）。
      hint: verdict.effect === 'reforge'
        ? '已拖回未澄清：**重铸新版本**（带 v1 重走澄清，冻结后产出 v2 并自动跳回未接单）。'
        : verdict.effect === 'clarify'
          ? '已拖回未澄清：接着澄清（本来就是草稿，不产生新版本）。'
          : verdict.effect === 'resume'
            ? '已移回在做：**接着原会话继续**（不新建会话）。'
            : '',
    })
    return
  }
  /**
   * **起澄清会话 / 派单执行**（v2.1.0）。
   *
   * ## 为什么挂在 `task` 的 action 下，而不是单独一个 method
   *
   * 最初写的是 `method:'clarify'` / `method:'dispatch'` 两条，**当场被测试抓出来**：
   * `method:'dispatch'` **已经被「派单设置」占用**（面板一级页那段，
   * 写 `codeWorkspace` / `dispatchModels`）——我这条分支在它后面，
   * 永远走不到，而表现是「点派出去没反应」。
   *
   * 这也说明为什么不该新占一个 method 名：`dispatch` 这个词在这个文件里
   * 已经指「派单**设置**」了。动作挂在 `task` 下与 create / verify / move
   * 一致——它们都是「对一张卡做什么」，而设置那条是「配什么」。
   */
  if (action === 'clarify' || action === 'dispatch') {
    const cardId = typeof body.id === 'string' ? body.id : ''
    if (cardId === '') {
      respond(res, 200, { ok: false, error: '缺卡片 id', hint: '面板会带上它；手调 RPC 时要自己给。' })
      return
    }
    const settings = readSettings()
    const deps = dispatchDepsOf(ctx, projectRoot, project, settings)
    const outcome = action === 'clarify'
      ? await runClarify(deps, { cardId })
      : await runDispatch(deps, { cardId })
    respond(res, 200, outcome)
    return
  }
  respond(res, 400, { ok: false, error: `未知 task action ${String(action)}` })
  return
}

async function rpcDecompose({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
  const request = typeof body.request === 'string' ? body.request.trim() : ''
  if (request === '') {
    respond(res, 200, { ok: false, error: '需求是空的', hint: '先写一段需求再点「一键分解」' })
    return
  }
  const llm = ctx.get('llm')
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    respond(res, 200, {
      ok: false,
      error: '这台部署没有提供 llm 服务，无法一键分解',
      hint: '可以直接手填标题 / 目标 / 描述——三个框本来就可改。',
    })
    return
  }
  const selection = defaultModelSelection(ctx)
  if (selection === null) {
    respond(res, 200, { ok: false, error: '拿不到默认模型', hint: '请先在宿主设置里选一个默认模型。' })
    return
  }
  const chosen = readSettings().dispatchModels.decompose
  const route = chosen !== null && chosen !== undefined ? chosen : selection
  try {
    const collected = await streamToText(llm, {
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      system: DECOMPOSE_SYSTEM,
      /**
       * `content` 按**契约**写成 block 数组（v2.4.11）。
       *
       * 宿主 `MessageBase.content` 的类型是 `readonly ContentBlock[]`，这里原先
       * 写的是裸字符串 `JSON.stringify({ request })`。pi-ai 适配器**两种都认**
       * （`convertResponsesMessages` 里有 `typeof msg.content === 'string'` 分支，
       * 已核实），所以**这不是本次失败的根因**——但它是一个越出契约的入参，
       * 同部署另外两个一次性调用（task-board 的裁判、blender 的视觉审查）
       * 都按数组写。趁这次改回契约形状。
       */
      messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify({ request }) }] }],
      maxTokens: DECOMPOSE_MAX_TOKENS,
      // 要稳定、要可复现（与 auto-review 同款理由）。
      temperature: 0,
      // ⚠️ **不传 `purpose`**（v2.4.11）：宿主 `GenerateOptions.purpose` 的契约
      // 只声明了 `'compaction' | 'session-title'`，两个都是**宿主自己的内部用途**
      // （压缩、起标题）。本插件原先传 `'puzzle-decompose'` —— 一个契约里没有的值。
      // pi-ai 适配器会忽略它（已核实：不校验、也不进请求体），所以**它不是根因**；
      // 但既然契约里没有，就不该由我们发明。同部署另外两个一次性调用也都不传。
    })
    const parsed = parseDecompose(collected.text)
    const finish = collected.finish
    if (parsed.ok !== true) {
      /**
       * 解析失败要**分两种报**（v2.4.10）：预算被思考吃完而截断，与模型没照格式说。
       * 两者用户该做的事不同，共用一句「模型没有返回 JSON 对象」会让第一种
       * 变成一个永远重试不成功的动作。`finish` 是 `null` 时（老宿主不给这个
       * chunk）不猜，仍按解析错误报。
       */
      const truncated = finish.kind === 'max-tokens'
      const stopped = finish.kind === 'error' || finish.kind === 'aborted'
      /**
       * ⚠️ **失败必须落盘**（v2.4.11，第十五宗罪）。
       *
       * 真机上报出来的只有一句「模型调用中断了（error）」——面板看不到、日志里
       * 也没有，排查只能靠猜。这里把 `finish` 的原始形状记下来：
       * `kind` + `detail`（message / code / status / requestId），以及**这次调用的
       * 路由与预算**。下次再失败，日志里就有 `code` / HTTP 状态可直接定位。
       */
      if (stopped) {
        logFailure('RPC:decompose', '模型调用没走完，分解没做成', finish.kind, {
          provider: route.provider,
          model: route.model,
          reasoningEffort: route.reasoningEffort ?? null,
          maxTokens: DECOMPOSE_MAX_TOKENS,
          detail: finish.detail,
          textBytes: collected.text.length,
        })
      }
      respond(res, 200, {
        ok: false,
        error: truncated
          ? '模型把输出预算花在思考上，JSON 还没写完就断了（上限 ' + String(DECOMPOSE_MAX_TOKENS) + ' tokens）'
          : (stopped
            ? '模型调用' + (finish.kind === 'aborted' ? '被取消' : '失败')
              + (finish.detail === '' ? '' : '：' + finish.detail)
            : parsed.error),
        raw: parsed.raw,
        hint: truncated
          ? '需求原文没丢。再点一次多半还是这样——把需求写短一点，或者手填这三个框。'
          : (stopped ? '需求原文没丢。这是模型侧/网络侧的失败，过一会儿重试或换个模型。' : '需求原文没丢，可以直接重试或手填。'),
      })
      return
    }
    respond(res, 200, {
      ok: true,
      result: {
        title: parsed.title,
        objective: parsed.objective,
        description: parsed.description,
        missing: parsed.missing,
      },
      hint: parsed.missing.length > 0
        ? '模型没给出这些字段：' + parsed.missing.join(' / ') + '——请自己补上（不要拿整段需求顶替）。'
        : '分解完成，三个框都可以改；改完点「创建任务单」。',
    })
  } catch (error) {
    respond(res, 200, {
      ok: false,
      error: '分解失败：' + String(error && error.message ? error.message : error),
      hint: '需求原文还在，可以直接重试。',
    })
  }
  return
}

async function rpcRebuild({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
  // `all:true` = 作用于该工作区**全部项目**（面板「迁移/仅迁移格式」是全局动作）。
  if (body.all === true) {
    const names = boundProjects(projectRoot)
    if (names.length === 0) {
      respond(res, 200, { ok: false, error: '这个工作区里还没有拼图项目' })
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

async function rpcList({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
  respond(res, 200, { ok: true, result: summarizeList(projectRoot, projectSummaries(projectRoot)) })
  return
}

async function rpcScan({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
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

async function rpcModule({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
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

async function rpcMode({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
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
    result: { ...summarize(afterMode, resolved.extra), ...projectPanel(projectRoot, project, afterMode) },
  })
  return
}

async function rpcSize({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
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
    result: { ...summarize(afterSize, resolved.extra), ...projectPanel(projectRoot, project, afterSize) },
  })
  return
}

async function rpcSettings({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
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
        /**
         * 故障日志的落点（v2.2.5）。面板把它显示出来，用户真机上遇到
         * 「点了没用」时能直接打开这个文件，而不是回来问「日志在哪」。
         * 与 `settingsFile` 同一口径：面板只显示，不解释。
         */
        logFile: logPath(),
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
      logFile: logPath(),
    },
  })
  return
}

async function rpcTheme({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
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
  /**
   * 开发 / 分享（v1.0.0）。四个 action 一组，理由见 `lib/themedev.js` 文件头。
   *
   * 为什么都走这一条 RPC 而不是各自开路由：面板与宿主之间只有
   * `/puzzle-mode-rpc` 一个通道（浏览器半拿不到 `host.call`），
   * 加路由就要动鉴权与错误处理两处，得不偿失。
   */
  if (action === 'dev') {
    // 「一键进入开发」：建脚手架 + 回一份开发提示词（面板把提示词填进输入框）。
    const scaffold = createThemeScaffold(
      resolved.cwd,
      typeof body.id === 'string' ? body.id : '',
      {
        name: typeof body.name === 'string' ? body.name : '',
        author: typeof body.author === 'string' ? body.author : '',
        description: typeof body.description === 'string' ? body.description : '',
        repoPath: typeof body.repoPath === 'string' && body.repoPath.trim() !== ''
          ? body.repoPath.trim()
          : findThemeRepo(resolved.cwd),
      },
    )
    if (scaffold.ok !== true) {
      respond(res, 200, { ok: false, error: scaffold.error, hint: scaffold.hint })
      return
    }
    respond(res, 200, {
      ok: true,
      result: {
        ...scaffold,
        prompt: themeDevPrompt(scaffold.id, { repoPath: scaffold.repoPath }),
        repo: themeRepoStatus(scaffold.repoPath),
      },
    })
    return
  }
  if (action === 'repair') {
    // 重算清单（作者手改了 CSS 之后，让 index.json 跟上）。
    const repoPath = typeof body.repoPath === 'string' && body.repoPath.trim() !== ''
      ? body.repoPath.trim()
      : findThemeRepo(resolved.cwd)
    const rebuilt = rebuildThemeIndex(repoPath)
    respond(res, 200, rebuilt.ok === true
      ? { ok: true, result: { ...rebuilt, repo: themeRepoStatus(repoPath) } }
      : { ok: false, error: rebuilt.error, problems: rebuilt.problems })
    return
  }
  if (action === 'publish') {
    // 「一键上传」：写文件（已在盘上）→ 重算清单 → commit → push。
    // **插件不读任何令牌**：凭据由 git 自己的凭据链取，理由见 themedev.js 文件头。
    const repoPath = typeof body.repoPath === 'string' && body.repoPath.trim() !== ''
      ? body.repoPath.trim()
      : findThemeRepo(resolved.cwd)
    const uploaded = uploadTheme(repoPath, typeof body.id === 'string' ? body.id : '', {
      name: typeof body.name === 'string' ? body.name : '',
      message: typeof body.message === 'string' ? body.message : '',
    })
    respond(res, 200, uploaded.ok === true
      ? { ok: true, result: { ...uploaded, repo: themeRepoStatus(repoPath) } }
      : {
        ok: false,
        error: uploaded.error,
        hint: uploaded.hint,
        steps: uploaded.steps,
        problems: uploaded.problems,
        stderr: uploaded.stderr,
        committed: uploaded.committed,
        repo: themeRepoStatus(repoPath),
      })
    return
  }
  if (action === 'export') {
    // 导出单文件主题包（第二条分享路：发给别人粘贴导入）。
    // 来源有两种：本机已装的（`id`），或主题仓库里的（`repoId`）。
    const fromRepo = typeof body.repoId === 'string' && body.repoId.trim() !== ''
    let theme = null
    if (fromRepo) {
      const repoPath = typeof body.repoPath === 'string' && body.repoPath.trim() !== ''
        ? body.repoPath.trim()
        : findThemeRepo(resolved.cwd)
      const read = readRepoTheme(repoPath, body.repoId)
      if (read.ok !== true) {
        respond(res, 200, { ok: false, error: read.error })
        return
      }
      theme = read
    } else {
      const wanted = typeof body.id === 'string' ? body.id : ''
      const loaded = loadThemeCss(wanted)
      if (loaded.ok !== true) {
        respond(res, 200, { ok: false, error: loaded.error ?? '读主题失败', hint: loaded.hint })
        return
      }
      if (loaded.css === '') {
        respond(res, 200, { ok: false, error: '这个主题还没下载，无法导出' })
        return
      }
      const state = readThemeState()
      const meta = state.installed[loaded.id] ?? {}
      theme = { id: loaded.id, css: loaded.css, ...meta }
    }
    const pack = exportThemePack(theme, { note: typeof body.note === 'string' ? body.note : '' })
    if (pack.ok !== true) {
      respond(res, 200, { ok: false, error: pack.error })
      return
    }
    // 同时落一份到工作区（`themes-out/`），面板给路径；文本也一起回，
    // 面板可以直接「复制到剪贴板」——两条路都不必再点一次。
    const written = writeThemePack(resolved.cwd, pack)
    respond(res, 200, {
      ok: true,
      result: {
        id: pack.id,
        filename: pack.filename,
        bytes: pack.bytes,
        sha256: pack.sha256,
        text: pack.text,
        path: written.ok === true ? written.path : '',
        writeError: written.ok === true ? '' : written.error,
        packs: listThemePacks(resolved.cwd),
      },
    })
    return
  }
  if (action === 'import') {
    // 导入主题包：**默认不覆盖**已装主题，同 id 时先回 `exists` 让面板问一句。
    const text = typeof body.text === 'string' ? body.text : ''
    const overwrite = body.overwrite === true
    const done = installThemePack(text, { overwrite, fs: { readThemeState, themesDir, themeCssPath } })
    if (done.ok !== true) {
      respond(res, 200, { ok: false, error: done.error, hint: done.hint, exists: done.exists === true, id: done.id })
      return
    }
    // 导入即应用：用户导一个包进来，意图就是「我要用它」。
    const applied = applyTheme(done.id)
    respond(res, 200, {
      ok: true,
      result: {
        ...done,
        applied: applied.ok === true,
        applyError: applied.ok === true ? '' : applied.error,
        css: applied.ok === true ? applied.css : '',
        theme: themeOverview(),
      },
    })
    return
  }
  if (action === 'repostatus') {
    const repoPath = typeof body.repoPath === 'string' && body.repoPath.trim() !== ''
      ? body.repoPath.trim()
      : findThemeRepo(resolved.cwd)
    respond(res, 200, {
      ok: true,
      result: {
        repo: themeRepoStatus(repoPath),
        repoIds: repoThermIds(repoPath),
        packs: listThemePacks(resolved.cwd),
        repoName: THEME_REPO_DIRNAME,
      },
    })
    return
  }
  respond(res, 400, { ok: false, error: `未知 theme action ${String(body.action)}` })
  return
}

async function rpcUpdate({ ctx, body, res, projectRoot, project, resolved, sessionId }) {
  const action = typeof body.action === 'string' ? body.action : 'check'
  /**
   * 「本机版本」走 `localVersion()`——它**先看 profile 里装的那份**，
   * 读不到才退回当前代码的版本。
   *
   * 实测踩过：开发机上跑着的代码来自源码仓库（已是新版），而 profile 里
   * 装着的还是旧版；用 `pluginVersion()` 会显示「已是最新」，用户却明明没升级。
   * **假报「已是最新」比报错更糟**——它让人以为没事，不会去查。
   */
  const local = localVersion()
  const current = local.version
  if (action === 'check') {
    const checked = await checkUpdate({ current })
    respond(res, 200, checked.ok === true
      ? {
        ok: true,
        result: {
          ...checked,
          // 面板要能说清「这个版本号是从哪读来的」（profile / 当前代码）。
          versionSource: local.source,
          profile: local.profile,
          install: installCommandOf(checked.latest, { tag: checked.tag, profile: local.profile }),
        },
      }
      : { ok: false, error: checked.error, tried: checked.tried, current, versionSource: local.source })
    return
  }
  if (action === 'download') {
    const checked = await checkUpdate({ current })
    if (checked.ok !== true) {
      respond(res, 200, { ok: false, error: checked.error, tried: checked.tried })
      return
    }
    const wanted = typeof body.version === 'string' && body.version.trim() !== '' ? body.version : checked.latest
    const done = await downloadUpdate(wanted, { info: checked, anchorSha256: checked.anchorSha256 })
    respond(res, 200, done.ok === true
      ? { ok: true, result: { ...done, install: installCommandOf(done.version, { tag: 'v' + done.version, profile: local.profile }) } }
      : { ok: false, error: done.error, hint: done.hint, tried: done.tried })
    return
  }
  if (action === 'staged') {
    respond(res, 200, {
      ok: true,
      result: {
        current,
        versionSource: local.source,
        dir: updatesDir(),
        staged: stagedVersions(),
        profile: local.profile,
        install: installCommandOf(current, { profile: local.profile }),
        // 最近一次运行的结论与备份清单（面板显示「装到哪了、可回退到哪」）。
        lastRun: readUpdateRun(),
        backups: listBackups(),
      },
    })
    return
  }
  if (action === 'releases') {
    // 「各个版本的更新日志」（用户裁定：Release 列表 API；每版最多 3 行摘要）。
    const listed = await fetchReleaseList({ current })
    respond(res, 200, listed.ok === true
      ? { ok: true, result: listed }
      : { ok: false, error: listed.error, tried: listed.tried })
    return
  }
  if (action === 'install') {
    /**
     * **谁来装**（v1.0.1，用户裁定「独立子进程自己装，失败自动回退」）。
     *
     * 为什么交给独立子进程、而不是宿主直接装：要装的东西是**插件自己**。
     * 装坏了宿主半就加载不了，面板跟着消失——那时任何「住在插件里」的回退逻辑
     * 也一起没了。所以安装器是一个**被复制到 `$DSH_HOME` 下**的独立脚本，
     * 它自己备份三处、自己验、失败自己还原（见 `tools/dsh-puzzle-update.mjs`）。
     *
     * 这里只负责**启动**并立刻返回：装包可能跑几十秒，卡在 RPC 里浏览器会超时。
     * 进度由面板轮询 `action:'staged'` 的 `lastRun` 拿。
     */
    const version = typeof body.version === 'string' && body.version.trim() !== '' ? body.version.trim() : ''
    const tag = typeof body.tag === 'string' && body.tag.trim() !== ''
      ? body.tag.trim()
      : (version !== '' ? 'v' + normalizeVersion(version) : '')
    if (tag === '') {
      respond(res, 400, { ok: false, error: '缺少要安装的版本' })
      return
    }
    const profile = profileDirOf()
    if (profile === '') {
      respond(res, 200, {
        ok: false,
        error: '没找到装着本插件的 profile 目录，无法自动安装',
        hint: '可以手动执行：' + installCommandOf(version, { tag, profile: '' }).command,
      })
      return
    }
    /**
     * **先解析 tag → SHA，再启动安装器**（v1.1.1 实测踩到）。
     *
     * 本机 `github.com:443` 不通（实测 21 秒超时），而 pnpm 装 git 依赖的
     * 第一步就是在那上面 `git ls-remote` 解析 tag → 于是必然失败。
     * 这里替它做完那一步：走可达的 `api.github.com` 拿 SHA，
     * 安装器拿到 SHA 后用 codeload 直连（`codeload.github.com` 实测可达）。
     *
     * 解析失败**不挡路**：把空 SHA 传下去，让安装器自己再试一次
     * （它走同一条 api 通道）——两处都失败才真的失败，那时报错也更准确。
     */
    const resolved = await resolveTagSha(tag)
    const sha = resolved.ok === true ? resolved.sha : ''
    const started = spawnUpdater({ profile, tag, version: normalizeVersion(version), sha })
    respond(res, 200, started.ok === true
      ? {
        ok: true,
        result: {
          started: true,
          pid: started.pid,
          profile: started.profile,
          tag: started.tag,
          resultPath: started.resultPath,
          hint: '安装器已在后台跑（独立进程，不依赖插件存活）。进度会自动刷新；失败会**自动回退**。装完要重启 profile 才生效。',
        },
      }
      : { ok: false, error: started.error, hint: started.hint })
    return
  }
  respond(res, 400, { ok: false, error: `未知 update action ${String(body.action)}` })
  return
}


async function puzzleOpList({ args, sessionId, resolved, projectRoot, project, append }) {
  return summarizeList(projectRoot, projectSummaries(projectRoot))
}

async function puzzleOpWorkspace({ args, sessionId, resolved, projectRoot, project, append }) {
  /**
   * 绑 / 查**数据工作区**（拼图文档与任务单住在哪个工作区）。
   *
   * 为什么要有这个 op：v8 的项目根不再来自会话 cwd，而来自用户在面板上
   * 绑定的工作区。模型需要一条路能「看见并改它」——否则用户说
   * 「把文档放到 D:\x 去」时，模型只能让他去点面板。
   *
   * 校验：给的路径必须**存在且是目录**。写进去一个不存在的路径，
   * 等于给之后所有 op 埋一个「查不到」——那比当场拒绝难查得多。
   */
  if (typeof args.path === 'string' && args.path.trim() !== '') {
    const wanted = args.path.trim()
    let isDir = false
    try {
      isDir = statSync(wanted).isDirectory()
    } catch (_error) {
      isDir = false
    }
    if (!isDir) return failure(`目录不存在或不是目录：${wanted}`, '给一个存在的绝对路径（拼图文档与任务单会写在这里）')
    const done = setWorkspaceBinding('', wanted)
    return {
      ...resolved.extra,
      ok: true,
      workspaceId: done.workspaceId,
      workspacePath: done.workspacePath,
      changed: done.changed,
      projectRoot: done.workspacePath,
      projectCount: listProjects(done.workspacePath).length,
      hint: '数据工作区已绑定：拼图文档（`<项目名>/拼图/`）与任务单都会写在这里。'
        + '⚠️ 若这个工作区里还有别的会话在干活，AI 可能把拼图文档误读成项目内容——建议给它一个干净的工作区。',
      ...pauseFields(),
    }
  }
  const settings = readSettings()
  return {
    ...resolved.extra,
    ok: true,
    workspaceId: settings.workspaceId,
    workspacePath: settings.workspacePath,
    bound: settings.workspacePath !== '',
    projectRoot: settings.workspacePath,
    projectCount: listProjects(settings.workspacePath).length,
    openProject: settings.openProject,
    codeWorkspace: settings.codeWorkspace,
    hint: settings.workspacePath === ''
      ? '还没绑定数据工作区：op:workspace 并给 path（绝对路径），或在面板一级页绑定一个工作区。'
      : '这是当前的数据工作区（拼图文档与任务单住这里）。要改绑就给 path。',
    ...pauseFields(),
  }
}

async function puzzleOpScan({ args, sessionId, resolved, projectRoot, project, append }) {
  /**
   * 列出工作区里**还没有拼图文档**的顶层目录。
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
        + '一次建多个时**最后一个成为面板当前打开的项目**。',
    ...pauseFields(),
  }
}

async function puzzleOpRead({ args, sessionId, resolved, projectRoot, project, append }) {
  // `brief:true` 是接续会话用的精简档：新会话不必把六个模块的五维明细全拉进上下文。
  return summarize(readState(projectRoot, project), resolved.extra, args.brief === true)
}

async function puzzleOpMainDoc({ args, sessionId, resolved, projectRoot, project, append }) {
  // 主文档全文：**只读**。面板的「主文档」入口走 RPC 的 `main`，
  // 这个 op 是给模型用的（例如用户贴了一段主文档要对照时，不必猜路径去 read）。
  const doc = readMainDoc(projectRoot, project)
  if (doc.ok !== true) return failure(doc.error, doc.hint)
  return {
    ok: true,
    project,
    mainDoc: doc.mainDoc,
    text: doc.text,
    version: doc.version,
    outdated: doc.outdated,
    hint: '这是主文档**原文**（只读）。改它请用 op:main（四节之一），不要用 write / edit。',
    ...resolved.extra,
    ...pauseFields(),
  }
}

async function puzzleOpShow({ args, sessionId, resolved, projectRoot, project, append }) {
  if (typeof args.name !== 'string' || args.name === '') return failure('缺少 name', '给出模块名，例如 auth-flow')
  const detail = readModuleDetail(projectRoot, project, args.name)
  if (detail.ok !== true) return failure(detail.error, '检查项目名与模块名')
  return { ...detail, ...resolved.extra, ...pauseFields() }
}

async function puzzleOpInit({ args, sessionId, resolved, projectRoot, project, append }) {
  // 没给 project 就用「日期-关键词」兜底，免得因为缺名字而建不出来。
  const name = project !== '' ? project : defaultProjectName(args.goal ?? '')
  const created = createProject(projectRoot, name, args.goal ?? '', args.modules ?? [], DEFAULT_MODE)
  if (created.ok !== true) return failure(created.error, created.hint)
  const opened = created.rebound === true
  return receipt(readState(projectRoot, created.project), {
    ...resolved.extra,
    // 真实归属：新建时顺手把它设成「面板当前打开的项目」→ open；
    // 项目本来就在、这次没动 → 按实际（通常 none）。
    projectSource: opened ? 'open' : 'none',
    created: true,
    mainCreated: created.mainCreated === true,
    createdModules: created.created,
    existingModules: created.existing,
    // **只在真新建时**才切「面板当前打开的项目」。项目已存在时不动——
    // 一次「确保存在」式的 op:init 不该改变用户当前在看哪个项目。
    rebound: opened,
    bound: opened,
    opened: created.opened ?? null,
    released: [],
    bindError: null,
    hint: opened
      ? '项目已建好，并已设为面板当前打开的项目。'
      : '项目已存在：**本次没有改动「当前打开的项目」**。要打开它用 op:current 并给 project。',
    next: `现在开始一轮提问（最多 ${ASK_MAX_QUESTIONS} 问、每题最多 ${ASK_MAX_OPTIONS} 个选项），并在最后问一次要不要先停下`,
  })
}

async function puzzleOpBind({ args, sessionId, resolved, projectRoot, project, append }) {
  return failure(
    `op:${args.op} 已废弃（v2.0.0 起插件改为全局，项目与会话不再绑定）`,
    '现在：项目列表 = 该工作区下的全部项目（op:bindings）；「当前项目」= 面板打开的那一个（op:current）；'
      + '数据工作区用 op:workspace 绑。这条 op 不会静默成功——避免你以为绑上了而其实没有。',
  )
}

async function puzzleOpBindings({ args, sessionId, resolved, projectRoot, project, append }) {
  // 工作区里有哪些项目、面板当前打开的是哪个、各自健康性与模式。
  // 为什么要有这个 op：`op:read` 只答「当前打开的那个」，模型看不到还有别的项目，
  // 于是「切到另一个项目」只能靠用户口头说。有了它，模型能自己判断该不该切。
  const names = boundProjects(projectRoot)
  return {
    // ⚠️ `...resolved.extra` 必须放**前面**：它里面也有一个 `bindings`
    // （那是项目名数组，每次返回都带）。放后面会把这个 op 精心构造的对象数组
    // 盖成一串字符串——实测踩过：面板拿到 `[undefined, undefined]`。
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
    openProject: openProjectOf(),
    count: names.length,
    hint: projectRoot === ''
      ? '还没绑定数据工作区：op:workspace 并给 path，或在面板一级页绑定一个工作区。'
      : names.length === 0
        ? '这个工作区里还没有拼图项目：op:init 建一个。'
        : '不给 project 就落在 currentProject（面板当前打开的那个）；要换用 op:current 并给 project。',
    ...pauseFields(),
  }
}

async function puzzleOpCurrent({ args, sessionId, resolved, projectRoot, project, append }) {
  // 切「面板当前打开的项目」——**只切，不改任何绑定**（v8 已经没有绑定了）。
  // 它对应的正是 U2 的「点一行进下一级」：切完 op:read / 面板都会落在这个项目上。
  if (project === '') return failure('缺少 project', 'current 需要给出要打开的项目名')
  const moved = setOpenProjectIn(projectRoot, project)
  if (moved.ok !== true) return failure(moved.error, moved.hint)
  return {
    ...receipt(readState(projectRoot, project), {
      ...resolved.extra,
      projectSource: 'open',
      currentProject: project,
      bindings: boundProjects(projectRoot),
      switched: true,
    }),
    hint: `面板当前打开的项目已切到「${project}」。`,
  }
}

async function puzzleOpRebuild({ args, sessionId, resolved, projectRoot, project, append }) {
  // 默认 dry-run：`apply` 不显式给 true 就只报计划。重建会重写 front-matter 与补小节，
  // 本项目不自动备份（工作区通常在 git 里），所以预览就是唯一的刹车。
  //
  // `all:true` = 作用于该工作区**全部项目**。为什么这是对的：迁移是
  // 「把这份文档升到当前格式」，与「面板现在打开哪个」无关——只迁当前那个
  // 等于留下几个格式不一致的文档，下次打开还要再迁一遍。
  // v8 起这里的范围从「本会话全部绑定」改成「工作区全部项目」：
  // 没有会话可依，而「这个根下的项目」本来就是同一批。
  if (args.all === true) {
    const names = boundProjects(projectRoot)
    if (names.length === 0) return failure('这个工作区里还没有拼图项目', '先用 op:init 建一个')
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
        ? `已对全部 ${names.length} 个项目重建；用 op:read 逐个复核。`
        : `这是**全部 ${names.length} 个项目**的预览（dry-run）。确认后加 apply:true 落盘。`,
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

async function puzzleOpMain({ args, sessionId, resolved, projectRoot, project, append }) {
  if (typeof args.section !== 'string' || args.section === '') return failure('缺少 section', `可用：${SECTION_ORDER.join(' / ')}（主文档只有这五节）`)
  const result = updateMainSection(projectRoot, project, args.section, args.content ?? '', append)
  if (result.ok !== true) return failure(result.error, result.hint)
  return receipt(readState(projectRoot, project), {
    ...resolved.extra,
    section: args.section,
    entries: result.entries ?? 0,
    // 超上限时如实回报删了几条——与模块侧（op:module）对齐。
    // 少了它，模型看不见被顶掉的是哪几条；那是「静默裁剪」，不是「可追溯的裁剪」。
    dropped: Array.isArray(result.dropped) ? result.dropped.length : 0,
    droppedEntries: Array.isArray(result.dropped) ? result.dropped : [],
  })
}

async function puzzleOpModule({ args, sessionId, resolved, projectRoot, project, append }) {
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

/**
 * **一次写多处**（v9）：把一批写操作合并成「每个文件一次读→解析→落盘」。
 *
 * ## 为什么单开一个 op 而不是让 op:main / op:module 收数组
 *
 * 那两个 op 的语义是「写**一节**」，返回值也是「这一节写了几条、顶掉了哪几条」。
 * 让它们收数组会让返回形状随参数变形（一节 vs 多节），而模型对返回形状的依赖很深。
 * 分开一个 op 后：老路径一个字不改，新路径的返回是**逐条**的（哪条成了、哪条被拒）。
 *
 * ## 校验与落盘的分工
 *
 * 判据全在 `docio.js`（纯逻辑，可单独测）：分组、逐条校验、渲染出整份新正文。
 * 这里只负责「取正文 → 交给它 → 按它给的 groups 落盘」。**不在这里再判一遍**——
 * 两处各判一次必然漂移（表现是「planWrites 放过了，落盘时又被拒」）。
 */
async function puzzleOpWrite({ args, sessionId, resolved, projectRoot, project, append }) {
  const writes = Array.isArray(args.writes) ? args.writes : []
  if (writes.length === 0) {
    return failure('op:write 要带 writes 数组', '每条形如 { target:"main"|"module", section, name?, content, append? }；只写一节用 op:main / op:module 即可')
  }
  const state = readState(projectRoot, project)
  const plan = planWrites(writes, {
    projectRoot,
    project,
    size: state.size,
    readText: readTextCached,
  })
  /**
   * **先落盘再回报**：`plan.errors` 里的是被拒的条，`plan.groups` 里的是能写的。
   * 被拒的条**不影响**其余条（不连坐），所以两边都要如实给出去。
   */
  const written = []
  for (const group of plan.groups) {
    const result = atomicWrite(group.file, group.next)
    if (result !== undefined && result !== null && result.ok === false) {
      return failure('写入 ' + group.file + ' 失败：' + String(result.error), result.hint)
    }
    written.push({
      file: group.file,
      target: group.target,
      name: group.name,
      created: group.created === true,
      sections: group.writes.map((one) => one.section),
    })
  }
  return receipt(readState(projectRoot, project), {
    ...resolved.extra,
    summary: describePlan(plan),
    files: written,
    sections: written.reduce((sum, one) => sum + one.sections.length, 0),
    rejected: plan.errors,
  })
}

async function puzzleOpHealth({ args, sessionId, resolved, projectRoot, project, append }) {
  // 五维只写在模块文档上：项目级健康性由宿主按模块均值汇总，写进文档只会与事实矛盾。
  if (typeof args.name !== 'string' || args.name === '') {
    return failure('health 需要 name', '给出模块名：五维写在模块文档的 ## 健康性 里；项目健康性由宿主按模块均值汇总，不要手写')
  }
  const result = updateModuleSection(projectRoot, project, args.name, 'health', args.content ?? '', append)
  if (result.ok !== true) return failure(result.error, result.hint)
  return receipt(readState(projectRoot, project), { ...resolved.extra, module: args.name, section: 'health', created: result.created })
}

async function puzzleOpSource({ args, sessionId, resolved, projectRoot, project, append }) {
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

async function puzzleOpMode({ args, sessionId, resolved, projectRoot, project, append }) {
  if (typeof args.mode !== 'string' || !MODES.includes(args.mode)) return failure(`未知模式 ${String(args.mode)}`, `可用：${MODES.join(' / ')}`)
  const result = setMode(projectRoot, project, args.mode)
  if (result.ok !== true) return failure(result.error, result.hint)
  return receipt(readState(projectRoot, project), { ...resolved.extra, modeChanged: args.mode })
}

async function puzzleOpSize({ args, sessionId, resolved, projectRoot, project, append }) {
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
      note: `当前规模「${current}」：悬而未决 ≤${capsOfSize(current).pending} 条、已定 ≤${capsOfSize(current).decided} 条，`
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

async function puzzleOpSettings({ args, sessionId, resolved, projectRoot, project, append }) {
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