/**
 * 把 UI.md 渲染成教程图（长图 + 逐节图）。
 *
 * 为什么需要它：工作区里那批教程图是 **v0.16.4** 时期渲染的，与当前 v0.19.1 的
 * UI.md 已经不一致（模式名、文档格式版本、工作流交互都变了）。
 * 图与正文对不上，比没有图更糟——所以要有一条**可重复**的渲染路径，
 * 而不是靠手工截图，下次改 UI.md 直接重跑。
 *
 * 用法：
 *   node tools/render-tutorial.mjs                 # 渲染并写入 .github/images/
 *   node tools/render-tutorial.mjs --out /tmp/x    # 输出到别处（试渲染）
 *   node tools/render-tutorial.mjs --no-split      # 只出长图，不切节
 *
 * 产出（全部 PNG）：
 *   ui-tutorial.png        整份长图（README 顶部用）
 *   01-入口按钮.png …      按 `## N. 标题` 切开的逐节图（UI.md 内联用）
 *
 * 依赖：`marked`（转 HTML）+ playwright 的 chromium（截图）。
 * 两者都**不在插件运行时依赖里**——这是构建期工具，不进 `files`。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const UI_MD = join(ROOT, 'UI.md')

/* --------------------------------- 参数 --------------------------------- */
const argv = process.argv.slice(2)
const outIdx = argv.indexOf('--out')
const OUT_DIR = outIdx >= 0 && argv[outIdx + 1] !== undefined
  ? resolve(argv[outIdx + 1])
  : join(ROOT, '.github', 'images')
const SPLIT = !argv.includes('--no-split')

/**
 * 页面宽度（CSS px）。
 *
 * **必须取 GitHub 正文宽（约 830px），不能取 1400**（踩过）：
 * GitHub 会把 README / UI.md 里宽于正文的图**等比缩到 830**。
 * 按 1400 渲染的图进页面后实际显示为 0.59x，字小到读不清；
 * 按 830 渲染则 1:1 显示，配合 deviceScaleFactor 2 在高分屏上依然锐利。
 */
const PAGE_WIDTH = 830

/**
 * 缩放倍率。
 *
 * 两个都用 2x。为什么：图在页面上按 **CSS 宽 830** 显示，
 * 2x 得到 1660 实像素 → 页面缩到 830 时是 2:1 降采样，
 * 在高分屏（手机 / Retina）上依然锐利；1x 在那些屏上会发糊。
 *
 * 实测体积（量化 256 色后）：9 张合计约 1.6MB，可接受。
 */
const SECTION_SCALE = 2
const FULL_SCALE = 2

/**
 * GitHub 风格样式。
 *
 * 为什么自己写而不是引 github-markdown-css：那是个额外的网络依赖，
 * 而这份样式只需要覆盖 UI.md 实际用到的元素（标题 / 表格 / 代码 / 引用块）。
 * 配色照 GitHub 浅色主题取值，保证渲染结果与仓库页面观感一致。
 *
 * 表格用 `table-layout:fixed` + `word-break`：窄宽（830px）下
 * 「内容」那列的长句会换行而不是把表格撑出画布（实测 1400px 时不需要，
 * 830px 时必须，否则表格右侧被裁掉）。
 */
const CSS = `
  :root { --fg:#1f2328; --muted:#59636e; --border:#d1d9e0; --bg:#ffffff;
          --code-bg:#f6f8fa; --accent:#0969da; --warn:#9a6700; --warn-bg:#fff8c5; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 28px; background:var(--bg); color:var(--fg);
         font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans CJK SC",
              "PingFang SC","Microsoft YaHei",sans-serif; }
  h1 { font-size:1.9em; margin:0 0 14px; padding-bottom:.3em; border-bottom:1px solid var(--border); }
  h2 { font-size:1.45em; margin:28px 0 14px; padding-bottom:.3em; border-bottom:1px solid var(--border); }
  h3 { font-size:1.2em; margin:22px 0 14px; }
  h4 { font-size:1em; margin:18px 0 10px; }
  p, ul, ol, table { margin:0 0 14px; }
  ul, ol { padding-left:2em; }
  li + li { margin-top:.25em; }
  a { color:var(--accent); text-decoration:none; }
  code { background:var(--code-bg); padding:.15em .35em; border-radius:5px;
         font:85%/1.5 ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace; }
  pre { background:var(--code-bg); padding:12px; border-radius:6px; overflow:auto; margin:0 0 14px; }
  pre code { background:none; padding:0; font-size:85%; }
  table { border-collapse:collapse; width:100%; table-layout:fixed; }
  th, td { border:1px solid var(--border); padding:5px 9px; word-break:break-word;
           font-size:14px; vertical-align:top; }
  th { background:var(--code-bg); font-weight:600; text-align:left; }
  blockquote { margin:0 0 14px; padding:0 1em; color:var(--muted); border-left:.25em solid var(--border); }
  blockquote code { font-size:85%; }
  hr { height:1px; margin:22px 0; border:0; background:var(--border); }
  /* 章节之间留出切图缝隙，切出来的每张图都自带上下留白。 */
  section.sec { padding:6px 0 20px; }
`

/** 把 markdown 切成「前言 + 每个 `## ` 一节」。 */
function splitSections(markdown) {
  const lines = markdown.split('\n')
  const sections = []
  let current = { title: null, lines: [] }
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line)
    // 只切 `## ` 二级标题；`### ` 属于上一节内部。
    if (m !== null && !line.startsWith('###')) {
      if (current.lines.length > 0) sections.push(current)
      current = { title: m[1], lines: [line] }
      continue
    }
    current.lines.push(line)
  }
  if (current.lines.length > 0) sections.push(current)
  return sections
}

/**
 * 剥掉正文里的图片引用再渲染。
 *
 * 为什么必须剥（踩过）：本脚本产出的图**被 UI.md 自己引用**，
 * 而脚本又是**照着 UI.md 渲染**的——不剥就是自引用。
 * `page.setContent` 没有 base URL，相对路径解析不到，
 * 渲染结果里会出现一排**破图图标**（实测确实出现了）。
 * 图是给正文配的，不该出现在「正文的渲染图」里。
 */
function stripImages(lines) {
  return lines.filter((line) => !/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line))
}

/**
 * 文件名安全化：去掉不能做文件名的字符，保留中文。
 *
 * 同时剥掉标题开头的**章节序号**（`1. 入口按钮` → `入口按钮`）：
 * 序号已经由文件名前缀 `01-` 表达，标题里再来一次会得到
 * `01-1.-入口按钮.png` 这种读不出重点的名字。
 */
function safeName(raw) {
  return String(raw)
    .replace(/^\s*\d+[.、)]\s*/, '')
    .replace(/^附[：:]\s*/, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/**
 * 解析 playwright：**优先本地**（仓库自己装了就用它），
 * 回退到 DSH 自带的那份（本机环境如此，避免为了出图再下一份浏览器）。
 *
 * 为什么要回退：playwright 会连带下载上百 MB 的浏览器；本机 DSH 已经装好
 * chromium，渲染脚本没理由再要一份。两条路都走不通时给出明确指引，
 * 而不是抛一个 `ERR_MODULE_NOT_FOUND` 让人猜。
 */
async function loadChromium() {
  const candidates = [
    'playwright',
    // `playwright-core` 不带浏览器，但能驱动**系统已装**的 Chromium（见 `launchBrowser`）。
    // 本机实测：npm 上 playwright 那个包体积大、镜像也慢，而系统本来就有 Edge——
    // 为了出一张图去下一个 130MB 的浏览器是纯浪费。
    'playwright-core',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/playwright/index.js',
  ]
  for (const spec of candidates) {
    try {
      const mod = await import(spec)
      const chromium = mod.chromium ?? mod.default?.chromium
      if (chromium !== undefined) return chromium
    } catch (_error) {
      /* 换下一个候选 */
    }
  }
  throw new Error(
    '找不到 playwright。装一个再重跑：npm i -D playwright-core（本机有 Edge/Chrome 就够了，不必下浏览器）',
  )
}

/**
 * 启动浏览器：先试 playwright 自带的 chromium，失败再试**系统已装**的 Edge / Chrome。
 *
 * 为什么要有第二档：`playwright-core` 不自带浏览器，直接 `launch()` 会报
 * 「Executable doesn't exist」。而 Windows 上 Edge 是系统自带的 Chromium，
 * 用 `channel: 'msedge'` 就能驱动它——出图这件事不需要指定版本。
 * 两条都失败才抛出原始错误，并把两个原因都带上（只报后一个会把真因藏掉）。
 */
async function launchBrowser(chromium) {
  const args = ['--no-sandbox', '--font-render-hinting=none']
  try {
    return await chromium.launch({ args })
  } catch (first) {
    for (const channel of ['msedge', 'chrome']) {
      try {
        return await chromium.launch({ channel, args })
      } catch (_error) {
        /* 换下一个 channel */
      }
    }
    throw new Error(
      '启动浏览器失败。自带 chromium：' + String(first && first.message ? first.message : first).split('\n')[0]
      + '；系统 Edge/Chrome 也起不来。装浏览器用：npx playwright install chromium',
    )
  }
}

/**
 * 用 Python/PIL 把产出的 PNG 量化到 256 色。
 *
 * 为什么值得单独一步（实测）：这批图是**文字截图**——白底 + 少量主题色，
 * 256 色足够表达，量化后合计 **4416KB → 1740KB（省 61%）**，
 * 而肉眼复核过文字边缘依旧锐利、没有色带。
 * 用 PIL 而不是 sharp：PIL 的 `quantize(MEDIANCUT)` 对这类图效果稳定，
 * 且本机已有；sharp 要另写一遍调参。
 *
 * 失败不致命：量化只是省体积，出不了图仍然可用，所以只告警不中断。
 */
async function quantize(dir, files) {
  const script = `
import sys, os
from PIL import Image
total0 = total1 = 0
for p in sys.argv[1:]:
    s0 = os.path.getsize(p)
    im = Image.open(p).convert('RGB')
    im.quantize(colors=256, method=Image.MEDIANCUT, dither=Image.NONE).save(p, 'PNG', optimize=True)
    total0 += s0
    total1 += os.path.getsize(p)
print(f'{total0//1024}KB -> {total1//1024}KB')
`
  const { spawnSync } = await import('node:child_process')
  // 找 python：`python3` 是 POSIX 惯例，Windows 上通常只有 `python`；
  // 另外 DSH 自带一份带 Pillow 的运行时（`$DSH_PYTHON` 可覆盖）。
  // 不找就直接跳过量化——那会让图从 1.7MB 涨到 6.5MB，所以值得多试几次。
  const candidates = [
    process.env.DSH_PYTHON,
    'python3',
    'python',
  ].filter((x) => typeof x === 'string' && x !== '')
  let lastError = '没找到 python'
  for (const bin of candidates) {
    const res = spawnSync(bin, ['-c', script, ...files.map((f) => join(dir, f))], { encoding: 'utf8' })
    if (res.status === 0) {
      console.log(`✓ 量化 256 色：${res.stdout.trim()}`)
      return
    }
    lastError = (res.stderr ?? '').trim().split('\n').pop() || String(res.error?.message ?? '')
  }
  console.warn('（量化跳过，图仍可用）：', lastError)
}

async function main() {
  const markdown = readFileSync(UI_MD, 'utf8')
  marked.setOptions({ gfm: true, breaks: false })

  const sections = splitSections(markdown)
  const preamble = sections[0]?.title === null ? sections.shift() : null

  const chromium = await loadChromium()
  const browser = await launchBrowser(chromium)

  mkdirSync(OUT_DIR, { recursive: true })
  const written = []

  /**
   * 先把上一轮的产物删掉。
   *
   * 为什么必须删（实测踩过）：本版 UI.md 插了一节，**后面的节号全体后移一位**——
   * `07-手机端.png` 变成 `08-手机端.png`。不清理的话，目录里会同时留着
   * `07-手机端.png`（旧）与 `07-主题管理页.png`（新），而 README 里
   * `![7. 手机端](…/07-手机端.png)` 仍然指得到旧图——**图与正文对不上，且没人会发现**。
   * 本仓的老教训正是「图与正文对不上比没图更糟」。
   */
  for (const stale of readdirSync(OUT_DIR)) {
    if (stale.endsWith('.png')) rmSync(join(OUT_DIR, stale), { force: true })
  }

  /* --------------------------- 0) 首页速览图 --------------------------- */
  /**
   * README 顶部那张。**不能直接放长图**（踩过）：长图 8000+px 高，
   * 进首页后要滚 5 屏多，第一屏全是它自己的目录，把「这插件长什么样」
   * 推到看不见的地方。所以首页只放「附录·按钮总览」那一节——
   * 它本来就是为「一屏速查」写的，短、密、能一眼看完全貌。
   *
   * 标题换成「面板长什么样」而不是照抄「附：按钮总览（一屏速查）」：
   * 后者是 UI.md 内部的附录编号，放首页当门面读起来像翻到了书末附录。
   */
  {
    const page = await browser.newPage({
      viewport: { width: PAGE_WIDTH, height: 1200 },
      deviceScaleFactor: SECTION_SCALE,
    })
    const overview = sections.find((s) => s.title !== null && s.title.startsWith('附'))
    if (overview === undefined) throw new Error('UI.md 里找不到「附：」那一节，首页图无法生成')
    // 丢掉原标题行（`## 附：…`），换成封面标题。
    const body = stripImages(overview.lines).filter((line) => !/^##\s/.test(line))
    const html = marked.parse(body.join('\n'))
    await page.setContent(
      `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>${CSS}</style></head>`
      + `<body><section class="sec"><h2>面板长什么样 · 一屏速查</h2>${html}</section></body></html>`,
      { waitUntil: 'load' },
    )
    const name = '00-首页速览.png'
    await page.locator('section.sec').screenshot({ path: join(OUT_DIR, name) })
    written.push(name)
    console.log(`✓ ${name}  ← README 顶部用`)
    await page.close()
  }

  /* ---------------------------- 1) 逐节图 ---------------------------- */
  if (SPLIT) {
    // 分节图逐段内联在 UI.md 里看，文字要清楚 → 2x。
    const page = await browser.newPage({
      viewport: { width: PAGE_WIDTH, height: 1200 },
      deviceScaleFactor: SECTION_SCALE,
    })
    let index = 0
    for (const sec of sections) {
      index += 1
      const html = marked.parse(stripImages(sec.lines).join('\n'))
      await page.setContent(
        `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>${CSS}</style></head>`
        + `<body><section class="sec">${html}</section></body></html>`,
        { waitUntil: 'load' },
      )
      const num = String(index).padStart(2, '0')
      const name = `${num}-${safeName(sec.title)}.png`
      const file = join(OUT_DIR, name)
      await page.locator('section.sec').screenshot({ path: file })
      written.push(name)
      console.log(`✓ ${name}  ← ${sec.title}`)
    }
    await page.close()
  }

  /* ----------------------------- 2) 长图 ----------------------------- */
  // 长图只是「一图流概览」，1x 足够——2x 会得到 3.1MB，没人会去读上面的小字。
  const fullPage = await browser.newPage({
    viewport: { width: PAGE_WIDTH, height: 1200 },
    deviceScaleFactor: FULL_SCALE,
  })
  const fullHtml = marked.parse(stripImages(markdown.split('\n')).join('\n'))
  await fullPage.setContent(
    `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>${CSS}</style></head>`
    + `<body>${fullHtml}</body></html>`,
    { waitUntil: 'load' },
  )
  const full = join(OUT_DIR, 'ui-tutorial.png')
  await fullPage.screenshot({ path: full, fullPage: true })
  written.push('ui-tutorial.png')
  console.log('✓ ui-tutorial.png  ← 整份长图')
  await fullPage.close()

  await browser.close()

  /* --------------------------- 3) 压体积 --------------------------- */
  await quantize(OUT_DIR, written)

  console.log(`\n输出目录：${OUT_DIR}`)
  console.log(`共 ${written.length} 张`)
  if (preamble !== null) console.log('（前言未单独出图，已并入长图）')
}

main().catch((error) => {
  console.error('渲染失败：', error)
  process.exit(1)
})
