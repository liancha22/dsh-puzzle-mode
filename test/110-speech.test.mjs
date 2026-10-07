/**
 * 说话纠正测试：纯逻辑层 + 真钩子接线层。
 *
 *   node test/110-speech.test.mjs
 *
 * ## 为什么要有这一组
 *
 * 用户两次点名同一件事：「强化防复读效果，就说输出陈述时不要复读输入的内容」
 * 「陈述中文化强化搞一个最硬的约束，现在还是会说英文」。
 *
 * 关键事实：**v0.28.0 起提示段里就写着「一律用中文」，用户实测仍然说英文**。
 * 所以这组测试的重心不是「提示段里有没有那行字」（那种断言拦不住任何东西），
 * 而是**检测真的命中、纠正真的注入**。
 *
 * 两头都要验：
 *   1. 该判的必须判（整句英文、英文标题、逐字复读）；
 *   2. **不该判的一条都不许判**（代码块、报错原文引用、标识符标题、命令、
 *      中文里夹英文词）——误判会打断正在干活的人，比漏判更糟。
 *
 * ## 断言为什么这么写
 *
 * 按本仓约定（`~/.dsh/AGENTS.md` 第 0.1 节）：**断言引常量**，
 * 阈值取 `ENGLISH_MIN_WORDS` / `ECHO_WINDOW` 而不是写死数字；
 * 同时**必须**有「守卫真的会红」的自证。
 *
 * 宿主半 import 了 `@deepseek-ai/dsh-tools`（由 DSH 运行时提供）。在没装 DSH 的
 * 裸目录里这一组无法运行，此时**明确跳过**并说明原因，而不是抛 ERR_MODULE_NOT_FOUND。
 */
import assert from 'node:assert/strict'
// **必须最先**：隔离 DSH_HOME（钩子走 isSessionDisabled，会读全局设置）。
import './helpers/isolate-home.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ECHO_STEP,
  ECHO_WINDOW,
  ENGLISH_HEADING_MIN_LETTERS,
  ENGLISH_HEADING_MIN_WORDS,
  ENGLISH_LINE_MIN_WORDS,
  ENGLISH_MIN_WORDS,
  SPEECH_KIND_ECHO,
  SPEECH_KIND_ENGLISH,
  SPEECH_MARK,
  clearSpeech,
  collapse,
  detectEcho,
  detectEnglish,
  inputsOf,
  noteStatement,
  peekViolation,
  rememberInput,
  resetSpeech,
  speechFixText,
  speechViolation,
  stripCode,
  takeViolation,
} from '../lib/puzzle.js'

let host
try {
  host = await import('../lib/index.js')
} catch (error) {
  const code = error === null || error === undefined ? undefined : error.code
  console.log(`skip 110-speech.test.mjs：${code === 'ERR_MODULE_NOT_FOUND' ? '找不到 @deepseek-ai/dsh-tools（本目录未装进 DSH profile），跳过' : String(error && error.message ? error.message : error)}`)
  process.exit(0)
}

const root = mkdtempSync(join(tmpdir(), 'puzzle-speech-'))
let passed = 0

function ok(name) {
  passed += 1
  console.log(`ok   ${name}`)
}

/** 摘出宿主半注册的监听器。 */
function capture() {
  const events = []
  const steps = []
  host.apply({
    systemPrompt: { section() {} },
    tools: { register() { return () => {} } },
    on(event, fn) {
      if (event === 'session/event') events.push(fn)
      if (event === 'agent/pre-step') steps.push(fn)
      return () => {}
    },
    inject() {},
    effect() {},
    get(name) {
      if (name !== 'sessions') return undefined
      return { get(id) { return typeof id === 'string' && id !== '' ? { header: { cwd: root } } : undefined } }
    },
  })
  return { events, steps }
}

/** 造一个 session/event 的载荷（只取钩子会读的字段）。 */
function evt(sessionId, type, data) {
  return [{ id: sessionId }, { type, data }]
}

/** 造一条消息（dsh-llm 的 createUserMessage 形状）。 */
function msg(text) {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

const accept = async () => ({ kind: 'enter', messages: [] })

/** 驱动一次 pre-step，返回注入的文本。 */
async function fireStep(listener, sessionId, messages = []) {
  const decision = await listener({ agent: { id: sessionId }, messages, turn: 2, step: 1 }, accept)
  const list = decision !== null && Array.isArray(decision.messages) ? decision.messages : []
  return list.map((message) => {
    const content = message !== null && message !== undefined ? message.content : undefined
    if (!Array.isArray(content)) return ''
    return content.map((block) => (block !== null && typeof block.text === 'string' ? block.text : '')).join('')
  })
}

try {
  /* ---------------- 纯逻辑：剥代码与压平 ---------------- */

  const withCode = '改动：\n```js\nconst foo = bar()\n```\n还有 `inline code` 在这里。'
  assert.ok(!stripCode(withCode).includes('foo'), '代码块必须被剥掉（否则每段带代码的回复都判违规）')
  assert.ok(!stripCode(withCode).includes('inline'), '行内代码必须被剥掉')
  assert.ok(stripCode(withCode).includes('改动'), '中文正文要留着')
  assert.equal(collapse('a  \n b\tc'), 'a b c', '空白要压平（复读比对不该因换行漏判）')
  ok('剥代码与压平空白')

  /* ---------------- 纯逻辑：英文检测（该判的） ---------------- */

  const english = detectEnglish('I have updated the file and the tests are all passing now.')
  assert.equal(english.ok, true, `整句英文必须判违规（阈值 ${ENGLISH_MIN_WORDS} 词）`)
  assert.ok(english.words >= ENGLISH_MIN_WORDS, `英文词数要够阈值：${english.words}`)
  ok('整句英文 → 判违规')

  // 英文**小标题**是最容易漏的一种：它只有两三个词，够不到正文那 5 词门槛。
  // 实测漏过 `## Next Steps`——所以标题单独一条更严的规则。
  const heading = detectEnglish('## Next Steps\n## Progress')
  assert.equal(heading.ok, true, '英文标题必须判违规（否则「英文小标题」这条口子一直开着）')
  ok('英文标题 → 判违规（正文门槛之外的单独规则）')

  /* ---------------- 纯逻辑：英文检测（不许误判的） ---------------- */

  const allowed = [
    ['纯中文', '这一步已经改完了，测试全绿。'],
    ['中文里夹代码', '跑 `npm test` 之后全绿了。'],
    ['引用报错原文', '报错原文：Cannot find module 找不到依赖，已修。'],
    ['代码块里的英文', '改动如下：\n```js\nconst foo = bar()\n```\n就这些。'],
    ['命令', 'git status --short'],
    ['标识符标题', '## op:read'],
    ['命令标题', '## git status'],
    ['命令标题2', '## npm run build'],
    ['中文标题夹英文词', '## 下一步 action items'],
    ['英文短句（不到阈值）', 'Just do it now'],
  ]
  for (const [name, text] of allowed) {
    assert.equal(detectEnglish(text).ok, false, `不该判违规：${name} —— ${text}`)
  }
  ok(`误判防线：${allowed.length} 种正常写法全部放行`)

  // 命令标题与英文标题的**唯一差别是大小写**——这条断言把那个判据钉住。
  assert.equal(detectEnglish('## git status').ok, false, '小写命令标题要放行')
  assert.equal(detectEnglish('## Git Status').ok, true, '词首大写的英文标题要判（与命令标题的差别就在这里）')
  ok('大小写是命令标题与英文标题的分界（钉住判据）')

  assert.ok(ENGLISH_HEADING_MIN_WORDS >= 2 && ENGLISH_HEADING_MIN_LETTERS >= 8,
    '标题门槛必须有下界，否则标识符标题（## op:read）会被误判')

  /* ---------------- 纯逻辑：复读检测 ---------------- */

  const source = '这是一段很长的文件内容，用来测试复读检测是否能够正确命中连续字符窗口，长度足够。'
  const echoed = detectEcho(`读完发现：${source.slice(0, ECHO_WINDOW + 8)}，所以改了它。`, [{ source: 'tool', text: source }])
  assert.equal(echoed.ok, true, `逐字复制 ≥ ${ECHO_WINDOW} 字符必须判复读`)
  assert.equal(echoed.source, 'tool', '要记下复读的来源（工具输出 / 用户消息）')
  ok(`逐字复述 ≥ ${ECHO_WINDOW} 字符 → 判复读`)

  // 只给结论、不给原文 → 不许判。
  const clean = detectEcho('我的结论是应该改用新的接口，因为它更短。', [{ source: 'tool', text: source }])
  assert.equal(clean.ok, false, '只写结论、没抄原文 → 不许判复读')
  ok('误判防线：只写结论不判复读')

  // 短于窗口的巧合不算复读。
  const short = detectEcho('它说的是「这是一段很长的文件」，我改了。', [{ source: 'tool', text: source }])
  assert.equal(short.ok, false, `短于 ${ECHO_WINDOW} 字符的巧合不算复读`)
  ok(`误判防线：短于 ${ECHO_WINDOW} 字符不判复读`)

  assert.ok(ECHO_STEP >= 1, '取样步进必须 ≥ 1（否则死循环）')

  /* ---------------- 综合判定：英文优先 ---------------- */

  const both = speechViolation('I have updated the file and the tests are all passing now.', [{ source: 'tool', text: source }])
  assert.equal(both.kind, SPEECH_KIND_ENGLISH, '同时命中时英文优先（那是用户点名「最硬」的那条）')
  const onlyEcho = speechViolation(`结论：${source.slice(0, ECHO_WINDOW + 8)}`, [{ source: 'tool', text: source }])
  assert.equal(onlyEcho.kind, SPEECH_KIND_ECHO, '只命中复读时报复读')
  assert.equal(speechViolation('正常的中文结论。', []).violation, false, '正常中文不报')
  ok('综合判定：英文优先，其次复读，正常中文不报')

  /* ---------------- 状态：记账与挂起 ---------------- */

  resetSpeech()
  assert.equal(rememberInput('s1', 'user', '用户说的话'), true, '记用户输入')
  assert.equal(rememberInput('s1', 'tool', '工具输出'), true, '记工具输出')
  assert.equal(rememberInput('s1', 'tool', '   '), false, '空文本不记')
  assert.equal(inputsOf('s1').length, 2, '两条输入都记下了')
  ok('记输入（空文本不记）')

  // 保留条数有上限：不然长会话会把内存撑大。
  resetSpeech()
  for (let i = 0; i < 10; i += 1) rememberInput('s2', 'tool', `输出 ${i}`)
  assert.ok(inputsOf('s2').length <= 5, `工具输出保留条数要有上限，实际 ${inputsOf('s2').length}`)
  ok('输入保留条数有上限')

  // 违规挂起 → peek 不消费 → take 才消费（顺序契约：先造上下文再落闸）。
  resetSpeech()
  const bad = noteStatement('s3', 'I have updated the file and the tests are all passing now.')
  assert.equal(bad.violation, true, '违规要记账')
  assert.notEqual(peekViolation('s3'), null, 'peek 应看到挂起的违规')
  assert.notEqual(peekViolation('s3'), null, 'peek **不消费**（可以看第二次）')
  const taken = takeViolation('s3')
  assert.equal(taken.kind, SPEECH_KIND_ENGLISH, 'take 拿到违规内容')
  assert.equal(peekViolation('s3'), null, 'take 之后挂起清空')
  ok('挂起 → peek 不消费 → take 消费（顺序契约）')

  resetSpeech()
  noteStatement('s4', '正常的中文结论。')
  assert.equal(peekViolation('s4'), null, '不违规就不挂起')
  ok('不违规不挂起')

  resetSpeech()
  assert.equal(noteStatement('', 'I have updated the file now and everything is fine.').violation, false, '空 sessionId 不判')
  assert.equal(noteStatement('s5', '').violation, false, '空文本不判')
  ok('空 sessionId / 空文本安全降级')

  clearSpeech('s3')
  assert.equal(peekViolation('s3'), null, 'clearSpeech 清得掉')
  ok('clearSpeech 清得掉状态')

  /* ---------------- 纠正文本 ---------------- */

  const englishText = speechFixText({ kind: SPEECH_KIND_ENGLISH, words: 12, sample: 'I have updated the file' })
  assert.ok(englishText.includes(SPEECH_MARK), '纠正带标记，便于辨认来源')
  assert.ok(englishText.includes('中文'), '英文纠正必须要求改用中文')
  assert.ok(englishText.includes('立刻'), '语气要硬（用户点名要「最硬的约束」）')
  assert.ok(englishText.includes('标识符') && englishText.includes('路径'), '要写清英文只允许出现在哪四种位置')
  ok('英文纠正：要求立刻改中文 + 列清英文的允许位置')

  const echoText = speechFixText({ kind: SPEECH_KIND_ECHO, run: ECHO_WINDOW, sample: '这是一段很长的文件内容', source: 'tool' })
  assert.ok(echoText.includes('复读') || echoText.includes('复述'), '复读纠正要说明是什么毛病')
  assert.ok(echoText.includes('文件:行'), '要教它「引用就给位置」，而不是整段搬')
  ok('复读纠正：说明毛病 + 教「引用给位置」')

  /* ---------------- 接线层：观察 → 注入 ---------------- */

  const { events, steps } = capture()
  assert.ok(events.length >= 1, '必须注册 session/event 观察钩子')
  assert.ok(steps.length >= 1, '必须注册 agent/pre-step 注入钩子')

  const sessionId = 'session-speech-wire'
  resetSpeech()
  clearSpeech(sessionId)

  // 找到「说话纠正」的观察钩子：喂一条英文陈述，看谁会让状态挂起。
  let observer = null
  for (const listener of events) {
    resetSpeech()
    clearSpeech(sessionId)
    try {
      listener(...evt(sessionId, 'assistant/message', { message: msg('I have updated the file and the tests are all passing now.') }))
    } catch (_error) { /* 别的钩子抛错不算它 */ }
    if (peekViolation(sessionId) !== null) { observer = listener; break }
  }
  assert.notEqual(observer, null, '必须有一个观察钩子在英文陈述后挂起纠正')
  ok('接线：英文陈述被观察钩子判违规并挂起')

  // 找到注入钩子：挂起后由它把纠正插进 messages。
  let injector = null
  for (const listener of steps) {
    resetSpeech()
    clearSpeech(sessionId)
    noteStatement(sessionId, 'I have updated the file and the tests are all passing now.')
    const injected = await fireStep(listener, sessionId)
    if (injected.some((one) => one.includes(SPEECH_MARK))) { injector = listener; break }
  }
  assert.notEqual(injector, null, '必须有一个 pre-step 钩子把纠正注入 messages')
  ok('接线：挂起的纠正被注入下一步的 messages')

  // 注入后挂起必须清空（否则每步都重复注入同一条）。
  resetSpeech()
  clearSpeech(sessionId)
  noteStatement(sessionId, 'I have updated the file and the tests are all passing now.')
  const first = await fireStep(injector, sessionId)
  assert.ok(first.some((one) => one.includes(SPEECH_MARK)), '第一次要注入')
  const second = await fireStep(injector, sessionId)
  assert.equal(second.filter((one) => one.includes(SPEECH_MARK)).length, 0, '注入后不许再注入同一条（不刷屏）')
  ok('接线：纠正只注入一次（不刷屏）')

  // 端到端：用户输入 → 模型复读 → 观察 → 注入。
  resetSpeech()
  clearSpeech(sessionId)
  observer(...evt(sessionId, 'user/message', { content: [{ type: 'text', text: source }] }))
  observer(...evt(sessionId, 'assistant/message', { message: msg(`我读完了：${source.slice(0, ECHO_WINDOW + 8)}`) }))
  const echoed2 = await fireStep(injector, sessionId)
  assert.ok(echoed2.some((one) => one.includes(SPEECH_MARK)), '复读输入也要端到端触发纠正')
  ok('接线：复读输入 → 端到端注入纠正')

  // 守卫自证：正常中文陈述**一条纠正都不许**注入。
  resetSpeech()
  clearSpeech(sessionId)
  observer(...evt(sessionId, 'user/message', { content: [{ type: 'text', text: source }] }))
  const cleanRuns = [
    '这一步已经改完了，测试全绿。',
    '改动如下：\n```js\nconst foo = bar()\n```\n就这些。',
    '报错原文：Cannot find module 找不到依赖，已修。',
    '结论：应该改用新接口。',
  ]
  for (const text of cleanRuns) observer(...evt(sessionId, 'assistant/message', { message: msg(text) }))
  const cleanOut = await fireStep(injector, sessionId)
  assert.equal(cleanOut.filter((one) => one.includes(SPEECH_MARK)).length, 0, '正常中文陈述一条纠正都不许注入')
  ok('守卫自证：正常中文 / 代码 / 报错引用不被纠正')

  // 守卫自证：工具输出里出现英文（读到一个英文文件）**不算模型说英文**。
  resetSpeech()
  clearSpeech(sessionId)
  observer(...evt(sessionId, 'tool/result', { message: { content: [{ type: 'text', text: 'I have updated the file and the tests are all passing now.' }] } }))
  const toolOut = await fireStep(injector, sessionId)
  assert.equal(toolOut.filter((one) => one.includes(SPEECH_MARK)).length, 0, '工具输出是英文不算模型说英文')
  ok('守卫自证：工具输出里的英文不触发纠正')

  console.log(`\n说话纠正： ${passed} 通过 / 0 失败`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
