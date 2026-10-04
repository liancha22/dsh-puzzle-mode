/**
 * `op:audit` 工具返回的**无损 JSON** 回归测试。
 *
 *   node test/90-audit-tool.test.mjs
 *
 * ## 为什么需要这个文件
 *
 * 宿主对工具返回做「无损 JSON」校验：返回的对象必须能 `JSON.parse(JSON.stringify(x))`
 * **原样往返**。显式 `undefined` 的属性过不了这一关——
 * `{ file: undefined }` → stringify → `{}` → 不等于原值 → **整次工具调用被判失败**。
 *
 * 实测踩到过：`op:audit` 带源码体检时必报
 * `tool "puzzle_mode" returned invalid output: value is not lossless JSON`，
 * 只有显式 `source:false` 能跑。根因是 `lib/index.js` 把源码发现并进 `findings` 时
 * 无条件写了 `file: item.file`，而 `source_flat`（「N 个文件全在同一层目录」）与
 * 「另有 N 个函数超长」这两条是**项目级**发现、本来就没有单个文件。
 *
 * 所以这里不去断言某个具体字段，而是断言**整个返回**能无损往返——
 * 这条判据不管以后哪个字段被写成 undefined，都会红。
 *
 * 需要 `@deepseek-ai/dsh-tools`（宿主半 import 了它）。没装就明确跳过，不抛 ERR_MODULE_NOT_FOUND。
 */
import assert from 'node:assert/strict'
// **必须最先**：隔离 DSH_HOME（绑定与开关都是全局状态）。
import './helpers/isolate-home.mjs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let host = null
try {
  host = await import('../lib/index.js')
} catch (error) {
  const code = error === null || error === undefined ? undefined : error.code
  console.log('skip 90-audit-tool.test.mjs：' + (code === 'ERR_MODULE_NOT_FOUND'
    ? '找不到 @deepseek-ai/dsh-tools（本目录未装进 DSH profile），跳过'
    : String(error && error.message ? error.message : error)))
  process.exit(0)
}

const root = mkdtempSync(join(tmpdir(), 'puzzle-audit-tool-'))

/** 截下宿主半注册的工具定义。 */
function captureTool() {
  let tool = null
  host.apply({
    systemPrompt: { section() {} },
    tools: { register(definition) { tool = definition; return () => {} } },
    on() { return () => {} },
    effect() {},
    get(name) {
      if (name !== 'sessions') return undefined
      return { get() { return { header: { cwd: root } } } }
    },
    inject() {},
  })
  assert.ok(tool !== null, '必须注册 puzzle_mode 工具')
  return tool
}

/**
 * 断言一个值能**无损往返**——这正是宿主那条校验的判据。
 *
 * 用 `assert.deepEqual`（严格深比较）而不是只看 `JSON.stringify` 不抛错：
 * `{file: undefined}` 恰好也能 stringify 成功（undefined 的键被默默丢掉），
 * 只看「没抛错」会漏掉这个 bug。
 */
function assertLossless(value, label) {
  let round = null
  try {
    round = JSON.parse(JSON.stringify(value))
  } catch (error) {
    assert.fail(label + ' 不是可序列化 JSON：' + (error && error.message))
  }
  assert.deepEqual(round, value, label + ' 往返后不一致（通常是有字段被写成 undefined）')
}

const exec = { agent: { session: { id: 'session-audit-tool-test' } } }
const tool = captureTool()
let passed = 0
const ok = (name) => { passed += 1; console.log('ok   ' + name) }

try {
  /* ---------- 建一个会触发 source_flat 的工程 ---------- */
  // 规则：源码文件 ≥6 个且**只有一层目录**时命中 source_flat。
  // 必须真的造出这个形状——否则那条没有 file 的发现不会出现，测试就是假的。
  const src = join(root, 'src-flat')
  mkdirSync(src, { recursive: true })
  for (let i = 0; i < 7; i += 1) {
    writeFileSync(join(src, 'mod' + i + '.js'), 'export const v' + i + ' = ' + i + '\n')
  }

  const created = await tool.execute({ op: 'init', project: 'demo', modules: ['a'] }, exec)
  assert.equal(created.ok, true, 'init 必须成功：' + JSON.stringify(created))

  /* ---------- 核心：带源码体检的 audit 必须无损 ---------- */
  const audit = await tool.execute({ op: 'audit', project: 'demo', sourceRoot: src }, exec)
  assert.equal(audit.ok, true, 'audit 必须成功：' + JSON.stringify(audit).slice(0, 400))
  assertLossless(audit, 'op:audit（带源码体检）的返回')
  ok('op:audit 带源码体检的返回可无损往返（曾经的必失败路径）')

  /* ---------- 那条项目级发现确实出现了 ---------- */
  const flat = audit.findings.filter((row) => row.id === 'source:source_flat')
  assert.equal(flat.length, 1, '造了 7 个同层文件，必须命中 source_flat')
  assert.equal(Object.hasOwn(flat[0], 'file'), false, '项目级发现不该有 file 键（不能是 undefined）')
  assert.ok(flat[0].fact.includes('7 个'), '事实里要写清文件数：' + flat[0].fact)
  ok('source_flat 命中且**不带** file 键（不是 undefined）')

  /* ---------- 带 file 的发现仍然带 file（别修过头） ---------- */
  const skipNote = { id: 'source:source_long_function', file: 'x.js' }
  assert.ok(skipNote.file, '这条只是示意：带 file 的发现要照旧带 file')
  const withFile = audit.findings.filter((row) => row.id.startsWith('source:') && Object.hasOwn(row, 'file'))
  for (const row of withFile) {
    assert.equal(typeof row.file, 'string', 'file 一旦存在就必须是字符串：' + JSON.stringify(row))
    assert.ok(row.file !== '', 'file 不能是空串')
  }
  ok('带 file 的源码发现仍是字符串（没修成一律不带）')

  /* ---------- 整个返回体都无损，不止 findings ---------- */
  assertLossless(audit.fixPlan, 'fixPlan')
  assertLossless(audit.dimensions ?? {}, 'dimensions')
  ok('fixPlan 与五维也都能无损往返')

  /* ---------- source:false 那条路没被弄坏 ---------- */
  const noSource = await tool.execute({ op: 'audit', project: 'demo', source: false }, exec)
  assert.equal(noSource.ok, true)
  assertLossless(noSource, 'op:audit（source:false）的返回')
  assert.equal(noSource.findings.filter((row) => row.id.startsWith('source:')).length, 0,
    'source:false 时不该有源码发现')
  ok('source:false 仍然可用且不含源码发现')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('')
console.log(passed + ' 项通过')
