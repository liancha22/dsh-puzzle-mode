/**
 * 只拼不写拦截测试：不需要 Cordis 运行时——把宿主半 `apply` 的
 * `agent/pre-step` 监听器截下来，用假的 payload/decision 直接驱动。
 *
 *   node test/40-pre-step.test.mjs
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
  console.log(`skip 40-pre-step.test.mjs：${code === 'ERR_MODULE_NOT_FOUND' ? '找不到 @deepseek-ai/dsh-tools（本目录未装进 DSH profile），跳过' : String(error && error.message ? error.message : error)}`)
  process.exit(0)
}

const root = mkdtempSync(join(tmpdir(), 'puzzle-premode-'))
let passed = 0

/** 摘出宿主半注册的 pre-step 监听器。 */
function captureListener() {
  let listener = null
  host.apply({
    systemPrompt: { section() {} },
    tools: { register() { return () => {} } },
    on(event, fn) {
      if (event === 'agent/pre-step') listener = fn
      return () => {}
    },
    inject() {},
    effect() {},
    get() { return undefined },
  })
  assert.equal(typeof listener, 'function', '必须注册 agent/pre-step 监听器')
  return listener
}

const decision = {
  kind: 'enter',
  messages: [
    { role: 'user', content: [{ type: 'text', text: '开始吧' }] },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', name: 'bash', id: '1' },
        { type: 'tool-call', name: 'puzzle_mode', id: '2' },
      ],
    },
  ],
}

function toolNames(out) {
  return out.messages.flatMap((message) => (Array.isArray(message.content)
    ? message.content.filter((block) => block.type === 'tool-call').map((block) => block.name)
    : []))
}

try {
  createProject(root, 'demo', '目标', ['auth-flow'])
  const listener = captureListener()
  const payload = { agent: { session: { header: { cwd: root } } } }

  const blocked = await listener(payload, async () => decision)
  assert.deepEqual(toolNames(blocked), ['puzzle_mode'], '越权工具必须被剔除，白名单工具保留')
  const notice = blocked.messages[blocked.messages.length - 1]
  assert.equal(notice.role, 'user')
  assert.equal(notice.source.kind, 'plugin')
  assert.equal(notice.source.form, 'notice')
  assert.ok(notice.content[0].text.includes('要不要先停下？'), '拦截说明里必须复述固定收尾问')
  assert.equal(typeof notice.id, 'string')
  passed += 1
  console.log('ok   只拼不写：越权工具被剔除并回注说明')

  setMode(root, 'demo', '边拼边写')
  const allowed = await listener(payload, async () => decision)
  assert.equal(allowed, decision, '边拼边写必须原样放行')
  passed += 1
  console.log('ok   边拼边写：原样放行')

  console.log(`\n${passed} 项通过`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
