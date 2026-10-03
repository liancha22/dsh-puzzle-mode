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
import { isFile } from '../lib/util.js'
import {
  AUDIT_PROMPT,
  ASK_MAX_OPTIONS,
  ASK_MAX_QUESTIONS,
  DIMENSION_FIX,
  ENTRY_CAPS,
  ENTRY_LIMITS,
  HEALTH_DIMENSIONS,
  HEALTH_HEADING,
  HEALTH_KEYS,
  MODE_PUZZLE_ONLY,
  MODE_PUZZLE_WRITE,
  PAUSE_OPTIONS,
  PAUSE_QUESTION,
  PUZZLE_DIR,
  MAIN_FILE,
  scanUnpuzzled,
  SECTION_HEADINGS,
  SECTION_ORDER,
  SIZE_LARGE,
  SIZE_MEDIUM,
  capsOfSize,
  limitsOfSize,
  MODULE_SECTION_HEADINGS,
  SESSION_FIELD,
  auditOf,
  bindSession,
  boundProject,
  boundProjects,
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
  setSize,
  setSourceRoot,
  sizeOfProject,
  writeSessionList,
  writeWorkflowDoc,
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
// v0.19.8：改成「全部跑完再报」——原先是首个失败就 throw，
// 上游一轮格式改造留下的陈旧断言只能一个个冒出来，看不见全貌。
const failed = []
const skipped = []

// 已知上游漂移（v0.19.8 盘点）：14 条断言停在文档格式 v4 时代 —— 检索索引/用户原话/悬而未决/
// 已定/撤销五节、`related` 合体小节、项目级显式健康性、六节主文档计数等，现行 v6 都已改掉。
// 这些在**改动前的干净树上同样失败**（不是本轮引入的）。打标记而不是静默跳过：每条都留名与理由，
// 待逐个重写成 v6 断言后从这个集合里划掉。清单同步在 CHANGELOG v0.19.8。
const KNOWN_DRIFT = new Set([])  // v0.19.8：10 条旧断言已全部改写成 v6 断言，名单清空

function check(name, fn) {
  // 已知漂移的条目**照样跑**（它们大多在为后面几条铺状态，直接跳过会连锁误报），
  // 只把断言失败降级成 skip 标记；非漂移条目失败照旧计入 failed。
  const drift = KNOWN_DRIFT.has(name)
  try {
    fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    if (drift) {
      skipped.push(name)
      console.log(`skip ${name} —— 已知上游漂移：${error.message.split('\n')[0]}`)
      return
    }
    failed.push({ name, message: error.message })
    console.error(`FAIL ${name} —— ${error.message}`)
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
    // v0.19.8 修：这条断言停在文档格式 v4（检索索引 / 用户原话 / 悬而未决 / 已定 / 撤销），
    // 而现行格式是 v6 五节（模块索引 / 源码索引 / 工具索引 / 坑 / 工作流）——
    // 「悬而未决 / 已定」已下沉到模块文档，「用户原话 / 撤销」两节取消。断言按现行格式写。
    // 小节名**引常量**而不是写死（v0.19.8）：改格式只改 constants.js，这里自动跟上。
    assert.deepEqual(SECTION_ORDER, ['index', 'source', 'tools', 'pit', 'workflow'])
    for (const key of SECTION_ORDER) {
      assert.ok(main.includes(SECTION_HEADINGS[key]), `主文档缺少 ${SECTION_HEADINGS[key]}`)
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
      HEALTH_HEADING,
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
    // v0.19.8 修：v6 的条目式小节每条必须带「（源码: 文件:行）」，否则不入库、不计分。
    // 旧测试写的是裸行（`- 要点一`），所以打分恒为 0 —— 这里补上出处，判据才落得下去。
    updateModuleSection(root, 'demo', 'session-store', 'points', '- 要点一（源码: lib/a.js:1）\n- 要点二（源码: lib/a.js:2）', false)
    updateModuleSection(root, 'demo', 'session-store', 'detail', '- 详细一（源码: lib/a.js:3）', false)
    // v0.19.8 修：related 是文档格式 v4 的合体小节（已定 + 悬而未决混在一处），
    // v6 拆成 pending / decided 两个小节 —— 继续写 related 不落任何分。
    updateModuleSection(root, 'demo', 'session-store', 'decided', '- 已定一（源码: lib/a.js:4）', false)
    updateModuleSection(root, 'demo', 'session-store', 'pending', '- 待定一（源码: lib/a.js:5）', false)
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

  // v0.19.8 修：项目级显式分数**已取消**（lib/health.js:169 —— 主文档只剩规范五节，
  // 没有 `## 健康性` 的容身处）。旧断言测的是一个不存在的功能，改成测现行契约：拒写 + 说明去处。
  check('项目级显式分数已取消：拒写并指路到模块文档', () => {
    const written = updateProjectHealth(root, 'demo', '- 代码质量: 88', false)
    assert.equal(written.ok, false)
    assert.match(written.error, /项目级健康性不再写进文档/)
    assert.match(written.hint, /op:health/)
    const state = readState(root, 'demo')
    const module = state.modules.find((m) => m.name === 'session-store')
    assert.notEqual(module.healthSources.quality, 'project', '模块分数不得再来自项目级')
  })

  check('模块级显式分数仍然生效（与已取消的项目级无关）', () => {
    const state = readState(root, 'demo')
    const module = state.modules.find((m) => m.name === 'auth-flow')
    assert.equal(module.healthSources.quality, 'module')
    assert.equal(module.healthScores.quality, 60, 'auth-flow 自己写了 60')
  })

  // v0.19.8 修：同一处取消的反面 —— 主文档**不该**再出现健康性小节（五节之外禁写）。
  check('主文档不再出现健康性小节（五节之外禁写）', () => {
    const main = readFileSync(join(root, 'demo', PUZZLE_DIR, '主文档.md'), 'utf8')
    assert.ok(!main.includes(HEALTH_HEADING), '主文档不应有健康性小节')
    assert.ok(!main.includes('代码质量: 88'))
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

  check('主文档「坑」条目带括号内容也能落盘（v6：条目要带源码出处）', () => {
    const w = updateMainSection(root, 'demo', 'pit', '- （见模块 auth-flow）（源码: lib/a.js:1）', false)
    assert.equal(w.ok, true, w.error)
    const state = readState(root, 'demo')
    const main = readFileSync(state.mainDoc, 'utf8')
    assert.ok(main.includes('见模块 auth-flow'), '括号里的内容必须写进文档')
    assert.ok(sectionCounts(main).pit >= 1, '「坑」要算一条')
  })

  check('append 默认追加、不覆盖既有内容（主文档 pit 段）', () => {
    updateMainSection(root, 'demo', 'pit', '- 坑甲（源码: lib/a.js:1）', false)
    updateMainSection(root, 'demo', 'pit', '- 坑乙（源码: lib/a.js:2）', true)
    const main = readFileSync(readState(root, 'demo').mainDoc, 'utf8')
    assert.ok(main.includes('坑甲') && main.includes('坑乙'), '追加不能覆盖')
  })

  check('目录守卫：越界模块名被 slug 化后仍关在拼图目录内', () => {
    const written = updateModuleSection(root, 'demo', '../../evil', 'points', '- x（源码: lib/a.js:1）', false)
    assert.equal(written.file, join(root, 'demo', PUZZLE_DIR, '模块', 'evil.md'))
    assert.equal(existsSync(join(root, 'evil.md')), false)
  })

  check('readModuleDetail 带五维；不存在的模块不建文件', () => {
    updateModuleSection(root, 'demo', 'auth-flow', 'points', '- 要点甲（源码: lib/a.js:1）\n- - 要点乙（源码: lib/a.js:1）', false)
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

  check('sectionCounts 数主文档五节（v6 格式），且不吃模板占位', () => {
    const text = readFileSync(readState(root, 'demo').mainDoc, 'utf8')
    const counts = sectionCounts(text)
    // v6：检索索引→模块索引、新增源码/工具索引；用户原话·悬而未决·已定·撤销四节取消
    assert.deepEqual(Object.keys(counts), ['index', 'source', 'tools', 'pit', 'workflow'])
    assert.ok(counts.pit >= 1, '「坑」里那条要算数')
  })

  check('dimensionRanking 按分数升序，最弱的一维排最前', () => {
    const ranking = dimensionRanking({ complexity: 50, extensibility: 10, maintenance: 90, quality: 0, reusability: 70 })
    assert.equal(ranking.length, 5)
    assert.equal(ranking[0].key, 'quality', '0 分排第一')
    assert.equal(ranking[0].name, '代码质量', 'ranking 要带中文名')
    assert.equal(ranking[4].key, 'maintenance', '90 分排最后')
    for (let i = 1; i < ranking.length; i += 1) assert.ok(ranking[i - 1].value <= ranking[i].value, '必须升序')
  })

  check('可拓展性只来自模块文档（v6 已无主文档决策小节）', () => {
    const isolated = createProject(root, 'audit-demo', '审查用', ['only-mod'])
    assert.equal(isolated.ok, true)
    const before = readState(root, 'audit-demo')
    assert.equal(before.modules[0].healthScores.extensibility, 0, '没写决策时是 0')

    const refused = updateMainSection(root, 'audit-demo', 'decided', '- [x] 结论甲', false)
    assert.equal(refused.ok, false, '主文档没有 decided 小节')
    assert.ok(/未知小节/.test(refused.error), refused.error)

    updateModuleSection(root, 'audit-demo', 'only-mod', 'pending', '- 待定乙（源码: lib/a.js:1）', false)
    updateModuleSection(root, 'audit-demo', 'only-mod', 'decided', '- 已定甲（源码: lib/a.js:2）', false)
    const after = readState(root, 'audit-demo')
    assert.equal(after.modules[0].healthSources.extensibility, 'derived')
    assert.equal(after.modules[0].healthScores.extensibility, 40, '模块 1 悬 + 1 定 → 40')
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
    updateModuleSection(root, 'audit-demo', 'only-mod', 'points', '- 一条真要点（源码: lib/a.js:1）', false)
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
    // v0.19.8 修：旧写法借用 audit-demo/only-mod，而那一轮前面的用例已经给它写了
    // 要点/已定（也就是**有**证据了），warn 自然不触发。这条必须自带干净模块。
    createProject(root, 'audit-decl', '自封分数专用', ['bare-mod'])
    updateModuleSection(root, 'audit-decl', 'bare-mod', 'health', '- 代码质量: 95', false)
    const state = readState(root, 'audit-decl')
    const item = state.findings.find((f) => f.id === 'declared_without_evidence:bare-mod:quality')
    assert.ok(item !== undefined, '手写 95 但一条证据都没有 → 必须报出来')
    assert.equal(item.level, 'warn')
    assert.ok(item.fact.includes('95'), '事实里要带那个自封的分数')
  })

  check('auditOf：全模块都靠公式推 → 只报一条项目级，不刷屏', () => {
    createProject(root, 'audit-plain', '未评估的项目', ['mod-a', 'mod-b', 'mod-c'])
    for (const name of ['mod-a', 'mod-b', 'mod-c']) {
      const w = updateModuleSection(root, 'audit-plain', name, 'points', '- 一条要点（源码: lib/a.js:1）', false)
      assert.equal(w.ok, true, w.error)
    }
    const state = readState(root, 'audit-plain')
    assert.equal(state.modules.length, 3)
    for (const module of state.modules) assert.ok(module.health > 0, '有要点就该有分')
    const rows = state.findings.filter((f) => f.id === 'never_reviewed')
    assert.equal(rows.length, 1, '三个模块也只报一条')
    assert.equal(rows[0].scope, 'project', '全都没评估时按项目级报')
    assert.ok(/\d+ 个模块/.test(rows[0].fact), '事实里要带数量：' + rows[0].fact)
    assert.ok(rows[0].fact.includes('mod-a'), '事实里要点名模块：' + rows[0].fact)
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

  check('AUDIT_PROMPT 要求带数字、禁空话、四段齐', () => {
    assert.ok(AUDIT_PROMPT.includes('带数字'), '要带数字')
    assert.ok(AUDIT_PROMPT.includes('空话'), '要明确禁止空话')
    assert.ok(AUDIT_PROMPT.includes('四段'), '要说明四段结构')
    assert.ok(AUDIT_PROMPT.includes('fix'), '要写清 fix 段')
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
      const mainWrite = updateMainSection(keepRoot, 'keep-demo', 'pit', '- 一个坑（源码: lib/a.js:1）')
      assert.equal(mainWrite.ok, true)
      assert.equal(boundProject(keepRoot, 'sess-a'), 'keep-demo', 'op:main 之后绑定必须还在')
      const moduleWrite = updateModuleSection(keepRoot, 'keep-demo', 'm1', 'points', '- 一条要点（源码: lib/a.js:1）')
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

  /**
   * v7 起这条**换了契约**（用户裁定：一个会话同时操作几个项目）：
   *   · `op:init` / 建项目 = **追加**绑定（建个项目不该抹掉别的绑定）；
   *   · `op:bind` = **替换全部**绑定（模型说「就绑这一个」时才是它）。
   * v6 及更早「一个会话只绑一个项目」那条不变量已被有意废除，所以旧断言换成这两条。
   */
  check('会话绑定：建第二个项目是**追加**绑定，不抹掉第一个（v7）', () => {
    const oneRoot = mkdtempSync(join(tmpdir(), 'puzzle-one-'))
    try {
      createProject(oneRoot, 'first', '第一个', ['m1'], MODE_PUZZLE_ONLY, 'sess-a')
      createProject(oneRoot, 'second', '第二个', ['m1'], MODE_PUZZLE_ONLY, 'sess-a')
      // 后建的成为当前项目（工具落点），但第一个仍然绑着——这是 v7 的核心变化。
      assert.equal(boundProject(oneRoot, 'sess-a'), 'second', '新建的项目应成为当前项目')
      assert.deepEqual(boundProjects(oneRoot, 'sess-a').sort(), ['first', 'second'], '建项目是追加绑定')
      assert.deepEqual(readState(oneRoot, 'first').sessions, ['sess-a'], '旧项目上必须还绑着')
      assert.deepEqual(readState(oneRoot, 'second').sessions, ['sess-a'])
      // 别的会话不受影响：`sess-b` 绑 first 与 `sess-a` 的绑定互不干扰。
      const moved = bindSession(oneRoot, 'first', 'sess-b')
      assert.equal(moved.ok, true)
      assert.deepEqual(moved.released, [], 'sess-b 本来没绑，不该解绑任何东西')
      assert.equal(boundProject(oneRoot, 'sess-a'), 'second', 'sess-a 的当前项目不该被别人动')
      assert.equal(boundProject(oneRoot, 'sess-b'), 'first')
      assert.deepEqual(boundProjects(oneRoot, 'sess-a').sort(), ['first', 'second'])
    } finally {
      rmSync(oneRoot, { recursive: true, force: true })
    }
  })

  check('会话绑定：op:bind 是**替换全部**绑定（改绑必须把旧项目摘掉）', () => {
    const oneRoot = mkdtempSync(join(tmpdir(), 'puzzle-one-'))
    try {
      createProject(oneRoot, 'first', '第一个', ['m1'], MODE_PUZZLE_ONLY, 'sess-a')
      createProject(oneRoot, 'second', '第二个', ['m1'], MODE_PUZZLE_ONLY, 'sess-a')
      const moved2 = bindSession(oneRoot, 'second', 'sess-a')
      assert.equal(moved2.ok, true)
      assert.deepEqual(moved2.released, ['first'], '改绑必须把旧项目摘掉')
      assert.deepEqual(readState(oneRoot, 'first').sessions, [])
      assert.deepEqual(readState(oneRoot, 'second').sessions, ['sess-a'])
      assert.deepEqual(boundProjects(oneRoot, 'sess-a'), ['second'])
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
      // 同一个 id 落到两个项目：走公开 API 的正常路径 —— 换绑（旧绑定会被摘掉）
      const rebind = bindSession(manyRoot, 'mb-b', 'sess-m')
      assert.equal(rebind.ok, true, rebind.error)
      const out = unbindSession(manyRoot, 'sess-m')
      assert.equal(out.ok, true, out.error)
      assert.ok(!readState(manyRoot, 'mb-a').sessions.includes('sess-m'), '甲上要摘净')
      assert.ok(!readState(manyRoot, 'mb-b').sessions.includes('sess-m'), '乙上要摘净')
    } finally { rmSync(manyRoot, { recursive: true, force: true }) }
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
    const chain = pendingMigrations(1)
    assert.ok(chain.length >= 1, 'v1 有待办迁移')
    assert.equal(pendingMigrations(PUZZLE_VERSION).length, 0, '当前版本没有待办迁移')
    assert.ok(chain[0].label.includes('v1'))
  })

  /**
   * v0.21.0 ①：`scanUnpuzzled` 只列「还没有拼图文档」的顶层目录，并排除噪音目录。
   *
   * 用户需求原话：「造着项目建文档加一个自动判断此会话是否有多个项目」。
   * 判据要**宽**（纯数据目录、脚本集合也是用户眼里的项目），但噪音目录必须挡掉——
   * 把 node_modules / .git 列给用户勾选，等于让他在噪音里找信号。
   */
  check('scanUnpuzzled：只列没文档的目录，且排除噪音目录', () => {
    const root2 = mkdtempSync(join(tmpdir(), 'puzzle-scan-'))
    try {
      for (const name of ['alpha', 'beta']) {
        mkdirSync(join(root2, name))
        writeFileSync(join(root2, name, 'README.md'), 'x')
      }
      // 噪音目录：依赖 / 版本控制 / 隐藏
      mkdirSync(join(root2, 'node_modules'))
      mkdirSync(join(root2, '.git'))
      mkdirSync(join(root2, '.cache'))
      // 已有拼图文档的目录：不该再被列出来
      createProject(root2, 'done', 'x', [], '写后再拼', 's1')
      const names = scanUnpuzzled(root2).map((item) => item.name)
      assert.deepEqual(names.sort(), ['alpha', 'beta'], '只列没文档的普通目录')
      assert.ok(!names.includes('done'), '已经有拼图文档的目录不该再列')
      assert.ok(!names.includes('node_modules') && !names.includes('.git'), '噪音目录必须排除')
      // 证据：每条带上目录里的文件名，用户靠它认人
      const alpha = scanUnpuzzled(root2).find((item) => item.name === 'alpha')
      assert.ok(Array.isArray(alpha.entries) && alpha.entries.includes('README.md'), '要带目录内容当证据')
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })

  /**
   * v0.21.0 ①：一次建多个项目 = **全部追加绑定**（用户裁定），最后一个成为当前。
   */
  check('一次建多个项目：全部追加绑定，最后一个成为当前', () => {
    const root2 = mkdtempSync(join(tmpdir(), 'puzzle-many-'))
    try {
      for (const name of ['alpha', 'beta', 'gamma']) {
        mkdirSync(join(root2, name))
        writeFileSync(join(root2, name, 'README.md'), 'x')
      }
      const sid = 'sess-many'
      for (const name of ['alpha', 'beta', 'gamma']) {
        const created = createProject(root2, name, '', [], '写后再拼', sid)
        assert.equal(created.ok, true, name + ' 要建得出来')
      }
      const bound = boundProjects(root2, sid)
      assert.equal(bound.length, 3, '三个都该绑上（不是只留最后一个）')
      assert.equal(bound[0], 'gamma', '最后一个建的成为当前项目')
      // 每个都真的落了一份主文档
      for (const name of ['alpha', 'beta', 'gamma']) {
        assert.ok(isFile(join(root2, name, PUZZLE_DIR, MAIN_FILE)), name + ' 要有主文档')
      }
    } finally {
      rmSync(root2, { recursive: true, force: true })
    }
  })

  check('planRebuild：只报计划、绝不写盘', () => {
    const root2 = mkdtempSync(join(tmpdir(), 'puzzle-rebuild-'))
    try {
      seedLegacy(root2)
      const file = join(root2, 'legacy', PUZZLE_DIR, '主文档.md')
      const before = readFileSync(file, 'utf8')
      const plan = planRebuild(root2, 'legacy')
      assert.equal(plan.ok, true, plan.error)
      assert.equal(plan.version, 1)
      assert.equal(plan.targetVersion, PUZZLE_VERSION)
      assert.equal(plan.outdated, true)
      assert.ok(plan.migrations.length >= 1, 'v1 → 当前 至少有一步迁移')
      assert.deepEqual(readFileSync(file, 'utf8'), before, '预览不能改文件')
    } finally { rmSync(root2, { recursive: true, force: true }) }
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
      assert.equal(result.applied, true, JSON.stringify(result.failed || []))
      assert.deepEqual(result.failed, [])
      assert.ok(result.written.length >= 2, '主文档 + 模块')
      const state = readState(root2, 'legacy')
      assert.equal(state.version, PUZZLE_VERSION, '版本已升级')
      assert.equal(state.outdated, false)
      // 正文证据必须原样保留（v1 的三条要点仍在新模块文档里）
      const after = readFileSync(join(root2, 'legacy', PUZZLE_DIR, '模块', 'mod-b.md'), 'utf8')
      for (const keep of ['要点一', '要点二', '要点三']) assert.ok(after.includes(keep), `正文要保留 ${keep}`)
    } finally { rmSync(root2, { recursive: true, force: true }) }
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
      const aHealth = a.slice(a.indexOf(HEALTH_HEADING))
      assert.ok(aHealth.includes('任务复杂度: ' + seeded), 'mod-a 空文档：复杂度该被折算填上')
      // 健康性要跟在 # 标题之后，而不是被插到文末。
      const aBody = a.split('---').slice(2).join('---')
      assert.ok(/^#\s/.test(aBody.trim().split('\n')[0]), '标题仍在最前')
      assert.equal(aBody.trim().split('\n')[2].trim(), HEALTH_HEADING, '健康性紧跟标题')
      const b = readFileSync(join(root2, 'legacy', PUZZLE_DIR, '模块', 'mod-b.md'), 'utf8')
      const bHealth = b.slice(b.indexOf(HEALTH_HEADING), b.indexOf(MODULE_SECTION_HEADINGS.progress))
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

  /* -------- 规模档位必须在所有重写 front-matter 的路径上被透传（v0.23.3） -------- */

  /**
   * 真实事故（本仓自己的数据被删）：`updateMainSection` 重写 front-matter 时
   * **漏透传 `规模:`**，于是「追加一条坑」把 `规模: 大` 抹掉 → 下次读按**中档** →
   * 中档的 `pit` 上限更严 → **下一次写入静默删掉超出的条目**。
   * 实测代价：主文档「坑」149 条被砍到 60 条，**丢了 93 条**（后按 dropped 原文恢复）。
   *
   * 同一形状的坑在本仓已出现多次（`setMainFields` 的注释里就写着这个后果），
   * 所以这里**把每条重写路径都过一遍**，而不是只测踩到的那一条。
   */
  check('规模档位在所有重写 front-matter 的路径上都被透传', () => {
    const dir = mkdtempSync(join(tmpdir(), 'size-preserve-'))
    try {
      createProject(dir, 'p', '目标', ['m1'], MODE_PUZZLE_ONLY, 'sess')
      setSize(dir, 'p', SIZE_LARGE)
      assert.equal(sizeOfProject(dir, 'p'), SIZE_LARGE, '取证：起始档位是「大」')
      const mainDoc = join(dir, 'p', PUZZLE_DIR, MAIN_FILE)
      const read = () => readFileSync(mainDoc, 'utf8')

      const paths = [
        ['op:main 写坑', () => updateMainSection(dir, 'p', 'pit', '- 一条坑（源码: lib/a.js:1）', true)],
        ['op:main 写工作流', () => updateMainSection(dir, 'p', 'workflow', '### 流程\n- 步骤一', true)],
        ['op:module 写模块', () => updateModuleSection(dir, 'p', 'm1', 'points', '- 一个要点（源码: lib/a.js:1）', true)],
        ['改模式', () => setMode(dir, 'p', MODE_PUZZLE_ONLY)],
        ['改源码根', () => setSourceRoot(dir, 'p', '/tmp')],
        ['写会话绑定', () => writeSessionList(mainDoc, read(), ['sess', 'sess2'], ['sess'])],
        ['写工作流归档', () => writeWorkflowDoc(mainDoc, read(), [], [])],
      ]
      for (const [label, run] of paths) {
        const r = run()
        assert.notEqual(r && r.ok, false, `「${label}」本身应成功：${r && r.error}`)
        assert.equal(sizeOfProject(dir, 'p'), SIZE_LARGE,
          `「${label}」之后 规模: 丢了——这正是静默删掉 93 条数据的那个 bug`)
      }
      // 而且必须**真的还写着那一行**，不是靠默认值蒙对。
      assert.match(read(), /^规模: 大$/m, 'front-matter 里必须真的还有 `规模: 大`')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /* ---------------- 审查器必须按规模档位取上限（v0.24.2 真 bug） ---------------- */

  /**
   * 用户原话：「审查器没有同步规模改动」。
   *
   * 三处写死了**中档**值：`audit.js` 的条数上限用 `ENTRY_CAPS`（4/10）、
   * `project.js` 的条目字数用 `MAIN_ENTRY_SPEC` / `MODULE_ENTRY_SPEC`（源自中档 `ENTRY_LIMITS`）。
   * 而写入侧走的是 `capsOfSize` / `limitsOfSize`——于是**大档项目写进去合法、审查却报警**。
   * 这正是本仓记过的「两把尺子」。
   *
   * 这条断言从**两个方向**钉住它：大档合法条目不许被报，中档超限条目仍须被报
   * （只测前者的话，把上限全改成 `Infinity` 也能绿）。
   */
  check('审查按规模档位取上限：大档不误报，中档仍会报', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puzzle-size-audit-'))
    try {
      createProject(dir, 'big', '目标', ['m1'], MODE_PUZZLE_WRITE, 'sess-big')
      setSize(dir, 'big', '大', 'sess-big')
      const bigLimits = limitsOfSize(SIZE_LARGE)
      const bigCaps = capsOfSize(SIZE_LARGE)
      // 大档比中档宽——不成立的话这条断言本身没意义。
      assert.ok(bigLimits.points > ENTRY_LIMITS.points,
        `大档要点上限应大于中档（${bigLimits.points} > ${ENTRY_LIMITS.points}）`)
      assert.ok(bigCaps.decided > ENTRY_CAPS.decided,
        `大档已定上限应大于中档（${bigCaps.decided} > ${ENTRY_CAPS.decided}）`)

      // 写一条**中档超长、大档合法**的要点：长度取两档之间。
      const target = ENTRY_LIMITS.points + 5
      const text = '要'.repeat(target)
      assert.ok(target <= bigLimits.points, '构造的要点长度须在大档上限内')
      const wrote = updateModuleSection(dir, 'big', 'm1', 'points',
        `- ${text}（源码: lib/a.js:1）`, false)
      assert.notEqual(wrote && wrote.ok, false, `大档写 ${target} 字要点应成功：${wrote && wrote.error}`)

      // 写**中档超条数、大档合法**的已定条数。
      const n = ENTRY_CAPS.decided + 2
      assert.ok(n <= bigCaps.decided, '构造的条数须在大档上限内')
      const lines = Array.from({ length: n }, (_, i) => `- 已定条目${i + 1}（源码: lib/a.js:${i + 1}）`).join('\n')
      updateModuleSection(dir, 'big', 'm1', 'decided', lines, false)

      const state = readState(dir, 'big', 'sess-big')
      assert.equal(state.size, SIZE_LARGE, '读回的档位应是大')
      const mod = state.modules[0]
      assert.equal((mod.entryIssues ?? []).length, 0,
        `大档的 ${target} 字要点不该被报超长——审查必须按档位量（当前报了 ${JSON.stringify(mod.entryIssues)}）`)

      const findings = auditOf(state)
      const overCap = findings.filter((f) => f.id.startsWith('over_cap'))
      const entryIssue = findings.filter((f) => f.id.startsWith('entry_issue'))
      assert.equal(overCap.length, 0,
        `大档的 ${n} 条已定不该被报超上限（当前报了 ${overCap.map((f) => f.fact).join('；')}）`)
      assert.equal(entryIssue.length, 0,
        `大档的条目不该被报超长（当前报了 ${entryIssue.map((f) => f.fact).join('；')}）`)

      // 反向：中档项目**已有**超长条目时必须被报出来——否则「大档不报」可能是因为
      // 审查根本没在量（把上限改成 Infinity 也能绿）。
      //
      // ⚠️ 不能用 `updateModuleSection` 造这条数据：写入侧会**直接拒绝**超长条目
      // （`条目 25 字，超过上限 20 字`），根本不落盘。超长条目只可能来自**旧文档**
      // （迁移不追溯），所以这里直接写文件——这正是审查存在的理由。
      const dir2 = mkdtempSync(join(tmpdir(), 'puzzle-size-audit2-'))
      try {
        createProject(dir2, 'mid', '目标', ['m1'], MODE_PUZZLE_WRITE, 'sess-mid')
        // 不调 setSize：缺省即中档。
        const modFile = join(dir2, 'mid', PUZZLE_DIR, '模块', 'm1.md')
        const text = readFileSync(modFile, 'utf8')
        const long = '要'.repeat(ENTRY_LIMITS.points + 5)
        assert.ok(text.includes('## 要点'), '模块文档应有「## 要点」小节可替换')
        writeFileSync(modFile, text.replace(/## 要点\n[\s\S]*?(?=\n## )/,
          `## 要点\n- ${long}（源码: lib/a.js:1）\n`))
        const midState = readState(dir2, 'mid', 'sess-mid')
        assert.equal(midState.size, SIZE_MEDIUM, '缺省档位应是中')
        const midIssues = midState.modules[0].entryIssues ?? []
        assert.ok(midIssues.some((issue) => issue.tooLong > 0),
          `中档项目里已有的超长要点**必须**被报出来（当前 entryIssues=${JSON.stringify(midIssues)}）`)
      } finally {
        rmSync(dir2, { recursive: true, force: true })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  console.log(`\n${passed} 项通过 / ${skipped.length} 项标记为已知上游漂移${failed.length ? ` / ${failed.length} 项失败:` : ''}`)
  for (const f of failed) console.log(`  - ${f.name} —— ${f.message}`)
  if (failed.length) process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true })
}
