/**
 * 真联网端到端：**从 GitHub 上的主题仓库真的下载一套主题**，走插件的完整安装路径。
 *
 *   node tools/verify-themes-online.mjs [themeId]
 *
 * 与另外两个自检的分工：
 *   - `verify-themes.mjs --remote`：只验「清单能不能拉到、格式对不对」；
 *   - `verify-theme-install.mjs`：本地起 HTTP 服务，验安装/校验/卸载**逻辑**，不碰外网；
 *   - **本脚本**：把两者接起来——真联网、真 sha256、真落盘，是「用户点一下」的最终判据。
 *
 * 它用**临时 DSH_HOME**，不会动用户真实的当前主题。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'puzzle-online-'))
process.env.DSH_HOME = HOME

const base = new URL('../lib/puzzle.js', import.meta.url).href
const {
  listThemes,
  installTheme,
  applyTheme,
  loadThemeCss,
  uninstallTheme,
  resetTheme,
  themeOverview,
  DEFAULT_THEME_REPO,
} = await import(base)

const want = process.argv[2] || 'sakura'
let failed = 0
const fail = (m) => { failed += 1; console.error('FAIL ' + m) }
const ok = (m) => console.log('ok   ' + m)

console.log('主题仓库：' + DEFAULT_THEME_REPO + '  目标主题：' + want + '\n')

try {
  /* 1) 拉清单 */
  const listed = await listThemes()
  if (listed.ok !== true) {
    fail('拉远端清单失败：' + listed.error)
    for (const row of listed.tried ?? []) console.error('  - ' + row.channel + ' → ' + row.error)
  } else {
    ok('清单拉到（通道 ' + listed.channel + '，' + listed.themes.length + ' 套主题）')
    if (listed.themes.length === 0) fail('清单里一套主题都没有')
  }

  /* 2) 真的下载 + 校验 sha256 + 落盘 */
  const installed = await installTheme(want)
  if (installed.ok !== true) {
    fail('安装 ' + want + ' 失败：' + installed.error + (installed.hint ? '（' + installed.hint + '）' : ''))
    for (const row of installed.tried ?? []) console.error('  - ' + row.channel + ' → ' + row.error)
  } else {
    ok('下载成功：通道 ' + installed.channel + '，' + installed.bytes + ' 字节')
    ok('sha256 与清单一致（不符会被拒，这里能过说明锚点对得上）')
  }

  /* 3) 应用 + 读回 */
  if (installed.ok === true) {
    const applied = applyTheme(installed.id)
    if (applied.ok !== true) fail('应用失败：' + applied.error)
    else if (!String(applied.css).includes('--dshpz-')) fail('应用后的 CSS 里没有主题变量')
    else ok('已应用，CSS 含 --dshpz-* 变量（' + applied.css.length + ' 字符）')

    const loaded = loadThemeCss('')
    if (loaded.ok !== true) fail('读回失败：' + loaded.error)
    else ok('读回当前主题：' + loaded.name + '（' + loaded.id + '）')

    const overview = themeOverview()
    if (overview.current !== want) fail('当前主题不是 ' + want + '：' + overview.current)
    else ok('状态文件已记录当前主题')

    // 4) 文件真的落盘了
    if (!existsSync(overview.dir)) fail('主题缓存目录不存在：' + overview.dir)
    else {
      const file = join(overview.dir, want + '.css')
      if (!existsSync(file)) fail('CSS 没落盘：' + file)
      else ok('CSS 已落盘：' + file + '（' + readFileSync(file, 'utf8').length + ' 字符）')
    }

    /* 5) 卸载 + 恢复默认 */
    uninstallTheme(want)
    resetTheme()
    if (themeOverview().current !== '') fail('卸载后当前主题没归零')
    else ok('卸载 + 恢复默认正常')
  }
} finally {
  rmSync(HOME, { recursive: true, force: true })
}

console.log('')
console.log(failed === 0 ? '真联网安装闭环通过' : failed + ' 项失败')
process.exit(failed === 0 ? 0 : 1)
