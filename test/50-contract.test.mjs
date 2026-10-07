/**
 * dsh-puzzle-mode **文档格式契约测试**。
 *
 *   node test/50-contract.test.mjs
 *
 * ## 为什么要单独有它
 *
 * v0.19.8 之前，本仓的测试在文档格式 v4 → v6 的改造中**整片脱节**：
 * 断言停在旧格式（六节主文档、`related` 合体小节、项目级健康性、裸条目），
 * 而实现早就改了 —— 于是 `npm test` 长期三红一绿，红成了常态，谁都不再看它。
 * 结果 v0.19.7 的 tag 是在测试全红的状态下打出来的。
 *
 * 根因不是「测试写得不好」，而是**缺一条契约测试**：格式是插件的对外承诺，
 * 却没有任何一条断言在说「这个承诺长什么样」。改动实现时自然没人发现测试在说谎。
 *
 * 这个文件就是把**对外承诺**逐条钉住。它只测**契约**（形状 / 上限 / 必备字段），
 * 不测实现细节 —— 所以格式不变时它永远不该红，格式一变它**必须**红，
 * 逼着改的人同时更新这里与文档格式版本号。
 *
 * ## 判据来源
 *
 * 所有期望值都**引 `lib/constants.js` 的常量**，不在本文件里写死任何数字或文案。
 * 这样「常量改了」与「契约改了」是同一件事，不存在两处各写一份再漂移的可能。
 */
import assert from 'node:assert/strict'
// **必须最先**：隔离 DSH_HOME（契约测试会读提示段，而提示段随全局开关分两份）。
import './helpers/isolate-home.mjs'
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ASK_MAX_OPTIONS,
  ASK_MAX_QUESTIONS,
  BINDING_WARN_THRESHOLD,
  CURRENT_SESSION_FIELD,
  ENTRY_CAPS,
  ENTRY_LIMITS,
  HEALTH_DIMENSIONS,
  HEALTH_HEADING,
  MAIN_FILE,
  OLD_PREAMBLE_LINES,
  MAIN_ENTRY_SPEC,
  MODE_PUZZLE_ONLY,
  MODULE_DIR,
  MODULE_SECTION_HEADINGS,
  MODULE_SECTION_KEYS,
  PANEL_LIMITS,
  PAUSE_OPTIONS,
  PAUSE_QUESTION,
  isAskPauseEnabled,
  setAskPause,
  pauseFields,
  readSettings,
  settingsPath,
  disableSession,
  enableSession,
  PUZZLE_DIR,
  PUZZLE_VERSION,
  SECTION_HEADINGS,
  SECTION_ORDER,
  SESSION_FIELD,
  SIZE_CAPS,
  SIZE_ENTRY_LIMITS,
  SIZE_LARGE,
  SIZE_MEDIUM,
  SIZE_SMALL,
  normalizeSize,
  limitsFor,
  SOURCE_MARK,
  WORKFLOW_MAX_STEPS,
  WORKFLOW_STEP_LIMIT,
  writeWorkflow,
  addBinding,
  bindSession,
  boundProject,
  boundProjects,
  conflictDigest,
  parseCurrentSessionList,
  parseSessionList,
  setCurrentProject,
  unbindOne,
  writeSessionList,
  measureWithoutMethod,
  parseWorkflowBlocks,
  readWorkflow,
  workflowsTriggeredBy,
  createProject,
  docVersion,
  extraSectionsIn,
  parseFrontMatter,
  readState,
  updateMainSection,
  updateModuleSection,
} from '../lib/puzzle.js'
// 迁移函数不在 barrel 里（它是重建流程的内部步骤），契约测试直接引实现文件。
import { migrateMainDoc } from '../lib/migrate.js'

let passed = 0
const failed = []

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failed.push({ name, message: error.message })
    console.error(`FAIL ${name} —— ${error.message}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'puzzle-contract-'))

try {
  createProject(root, 'demo', ['mod-a'], '契约测试', MODE_PUZZLE_ONLY, 'session-contract')
  const projectDir = join(root, 'demo', PUZZLE_DIR)
  const mainPath = join(projectDir, MAIN_FILE)

  /* --------------------- 契约的锚：**故意写死**的那几个值 --------------------- */

  // 上面说过「期望值都引常量」，但**契约测试不能全靠常量**——
  // 常量与模板同源，改常量时两边一起动，测试照样绿，等于没守（实测漏过：
  // 把 SECTION_HEADINGS.pit 改成「## 踩过的坑」，本文件 15 条全绿）。
  //
  // 所以这里**故意把契约钉成字面量**。这正是「契约测试」与「单元测试」的分界：
  //   - 单元测试引常量 —— 改实现不必满仓找断言（PR 建议①）；
  //   - 契约测试钉字面量 —— 格式一变**必须**红，逼改的人同时动版本号与文档（建议②）。
  // 改文档格式时，这里就是那张「必须一起改」的清单。
  check('契约锚·主文档五节的**字面名字**（改格式必须动这里 + 升 PUZZLE_VERSION）', () => {
    assert.deepEqual(
      Object.values(SECTION_HEADINGS),
      ['## 模块索引', '## 源码索引', '## 工具索引', '## 坑', '## 工作流'],
      '主文档五节的名字是对外承诺；改动必须同时升 PUZZLE_VERSION 并写进迁移说明',
    )
    assert.deepEqual(SECTION_ORDER, ['index', 'source', 'tools', 'pit', 'workflow'])
  })

  check('契约锚·文档格式版本的字面值（升版本必须动这里）', () => {
    assert.equal(PUZZLE_VERSION, 7, 'PUZZLE_VERSION 变化必须同步本文件与 CHANGELOG 的迁移说明')
  })

  check('契约锚·多绑定字段名（v7：一个会话可绑多个项目）', () => {
    // 这两个字段名是**写进用户文档的**（front-matter 里就长这样），改名等于改格式。
    assert.equal(SESSION_FIELD, '会话')
    assert.equal(CURRENT_SESSION_FIELD, '当前会话')
    assert.ok(BINDING_WARN_THRESHOLD > 1, '提醒阈值要是个能真的超过的数')
  })

  check('契约·v7 不变量：当前会话 ⊆ 会话（写盘时收口）', () => {
    // 手工构造一份「当前会话里有、会话里没有」的 front-matter：写回时必须被裁掉。
    // 这条不变量是「当前项目」语义的根——破了就会出现「当前项目其实没绑这个会话」，
    // 表现是工具落在一个本会话根本没绑的项目上。
    const text = [
      '---',
      'puzzle: 7',
      '项目: inv',
      '模式: 只拼不写',
      '计划模块: []',
      `会话: ${JSON.stringify(['s1', 's2'])}`,
      `当前会话: ${JSON.stringify(['s2', 'ghost'])}`,
      '更新时间: 2026-01-01 00:00:00',
      '---',
      '',
      '# inv',
      '',
    ].join('\n')
    const file = join(root, 'inv-main.md')
    writeFileSync(file, text, 'utf8')
    const written = writeSessionList(file, text, ['s1', 's2'], ['s2', 'ghost'])
    assert.equal(written.ok, true)
    const after = readFileSync(file, 'utf8')
    const fields = parseFrontMatter(after).fields
    assert.deepEqual(parseSessionList(fields), ['s1', 's2'])
    assert.deepEqual(parseCurrentSessionList(fields), ['s2'], '当前会话必须是绑定的子集')
  })

  check('契约·v7 迁移：v6 老文档补「当前会话」且取绑定的第一个', () => {
    // v6 及更早「一个会话只绑一个项目」，所以唯一那个绑定就是当前——迁移补出来的值
    // 必须与原行为一致（这是「只改形状、不改语义」的判据）。
    const text = [
      '---',
      'puzzle: 6',
      '项目: old',
      '模式: 只拼不写',
      '计划模块: []',
      `会话: ${JSON.stringify(['s-old'])}`,
      '更新时间: 2026-01-01 00:00:00',
      '---',
      '',
      '# old',
      '',
    ].join('\n')
    const done = migrateMainDoc(text, 'old', [])
    const fields = parseFrontMatter(done.text).fields
    assert.equal(fields.puzzle, '7')
    assert.deepEqual(parseCurrentSessionList(fields), ['s-old'], 'v6 的唯一绑定必须成为当前项目')
  })

  check('契约·v7 迁移幂等：已补过「当前会话」的文档第二次 0 改动', () => {
    const text = [
      '---',
      'puzzle: 6',
      '项目: old',
      '模式: 只拼不写',
      '计划模块: []',
      `会话: ${JSON.stringify(['s-old'])}`,
      '更新时间: 2026-01-01 00:00:00',
      '---',
      '',
      '# old',
      '',
    ].join('\n')
    const once = migrateMainDoc(text, 'old', [])
    const twice = migrateMainDoc(once.text, 'old', [])
    assert.deepEqual(twice.changes, [], '第二次必须 0 改动，否则「迁移」按钮每次都说有改动')
  })

  check('契约·多绑定：一个会话可同时绑多个项目，当前项目排第一', () => {
    const many = join(root, 'many-root')
    mkdirSync(join(many, 'aaa', PUZZLE_DIR), { recursive: true })
    mkdirSync(join(many, 'bbb', PUZZLE_DIR), { recursive: true })
    createProject(many, 'aaa', '', [], '只拼不写', 's-multi')
    createProject(many, 'bbb', '', [], '只拼不写', 's-multi')
    // 两个项目都绑了这个会话：这正是 v6 做不到、v7 放开的事。
    assert.deepEqual(boundProjects(many, 's-multi').sort(), ['aaa', 'bbb'])
    // 新建的第二个是当前 → 排第一，且 boundProject（工具落点）也是它。
    assert.equal(boundProject(many, 's-multi'), 'bbb', '新建的项目应当成为当前项目')
    setCurrentProject(many, 'aaa', 's-multi')
    assert.equal(boundProject(many, 's-multi'), 'aaa', '切换当前之后工具落点必须跟着换')
    // 切换只动「当前」，不动绑定集合。
    assert.deepEqual(boundProjects(many, 's-multi').sort(), ['aaa', 'bbb'], '切当前不该解绑')
  })

  check('契约·多绑定：解绑一个不动另一个，且当前项目自动补位', () => {
    const many = join(root, 'unb-root')
    mkdirSync(join(many, 'aaa', PUZZLE_DIR), { recursive: true })
    mkdirSync(join(many, 'bbb', PUZZLE_DIR), { recursive: true })
    createProject(many, 'aaa', '', [], '只拼不写', 's-u')
    createProject(many, 'bbb', '', [], '只拼不写', 's-u')
    // 当前是 bbb（后建的）；把当前那个解掉，剩下的 aaa 必须自动成为当前。
    const one = unbindOne(many, 'bbb', 's-u')
    assert.equal(one.ok, true)
    assert.deepEqual(boundProjects(many, 's-u'), ['aaa'])
    assert.equal(one.current, 'aaa', '解绑当前项目后，剩下的绑定必须补位成当前')
    assert.equal(boundProject(many, 's-u'), 'aaa', '不留「绑定还在、当前却没了」的状态')
  })

  check('契约·op:bind 仍是「替换全部绑定」（追加只走面板的 ＋）', () => {
    const many = join(root, 'repl-root')
    mkdirSync(join(many, 'aaa', PUZZLE_DIR), { recursive: true })
    mkdirSync(join(many, 'bbb', PUZZLE_DIR), { recursive: true })
    createProject(many, 'aaa', '', [], '只拼不写', 's-r')
    createProject(many, 'bbb', '', [], '只拼不写', 's-r')
    assert.deepEqual(boundProjects(many, 's-r').sort(), ['aaa', 'bbb'])
    const bound = bindSession(many, 'aaa', 's-r')
    assert.equal(bound.ok, true)
    assert.deepEqual(bound.released, ['bbb'], 'op:bind 必须解绑别处')
    assert.deepEqual(boundProjects(many, 's-r'), ['aaa'])
    // 追加是另一条路：`addBinding` 只加不删。
    addBinding(many, 'bbb', 's-r')
    assert.deepEqual(boundProjects(many, 's-r').sort(), ['aaa', 'bbb'])
  })

  check('契约锚·模块文档小节名与顺序（字面）', () => {
    assert.deepEqual(
      Object.values(MODULE_SECTION_HEADINGS),
      ['## 健康性', '## 进度', '## 要点', '## 悬而未决', '## 已定', '## 可复用', '## 详细记录'],
    )
  })

  check('契约锚·条目必须带源码出处的标记字面值', () => {
    assert.equal(SOURCE_MARK, '（源码', '出处标记是查找方向的锚，改了就断链')
  })

  /* ---------------------------- 主文档：五节契约 ---------------------------- */

  check('契约·主文档恰好五节：少一节算违约，**多一节也算**', () => {
    const main = readFileSync(mainPath, 'utf8')
    const body = parseFrontMatter(main).body
    // 「缺节」与「多节」都要抓：
    //   只断言「期望的节都在」会漏掉「模板多插了一节」——实测漏过（插一节 ## 临时索引 照样通过）。
    const extra = extraSectionsIn(body, Object.values(SECTION_HEADINGS))
    assert.deepEqual(extra, [], `主文档不该有规范外小节（除五节外禁止写任何内容）：${extra.join(' / ')}`)
    for (const key of SECTION_ORDER) {
      assert.ok(body.includes(SECTION_HEADINGS[key]), `缺少小节「${SECTION_HEADINGS[key]}」`)
    }
  })

  check('契约·模块文档不得有规范外小节（MODULE_SECTION_HEADINGS 之外禁写）', () => {
    updateModuleSection(root, 'demo', 'mod-a', 'points', `- 要点${SOURCE_MARK}: lib/b.js:2）`, true)
    const moduleText = readFileSync(join(projectDir, MODULE_DIR, 'mod-a.md'), 'utf8')
    const body = parseFrontMatter(moduleText).body
    const extra = extraSectionsIn(body, Object.values(MODULE_SECTION_HEADINGS))
    assert.deepEqual(extra, [], `模块文档不该有规范外小节：${extra.join(' / ')}`)
  })

  check('契约·extraSectionsIn 确实能抓出多余小节（自检：别让守卫本身失灵）', () => {
    // 这条是**守卫的守卫**：如果 extraSectionsIn 哪天退化成恒返回 []，
    // 上面两条会变成永远通过的空断言。这里用一个手工构造的样本确认它真的会报。
    const sample = '# 标题\n\n## 模块索引\n- x\n\n## 临时索引\n- y\n'
    const extra = extraSectionsIn(sample, Object.values(SECTION_HEADINGS))
    assert.deepEqual(extra, ['## 临时索引'], 'extraSectionsIn 必须能报出规范外小节')
  })

  check('契约·主文档小节标题与 SECTION_HEADINGS 逐字一致（改文案即违约）', () => {
    const main = readFileSync(mainPath, 'utf8')
    for (const key of SECTION_ORDER) {
      assert.ok(main.includes(SECTION_HEADINGS[key]), `缺少小节标题「${SECTION_HEADINGS[key]}」（key=${key}）`)
    }
  })

  check('契约·主文档不得出现模块级小节（健康性 / 进度 / 要点 都不属于主文档）', () => {
    const main = readFileSync(mainPath, 'utf8')
    assert.ok(!main.includes(HEALTH_HEADING), `主文档不该有 ${HEALTH_HEADING}`)
    assert.ok(!main.includes('## 进度'), '主文档不该有 ## 进度')
    assert.ok(!main.includes('## 要点'), '主文档不该有 ## 要点')
  })

  check('契约·文档格式版本 = PUZZLE_VERSION，且新建文档就是当前版', () => {
    const main = readFileSync(mainPath, 'utf8')
    assert.equal(docVersion(main), PUZZLE_VERSION, `新建主文档的 puzzle: 必须是 ${PUZZLE_VERSION}`)
    const state = readState(root, 'demo')
    assert.equal(state.version, PUZZLE_VERSION)
    assert.equal(state.outdated, false, '新建项目不该被判定为旧格式')
  })

  /* --------------------------- 条目契约：出处必填 --------------------------- */

  check('契约·主文档条目缺（源码: …）出处 → 写入被拒', () => {
    const before = readFileSync(mainPath, 'utf8')
    const result = updateMainSection(root, 'demo', 'pit', '- 一条没有出处的坑', false)
    assert.equal(result.ok, false, '缺出处的条目必须被拒，不能静默落盘')
    assert.equal(readFileSync(mainPath, 'utf8'), before, '被拒时文档不能被改动')
  })

  check('契约·主文档条目带出处 → 落盘，且出处原文保留', () => {
    const result = updateMainSection(root, 'demo', 'pit', `- 一条合规的坑${SOURCE_MARK}: lib/a.js:1）`, true)
    assert.equal(result.ok, true, '带出处的条目必须能落盘')
    const main = readFileSync(mainPath, 'utf8')
    assert.ok(main.includes('lib/a.js:1'), '出处里的文件:行必须原样保留（否则回查断链）')
  })

  check('契约·条目超长 → 报错且不截断（ENTRY_LIMITS 是硬上限）', () => {
    const tooLong = '坑'.repeat(ENTRY_LIMITS.pit + 1) + `${SOURCE_MARK}: lib/a.js:1）`
    const result = updateMainSection(root, 'demo', 'pit', '- ' + tooLong, false)
    assert.equal(result.ok, false, `超过 ${ENTRY_LIMITS.pit} 字必须报错`)
  })

  /* --------------------------- 模块文档：小节契约 --------------------------- */

  check('契约·模块文档小节 = MODULE_SECTION_KEYS，且健康性标题引常量', () => {
    updateModuleSection(root, 'demo', 'mod-a', 'points', `- 要点${SOURCE_MARK}: lib/b.js:2）`, true)
    const moduleText = readFileSync(join(projectDir, MODULE_DIR, 'mod-a.md'), 'utf8')
    assert.ok(moduleText.includes(HEALTH_HEADING), `模块文档必须有 ${HEALTH_HEADING}`)
    for (const key of MODULE_SECTION_KEYS) {
      assert.ok(moduleText.includes('## '), `模块文档小节缺失（key=${key}）`)
    }
    assert.equal(MODULE_SECTION_KEYS.length, 7, '模块文档小节数变化时请同步改这里与文档格式版本')
  })

  check('契约·五维维度名与数量 = HEALTH_DIMENSIONS', () => {
    const moduleText = readFileSync(join(projectDir, MODULE_DIR, 'mod-a.md'), 'utf8')
    const health = moduleText.slice(moduleText.indexOf(HEALTH_HEADING))
    for (const dimension of HEALTH_DIMENSIONS) {
      assert.ok(health.includes(dimension.name), `健康性小节必须列出维度「${dimension.name}」`)
    }
    assert.equal(HEALTH_DIMENSIONS.length, 5, '维度数变化属于格式变更')
  })

  /* ----------------------------- 上限契约：硬规则 ----------------------------- */

  check('契约·条数上限 = ENTRY_CAPS，超了删最旧（悬而未决 / 已定）', () => {
    // 写 ENTRY_CAPS.pending + 2 条，只应留下最后 ENTRY_CAPS.pending 条。
    const items = []
    for (let i = 0; i < ENTRY_CAPS.pending + 2; i += 1) {
      items.push(`- 未决第${i}条${SOURCE_MARK}: lib/c.js:${i}）`)
    }
    // API 契约：content 是**一段 markdown 文本**，不是数组（数组会被 String() 拼成一行）。
    const result = updateModuleSection(root, 'demo', 'mod-a', 'pending', items.join('\n'), false)
    assert.equal(result.ok, true)
    const moduleText = readFileSync(join(projectDir, MODULE_DIR, 'mod-a.md'), 'utf8')
    const kept = (moduleText.match(/未决第/g) || []).length
    assert.equal(kept, ENTRY_CAPS.pending, `悬而未决最多留 ${ENTRY_CAPS.pending} 条（超了删最旧）`)
    assert.ok(!moduleText.includes('未决第0条'), '最旧的应被删掉（删最旧，不是删最新）')
  })

  check('契约·提问额度 = ASK_MAX_QUESTIONS / ASK_MAX_OPTIONS，且都在合理区间', () => {
    assert.ok(Number.isSafeInteger(ASK_MAX_QUESTIONS) && ASK_MAX_QUESTIONS > 0, '提问上限必须是正整数')
    assert.ok(Number.isSafeInteger(ASK_MAX_OPTIONS) && ASK_MAX_OPTIONS > 0, '选项上限必须是正整数')
    // 收尾问固定两项：它不受 ASK_MAX_OPTIONS 影响，是**独立**的硬契约。
    assert.equal(PAUSE_OPTIONS.length, 2, '固定收尾问必须恰好两个选项')
    assert.ok(ASK_MAX_OPTIONS >= PAUSE_OPTIONS.length, '选项上限不该小于收尾问的选项数')
  })

  check('契约·工作流每条 ≤ WORKFLOW_MAX_STEPS 步；超了报错不删步', () => {
    const steps = []
    for (let i = 0; i < WORKFLOW_MAX_STEPS + 1; i += 1) steps.push(`${i + 1}. 第${i}步`)
    const tooMany = '### 超步数流程\n' + steps.join('\n')
    const result = updateMainSection(root, 'demo', 'workflow', tooMany, false)
    assert.equal(result.ok, false, `超过 ${WORKFLOW_MAX_STEPS} 步必须报错（步骤是有序的路，不能静默删）`)
  })


  /* ---------------- v0.19.9 的三条约束：各自「故意违反」也要能红 ---------------- */

  // 用户原话：「你说你现在的自觉性还不强，有什么通用建议给拼图插件增强约束」。
  // 三条都遵循同一个原则：**别靠记住，靠撞见；撞见就红**。
  // 所以每条都配一个「故意违反」用例——守卫写完不算数，**能抓到才算数**
  // （实测踩过：契约测试最初 15 条全绿，却漏掉两种真实漂移）。

  check('① 工作流触发：`触发:` 被解析成声明，**不算步骤**', () => {
    const blocks = parseWorkflowBlocks('### 发版\n触发: package.json\n1. 改 version。\n2. 传附件。')
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].trigger, 'package.json', '触发声明必须被解析出来（不是第 1 步）')
    assert.equal(blocks[0].steps.length, 2, '触发声明不该算进步骤')
  })

  check('① 工作流触发：命中参数、且不误伤无关文件', () => {
    const blocks = parseWorkflowBlocks('### 发版\n触发: package.json\n1. 改 version。')
    assert.equal(workflowsTriggeredBy(blocks, 'write', { file_path: '/x/package.json' }).length, 1)
    assert.equal(workflowsTriggeredBy(blocks, 'write', { file_path: '/x/other.js' }).length, 0, '无关文件不该触发')
    assert.equal(workflowsTriggeredBy(blocks, 'write', { file_path: '/x/a.js' }).length, 0)
  })

  check('① 触发声明必须**写回**文档（丢了机制就是死的）', () => {
    // 实测踩过：renderWorkflowBlock 最初没写回 `触发:`，
    // 于是它变成第 1 步、下次解析不出触发——功能看着实现了，实际永不触发。
    const written = updateMainSection(root, 'demo', 'workflow', '### 发版\n触发: package.json\n1. 改 version。', false)
    assert.equal(written.ok, true)
    const main = readFileSync(mainPath, 'utf8')
    const back = readWorkflow(parseFrontMatter(main).body)
    assert.equal(back[0].trigger, 'package.json', '写回后必须仍解析出触发声明')
    assert.equal(back[0].steps.length, 1, '写回后步骤数不变')
  })

  check('② 数字须带测法：无测法 → 警告；有测法 / 规格计数 → 不警告', () => {
    assert.ok(measureWithoutMethod('热路径 127ms') !== null, '报了 ms 却没测法 → 必须警告')
    assert.ok(measureWithoutMethod('热路径 127ms，实测中位数 / 20 次') === null, '有测法 → 不该警告')
    assert.equal(measureWithoutMethod('悬而未决最多 4 条'), null, '规格计数不是度量，不该警告')
    assert.equal(measureWithoutMethod('主文档五节'), null, '无度量单位，不该警告')
  })

  check('② 数字没测法**只警告不拒绝**（拦下来会逼模型删掉证据）', () => {
    const result = updateModuleSection(root, 'demo', 'mod-a', 'points', '- 热路径 127ms（源码: lib/a.js:1）', true)
    assert.equal(result.ok, true, '必须放行——这是语义判断，启发式会有假阳性')
    const moduleText = readFileSync(join(projectDir, MODULE_DIR, 'mod-a.md'), 'utf8')
    assert.ok(moduleText.includes('127ms'), '数字不能被悄悄丢掉')
  })

  check('③ 写「已定」**经真实写入路径**回显现有条目（接线断了也要红）', () => {
    // 这条必须走 `updateModuleSection`，不能只测 `conflictDigest` 本身——
    // 实测踩过：只测纯函数时，把 `updateModuleSection` 里的接线关掉，
    // 契约测试**照样全绿**（26 项通过），等于没守。
    updateModuleSection(root, 'demo', 'mod-a', 'decided', '- 旧决定甲（源码: lib/a.js:1）', false)
    const written = updateModuleSection(root, 'demo', 'mod-a', 'decided', '- 新决定乙（源码: lib/a.js:2）', true)
    assert.equal(written.ok, true)
    const digest = written.conflicts
    assert.ok(digest !== null && digest !== undefined, '真实写入路径必须把 conflicts 带回来')
    assert.deepEqual(digest.existing, ['旧决定甲'], '要回显该小节**写入前**的旧条目')
    assert.ok(digest.hint.includes('append:false'), '要明确告诉模型「别只追加」')
  })

  check('③ 纯函数行为：零误报、不做语义判断（字面算法拿不到可用阈值）', () => {
    // 实测：真冲突「不写测试不跑测试」vs「本项目测试要跑要维护」只共享「测试」，
    // 2-gram 重叠仅 1 分 —— 阈值 2 会漏，降到 1 会误报。所以**不判**，只回显。
    const digest = conflictDigest('decided', ['毫不相干的决定'], ['另一件毫不相干的事'], ENTRY_CAPS.decided)
    assert.deepEqual(digest.existing, ['毫不相干的决定'], '不管像不像，旧条目都原样给出（由模型判）')
    assert.equal(conflictDigest('decided', [], ['x'], ENTRY_CAPS.decided), null, '没有旧条目就不打扰')
  })

  check('③ 回显是**零误报**的：不做语义判断（字面算法拿不到可用阈值）', () => {
    // 实测：真冲突「不写测试不跑测试」vs「本项目测试要跑要维护」只共享「测试」，
    // 2-gram 重叠仅 1 分 —— 阈值 2 会漏，降到 1 会误报。所以**不判**，只回显。
    const digest = conflictDigest('decided', ['毫不相干的决定'], ['另一件毫不相干的事'], ENTRY_CAPS.decided)
    assert.deepEqual(digest.existing, ['毫不相干的决定'], '不管像不像，旧条目都原样给出（由模型判）')
    assert.equal(conflictDigest('decided', [], ['x'], ENTRY_CAPS.decided), null, '没有旧条目就不打扰')
  })

  check('契约·`## 工作流` 不套条目的尺子（步骤合法上限是 80，不是 50）', () => {
    // 实测 bug（v0.20.1 修）：`MAIN_ENTRY_SPEC` 把 `## 工作流` 也当条目小节，
    // 用 `ENTRY_LIMITS.workflow = 50` 量每一行；而步骤合法上限是 `WORKFLOW_STEP_LIMIT = 80`。
    // 于是 51–80 字的**完全合法**的步骤被报「超长」——本项目自己的文档长期挂着 7 条假发现。
    assert.equal(MAIN_ENTRY_SPEC.workflow, undefined, '工作流不是条目小节，不该出现在条目规格里')
    assert.ok(WORKFLOW_STEP_LIMIT > ENTRY_LIMITS.workflow, '步骤上限本来就比条目上限宽，这正是误报的来源')
    // 端到端：写一条 60 字的步骤（≤80 合法）落盘，审查不该报它超长。
    const root80 = join(root, 'wf80')
    createProject(root80, 'wf80', '', [], '只拼不写')
    // 造一个**正好落在 51–80 字**的步骤：这是合法区间，也正是旧代码误报的区间。
    const long = '这一步刻意写到六十个字上下用来验证步骤上限比条目上限宽的事实'.padEnd(60, '啊')
    assert.ok(long.length > ENTRY_LIMITS.workflow && long.length <= WORKFLOW_STEP_LIMIT,
      `样本要落在 ${ENTRY_LIMITS.workflow}–${WORKFLOW_STEP_LIMIT} 之间，实际 ${long.length}`)
    const file = join(root80, 'wf80', PUZZLE_DIR, MAIN_FILE)
    const text = readFileSync(file, 'utf8')
    const written = writeWorkflow(text, [{ name: '长步骤流程', steps: [long] }])
    writeFileSync(file, written, 'utf8')
    const state = readState(root80, 'wf80')
    const issues = (state.mainEntryIssues ?? []).filter((item) => item.key === 'workflow')
    assert.deepEqual(issues, [], '60 字的步骤是合法的，审查不该报它超长')
  })

  check('契约·迁移必须认得出**每一版**的旧说明行（漏一条那一版就永远修不好）', () => {
    // 真 bug（本项目自己的文档中招）：v3 时代的说明行是「只有四节：…」，
    // 而 `OLD_PREAMBLE_LINES` 里只列了「只有五节：…」。于是那份文档停在
    // 「只有四节」、正文却早就是五节，跑多少次迁移都修不掉——文件头与正文自相矛盾。
    // 判据是「整行完全一致才替换」，所以旧写法必须逐条列全。
    const fourSections = '> 只有四节：模块索引 / 源码索引 / 工具索引 / 坑。决策与轮汇报在 `模块/` 下。'
    assert.ok(OLD_PREAMBLE_LINES.has(fourSections), 'v3 的四节说明必须在旧说明表里，否则老文档永远修不好')
    const text = [
      '---',
      'puzzle: 3',
      '项目: old',
      '模式: 只拼不写',
      '计划模块: []',
      '更新时间: 2026-01-01 00:00:00',
      '---',
      '',
      '# old',
      '',
      fourSections,
      '> 每条一句话 + 出处（源码: 文件:行）；查找方向固定为 主文档 → 源码。',
      '> 项目健康性由模块文档的五维分数汇总得出，不在本文件手写总分。',
      '',
      '## 模块索引',
      '- （尚未拆分模块）',
      '',
    ].join('\n')
    const done = migrateMainDoc(text, 'old', [])
    assert.ok(!done.text.includes('只有四节'), '迁移后不该还留着「只有四节」这句与正文矛盾的自述')
    assert.ok(done.text.includes('只有五节'), '迁移后应换成当前版的说明行')
    // 幂等：迁移过的文档再跑一次不该再报「更新说明」。
    const twice = migrateMainDoc(done.text, 'old', [])
    assert.ok(!twice.changes.some((c) => c.includes('说明')), '第二次不该再改说明行')
  })

  /**
   * v0.21.0：迁移**不许**给「v7 的、只是不是当前」的项目补 `当前会话:`。
   *
   * 真实 bug（做「迁移作用于全部绑定」时暴露）：判据原本是「有 会话: 但没有 当前会话:」，
   * 而这个判据**只看单个项目**——可「当前是哪个」是**工作区级**事实：
   * 一个会话绑三个项目时，只有当前那一个该带 `当前会话:`，另外两个**本来就不带**。
   * 于是全局迁移给三个都补上，三个同时自称当前。后果不是显示错乱，而是
   * **解绑当前项目时静默把当前身份送给一个从没被选过的项目**（实测：解绑 beta 后 gamma 当上当前）。
   *
   * 判据必须带版本：只有 `docVersion < CURRENT_SESSION_VERSION` 才补。
   */
  check('契约·迁移不给「v7 且非当前」的项目补 当前会话:', () => {
    const v7 = [
      '---', 'puzzle: 7', '项目: side', '模式: 写后再拼', '计划模块: []',
      '会话: ["s1"]', '---', '', '> 目标：x', '',
      '## 模块索引', '- （尚未拆分模块）', '',
      '## 源码索引', '', '## 工具索引', '', '## 坑', '', '## 工作流', '',
    ].join('\n')
    const r = migrateMainDoc(v7, 'side', [])
    assert.ok(!r.text.includes(CURRENT_SESSION_FIELD),
      'v7 文档没写 当前会话: 是**合法状态**（绑着但不是当前），迁移不该替它选')
    assert.ok(!r.changes.some((c) => c.includes('当前会话')),
      '不该报「补 当前会话:」——那会让全局迁移把每个绑定项目都变成当前')
  })

  /**
   * 反向：真正的 v6 老文档**必须**还能被补上（修 bug 不能把功能一起修掉）。
   */
  check('契约·迁移仍给真正的 v6 文档补 当前会话:（且幂等）', () => {
    const v6 = [
      '---', 'puzzle: 6', '项目: old', '模式: 写后再拼', '计划模块: []',
      '会话: ["s1"]', '---', '', '> 目标：x', '',
      '## 模块索引', '- （尚未拆分模块）', '',
      '## 源码索引', '', '## 工具索引', '', '## 坑', '',
    ].join('\n')
    const once = migrateMainDoc(v6, 'old', [])
    assert.ok(once.text.includes(CURRENT_SESSION_FIELD), 'v6 唯一那个绑定就是当前，必须补出来')
    const twice = migrateMainDoc(once.text, 'old', [])
    assert.ok(!twice.changes.some((c) => c.includes('当前会话')), '补过一次后要幂等')
  })

  check('契约·固定收尾问文案与两个选项都在（引 PAUSE_QUESTION / PAUSE_OPTIONS）', () => {
    assert.equal(typeof PAUSE_QUESTION, 'string')
    assert.ok(PAUSE_QUESTION.length > 0)
    for (const option of PAUSE_OPTIONS) assert.ok(typeof option === 'string' && option.length > 0)
  })

  /**
   * v0.26.0：固定收尾问有了**全局关闭**开关（用户原话：「提问到最后还要选继续还是停下？
   * 的功能加一个全局关闭功能」）。
   *
   * 这条契约钉的是**默认值语义**：缺字段必须是「开」。
   * 反过来（缺=关）会让所有老用户的提问静默变了行为——比功能本身严重得多。
   * 同时钉住「关掉后不再下发文案」：留着 `pauseQuestion` 比不带更糟，
   * 模型看到文案就会继续问，于是「关掉了」变成一句空话。
   */
  check('契约·固定收尾问的全局开关：默认开，且关掉后不再下发文案', () => {
    const prev = process.env.DSH_HOME
    const home = mkdtempSync(join(tmpdir(), 'puzzle-contract-pause-'))
    process.env.DSH_HOME = home
    try {
      // 没有设置文件 = 开（默认行为不变）。
      assert.equal(isAskPauseEnabled(), true, '缺设置文件时必须是「开」')
      const on = pauseFields()
      assert.equal(on.askPause, true)
      assert.equal(on.pauseQuestion, PAUSE_QUESTION)
      assert.deepEqual(on.pauseOptions, PAUSE_OPTIONS)

      // 显式关掉之后：false + **不带**文案与选项。
      setAskPause(false)
      assert.equal(isAskPauseEnabled(), false)
      const off = pauseFields()
      assert.equal(off.askPause, false)
      assert.equal(Object.hasOwn(off, 'pauseQuestion'), false, '关掉后不该再下发收尾问文案')
      assert.equal(Object.hasOwn(off, 'pauseOptions'), false, '关掉后不该再下发收尾问选项')

      // 缺字段（老用户的设置文件）仍然算「开」。
      writeFileSync(settingsPath(), JSON.stringify({ disabledSessions: [] }))
      assert.equal(isAskPauseEnabled(), true, '缺 askPause 字段必须当「开」')
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      rmSync(home, { recursive: true, force: true })
    }
  })

  /**
   * 两个开关共用一个设置文件（`disabledSessions` + `askPause`），
   * 任何一侧写入时漏带另一侧就会把对方抹掉——本仓记过的「同名不同形的字段会互相盖掉」。
   */
  check('契约·收尾问开关与按会话禁用互不覆盖', () => {
    const prev = process.env.DSH_HOME
    const home = mkdtempSync(join(tmpdir(), 'puzzle-contract-pause2-'))
    process.env.DSH_HOME = home
    try {
      disableSession('sess-x')
      disableSession('sess-y')
      setAskPause(false)
      let after = readSettings()
      assert.equal(after.askPause, false)
      assert.deepEqual(after.disabledSessions, ['sess-x', 'sess-y'], '写 askPause 不能抹掉禁用名单')

      enableSession('sess-x')
      after = readSettings()
      assert.equal(after.askPause, false, '写禁用名单不能重置 askPause')
      assert.deepEqual(after.disabledSessions, ['sess-y'])
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      rmSync(home, { recursive: true, force: true })
    }
  })

  /**
   * v0.20.5：面板提示词模板里的数字**必须**由宿主下发，不许在客户端再抄一份。
   *
   * 这是本项目反复踩的那类坑（「改一处即可」被违反）：模板原先各抄一遍数字，
   * 改宿主上限时模板不跟随，于是**提示词把过期数字交给模型，模型照写，写入被拒**。
   * 断言直接扫 `lib/client.js` 的源码文本——模板是运行时拼的字符串，
   * 从外部拿不到「它有没有写死数字」这个事实。
   */
  check('契约·client 模板不得写死上限数字（一律走 limitsOf 下发）', () => {
    const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    const from = src.indexOf('function refactorTemplate')
    const to = src.indexOf('共享 store')
    assert.ok(from > 0 && to > from, '找不到模板区——文件结构变了，请同步这条断言')
    const region = src.slice(from, to)
    const offenders = []
    for (const m of region.matchAll(/≤\s*\d+\s*字|最多\s*\d+\s*[步条问]|(?:坑|要点|详细记录)[^']{0,4}\d+\s*字/g)) offenders.push(m[0])
    assert.deepEqual(offenders, [], '模板区写死了上限数字，改 constants.js 时它不会跟随：' + offenders.join(' / '))
  })

  /**
   * v0.20.5：`FALLBACK_LIMITS`（首次数据到达前的兜底）必须与宿主 `PANEL_LIMITS` 相等。
   *
   * 两者漂移的后果是「面板刚打开时给出过期上限」——一样会骗到模型。
   */
  check('契约·client 的 FALLBACK_LIMITS 与宿主 PANEL_LIMITS 逐字段相等', () => {
    const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    const at = src.indexOf('var FALLBACK_LIMITS = ')
    assert.ok(at > 0, '找不到 FALLBACK_LIMITS')
    const start = src.indexOf('{', at)
    let depth = 0
    let end = start
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    const fallback = new Function('return ' + src.slice(start, end + 1))()
    assert.deepEqual(fallback, PANEL_LIMITS, 'FALLBACK_LIMITS 与 PANEL_LIMITS 不一致')
  })

  /**
   * v0.20.5：提示段里**不许同时出现** v6 与 v7 两种绑定口径。
   *
   * 实际踩到过：`### 项目` 开头写着「一个会话只绑一个项目」，同一份提示段末尾的
   * `### 会话与多绑定（v7）` 又写着「可以同时绑多个项目」——模型读到两条**相反**的规则，
   * 而提示段是它每轮都看的东西。这条断言把「两说并存」变成一次可见的红。
   */
  check('契约·提示段不得同时出现「只绑一个项目」与「同时绑多个项目」', () => {
    const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
    const at = src.indexOf('const POLICY_BODY = [')
    const end = src.indexOf('会话与项目定位', at)
    assert.ok(at > 0 && end > at, '找不到 POLICY_BODY 区段——文件结构变了，请同步这条断言')
    const policy = src.slice(at, end)
    const one = policy.includes('一个会话只绑一个项目')
    const many = policy.includes('一个会话可以同时绑多个项目')
    assert.ok(!(one && many), '提示段同时给了两种绑定口径——模型会读到两条相反规则')
    assert.ok(many, 'v7 起提示段必须写明「可以同时绑多个项目」')
  })

  /**
   * v0.20.5：面板文案不许再说「单绑定不显示切换条」。
   *
   * 实际踩到过：面板写着单绑定「切换条不显示」，而 `bindingSwitcher` 的注释与实现
   * 都明确「不做这个退化」（用户当场抓到过一次）。用户可见的假话优先级最高。
   */
  check('契约·面板不得声称单绑定不显示切换条（实际会画）', () => {
    const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    assert.ok(!src.includes('切换条不显示'), '面板文案与实现矛盾：单绑定其实会画胶囊')
    assert.ok(!src.includes('不显示切换条'), '面板文案与实现矛盾：单绑定其实会画胶囊')
  })

  /**
   * v0.20.5：工具描述里**不许**拿 `ENTRY_LIMITS.workflow` 当工作流的尺子。
   *
   * 这是同一个「两把尺子」bug 的**第三处**：v0.20.2 修了审查侧
   * （`MAIN_ENTRY_SPEC` 拿 50 量 80 的步骤），v0.20.5 修了面板提示词侧，
   * 而 `op:main` 的 `content` 参数描述里**还写着「工作流 50 字」**——
   * 模型照它把合法步骤砍到 50 以内，写入侧（`normalizeWorkflowEntries`）
   * 明明收得下 80。`ENTRY_LIMITS.workflow` 只是个**占位值**，任何地方都不该拿它当上限。
   */
  check('契约·工具描述不得拿 ENTRY_LIMITS.workflow 当工作流的尺子', () => {
    const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
    assert.ok(!src.includes('工作流 ${ENTRY_LIMITS.workflow} 字'),
      'op:main 的 content 描述又把 ENTRY_LIMITS.workflow 当成工作流上限了')
    // 正向：工具描述里必须给出工作流**真正**的那把尺子。
    assert.ok(src.includes('WORKFLOW_STEP_LIMIT') && src.includes('WORKFLOW_NAME_LIMIT'),
      '工具描述必须写出工作流的真实尺子（名字 / 步骤），否则模型只能猜')
    assert.ok(src.includes('不要求出处'), '工具描述必须说明工作流不要求（源码: …）')
  })

  /**
   * 跨插件共存契约（与 dsh-infinite-gen-5 同装）——**钉字面量**。
   *
   * 为什么这几条必须钉字面量而不是引常量：它们约束的是**与外部插件的协商结果**，
   * 数字一改，对方那份 `data/arbitration.mjs` 就对不上。引常量的话本仓自己改了就绿，
   * 正是契约测试要拦的那种「单方面改动」。
   *
   * 三条各自的由来：
   *   ① 段序必须可覆盖 —— 否则与对方的末位锚点冲突时只能改源码；
   *   ② 默认值不得落在 DSH 内置段序表上 —— 同号时段序相同时**按段名比较**，
   *      位置就不再由协商决定（10100 撞过 WEB_SURFACE）；
   *   ③ 六条分工条款必须在场 —— 缺一条，那类冲突就回到「两边各说一套」。
   */
  check('契约·跨插件共存：段序可覆盖且默认值不撞 DSH 内置段序', () => {
    const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
    assert.ok(src.includes('PUZZLE_SECTION_ORDER'), '段序必须能被 PUZZLE_SECTION_ORDER 覆盖')
    assert.ok(src.includes('export const SECTION_ORDER_VALUE'), '必须导出段序常量供外部核对')

    const decl = JSON.parse(readFileSync(new URL('../compat.json', import.meta.url), 'utf8'))
    assert.equal(decl.contract, 'ig5-puzzle-coexist/1', '契约名变了就要同步对方侧')
    assert.ok(src.includes(`const DEFAULT_SECTION_ORDER = ${decl.puzzleDefaultOrder}`),
      `lib 默认段序必须与 compat.json 声明一致（${decl.puzzleDefaultOrder}）`)
    assert.ok(decl.puzzleDefaultOrder < decl.ig5TailOrder,
      `段序关系必须成立：本插件 ${decl.puzzleDefaultOrder} < 无限五代末位锚点 ${decl.ig5TailOrder}`)

    // DSH 内置段序表（@deepseek-ai/dsh-system-prompt 的 SECTION_ORDERS）——撞号即协商失效。
    const BUILTIN = [-1000, 0, 500, 600, 800, 900, 1000, 1010, 1100, 1200, 1300, 1400, 1500,
      1600, 1700, 2000, 2100, 2200, 2300, 2400, 2600, 2700, 2800, 2900, 3000, 3100,
      5000, 9000, 9900, 10000, 10100, 10200]
    assert.ok(!BUILTIN.includes(decl.puzzleDefaultOrder),
      `默认段序 ${decl.puzzleDefaultOrder} 撞上 DSH 内置段序：同号时按段名比较，位置不再由协商决定`)
  })

  check('契约·跨插件共存：六条分工条款都在政策文本里', () => {
    const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
    const decl = JSON.parse(readFileSync(new URL('../compat.json', import.meta.url), 'utf8'))
    const probes = decl.textProbes || {}
    const want = ['domain', 'ask-quota', 'batch-first', 'tool-shape', 'stop-semantics', 'tail-concede']
    assert.deepEqual(Object.keys(probes).sort(), [...want].sort(),
      '文本互校表必须覆盖六条分工规则（增删都要同步对方侧）')
    const miss = want.filter((k) => !src.includes(probes[k].puzzle))
    assert.equal(miss.length, 0, '政策文本缺条款：' + miss.join(' / '))
  })

  /**
   * 项目规模档位（小 / 中 / 大）——**中档必须等于升级前的值**。
   *
   * 为什么钉这一条：`中` 是默认档（存量文档不写 `规模:` 就是这个档）。
   * 若哪天有人调 `SIZE_CAPS['中']` 去「顺手改一下」，所有没写过规模的老项目
   * 会在下一次写入时**静默删掉超出的条目**。这条断言把那种改动变成一次可见的红。
   */
  check('契约·规模档位：中档 = 升级前的上限（存量文档不受影响）', () => {
    assert.deepEqual(SIZE_CAPS[SIZE_MEDIUM], { ...ENTRY_CAPS, pit: null },
      '中档必须等于 ENTRY_CAPS 原值（另加 pit: null）——否则存量文档的条目会被静默删掉')
    assert.deepEqual(SIZE_ENTRY_LIMITS[SIZE_MEDIUM], ENTRY_LIMITS,
      '中档字数上限必须等于 ENTRY_LIMITS 原值')
    // 三档必须都认得出，且 normalizeSize 的别名不能漏。
    for (const name of [SIZE_SMALL, SIZE_MEDIUM, SIZE_LARGE]) {
      assert.ok(normalizeSize(name) === name, `认不出档位「${name}」`)
      assert.ok(SIZE_CAPS[name] !== undefined, `缺 ${name} 档的条数上限`)
      assert.ok(SIZE_ENTRY_LIMITS[name] !== undefined, `缺 ${name} 档的字数上限`)
    }
    assert.equal(normalizeSize('l'), SIZE_LARGE, '别名 l 要认')
    assert.equal(normalizeSize('medium'), SIZE_MEDIUM, '别名 medium 要认')
    assert.equal(normalizeSize('xx'), null, '认不出的档位必须回 null（由调用方回落默认）')
  })

  check('契约·规模档位：大档确实放宽、小档确实收紧', () => {
    assert.ok(SIZE_CAPS[SIZE_LARGE].decided > SIZE_CAPS[SIZE_MEDIUM].decided, '大档已定上限要更高')
    assert.ok(SIZE_CAPS[SIZE_LARGE].pending > SIZE_CAPS[SIZE_MEDIUM].pending, '大档悬而未决上限要更高')
    assert.ok(SIZE_ENTRY_LIMITS[SIZE_LARGE].points > SIZE_ENTRY_LIMITS[SIZE_MEDIUM].points, '大档要点字数要放宽')
    assert.ok(SIZE_CAPS[SIZE_SMALL].pit !== null && SIZE_CAPS[SIZE_SMALL].pit > 0, '小档坑要有条数上限')
    assert.ok(SIZE_CAPS[SIZE_SMALL].decided < SIZE_CAPS[SIZE_MEDIUM].decided, '小档已定上限要更紧')
  })

  /**
   * 提示段**不许写死条目上限**——上限随项目规模变，写死就会把错的数字交给模型。
   *
   * 这条是「缓存检查」查出来的真问题：提示段是模块级常量（为了缓存稳定，这是对的），
   * 但它原先用 `ENTRY_CAPS.pending`（中档固定值）告诉模型「悬而未决 ≤4 条」——
   * 而大档实际能写 12 条。模型照提示段写就少写；照写入侧写又「违反」了提示段。
   * 修法：提示段只说「按规模，看返回里的 limits」，**真实值由 receipt 下发**。
   * 于是两边各有一条断言钉住：提示段不写死、receipt 给的是当前档的真值。
   */
  check('契约·提示段不得写死条目上限（真实值走 receipt 下发）', () => {
    const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
    const at = src.indexOf('const POLICY_BODY = [')
    const end = src.indexOf('会话与项目定位', at)
    assert.ok(at > 0 && end > at, '找不到 POLICY_BODY 区段——文件结构变了，请同步这条断言')
    const policy = src.slice(at, end)
    assert.ok(policy.includes('随项目规模'), '提示段必须说明上限随项目规模变化')
    assert.ok(policy.includes('limits'), '提示段必须指向 limits 拿真实上限')
    assert.ok(!policy.includes('ENTRY_CAPS.pending'), '提示段又把中档固定值当上限讲了')
    assert.ok(!policy.includes('ENTRY_CAPS.decided'), '提示段又把中档固定值当上限讲了')
    assert.ok(!policy.includes('ENTRY_CAPS.workflow'), '提示段又把中档固定值当上限讲了')
  })

  check('契约·receipt 下发的 limits 是**当前档**的真实上限', () => {
    assert.deepEqual(limitsFor(SIZE_SMALL).entryCaps, SIZE_CAPS[SIZE_SMALL], '小档 limits 要是小档的值')
    assert.deepEqual(limitsFor(SIZE_LARGE).entryCaps, SIZE_CAPS[SIZE_LARGE], '大档 limits 要是大档的值')
    assert.equal(limitsFor(SIZE_LARGE).size, SIZE_LARGE, 'limits 里要带上是哪一档')
    assert.deepEqual(limitsFor('乱写').entryCaps, SIZE_CAPS[SIZE_MEDIUM], '认不出的档位要回落到中档')
    assert.deepEqual(limitsFor(SIZE_MEDIUM).entryCaps, { ...ENTRY_CAPS, pit: null }, '中档必须与写入侧一致')
  })

  console.log(`\n${passed} 项通过${failed.length ? ` / ${failed.length} 项失败:` : ''}`)
  for (const f of failed) console.log(`  - ${f.name} —— ${f.message}`)
  if (failed.length) process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true })
}
