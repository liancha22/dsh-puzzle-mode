/**
 * 浏览器半的「无浏览器」冒烟测试。
 *
 * bundle 是手写的 `window.__ModuleLoader__.load({ id, factory })`，所以这里造一个
 * 最小 window/document/React 替身，真的把 factory 跑起来、真的调 `apply`，
 * 再真的**渲染**两个组件并模拟点击，验证：
 *   - 两个 Slot 的 id/order/name 符合契约；
 *   - 图块可点开（点模块块 → 发起 `method:'module'` 请求）；
 *   - 提问模板走 `inputActions.setDraft`（并且不自动发送）；
 *   - `inputActions` 从按钮 Slot 传到面板（shell.overlay 的 props 里没有它）。
 *
 *   node test/20-client.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ASK_MAX_OPTIONS, ASK_MAX_QUESTIONS, ENTRY_CAPS, ENTRY_LIMITS, HEALTH_DIMENSIONS, SIZE_CAPS, SIZES, SIZE_LARGE, SIZE_MEDIUM, SIZE_SMALL, capsOfSize, WORKFLOW_NAME_LIMIT, WORKFLOW_STEP_LIMIT } from '../lib/puzzle.js'

const here = dirname(fileURLToPath(import.meta.url))
// 维度名**引常量**而不是写死（v0.19.8）：改维度只改 lib/constants.js，断言自动跟上。
const DIMENSION_NAMES = HEALTH_DIMENSIONS.map((d) => d.name)
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let loaded = null
const fakeWindow = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry
    },
  },
  setInterval() {
    return 1
  },
  clearInterval() {},
  addEventListener() {},
  removeEventListener() {},
}

const fakeReact = {
  createElement(type, props, ...children) {
    return { type: type, props: props === null || props === undefined ? {} : props, children: children }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, function () {}]
  },
  useEffect(fn) {
    // 立即执行一次，让 Button 里「把 inputActions 交给面板」的 effect 生效。
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanup()
  },
}

const requests = []
/** 假 RPC：按 method 返回真实形状的结果，让面板走「已初始化」分支。 */
const fakeFetch = (url, options) => {
  const body = JSON.parse(options.body)
  requests.push({ url, body })
  let result
  if (body.method === 'state') {
    result = {
      ok: true,
      initialized: true,
      projectRoot: '/tmp/ws',
      projectDir: '/tmp/ws/demo/拼图',
      project: 'demo',
      mode: '只拼不写',
      modeSource: 'front-matter',
      health: 62,
      dimensions: { complexity: 34, extensibility: 40, maintenance: 44, quality: 88, reusability: 20 },
      cwdSource: 'session',
      projectSource: 'latest',
      modules: [{ name: 'auth-flow', exists: true, health: 62, dimensions: {}, counts: { points: 2, pending: 1, decided: 0 } }],
      findings: [
        { id: 'progress_no_points:auth-flow', level: 'blocker', dimension: 'maintenance', scope: 'auth-flow', fact: '完成度写 100，但要点 0 条。', fix: '把要点补上。' },
        { id: 'weakest_dimension', level: 'info', dimension: 'reusability', scope: 'project', fact: '最弱一维是可复用性。', fix: '写出可复用接口。' },
      ],
    }
  } else if (body.method === 'list') {
    result = { ok: true, projectCount: 2, defaultProject: 'demo', projects: [{ name: 'demo', health: 62 }, { name: 'second', health: 10 }] }
  } else if (body.method === 'module') {
    result = { ok: true, name: body.name, exists: true, health: 62, dimensions: { complexity: 34, extensibility: 40, maintenance: 44, quality: 88, reusability: 20 }, points: '要点一', related: '- [ ] 待定', detail: '详细一' }
  } else {
    result = { ok: true, mode: body.mode }
  }
  // 客户端读的是外层 { ok, result } —— 这里必须按真实 RPC 的形状包一层。
  return Promise.resolve({ json: () => Promise.resolve({ ok: true, result }) })
}

const run = new Function('window', 'document', 'fetch', source)
run(
  fakeWindow,
  { createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} }, body: {} },
  fakeFetch,
)

assert.ok(loaded !== null, 'bundle 必须调用 window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-puzzle-mode')
assert.equal(typeof loaded.factory, 'function')

const mod = loaded.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error('unexpected require: ' + name)
})
assert.equal(typeof mod.apply, 'function')
// v0.19.8 修：导出名单按现行 lib/client.js 的 module.exports 对齐 ——
// questionTemplate 已不存在（提问相关改由 interviewTemplate 承担），
// 实际导出还有 resumeTemplate / auditTemplate / refactorTemplate / adoptTemplate /
// newDocTemplate / workflowTemplate 等；这里逐个核可测导出。
assert.equal(typeof mod.auditTemplate, 'function', '审查模板必须可测（导出）')
for (const name of ['createTemplate', 'interviewTemplate', 'bindTemplate', 'createByForm',
  'resumeTemplate', 'refactorTemplate', 'adoptTemplate', 'newDocTemplate', 'workflowTemplate']) {
  assert.equal(typeof mod[name], 'function', name + ' 必须可测（导出）')
}

/* ---------------------------- 提问模板内容 ---------------------------- */

{
  const text = mod.interviewTemplate('登录重构')
  assert.ok(text.includes('登录重构'))
  // v0.19.8 修：同上 —— 固定收尾问不在模板里；改核模板的实质内容（岔路 + 取舍 + 上限）。
  assert.ok(text.includes('先采访再建'), '模板要说明先采访再建')
  assert.ok(text.includes('真岔路'), '模板要给真岔路而不是是非题')
  assert.ok(text.includes('能用选项就用选项'), '模板要点名用选项提问')
  assert.ok(text.includes('一轮最多 ' + ASK_MAX_QUESTIONS + ' 问'), '模板要写清提问额度（引 ASK_MAX_QUESTIONS，改上限不用改断言）')
  assert.ok(text.includes('每题最多 ' + ASK_MAX_OPTIONS + ' 个选项'), '模板要写清选项额度（引 ASK_MAX_OPTIONS）')
  assert.ok(/取舍|代价/.test(text), '模板要说明代价/取舍')
  // 提问数上限从 3 提到 5：模板要给出 5 个槽位。
  // v0.19.8 修：提问槽位编号已取消（改由 ASK_MAX_QUESTIONS 约束上限），不再逐槽断言。
  // v0.19.8 修：模板不再点名工具名（工具名由 policy 段给），改核「必须用选项提问」这条实质要求
  assert.ok(text.includes('能用选项就用选项'), '模板必须要求用选项提问（正文列选项不算提问）')
}

{
  const audit = mod.auditTemplate('登录重构')
  assert.ok(audit.includes('登录重构'))
  assert.ok(audit.includes('op:audit'), '审查模板必须点名 op:audit')
  assert.ok(audit.includes('五维'), '审查要按五维')
  // v0.19.8 修：模板**不再内嵌**固定收尾问（「每轮提问末尾必问停下」由 policy 段与 ask 流程统一要求，
  // 不在模板字符串里逐份复制），所以这里不再断言模板含那句。
  assert.ok(audit.includes('op:audit') || audit.includes('fixPlan'), '审查模板要点名审查产出')
}

{
  const create = mod.createTemplate('登录重构')
  assert.ok(create.includes('op:init'), '快速建空壳要点名 op:init')
  assert.ok(create.includes('modules'), '要提示给出模块名')
  const interview = mod.interviewTemplate('登录重构')
  assert.ok(interview.includes('op:init') && /最多 \d+ 问/.test(interview), '采访模板要限提问数（现行 10 问）')
  assert.ok(interview.includes('不要提前调 op:init'), '采访模板要明确先别建')
  const bind = mod.bindTemplate('demo')
  assert.ok(bind.includes('op:bind'), '绑定模板要点名 op:bind')
  assert.ok(bind.includes('demo'), '绑定模板要带上项目名')
}

/* -------- 规模档位：切档要立刻亮，且「当前上限」必须跟着档位走 -------- */

/**
 * 用户报「项目规模切换是**假态**，而且**延时切换**」。两个症状两个根因，都在 `sizeBlock`：
 *
 * 1. **假态**：面板那行「当前上限：悬而未决 ≤x · 已定 ≤y …」原先读 `limits.sizeCaps`，
 *    而那是「小/中/大**三档的整张表**」，不是当前这一档。于是 `caps.pending` 恒为
 *    `undefined`，靠 `undefined === undefined ? 4 : …` 的兜底**永远显示中档数字**——
 *    切到「大」显示「已定 ≤10」、切到「小」也显示「已定 ≤10」。真值在 `limits.entryCaps`
 *    （= `capsOfSize(当前档)`）。**这条断言就是钉它**：三个档位必须渲染出三个不同的上限行。
 * 2. **延时**：按钮只在**回包后**才变。已改成乐观更新——按下即翻档。
 *
 * 为什么断言「三个档渲染出三行不同的字」而不是断言内部字段：这个 bug 的特征是
 * **字段名读错但界面照常渲染**（不报错、不空白，只是数字永远一样），
 * 所以只有**渲染出来的文本**能抓住它。
 */
{
  const szRequests = []
  const szBindings = [{ project: 'aaa', current: true, mode: '只拼不写', health: 60, moduleCount: 2, initialized: true }]
  const szState = (size) => ({
    ok: true, initialized: true, projectRoot: '/tmp/ws7', projectDir: '/tmp/ws7/aaa/拼图',
    project: 'aaa', mode: '只拼不写', health: 60, version: 7, dimensions: {}, modules: [], findings: [],
    bindings: szBindings, currentProject: 'aaa', bindingWarnThreshold: 8,
    size,
    // 与宿主 `summarize` 同形：`limits` 里 `entryCaps` 是**当前档**，`sizeCaps` 是三档整表。
    limits: {
      askQuestions: 10, askOptions: 10,
      entryLimits: ENTRY_LIMITS, entryCaps: capsOfSize(size),
      workflowNameLimit: WORKFLOW_NAME_LIMIT, workflowStepLimit: WORKFLOW_STEP_LIMIT, workflowMaxSteps: 12,
      bindingWarnThreshold: 8, sizeCaps: SIZE_CAPS, sizes: SIZES,
    },
  })
  let szCurrent = SIZE_MEDIUM
  /**
   * **回包闸门**：扣住写操作的响应，用来真正验证「按下即亮」。
   *
   * 为什么必须扣住（我第一版没扣，结果是**假绿**）：`await setTimeout(0)` 是**宏任务**，
   * 排在微任务链之后，所以 `fetch → json → then` 那三层 promise 早就跑完了——
   * 断言看到的其实是**回包之后**的状态，把乐观更新整个删掉它照样绿。
   * 扣住回包后，`onClick()` 返回时 store 里只可能是**乐观更新写进去的那份**。
   */
  let szHold = null
  const szOpenGate = () => {
    let release
    const p = new Promise((resolve) => { release = resolve })
    szHold = { p, release }
    return function close() { const held = szHold; szHold = null; held.release() }
  }
  const szWindow = {
    __ModuleLoader__: { load(entry) { szRequests.push(entry) } },
    setInterval() { return 1 }, clearInterval() {}, addEventListener() {}, removeEventListener() {},
  }
  const szFetch = (url, options) => {
    const body = JSON.parse(options.body)
    let result
    if (body.method === 'state') result = szState(szCurrent)
    else if (body.method === 'list') result = { ok: true, projects: [{ name: 'aaa', health: 60 }] }
    else if (body.method === 'size') { szCurrent = body.size; result = szState(body.size) }
    // 写模式的回包按**真实 `summarize` 形状**给（含 size / limits / 绑定组），
    // 否则这条用例会用一个比现实更穷的回包去测合并逻辑，测不出真问题。
    else if (body.method === 'mode') result = Object.assign(szState(szCurrent), { mode: body.mode })
    else result = { ok: true, mode: body.mode }
    const payload = { json: () => Promise.resolve({ ok: true, result }) }
    // 只有写操作会被闸门扣住（`state` 是面板启动时要用的，扣住会卡住整个渲染）。
    const isWrite = body.method === 'size' || body.method === 'mode'
    return isWrite && szHold !== null ? szHold.p.then(() => payload) : Promise.resolve(payload)
  }
  new Function('window', 'document', 'fetch', source)(
    szWindow,
    { createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} }, body: {} },
    szFetch,
  )
  const szMod = szRequests[0].factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('unexpected require: ' + name)
  })
  const szRegs = []
  const szSlots = { inject(name, cb) { cb(); return () => {} }, register(o, c) { szRegs.push({ o, c }); return () => {} } }
  szMod.apply({ get: (n) => (n === 'slots' ? szSlots : undefined), effect: () => () => {} })
  const szBtn = szRegs.find((r) => r.o.name === 'conversation.input.left')
  const szPanel = szRegs.find((r) => r.o.name === 'shell.overlay')
  szBtn.c({ sessionId: 'session-size', inputActions: { setDraft() {}, submit() {} } }).props.onClick()
  await flush()

  /** 取那行「当前上限：…」的文本（唯一带「当前上限」的那个节点）。 */
  const capsLine = (tree) => {
    const node = findAll(tree, (n) => typeof n === 'object' && n.props !== undefined
      && typeof n.children?.[0] === 'string' && n.children[0].indexOf('当前上限') === 0)
    return node.length > 0 ? node[0].children[0] : null
  }
  /** 找到某个档位按钮（按钮里的 `span` 文本就是档位名）。 */
  const sizeButton = (tree, label) => findAll(tree, (n) => typeof n === 'object' && n.type === 'button'
    && findAll(n, (c) => c === label).length > 0)[0]

  let szTree = szPanel.c({})
  const midLine = capsLine(szTree)
  assert.ok(midLine !== null, '规模区必须渲染「当前上限」那行')
  // 引常量，别写死数字（本项目的「断言引常量」纪律）。
  assert.ok(midLine.includes('已定 ≤' + SIZE_CAPS[SIZE_MEDIUM].decided),
    '中档应显示中档上限，实际：' + midLine)

  // 切到「大」：**扣住回包 + 同步读树**，此刻 store 里只可能是乐观更新写进去的那份。
  const bigBtn = sizeButton(szTree, SIZE_LARGE)
  assert.ok(bigBtn !== undefined, '要能找到「大」按钮')
  let openGate = szOpenGate()
  bigBtn.props.onClick()
  /**
   * ⚠️ **必须同步读树，不能 `await` 之后再读**（我第一版就是那么写的，结果假绿）。
   *
   * 这个假 React 的 `useEffect` 是**每次渲染都跑**的（真实 React 只在挂载/依赖变化时跑），
   * 而面板的 effect 里有 `load(sessionId)`。所以只要 `await` 一个宏任务，
   * 那次 `state` 拉取就会回来、把乐观更新**冲掉**——断言看到的其实是回包后的状态，
   * 把乐观更新整个删掉也照样绿。
   *
   * 同步读则只可能读到 `onClick()` 里那次同步 `setState` 的结果；
   * 回包还被闸门扣着，`state` 拉取是异步的（尚未落地）。这才是「按下即亮」的真判据。
   */
  szTree = szPanel.c({})
  const bigLineNow = capsLine(szTree)
  assert.ok(bigLineNow !== null && bigLineNow.includes('已定 ≤' + SIZE_CAPS[SIZE_LARGE].decided),
    '点「大」必须**按下即亮**（回包被扣住时也要亮），实际：' + bigLineNow)
  assert.ok(bigLineNow.includes('悬而未决 ≤' + SIZE_CAPS[SIZE_LARGE].pending),
    '「大」档的悬而未决上限也要跟着走，实际：' + bigLineNow)
  openGate()
  await flush()

  // 再切到「小」——三档必须给出**三个不同**的上限行（这就是「假态」的判据）。
  szTree = szPanel.c({})
  openGate = szOpenGate()
  sizeButton(szTree, SIZE_SMALL).props.onClick()
  szTree = szPanel.c({})
  const smallLine = capsLine(szTree)
  assert.ok(smallLine.includes('已定 ≤' + SIZE_CAPS[SIZE_SMALL].decided),
    '「小」档要显示小档上限（回包被扣住时也要对），实际：' + smallLine)
  assert.notEqual(smallLine, midLine, '「小」与「中」的上限行**不能一样**——一样就是读了 sizeCaps 的假态')
  assert.notEqual(smallLine, bigLineNow, '「小」与「大」的上限行不能一样')
  openGate()
  await flush()
  console.log('ok   规模档位：按下即翻档（扣住回包也亮），且「当前上限」跟着档位走（三档三样）')

  /**
   * 模式按钮的**延时**症状（用户报的「延时切换」）与规模同一处纪律：
   * 按下必须立刻亮（`data-on='1'`），不能等回包。模式按钮把文本直接当子节点，
   * 用 `data-on` 判高亮即可。
   */
  const modeOn = (tree, label) => {
    const btn = findAll(tree, (n) => typeof n === 'object' && n.type === 'button'
      && Array.isArray(n.children) && n.children.includes(label))[0]
    return btn === undefined ? null : btn.props['data-on']
  }
  szTree = szPanel.c({})
  assert.equal(modeOn(szTree, '只拼不写'), '1', '初始应高亮宿主给的模式')
  const writeAfterBtn = findAll(szTree, (n) => typeof n === 'object' && n.type === 'button'
    && Array.isArray(n.children) && n.children.includes('写后再拼'))[0]
  assert.ok(writeAfterBtn !== undefined, '要能找到「写后再拼」按钮')
  // 同样**扣住回包 + 同步读树**：不这么做的话，await 之后那次 `state` 拉取已经把
  // 乐观更新冲掉了，把乐观更新删掉断言照样绿（第一版就是这么假绿的）。
  const modeGate = szOpenGate()
  writeAfterBtn.props.onClick()
  szTree = szPanel.c({})
  assert.equal(modeOn(szTree, '写后再拼'), '1', '点模式必须**按下即亮**（扣住回包也亮）——用户报的「延时切换」')
  assert.equal(modeOn(szTree, '只拼不写'), '0', '旧模式的高亮要同时撤掉')
  modeGate()
  await flush()
  console.log('ok   执行模式：按下即亮（扣住回包也亮），不等回包')
}

/* -------- 切项目：面板不得沿用上一个项目的模式（v0.23.3） -------- */

/**
 * 用户报「执行模式怎么继承到下一个打开的面板了」。
 *
 * **不是数据被写串了**（宿主侧两个项目的 `模式:` 各写各的，单独验过），
 * 而是**面板短暂地拿着上一个项目的值**：切项目时 `current` 的返回不带新项目的 `mode`，
 * 而 `load()` 是异步的。实测：
 *
 *   ① 当前 A（只拼不写）  高亮 = 只拼不写
 *   ② 在 A 点「边拼边写」  高亮 = 边拼边写
 *   ③ 切到 B（load 未回）  高亮 = **边拼边写**  ← A 的模式，这就是「继承」
 *   ④ load 已回            高亮 = 写后再拼      ← 最终才对
 *
 * 断言钉的是 **③**——即「扣住 state 回包」时的显示。不扣回包就测不到：
 * `await` 之后 load 早已返回，显示已经自我纠正，把修复删掉照样绿（同类假绿，见上文）。
 */
{
  const swReqs = []
  const SW = {
    A: { mode: '只拼不写', health: 60 },
    B: { mode: '写后再拼', health: 70 },
  }
  let swCurrent = 'A'
  const swState = (name) => ({
    ok: true, initialized: true, project: name, mode: SW[name].mode, size: SIZE_MEDIUM,
    health: SW[name].health, version: 7, dimensions: {}, modules: [], findings: [],
    bindings: [
      { project: 'A', current: swCurrent === 'A', mode: SW.A.mode, health: SW.A.health, moduleCount: 1, initialized: true },
      { project: 'B', current: swCurrent === 'B', mode: SW.B.mode, health: SW.B.health, moduleCount: 1, initialized: true },
    ],
    currentProject: swCurrent, bindingWarnThreshold: 8,
    limits: {
      askQuestions: 10, askOptions: 10, entryLimits: ENTRY_LIMITS, entryCaps: capsOfSize(SIZE_MEDIUM),
      workflowNameLimit: WORKFLOW_NAME_LIMIT, workflowStepLimit: WORKFLOW_STEP_LIMIT, workflowMaxSteps: 12,
      bindingWarnThreshold: 8, sizeCaps: SIZE_CAPS, sizes: SIZES,
    },
  })
  /** 扣住 `state` 的回包，用来观察「切完但还没重读」那一瞬。 */
  let swHold = null
  const swGate = () => {
    let release
    const p = new Promise((resolve) => { release = resolve })
    swHold = { p, release }
    return function close() { const h = swHold; swHold = null; h.release() }
  }
  const swWindow = {
    __ModuleLoader__: { load(entry) { swReqs.push(entry) } },
    setInterval() { return 1 }, clearInterval() {}, addEventListener() {}, removeEventListener() {},
  }
  const swFetch = (url, options) => {
    const body = JSON.parse(options.body)
    let result
    if (body.method === 'state') result = swState(swCurrent)
    else if (body.method === 'list') result = { ok: true, projects: [{ name: 'A' }, { name: 'B' }] }
    else if (body.method === 'current') { swCurrent = body.project; result = swState(swCurrent) }
    else if (body.method === 'mode') { SW[body.project].mode = body.mode; result = swState(body.project) }
    else result = { ok: true }
    const payload = { json: () => Promise.resolve({ ok: true, result }) }
    return body.method === 'state' && swHold !== null ? swHold.p.then(() => payload) : Promise.resolve(payload)
  }
  new Function('window', 'document', 'fetch', source)(
    swWindow,
    { createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} }, body: {} },
    swFetch,
  )
  const swMod = swReqs[0].factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('unexpected require: ' + name)
  })
  const swRegs = []
  const swSlots = { inject(name, cb) { cb(); return () => {} }, register(o, c) { swRegs.push({ o, c }); return () => {} } }
  swMod.apply({ get: (n) => (n === 'slots' ? swSlots : undefined), effect: () => () => {} })
  const swBtn = swRegs.find((r) => r.o.name === 'conversation.input.left')
  const swPanel = swRegs.find((r) => r.o.name === 'shell.overlay')
  swBtn.c({ sessionId: 'session-sw2', inputActions: { setDraft() {}, submit() {} } }).props.onClick()
  await flush()

  const swModeOn = (tree, label) => {
    const btn = findAll(tree, (n) => typeof n === 'object' && n.type === 'button'
      && Array.isArray(n.children) && n.children.includes(label))[0]
    return btn === undefined ? null : btn.props['data-on']
  }
  const swPill = (tree, name) => findAll(tree, (n) => typeof n === 'object' && n.props !== undefined
    && n.props.className === 'dshpz-pill' && findAll(n, (c) => c === name).length > 0)[0]

  let swTree = swPanel.c({})
  assert.equal(swModeOn(swTree, '只拼不写'), '1', '初始当前是 A，应高亮 A 的模式')

  // 切到 B，**扣住 state 回包**，只排空微任务再同步读树 —— 这一瞬就是「继承」发生的时刻。
  //
  // ⚠️ 这里**不能用 `setTimeout(0)`**（同族假绿的第三个变体）：`markCurrentLocal` 是在
  // `current` 请求的 `.then` 回调里跑的（**微任务**），而 `setTimeout` 是**宏任务**——
  // 只 await 一个 `setTimeout` 的话，回调还没跑，看到的是「点了没反应」那一态。
  // 排空微任务（`await Promise.resolve()`）才能停在「本地已切、state 未回」这一瞬。
  const gate = swGate()
  swPill(swTree, 'B').props.onClick()
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  swTree = swPanel.c({})
  assert.equal(swModeOn(swTree, '写后再拼'), '1',
    '切到 B 后必须立刻显示 **B 的模式**（扣住 state 回包时也要对）——这是用户报的「模式继承」')
  assert.equal(swModeOn(swTree, '只拼不写'), '0', '不能还留着 A 的模式高亮')
  gate()
  await flush()

  // 权威值回来后仍然是 B 的（本地填的不能反过来盖掉真值）。
  swTree = swPanel.c({})
  assert.equal(swModeOn(swTree, '写后再拼'), '1', 'load 回来后仍应是 B 的模式')
  console.log('ok   切项目：面板立刻换成目标项目的模式（不沿用上一个项目）')
}

/* ---------------- bindings 两种形状（v0.21.0 加固） ---------------- */

/**
 * 宿主侧 `bindings` 有**两种形状**：`state` RPC 是对象数组（`{project, health…}`），
 * `current` / `unbind` 是**字符串数组**。按字段取值的写法遇到字符串数组会得到一串
 * `undefined`——`length` 看着还对，`all` 却被静默判成 `false`（迁移只作用于当前项目）。
 *
 * 这个坑在本仓出现过一次（v0.20.0：`...extra` 把对象数组盖成 `[undefined, undefined]`），
 * 所以凡是按字段取 `data.bindings` 的地方都必须走 `boundNamesOf`。
 */
{
  assert.equal(typeof mod.boundNamesOf, 'function', 'boundNamesOf 必须可测（导出）')
  assert.deepEqual(mod.boundNamesOf({ bindings: [{ project: 'a' }, { project: 'b' }] }), ['a', 'b'],
    '对象数组要取出 project')
  assert.deepEqual(mod.boundNamesOf({ bindings: ['a', 'b'] }), ['a', 'b'],
    '字符串数组也要认——否则会拿到 [undefined, undefined]')
  assert.deepEqual(mod.boundNamesOf({ bindings: [] }), [], '空数组就是空')
  assert.deepEqual(mod.boundNamesOf({}), [], '没有 bindings 字段给空数组，不给 undefined')
  assert.deepEqual(mod.boundNamesOf(null), [], 'null 要安全')
  // 混着来也要稳（防御性：宿主将来可能改形状）
  assert.deepEqual(mod.boundNamesOf({ bindings: ['a', { project: 'b' }] }), ['a', 'b'], '两种形状混着也要认')
}

/* ---------------------- 接续会话模板（v0.21.0 ③） ---------------------- */

/**
 * 用户原话：「改接续会话提示词，直接让其接上一个会话干的活就行」，
 * 并确认「不是有什么看审查的段吗，把那个删掉」——即去掉要求它汇报「最弱的一维」。
 * 第三次裁定（v0.24.1）：「把接续会话里的分析代码删了吧，这种事交给专门的审查就行了」
 * ——再去掉「结合代码与文档的当前状态判断进度」。
 *
 * 为什么该删：接续会话的读者是**干活的人**，不是评审。让它先报五维最弱项、
 * 或者自己翻代码推进度，都是把「继续做」变成「先做一轮评估」——后者更贵，
 * 因为它要真的把源码读进来。进度该由 `op:audit` 的客观发现给（专门的审查）。
 */
{
  const text = mod.resumeTemplate('demo', '/w/demo/拼图', '/w', null, ['demo'])
  assert.ok(text.includes('接着上一个会话没干完的活'), '接续会话要以「接着干」为主旨')
  assert.ok(text.includes('不要重新问我需求'), '要明确不必重新问需求')
  assert.ok(!text.includes('最弱的一维'), '「最弱一维」那段按用户要求删掉')
  assert.ok(!/审查/.test(text), '接续会话不该提审查')
  // v0.24.1：不再要求模型自己分析代码推进度
  assert.ok(!text.includes('结合代码与文档'), '不该要求「结合代码与文档的当前状态」自己推')
  assert.ok(!text.includes('空壳 / TODO'), '不该要求自己分辨「哪些还是空壳 / TODO」')
  // 但「不要全仓搜」这条护栏必须留着——删了反而更容易乱翻
  assert.ok(text.includes('不要全仓搜'), '要保留「按源码索引跳、不要全仓搜」的护栏')
  assert.ok(text.includes('不要从头重做'), '「不要从头重做」这句要保留')
  // 多绑定：列出全部绑定项目，并说明接续是全局动作（用户裁定 ②）
  const many = mod.resumeTemplate('demo', '/w/demo/拼图', '/w', null, ['demo', 'other', 'third'])
  assert.ok(many.includes('other') && many.includes('third'), '多绑定时要列出全部绑定项目')
  assert.ok(many.includes('全局动作'), '要说清接续是全局动作，别只接当前项目')
  assert.ok(!many.includes('最弱的一维'), '多绑定版本同样不该有「最弱一维」')
  assert.ok(!many.includes('逐个判断进度'), '多绑定版本也不该要求逐个「判断进度」')
  // 单绑定不该冒出多绑定那段（否则是噪音）
  assert.ok(!text.includes('全局动作'), '单绑定时不该有多绑定提示')
}

/* ------------------------ 迁移/重构模板（v0.20.5） ------------------------ */

/**
 * 用户原话：「迁移有没有改提示词了」——迁移/重构**本身就是一段提示词**
 * （`refactorTemplate`，面板按钮把它填进输入框），而 v0.20.0 的 diff
 * 从 `client.js` 第 343 行才开始，模板区一行没碰。
 *
 * 于是它自己与现行规格直接冲突：
 *   1. 只写「每条必须带（源码: 文件:行）」——可 `## 工作流` **不在** `MAIN_ENTRY_SPEC` 里，
 *      不要求出处。模型于是给工作流步骤**编行号**（同一段里还写着「不许编行号」）。
 *   2. 只写「坑 20 字、其余主文档条目 50 字」——可工作流步骤的合法上限是
 *      `WORKFLOW_STEP_LIMIT`（80）。模型会把**合法**步骤砍到 50 以内，
 *      正是 v0.20.2 那个假发现的**镜像**（那次是插件拿 50 的尺子量 80 的步骤）。
 */
{
  const text = mod.refactorTemplate('demo')
  assert.ok(text.includes('## 工作流') || text.includes('工作流 例外'),
    '迁移提示词必须点名工作流是例外，否则模型会拿条目尺子量流水线')
  assert.ok(text.includes('不要求出处'), '迁移提示词必须写明工作流不要求（源码: …）')
  assert.ok(text.includes(String(WORKFLOW_STEP_LIMIT)) && text.includes(String(WORKFLOW_NAME_LIMIT)),
    '迁移提示词里的工作流尺子必须引常量（步骤 ' + WORKFLOW_STEP_LIMIT + ' / 名字 ' + WORKFLOW_NAME_LIMIT + '）')
  // 条目上限也必须引常量：写死就会在改 constants.js 时过期。
  assert.ok(text.includes(String(ENTRY_LIMITS.pit)), '坑的上限要引 ENTRY_LIMITS.pit')
  assert.ok(text.includes(String(ENTRY_CAPS.pending)), '悬而未决条数要引 ENTRY_CAPS.pending')
  // v7 形式：绑定不再是一对一，提示词不能还是 v6 口径。
  assert.ok(!text.includes('一个会话只绑一个'), '提示词不得残留 v6 的一对一绑定口径')
}

/* ------------------------------ 注册契约 ------------------------------ */

const registered = []
const slots = {
  inject(name, callback) {
    registered.push(['inject', name])
    callback()
    return () => {}
  },
  register(options, component) {
    registered.push(['register', options, component])
    return () => {}
  },
}

let effects = 0
mod.apply({
  get(name) {
    return name === 'slots' ? slots : undefined
  },
  effect() {
    effects += 1
    return () => {}
  },
})

const registrations = registered.filter((row) => row[0] === 'register')
assert.equal(registrations.length, 2, '应注册两个 Slot')
const button = registrations.find((row) => row[1].name === 'conversation.input.left')
const panel = registrations.find((row) => row[1].name === 'shell.overlay')
assert.ok(button !== undefined, '按钮必须挂在 conversation.input.left（模型选择器左边）')
assert.equal(button[1].id, 'puzzle-mode-button')
assert.equal(button[1].order, 100)
assert.ok(panel !== undefined, '面板必须挂在 shell.overlay')
assert.equal(panel[1].id, 'puzzle-mode-panel')
assert.equal(panel[1].order, 50)
assert.ok(effects >= 1, '样式注入必须挂在 ctx.effect 上（可随 Fiber 卸载）')

/* --------------------------- 首渲染不抛错 --------------------------- */

const draftCalls = []
const inputActions = {
  setDraft(text) {
    draftCalls.push(text)
  },
  submit() {
    draftCalls.push('SUBMIT-SHOULD-NOT-HAPPEN')
  },
}

const buttonTree = button[2]({ sessionId: 'session-x', inputActions })
assert.equal(buttonTree.type, 'button', '按钮首渲染应是一个 button')
const panelClosed = panel[2]({})
assert.equal(panelClosed, null, '未打开时面板不渲染任何东西')

/**
 * 让假 RPC 的 `fetch → json → then` 三层 promise 链跑完。
 * 单次 `setTimeout(0)` 只放行一个宏任务，不够——面板会停在「读取中」。
 */
async function flush(times = 4) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

/* --------------------- 打开面板 → 图块可点 + 提问模板 --------------------- */

// 模拟点击按钮打开面板：走真实的 onClick。
buttonTree.props.onClick()
await flush()

// 面板此刻应已打开（store 是模块级的，所以面板组件能看到）。
const panelTree = panel[2]({})
assert.ok(panelTree !== null, '点开后应渲染面板')

// 面板里必须已经能拿到 inputActions（从按钮 Slot 传过来）。
// 通过「点提问模板按钮 → setDraft 被调用」来验证，而不是读内部状态。
/**
 * 深度遍历渲染树。注意：**字符串子节点也要参与匹配**，
 * 否则 `h('span', null, '50%')` 里的文本永远找不到。
 */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  if (typeof node !== 'object') return out
  findAll(node.children, predicate, out)
  return out
}

const buttons = findAll(panelTree, (node) => typeof node === 'object' && node.type === 'button' && node.props !== undefined && typeof node.props.onClick === 'function')
// v0.19.8 修：「提问模板」按钮**已按用户裁定删除**（见 lib/client.js 顶部注释），
// 断言反过来 —— 它不该再出现（这是回归护栏，不是放宽）。
const templateButton = buttons.find((node) => Array.isArray(node.children) && node.children.some((child) => child === '提问模板'))
assert.equal(templateButton, undefined, '「提问模板」按钮已删除，不该再出现')
// v0.19.8 修：审查入口不再固定是「审查」字样的 <button>（面板分状态渲染），
// 改成「面板里存在能触发审查的入口」这一契约。
const auditEntry = findAll(panelTree, (node) => typeof node === 'object' && node.props !== undefined
  && typeof node.props.onClick === 'function'
  && JSON.stringify(node.children || []).includes('审查'))
assert.ok(auditEntry.length >= 1, '面板里要能触发「审查」（任意可点入口）')

// 客观发现必须直接渲染出来（含事实与下一步），不能只躺在 RPC 里。
assert.ok(findAll(panelTree, (node) => typeof node === 'string' && node.includes('完成度写 100')).length >= 1, '面板要显示发现的事实')
assert.ok(findAll(panelTree, (node) => typeof node === 'string' && node.includes('把要点补上')).length >= 1, '面板要显示发现的下一步')
assert.ok(findAll(panelTree, (node) => typeof node === 'string' && node.includes('审查 · 客观发现')).length >= 1, '要有审查区块标题')

/* --------------------------- 图块可点开看详情 --------------------------- */

// 面板打开时已经发过 state / list 请求。
assert.ok(requests.some((item) => item.body.method === 'state'), '打开面板应拉 state')
assert.ok(requests.some((item) => item.body.method === 'list'), '打开面板应拉项目列表')

// 找到模块图块并点它。（原注：点「提问模板」会关闭面板 —— 该按钮已删除，此注保留为历史。）
const tiles = findAll(panelTree, (node) => typeof node === 'object' && node.type === 'button' && node.props !== undefined && node.props['data-static'] === '0')
assert.ok(tiles.length >= 1, '模块图块必须是可点的（data-static=0）')
const before = requests.filter((item) => item.body.method === 'module').length
tiles[0].props.onClick()
await flush()
const after = requests.filter((item) => item.body.method === 'module')
assert.equal(after.length, before + 1, '点模块图块应发起 method:module 请求')
assert.equal(after[after.length - 1].body.name, 'auth-flow')

// 详情渲染出来后应包含文档内容。
const panelTree3 = panel[2]({})
assert.ok(findAll(panelTree3, (node) => Array.isArray(node.children) && node.children.includes('要点一')).length >= 1, '详情应显示模块要点')

// 面板必须渲染五维（跨模块均值），且不再出现旧的「完整度/overall」字样。
const dimNames = findAll(panelTree3, (node) => typeof node === 'string' && DIMENSION_NAMES.includes(node))
// 五维名在「跨模块均值」区块出现一次；模块详情展开时还会再出现一次，
// 所以这里断言「五个维度名都出现过」，而不是「恰好出现 5 次」。
for (const name of DIMENSION_NAMES) assert.ok(dimNames.includes(name), `面板必须渲染「${name}」`)
const dimVals = findAll(panelTree3, (node) => typeof node === 'string' && /^\d+%$/.test(node))
assert.ok(dimVals.length >= 5, '五维都要有百分比')
assert.equal(findAll(panelTree3, (node) => typeof node === 'string' && node.includes('完整度')).length, 0, '不该再出现「完整度」')

/* --------------------- 提问模板（放在最后：它会关面板） --------------------- */

// v0.19.8：按现行 markup 定位审查入口（按钮 title = 「让 AI 按五维审查这个项目，并出可执行修复清单」，
// 子节点文本 = 「审查（交给 AI）」），并断言点击后**真的把审查指令填进输入框**（askAi → setDraft）。
const auditButton = buttons.find((node) => node.props !== undefined
  && typeof node.props.title === 'string' && node.props.title.includes('按五维审查'))
assert.ok(auditButton !== undefined, '面板里必须有「审查（交给 AI）」入口')
const draftsBefore = draftCalls.length
auditButton.props.onClick({ target: {}, preventDefault() {}, stopPropagation() {} })
assert.equal(draftCalls.length, draftsBefore + 1, '点审查应恰好调用一次 setDraft')
assert.ok(draftCalls[draftCalls.length - 1].includes('op:audit'), '审查按钮要填审查模板')
assert.ok(!templateButton, '「提问模板」按钮已删除（不应再有第二个填模板入口）')
assert.ok(!draftCalls.includes('SUBMIT-SHOULD-NOT-HAPPEN'), '绝不能自动提交')

console.log('ok   bundle 格式、两个 Slot 注册、图块详情、客观发现渲染、提问/审查模板（setDraft，不自动发送）均通过')

/* ------------- 多绑定切换条（v7）：绑着几个就必须画几个胶囊 ------------- */

/**
 * 这条断言的由来（**回归护栏，不是形式主义**）：
 * 我第一版把「只绑了一个」优化成一行纯文字（`bindings.length === 1 && unbound.length === 0`
 * 时直接 return 文本），结果**单绑定是绝大多数情况** —— 等于切换条平时根本不存在，
 * 用户当场反馈「我的切换绑定被搞没了」。所以这里把「只要绑着就得画出来」钉死：
 * 单绑定要画，多绑定要画，当前项要高亮，`＋` 要在场。
 */
{
  const multiLoaded = []
  const multiRequests = []
  const multiWindow = {
    __ModuleLoader__: { load(entry) { multiLoaded.push(entry) } },
    setInterval() { return 1 },
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
  }
  const multiFetch = (url, options) => {
    const body = JSON.parse(options.body)
    multiRequests.push(body)
    let result
    if (body.method === 'state') {
      result = {
        ok: true, initialized: true, projectRoot: '/tmp/ws3', projectDir: '/tmp/ws3/demo/拼图',
        project: 'demo', mode: '只拼不写', health: 62, version: 7,
        dimensions: {}, modules: [], findings: [],
        // 两个绑定：当前是 demo。面板必须画出**两个**胶囊、且只有 demo 高亮。
        bindings: [
          { project: 'demo', current: true, mode: '只拼不写', health: 62, moduleCount: 3, initialized: true },
          { project: 'second', current: false, mode: '写后再拼', health: 41, moduleCount: 5, initialized: true },
        ],
        currentProject: 'demo', bindingWarnThreshold: 8,
      }
    } else if (body.method === 'list') {
      // 工作区里还有第三个（未绑定）→ `＋` 的候选。
      result = { ok: true, projects: [{ name: 'demo', health: 62 }, { name: 'second', health: 41 }, { name: 'third', health: 10 }] }
    } else {
      result = { ok: true }
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, result }) })
  }
  new Function('window', 'document', 'fetch', source)(
    multiWindow,
    { createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} }, body: {} },
    multiFetch,
  )
  const multiMod = multiLoaded[0].factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('unexpected require: ' + name)
  })
  const multiRegistered = []
  const multiSlots = {
    inject(name, callback) { callback(); return () => {} },
    register(options, component) { multiRegistered.push({ options, component }); return () => {} },
  }
  multiMod.apply({ get: (name) => (name === 'slots' ? multiSlots : undefined), effect: () => () => {} })
  const multiButton = multiRegistered.find((row) => row.options.name === 'conversation.input.left')
  const multiPanel = multiRegistered.find((row) => row.options.name === 'shell.overlay')
  multiButton.component({ sessionId: 'session-multi', inputActions: { setDraft() {}, submit() {} } }).props.onClick()
  await flush()
  const multiTree = multiPanel.component({})

  // 胶囊是 `<button class="dshpz-pill">`。要排除两类：`×`（里面的 span，class 含 pillx）
  // 与 `＋`（class 是 `dshpz-pill dshpz-pill-plus`）——后者也带 pill，用整串精确匹配区分。
  const pillNodes = findAll(multiTree, (node) => typeof node === 'object' && node.type === 'button'
    && node.props !== undefined && node.props.className === 'dshpz-pill')
  assert.equal(pillNodes.length, 2, '绑了两个项目就必须画两个胶囊（不是退化成一行文字）')
  assert.deepEqual(pillNodes.map((node) => node.props['data-on']), ['1', '0'], '只有当前项目那个胶囊高亮')
  assert.equal(pillNodes[0].props.title.includes('当前项目'), true, '当前胶囊要说明自己是当前')
  const plusButton = findAll(multiTree, (node) => typeof node === 'object' && node.type === 'button'
    && node.props !== undefined && typeof node.props.className === 'string'
    && node.props.className.includes('dshpz-pill-plus'))
  assert.equal(plusButton.length, 1, '要有个 ＋ 能再绑一个（工作区里还有未绑定的项目）')
  assert.ok(findAll(multiTree, (node) => typeof node === 'string' && node.includes('当前项目「')).length >= 1,
    '多绑定要说明当前是哪个 + 联动规则')

  // 点另一个胶囊 → 发 method:current（**切当前**，不是改绑）。
  const beforeCurrent = multiRequests.filter((item) => item.method === 'current').length
  pillNodes[1].props.onClick()
  await flush()
  const currentReqs = multiRequests.filter((item) => item.method === 'current')
  assert.equal(currentReqs.length, beforeCurrent + 1, '点胶囊要发 method:current')
  assert.equal(currentReqs[currentReqs.length - 1].project, 'second')
  assert.equal(multiRequests.some((item) => item.method === 'bind'), false, '切当前**不该**发 method:bind（那会改绑定集合）')

  // `×` → 只解绑这一个。
  const beforeUnbind = multiRequests.filter((item) => item.method === 'unbind').length
  const xNode = findAll(multiTree, (node) => typeof node === 'object' && node.props !== undefined
    && typeof node.props.className === 'string' && node.props.className.includes('dshpz-pillx'))
  assert.equal(xNode.length, 2, '每个胶囊都要有个 ×')
  xNode[1].props.onClick({ stopPropagation() {} })
  await flush()
  const unbindReqs = multiRequests.filter((item) => item.method === 'unbind')
  assert.equal(unbindReqs.length, beforeUnbind + 1, '点 × 要发 method:unbind')
  assert.equal(unbindReqs[unbindReqs.length - 1].project, 'second', '× 只解绑它自己那一个')

  console.log('ok   多绑定切换条：绑几个画几个胶囊 / 当前高亮 / 点胶囊切当前 / × 只解一个 / ＋ 在场')

/* ------------- 写操作之后胶囊必须还在（不能等下次轮询才回来） ------------- */

/**
 * 这条断言的由来（用户报「切换项目切着切着胶囊没了」）：
 *
 * 面板把**写操作的返回**整体当成新 `data`，而 `mode` / `workflow` / `bind` / `current`
 * 的返回都是 `summarize(readState(...))`——**一个都不带 `bindings`**（只有 `state` 带）。
 * 于是每做一次写操作，`data.bindings` 就变成 `undefined`，切换条塌成「只有当前项目」
 * 的兜底，要等下一次轮询（最多 8 秒）才恢复。
 *
 * 实测复现：点一下执行模式按钮，胶囊就从 `["aaa","bbb"]` 变成 `["aaa"]`。
 * 「切着切着胶囊没了」正是这个——每切一次空一下。
 */
{
  const swLoaded = []
  const swWindow = {
    __ModuleLoader__: { load(entry) { swLoaded.push(entry) } },
    setInterval() { return 1 },
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
  }
  const SW_BINDINGS = [
    { project: 'aaa', current: true, mode: '只拼不写', health: 60, moduleCount: 2, initialized: true },
    { project: 'bbb', current: false, mode: '写后再拼', health: 40, moduleCount: 1, initialized: true },
  ]
  const swFetch = (url, options) => {
    const body = JSON.parse(options.body)
    let result
    if (body.method === 'state') {
      result = { ok: true, initialized: true, projectRoot: '/tmp/ws5', projectDir: '/tmp/ws5/aaa/拼图', project: 'aaa', mode: '只拼不写', health: 60, version: 7, dimensions: {}, modules: [], findings: [], bindings: SW_BINDINGS, currentProject: 'aaa', bindingWarnThreshold: 8 }
    } else if (body.method === 'list') {
      result = { ok: true, projects: [{ name: 'aaa', health: 60 }, { name: 'bbb', health: 40 }] }
    } else {
      // 写操作（mode / current / bind / workflow）的**真实现形状**：没有 `bindings`。
      result = { ok: true, initialized: true, project: 'aaa', mode: body.mode, health: 60, version: 7, dimensions: {}, modules: [], findings: [] }
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, result }) })
  }
  new Function('window', 'document', 'fetch', source)(
    swWindow,
    { createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} }, body: {} },
    swFetch,
  )
  const swMod = swLoaded[0].factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('unexpected require: ' + name)
  })
  const swRegs = []
  const swSlots = { inject(name, cb) { cb(); return () => {} }, register(o, c) { swRegs.push({ o, c }); return () => {} } }
  swMod.apply({ get: (n) => (n === 'slots' ? swSlots : undefined), effect: () => () => {} })
  const swBtn = swRegs.find((r) => r.o.name === 'conversation.input.left')
  const swPanel = swRegs.find((r) => r.o.name === 'shell.overlay')
  swBtn.c({ sessionId: 'session-sw', inputActions: { setDraft() {}, submit() {} } }).props.onClick()
  await flush()
  let swTree = swPanel.c({})

  const pillNames = (tree) => findAll(tree, (node) => typeof node === 'object' && node.props !== undefined
    && node.props.className === 'dshpz-pill')
    .map((node) => {
      const span = node.children.find((c) => typeof c === 'object' && c.props !== undefined && c.props.className === 'dshpz-pillname')
      return span === undefined ? '?' : span.children[0]
    })
  assert.deepEqual(pillNames(swTree), ['aaa', 'bbb'], '初始应有两个胶囊')

  // 点一下执行模式按钮（一个**写操作**，返回不带 bindings）。
  const modeBtn = findAll(swTree, (node) => typeof node === 'object' && node.type === 'button'
    && Array.isArray(node.children) && node.children.includes('写后再拼'))[0]
  assert.ok(modeBtn !== undefined, '要能找到「写后再拼」模式按钮')
  modeBtn.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  swTree = swPanel.c({})
  assert.deepEqual(pillNames(swTree), ['aaa', 'bbb'],
    '写操作之后胶囊**不能塌掉**（这是「切着切着胶囊没了」的根因：写操作返回不带 bindings）')
  console.log('ok   写操作之后胶囊还在：返回缺 bindings 时客户端合并保留绑定组')
}

/* ------------- 空态多绑定：勾选 → 点「绑定选中的 N 个」必须发得出去 ------------- */

/**
 * 这条断言的由来（用户报「选中以后点绑定不行会闪出红框」）：
 * 空态「多绑定」模式勾选后点按钮，客户端发的是 `projects: [...]`、**没有 `project` 字段**，
 * 而 RPC 的入参守卫当时写成「没有 project 就 400」——请求永远被挡，面板弹红框。
 * 这里把**界面发出的载荷形状**钉死：只带 `projects` 数组。服务端那一半由 30-rpc 覆盖。
 */
{
  const multiLoaded = []
  const multiRequests = []
  const multiWindow = {
    __ModuleLoader__: { load(entry) { multiLoaded.push(entry) } },
    setInterval() { return 1 },
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
  }
  const multiFetch = (url, options) => {
    const body = JSON.parse(options.body)
    multiRequests.push(body)
    let result
    if (body.method === 'state') {
      result = { ok: true, initialized: false, projectRoot: '/tmp/ws4', projectDir: '', project: '', mode: '只拼不写', modeSource: 'default', health: 0, dimensions: {}, sections: {}, cwdSource: 'session', projectSource: 'none', modules: [] }
    } else if (body.method === 'list') {
      result = { ok: true, projectCount: 2, defaultProject: 'demo', projects: [{ name: 'demo', health: 62 }, { name: 'two', health: 41 }] }
    } else {
      result = { ok: true }
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, result }) })
  }
  new Function('window', 'document', 'fetch', source)(
    multiWindow,
    { createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} }, body: {} },
    multiFetch,
  )
  const multiMod = multiLoaded[0].factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('unexpected require: ' + name)
  })
  const regs = []
  const sl = { inject(name, cb) { cb(); return () => {} }, register(o, c) { regs.push({ o, c }); return () => {} } }
  multiMod.apply({ get: (n) => (n === 'slots' ? sl : undefined), effect: () => () => {} })
  const btn = regs.find((r) => r.o.name === 'conversation.input.left')
  const pnl = regs.find((r) => r.o.name === 'shell.overlay')
  btn.c({ sessionId: 'session-ms', inputActions: { setDraft() {}, submit() {} } }).props.onClick()
  await flush()
  let tree = pnl.c({})

  const multiMode = findAll(tree, (node) => typeof node === 'object' && node.type === 'button'
    && Array.isArray(node.children) && node.children.includes('多绑定'))[0]
  assert.ok(multiMode !== undefined, '空态要有「多绑定」模式按钮')
  multiMode.props.onClick()
  tree = pnl.c({})

  const boxes = findAll(tree, (node) => typeof node === 'object' && node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(boxes.length, 2, '多绑定模式要给每个已有项目一个勾选框')
  boxes[0].props.onChange()
  tree = pnl.c({})

  const bindBtn = findAll(tree, (node) => typeof node === 'object' && node.type === 'button'
    && Array.isArray(node.children) && node.children.some((c) => typeof c === 'string' && c.startsWith('绑定选中的')))[0]
  assert.ok(bindBtn !== undefined, '要有一颗「绑定选中的 N 个」按钮')
  assert.equal(bindBtn.props.disabled, false, '勾了一个之后按钮不该还是禁用的')
  bindBtn.props.onClick()
  await flush()

  const binds = multiRequests.filter((item) => item.method === 'bind')
  assert.equal(binds.length, 1, '点一次要恰好发一次 bind')
  assert.deepEqual(binds[0].projects, ['demo'], '载荷要带 projects 数组')
  assert.equal(binds[0].project, undefined, '**不该**带 project 字段——服务端守卫必须认 projects（这是红框的由来）')
  console.log('ok   空态多绑定：勾选 → 点绑定 → 载荷只带 projects 数组（服务端必须认它）')
}
}

/* ------------- 空态：新会话默认空绑定 → 建项目 / 绑定已有项目 ------------- */

// 第二次加载：让 state 返回 initialized:false，才能真正渲染空态分支。
const emptyLoaded = []
const emptyRequests = []
const emptyWindow = {
  __ModuleLoader__: { load(entry) { emptyLoaded.push(entry) } },
  setInterval() { return 1 },
  clearInterval() {},
  addEventListener() {},
  removeEventListener() {},
}
const emptyFetch = (url, options) => {
  const body = JSON.parse(options.body)
  emptyRequests.push(body)
  let result
  if (body.method === 'state') {
    result = {
      ok: true, initialized: false, projectRoot: '/tmp/ws2', projectDir: '', project: '',
      mode: '只拼不写', modeSource: 'default', health: 0, dimensions: {}, sections: {},
      cwdSource: 'session', projectSource: 'none', modules: [],
    }
  } else if (body.method === 'list') {
    result = { ok: true, projectCount: 1, defaultProject: 'demo', projects: [{ name: 'demo', health: 62 }] }
  } else {
    result = { ok: true }
  }
  return Promise.resolve({ json: () => Promise.resolve({ ok: true, result }) })
}
new Function('window', 'document', 'fetch', source)(
  emptyWindow,
  { createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} }, body: {} },
  emptyFetch,
)
assert.equal(emptyLoaded.length, 1, '第二次加载也要注册 bundle')
const emptyMod = emptyLoaded[0].factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error('unexpected require: ' + name)
})
const emptyRegistered = []
const emptySlots = {
  inject(name, callback) { callback(); return () => {} },
  register(options, component) { emptyRegistered.push({ options, component }); return () => {} },
}
emptyMod.apply({ get: (name) => (name === 'slots' ? emptySlots : undefined), effect: () => () => {} })
const emptyButton = emptyRegistered.find((row) => row.options.name === 'conversation.input.left')
const emptyPanel = emptyRegistered.find((row) => row.options.name === 'shell.overlay')
const emptyDrafts = []
const emptyActions = {
  setDraft(text) { emptyDrafts.push(text) },
  submit() { emptyDrafts.push('SUBMIT-SHOULD-NOT-HAPPEN') },
}
const emptyButtonTree = emptyButton.component({ sessionId: 'session-new', inputActions: emptyActions })
emptyButtonTree.props.onClick()
await flush()
const emptyTree = emptyPanel.component({})
assert.ok(emptyTree !== null, '空态也要渲染面板')
assert.ok(findAll(emptyTree, (node) => typeof node === 'string' && node.includes('不会自动占用')).length >= 1, '空态要说清不会自动占用别人的项目')
// v0.24.1（用户裁定「中间的白色大块占位删了，没用」）：那块虚线占位卡要真删掉。
// 它跟顶部副标题「本会话未绑定项目」重复，又占着中栏最值钱的位置。
// **但信息不能一起删**——上面那条「不会自动占用」的断言仍须通过，所以是降级成一行提示。
{
  const card = findAll(emptyTree, (node) => typeof node === 'object' && node !== null && node.props !== undefined && node.props.className === 'dshpz-empty')
  assert.equal(card.length, 0, '空态中栏不该再有虚线占位卡（dshpz-empty）')
  const cardIcon = findAll(emptyTree, (node) => typeof node === 'object' && node !== null && node.props !== undefined && node.props.className === 'dshpz-emptyicon')
  assert.equal(cardIcon.length, 0, '占位卡的图标要一起删')
  const cardTitle = findAll(emptyTree, (node) => typeof node === 'object' && node !== null && node.props !== undefined && node.props.className === 'dshpz-emptytitle')
  assert.equal(cardTitle.length, 0, '占位卡的标题（与副标题重复）要一起删')
}
const emptyButtons = findAll(emptyTree, (node) => typeof node === 'object' && node.type === 'button' && node.props !== undefined && typeof node.props.onClick === 'function')
const quickButton = emptyButtons.find((node) => Array.isArray(node.children) && node.children.some((child) => child === '快速建空壳'))
const interviewButton = emptyButtons.find((node) => Array.isArray(node.children) && node.children.some((child) => child === '采访后再建'))
assert.ok(quickButton !== undefined, '空态必须有「快速建空壳」')
assert.ok(interviewButton !== undefined, '空态必须有「采访后再建」')
quickButton.props.onClick()
interviewButton.props.onClick()
assert.equal(emptyDrafts.length, 2, '两个按钮各填一次模板')
assert.ok(emptyDrafts[0].includes('op:init'), '快速建空壳填的是 op:init 模板')
// v0.19.8：额度不再写死，改引 ASK_MAX_QUESTIONS —— 以后调上限不必回来改断言。
assert.ok(emptyDrafts[1].includes('最多 ' + ASK_MAX_QUESTIONS + ' 问'), '采访后再建填的是采访模板（额度引常量）')
assert.ok(!emptyDrafts.includes('SUBMIT-SHOULD-NOT-HAPPEN'), '绝不能自动提交')
  // 绑定已有项目：空态要列出现有项目并能一键绑定。
  const bindButton = findAll(emptyTree, (node) => typeof node === 'object' && node.type === 'button' && Array.isArray(node.children) && node.children.some((child) => child === '绑定'))[0]
  assert.ok(bindButton !== undefined, '空态要能绑定已有项目')
  bindButton.props.onClick()
  await flush()
  assert.ok(emptyRequests.some((item) => item.method === 'bind' && item.project === 'demo'), '点绑定要发 method:bind')
  console.log('ok   空态：快速建空壳 / 采访后再建 / 绑定已有项目（都走 setDraft 或 RPC，不自动提交）')

  // 表单直建：三个输入框 + 「立刻建」按钮必须在场（值由 store 驱动，见下）。
  const formInputs = findAll(emptyTree, (node) => typeof node === 'object' && node.type === 'input')
  assert.equal(formInputs.length, 3, '空态表单要有三个输入框（项目名 / 模块名 / 目标）')
  assert.ok(formInputs.every((node) => typeof node.props.onChange === 'function'), '三个输入框都要能改（onChange 在场）')
  const createButton = findAll(emptyTree, (node) => typeof node === 'object' && node.type === 'button' && Array.isArray(node.children) && node.children.some((child) => child === '立刻建'))[0]
  assert.ok(createButton !== undefined, '空态要有「立刻建」（表单直建）')
  assert.equal(typeof emptyMod.createByForm, 'function', '表单直建要可测（导出）')
  // 直接驱动导出的 createByForm：假 React 的 setState 是空函数，改不了 store 里的表单值，
  // 所以这里传一个自定义 view —— 这正是把它导出的理由。
  const beforeCreate = emptyRequests.filter((item) => item.method === 'create').length
  emptyMod.createByForm({ state: { sessionId: 'session-form', formProject: '   ', formModules: 'a', formGoal: '' } })
  await flush()
  assert.equal(emptyRequests.filter((item) => item.method === 'create').length, beforeCreate, '项目名为空时不该发 create')
  emptyMod.createByForm({ state: { sessionId: undefined, formProject: 'x' } })
  await flush()
  assert.equal(emptyRequests.filter((item) => item.method === 'create').length, beforeCreate, '没有会话 ID 时不该发 create')
  emptyMod.createByForm({ state: { sessionId: 'session-form', formProject: ' 表单项目 ', formModules: 'a, b、c d', formGoal: ' 一句话 ' } })
  await flush()
  const created = emptyRequests.filter((item) => item.method === 'create')
  assert.equal(created.length, beforeCreate + 1, '填好后要发 create')
  assert.equal(created[created.length - 1].project, '表单项目', '项目名要去首尾空格')
  assert.deepEqual(created[created.length - 1].modules, ['a', 'b', 'c', 'd'], '模块名按逗号/顿号/空格切')
  assert.equal(created[created.length - 1].goal, '一句话')
  console.log('ok   空态表单直建：三个输入框在场，填名 → 发 method:create（不经过模型，模块名按分隔符切）')

/* ---------- 面板不叠遮罩 / 主题页是主界面切换，不是第二层浮层（v0.27.1） ---------- */

/**
 * 用户两条原话：「打开面板的遮罩删掉」「换成主题页改为直接切换原本的主界面」。
 *
 * 两条都是**同一类问题**：屏幕上不该同时出现两层「面板」。所以断言也按这个形状写：
 *
 *   ① 主界面：整棵树里**没有** `background` 遮罩（样式表里 `.dshpz-backdrop` 不再压暗，
 *      内联兜底也不再写 rgba —— 只删样式表、兜底又写回来是**假修**，这条能抓到）；
 *   ② 主题页：它**就是**面板主体（`.dshpz-panel` 恰好一层），不是 `.dshpz-tlayer`
 *      那种全屏浮层；两层玻璃框、两个关闭按钮都不许再出现。
 *
 * 为什么断言「整棵树的层数」而不是断言某个类名存在：这次的 bug 特征正是
 * **多一层看不出来**（视觉上只是玻璃底变厚、Esc 要多按一次），
 * 只有数层数才抓得住。
 */
{
  const thReqs = []
  const thWindow = {
    __ModuleLoader__: { load(entry) { thReqs.push(entry) } },
    setInterval() { return 1 }, clearInterval() {}, addEventListener() {}, removeEventListener() {},
  }
  const thState = {
    ok: true, initialized: true, projectRoot: '/tmp/ws-th', projectDir: '/tmp/ws-th/demo/拼图',
    project: 'demo', mode: '写后再拼', health: 77, version: 7, dimensions: {}, modules: [], findings: [],
    bindings: [{ project: 'demo', current: true, mode: '写后再拼', health: 77, moduleCount: 1, initialized: true }],
    currentProject: 'demo', bindingWarnThreshold: 8, size: SIZE_MEDIUM,
    theme: { current: '', currentName: '', installed: [], repo: 'liancha22/dsh-puzzle-themes', apiVersion: 1, dir: '/tmp/themes' },
    limits: {
      askQuestions: 10, askOptions: 10, entryLimits: ENTRY_LIMITS, entryCaps: capsOfSize(SIZE_MEDIUM),
      workflowNameLimit: WORKFLOW_NAME_LIMIT, workflowStepLimit: WORKFLOW_STEP_LIMIT, workflowMaxSteps: 12,
      bindingWarnThreshold: 8, sizeCaps: SIZE_CAPS, sizes: SIZES,
    },
  }
  const thFetch = (url, options) => {
    const body = JSON.parse(options.body)
    let result
    if (body.method === 'state') result = thState
    else if (body.method === 'list') result = { ok: true, projects: [{ name: 'demo', health: 77 }] }
    else if (body.method === 'theme') result = { ok: true, themes: [], tried: [] }
    else result = { ok: true }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, result }) })
  }
  new Function('window', 'document', 'fetch', source)(
    thWindow,
    { createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} }, body: {} },
    thFetch,
  )
  const thMod = thReqs[0].factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('unexpected require: ' + name)
  })
  const thRegistered = []
  const thSlots = {
    inject(name, callback) { callback(); return () => {} },
    register(options, component) { thRegistered.push({ options, component }); return () => {} },
  }
  thMod.apply({ get: (name) => (name === 'slots' ? thSlots : undefined), effect: () => () => {} })
  const thButton = thRegistered.find((row) => row.options.name === 'conversation.input.left')
  const thPanel = thRegistered.find((row) => row.options.name === 'shell.overlay')
  thButton.component({ sessionId: 'session-theme-view', inputActions: { setDraft() {}, submit() {} } }).props.onClick()
  await flush()
  let thTree = thPanel.component({})

  /** 数出某个类名在整棵树里出现的次数。 */
  const countClass = (tree, className) => findAll(tree, (node) => typeof node === 'object' && node !== null
    && node.props !== undefined && typeof node.props.className === 'string'
    && node.props.className.split(/\s+/).includes(className)).length

  /* ① 遮罩：样式表与内联兜底都不许再有压暗底色。 */
  const backdropCss = mod.CSS.split('\n').find((line) => line.indexOf('.dshpz-backdrop{') === 0) || ''
  assert.ok(backdropCss !== '', '样式表里必须还有 .dshpz-backdrop 这条（它负责居中与点外部关闭）')
  assert.ok(!/background/.test(backdropCss), '遮罩层不许再画背景（用户要求删掉遮罩），实际：' + backdropCss)
  const backdropNode = findAll(thTree, (node) => typeof node === 'object' && node !== null
    && node.props !== undefined && typeof node.props.className === 'string'
    && node.props.className.split(/\s+/).includes('dshpz-backdrop'))[0]
  assert.ok(backdropNode !== undefined, '主界面仍要有那层定位壳（居中 + 点外部关闭）')
  assert.equal(backdropNode.props.style.background, undefined,
    '内联兜底也不许写 background —— 否则「样式表删了、兜底又加回来」是假修')
  console.log('ok   面板遮罩：样式表与内联兜底都不再压暗（点外部关闭与居中仍在）')

  /* ② 主题页 = 主界面切换：一层面板，不是第二层全屏浮层。 */
  const themeIcon = findAll(thTree, (node) => typeof node === 'object' && node.type === 'button'
    && node.props !== undefined && typeof node.props.onClick === 'function'
    && node.props.title !== undefined && String(node.props.title).indexOf('主题') === 0)[0]
  assert.ok(themeIcon !== undefined, '面板一角要能找到主题入口按钮')
  assert.equal(countClass(thTree, 'dshpz-panel'), 1, '主界面同时只能有一层 .dshpz-panel')

  themeIcon.props.onClick()
  thTree = thPanel.component({})
  assert.equal(countClass(thTree, 'dshpz-tlayer'), 0, '主题页不许再是全屏浮层（dshpz-tlayer 应已删除）')
  assert.equal(countClass(thTree, 'dshpz-tpanel'), 0, '主题页不许再有第二套玻璃框（dshpz-tpanel 应已删除）')
  assert.equal(countClass(thTree, 'dshpz-panel'), 1,
    '主题页就是面板主体本身：整棵树仍只有一层 .dshpz-panel（多一层＝又叠回去了）')
  // 主题页在场：它的标题与卡片区在。
  assert.ok(findAll(thTree, (node) => node === '主题').length >= 1, '切过去要真的是主题页')
  // 语义是「返回」而不是第二个「关闭」：按钮文案要点名返回，免得用户分不清哪个关面板。
  // 文案在 `span` 里（`h('button', …, h('span', null, '← 返回'))`），所以按**子树**找，
  // 不能只比 button 的直接子节点。
  const backBtn = findAll(thTree, (node) => typeof node === 'object' && node !== null && node.type === 'button'
    && findAll(node, (child) => child === '← 返回').length > 0)[0]
  assert.ok(backBtn !== undefined, '主题页要有「返回」而不是第二个「关闭」（两个 × 会让人分不清）')
  backBtn.props.onClick()
  thTree = thPanel.component({})
  assert.ok(findAll(thTree, (node) => typeof node === 'object' && node !== null
    && node.props !== undefined && typeof node.props.className === 'string'
    && node.props.className.split(/\s+/).includes('dshpz-body')).length >= 1, '点返回要真的回到三栏主界面')
  console.log('ok   主题页：直接切换主界面（全树只有一层 .dshpz-panel），返回回到项目面板')
}

