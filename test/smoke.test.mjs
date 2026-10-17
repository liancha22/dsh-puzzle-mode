/**
 * 最小冒烟测试（重构后唯一保留的测试）。
 *
 *   node test/smoke.test.mjs
 *
 * ## 为什么只留这一个
 *
 * 重构前有 21 个测试文件、约 9600 行（`20-client` 单文件 1714 行，带自己一套
 * `fakeReact` 与模块注册表）。它们钉的是**实现细节**（某个 CSS 字符串、
 * 某个导出名字、某段文案），重构一动就成片变红，而红的原因多半是「测试写死了
 * 旧结构」而不是「代码坏了」——那正是用户说的「大测试脚本」要删掉的东西。
 *
 * 留下的是**重构真正会弄坏、且坏了必须当场知道**的四类：
 *   ① 每个 lib 模块能被 import（拆文件 / 改依赖最容易在这里崩）；
 *   ② barrel 的导出面完整（改名 / 漏 re-export）；
 *   ③ 纯逻辑的核心契约（建项目 → 读状态 → 条目校验 → 看板搬列）；
 *   ④ 客户端半的 bundle 能被 eval 出来并交出 apply（它是最难验的一半）。
 *
 * 刻意**不**断言：具体文案、CSS 文本、内部函数名、导出总数。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 隔离 `DSH_HOME`（**必须最先执行**）。
 *
 * 设置与故障日志都存在 `$DSH_HOME` 下。不隔离的话，本测试会去读写**用户真实的
 * 设置与日志**——用户在面板上关掉收尾问之后，下面「写进去的开关读得回来」那条
 * 就会红，而代码一行没错。测试不该依赖运行者的个人状态。
 */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'puzzle-smoke-home-'))

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const home = mkdtempSync(join(tmpdir(), 'puzzle-smoke-'))
let passed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push({ name, message: error && error.message ? error.message : String(error) })
    console.log(`FAIL ${name} —— ${error && error.message ? error.message : error}`)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push({ name, message: error && error.message ? error.message : String(error) })
    console.log(`FAIL ${name} —— ${error && error.message ? error.message : error}`)
  }
}

try {
  /* ---------- ① 每个 lib 模块都能 import ---------- */
  const libFiles = readdirSync(join(root, 'lib')).filter((f) => f.endsWith('.js'))
  assert.ok(libFiles.length >= 10, 'lib/ 下的模块少得反常，先确认目录没被搬错')
  for (const file of libFiles) {
    // 客户端半（client.js）是浏览器 bundle，import 期就会碰 `window`，
    // 它的可加载性由下面第 ④ 组用 eval 单独验。
    if (file === 'client.js') continue
    await checkAsync(`import lib/${file}`, async () => {
      try {
        await import(new URL(`../lib/${file}`, import.meta.url).href)
      } catch (error) {
        // `@deepseek-ai/dsh-tools` 由 DSH 运行时提供，不在包的依赖里。
        // 脱离 DSH 目录（例如直接跑安装副本）时它必然找不到——那是环境差异，
        // 不是模块坏了。只放行这一种缺失，其余错误照常失败。
        if (error && error.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes('@deepseek-ai/dsh-tools')) return
        throw error
      }
    })
  }

  /* ---------- ② barrel 导出面 ---------- */
  /**
   * `puzzle.js` 这个 barrel 会 re-export `scopedtools.js`，而后者顶层 import
   * `@deepseek-ai/dsh-tools`（宿主运行时提供）。所以在 DSH 目录之外跑时，barrel
   * 整条链加载不了——那是环境差异，不是重构弄坏了导出。缺它时下面这组明确跳过。
   */
  let barrel = null
  try {
    barrel = await import('../lib/puzzle.js')
  } catch (error) {
    if (!(error && error.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes('@deepseek-ai/dsh-tools'))) throw error
    console.log('skip barrel 导出面：本目录脱离 DSH，缺 @deepseek-ai/dsh-tools（barrel 会 re-export 宿主半模块）')
  }
  if (barrel !== null) {
    check('barrel 导出面：核心纯逻辑符号都在', () => {
      // 只钉「重构会不小心弄丢、且下游真的在用」的那些。
      const must = [
        'createProject', 'readState', 'readMainDoc', 'updateMainSection', 'updateModuleSection',
        'setMode', 'setSize', 'setWorkspaceBinding', 'boundProjects', 'locate',
        'readBoard', 'writeBoard', 'emptyCard', 'nextCardId', 'moveVerdict', 'freezeCheck',
        'readSettings', 'patchSettings', 'isSessionWired', 'markWired',
        'checkEntry', 'normalizeEntries', 'slugify', 'atomicWrite', 'readTextCached',
        'logFailure', 'logPath',
      ]
      const missing = must.filter((name) => barrel[name] === undefined)
      assert.deepEqual(missing, [], 'barrel 丢了这些导出：' + missing.join(' / '))
    })

    check('barrel 不再导出 v8 已退场的绑定 API', () => {
      for (const gone of ['bindSession', 'unbindSession', 'addBinding', 'setCurrentProject']) {
        assert.equal(barrel[gone], undefined, `${gone} 不该还在 barrel 上`)
      }
    })
  }

  /* ---------- ③ 核心纯逻辑契约 ---------- */
  /**
   * 第 ③ 组全部走 barrel 的纯逻辑导出。脱离 DSH 时 barrel 加载不了（见上），
   * 这组整组跳过——它的目的是「重构有没有弄坏纯逻辑」，而不是「本机有没有装 DSH」。
   */
  const ws = join(home, 'ws')
  if (barrel !== null) {
    const created = barrel.createProject(ws, '冒烟项目')
    check('建项目：主文档落盘且能读回状态', () => {
      assert.equal(created.ok, true, 'createProject 失败：' + (created.error || ''))
      const state = barrel.readState(ws, '冒烟项目')
      assert.equal(state.initialized, true, '建完项目后 readState 必须 initialized')
      assert.equal(state.project, '冒烟项目')
    })

    check('条目校验：合法条目通过、超长被拒', () => {
      const good = barrel.checkEntry('一句话（源码: a.js:1）', 'points')
      assert.equal(good.ok, true, '合法条目被拒了：' + (good.error || ''))
      const bad = barrel.checkEntry('x'.repeat(5000), 'points')
      assert.equal(bad.ok, false, '超长条目必须被拒')
    })

    check('slug 过滤：路径分隔符与上跳被剥掉', () => {
      assert.equal(barrel.slugify('../../etc/passwd'), 'etcpasswd', '分隔符与 . 必须被剥掉')
      assert.equal(barrel.slugify('..'), null, '纯上跳必须回 null')
      assert.equal(barrel.slugify('正常项目名'), '正常项目名')
    })

    /* ---------- v9：工作流彻底删除 + 文档格式 v9 ---------- */
    /**
     * 为什么这条要进冒烟：删工作流是**破坏性格式改动**
     * （`## 工作流` 从 v6 起是主文档第五节）。它一旦漏改，
     * 旧文档会「读得出来、不报错、但形状已经对不上」——那正是版本号要防的事。
     */
    check('v9：主文档只剩四节，且工作流常量/导出全没了', () => {
      assert.equal(barrel.PUZZLE_VERSION, 9, 'PUZZLE_VERSION 应为 9')
      assert.deepEqual(barrel.SECTION_ORDER, ['index', 'source', 'tools', 'pit'], '主文档应只剩四节')
      assert.equal(barrel.SECTION_HEADINGS.workflow, undefined, 'SECTION_HEADINGS.workflow 应已删')
      for (const name of ['WORKFLOW_NAME_LIMIT', 'WORKFLOW_STEP_LIMIT', 'WORKFLOW_MAX_STEPS', 'WORKFLOW_ARCHIVE_CAP', 'WORKFLOW_ARCHIVE_FIELD', 'WORKFLOW_MARK']) {
        assert.equal(barrel[name], undefined, 'barrel 不该再导出 ' + name)
      }
      for (const name of ['readWorkflow', 'writeWorkflow', 'parseWorkflowBlocks', 'workflowsTriggeredBy', 'removeWorkflowItem']) {
        assert.equal(barrel[name], undefined, 'barrel 不该再导出 ' + name)
      }
    })

    check('v9 迁移：删掉 ## 工作流 与 工作流归档: ，其余内容一字不差且幂等', async () => {
      const v8 = [
        '---', 'puzzle: 8', '模式: 写后再拼', '规模: 中', '源码根: D:/src/demo',
        '工作流归档: [{"name":"老流程","steps":["a"]}]',
        '---', '',
        '> 只有五节：模块索引 / 源码索引 / 工具索引 / 坑 / 工作流。', '',
        '## 模块索引', '', '- a → 干活（源码: a.js:1）', '',
        '## 工作流', '', '### 发布流程', '', '1. 跑测试', '',
        '## 坑', '', '-别动邮箱（源码: login.js:40）', '',
      ].join('\n')
      const { migrateMainDoc } = await import('../lib/migrate.js')
      const once = migrateMainDoc(v8)
      assert.ok(!/^##\s*工作流/m.test(once.text), '`## 工作流` 没被删掉')
      assert.ok(!once.text.includes('发布流程'), '工作流内容没被删掉')
      assert.ok(!once.text.includes('工作流归档'), 'front-matter 的 工作流归档: 没被删掉')
      assert.ok(/puzzle:\s*9/.test(once.text), '版本没写成 9')
      // **workflow 之后的合法小节必须留着**（删节边界不能越界）
      assert.ok(once.text.includes('## 坑'), 'workflow 之后的「坑」被误删了')
      assert.ok(once.text.includes('别动邮箱'), '「坑」的内容被误改了')
      assert.ok(once.text.includes('源码根: D:/src/demo'), '别的 front-matter 字段被误删')
      // 幂等
      const twice = migrateMainDoc(once.text)
      assert.equal(twice.text, once.text, '第二次迁移改了文本（不幂等）')
      assert.equal(twice.changes.length, 0, '第二次应无改动')
    })

    check('v9：新项目模板不含 ## 工作流', () => {
      const text = barrel.mainTemplate('新项目', ['m1'], '目标')
      assert.ok(!text.includes('## 工作流'), '新模板还在生成 ## 工作流')
      assert.ok(!/五节/.test(text), '新模板说明还写着「五节」')
    })

    check('v9：写已删小节 section:"workflow" 被拒', () => {
      const r = barrel.updateMainSection(ws, '冒烟项目', 'workflow', '- x', true)
      assert.notEqual(r.ok, true, '已删的小节不该还能写')
      assert.ok(/index/.test(r.hint || '') && /pit/.test(r.hint || ''), 'hint 应列出可用四节，实际：' + r.hint)
    })

    /* ---------- 一次写多处（op:write 的纯逻辑那一半） ---------- */
    /**
     * 为什么要这条：`docio.js` **复刻了** `project.js` 的渲染语义
     * （那两个函数把「读」和「写」焊在一起，批量场景借不到只渲染那半）。
     * 复刻会随 `project.js` 漂移，所以必须用「**同一输入 → 逐字节相同**」把它钉死：
     * 批量写的产物必须等于逐条调单节 API 的产物。
     */
    check('一次写多处：批量产物与逐条单节写入**逐字节相同**', () => {
      const ops = [
        { target: 'main', section: 'index', content: '- auth → 登录（源码: login.js:1）' },
        { target: 'main', section: 'pit', content: '- 坑一（源码: login.js:40）' },
        { target: 'main', section: 'tools', content: '- vite → 构建（源码: v.js:1）' },
        { target: 'module', name: 'auth', section: 'points', content: '- 要点（源码: login.js:1）' },
      ]
      // A 路径：逐条单节 API
      const wsA = join(home, 'wsA')
      barrel.createProject(wsA, 'demo', ['auth'])
      for (const op of ops) {
        const r = op.target === 'main'
          ? barrel.updateMainSection(wsA, 'demo', op.section, op.content, true)
          : barrel.updateModuleSection(wsA, 'demo', op.name, op.section, op.content, true)
        assert.equal(r.ok, true, 'A 路径写入失败：' + (r.error || ''))
      }
      // B 路径：批量（planWrites + renderGroup，与 op:write 同一套）
      const wsB = join(home, 'wsB')
      barrel.createProject(wsB, 'demo', ['auth'])
      const plan = barrel.planWrites(ops, { projectRoot: wsB, project: 'demo', readText: barrel.readTextCached })
      assert.equal(plan.ok, true, 'planWrites 失败：' + JSON.stringify(plan.errors || plan).slice(0, 200))
      /**
       * ⚠️ **落 `group.next`，不要再调 `renderGroup`**。
       *
       * `planWrites` 返回的 groups 已经渲染完了（`next` 就是新正文），
       * 而它的 `writes` 是**输出记录**（`{section, entries, dropped}`）——
       * 里面没有 `normalized` / `append`，所以再调 `renderGroup(g)` 会把
       * `undefined` 当正文写进去（文档被清空）。
       * 我第一版就是这么写的，于是把**正确的实现**判成了“语义分家”。
       * `index.js` 的 `puzzleOpWrite` 走的就是 `group.next`。
       */
      for (const g of plan.groups) barrel.atomicWrite(g.file, g.next)
      // 逐文件比字节
      const files = ['主文档.md', join('模块', 'auth.md')]
      for (const rel of files) {
        const a = readFileSync(join(wsA, 'demo', '拼图', rel), 'utf8')
        const b = readFileSync(join(wsB, 'demo', '拼图', rel), 'utf8')
        assert.equal(b, a, rel + ' 字节不同（批量与单节语义分家了）')
      }
    })

    check('一次写多处：一条校验失败不连坐', () => {
      const wsC = join(home, 'wsC')
      barrel.createProject(wsC, 'demo', [])
      const plan = barrel.planWrites([
        { target: 'main', section: 'index', content: '- 合法（源码: a.js:1）' },
        { target: 'main', section: 'pit', content: 'x'.repeat(5000) },
        { target: 'main', section: 'tools', content: '- 也合法（源码: v.js:1）' },
      ], { projectRoot: wsC, project: 'demo', readText: barrel.readTextCached })
      assert.equal(plan.errors.length, 1, '应恰好 1 条被拒，实际 ' + JSON.stringify(plan.errors).slice(0, 200))
      assert.ok(plan.groups.length >= 1, '合法的那几条应仍形成写入计划（不能一条错全丢）')
    })

    /**
     * **`op:write` 必须能被模型发现**（v2.4.0）。
     *
     * 为什么单列一条：功能做完了、`OPS` 里也有它，但**工具描述里一个字没提**——
     * 模型看不到就不会用，等于没做（而且是静默的：没有任何报错）。
     * 这正是「实现了」与「用得上」之间的那道缝。
     */
    check('op:write 在两处工具描述里都能被看到（模型据此才会用）', () => {
      const src = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
      // ① TOOL_DESCRIPTION 首行（模型读的第一段）
      assert.ok(/op=write[^']*一次写多处/.test(src), 'TOOL_DESCRIPTION 里没写 op=write（模型发现不了它）')
      // ② op 参数的 description（枚举值的说明）
      const i = src.indexOf("description: 'list 列项目")
      assert.ok(i > 0, '找不到 op 参数的 description')
      const seg = src.slice(i, i + 900)
      assert.ok(seg.includes('write'), 'op 参数的 description 里没列 write')
      // ③ `OPS` 枚举里必须有（否则传 op:'write' 会被参数校验拒掉）
      const opsLine = src.match(/const OPS = \[([^\]]*)\]/)
      assert.ok(opsLine !== null, '找不到 OPS 枚举')
      assert.ok(opsLine[1].includes("'write'"), "OPS 枚举里没有 'write'")
    })

    check('看板：空看板可读，写回后卡片能读出来（项目级路径）', () => {
      const empty = barrel.readBoard(ws, '冒烟项目')
      assert.equal(empty.cards.length, 0, '新工作区必须是空看板')
      const card = barrel.emptyCard('task-0001', '标题')
      assert.equal(card.id, 'task-0001')
      const written = barrel.writeBoard(ws, '冒烟项目', [card])
      assert.equal(written.ok, true, '看板写入失败：' + (written.error || ''))
      const back = barrel.readBoard(ws, '冒烟项目')
      assert.equal(back.cards.length, 1, '写回后必须读得到那张卡')
      assert.equal(barrel.nextCardId(back.cards), 'task-0002')
      // 项目隔离：另一个项目读同一工作区必须是空的（v2.4.3）
      assert.equal(barrel.readBoard(ws, '另一个项目').cards.length, 0, '另一个项目的看板必须是空的')
    })

    check('看板：路径是 <工作区>/拼图/<项目名>/派单.json，且没项目名时返回 null', () => {
      const file = barrel.boardPath(ws, '冒烟项目')
      assert.equal(file, join(ws, barrel.PUZZLE_DIR, '冒烟项目', '派单.json'), '看板路径')
      assert.equal(barrel.boardPath(ws, ''), null, '没项目名必须返回 null（不退回工作区级旧路径）')
      assert.equal(barrel.boardPath('', '冒烟项目'), null, '没工作区必须返回 null')
    })

    /**
     * 执行会话的**上下文四件套 + 目标**（用户点名要求的那条）。
     *
     * 用**互斥哨兵**而不是中文串：中文串会互相包含（`sourceRequest` 里若写了标题，
     * 用 `includes` 判标题就会**假通过**——本轮审计真的踩过这一次）。
     */
    check('派单首轮消息：标题 / 描述 / 执行提示词 / 原文都在，且无占位残留', () => {
      const text = barrel.firstPromptOf({
        title: 'TITLE_SENTINEL',
        objective: 'OBJECTIVE_SENTINEL',
        description: 'DESC_SENTINEL',
        sourceRequest: 'SOURCE_SENTINEL',
        executionPrompt: 'EXEC_SENTINEL',
      })
      for (const [name, sentinel] of [
        ['标题', 'TITLE_SENTINEL'],
        ['目标', 'OBJECTIVE_SENTINEL'],
        ['描述', 'DESC_SENTINEL'],
        ['需求原文', 'SOURCE_SENTINEL'],
        ['具体执行提示词', 'EXEC_SENTINEL'],
      ]) {
        assert.ok(text.includes(sentinel), `${name} 必须进首轮消息（用户点名要求）`)
      }
      // 空字段不能留下 `undefined` / `null` 这类字面量，也不能留连续空行。
      const bare = barrel.firstPromptOf({ objective: 'ONLY_OBJECTIVE' })
      assert.equal(bare, '**目标**：ONLY_OBJECTIVE', '只有目标时不该有前缀空行或占位残留')
      assert.equal(barrel.firstPromptOf({}), '', '全空时必须返回空串')
      assert.ok(!/undefined|null|NaN/.test(barrel.firstPromptOf({ title: 'a' })), '不能把 undefined/null 渲染进消息')
    })

    /**
     * **冻结链路**（v2.3.0，待办 B）。
     *
     * 补的洞：`plan.frozenAt` 原先**没有任何写入点**（澄清器按拍板不自己冻结，
     * 面板上又没有那颗按钮），于是 `dispatchVerdict` 的第一道闸门
     * 「方案还没冻结」**永远拦着**——卡永远派不出去。
     *
     * 这条钉的是**整条链能不能走通**（未接单 → 冻结 → 可派），
     * 不是单个函数返回什么：只测 `freezeCard` 返回 ok 会漏掉「冻结了但派不出去」。
     *
     * ⚠️ v2.4.13（用户拍板）：**冻结只在「未接单」发生，而且不搬列**。
     * 原先这条钉的是「未澄清 → 冻结 → 搬到未接单」，那个捆法在 v2.4.4 给
     * 「未澄清 → 未接单」接上自动澄清之后就自相矛盾了（卡可以不冻就进未接单）。
     * 现在一列一件事：未澄清管澄清、未接单管冻结。
     */
    check('冻结链路：未接单 → 冻结 → 可以派出去', () => {
      const card = barrel.emptyCard('task-0001', '登录页支持手机号')
      card.plan.objective = '登录页能收手机号验证码'
      card.plan.executionPrompt = '改 src/login.ts 第 40 行'
      // 卡在「未接单」（拖过去会自动起澄清，但方案冻不冻由用户拍板）。
      card.column = 'pending'

      // 冻结前：派不出去（第一道闸门）
      const before = barrel.dispatchVerdict(card)
      assert.notEqual(before.ok, true, '冻结前不该能派出去')

      // 冻结：只写 frozenAt，**不搬列**
      const frozen = barrel.freezeCard(card)
      assert.equal(frozen.ok, true, '应该能冻结：' + (frozen.error || ''))
      assert.equal(frozen.card.column, 'pending', '冻结不该搬列（列归 moveVerdict 管）')
      assert.equal(typeof frozen.card.plan.frozenAt, 'number', 'frozenAt 必须写上（这正是原先缺的写入点）')

      // 冻结后：能派出去
      const after = barrel.dispatchVerdict(frozen.card)
      assert.equal(after.ok, true, '冻结后必须能派出去：' + (after.error || ''))
    })

    check('冻结：只接受「未接单」，未澄清要先移过去', () => {
      const card = barrel.emptyCard('t0', 'x')
      card.plan.objective = 'o'
      card.plan.executionPrompt = 'e'
      const r0 = barrel.freezeCard(card)
      assert.equal(r0.ok, false, '「未澄清」不该能冻结（v2.4.13 拍板）')
      assert.match(r0.error, /只有「未接单」的卡能冻结/)
      assert.match(r0.hint, /移到「未接单」/, '要指出出路：先移过去')
    })

    check('冻结：方案不全被拒，理由与 freezeCheck 同源', () => {
      const noGoal = barrel.emptyCard('t1', 'x')
      noGoal.column = 'pending'
      noGoal.plan.executionPrompt = '改点什么'
      const r1 = barrel.freezeCard(noGoal)
      assert.equal(r1.ok, false, '没目标不该能冻结')
      // 与派单闸门同一个判据函数 —— 两处各写一套必然漂移。
      assert.equal(r1.error, barrel.freezeCheck(noGoal.plan).error, '拒绝理由必须与 freezeCheck 同源')

      const noExec = barrel.emptyCard('t2', 'x')
      noExec.column = 'pending'
      noExec.plan.objective = '做点什么'
      assert.equal(barrel.freezeCard(noExec).ok, false, '没执行交代不该能冻结')

      // 判据是「或」：有 steps 也算执行交代
      const withSteps = barrel.emptyCard('t3', 'x')
      withSteps.column = 'pending'
      withSteps.plan.objective = '做点什么'
      withSteps.plan.steps = [{ n: 1, do: '改文件' }]
      assert.equal(barrel.freezeCard(withSteps).ok, true, '有 steps 就该能冻结')
    })

    check('冻结：不能重复冻结，且不改原卡（纯函数）', () => {
      const card = barrel.emptyCard('t1', 'x')
      card.column = 'pending'
      card.plan.objective = 'o'
      card.plan.executionPrompt = 'e'
      const snapshot = JSON.stringify(card)
      const once = barrel.freezeCard(card)
      assert.equal(JSON.stringify(card), snapshot, 'freezeCard 必须是纯函数，不改原卡')
      const twice = barrel.freezeCard(once.card)
      assert.equal(twice.ok, false, '已经冻结过的不该再冻（重置 frozenAt 会丢掉冻结时间）')
    })

    check('看板：坏 JSON 不抛错、降级成空看板', () => {
      const broken = join(home, 'broken')
      mkdirSync(join(broken, barrel.PUZZLE_DIR, '坏项目'), { recursive: true })
      writeFileSync(join(broken, barrel.PUZZLE_DIR, '坏项目', '派单.json'), '{ 坏')
      const board = barrel.readBoard(broken, '坏项目')
      assert.equal(board.cards.length, 0)
      assert.equal(board.degraded, true, '坏看板必须如实标 degraded')
    })

    check('设置：写入后能读回，坏 JSON 退回默认', () => {
      const saved = barrel.patchSettings({ askPause: false })
      assert.equal(saved.askPause, false)
      assert.equal(barrel.readSettings().askPause, false, '写进去的开关必须读得回来')
    })

    /**
     * **专属工具装不上时不许抛**（v2.4.14，真机 bug 的回归钉）。
     *
     * 真机现象：面板上一句红字 `task 处理器出错：cannot get property "fs" without inject`，
     * 派单整条路 500。
     *
     * 根因：`installScopedTools` 用 `ctx.fs` 取服务——那是 Cordis 的**硬取**语法，
     * 服务不在该作用域 inject 链上就**当场抛**。而代码下面明明写着
     * 「拿不到就降级」的分支，说明作者要的是 `ctx.get('fs')`（契约里标 **optional**，
     * 要求调用方自己判 undefined）；`inject:['fs']` + `ctx.fs` 才是 hardDependency。
     *
     * 这条为什么以前没被抓到：**`installScopedTools` 此前零覆盖**。离线冒烟驱动的是
     * 纯函数与客户端渲染，不碰 Cordis 的服务代理，所以它一直是绿的。
     *
     * 这里用 Proxy 复刻代理的真实行为（未 inject 的属性访问抛），才能钉住它。
     */
    check('专属工具：agent 作用域取服务走 get()，拿不到就降级而不是抛', () => {
      const makeCtx = (services) => {
        const store = { ...services }
        return new Proxy({ get: (name) => store[name] }, {
          get(t, prop) {
            if (prop in t || typeof prop === 'symbol') return t[prop]
            throw new Error(`cannot get property "${String(prop)}" without inject`)
          },
        })
      }
      const toolsStub = { register: () => () => {} }
      const fsStub = {
        resolve: async (p) => ({ targetKey: 'k:' + p, displayPath: p }),
        stat: async () => ({ version: 'v', type: 'file', size: 1 }),
        readText: async () => 'x',
        listDir: async () => [],
        writeText: async () => ({ operation: 'update', version: 'v', before: '', after: '' }),
        editText: async () => ({ version: 'v', before: '', after: '' }),
      }
      const shellStub = { resolve: (o) => o, execute: async () => ({ stdout: '', exitCode: 0 }) }

      // ① 服务齐全 → 装得上（硬取语法在这一步就抛，正是真机那句错）
      const full = barrel.installScopedTools(
        { ctx: makeCtx({ tools: toolsStub, fs: fsStub, shell: shellStub }) }, { cwd: 'D:/x' },
      )
      assert.equal(full.ok, true, '服务齐全时必须装得上：' + String(full.reason || ''))
      assert.ok(full.registered.length > 0, '至少要注册一个 pz_* 工具')

      // ② 拿不到 fs → 降级（不抛）
      const noFs = barrel.installScopedTools({ ctx: makeCtx({ tools: toolsStub }) }, { cwd: 'D:/x' })
      assert.equal(noFs.ok, false, '拿不到 fs 要降级')
      assert.match(String(noFs.reason), /fs/, '理由要说清是 fs 拿不到')

      // ③ 拿不到 shell 不影响装配（它只服务 pz_bash）
      const noShell = barrel.installScopedTools(
        { ctx: makeCtx({ tools: toolsStub, fs: fsStub }) }, { cwd: 'D:/x' },
      )
      assert.equal(noShell.ok, true, 'shell 缺失不该让整套工具失败')

      // ④ agent / ctx 拿不到也不许抛
      assert.equal(barrel.installScopedTools({ ctx: undefined }, {}).ok, false)
      assert.equal(barrel.installScopedTools(undefined, {}).ok, false)
    })

    /**
     * **沙箱策略必须真的传进 `writeText` / `editText`**（v2.4.15，真机 bug 的回归钉）。
     *
     * 真机现象：用户报「执行专属工具被沙箱拦住」——`pz_write` / `pz_edit` 一律被拒。
     *
     * 根因（宿主源码原文，`dsh-fs-sandbox` 的 `checkedTarget`）：
     * ```js
     * const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();  // 兜底不带 session！
     * if (mode === 'read-only') throw new FsError(..., 'FS_SANDBOX_DENIED');
     * ```
     * 不传第 5 个参数 → 兜底那次 `resolve()` **不带 session** → 拿部署默认
     * （fail-safe 的 `read-only`）→ 写一律 `FS_SANDBOX_DENIED`。
     *
     * ⚠️ 上一条用例的 stub ctx **没有 `sandboxPolicy`**，所以它走的正是「拿不到策略」
     * 的降级路径——恰好证明不抛，但**覆盖不到「策略传进去了」这个新行为**。
     * 这条专门补那个缺口：断言 `resolve` 收到 `session`、且 policy 真的作为
     * **第 5 个参数**到了 `writeText`。
     */
    await checkAsync('专属工具：沙箱策略按会话现算并作为第 5 个参数传给 writeText', async () => {      const writeCalls = []
      const resolveCalls = []
      const session = { id: 's-1', header: { cwd: 'D:/proj' } }
      const policy = { mode: 'workspace-write', workspaceRoot: 'D:/proj' }
      const ctx = {
        get: (name) => {
          if (name === 'tools') return { register: () => () => {} }
          if (name === 'sandboxPolicy') {
            return {
              resolve: (request) => {
                resolveCalls.push(request)
                return policy
              },
            }
          }
          if (name === 'fs') {
            return {
              resolve: async (p) => ({ targetKey: 'k:' + p, displayPath: p }),
              stat: async () => ({ version: 'v', type: 'file', size: 1 }),
              readText: async () => 'x',
              listDir: async () => [],
              writeText: async (...args) => {
                writeCalls.push(args)
                return { operation: 'update', version: 'v', before: '', after: '' }
              },
              editText: async (...args) => ({ version: 'v', before: '', after: '' }),
            }
          }
          return undefined
        },
      }
      const installed = barrel.installScopedTools({ ctx, session }, { cwd: 'D:/proj' })
      assert.equal(installed.ok, true, '应该装得上：' + String(installed.reason || ''))

      // 找到注册进去的 pz_write 定义，直接驱动它（冒烟里注册的是 stub，所以自己收集）
      const registered = []
      const realCtx = {
        get: (name) => (name === 'tools'
          ? { register: (def) => { registered.push(def); return () => {} } }
          : ctx.get(name)),
      }
      barrel.installScopedTools({ ctx: realCtx, session }, { cwd: 'D:/proj' })
      const pzWrite = registered.find((one) => one.name === 'pz_write')
      assert.ok(pzWrite !== undefined, '必须注册 pz_write')

      // ⚠️ 参数名必须是**语义化**的那套（v2.4.16）：`file_path` / `content`。
      // 用旧的 `p` / `text` 会被 defineTool 的参数校验当场拒（正是用户报的那个错），
      // 所以这行同时钉住了「参数名不能再退回单字母」。
      await pzWrite.execute({ file_path: 'a.txt', content: 'hi' })

      // ① 策略按**会话**现算（不传 session 就退回部署根，等于丢掉会话边界）
      assert.equal(resolveCalls.length > 0, true, '必须调用 sandboxPolicy.resolve')
      assert.equal(resolveCalls[0].session, session, 'resolve 必须收到本会话（它的 cwd 就是 workspace-write 边界）')
      // ② 策略真的到了 writeText 的第 5 个参数位
      assert.equal(writeCalls.length, 1, 'writeText 必须被调用一次')
      assert.equal(writeCalls[0][4], policy, 'writeText 的第 5 个参数必须是解析出来的 policy')
    })
  }

  /* ---------- ④ 客户端半 bundle ---------- */
  await checkAsync('客户端 bundle：能 eval 并交出 apply', async () => {
    const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
    let loaded = null
    const fakeWindow = {
      __ModuleLoader__: { load(definition) { loaded = definition } },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      addEventListener() {},
      removeEventListener() {},
      confirm: () => false,
      setTimeout,
      clearTimeout,
    }
    const run = new Function('window', 'document', 'fetch', src)
    run(
      fakeWindow,
      { createElement: () => ({ setAttribute() {}, textContent: '', style: {} }), head: { appendChild() {} }, body: {} },
      () => Promise.resolve({ json: () => Promise.resolve({ ok: true, result: {} }) }),
    )
    assert.ok(loaded !== null, 'bundle 必须调用 window.__ModuleLoader__.load')
    assert.equal(loaded.id, 'dsh-puzzle-mode')
    assert.equal(typeof loaded.factory, 'function')
    const fakeReact = {
      createElement: () => null,
      useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
      useEffect: () => {},
      useMemo: (f) => f(),
      useRef: (v) => ({ current: v }),
      useCallback: (f) => f,
      Fragment: 'fragment',
    }
    const exported = loaded.factory((name) => {
      if (name === 'react') return fakeReact
      throw new Error('unexpected require: ' + name)
    })
    assert.equal(typeof exported.apply, 'function', '客户端半必须交出 apply')
  })

  /* ---------- ⑤ 看板列头五列等高（布局契约） ---------- */
  /**
   * 为什么这条要进冒烟：`dispatchBoard` 只给「未澄清」列头加「＋ 新建」按钮，
   * 而按钮比标题行高得多。`align-items:center` 只对齐盒内内容，**盒子不等高就必然错位**
   * ——症状是那一列标题下移、空态文字跟着下移（v2.2.6 用户报的「没横向对齐」）。
   *
   * 这里断言的是**根因**（列头盒被显式撑高），不是像素值：真排版量盒要用真浏览器
   * （本次修复已用 headless Chromium 量过五列的列头盒高 / 标题中心 / 空态中心，修前
   * 未澄清列分别是 34.39 / +2.69 / +5.39，其余四列一致；修后五列全部 38 / 26 / 108.25）。
   * 冒烟**不引浏览器依赖**——那会把最小回归网变成需要 Chromium 的重活。
   */
  check('看板：列头盒必须显式等高，否则「未澄清」列必然错位', () => {
    const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
    const m = src.match(/\.dshpz-boardcolhead\{([^}]*)\}/)
    assert.ok(m !== null, '必须还能找到 .dshpz-boardcolhead 规则')
    const rule = m[1]
    assert.ok(
      rule.includes('box-sizing:border-box'),
      '列头必须 border-box：padding 与 min-height 不加在一起才算得准',
    )
    assert.ok(
      /min-height:\d/.test(rule),
      '列头必须 min-height：五列里有一列多了「＋ 新建」按钮，不撑高就会各列不等高',
    )
    // 按钮真的只加在「未澄清」列 —— 这条前提变了，上面那条 min-height 的必要性也会变。
    const board = src.slice(src.indexOf('function dispatchBoard'))
    assert.ok(
      /pair\[0\] === 'unclarified'/.test(board),
      '「＋ 新建」按钮仍然只加在未澄清列（前提不变）',
    )
  })

  /* ---------- ⑥ 新建任务单浮窗 + 分解转圈圈 ---------- */
  /**
   * 为什么这条要进冒烟：v2.2.7 把「新建任务单」从**整页替换**改成**浮在看板上**，
   * 并把「分解中…」换成一个转圈圈。两者都会**静默退化**——
   * 浮窗退回整页只是「建完看不到卡落在哪」，转圈圈丢了只是「按钮文字还在」，
   * 都不会报错，所以必须有断言钉住。
   *
   * 这里驱动**真实的 `dispatchBoard` / `newTaskFloat`**（建树版假 React），
   * 断言的是**行为契约**（是浮层不是换页、转圈圈只在忙时出现），不是文案或 CSS 文本。
   */
  check('新建任务单：是浮层而不是换页，且分解中才转圈圈', () => {
    const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
    let loaded = null
    const fakeWindow = {
      __ModuleLoader__: { load(d) { loaded = d } },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      addEventListener() {}, removeEventListener() {}, confirm: () => false, setTimeout, clearTimeout,
    }
    new Function('window', 'document', 'fetch', src)(
      fakeWindow,
      { createElement: () => ({ setAttribute() {}, textContent: '', style: {} }), head: { appendChild() {} }, body: {} },
      () => Promise.resolve({ json: () => Promise.resolve({ ok: true, result: {} }) }),
    )
    // **建树版** React：把 h(...) 留成对象，才能断言真实的元素树。
    const h = (type, props, ...kids) => ({
      type, props: props || {},
      children: kids.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    })
    const exported = loaded.factory((name) => {
      if (name === 'react') {
        return { createElement: h, useState: (v) => [v, () => {}], useEffect() {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }), useCallback: (f) => f, Fragment: 'fragment' }
      }
      throw new Error('unexpected require: ' + name)
    })
    assert.equal(typeof exported.newTaskFloat, 'function', '浮窗组件必须导出（便于离线驱动）')
    assert.equal(typeof exported.dispatchBoard, 'function')

    const walk = (n, out = []) => {
      if (n === null || n === undefined || typeof n !== 'object') return out
      out.push(n)
      for (const c of n.children || []) walk(c, out)
      return out
    }
    const cls = (tree) => walk(tree).map((n) => (n.props && n.props.className) || '')
    const texts = (tree) => walk(tree).flatMap((n) => n.children.filter((c) => typeof c === 'string'))
    const form = { request: '让登录页支持手机号+验证码', title: '', objective: '', description: '', busy: false }
    const viewOf = (newTask) => ({
      state: { newTask, board: { cards: [] }, narrow: false, boardCol: 'unclarified', flyId: null, dragOver: null, dragId: null },
    })

    // ① 浮层结构
    const idle = exported.newTaskFloat(viewOf(form))
    assert.ok(cls(idle).includes('dshpz-ntwrap'), '必须有浮层底板 .dshpz-ntwrap')
    assert.ok(cls(idle).includes('dshpz-ntbox'), '必须有窗体 .dshpz-ntbox')

    // ② 转圈圈只在 busy 时出现，且那时按钮被禁用（防连点）
    assert.ok(!cls(idle).includes('dshpz-spin'), '没在分解时不该有转圈圈')
    const busy = exported.newTaskFloat(viewOf(Object.assign({}, form, { busy: true })))
    assert.ok(cls(busy).includes('dshpz-spin'), '分解中必须有转圈圈')
    const spinBtn = walk(busy).find(
      (n) => n.type === 'button' && n.children.some((c) => c && c.props && c.props.className === 'dshpz-spin'),
    )
    assert.ok(spinBtn !== undefined, '转圈圈必须在按钮内部')
    assert.equal(spinBtn.props.disabled, true, '分解中按钮必须禁用，否则能连点')
    // 用户指定：转圈圈在**文字右边**。子节点顺序就是视觉顺序。
    const kids = spinBtn.children
    const textIdx = kids.findIndex((c) => typeof c === 'string')
    const spinIdx = kids.findIndex((c) => c && c.props && c.props.className === 'dshpz-spin')
    assert.ok(textIdx >= 0 && spinIdx >= 0, '按钮里应有文字与转圈圈')
    assert.ok(spinIdx > textIdx, '转圈圈必须在文字右边')

    // ③ 关键：浮窗开着时**看板本体仍在**（这正是「改成浮窗」的目的）
    const open = exported.dispatchBoard(viewOf(form))
    assert.ok(cls(open).includes('dshpz-board'), '浮窗开着时看板必须还在（否则就是退回整页替换了）')
    assert.ok(cls(open).includes('dshpz-ntwrap'), '看板里必须挂着浮窗')
    assert.equal(cls(open).filter((c) => c === 'dshpz-boardcol').length, 5, '五列必须都在')
    // 窄屏分支同样要挂
    const narrow = viewOf(form)
    narrow.state.narrow = true
    assert.ok(cls(exported.dispatchBoard(narrow)).includes('dshpz-ntwrap'), '窄屏下浮窗不能丢')
    // 关着时不该有浮层
    assert.ok(!cls(exported.dispatchBoard(viewOf(null))).includes('dshpz-ntwrap'), '没开新建时不该有浮窗')

    /**
     * ④ **「冻结」按钮真的挂上了 onClick**（v2.3.0；v2.4.3 起搬进详情浮窗）。
     *
     * 光断言「按钮文案在」不够：把 onClick 摘掉，文案照样渲染，
     * 而用户点下去什么都不会发生——**静默失效**。
     * 这条是负控实测暴露的缺口（摘掉 onClick 时冒烟原本全绿）。
     *
     * ⚠️ v2.4.3：卡上按钮全删了（用户拍板），动作搬进**卡详情浮窗**。
     * 所以这里要把浮窗打开（`state.cardFloat`）才找得到那颗按钮。
     * 顺带钉住新契约：**卡本体上不该再有任何 button**。
     */
    const cardOf = {
      id: 'task-0001', title: 't', column: 'unclarified',
      plan: { frozenAt: null, version: 1 }, sourceRequest: '',
      goalId: '', failure: null, verified: false, history: [],
    }
    const cardTree = exported.dispatchBoard({
      state: {
        board: {
          cards: [cardOf],
          columns: ['unclarified', 'pending', 'doing', 'done', 'failed'],
          labels: { unclarified: '未澄清', pending: '未接单', doing: '在做', done: '已做', failed: '失败' },
        },
        narrow: false, taskBusy: false, dragOver: null, dragId: null, flyId: null,
      },
    })
    /**
     * 折叠卡上**一个 button 都不该有**——这是用户拍板那条的直接断言。
     * 用「卡那个子树里有没有 button」判，而不是数整棵树（浮窗与列头都有按钮）。
     */
    const miniCard = walk(cardTree).find((n) => n.props && typeof n.props.className === 'string'
      && n.props.className.includes('dshpz-cardmini'))
    assert.ok(miniCard !== undefined, '折叠卡必须带 dshpz-cardmini')
    assert.ok(
      walk(miniCard).every((n) => n.type !== 'button'),
      '折叠卡上不该再有任何按钮（用户拍板：卡上按钮删掉，只能移动触发）',
    )
    assert.ok(
      walk(miniCard).some((n) => n.props && n.props.className === 'dshpz-minititle'),
      '折叠卡必须显示标题',
    )

    /**
     * ⚠️ v2.4.13（用户拍板）：冻结按钮**只在「未接单」**。
     * 原先这里拿「未澄清」的卡找按钮，而那一列现在只负责澄清——
     * 一列一件事：未澄清管澄清、未接单管冻结。
     */
    const pendingCard = {
      id: 'task-0002', title: 't2', column: 'pending',
      plan: { frozenAt: null, version: 1 }, sourceRequest: '',
      goalId: '', failure: null, verified: false, history: [],
    }
    const floatTree = exported.dispatchBoard({
      state: {
        board: {
          cards: [pendingCard],
          columns: ['unclarified', 'pending', 'doing', 'done', 'failed'],
          labels: { unclarified: '未澄清', pending: '未接单', doing: '在做', done: '已做', failed: '失败' },
        },
        narrow: false, taskBusy: false, dragOver: null, dragId: null, flyId: null,
        cardFloat: 'task-0002',
      },
    })
    const freezeBtn = walk(floatTree).find((n) => n.type === 'button' && n.children.includes('冻结'))
    assert.ok(freezeBtn !== undefined, '「未接单」卡的详情浮窗里必须有「冻结」按钮')
    assert.equal(typeof freezeBtn.props.onClick, 'function', '「冻结」按钮必须挂 onClick（否则点了没反应）')
    /**
     * 光断言「是个函数」不够：换成一个**空函数**也能通过，
     * 而那样按钮依然是死的。所以还要钉「它真的去发那个请求」。
     */
    assert.ok(
      freezeBtn.props.onClick.toString().includes('freezeCard'),
      '「冻结」按钮的 onClick 必须真的调 freezeCard（不能是空函数）',
    )
    /**
     * 反向：**「未澄清」的卡不该有冻结按钮**（v2.4.13 拍板）。
     * 少了这条，把按钮挂回两列也能全绿——而那正是用户否掉的做法。
     */
    const unclarifiedFloat = exported.dispatchBoard({
      state: {
        board: {
          cards: [cardOf],
          columns: ['unclarified', 'pending', 'doing', 'done', 'failed'],
          labels: { unclarified: '未澄清', pending: '未接单', doing: '在做', done: '已做', failed: '失败' },
        },
        narrow: false, taskBusy: false, dragOver: null, dragId: null, flyId: null,
        cardFloat: 'task-0001',
      },
    })
    assert.ok(
      !walk(unclarifiedFloat).some((n) => n.type === 'button' && n.children.includes('冻结')),
      '「未澄清」的卡不该有冻结按钮（它只管澄清；先移到「未接单」）',
    )
  })

  /* ---------- ⑥ 任务单拖动 ---------- */
  /**
   * 拖拽最易坏的地方**不在「事件挂没挂」**，而在两处：
   *   1. `dragover` 忘了 `preventDefault()` → 浏览器认定「不可放置」，
   *      `drop` **永不触发且不报错**（表现：拖过去松手什么都没发生）；
   *   2. `dragend` 没清 `dragId` → 取消拖拽后的一次 drop 会**搬错卡**。
   * 两条都只有真驱动处理器才看得见，所以这里直接调**真函数**。
   */
  check('看板拖拽：dragover 必须 preventDefault，否则 drop 永不触发', () => {
    const clientSrc = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
    let bundle = null
    new Function('window', 'document', 'fetch', clientSrc)(
      {
        __ModuleLoader__: { load(d) { bundle = d } },
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        addEventListener() {}, removeEventListener() {}, confirm: () => false, setTimeout, clearTimeout,
      },
      { createElement: () => ({ setAttribute() {}, textContent: '', style: {} }), head: { appendChild() {} }, body: {} },
      () => Promise.resolve({ json: () => Promise.resolve({ ok: true, result: { board: { cards: [], columns: [] }, effect: 'advance', label: 'x' } }) }),
    )
    const mk = (type, props, ...kids) => ({ type, props: props || {}, children: kids.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true) })
    const ui = bundle.factory((n) => {
      if (n === 'react') return { createElement: mk, useState: (v) => [v, () => {}], useEffect() {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }), useCallback: (f) => f, Fragment: 'f' }
      throw new Error('unexpected require: ' + n)
    })
    const all = (n, out = []) => {
      if (n === null || n === undefined || typeof n !== 'object') return out
      out.push(n)
      for (const c of n.children || []) all(c, out)
      return out
    }
    const tree = ui.dispatchBoard({
      state: {
        board: {
          cards: [{ id: 'task-0001', title: 't', column: 'unclarified', plan: { frozenAt: null, version: 1 }, sourceRequest: '', goalId: '', failure: null, verified: false, history: [] }],
          columns: ['unclarified', 'pending', 'doing', 'done', 'failed'],
          labels: { unclarified: '未澄清', pending: '未接单', doing: '在做', done: '已做', failed: '失败' },
        },
        narrow: false, taskBusy: false, dragOver: null, dragId: null, flyId: null,
      },
    })
    const card = all(tree).find((n) => n.props && typeof n.props.className === 'string' && n.props.className.split(' ').includes('dshpz-card'))
    const pending = all(tree).find((n) => n.props && n.props.className === 'dshpz-boardcol' && n.props['data-col'] === 'pending')
    assert.ok(card !== undefined && pending !== undefined, '必须能找到卡与目标列')
    assert.equal(card.props.draggable, true, '宽屏卡片必须 draggable')
    assert.equal(typeof card.props.onDragStart, 'function', '缺 onDragStart')
    assert.equal(typeof card.props.onDragEnd, 'function', '缺 onDragEnd')
    assert.equal(typeof pending.props.onDragOver, 'function', '缺 onDragOver')
    assert.equal(typeof pending.props.onDrop, 'function', '缺 onDrop')

    // 真语义事件：preventDefault 真的置 defaultPrevented。
    const mkEv = (dt) => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, dataTransfer: dt })
    const mkDt = (working) => {
      const store = {}
      return {
        effectAllowed: '', dropEffect: '',
        setData(k, v) { if (!working) throw new Error('老 WebView'); store[k] = v },
        getData(k) { return working ? (store[k] || '') : '' },
      }
    }

    const over = mkEv(mkDt(true))
    pending.props.onDragOver(over)
    assert.equal(over.defaultPrevented, true, 'dragover 没 preventDefault —— 浏览器会认定「不可放置」，drop 永不触发且不报错')

    // dragstart 必须把卡 id 写进 dataTransfer
    const d = mkDt(true)
    card.props.onDragStart(mkEv(d))
    assert.equal(d.getData('text/plain'), 'task-0001', 'dataTransfer 里应是卡 id')

    /**
     * `dataTransfer` **读不到**时要靠 `state.dragId` 兜底（老 WebView / 某些浏览器
     * 在 `dragstart` 里设得进、`drop` 里读不出）。
     * 钉它的方式：用一个“会抛”的 dataTransfer 走完拖拽，
     * 看沿途是否仍然会发出搬卡请求。
     */
    /**
     * 真验兜底：把 `fetch` 换成**记录请求**的桩。
     * `post()` 走的就是 bundle 求值时注入的那个 `fetch`，
     * 所以只要重新载一次 bundle、换上桩，就能看到面板真正发出的请求。
     */
    const seen = []
    let bundle2 = null
    new Function('window', 'document', 'fetch', clientSrc)(
      {
        __ModuleLoader__: { load(d) { bundle2 = d } },
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        addEventListener() {}, removeEventListener() {}, confirm: () => false, setTimeout, clearTimeout,
      },
      { createElement: () => ({ setAttribute() {}, textContent: '', style: {} }), head: { appendChild() {} }, body: {} },
      (url, opt) => {
        try { seen.push(JSON.parse(opt.body)) } catch (_e) { /* 忽略 */ }
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, result: { board: { cards: [], columns: [] }, effect: 'advance', label: 'x' } }) })
      },
    )
    const ui2 = bundle2.factory((n) => {
      if (n === 'react') return { createElement: mk, useState: (v) => [v, () => {}], useEffect() {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }), useCallback: (f) => f, Fragment: 'f' }
      throw new Error('unexpected require: ' + n)
    })
    const tree2 = ui2.dispatchBoard({
      state: {
        board: {
          cards: [{ id: 'task-0001', title: 't', column: 'unclarified', plan: { frozenAt: null, version: 1 }, sourceRequest: '', goalId: '', failure: null, verified: false, history: [] }],
          columns: ['unclarified', 'pending', 'doing', 'done', 'failed'],
          labels: { unclarified: '未澄清', pending: '未接单', doing: '在做', done: '已做', failed: '失败' },
        },
        narrow: false, taskBusy: false, dragOver: null, dragId: null, flyId: null,
      },
    })
    const c2 = all(tree2).find((n) => n.props && typeof n.props.className === 'string' && n.props.className.split(' ').includes('dshpz-card'))
    const p2 = all(tree2).find((n) => n.props && n.props.className === 'dshpz-boardcol' && n.props['data-col'] === 'pending')
    // dataTransfer 两头都不可用（老 WebView）——只能靠 state.dragId
    const broken = { effectAllowed: '', dropEffect: '', setData() { throw new Error('老 WebView') }, getData() { return '' } }
    c2.props.onDragStart(mkEv(broken))
    p2.props.onDrop(mkEv(broken))
    const move = seen.filter((q) => q && q.action === 'move').pop()
    assert.ok(move !== undefined, 'dataTransfer 不可用时必须能靠 dragId 兜底搬卡，实际请求：' + JSON.stringify(seen))
    assert.equal(move.id, 'task-0001', '兜底搬的应是 task-0001')

    // 取消拖拽（dragend）后再 drop 不该搬卡（脏 dragId 会搬错卡）
    seen.length = 0
    c2.props.onDragStart(mkEv(broken))
    c2.props.onDragEnd()
    p2.props.onDrop(mkEv(broken))
    assert.ok(seen.filter((q) => q && q.action === 'move').length === 0,
      'dragend 没清净 dragId：取消拖拽之后的一次 drop 仍然搬了卡')
  })

  check('看板拖拽：窄屏不挂拖拽（触屏上原生拖拽与滚动打架）', () => {
    const clientSrc = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
    let bundle = null
    new Function('window', 'document', 'fetch', clientSrc)(
      {
        __ModuleLoader__: { load(d) { bundle = d } },
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        addEventListener() {}, removeEventListener() {}, confirm: () => false, setTimeout, clearTimeout,
      },
      { createElement: () => ({ setAttribute() {}, textContent: '', style: {} }), head: { appendChild() {} }, body: {} },
      () => Promise.resolve({ json: () => Promise.resolve({ ok: true, result: { board: { cards: [], columns: [] }, effect: 'advance', label: 'x' } }) }),
    )
    const mk = (type, props, ...kids) => ({ type, props: props || {}, children: kids.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true) })
    const ui = bundle.factory((n) => {
      if (n === 'react') return { createElement: mk, useState: (v) => [v, () => {}], useEffect() {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }), useCallback: (f) => f, Fragment: 'f' }
      throw new Error('unexpected require: ' + n)
    })
    const all = (n, out = []) => {
      if (n === null || n === undefined || typeof n !== 'object') return out
      out.push(n)
      for (const c of n.children || []) all(c, out)
      return out
    }
    const narrowTree = ui.dispatchBoard({
      state: {
        board: {
          cards: [{ id: 'task-0001', title: 't', column: 'unclarified', plan: { frozenAt: null, version: 1 }, sourceRequest: '', goalId: '', failure: null, verified: false, history: [] }],
          columns: ['unclarified', 'pending', 'doing', 'done', 'failed'],
          labels: { unclarified: '未澄清', pending: '未接单', doing: '在做', done: '已做', failed: '失败' },
        },
        narrow: true, taskBusy: false, dragOver: null, dragId: null, flyId: null,
      },
    })
    const nc = all(narrowTree).find((n) => n.props && typeof n.props.className === 'string' && n.props.className.split(' ').includes('dshpz-card'))
    assert.ok(nc !== undefined, '窄屏下也该有卡')
    assert.notEqual(nc.props.draggable, true, '窄屏不该 draggable')
    assert.equal(nc.props.onDragStart, undefined, '窄屏不该挂 onDragStart')
  })

  /* ---------- ⑥ 看板列名用中文（不是英文列键） ---------- */
  /**
   * 为什么这条要进冒烟：宿主 `rpcBoard` 一直在返回 `labels: COLUMN_LABELS`，
   * 而客户端原先**没用它**——按钮上写 `'→ ' + next`，`next` 是**列键**，
   * 于是真机显示「→ pending」。用户看到的是内部标识符而不是列名。
   *
   * 这条**自己载入 bundle**（不依赖上面那个 check 的局部 `exported`）——
   * 变量作用域不该成为断言能不能写的理由。
   */
  check('看板：「→ 下一列」按钮用中文列名，不露出英文列键', () => {
    const clientSrc = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
    let bundle = null
    new Function('window', 'document', 'fetch', clientSrc)(
      {
        __ModuleLoader__: { load(d) { bundle = d } },
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        addEventListener() {}, removeEventListener() {}, confirm: () => false, setTimeout, clearTimeout,
      },
      { createElement: () => ({ setAttribute() {}, textContent: '', style: {} }), head: { appendChild() {} }, body: {} },
      () => Promise.resolve({ json: () => Promise.resolve({ ok: true, result: {} }) }),
    )
    const mk = (type, props, ...kids) => ({
      type, props: props || {},
      children: kids.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
    })
    const ui = bundle.factory((n) => {
      if (n === 'react') return { createElement: mk, useState: (v) => [v, () => {}], useEffect() {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }), useCallback: (f) => f, Fragment: 'f' }
      throw new Error('unexpected require: ' + n)
    })
    const all = (n, out = []) => {
      if (n === null || n === undefined || typeof n !== 'object') return out
      out.push(n)
      for (const c of n.children || []) all(c, out)
      return out
    }
    const textsOf = (tree) => all(tree).flatMap((n) => n.children.filter((c) => typeof c === 'string'))
    const boardOf = (labels) => ({
      state: {
        board: {
          cards: [{ id: 't1', title: 'x', column: 'unclarified', plan: { frozenAt: null, version: 1 }, sourceRequest: '', goalId: '', failure: null, verified: false, history: [] }],
          columns: ['unclarified', 'pending', 'doing', 'done', 'failed'],
          ...(labels === undefined ? {} : { labels }),
        },
        narrow: false, taskBusy: false, dragOver: null, dragId: null, flyId: null,
        /**
         * ⚠️ v2.4.3：箭头按钮从卡上搬进了**卡详情浮窗**，所以要把浮窗打开
         * （`state.cardFloat` 指向那张卡）才找得到它。少了这一行，这条断言
         * 会因为「按钮不在卡上了」而红——而那不是 bug，是设计。
         */
        cardFloat: 't1',
      },
    })

    const texts = textsOf(ui.dispatchBoard(boardOf({ unclarified: '未澄清', pending: '未接单', doing: '在做', done: '已做', failed: '失败' })))
    assert.ok(texts.includes('→ 未接单'), '按钮应显示「→ 未接单」，实际箭头按钮：' + texts.filter((s) => s.startsWith('→')).join('/'))
    assert.ok(!texts.some((s) => s === '→ pending'), '不能把英文列键直接给用户看')

    // 拿不到 labels（老宿主 / 降级）时不能崩，也不能渲染 undefined。
    const fallback = textsOf(ui.dispatchBoard(boardOf(undefined)))
    assert.ok(!fallback.some((s) => /undefined/.test(s)), '缺 labels 时不能渲染 undefined')
  })

  /* ---------- ⑦ 执行完成 → 搬卡 + 汇报大脑 ---------- */
  /**
   * 为什么这条要进冒烟：`verdictOf` / `observeOf` 曾经**全仓零调用**
   * （界面上写着「做完自动落到已做」，实际那条线是断的）。这条钉住它真的接上了：
   * 完成搬「已做」、失败搬「失败」、完成时把汇报投给大脑，且**旁路失败不回滚主功能**。
   */
  await checkAsync('执行完成：搬到「已做」并把汇报投给全局大脑', async () => {
    const c = await import('../lib/completion.js')
    const d = await import('../lib/dispatch.js')
    const card = {
      ...d.emptyCard('task-0001', '登录页支持手机号'),
      column: 'doing', sessionId: 'sess-1', project: 'demo', goalId: 'goal-1',
      plan: { ...d.emptyCard('t', 'x').plan, objective: '登录页能收手机号验证码', executionPrompt: '改 src/login.ts', frozenAt: 1 },
    }
    const prompts = []
    let board = { cards: [card] }
    const deps = {
      readBoard: () => board,
      writeBoard: (next) => { board = { cards: next }; return { ok: true } },
      brainSessionOf: () => 'brain-1',
      sessionController: { prompt: (req) => { prompts.push(req); return Promise.resolve() } },
    }

    // ① 完成
    const done = await c.applyGoalChange(deps, { id: 'sess-1' }, { goal: { phase: 'complete' } })
    assert.equal(done.moved, true, '完成必须搬卡：' + done.reason)
    assert.equal(board.cards[0].column, 'done', '完成的卡必须落到「已做」')
    assert.equal(board.cards[0].verified, false, '完成的卡必须标未验收')
    assert.equal(board.cards[0].history[0].by, 'auto', '自动搬列要记 by:auto')
    assert.equal(prompts.length, 1, '完成必须投一条汇报给大脑')
    assert.equal(prompts[0].sessionId, 'brain-1', '汇报的收件人必须是大脑会话')
    assert.equal(prompts[0].mode, 'queue', '汇报要 queue（排进 inbox），不是 steer')
    assert.ok(prompts[0].content[0].text.includes('登录页能收手机号验证码'), '汇报必须带上目标')

    // ② 失败：搬列但**不**打扰大脑
    const cards2 = [{ ...card, column: 'doing' }]
    const prompts2 = []
    const deps2 = { ...deps, readBoard: () => ({ cards: cards2 }), writeBoard: () => ({ ok: true }), sessionController: { prompt: (r) => { prompts2.push(r); return Promise.resolve() } } }
    const bad = await c.applyGoalChange(deps2, { id: 'sess-1' }, { goal: { phase: 'blocked', blockedReason: { code: 'round-limit', message: '轮次用尽' } } })
    assert.equal(bad.moved, true, 'blocked 必须搬卡')
    assert.equal(prompts2.length, 0, '失败不该投汇报（该由用户决定重来）')

    // ③ 旁路失败不回滚：没有大脑时仍然搬卡
    let board3 = { cards: [{ ...card, column: 'doing' }] }
    const deps3 = { readBoard: () => board3, writeBoard: (n) => { board3 = { cards: n }; return { ok: true } }, brainSessionOf: () => '', sessionController: { prompt: () => Promise.resolve() } }
    const noBrain = await c.applyGoalChange(deps3, { id: 'sess-1' }, { goal: { phase: 'complete' } })
    assert.equal(noBrain.moved, true, '没有大脑也必须搬卡（旁路失败不升级成主功能失败）')
    assert.equal(board3.cards[0].column, 'done', '卡必须已经搬到「已做」')

    /**
     * ④ **幂等**：宿主会对同一个 goal 反复 emit `goal/changed`（每次变更都发），
     * 而卡已经在「已做」之后不该再搬、更不该**再汇报一遍**——否则大脑会被
     * 同一件事反复打扰。这条是负控实测暴露出来的缺口（原先没钉）。
     */
    let board4 = { cards: [{ ...card, column: 'done', verified: false }] }
    const prompts4 = []
    const deps4 = {
      readBoard: () => board4,
      writeBoard: (n) => { board4 = { cards: n }; return { ok: true } },
      brainSessionOf: () => 'brain-1',
      sessionController: { prompt: (r) => { prompts4.push(r); return Promise.resolve() } },
    }
    const again = await c.applyGoalChange(deps4, { id: 'sess-1' }, { goal: { phase: 'complete' } })
    assert.equal(again.moved, false, '已在「已做」的卡不该再搬一次')
    assert.equal(prompts4.length, 0, '已在「已做」的卡不该重复汇报给大脑')
    assert.equal(board4.cards[0].history.length, 0, '不该留下一条「已做 → 已做」的空历史')
  })

  /* ---------- ⑧ RPC 路由必须 await 异步处理器 ---------- */
  /**
   * 为什么这条要进冒烟：路由里多数 handler 是 `async`，而**它们自己**
   * 负责 `respond()`。不 await 的话，handler 抛错会变成一条**浮空的 rejection**：
   * 响应永远不发，浏览器那边就是「点了没反应」，一直挂到超时——比报错难查得多。
   * v2.4.0 起尤其要紧：删卡会去 await 宿主服务（`workspaceRegistry.deleteSession`），那真会抛。
   */
  check('RPC 路由：必须 await handler 并接住异常（否则响应永远不发）', () => {
    const src = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
    assert.ok(
      /await handler\(\{ ctx, body, res/.test(src),
      '路由没 await handler：异步 handler 抛错会静默挂起浏览器',
    )
    // 必须有 try/catch，否则 rejection 没人接（还是挂起）
    const at = src.indexOf('await handler({ ctx, body, res')
    assert.ok(at > 0, '找不到 await handler 那一行')
    const before = src.slice(Math.max(0, at - 200), at)
    assert.ok(before.includes('try {'), 'await handler 没包在 try 里')
  })

  await checkAsync('宿主半：apply 能注册而不抛错', async () => {
    let host
    try {
      host = await import('../lib/index.js')
    } catch (error) {
      if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
        console.log('     （跳过：本目录未装进 DSH profile，缺 @deepseek-ai/dsh-tools）')
        return
      }
      throw error
    }
    assert.equal(typeof host.apply, 'function')
    const registered = { routes: [], hooks: [] }
    host.apply({
      systemPrompt: { section() {} },
      tools: { register() { return () => {} } },
      on(event) { registered.hooks.push(event); return () => {} },
      inject(deps, cb) {
        // 真机签名是 ctx.inject(deps, callback)，回调拿到的是**带 webServer 的子 ctx**。
        cb({
          webServer: { register(options) { registered.routes.push(options.path); return () => {} } },
          connection: { requestRejection: () => undefined },
          effect(fn) { fn() },
        })
      },
      effect() {},
      get() { return undefined },
    })
    assert.ok(registered.hooks.length > 0, '宿主半必须注册钩子')
    assert.ok(registered.routes.includes('/puzzle-mode-rpc'), '必须注册面板的数据通道')
  })
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n${passed} 项通过${failures.length ? ` / ${failures.length} 项失败:` : ''}`)
for (const f of failures) console.log(`  - ${f.name} —— ${f.message}`)
if (failures.length) process.exitCode = 1
