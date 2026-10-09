/**
 * 往 `lib/puzzle.js` 这个 barrel 里插入几行 re-export。
 *
 *   node tools/add-barrel-exports.mjs
 *
 * 为什么写成脚本：要插入的字符串里含反引号、`'` 与 `{}`，在 PowerShell 里拼
 * 会被 shell 先吃掉一层引号（本轮已栽四次）。脚本 + 幂等检查是唯一稳的做法。
 *
 * **幂等**：已经存在的行不会重复插入。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const path = join(root, 'lib', 'puzzle.js')

/** 要确保存在的 re-export 行（按顺序插在 anchor 之前）。 */
const LINES = [
  "export { toolArgs, stringField, docTargetOf } from './toolargs.js'",
  "export { WRITE_TOOLS, STALE_CODES, STALE_AFTER_STEPS, DECISION_DENSE_THRESHOLD, FSGUARD_MAX_SESSIONS, countDecisions, errorCodeOf, isStaleCode, retryText, preWriteText, preEditText, denseDecisionText, ObservationLog, noteStepStart, noteReasoning, noteToolCall, fsGuardStatsOf, fsGuardLogOf, clearFsGuard, resetFsGuard } from './fsguard.js'",
  "export { INJECT_BUDGET_PER_TURN, INJECT_COOLDOWN_STEPS, INJECT_MAX_SESSIONS, INJECT_ALWAYS, INJECT_REASON_OK, INJECT_REASON_BUDGET, INJECT_REASON_COOLDOWN, noteProgress, requestInject, injectGateOf, clearInjectGate, resetInjectGate, injectSkipText } from './injectgate.js'",
]

const ANCHOR = "export { THEME_PACK_VERSION,"

let text = readFileSync(path, 'utf8')
if (!text.includes(ANCHOR)) {
  console.error('✗ barrel 里找不到锚点：' + ANCHOR)
  process.exit(1)
}

const missing = LINES.filter((line) => !text.includes(line))
if (missing.length === 0) {
  console.log('✓ 三行 re-export 都已在场（幂等）')
  process.exit(0)
}

text = text.replace(ANCHOR, missing.join('\n') + '\n' + ANCHOR)
writeFileSync(path, text)
console.log(`✓ 已插入 ${missing.length} 行 re-export`)
