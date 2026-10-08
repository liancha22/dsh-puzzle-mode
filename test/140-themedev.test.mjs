/**
 * 主题开发与分享测试：脚手架 / 主题包往返 / 上传链。
 *
 *   node test/140-themedev.test.mjs
 *
 * ## 为什么要有这一组
 *
 * 用户三条需求落在这里：「一键进入自主开发主题」「一键上传」，以及追加的
 * 「**上传是让别人能够分享自己做的主题风格**」→ 于是还有第二条分享路
 * 「导出单文件主题包 + 一键导入」。
 *
 * 三件事各有必须钉死的点：
 *
 *   1. **脚手架不许覆盖已有文件**——作者可能已经改了一半，覆盖等于把他的工作删了；
 *   2. **主题包要能往返**——导出再导入必须得到同一份 CSS，否则分享就是坏的；
 *   3. **上传前必须用插件自己的尺子量**——推上去的坏主题会让**所有**用户装不上，
 *      比本地报错严重得多。
 */
import assert from 'node:assert/strict'
// **必须最先**：隔离 DSH_HOME（主题状态与缓存都在那下面）。
import './helpers/isolate-home.mjs'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_PACK_BYTES,
  THEME_PACK_EXT,
  THEME_PACK_VERSION,
  THEME_REPO_DIRNAME,
  THEME_TOKENS,
  createThemeScaffold,
  cssTemplate,
  exportThemePack,
  findThemeRepo,
  importThemePack,
  isThemeRepo,
  manifestTemplate,
  parseGitStatus,
  readRepoTheme,
  rebuildThemeIndex,
  repoThermIds,
  themeDevPrompt,
  themeIdOf,
  uploadTheme,
  validateThemePack,
  writeRepoTheme,
  writeThemePack,
} from '../lib/puzzle.js'
import { validateThemeCss } from '../lib/themes.js'

const root = mkdtempSync(join(tmpdir(), 'puzzle-themedev-'))
let passed = 0

function ok(name) {
  passed += 1
  console.log(`ok   ${name}`)
}

/** 一份合法的最小主题 CSS（声明了 --dshpz-* 变量、选择器只碰插件自己的类）。 */
const GOOD_CSS = [
  ':root {',
  '  --dshpz-accent: #123456;',
  '}',
  '.dshpz-tlogo { color: var(--dshpz-accent); }',
  '',
].join('\n')

try {
  /* ---------------- 主题 id 规范化 ---------------- */

  assert.equal(themeIdOf('My Theme'), 'my-theme', '空格转连字符、转小写')
  assert.equal(themeIdOf('my_theme'), 'my-theme', '下划线转连字符')
  assert.equal(themeIdOf('  Deep.Sea  '), 'deep.sea', '去空白、保留点')
  assert.equal(themeIdOf('9lives'), '9lives', '数字开头合法')
  assert.equal(themeIdOf('-bad'), 'bad', '前导连字符被剔掉')
  // 中文名规范化后为空 → 返回空串让调用方报错，**不硬凑一个 id**
  // （硬凑会建出 `theme-1` 这类用户看不懂的目录名）。
  assert.equal(themeIdOf('我的主题'), '', '全中文 → 空串（不硬凑 id）')
  assert.equal(themeIdOf(''), '', '空串安全')
  assert.equal(themeIdOf(null), '', '非字符串安全')
  assert.equal(themeIdOf('A'.repeat(200)).length <= 64, true, '超长要截断到 64')
  ok('主题 id 规范化（空格 / 下划线 / 大小写 / 超长 / 不硬凑）')

  /* ---------------- 脚手架 ---------------- */

  const ws = join(root, '工作区')
  mkdirSync(ws, { recursive: true })

  const scaffold = createThemeScaffold(ws, '我的皮肤 My Skin', { name: '我的皮肤', author: '测试者' })
  assert.equal(scaffold.ok, true, '脚手架要建得出来')
  assert.equal(scaffold.id, 'my-skin', 'id 被规范化')
  assert.equal(existsSync(scaffold.manifestPath), true, 'manifest.json 要建出来')
  assert.equal(existsSync(scaffold.cssPath), true, 'theme.css 要建出来')
  assert.equal(scaffold.created.length, 2, '两个文件都是新建的')
  assert.equal(scaffold.isNew, true, '首次是新建')
  ok('脚手架：一次建出 manifest.json + theme.css')

  // 模板本身必须**过插件自己的校验**——不然作者第一步就拿到一个装不上的模板。
  const templateCss = cssTemplate('my-skin', '我的皮肤')
  const templateValid = validateThemeCss(templateCss)
  assert.equal(templateValid.ok, true, `脚手架模板必须通过插件自己的白名单校验：${templateValid.ok === true ? '' : templateValid.error}`)
  // 模板要能立刻看出效果（至少声明一个变量），否则用户会以为功能坏了。
  assert.ok(/--dshpz-[a-z0-9-]+\s*:/.test(templateCss), '模板要声明 --dshpz-* 变量（装上去立刻有变化）')
  /**
   * 模板只覆盖**视觉核心**令牌（颜色 / 发光 / 圆角 / 动效）——字体栈与缓动曲线
   * 不放进模板，是因为改它们会让面板和宿主界面明显不一致，不该是默认值。
   * **全部**令牌列在开发提示词里（下面单独断言），作者要改别的照着挑。
   */
  for (const token of ['accent', 'accent-hi', 'accent-lo', 'on-accent', 'glow', 'shadow', 'radius-md']) {
    assert.ok(templateCss.includes(`--dshpz-${token}`), `模板该给出核心令牌 ${token}`)
  }
  ok('模板通过插件白名单校验，且给出视觉核心令牌')

  const manifest = JSON.parse(readFileSync(scaffold.manifestPath, 'utf8'))
  assert.equal(manifest.name, '我的皮肤', 'manifest 里放用户给的原名（可以是中文）')
  assert.equal(manifest.author, '测试者', '作者写进去')
  assert.equal(manifest.version, '1.0.0', '初始版本号')
  assert.equal(manifestTemplate('x', 'y').includes('"accent"'), true, 'manifest 模板带 accent（主题列表的色块）')
  ok('manifest 模板（原名 / 作者 / 版本 / accent）')

  // **核心断言**：已存在的文件不许被覆盖——覆盖等于把作者的工作删了。
  const customCss = GOOD_CSS + '/* 作者自己改过的 */\n'
  writeFileSync(scaffold.cssPath, customCss, 'utf8')
  const second = createThemeScaffold(ws, 'my-skin', { name: '我的皮肤' })
  assert.equal(second.ok, true, '重复建脚手架不该失败')
  assert.equal(readFileSync(scaffold.cssPath, 'utf8'), customCss, '已存在的 theme.css 一个字都不许改')
  assert.equal(second.created.length, 0, '没有文件被重新创建')
  assert.equal(second.skipped.length, 2, '两个文件都跳过')
  assert.equal(second.isNew, false, '不是新建（面板据此说「已就绪」而不是「已创建」）')
  ok('脚手架不覆盖已有文件（作者的工作不会被删）')

  // 非法 id 要明确失败。
  assert.equal(createThemeScaffold(ws, '我的主题').ok, false, '全中文 id 明确失败')
  assert.equal(createThemeScaffold('', 'x').ok, false, '拿不到工作区时明确失败')
  ok('非法 id / 空工作区明确失败（不静默）')

  /* ---------------- 开发提示词 ---------------- */

  const prompt = themeDevPrompt('my-skin', { repoPath: '/repo' })
  assert.ok(prompt.includes('my-skin'), '提示词点名主题 id')
  assert.ok(prompt.includes('/repo/themes/my-skin'), '提示词给出目录')
  assert.ok(prompt.includes('@import'), '提示词写明禁止项')
  assert.ok(prompt.includes('build-index'), '提示词给出重算清单的命令')
  assert.ok(prompt.includes('verify:themes'), '提示词给出验收命令')
  // **全部令牌**列在提示词里：作者要改字体/缓动这类模板没给的令牌，得有地方查。
  for (const token of THEME_TOKENS) {
    assert.ok(prompt.includes(`--dshpz-${token}`), `提示词该列出令牌 ${token}`)
  }
  ok(`开发提示词：目录 + ${THEME_TOKENS.length} 个令牌 + 禁止项 + 验收命令`)

  /* ---------------- 主题包：导出 / 导入往返 ---------------- */

  assert.equal(THEME_PACK_VERSION, 1, '主题包格式版本')
  assert.ok(THEME_PACK_EXT.endsWith('.json'), '主题包是 JSON 文本（可粘贴分享，不是二进制）')

  const pack = exportThemePack({ id: 'my-skin', name: '我的皮肤', author: '测试者', description: '描述', version: '2.1.0', accent: '#abcdef', css: GOOD_CSS })
  assert.equal(pack.ok, true, '导出要成功')
  assert.ok(pack.text.includes('dshpz-theme-pack'), '包里有 kind 标记')
  assert.equal(pack.filename, 'my-skin' + THEME_PACK_EXT, '文件名带 id 与后缀')
  // 导出时**现算** sha256：抄状态文件里的旧值会让导入端判成「被改过」。
  assert.equal(pack.sha256.length, 64, '包里带现算的 sha256')
  ok('导出主题包（kind 标记 / 文件名 / 现算 sha256）')

  // **核心断言**：往返必须一致。
  const back = importThemePack(pack.text)
  assert.equal(back.ok, true, '导入自己导出的包要成功')
  assert.equal(back.id, 'my-skin', 'id 往返一致')
  assert.equal(back.css, GOOD_CSS, 'CSS 往返逐字一致')
  assert.equal(back.manifest.name, '我的皮肤', 'manifest 往返一致')
  assert.equal(back.manifest.version, '2.1.0', '版本往返一致')
  ok('主题包往返：导出 → 导入，CSS 与元信息逐字一致')

  // 坏包的各种形状都要明确拒。
  assert.equal(importThemePack('').ok, false, '空内容要拒')
  assert.equal(importThemePack('{').ok, false, '坏 JSON 要拒')
  assert.equal(importThemePack('{}').ok, false, '缺 kind 要拒')
  assert.equal(importThemePack(JSON.stringify({ kind: 'dshpz-theme-pack', packVersion: 99, id: 'a', css: GOOD_CSS })).ok, false, '版本不认要拒')
  assert.equal(validateThemePack(null).ok, false, '非对象要拒')
  /**
   * id 走**规范化**而不是直接拒（与 `createThemeScaffold` 同一套行为）。
   *
   * 为什么不拒：id 只当**文件名**用，规范化之后一定安全；而「把 `My Theme` 规范化成
   * `my-theme`」正是用户期待的行为——手写一个包的人不该因为多打了个空格就被拒。
   * 规范化后仍非法（比如全中文）才拒，见下一条。
   */
  const looseId = validateThemePack({ kind: 'dshpz-theme-pack', packVersion: 1, id: 'My Theme', css: GOOD_CSS })
  assert.equal(looseId.ok, true, '可规范化的 id 要接受')
  assert.equal(looseId.id, 'my-theme', '接受的同时把 id 规范化（回传的是规范后的）')
  // 规范化之后仍然非法 → 明确拒（不硬凑一个 id）。
  assert.equal(validateThemePack({ kind: 'dshpz-theme-pack', packVersion: 1, id: '我的主题', css: GOOD_CSS }).ok, false,
    '规范化后仍非法的 id（全中文）要拒')
  // 包里的 CSS 必须过**同一把尺子**：导入端放半个坏包进来，用户会得到一个装不上的主题。
  assert.equal(importThemePack(JSON.stringify({
    kind: 'dshpz-theme-pack', packVersion: 1, id: 'evil', css: ':root{--dshpz-a:1}\n@import url(http://evil.com/x.css);',
  })).ok, false, '包里的 CSS 含 @import 要拒')
  ok('坏包一律明确拒绝（空 / 坏 JSON / 缺标记 / 版本不符 / 坏 id / 坏 CSS）')

  // **防篡改**：包里带 sha256 就一定要对。
  const tampered = JSON.parse(pack.text)
  tampered.css = GOOD_CSS + '\n.dshpz-x{color:red}'
  const tamperResult = importThemePack(JSON.stringify(tampered))
  assert.equal(tamperResult.ok, false, '改了内容但没改 hash → 必须拒')
  assert.ok(tamperResult.error.includes('sha256'), '错误要说清是 hash 不符')
  ok('主题包防篡改：内容被改过就拒绝导入')

  // 超大包要拒（体积上限防的是「把内存吃光」）。
  const huge = JSON.stringify({ kind: 'dshpz-theme-pack', packVersion: 1, id: 'huge', css: ':root{--dshpz-a:1}' + 'x'.repeat(MAX_PACK_BYTES) })
  assert.equal(importThemePack(huge).ok, false, '超过上限的包要拒')
  ok(`超过 ${MAX_PACK_BYTES} 字节的包被拒`)

  // 落盘导出：写到工作区的 themes-out/，面板给路径。
  const written = writeThemePack(ws, pack)
  assert.equal(written.ok, true, '导出落盘要成功')
  assert.equal(existsSync(written.path), true, '文件真的在盘上')
  assert.equal(readFileSync(written.path, 'utf8'), pack.text, '落盘内容与返回的文本一致')
  assert.equal(writeThemePack('', pack).ok, false, '拿不到工作区时明确失败')
  ok('主题包落盘（内容与返回文本一致）')

  /* ---------------- 主题仓库：清单重算 ---------------- */

  /**
   * 仓库路径要**单独取**：前面 `createThemeScaffold` 已经在这个工作区下
   * 建过 `dsh-puzzle-themes/`（带 themes/ 目录），所以 `ws` 下那一个**早就是**
   * 主题仓库了。想验「还没建时不是仓库」，得用一个干净父目录。
   */
  const repoParent = join(root, '仓库父目录')
  mkdirSync(repoParent, { recursive: true })
  const repo = join(repoParent, THEME_REPO_DIRNAME)
  assert.equal(isThemeRepo(repo), false, '还没建时不是主题仓库')

  const made = writeRepoTheme(repo, 'alpha', GOOD_CSS, { name: '甲主题', author: '我', version: '1.0.0', accent: '#111111' })
  assert.equal(made.ok, true, '往仓库写主题要成功')
  assert.equal(isThemeRepo(repo), true, '有 themes/ 之后就是主题仓库了')
  writeRepoTheme(repo, 'beta', GOOD_CSS.replace('#123456', '#654321'), { name: '乙主题' })
  ok('往主题仓库写主题（目录与文件自动建）')

  // 写进去的 CSS 必须过校验——坏 CSS 不许落盘。
  assert.equal(writeRepoTheme(repo, 'bad', '@import url(http://x);', {}).ok, false, '坏 CSS 拒绝写入仓库')
  ok('坏 CSS 拒绝写进主题仓库')

  const rebuilt = rebuildThemeIndex(repo)
  assert.equal(rebuilt.ok, true, `重算清单要成功：${rebuilt.ok === true ? '' : JSON.stringify(rebuilt.problems)}`)
  assert.equal(rebuilt.count, 2, '两套主题都进清单')
  assert.equal(rebuilt.changed, true, '首次重算有变化')
  const index = JSON.parse(readFileSync(join(repo, 'index.json'), 'utf8'))
  assert.equal(index.apiVersion, 1, '清单带 apiVersion（插件只认自己支持的那档）')
  assert.equal(index.themes.length, 2, '清单里两套')
  // sha256 必须由脚本**现算**——手写就意味着「改完 CSS 忘了更新 hash」，
  // 而那个后果不是报错，是所有用户都装不上。
  const alpha = index.themes.find((theme) => theme.id === 'alpha')
  assert.equal(alpha.sha256.length, 64, '清单里的 sha256 是现算的')
  assert.equal(alpha.sha256, (await import('node:crypto')).createHash('sha256').update(GOOD_CSS, 'utf8').digest('hex'),
    'sha256 与 CSS 内容一致')
  assert.equal(alpha.file, 'themes/alpha/theme.css', '清单指向正确的文件')
  assert.equal(alpha.name, '甲主题', 'manifest 的 name 进了清单')
  // 幂等：同样的内容重算两次，第二次不该有变化。
  const again = rebuildThemeIndex(repo)
  assert.equal(again.changed, false, '内容没变时重算不该改文件（幂等）')
  ok('重算清单（apiVersion / 现算 sha256 / 幂等）')

  assert.deepEqual(repoThermIds(repo), ['alpha', 'beta'], '列出仓库里的主题 id')
  const read = readRepoTheme(repo, 'alpha')
  assert.equal(read.ok, true, '读仓库里的主题')
  assert.equal(read.css, GOOD_CSS, 'CSS 读得对')
  assert.equal(read.name, '甲主题', 'manifest 读得对')
  ok('读仓库里的主题（CSS + manifest）')

  // 仓库里有坏主题时，重算要**整体失败并列出问题**，不许写半份清单。
  writeRepoTheme(repo, 'gamma', GOOD_CSS, { name: '丙' })
  writeFileSync(join(repo, 'themes', 'gamma', 'theme.css'), '@import url(http://evil);', 'utf8')
  const broken = rebuildThemeIndex(repo)
  assert.equal(broken.ok, false, '仓库里有坏主题时重算要失败')
  assert.ok(Array.isArray(broken.problems) && broken.problems.length > 0, '要列出问题')
  assert.ok(broken.problems.some((one) => one.includes('gamma')), '问题要点名是哪个主题')
  ok('仓库里有坏主题 → 整体失败并点名（不写半份清单）')

  /* ---------------- 找主题仓库 ---------------- */

  assert.equal(findThemeRepo(ws), join(ws, THEME_REPO_DIRNAME), '工作区下直接找到主题仓库（脚手架建的那个）')
  assert.equal(findThemeRepo(repoParent), repo, '仓库父目录下也找得到')
  const wrapped = join(root, '包装', '内层')
  mkdirSync(join(wrapped, THEME_REPO_DIRNAME, 'themes'), { recursive: true })
  assert.equal(findThemeRepo(wrapped), join(wrapped, THEME_REPO_DIRNAME), '一层包装目录里也找得到')
  // **找不到就返回空串，不猜**：猜错的后果是往不相干的仓库推主题。
  assert.equal(findThemeRepo(join(root, '空工作区')), '', '找不到时返回空串（不猜路径）')
  assert.equal(findThemeRepo(''), '', '空工作区安全')
  ok('找主题仓库（直接 / 一层包装 / 找不到就返回空串不猜）')

  /* ---------------- git 状态解析 ---------------- */

  const status = parseGitStatus(' M lib/a.js\n?? themes/new/theme.css\nA  added.js\n')
  assert.equal(status.length, 3, '三个改动')
  assert.equal(status[0].status, 'M', '已修改')
  assert.equal(status[0].path, 'lib/a.js', '路径读对')
  assert.equal(status[1].status, '??', '未跟踪')
  assert.equal(parseGitStatus('').length, 0, '空输出 → 空数组')
  assert.equal(parseGitStatus(null).length, 0, '非字符串安全')
  ok('git status 解析（M / ?? / A / 空）')

  /* ---------------- 上传链：不碰网络也要能验的部分 ---------------- */

  // 上传前的校验必须**真的拦住坏 CSS**——推上去的坏主题会让所有用户装不上。
  writeRepoTheme(repo, 'delta', GOOD_CSS, { name: '丁' })
  writeFileSync(join(repo, 'themes', 'delta', 'theme.css'), ':root{--dshpz-a:1}\n@import url(http://evil.com/x.css);', 'utf8')
  const blocked = uploadTheme(repo, 'delta')
  assert.equal(blocked.ok, false, '坏 CSS 必须拒绝上传')
  assert.ok(blocked.error.includes('安全校验'), '错误要说清是安全校验没过')
  ok('上传前拦住坏 CSS（不让坏主题推到仓库）')

  // 主题不存在 → 明确失败并指路。
  const missing = uploadTheme(repo, 'nonexistent')
  assert.equal(missing.ok, false, '不存在的主题要失败')
  assert.ok(missing.hint !== undefined, '要给出下一步该做什么')
  // 目录不像主题仓库 → 明确失败（不猜、不硬推）。
  assert.equal(uploadTheme(join(root, '不是仓库'), 'alpha').ok, false, '不是主题仓库时明确失败')
  assert.equal(uploadTheme('', 'alpha').ok, false, '空路径明确失败')
  assert.equal(uploadTheme(repo, 'BAD ID').ok, false, '非法 id 明确失败')
  ok('上传的失败路径都说得清（坏 CSS / 不存在 / 不是仓库 / 非法 id）')

  console.log(`\n主题开发与分享： ${passed} 通过 / 0 失败`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
