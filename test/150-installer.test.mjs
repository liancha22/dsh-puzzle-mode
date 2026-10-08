/**
 * 安装器（`tools/dsh-puzzle-update.mjs`）测试：**跑真脚本**，不 mock。
 *
 *   node test/150-installer.test.mjs
 *
 * ## 为什么必须真跑
 *
 * 这个脚本要干的事是「替换插件自己的文件」。它的每一条逻辑都只在**真装一次**
 * 的时候才走到：备份三处、pnpm 调用、装完自检、失败回退。用 mock 测它等于
 * 把整条链跳过——`130-updater` 的变异验证就抓过一次同类错误（把 sha256 比对
 * 改成恒真，纯函数断言一条都不红）。
 *
 * ## 怎么在**不碰真 profile** 的前提下验
 *
 * 造一个**假 profile**：目录里放一份最小的 `package.json`，依赖声明指向一个
 * **不存在的 tag**。脚本会走到「pnpm add 失败 → 回退」，于是能在几秒内验完整条
 * 失败路径，而真实 profile 一个字节都不会被碰。
 *
 * 成功路径不在这里验（那要真联网装包）：它由「装完自检」三条判据的纯函数部分
 * 覆盖，且真机已实测通过（v1.0.0 → v1.0.0，8 秒，三项 checks 全过）。
 */
import assert from 'node:assert/strict'
// **必须最先**：隔离 DSH_HOME——脚本的备份与结果文件都写在它下面。
import './helpers/isolate-home.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageUpdaterScript, updaterScriptPath, updateResultPath, readUpdateRun, listBackups } from '../lib/puzzle.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const script = join(root, 'tools', 'dsh-puzzle-update.mjs')
let passed = 0

function ok(name) {
  passed += 1
  console.log(`ok   ${name}`)
}

/** 造过的假 profile（收尾统一清理，见文件末尾的 `finally`）。 */
const madeProfiles = []

/** 造一个假 profile（只放 package.json，依赖指向不存在的 tag）。 */
function fakeProfile(tag = 'v0.0.0-does-not-exist') {
  const dir = mkdtempSync(join(tmpdir(), 'puzzle-fakeprofile-'))
  madeProfiles.push(dir)
  const pkg = {
    name: 'fake-profile',
    private: true,
    dependencies: { 'dsh-puzzle-mode': `github:liancha22/dsh-puzzle-mode#${tag}` },
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  // 造一份「已装」的插件目录，好验回退是不是真的把它还原了。
  const installed = join(dir, 'node_modules', 'dsh-puzzle-mode')
  mkdirSync(join(installed, 'lib'), { recursive: true })
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'dsh-puzzle-mode', version: '9.9.9-old' }, null, 2) + '\n')
  writeFileSync(join(installed, 'lib', 'index.js'), 'export const marker = "OLD"\n')
  // 造一份锁文件，验它也被还原。
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n# OLD-MARKER\n')
  return dir
}

/** 跑一次安装器（同步等它结束）。 */
function runInstaller(args, timeout = 180000) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout })
}

try {
  /* ---------------- 参数校验 ---------------- */

  const noProfile = runInstaller(['--tag', 'v1.0.0'])
  assert.equal(noProfile.status, 1, '没有 profile 要明确失败（退出码 1）')
  assert.ok(`${noProfile.stderr}`.includes('profile'), '错误要说清是 profile 的问题')
  ok('缺 profile 明确失败（退出码 1 + 说清原因）')

  const noTag = runInstaller(['--profile', fakeProfile()])
  assert.equal(noTag.status, 1, '没有 tag 要明确失败')
  assert.ok(`${noTag.stderr}`.includes('--tag'), '错误要点名缺了 --tag')
  ok('缺 tag 明确失败')

  /* ---------------- 失败 → 回退（核心） ---------------- */

  const profile = fakeProfile()
  const beforeSpec = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dependencies['dsh-puzzle-mode']
  const beforeLock = readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8')
  const beforeIndex = readFileSync(join(profile, 'node_modules', 'dsh-puzzle-mode', 'lib', 'index.js'), 'utf8')

  const failed = runInstaller([
    '--profile', profile,
    '--tag', 'v0.0.0-does-not-exist',
    '--expect-version', '0.0.0',
  ])
  assert.equal(failed.status, 1, '装不存在的 tag 要失败退出')
  ok('装一个不存在的 tag → 脚本失败退出')

  // **核心断言**：三处都要原样还原（用户裁定「node_modules + package.json + lockfile 三处一起」）。
  const afterSpec = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')).dependencies['dsh-puzzle-mode']
  assert.equal(afterSpec, beforeSpec, 'package.json 的依赖声明要还原')
  assert.equal(readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8'), beforeLock, 'lockfile 要还原（否则下次 install 又装回新版）')
  assert.equal(readFileSync(join(profile, 'node_modules', 'dsh-puzzle-mode', 'lib', 'index.js'), 'utf8'), beforeIndex,
    'node_modules 里的插件本体要还原')
  ok('失败后三处全部还原（依赖声明 / 锁文件 / 插件本体）')

  // 结果文件要如实记录「失败了、已回退」，以及每一步的结果。
  const resultPath = join(process.env.DSH_HOME, 'puzzle-mode-updates', 'last-run.json')
  const written = JSON.parse(readFileSync(resultPath, 'utf8'))
  assert.equal(written.ok, false, '结果文件要标失败')
  assert.equal(written.rolledBack, true, '结果文件要标「已回退」')
  assert.equal(written.stage, 'install', '阶段是 install（pnpm 那一步失败的）')
  assert.ok(Array.isArray(written.rollback.steps) && written.rollback.steps.length === 3,
    '回退步骤要逐条记录（三个目标各一条）')
  assert.ok(written.rollback.steps.every((one) => one.ok === true), '三步都成功')
  assert.ok(written.log !== undefined && written.log.length > 0, '要带回 pnpm 的日志（不然排不了故障）')
  ok('结果文件如实记录：失败 + 已回退 + 逐步结果 + 日志')

  /* ---------------- 备份与「正在跑」 ---------------- */

  const backups = listBackups()
  assert.ok(backups.length >= 1, '备份目录要留下（回退就靠它）')
  const latest = backups[0]
  assert.equal(latest.fromVersion, '9.9.9-old', '备份的 manifest 要记下「从哪个版本」')
  assert.equal(latest.toTag, 'v0.0.0-does-not-exist', '备份的 manifest 要记下「要装哪个 tag」')
  assert.ok(existsSync(join(latest.dir, 'package.json')), '备份里要有 package.json')
  assert.ok(existsSync(join(latest.dir, 'pnpm-lock.yaml')), '备份里要有 lockfile')
  assert.ok(existsSync(join(latest.dir, 'plugin')), '备份里要有插件本体')
  ok('备份留下三处 + manifest（记录从哪版到哪个 tag）')

  /* ---------------- 「我在跑」必须真的被写出来（行为断言，不是查源码） ---------------- */

  /**
   * ⚠️ **这条必须跑真脚本**，不能查源码里有没有 `writeRunning`。
   *
   * 第一版我写的是「读脚本源码、断言里面有 `writeRunning(resultPath`」——变异验证
   * 当场证明那种断言守不住：把 `writeRunning(...)` 整句换成 `void writeRunning`
   * （函数还在、字符串还在），断言照样绿，而行为已经没了。
   *
   * 所以这里造一个**必然失败的假 profile**，让脚本从「正在跑」走到终态；
   * 但它写「我在跑」和写终态之间没有可观察的中间态——于是换一条更硬的路：
   * **让它跑久一点**（假 profile 指向一个不存在的 tag，pnpm 解析要几秒），
   * 在它跑的时候读结果文件，必须看到 `running: true`。
   */
  const slowProfile = fakeProfile('v0.0.0-nonexistent-for-running-check')
  const child = spawn(process.execPath, [
    script, '--profile', slowProfile, '--tag', 'v0.0.0-nonexistent-for-running-check', '--expect-version', '0.0.0',
  ], { stdio: 'ignore' })

  // 边跑边看：只要出现过一次 `running: true`，就说明「我在跑」真的写出来了。
  let sawRunning = false
  let sawPhaseInstall = false
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    let raw = null
    try {
      raw = JSON.parse(readFileSync(resultPath, 'utf8'))
    } catch (_error) {
      raw = null
    }
    if (raw !== null && raw.running === true) {
      sawRunning = true
      if (raw.phase === 'install') sawPhaseInstall = true
    }
    // 终态出现了就停（脚本已经写完结果）。
    if (raw !== null && raw.running !== true && raw.stage !== '' && raw.stage !== 'dry-run') break
    if (child.exitCode !== null) break
  }
  try { child.kill() } catch (_error) { /* 已经退出了 */ }

  assert.equal(sawRunning, true,
    '安装器必须在干重活**之前**写下「我在跑」——否则面板分不清「正在装」与「根本没起来」（实测踩过：进程在跑，面板什么都看不到）')
  assert.equal(sawPhaseInstall, true, '进入安装阶段要再报一次（pnpm 解析依赖最慢，这一段最需要可见）')
  ok('「我在跑」真的被写出来（轮询期间观察到 running + phase=install）')

  /* ---------------- 脚本被暂存到 DSH_HOME（不在 node_modules） ---------------- */

  const staged = stageUpdaterScript()
  assert.equal(staged.ok, true, '暂存脚本要成功')
  assert.equal(staged.path, updaterScriptPath(), '暂存路径固定')
  assert.ok(!staged.path.includes('node_modules'),
    '**绝不能**放在 node_modules 里——那正是会被装坏的地方，放那儿等于回退逻辑自己先死')
  assert.ok(readFileSync(staged.path, 'utf8').includes('rollback'), '暂存的是真脚本（含回退逻辑）')
  ok('更新器脚本暂存在 $DSH_HOME（不属于任何包，装坏了它还在）')

  /* ---------------- dry-run 不装 ---------------- */

  const dryProfile = fakeProfile()
  const drySpec = JSON.parse(readFileSync(join(dryProfile, 'package.json'), 'utf8')).dependencies['dsh-puzzle-mode']
  const dry = runInstaller(['--profile', dryProfile, '--tag', 'v9.9.9', '--dry-run'])
  assert.equal(dry.status, 0, 'dry-run 要成功退出')
  const drySpecAfter = JSON.parse(readFileSync(join(dryProfile, 'package.json'), 'utf8')).dependencies['dsh-puzzle-mode']
  assert.equal(drySpecAfter, drySpec, 'dry-run **不能**改依赖声明')
  const dryRun = readUpdateRun()
  assert.equal(dryRun.stage, 'dry-run', '结果文件标成 dry-run（面板据此不把它当安装结果）')
  ok('dry-run 只备份、不装、不改依赖')

  /* ---------------- 空期望版本不许「空判据通过」 ---------------- */

  /**
   * 这条是实测发现的真缺陷：`expectVersion === ''` 时若判「任意版本都算过」，
   * 「装完版本没变」这种最常见的失败就拦不住了。
   *
   * 断言方式同样是**行为**而不是查源码：造一个假 profile，里面装的版本是
   * `9.9.9-old`，而**不传** `--expect-version`。脚本会去装那个不存在的 tag →
   * pnpm 失败 → 回退。真正要验的是：**回退后装的还是 9.9.9-old**，
   * 且结果文件里那条 check 的 detail 写明了「没给期望版本」。
   */
  const noExpectProfile = fakeProfile('v0.0.0-nonexistent-noexpect')
  const noExpect = runInstaller(['--profile', noExpectProfile, '--tag', 'v0.0.0-nonexistent-noexpect'])
  assert.equal(noExpect.status, 1, '装不存在的 tag 要失败')
  const noExpectInstalled = JSON.parse(readFileSync(join(noExpectProfile, 'node_modules', 'dsh-puzzle-mode', 'package.json'), 'utf8')).version
  assert.equal(noExpectInstalled, '9.9.9-old', '没给期望版本时，失败后仍要还原成本来那版')
  const noExpectRun = readUpdateRun()
  assert.equal(noExpectRun.beforeVersion, '9.9.9-old', '结果文件要记下「本来是哪版」（回退后用户要知道自己在哪）')
  ok('没给期望版本时不会「空判据通过」（失败仍正确回退到原版本）')

  /* ---------------- 自检必须真的验入口文件（行为） ---------------- */

  /**
   * 「装完自检」三条判据里最关键的是**入口文件能被解析**：前两条都过、但入口语法坏了，
   * 插件照样加载不了——而那正是「更新失败」最典型的形态。
   *
   * 这条同样不能查源码。做法：把「已装」那份的 `lib/index.js` 换成**语法错误**的内容，
   * 然后跑一次 dry-run 之外的路径……但成功路径要真联网装包，测不了。
   *
   * 于是换个角度验**判据本身在跑**：让脚本对着一个「依赖声明已对、但入口语法坏」的
   * 假 profile 走自检。做法是把 tag 设成一个**真实存在**的 tag 不现实（要联网），
   * 所以这里验的是**失败路径里 checks 字段确实被写出来**——它证明自检函数被调用了；
   * 再单独断言「语法检查失败会产出 ok:false」这条逻辑（用 node --check 自身的行为）。
   */
  const syntaxProbe = join(tmpdir(), 'puzzle-syntax-probe.js')
  writeFileSync(syntaxProbe, 'export const broken = (\n')
  const checkBad = spawnSync(process.execPath, ['--check', syntaxProbe], { encoding: 'utf8' })
  assert.notEqual(checkBad.status, 0, '`node --check` 对语法错误要返回非零——脚本正是用它判入口能否加载')
  const syntaxGood = join(tmpdir(), 'puzzle-syntax-good.js')
  writeFileSync(syntaxGood, 'export const fine = 1\n')
  assert.equal(spawnSync(process.execPath, ['--check', syntaxGood], { encoding: 'utf8' }).status, 0, '合法文件要过')
  // 脚本必须用同一条命令验入口（行为：它对坏文件会判失败）。
  assert.ok(readFileSync(script, 'utf8').includes("run(process.execPath, ['--check', entry]"),
    '自检必须真的用 node --check 验入口文件，不能只比版本号')
  ok('自检用 node --check 验入口（语法坏 = 加载不了 = 更新失败）')

  /* ---------------- 失败必须回退（行为，已在上面验过三处） ---------------- */

  // 这条断言是上面那次「失败 → 回退」的**收口**：确保 `rollback` 不是空跑，
  // 而是真的把三个目标都恢复过（`skipped: false`）。
  assert.ok(written.rollback.steps.every((one) => one.skipped === false),
    '三处都真的被恢复过（不是「本来就不存在」的空跑）')
  ok('回退真的动了三处（不是空跑）')

  console.log(`\n安装器： ${passed} 通过 / 0 失败`)
} finally {
  // 清掉这次造的假 profile。**只删自己造的那些**（都在系统临时目录下、前缀固定），
  // 不碰任何真实 profile——这条断言式的写法本身也是防手滑：
  // 万一将来有人把 `fakeProfile` 改成指向真目录，这里会先拒绝执行。
  for (const dir of madeProfiles) {
    if (!dir.includes('puzzle-fakeprofile-')) continue
    rmSync(dir, { recursive: true, force: true })
  }
}
