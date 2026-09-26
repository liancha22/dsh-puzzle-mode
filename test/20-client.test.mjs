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

const here = dirname(fileURLToPath(import.meta.url))
const DIMENSION_NAMES = ['任务复杂度', '可拓展性', '维护系数', '代码质量', '可复用性']
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
assert.equal(typeof mod.questionTemplate, 'function', '提问模板必须可测（导出）')

/* ---------------------------- 提问模板内容 ---------------------------- */

{
  const text = mod.questionTemplate('登录重构')
  assert.ok(text.includes('登录重构'))
  assert.ok(text.includes('要不要先停下？'), '模板必须含固定收尾问')
  assert.ok(text.includes('停下，等我看过再说') && text.includes('继续，不用停'), '模板必须含两个固定选项')
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
const templateButton = buttons.find((node) => Array.isArray(node.children) && node.children.some((child) => child === '提问模板'))
assert.ok(templateButton !== undefined, '面板里必须有「提问模板」按钮')

/* --------------------------- 图块可点开看详情 --------------------------- */

// 面板打开时已经发过 state / list 请求。
assert.ok(requests.some((item) => item.body.method === 'state'), '打开面板应拉 state')
assert.ok(requests.some((item) => item.body.method === 'list'), '打开面板应拉项目列表')

// 找到模块图块并点它。注意顺序：点「提问模板」会关闭面板（这是设计），
// 所以图块相关断言必须放在那之前。
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

templateButton.props.onClick()
assert.equal(draftCalls.length, 1, '点提问模板应恰好调用一次 setDraft')
assert.ok(draftCalls[0].includes('要不要先停下？'), '填进输入框的模板必须含固定收尾问')
assert.ok(!draftCalls.includes('SUBMIT-SHOULD-NOT-HAPPEN'), '绝不能自动提交')

console.log('ok   bundle 格式、两个 Slot 注册、图块详情与提问模板（setDraft，不自动发送）均通过')
