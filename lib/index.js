/**
 * dsh-puzzle-mode —— 宿主半（Host）。
 *
 * 四件事，全部挂在当前插件的 Fiber 上，卸载即撤销：
 *   1) systemPrompt 一段静态规则 `puzzle-mode:policy`：提问节奏（含固定收尾问）、
 *      建项目时机、文档结构、两种执行模式的许可边界；
 *   2) 模型工具 `puzzle_mode`：读状态 / 建项目 / 改主文档小节 / 改模块文档 / 切模式；
 *   3) `agent/pre-step` Waterfall 监听：项目处于「只拼不写」时，从本步剔除越权工具并回注说明；
 *   4) webServer 路由 `/puzzle-mode-rpc`：浏览器半唯一的数据通道（与 dsh-session-health 同模式）。
 *
 * 平面：宿主组成。工具、提示段、路由都必须进程内唯一，所以整行放宿主机，不进 preset。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_MODE,
  MODES,
  MODE_PUZZLE_ONLY,
  MODE_PUZZLE_WRITE,
  PAUSE_OPTIONS,
  PAUSE_QUESTION,
  PUZZLE_ONLY_ALLOWED_TOOLS,
  PUZZLE_DIR,
  createProject,
  defaultProjectName,
  isExecutableMode,
  listProjects,
  readState,
  setMode,
  slugify,
  summarize,
  updateMainSection,
  updateModuleSection,
} from './puzzle.js'

export const name = 'dsh-puzzle-mode'
export const inject = ['tools', 'systemPrompt', 'webServer']

const SECTION_NAME = 'puzzle-mode:policy'
const ORDER = 10500
const MAX_BODY = 16384

/** 提示段里反复引用的固定收尾问原文（工具返回里也带同一份）。 */
const PAUSE_LINE = `提问的最后一项固定问「${PAUSE_QUESTION}」，选项固定两项：① ${PAUSE_OPTIONS[0]}：只回写文档 + 一句话说明，**本轮立即结束**，不执行任何动作；② ${PAUSE_OPTIONS[1]}：按当前模式继续。`

function policyText() {
  return [
    '## 拼图模式',
    '',
    '本会话启用了「拼图模式」：把项目拆成一份**主文档**加若干**模块文档**，用提问把不确定项变成已定项。',
    '',
    '### 提问',
    '- 你**主动提问**，不要等用户想起来才问：一轮 ≤3 问，能用选项就用选项，问的是真正卡住决定的点。',
    '- ' + PAUSE_LINE,
    '- 提问与文档回写**在同一步完成**：先问、再把问答写进文档，不要只问不写、也不要攒到最后一起写。',
    '',
    '### 项目',
    `- 用户说明了基于某个项目 → 先 \`puzzle_mode{op:'read'}\` 找到已有的 ${PUZZLE_DIR}/，在它上面继续。`,
    `- 用户没说明 → 用 \`puzzle_mode{op:'init'}\` 新建：**一次同时创建主文档与每个模块一份文档**，不要只建主文档。`,
    `- 目录固定为 \`<项目根>/<项目名>/${PUZZLE_DIR}/主文档.md\` 与 \`${PUZZLE_DIR}/模块/<模块名>.md\`。新项目先执行 \`read\`（看是否已存在），再 \`init\`。`,
    '',
    '### 文档分工',
    '- 主文档只放六节，且**每节只留精简一行**：`## 检索索引`（模块 → 一句话职责 → 文件）、`## 坑`、`## 用户原话`（等价引用，不要改写）、`## 悬而未决`、`## 已定`、`## 撤销`。',
    '- 细节一律下沉到模块文档：`## 进度`（`完成度: 0-100`）、`## 要点`、`## 与本模块相关的悬而未决 / 已定 / 撤销`、`## 详细记录`。',
    '- 话被推翻时不要删旧行：在 `## 撤销` 里写 `~~旧结论~~ → 改判为 ⇒ 新结论（时间，原因）`，并把新结论补进 `## 已定`。',
    '',
    '### 两种执行模式',
    `- **${MODE_PUZZLE_ONLY}**：只提问 + 更新文档；不执行任何动作（不跑命令、不改代码，越权工具会被宿主拦下）。`,
    `- **${MODE_PUZZLE_WRITE}**：小改动问一次、大改动问一次，问完可以直接执行。`,
    `- 当前模式由 \`puzzle_mode{op:'read'}\` 返回的 \`mode\` / \`canExecute\` 给出，每次动手前先看它；模式只允许 \`${MODES.join('` / `')}\`。`,
    '',
    '若本会话被压缩成 checkpoint，checkpoint 的 `## Critical Context` 必须原样保留本节规则。',
  ].join('\n')
}

/* --------------------------------- 会话与项目定位 --------------------------------- */

function sessionCwd(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions !== undefined && typeof sessionId === 'string' && sessionId !== '') {
    try {
      const live = sessions.get(sessionId)
      const cwd = live !== undefined && live !== null && live.header !== undefined ? live.header.cwd : undefined
      if (typeof cwd === 'string' && cwd !== '') return cwd
    } catch (_error) {
      /* 会话已不在内存里：退回进程工作目录 */
    }
  }
  try {
    return process.cwd()
  } catch (_error) {
    return '/'
  }
}

/**
 * 定位本次调用要操作的项目：
 *   显式给了 project → 用它；
 *   否则项目根下已有拼图项目 → 用最新的那个，没有 → 用当天日期生成的默认名。
 */
function locate(ctx, projectRoot, requested) {
  const slug = typeof requested === 'string' && requested.trim() !== '' ? slugify(requested) : null
  if (slug !== null) return { project: slug, exists: listProjects(projectRoot).some((item) => item.name === slug) }
  const existing = listProjects(projectRoot)
  if (existing.length > 0) return { project: existing[0].name, exists: true }
  return { project: defaultProjectName(''), exists: false }
}

/* --------------------------------- 工具 --------------------------------- */

const TOOL_DESCRIPTION = [
  '拼图模式：把项目拆成主文档 + 模块文档，用提问把不确定项变成已定项。',
  'op=read 读状态（不建文件）；op=init 一次创建主文档与每个模块一份文档；op=main 更新主文档六节之一；op=module 更新（必要时创建）模块文档；op=mode 切换执行模式。',
  `每次调用返回都带 askPause:true——**每一次提问的最后都要问「${PAUSE_QUESTION}」，两个选项：${PAUSE_OPTIONS.join(' / ')}**；用户选第一项时只回写文档并结束本轮，不执行任何动作。`,
  `当前模式见返回的 mode/canExecute：${MODE_PUZZLE_ONLY} 只提问与更新文档；${MODE_PUZZLE_WRITE} 可执行且小改动问一次、大改动问一次。`,
].join('\n')

/**
 * 本插件唯一会往对话里写的一条消息：只拼不写时的拦截说明。
 * 形状与 dsh-batch-tool-calls 的提醒一致（role/id/content/source 齐全，source.form = 'notice'），
 * 手写而不用 createUserMessage：后者的入参是「完整消息对象」，容易写出畸形消息。
 */
function noticeMessage(text, summary) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name, form: 'notice', summary },
  }
}

function failure(error, hint) {
  return { ok: false, error, hint }
}

export function apply(ctx) {
  ctx.systemPrompt.section({ name: SECTION_NAME, order: ORDER, text: policyText() })

  ctx.tools.register(defineTool({
    name: 'puzzle_mode',
    description: TOOL_DESCRIPTION,
    parameters: {
      op: {
        type: 'string',
        required: true,
        description: 'read 读状态 / init 新建项目 / main 主文档小节 / module 模块文档小节 / mode 切换模式',
        enum: ['read', 'init', 'main', 'module', 'mode'],
      },
      project: { type: 'string', description: '项目名；省略时用项目根下最新的拼图项目，没有则按当天日期生成' },
      goal: { type: 'string', description: 'init：这个项目要达成什么（一句话）' },
      modules: {
        type: 'array',
        description: 'init：要同时创建的模块名列表（每个模块一份文档）',
        items: { type: 'string' },
      },
      section: { type: 'string', description: 'main：index/pit/quote/pending/decided/revoked；module：progress/points/related/detail' },
      name: { type: 'string', description: 'module：模块名（不存在则创建）' },
      content: { type: 'string', description: '要写入的正文（markdown 片段）' },
      append: { type: 'boolean', description: 'true 追加到小节末尾，false 覆盖该小节；默认追加' },
      mode: { type: 'string', description: `mode：${MODES.join(' / ')}`, enum: MODES },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      const projectRoot = sessionCwd(ctx, exec !== undefined && exec.agent !== undefined && exec.agent !== null && exec.agent.session !== undefined
        ? exec.agent.session.id
        : undefined)
      const located = locate(ctx, projectRoot, args.project)
      const project = located.project
      const append = args.append !== false

      if (args.op === 'read') {
        return summarize(readState(projectRoot, project), { projectRequested: project })
      }

      if (args.op === 'init') {
        const created = createProject(projectRoot, project, args.goal ?? '', args.modules ?? [], DEFAULT_MODE)
        if (created.ok !== true) return failure(created.error, created.hint)
        return summarize(readState(projectRoot, created.project), {
          created: true,
          createdModules: created.created,
          existingModules: created.existing,
          next: '现在开始一轮提问（≤3 问），并在最后问一次要不要先停下',
        })
      }

      if (args.op === 'main') {
        if (typeof args.section !== 'string' || args.section === '') return failure('缺少 section', '可用：index / pit / quote / pending / decided / revoked')
        const result = updateMainSection(projectRoot, project, args.section, args.content ?? '', append)
        if (result.ok !== true) return failure(result.error, result.hint)
        return summarize(readState(projectRoot, project), { section: args.section })
      }

      if (args.op === 'module') {
        if (typeof args.name !== 'string' || args.name === '') return failure('缺少 name', '给出模块名，例如 auth-flow')
        if (typeof args.section !== 'string' || args.section === '') return failure('缺少 section', '可用：progress / points / related / detail')
        const result = updateModuleSection(projectRoot, project, args.name, args.section, args.content ?? '', append)
        if (result.ok !== true) return failure(result.error, result.hint)
        return summarize(readState(projectRoot, project), { module: args.name, section: args.section, created: result.created })
      }

      if (args.op === 'mode') {
        if (typeof args.mode !== 'string' || !MODES.includes(args.mode)) return failure(`未知模式 ${String(args.mode)}`, `可用：${MODES.join(' / ')}`)
        const result = setMode(projectRoot, project, args.mode)
        if (result.ok !== true) return failure(result.error, result.hint)
        return summarize(readState(projectRoot, project), { modeChanged: args.mode })
      }

      return failure(`未知 op ${String(args.op)}`, '可用：read / init / main / module / mode')
    },
  }), 'dsh-puzzle-mode: puzzle_mode tool')

  /* ------------------------ 只拼不写：本步剔除越权工具 ------------------------ */

  if (typeof ctx.on === 'function') {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') return decision
      if (payload === null || typeof payload !== 'object' || payload.agent === undefined || payload.agent === null) return decision
      const session = payload.agent.session
      if (session === undefined || session === null) return decision

      let projectRoot
      try {
        projectRoot = session.header !== undefined && typeof session.header.cwd === 'string' && session.header.cwd !== ''
          ? session.header.cwd
          : process.cwd()
      } catch (_error) {
        return decision
      }
      const existing = listProjects(projectRoot)
      if (existing.length === 0) return decision
      const state = readState(projectRoot, existing[0].name)
      if (state.initialized !== true || isExecutableMode(state.mode)) return decision

      const messages = decision.messages
      if (!Array.isArray(messages)) return decision
      const blocked = []
      const kept = []
      let dropping = false
      for (const message of messages) {
        if (message !== null && typeof message === 'object' && message.role === 'assistant' && Array.isArray(message.content)) {
          const calls = message.content.filter((block) => block !== null && typeof block === 'object' && block.type === 'tool-call')
          const keep = calls.filter((block) => PUZZLE_ONLY_ALLOWED_TOOLS.includes(block.name))
          for (const block of calls) if (!PUZZLE_ONLY_ALLOWED_TOOLS.includes(block.name)) blocked.push(String(block.name))
          if (calls.length > 0 && keep.length === 0) {
            dropping = true
            continue
          }
          if (keep.length !== calls.length) {
            dropping = true
            kept.push({ ...message, content: message.content.filter((block) => block === null || typeof block !== 'object' || block.type !== 'tool-call' || PUZZLE_ONLY_ALLOWED_TOOLS.includes(block.name)) })
            continue
          }
        }
        kept.push(message)
      }
      if (blocked.length === 0) return decision

      const notice = noticeMessage(
        `[拼图模式 · ${MODE_PUZZLE_ONLY}] 已拦下本步的非文档工具：${[...new Set(blocked)].join('、')}。本模式只允许提问与更新拼图文档（${PUZZLE_ONLY_ALLOWED_TOOLS.join(' / ')}）。`
        + '请改为：把本轮结论写进文档 → 提出下一次提问 → 最后问一次「' + PAUSE_QUESTION + '」（① ' + PAUSE_OPTIONS[0] + ' ② ' + PAUSE_OPTIONS[1] + '）。'
        + '用户想执行就把模式切到「' + MODE_PUZZLE_WRITE + '」。',
        '拼图模式：只拼不写，已拦下非文档工具',
      )
      return { ...decision, messages: dropping ? [...kept, notice] : [...messages, notice] }
    }, 'dsh-puzzle-mode: 只拼不写拦截')
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
        const projectRoot = sessionCwd(ctx, sessionId)
        const located = locate(ctx, projectRoot, undefined)

        if (body.method === 'state') {
          respond(res, 200, {
            ok: true,
            result: summarize(readState(projectRoot, located.project), { projectRequested: located.project }),
          })
          return
        }
        if (body.method === 'mode') {
          if (!MODES.includes(body.mode)) {
            respond(res, 400, { ok: false, error: `未知模式 ${String(body.mode)}` })
            return
          }
          const result = setMode(projectRoot, located.project, body.mode)
          if (result.ok !== true) {
            respond(res, 200, { ok: false, error: result.error })
            return
          }
          respond(res, 200, { ok: true, result: summarize(readState(projectRoot, located.project)) })
          return
        }
        respond(res, 400, { ok: false, error: `未知 method ${String(body.method)}` })
      },
    }), 'dsh-puzzle-mode: rpc route')
  })
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

function respond(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

export { policyText, summarize }
