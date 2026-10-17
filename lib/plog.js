/**
 * 插件自己的故障日志（v2.2.5）。
 *
 * ## 为什么要有它
 *
 * 在此之前插件**一条日志都没有**：全仓 33 个 `lib/*.js` 里零处 `ctx.logger`、
 * 零处 `console.*`，而 198 处 `catch` 绝大多数是 `catch (_error) {}` —— 失败
 * **被静默吞掉**。真机上出故障时，用户能看到的只有两种东西：面板上那句
 * `{ok:false,error,hint}`（只在 RPC 路径上），以及**什么都没有**（六个注入类
 * 钩子、`session/event` 观察、启动期装配，全在面板看不到的地方）。
 *
 * 后果就是本仓反复出现的那类排查：现象是「点了没用」「文档段没注入」，
 * 而日志里一个字都没有，只能回去逐行读源码猜。
 *
 * ## 为什么不直接用宿主的 `ctx.logger`
 *
 * 宿主确实有 `LoggerService`（`ctx.logger()` / `ctx.logger.exporter()`，
 * 实读 `@deepseek-ai/cordis` 的 `lib/types/logger.js`）。但它**没有文件输出端**：
 * 整个 `app.asar` 里只有 `dsh-app-boot` 注册过一个 exporter，而且是「只收
 * warn/error、只存在内存里、只在启动失败时拼进报错」的启动诊断。桌面档里
 * `ctx.logger` 的输出走进程 stdout，用户看不到，`~/.dsh` 下也没有日志目录。
 *
 * 所以只补 `ctx.logger` 解决不了第十五宗罪要解决的问题。落盘必须插件自己来。
 *
 * ## 落点与体积
 *
 * `$DSH_HOME/dsh-puzzle-mode.log`（与设置文件同一个目录，`settingsDir()` 的口径）。
 * 超过 `MAX_LOG_BYTES` 就**只留后半段**——日志是线索不是档案，撑大没有收益。
 * 只记失败与降级，**正常路径一行不写**（那正是「不在高频正常路径刷日志」）。
 *
 * ## 写失败为什么可以静默
 *
 * 这是全文件唯一一处允许的静默，理由是真实失败路径：盘满、目录只读、被占用。
 * 那时插件该做的事是照常干活，而不是因为记不下日志把自己也弄崩。
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { settingsDir } from './settings.js'

/** 日志文件名（放在 DSH_HOME 根下，与 `.dsh-puzzle-mode.json` 同目录）。 */
export const LOG_FILE = 'dsh-puzzle-mode.log'

/** 单个日志文件的上限：超了就砍掉前半段。 */
export const MAX_LOG_BYTES = 200 * 1024

/** 日志文件的绝对路径（面板与用户都按这个路径找）。 */
export function logPath() {
  return join(settingsDir(), LOG_FILE)
}

/**
 * 把 `Error` / 任意抛出物压成一行可读文本。
 *
 * 为什么带 `stack` 的第一行而不是整个 stack：这条日志要回答的是「哪一行抛的」，
 * 第一行就够；完整 stack 会把一行日志撑成几十行，反而不好扫。
 */
function describe(error) {
  if (error === null || error === undefined) return '（没有错误对象）'
  if (error instanceof Error) {
    const stack = typeof error.stack === 'string' ? error.stack.split('\n')[1] : ''
    const at = typeof stack === 'string' && stack.trim() !== '' ? ' @' + stack.trim() : ''
    return `${error.name}: ${error.message}${at}`
  }
  return typeof error === 'string' ? error : JSON.stringify(error)
}

/** 一行日志的正文：时间 / 级别 / 落点 / 做了什么 / 上下文 / 原始错误。 */
function formatLine(scope, detail, error, context) {
  const now = new Date()
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  const at = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`
  const parts = [at, '[error]', String(scope), '|', String(detail)]
  if (context !== undefined && context !== null && context !== '') parts.push('|', typeof context === 'string' ? context : JSON.stringify(context))
  parts.push('|', describe(error))
  return parts.join(' ') + '\n'
}

/** 超过上限就只留后半段（从行边界切，不留半行）。 */
function trimIfNeeded(file) {
  let size = 0
  try {
    size = statSync(file).size
  } catch (_error) {
    return
  }
  if (size <= MAX_LOG_BYTES) return
  const text = readFileSync(file, 'utf8')
  const cut = text.slice(Math.max(0, text.length - Math.floor(MAX_LOG_BYTES / 2)))
  const firstBreak = cut.indexOf('\n')
  writeFileSync(file, firstBreak < 0 ? cut : cut.slice(firstBreak + 1), 'utf8')
}

/**
 * 记一条失败。**这是本模块唯一的入口。**
 *
 * `scope` 说「哪个模块 / 哪条钩子」，`detail` 说「什么操作、哪个阶段」，
 * `error` 是原始抛出物（保留类型与消息），`context` 是最少定位信息
 * （会话 id / 项目名 / 卡片 id 这类，**不要**塞整份数据）。
 *
 * 例：`logFailure('钩子:首轮判定', '注入采访提示失败', error, { sessionId })`
 */
export function logFailure(scope, detail, error, context) {
  try {
    const dir = settingsDir()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, LOG_FILE)
    trimIfNeeded(file)
    appendFileSync(file, formatLine(scope, detail, error, context), 'utf8')
  } catch (_error) {
    /* 盘满 / 只读 / 被占用：记不下就算了，绝不能让日志把插件本身弄崩 */
  }
}
