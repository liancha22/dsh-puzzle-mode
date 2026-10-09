/**
 * 工具入参形状 + 文件观察守卫 + 注入闸门测试。
 *
 *   node test/160-toolargs-fsguard.test.mjs
 *
 * ## 为什么这一组必须存在
 *
 * 集成 `dsh-cot-guard` 时**顺手发现了拼图插件自己的一个真缺陷**：
 * 五处把 `exec.arguments` 当对象读，而真实形状是**字符串**。
 *
 * 证据（2026-10-08 会话日志，逐条数出来的）：
 * ```
 * tool/call 共 248 条：arguments 是字符串 248 条，对象 0 条
 * ```
 *
 * 后果不是报错，是**静默失效**：「只拼不写拦截」认不出任何一次真实调用、
 * 工作流触发命中不了文件路径关键词、熔断签名恒为空、催促拿不到 file_path。
 * 四处都有测试、都全绿——因为**测试用的是对象**（照着类型想象写的）。
 *
 * 所以这一组的第一条判据是：**喂字符串**（真实形状）必须能解析出来，
 * 同时喂对象也要能（防宿主将来改形状）。
 */
import assert from 'node:assert/strict'
// **必须最先**：隔离 DSH_HOME（本组会读全局设置判断会话是否禁用）。
import './helpers/isolate-home.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DECISION_DENSE_THRESHOLD,
  INJECT_ALWAYS,
  INJECT_BUDGET_PER_TURN,
  INJECT_COOLDOWN_STEPS,
  INJECT_REASON_BUDGET,
  INJECT_REASON_COOLDOWN,
  INJECT_SELF_PACED,
  STALE_AFTER_STEPS,
  countDecisions,
  denseDecisionText,
  docTargetOf,
  errorCodeOf,
  fsGuardLogOf,
  fsGuardStatsOf,
  injectGateOf,
  isStaleCode,
  noteProgress,
  noteReasoning,
  noteStepStart,
  noteToolCall,
  preEditText,
  preWriteText,
  requestInject,
  resetFsGuard,
  resetInjectGate,
  retryText,
  toolArgs,
} from '../lib/puzzle.js'

let host
try {
  host = await import('../lib/index.js')
} catch (error) {
  const code = error === null || error === undefined ? undefined : error.code
  console.log(`skip 160-toolargs-fsguard.test.mjs：${code === 'ERR_MODULE_NOT_FOUND' ? '找不到 @deepseek-ai/dsh-tools（本目录未装进 DSH profile），跳过' : String(error && error.message ? error.message : error)}`)
  process.exit(0)
}

const root = mkdtempSync(join(tmpdir(), 'puzzle-args-'))
let passed = 0

function ok(name) {
  passed += 1
  console.log(`ok   ${name}`)
}

try {
  /* ---------------- 工具入参形状（这轮最值钱的一条） ---------------- */

  // **真实形状**：字符串。这是从会话日志里数出来的，不是想象的。
  const realShape = '{"file_path":"D:\\\\ws\\\\拼图\\\\主文档.md","content":"x"}'
  const fromString = toolArgs(realShape)
  assert.equal(fromString.file_path, 'D:\\ws\\拼图\\主文档.md', '**字符串**入参必须能解析出 file_path（真实形状）')
  // 同时认对象（防宿主将来改成对象时这五处再次静默失效）。
  const fromObject = toolArgs({ file_path: '/a/b.md' })
  assert.equal(fromObject.file_path, '/a/b.md', '对象入参也要能读（防形状漂移）')
  // 坏输入一律安静降级成空对象——读不懂参数绝不能让工具结果变错。
  assert.deepEqual(toolArgs(null), {}, 'null → 空对象')
  assert.deepEqual(toolArgs(undefined), {}, 'undefined → 空对象')
  assert.deepEqual(toolArgs(''), {}, '空串 → 空对象')
  assert.deepEqual(toolArgs('{坏 JSON'), {}, '坏 JSON → 空对象（不抛错）')
  assert.deepEqual(toolArgs('[1,2]'), {}, '数组 → 空对象（不是合法入参）')
  assert.deepEqual(toolArgs(42), {}, '数字 → 空对象')
  ok('入参解析：字符串（真实形状）与对象都认，坏输入安静降级')

  /**
   * **核心回归守卫**：拿真实形状喂 `docTargetOf`，必须认出「在动拼图文档」。
   *
   * 这条就是那个 bug 的守卫——修之前它是 `null`（因为按对象读字符串），
   * 于是「只拼不写拦截」从来没生效过。把它改回去这条会红。
   */
  const docPath = join(root, '项目', '拼图', '主文档.md')
  const asString = JSON.stringify({ file_path: docPath })
  assert.equal(docTargetOf('write', asString), docPath,
    '**字符串**入参 + 拼图文档路径 → 必须认出来（修之前这里返回空串，拦截形同虚设）')
  assert.equal(docTargetOf('edit', asString), docPath, 'edit 同样要认出来')
  assert.equal(docTargetOf('read', asString), '', '读文档不算「动文档」（那是「只拼」的一部分）')
  assert.equal(docTargetOf('write', JSON.stringify({ file_path: join(root, '普通文件.md') })), '',
    '普通文件不该被当成拼图文档')
  ok('回归守卫：字符串入参下的「只拼不写」判定真的生效（修前是空串）')

  /* ---------------- FS 错误码形状 ---------------- */

  // 真实钩子形状：码在 `error.info.code` 里（不在顶层）——cot-guard 为此踩过一次假绿。
  assert.equal(errorCodeOf({ error: { message: 'x', info: { name: 'FsError', code: 'FS_STALE_VERSION' } } }),
    'FS_STALE_VERSION', '码在 error.info.code 里（真实钩子形状）')
  // 日志形状也认（离线回放脚本直接喂事件）。
  assert.equal(errorCodeOf({ error: { code: 'FS_NOT_OBSERVED' } }), 'FS_NOT_OBSERVED', '日志形状也认')
  assert.equal(errorCodeOf({ error: null }), null, '没有错误 → null')
  assert.equal(errorCodeOf({}), null, '缺 error → null')
  assert.equal(errorCodeOf({ error: { message: 'no code' } }), null, '没有码 → null')
  assert.equal(isStaleCode('FS_STALE_VERSION'), true, 'FS_STALE_VERSION 是观察失效类')
  assert.equal(isStaleCode('FS_NOT_OBSERVED'), true, 'FS_NOT_OBSERVED 是观察失效类')
  assert.equal(isStaleCode('FS_IO_ERROR'), false, 'FS_IO_ERROR **不是**观察失效类（read 治不了它）')
  ok('FS 错误码：两种形状都认（含真实钩子的 error.info.code）')

  /* ---------------- 决定密度 ---------------- */

  assert.equal(DECISION_DENSE_THRESHOLD, 8, '决定密度阈值 = 8（离线回放扫出来的）')
  assert.equal(countDecisions('Decision: a\nDecision: b'), 2, '数得出决定宣告')
  // ⚠️ 尾随 `\b` 会让 `Decision: ` 永远匹配不到（冒号是非单词字符）——实测踩过。
  assert.equal(countDecisions('Decision: x'), 1, '`Decision:` 以冒号结尾也要数得到（尾随 \\b 的坑）')
  assert.equal(countDecisions('Settled: y'), 1, '`Settled:` 同理')
  assert.equal(countDecisions(''), 0, '空串 → 0')
  assert.equal(countDecisions(null), 0, '非字符串 → 0')
  // 正则带 g，必须重置 lastIndex，否则跨调用会漏计。
  const once = countDecisions('Decision: a')
  const twice = countDecisions('Decision: a')
  assert.equal(once, twice, '连续两次调用结果必须一致（lastIndex 必须重置）')
  ok('决定计数：`Decision:` 冒号结尾也数得到，且连续调用不漏计')

  /* ---------------- 文案 ---------------- */

  const retry = retryText('/a/b.md')
  assert.ok(retry.includes('/a/b.md'), '重试提示点名文件')
  assert.ok(retry.includes('98.3%'), '重试提示给出实测成功率（这是它唯一的说服力）')
  assert.ok(retry.includes('0%'), '重试提示给出反面对照')
  const preWrite = preWriteText('/a/b.md', 7)
  assert.ok(preWrite.includes('7'), '预防提示给出「几步之前」')
  assert.ok(preWrite.includes('32.0%'), '预防提示给出实测报错率')
  assert.ok(!preWrite.includes('必须'), '预防是「可能」，不下「必须」（观察表可能不同步）')
  const preEdit = preEditText('/a/b.md')
  assert.ok(preEdit.includes('先 `read`'), '「没查证就动手」的纠正要给出动作')
  assert.ok(preEdit.includes('同一条事实的两种说法'), '要说清它**不是**预测（避免被当成玄学）')
  const dense = denseDecisionText(9, 2)
  assert.ok(dense.includes('9'), '决定密度提示给出次数')
  assert.ok(dense.includes('刚才那一步'), '时态必须是「刚才那一步」（additionalContexts 下一步才被读到）')
  assert.ok(dense.includes('8.6%'), '给出实测报错率差 3 倍')
  ok('四条文案：都带实测数字，且时态/语气各按自己的语义写')

  /* ---------------- 观察表与触发 ---------------- */

  assert.equal(STALE_AFTER_STEPS, 5, '过期阈值 = 5（离线回放扫出来的，不是按报错率最高挑的）')
  resetFsGuard()
  const S = 'session-fs'

  // read 之后短间隔内不改：不该提示。
  noteStepStart(S, 1)
  noteToolCall(S, 'read', { file_path: '/x.md' }, { ok: true })
  noteStepStart(S, 2)
  let note = noteToolCall(S, 'edit', { file_path: '/x.md' }, { ok: true })
  assert.equal(note.kind, '', '刚读过就改：不提示（gap 0–5 是安全区，报错率只有 9.4%）')
  ok('刚读过就改不提示（gap 0–5 是安全区）')

  // 隔够了再改：提示「过期」。
  resetFsGuard()
  noteStepStart(S, 1)
  noteToolCall(S, 'read', { file_path: '/y.md' }, { ok: true })
  noteStepStart(S, 1 + STALE_AFTER_STEPS)
  note = noteToolCall(S, 'edit', { file_path: '/y.md' }, { ok: true })
  assert.equal(note.kind, 'pre-write', `隔 ${STALE_AFTER_STEPS} 步再改要提示`)
  assert.ok(note.text.includes('/y.md'), '提示点名文件')
  ok(`隔 ${STALE_AFTER_STEPS} 步再改 → 提示「观察记录可能失效」`)

  // 同一文件同一档只提示一次。
  noteStepStart(S, 1 + STALE_AFTER_STEPS * 2)
  const again = noteToolCall(S, 'edit', { file_path: '/y.md' }, { ok: true })
  assert.equal(again.kind, '', '同一文件同一档只提示一次（否则每次编辑都刷一条）')
  ok('同一文件同一档只提示一次')

  // 写被拒（FS_STALE_VERSION）→ 注入「先 read 再重试」。
  resetFsGuard()
  noteStepStart(S, 1)
  noteToolCall(S, 'read', { file_path: '/z.md' }, { ok: true })
  const stale = noteToolCall(S, 'edit', { file_path: '/z.md' },
    { error: { message: 'stale', info: { code: 'FS_STALE_VERSION' } } })
  assert.equal(stale.kind, 'retry', '写被拒 → 注入重试提示（唯一有对照组的动作）')
  assert.ok(stale.text.includes('先 `read`'), '重试提示要说清先 read')
  ok('写被拒 → 注入「先 read 再重试」')

  // `FS_NOT_OBSERVED` + edit + 从未观察 → 附带「没查证就动手」。
  resetFsGuard()
  noteStepStart(S, 1)
  const never = noteToolCall(S, 'edit', { file_path: '/never.md' },
    { error: { message: 'x', info: { code: 'FS_NOT_OBSERVED' } } })
  assert.equal(never.kind, 'retry', '仍未观察 → 还是先给重试提示')
  assert.ok(Array.isArray(never.extra) && never.extra.length === 1, '附带一条「没查证就动手」')
  assert.equal(never.extra[0].kind, 'pre-edit', '附带的是 pre-edit')
  // 只对 edit：write 新建文件本就没有观察记录，说它「没查证」不准确。
  resetFsGuard()
  noteStepStart(S, 1)
  const writeNever = noteToolCall(S, 'write', { file_path: '/new.md' },
    { error: { message: 'x', info: { code: 'FS_NOT_OBSERVED' } } })
  assert.equal(writeNever.kind, 'retry', 'write 也给重试提示')
  assert.ok(!Array.isArray(writeNever.extra) || writeNever.extra.length === 0,
    'write 不附带「没查证」（新建文件本来就没观察记录）')
  ok('FS_NOT_OBSERVED + edit → 附带行为纠正；write 不附带（避免误报）')

  // 成功的写**自己也会登记 fs/observed**，所以观察表要同步刷新——否则会误报。
  //
  // ⚠️ 间隔要取**小于阈值**：`STALE_AFTER_STEPS` 是「≥5 就算过期」，
  // 所以隔 5 步本来就**应该**提示（那正是它要拦的那一档，报错率 32.0%）。
  // 第一版这里用了 `1 + STALE_AFTER_STEPS` 去验「不该提示」，是把阈值当成了「>5」，
  // 于是断言本身写错、红的是测试而不是实现。
  resetFsGuard()
  noteStepStart(S, 1)
  noteToolCall(S, 'write', { file_path: '/fresh.md' }, { ok: true })
  noteStepStart(S, STALE_AFTER_STEPS) // 距上次观察 4 步（5 - 1），在安全区内
  const afterWrite = noteToolCall(S, 'edit', { file_path: '/fresh.md' }, { ok: true })
  assert.equal(afterWrite.kind, '', '刚成功写过的文件在安全区内不该被提示（宿主写成功后也会登记观察）')
  // 反证：若观察表**没有**刷新，隔 4 步就会被判成「过期」而提示。
  // 所以先单独验「写那一步确实刷新了观察时间」——不然上面那条可能是因为别的原因过的。
  resetFsGuard()
  noteStepStart(S, 1)
  noteToolCall(S, 'write', { file_path: '/stamp.md' }, { ok: true })
  assert.equal(fsGuardLogOf(S).readAt.get('/stamp.md'), 1,
    '成功的写要把观察时间记在**那一步**（宿主写成功后也会 emit fs/observed）')
  // 再验：那次 edit 成功后，观察时间又推进到 edit 那一步（每次成功写都刷新）。
  noteStepStart(S, 5)
  noteToolCall(S, 'edit', { file_path: '/stamp.md' }, { ok: true })
  assert.equal(fsGuardLogOf(S).readAt.get('/stamp.md'), 5, 'edit 成功后观察时间推进到 edit 那一步')
  ok('成功的写也刷新观察表（否则刚改过的文件会被误报）')

  // 决定过密：借**下一个工具结果**注入一次，然后作废。
  resetFsGuard()
  noteStepStart(S, 1)
  noteReasoning(S, Array.from({ length: DECISION_DENSE_THRESHOLD }, () => 'Decision: x').join('\n'))
  const denseNote = noteToolCall(S, 'read', { file_path: '/d.md' }, { ok: true })
  assert.equal(denseNote.kind, 'dense', `决定 ≥${DECISION_DENSE_THRESHOLD} 次 → 借下一个工具结果注入`)
  assert.ok(denseNote.text.includes('刚才那一步'), '时态说「刚才那一步」')
  const afterDense = noteToolCall(S, 'read', { file_path: '/d.md' }, { ok: true })
  assert.equal(afterDense.kind, '', '注入过一次就作废（不跨步补发）')
  // 落空作废：本步没工具结果，下一步不该补发。
  noteStepStart(S, 2)
  noteReasoning(S, Array.from({ length: DECISION_DENSE_THRESHOLD }, () => 'Decision: x').join('\n'))
  noteStepStart(S, 3)
  const nextStep = noteToolCall(S, 'read', { file_path: '/d.md' }, { ok: true })
  assert.equal(nextStep.kind, '', '跨步之后作废（补发时上下文已经变了）')
  ok('决定过密：借下一个工具结果注入一次，跨步作废不补发')

  assert.equal(fsGuardStatsOf(S).dense, 1, '统计记下注入次数')
  assert.notEqual(fsGuardLogOf(S), null, '观察表可读（诊断用）')
  ok('守卫状态可读（统计 + 观察表）')

  /* ---------------- 注入闸门（用户裁定「一起降低注入频次」） ---------------- */

  assert.equal(INJECT_BUDGET_PER_TURN, 2, '一轮最多 2 条注入')
  assert.equal(INJECT_COOLDOWN_STEPS, 6, '同类冷却 6 步')
  assert.ok(INJECT_ALWAYS.includes('retry'), '「先 read 再重试」永远放行（唯一有对照组的动作）')
  assert.ok(INJECT_ALWAYS.includes('speech'), '说话纠正永远放行（治的是本轮已发生的事实错误）')
  assert.ok(INJECT_SELF_PACED.includes('loop'), '熔断豁免同类冷却（它自带 3 步升级节奏）')
  assert.ok(INJECT_SELF_PACED.includes('nudge'), '催促豁免同类冷却（它自带 6 步节拍）')
  ok('闸门常量：预算 2 条 / 冷却 6 步 / 永远放行 2 类 / 自带节流 2 类')

  // **核心**：无轮信息时**不许拦**——信息不足时拦会把功能弄失效。
  resetInjectGate()
  for (let i = 0; i < 10; i += 1) {
    const r = requestInject('gate-1', 'workflow')
    assert.equal(r.allow, true, `无轮信息时第 ${i + 1} 次也必须放行（信息不足时拦 = 功能失效）`)
  }
  ok('无轮信息时不拦（信息不足时拦会把功能弄失效）')

  // 有轮信息时：预算真的生效。
  resetInjectGate()
  noteProgress('gate-2', { turn: 1, step: 1 })
  const first = requestInject('gate-2', 'workflow')
  const second = requestInject('gate-2', 'pre-write')
  const third = requestInject('gate-2', 'dense')
  assert.equal(first.allow, true, '第 1 条放行')
  assert.equal(second.allow, true, '第 2 条放行')
  assert.equal(third.allow, false, `第 ${INJECT_BUDGET_PER_TURN + 1} 条被预算拦下`)
  assert.equal(third.reason, INJECT_REASON_BUDGET, '原因是预算')
  ok(`有轮信息时一轮最多放行 ${INJECT_BUDGET_PER_TURN} 条`)

  // 换轮 → 额度清零。
  noteProgress('gate-2', { turn: 2, step: 8 })
  assert.equal(requestInject('gate-2', 'workflow').allow, true, '换轮之后额度清零')
  ok('换轮后额度清零（预算的单位是轮）')

  // 同类冷却（有轮信息时）。
  resetInjectGate()
  noteProgress('gate-3', { turn: 1, step: 1 })
  assert.equal(requestInject('gate-3', 'pre-write').allow, true, '同类第一次放行')
  noteProgress('gate-3', { turn: 1, step: 2 })
  const cooled = requestInject('gate-3', 'pre-write')
  assert.equal(cooled.allow, false, '同类在冷却窗口内被拦')
  assert.equal(cooled.reason, INJECT_REASON_COOLDOWN, '原因是冷却')
  noteProgress('gate-3', { turn: 1, step: 1 + INJECT_COOLDOWN_STEPS })
  assert.equal(requestInject('gate-3', 'pre-write').allow, true, `隔 ${INJECT_COOLDOWN_STEPS} 步后重新放行`)
  ok(`同类冷却 ${INJECT_COOLDOWN_STEPS} 步（隔够就重新放行）`)

  // 永远放行的两类不占预算、不受冷却。
  resetInjectGate()
  noteProgress('gate-4', { turn: 1, step: 1 })
  for (let i = 0; i < 5; i += 1) {
    assert.equal(requestInject('gate-4', 'retry').allow, true, `retry 第 ${i + 1} 次永远放行`)
  }
  assert.equal(injectGateOf('gate-4').used, 0, '永远放行的不占预算')
  ok('「先 read 再重试」永远放行且不占预算')

  // 自带节流的豁免冷却，但仍占预算（轮预算防的是「一轮里塞好几条不同的」）。
  resetInjectGate()
  noteProgress('gate-5', { turn: 1, step: 1 })
  assert.equal(requestInject('gate-5', 'loop').allow, true, '熔断第 1 次放行')
  noteProgress('gate-5', { turn: 1, step: 2 })
  assert.equal(requestInject('gate-5', 'loop').allow, true, '熔断第 2 次放行（豁免冷却——它自带 3 步升级节奏）')
  noteProgress('gate-5', { turn: 1, step: 3 })
  assert.equal(requestInject('gate-5', 'loop').allow, false, '但轮预算仍然管着它（一轮 2 条）')
  ok('自带节流的种类：豁免冷却，但仍占轮预算')

  /* ---------------- 接线层：真钩子 ---------------- */

  const listeners = []
  host.apply({
    systemPrompt: { section() {} },
    tools: { register() { return () => {} } },
    on(event, fn) { if (event === 'tools/post-execute') listeners.push(fn); return () => {} },
    inject() {},
    effect() {},
    get(name) {
      if (name !== 'sessions') return undefined
      return { get(id) { return typeof id === 'string' && id !== '' ? { header: { cwd: root } } : undefined } }
    },
  })
  assert.ok(listeners.length >= 4, `要有至少 4 个 post-execute 钩子（实际 ${listeners.length}）`)

  const W = 'session-wire-fs'
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

  /** 找文件观察守卫那个钩子：只有它会注入带「先 `read` 再重放」的文本。 */
  let fsListener = null
  for (const listener of listeners) {
    resetFsGuard()
    resetInjectGate()
    const exec = {
      callId: 'c1', name: 'edit',
      // **真实形状**：字符串入参。
      arguments: JSON.stringify({ file_path: join(root, 'never-read.md') }),
      agent: { id: W }, signal: { aborted: false },
    }
    const decision = await listener(exec, { error: { message: 'x', info: { code: 'FS_NOT_OBSERVED' } } }, accept)
    const texts = (decision !== null && Array.isArray(decision.additionalContexts) ? decision.additionalContexts : [])
      .map((m) => (Array.isArray(m.content) ? m.content.map((b) => (typeof b.text === 'string' ? b.text : '')).join('') : ''))
    if (texts.some((one) => one.includes('先 `read` 再重放') || one.includes('观察记录已失效'))) { fsListener = listener; break }
  }
  assert.notEqual(fsListener, null, '必须有钩子在写被拒时注入「先 read 再重试」（用**字符串**入参驱动）')
  ok('接线：写被拒时真的注入了「先 read 再重试」（字符串入参）')

  // 端到端：read → 隔 5 步 → edit，必须出现预防提示。
  resetFsGuard()
  resetInjectGate()
  const cwdRoot = root
  await fire(fsListener, {
    callId: 'c2', name: 'read',
    arguments: JSON.stringify({ file_path: join(cwdRoot, 'warm.md') }),
    agent: { id: W }, signal: { aborted: false },
  })
  // 直接把步号推到 5 步之后（接线层拿不到 step/start，用导出函数推进）。
  noteStepStart(W, 1 + STALE_AFTER_STEPS)
  const preTexts = await fire(fsListener, {
    callId: 'c3', name: 'edit',
    arguments: JSON.stringify({ file_path: join(cwdRoot, 'warm.md') }),
    agent: { id: W }, signal: { aborted: false },
  })
  assert.ok(preTexts.some((one) => one.includes('步之前')), '隔 5 步再改 → 真实钩子上要出现预防提示')
  ok('接线：隔 5 步再改 → 真实钩子注入预防提示')

  console.log(`\n工具入参 / 文件观察守卫 / 注入闸门： ${passed} 通过 / 0 失败`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
