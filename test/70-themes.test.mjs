/**
 * 主题功能的测试：**安全边界 + 缓存语义 + 前端复检与宿主口径一致**。
 *
 *   node test/70-themes.test.mjs
 *
 * 为什么这个文件必须存在（本功能唯一的攻击面就在这）：
 *   主题是「用户点一下就从网上取回来、注入进页面」的第三方文本。它的正确性有两半——
 *   好看不好看靠肉眼，**能不能被利用只能靠断言**。所以这里逐个喂恶意样本：
 *   外部 url()、@import、javascript:、`</` 提前闭合、越界选择器、花括号不配平。
 *
 * 为什么还要测「前端那份重复实现」：浏览器半是手写的 module-loader 包，拿不到
 * `lib/` 的 ESM 导出，所以它在挂载前**重复实现**了一遍硬规则（见 client.js 的
 * `themeCssRejectReason`）。重复实现必然漂移——除非有测试拿同一批样本同时喂两边。
 * 这就是本仓记过的「守卫只测纯函数会漏接线断开」的反面用法：**守卫本身也要被守卫**。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  THEME_API_VERSION,
  DEFAULT_THEME_REPO,
  MAX_THEME_BYTES,
  THEME_ID_RE,
  themeChannelsFor,
  sha256Hex,
  validateThemeCss,
  validateThemeIndex,
  readThemeState,
  setThemeRepo,
  applyTheme,
  resetTheme,
  uninstallTheme,
  loadThemeCss,
  themeOverview,
  themeFilesOnDisk,
} from '../lib/puzzle.js'

const here = dirname(fileURLToPath(import.meta.url))

let passed = 0
let failed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log('ok   ' + name)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log('FAIL ' + name + ' —— ' + (error && error.message ? error.message : String(error)))
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('ok   ' + name)
  } catch (error) {
    failed += 1
    failures.push({ name, error })
    console.log('FAIL ' + name + ' —— ' + (error && error.message ? error.message : String(error)))
  }
}

/**
 * 每个用例都在**自己的 DSH_HOME** 里跑。
 *
 * 主题状态是全局文件（用户裁定「全局记忆」），所以测试必须把 DSH_HOME 指到临时目录，
 * 否则跑一次测试就会把用户真实的当前主题改掉——那是本仓最不能接受的那种测试。
 */
function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'puzzle-theme-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return fn(home)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
}

/* ------------------------------ 恶意 CSS 白名单 ------------------------------ */

/**
 * 一份合法的最小主题：只声明 `--dshpz-*`，选择器全落在插件自己的类上。
 * 所有恶意样本都以它为基底改一处，保证「被拒绝」是那一处导致的。
 */
const GOOD_CSS = [
  ':root{--dshpz-accent:#ff7ab6;--dshpz-accent-hi:#ffd0e6;--dshpz-on-accent:#2a0a18}',
  '.dshpz-panel{--dshpz-glass:#1b1020}',
  '.dshpz-btn{color:var(--dshpz-accent)}',
].join('\n')

check('白名单：合法主题通过，并回报字节数', () => {
  const r = validateThemeCss(GOOD_CSS)
  assert.equal(r.ok, true, '合法主题必须通过：' + r.error)
  assert.equal(typeof r.bytes, 'number')
  assert.ok(r.bytes > 0)
})

check('白名单：空 CSS 被拒', () => {
  assert.equal(validateThemeCss('').ok, false)
  assert.equal(validateThemeCss('   \n ').ok, false)
  assert.equal(validateThemeCss(null).ok, false)
})

check('白名单：@import 被拒（能拉外部资源）', () => {
  const r = validateThemeCss(GOOD_CSS + '\n@import url("https://evil.example/x.css");')
  assert.equal(r.ok, false)
  assert.match(String(r.error), /@import/)
})

check('白名单：外部 url() 被拒（能外带数据/跟踪）', () => {
  for (const css of [
    GOOD_CSS + '\n.dshpz-panel{background:url(https://evil.example/p.png)}',
    GOOD_CSS + "\n.dshpz-panel{background:url('//evil.example/p.png')}",
    GOOD_CSS + '\n.dshpz-panel{background:url(http://evil.example/p.png)}',
  ]) {
    const r = validateThemeCss(css)
    assert.equal(r.ok, false, '外部 url 必须被拒：' + css)
  }
})

check('白名单：data:image 内联图放行（不请求外部）', () => {
  const r = validateThemeCss(GOOD_CSS + '\n.dshpz-panel{background-image:url(data:image/svg+xml;base64,PHN2Zy8+)}')
  assert.equal(r.ok, true, 'data:image 应放行：' + r.error)
})

check('白名单：javascript: 与 expression() 被拒（等于在 CSS 里执行 JS）', () => {
  assert.equal(validateThemeCss(GOOD_CSS + '\n.dshpz-panel{background:javascript:alert(1)}').ok, false)
  assert.equal(validateThemeCss(GOOD_CSS + '\n.dshpz-panel{width:expression(alert(1))}').ok, false)
})

check('白名单：`</` 被拒（会提前闭合 style 标签，变成 HTML 注入）', () => {
  const r = validateThemeCss(GOOD_CSS + '\n/* </style><script>alert(1)</script> */')
  assert.equal(r.ok, false)
  assert.match(String(r.error), /闭合/)
})

check('白名单：花括号不配平被拒（会静默破坏后续规则）', () => {
  assert.equal(validateThemeCss(':root{--dshpz-accent:red').ok, false)
  assert.equal(validateThemeCss(':root{--dshpz-accent:red}}').ok, false)
  // 注释里的花括号不该参与配平判断（否则合法主题会被误拒）。
  assert.equal(validateThemeCss('/* { */\n' + GOOD_CSS).ok, true, '注释里的 { 不该影响配平')
})

check('白名单：越界选择器被拒（作用域只能是面板 + 小按钮）', () => {
  for (const css of [
    'body{--dshpz-accent:red}',
    '*{--dshpz-accent:red}',
    '.some-host-class{--dshpz-accent:red}',
    'html.dark{--dshpz-accent:red}',
  ]) {
    const r = validateThemeCss(css)
    assert.equal(r.ok, false, '越界选择器必须被拒：' + css)
  }
})

check('白名单：`:root` 里只能声明 --dshpz-* 变量', () => {
  const r = validateThemeCss(':root{--dshpz-accent:red;color:red}')
  assert.equal(r.ok, false, '`color:red` 会改整个界面，必须拒')
  assert.match(String(r.error), /--dshpz-/)
})

check('白名单：一份什么都不改的主题被拒（应用了也没变化＝功能像坏的）', () => {
  const r = validateThemeCss('.dshpz-panel{color:red}')
  assert.equal(r.ok, false)
  assert.match(String(r.error), /--dshpz-/)
})

check('白名单：@media / @supports 里的规则照常逐条判（递归不能漏）', () => {
  assert.equal(validateThemeCss('@media (max-width:900px){.dshpz-panel{--dshpz-accent:red}}').ok, true)
  // 递归里也要拦住越界选择器——否则包一层 @media 就绕过了白名单。
  assert.equal(validateThemeCss('@media (max-width:900px){body{--dshpz-accent:red}}').ok, false)
  // 未知 at-rule 一律拒绝（@font-face 能拉外部字体）。
  assert.equal(validateThemeCss('@font-face{font-family:x;src:url(https://evil/x.woff)}').ok, false)
  // @keyframes 里的百分比不是 DOM 选择器，放过。
  assert.equal(validateThemeCss('@keyframes dshpz-x{from{opacity:0}to{opacity:1}}\n' + GOOD_CSS).ok, true)
})

check('白名单：体积上限生效', () => {
  const big = ':root{--dshpz-accent:red}\n' + '/* ' + 'x'.repeat(MAX_THEME_BYTES) + ' */'
  const r = validateThemeCss(big)
  assert.equal(r.ok, false)
  assert.match(String(r.error), /超过/)
})

/* ------------------------------ 清单校验 ------------------------------ */

const goodIndex = {
  apiVersion: THEME_API_VERSION,
  themes: [
    { id: 'sakura', name: '樱花', author: 'liancha22', version: '1.0.0', accent: '#ff7ab6', sha256: 'a'.repeat(64), file: 'themes/sakura/theme.css' },
    { id: 'noir', name: '墨黑', sha256: 'b'.repeat(64) },
  ],
}

check('清单：合法清单通过，默认 file 路径按 id 推出来', () => {
  const r = validateThemeIndex(goodIndex)
  assert.equal(r.ok, true, '合法清单必须通过：' + r.error)
  assert.equal(r.themes.length, 2)
  assert.equal(r.themes[1].file, 'themes/noir/theme.css', '没写 file 就按约定推')
  assert.equal(r.themes[1].name, '墨黑')
})

check('清单：apiVersion 不匹配整批拒绝（跨仓版本对不上时不能装）', () => {
  const r = validateThemeIndex({ ...goodIndex, apiVersion: THEME_API_VERSION + 1 })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /apiVersion/)
})

check('清单：缺 hash 的主题保留在列表但标成不可安装', () => {
  const r = validateThemeIndex({ apiVersion: THEME_API_VERSION, themes: [{ id: 'x', name: 'X', sha256: 'short' }] })
  assert.equal(r.ok, true)
  assert.equal(r.themes[0].sha256, '', '不合法的 hash 要清成空串（前端据此禁用按钮）')
})

check('清单：非法 id / 重复 id / 坏形状都被挡掉', () => {
  const r = validateThemeIndex({
    apiVersion: THEME_API_VERSION,
    themes: [
      { id: '../escape', sha256: 'a'.repeat(64) },
      { id: 'UPPER', sha256: 'a'.repeat(64) },
      { id: '', sha256: 'a'.repeat(64) },
      { id: 'ok', sha256: 'a'.repeat(64) },
      { id: 'ok', sha256: 'b'.repeat(64) },
      'not-an-object',
      null,
    ],
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.themes.map((t) => t.id), ['ok'], '只该留下一个合法的 ok（重复项去重）')
})

check('清单：不是对象 / 缺 themes 都被拒', () => {
  assert.equal(validateThemeIndex(null).ok, false)
  assert.equal(validateThemeIndex([]).ok, false)
  assert.equal(validateThemeIndex('x').ok, false)
  assert.equal(validateThemeIndex({ apiVersion: THEME_API_VERSION }).ok, false)
})

check('主题 id 正则：只认小写字母数字开头，挡掉路径符号', () => {
  for (const ok of ['sakura', 'a', 'my-theme_2', 'a.b']) assert.equal(THEME_ID_RE.test(ok), true, ok + ' 应合法')
  for (const bad of ['../x', 'a/b', 'A', '-x', '', 'x'.repeat(65)]) assert.equal(THEME_ID_RE.test(bad), false, bad + ' 应非法')
})

/* ------------------------------ 多镜像与 sha256 ------------------------------ */

check('通道：默认顺序是 jsDelivr → gh-proxy → raw（本机 GitHub 直连不通）', () => {
  const keys = themeChannelsFor('').map((c) => c.key)
  assert.deepEqual(keys, ['jsdelivr', 'gh-proxy', 'raw'])
})

check('通道：填了自定义源就排最前（自己的源优先）', () => {
  const channels = themeChannelsFor('https://my.example/themes/')
  assert.equal(channels[0].key, 'custom')
  assert.equal(channels[0].url('o/r', 'main', 'index.json'), 'https://my.example/themes/index.json', '尾部斜杠不能拼成双斜杠')
  assert.equal(channels.length, 4)
})

check('通道：内置通道 URL 形状正确', () => {
  const byKey = {}
  for (const c of themeChannelsFor('')) byKey[c.key] = c
  assert.equal(byKey.jsdelivr.url('o/r', 'main', 'index.json'), 'https://cdn.jsdelivr.net/gh/o/r@main/index.json')
  assert.match(byKey['gh-proxy'].url('o/r', 'main', 'index.json'), /^https:\/\/gh-proxy\.com\/https:\/\/raw\.githubusercontent\.com\/o\/r\/main\/index\.json$/)
  assert.equal(byKey.raw.url('o/r', 'main', 'index.json'), 'https://raw.githubusercontent.com/o/r/main/index.json')
})

check('sha256：同一文本稳定，改一个字符就变', () => {
  assert.equal(sha256Hex('abc'), sha256Hex('abc'))
  assert.notEqual(sha256Hex('abc'), sha256Hex('abd'))
  assert.equal(sha256Hex('abc').length, 64)
})

/* ------------------------------ 状态与缓存语义 ------------------------------ */

check('状态：坏文件 / 缺失文件都退回「没装过主题」，不抛错', () => {
  withHome(() => {
    const s = readThemeState()
    assert.equal(s.current, '')
    assert.deepEqual(s.installed, {})
    assert.equal(s.repo, DEFAULT_THEME_REPO)
    assert.equal(s.base, '')
  })
})

check('状态：当前主题必须同时已装（手改状态文件不能骗过读回）', () => {
  withHome((home) => {
    // 直接写一个「当前=某主题，但已装清单是空的」状态文件。
    writeFileSync(join(home, '.dsh-puzzle-mode-themes.json'), JSON.stringify({ current: 'ghost', installed: {} }))
    const s = readThemeState()
    assert.equal(s.current, '', '指向未安装的主题时当前主题要归零（否则面板会读不存在的 CSS）')
  })
})

check('状态：坏 installed 条目被逐条过滤，不整份丢掉', () => {
  withHome((home) => {
    writeFileSync(join(home, '.dsh-puzzle-mode-themes.json'), JSON.stringify({
      current: 'ok',
      installed: { ok: { name: 'OK', sha256: 'a'.repeat(64) }, '../bad': { name: 'BAD' }, 'also-bad': 'not-an-object' },
    }))
    const s = readThemeState()
    assert.deepEqual(Object.keys(s.installed), ['ok'])
    assert.equal(s.current, 'ok')
  })
})

check('应用：没下载过的主题不能应用（要给出可执行的下一步）', () => {
  withHome(() => {
    const r = applyTheme('nope')
    assert.equal(r.ok, false)
    assert.match(String(r.hint || ''), /下载/)
  })
})

check('应用 / 读回 / 卸载 / 恢复默认：一条完整回路', () => {
  withHome(() => {
    const themes = join(process.env.DSH_HOME, 'puzzle-mode-themes')
    mkdirSync(themes, { recursive: true })
    // 直接落盘一份合法主题，再走 applyTheme —— 与 installTheme 的落盘结果同形。
    writeFileSync(join(themes, 'sakura.css'), GOOD_CSS)
    writeFileSync(join(process.env.DSH_HOME, '.dsh-puzzle-mode-themes.json'), JSON.stringify({
      current: '', installed: { sakura: { name: '樱花', version: '1.0.0', sha256: sha256Hex(GOOD_CSS), accent: '#ff7ab6' } },
    }))

    const applied = applyTheme('sakura')
    assert.equal(applied.ok, true, '已安装的主题应能应用：' + applied.error)
    assert.equal(applied.css, GOOD_CSS)

    // 不带 id 读回 = 读当前生效主题（面板 state 走的就是这条）。
    const loaded = loadThemeCss('')
    assert.equal(loaded.ok, true)
    assert.equal(loaded.id, 'sakura')
    assert.equal(loaded.css, GOOD_CSS)
    assert.equal(loaded.name, '樱花')

    const overview = themeOverview()
    assert.equal(overview.current, 'sakura')
    assert.equal(overview.installedCount, 1)
    assert.deepEqual(themeFilesOnDisk(), ['sakura.css'])

    const removed = uninstallTheme('sakura')
    assert.equal(removed.ok, true)
    assert.equal(removed.resetCurrent, true, '卸掉当前在用的主题要顺带回默认')
    assert.equal(readThemeState().current, '')
    assert.equal(existsSync(join(themes, 'sakura.css')), false, '卸载要真的删掉缓存文件')
    assert.deepEqual(themeFilesOnDisk(), [])
  })
})

check('读回：磁盘上的主题被手工改成恶意内容时**读回也要拦**', () => {
  withHome(() => {
    const themes = join(process.env.DSH_HOME, 'puzzle-mode-themes')
    mkdirSync(themes, { recursive: true })
    // 落盘时合法、之后被手工替换成会外带数据的版本。
    writeFileSync(join(themes, 'evil.css'), GOOD_CSS + '\n.dshpz-panel{background:url(https://evil.example/p.png)}')
    writeFileSync(join(process.env.DSH_HOME, '.dsh-puzzle-mode-themes.json'), JSON.stringify({
      current: 'evil', installed: { evil: { name: 'Evil' } },
    }))
    const r = loadThemeCss('')
    assert.equal(r.ok, false, '读回时必须重新校验，否则手工替换就绕过了白名单')
    assert.match(String(r.error), /安全校验/)
  })
})

check('读回：主题文件被删掉时给出「重新下载」的提示', () => {
  withHome((home) => {
    writeFileSync(join(home, '.dsh-puzzle-mode-themes.json'), JSON.stringify({ current: 'gone', installed: { gone: { name: 'Gone' } } }))
    const r = loadThemeCss('')
    assert.equal(r.ok, false)
    assert.match(String(r.hint || ''), /重新下载/)
  })
})

check('恢复默认：清掉当前但不卸载已装主题', () => {
  withHome((home) => {
    writeFileSync(join(home, '.dsh-puzzle-mode-themes.json'), JSON.stringify({ current: 'a', installed: { a: { name: 'A' } } }))
    resetTheme()
    const s = readThemeState()
    assert.equal(s.current, '')
    assert.equal(s.installed.a !== undefined, true, '恢复默认不该卸载主题')
  })
})

check('主题源：owner/name 与 http(s) 两种写法，非法值被拒', () => {
  withHome(() => {
    assert.equal(setThemeRepo('me/themes').ok, true)
    assert.equal(readThemeState().repo, 'me/themes')
    assert.equal(setThemeRepo('https://my.example/t/').ok, true)
    assert.equal(readThemeState().base, 'https://my.example/t', '尾部斜杠要去掉')
    assert.equal(setThemeRepo('not a repo').ok, false)
    // 空串 = 回到默认仓库并清掉自定义 base。
    assert.equal(setThemeRepo('').ok, true)
    const s = readThemeState()
    assert.equal(s.repo, DEFAULT_THEME_REPO)
    assert.equal(s.base, '')
  })
})

/* --------------------- 前端复检与宿主口径必须一致 --------------------- */

/**
 * 这一块是本文件最重要的部分：拿**同一批恶意样本**同时喂给宿主半与浏览器半。
 *
 * 两侧必须给出同样的「拒 / 放」结论。任何一侧放宽（或被改坏），这里就红。
 * 若只测宿主半，浏览器半那份重复实现漂移了也无人发现——而它才是最后
 * 把文本交给浏览器的那一道。
 */
await checkAsync('前端复检与宿主白名单：同一批样本结论一致', async () => {
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  let loaded = null
  const fakeWindow = {
    __ModuleLoader__: { load(entry) { loaded = entry } },
    setInterval() { return 1 },
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
  }
  const fakeReact = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, function () {}] },
    useEffect() {},
  }
  const fakeFetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: false, error: 'x' }) })
  new Function('window', 'document', 'fetch', source)(
    fakeWindow,
    { createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} }, body: {} },
    fakeFetch,
  )
  const mod = loaded.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('unexpected require: ' + name)
  })
  assert.equal(typeof mod.themeCssRejectReason, 'function', '浏览器半必须导出复检函数（否则这条断言无从下手）')

  const samples = [
    ['合法', GOOD_CSS, true],
    ['空', '', false],
    ['@import', GOOD_CSS + '\n@import url(https://evil/x.css);', false],
    ['外部 url', GOOD_CSS + '\n.dshpz-panel{background:url(https://evil/p.png)}', false],
    ['data:image', GOOD_CSS + '\n.dshpz-panel{background:url(data:image/png;base64,AA)}', true],
    ['javascript:', GOOD_CSS + '\n.dshpz-panel{background:javascript:alert(1)}', false],
    ['expression', GOOD_CSS + '\n.dshpz-panel{width:expression(alert(1))}', false],
    ['闭合 style', GOOD_CSS + '\n/* </style> */', false],
  ]
  for (const [label, css, shouldPass] of samples) {
    const hostVerdict = validateThemeCss(css).ok === true
    const clientVerdict = mod.themeCssRejectReason(css) === null
    assert.equal(hostVerdict, shouldPass, '宿主半对「' + label + '」的判断不对')
    assert.equal(clientVerdict, hostVerdict,
      '两侧口径漂移：「' + label + '」宿主半=' + hostVerdict + ' 前端=' + clientVerdict
      + '（重复实现必须同步，见 client.js 的 themeCssRejectReason）')
  }
})

await checkAsync('前端 applyUserTheme：合法则挂 style 节点，恶意则撤掉旧节点', async () => {
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  let loaded = null
  const nodes = {}
  const created = []
  const fakeWindow = {
    __ModuleLoader__: { load(entry) { loaded = entry } },
    setInterval() { return 1 },
    clearInterval() {},
    addEventListener() {},
    removeEventListener() {},
  }
  const fakeReact = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, function () {}] },
    useEffect() {},
  }
  const fakeDoc = {
    getElementById: (id) => (nodes[id] === undefined ? null : nodes[id]),
    createElement: (tag) => {
      const node = {
        tag,
        attrs: {},
        textContent: '',
        parentNode: null,
        setAttribute(k, v) { this.attrs[k] = v },
      }
      created.push(node)
      return node
    },
    head: {
      appendChild(node) {
        node.parentNode = {
          removeChild(child) {
            child.parentNode = null
            delete nodes[child.attrs.id]
          },
        }
        if (node.attrs && node.attrs.id) nodes[node.attrs.id] = node
      },
    },
  }
  fakeDoc.head.parentNode = null
  new Function('window', 'document', 'fetch', source)(fakeWindow, fakeDoc, () => Promise.resolve({ json: () => Promise.resolve({ ok: false }) }))
  const mod = loaded.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('unexpected require: ' + name)
  })

  assert.equal(mod.applyUserTheme(GOOD_CSS), null, '合法主题应挂载成功')
  assert.equal(created.length, 1, '应只创建一个 style 节点')
  const themeNode = created[0]
  assert.equal(themeNode.textContent, GOOD_CSS)
  assert.notEqual(themeNode.parentNode, null, '合法主题应真的挂进 head')

  // 同一个节点要复用（幂等），不能每次挂一个新的——否则主题会越挂越多。
  assert.equal(mod.applyUserTheme(GOOD_CSS), null)
  assert.equal(created.length, 1, '重复挂载必须复用同一个节点')

  // 恶意内容：必须拒绝**并把已经挂上的旧主题撤掉**（留着旧主题＝状态在骗人）。
  const reason = mod.applyUserTheme(GOOD_CSS + '\n.dshpz-panel{background:url(https://evil/p.png)}')
  assert.notEqual(reason, null, '恶意主题必须被拒')
  assert.equal(themeNode.parentNode, null, '拒绝时旧主题节点要被摘掉')
})

/* --------------------- 「主题不在打包里」必须有守卫 --------------------- */

/**
 * 用户最原始的那条要求：「主题 UI 不在打包里，只点击从仓库下载」。
 *
 * 这句话有**两个方向**，都得钉住，否则迟早被无意破坏：
 *   ① 包里不能出现主题内容（皮肤 CSS）；
 *   ② 包里必须**有**那条下载通路（否则「不在包里」就退化成「根本没有」）。
 *
 * 只测 ① 会漏掉「把功能删了也算通过」这种荒唐结果——本仓的老教训是
 * 「守卫只测纯函数会漏接线断开」，所以这里同时钉住两个方向。
 */
check('打包：`files` 不含任何主题目录，且 lib/ 下没有皮肤 CSS 文件', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  const files = Array.isArray(pkg.files) ? pkg.files : []
  // 主题内容若进了包，一定是从这些入口进来的。
  for (const forbidden of ['themes', 'theme', 'skins', 'assets/themes']) {
    assert.equal(files.includes(forbidden), false, '`files` 不该包含 ' + forbidden + '（主题必须只在仓库里）')
  }
  // `lib/` 里只该有代码：出现 `.css` 文件就说明有人把皮肤塞进了包。
  const libDir = join(here, '..', 'lib')
  const cssInLib = readdirSync(libDir).filter((name) => name.endsWith('.css'))
  assert.deepEqual(cssInLib, [], 'lib/ 下不该有 .css（皮肤必须从仓库下，不随包走）')
})

check('打包：下载通路必须在包里（否则「不在包里」变成「没有」）', () => {
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
  const files = Array.isArray(pkg.files) ? pkg.files : []
  assert.ok(files.includes('lib'), 'lib/ 必须在包里（主题的下载/校验逻辑在里面）')
  assert.ok(existsSync(join(here, '..', 'lib', 'themes.js')), 'lib/themes.js 必须在（它是下载通路本身）')
  // 默认源必须是个 owner/name，且不是空串——空源等于功能没有默认出口。
  assert.match(DEFAULT_THEME_REPO, /^[\w.-]+\/[\w.-]+$/, '默认主题源要写成 owner/name')
})

console.log('')
console.log(passed + ' 项通过 / ' + failed + ' 项失败')
if (failed > 0) {
  for (const row of failures) console.log('  - ' + row.name + '：' + (row.error && row.error.message ? row.error.message : String(row.error)))
  process.exit(1)
}
