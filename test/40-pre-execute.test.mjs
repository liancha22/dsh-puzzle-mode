/**
 * 只拼不写拦截测试：不需要 Cordis 运行时——把宿主半 `apply` 注册的
 * `tools/pre-execute` 监听器截下来，用真实的 `ToolExecution` 形状直接驱动。
 *
 *   node test/40-pre-execute.test.mjs
 *
 * 为什么不再是 `agent/pre-step`：那个事件的 `decision.messages` 契约是
 * **`UserMessage[]`**（见 Host Event catalog），里面根本没有 tool-call。旧测试
 * 伪造了一条带 tool-call 的 assistant 消息，于是「拦截生效」是假绿——真实运行时
 * 永远走不到那个分支。改用 `tools/pre-execute`（可返回 `{kind:'deny'}`）后，
 * 这里的断言才对得上真实契约。
 *
 * 宿主半 import 了 `@deepseek-ai/dsh-tools`（由 DSH 运行时提供）。在没装 DSH 的
 * 裸目录里这一组无法运行，此时**明确跳过**并说明原因，而不是抛 ERR_MODULE_NOT_FOUND。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProject, setMode } from '../lib/puzzle.js'

let host
try {
  host = await import('../lib/index.js')
} catch (error) {
  const code = error === null || error === undefined ? undefined : error.code
  console.log(`skip 40-pre-execute.test.mjs：${code === 'ERR_MODULE_NOT_FOUND' ? '找不到 @deepseek-ai/dsh-tools（本目录未装进 DSH profile），跳过' : String(error && error.message ? error.message : error)}`)
  process.exit(0)
}

const root = mkdtempSync(join(tmpdir(), 'puzzle-preexec-'))
let passed = 0

function ok(name) {
  passed += 1
  console.log(`ok   ${name}`)
}

/** 摘出宿主半注册的 tools/pre-execute 监听器。 */
function captureListener() {
  let listener = null
  host.apply({
    systemPrompt: { section() {} },
    tools: { register() { return () => {} } },
    on(event, fn) {
      if (event === 'tools/pre-execute') listener = fn
      return () => {}
    },
    inject() {},
    effect() {},
    get(name) {
      if (name !== 'sessions') return undefined
      return { get(id) { return typeof id === 'string' && id !== '' ? { header: { cwd: root } } : undefined } }
    },
  })
  assert.equal(typeof listener, 'function', '必须注册 tools/pre-execute 监听器')
  return listener
}

/** 真实的 ToolExecution 形状（只取本插件会读的字段）。 */
function call(name, id = 'session-x') {
  return { callId: 'c1', name, arguments: {}, agent: { id }, signal: { aborted: false } }
}

/** 默认放行（模拟 next() 到链尾的 allow）。 */
const allow = async () => ({ kind: 'allow' })

try {
  createProject(root, 'demo', '目标', ['auth-flow'], '只拼不写', 'session-x')
  const listener = captureListener()

  // 1) 只拼不写：越权工具必须被 deny，且理由里带上固定收尾问与「改用 puzzle_mode」。
  const denied = await listener(call('bash'), allow)
  assert.equal(denied.kind, 'deny', 'bash 必须被 deny')
  assert.ok(denied.reason.includes('要不要先停下？'), '拒绝理由里必须复述固定收尾问')
  assert.ok(denied.reason.includes('puzzle_mode'), '拒绝理由里必须指明改走 puzzle_mode')
  assert.ok(denied.reason.includes('write / edit'), '拒绝理由里必须点明不要用 write/edit')
  ok('只拼不写：bash → deny，理由含固定收尾问与替代路径')

  // 2) 白名单工具必须放行（原样返回 next() 的结果）。
  for (const name of ['puzzle_mode', 'read', 'grep', 'glob', 'ask_user_question', 'todo_write']) {
    const decision = await listener(call(name), allow)
    assert.equal(decision.kind, 'allow', `${name} 应放行`)
  }
  ok('只拼不写：白名单六个工具全部放行')

  // 3) write / edit 不在白名单——它们能绕过路径守卫，必须拦。
  for (const name of ['write', 'edit']) {
    const decision = await listener(call(name), allow)
    assert.equal(decision.kind, 'deny', `${name} 必须被 deny（能绕过路径守卫）`)
  }
  ok('只拼不写：write / edit 被拦（不能绕过路径守卫）')

  // 4) 边拼边写：全部放行。
  setMode(root, 'demo', '边拼边写')
  for (const name of ['bash', 'write', 'edit', 'puzzle_mode']) {
    const decision = await listener(call(name), allow)
    assert.equal(decision.kind, 'allow', `边拼边写下 ${name} 应放行`)
  }
  ok('边拼边写：bash / write / edit 全部放行')

  // 5) 已经有人 deny 过：不要插话覆盖。
  setMode(root, 'demo', '只拼不写')
  const prior = { kind: 'deny', reason: '别人拒的' }
  const kept = await listener(call('bash'), async () => prior)
  assert.equal(kept, prior, '已 deny 的决策必须原样透传')
  ok('已有 deny：原样透传，不覆盖')

  // 6) 无项目 / 未知会话：一律放行。
  const other = await listener(call('bash', 'session-unknown'), allow)
  assert.equal(other.kind, 'allow', '该会话没绑定项目 → 放行（不误伤别的会话）')
  const loose = await listener(call('bash', 'session-loose'), allow)
  assert.equal(loose.kind, 'allow', '未绑定会话即使项目根下有项目也不拦')
  const emptyRoot = mkdtempSync(join(tmpdir(), 'puzzle-empty-'))
  try {
    const listener2 = (() => {
      let l = null
      host.apply({
        systemPrompt: { section() {} },
        tools: { register() { return () => {} } },
        on(event, fn) { if (event === 'tools/pre-execute') l = fn; return () => {} },
        inject() {}, effect() {},
        get(name) { return name === 'sessions' ? { get() { return { header: { cwd: emptyRoot } } } } : undefined },
      })
      return l
    })()
    const noProject = await listener2(call('bash'), allow)
    assert.equal(noProject.kind, 'allow', '项目根下没有拼图项目时放行')
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true })
  }
  ok('无项目 / 未知会话：一律放行')

  console.log(`\n${passed} 项通过`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
