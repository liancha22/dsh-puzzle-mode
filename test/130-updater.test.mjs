/**
 * 自动更新测试：版本比较 / 更新日志解析 / tar 解包安全 / 校验链。
 *
 *   node test/130-updater.test.mjs
 *
 * ## 为什么要有这一组
 *
 * 用户裁定：检测到新版本后，「**下载 + 校验 + 解包到暂存区，再给一条命令**」——
 * 插件只写自己的缓存目录，一个字节都不碰 profile。所以这条链上有三件必须钉死的事：
 *
 *   1. **版本比较要准**：判错方向会让用户「点了更新、装完发现还是同一个版本」；
 *   2. **解包不能逃逸**：这是整条路径上唯一的攻击面（解压一个从网上下来的归档）；
 *   3. **校验要说实话**：正文里没有哈希锚点时退化成结构校验，且**如实标成未校验哈希**——
 *      假装验过了比不验更糟。
 *
 * ## 为什么自己造 tar 而不下载真包
 *
 * 测试要能离线跑（CI 与裸目录都能跑），而且要能构造**恶意**归档
 * （`../` 穿越、绝对路径、符号链接）——真发布包里没有这些，只能自己造。
 * 造包用的是 tar 的公开格式（512 字节头 + 八进制长度），与 `parseTar` 是同一份规格。
 */
import assert from 'node:assert/strict'
// **必须最先**：隔离 DSH_HOME（本组会读 `$DSH_HOME` 下的暂存目录）。
import './helpers/isolate-home.mjs'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  ASSET_CHANNELS,
  MAX_TARBALL_BYTES,
  UPDATE_PACKAGE_NAME,
  UPDATE_STATE_AHEAD,
  UPDATE_STATE_LATEST,
  UPDATE_STATE_NEWER,
  changelogSectionOf,
  compareVersions,
  downloadUpdate,
  extractTarball,
  installCommandOf,
  isNewerVersion,
  isSafeTarPath,
  normalizeVersion,
  parseTar,
  pluginVersion,
  releaseInfoOf,
  sha256FromNotes,
  sha256OfBytes,
  stagedTarballPath,
  RELEASE_SUMMARY_LINES,
  summarizeNotes,
  releaseListOf,
  releaseListOf as _releaseListOf,
  updaterArgsOf,
  localVersion,
  installedVersionOf,
  stageUpdaterScript,
  updaterScriptPath,
  listBackups,
  readUpdateRun,
  UPDATER_SCRIPT,
} from '../lib/puzzle.js'

const root = mkdtempSync(join(tmpdir(), 'puzzle-updater-'))
let passed = 0

function ok(name) {
  passed += 1
  console.log(`ok   ${name}`)
}

/**
 * 造一个 tar 条目（512 字节头 + 内容 + 512 对齐填充）。
 *
 * 只写 `parseTar` 会读的字段：name(0-100) / size(124-136, 八进制) /
 * typeflag(156) / prefix(345-500)。这与真实 tar 的布局一致。
 */
function tarEntry(name, content, typeFlag = '0') {
  const data = Buffer.from(content, 'utf8')
  const header = Buffer.alloc(512, 0)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644', 100, 8, 'utf8')       // mode
  header.write('0000000', 108, 8, 'utf8')       // uid
  header.write('0000000', 116, 8, 'utf8')       // gid
  header.write(data.length.toString(8).padStart(11, '0'), 124, 12, 'utf8') // size
  header.write('00000000000', 136, 12, 'utf8')  // mtime
  header.write('        ', 148, 8, 'utf8')      // checksum 占位
  header.write(typeFlag, 156, 1, 'utf8')
  header.write('ustar', 257, 6, 'utf8')
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512, 0)
  return Buffer.concat([header, data, padding])
}

/** 把若干条目打成 tar（末尾两个全零块）。 */
function makeTar(entries) {
  return Buffer.concat([...entries, Buffer.alloc(1024, 0)])
}

/** 造一个「像真发布包」的 tgz。 */
function makeTarball(files) {
  return gzipSync(makeTar(files.map(([name, content]) => tarEntry(name, content))))
}

/** 一个合法的发布包（顶层 `package/`，含 package.json）。 */
function goodTarball(version = '1.0.0', extra = []) {
  return makeTarball([
    ['package/package.json', JSON.stringify({ name: UPDATE_PACKAGE_NAME, version })],
    ['package/lib/index.js', 'export const x = 1\n'],
    ...extra,
  ])
}

try {
  /* ---------------- 版本号 ---------------- */

  assert.equal(normalizeVersion('v1.0.0'), '1.0.0', '去掉前导 v')
  assert.equal(normalizeVersion('1.0.0+build.5'), '1.0.0', '去掉 +build 后缀')
  assert.equal(normalizeVersion('  1.2.3  '), '1.2.3', '去空白')
  assert.equal(normalizeVersion(''), '', '空串安全')
  assert.equal(normalizeVersion(null), '', '非字符串安全')
  ok('版本号规范化（v 前缀 / +build / 空白 / 非字符串）')

  // Release 的 tag 是 `v1.0.0`、package.json 的是 `1.0.0`——
  // 不规范化就会把同一个版本判成「有更新」，那是最烦人的假报。
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0, 'tag 与 version 写法不同但同版本 → 相等')
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1, '补丁号大 → 更新')
  assert.equal(compareVersions('0.30.0', '1.0.0'), -1, '主版本小 → 更旧')
  assert.equal(compareVersions('1.2.0', '1.10.0'), -1, '按数值比而不是按字符串比（2 < 10）')
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1, '主版本优先')
  // 预发布 < 同号正式版。
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1, '预发布版比正式版旧')
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1, '正式版比预发布版新')
  // 形状不认识 → 判「一样」，宁可少报也不要凭空报「有新版」。
  assert.equal(compareVersions('abc', '1.0.0'), 0, '认不出的版本判「一样」（不凭空报更新）')
  assert.equal(compareVersions('', ''), 0, '两个空串判「一样」')
  assert.equal(isNewerVersion('1.0.1', '1.0.0'), true, '有新版')
  assert.equal(isNewerVersion('1.0.0', '1.0.0'), false, '同版本不算有新版')
  ok('版本比较：数值比较 / 预发布语义 / 认不出时不乱报')

  /* ---------------- 哈希锚点解析 ---------------- */

  const hash = 'a'.repeat(64)
  assert.equal(sha256FromNotes(`正文\nsha256: ${hash}\n更多`), hash, '认 `sha256: ...` 写法')
  assert.equal(sha256FromNotes(`sha256=${hash}`), hash, '认 `sha256=...` 写法')
  assert.equal(sha256FromNotes('SHA256: ' + hash.toUpperCase()), hash, '大小写不敏感，且统一小写')
  assert.equal(sha256FromNotes('正文里没有哈希'), '', '找不到 → 空串（据此退化成结构校验）')
  assert.equal(sha256FromNotes('sha256: abc'), '', '位数不够不算锚点')
  assert.equal(sha256FromNotes(null), '', '非字符串安全')
  ok('从 Release 正文解析 sha256 锚点（找不到时如实返回空串）')

  /* ---------------- 更新日志 ---------------- */

  const changelog = [
    '# 更新日志',
    '',
    '## 历史版本',
    '',
    '### v0.30.0 · 旧版',
    '',
    '旧内容',
    '',
    '### v1.0.0 · 自动更新',
    '',
    '新内容第一行',
    '新内容第二行',
    '',
    '## 工作流',
    '',
    '不该被带进来',
  ].join('\n')
  const section = changelogSectionOf(changelog, '1.0.0')
  assert.ok(section.includes('新内容第一行'), '取到目标版本那一节')
  assert.ok(section.includes('新内容第二行'), '整节都要，不能只取第一行')
  assert.ok(!section.includes('旧内容'), '不许把别的版本带进来')
  assert.ok(!section.includes('不该被带进来'), '遇到下一个二级标题就停')
  assert.equal(changelogSectionOf(changelog, '9.9.9'), '', '找不到那一版 → 空串（不瞎猜）')
  assert.equal(changelogSectionOf(changelog, ''), '', '空版本号安全')
  ok('更新日志按版本取节（取整节 / 不越界 / 找不到不瞎猜）')

  /* ---------------- Release 响应规范化 ---------------- */

  const release = releaseInfoOf({
    tag_name: 'v1.0.0',
    name: '自动更新',
    body: 'sha256: ' + hash,
    html_url: 'https://example.com/r',
    published_at: '2026-10-08T00:00:00Z',
    prerelease: false,
    draft: false,
    assets: [
      { name: 'dsh-puzzle-mode-1.0.0.tgz', browser_download_url: 'https://example.com/a.tgz', size: 123, sha256: 'B'.repeat(64) },
      { name: '', browser_download_url: 'https://example.com/bad' },
    ],
  })
  assert.equal(release.ok, true, '合法响应要认')
  assert.equal(release.version, '1.0.0', 'tag 规范化成版本号')
  assert.equal(release.assets.length, 1, '缺名字的附件要剔掉')
  assert.equal(release.assets[0].sha256, 'b'.repeat(64), '附件 sha256 统一小写')
  assert.equal(sha256FromNotes(release.body), hash, '正文锚点可解析')
  assert.equal(releaseInfoOf(null).ok, false, '非对象 → 失败')
  assert.equal(releaseInfoOf({}).ok, false, '缺 tag_name → 失败（不返回半成品）')
  ok('Release 响应规范化（剔坏附件 / 缺字段明确失败）')

  /* ---------------- tar 解析 ---------------- */

  const tar = makeTar([
    tarEntry('package/package.json', '{"a":1}'),
    tarEntry('package/lib/', '', '5'),
    tarEntry('package/lib/x.js', 'const a = 1'),
  ])
  const parsed = parseTar(tar)
  assert.equal(parsed.ok, true, '合法 tar 要解得开')
  assert.equal(parsed.entries.length, 3, '三个条目')
  assert.equal(parsed.entries[0].name, 'package/package.json', '条目名要读对')
  assert.equal(parsed.entries[0].data.toString('utf8'), '{"a":1}', '内容要读对')
  assert.equal(parsed.entries[1].type, 'dir', '目录条目要认出来')
  // 截断的归档必须报错而不是静默少解几个文件。
  //
  // 截断点要落在**正文中间**：第一条目是 512 字节头 + 7 字节内容（`{"a":1}`），
  // 所以正文区间是 [512, 519)。切在 600 是**切在条目之后**——那时正文是完整的，
  // 只是后面少了几条，`parseTar` 没有条目总数可比，本来就判不出来（见下面那条断言）。
  const truncated = parseTar(tar.subarray(0, 515))
  assert.equal(truncated.ok, false, '正文被截断的 tar 要报错（不许静默少解）')
  // **已知边界，写出来免得被当成已覆盖**：tar 没有「条目总数」字段，
  // 所以「正文完整但尾部少了几条」是**判不出来**的。真正的兜底不在这一层——
  // 是 `downloadUpdate` 里的包名 / 版本 / 字节数核对：少了文件的包对不上，
  // 那一步会拒。这里只保证「单个条目读到一半就没了」这类明显损坏能被抓住。
  assert.equal(parseTar(tar.subarray(0, 600)).ok, true, '尾部少条目判不出来（已文档化的边界）')
  ok('tar 解析（文件名 / 内容 / 目录 / 正文截断报错）')

  // 链接条目一律拒：它是「解包逃逸」最经典的载体。
  const symlinkTar = makeTar([tarEntry('package/evil', '/etc/passwd', '2')])
  assert.equal(parseTar(symlinkTar).ok, false, '符号链接条目要拒')
  const hardlinkTar = makeTar([tarEntry('package/evil', 'target', '1')])
  assert.equal(parseTar(hardlinkTar).ok, false, '硬链接条目要拒')
  ok('tar 里的链接条目一律拒（逃逸载体）')

  /* ---------------- 解包路径安全 ---------------- */

  assert.equal(isSafeTarPath('package/lib/a.js'), true, '普通相对路径放行')
  assert.equal(isSafeTarPath('a/b/c.txt'), true, '多层相对路径放行')
  assert.equal(isSafeTarPath('../etc/passwd'), false, '`..` 穿越要拦')
  assert.equal(isSafeTarPath('package/../../x'), false, '中途的 `..` 也要拦')
  assert.equal(isSafeTarPath('..\\..\\windows'), false, '反斜杠穿越也要拦（Windows）')
  assert.equal(isSafeTarPath('/etc/passwd'), false, '绝对路径要拦')
  assert.equal(isSafeTarPath('C:\\Windows\\x'), false, 'Windows 盘符路径要拦')
  assert.equal(isSafeTarPath(''), false, '空名要拦')
  assert.equal(isSafeTarPath(null), false, '非字符串要拦')
  ok('解包路径安全判定（穿越 / 绝对 / 盘符 / 反斜杠 / 空名）')

  /* ---------------- 解包落地 ---------------- */

  const dest = join(root, 'extract')
  mkdirSync(dest, { recursive: true })
  const good = extractTarball(goodTarball('1.0.0'), dest)
  assert.equal(good.ok, true, '合法包要解得开')
  assert.equal(good.count, 2, '两个文件（目录不算文件）')
  // 顶层 `package/` 要剥掉：落盘就是插件目录本身。
  assert.equal(existsSync(join(dest, 'package.json')), true, '顶层 package/ 被剥掉')
  assert.equal(existsSync(join(dest, 'lib', 'index.js')), true, '子目录结构保留')
  assert.equal(existsSync(join(dest, 'package', 'package.json')), false, '不该留一层 package/')
  ok('解包落地（剥掉顶层 package/，保留子目录）')

  // **核心安全断言**：带穿越的包一个文件都不许落地。
  const evilDest = join(root, 'evil')
  mkdirSync(evilDest, { recursive: true })
  const evil = extractTarball(goodTarball('1.0.0', [['package/../../pwned.txt', 'x']]), evilDest)
  assert.equal(evil.ok, false, '带 `..` 穿越的包必须拒绝解包')
  assert.equal(existsSync(join(root, 'pwned.txt')), false, '穿越的文件不许出现在解包目录之外')
  assert.equal(existsSync(join(evilDest, 'package.json')), false, '拒绝时要**整体不落盘**（先校验后写）')
  ok('带穿越的包整体拒绝，且一个文件都不落盘')

  // 不是 gzip → 明确报错（下到 HTML 错误页是常见情形）。
  const notGzip = extractTarball(Buffer.from('<html>404</html>'), join(root, 'ng'))
  assert.equal(notGzip.ok, false, '非 gzip 数据要报错')
  assert.ok(notGzip.error.includes('gzip'), '错误要说得清是 gzip 的问题')
  ok('非 gzip 数据明确报错（下到 HTML 错误页的情形）')

  /* ---------------- 安装命令 ---------------- */

  const cmd = installCommandOf('1.0.0', { profile: 'C:\\profiles\\desktop' })
  assert.ok(cmd.command.includes('cd "C:\\profiles\\desktop"'), '有 profile 路径时先 cd')
  assert.ok(cmd.command.includes(`pnpm add ${UPDATE_PACKAGE_NAME}@github:`), '用 pnpm add + github: 规格')
  assert.ok(cmd.command.includes('#v1.0.0'), '规格里带 tag')
  // 沿用 profile 原有的 `github:` 规格族，升级后 package.json 形状不变。
  // 若用 `file:` 指向暂存目录，那个目录一被清理依赖就悬空了。
  assert.ok(!cmd.command.includes('file:'), '不许用 file: 规格（暂存目录被清理后依赖会悬空）')
  const noProfile = installCommandOf('1.0.0', {})
  assert.ok(!noProfile.command.includes('cd '), '不知道 profile 时**不编造** cd 路径')
  ok('安装命令（有 profile 先 cd / 无 profile 不编路径 / 不用 file: 规格）')

  /* ---------------- 插件自身版本 ---------------- */

  const current = pluginVersion()
  assert.ok(/^\d+\.\d+\.\d+/.test(current), `本插件版本要能从 package.json 读出来（读到 ${current}）`)
  // 与 package.json 逐字一致：写死常量会在发版时漂移成「永远显示有更新」。
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
  assert.equal(current, normalizeVersion(pkg.version), '版本号来自 package.json，不是写死的常量')
  ok(`插件版本从 package.json 现读（${current}）`)

  /* ---------------- 状态常量与暂存路径 ---------------- */

  assert.equal(UPDATE_STATE_NEWER, 'newer', '有新版的状态值')
  assert.equal(UPDATE_STATE_LATEST, 'latest', '已最新的状态值')
  assert.equal(UPDATE_STATE_AHEAD, 'ahead', '本机比线上新（未发布提交）的状态值')
  assert.ok(MAX_TARBALL_BYTES >= 1024 * 1024, 'tgz 上限要留够余量（正常约 450KB）')
  assert.ok(ASSET_CHANNELS.length >= 2, '附件下载要有多个通道（直连不通时靠镜像）')
  // 暂存路径必须在 DSH_HOME 下（插件只写自己的缓存目录，不碰 profile）。
  const staged = stagedTarballPath('1.0.0')
  assert.ok(staged.includes('1.0.0'), '暂存路径带版本号')
  assert.ok(staged.endsWith('.tgz'), '暂存的是 tgz')
  ok('状态常量 / 体积上限 / 暂存路径形状')

  /* ---------------- 下载与校验链（走真实 HTTP，不用 mock） ---------------- */

  /**
   * 为什么起一个**真的**本地 HTTP 服务而不是 mock `fetch`：
   * 校验链（体积上限 → sha256 锚点 → gzip → 包名/版本/字节数）里有好几处
   * 只在「真的读到字节」时才走到。mock 掉 fetch 就等于把这条链整段跳过，
   * 测试会全绿而防线没验过——变异验证正是这样抓出来的：把锚点比对改成恒真，
   * 上面那些纯函数断言**一条都不红**。
   *
   * 服务只监听回环地址，端口由系统分配（`listen(0)`），跑完立刻关。
   */
  const { createServer } = await import('node:http')
  const served = new Map()
  const server = createServer((req, res) => {
    const body = served.get(req.url)
    if (body === undefined) {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) })
    res.end(body)
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  try {
    const tarball = goodTarball('1.0.0')
    const realHash = sha256OfBytes(tarball)
    served.set('/good.tgz', tarball)

    // 锚点正确 → 装进暂存区，且**标成 sha256 级校验**。
    const okDownload = await downloadUpdate('1.0.0', {
      assetUrl: `${base}/good.tgz`,
      anchorSha256: realHash,
      info: { tarball: { url: `${base}/good.tgz`, size: tarball.length } },
    })
    assert.equal(okDownload.ok, true, `锚点正确时应当装成功：${okDownload.ok === true ? '' : okDownload.error}`)
    assert.equal(okDownload.verified, 'sha256', '有锚点且比对通过 → 标成强校验')
    assert.equal(okDownload.sha256, realHash, '回报的 sha256 与实际字节一致')
    assert.equal(okDownload.bytes, tarball.length, '字节数正确')
    assert.equal(existsSync(join(okDownload.dir, 'package.json')), true, '解包后的文件真的在暂存区')
    assert.equal(existsSync(okDownload.tarballPath), true, 'tgz 也留在暂存区（便于排查）')
    assert.equal(existsSync(join(okDownload.dir, 'update.json')), true, '写下 update.json 记录来源与校验级别')
    const meta = JSON.parse(readFileSync(join(okDownload.dir, 'update.json'), 'utf8'))
    assert.equal(meta.verified, 'sha256', '记录里如实写明校验级别')
    assert.equal(meta.sha256, realHash, '记录里存着实际哈希')
    ok('下载链：锚点正确 → 解包到暂存区并标成强校验')

    // **核心安全断言**：锚点不符 → 拒绝，且**一个文件都不落盘**。
    const wrongHash = 'f'.repeat(64)
    const badDownload = await downloadUpdate('1.0.0', {
      assetUrl: `${base}/good.tgz`,
      anchorSha256: wrongHash,
      info: { tarball: { url: `${base}/good.tgz`, size: tarball.length } },
    })
    assert.equal(badDownload.ok, false, '锚点不符必须拒绝')
    assert.ok(badDownload.error.includes('sha256'), '错误要说清是 sha256 不符')
    assert.ok(badDownload.hint.includes(wrongHash.slice(0, 12)), '提示要给出「正文写的」与「实际的」以便排查')
    ok('下载链：锚点不符 → 拒绝安装')

    // 没有锚点（老版本正文没写哈希）→ 退化成结构校验，且**如实标成未校验哈希**。
    const structural = await downloadUpdate('1.0.0', {
      assetUrl: `${base}/good.tgz`,
      anchorSha256: '',
      info: { tarball: { url: `${base}/good.tgz`, size: tarball.length } },
    })
    assert.equal(structural.ok, true, '没有锚点时按结构校验放行')
    assert.equal(structural.verified, 'structural', '**如实**标成结构校验（不假装验过哈希）')
    ok('下载链：没有锚点时标成结构校验（不假装验过哈希）')

    // 下到的不是本插件 / 版本不对 → 拒（防「拿错包」）。
    served.set('/wrongname.tgz', makeTarball([
      ['package/package.json', JSON.stringify({ name: 'something-else', version: '1.0.0' })],
    ]))
    const wrongName = await downloadUpdate('1.0.0', {
      assetUrl: `${base}/wrongname.tgz`,
      anchorSha256: '',
      info: { tarball: { url: `${base}/wrongname.tgz`, size: 0 } },
    })
    assert.equal(wrongName.ok, false, '包名不对要拒')
    assert.ok(wrongName.error.includes(UPDATE_PACKAGE_NAME), '错误要点名期望的包名')

    served.set('/wrongver.tgz', makeTarball([
      ['package/package.json', JSON.stringify({ name: UPDATE_PACKAGE_NAME, version: '9.9.9' })],
    ]))
    const wrongVer = await downloadUpdate('1.0.0', {
      assetUrl: `${base}/wrongver.tgz`,
      anchorSha256: '',
      info: { tarball: { url: `${base}/wrongver.tgz`, size: 0 } },
    })
    assert.equal(wrongVer.ok, false, '版本不一致要拒')
    ok('下载链：包名 / 版本不符一律拒（防拿错包）')

    // 字节数与 Release 声明的不符 → 拒（防截断的下载）。
    const sizeMismatch = await downloadUpdate('1.0.0', {
      assetUrl: `${base}/good.tgz`,
      anchorSha256: '',
      info: { tarball: { url: `${base}/good.tgz`, size: tarball.length + 1 } },
    })
    assert.equal(sizeMismatch.ok, false, '字节数与声明不符要拒')
    ok('下载链：字节数与声明不符 → 拒（防截断下载）')

    // 下到 HTML 错误页（不是 gzip）→ 明确报错。
    served.set('/html.tgz', Buffer.from('<html>404</html>'))
    const html = await downloadUpdate('1.0.0', {
      assetUrl: `${base}/html.tgz`,
      anchorSha256: '',
      info: { tarball: { url: `${base}/html.tgz`, size: 0 } },
    })
    assert.equal(html.ok, false, '非 gzip 要拒')
    assert.ok(html.error.includes('gzip'), '错误要说清是 gzip 的问题')
    ok('下载链：下到 HTML 错误页 → 明确报错')

    // 没有附件地址（jsDelivr 回退通道拿不到附件）→ 明确失败并指路，不静默。
    const noAsset = await downloadUpdate('1.0.0', { info: { tarball: null } })
    assert.equal(noAsset.ok, false, '没有附件地址时明确失败')
    assert.ok(noAsset.hint !== undefined && noAsset.hint.includes('Release'), '要指路去 Release 页')
    ok('下载链：拿不到附件地址时明确失败并指路')

    // HTTP 404 → 明确报错（带通道诊断）。
    const missingAsset = await downloadUpdate('1.0.0', {
      assetUrl: `${base}/nope.tgz`,
      anchorSha256: '',
      info: { tarball: { url: `${base}/nope.tgz`, size: 0 } },
    })
    assert.equal(missingAsset.ok, false, '404 要报错')
    assert.ok(Array.isArray(missingAsset.tried) && missingAsset.tried.length > 0, '失败时带回各通道的诊断')
    ok('下载链：HTTP 失败时带回通道诊断（不是一句笼统的「下载失败」）')
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise))
  }

  /* ---------------- 各版本更新日志（v1.0.1：洁简，每版最多 3 行） ---------------- */

  assert.equal(RELEASE_SUMMARY_LINES, 3, `用户裁定每版最多 ${RELEASE_SUMMARY_LINES} 行摘要`)
  ok(`每版摘要上限 = ${RELEASE_SUMMARY_LINES} 行（用户裁定）`)

  // **核心**：摘要必须真的短——这是「不要一大堆字」那条需求的判据。
  const longBody = [
    '# v1.0.0 · 很长的标题',
    '',
    '**粗体**说明第一句。',
    '',
    '- 列表项一',
    '- 列表项二',
    '- 列表项三',
    '- 列表项四',
    '- 列表项五',
    '',
    '| 项 | 值 |',
    '| --- | --- |',
    '| a | 1 |',
    '',
    '![图](x.png)',
    '',
    '---',
    '',
    '结尾一段话',
  ].join('\n')
  const sum = summarizeNotes(longBody)
  assert.equal(sum.lines.length, RELEASE_SUMMARY_LINES, `摘要必须正好 ${RELEASE_SUMMARY_LINES} 行`)
  assert.equal(sum.truncated, true, '被截断时要标出来')
  assert.ok(sum.rest > 0, '要能说出还剩几行（静默截断会让人以为这版就这么点内容）')
  ok(`长正文被压成 ${RELEASE_SUMMARY_LINES} 行 + 「还有 ${sum.rest} 行」`)

  // 逐条判据：标题、空行、图片、分隔线都该丢掉；列表符号与粗体要规范化。
  const joined = sum.lines.join('\n')
  assert.ok(!joined.includes('#'), '标题行要丢掉（列表里已有版本号与标题，重复占地方）')
  assert.ok(!joined.includes('!['), '图片行要丢掉（纯文本摘要里是乱码）')
  assert.ok(!joined.includes('---'), '分隔线要丢掉（只是排版）')
  assert.ok(joined.includes('粗体说明第一句'), '**粗体** 记号要去掉但文字要留')
  assert.ok(!joined.includes('**'), 'markdown 粗体记号要剥掉')
  assert.ok(joined.includes('· 列表项一'), '列表符号统一成 ·')
  ok('摘要规则：丢标题/图片/分隔线，剥粗体记号，列表符号统一')

  // 短正文不该被标成截断。
  const shortSum = summarizeNotes('就一句话。')
  assert.equal(shortSum.truncated, false, '短正文不算截断')
  assert.equal(shortSum.lines.length, 1, '短正文一行')
  assert.equal(summarizeNotes('').lines.length, 0, '空正文安全')
  assert.equal(summarizeNotes(null).lines.length, 0, '非字符串安全')
  ok('短正文不标截断 / 空值安全')

  // 表格行要压平保留：发版正文的关键信息常在表里，整行丢掉会漏掉「改了什么」。
  const tableSum = summarizeNotes('| 通道 | 结果 |\n| --- | --- |\n| API | 通 |')
  assert.ok(tableSum.lines.some((one) => one.includes('通道') && one.includes('结果')), '表格表头要压平保留')
  assert.ok(tableSum.lines.some((one) => one.includes('API') && one.includes('通')), '表格数据行要压平保留')
  assert.ok(!tableSum.lines.some((one) => one.includes('---')), '表格分隔行要丢掉')
  ok('表格行压平保留（关键信息常在表里）')

  /* ---------------- Release 列表解析 ---------------- */

  const listJson = [
    { tag_name: 'v1.0.0', name: 'v1.0.0 · 新', body: '第一行\n第二行\n第三行\n第四行', published_at: '2026-10-08T00:00:00Z', html_url: 'https://x/1', prerelease: false, draft: false },
    { tag_name: 'v0.9.0', name: 'v0.9.0 · 旧', body: '旧的一行', published_at: '2026-09-01T00:00:00Z', html_url: 'https://x/09', prerelease: false, draft: false },
    { tag_name: 'v9.9.9', name: '草稿', body: 'x', draft: true },
    { name: '缺 tag', body: 'y' },
  ]
  const parsedList = releaseListOf(listJson, { current: '0.9.0' })
  assert.equal(parsedList.ok, true, '列表要认')
  assert.equal(parsedList.releases.length, 2, '草稿与缺 tag 的要剔掉')
  // 排序：新的在前（用户看日志是从新往旧看）。
  assert.equal(parsedList.releases[0].version, '1.0.0', '最新的排最前')
  assert.equal(parsedList.releases[1].version, '0.9.0', '旧版在后')
  // 「当前装的那版」要标出来——没有这个标记，用户得自己找。
  assert.equal(parsedList.releases[0].current, false, '不是当前装的那版')
  assert.equal(parsedList.releases[1].current, true, '当前装的那版要标记出来')
  assert.equal(parsedList.releases[0].summary.length, RELEASE_SUMMARY_LINES, '每版都带摘要')
  assert.equal(parsedList.releases[0].summaryTruncated, true, '四行正文压成三行 → 标截断')
  ok('Release 列表：剔草稿/缺字段、按版本倒序、标出当前版、每版带摘要')

  assert.equal(releaseListOf(null).ok, false, '非数组要明确失败')
  assert.equal(releaseListOf([]).releases.length, 0, '空列表安全')
  ok('Release 列表的坏输入明确失败 / 空列表安全')

  /* ---------------- 安装器：参数与暂存（v1.0.1） ---------------- */

  const args = updaterArgsOf({ profile: 'P', tag: 'v2.0.0', version: '2.0.0' })
  for (const flag of ['--profile', '--tag', '--expect-version', '--result']) {
    assert.ok(args.includes(flag), `安装器参数要带 ${flag}`)
  }
  assert.equal(args[args.indexOf('--tag') + 1], 'v2.0.0', 'tag 要传对')
  assert.equal(args[args.indexOf('--expect-version') + 1], '2.0.0', '期望版本要传对（自检用它比对）')
  ok('安装器参数拼装（profile / tag / 期望版本 / 结果路径）')

  // **核心设计**：脚本要先被复制到 $DSH_HOME 下再跑——它要替换插件自己的文件，
  // 住在插件里就会出现「装坏了脚本也没了」的死局。
  const stagedScript = stageUpdaterScript()
  assert.equal(stagedScript.ok, true, `更新器脚本要能被暂存：${stagedScript.ok === true ? '' : stagedScript.error}`)
  assert.equal(stagedScript.path, updaterScriptPath(), '暂存路径是 $DSH_HOME 下的固定位置')
  assert.ok(stagedScript.path.includes('puzzle-mode-updates'), '暂存位置在更新目录里（不属于任何包）')
  assert.ok(!stagedScript.path.includes('node_modules'), '**绝不能**放在 node_modules 里——那正是会被装坏的地方')
  assert.equal(existsSync(stagedScript.path), true, '脚本真的落到盘上了')
  assert.equal(UPDATER_SCRIPT, 'dsh-puzzle-update.mjs', '脚本文件名')
  ok('更新器脚本被暂存到 $DSH_HOME（不在 node_modules 里，装坏了也还在）')

  // 读「上一次运行」：没有结果时返回 null（面板据此显示「还没装过」而不是报错）。
  assert.equal(readUpdateRun(), null, '没有结果文件时返回 null（不抛错）')
  assert.ok(Array.isArray(listBackups()), '备份清单要能列出来（没有就是空数组）')

  /* ---------------- 本机版本必须读 profile，不能读「跑着的代码」 ---------------- */

  /**
   * 这条是**实测踩到的真坑**（v1.0.1 发完当场发现）：开发机上跑着的代码来自源码仓库
   * （版本已是新的），而 profile 里装着的还是旧版。用 `pluginVersion()` 当「本机版本」，
   * 面板会显示「已是最新」，用户却明明没升级——**假报「已是最新」比报错更糟**，
   * 因为它让人以为没事，不会去查。
   */
  const lv = localVersion()
  assert.ok(typeof lv.version === 'string' && lv.version !== '', 'localVersion 要给出一个版本号')
  assert.ok(lv.source === 'profile' || lv.source === 'running', `来源只能是 profile 或 running，实际 ${lv.source}`)
  // 造一个假 profile，里面装着一个**特定版本**，看它读不读得到。
  const fakeProfileDir = mkdtempSync(join(tmpdir(), 'puzzle-ver-'))
  mkdirSync(join(fakeProfileDir, 'node_modules', 'dsh-puzzle-mode'), { recursive: true })
  writeFileSync(
    join(fakeProfileDir, 'node_modules', 'dsh-puzzle-mode', 'package.json'),
    JSON.stringify({ name: 'dsh-puzzle-mode', version: '7.7.7-from-profile' }) + '\n',
  )
  assert.equal(installedVersionOf(fakeProfileDir), '7.7.7-from-profile',
    'installedVersionOf 要读 **profile 里装的**那份，而不是当前跑着的代码')
  assert.equal(installedVersionOf(join(fakeProfileDir, '不存在')), '', 'profile 里没装 → 空串（不编一个版本）')
  assert.equal(installedVersionOf(''), '', '空路径安全')
  rmSync(fakeProfileDir, { recursive: true, force: true })
  ok(`本机版本读 profile 里装的那份（当前 ${lv.version}，来源 ${lv.source}）`)

  console.log(`\n自动更新： ${passed} 通过 / 0 失败`)} finally {
  rmSync(root, { recursive: true, force: true })
}
