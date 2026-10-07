/**
 * 催促（每 N 步一次）测试：纯函数层 + 真钩子接线层。
 *
 *   node test/100-nudge.test.mjs
 *
 * ## 为什么要有这一组
 *
 * 用户原话：「干活都磨磨唧唧的，加一个自动注入语音犀利的催促的功能」，
 * 随后把口径钉死成**「我的意思是干什么都四步催一次」**（该值后来由用户改为 6 步）——
 * 是**纯节拍**，不是「连续只读才催」。第一版做成了后者，被当场纠正。
 * 所以这里最关键的一条断言是：**读写混合的 4 步也必须催**。
 *
 * ## 断言为什么这么写
 *
 * 按本仓约定（`~/.dsh/AGENTS.md` 第 0.1 节）：**断言引常量**，
 * 阈值取 `NUDGE_EVERY` 而不是写死 4；同时**必须**有「守卫真的会红」的自证——
 * 把节拍改回「只读才算」、或让分段读顶掉节拍，下面必有断言变红。
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
  NUDGE_EVERY,
  NUDGE_MARK,
  NUDGE_MAX_LEVEL,
  NUDGE_REASON_CADENCE,
  NUDGE_REASON_REPEAT,
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
  /* ---------------- 纯函数层：节拍 ---------------- */

  assert.equal(NUDGE_EVERY, 6, `用户裁定节拍为 6 步（当前 ${NUDGE_EVERY}）`)
  ok(`节拍 = ${NUDGE_EVERY} 步（用户裁定值）`)

  // **核心断言**：纯节拍——读写混合也必须按节拍催。
  // 第一版是「连续只读才催」，这一条就是防它退回去的守卫。
  // 工具名刻意**交错**，覆盖「读 / 写 / 跑命令」都在同一节拍里。
  resetNudge()
  const mixed = Array.from({ length: NUDGE_EVERY }, (_, i) => ['read', 'write', 'pwsh'][i % 3])
  let cadenceHit = null
  for (let i = 0; i < mixed.length; i += 1) {
    const step = noteCall('s1', mixed[i], { file_path: `/m${i}.txt` })
    assert.equal(step.count, i + 1, `第 ${i + 1} 步应记 ${i + 1}`)
    if (step.shouldNudge) cadenceHit = step
    else assert.equal(step.shouldNudge, false, `第 ${i + 1} 步（未到 ${NUDGE_EVERY} 的倍数）不该催`)
  }
  assert.notEqual(cadenceHit, null, `读写混合走到第 ${NUDGE_EVERY} 步也必须催（纯节拍，不看工具类型）`)
  assert.equal(cadenceHit.reason, NUDGE_REASON_CADENCE, '原因是「到节拍」')
  assert.equal(cadenceHit.level, 1, '中间有产出 → 语气停在第 1 档（轻推，别骂干活的人）')
  ok(`读写混合走到第 ${NUDGE_EVERY} 步 → 催（纯节拍，这是用户要的口径）`)

  // 全是写（完全没有只读）也照样按节拍催。
  resetNudge()
  let allWrite = null
  for (let i = 0; i < NUDGE_EVERY; i += 1) allWrite = noteCall('s2', 'write', { file_path: `/w${i}.txt` })
  assert.equal(allWrite.shouldNudge, true, `全在写也要按节拍催（第 ${NUDGE_EVERY} 步）`)
  assert.equal(allWrite.level, 1, '有产出 → 第 1 档')
  ok('全是产出动作也按节拍催（第 1 档轻推）')

  // 一直只读 → 档位逐次加硬（第 2 档禁只读，第 3 档只留交付）。
  resetNudge()
  const levels = []
  for (let i = 1; i <= NUDGE_EVERY * 3; i += 1) {
    const step = noteCall('s3', 'read', { file_path: `/r${i}.txt` })
    if (step.shouldNudge) levels.push(step.level)
  }
  assert.deepEqual(levels, [1, 2, 3], `一直只读时档位应逐次加硬，实际 ${JSON.stringify(levels)}`)
  ok('一直只读 → 档位 1 / 2 / 3 逐次加硬')

  // 档位封顶，但**节拍照旧**（沉默比重复更贵）。
  resetNudge()
  let maxLevel = 1
  let refires = 0
  for (let i = 1; i <= NUDGE_EVERY * (NUDGE_MAX_LEVEL + 3); i += 1) {
    const step = noteCall('s4', 'read', { file_path: `/c${i}.txt` })
    if (step.shouldNudge) { refires += 1; maxLevel = Math.max(maxLevel, step.level) }
  }
  assert.equal(maxLevel, NUDGE_MAX_LEVEL, `档位封顶 ${NUDGE_MAX_LEVEL}（不许无限加码）`)
  assert.ok(refires >= NUDGE_MAX_LEVEL + 1, '封顶之后仍然继续按节拍催')
  ok(`档位封顶 ${NUDGE_MAX_LEVEL}，且封顶后仍按节拍继续催`)

  // 每轮都是 4 的倍数 → 等距，没有漏拍也没有多拍。
  resetNudge()
  const hits = []
  for (let i = 1; i <= NUDGE_EVERY * 4; i += 1) {
    const step = noteCall('s5', 'read', { file_path: `/e${i}.txt` })
    if (step.shouldNudge && step.reason === NUDGE_REASON_CADENCE) hits.push(step.count)
  }
  assert.deepEqual(hits, [NUDGE_EVERY, NUDGE_EVERY * 2, NUDGE_EVERY * 3, NUDGE_EVERY * 4],
    `节拍必须等距落在 ${NUDGE_EVERY} 的倍数上，实际 ${JSON.stringify(hits)}`)
  ok(`节拍等距：第 ${NUDGE_EVERY} / ${NUDGE_EVERY * 2} / ${NUDGE_EVERY * 3} / ${NUDGE_EVERY * 4} 步各一次`)

  // 分段读：同一个文件读到第 NUDGE_SAME_FILE 次额外点名，且**不吃掉节拍**。
  resetNudge()
  const firstRead = noteCall('s6', 'read', { file_path: '/same.txt' })
  assert.equal(firstRead.shouldNudge, false, '第一次读一个文件永远正常')
  const secondRead = noteCall('s6', 'read', { file_path: '/same.txt' })
  assert.equal(secondRead.shouldNudge, true, `同一个文件读到第 ${NUDGE_SAME_FILE} 次 → 催「一次读全」`)
  assert.equal(secondRead.reason, NUDGE_REASON_REPEAT, '原因是「分段读」')
  assert.equal(secondRead.target, '/same.txt', '催促要点名是哪个文件')
  ok(`同一个文件读第 ${NUDGE_SAME_FILE} 次 → 触发「分段读」催促`)

  // 同一个文件只催一次：读十次催九次比不催更烦。
  const thirdRead = noteCall('s6', 'read', { file_path: '/same.txt' })
  assert.equal(thirdRead.reason, '', '同一个文件已经催过 → 不再重复催')
  ok('同一个文件只催一次（不刷屏）')

  // 分段读**不消费**节拍：两条触发各有各的节流。
  resetNudge()
  let cadenceAfterRepeat = null
  for (let i = 1; i <= NUDGE_EVERY; i += 1) {
    // 前两步读同一个文件（第 2 步触发分段读），后面继续走到节拍。
    const name = i <= 2 ? 'read' : 'write'
    const step = noteCall('s7', name, { file_path: i <= 2 ? '/dup.txt' : `/x${i}.txt` })
    if (step.reason === NUDGE_REASON_CADENCE) cadenceAfterRepeat = step
  }
  assert.notEqual(cadenceAfterRepeat, null, `分段读不许顶掉节拍——第 ${NUDGE_EVERY} 步仍要按节拍催`)
  assert.equal(cadenceAfterRepeat.count, NUDGE_EVERY, '节拍落在正确的步数上')
  ok('分段读不消费节拍（两条触发各管各的）')

  // 会话之间互不串味（本 hook 注册在根级 ctx，对每个 agent 都生效）。
  resetNudge()
  for (let i = 0; i < NUDGE_EVERY; i += 1) noteCall('sA', 'read', { file_path: `/n${i}.txt` })
  const other = noteCall('sB', 'read', { file_path: '/n0.txt' })
  assert.equal(other.count, 1, '会话之间互不串味')
  assert.equal(other.shouldNudge, false, '别的会话第一步不催')
  ok('催促计数按会话隔离')

  // 空 sessionId / 空工具名安全降级：不崩、不落表。
  resetNudge()
  assert.equal(noteCall('', 'read', { file_path: '/a.txt' }).shouldNudge, false, '没有 sessionId 时不催')
  assert.equal(nudgeStateOf(''), null, '空 sessionId 不落表')
  assert.equal(noteCall('s8', '', {}).shouldNudge, false, '没有工具名时不计数')
  ok('空 sessionId / 空工具名安全降级')

  // clearNudge 要能真的清掉（测试与「用户重新说话」都靠它）。
  resetNudge()
  noteCall('s9', 'read', { file_path: '/x.txt' })
  assert.notEqual(nudgeStateOf('s9'), null, '记过之后有状态')
  clearNudge('s9')
  assert.equal(nudgeStateOf('s9'), null, 'clearNudge 之后状态没了')
  ok('clearNudge 清得掉状态')

  /* ---------------- 纯函数层：工具名单与目标 ---------------- */

  assert.deepEqual([...READ_ONLY_TOOLS], ['read', 'grep', 'glob'], '只读名单只含三个探查工具')
  assert.equal(isReadOnlyTool('write'), false, 'write 不是只读')
  assert.equal(readTargetOf('read', { file_path: '/a/b.txt' }), '/a/b.txt', 'read 的目标是 file_path')
  assert.equal(readTargetOf('grep', { path: '/a' }), '', 'grep 不是「同一个文件」')
  ok('只读名单与 read 目标判定')

  /* ---------------- 提示文本 ---------------- */

  const cadenceText = nudgeText(NUDGE_REASON_CADENCE, NUDGE_EVERY, 1)
  assert.ok(cadenceText.includes(NUDGE_MARK), '催促带标记，便于辨认来源')
  assert.ok(cadenceText.includes(String(NUDGE_EVERY)), '第 1 档要写明走了多少步')
  assert.ok(cadenceText.includes('报进度'), '第 1 档要的是「报进度 + 做下一步」，不是训斥')
  assert.ok(!cadenceText.includes('不许再调'), '第 1 档不该禁工具（有产出时只是轻推）')
  ok('第 1 档：报进度 + 做下一步（轻推）')

  const repeatText = nudgeText(NUDGE_REASON_REPEAT, NUDGE_EVERY, 0, '/same.txt')
  assert.ok(repeatText.includes('/same.txt'), '分段读的催促要点名是哪个文件')
  assert.ok(repeatText.includes('limit'), '分段读的催促要教它把 limit 给足')
  assert.ok(repeatText.includes('并行'), '分段读的催促要教它并行读多个文件')
  ok('分段读催促：点名文件 + 教「一次读全 / 并行读」')

  const hardText = nudgeText(NUDGE_REASON_CADENCE, NUDGE_EVERY * 2, 2)
  assert.ok(hardText.includes('不许再调'), '第 2 档必须禁掉只读工具（撤出口）')
  const hardest = nudgeText(NUDGE_REASON_CADENCE, NUDGE_EVERY * 3, NUDGE_MAX_LEVEL)
  assert.ok(hardest.includes('立刻交付'), '最高档必须要求立刻交付')
  ok(`第 2 档禁只读、第 ${NUDGE_MAX_LEVEL} 档要求立刻交付`)

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
    // 用**读写混合**驱动：这正是用户要的口径，也能把「只读才算」的旧实现筛掉。
    for (let i = 0; i < NUDGE_EVERY; i += 1) {
      injected = await fire(listener, call(i % 2 === 0 ? 'read' : 'write', { file_path: `/w${i}.txt` }, sessionId))
    }
    if (injected.some((one) => one.includes(NUDGE_MARK))) { nudgeListener = listener; break }
  }
  assert.notEqual(nudgeListener, null, `读写混合走到第 ${NUDGE_EVERY} 步必须注入催促`)
  ok('接线：读写混合走到节拍真的注入了催促')

  // 接线层回归：不产出时钩子必须**持续**按节拍催，且第二次起变硬。
  resetNudge()
  clearNudge(sessionId)
  const pushed = []
  for (let i = 1; i <= NUDGE_EVERY * 3; i += 1) {
    const decision = await nudgeListener(call('read', { file_path: `/w-more-${i}.txt` }, sessionId), { ok: true }, accept)
    const contexts = decision !== null && Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    for (const message of contexts) {
      const content = message !== null && message !== undefined ? message.content : undefined
      if (Array.isArray(content)) pushed.push(content.map((b) => (b !== null && typeof b.text === 'string' ? b.text : '')).join(''))
    }
  }
  assert.equal(pushed.length, NUDGE_MAX_LEVEL, `一直只读时每个节拍各催一次（共 ${NUDGE_MAX_LEVEL} 次）`)
  assert.ok(pushed.some((one) => one.includes('不许再调')), '第二次催必须是硬文案（禁掉只读工具）')
  ok(`接线：一直只读时每个节拍都催（${NUDGE_MAX_LEVEL} 次），第二次起禁只读`)

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

  // 守卫自证：**未到节拍**不许催（否则每步都催，催促会变成噪音源）。
  resetNudge()
  clearNudge(sessionId)
  let earlyInjected = 0
  for (let i = 1; i < NUDGE_EVERY; i += 1) {
    const decision = await nudgeListener(call('read', { file_path: `/early${i}.txt` }, sessionId), { ok: true }, accept)
    const contexts = decision !== null && Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    earlyInjected += contexts.length
  }
  assert.equal(earlyInjected, 0, `未到 ${NUDGE_EVERY} 的倍数时一步都不许催`)
  ok(`守卫自证：未到节拍（前 ${NUDGE_EVERY - 1} 步）不被催`)

  // 守卫自证：工具失败（block）时不插话——失败重试是正当行为，不是磨蹭。
  resetNudge()
  clearNudge(sessionId)
  let blockedInjected = 0
  for (let i = 0; i < NUDGE_EVERY + 2; i += 1) {
    const decision = await nudgeListener(call('read', { file_path: `/bad${i}.txt` }, sessionId), { ok: false }, async () => ({ kind: 'block' }))
    const contexts = decision !== null && Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    blockedInjected += contexts.length
  }
  assert.equal(blockedInjected, 0, '工具失败（block）时不催')
  ok('守卫自证：工具失败时不插话')

  console.log(`\n催促（每 ${NUDGE_EVERY} 步一次）： ${passed} 通过 / 0 失败`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
