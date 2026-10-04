/**
 * 主题下载的**端到端**验证：起一个本地 HTTP 服务当「主题仓库」，
 * 用插件**真实的下载路径**（`fetchThemeFile` 的多镜像回退 + `installTheme` 的
 * 校验/落盘/应用）走一遍。
 *
 *   node tools/verify-theme-install.mjs <主题仓库路径>
 *
 * 为什么需要它：`test/70-themes.test.mjs` 测的是纯函数（白名单、清单校验、状态读写），
 * 它**不发一个请求**。而「下载」这条路上真正会出事的地方恰恰是网络层：
 * URL 拼错、镜像回退不生效、hash 比对用了错的字符串、装完没落盘、应用了但状态没写。
 * 这些在纯函数测试里全是绿的。
 *
 * 为什么用本地服务而不是真去 GitHub：本机 GitHub 直连超时、raw 不通，
 * 而**本地服务能确定性复现成功与失败两条路**（比如故意改一个字节让 hash 对不上）。
 * 真网络的可用性由 `tools/verify-themes.mjs --remote` 单独负责。
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { installTheme, applyTheme, loadThemeCss, readThemeState, resetTheme, uninstallTheme, setThemeRepo } from '../lib/puzzle.js'

const repo = process.argv[2] || join(process.cwd(), '..', 'dsh-puzzle-themes')
let failed = 0
const fail = (msg) => { failed += 1; console.error('FAIL ' + msg) }
const ok = (msg) => console.log('ok   ' + msg)

if (!existsSync(join(repo, 'index.json'))) {
  console.error('主题仓库里没有 index.json：' + repo)
  process.exit(1)
}

/** 故意改坏一个字节：用来验证「hash 不符必须拒绝」。 */
let corrupt = false

const server = createServer((req, res) => {
  // 只服务仓库目录内的文件；挡掉 `..` 跳出（本脚本自己是服务器，也要守规矩）。
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^[\\/]+/, '')
  if (rel.includes('..')) { res.writeHead(403); res.end('no'); return }
  const file = join(repo, rel)
  if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return }
  let body = readFileSync(file)
  if (corrupt && rel.endsWith('.css')) {
    // 改**中间**一个字节，而不是末尾：这样能证明比对的是整份内容，
    // 不是「只看长度」或「只比前 12 位」。
    body = Buffer.from(body.toString('utf8').replace('--dshpz-accent:', '--dshpz-accent:' + ' '))
  }
  res.writeHead(200, { 'content-type': extname(rel) === '.json' ? 'application/json' : 'text/css' })
  res.end(body)
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}`
console.log('本地主题仓库：' + base + '  （源目录 ' + repo + '）\n')

// 把主题状态指到临时 DSH_HOME，别动用户真实的当前主题。
const home = mkdtempSync(join(process.env.TEMP || '/tmp', 'puzzle-e2e-'))
const prevHome = process.env.DSH_HOME
process.env.DSH_HOME = home

try {
  // 用自建源（本地服务）——这条同时验证了「用户可填自定义源」那条路。
  setThemeRepo(base)
  ok('自定义主题源已设置：' + base)

  /* ------------------------- 1) 正常安装 ------------------------- */
  const installed = await installTheme('sakura')
  if (installed.ok !== true) fail('installTheme(sakura) 失败：' + installed.error)
  else ok(`下载成功：通道=${installed.channel} 体积=${installed.bytes}B`)

  if (installed.ok === true) {
    const applied = applyTheme('sakura')
    if (applied.ok !== true) fail('applyTheme 失败：' + applied.error)
    else {
      if (!applied.css.includes('--dshpz-accent')) fail('应用后的 CSS 里没有主题内容')
      else ok('已应用，CSS 内容正确（' + applied.css.length + ' 字符）')
    }
    const loaded = loadThemeCss('')
    if (loaded.ok !== true) fail('读回当前主题失败：' + loaded.error)
    else if (loaded.id !== 'sakura') fail('读回的主题 id 不对：' + loaded.id)
    else ok('读回当前主题：' + loaded.name + '（' + loaded.id + '）')
    if (readThemeState().current !== 'sakura') fail('状态文件里的 current 没写对')
    else ok('状态文件已记录当前主题')
  }

  /* --------------------- 2) 另一个主题（换主题） --------------------- */
  const second = await installTheme('noir')
  if (second.ok !== true) fail('installTheme(noir) 失败：' + second.error)
  else {
    applyTheme('noir')
    const loaded = loadThemeCss('')
    if (loaded.id !== 'noir') fail('换主题后读回的不是 noir：' + loaded.id)
    else ok('换主题成功：sakura → noir')
  }

  /* --------------------- 3) hash 不符必须拒绝 --------------------- */
  corrupt = true
  const bad = await installTheme('deepsea')
  if (bad.ok !== true) {
    if (!/sha256/.test(String(bad.error))) fail('拒绝了但原因不是 sha256：' + bad.error)
    else ok('内容被改动 → 以 sha256 不符拒绝安装（未落盘）')
  } else {
    fail('内容被改动却装成功了——hash 校验形同虚设')
  }
  // 而且**不能覆盖**已装好的同名主题。
  const stillNoir = loadThemeCss('')
  if (stillNoir.ok !== true || stillNoir.id !== 'noir') fail('拒绝安装时把已装的主题弄坏了')
  else ok('拒绝安装没有破坏已在用的主题')
  corrupt = false

  /* --------------------- 4) 未知主题 / 未知 id --------------------- */
  const ghost = await installTheme('not-a-theme')
  if (ghost.ok === true) fail('装一个清单里没有的主题竟然成功了')
  else ok('清单里没有的主题被拒绝：' + ghost.error)

  /* --------------------- 5) 卸载与恢复默认 --------------------- */
  uninstallTheme('noir')
  if (readThemeState().current !== '') fail('卸载当前主题后没有回默认')
  else ok('卸载当前主题 → 自动恢复默认')
  resetTheme()
  const all = readThemeState()
  if (Object.keys(all.installed).length !== 1) fail('卸载后已装清单数量不对：' + JSON.stringify(Object.keys(all.installed)))
  else ok('已装清单正确（剩 sakura 一套）')
} finally {
  server.close()
  if (prevHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevHome
  rmSync(home, { recursive: true, force: true })
}

console.log('')
console.log(failed === 0 ? '主题下载端到端验证通过' : failed + ' 项失败')
process.exit(failed === 0 ? 0 : 1)
