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
 *   - **主文档只读查看**、模块详情、迁移/重构；
 *   - 一级页的项目列表、工作区绑定、主题页、更新页。
 *
 * 注：v2.1.1 起二级页**只剩两栏**（用户裁定删掉最左栏）：执行模式、交给 AI 的动作、
 * 全局设置两块开关**连同代码一起删除**，只留「项目名 + 路径」与「主文档」。
 * 曾经的「提问模板」按钮也已按用户裁定删除。
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
    /**
     * 侧边栏按钮与主区面板**共用的 id**（v2.0.0，U1）。
     *
     * 侧边栏靠「list 里的 id == main 里的 key」配对找面板，两处必须**同一个字符串**。
     * 抽成常量是为了让「改一处忘了改另一处」在代码上不可能发生——
     * 那种错的表现是「点按钮抛错」，而错误信息完全不会提到 id 不匹配。
     */
    var PANEL_ID = 'puzzle'
    /**
     * 侧边栏排序：排在「插件」按钮（order 0）**下面**。
     *
     * ⚠️ 这是**真机确认前的猜测值**（升级方案 U1 待定项 ③）。宿主侧边栏还有别的按钮，
     * 若真机上位置不对，改这一个数即可。
     */
    var SIDEBAR_ORDER = 10

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
      entryLimits: { index: 50, source: 50, tools: 50, pit: 20, points: 20, pending: 20, decided: 20, reuse: 20, detail: 50 },
      entryCaps: { pending: 4, decided: 10 },
      bindingWarnThreshold: 8,
      // 三档条数上限：兜底也要有，否则首次数据到达前面板会把「小/中/大」显示成 undefined。
      // 与宿主 `PANEL_LIMITS.sizeCaps` 逐字段相等，由契约测试钉住。
      sizeCaps: {
        '小': { pending: 4, decided: 6, pit: 10 },
        '中': { pending: 4, decided: 10, pit: null },
        // 大档的 pit 也是 `null`（不限）——与宿主 `SIZE_CAPS` 同步。
        // 它曾经是 60，而中档不限，于是**切到大档反而收紧**（实测写 70 条被砍到 60）。
        // 契约测试「逐字段相等」就是钉这件事的：漏改这一份会红。
        '大': { pending: 12, decided: 30, pit: null },
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
     *      实测代价：这一段会让模型一上手就全仓翻代码，用户看得烦，轮数也白烧。
     *      （v2.1.1：审查功能已整体删除，所以这条现在是「别做评估」本身。）
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
        '   —— 它只有四节：模块索引 / 源码索引 / 工具索引 / 坑，是**查找入口**。',
        '   重点看「## 坑」与各节的出处。',
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
     * 迁移/重构模板：**全量清理**，不留手。
     *
     * 与 `op:rebuild` 的分工：rebuild 只改**形状**（front-matter、小节存在性），
     * 不动正文；这里要求模型按最新规格把**正文也重写一遍**——旧条目超长、没出处、
     * 条数超限，rebuild 一律不管（它刻意不追溯老条目）。两件事都得做。
     */
    function refactorTemplate(projectName, projectDir, projectRoot, lim) {
      var L = lim || FALLBACK_LIMITS
      return [
        '【' + (projectName || '拼图') + ' · 迁移/重构】',
        '把当前项目的拼图文档**全量清理并重构到最新规格**，不得留手，绝对服从规格：',
        '1. 先 op:rebuild 看预览 → apply:true 落盘（这一步只改形状：收敛成四节、补小节、拆 悬而未决/已定、删已取消的小节）。',
        '2. 逐节重写正文，旧内容不保留原样：',
        '   - 主文档四节：模块索引 / 源码索引 / 工具索引 / 坑；**除这四节外不许有任何内容**。',
        '   - **条目式**小节（模块索引 / 源码索引 / 工具索引 / 坑）每条一句话，超长就砍到上限内：'
          + '坑 ' + L.entryLimits.pit + ' 字、其余 ' + L.entryLimits.index + ' 字；',
        '     这四节每条**必须带（源码: 文件:行）**——去源码里核实，**不许编行号**。',
        '   - 模块 ## 悬而未决 ≤' + L.entryCaps.pending + ' 条、## 已定 ≤' + L.entryCaps.decided + ' 条：超了删最旧，不论有没有澄清。',
        '   - 模块 ## 要点 ≤' + L.entryLimits.points + ' 字、## 详细记录 ≤' + L.entryLimits.detail + ' 字（详细记录 = 轮汇报）。',
        '4. 旧要点里的长句要**压成一句事实**，不是原样搬过去；搬不动的就删。',
        '规则冲突时以规格为准；拿不准的删掉而不是留着。',
      ].join('\n')
    }

    /**
     * 快速建空壳：不采访，直接让模型 op:init（项目名会成为工作区里的文件夹名）。
     *
     * `form`（v2.1.2 新增，可选）是面板新建表单里已经填好的三个值。
     * 为什么要传进来：模板原先三行都是 `<占位符>`，让模型自己去猜项目名——
     * 而用户**明明已经在表单里填了**。填了还让它猜，它就会造一个别的名字出来，
     * 然后用户看到的文件夹跟他填的不是一个。所以填了就用填的，没填才留占位符。
     */
    function createTemplate(projectName, form) {
      var f = form === null || form === undefined ? {} : form
      var modules = String(f.modules === undefined || f.modules === null ? '' : f.modules).trim()
      var goal = String(f.goal === undefined || f.goal === null ? '' : f.goal).trim()
      return [
        '【' + (projectName || '拼图') + ' · 建项目】',
        '直接调 puzzle_mode 的 op:init 把项目建出来，不要先采访：',
        '- project：' + (projectName || '<工作区里的文件夹名，请替换成真实项目名>'),
        '- modules：' + (modules !== '' ? modules : '<模块名，逗号分隔；每个模块一份文档>'),
        '- goal：' + (goal !== '' ? goal : '<一句话目标>'),
        '建完把主文档与每个模块文档的路径回报给我；目录固定为 <工作区>/<项目名>/拼图/。',
      ].join('\n')
    }

    /**
     * 采访后再建：**第一轮只准问，什么都不许做**；拿到回答之后才建。
     *
     * `form`（v2.1.2 新增，可选）同 `createTemplate`：用户在表单里填了就先照它来，
     * 只把**没填的那些**留给采访。已经写死的项目名不该再问一遍「项目叫什么」。
     *
     * ## v2.1.6：为什么把「只准问」提到最前面、并且写成硬约束
     *
     * 用户原话：「我想的是直接点采访键出会话自动发规则后**他不要搞东西只问我**
     * 新项目文档要怎么搞」。
     *
     * 原先这段模板是「先采访**再建**」——把两件事写在同一段里，模型看到
     * `op:init` / `op:bind` 这些动作，很容易**跳过提问直接开工**，或者一边问
     * 一边自己去翻工作区（实测它去搜了 `puzzle_mode|op:init|已废弃`）。
     * 那看起来就是「不知道在搞什么飞机」。
     *
     * 改法：第一轮的任务**只有提问**，并且明确禁止三件事——
     * 调任何 `puzzle_mode` 操作、读/搜任何文件、建任何东西。
     * 「先问清楚再动手」本来就是这条路的意义；不分两段写，模型就会自己合并。
     */
    function interviewTemplate(projectName, projectDir, projectRoot, lim, form) {
      var L = lim || FALLBACK_LIMITS
      var f = form === null || form === undefined ? {} : form
      var modules = String(f.modules === undefined || f.modules === null ? '' : f.modules).trim()
      var goal = String(f.goal === undefined || f.goal === null ? '' : f.goal).trim()
      var known = []
      if (projectName !== undefined && projectName !== null && String(projectName).trim() !== '') known.push('项目名：' + String(projectName).trim())
      if (modules !== '') known.push('模块：' + modules)
      if (goal !== '') known.push('目标：' + goal)
      var lines = [
        '【' + (projectName || '拼图') + ' · 新项目文档怎么建】',
        '这条路是**先采访再建**：先问清楚，再动手。',
        '',
        '## 这一轮你只做一件事：问我问题',
        '',
        '**不要调用任何工具**（尤其不要调 `puzzle_mode`），**不要读任何文件、不要搜索工作区**，'
          + '**不要建任何东西**。这一轮你的全部产出就是一组问题。',
        '**不要提前调 op:init**（也不要 `op:bind`）——那是我回答之后的事。',
        '问完就停下等我回答——我会一次性回你，你再动手。',
        '',
        '问的是：**这个新项目的文档要怎么组织**。',
      ]
      if (known.length > 0) {
        lines.push(
          '',
          '下面这些我在面板表单里**已经填了**，直接照用，不要再问：',
        )
        for (var k = 0; k < known.length; k += 1) lines.push('  - ' + known[k])
        lines.push('只问**没填的部分**（比如模块怎么划、边界在哪）。')
      }
      lines.push(
        '',
        '## 问题怎么问',
        '',
        '- 一轮最多 ' + L.askQuestions + ' 问、每题最多 ' + L.askOptions
          + ' 个选项，能用选项就用选项',
        '- **每题给 3–6 个真岔路、每个配一句取舍**，推荐项放第一并加「（推荐）」；'
          + '只说「① 是 ② 否」等于没问——我看不到代价就没法选',
        '- 找岔路问这五个维度：**做法**（走哪条路）/ **范围**（改多大）/ **时机**（现在做还是先记下）/'
          + ' **代价**（怎么退、多花什么）/ **取舍**（快 vs 稳、通用 vs 专用）',
        '',
        '## 我回答之后你再做（现在别做）',
        '',
        '- 用 `puzzle_mode` 的 `op:init` **一次同时创建主文档与每个模块一份文档**（显式给 project 与 modules）',
        '- 项目名会成为工作区里的文件夹名；目录固定为 <工作区>/<项目名>/拼图/',
        '- `op:init` 建完会**追加**一个绑定（不是替换）——若返回 `rebound:false`，'
          + '**必须再调 `op:bind` 把本会话绑上**，否则面板仍停在空态',
      )
      return lines.join('\n')
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
          + '，坑 ' + (L.sizeCaps['小'].pit) + ' 条）；',
        '  - 中：≲20k 行、模块 ≲8 个 → 默认档（悬而未决 ' + (L.sizeCaps['中'].pending) + ' / 已定 ' + (L.sizeCaps['中'].decided)
          + '，坑不限）；',
        '  - 大：更多行数或模块 → 条目放宽（悬而未决 ' + (L.sizeCaps['大'].pending) + ' / 已定 ' + (L.sizeCaps['大'].decided)
          + '，坑 ' + (L.sizeCaps['大'].pit) + ' 条；字数也放宽）；',
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
     * 从用户主题 CSS 里取出「声明在根元素上」的 `--dshpz-*` 变量。
     *
     * 为什么需要这一步（v2.1.12，待办 A 的配套）：内置样式表现在**同时在 `:root`
     * 和 `body` 上**声明 `--dshpz-*`。`body` 那份是必要的（`var(--dsw-alias-*)`
     * 必须在宿主令牌所在的同一个元素上求值，见 `CSS` 里那条注释），但它会**盖住**
     * 用户主题写在 `:root` / `html` 上的覆盖值——而白名单只允许用户写这两个
     * （`body{--dshpz-*}` 被 `validateThemeCss` 明确拒绝），
     * 于是「换肤」会变成静默失效：状态说换了，界面一点没变。
     *
     * 修法是把用户主题里的这些变量**再写一份到 `body` 的行内样式**——行内样式
     * 优先级高于任何样式表，必定赢过内置的 `body{}` 那条。刻意**不改用户的 CSS 文本、
     * 也不多挂节点**：`test/70-themes.test.mjs` 逐字断言主题节点内容 === 用户 CSS、
     * 且只创建一个 style 节点，那两条守的是「我们不动用户写的东西」，必须原样通过。
     *
     * ## 只取「根元素」块，且只取顶层
     *
     * - 判据与白名单**逐字对齐**：选择器里有一整段恰好是 `:root` 或 `html`
     *   （`themes.js` 的 `checkSelectors` 就是这么判的，刻意用全等而不是前缀，
     *   所以 `html.dark{}` 根本进不来）。`.dshpz-panel{--dshpz-…}` 这类声明本就
     *   作用在面板子树里，面板内的 `var()` 在**声明处**求值、自己就能看到 `body`
     *   的宿主令牌，不需要也不应该被抬到 `body` 上——那会把面板级覆盖变成全局覆盖。
     * - **不递归 `@media`**：把媒体查询里的覆盖无条件写到行内，等于让它在所有宽度下
     *   都生效，那是错的。这类主题保持原状（`<style>` 节点里的规则仍然照旧生效，
     *   只是赢不过内置的 `body{}`）——比「在所有宽度下都用错的值」要好。
     *   脚手架生成的主题与现有主题都是顶层 `:root`，走的是上面那条完整生效的路。
     */
    function rootScopedThemeVars(css) {
      var out = {}
      // 去注释，避免注释里的花括号/声明被当成真的。
      var text = String(css).replace(/\/\*[\s\S]*?\*\//g, ' ')
      var i = 0
      while (i < text.length) {
        var open = text.indexOf('{', i)
        if (open < 0) break
        var head = text.slice(i, open).trim()
        // 扫到配对的收尾花括号（顶层块之间不会嵌套，除了 at-rule 内部）。
        var depth = 1
        var j = open + 1
        while (j < text.length && depth > 0) {
          if (text[j] === '{') depth++
          else if (text[j] === '}') depth--
          j++
        }
        var blockBody = text.slice(open + 1, j - 1)
        // at-rule 一律跳过（见上面「不递归 @media」）。
        if (head.charAt(0) !== '@') {
          var parts = head.split(',')
          var isRoot = false
          for (var p = 0; p < parts.length; p++) {
            var part = parts[p].trim()
            if (part === ':root' || part === 'html') isRoot = true
          }
          if (isRoot) {
            var decls = blockBody.split(';')
            for (var d = 0; d < decls.length; d++) {
              var idx = decls[d].indexOf(':')
              if (idx < 0) continue
              var name = decls[d].slice(0, idx).trim()
              var value = decls[d].slice(idx + 1).trim()
              if (name.indexOf('--dshpz-') !== 0) continue
              if (value === '') continue
              out[name] = value
            }
          }
        }
        i = j
      }
      return out
    }

    /**
     * 把用户主题在根元素上的变量镜像到 `body` 行内样式（或撤掉）。
     *
     * 幂等：先清掉上一次镜像的名字再写当前的，所以换主题 / 撤主题都不会留下残值。
     * 走过的名字要记住——否则撤主题时不知道该删哪些。
     */
    var mirroredThemeVars = []
    function mirrorUserThemeToBody(doc, css) {
      var body = doc !== null && doc.body ? doc.body : null
      if (body === null || typeof body.style !== 'object' || body.style === null) return
      if (typeof body.style.setProperty !== 'function') return
      for (var i = 0; i < mirroredThemeVars.length; i++) body.style.removeProperty(mirroredThemeVars[i])
      mirroredThemeVars = []
      if (typeof css !== 'string') return
      var vars = rootScopedThemeVars(css)
      for (var name in vars) {
        if (!Object.prototype.hasOwnProperty.call(vars, name)) continue
        body.style.setProperty(name, vars[name])
        mirroredThemeVars.push(name)
      }
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
     *
     * v2.1.12：除 `<style>` 节点外，`--dshpz-*` 还要**镜像一份到 `body` 行内样式**
     * （理由见 `rootScopedThemeVars`）。节点本身仍然只有一个、内容仍然逐字是用户 CSS。
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
        mirrorUserThemeToBody(doc, null)
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
      mirrorUserThemeToBody(doc, css)
      return null
    }

    /* ------------------------------- 共享 store ------------------------------- */

    var state = {
      /**
       * 面板是否打开。
       *
       * v2.0.0 起它**不再由面板自己控制**（面板住在主区槽位里，由宿主的
       * `activePanelId` 决定渲染哪一块）。留着这个字段是为了：
       *   ① 侧边栏按钮的选中态判断；
       *   ② 旧代码路径里的 `state.open` 读值不至于变成 `undefined`（会静默改变分支）。
       * 真正的开关走 `ctx.layout.selectPanel(PANEL_ID | null)`。
       */
      open: false,
      /**
       * 一级面板的当前视图（v2.0.0，U2/U4）。
       *
       * ## 为什么收敛成枚举，而不是继续用 `themeOpen` / `updateOpen` 两个布尔
       *
       * 加子页之后视图变成**四个**（项目列表 / 项目二级 / 主题 / 更新），
       * 三个布尔互斥靠点击处手工维护已经不够用——代码注释里就写过
       * 「手改状态 / 新入口忘清」的警告。一个枚举让「同时为真」在结构上不可能。
       *
       * ⚠️ `themeOpen` / `updateOpen` **保留为派生字段**（见 `setState` 的同步），
       * 因为主题页 / 更新页内部还有大量代码在读它们。删掉会牵动几十处，
       * 而收益只是「少两个字段」。
       */
      view: 'projects',
      /**
       * 二级面板的子页：`info`（拼图文档信息）/ `dispatch`（派单系统）。
       *
       * **独立持久化**：切到派单系统后刷新 / 重开面板仍停在派单系统——
       * 用户在里面做事，一次误刷新就回到信息页会让他丢掉上下文。
       */
      tab: 'info',
      /** 主题页 / 更新页是否打开（由 `view` 派生，见上面的说明）。 */
      themeOpen: false,
      updateOpen: false,
      /**
       * 工作区选择器是否展开（v2.1.1）。
       *
       * 默认**折叠**：宿主的工作区可能有一二十个，全铺出来会把一级页顶到屏幕外面，
       * 而「换数据工作区」是低频动作。折叠时只显示当前绑的那个 + 一个「更换」。
       */
      wsOpen: false,
      /**
       * 「快速建空壳 / 采访后再建」正在起会话（v2.1.2）。
       *
       * 起会话要几秒，而它**真的会造出一个会话**——所以这一段必须把按钮禁掉。
       * 不禁的话连点三下就是三个会话、三份互相矛盾的文档，而用户只看到一次点击。
       */
      buildBusy: false,
      /**
       * 面板内浮窗里那个会话（v2.1.3；v2.2.0 起有 `kind`）。
       *
       * `null` = 没浮窗。否则：
       *   - `{kind, sessionId, reference, wired, wiredTool, wiredReason}` 成功；
       *   - `{kind, sessionId, error}` 会话起好了但客户端还拿不到它（见 `openBuildFloat`）。
       *
       * `kind` 三种（v2.2.0）：
       *   - `'build'`：新建项目那两条 AI 路的会话（v2.1.3 的老行为）；
       *   - `'brain'`：全局大脑（派单页左上角那颗按钮）；
       *   - `'clarify'`：澄清器（从大脑分叉出来的子代理）。
       *
       * ## 为什么共用一个槽位而不是三个
       *
       * 浮窗是**同一个位置、同一层**，同时开两个只会互相盖住。用一个槽位
       * 让「同时只能开一个」在结构上成立，而不是靠三处各自记得关掉别的。
       * 差别只在头部文案与 ✕ 的语义（见 `buildFloatLayer`）。
       *
       * `reference` 是 `sessions.retain()` 的产物——**必须**留着并在关窗时
       * `release()`，否则那个会话会被客户端一直持有（引用计数不归零就不回收 scope）。
       */
      build: null,
      /**
       * **卡详情浮窗**（v2.4.3）：存的是**卡 id**（不是卡对象）。
       *
       * ## 为什么存 id 而不是整张卡
       *
       * 卡会变（8 秒轮询刷新、别的窗口搬列、AI 做完自动搬列）。存对象的话
       * 浮窗里显示的是**打开那一刻的快照**，而用户会以为那是现状——
       * 一个「在做」的卡做完之后，浮窗还写着「在做」。
       * 存 id 则每次渲染都从最新看板里取，浮窗跟着一起更新。
       */
      cardFloat: null,
      /**
       * 派单模型目录（`method:'models'` 的返回）：`null` = 没拉过；
       * `{ok:false, error}` = 拉不到（此时三个模型选择器**报错并禁用保存**，
       * 而不是静默退回手填——见 `dispatchModelRow`）。
       */
      modelCatalog: null,
      data: null,
      projects: null,
      /** 工作区绑定状态（`method:workspace` 的返回）：一级页要显示「文档放哪」。 */
      workspace: null,
      /** 派单看板（`method:board` 的返回）：五列分组 + 原始卡片。 */
      board: null,
      /**
       * **每个会话的实时活动状态**（v2.3.x，需求 ②/④）：
       * `null` = 没拉过；否则是 `{ [sessionId]: {status, phase, roundsStarted, maxGoalRounds, revision} }`。
       *
       * ## 为什么不能拿卡上已有的字段当判据
       *
       * 卡上确实有 `roundsStarted` / `goalRevision`，但它们是**派单那一刻**写下的快照
       * （`dispatchrun.js` 落完 `sessionId` 之后就不再更新）。拿它渲染「轮 3/10」
       * 会永远停在「轮 0/10」——**显示一个假事实比不显示更糟**。
       *
       * 所以实时值一律由宿主现读（`method:'live'` 读 `agents.get(id).status` 与
       * `goals.get(agent)`），客户端只负责显示。
       */
      live: null,
      /**
       * **上一轮各卡在哪一列**（v2.3.x，需求 ③）：`{ [cardId]: column }`。
       *
       * ## 为什么必须有它
       *
       * v2.2.9 起「执行完成 → 搬卡」是**宿主自动**做的（`completion.js` 听
       * `goal/changed`），面板只是 8 秒轮询时才发现。若每轮都拿「卡在已做 / 失败」
       * 去弹消息，同一件事就会**每 8 秒弹一次**。
       *
       * 所以只在**真的换了列**、且是从「在做」换出去时弹一次。
       * `null` = 还没有基线（第一轮只记录、不弹）——否则一打开面板就会把
       * 历史上所有搬动当成刚刚发生的事报一遍。
       */
      cardColumns: null,
      /**
       * 新建任务单表单：`null` = 没在新建；否则是
       * `{request, title, objective, description, busy, missing, error}`。
       */
      newTask: null,
      /**
       * 分解请求的自增序号。
       *
       * **连点两次「一键分解」时第二次作废第一次**：否则慢的那次回来会覆盖
       * 用户已经改过的三个框（U4 明确要求「连点安全」）。序号对不上就整份丢弃。
       */
      decomposeSeq: 0,
      /** 创建任务单 / 搬卡是否在途（按钮显示忙碌态并禁用，防连点）。 */
      taskBusy: false,
      /**
       * 「呼出全局大脑」是否在途（v2.2.0）。
       *
       * 与 `buildBusy` / `taskBusy` 同一条理由：它**真的会起会话**
       * （第一次点就是建会话 + 注入人设 + 投首轮消息，几秒）。
       * 不禁的话连点三下，前两下的回包会被后一下覆盖，而磁盘上已经多了一个会话。
       */
      brainBusy: false,
      /** 窄屏形态（`<900px`）：看板切单列 + 列标签切换，**不拖拽**（U4 Q8）。 */
      narrow: false,
      /** 窄屏下当前显示哪一列。 */
      boardCol: 'unclarified',
      /**
       * 正在被拖的那张卡的 id（宽屏拖拽用）。
       *
       * 为什么除了 `dataTransfer` 还要存一份：老 WebView / 某些浏览器在
       * `dragstart` 里设了 `dataTransfer` 而 `drop` 里读不到（安全策略），
       * 那时只能靠这个兜底。**取消拖拽时必须清掉**（`onDragEnd`），
       * 否则下一次 drop 会搬错卡。
       */
      dragId: null,
      /**
       * **板上那张源卡正被隐藏的是谁**（v2.4.7）。
       *
       * ## 为什么不能用 `dragId` 当判据（v2.4.6 就是这么坏掉的）
       *
       * `dragId` 在 `drop` 里**立刻**被清（拖拽结束了），可那时搬卡请求还在路上、
       * 手上那张也还没落位。若隐藏判据挂在 `dragId` 上，松手瞬间源卡就**现出来**，
       * 于是看到「卡先在旧列闪一下、然后才跳到新列」。
       *
       * 所以「谁被隐藏」是**独立于拖拽生命周期**的一件事，由它自己的字段说：
       * 设于 `dragstart` 之后（延迟，见下），清于**搬卡有结论之后**
       * （成功 / 被拒 / 没拿到卡 id / Esc 取消）。
       */
      hiddenCardId: null,
      /** 当前拖到哪一列上（用来高亮落点；`null` = 没在拖）。 */
      dragOver: null,
      /**
       * 拖起来那一刻**按下点**的屏幕坐标（v2.4.4）。
       *
       * ⚠️ v2.4.5 起它**只用来判「这次拖拽是真的从板上起的」**，不再用来算弹回位移：
       * 手上那张卡的跟手位置改由 `ghostGrabAt`（抓取点在卡上的相对位置）算，
       * 而弹回是让它 `translate(0,0)` —— 终点就是出发处，不需要位移。
       * 留着它是因为 `bounceOf` 那条「没有按下点就不编假动画」的判据还依赖它。
       */
      dragFrom: null,
      /**
       * 刚搬过列的那张卡（用来播一次**跨列飞行**；`null` = 没有）。
       *
       * 由 `moveCard` 的回包设上，飞行放完由 `travelCard` 清掉。
       *
       * ## v2.4.17：从「淡入 + 缩放」升级成「真的从旧列飞到新列」
       *
       * 原先只挂一个 `dshpz-cardfly`（透明度 .35 → 1、缩放 .94 → 1）。那是
       * **入场**的语言，回答的是「有个新东西出现了」；而用户真正想知道的是
       * 「刚才那张卡去哪了」——**同一个对象**换了位置。入场动画恰恰把这个
       * 说反了：它看起来像另一张卡凭空出现在新列。
       *
       * 所以现在改成 FLIP 的变体：搬卡前量下旧位置（`flyFrom`），渲染后在
       * 新列里量新位置，把差值反着压成 `transform`，再放归零。观众看到的是
       * **同一张卡横跨两列**——这正是「拼图块嵌进下一个槽」的母题。
       */
      flyId: null,
      /**
       * 跨列飞行的**起点矩形**（视口坐标；`null` = 没量到，退化成淡入）。
       *
       * 为什么在搬卡**之前**量：`moveCard` 一发请求，宿主回包后卡片就被渲染到
       * 新列里了——那时旧位置已经不存在，`getBoundingClientRect()` 只能量到新列。
       * 所以起点必须在发请求那一刻取。
       *
       * ⚠️ 量不到（老 WebView / 卡不在视口 / 测试桩）时**保持 `null`**，
       * 由 CSS 的 `dshpz-cardfly` 兜底成一次淡入——**宁可弱一点，也不编一个
       * 假的起点**：拿视口中心当起点会让卡从屏幕中间飞出来，比不做动画更糟。
       */
      flyFrom: null,
      /**
       * ## 主视图切换的方向（v2.4.17）
       *
       * `1` = 前进（往右推走旧页，新页从右侧进）；`-1` = 后退；`0` = 不播。
       *
       * ## 为什么方向要**显式传**，不能由目标页推出来
       *
       * 「主题」和「更新」在导航栏上是并列的两格，从「项目」去它们都是前进；
       * 但从「主题」回「项目」是后退，从「主题」去「更新」又是前进。
       * 只看「从哪到哪」不够——**同一个目标页可以是前进也可以是后退**。
       * 所以方向是**这次导航的意图**，由发起处给出，不由目标推。
       *
       * `0` 是有意义的取值：第一次挂载、数据刷新引起的重渲染都不该播转场。
       */
      navDir: 0,
      /**
       * 导航序号（v2.4.17）：每导航一次 +1，用作页面容器的 `key`。
       *
       * ## 为什么非得重挂
       *
       * CSS 动画只在**元素被创建**或**动画名改变**时重新播放。而两次导航
       * 可能用同一个方向（项目 → 主题 → 更新都是前进），类名不变、元素也
       * 被 React 复用 —— 于是第二次导航**一点动画都没有**。
       *
       * 用序号当 `key`，每次导航都是一个新的页面实例：动画必然重播。
       * 这也符合语义：每次导航本来就是「一张新页面」。
       */
      navSeq: 0,
      /**
       * 刚落进哪一列（v2.4.17）：`null` = 没有；否则是列键。
       *
       * 用来给**接收卡的那一列**播一次落定脉冲。为什么是列而不是卡：
       * 卡自己的飞行已经说明了「它去哪」，列再脉冲一下是把「这个槽接住了它」
       * 说出来——两块拼图合上的那一下。只播一次（由 `onAnimationEnd` 清），
       * 绝不 infinite（看板上五列一起闪会非常吵）。
       */
      landedCol: null,
      /** 新建项目表单是否展开（一级页右上角「＋ 新建项目」）。 */
      newOpen: false,
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
       * **哪些条目小节被展开了**（v2.1.8）：`null` = 全默认（都折叠）；
       * 否则是一个 `{ [小节名]: true }` 的映射。
       *
       * ## 为什么默认折叠
       *
       * 用户要求「给条目加一个默认折叠的功能」。一个模块的条目可以有五组
       * （要点 / 悬而未决 / 已定 / 可复用 / 详细记录），30 条铺开时右栏要滚很久，
       * 而多数时候只想看「哪一组有几条、有没有超字的」。
       *
       * ## 为什么用**名字**而不是序号当键
       *
       * 条目是按小节名分组的，组名稳定；
       * 用下标的话，某组因为「没有条目就整组不渲染」而消失时，下标会整体前移，
       * 展开态就会跳到**另一组**上去。
       *
       * ## 为什么不放进 `detail` 里
       *
       * 展开态是**界面状态**，不是文档数据。`detail` 每次取数都会整体换掉，
       * 放进去会被下一次 `method:'module'` 覆盖成折叠——用户正读着就被收起来。
       */
      entryOpen: null,
      /** 审查结果字段已随「审查 / 真实值」按钮与真实值显示区一起删除（v0.23.0）。 */
      loading: false,
      /**
       * **这一屏出了问题**——取数失败，或某个动作被拒。
       *
       * ## 它到底该不该「换页」，判据不是它自己（v2.4.8 修的真 bug）
       *
       * 原先 `panelBody` 一见它非空就**整页换成错误骨架**。于是用户拖到不该去的列
       * 被拒时，整个看板被抽走、换成「右栏数据未取到。点右上角 ⟳ 重试」——
       * 而**那句话是假的**：数据明明取到了，只是这一次拖动不行。
       *
       * 根因是把两种严重程度完全不同的事塞进了一个字段、共用了一种渲染：
       *   - **取数失败**：这一屏**没有内容可显示** → 换成骨架是**对的**；
       *   - **动作被拒**：内容都在，只是刚才那一步没成 → 只该**原地一行字**。
       *
       * 所以判据落在**「有没有内容」**上（见 `panelBody` 里那个 `data === null`），
       * 而不是落在「谁写的」上——写它的人有三十来处，判据只有一处，
       * 这才是不会随新增动作而漂移的写法。
       */
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
       * 「更新」页是否打开（v1.0.0）。与 `themeOpen` **互斥**：两者都是「面板主视图」，
       * 同时为真会让 `Panel` 不知道该渲染哪个（它是三选一）。
       */
      updateOpen: false,
      /** 更新页的即时反馈 / 错误 / 忙碌态，与主题页那三个分开（两页各自独立）。 */
      updateBusy: false,
      updateNotice: null,
      updateError: null,
      updateHint: '',
      updateTried: null,
      /** 上传/导出时的步骤回显（每一步的成败都显示，不写死一句笼统的话）。 */
      publishSteps: null,
      publishStderr: '',
      /** 开发区那个主题 id 输入框的内容。 */
      devId: '',
      /** 重名导入时待确认的 id（不为空 → 面板问「要替换吗」）。 */
      themeConfirmOverwrite: null,
      /** 上传/重算失败时的补充说明（宿主给的问题清单）。 */
      themeHint: '',
      /** 导出到工作区的主题包文件名清单。 */
      packs: [],
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
      /**
       * 主题仓库的检出状态（v1.0.0）：`{repo:{found,path,branch,remote,dirty,changes},repoIds,packs}`。
       * 打开主题页时拉一次（本地 git 命令，不联网），用于「开发主题 / 上传」两个入口。
       */
      themeRepo: null,
      /** 主题包导入的文本框内容（用户粘贴单文件主题包）。 */
      themePackText: '',
      /** 导出出来的主题包文本（面板显示「复制到剪贴板」用）。 */
      themePackOut: null,
      /**
       * 更新检查结果（v1.0.0）：`{ok,current,latest,state,hasUpdate,notes,install,…}`。
       * `null` = 还没查过；`{checking:true}` = 正在查。
       */
      update: null,
      /** 更新暂存区里的东西（下完之后 `{staged:[…],profile,lastRun,backups}`）。 */
      updateStaged: null,
      /**
       * 各版本的更新日志（v1.0.1）：`null` = 没拉过；`{loading:true}` = 正在拉；
       * 否则是 `method:'update', action:'releases'` 的返回（每版带 `summary` 数组）。
       */
      releases: null,
      /** 最近一次安装的结论（成功 / 失败 / 已回退），面板顶部据此说话。 */
      updateRun: null,
      /** 安装器是否正在跑（轮询中）。 */
      updateInstalling: false,
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

    /**
     * 写状态。**一处收口**，顺便把派生的两个布尔与 `view` 双向同步好。
     *
     * ## 为什么在这里同步 `themeOpen` / `updateOpen`
     *
     * v2.0.0 把「主视图」收敛成 `view` 枚举（见 `state.view` 的注释），
     * 但主题页 / 更新页内部还有大量代码在读那两个布尔。与其改几十处调用点
     * （纯风险、零功能收益），不如**在唯一的写入口把它们从 `view` 推出来**：
     * 于是「枚举是真相、布尔是派生」，两者不可能再互相矛盾。
     *
     * ## 为什么还要**反向**推（v2.0.0 修的真 bug）
     *
     * 只做单向（`view` → 布尔）时，「传 `themeOpen: false`」是一个**静默失效**的写法：
     * 布尔被赋了 false，`view` 却还是 `'theme'`，而渲染按 `view` 分支走——
     * 表现是**点了「返回」界面不动**，且不报错。
     * 实测就踩到了（主题页 / 更新页的「← 返回」都这么写）。
     *
     * 修法是让这一对字段**互为派生**：只要 `patch` 里出现了其中任何一个，
     * 另一个就被推成一致的值。于是「传哪个都行」——而这正是调用方会做的事。
     *
     * ⚠️ 调用方**优先传 `view`**（它是枚举，语义更清楚）；传布尔也能工作，
     * 但那是兼容路径，新代码不要再学。
     */
    function setState(patch) {
      var next = Object.assign({}, state, patch)
      if (patch !== null && patch !== undefined) {
        var hasView = Object.prototype.hasOwnProperty.call(patch, 'view')
        var hasTheme = Object.prototype.hasOwnProperty.call(patch, 'themeOpen')
        var hasUpdate = Object.prototype.hasOwnProperty.call(patch, 'updateOpen')
        if (hasView) {
          next.themeOpen = patch.view === 'theme'
          next.updateOpen = patch.view === 'update'
        } else if (hasTheme || hasUpdate) {
          // 反向：从布尔推 `view`。两个都传时**关闭优先**——「退出某个视图」
          // 比「进入某个视图」更该赢，否则会造出「点了返回却进了另一个视图」。
          var themeOn = hasTheme ? patch.themeOpen === true : next.themeOpen === true
          var updateOn = hasUpdate ? patch.updateOpen === true : next.updateOpen === true
          if (hasTheme && patch.themeOpen === false) {
            next.updateOpen = false
            next.view = 'projects'
          } else if (hasUpdate && patch.updateOpen === false) {
            next.themeOpen = false
            next.view = 'projects'
          } else if (themeOn) {
            next.updateOpen = false
            next.view = 'theme'
          } else if (updateOn) {
            next.themeOpen = false
            next.view = 'update'
          }
        }
      }
      state = next
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

    /**
     * 取数：`state`。
     *
     * ⚠️ **v2.0.0 起 `sessionId` 不再是必需参数**（U3：面板是全局的）。
     * 原先「没有会话 ID 就报错」会把**完全合法的用法**（不打开任何会话、
     * 直接点侧边栏看项目列表）挡在门外。现在它只在「有就带上」时才进请求体——
     * 宿主侧需要它的只有 `settings`（按会话禁用）那一条通道。
     */
    function load(sessionId, project) {
      setState({ loading: true })
      var body = { method: 'state' }
      if (sessionId !== undefined && sessionId !== null && sessionId !== '') body.sessionId = String(sessionId)
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

    /**
     * 取数：一级页要的**项目列表**（工作区里全部项目 + 当前打开的那个 + 工作区绑定）。
     *
     * 与 `load` 分开的理由：`state` 要解析当前项目的整份文档树（模块、健康性、审查），
     * 而一级页只列一行行项目名与健康性。**停在列表页时不该为每个项目付一次全量解析**。
     */
    function loadProjects(sessionId) {
      var body = { method: 'list' }
      if (sessionId !== undefined && sessionId !== null && sessionId !== '') body.sessionId = String(sessionId)
      post(body)
        .then(function (json) {
          if (json && json.ok === true) setState({ projects: json.result })
        })
        .catch(function () {
          /* 列表失败不覆盖主状态 */
        })
    }

    /**
     * 取数：**工作区绑定状态**（一级页的「数据工作区」区与「派单设置」区都要它）。
     *
     * 走 `method:workspace`（不给 path = 只查询）。它与项目无关，
     * 所以在**还没绑工作区**的空态下也要能拉到——那正是最需要显示这个控件的时刻。
     *
     * ⚠️ **`ok` 必须在 `result` 里**（这里修过一个真 bug）：RPC 的外层形状是
     * `{ ok, result }`，而面板各处判的是 `workspace.ok`（**内层**）。
     * 只存 `json.result` 的话，内层永远没有 `ok` 字段，于是
     * `bound = workspace.ok === true && workspace.bound === true` **恒为假**——
     * 一级页会一直显示「还没绑定数据工作区」，哪怕宿主明明绑好了。
     * 这种 bug 不报错、只是显示错，靠肉眼很难发现；所以这里显式补上 `ok: true`。
     */
    function loadWorkspace() {
      post({ method: 'workspace' })
        .then(function (json) {
          if (json && json.ok === true) {
            setState({ workspace: Object.assign({ ok: true }, json.result) })
          } else {
            setState({ workspace: { ok: false, error: (json && json.error) || '工作区状态读取失败' } })
          }
        })
        .catch(function () {
          setState({ workspace: { ok: false, error: '无法连接 ' + RPC } })
        })
    }

    /** 绑 / 换**数据工作区**（U3 追加拍板 ②）。传空串 = 解绑。 */
    function bindWorkspace(path, workspaceId) {
      setState({ loading: true, error: null })
      var body = { method: 'workspace', path: String(path || '') }
      if (workspaceId !== undefined && workspaceId !== null && workspaceId !== '') body.workspaceId = String(workspaceId)
      post(body)
        .then(function (json) {
          if (json && json.ok === true) {
            /**
             * ⚠️ **`ok: true` 必须补上**（v2.1.1 修的真 bug：换工作区后项目区不更新）。
             *
             * 外层 RPC 形状是 `{ok, result}`，而面板各处判的是**内层**
             * `workspace.ok === true && workspace.bound === true`。这里原先把
             * `json.result` 原样存进去，内层没有 `ok` → `bound` 恒为假 →
             * 刚绑完工作区，项目区却退回「先绑定一个工作区」的空态，
             * 看着就像「换了工作区这里没更新」。`loadWorkspace` 一直是
             * `Object.assign({ok:true}, …)`，只有这条写路径漏了。
             */
            setState({
              workspace: Object.assign({ ok: true }, json.result),
              loading: false,
              notice: json.result.bound === true
                ? '已绑定数据工作区：' + json.result.workspacePath + '（拼图文档与任务单都会写在这里）'
                : '已解绑数据工作区。',
            })
            loadProjects(state.sessionId)
          } else {
            setState({ error: (json && json.error) || '绑定工作区失败', loading: false })
          }
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
        })
    }

    /**
     * 切换**面板当前打开的项目**（U2 的「点一行进下一级」）。
     *
     * 成功后就地改本地状态（`view: 'project'` + `openProject`），
     * **不等 8 秒轮询**——点一下要立刻进得去，等一轮会让面板看起来是卡住的。
     * 宿主返回的真值随后由轮询校正。
     */
    function openProject(projectName) {
      /**
       * 进二级页 = **往右走**（v2.4.17）。
       *
       * 空间关系：一级是「一排项目」，点其中一行就**进到它里面**。在
       * 横向导航的语言里，进入下一层是往右推。这里与一级内三页共用同一个
       * 方向记号（`navDir`），所以从「主题」页点项目也是同一个方向——
       * 因为对用户来说那都是「往里走一步」。
       */
      setState({
        view: 'project',
        tab: state.tab || 'info',
        error: null,
        detail: null,
        detailName: null,
        navDir: 1,
        navSeq: (state.navSeq || 0) + 1,
      })
      post({ method: 'current', project: String(projectName) })
        .then(function (json) {
          if (json && json.ok === true) {
            setState({ data: mergePanelData(json.result), error: null })
            load(state.sessionId, projectName)
            loadMain(state.sessionId, projectName)
          } else {
            setState({ error: (json && json.error) || '打开项目失败' })
          }
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC })
        })
    }

    /**
     * 回到一级**项目列表**（不改「当前打开的项目」，只是退出二级视图）。
     *
     * v2.4.17：这是**往左走**（后退）。方向必须在这里给——它是「返回」的
     * 语义，而 `switchToView` 算不出来（那个函数管的是三页之间的左右关系）。
     */
    function backToProjects() {
      setState({
        view: 'projects',
        error: null,
        detail: null,
        detailName: null,
        notice: null,
        navDir: -1,
        navSeq: (state.navSeq || 0) + 1,
      })
      loadWorkspace()
      loadProjects(state.sessionId)
    }

    /* ------------------------------ 派单系统（U4 子页二） ------------------------------ */

    /**
     * 拉整块看板（五列分组 + 原始卡片）。
     *
     * 为什么不并进 8 秒轮询的 `state`：它要扫 `拼图/<项目名>/派单/` 目录（一卡一次读盘 + 解析），
     * 而用户多数时候停在「文档信息」子页、根本不看它。按需拉：切到派单子页拉一次，
     * 搬卡 / 建卡后再拉一次。
     */
    function loadBoard() {
      post({ method: 'board' })
        .then(function (json) {
          if (json && json.ok === true) {
            /**
             * ⚠️ **先算差异、再落状态**（需求 ③）：`columnChangeOf` 要读
             * **上一轮**的 `state.cardColumns` 与本轮的列，所以它必须在
             * `setState` 之前调用——放到后面读到的就已经是本轮的基线，差异恒为空。
             *
             * 它与 `board` 合成**一次** `setState`：分两次写会多渲染一遍
             * （看板可能有几十张卡，而这是每 8 秒一次的路径）。
             */
            var change = columnChangeOf(json.result, state.cardColumns)
            var patch = { board: json.result, cardColumns: change.columns }
            if (change.notice !== null) patch.notice = change.notice
            setState(patch)
            /**
             * 立刻按**新**看板查一次实时状态：不这样的话「执行中」要等下一个
             * 8 秒轮询才出现（刚切进派单页时 `state.board` 还是 `null`，
             * `pollLive` 那一轮没有 id 可查）。
             */
            loadLive(doingSessionIdsOf(json.result).concat(brainSessionIds()))
          } else {
            setState({ board: { ok: false, error: (json && json.error) || '看板读取失败', cards: [] } })
          }
        })
        .catch(function () {
          setState({ board: { ok: false, error: '无法连接 ' + RPC, cards: [] } })
        })
    }

    /**
     * 把一份看板压成「卡 id → 列」的基线（`state.cardColumns` 的形状）。
     *
     * 手动动作（搬卡 / 派单 / 验收 / 冻结 / 删除）也会整体换掉 `state.board`。
     * 那时**必须同步更新基线**，否则下一轮轮询会拿新看板去比旧基线，
     * 把用户刚刚亲手做的那次搬动**再报一遍**——同一件事说两遍。
     */
    function columnsOf(board) {
      var cards = board !== null && board !== undefined && Array.isArray(board.cards) ? board.cards : []
      var next = {}
      for (var i = 0; i < cards.length; i += 1) {
        var card = cards[i]
        if (card === null || card === undefined || typeof card.id !== 'string') continue
        next[card.id] = card.column
      }
      return next
    }

    /**
     * **手动动作换看板时要带的补丁**：`{board, cardColumns}`。
     *
     * 为什么不能只写 `{board}`：`cardColumns` 是「上一轮各卡在哪一列」的基线，
     * 而差异检测（`columnChangeOf`）靠它判断「有没有真的换列」。手动搬完卡
     * 若不同步基线，**下一轮轮询会把用户刚刚亲手做的那次搬动再报一遍**
     * ——同一件事说两遍（`moveCard` 自己已经弹过 `notice` 了）。
     *
     * 收成一个函数而不是在七处各写一遍 `columnsOf(...)`：那些调用点形状相同
     * （都是「宿主回了 `result.board`」），少写一处就是一条安静的重复提示。
     */
    function boardPatch(board) {
      return { board: board, cardColumns: columnsOf(board) }
    }

    /**
     * **列变化的差异检测**（v2.3.x，需求 ③）：只在卡**真的从「在做」换出去**时给一条消息。
     *
     * ## 为什么不能「看到已做/失败就弹」
     *
     * 搬列是宿主自动做的（`completion.js` 听 `goal/changed`），面板靠 8 秒轮询才发现。
     * 按「卡在已做」判就会**每 8 秒弹一次**同一条——用户会以为 AI 一直在完成同一件事。
     * 判据必须是**变化**，不是**状态**。
     *
     * ## 为什么只报「在做 → 已做/失败」
     *
     * 那正是用户看不到的那一次（AI 在后台跑完了）。手动搬卡（`moveCard`）自己已经
     * 弹了 `notice`，这里再报一次就是同一动作说两遍。所以只有**从在做出去**
     * 才算「你没看见的那次」，其余列变化只更新基线、不出声。
     *
     * ## 第一轮只建基线
     *
     * `previous` 为 `null`（还没基线）时直接记录、不出声——否则打开面板的第一屏
     * 会把历史上所有已完成的卡都当成「刚刚完成」报一遍。
     *
     * ## 为什么是**纯函数**（`previous` 由调用方传，而不是自己读 `state`）
     *
     * 与 `moveVerdict` / `freezeCard` 同一条纪律：判据写成纯函数才能被直接驱动，
     * 测试不必「手写一份 state 再喂进去」——那种自证式测试本仓明确不信任
     * （它只能证明「我写的期望等于我写的实现」）。
     *
     * @param board 宿主回的看板
     * @param previous 上一轮的基线（`{cardId: column}`），`null` = 还没有
     * @returns `{columns, notice}`：新的基线（**无条件**要落进 state），
     *   以及该显示的 `notice`（`null` = 不弹）。
     */
    function columnChangeOf(board, previous) {
      var cards = board !== null && board !== undefined && Array.isArray(board.cards) ? board.cards : []
      var next = columnsOf(board)
      var messages = []
      for (var i = 0; i < cards.length; i += 1) {
        var card = cards[i]
        if (card === null || card === undefined || typeof card.id !== 'string') continue
        if (previous === null || previous === undefined) continue
        var before = previous[card.id]
        if (before !== 'doing') continue
        if (card.column === before) continue
        messages.push(columnChangeText(card))
      }
      return { columns: next, notice: messages.length === 0 ? null : messages.join('；') }
    }

    /**
     * 一条列变化的说法。**按落点分开写**，因为「做完了」与「失败了」
     * 对用户是两件完全不同的事（一个去验收，一个去看原因并重做）。
     */
    function columnChangeText(card) {
      var title = String(card.title || card.id || '（无标题）')
      if (card.column === 'done') return '「' + title + '」执行完成，已自动落到「已做」——记得点「验收」'
      if (card.column === 'failed') {
        var failure = card.failure !== null && card.failure !== undefined && typeof card.failure.code === 'string'
          ? card.failure.code
          : ''
        return '「' + title + '」执行失败，已自动落到「失败」' + (failure === '' ? '' : '（' + failure + '）') + '——卡上可以点「← 重做」'
      }
      return '「' + title + '」已从「在做」移到「' + String(card.column) + '」'
    }

    /**
     * **拉每个会话的实时状态**（v2.3.x，需求 ②/④）：`method:'live'`。
     *
     * ## 为什么要单独一条 RPC、且不进 8 秒轮询
     *
     * 它读的是**进程内**的 `agents` / `goals`（不读盘、不联网），但它是
     * 「谁现在在跑」这件事——而面板只在**看着看板或大脑浮窗**时才需要它。
     * 所以由那两处的轮询/渲染自己调（见 `dispatchBoard` 与 `buildFloatLayer`），
     * 不塞进 `state` 那条每 8 秒都跑的路径。
     *
     * ## 为什么失败时静默
     *
     * 它是**装饰性信息**（「在跑」那行字）。拉不到最多是不显示，
     * 不该在看板上弹一条红字——那会把一条旁路的失败升级成主功能的失败。
     */
    function loadLive(ids) {
      var list = Array.isArray(ids) ? ids.filter(function (one) { return typeof one === 'string' && one !== '' }) : []
      if (list.length === 0) {
        // 没有要查的会话 → 清空，免得显示上一轮那些已经不在的 id。
        if (state.live !== null) setState({ live: null })
        return
      }
      post({ method: 'live', ids: list })
        .then(function (json) {
          if (json && json.ok === true && json.result !== null && json.result !== undefined) {
            setState({ live: json.result.sessions || {} })
          }
        })
        .catch(function () {
          /* 静默：见上面那条 */
        })
    }

    /** 某个会话的实时状态；没拉过 / 没这个 id 一律回 `null`（= 不知道，**不猜**）。 */
    function liveOfIn(view, sessionId) {      var map = view !== null && view !== undefined && view.state !== null && view.state !== undefined
        ? view.state.live
        : null
      if (map === null || map === undefined) return null
      if (typeof sessionId !== 'string' || sessionId === '') return null
      var one = map[sessionId]
      return one === null || one === undefined ? null : one
    }

    /**
     * 「在做」列那些卡的执行会话 id（需求 ② 的取数口）。
     *
     * 传 `board` 而不是读 `state.board`：`loadBoard` 里要在 `setState` **之前**
     * 用刚拿到的这一份，那时 `state.board` 还是上一轮的。
     */
    function doingSessionIdsOf(board) {
      var cards = board !== null && board !== undefined && Array.isArray(board.cards) ? board.cards : []
      var ids = []
      for (var i = 0; i < cards.length; i += 1) {
        var card = cards[i]
        if (card === null || card === undefined || card.column !== 'doing') continue
        if (typeof card.sessionId === 'string' && card.sessionId !== '') ids.push(card.sessionId)
      }
      return ids
    }

    /**
     * 浮窗里那个**全局大脑**的会话 id（需求 ④ 的取数口）；不是大脑浮窗时回空数组。
     *
     * 为什么只认 `kind === 'brain'`：需求 ④ 说的是全局大脑。澄清器浮窗是
     * **用户正在里面打字**的会话，它的活动状态用户自己看得见，不必再报一遍。
     */
    function brainSessionIds() {
      var build = state.build
      if (build === null || build === undefined || build.kind !== 'brain') return []
      return typeof build.sessionId === 'string' && build.sessionId !== '' ? [build.sessionId] : []
    }

    /**
     * **这一轮要查实时状态的那些会话**（需求 ② + ④）——两处的并集。
     *
     * 为什么不查其它列的会话：别的列没有在跑的活（已做 / 失败的已经结束，
     * 未澄清 / 未接单的还没起会话）。多查只是白花一次进程内查询。
     *
     * 看板只在**停在派单子页**时才读 `state.board`：切到文档信息子页后
     * 那一份可能已经过期，而拿过期看板去查状态只会查到一堆无关会话。
     */
    function liveIdsToPoll() {
      var doing = state.tab === 'dispatch' ? doingSessionIdsOf(state.board) : []
      return doing.concat(brainSessionIds())
    }

    /** 拉一次实时状态。**没有要查的会话时是空操作**（见 `loadLive` 的第一条分支）。 */
    function pollLive() {
      loadLive(liveIdsToPoll())
    }

    /**
     * 新建任务单（**不自动开澄清器**，U4 拍板）。
     *
     * 为什么新建不自动提问：新建页刚让用户写了一大段需求，**立刻弹一轮提问会打断他**
     * ——他可能还要连建几张卡。所以新建只做「落一张卡」，澄清由用户主动发起。
     */
    function createTask(view) {
      var form = view.state.newTask || {}
      var title = String(form.title || '').trim()
      if (title === '') {
        setState({ error: '标题是空的——点「一键分解」让它从需求里提炼，或自己写一句' })
        return
      }
      setState({ taskBusy: true, error: null })
      post({
        method: 'task',
        action: 'create',
        title: title,
        objective: String(form.objective || ''),
        description: String(form.description || ''),
        request: String(form.request || ''),
      })
        .then(function (json) {
          if (json && json.ok === true) {
            setState({
              taskBusy: false,
              newTask: null,
              ...boardPatch(json.result.board),
              notice: '已创建任务单「' + title + '」，落在**未澄清**列。想澄清时点卡上的「开始澄清」。',
            })
          } else {
            setState({ taskBusy: false, error: (json && json.error) || '创建任务单失败' })
          }
        })
        .catch(function () {
          setState({ taskBusy: false, error: '无法连接 ' + RPC })
        })
    }

    /**
     * **一键分解**：宿主侧直调模型，返回标题 / 目标 / 描述三个字段。
     *
     * ## 两条必须写对的容错
     *
     * 1. **连点两次**：第二次**作废第一次**——否则慢的那次回来会覆盖用户已经改过的框。
     *    实现方式是给每次请求一个自增序号，回来时对不上就整份丢弃。
     * 2. **失败 / 超时**：需求原文**不丢**（`newTask.request` 保持原样），用户可以直接重试。
     */
    function decomposeTask(view) {
      var form = view.state.newTask || {}
      var request = String(form.request || '').trim()
      if (request === '') {
        setState({ error: '先写一段需求再点「一键分解」' })
        return
      }
      var seq = (state.decomposeSeq || 0) + 1
      setState({
        decomposeSeq: seq,
        newTask: Object.assign({}, form, { busy: true, error: null }),
        error: null,
      })
      post({ method: 'decompose', request: request })
        .then(function (json) {
          // 作废检查：只有**最后一次**的结果生效。
          if (state.decomposeSeq !== seq) return
          var current = state.newTask || {}
          if (json && json.ok === true) {
            setState({
              newTask: Object.assign({}, current, {
                title: json.result.title || '',
                objective: json.result.objective || '',
                description: json.result.description || '',
                busy: false,
                missing: json.result.missing || [],
              }),
              notice: json.hint || '分解完成，三个框都可以改。',
            })
          } else {
            setState({
              // 需求原文**保持原样**：失败时不能把用户写的东西弄丢。
              newTask: Object.assign({}, current, { busy: false, error: (json && json.error) || '分解失败' }),
              error: (json && json.error) || '分解失败',
            })
          }
        })
        .catch(function () {
          if (state.decomposeSeq !== seq) return
          var current = state.newTask || {}
          setState({
            newTask: Object.assign({}, current, { busy: false, error: '无法连接 ' + RPC }),
            error: '无法连接 ' + RPC,
          })
        })
    }

    /**
     * 搬卡。**宽屏拖拽与窄屏按钮都走这一条**（U4 硬要求：两条路径合流）。
     *
     * 规则（能不能移、移了算什么）全在宿主侧的 `moveVerdict` 里，
     * 面板**不自己判**——自己判就会长出第二套语义。
     */
    function moveCard(view, cardId, to, event) {
      /**
       * ## 飞行起点：**必须在发请求之前量**（v2.4.17）
       *
       * 回包一到，这张卡就已经被渲染到新列里了，那时 `getBoundingClientRect()`
       * 量到的只能是**新位置**——「从哪来」这个信息已经不存在了。
       *
       * 所以起点在**此刻**（用户刚松手 / 刚点按钮）取。取不到就留 `null`，
       * 由 CSS 的 `dshpz-cardfly` 兜底成淡入（**不编假起点**，见 `flyFrom` 注释）。
       *
       * ⚠️ 只查**视口内**的卡：卡片可能在列里被滚出可视区（列自己会滚动）。
       * 那种情况下起点在屏幕外，飞行会从看不见的地方飞进来——
       * 那不是「它从哪来」，那是「有个东西从天而降」。宁可退化成淡入。
       */
      var flyFrom = null
      if (!motionOn() && typeof document !== 'undefined' && document !== null
        && typeof document.querySelector === 'function') {
        try {
          var nodes = document.querySelectorAll('.dshpz-card[data-card-id]')
          for (var n = 0; n < nodes.length; n += 1) {
            if (String(nodes[n].getAttribute('data-card-id')) !== String(cardId)) continue
            var box = typeof nodes[n].getBoundingClientRect === 'function' ? nodes[n].getBoundingClientRect() : null
            if (box === null || !isFinite(box.left) || !isFinite(box.top)) break
            /**
             * 视口判定：完全在视口外就不飞。
             * 用「有交集」而不是「完全可见」——露出半张卡时从半空飞过去仍然讲得通。
             */
            var vw = window.innerWidth || 0
            var vh = window.innerHeight || 0
            if (box.right < 0 || box.bottom < 0 || box.left > vw || box.top > vh) break
            flyFrom = { left: box.left, top: box.top, width: box.width, height: box.height }
            break
          }
        } catch (_error) {
          /* 量不到就退化成淡入，不是错误 */
        }
      }
      /**
       * ## 被拒时：**手上那张卡飞回原处**（v2.4.5）
       *
       * 用户原话（v2.4.4）：「不能拖到某列的反馈改为拖过去后弹回」。
       *
       * 原先被拒时只设一句 `error`（面板顶部那行红字）。问题不是那句话不对，
       * 而是**它和用户的手势不在同一个地方**：手在列上松开了，反馈却在屏幕另一头，
       * 用户的直觉是「卡怎么没动」——他会再拖一次。
       *
       * ⚠️ v2.4.5 起弹的是**手上那张**（`dshpz-cardghost`），不是板上那张：
       * 板上那张从没离开过，让它抖一下与用户手上的动作无关，看着像另一个东西在动。
       * 手上那张沿原路飞回去，才是「我把它放回去了」。
       *
       * 顶部那行 `error` 照旧——弹回说「不行」，提示说「为什么」。
       */
      var back = function () {
        ghostBack()
        setState({ dragId: null, dragOver: null, dragFrom: null, hiddenCardId: null })
      }
      post({ method: 'task', action: 'move', id: String(cardId), to: String(to) })
        .then(function (json) {
          if (json && json.ok === true) {
            /**
             * 记下刚搬的那张卡 → 渲染时让 `travelCard` 把它从旧位置飞过去。
             *
             * ⚠️ **同列换排不该播飞行**：那会让卡片原地闪一下，而它其实没动过列。
             * 判据是回包里的 `effect`（宿主侧的 `moveVerdict` 给的）——
             * 那是「这次移动到底算什么」的唯一真相来源，客户端不再自己判一遍。
             */
            var result = json.result !== null && json.result !== undefined ? json.result : {}
            var effect = result.effect
            var crossing = effect !== 'reorder'
            /**
             * 成功了 → 手上那张**直接消失**（它已经落到新列上了）。
             *
             * ⚠️ 必须在这里清：`onDragEnd` 也会兜底清一次，但那是**之后**才跑的，
             * 而这段时间里用户会看到「卡已经在目标列了，手上还飘着一张」——
             * 两张同时在屏幕上，正是要避免的重影。
             */
            ghostDrop()
            setState({
              ...boardPatch(result.board),
              error: null,
              notice: json.hint || result.label,
              flyId: crossing ? String(cardId) : null,
              flyFrom: crossing ? flyFrom : null,
              // 落定的那一列：只在真的换列时给，同列换排不庆祝。
              landedCol: crossing ? String(to) : null,
              dragId: null,
              dragOver: null,
              dragFrom: null,
              // 源卡要重新显出来——它已经在新列里了，隐形的话用户会以为卡丢了。
              hiddenCardId: null,
            })
            /**
             * ## 移到「未接单」= 自动开始澄清 → **当场弹澄清浮窗**（v2.4.4）
             *
             * 用户原话：「末澄清拖到未接单没有自动开始弹出澄清浮窗」。
             *
             * 宿主那条分支（`rpcTask` 的 `unclarified → pending`）已经起了澄清会话，
             * 但**会话起来了不等于用户看得见**——浮窗要由面板开。所以这里必须接上，
             * 否则用户看到的还是「拖过去了，什么都没发生」。
             *
             * 判据用宿主回的 `autoClarified`，**不在客户端猜「拖到未接单大概会起澄清」**：
             * 那条规则在宿主，客户端猜一次就长出第二套。
             *
             * 复用 `openSessionFloat('clarify', …)` 而不是另写一个开窗函数：
             * 与详情浮窗里那颗「开始澄清」按钮**走同一条路**，两个入口不会漂移。
             */
            if (result.autoClarified === true && typeof result.sessionId === 'string' && result.sessionId !== '') {
              openSessionFloat('clarify', result.sessionId, result)
            }
          } else {
            setState({ error: (json && json.error) || '搬卡失败', notice: null })
            back()
          }
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC })
          back()
        })
    }

    /**
     * **删除一张「已做」的任务单，连同它挂的两个会话**（v2.3.x，需求 ①）。
     *
     * ## 为什么二次确认在客户端、判据在宿主
     *
     * 这两件事**不重复**：二次确认问的是「你真的要删吗」（用户意图），
     * 判据答的是「这张卡能不能删」（数据规则）。前者只有界面知道，
     * 后者只有宿主知道——两边各管各的，谁都不替对方猜。
     *
     * ## 为什么确认框里要把两个会话 id 写出来
     *
     * 用户点的是「删卡」，但**实际后果包括删掉两个会话**。只说「删除任务单」
     * 会让他以为只是从看板上移走一行字——而这是不可恢复的。
     * 会话 id 一并列出，用户能自己核对「要删的是不是我以为的那个」。
     *
     * ## 失败时把宿主那句话原样显示
     *
     * 「只有已做能删」「会话还在跑」这类结论**只有宿主说得准**。
     * 客户端失败时只补一句「无法连接」（那是网络层的实话），其余照搬 `error` / `hint`。
     */
    function deleteCard(view, card) {
      var id = String(card.id)
      var sessions = [card.sessionId, card.clarifySessionId]
        .filter(function (one) { return typeof one === 'string' && one !== '' })
      var ok = window.confirm(
        '删除任务单「' + String(card.title || id) + '」？\n\n'
        + '⚠️ 这一步**不可恢复**，并且会**连同它的会话一起删掉**：\n'
        + (sessions.length === 0 ? '（这张卡没挂会话）' : sessions.map(function (one) { return '· ' + one }).join('\n'))
        + '\n\n这张卡的文件（`派单/<卡 id>.json`）会被删掉，会话会从侧边栏消失。',
      )
      if (ok !== true) return
      setState({ taskBusy: true, error: null })
      post({ method: 'task', action: 'delete', id: id })
        .then(function (json) {
          if (json && json.ok === true) {
            setState({
              taskBusy: false,
              ...boardPatch(json.result.board),
              error: null,
              notice: json.hint || ('已删除任务单「' + String(card.title || id) + '」。'),
            })
          } else {
            setState({
              taskBusy: false,
              error: (json && json.error) || '删除任务单失败',
              notice: json && json.hint ? String(json.hint) : null,
            })
          }
        })
        .catch(function () {
          setState({ taskBusy: false, error: '无法连接 ' + RPC })
        })
    }

    /** 人工点「验收」：消掉「未验收」标记（Q6）。**卡不因验收而移动**。 */
    function verifyCard(view, cardId) {      post({ method: 'task', action: 'verify', id: String(cardId) })
        .then(function (json) {
          if (json && json.ok === true) setState({ ...boardPatch(json.result.board), notice: '已验收。' })
          else setState({ error: (json && json.error) || '验收失败' })
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC })
        })
    }

    /**
     * **冻结方案**（v2.3.0）：把「未接单」的卡定稿（写 `frozenAt`，**不搬列**）。
     *
     * ## 为什么这个动作在客户端只是「发一个请求」
     *
     * 判据（目标 + 执行交代齐没齐、能不能冻结）全在宿主侧的 `freezeCard`。
     * 客户端**不自己预判**——预判就会长出第二套规则，而漂移的表现是
     * 「按钮能点，点了被拒」或反过来「明明能冻，按钮却是灰的」。
     * 所以失败时把宿主那句错话**原样显示**（含 hint），而不是自己编一句。
     *
     * `hint` 与 `error` **分开放**：`error` 说「哪里不对」，`hint` 说「怎么修」。
     * 合成一句话会让「还没写目标」和「去点一键分解」这两件事挤在一起。
     */
    function freezeCard(view, cardId) {
      setState({ taskBusy: true, error: null })
      post({ method: 'task', action: 'freeze', id: String(cardId) })
        .then(function (json) {
          if (json && json.ok === true) {
            setState({ taskBusy: false, ...boardPatch(json.result.board), notice: json.hint || '已冻结。' })
          } else {
            setState({
              taskBusy: false,
              error: (json && json.error) || '冻结失败',
              notice: json && json.hint ? json.hint : null,
            })
          }
        })
        .catch(function () {
          setState({ taskBusy: false, error: '无法连接 ' + RPC })
        })
    }

    /**
     * **停掉这张卡的执行会话**（v2.4.14，用户报的「执行会话人为停止不了」）。
     *
     * ## 为什么面板上原先没有这颗按钮
     *
     * v2.4.3 把执行会话的 ✕ 定成「只收起浮窗」（理由见 `buildFloatLayer` 那段：
     * 删会话会把正在做的活连同上下文丢掉）。那条理由本身没错，但它只回答了
     * 「✕ 该不该删」，**没有回答「那怎么停」**——于是面板上根本没有任何停止入口，
     * 用户只能眼睁睁看着它在跑。这颗按钮补的就是那个缺口。
     *
     * ## 为什么「停」不等于「删会话」，也不等于「搬卡」
     *
     * 三件事的后果完全不同：
     *   - **删会话**（✕ / 删除卡）：转录、上下文一并没了，不可恢复；
     *   - **搬卡**（拖到别的列）：只换列，会话与 goal 照旧；
     *   - **停**：打断当前那一轮（宿主走 `sessionController.cancel({sessionId})`），
     *     **待处理的消息队列不丢**（那是「停一下再继续」与「永远接不上」的分界）。
     *     这一步**不碰 goal、不搬卡**——会话与 goal 都留在原地。
     *
     * ## 判据在宿主，客户端只发一个请求
     *
     * 「会话还在不在、`sessionController` 有没有 `cancel`」全是**宿主进程里的事实**。
     * 客户端自己判就会长出第二套规则，而漂移的表现是「按钮能点，点了没反应」。
     * 所以这里照 `freezeCard` 的范式：只发请求，失败时把宿主那句错话**原样显示**（含 hint）。
     *
     * ## 停不下来必须如实报错
     *
     * 回包 `ok !== true` 时**只报错**，绝不写「已停」——把没做成说成做成了，
     * 用户会以为它停了而它还在烧钱。宿主那侧也照此纪律（见 `rpcTask` 的 `stop` 分支）。
     */
    function stopCardSession(view, cardId) {
      setState({ taskBusy: true, error: null })
      post({ method: 'task', action: 'stop', id: String(cardId) })
        .then(function (json) {
          if (json && json.ok === true) {
            setState({
              taskBusy: false,
              ...boardPatch(json.result.board),
              error: null,
              notice: json.hint || '已请求停掉这个执行会话。',
            })
            /**
             * 立刻按**新**状态查一次实时：不这样的话浮窗上那颗「运行中」要等
             * 下一个 8 秒轮询才消失，而用户会以为没停掉（与 `dispatchCard` 同理）。
             */
            pollLive()
          } else {
            setState({
              taskBusy: false,
              error: (json && json.error) || '停不掉这个执行会话',
              notice: json && json.hint ? String(json.hint) : null,
            })
          }
        })
        .catch(function () {
          setState({ taskBusy: false, error: '无法连接 ' + RPC })
        })
    }

    /**
     * **呼出全局大脑**（v2.2.0）：派单页左上角那颗按钮。
     *
     * ## 为什么走 RPC 而不是自己 retain 一个会话
     *
     * 「这个项目的大脑是哪个会话」是**宿主侧的事实**（记在全局设置里）。
     * 面板自己存一份的话，换个面板实例 / 刷新页面就丢了，
     * 于是每次点都新起一个会话——而用户要的正是「一个项目一个、复用」。
     *
     * ## 回包里的 `sessionId` 一定要 retain
     *
     * 与新建项目浮窗同一条：内嵌对话流渲染的是**那个会话本身**，
     * 宿主 `SessionProvider` 只认 `SessionReference`。`openSessionFloat` 干这件事。
     */
    function openBrain(view) {
      if (view.state.brainBusy === true) return
      setState({ brainBusy: true, error: null })
      post({ method: 'brain', sessionId: String(view.state.sessionId || '') })
        .then(function (json) {
          if (json && json.ok === true) {
            var result = json.result || {}
            setState({ brainBusy: false, notice: json.hint || '已呼出全局大脑。' })
            openSessionFloat('brain', result.sessionId, result)
            /**
             * 立刻查一次大脑的实时状态（需求 ④）：不这样的话浮窗头部那颗
             * 「运行中」要等下一个 8 秒轮询才出现，而刚呼出的大脑
             * **通常已经在跑了**（首轮消息就是这一步投进去的）。
             */
            pollLive()
          } else {
            setState({
              brainBusy: false,
              error: (json && json.error) || '呼出全局大脑失败',
              notice: json && json.hint ? json.hint : null,
            })
          }
        })
        .catch(function () {
          setState({ brainBusy: false, error: '无法连接 ' + RPC })
        })
    }

    /**
     * 呼出澄清器（v2.1.0；v2.2.0 起**在浮窗里问**）。
     *
     * ## 为什么现在开浮窗
     *
     * 用户拍板：「澄清时会呼出浮窗进行提问」。原先这个动作只是把会话建出来、
     * 显示一句「澄清会话已起」，用户还得自己去侧边栏找它——而澄清是
     * **一问一答**的，找不到会话这条功能就等于不存在。
     *
     * 这个动作**很慢**（要起大脑、fork、投消息），所以挂 `taskBusy` 把按钮禁掉，
     * 避免用户连点造出好几个澄清会话——而 `clarifyVerdict` 只能挡住
     * **已经落盘**的重复（第二次点击时第一张卡还没写盘）。
     */
    function clarifyCard(view, cardId) {
      setState({ taskBusy: true, error: null })
      // ⚠️ 走 `task` 的 action，**不是** `method:'clarify'`——后者不存在，
      // 而 `method:'dispatch'` 更糟：那个名字**已经被「派单设置」占用**，
      // 请求会被设置分支吃掉并返回 ok:true（看起来成功、其实什么都没发生）。
      post({ method: 'task', action: 'clarify', id: String(cardId) })
        .then(function (json) {
          if (json && json.ok === true) {
            var result = json.result || {}
            setState({
              taskBusy: false,
              ...boardPatch(result.board),
              error: null,
              notice: json.hint || '澄清会话已起。',
            })
            // 浮窗里问：它继承大脑的上下文，用户就在这张卡旁边一问一答。
            openSessionFloat('clarify', result.sessionId, result)
          } else {
            setState({ taskBusy: false, error: (json && json.error) || '起澄清会话失败', notice: json && json.hint ? json.hint : null })
          }
        })
        .catch(function () {
          setState({ taskBusy: false, error: '无法连接 ' + RPC })
        })
    }

    /**
     * 派单执行（v2.1.0）：建会话 → 拿 agent → 挂 goal → 投首轮消息 → 搬到「在做」。
     *
     * 失败时**把 hint 一起显示**：宿主半的 hint 里带着「会话已经建出来了、
     * 它叫什么」这种可追溯信息，只显示 error 会让用户以为什么都没发生。
     */
    function dispatchCard(view, cardId) {
      setState({ taskBusy: true, error: null })
      post({ method: 'task', action: 'dispatch', id: String(cardId) })
        .then(function (json) {
          if (json && json.ok === true) {
            setState({
              taskBusy: false,
              ...boardPatch(json.result.board),
              error: null,
              notice: json.hint || '已派出去。',
            })
            /**
             * 派单成功 = 会话刚被投了首轮消息，**它现在就在跑**。
             * 立刻查一次状态，卡片上那行「执行中」才会马上出现
             * （否则要等下一个 8 秒轮询）。
             */
            pollLive()
          } else {
            setState({ taskBusy: false, error: (json && json.error) || '派单失败', notice: json && json.hint ? json.hint : null })
          }
        })
        .catch(function () {
          setState({ taskBusy: false, error: '无法连接 ' + RPC })
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
            setState({ themeBusy: null, themeNotice: '已恢复液态玻璃（内置默认）' })
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
              themeNotice: '已卸载「' + id + '」' + (json.result.resetCurrent === true ? '，并已恢复液态玻璃' : ''),
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

    /* ------------------ 主题开发 / 分享（v1.0.0） ------------------ */

    /**
     * 拉主题仓库检出状态（本地 git，不联网）。
     *
     * 打开主题页时拉一次：面板要据此决定「开发主题 / 上传」两个入口是**可用**还是
     * 「还没克隆仓库」。查不到仓库时不报错——那是正常状态（大多数人只是用主题），
     * 界面给一句「把仓库克隆到工作区就能开发」即可。
     */
    function loadThemeRepo(sessionId) {
      post({ method: 'theme', action: 'repostatus', sessionId: String(sessionId) })
        .then(function (json) {
          if (json && json.ok === true) setState({ themeRepo: json.result })
          else setState({ themeRepo: { error: (json && json.error) || '读不到主题仓库状态' } })
        })
        .catch(function () {
          setState({ themeRepo: { error: '无法连接 ' + RPC } })
        })
    }

    /**
     * 「开发主题」：建脚手架 + 把开发提示词**填进输入框**。
     *
     * 为什么提示词要填进输入框而不是直接发给模型：本仓一贯的分工是
     * 「面板只填提示词，发不发由用户决定」（与其它按钮同一条规矩）。
     * 填进去用户还能改两笔再发，直接发就替他做了决定。
     */
    function devTheme(sessionId, id, name) {
      if (state.themeBusy !== null) return
      setState({ themeBusy: 'dev:' + id, themeError: null, themeNotice: null })
      post({ method: 'theme', action: 'dev', id: String(id), name: String(name || ''), sessionId: String(sessionId) })
        .then(function (json) {
          if (json && json.ok === true) {
            var result = json.result || {}
            var filled = fillPrompt(result.prompt)
            setState({
              themeBusy: null,
              themeRepo: result.repo !== undefined ? { repo: result.repo, repoIds: (state.themeRepo && state.themeRepo.repoIds) || [], packs: (state.themeRepo && state.themeRepo.packs) || [] } : state.themeRepo,
              themeNotice: '脚手架已就绪：' + String(result.dir || '')
                + (result.isNew === true ? '（新建）' : '（已存在，没覆盖你的改动）')
                + (filled ? '；开发提示词已填进输入框' : '；提示词没填进去（面板拿不到输入框，请手动复制）'),
              devPrompt: filled ? '' : String(result.prompt || ''),
            })
            load(sessionId)
          } else {
            setState({ themeBusy: null, themeError: (json && json.error) || '建脚手架失败' })
          }
        })
        .catch(function () {
          setState({ themeBusy: null, themeError: '无法连接 ' + RPC })
        })
    }

    /**
     * 「上传」：写文件 → 重算清单 → commit → push（**插件不读任何令牌**，
     * 凭据由 git 自己的凭据链取，见 `lib/themedev.js` 文件头）。
     *
     * 每一步的输出都显示出来：本仓老教训是「诊断行写死会让误报与真错同形」。
     */
    function publishTheme(sessionId, id, name) {
      if (state.themeBusy !== null) return
      setState({ themeBusy: 'pub:' + id, themeError: null, themeNotice: null })
      post({ method: 'theme', action: 'publish', id: String(id), name: String(name || ''), sessionId: String(sessionId) })
        .then(function (json) {
          if (json && json.ok === true) {
            var result = json.result || {}
            setState({
              themeBusy: null,
              themeRepo: result.repo !== undefined ? { repo: result.repo, repoIds: (state.themeRepo && state.themeRepo.repoIds) || [], packs: (state.themeRepo && state.themeRepo.packs) || [] } : state.themeRepo,
              themeNotice: '已上传：' + String(result.hint || '') + '（提交 ' + String(result.files || 0) + ' 个文件）',
              publishSteps: Array.isArray(result.steps) ? result.steps : [],
            })
          } else {
            setState({
              themeBusy: null,
              themeError: (json && json.error) || '上传失败',
              themeHint: (json && json.hint) || '',
              publishSteps: json && Array.isArray(json.steps) ? json.steps : [],
              publishStderr: (json && json.stderr) || '',
              themeRepo: json && json.repo !== undefined ? { repo: json.repo, repoIds: (state.themeRepo && state.themeRepo.repoIds) || [], packs: (state.themeRepo && state.themeRepo.packs) || [] } : state.themeRepo,
            })
          }
        })
        .catch(function () {
          setState({ themeBusy: null, themeError: '无法连接 ' + RPC })
        })
    }

    /** 重算 `index.json`（作者手改了 CSS 之后让清单跟上）。 */
    function repairThemeIndex(sessionId) {
      if (state.themeBusy !== null) return
      setState({ themeBusy: 'repair', themeError: null, themeNotice: null })
      post({ method: 'theme', action: 'repair', sessionId: String(sessionId) })
        .then(function (json) {
          if (json && json.ok === true) {
            var result = json.result || {}
            setState({
              themeBusy: null,
              themeNotice: '清单已重算：' + String(result.count || 0) + ' 套主题'
                + (result.changed === true ? '（有变化）' : '（本来就没变）'),
              themeRepo: result.repo !== undefined ? { repo: result.repo, repoIds: (state.themeRepo && state.themeRepo.repoIds) || [], packs: (state.themeRepo && state.themeRepo.packs) || [] } : state.themeRepo,
            })
          } else {
            setState({
              themeBusy: null,
              themeError: (json && json.error) || '重算清单失败',
              themeHint: Array.isArray(json && json.problems) ? json.problems.join('；') : '',
            })
          }
        })
        .catch(function () {
          setState({ themeBusy: null, themeError: '无法连接 ' + RPC })
        })
    }

    /** 导出单文件主题包（第二条分享路：发给对方粘贴导入）。 */
    function exportPack(sessionId, id, fromRepo) {
      if (state.themeBusy !== null) return
      setState({ themeBusy: 'exp:' + id, themeError: null, themeNotice: null, themePackOut: null })
      var body = { method: 'theme', action: 'export', sessionId: String(sessionId) }
      if (fromRepo === true) body.repoId = String(id)
      else body.id = String(id)
      post(body)
        .then(function (json) {
          if (json && json.ok === true) {
            var result = json.result || {}
            setState({
              themeBusy: null,
              themePackOut: result,
              themeNotice: '已导出「' + String(result.id || '') + '」主题包'
                + (result.path ? '（' + String(result.path) + '）' : '')
                + '；发给别人粘贴到「导入」框即可',
              packs: Array.isArray(result.packs) ? result.packs : state.packs,
            })
          } else {
            setState({ themeBusy: null, themeError: (json && json.error) || '导出失败' })
          }
        })
        .catch(function () {
          setState({ themeBusy: null, themeError: '无法连接 ' + RPC })
        })
    }

    /**
     * 导入主题包。**同 id 已装时先问一句**（`overwrite`）——
     * 直接覆盖会把用户原来那套删掉，那是不可逆的。
     */
    function importPack(sessionId, text, overwrite) {
      if (state.themeBusy !== null) return
      setState({ themeBusy: 'import', themeError: null, themeNotice: null })
      post({ method: 'theme', action: 'import', text: String(text || ''), overwrite: overwrite === true, sessionId: String(sessionId) })
        .then(function (json) {
          if (json && json.ok === true) {
            var result = json.result || {}
            setState({
              themeBusy: null,
              themePackText: '',
              themeNotice: '已导入并应用「' + String((result.manifest && result.manifest.name) || result.id || '') + '」'
                + (result.applied === true ? '' : '（但应用失败：' + String(result.applyError || '') + '）'),
            })
            load(sessionId)
          } else if (json && json.exists === true) {
            // 重名：把选择交给用户，不替他决定。
            setState({
              themeBusy: null,
              themeError: null,
              themeNotice: '本机已经装过同 id 的主题「' + String(json.id || '') + '」——要替换它吗？',
              themeConfirmOverwrite: String(json.id || ''),
            })
          } else {
            setState({ themeBusy: null, themeError: (json && json.error) || '导入失败', themeHint: (json && json.hint) || '' })
          }
        })
        .catch(function () {
          setState({ themeBusy: null, themeError: '无法连接 ' + RPC })
        })
    }

    /* ------------------ 自动更新（v1.0.0） ------------------ */

    /** 查有没有新版本（顺带把更新日志拉回来）。 */
    function checkUpdateNow() {
      setState({ update: { checking: true }, updateError: null })
      post({ method: 'update', action: 'check', sessionId: String(state.sessionId || '') })
        .then(function (json) {
          if (json && json.ok === true) setState({ update: json.result, updateError: null })
          else setState({ update: { error: (json && json.error) || '检查更新失败', tried: json && json.tried }, updateError: null })
        })
        .catch(function () {
          setState({ update: { error: '无法连接 ' + RPC } })
        })
    }

    /**
     * 拉**各个版本**的更新日志（v1.0.1，用户需求「有个地方看各个版本的更新日志」）。
     *
     * 摘要在**宿主半**压好（每版最多 3 行，`RELEASE_SUMMARY_LINES`），面板只渲染。
     * 这样那条截断规则能被测试直接钉住，而不必真机点开才验得到。
     */
    function loadReleases() {
      setState({ releases: { loading: true }, updateError: null })
      post({ method: 'update', action: 'releases', sessionId: String(state.sessionId || '') })
        .then(function (json) {
          if (json && json.ok === true) setState({ releases: json.result })
          else setState({ releases: { error: (json && json.error) || '拉更新日志失败', tried: json && json.tried } })
        })
        .catch(function () {
          setState({ releases: { error: '无法连接 ' + RPC } })
        })
    }

    /**
     * 一键更新：让**独立子进程**去装，失败自动回退（v1.0.1，用户裁定）。
     *
     * 为什么这里只发一个「启动」请求就完事：装包可能跑几十秒，卡在 HTTP 请求里
     * 浏览器会先超时。进度由 `loadStaged()` 轮询 `lastRun` 拿。
     *
     * 为什么要说清「独立进程」：装坏了插件本身就加载不了、面板会跟着消失——
     * 那时回退逻辑还能跑，正是因为它不在插件里。这句话让用户知道这套设计存在。
     */
    function installUpdateNow(version, tag) {
      setState({ updateBusy: true, updateError: null, updateNotice: null, updateRun: null })
      post({
        method: 'update', action: 'install',
        version: String(version || ''), tag: String(tag || ''),
        sessionId: String(state.sessionId || ''),
      })
        .then(function (json) {
          if (json && json.ok === true) {
            var result = json.result || {}
            setState({
              updateBusy: false,
              updateNotice: '安装器已在后台运行（独立进程）——' + String(result.hint || ''),
              updateInstalling: true,
            })
            // 立刻开始轮询：用户马上就能看到「正在装 / 已装好 / 已回退」。
            pollRun(0)
          } else {
            setState({ updateBusy: false, updateError: (json && json.error) || '启动安装失败', updateHint: (json && json.hint) || '' })
          }
        })
        .catch(function () {
          setState({ updateBusy: false, updateError: '无法连接 ' + RPC })
        })
    }

    /**
     * 轮询安装结果。
     *
     * ## 三种「结束」与一种「还在跑」
     *
     * 结果文件里 `running: true` 表示安装器**正在跑**（它一启动就写这条，
     * 见 `tools/dsh-puzzle-update.mjs` 的 `writeRunning`）。这一条是实测补上的：
     * 第一版只在结束时写文件，面板分不清「正在装」与「根本没起来」——
     * 两种情况都看不到文件，用户不知道该等还是该重来。
     *
     * ## 为什么上限给到 5 分钟
     *
     * pnpm 解析 git tag 要联网问 GitHub，实测一次要一两分钟（本机网络下）。
     * 上限太短会让「其实在正常装」被判成卡住——那比不提示更糟。
     * 到点也**不说失败**，只说「还没结果，去看 last-run.json」。
     */
    function pollRun(tries) {
      var attempt = typeof tries === 'number' ? tries : 0
      var MAX_TRIES = 200 // 200 × 1.5s ≈ 5 分钟
      if (attempt > MAX_TRIES) {
        setState({
          updateInstalling: false,
          updateError: '安装器跑了 5 分钟还没写结果，可能卡住了。看暂存目录里的 last-run.json。',
        })
        return
      }
      post({ method: 'update', action: 'staged', sessionId: String(state.sessionId || '') })
        .then(function (json) {
          if (json && json.ok === true && json.result !== undefined && json.result !== null) {
            var run = json.result.lastRun
            setState({ updateStaged: json.result, updateRun: run })
            if (run !== null && run !== undefined) {
              // 还在跑：继续等，并把阶段显示出来（「备份中 / 安装中」）。
              if (run.running === true) {
                setState({ updateNotice: run.phase === 'install' ? '正在装（pnpm 解析依赖，可能要一两分钟）…' : '正在备份…' })
                setTimeout(function () { pollRun(attempt + 1) }, 1500)
                return
              }
              if (run.stage !== '' && run.stage !== 'dry-run') {
                setState({ updateInstalling: false })
                if (run.ok === true) {
                  setState({ updateNotice: '已装好 v' + String(run.afterVersion || '') + '。**重启 profile** 才会生效。' })
                  checkUpdateNow()
                } else if (run.rolledBack === true) {
                  setState({ updateError: '更新失败，**已自动回退**：' + String(run.error || '') + '（回到 v' + String(run.beforeVersion || '?') + '）' })
                } else {
                  setState({ updateError: '更新失败：' + String(run.error || '') })
                }
                return
              }
            }
          }
          setTimeout(function () { pollRun(attempt + 1) }, 1500)
        })
        .catch(function () {
          setTimeout(function () { pollRun(attempt + 1) }, 1500)
        })
    }

    /**
     * 下载新版到暂存区（**不安装**）。
     *
     * 保留它：一键更新走的是「独立进程自己下自己装」，而这条是「先下下来看看」
     * ——装之前想验一下 sha256、或想离线装的人需要它。
     */
    function downloadUpdateNow(version) {
      setState({ updateBusy: true, updateError: null, updateNotice: null })
      post({ method: 'update', action: 'download', version: String(version || ''), sessionId: String(state.sessionId || '') })
        .then(function (json) {
          if (json && json.ok === true) {
            var result = json.result || {}
            setState({
              updateBusy: false,
              updateStaged: result,
              updateNotice: '已下载并校验 v' + String(result.version || '')
                + '（' + (result.verified === 'sha256' ? 'sha256 比对通过' : '结构校验，正文里没有哈希锚点') + '）',
            })
          } else {
            setState({ updateBusy: false, updateError: (json && json.error) || '下载失败', updateHint: (json && json.hint) || '', updateTried: json && json.tried })
          }
        })
        .catch(function () {
          setState({ updateBusy: false, updateError: '无法连接 ' + RPC })
        })
    }

    /**
     * ## 一条安装记录算不算「当前这次」？（v2.4.19 修的真 bug）
     *
     * ## 那个 bug 的形状
     *
     * 用户报「有没有可能是他发癫回退了」。查下来：`last-run.json` 是
     * **8 天前**一次失败的记录（v1.1.3 安装时 codeload 下载超时），
     * 而面板把它当成刚刚发生的事渲染成「更新失败，**已自动回退**到 v1.1.2」，
     * 下面又同时写着「已经是最近版本 v2.4.18」——**两句自相矛盾**，
     * 看起来就像插件在发癫。
     *
     * 根因：渲染时只判 `stage !== ''`，**完全不看这条记录有多旧**。
     * 一条历史失败会永远挂在那里，用户每打开一次更新页就被误导一次。
     *
     * ## 判据：用时间窗，不用「有没有内容」
     *
     * 「刚刚发生的」= `finishedAt` 落在最近 **24 小时**内。
     * 为什么是 24 小时而不是「本次会话内」：
     *   - 用户可能装完就关了面板、第二天打开还想看到结论（那是**有用**的信息）；
     *   - 而超过一天还挂着「刚刚失败」就是噪音了。
     *
     * 为什么不用「本次会话内」：面板是全局的，用户重开客户端后 `state` 是空的，
     * 而那次安装的结论仍然值得看一次——只是不该**永远**看。
     *
     * ⚠️ `finishedAt` 缺失或解析不出来时**算新鲜**：那是老版本安装器写的记录，
     * 里面没有这个字段。宁可多显示一次，也不要因为字段缺失就把真实失败藏掉。
     * （藏掉失败比多显示一次失败危险得多。）
     *
     * @param run `state.updateRun`
     * @returns 这条记录是否值得当作「当前这次」渲染
     */
    function runIsCurrent(run) {
      if (run === null || run === undefined) return false
      if (run.running === true) return true
      var finished = typeof run.finishedAt === 'string' ? run.finishedAt : ''
      if (finished === '') return true
      var at = Date.parse(finished)
      // 解析不出来 → 老记录格式，算新鲜（见上）。
      if (!isFinite(at)) return true
      var age = Date.now() - at
      // 未来时间（时钟错乱）也算新鲜：不因为时钟问题藏掉一次真实失败。
      if (age < 0) return true
      return age < 24 * 60 * 60 * 1000
    }

    /**
     * 把「过期记录」变成一句**明确的历史说明**，而不是删掉。
     *
     * 为什么保留：用户确实想知道「上次为什么没装上」。只是不该让它冒充
     * 「刚刚发生的事」。所以过期时换成一句带时间的陈述，且**不再显示
     * 「已自动回退」这种现在时**（回退是过去发生的一次动作，不是当前状态）。
     */
    function staleRunNotice(run) {
      if (run === null || run === undefined) return null
      var finished = typeof run.finishedAt === 'string' ? run.finishedAt.slice(0, 16).replace('T', ' ') : ''
      var when = finished === '' ? '上次' : finished
      if (run.ok === true) return null
      var what = run.rolledBack === true
        ? '那次更新失败，插件已回退到原版本（当前不受影响）'
        : '那次更新失败'
      return when + ' 有过一次更新尝试：' + what + '。原因：' + String(run.error || '未记录')
    }

    /** 读暂存区现状 + 最近一次安装结果 + 备份清单。 */
    function loadStaged() {
      post({ method: 'update', action: 'staged', sessionId: String(state.sessionId || '') })
        .then(function (json) {
          if (json && json.ok === true) {
            setState({ updateStaged: json.result, updateRun: json.result.lastRun || null })
          }
        })
        .catch(function () {
          /* 静默：这是辅助信息 */
        })
    }

    /**
     * 把宿主回报的「各镜像分别报了什么」并回清单状态里。
     *
     * 为什么不让它随请求一起丢掉：主题拉不到时，用户需要看到
     * 「jsDelivr / gh-proxy / raw 分别超时还是 404」——只说「下载失败」等于没诊断。
     */
    function mergeThemeTried(list, json) {      if (list === null || list === undefined) return list
      if (json === null || json === undefined || !Array.isArray(json.tried)) return list
      var merged = Object.assign({}, list)
      merged.tried = json.tried
      return merged
    }


    /**
     * 拉某个模块的详情（点图块）。
     *
     * ⚠️ **不要求 `sessionId`**（v2.0.0）：读模块详情是纯粹的「读文档」，
     * 与任何会话无关。原先那句「没有会话 ID 就 return」会让**不打开会话的用户**
     * 点图块完全没反应——按了不动、也不报错，是最难查的一类故障。
     * 这里改成「有就带上、没有就不带」。
     */
    function loadDetail(sessionId, name, project) {
      var body = { method: 'module', name: String(name) }
      if (sessionId !== undefined && sessionId !== null && sessionId !== '') body.sessionId = String(sessionId)
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
     * 取主文档原文（含 front-matter）。
     *
     * 面板里**只读**：拼图文档只能由 AI 通过 puzzle_mode 改，做成可编辑就等于开了后门。
     */
    function loadMain(sessionId, project) {
      // 合并而不是覆盖：重新拉取时先留着上一次的原文（否则主文档区块会闪一下空白）。
      // `error` 要清掉：否则上一次失败的红字会跟着新一次请求活到成功之后。
      setState({ main: Object.assign({}, state.main, { loading: true, error: undefined }) })
      // ⚠️ `sessionId` 可选（v2.0.0）：读主文档与任何会话无关，有就带上、没有就不带。
      var body = { method: 'main' }
      if (sessionId !== undefined && sessionId !== null && sessionId !== '') body.sessionId = String(sessionId)
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
     * 扫工作区里**还没有拼图文档**的顶层目录（用户需求 v0.21.0 ①）。
     *
     * 为什么要走宿主而不是让面板自己猜：目录清单是客观事实，宿主扫一次给出
     * 名字 + 证据（目录里前几个文件名），用户勾选才有依据。面板只管画。
     */
    function scanCandidates(view) {
      var sessionId = view.state.sessionId
      setState({ loading: true, scanPick: [] })
      // ⚠️ `sessionId` 可选（v2.0.0）：扫描工作区与会话无关。
      var body = { method: 'scan' }
      if (sessionId !== undefined && sessionId !== null && sessionId !== '') body.sessionId = String(sessionId)
      post(body)
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
          var one = { method: 'create', project: String(name), modules: [], goal: '' }
          if (sessionId !== undefined && sessionId !== null && sessionId !== '') one.sessionId = String(sessionId)
          return post(one)
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
      if (project === "") {
        setState({ error: '请先填项目名（它会成为工作区里的文件夹名）' })
        return
      }
      var modules = String(view.state.formModules || "")
        .split(/[,，、;；\s]+/)
        .map(function (item) { return item.trim() })
        .filter(function (item) { return item !== "" })
      setState({ loading: true })
      var createBody = {
        method: 'create',
        project: project,
        modules: modules,
        goal: String(view.state.formGoal || "").trim(),
      }
      if (sessionId !== undefined && sessionId !== null && sessionId !== '') createBody.sessionId = String(sessionId)
      post(createBody)
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
     * 「快速建空壳 / 采访后再建」：把模板投给一个**新建的会话**（v2.1.2）。
     *
     * ## 为什么是「起会话 + 投提示词」，不是「填进输入框」
     *
     * 这两条路要模型**去读工作区**（按真实分层拆模块、按实际体量定规模档），
     * 一轮对话远远做不完，而且它得用 `puzzle_mode` 真把文档写出来。
     * 填进输入框等于「提示词到了，但还得用户自己按回车、还得盯着」——
     * 而模板里那句「建完回报路径」根本没人在等。
     *
     * 与「开发主题」那条的区别：那条的产物是**一段用户要改的提示词**（脚手架 + 让用户自己发），
     * 这条的产物是**建出来的项目**（AI 直接干）。两件事的终点不同，所以一条填框、一条起会话。
     *
     * ## `requestId` 为什么在客户端生成
     *
     * 宿主按 `requestId` 做幂等（重复投同一条会被识别为已收）。所以它必须**每次点击唯一**——
     * 由面板生成一个带时间戳与随机数的值，比让宿主自己凑更可靠（宿主那层没有点击这个概念，
     * 只能用时间戳，连点两次可能撞在同一毫秒）。
     */
    function buildViaSession(view, kind) {
      if (view.state.buildBusy === true) return
      var project = String(view.state.formProject || '').trim()
      if (project === '') {
        setState({ error: '请先填项目名（它会成为工作区里的文件夹名）' })
        return
      }
      var form = { modules: String(view.state.formModules || ''), goal: String(view.state.formGoal || '') }
      var text = kind === 'interview'
        ? interviewTemplate(project, '', '', limitsOf(view.state.data), form)
        : createTemplate(project, form)
      setState({ buildBusy: true, error: null, notice: null })
      post({
        method: 'build',
        prompt: text,
        requestId: 'puzzle-build-' + Date.now() + '-' + Math.floor(Math.random() * 1e9),
      })
        .then(function (json) {
          if (json && json.ok === true) {
            var result = json.result || {}
            setState({
              buildBusy: false,
              newOpen: false,
              formProject: '',
              formModules: '',
              formGoal: '',
              notice: json.hint || '已起会话。',
            })
            // 把那个会话挂进面板内浮窗——用户点这个按钮就是想**在面板里看着它做**，
            // 而不是被切到主区、还得回侧边栏找回来（v2.1.3）。
            openBuildFloat(result.sessionId, result)
          } else {
            setState({
              buildBusy: false,
              error: (json && json.error) || '起会话失败',
              notice: json && json.hint ? json.hint : null,
            })
          }
        })
        .catch(function () {
          setState({ buildBusy: false, error: '无法连接 ' + RPC })
        })
    }

    /**
     * 把「新建项目会话」挂进面板内浮窗（v2.1.3）。
     *
     * ## 为什么要 `sessions.retain()`
     *
     * 内嵌对话流渲染的是**那个会话本身**，而宿主的 `SessionProvider` 只认
     * `SessionReference`（它内部会校验 `sessions.binding(id) === reference.binding`，
     * 传裸 id 会抛「reference is not active in this Controller」）。
     * 见 ui-subagent 的 `SidebarChatTab`：同一套做法（`sessions.retain` → `SessionProvider`）。
     *
     * `source` 取 `'sidebarChat'`：它与这里的语义一致（一个内嵌的对话视图），
     * 也是宿主里已经存在的取值（`SessionReferenceSourceMap` 只登记了
     * `controllerOperation` / `gateway` / `sidebarChat`，运行时它只是引用计数的分桶键）。
     *
     * ## `reference` 必须留着并释放
     *
     * 引用计数不归零，宿主就不会回收那个会话的 scope。所以关浮窗（或开下一个）时
     * 一定要 `release()`——见 `releaseBuildRef`。
     *
     * ## 为什么会有「拿不到」这条路
     *
     * `retain()` 对未知 id 会抛（`sessions.retain: unknown session <id>`）。
     * 客户端是靠 `api-session/added` 这条远程事件才认识新会话的，而宿主是
     * 「建会话 → 发事件 → 回 HTTP」，两者不保证先后。真拿不到就**如实说**，
     * 并把会话 id 显示出来（它在侧边栏里，用户找得回）。
     */
    function openBuildFloat(sessionId, result) {
      openSessionFloat('build', sessionId, result)
    }

    /**
     * 把一个会话挂进面板内浮窗（v2.2.0：三种浮窗共用这一条）。
     *
     * ## 为什么抽出来
     *
     * 新建项目、全局大脑、澄清器三处要做的事**逐字相同**：
     * `releaseBuildRef()` → `sessions.retain()` → 落进 `state.build`。
     * 三份各写一遍的必然结果是某一份漏了 `release`（引用计数不归零），
     * 而那种缺陷不报错、只是会话的 scope 永远不被回收。
     *
     * ## `extra` 里带什么
     *
     * 头部文案要用的字段（`inherited` / `taskTool` 等）与诊断字段。
     * 全部**如实透传**，渲染那边按 `kind` 决定显示哪几个。
     */
    function openSessionFloat(kind, sessionId, result) {
      releaseBuildRef()
      var info = result || {}
      var base = {
        kind: kind,
        sessionId: typeof sessionId === 'string' ? sessionId : '',
        wired: info.wired === undefined ? '' : String(info.wired),
        wiredTool: info.wiredTool === true,
        wiredReason: info.wiredReason === undefined ? '' : String(info.wiredReason),
        reference: null,
        error: null,
        // 三处各自的回包字段：统一放在这里，渲染按 kind 取。
        inherited: info.inherited === true,
        brainSessionId: info.brainSessionId === undefined ? '' : String(info.brainSessionId),
        reused: info.reused === true,
        taskTool: info.taskTool === undefined ? '' : String(info.taskTool),
        taskToolReason: info.taskToolReason === undefined ? '' : String(info.taskToolReason),
        brain: info.brain === undefined ? '' : String(info.brain),
        brainReason: info.brainReason === undefined ? '' : String(info.brainReason),
        /**
         * ⚠️ `brainDoc` 必须**原样透传这个布尔**，不能在面板侧由 `brain` 推导
         * （见 `buildFloatLayer` 里那段：推导过一次，把成功报成了失败）。
         */
        brainDoc: info.brainDoc === true,
        /**
         * 卡 id（v2.4.14）：`exec` 浮窗要拿它去调 `task:stop`（见 `stopCardSession`）。
         * 另外三种浮窗（建项目 / 大脑 / 澄清器）不挂某一张卡，所以是空串——
         * **如实透传**，渲染侧不猜「这是不是某个卡会话」。
         */
        cardId: info.cardId === undefined ? '' : String(info.cardId),
      }
      if (base.sessionId === '') {
        setState({ build: Object.assign({}, base, { error: '宿主没有返回会话 id' }) })
        return
      }
      var ctx = panelCtx
      var sessions = ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
      if (sessions === undefined || sessions === null || typeof sessions.retain !== 'function') {
        setState({ build: Object.assign({}, base, { error: '拿不到宿主的 sessions 服务，没法在面板里挂这个会话' }) })
        return
      }
      var reference
      try {
        reference = sessions.retain(base.sessionId, { source: 'sidebarChat' })
      } catch (error) {
        setState({ build: Object.assign({}, base, { error: String((error && error.message) || error) }) })
        return
      }
      setState({ build: Object.assign({}, base, { reference: reference }) })
    }

    /**
     * 释放浮窗持有的会话引用。幂等；没有浮窗时什么也不做。
     *
     * ⚠️ **释放之后必须把 `reference` 置回 `null`**（v2.4.16）：
     * `release()` 只是把那个 `ClientSessionReference` 内部的 `record` 清掉，
     * **对象本身还在、`typeof reference.release` 也还在**。如果这里留着它，
     * 那么「浮窗有没有可用引用」这个判据（`build.reference !== null`）就永远为真，
     * 于是重新挂载时 `reattachBuildRef` 会以为一切正常、不去补引用，
     * 浮窗照旧把一个**已释放**的引用交给宿主 —— 那正是白屏本身。
     * 所以「引用已放掉」这件事必须**写进状态**，不能只留在宿主的内部字段里。
     *
     * 这里直接换 `state` 而**不发 emit**：三个调用点（关浮窗 / 换浮窗 / 删会话）
     * 后面都紧跟一条 `setState`，而剩下那个调用点在卸载清理里（组件已经没了）。
     * 多一次 emit 只会让卸载中的组件收到一次无意义的通知。
     */
    function releaseBuildRef() {
      var build = state.build
      if (build === null || build === undefined) return
      var reference = build.reference
      if (reference === null || reference === undefined) return
      if (typeof reference.release === 'function') {
        reference.release()
      }
      state = Object.assign({}, state, { build: Object.assign({}, build, { reference: null }) })
    }

    /**
     * 面板重新挂载时把浮窗那个会话**重新接上**（v2.4.16）。
     *
     * ## 为什么必须有它：白屏的根因
     *
     * 浮窗状态住在**模块级** `state.build` 里，它活得比面板组件长。切到别的主面板时
     * 宿主不再渲染这块 `main`，`Panel` 被卸载、卸载清理 `release()` 掉引用
     * （那是必须的，否则引用计数不归零）；但 `state.build` 还在，**里面那个
     * `SessionReference` 已经作废**。切回来时面板重新挂载、浮窗照旧渲染，于是拿一个
     * 已释放的引用去挂 `SessionProvider`——宿主那边 `adapter.bindingSource()` 会读
     * `reference.binding`，而 `ClientSessionReference.binding` 在 `record` 被清掉后
     * **直接抛** `Session reference "…" is released`。面板那一格被宿主的错误边界判死，
     * 表现就是「切走再切回来白屏」，而且不会自己恢复。
     *
     * 所以挂载时补一次 `retain()`：已经有引用就什么也不做（幂等），没有就按
     * `openSessionFloat` 那条老路重新拿一个（拿不到照样如实写进 `error`，不假装有对话流）。
     *
     * 只在「本该显示对话流」的那一态补：`closing`（正在删）与 `error`（已经有一句
     * 失败原因）两态**不碰**——给正在删的会话续引用是错的，重试失败也会盖掉原来那句原因。
     */
    function reattachBuildRef() {
      var build = state.build
      if (build === null || build === undefined) return
      if (build.reference !== null && build.reference !== undefined) return
      if (build.closing === true) return
      if (build.error !== null && build.error !== undefined) return
      openSessionFloat(build.kind, build.sessionId, build)
    }

    /** 关掉浮窗（并放掉引用）。会话本身**不受影响**——它仍在侧边栏里。 */
    function closeBuildFloat() {
      releaseBuildRef()
      setState({ build: null })
    }

    /**
     * **永久删掉浮窗里那个会话**（v2.1.7）。
     *
     * ## 更正 v2.1.6 的一个错误结论
     *
     * v2.1.6 这里写的是「DSH 没有删除会话的 API，所以只能归档」——
     * **那个结论是错的**，而且用户当场用反例指出来了：
     * `@michengai/dsh-archive-manager` 就能真删。
     *
     * 它怎么做到的：官方 `WorkspaceRegistry` 确实只有 archive / unarchive，
     * 但那个插件用 `cordis.patch.yml` 把官方 `workspace` 服务**整个替换**成自己的子类
     * （`disabled: true` + `insert: workspace-archive-manager`），
     * 然后加上 `deleteSession` / `deleteArchivedSessions`，
     * 里面真的 `rm -rf` 转录目录（它的 `workspace.js:1094`）。
     *
     * 所以「官方没有」≠「做不到」——**插件可以接管宿主服务**。这是我上一轮的判断失误。
     *
     * ## 为什么走 RPC 调它，而不是自己实现
     *
     * 那个插件**已经**接管了 `workspace`，它的 `deleteSession` 此刻就可调用。
     * 我不去抢着替换同一个服务（两个插件 patch 同一个 id 会打架），
     * 而是请宿主半转发给它。
     *
     * 更重要的理由：它那份把善后都做全了——`flush` 落盘 → 从 sessions 摘除 →
     * 清投影缓存 → **级联删子会话** → 清 spill → 删转录目录 →
     * 清归档记账 → 写墓碑**阻止父类把 stale 列表又编回索引** → 广播移除。
     * 自己重写几乎必然漏掉「墓碑防复活」，症状是**删了又回来**，比不删更让人困惑。
     *
     * ## 拿不到就如实说，**不偷偷退回归档**
     *
     * 没装那个插件时宿主半会回 `ok:false` + 一句说明。这里照实显示，
     * 绝不退化成「移出侧边栏」——用户点的是删，把它做成归档就是**把失败伪装成成功**。
     */
    function deleteBuildSession() {
      var build = state.build
      if (build === null || build === undefined) return
      var sessionId = String(build.sessionId || '')
      if (sessionId === '') { closeBuildFloat(); return }
      /**
       * 先放掉引用再删：本插件持有的是 `sessions.retain()` 的引用，
       * 自己不放就轮到宿主猜「这个会话还有没有人用」。放干净再删。
       * 顺带把 `reference` 置 null，渲染那边才不会拿一个已释放的引用去挂 `SessionProvider`。
       */
      releaseBuildRef()
      setState({ build: Object.assign({}, build, { reference: null, closing: true, error: null }) })
      post({ method: 'deleteSession', sessionId: sessionId })
        .then(function (json) {
          if (json && json.ok === true) { setState({ build: null }); return }
          setState({
            build: Object.assign({}, build, {
              reference: null,
              closing: false,
              failed: 'delete',
              error: (json && json.error) || '删除会话失败',
              notice: json && json.hint ? String(json.hint) : null,
            }),
          })
        })
        .catch(function () {
          setState({
            build: Object.assign({}, build, {
              reference: null,
              closing: false,
              failed: 'delete',
              error: '无法连接 ' + RPC + '，会话没删掉',
            }),
          })
        })
    }

    /**
     * 把主区切到某个会话（`uiWorkspace.openSession`）。
     *
     * 为什么切：这两个动作的产物是**一个正在干活的会话**，不切过去用户只看到
     * 一句「已起会话 3f2a…」，然后得自己去侧边栏找。切过去是「点完就能看着它做」。
     *
     * 拿不到服务时**静默**：会话已经起好了，切不过去只是少一步便利，不该报成失败。
     */
    function openSessionById(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      try {
        var ctx = panelCtx
        var uiWorkspace = ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
        if (uiWorkspace !== undefined && uiWorkspace !== null && typeof uiWorkspace.openSession === 'function') {
          uiWorkspace.openSession(sessionId)
        }
      } catch (_error) {
        /* 静默：见上面那条 */
      }
    }

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
      var body = { method: 'rebuild', project: String(data.project), apply: apply === true }
      if (sessionId !== undefined && sessionId !== null && sessionId !== '') body.sessionId = String(sessionId)
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

    /* --------------------------------- 样式 --------------------------------- */

    /**
     * 主题令牌：**换肤唯一入口**。
     *
     * 为什么内联在这里、不拆成 `lib/theme.js`：浏览器半是**手写的 module-loader 包**，
     * 它的 `require` 只认平台种子与「已注册的包工厂」——裸相对路径 `./theme.js`
     * 会直接抛 `missed the module table`（实测宿主 `dsh-client-modules` 的实现如此）。
     * 拆出去就是一个永远加载不了的文件，所以主题必须留在本文件内。
     *
     * ## 默认风格 = **液态玻璃**
     *
     * 默认皮肤本来就有玻璃材质（`backdrop-filter`），但它同时挂着科幻 HUD 装饰
     * （青蓝主色 + 网格 + 顶部扫描线），而面板上写的是「默认皮肤」——没人知道那叫玻璃。
     * 所以「做实」是三处：`grid` 归零（网格层消失）、blur 18→24px、
     * 顶部扫描线换成**内高光边**（玻璃的辨识度来自边缘亮线，不是彩色扫描线）。
     *
     * 与宿主的关系：宿主（`dsh-client-ui-theme`）只有 99 个 `--dsw-alias-*` **语义**
     * 令牌，**没有**字体/圆角/阴影/间距令牌。所以这里分两层：
     *   1) 基底（bg/label/border/state）**收口宿主令牌** → 宿主切浅色/深色主题时面板自动跟随；
     *   2) 玻璃部分（主色、发光、模糊、尺度、字体栈）宿主没有，自建。
     *
     * 硬约束（用户裁定）：零新依赖、零外部资源。所有特效纯 CSS，图标内联 SVG。
     */
    var THEME_GLASS = {
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
      /**
       * 第三档边框（v2.1.2 新增）。
       *
       * 宿主的 `border-l1` / `border-l2` 分别是 4% / 10% 黑（深色主题 6% / 12% 白），
       * 画在**卡片**上太淡——真机截图里条目卡的边框根本看不见，30 条要点糊成一块。
       * `l3` 是 12% / 16%，是宿主自己给「需要看清的描边」留的一档。
       */
      border3: 'var(--dsw-alias-border-l3)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      err: 'var(--dsw-alias-state-error-primary)',
      // 玻璃自建：主色仍是青蓝（沿用原有辨识度），但**不再有网格与扫描线**。
      // 发光**只给当前状态**用——满屏发光是页游，不是液态玻璃。
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
      /**
       * ## 任务卡的「纸」（v2.4.4，用户裁定）
       *
       * 用户原话：「卡的颜色改为纸的颜色再加上一层纸纹理」。看板要读的是
       * 「哪张卡在流转」，而卡原先用 `bg-2`（宿主卡片色，浅色主题下就是纯白），
       * 五列并排时白卡与白列糊在一起、没有「纸片压在板子上」的层次。
       *
       * 做法是**两层叠加**，刻意不用 `color-mix` 调纸色：
       *   1. `paperTint` —— 一层均匀的暖色（半透明 `rgba`），铺在宿主卡片色**之上**；
       *   2. `paperTexture` —— 一层极淡的纤维噪点（SVG `feTurbulence`）。
       *
       * 为什么是叠加而不是把纸色算成一个值：**纸色必须跟随宿主的浅色/深色**。
       * 写成固定米色的话，深色主题下会得到一张刺眼的白纸。叠加 `rgba` 暖色
       * 让底色仍是宿主的 `bg-2`，浅色下是米白纸、深色下是深牛皮纸，两边都对。
       *
       * ⚠️ 两层都**必须能单独失效**：纹理是 SVG data URI，老浏览器不认就只少一层
       * 噪点；暖色层是 `linear-gradient`，几乎处处支持。任一失效都还剩宿主的卡片色
       * ——不会退化成「卡片没底色」。这正是**不用** `color-mix` 的原因：它一旦不被支持，
       * 整条 `background` 变 guaranteed-invalid，卡片会直接透明。
       *
       * 纹理只放行 `data:image/` 是主题白名单的硬规则（见 `themeCssRejectReason`），
       * 所以这里用内联 SVG 而不是外部图片——**与用户主题同一把尺子**。
       */
      paperTint: 'linear-gradient(0deg,rgba(198,164,110,.15),rgba(198,164,110,.15))',
      paperTexture: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'140\' height=\'140\'%3E%3Cfilter id=\'p\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'.85\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3CfeColorMatrix type=\'saturate\' values=\'0\'/%3E%3C/filter%3E%3Crect width=\'140\' height=\'140\' filter=\'url(%23p)\' opacity=\'.06\'/%3E%3C/svg%3E")',
      /**
       * ## 列托盘（v2.4.4，与纸配套）
       *
       * 用户原话：「有卡时列框不用变白」。原先**有卡的列**用不透明的 `bg-1`
       * （浅色主题下就是纯白），而**空列**用 `color-mix(bg-1 42%, transparent)`
       * ——于是同一块板子上，有卡的列白、没卡的列是浅蓝灰，五列排在一起像两种控件。
       *
       * 现在**五列一律用这一个半透明色**：列成了「托盘」，卡片是压在上面的「纸」，
       * 层次由「纸 vs 托盘」表达，不再靠「有卡就变白」。
       *
       * 为什么半透明是安全的（与面板基底的规矩不冲突）：面板自己有**不透明**的
       * `--dshpz-glass` 兜底，列就算整个透明也只是露出面板，不会漏出下面的对话。
       * 面板基底那条禁用 `color-mix` 的注释针对的是**面板自己**——那个位置漏了就是
       * 「连对话都盖不住」，性质不同。
       */
      boardTray: 'color-mix(in srgb,var(--dsw-alias-bg-layer-1) 42%,transparent)',
      /** 叠加在底色上的极淡主色光晕：纯装饰，不支持 color-mix 时整层消失也无妨。 */
      glassSheen: 'linear-gradient(135deg,color-mix(in srgb,#22d3ee 11%,transparent),transparent 58%)',
      /**
       * 顶栏（吸顶条）自己的光晕（v2.1.1）。
       *
       * 为什么不能复用 `glassSheen`：那条是 135° 对角渐变，铺在**一整块面板**上是
       * 玻璃高光；铺在**一条 44px 高的横条**上就只剩左上角一坨亮斑，看着像渲染坏了。
       * 顶栏要的是**水平方向**的极淡主色，从左到右均匀铺开。
       */
      headSheen: 'linear-gradient(90deg,color-mix(in srgb,#22d3ee 13%,transparent),transparent 72%)',
      /**
       * 网格层：**液态玻璃归零**（v1.0.0，用户裁定「去网格/扫描线」）。
       *
       * 它原先是一层青蓝细网格（`.dshpz-panel::before` 取的就是这个值）。
       * 网格是**科幻 HUD** 的语言，不是玻璃的——玻璃靠模糊与高光分层，
       * 叠一层网格会让它看起来像「半透明仪表盘」。所以这里给 `transparent`：
       * 那一层仍然存在（不必改规则），只是画不出东西。
       *
       * 保留这个令牌而不是删掉：主题（`--dshpz-grid`）仍然可以把它改回来，
       * 喜欢网格的人下一套皮肤就能有。
       */
      grid: 'transparent',
      /**
       * 发光：只给「当前状态」（选中页签、达标进度、聚焦输入框）用。
       * 退化值是一道**实心描边**而不是无：老浏览器上仍然看得见「哪个是选中的」，
       * 只是少了光晕。发光本身是效果，选中态是信息——信息不能因兼容性丢掉。
       */
      glow: '0 0 0 1px #22d3ee',
      /**
       * 投影：玻璃要有**厚度感**，所以是「近处一道紧贴的暗边 + 远处一片散开的大阴影」。
       * 近处那道（`0 1px 2px`）负责把面板从对话里「切」出来，远处那片负责空间感。
       */
      shadow: '0 1px 2px rgba(0,0,0,.4), 0 24px 64px -12px rgba(0,0,0,.65)',
      // 圆角比 HUD 时期略大：玻璃的边缘越圆，高光越顺（液态玻璃的辨识度就在这道边）。
      radiusSm: '7px',
      radiusMd: '12px',
      radiusLg: '18px',
      fontUi: 'system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif',
      fontMono: 'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace',
      durIn: '260ms',
      durFast: '120ms',
      /**
       * `--dshpz-dur-slow`（v2.0.0 新增）：**跨列移动**这类大位移专用。
       *
       * 为什么两档不够：`fast` 120ms 与 `in` 260ms 都是给「小范围状态切换」定的；
       * 卡片从「在做」飞到「已做」横跨几百像素，260ms 会显得**跳**——
       * 眼睛跟不上落点，反而看不懂「它去哪了」。320ms 让位移有过程。
       *
       * ⚠️ **新增令牌要同步三处**（漏一处主题作者就看不到它）：
       *   ① `THEME_GLASS` / `THEME_MINIMAL`（本处）；② `lib/themedev.js` 的 `THEME_TOKENS`；
       *   ③ 脚手架 CSS 里的示例值。
       */
      durSlow: '320ms',
      /**
       * `--dshpz-dur-page`（v2.4.17 新增）：**主视图切换**专用。
       *
       * 为什么不能复用前三档：
       *   - `fast` 120ms 是「按下 / 悬停」，用在整屏换主体上会像**闪**一下，
       *     方向感根本来不及被看见（而方向正是这次要表达的东西）；
       *   - `in` 260ms 是「元素出现」，它假设的是**空场**里出现一个东西；
       *     换页时旧内容是被新内容**推走**的，节奏该比入场略紧——
       *     用户是自己按的，不需要等一场演出；
       *   - `slow` 320ms 是「跨列位移」，那是**空间里的一段路程**；
       *     换页没有路程，只有先后。
       *
       * 200ms 落在 E1.3 的「中等元素 200–350」下沿：够看清方向，又不拖。
       */
      durPage: '200ms',
      easeOut: 'cubic-bezier(.16,1,.3,1)',
      /**
       * `--dshpz-ease-in` / `--dshpz-ease-in-out`（v2.4.17 新增）。
       *
       * 原先只有 `out`（进入）与 `std`（悬停）两条。而这次升级引入的两类动作
       * 需要另外两条，缺了它们只能拿 `out` 硬凑，观感是错的：
       *   - **退场 / 被推走**（`ease-in`）：加速离开。用 `out` 会「先快后慢地走」，
       *     像被拽住又放开——退出应该是果断的（E1.4「退场用加速」）；
       *   - **页面横移**（`ease-in-out`）：两端都要平滑。纯 `out` 起步太急，
       *     整屏位移在起步那一下会有「一顿」的错觉（E1.4「位置/尺寸变化用进出对称」）。
       *
       * ⚠️ 与 `dur-page` 一样，**新增令牌要同步三处**（见 `durSlow` 那条）：
       *   ① 两个主题对象；② `lib/themedev.js` 的 `THEME_TOKENS`；③ 脚手架示例值。
       */
      easeIn: 'cubic-bezier(.55,.06,.68,.19)',
      easeInOut: 'cubic-bezier(.65,.05,.36,1)',
      easeStd: 'cubic-bezier(.4,0,.2,1)',
    }

    /**
     * D 案：现代极简（备选）。
     *
     * 它与默认（液态玻璃）**共用全部布局与结构**，差别只在颜色/发光/圆角：
     * 想换回去时把 `THEME` 指向它即可，不必改任何 CSS。
     *
     * 保留它而不是删掉：它是「不透明、无玻璃、无发光」的那一档，
     * 在低性能设备或用户嫌模糊费电时是唯一的退路。
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
      border3: 'var(--dsw-alias-border-l3)',
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
      // 纸（见 THEME_GLASS 里那段完整依据）：极简主题同样要「纸」，但更淡——
      // 它的设计语言是「不透明底、无渐变」，所以暖色层压到 .10、纹理压到 .04。
      paperTint: 'linear-gradient(0deg,rgba(198,164,110,.10),rgba(198,164,110,.10))',
      paperTexture: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'140\' height=\'140\'%3E%3Cfilter id=\'p\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'.85\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3CfeColorMatrix type=\'saturate\' values=\'0\'/%3E%3C/filter%3E%3Crect width=\'140\' height=\'140\' filter=\'url(%23p)\' opacity=\'.04\'/%3E%3C/svg%3E")',
      // 列托盘与纸同一套语义（见 THEME_GLASS 里那段依据），极简主题同样用它。
      boardTray: 'color-mix(in srgb,var(--dsw-alias-bg-layer-1) 42%,transparent)',
      // 极简不要光晕层：`none` 是合法 background-image 值，规则层不必为此写分支。
      glassSheen: 'none',
      // 顶栏同理（见 THEME_GLASS 里那条）：极简主题不要任何渐变。
      headSheen: 'none',
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
      durSlow: '260ms',
      durPage: '200ms',
      easeOut: 'cubic-bezier(.16,1,.3,1)',
      easeIn: 'cubic-bezier(.55,.06,.68,.19)',
      easeInOut: 'cubic-bezier(.65,.05,.36,1)',
      easeStd: 'cubic-bezier(.4,0,.2,1)',
    }

    /** 当前生效主题。**换肤只改这一行**：THEME_GLASS ↔ THEME_MINIMAL。 */
    var THEME = THEME_GLASS

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
       * 主色、发光、玻璃、尺度、字体栈宿主没有，自建（见 `THEME_GLASS`）。
       */
      // 令牌挂在 `:root` 上：作用域靠 `--dshpz-` 前缀与 `.dshpz-*` 选择器收窄，
      // 而不是靠挂载点——因为小按钮不在 `.dshpz-panel` 里（见上面那条注释）。
      /**
       * 主题令牌挂在 **`:root`** 而不是 `.dshpz-panel` 上。
       *
       * 作用域是「面板 **+ 那颗小按钮**」，而小按钮属于 `conversation.input.left`、
       * **不在** `.dshpz-panel` 里。令牌原先只声明在 `.dshpz-panel` 上，按钮里的
       * `var(--dshpz-*)` 一律取不到值（静默失效），「跟着变色」做不到。
       *
       * 挂全局不会污染宿主：变量名全部带 `--dshpz-` 前缀，只有本插件的 `.dshpz-*`
       * 类会读；用户主题在 `:root` 覆盖它们也是安全的（白名单强制只能改 `--dshpz-*`）。
       *
       * ## `body` 上必须**再声明一份**（这是「看板五列没状态色」的根因修复）
       *
       * 已由判定实验坐实，不是推测：宿主把 99 个 `--dsw-alias-*` 声明在 **`body`** 上，
       * 而本插件的 `--dshpz-bg-*` / `label-*` / `border-*` / `state-*` 的值写的是
       * `var(--dsw-alias-…)`，声明在 `:root`（=`html`，**`body` 的父元素**）。
       *
       * 自定义属性的 `var()` 在**声明处**求值：`:root` 这层算值时看不到只有 `body`
       * 才有的令牌，于是这些 `--dshpz-*` 全部变成 guaranteed-invalid。真机读计算值：
       * `--dshpz-accent` = `#22d3ee`（字面量，取得到），而 `--dshpz-warn/ok/err/
       * border-2/bg-1/label-3` **全是空串**——这正好解释「五列只有两列有状态色」
       * （那两列用的是字面量主色）。
       *
       * 所以令牌**两处都声明**：`:root` 那份保住 `body` 之外的挂载点，`body` 这份让
       * `var(--dsw-alias-*)` 能在**同一个元素上**解析到宿主令牌。
       *
       * ⚠️ **配套陷阱（两处必须一起改）**：`body` 上有了声明后，它的**继承值会盖住
       * `:root`**，而用户主题按白名单**只能写 `:root`**（`body{--dshpz-*}` 被
       * `themeCssRejectReason` 拒绝）——于是换肤静默失效。修法在 `applyUserTheme`：
       * 把主题里的 `--dshpz-*` **再写一份到 `body` 的行内样式**（行内优先级最高）。
       */
      ':root{' + themeVars(THEME) + '}',
      // 与 `:root` 逐字同值：同一份声明串，保证两处永远不分叉。
      'body{' + themeVars(THEME) + '}',

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
      /**
       * ===================== v2.4.17 · 运动语言 =====================
       *
       * ## 母题：**拼图块嵌进下一个槽**
       *
       * 这个插件叫「拼图」，而它的核心动作恰恰就是拼图本身的动作：
       * **一块东西从一个位置被挪到它该在的位置，然后合上**。五列看板就是这个母题
       * 最直白的舞台——「未澄清 → 未接单 → 在做 → 已做」本来就是把一块
       * 逐渐成形的拼图往成品里推。
       *
       * 所以这一版所有动效都由同一条语法生成，而不是每处挑一个流行效果：
       *
       * | 规则 | 内容 |
       * |---|---|
       * | **空间规则** | 对象**从它来的方向**进出。换页是横向推（导航栏在顶上，是横向排列）；卡换列是横向飞（列是横向排列）；浮窗是从面板内部长出来（不位移）。 |
       * | **能量规则** | 输入**立即**被承认（按下即亮 / 卡片即时跟手），跟随与收尾才带动画。等待感只能来自真实等待（网络），不能由动画制造。 |
       * | **时间规则** | 高频反馈 120ms；元素出现 260ms；跨列飞行 320ms；换页 200ms。**退场一律比入场短**（60–80%）。 |
       * | **变化规则** | 同一批动效共用曲线族：进入 `ease-out`、退场 `ease-in`、整屏横移 `ease-in-out`。 |
       * | **禁用规则** | ① 不做无限循环装饰（除骨架微光与转圈圈——它们表达「真的在等」）；② 不做滚动劫持；③ 不让动画改变命中区与焦点；④ 不用动画伪造进度、成功或 AI 的「思考」；⑤ 同屏只允许**一个**主运动焦点。 |
       *
       * ## 为什么把这条母题写进代码而不是只写在文档里
       *
       * 因为它约束的是**以后每一次改动**。下一个人想加一个「卡片弹一下」时，
       * 这段话会先问他：弹这一下表达的是「嵌进去了」还是只是「我觉得好看」？
       * 写在 CHANGELOG 里只能解释这一次，写在 CSS 里才能管住下一次。
       */

      /* ------------------------- ① 主视图切换（三页互切） ------------------------- */
      /**
       * ## 为什么要做方向感
       *
       * 项目 / 主题 / 更新是三页并列，导航栏在顶上横向排列。**横向**就是它们的
       * 空间关系，所以切换应该横向推：前进 → 新页从右进、旧页往左走；
       * 后退 → 反过来。这样「我在往哪个方向走」在动画结束前就已经知道了。
       *
       * ## 为什么旧页也要动
       *
       * 只让新页淡入（旧版做法）在**并列导航**里是错的：它看起来像「同一页
       * 内容变了」，而不是「我换了一页」。旧页必须被**推走**——那才是换页。
       *
       * ## 为什么不真做「两页同时在场」的转场
       *
       * 那需要把两页同时挂在 DOM 里（绝对定位叠起来），代价是：
       *   - 两页的数据 hook 会同时跑（一次切换多一倍请求）；
       *   - 旧页在被推走的过程中仍然可点（要额外处理 `pointer-events` 与焦点）；
       *   - 退出动画没播完就再切一次时，要处理「两条转场抢同一个容器」。
       *
       * 所以这里用**同一页容器自己播进出两段**：进场时从 ±18px 滑入并淡入，
       * 旧页不单独退场——它被新页覆盖的瞬间就是「被推走」。
       * 观感上少了半段，但换来的是**没有多一份数据和一份焦点**。
       * 这是一次自觉的取舍，不是省事（E2.6 的「先出后进」也是这个道理）。
       *
       * ## 18px 是怎么定的
       *
       * 整屏宽度的 3% 左右。太小（<8px）看不出方向，只剩「闪一下」；
       * 太大（>40px）会让人以为面板自己移位了——面板是铺满主区的，
       * 位移过大就露出宿主背景，那就不再是「一页」而是「一块卡片」。
       */
      '@keyframes dshpz-page-in-right{from{opacity:0;transform:translateX(18px)}to{opacity:1;transform:none}}',
      '@keyframes dshpz-page-in-left{from{opacity:0;transform:translateX(-18px)}to{opacity:1;transform:none}}',
      '.dshpz-page{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}',
      '.dshpz-page[data-nav="1"]{animation:dshpz-page-in-right var(--dshpz-dur-page) var(--dshpz-ease-out)}',
      '.dshpz-page[data-nav="-1"]{animation:dshpz-page-in-left var(--dshpz-dur-page) var(--dshpz-ease-out)}',
      /**
       * ## ⚠️ 换页期间锁住交互，但**绝不能让它常驻**
       *
       * 为什么需要锁：200ms 里页面在移动，此时点到的位置与眼睛看到的位置
       * 最多差 18px。对「删除」与「验收」这种相邻按钮，18px 足以点错。
       *
       * ## 这里踩过一个**整块面板点不了**的真 bug（v2.4.18 修）
       *
       * 第一版写的是：
       *
       * ```css
       * .dshpz-page[data-nav="1"],.dshpz-page[data-nav="-1"]{pointer-events:none}
       * ```
       *
       * 它假设 `data-nav` 会在动画结束后回到 0。**但 `navDir` 从来没有被复位过**
       * ——它只在导航时被设成 ±1，此后一直是 ±1。于是这条 `pointer-events:none`
       * **永久生效**：打开面板还能点（那时 `navDir` 是初始的 0），
       * **一旦切过页，整个面板就再也点不动了**。
       *
       * 为什么冒烟没抓到：那条测试只断言「导航时必须给 navDir」，
       * 没断言「它必须被复位」——**只钉了写、没钉清**，这类漏网很典型。
       *
       * ## 修法：两件事一起做
       *
       * 1. **CSS 侧不再依赖状态复位**：把锁定挂在动画**运行期间**才有效的选择器上。
       *    `animation-play-state` 做不到这件事，所以改用「动画结束就由 JS 摘掉
       *    一个类」——但更稳的是下面第 2 条。
       * 2. **JS 侧在 `animationend` 复位 `navDir`**（见 `Panel` 里的 `onAnimationEnd`）。
       *    这是根治：状态回到 0，CSS 自然不再命中。
       *
       * 所以下面这条**保留但不再是唯一防线**：即使 JS 复位失败（老 WebView 上
       * `animationend` 可能不来），也不会永久锁死——因为下一帧起 `data-nav` 仍非 0
       * 时，`animationend` 的兜底定时器会复位它。
       */
      '.dshpz-page[data-nav="1"],.dshpz-page[data-nav="-1"]{pointer-events:none}',

      /* --------------------- ② 卡片跨列飞行（本版主运动焦点） --------------------- */
      /**
       * ## 这是本版唯一的主角
       *
       * 看板上「卡换列」是用户最需要看懂的一件事：他在「未接单」把一张卡拖到
       * 「在做」，然后那张卡去哪了？原先它「啪」一下出现在新列（v2.4.16 之前
       * 是一次淡入 + 缩放），两种都在说「有个新东西出现了」——而事实是
       * **同一个东西换了位置**。这两件事在观感上是相反的。
       *
       * ## 怎么实现（FLIP 的变体）
       *
       * 搬卡前量旧矩形（`flyFrom`），渲染后量新矩形，把差值反着写成
       * `transform`（于是它**先看起来还在旧位置**），下一帧去掉 `transform`
       * 让它过渡过去。JS 负责量，CSS 只负责过渡——与 `flipList` 同一条纪律。
       *
       * ## 为什么飞行途中要**抬起**（`--dshpz-fly-lift`）
       *
       * 纯平移在五列并排的板子上会**穿过中间那几列**，看起来像一张卡在
       * 别人家的列上滑过去。加一层极轻的放大（1.02）与更亮的投影，
       * 是在说「它现在不在任何一列里，它在空中」——这正是拖动时
       * 「拿在手上」那套语言的延续（见 `.dshpz-cardghost`）。
       *
       * ## 为什么**不能**改布局属性
       *
       * 只动 `transform` 与 `opacity`。改 `left/top/margin` 会让五列里的
       * 每一张卡在每一帧重排——本仓的性能红线。
       */
      '@keyframes dshpz-card-travel{0%{box-shadow:0 14px 32px -12px rgba(0,0,0,.55)}100%{box-shadow:none}}',
      /**
       * ⚠️ `transition` 必须写在**类里**、而且**不能同时留一行内 `transition:none`**。
       *
       * 这是本次升级里抓到的一个**既有真 bug**（`flipList` 也中）：
       * 旧写法是「`node.style.transition='none'` → 设 transform → 回流 →
       * 挂类 → 清 transform」。看起来对，但**行内样式优先级高于类**——
       * 那行 `transition:none` 一直留着，于是类里的过渡永远不生效，
       * 元素直接跳到终点。**列表重排的 FLIP 其实一次都没播过**，
       * 只是没人盯着看，所以一直没被发现。
       *
       * 正确写法见 `dshpz-move-off`：用**类**来表达「这一帧不要过渡」，
       * 加类 → 设 transform → 回流 → 摘类挂本类 → 清 transform。
       * 浏览器按**变化后的**样式取过渡参数（规范如此），所以过渡会正常开始。
       */
      '.dshpz-cardtravel{position:relative;z-index:3;transition:transform var(--dshpz-dur-slow) var(--dshpz-ease-out);animation:dshpz-card-travel var(--dshpz-dur-slow) var(--dshpz-ease-out)}',
      /**
       * 「这一帧不要过渡」：给 FLIP / 飞行在**设置起点**时临时挂上。
       *
       * `!important` 是必需的：它要压过目标类里那条过渡，而两者特异性相同
       * （都是单类）。这也是本仓少见地动用 `!important` 的地方——它的作用域
       * 只有「一个元素的一帧」，不会外溢。
       */
      '.dshpz-move-off{transition:none!important}',
      /**
       * 兜底：**量不到起点时**才用它。
       *
       * `dshpz-cardfly` 是老名字，现在只在 `flyFrom === null` 时挂上——
       * 也就是说它退化成一次淡入。**保留而不是删掉**：老 WebView 上
       * `getBoundingClientRect` 可能拿不到（或者卡在视口外），
       * 那时「有个东西出现了」仍比「什么都没有」诚实。
       */
      '.dshpz-cardfly{animation:dshpz-flyin var(--dshpz-dur-slow) var(--dshpz-ease-out)}',
      '@keyframes dshpz-flyin{from{opacity:.35;transform:scale(.94)}to{opacity:1;transform:none}}',
      /**
       * ## 接收列「合上」的那一下
       *
       * 卡落进某一列时，那一列播一次极轻的**内收**（描边亮一下 + 背景微微压深）。
       * 它回答的是「这个槽接住了它」——拼图合上的那声轻响。
       *
       * 为什么幅度这么小（0.6% 缩放、不位移）：五列是并排的邻居，某一列
       * 动 2px 就足以让整块板子看起来在抖。而这条动效的作用只是**指出哪一列**，
       * 不是「庆祝」。它也**只播一次**，绝不 infinite。
       */
      '@keyframes dshpz-col-land{0%{box-shadow:inset 0 0 0 1px var(--dshpz-accent),0 1px 2px -1px rgba(0,0,0,.28)}100%{box-shadow:inset 0 0 0 0 transparent,0 1px 2px -1px rgba(0,0,0,.28)}}',
      '.dshpz-boardcol[data-landed="1"]{animation:dshpz-col-land var(--dshpz-dur-slow) var(--dshpz-ease-out)}',

      /* ------------------------- ③ 按下 / 悬停的触感 ------------------------- */
      /**
       * ## 现有反馈的问题：**只有悬停，没有按下**
       *
       * 翻一遍旧样式：`.dshpz-act:hover` 抬 1px、`.dshpz-tile:hover` 抬 2px，
       * 但 `:active` 一律只是「取消抬起」（`translateY(0)`）。那等于说：
       * 按下去和松开手看起来一样。**按下没有任何确认感**。
       *
       * 对高频工具来说，按下的触感比入场动画重要得多——用户一天按几十次，
       * 而入场一天看几次。所以这一版把「按下」补上：
       *
       * | 阶段 | 视觉 | 时长 |
       * |---|---|---|
       * | 按下 | 内收 0.97（`scale`）+ 底色加深一档 | 80ms（要快，慢了会像卡住） |
       * | 松开 | 弹回 1 | 180ms（回弹可以慢一点，那是「松手」的余韵） |
       *
       * ## 为什么用 `scale` 而不是改 `padding` / `height`
       *
       * 只有 `transform` 不触发布局。改内边距会让同一行里的邻居跟着动，
       * 而按钮组的邻居一动就是「整排按钮在跳」。
       *
       * ## 为什么**不能**让命中区跟着缩小
       *
       * `transform:scale` 只改**绘制**，不改命中区（命中区仍是布局盒）——
       * 这正是想要的：视觉上按下去，手指/指针的判定范围不变。
       * 若改成 `width` 就会把命中区缩掉，快速连点时第二下会落空（E3.35）。
       *
       * ## 为什么用 `:where()`
       *
       * 特异性压到 0，好让各控件自己的 `:active`（比如 `.dshpz-close:active`
       * 的 `translateY(0)`）**不被压掉**——那条要表达的是「落下去」，与本条
       * 的内收是两个不同的动作，可以叠加。
       */
      ':where(.dshpz-act,.dshpz-btn,.dshpz-close,.dshpz-tile,.dshpz-projectrow,.dshpz-tcard,.dshpz-brainbtn,.dshpz-wsrow,.dshpz-boardtab,.dshpz-sechead,.dshpz-seg button):active{transform:scale(.97);transition-duration:80ms}',
      ':where(.dshpz-act,.dshpz-btn,.dshpz-close,.dshpz-tile,.dshpz-projectrow,.dshpz-tcard,.dshpz-brainbtn,.dshpz-wsrow,.dshpz-boardtab,.dshpz-sechead,.dshpz-seg button){transition:transform var(--dshpz-dur-fast) var(--dshpz-ease-out)}',
      /**
       * 禁用态**不播按压**：按一个禁用的按钮有反馈，会让人以为它其实能用。
       * （`disabled` 元素本来就不触发 `:active`，但 `.dshpz-brainbtn` 这类
       * 用 `data-*` 表达禁用的控件需要显式排除。）
       */
      ':where(.dshpz-brainbtn:disabled,.dshpz-act[disabled]):active{transform:none}',

      /* ------------------------- ④ 分段控件的选中指示器 ------------------------- */
      /**
       * ## 旧版的选中态是「换底色」
       *
       * 切页时选中的那格**瞬间**变亮——没有过程。用户按了「主题」，
       * 眼睛还没来得及从「项目」移开，选中态就已经在「主题」上了。
       * 那一下是**跳**的，而并列导航的选中态本该像一根滑块**移过去**。
       *
       * ## 改法：底色 + 一条会滑的底线
       *
       * 每格自带一条 `::after` 底线，选中时从中间向两侧展开（`scaleX 0 → 1`）。
       * 用 `scaleX` 而不是 `width`：只有前者不触发布局（E7）。
       *
       * 为什么不真做「一根绝对定位的滑块在格与格之间平移」：
       * 那需要 JS 量每格宽度并在切换时算位移，而这里三格的宽度由文字决定、
       * 会随字体与语言变化——为了 200ms 的滑动去维护一套测量逻辑，
       * 换来的只是「滑块从 A 滑到 B」而不是「A 收、B 展」。
       * 后者的观感差别很小，而它**零测量、零状态**。
       */
      '.dshpz-seg button{position:relative}',
      '.dshpz-seg button::after{content:"";position:absolute;left:8px;right:8px;bottom:2px;height:2px;border-radius:2px;background:currentColor;opacity:0;transform:scaleX(.2);transform-origin:center;transition:opacity var(--dshpz-dur-fast) var(--dshpz-ease-out),transform var(--dshpz-dur-fast) var(--dshpz-ease-out)}',
      '.dshpz-seg button[data-on="1"]::after{opacity:.85;transform:scaleX(1)}',
      /**
       * ⚠️ 主视图那一套（`.dshpz-seg-main`）**不要**这条底线：
       * 它的选中态已经是「主色实心 + 发光」，再加一条线就是三重强调，
       * 而顶栏是整块面板最该干净的地方（E4.4「同一件事只用一个信号」）。
       */
      '.dshpz-seg-main button::after{display:none}',

      /* ------------------------- ⑤ 数值滚动（健康性主读数） ------------------------- */
      /**
       * ## 为什么主读数需要它
       *
       * 「健康性 82%」是这一屏唯一的结论性数字（见 `.dshpz-ring` 那段）。
       * 而它随文档改动而变——改完文档切回来，数字**直接换掉**，
       * 用户得先记住刚才那个数才知道变了多少。
       *
       * 数字滚动把「变了」这件事说出来：从旧值爬到新值的过程里，
       * 眼睛看到的是「它在动」，于是「它变了」不需要再比对。
       *
       * ## 为什么不用逐位竖条（E2.3 的「数字滚动」）
       *
       * 那个机制适合**金额与计数器**（位数固定、需要「落定」感）。
       * 这里是一个 0–100 的百分数，逐位竖条会带来两个多余的东西：
       *   - 十位与个位分别滚，中间会出现「8→9 十位在动、个位还在动」的
       *     半成品读数（比如显示 79 而真实是 82），**读数是业务值，不能中途说谎**；
       *   - 竖条需要额外的 DOM 结构与对齐约束（E4.3.2 记过边框破坏步长对齐）。
       *
       * 所以这里用最朴素的**整数爬升**：显示的始终是一个**曾经真实存在过的值**，
       * 中途不编造、不越界。这也满足「进度类属性只用单调曲线」那条。
       *
       * ⚠️ 与环形的 `stroke-dashoffset` 过渡**共用同一个进度**（见 `heroRing`）：
       * 数字与圆环必须同步到同一刻，否则「数字到了 82、环还在 70」。
       */
      '.dshpz-ringnum{font-variant-numeric:tabular-nums}',

      /* ------------------------- ⑥ 拖拽：拿在手上的重量 ------------------------- */
      /**
       * ## 旧版拖拽缺的是「重量」
       *
       * 手上那张卡（`.dshpz-cardghost`）跟手跟得很准，微摇动也有（v2.4.5）。
       * 但它**从头到尾长得跟板上那张一模一样**——没有任何「它被抬起来了」的
       * 视觉差异。用户看到的是「一张卡跟着我动」，而不是「我拿起了一张卡」。
       *
       * 补两件事，都是极轻的：
       *   1. **抬起时略放大**（1.015）：距离眼睛近了；
       *   2. **投影变远变散**：光源在上方，东西抬高了影子就散开。
       *
       * ## 为什么幅度这么小
       *
       * 幅度大了会变成「卡片在弹跳」。这里要表达的是**重量**，不是「活泼」。
       * 1.015 在 200px 宽的卡上约等于 3px——刚好够被感知，不够被注意。
       *
       * ⚠️ 缩放写在**外层**（定位层）还是**内层**（摇动层）？
       * 必须写在**内层**：外层用 `transform:translate()` 定位（见 `ghostAt`），
       * 同一个元素上两条 `transform` 会互相覆盖——那正是 `ghostGrab` 分两层的原因。
       * 所以内层同时承担「摇动」与「抬起」，两者合成一个 `transform`。
       */
      '.dshpz-cardghost{filter:drop-shadow(0 12px 20px rgba(0,0,0,.34))}',
      /**
       * ## 抬起时的放大**必须由 JS 合成进外层 `transform`**，不能用 CSS 加
       *
       * 第一版这里写的是 `.dshpz-cardghost[data-lift="1"] > * { transform:scale(1.015) }`
       * ——**那条规则是死的，而且死得很隐蔽**：
       *
       * 内层同时挂着 `.dshpz-cardsway`，那条关键帧动画写的也是 `transform`
       * （`rotate(...) translateX(...)`）。CSS 里**动画的优先级高于普通声明**，
       * 所以只要摇动在播，那条 `scale` 就永远不生效；而摇动恰好在
       * 「拿着」的**全程**都在播——于是放大**一次都不会出现**。
       *
       * 这正是本仓那条纪律的又一个实例（`ghostGrab` 分两层的原因）：
       * **两个动效抢同一个属性时，不是去调优先级，而是让它们落在不同元素上**
       * 或者**由同一处合成**。这里选后者：外层的 `transform` 本来由
       * `ghostAt()` 独占写入，让它顺带把 `scale` 拼进去，就只有一处在写。
       *
       * 所以下面**没有** `data-lift` 的样式规则——那个属性只是给测试与调试
       * 一个可读的标记（「现在是不是抬着」），真正干活的是 `ghostAt`。
       */

      /* ------------------------- ⑦ 减少动效：逐条给终态 ------------------------- */
      /**
       * ⚠️ 这一条**必须排在所有动效规则之后**（它在文件末尾附近）。
       *
       * 它已经在下面那段 `prefers-reduced-motion` 里统一处理了「全部关掉」。
       * 但「全部关掉」有一个副作用：**依赖动画来表达的信息会一起消失**。
       * 比如：
       *   - `.dshpz-page` 的进场被关掉 → 页面照常出现（没问题，它本来就有终态）；
       *   - `.dshpz-cardtravel` 的飞行被关掉 → 卡直接在新列（**没问题**，
       *     卡的位置就是业务事实，动画只是解释）；
       *   - `.dshpz-seg button::after` 的底线被关掉 → **有问题**：
       *     它的 `opacity` 终态是 1，但 `transition:none` 不影响终态值，
       *     所以选中格仍然有线。**这条不需要额外处理**。
       *
       * 结论：本版的动效**全部**只解释过程、不承载信息，所以统一关掉是安全的。
       * 这条注释留在这里，是为了让下一个人加动效时先回答同一个问题：
       * **关掉它，用户会不会漏掉一件事？** 会 → 那件事不能只靠动画表达。
       */
      // 面板：玻璃底 + 网格纹理 + 顶部一道主色高光。网格用 repeating-linear-gradient 纯 CSS 画，不引图片。
      // **宽度与高度先给纯 CSS 2.1 的写法，再用 min() 覆盖**：`min()` 不认时前面的声明仍然生效，
      // 面板至少是「一屏宽、不超视口高」，而不是退化成内容宽度把三栏挤成一团。
      /**
       * 面板外壳（v2.1.1 改成**铺满主区**）。
       *
       * ## 为什么去掉 `max-width` / 居中 / 圆角
       *
       * v2.0.0 的面板住在 `main` 槽位里——**它就是主区本身**，不再是浮在遮罩上的
       * 一块卡片。可上一版仍留着「浮层时代」的尺度：`max-width:1240px`、
       * `max-height:88vh`、圆角 + 投影。结果是主区里孤零零一块小卡片，
       * 四周全是空——用户原话「面板没有完全平铺在会话框」。
       *
       * 现在按主区容器算账：宽高都吃满、不要圆角与投影（贴边的东西不需要阴影），
       * 只留玻璃底与描边。`min-height` 兜住一个下限：宿主若给不出高度
       * （`height:100%` 在 auto 父级上退化成 auto），面板不至于被内容压成一条。
       *
       * ⚠️ `border` 只留上/下：左右贴边时那两条线是多余的，而且会在
       * 「主区背景与面板底色不完全一致」时露出一道缝。
       */
      '.dshpz-host{position:relative;display:flex;flex-direction:column;height:100%;min-height:0}',
      '.dshpz-panel{position:relative;flex:1 1 auto;width:100%;min-height:min(88vh,940px);display:flex;flex-direction:column;overflow:hidden;background-color:var(--dshpz-glass);background-image:var(--dshpz-glass-sheen);color:var(--dshpz-label-1);border-top:1px solid var(--dshpz-border-2);border-bottom:1px solid var(--dshpz-border-2);border-radius:0;box-shadow:none;font-family:var(--dshpz-font-ui);font-size:14px;animation:dshpz-rise var(--dshpz-dur-in) var(--dshpz-ease-out)}',
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
      //
      // blur 18px → **24px**（v1.0.0「把玻璃做实」）：18px 在深色对话底上只够
      // 把文字糊掉，看不出「玻璃」；24px 才让背后的内容变成一片柔和的光影，
      // 那是液态玻璃的辨识度来源。`saturate(1.2)` 保留——它让透过来的颜色更活。
      '@supports ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.dshpz-panel{backdrop-filter:blur(24px) saturate(1.35);-webkit-backdrop-filter:blur(24px) saturate(1.35)}}',
      '@supports (color:color-mix(in srgb,red 50%,blue)){.dshpz-panel{background-color:color-mix(in srgb,var(--dshpz-glass) 86%,transparent)}}',
      // 网格层：默认主题已把 `--dshpz-grid` 归零，所以这一层画不出东西（规则保留，
      // 主题改回网格色它就会重新出现）。`mask-image` 保留同理。
      '.dshpz-panel::before{content:"";position:absolute;top:0;right:0;bottom:0;left:0;pointer-events:none;background-image:linear-gradient(var(--dshpz-grid) 1px,transparent 1px),linear-gradient(90deg,var(--dshpz-grid) 1px,transparent 1px);background-size:34px 34px;mask-image:radial-gradient(120% 90% at 50% 0,#000 30%,transparent 78%);-webkit-mask-image:radial-gradient(120% 90% at 50% 0,#000 30%,transparent 78%)}',
      /**
       * 顶边高光：**液态玻璃的招牌**（v1.0.0 把原来的彩色扫描线换成它）。
       *
       * 原来的写法是 `linear-gradient(90deg,transparent,var(--dshpz-accent),transparent)`
       * ——一条彩色扫描线，那是科幻 HUD 的语言。玻璃的边不是彩色的，而是
       * 「光从上方打下来，上边缘被照亮」：中间最亮、两头渐隐的**白色**细线。
       *
       * 为什么不用 `color-mix` 调主色：玻璃的高光与主色无关，用白色才像光。
       * `opacity` 压到 .5 是刻意的——再亮就成了一条白杠，看着像分隔线而不是光。
       */
      '.dshpz-panel::after{content:"";position:absolute;left:8%;right:8%;top:0;height:1px;pointer-events:none;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);opacity:.5}',
      // 面板内所有滚动条统一成细的，避免宿主默认粗条打断视觉。
      '.dshpz-panel *{scrollbar-width:thin;scrollbar-color:var(--dshpz-border-2) transparent}',
      '.dshpz-panel ::-webkit-scrollbar{width:8px;height:8px}',
      '.dshpz-panel ::-webkit-scrollbar-thumb{background:var(--dshpz-border-2);border-radius:99px}',

      /* --------------------------------- 页头 --------------------------------- */
      /**
       * 顶栏：**独立成条 + 吸顶**（v2.1.1，用户拍板「铺满 + 顶栏吸顶独立成条」）。
       *
       * ## 为什么它必须独立成一条
       *
       * 面板铺满主区之后，内容区会很长（项目列表 + 派单设置 + 三个模型）。
       * 顶栏跟着一起滚走，用户就**再也切不回主题页**——而切换控件就在顶栏里，
       * 那正是他上一个 bug 的同一类症状（「切换无用」）。
       *
       * `position:sticky` + `top:0` 而不是 `position:fixed`：面板本身可能是
       * 主区里的一块（窄屏 / 宿主给的容器有 padding），`fixed` 会脱离那条容器
       * 贴到视口上去。sticky 只在**它自己的滚动容器**里吸顶，这正是要的语义。
       *
       * ⚠️ `z-index` 要给：内容里有 `.dshpz-tile:hover` 的投影与 `data-on` 的发光，
       * 不给的话滚上来的卡片会盖住顶栏的一部分。
       */
      '.dshpz-head{position:sticky;top:0;z-index:5;flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--dshpz-border-2);background:var(--dshpz-glass);background-image:var(--dshpz-head-sheen);backdrop-filter:blur(14px) saturate(1.3);-webkit-backdrop-filter:blur(14px) saturate(1.3);box-shadow:0 1px 0 0 color-mix(in srgb,var(--dshpz-accent) 26%,transparent)}',
      '.dshpz-logo{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;color:var(--dshpz-on-accent);background:linear-gradient(135deg,var(--dshpz-accent-hi),var(--dshpz-accent));box-shadow:0 0 16px -3px var(--dshpz-accent)}',
      '.dshpz-headtext{flex:1 1 auto;min-width:0}',
      '.dshpz-title{margin:0;font-size:17px;font-weight:700;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshpz-sub{font-size:11.5px;color:var(--dshpz-label-2);margin-top:2px;font-family:var(--dshpz-font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshpz-close{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);background:transparent;color:var(--dshpz-label-2);cursor:pointer;transition:color var(--dshpz-dur-fast) var(--dshpz-ease-std),border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),transform var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-close:hover{color:var(--dshpz-label-1);border-color:var(--dshpz-border-2);transform:translateY(-1px)}',
      // v2.4.17：同 `.dshpz-act:active`——取消抬起与按下的内收必须在同一条里合成。
      '.dshpz-close:active{transform:translateY(0) scale(.94);transition-duration:80ms}',
      // 有新版时的角标（v1.0.0）：用户不会没事点进更新页看版本号，
      // 所以这是「有新版本」这件事唯一会被注意到的入口。用主色实心点，
      // 而不是加个数字——数字会让人以为要处理 N 件事，实际只有一件。
      '.dshpz-close[data-alert="1"]{position:relative;color:var(--dshpz-accent)}',
      '.dshpz-close[data-alert="1"]::after{content:"";position:absolute;top:-2px;right:-2px;width:7px;height:7px;border-radius:99px;background:var(--dshpz-accent);box-shadow:0 0 0 2px var(--dshpz-glass),0 0 10px -1px var(--dshpz-accent)}',
      // 更新日志与安装命令：等宽、可滚动、限高。用 pre 是因为零依赖下不引 markdown 解析器。
      '.dshpz-pre{margin:6px 0;padding:10px 12px;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);background:color-mix(in srgb,var(--dshpz-bg-3) 60%,transparent);font-family:var(--dshpz-font-mono);font-size:11.5px;line-height:1.7;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;color:var(--dshpz-label-2)}',
      '.dshpz-notes{max-height:420px}',
      // 主题开发区（v1.0.0）：与主题卡片网格分开的一块，顶部一条分隔线。
      '.dshpz-tdev{flex:0 0 auto;padding:12px 16px 4px;border-top:1px solid var(--dshpz-border-1)}',
      '.dshpz-tdevrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0}',
      '.dshpz-tinput{flex:1 1 220px;min-width:160px;padding:7px 10px;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);background:color-mix(in srgb,var(--dshpz-bg-3) 55%,transparent);color:var(--dshpz-label-1);font-family:var(--dshpz-font-ui);font-size:12px}',
      '.dshpz-tinput:focus{outline:none;border-color:var(--dshpz-accent);box-shadow:var(--dshpz-glow)}',
      // 主题包文本框：等宽、限高、可滚动（一份包可能几百 KB，不能把面板撑开）。
      '.dshpz-tpack{width:100%;box-sizing:border-box;margin:6px 0;padding:9px 11px;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);background:color-mix(in srgb,var(--dshpz-bg-3) 55%,transparent);color:var(--dshpz-label-2);font-family:var(--dshpz-font-mono);font-size:11px;line-height:1.6;resize:vertical;max-height:200px}',
      '.dshpz-tpack:focus{outline:none;border-color:var(--dshpz-accent)}',
      // 各版本更新日志（v1.0.1）：每版一块，行高紧凑——用户要的是「一屏看很多版」。
      // 不画卡片、不加投影：那是「一大堆字」的视觉版本，列表越素越像日志。
      '.dshpz-rel{display:flex;flex-direction:column;gap:2px;margin:6px 0}',
      '.dshpz-relrow{padding:8px 10px;border-radius:var(--dshpz-radius-sm);border-left:2px solid transparent}',
      '.dshpz-relrow[data-cur="1"]{border-left-color:var(--dshpz-accent);background:color-mix(in srgb,var(--dshpz-accent) 7%,transparent)}',
      '.dshpz-relhead{display:flex;align-items:center;gap:7px;flex-wrap:wrap}',
      '.dshpz-relver{font-family:var(--dshpz-font-mono);font-size:12px;font-weight:600;color:var(--dshpz-label-1)}',
      '.dshpz-relname{font-size:12px;color:var(--dshpz-label-2);flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshpz-reldate{font-family:var(--dshpz-font-mono);font-size:10.5px;color:var(--dshpz-label-3)}',
      // 摘要：最多 3 行，超出由宿主半截断并附一句「还有 N 行」。
      '.dshpz-relsum{margin-top:3px;font-size:11.5px;line-height:1.6;color:var(--dshpz-label-2)}',

      /* ------------------------------ 三栏工作台 ------------------------------ */
      // 二级页正文（v2.1.1：**三栏改两栏**）。
      //
      // 用户裁定删掉最左栏，于是列宽从 264/自适应/424 改成 **自适应/424**。
      // 少一栏之后每栏都变宽，原来挤成一团的文字自然松开了。
      //
      // **先给纯 CSS 2.1 的固定两列，再用 minmax 覆盖**（沿用 v0.16.2 那条教训）：
      // `minmax()` 一旦整条被丢弃，两栏会退化成「一列挤两份内容」——列与列**重叠**。
      // 固定列宽在窄屏本来就会被 `@media` 换成块级，所以这层兜底没有副作用。
      '.dshpz-body{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:auto 424px;grid-template-columns:minmax(0,1fr) 424px;gap:0}',
      // 正文外面那层：项目条 + 告警 + 两栏正文，纵向排。
      '.dshpz-bodywrap{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}',
      // 项目条：身份信息（项目名 + 路径）与「主文档」入口横着放一行，不占一整栏。
      '.dshpz-projbar{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:1px solid var(--dshpz-border-1);background:var(--dshpz-bg-1)}',
      '.dshpz-projbaricon{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:9px;color:var(--dshpz-on-accent);background:linear-gradient(135deg,var(--dshpz-accent-hi),var(--dshpz-accent));box-shadow:0 0 14px -4px var(--dshpz-accent)}',
      '.dshpz-projbartext{flex:1 1 auto;min-width:0}',
      '.dshpz-projbar .dshpz-projectname{font-size:15px}',
      '.dshpz-projbar .dshpz-docpath{margin-top:2px;font-size:11.5px}',
      '.dshpz-col{min-width:0;overflow:auto;padding:20px 22px}',
      '.dshpz-col + .dshpz-col{border-left:1px solid var(--dshpz-border-1)}',
      // 单栏堆叠时（手机/窄窗）取消分栏与左边框，回到纵向流。
      // 同时**收起页头的健康性徽标**：窄屏上它会和副标题挤成两行，
      // 而左栏的环形总览本来就把这个数字放得更大——重复且更差。
      //
      // 手机端滑不动的原因（实测）：窄屏把 `.dshpz-col` 改成 `overflow:visible` 后，
      // 两栏内容整体高度**超出** `.dshpz-body`（`flex:1 1 auto;min-height:0`），
      // 而面板是 `overflow:hidden` —— 多出来的部分被裁掉，
      // 里面又没有可滚动容器，于是手指往上推什么也不动。
      // 修法：窄屏把 `.dshpz-body` 从 grid 换成块级并**自己滚动**（`overflow-y:auto`），
      // 页头仍然 `flex:0 0 auto` 钉在顶部；`overscroll-behavior:contain` 防止
      // 滑到底后把滚动链传给宿主页面（那会让面板被拖走）。
      '@media (max-width:900px){.dshpz-body{display:block;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}.dshpz-bodywrap{overflow:hidden}.dshpz-col{overflow:visible}.dshpz-col + .dshpz-col{border-left:0;border-top:1px solid var(--dshpz-border-1)}.dshpz-panel{min-height:92vh}.dshpz-backdrop{padding:10px}.dshpz-head .dshpz-heroval{display:none}.dshpz-projbar{flex-wrap:wrap}}',

      /* -------------------------------- 区块 -------------------------------- */
      /**
       * 区块（v2.1.1 改成**卡片**）：铺满主区之后，一列平铺的文字在超宽屏上会散开，
       * 区块之间也看不出边界。给每个区块一层淡底 + 描边，边界一眼可见。
       *
       * ⚠️ 只给**单列布局**（`.dshpz-body-single`：一级页与二级派单子页）加卡片：
       * 二级「文档信息」页的两栏本来就有列分隔，再加一层卡片会变成「框里套框」。
       *
       * ⚠️ **v2.1.1 重新设计**：用户报「看着不舒服、太小了、醒目的元素不多、突出不了重点」。
       * 这一版整体把尺度与对比度提上去（字号 +1、间距加大、标题加粗加高、
       * 主读数放大近一倍），而不是只换配色——换配色不解决「小」。
       */
      '.dshpz-sect{margin-top:20px}',
      '.dshpz-sect:first-child{margin-top:0}',
      '.dshpz-body-single .dshpz-sect{margin-top:16px;padding:16px 18px;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-md);background:var(--dshpz-bg-1)}',
      '.dshpz-body-single .dshpz-sect:first-child{margin-top:0}',
      /**
       * 小节标题：左侧一道主色竖条 + 等宽大写，是 HUD 的「分区标牌」。
       *
       * v2.1.1 放大：字号 11 → 13.5、竖条 2px×11 → 4px×17、字重 600 → 700、
       * 颜色一律用一级文字色（原先二级页标题是灰的，在深色底上几乎看不见——
       * 「突出不了重点」有一半是它造成的）。竖条改用主色实心 + 发光，
       * 它现在是整块里最醒目的定位锚点。
       */
      '.dshpz-secttitle{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:700;letter-spacing:.5px;color:var(--dshpz-label-1);margin-bottom:14px}',
      '.dshpz-secttitle::before{content:"";flex:0 0 auto;width:4px;height:19px;border-radius:2px;background:linear-gradient(180deg,var(--dshpz-accent-hi),var(--dshpz-accent-lo));box-shadow:0 0 8px -1px var(--dshpz-accent)}',
      '.dshpz-secttitle .dshpz-count{margin-left:auto;font-family:var(--dshpz-font-mono);font-size:12.5px;color:var(--dshpz-label-2);letter-spacing:0;font-weight:500}',

      /* -------------------------------- 控件 -------------------------------- */
      '.dshpz-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);background:transparent;color:var(--dshpz-label-2);cursor:pointer;font-size:12px;line-height:1;font-family:inherit;transition:color var(--dshpz-dur-fast) var(--dshpz-ease-std),border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),background var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-btn:hover{color:var(--dshpz-label-1);border-color:var(--dshpz-border-2);background:var(--dshpz-bg-2)}',
      '.dshpz-btn[data-on="1"]{color:var(--dshpz-accent);border-color:var(--dshpz-accent);box-shadow:var(--dshpz-glow)}',
      // 主按钮：唯一使用实心主色的控件，用来标记「这一步是主动作」。
      '.dshpz-act{display:inline-flex;align-items:center;gap:5px;background:transparent;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);color:var(--dshpz-label-2);padding:5px 10px;font-size:12px;cursor:pointer;font-family:inherit;line-height:1.2;text-align:left;transition:color var(--dshpz-dur-fast) var(--dshpz-ease-std),border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),background var(--dshpz-dur-fast) var(--dshpz-ease-std),transform var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-act:hover{color:var(--dshpz-label-1);border-color:var(--dshpz-border-2);background:var(--dshpz-bg-2);transform:translateY(-1px)}',
      /**
       * ⚠️ v2.4.17：按下时**必须把 hover 的抬起与按下的内收合成一个 transform**。
       *
       * 原先这一条是 `transform:translateY(0)`——只「取消抬起」，没有任何按压感。
       * 本次想给它加 `scale(.97)`，但第一版加在了 `:where(...)` 那条通用规则里，
       * 结果**完全不生效**：`:where()` 把特异性压到 0，而这条 `.dshpz-act:active`
       * 是 0,2,0——后者赢，`translateY(0)` 把 `scale` 整个盖掉。
       *
       * 这是**真机验证抓到的**（冒烟里的静态断言看不出特异性竞争）：
       * 按下时读到的 `scale` 是 1.000，纹丝不动。
       *
       * 修法：在**这条**规则里写完整姿态（既取消抬起、又内收），
       * 而不是指望另一条低特异性规则来叠加。同一个属性只能有一处说了算。
       */
      '.dshpz-act:active{transform:translateY(0) scale(.97);transition-duration:80ms}',
      '.dshpz-act[data-on="1"]{color:var(--dshpz-accent);border-color:var(--dshpz-accent);background:color-mix(in srgb,var(--dshpz-accent) 12%,transparent);box-shadow:var(--dshpz-glow)}',
      '.dshpz-act[data-tone="danger"]:hover{color:var(--dshpz-err);border-color:var(--dshpz-err)}',
      '.dshpz-acts{display:flex;flex-wrap:wrap;gap:6px}',
      // 横向一组按钮（规模三档）：等宽铺开，选中态用 data-on 高亮。
      '.dshpz-acts-horiz{display:flex;flex-direction:row;gap:6px}',
      '.dshpz-acts-horiz .dshpz-act{flex:1 1 0;justify-content:center}',
      '.dshpz-acts-horiz .dshpz-act[data-on="1"]{outline:1px solid currentColor;font-weight:600}',
      '.dshpz-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      // 正文基准字号 12 → 13（v2.1.1「太小了」）。它影响所有没显式定字号的地方，
      // 所以这是「整体放大」最省事也最一致的一处；说明性文字仍比正文小一号。
      '.dshpz-muted{color:var(--dshpz-label-2);font-size:13px;line-height:1.6}',
      '.dshpz-mono{font-family:var(--dshpz-font-mono);font-size:12px}',

      /* ------------------------------- 健康性总览 ------------------------------- */
      /**
       * 大数字 + 环形进度：整块面板的「主读数」。
       *
       * v2.1.1 放大：这是全页唯一的**结论性数字**，原先 74px 的环 + 13px 的评语
       * 混在一堆同尺寸文字里，看不出它是主角。现在环 74 → 104px、数字 19 → 30px、
       * 评语 13 → 17px 加粗，并给它更厚的描边与更亮的渐变底。
       */
      '.dshpz-hero{display:flex;align-items:center;gap:20px;padding:18px 20px;border:1px solid color-mix(in srgb,var(--dshpz-accent) 30%,var(--dshpz-border-1));border-radius:var(--dshpz-radius-md);background:linear-gradient(135deg,color-mix(in srgb,var(--dshpz-accent) 14%,transparent),transparent 62%);box-shadow:0 10px 30px -22px var(--dshpz-accent)}',
      '.dshpz-ring{flex:0 0 auto;position:relative;width:104px;height:104px}',
      '.dshpz-ring svg{display:block;transform:rotate(-90deg)}',
      '.dshpz-ringcircle{fill:none;stroke:var(--dshpz-bg-3);stroke-width:9}',
      '.dshpz-ringfill{fill:none;stroke:url(#dshpz-ringgrad);stroke-width:9;stroke-linecap:round;transition:stroke-dashoffset var(--dshpz-dur-slow) var(--dshpz-ease-out)}',
      '.dshpz-ringnum{position:absolute;top:0;right:0;bottom:0;left:0;display:flex;align-items:center;justify-content:center;font-family:var(--dshpz-font-mono);font-size:30px;font-weight:700;color:var(--dshpz-label-1);text-shadow:0 0 18px color-mix(in srgb,var(--dshpz-accent) 55%,transparent)}',
      '.dshpz-herotext{min-width:0}',
      '.dshpz-herolabel{font-size:12px;letter-spacing:1.1px;font-weight:600;color:var(--dshpz-label-2)}',
      '.dshpz-heroval{font-size:17px;font-weight:650;color:var(--dshpz-label-1);margin-top:4px;line-height:1.35}',

      /* --------------------------------- 五维 --------------------------------- */
      // v2.1.2：名字 13 → 14px、行距 10 → 12px、条厚 10 → 12px。
      // 用户在这一屏上同时报了「太小了」，五维那五行与下面的条目卡是一整块内容，
      // 只放大条目、不放大它们，两块会明显不搭。
      '.dshpz-dims{display:flex;flex-direction:column;gap:12px}',
      '.dshpz-dim{display:grid;grid-template-columns:104px minmax(0,1fr) 66px;align-items:center;gap:12px;font-size:14px}',
      '.dshpz-dimname{color:var(--dshpz-label-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      // 进度条加厚（6 → 10 → 12px）：细条在大屏上几乎看不见，「醒目」的第一条就是它。
      '.dshpz-dimbar{position:relative;height:12px;border-radius:99px;background:var(--dshpz-bg-3);overflow:hidden}',
      '.dshpz-dimfill{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--dshpz-accent-lo),var(--dshpz-accent-hi));transform-origin:left;animation:dshpz-grow var(--dshpz-dur-slow) var(--dshpz-ease-out)}',
      // 真实值对照行：名字 / 声明→实测 / 差额标签。**与 .dshpz-dim 分开**——
      // 两者子元素个数不同（这里是 3 列对照，上面是「名字+条+值」），
      // 硬塞进同一个 grid 模板会让其中一边错位。
      '.dshpz-dimcmp{display:grid;grid-template-columns:82px minmax(0,1fr) auto;align-items:center;gap:9px;font-size:12px}',
      '.dshpz-dimcmp .dshpz-dimbar{grid-column:2 / -1}',
      '.dshpz-dimpair{display:inline-flex;align-items:baseline;gap:6px;font-family:var(--dshpz-font-mono);font-size:11px;color:var(--dshpz-label-2)}',
      // 真实值用一层半透明的「第二段」压在声明值上，直接看出虚高多少。
      '.dshpz-dimtrue{position:absolute;left:0;top:0;height:100%;border-radius:99px;background:color-mix(in srgb,var(--dshpz-warn) 70%,transparent)}',
      '.dshpz-dimval{text-align:right;font-family:var(--dshpz-font-mono);font-size:12.5px;color:var(--dshpz-label-2);white-space:nowrap}',
      '.dshpz-dimval[data-true="1"]{color:var(--dshpz-accent);font-weight:700}',
      '.dshpz-dimcmp[data-bad="1"] .dshpz-dimval[data-true="1"]{color:var(--dshpz-err)}',
      '.dshpz-arrow{color:var(--dshpz-label-3);font-size:10px}',
      '.dshpz-dimnote{grid-column:1 / -1;color:var(--dshpz-label-3);font-size:10px;line-height:1.35;margin-top:-2px}',

      /* -------------------------------- 模块卡 -------------------------------- */
      /**
       * 模块卡：v2.1.1 放大（126px → 158px 起、84 → 108px 高），名字 12 → 14px 加粗、
       * 百分比 10 → 17px。原来一格卡里最该看的两个数（模块名、健康性）
       * 是全页最小的字，那正是「突出不了重点」。
       */
      '.dshpz-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:12px}',
      '.dshpz-tile{position:relative;display:flex;flex-direction:column;gap:8px;min-height:108px;padding:13px;text-align:left;color:inherit;font:inherit;cursor:pointer;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-md);background:var(--dshpz-bg-1);overflow:hidden;transition:border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),transform var(--dshpz-dur-fast) var(--dshpz-ease-std),box-shadow var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      // 悬停时卡片抬 1px + 出现主色边——比整块变色克制，也更像「可点」。
      '.dshpz-tile:hover{border-color:var(--dshpz-accent);transform:translateY(-2px);box-shadow:0 10px 24px -14px var(--dshpz-accent)}',
      '.dshpz-tile[data-on="1"]{border-color:var(--dshpz-accent);box-shadow:var(--dshpz-glow)}',
      '.dshpz-tile[data-empty="1"]{opacity:.45}',
      '.dshpz-tile[data-static="1"]{cursor:default}',
      '.dshpz-tile b{font-size:14px;font-weight:650;line-height:1.3;word-break:break-word}',
      '.dshpz-tilebar{height:6px;border-radius:99px;background:var(--dshpz-bg-3);overflow:hidden}',
      '.dshpz-tilefill{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--dshpz-ok),var(--dshpz-accent-hi));transform-origin:left;animation:dshpz-grow var(--dshpz-dur-in) var(--dshpz-ease-out)}',
      '.dshpz-pct{font-family:var(--dshpz-font-mono);font-size:12px;color:var(--dshpz-label-2)}',
      // 卡片里那个**大百分比**：它是每张卡的主读数，单独放大（其余 .dshpz-pct 保持小字）。
      '.dshpz-tilescore{font-family:var(--dshpz-font-mono);font-size:19px;font-weight:700;color:var(--dshpz-label-1);line-height:1}',
      '.dshpz-tilescore[data-empty="1"]{font-size:13px;color:var(--dshpz-label-3);font-weight:500}',

      /* ------------------------------- 分段控件 ------------------------------- */
      '.dshpz-seg{display:inline-flex;border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);overflow:hidden;background:var(--dshpz-bg-1)}',
      '.dshpz-seg button{background:transparent;border:0;color:var(--dshpz-label-2);padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit;transition:background var(--dshpz-dur-fast) var(--dshpz-ease-std),color var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-seg button:hover{color:var(--dshpz-label-1);background:var(--dshpz-bg-2)}',
      '.dshpz-seg button[data-on="1"]{background:linear-gradient(135deg,var(--dshpz-accent),var(--dshpz-accent-lo));color:var(--dshpz-on-accent);font-weight:600}',
      /**
       * 主视图切换控件（`viewTabs`）比二级子页那一套**更显眼**（v2.1.1，用户要「醒目一点」）。
       *
       * 三处差别，都是为了「一眼看出这是可以点、且我现在在哪一页」：
       *   1. 更粗的描边 + 主色底 → 在一整条顶栏里跳出来；
       *   2. 选中项加发光（`--dshpz-glow`）——顶栏是吸顶的纯色条，
       *      只靠填充色在老显示器上分不清哪颗是按下的；
       *   3. 更大的内边距：它是面板的主导航，不该与旁边的「刷新」图标按钮同尺寸。
       */
      '.dshpz-seg-main{border-color:color-mix(in srgb,var(--dshpz-accent) 38%,var(--dshpz-border-1));background:color-mix(in srgb,var(--dshpz-accent) 9%,transparent)}',
      '.dshpz-seg-main button{padding:7px 16px;font-size:13px;font-weight:500}',
      '.dshpz-seg-main button[data-on="1"]{box-shadow:var(--dshpz-glow)}',

      /* -------------------------------- 提示条 -------------------------------- */
      '.dshpz-notice{display:flex;gap:7px;align-items:flex-start;margin:10px 0 0;padding:8px 10px;border:1px solid color-mix(in srgb,var(--dshpz-accent) 45%,transparent);border-radius:var(--dshpz-radius-sm);background:color-mix(in srgb,var(--dshpz-accent) 10%,transparent);color:var(--dshpz-label-1);font-size:12px;line-height:1.45}',
      '.dshpz-err{display:flex;gap:7px;align-items:flex-start;margin:10px 0 0;padding:8px 10px;border:1px solid color-mix(in srgb,var(--dshpz-err) 50%,transparent);border-radius:var(--dshpz-radius-sm);background:color-mix(in srgb,var(--dshpz-err) 10%,transparent);color:var(--dshpz-err);font-size:12px;line-height:1.45}',
      '.dshpz-warn{display:flex;gap:7px;align-items:flex-start;margin:10px 0 0;padding:8px 10px;border:1px solid color-mix(in srgb,var(--dshpz-warn) 50%,transparent);border-radius:var(--dshpz-radius-sm);background:color-mix(in srgb,var(--dshpz-warn) 10%,transparent);color:var(--dshpz-warn);font-size:12px;line-height:1.45}',
      '.dshpz-hint{margin-top:14px;padding-top:12px;border-top:1px solid var(--dshpz-border-1);color:var(--dshpz-label-2);font-size:12px;line-height:1.65}',

      /* --------------------------------- 详情 --------------------------------- */
      /**
       * 二级页的模块标题（「模块 · 名字 · 健康性 69%」）。
       *
       * v2.1.2：13 → 16px、加粗 700、下加一条分隔线。它是整页的标题，
       * 原先却和正文一样大，用户报「突出不了重点」。
       */
      '.dshpz-detail{margin-top:14px;padding:14px 16px;border:1px solid var(--dshpz-border-2);border-radius:var(--dshpz-radius-md);background:var(--dshpz-bg-1)}',
      '.dshpz-detail h4{margin:0 0 14px;padding-bottom:10px;border-bottom:1px solid var(--dshpz-border-1);font-size:16px;font-weight:700;line-height:1.35;display:flex;align-items:center;gap:8px}',

      /* ------------------------------ 条目（书签） ------------------------------ */
      /**
       * 小节标题（「要点 / 悬而未决 / 已定」）。
       *
       * v2.1.2 新增：原先这几段标题只是 13px 灰色说明文字，与条目正文同重，
       * 30 条要点铺开时看不出段落边界。现在是「加粗名字 + 主色计数」的一行。
       */
      '.dshpz-entryhead{display:flex;align-items:baseline;gap:10px;margin:18px 0 10px}',
      '.dshpz-entryhead:first-child{margin-top:0}',
      '.dshpz-entryheadname{font-size:14px;font-weight:700;color:var(--dshpz-label-1)}',
      '.dshpz-entryheadnote{font-family:var(--dshpz-font-mono);font-size:12px;color:var(--dshpz-label-2)}',
      /**
       * **可折叠的小节标题**（v2.1.8，用户要求「给条目加一个默认折叠的功能」）。
       *
       * 标题本身是一颗整行按钮（点哪都能开合，不必精确点到那个箭头），
       * 所以这里要清掉 `button` 的默认外观：背景 / 边框 / 字体 / 内边距。
       * `cursor:pointer` 与 `:hover` 的底色是**可点性的唯一提示**——
       * 折叠态下只看得见标题，没有它用户不会知道这里能点。
       *
       * `text-align:left` 必须显式给：`button` 默认居中，而这一行是左对齐的列表。
       */
      '.dshpz-sechead{display:flex;align-items:baseline;gap:10px;width:100%;box-sizing:border-box;margin:18px 0 10px;padding:6px 8px;font:inherit;text-align:left;background:transparent;border:1px solid transparent;border-radius:var(--dshpz-radius-sm);cursor:pointer;transition:background var(--dshpz-dur-fast) var(--dshpz-ease-std),border-color var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-sechead:hover{background:var(--dshpz-bg-2);border-color:var(--dshpz-border-1)}',
      '.dshpz-sechead:first-child{margin-top:0}',
      /** 开合箭头：折叠 `▸` / 展开 `▾`，固定宽度以免开合时标题左右跳。 */
      '.dshpz-seccaret{flex:0 0 auto;width:12px;color:var(--dshpz-label-3);font-size:11px}',
      /**
       * 折叠态：整组**渲染但隐藏**。
       *
       * 为什么用 CSS 隐藏而不是「不渲染」：条目内容留在树里，
       * 「折叠」就只是视觉动作，不会让下游（含既有测试的树断言）看不到内容；
       * 而且开合是纯 CSS 切换，不必为每次点击重建整棵子树。
       */
      '.dshpz-secbody[data-open="0"]{display:none}',
      /**
       * 条目卡（v2.1.2 再放大 + 描边加深）。
       *
       * 用户报「太小了、那一条条的应该加个边框」。原先 12px 正文 + `--dshpz-border-1`
       * （= 宿主的 `border-l1`，最淡的一档）叠在白底上，边框**在真机截图里根本看不见**，
       * 30 条要点糊成一整块，看不出是一条一条。
       *
       * 三处一起改：字号 12 → 14、行高 1.5 → 1.6、内边距 6/9 → 11/14（条与条之间才有呼吸），
       * 边框换成 `--dshpz-border-3`（宿主的 `border-l3`，12% 黑），左侧那根状态条 3px → 4px。
       * 用 `l2`（10%）试过：在这台机器的浅色主题下仍然几乎看不见，所以取宿主给「需要看清的
       * 描边」留的那一档。
       */
      '.dshpz-entries{display:flex;flex-direction:column;gap:14px;margin:0 0 14px}',
      /**
       * **条目之间的横线**（v2.1.8，用户要求「条目之间加一条横线以凸显重点」）。
       *
       * 为什么用 `::after` 而不是给卡片加 `border-top`：卡片自己已经有四边
       * `border` 与左侧 4px 的强调条。再加 `border-top` 会让**第一张**卡片
       * 顶着一条多余的线（它上面是小节标题），而 `:not(:first-child)` 那种写法
       * 在「组内只有一条」时又完全看不到线。
       *
       * 分隔元素的位置可控：**每条之后**画一条，最后一条不画
       * （它下面是下一节的标题，由标题自己带分隔）。
       * 线的位置取 gap 的**正中**（gap 14px → `bottom:-7px`），这样上下留白均匀。
       * 颜色取 `--dshpz-border-2`（比卡片边框 `border-3` 略重）——横线的目的是
       * 「凸显边界」，用最淡的那一档等于没画。
       */
      '.dshpz-entry{position:relative}',
      '.dshpz-entry:not(:last-child)::after{content:"";position:absolute;left:0;right:0;bottom:-7px;height:1px;background:var(--dshpz-border-2)}',
      '.dshpz-entry{display:flex;align-items:flex-start;gap:10px;font-size:14px;line-height:1.6;background:var(--dshpz-bg-1);border:1px solid var(--dshpz-border-3);border-left-width:4px;border-radius:var(--dshpz-radius-sm);padding:11px 14px;transition:border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),background var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-entry:hover{background:var(--dshpz-bg-2);border-color:var(--dshpz-accent)}',
      '.dshpz-entry[data-bad="1"]{border-left-color:var(--dshpz-warn)}',
      '.dshpz-entry:not([data-bad="1"]){border-left-color:var(--dshpz-accent)}',
      '.dshpz-entrynum{flex:0 0 auto;min-width:22px;font-family:var(--dshpz-font-mono);font-size:12px;color:var(--dshpz-label-2);padding-top:3px}',
      '.dshpz-entrybody{flex:1 1 auto;color:var(--dshpz-label-1);word-break:break-word}',
      '.dshpz-entrysrc{font-family:var(--dshpz-font-mono);color:var(--dshpz-label-2);font-size:12px}',
      '.dshpz-entryflag{flex:0 0 auto;color:var(--dshpz-warn);font-size:11px;white-space:nowrap;border:1px solid color-mix(in srgb,var(--dshpz-warn) 45%,transparent);border-radius:99px;padding:2px 8px}',

      /* --------------------------------- 表单 --------------------------------- */
      '.dshpz-in{display:block;width:100%;box-sizing:border-box;margin-bottom:6px;background:var(--dshpz-bg-1);color:var(--dshpz-label-1);border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);padding:7px 9px;font-size:12px;font-family:inherit;transition:border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),box-shadow var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-in:focus{outline:none;border-color:var(--dshpz-accent);box-shadow:var(--dshpz-glow)}',
      '.dshpz-in::placeholder{color:var(--dshpz-label-3)}',
      '.dshpz-sel{background:var(--dshpz-bg-1);color:var(--dshpz-label-1);border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);padding:6px 8px;font-size:12px;font-family:inherit;max-width:100%}',
      /* ------------------------- 项目列表重排（FLIP，U5 #3） ------------------------- */
      /**
       * FLIP = First（记旧位置）→ Last（改完读新位置）→ Invert（用 `transform`
       * 把元素**先拉回旧位置**）→ Play（过渡到 `transform: none`）。
       *
       * 它**只动 `transform`**，所以不触发逐帧重排——列表 / 看板重排的标准做法。
       * 这三个类就是 FLIP 的三步：JS 负责读位置与设 `transform`，CSS 只给过渡。
       *
       * ⚠️ 为什么不用 CSS 的 `transition: transform` 直接写在行上：
       * 那样**每次 hover 的位移也会被一起过渡**，于是 hover 变得黏糊。
       * 分开一个 `.dshpz-flip` 类，只在重排那一瞬间挂上、动画结束就摘掉。
       */
      '.dshpz-flip{transition:transform var(--dshpz-dur-slow) var(--dshpz-ease-out)}',
      /**
       * 卡片跨列移动的飞入（U5 #12，**全版最重要的一条动效**）。
       *
       * 它解释「卡去哪了」——没有它，卡会「啪」一下出现在另一列，
       * 用户得重新扫一遍整个看板才知道刚才那下点成功了没有。
       */
      '.dshpz-cardfly{animation:dshpz-flyin var(--dshpz-dur-slow) var(--dshpz-ease-out)}',
      '@keyframes dshpz-flyin{from{opacity:.35;transform:scale(.94)}to{opacity:1;transform:none}}',
      /**
       * 「未验收」标记出现时**只脉冲一次**（U5 #17）。
       *
       * ⚠️ 明确**不 infinite**：看板上多张卡同时闪会非常吵，
       * 而 U5 的边界里写着「除骨架屏外不新增 infinite 装饰动画」。
       */
      '.dshpz-pulseonce{animation:dshpz-pulseonce var(--dshpz-dur-in) var(--dshpz-ease-out) 1}',
      '@keyframes dshpz-pulseonce{0%{transform:scale(1)}50%{transform:scale(1.04)}100%{transform:scale(1)}}',

      /* ---- 绑定切换条的样式（v0.20.0 加的）**已随 U3 整体删除** ----
       *
       * 那批类（`.dshpz-pill*` / `.dshpz-bind*` / `.dshpz-addlist`）在 v2.0.0 里
       * **没有任何渲染点了**：绑定退场，二级页只显示当前项目名，换项目走一级列表。
       *
       * 为什么必须删而不是留着：本仓记过「守卫须能抓到漂移」——留着一堆没人用的类，
       * 下一个人会以为「绑定 UI 还在，只是没渲染」，于是照它去改绑定逻辑。
       * 死样式与死代码一样，是**假信号**。
       */
      '.dshpz-sel:focus{outline:none;border-color:var(--dshpz-accent)}',


      /* ------------------------------- 发现（审查） ------------------------------- */
      // 审查块（`.dshpz-finding` 一族）已按用户指令删除；
      // ⚠️ `.dshpz-findings` 与 `.dshpz-finding*` **不能一起删**——重建预览的逐项目行
      // 还在用它们（见 `rebuildBlockAll` / `rebuildBlock`）。删掉会静默失去边框与配色。
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

      /* -------------------------------- 空态 -------------------------------- */
      '.dshpz-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:26px 16px;text-align:center;color:var(--dshpz-label-2);border:1px dashed var(--dshpz-border-2);border-radius:var(--dshpz-radius-md);background:color-mix(in srgb,var(--dshpz-bg-1) 60%,transparent)}',
      '.dshpz-emptyicon{color:var(--dshpz-label-3)}',
      '.dshpz-emptytitle{font-size:13px;color:var(--dshpz-label-1);font-weight:600}',

      /* ------------------------------- 加载骨架 ------------------------------- */
      '.dshpz-skel{position:relative;overflow:hidden;height:12px;border-radius:6px;background:var(--dshpz-bg-2);margin-bottom:8px}',
      '.dshpz-skel::after{content:"";position:absolute;top:0;right:0;bottom:0;left:0;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--dshpz-label-1) 12%,transparent),transparent);background-size:160% 100%;animation:dshpz-sheen 1.3s linear infinite}',
      /**
       * ## 转圈圈（v2.2.7）
       *
       * 纯 CSS 圆环：`border-top-color` 用 `currentColor`，其余三边是它的 28% 淡版。
       * 不引 SVG、不加额外 DOM 层级——它出现在按钮里，尺寸必须能被 `flex` 收住。
       *
       * `currentColor` 让它在任何按钮状态（禁用 / 悬停 / 主色）下自动跟随文字色，
       * 不必为每个场景再配一份颜色。
       *
       * ⚠️ 减少动效时它会被作用域通配规则停住（变成一枚静态圆环）。
       * 这是**既有裁定**（U5 缺口 A：动效一律关），不是漏网——静态圆环仍表达「在忙」。
       */
      '.dshpz-spin{flex:0 0 auto;box-sizing:border-box;width:11px;height:11px;border-radius:99px;border:1.5px solid color-mix(in srgb,currentColor 28%,transparent);border-top-color:currentColor;animation:dshpz-spin .7s linear infinite}',
      '@keyframes dshpz-spin{to{transform:rotate(360deg)}}',

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

      /**
       * 侧边栏常驻按钮（v2.0.0，U1）。
       *
       * 它**不再是输入框里那颗小按钮**：宿主 `PanelRow` 已经画好了整行的容器
       * （`padding:7px 8px`、`min-height:36px`、圆角、hover 底色），本组件落在它的
       * `panelGlyph` 格里，**只负责那一格图标**。
       *
       * 所以这里**不能有任何自己的盒模型**：`padding` / `width` / `background` 三者
       * 只要有一个在，图标就会相对「插件 / 任务看板 / 技能中心」那几行的图标偏移
       * （padding 把它往右推，padding 的上下量还会把这一行顶高）。曾经的
       * `padding:7px 10px` + `width:100%` + hover 底色就是错位与行高不齐的来源。
       */
      '.dshpz-sidebtn{display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;background:transparent;color:var(--dshpz-label-2);cursor:pointer;transition:color var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-sidebtn:hover{color:var(--dshpz-label-1)}',
      '.dshpz-sidebtn[data-on="1"]{color:var(--dshpz-accent)}',

      /* --------------------------- 一级：项目列表（U2） --------------------------- */
      // 一级页是**单栏**：列表一行一个项目，不需要三栏骨架。
      /**
       * 单列布局（一级页 / 二级派单子页）：铺满主区后内容列要收敛。
       *
       * 面板宽了，一行中文不该跟着变宽（一行 1600px 没人读得下去），所以给
       * 内容区一个 `max-width` 并用 `margin:auto` 居中。用 `padding` 的
       * `max()` 而不是 `margin:auto` 包一层容器：`.dshpz-body-single` 自己
       * 就是滚动容器（`overflow-y:auto`），`margin:auto` 在滚动容器里垂直方向上
       * 会把内容顶到中间，滚动条一出现就跳。
       *
       * 1080px 而不是更窄：一级页里有「三个模型」那种一行多控件的行，
       * 太窄会把它们挤成两行。
       */
      '.dshpz-body-single{display:block;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:14px max(18px,calc((100% - 1080px) / 2))}',
      '.dshpz-body-single .dshpz-col{overflow:visible;padding:0;border:0}',
      '.dshpz-projects{display:flex;flex-direction:column;gap:7px}',
      // 行：项目名 + 元信息 + 箭头。**只用 transform / border-color 做动效**（性能红线：
      // 绝不动 width/height/top/left，那会在长列表上逐帧重排）。
      '.dshpz-projectrow{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;padding:10px 12px;text-align:left;font:inherit;color:inherit;background:var(--dshpz-bg-1);border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-md);cursor:pointer;transition:border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),transform var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-projectrow:hover{border-color:var(--dshpz-accent);transform:translateY(-1px)}',
      '.dshpz-projectrow[data-on="1"]{border-color:var(--dshpz-accent);box-shadow:var(--dshpz-glow)}',
      '.dshpz-projectname{display:flex;align-items:center;gap:7px;flex:1 1 auto;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshpz-nowbadge{flex:0 0 auto;padding:1px 6px;border-radius:999px;font-size:10px;font-weight:500;background:var(--dshpz-accent);color:var(--dshpz-on-accent)}',
      '.dshpz-projectmeta{flex:0 0 auto;display:flex;align-items:center;gap:6px;color:var(--dshpz-label-3);font-size:11px;white-space:nowrap}',
      '.dshpz-dot{opacity:.55}',
      '.dshpz-projectgo{flex:0 0 auto;color:var(--dshpz-label-3);font-size:15px;line-height:1}',
      // 工作区选择器（v2.1.1：默认折叠，点「更换」才铺开）。
      // 折叠态那一行就是「当前绑的是哪个」，所以折叠不会把最该看的信息藏掉。
      '.dshpz-wsblock{margin-top:6px}',
      '.dshpz-wshead{display:flex;align-items:center;gap:8px;margin-top:6px}',
      '.dshpz-wslist{display:flex;flex-direction:column;gap:5px;margin-top:6px;padding:6px;border:1px solid var(--dshpz-border-2);border-radius:var(--dshpz-radius-md);background:var(--dshpz-bg-2);animation:dshpz-rise var(--dshpz-dur-fast) var(--dshpz-ease-out)}',
      '.dshpz-wsrow{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;padding:7px 10px;text-align:left;font:inherit;font-size:12px;color:var(--dshpz-label-2);background:var(--dshpz-bg-1);border:1px solid var(--dshpz-border-1);border-radius:var(--dshpz-radius-sm);cursor:pointer;transition:border-color var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-wsrow:hover{border-color:var(--dshpz-accent)}',
      '.dshpz-wsrow[data-on="1"]{border-color:var(--dshpz-accent);box-shadow:var(--dshpz-glow)}',
      '.dshpz-wsname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dshpz-font-mono);font-size:11px}',
      '.dshpz-wswarn{flex:0 0 auto;color:var(--dshpz-warn);font-size:11px}',
      '.dshpz-wsok{flex:0 0 auto;color:var(--dshpz-ok);font-size:11px}',
      // 「当前会话所在的工作区」标记（v2.1.1）：主色实心小徽标，与「当前」两字同一套语言。
      '.dshpz-wscur{flex:0 0 auto;padding:1px 6px;border-radius:999px;font-size:10px;font-weight:500;background:var(--dshpz-accent);color:var(--dshpz-on-accent)}',
      '.dshpz-wsrow[data-current="1"]{border-color:var(--dshpz-accent)}',
      /**
       * 面板内浮窗（v2.1.3）：把「新建项目会话」的对话流挂在这里。
       *
       * ## 为什么是面板内的一层，不是右侧浮动窗
       *
       * 右侧浮动 pane（`data-dockkit-float`）由 `ui-dockkit` 渲染在
       * `sidebar-right` 的 `SessionView` 子树里，而那个子树在
       * `activePanelId !== null` 时被整个标 `hidden`（CSS `display:none`）。
       * 拼图面板一打开就满足那个条件——**浮动窗会跟着整条右栏一起消失**。
       * 那是可见性规则挡死的，不是实现难度问题。
       *
       * 所以浮窗住在拼图面板自己的层里：与主题层同一套做法（见 `themeOpen` 的注释），
       * 关闭顺序天然正确（先关浮窗，再关面板）。
       */
      /**
       * 浮窗**底板**（v2.1.6 调过不透明度）。
       *
       * 原先写 `color-mix(in srgb,var(--dshpz-glass) 72%,transparent)`——
       * 那是**72% 透明**，不是 72% 不透明，于是面板底下的字透上来，
       * 用户报「太透明了看不清」。现在直接用不透明的 `--dshpz-glass`，
       * 只靠 `backdrop-filter` 做质感。`color-mix` 的退化路径也更稳：
       * 不支持时就是一个不透明底，而不是全透明。
       */
      '.dshpz-float{position:absolute;inset:0;z-index:30;display:flex;flex-direction:column;padding:18px;background:var(--dshpz-glass);backdrop-filter:blur(18px) saturate(1.25);-webkit-backdrop-filter:blur(18px) saturate(1.25);animation:dshpz-fade var(--dshpz-dur-in) var(--dshpz-ease-out)}',
      '.dshpz-floatbox{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;border:1px solid var(--dshpz-border-3);border-radius:var(--dshpz-radius-md);background:var(--dshpz-bg-1);overflow:hidden;box-shadow:0 18px 48px -28px rgba(0,0,0,.7)}',
      '.dshpz-floathead{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--dshpz-border-2);background:var(--dshpz-bg-2)}',
      '.dshpz-floattitle{flex:1 1 auto;min-width:0;font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshpz-floatsid{flex:0 0 auto;font-family:var(--dshpz-font-mono);font-size:11px;color:var(--dshpz-label-3)}',
      '.dshpz-floatbody{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
      // 内嵌对话流：`conversation.content` 的 `variant:'embedded'` 自己管宽度，
      // 这里只保证「有确定的高度」——它内部是 flex + overflow-y:auto，
      // 父级高度为 auto 时会被内容压成 0（那正是「挂上去什么都不显示」的成因）。
      '.dshpz-chat{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
      '.dshpz-chat[data-ready="0"]{align-items:center;justify-content:center;color:var(--dshpz-label-2);font-size:12px;padding:20px;text-align:center}',
      '.dshpz-floatfoot{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--dshpz-border-2);background:var(--dshpz-bg-2)}',
      '.dshpz-modelname{flex:0 0 auto;width:132px;color:var(--dshpz-label-2);font-size:12px}',
      /**
       * 派单页左上角那条「全局大脑」（v2.2.0）。
       *
       * 它坐在 `.dshpz-dispatch`（flex 纵向）的**第一个孩子**位置，
       * 所以 `flex:0 0 auto` —— 高度让给下面的五列看板。
       *
       * `data-on="1"` 时按钮亮起来（与分段控件同一套语言）：浮窗现在开着它。
       */
      '.dshpz-brainbar{flex:0 0 auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dshpz-brainbtn{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;font-family:inherit;font-size:12.5px;font-weight:600;color:var(--dshpz-label-1);background:var(--dshpz-bg-2);border:1px solid var(--dshpz-border-2);border-radius:var(--dshpz-radius-sm);cursor:pointer;transition:color var(--dshpz-dur-fast) var(--dshpz-ease-std),border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),background var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-brainbtn:hover:not(:disabled){border-color:var(--dshpz-accent);color:var(--dshpz-accent)}',
      '.dshpz-brainbtn[data-on="1"]{border-color:var(--dshpz-accent);color:var(--dshpz-accent);background:color-mix(in srgb,var(--dshpz-accent) 12%,var(--dshpz-bg-2))}',
      '.dshpz-brainbtn:disabled{opacity:.55;cursor:default}',
      '.dshpz-brainhint{flex:1 1 240px;min-width:0;color:var(--dshpz-label-3);font-size:11.5px;line-height:1.5}',

      /* --------------------------- 二级：派单看板（U4） --------------------------- */
      /**
       * ## 派单页要**占满面板**（v2.1.10）
       *
       * 用户原话：「我要的效果是占满面板」。
       *
       * 原先这一页套的是通用的 `.dshpz-body-single`，而那条规则是为**文字页**写的：
       *   - `padding:14px max(18px,calc((100% - 1080px)/2))` —— 内容收敛到 1080px 居中；
       *   - `display:block` + 高度 `auto` —— 内容多高就多高。
       *
       * 两条对看板都是错的：五列被压在 1080px 里（每列约 200px，挤），
       * 而列高只有 `min-height:132px`，于是面板下面空掉一大片。
       *
       * 所以给派单页加 `dshpz-body-fill`：宽度放开、高度走 flex 撑满，
       * 每一列**自己滚动**（看板的标准行为：卡多时滚列，不滚整页）。
       *
       * ⚠️ 这些规则必须写在 `.dshpz-body-single` 那几条**之后**：两者特异性相同
       * （都是 0,2,0 / 0,1,0），靠顺序覆盖。挪到前面会被 `display:block` 压回去。
       */
      '.dshpz-body-fill{display:flex;flex-direction:column;overflow:hidden;padding:14px 16px}',
      /**
       * 派单页里的 `notice` 与 `.dshpz-err`（v2.3.x）。
       *
       * `.dshpz-body-fill` 是 flex 纵向容器，子项默认 `flex:0 1 auto`——
       * 那句提示会被下面撑满的看板**压扁成一条线**（文字叠在一起）。
       * 与 `.dshpz-boardtabs` 遇到的是同一个问题，所以用同一条修法。
       *
       * 顺带清掉 `.dshpz-notice` / `.dshpz-err` 自带的 `margin:10px 0 0`：
       * 容器已经有 `gap`，再叠一层上边距会让它离顶部莫名远一截。
       */
      '.dshpz-body-fill > .dshpz-notice,.dshpz-body-fill > .dshpz-err{flex:0 0 auto;margin:0}',
      /**
       * ⚠️ 里层 `.dshpz-col` 的 `padding:20px 22px` **必须清掉**：
       * 它和外层 `.dshpz-body-fill` 的 `padding:14px 16px` 会**叠加**成 34px，
       * 五列的可视宽度白白少掉 68px。外边距只留一层。
       */
      '.dshpz-body-fill .dshpz-col{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow:hidden;padding:0;border:0}',
      // 五列看板：宽屏并排、窄屏切单列（Q8）。列间距固定，列内卡片向下排。
      // `position:relative` 是给「新建任务单」浮窗当定位基准的（见 `.dshpz-ntwrap`）。
      '.dshpz-dispatch{position:relative;display:flex;flex-direction:column;gap:10px;flex:1 1 auto;min-height:0}',
      /**
       * ## 「新建任务单」浮窗（v2.2.7）
       *
       * 原先它是一个**整页**（`newTaskPage` 直接替换掉整个看板）。问题是：
       * 新建完一张卡，用户**看不到自己刚才建的那张落在哪**——看板被整页顶掉了。
       * 改成浮在看板上的小窗后，「建完 → 卡出现在未澄清列」是**同一屏内**的因果。
       *
       * 尺寸刻意压小（`min(420px,100%)`）：它只有两个输入区，铺满整屏是浪费，
       * 也会让人以为又跳了一层页。
       *
       * 底板用**不透明** `--dshpz-bg-1`：这是要读字的表单，透出底下的卡片会花。
       * 遮罩只做很轻的压暗 + 3px 模糊——目的是「知道后面是看板」，不是「看不清后面」。
       */
      '.dshpz-ntwrap{position:absolute;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;padding:14px;background:color-mix(in srgb,var(--dshpz-bg-1) 62%,transparent);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);animation:dshpz-fade var(--dshpz-dur-in) var(--dshpz-ease-out)}',
      '.dshpz-ntbox{box-sizing:border-box;display:flex;flex-direction:column;gap:7px;width:min(420px,100%);max-height:100%;overflow-y:auto;overscroll-behavior:contain;padding:13px 14px 14px;border:1px solid var(--dshpz-border-3);border-radius:var(--dshpz-radius-md);background:var(--dshpz-bg-1);box-shadow:0 20px 52px -30px rgba(0,0,0,.75);animation:dshpz-rise var(--dshpz-dur-in) var(--dshpz-ease-out)}',
      '.dshpz-nthead{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:var(--dshpz-label-1)}',
      '.dshpz-nthead .dshpz-act{margin-left:auto;padding:3px 7px}',
      // 表单在浮窗里一律小一号：13px 的输入框在 420px 宽的窗里显得很挤。
      '.dshpz-ntbox .dshpz-in{font-size:12px;padding:6px 8px;margin-bottom:0}',
      '.dshpz-ntbox .dshpz-acts{margin-top:2px}',
      '.dshpz-ntbox .dshpz-muted{font-size:11.5px;line-height:1.5}',
      '.dshpz-board{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;align-items:stretch;flex:1 1 auto;min-height:0}',
      /**
       * **每一列是一个有明确范围的框**（v2.1.9，用户要求「各列加个框选定范围让 UI 更醒目」）。
       *
       * 原先只是 `1px solid var(--dshpz-border-1)` + `bg-1` 的浅底——五列并排时
       * 「这张卡属于哪一列」要靠读列头，列与列的**范围**在视觉上糊成一片。
       *
       * 改法是三件事一起做：
       *   1. 边框加重一档（`border-2`）+ 外圈 `shadow`，让每列成为一个**独立的框**；
       *   2. 列头加一条**状态色顶带**（`::before`，按 `data-col` 取色），
       *      范围从哪开始一眼可见，且五列各有自己的色，不用读字；
       *   3. 空列给一个**虚线内框**（`.dshpz-boardcol[data-empty="1"]`）——
       *      那是「这一列还没有卡」的可视化，也让拖拽目标更明确。
       *
       * ⚠️ 顶带用 `::before` 而不是给列头加 `border-top`：列头是 flex 行，
       * 加 `border-top` 会让它的高度与其它列差 2px（有卡 / 无卡时列头一致才对齐）。
       */
      /**
       * ## 列底色：**有卡没卡都一样**（v2.4.4，用户裁定）
       *
       * 用户原话：「有卡时列框不用变白」。原先是两套底色——有卡用不透明的 `bg-1`
       * （浅色下＝纯白），空列用 `color-mix(bg-1 42%,transparent)`（浅蓝灰），
       * 于是同一块板子上五列像两种控件，而「这一列有没有卡」本来就由列头数字
       * 与卡本身说明，不需要底色再喊一次。
       *
       * 现在统一走 `--dshpz-board-tray`：列是**托盘**，卡片是压在上面的**纸**，
       * 层次由「纸 vs 托盘」表达。空列不再需要单独一条底色规则（`data-empty`
       * 只留 `box-shadow` 的差别），**实线边框与撑满照旧不动**。
       */
      '.dshpz-boardcol{position:relative;display:flex;flex-direction:column;gap:7px;min-width:0;padding:10px 9px 9px;background:var(--dshpz-board-tray);border:1px solid var(--dshpz-border-2);border-radius:var(--dshpz-radius-md);min-height:132px;box-shadow:0 1px 2px -1px rgba(0,0,0,.28),0 8px 20px -18px rgba(0,0,0,.6);transition:border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),background var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      /**
       * 列在「占满面板」时**自己滚动**（v2.1.10）。
       *
       * 看板的标准行为：列高度撑满可视区，卡多了**滚那一列**、不滚整页。
       * 这样列头始终可见（不然往下滚就不知道自己在看哪一列）。
       *
       * `min-height:0` 是必需的：flex 子项默认 `min-height:auto`，
       * 不给 0 的话列会被内容顶高、`overflow` 永远不触发——那正是
       * 「设了 overflow:auto 却不滚动」的经典成因。
       *
       * 只在 `.dshpz-body-fill` 里生效（窄屏那套单列布局不加这个类，
       * 它要的是整页滚，见下面的 `@media`）。
       */
      '.dshpz-body-fill .dshpz-boardcol{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;scrollbar-gutter:stable}',
      /**
       * ## 那条横向滑条（v2.1.11 修）
       *
       * 用户截图里每列底部有一条横向滚动条。根因是**顶带的负偏移**：
       * `::before` 写的是 `left:-1px;right:-1px`（为了盖住列自己的 1px 边框），
       * 于是它比列的**内容盒宽 2px**。
       *
       * 而 CSS 有一条硬规则：`overflow-y:auto` 会把 `overflow-x` 从
       * `visible` **提升成 `auto`**（两者不能一个 visible 一个 auto）。
       * 于是那 2px 溢出变成了横向滚动条——它跟内容毫无关系。
       *
       * 两处一起修，缺一不可：
       *   1. 顶带**不再用负偏移**，改用 `inset` 与 `border-radius` 对齐列的内边；
       *   2. 列显式 `overflow-x:hidden`（不依赖 `overflow-y:auto` 的隐式提升）。
       *
       * 另外给 `scrollbar-gutter:stable`：有卡/无卡时列的内容宽度不跳。
       */
      '.dshpz-boardcol::before{content:"";position:absolute;left:0;right:0;top:0;height:3px;border-radius:calc(var(--dshpz-radius-md) - 1px) calc(var(--dshpz-radius-md) - 1px) 0 0;background:var(--dshpz-col-accent,var(--dshpz-border-2));pointer-events:none}',
      /**
       * 五列各自的状态色。取的都是**已有令牌**，不新增颜色：
       * 未澄清＝警告（还没问清）、未接单＝主色（就绪待派）、在做＝主色、
       * 已做＝成功、失败＝错误。
       */
      '.dshpz-boardcol[data-col="unclarified"]{--dshpz-col-accent:var(--dshpz-warn)}',
      '.dshpz-boardcol[data-col="pending"]{--dshpz-col-accent:var(--dshpz-accent)}',
      '.dshpz-boardcol[data-col="doing"]{--dshpz-col-accent:var(--dshpz-accent)}',
      '.dshpz-boardcol[data-col="done"]{--dshpz-col-accent:var(--dshpz-ok)}',
      '.dshpz-boardcol[data-col="failed"]{--dshpz-col-accent:var(--dshpz-err)}',
      /**
       * ## 空列的观感
       *
       * 水平**与列头「文字」左对齐**、垂直居中——两个方向各修各的毛病。
       *
       * ⚠️ 对齐对象是**文字**，不是列头那个状态色圆点。列头是 `[圆点 7px][gap 7px][文字]`，
       * 文字比圆点右移 14px，加上列头自己的 `padding-left:1px`，空态要缩进 **15px**：
       * 列头文字左边缘 = 列 9 + 列头 1 + 圆点 7 + 间距 7 = 24px，空态 = 列 9 + 15 = 24px。
       * （踩过一次：按「列头那条 10px 线」对齐，结果对到了圆点上，差 14px。）
       *
       * ⚠️ 列的**实线边框与撑满**不动（用户拍板）。
       */
      /**
       * 空列**不再改底色**（v2.4.4）：底色已由 `.dshpz-boardcol` 统一成托盘，
       * 五列一致。空列与有卡列只差**外圈阴影**——托盘里没压纸时不需要那层托举感。
       *
       * ⚠️ 原先这里写的是 `background:color-mix(bg-1 42%,transparent)`，正是
       * 「有卡白、没卡灰」那个落差的来源。改底色就等于把用户要修的东西又加回来。
       */
      '.dshpz-boardcol[data-empty="1"]{box-shadow:none}',
      '.dshpz-boardempty{flex:1 1 auto;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:7px;margin:0;padding:16px 1px 16px 15px;color:var(--dshpz-label-3);font-size:11.5px;line-height:1.5;text-align:left}',
      '.dshpz-boardemptyicon{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:var(--dshpz-bg-3);color:var(--dshpz-label-3);opacity:.85}',
      /** 列头：给状态色留一个小圆点，与顶带呼应（顶带是「范围」，圆点是「身份」）。 */
      '.dshpz-boardcoldot{flex:0 0 auto;width:7px;height:7px;border-radius:99px;background:var(--dshpz-col-accent,var(--dshpz-border-2))}',
      /**
       * ## 列头**必须五列等高**（v2.2.6 修的错位）
       *
       * 「未澄清」列头里多一个「＋ 新建」按钮，而按钮自然高 26.4px（12×1.2 + 5×2 + 1×2）、
       * 标题行只有 16.8px。`align-items:center` 于是把**那一列的标题压低 4.8px**；
       * 该列列头整体高 9.6px，空态块的 `justify-content:center` 又在矮掉的剩余空间里
       * 下移 4.8px —— 用户报的「未澄清没和别的列对齐」与「中间那句解释文字也没对齐」
       * 是**同一个根因**（实测：未澄清标题 +4.8px、空态 +5.6px，其余四列一致）。
       *
       * 修法是让列头容纳最高的控件：`border-box` + `min-height`。
       * ⚠️ 这两条**不能删**：`align-items:center` 只对齐盒内内容，**盒子不等高就必然错位**。
       * 38px = 按钮 26.4 + 上下内边 10 + 下边框 1（取整留 0.6px 余量）。
       */
      '.dshpz-boardcolhead{display:flex;align-items:center;gap:7px;box-sizing:border-box;min-height:38px;font-size:12.5px;font-weight:600;color:var(--dshpz-label-1);padding:2px 1px 8px;border-bottom:1px solid var(--dshpz-border-1)}',
      '.dshpz-boardcoln{padding:0 6px;border-radius:999px;background:var(--dshpz-bg-3);color:var(--dshpz-label-3);font-size:10px;font-weight:500}',
      /**
       * ## 卡＝纸（v2.4.4，用户裁定）
       *
       * 用户原话：「卡的颜色改为纸的颜色再加上一层纸纹理」。
       *
       * `background-color` 仍是宿主的 `bg-2`（保证跟随浅色/深色），
       * `background-image` 叠**两层**：暖色层 + 纤维噪点（见 `paperTint` /
       * `paperTexture` 的完整依据）。两层都是 `background-image`，
       * **`background-color` 兜底不变**——任一层不被支持时卡片仍是有底色的，
       * 不会退化成透明。
       *
       * ⚠️ 顺序有语义：`background-image` **先写的在上层**，所以暖色在前、
       * 噪点在后。反了的话均匀暖色会盖住纤维，纹理就看不见了。
       *
       * ## 描边走 `border-3`（v2.4.4，用户裁定「给卡片加个描边」）
       *
       * 原先用 `border-1`（宿主的 `border-l1` = **4% 黑**）。卡还是冷白时那道边勉强够，
       * 换成暖色纸之后**纸与托盘的明度差变小**，4% 的边就彻底看不见了——用户截图里
       * 卡片像一块没有轮廓的色斑。
       *
       * 改用 `border-3`（`border-l3` = 12% 黑）。**这不是新造的颜色**：本仓早就记过
       * 「`border-1` 画在卡片上太淡、30 条要点糊成一块」，`border-3` 就是宿主给
       * 「需要看清的描边」留的那一档，`.dshpz-entry` 与 `.dshpz-floatbox` 一直在用它
       * （见 `THEME_GLASS` 里 `border3` 的注释）。同一件事用同一个令牌，别处改了一处就够。
       *
       * 左边那根 3px 状态条照旧：`border-left-width:3px` 不变，`failed` / `done`
       * 两列仍由下面的规则把左边框染成状态色。
       */
      '.dshpz-card{display:flex;flex-direction:column;gap:5px;padding:8px 9px;background-color:var(--dshpz-bg-2);background-image:var(--dshpz-paper-tint),var(--dshpz-paper-texture);background-repeat:no-repeat,repeat;border:1px solid var(--dshpz-border-3);border-left-width:3px;border-radius:var(--dshpz-radius-sm);cursor:grab;transition:border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),transform var(--dshpz-dur-slow) var(--dshpz-ease-out)}',
      '.dshpz-card[data-col="failed"]{border-left-color:var(--dshpz-err)}',
      '.dshpz-card[data-col="done"]{border-left-color:var(--dshpz-ok)}',
      /**
       * ⚠️ v2.4.3：`.dshpz-cardtitle` / `.dshpz-cardobj` / `.dshpz-cardexec` /
       * `.dshpz-cardbadge` / `.dshpz-cardfail` / `.dshpz-cardacts` **六条已删**。
       *
       * 它们是折叠卡之前那套「卡上直接铺目标 / 执行提示词 / 失败原因 / 按钮」
       * 的样式，随卡一起搬进了详情浮窗（浮窗有自己的 `.dshpz-d*` 一套）。
       * 留着它们不是「无害的旧代码」——下一个人会以为卡上还能长那些东西，
       * 照着类名去写渲染，然后发现样式对不上。
       */
      /**
       * ## 「这张卡现在在干活吗」那一行（v2.3.x，需求 ②）
       *
       * 复用既有的 `.dshpz-spin` 转圈圈（v2.2.7 加的），这里只给**容器**：
       * 转圈圈是 `inline` 尺寸的圆环，塞进卡片需要一行 `flex` 把它与文字对齐，
       * 否则圆环会跟着基线跑偏。
       *
       * `data-run` 三态共用这一条规则，**不新造三个类**：它们是同一个语义槽位
       * （「这张卡的活动状态」）的三个取值，用属性区分比三个类名更贴事实。
       *   - `run="running"`：主色——正在跑，要显眼；
       *   - `run="idle"`：弱化——已经停了，不是错误，不该抢注意力；
       *   - `run="gone"`：弱化——会话不在进程里了（可能被删/重启），如实说。
       */
      '.dshpz-cardrun{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:500;color:var(--dshpz-accent);line-height:1.4;word-break:break-word}',
      '.dshpz-cardrun[data-run="idle"],.dshpz-cardrun[data-run="gone"]{color:var(--dshpz-label-3);font-weight:400}',
      /**
       * ## 折叠小卡（v2.4.3）
       *
       * 用户拍板「任务卡折叠成一个小卡片，只显示标题」。所以这一版把卡片
       * 压成**一行**：`[转圈圈] 标题 [角标]`。
       *
       * ⚠️ **`box-sizing:border-box` 必须写**：卡有 1px 边框 + 3px 左边框，
       * 不写的话内容盒比列宽宽出 4px，五列并排时会挤出横向滚动条
       * （本仓在 `.dshpz-boardcolhead` 与 `.dshpz-ntbox` 上各踩过一次）。
       *
       * `min-height` 与列头一致（38px）：一行卡与两行卡混排时，列内不会因为
       * 「这一列刚好都是单行卡」而看起来比别的列矮一截。
       */
      '.dshpz-cardmini{box-sizing:border-box;flex-direction:row;align-items:center;gap:6px;min-height:34px;padding:7px 9px;cursor:pointer}',
      '.dshpz-cardmini:active{cursor:grabbing}',
      '.dshpz-minititle{flex:1 1 auto;min-width:0;font-size:12px;font-weight:600;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      /**
       * 正在跑的小圆环：与标题同一行，`flex:0 0 auto` 保证它不被长标题挤扁。
       * 尺寸由 `.dshpz-spin` 自己定（11px），这里只负责不缩。
       */
      '.dshpz-minidot{flex:0 0 auto}',
      '.dshpz-minibadge{flex:0 0 auto;padding:1px 6px;border-radius:999px;font-size:10px;line-height:1.5;background:var(--dshpz-bg-3);color:var(--dshpz-label-2)}',
      '.dshpz-minibadge[data-tone="warn"]{background:var(--dshpz-warn);color:var(--dshpz-on-accent)}',
      '.dshpz-minibadge[data-tone="err"]{background:var(--dshpz-err);color:var(--dshpz-on-accent)}',
      /* ---- 卡详情浮窗（v2.4.3）：原来卡上的信息与动作搬到这里 ---- */
      '.dshpz-dscroll{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:12px 14px}',
      '.dshpz-detail{display:flex;flex-direction:column;gap:7px}',
      '.dshpz-dbadges{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:2px}',
      '.dshpz-dbadge{padding:1px 7px;border-radius:999px;font-size:10.5px;background:var(--dshpz-bg-3);color:var(--dshpz-label-2)}',
      '.dshpz-dbadge[data-tone="ok"]{background:var(--dshpz-ok);color:var(--dshpz-on-accent)}',
      '.dshpz-dbadge[data-tone="warn"]{background:var(--dshpz-warn);color:var(--dshpz-on-accent)}',
      '.dshpz-dbadge[data-tone="err"]{background:var(--dshpz-err);color:var(--dshpz-on-accent)}',
      '.dshpz-drow{display:flex;gap:8px;font-size:11.5px;line-height:1.55}',
      '.dshpz-dkey{flex:0 0 auto;min-width:64px;color:var(--dshpz-label-3)}',
      '.dshpz-dval{flex:1 1 auto;min-width:0;word-break:break-word;white-space:pre-wrap}',
      '.dshpz-dblock{display:flex;flex-direction:column;gap:3px;padding-top:3px;border-top:1px solid var(--dshpz-border-1)}',
      '.dshpz-dlist{margin:0;padding-left:18px;font-size:11.5px;line-height:1.6}',
      '.dshpz-dacts{display:flex;gap:5px;flex-wrap:wrap}',
      /**
       * 浮窗头部那颗「大脑在跑」的指示（需求 ④）。
       *
       * 与 `.dshpz-cardrun` 分开一个类而**不复用**：浮窗头部那一行是
       * `flex` 容器里的一个子项，需要 `flex:0 0 auto` 才不会被标题挤扁；
       * 卡片那一行在 `column` 流里，加了 `flex` 反而会改变卡片高度。
       * 两条规则的**布局约束不同**，合成一条迟早要在某一处写 `!important`。
       */
      '.dshpz-floatrun{flex:0 0 auto;display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:500;color:var(--dshpz-accent)}',
      '.dshpz-floatrun[data-run="idle"],.dshpz-floatrun[data-run="gone"]{color:var(--dshpz-label-3);font-weight:400}',
      // 拖拽落点高亮：**只改 border-color 与底色**（不动布局属性——那会在拖动时逐帧重排）。
      /**
       * 拖拽落点高亮：**只改 border-color 与叠一层色**（不动布局属性——那会在拖动时逐帧重排）。
       *
       * ⚠️ v2.4.4：原先是 `background:color-mix(accent 10%,bg-1)`——那是个**不透明**色，
       * 拖到列上时整列会闪成不透明底（浅色主题下就是变白），正是用户这次要修的
       * 「有卡时列框变白」的同一个毛病，只是发生在拖拽瞬间。改成只叠
       * `background-image`，**列的托盘底色照旧**（`background-color` 不被 shorthand 重置）。
       */
      '.dshpz-boardcol[data-over="1"]{border-color:var(--dshpz-accent);border-style:solid;background-image:linear-gradient(0deg,color-mix(in srgb,var(--dshpz-accent) 12%,transparent),color-mix(in srgb,var(--dshpz-accent) 12%,transparent))}',
      /**
       * ## 拖拽中的卡：**真抓在手上**（v2.4.5，用户拍板）
       *
       * 用户原话两条：「我要的是真抓在手上，不是投影」「拖的时候加一个任务卡微摇动效果」。
       *
       * ## 为什么不能靠浏览器的原生拖影
       *
       * 原生拖影是浏览器在 `dragstart` 返回时拍的**一张位图快照**。这有两个死结：
       *
       *   1. **它不能动**。位图没有动画——「微摇动」这件事在原生素材上**做不到**，
       *      不是「没调好」，是素材形态不允许。
       *   2. **它只是"跟着"光标，不是"握在手里"**。快照与光标之间只有一个固定偏移，
       *      卡本身没有任何「被拿着」的迹象，于是只能靠**投影**去暗示"它抬起来了"。
       *      而投影补的正是「它其实没被握住」这个缺口——用户一眼就看出来了。
       *
       * 所以这一版**把原生拖影整个藏掉**（`setDragImage` 传一张透明图），
       * 改成自己造一张真卡跟着光标走：
       *
       *   - **跟着光标**：`dragover` 里按 `光标 − 抓取点` 更新位置。抓取点就是
       *     用户按下时手指在卡上的那个点——于是卡停在手底下**原来的相对位置**，
       *     这才是「抓着它」而不是「它跟着我」。
       *   - **微摇动**：真 DOM 节点，能播 CSS 动画。手拿着东西本来就会轻轻晃。
       *   - **不再靠投影**：卡真的在手上，就不需要投影去暗示它被拿起来了。
       *
       * ## 为什么不用 React 渲染这张卡
       *
       * 它要跟着 `dragover` 每几毫秒动一次。走 React state 就是每帧一次重渲染
       * 整棵看板——本仓的性能红线。所以它是**模块级的一个 DOM 节点**，
       * 直接改 `transform`（只动合成层，不触发重排）。
       *
       * 这与「抬起曾走行内样式」是同一条理由的两个阶段：**拖影这件事 React 管不了**。
       * 上一版是在快照拍之前抢着改行内样式（治标），这一版干脆不用快照（治本）。
       */
      '.dshpz-cardghost{position:fixed;left:0;top:0;z-index:60;margin:0;box-sizing:border-box;pointer-events:none;will-change:transform}',
      /**
       * 正被拖的那张：**占位但不显示**（v2.4.6，用户拍板）。
       *
       * 用户原话：「拖的时候原地不要有那个卡」。
       *
       * 为什么用 `visibility` 而不是 `display:none`：后者让这张卡**脱离布局**，
       * 同列后面的卡会往上跳、列高也变——拖动过程中整列在动，比留着那张卡还晃眼。
       * `visibility:hidden` 保留它占的位置，于是「它被拿走了、这里空着」是稳的。
       *
       * ⚠️ 不能写 `opacity:0`：那与 `visibility` 不同，**元素仍然接事件**，
       * 而且它是可被动画/过渡影响的属性（`.dshpz-card` 上有 transition）。
       * `visibility` 更明确：不画、也不接。
       *
       * ⚠️ 也**不能**用 `display:none` 或把节点摘掉：那会让拖拽的**源元素**
       * 在拖拽进行中离开渲染树，某些浏览器会当场**取消这次拖拽**——
       * 表现是「拖到一半卡突然不动了」。`visibility:hidden` 的节点仍在树里、
       * 仍在布局里，所以拖拽照常。
       */
      '.dshpz-card[data-dragging="1"]{visibility:hidden}',
      // 卡里的任何东西都不该接事件——不然它会挡住 `dragover` 的落点判定。
      '.dshpz-cardghost *{pointer-events:none}',
      /**
       * 微摇动：手拿着东西时那种**不规则的轻晃**。
       *
       * 为什么幅度这么小（±2° 上下、位移 1px）：它是「握在手里」的细节，
       * 不是「这张卡在提醒你」。晃大了会变成抖动噪音，而且会让落点看起来在漂。
       *
       * ⚠️ 用 `ease-in-out` + 不等的中间帧（不是规整的 0/50/100）：
       * 规整的往返是**节拍器**，一眼就假；不等的帧才像手在轻微地动。
       *
       * ⚠️ 这条动画**不能靠 `prefers-reduced-motion` 那条作用域通配规则关掉**：
       * 那张卡挂在 `document.body` 下，不在 `.dshpz-scope` 子树里，通配规则罩不到它。
       * 所以由 JS 显式判（见 `ghostGrab` 的 `sway` 参数）——本仓对 JS 动效的既有纪律。
       *
       * ⚠️ 它挂在**内层**（`ghostGrab` 造两层的原因）：动画写的是 `transform`，
       * 而外层用 `transform` 定位。同一个元素上两者会互相覆盖——外层管"在哪"、
       * 内层管"怎么晃"，各写各的。
       */
      '@keyframes dshpz-cardsway{0%{transform:rotate(-2.1deg) translateX(-1px)}30%{transform:rotate(-0.6deg) translateX(1px)}55%{transform:rotate(-1.7deg) translateX(0)}80%{transform:rotate(-0.9deg) translateX(-1px)}100%{transform:rotate(-2.1deg) translateX(-1px)}}',
      '.dshpz-cardsway{animation:dshpz-cardsway 1100ms ease-in-out infinite}',
      /**
       * ## 拖到「不接收」的列：**当场看得出来**（v2.4.5）
       *
       * 用户原话：「未澄清列不能拖到完成与失败」。
       *
       * 规则在宿主（`moveVerdict` 的禁跳表），随看板下发到 `board.forbidden`。
       * 这里只管**把那个事实画出来**——拖动时就告诉用户"这一列不要"，
       * 而不是等他松手才被拒。松手仍然会被宿主拒（并给出理由），
       * 两层是互补的：**预告省掉一次白拖，拒绝解释为什么**。
       *
       * 用 `--dshpz-err` 而不是 `accent`：拒绝与"可以放"必须在**颜色上**就分开，
       * 只靠边框深浅区分不出来。虚线是第二个信号（不靠颜色也能认，
       * 对色觉障碍用户同样有效）。
       */
      '.dshpz-boardcol[data-no="1"]{border-color:var(--dshpz-err);border-style:dashed;background-image:linear-gradient(0deg,color-mix(in srgb,var(--dshpz-err) 10%,transparent),color-mix(in srgb,var(--dshpz-err) 10%,transparent))}',
      '.dshpz-boardcol[data-no="1"] .dshpz-boardcolhead{color:var(--dshpz-err)}',
      /**
       * 被拒的那次拖拽：**手上那张卡飞回原处**（v2.4.5）。
       *
       * 为什么弹的是「手上那张」而不是「板上那张」：板上那张**从没离开过**
       * （见 `dshpz-cardghost` 那段——跟着光标走的是另造的一张真卡）。
       * 所以「弹回」= 让手上那张沿原路飞回它出发的位置，然后消失。
       * 这样用户看到的是「我把它放回去」而不是「板上的卡抖了一下」。
       *
       * 起点就是它**此刻所在的位置**（松手点），终点是 `translate(0,0)`
       * ——也就是它出发时那个位置。所以拖到多远就从多远飞回来。
       */
      '.dshpz-cardghost[data-back="1"]{transition:transform var(--dshpz-dur-slow) var(--dshpz-ease-out)}',
      // 窄屏：列标签横滑 + 一次只显示一列。
      /**
       * `flex:0 0 auto`（v2.1.10）：`.dshpz-dispatch` 现在是 flex 纵向容器，
       * 而 flex 子项默认 `flex:0 1 auto` —— 标签条与底部说明会被**压扁**
       * （高度被让给下面那个撑满的列）。这两条都不该被压缩。
       */
      '.dshpz-boardtabs{flex:0 0 auto;display:flex;gap:5px;overflow-x:auto;padding-bottom:4px}',
      '.dshpz-dispatch > .dshpz-hint{flex:0 0 auto}',
      '.dshpz-boardtab{flex:0 0 auto;display:inline-flex;align-items:center;gap:5px;padding:6px 10px;font-size:12px;font-family:inherit;color:var(--dshpz-label-2);background:var(--dshpz-bg-1);border:1px solid var(--dshpz-border-1);border-radius:999px;cursor:pointer;transition:border-color var(--dshpz-dur-fast) var(--dshpz-ease-std),color var(--dshpz-dur-fast) var(--dshpz-ease-std)}',
      '.dshpz-boardtab[data-on="1"]{border-color:var(--dshpz-accent);color:var(--dshpz-accent)}',
      '.dshpz-boardtabn{font-size:10px;color:var(--dshpz-label-3)}',
      // 900px 以下：五列改单列（与既有那档断点一致，不新增断点）。
      '@media (max-width:900px){.dshpz-board{grid-template-columns:1fr}}',

      /* --------------------------- 减少动效（无障碍） --------------------------- */
      /**
       * 尊重系统设置：用户开了「减少动态效果」就全部关掉，只保留状态切换本身。
       *
       * ## 为什么从「白名单」改成「作用域内通配」（v2.0.0，U5 缺口 A）
       *
       * 原先这条是**逐个点名 5 个选择器**：
       * `.dshpz-backdrop,.dshpz-panel,.dshpz-dimfill,.dshpz-tilefill,.dshpz-skel::after`。
       * 后果是**新增的动效类不会被自动关掉**——每加一个动效都得回来补一行，
       * 漏一次就是「开了减少动效的用户仍被动画晃」。本版新增了卡片跨列、列表 FLIP、
       * 子页切换等一批动效，靠名单是维护不住的。
       *
       * ## 为什么不能写全局 `*`
       *
       * `*` 会**改掉整个宿主 UI 的动效**（那是越界，也会让宿主的其他动画一起失效）。
       * 所以必须限定在**插件的挂载子树内**。而插件原先**没有共同根类**
       * （面板是 `.dshpz-panel`，侧边栏按钮是 `.dshpz-btn`），
       * 于是借 U1 顺手加了 `.dshpz-scope`，挂在**两个挂载点**上：
       * 主区面板容器 + 侧边栏图标按钮。从此所有全局性规则都有落脚点。
       *
       * `:where()` 把特异性压到 0，`!important` 才不会被更具体的选择器压回去。
       */
      '@media (prefers-reduced-motion:reduce){'
        + ':where(.dshpz-scope),:where(.dshpz-scope *),:where(.dshpz-scope *::before),:where(.dshpz-scope *::after)'
        + '{animation:none!important;transition:none!important;scroll-behavior:auto!important}'
        + '}',
    ].join('\n')

    /**
     * 系统是否开着「减少动态效果」。
     *
     * ## 为什么 JS 也要读它（v2.0.0，U5 缺口 C）
     *
     * CSS 的 `prefers-reduced-motion` **管不到 JS 驱动的动画**——拖拽跟手、FLIP 重排、
     * 滚动定位都是 JS 直接改 `transform`，媒体查询对它们完全无效。
     * 所以每处 JS 动画都必须**先问它**：为真就**直接落位**，不做过渡。
     *
     * ## 为什么每次都现读、不缓存
     *
     * 用户可以在会话进行中改系统设置（尤其是「省电模式」会自动打开它）。
     * 缓存住就会「改了设置还得刷新页面」。`matchMedia` 的查询对象本身是廉价的，
     * 读一次 `.matches` 只是一次属性访问。
     *
     * 取不到 `matchMedia`（老 WebView / 测试桩）时返回 `false`：
     * **默认做动画**——那是插件的正常行为，取不到偏好不该把动效全砍掉。
     */
    function motionOn() {
      try {
        var mm = window.matchMedia
        if (typeof mm !== 'function') return false
        return mm('(prefers-reduced-motion: reduce)').matches === true
      } catch (_error) {
        return false
      }
    }

    /**
     * ## 手上那张卡（v2.4.5）
     *
     * 一个**模块级**的 DOM 节点，拖拽期间跟着光标走。它不在 React 树里，
     * 理由见 CSS 那段（每帧一次全看板重渲染是性能红线）。
     *
     * 整个生命周期只有四个动作：`ghostGrab` → `ghostMove` → `ghostDrop` / `ghostBack`。
     * 收成四个具名函数而不是散在事件处理里，是因为**「谁负责清掉它」这件事必须唯一**：
     * 散着写就会出现「Esc 取消拖拽后它还挂在屏幕上」这类漏网。
     */
    var ghostNode = null
    /** 抓取点：用户按下时，手指在卡上的位置（相对卡片左上角）。 */
    var ghostGrabAt = { x: 0, y: 0 }
    /** 它出发时在屏幕上的位置——弹回的终点就是这里。 */
    var ghostOrigin = { x: 0, y: 0 }

    /**
     * 拿一张真卡在手上：按被拖那张卡的尺寸与外观造一个副本。
     *
     * ## 为什么是**两层**（外层定位、内层摇动）
     *
     * 因为两者都要写 `transform`，而一个元素只有一个 `transform`：
     * 摇动那条关键帧写的是 `rotate(...) translateX(...)`，它会**整个覆盖**掉
     * 定位用的 `translate(光标位置)`——于是卡会一边摇一边钉在视口左上角。
     * 分成两层后：外层管"在哪"，内层管"怎么晃"，互不干扰。
     *
     * 这也是本仓那条纪律的一个具体例子：**两个动效抢同一个属性时，
     * 不是去调优先级，而是让它们落在不同元素上**。
     */
    function ghostGrab(source, event, sway) {
      ghostDrop()
      if (typeof document === 'undefined' || document === null || typeof document.createElement !== 'function') return
      if (source === null || source === undefined) return
      var box = typeof source.getBoundingClientRect === 'function' ? source.getBoundingClientRect() : null
      if (box === null) return

      var outer = document.createElement('div')
      outer.className = 'dshpz-cardghost'
      // 尺寸钉死成原卡的实测值：手上那张要跟板上那张一样大，
      // 不能因为它脱离了列宽而变形（列宽才是卡宽的来源）。
      outer.style.width = box.width + 'px'
      outer.style.height = box.height + 'px'

      var inner = document.createElement('div')
      // 复制**渲染出来的样子**：类名与内容都照搬。
      inner.className = String(source.className || '') + (sway ? ' dshpz-cardsway' : '')
      inner.innerHTML = String(source.innerHTML || '')
      // 内层填满外层，于是它继承的宽度就是原卡宽度。
      inner.style.width = '100%'
      inner.style.height = '100%'
      outer.appendChild(inner)

      /**
       * 抓取点：光标在卡上的相对位置。
       *
       * 为什么必须记它、不能用「卡左上角贴着光标」：那样一按下卡就**跳**一下，
       * 因为用户多半不是从左上角抓的。记下他抓在哪，卡就一直停在他手底下
       * 原来的那个位置——这才是「抓着」。
       *
       * 取不到坐标（测试桩 / 老 WebView）时退回卡片中心：比贴左上角像样。
       */
      var hasPoint = event !== null && event !== undefined
        && isFinite(Number(event.clientX)) && isFinite(Number(event.clientY))
      ghostGrabAt = hasPoint
        ? { x: Number(event.clientX) - box.left, y: Number(event.clientY) - box.top }
        : { x: box.width / 2, y: box.height / 2 }
      ghostOrigin = { x: box.left, y: box.top }
      /**
       * 拿起来的这一刻就抬起（v2.4.17）。
       *
       * 为什么**不加过渡**：外层的 `transform` 在拖拽期间被 `ghostMove` 每几毫秒
       * 重写一次。给它挂 `transition` 会把**跟手**也一起过渡掉——卡会拖在光标
       * 后面慢慢追，那正是「失去控制」的手感（E4.5 的跟手要求）。
       *
       * 而 1.015 这个量级不加过渡也不会「跳」：它在 200px 的卡上是 3px，
       * 眼睛读到的是「这张卡忽然更实在了」，而不是「它弹了一下」。
       * 用**没有过渡的微小位移**换**完全跟手**，这个取舍是刻意的。
       */
      outer.setAttribute('data-lift', '1')
      outer.style.transform = ghostAt(box.left, box.top, true)
      document.body.appendChild(outer)
      ghostNode = outer
    }

    /**
     * 外层的位置：绝对屏幕坐标（`position:fixed` + 左上角原点，所以直接就是坐标）。
     *
     * ## v2.4.17：顺带把「抬起」的放大合成进来
     *
     * 为什么放大要写在这一处、而不是给内层加一条 CSS（见 CSS 里那段）：
     * 内层的 `transform` 已经被微摇动的关键帧独占，再叠一条会被动画压掉。
     * 而外层的 `transform` **本来就只由这个函数写**（`ghostGrab` 与
     * `ghostMove` 都走它），让它顺带拼一个 `scale` 是唯一的「一处写」方案。
     *
     * ## 为什么缩放原点在中心
     *
     * `translate(x, y)` 之后元素左上角在 `(x, y)`。要让**卡片中心**保持
     * 在光标下的同一处，缩放原点必须是卡片中心，所以补一个 `50% 50%`。
     * 不设的话默认原点在左上角，放大时卡会往右下「长」出去，
     * 抓取点就慢慢漂走了——用户会觉得「卡在我手里滑」。
     *
     * ## 为什么抬起量是 1.015
     *
     * 200px 宽的卡上约 3px。刚好够被感知成「它离我近了」，不够被注意成
     * 「它在放大」。幅度再大就变成弹跳，那是另一种语言（见母题里的禁用规则）。
     */
    function ghostAt(x, y, lift) {
      var scale = lift === true ? ' scale(1.015)' : ''
      return 'translate(' + x + 'px,' + y + 'px)' + scale
    }

    /** 跟着光标走（`dragover` 里每几毫秒一次，所以只改 `transform`）。 */
    function ghostMove(event) {
      if (ghostNode === null) return
      if (event === null || event === undefined) return
      if (!isFinite(Number(event.clientX)) || !isFinite(Number(event.clientY))) return
      // `lift` 必须一直带着：这个函数每次重写 `transform`，漏掉就等于「抬起来又落回去」。
      ghostNode.style.transform = ghostAt(
        Number(event.clientX) - ghostGrabAt.x,
        Number(event.clientY) - ghostGrabAt.y,
        true,
      )
    }

    /** 松手：手上那张消失。**唯一的清场入口**，所有结束路径都走它。 */
    function ghostDrop() {
      if (ghostNode === null) return
      if (ghostNode.parentNode !== null && ghostNode.parentNode !== undefined) {
        ghostNode.parentNode.removeChild(ghostNode)
      }
      ghostNode = null
    }

    /**
     * 被拒：手上那张**沿原路飞回原处**再消失（v2.4.5，用户拍板）。
     *
     * ## 为什么飞的是手上那张
     *
     * 板上那张从没离开过（跟着光标的是另造的一张）。所以「弹回」只能是
     * 手上那张飞回去——用户看到的是「我把它放回去了」。
     * 若改成让板上那张抖一下，那与他手上的动作无关，看着像另一个东西在动。
     *
     * ## 终点是 `ghostOrigin`，不是 `translate(0,0)`
     *
     * 外层是 `position:fixed;left:0;top:0`，所以 `translate(0,0)` 是**视口左上角**——
     * 卡会一路飞到一个跟它无关的地方。终点必须是它**出发时那个坐标**
     * （`ghostOrigin` = 原卡的 `getBoundingClientRect().left/top`）。
     *
     * ## 为什么要 `requestAnimationFrame` 等一帧
     *
     * `transition` 只在**属性真的发生变化**时才播。刚 append 的节点这一帧还没有
     * 起始值，直接改 `transform` 会被浏览器合并成「一开始就在终点」——卡瞬移回去，
     * 没有过渡。等一帧让它先落位，再改，过渡才会真的发生。
     */
    function ghostBack() {
      var node = ghostNode
      if (node === null) return
      ghostNode = null
      // 摇动要停：它是「在手上晃」，飞回去的过程中不该还在晃。
      var inner = node.firstChild
      if (inner !== null && inner !== undefined && inner.className !== undefined) {
        inner.className = String(inner.className).replace(' dshpz-cardsway', '')
      }
      node.setAttribute('data-back', '1')
      /**
       * 飞回去的过程中**把抬起放掉**（v2.4.17）：`ghostAt(..., false)` 不带 `scale`，
       * 于是过渡里同时发生「移回原处」与「缩回原尺寸」——那是「放下去了」。
       *
       * 只写 `translate` 也能回去，但卡会**一路保持放大**到落点才消失，
       * 看着像「它被吸走了」而不是「我把它放回去了」。
       */
      node.removeAttribute('data-lift')
      var finish = function () {
        if (node.parentNode !== null && node.parentNode !== undefined) node.parentNode.removeChild(node)
      }
      // 减少动效：直接落回原处并消失，不播过渡。
      if (motionOn()) {
        node.style.transform = ghostAt(ghostOrigin.x, ghostOrigin.y)
        finish()
        return
      }
      var step = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame
        : function (fn) { return setTimeout(fn, 16) }
      step(function () {
        node.style.transform = ghostAt(ghostOrigin.x, ghostOrigin.y)
        // 过渡结束就摘掉；取不到事件时兜底一个定时器（老 WebView 上 transitionend 可能不来）。
        var done = false
        var cleanup = function () {
          if (done) return
          done = true
          finish()
        }
        node.addEventListener('transitionend', cleanup)
        setTimeout(cleanup, 500)
      })
    }

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
      // 规则：列表带勾。
      rules: 'M2.4 4.2l1.4 1.4 2.4-2.4M2.4 11l1.4 1.4 2.4-2.4M8.6 5h5.4M8.6 11.8h5.4',
      // 审查：放大镜。
      scan: 'M7.2 2.6a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2Zm3.4 7.9l3 3',
      // 模块：方块阵。
      grid: 'M2.4 2.4h4.4v4.4H2.4V2.4Zm6.8 0h4.4v4.4H9.2V2.4ZM2.4 9.2h4.4v4.4H2.4V9.2Zm6.8 0h4.4v4.4H9.2V9.2Z',
      // 警示：三角。
      alert: 'M8 2.2l6 10.6H2L8 2.2Zm0 4v3.4M8 11.6v.1',
      // 归档：盒。
      archive: 'M2.2 3h11.6v3H2.2V3Zm1 3v7h9.6V6M6.4 8.6h3.2',
      // 更新：向下箭头落进托盘（v1.0.0 的更新入口用）。
      download: 'M8 1.8v7.4M5 6.4L8 9.4l3-3M2.6 11.4v2h10.8v-2',
      /**
       * 全局大脑（v2.2.0）：一个圆里三颗节点 + 连线（「一张网」的语义）。
       *
       * 描边型，所以走与 alert / rules 同一套线宽，视觉重量自动对齐。
       * 画的是「中心一颗、外围两颗、彼此相连」——大脑在这里的含义是
       * 「记得住整个项目、并把活派出去」，不是医学脑图。
       */
      brain: 'M8 5.6a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8Zm-4.2-3a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2Zm8.4 0a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2ZM5.9 6.6 4.9 4.6M10.1 6.6l1-2M8 10.4v2.2',
    }

    /**
     * 拼图块路径的**外接框**：`x 0.8..12.8`、`y 1.5..12.4`，中心 `(6.8, 6.95)`。
     *
     * 实测（Chromium 渲染后数像素）：`size = 18` 时
     *   - 宿主自带「插件」风车：墨迹 `18×18`，中心 `(9, 9)`；
     *   - 宿主自带「任务看板」时钟：墨迹 `16×16`，中心 `(9, 9)`；
     *   - 拼图块按 `0 0 16 16`：墨迹只有 `14×13`，中心 `(8, 7.5)`。
     *
     * 也就是说它**既小一圈、又偏左上**——填充块只画在 12×10.9 里，而宿主那几个
     * 描边图标的内容占到 15.5×15.5。侧边栏里四颗图标上下排开，这一颗就明显「没齐」。
     *
     * 修法：取景框收到内容自己的尺寸（边长 13.5 → 墨迹 `16×16`，与时钟一致），
     * 框心对准内容中心 `(6.8, 6.95)`。**不改路径**——路径本身画得对，错的是取景框。
     */
    var PUZZLE_BOX = '0.05 0.2 13.5 13.5'

    /**
     * 画一个图标。`size` 默认 14（与 12px 正文的视觉重量匹配）。
     * `stroke` 型图标（close/rules/scan/doc/alert/archive）走描边，
     * `fill` 型（puzzle/refresh/grid）走填充——两类混用时靠视觉重量对齐，不靠同一套线宽。
     *
     * `opts.box` 覆盖取景框，用于「填充块的实占范围天生比描边块小」这一种情况
     * （见 `PUZZLE_BOX`）。
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
        viewBox: extra.box === undefined ? '0 0 16 16' : extra.box,
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
            current === '' ? '当前：液态玻璃（内置默认 · 随宿主明暗）' : '当前：' + (currentName || current)),
        ),
        // ⚠️ 三页共用同一套分段控件（v2.1.1）：只在项目列表页画它，
        // 就是用户报的「切到主题页之后切不回去」。
        viewTabs(view),
        // 「恢复默认」固定在顶部（用户裁定）：换主题最怕回不去，所以它不跟着列表滚。
        h(
          'button',
          {
            className: 'dshpz-act',
            'data-tone': current === '' ? undefined : 'danger',
            disabled: current === '' || busy !== null,
            title: current === '' ? '现在就是液态玻璃（内置默认）' : '回到内置的液态玻璃（不卸载已下载的主题）',
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
            /**
             * 语义是**返回**而不是「关闭」：主题页是主视图的一种，关掉它等于关掉整个面板，
             * 那是右上角那颗 × 的事（用户会分不清）。
             *
             * ⚠️ **必须写 `view`，不能写 `themeOpen: false`**（v2.0.0）：`setState`
             * 现在把 `themeOpen` 当作 `view` 的**派生字段**，只在 `view` 出现时同步。
             * 只写 `themeOpen: false` 的话它会被 `view` 重新推回 `true`——
             * 表现是「点返回没反应」，而且不报错。
             */
            title: '返回项目列表（Esc）',
            onClick: function () {
              /**
               * v2.4.17：返回 = **往左走**。方向要显式给——`setState` 不认识
               * 「这是后退」，它只照着 patch 落值。
               */
              setState({
                view: 'projects',
                themeNotice: null,
                themeError: null,
                navDir: -1,
                navSeq: (state.navSeq || 0) + 1,
              })
            },
          },
          h('span', null, '← 返回'),
        ),
        h(
          'button',
          {
            className: 'dshpz-close',
            title: '关闭面板（Esc 先返回项目列表）',
            onClick: function () { closePanel() },
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
                  title: '从本机删掉这个主题的缓存' + (isCurrent ? '（会同时恢复液态玻璃）' : ''),
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
        h('div', { className: 'dshpz-tbody' },
          devSection(view, sessionId),
          grid,
        ),
        foot,
      )
    }

    /**
     * 主题页的「开发与分享」区（v1.0.0）。
     *
     * ## 为什么要有它（用户原话）
     *
     * 「主题添加一键进入自主开发此插件主题风格的功能，并且可一键上传」，
     * 随后澄清「**上传是让别人能够分享自己做的主题风格**」。
     *
     * 所以这一区回答三个问题，按用户的实际顺序排：
     *   1. **我要做一套** → 建脚手架 + 把开发提示词填进输入框；
     *   2. **怎么让别人用上** → 两条路：推到主题仓库（别人刷新列表就能装）、
     *      导出单文件主题包（发给对方粘贴导入，不依赖 git 与网络源）；
     *   3. **推之前要做什么** → 重算清单（sha256 必须现算）。
     *
     * ## 为什么「上传」按钮不叫「一键更新」
     *
     * 它确实只做到 `git push`，装到别人机器上还要对方点一下。文案如实写
     * 「推送到主题仓库」，别用一个含糊的「发布」让用户以为对方自动就有了。
     */
    function devSection(view, sessionId) {
      var repoState = view.state.themeRepo
      var repo = repoState !== null && repoState !== undefined && repoState.repo !== undefined ? repoState.repo : null
      var found = repo !== null && repo.found === true
      var busy = view.state.themeBusy
      var repoIds = repoState !== null && repoState !== undefined && Array.isArray(repoState.repoIds) ? repoState.repoIds : []
      var packs = repoState !== null && repoState !== undefined && Array.isArray(repoState.packs) ? repoState.packs : []
      var out = view.state.themePackOut
      var confirmOverwrite = view.state.themeConfirmOverwrite

      /**
       * 本机已装的主题——**从 `view.state.data.theme` 现取**，不复用 `themePage` 的局部变量。
       *
       * 实测踩过：第一版直接用了 `installed`（那是 `themePage` 里的局部变量），
       * 结果 `ReferenceError: installed is not defined`，面板整个渲染不出来。
       * 两个函数虽然在同一个闭包里，但**局部变量不共享**——这是最容易被
       * 「它俩挨着」骗过去的一类错，只有真跑一次才暴露。
       */
      var data = view.state.data
      var theme = data !== null && data !== undefined && data.theme !== undefined ? data.theme : null
      var installed = theme !== null && Array.isArray(theme.installed) ? theme.installed : []

      var rows = []

      rows.push(h('div', { className: 'dshpz-secttitle' }, '开发一套自己的主题'))

      if (!found) {
        // 找不到检出时**不报错**：大多数人只是用主题，不做开发。给一句可执行的下一步。
        rows.push(h('div', { className: 'dshpz-muted' },
          '没找到主题仓库的检出。想自己开发，把主题仓库克隆到工作区下名为 `dsh-puzzle-themes` 的目录里，' +
          '或者直接点下面「建脚手架」——它会替你在那里建好目录。'))
      } else {
        rows.push(h('div', { className: 'dshpz-muted' },
          '主题仓库：' + String(repo.path || '')
          + (repo.branch ? ' · 分支 ' + String(repo.branch) : '')
          + (repo.remote ? ' · 远端 ' + String(repo.remote) : ' · ⚠ 没有 remote，推不出去')
          + (repo.dirty === true ? ' · ' + String(repo.changes) + ' 个文件待提交' : ' · 工作区干净')
          + (repoIds.length > 0 ? ' · 已有 ' + repoIds.length + ' 套主题' : '')))
      }

      // 脚手架：一个输入框 + 一颗按钮。id 由用户给（中文名也能，id 会自动规范化）。
      rows.push(h('div', { className: 'dshpz-tdevrow' },
        h('input', {
          className: 'dshpz-tinput',
          type: 'text',
          placeholder: '主题 id（小写字母数字，如 aurora）',
          value: view.state.devId || '',
          onInput: function (event) { setState({ devId: String(event.target.value || '') }) },
        }),
        h('button', {
          className: 'dshpz-act',
          disabled: busy !== null,
          title: '在工作区建出 themes/<id>/{manifest.json,theme.css}，并把开发提示词填进输入框',
          onClick: function () { devTheme(sessionId, view.state.devId || '', view.state.devId || '') },
        }, h('span', null, busy === 'dev:' + (view.state.devId || '') ? '建中…' : '建脚手架 + 填提示词')),
      ))

      // 上传 / 重算清单：只在找到仓库时给（找不到时点了必然失败，给个死按钮没意义）。
      if (found) {
        rows.push(h('div', { className: 'dshpz-tdevrow' },
          h('button', {
            className: 'dshpz-act',
            disabled: busy !== null || (view.state.devId || '') === '',
            title: '用插件自己的校验器验一遍 CSS，再重算 index.json（sha256 现算）',
            onClick: function () { repairThemeIndex(sessionId) },
          }, h('span', null, busy === 'repair' ? '重算中…' : '重算清单')),
          h('button', {
            className: 'dshpz-act',
            'data-tone': 'accent',
            disabled: busy !== null || (view.state.devId || '') === '',
            title: '重算清单 → commit → git push。插件不读任何令牌，凭据由 git 自己的凭据链取',
            onClick: function () { publishTheme(sessionId, view.state.devId || '', view.state.devId || '') },
          }, h('span', null, busy === 'pub:' + (view.state.devId || '') ? '上传中…' : '上传（推送到主题仓库）')),
        ))
        rows.push(h('div', { className: 'dshpz-muted' },
          '上传只做 `git add / commit / push`，凭据由 git 自己的凭据链取——**插件代码里没有任何令牌路径**。' +
          '推上去之后，别人在主题页点「刷新列表」就能看到并一键安装。'))
      }

      // 发布步骤回显：每一步的成败都显示，不写死一句笼统的话。
      var steps = view.state.publishSteps
      if (Array.isArray(steps) && steps.length > 0) {
        rows.push(h('div', { className: 'dshpz-muted', style: { fontFamily: 'var(--dshpz-font-mono)', fontSize: '11px', lineHeight: '1.7' } },
          steps.map(function (row, index) {
            return h('div', { key: 'st' + index },
              (row.ok === true ? '✓ ' : '✗ ') + String(row.step || '') + (row.detail ? ' — ' + String(row.detail) : ''))
          })))
      }
      if (view.state.publishStderr) {
        rows.push(h('div', { className: 'dshpz-err' },
          h('pre', { className: 'dshpz-pre' }, String(view.state.publishStderr).slice(0, 2000))))
      }

      rows.push(h('div', { className: 'dshpz-secttitle' }, '分享给别人'))

      // 路一：导出单文件主题包（发给对方粘贴导入）。
      var exportables = []
      for (var i = 0; i < installed.length; i += 1) {
        exportables.push({ id: installed[i].id, name: installed[i].name, fromRepo: false })
      }
      for (var r2 = 0; r2 < repoIds.length; r2 += 1) {
        var already = false
        for (var e = 0; e < exportables.length; e += 1) if (exportables[e].id === repoIds[r2]) already = true
        if (!already) exportables.push({ id: repoIds[r2], name: repoIds[r2], fromRepo: true })
      }
      if (exportables.length === 0) {
        rows.push(h('div', { className: 'dshpz-muted' }, '还没有可导出的主题：先下载一套，或在工作区里建一套。'))
      } else {
        rows.push(h('div', { className: 'dshpz-tdevrow' }, exportables.slice(0, 8).map(function (item) {
          return h('button', {
            className: 'dshpz-act',
            key: 'ex' + item.id,
            disabled: busy !== null,
            title: '导出成一个 .json 主题包，发给别人粘贴导入',
            onClick: function () { exportPack(sessionId, item.id, item.fromRepo) },
          }, h('span', null, busy === 'exp:' + item.id ? '导出中…' : '导出「' + String(item.name || item.id) + '」'))
        })))
      }
      if (out !== null && out !== undefined && typeof out.text === 'string') {
        rows.push(h('div', { className: 'dshpz-muted' },
          '已导出：' + String(out.filename || '')
          + ' · ' + String(out.bytes || 0) + ' 字节'
          + ' · sha256 ' + String(out.sha256 || '').slice(0, 12) + '…'
          + (out.path ? ' · 已存到 ' + String(out.path) : '')))
        rows.push(h('div', { className: 'dshpz-tdevrow' },
          h('button', {
            className: 'dshpz-act',
            title: '把主题包文本复制到剪贴板，直接发给对方',
            onClick: function () {
              try {
                navigator.clipboard.writeText(String(out.text))
                setState({ themeNotice: '主题包已复制到剪贴板，发给对方即可' })
              } catch (_error) {
                setState({ themeError: '复制失败，请从下面文本框里手动全选复制' })
              }
            },
          }, h('span', null, '复制主题包到剪贴板')),
          h('button', {
            className: 'dshpz-act',
            title: '收起这段文本',
            onClick: function () { setState({ themePackOut: null }) },
          }, h('span', null, '收起')),
        ))
        rows.push(h('textarea', {
          className: 'dshpz-tpack',
          readOnly: true,
          value: String(out.text).slice(0, 20000),
          rows: 4,
        }))
      }

      // 路二：导入别人发来的主题包。
      rows.push(h('div', { className: 'dshpz-muted' }, '收到别人的主题包？粘贴到下面，导入即应用。'))
      rows.push(h('textarea', {
        className: 'dshpz-tpack',
        placeholder: '把主题包的 JSON 文本粘贴到这里',
        value: view.state.themePackText || '',
        rows: 3,
        onInput: function (event) { setState({ themePackText: String(event.target.value || '') }) },
      }))
      if (confirmOverwrite) {
        // 重名时不替用户决定：直接覆盖会把他原来那套删掉，不可逆。
        rows.push(h('div', { className: 'dshpz-tdevrow' },
          h('span', { className: 'dshpz-muted' }, '「' + String(confirmOverwrite) + '」已经装过——'),
          h('button', {
            className: 'dshpz-act',
            'data-tone': 'danger',
            disabled: busy !== null,
            title: '用这个包替换本机那份',
            onClick: function () { setState({ themeConfirmOverwrite: null }); importPack(sessionId, view.state.themePackText || '', true) },
          }, h('span', null, '替换')),
          h('button', {
            className: 'dshpz-act',
            disabled: busy !== null,
            title: '保留本机那份，什么都不做',
            onClick: function () { setState({ themeConfirmOverwrite: null, themeNotice: '已保留本机那份' }) },
          }, h('span', null, '保留本机')),
        ))
      } else {
        rows.push(h('div', { className: 'dshpz-tdevrow' },
          h('button', {
            className: 'dshpz-act',
            'data-tone': 'accent',
            disabled: busy !== null || (view.state.themePackText || '').trim() === '',
            title: '校验主题包（含 sha256 与 CSS 白名单），导入并立即应用',
            onClick: function () { importPack(sessionId, view.state.themePackText || '', false) },
          }, h('span', null, busy === 'import' ? '导入中…' : '导入并应用')),
          h('span', { className: 'dshpz-muted' }, packs.length > 0 ? '工作区里已导出 ' + packs.length + ' 个包' : ''),
        ))
      }

      // 「复制到剪贴板」在不可用环境（非 https / 无权限）下会抛错，上面已经兜住并提示手动复制。

      return h('div', { className: 'dshpz-tdev' }, rows)
    }

    /**
     * 「更新」页（v1.0.0）。
     *
     * ## 三件事，按用户的顺序
     *
     * 用户需求：「1.添加自动更新功能，检测到有新版本可选择更新 2.添加更新日志，
     * 拉取仓库的更新日志，说明更新内容」。
     *
     * 所以这一页从上到下就是：**当前版本 vs 线上版本 → 更新内容 → 下载 → 安装命令**。
     *
     * ## 为什么最后一步是「复制命令」而不是「一键安装」（用户裁定）
     *
     * 备选是让宿主直接跑 `pnpm add`。那是真的一键，但它有一个不可接受的失败模式：
     * **装坏了插件本身就加载不了，面板随之消失**——用户只剩手改 `package.json`
     * 这一条路，而那时他连界面都没有。所以边界划在：插件只写自己的缓存目录，
     * 装不装由用户执行那一条命令决定。
     *
     * 界面上必须把这件事**说清楚**：按钮叫「下载到暂存区」，不叫「更新」。
     * 叫「更新」会让用户以为点完就好了，然后发现版本没变——那是骗人。
     */
    function updatePage(view) {
      var data = view.state.update
      var staged = view.state.updateStaged
      var checking = data !== null && data !== undefined && data.checking === true
      var info = data !== null && data !== undefined && data.checking !== true ? data : null
      var busy = view.state.updateBusy === true

      var current = info !== null && info.current !== undefined ? String(info.current) : (staged !== null && staged !== undefined ? String(staged.current || '') : '')
      var latest = info !== null && info.latest !== undefined ? String(info.latest) : ''
      var state = info !== null && info.state !== undefined ? String(info.state) : ''

      var head = h(
        'div',
        { className: 'dshpz-thead' },
        h('span', { className: 'dshpz-tlogo' }, icon('download', 16)),
        h(
          'div',
          { className: 'dshpz-headtext' },
          h('h3', { className: 'dshpz-title' }, '更新'),
          h('div', { className: 'dshpz-sub' },
            current === '' ? '本机版本读不出来' : '当前 v' + current
            + (latest !== '' ? ' · 线上 v' + latest : '')
            + (state === 'newer' ? ' · 有新版本' : state === 'latest' ? ' · 已是最新' : state === 'ahead' ? ' · 本机比线上新（未发布的提交）' : '')),
        ),
        // 与主题页同一条理由：三页共用同一套分段控件，否则切过来就切不回去。
        viewTabs(view),
        h('button', {
          className: 'dshpz-act',
          disabled: checking,
          title: '重新对比线上版本并拉取更新日志',
          onClick: function () { checkUpdateNow() },
        }, h('span', null, checking ? '检查中…' : '重新检查')),
        h('button', {
          className: 'dshpz-act',
          // 语义是**返回**（与主题页同一条理由）：更新页是主界面的一种视图。
          // ⚠️ 写 `view`（真相字段）；传 `updateOpen: false` 也**能工作**了
          // （`setState` 现在双向派生），但那只是兼容路径，新代码照这条写。
          title: '返回项目列表（Esc）',
          onClick: function () {
            // v2.4.17：返回 = 往左走（与主题页那颗同一条）。
            setState({
              view: 'projects',
              updateNotice: null,
              updateError: null,
              navDir: -1,
              navSeq: (state.navSeq || 0) + 1,
            })
          },
        }, h('span', null, '← 返回')),
        h('button', {
          className: 'dshpz-close',
          title: '关闭面板（Esc 先返回项目列表）',
          onClick: function () { closePanel() },
        }, icon('close', 15, { weight: 'bold' })),
      )

      var notices = []
      if (view.state.updateNotice !== null && view.state.updateNotice !== undefined) {
        notices.push(h('div', { className: 'dshpz-notice', key: 'ok' }, icon('alert', 14), h('span', null, String(view.state.updateNotice))))
      }
      if (view.state.updateError !== null && view.state.updateError !== undefined) {
        notices.push(h('div', { className: 'dshpz-err', key: 'err' }, icon('alert', 14), h('span', null, String(view.state.updateError))))
      }
      if (view.state.updateHint !== '' && view.state.updateHint !== null && view.state.updateHint !== undefined) {
        notices.push(h('div', { className: 'dshpz-muted', key: 'hint' }, String(view.state.updateHint)))
      }
      // 各通道的诊断原样回显：拉不到时这一行才说得清是超时还是 404。
      var tried = view.state.updateTried !== null && Array.isArray(view.state.updateTried) ? view.state.updateTried
        : (info !== null && Array.isArray(info.tried) ? info.tried : [])
      if (tried.length > 0) {
        notices.push(h('div', {
          className: 'dshpz-muted', key: 'tried',
          style: { fontFamily: 'var(--dshpz-font-mono)', fontSize: '11px', lineHeight: '1.6' },
        }, tried.map(function (row, index) {
          return h('div', { key: 'tr' + index }, String(row.channel) + ' → ' + String(row.error))
        })))
      }

      var body = []

      // 安装结果优先显示：它是用户刚点的那个动作的结论，不该埋在下面。
      var run = view.state.updateRun
      /**
       * ⚠️ **只把「新鲜」的记录当成本次结果**（v2.4.19 修的真 bug）。
       *
       * 原先这里只判 `stage !== ''`，于是 `last-run.json` 里一条**8 天前**
       * 的失败记录会被渲染成「更新失败，**已自动回退**到 v1.1.2」，
       * 而同一屏下方又写着「已经是最近版本 v2.4.18」——**两句自相矛盾**，
       * 用户以为插件在发癫。
       *
       * 现在：新鲜的走原来的「本次结果」分支；过期的换成一句带时间的
       * 历史陈述（不删掉——「上次为什么没装上」是有用信息，只是不该冒充现在）。
       */
      var runCurrent = runIsCurrent(run)
      if (run !== null && run !== undefined && run.running === true) {
        // 安装器**自己**报了「我在跑」——这比面板的本地标志可靠（换页面/刷新都还在）。
        body.push(h('div', { className: 'dshpz-notice' }, icon('alert', 14),
          h('span', null, (run.phase === 'install' ? '正在安装' : '正在备份') + '…（独立进程 pid ' + String(run.pid || '?') + '，装完会自动刷新）')))
      } else if (view.state.updateInstalling === true) {
        body.push(h('div', { className: 'dshpz-notice' }, icon('alert', 14),
          h('span', null, '正在安装…（独立进程在跑，装完会自动刷新）')))
      }
      if (runCurrent && run !== null && run !== undefined && run.running !== true && run.stage !== '' && run.stage !== 'dry-run') {
        if (run.ok === true) {
          body.push(h('div', { className: 'dshpz-notice' }, icon('alert', 14),
            h('span', null, '已装好 v' + String(run.afterVersion || '') + '（从 v' + String(run.beforeVersion || '?') + '）——**重启 profile** 才生效。')))
        } else if (run.rolledBack === true) {
          body.push(h('div', { className: 'dshpz-err' }, icon('alert', 14),
            h('span', null, '更新失败，**已自动回退**到 v' + String(run.beforeVersion || '?') + '：' + String(run.error || ''))))
          if (run.rollback !== null && run.rollback !== undefined && Array.isArray(run.rollback.steps)) {
            body.push(h('div', { className: 'dshpz-muted', style: { fontFamily: 'var(--dshpz-font-mono)', fontSize: '11px', lineHeight: '1.7' } },
              run.rollback.steps.map(function (row, index) {
                return h('div', { key: 'rb' + index },
                  (row.ok === true ? '✓ ' : '✗ ') + '恢复 ' + String(row.target || '') + (row.skipped === true ? '（本来就没有）' : ''))
              })))
          }
          body.push(h('div', { className: 'dshpz-muted' },
            '你原来那版还在，插件照旧能用。失败原因在下面的「安装日志」里。'))
        } else {
          body.push(h('div', { className: 'dshpz-err' }, icon('alert', 14),
            h('span', null, '更新失败：' + String(run.error || '') + (run.rolledBack === true ? '（已回退）' : '（未回退）'))))
        }
      } else if (run !== null && run !== undefined && run.running !== true) {
        /**
         * 过期记录：**降级成一行灰色的历史说明**。
         *
         * 用 `dshpz-muted` 而不是 `dshpz-err`：它不是错误状态（当前一切都好），
         * 只是「以前发生过一件事」。红色横幅会让用户以为现在还坏着。
         */
        var stale = staleRunNotice(run)
        if (stale !== null) {
          body.push(h('div', { className: 'dshpz-muted', style: { marginTop: '10px', fontSize: '11.5px', lineHeight: '1.6' } }, stale))
        }
      }

      if (checking) {
        body.push(h('div', { className: 'dshpz-skel', style: { height: '96px' } }))
      } else if (info === null || info === undefined) {
        body.push(h('div', { className: 'dshpz-muted', style: { padding: '18px 4px' } },
          '点右上角「重新检查」对比线上版本。'))
      } else if (info.error !== undefined) {
        body.push(h('div', { className: 'dshpz-err' }, '检查更新失败：' + String(info.error)))
      } else {
        // ① 版本对比 + 一键更新。
        if (info.hasUpdate === true) {
          body.push(h('div', { className: 'dshpz-secttitle' }, '发现新版本 v' + latest))
          body.push(h('div', { className: 'dshpz-tdevrow' },
            h('button', {
              className: 'dshpz-act',
              'data-tone': 'accent',
              disabled: busy || view.state.updateInstalling === true,
              title: '交给独立进程去装：先备份 node_modules / package.json / lockfile 三处，装完自检（版本号 + 入口能否解析），任何一步不过就整体回退',
              onClick: function () { installUpdateNow(latest, info.tag) },
            }, h('span', null, view.state.updateInstalling === true ? '安装中…' : '一键更新到 v' + latest)),
            // 想先验一遍再装的人需要这条。
            h('button', {
              className: 'dshpz-act',
              disabled: busy || view.state.updateInstalling === true,
              title: '只下载到暂存目录并校验，不安装',
              onClick: function () { downloadUpdateNow(latest) },
            }, h('span', null, busy ? '下载中…' : '只下载到暂存区')),
          ))
          /**
           * 为什么敢做成一键（v1.0.1 改了主意，用户裁定「更新失败就回退」）。
           *
           * v1.0.0 的顾虑是「装坏了插件加载不了、面板消失、只剩手改 package.json」。
           * 那个顾虑是对的，但**解法不是不让装**，而是让**回退逻辑不依赖插件活着**：
           * 安装器是一个独立脚本，运行前被复制到 `$DSH_HOME` 下（不属于任何包），
           * 它自己备份三处、自己验、失败自己还原。装坏了也不影响它跑完。
           */
          body.push(h('div', { className: 'dshpz-muted' },
            '更新由**独立进程**执行：先把 `node_modules` / `package.json` / 锁文件三处备份，'
            + '装完自检（依赖声明、版本号、入口文件能否解析），**任何一步不过就整体回退**。'
            + '回退逻辑不在插件里，所以插件被装坏也照样能回退。'))
          if (info.tarball !== null && info.tarball !== undefined) {
            body.push(h('div', { className: 'dshpz-muted' },
              '安装包：' + String(info.tarball.name || '') + (info.tarball.size > 0 ? ' · ' + Math.round(info.tarball.size / 1024) + ' KB' : '')))
          }
        } else if (state === 'latest') {
          body.push(h('div', { className: 'dshpz-notice' }, icon('alert', 14), h('span', null, '已经是最新版本 v' + current + '。')))
        } else if (state === 'ahead') {
          body.push(h('div', { className: 'dshpz-muted' },
            '本机 v' + current + ' 比线上 v' + latest + ' 还新——说明你装的是尚未发布的提交。这不是问题，也不会被当成「有更新」。'))
        }

        // ② 各版本更新日志（v1.0.1，用户需求：「有个地方看各个版本的更新日志，而且要洁简」）。
        //
        // ⚠️ **不要传 `sessionId`**：`updatePage` 里没有这个变量（它不需要会话——
        // 更新是全局的），而 `releaseList` 也根本不用它。第一版写成
        // `releaseList(view, sessionId)`，结果渲染时 `ReferenceError: sessionId is not defined`
        // → React 整棵子树卸载 → **面板一打开就消失**。实测踩到。
        body.push(releaseList(view))
      }

      // ③ 装过之后才需要的东西：备份清单 + 安装日志（折叠在最后，不占视线）。
      var stagedInfo = staged !== null && staged !== undefined && staged.staged !== undefined ? staged : null
      if (stagedInfo !== null) {
        var backups = Array.isArray(stagedInfo.backups) ? stagedInfo.backups : []
        var list = Array.isArray(stagedInfo.staged) ? stagedInfo.staged : []
        if (backups.length > 0 || list.length > 0) {
          body.push(h('div', { className: 'dshpz-secttitle' }, '备份与暂存'))
          if (backups.length > 0) {
            body.push(h('div', { className: 'dshpz-muted' }, '最近几次安装前的备份（失败时用它回退）：'))
            body.push(h('div', { className: 'dshpz-muted', style: { fontFamily: 'var(--dshpz-font-mono)', fontSize: '11px', lineHeight: '1.7' } },
              backups.slice(0, 3).map(function (row, index) {
                return h('div', { key: 'bk' + index },
                  'v' + String(row.fromVersion || '?') + ' → ' + String(row.toTag || '?')
                  + (row.at ? ' · ' + String(row.at).slice(0, 16).replace('T', ' ') : ''))
              })))
          }
          if (list.length > 0) {
            body.push(h('div', { className: 'dshpz-muted', style: { fontFamily: 'var(--dshpz-font-mono)', fontSize: '11px', lineHeight: '1.7' } },
              list.map(function (row, index) {
                var meta = row.meta !== null && row.meta !== undefined ? row.meta : {}
                return h('div', { key: 'sg' + index },
                  '暂存 v' + String(row.version || '')
                  + ' · ' + String(meta.verified === 'sha256' ? 'sha256 已比对' : '结构校验'))
              })))
          }
          body.push(h('div', { className: 'dshpz-muted' }, '目录：' + String(stagedInfo.dir || '')))
        }
      }

      return h(
        'div',
        { className: 'dshpz-panel' },
        head,
        notices,
        h('div', { className: 'dshpz-tbody' }, body),
        h('div', { className: 'dshpz-tfoot' },
          h('div', { className: 'dshpz-muted' },
            '更新检查走 GitHub API（不通时退到 jsDelivr 读仓库里的 package.json 与 CHANGELOG.md）；' +
            '安装包从 Release 附件下载，正文里写了 sha256 就比对，没写就做结构校验并**如实标注**。'),
          h('div', { className: 'dshpz-muted' },
            '本插件的更新**不会**自动装进 profile——它只写自己的暂存目录，装不装由你决定。'),
        ),
      )
    }

    /**
     * 「各版本更新日志」区块（v1.0.1，v1.1.3 改成只认「## 摘要」区块）。
     *
     * ## 用户的两句原话决定了它的样子
     *
     * 「我要的是有个地方看**各个版本**的更新日志」→ 不是只看最新那一版，要能往下翻；
     * 「而且要**洁简，不要一大堆字**」→ v1.0.0 把整篇 Release 正文铺出来（实测 6194 字符），
     * 一屏放不下一个版本，那不叫看日志。
     *
     * v1.1.3 起用户的要求更明确：「**简短三句交代更新了什么**」。摘要不再取正文前 3 行
     * （那取到的是背景铺垫，v1.1.2 上实测三句里没有一句说「改了什么」），
     * 而是正文里的 `## 摘要` 区块——**没写就明说「这版没写摘要」**，不拿别的段冒充。
     *
     * 为什么不给「展开全文」：用户明确要的是简洁，列表里塞展开就等于把它变回长文。
     * 真要看全文，Release 页的链接就在每行右边。
     */
    function releaseList(view) {
      var data = view.state.releases
      var loading = data !== null && data !== undefined && data.loading === true
      var list = data !== null && data !== undefined && Array.isArray(data.releases) ? data.releases : null
      var error = data !== null && data !== undefined && data.error !== undefined ? String(data.error) : ''

      var rows = [h('div', { className: 'dshpz-secttitle' }, '各版本更新日志')]

      if (loading) {
        rows.push(h('div', { className: 'dshpz-skel', style: { height: '64px' } }))
        return h('div', null, rows)
      }
      if (error !== '') {
        rows.push(h('div', { className: 'dshpz-err' }, '拉更新日志失败：' + error))
        var tried = data !== null && data !== undefined && Array.isArray(data.tried) ? data.tried : []
        if (tried.length > 0) {
          rows.push(h('div', { className: 'dshpz-muted', style: { fontFamily: 'var(--dshpz-font-mono)', fontSize: '11px', lineHeight: '1.6' } },
            tried.map(function (row, index) { return h('div', { key: 'rt' + index }, String(row.channel) + ' → ' + String(row.error)) })))
        }
        return h('div', null, rows)
      }
      if (list === null) {
        rows.push(h('div', { className: 'dshpz-muted' }, '点右上角「重新检查」拉取。'))
        return h('div', null, rows)
      }
      if (list.length === 0) {
        rows.push(h('div', { className: 'dshpz-muted' }, '这个仓库还没有发布过版本。'))
        return h('div', null, rows)
      }

      rows.push(h('div', { className: 'dshpz-rel' }, list.map(function (item, index) {
        var summary = Array.isArray(item.summary) ? item.summary : []
        return h('div', { className: 'dshpz-relrow', key: 'rel' + index, 'data-cur': item.current === true ? '1' : '0' },
          h('div', { className: 'dshpz-relhead' },
            h('span', { className: 'dshpz-relver' }, 'v' + String(item.version || '')),
            item.current === true ? h('span', { className: 'dshpz-tbadge' }, '当前') : null,
            item.prerelease === true ? h('span', { className: 'dshpz-tbadge' }, '预发布') : null,
            h('span', { className: 'dshpz-relname' }, String(item.name || '')),
            h('span', { className: 'dshpz-reldate' }, String(item.publishedAt || '').slice(0, 10)),
          ),
          summary.length > 0
            ? h('div', { className: 'dshpz-relsum' }, summary.map(function (line, li) {
              return h('div', { key: 'sl' + li }, String(line))
            }))
            // 「这版没写摘要」要**明说**。老版本（v1.1.2 及以前）正文里没有 `## 摘要` 区块，
            // 显示成「（这一版没有单独的说明）」会让人以为这版真没改什么。
            : h('div', { className: 'dshpz-muted' }, item.summaryMissing === true ? '（这版没写摘要）' : '（这一版没有单独的说明）'),
          // 超出行数时明说还有多少——静默截断会让人以为这版就这么点内容。
          item.summaryTruncated === true
            ? h('div', { className: 'dshpz-reldate' }, '…还有 ' + String(item.summaryRest || 0) + ' 行')
            : null,
        )
      })))
      return h('div', null, rows)
    }

    /**
     * 大读数：环形进度 + 百分比 + 一句状态。
     *
     * 为什么值得单独做一块：面板里其它数字都是细节，只有「项目健康性」是**一句话结论**。
     * 环形（而不是横条）是因为它在两栏布局里占地更方，且环心天然适合放那个大数字。
     *
     * 环用 SVG `stroke-dasharray` + `stroke-dashoffset` 画：纯 CSS/SVG，不引图表库。
     * 半径 44、周长 2πr≈276.5——`offset = 周长 × (1 - 分数/100)`。
     *
     * ⚠️ **尺寸必须与 CSS 的 `.dshpz-ring` / `.dshpz-ringnum` 一致**：v2.1.1 把环从
     * 74 放大到 104 时，这里的三处数字（width/height/viewBox 与 cx/cy/r）**一处不改就会错位**
     * ——SVG 会按 viewBox 缩放，圆心与半径却还按 37/30 算，环就画偏了。
     * 所以半径与中心都从 `SIZE` 推出来，只改一个数。
     */
    /**
     * ## 主读数「爬升」的插值（v2.4.17）
     *
     * 健康性从 62 变成 78 时，数字**直接换掉**——用户得先记住刚才那个数，
     * 才知道变了多少。爬升把「变了」这件事说出来：眼睛看到它在动，
     * 于是「它变了」不需要再比对。
     *
     * ## 为什么是**整数**爬升，而不是逐位竖条（E2.3 的数字滚动）
     *
     * 逐位竖条适合金额与计数器（位数固定、要「落定」感）。这里是一个
     * 0–100 的百分数，逐位竖条会带来一个**不可接受**的问题：
     * 十位与个位分别滚，中途会出现「十位已经到 8、个位还在 7」的读数
     * （显示 87 而真实是 82）——**读数是业务值，不能中途说谎**。
     * 整数爬升则保证显示的每一个值都**曾经真实存在过**（62…78 之间的整数），
     * 且严格单调、不越界。
     *
     * ## 为什么用 `easeOut` 的数值近似而不是线性
     *
     * 线性爬升会让「变化」在整段时间里均匀发生，观感像进度条。
     * 而这个数字是**结论**，它应该「快到位、慢慢停稳」——那是 `easeOut`
     * 的性格（与环形那圈 `stroke-dashoffset` 的过渡曲线**必须同一条**，
     * 否则数字到了 78、环还在 70，两个读数打架）。
     *
     * 这里用 `cubicOut`（`1-(1-t)³`）与 CSS 的 `--dshpz-ease-out` 同族，
     * 且它是**纯函数**：给定 from/to/t 就有确定结果，测试可以直接驱动它，
     * 不必去 mock 一个 rAF 时钟。
     *
     * @param from 起始值（`null` = 没有起始值，直接给 `to`）
     * @param to 目标值
     * @param t 归一化进度 0–1
     * @returns 当前应显示的**整数**（已夹紧在 from 与 to 之间）
     */
    function countUpValue(from, to, t) {
      var target = Math.max(0, Math.min(100, Math.round(Number(to) || 0)))
      if (from === null || from === undefined) return target
      var start = Math.max(0, Math.min(100, Math.round(Number(from) || 0)))
      var p = Math.max(0, Math.min(1, Number(t) || 0))
      if (start === target) return target
      /**
       * `cubicOut` 在 [0,1] 上**严格单调且值域就在 [0,1]**（这是它的定义性质，
       * 不是巧合），所以插值结果天然落在两端之间——**不需要再夹一次**。
       *
       * ⚠️ 这条注释是有意留下的：本函数一度在末尾又写了一遍
       * `Math.max(lo, Math.min(hi, value))`。那层夹紧**永远不生效**，
       * 而它有害：变异测试里把曲线改成会过冲的公式时，夹紧把越界值救了回来，
       * 于是「读数越界」这条测试**抓不到回归**——一个不会失败的断言等于没有断言。
       * 删掉它之后，同样的变异立刻变红。
       *
       * 结论：**曲线本身选对，比事后夹紧更可靠**（也正是母题禁用规则 ④
       * 「不用动画伪造」的技术前提——读数不说谎靠的是单调曲线，不是靠 clamp）。
       */
      var eased = 1 - Math.pow(1 - p, 3)
      return Math.round(start + (target - start) * eased)
    }

    /**
     * 主读数环 + 数字（v2.4.17：数字会从旧值爬升到新值）。
     *
     * ## 为什么它是组件、而 `heroRing` 是纯函数
     *
     * 爬升需要**跨渲染记住上一个值**（这次是 62、下次 78，要知道从 62 起爬），
     * 而「记住」只能靠 hook。纯函数拿不到上一帧的值。
     *
     * 所以拆成两层：
     *   - `heroRing` 保持纯函数（几何计算，测试直接驱动它）；
     *   - `HeroRing` 这个组件只负责「上一个值 → 当前值」的过渡。
     *
     * ## 为什么用 `useRef` 而不是 state 记上一个值
     *
     * 上一个值**不需要触发重渲染**——它只在下一次渲染时被读。用 state 会
     * 多出一次渲染（每 8 秒轮询都多一次），而 ref 不会。
     *
     * ## 为什么动画用 rAF 手动驱动，而不是 CSS 过渡
     *
     * CSS 过渡只能过渡**数值属性**（`width`、`opacity`…），不能过渡
     * `textContent`。数字爬升本质是「连续写入不同的文本」，只能由 JS 算。
     * 而既然要 JS 算，就用项目已有的时钟纪律：`rAF` + `motionOn()` 门控。
     */
    function HeroRing(props) {
      var target = Math.max(0, Math.min(100, Math.round(Number(props.score) || 0)))
      var previous = React.useRef(null)
      var frame = React.useRef(null)
      /**
       * 当前显示值。`null` = 还没开始爬（首帧直接显示目标值）。
       *
       * 为什么首帧**不爬**：打开面板时从 0 爬到 62 是在演一场「它在增长」的
       * 戏，而事实是这个数字一直都在——那是**伪造过程**（母题的禁用规则 ④）。
       * 只有「它真的变了」才值得爬。
       */
      var pair = React.useState(null)
      var shown = pair[0]
      var setShown = pair[1]

      React.useEffect(
        function () {
          var from = previous.current
          previous.current = target
          /**
           * 首帧、或值没变：直接显示目标值，不起动画。
           *
           * ⚠️ 「值没变」也要**显式设一次**：轮询每 8 秒重渲染，若不设，
           * `shown` 会停在 `null`（首帧的分支只跑一次），数字就永远空白。
           */
          if (from === null || from === undefined || from === target) {
            setShown(target)
            return undefined
          }
          // 减少动效：直接落定。CSS 的媒体查询管不到 JS 写的文本。
          if (motionOn()) {
            setShown(target)
            return undefined
          }
          /**
           * 爬升：360ms。
           *
           * 为什么比环形的 `--dshpz-dur-slow`（320ms）略长：
           * 环是**形状**，眼睛对它的到位不敏感；数字是**读数**，
           * 爬太快会糊成一串跳动的数（尤其 62 → 78 只跳 16 次），
           * 略慢一点才能被读成「它在往上走」而不是「它在闪」。
           */
          var DURATION = 360
          var startedAt = null
          var step = function (ts) {
            if (startedAt === null) startedAt = ts
            var t = DURATION <= 0 ? 1 : (ts - startedAt) / DURATION
            if (t >= 1) {
              setShown(target)
              frame.current = null
              return
            }
            setShown(countUpValue(from, target, t))
            frame.current = typeof window.requestAnimationFrame === 'function'
              ? window.requestAnimationFrame(step)
              : null
          }
          frame.current = typeof window.requestAnimationFrame === 'function'
            ? window.requestAnimationFrame(step)
            : null
          /**
           * 清理：**必须取消**。
           *
           * 每 8 秒轮询都会重跑这个 effect（依赖 `target` 没变时不重跑，
           * 但值一变就会）。不取消的话，上一轮的 rAF 会继续往
           * `setShown` 里写旧目标的值——数字会在两个值之间来回跳。
           */
          return function () {
            if (frame.current !== null && typeof window.cancelAnimationFrame === 'function') {
              window.cancelAnimationFrame(frame.current)
            }
            frame.current = null
          }
        },
        [target],
      )

      var ring = heroRing(target)
      if (shown === null || shown === undefined) return ring
      /**
       * 把环里那个数字换成**爬升中的值**。
       *
       * 为什么不重写整个 `heroRing`：几何部分（环的 `stroke-dashoffset`）
       * 只跟**目标值**走，它由 CSS 过渡自己滑过去（见 `.dshpz-ringfill` 的
       * `transition:stroke-dashoffset`）。数字则是 JS 逐帧写的。
       * 两者共用同一个 `easeOut` 性格、同一个终点——于是它们会一起到位。
       *
       * 改写方式：`heroRing` 返回的元素树里，最后那个 `.dshpz-ringnum`
       * 的子节点是字符串。这里换掉它，其余原样复用。
       */
      if (ring === null || ring === undefined || !Array.isArray(ring.children)) return ring
      var children = ring.children.slice()
      var lastIndex = children.length - 1
      var last = children[lastIndex]
      if (last !== null && last !== undefined && last.props !== undefined
        && String(last.props.className || '').indexOf('dshpz-ringnum') >= 0) {
        children[lastIndex] = h('div', { className: 'dshpz-ringnum' }, String(shown))
      }
      return h('div', { className: ring.props.className }, children)
    }

    /**
     * 环 + 数字的**纯几何**渲染（不含爬升）。
     *
     * 为什么不把爬升直接写进这里：这个函数是**纯函数**，给定分数就给出确定的
     * 元素树——测试可以直接驱动它断言几何（环的 `stroke-dashoffset`、中心、
     * 半径），不必 mock 时钟或 hook。爬升那部分跨渲染记忆状态，必须靠 hook，
     * 所以它在 `HeroRing` 里。
     *
     * 分工是刻意的：**几何归纯函数，时间归组件**。
     */
    function heroRing(score) {
      var value = Math.max(0, Math.min(100, Number(score) || 0))
      var SIZE = 104
      var CENTER = SIZE / 2
      var R = 44
      var C = 2 * Math.PI * R
      var offset = C * (1 - value / 100)
      return h(
        'div',
        { className: 'dshpz-ring' },
        h(
          'svg',
          { width: SIZE, height: SIZE, viewBox: '0 0 ' + SIZE + ' ' + SIZE, 'aria-hidden': true },
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
          h('circle', { className: 'dshpz-ringcircle', cx: CENTER, cy: CENTER, r: R }),
          h('circle', {
            className: 'dshpz-ringfill',
            cx: CENTER,
            cy: CENTER,
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
     * 而它的直接效果是改条目上限（悬而未决 / 已定 / 坑的条数与字数）。
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
      /**
       * 三档的悬停说明。
       *
       * ⚠️ **文案必须与 `SIZE_CAPS` 的真值一致**（这里修过一个真 bug）：
       * 大档原先写「坑 60 条」，而 `SIZE_CAPS.大.pit` 是 `null`（**不限**）——
       * 于是悬停说 60、下面「当前上限」那行显示「坑 不限」，**同一屏两句话打架**。
       * 那条 60 是历史遗留：`constants.js` 的注释里专门记了「原先写 60 是错的，
       * 切到大档反而收紧」，改常量时漏改了这里的文案。
       *
       * 教训：**上限数字不要在两处各写一遍**。这里保留文字说明是因为它要讲「档位语气」
       * （收紧 / 默认 / 放宽），但每个数字都要与常量对得上——改常量时回来核这一处。
       */
      var hints = {
        '小': '小项目：条目收紧（悬而未决 4 / 已定 6，坑 10 条）',
        '中': '中项目：默认档（悬而未决 4 / 已定 10，坑不限）',
        '大': '大项目：条目放宽（悬而未决 12 / 已定 30，坑不限；字数也放宽）',
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
        // 每张卡的主读数放大：它是「这个模块健康不健康」的唯一答案。
        h('div', { className: 'dshpz-tilescore', 'data-empty': empty ? '1' : '0' }, empty ? '未建' : piece.score + '%'),
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

    /**
     * 一个「条目小节」：**可折叠的标题** + 计数 + 逐条卡片（v2.1.8 起可折叠）。
     *
     * ## 默认折叠（用户要求「给条目加一个默认折叠的功能」）
     *
     * 一个模块最多五组（要点 / 悬而未决 / 已定 / 可复用 / 详细记录），
     * 每组上限 20 条（详细记录 50 字 × 20 条）——全铺开时右栏要滚很久，
     * 而多数时候只想看「哪组有几条、有没有超字的」。
     *
     * 展开态从 `view.state.entryOpen[heading]` 读。**默认（`entryOpen` 为 null）
     * 一律折叠**——那是「默认折叠」这条要求的落点。
     *
     * ⚠️ 折叠是**用 CSS 隐藏**（`.dshpz-secbody[data-open="0"]{display:none}`），
     * 卡片仍然渲染在树里。这样「折叠」不会改变树的内容，
     * 只改变可见性——下游（包括既有的树断言）看到的东西不变。
     */
    function entrySection(view, heading, text, limit, requireSource) {
      var cards = entryCards(text, limit, requireSource)
      if (cards.length === 0) return null
      var openMap = view.state.entryOpen
      var open = openMap !== null && openMap !== undefined && openMap[heading] === true
      return h(
        'div',
        { key: heading },
        /**
         * 标题是一颗**整行按钮**：点名字或点计数都能开合，不必精确点到箭头。
         * 折叠态下这是唯一可见的一行，所以 `title` 要写清「点开看什么」。
         */
        h(
          'button',
          {
            type: 'button',
            className: 'dshpz-sechead',
            'data-open': open ? '1' : '0',
            title: open ? '收起「' + heading + '」' : '点开看「' + heading + '」的 ' + cards.length + ' 条',
            onClick: function () { toggleEntrySection(heading) },
          },
          h('span', { className: 'dshpz-seccaret' }, open ? '▾' : '▸'),
          h('span', { className: 'dshpz-entryheadname' }, heading),
          h('span', { className: 'dshpz-entryheadnote' }, cards.length + ' 条 · 每条 ≤' + limit + ' 字 + 出处'),
        ),
        h('div', { className: 'dshpz-secbody', 'data-open': open ? '1' : '0' },
          h('div', { className: 'dshpz-entries' }, cards)),
      )
    }

    /**
     * 开合一个条目小节（v2.1.8）。
     *
     * 每次点击**只改这一个键**，不整体替换：用户可能同时展开好几组对着看
     * （比如「悬而未决」和「已定」要一起读），整体替换会把别的组一起收掉。
     *
     * 纯逻辑抽在 `nextEntryOpen` 里：开合规则（互不影响 / 可逆）是**可以离线断言**
     * 的，而 `setState` 那一步在假 React 里读不回来。分开之后，测试驱动的是
     * 真正的规则，而不是「我手写一个期望的 state 再喂进去」那种自证。
     */
    function toggleEntrySection(heading) {
      setState({ entryOpen: nextEntryOpen(state.entryOpen, heading) })
    }

    /**
     * 算出「点一下 `heading` 之后」的展开表（纯函数，不改任何状态）。
     *
     * 契约：
     *   - 只翻转 `heading` 这一个键，**其余键原样保留**；
     *   - 已经是展开的 → 收起（可逆）；
     *   - 入参为 `null`（默认全折叠）→ 返回只带这一个键的表。
     */
    function nextEntryOpen(current, heading) {
      var next = {}
      if (current !== null && current !== undefined) {
        for (var key of Object.keys(current)) next[key] = current[key]
      }
      if (next[heading] === true) delete next[heading]
      else next[heading] = true
      return next
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
            h('div', { className: 'dshpz-entryhead' }, h('span', { className: 'dshpz-entryheadname' }, '五维健康性')),
            h('div', { className: 'dshpz-dims' }, DIMENSION_KEYS.map(function (key) {
              return dimensionRow(key, detail.dimensions[key] || 0)
            })),
          ))
        }
        // 逐条渲染（书签式）：模块索引指向模块文档，所以不强制源码出处。
        var sections = [
          entrySection(view, '要点', detail.points, 20, true),
          entrySection(view, '悬而未决', detail.pending, 20, true),
          entrySection(view, '已定', detail.decided, 20, true),
          entrySection(view, '可复用', detail.reuse, 20, true),
          entrySection(view, '详细记录 · 轮汇报', detail.detail, 50, true),
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
     * 样式没生效时那块告警（一级页与二级页都要用，所以抽出来）。
     *
     * 为什么必须**两处都渲染**：一级页是用户看到的第一屏，而「面板没样式」
     * 恰恰会让人以为「插件坏了」而不是「样式没加载」。只在二级页显示，
     * 等于把最容易出问题的第一屏放过去了。
     */
    function styleWarningOf(view) {
      var diag = view.state.styleDiag
      if (diag === null || diag === undefined || diag.applied !== false) return null
      return h(
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
    }

    /**
     * **新建任务单浮窗**（v2.2.7 从整页改成浮窗）。
     *
     * 两步：① 写需求 → 点「一键分解」→ ② 三个框被填上且可改 → 点「创建」落卡。
     *
     * ## 为什么从整页改成浮窗
     *
     * 原先 `newTaskPage` 直接**替换掉整个看板**。于是新建完一张卡，用户看不到
     * 自己刚建的那张落在哪——「建好了」和「卡出现在未澄清列」被拆到了两屏。
     * 浮在看板上之后，这两件事在**同一屏内**构成因果。
     *
     * ## 三个关键行为（都来自拍板，不是自选）
     *
     * 1. **分解是「帮用户把一段话理成结构」，不是「一次生成不可动」**——三个框都可改；
     * 2. **需求原文一字不改地留在卡上**（`sourceRequest`）：分解产物是模型的解释，
     *    原文才是事实。任何时候都能回头看用户当初到底说了什么；
     * 3. **创建后不自动弹澄清器**：用户可能还要连建几张卡，立刻提问会打断他。
     *
     * ## 文案为什么这么短（v2.2.7）
     *
     * 窗只有 420px 宽，说明文字占的行数直接决定要不要滚动。凡是**能由占位符表达**的
     * 都不再写成正文：原来那三段「写一段需求（随便写，一大段也行）…」其实全在
     * placeholder 与按钮 title 里说过了。只保留两条**占位符说不清**的：
     * 「一次模型调用会花钱」与「原文会留档」。
     */
    function newTaskFloat(view) {
      var form = view.state.newTask || {}
      var busy = form.busy === true
      var missing = Array.isArray(form.missing) ? form.missing : []
      var missingLabel = { title: '标题', objective: '目标', description: '描述' }
      var ready = String(form.title || '').trim() !== ''
      var close = function () { setState({ newTask: null, error: null }) }
      return h(
        'div',
        { className: 'dshpz-ntwrap' },
        h(
          'div',
          { className: 'dshpz-ntbox' },
          h(
            'div',
            { className: 'dshpz-nthead' },
            '新建任务单',
            h('button', { className: 'dshpz-act', title: '关闭', onClick: close }, icon('close', 12)),
          ),
          h('textarea', {
            className: 'dshpz-in',
            style: { minHeight: '68px', resize: 'vertical' },
            placeholder: '写一段需求，随便写，一大段也行…',
            value: form.request || '',
            onChange: function (event) {
              setState({ newTask: Object.assign({}, form, { request: event.target.value }) })
            },
          }),
          h(
            'div',
            { className: 'dshpz-acts' },
            h('button', {
              className: 'dshpz-act',
              disabled: busy,
              title: '由模型整理成标题 / 目标 / 描述（一次模型调用，会花钱）',
              onClick: function () { decomposeTask(view) },
              // 转圈圈挂在**文字右边**（用户指定）：`.dshpz-act` 是 inline-flex，
              // 子节点顺序就是视觉顺序。放左边会把「一键分解」四个字推走，
              // 按钮宽度在忙碌/空闲之间跳一下——放右边则文字位置始终不动。
            }, busy ? '分解中' : '一键分解', busy ? h('span', { className: 'dshpz-spin' }) : null),
          ),
          form.error !== null && form.error !== undefined
            ? h('div', { className: 'dshpz-err' }, icon('alert', 14), h('span', null, String(form.error)))
            : null,
          missing.length > 0
            ? h('div', { className: 'dshpz-warn' }, icon('alert', 14),
              h('span', null, '模型没给：' + missing.map(function (key) { return missingLabel[key] || key }).join(' / ') + '，自己补上。'))
            : null,
          h('input', {
            className: 'dshpz-in',
            placeholder: '标题（一句话）',
            value: form.title || '',
            onChange: function (event) { setState({ newTask: Object.assign({}, form, { title: event.target.value }) }) },
          }),
          h('textarea', {
            className: 'dshpz-in',
            style: { minHeight: '40px', resize: 'vertical' },
            placeholder: '目标（可判定，将来直接当 goal）',
            value: form.objective || '',
            onChange: function (event) { setState({ newTask: Object.assign({}, form, { objective: event.target.value }) }) },
          }),
          h('textarea', {
            className: 'dshpz-in',
            style: { minHeight: '48px', resize: 'vertical' },
            placeholder: '描述（做什么 / 边界 / 约束）',
            value: form.description || '',
            onChange: function (event) { setState({ newTask: Object.assign({}, form, { description: event.target.value }) }) },
          }),
          h(
            'div',
            { className: 'dshpz-acts' },
            h('button', {
              className: 'dshpz-act',
              disabled: !ready || view.state.taskBusy === true,
              title: ready ? '落在「未澄清」列（不会自动开澄清器）' : '标题不能为空',
              onClick: function () { createTask(view) },
            }, '创建'),
            h('button', { className: 'dshpz-act', onClick: close }, '取消'),
          ),
          String(form.request || '').trim() === ''
            ? null
            : h('div', { className: 'dshpz-hint', style: { marginTop: '2px', paddingTop: '8px' } },
              '需求原文会原样留在卡上（`sourceRequest`）。'),
        ),
      )
    }

    /**
     * 派单系统子页（U4 子页二）。
     *
     * 五列看板：宽屏并排（可拖拽）、窄屏单列 + 列标签 + 显式按钮（U4 Q8）。
     * 列名与流转规则**引宿主下发的常量**，不在客户端重写一份——
     * 重写就会漂移，而漂移的表现是「界面上允许的移动，宿主拒绝了」。
     */
    function dispatchBoard(view) {
      var board = view.state.board
      /**
       * 新建任务单浮窗（v2.2.7）：**浮在看板上**，不再整页替换。
       *
       * 它挂进 `.dshpz-dispatch`（那个容器已 `position:relative`），由 `.dshpz-ntwrap`
       * 绝对定位铺满看板区。这样「点创建 → 卡出现在未澄清列」在**同一屏内**可见。
       */
      var newTaskOpen = view.state.newTask !== null && view.state.newTask !== undefined
      var float = newTaskOpen ? newTaskFloat(view) : null
      var columns = [
        ['unclarified', '未澄清'],
        ['pending', '未接单'],
        ['doing', '在做'],
        ['done', '已做'],
        ['failed', '失败'],
      ]
      /**
       * **卡片跨列飞入**（U5 #12）。
       *
       * ## 为什么需要它
       *
       * 卡片换列如果「啪」一下出现在另一列，用户得**重新扫一遍整个看板**
       * 才知道刚才那下点成功了没有、卡跑哪去了。飞入（透明度 + 轻微缩放）
       * 让「它刚动过」这件事一眼可见。
       *
       * ## 怎么触发（`flyId`）
       *
       * 搬卡成功后（`moveCard` 的回包）把那张卡的 id 记进 `state.flyId`，
       * 渲染时给它挂 `.dshpz-cardfly`。动画放完由 `onAnimationEnd` 清掉——
       * **不清的话，下一次轮询重渲染会重新播一遍**，看板会一直闪。
       *
       * ## 为什么先问 `motionOn()`
       *
       * CSS 的 `prefers-reduced-motion` **管不到「要不要挂这个类」这件事**——
       * 它只能把动画时长压成 0（那已经由作用域通配规则做了）。
       * 但挂类还会带来一次 `animationend` 事件与一次重排，所以这里**显式不挂**
       * （U5 缺口 C：JS 驱动的动效要自己读偏好）。
       */
      var flyId = motionOn() ? view.state.flyId : null
            /**
       * 窄屏形态（U4 拍板 Q8）：**单列视图 + 列标签切换 + 显式右移按钮，不做拖拽**。
       *
       * 判据是**窗口宽度**，不是「设备类型」——平板横竖屏、桌面窄窗口都会跨过 900px。
       * 这里读一次宽度决定渲染形态；窗口 resize 由 `state.narrow` 在挂载时同步。
       */
      var narrow = view.state.narrow === true
      var activeCol = view.state.boardCol || 'unclarified'
      var cardsOf = function (key) {
        if (board === null || board === undefined || !Array.isArray(board.cards)) return []
        return board.cards.filter(function (card) { return card.column === key })
      }
      /**
       * ## 「这一列收不收」的判据来自宿主（v2.4.5）
       *
       * 拖到某一列时要不要显示「不接收」的样子，必须在**松手之前**就知道。
       * 而那条规则住在 `moveVerdict`（宿主侧）——所以宿主把它随看板一起下发
       * （`result.forbidden`）。面板**不自己写一份**：抄一份就是两套规则，
       * 迟早漂移成「高亮说能放、松手却被拒」。
       *
       * ⚠️ 取不到（老宿主 / 还没刷新）时返回 `false`——**宁可不预告也不要假预告**：
       * 说"能放"而实际被拒，比不预告更让人困惑。
       */
      var forbiddenOf = function (from, to) {
        var table = board !== null && board !== undefined ? board.forbidden : null
        if (table === null || table === undefined || typeof table !== 'object') return false
        var banned = table[from]
        return Array.isArray(banned) && banned.indexOf(to) >= 0
      }
      /** 当前正被拖的那张卡在哪一列（预告「收不收」要知道起点）。 */
      var dragFromCol = function () {
        if (board === null || board === undefined || !Array.isArray(board.cards)) return null
        var id = view.state.dragId
        if (id === null || id === undefined) return null
        for (var i = 0; i < board.cards.length; i += 1) {
          if (String(board.cards[i].id) === String(id)) return board.cards[i].column
        }
        return null
      }
      if (narrow) {
        var one = cardsOf(activeCol)
        return h(
          'div',
          { className: 'dshpz-dispatch' },
          brainBar(view),
          h(
            'div',
            { className: 'dshpz-boardtabs' },
            columns.map(function (pair) {
              return h(
                'button',
                {
                  key: pair[0],
                  className: 'dshpz-boardtab',
                  'data-on': activeCol === pair[0] ? '1' : '0',
                  onClick: function () { setState({ boardCol: pair[0] }) },
                },
                pair[1],
                h('span', { className: 'dshpz-boardtabn' }, String(cardsOf(pair[0]).length)),
              )
            }),
          ),
          h(
            'div',
            { className: 'dshpz-boardcol', 'data-col': activeCol, 'data-empty': one.length === 0 ? '1' : '0' },
            one.length === 0
              ? h(
                'div',
                { className: 'dshpz-boardempty' },
                h('span', { className: 'dshpz-boardemptyicon' }, icon('grid', 15)),
                h('span', null, activeCol === 'unclarified' ? '还没有任务单' : '这一列是空的'),
                h('span', null, activeCol === 'unclarified' ? '点右上「＋ 新建」写一张' : '把卡移过来'),
              )
              : one.map(function (card) { return cardView(view, card, true, flyId) }),
          ),
          h('div', { className: 'dshpz-hint' }, '窄屏下点开卡片，用浮窗里的「→ 移到下一列」按钮搬卡（拖拽在窄屏被刻意取消，见 U4 Q8）。'),
          float,
          cardFloatLayer(view),
        )
      }
      return h(
        'div',
        { className: 'dshpz-dispatch' },
        brainBar(view),
        h(
          'div',
          { className: 'dshpz-board' },
          columns.map(function (pair) {
            var list = cardsOf(pair[0])
            return h(
              'div',
              {
                key: pair[0],
                className: 'dshpz-boardcol',
                'data-col': pair[0],
                // 空列给虚线内框（v2.1.9）：让「这里可以放卡」在拖拽前就看得见。
                'data-empty': list.length === 0 ? '1' : '0',
                // 拖到这一列上时高亮它（`data-over`），并在松手时搬卡。
                'data-over': view.state.dragOver === pair[0] ? '1' : '0',
                /**
                 * 这一列**不接收**正在拖的那张卡（v2.4.5）。
                 *
                 * 判据全来自宿主下发的 `forbidden`（见 `forbiddenOf`）——
                 * 面板不自己判。这样「拖动时就看得见不能放」与「松手真的被拒」
                 * 用的是同一条规则，不可能出现预告与实际不一致。
                 *
                 * 两个属性分开：`data-over` 是「光标在这一列上」，
                 * `data-no` 是「这一列不接收它」。落点高亮要按后者压过去——
                 * 让「不接收」在视觉上赢，否则用户以为能放。
                 */
                'data-no': view.state.dragOver === pair[0] && forbiddenOf(dragFromCol(), pair[0]) ? '1' : '0',
                /**
                 * ## 「这一列刚接住了一张卡」（v2.4.17）
                 *
                 * 由 `landColumn` 在搬卡成功后挂上、`onAnimationEnd` 摘掉。
                 * 与卡自己的飞行是**两件事的两个落点**：卡说明「它去哪了」，
                 * 列说明「这个槽接住了它」——拼图合上的那一下在两个零件之间。
                 *
                 * ⚠️ 只在**真的换列**时给（`state.landedCol` 由 `moveCard` 按
                 * 宿主的 `effect` 判），同列换排不庆祝。
                 */
                'data-landed': view.state.landedCol === pair[0] ? '1' : '0',
                /**
                 * 落定脉冲放完就摘掉。
                 *
                 * 为什么必须摘：`data-landed` 留着的话，下一次任何原因的重渲染
                 * （8 秒轮询、悬停、切换子页）都会让这一列**再闪一次**——
                 * 而它其实什么都没发生。用 `animationend` 而不是定时器：
                 * 减少动效下压根没有动画，定时器会清得太晚。
                 *
                 * 判据用 `state.landedCol` 而不是闭包里的 `pair[0]`：事件可能
                 * 在**下一次搬卡之后**才到（那 320ms 里用户又拖了一张），
                 * 那时 `landedCol` 已经指向新列，不该被旧事件清掉。
                 */
                onAnimationEnd: function () {
                  if (state.landedCol === pair[0]) setState({ landedCol: null })
                },
                /**
                 * ## 落点：**列**接收 drop（不是卡片）
                 *
                 * 为什么不做「插到某张卡前面」：`moveVerdict` 的语义是**列与列**的流转
                 * （向右 / 三个左移口子），没有「同列内第几位」这个概念。
                 * 做成卡间插入就得再造一套位置语义，而 Q8 明确说「同列换排」是允许但
                 * 不必精确到位的操作——列接收 drop 已经够用，且与按钮走**同一条落位函数**。
                 */
                ...(narrow
                  ? {}
                  : {
                    onDragOver: function (event) {
                      // **必须 preventDefault**：不拦的话浏览器把这一列当成「不可放置」，
                      // `drop` 永远不会触发——表现是「拖过去松手什么也没发生」，且不报错。
                      //
                      // ⚠️ 不接收的列**也照样 preventDefault**：那一步只是为了让 `drop`
                      // 能触发，好让宿主给出**它自己那句拒绝理由**（含"下一步该做什么"）。
                      // 在这里直接不 preventDefault 的话，浏览器会静默吞掉这次松手——
                      // 用户看到的是「拖过去松开，什么都没发生，也没有任何解释」。
                      event.preventDefault()
                      // 手上的卡跟着光标走（只改 `transform`，不碰布局）。
                      ghostMove(event)
                      try {
                        event.dataTransfer.dropEffect = 'move'
                      } catch (_error) {
                        /* 忽略：某些浏览器只读 */
                      }
                      if (state.dragOver !== pair[0]) setState({ dragOver: pair[0] })
                    },
                    onDragLeave: function () {
                      if (state.dragOver === pair[0]) setState({ dragOver: null })
                    },
                    onDrop: function (event) {
                      event.preventDefault()
                      // `dataTransfer` 优先，拿不到就用 `dragId` 兜底（见 `onDragStart`）。
                      var id = ''
                      try {
                        id = event.dataTransfer.getData('text/plain')
                      } catch (_error) {
                        id = ''
                      }
                      if (id === '') id = state.dragId === null || state.dragId === undefined ? '' : String(state.dragId)
                      setState({ dragId: null, dragOver: null })
                      /**
                       * ⚠️ 这里**只清 `dragId`、不清 `hiddenCardId`**：
                       * 源卡此刻还是隐藏的，而 `moveCard` 的回包会决定它去哪
                       * （成功 → 在新列显出来；被拒 → 弹回后显出来）。两条路都会清
                       * `hiddenCardId`。在这里就清的话，请求还没回来卡就现出来了，
                       * 会看到「卡在旧列闪一下、然后才跳到新列」。
                       *
                       * 但**没拿到卡 id** 时没有回包会来清它——那种情况必须在这里清，
                       * 否则那张卡永远隐形。
                       */
                      if (id === '') {
                        ghostDrop()
                        setState({ hiddenCardId: null })
                        return
                      }
                      /**
                       * 与按钮**同一个落位函数**：能不能移、移了算什么，全由宿主判。
                       *
                       * ⚠️ `event` 要一起传下去：被拒时手上那张卡要**沿原路飞回**，
                       * 而松手点只在这个事件上有（`clientX` / `clientY`）。
                       */
                      moveCard(view, id, pair[0], event)
                    },
                  }),
              },
              h(
                'div',
                { className: 'dshpz-boardcolhead' },
                h('span', { className: 'dshpz-boardcoldot' }),
                pair[1],
                h('span', { className: 'dshpz-boardcoln' }, String(list.length)),
                /**
                 * **新建入口**（U4-3 建议放「未澄清」列头）：新建的卡落在**未澄清**列，
                 * 与列语义一致。
                 */
                pair[0] === 'unclarified'
                  ? h(
                    'button',
                    {
                      className: 'dshpz-act',
                      style: { marginLeft: 'auto' },
                      title: '写一段需求，一键由模型分解成标题 / 目标 / 描述',
                      onClick: function () { setState({ newTask: { request: '', title: '', objective: '', description: '', busy: false } }) },
                    },
                    '＋ 新建',
                  )
                  : null,
              ),
              /**
               * 空列：一个**居中占位块**（v2.1.11）。
               *
               * 原先只写一个字「空」——五列全空时看着像没渲染出来。
               * 现在给图标 + 一句「拖一张卡过来」，与别处的空态（`.dshpz-empty`）
               * 同一套语言：**说清这里是什么、以及怎么让它不空**。
               *
               * `flex:1` 让它占满列内剩余高度，于是占位块**垂直居中**——
               * 这正是「空列」看起来该有的样子（而不是顶着列头的一行小字）。
               */
              list.length === 0
                ? h(
                  'div',
                  { className: 'dshpz-boardempty' },
                  h('span', { className: 'dshpz-boardemptyicon' }, icon('grid', 15)),
                  h('span', null, pair[0] === 'unclarified' ? '还没有任务单' : '这一列是空的'),
                  h('span', null, pair[0] === 'unclarified' ? '点右上「＋ 新建」写一张' : '把卡拖过来'),
                )
                : list.map(function (card) { return cardView(view, card, false, flyId) }),
            )
          }),
        ),
        h('div', { className: 'dshpz-hint' },
          '点一张卡看详情；**移动是唯一的触发手势**——「未接单」拖到「在做」= 真的派单开工。只能向右移（或同列换排）；左移只开三个口子：未接单（已冻结）→ 未澄清 = 重铸新版、未接单（未冻结）→ 未澄清 = 接着澄清、失败 → 在做 = 接着原会话重做。'),
        float,
        cardFloatLayer(view),
      )
    }

    /**
     * 按字数截断一段**显示文本**（落盘内容一律不动）。
     *
     * 浏览器半**拿不到**宿主侧的 `shortTitle`（那是 `lib/dispatch.js` 的导出，
     * 而 client bundle 只带自己那一份）。所以在客户端放一个最小的：
     * 卡上要的是「它写了什么」的第一眼，全文走 `title` 属性与派单首轮消息。
     */
    function clipText(text, limit) {
      var value = typeof text === 'string' ? text : ''
      return value.length <= limit ? value : value.slice(0, limit - 1) + '…'
    }

    /**
     * 派单页**左上角**的那一条（v2.2.0）：全局大脑入口。
     *
     * ## 为什么放在派单页而不是面板头部
     *
     * 用户原话：「在派单页左上角放一个全局大脑按钮」。放在这里还有一层语义：
     * 大脑是**派单系统的总控**——它看五列、看执行汇报、决定谁该干什么。
     * 放面板头部会让人以为它是面板级功能（像主题 / 更新那样），
     * 而它跟具体哪个项目强相关。
     *
     * ## 按钮状态
     *
     * 已经呼出过时（`state.build.kind === 'brain'`）按钮显示 `data-on`——
     * 与分段控件同一套语言：**「这个面板现在开着它」**一眼可见。
     */
    function brainBar(view) {
      var open = view.state.build !== null && view.state.build !== undefined && view.state.build.kind === 'brain'
      return h(
        'div',
        { className: 'dshpz-brainbar' },
        h('button', {
          className: 'dshpz-brainbtn',
          'data-on': open ? '1' : '0',
          disabled: view.state.brainBusy === true,
          title: '呼出全局大脑：这个项目的常驻会话，带主文档、能回读模块文档、能看执行汇报。一个项目一个，已存在就复用',
          onClick: function () { openBrain(view) },
        },
          icon('brain', 15),
          h('span', null, view.state.brainBusy === true ? '正在呼出…' : '全局大脑'),
        ),
        h('span', { className: 'dshpz-brainhint' },
          '常驻会话：带这个项目的主文档（压缩时才刷新），能回读模块文档、检索条目、看执行汇报。'),
      )
    }

    /**
     * **卡上「它在干活吗」那一行**（v2.3.x，需求 ②）——`cardView` 只调它、不自己拼。
     *
     * ## 为什么轮次要用宿主的实时值，而不是卡上的 `roundsStarted`
     *
     * 卡上那个字段是**派单那一刻**的快照，此后不再更新。拿它渲染「轮 3/10」
     * 会永远停在「轮 0/10」——**显示一个假事实比不显示更糟**。
     * 所以有实时值就用实时值，没有就**不写轮次**（而不是退回那个快照）。
     *
     * ## 三种状态分别说什么
     *
     *   - `running`：转圈圈（复用 `.dshpz-spin`）+「执行中」；
     *   - `idle`：agent 在、但没在跑——如实写事实「会话空闲」，因为
     *     **为什么停**宿主没告诉我们；
     *   - 拿不到状态：按**为什么拿不到**分两句（见下）。
     *
     * 轮次只在拿到实时值时才附上，且格式与卡上原来那句 `goal …` 一致（都是
     * `轮 N/M`），免得同一个概念在卡上有两种写法。
     */
    function cardRunLine(view, card) {
      /**
       * **这张卡压根没有会话**：它可能是被手动拖进「在做」的（`moveVerdict`
       * 允许手动右移），也可能是老数据。这与「有会话但读不到状态」是两件事，
       * 说成后者会误导用户去找一个不存在的会话。所以先分开。
       */
      if (typeof card.sessionId !== 'string' || card.sessionId === '') {
        return h('div', { className: 'dshpz-cardrun', 'data-run': 'gone' },
          h('span', null, '没有会话——这张卡不是派单出去的'))
      }
      var live = liveOfIn(view, card.sessionId)
      var rounds = live !== null && live.roundsStarted !== null && live.roundsStarted !== undefined
        ? '轮 ' + String(live.roundsStarted) + '/' + String(live.maxGoalRounds === null || live.maxGoalRounds === undefined ? '?' : live.maxGoalRounds)
        : ''
      /**
       * ⚠️ 变量名**不能叫 `state`**：本文件顶部有一个模块级的共享 store 就叫 `state`，
       * 同名会把它在这个函数里整体遮蔽（`var` 提升）。名字上分开，
       * 才不会写出「读到一个空对象」这类错。
       */
      var runState = live === null ? '' : String(live.status || '')
      if (runState === 'running') {
        return h('div', { className: 'dshpz-cardrun', 'data-run': 'running' },
          h('span', { className: 'dshpz-spin' }),
          h('span', null, '执行中' + (rounds === '' ? '' : '（' + rounds + '）')))
      }
      if (runState === 'idle') {
        return h('div', { className: 'dshpz-cardrun', 'data-run': 'idle' },
          h('span', null, '会话空闲（没在跑，可能等下一轮）' + (rounds === '' ? '' : '（' + rounds + '）')))
      }
      /**
       * 既不是 running 也不是 idle：`live === null`（还没拉到 / 这个 id 不在返回里）
       * 或宿主给了一个我们不认识的状态词。两者都是「不知道」，
       * 所以共用一句话——**不猜**。
       */
      return h('div', { className: 'dshpz-cardrun', 'data-run': 'gone' },
        h('span', null, '读不到实时状态（会话可能已经不在了）'))
    }

    /**
     * 一张任务卡：**折叠成只显示标题的小卡片**（v2.4.3）。
     *
     * ## 用户拍板
     *
     * 「任务卡折叠成一个小卡片，只显示标题，点击才展开成浮窗查看详细信息。
     *   任务卡上的按钮删掉，只能移动触发逻辑。」
     *
     * ## 为什么按钮全删、只剩移动
     *
     * 原先卡上最多能长出**七颗按钮**（验收 / → 下一列 / ← 重做 / ← 回澄清 /
     * 开始澄清 / 冻结 / 派出去 / 删除），五列并排时卡片被按钮撑得比标题还高，
     * 看板看不出「哪些卡在流转」——而那才是看板要回答的问题。
     *
     * 删掉之后**移动就是唯一的手势**，而移动本身带语义（见宿主 `rpcTask` 的
     * `action:'move'`）：未接单 → 在做 = 真的派单开工。剩下的动作收进详情浮窗。
     *
     * ## 点卡做什么（按列分）
     *
     * - **在做**：直接开**执行会话浮窗**——用户点一张正在跑的卡，想看的就是它在干什么；
     * - **未澄清**：开**澄清器浮窗**（有澄清会话时）；
     * - 其余列：开**详情浮窗**（含删除 / 验收 / 左移口子）。
     *
     * 判据全在宿主给的数据上（`card.sessionId` / `card.clarifySessionId`），
     * 客户端不猜「大概有没有会话」。
     */
    function cardView(view, card, narrow, flyId) {
      var plan = card.plan !== null && card.plan !== undefined ? card.plan : {}
      var verified = card.verified === true
      /**
       * 「这张卡现在在干活吗」——只在「在做」列算。
       *
       * 折叠后卡上只剩标题，但**正在跑**这件事必须一眼看得见（否则用户得
       * 一张张点开才知道谁在动）。所以给一个极小的转圈圈，不占第二行文字。
       */
      var running = card.column === 'doing' && typeof card.sessionId === 'string' && card.sessionId !== ''
        ? liveOfIn(view, card.sessionId)
        : null
      var isRunning = running !== null && String(running.status || '') === 'running'
      /**
       * 折叠卡的角标：一个词说清「这张卡有没有话要说」。
       *
       * 只给**需要用户注意**的两种：未验收（已做）、失败。
       * 其余列不给——列名已经说明了状态，再挂一个角标只是噪音。
       */
      var badge = null
      if (card.column === 'done' && !verified) badge = { text: '未验收', tone: 'warn' }
      else if (card.column === 'failed') badge = { text: '失败', tone: 'err' }
      /**
       * ## 正被拖的那张：**板上不显示它**（v2.4.6，用户拍板）
       *
       * 用户原话：「拖的时候原地不要有那个卡」。
       *
       * 原先板上那张一直在列里（因为跟着光标走的是另造的 ghost）——于是屏幕上
       * **同时有两张**：手上那张在动，原地那张还静静躺着。用户看到的是「我拿起了一张，
       * 但原来那张还在」，像复制了一个而不是拿走了它。
       *
       * 判据是 `dragId`（「拖的是谁」的唯一真相源），与 ghost 用的是同一个值，
       * 所以不可能出现「手上是 A、原地藏的是 B」。
       *
       * ⚠️ 藏的方式是 `visibility:hidden`（见 CSS），**不是** `display:none`：
       * 后者会让这张卡**脱离布局**，同列后面的卡会往上跳一格、列高也变——
       * 拖动过程中整列在动，比留着那张卡还晃眼。`visibility` 保留它的位置，
       * 于是「它被拿走了、这个位置空着」这件事看起来是稳的。
       *
       * ## ⚠️ 为什么隐藏源卡**不能**在 `dragstart` 里同步做（v2.4.7 修的真 bug）
       *
       * v2.4.6 是同步挂的（`setState({dragId})` 直接让这张卡 `visibility:hidden`），
       * 结果**整个拖拽拖不动了**。
       *
       * 根因：**隐藏拖拽的源元素会让浏览器当场放弃这次拖拽**。而且放弃得很安静——
       * `dragend` **也不触发**，于是 `dragId` 永远留在 state 里，那张卡**永远回不来**，
       * 下一次拖别的卡也会被这个脏值干扰。表现就是用户看到的「怎么拖不动了」。
       *
       * 所以判据拆成两半：
       *   - `dragId`：`dragstart` 里**同步**设（拖拽逻辑与 `data-no` 预告要用）；
       *   - `hiddenCardId`：**等这次 `dragstart` 返回之后**（`setTimeout 0`）才设，
       *     并且**活到搬卡有结论**（不是 `drop` 那一刻就清）——理由见它的注释。
       *
       * ⚠️ 用 `setTimeout(0)` 而不是 `requestAnimationFrame`：`rAF` 在某些
       * 后台/不可见标签页里会被**暂停**，那样隐藏就永远不发生；而这是个
       * 「越早越好」的观感动作，定时器更可靠。
       */
      var dragging = view.state.hiddenCardId !== null && view.state.hiddenCardId !== undefined
        && String(view.state.hiddenCardId) === String(card.id)
      return h(
        'div',
        {
          key: card.id,
          /**
           * 飞行时**不挂** `.dshpz-cardfly`（v2.4.17）：
           * 那个类是「量不到起点」时的**兜底淡入**，而真飞行由 `travelCard`
           * 直接写行内 `transform` 完成。两者同时挂的话，淡入的
           * `opacity:.35 → 1` 会叠在飞行的位移上——卡会一边飞一边半透明，
           * 看起来像「它在消失又出现」，而不是「它被挪过去了」。
           *
           * 判据是 `flyFrom`：有起点 → 交给 `travelCard`；没起点 → 才挂类。
           */
          className: 'dshpz-card dshpz-cardmini'
            + (flyId === card.id && (view.state.flyFrom === null || view.state.flyFrom === undefined) ? ' dshpz-cardfly' : ''),
          'data-col': card.column,
          /**
           * 卡 id 写进属性（v2.4.17）：`travelCard` / `ghostGrab` 要按 id 找 DOM。
           *
           * 为什么不用 React 的 `ref`：卡是列表渲染出来的，几十张卡就是几十个 ref，
           * 而需要找的**永远只有正在飞的那一张**。属性查询是 O(n) 但 n 是几十，
           * 且只在搬卡那一刻跑一次——比维护一张 ref 表简单得多。
           */
          'data-card-id': String(card.id),
          // 正被拖的那张：板上留位置但不显示（理由见 `dragging` 那段）。
          'data-dragging': dragging ? '1' : '0',
          /**
           * 悬停给需求原文：折叠卡只有一行标题，而用户常常想确认「这张是不是
           * 我说的那件事」。原文是他自己写的，最准。
           */
          title: String(card.sourceRequest || card.title || ''),
          onClick: function () { openCardFloat(view, card) },
          /**
           * ## 宽屏拖拽（U4 Q8）
           *
           * 用 **HTML5 原生拖拽**（`draggable` + `dragstart` / `dragover` / `drop`），
           * 不是 Pointer Events 自己实现——理由是**省事且够用**：
           * 看板是「整卡换列」，不需要跟手位移、不需要自定义落点预览；
           * 原生拖拽自带「拖到哪一列」的语义，落点由目标列的 `drop` 处理。
           *
           * ⚠️ v2.4.5：**落点仍然用原生拖拽，但"手上那张卡"不用原生素材**。
           * 原生拖影是位图快照（不能动、也不能真的跟手），所以这里把它藏掉、
           * 换成自己造的真卡（见 `ghostGrab`）。两者分工：原生负责**语义**
           * （拖到哪一列、什么时候松手），自造的负责**观感**。
           *
           * ⚠️ **窄屏不挂这些**（`narrow === true` 时整块为 `null`）：
           * 触屏上原生拖拽要么不触发、要么与滚动打架，Q8 明确要求窄屏用按钮。
           *
           * ⚠️ v2.4.3：卡上按钮删掉后，**窄屏靠点击浮窗里的移动按钮**搬卡
           * （浮窗里给「→ 下一列」与左移口子，走同一个 `moveCard`）。
           * 窄屏没有拖拽，所以那几颗按钮是必须的——不能一起删掉。
           */
          ...(narrow
            ? {}
            : {
              draggable: true,
              onDragStart: function (event) {
                // 记下拖的是哪张卡。用 `dataTransfer` 而不是模块级变量：
                // 后者在「拖起来又按 Esc 取消」时会留下一个脏值，
                // 下一次 drop 就会搬错卡——而那种错用户完全看不出原因。
                try {
                  event.dataTransfer.setData('text/plain', String(card.id))
                  event.dataTransfer.effectAllowed = 'move'
                } catch (_error) {
                  /* 老 WebView 不给 dataTransfer：靠下面的 dragId 兜底 */
                }
                /**
                 * ## 把浏览器那张拖影**藏掉**（v2.4.5）
                 *
                 * 传一张 1×1 的透明图当拖影，原生那张就看不见了——于是屏幕上
                 * 只剩我们自己造的那张真卡。不藏的话会**两张一起跟**（一张位图、
                 * 一张真卡），看着像重影。
                 *
                 * ⚠️ 用**内联 SVG 的透明 data URI**，不引外部图片：本仓的
                 * `validateThemeCss` 只允许 `url(data:image/…)`，而且外部图片
                 * 在离线/被 CSP 拦时会让这一句抛错——那会连拖拽都起不来。
                 *
                 * ⚠️ 包在 try 里：`setDragImage` 在老 WebView 上可能不存在或抛错，
                 * 而它只是**观感优化**——失败了拖拽本身必须照常能走。
                 */
                try {
                  var blank = document.createElement('img')
                  blank.src = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221%22 height=%221%22/%3E'
                  event.dataTransfer.setDragImage(blank, 0, 0)
                } catch (_error) {
                  /* 老 WebView：拖影藏不掉，那就两张一起跟——功能不受影响 */
                }
                /**
                 * ## 造一张真卡拿在手上（v2.4.5，用户拍板）
                 *
                 * 用户原话：「我要的是真抓在手上，不是投影」+「拖的时候加一个任务卡微摇动效果」。
                 *
                 * 原生拖影做不到这两件事：它是**位图**（不能动，摇不起来），
                 * 而且与光标只有一个固定偏移（不是"握在手里"，所以上一版只能靠投影
                 * 去暗示"它抬起来了"——那正是用户看出来的破绽）。
                 *
                 * `event.currentTarget` 就是被拖的那张卡本身，拿它当样子复制一份。
                 * 摇动由 `motionOn()` 决定要不要加（那张卡不在 `.dshpz-scope` 子树里，
                 * 减少动效的作用域通配规则罩不到它——本仓对 JS 动效的既有纪律）。
                 */
                ghostGrab(event !== null && event !== undefined ? event.currentTarget : null, event, !motionOn())
                /**
                 * 记下**按下点**：它是「这次拖拽确实从板上起的」的证据，
                 * `ghostBack` 的「没有按下点就不编假动画」判据依赖它。
                 */
                var from = null
                if (event !== null && event !== undefined && isFinite(Number(event.clientX)) && isFinite(Number(event.clientY))) {
                  from = { x: Number(event.clientX), y: Number(event.clientY) }
                }
                /**
                 * ⚠️ **顺序**：`ghostGrab` 必须在这次 `setState` **之前**跑。
                 * 这次 setState 之后（下一个任务）板上那张会挂上 `data-dragging="1"`
                 * （`visibility:hidden`），而 `ghostGrab` 是照它的 `innerHTML` /
                 * `className` 复制外观的——顺序反了就是**照着一张隐藏的卡去复制**。
                 *
                 * ⚠️ 这里只设 `dragId`（同步，拖拽逻辑要用），**不设 `hiddenCardId`**：
                 * 隐藏源卡会让浏览器当场放弃这次拖拽（`dragend` 也不触发，卡永远回不来）。
                 * 所以延到 `setTimeout 0` —— 那时 `dragstart` 已经返回，拖拽已经立住了。
                 */
                setState({ dragId: card.id, dragFrom: from })
                setTimeout(function () {
                  // 只有这次拖拽还在（没被取消 / 没被 drop 清掉）才隐藏。
                  if (state.dragId === card.id) setState({ hiddenCardId: card.id })
                }, 0)
              },
              onDragEnd: function () {
                // 无论成功还是取消都要清掉，否则高亮的列会一直亮着。
                //
                // ⚠️ `dragFrom` **不在这里清**：`drop` 先于 `dragend` 触发，
                // 而被拒的结论要等宿主回包才到——那时 `dragend` 早就跑过了。
                // 起点由 `moveCard` 在**调用那一刻**同步取走（见那里的 `var from`），
                // 所以这里清不清都不影响弹回；清了反而让状态更干净，故一并清。
                //
                // ⚠️ **手上那张卡也在这里兜底清掉**：正常路径上 `drop` 已经清过了
                // （成功 → `ghostDrop`；被拒 → `ghostBack`），但「拖起来又按 Esc 取消」
                // 根本不触发 `drop`——不清的话它会**永久挂在屏幕上**。
                // `ghostDrop` 幂等（节点已清就什么都不做），重复调无副作用。
                ghostDrop()
                setState({ dragId: null, dragOver: null, dragFrom: null, hiddenCardId: null })
              },
            }),
          /**
           * 动画放完就把 `flyId` / `flyFrom` 清掉。
           *
           * ⚠️ **必须清**：留着的话，下一次 8 秒轮询引起的重渲染会给它重新挂上类、
           * 再播一遍——看板会一直闪。用 `animationend` 而不是定时器：
           * 定时器在「减少动效」下会清得太晚（那时压根没动画）。
           *
           * ⚠️ 两条**一起清**（v2.4.17）：`flyFrom` 是「这一轮搬卡的起点」，
           * 它只对紧接着的那一次渲染有效。留着的话，下一次**没有新起点**的
           * 搬卡（比如被拒后重试）会被当成有效值，卡会从一个早就过期的地方
           * 飞过来——那比不飞更糟，因为它的来路是假的。
           */
          onAnimationEnd: function () {
            if (state.flyId === card.id) setState({ flyId: null, flyFrom: null })
          },
        },
        isRunning ? h('span', { className: 'dshpz-minidot dshpz-spin' }) : null,
        h('span', { className: 'dshpz-minititle' }, String(card.title || '（无标题）')),
        badge === null ? null : h('span', { className: 'dshpz-minibadge', 'data-tone': badge.tone }, badge.text),
      )
    }

    /**
     * 点一张卡：**按列决定开哪个浮窗**（v2.4.3）。
     *
     * ## 为什么要分三种，而不是一律开详情
     *
     * 用户点一张卡，想问的是「这件事现在怎么样了」——而「怎么样」在不同列
     * 是不同的东西：
     *   - **在做**：它在跑。用户想看的是**执行会话本身**（它说了什么、干到哪了），
     *     而不是卡上的元数据。所以直接开会话浮窗，不让他再点一次。
     *   - **未澄清**：正在一问一答。同理，有澄清会话就直接开它。
     *   - 其余列：没有活会话可看，开详情浮窗（方案 / 历史 / 动作）。
     *
     * ## 没有会话时**降级到详情**，而不是开一个空浮窗
     *
     * 「在做但没有会话」是真实状态（手动拖进去的卡，见 `cardRunLine` 那段），
     * 那时开执行会话浮窗会是一个空壳。所以判据是 `card.sessionId !== ''`。
     */
    function openCardFloat(view, card) {
      if (card.column === 'doing' && typeof card.sessionId === 'string' && card.sessionId !== '') {
        openSessionFloat('exec', card.sessionId, { cardId: card.id })
        return
      }
      if (card.column === 'unclarified' && typeof card.clarifySessionId === 'string' && card.clarifySessionId !== '') {
        openSessionFloat('clarify', card.clarifySessionId, { cardId: card.id })
        return
      }
      setState({ cardFloat: String(card.id) })
    }

    /**
     * 卡详情浮窗：**原来卡上那些信息与动作的新家**（v2.4.3）。
     *
     * ## 为什么做成浮窗而不是二级页
     *
     * 它要「盖住看板」而不是「换页」：用户点开一张卡看完，多半要接着看下一张。
     * 换页就得「返回 → 再点」，而那两次点击在看板上是纯开销。浮窗按 Esc 就回去。
     *
     * ## 内容按列给，判据在宿主
     *
     * 这里**不预判**「能不能冻结 / 能不能删」——按钮照常发请求，被拒时把宿主
     * 那句话原样显示（本仓一贯的纪律：客户端猜一次就会长出第二套规则）。
     * 唯一的例外是「按列决定显示哪几颗」，那是**界面组织**，不是数据规则。
     */
    function cardFloatLayer(view) {
      var id = view.state.cardFloat
      if (id === null || id === undefined || id === '') return null
      var board = view.state.board
      var cards = board !== null && board !== undefined && Array.isArray(board.cards) ? board.cards : []
      var card = null
      for (var i = 0; i < cards.length; i += 1) {
        if (cards[i] !== null && cards[i] !== undefined && String(cards[i].id) === String(id)) { card = cards[i]; break }
      }
      /**
       * 卡不见了（被别的窗口删了 / 看板刚刷新）→ **如实说**，不渲染一个空壳。
       * 留着一个读 `null` 字段的浮窗会当场抛错，而用户看到的是面板白屏。
       */
      if (card === null) {
        return h('div', { className: 'dshpz-float', onClick: function () { setState({ cardFloat: null }) } },
          h('div', { className: 'dshpz-floatbox' },
            h('div', { className: 'dshpz-floathead' },
              h('div', { className: 'dshpz-floattitle' }, '这张任务单已经不在了'),
              h('button', { className: 'dshpz-close', onClick: function () { setState({ cardFloat: null }) } }, icon('close', 15, { weight: 'bold' }))),
            h('div', { className: 'dshpz-floatbody' },
              h('div', { className: 'dshpz-chat', 'data-ready': '0' },
                h('div', null, '它可能刚被删掉，或看板已经刷新。')))))
      }
      var plan = card.plan !== null && card.plan !== undefined ? card.plan : {}
      var frozen = plan.frozenAt !== null && plan.frozenAt !== undefined
      var verified = card.verified === true
      var boardMeta = view.state.board
      var order = boardMeta !== null && boardMeta !== undefined && Array.isArray(boardMeta.columns) && boardMeta.columns.length > 0
        ? boardMeta.columns
        : ['unclarified', 'pending', 'doing', 'done', 'failed']
      var labels = boardMeta !== null && boardMeta !== undefined && boardMeta.labels !== null && boardMeta.labels !== undefined
        && typeof boardMeta.labels === 'object' ? boardMeta.labels : {}
      var labelOf = function (key) {
        var text = labels[key]
        return typeof text === 'string' && text !== '' ? text : String(key)
      }
      var at = order.indexOf(card.column)
      var next = at >= 0 && at < order.length - 1 ? order[at + 1] : null
      if (card.column === 'done') next = null

      /** 一行「标签：值」——详情里反复用，收一个。 */
      var row = function (name, value) {
        var text = typeof value === 'string' ? value.trim() : ''
        if (text === '') return null
        return h('div', { className: 'dshpz-drow' },
          h('span', { className: 'dshpz-dkey' }, name),
          h('span', { className: 'dshpz-dval' }, text))
      }
      var steps = Array.isArray(plan.steps) ? plan.steps : []
      var constraints = Array.isArray(plan.constraints) ? plan.constraints.filter(function (one) { return typeof one === 'string' && one !== '' }) : []
      var acceptance = Array.isArray(plan.acceptance) ? plan.acceptance.filter(function (one) { return typeof one === 'string' && one !== '' }) : []

      var body = h(
        'div',
        { className: 'dshpz-detail' },
        h('div', { className: 'dshpz-dbadges' },
          h('span', { className: 'dshpz-dbadge' }, labelOf(card.column)),
          frozen ? h('span', { className: 'dshpz-dbadge', 'data-tone': 'ok' }, '已冻结 v' + String(plan.version === null || plan.version === undefined ? 1 : plan.version)) : null,
          card.column === 'done' && !verified ? h('span', { className: 'dshpz-dbadge', 'data-tone': 'warn' }, '未验收') : null,
          card.column === 'done' && verified ? h('span', { className: 'dshpz-dbadge', 'data-tone': 'ok' }, '已验收') : null,
          card.failure !== null && card.failure !== undefined && typeof card.failure.code === 'string'
            ? h('span', { className: 'dshpz-dbadge', 'data-tone': 'err' }, '失败：' + card.failure.code) : null),
        card.column === 'doing' ? cardRunLine(view, card) : null,
        row('目标', plan.objective),
        row('描述', plan.description),
        row('需求原文', card.sourceRequest),
        row('执行提示词', plan.executionPrompt),
        /**
         * 执行工作区（v2.4.3）：**派单时实际用的那个目录**。
         * 卡上记着它（`runDispatch` 落的 `codeRoot`），所以这里直接显示事实，
         * 不重算——重算要再拼一次路径，那是「两处各拼一遍会漂移」的老坑。
         */
        row('工作目录', card.codeRoot),
        row('执行会话', card.sessionId),
        row('澄清会话', card.clarifySessionId),
        row('goal', card.goalId === '' || card.goalId === null || card.goalId === undefined
          ? ''
          : String(card.goalId) + '（rev ' + String(card.goalRevision === null || card.goalRevision === undefined ? '?' : card.goalRevision)
            + ' · 轮 ' + String(card.roundsStarted === null || card.roundsStarted === undefined ? 0 : card.roundsStarted)
            + '/' + String(card.maxGoalRounds === null || card.maxGoalRounds === undefined ? '?' : card.maxGoalRounds) + '）'),
        steps.length === 0 ? null : h('div', { className: 'dshpz-dblock' },
          h('div', { className: 'dshpz-dkey' }, '执行骨架'),
          h('ol', { className: 'dshpz-dlist' }, steps.map(function (step, index) {
            if (step === null || typeof step !== 'object') return null
            var doWhat = typeof step.do === 'string' ? step.do : ''
            var doneWhen = typeof step.done_when === 'string' && step.done_when !== '' ? '（完成判据：' + step.done_when + '）' : ''
            var files = Array.isArray(step.files) && step.files.length > 0 ? '（涉及：' + step.files.join('、') + '）' : ''
            return h('li', { key: 'step-' + String(index) }, String(step.n === null || step.n === undefined ? index + 1 : step.n) + '. ' + doWhat + files + doneWhen)
          }))),
        constraints.length === 0 ? null : h('div', { className: 'dshpz-dblock' },
          h('div', { className: 'dshpz-dkey' }, '约束'),
          h('ul', { className: 'dshpz-dlist' }, constraints.map(function (one, index) { return h('li', { key: 'c-' + String(index) }, one) }))),
        acceptance.length === 0 ? null : h('div', { className: 'dshpz-dblock' },
          h('div', { className: 'dshpz-dkey' }, '验收判据'),
          h('ul', { className: 'dshpz-dlist' }, acceptance.map(function (one, index) { return h('li', { key: 'a-' + String(index) }, one) }))),
        h('div', { className: 'dshpz-dblock' },
          h('div', { className: 'dshpz-dkey' }, '历史'),
          Array.isArray(card.history) && card.history.length > 0
            ? h('ul', { className: 'dshpz-dlist' }, card.history.slice(-12).map(function (one, index) {
              if (one === null || typeof one !== 'object') return null
              return h('li', { key: 'h-' + String(index) },
                labelOf(one.from) + ' → ' + labelOf(one.to) + ' · ' + (one.by === 'auto' ? '自动' : '手动')
                + (typeof one.note === 'string' && one.note !== '' ? ' · ' + one.note : ''))
            }))
            : h('div', { className: 'dshpz-muted' }, '还没有搬动记录')),
      )

      /**
       * ## 动作区：**卡上删掉的那些按钮搬到这里**
       *
       * 按列给，与原来卡上的判据**逐条一致**（判据源头仍是宿主，这里只是组织）。
       * 移动类的按钮在窄屏是必需的（窄屏没有拖拽），所以一律给。
       */
      var acts = []
      if (card.column === 'unclarified') {
        acts.push(h('button', {
          className: 'dshpz-act',
          disabled: view.state.taskBusy === true,
          title: '起一个**固定的澄清器**会话：它手上会有主文档全文与模块索引',
          onClick: function () { clarifyCard(view, card.id) },
        }, '开始澄清'))
      }
      /**
       * ## 冻结按钮：**只在「未接单」**（v2.4.13，用户拍板）
       *
       * 用户原话：「未澄清卡才能冻结是什么鬼，不应该是未接单吗」。
       *
       * 一列一件事：「未澄清」管**澄清**（开始澄清 / 拖过去自动澄清），
       * 「未接单」管**冻结** → 冻完才派得出去。
       *
       * 原先这颗按钮长在「未澄清」上，而 v2.4.4 之后卡可以**不经过冻结**
       * 就进「未接单」（拖过去会自动起澄清）——于是那些卡既没有按钮、
       * 也派不出去。把按钮搬到它真正该在的那一列，两条问题一起消失。
       *
       * 已冻结的卡不画（再冻会被宿主拒「已经冻结过了」，
       * 画一颗点了必然报错的按钮只会让人以为坏了）。
       */
      if (card.column === 'pending' && !frozen) {
        acts.push(h('button', {
          className: 'dshpz-act',
          disabled: view.state.taskBusy === true,
          title: '方案定稿：写入冻结时间（卡停在「未接单」不动）。冻结后才能派出去。',
          onClick: function () { freezeCard(view, card.id) },
        }, '冻结'))
      }
      if (next !== null) {
        acts.push(h('button', {
          className: 'dshpz-act',
          title: card.column === 'pending'
            ? '移到「在做」= **真的派单开工**（建会话、挂 goal、投首轮消息）'
            : '移到「' + labelOf(next) + '」列',
          onClick: function () { moveCard(view, card.id, next) },
        }, '→ ' + labelOf(next)))
      }
      if (card.column === 'failed') {
        acts.push(h('button', {
          className: 'dshpz-act',
          title: '接着**原会话**继续（不新建会话）',
          onClick: function () { moveCard(view, card.id, 'doing') },
        }, '← 重做'))
      }
      if (card.column === 'pending') {
        acts.push(h('button', {
          className: 'dshpz-act',
          title: frozen ? '重铸新版本：带着 v1 重走澄清' : '接着澄清（本来就是草稿）',
          onClick: function () { moveCard(view, card.id, 'unclarified') },
        }, frozen ? '← 重铸' : '← 回澄清'))
      }
      if (card.column === 'done' && !verified) {
        acts.push(h('button', {
          className: 'dshpz-act',
          title: '人工验收：消掉「未验收」标记',
          onClick: function () { verifyCard(view, card.id) },
        }, '验收'))
      }
      if (card.column === 'done') {
        acts.push(h('button', {
          className: 'dshpz-act',
          'data-tone': 'danger',
          disabled: view.state.taskBusy === true,
          title: '删除这张任务单，**连同它的执行会话与澄清会话**（不可恢复）',
          onClick: function () { deleteCard(view, card) },
        }, '删除'))
      }
      if (typeof card.sessionId === 'string' && card.sessionId !== '') {
        acts.push(h('button', {
          className: 'dshpz-act',
          title: '在浮窗里看这个执行会话的对话',
          onClick: function () { openSessionFloat('exec', card.sessionId, { cardId: card.id }) },
        }, '看执行会话'))
        /**
         * **停掉这张卡的执行会话**（v2.4.14，用户报的「执行会话人为停止不了」）。
         *
         * 与执行会话浮窗头部那颗「停」是**同一个动作、同一个 RPC**（`stopCardSession`）
         * ——详情浮窗是「这张卡现在怎么样了」的入口，用户在这里看到「在做」却停不了，
         * 就只能先去点「看执行会话」再停，多一步纯开销。
         *
         * 判据只看**卡上有没有执行会话**（`card.sessionId`）：宿主侧对「会话已经不在 /
         * goal 已经结束」会给出自己的错话，客户端不预判（见 `stopCardSession`）。
         */
        acts.push(h('button', {
          className: 'dshpz-act',
          'data-tone': 'danger',
          disabled: view.state.taskBusy === true,
          title: '停掉这张卡的执行会话：打断它当前这一轮。**会话、goal、卡都留在原地**'
            + '（goal 不会被清、卡不会搬列），待处理的消息也不丢——想接着做再派一次即可。',
          onClick: function () { stopCardSession(view, card.id) },
        }, '停'))
      }
      if (typeof card.clarifySessionId === 'string' && card.clarifySessionId !== '') {
        acts.push(h('button', {
          className: 'dshpz-act',
          title: '在浮窗里看这个澄清会话的对话',
          onClick: function () { openSessionFloat('clarify', card.clarifySessionId, { cardId: card.id }) },
        }, '看澄清会话'))
      }

      return h(
        'div',
        {
          className: 'dshpz-float',
          onClick: function (event) {
            // 点遮罩关掉；点浮窗内部不关（否则选文字都会把浮窗关掉）。
            if (event.target === event.currentTarget) setState({ cardFloat: null })
          },
        },
        h(
          'div',
          { className: 'dshpz-floatbox' },
          h(
            'div',
            { className: 'dshpz-floathead' },
            icon('rules', 16),
            h('div', { className: 'dshpz-floattitle' }, String(card.title || '（无标题）')),
            h('span', { className: 'dshpz-floatsid' }, String(card.id)),
            h('button', {
              className: 'dshpz-close',
              title: '关掉（Esc 同效）。卡不会被删、会话也不动。',
              onClick: function () { setState({ cardFloat: null }) },
            }, icon('close', 15, { weight: 'bold' })),
          ),
          h('div', { className: 'dshpz-floatbody' }, h('div', { className: 'dshpz-dscroll' }, body)),
          h('div', { className: 'dshpz-floatfoot' },
            h('div', { className: 'dshpz-dacts' }, acts),
            h('div', { className: 'dshpz-hint', style: { margin: '0' } },
              '移动是唯一的触发手势：把「未接单」移到「在做」= 真的开工。')),
        ),
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
              : '这个工作区里还没有打开任何项目',
          ),
        ),
        inited ? h('span', { className: 'dshpz-heroval dshpz-mono' }, '健康性 ' + data.health + '%') : null,
        /**
         * **二级面板的两个子页**（U4 拍板①：分段切换）。
         *
         * 复用现有 `.dshpz-seg`——插件里已经有一个分段控件（执行模式三选一、
         * 绑定模式二选一都在用），**同一面板里两种分段控件会长得不一样**，
         * 那是纯粹的自找麻烦。
         */
        h(
          'div',
          { className: 'dshpz-seg' },
          [['info', '文档信息'], ['dispatch', '派单系统']].map(function (pair) {
            return h(
              'button',
              {
                key: pair[0],
                'data-on': (view.state.tab || 'info') === pair[0] ? '1' : '0',
                title: pair[0] === 'info'
                  ? '拼图文档信息：模块索引、五维健康性、主文档'
                  : '派单系统：五列看板 + 新建任务单',
                onClick: function () {
                  setState({ tab: pair[0] })
                  // 切到派单子页时**按需拉看板**：它要读盘，不该塞进 8 秒轮询。
                  if (pair[0] === 'dispatch') loadBoard()
                },
              },
              pair[1],
            )
          }),
        ),
        /**
         * **「← 项目列表」返回**（U2 判据 4）。
         *
         * 主题页 / 更新页的图标**已按 U4 拍板⑥ 从二级移除**——它们是面板级的东西
         * （全局皮肤、插件自身版本），跟「哪个项目」无关，现在在一级页做切换。
         * 删掉这两个图标就是那条拍板的落地：二级里**不再出现**这两个入口。
         */
        h(
          'button',
          {
            className: 'dshpz-act',
            title: '回到项目列表（Esc 同效）',
            onClick: function () { backToProjects() },
          },
          '← 项目列表',
        ),
        h(
          'button',
          {
            className: 'dshpz-close',
            title: '刷新',
            onClick: function () {
              // 不带显式 project：刷新要看到**当前真实打开的项目**（宿主按全局设置解析），
              // 带上面板此刻显示的项目名等于把旧状态钉死。
              load(view.state.sessionId)
              loadProjects(view.state.sessionId)
              // 主文档也一起刷新：它不在 `state` 摘要里，只刷 state 会让这一块停在旧原文。
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
            onClick: function () { closePanel() },
          },
          icon('close', 15, { weight: 'bold' }),
        ),
      )

      // 一次性说明（不是错误，所以不跟 error 抢同一行）：例如「项目已存在，没动绑定」。
      var notice = view.state.notice === null || view.state.notice === undefined
        ? null
        : h('div', { className: 'dshpz-notice' }, icon('alert', 14), h('span', null, String(view.state.notice)))

      /**
       * 这一屏出了问题时的那行字（v2.4.8）。
       *
       * ⚠️ 它与一级页那份 `errorLine`（见 `projectsBody`）**是同一件事的两个渲染点**，
       * 所以取值方式必须一致。两边都读 `state.error`——只是**二级页多了一个
       * 「没有内容时才换整页」的前置判断**（见下面那段）。
       */
      var errorLine = view.state.error === null || view.state.error === undefined
        ? null
        : h('div', { className: 'dshpz-err' }, icon('alert', 14), h('span', null, String(view.state.error)))

      // 样式自检告警（定义见 `styleWarningOf`）：只在真的没生效时非 null。
      var styleWarning = styleWarningOf(view)

      // 样式自检告警（定义见 `styleWarningOf`）：只在真的没生效时非 null。
      var styleWarning = styleWarningOf(view)

      /**
       * ## 什么时候才该**整页换成错误骨架**（v2.4.8 修的真 bug）
       *
       * 判据是「**这一屏还有没有内容**」，也就是 `data === null`——
       * **不是**「`error` 是不是非空」。
       *
       * 原先一见 `error` 非空就整页接管，于是用户拖到不该去的列被拒时，
       * 整个看板被抽走、换成「右栏数据未取到。点右上角 ⟳ 重试」——
       * 而**那句话是假的**：数据明明取到了，只是这一次拖动不行。
       *
       * 根因是 `error` 一个字段兼了两种严重程度完全不同的事：
       *   - **取数失败**：这一屏没有内容可显示 → 换骨架是**对的**；
       *   - **动作被拒**：内容都在，只是刚才那一步没成 → 只该**原地一行字**。
       *
       * 为什么判据落在「有没有内容」而不是「谁写的 `error`」：写它的人有三十来处
       * （拖动 / 冻结 / 派单 / 验收 / 删除 / 建项目 / 写设置……），而判据只有这一处。
       * 挂在「谁写的」上，每加一个动作就要记得去登记一次——迟早漏，漏的表现
       * 就是今天这个 bug 换个地方复发。
       */
      if (view.state.error !== null && (data === null || data === undefined)) {
        // 错误态也保持两栏骨架：只弹一个居中红条会让面板「看起来坏了」，
        // 而保留布局能让人一眼确认「面板还在，只是这次读取失败」。
        return h(
          'div',
          { className: 'dshpz-panel' },
          header,
          h(
            'div',
            { className: 'dshpz-body dshpz-body-two' },
            h('div', { className: 'dshpz-col' }, errorLine),
            h('div', { className: 'dshpz-col' }, h('div', { className: 'dshpz-muted' }, '右栏数据未取到。点右上角 ⟳ 重试。')),
          ),
        )
      }
      if (data === null || data === undefined) {
        // 首屏加载：给骨架屏而不是干巴巴的「读取中…」——两栏布局下空白会让面板看起来是坏的。
        return h(
          'div',
          { className: 'dshpz-panel' },
          header,
          h(
            'div',
            { className: 'dshpz-body dshpz-body-two' },
            h('div', { className: 'dshpz-col' }, h('div', { className: 'dshpz-skel', style: { width: '55%' } }), h('div', { className: 'dshpz-skel', style: { width: '80%' } }), h('div', { className: 'dshpz-skel', style: { width: '65%' } })),
            h('div', { className: 'dshpz-col' }, h('div', { className: 'dshpz-skel', style: { width: '60%' } }), h('div', { className: 'dshpz-skel', style: { width: '72%' } })),
          ),
        )
      }

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

      /**
       * ## 二级页的骨架（v2.1.1：**三栏改两栏**）
       *
       * 用户裁定：删掉最左栏。那一栏装的是「项目 / 执行模式 / 看项目 / 交给 AI 的动作 /
       * 全局设置」——执行模式、AI 动作、两个全局开关的**代码也一并删除**（用户原话），
       * 只保留「项目名 + 路径」与「主文档（只读查看）」两样。
       *
       * 保留的这两样收进顶部一条**项目条**（`.dshpz-projbar`）：
       * 它俩都是「这个项目是什么」的身份信息，横着放一行刚好，不必再占一整栏。
       *
       * 于是主体只剩两栏：**读数**（健康性 / 五维 / 规模 / 模块 / 发现）与
       * **细节**（模块详情 / 主文档 / 迁移）。少一栏之后每栏都变宽，
       * 原来挤成一团的文字也就松开了——这正是用户要的「不挤」。
       */
      var projectBar = h(
        'div',
        { className: 'dshpz-projbar' },
        h('span', { className: 'dshpz-projbaricon' }, icon('puzzle', 15)),
        h(
          'div',
          { className: 'dshpz-projbartext' },
          h('div', { className: 'dshpz-projectname', style: { fontWeight: '600' } }, data.project || '未命名'),
          h('div', { className: 'dshpz-docpath' }, data.projectDir || ''),
        ),
        h(
          'button',
          {
            className: 'dshpz-act',
            'data-on': view.state.showMain === true ? '1' : '0',
            title: '只读查看主文档原文（含 front-matter 与四节）',
            onClick: function () {
              var next = view.state.showMain !== true
              setState({ showMain: next })
              // 关掉再打开时**重新拉**：文档可能已被 AI 改过，缓存会给出过期原文。
              if (next) loadMain(view.state.sessionId, data.project)
            },
          },
          icon('doc', 13), h('span', null, '主文档' + (view.state.showMain === true ? ' · 收起' : '')),
        ),
      )

      return h(
        'div',
        { className: 'dshpz-panel' },
        header,
        // **二级的两个子页**（U4）：`info` 是两栏工作台，`dispatch` 是派单系统看板。
        // 切换控件在 `header` 里（分段式，与一级内切换同一套 `.dshpz-seg`）。
        (view.state.tab || 'info') === 'dispatch'
          ? h(
            'div',
            { className: 'dshpz-body dshpz-body-fill' },
            /**
             * ⚠️ **`notice` 必须在派单分支里也渲染**（v2.3.x 修的真 bug）。
             *
             * 原先它只挂在 `info` 分支上，而**所有会设 `notice` 的动作都在派单页发生**：
             * 搬卡 / 冻结 / 派出去 / 验收 / 新建，以及需求 ③ 的「执行完成」——
             * 用户在派单页点完，那句话被写进 state 却**一个字都不显示**。
             *
             * 表现极具迷惑性：功能看着「成功」（看板确实动了），只是没有反馈。
             * 而需求 ③ 恰恰就是「要有消息反馈」——反馈写进了 state 却不渲染，
             * 等于这条需求没做。
             */
            notice,
            /**
             * ⚠️ `errorLine` 也**必须**在这个分支里（v2.4.8）——理由与 `notice` 完全一样：
             * 所有会设 `error` 的动作都在派单页发生（拖动被拒 / 冻结失败 / 派单失败 /
             * 验收失败）。只挂在 `info` 分支上，用户就会「点了没反应、也没有任何解释」。
             *
             * ⚠️ 它在这里是**一行字**，不是整页接管——因为看板已经渲染出来了
             * （`data` 非 null），这一屏有内容。整页接管只在「没有内容」时发生。
             */
            errorLine,
            h('div', { className: 'dshpz-col' }, dispatchBoard(view)),
          )
          : h(
            'div',
            { className: 'dshpz-bodywrap' },
            projectBar,
            styleWarning,
            notice,
            errorLine,
            /**
             * `cwdSource` 的告警（v2.0.0 改口）。
             *
             * v1.x 判的是 `!== 'session'`（拿不到会话 cwd 就警告）。v2.0.0 起项目根
             * 来自**绑定的数据工作区**，正常值是 `workspace`；只有 `none`（没绑）
             * 才是真问题——那时 `projectRoot` 是空串，下面的路径会显示成空白。
             */
            data.cwdSource === 'none'
              ? h('div', { className: 'dshpz-warn' }, icon('alert', 14),
                h('span', null, '还没绑定数据工作区——拼图文档与任务单没有地方可写。回项目列表页绑一个。'))
              : null,
            h(
              'div',
              { className: 'dshpz-body dshpz-body-two' },
              /* -------- 左栏：读数。这一栏是「现在什么状态」 -------- */
              h(
                'div',
                { className: 'dshpz-col' },
                h(
                  'div',
                  { className: 'dshpz-hero' },
                  h(HeroRing, { score: data.health }),
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
                h(
                  'div',
                  { className: 'dshpz-hint' },
                  '拼图文档只能由 AI 通过 puzzle_mode 改；write / edit 会被文档锁拒绝（所有模式）。',
                  h('br', null),
                  '一轮最多 ' + limitsOf(data).askQuestions + ' 问、每题最多 ' + limitsOf(data).askOptions + ' 个选项。',
                ),
              ),

              /* -------- 右栏：文档与细节。这一栏是「具体内容是什么」 -------- */
              h(
                'div',
                { className: 'dshpz-col' },
                detailBlock(view),
                mainBlock(view),
                rebuildBlock(view),
              ),
            ),
          ),
      )
    }
    /**
     * 主区面板（v2.0.0，U1/U2/U4）。
     *
     * ## 它与 v1.x 那个浮层面板的根本差别
     *
     * v1.x：挂在 `shell.overlay` 上，是**全屏遮罩里的一块浮层**，靠 `state.open` 开关。
     * v2.0.0：挂在 `main` 这个 **keyed 槽位**上，**就是主区本身**——宿主按
     * `activePanelId` 只渲染一块主面板，所以它**不再需要遮罩、不再需要「点外部关闭」**，
     * 也不需要自己判「开没开」（宿主不渲染它时它压根不挂载）。
     *
     * ## 取数为什么要看 `view`
     *
     * 一级页（`projects`）只要项目列表 + 工作区绑定；二级页（`project`）才需要
     * 整份项目状态（模块 / 健康性 / 主文档）。**在列表页就为每个项目做全量解析**
     * 是纯浪费——项目多时一次能读几十份文档。
     */
    function Panel(props) {
      var view = useStore()
      var sessionId = props.sessionId === undefined ? view.state.sessionId : props.sessionId
      var inProject = view.state.view === 'project'

      /**
       * ⚠️ **FLIP 的两个 ref 与那个 effect 必须挂在这里，不能挂在 `projectsPage` 里**
       * ——这是真机「主题页 / 更新页切过去白屏」的根因。
       *
       * 原因：`projectsPage` 是**条件调用**的（`Panel` 只在 `view === 'projects'` 时调它），
       * 而它内部调了 `useRef`×2 + `useEffect`×1。切到主题页 / 更新页时那三个 hook
       * **不再被调用** → React 报 `Rendered fewer hooks than expected` → 整棵子树卸载。
       * 表现就是白屏，且控制台里那句报错离「切换」这个动作很远，很难联想到。
       *
       * 修法：把 hook 提到**无条件执行**的 `Panel` 里，`projectsPage` 只收现成的盒子。
       * 这也是 React 的硬规则——hook 不能出现在条件分支里，而「哪一页」正是条件分支。
       *
       * 为什么假 React 测试没抓到：夹具的 `useRef`/`useEffect` 不校验调用顺序，
       * 少调几次照跑。这条只能靠真机或 hook 计数守卫发现（本仓记过同类教训）。
       */
      var listRef = React.useRef(null)
      var flipPos = React.useRef({})
      React.useEffect(function () {
        flipList(listRef.current, flipPos.current)
      })

      /**
       * **跨列飞行的播放点**（v2.4.17）。
       *
       * ## 为什么放在这里、且**没有依赖数组**
       *
       * 与上面那条 FLIP 同一条理由：它要在**每次渲染之后**跑，而「渲染后」
       * 才有新列里的卡可以量。给依赖数组的话，`flyId` 从 A 变成 A（同一张卡
       * 连着搬两次）时不会重跑——第二次搬就没有动画了。
       *
       * ## 为什么播放完要清 `flyId` / `flyFrom`
       *
       * 不清的话，下一次 8 秒轮询引起的重渲染会**再播一遍**（看板会一直闪）。
       * `flyFrom` 也必须一起清：它是「上一轮搬卡的起点」，留着的话下一轮
       * 没有新起点时会被当成有效值，卡会从一个早就过期的地方飞过来。
       *
       * ## 为什么这里不判「是不是还在播」
       *
       * `travelCard` 自己幂等：它每次都是「先量新位置、再算差值」，
       * 中途重入只会从当前位置重新开始，不会叠两条过渡（`transition:none`
       * 那一步就是取消上一条）。这一点与 `flipList` 的坑 3 是同一条修法。
       */
      React.useEffect(function () {
        var flying = state.flyId
        if (flying !== null && flying !== undefined && String(flying) !== '') {
          var played = travelCard(flying, state.flyFrom)
          /**
           * ⚠️ 只有**真的播了**才立刻清；降级（量不到起点 / 减少动效）时
           * 留给 `onAnimationEnd` 与下一次渲染去清——但那条路只在有动画时
           * 才有 `animationend`，所以降级时必须在这里清掉，否则 `flyId`
           * 会一直挂着，每次轮询重渲染都重新挂一次 `dshpz-cardfly` 类。
           */
          if (!played) setState({ flyId: null, flyFrom: null })
        }
        var landed = state.landedCol
        if (landed !== null && landed !== undefined && String(landed) !== '') {
          var ok = landColumn(landed)
          if (!ok) setState({ landedCol: null })
        }
      })

      /**
       * ## 换页转场锁的**兜底解锁**（v2.4.18，修「面板点不了」）
       *
       * `data-nav` 非 0 时 CSS 会把整页设成 `pointer-events:none`（换页那 200ms
       * 里锁住点击，防止点错相邻按钮）。正常情况下它由页面容器的
       * `onAnimationEnd` 复位成 0。
       *
       * ## 为什么还需要这条兜底
       *
       * `animationend` **不保证会来**，至少两种情况：
       *
       * 1. **减少动效**：CSS 把动画整个关掉（`animation:none!important`），
       *    没有动画自然没有结束事件 —— 而 `data-nav` 仍然是 ±1，
       *    面板就**永久点不了**。这不是理论风险：开着「减少动态效果」的用户
       *    一进面板就废了。
       * 2. **老 WebView**：动画被丢弃 / 元素在动画中被重建，事件可能不来。
       *
       * 所以这里挂一个**定时器兜底**：只要 `navDir` 非 0，`--dshpz-dur-page`
       * （200ms）之后一定复位。用 `setTimeout` 而不是 rAF：后台标签页里
       * rAF 会被暂停，那样锁就永远解不开（而这是个「必须解开」的锁）。
       *
       * ⚠️ 延时取 260ms（令牌 200ms + 60ms 余量）：太短会在动画没播完时
       * 就解锁（那就失去了锁的意义），太长会让用户多等。余量是给慢设备的
       * ——`animationend` 在正常设备上会先到，兜底只是保险。
       */
      React.useEffect(function () {
        if (state.navDir === 0) return undefined
        var timer = setTimeout(function () {
          if (state.navDir !== 0) setState({ navDir: 0 })
        }, 260)
        return function () { clearTimeout(timer) }
      }, [state.navDir, state.navSeq])

      React.useEffect(
        function () {
          /**
           * 面板卸载时**放掉浮窗持有的会话引用**（v2.1.3）。
           *
           * 为什么必须有这一条：`sessions.retain()` 加的是引用计数，
           * 而「面板被卸载」与「用户点了关窗」是两条独立的路——
           * 切到别的主面板（宿主不再渲染这块 `main`）时组件直接消失，
           * `closeBuildFloat` 根本没机会跑。漏掉就是引用计数永远不归零，
           * 宿主不会回收那个会话的 scope。
           *
           * 用**空依赖**：清理只该在真正卸载时跑一次，不能跟着 `build` 变化跑
           * （那会在每次换浮窗会话时释放掉刚拿到的那一个）。
           */
          return function () { releaseBuildRef() }
        },
        [],
      )

      /**
       * **挂载时把浮窗的会话引用接回来**（v2.4.16）——「呼出浮窗后切走再切回白屏」的修法。
       *
       * 与上面那条清理**成对**：卸载时放掉引用（必须），挂载时补回来（同样必须）。
       * 少了这一条，`state.build` 还在而它手里的 `SessionReference` 已经作废，
       * 浮窗会把一个已释放的引用交给宿主的 `SessionProvider` → 宿主抛
       * `Session reference "…" is released` → 这一格被判死 → 白屏且不自愈。
       * 完整推导写在 `reattachBuildRef` 那段。
       *
       * 用**空依赖**：只在真正挂载时跑一次。它读的是模块级 `state.build`（不是 props），
       * 所以不需要跟着任何 prop 变化重跑。
       */
      React.useEffect(function () {
        reattachBuildRef()
        return undefined
      }, [])

      /**
       * 宿主标准 prop `useWorkspaces`（root 作用域一定有它）。
       *
       * 为什么走 prop 而不是 `ctx.get('workspaces')`：后者拿到的是**服务对象**
       * （`WorkspaceController`），它的快照在 `service.list.getSnapshot()` 上，
       * 服务本身**没有 `snapshot()`** —— 原先按 `hooks.snapshot()` 取，恒为 `undefined`，
       * 于是工作区列表永远是空的、绑定入口退化成手填路径。宿主已经把
       * `useWorkspaces` 当标准 prop 发下来了，直接用它是唯一稳的取法。
       *
       * 结果存模块级 `wsSnapshot` 供 `workspacesOf()` 读（它被渲染树深处的按钮调用，
       * 没法一路透传；面板是进程级单例，所以这样存是安全的）。
       */
      var useWorkspacesProp = props.useWorkspaces
      /**
       * ⚠️ 这一行**必须无条件调用一个函数**：`useWorkspaces` 是宿主发的 hook，
       * 而 hook 的调用次数在多次渲染之间必须一致（上面刚因为条件 hook 白过屏）。
       * 所以拿不到宿主那个 prop 时**换成一个不用 hook 的纯函数顶上**——
       * 它不是 hook，不占 hook 位；宿主给了就用宿主的。
       */
      var useWorkspacesHook = typeof useWorkspacesProp === 'function'
        ? useWorkspacesProp
        : function () { return wsSnapshot }
      var wsSnap = useWorkspacesHook(function (snapshot) { return snapshot })
      if (typeof useWorkspacesProp === 'function') wsSnapshot = wsSnap

      React.useEffect(
        function () {
          /**
           * 会话 ID 在 v2.0.0 里是**可选**的（面板是全局的）。
           * 项目列表、工作区绑定、主题、更新**全都照常**——
           * 这正是「不打开任何会话也能用面板」的含义。
           */
          loadWorkspace()
          loadProjects(sessionId)
          // 主题是全局状态，与项目无关，两级视图都要拉。
          loadActiveTheme(sessionId)
          /**
           * **模型目录**（v2.1.1）：一级页「三个模型」下拉的数据源。
           *
           * 为什么在挂载时就拉、而不是等展开派单设置：那次展开是**同步渲染**的，
           * 而目录是一次网络往返——等到展开才拉会让用户先看到一屏「读不到模型目录」
           * 再突然变成下拉。挂载时拉一次，展开时看到的就是已就绪的列表。
           */
          loadModelCatalog()
          if (!inProject) return undefined
          // 二级视图才拉项目状态与主文档：一级页只列项目名与健康性。
          load(sessionId)
          loadMain(sessionId)
          // 停在派单子页时把看板也拉一次（它不在 `state` 里，要单独读盘）。
          if (view.state.tab === 'dispatch') loadBoard()
          pollLive()
          /**
           * ## 轮询（需求 ③ 的落点）
           *
           * ⚠️ **停在派单子页时，看板也必须每轮拉一次**——这不是可选的。
           *
           * 搬列是**宿主自动**做的（`completion.js` 听 `goal/changed`），
           * 面板没有任何推送通道；它唯一能发现「卡换了列」的方式就是重读看板。
           * 原先只在切进子页时拉一次，于是**自动搬的列要等用户手动刷新才看得见**，
           * 而「执行完成有消息反馈」这条需求在那种情况下永远不会触发。
           *
           * 代价是每 8 秒多一次读盘 + 解析（一个 JSON 文件），而且只在
           * **用户正看着派单子页**时发生——切到文档信息子页立刻停。
           * 这与「按需拉、不塞进 state」那条原则不冲突：需求 ③ 要的正是
           * 「看着看板时能发现变化」。
           *
           * ⚠️ 轮询里的 `load` **不能带显式 project**：这个闭包在 effect 首次运行时
           * 捕获，而「当前打开的项目」是全局状态，可能已被别的面板实例改过。
           * 只给 sessionId，让宿主按「面板当前打开的项目」解析。
           */
          var timer = window.setInterval(function () {
            load(sessionId)
            loadActiveTheme(sessionId)
            if (state.tab === 'dispatch') loadBoard()
            pollLive()
          }, POLL_MS)
          return function () {
            window.clearInterval(timer)
          }
        },
        [inProject, view.state.sessionId, props.sessionId, view.state.tab],
      )

      /**
       * 窄屏判定（U4 Q8：断点沿用现有的 900px）。
       *
       * 为什么读**窗口宽度**而不是「设备类型」：平板横竖屏、桌面窄窗口都会跨过 900px，
       * 而判据是「五列挤不挤得下」，那件事只跟宽度有关。
       * 挂载时同步一次、resize 时再同步——**不放进 8 秒轮询**（那与窗口尺寸无关）。
       */
      React.useEffect(function () {
        var sync = function () {
          var narrow = window.innerWidth !== undefined && window.innerWidth < 900
          if (state.narrow !== narrow) setState({ narrow: narrow })
        }
        sync()
        if (typeof window.addEventListener === 'function') {
          window.addEventListener('resize', sync)
          return function () { window.removeEventListener('resize', sync) }
        }
        return undefined
      }, [])

      /**
       * Esc 的层级顺序（U4 拍板）：
       * `theme` / `update` → 回 `projects`；`project` → 回 `projects`；`projects` → 关面板。
       *
       * 「关面板」走 `ctx.layout.selectPanel(null)`——面板住在主区里，自己藏不掉自己。
       * 拿不到 layout 服务时**退回「回列表页」**：那至少是一个可见的变化，
       * 比按了没反应好（静默无效会让人以为键盘坏了）。
       */
      React.useEffect(function () {
        var onKey = function (event) {
          if (event.key !== 'Escape') return
          /**
           * 浮窗在最上层（v2.1.3）：Esc 先关它。
           * 顺序与视觉层级一致——不然「按 Esc 关了面板、浮窗却还在」，
           * 而浮窗挂在面板里，面板没了它就跟着没，看起来像一次诡异的双跳。
           */
          if (state.build !== null && state.build !== undefined) {
            closeBuildFloat()
            return
          }
          /**
           * **卡详情浮窗**（v2.4.3）：与 build 浮窗同一层（都是浮在看板上的），
           * 所以 Esc 也必须先关它。少了这一条的表现与上面那条一样：
           * 按 Esc 整个面板没了，而用户只是想关掉那张卡。
           */
          if (state.cardFloat !== null && state.cardFloat !== undefined) {
            setState({ cardFloat: null })
            return
          }
          /**
           * 「新建任务单」浮窗（v2.2.7）：它也是**浮在看板上的最上层**，
           * 所以与 build 浮窗同一优先级——Esc 先关它，不关面板。
           * 少了这一条的表现是「按 Esc 整个面板没了，浮窗里的输入也跟着丢」。
           */
          if (state.newTask !== null && state.newTask !== undefined) {
            setState({ newTask: null, error: null })
            return
          }
          if (state.view === 'theme' || state.view === 'update') {
            /**
             * Esc 回列表 = **往左走**（v2.4.17）。与那两颗「← 返回」按钮
             * 走同一个方向记号——键盘与鼠标不该给出不同的空间感。
             */
            setState({
              view: 'projects',
              themeNotice: null,
              themeError: null,
              updateNotice: null,
              updateError: null,
              navDir: -1,
              navSeq: (state.navSeq || 0) + 1,
            })
            return
          }
          if (state.view === 'project') {
            backToProjects()
            return
          }
          closePanel()
        }
        window.addEventListener('keydown', onKey)
        return function () {
          window.removeEventListener('keydown', onKey)
        }
      }, [])

      /**
       * 把用户主题挂到文档上。
       *
       * 与侧边栏按钮里那条是同一件事（`applyUserTheme` 幂等，按 id 复用同一个节点）。
       * 两处都挂是因为两个组件**都可能先挂载**。
       * 依赖放 `themeCss` 字符串本身——它是顶层字段，换主题才会变，8 秒轮询不会触发重挂。
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

      // 主视图**四选一**（U4 拍板 ⑥）：项目列表 / 项目二级 / 主题 / 更新。
      // 主题与更新**从二级提到一级**——它们是面板级的东西（全局皮肤、插件自身版本），
      // 跟「哪个项目」无关，所以二级里不再出现这两个入口。
      var current = view.state.view
      var page = current === 'theme'
        ? themePage(view)
        : current === 'update'
          ? updatePage(view)
          : current === 'project'
            ? panelBody(view)
            : projectsPage(view, listRef, flipPos)

      /**
       * ## 页面容器（v2.4.17）：换页转场的挂点
       *
       * 为什么要在 `body` 外面再包一层、而不是直接把动画挂到各页自己的
       * `.dshpz-panel` 上：
       *
       * 1. **四页的根元素不统一**：`projectsPage` / `themePage` / `updatePage` /
       *    `panelBody` 各自渲染 `.dshpz-panel`，但它们**内部结构不同**
       *    （有的是 `dshpz-body`，有的是 `dshpz-bodywrap`）。把动画挂在
       *    `.dshpz-panel` 上要改四处，而挂在这一层只改一处；
       * 2. **`key` 必须在这里**：换页转场靠「元素被重建」来重播动画
       *    （见 `navSeq` 的注释）。给四页各加 `key` 也行，但那要记得加四次。
       *
       * ## `key` 用 `navSeq` 而不是 `current`
       *
       * 用 `current`（页名）当 key 的话，「项目 → 主题 → 项目」会复用第一次
       * 那个「项目」元素——它的动画**已经播过了**，不会再播。
       * 用自增序号则每次导航都是一个全新实例，动画必然重播。
       *
       * ## `data-nav` 的三种取值
       *
       * `1` 前进（从右进）、`-1` 后退（从左进）、`0` 不播。
       * `0` 出现在：首次挂载、以及同页重复点击（那时 `navSeq` 没变，
       * `key` 也没变，元素不重建，压根不会重播）。
       *
       * ⚠️ **`data-nav` 非 0 会锁住整页的点击**（CSS 里那条 `pointer-events:none`）。
       * 所以它必须在动画结束后**立刻回到 0** —— 见下面的 `onAnimationEnd`。
       * 少了那一步就是「切过一次页之后整个面板点不了」。
       *
       * ⚠️ **`key` 变了意味着整棵子树重建**——包括 `projectsPage` 里的
       * 列表 DOM。这会让 `flipPos` 记录的位置失效（新节点还没被量过）。
       * `flipList` 对此是安全的：它遇到 `previous[key] === undefined` 就
       * 只记录、不动画——正好是「第一次见到这批行」该有的行为。
       */
      var body = h(
        'div',
        {
          key: 'page-' + String(view.state.navSeq || 0),
          className: 'dshpz-page',
          'data-nav': String(view.state.navDir || 0),
          /**
           * ## 转场结束 → **立刻把 `navDir` 复位成 0**（v2.4.18 修的严重 bug）
           *
           * ## 那个 bug 是什么
           *
           * 第一版只在导航时把 `navDir` 设成 ±1，**从来没有复位过**。
           * 而 CSS 里有一条：
           *
           * ```css
           * .dshpz-page[data-nav="1"],.dshpz-page[data-nav="-1"]{pointer-events:none}
           * ```
           *
           * 于是切过一次页之后，`data-nav` 永远是 ±1，那条 `pointer-events:none`
           * **永久生效** —— 用户报的「面板点不了」就是它：整个面板看得见、
           * 一个按钮都点不动，而且不报任何错。
           *
           * ## 为什么冒烟没抓到
           *
           * 那条测试只断言「导航时必须给 navDir」（钉了**写**），
           * 没断言「它必须被复位」（没钉**清**）。这类漏网很典型：
           * 一个状态有「进入」没有「退出」，静态断言只看进入就全绿。
           * 现在补了两条测试：状态必须复位 + 复位必须是 `onAnimationEnd` 触发的。
           *
           * ## 为什么复位挂在 `onAnimationEnd` 上
           *
           * 转场是 CSS 动画，它**自己知道什么时候结束**（`animationend`）。
           * 用定时器猜 200ms 会在「减少动效」下白等（那时压根没有动画），
           * 而用 `animationend` 精确对齐。减少动效时 CSS 把动画关掉，
           * 事件不会来 —— 所以下面**同时**做了兜底（见 `React.useEffect`）。
           */
          onAnimationEnd: function () {
            if (state.navDir !== 0) setState({ navDir: 0 })
          },
        },
        page,
      )

      /**
       * `.dshpz-scope` 是 v2.0.0 新增的**共同根类**（U5 缺口 A 的落点）：
       * 「减少动效」那条全局规则要限定在插件的挂载子树内，而插件原先没有统一容器类。
       * 主区面板与侧边栏按钮各挂一个，从此所有全局性规则都有落脚点。
       *
       * v2.1.3：面板内浮窗是这一层里的绝对定位层，所以这里同时是它的包含块。
       */
      return h('div', { className: 'dshpz-scope dshpz-host' }, body, buildFloatLayer(view, props))
    }

    /**
     * 面板内浮窗（v2.1.3）：新建项目那两条 AI 路的会话，在面板里看着它做。
     *
     * ## 为什么不是右侧浮动窗
     *
     * 右侧浮动 pane 住在 `sidebar-right` 的 `SessionView` 子树里，而那个子树在
     * `activePanelId !== null` 时被整条标 `hidden`（CSS `display:none`）。
     * 拼图面板一打开就满足那个条件——浮动窗会跟着整条右栏一起消失。
     * 见 §3.2 那条 CSS，以及 `themeOpen` 那段的同类取舍。
     *
     * ## 内嵌对话流怎么挂（照抄 ui-subagent 的范本）
     *
     * `conversation.content` 是**工厂槽位**，用 `renderFactorySlot` 渲染；
     * 它要一个 `SessionProvider`（宿主只认 `SessionReference`）与一个
     * `views` 局部槽位（不传就退化成默认 Chat 视图，这里显式给同一个，
     * 与 ui-subagent 的 `FixedChatConversationView` 一致）。
     *
     * ⚠️ `renderFactorySlot` 与 `SessionProvider` 都是**主区那条注册的 kit 发的**：
     * 前者每个 entry 都有，后者只在 `children` 里声明了非 root 作用域子槽位时才发。
     * 所以 `main` 那条注册声明了 `puzzle.build.chat`（见 `apply`）——
     * 少了它，这里两个 prop 都是 `undefined`，症状是浮窗一片空白。
     */
    /**
     * 浮窗头部那颗「大脑在跑」的指示（v2.3.x，需求 ④）。
     *
     * 三种情形分开说，**不把「不知道」说成「空闲」**：
     *   - `running`：转圈圈（复用 `.dshpz-spin`）+「运行中」；
     *   - `idle`：如实写「空闲」（会话在、但没在跑）；
     *   - 拿不到（还没拉到 live / 会话已不在）：**整颗不渲染**。
     *     浮窗刚打开的那一瞬 live 还没回来，此时写「空闲」是编的。
     *
     * 轮次只在有实时值时才附上：卡上那个 `goal …` 是派单时的快照，
     * 拿它当实时值会永远停在「轮 0」（见 `state.live` 那段说明）。
     */
    function brainRunBadge(view) {
      var build = view.state.build
      if (build === null || build === undefined) return null
      var live = liveOfIn(view, build.sessionId)
      if (live === null) return null
      var rounds = live.roundsStarted !== null && live.roundsStarted !== undefined
        ? '轮 ' + String(live.roundsStarted) + '/' + String(live.maxGoalRounds === null || live.maxGoalRounds === undefined ? '?' : live.maxGoalRounds)
        : ''
      if (String(live.status || '') === 'running') {
        return h('span', { className: 'dshpz-floatrun', 'data-run': 'running' },
          h('span', { className: 'dshpz-spin' }),
          h('span', null, '运行中' + (rounds === '' ? '' : '（' + rounds + '）')))
      }
      if (String(live.status || '') === 'idle') {
        return h('span', { className: 'dshpz-floatrun', 'data-run': 'idle' },
          h('span', null, '空闲' + (rounds === '' ? '' : '（' + rounds + '）')))
      }
      return null
    }

    function buildFloatLayer(view, props) {
      var build = view.state.build
      if (build === null || build === undefined) return null
      var sessionId = String(build.sessionId || '')
      /**
       * ## 三种浮窗的差别（v2.2.0）
       *
       * 用户拍板：
       *   - **大脑**：✕ 只是**收起**（会话要常驻，删了就没记忆了）；
       *   - **澄清器**：✕ 是**删掉这个子代理**——它的产物已经写回任务单，
       *     留着只会在侧边栏堆一堆一次性会话（用户原话：「指引用户直接按叉
       *     关浮窗顺便删掉这个起的子代理」）；
       *   - **新建项目**：✕ 是删除（v2.1.7 的老语义，不动）。
       *
       * 三种共用一层浮窗、一个 ✕ 位置，但**语义不同**——所以按钮的
       * `title` 与脚注必须按 kind 写清，否则用户会拿大脑的预期去按澄清器的叉。
       */
      var kind = typeof build.kind === 'string' && build.kind !== '' ? build.kind : 'build'
      var titles = {
        build: '新建项目 · 正在起会话',
        brain: '全局大脑',
        clarify: '澄清器 · 就这一张任务单',
        exec: '执行会话',
      }
      var icons = { build: 'puzzle', brain: 'brain', clarify: 'rules', exec: 'rules' }
      /**
       * ✕ 的语义按 kind 分（见上面那段）。
       *
       * `exec`（v2.4.3）：**只收起**，与大脑同一条纪律。
       *
       * ## 为什么执行会话不能「✕ = 删掉」
       *
       * 澄清器可以删，因为它的产物（四个字段）已经写回任务单了，删掉没有损失。
       * 而执行会话**还在跑**——它的 goal 驱动着这张卡的活，删掉会话等于把
       * 正在做的工作连同上下文一起丢掉，而卡还停在「在做」，成了一个永远不会
       * 有人推的孤儿。用户点一张「在做」的卡只是想**看它在干什么**，
       * 不该因为按了一次叉就把活弄没。
       */
      var closeDeletes = kind !== 'brain' && kind !== 'exec'
      /**
       * **大脑在不在干活**（v2.3.x，需求 ④）：只给 `kind === 'brain'` 挂这一颗。
       *
       * ## 为什么需要它
       *
       * 大脑是**常驻会话**，它不在侧边栏里显示「正在输入」，浮窗里也看不到
       * 它是不是在跑——用户点了「全局大脑」后只能看到一屏对话，无从判断
       * 它是在思考还是已经停了。这正是需求 ④ 说的「运行时有反馈」。
       *
       * ## 判据是宿主的 `agents.get(id).status`，不是浮窗自己的状态
       *
       * `state.brainBusy` 只覆盖「正在呼出」那几秒（那是**建会话**的过程），
       * 会话建好之后就恒为 false。此后它跑没跑只有宿主知道，
       * 所以这里读 `method:'live'`（见 `pollLive` / `liveIdsToPoll`）。
       *
       * 拿不到状态时**什么都不显示**，而不是显示「空闲」——浮窗刚打开的那一瞬
       * 还没拉到 live，此时说「空闲」是编的。
       */
      var runBadge = (kind !== 'brain' && kind !== 'exec') ? null : brainRunBadge(view)
      var head = h(
        'div',
        { className: 'dshpz-floathead' },
        icon(icons[kind], 16),
        h('div', { className: 'dshpz-floattitle' }, titles[kind]),
        runBadge,
        sessionId === '' ? null : h('span', { className: 'dshpz-floatsid' }, sessionId),
        h('button', {
          className: 'dshpz-act',
          title: '在主区打开这个会话（面板会让位给主区会话视图）',
          onClick: function () { openSessionById(sessionId) },
        }, '在主区打开'),
        /**
         * **停掉这个执行会话**（v2.4.14，用户报的「执行会话人为停止不了」）。
         *
         * ## 为什么入口在浮窗头部，而不是长回卡上
         *
         * v2.4.3 用户拍板「卡上按钮全删，只能移动触发」，所以停止不能长回卡上。
         * 而用户点开一张「在做」的卡，看到的正是这个浮窗——「它在干什么」与
         * 「我不想让它干了」是同一个场景里的两个动作，入口放在一起才对。
         *
         * ## 为什么只给 `exec` 挂
         *
         * 「停」的语义是「打断这张卡的执行会话当前那一轮」。大脑是**常驻**的
         * （没有卡、也没有「这一轮做完就结束」的目标），澄清器是用户正在里面
         * 一问一答的会话——两者都不该被这个按钮停。所以只有宿主给了卡 id
         * （`openSessionFloat('exec', …, {cardId})`）时才挂。
         *
         * ## 为什么文案要把「什么还在」写出来
         *
         * 「停」在别处容易被读成「删掉 / 搬走 / 放弃」。这里的真实后果是：
         * 只打断当前那一轮，**会话、goal、卡都在原地**（宿主侧那条分支的注释
         * 写明了「停 ≠ 放弃」）。含糊写一句「停止」会让用户以为这件事被取消了。
         */
        kind === 'exec' && String(build.cardId || '') !== ''
          ? h('button', {
            className: 'dshpz-act',
            'data-tone': 'danger',
            disabled: view.state.taskBusy === true,
            title: '停掉这张卡的执行会话：打断它当前这一轮。**会话、goal、卡都留在原地**'
              + '（goal 不会被清、卡不会搬列），待处理的消息也不丢——想接着做再派一次即可。'
              + '想连会话一起删，去卡详情浮窗里的「删除」（只有「已做」列才有）。',
            onClick: function () { stopCardSession(view, build.cardId) },
          }, '停')
          : null,
        /**
         * ✕ 的语义**按 kind 分**（见上面那段）。
         *
         * `build` / `clarify`：走 `deleteBuildSession` → RPC → 宿主
         * `workspaceRegistry.deleteSession`（真删转录目录）。
         * `brain`：只收起浮窗——它是常驻的，删掉等于把这个项目的记忆扔掉。
         */
        h('button', {
          className: 'dshpz-close',
          disabled: build.closing === true,
          title: closeDeletes
            ? (kind === 'clarify'
              ? '关掉浮窗并**删掉这个澄清子代理**（它的结论已经写回任务单，留着只会在侧边栏堆积）。只想收起、留着它就按 Esc。'
              : '永久删除这个会话（转录目录、附件、工作区记账一并清掉，不可撤销）。只想收起浮窗、留着会话就按 Esc。')
            : '收起浮窗。全局大脑是**常驻**的，不会被删掉——它记着这个项目。',
          onClick: function () { closeDeletes ? deleteBuildSession() : closeBuildFloat() },
        }, icon('close', 15, { weight: 'bold' })),
      )

      /**
       * 装不上 `puzzle_mode` 要**如实说**：含糊的「已起会话」会让用户以为
       * AI 能建项目，而它连 `op:init` 都没有（宿主半的 `wired` 就是为此回报的）。
       *
       * 大脑那条多一句：它的**文档段**也可能没进去（那是「它记不记得住项目」的关键）。
       */
      var wired = null
      if (build.wiredTool === true) {
        wired = h('div', { className: 'dshpz-hint' },
          kind === 'build'
            ? '`puzzle_mode` 已装上，它可以真的把项目建出来。'
            : '`puzzle_mode` 已装上，它可以把结论写回拼图文档。')
      } else if (build.wired !== '') {
        wired = h('div', { className: 'dshpz-warn' }, icon('alert', 13),
          h('span', null, '⚠️ `puzzle_mode` **没装上**（' + String(build.wiredReason || '未知原因')
            + '）' + (kind === 'build' ? '，这个会话建不了项目。' : '，这个会话写不回文档。')))
      }
      /**
       * 大脑：文档段没进去要说清——那是「它开口就知道这个项目已定什么」的依据。
       * 澄清器：有没有真从大脑分叉，也要说清（那是「它记不记得住上文」的依据）。
       *
       * ⚠️ 判据只读宿主给的 **`brainDoc` 布尔**，不解释 `brain` 那个状态词。
       * 这里踩过一次（v2.2.0 真机首报）：复用已装过的会话时宿主给的是 `'kept'`
       * （成功态），而这里当时按 `!== 'both'` 判 → 把成功报成「没完全注入（未知原因）」。
       * 同一规则写在两处必然漂移，所以结论由宿主给。
       */
      var extraNote = null
      if (kind === 'brain' && build.brainDoc !== true) {
        extraNote = h('div', { className: 'dshpz-warn' }, icon('alert', 13),
          h('span', null, '⚠️ 大脑的**冻结文档段**没注入（' + String(build.brainReason || '未知原因') + '）。'))
      }
      if (kind === 'clarify' && build.inherited !== true) {
        extraNote = h('div', { className: 'dshpz-warn' }, icon('alert', 13),
          h('span', null, '⚠️ 这个澄清器**没有**从全局大脑分叉——它没有继承上文。'))
      }

      var chat
      /**
       * 「正在删」那一小段（v2.1.6）：`deleteBuildSession` 会**先放掉
       * `reference`** 再等归档返回。那一小段时间里**不能**再渲染对话流
       * ——`SessionProvider` 拿到 `null` 的 `session` 会炸。所以这一态单独给一句话。
       */
      if (build.closing === true) {
        chat = h('div', { className: 'dshpz-chat', 'data-ready': '0' },
          h('div', null, '正在永久删除这个会话…'))
      } else if (build.error !== null && build.error !== undefined) {
        /**
         * 两种失败共用 `error`，但**话不一样**（v2.1.7）：
         *   - `failed:'delete'`：删没删掉。要说清「会话还在」，并给出宿主半那句出路；
         *   - 其余：会话起好了但这个面板还没拿到它（`retain` 抛错那条路）。
         * 混成一句会让「删失败」显示成「还没拿到它」，那是错的。
         */
        var deleteFailed = build.failed === 'delete'
        chat = h('div', { className: 'dshpz-chat', 'data-ready': '0' },
          h('div', null,
            h('div', null, deleteFailed ? '这个会话没删掉：' : '会话已经起好了，但这个面板还没拿到它：'),
            h('div', { className: 'dshpz-err' }, icon('alert', 14), h('span', null, String(build.error))),
            build.notice === null || build.notice === undefined
              ? null
              : h('div', { className: 'dshpz-muted', style: { marginTop: '8px' } }, String(build.notice)),
            deleteFailed
              ? h('div', { className: 'dshpz-muted', style: { marginTop: '8px' } },
                '会话还在侧边栏里。点 ✕ 可以重试，或按 Esc 先收起浮窗。')
              : h('div', { className: 'dshpz-muted', style: { marginTop: '8px' } },
                '它已经在侧边栏里了——点上面「在主区打开」或直接从侧边栏进去。')))
      } else if (build.reference === null || build.reference === undefined) {
        /**
         * **引用已作废，但还没接回来**（v2.4.16）——「切走再切回白屏」的第二个落点。
         *
         * ## 为什么必须有这一支：`useEffect` 比第一帧晚
         *
         * 切走时面板卸载、清理 `release()` 掉引用（必须），切回来时面板重新挂载。
         * 而**重新 `retain()` 那条 effect 在首次提交之后才跑**，所以挂载后的第一帧
         * `build.reference` 还是空的。那一帧如果把 `null` 交给 `SessionProvider`，
         * 宿主 `bindingSource()` 会去读 `null.binding` 而**直接抛 TypeError**
         * （见宿主 `ui-session-client.js:206`：只有 `undefined` 才走 absent 分支），
         * 整格被错误边界判死 → 还是白屏。
         *
         * 所以这一帧**如实降级成一句话**，不把死引用递给宿主；紧接着那条 effect
         * 补上引用、`setState` 触发重渲染，下一帧就是正常对话流。这不是防御性代码，
         * 是「渲染不能有副作用、而 repair 只能发生在提交之后」这条 React 硬规则的落点。
         */
        chat = h('div', { className: 'dshpz-chat', 'data-ready': '0' },
          h('div', null, '正在接回这个会话…'))
      } else {
        chat = h('div', { className: 'dshpz-chat' },
          h(props.SessionProvider, {
            session: build.reference,
            children: props.renderFactorySlot('conversation.content', {
              variant: 'embedded',
              /**
               * 相位**写死 `active`**：这个会话是刚被投了提示词的，
               * 不是空会话——`hero` 那一屏（品牌语 + 选工作区）在这里没有意义。
               * 宿主自己的相位判定要 `useSession` / `useConversation`，
               * 而那两个 hook 只在 session 作用域的 kit 里发（见 `apply` 里
               * `puzzle.build.chat` 那段为什么只声明、不注册）。
               */
              phase: 'active',
              hero: false,
            }, { slots: { views: FixedBuildChatView } }),
          }))
      }

      return h(
        'div',
        { className: 'dshpz-float' },
        h(
          'div',
          { className: 'dshpz-floatbox' },
          head,
          h('div', { className: 'dshpz-floatbody' }, chat),
          h(
            'div',
            { className: 'dshpz-floatfoot' },
            h('div', { className: 'dshpz-hint', style: { margin: '0' } },
              kind === 'brain'
                ? '右上角 ✕ 只**收起浮窗**——全局大脑是常驻的，它记着这个项目；按 Esc 同效。'
                : kind === 'exec'
                  ? '右上角 ✕ 只**收起浮窗**——关掉浮窗不会停下它；要停就点上面的「停」（停的只是这张卡执行会话当前那一轮，会话与 goal 都还在）；按 Esc 同效。'
                  : kind === 'clarify'
                    ? '澄清完就按右上角 ✕：它会把**这个澄清子代理删掉**（结论已经写回任务单，留着只会在侧边栏堆积）。'
                    : '右上角 ✕ 会**永久删除这个会话**（转录目录、附件、记账一并清掉，不可撤销）；'
                      + '只想收起浮窗、留着会话就按 Esc。'),
            extraNote,
            wired,
          ),
        ),
      )
    }

    /**
     * 浮窗里的对话流**没有单独注册组件**（v2.1.3）。
     *
     * ## 为什么不注册
     *
     * 面板侧只需要「一个 `SessionProvider` + 一个 `renderFactorySlot`」，
     * 而这两样 `Panel` 的 props 里本来就有。多注册一个 `main` 子槽位是**白加一层**
     * ——它会把「本插件注册了几个 Slot」从 2 变成 3，而那个数字是宿主的
     * 槽位拓扑事实，不该为一次渲染便利而改。
     *
     * ## 那为什么 `main` 还要声明 `puzzle.build.chat`
     *
     * 因为 `SessionProvider` 是**按 children 声明发的**（见 ui-renderer 的
     * `standardKit`：只有 `children` 里有非 root 作用域子槽位时才发）。
     * 声明是拿 `SessionProvider` 的代价，不是拿一个新槽位的收益——
     * 它是 `single` 且**故意不注册**，所以永远渲染 `null`。
     */

    /** 固定的 Chat 视图选择（与 ui-subagent 的 `FixedChatConversationView` 同一做法）。 */
    function FixedBuildChatView(props) {
      return props.renderSlot('conversation.session', { view: 'chat' })
    }

    /**
     * 关闭面板：走宿主的 `layout.selectPanel(null)`。
     *
     * 为什么必须走宿主：面板现在**就是主区本身**，它没有「把自己藏起来」的能力——
     * 直接改 `state.open` 只会让下一次渲染又把它画回来（宿主仍认为它选中）。
     */
    function closePanel() {
      var ctx = panelCtx
      try {
        var layout = ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('layout') : undefined
        if (layout !== undefined && layout !== null && typeof layout.selectPanel === 'function') {
          layout.selectPanel(null)
          return
        }
      } catch (_error) {
        /* 拿不到 layout：退回下面那条 */
      }
      // 兜底：至少退回列表页，让按键有可见效果。
      // v2.4.17：这也是「返回」，所以方向同样是往左（与 Esc 那条一致）。
      setState({
        view: 'projects',
        detail: null,
        detailName: null,
        navDir: -1,
        navSeq: (state.navSeq || 0) + 1,
      })
    }

    /**
     * 切到拼图面板（从别的主面板切过来）。
     *
     * 用于「照项目建」那类「切到某个会话、填完草稿、再切回拼图」的流程（U3 方案 B）。
     * 拿不到 layout 时静默失败——那时用户本来就还在拼图面板里，没有需要切回的地方。
     */
    function openPanel() {
      var ctx = panelCtx
      try {
        var layout = ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('layout') : undefined
        if (layout !== undefined && layout !== null && typeof layout.selectPanel === 'function') {
          layout.selectPanel(PANEL_ID)
        }
      } catch (_error) {
        /* 静默：没有 layout 服务时什么也做不了，而这不是用户能修的 */
      }
    }

    /* ---------------------------- 侧边栏入口按钮 ---------------------------- */

    /**
     * 侧边栏常驻按钮（v2.0.0，U1）。
     *
     * ## 它承担三件在 v1.x 里分散的事
     *
     * 1. **入口**：点它切主区到拼图面板（走 `ctx.layout.selectPanel(PANEL_ID)`）；
     * 2. **选中态**：宿主把 `active` 当 prop 传进来，也读 `state.view`——两者都要认
     *    （宿主是权威，`state.view` 是兜底，某些路径下 prop 可能还没刷新）；
     * 3. **主题常驻**：v1.x 里「一直可见」的是输入框那个小按钮，它挂载时拉主题
     *    （`loadActiveTheme`）并挂 `applyUserTheme`。按钮搬到侧边栏后，**这份职责
     *    跟着搬到这里**——否则不打开面板时按钮不换色。
     *
     * ⚠️ `loadActiveTheme` 原先**要会话 ID**（v1.x 主题按会话取）。v2.0.0 起
     * 主题本就是全局状态，不该按会话取，所以现在传空串即可（宿主半那条路
     * `action:'css'` 不读 sessionId）。
     *
     * ## 图标
     *
     * 用**现在小按钮里的那个图形**（`icon('puzzle', size)`）——用户要求「是同一个」。
     * 尺寸取宿主给的 `size`（它请求的是图标边长），拿不到就用 18。
     */
    function SidebarButton(props) {
      var view = useStore()
      var size = typeof props.size === 'number' && props.size > 0 ? props.size : 18
      var active = props.active === true || view.state.view === 'project' || view.state.view === 'projects'

      /**
       * 主题常驻：挂载时拉一次，并跟着 `themeCss` 重挂。
       *
       * 为什么不能等面板打开：这颗按钮**一直显示**，而面板是用户点进去才渲染的。
       * 主题 CSS 只跟着面板走的话，不进面板就永远看不到按钮换色。
       */
      React.useEffect(
        function () {
          loadActiveTheme('')
        },
        [],
      )

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
          /**
           * `.dshpz-scope` 与主区面板**同一个根类**：U5 的「减少动效」规则
           * 要同时罩住这两处，而它们不在同一棵子树里。
           */
          className: 'dshpz-scope dshpz-sidebtn',
          'data-on': active ? '1' : '0',
          title: '拼图',
          'aria-label': '拼图',
          onMouseDown: function (event) {
            event.preventDefault()
          },
          onClick: function () {
            openPanel()
          },
        },
        // 这里**只画图标**：文字由宿主按注册时的 `label: '拼图'` 渲染在自己那一格里。
        // 取景框收紧到拼图块自己的外接框，否则填充块比宿主那几颗描边图标小一圈。
        icon('puzzle', size, { box: PUZZLE_BOX }),
      )
    }

    /**
     * **FLIP 列表重排**（U5 #3 / #12）：新建项目后插一行时，让已有的行**平滑让位**。
     *
     * ## 为什么不用 CSS 过渡直接搞定
     *
     * 列表重排时元素**换的是 DOM 位置**，而 `transform` 是相对自身原位的——
     * 位置一变，`transform` 也就跟着变了，CSS 根本不知道「它原来在哪」。
     * 所以必须：**先记旧位置 → 让 React 重排 → 再读新位置 → 用 `transform`
     * 把它先拉回旧位置 → 下一帧去掉 `transform` 让它过渡过去**。这就是 FLIP。
     *
     * ## 三个坑（U5 明确列出，都在这里处理）
     *
     * 1. **React 重渲染会把 transform 冲掉**：所以要在**同一帧内**设好 transform
     *    （本函数在 `useEffect` 里跑，读到的已是新布局）；
     * 2. **轮询会打断动画**：`load()` 每 8 秒重渲染一次。这里挂一个
     *    `state.flipBusy` 标志位，轮询回调见到它就跳过本次数据应用——
     *    否则卡飞到一半会被新数据「按」回原位；
     * 3. **动画期间用户又操作了**：同一批元素再次重排时，**取消上一次过渡**
     *    （直接把 `transform` 清掉重新开始），不让两条过渡叠加。
     *
     * ⚠️ **只动 `transform`**（性能红线）：绝不写 `top` / `left` / `margin`，
     * 那会在长列表上逐帧重排。
     * ⚠️ **先问 `motionOn()`**：系统开了「减少动效」就**直接落位**，不做过渡
     * （CSS 的媒体查询管不到 JS 动画——这正是 U5 缺口 C）。
     */
    function flipList(container, previous) {
      if (container === null || container === undefined) return
      var nodes = container.children
      if (nodes === undefined || nodes.length === 0) return
      // 减少动效：不做过渡，但**仍要更新记录**（否则下次重排会拿一份过期位置）。
      var animate = !motionOn()
      for (var i = 0; i < nodes.length; i += 1) {
        var node = nodes[i]
        var key = node.getAttribute === undefined ? null : node.getAttribute('data-key')
        if (key === null) continue
        var next = node.getBoundingClientRect !== undefined ? node.getBoundingClientRect() : null
        var was = previous[key]
        if (next !== null) previous[key] = next.top
        if (!animate || was === undefined || next === null) continue
        var delta = was - next.top
        // 位置没变就不用动（避免给每一行都白挂一次 transform）。
        if (Math.abs(delta) < 1) continue
        /**
         * 坑 3：**取消上一次过渡**——先摘掉上一轮的类，不让两条叠加。
         *
         * ⚠️ v2.4.17 修的真 bug：这里原先写的是 `node.style.transition = 'none'`。
         * 行内样式优先级**高于类**，而下面挂的 `.dshpz-flip` 正是靠类给过渡的
         * ——于是那行 `transition:none` 把过渡整个压掉，元素**直接跳到终点**。
         * 也就是说：**列表重排的 FLIP 从加进来那天起一次都没播过**，
         * 只是它退化得「安静」（行还是会移动，只是没有过程），没人报过。
         *
         * 修法是改用 `dshpz-move-off` 这个类：加类 → 设起点 → 回流 →
         * 摘类挂 `.dshpz-flip` → 清 transform。全程不碰行内 `transition`。
         */
        node.classList.remove('dshpz-flip')
        node.classList.add('dshpz-move-off')
        node.style.transform = 'translateY(' + delta + 'px)'
        // 强制回流一次，让「先拉回旧位置」这一帧真的生效（否则浏览器会合并两次修改）。
        void node.offsetHeight
        /**
         * 从「拉回旧位置」过渡到「真实位置」：用 CSS 类给过渡，动画完再摘掉。
         *
         * ⚠️ **必须走类、不能直接写 `node.style.transition`**：内联的
         * `transition` 会在**下一次 hover** 时也生效，于是 hover 的
         * `translateY(-1px)` 变得黏糊糊（原本是 `dur-fast`，被拖成 `dur-slow`）。
         * 类只在重排这一瞬间挂着，摘掉之后 hover 回到自己的节奏。
         */
        node.classList.remove('dshpz-move-off')
        node.classList.add('dshpz-flip')
        node.style.transform = ''
        // 过渡结束就摘类（`transitionend` 只在真的发生过渡时触发，正合需要）。
        var done = function () {
          node.classList.remove('dshpz-flip')
          node.removeEventListener('transitionend', done)
        }
        node.addEventListener('transitionend', done)
      }
    }

    /**
     * **让一张卡从旧列飞到新列**（v2.4.17，本版的主运动焦点）。
     *
     * ## 它解决的问题
     *
     * 搬卡成功后，那张卡「啪」一下出现在新列。用户得重新扫一遍整个看板，
     * 才知道刚才那一下成功了没有、卡跑到哪去了。旧版的 `.dshpz-cardfly`
     * 是一次淡入 + 缩放——那是**入场**的语言（「有个新东西出现了」），
     * 而事实是**同一个东西换了位置**。这两件事在观感上正好相反：
     * 入场会把「它还是原来那个」这个最重要的信息抹掉。
     *
     * ## 做法（FLIP 的变体，与 `flipList` 同一套纪律）
     *
     * ```
     * ① 搬卡前：量旧矩形 → state.flyFrom
     * ② 搬卡后（本函数，在 useEffect 里跑，读到的已是新布局）：
     *    量新矩形 → 算出「旧位置减新位置」的差值
     * ③ 把这个差值写成 transform：于是它**看起来还在旧位置**
     * ④ 下一帧清掉 transform + 挂上过渡类：它滑向真实位置
     * ```
     *
     * ## 为什么差值要**反着**加
     *
     * `transform` 是相对元素**现在所在的位置**。元素现在在新列，要让它在
     * 视觉上回到旧列，就得平移 `旧 - 新`。反过来加（`新 - 旧`）会让它
     * 从更远的地方飞过来——那是错的，而且错得很明显（会飞出看板外）。
     *
     * ## 为什么横向与纵向都要算
     *
     * 窄屏只有一列，「换列」表现为**纵向**滚动位置变化。只算 `x` 的话，
     * 窄屏上飞行是 0px（卡原地不动），看起来像没做动画。两个轴都算，
     * 宽屏纵向量到接近 0、窄屏横向量到接近 0，各自自然。
     *
     * ## 三个必须处理的边界
     *
     * 1. **量不到起点**（`flyFrom === null`）：不播飞行，让 CSS 的
     *    `dshpz-cardfly` 兜底成淡入。**不编起点**（见 `flyFrom` 的注释）。
     * 2. **位移太小**（< 8px）：不播。那种情况下飞行只是「抖一下」，
     *    而它其实没怎么动——同列换排就属于这一类（虽然那时 `flyId` 已经是 null）。
     * 3. **减少动效**：`motionOn()` 为真就整段跳过。CSS 的媒体查询管不到
     *    JS 直接写的 `transform`（U5 缺口 C）。
     *
     * ## 为什么必须清 `flyId`
     *
     * 不清的话，下一次 8 秒轮询引起的重渲染会重新挂上类、**再播一遍**——
     * 看板会一直闪。用 `animationend` 而不是定时器：减少动效下压根没有
     * 动画，定时器会清得太晚（那时 `flyId` 已经过期了，清它没有意义，
     * 但晚清的那几百毫秒里它是脏的）。
     *
     * @param cardId 要飞的那张卡的 id（`state.flyId`）
     * @param from 搬卡前的矩形（`state.flyFrom`），`null` = 没量到
     * @returns 是否真的播了飞行（测试用它区分「播了」与「降级了」）
     */
    function travelCard(cardId, from) {
      if (cardId === null || cardId === undefined || String(cardId) === '') return false
      if (from === null || from === undefined) return false
      if (motionOn()) return false
      if (typeof document === 'undefined' || document === null || typeof document.querySelector !== 'function') return false
      /**
       * 找到**新列里的那张卡**。
       *
       * ⚠️ 用 `data-card-id` 而不是从 `state` 里拿 DOM 引用：卡是 React 渲染的，
       * 每次重渲染都是新节点，任何缓存的引用都会在下一轮失效。
       * 属性查询永远拿当前那个。
       */
      var node = null
      try {
        var nodes = document.querySelectorAll('.dshpz-card[data-card-id]')
        for (var i = 0; i < nodes.length; i += 1) {
          if (String(nodes[i].getAttribute('data-card-id')) === String(cardId)) { node = nodes[i]; break }
        }
      } catch (_error) {
        return false
      }
      if (node === null) return false
      if (typeof node.getBoundingClientRect !== 'function') return false
      var box = node.getBoundingClientRect()
      if (box === null || !isFinite(box.left) || !isFinite(box.top)) return false
      var dx = Number(from.left) - box.left
      var dy = Number(from.top) - box.top
      // 位移太小：不是「换列」，别抖一下（同列换排本来就该静默）。
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return false
      /**
       * ① 先把它**拉回旧位置**。
       *
       * ⚠️ 这里挂 `dshpz-move-off` 而**不是**写 `node.style.transition='none'`：
       * 行内样式优先级高于类，那行会一直留着，把下面类里的过渡压掉——
       * 结果就是「卡瞬间出现在新位置」，飞行根本不播。这正是 `flipList`
       * 一直以来的 bug（见 `dshpz-cardtravel` 那段注释）。
       */
      node.classList.add('dshpz-move-off')
      node.style.transform = 'translate(' + dx + 'px,' + dy + 'px)'
      /**
       * ② 强制回流一次：浏览器会把同一帧内的两次样式修改合并，
       *    不强制的话「拉回旧位置」与「放归零」会被合并成一次，
       *    于是**没有过渡**，卡直接在新位置（这正是 E4.1.2 记的那个坑）。
       */
      void node.offsetHeight
      /**
       * ③ 换成飞行类（摘掉 `move-off`）并放归零。
       *
       * 顺序不能反：先摘 `move-off`、再挂飞行类、最后清 `transform`——
       * 浏览器在**这一步之后**取过渡参数，那时过渡已经生效。
       * 若先清 `transform` 再摘 `move-off`，那一次变化仍然是无过渡的。
       */
      node.classList.remove('dshpz-move-off')
      node.classList.add('dshpz-cardtravel')
      node.style.transform = ''
      return true
    }

    /**
     * 接收列「合上」的那一下（v2.4.17）。
     *
     * ## 为什么是列，不是卡
     *
     * 卡自己的飞行已经说明了「它去哪」。列再亮一下是把另一件事说出来：
     * **这个槽接住了它**。两块拼图合上的那一下，动静在两个零件之间，
     * 不在其中任何一个上。
     *
     * ## 为什么只亮描边、不位移
     *
     * 五列是并排的邻居。某一列位移 2px，整块板子都会看起来在抖——
     * 而这条动效的作用只是**指出是哪一列**，不是「庆祝成功」。
     * （成功有它自己的表达：卡左边那道状态条变绿 / 变红。）
     *
     * @param col 列键（`state.landedCol`）
     * @returns 是否真的挂上了（测试用它断言「换列才庆祝」）
     */
    function landColumn(col) {
      if (col === null || col === undefined || String(col) === '') return false
      if (motionOn()) return false
      if (typeof document === 'undefined' || document === null || typeof document.querySelector !== 'function') return false
      var node = null
      try {
        var nodes = document.querySelectorAll('.dshpz-boardcol[data-col]')
        for (var i = 0; i < nodes.length; i += 1) {
          if (String(nodes[i].getAttribute('data-col')) === String(col)) { node = nodes[i]; break }
        }
      } catch (_error) {
        return false
      }
      if (node === null) return false
      node.setAttribute('data-landed', '1')
      return true
    }

    /**
     * **切换主视图**（v2.1.1，用户报「主题页、更新页切换无用」）。
     *
     * ## 用户报的是什么
     *
     * 「一级面板主题页、更新页切换无用」——切过去之后就**回不来**了：
     * 主题页与更新页原先各有自己的顶栏（`.dshpz-thead`），里面**没有**那套
     * 「项目 / 主题 / 更新」分段控件，只有一颗「← 返回」。于是：
     *   ① 从主题页想去更新页，得先返回、再点更新（两步，且看不出来）；
     *   ② 两颗「← 返回」长得一样，用户点了以为没反应。
     *
     * ## 改法（用户拍板：三页共用一个常驻顶栏分段控件）
     *
     * 把分段控件抽成 `viewTabs`，**三页的顶栏都画它**。任何一页都能一步切到
     * 另外两页；「← 返回」保留（两处都能走，不会有人找不到路）。
     *
     * ## 为什么这里要一起管取数
     *
     * 原来那套分段控件在 `onClick` 里手写了 `if theme → loadThemes / if update → …`。
     * 三处各写一遍必然漂移（切过去的页拿不到数据 → 空态 → 「切换无用」）。
     * 收口成一个函数，切哪页就拉哪页的数据。
     *
     * ## v2.4.17：顺带把**转场方向**定下来
     *
     * 三页在导航栏上的**排列顺序**就是它们的空间关系：项目 → 主题 → 更新。
     * 所以方向可以直接由「在那一排里往左走还是往右走」算出来——
     * 这正是用户心里对这件事的模型（顶上一排标签，往右点就是往右走）。
     *
     * ⚠️ 为什么不在 `viewTabs` 里算：`switchToView` 还有别的调用点
     * （「← 返回」按钮、Esc 回退、二级页回列表）。**每一个入口都要有方向**，
     * 而它们各自知道自己的语义（返回＝后退）。放在这里统一算，
     * 那些调用点只需照常调它，方向自动对。
     *
     * 拿不到当前页（`state.view` 不是这三页之一，比如停在二级项目页）时
     * 按「前进」算：从二级回一级在导航语义上就是往**左**……但这里给的是
     * 一级内部的方向。二级 → 一级是 `backToProjects`，不走这个函数。
     */
    function switchToView(view, next) {
      /**
       * 三页的排列位置（与 `viewTabs` 里那个数组**同序**）。
       *
       * ⚠️ 两处同序是硬约束：这里算方向、那里画控件。改了顺序要一起改，
       * 否则会出现「往右点却从左边进来」——那种错很小，但用户会觉得
       * 「这个界面有点怪」，而说不清哪里怪。
       */
      var ORDER = ['projects', 'theme', 'update']
      var from = ORDER.indexOf(String(state.view || 'projects'))
      var to = ORDER.indexOf(String(next))
      var dir = 0
      if (from >= 0 && to >= 0 && from !== to) dir = to > from ? 1 : -1
      var patch = { view: next, detail: null, detailName: null, navDir: dir }
      /**
       * 只有**真的换页**才 +1 序号。同一页重复点（比如在「主题」页再点「主题」）
       * 不该重播转场——那会让页面无故闪一下，而用户什么都没做。
       */
      if (dir !== 0) patch.navSeq = (state.navSeq || 0) + 1
      if (next === 'theme') {
        setState(patch)
        loadThemes(state.sessionId)
        loadThemeRepo(state.sessionId)
        return
      }
      if (next === 'update') {
        setState(patch)
        checkUpdateNow()
        loadStaged()
        loadReleases()
        return
      }
      setState(patch)
      loadWorkspace()
      loadProjects(state.sessionId)
    }

    /**
     * 三页共用的「项目 / 主题 / 更新」分段控件。
     *
     * ⚠️ 必须在**三页的顶栏里都渲染**：只在一级页有它，正是用户报的那个 bug
     * （切过去之后控件消失，看起来像「切换没用」）。
     */
    function viewTabs(view) {
      return h(
        'div',
        { className: 'dshpz-seg dshpz-seg-main' },
        [['projects', '项目'], ['theme', '主题'], ['update', '更新']].map(function (pair) {
          return h(
            'button',
            {
              key: pair[0],
              type: 'button',
              'data-on': view.state.view === pair[0] ? '1' : '0',
              title: pair[0] === 'projects'
                ? '这个工作区里的拼图项目'
                : (pair[0] === 'theme' ? '主题：换肤、开发与分享' : '更新：对比线上版本、看更新日志'),
              onClick: function () { switchToView(view, pair[0]) },
            },
            pair[1],
          )
        }),
      )
    }

    /**
     * 一级面板：**项目列表页**（v2.0.0，U2）。
     *
     * ## 它取代了什么
     *
     * v1.x 的第一屏是「当前项目的工作台」或「未绑定空态」。v2.0.0 起第一屏是
     * **这个工作区里有哪些拼图项目**（纵向列表，一行一个），点一行进二级。
     *
     * ## 三个区域
     *
     *   1. **数据工作区**：绑定 / 显示当前根路径（U3 追加拍板 ②）。没绑时是空态，
     *      提示「绑定一个工作区」——**不偷偷用进程目录兜底**（那会把文档写错地方）；
     *   2. **项目列表**：一行一个项目（名字 · 健康性 · 模块数 · 更新时间）；
     *   3. **新建项目**：内联展开的表单（U2 待定项建议「内联展开，少一层导航」）。
     *
     * ## 一级内的切换（U4 拍板 ⑥）
     *
     * 主题页 / 更新页**提到一级**做切换——它们是面板级的东西，跟「哪个项目」无关。
     */
    function projectsPage(view, listRef, flipPos) {
      var workspace = view.state.workspace
      var bound = workspace !== null && workspace !== undefined && workspace.ok === true && workspace.bound === true
      var list = view.state.projects
      var rows = list !== null && list !== undefined && Array.isArray(list.projects) ? list.projects : []
      var openName = list !== null && list !== undefined && typeof list.currentProject === 'string' ? list.currentProject : ''
      var loadingList = list === null || list === undefined

      var head = h(
        'div',
        { className: 'dshpz-head' },
        h('span', { className: 'dshpz-logo' }, icon('puzzle', 18)),
        h(
          'div',
          { className: 'dshpz-headtext' },
          h('h3', { className: 'dshpz-title' }, '拼图'),
          h(
            'div',
            { className: 'dshpz-sub' },
            bound ? (workspace.workspacePath || '') : '还没绑定数据工作区',
          ),
        ),
        // 一级内切换：项目列表 / 主题 / 更新。
        // v2.1.1 起抽成 `viewTabs`，**三页共用同一个控件**（用户报「切换无用」的修法）。
        viewTabs(view),
        h(
          'button',
          {
            className: 'dshpz-close',
            title: '刷新项目列表',
            onClick: function () {
              loadWorkspace()
              loadProjects(view.state.sessionId)
            },
          },
          icon('refresh', 15),
        ),
        h(
          'button',
          {
            className: 'dshpz-close',
            title: '关闭（Esc）',
            onClick: function () { closePanel() },
          },
          icon('close', 15, { weight: 'bold' }),
        ),
      )

      var notice = view.state.notice === null || view.state.notice === undefined
        ? null
        : h('div', { className: 'dshpz-notice' }, icon('alert', 14), h('span', null, String(view.state.notice)))

      /** 一级页的错误行。为什么要它：见 `errorLine` 被使用处那段注释（v2.1.4）。 */
      var errorLine = view.state.error === null || view.state.error === undefined
        ? null
        : h('div', { className: 'dshpz-err' }, icon('alert', 14), h('span', null, String(view.state.error)))

      /**
       * **数据工作区**区。
       *
       * 「绑非空工作区要提醒」这条按升级方案实现：判据是**该工作区有没有会话**
       * （`sessionIds.length === 0`）——用 `useWorkspaces` 快照里现成的字段，
       * 零成本、且语义最贴近「AI 会不会在里面干活」。
       * 宿主半看不到这份快照，所以提醒在**这里**判、而不是在 RPC 里。
       */
      var workspaceBlock = h(
        'div',
        { className: 'dshpz-sect' },
        h('div', { className: 'dshpz-secttitle' }, '数据工作区', h('span', { className: 'dshpz-count' }, bound ? '已绑定' : '未绑定')),
        h('div', { className: 'dshpz-docpath' }, bound ? String(workspace.workspacePath || '') : '（还没绑定）'),
        h('div', { className: 'dshpz-muted', style: { marginTop: '5px', lineHeight: '1.55' } },
          bound
            ? '拼图项目文档与任务单都存在这个工作区里。'
            : '拼图文档与任务单要存在一个工作区里。**没绑就是没绑**——插件不会退回进程目录（那会把文档写到你看不见的地方）。'),
        workspacePicker(view),
      )

      var newBlock = view.state.newOpen === true
        ? h(
          'div',
          { className: 'dshpz-sect' },
          h('div', { className: 'dshpz-secttitle' }, '新建项目'),
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
            'div',
            { className: 'dshpz-acts' },
            /**
             * 三个按钮**全部接通**（v2.1.2）。
             *
             * ## 它们为什么曾经是灰的
             *
             * v2.0.0 时「交给 AI 的动作」被整体停用，理由是那个版本的面板住在
             * `main` 槽位里、**拿不到 `inputActions`**，于是「填提示词进输入框」
             * 这条路根本走不通。一级页这三个按钮跟着一起灰了。
             *
             * ## 现在为什么能接通
             *
             * 两条路都不再需要 `inputActions`：
             *   - 「立刻建」走 `method:'create'`，是纯本地写（宿主直接建文件夹）；
             *   - 另两个走 `method:'build'`，由**宿主**起一个会话、把提示词投进去
             *     （与派单同一条三跳链路）。提示词是宿主投的，不经过浏览器输入框。
             *
             * ## 三个按钮的分工
             *
             * | 按钮 | 谁干活 | 落点 |
             * |---|---|---|
             * | 立刻建 | 宿主直接建 | 建文件夹 + 主文档，模块名按表单填的建 |
             * | 快速建空壳 | 新会话里的 AI | 它自己 `op:init`，不采访 |
             * | 采访后再建 | 新会话里的 AI | 先采访（只问表单没填的）再 `op:init` |
             *
             * 后两个**慢**（要起会话），所以 `buildBusy` 期间整组禁用，防连点造出多个会话。
             */
            h('button', {
              className: 'dshpz-act',
              disabled: view.state.buildBusy === true,
              title: '按表单立刻建出项目文件夹与文档（本地直接建，不起会话）',
              onClick: function () { createByForm(view) },
            }, '立刻建'),
            h('button', {
              className: 'dshpz-act',
              disabled: view.state.buildBusy === true,
              title: '起一个会话，让 AI 按表单信息直接建（不采访）',
              onClick: function () { buildViaSession(view, 'shell') },
            }, view.state.buildBusy === true ? '正在起会话…' : '快速建空壳'),
            h('button', {
              className: 'dshpz-act',
              disabled: view.state.buildBusy === true,
              title: '起一个会话，先问清表单没填的部分，再建',
              onClick: function () { buildViaSession(view, 'interview') },
            }, '采访后再建'),
            h('button', { className: 'dshpz-act', onClick: function () { setState({ newOpen: false }) } }, '取消'),
          ),
          h('div', { className: 'dshpz-hint' },
            '「立刻建」在本地直接建；另两个会**起一个新会话**让 AI 来建，'
            + '并在**这个面板里**弹出一个浮窗让你看着它做'
            + '（会话本身也会进侧边栏——DSH 没有「临时会话」这种东西）。'),
        )
        : null

      return h(
        'div',
        { className: 'dshpz-panel' },
        head,
        h(
          'div',
          { className: 'dshpz-body dshpz-body-single' },
          h(
            'div',
            { className: 'dshpz-col' },
            styleWarningOf(view),
            /**
             * ## 一级页也必须把 `state.error` 显示出来（v2.1.4 修的真 bug）
             *
             * 症状：**点了「快速建空壳 / 采访后再建」什么反应都没有**。
             *
             * 根因不在那两颗按钮上，而在这一页**从来不渲染 `view.state.error`**
             * ——全仓只有二级页（`panelBody`）渲染它。于是所有在一级页发生的失败
             * 都只写进了状态、没有任何一处显示：
             *   - `buildViaSession` 的「请先填项目名」（没填名字就点，最常见的那条路）；
             *   - `createByForm` 的同一句；
             *   - `method:'build'` 的 RPC 失败（没绑工作区、起会话失败、装不上工具）。
             *
             * 用户看到的就是「点了没用」——**失败被静默吞掉**，不是没反应。
             * 这属于「不把失败伪装成成功」，所以补的是这一页，而不是去动按钮。
             *
             * 放在 `notice` 之前：错误比一次性说明更该被看见。
             */
            errorLine,
            notice,
            workspaceBlock,
            h(
              'div',
              { className: 'dshpz-sect' },
              h(
                'div',
                { className: 'dshpz-secttitle' },
                '项目',
                h('span', { className: 'dshpz-count' }, loadingList ? '…' : String(rows.length)),
                h(
                  'button',
                  {
                    className: 'dshpz-act',
                    style: { marginLeft: 'auto' },
                    title: '在这个工作区里新建一个拼图项目',
                    disabled: !bound,
                    onClick: function () { setState({ newOpen: view.state.newOpen !== true, view: 'projects' }) },
                  },
                  '＋ 新建项目',
                ),
              ),
              !bound
                ? h('div', { className: 'dshpz-empty' },
                  h('span', { className: 'dshpz-emptyicon' }, icon('grid', 24)),
                  h('div', { className: 'dshpz-emptytitle' }, '先绑定一个工作区'),
                  h('div', { className: 'dshpz-muted' }, '绑好之后这里会列出那个工作区里的全部拼图项目。'))
                : loadingList
                  ? h('div', null,
                    h('div', { className: 'dshpz-skel', style: { width: '72%', height: '34px', marginBottom: '8px' } }),
                    h('div', { className: 'dshpz-skel', style: { width: '62%', height: '34px', marginBottom: '8px' } }),
                    h('div', { className: 'dshpz-skel', style: { width: '68%', height: '34px' } }))
                  : rows.length === 0
                    ? h('div', { className: 'dshpz-empty' },
                      h('span', { className: 'dshpz-emptyicon' }, icon('grid', 24)),
                      h('div', { className: 'dshpz-emptytitle' }, '还没有拼图项目'),
                      h('div', { className: 'dshpz-muted' }, '点右上角「＋ 新建项目」建一个。'))
                    : h('div', { className: 'dshpz-projects', ref: listRef }, rows.map(function (item) {
                      var isOpen = item.name === openName
                      return h(
                        'button',
                        {
                          key: item.name,
                          className: 'dshpz-projectrow',
                          'data-key': item.name,
                          'data-on': isOpen ? '1' : '0',
                          title: '进入「' + item.name + '」：' + (item.mode || '?') + ' · 健康性 ' + (item.health || 0) + '%',
                          onClick: function () { openProject(item.name) },
                        },
                        h('span', { className: 'dshpz-projectname' }, item.name, isOpen ? h('span', { className: 'dshpz-nowbadge' }, '当前') : null),
                        h('span', { className: 'dshpz-projectmeta' },
                          '健康性 ' + (item.health || 0) + '%',
                          h('span', { className: 'dshpz-dot' }, '·'),
                          (item.builtModuleCount === undefined ? (item.moduleCount || 0) : item.builtModuleCount) + '/' + (item.moduleCount || 0) + ' 模块',
                          h('span', { className: 'dshpz-dot' }, '·'),
                          String(item.updated || '')),
                        h('span', { className: 'dshpz-projectgo' }, '›'),
                      )
                    })),
            ),
            newBlock,
            /**
             * **派单设置**（U4-4）：三处模型 + 代码工作区，都在一级面板。
             *
             * 为什么在一级而不是每张卡 / 二级：这三处是**派单系统的全局行为**，
             * 与「哪个项目」无关；一处管完，换项目时不用逐卡重配。
             */
            dispatchSettingsBlock(view),
          ),
        ),
      )
    }

    /**
     * 工作区选择器：列出宿主的工作区，点一个就绑过去。
     *
     * ## v2.1.1：把**当前会话所在的工作区**置顶并标注
     *
     * 用户反馈「工作区绑定用会话工作区选择」。原先是一个平铺列表，用户得自己
     * 从路径里认出「我现在的会话在哪个工作区」——而他自己就是在那开的会话，
     * 这件事插件完全算得出来（`useWorkspaces` 快照的 `sessionIds` 里有当前会话 id）。
     *
     * 所以判据是**会话 id 属于哪个工作区**，而不是路径字符串比对：
     * 路径会被改名、同一个路径可能注册成两个工作区，而会话 id 是精确的。
     * 置顶之后它就在第一行，一眼可见、一点就绑。
     *
     * ⚠️ **不自动绑定**：绑定是写盘动作（改了「文档写到哪」这个根），
     * 自动绑会在用户没看的情况下把文档根挪走。只置顶 + 标注。
     *
     * 数据源是 `useWorkspaces` 快照（宿主标准 prop）。拿不到时就退回一个手填路径的输入框——
     * **降级而不是没有**：绑定工作区是 v2.0.0 的根，缺了它整个面板都用不了。
     */
    function workspacePicker(view) {
      var list = workspacesOf()
      if (list === null) {
        return h(
          'div',
          { className: 'dshpz-acts', style: { marginTop: '6px' } },
          h('input', {
            className: 'dshpz-in',
            style: { marginBottom: '0' },
            placeholder: '工作区绝对路径',
            value: view.state.wsPath || '',
            onChange: function (event) { setState({ wsPath: event.target.value }) },
          }),
          h('button', { className: 'dshpz-act', onClick: function () { bindWorkspace(view.state.wsPath || '') } }, '绑定'),
        )
      }
      if (list.length === 0) {
        return h('div', { className: 'dshpz-muted', style: { marginTop: '6px' } }, '宿主还没有注册任何工作区。')
      }
      var sessionId = typeof view.state.sessionId === 'string' ? view.state.sessionId : ''
      /** 当前会话在哪个工作区里（找不到就是 `''`，那时不置顶也不标注）。 */
      var currentOf = ''
      if (sessionId !== '') {
        for (var s = 0; s < list.length; s += 1) {
          if (list[s].sessionIds.indexOf(sessionId) >= 0) {
            currentOf = list[s].path
            break
          }
        }
      }
      /**
       * 排序：当前会话那个排第一，其余保持宿主给的顺序。
       *
       * 为什么不整体排序（比如按会话数）：宿主的顺序是**用户自己建工作区的顺序**，
       * 那是他记得住的次序。只把「当前这个」提上来，其余不动。
       */
      var rows = list.slice()
      if (currentOf !== '') {
        rows = list.filter(function (item) { return item.path === currentOf })
          .concat(list.filter(function (item) { return item.path !== currentOf }))
      }
      /**
       * ## 折叠态（默认）：只有一颗「更换」按钮
       *
       * 上面那行 `.dshpz-docpath` 已经写着当前绑的路径了，所以这里**不再重复路径**
       * ——折叠的意义就是省地方，把同一句话写两遍等于没省。
       * 展开态才是那串可选的工作区。
       */
      var ws = view.state.workspace
      var open = view.state.wsOpen === true
      var head = h(
        'div',
        { className: 'dshpz-wshead' },
        h(
          'button',
          {
            className: 'dshpz-act',
            'data-on': open ? '1' : '0',
            style: { width: '100%', justifyContent: 'center' },
            title: open ? '收起工作区列表' : '展开宿主的工作区列表，点一个就绑过去',
            onClick: function () { setState({ wsOpen: !open }) },
          },
          h('span', null, open ? '收起 ▲' : '更换工作区（' + list.length + ' 个）▼'),
        ),
      )

      if (!open) return h('div', { className: 'dshpz-wsblock' }, head)

      return h(
        'div',
        { className: 'dshpz-wsblock' },
        head,
        h(
          'div',
          { className: 'dshpz-wslist' },
          rows.map(function (item) {
            var isBound = ws !== null && ws !== undefined && ws.workspacePath === item.path
            var isCurrent = currentOf !== '' && item.path === currentOf
            /**
             * 「绑非空工作区要提醒」的判据：**该工作区有没有会话**。
             * `sessionIds.length === 0` 表示 AI 根本不会在里面干活，那是最理想的存放处。
             */
            var busy = Array.isArray(item.sessionIds) && item.sessionIds.length > 0
            return h(
              'button',
              {
                key: item.path,
                className: 'dshpz-wsrow',
                'data-on': isBound ? '1' : '0',
                'data-current': isCurrent ? '1' : '0',
                title: isCurrent
                  ? '当前这个会话就在这个工作区里（置顶只是方便你选中，插件不会自动绑）'
                  : (busy
                    ? '这个工作区里已经有 ' + item.sessionIds.length + ' 个会话：AI 在里面干活时，可能把拼图文档与任务单误读成项目内容'
                    : '这个工作区还没有会话，是存放拼图数据的好地方'),
                /**
                 * 选中之后就**收起**：这个控件的目的是「换一个并绑上」，
                 * 点完还敞着列表会让用户以为没生效，也白占一屏。
                 */
                onClick: function () {
                  bindWorkspace(item.path, item.id)
                  setState({ wsOpen: false })
                },
              },
              h('span', { className: 'dshpz-wsname' }, item.label || item.path),
              isCurrent ? h('span', { className: 'dshpz-wscur' }, '当前会话') : null,
              busy
                ? h('span', { className: 'dshpz-wswarn' }, '⚠ ' + item.sessionIds.length + ' 个会话')
                : h('span', { className: 'dshpz-wsok' }, '干净'),
            )
          }),
          h('div', { className: 'dshpz-hint' },
            currentOf === ''
              ? '推荐给拼图数据一个**干净的工作区**（没有会话的）。绑非空工作区也可以，但 AI 可能把「拼图/」与任务单误读成项目内容。'
              : '排在第一行的是**当前会话所在的工作区**。推荐给拼图数据一个干净的工作区（没有会话的）；绑非空工作区也可以，但 AI 可能把「拼图/」与任务单误读成项目内容。'),
        ),
      )
    }

    /**
     * 派单设置区（U4-4 + U3 执行工作区）。
     *
     * 两个控件组：
     *   1. **执行工作区**：默认 = 拼图项目文件夹（`<数据工作区>/<项目名>`，v2.4.2），
     *      想覆盖时才填全局根 / 单项目覆盖；
     *   2. **四个模型**：创建任务卡 / 全局大脑 / 澄清器 / 执行会话各自可选，缺省 = 跟随全局默认。
     *
     * ⚠️ 写入必须走 `patchSettings`（宿主侧的唯一写路径），它会带上没碰的字段——
     * 这个设置文件是共享的，只写 `dispatchModels` 会把工作区绑定整个抹掉。
     */
    function dispatchSettingsBlock(view) {
      var ws = view.state.workspace
      var code = ws !== null && ws !== undefined && ws.codeWorkspace ? ws.codeWorkspace : null
      var models = ws !== null && ws !== undefined && ws.dispatchModels ? ws.dispatchModels : null
      var open = view.state.dispatchOpen === true
      var catalog = view.state.modelCatalog
      var catalogOk = catalog !== null && catalog !== undefined && catalog.ok === true
      /**
       * **实际生效的执行工作区**（宿主回 `effectiveCodeRoot` + `...Source`）。
       *
       * 显示它而不是只显示输入框：默认档下 `globalPath` 是空的，而实际路径是
       * `<数据工作区>/<项目名>`。只画一个空输入框，用户会以为「没配＝不能用」——
       * 而它**不配就能用**，这正是 v2.4.2 要传达的。
       */
      var effective = ws !== null && ws !== undefined && typeof ws.effectiveCodeRoot === 'string' ? ws.effectiveCodeRoot : ''
      var source = ws !== null && ws !== undefined ? String(ws.effectiveCodeRootSource || '') : ''
      var sourceText = source === 'perProject'
        ? '你为这个项目单独指定了目录'
        : source === 'global'
          ? '按你填的全局根 + 项目名推导'
          : source === 'projectFolder'
            ? '默认：拼图项目文件夹（不配就是这样）'
            : '拼不出来——先绑数据工作区，并打开一个项目'
      return h(
        'div',
        { className: 'dshpz-sect' },
        h(
          'div',
          { className: 'dshpz-secttitle' },
          '派单设置',
          h(
            'button',
            {
              className: 'dshpz-act',
              style: { marginLeft: 'auto' },
              'data-on': open ? '1' : '0',
              onClick: function () {
                setState({ dispatchOpen: !open })
                // 展开时才拉模型目录：它是三个下拉的数据源，而**折叠状态下没人看它**。
                if (!open) loadModelCatalog()
              },
            },
            open ? '收起' : '展开',
          ),
        ),
        !open
          ? h('div', { className: 'dshpz-muted' }, '执行工作区（默认就是项目文件夹）与四个模型（分解 / 大脑 / 澄清器 / 执行会话）在这里配。')
          : h(
            'div',
            null,
            h('div', { className: 'dshpz-secttitle', style: { marginTop: '4px' } }, '执行工作区'),
            h('div', { className: 'dshpz-muted', style: { lineHeight: '1.55' } },
              '派单出去的 AI 在哪个目录里改代码。**默认就是拼图项目文件夹**（' + '<数据工作区>/<项目名>' + '），不配也能用；'
              + '要指到别处才填下面的全局根（每个项目的目录 = 根 + 项目名）。'),
            h('div', { className: 'dshpz-docpath' }, effective !== '' ? effective : '（还没有可用的项目）'),
            h('div', { className: 'dshpz-muted', style: { marginTop: '3px' } }, sourceText),
            h('input', {
              className: 'dshpz-in',
              style: { marginTop: '6px' },
              placeholder: '（可留空）全局执行工作区根路径，留空 = 用项目文件夹',
              value: view.state.codeRoot !== undefined ? view.state.codeRoot : (code !== null && code !== undefined ? (code.globalPath || '') : ''),
              onChange: function (event) { setState({ codeRoot: event.target.value }) },
            }),
            h(
              'div',
              { className: 'dshpz-acts' },
              h('button', {
                className: 'dshpz-act',
                title: '填了根就按「根 + 项目名」推导每个项目的目录；留空保存 = 回到默认（项目文件夹）',
                onClick: function () { writeDispatch(view, { codeWorkspace: { mode: 'global', globalPath: String(view.state.codeRoot || '') } }) },
              }, '保存'),
              code !== null && code !== undefined && (code.globalPath || '') !== ''
                ? h('button', {
                  className: 'dshpz-act',
                  title: '清掉全局根，回到默认的「拼图项目文件夹」',
                  onClick: function () { setState({ codeRoot: '' }); writeDispatch(view, { codeWorkspace: { mode: 'global', globalPath: '' } }) },
                }, '恢复默认')
                : null,
            ),
            code !== null && code !== undefined && Object.keys(code.perProject || {}).length > 0
              ? h('div', { className: 'dshpz-muted', style: { marginTop: '5px' } },
                '单项目覆盖：' + Object.keys(code.perProject).map(function (name) {
                  return name + ' → ' + code.perProject[name]
                }).join('；'))
              : null,
            h('div', { className: 'dshpz-secttitle', style: { marginTop: '10px' } }, '四个模型'),
            h('div', { className: 'dshpz-muted', style: { lineHeight: '1.55' } },
              '四处各自可选，互不牵连。**缺省 = 跟随全局默认模型**；这里改**不会**动你的全局默认（走 installModelSelection，不是 session/selectModel）。',
              catalogOk && modelCountOf(catalog) === 0
                ? '⚠️ 宿主报告「当前没有任何可路由的模型」——先去设置里配一个 provider。'
                : ''),
            dispatchModelRow(view, models, 'decompose', '创建任务卡（一键分解）'),
            dispatchModelRow(view, models, 'brain', '全局大脑'),
            dispatchModelRow(view, models, 'clarifier', '澄清器'),
            dispatchModelRow(view, models, 'executor', '执行会话'),
          ),
      )
    }

    /**
     * 一行模型选择器（v2.1.1：**改成下拉**，数据来自宿主模型目录）。
     *
     * ## 用户要的是什么
     *
     * 「插件三个模型设置加选择设置中已经设置的模型」——原来只有两个文本框，
     * 用户得自己记住「provider/model」怎么写，写错一个字母就是一个选了会报错的
     * 配置（而且报错发生在真派单那一刻，离这里很远）。
     *
     * ## 为什么是「下拉 + 手填」而不是「纯下拉」
     *
     * 宿主目录里列的是**它认为可路由**的模型。用户拍板保留手填这一路：
     * 目录少列了某个自定义模型时，纯下拉等于把那个模型彻底锁死。
     *
     * ## 读不到目录时：**报错并禁用保存**（用户拍板，不是静默退回文本框）
     *
     * 静默退回文本框会让人以为「这台部署就是这样的」，而事实是宿主接口没读到——
     * 那件事用户能查（去看 profile 的 provider 配置）。所以这里：
     *   - `<select>` 换成一句红字说明；
     *   - 「保存」按钮 `disabled`，点了也不写——写进去的是一个无法核对的字符串。
     */
    function dispatchModelRow(view, models, slot, label) {
      var current = models !== null && models !== undefined ? models[slot] : null
      var key = 'model_' + slot
      var text = view.state[key] !== undefined
        ? view.state[key]
        : (current === null || current === undefined ? '' : (current.provider + '/' + current.model))
      var catalog = view.state.modelCatalog
      var catalogOk = catalog !== null && catalog !== undefined && catalog.ok === true
      var catalogError = catalog !== null && catalog !== undefined && catalog.error !== undefined ? String(catalog.error) : ''
      var groups = catalogOk && Array.isArray(catalog.groups) ? catalog.groups : []
      var defaultSelection = catalogOk && catalog.default !== null && catalog.default !== undefined ? catalog.default : null
      var defaultValue = defaultSelection === null ? '' : (defaultSelection.provider + '/' + defaultSelection.model)

      /** 目录里的每一项：`provider/model` 为值，`组名 · 模型名` 为文案。 */
      var options = []
      for (var g = 0; g < groups.length; g += 1) {
        for (var m = 0; m < groups[g].models.length; m += 1) {
          var one = groups[g].models[m]
          options.push({
            value: groups[g].id + '/' + one.id,
            label: groups[g].name + ' · ' + one.name,
          })
        }
      }
      // 当前值不在目录里时（目录读到了但少了这个模型、或是早先手填的）**补一项**：
      // 不补的话 `<select>` 会自己跳到第一项，用户一进来就看到一个他没选过的模型。
      if (text !== '' && !options.some(function (item) { return item.value === text })) {
        options.unshift({ value: text, label: text + '（不在目录里）' })
      }

      var picker = catalogOk
        ? h('select', {
          className: 'dshpz-sel',
          style: { flex: '1 1 180px' },
          value: text,
          title: '选项来自宿主设置里已配置、且当前可路由的模型',
          onChange: function (event) {
            var patch = {}
            patch[key] = event.target.value
            setState(patch)
          },
        }, [h('option', { key: '__default', value: '' },
          defaultValue === '' ? '跟随全局默认模型' : ('跟随全局默认（' + defaultValue + '）'))]
          .concat(options.map(function (item) {
            return h('option', { key: item.value, value: item.value }, item.label)
          })))
        : h('span', { className: 'dshpz-err', style: { flex: '1 1 220px', margin: '0' } },
          icon('alert', 13),
          h('span', null, '读不到模型目录，无法选择：' + (catalogError || '还没拉过')))

      return h(
        'div',
        { className: 'dshpz-acts', style: { marginTop: '6px' } },
        h('span', { className: 'dshpz-modelname' }, label),
        picker,
        catalogOk
          ? h('button', {
            className: 'dshpz-act',
            title: '把这一处钉到上面选的那个模型',
            onClick: function () {
              var raw = String(view.state[key] !== undefined ? view.state[key] : '').trim()
              if (raw === '') {
                writeDispatch(view, { dispatchModels: { [slot]: null } })
                return
              }
              var at = raw.indexOf('/')
              if (at <= 0 || at >= raw.length - 1) {
                setState({ error: '模型要写成 provider/model 的形式（例如 deepseek/deepseek-chat）' })
                return
              }
              writeDispatch(view, { dispatchModels: { [slot]: { provider: raw.slice(0, at), model: raw.slice(at + 1) } } })
            },
          }, '保存')
          : h('button', {
            className: 'dshpz-act',
            disabled: true,
            title: '读不到宿主模型目录时不写——写进去的是一个无法核对的字符串',
          }, '保存'),
        current !== null && current !== undefined
          ? h('button', {
            className: 'dshpz-act',
            title: '清掉这一处的选择，恢复成「跟随全局默认模型」',
            onClick: function () { writeDispatch(view, { dispatchModels: { [slot]: null } }) },
          }, '跟随默认')
          : null,
      )
    }

    /** 写派单设置（代码工作区 / 三个模型）。宿主回整份设置，面板据此重画。 */
    function writeDispatch(view, patch) {
      var body = { method: 'dispatch' }
      if (patch.codeWorkspace !== undefined) body.codeWorkspace = patch.codeWorkspace
      if (patch.dispatchModels !== undefined) body.dispatchModels = patch.dispatchModels
      post(body)
        .then(function (json) {
          if (json && json.ok === true) {
            setState({
              workspace: Object.assign({}, state.workspace, json.result),
              error: null,
              notice: '派单设置已保存。',
            })
          } else {
            setState({ error: (json && json.error) || '派单设置写入失败' })
          }
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC })
        })
    }

    /**
     * 读宿主的工作区快照（`useWorkspaces` 标准 prop，由 `Panel` 存进 `wsSnapshot`）。
     *
     * 返回 `null` 表示**拿不到这个 prop**（与「拿到了但是空数组」是两件事）：
     * 前者要退回手填路径的输入框，后者要显示「宿主还没注册任何工作区」。
     * 把两者混成一个空数组，会让用户在一个没有工作区的部署上看到一个永远填不对的输入框。
     *
     * ## 快照的真实形状（v2.1.1 修的真 bug）
     *
     * 宿主 `ClientWorkspaceModel.buildSnapshot()` 返回的是：
     *   `{ items: [{ workspaceId, path, title, sessionIds, createdAt, updatedAt }],
     *      archivedSessionIds, pinnedSessionIds, state, phase, error }`
     *
     * ⚠️ 原先这里读的是 `snap.byId` —— **那个字段根本不存在**（`byId` 是 `useSessions`
     * 的形状）。于是 `rows === null` → 返回 `[]` → 选择器永远显示
     * 「宿主还没有注册任何工作区」，用户看到的就是「没有选绑的地方」。
     * 真机实测：一级页只剩手填路径的降级输入框，或者一句「还没注册任何工作区」。
     */
    function workspacesOf() {
      var snap = wsSnapshot
      if (snap === null || snap === undefined) return null
      var rows = Array.isArray(snap.items) ? snap.items : null
      if (rows === null) return []
      return rows.map(function (item) {
        return {
          id: String(item.workspaceId || ''),
          path: String(item.path || ''),
          label: String(item.title || item.path || ''),
          sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds : [],
        }
      }).filter(function (item) { return item.path !== '' })
    }

    /** 目录里一共有几个模型（用来区分「读不到」与「读到了但是空的」）。 */
    function modelCountOf(catalog) {
      var groups = catalog !== null && catalog !== undefined && Array.isArray(catalog.groups) ? catalog.groups : []
      var total = 0
      for (var i = 0; i < groups.length; i += 1) total += Array.isArray(groups[i].models) ? groups[i].models.length : 0
      return total
    }

    /**
     * 拉宿主模型目录（v2.1.1，一级页三个模型下拉的数据源）。
     *
     * 失败时把 `{ok:false, error}` 存进 `state.modelCatalog`——**不吞掉**：
     * 三个下拉要靠它决定「显示选项」还是「显示『读不到目录』并禁用保存」。
     */
    function loadModelCatalog() {
      post({ method: 'models' })
        .then(function (json) {
          if (json && json.ok === true) setState({ modelCatalog: json.result })
          else setState({ modelCatalog: { ok: false, error: (json && json.error) || '读模型目录失败' } })
        })
        .catch(function () {
          setState({ modelCatalog: { ok: false, error: '无法连接 ' + RPC } })
        })
    }

    /* --------------------------- 兼容：旧的输入框按钮 --------------------------- */

    /**
     * **已停用**：v1.x 挂在 `conversation.input.left` 的那个小按钮。
     *
     * 为什么保留这个组件而不删：它是 `loadActiveTheme` / `applyUserTheme` 两条
     * 「主题常驻」职责的**原始落点**，而那两条职责现在搬到了 `SidebarButton` 上。
     * 留一个**不注册**的副本会让「这两条职责搬到哪去了」在 diff 里断掉——
     * 而它们恰恰是最容易被漏掉的一类改动（不打开面板就不换色，肉眼很难发现）。
     *
     * 判据：`apply()` 里**不再注册任何 `conversation.input.left`**（U1 拍板①）。
     * 这条由 `test/20-client.test.mjs` 的注册契约断言钉住。
     */
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
          'data-on': view.state.open === true || view.state.themeOpen === true || view.state.updateOpen === true ? '1' : '0',
          title: '拼图模式：项目健康性、模块与文档',
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
     * 把一段**现成文本**写进输入框，返回是否成功。
     *
     * 收的是一段已经拼好的文本（宿主给的开发提示词），原样填进去。
     * 面板上**没有**别的填模板入口了：v2.1.1 删掉「交给 AI 的动作」那一块之后，
     * 这里成了唯一一处，所以不再有「与谁分工」的问题。
     *
     * 失败返回 `false` 而不是抛错：调用方要把失败写进提示语（「提示词没填进去」），
     * 让用户知道要手动复制——静默失败会让他以为提示词已经在了。
     */
    function fillPrompt(text) {
      var value = typeof text === 'string' ? text : ''
      if (value === '') return false
      var actions = state.inputActions
      if (actions === undefined || actions === null || typeof actions.setDraft !== 'function') return false
      try {
        actions.setDraft(value)
        return true
      } catch (_error) {
        return false
      }
    }

    /**
     * 插件的 ctx（在 `apply` 里赋值）。见 `apply` 里那段说明。
     *
     * `null` 表示还没挂载——所有读它的地方都必须能容忍这个值。
     */
    var panelCtx = null

    /**
     * 宿主的工作区快照（`useWorkspaces` 标准 prop 的返回值）。
     *
     * 为什么存模块级：`workspacesOf()` 被渲染树深处的按钮（工作区选择器）调用，
     * 一路透传要改十几个签名；面板是**进程级单例**，所以这样存是安全的。
     * `null` = 还没拿到这个 prop（`workspacesOf` 据此退回手填路径）。
     */
    var wsSnapshot = null

    /* --------------------------------- 插件 --------------------------------- */

    function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return
      /**
       * 把 ctx 存起来供 `closePanel` / `openPanel` / `workspacesOf` 用。
       *
       * 为什么存模块级变量而不是一路传参：这三个函数被**渲染树深处**的按钮调用
       * （Esc 处理、列表行点击、工作区选择器），把 ctx 一路透传下去要改十几个签名，
       * 而它是个**进程级单例**——面板只可能有一个。代价是它必须在 `apply` 里赋值，
       * 所以所有读它的地方都做了「拿不到就降级」的处理（见各自注释）。
       */
      panelCtx = ctx

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

      /**
       * ## v2.0.0（U1）：入口从「输入框小按钮 + 浮层」改成「侧边栏按钮 + 主区面板」
       *
       * 宿主槽位事实（已实读 Inspect + 宿主源码）：
       *   - `sidebar.panellist` 是 **list** 槽位，root 作用域，注册字段 `{ id, order?, label? }`；
       *     每个 id **寻址 `main` keyed 槽里同名的那块面板**；
       *   - `main` 是 **keyed** 槽位，注册字段 `{ key }`，已占 `conversation` / `plugins`；
       *   - **按钮与主区必须成对注册**：选一个不存在的主面板条目会**抛错**并保留当前选中态。
       *
       * ⚠️ **必须用新 id `puzzle`**：复用已占的 `plugins` 会**替换**该格，
       * 把宿主的「插件」按钮整个顶掉。
       *
       * ⚠️ **本次改动不新增任何每步 prompt 注入**——常驻的是 UI，不是提示词。
       */
      slots.inject('sidebar.panellist', function () {
        return slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: SIDEBAR_ORDER, label: '拼图' },
          SidebarButton,
        )
      })

      /**
       * ## v2.1.3：`children` 里多声明一个 `puzzle.build.chat`
       *
       * 面板内浮窗要渲染**那个新建会话的对话流**，而宿主的 `SessionProvider`
       * 只在「本 entry 声明了非 root 作用域的子槽位」时才发（见 ui-renderer 的
       * `standardKit`）。所以这个声明不是装饰：少了它，浮窗里
       * `props.SessionProvider` 与 `props.renderSlot` 都是 `undefined`，
       * 症状是浮窗一片空白且不报错。
       *
       * 声明成 `session`（不是 `session-maybe`）：浮窗只在**已经有会话**时才出现，
       * 没有「还没有会话」那个中间态。
       */
      slots.inject('main', function () {
        // `key` 与侧边栏那个 id **同名**：侧边栏靠同名配对找到这块面板。
        return slots.register({
          name: 'main',
          key: PANEL_ID,
          children: { 'puzzle.build.chat': { kind: 'single', scope: 'session' } },
        }, Panel)
      })
    }

    module.exports = {
      name: 'dsh-puzzle-mode',
      apply: apply,
      resumeTemplate: resumeTemplate,
      refactorTemplate: refactorTemplate,
      createTemplate: createTemplate,
      interviewTemplate: interviewTemplate,
      adoptTemplate: adoptTemplate,
      sizeBlock: sizeBlock,
      newDocTemplate: newDocTemplate,
      bindTemplate: bindTemplate,
      createByForm: createByForm,
      // v2.1.2：另两条「建项目」的路（起会话让 AI 建）。导出是为了能离线驱动它、
      // 断言「提示词真的带上了表单里填的值」——不必真起一个会话。
      buildViaSession: buildViaSession,
      // v2.1.3：面板内浮窗。导出是为了能离线断言「起完会话挂的是浮窗、
      // 而且拿到了 SessionReference」——不必真起一个会话。
      openBuildFloat: openBuildFloat,
      closeBuildFloat: closeBuildFloat,
      // v2.2.0：三种浮窗共用这一条（新建项目 / 全局大脑 / 澄清器）。
      // 导出是为了能离线断言「呼出大脑后挂的是浮窗、而且拿到了 SessionReference」。
      openSessionFloat: openSessionFloat,
      // v2.2.0：派单页左上角那颗按钮的动作。导出是为了能离线断言
      // 「它走 method:'brain'、失败时把 hint 一起显示」。
      openBrain: openBrain,
      // v2.2.0：大脑入口那一条（按钮 + 说明）。导出便于离线冒烟。
      brainBar: brainBar,
      // v2.1.6：浮窗上的 ✕ 改成删会话。导出是为了能离线断言
      // 「它真的调了 uiWorkspace.archiveSession 且带 stopActivity」。
      deleteBuildSession: deleteBuildSession,
      boundNamesOf: boundNamesOf,
      scanCandidates: scanCandidates,
      createMany: createMany,
      loadMain: loadMain,
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
      // ⚠️ v2.0.0 起**不再导出 `unbind`**：绑定整体退场，函数已删。
      // 导出名单是一条**契约**（测试按它核对「哪些能力还在」），
      // 留一个指向已删函数的键会在 factory 求值那一刻直接 `ReferenceError`，
      // 整块面板连加载都过不去——比功能缺失严重得多。
      rebuildNow: rebuildNow,
      entryCards: entryCards,
      // v2.1.8：条目小节默认折叠。导出是为了能离线断言
      // 「默认是折叠的」以及「点一下只开合那一组」。
      entrySection: entrySection,
      toggleEntrySection: toggleEntrySection,
      // 开合规则的纯函数：测试直接驱动它，避免「手写期望 state 再喂进去」的自证。
      nextEntryOpen: nextEntryOpen,
      // v2.0.0 新增：一级项目列表页与派单看板（面板级组件，便于离线冒烟）。
      projectsPage: projectsPage,
      dispatchBoard: dispatchBoard,
      newTaskFloat: newTaskFloat,
      // v2.1.0：派单/澄清两个动作**导出**，让离线冒烟能直接驱动它们
      // （断言「失败时把 hint 一起显示」这类行为，不必真起会话）。
      clarifyCard: clarifyCard,
      freezeCard: freezeCard,
      dispatchCard: dispatchCard,
      /**
       * v2.3.x（需求 ①③）：
       *   - `deleteCard`：删除已做的卡（含它的两个会话）。导出是为了能离线断言
       *     「它先弹二次确认、确认后才发 `action:'delete'`，且失败时原样显示宿主那句错话」。
       *   - `columnChangeOf`：列变化的**纯函数**判据。它是「③ 只在真的换列时弹一次」
       *     这条规则的唯一落点，直接驱动它比手写一份 state 再喂进去更能自证
       *     （本仓对「自证式测试」有明确戒心）。
       */
      deleteCard: deleteCard,
      columnChangeOf: columnChangeOf,
      /**
       * v2.3.x（需求 ②④）：两处「它在干活吗」的渲染。导出是为了能**直接驱动**它们，
       * 断言「running 时才有转圈圈、拿不到状态时如实说读不到」——而不必真的起一个会话。
       */
      cardRunLine: cardRunLine,
      brainRunBadge: brainRunBadge,
      SidebarButton: SidebarButton,
      PANEL_ID: PANEL_ID,
      SIDEBAR_ORDER: SIDEBAR_ORDER,
      // U5 的 JS 动效判据：`motionOn()` 是「JS 动画要不要做过渡」的唯一入口，
      // 导出它才能在没有真实浏览器的情况下断言「减少动效时直接落位」。
      motionOn: motionOn,
      /**
       * v2.4.17：数字爬升的插值。
       *
       * 导出是为了能**直接驱动**它，断言「每个中间值都在真实区间内、单调、
       * 整数、端点准确」——这些是「读数不能中途说谎」这条底线的唯一可测形式。
       * 不导出的话只能去 mock 一个 rAF 时钟再读 DOM 文本，那既慢又脆。
       */
      countUpValue: countUpValue,
      /**
       * v2.4.19：安装记录的新鲜度判据。
       *
       * 导出是为了能**直接驱动**它断言：
       *   - 8 天前的记录不算当前（真机上就是这条在冒充「刚刚失败」）；
       *   - 缺失 / 坏值 / 未来时间**算新鲜**（保守方向：宁可不藏掉一次真实失败）。
       * 不导出就只能去 mock `Date.now` 再渲染整页，那既慢又脆。
       */
      runIsCurrent: runIsCurrent,
      staleRunNotice: staleRunNotice,
      /**
       * v2.4.17：跨列飞行与列落定。
       *
       * 导出是为了能离线断言「量不到起点时返回 false（不编假动画）」、
       * 「位移太小时不播」——这两条都只有真驱动才看得见。
       */
      travelCard: travelCard,
      landColumn: landColumn,
      /**
       * v2.4.5（用户拍板「真抓在手上」+「微摇动」）：
       * 手上那张卡的四个动作。导出是为了能**真驱动**它们，断言：
       *   - `ghostGrab` 造出来的节点尺寸/外观照搬原卡，且抓取点按光标位置算
       *     （不是贴左上角——那会让卡在按下瞬间跳一下）；
       *   - `ghostMove` 按「光标 − 抓取点」定位；
       *   - `ghostDrop` 把节点从 DOM 摘掉，且**幂等**（`onDragEnd` 会兜底再调一次）；
       *   - `ghostBack` 的终点是**出发坐标**而不是 `translate(0,0)`
       *     （后者是视口左上角，卡会飞到一个跟它无关的地方）。
       */
      ghostGrab: ghostGrab,
      ghostMove: ghostMove,
      ghostDrop: ghostDrop,
      ghostBack: ghostBack,
      /**
       * v2.4.14：停掉执行会话（用户报的「执行会话人为停止不了」）。
       * 导出是为了能离线断言「它真的发 `method:'task', action:'stop', id:<卡 id>`，
       * 且失败时把宿主那句错话原样显示」——与 `freezeCard` / `deleteCard` 同一条纪律。
       */
      stopCardSession: stopCardSession,
      /** 测试要读「现在手上有没有卡」，所以给一个只读探针。 */
      ghostOf: function () { return ghostNode },
    }
    return module.exports
  },
})
