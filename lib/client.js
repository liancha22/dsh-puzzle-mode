/**
 * dsh-puzzle-mode —— 浏览器半。
 *
 * 两个 Slot，共用一个模块级 store：
 *   1) conversation.input.left  —— 模型选择器左边的小按钮（拼图图标 + 健康性角标）
 *   2) shell.overlay           —— 点按钮弹出的拼图面板
 *
 * 面板里有四件事：
 *   - 项目路径 / 项目健康性进度条 / 五维块 / 模块图块；
 *   - **图块可点开**：读该模块文档的要点、相关决策、详细记录（宿主 `method:'module'`）；
 *   - **提问模板**：一键把「带固定收尾问」的提问填进输入框（`inputActions.setDraft`），
 *     不自动发送——把「每次提问必带固定收尾问」从"靠模型自觉"变成"UI 直接给模板"；
 *   - 模式切换（只拼不写 / 边拼边写）与多项目切换。
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
     * 提问模板：正文里已经写死固定收尾问，用户只补具体问题。
     *
     * 第一行专门点「用 ask_user_question」：在正文里列 ① ② ③ 不算提问——
     * 用户看不到可点选项，只能在聊天里手打。这一条是用户当场纠正过的。
     */
    function questionTemplate(projectName) {
      return [
        '【' + (projectName || '拼图') + ' · 提问】',
        '用 ask_user_question 工具提问（不要只在正文里列选项）：',
        '1. ',
        '2. ',
        '3. ',
        '4. ',
        '5. ',
        '',
        PAUSE_QUESTION,
        '① ' + PAUSE_OPTIONS[0],
        '② ' + PAUSE_OPTIONS[1],
      ].join('\n')
    }

    /** 审查模板：先让模型拿 op:audit 的客观事实，再按五维点名点评。 */
    function auditTemplate(projectName) {
      return [
        '【' + (projectName || '拼图') + ' · 审查】',
        '先调 puzzle_mode 的 op:audit 拿客观事实，再按五维写审查：',
        '- 最弱的一维是哪一维、落在哪个模块、缺的是哪条证据（点名到数字）',
        '- 每条问题配一条可执行的下一步',
        '- 不要「整体不错、建议持续完善」这类空话',
        '',
        PAUSE_QUESTION,
        '① ' + PAUSE_OPTIONS[0],
        '② ' + PAUSE_OPTIONS[1],
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
        
        PAUSE_QUESTION,
        '① ' + PAUSE_OPTIONS[0],
        '② ' + PAUSE_OPTIONS[1],
      ].join('\n')
    }

    /** 采访后再建：先问 ≤5 问把目标与模块划分问清，再一次 op:init。 */
    function interviewTemplate(projectName) {
      return [
        '【' + (projectName || '拼图') + ' · 建项目（先采访）】',
        '先采访再建，不要提前调 op:init：',
        '- 一轮最多 5 问，能用选项就用选项，问的是真正卡住决定的点（目标、模块怎么划、边界在哪）',
        '- 拿到回答后用 op:init **一次同时创建主文档与每个模块一份文档**（显式给 project 与 modules）',
        '- 项目名会成为工作区里的文件夹名；目录固定为 <工作区>/<项目名>/拼图/',
        
        PAUSE_QUESTION,
        '① ' + PAUSE_OPTIONS[0],
        '② ' + PAUSE_OPTIONS[1],
      ].join('\n')
    }

    /** 绑定到已有项目：本会话只绑一个，绑过去之后别的项目上会自动解绑。 */
    function bindTemplate(projectName) {
      return [
        '【绑图 · 绑定项目】',
        '把本会话绑定到项目「' + (projectName || '<项目名>') + '」：',
        '- 调 puzzle_mode 的 op:bind 并给 project（项目已存在，不要用 op:init 重建）',
        '- 绑定后先 op:read 确认 projectSource 变成 bound，再把本轮结论写进该项目的文档',
        
        PAUSE_QUESTION,
        '① ' + PAUSE_OPTIONS[0],
        '② ' + PAUSE_OPTIONS[1],
      ].join('\n')
    }

    /* ------------------------------- 共享 store ------------------------------- */

    var state = {
      open: false,
      data: null,
      projects: null,
      detail: null,
      detailName: null,
      loading: false,
      error: null,
      sessionId: undefined,
      /**
       * 输入框动作，来自按钮那一侧。
       *
       * `shell.overlay` 的标准 props **不含 `inputActions`**（只有 `conversation.*`
       * 作用域的 Slot 才有），所以面板拿不到它——必须由 `conversation.input.left` 里的
       * 按钮把 props.inputActions 存进这个共享 store，面板才能填提问模板。
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
      formGoal: "",
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
          if (json && json.ok === true) setState({ data: json.result, error: null, loading: false })
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
     * 表单直建：把项目名 / 模块名 / 目标填好，直接调 RPC `create` —— **不经过模型**。
     *
     * 与两个模板按钮的分工：模板按钮是「让 AI 来建」（会问、会拆模块），
     * 这里是「我自己填好了，立刻建」（机械动作，不该占一轮对话）。
     * 模块名按逗号/顿号/空格切，空名与重复名交给宿主 `slugify` 去重。
     */
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
            setState({ error: null, loading: false, formProject: '', formModules: '', formGoal: '' })
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
      setState({ loading: true, rebuild: null })
      post({ method: 'rebuild', sessionId: String(sessionId), project: String(data.project), apply: apply === true })
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

    /** 重建预览：逐文件列出将要改什么，并给「落盘」按钮。 */
    function rebuildBlock(view) {
      var r = view.state.rebuild
      if (r === null || r === undefined) return null
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
          if (json && json.ok === true) setState({ error: null, loading: false, detail: null, detailName: null })
          else setState({ error: (json && json.error) || '解绑失败', loading: false })
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
    function bindTo(view, project) {
      var sessionId = view.state.sessionId
      if (sessionId === undefined || sessionId === null || project === undefined || project === null || project === "") {
        setState({ error: '要绑定需要会话 ID 与项目名' })
        return
      }
      setState({ loading: true })
      post({ method: 'bind', sessionId: String(sessionId), project: String(project) })
        .then(function (json) {
          if (json && json.ok === true) setState({ error: null, loading: false, detail: null, detailName: null })
          else setState({ error: (json && json.error) || '绑定失败', loading: false })
          load(sessionId)
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
        })
    }

    function writeMode(sessionId, mode, project) {
      if (sessionId === undefined || sessionId === null) return
      setState({ loading: true })
      var body = { method: 'mode', sessionId: String(sessionId), mode: mode }
      if (project !== undefined && project !== null && project !== '') body.project = String(project)
      post(body)
        .then(function (json) {
          if (json && json.ok === true) setState({ data: json.result, error: null, loading: false })
          else setState({ error: (json && json.error) || '模式写入失败', loading: false })
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
        })
    }

    /* --------------------------------- 样式 --------------------------------- */

    var CSS = [
      '.dshpz-btn{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1}',
      '.dshpz-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}',
      '.dshpz-btn[data-on="1"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.dshpz-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.28);pointer-events:auto;display:flex;align-items:center;justify-content:center;padding:16px;z-index:40}',
      '.dshpz-panel{width:min(680px,100%);max-height:min(80vh,760px);overflow:auto;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:14px 16px 16px;box-shadow:0 12px 40px rgba(0,0,0,.35);font-size:13px}',
      '.dshpz-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dshpz-title{font-weight:600;font-size:14px;margin:0}',
      '.dshpz-muted{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dshpz-bar{height:6px;border-radius:99px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin:8px 0 12px}',
      '.dshpz-fill{height:100%;background:var(--dsw-alias-brand-primary)}',
      '.dshpz-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:8px}',
      '.dshpz-tile{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px;background:var(--dsw-alias-bg-layer-1);min-height:74px;display:flex;flex-direction:column;gap:5px;text-align:left;color:inherit;font:inherit;cursor:pointer}',
      '.dshpz-tile:hover{border-color:var(--dsw-alias-border-l2)}',
      '.dshpz-tile[data-on="1"]{border-color:var(--dsw-alias-brand-primary)}',
      '.dshpz-tile[data-empty="1"]{opacity:.45}',
      '.dshpz-tile[data-static="1"]{cursor:default}',
      '.dshpz-tile b{font-size:12px;font-weight:600;line-height:1.25;word-break:break-all}',
      '.dshpz-tilebar{height:4px;border-radius:99px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.dshpz-tillefill{height:100%;background:var(--dsw-alias-state-success-primary)}',
      '.dshpz-pct{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dshpz-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}',
      '.dshpz-seg button{background:transparent;border:0;color:var(--dsw-alias-label-secondary);padding:5px 10px;font-size:12px;cursor:pointer}',
      '.dshpz-seg button[data-on="1"]{background:var(--dsw-alias-brand-primary);color:#fff}',
      '.dshpz-close{margin-left:auto;background:transparent;border:0;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:16px;line-height:1}',
      '.dshpz-hint{margin-top:10px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dshpz-err{color:var(--dsw-alias-state-error-primary);font-size:12px}',
      '.dshpz-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px}',
      '.dshpz-act{background:transparent;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;color:var(--dsw-alias-label-secondary);padding:4px 9px;font-size:12px;cursor:pointer}',
      '.dshpz-act:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}',
      '.dshpz-detail{margin-top:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.dshpz-detail h4{margin:0 0 6px;font-size:13px}',
      '.dshpz-pre{white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--dsw-alias-label-secondary);margin:0 0 8px}',
      '.dshpz-in{display:block;width:100%;box-sizing:border-box;margin-bottom:5px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 7px;font-size:12px}',
      '.dshpz-sel{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:4px 6px;font-size:12px}',
      '.dshpz-sect{margin-top:10px}',
      '.dshpz-secttitle{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:5px}',
      '.dshpz-dims{display:flex;flex-direction:column;gap:4px}',
      '.dshpz-dim{display:flex;align-items:center;gap:7px;font-size:12px}',
      '.dshpz-dimname{width:76px;flex:0 0 auto;color:var(--dsw-alias-label-secondary)}',
      '.dshpz-dimbar{flex:1 1 auto;height:5px;border-radius:99px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.dshpz-dimfill{display:block;height:100%;background:var(--dsw-alias-brand-primary)}',
      '.dshpz-dimval{width:34px;flex:0 0 auto;text-align:right;color:var(--dsw-alias-label-secondary)}',
      '.dshpz-findings{display:flex;flex-direction:column;gap:6px}',
      '.dshpz-finding{display:flex;gap:7px;align-items:flex-start;border:1px solid var(--dsw-alias-border-l1);border-left-width:3px;border-radius:8px;padding:6px 8px;background:var(--dsw-alias-bg-layer-1)}',
      '.dshpz-finding[data-level="blocker"]{border-left-color:var(--dsw-alias-state-error-primary)}',
      '.dshpz-finding[data-level="warn"]{border-left-color:var(--dsw-alias-state-warn-primary)}',
      '.dshpz-finding[data-level="info"]{border-left-color:var(--dsw-alias-border-l2)}',
      '.dshpz-flevel{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dshpz-ffact{font-size:12px;line-height:1.4}',
      '.dshpz-ffix{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary);margin-top:2px}',
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
          h('div', { className: 'dshpz-tilfill', style: { width: piece.score + '%' } }),
        ),
        h('div', { className: 'dshpz-pct' }, empty ? '未建' : piece.score + '%'),
        detail.length > 0 ? h('div', { className: 'dshpz-pct' }, detail.join(' · ')) : null,
      )
    }

    /* ------------------------------- 模块详情 ------------------------------- */

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
        if (detail.points) parts.push(h('div', { key: 'p' }, h('div', { className: 'dshpz-muted' }, '要点'), h('div', { className: 'dshpz-pre' }, detail.points)))
        if (detail.related) parts.push(h('div', { key: 'r' }, h('div', { className: 'dshpz-muted' }, '相关决策'), h('div', { className: 'dshpz-pre' }, detail.related)))
        if (detail.detail) parts.push(h('div', { key: 'd' }, h('div', { className: 'dshpz-muted' }, '详细记录'), h('div', { className: 'dshpz-pre' }, detail.detail)))
        if (parts.length === 0) parts.push(h('div', { className: 'dshpz-muted', key: 'empty' }, '文档还是空的。'))
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
     * 另一半（一针见血的点评）由模型写——面板只提供入口（「审查」按钮填提问模板）。
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

    /* -------------------------------- 面板 -------------------------------- */

    function panelBody(view) {
      var data = view.state.data
      var header = h(
        'div',
        { className: 'dshpz-row' },
        h('h3', { className: 'dshpz-title' }, '拼图' + (data && data.initialized === true ? ' · ' + (data.project || '未命名') : '')),
        data && data.initialized === true ? h('span', { className: 'dshpz-muted' }, '健康性 ' + data.health + '%') : null,
        h(
          'button',
          {
            className: 'dshpz-close',
            title: '刷新',
            onClick: function () {
              load(view.state.sessionId, data && data.initialized === true ? data.project : undefined)
              loadProjects(view.state.sessionId)
            },
          },
          '⟳',
        ),
      )

      if (view.state.error !== null) {
        return h('div', null, header, h('div', { className: 'dshpz-err' }, String(view.state.error)))
      }
      if (data === null || data === undefined) return h('div', null, header, h('div', { className: 'dshpz-muted' }, '读取中…'))

      if (data.initialized !== true) {
        var existing = view.state.projects
        var existingList = existing !== null && existing !== undefined && Array.isArray(existing.projects) ? existing.projects : []
        return h(
          'div',
          null,
          header,
          h('div', { className: 'dshpz-muted' }, '本会话还没绑定拼图项目（新会话默认空，不会自动占用上一个会话的项目）。'),
          h('div', { className: 'dshpz-hint' }, '目录：' + (data.projectRoot || '?') + '/<项目名>/拼图/'),
          // 表单直建：自己填好立刻建，**不经过模型**（机械动作不占一轮对话）。
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
          h(
            'div',
            { className: 'dshpz-row', style: { marginTop: '8px' } },
            h('span', { className: 'dshpz-muted' }, '或交给 AI：'),
            h(
              'button',
              { className: 'dshpz-act', title: '不采访，让 AI 直接 op:init 建出文件夹与全部文档', onClick: function () { askAi(view, null, createTemplate) } },
              '快速建空壳',
            ),
            h(
              'button',
              { className: 'dshpz-act', title: '先让 AI 问 ≤5 问，再 op:init', onClick: function () { askAi(view, null, interviewTemplate) } },
              '采访后再建',
            ),
          ),
          existingList.length === 0
            ? null
            : h(
              'div',
              { className: 'dshpz-sect' },
              h('div', { className: 'dshpz-secttitle' }, '或绑定已有项目（' + existingList.length + '）'),
              h('div', { className: 'dshpz-findings' }, existingList.map(function (item) {
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
        )
      }

      var modes = ['只拼不写', '边拼边写']
      var projects = view.state.projects
      var projectList = projects !== null && projects !== undefined && Array.isArray(projects.projects) ? projects.projects : []
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
        null,
        header,
        h(
          'div',
          { className: 'dshpz-row' },
          projectList.length > 0
            ? h(
              'select',
              {
                className: 'dshpz-sel',
                value: data.project,
                onChange: function (event) {
                  // 一个会话只绑一个项目：这里切换就是**改绑**，不是临时看别的项目。
                  bindTo(view, event.target.value)
                },
              },
              projectList.map(function (item) {
                return h('option', { key: item.name, value: item.name }, item.name + ' · 健康性 ' + item.health + '%')
              }),
            )
            : null,
          h(
            'div',
            { className: 'dshpz-seg' },
            modes.map(function (mode) {
              return h(
                'button',
                {
                  key: mode,
                  'data-on': data.mode === mode ? '1' : '0',
                  onClick: function () {
                    writeMode(view.state.sessionId, mode, data.project)
                  },
                },
                mode,
              )
            }),
          ),
          h(
            'button',
            {
              className: 'dshpz-act',
              title: '把带固定收尾问的提问模板填进输入框',
              onClick: function () { askAi(view, null) },
            },
            '提问模板',
          ),
          h(
            'button',
            {
              className: 'dshpz-act',
              title: '让 AI 按五维审查这个项目：最弱的一维、缺哪条证据、怎么补',
              onClick: function () { askAi(view, null, auditTemplate) },
            },
            '审查',
          ),
          h(
            'button',
            {
              className: 'dshpz-act',
              title: '解绑本会话（回到没绑定；文档与文件夹都留着，不会被删）',
              onClick: function () { unbind(view) },
            },
            '解绑',
          ),
          // 只在旧格式时出现：当前格式的项目不需要这颗按钮。
          data.outdated === true
            ? h(
              'button',
              {
                className: 'dshpz-act',
                title: '文档是旧格式（v' + data.version + '）：先看预览，再决定是否落盘',
                onClick: function () { rebuildNow(view, false) },
              },
              '重建格式',
            )
            : null,
        ),
        h('div', { className: 'dshpz-muted' }, data.projectDir || ''),
        data.cwdSource !== undefined && data.cwdSource !== 'session'
          ? h('div', { className: 'dshpz-warn' }, '⚠ 拿不到会话工作目录，已退回 ' + data.projectRoot + '（文档可能写错地方）')
          : null,
        h('div', { className: 'dshpz-bar' }, h('div', { className: 'dshpz-fill', style: { width: data.health + '%' } })),
        h(
          'div',
          { className: 'dshpz-sect' },
          h('div', { className: 'dshpz-secttitle' }, '五维（跨模块均值）'),
          h('div', { className: 'dshpz-dims' }, DIMENSION_KEYS.map(function (key) {
            return dimensionRow(key, dimensions[key] || 0)
          })),
        ),
        h(
          'div',
          { className: 'dshpz-sect' },
          h('div', { className: 'dshpz-secttitle' }, '模块（' + moduleTiles.length + '）'),
          moduleTiles.length === 0
            ? h('div', { className: 'dshpz-muted' }, '还没有模块。让 AI 用 op:init 带 modules 一起建。')
            : h('div', { className: 'dshpz-grid' }, moduleTiles.map(function (piece) { return tile(piece, view) })),
        ),
        detailBlock(view),
        rebuildBlock(view),
        findingsBlock(view),
        h(
          'div',
          { className: 'dshpz-hint' },
          data.mode === '只拼不写'
            ? '当前只拼不写：AI 只提问 + 更新文档，越权工具会被宿主拦下。'
            : '当前边拼边写：AI 可以在小改动或大改动时各问一次后直接执行。',
          h('br', null),
          '健康性来自文档里写下的证据（要点 / 详细记录 / 决策 / 坑），空文档就是 0——不是印象分。',
          h('br', null),
          '每次提问的最后都会问：' + PAUSE_QUESTION,
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
          if (sessionId === undefined || sessionId === null) return undefined
          load(sessionId)
          loadProjects(sessionId)
          var timer = window.setInterval(function () {
            load(sessionId, view.state.data && view.state.data.initialized === true ? view.state.data.project : undefined)
          }, POLL_MS)
          return function () {
            window.clearInterval(timer)
          }
        },
        [view.state.open, view.state.sessionId, props.sessionId],
      )

      React.useEffect(function () {
        var onKey = function (event) {
          if (event.key === 'Escape') setState({ open: false, detail: null, detailName: null })
        }
        window.addEventListener('keydown', onKey)
        return function () {
          window.removeEventListener('keydown', onKey)
        }
      }, [])

      if (view.state.open !== true) return null
      return h(
        'div',
        {
          className: 'dshpz-backdrop',
          onClick: function (event) {
            if (event.target === event.currentTarget) setState({ open: false, detail: null, detailName: null })
          },
        },
        h('div', { className: 'dshpz-panel' }, panelBody(view)),
      )
    }

    /* -------------------------------- 按钮 -------------------------------- */

    function Icon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true },
        h('path', {
          fill: 'currentColor',
          d: 'M6.2 1.5a1.7 1.7 0 0 1 1.7 1.7v.6h2.6v2.6h.6a1.7 1.7 0 0 1 0 3.4h-.6v2.6H7.9v-.6a1.7 1.7 0 0 0-3.4 0v.6H1.9V9.8h.6a1.7 1.7 0 0 1 0-3.4h-.6V3.8h2.6v-.6a1.7 1.7 0 0 1 1.7-1.7Z',
        }),
      )
    }

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

      return h(
        'button',
        {
          type: 'button',
          className: 'dshpz-btn',
          'data-on': view.state.open === true ? '1' : '0',
          title: '拼图模式：项目健康性与模块',
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
        h(Icon, null),
        h('span', null, '拼图'),
        label === '' ? null : h('span', null, label),
      )
    }

    /* ------------------------------ 填提问模板 ------------------------------ */

    /**
     * 把提问模板写进输入框——**不自动发送**，由用户补完问题自己发。
     *
     * `inputActions.setDraft` 是 `conversation.input.left` 的标准 props 之一
     * （见 Client Slot catalog 的 InputActions 契约）。它可能不存在（例如没有
     * 当前会话时是 undefined），所以这里必须容错，不能让面板整个崩掉。
     */
    function askAi(view, prefix, template) {
      var actions = view.state.inputActions
      if (actions === undefined || actions === null || typeof actions.setDraft !== 'function') {
        setState({ error: '当前输入框不可写入（没有会话或输入区未就绪）' })
        return
      }
      var project = view.state.data && view.state.data.initialized === true ? view.state.data.project : ''
      var build = template === undefined || template === null ? questionTemplate : template
      var text = prefix === null || prefix === undefined
        ? build(project)
        : '【' + (project || '拼图') + ' · 提问】' + prefix + '\n\n' + PAUSE_QUESTION + '\n① ' + PAUSE_OPTIONS[0] + '\n② ' + PAUSE_OPTIONS[1]
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
      questionTemplate: questionTemplate,
      auditTemplate: auditTemplate,
      createTemplate: createTemplate,
      interviewTemplate: interviewTemplate,
      bindTemplate: bindTemplate,
      createByForm: createByForm,
      unbind: unbind,
      rebuildNow: rebuildNow,
    }
    return module.exports
  },
})
