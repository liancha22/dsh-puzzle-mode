/**
 * dsh-puzzle-mode —— 宿主半（Host）。
 *
 * 四件事，全部挂在当前插件的 Fiber 上，卸载即撤销：
 *   1) systemPrompt 一段静态规则 `puzzle-mode:policy`：提问节奏（含固定收尾问）、
 *      建项目时机、文档结构、两种执行模式的许可边界；
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
  projectSummaries,
  readModuleDetail,
  readState,
  setMode,
  slugify,
  summarize,
  summarizeList,
  updateMainSection,
  updateModuleSection,
} from './puzzle.js'

export const name = 'dsh-puzzle-mode'
export const inject = ['tools', 'systemPrompt', 'webServer']

const SECTION_NAME = 'puzzle-mode:policy'
const ORDER = 10500
const MAX_BODY = 16384
const OPS = ['list', 'read', 'show', 'init', 'main', 'module', 'mode']

/** 提示段里反复引用的固定收尾问原文（工具返回里也带同一份）。 */
const PAUSE_LINE = `提问的最后一项固定问「${PAUSE_QUESTION}」，选项固定两项：① ${PAUSE_OPTIONS[0]}：只回写文档 + 一句话说明，**本轮立即结束**，不执行任何动作；② ${PAUSE_OPTIONS[1]}：按当前模式继续。`

/** 拒绝时的理由：一句话说清「为什么被拦 + 现在该做什么」。 */
function denyReason(toolName) {
  return `[拼图模式 · ${MODE_PUZZLE_ONLY}] 已拦下工具「${toolName}」：本模式只提问与更新拼图文档，`
    + `不执行任何动作（不跑命令、不改代码）。当前允许：${PUZZLE_ONLY_ALLOWED_TOOLS.join(' / ')}。`
    + `文档更新请用 puzzle_mode（它带路径守卫），不要用 write / edit。`
    + `请改为：把本轮结论写进文档 → 提出下一次提问 → 最后问一次「${PAUSE_QUESTION}」`
    + `（① ${PAUSE_OPTIONS[0]} ② ${PAUSE_OPTIONS[1]}）。`
    + `用户想执行就把模式切到「${MODE_PUZZLE_WRITE}」（puzzle_mode{op:'mode'} 或面板按钮）。`
}

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
    `- 先看有哪些项目：\`puzzle_mode{op:'list'}\`。用户说明了基于某个项目 → 用它的名字调 \`op:'read'\`，在它上面继续。`,
    `- 用户没说明 → \`op:'read'\` 看默认项目；确认要开新的再用 \`op:'init'\` **一次同时创建主文档与每个模块一份文档**，不要只建主文档。`,
    `- 多个项目并存时**必须显式给 \`project\`**：不给就默认用最新的那个，容易改错项目。`,
    `- 目录固定为 \`<项目根>/<项目名>/${PUZZLE_DIR}/主文档.md\` 与 \`${PUZZLE_DIR}/模块/<模块名>.md\`。`,
    '',
    '### 文档分工',
    '- 主文档只放六节，且**每节只留精简一行**：`## 检索索引`（模块 → 一句话职责 → 文件）、`## 坑`、`## 用户原话`（等价引用，不要改写）、`## 悬而未决`、`## 已定`、`## 撤销`。',
    '- 细节一律下沉到模块文档：`## 进度`（`完成度: 0-100`）、`## 要点`、`## 与本模块相关的悬而未决 / 已定 / 撤销`、`## 详细记录`。',
    '- 话被推翻时不要删旧行：在 `## 撤销` 里写 `~~旧结论~~ → 改判为 ⇒ 新结论（时间，原因）`，并把新结论补进 `## 已定`。',
    '',
    '### 两种执行模式',
    `- **${MODE_PUZZLE_ONLY}**：只提问 + 更新文档；不执行任何动作（越权工具会被宿主 deny，错误里会说明原因）。`,
    `- **${MODE_PUZZLE_WRITE}**：小改动问一次、大改动问一次，问完可以直接执行。`,
    `- 当前模式由 \`puzzle_mode{op:'read'}\` 返回的 \`mode\` / \`canExecute\` 给出，每次动手前先看它；模式只允许 \`${MODES.join('` / `')}\`。`,
    '',
    '若本会话被压缩成 checkpoint，checkpoint 的 `## Critical Context` 必须原样保留本节规则。',
  ].join('\n')
}

/* --------------------------------- 会话与项目定位 --------------------------------- */

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
 * 定位本次调用要操作的项目：
 *   显式给了 project → 用它（source: 'explicit'）；
 *   否则项目根下已有拼图项目 → 用最新的那个（source: 'latest'）；
 *   都没有 → 用当天日期生成的默认名（source: 'default'）。
 */
function locate(projectRoot, requested) {
  const slug = typeof requested === 'string' && requested.trim() !== '' ? slugify(requested) : null
  if (slug !== null) {
    return { project: slug, source: 'explicit', exists: listProjects(projectRoot).some((item) => item.name === slug) }
  }
  const existing = listProjects(projectRoot)
  if (existing.length > 0) return { project: existing[0].name, source: 'latest', exists: true }
  return { project: defaultProjectName(''), source: 'default', exists: false }
}

/** 把定位结果并进返回，让「用的是哪个项目、项目根从哪来」始终可见。 */
function located(ctx, sessionId, requested) {
  const resolved = sessionCwd(ctx, sessionId)
  const where = locate(resolved.cwd, requested)
  const extra = {
    projectRoot: resolved.cwd,
    cwdSource: resolved.source,
    projectRequested: where.project,
    projectSource: where.source,
  }
  if (resolved.source !== 'session') {
    extra.hint = `拿不到会话工作目录，已退回进程目录 ${resolved.cwd}——文档可能写到了这里而不是你的工作区。请确认项目根。`
  } else if (where.source === 'latest' && listProjects(resolved.cwd).length > 1) {
    extra.hint = `项目根下有多个拼图项目，本次用的是最新的「${where.project}」。要改别的项目请显式给 project。`
  }
  return { project: where.project, projectRoot: resolved.cwd, extra }
}

/* --------------------------------- 工具 --------------------------------- */

const TOOL_DESCRIPTION = [
  '拼图模式：把项目拆成主文档 + 模块文档，用提问把不确定项变成已定项。',
  'op=list 列出现有项目（多项目时先看这个）；op=read 读状态（不建文件）；op=show 读某个模块文档的详情；op=init 一次创建主文档与每个模块一份文档；op=main 更新主文档六节之一；op=module 更新（必要时创建）模块文档；op=mode 切换执行模式。',
  '不给 project 时默认用项目根下最新的项目（返回里的 projectSource 会说明是 explicit/latest/default）——多项目并存时必须显式给 project。',
  `每次调用返回都带 askPause:true——**每一次提问的最后都要问「${PAUSE_QUESTION}」，两个选项：${PAUSE_OPTIONS.join(' / ')}**；用户选第一项时只回写文档并结束本轮，不执行任何动作。`,
  `当前模式见返回的 mode/canExecute：${MODE_PUZZLE_ONLY} 只提问与更新文档（越权工具会被 deny）；${MODE_PUZZLE_WRITE} 可执行且小改动问一次、大改动问一次。`,
].join('\n')

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
        description: 'list 列项目 / read 读状态 / show 读模块详情 / init 新建项目 / main 主文档小节 / module 模块文档小节 / mode 切换模式',
        enum: OPS,
      },
      project: { type: 'string', description: '项目名；省略时用项目根下最新的拼图项目（多项目时必须显式给）' },
      goal: { type: 'string', description: 'init：这个项目要达成什么（一句话）' },
      modules: {
        type: 'array',
        description: 'init：要同时创建的模块名列表（每个模块一份文档）',
        items: { type: 'string' },
      },
      section: { type: 'string', description: 'main：index/pit/quote/pending/decided/revoked；module：progress/points/related/detail' },
      name: { type: 'string', description: 'module / show：模块名（module 时不存在则创建）' },
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

      if (args.op === 'read') {
        return summarize(readState(projectRoot, project), resolved.extra)
      }

      if (args.op === 'show') {
        if (typeof args.name !== 'string' || args.name === '') return failure('缺少 name', '给出模块名，例如 auth-flow')
        const detail = readModuleDetail(projectRoot, project, args.name)
        if (detail.ok !== true) return failure(detail.error, '检查项目名与模块名')
        return { ...detail, ...resolved.extra, askPause: true, pauseQuestion: PAUSE_QUESTION, pauseOptions: PAUSE_OPTIONS }
      }

      if (args.op === 'init') {
        const created = createProject(projectRoot, project, args.goal ?? '', args.modules ?? [], DEFAULT_MODE)
        if (created.ok !== true) return failure(created.error, created.hint)
        return summarize(readState(projectRoot, created.project), {
          ...resolved.extra,
          created: true,
          mainCreated: created.mainCreated,
          createdModules: created.created,
          existingModules: created.existing,
          next: '现在开始一轮提问（≤3 问），并在最后问一次要不要先停下',
        })
      }

      if (args.op === 'main') {
        if (typeof args.section !== 'string' || args.section === '') return failure('缺少 section', '可用：index / pit / quote / pending / decided / revoked')
        const result = updateMainSection(projectRoot, project, args.section, args.content ?? '', append)
        if (result.ok !== true) return failure(result.error, result.hint)
        return summarize(readState(projectRoot, project), { ...resolved.extra, section: args.section })
      }

      if (args.op === 'module') {
        if (typeof args.name !== 'string' || args.name === '') return failure('缺少 name', '给出模块名，例如 auth-flow')
        if (typeof args.section !== 'string' || args.section === '') return failure('缺少 section', '可用：progress / points / related / detail')
        const result = updateModuleSection(projectRoot, project, args.name, args.section, args.content ?? '', append)
        if (result.ok !== true) return failure(result.error, result.hint)
        return summarize(readState(projectRoot, project), { ...resolved.extra, module: args.name, section: args.section, created: result.created })
      }

      if (args.op === 'mode') {
        if (typeof args.mode !== 'string' || !MODES.includes(args.mode)) return failure(`未知模式 ${String(args.mode)}`, `可用：${MODES.join(' / ')}`)
        const result = setMode(projectRoot, project, args.mode)
        if (result.ok !== true) return failure(result.error, result.hint)
        return summarize(readState(projectRoot, project), { ...resolved.extra, modeChanged: args.mode })
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
      const agent = exec.agent
      const sessionId = agent !== undefined && agent !== null && typeof agent.id === 'string' ? agent.id : ''
      if (sessionId === '') return decision

      const resolved = sessionCwd(ctx, sessionId)
      const existing = listProjects(resolved.cwd)
      if (existing.length === 0) return decision
      const state = readState(resolved.cwd, existing[0].name)
      if (state.initialized !== true || isExecutableMode(state.mode)) return decision

      return { kind: 'deny', reason: denyReason(toolName) }
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
        // 面板可以显式指定项目；不给就用默认（最新的那个）。
        const requested = typeof body.project === 'string' ? body.project : undefined
        const resolved = located(ctx, sessionId, requested)
        const projectRoot = resolved.projectRoot
        const project = resolved.project

        if (body.method === 'state') {
          respond(res, 200, { ok: true, result: summarize(readState(projectRoot, project), resolved.extra) })
          return
        }
        if (body.method === 'list') {
          respond(res, 200, { ok: true, result: summarizeList(projectRoot, projectSummaries(projectRoot)) })
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
          respond(res, 200, { ok: true, result: summarize(readState(projectRoot, project), resolved.extra) })
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

export { policyText, summarize, denyReason }
