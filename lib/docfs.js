/**
 * 拼图目录的路径守卫与原子写。**任何**写盘都必须经过这里，路径不许绕过 puzzleDirOf。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 */
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { PUZZLE_DIR } from './constants.js'
import { slugify } from './util.js'


/* --------------------------------- 路径与落盘 --------------------------------- */

/** 把相对路径拼到 root 下，并确认结果没有逃出 root。 */
export function safeJoin(root, ...parts) {
  const target = resolve(root, ...parts)
  const base = resolve(root)
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}

/**
 * **拼图项目文件夹**：`<数据工作区>/<项目名>`。不在工作区内则返回 null。
 *
 * 这是「一个拼图项目的家」的**唯一定义**——`拼图/` 文档目录与 `派单/` 看板都在它里面，
 * 而 v2.4.2 起它还是**执行工作区的默认值**（`codeRootOf` 的兜底）。
 *
 * ## 为什么必须收成一个函数
 *
 * 三处要用同一个概念：`puzzleDirOf`（文档在哪）、`source.js`（默认源码根 = 拼图目录的上一级）、
 * `dispatchrun.js`（派单会话的 cwd 默认值）。三处各写一遍路径拼法，迟早有一处漂移，
 * 而漂移的表现是「文档写在 A、AI 却在 B 里改代码」——不报错，只是慢慢做错。
 */
export function projectFolderOf(projectRoot, projectName) {
  if (typeof projectRoot !== 'string' || projectRoot === '') return null
  const slug = slugify(projectName)
  if (slug === null) return null
  return safeJoin(projectRoot, slug)
}

/** 解析项目根下的 拼图/ 目录；不在项目根内则返回 null。 */
export function puzzleDirOf(projectRoot, projectName) {
  const folder = projectFolderOf(projectRoot, projectName)
  return folder === null ? null : join(folder, PUZZLE_DIR)
}

/**
 * 目标路径是不是「拼图文档」（`.../拼图/...`）。
 *
 * 用于**文档锁**：`write` / `edit` / `str_replace_editor` 只要落在这里就被拒，
 * 任何模式都一样——拼图文档只能走 `puzzle_mode`（它带 slug 过滤与路径守卫）。
 * 判断只看路径段，不要求文件已存在（新建也算），所以按 `/拼图/` 或结尾 `拼图` 认。
 */
export function isPuzzleDocPath(target) {
  if (typeof target !== 'string' || target.trim() === '') return false
  const normalized = target.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized === PUZZLE_DIR || normalized.endsWith('/' + PUZZLE_DIR) || normalized.includes('/' + PUZZLE_DIR + '/')
}

/** 会**改动**文档的工具及其路径参数名；`str_replace_editor` 的 `view` 是只读，不在列。 */
export const DOC_MUTATING_TOOLS = {
  write: { pathField: 'file_path' },
  edit: { pathField: 'file_path' },
  str_replace_editor: { pathField: 'path', mutatingCommands: ['create', 'str_replace', 'insert'] },
}

/**
 * 从一次工具调用里取出「它要改的文件路径」；不是会改文档的调用就返回 null。
 *
 * 纯函数、不抛错：拿不到 arguments 或字段就当作与文档锁无关（放行）。
 */
export function docMutationTarget(toolName, args) {
  const spec = DOC_MUTATING_TOOLS[toolName]
  if (spec === undefined) return null
  const input = args !== null && typeof args === 'object' ? args : {}
  if (Array.isArray(spec.mutatingCommands)) {
    const command = typeof input.command === 'string' ? input.command : ''
    if (!spec.mutatingCommands.includes(command)) return null
  }
  const value = input[spec.pathField]
  return typeof value === 'string' && value !== '' ? value : null
}

/** 扫出项目根下所有已有拼图项目（按修改时间倒序）。 */


/**
 * 原子写：先写同目录临时文件再 rename，避免读到半截文档。
 *
 * **写完必须失效缓存**：`readTextCached` 认的是 `mtimeMs + size`，而 rename 换的是目录项——
 * 在部分文件系统（以及同一毫秒内）指纹可能没变，同进程紧接着读就会拿到**旧内容**。
 * 实测踩点：写完主文档立刻 `readState` 会读回旧值（写后回执里的数字对不上）。
 * 失效放这里而不是每个调用点，是因为**所有**写盘都收口在本函数（全仓仅此一处 writeFileSync）。
 */
export function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
  invalidateTextCache(file)
}


export function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (_error) {
    return null
  }
}

/**
 * 带缓存的文件读：**用 `mtimeMs + size` 当指纹**，指纹没变就复用上次的内容。
 *
 * 为什么必须要有它（实测数字，2026-10-02）：`tools/pre-execute` 挂在**每一次工具调用**上，
 * 而它一路走到 `readState` —— 那会把工作区里 9 份主文档 + 全部模块文档同步读一遍。
 * 单次工具调用的阻塞实测 **86–127ms**，一个 20 次调用的回合 ≈ **2.4 秒**纯等待，
 * 用户反馈的「装了插件变慢」就是这笔。而这条链**只为回答一个问题**：项目是不是「只拼不写」。
 * 健康性 / 条目合规 / 引用源码全算了，然后全部丢掉。
 *
 * 指纹选 `mtimeMs + size` 而不是只 `mtime`：`mtime` 的粒度在部分文件系统上只有秒级，
 * 同一秒内的两次写入会被误判成「没变」。加上 `size` 能挡掉绝大多数同秒改写；
 * 两者都没变却改了内容（同秒且等长）属于理论窗口，本插件的写入是 `atomicWrite`（rename），
 * 会换 inode 与 mtime，实际不会命中。
 *
 * 缓存**无上限**：key 是工作区里的文档路径，数量级就是「项目数 × 模块数」，
 * 几十到几百条字符串，不构成内存问题。文件消失时顺手删掉条目。
 */
const textCache = new Map()

export function readTextCached(file) {
  let stat = null
  try {
    stat = statSync(file)
  } catch (_error) {
    textCache.delete(file)
    return null
  }
  const fingerprint = `${stat.mtimeMs}:${stat.size}`
  const hit = textCache.get(file)
  if (hit !== undefined && hit.fingerprint === fingerprint) return hit.text
  const text = readText(file)
  if (text === null) {
    textCache.delete(file)
    return null
  }
  textCache.set(file, { fingerprint, text })
  return text
}

/**
 * 丢掉缓存。**写入后必须调**，否则同进程内会读到旧内容。
 *
 * 为什么不做成「写入自动失效」：写盘收口在 `atomicWrite`，但那边只拿到路径、
 * 拿不到「这次写的是哪份文档」的语义；而在写操作结束时统一清空最省心——
 * 写入本来就是低频动作（一轮几次），清空的代价远小于漏失效的代价。
 * 空参数表示全清；给路径只清那一条。
 */
export function invalidateTextCache(file) {
  if (typeof file === 'string' && file !== '') textCache.delete(file)
  else textCache.clear()
}

/* --------------------------------- 计数 --------------------------------- */

/**
 * 模板自带的说明性占位行——**只认这几种固定说法**。
 *
 * 早先的实现把「整行就是一对括号」一律当占位，于是用户写的
 * 「（见模块 auth-flow）」这类真内容会被误判为空、少算条数。
 */
