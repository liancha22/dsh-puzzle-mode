/**
 * dsh-puzzle-mode 纯逻辑测试（无 Cordis 依赖）。
 *
 *   node test/10-puzzle.test.mjs
 *
 * 覆盖：目录守卫、建项目（多份文档）、小节合并、模式写入，
 * 以及**五维项目健康性**：显式分数、证据推导、反向维度、跨模块汇总。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
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
  summarizeList,
  updateMainSection,
  updateModuleSection,
  updateProjectHealth,
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

  console.log(`\n${passed} 项通过`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
