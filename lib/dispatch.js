/**
 * 派单系统（v2.0.0，U4 子页二）：任务单的**数据层**。
 *
 * ## 它是什么
 *
 * 五列看板：未澄清 / 未接单 / 在做 / 已做 / 失败。一张卡从「用户写一段需求」开始，
 * 经「模型分解成标题 / 目标 / 描述」→「澄清器问清楚并冻结」→「派单会话带 goal 多轮执行」
 * →「自动判定搬列」，全程落在 `<数据工作区>/拼图/<项目名>/派单/<卡 id>.json` 里
 * （**一张卡一个文件**，v2.4.9）。
 *
 * ## 为什么单独一个文件
 *
 * 它是**纯数据 + 纯规则**（读卡、写卡、搬列、判定该往哪列搬），不碰 Cordis、
 * 不碰客户端。宿主半只负责把模型与会话能力接上去（见 `lib/index.js` 的
 * `method:'dispatch'` / `decompose` 等分支），客户端只负责画。
 * 这样「搬列规则」这一条最容易写错的东西可以被单测直接钉住。
 *
 * ## ⚠️ 三条红线
 *
 * 1. **任务单文件在 `拼图/` 下**，而那个路径受插件**自己的文档锁**保护
 *    （`isPuzzleDocPath` 会拦 `write` / `edit`）。所以读写**必须经本模块**，
 *    不能靠模型直接写——否则会被自己的锁拦下。
 * 2. **数据存在绑定的数据工作区里**（不是全局设置、不是项目目录）：
 *    用户明确要求「拼图项目文档和任务单存进单独工作区」。
 * 3. **看板是项目级的**（v2.4.3），且**一张卡一个文件**（v2.4.9）：一个项目的卡
 *    都在 `<工作区>/拼图/<项目名>/派单/` 目录下，各占一个 `.json`。
 *    所以 `readBoard` / `writeBoard` **必须带项目名**——
 *    不带就返回 null，而不是退回旧的工作区级路径（那会让两个真相并存）。
 *
 * ## 列名用英文枚举落盘、中文只在 UI 上
 *
 * `unclarified` / `pending` / `doing` / `done` / `failed`——落盘值必须是稳定的标识符，
 * 中文只是显示名。混着用会让「改一次 UI 文案就把所有卡片读不出来」。
 */
import { mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { readText, atomicWrite, safeJoin } from './docfs.js'
import { isFile, isDir, slugify } from './util.js'
import { PUZZLE_DIR } from './constants.js'
import { logFailure } from './plog.js'

/** 看板的五列（顺序即流转方向：只能向右）。 */
export const BOARD_COLUMNS = ['unclarified', 'pending', 'doing', 'done', 'failed']

/** 列的中文显示名（**只在 UI 上**用，落盘一律用上面的英文枚举）。 */
export const COLUMN_LABELS = {
  unclarified: '未澄清',
  pending: '未接单',
  doing: '在做',
  done: '已做',
  failed: '失败',
}

/**
 * 左移的**三个口子**（其余一律回弹）。
 *
 * | 起点 → 终点 | 语义 | 对应拍板 |
 * |---|---|---|
 * | `pending`（已冻结）→ `unclarified` | **重铸**新版本（v1 保留、产出 v2） | Q3 |
 * | `pending`（未冻结）→ `unclarified` | **接着澄清**（本来就是草稿，不产生新版本） | Q3 |
 * | `failed` → `doing` | 接着**原会话**重做（不新建会话） | Q9 |
 *
 * ⚠️ `done → doing` **不在列**：`complete` 是终态，`resume` 的 `resumable`
 * 不含 `complete`，要重做只能 `goals/create` 新建 goal。技术上可行，但本版**不开这个口子**。
 */
export const LEFT_MOVES = [
  { from: 'pending', to: 'unclarified', frozen: true, effect: 'reforge', label: '重铸新版本' },
  { from: 'pending', to: 'unclarified', frozen: false, effect: 'clarify', label: '接着澄清' },
  { from: 'failed', to: 'doing', effect: 'resume', label: '接着原会话重做' },
]

/**
 * 从某列出发**禁止直接跳到**的列（v2.4.5，用户拍板）。
 *
 * ## 为什么「未澄清」不能直接到「已做」/「失败」
 *
 * 这两列的语义都是**执行有了结论**——做完了、或者失败了。而「未澄清」的卡
 * 既没澄清、没冻结方案、也从没派出去过：**它压根没执行**，哪来的结论。
 *
 * 放它过去会写出一条**假的完成记录**：卡上 `sessionId` 是空的、`history` 里
 * 只有一条「向右流转」，而看板会把它显示成一件做完的事。用户下次看板子时
 * 分不出「真做完了」和「被谁拖过去的」——这正是看板最不能出的错。
 *
 * ## 为什么**不**禁「未澄清 → 在做」
 *
 * 那一步有**真实的拒绝理由**：`dispatchVerdict` 会说「方案还没冻结，不能派出去」
 * 并指出出路（先去冻结）。由派单闸门当场拦下、把原因说清，比在这里静默禁掉
 * 更有用——用户能知道**下一步该做什么**，而不是只看到「不行」。
 *
 * ⚠️ 表是**单向**的（只列「从谁出发」）。别把它写成对称表：反向的那些口子
 * 由 `LEFT_MOVES` 单独管，两者语义不同（一个禁跳、一个开左移口子）。
 */
export const FORBIDDEN_JUMPS = { unclarified: ['done', 'failed'] }

/** 任务单文件在**项目级**看板目录里的位置：`<工作区>/拼图/<项目名>/派单.json`（v2.4.3）。 */
export const BOARD_FILE = '派单.json'

/**
 * **每张卡一个文件**（v2.4.9，用户拍板：「一个派单json应该对应一个任务卡」）。
 *
 * ## 从「一个文件装全部卡」改成「一张卡一个文件」
 *
 * v2.4.3 把看板做成**项目级**的一份 `派单.json`，里面是 `cards` 数组。
 * 用户这次拍板：**一个派单 json 只对应一张任务卡**。
 *
 * 这不是换了个存放位置，而是**换掉了并发模型**——原先写盘是「整份覆盖」：
 *
 *   1. 面板 8 秒轮询驱动的自动搬列、用户的拖拽、模型的 `op` 调用，三者都
 *      读→改→写**同一个文件**。谁后写谁赢，前一次的改动**静默消失**。
 *      两张卡本来互不相干，却被对方的写入盖掉。
 *   2. 整份覆盖的代价随卡数增长：改一张卡的 `verified` 要重写全部卡。
 *   3. 一张卡的 JSON 坏了（磁盘写一半、手改错一个逗号）→ **全部卡一起读不出来**。
 *      这是最要命的一条：损坏半径是整块看板。
 *
 * 一卡一文件之后：改哪张写哪张，坏哪张只丢哪张，两条并发路径不再互相覆盖。
 *
 * ## 目录布局
 *
 * ```
 * <数据工作区>/拼图/<项目名>/
 *   ├── 派单.json          ← 只留一句版本说明（占位，见下）
 *   └── 派单/
 *       ├── task-0001.json
 *       └── task-0002.json
 * ```
 *
 * ⚠️ **`派单.json` 这个文件本身保留**（`BOARD_FILE` 仍指向它）：它从「装卡」
 * 降级成**一处小索引**。留着它有两个实际理由：
 *   - 用户按名找看板时，`拼图/<项目名>/派单.json` 这条路径没变；
 *   - 老版本（≤v2.4.8）读到它不会当成「没有看板」而**另建一份空的**——
 *     那会让新旧两个真相并存，而卡还躺在 `派单/` 里。
 */
export const BOARD_DIR = '派单'

/** 单张卡的文件名：`task-0001.json`。 */
export function cardFile(id) {
  const safe = String(id === null || id === undefined ? '' : id).trim()
  // 卡 id 是 `nextCardId` 生成的 `task-\d+`，但它也可能来自旧文件/人手改过。
  // 要当路径用就必须消毒：`../` 会写到看板目录外面去。
  if (!/^[A-Za-z0-9_-]+$/.test(safe)) return null
  return safe + '.json'
}

/** 看板目录（`派单/`）：装每张卡一个的文件。 */
export function boardDirPath(workspaceRoot, projectName) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') return null
  const slug = slugify(projectName)
  if (slug === null) return null
  return safeJoin(workspaceRoot, PUZZLE_DIR, slug, BOARD_DIR)
}

/** 单张卡的文件路径。`id` 不合法时返回 null（调用方当「没这张卡」处理）。 */
export function cardPath(workspaceRoot, projectName, id) {
  const dir = boardDirPath(workspaceRoot, projectName)
  const name = cardFile(id)
  if (dir === null || name === null) return null
  return safeJoin(dir, name)
}

/** 判定一次移动**允不允许**，以及允许时**该做什么**。
 *
 * 纯函数：给它「从哪列、到哪列、卡是否已冻结」，它回答「允不允许 / 什么副作用」。
 * 宽屏拖拽与窄屏按钮**都调它**——两条路径合流在这一处，
 * 否则「拖能过、按钮不能过」这种漂移迟早出现（U4 明确要求同一个落位函数）。
 */
export function moveVerdict(from, to, frozen) {
  if (!BOARD_COLUMNS.includes(from) || !BOARD_COLUMNS.includes(to)) {
    return { ok: false, error: `未知列：${String(from)} → ${String(to)}` }
  }
  if (from === to) return { ok: true, effect: 'reorder', label: '同列换排' }
  const fromAt = BOARD_COLUMNS.indexOf(from)
  const toAt = BOARD_COLUMNS.indexOf(to)
  /**
   * **禁跳表优先于「只能向右」**（v2.4.5）。
   *
   * 顺序不能反：`done` / `failed` 在列序上都在「未澄清」右边，所以「向右一律放行」
   * 那条会先把它们放过去，禁跳表永远轮不到。先问禁跳，再问方向。
   */
  const banned = FORBIDDEN_JUMPS[from]
  if (Array.isArray(banned) && banned.includes(to)) {
    return {
      ok: false,
      error: `不能从「${COLUMN_LABELS[from]}」直接移到「${COLUMN_LABELS[to]}」`,
      hint: `「${COLUMN_LABELS[to]}」的意思是**执行有了结论**，而「${COLUMN_LABELS[from]}」的卡`
        + '还没澄清、没冻结方案、也从没派出去过——它没执行，不该有结论。'
        + '先把它澄清、冻结，再从「未接单」派出去；结论由执行本身给出。',
    }
  }
  // **只能向右**：这条是看板的总规则，不是「建议」。
  if (toAt > fromAt) return { ok: true, effect: 'advance', label: '向右流转' }
  // 左移：只在三个口子里放行。
  for (const rule of LEFT_MOVES) {
    if (rule.from !== from || rule.to !== to) continue
    if (rule.frozen !== undefined && rule.frozen !== (frozen === true)) continue
    return { ok: true, effect: rule.effect, label: rule.label }
  }
  return {
    ok: false,
    error: `不允许从「${COLUMN_LABELS[from]}」移到「${COLUMN_LABELS[to]}」`,
    hint: '只能向右移（或同列换排）；左移只开三个口子：未接单（已冻结）→ 未澄清、未接单（未冻结）→ 未澄清、失败 → 在做。',
  }
}

/** 一张新卡的默认形状（Q10 的**完整字段集**）。 */
export function emptyCard(id, title) {
  return {
    id,
    title,
    column: 'unclarified',
    /**
     * 执行方案（Q1 的结构化字段）。新建时只填 `title` / `objective` /
     * `description` / `sourceRequest` 四个——`steps` / `constraints` / `acceptance`
     * 要等澄清器问完、用户点「冻结」才填（Q3）。
     */
    plan: {
      id,
      title,
      objective: '',
      description: '',
      sourceRequest: '',
      /**
       * **具体执行提示词**（v2.2.0，用户拍板新增）。
       *
       * 澄清器问完之后写下的那一段「改哪些文件、按什么顺序、每步的完成判据」。
       * 它比 `steps` 更直接：`steps` 是结构化骨架（面板可逐条渲染、可校验），
       * 这一段是**给执行会话看的完整交代**，派单首轮优先投它。
       *
       * 两者都保留：`steps` 仍可被澄清器填写（面板会画出来），
       * 而冻结判据只要「目标 + 二者之一」——见 `freezeCheck`。
       */
      executionPrompt: '',
      clarified: [],
      steps: [],
      constraints: [],
      acceptance: [],
      frozenAt: null,
      version: 1,
    },
    /** 列表页不解析 `plan` 就能显示版本，所以卡上冗余一份。 */
    planVersion: 1,
    /** **用户写的需求原文，一字不改**。分解产物是模型的解释，原文才是事实。 */
    sourceRequest: '',
    /** 澄清会话 id（起了澄清器才有值）。与 `sessionId`（派单执行会话）**分开**。 */
    clarifySessionId: '',
    sessionId: '',
    /**
     * 这张卡属于哪个项目（v2.2.9，派单时写入）。
     *
     * 为什么卡上要冗余一份：看板是**工作区级**的（一份文件装全项目的卡），
     * 而「执行完成 → 汇报全局大脑」要知道投给**哪个项目**的大脑（大脑是项目级的）。
     * 没有它，那条汇报就找不到收件人。
     */
    project: '',
    goalId: '',
    goalRevision: null,
    roundsStarted: 0,
    maxGoalRounds: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    /** 与 `updatedAt` 分开：停留时长要按它算（超时判定、列表排序都用得上）。 */
    columnChangedAt: Date.now(),
    verified: false,
    verifiedAt: null,
    failure: null,
    history: [],
  }
}

/**
 * 看板文件路径（**每个项目一份**）。
 *
 * ## v2.4.3：从「工作区级一份」改成「项目级一份」
 *
 * 用户拍板：「相应派单应放拼图文件夹的子项目文件夹隔离」。
 *
 * 原先所有项目共用 `<数据工作区>/拼图/派单.json`。那有三个真问题：
 *   1. **一个项目的卡会出现在另一个项目的看板上**——看板是全局的，而卡是有主的；
 *   2. 项目名只冗余在**卡**上（`card.project`），而那是**派单时**才写的：
 *      没派过的卡压根不知道自己属于谁，于是「这张卡该进哪个项目的看板」无解；
 *   3. 两份互不相干的工作共用一个文件，写它要整份覆盖——一边写就把另一边的
 *      并发改动盖掉。
 *
 * 新布局：`<数据工作区>/拼图/<项目名>/派单.json`。
 * 与 `拼图/` 目录**平级**放一层项目名，而不是塞进某个项目的文档目录里——
 * 看板是**工作数据**，不该混进 AI 会去读的文档区。
 *
 * ⚠️ **项目名必须给**：它是路径的一段。给空串时返回 null（而不是退回工作区级），
 * 否则「没有项目的看板」会静默落回旧路径，两个真相并存。
 *
 * ⚠️ v2.4.9 起这个 `派单.json` **不再装卡**（卡在 `派单/` 目录里，一卡一文件）。
 * 它降级成一处小索引，但路径与文件名**刻意不动**：老版本读到它才不会另建空看板。
 */
export function boardPath(workspaceRoot, projectName) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') return null
  const slug = slugify(projectName)
  if (slug === null) return null
  return safeJoin(workspaceRoot, PUZZLE_DIR, slug, BOARD_FILE)
}

/**
 * 读**一张卡**。**从不抛错**：文件不在 / 坏 JSON 一律当「没这张卡」。
 *
 * 为什么吞掉错误：看板是面板一级页之后的第二屏，一张卡的坏 JSON 不该让整个面板打不开。
 */
export function readCard(workspaceRoot, projectName, id) {
  const file = cardPath(workspaceRoot, projectName, id)
  if (file === null) return null
  if (!isFile(file)) return null
  const text = readText(file)
  if (text === null) {
    logFailure('看板:读取', '卡片文件存在但读不出来', 'readText 返回 null', { file })
    return null
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logFailure('看板:读取', '卡片文件不是对象', 'JSON 解析出来不是对象', { file })
      return null
    }
    // 卡 id 以**文件内容**为准，但文件名是路径来源；两者不一致时以文件名对齐，
    // 否则会出现「文件叫 task-0003、里面的 id 是 task-0007」这种鬼东西。
    return { ...parsed, id: String(id) }
  } catch (error) {
    logFailure('看板:读取', '卡片 JSON 坏了，当这张卡不存在', error, { file, bytes: text.length })
    return null
  }
}

/**
 * 读整个看板（**扫目录**）。
 *
 * ## 顺序必须稳定
 *
 * `readdirSync` 的顺序**不保证**（不同文件系统不一样）。按 `id` 排序后再返回——
 * 否则「同列里第几张」每次刷新都在变，看板会自己抖。
 *
 * 排序用**数字序**（`task-2` 排在 `task-10` 前面）：`task-` 后面是补零到 4 位的
 * 十进制数，按字符串排会得到 `task-0001 < task-0002 < …` 恰好也对，
 * 但一旦 id 长过 4 位（`task-10000`）字符串序就会错，所以直接按数字比。
 */
export function readBoard(workspaceRoot, projectName) {
  const dir = boardDirPath(workspaceRoot, projectName)
  const file = boardPath(workspaceRoot, projectName)
  if (dir === null) return { ok: true, file: '', dir: '', cards: [], empty: true }
  /**
   * ⚠️ **老的单文件看板必须在这里先搬过来**（v2.4.9）。
   *
   * 不搬的话，升级后第一次读会扫一个**还不存在**的 `派单/` 目录、返回空看板——
   * 用户看到「我所有的卡都不见了」。所以这一步不能交给调用方去记得做：
   * 一个调用点忘了，就是一次「卡凭空消失」，而那是不可恢复的观感。
   * 放在读入口上，任何路径第一次读都会先补齐。
   *
   * 代价是读函数里有一次写。这是**一次性**的（搬完 `派单/` 就存在了，
   * 之后只是一次 `isDir` 判断），换来的是「升级不会丢卡」。
   */
  const migration = migrateBoard(workspaceRoot, projectName)
  if (!isDir(dir)) {
    /**
     * ⚠️ 把迁移的降级**如实报出来**。
     *
     * 老 `派单.json` 存在但读不出来（坏 JSON / 搬不动）时，这里返回的是一份
     * **空看板**——而磁盘上明明躺着用户的卡。不标 `degraded` 的话，
     * 界面上「卡全没了」和「你本来就没建过卡」长得一模一样，
     * 用户没有任何线索知道该去救那个文件。这是本仓明令禁止的静默降级。
     */
    return { ok: true, file, dir, cards: [], empty: true, degraded: migration.degraded === true }
  }

  let names = []
  try {
    names = readdirSync(dir)
  } catch (error) {
    logFailure('看板:读取', '看板目录列不出来，按空看板处理', error, { dir })
    return { ok: true, file, dir, cards: [], empty: true, degraded: true }
  }

  const cards = []
  let broken = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    const card = readCard(workspaceRoot, projectName, id)
    // 坏的那张**只丢它自己**（一卡一文件的核心好处），但要数出来留痕：
    // 静默少一张卡与「用户自己删了」在界面上长得一样。
    if (card === null) { broken += 1; continue }
    cards.push(card)
  }
  cards.sort((a, b) => seqOf(a.id) - seqOf(b.id))
  if (broken > 0) {
    logFailure('看板:读取', '有 ' + String(broken) + ' 张卡读不出来（其余照常显示）', '卡片 JSON 坏了', { dir })
  }
  return { ok: true, file, dir, cards, empty: false, broken }
}

/** 从 `task-0001` 取数字序号，用于稳定排序；取不到时排最后。 */
function seqOf(id) {
  const match = /^task-(\d+)$/.exec(String(id === null || id === undefined ? '' : id))
  if (match === null) return Number.MAX_SAFE_INTEGER
  const n = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(n) ? n : Number.MAX_SAFE_INTEGER
}

/**
 * 写**一张卡**（原子写）。
 *
 * ## 为什么这里没有「整份覆盖」了
 *
 * v2.4.8 及以前，任何一处改动（搬列、验收、写 history）都要「读全部 → 改 → 写全部」。
 * 面板的 8 秒轮询、用户的拖拽、模型的 op 调用三者并发时，谁后写谁赢，
 * 前一次的改动**静默消失**——而且那种错只在两张卡同时动时才出现，极难复现。
 *
 * 一卡一文件之后，「改一张卡」只碰一个文件，两条并发路径不再互相覆盖。
 *
 * ## 不变量仍然要守
 *
 * `history` 追加、`columnChangedAt` 与 `column` 同步——这些由 `pushHistory`
 * 负责（纯函数），本函数只负责把结果原子落盘。
 *
 * ⚠️ **必须先建目录**：用户刚绑好工作区、这个项目一张卡都还没建过时，
 * `派单/` 还不存在。`atomicWrite` 只写文件、不建目录，直接写会抛 `ENOENT`。
 */
export function writeCard(workspaceRoot, projectName, card) {
  const dir = boardDirPath(workspaceRoot, projectName)
  if (dir === null || card === null || card === undefined || typeof card !== 'object') {
    return {
      ok: false,
      error: '还没绑定数据工作区（或没给项目名）',
      hint: '看板是**项目级**的：`<数据工作区>/拼图/<项目名>/派单/<卡 id>.json`。先在面板一级页绑工作区、并打开一个项目。',
    }
  }
  const file = cardPath(workspaceRoot, projectName, card.id)
  if (file === null) {
    return { ok: false, error: '卡 id 不能当文件名用：' + String(card.id), hint: '卡 id 只允许字母、数字、下划线与短横。' }
  }
  try {
    mkdirSync(dir, { recursive: true })
    atomicWrite(file, JSON.stringify(card, null, 2) + '\n')
  } catch (error) {
    return { ok: false, error: '卡片写入失败', hint: String(error && error.message ? error.message : error) }
  }
  return { ok: true, file }
}

/**
 * 删掉一张卡的文件。
 *
 * ⚠️ 文件不存在**算成功**：删除的目标是「这张卡不在了」，而它已经不在。
 * 报错的话调用方会以为删除失败，而再点一次还是一样。
 */
export function removeCard(workspaceRoot, projectName, id) {
  const file = cardPath(workspaceRoot, projectName, id)
  if (file === null) return { ok: true, file: '', removed: false }
  try {
    if (isFile(file)) {
      unlinkSync(file)
      return { ok: true, file, removed: true }
    }
  } catch (error) {
    return { ok: false, error: '卡片删除失败', hint: String(error && error.message ? error.message : error) }
  }
  return { ok: true, file, removed: false }
}

/**
 * 把整个看板**对齐**成给定的这份卡列表：缺的写、多的删。
 *
 * ## 为什么是「对齐」而不是「只写不删」
 *
 * 删卡时调用方给的是**删掉之后**的列表。若这里只写不删，那张卡的文件还在，
 * 下一次 `readBoard` 扫目录会把它**读回来**——用户看到的是「删了又自己回来了」，
 * 而这是本功能最不能出的错（不可恢复的动作看起来没生效）。
 *
 * 所以判据是「**目录必须等于这份列表**」：多出来的 `.json` 一律删掉。
 *
 * ⚠️ 因此**调用方必须给全量列表**（这个项目的全部卡），不能给子集——
 * 给子集会把没列进来的卡当「多余」删掉。单卡改动请用 `writeCard`。
 */
export function writeBoard(workspaceRoot, projectName, cards) {
  const dir = boardDirPath(workspaceRoot, projectName)
  if (dir === null) {
    return {
      ok: false,
      error: '还没绑定数据工作区（或没给项目名）',
      hint: '看板是**项目级**的：`<数据工作区>/拼图/<项目名>/派单/`。先在面板一级页绑工作区、并打开一个项目。',
    }
  }
  const list = (Array.isArray(cards) ? cards : []).filter((card) => card !== null && card !== undefined && typeof card === 'object')

  // 先写：写失败就**不删**任何东西。顺序反了的话，一次失败的写入会连带删掉
  // 还没成功写下的卡——那是「写不进去」升级成「卡没了」。
  const keep = new Set()
  for (const card of list) {
    const written = writeCard(workspaceRoot, projectName, card)
    if (written.ok !== true) return written
    keep.add(cardFile(card.id))
  }

  // 再删多出来的。删失败**不算整体失败**：卡已经写好了，多一个残留文件
  // 只影响下一次读取，不该让用户以为「刚才那次操作没成」。
  let removed = 0
  let names = []
  try {
    names = readdirSync(dir)
  } catch (_error) {
    return { ok: true, dir, count: list.length, removed: 0 }
  }
  for (const name of names) {
    if (!name.endsWith('.json') || keep.has(name)) continue
    const id = name.slice(0, -'.json'.length)
    /**
     * ⚠️ **读不出来的文件不许删**（这条是防数据丢失的，别省）。
     *
     * `readBoard` 遇到坏 JSON 会把它**跳过**，于是它不出现在任何一份卡列表里。
     * 如果这里只看「不在列表里就删」，那么一次**毫不相干**的写入（改别的卡）
     * 就会顺手把那份坏文件删掉——而它可能只是少了一个逗号，
     * 是用户唯一的数据。
     *
     * 判据：**只有能确认是一张卡的文件才算「被删掉的卡」**。
     * 读不出来的东西我们不知道它是什么，就不动它。
     */
    if (readCard(workspaceRoot, projectName, id) === null) {
      logFailure('看板:写入', '有读不出来的卡片文件，没敢删（留人工处理）', 'readCard 返回 null', { dir, name })
      continue
    }
    const gone = removeCard(workspaceRoot, projectName, id)
    if (gone.ok === true && gone.removed === true) removed += 1
  }
  return { ok: true, dir, count: list.length, removed }
}

/**
 * **老的单文件看板 → 一卡一文件**（v2.4.9）。
 *
 * ## 为什么必须有这一步
 *
 * v2.4.8 及以前，一个项目的卡都在 `派单.json` 的 `cards` 数组里。升级到本版后，
 * `readBoard` 改扫 `派单/` 目录——那个目录还不存在，于是返回**空看板**。
 * 用户看到的是「**我所有的任务卡都不见了**」，而文件其实好端端躺在磁盘上。
 *
 * ## 幂等，且只在真的需要时动手
 *
 * - `派单/` 已经有文件 → 什么都不做（`isDir` 一次 stat，这是热路径，要便宜）；
 * - 没有 `派单.json` → 没什么可搬的；
 * - 有 `派单.json` 但 `cards` 是空的 → 不动它，也不建目录（避免为一个空看板造目录）。
 *
 * 搬完把老文件**改名**成 `派单.json.migrated`，而不是删掉：迁移是不可逆的
 * 结构变更，留一份原文件在磁盘上，万一搬错了还能人工捞回来。
 * 改名而不是保留原名，是为了让下一次 `migrateBoard` 不再重复搬一遍。
 */
export function migrateBoard(workspaceRoot, projectName) {
  const dir = boardDirPath(workspaceRoot, projectName)
  const legacy = boardPath(workspaceRoot, projectName)
  if (dir === null || legacy === null) return { ok: true, migrated: 0 }
  if (isDir(dir)) return { ok: true, migrated: 0 }
  if (!isFile(legacy)) return { ok: true, migrated: 0 }
  const text = readText(legacy)
  if (text === null) return { ok: true, migrated: 0 }
  let cards = []
  try {
    const parsed = JSON.parse(text)
    cards = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.cards) ? parsed.cards : [])
  } catch (error) {
    // 老文件是坏 JSON：**不搬、也不改名**。改名的话这份坏文件就再也没人看了，
    // 而它可能是用户唯一的数据——留给人工处理，并留痕。
    logFailure('看板:迁移', '老的派单.json 是坏 JSON，没搬', error, { file: legacy })
    return { ok: true, migrated: 0, degraded: true }
  }
  cards = cards.filter((card) => card !== null && card !== undefined && typeof card === 'object' && cardFile(card.id) !== null)
  if (cards.length === 0) return { ok: true, migrated: 0 }

  const written = writeBoard(workspaceRoot, projectName, cards)
  if (written.ok !== true) {
    logFailure('看板:迁移', '老的派单.json 搬不过来', written.hint || written.error, { file: legacy, count: cards.length })
    return { ok: true, migrated: 0, degraded: true }
  }
  try {
    renameSync(legacy, legacy + '.migrated')
  } catch (error) {
    // 改名失败**不影响结果**：卡已经写进 `派单/` 了，而 `readBoard` 只看那个目录。
    // 留着原名只是下次会再搬一遍（幂等，写的是同样的内容）。
    logFailure('看板:迁移', '搬完了但老文件没改名', error, { file: legacy })
  }
  return { ok: true, migrated: cards.length }
}

/**
 * 生成下一个卡 id（`task-0001` 递增）。
 *
 * ⚠️ 它只按**传进来的卡**算，所以调用方必须给全量看板。给局部列表会撞 id，
 * 而撞 id 的后果是**两张卡写进同一个文件**——后写的那张直接覆盖前一张，
 * 用户看到的是「新建了一张卡，另一张不见了」。
 */
export function nextCardId(cards) {
  let max = 0
  for (const card of Array.isArray(cards) ? cards : []) {
    const match = /^task-(\d+)$/.exec(String(card.id || ''))
    if (match === null) continue
    const n = Number.parseInt(match[1], 10)
    if (Number.isSafeInteger(n) && n > max) max = n
  }
  return 'task-' + String(max + 1).padStart(4, '0')
}

/**
 * 追加一条 `history`（**两条路径都要写**：自动搬 `by:'auto'`、手动按钮 `by:'manual'`）。
 *
 * 为什么必须两条都写：U4 判据 14 要求「手动按钮搬的痕迹与拖拽一致」。
 * 只给拖拽写历史，事后追查时就会看到「这张卡凭空换了列」。
 */
export function pushHistory(card, from, to, by, note) {
  const next = { ...card }
  const history = Array.isArray(card.history) ? card.history.slice() : []
  history.push({
    at: Date.now(),
    from,
    to,
    by: by === 'auto' ? 'auto' : 'manual',
    note: typeof note === 'string' ? note : '',
  })
  next.history = history
  next.column = to
  next.updatedAt = Date.now()
  if (from !== to) next.columnChangedAt = Date.now()
  return next
}

/**
 * 失败判定的**优先级**（Q7）。顺序即优先级，避免同一次变化被搬两次。
 *
 * | 顺序 | 条件 | 落位 |
 * |---|---|---|
 * | 1 | `phase === 'complete'` | 已做（标未验收） |
 * | 2 | `phase === 'blocked'` | 失败（原因取 `blockedReason`） |
 * | 3 | `lastAgentError` 非空且 `phase !== 'complete'` | 失败（原因取 `lastAgentError`） |
 * | 4 | `active + disarmed + 不运行` 持续超阈值 | 失败（`code:'stalled'`） |
 *
 * **`complete` 最大**：已经做完的卡不该因为一条残留 error 被搬进失败列。
 * 第 3 条的 `phase !== 'complete'` 就是为了挡住这个。
 *
 * `blockedReason.code` **实际有 4 种**（本方案早前写的「三种」是错的，已按源码更正）：
 * `round-limit`（轮次用尽，驱动自动 block）/ `queue-failed`（轮次入不了队）/
 * `prompt-rejected`（`agent/pre-step` 判定该轮无效）/ `model-reported`（模型自报阻塞）。
 */
export const BLOCKED_CODES = ['round-limit', 'queue-failed', 'prompt-rejected', 'model-reported']

/**
 * 判定「这张卡该不该搬列」，返回 `{ column, failure }`；不用搬时 `column` 等于当前列。
 *
 * 纯函数、无副作用：给它的是一次**观测**（goal phase / activation / running /
 * lastAgentError / 已停止多少毫秒），它给出结论。宿主半负责取观测、写盘。
 */
export function verdictOf(card, observed, options = {}) {
  const stallMs = Number.isSafeInteger(options.stallMs) && options.stallMs > 0 ? options.stallMs : STALL_MS
  const o = observed !== null && observed !== undefined ? observed : {}
  const phase = typeof o.phase === 'string' ? o.phase : ''
  const activation = typeof o.activation === 'string' ? o.activation : ''
  const running = o.running === true
  const error = typeof o.lastAgentError === 'string' && o.lastAgentError !== '' ? o.lastAgentError : null
  const stoppedFor = Number.isSafeInteger(o.stoppedForMs) && o.stoppedForMs > 0 ? o.stoppedForMs : 0

  // ① 完成：**优先级最高**。
  if (phase === 'complete') {
    return { column: 'done', failure: null, reason: 'complete', verified: false }
  }
  // ② goal 被 block：4 种 code 全算失败。
  if (phase === 'blocked') {
    const code = BLOCKED_CODES.includes(o.blockedCode) ? o.blockedCode : 'blocked'
    return {
      column: 'failed',
      reason: 'blocked',
      failure: { code, message: typeof o.blockedMessage === 'string' ? o.blockedMessage : '' },
    }
  }
  // ③ 会话级报错：**只在非 complete 时**算失败（挡住「做完但报过错」被搬进失败列）。
  if (error !== null && phase !== 'complete') {
    return { column: 'failed', reason: 'agent-error', failure: { code: 'agent-error', message: error } }
  }
  // ④ 卡死超时：`active + disarmed + 不运行` 持续超过阈值。
  //    为什么需要它：`agent/error` 会让驱动 `disarm` 却**不改 phase**，
  //    于是 goal 仍是 `active` 而驱动不再推轮次——①②③ 都判不出来，卡会永远停在「在做」。
  if (phase === 'active' && activation === 'disarmed' && !running && stoppedFor >= stallMs) {
    return {
      column: 'failed',
      reason: 'stalled',
      failure: { code: 'stalled', message: `已停止自动推进 ${Math.round(stoppedFor / 60000)} 分钟` },
    }
  }
  return { column: card.column, failure: card.failure ?? null, reason: '' }
}

/**
 * 把「分解产物」拼成**首轮用户消息**（Q1 的字段-流转对应表）。
 *
 * `objective` 进 goal、`steps` 与 `description` 进首轮消息——**两种粒度都要给**：
 * 只给 objective，AI 每轮都要重新想「先干什么」；只给 steps，goal 驱动就没有目标
 * 可判「做完了没有」。
 *
 * ## `executionPrompt` 放最前（v2.2.0）
 *
 * 它是澄清器写下的**具体执行提示词**——比 `steps` 更完整（含文件与顺序）。
 * 放最前是因为执行会话读到的第一段就该是「你到底要我干什么」；
 * 后面的 `steps` / `constraints` / `acceptance` 是补充，与它并存不冲突。
 *
 * ## 标题也要给（v2.2.8 补的真缺口）
 *
 * 首轮消息原先**没有标题**（用户点名要求「标题 / 描述 / 具体执行提示词为上下文」）。
 * 用互斥哨兵实测过：`title` 从不出现，而 `objective` / `description` /
 * `sourceRequest` / `executionPrompt` 都在。缺标题的后果是执行会话不知道
 * **这张卡叫什么**——它的汇报、它写的文档段、它跟大脑对话时都没有一个可引用的名字，
 * 而看板上那一列显示的就是标题。
 *
 * 放在最前（目标之前）：它是一行短标签，先给「这是哪件事」的锚点。
 */
export function firstPromptOf(plan) {
  const p = plan !== null && plan !== undefined ? plan : {}
  const lines = []
  const title = typeof p.title === 'string' ? p.title.trim() : ''
  const objective = typeof p.objective === 'string' ? p.objective.trim() : ''
  const description = typeof p.description === 'string' ? p.description.trim() : ''
  const source = typeof p.sourceRequest === 'string' ? p.sourceRequest.trim() : ''
  const execution = typeof p.executionPrompt === 'string' ? p.executionPrompt.trim() : ''
  if (title !== '') lines.push('**任务单**：' + title)
  if (objective !== '') {
    // 标题在时与目标之间空一行；标题不在时目标就是第一行，不留空行。
    if (lines.length > 0) lines.push('')
    lines.push('**目标**：' + objective)
  }
  if (description !== '') lines.push('', '**背景与边界**：' + description)
  if (source !== '') lines.push('', '**用户的原话**（需求原文，一字未改）：', source)
  if (execution !== '') lines.push('', '**具体执行提示词**（澄清器写的，按它做）：', execution)
  const steps = Array.isArray(p.steps) ? p.steps : []
  if (steps.length > 0) {
    lines.push('', '**执行骨架**（按这个顺序做，可按实际情况调整）：')
    for (const step of steps) {
      if (step === null || typeof step !== 'object') continue
      const doWhat = typeof step.do === 'string' ? step.do : ''
      const doneWhen = typeof step.done_when === 'string' && step.done_when !== '' ? '（完成判据：' + step.done_when + '）' : ''
      const files = Array.isArray(step.files) && step.files.length > 0 ? '（涉及：' + step.files.join('、') + '）' : ''
      lines.push(`${step.n ?? '-'}. ${doWhat}${files}${doneWhen}`)
    }
  }
  const constraints = Array.isArray(p.constraints) ? p.constraints.filter((c) => typeof c === 'string' && c !== '') : []
  if (constraints.length > 0) {
    lines.push('', '**约束**：')
    for (const one of constraints) lines.push('- ' + one)
  }
  const acceptance = Array.isArray(p.acceptance) ? p.acceptance.filter((c) => typeof c === 'string' && c !== '') : []
  if (acceptance.length > 0) {
    lines.push('', '**验收判据**：')
    for (const one of acceptance) lines.push('- ' + one)
  }
  return lines.join('\n')
}

/**
 * 冻结校验：必填字段齐没齐（Q1 说的「可校验」）。
 *
 * ## 判据（v2.2.0 起）：目标 + **执行交代**
 *
 * 「执行交代」有两档，**任给其一**即可冻结：
 *   - `executionPrompt`：澄清器写下的那一段具体执行提示词（v2.2.0 新增）；
 *   - `steps`：结构化骨架（澄清器也可以只给这个）。
 *
 * 为什么是「或」而不是「都要」：两者是同一件事的两种粒度，用户与模型
 * 选哪种都行；逼着两份都填，只会让人把同一段话抄两遍。
 *
 * 约束与验收判据缺失**不拦**——它们能让方案更完整，但拦着不让冻结会把
 * 「想先开工」的用户挡在门外。
 *
 * 反过来说，**目标为空绝对不许冻结**：goal 只认一句 `objective`，
 * 没有它整个执行阶段就没有「做完了没有」的判据。
 */
export function freezeCheck(plan) {
  const p = plan !== null && plan !== undefined ? plan : {}
  const objective = typeof p.objective === 'string' ? p.objective.trim() : ''
  if (objective === '') {
    return { ok: false, error: '还没写目标，不能冻结', hint: 'goal 只认一句可判定的目标——没有它，执行阶段无法判断「做完了没有」。' }
  }
  const execution = typeof p.executionPrompt === 'string' ? p.executionPrompt.trim() : ''
  const steps = Array.isArray(p.steps) ? p.steps.filter((s) => s !== null && typeof s === 'object') : []
  if (execution === '' && steps.length === 0) {
    return {
      ok: false,
      error: '还没有执行交代，不能冻结',
      hint: '至少要写一步「做什么」（或让澄清器写下一段具体执行提示词），否则派单会话没有起点。',
    }
  }
  return { ok: true }
}

/** 按列分组（面板渲染用；顺序固定，与 `BOARD_COLUMNS` 一致）。 */
export function groupByColumn(cards) {
  const out = {}
  for (const key of BOARD_COLUMNS) out[key] = []
  for (const card of Array.isArray(cards) ? cards : []) {
    const key = BOARD_COLUMNS.includes(card.column) ? card.column : 'unclarified'
    out[key].push(card)
  }
  return out
}

/** 卡片标题的安全截断（面板一行放不下长标题；截断只影响显示，落盘保留原文）。 */
export function shortTitle(title, limit = 40) {
  const text = typeof title === 'string' ? title.trim() : ''
  return text.length <= limit ? text : text.slice(0, limit - 1) + '…'
}

/** 默认的分解系统提示（`system` 字段，**固定不变**，见 U4「新建任务单」）。 */
export const DECOMPOSE_SYSTEM = [
  '你是任务分解器。用户会给一段口语化的需求，你把它整理成结构化字段。',
  '',
  '**只输出一个 JSON 对象**，字段恰好是 `title` / `objective` / `description`，没有别的字段。',
  '不要 Markdown 围栏，不要解释文字。',
  '',
  '规则：',
  '- `title`：一句话标题，不超过 40 字。',
  '- `objective`：**一句话、可判定**（写完能判断做没做到）。它将来会直接当 goal 的目标，goal 只认一句。',
  '- `description`：说明做什么 / 边界 / 已知约束，可以几段。',
  '- **不许编造需求里没有的信息**；需求没提到的（比如具体技术选型）留空或写「待澄清」。',
  '  分解**不是澄清**——澄清归澄清器。分解阶段编出来的约束会一路带进执行。',
  '- 输出语言**跟随需求原文的语言**。',
].join('\n')

/**
 * 从模型输出里**剥出**三个字段（容错解析）。
 *
 * 必须处理的三种偏差（按发生频率排序，都是实测常见形态）：
 *   1. 模型顺手加了 ```json 围栏 → **先剥围栏再解析**（这是最常见的一种）；
 *   2. 前后带了说明文字 → 取**第一个 `{` 到最后一个 `}`** 之间的片段；
 *   3. 字段缺失 / 类型不对 → 缺哪个就**留空那个**，**不要**用整段需求去顶替
 *      （顶替会让用户以为模型给了一个目标，而其实那是原文的截断）。
 */
export function parseDecompose(text) {
  const raw = typeof text === 'string' ? text : ''
  let body = raw.trim()
  // ① 剥围栏：```json ... ``` 或 ``` ... ```
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(body)
  if (fence !== null) body = fence[1].trim()
  // ② 取最外层的对象片段
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) {
    return { ok: false, error: '模型没有返回 JSON 对象', raw: raw.slice(0, 400) }
  }
  let parsed = null
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch (error) {
    return { ok: false, error: '模型返回的 JSON 解析失败：' + String(error && error.message ? error.message : error), raw: raw.slice(0, 400) }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '模型返回的不是一个对象', raw: raw.slice(0, 400) }
  }
  const str = (key) => (typeof parsed[key] === 'string' ? parsed[key].trim() : '')
  const out = { title: str('title'), objective: str('objective'), description: str('description') }
  // 缺字段**如实报**，让面板把那一栏留空并提示用户自己补——而不是静默填一段假内容。
  const missing = Object.keys(out).filter((key) => out[key] === '')
  return { ok: true, ...out, missing }
}

/* ============================ 会话接线（v2.1.0） ============================ */

/**
 * 派单执行的**默认轮次上限**。
 *
 * ## 为什么必须有上限
 *
 * `maxGoalRounds` 是 goal 的**唯一**预算闸门——goal 不计量 token、不计量钱、
 * 不计量挂钟时间（`dsh-goal` 的「已知限制」里写明了）。不设上限就等于
 * 「这张卡可以无声地烧到用户自己发现为止」，而那正是用户最不该承担的风险。
 *
 * 30 是「够做完一件正经事、又不至于失控」的经验值。面板上按卡可改。
 */
export const DEFAULT_MAX_GOAL_ROUNDS = 30

/**
 * 澄清会话的轮次上限。
 *
 * 澄清是**交互式**的（一问一答），所以它不需要 goal 的自动续行；这个数只用来
 * 在提示里告诉模型「问几轮之内该收敛了」，不是硬闸门。
 */
export const CLARIFIER_MAX_ROUNDS = 40

/**
 * 卡死超时阈值（毫秒）：`active + disarmed + 不运行` 持续超过它就判失败。
 *
 * 提成常量是为了让 `verdictOf` 的默认值、面板文案与测试**引同一处**——
 * 三处各写一个 600000 迟早会漂移，而漂移的表现是「面板说 5 分钟、判定按 10 分钟」。
 */
export const STALL_MS = 600000

/**
 * 这张卡**能不能派出去**（纯函数，宿主与面板都引它）。
 *
 * 四道闸门，顺序即优先级——**先报最根上的那个**，否则用户会去修一个
 * 不是原因的原因（比如方案没冻结，却先被告知「已经派出去了」）。
 */
export function dispatchVerdict(card) {
  if (card === null || card === undefined || typeof card !== 'object') {
    return { ok: false, error: '卡片不存在' }
  }
  if (typeof card.goalId === 'string' && card.goalId !== '') {
    return {
      ok: false,
      error: '这张卡已经派出去了',
      hint: '它带着 goal ' + card.goalId + '。要重做请把它拖回「在做」接着原会话，或先重铸新版本。',
    }
  }
  if (card.column !== 'pending') {
    return {
      ok: false,
      error: '只有「未接单」的卡能派出去',
      hint: '先把方案冻结并移到「未接单」列——派单执行读的就是那份冻结方案。',
    }
  }
  const plan = card.plan !== null && card.plan !== undefined ? card.plan : {}
  if (plan.frozenAt === null || plan.frozenAt === undefined) {
    return {
      ok: false,
      error: '方案还没冻结，不能派出去',
      /**
       * ⚠️ 这条提示**只能是「去冻结」**（v2.4.12）。
       *
       * 能走到这里，卡**一定**在「未接单」——上面那道闸门已经把别的列全挡了。
       * 原先那句「点『开始澄清』问清楚」在这个位置是**指错路**：卡早澄清过了，
       * 而当时面板在「未接单」列又**没有冻结按钮**（这正是用户报的那个死路）。
       * 现在按钮有了，提示也就指得对了。
       */
      hint: '打开这张卡的详情，点「冻结」——方案定稿后才能派出去。',
    }
  }
  // 冻结过也可能被改空（比如手改过 JSON）——所以**再验一次**，不只信 `frozenAt`。
  return freezeCheck(plan)
}

/**
 * 这张卡**能不能起澄清**。
 *
 * 只有「未澄清」列能起；而且**已经在澄清中的卡不许重复起**——
 * 重复起会造出两个澄清会话，各自冻结出互相矛盾的方案，而用户只看到一张卡。
 */
export function clarifyVerdict(card) {
  if (card === null || card === undefined || typeof card !== 'object') {
    return { ok: false, error: '卡片不存在' }
  }
  if (card.column !== 'unclarified') {
    return {
      ok: false,
      error: '只有「未澄清」的卡能起澄清',
      hint: '方案已经冻结的卡不用再澄清；要改就把它拖回「未澄清」（重铸新版本）。',
    }
  }
  if (typeof card.clarifySessionId === 'string' && card.clarifySessionId !== '') {
    return { ok: true, reuse: card.clarifySessionId }
  }
  return { ok: true, reuse: '' }
}

/**
 * **冻结这张卡**（纯函数，返回新卡）。
 *
 * ## 冻结到底是什么
 *
 * 它是「用户拍板：方案定了，可以开工」这一个动作，**只做一件事**：
 * 写 `plan.frozenAt`（派单的第一道闸门看它——`dispatchVerdict`）。
 *
 * ## 为什么不再搬列（v2.4.13，用户拍板）
 *
 * v2.4.12 之前它做两件事：写 `frozenAt` **并**把卡从「未澄清」搬到「未接单」。
 * 那个捆法的前提是「冻结 = 进未接单的门」。但 v2.4.4 给「未澄清 → 未接单」
 * 接上**自动起澄清**之后，卡可以**不经过冻结**就进「未接单」——
 * 而那一列的语义写的是「已冻结」。前提没了，捆法就只剩副作用：
 * 一个动作改两样东西（方案状态 + 列），用户看到的错会分不清是哪一样出的。
 *
 * 现在一列一件事：**「未澄清」管澄清，「未接单」管冻结**。
 * 搬列归 `moveVerdict`，冻结归这里，各自单一。
 *
 * ## 为什么不能重复冻结
 *
 * 已经冻结的卡再冻一次会**重置 `frozenAt`**，于是「冻结时间」这个事实就丢了
 * （重铸新版本时要靠它区分 v1/v2）。所以这里直接拒绝，而不是幂等覆盖。
 *
 * @returns `{ok:true, card}` 或 `{ok:false, error, hint}`
 */
export function freezeCard(card) {
  if (card === null || card === undefined || typeof card !== 'object') {
    return { ok: false, error: '卡片不存在' }
  }
  /**
   * ## 冻结**只发生在「未接单」**，而且**不搬列**（v2.4.13，用户拍板）
   *
   * 用户原话：「未澄清卡才能冻结是什么鬼，不应该是未接单吗」。
   *
   * 原先这里放行 `unclarified`，理由是「冻结 = 写 `frozenAt` **并**搬到「未接单」」，
   * 两件事捆在一起。那个捆法来自「冻结就是进未接单的门」这个早期理解。
   *
   * 但 v2.4.4 给「未澄清 → 未接单」接上**自动起澄清**之后，捆法就自相矛盾了：
   * 拖过去会**自动进「未接单」**，而那一列的语义是「已冻结」——可它并没有冻。
   * 于是同一列里混着「冻过」和「没冻」两种卡，而冻结按钮只长在「未澄清」，
   * 那些被拖进来的卡既冻不了也派不出去。
   *
   * 拍板后的分工（一列一件事）：
   *
   * | 列 | 负责 |
   * |---|---|
   * | 未澄清 | **澄清**（开始澄清 / 拖过去自动澄清） |
   * | 未接单 | **冻结** → 冻完才派得出去 |
   *
   * 所以这里只认 `pending`，并且**只写 `frozenAt`、绝不搬列**——
   * 搬列是 `moveVerdict` 的事，一个动作做两件事正是上面那团乱的根。
   *
   * 「未澄清」的卡要冻结，先把它移到「未接单」（拖过去会自动起澄清）。
   */
  if (card.column !== 'pending') {
    return {
      ok: false,
      error: '只有「未接单」的卡能冻结',
      hint: card.column === 'unclarified'
        ? '先把卡移到「未接单」（拖过去会自动开始澄清），方案问全后再冻结。'
        : `这张卡在「${COLUMN_LABELS[card.column] || card.column}」列。已经开工或已有结论的卡不用再冻结。`,
    }
  }
  const plan = card.plan !== null && card.plan !== undefined ? card.plan : {}
  if (plan.frozenAt !== null && plan.frozenAt !== undefined) {
    return {
      ok: false,
      error: '这张卡已经冻结过了',
      hint: '要改方案请把它拖回「未澄清」（已冻结的卡拖回去 = 重铸新版本）。',
    }
  }
  // 判据与派单第一道闸门**同一个函数**：两处各写一套必然漂移
  // （表现是「冻结放过了，派单却拒了」）。
  const check = freezeCheck(plan)
  if (check.ok !== true) return { ok: false, error: check.error, hint: check.hint }
  /**
   * **不写 `history`**：`history` 记的是**搬动**（`from → to`）。
   * 冻结不搬列，塞一条「未接单 → 未接单」进去只会污染那份记录。
   */
  return { ok: true, card: { ...card, plan: { ...plan, frozenAt: Date.now() }, updatedAt: Date.now() } }
}

/**
 * 从方案生成 `goals.create` 的请求（纯函数）。
 *
 * 为什么单独一个函数：`objective` 是 goal 的**全部**输入（goal 只认一句），
 * 而它来自用户可编辑的输入框——空串、纯空白、超长都得在这一处收口，
 * 不能让 `goals.create` 去替我们判。
 */
export function goalRequestOf(plan, maxGoalRounds) {
  const p = plan !== null && plan !== undefined ? plan : {}
  const objective = typeof p.objective === 'string' ? p.objective.trim() : ''
  if (objective === '') {
    return { ok: false, error: '目标为空，不能建 goal', hint: 'goal 只认一句可判定的目标——回澄清页把它写上。' }
  }
  const cap = Number.isSafeInteger(maxGoalRounds) && maxGoalRounds > 0 ? maxGoalRounds : DEFAULT_MAX_GOAL_ROUNDS
  return { ok: true, request: { objective, maxGoalRounds: cap } }
}

/**
 * 组装 `verdictOf` 要的**观测**（纯函数）。
 *
 * ## 为什么观测要拼三处
 *
 * `verdictOf` 判四种情况，而它们的数据**不来自同一个地方**：
 *
 * | 判据 | 数据源 |
 * |---|---|
 * | `phase === 'complete'` / `'blocked'` | `goals.get(agent)` |
 * | `activation` / `roundsStarted` | `goals.get(agent)` |
 * | `running` | `sessionController.list()` 的 `SessionSummary` |
 * | `lastAgentError` | 会话日志（`agent/error`） |
 *
 * 只接 goal 那一处的话，第 ③ 条（会话级报错）与第 ④ 条（卡死超时）**永远判不出来**——
 * 而第 ④ 条恰恰是 `agent/error` 让驱动 `disarm` 却不改 phase 时唯一的兜底。
 *
 * `stoppedForMs` 由调用方算（要 `Date.now()`，纯函数不碰时钟）。
 */
export function observeOf(goal, summary, options = {}) {
  const g = goal !== null && goal !== undefined ? goal : {}
  const s = summary !== null && summary !== undefined ? summary : {}
  const o = {
    phase: typeof g.phase === 'string' ? g.phase : '',
    activation: typeof g.activation === 'string' ? g.activation : '',
    running: s.running === true,
  }
  const reason = g.blockedReason
  if (reason !== null && reason !== undefined && typeof reason === 'object') {
    o.blockedCode = typeof reason.code === 'string' ? reason.code : ''
    o.blockedMessage = typeof reason.message === 'string' ? reason.message : ''
  }
  if (typeof options.lastAgentError === 'string' && options.lastAgentError !== '') {
    o.lastAgentError = options.lastAgentError
  }
  if (Number.isSafeInteger(options.stoppedForMs) && options.stoppedForMs > 0) {
    o.stoppedForMs = options.stoppedForMs
  }
  return o
}

/**
 * **澄清器的固定系统提示**（v2.1.0，用户拍板「全局大脑」）。
 *
 * ## 它为什么是常量而不是每轮拼
 *
 * 用户要的是「这个澄清器是**固定的**」——固定意味着两件事：
 *   1. 它的**人格与纪律**不变：不写代码、不编造、问真岔路、以盘上文档为准；
 *   2. 它的**上下文结构**不变：主文档 + 模块索引在每轮开头，检索手段写死。
 *
 * 每轮变的东西（需求原文、主文档正文、路径）走 `clarifierPromptOf` 拼进**首轮消息**，
 * 不塞进这里——塞进来就不是常量了，而常量才能被测试逐字钉住。
 */
export const CLARIFIER_SYSTEM = [
  '你是**澄清器**：把用户一段口语化的需求，问成一份**可执行、可验收**的方案。',
  '',
  '## 你不做什么',
  '- **你不写代码**。你的产物是「方案」，不是实现——实现由派单会话做。',
  '- **你不编造**。需求里没有的信息去问用户，不要自己填；填出来的约束会一路带进执行。',
  '- **你不假装做过**。没读过的文件就说没读，不要凭印象描述它。',
  '',
  '## 你手上有什么',
  '- 消息里给了这个项目的**主文档全文**与**模块索引**——那是这个项目已定的事实，先读它。',
  '- 你可以用 read / grep / glob 去**检索模块文档**（路径见消息里的「拼图文档根」）。',
  '- 你还可以**小量检索代码**（路径见「代码根」）——只查「这个改动会碰到什么」，不要通读。',
  '',
  '## 你怎么问',
  '- 一次最多 10 个问题，每题给 3–6 个**真岔路**，每个岔路写清代价。',
  '- 只问真正卡住决定的点；同一件事只有一种做法时不要硬凑选项。',
  '- 问完就停，**不要**追加「要不要先停下」之类的收尾问。',
  '',
  '## 什么时候冻结',
  '目标（一句话、可判定）+ 至少一步「做什么」齐了就能冻结。',
  '约束与验收判据能让方案更完整，但**不拦冻结**——想先开工的用户不该被挡在门外。',
  '',
  '## 你的上下文管理（用户明确要求的一条）',
  '- **每轮以盘上文档为准**：它可能已经被改过，而你记得的版本可能已经过期。',
  '- 拿不准就**重新读一遍**主文档或那个模块文档，不要凭记忆回答。',
  '- 你的结论要**落回文档**（走 puzzle_mode），不要只留在对话里——对话会滚走，文档不会。',
  '- 改了文档就在回复里**说清改了哪一份**，让用户能核。',
].join('\n')

/**
 * 拼澄清会话的**首轮用户消息**（纯函数，可测）。
 *
 * ## 为什么把主文档全文内联，而不是让模型自己去读
 *
 * 用户要的是「有拼图文档的**主文档全部信息**」——那是一个**先验**，
 * 不是一次检索。让它自己读的代价是：它可能不读、读一半、或读到一个中间版本，
 * 而澄清的每一步都建立在「这个项目已经定了什么」之上。内联是唯一能保证
 * 「开口就知道」的做法。
 *
 * 模块文档**不内联**（那是「快速检索」的活）：索引给它，正文让它按需 read。
 */
export function clarifierPromptOf(input) {
  const i = input !== null && input !== undefined ? input : {}
  const lines = []
  lines.push('# 要澄清的需求')
  lines.push('')
  const request = typeof i.request === 'string' ? i.request.trim() : ''
  lines.push(request !== '' ? request : '（用户没写需求原文——先问他要做什么。）')
  lines.push('')
  /**
   * **任务单是「未澄清」那一张**（v2.2.0）：把它的标题也带上，
   * 因为澄清器是从全局大脑分叉出来的，它继承的对话里**没有**这张卡的信息——
   * 不带的话它得先猜「用户现在说的是哪件事」。
   */
  const taskTitle = typeof i.taskTitle === 'string' ? i.taskTitle.trim() : ''
  if (taskTitle !== '') lines.push('- 这张任务单：' + taskTitle)
  lines.push('')
  lines.push('# 这个项目现在长什么样')
  lines.push('')
  const project = typeof i.project === 'string' ? i.project.trim() : ''
  if (project !== '') lines.push('- 项目：' + project)
  if (typeof i.dataWorkspace === 'string' && i.dataWorkspace !== '') {
    lines.push('- 拼图文档根：' + i.dataWorkspace)
  }
  if (typeof i.codeWorkspace === 'string' && i.codeWorkspace !== '') {
    lines.push('- 代码根：' + i.codeWorkspace)
  } else {
    lines.push('- 代码根：**没配**——不要去找代码，只按文档澄清。')
  }
  lines.push('')
  const index = typeof i.moduleIndex === 'string' ? i.moduleIndex.trim() : ''
  if (index !== '') {
    lines.push('## 模块索引（模块 → 一句话职责 → 文件）')
    lines.push('')
    lines.push(index)
    lines.push('')
  }
  /**
   * `inlineMainDoc`（v2.2.0）：默认 `true`（老路径，主文档是它唯一的来源）。
   *
   * 从全局大脑分叉的澄清器**不再内联**：那份主文档已经走
   * `puzzle-mode:brain-doc` 那一段进了它的系统提示（见 `brain.js`）。
   * 再内联一份 = 同一份内容付两次费，而且两份会漂移。
   */
  if (i.inlineMainDoc !== false) {
    const main = typeof i.mainDoc === 'string' ? i.mainDoc.trim() : ''
    lines.push('## 主文档全文')
    lines.push('')
    lines.push(main !== '' ? main : '（主文档是空的——这个项目还没写任何已定事实。）')
    lines.push('')
  } else {
    lines.push('> 主文档全文已经在你的系统提示里（「这个项目的文档」那一段），这里不再重复。')
    lines.push('')
  }
  lines.push('# 你这一轮要做什么')
  lines.push('')
  lines.push('先读上面的主文档，再决定要问什么。要问就问**真正卡住决定**的点，最多 10 个。')
  lines.push('')
  /**
   * **写完就结束**（v2.2.0，用户拍板）：澄清器的产物就是那张卡上的四个字段。
   * 它不搬卡、不建卡、不管别的卡——那些是用户与全局大脑的事。
   */
  lines.push('## 问完之后')
  lines.push('')
  if (i.hasWriter === true) {
    lines.push('用 `puzzle_task` 把结果写回**这张任务单**：标题 / 目标 / 描述 / 具体执行提示词。')
  } else {
    lines.push('把结果整理成四段写清楚：标题 / 目标 / 描述 / 具体执行提示词（用户会手填进任务单）。')
  }
  lines.push('写完就**结束这一轮**——用户会关掉这个澄清会话。')
  return lines.join('\n')
}

