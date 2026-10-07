/**
 * 催促（只看不动）测试：纯函数层 + 真钩子接线层。
 *
 *   node test/100-nudge.test.mjs
 *
 * ## 为什么要有这一组
 *
 * 用户原话：「干活都磨磨唧唧的，加一个自动注入语音犀利的催促的功能」。
 * 催促的价值全在**真的注入了**——一个永不触发的钩子（或反过来：见谁都催的噪音源）
 * 都会让这个功能变成摆设。所以这里两头都验：
 *   1. 该催的必须催（只读连击、同一个文件读第二次）；
 *   2. **不该催的一条都不许催**（写文件、跑命令、参数各不相同的正常调研）。
 *
 * ## 断言为什么这么写
 *
 * 按本仓约定（`~/.dsh/AGENTS.md` 第 0.1 节）：**断言引常量**，
 * 阈值取 `NUDGE_READ_STREAK` 而不是写死 6；同时**必须**有「守卫真的会红」的自证——
 * 把只读白名单扩到所有工具、或把阈值调成 1，下面必有断言变红。
 *
 * 宿主半 import 了 `@deepseek-ai/dsh-tools`（由 DSH 运行时提供）。在没装 DSH 的
 * 裸目录里这一组无法运行，此时**明确跳过**并说明原因，而不是抛 ERR_MODULE_NOT_FOUND。
 */
import assert from 'node:assert/strict'
// **必须最先**：隔离 DSH_HOME（本钩子走 isSessionDisabled，会读全局设置）。
import './helpers/isolate-home.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NUDGE_ESCALATE_EVERY,
  NUDGE_MARK,
  NUDGE_MAX_LEVEL,
  NUDGE_READ_STREAK,
  NUDGE_REASON_REPEAT,
  NUDGE_REASON_STREAK,
  NUDGE_SAME_FILE,
  READ_ONLY_TOOLS,
  clearNudge,
  isReadOnlyTool,
  noteCall,
  nudgeStateOf,
  nudgeText,
  readTargetOf,
  resetNudge,
} from '../lib/puzzle.js'

let host
try {
  host = await import('../lib/index.js')
} catch (error) {
  const code = error === null || error === undefined ? undefined : error.code
  console.log(`skip 100-nudge.test.mjs：${code === 'ERR_MODULE_NOT_FOUND' ? '找不到 @deepseek-ai/dsh-tools（本目录未装进 DSH profile），跳过' : String(error && error.message ? error.message : error)}`)
  process.exit(0)
}

const root = mkdtempSync(join(tmpdir(), 'puzzle-nudge-'))
let passed = 0

function ok(name) {
  passed += 1
  console.log(`ok   ${name}`)
}

/** 摘出宿主半注册的 tools/post-execute 监听器（本插件现在有三个）。 */
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
function call(name, args = {}, id = 'session-nudge') {
  return { callId: 'c1', name, arguments: args, agent: { id }, signal: { aborted: false } }
}

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
  /* ---------------- 纯函数层：判定 ---------------- */

  // 白名单必须**只有**只读工具：把 write / pwsh 混进来，催促就会打断正在干活的人。
  assert.deepEqual([...READ_ONLY_TOOLS], ['read', 'grep', 'glob'], '只读白名单只能是 read / grep / glob')
  assert.equal(isReadOnlyTool('read'), true, 'read 算只读')
  assert.equal(isReadOnlyTool('grep'), true, 'grep 算只读')
  assert.equal(isReadOnlyTool('write'), false, 'write 是产出，不算只读')
  assert.equal(isReadOnlyTool('pwsh'), false, 'pwsh 是产出，不算只读')
  assert.equal(isReadOnlyTool('puzzle_mode'), false, 'puzzle_mode 是产出，不算只读')
  ok('只读白名单只含 read / grep / glob')

  // 只有 read 有「同一个文件」这个概念；grep / glob 是范围检索，取不到单一目标。
  assert.equal(readTargetOf('read', { file_path: '/a/b.txt' }), '/a/b.txt', 'read 的目标是 file_path')
  assert.equal(readTargetOf('read', {}), '', 'read 没给 file_path → 空')
  assert.equal(readTargetOf('grep', { path: '/a' }), '', 'grep 不是「同一个文件」')
  assert.equal(readTargetOf('read', { file_path: '  ' }), '', '空白路径不算目标')
  ok('只有 read 参与「分段读」判定')

  // 未到阈值不许催：连着读几个文件是正常调研。
  resetNudge()
  for (let i = 1; i < NUDGE_READ_STREAK; i += 1) {
    const step = noteCall('s1', 'read', { file_path: `/f${i}.txt` })
    assert.equal(step.shouldNudge, false, `第 ${i} 次只读（未到阈值 ${NUDGE_READ_STREAK}）不该催`)
    assert.equal(step.streak, i, `连击应记到 ${i}`)
  }
  const hit = noteCall('s1', 'read', { file_path: '/f-last.txt' })
  assert.equal(hit.streak, NUDGE_READ_STREAK, `第 ${NUDGE_READ_STREAK} 次到阈值`)
  assert.equal(hit.shouldNudge, true, '连续只读到阈值 → 必须催')
  assert.equal(hit.reason, NUDGE_REASON_STREAK, '原因是「只读连击」')
  assert.equal(hit.level, 1, '第一次催是第 1 档')
  ok(`连续 ${NUDGE_READ_STREAK} 次只读 → 触发催促`)

  // 产出动作必须**清空**连击：写完文件还接着被催，等于催一个正在干活的人。
  resetNudge()
  for (let i = 0; i < NUDGE_READ_STREAK; i += 1) noteCall('s1', 'read', { file_path: `/g${i}.txt` })
  const produced = noteCall('s1', 'write', { file_path: '/g.txt' })
  assert.equal(produced.shouldNudge, false, 'write 是产出，不该被催')
  assert.equal(produced.streak, 0, '产出后连击归零')
  assert.equal(nudgeStateOf('s1'), null, '产出后状态整个丢掉（不跨段继承读过的文件）')
  ok('产出动作清空连击（不误催正在干活的人）')

  // 分段读：同一个文件读到第 NUDGE_SAME_FILE 次就要点名。
  resetNudge()
  const firstRead = noteCall('s2', 'read', { file_path: '/same.txt' })
  assert.equal(firstRead.shouldNudge, false, '第一次读一个文件永远正常')
  const secondRead = noteCall('s2', 'read', { file_path: '/same.txt' })
  assert.equal(secondRead.shouldNudge, true, `同一个文件读到第 ${NUDGE_SAME_FILE} 次 → 催「一次读全」`)
  assert.equal(secondRead.reason, NUDGE_REASON_REPEAT, '原因是「分段读」')
  assert.equal(secondRead.target, '/same.txt', '催促要点名是哪个文件')
  ok(`同一个文件读第 ${NUDGE_SAME_FILE} 次 → 触发「分段读」催促`)

  // 同一个文件只催一次：读十次催九次比不催更烦。
  const thirdRead = noteCall('s2', 'read', { file_path: '/same.txt' })
  assert.equal(thirdRead.shouldNudge, false, '同一个文件已经催过 → 不再重复催')
  ok('同一个文件只催一次（不刷屏）')

  // 关键回归：催过之后**不许永久闭嘴**。模型没产出就每 NUDGE_ESCALATE_EVERY 次再催一次，
  // 而且档位要加硬——删掉这条逻辑，催促会退化成「只报一次」= 静默失效。
  resetNudge()
  for (let i = 0; i < NUDGE_READ_STREAK; i += 1) noteCall('s3', 'read', { file_path: `/h${i}.txt` })
  let escalated = null
  for (let i = 0; i < NUDGE_ESCALATE_EVERY + 2; i += 1) {
    const step = noteCall('s3', 'read', { file_path: `/h-more-${i}.txt` })
    if (step.shouldNudge) { escalated = step; break }
  }
  assert.notEqual(escalated, null, `没产出时每 ${NUDGE_ESCALATE_EVERY} 次必须再催一次（否则催促只报一次 = 静默失效）`)
  assert.equal(escalated.level, 2, '第二次催升到第 2 档（文案要变硬）')
  ok(`没产出 → 每 ${NUDGE_ESCALATE_EVERY} 次升级重催`)

  // 档位有上限，但**仍然继续催**（沉默比重复更贵）。
  resetNudge()
  for (let i = 0; i < NUDGE_READ_STREAK; i += 1) noteCall('s4', 'read', { file_path: `/k${i}.txt` })
  let maxLevel = 1
  let refires = 0
  for (let i = 0; i < NUDGE_ESCALATE_EVERY * NUDGE_MAX_LEVEL + NUDGE_ESCALATE_EVERY * 2; i += 1) {
    const step = noteCall('s4', 'read', { file_path: `/k-more-${i}.txt` })
    if (step.shouldNudge) { refires += 1; maxLevel = Math.max(maxLevel, step.level) }
  }
  assert.equal(maxLevel, NUDGE_MAX_LEVEL, `档位封顶 ${NUDGE_MAX_LEVEL}（不许无限加码）`)
  assert.ok(refires >= 1, '到顶之后仍然继续催——不许退回「催过就永久沉默」')
  ok(`档位封顶 ${NUDGE_MAX_LEVEL}，且到顶后仍持续催`)

  // 会话之间互不串味（本 hook 注册在根级 ctx，对每个 agent 都生效）。
  resetNudge()
  for (let i = 0; i < NUDGE_READ_STREAK; i += 1) noteCall('sA', 'read', { file_path: `/m${i}.txt` })
  const other = noteCall('sB', 'read', { file_path: '/m0.txt' })
  assert.equal(other.streak, 1, '会话之间互不串味')
  assert.equal(other.shouldNudge, false, '别的会话第一次不催')
  ok('催促状态按会话隔离')

  // 空 sessionId 安全降级：不崩、不落表。
  resetNudge()
  const anonymous = noteCall('', 'read', { file_path: '/a.txt' })
  assert.equal(anonymous.shouldNudge, false, '没有 sessionId 时不催')
  assert.equal(nudgeStateOf(''), null, '空 sessionId 不落表')
  ok('空 sessionId 安全降级')

  // clearNudge 要能真的清掉（测试与「用户重新说话」都靠它）。
  resetNudge()
  noteCall('s5', 'read', { file_path: '/x.txt' })
  assert.notEqual(nudgeStateOf('s5'), null, '记过之后有状态')
  clearNudge('s5')
  assert.equal(nudgeStateOf('s5'), null, 'clearNudge 之后状态没了')
  ok('clearNudge 清得掉状态')

  /* ---------------- 提示文本 ---------------- */

  const streakText = nudgeText(NUDGE_REASON_STREAK, NUDGE_READ_STREAK, 1)
  assert.ok(streakText.includes(NUDGE_MARK), '催促带标记，便于辨认来源')
  assert.ok(streakText.includes(String(NUDGE_READ_STREAK)), '催促里写明连续几次')
  // 催促必须给出口：只骂「你太慢了」等于没给信息。
  assert.ok(streakText.includes('产出'), '第一档必须要求「先产出一步」')
  ok('催促第一档：写明次数 + 给出产出动作')

  const repeatText = nudgeText(NUDGE_REASON_REPEAT, NUDGE_READ_STREAK, 0, '/same.txt')
  assert.ok(repeatText.includes('/same.txt'), '分段读的催促要点名是哪个文件')
  assert.ok(repeatText.includes('limit'), '分段读的催促要教它把 limit 给足')
  assert.ok(repeatText.includes('并行'), '分段读的催促要教它并行读多个文件')
  ok('分段读催促：点名文件 + 教「一次读全 / 并行读」')

  const hardText = nudgeText(NUDGE_REASON_STREAK, NUDGE_READ_STREAK + NUDGE_ESCALATE_EVERY, 2)
  assert.ok(hardText.includes('不许再调'), '第二档必须禁掉只读工具（撤出口）')
  ok('催促第二档：禁掉只读工具')

  const hardest = nudgeText(NUDGE_REASON_STREAK, NUDGE_READ_STREAK + NUDGE_ESCALATE_EVERY * 2, NUDGE_MAX_LEVEL)
  assert.ok(hardest.includes('立刻交付'), '最高档必须要求立刻交付')
  ok(`催促最高档（${NUDGE_MAX_LEVEL} 档）要求立刻交付`)

  /* ---------------- 接线层：真钩子驱动 ---------------- */

  const listeners = captureListeners()
  assert.ok(listeners.length >= 1, '必须注册 tools/post-execute 监听器')

  // 找到催促那个钩子：只有它会注入带催促标记的上下文。
  resetNudge()
  const sessionId = 'session-nudge-wire'
  clearNudge(sessionId)
  let nudgeListener = null
  for (const listener of listeners) {
    resetNudge()
    clearNudge(sessionId)
    let injected = []
    for (let i = 0; i < NUDGE_READ_STREAK; i += 1) {
      injected = await fire(listener, call('read', { file_path: `/w${i}.txt` }, sessionId))
    }
    if (injected.some((one) => one.includes(NUDGE_MARK))) { nudgeListener = listener; break }
  }
  assert.notEqual(nudgeListener, null, '必须有一个钩子在连续只读时注入催促')
  ok('接线：连续只读调用后真的注入了催促')

  // 接线层回归：不产出时必须持续催（只催一次 = 用户还得手工推）。
  resetNudge()
  clearNudge(sessionId)
  const pushed = []
  for (let i = 0; i < NUDGE_READ_STREAK + NUDGE_ESCALATE_EVERY + 2; i += 1) {
    const decision = await nudgeListener(call('read', { file_path: `/w-more-${i}.txt` }, sessionId), { ok: true }, accept)
    const contexts = decision !== null && Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    for (const message of contexts) {
      const content = message !== null && message !== undefined ? message.content : undefined
      if (Array.isArray(content)) pushed.push(content.map((b) => (b !== null && typeof b.text === 'string' ? b.text : '')).join(''))
    }
  }
  assert.ok(pushed.length >= 2, '不产出时钩子必须重复催（只催一次 = 催促失效）')
  assert.ok(pushed.some((one) => one.includes('不许再调')), '第二次催必须是硬文案（禁掉只读工具）')
  ok('接线：不产出时持续升级催促，第二次起禁掉只读工具')

  // 接线层：分段读在真实钩子上也要触发，且带文件名。
  resetNudge()
  clearNudge(sessionId)
  let repeatInjected = []
  for (let i = 0; i < NUDGE_SAME_FILE; i += 1) {
    repeatInjected = await fire(nudgeListener, call('read', { file_path: '/repeat-me.txt' }, sessionId))
  }
  assert.ok(repeatInjected.some((one) => one.includes(NUDGE_MARK)), '同一个文件读第二次必须在真实钩子上触发催促')
  assert.ok(repeatInjected.some((one) => one.includes('/repeat-me.txt')), '催促里要点名那个文件')
  ok('接线：分段读触发且点名文件')

  // 守卫自证：产出动作**一条都不许**被催（否则催促会打断正在干活的人）。
  resetNudge()
  clearNudge(sessionId)
  let producedInjected = 0
  for (let i = 0; i < NUDGE_READ_STREAK + 3; i += 1) {
    const decision = await nudgeListener(call('write', { file_path: `/out${i}.txt` }, sessionId), { ok: true }, accept)
    const contexts = decision !== null && Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    producedInjected += contexts.length
  }
  assert.equal(producedInjected, 0, '一直产出时一条催促都不许注入')
  ok('守卫自证：持续产出时不被催')

  // 守卫自证：只读与产出交替（正常干活的节奏）不许被催。
  resetNudge()
  clearNudge(sessionId)
  let mixedInjected = 0
  for (let i = 0; i < NUDGE_READ_STREAK + 3; i += 1) {
    const decision = await nudgeListener(call('read', { file_path: `/mix${i}.txt` }, sessionId), { ok: true }, accept)
    const contexts = decision !== null && Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    mixedInjected += contexts.length
    // 每读一次就跟一次产出——这是健康的节奏，连击应当始终归零。
    await nudgeListener(call('edit', { file_path: `/mix${i}.txt` }, sessionId), { ok: true }, accept)
  }
  assert.equal(mixedInjected, 0, '读一次改一次（正常节奏）不该被催')
  ok('守卫自证：读一次改一次不被催')

  // 守卫自证：工具失败（block）时不插话——失败重试是正当行为，不是磨蹭。
  resetNudge()
  clearNudge(sessionId)
  let blockedInjected = 0
  for (let i = 0; i < NUDGE_READ_STREAK + 2; i += 1) {
    const decision = await nudgeListener(call('read', { file_path: `/bad${i}.txt` }, sessionId), { ok: false }, async () => ({ kind: 'block' }))
    const contexts = decision !== null && Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    blockedInjected += contexts.length
  }
  assert.equal(blockedInjected, 0, '工具失败（block）时不催')
  ok('守卫自证：工具失败时不插话')

  console.log(`\n催促（只看不动）： ${passed} 通过 / 0 失败`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
