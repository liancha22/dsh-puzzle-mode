/**
 * 无依赖的小工具：文件枚举、百分比夹取、均值、slug、时间戳、finding 构造，
 * 以及 `makeContextMessage`（造一条注入用的 user 上下文消息）。
 *
 * 本文件由 lib/puzzle.js 拆分而来（v0.11.0）：只搬运，未改逻辑。
 * `makeContextMessage` 原先在首轮自动判定模块里，随首轮功能一起删除时**单独搬到这里**
 * （v2.2.0）：它被保留的「派单边界提醒」钩子使用，不是首轮功能的一部分。
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'


/* ---------------------------------- 小工具 ---------------------------------- */

export function listFiles(dir) {
  try {
    return readdirSync(dir)
  } catch (_error) {
    return []
  }
}


export function isFile(file) {
  try {
    return statSync(file).isFile()
  } catch (_error) {
    return false
  }
}


export function isDir(dir) {
  try {
    return statSync(dir).isDirectory()
  } catch (_error) {
    return false
  }
}

/**
 * 目录名是不是**不该当项目看**的。
 *
 * 为什么要有这张名单（v0.21.0 加，用户需求「自动判断此会话是否有多个项目」）：
 * 扫描是拿工作区顶层目录当候选，而顶层一定混着这些东西——依赖目录、缓存、
 * 构建产物、版本控制、隐藏目录。把它们列给用户勾选，等于让他在噪音里找信号。
 *
 * 判据刻意**保守**（只挡明确的非项目目录），认不出来的照列——因为漏掉一个真项目
 * 比多列一个噪音更糟：漏了就建不出文档，多了只是不勾它。
 */
const NOT_A_PROJECT = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'coverage',
  '.git', '.github', '.cache', '.vscode', '.idea', '.next', '.nuxt', '.venv',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.dsh', '.claude',
])

export function isSkippableDirName(name) {
  if (typeof name !== 'string' || name === '') return true
  // 隐藏目录（以 `.` 开头）一律跳过——用户不会把项目放在隐藏目录里。
  if (name.startsWith('.')) return true
  return NOT_A_PROJECT.has(name)
}


export function clampPercent(value) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}


export function average(values) {
  if (!Array.isArray(values) || values.length === 0) return 0
  return clampPercent(values.reduce((sum, value) => sum + value, 0) / values.length)
}

/** 解析一个安全 slug；返回 null 表示这个名字不能用。 */
export function slugify(raw) {
  if (typeof raw !== 'string') return null
  const cleaned = raw
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[\\/:*?"<>|#%&{}$!'@`+=~^[\];,]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 64)
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return null
  return cleaned
}

/** 今天的日期前缀，形如 2026-09-19。 */
export function defaultProjectName(text, now = new Date()) {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
  const word = slugify(typeof text === 'string' ? text.replace(/[\s，。,.、:：;；!！?？]/g, '/').trim().slice(0, 12) : '')
  const tail = word === null || word === '' ? '项目' : word.split('-').filter(Boolean).slice(0, 2).join('-')
  return `${stamp}-${tail}`
}


export function timestamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return [
    now.getFullYear(), '-', pad(now.getMonth() + 1), '-', pad(now.getDate()),
    ' ', pad(now.getHours()), ':', pad(now.getMinutes()), ':', pad(now.getSeconds()),
  ].join('')
}

/* ------------------------------- front-matter ------------------------------- */

/**
 * 写一段 front-matter。
 *
 * 主文档：`项目 / 模式 / 计划模块 / 会话`；模块文档：`项目 / 模块`。
 * 「模式」是项目级设置，模块文档不带它（早先模板误抄了 `模式:`，已去掉）。
 * 模块列表走 JSON，避免与 `、` 之类的分隔符冲突；`会话` 同理，是 JSON 字符串数组，
 * **只在非空时才写这一行**——老文档没绑定时保持原样，不凭空多出一行。
 */


export function finding(id, level, dimension, scope, fact, fix) {
  return { id, level, dimension, scope, fact, fix }
}

/**
 * 把当前状态过一遍，输出**客观发现清单**。只陈述事实，不做评价。
 *
 * 不抛错：状态缺字段一律按 0 处理（未初始化的项目也会走到这里）。
 */

/* ------------------------------- 注入用上下文 ------------------------------- */

/**
 * 造一条 user 上下文消息。
 *
 * 为什么**不**直接 import `@deepseek-ai/dsh-llm` 的 `createUserMessage`：
 * 那个包**不在本插件的 peerDependencies 里**（本插件只 peer `dsh-tools`），
 * 静态 import 会让「宿主没装 dsh-llm」变成一个**加载期硬失败**——整个插件都起不来。
 * 注入提醒是锦上添花的功能，**绝不能**因为它把插件拖垮。
 *
 * 这里按 `dsh-llm` 的 `createMessage` 形状自己造（`{id, role, content, source}`，
 * 冻结防改），实测与 `createUserMessage` 产物同形。真装了 dsh-llm 时产物也一致——
 * 那个函数本身也只是 `createMessage({...input, role:'user'})` 的一层薄包装。
 */
export function makeContextMessage(text, sourceKind = 'puzzle-context') {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: String(text ?? '') })]),
    source: Object.freeze({ kind: sourceKind }),
  })
}
