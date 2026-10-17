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
     * **澄清器不许把文档活写进执行交代**（v2.4.20 真机 bug）。
     *
     * 真机证据：卡 `task-0001` 的第 7 步写着「回写拼图文档（走 puzzle_mode）」，
     * 而 v2.4.15 起执行会话**没有** `puzzle_mode`——那一步必然撞文档锁。
     *
     * 根因不在执行侧，在澄清侧：它自己的系统提示说「你的结论要落回文档」，
     * 却没被告知「执行会话写不了文档」，于是把回写当成执行交代的一部分。
     * 所以这条钉的是**澄清器的两份提示词都得说清分工**。
     */
    check('澄清器：必须说清「执行会话写不了文档」，别把回写写进执行交代', () => {
      const sys = barrel.CLARIFIER_SYSTEM
      assert.ok(sys.includes('执行会话不能写文档'), '系统提示必须点明执行会话没有文档工具')
      assert.ok(sys.includes('全局大脑'), '必须说清文档由全局大脑回写')
      const body = barrel.clarifierPromptOf({ request: 'REQ_SENTINEL', hasWriter: true })
      assert.ok(body.includes('不要') && body.includes('回写拼图文档'), '首轮消息必须警告不许写回写步骤')
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

  /* ---------- ⑨ 动效（v2.4.17） ---------- */
  /**
   * ## 为什么动效也要进冒烟
   *
   * 动效最容易「静默失效」：类名拼错、CSS 规则被覆盖、行内样式压掉过渡、
   * `transform` 被两条规则争用——**这些全都不报错**，页面照常能用，
   * 只是那一处动画从来没播过。本仓在 `flipList` 上就踩过一次：
   * 行内 `transition:none` 把类里的过渡整个压掉，**FLIP 从加进来那天起
   * 一次都没播过**，而它退化得极其安静（行还是会移动，只是没有过程）。
   *
   * 所以下面每条都钉「只可能由正确实现产生」的量：
   *   - 过渡必须写在**类**里（行内会被覆盖）；
   *   - 「不要过渡」必须是**类**而不是行内 `transition`；
   *   - 方向必须**由导航意图给出**，不由目标页推；
   *   - 数字爬升的每个中间值都必须在真实区间内（读数不能中途说谎）。
   */
  check('动效：FLIP 的过渡写在类里，且「本帧不过渡」用类而不是行内样式', () => {
    const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
    /**
     * ① 过渡必须在类里。行内 `transition` 会**永久**留在元素上（没人清它），
     * 于是把类里的过渡压掉——那就是 FLIP 从未播放的根因。
     */
    assert.ok(
      /\.dshpz-flip\{transition:transform var\(--dshpz-dur-slow\)/.test(src),
      '.dshpz-flip 必须用令牌给 transition（过渡要在类里，不能在行内）',
    )
    assert.ok(
      /\.dshpz-cardtravel\{[^}]*transition:transform var\(--dshpz-dur-slow\)/.test(src),
      '.dshpz-cardtravel 必须用令牌给 transition',
    )
    /**
     * ② 「本帧不要过渡」必须是**类**。用行内 `transition:none` 会一直留着，
     * 把后面挂的类过渡压掉——这是那条真 bug 的形状。
     */
    assert.ok(
      /\.dshpz-move-off\{transition:none!important\}/.test(src),
      '必须有 .dshpz-move-off 这个「本帧不过渡」的类（行内 transition 会压掉类过渡）',
    )
    /**
     * ③ 反向断言：`flipList` 与 `travelCard` 里**不许**再出现
     * `style.transition = 'none'`。这条是负控——把 bug 写回去就必须红。
     *
     * ⚠️ 必须先**剥掉注释**再查：本次修复的注释里**引用了**那行旧代码
     * （「原先写的是 `node.style.transition = 'none'`」），不剥的话
     * 这条负控会因为它自己的说明文字而红——那是假警报。
     * 剥注释的写法：按行去掉 `//` 之后的部分与整行 `*` 注释。
     */
    const codeOnly = src
      .split('\n')
      .filter((line) => !/^\s*\*/.test(line) && !/^\s*\/\*/.test(line))
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
    const badInline = codeOnly.match(/\.style\.transition\s*=\s*['"]none['"]/g)
    assert.equal(
      badInline, null,
      '不能用行内 transition:none 来「本帧不过渡」：行内优先级高于类，会把类里的过渡压掉（FLIP 从未播放的根因）',
    )
    /**
     * ④ `dshpz-move-off` 必须在两个 FLIP 实现里都被**真的用上**。
     * 光有这条 CSS 而没人挂它，等于什么都没修。
     */
    assert.ok(
      (src.match(/classList\.add\('dshpz-move-off'\)/g) || []).length >= 2,
      'flipList 与 travelCard 都必须真的挂 .dshpz-move-off（两个 FLIP 实现）',
    )
  })

  check('动效：换页方向由导航意图给出，同一目标页可以是前进也可以是后退', () => {
    const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
    /**
     * `switchToView` 里必须**按三页的排列顺序**算方向（项目 → 主题 → 更新）。
     *
     * 为什么要钉这个：如果改成「按目标页推方向」（比如 `theme` 就前进、
     * `projects` 就后退），那么「主题 → 项目」与「更新 → 项目」都对了，
     * 但「项目 → 主题」与「项目 → 更新」也对了……看起来都对。
     * 真正会错的是**同页重复点击**与**二级页进入**——而那些恰恰是
     * 用户最容易觉得「怪但说不清」的地方。所以判据必须是**位置差**。
     */
    assert.ok(
      /var ORDER = \['projects', 'theme', 'update'\]/.test(src),
      'switchToView 必须按三页排列顺序算方向（位置差），不能按目标页硬编码',
    )
    assert.ok(
      /dir = to > from \? 1 : -1/.test(src),
      '方向必须由「目标位置 > 当前位置」得出',
    )
    /**
     * 方向为 0（同页）时**不能** +1 序号：那会让页面无故重建、闪一下，
     * 而用户其实什么都没做。
     */
    assert.ok(
      /if \(dir !== 0\) patch\.navSeq = \(state\.navSeq \|\| 0\) \+ 1/.test(src),
      '同一页重复点击不该 +1 导航序号（否则会无故重播转场）',
    )
    /**
     * 「返回」类入口必须显式给 `navDir: -1`：它们是后退语义，
     * 而 `switchToView` 算不出来（那个函数管的是三页之间的左右关系）。
     * 至少要有：主题页返回、更新页返回、Esc 回退、二级页返回。
     */
    const backSites = src.match(/navDir: -1/g) || []
    assert.ok(
      backSites.length >= 4,
      '「返回」类入口（主题页 / 更新页 / Esc / 二级页）都必须显式给 navDir:-1，实际只有 ' + backSites.length + ' 处',
    )
    /**
     * 进二级页 = 前进（往右走）。
     */
    assert.ok(
      /view: 'project',\s*\n\s*tab: state\.tab \|\| 'info'/.test(src) && src.includes('navDir: 1'),
      '进二级页必须给 navDir:1（往右走）',
    )
  })

  /* ---------- ⑩ 换页锁必须能解开（v2.4.18 修「面板点不了」） ---------- */
  /**
   * ## 为什么这条必须进冒烟：它是一条**永久锁死面板**的规则
   *
   * `data-nav` 非 0 时 CSS 会给整页 `pointer-events:none`（换页那 200ms 锁点击，
   * 防止点错相邻按钮）。而第一版**从来没有把 `navDir` 复位过**——
   * 它只在导航时被设成 ±1，此后一直是 ±1。
   *
   * 结果：打开面板还能点（那时是初始的 0），**一旦切过页，整个面板就再也
   * 点不动了**——看得见、一个按钮都点不了、不报任何错。
   *
   * ## 为什么原有测试全绿却没抓到
   *
   * 上面那条「换页方向」的测试只断言**导航时必须给 navDir**（钉了「写」），
   * 没断言**它必须被复位**（没钉「清」）。一个状态有「进入」没有「退出」时，
   * 只看进入的断言必然全绿。这类漏网很典型，所以补下面三条。
   */
  check('动效：换页锁（pointer-events）必须能被解开，否则整个面板永久点不了', () => {
    const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

    /**
     * ① 前置事实：CSS 里确实有一条「data-nav 非 0 就锁点击」的规则。
     *
     * 先钉住这个前提——如果哪天那条 CSS 被删了，下面两条「必须复位」的
     * 断言就失去了意义（而测试会继续假装在保护什么）。
     */
    assert.ok(
      /\.dshpz-page\[data-nav="1"\],\.dshpz-page\[data-nav="-1"\]\{pointer-events:none\}/.test(src),
      '前提变了：CSS 里「换页锁点击」那条规则不见了。若是有意删除，这条测试要一起改',
    )

    /**
     * ② 必须有**复位**：`onAnimationEnd` 里把 `navDir` 设回 0。
     *
     * 这是根治：状态回到 0，CSS 自然不再命中。
     */
    assert.ok(
      /onAnimationEnd: function \(\) \{\s*\n\s*if \(state\.navDir !== 0\) setState\(\{ navDir: 0 \}\)/.test(src),
      '换页容器必须有 onAnimationEnd 把 navDir 复位成 0（否则 pointer-events:none 永久生效，面板点不了）',
    )

    /**
     * ③ 必须有**兜底定时器**：`animationend` 不保证会来。
     *
     * 至少两种情况：减少动效（CSS 把动画整个关掉 → 没有结束事件）、
     * 老 WebView（动画被丢弃）。少了兜底，开着「减少动态效果」的用户
     * 一进面板就废了。
     */
    assert.ok(
      /if \(state\.navDir === 0\) return undefined[\s\S]{0,400}?setTimeout\(function \(\) \{[\s\S]{0,160}?navDir: 0/.test(src),
      '必须有定时器兜底复位 navDir（减少动效下 animationend 不会来，没有兜底就永久锁死）',
    )

    /**
     * ④ **负控**：`navDir` 在导航里被设成 ±1 的地方，必须都能被上面两条
     * 复位路径覆盖。判据是「没有任何地方把 navDir 设成非 0 之后不依赖复位」
     * ——这里用一条更硬的检查：`navDir: 0` 必须至少出现在两处
     * （state 初值 + 复位点），否则说明复位被删了。
     */
    const resets = src.match(/navDir: 0/g) || []
    assert.ok(
      resets.length >= 3,
      'navDir 复位点太少（' + resets.length + ' 处）：初值 + onAnimationEnd + 兜底定时器，至少三处',
    )
  })

  /* ---------- ⑪ 过期的安装记录不能冒充「刚刚失败」（v2.4.19） ---------- */
  /**
   * ## 为什么这条必须进冒烟：它让用户以为插件「发癫」
   *
   * 真机现象：更新页顶部红条写着「更新失败，**已自动回退**到 v1.1.2」，
   * 下面又写着「已经是最近版本 v2.4.18」——两句自相矛盾。
   *
   * 查下来：那条红条来自 `last-run.json` 里**8 天前**一次失败的记录
   * （v1.1.3 安装时 codeload 下载超时）。面板渲染时只判 `stage !== ''`，
   * **完全不看这条记录有多旧**，于是一条历史失败永远挂在那里冒充「刚刚」。
   *
   * 这条钉两件事：
   *   ① `runIsCurrent` 真的按时间窗判新鲜度（而且缺失/坏值算新鲜，
   *      **绝不因为字段问题藏掉一次真实失败**）；
   *   ② 渲染处必须**用它**——不然判据写了也白写。
   */
  check('更新页：过期的安装记录必须降级成历史说明，不能冒充「刚刚失败」', () => {
    const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
    let bundle = null
    new Function('window', 'document', 'fetch', src)(
      {
        __ModuleLoader__: { load(d) { bundle = d } },
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        addEventListener() {}, removeEventListener() {}, confirm: () => false, setTimeout, clearTimeout,
        innerWidth: 1200, innerHeight: 800,
      },
      { createElement: () => ({ setAttribute() {}, textContent: '', style: {} }), head: { appendChild() {} }, body: {} },
      () => Promise.resolve({ json: () => Promise.resolve({ ok: true, result: {} }) }),
    )
    const ui = bundle.factory((n) => {
      if (n === 'react') return { createElement: () => null, useState: (v) => [v, () => {}], useEffect() {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }), useCallback: (f) => f, Fragment: 'f' }
      throw new Error('unexpected require: ' + n)
    })
    assert.equal(typeof ui.runIsCurrent, 'function', 'runIsCurrent 必须导出（便于直接驱动）')
    assert.equal(typeof ui.staleRunNotice, 'function', 'staleRunNotice 必须导出')

    const now = Date.now()
    const hoursAgo = (h) => new Date(now - h * 3600 * 1000).toISOString()

    // ① 刚结束的（1 小时前）：算当前。
    assert.equal(ui.runIsCurrent({ stage: 'install', ok: false, finishedAt: hoursAgo(1) }), true, '1 小时前的记录算当前')
    // ② 8 天前（正是真机上那条）：**不算**当前。
    assert.equal(ui.runIsCurrent({ stage: 'install', ok: false, finishedAt: hoursAgo(8 * 24) }), false, '8 天前的记录不能算当前')
    // ③ 边界：23 小时算、25 小时不算。
    assert.equal(ui.runIsCurrent({ finishedAt: hoursAgo(23) }), true, '23 小时前算当前')
    assert.equal(ui.runIsCurrent({ finishedAt: hoursAgo(25) }), false, '25 小时前不算当前')
    /**
     * ④ **缺失 / 坏值算新鲜**——这是刻意的保守方向。
     *
     * 老版本安装器写的记录里没有 `finishedAt`。若把「没有字段」判成过期，
     * 一次**真实的失败**就会被藏掉；而藏掉失败比多显示一次失败危险得多。
     */
    assert.equal(ui.runIsCurrent({ stage: 'install', ok: false }), true, '没有 finishedAt 时必须算新鲜（不能藏掉真实失败）')
    assert.equal(ui.runIsCurrent({ finishedAt: '不是时间' }), true, 'finishedAt 解析不出来时算新鲜')
    // ⑤ 时钟错乱（未来时间）也算新鲜。
    assert.equal(ui.runIsCurrent({ finishedAt: hoursAgo(-5) }), true, '未来时间算新鲜（不因时钟问题藏掉失败）')
    // ⑥ 正在跑的一律算当前。
    assert.equal(ui.runIsCurrent({ running: true }), true, 'running 一律算当前')

    /**
     * ⑦ 过期说明必须是**过去时**，且不能再说「已自动回退」。
     *
     * 「已自动回退」是现在时陈述——用户读到会以为**现在**处于回退状态。
     * 过期记录应该说「那次更新失败，插件已回退到原版本（当前不受影响）」。
     */
    const stale = ui.staleRunNotice({
      stage: 'install', ok: false, rolledBack: true, error: 'pnpm add 退出码 1',
      beforeVersion: '1.1.2', finishedAt: hoursAgo(8 * 24),
    })
    assert.ok(typeof stale === 'string' && stale !== '', '过期记录必须给一句说明（不能静默丢弃）')
    assert.ok(stale.includes('那次'), '过期说明必须是过去时（「那次更新失败」）')
    assert.ok(stale.includes('当前不受影响'), '必须明确告诉用户当前状态是好的')
    assert.ok(!/已自动回退/.test(stale), '过期说明不能再用现在时的「已自动回退」（会让用户以为现在还坏着）')
    assert.ok(stale.includes('pnpm add'), '必须带上原始失败原因（那是用户想知道的信息）')

    /**
     * ⑧ 渲染处必须**真的用了** `runIsCurrent`。
     *
     * 判据函数写对了但渲染不调用，等于没修。这条是负控：
     * 把 `runCurrent &&` 摘掉就会红。
     */
    assert.ok(
      /var runCurrent = runIsCurrent\(run\)/.test(src),
      '渲染处必须先算 runCurrent（不能只判 stage）',
    )
    assert.ok(
      /if \(runCurrent && run !== null[\s\S]{0,120}?run\.stage !== 'dry-run'\)/.test(src),
      '「本次结果」分支必须由 runCurrent 门控（否则过期记录会冒充刚刚失败）',
    )
    assert.ok(
      /staleRunNotice\(run\)/.test(src),
      '过期记录必须走 staleRunNotice（降级成历史说明，而不是删掉）',
    )
  })

  check('动效：卡片跨列飞行量的是「旧位置减新位置」，且量不到起点不编假动画', () => {
    const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
    /**
     * 差值方向必须反着加：`from.left - box.left`。
     *
     * 这条**只可能由正确实现产生**：反了（`box.left - from.left`）会让卡
     * 从更远的地方飞过来——错得很明显（会飞出看板），但它不报错，
     * 只在真机上看得出。所以用源码断言钉住方向。
     */
    assert.ok(
      /var dx = Number\(from\.left\) - box\.left/.test(src),
      '飞行差值必须是「旧位置 - 新位置」（反了会让卡从错误方向飞过来）',
    )
    assert.ok(
      /var dy = Number\(from\.top\) - box\.top/.test(src),
      '纵向也要算：窄屏只有一列，换列表现为纵向位移',
    )
    /**
     * 量不到起点时必须**不播**（返回 false），由 CSS 兜底成淡入。
     * 编一个假起点（比如视口中心）比不做动画更糟。
     */
    assert.ok(
      /if \(from === null \|\| from === undefined\) return false/.test(src),
      '量不到起点必须降级（不能编假起点）',
    )
    /**
     * 起点必须在**发请求之前**量：回包一到，卡已经在新列里了。
     */
    const moveAt = src.indexOf('function moveCard(')
    const measureAt = src.indexOf('var flyFrom = null', moveAt)
    const postAt = src.indexOf("post({ method: 'task', action: 'move'", moveAt)
    assert.ok(
      measureAt > moveAt && postAt > measureAt,
      '飞行起点必须在发搬卡请求**之前**量（回包后旧位置已经不存在了）',
    )
    /**
     * 有起点时**不能**再挂 `dshpz-cardfly`：那个兜底淡入会叠在飞行的位移上，
     * 卡会一边飞一边半透明。
     *
     * 断言写成「`dshpz-cardfly` 的出现**必须**由 `flyFrom` 为空来门控」——
     * 而不是钉死整行的字符（那样改个括号就会误红）。
     */
    const fallbackLine = src.split('\n').find((line) => line.includes("' dshpz-cardfly'"))
    assert.ok(fallbackLine !== undefined, '必须保留「量不到起点」时的兜底淡入类')
    assert.ok(
      fallbackLine.includes('flyFrom === null') && fallbackLine.includes('flyFrom === undefined'),
      '兜底淡入类必须由 flyFrom 为空门控（有起点时交给 travelCard，否则两者叠加）',
    )
  })

  check('动效：数字爬升的每个中间值都在真实区间内（读数不能中途说谎）', () => {
    const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
    let bundle = null
    new Function('window', 'document', 'fetch', src)(
      {
        __ModuleLoader__: { load(d) { bundle = d } },
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        addEventListener() {}, removeEventListener() {}, confirm: () => false, setTimeout, clearTimeout,
      },
      { createElement: () => ({ setAttribute() {}, textContent: '', style: {} }), head: { appendChild() {} }, body: {} },
      () => Promise.resolve({ json: () => Promise.resolve({ ok: true, result: {} }) }),
    )
    const ui = bundle.factory((n) => {
      if (n === 'react') return { createElement: () => null, useState: (v) => [v, () => {}], useEffect() {}, useMemo: (f) => f(), useRef: (v) => ({ current: v }), useCallback: (f) => f, Fragment: 'f' }
      throw new Error('unexpected require: ' + n)
    })
    assert.equal(typeof ui.countUpValue, 'function', '数字爬升的插值必须是可驱动的纯函数')

    /**
     * ① 端点：t=0 给起始值、t=1 给目标值。
     */
    assert.equal(ui.countUpValue(62, 78, 0), 62, 't=0 必须显示起始值')
    assert.equal(ui.countUpValue(62, 78, 1), 78, 't=1 必须显示目标值')
    /**
     * ② **每一个中间值都必须在 [62, 78] 内**。
     *
     * 这是这条测试的核心：爬升的读数是业务值，中途出现 80 或 61 就是
     * 「读数说了谎」——而它不会报错，用户只会觉得「这个数字怪怪的」。
     * 逐点扫 0→1，越界立即失败。
     */
    for (let i = 0; i <= 100; i += 1) {
      const v = ui.countUpValue(62, 78, i / 100)
      assert.ok(v >= 62 && v <= 78, `t=${i / 100} 时读到 ${v}，超出 [62,78]（读数不能越界）`)
      assert.equal(Number.isInteger(v), true, `t=${i / 100} 时读到 ${v}，必须是整数（半成品读数不可读）`)
    }
    /**
     * ③ 单调不减：往上爬的过程里不能回头。
     */
    let prev = ui.countUpValue(62, 78, 0)
    for (let i = 1; i <= 100; i += 1) {
      const v = ui.countUpValue(62, 78, i / 100)
      assert.ok(v >= prev, `t=${i / 100} 时读到 ${v} < 上一个值 ${prev}：爬升不能回头`)
      prev = v
    }
    /**
     * ④ 下降也对称（健康性会掉）。
     */
    assert.equal(ui.countUpValue(78, 62, 0), 78, '下降时 t=0 也要显示起始值')
    assert.equal(ui.countUpValue(78, 62, 1), 62, '下降时 t=1 要显示目标值')
    for (let i = 0; i <= 100; i += 1) {
      const v = ui.countUpValue(78, 62, i / 100)
      assert.ok(v >= 62 && v <= 78, `下降 t=${i / 100} 时读到 ${v}，超出 [62,78]`)
    }
    /**
     * ⑤ `from === null`（首帧）直接给目标值：**首帧不爬**。
     *
     * 打开面板时从 0 爬到 62 是在演「它在增长」，而事实是这个数字一直都在
     * ——那是伪造过程。
     */
    assert.equal(ui.countUpValue(null, 62, 0.3), 62, '首帧（没有起始值）必须直接给目标值，不能从 0 爬')
    /**
     * ⑥ 越界输入被夹紧：宿主万一给了 -5 或 120，读数不能显示成那样。
     */
    assert.equal(ui.countUpValue(0, 120, 1), 100, '目标值必须夹在 0–100')
    assert.equal(ui.countUpValue(0, -5, 1), 0, '负目标值必须夹到 0')
  })

  check('动效：减少动效时 JS 动效一律直接落位（CSS 媒体查询管不到它们）', () => {
    const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
    /**
     * 三处 JS 动效（列表 FLIP / 卡跨列飞行 / 列落定脉冲）都必须先问 `motionOn()`。
     *
     * 为什么这条必须钉：CSS 的 `prefers-reduced-motion` 只作用于**样式表里的
     * 动画与过渡**，而这三处是 JS 直接写 `transform` / 加类——
     * 媒体查询对它们**完全无效**。漏一处就是「开了减少动效的用户仍被动效晃」。
     */
    const flipAt = src.indexOf('function flipList(')
    assert.ok(
      src.slice(flipAt, flipAt + 900).includes('!motionOn()'),
      'flipList 必须先问 motionOn()（减少动效直接落位）',
    )
    const travelAt = src.indexOf('function travelCard(')
    assert.ok(
      src.slice(travelAt, travelAt + 1200).includes('if (motionOn()) return false'),
      'travelCard 必须先问 motionOn()',
    )
    const landAt = src.indexOf('function landColumn(')
    assert.ok(
      src.slice(landAt, landAt + 600).includes('if (motionOn()) return false'),
      'landColumn 必须先问 motionOn()',
    )
    /**
     * 数字爬升同理（它由 rAF 逐帧写文本）。
     */
    const heroAt = src.indexOf('function HeroRing(')
    assert.ok(
      src.slice(heroAt, heroAt + 3000).includes('if (motionOn())'),
      '数字爬升必须先问 motionOn()（减少动效直接落定）',
    )
    /**
     * 拖拽时的微摇动由 `ghostGrab` 的第三个参数控制，那个参数必须来自 `motionOn()`。
     * （这条是既有纪律，本次升级新增了「抬起」但没改摇动的判据，一并钉住。）
     */
    assert.ok(
      /ghostGrab\([^)]*!motionOn\(\)\)/.test(src),
      '微摇动必须由 motionOn() 决定（那张卡不在 .dshpz-scope 子树里，通配规则罩不到）',
    )
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
