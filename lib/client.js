/**
 * dsh-puzzle-mode —— 浏览器半。
 *
 * 两个 Slot，共用一个模块级 store：
 *   1) conversation.input.left  —— 模型选择器左边的小按钮（拼图图标 + 完整度角标）
 *   2) shell.overlay           —— 点按钮弹出的拼图面板（完整度 + 图块网格 + 模式开关）
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

    /* ------------------------------- 共享 store ------------------------------- */

    var state = { open: false, data: null, loading: false, error: null, sessionId: undefined }
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

    function useStore() {
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

    function load(sessionId) {
      if (sessionId === undefined || sessionId === null) {
        setState({ error: '当前会话没有会话 ID，无法读取拼图状态', loading: false })
        return
      }
      setState({ loading: true })
      fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'state', sessionId: String(sessionId) }),
      })
        .then(function (res) {
          return res.json()
        })
        .then(function (json) {
          if (json && json.ok === true) setState({ data: json.result, error: null, loading: false })
          else setState({ error: (json && json.error) || '未知错误', loading: false })
        })
        .catch(function () {
          setState({ error: '无法连接 ' + RPC, loading: false })
        })
    }

    function writeMode(sessionId, mode) {
      if (sessionId === undefined || sessionId === null) return
      setState({ loading: true })
      fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'mode', sessionId: String(sessionId), mode: mode }),
      })
        .then(function (res) {
          return res.json()
        })
        .then(function (json) {
          if (json && json.ok === true) {
            setState({ data: json.result, error: null, loading: false })
          } else {
            setState({ error: (json && json.error) || '模式写入失败', loading: false })
          }
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
      '.dshpz-tile{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px;background:var(--dsw-alias-bg-layer-1);min-height:74px;display:flex;flex-direction:column;gap:5px}',
      '.dshpz-tile[data-empty="1"]{opacity:.45}',
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
    ].join('\n')

    /* --------------------------------- 图块 --------------------------------- */

    function tile(piece) {
      var empty = piece.kind === 'module' && piece.exists === false
      var counts = piece.counts || {}
      var detail = []
      if (counts.items) detail.push('条 ' + counts.items)
      if (counts.pending) detail.push('悬 ' + counts.pending)
      if (counts.decided) detail.push('定 ' + counts.decided)
      return h(
        'div',
        { className: 'dshpz-tile', 'data-empty': empty ? '1' : '0', key: piece.id, title: piece.id },
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

    /* -------------------------------- 面板 -------------------------------- */

    function panelBody(view) {
      var data = view.state.data
      if (view.state.error !== null) {
        return h('div', null, h('div', { className: 'dshpz-err' }, String(view.state.error)))
      }
      if (data === null || data === undefined) return h('div', { className: 'dshpz-muted' }, '读取中…')
      if (data.initialized !== true) {
        return h(
          'div',
          null,
          h('div', { className: 'dshpz-muted' }, '还没有拼图项目。让 AI 描述这个项目，它会一次建出主文档与若干模块文档。'),
          h('div', { className: 'dshpz-hint' }, '目录：' + (data.projectRoot || '?') + '/<项目名>/拼图/'),
        )
      }
      var pieces = Array.isArray(data.pieces) ? data.pieces : []
      var modes = ['只拼不写', '边拼边写']
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'dshpz-row' },
          h('h3', { className: 'dshpz-title' }, '拼图 · ' + (data.project || '未命名')),
          h('span', { className: 'dshpz-muted' }, data.overall + '%'),
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
                    writeMode(view.state.sessionId, mode)
                  },
                },
                mode,
              )
            }),
          ),
          h(
            'button',
            {
              className: 'dshpz-close',
              title: '刷新',
              onClick: function () {
                load(view.state.sessionId)
              },
            },
            '⟳',
          ),
        ),
        h('div', { className: 'dshpz-muted' }, data.projectDir || ''),
        h('div', { className: 'dshpz-bar' }, h('div', { className: 'dshpz-fill', style: { width: data.overall + '%' } })),
        h('div', { className: 'dshpz-grid' }, pieces.map(tile)),
        h(
          'div',
          { className: 'dshpz-hint' },
          data.mode === '只拼不写'
            ? '当前只拼不写：AI 只提问 + 更新文档，不执行任何动作。'
            : '当前边拼边写：AI 可以在小改动或大改动时各问一次后直接执行。',
          h('br', null),
          '每次提问的最后都会问：要不要先停下？',
        ),
      )
    }

    function Panel(props) {
      var view = useStore()

      React.useEffect(
        function () {
          if (view.state.open !== true) return undefined
          if (view.state.sessionId === undefined || view.state.sessionId === null) return undefined
          load(props.sessionId === undefined ? view.state.sessionId : props.sessionId)
          var timer = window.setInterval(function () {
            load(props.sessionId === undefined ? view.state.sessionId : props.sessionId)
          }, POLL_MS)
          return function () {
            window.clearInterval(timer)
          }
        },
        [view.state.open, view.state.sessionId, props.sessionId],
      )

      React.useEffect(function () {
        var onKey = function (event) {
          if (event.key === 'Escape') setState({ open: false })
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
            if (event.target === event.currentTarget) setState({ open: false })
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
      var label = data !== null && data !== undefined && data.initialized === true ? data.overall + '%' : ''
      return h(
        'button',
        {
          type: 'button',
          className: 'dshpz-btn',
          'data-on': view.state.open === true ? '1' : '0',
          title: '拼图模式：完整度与图块',
          onMouseDown: function (event) {
            event.preventDefault()
          },
          onClick: function () {
            var next = view.state.open !== true
            setState({ open: next, sessionId: props.sessionId })
            if (next) load(props.sessionId)
          },
        },
        h(Icon, null),
        h('span', null, '拼图'),
        label === '' ? null : h('span', null, label),
      )
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

    module.exports = { name: 'dsh-puzzle-mode', apply: apply }
    return module.exports
  },
})
