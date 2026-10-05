/**
 * dsh-puzzle-mode —— 浏览器半。
 *
 * 两个 Slot，共用一个模块级 store：
 *   1) conversation.input.left  —— 模型选择器左边的小按钮（拼图图标 + 健康性角标）
 *   2) shell.overlay           —— 点按钮弹出的拼图面板
 *
 * 面板里有这些：
 *   - 项目路径 / 项目健康性进度条 / 五维块 / 模块图块；
 *   - **图块可点开**：读该模块文档的要点、相关决策、详细记录（宿主 `method:'module'`）；
 *   - **让 AI 动手**：每颗按钮把对应提示词填进输入框（`inputActions.setDraft`），
 *     **不自动发送**——空态有「照现有项目搭文档 / 快速建空壳 / 采访后再建」，
 *     已绑定态有「新增模块文档 / 接续会话 / 审查 / 工作流模板 / 迁移重构」；
 *   - 模式切换（只拼不写 / 写后再拼 / 边拼边写）与多项目切换。
 *
 * 注：曾经有「提问模板」按钮（一键填带固定收尾问的提问），已按用户裁定删除；
 * `askAi` 现在**必须**收到模板函数，不再有「不给就走提问模板」的兜底。
 *
 * 数据来自宿主半的 `/puzzle-mode-rpc`（同源相对路径）：bundle 客户端没有动态插件的
 * `host.call`，所以走 webServer 路由——与 dsh-session-health 的 `/session-health-rpc` 同一模式。
 *
 * 本文件是**手写的 module-loader 包**（不经过任何打包器）：
 * `window.__ModuleLoader__.load({ id, factory })`，factory 内用 `require('react')`。
 */
window.__ModuleLoader__.load({
  id: 'dsh-puzzle-mode',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var h = React.createElement
    var RPC = '/puzzle-mode-rpc'
    var POLL_MS = 8000
    var PAUSE_QUESTION = '要不要先停下？'
    var PAUSE_OPTIONS = ['停下，等我看过再说', '继续，不用停']

    /**
     * 面板提示词模板要用的上限——**首次数据到达前的兜底**，值必须与宿主
     * `constants.js` 的 `PANEL_LIMITS` 逐字段相等（契约测试钉住）。
     *
     * 为什么这里还要有一份（v0.20.5 修的真实脱节）：本文件是**手写的 module-loader 包**
     * （见文件头），factory 内只有 `require('react')`，拿不到 `lib/` 的 ESM 导出。
     * 原先的做法是**在 9 个模板里各抄一遍数字**（`var ASK_MAX_QUESTIONS = 10`、
     * 正文里的「坑 20 字 / ≤4 条 / 最多 12 步、每步 ≤80 字」）——改宿主上限时模板不跟随，
     * 于是**提示词把过期数字交给模型，模型照写，写入被拒**。
     *
     * 现在改成：宿主每次 `state` / `op:read` 都下发 `limits`，模板一律读它；
     * 这个兜底只在「第一次数据还没到」时用得上（面板那时也还没画出模板按钮）。
     * 想改上限 → 只改 `constants.js`；漏改了这里，契约测试会红。
     */
    var FALLBACK_LIMITS = {
      askQuestions: 10,
      askOptions: 10,
      entryLimits: { index: 50, source: 50, tools: 50, pit: 20, workflow: 50, points: 20, pending: 20, decided: 20, reuse: 20, detail: 50 },
      entryCaps: { pending: 4, decided: 10, workflow: 5 },
      workflowNameLimit: 20,
      workflowStepLimit: 80,
      workflowMaxSteps: 12,
      bindingWarnThreshold: 8,
      // 三档条数上限：兜底也要有，否则首次数据到达前面板会把「小/中/大」显示成 undefined。
      // 与宿主 `PANEL_LIMITS.sizeCaps` 逐字段相等，由契约测试钉住。
      sizeCaps: {
        '小': { pending: 4, decided: 6, workflow: 3, pit: 10 },
        '中': { pending: 4, decided: 10, workflow: 5, pit: null },
        // 大档的 pit 也是 `null`（不限）——与宿主 `SIZE_CAPS` 同步。
        // 它曾经是 60，而中档不限，于是**切到大档反而收紧**（实测写 70 条被砍到 60）。
        // 契约测试「逐字段相等」就是钉这件事的：漏改这一份会红。
        '大': { pending: 12, decided: 30, workflow: 12, pit: null },
      },
      sizes: ['小', '中', '大'],
    }

    /**
     * 当前生效的上限：优先用宿主下发的 `data.limits`，缺字段时逐项退回兜底。
     *
     * **逐项**合并而不是整体替换：宿主将来多下发一个字段、或某个版本漏发一个，
     * 都不该让整份上限变成 `undefined`（那会让模板打印出 `undefined 字`）。
     */
    function limitsOf(data) {
      var src = data && typeof data === 'object' && data.limits && typeof data.limits === 'object' ? data.limits : null
      if (src === null) return FALLBACK_LIMITS
      var out = {}
      for (var key of Object.keys(FALLBACK_LIMITS)) {
        var value = src[key]
        out[key] = value === undefined || value === null ? FALLBACK_LIMITS[key] : value
      }
      return out
    }

    /**
     * 三种执行模式的一句话说明（面板按钮悬停与下方说明共用）。
     *
     * 为什么要在 UI 里写清楚：`边拼边写` 这个名字在 v5 **换了含义**——
     * 旧含义（一轮做完才问）现在叫 `写后再拼`。只说「AI 可以执行」等于什么都没说，
     * 用户会按旧印象选错模式。
     */
    var MODE_HINTS = {
      '只拼不写': 'AI 只提问 + 更新文档，越权工具会被宿主拦下。',
      '写后再拼': 'AI 先把这一轮改完，再一起汇报与提问（旧名「边拼边写」）。',
      '边拼边写': 'AI 每个写动作之前先问：说清改哪个文件、改成什么，你点头才动手。',
    }

    /**
     * 接续会话模板：**直接接上一个会话没干完的活**。
     *
     * 口径由用户三次裁定定下来（v0.21.0 / v0.24.1）：
     *   1. 「直接让其接上一个会话干的活就行」——重心从「怎么读文档」挪到「接着干」；
     *   2. 「不是有什么看审查的段吗，把那个删掉」——去掉要求它汇报「最弱的一维」。
     *      为什么该删：接续会话的读者是**干活的人**，不是评审。让它先报五维最弱项，
     *      等于把「继续做」变成「先做一轮评估」，离题且费上下文。
     *   3. 「把接续会话里的分析代码删了吧，这种事交给专门的审查就行了」——去掉
     *      「结合代码与文档的当前状态判断进度」。同一条理由的延伸：**自己翻代码推进度**
     *      也是「先做一轮评估」，而且比报分数更贵——它要真的把源码读进来。
     *      进度该由 `op:audit` 的客观发现给（那是专门的审查），接续只管**接着干**。
     *      实测代价：这一段会让模型一上手就全仓翻代码，用户看得烦，轮数也白烧。
     *
     * 保留「按需读、不通读」与「按源码索引跳、不要全仓搜」：前者省上下文，
     * 后者是**防乱翻的护栏**——删了它反而更容易满仓找。
     * 文档全量读一遍是几千字（本项目实测 8888 字符），
     * 而本轮真正用得到的通常只有一两个模块。这是**手段**（省钱省上下文），
     * 不是目的——目的仍是「接着干」。
     *
     * 多绑定时把**全部绑定**列进提示词（用户裁定 ②）：接续会话是全局动作，
     * 模型得知道除了当前这个还绑着谁，否则会漏掉该一起接上的项目。
     */
    function resumeTemplate(projectName, projectDir, projectRoot, lim, boundNames) {
      var bound = Array.isArray(boundNames) ? boundNames.filter(function (n) { return typeof n === 'string' && n !== '' }) : []
      var lines = [
        '【' + (projectName || '拼图') + ' · 接续会话】',
        '**接着上一个会话没干完的活继续干**——先搞清「干到哪了」，再直接往下做，不要重新问我需求。',
        '',
        '怎么搞清「干到哪了」：',
        '1. puzzle_mode{op:"read", brief:true}：精简档，只有项目名、模式、健康性、模块清单',
        '   与「下一步该读什么」的指路（本项目实测 2916 → 1105 字符，省 62%）。',
        '2. 只读主文档' + (projectDir ? '：' + projectDir + '/主文档.md' : '（projectDir 下的 主文档.md）'),
        '   —— 它只有五节：模块索引 / 源码索引 / 工具索引 / 坑 / 工作流，是**查找入口**。',
        '   重点看「## 工作流」（这个项目自己定的流程）与「## 坑」。',
        '3. 按主文档指的方向，**只读相关的那一两个模块文档**；不确定读哪个就先问我。',
        '4. 需要看实现时，按主文档的「源码索引」直接跳到源码，不要全仓搜。',
        '5. 从文档里读到的断点直接接着做——**不要从头重做已经做完的部分**。',
      ]
      if (bound.length > 1) {
        lines.push(
          '',
          '⚠️ 本会话同时绑了 ' + bound.length + ' 个项目：' + bound.join(' / ') + '。',
          '接续是**全局动作**：上面这些项目各自都可能有没干完的活，',
          '逐个接上，别只接当前项目（' + (projectName || '当前项目') + '）那一个。',
        )
      }
      lines.push(
        '',
        '回报用两三句说清：接着要做什么、从哪个文件哪一步开始。',
      )
      return lines.join('\n')
    }

    /**
     * 审查模板：让模型拿 `op:audit` 的**真实值**，再改分数。
     *
     * 关键点：审查不只是评论——它要**把虚高的分改成真实值**，并真的去拆代码。
     * 真实值由插件算（文档证据 + 源码体检），模型不许自己拍。
     */
    function auditTemplate(projectName, projectDir) {
      return [
        '【' + (projectName || '拼图') + ' · 审查（含真实值）】',
        '调 puzzle_mode 的 op:audit 拿客观事实（含五维真实值），然后：',
        '',
        '1. 先看 `inflation` 数组——那是「你之前自评的分」与「真实值」的差额：',
        '   - 逐条用 op:health 带 name 与 append:false，把该模块五维改成 trueValue；',
        '   - 不许反过来改文档凑证据。分数是结论，不是目标。',
        '2. 再看 `source`（源码体检）：文件行数、最长函数、目录分层。',
        '   - 单文件 >800 行要拆，>2000 行必须先拆；巨函数（>60 行）按步骤拆；',
        '   - 「一个文件装下整个项目」先切成 4-8 个文件；',
        '   - 这些**改分数解决不了**，必须真的动代码。拆完再跑一次 op:audit 复核。',
        '3. 最后按五维写点评：最弱一维落在哪个模块、缺哪条证据、下一步动什么。',
        '   - 每条带数字或文档事实；不要「整体不错、建议持续完善」这类空话。',
        '',
        '注意：`fromSource` 是 null 的维度表示**没有源码可查**，那一维不是实测值，要如实说。',
      ].join('\n')
    }

    /**
     * 迁移/重构模板：**全量清理**，不留手。
     *
     * 与 `op:rebuild` 的分工：rebuild 只改**形状**（front-matter、小节存在性），
     * 不动正文；这里要求模型按最新规格把**正文也重写一遍**——旧条目超长、没出处、
     * 条数超限，rebuild 一律不管（它刻意不追溯老条目）。两件事都得做。
     *
     * ⚠️ **`## 工作流` 必须单独说**（v0.20.5 修的真实缺陷）：它**不是**条目式小节，
     * 内容也不是「一句话条目」而是流水线块（`### 名字` + 有序步骤）。原先这里只写
     * 「每条必须带（源码: 文件:行）」——模型于是给工作流步骤**编行号**（同一段里还写着
     * 「不许编行号」），并按「其余主文档条目 50 字」把**合法**步骤砍到 50 以内
     * （步骤的真实上限是 `workflowStepLimit`）。这是 v0.20.2 那个假发现的**镜像**：
     * 那次是插件拿 50 的尺子量 80 的步骤，这次是**提示词让模型自己砍**。
     */
    function refactorTemplate(projectName, projectDir, projectRoot, lim) {
      var L = lim || FALLBACK_LIMITS
      return [
        '【' + (projectName || '拼图') + ' · 迁移/重构】',
        '把当前项目的拼图文档**全量清理并重构到最新规格**，不得留手，绝对服从规格：',
        '1. 先 op:rebuild 看预览 → apply:true 落盘（这一步只改形状：收敛成五节、补小节、拆 悬而未决/已定、删已取消的小节）。',
        '2. 再 op:audit，把返回的 findings **逐条清零**——尤其是 entry_issue / main_entry_issue 这两类。',
        '3. 逐节重写正文，旧内容不保留原样：',
        '   - 主文档五节：模块索引 / 源码索引 / 工具索引 / 坑 / 工作流；**除这五节外不许有任何内容**。',
        '   - **条目式**小节（模块索引 / 源码索引 / 工具索引 / 坑）每条一句话，超长就砍到上限内：'
          + '坑 ' + L.entryLimits.pit + ' 字、其余 ' + L.entryLimits.index + ' 字；',
        '     这四节每条**必须带（源码: 文件:行）**——去源码里核实，**不许编行号**。',
        '   - **## 工作流 例外，它不按条目算**：内容是一块块流水线（`### 名字` + 有序步骤），',
        '     **不要求出处**（它约束流程、不对代码事实下断言），所以**不要给它编行号**；',
        '     尺子是「名字 ≤' + L.workflowNameLimit + ' 字 / 每步 ≤' + L.workflowStepLimit
          + ' 字 / 每块 ≤' + L.workflowMaxSteps + ' 步 / 最多 ' + L.entryCaps.workflow + ' 块」；',
        '     合法的长步骤**不要**按条目上限砍。',
        '   - 模块 ## 悬而未决 ≤' + L.entryCaps.pending + ' 条、## 已定 ≤' + L.entryCaps.decided + ' 条：超了删最旧，不论有没有澄清。',
        '   - 模块 ## 要点 ≤' + L.entryLimits.points + ' 字、## 详细记录 ≤' + L.entryLimits.detail + ' 字（详细记录 = 轮汇报）。',
        '4. 旧要点里的长句要**压成一句事实**，不是原样搬过去；搬不动的就删。',
        '5. 重写完再跑一次 op:audit，确认 findings 里不再有 entry_issue / main_entry_issue。',
        '规则冲突时以规格为准；拿不准的删掉而不是留着。',
      ].join('\n')
    }

    /** 快速建空壳：不采访，直接让模型 op:init（项目名会成为工作区里的文件夹名）。 */
    function createTemplate(projectName) {
      return [
        '【' + (projectName || '拼图') + ' · 建项目】',
        '直接调 puzzle_mode 的 op:init 把项目建出来，不要先采访：',
        '- project：<工作区里的文件夹名，请替换成真实项目名>',
        '- modules：<模块名，逗号分隔；每个模块一份文档>',
        '- goal：<一句话目标>',
        '建完把主文档与每个模块文档的路径回报给我；目录固定为 <工作区>/<项目名>/拼图/。',
      ].join('\n')
    }

    /** 采访后再建：先问最多 `lim.askQuestions` 问把目标与模块划分问清，再一次 op:init。 */
    function interviewTemplate(projectName, projectDir, projectRoot, lim) {
      var L = lim || FALLBACK_LIMITS
      return [
        '【' + (projectName || '拼图') + ' · 建项目（先采访）】',
        '先采访再建，不要提前调 op:init：',
        '- 一轮最多 ' + L.askQuestions + ' 问、每题最多 ' + L.askOptions
          + ' 个选项，能用选项就用选项，问的是真正卡住决定的点（目标、模块怎么划、边界在哪）',
        '- **每题给 3–6 个真岔路、每个配一句取舍**，推荐项放第一并加「（推荐）」；'
          + '只说「① 是 ② 否」等于没问——用户看不到代价就没法选',
        '- 找岔路问这五个维度：**做法**（走哪条路）/ **范围**（改多大）/ **时机**（现在做还是先记下）/'
          + ' **代价**（怎么退、多花什么）/ **取舍**（快 vs 稳、通用 vs 专用）',
        '- 拿到回答后用 op:init **一次同时创建主文档与每个模块一份文档**（显式给 project 与 modules）',
        '- 项目名会成为工作区里的文件夹名；目录固定为 <工作区>/<项目名>/拼图/',
        '- op:init 建完会**追加**一个绑定（不是替换）——若返回 rebound:false（项目本来就在、这次没改绑定），'
          + '**必须再调 op:bind 把本会话绑上**，否则面板仍停在空态。',
      ].join('\n')
    }

    /**
     * 新增模块文档：**在「本会话已绑定的项目」里再加一份模块文档**。
     *
     * 与另外两条的分工（三个按钮容易混，所以写清楚）：
     *   - 空态「照现有项目搭文档」（adoptTemplate）：一份文档都没有 → 搭**整套**（op:init + bind + source）；
     *   - 空态「快速建空壳 / 采访后再建」：从零建一个**新项目**；
     *   - 本模板：项目**已经有文档**了，只是再添一个模块（op:module）。
     *     按钮名是「新增模块文档」而不是「新建文档」——后者与空态那条撞过车。
     *
     * 为什么必须连主文档「模块索引」一起写：主文档是**查找入口**，
     * 而 `op:module` 只会把模块名补进 front-matter 的 `计划模块:`（面板图块认它），
     * **不会**自动往 `## 模块索引` 里加一行。少写那一行 = 这份新文档在主文档里查不到，
     * 等于「建了但找不到」。所以模板把这一步显式写进去。
     *
     * 槽位留空（用户裁定）：具体文档名与职责由用户自己填完再发。
     */
    function newDocTemplate(projectName, projectDir, projectRoot, lim) {
      var L = lim || FALLBACK_LIMITS
      return [
        '【' + (projectName || '拼图') + ' · 新增模块文档】',
        '在**当前项目**（不要新建项目、不要用 op:init）里加一份模块文档：',
        '',
        '1. 文档名：<模块名，会成为 模块/<名字>.md>',
        '2. 一句话职责：<这份文档管什么>',
        '3. 初始要点：<已知的结论，一行一条；没有就留空>',
        '',
        '建法：',
        '- 用 puzzle_mode{op:"module", name:"<文档名>", section:"points", content:"- <要点>（源码: 文件:行）"}',
        '  第一次写会自动建出 模块/<文档名>.md（返回 created:true）并补进 front-matter 模块清单；',
        '- 再用 puzzle_mode{op:"main", section:"index", content:"- 模块：<文档名> —— <一句话职责>（源码: 模块/<文档名>.md）"}',
        '  **把这一行写进主文档的「模块索引」**——主文档是查找入口，不写就等于这份文档查不到。',
        '',
        '注意：条目有字数上限（要点 ' + L.entryLimits.points + ' 字 / 详细记录 ' + L.entryLimits.detail
          + ' 字 / 坑 ' + L.entryLimits.pit + ' 字），且每条必须带（源码: 文件:行）；',
        '超限会被拒绝写入，不会截断。',
      ].join('\n')
    }

    /**
     * 照现有项目搭文档：**本会话已经有现成的项目（代码就在工作区里），但一份拼图文档都没有**。
     *
     * 场景（用户原话）：新装插件的人，手上是一堆**老会话**——每个会话都在做真实项目，
     * 却从来没有拼图文档。他们要的不是「新建一个空项目」，而是**照着这个会话已有的东西
     * 把整套文档搭出来**。所以这条模板的落点是空态，且**不采访**：项目已经在那了，
     * 该让模型去读，而不是让用户从零起名。
     *
     * 三个必须写进提示词的点（都是「不问就会踩」的）：
     *   1. **先读再写**：不读工作区就拆模块＝凭空编，文档一出生就是假的；
     *   2. **op:init 已存在时不改绑定**（返回 `rebound:false`）→ 必须补一次 `op:bind`，
     *      否则面板仍然停在空态，看起来像「建失败了」；
     *   3. **源码根**：代码通常在工作区根目录，而默认规则按「拼图目录的上一级」找，
     *      找不到源码 → 源码索引与体检全空。所以必须显式 `op:source` 记一次。
     */
    function adoptTemplate(projectName, projectDir, projectRoot, lim) {
      var root = projectRoot || '<本会话工作区>'
      var L = lim || FALLBACK_LIMITS
      return [
        '【' + (projectName || '<项目名>') + ' · 照现有项目搭拼图文档】',
        '本会话**已经有一个现成的项目**（代码/文件都在工作区里），但**还没有拼图文档**。',
        '请**先读真实内容，再据实搭**——不要采访我，也不要凭空编：',
        '',
        '第 1 步 · 先看再定名（不要跳过）',
        '读本会话工作区：' + root,
        '  - 看目录分层、入口文件、package.json / README、主要源码文件；',
        '  - 据此推导**项目名**（优先 package.json 的 name，其次工作区文件夹名），并说明你用了哪个依据；',
        '  - 项目名会成为工作区里的文件夹名，文档落在 ' + root + '/<项目名>/拼图/。',
        '',
        '第 2 步 · 一次建出来',
        '用 puzzle_mode{op:"init", project:"<推导出的项目名>", modules:[<按真实目录/文件分层拆的模块>], goal:"<一句话>"}；',
        '  - modules 要按**真实的代码分层**拆（一个目录/一层职责一个模块），不要照搬模板里的示例名；',
        '  - 若返回 rebound:false（项目本来就在、这次没有改绑定），**必须再调 op:bind 把本会话绑上**，',
        '    否则面板仍然显示空态，看起来像建失败了。',
        '',
        '第 3 步 · 记源码根（漏了后面全空）',
        '代码若不在 ' + root + '/<项目名>/ 下（通常都在工作区根目录），用 puzzle_mode{op:"source", path:"' + root + '"} 记下真实源码目录；',
        '  - 源码索引、源码体检都靠它，不记就是空的；',
        '  - 记完用 op:source 复查 fileCount 不是 0。',
        '',
        '第 4 步 · 定规模档位（按工作区**实际体量**自判，不要问我）',
        '用 puzzle_mode{op:"size", size:"<小|中|大>"} 写下来；判据是**你第 1 步真读到的数字**：',
        '  - 小：源码 ≲2k 行、模块 ≲3 个 → 条目收紧（悬而未决 ' + (L.sizeCaps['小'].pending) + ' / 已定 ' + (L.sizeCaps['小'].decided)
          + ' / 工作流 ' + (L.sizeCaps['小'].workflow) + '，坑 ' + (L.sizeCaps['小'].pit) + ' 条）；',
        '  - 中：≲20k 行、模块 ≲8 个 → 默认档（悬而未决 ' + (L.sizeCaps['中'].pending) + ' / 已定 ' + (L.sizeCaps['中'].decided)
          + ' / 工作流 ' + (L.sizeCaps['中'].workflow) + '，坑不限）；',
        '  - 大：更多行数或模块 → 条目放宽（悬而未决 ' + (L.sizeCaps['大'].pending) + ' / 已定 ' + (L.sizeCaps['大'].decided)
          + ' / 工作流 ' + (L.sizeCaps['大'].workflow) + '，坑 ' + (L.sizeCaps['大'].pit) + ' 条；字数也放宽）；',
        '说不准就写「中」——它是默认档，写错也不会有额外后果；定了之后随时能在面板上改。',
        '',
        '第 5 步 · 逐节填真实内容，每条都带（源码: 文件:行）',
        '  - 主文档「模块索引」：每个模块一行，指向 模块/<名>.md；',
        '  - 主文档「源码索引」：入口与关键文件 → 真实行号；',
        '  - 主文档「坑」：从代码里**读出来**的真实坑；读不出来就留空，别硬凑；',
        '  - 每个模块文档的「要点」：这份模块管什么、关键函数在哪个文件哪一行。',
        '行号必须**打开文件核实**，不许估；填不出的地方留空，空着比编造好。',
        '',
        '注意：条目有字数上限（要点 ' + L.entryLimits.points + ' 字 / 详细记录 ' + L.entryLimits.detail
          + ' 字 / 坑 ' + L.entryLimits.pit + ' 字 / 主文档条目 ' + L.entryLimits.index + ' 字），',
        '每条必须带（源码: 文件:行）；超限会被拒绝写入，不会截断。',
      ].join('\n')
    }

    /**
     * 绑定到已有项目：`op:bind` 是**替换全部绑定**（「本会话就绑这一个」）。
     *
     * 要**追加**（保留已有的绑定、只多加一个）得走面板的「＋ 绑定项目」或 `op:init`；
     * 这两条路的语义在 v7 分开了，模板必须说清是哪一个，否则模型会用 op:bind 去「加一个」，
     * 结果静默解绑掉别的项目。
     */
    function bindTemplate(projectName) {
      return [
        '【绑图 · 绑定项目】',
        '把本会话绑定到项目「' + (projectName || '<项目名>') + '」：',
        '- 调 puzzle_mode 的 op:bind 并给 project（项目已存在，不要用 op:init 重建）',
        '- 注意 op:bind 是**替换全部绑定**——本会话原先绑的其它项目会被解绑；',
        '  只想**再加一个**、保留原有的，改用面板的「＋ 绑定项目」（或 op:init 建新项目）。',
        '- 绑定后先 op:read 确认 projectSource 变成 bound，再把本轮结论写进该项目的文档',
      ].join('\n')
    }

    /**
     * 工作流模板：**先问出「哪条流程」，再把它写成一条流水线**。
     *
     * 工作流不是待办清单，也不是「别做某事」的禁令——它是**标准化流水线**：
     * 为完成某个特定任务，把重复的步骤、工具、规则按顺序串成一条可复用的路。
     * 所以模板要求模型**先提问确认是哪条流程**，再用 `op:main section:'workflow'`
     * 写成 `### 名字` + 有序步骤，而不是自己拍一条。槽位留空，具体业务由问答定。
     */
    function workflowTemplate(projectName, projectDir, projectRoot, lim) {
      var L = lim || FALLBACK_LIMITS
      return [
        '【' + (projectName || '拼图') + ' · 工作流】',
        '工作流 = **标准化流水线**：为完成某个特定任务，把重复的步骤、工具、规则按顺序串成一条可复用的路。',
        '先别写文档——用 ask_user_question 把下面这些问清（一轮最多 ' + L.askQuestions
          + ' 问、每题最多 ' + L.askOptions + ' 个选项，能用选项就用选项）：',
        '（每题给 3–6 个真岔路、每个配一句取舍；只说「① 是 ② 否」等于没问）',
        '1. 这条流程要完成什么任务？（这就是它的名字，≤' + L.workflowNameLimit + ' 字）',
        '2. 从开始到结束，依次经过哪些步骤？（按真实顺序，一步一个动作）',
        '3. 每一步用什么工具 / 命令？产出什么？哪些步骤最容易漏或做错？',
        '',
        '拿到回答后，用 puzzle_mode{op:"main", section:"workflow"} 写成：',
        '### <这条流程的名字>',
        '1. <第一步：谁 + 用什么工具 + 做什么 + 产出什么>',
        '2. <第二步>',
        '',
        '规则：一条工作流 = 一个 `### 名字` 块，块内逐行是**有序**步骤（最多 ' + L.workflowMaxSteps
          + ' 步、每步 ≤' + L.workflowStepLimit + ' 字）。',
        '**工作流不要求（源码: 文件:行）**——它约束的是流程，不是对代码事实的断言，别给步骤编行号。',
        '**要改一条就改那一块**，不要新加一条——每条工作流是并列的一条独立的路，两条之间不应有依赖。',
        '最多 ' + L.entryCaps.workflow + ' 条，超了写入时自动删最旧的一条（整条删）；删掉的进归档，可在面板里恢复或永久删除。',
      ].join('\n')
    }

    /**
     * 用户主题 CSS 的前端复检。
     *
     * 刻意**不 import** 宿主半的 `validateThemeCss`：本文件是手写的 module-loader 包，
     * factory 内只有 `require('react')`（见文件头），拿不到 `lib/` 的 ESM 导出。
     * 所以这里是一份**刻意的重复实现**，只覆盖「挂载前必须再拦一次」的那几条硬规则。
     * 两条口径必须一致——`test/70-themes.test.mjs` 拿同一批恶意样本同时喂给两边，
     * 任何一侧漏拦都会红（否则这份重复实现迟早漂移成摆设）。
     */
    function themeCssRejectReason(css) {
      if (typeof css !== 'string' || css.trim() === '') return 'empty'
      var lower = css.toLowerCase()
      if (lower.indexOf('@import') >= 0) return 'import'
      if (lower.indexOf('javascript:') >= 0) return 'javascript'
      if (lower.indexOf('expression(') >= 0) return 'expression'
      if (css.indexOf('</') >= 0) return 'close-tag'
      var urls = css.match(/url\(\s*['"]?([^'")]*)/gi) || []
      for (var i = 0; i < urls.length; i++) {
        var inner = urls[i].replace(/^url\(\s*['"]?/i, '').trim()
        if (!/^data:image\//i.test(inner)) return 'external-url'
      }
      return null
    }

    /**
     * 把用户主题挂进文档（或撤掉）。
     *
     * 为什么单独一张 `<style>` 而不是拼进内置的 `CSS` 常量：
     *   1) 内置样式表是**静态字符串**，重挂它等于把整张表重解析一遍；
     *   2) 主题要能**单独撤掉**（恢复默认），独立节点只需 `remove()`；
     *   3) 顺序上它排在后面，所以主题的 `--dshpz-*` 能覆盖内置的默认值——
     *      这就是「主题 = 变量覆盖」的机制本身。
     *
     * 挂载点选 `document.head` 而不是面板根节点：用户裁定的作用域是
     * 「面板 + 那颗小按钮」，两者分属不同 Slot，只有 `head` 能同时罩住。
     * 这也正是主题 CSS 被**限制成只能写 `.dshpz-*` 选择器**的原因——
     * 作用域是靠选择器收窄的，不是靠挂载点。
     */
    function applyUserTheme(css) {
      // 取节点这一步**必须容错**：主题是背景功能，它出问题绝不能让按钮/面板渲染不出来。
      // 老 WebView、被裁剪的 DOM 替身、别的插件改过 document——症状都可能是这里抛错。
      var doc = typeof document !== 'undefined' && document !== null ? document : null
      if (doc === null || typeof doc.createElement !== 'function' || typeof doc.getElementById !== 'function') return 'no-dom'
      var existing = doc.getElementById('dshpz-user-theme')
      var reason = themeCssRejectReason(css)
      if (reason !== null) {
        // 拒绝时**必须撤掉旧的**：留着旧主题而状态说「已换」，用户看到的是假象。
        if (existing !== null && existing !== undefined && existing.parentNode) existing.parentNode.removeChild(existing)
        return reason
      }
      var node = existing
      if (node === null || node === undefined) {
        node = doc.createElement('style')
        node.setAttribute('id', 'dshpz-user-theme')
        node.setAttribute('data-dsh-puzzle-theme', '')
        doc.head.appendChild(node)
      }
      if (node.textContent !== css) node.textContent = css
      return null
    }

    /* ------------------------------- 共享 store ------------------------------- */

    var state = {
      open: false,
      data: null,
      projects: null,
      detail: null,
      detailName: null,
      /**
       * 主文档只读视图：`null` = 没拉过；`{loading:true}` = 正在拉；
       * 否则是 `method:'main'` 的返回（`text` 是完整原文）；失败时是 `{error}`。
       *
       * 面板里**只读**——拼图文档只能由 AI 通过 puzzle_mode 改，做成可编辑就等于开了后门。
       */
      main: null,
      /** 「主文档」区块是否展开（点按钮切换；展开时才去拉 `method:'main'`）。 */
      showMain: false,
      /**
       * 当前**展开**的那条工作流的名字（`null` = 都收起）。
       *
       * 与模块详情同一套交互（用户裁定：工作流 UI 改成像模块点击出细节的模式）：
       * 列表只显示「名字 + 几步」，点开才铺开有序步骤——这样 5 条工作流不会把面板撑长，
       * 也一眼看得出每条有多长。用**名字**而不是序号当键：删掉一条后序号会重排，
       * 而名字是这条路的标识（与 `removeWorkflowItem` 的身份校验同一个口径）。
       */
      wfOpen: null,
      /** 审查结果字段已随「审查 / 真实值」按钮与真实值显示区一起删除（v0.23.0）。 */
      /**
       * 全局开关状态（此后新建的会话带不带拼图模式）。
       *
       * 与项目无关，所以**空态也要能读写**——恰恰是「新会话还没绑项目、
       * 但不想被拼图规则牵着走」这个场景最需要它。
       */
      settings: null,
      loading: false,
      error: null,
      sessionId: undefined,
      /**
       * 输入框动作，来自按钮那一侧。
       *
       * `shell.overlay` 的标准 props **不含 `inputActions`**（只有 `conversation.*`
       * 作用域的 Slot 才有），所以面板拿不到它——必须由 `conversation.input.left` 里的
       * 按钮把 props.inputActions 存进这个共享 store，面板才能把提示词填进输入框。
       */
      inputActions: undefined,
      /**
       * 空态表单（表单直建用）。
       *
       * 存在的意义：让「建项目」不必经过模型——模型要走一轮对话，而建一个空壳是纯机械动作。
       * 走 RPC 的 `create` 是同步的，点完立刻就绑好了，省掉一整轮往返。
       */
      formProject: "",
      formModules: "",
      /** 「＋ 绑定项目」的候选列表是否展开（默认收起，免得挤掉下面的区块）。 */
      addOpen: false,
      /** 空态的绑定模式：`single`（只绑一个）或 `multi`（同时绑多个）。 */
      bindMode: "single",
      /** 多绑定模式下勾选的项目名（提交后清空）。 */
      bindPick: [],
      /**
       * 「扫工作区」的结果（v0.21.0 ①）：`null` = 还没扫过或已关掉；
       * 否则是 `method:'scan'` 给的候选数组（每项 `{name, slug, entries}`）。
       */
      scan: null,
      /** 扫描结果里勾选的目录名（提交后清空）。 */
      scanPick: [],
      formGoal: "",
      /**
       * 一次性提示（成功但需要说明的事，例如「项目已存在，本次没动绑定」）。
       *
       * 与 `error` 分开：它不是失败，红字会让人以为出错了。每次 load 时清掉。
       */
      notice: null,
      /**
       * 样式自检结果（`apply` 挂样式表后读一次真实计算值）。
       * `applied:false` 表示**面板没有样式**——那才是「缩在左上角、文字重叠」的原因，
       * 与项目数据无关。`null` 表示还没测到。
       */
      styleDiag: null,
      /**
       * 主题层是否打开（面板一角那颗图标点开的**全屏覆盖层**）。
       *
       * 为什么是「面板内的一层」而不是新 Slot：面板本身已经是 `shell.overlay` 上的
       * 全屏遮罩，再注册一个 Slot 会与宿主的面板叠在一起、Esc 关谁都不确定。
       * 做成面板内部的一层，关闭顺序天然正确（先关主题层，再关面板）。
       */
      themeOpen: false,
      /**
       * 远端主题清单：`null` = 还没拉过；`{loading:true}` = 正在拉；
       * 否则是 `method:'theme', action:'list'` 的返回（含 `themes` / `tried` / `offline`）。
       */
      themeList: null,
      /** 主题层的即时反馈（安装成功/失败的一句话），与面板的 `error` 分开。 */
      themeNotice: null,
      /** 主题层的错误（红字），与 `themeNotice` 分开：红字只给真失败。 */
      themeError: null,
      /** 正在安装/卸载的主题 id（按钮显示「下载中…」并禁用，防连点重复下载）。 */
      themeBusy: null,
      /**
       * 当前生效主题的 CSS 文本与 id——**顶层字段，不藏在 `data` 里**。
       *
       * 为什么必须独立于 `data`：那颗小按钮**在面板没打开时也一直显示**，
       * 而 `data` 只在面板打开后才由 `load()` 拉。若主题 CSS 只跟着 `data` 走，
       * 用户不打开面板就永远看不到按钮换色——「跟着变色」等于没做。
       * 所以按钮挂载时单独拉一次 `action:'css'`（一个小请求），把结果放这里。
       */
      themeCss: '',
      themeCurrent: '',
    }
    var listeners = new Set()

    function emit() {
      for (var fn of Array.from(listeners)) {
        try {
          fn()
        } catch (_error) {
          /* 单个渲染错误不能影响其它订阅者 */
        }
      }
    }

    function setState(patch) {
      state = Object.assign({}, state, patch)
      emit()
    }

    function subscribe(fn) {
      listeners.add(fn)
      return function () {
        listeners.delete(fn)
      }
    }

    function useStore(inputActions) {
      var pair = React.useState(0)
      var tick = pair[0]
      var bump = pair[1]
      React.useEffect(function () {
        return subscribe(function () {
          bump(function (value) {
            return value + 1
          })
        })
      }, [])
      return { tick: tick, state: state, setState: setState }
    }

    /* --------------------------------- 取数 --------------------------------- */

    function post(payload) {
      return fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (res) {
        return res.json()
      })
    }

    function load(sessionId, project) {
      if (sessionId === undefined || sessionId === null) {
        setState({ error: '当前会话没有会话 ID，无法读取拼图状态', loading: false })
        return
      }
      setState({ loading: true })
      var body = { method: 'state', sessionId: String(sessionId) }
      if (project !== undefined && project !== null && project !== '') body.project = String(project)
      post(body)
        .then(function (json) {
          // `notice` 不清：它是给用户看的一次性说明（如「项目已存在，没动绑定」），
          // 而轮询每 8 秒跑一次 `load`，在这里清掉就等于用户根本来不及看到。
          if (json && json.ok === true) setState({ data: mergePanelData(json.result), error: null, loading: false })
          else setState({ error: (json && json.error) || '未知错误', loading: false })
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
        })
    }

    function loadProjects(sessionId) {
      if (sessionId === undefined || sessionId === null) return
      post({ method: 'list', sessionId: String(sessionId) })
        .then(function (json) {
          if (json && json.ok === true) setState({ projects: json.result })
        })
        .catch(function () {
          /* 列表失败不覆盖主状态 */
        })
    }

    /* --------------------------------- 主题 --------------------------------- */

    /**
     * 拉当前生效主题的 CSS（**小请求，面板没开也要拉**）。
     *
     * 为什么与 `load()` 分开：`load()` 走 `state`，而 `state` 要解析整个项目文档树；
     * 那颗小按钮在**任何**会话里都显示，不该为了给它上色去读整个项目。
     * 这条只读主题目录里一个小文件。
     *
     * 失败**静默**：主题取不到就保持默认皮肤，不该在按钮上弹错——那是背景功能，
     * 不该打断用户正在做的事（真失败会在打开主题页时如实报出来）。
     */
    function loadActiveTheme(sessionId) {
      if (sessionId === undefined || sessionId === null || sessionId === '') return
      post({ method: 'theme', action: 'css', sessionId: String(sessionId) })
        .then(function (json) {
          if (json && json.ok === true && json.result !== undefined && json.result !== null) {
            setState({ themeCss: String(json.result.css || ''), themeCurrent: String(json.result.id || '') })
          }
        })
        .catch(function () {
          /* 静默：主题是背景功能 */
        })
    }

    /**
     * 拉远端主题清单（打开主题页时一次）。
     *
     * **刻意不在 `load()` 的 8 秒轮询里**：`list` 要联网，最坏 3 个镜像 × 8 秒超时；
     * 放进轮询会让断网时面板每 8 秒卡住一次。清单只在用户点进主题页时拉。
     */
    function loadThemes(sessionId) {
      setState({ themeList: { loading: true }, themeError: null })
      post({ method: 'theme', action: 'list', sessionId: String(sessionId) })
        .then(function (json) {
          if (json && json.ok === true) setState({ themeList: json.result })
          else setState({ themeList: { error: (json && json.error) || '拉主题清单失败', tried: json && json.tried } })
        })
        .catch(function () {
          setState({ themeList: { error: '无法连接 ' + RPC } })
        })
    }

    /**
     * 「下载并应用」——一颗按钮走完下载 → 校验 → 落盘 → 应用。
     *
     * 失败时**保留失败原因与各镜像的报错**（`tried`）：本仓的老教训是
     * 「诊断行写死致误报与真错同形」，所以这里把宿主回报的 `tried` 原样显示出来。
     */
    function installAndApplyTheme(sessionId, id) {
      if (state.themeBusy !== null) return
      setState({ themeBusy: id, themeError: null, themeNotice: null })
      post({ method: 'theme', action: 'install', id: String(id), sessionId: String(sessionId) })
        .then(function (json) {
          if (json && json.ok === true) {
            setState({
              themeBusy: null,
              themeNotice: '已应用「' + (json.result.name || id) + '」' + (json.result.cached === true ? '（清单来自缓存）' : ''),
            })
            load(sessionId)
          } else {
            setState({ themeBusy: null, themeError: (json && json.error) || '安装失败', themeList: mergeThemeTried(state.themeList, json) })
          }
        })
        .catch(function () {
          setState({ themeBusy: null, themeError: '无法连接 ' + RPC })
        })
    }

    /** 应用一个**已下载**的主题（不联网）。 */
    function applyInstalledTheme(sessionId, id) {
      if (state.themeBusy !== null) return
      setState({ themeBusy: id, themeError: null, themeNotice: null })
      post({ method: 'theme', action: 'apply', id: String(id), sessionId: String(sessionId) })
        .then(function (json) {
          if (json && json.ok === true) {
            setState({ themeBusy: null, themeNotice: '已应用「' + (json.result.name || id) + '」' })
            load(sessionId)
          } else {
            setState({ themeBusy: null, themeError: (json && json.error) || '应用失败' })
          }
        })
        .catch(function () {
          setState({ themeBusy: null, themeError: '无法连接 ' + RPC })
        })
    }

    /** 恢复默认皮肤（清掉当前主题记录，CSS 由宿主下次 `state` 下发为空）。 */
    function resetThemeNow(sessionId) {
      setState({ themeBusy: '', themeError: null, themeNotice: null })
      post({ method: 'theme', action: 'reset', sessionId: String(sessionId) })
        .then(function (json) {
          if (json && json.ok === true) {
            setState({ themeBusy: null, themeNotice: '已恢复默认皮肤' })
            load(sessionId)
          } else {
            setState({ themeBusy: null, themeError: (json && json.error) || '恢复默认失败' })
          }
        })
        .catch(function () {
          setState({ themeBusy: null, themeError: '无法连接 ' + RPC })
        })
    }

    /** 卸载一个已下载的主题；卸的正好是当前主题时宿主会顺带回默认。 */
    function uninstallThemeNow(sessionId, id) {
      if (state.themeBusy !== null) return
      setState({ themeBusy: id, themeError: null, themeNotice: null })
      post({ method: 'theme', action: 'uninstall', id: String(id), sessionId: String(sessionId) })
        .then(function (json) {
          if (json && json.ok === true) {
            setState({
              themeBusy: null,
              themeNotice: '已卸载「' + id + '」' + (json.result.resetCurrent === true ? '，并已恢复默认皮肤' : ''),
            })
            load(sessionId)
          } else {
            setState({ themeBusy: null, themeError: (json && json.error) || '卸载失败' })
          }
        })
        .catch(function () {
          setState({ themeBusy: null, themeError: '无法连接 ' + RPC })
        })
    }

    /**
     * 把宿主回报的「各镜像分别报了什么」并回清单状态里。
     *
     * 为什么不让它随请求一起丢掉：主题拉不到时，用户需要看到
     * 「jsDelivr / gh-proxy / raw 分别超时还是 404」——只说「下载失败」等于没诊断。
     */
    function mergeThemeTried(list, json) {
      if (list === null || list === undefined) return list
      if (json === null || json === undefined || !Array.isArray(json.tried)) return list
      var merged = Object.assign({}, list)
      merged.tried = json.tried
      return merged
    }


    /**
     * **按会话**开关：只影响当前这个会话。
     *
     * 判定只认会话 ID，所以必须把**真实的 sessionId** 传给宿主——
     * 早先用占位串 `'panel'` 只因为那时是全局时刻、与谁在调无关；
     * 现在这个占位串会被当成一个不存在的会话，开关就失灵了。
     */
    function loadSettings(sessionId) {
      if (sessionId === undefined || sessionId === null || sessionId === '') {
        setState({ settings: { error: '当前会话没有会话 ID，无法读写开关' } })
        return
      }
      post({ method: 'settings', sessionId: String(sessionId) })
        .then(function (json) {
          if (json && json.ok === true) setState({ settings: json.result })
          else setState({ settings: { error: (json && json.error) || '开关读取失败' } })
        })
        .catch(function () {
          setState({ settings: { error: '无法连接 ' + RPC } })
        })
    }

    /**
     * 写设置。两个开关**分开传**，只传要改的那个：
     *   `disabled` —— 按会话（拼图模式开关）；
     *   `askPause` —— 全局（固定收尾问）。
     * 传 `undefined` 的那个字段**根本不会进请求体**，宿主也就不会去动它。
     * （早先这里无条件带上 `disabled`，加第二个开关时若照抄，就会「点收尾问顺手把会话也开了」。）
     */
    function writeSettings(sessionId, disabled, askPause) {
      if (sessionId === undefined || sessionId === null || sessionId === '') {
        setState({ error: '当前会话没有会话 ID，无法切换开关' })
        return
      }
      var body = { method: 'settings', sessionId: String(sessionId) }
      if (disabled !== undefined) body.disabled = disabled === true
      if (askPause !== undefined) body.askPause = askPause === true
      post(body)
        .then(function (json) {
          if (json && json.ok === true) {
            var notice = null
            if (askPause !== undefined) {
              notice = json.result.askPause === true
                ? '已开启固定收尾问：每次提问末尾都会问「' + PAUSE_QUESTION + '」。'
                : '已**全局关闭**固定收尾问：此后所有会话的提问都不再带它。'
            } else if (disabled !== undefined) {
              notice = json.result.disabled === true
                ? '已关掉**本会话**的拼图模式；其他会话不受影响。'
                : '已恢复**本会话**的拼图模式。'
            }
            setState({ settings: json.result, notice: notice })
          } else {
            setState({ error: (json && json.error) || '开关写入失败' })
          }
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC })
        })
    }

    function loadDetail(sessionId, name, project) {
      if (sessionId === undefined || sessionId === null) return
      var body = { method: 'module', sessionId: String(sessionId), name: String(name) }
      if (project !== undefined && project !== null && project !== '') body.project = String(project)
      post(body)
        .then(function (json) {
          if (json && json.ok === true) setState({ detail: json.result, detailName: name })
          else setState({ detail: { error: (json && json.error) || '读取失败' }, detailName: name })
        })
        .catch(function () {
          setState({ detail: { error: '无法连接 ' + RPC }, detailName: name })
        })
    }

    /**
     * 取主文档原文（含 front-matter）与工作流条目 / 归档。
     *
     * 面板里**只读**：拼图文档只能由 AI 通过 puzzle_mode 改，做成可编辑就等于开了后门。
     * 工作流区块的数据也来自这一次调用——`state` 摘要里不含工作流，所以面板打开时
     * 顺手拉一次，删/恢复之后再拉一次（`text` 跟着变了，不能只改本地数组）。
     */
    function loadMain(sessionId, project) {
      if (sessionId === undefined || sessionId === null) {
        setState({ main: { error: '当前会话没有会话 ID，无法读取主文档' } })
        return
      }
      // 合并而不是覆盖：重新拉取时先留着上一次的原文与工作流（否则删一条之后整块会闪一下空白）。
      // `error` 要清掉：否则上一次失败的红字会跟着新一次请求活到成功之后。
      setState({ main: Object.assign({}, state.main, { loading: true, error: undefined }) })
      var body = { method: 'main', sessionId: String(sessionId) }
      if (project !== undefined && project !== null && project !== '') body.project = String(project)
      post(body)
        .then(function (json) {
          if (json && json.ok === true) setState({ main: json.result })
          else setState({ main: { error: (json && json.error) || '主文档读取失败' } })
        })
        .catch(function () {
          setState({ main: { error: '无法连接 ' + RPC } })
        })
    }

    /**
     * 工作流的删除 / 恢复 / 永久删除。
     *
     * 这是**面板里唯一会改主文档的动作**，所以删除走二次确认（`window.confirm`），
     * 恢复也走二次确认：工作流满 5 条时，恢复会**挤掉最旧的一条**（那条会被推回归档，
     * 不是丢掉，但对用户来说是「我的流程列表变了」），所以必须让他知道再点。
     * `index` 是 1 起的序号，与宿主契约一致；成功后宿主回的是**整份状态摘要**，
     * 所以这里按 `writeMode` 那套直接整体换 `data`。
     *
     * 删除时会带 `expected`（那条工作流的**名字**）：宿主用它做**身份校验**。
     * 为什么需要：`index` 是位置语义——同一次渲染里连点两次「删除」，第二次会删掉
     * 补位上来的另一条。带上名字，过期就拒绝，不会误删。
     */
    function workflowAction(view, action, index, changed) {
      var sessionId = view.state.sessionId
      if (sessionId === undefined || sessionId === null) {
        setState({ error: '当前会话没有会话 ID，无法改动工作流' })
        return
      }
      var data = view.state.data
      setState({ loading: true })
      var body = { method: 'workflow', sessionId: String(sessionId), action: action, index: index }
      if (data !== null && data !== undefined && data.initialized === true && data.project) body.project = String(data.project)
      // 只对删除做身份校验：恢复 / 永久删除是按归档序号取，归档只在删除时追加，语义已经稳定。
      if (action === 'remove' && typeof changed === 'string' && changed !== '') body.expected = changed
      post(body)
        .then(function (json) {
          if (json && json.ok === true) {
            var result = json.result || {}
            var evicted = Array.isArray(result.evicted) ? result.evicted : []
            var notice
            if (action === 'remove') {
              notice = '已删除工作流「' + String(result.changed || changed || '') + '」（在下面「归档」里可以恢复或永久删除）'
            } else if (action === 'drop') {
              notice = '已从归档永久删除「' + String(result.changed || changed || '') + '」，不可恢复。'
            } else if (evicted.length > 0) {
              // 挤掉的那条**回到了归档**，所以这里说清「不是丢了」，并指路怎么再恢复。
              notice = '已恢复：' + String(result.changed || '') + '；工作流原本已满，最旧的一条被挤回「归档」：' + evicted.join('；') + '（想找回它就在归档里点恢复）'
            } else {
              notice = '已恢复：' + String(result.changed || '')
            }
            // 展开态跟着结果走：删掉 / 恢复后名字可能已经不在列表里，
            // 留着旧名字会让「已展开」的标记指着一个不存在的块。
            setState({ data: mergePanelData(result), error: null, loading: false, notice: notice, wfOpen: null })
            // 主文档原文跟着变了：重新拉一次，别只改本地数组（下次刷新就会露馅）。
            loadMain(sessionId, result.project)
          } else {
            // 宿主给了 hint（例如「面板已过期，重新打开再删」）就一起显示，别只丢一句 error。
            var message = (json && json.error) || '工作流写入失败'
            if (json && typeof json.hint === 'string' && json.hint !== '') message += '（' + json.hint + '）'
            setState({ error: message, loading: false })
          }
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
        })
    }

    /** 删除整条工作流：**二次确认**后才真的调 RPC。 */
    function removeWorkflow(view, index, name) {
      var ok = window.confirm('删掉整条工作流「' + String(name || '') + '」？\n\n（会进归档，可在面板里恢复）')
      if (ok !== true) return
      workflowAction(view, 'remove', index, name)
    }

    /**
     * 恢复一条归档条目：同样**二次确认**。
     *
     * 与删除的唯一区别：工作流已满 5 条时，恢复会挤掉最旧的那一条（它会被推回归档）。
     * 所以确认文案要预告这件事，而不是让用户在结果里才发现列表变了。
     */
    function restoreWorkflow(view, index, name) {
      var list = []
      var main = view.state.main
      if (main !== null && main !== undefined && Array.isArray(main.workflow)) list = main.workflow
      var full = list.length >= 5
      var oldest = full && list[0] !== undefined && list[0] !== null ? String(list[0].name || '') : ''
      var ok = window.confirm('把整条工作流「' + String(name || '') + '」恢复回列表？'
        + (full
          ? '\n\n⚠️ 工作流已满 5 条：恢复会把最旧的一条「' + oldest + '」挤回归档（不是丢掉，归档里还能恢复）。'
          : ''))
      if (ok !== true) return
      workflowAction(view, 'restore', index, name)
    }

    /**
     * 从归档里**永久删除**一条：二次确认，且文案要说清「不可恢复」。
     *
     * 与「恢复」并列的第二个出口。为什么需要它：归档是有界账本（≤10 条），
     * 若只能恢复不能删，用户想彻底丢掉一条旧流水线时，唯一办法是把它恢复出来、
     * 挤掉一条好的、再删掉——绕一大圈还会误伤（用户原话：归档可恢复可删除）。
     */
    function dropWorkflow(view, index, name) {
      var ok = window.confirm('从归档里永久删除「' + String(name || '') + '」？\n\n⚠️ 这一步**不可恢复**，那条工作流的步骤会一起消失。')
      if (ok !== true) return
      workflowAction(view, 'drop', index, name)
    }

    /**
     * 表单直建：把项目名 / 模块名 / 目标填好，直接调 RPC `create` —— **不经过模型**。
     *
     * 与两个模板按钮的分工：模板按钮是「让 AI 来建」（会问、会拆模块），
     * 这里是「我自己填好了，立刻建」（机械动作，不该占一轮对话）。
     * 模块名按逗号/顿号/空格切，空名与重复名交给宿主 `slugify` 去重。
     */
    /**
     * 扫工作区里**还没有拼图文档**的顶层目录（用户需求 v0.21.0 ①）。
     *
     * 为什么要走宿主而不是让面板自己猜：目录清单是客观事实，宿主扫一次给出
     * 名字 + 证据（目录里前几个文件名），用户勾选才有依据。面板只管画。
     */
    function scanCandidates(view) {
      var sessionId = view.state.sessionId
      if (sessionId === undefined || sessionId === null) {
        setState({ error: '当前会话没有会话 ID，无法扫描' })
        return
      }
      setState({ loading: true, scanPick: [] })
      post({ method: 'scan', sessionId: String(sessionId) })
        .then(function (json) {
          if (json && json.ok === true) {
            var r = json.result || {}
            var list = Array.isArray(r.candidates) ? r.candidates : []
            setState({
              error: null,
              loading: false,
              scan: list,
              scanPick: [],
              // 只扫到一个就直接勾上——省一次点击，且这正是「只有一个新项目」的常见情形。
              scanOpen: true,
              notice: list.length === 0
                ? '工作区里每个顶层目录都已经有拼图文档了。'
                : '扫到 ' + list.length + ' 个还没有拼图文档的目录，勾选后一次建齐。',
            })
          } else {
            setState({ error: (json && json.error) || '扫描失败', loading: false })
          }
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
        })
    }

    /**
     * 一次给**多个**项目建文档（用户需求 v0.21.0 ①）。
     *
     * 绑定语义（用户裁定「全部追加绑定」）：逐个走 `create`，每个都是一次 `addBinding`
     * （宿主 `createProject` 用 `addBinding`，只追加不解绑），最后一个成为当前项目。
     * 串行而不是并发：建项目会读改写**同一个工作区**的文档，并发会让绑定顺序不确定。
     */
    function createMany(view) {
      var sessionId = view.state.sessionId
      var picked = view.state.scanPick || []
      if (sessionId === undefined || sessionId === null) {
        setState({ error: '当前会话没有会话 ID，无法建项目' })
        return
      }
      if (picked.length === 0) {
        setState({ error: '先勾选要建文档的目录' })
        return
      }
      setState({ loading: true, error: null })
      var done = []
      var failed = []
      var chain = Promise.resolve()
      picked.forEach(function (name) {
        chain = chain.then(function () {
          // 模块名留空 → 宿主按空模块清单建主文档，之后由「照现有项目搭文档」或模型补模块。
          return post({ method: 'create', sessionId: String(sessionId), project: String(name), modules: [], goal: '' })
            .then(function (json) {
              if (json && json.ok === true) done.push(name)
              else failed.push(name + '：' + String((json && json.error) || '建项目失败'))
            })
            .catch(function () { failed.push(name + '：无法连接 ' + RPC) })
        })
      })
      chain.then(function () {
        setState({
          loading: false,
          scanOpen: false,
          scanPick: [],
          scan: null,
          error: failed.length > 0 ? failed.join('；') : null,
          notice: done.length > 0
            ? '已建好 ' + done.length + ' 个项目文档并**全部追加绑定**（' + done.join('、') + '），'
              + '最后一个成为当前项目。'
            : null,
        })
        load(sessionId)
        loadProjects(sessionId)
      })
    }

    function createByForm(view) {
      var sessionId = view.state.sessionId
      var project = String(view.state.formProject || "").trim()
      if (sessionId === undefined || sessionId === null) {
        setState({ error: '当前会话没有会话 ID，无法建项目' })
        return
      }
      if (project === "") {
        setState({ error: '请先填项目名（它会成为工作区里的文件夹名）' })
        return
      }
      var modules = String(view.state.formModules || "")
        .split(/[,，、;；\s]+/)
        .map(function (item) { return item.trim() })
        .filter(function (item) { return item !== "" })
      setState({ loading: true })
      post({
        method: 'create',
        sessionId: String(sessionId),
        project: project,
        modules: modules,
        goal: String(view.state.formGoal || "").trim(),
      })
        .then(function (json) {
          if (json && json.ok === true) {
            var result = json.result || {}
            // 项目已存在 → 宿主**没有**改绑定。必须把这件事说出来：
            // 否则用户填了个已有项目名、点「立刻建」，会以为自己绑过去了。
            setState({
              error: null,
              loading: false,
              formProject: '',
              formModules: '',
              formGoal: '',
              notice: result.mainCreated === true
                ? '已建好并绑定本会话。'
                : '项目已存在，**没有改动绑定**（要改绑用「项目」区的绑定切换条）。',
            })
          } else {
            setState({ error: (json && json.error) || '建项目失败', loading: false })
          }
          load(sessionId)
          loadProjects(sessionId)
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
        })
    }

    /**
     * 重建文档格式。
     *
     * 两步走：先 dry-run 把「将要改什么」摆出来（**不落盘**），再让用户点第二次才 apply。
     * 为什么不一步到位：重建是破坏性的，而本项目不自动备份——预览就是唯一的刹车。
     */
    /**
     * 从面板 `data.bindings` 里取出项目名——**两种形状都认**。
     *
     * 宿主侧 `bindings` 有两种：`state` RPC 是对象数组（`{project, health, mode…}`），
     * `current` / `unbind` 是字符串数组。同名不同形是这份代码里反复出现的坑
     * （v0.20.0 踩过一次：`...extra` 把对象数组盖成 `[undefined, undefined]`）。
     * 凡是**按字段取值**的地方都得走这里，别直接 `.map(b => b.project)`。
     */
    function boundNamesOf(data) {
      if (data === null || data === undefined || !Array.isArray(data.bindings)) return []
      var out = []
      for (var i = 0; i < data.bindings.length; i += 1) {
        var item = data.bindings[i]
        if (typeof item === 'string' && item !== '') out.push(item)
        else if (item !== null && item !== undefined && typeof item.project === 'string' && item.project !== '') out.push(item.project)
      }
      return out
    }

    function rebuildNow(view, apply) {
      var sessionId = view.state.sessionId
      var data = view.state.data
      if (sessionId === undefined || sessionId === null) {
        setState({ error: '当前会话没有会话 ID，无法重建' })
        return
      }
      if (data === null || data === undefined || data.initialized !== true) {
        setState({ error: '还没有项目可重建' })
        return
      }
      // 多绑定时迁移是**全局动作**（用户裁定 ②）：一次把全部绑定项目升到当前格式，
      // 免得留下几个格式不一致的文档、下次打开还要再迁一遍。单绑定时 all 无害（就它一个）。
      //
      // ⚠️ `bindings` 在宿主侧有**两种形状**：`state` RPC 给对象数组（`{project, health…}`），
      // 而 `current` / `unbind` 给**字符串数组**。这里按字段取，遇到字符串数组会得到一串
      // `undefined`——`length` 看着还对，`all` 却被静默判成 `false`（迁移只作用于当前项目，
      // 正是用户要根治的那个行为）。所以两种形状都认。
      var boundNames = boundNamesOf(data)
      var all = boundNames.length > 1
      setState({ loading: true, rebuild: null })
      var body = { method: 'rebuild', sessionId: String(sessionId), project: String(data.project), apply: apply === true }
      if (all) body.all = true
      post(body)
        .then(function (json) {
          if (json && json.ok === true) {
            setState({ error: null, loading: false, rebuild: json.result })
            if (apply === true) {
              load(sessionId)
              loadProjects(sessionId)
            }
          } else {
            setState({ error: (json && json.error) || '重建失败', loading: false })
          }
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
        })
    }

    /**
     * 扫描结果勾选器（v0.21.0 ①）：列出工作区里还没有拼图文档的目录，勾选后一次建齐。
     *
     * 为什么不是「扫到就自动全建」：工作区顶层常混着实验目录、临时目录，
     * 全自动会一次建出一堆没人要的文档。用户裁定「先扫描列出来，我勾选」——
     * 插件负责把事实摆清楚（目录名 + 里面前几个文件当证据），决定权在用户。
     */
    function scanPicker(view) {
      var list = view.state.scan
      if (list === null || list === undefined || !Array.isArray(list)) return null
      var picked = view.state.scanPick || []
      if (list.length === 0) {
        return h('div', { className: 'dshpz-hint' }, '工作区里每个顶层目录都已经有拼图文档了。')
      }
      return h(
        'div',
        { className: 'dshpz-sect' },
        h('div', { className: 'dshpz-secttitle' },
          '扫到 ' + list.length + ' 个还没有拼图文档的目录',
          h('span', { className: 'dshpz-count' }, '已选 ' + picked.length)),
        h('div', { className: 'dshpz-muted', style: { marginBottom: '6px' } },
          '勾选后一次建齐：每个建一份主文档，并**全部追加绑定**（最后一个成为当前项目）。模块由之后「照现有项目搭文档」或模型补。'),
        h('div', { className: 'dshpz-findings' }, list.map(function (item) {
          var on = picked.indexOf(item.name) >= 0
          return h(
            'label',
            { key: item.name, className: 'dshpz-pickrow' },
            h('input', {
              type: 'checkbox',
              checked: on,
              onChange: function () {
                var next = picked.slice()
                var at = next.indexOf(item.name)
                if (at >= 0) next.splice(at, 1)
                else next.push(item.name)
                setState({ scanPick: next })
              },
            }),
            h('span', { className: 'dshpz-pickname' }, item.name),
            // 证据：目录里前几个文件名。重名或名字看不出是什么时，靠它认人。
            Array.isArray(item.entries) && item.entries.length > 0
              ? h('span', { className: 'dshpz-muted' }, '（' + item.entries.join(' / ') + '）')
              : null,
          )
        })),
        h('div', { className: 'dshpz-acts' },
          h('button', {
            className: 'dshpz-act',
            disabled: picked.length === 0,
            title: '给勾选的 ' + picked.length + ' 个目录各建一份主文档，并全部追加绑定',
            onClick: function () { createMany(view) },
          }, '建这 ' + picked.length + ' 个'),
          h('button', {
            className: 'dshpz-act',
            title: '关掉扫描结果（不建任何东西）',
            onClick: function () { setState({ scan: null, scanPick: [] }) },
          }, '取消'),
        ),
      )
    }

    /**
     * 多绑定迁移的预览：**逐项目**分组（v0.21.0 ②）。
     *
     * 为什么单独一条路：单项目预览读 `r.files`，而 `all:true` 的返回是
     * `r.results[]`（每项带自己的 `files`）。复用单项目渲染会让面板显示
     * 「已经是当前格式」——那是**假话**，明明有项目要迁。这条把每个项目
     * 连同它的改动数列出来，落盘按钮走同一个 `rebuildNow(view, true)`。
     */
    function rebuildBlockAll(view, r) {
      var results = Array.isArray(r.results) ? r.results : []
      var rows = []
      for (var i = 0; i < results.length; i += 1) {
        var one = results[i]
        var files = Array.isArray(one.files) ? one.files : []
        var detail = []
        for (var j = 0; j < files.length; j += 1) {
          if (!Array.isArray(files[j].changes) || files[j].changes.length === 0) continue
          detail.push(files[j].name + '：' + files[j].changes.join('；'))
        }
        var state = one.ok !== true ? '失败' : (one.totalChanges > 0 ? '要改 ' + one.totalChanges + ' 处' : '已是当前格式')
        rows.push(h(
          'div',
          { className: 'dshpz-finding', key: one.project, 'data-level': one.ok !== true ? 'blocker' : (one.totalChanges > 0 ? 'warn' : 'info') },
          h('span', { className: 'dshpz-flevel' }, one.current === true ? '当前' : '绑定'),
          h(
            'div',
            null,
            h('div', { className: 'dshpz-ffact' }, one.project + ' · ' + state),
            h('div', { className: 'dshpz-ffix' }, one.ok !== true ? String(one.error || '') : (detail.length > 0 ? detail.join(' / ') : '无改动')),
          ),
        ))
      }
      return h(
        'div',
        { className: 'dshpz-sect' },
        h('div', { className: 'dshpz-secttitle' },
          '重建预览 · **全部 ' + results.length + ' 个绑定项目**（共 ' + (r.totalChanges || 0) + ' 处改动）'),
        rows.length === 0
          ? h('div', { className: 'dshpz-muted' }, '本会话没有绑定项目。')
          : h('div', { className: 'dshpz-findings' }, rows),
        r.applied === true
          ? h('div', { className: 'dshpz-muted' }, '已落盘：' + results.reduce(function (acc, one) {
            return acc.concat(one.written || [])
          }, []).join('、'))
          : h(
            'div',
            { className: 'dshpz-row', style: { marginTop: '6px' } },
            h('button', {
              className: 'dshpz-act',
              title: '把上面这些改动写进**全部绑定项目**的文档（正文不动，只改 front-matter 形状与缺失的小节）',
              onClick: function () { rebuildNow(view, true) },
            }, '落盘（全部 ' + results.length + ' 个）'),
          ),
      )
    }

    /** 重建预览：逐文件列出将要改什么，并给「落盘」按钮。 */
    function rebuildBlock(view) {
      var r = view.state.rebuild
      if (r === null || r === undefined) return null
      // 多绑定（`all:true`）：结果是**每个项目一份**，逐项目分组显示。
      // 不能只渲染 `r.files`——那是单项目路径的字段，全局迁移时它根本不存在，
      // 用户会看到「已经是当前格式，无需重建」这种**假话**（明明有项目要迁）。
      if (r.all === true) return rebuildBlockAll(view, r)
      var files = Array.isArray(r.files) ? r.files : []
      var rows = []
      for (var i = 0; i < files.length; i += 1) {
        var item = files[i]
        if (!Array.isArray(item.changes) || item.changes.length === 0) continue
        rows.push(h(
          'div',
          { className: 'dshpz-finding', key: item.kind + ':' + item.name, 'data-level': item.willWrite ? 'warn' : 'info' },
          h('span', { className: 'dshpz-flevel' }, item.kind === 'main' ? '主' : '模'),
          h(
            'div',
            null,
            h('div', { className: 'dshpz-ffact' }, item.name + ' · v' + item.version),
            h('div', { className: 'dshpz-ffix' }, item.changes.join('；')),
          ),
        ))
      }
      return h(
        'div',
        { className: 'dshpz-sect' },
        h(
          'div',
          { className: 'dshpz-secttitle' },
          '重建预览 · 文档格式 v' + r.version + ' → v' + r.targetVersion + '（' + r.totalChanges + ' 处改动）',
        ),
        rows.length === 0
          ? h('div', { className: 'dshpz-muted' }, '已经是当前格式，无需重建。')
          : h('div', { className: 'dshpz-findings' }, rows),
        r.applied === true
          ? h('div', { className: 'dshpz-muted' }, '已落盘：' + (r.written || []).join('、'))
          : h(
            'div',
            { className: 'dshpz-row', style: { marginTop: '6px' } },
            h(
              'button',
              {
                className: 'dshpz-act',
                title: '把上面这些改动写进文档（正文不动，只改 front-matter 形状与缺失的小节）',
                onClick: function () { rebuildNow(view, true) },
              },
              '落盘',
            ),
            h('span', { className: 'dshpz-muted' }, '本项目不自动备份，落盘前请确认'),
          ),
      )
    }

    /** 解绑本会话（回到没绑定）。解绑后重新 load，面板会回到空态。 */
    function unbind(view) {
      var sessionId = view.state.sessionId
      if (sessionId === undefined || sessionId === null) {
        setState({ error: '当前会话没有会话 ID，无法解绑' })
        return
      }
      setState({ loading: true })
      post({ method: 'unbind', sessionId: String(sessionId) })
        .then(function (json) {
          if (json && json.ok === true) {
            // 解绑后没有项目了：主文档/工作流视图必须清掉，否则还显示着上一个项目的原文。
            setState({ error: null, loading: false, detail: null, detailName: null, main: null, showMain: false })
          } else {
            setState({ error: (json && json.error) || '解绑失败', loading: false })
          }
          load(sessionId)
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
        })
    }

    /**
     * 把本会话绑到某个项目。
     *
     * 绑定是**会话级**的，所以成功后必须重新 load 一次（不带 project）——
     * 让宿主按绑定重新解析，面板显示的才是真实归属。
     */
    function bindTo(view, project, add) {
      var sessionId = view.state.sessionId
      if (sessionId === undefined || sessionId === null || project === undefined || project === null || project === "") {
        setState({ error: '要绑定需要会话 ID 与项目名' })
        return
      }
      setState({ loading: true })
      var body = { method: 'bind', sessionId: String(sessionId), project: String(project) }
      // `add:true` = 面板那个「＋」：**追加**一个绑定，不动已有的（宿主侧走 addBinding）。
      // 不带就是老的「替换全部」语义（「绑定」按钮）。
      if (add === true) body.add = true
      post(body)
        .then(function (json) {
          if (json && json.ok === true) setState({ error: null, loading: false, detail: null, detailName: null })
          else setState({ error: (json && json.error) || '绑定失败', loading: false })
          load(sessionId)
          // 换了项目 → 主文档与工作流也换了，必须重拉（否则「主文档」页签还停在上一个项目的原文）。
          loadMain(sessionId, project)
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
        })
    }

    /** 一次追加绑定多个项目（多绑定模式的多选提交）。 */
    function bindMany(view, projects) {
      var sessionId = view.state.sessionId
      if (sessionId === undefined || sessionId === null || !projects || projects.length === 0) return
      setState({ loading: true })
      post({ method: 'bind', sessionId: String(sessionId), projects: projects })
        .then(function (json) {
          if (json && json.ok === true) setState({ error: null, loading: false, bindPick: [] })
          else setState({ error: (json && json.error) || '绑定失败', loading: false })
          load(sessionId)
          // 最后一个成为当前项目，主文档跟着它换。
          loadMain(sessionId, projects[projects.length - 1])
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
        })
    }

    /**
     * 写操作的返回**整体**成为面板新 `data` 时，补回它没带的字段。
     *
     * 为什么需要它（用户报「切换项目切着切着胶囊没了」）：
     * `method:'state'` 的返回带 `bindings`（面板切换条的数据源），而写操作的返回
     * 是 `summarize(readState(...))`——本来**一个都不带 `bindings`**。面板却把这些返回
     * 整体当成新 `data`，于是每做一次写操作，`data.bindings` 就变成 `undefined`：
     * 切换条当场塌成「只有当前项目」的兜底，要等下一次轮询（最多 8 秒）才恢复。
     *
     * ⚠️ **本轮已改主意，两侧各修一半，别只看到其中一处**：
     * 原来这里写着「选了客户端合并，另一种是让宿主每个写操作都带上 `bindings`，
     * 但那要给每个绑定项目都算一遍 `readState`，与返回体积纪律相反」——那个理由**只对
     * 一半的字段成立**。保留旧值能防「胶囊塌掉」，却防不了**值过期**：胶囊的 title 直接
     * 渲染 `item.mode`，于是点「边拼边写」后胶囊仍显示旧模式，看起来就是**「点了又自己
     * 弹回去」**（`size` 同理）。真正的根因是**写操作的返回没给真值**，不是客户端没兜住。
     * 所以现在：宿主侧 `mode` / `size` / `current` 都回一份 `bindingPanel(...)`
     * （见 `lib/index.js` 的 `bindingPanel`），这里继续留着当**兜底**——降级场景
     * （老版本宿主、返回被截断）仍需要它，且「胶囊不塌」这条有独立断言。
     *
     * 合并规则只有一条：**新值没给这个字段，就沿用旧的**。给了（哪怕是空数组）就用新的。
     */
    function mergePanelData(next) {
      var prev = state.data
      if (prev === null || prev === undefined) return next
      if (next === null || next === undefined) return next
      var merged = Object.assign({}, next)
      for (var key of ['bindings', 'currentProject', 'bindingWarnThreshold', 'limits', 'theme', 'themeCss']) {
        if (merged[key] === undefined && prev[key] !== undefined) merged[key] = prev[key]
      }
      return merged
    }

    /**
     * 把面板切到 `project`——**纯本地，不发请求**，用的数据全部来自胶囊本身。
     *
     * 它做三件事：
     *   1. 把 `current` 标记改到刚切过去的那个项目上——`mergePanelData` 只会**保留**
     *      旧的绑定组（当前项还是切换前那个），不修就显示成「点了没反应」；
     *   2. 把当前项排到第一位，与宿主 `boundProjects` 的顺序口径一致
     *      （「第一个就是当前」这条不变量在本地也必须成立）；
     *   3. **把 `mode` / `size` / `health` 一并换成目标项目的值**（用户报的
     *      「执行模式继承到下一个打开的面板」就是漏了这一步）。
     *
     * 第 3 条为什么必须有（实测复现，见 v0.23.3）：
     * 切项目时 `current` 的返回**不带**新项目的 `mode`，而 `load(sessionId)` 是异步的——
     * 从点下胶囊到 `state` 回包这段时间，面板显示的是**上一个项目的模式**：
     *
     *   ① 当前 A（只拼不写）   高亮 = 只拼不写
     *   ② 在 A 点「边拼边写」   高亮 = 边拼边写
     *   ③ 切到 B（load 未回）   高亮 = **边拼边写**  ← 这是 A 的模式，不是 B 的
     *   ④ load 已回             高亮 = 写后再拼      ← 最终才对
     *
     * 所以「继承」不是数据被写串了（宿主侧两个项目的 `模式:` 各写各的，我验过），
     * 而是**面板短暂地拿着上一个项目的值**。这几秒足够用户看错、也足够截错图。
     *
     * 数据来源是**胶囊自己**（`bindings` 里每项都带 `mode` / `health` / `moduleCount`），
     * 所以这一步不需要任何额外请求——这也是当初把这三个字段放进绑定组的原因。
     * 权威值仍以随后的 `load()` 为准；这里只是把窗口期填对。
     *
     * ⚠️ 早先这条注释写着「没能稳定构造出它单独失效的场景」——那是**当时没测出来**，
     * 不是它没问题。v0.23.3 补上了复现与断言（第 3 条就是当初漏掉的那半）。
     */
    function markCurrentLocal(view, project) {
      // 读**模块级** `state.data`，不读 `view.state.data`：`view` 是组件渲染时的快照，
      // 而写操作的回调是在若干微任务之后跑的——那时 `view.state` 已经过期了
      // （实测：用 `view.state` 时胶囊回来了、但高亮停在旧的那一个）。
      // `setState` 本来就写模块级 `state`，这里与它同一份来源。
      var data = state.data
      if (data === null || data === undefined || !Array.isArray(data.bindings)) return
      if (project === undefined || project === null || project === '') return
      var target = null
      var next = data.bindings.map(function (item) {
        if (item !== null && item !== undefined && item.project === project) target = item
        return Object.assign({}, item, { current: item.project === project })
      })
      // 当前项排第一（与宿主 `boundProjects` 的顺序口径一致），否则「第一个就是当前」
      // 这条不变量在本地就破了，别处按 `bindings[0]` 取当前的地方会读到错的。
      next.sort(function (a, b) { return (b.current === true ? 1 : 0) - (a.current === true ? 1 : 0) })
      var patch = { bindings: next, project: project, currentProject: project }
      // 第 3 条：目标项目的模式 / 健康性就地从胶囊取（没有就跳过，别写 undefined
      // 把已有字段冲掉——那会让面板显示成空白）。
      //
      // **只补这两个字段，不碰 `modules`**：胶囊里带的是 `moduleCount`（个数）而不是模块列表，
      // 没法据此填对；若清空又会多一次「模块区闪一下空」的抖动。模块列表的权威值由随后的
      // `load()` 给。这是**已知的、刻意留下的**同族残留（窗口期内模块区可能还是上一个项目的），
      // 比「显示错模式」轻，且没有便宜的本地数据可填——不要以为它也被修了。
      if (target !== null) {
        if (typeof target.mode === 'string' && target.mode !== '') patch.mode = target.mode
        if (typeof target.health === 'number') patch.health = target.health
      }
      setState({ data: Object.assign({}, data, patch) })
    }

    /**
     * 在**已绑定的**项目之间切换当前项目（只切，不改绑定集合）。
     *
     * 与 `bindTo` 分开：`bindTo` 是「改绑」（会动绑定集合），这个只动「当前是哪个」。
     * 面板的胶囊切换走这条——点一下就把当前切过去，别的绑定原样留着。
     */
    function switchCurrent(view, project) {
      var sessionId = view.state.sessionId
      if (sessionId === undefined || sessionId === null || project === undefined || project === null || project === "") return
      setState({ loading: true })
      post({ method: 'current', sessionId: String(sessionId), project: String(project) })
        .then(function (json) {
          if (json && json.ok === true) {
            setState({ error: null, loading: false, detail: null, detailName: null })
            // **先本地把当前项改掉**，再拉 state：`current` 的返回不带 `bindings`，
            // 不补这一步胶囊会塌掉（用户报的「切着切着胶囊没了」）。
            markCurrentLocal(view, project)
          } else {
            setState({ error: (json && json.error) || '切换失败', loading: false })
          }
          load(sessionId)
          // 当前项目换了 → 主文档 / 工作流 / 模块列表都是另一个项目的了，必须重拉。
          loadMain(sessionId, project)
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
        })
    }

    /** 解绑**一个**项目（面板每项那个 `×`）；不动别的绑定。 */
    function unbindOneProject(view, project) {
      var sessionId = view.state.sessionId
      if (sessionId === undefined || sessionId === null || project === undefined || project === null || project === "") return
      setState({ loading: true })
      post({ method: 'unbind', sessionId: String(sessionId), project: String(project) })
        .then(function (json) {
          if (json && json.ok === true) setState({ error: null, loading: false, detail: null, detailName: null })
          else setState({ error: (json && json.error) || '解绑失败', loading: false })
          load(sessionId)
          loadMain(sessionId)
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
        })
    }

    function writeMode(sessionId, mode, project) {
      if (sessionId === undefined || sessionId === null) return
      setState({ loading: true })
      /**
       * 与 `sizeBlock` 同一处纪律：**按下即亮**。
       *
       * 模式按钮原先也要等回包才变色（写盘 + 重读 + 回包），用户报的「延时切换」是同一个
       * 症状。`mode` 与 `size` 是面板上最直接的两个开关，反馈必须跟手。
       * 这里没有「假态」问题（`data.mode` 本来就来自宿主），所以只做乐观更新。
       */
      var fresh = state.data
      if (fresh !== null && fresh !== undefined) {
        setState({ data: Object.assign({}, fresh, { mode: mode }) })
      }
      var body = { method: 'mode', sessionId: String(sessionId), mode: mode }
      if (project !== undefined && project !== null && project !== '') body.project = String(project)
      post(body)
        .then(function (json) {
          // 回包是权威值（带 `mode` / `limits` / 绑定组）。
          if (json && json.ok === true) setState({ data: mergePanelData(json.result), error: null, loading: false })
          // 失败要**回宿主重读**：乐观更新已经把模式翻过去了，不拉回来面板就停在假态上。
          else {
            setState({ error: (json && json.error) || '模式写入失败', loading: false })
            load(String(sessionId))
          }
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
          load(String(sessionId))
        })
    }

    /* --------------------------------- 样式 --------------------------------- */

    /**
     * 主题令牌：**换肤唯一入口**。
     *
     * 为什么内联在这里、不拆成 `lib/theme.js`：浏览器半是**手写的 module-loader 包**，
     * 它的 `require` 只认平台种子与「已注册的包工厂」——裸相对路径 `./theme.js`
     * 会直接抛 `missed the module table`（实测宿主 `dsh-client-modules` 的实现如此）。
     * 拆出去就是一个永远加载不了的文件，所以主题必须留在本文件内。
     *
     * 为什么仍然值得单独成块：用户裁定「先做 A 科幻 HUD，真机验过不好再退 D 极简」。
     * 换风格的代价必须是**改这一块**，而不是满文件找颜色值——所以下面所有 CSS
     * 都只引用 `--dshpz-*`，不写死任何颜色/圆角/阴影。
     *
     * 与宿主的关系：宿主（`dsh-client-ui-theme`）只有 99 个 `--dsw-alias-*` **语义**
     * 令牌，**没有**字体/圆角/阴影/间距令牌。所以这里分两层：
     *   1) 基底（bg/label/border/state）**收口宿主令牌** → 宿主切浅色/深色主题时面板自动跟随；
     *   2) HUD 部分（主色、发光、玻璃、尺度、字体栈）宿主没有，自建。
     *
     * 硬约束（用户裁定）：零新依赖、零外部资源。所有特效纯 CSS，图标内联 SVG。
     */
    var THEME_HUD = {
      // 基底：值仍是宿主令牌，所以主题跟随宿主
      bg1: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      bg3: 'var(--dsw-alias-bg-layer-3)',
      bgOverlay: 'var(--dsw-alias-bg-overlay)',
      label1: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      label3: 'var(--dsw-alias-label-tertiary)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      // HUD 自建：青蓝主色。发光**只给当前状态**用——满屏发光是页游，不是 3A。
      accent: '#22d3ee',
      accentHi: '#5eead4',
      accentLo: '#0e7490',
      /**
       * 主色之上的**前景色**：实心主色按钮/徽标里的文字。
       *
       * 为什么必须是深色而不是 `#fff`：主色是亮青（#22d3ee），白字在上面几乎读不出来。
       * 这类「主色的对比色」在宿主令牌里没有对应项，所以只能自建，但**必须收进令牌**——
       * 否则换 D 极简主题（主色变成宿主品牌色，可能是深色）时，这里就会变成白底白字。
       */
      onAccent: '#04121a',
      /**
       * 面板底色。
       *
       * `color-mix()` 需要 Chrome 111+ / Safari 16.2+。它在这里若用来做**半透明底色**，
       * 老浏览器上的退化结果是「整个面板变透明」——连下面的对话都盖不住，那是坏掉而不是降级。
       * 所以基底一律用宿主的**不透明**令牌，半透明/光晕只作为叠加层（`glassSheen`）。
       */
      glass: 'var(--dsw-alias-bg-overlay)',
      /** 叠加在底色上的极淡主色光晕：纯装饰，不支持 color-mix 时整层消失也无妨。 */
      glassSheen: 'linear-gradient(135deg,color-mix(in srgb,#22d3ee 9%,transparent),transparent 62%)',
      /** 网格/扫描线：纯装饰，不支持时整层消失（`transparent` 兜底）。 */
      grid: 'color-mix(in srgb, #22d3ee 10%, transparent)',
      /**
       * 发光：只给「当前状态」（选中页签、达标进度、聚焦输入框）用。
       * 退化值是一道**实心描边**而不是无：老浏览器上仍然看得见「哪个是选中的」，
       * 只是少了光晕。发光本身是效果，选中态是信息——信息不能因兼容性丢掉。
       */
      glow: '0 0 0 1px #22d3ee',
      shadow: '0 1px 2px rgba(0,0,0,.4), 0 24px 64px -12px rgba(0,0,0,.65)',
      radiusSm: '6px',
      radiusMd: '10px',
      radiusLg: '16px',
      fontUi: 'system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif',
      fontMono: 'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace',
      durIn: '260ms',
      durFast: '120ms',
      easeOut: 'cubic-bezier(.16,1,.3,1)',
      easeStd: 'cubic-bezier(.4,0,.2,1)',
    }

    /**
     * D 案：现代极简（备选）。
     *
     * 用户原话「先做 A，我真机验过不好再 D」——所以这份先写好放着。
     * 它与 A **共用全部布局与结构**，差别只在颜色/发光/圆角：
     * 真机不满意时把 `THEME` 指向它即可，不必改任何 CSS。
     */
    var THEME_MINIMAL = {
      bg1: 'var(--dsw-alias-bg-layer-1)',
      bg2: 'var(--dsw-alias-bg-layer-2)',
      bg3: 'var(--dsw-alias-bg-layer-3)',
      bgOverlay: 'var(--dsw-alias-bg-overlay)',
      label1: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      label3: 'var(--dsw-alias-label-tertiary)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      // 极简：主色跟随宿主品牌色、不透明底、无网格、无发光、单层轻投影。
      accent: 'var(--dsw-alias-brand-primary)',
      accentHi: 'var(--dsw-alias-brand-primary)',
      accentLo: 'var(--dsw-alias-brand-primary)',
      // 极简主题的主色是宿主品牌色（深浅不定），所以前景直接取宿主的反色令牌——
      // 这是「为什么对比色必须收进令牌」的实证：A 案写死深色，D 案就必须换成反色。
      onAccent: 'var(--dsw-alias-label-primary-inverted)',
      glass: 'var(--dsw-alias-bg-overlay)',
      // 极简不要光晕层：`none` 是合法 background-image 值，规则层不必为此写分支。
      glassSheen: 'none',
      grid: 'transparent',
      glow: '0 0 0 1px var(--dsw-alias-border-l2)',
      shadow: '0 12px 40px rgba(0,0,0,.28)',
      radiusSm: '8px',
      radiusMd: '14px',
      radiusLg: '20px',
      fontUi: 'system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif',
      fontMono: 'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace',
      durIn: '200ms',
      durFast: '100ms',
      easeOut: 'cubic-bezier(.16,1,.3,1)',
      easeStd: 'cubic-bezier(.4,0,.2,1)',
    }

    /** 当前生效主题。**换肤只改这一行**：THEME_HUD ↔ THEME_MINIMAL。 */
    var THEME = THEME_HUD

    /**
     * 主题对象 → `--dshpz-*: 值` 声明串。
     *
     * 命名转换必须**同时**处理两种边界，否则变量名对不上、属性静默失效：
     *   - 大写字母：`accentHi` → `accent-hi`（驼峰）
     *   - 字母接数字：`label1` → `label-1`（**这一条曾经漏掉**：`label1` 被转成
     *     `--dshpz-label1`，而 CSS 里写的是 `var(--dshpz-label-1)`，于是 bg/label/border
     *     这 8 个基底变量**全部取不到值**——面板会退回继承色，肉眼看着「还行」，
     *     但主题令牌整套是废的。这类 bug 不会报错，只能靠「逐个变量核对」抓出来。）
     */
    function themeVars(theme) {
      var out = []
      for (var key in theme) {
        if (!Object.prototype.hasOwnProperty.call(theme, key)) continue
        var cssKey = key
          .replace(/([a-z])([0-9])/g, '$1-$2')
          .replace(/[A-Z]/g, function (ch) { return '-' + ch.toLowerCase() })
        out.push('--dshpz-' + cssKey + ':' + theme[key])
      }
      return out.join(';')
    }

    /**
     * 面板样式。
     *
     * 布局：**宽屏三栏工作台**（左＝项目与操作，中＝健康性与模块，右＝文档与审查），
     * 窄屏（<900px）自动堆叠回单栏——手机端一行不改也能用。
     * 断点只有一个（900px）：多断点会让「手机/电脑」两套意图变得难以维护。
     */
    var CSS = [
      /**
       * 面板的令牌一律走 `--dshpz-*`，声明在 `:root`（见下一条）。
       *
       * `--dshpz-bg-*` / `--dshpz-label-*` / `--dshpz-border-*` 的**默认值**收口宿主的
       * `--dsw-alias-*` 语义令牌，所以宿主切浅色/深色时面板自动跟随；
       * 主色、发光、玻璃、尺度、字体栈宿主没有，自建（见 `THEME_HUD`）。
       */
      // 令牌挂在 `:root` 上：作用域靠 `--dshpz-` 前缀与 `.dshpz-*` 选择器收窄，
      // 而不是靠挂载点——因为小按钮不在 `.dshpz-panel` 里（见上面那条注释）。
      /**
       * 主题令牌挂在 **`:root`** 而不是 `.dshpz-panel` 上（v0.25.0 改）。
       *
       * 为什么必须换位置：用户裁定的作用域是「面板 **+ 那颗小按钮**」，而小按钮
       * 属于 `conversation.input.left`、**不在** `.dshpz-panel` 里。令牌原先只声明在
       * `.dshpz-panel` 上，按钮里的 `var(--dshpz-*)` 一律取不到值（静默失效）——
       * 按钮因此拿不到主题色，「跟着变色」根本做不到。
       *
       * 为什么挂全局也不会污染宿主：这些变量名全部带 `--dshpz-` 前缀，只有本插件的
       * `.dshpz-*` 类会读它们；宿主与别的插件看不到这个名字。同理，用户主题在
       * `:root` 里覆盖这些变量是安全的——白名单也强制它们只能改 `--dshpz-*`。
       */
      ':root{' + themeVars(THEME) + '}',

      /* ------------------------------- 外壳与入场 ------------------------------- */
      // `inset:0` 是 Chrome 87+（2020-11）才有的简写。老 WebView 会**整条丢弃**它，
      // 于是 fixed 元素没有偏移量 → 塌成内容大小、停在静态位置（左上角）、盖不住屏幕，
      // 而 `.dshpz-panel` 的 `width:min(...)`（Chrome 79+）若一起失效，
      // 三栏网格（264 + 1fr + 424）就被塞进一个内容宽的窄框里 → **列与列重叠**。
      // 实测症状正是「面板缩在左上角、文字互相压着、宿主 UI 透出来」。
      // 所以这里一律用**长手写 top/right/bottom/left**，不用 inset 简写。
      // **没有遮罩底色**（v0.27.1，用户裁定「打开面板的遮罩删掉」）：这一层现在只做
      // 「居中 + 点外部关闭」的定位与命中，不再压暗宿主 UI——面板自己的玻璃底
      // （`--dshpz-glass` + `backdrop-filter`）已经保证可读性，那层黑是多余的。
      // 注意它**仍是全屏且 `pointer-events:auto`**：点面板外面一下＝关面板（原行为不变），
      // 所以「看起来能点宿主、其实被吃掉一次点击」这件事与改动前一致，不是新问题。
      '.dshpz-backdrop{position:fixed;top:0;right:0;bottom:0;left:0;pointer-events:auto;display:flex;align-items:center;justify-content:center;padding:24px;z-index:40;animation:dshpz-fade var(--dshpz-dur-in) var(--dshpz-ease-out)}',
      '@keyframes dshpz-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes dshpz-rise{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}',
      '@keyframes dshpz-grow{from{transform:scaleX(0)}}',
      '@keyframes dshpz-sheen{from{background-position:-160% 0}to{background-position:260% 0}}',
      // 面板：玻璃底 + 网格纹理 + 顶部一道主色高光。网格用 repeating-linear-gradient 纯 CSS 画，不引图片。
      // **宽度与高度先给纯 CSS 2.1 的写法，再用 min() 覆盖**：`min()` 不认时前面的声明仍然生效，
      // 面板至少是「一屏宽、不超视口高」，而不是退化成内容宽度把三栏挤成一团。
      '.dshpz-panel{position:relative;width:100%;max-width:1240px;max-height:88vh;width:min(1240px,100%);max-height:min(88vh,940px);display:flex;flex-direction:column;overflow:hidden;background-color:var(--dshpz-glass);background-image:var(--dshpz-glass-sheen);color:var(--dshpz-label-1);border:1px solid var(--dshpz-border-2);border-radius:var(--dshpz-radius-lg);box-shadow:var(--dshpz-shadow);font-family:var(--dshpz-font-ui);font-size:13px;animation:dshpz-rise var(--dshpz-dur-in) var(--dshpz-ease-out)}',
      // 背景模糊单独一条：老浏览器不认就整条丢弃，底色与内容都不受影响。
      //
      // **`color-mix` 必须再套一层 `@supports`**（v0.16.2 修的）：
      // 外层只问 `backdrop-filter`，而 `color-mix` 是另一项独立特性
      // （Chrome 111+ / Safari 16.2+）。浏览器完全可能「认 backdrop-filter 但不认 color-mix」
      // ——比如 Chrome 76~110：`@supports` 判定通过、进了这个块，
      // 但 `background-color:color-mix(...)` 是**无效值**，会被整条丢弃。
      // 后果不是「没模糊」，而是 `background-color` 在这个块里**被覆盖成无效**，
      // 基底那条 `background-color:var(--dshpz-glass)` 也一起失效 → **面板变成全透明**，
      // 宿主 UI 从面板底下透出来。这正是「面板透明、文字与宿主内容重叠」的成因。
      // 现在只有**两项都支持**时才覆盖底色，否则老老实实用不透明基底。
      '@supports ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.dshpz-panel{backdrop-filter:blur(18px) saturate(1.2);-webkit-backdrop-filter:blur(18px) saturate(1.2)}}',
      '@supports (color:color-mix(in srgb,red 50%,blue)){.dshpz-panel{background-color:color-mix(in srgb,var(--dshpz-glass) 88%,transparent)}}',
      '.dshpz-panel::before{content:"";position:absolute;top:0;right:0;bottom:0;left:0;pointer-events:none;background-image:linear-gradient(var(--dshpz-grid) 1px,transparent 1px),linear-gradient(90deg,var(--dshpz-grid) 1px,transparent 1px);background-size:34px 34px;mask-image:radial-gradient(120% 90% at 50% 0,#000 30%,transparent 78%);-webkit-mask-image:radial-gradient(120% 90% at 50% 0,#000 30%,transparent 78%)}',
      '.dshpz-panel::after{content:"";position:absolute;left:0;right:0;top:0;height:1px;pointer-events:none;background:linear-gradient(90deg,transparent,var(--dshpz-accent),transparent);opacity:.75}',
      // 面板内所有滚动条统一成细的，避免宿主默认粗条打断视觉。
      '.dshpz-panel *{scrollbar-width:thin;scrollbar-color:var(--dshpz-border-2) transparent}',
      '.dshpz-panel ::-webkit-scrollbar{width:8px;height:8px}',
      '.dshpz-panel ::-webkit-scrollbar-thumb{background:var(--dshpz-border-2);border-radius:99px}',

      /* --------------------------------- 页头 --------------------------------- */
      '.dshpz-head{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--dshpz-border-1);background:linear-gradient(180deg,color-mix(in srgb,var(--dshpz-accent) 7%,transparent),transparent)}',
      '.dshpz-logo{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;color:var(--dshpz-on-accent);background:linear-gradient(135deg,var(--dshpz-accent-hi),var(--dshpz-accent));box-shadow:0 0 16px -3px var(--dshpz-accent)}',
      '.dshpz-headtext{flex:1 1 auto;min-width:0}',
      '.dshpz-title{margin:0;font-size:15px;font-weight:650;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshpz-sub{font-size:11px;color:var(--dshpz-label-2);margin-top:1px;font-family:var(--dshpz-font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshpz-close{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);background:transparent;color:var(--dshpz-label-2);cursor:pointer;transition:color var(--dshpz-dur-fast) var(--dshpz-ease-std),border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),transform var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-close:hover{color:var(--dshpz-label-1);border-color:var(--dshpz-border-2);transform:translateY(-1px)}',
      '.dshpz-close:active{transform:translateY(0)}',

      /* ------------------------------ 三栏工作台 ------------------------------ */
      // 宽屏三栏：左（项目与操作）固定 260，中（数据）自适应，右（文档）420。
      //
      // **先给纯 CSS 2.1 的固定三列，再用 minmax 覆盖**（v0.16.2）：
      // `minmax()` 是 Chrome 57+，虽不算新，但一旦哪条声明整条被丢弃，
      // 三栏就会退化成「一列挤三份内容」——列与列**重叠**，正是截图里那个样子。
      // 固定列宽在窄屏本来就会被 `@media` 换成块级，所以这层兜底没有副作用。
      '.dshpz-body{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:264px auto 424px;grid-template-columns:264px minmax(0,1fr) 424px;gap:0}',
      '.dshpz-col{min-width:0;overflow:auto;padding:14px 16px}',
      '.dshpz-col + .dshpz-col{border-left:1px solid var(--dshpz-border-1)}',
      // 单栏堆叠时（手机/窄窗）取消分栏与左边框，回到纵向流。
      // 同时**收起页头的健康性徽标**：窄屏上它会和副标题挤成两行，
      // 而中栏的环形总览本来就把这个数字放得更大——重复且更差。
      //
      // 手机端滑不动的原因（实测）：窄屏把 `.dshpz-col` 改成 `overflow:visible` 后，
      // 三栏内容整体高度**超出** `.dshpz-body`（`flex:1 1 auto;min-height:0`），
      // 而面板是 `overflow:hidden` + `max-height:92vh` —— 多出来的部分被裁掉，
      // 里面又没有可滚动容器，于是手指往上推什么也不动。
      // 修法：窄屏把 `.dshpz-body` 从 grid 换成块级并**自己滚动**（`overflow-y:auto`），
      // 页头仍然 `flex:0 0 auto` 钉在顶部；`overscroll-behavior:contain` 防止
      // 滑到底后把滚动链传给宿主页面（那会让面板被拖走）。
      '@media (max-width:900px){.dshpz-body{display:block;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}.dshpz-col{overflow:visible}.dshpz-col + .dshpz-col{border-left:0;border-top:1px solid var(--dshpz-border-1)}.dshpz-panel{max-height:92vh;width:100%}.dshpz-backdrop{padding:10px}.dshpz-head .dshpz-heroval{display:none}}',

      /* -------------------------------- 区块 -------------------------------- */
      '.dshpz-sect{margin-top:14px}',
      '.dshpz-sect:first-child{margin-top:0}',
      // 小节标题：左侧一道主色竖条 + 等宽大写，是 HUD 的「分区标牌」。
      '.dshpz-secttitle{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;color:var(--dshpz-label-2);margin-bottom:8px}',
      '.dshpz-secttitle::before{content:"";flex:0 0 auto;width:2px;height:11px;border-radius:2px;background:linear-gradient(180deg,var(--dshpz-accent-hi),var(--dshpz-accent-lo))}',
      '.dshpz-secttitle .dshpz-count{margin-left:auto;font-family:var(--dshpz-font-mono);font-size:10px;color:var(--dshpz-label-3);letter-spacing:0;text-transform:none}',

      /* -------------------------------- 控件 -------------------------------- */
      '.dshpz-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);background:transparent;color:var(--dshpz-label-2);cursor:pointer;font-size:12px;line-height:1;font-family:inherit;transition:color var(--dshpz-dur-fast) var(--dshpz-ease-std),border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),background var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-btn:hover{color:var(--dshpz-label-1);border-color:var(--dshpz-border-2);background:var(--dshpz-bg-2)}',
      '.dshpz-btn[data-on="1"]{color:var(--dshpz-accent);border-color:var(--dshpz-accent);box-shadow:var(--dshpz-glow)}',
      // 主按钮：唯一使用实心主色的控件，用来标记「这一步是主动作」。
      '.dshpz-act{display:inline-flex;align-items:center;gap:5px;background:transparent;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);color:var(--dshpz-label-2);padding:5px 10px;font-size:12px;cursor:pointer;font-family:inherit;line-height:1.2;text-align:left;transition:color var(--dshpz-dur-fast) var(--dshpz-ease-std),border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),background var(--dshpz-dur-fast) var(--dshpz-ease-std),transform var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-act:hover{color:var(--dshpz-label-1);border-color:var(--dshpz-border-2);background:var(--dshpz-bg-2);transform:translateY(-1px)}',
      '.dshpz-act:active{transform:translateY(0)}',
      '.dshpz-act[data-on="1"]{color:var(--dshpz-accent);border-color:var(--dshpz-accent);background:color-mix(in srgb,var(--dshpz-accent) 12%,transparent);box-shadow:var(--dshpz-glow)}',
      '.dshpz-act[data-tone="danger"]:hover{color:var(--dshpz-err);border-color:var(--dshpz-err)}',
      '.dshpz-acts{display:flex;flex-wrap:wrap;gap:6px}',
      '.dshpz-acts-vert{display:flex;flex-direction:column;gap:6px}',
      '.dshpz-acts-vert .dshpz-act{justify-content:flex-start;width:100%}',
      // 横向一组按钮（规模三档）：等宽铺开，选中态用 data-on 高亮。
      '.dshpz-acts-horiz{display:flex;flex-direction:row;gap:6px}',
      '.dshpz-acts-horiz .dshpz-act{flex:1 1 0;justify-content:center}',
      '.dshpz-acts-horiz .dshpz-act[data-on="1"]{outline:1px solid currentColor;font-weight:600}',
      '.dshpz-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dshpz-muted{color:var(--dshpz-label-2);font-size:12px}',
      '.dshpz-mono{font-family:var(--dshpz-font-mono);font-size:11px}',

      /* ------------------------------- 健康性总览 ------------------------------- */
      // 大数字 + 环形进度：整块面板的「主读数」，一眼看到项目状态。
      '.dshpz-hero{display:flex;align-items:center;gap:14px;padding:12px;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-md);background:linear-gradient(135deg,color-mix(in srgb,var(--dshpz-accent) 8%,transparent),transparent 60%)}',
      '.dshpz-ring{flex:0 0 auto;position:relative;width:74px;height:74px}',
      '.dshpz-ring svg{display:block;transform:rotate(-90deg)}',
      '.dshpz-ringcircle{fill:none;stroke:var(--dshpz-bg-3);stroke-width:7}',
      '.dshpz-ringfill{fill:none;stroke:url(#dshpz-ringgrad);stroke-width:7;stroke-linecap:round;transition:stroke-dashoffset 700ms var(--dshpz-ease-out)}',
      '.dshpz-ringnum{position:absolute;top:0;right:0;bottom:0;left:0;display:flex;align-items:center;justify-content:center;font-family:var(--dshpz-font-mono);font-size:19px;font-weight:650;color:var(--dshpz-label-1)}',
      '.dshpz-herotext{min-width:0}',
      '.dshpz-herolabel{font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:var(--dshpz-label-2)}',
      '.dshpz-heroval{font-size:13px;color:var(--dshpz-label-1);margin-top:2px}',

      /* --------------------------------- 五维 --------------------------------- */
      '.dshpz-dims{display:flex;flex-direction:column;gap:7px}',
      '.dshpz-dim{display:grid;grid-template-columns:82px minmax(0,1fr) 62px;align-items:center;gap:9px;font-size:12px}',
      '.dshpz-dimname{color:var(--dshpz-label-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshpz-dimbar{position:relative;height:6px;border-radius:99px;background:var(--dshpz-bg-3);overflow:hidden}',
      '.dshpz-dimfill{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--dshpz-accent-lo),var(--dshpz-accent-hi));transform-origin:left;animation:dshpz-grow 700ms var(--dshpz-ease-out)}',
      // 真实值对照行：名字 / 声明→实测 / 差额标签。**与 .dshpz-dim 分开**——
      // 两者子元素个数不同（这里是 3 列对照，上面是「名字+条+值」），
      // 硬塞进同一个 grid 模板会让其中一边错位。
      '.dshpz-dimcmp{display:grid;grid-template-columns:82px minmax(0,1fr) auto;align-items:center;gap:9px;font-size:12px}',
      '.dshpz-dimcmp .dshpz-dimbar{grid-column:2 / -1}',
      '.dshpz-dimpair{display:inline-flex;align-items:baseline;gap:6px;font-family:var(--dshpz-font-mono);font-size:11px;color:var(--dshpz-label-2)}',
      // 真实值用一层半透明的「第二段」压在声明值上，直接看出虚高多少。
      '.dshpz-dimtrue{position:absolute;left:0;top:0;height:100%;border-radius:99px;background:color-mix(in srgb,var(--dshpz-warn) 70%,transparent)}',
      '.dshpz-dimval{text-align:right;font-family:var(--dshpz-font-mono);font-size:11px;color:var(--dshpz-label-2);white-space:nowrap}',
      '.dshpz-dimval[data-true="1"]{color:var(--dshpz-accent);font-weight:650}',
      '.dshpz-dimcmp[data-bad="1"] .dshpz-dimval[data-true="1"]{color:var(--dshpz-err)}',
      '.dshpz-arrow{color:var(--dshpz-label-3);font-size:10px}',
      '.dshpz-dimnote{grid-column:1 / -1;color:var(--dshpz-label-3);font-size:10px;line-height:1.35;margin-top:-2px}',

      /* -------------------------------- 模块卡 -------------------------------- */
      '.dshpz-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(126px,1fr));gap:8px}',
      '.dshpz-tile{position:relative;display:flex;flex-direction:column;gap:6px;min-height:84px;padding:9px;text-align:left;color:inherit;font:inherit;cursor:pointer;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-md);background:var(--dshpz-bg-1);overflow:hidden;transition:border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),transform var(--dshpz-dur-fast) var(--dshpz-ease-std),box-shadow var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      // 悬停时卡片抬 1px + 出现主色边——比整块变色克制，也更像「可点」。
      '.dshpz-tile:hover{border-color:var(--dshpz-accent);transform:translateY(-1px);box-shadow:0 6px 18px -10px var(--dshpz-accent)}',
      '.dshpz-tile[data-on="1"]{border-color:var(--dshpz-accent);box-shadow:var(--dshpz-glow)}',
      '.dshpz-tile[data-empty="1"]{opacity:.45}',
      '.dshpz-tile[data-static="1"]{cursor:default}',
      '.dshpz-tile b{font-size:12px;font-weight:600;line-height:1.25;word-break:break-word}',
      '.dshpz-tilebar{height:4px;border-radius:99px;background:var(--dshpz-bg-3);overflow:hidden}',
      '.dshpz-tilefill{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--dshpz-ok),var(--dshpz-accent-hi));transform-origin:left;animation:dshpz-grow 600ms var(--dshpz-ease-out)}',
      '.dshpz-pct{font-family:var(--dshpz-font-mono);font-size:10px;color:var(--dshpz-label-2)}',

      /* ------------------------------- 分段控件 ------------------------------- */
      '.dshpz-seg{display:inline-flex;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);overflow:hidden;background:var(--dshpz-bg-1)}',
      '.dshpz-seg button{background:transparent;border:0;color:var(--dshpz-label-2);padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit;transition:background var(--dshpz-dur-fast) var(--dshpz-ease-std),color var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-seg button:hover{color:var(--dshpz-label-1);background:var(--dshpz-bg-2)}',
      '.dshpz-seg button[data-on="1"]{background:linear-gradient(135deg,var(--dshpz-accent),var(--dshpz-accent-lo));color:var(--dshpz-on-accent);font-weight:600}',

      /* -------------------------------- 提示条 -------------------------------- */
      '.dshpz-notice{display:flex;gap:7px;align-items:flex-start;margin:10px 0 0;padding:8px 10px;border:1px solid color-mix(in srgb,var(--dshpz-accent) 45%,transparent);border-radius:var(--dshpz-radius-sm);background:color-mix(in srgb,var(--dshpz-accent) 10%,transparent);color:var(--dshpz-label-1);font-size:12px;line-height:1.45}',
      '.dshpz-err{display:flex;gap:7px;align-items:flex-start;margin:10px 0 0;padding:8px 10px;border:1px solid color-mix(in srgb,var(--dshpz-err) 50%,transparent);border-radius:var(--dshpz-radius-sm);background:color-mix(in srgb,var(--dshpz-err) 10%,transparent);color:var(--dshpz-err);font-size:12px;line-height:1.45}',
      '.dshpz-warn{display:flex;gap:7px;align-items:flex-start;margin:10px 0 0;padding:8px 10px;border:1px solid color-mix(in srgb,var(--dshpz-warn) 50%,transparent);border-radius:var(--dshpz-radius-sm);background:color-mix(in srgb,var(--dshpz-warn) 10%,transparent);color:var(--dshpz-warn);font-size:12px;line-height:1.45}',
      '.dshpz-hint{margin-top:12px;padding-top:10px;border-top:1px solid var(--dshpz-border-1);color:var(--dshpz-label-2);font-size:11.5px;line-height:1.6}',

      /* --------------------------------- 详情 --------------------------------- */
      '.dshpz-detail{margin-top:12px;padding:11px;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-md);background:var(--dshpz-bg-1)}',
      '.dshpz-detail h4{margin:0 0 7px;font-size:13px;display:flex;align-items:center;gap:7px}',

      /* ------------------------------ 条目（书签） ------------------------------ */
      '.dshpz-entries{display:flex;flex-direction:column;gap:4px;margin:0 0 10px}',
      // 每条左侧一道细条：合规=中性、不合规=警告色。比整条描边更省视觉噪音。
      '.dshpz-entry{display:flex;align-items:flex-start;gap:7px;font-size:12px;line-height:1.5;background:var(--dshpz-bg-1);border:1px solid var(--dshpz-border-1);border-left-width:3px;border-radius:var(--dshpz-radius-sm);padding:6px 9px;transition:border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),background var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-entry:hover{background:var(--dshpz-bg-2)}',
      '.dshpz-entry[data-bad="1"]{border-left-color:var(--dshpz-warn)}',
      '.dshpz-entry:not([data-bad="1"]){border-left-color:var(--dshpz-border-2)}',
      '.dshpz-entrynum{flex:0 0 auto;min-width:18px;font-family:var(--dshpz-font-mono);font-size:10px;color:var(--dshpz-label-3);padding-top:2px}',
      '.dshpz-entrybody{flex:1 1 auto;color:var(--dshpz-label-1);word-break:break-word}',
      '.dshpz-entrysrc{font-family:var(--dshpz-font-mono);color:var(--dshpz-label-3);font-size:10.5px}',
      '.dshpz-entryflag{flex:0 0 auto;color:var(--dshpz-warn);font-size:10px;white-space:nowrap;border:1px solid color-mix(in srgb,var(--dshpz-warn) 45%,transparent);border-radius:99px;padding:1px 6px}',

      /* --------------------------------- 表单 --------------------------------- */
      '.dshpz-in{display:block;width:100%;box-sizing:border-box;margin-bottom:6px;background:var(--dshpz-bg-1);color:var(--dshpz-label-1);border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);padding:7px 9px;font-size:12px;font-family:inherit;transition:border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),box-shadow var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-in:focus{outline:none;border-color:var(--dshpz-accent);box-shadow:var(--dshpz-glow)}',
      '.dshpz-in::placeholder{color:var(--dshpz-label-3)}',
      '.dshpz-sel{background:var(--dshpz-bg-1);color:var(--dshpz-label-1);border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);padding:6px 8px;font-size:12px;font-family:inherit;max-width:100%}',
      /* ---- 绑定切换条（v0.20.0）：胶囊（2–4 个）+ 卡片兜底（≥5 个）---- */
      '.dshpz-bindwrap{display:flex;flex-direction:column;gap:4px}',
      '.dshpz-pills{display:flex;flex-wrap:wrap;gap:5px;align-items:center}',
      '.dshpz-pill{display:inline-flex;align-items:center;gap:5px;background:var(--dshpz-bg-1);color:var(--dshpz-label-2);border:1px solid var(--dshpz-border-1);border-radius:999px;padding:4px 9px;font-size:12px;font-family:inherit;cursor:pointer;transition:background var(--dshpz-dur-fast) var(--dshpz-ease-std),color var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-pill:hover{color:var(--dshpz-label-1);background:var(--dshpz-bg-2)}',
      /* 当前项高亮：渐变底 + 反色字，与执行模式分段控件同一套视觉语言。 */
      '.dshpz-pill[data-on="1"]{background:linear-gradient(135deg,var(--dshpz-accent),var(--dshpz-accent-lo));color:var(--dshpz-on-accent);border-color:transparent;font-weight:600}',
      '.dshpz-pillname{max-width:9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshpz-pillpct{opacity:.7;font-size:10.5px;font-variant-numeric:tabular-nums}',
      /* `×` 只在悬停时显形：常显会让每个胶囊都挤一个叉，看着像「危险操作」排成一行。 */
      '.dshpz-pillx{opacity:0;font-size:13px;line-height:1;padding:0 1px;border-radius:50%;transition:opacity var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-pill:hover .dshpz-pillx{opacity:.65}',
      '.dshpz-pillx:hover{opacity:1}',
      '.dshpz-pill-plus{padding:4px 10px;font-weight:600}',
      '.dshpz-addlist{display:flex;flex-direction:column;gap:3px;margin-top:4px;padding:5px;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);background:var(--dshpz-bg-1);max-height:170px;overflow:auto}',
      '.dshpz-bindcards{display:flex;flex-direction:column;gap:5px}',
      '.dshpz-bindcard{border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);padding:6px 8px;background:var(--dshpz-bg-1);cursor:pointer;display:flex;flex-direction:column;gap:3px}',
      '.dshpz-bindcard[data-on="1"]{border-color:var(--dshpz-accent)}',
      '.dshpz-bindcardtop{display:flex;align-items:center;gap:6px}',
      '.dshpz-bindcardnow{font-size:10px;padding:1px 5px;border-radius:999px;background:var(--dshpz-accent);color:var(--dshpz-on-accent)}',
      '.dshpz-bindbar{height:3px;border-radius:2px;background:var(--dshpz-bg-2);overflow:hidden}',
      '.dshpz-bindbar span{display:block;height:100%;background:linear-gradient(90deg,var(--dshpz-accent-lo),var(--dshpz-accent))}',
      '.dshpz-bindunbind{align-self:flex-start;background:transparent;border:1px solid var(--dshpz-border-1);color:var(--dshpz-label-2);border-radius:var(--dshpz-radius-sm);padding:2px 7px;font-size:11px;font-family:inherit;cursor:pointer}',
      '.dshpz-bindunbind:hover{color:var(--dshpz-label-1);background:var(--dshpz-bg-2)}',
      '.dshpz-sel:focus{outline:none;border-color:var(--dshpz-accent)}',


      /* ------------------------------- 发现（审查） ------------------------------- */
      '.dshpz-findings{display:flex;flex-direction:column;gap:7px}',
      // 扫描结果的勾选行（v0.21.0 ①）：目录名 + 证据文件，整行可点。
      '.dshpz-pickrow{display:flex;align-items:baseline;gap:7px;cursor:pointer;font-size:12px}',
      '.dshpz-pickname{font-weight:600}',
      '.dshpz-finding{display:flex;gap:8px;align-items:flex-start;border:1px solid var(--dshpz-border-1);border-left-width:3px;border-radius:var(--dshpz-radius-sm);padding:8px 10px;background:var(--dshpz-bg-1)}',
      '.dshpz-finding[data-level="blocker"]{border-left-color:var(--dshpz-err)}',
      '.dshpz-finding[data-level="warn"]{border-left-color:var(--dshpz-warn)}',
      '.dshpz-finding[data-level="info"]{border-left-color:var(--dshpz-border-2)}',
      '.dshpz-flevel{flex:0 0 auto;font-family:var(--dshpz-font-mono);font-size:10px;color:var(--dshpz-label-3);padding-top:1px;text-transform:uppercase}',
      '.dshpz-ffact{font-size:12px;line-height:1.5}',
      '.dshpz-ffix{font-size:11.5px;line-height:1.5;color:var(--dshpz-label-2);margin-top:3px}',

      /* ------------------------------- 主文档视图 ------------------------------- */
      '.dshpz-doc{margin:0;max-height:340px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:var(--dshpz-font-mono);font-size:11.5px;line-height:1.6;color:var(--dshpz-label-1);background:var(--dshpz-bg-1);border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);padding:10px}',
      '.dshpz-docpath{font-family:var(--dshpz-font-mono);font-size:10.5px;color:var(--dshpz-label-3);word-break:break-all;margin-bottom:6px}',

      /* ------------------------------- 工作流（流水线） ------------------------------- */
      // 工作流列表是**图块式**（与模块块同一套交互）：只显示「名字 + 几步」，点开才铺开步骤。
      '.dshpz-wflist{display:flex;flex-direction:column;gap:6px}',
      '.dshpz-wfitem{display:flex;flex-direction:column;gap:0;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);background:var(--dshpz-bg-1);overflow:hidden;transition:border-color var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-wfitem:hover{border-color:var(--dshpz-border-2)}',
      '.dshpz-wftile{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;text-align:left;color:inherit;font:inherit;cursor:pointer;background:transparent;border:0;border-left:3px solid var(--dshpz-accent)}',
      '.dshpz-wftile[data-on="1"]{background:var(--dshpz-bg-2)}',
      '.dshpz-wfname{flex:1 1 auto;font-size:12.5px;font-weight:600;line-height:1.35;word-break:break-word}',
      '.dshpz-wfcount{flex:0 0 auto;font-size:10.5px;color:var(--dshpz-label-3);white-space:nowrap}',
      '.dshpz-wfcaret{flex:0 0 auto;font-size:10px;color:var(--dshpz-label-3)}',
      // 展开后的步骤：**有序**（序号在左，与文档里的 1. 2. 3. 一致）。
      '.dshpz-wfsteps{display:flex;flex-direction:column;gap:4px;padding:8px 10px 4px 14px;border-top:1px solid var(--dshpz-border-1)}',
      '.dshpz-wfstep{display:flex;align-items:flex-start;gap:7px;font-size:12px;line-height:1.55}',
      '.dshpz-wfstepno{flex:0 0 auto;min-width:15px;text-align:right;font-family:var(--dshpz-font-mono);font-size:10.5px;color:var(--dshpz-accent);padding-top:2px}',
      '.dshpz-wfsteptext{flex:1 1 auto;color:var(--dshpz-label-1);word-break:break-word}',
      '.dshpz-wfops{display:flex;justify-content:flex-end;gap:6px;padding:0 10px 8px}',
      // 归档项：与正文条目同一形状，但**不可展开**（只显示名字与步数）。
      '.dshpz-wf{display:flex;align-items:flex-start;gap:7px;font-size:12px;line-height:1.5;background:var(--dshpz-bg-1);border:1px solid var(--dshpz-border-1);border-left:3px solid var(--dshpz-accent);border-radius:var(--dshpz-radius-sm);padding:6px 9px;transition:background var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-wf:hover{background:var(--dshpz-bg-2)}',
      '.dshpz-wf[data-arch="1"]{opacity:.62;border-left-color:var(--dshpz-border-2)}',
      '.dshpz-wfbody{flex:1 1 auto;color:var(--dshpz-label-1);word-break:break-word}',
      // 「永久删除」用危险色：与「恢复」并排时，不能让人一眼分不出哪个是不可逆的。
      '.dshpz-act[data-danger="1"]{color:var(--dshpz-err);border-color:var(--dshpz-err)}',
      '.dshpz-act[data-danger="1"]:hover{background:var(--dshpz-err);color:var(--dshpz-on-accent)}',

      /* -------------------------------- 空态 -------------------------------- */
      '.dshpz-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:26px 16px;text-align:center;color:var(--dshpz-label-2);border:1px dashed var(--dshpz-border-2);border-radius:var(--dshpz-radius-md);background:color-mix(in srgb,var(--dshpz-bg-1) 60%,transparent)}',
      '.dshpz-emptyicon{color:var(--dshpz-label-3)}',
      '.dshpz-emptytitle{font-size:13px;color:var(--dshpz-label-1);font-weight:600}',

      /* ------------------------------- 加载骨架 ------------------------------- */
      '.dshpz-skel{position:relative;overflow:hidden;height:12px;border-radius:6px;background:var(--dshpz-bg-2);margin-bottom:8px}',
      '.dshpz-skel::after{content:"";position:absolute;top:0;right:0;bottom:0;left:0;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--dshpz-label-1) 12%,transparent),transparent);background-size:160% 100%;animation:dshpz-sheen 1.3s linear infinite}',

      /* ------------------------------ 主题管理层 ------------------------------ */

      /**
       * 主题管理**不是浮层，而是面板主界面的一次切换**（v0.27.1，用户裁定
       * 「换成主题页改为直接切换原本的主界面」）。
       *
       * 原先它是一层 `.dshpz-tlayer` 全屏覆盖层压在面板之上（还带 `clip-path` 生长动画），
       * 于是同一个「面板」概念叠了两层玻璃框、两个关闭按钮、两级 Esc。
       * 现在主题页复用 `.dshpz-panel` 外壳、**替换**三栏主体：点主题图标 = 切到主题页，
       * 点返回（或 Esc）= 切回主界面。面板本身从头到尾只有一层。
       *
       * 随之删掉的：`.dshpz-tlayer` / `.dshpz-tpanel` / `@keyframes dshpz-tgrow`
       * 与 `themeOrigin`（生长动画的圆心）——它们只服务于那层已经不存在的浮层。
       */
      '.dshpz-thead{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:14px 18px;border-bottom:1px solid var(--dshpz-border-1);background:linear-gradient(180deg,color-mix(in srgb,var(--dshpz-accent) 7%,transparent),transparent)}',
      '.dshpz-tlogo{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;color:var(--dshpz-on-accent);background:linear-gradient(135deg,var(--dshpz-accent-hi),var(--dshpz-accent))}',
      '.dshpz-tbody{flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain;padding:14px 18px}',
      '.dshpz-tgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));gap:10px}',
      '.dshpz-tcard{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-md);background:var(--dshpz-bg-2);transition:border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),transform var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-tcard:hover{border-color:var(--dshpz-border-2);transform:translateY(-1px)}',
      '.dshpz-tcard[data-on="1"]{border-color:var(--dshpz-accent);box-shadow:var(--dshpz-glow)}',
      '.dshpz-tswatch{height:44px;border-radius:var(--dshpz-radius-sm);border:1px solid var(--dshpz-border-1)}',
      '.dshpz-tmeta{flex:1 1 auto;min-width:0}',
      '.dshpz-tname{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--dshpz-label-1)}',
      '.dshpz-tbadge{flex:0 0 auto;padding:1px 6px;border-radius:99px;font-size:10px;font-weight:500;letter-spacing:.3px;color:var(--dshpz-on-accent);background:var(--dshpz-accent)}',
      '.dshpz-tby{font-family:var(--dshpz-font-mono);font-size:10px;color:var(--dshpz-label-3);margin-top:2px}',
      '.dshpz-tdesc{font-size:11px;line-height:1.5;color:var(--dshpz-label-2);margin-top:4px}',
      '.dshpz-tacts{display:flex;gap:6px;flex-wrap:wrap}',
      '.dshpz-tfoot{flex:0 0 auto;padding:10px 18px;border-top:1px solid var(--dshpz-border-1);display:flex;flex-direction:column;gap:3px}',
      // 主题页现在就在面板外壳里，窄屏规则只收拾它自己那几块；
      // `.dshpz-tpanel` / `.dshpz-tlayer` 已随浮层一起删除，这里不能再引用它们
      // （引用了也不会报错，但那条规则永远是死的——本仓记过「守卫须能抓到漂移」）。
      '@media (max-width:900px){.dshpz-tgrid{grid-template-columns:1fr}.dshpz-thead{flex-wrap:wrap}}',

      /* --------------------------- 减少动效（无障碍） --------------------------- */
      // 尊重系统设置：用户开了「减少动态效果」就全部关掉，只保留状态切换本身。
      '@media (prefers-reduced-motion:reduce){.dshpz-backdrop,.dshpz-panel,.dshpz-dimfill,.dshpz-tilefill,.dshpz-skel::after{animation:none!important;transition:none!important}}',
    ].join('\n')

    /* --------------------------------- 图块 --------------------------------- */

    /** 五维的名字与顺序（与宿主 `HEALTH_DIMENSIONS` 对齐；UI 只读不改）。 */
    var DIMENSION_LABELS = {
      complexity: '任务复杂度',
      extensibility: '可拓展性',
      maintenance: '维护系数',
      quality: '代码质量',
      reusability: '可复用性',
    }
    var DIMENSION_KEYS = ['complexity', 'extensibility', 'maintenance', 'quality', 'reusability']

    /* ------------------------------- 图标（内联 SVG） ------------------------------- */

    /**
     * 图标一律内联 SVG：**零外部资源、零字体依赖**（用户裁定）。
     *
     * 用 `currentColor` 取色，所以图标自动跟随所在控件的文字颜色（悬停/选中态都跟着变），
     * 不需要为每个状态各写一份样式。
     */
    var ICON_PATHS = {
      // 拼图块：品牌标识与面板标题。
      puzzle: 'M6.2 1.5a1.7 1.7 0 0 1 1.7 1.7v.6h2.6v2.6h.6a1.7 1.7 0 0 1 0 3.4h-.6v2.6H7.9v-.6a1.7 1.7 0 0 0-3.4 0v.6H1.9V9.8h.6a1.7 1.7 0 0 1 0-3.4h-.6V3.8h2.6v-.6a1.7 1.7 0 0 1 1.7-1.7Z',
      // 刷新：环形箭头。
      refresh: 'M8 2.6a5.4 5.4 0 1 0 5.2 6.9h-1.6A3.9 3.9 0 1 1 8 4.1v1.7l2.6-2.3L8 1.2v1.4Z',
      // 关闭：叉。
      close: 'M4 4l8 8M12 4l-8 8',
      // 文档：纸页。
      doc: 'M4 1.8h5l3 3v9.4H4V1.8Zm5 0v3h3',
      // 规则/工作流：列表带勾。
      rules: 'M2.4 4.2l1.4 1.4 2.4-2.4M2.4 11l1.4 1.4 2.4-2.4M8.6 5h5.4M8.6 11.8h5.4',
      // 审查：放大镜。
      scan: 'M7.2 2.6a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2Zm3.4 7.9l3 3',
      // 模块：方块阵。
      grid: 'M2.4 2.4h4.4v4.4H2.4V2.4Zm6.8 0h4.4v4.4H9.2V2.4ZM2.4 9.2h4.4v4.4H2.4V9.2Zm6.8 0h4.4v4.4H9.2V9.2Z',
      // 警示：三角。
      alert: 'M8 2.2l6 10.6H2L8 2.2Zm0 4v3.4M8 11.6v.1',
      // 归档：盒。
      archive: 'M2.2 3h11.6v3H2.2V3Zm1 3v7h9.6V6M6.4 8.6h3.2',
    }

    /**
     * 画一个图标。`size` 默认 14（与 12px 正文的视觉重量匹配）。
     * `stroke` 型图标（close/rules/scan/doc/alert/archive）走描边，
     * `fill` 型（puzzle/refresh/grid）走填充——两类混用时靠视觉重量对齐，不靠同一套线宽。
     */
    function icon(name, size, opts) {
      var path = ICON_PATHS[name]
      if (path === undefined) return null
      var s = size === undefined ? 14 : size
      var filled = name === 'puzzle' || name === 'refresh' || name === 'grid'
      var extra = opts || {}
      var props = {
        width: s,
        height: s,
        viewBox: '0 0 16 16',
        'aria-hidden': true,
        style: { flex: '0 0 auto', display: 'block' },
      }
      if (filled) props.fill = 'currentColor'
      else {
        props.fill = 'none'
        props.stroke = 'currentColor'
        props.strokeWidth = extra.weight === 'bold' ? 2 : 1.5
        props.strokeLinecap = 'round'
        props.strokeLinejoin = 'round'
      }
      return h('svg', props, h('path', { d: path }))
    }

    /* ------------------------------- 健康性总览 ------------------------------- */

    /* ------------------------------ 主题管理层 ------------------------------ */

    /**
     * 主题管理页——**面板一角那颗图标点开的全屏覆盖层**（用户原话：
     * 「在面板一角放个图标点进去是主题管理不就行了？」）。
     *
     * 三块内容，按用户裁定的形态：
     *   1) 顶部固定一条：标题 + 当前主题 + **「恢复默认」一颗常驻按钮**（用户裁定放顶部固定）；
     *   2) **卡片墙**（网格）：每张卡用主题自己的 `accent` 做色块 + 名字 + 作者/版本，
     *      带「下载并应用」/「应用」/「卸载」；
     *   3) 底部：主题源（仓库）+ 拉取诊断（各镜像分别报了什么）。
     *
     * 为什么卡片用**主题自己声明的 accent** 上色：主题包只是 CSS，插件拿不到它的
     * 渲染结果，但清单里有 `accent` 一个色值——足够让每张卡「一眼看出是什么调」，
     * 又不至于为了预览去解析 CSS。
     */
    /**
     * 主题管理页 —— **面板主界面的一种视图**，不是压在面板上的浮层（v0.27.1）。
     *
     * 用户原话：「换成主题页改为直接切换原本的主界面」。
     * 改动前它是一层 `.dshpz-tlayer` 全屏覆盖层（带 `clip-path` 从图标生长的动画），
     * 于是屏幕上同时存在两套玻璃框、两个关闭按钮、两级 Esc——同一个「面板」叠了两层。
     * 现在它复用面板外壳，**替换**三栏主体：点图标进来，点「返回」或 Esc 回去。
     *
     * 返回值就是**整个 `.dshpz-panel`**（与 `panelBody` 同层级），由 `Panel` 二选一渲染。
     */
    function themePage(view) {
      var sessionId = view.state.sessionId
      var list = view.state.themeList
      var data = view.state.data
      var theme = data !== null && data !== undefined && data.theme !== undefined ? data.theme : null
      var current = theme !== null ? String(theme.current || '') : ''
      var currentName = theme !== null ? String(theme.currentName || '') : ''
      var installed = theme !== null && Array.isArray(theme.installed) ? theme.installed : []
      var installedMap = {}
      for (var i = 0; i < installed.length; i++) installedMap[installed[i].id] = installed[i]
      var busy = view.state.themeBusy

      var remote = list !== null && list !== undefined && Array.isArray(list.themes) ? list.themes : null
      var loading = list !== null && list !== undefined && list.loading === true
      var listError = list !== null && list !== undefined && list.error !== undefined ? String(list.error) : ''

      // 卡片的**并集**：远端有的 + 本机已装的。已装但远端清单里没有的（换过源、
      // 或主题被作者下架）仍要显示并能卸载——否则用户永远清不掉它。
      var cards = []
      var seen = {}
      if (remote !== null) {
        for (var r = 0; r < remote.length; r++) {
          var item = remote[r]
          cards.push({
            id: item.id, name: item.name, author: item.author, description: item.description,
            version: item.version, accent: item.accent, sha256: item.sha256,
            installed: installedMap[item.id] !== undefined,
          })
          seen[item.id] = true
        }
      }
      for (var k = 0; k < installed.length; k++) {
        var local = installed[k]
        if (seen[local.id] === true) continue
        cards.push({
          id: local.id, name: local.name, author: '', description: '', version: local.version,
          accent: local.accent, sha256: local.sha256, installed: true, localOnly: true,
        })
      }

      var head = h(
        'div',
        { className: 'dshpz-thead' },
        h('span', { className: 'dshpz-tlogo' }, icon('grid', 16)),
        h(
          'div',
          { className: 'dshpz-headtext' },
          h('h3', { className: 'dshpz-title' }, '主题'),
          h('div', { className: 'dshpz-sub' },
            current === '' ? '当前：默认皮肤（随宿主明暗）' : '当前：' + (currentName || current)),
        ),
        // 「恢复默认」固定在顶部（用户裁定）：换主题最怕回不去，所以它不跟着列表滚。
        h(
          'button',
          {
            className: 'dshpz-act',
            'data-tone': current === '' ? undefined : 'danger',
            disabled: current === '' || busy !== null,
            title: current === '' ? '现在就是默认皮肤' : '回到内置默认皮肤（不卸载已下载的主题）',
            onClick: function () { resetThemeNow(sessionId) },
          },
          h('span', null, '恢复默认'),
        ),
        h(
          'button',
          {
            className: 'dshpz-act',
            disabled: loading,
            title: '重新从主题仓库拉清单',
            onClick: function () { loadThemes(sessionId) },
          },
          h('span', null, loading ? '拉取中…' : '刷新列表'),
        ),
        h(
          'button',
          {
            className: 'dshpz-act',
            // 语义是**返回**而不是「关闭」：主题页是主界面的一种视图，
            // 关掉它等于关掉整个面板，那是右上角那颗 × 的事（用户会分不清）。
            title: '返回项目面板（Esc）',
            onClick: function () { setState({ themeOpen: false, themeNotice: null, themeError: null }) },
          },
          h('span', null, '← 返回'),
        ),
        h(
          'button',
          {
            className: 'dshpz-close',
            title: '关闭面板（Esc 先返回项目面板）',
            onClick: function () { setState({ open: false, themeOpen: false, detail: null, detailName: null, themeNotice: null, themeError: null }) },
          },
          icon('close', 15, { weight: 'bold' }),
        ),
      )

      var notices = []
      if (view.state.themeNotice !== null && view.state.themeNotice !== undefined) {
        notices.push(h('div', { className: 'dshpz-notice', key: 'ok' }, icon('alert', 14), h('span', null, String(view.state.themeNotice))))
      }
      if (view.state.themeError !== null && view.state.themeError !== undefined) {
        notices.push(h('div', { className: 'dshpz-err', key: 'err' }, icon('alert', 14), h('span', null, String(view.state.themeError))))
      }
      // 离线提示（用户裁定「用上次缓存 + 一条提示」）：清单来自缓存时**必须说清**，
      // 否则用户会以为看到的是最新的主题列表。
      if (list !== null && list !== undefined && list.cached === true) {
        notices.push(h('div', { className: 'dshpz-muted', key: 'cache' },
          '⚠ 当前离线（' + (listError || '拉取失败') + '），下面这份列表是上次成功拉到的缓存'
          + (list.fetchedAt ? '（' + String(list.fetchedAt).slice(0, 16).replace('T', ' ') + '）' : '')))
      }
      if (listError !== '' && (list === null || list === undefined || list.cached !== true)) {
        notices.push(h('div', { className: 'dshpz-err', key: 'list' }, icon('alert', 14), h('span', null, '拉主题清单失败：' + listError)))
      }
      // 各镜像的诊断（原样回显宿主的 `tried`）：拉不到时这一行才说得清是超时还是 404。
      var tried = list !== null && list !== undefined && Array.isArray(list.tried) ? list.tried : []
      if (tried.length > 0) {
        notices.push(h('div', {
          className: 'dshpz-muted', key: 'tried',
          style: { fontFamily: 'var(--dshpz-font-mono)', fontSize: '11px', lineHeight: '1.6' },
        }, tried.map(function (row, index) {
          return h('div', { key: String(index) }, String(row.channel) + ' → ' + String(row.error))
        })))
      }

      var grid = null
      if (loading) {
        grid = h('div', { className: 'dshpz-tgrid' },
          h('div', { className: 'dshpz-skel', style: { height: '86px' } }),
          h('div', { className: 'dshpz-skel', style: { height: '86px' } }),
          h('div', { className: 'dshpz-skel', style: { height: '86px' } }))
      } else if (cards.length === 0) {
        grid = h('div', { className: 'dshpz-muted', style: { padding: '18px 4px' } },
          '主题仓库里还没有主题。装一套皮肤只需要往仓库加一个 themes/<id>/{manifest.json,theme.css}，再跑一次 index 生成脚本。')
      } else {
        grid = h('div', { className: 'dshpz-tgrid' }, cards.map(function (card) {
          var isCurrent = card.id === current
          var isBusy = busy === card.id
          return h(
            'div',
            { className: 'dshpz-tcard', key: card.id, 'data-on': isCurrent ? '1' : '0' },
            // 色块：主题自己声明的 accent；没声明就退回中性底。
            h('div', {
              className: 'dshpz-tswatch',
              style: { background: card.accent !== '' ? card.accent : 'var(--dshpz-bg-3)' },
            }),
            h('div', { className: 'dshpz-tmeta' },
              h('div', { className: 'dshpz-tname' },
                String(card.name || card.id),
                isCurrent ? h('span', { className: 'dshpz-tbadge' }, '使用中') : null,
                card.localOnly === true ? h('span', { className: 'dshpz-tbadge' }, '仅本机') : null),
              h('div', { className: 'dshpz-tby' },
                (card.author !== '' ? String(card.author) : '佚名')
                + (card.version !== '' ? ' · v' + String(card.version) : '')
                + (card.sha256 === '' ? ' · 清单缺 hash（不可安装）' : '')),
              card.description !== '' ? h('div', { className: 'dshpz-tdesc' }, String(card.description)) : null,
            ),
            h('div', { className: 'dshpz-tacts' },
              // 「一个『下载并应用』」：未装的按钮就是它，点完直接生效。
              card.installed !== true
                ? h('button', {
                  className: 'dshpz-act',
                  disabled: isBusy || busy !== null || card.sha256 === '',
                  title: card.sha256 === '' ? '主题清单里这条缺 sha256，拒绝安装' : '下载、校验 sha256 与安全白名单后立即应用',
                  onClick: function () { installAndApplyTheme(sessionId, card.id) },
                }, h('span', null, isBusy ? '下载中…' : '下载并应用'))
                : h('button', {
                  className: 'dshpz-act',
                  'data-tone': isCurrent ? undefined : 'accent',
                  disabled: isBusy || busy !== null || isCurrent,
                  title: isCurrent ? '已经在用这个主题' : '切到这个已下载的主题（不联网）',
                  onClick: function () { applyInstalledTheme(sessionId, card.id) },
                }, h('span', null, isCurrent ? '使用中' : '应用')),
              card.installed === true
                ? h('button', {
                  className: 'dshpz-act',
                  'data-tone': 'danger',
                  disabled: isBusy || busy !== null,
                  title: '从本机删掉这个主题的缓存' + (isCurrent ? '（会同时恢复默认皮肤）' : ''),
                  onClick: function () { uninstallThemeNow(sessionId, card.id) },
                }, h('span', null, '卸载'))
                : null,
            ),
          )
        }))
      }

      var foot = h(
        'div',
        { className: 'dshpz-tfoot' },
        h('div', { className: 'dshpz-muted' },
          '主题源：' + (theme !== null ? String(theme.repo || '') : '')
          + (theme !== null && theme.base ? '（自定义 ' + String(theme.base) + '）' : '')
          + ' · 接口版本 v' + (theme !== null ? String(theme.apiVersion || '') : '')
          + ' · 缓存目录：' + (theme !== null ? String(theme.dir || '') : '')),
        h('div', { className: 'dshpz-muted' },
          '主题只能是 CSS（不允许 JS / 外部请求）；下载后按清单里的 sha256 校验，不符即拒绝。'),
      )

      // 与 `panelBody` 同层级：主题页**就是**面板主体，不再是压在它上面的第二层。
      // 所以这里只返回 `.dshpz-panel` 外壳（玻璃底、网格纹、顶部高光都在
      // `.dshpz-panel` 与它的 `::before/::after` 上，复用即可）；
      // 外面那层负责「全屏居中 + 点外部关闭」的 `.dshpz-backdrop` 由 `Panel` 统一提供，
      // 两个视图共用一层——这正是「不再叠两层」的落点。
      return h(
        'div',
        { className: 'dshpz-panel' },
        head,
        notices,
        h('div', { className: 'dshpz-tbody' }, grid),
        foot,
      )
    }

    /**
     * 大读数：环形进度 + 百分比 + 一句状态。
     *
     * 为什么值得单独做一块：面板里其它数字都是细节，只有「项目健康性」是**一句话结论**。
     * 环形（而不是横条）是因为它在三栏布局里占地更方，且环心天然适合放那个大数字。
     *
     * 环用 SVG `stroke-dasharray` + `stroke-dashoffset` 画：纯 CSS/SVG，不引图表库。
     * 半径 30、周长 2πr≈188.5——`offset = 周长 × (1 - 分数/100)`。
     */
    function heroRing(score) {
      var value = Math.max(0, Math.min(100, Number(score) || 0))
      var R = 30
      var C = 2 * Math.PI * R
      var offset = C * (1 - value / 100)
      return h(
        'div',
        { className: 'dshpz-ring' },
        h(
          'svg',
          { width: 74, height: 74, viewBox: '0 0 74 74', 'aria-hidden': true },
          // 渐变描边：需要 defs + 唯一 id；面板同时只开一个，所以固定 id 不会冲突。
          h(
            'defs',
            null,
            h(
              'linearGradient',
              { id: 'dshpz-ringgrad', x1: '0', y1: '0', x2: '1', y2: '1' },
              h('stop', { offset: '0', stopColor: 'var(--dshpz-accent-hi)' }),
              h('stop', { offset: '1', stopColor: 'var(--dshpz-accent-lo)' }),
            ),
          ),
          h('circle', { className: 'dshpz-ringcircle', cx: 37, cy: 37, r: R }),
          h('circle', {
            className: 'dshpz-ringfill',
            cx: 37,
            cy: 37,
            r: R,
            strokeDasharray: String(C),
            strokeDashoffset: String(offset),
          }),
        ),
        h('div', { className: 'dshpz-ringnum' }, String(value)),
      )
    }

    /**
     * 一句状态：把分数翻成中文档位。
     *
     * 分档是刻意的**粗**（四档）：健康性本身是证据的粗略度量，给出「82 分很健康」这种
     * 精确措辞会假装它比实际更准。四档只回答「现在该不该慌」。
     */
    function healthVerdict(score) {
      var v = Number(score) || 0
      if (v >= 85) return '文档证据充分，可以直接动手'
      if (v >= 70) return '基本可用，有若干维度缺证据'
      if (v >= 50) return '证据偏薄，改动前先补文档'
      return '证据很少，建议先补要点与决策'
    }

    /** 一维一条小进度条；分数来自宿主汇总，UI 不自己算。 */
    function dimensionRow(key, value) {
      return h(
        'div',
        { className: 'dshpz-dim', key: key },
        h('span', { className: 'dshpz-dimname' }, DIMENSION_LABELS[key] || key),
        h('span', { className: 'dshpz-dimbar' }, h('span', { className: 'dshpz-dimfill', style: { width: value + '%' } })),
        h('span', { className: 'dshpz-dimval' }, value + '%'),
      )
    }

    /**
     * 项目规模（小 / 中 / 大）：三颗按钮，点了写主文档 front-matter 的 `规模:`。
     *
     * 为什么放在五维下面：它管的是「这个项目写多细」——与健康性一样属于**项目级**设定，
     * 而它的直接效果是改条目上限（悬而未决 / 已定 / 工作流 / 坑的条数与字数）。
     *
     * 档位由宿主算好随 `state` 下发（`data.size`）；客户端不自己推导上限，
     * 免得改 `constants.js` 时两边不一致（那条「只改一处即可」的纪律）。
     */
    function sizeBlock(view) {
      var data = view.state.data
      if (data === null || data === undefined || data.project === undefined || data.project === null) return null
      var current = typeof data.size === 'string' && data.size !== '' ? data.size : '中'
      /**
       * ⚠️ **这里原先读的是 `sizeCaps`，而宿主下发的是 `entryCaps`**——这正是用户报的
       * 「项目规模切换是假态」的另一半：`sizeCaps` 是「小/中/大三档的整张表」，
       * 不是「当前这档」，于是 `caps.pending` 永远是 `undefined`，下面那行「当前上限」
       * 靠 `undefined === undefined ? 4 : …` 的兜底**永远显示中档的数字**——
       * 切到「大」显示「已定 ≤10」，切到「小」也显示「已定 ≤10」。看着像按钮没生效。
       *
       * 真值在 `limits.entryCaps`（= `capsOfSize(当前档)`）。这里优先取它，
       * 再退回「按当前档名去 `sizeCaps` 里查」，最后才用兜底——三层都能得出正确的当前档。
       */
      var limits = limitsOf(data)
      var caps = (limits.entryCaps !== null && limits.entryCaps !== undefined && typeof limits.entryCaps === 'object')
        ? limits.entryCaps
        : ((limits.sizeCaps || {})[current] || {})
      var hints = {
        '小': '小项目：条目收紧（悬而未决 4 / 已定 6 / 工作流 3，坑 10 条）',
        '中': '中项目：默认档（悬而未决 4 / 已定 10 / 工作流 5，坑不限）',
        '大': '大项目：条目放宽（悬而未决 12 / 已定 30 / 工作流 12，坑 60 条；字数也放宽）',
      }
      return h(
        'div',
        { className: 'dshpz-sect' },
        h('div', { className: 'dshpz-secttitle' }, '规模', h('span', { className: 'dshpz-count' }, current + ' · 决定条目上限')),
        h(
          'div',
          { className: 'dshpz-acts-horiz' },
          ['小', '中', '大'].map(function (name) {
            return h(
              'button',
              {
                className: 'dshpz-act',
                key: name,
                'data-on': current === name ? '1' : '0',
                title: hints[name],
                onClick: function () {
                  if (current === name) return
                  /**
                   * **先本地翻档，再发请求**——用户报「项目规模切换是假态，而且延时切换」。
                   *
                   * 两个症状同一个根因，都在这一行上（原写法是
                   * `setState({ data: mergePanelData(view.state.data, json.result) })`）：
                   *
                   * 1. **延时**：写盘 + 重读 + 回包要一会儿，而按钮只在**回包后**才变。
                   *    这三颗按钮是「我点了一个开关」的直接反馈，必须**按下即亮**。
                   *    改成乐观更新：点下去立刻把 `size` 与 `limits` 换成本地算好的新档。
                   * 2. **假态**：`view.state.data` 是**组件渲染时的快照**，而回调在若干微任务
                   *    之后才跑，那时它已经过期了；同时 `mergePanelData` 只认**一个**参数
                   *    （第二个被静默忽略），于是「保留绑定组」那层意图在这里根本没生效。
                   *    读**模块级** `state.data`（`setState` 的同一份来源，与
                   *    `markCurrentLocal` 踩过的坑一模一样）。
                   *
                   * 档位的上限由宿主算好下发（客户端不自己推导），但这里必须本地先翻一次，
                   * 否则「按下即亮」做不到；随后的回包会用它自己的权威值覆盖。
                   */
                  var fresh = state.data
                  var table = limitsOf(fresh === null || fresh === undefined ? null : fresh).sizeCaps || {}
                  if (table[name] !== undefined) {
                    setState({
                      data: Object.assign({}, fresh, {
                        size: name,
                        limits: Object.assign({}, limitsOf(fresh), { size: name, entryCaps: table[name] }),
                      }),
                    })
                  }
                  post({ method: 'size', sessionId: String(view.state.sessionId), project: String(data.project), size: name })
                    .then(function (json) {
                      // 回包是权威值：整份替换（它带了 `size` / `limits` / 绑定组）。
                      if (json && json.ok === true) setState({ data: mergePanelData(json.result) })
                      // 失败必须**回宿主重读**，不能只留个 error：乐观更新已经把档位翻过去了，
                      // 不拉回来面板就停在一个**没写进文档的假态**上（正是这个 bug 的形状）。
                      // 也别拿 `mergePanelData({})` 去「还原」——那会只留绑定组、把别的字段全冲掉。
                      else {
                        setState({ error: (json && json.error) || '规模写入失败' })
                        load(String(view.state.sessionId))
                      }
                    })
                    .catch(function () {
                      setState({ error: '无法连接 ' + RPC })
                      load(String(view.state.sessionId))
                    })
                },
              },
              h('span', null, name),
            )
          }),
        ),
        h('div', { className: 'dshpz-muted' }, '当前上限：悬而未决 ≤' + (caps.pending === undefined ? 4 : caps.pending)
          + ' · 已定 ≤' + (caps.decided === undefined ? 10 : caps.decided)
          + ' · 工作流 ≤' + (caps.workflow === undefined ? 5 : caps.workflow)
          + ' · 坑 ' + (caps.pit === undefined || caps.pit === null ? '不限' : ('≤' + caps.pit))),
      )
    }


    /** 图块：模块块可点开详情；五维块与模块块共用一套渲染。 */
    function tile(piece, view) {
      var empty = piece.kind === 'module' && piece.exists === false
      var counts = piece.counts || {}
      var detail = []
      if (counts.points) detail.push('点 ' + counts.points)
      if (counts.pending) detail.push('悬 ' + counts.pending)
      if (counts.decided) detail.push('定 ' + counts.decided)
      var clickable = piece.kind === 'module'
      var on = view.state.detailName === piece.name ? '1' : '0'
      var props = {
        className: 'dshpz-tile',
        'data-empty': empty ? '1' : '0',
        'data-on': on,
        'data-static': clickable ? '0' : '1',
        key: piece.id,
        title: clickable ? '点开看模块详情' : piece.id,
      }
      if (clickable) {
        props.onClick = function () {
          if (view.state.detailName === piece.name) setState({ detail: null, detailName: null })
          else loadDetail(view.state.sessionId, piece.name, view.state.data && view.state.data.project)
        }
      }
      return h(
        'button',
        props,
        h('b', null, piece.name),
        h(
          'div',
          { className: 'dshpz-tilebar' },
          h('div', { className: 'dshpz-tilefill', style: { width: piece.score + '%' } }),
        ),
        h('div', { className: 'dshpz-pct' }, empty ? '未建' : piece.score + '%'),
        detail.length > 0 ? h('div', { className: 'dshpz-pct' }, detail.join(' · ')) : null,
      )
    }

    /* ------------------------------- 模块详情 ------------------------------- */

    /**
     * 把一段正文按**条**拆开渲染：一条一个卡片（书签感），不再是一整块 `<pre>`。
     *
     * 为什么：一整个 `<pre>` 读起来像读源码，条目之间没有边界；拆成一条一张卡片后
     * 每条独立可扫，也才能一眼看出哪条超长、哪条没带出处。
     *
     * 每条都做合规检查：超长标 `超N字`、没出处标 `缺出处`——审查发现问题时，
     * 面板里能直接看到**是哪一条**。
     */
    function entryCards(text, limit, requireSource) {
      var lines = String(text || '').split(/\r?\n/).filter(function (line) {
        return line.trim() !== ''
      })
      return lines.map(function (line, index) {
        var bare = line.replace(/^\s*[-*]\s*/, '').trim()
        var mark = bare.indexOf('（源码')
        var body = mark < 0 ? bare : bare.slice(0, mark).trim()
        var source = mark < 0 ? '' : bare.slice(mark).replace(/^（源码\s*[:：]?\s*/, '').replace(/）\s*$/, '')
        // 按码点数数：一个汉字算 1，与宿主的 ENTRY_LIMITS 口径一致。
        var count = Array.from(body).length
        var flags = []
        if (count > limit) flags.push('超' + (count - limit) + '字')
        if (requireSource !== false && source === '') flags.push('缺出处')
        return h(
          'div',
          { className: 'dshpz-entry', key: 'e' + index, 'data-bad': flags.length > 0 ? '1' : '0' },
          h('span', { className: 'dshpz-entrynum' }, String(index + 1)),
          h(
            'span',
            { className: 'dshpz-entrybody' },
            body,
            source === ''
              ? null
              : h('span', { className: 'dshpz-entrysrc' }, ' ' + source),
          ),
          flags.length === 0
            ? null
            : h('span', { className: 'dshpz-entryflag' }, flags.join(' · ')),
        )
      })
    }

    /** 一个「条目小节」：标题 + 计数 + 逐条卡片。 */
    function entrySection(heading, text, limit, requireSource) {
      var cards = entryCards(text, limit, requireSource)
      if (cards.length === 0) return null
      return h(
        'div',
        { key: heading },
        h('div', { className: 'dshpz-muted' }, heading + '（' + cards.length + ' 条，每条 ≤' + limit + ' 字 + 出处）'),
        h('div', { className: 'dshpz-entries' }, cards),
      )
    }

    function detailBlock(view) {
      var detail = view.state.detail
      if (detail === null || detail === undefined) return null
      if (detail.error !== undefined) {
        return h('div', { className: 'dshpz-detail' }, h('div', { className: 'dshpz-err' }, String(detail.error)))
      }
      var parts = []
      if (detail.exists !== true) {
        parts.push(h('div', { className: 'dshpz-muted', key: 'none' }, '这个模块还没建文档。'))
      } else {
        if (detail.dimensions !== undefined && detail.dimensions !== null) {
          parts.push(h(
            'div',
            { key: 'h' },
            h('div', { className: 'dshpz-muted' }, '五维健康性'),
            h('div', { className: 'dshpz-dims' }, DIMENSION_KEYS.map(function (key) {
              return dimensionRow(key, detail.dimensions[key] || 0)
            })),
          ))
        }
        // 逐条渲染（书签式）：模块索引指向模块文档，所以不强制源码出处。
        var sections = [
          entrySection('要点', detail.points, 20, true),
          entrySection('悬而未决', detail.pending, 20, true),
          entrySection('已定', detail.decided, 20, true),
          entrySection('可复用', detail.reuse, 20, true),
          entrySection('详细记录 · 轮汇报', detail.detail, 50, true),
        ].filter(Boolean)
        if (sections.length === 0) {
          parts.push(h('div', { className: 'dshpz-muted', key: 'empty' }, '文档还是空的。'))
        } else {
          parts = parts.concat(sections)
        }
      }
      return h(
        'div',
        { className: 'dshpz-detail' },
        h('h4', null, '模块 · ' + detail.name + (detail.health === undefined ? '' : ' · 健康性 ' + detail.health + '%')),
        parts,
      )
    }

    /* ------------------------------ 客观发现 ------------------------------ */

    /**
     * 审查的「事实」半边：规则数出来的发现，直接给人看。
     *
     * 另一半（一针见血的点评）由模型写——面板只提供入口（「审查」按钮填审查提示词）。
     */
    function findingsBlock(view) {
      var data = view.state.data
      var list = data !== null && data !== undefined && Array.isArray(data.findings) ? data.findings : []
      if (list.length === 0) {
        return h(
          'div',
          { className: 'dshpz-sect' },
          h('div', { className: 'dshpz-secttitle' }, '审查 · 客观发现（0）'),
          h('div', { className: 'dshpz-muted' }, '没有发现「文档与数字对不上」的地方。'),
        )
      }
      var order = { blocker: 0, warn: 1, info: 2 }
      var sorted = list.slice().sort(function (a, b) {
        var left = order[a.level] === undefined ? 3 : order[a.level]
        var right = order[b.level] === undefined ? 3 : order[b.level]
        return left - right
      })
      return h(
        'div',
        { className: 'dshpz-sect' },
        h('div', { className: 'dshpz-secttitle' }, '审查 · 客观发现（' + list.length + '）'),
        h('div', { className: 'dshpz-findings' }, sorted.map(function (item) {
          return h(
            'div',
            { className: 'dshpz-finding', key: item.id, 'data-level': item.level },
            h('span', { className: 'dshpz-flevel' }, item.level === 'blocker' ? '堵' : (item.level === 'warn' ? '补' : '提')),
            h(
              'div',
              null,
              h('div', { className: 'dshpz-ffact' }, (item.scope === 'project' ? '项目' : item.scope) + '：' + item.fact),
              h('div', { className: 'dshpz-ffix' }, '→ ' + item.fix),
            ),
          )
        })),
        h('div', { className: 'dshpz-muted' }, '以上是规则数出来的事实；点评由 AI 写——点「审查」把请求填进输入框。'),
      )
    }

    /* ------------------------- 工作流（可删可恢复） ------------------------- */

    /**
     * 工作流区块：当前条目（1 起编号，右侧「✕ 删除」）+ 归档（右侧「恢复」）。
     *
     * 数据来自 `method:'main'`——`state` 摘要里没有工作流，所以这一段和主文档共用一次取数。
     * 删除是**唯一会改主文档的面板动作**，所以它要二次确认；恢复是往回加，不用确认。
     */
    function workflowBlock(view) {
      var main = view.state.main
      if (main === null || main === undefined) return null
      // 正在重新拉取、且手上还没有数据 → 先不渲染（避免闪一下「还没有工作流」）。
      if (main.loading === true && main.workflow === undefined) return null
      if (main.error !== undefined && main.workflow === undefined) {
        return h(
          'div',
          { className: 'dshpz-sect' },
          h('div', { className: 'dshpz-secttitle' }, '工作流'),
          h('div', { className: 'dshpz-err' }, String(main.error)),
        )
      }
      var list = Array.isArray(main.workflow) ? main.workflow : []
      var archive = Array.isArray(main.workflowArchive) ? main.workflowArchive : []

      // 工作流列表：**图块式**（与模块块同一套交互）——只显示「名字 + 几步」，
      // 点开才铺开有序步骤。用户裁定：工作流 UI 改成像模块点击出细节的模式。
      // 这样 5 条流水线不会把面板撑长，也一眼看得出每条有多长（步数）。
      var tiles = list.map(function (item, index) {
        var no = index + 1
        var name = String(item && item.name !== undefined ? item.name : '')
        var steps = Array.isArray(item && item.steps) ? item.steps : []
        var on = view.state.wfOpen === name ? '1' : '0'
        var open = on === '1'
        var detail = open
          ? h(
            'div',
            { className: 'dshpz-wfsteps' },
            steps.map(function (step, i) {
              return h(
                'div',
                { className: 'dshpz-wfstep', key: 's' + i },
                h('span', { className: 'dshpz-wfstepno' }, String(i + 1)),
                h('span', { className: 'dshpz-wfsteptext' }, String(step)),
              )
            }),
          )
          : null
        return h(
          'div',
          { className: 'dshpz-wfitem', key: 'w' + no },
          h(
            'button',
            {
              type: 'button',
              className: 'dshpz-wftile',
              'data-on': on,
              title: open ? '收起这条工作流' : '点开看这条流水线的步骤',
              onClick: function () {
                setState({ wfOpen: open ? null : name })
              },
            },
            h('span', { className: 'dshpz-entrynum' }, String(no)),
            h('b', { className: 'dshpz-wfname' }, name),
            h('span', { className: 'dshpz-wfcount' }, steps.length + ' 步'),
            h('span', { className: 'dshpz-wfcaret' }, open ? '▾' : '▸'),
          ),
          detail,
          h(
            'div',
            { className: 'dshpz-wfops' },
            h(
              'button',
              {
                className: 'dshpz-act',
                title: '删掉整条工作流（会进归档，可恢复）',
                onClick: function () { removeWorkflow(view, no, name) },
              },
              '✕ 删除',
            ),
          ),
        )
      })

      // 归档：**不可展开看细节**（用户裁定）——它是「删过什么」的账，不是当前的流程。
      // 只显示「名字 + 几步」，并给两个出口：恢复 / 永久删除。
      var archRows = archive.map(function (item, index) {
        var no = index + 1
        var name = String(item && item.name !== undefined ? item.name : '')
        var steps = Array.isArray(item && item.steps) ? item.steps : []
        return h(
          'div',
          { className: 'dshpz-wf', key: 'a' + no, 'data-arch': '1' },
          h('span', { className: 'dshpz-entrynum' }, String(no)),
          h('span', { className: 'dshpz-wfbody' }, name + (steps.length > 0 ? ' · ' + steps.length + ' 步' : '')),
          h(
            'button',
            {
              className: 'dshpz-act',
              title: '把整条工作流恢复回列表（已满 5 条时会挤掉最旧的一条，那条会进归档）',
              onClick: function () { restoreWorkflow(view, no, name) },
            },
            '恢复',
          ),
          h(
            'button',
            {
              className: 'dshpz-act',
              'data-danger': '1',
              title: '从归档里永久删除这一条（不可恢复）',
              onClick: function () { dropWorkflow(view, no, name) },
            },
            '永久删除',
          ),
        )
      })
      return h(
        'div',
        { className: 'dshpz-sect' },
        h('div', { className: 'dshpz-secttitle' }, '工作流（' + list.length + '/'
          + limitsOf(view.state.data).entryCaps.workflow + ' · 每条 ≤'
          + limitsOf(view.state.data).workflowMaxSteps + ' 步 · 点名字看步骤）'),
        list.length === 0
          ? h('div', { className: 'dshpz-muted' }, '还没有工作流。点「工作流模板」让 AI 先问清是哪条流程，再写成流水线。')
          : h('div', { className: 'dshpz-wflist' }, tiles),
        h('div', { className: 'dshpz-secttitle', style: { marginTop: '8px' } }, '归档（' + archive.length + ' · 可恢复 / 可永久删除）'),
        archive.length === 0
          ? h('div', { className: 'dshpz-muted' }, '暂无删除记录')
          : h('div', { className: 'dshpz-entries' }, archRows),
      )
    }

    /* --------------------------- 主文档（只读） --------------------------- */

    /**
     * 主文档只读视图。
     *
     * 为什么是只读：拼图文档只能由 AI 通过 `puzzle_mode` 改（write / edit 会被文档锁拒绝），
     * 面板上开一个可编辑框等于绕过规格。这里只把 `result.text` 原样摆出来给人看。
     * 用 `<pre>` 而不是 `<textarea>`：保留换行、可滚动，且天然不可编辑。
     */
    function mainBlock(view) {
      if (view.state.showMain !== true) return null
      var main = view.state.main
      if (main === null || main === undefined) {
        return h(
          'div',
          { className: 'dshpz-sect' },
          h('div', { className: 'dshpz-secttitle' }, '主文档'),
          h('div', { className: 'dshpz-muted' }, '读取中…'),
        )
      }
      // 重新拉取时留着上一次的原文（`text` 已有就不闪空白）；首次拉取才是「读取中…」。
      if (main.loading === true && main.text === undefined) {
        return h(
          'div',
          { className: 'dshpz-sect' },
          h('div', { className: 'dshpz-secttitle' }, '主文档'),
          h('div', { className: 'dshpz-muted' }, '读取中…'),
        )
      }
      if (main.error !== undefined && main.text === undefined) {
        return h(
          'div',
          { className: 'dshpz-sect' },
          h('div', { className: 'dshpz-secttitle' }, '主文档'),
          h('div', { className: 'dshpz-err' }, String(main.error)),
        )
      }
      return h(
        'div',
        { className: 'dshpz-sect' },
        h(
          'div',
          { className: 'dshpz-secttitle' },
          // `version` 与页头一样给兜底：当前 RPC 契约下它恒有值（不可达），
          // 但裸拼会在契约变化时渲染出「格式 vundefined」——与页头的 `|| '?'` 对齐。
          '主文档（只读 · 格式 v' + (main.version || '?') + (main.outdated === true ? ' · 旧格式' : '') + (main.loading === true ? ' · 读取中…' : '') + '）',
        ),
        main.error !== undefined ? h('div', { className: 'dshpz-err' }, String(main.error)) : null,
        h('div', { className: 'dshpz-docpath' }, String(main.mainDoc || '')),
        String(main.text || '') === ''
          ? h('div', { className: 'dshpz-muted' }, '主文档是空的。')
          : h('pre', { className: 'dshpz-doc' }, String(main.text)),
        h('div', { className: 'dshpz-muted' }, '只读：拼图文档只能由 AI 通过 puzzle_mode 改，面板不提供编辑。'),
      )
    }

    /* -------------------------------- 面板 -------------------------------- */

    /**
     * 开关那一行：**关掉本会话**的拼图模式。
     *
     * 放在面板顶部、**两个分支都渲染**（有项目 / 空态）：它只认会话 ID，与项目无关，
     * 而空态（还没绑项目）恰恰是最想关掉它的场景。
     *
     * 文案必须写明「只影响本会话」——早先那版写的是「只对新会话生效」，
     * 用户按下去发现当前会话毫无变化，直接反馈「怎么禁用没有效果」。
     */
    /**
     * 固定收尾问当前是否开着（**全局**设置，宿主随 `settings` 下发）。
     *
     * 为什么读 `settings` 而不是 `data`：它是 DSH_HOME 下的全局开关，与项目无关——
     * 空态（还没绑项目）也必须能读到，否则用户在新会话里连关都关不掉。
     *
     * 拿不到时**返回 true**：默认行为是「开着」，读不到就保持现状，
     * 不要在数据还没到的时候让面板先显示成「已关闭」。
     */
    function pauseEnabledOf(view) {
      var settings = view.state.settings
      if (settings === null || settings === undefined) return true
      if (typeof settings.askPause !== 'boolean') return true
      return settings.askPause
    }

    function settingsRow(view) {
      var settings = view.state.settings
      if (settings === null || settings === undefined) return null
      if (settings.error !== undefined) {
        return h('div', { className: 'dshpz-muted' }, '开关读取失败：' + String(settings.error))
      }
      var off = settings.disabled === true
      var sessionId = view.state.sessionId
      // 固定收尾问是**全局**开关（与项目、会话都无关），所以它与「本会话」那颗按钮
      // 分两行渲染，并各自说清作用范围——把两个范围不同的开关并排放在一行，
      // 用户会以为它们的影响面一样。
      var pauseOn = pauseEnabledOf(view)
      return h(
        'div',
        { className: 'dshpz-row', style: { marginTop: '6px', flexWrap: 'wrap', gap: '6px' } },
        h(
          'button',
          {
            className: 'dshpz-act',
            'data-on': off ? '1' : '0',
            title: off
              ? '恢复**本会话**的拼图模式（其他会话的禁用状态不受影响）'
              : '关掉**本会话**的拼图模式：下一轮起不再注入拼图规则、也不再拦工具；其他会话不受影响',
            onClick: function () { writeSettings(sessionId, !off) },
          },
          off ? '本会话：已关拼图 · 点此恢复' : '关掉本会话的拼图模式',
        ),
        h(
          'button',
          {
            className: 'dshpz-act',
            'data-on': pauseOn ? '0' : '1',
            title: pauseOn
              ? '关掉固定收尾问：此后**所有会话**的提问都不再带「要不要先停下？」'
              : '恢复固定收尾问：每次提问末尾都问「要不要先停下？」',
            onClick: function () { writeSettings(sessionId, undefined, !pauseOn) },
          },
          pauseOn ? '固定收尾问：开 · 点此关闭' : '固定收尾问：已关 · 点此开启',
        ),
        h(
          'span',
          { className: 'dshpz-muted', style: { flexBasis: '100%' } },
          pauseOn
            ? '「关掉本会话」只影响本会话；「固定收尾问」是**全局**的，跨会话跨项目一致。'
            : '固定收尾问已**全局关闭**（跨会话跨项目一致）：提问不再带「要不要先停下？」。',
        ),
      )
    }

    /**
     * 绑定切换条：**在已绑定的项目之间切当前**（用户需求：「把范围缩小为选择绑定的那几个」）。
     *
     * 用户裁定（v0.20.0）：这里原来是原生 `select`，列的是**工作区全部项目**，
     * 选中即「改绑」（把会话从上一个项目摘掉）。多绑定之后这个语义就错了——
     * 一个会话同时操作几个项目时，切换是「换当前」而不是「换掉全部绑定」。
     *
     * 两种形态（用户选的「胶囊分段控件 + 卡片兜底」）：
     *   · 绑定 2–4 个 → 一排胶囊，一眼看全、一次点中，当前项高亮；
     *   · 绑定 ≥5 个 → 换成卡片列表，每项显示健康性与模块数（胶囊排长了会折行、挤掉别的区块）。
     *
     * 为什么不用原生 `select`：它没法在选项里画健康性进度、也没法放「解绑」那个 `×`，
     * 而且移动端弹出的是系统列表，看不到当前项目的上下文。
     */
    function bindingSwitcher(view, data, bindings, allProjects, warn) {
      var PILL_MAX = 4
      var boundNames = bindings.map(function (item) { return item.project })
      // 还没绑的项目：面板那个「＋」的候选。用**工作区全部项目**减去已绑的。
      var unbound = (allProjects || []).filter(function (item) { return boundNames.indexOf(item.name) < 0 })
      // ⚠️ 这里**不做「单绑定就退化成一行纯文字」的优化**（我做过，被用户当场发现）：
      // 单绑定是**绝大多数情况**，一退化就等于「切换条平时根本不存在」，
      // 用户看到的是「我的切换绑定被搞没了」。所以只要绑着就画胶囊——
      // 单个胶囊也是那个「当前项目 + 可解绑」的锚点，视觉与交互都保持一致。
      var plus = unbound.length > 0
        ? h(
          'button',
          {
            className: 'dshpz-pill dshpz-pill-plus',
            key: '__add',
            title: '再绑一个项目（追加，不会解绑现有的）：' + unbound.map(function (i) { return i.name }).join(' / '),
            onClick: function () { setState({ addOpen: view.state.addOpen !== true }) },
          },
          '＋',
        )
        : null

      var rows = bindings.length <= PILL_MAX
        ? [
          h(
            'div',
            { className: 'dshpz-pills', key: 'pills' },
            bindings.map(function (item) {
              return h(
                'button',
                {
                  key: item.project,
                  className: 'dshpz-pill',
                  'data-on': item.current === true ? '1' : '0',
                  title: (item.current === true ? '当前项目 · ' : '点一下切到 ') + item.project
                    + '（' + (item.mode || '?') + ' · 健康性 ' + (item.health || 0) + '% · ' + (item.moduleCount || 0) + ' 个模块）',
                  onClick: function () {
                    // 已经是当前就不用再切：省一次写盘，也免得把 detail 清掉。
                    if (item.current === true) return
                    switchCurrent(view, item.project)
                  },
                },
                h('span', { className: 'dshpz-pillname' }, item.project),
                h('span', { className: 'dshpz-pillpct' }, (item.health || 0) + '%'),
                h(
                  'span',
                  {
                    className: 'dshpz-pillx',
                    title: '解绑这个项目（不影响其它绑定）',
                    onClick: function (event) {
                      event.stopPropagation()
                      unbindOneProject(view, item.project)
                    },
                  },
                  '×',
                ),
              )
            }),
            plus,
          ),
        ]
        : [
          h('div', { className: 'dshpz-muted', key: 'many' }, '绑了 ' + bindings.length + ' 个项目，改用卡片列表（胶囊排不下会折行挤掉别的区块）：'),
          h(
            'div',
            { className: 'dshpz-bindcards', key: 'cards' },
            bindings.map(function (item) {
              return h(
                'div',
                {
                  key: item.project,
                  className: 'dshpz-bindcard',
                  'data-on': item.current === true ? '1' : '0',
                  onClick: function () {
                    if (item.current === true) return
                    switchCurrent(view, item.project)
                  },
                },
                h(
                  'div',
                  { className: 'dshpz-bindcardtop' },
                  h('span', { className: 'dshpz-pillname' }, item.project),
                  item.current === true ? h('span', { className: 'dshpz-bindcardnow' }, '当前') : null,
                ),
                h('div', { className: 'dshpz-muted' }, (item.mode || '?') + ' · ' + (item.moduleCount || 0) + ' 个模块'),
                h(
                  'div',
                  { className: 'dshpz-bindbar' },
                  h('span', { style: { width: Math.max(0, Math.min(100, item.health || 0)) + '%' } }),
                ),
                h('div', { className: 'dshpz-muted' }, '健康性 ' + (item.health || 0) + '%'),
                h(
                  'button',
                  {
                    className: 'dshpz-bindunbind',
                    onClick: function (event) {
                      event.stopPropagation()
                      unbindOneProject(view, item.project)
                    },
                  },
                  '解绑',
                ),
              )
            }),
          ),
        ]

      return h(
        'div',
        { className: 'dshpz-bindwrap' },
        ...rows,
        // 「＋」展开的候选列表：默认收起，点开才铺，免得挤掉下面的执行模式。
        view.state.addOpen === true && unbound.length > 0
          ? h(
            'div',
            { className: 'dshpz-addlist' },
            unbound.map(function (item) {
              return h(
                'button',
                {
                  key: item.name,
                  className: 'dshpz-act',
                  onClick: function () {
                    setState({ addOpen: false })
                    bindTo(view, item.name, true)
                  },
                },
                '＋ ' + item.name + ' · 健康性 ' + item.health + '%',
              )
            }),
          )
          : null,
        bindings.length > 1
          ? h('div', { className: 'dshpz-muted', style: { marginTop: '5px', lineHeight: '1.5' } },
            '当前项目「' + (data.project || '?') + '」；多绑定联动：任一项目是「只拼不写」就拦写动作。')
          : null,
        warn === true
          ? h('div', { className: 'dshpz-muted', style: { marginTop: '5px', lineHeight: '1.5' } },
            '⚠ 绑了 ' + bindings.length + ' 个项目，当前项目容易看错——建议解绑不用的。')
          : null,
      )
    }

    function panelBody(view) {
      var data = view.state.data
      var inited = data !== null && data !== undefined && data.initialized === true
      var header = h(
        'div',
        { className: 'dshpz-head' },
        h('span', { className: 'dshpz-logo' }, icon('puzzle', 18)),
        h(
          'div',
          { className: 'dshpz-headtext' },
          h('h3', { className: 'dshpz-title' }, '拼图' + (inited ? ' · ' + (data.project || '未命名') : '')),
          h(
            'div',
            { className: 'dshpz-sub' },
            inited
              ? (data.mode || '') + ' · 格式 v' + (data.version || '?') + (data.outdated === true ? '（旧格式，建议迁移）' : '') + ' · ' + (data.projectDir || '')
              : '本会话未绑定项目',
          ),
        ),
        inited ? h('span', { className: 'dshpz-heroval dshpz-mono' }, '健康性 ' + data.health + '%') : null,
        /**
         * **面板一角的主题图标**（用户原话：「在面板一角放个图标点进去是主题管理不就行了？」）。
         *
         * 为什么放右上角、在「刷新 / 关闭」左边：那一排已经是「面板级动作」的位置，
         * 主题是同一层级的东西；放在角落而不是当第四栏，是因为它不该常驻占地方。
         *
         * v0.27.1 起点击是**切换面板主视图**（不再是叠一层全屏浮层），
         * 所以这里不再量图标坐标——那个 `themeOrigin` 只服务于已删掉的生长动画。
         */
        h(
          'button',
          {
            className: 'dshpz-close',
            'data-on': view.state.themeOpen === true ? '1' : '0',
            title: '主题：切换到这个面板的主题页（再点或按 Esc 返回）',
            onClick: function () {
              var next = view.state.themeOpen !== true
              setState({ themeOpen: next, themeNotice: null, themeError: null })
              // 每次进来都重拉清单：主题仓库是外部状态，缓存只该在网络失败时兜底。
              if (next) loadThemes(view.state.sessionId)
            },
          },
          icon('grid', 15),
        ),
        h(
          'button',
          {
            className: 'dshpz-close',
            title: '刷新',
            onClick: function () {
              // 同样不带显式 project：刷新要看到**当前真实归属**（宿主按绑定解析），
              // 带上面板此刻显示的项目名等于把旧状态钉死，解绑后刷新也会「复活」。
              load(view.state.sessionId)
              loadProjects(view.state.sessionId)
              // 主文档/工作流也一起刷新：它们不在 `state` 摘要里，只刷 state 会让这一块停在旧原文。
              loadMain(view.state.sessionId)
            },
          },
          icon('refresh', 15),
        ),
        h(
          'button',
          {
            className: 'dshpz-close',
            title: '关闭（Esc）',
            onClick: function () { setState({ open: false, detail: null, detailName: null }) },
          },
          icon('close', 15, { weight: 'bold' }),
        ),
      )

      // 一次性说明（不是错误，所以不跟 error 抢同一行）：例如「项目已存在，没动绑定」。
      var notice = view.state.notice === null || view.state.notice === undefined
        ? null
        : h('div', { className: 'dshpz-notice' }, icon('alert', 14), h('span', null, String(view.state.notice)))

      /**
       * 样式没生效时**在面板里直说**，并给出可复制的一行环境指纹。
       *
       * 只在真的失败时渲染（`applied === false`）：样式正常时用户不该看到任何技术噪音。
       * 这一块是给「远程排障」用的——用户把这一行截图/复制出来，就知道是
       * `inset` 不支持、还是 `color-mix` 不支持、还是 UA 太老，不必再猜。
       *
       * **v0.16.5 修**：原先这行把 `applied=false` **写死**在字面量里，于是
       * 「自检误报」和「真的没生效」看起来一模一样。现在 `applied` 取真实值，
       * 并补一项 `rules=`（`<style>` 的 `cssRules` 条数，CSP 拦掉时为 `null`）：
       * `applied=false` 且 `rules=null` 才是「样式表没进文档」，
       * `applied=false` 而 `rules>0` 说明表进了文档、只是没盖住探针。
       */
      var diag = view.state.styleDiag
      var styleWarning = diag !== null && diag !== undefined && diag.applied === false
        ? h(
          'div',
          { className: 'dshpz-err', style: { display: 'block' } },
          h('span', null, '⚠ 面板样式没有生效（当前是「无样式」兜底显示，功能仍可用）。请把下面这行发给插件作者：'),
          h('div', { className: 'dshpz-mono', style: { marginTop: '6px', wordBreak: 'break-all' } },
            'puzzle-style-diag applied=' + String(diag.applied)
            + ' rules=' + String(diag.rules)
            + ' inset=' + String(diag.inset)
            + ' color-mix=' + String(diag.colorMix)
            + ' backdrop=' + String(diag.backdrop)
            + ' min()=' + String(diag.minFn)
            + ' ua=' + String(diag.ua)),
        )
        : null

      if (view.state.error !== null) {
        // 错误态也保持三栏骨架：只弹一个居中红条会让面板「看起来坏了」，
        // 而保留布局能让人一眼确认「面板还在，只是这次读取失败」。
        return h(
          'div',
          { className: 'dshpz-panel' },
          header,
          h(
            'div',
            { className: 'dshpz-body' },
            h('div', { className: 'dshpz-col' }, h('div', { className: 'dshpz-err' }, icon('alert', 14), h('span', null, String(view.state.error)))),
            h('div', { className: 'dshpz-col' }, h('div', { className: 'dshpz-muted' }, '中栏数据未取到。点右上角 ⟳ 重试。')),
            h('div', { className: 'dshpz-col' }, h('div', { className: 'dshpz-muted' }, '右栏内容未取到。')),
          ),
        )
      }
      if (data === null || data === undefined) {
        // 首屏加载：给骨架屏而不是干巴巴的「读取中…」——三栏布局下空白会让面板看起来是坏的。
        return h(
          'div',
          { className: 'dshpz-panel' },
          header,
          h(
            'div',
            { className: 'dshpz-body' },
            h('div', { className: 'dshpz-col' }, h('div', { className: 'dshpz-skel', style: { width: '70%' } }), h('div', { className: 'dshpz-skel', style: { width: '45%' } })),
            h('div', { className: 'dshpz-col' }, h('div', { className: 'dshpz-skel', style: { width: '55%' } }), h('div', { className: 'dshpz-skel', style: { width: '80%' } }), h('div', { className: 'dshpz-skel', style: { width: '65%' } })),
            h('div', { className: 'dshpz-col' }, h('div', { className: 'dshpz-skel', style: { width: '60%' } })),
          ),
        )
      }

      if (data.initialized !== true) {
        var existing = view.state.projects
        var existingList = existing !== null && existing !== undefined && Array.isArray(existing.projects) ? existing.projects : []
        return h(
          'div',
          { className: 'dshpz-panel' },
          header,
          h(
            'div',
            { className: 'dshpz-body' },
            // 空态也分三栏：左＝建项目，中＝说明与目录，右＝可绑定的已有项目。
            h(
              'div',
              { className: 'dshpz-col' },
              styleWarning,
              notice,
              settingsRow(view),
              h(
                'div',
                { className: 'dshpz-sect' },
                h('div', { className: 'dshpz-secttitle' }, '直接建（不经过 AI）'),
                h('input', {
                  className: 'dshpz-in',
                  placeholder: '项目名（= 工作区里的文件夹名）',
                  value: view.state.formProject || '',
                  onChange: function (event) { setState({ formProject: event.target.value }) },
                }),
                h('input', {
                  className: 'dshpz-in',
                  placeholder: '模块名，逗号分隔（可留空）',
                  value: view.state.formModules || '',
                  onChange: function (event) { setState({ formModules: event.target.value }) },
                }),
                h('input', {
                  className: 'dshpz-in',
                  placeholder: '一句话目标（可留空）',
                  value: view.state.formGoal || '',
                  onChange: function (event) { setState({ formGoal: event.target.value }) },
                }),
                h(
                  'button',
                  { className: 'dshpz-act', title: '立刻建出文件夹 + 主文档 + 每个模块一份文档，并绑定本会话', onClick: function () { createByForm(view) } },
                  '立刻建',
                ),
              ),
            ),
            h(
              'div',
              { className: 'dshpz-col' },
              // 这里原先是一块虚线占位卡（图标 + 标题 + 这行说明），用户裁定「没用」删掉：
              // 标题与面板顶部的「本会话未绑定项目」重复，而它占着中栏最值钱的位置，
              // 把下面三个真按钮往下推。**但那行说明是有意留下的信息**（回答
              // 「我的项目怎么不见了」——新会话不会自动占用上一个会话的项目），
              // 且有一条断言钉着它，所以降级成一行普通提示，不占额外高度。
              h('div', { className: 'dshpz-hint' }, '新会话默认是空的，不会自动占用上一个会话的项目。'),
              h(
                'div',
                { className: 'dshpz-sect' },
                h('div', { className: 'dshpz-secttitle' }, '或交给 AI'),
                h(
                  'div',
                  { className: 'dshpz-acts-vert' },
                  // **照现有项目搭文档**：本会话已经有真实项目（代码就在工作区里），
                  // 只是从来没有拼图文档 —— 这正是「新装插件 + 老会话」的处境。
                  // 放在第一位：它比下面两条更常是用户真正想要的，
                  // 因为项目已经存在，缺的只是文档。
                  h(
                    'button',
                    {
                      className: 'dshpz-act',
                      title: '把提示词填进输入框：先读本会话工作区的真实代码，据此推导项目名与模块划分，再 op:init + op:bind + op:source，并把源码索引/坑按真实 文件:行 填好',
                      onClick: function () { askAi(view, null, adoptTemplate) },
                    },
                    icon('doc', 13), h('span', null, '照现有项目搭文档'),
                  ),
                  // **扫工作区一次建齐**（v0.21.0 ①）：项目已在工作区里、且不止一个时，
                  // 「一个一个建」是纯体力活。扫描 → 勾选 → 一次建完并全部追加绑定。
                  h(
                    'button',
                    {
                      className: 'dshpz-act',
                      title: '先扫工作区顶层目录，列出**还没有拼图文档**的那些；勾选后一次给它们建文档（全部追加绑定，最后一个成为当前项目）',
                      onClick: function () { scanCandidates(view) },
                    },
                    icon('doc', 13), h('span', null, '扫工作区 · 一次建多个'),
                  ),
                  h(
                    'button',
                    { className: 'dshpz-act', title: '不采访，让 AI 直接 op:init 建出文件夹与全部文档', onClick: function () { askAi(view, null, createTemplate) } },
                    '快速建空壳',
                  ),
                  h(
                    'button',
                    { className: 'dshpz-act', title: '先让 AI 问最多 ' + limitsOf(data).askQuestions + ' 问，再 op:init', onClick: function () { askAi(view, null, interviewTemplate) } },
                    '采访后再建',
                  ),
                ),
                h('div', { className: 'dshpz-hint' }, '「照现有项目搭文档」= 项目已在工作区里，只是还没文档；下面两条 = 从零建一个新项目。'),
              ),
              h('div', { className: 'dshpz-hint' }, '目录：' + (data.projectRoot || '?') + '/<项目名>/拼图/'),
              scanPicker(view),
            ),
            h(
              'div',
              { className: 'dshpz-col' },
              h(
                'div',
                { className: 'dshpz-sect' },
                h('div', { className: 'dshpz-secttitle' }, '绑定已有项目', h('span', { className: 'dshpz-count' }, String(existingList.length))),
                // 单绑定 / 多绑定两种模式（用户裁定：在「未绑定」这一块就分出来）。
                // 为什么先选模式再选项目：两者的**动作语义不同**——单绑定是「就绑这一个」
                // （会解绑别处），多绑定是「追加，之后在它们之间切」。先选模式，按钮文案
                // 与后续行为才不会打架。
                h(
                  'div',
                  { className: 'dshpz-seg', style: { marginBottom: '6px' } },
                  [['single', '单绑定'], ['multi', '多绑定']].map(function (pair) {
                    return h(
                      'button',
                      {
                        key: pair[0],
                        'data-on': (view.state.bindMode || 'single') === pair[0] ? '1' : '0',
                        title: pair[0] === 'single'
                          ? '本会话只绑这一个项目（会解绑其它项目）——切换条上就一颗胶囊'
                          : '本会话同时绑多个项目（追加，可多选）——可在「项目」区的切换条上换当前',
                        onClick: function () { setState({ bindMode: pair[0], bindPick: [] }) },
                      },
                      pair[1],
                    )
                  }),
                ),
                h('div', { className: 'dshpz-muted', style: { marginBottom: '6px', lineHeight: '1.5' } },
                  (view.state.bindMode || 'single') === 'single'
                    ? '只绑一个：切换条上只有这一颗胶囊，按这一个项目的模式与工作流走；工作区还有别的项目时会多一个 ＋ 用来追加。'
                    : '绑多个：勾选几个项目一起绑（最后一个成为当前项目），之后在「项目」区的切换条上换当前。'),
                existingList.length === 0
                  ? h('div', { className: 'dshpz-muted' }, '工作区里还没有拼图项目。')
                  : (view.state.bindMode || 'single') === 'multi'
                    ? h(
                      'div',
                      { className: 'dshpz-findings' },
                      existingList.map(function (item) {
                        var picked = (view.state.bindPick || []).indexOf(item.name) >= 0
                        return h(
                          'label',
                          { className: 'dshpz-finding', key: item.name, style: { cursor: 'pointer' } },
                          h('div', { className: 'dshpz-ffact' }, (picked ? '☑ ' : '☐ ') + item.name + ' · 健康性 ' + item.health + '%'),
                          h('input', {
                            type: 'checkbox',
                            checked: picked,
                            onChange: function () {
                              var list = (view.state.bindPick || []).slice()
                              var at = list.indexOf(item.name)
                              if (at >= 0) list.splice(at, 1)
                              else list.push(item.name)
                              setState({ bindPick: list })
                            },
                          }),
                        )
                      }),
                      h(
                        'button',
                        {
                          className: 'dshpz-act',
                          style: { marginTop: '5px' },
                          disabled: (view.state.bindPick || []).length === 0,
                          onClick: function () { bindMany(view, view.state.bindPick || []) },
                        },
                        '绑定选中的 ' + (view.state.bindPick || []).length + ' 个',
                      ),
                    )
                    : h('div', { className: 'dshpz-findings' }, existingList.map(function (item) {
                      return h(
                        'div',
                        { className: 'dshpz-finding', key: item.name },
                        h('div', { className: 'dshpz-ffact' }, item.name + ' · 健康性 ' + item.health + '%'),
                        h(
                          'button',
                          { className: 'dshpz-act', onClick: function () { bindTo(view, item.name) } },
                          '绑定',
                        ),
                      )
                    })),
              ),
            ),
          ),
        )
      }

      var modes = ['只拼不写', '写后再拼', '边拼边写']
      var projects = view.state.projects
      var projectList = projects !== null && projects !== undefined && Array.isArray(projects.projects) ? projects.projects : []
      /**
       * 本会话**绑定的**项目（不是工作区全部项目）。切换条只列这几个——用户裁定
       * 「把切换条的范围缩小为选择绑定的那几个」。工作区全部项目仍然有用，
       * 但那是「＋ 追加绑定」的候选，不是切换条的选项。
       *
       * 兜底：宿主没给 `bindings`（老版本 / 未绑定）时，退回「只有当前项目」这一项——
       * 让面板在降级状态下仍然可用，而不是整块空掉。
       */
      // 走 `boundNamesOf` 认两种形状，再按名字回填详情——直接 `.map(b => b.project)`
      // 遇到字符串数组会得到一串 `undefined`，胶囊会显示成空白。
      var bindingList = boundNamesOf(data).length > 0
        ? boundNamesOf(data).map(function (name) {
          for (var i = 0; i < (data.bindings || []).length; i += 1) {
            var item = data.bindings[i]
            if (item !== null && item !== undefined && typeof item === 'object' && item.project === name) return item
          }
          return { project: name, current: name === data.currentProject, mode: data.mode, health: data.health, moduleCount: (data.modules || []).length }
        })
        : (inited && data.project ? [{ project: data.project, current: true, mode: data.mode, health: data.health, moduleCount: (data.modules || []).length }] : [])
      var bindingWarn = typeof data.bindingWarnThreshold === 'number' && bindingList.length > data.bindingWarnThreshold
      var dimensions = data.dimensions !== null && data.dimensions !== undefined ? data.dimensions : {}
      var moduleTiles = (Array.isArray(data.modules) ? data.modules : []).map(function (module) {
        return {
          id: 'module:' + module.name,
          kind: 'module',
          name: module.name,
          score: module.health,
          exists: module.exists,
          counts: module.counts,
        }
      })

      return h(
        'div',
        { className: 'dshpz-panel' },
        header,
        h(
          'div',
          { className: 'dshpz-body' },
          /* -------- 左栏：项目、模式、动作。这一栏是「我要做什么」 -------- */
          h(
            'div',
            { className: 'dshpz-col' },
            h(
              'div',
              { className: 'dshpz-sect' },
              h(
                'div',
                { className: 'dshpz-secttitle' },
                '项目',
                bindingList.length > 1
                  ? h('span', { className: 'dshpz-count' }, String(bindingList.length))
                  : null,
              ),
              // 切换条占「项目名」那一格。**单绑定也要走它**——不是为了让用户「切」
              // （只有一个没什么可切），而是因为「＋ 再绑一个」的入口在这里；
              // 藏掉它，单绑定的用户就再也加不了第二个项目了。
              // 真没什么可显示时（只有一个绑定、且没有别的项目可加），
              // `bindingSwitcher` 自己退回一行普通项目名。
              bindingList.length > 0
                ? bindingSwitcher(view, data, bindingList, projectList, bindingWarn)
                : h('div', { className: 'dshpz-muted' }, data.project || '未命名'),
              h('div', { className: 'dshpz-docpath', style: { marginTop: '6px' } }, data.projectDir || ''),
            ),
            h(
              'div',
              { className: 'dshpz-sect' },
              h('div', { className: 'dshpz-secttitle' }, '执行模式'),
              h(
                'div',
                { className: 'dshpz-seg' },
                modes.map(function (mode) {
                  return h(
                    'button',
                    {
                      key: mode,
                      'data-on': data.mode === mode ? '1' : '0',
                      // 名字的含义换过（v5）：`边拼边写` 现在指「每个写动作前先问」，
                      // 旧的「一轮做完才问」叫 `写后再拼`。悬停/长按能看到差别，免得选错。
                      title: MODE_HINTS[mode] || '',
                      onClick: function () {
                        writeMode(view.state.sessionId, mode, data.project)
                      },
                    },
                    mode,
                  )
                }),
              ),
              h('div', { className: 'dshpz-muted', style: { marginTop: '7px', lineHeight: '1.55' } },
                MODE_HINTS[data.mode] || 'AI 可以动手；具体在什么时候问，见模式按钮的说明。'),
              // front-matter 里还写着旧名字时如实提示：它已被按旧含义（写后再拼）读，
              // 迁移一次才会把名字改过来。不说的话用户会以为「我明明选的是边拼边写」。
              data.modeRenamed === true
                ? h('div', { className: 'dshpz-muted', style: { marginTop: '6px', lineHeight: '1.55' } },
                  '⚠ 文档里写的还是旧名字「边拼边写」（当时表示一轮做完才问），已按「写后再拼」读取；跑一次「迁移/重构」会把名字改过来。')
                : null,
            ),
            // 动作按「干什么」分组：看项目 / 让 AI 动手 / 改文档。分组比一长排按钮好扫。
            h(
              'div',
              { className: 'dshpz-sect' },
              h('div', { className: 'dshpz-secttitle' }, '看项目'),
              h(
                'div',
                { className: 'dshpz-acts-vert' },
                // 「审查 / 真实值」按钮已删（v0.23.0，用户裁定「看项目的审查没什么用」）：
                // 它拉的是 op:audit 的 RPC，而那块「真实值（声明 → 实测）」显示区也一起删了——
                // 没按钮拉数据，显示区就永远是空的。审查能力本身没动（op:audit 还在，
                // 「让 AI 动手」区的「审查（交给 AI）」仍可用）。
                h(
                  'button',
                  {
                    className: 'dshpz-act',
                    'data-on': view.state.showMain === true ? '1' : '0',
                    title: '只读查看主文档原文（含 front-matter 与五节）；工作流条目与归档也在这一块',
                    onClick: function () {
                      var next = view.state.showMain !== true
                      setState({ showMain: next })
                      // 关掉再打开时**重新拉**：文档可能已被 AI 改过，缓存会给出过期原文。
                      if (next) loadMain(view.state.sessionId, data.project)
                    },
                  },
                  icon('doc', 13), h('span', null, '主文档' + (view.state.showMain === true ? ' · 收起' : '')),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dshpz-sect' },
              h('div', { className: 'dshpz-secttitle' }, '让 AI 动手'),
              h(
                'div',
                { className: 'dshpz-acts-vert' },
                // **新增模块文档**：在**当前项目**里再加一份模块文档（走 op:module）。
                // 与空态的「照现有项目搭文档」区分：那条是「一份文档都没有」时搭整套；
                // 这条是项目已有文档、只是要再添一个模块。名字刻意不叫「新建文档」——
                // 那个说法和空态那条混起来过（用户指正过一次），这里写清是「加模块」。
                h(
                  'button',
                  {
                    className: 'dshpz-act',
                    title: '把提示词填进输入框：在当前项目里再加一份模块文档，并同步主文档的「模块索引」（不会新建项目、不动已有文档）',
                    onClick: function () { askAi(view, null, newDocTemplate) },
                  },
                  icon('doc', 13), h('span', null, '新增模块文档'),
                ),
                // **接续会话**：新会话别通读全部文档。文档全量读一遍是几千字，
                // 而本轮真正用得到的通常只有一两个模块——主文档本来就是查找入口。
                h(
                  'button',
                  {
                    className: 'dshpz-act',
                    title: '把「接续会话」提示词填进输入框：新会话按需读（先 op:read → 只读主文档 → 只读相关那一个模块），不通读全部',
                    onClick: function () { askAi(view, null, resumeTemplate) },
                  },
                  h('span', null, '接续会话'),
                ),
                h(
                  'button',
                  {
                    className: 'dshpz-act',
                    title: '让 AI 按五维审查这个项目，并出可执行修复清单',
                    onClick: function () { askAi(view, null, auditTemplate) },
                  },
                  h('span', null, '审查（交给 AI）'),
                ),
                // **工作流模板**：工作流是**标准化流水线**（为完成某任务，把重复的步骤、工具、
                // 规则按顺序串成一条可复用的路），不是待办清单、也不是禁令；
                // 所以模板要求模型先问清「是哪条流程、依次哪些步骤」，再 op:main 落盘。
                h(
                  'button',
                  {
                    className: 'dshpz-act',
                    title: '把「工作流」提示词填进输入框：先问清是哪条流程、依次经过哪些步骤，再用 op:main 写成 ### 名字 + 有序步骤',
                    onClick: function () { askAi(view, null, workflowTemplate) },
                  },
                  icon('rules', 13), h('span', null, '工作流模板'),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dshpz-sect' },
              h('div', { className: 'dshpz-secttitle' }, '改文档'),
              h(
                'div',
                { className: 'dshpz-acts-vert' },
                // **常驻**：迁移/重构不只在旧格式时需要——格式对得上但正文超长、没出处、
                // 条数超限时，同样要按规格重写。点它 = **把提示词填进输入框**，
                // 真正的动作由模型按提示词执行（先 op:rebuild 落盘，再逐节重写正文）。
                h(
                  'button',
                  {
                    className: 'dshpz-act',
                    'data-on': data.outdated === true ? '1' : '0',
                    title: '把「全量迁移/重构」提示词填进输入框：按最新规格清理全部文档，不留手'
                      + (data.outdated === true ? '（当前是旧格式 v' + data.version + '，建议先跑）' : ''),
                    onClick: function () { askAi(view, null, refactorTemplate) },
                  },
                  data.outdated === true ? icon('alert', 13) : null,
                  h('span', null, '迁移/重构' + (data.outdated === true ? ' ⚠' : '')),
                ),
                // 只改形状的机械动作不必经过模型：这里直接出预览（dry-run），确认后落盘。
                h(
                  'button',
                  {
                    className: 'dshpz-act',
                    title: '只迁移文档格式（不经过 AI）：收敛成五节、补小节、拆 悬而未决/已定，正文不动。先出预览',
                    onClick: function () { rebuildNow(view, false) },
                  },
                  h('span', null, '仅迁移格式'),
                ),
              ),
            ),
            styleWarning,
            notice,
            settingsRow(view),
            data.cwdSource !== undefined && data.cwdSource !== 'session'
              ? h('div', { className: 'dshpz-warn' }, icon('alert', 14), h('span', null, '拿不到会话工作目录，已退回 ' + data.projectRoot + '（文档可能写错地方）'))
              : null,
            h(
              'div',
              { className: 'dshpz-sect' },
              h(
                'div',
                { className: 'dshpz-acts' },
                h(
                  'button',
                  {
                    className: 'dshpz-act',
                    'data-tone': 'danger',
                    title: '解绑本会话（回到没绑定；文档与文件夹都留着，不会被删）',
                    onClick: function () { unbind(view) },
                  },
                  h('span', null, '解绑本会话'),
                ),
              ),
            ),
          ),

          /* -------- 中栏：读数。这一栏是「现在什么状态」 -------- */
          h(
            'div',
            { className: 'dshpz-col' },
            h(
              'div',
              { className: 'dshpz-hero' },
              heroRing(data.health),
              h(
                'div',
                { className: 'dshpz-herotext' },
                h('div', { className: 'dshpz-herolabel' }, '项目健康性'),
                h('div', { className: 'dshpz-heroval' }, healthVerdict(data.health)),
                h('div', { className: 'dshpz-muted', style: { marginTop: '3px' } },
                  '来自文档里写下的证据（要点 / 详细记录 / 悬而未决 / 已定 / 坑）——空文档就是 0，不是印象分。'),
              ),
            ),
            h(
              'div',
              { className: 'dshpz-sect' },
              h('div', { className: 'dshpz-secttitle' }, '五维', h('span', { className: 'dshpz-count' }, '跨模块均值 · 声明值')),
              h('div', { className: 'dshpz-dims' }, DIMENSION_KEYS.map(function (key) {
                return dimensionRow(key, dimensions[key] || 0)
              })),
            ),
            // **项目规模（小 / 中 / 大）**：决定同一个项目写多细（条数上限与字数上限）。
            // 存主文档 front-matter 的 `规模:`，跟着项目走；没写就是「中」（= 升级前的值）。
            sizeBlock(view),
            h(
              'div',
              { className: 'dshpz-sect' },
              h('div', { className: 'dshpz-secttitle' }, '模块', h('span', { className: 'dshpz-count' }, String(moduleTiles.length))),
              moduleTiles.length === 0
                ? h('div', { className: 'dshpz-empty' }, h('span', { className: 'dshpz-emptyicon' }, icon('grid', 24)), h('div', { className: 'dshpz-emptytitle' }, '还没有模块'), h('div', { className: 'dshpz-muted' }, '让 AI 用 op:init 带 modules 一起建。'))
                : h('div', { className: 'dshpz-grid' }, moduleTiles.map(function (piece) { return tile(piece, view) })),
            ),
            findingsBlock(view),
            h(
              'div',
              { className: 'dshpz-hint' },
              '拼图文档只能由 AI 通过 puzzle_mode 改；write / edit 会被文档锁拒绝（所有模式）。',
              h('br', null),
              // 收尾问被全局关掉时**如实说不问**：面板还在承诺「每次提问最后都会问」，
              // 而模型已经不问——那是最让人困惑的一种不一致。
              pauseEnabledOf(view)
                ? '每次提问的最后都会问：' + PAUSE_QUESTION + '（可在左栏「全局设置」里关掉）'
                : '固定收尾问已全局关闭：提问不再带「' + PAUSE_QUESTION + '」。',
              h('br', null),
              '一轮最多 ' + limitsOf(data).askQuestions + ' 问、每题最多 ' + limitsOf(data).askOptions + ' 个选项。',
            ),
          ),

          /* -------- 右栏：文档与细节。这一栏是「具体内容是什么」 -------- */
          h(
            'div',
            { className: 'dshpz-col' },
            detailBlock(view),
            workflowBlock(view),
            mainBlock(view),
            rebuildBlock(view),
          ),
        ),
      )
    }

    function Panel(props) {
      // 面板从共享 store 读 inputActions（shell.overlay 的 props 里没有它）。
      var view = useStore()

      React.useEffect(
        function () {
          if (view.state.open !== true) return undefined
          var sessionId = props.sessionId === undefined ? view.state.sessionId : props.sessionId
          // 开关按**会话**判定，必须拿真实的 sessionId（早先传占位串 'panel' 是全局语义的遗留）。
          loadSettings(sessionId)
          if (sessionId === undefined || sessionId === null) return undefined
          load(sessionId)
          loadProjects(sessionId)
          // 主文档与工作流共用一次取数：**每次打开都重拉**（文档可能刚被 AI 改过），
          // 否则展开「主文档」看到的会是上一次打开时的旧原文。
          loadMain(sessionId)
          // 轮询**不能带显式 project**：这个闭包是在 effect 首次运行时捕获的，
          // 解绑不会让 effect 重跑，所以它会一直握着「解绑前那个项目名」。
          // 而显式 project 在宿主侧的优先级高于绑定 —— 于是解绑 8 秒后面板又显示成已绑定，
          // 看起来就是「解绑了过一会又自动绑定」。只给 sessionId，让宿主按绑定解析。
          //
          // 主题也一起刷：它挂在**全局状态**上，用户在主题页换了皮肤之后，
          // 面板与按钮都得跟着变；只刷 `state` 的话按钮要等下一次挂载才更新。
          loadActiveTheme(sessionId)
          var timer = window.setInterval(function () {
            load(sessionId)
            loadActiveTheme(sessionId)
          }, POLL_MS)
          return function () {
            window.clearInterval(timer)
          }
        },
        [view.state.open, view.state.sessionId, props.sessionId],
      )

      React.useEffect(function () {
        var onKey = function (event) {
          if (event.key !== 'Escape') return
          // Esc 先退出**当前视图**：主题页开着时退回项目面板，而不是把面板整个关掉
          // （一次 Esc 直接关掉面板会让人以为面板自己弹回去了）。
          if (state.themeOpen === true) {
            setState({ themeOpen: false, themeNotice: null, themeError: null })
            return
          }
          setState({ open: false, detail: null, detailName: null })
        }
        window.addEventListener('keydown', onKey)
        return function () {
          window.removeEventListener('keydown', onKey)
        }
      }, [])

      /**
       * 把用户主题挂到文档上。
       *
       * 与 `Button` 里那条是同一件事（`applyUserTheme` 幂等，按 id 复用同一个节点）。
       * 两处都挂是因为两个组件**都可能先挂载**：面板开着时按钮也在，反之亦然。
       * 依赖放的是 `themeCss` 字符串本身——它是 `state` 顶层字段，换主题才会变，
       * 8 秒轮询不会触发重挂。
       */
      React.useEffect(
        function () {
          var reason = applyUserTheme(view.state.themeCss)
          // 前端复检拒绝时**如实说出来**：宿主半本该已经拦下，走到这里说明
          // 两边口径不一致（或被中间层改写过）。静默退回默认皮肤会让人以为主题坏了。
          if (reason !== null && reason !== 'empty') {
            setState({ themeError: '主题 CSS 未通过前端安全复检（' + reason + '），已退回默认皮肤' })
          }
          return undefined
        },
        [view.state.themeCss],
      )

      if (view.state.open !== true) return null

      // **主视图二选一**（v0.27.1）：主题页不再是压在面板上的浮层，而是面板主体的
      // 另一种内容。两个视图共用**同一层** `.dshpz-backdrop`（负责全屏居中 + 点外部关闭），
      // 里面各装各的 `.dshpz-panel`——所以屏幕上永远只有一套玻璃框。
      var themeMode = view.state.themeOpen === true

      return h(
        'div',
        {
          className: 'dshpz-backdrop',
          // **内联兜底**（v0.16.2 加的）：万一整张样式表都没生效（老 WebView 丢弃
          // `inset` 简写、CSP 拦掉 <style>、或别的插件把样式清了），
          // 面板至少还是「全屏居中」的可用状态，
          // 而不是缩在左上角、文字互相压着。
          //
          // 只内联**没有被 @media 覆盖过**的属性：`padding` 故意不内联，
          // 因为窄屏那条 `@media (max-width:900px)` 会把它改成 10px，
          // 内联会盖掉媒体查询，等于把手机端的边距改坏。
          // 写的值与 `.dshpz-backdrop` 一致，所以样式正常时看不出差别。
          // **`background` 也故意不写**（v0.27.1）：遮罩已按用户要求删掉，
          // 内联再写一遍 rgba 就等于「样式表删了、兜底又加回来」，改了个寂寞。
          style: {
            position: 'fixed', top: 0, right: 0, bottom: 0, left: 0,
            display: 'flex',
            alignItems: 'center', justifyContent: 'center', zIndex: 40,
          },
          // 点面板外面＝关整个面板（主题页也一样：那本来就是「退出」的直觉）。
          onClick: function (event) {
            if (event.target === event.currentTarget) {
              setState({ open: false, themeOpen: false, detail: null, detailName: null })
            }
          },
        },
        // `panelBody` / `themePage` 各自返回 `.dshpz-panel`（主题令牌挂在 `:root` 上），
        // 所以这里**不再包一层**：多包一层会得到「面板套面板」，玻璃底与网格纹理会叠两次。
        themeMode ? themePage(view) : panelBody(view),
      )
    }

    /* -------------------------------- 按钮 -------------------------------- */

    function Button(props) {
      var view = useStore()
      var data = view.state.data
      var label = data !== null && data !== undefined && data.initialized === true ? data.health + '%' : ''

      // 把输入框动作交给面板：只有这个 Slot 拿得到 inputActions。
      React.useEffect(
        function () {
          if (state.inputActions !== props.inputActions) setState({ inputActions: props.inputActions })
        },
        [props.inputActions],
      )

      /**
       * 按钮挂载时就拉一次当前主题。
       *
       * 为什么不能等面板打开：这颗按钮**一直显示**，而面板是用户点开才渲染的。
       * 主题 CSS 只跟着 `state.data` 走的话，不打开面板就永远看不到按钮换色。
       * 只拉一次（依赖 sessionId）：主题是全局状态，8 秒轮询那条路已经覆盖了
       * 「换主题后要更新」——换主题必然发生在面板里。
       */
      React.useEffect(
        function () {
          loadActiveTheme(props.sessionId)
        },
        [props.sessionId],
      )

      /**
       * 把用户主题挂到文档上。
       *
       * 挂在这里而不是只在 `Panel` 里：**按钮在面板关闭时也存在**，而主题要能罩住按钮。
       * `applyUserTheme` 是幂等的（同一个 `<style>` 节点按 id 复用），所以两处都挂也不会重复。
       * 依赖 `view.state.themeCss`：变了才重挂，8 秒轮询不会打断主题动画。
       */
      React.useEffect(
        function () {
          applyUserTheme(view.state.themeCss)
          return undefined
        },
        [view.state.themeCss],
      )

      return h(
        'button',
        {
          type: 'button',
          className: 'dshpz-btn',
          'data-on': view.state.open === true || view.state.themeOpen === true ? '1' : '0',
          title: '拼图模式：项目健康性、模块与工作流',
          onMouseDown: function (event) {
            event.preventDefault()
          },
          onClick: function () {
            var next = view.state.open !== true
            setState({ open: next, sessionId: props.sessionId, detail: null, detailName: null })
            if (next) {
              load(props.sessionId)
              loadProjects(props.sessionId)
            }
          },
        },
        icon('puzzle', 14),
        h('span', null, '拼图'),
        label === '' ? null : h('span', null, label),
      )
    }

    /* -------------------------------- 填模板 -------------------------------- */

    /**
     * 把模板写进输入框——**不自动发送**，由用户补完问题自己发。
     *
     * `inputActions.setDraft` 是 `conversation.input.left` 的标准 props 之一
     * （见 Client Slot catalog 的 InputActions 契约）。它可能不存在（例如没有
     * 当前会话时是 undefined），所以这里必须容错，不能让面板整个崩掉。
     *
     * `template` 现在**必给**：原先「不给就走提问模板」的兜底随「提问模板」按钮一起删了
     * （用户裁定：面板上不要那个按钮）。少了它就在这里说清楚，不要静默填一段空提示词。
     */
    function askAi(view, prefix, template) {
      var actions = view.state.inputActions
      if (actions === undefined || actions === null || typeof actions.setDraft !== 'function') {
        setState({ error: '当前输入框不可写入（没有会话或输入区未就绪）' })
        return
      }
      if (typeof template !== 'function') {
        setState({ error: '没有可用的提示词模板（面板按钮与模板的对应关系断了）' })
        return
      }
      var data = view.state.data
      var project = data && data.initialized === true ? data.project : ''
      var projectDir = data && data.initialized === true ? (data.projectDir || '') : ''
      // `projectRoot` 在**空态也要给**：空态的「照现有项目搭文档」正是要在没有项目的时候
      // 告诉模型去读哪个目录。它不在 initialized 分支里，所以单独取，别跟着上面的判断走。
      var projectRoot = data && typeof data.projectRoot === 'string' ? data.projectRoot : ''
      var build = template
      // 模板收 (project, projectDir, projectRoot, lim, boundNames)：接续会话那条要把主文档路径
      // 与**全部绑定**写进提示词（多绑定时接续是全局动作），「照现有项目搭文档」那条要在空态
      // 拿到工作区根，`lim` 是宿主下发的上限（见 `limitsOf`——模板里的数字**一律**从它取）。
      var boundNames = boundNamesOf(data)
      // 「提问」模板的收尾问**跟着全局开关走**：关掉之后还往输入框里塞一段
      // 「要不要先停下？」等于用一个按钮把用户的设置又打开一遍。
      var pauseOn = pauseEnabledOf(view)
      var text = prefix === null || prefix === undefined
        ? build(project, projectDir, projectRoot, limitsOf(data), boundNames)
        : '【' + (project || '拼图') + ' · 提问】' + prefix
          + (pauseOn ? '\n\n' + PAUSE_QUESTION + '\n① ' + PAUSE_OPTIONS[0] + '\n② ' + PAUSE_OPTIONS[1] : '')
          + '\n\n（一轮最多 ' + limitsOf(data).askQuestions + ' 问、每题最多 ' + limitsOf(data).askOptions + ' 个选项'
          + (pauseOn ? '；末尾带固定收尾问' : '；固定收尾问已全局关闭') + '）'
      try {
        actions.setDraft(text)
        setState({ open: false, error: null })
      } catch (error) {
        setState({ error: '写入输入框失败：' + String(error && error.message ? error.message : error) })
      }
    }

    /* --------------------------------- 插件 --------------------------------- */

    function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return

      ctx.effect(function () {
        var style = document.createElement('style')
        style.setAttribute('data-dsh-puzzle-mode', '')
        style.textContent = CSS
        document.head.appendChild(style)
        // **样式自检**（v0.16.2 加的）：把「这张表到底有没有生效」变成可远程汇报的一行事实。
        // 为什么需要它：老 WebView / CSP / 别的插件清样式，症状都是「面板能开但没样式」，
        // 而拿到截图的人只能猜。这里在挂载后读一次真实计算值——读不到就说明没生效，
        // 顺手把环境指纹（UA / 三项特性支持）记下来，用户截一次图就够定位。
        // 读的是 `getComputedStyle`，即浏览器**实际采纳**的结果，不是我们写了什么。
        try {
          // **探针里绝不能写 `position`**（v0.16.5 修的 bug ①）：
          // 行内样式的优先级**高于样式表**，原先写的 `position:absolute` 会盖掉
          // `.dshpz-backdrop{position:fixed}`，于是 `getComputedStyle().position`
          // 恒为 `absolute` —— `applied` 在**任何**浏览器上都是 `false`，
          // 自检于是天天报假警。探针只负责挪出视口，position 交给样式表判定。
          var probe = document.createElement('div')
          probe.className = 'dshpz-backdrop'
          probe.style.cssText = 'left:-9999px;top:0;width:10px;height:10px'
          document.body.appendChild(probe)
          var computed = window.getComputedStyle(probe)
          var applied = computed.position === 'fixed'
          document.body.removeChild(probe)
          // 样式表**真的进了文档**没有：`sheet.cssRules` 读得到才算进了
          // （CSP 拦掉 `<style>` 时 `style.sheet` 为 null）。这条与 `applied`
          // 互为交叉验证：只有 `applied` 不可信时它才说得清问题在哪。
          var rules = null
          try {
            rules = style.sheet !== null && style.sheet !== undefined ? style.sheet.cssRules.length : null
          } catch (_e) { rules = null }
          // **这里必须走 `window.CSS`，不能写 `CSS.supports`**（v0.16.5 修的 bug ②）：
          // 本文件第 954 行有 `var CSS = [...]`（样式表字符串），它**遮蔽了**全局 `CSS`。
          // 原先写 `CSS.supports`，取到的是字符串的 `undefined` 属性，
          // `CSS.supports !== undefined` 为假、`&&` 短路 —— 四项特性**一律返回 false**。
          // 那行报告里 `inset=false color-mix=false backdrop=false min()=false`
          // 就是被这个假值骗出来的（Chrome 152 不可能四项全不支持）。
          var supports = function (prop, value) {
            try {
              var css = window.CSS
              return css !== undefined && css.supports !== undefined ? css.supports(prop, value) : null
            } catch (_e) { return null }
          }
          setState({
            styleDiag: {
              applied: applied,
              rules: rules,
              ua: String(navigator.userAgent || '').slice(0, 120),
              inset: supports('inset', '0'),
              colorMix: supports('color', 'color-mix(in srgb,red 50%,blue)'),
              backdrop: supports('backdrop-filter', 'blur(1px)') || supports('-webkit-backdrop-filter', 'blur(1px)'),
              minFn: supports('width', 'min(1px,2px)'),
            },
          })
        } catch (_error) {
          /* 自检本身失败不该影响插件：静默跳过，面板照常渲染 */
        }
        return function () {
          if (style.parentNode !== null) style.parentNode.removeChild(style)
        }
      }, 'dsh-puzzle-mode: styles')

      slots.inject('conversation.input.left', function () {
        return slots.register(
          { name: 'conversation.input.left', id: 'puzzle-mode-button', order: 100 },
          Button,
        )
      })

      slots.inject('shell.overlay', function () {
        return slots.register({ name: 'shell.overlay', id: 'puzzle-mode-panel', order: 50 }, Panel)
      })
    }

    module.exports = {
      name: 'dsh-puzzle-mode',
      apply: apply,
      resumeTemplate: resumeTemplate,
      auditTemplate: auditTemplate,
      refactorTemplate: refactorTemplate,
      createTemplate: createTemplate,
      interviewTemplate: interviewTemplate,
      adoptTemplate: adoptTemplate,
      sizeBlock: sizeBlock,
      newDocTemplate: newDocTemplate,
      bindTemplate: bindTemplate,
      workflowTemplate: workflowTemplate,
      createByForm: createByForm,
      boundNamesOf: boundNamesOf,
      scanCandidates: scanCandidates,
      createMany: createMany,
      loadMain: loadMain,
      removeWorkflow: removeWorkflow,
      restoreWorkflow: restoreWorkflow,
      dropWorkflow: dropWorkflow,
      workflowAction: workflowAction,
      workflowBlock: workflowBlock,
      mainBlock: mainBlock,
      // 导出面板主体与主题，便于在真机之外做一次「元素树 + 令牌」冒烟：
      // 三栏结构、类名、CSS 变量都在这里能看到，不必等页面刷新。
      panelBody: panelBody,
      themeVars: themeVars,
      THEME: THEME,
      CSS: CSS,
      themePage: themePage,
      themeCssRejectReason: themeCssRejectReason,
      applyUserTheme: applyUserTheme,
      unbind: unbind,
      rebuildNow: rebuildNow,
      entryCards: entryCards,
    }
    return module.exports
  },
})
