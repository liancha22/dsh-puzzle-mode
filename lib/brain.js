/**
 * 全局大脑：**项目级常驻会话** + 冻结式文档上下文 + 专属工具。
 *
 * 用户要的是**一个项目一个大脑**：它常驻、记得住、澄清器从它这里分叉出去
 * （此前澄清器每次从零起会话，同一项目问十次就有十份互不知情的上下文）。三件事：
 *
 *   1. **人设 + 拼图纪律**（`BRAIN_SYSTEM`）：走子会话 systemPrompt 注入，是常量；
 *   2. **拼图文档段**（`BRAIN_CONTEXT_SECTION_NAME`）：**没压缩时冻结**，
 *      只在压缩时重新读盘更新（见 `brainDocHolder` 与 `refreshBrainDoc`）；
 *   3. **专属工具**：`puzzle_brain`（回读模块文档 / 检索条目 / 看执行汇报）。
 *
 * ## 「冻结」的实现
 *
 * `systemPrompt.section({text})` 的 `text` 可以是字符串（永不变）或函数（每次装配求值）。
 * 这里注册**函数**，但它只读 `holder.text`，而 `holder.text` **只有 `refreshBrainDoc` 会改**——
 * 效果与字符串一样（没压缩就不变），却不必为了刷新去注销再重注册。
 *
 * ⚠️ **不能靠「重名再注册一次」刷新**：宿主 `dsh-scope` 的 `NamedEntries.insert` 对
 * **同层同名**直接抛错（`prompt section "x" is already registered in this scope`）。
 * 重名注册不是覆盖、是抛异常——那条路走不通。
 *
 * ## 不自己判「该不该压缩」
 *
 * 压缩是宿主的事（`compaction/start` → `summary` → `end`）。插件只**听**那个事件，
 * 不自己数 token、不自己算阈值——那会造出第二套判据，迟早不一致（表现为「该更新时没更新」）。
 *
 * ## 检索是纯函数，注入才有副作用
 *
 * `taskReports` / `brainPromptOf` / `docLookup` 不碰盘、不碰 Cordis，可直接测；
 * 只有 `installBrain` / `installTaskWriter` 碰 agent。与 `clarifier.js` 同一套分工。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { clarifierLookup, LOOKUP_MAX_HITS, LOOKUP_MAX_NAMES, LOOKUP_MAX_QUERIES } from './clarifier.js'

/**
 * 全局大脑的人设与纪律（常量，可被测试逐字钉住）。
 *
 * ## 为什么与澄清器分成两份而不是共用一份
 *
 * 两者的**职责不同**：大脑是「这个项目的常驻记忆 + 总控」，它会看执行汇报、
 * 回写文档、被反复追问；澄清器是「就这一张任务单问清楚」的一次性角色，
 * 它**不写代码、也不该管别的卡**。共用一份文本就得在里面写满
 * 「如果你是澄清器则……」的条件句，那种文本模型读起来更容易串味。
 */
export const BRAIN_SYSTEM = [
  '你是这个项目的**全局大脑**：常驻、记得住、对项目的全部已定事实负责。',
  '',
  '## 你是什么',
  '- 你是**项目级**的：一个项目一个你，不是「一次任务一个」。用户会反复回来找你。',
  '- 你手上带着这个项目的**主文档**（见下一条上下文段），那是这个项目已定的事实。',
  '- 你可以**回读任意模块文档**、**检索模块文档条目**，也可以用 `puzzle_mode` 把结论**写回文档**。',
  '- 你能**看执行代理的任务汇报**（每张卡的目标 / 轮次 / 失败 / 历史），据此判断谁卡住了。',
  '',
  '## 你不做什么',
  '- **你不写代码**。你出的是方案与判断；实现由派单会话做。',
  '- **你不编造**。文档里没有、用户也没说的信息，去问用户，不要自己填。',
  '- **你不假装做过**。没读过的文件就说没读过，不要凭印象描述它。',
  '',
  '## 你的上下文纪律（用户明确要求的一条）',
  '- 你上下文里那份「项目文档」是**冻结的**：它是你上次被压缩时读到的版本。',
  '- 所以**拿不准就以工具为准**：用 `puzzle_brain` 的 `main` / `module` / `search` 重新读一遍，',
  '  不要拿记忆里的版本当现状回答。',
  '- **一次读多处**：`module` 给 `names` 一次读几份模块文档，`search` 给 `queries` 一次搜几个词——',
  '  同一件事不要连调三次。单次有总量上限，超了返回里会点名哪些没读。',
  '- 你的结论要**落回文档**（走 `puzzle_mode`），不要只留在对话里——对话会滚走，文档不会。',
  '- **一次写多处**：把这一轮的结论攒成一批 `writes` 一次落盘（同一个文件的多节只解析一次），',
  '  别一节一节地调——大文档上每多一次调用就多付一次全量读写。',
  '',
  '## 澄清器是你派出去的',
  '- 用户为某张未澄清的任务单呼出澄清器时，它会**从你这里分叉**（继承你的上下文）。',
  '- 所以你要把「这个项目已定什么」保持在文档里：它继承的是你的上下文，不是你脑子里的印象。',
].join('\n')

/** 人设段名与序号（`10125`：夹在本插件 `10120` 与澄清器 `10130` 之间，不撞宿主内置段序）。 */
export const BRAIN_SECTION_NAME = 'puzzle-mode:brain'
export const BRAIN_SECTION_ORDER = 10125

/**
 * 拼图文档段名与序号。
 *
 * 序号取 `10126`（人设段之后、澄清器之前）：文档是**事实**，人设是**角色**，
 * 事实紧跟角色，模型读到的是「你是谁 → 这个项目现在是什么样 → 纪律」。
 */
export const BRAIN_CONTEXT_SECTION_NAME = 'puzzle-mode:brain-doc'
export const BRAIN_CONTEXT_SECTION_ORDER = 10126

/** 大脑的专属工具名。与澄清器的 `puzzle_context` **分开**：两者 op 面不同。 */
export const BRAIN_TOOL_NAME = 'puzzle_brain'

/** 澄清器写任务单的专属工具名（用户拍板「他有单独的工具用于写任务单」）。 */
export const TASK_TOOL_NAME = 'puzzle_task'

/** 一份「冻结文档段」的持有者。只有 `refreshBrainDoc` 会改 `text`。 */
export function brainDocHolder(initialText, lookup) {
  return {
    text: typeof initialText === 'string' ? initialText : '',
    /** 重读用的取数口。存在 holder 上，压缩事件才能在不知道项目的情况下重读。 */
    lookup: typeof lookup === 'function' ? lookup : null,
    reads: 0,
  }
}

/**
 * 进程内的大脑文档段登记表：`sessionId → holder`。
 *
 * 为什么需要它：刷新发生在 `index.js` 的 `session/event` 监听里（那是全局钩子），
 * 而 holder 是 `installBrain` 闭包里的东西。中间必须有这么一张表。
 * 键是会话 id，所以一个会话只可能有一个 holder——与「一个项目一个大脑」一致。
 */
const brainHolders = new Map()

/** 登记一个会话的文档段 holder（由 `installBrain` 调）。 */
export function noteBrainHolder(sessionId, holder) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  if (holder === null || holder === undefined) return
  brainHolders.set(sessionId, holder)
}

/** 这个会话是不是大脑（有 holder 就是）。 */
export function isBrainSession(sessionId) {
  return typeof sessionId === 'string' && brainHolders.has(sessionId)
}

/**
 * **重新读盘并更新那个冻结段**——只在压缩时调。
 *
 * ## 为什么返回 `{ok, reason}` 而不是抛错
 *
 * 它跑在 `session/event` 的监听里（emit 是 fire-and-forget）。抛错会被宿主
 * 记成一次监听器异常，而真正该发生的事（这一步照常走）反而没人管。
 * 所以如实返回，由调用方决定要不要记一行。
 */
export function refreshBrainDoc(sessionId, lookup) {
  const holder = brainHolders.get(sessionId)
  if (holder === undefined) return { ok: false, reason: '这个会话没有登记大脑文档段' }
  // 优先用调用方这次给的 lookup；没给就用登记时存下的那个（压缩事件里没有项目上下文）。
  const read = typeof lookup === 'function' ? lookup : holder.lookup
  if (typeof read !== 'function') return { ok: false, reason: '没给 lookup，读不到最新文档' }
  try {
    const source = read()
    const s = source !== null && source !== undefined ? source : {}
    const main = typeof s.mainDoc === 'function' ? s.mainDoc() : s.mainDoc
    const index = typeof s.moduleIndex === 'function' ? s.moduleIndex() : s.moduleIndex
    holder.text = brainDocText(main, index)
    holder.reads += 1
    return { ok: true, chars: holder.text.length }
  } catch (error) {
    const raw = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
    return { ok: false, reason: '重读文档失败：' + raw }
  }
}

/** 供测试与诊断用：这个会话的文档段现在是什么。 */
export function brainDocOf(sessionId) {
  const holder = brainHolders.get(sessionId)
  return holder === undefined ? null : holder.text
}

/** 清掉登记（会话结束 / 测试隔离用）。 */
export function forgetBrainHolder(sessionId) {
  brainHolders.delete(sessionId)
}

/** 把主文档与模块索引拼成那一段**注入文本**（纯函数）。 */
export function brainDocText(mainDoc, moduleIndex) {
  const main = typeof mainDoc === 'string' ? mainDoc.trim() : ''
  const index = typeof moduleIndex === 'string' ? moduleIndex.trim() : ''
  const lines = []
  lines.push('# 这个项目的文档（冻结快照）')
  lines.push('')
  lines.push('⚠️ 这是**你上次被压缩时**读到的版本，可能已经过期。拿不准就用 `puzzle_brain` 重读。')
  lines.push('')
  if (index !== '') {
    lines.push('## 模块索引（模块 → 一句话职责 → 文件）')
    lines.push('')
    lines.push(index)
    lines.push('')
  }
  lines.push('## 主文档全文')
  lines.push('')
  lines.push(main !== '' ? main : '（主文档是空的——这个项目还没写任何已定事实。）')
  return lines.join('\n')
}

/**
 * **执行代理的任务汇报**（纯函数）。
 *
 * ## 为什么只给「goal 状态 + 摘要」而不是逐轮转录
 *
 * 用户拍板的就是这一档。逐轮转录（`sessionQuery`）要读别的会话的日志，
 * 一次几万 token，而大脑要判断的是「谁卡住了、谁做完了、失败在哪」——
 * 那三件事全在卡上（`column` / `goalId` / `roundsStarted` / `failure` / `history`）
 * 与 goal 视图（`phase` / `activation` / `blockedReason`）里。
 *
 * `liveOf` 是 thunk：`sessionId → goal 视图或 undefined`。它可能对某些会话
 * 拿不到（会话已回收 / 没有 goals 服务），那时**如实说「拿不到实时 goal」**，
 * 不假装卡上的字段就是全部。
 */
export function taskReports(board, liveOf) {
  const cards = board !== null && board !== undefined && Array.isArray(board.cards) ? board.cards : []
  const live = typeof liveOf === 'function' ? liveOf : null
  const out = []
  for (const card of cards) {
    if (card === null || typeof card !== 'object') continue
    const plan = card.plan !== null && card.plan !== undefined ? card.plan : {}
    const row = {
      id: String(card.id || ''),
      title: String(card.title || ''),
      column: String(card.column || ''),
      objective: typeof plan.objective === 'string' ? plan.objective : '',
      sessionId: typeof card.sessionId === 'string' ? card.sessionId : '',
      goalId: typeof card.goalId === 'string' ? card.goalId : '',
      roundsStarted: Number.isSafeInteger(card.roundsStarted) ? card.roundsStarted : 0,
      maxGoalRounds: Number.isSafeInteger(card.maxGoalRounds) ? card.maxGoalRounds : null,
      verified: card.verified === true,
      failure: card.failure !== null && card.failure !== undefined ? card.failure : null,
    }
    /**
     * 历史只给**最后三条**：大脑要看的是「它最近动过没有、为什么动的」，
     * 而一张卡可能被搬过几十次——全给就是把上下文塞满搬卡记录。
     */
    const history = Array.isArray(card.history) ? card.history : []
    row.history = history.slice(-3).map((one) => ({
      from: String(one.from || ''),
      to: String(one.to || ''),
      by: String(one.by || ''),
      note: String(one.note || ''),
    }))
    if (live !== null && row.sessionId !== '') {
      const view = live(row.sessionId)
      if (view !== null && view !== undefined) {
        row.goal = {
          phase: typeof view.phase === 'string' ? view.phase : '',
          activation: typeof view.activation === 'string' ? view.activation : '',
          roundsStarted: Number.isSafeInteger(view.roundsStarted) ? view.roundsStarted : null,
          blockedCode: view.blockedReason !== null && view.blockedReason !== undefined && typeof view.blockedReason === 'object'
            ? String(view.blockedReason.code || '')
            : '',
        }
      } else {
        row.goal = null
        row.goalNote = '拿不到这个会话的实时 goal（会话可能已回收，或这台部署没有 goals 服务）——上面是卡上记录的值。'
      }
    }
    out.push(row)
  }
  return out
}

/**
 * 大脑的**首轮用户消息**（纯函数）。
 *
 * ## 为什么主文档不在这里内联
 *
 * 它已经走 `BRAIN_CONTEXT_SECTION_NAME` 那个段进了系统提示（那是「冻结」的载体）。
 * 再在首轮消息里塞一份就是**同一份内容付两次费**，而且两份会漂移——
 * 模型看到两个版本时无从判断哪个是现状。
 *
 * 这里只给**每轮会变的东西**：项目名、文档根、代码根、以及「现在要你做什么」。
 */
export function brainPromptOf(input) {
  const i = input !== null && input !== undefined ? input : {}
  const lines = []
  lines.push('# 你现在是「' + (typeof i.project === 'string' && i.project !== '' ? i.project : '这个项目') + '」的全局大脑')
  lines.push('')
  lines.push('主文档全文已经在你的系统提示里（那一段是冻结快照）。这一条只交代位置与职责。')
  lines.push('')
  if (typeof i.dataWorkspace === 'string' && i.dataWorkspace !== '') {
    lines.push('- 拼图文档根：' + i.dataWorkspace)
  }
  if (typeof i.codeWorkspace === 'string' && i.codeWorkspace !== '') {
    lines.push('- 代码根：' + i.codeWorkspace)
  } else {
    lines.push('- 代码根：**没配**——只按文档判断，不要去找代码。')
  }
  lines.push('')
  lines.push('# 你这一轮要做什么')
  lines.push('')
  lines.push('先确认你已经读到了主文档，然后用一句话说明「这个项目现在是什么状态」。')
  lines.push('之后等用户提问：他可能会让你回读某个模块、检索某条已定事实、或看执行代理的汇报。')
  lines.push('**不要主动开工**——你是常驻的，不是你每次开口都要改点什么。')
  return lines.join('\n')
}

/** `puzzle_brain` 的工具描述：写清每个 op 什么时候用，否则模型会拿 `main` 当万能答案。 */
const BRAIN_TOOL_DESCRIPTION = [
  '全局大脑的专属工具：回读这个项目的文档，以及看执行代理的汇报。',
  'op=main 取主文档全文（**以它为准**，不要凭记忆回答）；',
  'op=modules 取模块索引；',
  'op=module 并给 names 取那几份模块文档的正文（一次多份；旧的 name 单数也认）；',
  'op=search 并给 queries 在拼图文档里搜命中行（一次多个词，各给一段；旧的 query 单数也认）；',
  'op=code 并给 queries 在源码里搜命中行（只查「这个改动会碰到什么」，不要通读）；',
  'op=reports 看每张任务单的 goal 状态与摘要（谁在做、谁卡住、失败在哪）。',
  '一次能取多处就一次取完——别为同一件事连调三次；但单次有总量上限，超了返回里会点名哪些没读。',
  '文档可能已被改过，而你上下文里那份是冻结快照——拿不准就重新调一次。',
].join('')

/** 澄清器写任务单的工具描述。 */
const TASK_TOOL_DESCRIPTION = [
  '把澄清结果写回**这一张**任务单：标题 / 目标 / 描述 / 具体执行提示词。',
  '只写这四个字段，不搬卡、不建卡、不动别的卡。',
  '「具体执行提示词」要写清「改哪些文件、按什么顺序、每步的完成判据」——',
  '执行会话拿到它就直接开工，不需要再猜。',
].join('')

/**
 * 把大脑的人设、冻结文档段与专属工具**注册进这个子会话的作用域**。
 *
 * ## 顺序与降级（与 `installClarifier` 同一条纪律）
 *
 * 先人设 → 再文档段 → 最后工具。人设失败就整体降级（角色是重点），
 * 文档段失败只降那一段，工具失败只降工具那一半。
 * **任何一步失败都不抛错**：会话已经建出来了，抛错会留一个孤儿会话。
 */
export function installBrain(agent, options) {
  const o = options !== null && options !== undefined ? options : {}
  const ctx = agent !== null && agent !== undefined ? agent.ctx : undefined
  const prompt = ctx !== null && ctx !== undefined ? ctx.systemPrompt : undefined
  if (prompt === null || prompt === undefined || typeof prompt.section !== 'function') {
    return { ok: false, reason: '这个会话拿不到 agent 作用域的 systemPrompt，人设注入不进去' }
  }

  try {
    prompt.section({
      name: BRAIN_SECTION_NAME,
      order: BRAIN_SECTION_ORDER,
      text: typeof o.system === 'string' && o.system !== '' ? o.system : BRAIN_SYSTEM,
    })
  } catch (error) {
    const raw = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
    return { ok: false, reason: '注册人设失败：' + raw }
  }

  /**
   * 文档段：`text` 是**函数**，读的是 holder —— 没压缩就不变（见文件头）。
   * holder 必须先登记再注册，否则压缩事件可能早于登记到达（那时刷不到东西）。
   *
   * 调用方没给 holder 时在这里现造一个：它要带着 `lookup`，因为压缩事件
   * 到达时没有项目上下文，只能靠 holder 自己记着「去哪儿重读」。
   */
  const holder = o.holder !== null && o.holder !== undefined ? o.holder : brainDocHolder('', o.lookup)
  if (typeof o.sessionId === 'string' && o.sessionId !== '') noteBrainHolder(o.sessionId, holder)
  let doc = true
  let docReason = ''
  try {
    prompt.section({
      name: BRAIN_CONTEXT_SECTION_NAME,
      order: BRAIN_CONTEXT_SECTION_ORDER,
      text: () => holder.text,
    })
  } catch (error) {
    doc = false
    docReason = '注册文档段失败：' + (error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error))
  }

  const tools = ctx !== null && ctx !== undefined ? ctx.tools : undefined
  if (tools === null || tools === undefined || typeof tools.register !== 'function') {
    return { ok: true, section: true, doc, docReason, tool: false, reason: '这个会话拿不到 agent 作用域的 tools，专属工具没装上（人设与文档段已到位）' }
  }
  const lookup = o.lookup
  const reports = o.reports
  try {
    tools.register(defineTool({
      name: BRAIN_TOOL_NAME,
      description: BRAIN_TOOL_DESCRIPTION,
      parameters: {
        op: {
          type: 'string',
          required: true,
          enum: ['main', 'modules', 'module', 'search', 'code', 'reports'],
          description: 'main 主文档 / modules 模块索引 / module 某些模块（给 names）/ search 搜文档（给 queries）/ code 搜源码（给 queries）/ reports 执行汇报',
        },
        name: { type: 'string', description: 'op:module 时的**单个**模块名（旧写法，仍可用）；要一次读多份就用 names' },
        names: {
          type: 'array',
          items: { type: 'string' },
          description: `op:module 时的模块名列表，一次读多份（单次最多 ${LOOKUP_MAX_NAMES} 份）；名字要与模块索引里完全一致`,
        },
        query: { type: 'string', description: 'op:search / op:code 时的**单个**检索词（旧写法，仍可用）；要一次搜多个词就用 queries' },
        queries: {
          type: 'array',
          items: { type: 'string' },
          description: `op:search / op:code 时的检索词列表，一次搜多个（单次最多 ${LOOKUP_MAX_QUERIES} 个词），返回里一个词一段`,
        },
        limit: { type: 'number', description: `每个检索词最多返回多少条命中；默认与上限都是 ${LOOKUP_MAX_HITS}` },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(args) {
        const op = args !== null && args !== undefined && typeof args.op === 'string' ? args.op : ''
        if (op === 'reports') {
          /**
           * 取汇报要读看板 + 问 goal。两者都由调用方给 thunk——
           * 本文件不碰盘、不碰 Cordis（见文件头）。
           */
          if (typeof reports !== 'function') {
            return { ok: false, error: '这个大脑没接上汇报通道', hint: '调用方没给 reports thunk。' }
          }
          const board = reports()
          const cards = board !== null && board !== undefined && Array.isArray(board.cards) ? board : { cards: [] }
          return {
            ok: true,
            op,
            title: '执行代理的任务汇报',
            cards: taskReports(cards, o.liveGoalOf),
          }
        }
        return clarifierLookup(args, typeof lookup === 'function' ? lookup() : {})
      },
    }))
  } catch (error) {
    const raw = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
    return { ok: true, section: true, doc, docReason, tool: false, reason: '注册专属工具失败：' + raw }
  }
  return { ok: true, section: true, doc, docReason, tool: true, toolName: BRAIN_TOOL_NAME }
}

/**
 * 给**澄清器**装「写任务单」的工具（用户拍板「他有单独的工具用于写任务单」）。
 *
 * ## 为什么不让澄清器直接用 `puzzle_mode` 写
 *
 * 看板不是拼图文档：它在 `<数据工作区>/拼图/<项目名>/派单/`（**项目级 + 一卡一文件**，v2.4.9），
 * 形状是五列卡片，
 * 而 `puzzle_mode` 的 op 面全是「主文档 / 模块文档的小节」。让它拿文档工具
 * 去写卡片 JSON，等于把「卡片长什么样」这条规则交给模型自由发挥。
 * 所以这里开一个**窄口子**：只能改这一张卡的四个字段，走与面板同一个
 * `writeBoard` 落盘（同一个原子写、同一份形状）。
 *
 * ## 写完就结束
 *
 * 工具只负责落盘并回执；「任务完成、请按 ✕ 关掉这个澄清器」由**面板**说
 * （那是 UI 的职责，写进工具返回里模型看不到用户）。
 */
export function installTaskWriter(agent, options) {
  const o = options !== null && options !== undefined ? options : {}
  const ctx = agent !== null && agent !== undefined ? agent.ctx : undefined
  const tools = ctx !== null && ctx !== undefined ? ctx.tools : undefined
  if (tools === null || tools === undefined || typeof tools.register !== 'function') {
    return { ok: false, tool: false, reason: '这个会话拿不到 agent 作用域的 tools，写任务单的工具没装上' }
  }
  const write = o.write
  if (typeof write !== 'function') {
    return { ok: false, tool: false, reason: '没给 write，写任务单的工具没装上' }
  }
  try {
    tools.register(defineTool({
      name: TASK_TOOL_NAME,
      description: TASK_TOOL_DESCRIPTION,
      parameters: {
        title: { type: 'string', description: '一句话标题，不超过 40 字' },
        objective: { type: 'string', description: '**一句话、可判定**的目标——它将来直接当 goal 的目标' },
        description: { type: 'string', description: '背景与边界：做什么、不做什么、已知约束' },
        executionPrompt: {
          type: 'string',
          required: true,
          description: '具体执行提示词：改哪些文件、按什么顺序、每步的完成判据。执行会话直接拿它开工',
        },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(args) {
        const a = args !== null && args !== undefined ? args : {}
        return write({
          title: typeof a.title === 'string' ? a.title : '',
          objective: typeof a.objective === 'string' ? a.objective : '',
          description: typeof a.description === 'string' ? a.description : '',
          executionPrompt: typeof a.executionPrompt === 'string' ? a.executionPrompt : '',
        })
      },
    }))
  } catch (error) {
    const raw = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
    return { ok: false, tool: false, reason: '注册写任务单的工具失败：' + raw }
  }
  return { ok: true, tool: true, toolName: TASK_TOOL_NAME }
}
