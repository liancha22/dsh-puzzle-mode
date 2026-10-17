/**
 * 工具入参的统一解析：**一次收口，四处受益**。
 *
 * 原先有四处把 `exec.arguments` **当对象**读（现存的一处是 `docMutationTarget`，
 * 另外三处随对应模块删除）。而真实形状是**字符串**——2026-10-08 会话日志核对：
 * `tool/call` 共 248 条，arguments 是字符串 **248 条**、对象 **0 条**。
 *
 * 后果不是报错，是**静默失效**（`typeof 'xxx' === 'object'` 为假 → 一律当空对象）：
 *   - 「只拼不写拦截」认不出任何真实调用（**那条防线一直没生效**）；
 *   - 「熔断」的签名恒为空串（无参调用不计入连击）；
 *   - 「催促」的分段读判定永远拿不到 `file_path`。
 *
 * 这四处当时都有测试、都全绿——因为**测试用的是对象**（照着类型想象写的）。
 * 教训：测试夹具的形状必须从真实运行时抄，不能凭类型想象。
 *
 * ## 为什么「两边都认」
 *
 * 认字符串与实测一致；同时认对象是为了**防漂移**：宿主若改成传对象，只认字符串会让
 * 上面四处**再次静默失效**，同样不报错。代价只是一次 `typeof`。
 */
import { isPuzzleDocPath } from './docfs.js'

/**
 * 把 `exec.arguments` 归一成对象。**从不抛错**：解析不出来就返回空对象。
 *
 * 返回空对象而不是 `null`：调用方全都写成 `input.xxx` 的形式，
 * 给空对象能让它们少一层判空（`null.file_path` 会抛错）。
 */
export function toolArgs(raw) {
  if (raw === null || raw === undefined) return {}
  // 形状一：已经是对象（宿主将来可能改成这个）。
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw
  // 形状二：JSON 字符串（**当前真实形状**）。
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text === '') return {}
    try {
      const parsed = JSON.parse(text)
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (_error) {
      // 解析不了就安静放行：读不懂参数绝不能让工具结果变错。
      return {}
    }
  }
  return {}
}

/** 取一个字符串字段；缺 / 非字符串 / 空串一律返回空串。 */
export function stringField(raw, key) {
  const value = toolArgs(raw)[key]
  return typeof value === 'string' && value !== '' ? value : ''
}

/**
 * 这次调用是否在动**拼图文档**（「只拼不写」拦截用）。
 *
 * 与 `docMutationTarget` 的分工：那个函数收「已解析的对象」，本函数收**原始入参**
 * （字符串或对象都行）。拦截路径上拿到的永远是原始值，所以这一层必须存在。
 */
export function docTargetOf(toolName, raw) {
  const input = toolArgs(raw)
  const path = stringField(input, 'file_path')
  if (path === '') return ''
  // 只有写类工具才看；读文档是允许的（那是「只拼」的一部分）。
  if (toolName !== 'write' && toolName !== 'edit') return ''
  return isPuzzleDocPath(path) ? path : ''
}
