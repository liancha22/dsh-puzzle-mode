/**
 * 派单会话的**专属轻量工具**（T1–T4）。
 *
 * 派单会话原先拿宿主原版工具（`read`/`write`/`edit`/`glob`/`grep`/`bash`），那套 schema
 * 字段多、描述长，而派单会话的活很窄（读方案、改代码、跑验证），每轮都要为它付 token。
 * 做法是**换一套**：六个 `pz_*` 注册进这个 agent 自己的层，再用 `tools.restrict({ deny })`
 * 把原版从它继承的那一层遮掉。
 *
 * ## restrict 只收继承层（已核实）
 *
 * `dsh-tools` 的 `view(scope)` 里 `restrictableNames` **只收 global + 祖先层**，
 * 本层自己注册的不进这个集合。两条推论正好是我们要的：
 *   - ✅ 要遮的原版在祖先层 → 写进 `deny` 即「对该 agent 隐藏全局工具」；
 *   - ✅ `pz_*` 在本层 → 不会被自己的 restrict 筛掉，**也不能写进 deny**
 *     （写进去会被当场拒绝：名字不在 `restrictableNames` 里）。
 *
 * ## 三条硬约束（宿主实现里读出来的）
 *
 * 1. **空参数会抛**：`restrict({})` 抛 `is a no-op`。所以 `deny` 为空时**跳过调用**。
 * 2. **名字不在 `restrictableNames` 会抛**。⇒ `deny` 必须按**当前实际可见的工具**算，
 *    不能写死一串「我以为存在」的名字——换个没装某工具的部署就当场炸。
 * 3. **返回 effect disposer**（`label` 是 `tools.restrict()`），回滚时要用。
 *
 * ## 红线
 *
 * - **只作用于派单会话**。普通会话一律用原版，不许影响 KV 缓存。
 * - 工具体**必须走 `ctx.fs`，不许 `node:fs`**：插件自身直连 `node:fs`，专属工具若也直连，
 *   「越界被沙箱拒绝」那条判据会直接失效——连写入边界一起消失。
 * - **注册与禁原版必须成对**：只注册不禁 = 白做，而且两套 schema 都在付 token，比不装更糟。
 *   所以「禁原版失败」要**整体回退**（把已注册的 dispose 掉）。
 * - 装不上要**降级并如实回报**，不许抛错、不许因此不派单。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

/** 专属工具名。**新名字，不与全局重名**（重名会互相遮蔽，排查起来很痛）。 */
export const SCOPED_TOOL_NAMES = ['pz_read', 'pz_write', 'pz_edit', 'pz_glob', 'pz_grep', 'pz_bash']

/**
 * 要隐藏的宿主原版名——**只是候选**。
 *
 * 真正写进 `deny` 的必须按**当前实际可见**的工具算（见 `visibleOriginalsOf`）：
 * 写死的话，换个没装 `bash` 的部署就会在 `restrict` 那里抛错，而那时
 * 六个 `pz_*` 已经注册完了——留下「两套并存」这个比不装更糟的状态。
 */
export const ORIGINAL_TOOL_NAMES = ['read', 'write', 'edit', 'glob', 'grep', 'bash']

/** 一次 `pz_read` 最多给多少行。超了截断并明说——不给上限会让一次读把上下文打满。 */
export const PZ_READ_MAX_LINES = 400

/** 一条命中行最大长度（代码行可能很长）。 */
export const PZ_LINE_MAX = 200

/** `pz_grep` 最多返回多少条命中。 */
export const PZ_GREP_MAX_HITS = 60

/** `pz_glob` 最多返回多少条路径。 */
export const PZ_GLOB_MAX_HITS = 200

/**
 * 从 tools 服务里算出**当前真的可见**的原版工具名。
 *
 * 为什么逐个 `get(name, agent)` 而不是拿 `restrictableNames` 一把梭：
 * `restrictableNames` 是「可被限制的全部名字」（几十个），我们只想遮文件与命令那一组；
 * 而逐个问「这个 agent 现在能不能看见 `read`」正好是我们要的判据。
 *
 * `get` 拿不到（旧版本 / 假对象）时返回空数组，调用方据此跳过 restrict——
 * **宁可不禁，也不要拿一个猜的清单去抛错**。
 */
export function visibleOriginalsOf(tools, agent) {
  if (tools === null || tools === undefined || typeof tools.get !== 'function') return []
  const found = []
  for (const name of ORIGINAL_TOOL_NAMES) {
    try {
      if (tools.get(name, agent) !== undefined) found.push(name)
    } catch (_error) {
      // 问不动就当它不在——这一条不该让整件事失败。
    }
  }
  return found
}

/* ------------------------------ 越界判定（T4） ------------------------------ */

/**
 * 从一次 `pz_*` 调用的参数里取**它要碰的路径**（纯函数）。
 *
 * 放这里而不是放进六个工具体内部：判定要取路径，就得让 schema 跟着走，
 * 而 schema 压到最小是这一版的目的——**放工具内部等于用 token 买判定**。
 */
export function pathOfScopedCall(toolName, args) {
  if (!SCOPED_TOOL_NAMES.includes(toolName)) return ''
  const input = args !== null && args !== undefined && typeof args === 'object' ? args : {}
  /**
   * ⚠️ **两套名字都要认**（v2.4.16）。参数名从单字母改成语义化之后，
   * 老会话的日志里可能还留着按旧名记的调用；这里读的是**已经解析过的入参**，
   * 所以兼容两种写法只花一个 `??`，却能让历史回放与边界提醒都不丢路径。
   */
  const pathArg = typeof input.file_path === 'string' && input.file_path !== ''
    ? input.file_path
    : (typeof input.path === 'string' && input.path !== '' ? input.path : input.p)
  return typeof pathArg === 'string' && pathArg.trim() !== '' ? pathArg.trim() : ''
}

/**
 * 这次调用是不是**落在这个会话的工作目录之外**（纯函数）。
 *
 * 判定用「解析后的绝对路径是否在 cwd 之下」，不是字符串前缀——前缀判定会把
 * `D:\work2` 误判成在 `D:\work` 里（多一个字符就穿过边界）。
 *
 * 判不出来（空路径 / 空 cwd / 相对路径）一律返回 false：**只提醒，不误报**。
 * 相对路径按 cwd 解释，所以它在里面。
 */
export function outsideWorkspaceOf(requested, cwd) {
  const raw = typeof requested === 'string' ? requested.trim() : ''
  const root = typeof cwd === 'string' ? cwd.trim() : ''
  if (raw === '' || root === '') return false
  const normalized = raw.replace(/\\/g, '/')
  // 相对路径按 cwd 解释 → 在里面（`../` 那种由沙箱去拒，不在这里猜）。
  if (!/^[a-zA-Z]:\//.test(normalized) && !normalized.startsWith('/')) return false
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const target = normalized.replace(/\/+$/, '')
  if (target === base) return false
  return !target.startsWith(base + '/')
}

/** 越界提醒的文案（一处生成，六处共用）。 */
export function outsideNotice(path, cwd) {
  return '【拼图模式 · 派单边界】这次动的是工作目录之外的路径：' + String(path)
    + '（本会话的工作目录是 ' + String(cwd) + '）。'
    + '如果这是有意的（例如用户明确让你改另一个项目），继续即可；'
    + '如果不是，改回工作目录里的路径。**写操作还会被沙箱再拦一道**——那不是插件拦的。'
}

/* ------------------------------ 六个工具体 ------------------------------ */

/** 统一把 `ctx.fs` 的失败翻成人话——`FsError` 的 code 是稳定的，消息不是。 */
function fsFailure(error, what) {
  const code = error !== null && error !== undefined && typeof error.code === 'string' ? error.code : ''
  const raw = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
  if (code === 'FS_NOT_FOUND') return { ok: false, error: what + '：文件不存在', hint: '先用 pz_glob 看目录里有什么。' }
  if (code === 'FS_SANDBOX_DENIED') return { ok: false, error: what + '：被沙箱拒绝', hint: '这个路径不在本会话允许写入的范围内（工作区与临时目录）。' }
  if (code === 'FS_STALE_VERSION') return { ok: false, error: what + '：文件在你读过之后变过', hint: '重新 pz_read 一次再改。' }
  if (code === 'FS_AMBIGUOUS_EDIT') return { ok: false, error: what + '：old 在文件里不是唯一匹配', hint: '把 old 写长一点，让它唯一。' }
  return { ok: false, error: what + '：' + raw }
}

/**
 * 在**任意** ctx 上按**可选口径**取一个服务；拿不到就 `undefined`。
 *
 * ## 为什么不能写 `ctx.fs`（v2.4.14，真机 bug）
 *
 * `ctx.fs` 是 Cordis 服务代理的**硬取**语法：服务不在该作用域的 inject 链上时，
 * 它**当场抛** `cannot get property "fs" without inject`。而这里要的语义是
 * 「拿不到就降级」——硬取语法从根上表达不了它。
 *
 * `fs` 服务的契约里写着两条路（`Service` 检查器原话）：
 *   - `ctx.get("fs")` —— **optional**，要求调用方自己判 `undefined`；
 *   - `inject: ['fs']` + `ctx.fs` —— **hardDependency**。
 *
 * 本文件的 `if (fs === null || fs === undefined) return {...降级...}` 就是为前者
 * 写的——**写法用错了**，于是「拿不到就降级」变成了「拿不到就把整个 task 打成 500」。
 *
 * ⚠️ 这条尤其要紧：`installScopedTools` 是在 `runDispatch` 里调的，它一抛，
 * 整个 `task action:'dispatch'` 就 500——用户看到的是「派单按钮报错」，
 * 而真正的原因（这个会话取不到 fs）一个字都没露出来。
 *
 * 内建代码在 agent 作用域上取服务也是这个口径：`agent.ctx.get('sandboxPolicy')`。
 */
function serviceOf(ctx, name) {
  if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return undefined
  const value = ctx.get(name)
  return value === null || value === undefined ? undefined : value
}

/**
 * 工具体的依赖：`fs`（必需）、`cwd`（取相对路径）、`signal`、`shell`（只服务 `pz_bash`）、
 * `sandboxPolicy` + `session`（算沙箱策略，见下）。
 *
 * `ctx.fs` 拿不到时**六个工具都注册失败**——这是对的：没有 `ctx.fs` 就没有
 * 沙箱边界，而那正是这一版要的东西。用 `node:fs` 兜底会让红线失效。
 *
 * ## 沙箱策略为什么必须显式传（v2.4.15，真机 bug）
 *
 * 真机现象：派单会话里 `pz_write` / `pz_edit` 一律被沙箱拒绝。
 *
 * 根因：`fs.writeText(target, content, expected?, signal?, sandboxPolicy?)` 的第 5 个
 * 参数就是**这次调用跑在哪个模式、哪个工作区根**（`SandboxExecutionPolicy`
 * = `{ mode, workspaceRoot, sessionId? }`）。契约原文：
 * 「a sandboxing backend fences the write by it, the bare backend ignores it.
 * **Omit to leave the backend its own default**」——不传就是让沙箱后端用它自己的
 * 默认（fail-safe 的 `read-only`），于是「这个会话明明能写工作区」变成了「写被拒」。
 *
 * 策略的来源只有一处（`sandboxPolicy` 服务契约）：`resolve(request?)` 返回
 * 「本次调用完整的 mode + 绝对 workspaceRoot」，「an approved explicit mode outranks
 * the session's last `sandbox/mode` event, which outranks the deployment default.
 * **A session cwd is its workspace-write boundary**」。
 *
 * ## 为什么是**每次调用现算**，不是装工具时算一次
 *
 * 契约明说「The service **reads session state once at each operation boundary**」，
 * 而会话的 mode 是可以在装完工具之后被改的（`sandbox/mode` 事件、升级批准）。
 * 装的时候冻结一个 policy，等于把「用户后来放宽了沙箱」这件事吃掉。
 * 宿主自己的 PTC 通道就是这么写的（`dsh-tools/lib/index.js:2784`）：
 * `ctx.get("sandboxPolicy").resolve({ session: exec.agent.session })`。
 *
 * ## 拿不到策略时**降级不抛**
 *
 * 与 `serviceOf` 同一条口径：写类工具如实回报「拿不到沙箱策略，写不了」，
 * 而不是让整个 task 500。**读类工具不受影响**（`readText`/`listDir`/`stat`
 * 的契约里根本没有 policy 参数）。
 */
function makeTools(deps) {
  const fs = deps.fs
  const cwd = typeof deps.cwd === 'string' ? deps.cwd : ''
  const signal = deps.signal

  /**
   * 现算本次调用的沙箱策略；服务缺失、不是契约形状、或 `resolve()` 自己抛
   * （会话日志已随会话释放等）时一律返回 `undefined` —— 与 `visibleOriginalsOf`
   * 逐条吞错同一条口径：**取不到策略是降级，不是失败**。
   *
   * 不传 `mode`：本调用方**没有**「已批准的显式模式」可给（那是升级批准链的东西），
   * 硬塞一个等于越过会话的 `sandbox/mode` 事件去替用户做决定。
   */
  const policyOf = () => {
    const policy = deps.sandboxPolicy
    if (policy === null || policy === undefined || typeof policy.resolve !== 'function') return undefined
    const session = deps.session
    try {
      return policy.resolve(session === null || session === undefined ? {} : { session })
    } catch (_error) {
      return undefined
    }
  }

  /** 拿不到策略时写类工具的统一回报（如实说清，不给假成功）。 */
  const noPolicy = {
    ok: false,
    error: '拿不到沙箱策略，写不了',
    hint: '这个会话取不到 ctx.sandboxPolicy，写入边界（mode 与 workspaceRoot）无从确定，所以没有落笔。读类工具不受影响。',
  }
  const out = {
    schema: { type: 'json' },
    render(_args, value) {
      return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
    },
  }

  const pzRead = defineTool({
    name: 'pz_read',
    description: '读一个文本文件；可给 from/n 读一段。路径相对本会话工作目录。',
    parameters: {
      file_path: { type: 'string', required: true, description: '文件路径' },
      offset: { type: 'number', description: '起始行（从 1 开始），不给从头读' },
      limit: { type: 'number', description: '最多读几行' },
    },
    output: out,
    async execute(args) {
      try {
        const target = await fs.resolve(args.file_path, { cwd })
        const info = await fs.stat(target, signal)
        if (info === undefined) return { ok: false, error: '文件不存在：' + args.file_path, hint: '先用 pz_glob 看目录里有什么。' }
        const text = await fs.readText(target, signal)
        const lines = String(text).split('\n')
        const from = Number.isSafeInteger(args.offset) && args.offset > 0 ? args.offset : 1
        const want = Number.isSafeInteger(args.limit) && args.limit > 0 ? args.limit : PZ_READ_MAX_LINES
        const take = Math.min(want, PZ_READ_MAX_LINES)
        const slice = lines.slice(from - 1, from - 1 + take)
        const truncated = lines.length > from - 1 + take
        return {
          ok: true,
          path: args.file_path,
          totalLines: lines.length,
          from,
          lines: slice.map((line, at) => (from + at) + ': ' + (line.length > PZ_LINE_MAX ? line.slice(0, PZ_LINE_MAX) + '…' : line)),
          ...(truncated ? { truncated: true, note: `只给了 ${take} 行；要接着读给 from=${from + take}` } : {}),
        }
      } catch (error) {
        return fsFailure(error, '读文件失败')
      }
    },
  })

  const pzWrite = defineTool({
    name: 'pz_write',
    description: '整份写入一个文本文件（覆盖）。要改几处请用 pz_edit。',
    parameters: {
      file_path: { type: 'string', required: true, description: '文件路径' },
      content: { type: 'string', required: true, description: '完整的新内容' },
    },
    output: out,
    async execute(args) {
      const policy = policyOf()
      if (policy === undefined) return noPolicy
      try {
        const target = await fs.resolve(args.file_path, { cwd })
        // 第 5 个参数：本次写入的模式与工作区根。不传＝沙箱后端自己的默认（写被拒）。
        await fs.writeText(target, String(args.content), undefined, signal, policy)
        return { ok: true, path: args.file_path, bytes: String(args.content).length }
      } catch (error) {
        return fsFailure(error, '写文件失败')
      }
    },
  })

  const pzEdit = defineTool({
    name: 'pz_edit',
    description: '把文件里的 old 换成 new（要求 old 唯一）。改多处请重复调用。',
    parameters: {
      file_path: { type: 'string', required: true, description: '文件路径' },
      old_string: { type: 'string', required: true, description: '要被替换的原文' },
      new_string: { type: 'string', required: true, description: '替换成什么' },
    },
    output: out,
    async execute(args) {
      const policy = policyOf()
      if (policy === undefined) return noPolicy
      try {
        const target = await fs.resolve(args.file_path, { cwd })
        // 第 5 个参数：同 pz_write。`edit` 的 `replaceAll` 契约里是必填，缺省语义取 false。
        await fs.editText(target, { oldString: String(args.old_string), newString: String(args.new_string), replaceAll: false }, undefined, signal, policy)
        return { ok: true, path: args.file_path }
      } catch (error) {
        return fsFailure(error, '改文件失败')
      }
    },
  })

  const pzGlob = defineTool({
    name: 'pz_glob',
    description: '按文件名模式列文件（如 **/*.mjs）。',
    parameters: {
      pattern: { type: 'string', required: true, description: '文件名模式（如 **/*.mjs）' },
      path: { type: 'string', description: '从哪个目录开始，默认工作目录' },
    },
    output: out,
    async execute(args) {
      try {
        const target = await fs.resolve(typeof args.path === 'string' && args.path !== '' ? args.path : '.', { cwd })
        const entries = await fs.listDir(target, signal)
        const re = globToRegExp(String(args.pattern))
        const hits = []
        for (const entry of Array.isArray(entries) ? entries : []) {
          if (hits.length >= PZ_GLOB_MAX_HITS) break
          const name = typeof entry === 'string' ? entry : (entry !== null && entry !== undefined ? entry.name : '')
          if (typeof name !== 'string' || name === '') continue
          if (re.test(name)) hits.push(name)
        }
        return { ok: true, pattern: args.pattern, dir: typeof args.path === 'string' ? args.path : '.', entries: hits, count: hits.length }
      } catch (error) {
        return fsFailure(error, '列目录失败')
      }
    },
  })

  const pzGrep = defineTool({
    name: 'pz_grep',
    description: '在文件里搜一个字符串，返回「文件:行号: 那一行」。',
    parameters: {
      pattern: { type: 'string', required: true, description: '要找的字符串（不是正则）' },
      path: { type: 'string', description: '要搜的文件或目录，默认工作目录' },
    },
    output: out,
    async execute(args) {
      try {
        const needle = String(args.pattern)
        const start = typeof args.path === 'string' && args.path !== '' ? args.path : '.'
        const files = await collectUnder(fs, start, cwd, signal)
        const hits = []
        let truncated = false
        for (const one of files) {
          if (hits.length >= PZ_GREP_MAX_HITS) { truncated = true; break }
          let text
          try {
            text = await fs.readText(one.target, signal)
          } catch (_error) {
            continue
          }
          const lines = String(text).split('\n')
          for (let at = 0; at < lines.length; at += 1) {
            if (!lines[at].includes(needle)) continue
            if (hits.length >= PZ_GREP_MAX_HITS) { truncated = true; break }
            const body = lines[at].trim()
            hits.push(one.display + ':' + (at + 1) + ': ' + (body.length > PZ_LINE_MAX ? body.slice(0, PZ_LINE_MAX) + '…' : body))
          }
        }
        return { ok: true, pattern: needle, hits, count: hits.length, ...(truncated ? { truncated: true, note: '命中太多，只给了前 ' + PZ_GREP_MAX_HITS + ' 条' } : {}) }
      } catch (error) {
        return fsFailure(error, '搜索失败')
      }
    },
  })

  const pzBash = defineTool({
    name: 'pz_bash',
    description: '跑一条 shell 命令，返回输出与退出码。',
    parameters: {
      command: { type: 'string', required: true, description: '要跑的命令' },
    },
    output: out,
    async execute(args) {
      const shell = deps.shell
      if (shell === null || shell === undefined || typeof shell.execute !== 'function' || typeof shell.resolve !== 'function') {
        return { ok: false, error: '这台部署没有 shell 服务', hint: '跑不了命令；其余 pz_* 工具不受影响。' }
      }
      try {
        /**
         * `pz_bash` **也要**带上 policy，理由与写类工具同源，但机制不同：
         *
         * 沙箱执行器的 `resolve(request)` 是
         * `sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()`
         * （`dsh-bash-sandbox/lib/index.js`）——兜底那次 `resolve()` **不带 session**，
         * 于是拿到的是部署默认（fail-safe 的 `read-only`），而不是这个派单会话的
         * 工作区。结果就是「命令明明只在工作区里动，却被判越界」。
         *
         * 宿主自己的 `bash` 工具就是这么传的
         * （`dsh-tool-bash/lib/index.js:15764`：
         * `resolveSandboxPolicy = (exec) => sandboxPolicy?.resolve({ session: exec.agent.session })`），
         * 然后把结果放进 `request.sandboxPolicy`。
         *
         * 拿不到策略时**不传这个字段**——`??` 的兜底语义与改动前完全一致，
         * 不发明新的失败模式（不像写类工具，这里没有「边界未知」就必须拒绝的理由：
         * 执行器自己的兜底是 fail-closed 的）。
         */
        const policy = policyOf()
        const handle = await shell.execute(shell.resolve({
          command: String(args.command),
          ...(cwd !== '' ? { workdir: cwd } : {}),
          signal,
          ...(policy !== undefined ? { sandboxPolicy: policy } : {}),
        }))
        const result = await handle.result()
        return {
          ok: result !== null && result !== undefined && !result.aborted,
          command: args.command,
          output: result !== null && result !== undefined ? String(result.output ?? result.text ?? '') : '',
          exitCode: result !== null && result !== undefined && Number.isSafeInteger(result.exitCode) ? result.exitCode : null,
          ...(result !== null && result !== undefined && result.aborted === true ? { error: '命令被中止' } : {}),
        }
      } catch (error) {
        const raw = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
        return { ok: false, error: '跑命令失败：' + raw }
      }
    },
  })

  return { pzRead, pzWrite, pzEdit, pzGlob, pzGrep, pzBash }
}

/** 把 glob 模式翻成正则。只支持 `*` / `**` / `?`——够用，且不会引入依赖。 */
export function globToRegExp(pattern) {
  const raw = typeof pattern === 'string' ? pattern : ''
  let out = ''
  for (let at = 0; at < raw.length; at += 1) {
    const ch = raw[at]
    if (ch === '*') {
      if (raw[at + 1] === '*') { out += '.*'; at += 1 } else { out += '[^/]*' }
      continue
    }
    if (ch === '?') { out += '.'; continue }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + out + '$', 'i')
}

/** 递归列出一个目录下的文本文件（限深度与数量，避免把整棵依赖树读进来）。 */
async function collectUnder(fs, start, cwd, signal, maxDepth = 4, maxFiles = 400) {
  const out = []
  const walk = async (rel, depth) => {
    if (depth > maxDepth || out.length >= maxFiles) return
    let entries
    try {
      const target = await fs.resolve(rel, { cwd })
      entries = await fs.listDir(target, signal)
    } catch (_error) {
      return
    }
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (out.length >= maxFiles) return
      const name = typeof entry === 'string' ? entry : (entry !== null && entry !== undefined ? entry.name : '')
      if (typeof name !== 'string' || name === '') continue
      if (name === 'node_modules' || name === '.git' || name.startsWith('.')) continue
      const child = (rel === '.' || rel === '' ? '' : rel + '/') + name
      const isDir = entry !== null && entry !== undefined && typeof entry === 'object' && entry.type === 'directory'
      if (isDir) { await walk(child, depth + 1); continue }
      out.push({ target: await fs.resolve(child, { cwd }), display: child })
    }
  }
  await walk(typeof start === 'string' && start !== '' ? start : '.', 0)
  return out
}

/* ------------------------------ 安装与回滚 ------------------------------ */

/**
 * 给**一个派单会话**装上专属工具，并把原版遮掉。
 *
 * ## 顺序不能换
 *
 * 1. 拿 `agent.ctx.tools` —— 拿不到就如实失败（**不抛**）；
 * 2. 探**当前实际可见**的原版名（§2.1 硬约束 2）；
 * 3. 注册六个 `pz_*`（逐个 try，一个失败不放弃其余）；
 * 4. `restrict({ deny })` —— **失败就整体回退**（把第 3 步的 dispose 掉）。
 *
 * 第 4 步的回退是这一版最要紧的一条：只注册不禁 = 专属工具白做，
 * 而且两套 schema 都在付 token，**比不装更糟**。
 *
 * 第 2 步一个原版都没探到时**跳过 restrict**：`restrict({deny:[]})` 不是 no-op
 * （空 filter 会被当成「materialized-empty-config bug」），而且没有要遮的就没意义。
 */
export function installScopedTools(agent, deps) {
  const d = deps !== null && deps !== undefined ? deps : {}
  const ctx = agent !== null && agent !== undefined ? agent.ctx : undefined
  const tools = serviceOf(ctx, 'tools')
  if (tools === null || tools === undefined || typeof tools.register !== 'function') {
    return { ok: false, registered: [], denied: [], reason: '这个会话拿不到 agent 作用域的 tools' }
  }
  const fs = serviceOf(ctx, 'fs')
  if (fs === null || fs === undefined) {
    return { ok: false, registered: [], denied: [], reason: '这个会话拿不到 ctx.fs——没有它就没有沙箱边界，专属工具不做' }
  }

  const deny = visibleOriginalsOf(tools, agent)
  const disposers = []
  const registered = []
  const failed = []
  /**
   * `sandboxPolicy` 与 `session` 都按**可选**取：拿不到时写类工具如实回报
   * 「拿不到沙箱策略，写不了」，而不是让 `installScopedTools` 抛（那会把整个
   * `task action:'dispatch'` 打成 500，见本文件顶部 `serviceOf` 的说明）。
   *
   * `session` 走 `agent.session`：`SandboxPolicyRequest.session` 要的是
   * 「调用会话」，它的 **cwd 就是 workspace-write 边界**（契约原话）。
   * 不传 session 的话 `resolve()` 只能退回部署根，那等于把派单会话的
   * 工作目录丢掉——正是这次要修的 bug 的另一半。
   */
  const made = makeTools({
    fs,
    cwd: d.cwd,
    signal: d.signal,
    shell: serviceOf(ctx, 'shell'),
    sandboxPolicy: serviceOf(ctx, 'sandboxPolicy'),
    session: agent !== null && agent !== undefined ? agent.session : undefined,
  })

  for (const definition of [made.pzRead, made.pzWrite, made.pzEdit, made.pzGlob, made.pzGrep, made.pzBash]) {
    try {
      disposers.push(tools.register(definition))
      registered.push(definition.name)
    } catch (error) {
      const raw = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
      failed.push(definition.name + '：' + raw)
    }
  }

  /** 回滚：把已注册的撤掉。回滚本身失败也要吞掉——它不该盖住真正的原因。 */
  const rollback = () => {
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch (_error) { /* 回滚失败不改变结论 */ }
    }
  }

  if (deny.length === 0) {
    return {
      ok: true,
      registered,
      denied: [],
      failed,
      restrictSkipped: true,
      reason: '没探到任何原版文件/命令工具可遮（可能这台部署本来就没装），restrict 跳过',
    }
  }
  if (typeof tools.restrict !== 'function') {
    rollback()
    return { ok: false, registered: [], denied: [], failed, reason: '这个会话的 tools 没有 restrict，只注册不禁会让两套 schema 并存——已整体回退' }
  }
  try {
    tools.restrict({ deny })
  } catch (error) {
    const raw = error !== null && error !== undefined && error.message !== undefined ? String(error.message) : String(error)
    rollback()
    return {
      ok: false,
      registered: [],
      denied: [],
      failed,
      reason: '遮原版工具失败（' + raw + '）——只注册不禁比不装更糟，已整体回退',
    }
  }
  return { ok: true, registered, denied: deny, failed }
}
