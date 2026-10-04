/**
 * 固定收尾问的**全局开关**测试。
 *
 *   node test/80-ask-pause.test.mjs
 *
 * 背景（用户原话）：「提问到最后还要选继续还是停下？的功能加一个全局关闭功能。」
 *
 * 这个开关有一条**极易写错**的语义，所以单独立一个文件钉它：
 *   缺字段 = **开**（默认保持原有行为），只有显式 `false` 才是关。
 * 反过来（缺字段 = 关）会让所有老用户的提问突然不再收尾——那是静默的行为变更，
 * 比功能本身更严重。所以下面第一条用例就是钉这个默认值。
 *
 * 第二个重点是**两个开关不能互相盖掉**：设置文件是共享的
 * （`disabledSessions` 按会话 + `askPause` 全局），任何一侧写入时漏带另一侧，
 * 就会把对方整个抹掉。这正是本仓记过的「同名不同形的字段会互相盖掉」。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 每个用例都在自己的 DSH_HOME 里跑。
 *
 * 这一条**必须**有：开关存在 `$DSH_HOME/.dsh-puzzle-mode.json`，
 * 不隔离的话测试会去读**用户真实的设置**、也会把它改掉。
 */
const HOME = mkdtempSync(join(tmpdir(), 'puzzle-pause-'))
process.env.DSH_HOME = HOME

const {
  ASK_PAUSE_DEFAULT,
  PAUSE_QUESTION,
  PAUSE_OPTIONS,
  settingsPath,
  readSettings,
  isAskPauseEnabled,
  setAskPause,
  disableSession,
  enableSession,
  pauseFields,
} = await import('../lib/puzzle.js')

let passed = 0
let failed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log('ok   ' + name)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log('FAIL ' + name + ' —— ' + (error && error.message ? error.message : String(error)))
  }
}

/** 直接写一份设置文件（绕过写路径，用来构造「用户手改过」的场景）。 */
function writeRaw(value) {
  writeFileSync(settingsPath(), typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

/** 把设置文件删掉（回到「从没设置过」）。 */
function clearRaw() {
  rmSync(settingsPath(), { force: true })
}

/* ------------------------------ 默认值语义 ------------------------------ */

check('默认值是「开」：文件不存在时收尾问照旧要问', () => {
  clearRaw()
  assert.equal(ASK_PAUSE_DEFAULT, true, '常量本身就是 true')
  assert.equal(isAskPauseEnabled(), true, '没有设置文件 = 开着')
  const fields = pauseFields()
  assert.equal(fields.askPause, true)
  assert.equal(fields.pauseQuestion, PAUSE_QUESTION)
  assert.deepEqual(fields.pauseOptions, PAUSE_OPTIONS)
})

check('缺 askPause 字段 = 开（老用户的设置文件里没有这个字段）', () => {
  writeRaw({ disabledSessions: [] })
  assert.equal(isAskPauseEnabled(), true, '缺字段必须当「开」——否则老用户静默变了行为')
  assert.equal(readSettings().askPause, true)
})

check('坏值一律当「开」：字符串 "false" / 0 / null / 数组都不算「关」', () => {
  for (const bad of ['false', 0, null, [], {}, 'true']) {
    writeRaw({ askPause: bad })
    assert.equal(isAskPauseEnabled(), true, '只有**显式的布尔 false** 才算关，收到：' + JSON.stringify(bad))
  }
})

check('坏 JSON / 坏形状不抛错，退回「开 + 无禁用」', () => {
  writeRaw('{ this is not json')
  assert.equal(isAskPauseEnabled(), true)
  assert.deepEqual(readSettings().disabledSessions, [])
  writeRaw('[]')
  assert.equal(isAskPauseEnabled(), true)
  writeRaw('"just a string"')
  assert.equal(isAskPauseEnabled(), true)
})

/* ------------------------------ 开关本身 ------------------------------ */

check('关掉之后：pauseFields 回 false 且**不再带**收尾问文案', () => {
  clearRaw()
  const off = setAskPause(false)
  assert.equal(off.ok, true)
  assert.equal(off.askPause, false)
  assert.equal(off.changed, true, '第一次关要报告「变了」')
  assert.equal(isAskPauseEnabled(), false)

  const fields = pauseFields()
  assert.equal(fields.askPause, false)
  // 留着 pauseQuestion 比不带更糟：模型看到文案就会继续问。
  assert.equal(Object.hasOwn(fields, 'pauseQuestion'), false, '关掉后不该再下发收尾问文案')
  assert.equal(Object.hasOwn(fields, 'pauseOptions'), false, '关掉后不该再下发收尾问选项')
})

check('重复关是幂等的，且 changed 如实回报 false', () => {
  clearRaw()
  setAskPause(false)
  const again = setAskPause(false)
  assert.equal(again.askPause, false)
  assert.equal(again.changed, false, '第二次关没改变什么，changed 必须是 false')
})

check('能再打开，且打开后文案与选项都回来了', () => {
  clearRaw()
  setAskPause(false)
  const on = setAskPause(true)
  assert.equal(on.askPause, true)
  assert.equal(on.changed, true)
  const fields = pauseFields()
  assert.equal(fields.askPause, true)
  assert.equal(fields.pauseQuestion, PAUSE_QUESTION)
  assert.deepEqual(fields.pauseOptions, PAUSE_OPTIONS)
})

check('非布尔入参按「开」处理（`setAskPause(undefined)` 不该关掉它）', () => {
  clearRaw()
  setAskPause(false)
  // 面板传值出错时最可能的形状就是 undefined；那一下不该把开关翻成开或关得莫名其妙。
  const r = setAskPause(undefined)
  assert.equal(r.askPause, true, 'undefined 视为「不是显式 false」= 开')
})

/* --------------------- 两个开关不能互相盖掉（本仓老坑） --------------------- */

check('关收尾问**不会**抹掉按会话的禁用名单', () => {
  clearRaw()
  disableSession('session-a')
  disableSession('session-b')
  assert.equal(readSettings().disabledSessions.length, 2)

  setAskPause(false)
  const after = readSettings()
  assert.equal(after.askPause, false)
  assert.deepEqual(after.disabledSessions, ['session-a', 'session-b'], '写 askPause 时必须把禁用名单一起写回')
})

check('按会话禁用**不会**把收尾问开关重置回默认', () => {
  clearRaw()
  setAskPause(false)
  disableSession('session-c')
  assert.equal(readSettings().askPause, false, '写禁用名单时必须把 askPause 一起写回')

  enableSession('session-c')
  assert.equal(readSettings().askPause, false, '恢复会话同样不能碰 askPause')
})

check('设置文件里两个字段同时在（形状没被写成只剩一个）', () => {
  clearRaw()
  setAskPause(false)
  disableSession('session-d')
  const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'))
  assert.equal(typeof raw.askPause, 'boolean', 'askPause 必须在文件里')
  assert.ok(Array.isArray(raw.disabledSessions), 'disabledSessions 必须在文件里')
  assert.ok(existsSync(settingsPath()))
})

/* ------------------------------ 跨会话全局 ------------------------------ */

check('开关是**全局**的：与 sessionId 无关，读它不需要任何会话参数', () => {
  clearRaw()
  setAskPause(false)
  // 函数签名里根本没有 sessionId —— 这就是「全局」在代码层的表达。
  assert.equal(isAskPauseEnabled.length, 0, 'isAskPauseEnabled 不该收会话参数')
  assert.equal(isAskPauseEnabled(), false)
  setAskPause(true)
  assert.equal(isAskPauseEnabled(), true)
})

/* ------------------------------ 收尾 ------------------------------ */

rmSync(HOME, { recursive: true, force: true })
console.log('')
console.log(passed + ' 项通过 / ' + failed + ' 项失败')
if (failed > 0) {
  for (const row of failures) console.log('  - ' + row.name + '：' + (row.error && row.error.message ? row.error.message : String(row.error)))
  process.exit(1)
}
