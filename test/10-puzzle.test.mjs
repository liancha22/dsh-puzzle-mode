/**
 * dsh-puzzle-mode 纯逻辑测试（无 Cordis 依赖）。
 *
 *   node test/10-puzzle.test.mjs
 *
 * 覆盖：目录守卫、建项目（多份文档）、小节合并、模块写入、模式写入、
 * 以及确定性完整度算法的几个定值。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createProject,
  defaultProjectName,
  isExecutableMode,
  MODE_PUZZLE_ONLY,
  MODE_PUZZLE_WRITE,
  PAUSE_OPTIONS,
  PAUSE_QUESTION,
  PUZZLE_DIR,
  projectSummaries,
  readModuleDetail,
  readState,
  setMode,
  slugify,
  summarize,
  summarizeList,
  updateMainSection,
  updateModuleSection,
} from '../lib/puzzle.js'

const root = mkdtempSync(join(tmpdir(), 'puzzle-test-'))
let passed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    throw error
  }
}

try {
  check('slugify 挡掉路径符号与空名', () => {
    assert.equal(slugify('auth/flow'), 'authflow')
    assert.equal(slugify('  ..  '), null)
    assert.equal(slugify(''), null)
    assert.ok(slugify('登录 重构') !== null)
  })

  check('defaultProjectName 是日期前缀', () => {
    const name = defaultProjectName('登录重构', new Date('2026-09-19T03:00:00Z'))
    assert.match(name, /^2026-09-19-/)
  })

  check('固定收尾问存在且「停下」排第一', () => {
    assert.equal(PAUSE_QUESTION, '要不要先停下？')
    assert.equal(PAUSE_OPTIONS[0], '停下，等我看过再说')
    assert.equal(PAUSE_OPTIONS.length, 2)
  })

  check('init 一次建出主文档 + N 份模块文档', () => {
    const created = createProject(root, 'demo', '把登录重构成三步', ['auth-flow', 'session-store'])
    assert.equal(created.ok, true)
    const dir = join(root, 'demo', PUZZLE_DIR)
    assert.ok(existsSync(join(dir, '主文档.md')))
    assert.ok(existsSync(join(dir, '模块', 'auth-flow.md')))
    assert.ok(existsSync(join(dir, '模块', 'session-store.md')))

    const main = readFileSync(join(dir, '主文档.md'), 'utf8')
    for (const heading of ['## 检索索引', '## 坑', '## 用户原话', '## 悬而未决', '## 已定', '## 撤销']) {
      assert.ok(main.includes(heading), `主文档缺少 ${heading}`)
    }
    assert.ok(main.includes('模式: 只拼不写'))
  })

  check('未初始化时 readState 不建文件、不抛错', () => {
    const state = readState(root, 'not-there')
    assert.equal(state.initialized, false)
    assert.equal(state.overall, 0)
    assert.equal(existsSync(join(root, 'not-there')), false)
  })

  check('初始状态：初始化块满分、已定 3 条 → 60', () => {
    updateMainSection(root, 'demo', 'decided', ['- [x] 用 JWT', '- [x] 刷新放 HttpOnly Cookie', '- [x] 会话表放 PG'].join('\n'), false)
    const state = readState(root, 'demo')
    assert.equal(state.initialized, true)
    const byId = Object.fromEntries(state.pieces.map((piece) => [piece.id, piece.score]))
    assert.equal(byId.init, 100, '小节齐 + 模块齐 → 初始化满分')
    assert.equal(byId.decided, 60, '3 条 × 20 = 60')
    assert.ok(byId.module === undefined)
    assert.ok(state.pieces.some((piece) => piece.id === 'module:auth-flow'))
  })

  check('module 写入会自动建文件并回写模块清单', () => {
    const before = readState(root, 'demo')
    assert.equal(before.modules.some((m) => m.name === 'extra'), false, '未写入前不出现该模块')
    const written = updateModuleSection(root, 'demo', 'extra', 'points', '- 新模块要点', false)
    assert.equal(written.ok, true)
    assert.equal(written.created, true)
    const after = readState(root, 'demo')
    const extra = after.modules.find((m) => m.name === 'extra')
    assert.ok(extra !== undefined, '新模块应进入模块清单')
    assert.equal(extra.exists, true)
    assert.ok(extra.score > 0)
  })

  check('module 完成度写死时模块细化用这个值', () => {
    updateModuleSection(root, 'demo', 'auth-flow', 'progress', '完成度: 80', false)
    const state = readState(root, 'demo')
    const piece = state.pieces.find((item) => item.id === 'module:auth-flow')
    assert.equal(piece.score, 80)
  })

  check('模式写入与 canExecute 联动', () => {
    assert.equal(isExecutableMode(MODE_PUZZLE_ONLY), false)
    assert.equal(isExecutableMode(MODE_PUZZLE_WRITE), true)
    assert.equal(setMode(root, 'demo', MODE_PUZZLE_WRITE).ok, true)
    const state = readState(root, 'demo')
    assert.equal(state.mode, MODE_PUZZLE_WRITE)
    assert.equal(summarize(state).canExecute, true)
    assert.equal(setMode(root, 'demo', '乱写').ok, false)
  })

  check('append 默认追加、不覆盖既有内容', () => {
    updateMainSection(root, 'demo', 'pit', '- 坑一', false)
    updateMainSection(root, 'demo', 'pit', '- 坑二', true)
    const state = readState(root, 'demo')
    const main = readFileSync(state.mainDoc, 'utf8')
    assert.ok(main.includes('坑一') && main.includes('坑二'))
  })

  check('目录守卫：越界模块名被 slug 化后仍关在拼图目录内', () => {
    const written = updateModuleSection(root, 'demo', '../../evil', 'points', '- x', false)
    // '../../evil' 被 slugify 成 'evil'：写入必须落在 模块/evil.md，
    // 而不是逃到 root/evil.md 或拼图目录之外。
    assert.equal(written.file, join(root, 'demo', PUZZLE_DIR, '模块', 'evil.md'))
    assert.equal(existsSync(join(root, 'evil.md')), false)
    assert.equal(existsSync(join(root, 'demo', 'evil.md')), false)
  })

  check('summarize 每次都带固定收尾问，图块数与文档一致', () => {
    const state = readState(root, 'demo')
    assert.equal(state.pieces.length, 1 + 6 + state.modules.length, '1 初始化 + 6 主文档节 + 每模块一块')
    const summary = summarize(state)
    assert.equal(summary.askPause, true)
    assert.equal(summary.pauseQuestion, PAUSE_QUESTION)
    assert.deepEqual(summary.pauseOptions, PAUSE_OPTIONS)
    assert.ok(summary.pieces.length === 1 + 6 + state.modules.length)
    assert.ok(summary.pieces.some((piece) => piece.kind === 'module'))
    assert.ok(summary.pieces.some((piece) => piece.kind === 'init'))
  })

  check('坏 front-matter 只降级、不抛错', () => {
    const dir = join(root, 'demo', PUZZLE_DIR)
    const main = join(dir, '主文档.md')
    const text = readFileSync(main, 'utf8').replace('计划模块: [', '计划模块: [oops')
    writeFileSync(main, text)
    const state = readState(root, 'demo')
    assert.equal(state.initialized, true)
    assert.equal(state.degraded, true)
  })

  check('模块文档不带「模式」（模式是项目级，只在主文档）', () => {
    const moduleText = readFileSync(join(root, 'demo', PUZZLE_DIR, '模块', 'auth-flow.md'), 'utf8')
    assert.ok(!moduleText.includes('模式:'), '模块文档不该有 模式: 字段')
    assert.ok(moduleText.includes('模块: auth-flow'), '模块文档应记自己的模块名')
    const mainText = readFileSync(join(root, 'demo', PUZZLE_DIR, '主文档.md'), 'utf8')
    assert.ok(mainText.includes('模式:'), '主文档仍应有 模式: 字段')
  })

  check('modeSource 区分「写死的」与「缺省补的」', () => {
    const withMode = readState(root, 'demo')
    assert.equal(withMode.modeSource, 'front-matter')
    // 把模式行删掉 → 应退回默认值，且 modeSource 标记为 default
    const dir = join(root, 'demo', PUZZLE_DIR)
    const main = join(dir, '主文档.md')
    const text = readFileSync(main, 'utf8').replace(/^模式: .*$/m, '')
    writeFileSync(main, text)
    const without = readState(root, 'demo')
    assert.equal(without.mode, MODE_PUZZLE_ONLY)
    assert.equal(without.modeSource, 'default')
    // 恢复，后面的用例继续用「边拼边写」
    setMode(root, 'demo', MODE_PUZZLE_WRITE)
  })

  check('用户写的括号行不再被误判为空', () => {
    // 早先把「整行就是一对括号」一律当占位，于是真内容会被漏算。
    updateMainSection(root, 'demo', 'pit', '- （见模块 auth-flow）', false)
    const state = readState(root, 'demo')
    const pit = state.pieces.find((piece) => piece.id === 'pit')
    assert.equal(pit.counts.items, 1, '括号里的真内容应算 1 条')
    assert.equal(pit.score, 25)
  })

  check('readModuleDetail 读详情；不存在的模块不建文件', () => {
    updateModuleSection(root, 'demo', 'auth-flow', 'detail', '- 详细一\n- 详细二', false)
    const detail = readModuleDetail(root, 'demo', 'auth-flow')
    assert.equal(detail.ok, true)
    assert.equal(detail.exists, true)
    assert.ok(detail.detail.includes('详细一'))
    assert.equal(detail.declaredProgress, 80, '之前写过 完成度: 80')

    const missing = readModuleDetail(root, 'demo', 'nope')
    assert.equal(missing.ok, true)
    assert.equal(missing.exists, false)
    assert.equal(existsSync(join(root, 'demo', PUZZLE_DIR, '模块', 'nope.md')), false, '读详情不能建文件')
  })

  check('projectSummaries 列出多个项目并标注默认', () => {
    createProject(root, 'second', '第二个项目', ['mod-a'])
    const summaries = projectSummaries(root)
    assert.equal(summaries.length, 2, '应有 demo 与 second 两个项目')
    const names = summaries.map((item) => item.name).sort()
    assert.deepEqual(names, ['demo', 'second'])
    for (const item of summaries) {
      assert.equal(typeof item.overall, 'number')
      assert.equal(typeof item.moduleCount, 'number')
      assert.ok(item.updatedAt !== undefined)
    }
    const list = summarizeList(root, summaries)
    assert.equal(list.projectCount, 2)
    assert.ok(list.defaultProject !== null, '必须标出默认用哪个')
    assert.ok(list.pauseQuestion === PAUSE_QUESTION, 'list 也要带固定收尾问')
  })

  check('空项目根：summarizeList 不报错且 projectCount 为 0', () => {
    const empty = mkdtempSync(join(tmpdir(), 'puzzle-empty-'))
    try {
      const list = summarizeList(empty, projectSummaries(empty))
      assert.equal(list.ok, true)
      assert.equal(list.projectCount, 0)
      assert.equal(list.defaultProject, null)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  console.log(`\n${passed} 项通过`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
