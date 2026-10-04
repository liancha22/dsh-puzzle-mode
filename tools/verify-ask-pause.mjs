/**
 * 「固定收尾问」全局开关的**端到端**验证：走真实 RPC 通道。
 *
 *   node tools/verify-ask-pause.mjs
 *
 * 为什么不能只靠 test/80-ask-pause.test.mjs：那个文件测的是 `lib/settings.js` 与
 * `pauseFields()` 这些**纯函数**。而「关掉之后模型还问不问」取决于三处**接线**：
 *   ① RPC `method:settings` 认不认 `askPause` 这个字段；
 *   ② 工具返回（`state` / `op:read` / `op:settings`）里的 `askPause` 是不是跟着变；
 *   ③ 提示段正文有没有换成「不问」的那一份。
 * 纯函数全绿而接线断了，是本仓反复记过的「假绿」。
 *
 * 它需要 `@deepseek-ai/dsh-tools`（宿主半 import 了它）。装不上就明确跳过。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离 DSH_HOME：别动用户真实的设置。
const HOME = mkdtempSync(join(tmpdir(), 'puzzle-pause-e2e-'))
process.env.DSH_HOME = HOME

let host = null
try {
  host = await import('../lib/index.js')
} catch (error) {
  const code = error === null || error === undefined ? undefined : error.code
  console.log('skip verify-ask-pause.mjs：' + (code === 'ERR_MODULE_NOT_FOUND'
    ? '找不到 @deepseek-ai/dsh-tools（本目录未装进 DSH profile），跳过'
    : String(error && error.message ? error.message : error)))
  process.exit(0)
}

const root = mkdtempSync(join(tmpdir(), 'puzzle-pause-ws-'))
let passed = 0
const ok = (name) => { passed += 1; console.log('ok   ' + name) }

/** 截下宿主注册的提示段函数与 RPC 处理器。 */
function capture() {
  let route = null
  let promptFn = null
  host.apply({
    systemPrompt: { section(options) { promptFn = options.text } },
    tools: { register() { return () => {} } },
    on() { return () => {} },
    effect() {},
    get(name) {
      if (name !== 'sessions') return undefined
      return { get() { return { header: { cwd: root } } } }
    },
    inject(_names, fn) {
      fn({
        connection: { requestRejection() { return undefined } },
        webServer: { register(definition) { route = definition; return () => {} } },
        // `effect` 必须**真的执行回调**：插件把 `register` 包在 `effect(...)` 里
        // （用来在卸载时回收路由）。不执行就永远注册不上，测试只会看到 null。
        effect(callback) {
          if (typeof callback === 'function') callback()
          return () => {}
        },
      })
    },
  })
  return { getRoute: () => route, getPrompt: () => promptFn }
}
function fakeReq(body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    method: 'POST',
    headers: {},
    setEncoding() {},
    on(event, fn) {
      if (event === 'data') fn(text)
      if (event === 'end') fn()
    },
  }
}

function fakeRes() {
  const out = {}
  return {
    out,
    writeHead(status) { out.status = status },
    end(payload) { out.body = payload === undefined ? null : JSON.parse(payload) },
  }
}

async function call(handler, body) {
  const res = fakeRes()
  await handler(fakeReq(body), res)
  return res.out
}

try {
  const { getRoute, getPrompt } = capture()
  // `webServer.register` 收到的是**定义对象** `{ kind, path, handler }`，
  // 不是裸函数——所以要取 `.handler`。
  const definition = getRoute()
  const handler = definition !== null && definition !== undefined ? definition.handler : null
  assert.equal(typeof handler, 'function', 'RPC 处理器必须注册上')
  const sessionId = 'session-pause-e2e'

  /* ---------------- 1) 默认：开 ---------------- */
  {
    const out = await call(handler, { method: 'settings', sessionId })
    assert.equal(out.body.ok, true)
    assert.equal(out.body.result.askPause, true, '默认必须是开（老行为不变）')
    ok('RPC settings 查询 → askPause 默认 true')
  }

  /* ---------------- 2) 提示段此刻要求收尾问 ---------------- */
  // 提示段里收尾问的**可判据**是这两句（见 POLICY_BODY）：
  //   「提问的最后一项固定问」= 要求带上它；「固定收尾问已**全局关闭**」= 要求别问。
  const promptOn = getPrompt()({ agent: { session: { id: sessionId } } })
  assert.ok(promptOn.includes('提问的最后一项固定问'), '开着时提示段必须要求收尾问')
  assert.ok(promptOn.includes('要不要先停下？'), '开着时提示段要写出收尾问原文')
  assert.ok(!promptOn.includes('固定收尾问已**全局关闭**'), '开着时不该出现「已关闭」那句')
  ok('提示段（开）→ 要求固定收尾问')

  /* ---------------- 3) 关掉 ---------------- */
  {
    const out = await call(handler, { method: 'settings', sessionId, askPause: false })
    assert.equal(out.body.ok, true, '关必须成功：' + JSON.stringify(out.body))
    assert.equal(out.body.result.askPause, false)
    ok('RPC settings askPause:false → 已关闭')
  }

  /* ---------------- 4) 工具返回跟着变 ---------------- */
  {
    const out = await call(handler, { method: 'state', sessionId })
    assert.equal(out.body.result.askPause, false, 'state 返回的 askPause 必须跟着变')
    assert.equal(Object.hasOwn(out.body.result, 'pauseQuestion'), false,
      '关掉后 state 不该再下发收尾问文案（留着它模型就会继续问）')
    ok('RPC state → askPause:false 且不再带收尾问文案')
  }

  /* ---------------- 5) 提示段换成「不问」那一份 ---------------- */
  const promptOff = getPrompt()({ agent: { session: { id: sessionId } } })
  assert.ok(!promptOff.includes('提问的最后一项固定问'), '关掉后不该再要求「最后一项固定问」')
  assert.ok(promptOff.includes('固定收尾问已**全局关闭**'), '关掉后提示段要明说已关闭')
  assert.ok(promptOff.includes('不要再追加一轮'), '关掉后要给出明确指令')
  ok('提示段（关）→ 明确说「已全局关闭、不要再问」')

  /* ---------------- 6) 再打开 ---------------- */
  {
    const out = await call(handler, { method: 'settings', sessionId, askPause: true })
    assert.equal(out.body.result.askPause, true)
    const state = await call(handler, { method: 'state', sessionId })
    assert.equal(state.body.result.askPause, true)
    assert.equal(state.body.result.pauseQuestion, '要不要先停下？', '重新打开后文案要回来')
    const prompt = getPrompt()({ agent: { session: { id: sessionId } } })
    assert.ok(prompt.includes('提问的最后一项固定问'), '重新打开后提示段要恢复要求')
    ok('重新打开 → 返回与提示段都恢复')
  }

  /* ---------------- 7) 开关不影响「按会话禁用」 ---------------- */
  {
    // 关掉收尾问不该把会话也禁了（两个开关共用一个文件，最容易互相盖掉）。
    await call(handler, { method: 'settings', sessionId, askPause: false })
    const state = await call(handler, { method: 'state', sessionId })
    assert.equal(state.body.result.askPause, false)
    const prompt = getPrompt()({ agent: { session: { id: sessionId } } })
    assert.notEqual(prompt, '', '关收尾问**不该**让整个提示段消失（那是「禁用会话」的效果）')
    ok('关收尾问不影响会话本身（提示段仍在，只是不问收尾）')
  }
} finally {
  rmSync(root, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
}

console.log('')
console.log('固定收尾问开关端到端：' + passed + ' 项通过')
