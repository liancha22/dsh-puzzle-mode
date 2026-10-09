/**
 * 工作流注入去重测试：纯函数层 + 真钩子接线层。
 *
 *   node test/120-workflowguard.test.mjs
 *
 * ## 为什么要有这一组
 *
 * 用户原话：「工作流注入去重，加最小注入间隔」。
 * 改之前，**每一次**工具调用都会重新注入一遍命中的流程——连着改同一类文件，
 * 同一份 11 步流程被原样塞进上下文十遍。代价不只是浪费：同一段规则刷屏之后，
 * 模型会开始**忽略**它。
 *
 * ## 判据是两条，缺一不可
 *
 *   1. **命中集合没变 → 不重复注入**（治刷屏）；
 *   2. **换了阶段（命中集合变了）→ 立刻重新注入**（不漏关键时刻）。
 *
 * 只验第 1 条的测试会把「干脆永远不注入」判成通过——那是另一种错，而且更隐蔽
 * （规则静默失效，没人报错）。所以下面**必须**同时有「隔够了要重新注入」与
 * 「集合变了立刻注入」的断言。
 *
 * ## 断言为什么引常量
 *
 * 按本仓约定（`~/.dsh/AGENTS.md` 第 0.1 节）：阈值取 `WORKFLOW_MIN_INTERVAL`
 * 而不是写死 6。这样改上限时测试自动跟上，而**行为变了**（比如去重失效）照样红。
 */
import assert from 'node:assert/strict'
// **必须最先**：隔离 DSH_HOME（本钩子会读全局设置判断会话是否被禁用）。
import './helpers/isolate-home.mjs'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WORKFLOW_MARK,
  WORKFLOW_MIN_INTERVAL,
  WORKFLOW_REASON_DEDUPED,
  WORKFLOW_REASON_FIRST,
  WORKFLOW_REASON_INTERVAL,
  clearWorkflowGuard,
  noteWorkflowTrigger,
  resetWorkflowGuard,
  workflowGuardStateOf,
  workflowSignature,
  workflowSkipText,
} from '../lib/puzzle.js'

let host
try {
  host = await import('../lib/index.js')
} catch (error) {
  const code = error === null || error === undefined ? undefined : error.code
  console.log(`skip 120-workflowguard.test.mjs：${code === 'ERR_MODULE_NOT_FOUND' ? '找不到 @deepseek-ai/dsh-tools（本目录未装进 DSH profile），跳过' : String(error && error.message ? error.message : error)}`)
  process.exit(0)
}

const root = mkdtempSync(join(tmpdir(), 'puzzle-wfg-'))
let passed = 0

function ok(name) {
  passed += 1
  console.log(`ok   ${name}`)
}

/**
 * 建一个带工作流的项目（钩子要从主文档里读 `## 工作流`）。
 *
 * `会话:` / `当前会话:` 是 **JSON 字符串数组**（`parseSessionList` 按 JSON 解析，
 * 裸字符串会被整条丢掉 → 绑定为空 → 钩子一条都不注入）。写错这里会让接线层
 * **静默通过**：「没注入」看起来像「去重生效」。
 *
 * 触发词用 `lib`（不带斜杠）：`workflowsTriggeredBy` 是**子串**匹配，
 * 而 Windows 上路径是反斜杠（`...\lib\a.js`），写 `lib/` 永远匹配不上。
 * 这不是测试取巧——主题仓库的 `index.json` 与真实工作流的触发词同样要注意这点。
 */
function makeProject(name, workflows, sessionId) {
  const dir = join(root, name, '拼图')
  mkdirSync(dir, { recursive: true })
  const blocks = workflows.map((item) => [
    `### ${item.name}`,
    `触发: ${item.trigger}`,
    ...item.steps.map((step, index) => `${index + 1}. ${step}`),
  ].join('\n'))
  const text = [
    '---',
    `会话: ${JSON.stringify([sessionId])}`,
    `当前会话: ${JSON.stringify([sessionId])}`,
    'puzzle: 7',
    '规模: 小',
    '模式: 写后再拼',
    '---',
    '',
    '> 目标：测试',
    '',
    '## 模块索引',
    '',
    '## 源码索引',
    '',
    '## 工具索引',
    '',
    '## 坑',
    '',
    '## 工作流',
    '',
    ...blocks,
    '',
  ].join('\n')
  writeFileSync(join(dir, '主文档.md'), text, 'utf8')
  return join(root, name)
}

/** 摘出宿主半注册的 tools/post-execute 监听器。 */
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

function call(name, args = {}, id = 'session-wfg') {
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
  /* ---------------- 纯函数层：签名 ---------------- */

  // 空集合 → 空签名（调用方据此放行，这一步不算一次注入）。
  assert.equal(workflowSignature([]), '', '空集合的签名是空串')
  assert.equal(workflowSignature(null), '', '非数组安全降级')

  // **顺序不该影响判定**：同一个集合以不同顺序算出来必须是同一个签名，
  // 否则「没变」会被误判成「变了」，去重当场失效。
  const a = [{ project: 'P', blocks: [{ name: '甲' }, { name: '乙' }] }]
  const b = [{ project: 'P', blocks: [{ name: '乙' }, { name: '甲' }] }]
  assert.equal(workflowSignature(a), workflowSignature(b), '块顺序不同 → 同一个签名')
  ok('签名与块顺序无关（同一集合必须判成「没变」）')

  // 多项目也是排序的：顺序不同同样是同一个签名。
  const two = [
    { project: 'P2', blocks: [{ name: '丙' }] },
    { project: 'P1', blocks: [{ name: '甲' }] },
  ]
  const twoSwapped = [
    { project: 'P1', blocks: [{ name: '甲' }] },
    { project: 'P2', blocks: [{ name: '丙' }] },
  ]
  assert.equal(workflowSignature(two), workflowSignature(twoSwapped), '项目顺序不同 → 同一个签名')
  ok('签名与项目顺序无关（多绑定场景）')

  // 集合变了 → 签名必须变（这是「换了阶段立刻重新注入」的判据基础）。
  const changed = [{ project: 'P', blocks: [{ name: '甲' }] }]
  assert.notEqual(workflowSignature(a), workflowSignature(changed), '少一条工作流 → 签名必须变')
  ok('命中集合变了 → 签名变（新阶段能被认出来）')

  /* ---------------- 纯函数层：去重规则 ---------------- */

  assert.equal(WORKFLOW_MIN_INTERVAL, 6, `最小注入间隔为 6 步（当前 ${WORKFLOW_MIN_INTERVAL}）`)
  ok(`最小注入间隔 = ${WORKFLOW_MIN_INTERVAL} 步`)

  const sig = workflowSignature(a)

  // 第一次见 → 注入。
  resetWorkflowGuard()
  const first = noteWorkflowTrigger('s1', sig)
  assert.equal(first.inject, true, '第一次命中 → 注入')
  assert.equal(first.reason, WORKFLOW_REASON_FIRST, '原因是「第一次见」')
  assert.equal(first.steps, 1, '步数从 1 起')
  ok('第一次命中 → 注入（原因 first）')

  // **核心断言 ①**：紧接着的每一步都是同一个签名 → 全部跳过。
  const skipped = []
  for (let i = 0; i < WORKFLOW_MIN_INTERVAL - 1; i += 1) {
    const step = noteWorkflowTrigger('s1', sig)
    skipped.push(step.inject)
    if (!step.inject) assert.equal(step.reason, WORKFLOW_REASON_DEDUPED, '跳过时原因要说清是去重')
  }
  assert.deepEqual(skipped, Array.from({ length: WORKFLOW_MIN_INTERVAL - 1 }, () => false),
    `紧接着的 ${WORKFLOW_MIN_INTERVAL - 1} 步必须全部跳过（去重生效）`)
  ok(`命中集合没变 → 紧接着的 ${WORKFLOW_MIN_INTERVAL - 1} 步都不重复注入`)

  // **核心断言 ②**：隔够了 → 重新注入（否则规则在长会话里静默失效）。
  const again = noteWorkflowTrigger('s1', sig)
  assert.equal(again.inject, true, `隔满 ${WORKFLOW_MIN_INTERVAL} 步后要重新注入`)
  assert.equal(again.reason, WORKFLOW_REASON_INTERVAL, '原因是「隔够了」')
  assert.equal(again.gap, WORKFLOW_MIN_INTERVAL, `间隔应为 ${WORKFLOW_MIN_INTERVAL}`)
  ok(`隔满 ${WORKFLOW_MIN_INTERVAL} 步 → 重新注入（不是永远只注入一次）`)

  // **核心断言 ③**：换了阶段（签名变了）→ 立刻注入，不等间隔。
  resetWorkflowGuard()
  noteWorkflowTrigger('s2', sig)
  const other = workflowSignature(changed)
  const switched = noteWorkflowTrigger('s2', other)
  assert.equal(switched.inject, true, '命中集合一变就立刻注入（换阶段不能等）')
  assert.equal(switched.reason, WORKFLOW_REASON_FIRST, '这个签名是第一次见 → first')
  ok('换了阶段（命中集合变了）→ 立刻重新注入')

  // 来回横跳：A → B → A。A 刚注入过，回到 A 也要被挡住——
  // 否则 A、B 交替命中时每一步都注入，比去重之前还吵。
  resetWorkflowGuard()
  noteWorkflowTrigger('s3', sig)      // 第 1 步：注入 A
  noteWorkflowTrigger('s3', other)    // 第 2 步：注入 B
  const back = noteWorkflowTrigger('s3', sig) // 第 3 步：回到 A
  assert.equal(back.inject, false, '横跳回刚注入过的集合 → 挡住（不然每步都注入）')
  assert.equal(back.reason, WORKFLOW_REASON_DEDUPED, '原因同样是去重')
  ok('来回横跳被挡住（A→B→A 不刷屏）')

  // 没命中任何流程：只推进步数，不产生注入，也不该把间隔算乱。
  resetWorkflowGuard()
  noteWorkflowTrigger('s4', sig)
  const none = noteWorkflowTrigger('s4', '')
  assert.equal(none.inject, false, '没命中 → 不注入')
  assert.equal(none.steps, 2, '没命中也要推进步数（间隔的分母）')
  /**
   * **没命中不能计入「注入次数」**。
   *
   * 这条是变异验证抓出来的：把 `injected + 1` 挪进「没命中」那条分支，
   * 原先的断言**全部照绿**——因为没有任何断言看过 `injected`。
   * 那个字段是面板/诊断用来说明「这条规则到底生效了几次」的，
   * 虚高就等于告诉用户「注入过了」而其实没有。
   */
  assert.equal(workflowGuardStateOf('s4').injected, 1, '没命中的步不该被算成一次注入')
  ok('没命中任何流程时只推进步数（间隔分母不丢，且不计入注入次数）')

  // 步数是间隔的分母：中间夹着「没命中」的步，间隔照样要算对。
  resetWorkflowGuard()
  noteWorkflowTrigger('s5', sig)
  for (let i = 0; i < WORKFLOW_MIN_INTERVAL - 1; i += 1) noteWorkflowTrigger('s5', '')
  const afterIdle = noteWorkflowTrigger('s5', sig)
  assert.equal(afterIdle.inject, true, '中间空转的步也要计入间隔')
  ok('中间没命中的步计入间隔（分母是「走了几步」而不是「命中几次」）')

  // 会话隔离：两个会话各算各的。
  resetWorkflowGuard()
  noteWorkflowTrigger('sA', sig)
  const otherSession = noteWorkflowTrigger('sB', sig)
  assert.equal(otherSession.inject, true, '别的会话第一次见 → 注入（互不串味）')
  assert.equal(otherSession.steps, 1, '别的会话步数从 1 起')
  ok('去重状态按会话隔离')

  // 空 sessionId 安全降级：不崩、不落表。
  resetWorkflowGuard()
  assert.equal(noteWorkflowTrigger('', sig).inject, false, '没有 sessionId 时不注入')
  assert.equal(workflowGuardStateOf(''), null, '空 sessionId 不落表')
  ok('空 sessionId 安全降级')

  // clearWorkflowGuard 要能真的清掉。
  resetWorkflowGuard()
  noteWorkflowTrigger('s6', sig)
  assert.notEqual(workflowGuardStateOf('s6'), null, '记过之后有状态')
  clearWorkflowGuard('s6')
  assert.equal(workflowGuardStateOf('s6'), null, 'clearWorkflowGuard 之后状态没了')
  ok('clearWorkflowGuard 清得掉状态')

  // 跳过时的说明文案：给面板/日志看，**不进上下文**（进上下文就等于把噪音加回去）。
  const skipText = workflowSkipText(WORKFLOW_REASON_DEDUPED, 2, sig)
  assert.ok(skipText.includes(WORKFLOW_MARK), '跳过说明带标记')
  assert.equal(workflowSkipText(WORKFLOW_REASON_FIRST, 0, sig), '', '不是「跳过」时不产生说明')
  ok('跳过说明只在去重时产生')

  /* ---------------- 接线层：真钩子驱动 ---------------- */

  const sessionId = 'session-wfg-wire'

  /**
   * **两个项目都要在第一次调用之前建好。**
   *
   * `boundProjects` 有 1 秒 TTL 的绑定记忆（`BOUND_TTL_HIT`，见 `lib/project.js` 文件头：
   * 为「每次工具调用白交 10ms 以上」做的优化，且明确写下了代价——手工改文档时
   * 绑定可见性最多延后一个 TTL）。若先跑几轮再建乙项目，**同一秒内**它是看不见的，
   * 「换阶段」那条断言会假红。这是已文档化的取舍，所以测试顺着它写。
   */
  makeProject('甲项目', [
    { name: '改动后验证', trigger: 'lib, test, npm test', steps: ['跑语法检查', '跑 npm test'] },
  ], sessionId)
  makeProject('乙项目', [
    { name: '另一条流程', trigger: 'special-target', steps: ['只在这一条里出现的步骤'] },
  ], sessionId)

  const listeners = captureListeners()
  assert.ok(listeners.length >= 1, '必须注册 tools/post-execute 监听器')

  /** 找出工作流触发那个钩子：只有它会注入带工作流标记的上下文。 */
  let wfListener = null
  for (const listener of listeners) {
    resetWorkflowGuard()
    clearWorkflowGuard(sessionId)
    const injected = await fire(listener, call('write', { file_path: join(root, '甲项目', 'lib', 'a.js') }, sessionId))
    if (injected.some((one) => one.includes(WORKFLOW_MARK))) { wfListener = listener; break }
  }
  assert.notEqual(wfListener, null, '命中工作流时必须注入（钩子真的在跑）')
  ok('接线：命中工作流真的注入了')

  // **接线层核心**：连着改同一类文件，只注入一次。
  resetWorkflowGuard()
  clearWorkflowGuard(sessionId)
  let injectedCount = 0
  for (let i = 0; i < WORKFLOW_MIN_INTERVAL; i += 1) {
    const injected = await fire(wfListener, call('write', { file_path: join(root, '甲项目', 'lib', `f${i}.js`) }, sessionId))
    if (injected.some((one) => one.includes(WORKFLOW_MARK))) injectedCount += 1
  }
  assert.equal(injectedCount, 1,
    `连着 ${WORKFLOW_MIN_INTERVAL} 步改同一类文件，只该注入 1 次，实际 ${injectedCount} 次`)
  ok(`接线：连着 ${WORKFLOW_MIN_INTERVAL} 步同一阶段 → 只注入 1 次（去重真的生效）`)

  // **接线层核心**：隔够之后必须重新注入（防「干脆永远不注入」）。
  const reinjected = await fire(wfListener, call('write', { file_path: join(root, '甲项目', 'lib', 'later.js') }, sessionId))
  assert.ok(reinjected.some((one) => one.includes(WORKFLOW_MARK)),
    `隔满 ${WORKFLOW_MIN_INTERVAL} 步后必须重新注入（否则规则静默失效）`)
  ok(`接线：隔满 ${WORKFLOW_MIN_INTERVAL} 步 → 重新注入`)

  /* ---------------- v1.1.2：首次全文，之后一行指路 ---------------- */

  // 为什么必须有这一组：用户报「复读机」，而这条注入在一个真实会话里出现了 510 次，
  // 其中同一条流程被原样塞了 159 次**完整 11 步**。改法是把重复的那部分压成一行，
  // 但**不能**压掉「第一次的完整步骤」——那会让模型压根看不到流程。
  // 所以下面两条断言缺一不可：首次必须**含步骤**，重复必须**不含步骤**。
  resetWorkflowGuard()
  clearWorkflowGuard(sessionId)
  const firstFire = await fire(wfListener, call('write', { file_path: join(root, '甲项目', 'lib', 'first.js') }, sessionId))
  const firstText = firstFire.find((one) => one.includes(WORKFLOW_MARK)) ?? ''
  assert.ok(firstText.includes('改动后验证'), '首次注入要点名流程名')
  assert.ok(firstText.includes('跑语法检查'), '首次注入必须带**完整步骤**（否则模型看不到流程）')
  assert.ok(!firstText.includes('步骤已给过'), '首次注入不该是「指路」形态')
  ok('首次命中 → 完整步骤')

  // 走到重复注入（隔满间隔），这次必须是**一行指路**。
  let repeatText = ''
  for (let i = 0; i < WORKFLOW_MIN_INTERVAL + 1; i += 1) {
    const injected = await fire(wfListener, call('write', { file_path: join(root, '甲项目', 'lib', `again${i}.js`) }, sessionId))
    const hit = injected.find((one) => one.includes(WORKFLOW_MARK))
    if (hit !== undefined) repeatText = hit
  }
  assert.notEqual(repeatText, '', '隔够之后必须重新注入（不能因为压文案而彻底沉默）')
  assert.ok(repeatText.includes('步骤已给过'), `重复注入必须是「指路」形态，实际：${repeatText.slice(0, 80)}`)
  assert.ok(repeatText.includes('改动后验证'), '指路也要点名是哪条流程')
  assert.ok(!repeatText.includes('跑语法检查'), '重复注入**不许**再带完整步骤（那正是复读机）')
  assert.ok(repeatText.split('\n').length <= 2, `指路必须是一行（实际 ${repeatText.split('\n').length} 行）`)
  ok('重复命中 → 一行指路（不带步骤）')

  // 换阶段：命中另一条流程 → 立刻注入，且注入的是**新那条**。
  // 乙项目已在上面建好（绑定记忆有 1 秒 TTL，见那段注释）。
  resetWorkflowGuard()
  clearWorkflowGuard(sessionId)
  await fire(wfListener, call('write', { file_path: join(root, '乙项目', 'lib', 'a.js') }, sessionId))
  const switchedInjected = await fire(wfListener, call('write', { file_path: join(root, '乙项目', 'special-target.js') }, sessionId))
  assert.ok(switchedInjected.some((one) => one.includes(WORKFLOW_MARK)), '换阶段必须立刻注入')
  assert.ok(switchedInjected.some((one) => one.includes('另一条流程')), '注入的必须是新命中的那条流程')
  ok('接线：换了阶段立刻注入，且内容是新那条')

  // 守卫自证：**没命中**时一步都不许注入（去重不能变成「乱注入」）。
  resetWorkflowGuard()
  clearWorkflowGuard(sessionId)
  let missCount = 0
  for (let i = 0; i < WORKFLOW_MIN_INTERVAL + 2; i += 1) {
    const injected = await fire(wfListener, call('write', { file_path: join(root, '甲项目', '无关目录', `x${i}.txt`) }, sessionId))
    if (injected.some((one) => one.includes(WORKFLOW_MARK))) missCount += 1
  }
  assert.equal(missCount, 0, '没命中任何工作流时一步都不许注入')
  ok('守卫自证：没命中就不注入（去重没变成乱注入）')

  // 守卫自证：工具失败（block）时不插话（与熔断/催促同口径）。
  resetWorkflowGuard()
  clearWorkflowGuard(sessionId)
  let blockedCount = 0
  for (let i = 0; i < WORKFLOW_MIN_INTERVAL + 2; i += 1) {
    const decision = await wfListener(
      call('write', { file_path: join(root, '甲项目', 'lib', `b${i}.js`) }, sessionId),
      { ok: false },
      async () => ({ kind: 'block' }),
    )
    const contexts = decision !== null && Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    blockedCount += contexts.length
  }
  assert.equal(blockedCount, 0, '工具失败（block）时不注入工作流')
  ok('守卫自证：工具失败时不插话')

  console.log(`\n工作流注入去重： ${passed} 通过 / 0 失败`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
