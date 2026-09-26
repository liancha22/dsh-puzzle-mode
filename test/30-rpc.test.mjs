/**
 * RPC 路由测试：把宿主半注册的 `/puzzle-mode-rpc` 处理器截下来，用假的 req/res 驱动。
 * 覆盖：鉴权拒绝、非 POST、坏正文、缺 sessionId、state / list / module / mode、未知 method。
 *
 *   node test/30-rpc.test.mjs
 *
 * 宿主半 import 了 `@deepseek-ai/dsh-tools`（由 DSH 运行时提供）。在没装 DSH 的
 * 裸目录里这一组无法运行，此时**明确跳过**并说明原因，而不是抛 ERR_MODULE_NOT_FOUND。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject, readState } from '../lib/puzzle.js'

let host
try {
  host = await import('../lib/index.js')
} catch (error) {
  const code = error === null || error === undefined ? undefined : error.code
  console.log(`skip 30-rpc.test.mjs：${code === 'ERR_MODULE_NOT_FOUND' ? '找不到 @deepseek-ai/dsh-tools（本目录未装进 DSH profile），跳过' : String(error && error.message ? error.message : error)}`)
  process.exit(0)
}

const root = mkdtempSync(join(tmpdir(), 'puzzle-rpc-'))
let passed = 0

function ok(name) {
  passed += 1
  console.log(`ok   ${name}`)
}

/** 摘出宿主半注册的 RPC 处理器。 */
function captureRoute({ reject = false } = {}) {
  let route = null
  host.apply({
    systemPrompt: { section() {} },
    tools: { register() { return () => {} } },
    on() { return () => {} },
    effect() {},
    get(name) {
      if (name !== 'sessions') return undefined
      return {
        get(id) {
          return id === 'session-x' ? { header: { cwd: root } } : undefined
        },
      }
    },
    inject(keys, callback) {
      assert.deepEqual(keys, ['webServer', 'connection'])
      callback({
        effect(cb) {
          cb()
          return () => {}
        },
        webServer: {
          register(options) {
            route = options
            return () => {}
          },
        },
        connection: {
          requestRejection() {
            return reject ? 401 : undefined
          },
        },
      })
    },
  })
  assert.ok(route !== null, '必须注册 /puzzle-mode-rpc 路由')
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, '/puzzle-mode-rpc')
  return route.handler
}

/** 假 req：只有 setEncoding/on 与可读正文。 */
function fakeReq({ method = 'POST', body = '' } = {}) {
  const handlers = {}
  const req = {
    method,
    setEncoding() {},
    on(event, fn) {
      handlers[event] = fn
      return req
    },
    destroy() {},
  }
  queueMicrotask(() => {
    if (handlers.data !== undefined && body !== '') handlers.data(body)
    if (handlers.end !== undefined) handlers.end()
  })
  return req
}

/** 假 res：记下 status 与 JSON 正文。 */
function fakeRes() {
  const out = { status: 0, body: null, headers: null }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers
    },
    end(payload) {
      out.body = payload === undefined ? null : JSON.parse(payload)
    },
  }
}

async function call(handler, options) {
  const res = fakeRes()
  await handler(fakeReq(options), res)
  return res.out
}

try {
  createProject(root, 'demo', '目标', ['auth-flow'])

  {
    const handler = captureRoute({ reject: true })
    const out = await call(handler, { body: JSON.stringify({ method: 'state', sessionId: 'session-x' }) })
    assert.equal(out.status, 401)
    ok('鉴权失败 → 401')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { method: 'GET', body: '' })
    assert.equal(out.status, 405)
    ok('非 POST → 405')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { body: 'not json' })
    assert.equal(out.status, 400)
    ok('坏正文 → 400')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'state' }) })
    assert.equal(out.status, 400)
    assert.equal(out.body.error, '缺少 sessionId')
    ok('缺 sessionId → 400')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'state', sessionId: 'session-x' }) })
    assert.equal(out.status, 200)
    assert.equal(out.body.ok, true)
    assert.equal(out.body.result.initialized, true)
    assert.equal(out.body.result.project, 'demo')
    assert.equal(out.body.result.askPause, true)
    assert.equal(out.body.result.pauseQuestion, '要不要先停下？')
    assert.ok(out.body.result.pieces.length >= 8)
    ok('state → 返回完整度与图块')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'mode', sessionId: 'session-x', mode: '边拼边写' }) })
    assert.equal(out.body.ok, true)
    assert.equal(out.body.result.mode, '边拼边写')
    assert.equal(out.body.result.canExecute, true)
    assert.equal(readState(root, 'demo').mode, '边拼边写')
    ok('mode → 写回主文档并返回新状态')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'mode', sessionId: 'session-x', mode: '乱写' }) })
    assert.equal(out.status, 400)
    ok('未知 mode → 400')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'nope', sessionId: 'session-x' }) })
    assert.equal(out.status, 400)
    ok('未知 method → 400')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'list', sessionId: 'session-x' }) })
    assert.equal(out.status, 200)
    assert.equal(out.body.ok, true)
    assert.equal(out.body.result.projectCount >= 1, true)
    assert.ok(Array.isArray(out.body.result.projects))
    ok('list → 返回项目清单与默认项目')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'module', sessionId: 'session-x', name: 'auth-flow' }) })
    assert.equal(out.status, 200)
    assert.equal(out.body.ok, true)
    assert.equal(out.body.result.exists, true)
    assert.equal(typeof out.body.result.detail, 'string')
    ok('module → 返回模块详情')
  }

  {
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'module', sessionId: 'session-x' }) })
    assert.equal(out.status, 400)
    ok('module 缺 name → 400')
  }

  {
    // 显式指定项目：不存在的项目名 → 状态应显示未初始化，而不是静默换成别的项目。
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'state', sessionId: 'session-x', project: 'nope' }) })
    assert.equal(out.body.result.initialized, false)
    assert.equal(out.body.result.projectRequested, 'nope')
    assert.equal(out.body.result.projectSource, 'explicit')
    ok('state 带 project → 用显式项目（未初始化就如实说）')
  }

  {
    // cwdSource 必须可见：拿不到会话时不能静默写到进程目录。
    const handler = captureRoute()
    const out = await call(handler, { body: JSON.stringify({ method: 'state', sessionId: 'session-x' }) })
    assert.equal(out.body.result.cwdSource, 'session')
    assert.equal(out.body.result.projectSource, 'latest')
    ok('state → 暴露 cwdSource / projectSource')
  }

  console.log(`\n${passed} 项通过`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
