/**
 * 重复思考熔断测试：不需要 Cordis 运行时——把宿主半 `apply` 注册的
 * `tools/post-execute` 监听器截下来，用真实的 `ToolExecution` 形状直接驱动。
 *
 *   node test/60-loopguard.test.mjs
 *
 * ## 为什么用 `tools/post-execute` 驱动，而不是 `agent/pre-step`
 *
 * 本仓已经用**假绿**换过这个教训（见 `test/40-pre-execute.test.mjs` 开头）：
 * `agent/pre-step` 的 `decision.messages` 契约是 `UserMessage[]`，
 * **里面根本没有 tool-call**。想从 pre-step 的消息里认出「模型刚才调了什么工具」
 * 读不到——旧测试伪造了一条带 tool-call 的 assistant 消息，断言全绿，
 * 而真实运行时永远走不到那个分支。所以这里一律用真实的 `ToolExecution`
 * （`{callId, name, arguments, agent, signal}`）。
 *
 * ## 断言为什么这么写
 *
 * 按本仓约定（`~/.dsh/AGENTS.md` 第 0.1 节）：**断言引常量**，
 * 阈值取 `LOOP_REPEAT_THRESHOLD` 而不是写死 3；同时**必须**有一条
 * 「守卫真的会红」的自证——把阈值改回去就报错，否则守卫形同虚设。
 *
 * 宿主半 import 了 `@deepseek-ai/dsh-tools`（由 DSH 运行时提供）。在没装 DSH 的
 * 裸目录里这一组无法运行，此时**明确跳过**并说明原因，而不是抛 ERR_MODULE_NOT_FOUND。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LOOP_ESCALATE_EVERY,
  LOOP_MAX_LEVEL,
  LOOP_REPEAT_THRESHOLD,
  actionSignature,
  clearStreak,
  loopBreakText,
  noteAction,
  resetLoopGuard,
  streakOf,
} from '../lib/puzzle.js'

let host
try {
  host = await import('../lib/index.js')
} catch (error) {
  const code = error === null || error === undefined ? undefined : error.code
  console.log(`skip 60-loopguard.test.mjs：${code === 'ERR_MODULE_NOT_FOUND' ? '找不到 @deepseek-ai/dsh-tools（本目录未装进 DSH profile），跳过' : String(error && error.message ? error.message : error)}`)
  process.exit(0)
}

const root = mkdtempSync(join(tmpdir(), 'puzzle-loopguard-'))
let passed = 0

function ok(name) {
  passed += 1
  console.log(`ok   ${name}`)
}

/** 摘出宿主半注册的 tools/post-execute 监听器（可能有两个：工作流触发 + 熔断）。 */
function captureListeners() {
  const found = []
  host.apply({
    systemPrompt: { section() {} },
    tools: { register() { return () => {} } },
    on(event, fn) {
      if (event === 'tools/post-execute') found.push(fn)
      return () => {}
    },
    inject() {},
    effect() {},
    get(name) {
      if (name !== 'sessions') return undefined
      return { get(id) { return typeof id === 'string' && id !== '' ? { header: { cwd: root } } : undefined } }
    },
  })
  return found
}

/** 真实的 ToolExecution 形状（只取本插件会读的字段）。 */
function call(name, args = {}, id = 'session-loop') {
  return { callId: 'c1', name, arguments: args, agent: { id }, signal: { aborted: false } }
}

/** 默认放行（模拟 next() 到链尾的 accept）。 */
const accept = async () => ({ kind: 'accept' })

/** 驱动一次调用，返回注入的上下文文本数组。 */
async function fire(listener, exec) {
  const decision = await listener(exec, { ok: true }, accept)
  const contexts = decision !== null && decision !== undefined && Array.isArray(decision.additionalContexts)
    ? decision.additionalContexts
    : []
  return contexts.map((message) => {
    const content = message !== null && message !== undefined ? message.content : undefined
    if (!Array.isArray(content)) return ''
    return content.map((block) => (block !== null && typeof block.text === 'string' ? block.text : '')).join('')
  })
}

try {
  const listeners = captureListeners()
  // 本插件现在有两个 post-execute 钩子（工作流触发 / 熔断），逐个都验。
  assert.ok(listeners.length >= 1, '必须注册 tools/post-execute 监听器')

  /* ---------------- 纯函数层：签名与连击 ---------------- */

  resetLoopGuard()
  assert.equal(actionSignature('', { a: 1 }), '', '工具名缺失 → 不计入连击')
  assert.equal(actionSignature('read', {}), '', '无参调用 → 不计入连击（轮询类工具的正常行为）')
  assert.equal(actionSignature('read', null), '', '参数不是对象 → 不计入连击')
  ok('无参 / 认不出的调用不计入连击')

  // 键序不同必须算出同一个签名——否则同一件事算两个签名，连击永远数不到阈值，
  // 熔断就成了永不触发的死代码。
  assert.equal(
    actionSignature('read', { path: '/a', limit: 10 }),
    actionSignature('read', { limit: 10, path: '/a' }),
    '键序不同 → 同一个签名',
  )
  assert.notEqual(
    actionSignature('read', { path: '/a' }),
    actionSignature('read', { path: '/b' }),
    '参数不同 → 不同签名',
  )
  assert.notEqual(
    actionSignature('read', { path: '/a' }),
    actionSignature('grep', { path: '/a' }),
    '工具名不同 → 不同签名',
  )
  ok('签名对键序不敏感、对工具名与参数敏感')

  resetLoopGuard()
  const first = noteAction('s1', 'read', { path: '/a' })
  assert.equal(first.count, 1, '第一次记 1')
  assert.equal(first.shouldFire, false, '第一次不熔断')
  for (let i = 2; i < LOOP_REPEAT_THRESHOLD; i += 1) {
    const mid = noteAction('s1', 'read', { path: '/a' })
    assert.equal(mid.count, i, `第 ${i} 次记 ${i}`)
    assert.equal(mid.shouldFire, false, `第 ${i} 次（未到阈值）不熔断`)
  }
  const hit = noteAction('s1', 'read', { path: '/a' })
  assert.equal(hit.count, LOOP_REPEAT_THRESHOLD, `第 ${LOOP_REPEAT_THRESHOLD} 次到阈值`)
  assert.equal(hit.shouldFire, true, '连续到阈值 → 熔断')
  ok(`连续 ${LOOP_REPEAT_THRESHOLD} 次同签名 → 触发熔断`)

  // 升级重报（v0.27.0）：报过之后**不再永久闭嘴**。
  // 旧行为是「同一段连击只报一次」，实测后果是熔断不生效——模型没改的时候，
  // 后面每一次重复都被静默放行，链条原地空转或把球踢回用户，最后还得人工推。
  const again = noteAction('s1', 'read', { path: '/a' })
  assert.equal(again.shouldFire, false, '报过之后紧邻的几次不重复刷屏（间隔内）')
  assert.equal(again.count, LOOP_REPEAT_THRESHOLD + 1, '计数继续涨')
  ok('报过一次后，间隔内不重复刷屏')

  // 关键回归：没换动作 → 每 LOOP_ESCALATE_EVERY 次必须**再报一次**。
  // 这条断言就是「熔断后能自己继续推进」的守卫；把它删掉，功能会静默退化成只报一次。
  let escalated = null
  let steps = LOOP_REPEAT_THRESHOLD + 1
  while (steps < LOOP_REPEAT_THRESHOLD + LOOP_ESCALATE_EVERY + 2) {
    const next = noteAction('s1', 'read', { path: '/a' })
    steps += 1
    if (next.shouldFire) { escalated = next; break }
  }
  assert.notEqual(escalated, null, `没换动作时，每 ${LOOP_ESCALATE_EVERY} 次必须再报一次（否则熔断只报一次 = 静默失效）`)
  assert.equal(escalated.level, 2, '第二次提醒 level 升到 2（文案要变硬）')
  ok(`没换动作 → 每 ${LOOP_ESCALATE_EVERY} 次升级重报一次`)

  // level 有上限：连击再长也不无限加码，但**仍然继续重报**（沉默比重复更贵）。
  let maxLevel = escalated.level
  let refires = 0
  for (let i = 0; i < LOOP_ESCALATE_EVERY * LOOP_MAX_LEVEL + LOOP_ESCALATE_EVERY; i += 1) {
    const next = noteAction('s1', 'read', { path: '/a' })
    if (next.shouldFire) { refires += 1; maxLevel = Math.max(maxLevel, next.level) }
  }
  assert.equal(maxLevel, LOOP_MAX_LEVEL, `level 到顶后不再加码（上限 ${LOOP_MAX_LEVEL}）`)
  assert.ok(refires >= 1, '到顶之后仍然按间隔重报——不许退回「报过就永久沉默」')
  ok(`level 封顶 ${LOOP_MAX_LEVEL}，且到顶后仍持续重报`)

  // 签名变了 = 换了动作 → 重新数，并重新武装（提醒次数归零，重新给温和的第一档）。
  const changed = noteAction('s1', 'read', { path: '/b' })
  assert.equal(changed.count, 1, '换动作后从 1 重新数')
  assert.equal(changed.shouldFire, false, '换动作后不立刻报')
  assert.equal(changed.level, 0, '换动作后提醒档位归零')
  ok('换动作后连击归零并重新武装')

  // 不同会话互不干扰（本 hook 注册在根级 ctx，对每个 agent 都生效）。
  resetLoopGuard()
  for (let i = 0; i < LOOP_REPEAT_THRESHOLD; i += 1) noteAction('sA', 'read', { path: '/a' })
  const other = noteAction('sB', 'read', { path: '/a' })
  assert.equal(other.count, 1, '会话之间互不串味')
  assert.equal(other.shouldFire, false, '别的会话第一次不熔断')
  ok('连击按会话隔离')

  // 空 sessionId 不该崩，也不该被记进表里。
  const anonymous = noteAction('', 'read', { path: '/a' })
  assert.equal(anonymous.count, 1, '没有 sessionId 时按第一次算')
  assert.equal(anonymous.shouldFire, false, '没有 sessionId 时不熔断')
  assert.equal(streakOf(''), null, '空 sessionId 不落表')
  ok('空 sessionId 安全降级')

  /* ---------------- 提示文本 ---------------- */

  const text = loopBreakText('read', LOOP_REPEAT_THRESHOLD)
  assert.ok(text.includes('read'), '提示里点名了工具')
  assert.ok(text.includes(String(LOOP_REPEAT_THRESHOLD)), '提示里写明连续几次')
  assert.ok(text.includes('【拼图模式'), '提示带标记，便于辨认来源')
  // 三条出路缺一不可：只说「别重复」等于没给信息。
  assert.ok(text.includes('换输入') && text.includes('换动作') && text.includes('停下来说清'), '三条出路齐全')
  ok('熔断提示含事实 + 三条出路')

  // 第二档起必须**撤掉「转人工」这条逃逸口**——它是最省力的逃避，
  // 留着它熔断就变成「把问题抛回用户」，正是用户报的那个「还得人工推」。
  const hard = loopBreakText('read', LOOP_REPEAT_THRESHOLD + LOOP_ESCALATE_EVERY, LOOP_REPEAT_THRESHOLD, 2)
  assert.ok(hard.includes('先捋事实'), '第二档要给「先捋已有事实」这一步')
  assert.ok(hard.includes('不要再调一次工具去确认'), '第二档要禁掉「再确认一遍」')
  assert.ok(hard.includes('现在不适用'), '第二档必须明确否掉「停下来说清」这条出路')
  assert.ok(hard.includes('卡在哪一步'), '真要报卡住时必须说清卡在哪一步、缺哪条信息')
  assert.ok(!hard.includes('三选一'), '第二档不再是三选一')
  ok('第二档升级为硬指令并撤掉转人工逃逸口')

  /* ---------------- 接线层：真钩子驱动 ---------------- */

  // 找到熔断那个钩子：只有它会为重复调用注入带标记的上下文。
  resetLoopGuard()
  const sessionId = 'session-loop-wire'
  clearStreak(sessionId)
  const execArgs = { file_path: '/tmp/demo.txt' }
  let breakListener = null
  const seen = []
  for (const listener of listeners) {
    resetLoopGuard()
    clearStreak(sessionId)
    let injected = []
    for (let i = 0; i < LOOP_REPEAT_THRESHOLD; i += 1) {
      injected = await fire(listener, call('read_file', execArgs, sessionId))
    }
    seen.push(injected)
    if (injected.some((one) => one.includes('重复思考熔断'))) breakListener = listener
  }
  assert.notEqual(breakListener, null, '必须有一个钩子在连续重复时注入熔断提示')
  ok('接线：连续重复调用后真的注入了熔断提示')

  const injectedText = seen.find((list) => list.some((one) => one.includes('重复思考熔断'))) ?? []
  const breakText = injectedText.find((one) => one.includes('重复思考熔断')) ?? ''
  assert.ok(breakText.includes('read_file'), '注入文本点名了重复的工具')
  assert.ok(breakText.includes(String(LOOP_REPEAT_THRESHOLD)), '注入文本写明了重复次数')
  ok('接线：注入文本内容正确')

  // 接线层回归（v0.27.0 的核心）：模型**不改**的时候，钩子必须持续推动，
  // 而且第二次注入要换成硬指令。只验纯函数会漏掉「钩子没把 level 传下去」这种断线。
  resetLoopGuard()
  clearStreak(sessionId)
  const pushed = []
  for (let i = 0; i < LOOP_REPEAT_THRESHOLD + LOOP_ESCALATE_EVERY + 2; i += 1) {
    const decision = await breakListener(call('read_file', execArgs, sessionId), { ok: true }, accept)
    const contexts = decision !== null && Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    for (const message of contexts) {
      const content = message !== null && message !== undefined ? message.content : undefined
      if (Array.isArray(content)) pushed.push(content.map((b) => (b !== null && typeof b.text === 'string' ? b.text : '')).join(''))
    }
  }
  assert.ok(pushed.length >= 2, '不改动作时钩子必须重复注入（只注入一次 = 熔断后没人推，用户得手工接着跑）')
  assert.ok(pushed.some((one) => one.includes('先捋事实')), '第二次注入必须是硬指令（撤掉转人工逃逸口）')
  ok('接线：不改动作时持续升级注入，第二次起是硬指令')

  // 守卫自证：不重复的调用**不许**被注入（否则熔断会变成噪音源）。
  resetLoopGuard()
  clearStreak(sessionId)
  const distinct = []
  for (let i = 0; i < LOOP_REPEAT_THRESHOLD + 2; i += 1) {
    const decision = await breakListener(call('read_file', { file_path: `/tmp/f${i}.txt` }, sessionId), { ok: true }, accept)
    const contexts = decision !== null && Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    distinct.push(...contexts)
  }
  assert.equal(distinct.length, 0, '每次参数都不同 → 一条都不该注入')
  ok('守卫自证：不重复的调用不会被误报')

  // 守卫自证：无参轮询工具反复调**不许**被注入。
  resetLoopGuard()
  clearStreak(sessionId)
  let pollInjected = 0
  for (let i = 0; i < LOOP_REPEAT_THRESHOLD + 3; i += 1) {
    const decision = await breakListener(call('job_list', {}, sessionId), { ok: true }, accept)
    const contexts = decision !== null && Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    pollInjected += contexts.length
  }
  assert.equal(pollInjected, 0, '无参轮询工具反复调不该被当成绕圈')
  ok('守卫自证：无参轮询工具不被误报')

  // 守卫自证：工具被 block（失败）时不插话——失败重试是正当行为。
  resetLoopGuard()
  clearStreak(sessionId)
  let blockedInjected = 0
  for (let i = 0; i < LOOP_REPEAT_THRESHOLD + 2; i += 1) {
    const decision = await breakListener(call('read_file', execArgs, sessionId), { ok: false }, async () => ({ kind: 'block' }))
    const contexts = decision !== null && Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    blockedInjected += contexts.length
  }
  assert.equal(blockedInjected, 0, '工具失败（block）时不注入熔断')
  ok('守卫自证：工具失败时不插话')

  console.log(`\n重复思考熔断： ${passed} 通过 / 0 失败`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
