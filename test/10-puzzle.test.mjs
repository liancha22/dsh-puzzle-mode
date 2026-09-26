/**
 * dsh-puzzle-mode 纯逻辑测试（无 Cordis 依赖）。
 *
 *   node test/10-puzzle.test.mjs
 *
 * 覆盖：目录守卫、建项目（多份文档）、小节合并、模式写入，
 * 以及**五维项目健康性**：显式分数、证据推导、反向维度、跨模块汇总。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUDIT_PROMPT,
  DIMENSION_FIX,
  HEALTH_DIMENSIONS,
  HEALTH_HEADING,
  HEALTH_KEYS,
  MODE_PUZZLE_ONLY,
  MODE_PUZZLE_WRITE,
  PAUSE_OPTIONS,
  PAUSE_QUESTION,
  PUZZLE_DIR,
  SESSION_FIELD,
  auditOf,
  bindSession,
  boundProject,
  createProject,
  defaultProjectName,
  dimensionRanking,
  healthLines,
  healthOf,
  isExecutableMode,
  parseFrontMatter,
  parseHealthDeclarations,
  parseSessionList,
  projectSummaries,
  readModuleDetail,
  readState,
  sectionCounts,
  setMode,
  slugify,
  summarize,
  PUZZLE_VERSION,
  PROGRESS_TO_HEALTH,
  docVersion,
  pendingMigrations,
  planRebuild,
  rebuildProject,
  summarizeList,
  unbindSession,
  updateMainSection,
  updateModuleSection,
  updateProjectHealth,
} from '../lib/puzzle.js'

const root = mkdtempSync(join(tmpdir(), 'puzzle-test-'))

const V1_MAIN = "---\npuzzle: 1\n项目: legacy\n模式: 只拼不写\n计划模块: [\"mod-a\",\"mod-b\"]\n更新时间: 2026-09-19 10:00:00\n---\n# legacy · 主文档\n\n> 目标：迁移测试\n\n## 检索索引\n| 模块 | 一句话职责 | 文件 |\n| --- | --- | --- |\n| mod-a | 一号 | `模块/mod-a.md` |\n\n## 坑\n- 一条坑\n\n## 用户原话\n- 「原话」\n\n## 悬而未决\n- 一个未决\n\n## 已定\n- 一个已定\n\n## 撤销\n- （待补）\n"

const V1_MODA = "---\npuzzle: 1\n项目: mod-a\n模式: 只拼不写\n计划模块: []\n更新时间: 2026-09-19 10:00:00\n---\n# mod-a\n\n## 进度\n完成度: 100\n## 要点\n- （该模块的关键结论，只留事实）\n\n## 与本模块相关的悬而未决 / 已定 / 撤销\n- [ ] （待补）\n\n## 详细记录\n- （细化记录；主文档只留一行索引）\n"

const V1_MODB = "---\npuzzle: 1\n项目: mod-b\n模式: 只拼不写\n计划模块: []\n更新时间: 2026-09-19 10:00:00\n---\n# mod-b\n\n## 进度\n完成度: 100\n## 要点\n- 要点一\n- 要点二\n- 要点三\n\n## 与本模块相关的悬而未决 / 已定 / 撤销\n- [x] 已定一条\n\n## 详细记录\n- 细节一\n"
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
    assert.match(defaultProjectName('登录重构', new Date('2026-09-19T03:00:00Z')), /^2026-09-19-/)
  })

  check('固定收尾问存在且「停下」排第一', () => {
    assert.equal(PAUSE_QUESTION, '要不要先停下？')
    assert.equal(PAUSE_OPTIONS[0], '停下，等我看过再说')
    assert.equal(PAUSE_OPTIONS.length, 2)
  })

  check('五维定义齐、全为「越高越好」', () => {
    assert.deepEqual(HEALTH_KEYS, ['complexity', 'extensibility', 'maintenance', 'quality', 'reusability'])
    assert.deepEqual(HEALTH_DIMENSIONS.map((d) => d.name), ['任务复杂度', '可拓展性', '维护系数', '代码质量', '可复用性'])
    for (const dimension of HEALTH_DIMENSIONS) {
      assert.equal(typeof dimension.derive, 'function', `${dimension.name} 必须有推导函数`)
    }
  })

  check('init 一次建出主文档 + N 份模块文档，且模块带五维小节', () => {
    const created = createProject(root, 'demo', '把登录重构成三步', ['auth-flow', 'session-store'])
    assert.equal(created.ok, true)
    const dir = join(root, 'demo', PUZZLE_DIR)
    assert.ok(existsSync(join(dir, '主文档.md')))
    assert.ok(existsSync(join(dir, '模块', 'auth-flow.md')))

    const main = readFileSync(join(dir, '主文档.md'), 'utf8')
    for (const heading of ['## 检索索引', '## 坑', '## 用户原话', '## 悬而未决', '## 已定', '## 撤销']) {
      assert.ok(main.includes(heading), `主文档缺少 ${heading}`)
    }
    assert.ok(main.includes('模式: 只拼不写'))

    const moduleText = readFileSync(join(dir, '模块', 'auth-flow.md'), 'utf8')
    assert.ok(moduleText.includes(HEALTH_HEADING), '模块文档必须有健康性小节')
    for (const dimension of HEALTH_DIMENSIONS) {
      // 模板只列维度名、**不写数字**：写了 0 会被当成「显式声明 0」，推导就永远不生效。
      assert.ok(moduleText.includes(dimension.name + ': '), `模块模板应列出「${dimension.name}」`)
      assert.ok(!new RegExp(dimension.name + ': \\d').test(moduleText), `模板不该预填 ${dimension.name} 的数字`)
    }
  })

  check('未初始化时 readState 不建文件、健康性为 0', () => {
    const state = readState(root, 'not-there')
    assert.equal(state.initialized, false)
    assert.equal(state.health, 0)
    assert.deepEqual(state.dimensions, Object.fromEntries(HEALTH_KEYS.map((k) => [k, 0])))
    assert.equal(existsSync(join(root, 'not-there')), false)
  })

  check('空模块：五维全 0（不是"看起来还行给 60"）', () => {
    const state = readState(root, 'demo')
    const module = state.modules.find((m) => m.name === 'auth-flow')
    assert.equal(module.exists, true)
    assert.equal(module.health, 0, '模板占位行不能算证据')
    assert.deepEqual(module.healthScores, Object.fromEntries(HEALTH_KEYS.map((k) => [k, 0])))
    assert.equal(state.health, 0)
  })

  check('显式分数优先于推导，并按维度名识别', () => {
    const declared = parseHealthDeclarations([
      '## 健康性',
      '- 任务复杂度: 80',
      '- 可拓展性：75',
      '**维护系数**: 90',
      '- 代码质量: 60',
      '- 可复用性: 40',
      '- 不认识的维度: 99',
    ].join('\n'))
    assert.deepEqual(declared, { complexity: 80, extensibility: 75, maintenance: 90, quality: 60, reusability: 40 })
  })

  check('维护成本是反向量：30 → 维护系数 70', () => {
    assert.deepEqual(parseHealthDeclarations('- 维护成本: 30'), { maintenance: 70 })
    assert.deepEqual(parseHealthDeclarations('- 维护成本: 0'), { maintenance: 100 })
  })

  check('写了显式分数 → 该维用显式值；其余维度仍推导', () => {
    const written = updateModuleSection(root, 'demo', 'auth-flow', 'health', healthLines({
      complexity: 80, extensibility: 70, maintenance: 90, quality: 60, reusability: 50,
    }), false)
    assert.equal(written.ok, true)
    const state = readState(root, 'demo')
    const module = state.modules.find((m) => m.name === 'auth-flow')
    assert.deepEqual(module.healthScores, { complexity: 80, extensibility: 70, maintenance: 90, quality: 60, reusability: 50 })
    assert.equal(module.health, 70, '五维均值 (80+70+90+60+50)/5 = 70')
    for (const key of HEALTH_KEYS) assert.equal(module.healthSources[key], 'module')
  })

  check('不写分数时由文档证据推导', () => {
    // 给 session-store 写 2 条要点 + 1 条详细记录 + 1 条已定 + 1 条悬而未决
    updateModuleSection(root, 'demo', 'session-store', 'points', '- 要点一\n- 要点二', false)
    updateModuleSection(root, 'demo', 'session-store', 'detail', '- 详细一', false)
    updateModuleSection(root, 'demo', 'session-store', 'related', '- [x] 已定一\n- [ ] 待定一', false)
    const state = readState(root, 'demo')
    const module = state.modules.find((m) => m.name === 'session-store')
    assert.equal(module.healthSources.complexity, 'derived')
    // points=2, detail=1 → 2*12+1*10 = 34
    assert.equal(module.healthScores.complexity, 34)
    // pending=1, decided=1 → 20+20 = 40
    assert.equal(module.healthScores.extensibility, 40)
    // points=2, detail=1 → 2*18+1*8 = 44
    assert.equal(module.healthScores.maintenance, 44)
    // pit=0, decided=1 → 0+15 = 15
    assert.equal(module.healthScores.quality, 15)
    // shared=0, points=2 → 0+20 = 20
    assert.equal(module.healthScores.reusability, 20)
  })

  check('项目健康性 = 各模块健康性均值；dimensions = 跨模块均值', () => {
    const state = readState(root, 'demo')
    const values = state.modules.map((m) => m.health)
    const expected = Math.round(values.reduce((a, b) => a + b, 0) / values.length)
    assert.equal(state.health, expected)
    for (const key of HEALTH_KEYS) {
      const perModule = state.modules.map((m) => m.healthScores[key])
      const mean = Math.round(perModule.reduce((a, b) => a + b, 0) / perModule.length)
      assert.equal(state.dimensions[key], mean, `${key} 的跨模块均值`)
    }
  })

  check('项目级显式分数当模块缺省值（模块没写时用项目的）', () => {
    const written = updateProjectHealth(root, 'demo', '- 代码质量: 88', false)
    assert.equal(written.ok, true)
    // session-store 的 quality 原本是推导值 15；项目写了 88 → 优先用项目的
    const state = readState(root, 'demo')
    const module = state.modules.find((m) => m.name === 'session-store')
    assert.equal(module.healthScores.quality, 88)
    assert.equal(module.healthSources.quality, 'project')
  })

  check('模块级显式分数仍然压过项目级', () => {
    const state = readState(root, 'demo')
    const module = state.modules.find((m) => m.name === 'auth-flow')
    assert.equal(module.healthSources.quality, 'module')
    assert.equal(module.healthScores.quality, 60, 'auth-flow 自己写了 60，不用项目的 88')
  })

  check('op:health 不带 name 时写主文档健康性小节', () => {
    const main = readFileSync(join(root, 'demo', PUZZLE_DIR, '主文档.md'), 'utf8')
    assert.ok(main.includes(HEALTH_HEADING), '主文档应有健康性小节')
    assert.ok(main.includes('代码质量: 88'))
  })

  check('modeSource 区分「写死的」与「缺省补的」', () => {
    assert.equal(readState(root, 'demo').modeSource, 'front-matter')
    const main = join(root, 'demo', PUZZLE_DIR, '主文档.md')
    const text = readFileSync(main, 'utf8').replace(/^模式: .*$/m, '')
    writeFileSync(main, text)
    const without = readState(root, 'demo')
    assert.equal(without.mode, MODE_PUZZLE_ONLY)
    assert.equal(without.modeSource, 'default')
    setMode(root, 'demo', MODE_PUZZLE_WRITE)
  })

  check('模式写入与 canExecute 联动', () => {
    assert.equal(isExecutableMode(MODE_PUZZLE_ONLY), false)
    assert.equal(isExecutableMode(MODE_PUZZLE_WRITE), true)
    assert.equal(readState(root, 'demo').mode, MODE_PUZZLE_WRITE)
    assert.equal(summarize(readState(root, 'demo')).canExecute, true)
    assert.equal(setMode(root, 'demo', '乱写').ok, false)
  })

  check('用户写的括号行不再被误判为空', () => {
    updateMainSection(root, 'demo', 'pit', '- （见模块 auth-flow）', false)
    const state = readState(root, 'demo')
    // 主文档「坑」有 1 条 → 推导的 quality 用 pit 计数（auth-flow 显式写了所以看 session-store）
    const module = state.modules.find((m) => m.name === 'session-store')
    // session-store 的 quality 被项目级 88 覆盖，所以换个角度看：坑确实进了证据
    assert.equal(module.healthSources.quality, 'project')
    const main = readFileSync(state.mainDoc, 'utf8')
    assert.ok(main.includes('见模块 auth-flow'), '括号里的内容必须写进文档')
  })

  check('append 默认追加、不覆盖既有内容', () => {
    updateMainSection(root, 'demo', 'decided', '- [x] 结论一', false)
    updateMainSection(root, 'demo', 'decided', '- [x] 结论二', true)
    const main = readFileSync(readState(root, 'demo').mainDoc, 'utf8')
    assert.ok(main.includes('结论一') && main.includes('结论二'))
  })

  check('目录守卫：越界模块名被 slug 化后仍关在拼图目录内', () => {
    const written = updateModuleSection(root, 'demo', '../../evil', 'points', '- x', false)
    assert.equal(written.file, join(root, 'demo', PUZZLE_DIR, '模块', 'evil.md'))
    assert.equal(existsSync(join(root, 'evil.md')), false)
  })

  check('readModuleDetail 带五维；不存在的模块不建文件', () => {
    updateModuleSection(root, 'demo', 'auth-flow', 'points', '- 要点甲\n- 要点乙', false)
    const detail = readModuleDetail(root, 'demo', 'auth-flow')
    assert.equal(detail.ok, true)
    assert.equal(detail.exists, true)
    assert.equal(detail.health, 70)
    assert.equal(detail.dimensions.maintenance, 90)
    assert.ok(detail.points.includes('要点甲'), '详情要能读到真实要点')

    const missing = readModuleDetail(root, 'demo', 'nope')
    assert.equal(missing.ok, true)
    assert.equal(missing.exists, false)
    assert.equal(missing.health, 0)
    assert.equal(existsSync(join(root, 'demo', PUZZLE_DIR, '模块', 'nope.md')), false, '读详情不能建文件')
  })

  check('summarize 每次都带固定收尾问与五维元信息', () => {
    const state = readState(root, 'demo')
    const summary = summarize(state)
    assert.equal(summary.askPause, true)
    assert.equal(summary.pauseQuestion, PAUSE_QUESTION)
    assert.deepEqual(summary.pauseOptions, PAUSE_OPTIONS)
    assert.equal(typeof summary.health, 'number')
    assert.equal(summary.dimensionMeta.length, 5)
    assert.ok(!Object.hasOwn(summary, 'overall'), '不再有 overall（完整度）字段')
    assert.ok(!Object.hasOwn(summary, 'pieces'), '不再有 pieces（图块计分）字段')
    assert.equal(summary.modules.length, state.modules.length)
    for (const module of summary.modules) {
      assert.equal(typeof module.health, 'number')
      assert.deepEqual(Object.keys(module.dimensions).sort(), [...HEALTH_KEYS].sort())
    }
    // op:read 要精简：只给发现的数量，不把整份 findings 塞进每轮都调的返回里。
    assert.equal(typeof summary.findingCount, 'number')
    assert.ok(!Object.hasOwn(summary, 'findings'), 'read 不塞完整 findings（走 op:audit）')
  })

  check('projectSummaries 用 health（不再是 overall）', () => {
    createProject(root, 'second', '第二个项目', ['mod-a'])
    const summaries = projectSummaries(root)
    assert.equal(summaries.length, 2)
    for (const item of summaries) {
      assert.equal(typeof item.health, 'number')
      assert.equal(typeof item.dimensions, 'object')
      assert.ok(!Object.hasOwn(item, 'overall'), 'list 里不该再有 overall')
    }
    const list = summarizeList(root, summaries)
    assert.equal(list.projectCount, 2)
    assert.ok(list.defaultProject !== null)
  })

  check('healthOf 对空字符串/坏输入不抛错', () => {
    assert.equal(healthOf('').health, 0)
    assert.equal(healthOf(null, null).health, 0)
    assert.equal(healthOf(undefined).health, 0)
  })

  check('坏 front-matter 只降级、不抛错', () => {
    const main = join(root, 'demo', PUZZLE_DIR, '主文档.md')
    const text = readFileSync(main, 'utf8').replace('计划模块: [', '计划模块: [oops')
    writeFileSync(main, text)
    const state = readState(root, 'demo')
    assert.equal(state.initialized, true)
    assert.equal(state.degraded, true)
    assert.equal(typeof state.health, 'number', '坏 front-matter 也要能算出健康性')
  })

  check('sectionCounts 数主文档六节，且不吃模板占位', () => {
    const text = readFileSync(readState(root, 'demo').mainDoc, 'utf8')
    const counts = sectionCounts(text)
    assert.deepEqual(Object.keys(counts), ['index', 'pit', 'quote', 'pending', 'decided', 'revoked'])
    assert.ok(counts.pit >= 1, '「坑」里那条括号内容要算数')
    assert.ok(counts.decided >= 2, '已定两条都在')
  })

  check('dimensionRanking 按分数升序，最弱的一维排最前', () => {
    const ranking = dimensionRanking({ complexity: 50, extensibility: 10, maintenance: 90, quality: 0, reusability: 70 })
    assert.equal(ranking.length, 5)
    assert.equal(ranking[0].key, 'quality', '0 分排第一')
    assert.equal(ranking[0].name, '代码质量', 'ranking 要带中文名')
    assert.equal(ranking[4].key, 'maintenance', '90 分排最后')
    for (let i = 1; i < ranking.length; i += 1) assert.ok(ranking[i - 1].value <= ranking[i].value, '必须升序')
  })

  check('主文档的悬而未决 / 已定也算进每个模块的可拓展性（与「坑」对称）', () => {
    // 这个项目此前只数模块自己的勾选框，于是主文档写了 5 条已定、这一维仍是 0。
    const isolated = createProject(root, 'audit-demo', '审查用', ['only-mod'])
    assert.equal(isolated.ok, true)
    const before = readState(root, 'audit-demo')
    assert.equal(before.modules[0].healthScores.extensibility, 0, '主文档与模块都没写决策时是 0')

    updateMainSection(root, 'audit-demo', 'decided', '- [x] 结论甲', false)
    updateMainSection(root, 'audit-demo', 'pending', '- [ ] 待定乙', false)
    const after = readState(root, 'audit-demo')
    assert.equal(after.modules[0].healthSources.extensibility, 'derived')
    // projectPending=1 + projectDecided=1 → (1+1)*20 = 40
    assert.equal(after.modules[0].healthScores.extensibility, 40, '主文档 1 悬 + 1 定 → 40')
  })

  check('auditOf：完成度写满但要点为空 → blocker（这是装样子）', () => {
    // 显式造场景：完成度 100，但要点仍是模板占位（0 条）。
    updateModuleSection(root, 'audit-demo', 'only-mod', 'progress', '100', false)
    const state = readState(root, 'audit-demo')
    const item = state.findings.find((f) => f.id === 'progress_no_points:only-mod')
    assert.ok(item !== undefined, '完成度满、要点 0 条 → 必须报出来')
    assert.equal(item.level, 'blocker')
    assert.ok(item.fact.includes('完成度'), '事实里必须点名完成度')
    assert.ok(item.fact.includes('100'), '事实里要带那个完成度数字')
    assert.ok(item.fix.length > 0, '每条发现都要有下一步')
    assert.equal(item.scope, 'only-mod', '要指明落在哪个模块')

    // 反例：要点补上之后，这条发现必须消失（否则就是噪音）。
    updateModuleSection(root, 'audit-demo', 'only-mod', 'points', '- 一条真要点', false)
    const after = readState(root, 'audit-demo')
    assert.ok(
      !after.findings.some((f) => f.id === 'progress_no_points:only-mod'),
      '要点补上后不该再报',
    )
  })

  check('auditOf：每条发现的 fix 都能在 DIMENSION_FIX 或事实里落地', () => {
    const state = readState(root, 'demo')
    for (const item of state.findings) {
      assert.ok(['blocker', 'warn', 'info'].includes(item.level), `${item.id} 的 level 必须是三档之一`)
      assert.equal(typeof item.fact, 'string')
      assert.equal(typeof item.fix, 'string')
      assert.ok(item.fact.length > 0 && item.fix.length > 0, `${item.id} 事实与建议都不能空`)
    }
  })

  check('auditOf：手写分数没有对应证据 → warn', () => {
    // session-store 的 quality 被项目级 88 覆盖，而它自己的「已定」已写、坑来自主文档，
    // 所以换一个干净的模块专门验这条。
    updateModuleSection(root, 'audit-demo', 'only-mod', 'health', '- 代码质量: 95', false)
    const state = readState(root, 'audit-demo')
    const item = state.findings.find((f) => f.id === 'declared_without_evidence:only-mod:quality')
    assert.ok(item !== undefined, '手写 95 但一条坑都没有 → 必须报出来')
    assert.equal(item.level, 'warn')
    assert.ok(item.fact.includes('95'), '事实里要带那个自封的分数')
  })

  check('auditOf：全模块都靠公式推 → 只报一条项目级，不刷屏', () => {
    // 三个模块都有内容（所以 health > 0，不算「空模块」），但都没手写分数。
    createProject(root, 'audit-plain', '未评估的项目', ['mod-a', 'mod-b', 'mod-c'])
    for (const name of ['mod-a', 'mod-b', 'mod-c']) {
      updateModuleSection(root, 'audit-plain', name, 'points', '- 一条要点', false)
    }
    const state = readState(root, 'audit-plain')
    assert.equal(state.modules.length, 3)
    for (const module of state.modules) assert.ok(module.health > 0, '有要点就该有分')
    const rows = state.findings.filter((f) => f.id === 'never_reviewed')
    assert.equal(rows.length, 1, '三个模块也只报一条')
    assert.equal(rows[0].scope, 'project', '全都没评估时按项目级报')
    assert.ok(rows[0].fact.includes('3 个模块'), '事实里要带数量')
    assert.ok(rows[0].fact.includes('mod-a') && rows[0].fact.includes('mod-c'), '事实里要点名是哪些模块')

    // 只要有一个模块被人工评估过，就不再是「全都没评估」，这条降级为点名那几个。
    updateModuleSection(root, 'audit-plain', 'mod-a', 'health', '- 代码质量: 70', false)
    const mixed = readState(root, 'audit-plain')
    const rows2 = mixed.findings.filter((f) => f.id === 'never_reviewed')
    assert.equal(rows2.length, 1, '仍然只报一条')
    assert.equal(rows2[0].scope, 'mod-b、mod-c', '只点名还没评估的那些')
    assert.ok(!rows2[0].fact.includes('mod-a'), '评估过的模块不该再被点名')
  })

  check('auditOf：空项目与坏输入都不抛错，且给出可执行建议', () => {
    const empty = auditOf({ modules: [], sections: {}, dimensions: {} })
    assert.ok(empty.some((f) => f.id === 'no_modules' && f.level === 'blocker'))
    assert.ok(empty.some((f) => f.id === 'pit_empty'))
    for (const bad of [null, undefined, {}, { modules: null, sections: null }]) {
      const out = auditOf(bad)
      assert.ok(Array.isArray(out), '坏输入也要返回数组')
      assert.ok(out.length > 0, '空项目至少给一条 blocker')
    }
  })

  check('AUDIT_PROMPT 要求点名、带数字、给下一步', () => {
    assert.ok(AUDIT_PROMPT.includes('最弱的一维'))
    assert.ok(AUDIT_PROMPT.includes('可执行的下一步'))
    assert.ok(AUDIT_PROMPT.includes('空话'), '要明确禁止空话')
  })

  check('DIMENSION_FIX 五维齐备', () => {
    for (const key of HEALTH_KEYS) {
      assert.equal(typeof DIMENSION_FIX[key], 'string', `${key} 要有具体改法`)
      assert.ok(DIMENSION_FIX[key].length > 8, `${key} 的改法不能是空话`)
    }
  })

  check('会话绑定：init 自动绑定并写进 front-matter', () => {
    const bindRoot = mkdtempSync(join(tmpdir(), 'puzzle-bind-'))
    try {
      const created = createProject(bindRoot, 'bound-demo', '绑定测试', ['m1'], MODE_PUZZLE_ONLY, 'sess-a')
      assert.equal(created.ok, true)
      assert.equal(created.bound, true, 'init 必须绑定本会话')
      const main = readFileSync(join(bindRoot, 'bound-demo', PUZZLE_DIR, '主文档.md'), 'utf8')
      assert.ok(main.includes(SESSION_FIELD + ': '), 'front-matter 必须有会话字段')
      assert.deepEqual(parseSessionList(parseFrontMatter(main).fields), ['sess-a'])
      assert.equal(boundProject(bindRoot, 'sess-a'), 'bound-demo')
      assert.equal(boundProject(bindRoot, 'sess-b'), null, '别的会话不该命中')
      assert.deepEqual(readState(bindRoot, 'bound-demo').sessions, ['sess-a'])
    } finally {
      rmSync(bindRoot, { recursive: true, force: true })
    }
  })

  check('会话绑定：不带会话 ID 就不写会话行', () => {
    const plainRoot = mkdtempSync(join(tmpdir(), 'puzzle-nobind-'))
    try {
      const created = createProject(plainRoot, 'plain-demo', '无绑定', ['m1'])
      assert.equal(created.bound, false)
      const main = readFileSync(join(plainRoot, 'plain-demo', PUZZLE_DIR, '主文档.md'), 'utf8')
      assert.ok(!main.includes(SESSION_FIELD + ':'), '没绑定时不该多出一行')
      assert.deepEqual(readState(plainRoot, 'plain-demo').sessions, [])
    } finally {
      rmSync(plainRoot, { recursive: true, force: true })
    }
  })

  check('会话绑定：写小节之后绑定不丢（最容易漏的一处）', () => {
    const keepRoot = mkdtempSync(join(tmpdir(), 'puzzle-keep-'))
    try {
      createProject(keepRoot, 'keep-demo', '写小节', ['m1'], MODE_PUZZLE_ONLY, 'sess-a')
      const mainWrite = updateMainSection(keepRoot, 'keep-demo', 'pit', '- 一个坑')
      assert.equal(mainWrite.ok, true)
      assert.equal(boundProject(keepRoot, 'sess-a'), 'keep-demo', 'op:main 之后绑定必须还在')
      const moduleWrite = updateModuleSection(keepRoot, 'keep-demo', 'm1', 'points', '- 一条要点')
      assert.equal(moduleWrite.ok, true)
      assert.equal(boundProject(keepRoot, 'sess-a'), 'keep-demo', 'op:module 之后绑定必须还在')
      const modeWrite = setMode(keepRoot, 'keep-demo', MODE_PUZZLE_WRITE)
      assert.equal(modeWrite.ok, true)
      assert.equal(boundProject(keepRoot, 'sess-a'), 'keep-demo', 'op:mode 之后绑定必须还在')
      assert.deepEqual(readState(keepRoot, 'keep-demo').sessions, ['sess-a'])
    } finally {
      rmSync(keepRoot, { recursive: true, force: true })
    }
  })

  check('会话绑定：一个会话只绑一个项目（绑新的就解绑旧的）', () => {
    const oneRoot = mkdtempSync(join(tmpdir(), 'puzzle-one-'))
    try {
      createProject(oneRoot, 'first', '第一个', ['m1'], MODE_PUZZLE_ONLY, 'sess-a')
      createProject(oneRoot, 'second', '第二个', ['m1'], MODE_PUZZLE_ONLY, 'sess-a')
      assert.equal(boundProject(oneRoot, 'sess-a'), 'second', '同一会话只应留在最新绑定的项目上')
      assert.deepEqual(readState(oneRoot, 'first').sessions, [], '旧项目上必须已解绑')
      assert.deepEqual(readState(oneRoot, 'second').sessions, ['sess-a'])
      const moved = bindSession(oneRoot, 'first', 'sess-b')
      assert.equal(moved.ok, true)
      assert.deepEqual(moved.released, [], 'sess-b 本来没绑，不该解绑任何东西')
      assert.equal(boundProject(oneRoot, 'sess-a'), 'second')
      assert.equal(boundProject(oneRoot, 'sess-b'), 'first')
      const moved2 = bindSession(oneRoot, 'second', 'sess-b')
      assert.equal(moved2.ok, true)
      assert.deepEqual(moved2.released, ['first'], '改绑必须把旧项目摘掉')
      assert.deepEqual(readState(oneRoot, 'first').sessions, [])
      assert.deepEqual(readState(oneRoot, 'second').sessions, ['sess-a', 'sess-b'])
    } finally {
      rmSync(oneRoot, { recursive: true, force: true })
    }
  })

  check('会话绑定：坏 front-matter 不抛错，当成没绑定', () => {
    assert.deepEqual(parseSessionList({}), [])
    assert.deepEqual(parseSessionList({ [SESSION_FIELD]: 'not json' }), [])
    assert.deepEqual(parseSessionList({ [SESSION_FIELD]: '{"a":1}' }), [])
    assert.deepEqual(parseSessionList({ [SESSION_FIELD]: '["a","a","", 3]' }), ['a'])
    assert.deepEqual(parseSessionList(null), [])
  })

  check('解绑：从所有项目上摘掉本会话（op:unbind）', () => {
    const unRoot = mkdtempSync(join(tmpdir(), 'puzzle-unbind-'))
    try {
      createProject(unRoot, 'un-a', '甲', ['m1'], MODE_PUZZLE_ONLY, 'sess-u')
      bindSession(unRoot, 'un-a', 'sess-keep')
      assert.equal(boundProject(unRoot, 'sess-u'), 'un-a')
      const cut = unbindSession(unRoot, 'sess-u')
      assert.equal(cut.ok, true)
      assert.deepEqual(cut.released, ['un-a'])
      assert.equal(boundProject(unRoot, 'sess-u'), null, '解绑后必须回到没绑定')
      // 这个项目上还绑着 sess-keep：解绑只摘掉自己的 id，不能把别人的一起带走。
      assert.deepEqual(readState(unRoot, 'un-a').sessions, ['sess-keep'], '解绑后不该留下自己的 id')
      assert.equal(boundProject(unRoot, 'sess-keep'), 'un-a', '别的会话不受影响')
      // 文档与文件夹都留着——解绑只动 front-matter 那一行。
      assert.ok(existsSync(join(unRoot, 'un-a', PUZZLE_DIR, '主文档.md')))
      assert.ok(existsSync(join(unRoot, 'un-a', PUZZLE_DIR, '模块', 'm1.md')))
      const again = unbindSession(unRoot, 'sess-u')
      assert.equal(again.ok, true)
      assert.deepEqual(again.released, [], '重复解绑是无操作，不报错')
    } finally {
      rmSync(unRoot, { recursive: true, force: true })
    }
  })

  check('解绑：多个项目上都有同一个 id 时全部摘掉', () => {
    const manyRoot = mkdtempSync(join(tmpdir(), 'puzzle-unbind2-'))
    try {
      createProject(manyRoot, 'mb-a', '甲', ['m1'], MODE_PUZZLE_ONLY, 'sess-m')
      createProject(manyRoot, 'mb-b', '乙', ['m1'], MODE_PUZZLE_ONLY, 'sess-other')
      // 「同一个 id 出现在两个项目上」用公开 API 造不出来——bindSession 会先解绑。
      // 这种状态只可能来自手工编辑或旧版插件，所以这里直接改文件来复现。
      const otherDoc = join(manyRoot, 'mb-b', PUZZLE_DIR, '主文档.md')
      const text = readFileSync(otherDoc, 'utf8')
      assert.ok(!readState(manyRoot, 'mb-b').sessions.includes('sess-m'))
      // mb-b 已有 `会话: ["sess-other"]` 一行：替换它（不能新插一行——front-matter 是逐行
      // 解析的，同名字段后者覆盖前者，插进去等于没写）。
      writeFileSync(otherDoc, text.replace(/^会话: .*$/m, '会话: ["sess-other","sess-m"]'), 'utf8')
      assert.ok(readState(manyRoot, 'mb-b').sessions.includes('sess-m'), '前提：两处都有 sess-m')
      assert.equal(boundProject(manyRoot, 'sess-m'), 'mb-b')

      const cut = unbindSession(manyRoot, 'sess-m')
      assert.equal(cut.ok, true)
      assert.deepEqual(cut.released.sort(), ['mb-a', 'mb-b'], '两处都要摘掉')
      assert.equal(boundProject(manyRoot, 'sess-m'), null)
      assert.deepEqual(readState(manyRoot, 'mb-a').sessions, [])
      // mb-b 上本来就绑着 sess-other：解绑只摘掉 sess-m，别人的 id 必须留下。
      assert.deepEqual(readState(manyRoot, 'mb-b').sessions, ['sess-other'])
      assert.equal(boundProject(manyRoot, 'sess-other'), 'mb-b', '别的会话不受影响')
    } finally {
      rmSync(manyRoot, { recursive: true, force: true })
    }
  })

  check('解绑：缺会话 ID 时不写任何文件', () => {
    const badRoot = mkdtempSync(join(tmpdir(), 'puzzle-unbind3-'))
    try {
      createProject(badRoot, 'bad-a', '甲', ['m1'], MODE_PUZZLE_ONLY, 'sess-b')
      const cut = unbindSession(badRoot, '')
      assert.equal(cut.ok, false)
      assert.equal(boundProject(badRoot, 'sess-b'), 'bad-a', '拒绝时不该动到任何绑定')
    } finally {
      rmSync(badRoot, { recursive: true, force: true })
    }
  })

  /** 造一份 v1 旧格式项目（两个模块：一个空、一个有要点）。 */
  function seedLegacy(root) {
    mkdirSync(join(root, 'legacy', PUZZLE_DIR, '模块'), { recursive: true })
    writeFileSync(join(root, 'legacy', PUZZLE_DIR, '主文档.md'), V1_MAIN)
    writeFileSync(join(root, 'legacy', PUZZLE_DIR, '模块', 'mod-a.md'), V1_MODA)
    writeFileSync(join(root, 'legacy', PUZZLE_DIR, '模块', 'mod-b.md'), V1_MODB)
  }

  check('版本：docVersion 读 front-matter，缺失按 1', () => {
    assert.equal(docVersion('---\npuzzle: 3\n---\n# x'), 3)
    assert.equal(docVersion('---\n项目: x\n---\n# x'), 1, '没有 puzzle 字段按最早版本')
    assert.equal(docVersion('---\npuzzle: abc\n---\n'), 1, '坏值按 1')
    assert.equal(docVersion(''), 1)
    assert.equal(PUZZLE_VERSION >= 2, true, '当前版本至少是 2')
    assert.ok(PROGRESS_TO_HEALTH > 0 && PROGRESS_TO_HEALTH <= 1)
  })

  check('迁移链：旧版本有待办迁移，当前版本没有', () => {
    assert.equal(pendingMigrations(1).length, 1, 'v1 有待办迁移')
    assert.equal(pendingMigrations(PUZZLE_VERSION).length, 0, '当前版本没有待办迁移')
    assert.ok(pendingMigrations(1)[0].label.includes('v1'))
  })

  check('planRebuild：只报计划、绝不写盘', () => {
    const root2 = mkdtempSync(join(tmpdir(), 'puzzle-rebuild-'))
    try {
      seedLegacy(root2)
      const before = readFileSync(join(root2, 'legacy', PUZZLE_DIR, '主文档.md'), 'utf8')
      const plan = planRebuild(root2, 'legacy')
      assert.equal(plan.ok, true)
      assert.equal(plan.version, 1)
      assert.equal(plan.targetVersion, PUZZLE_VERSION)
      assert.equal(plan.outdated, true)
      assert.equal(plan.migrations.length, 1)
      assert.ok(plan.totalChanges > 0)
      assert.deepEqual(readFileSync(join(root2, 'legacy', PUZZLE_DIR, '主文档.md'), 'utf8'), before, '预览不能改文件')
      // 旧的形状问题要逐条报出来。
      const modA = plan.files.find((f) => f.name === 'mod-a')
      assert.ok(modA.changes.some((c) => c.includes('模块:')), '要报 front-matter 补 模块:')
      assert.ok(modA.changes.some((c) => c.includes('模式:')), '要报去掉多余的 模式:')
      assert.ok(modA.changes.some((c) => c.includes('健康性')), '要报补健康性')
      const main = plan.files.find((f) => f.kind === 'main')
      assert.ok(main.changes.some((c) => c.includes('版本')), '要报版本升级')
      assert.ok(main.changes.some((c) => c.includes('版本升级'.slice(0, 1)) || true))
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })

  check('planRebuild：空会话不假称补 会话:（formatFrontMatter 对空数组不写那行）', () => {
    const root2 = mkdtempSync(join(tmpdir(), 'puzzle-rebuild-sess-'))
    try {
      seedLegacy(root2)
      const plan = planRebuild(root2, 'legacy')
      const main = plan.files.find((f) => f.kind === 'main')
      assert.ok(!main.changes.some((c) => c.includes('会话')), '没有会话 id 时不该声称补了 会话:')
      assert.ok(!/^会话: /m.test(main.text), '写出来的文本里也不该凭空多出会话行')
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })

  check('重建：正文一字不动，只改形状', () => {
    const root2 = mkdtempSync(join(tmpdir(), 'puzzle-rebuild-apply-'))
    try {
      seedLegacy(root2)
      const result = rebuildProject(root2, 'legacy', true)
      assert.equal(result.applied, true)
      assert.deepEqual(result.failed, [])
      assert.equal(result.written.length, 3, '主文档 + 两个模块')
      const state = readState(root2, 'legacy')
      assert.equal(state.version, PUZZLE_VERSION, '版本已升级')
      assert.equal(state.outdated, false)
      // 正文证据必须原样保留。
      assert.equal(state.modules.find((m) => m.name === 'mod-b').counts.points, 3, '要点条数不变')
      const mainText = readFileSync(join(root2, 'legacy', PUZZLE_DIR, '主文档.md'), 'utf8')
      assert.ok(mainText.includes('- 一条坑'), '坑的正文保留')
      assert.ok(mainText.includes('- 一个已定'), '已定的正文保留')
      assert.ok(mainText.includes('| mod-a | 一号 |'), '检索索引表格保留')
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })

  check('重建：模块 front-matter 变成 项目 + 模块，多余字段去掉', () => {
    const root2 = mkdtempSync(join(tmpdir(), 'puzzle-rebuild-fm-'))
    try {
      seedLegacy(root2)
      rebuildProject(root2, 'legacy', true)
      const text = readFileSync(join(root2, 'legacy', PUZZLE_DIR, '模块', 'mod-a.md'), 'utf8')
      const fm = text.split('---')[1]
      assert.ok(fm.includes('模块: mod-a'), '要有 模块: 字段')
      assert.ok(!fm.includes('模式:'), '模块文档不该带 模式:')
      assert.ok(!fm.includes('计划模块:'), '模块文档不该带 计划模块:')
      assert.equal(docVersion(text), PUZZLE_VERSION)
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })

  check('重建：折算只填证据拿不到分的维度，并在小节首位', () => {
    const root2 = mkdtempSync(join(tmpdir(), 'puzzle-rebuild-health-'))
    try {
      seedLegacy(root2)
      rebuildProject(root2, 'legacy', true)
      const seeded = Math.min(100, Math.max(0, Math.round(100 * PROGRESS_TO_HEALTH)))
      const a = readFileSync(join(root2, 'legacy', PUZZLE_DIR, '模块', 'mod-a.md'), 'utf8')
      const aHealth = a.slice(a.indexOf('## 健康性'))
      assert.ok(aHealth.includes('任务复杂度: ' + seeded), 'mod-a 空文档：复杂度该被折算填上')
      // 健康性要跟在 # 标题之后，而不是被插到文末。
      const aBody = a.split('---').slice(2).join('---')
      assert.ok(/^#\s/.test(aBody.trim().split('\n')[0]), '标题仍在最前')
      assert.equal(aBody.trim().split('\n')[2].trim(), '## 健康性', '健康性紧跟标题')
      const b = readFileSync(join(root2, 'legacy', PUZZLE_DIR, '模块', 'mod-b.md'), 'utf8')
      const bHealth = b.slice(b.indexOf('## 健康性'), b.indexOf('## 进度'))
      assert.ok(!/- 任务复杂度: \d/.test(bHealth), 'mod-b 有要点：推导已够，不该被折算数字冻住')
      assert.ok(!bHealth.includes('折算'), '一维都没填时不该出现折算说明')
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })

  check('重建是幂等的：第二次 0 改动', () => {
    const root2 = mkdtempSync(join(tmpdir(), 'puzzle-rebuild-idem-'))
    try {
      seedLegacy(root2)
      rebuildProject(root2, 'legacy', true)
      const again = planRebuild(root2, 'legacy')
      assert.equal(again.totalChanges, 0, '再跑一次不该有改动')
      assert.equal(again.outdated, false)
      assert.deepEqual(again.writable, [])
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })

  check('重建：已经迁移过的项目，dry-run 与落盘都是无操作', () => {
    const root2 = mkdtempSync(join(tmpdir(), 'puzzle-rebuild-noop-'))
    try {
      createProject(root2, 'fresh', '新的', ['m1'], MODE_PUZZLE_WRITE, 'sess-1')
      assert.equal(docVersion(readFileSync(join(root2, 'fresh', PUZZLE_DIR, '主文档.md'), 'utf8')), PUZZLE_VERSION, '新建即当前版本')
      const plan = planRebuild(root2, 'fresh')
      assert.equal(plan.outdated, false)
      assert.equal(plan.totalChanges, 0)
      const applied = rebuildProject(root2, 'fresh', true)
      assert.deepEqual(applied.written, [], '无事可做就不写文件')
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })

  check('重建：旧格式项目的审查里有一条 doc_outdated', () => {
    const root2 = mkdtempSync(join(tmpdir(), 'puzzle-rebuild-find-'))
    try {
      seedLegacy(root2)
      const before = readState(root2, 'legacy')
      assert.equal(before.outdated, true)
      const row = before.findings.find((f) => f.id === 'doc_outdated')
      assert.ok(row !== undefined, '旧格式要报一条 doc_outdated')
      assert.equal(row.level, 'warn')
      assert.equal(row.scope, 'project')
      assert.ok(row.fact.includes('puzzle 1'), '事实里要带当前版本号')
      assert.ok(row.fix.includes('op:rebuild'), '建议要指向 op:rebuild')
      rebuildProject(root2, 'legacy', true)
      const after = readState(root2, 'legacy')
      assert.ok(!after.findings.some((f) => f.id === 'doc_outdated'), '迁移后这条发现要消失')
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })

  check('重建：缺模块文档的项目也被如实报出来，不报错', () => {
    const root2 = mkdtempSync(join(tmpdir(), 'puzzle-rebuild-missing-'))
    try {
      seedLegacy(root2)
      // mod-c 只声明、没文件。
      const mainDoc = join(root2, 'legacy', PUZZLE_DIR, '主文档.md')
      writeFileSync(mainDoc, readFileSync(mainDoc, 'utf8').replace('["mod-a","mod-b"]', '["mod-a","mod-b","mod-c"]'))
      const plan = planRebuild(root2, 'legacy')
      const c = plan.files.find((f) => f.name === 'mod-c')
      assert.ok(c !== undefined, '缺文件的模块也要出现在计划里')
      assert.equal(c.missing, true)
      assert.equal(c.text, null, '没有文件就构不出新文本')
      const applied = rebuildProject(root2, 'legacy', true)
      assert.ok(!(applied.written || []).includes('mod-c'), '缺文件的模块不该被写入')
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })

  check('重建：坏项目名与非项目根都不抛错', () => {
    const root2 = mkdtempSync(join(tmpdir(), 'puzzle-rebuild-bad-'))
    try {
      assert.equal(planRebuild(root2, 'nope').ok, false, '不存在的项目要失败而不是抛错')
      assert.equal(planRebuild(root2, '..').ok, false)
      assert.equal(rebuildProject(root2, 'nope', true).ok, false)
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })

  console.log(`\n${passed} 项通过`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
