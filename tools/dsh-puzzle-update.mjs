#!/usr/bin/env node
/**
 * 独立更新器：装新版，**失败就整体回退**。
 *
 *   node dsh-puzzle-update.mjs --profile <profile目录> --tag vX.Y.Z [--expect-version X.Y.Z]
 *                              [--result <结果json路径>] [--pnpm <pnpm.cjs路径>]
 *
 * ## 为什么必须是一个**独立进程 + 独立文件**
 *
 * 这个脚本要干的事是「替换插件自己的文件」。如果它住在插件目录里，就会出现一个
 * 无法自救的死局：装到一半 `node_modules/dsh-puzzle-mode` 被写坏 → **脚本自己也跟着没了**
 * → 回退逻辑不复存在，用户只剩手改 `package.json`。
 *
 * 所以插件在启动它之前，会先把本文件**复制到 `$DSH_HOME/puzzle-mode-updates/` 下**再执行。
 * 那个位置不属于任何包，装什么都不会动它。
 *
 * ## 回退恢复三处（用户裁定）
 *
 *   1. `node_modules/dsh-puzzle-mode/`（插件本体）
 *   2. `package.json` 里的依赖声明
 *   3. `pnpm-lock.yaml`（锁文件）
 *
 * 只恢复第 1 处是不够的：`package.json` 还指着新版，下次任何一次 `pnpm install`
 * 都会把坏版本再装回来——那种「修好了又自己坏掉」最难查。
 *
 * ## 判定「装成功」的三条（缺一不可）
 *
 *   - `package.json` 的依赖声明里出现了这次要装的 tag；
 *   - `node_modules/dsh-puzzle-mode/package.json` 的 version 等于期望版本；
 *   - 装上的那份 `lib/index.js` 能被 `node --check` 解析（语法没过 = 加载不了 = 插件消失）。
 *
 * 第三条是关键：前两条都过、但入口文件语法坏了，插件照样加载不了，
 * 而那正是「更新失败」最典型的形态。
 *
 * 本文件**只用 Node 内置模块**：它要在一个可能已经半坏的 profile 里运行，
 * 任何第三方依赖都可能正好是坏掉的那一个。
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 本插件的包名。 */
const PACKAGE_NAME = 'dsh-puzzle-mode'

/** pnpm 命令的超时：装包要联网，给足 5 分钟。 */
const PNPM_TIMEOUT_MS = 300000

/** 保留的备份份数：多了会把 `$DSH_HOME` 撑大，少了不够回退。 */
const KEEP_BACKUPS = 3

function parseArgs(argv) {
  const out = { profile: '', tag: '', expectVersion: '', result: '', pnpm: '', dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === '--profile') { out.profile = String(value ?? ''); i += 1 } else if (key === '--tag') { out.tag = String(value ?? ''); i += 1 } else if (key === '--expect-version') { out.expectVersion = String(value ?? ''); i += 1 } else if (key === '--result') { out.result = String(value ?? ''); i += 1 } else if (key === '--pnpm') { out.pnpm = String(value ?? ''); i += 1 } else if (key === '--dry-run') { out.dryRun = true }
  }
  return out
}

/** 时间戳：用于备份目录名与结果文件。 */
function stamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function settingsHome() {
  const env = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return env !== '' ? env : join(homedir(), '.dsh')
}

function updatesRoot() {
  return join(settingsHome(), 'puzzle-mode-updates')
}

/** 读一个 JSON 文件；坏值返回 null（**从不抛错**）。 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (_error) {
    return null
  }
}

/**
 * 找 pnpm。
 *
 * 优先用 **DSH 自带的那份**（`dsh-runtimes/<runtime>/dependencies/pnpm/bin/pnpm.cjs`）：
 * 它是这个 profile 实际使用的版本，用它装出来的锁文件格式一定对得上。
 * 退路才是 PATH 上的 `pnpm`——那可能是另一个版本，锁文件格式不同会引发全量重装。
 */
function findPnpm(explicit) {
  if (typeof explicit === 'string' && explicit !== '' && existsSync(explicit)) {
    return { kind: 'cjs', path: explicit }
  }
  const runtimes = join(settingsHome(), 'dsh-runtimes')
  let names = []
  try {
    names = readdirSync(runtimes)
  } catch (_error) {
    names = []
  }
  for (const name of names) {
    const cjs = join(runtimes, name, 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')
    if (existsSync(cjs)) return { kind: 'cjs', path: cjs }
  }
  return { kind: 'command', path: 'pnpm' }
}

/** 跑一条命令，带回 stdout / stderr / 退出码。**不抛错**。 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeout ?? PNPM_TIMEOUT_MS,
    windowsHide: true,
    // Windows 上 `pnpm` 是 .cmd，必须过 shell 才找得到。
    shell: options.shell === true,
    env: process.env,
  })
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  if (result.error !== undefined && result.error !== null) {
    const code = result.error.code
    return { ok: false, code: -1, stdout, stderr, error: code === 'ETIMEDOUT' ? '命令超时' : String(result.error.message ?? result.error) }
  }
  return { ok: result.status === 0, code: result.status, stdout, stderr, error: '' }
}

/** 把 pnpm 调用成 `(命令, 参数前缀)`，两种形态各走各的。 */
function pnpmInvocation(pnpm) {
  if (pnpm.kind === 'cjs') return { command: process.execPath, prefix: [pnpm.path], shell: false }
  return { command: pnpm.kind === 'command' && process.platform === 'win32' ? 'pnpm.cmd' : pnpm.path, prefix: [], shell: process.platform === 'win32' }
}

/** 结果写盘（面板轮询它）。**一定写**，失败路径也要写，否则面板永远转圈。 */
function writeResult(path, payload) {
  const target = typeof path === 'string' && path !== '' ? path : join(updatesRoot(), 'last-run.json')
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(payload, null, 2) + '\n')
  } catch (_error) {
    /* 结果文件写不出去也不能让脚本崩：它可能正好在修一个坏掉的目录 */
  }
}

/**
 * 写下「我正在跑」——**必须在干重活之前写**。
 *
 * ## 为什么这条是实测补上的（真缺陷）
 *
 * 第一版只在**结束时**写结果文件。后果是面板无法区分两件事：
 *   - 安装器正在装（正常，pnpm 解析 git 依赖可能要一两分钟）；
 *   - 安装器**根本没起来**（`spawn` 失败、脚本语法错、node 路径不对）。
 * 两种情况下结果文件都不存在，面板只能一直显示「正在安装…」——用户不知道
 * 该等还是该重来。实测就是这样：进程在跑，面板却什么都看不到。
 *
 * 所以先写一条 `stage:'running'`，里面带 pid。面板据此说「正在跑（pid 1234）」，
 * 并且能看出「这条 running 是不是我这次点的」（比对 `startedAt`）。
 */
function writeRunning(path, payload) {
  writeResult(path, {
    ok: false, stage: 'running', running: true, startedAt: new Date().toISOString(),
    pid: process.pid, ...payload,
  })
}

/** 备份一份文件/目录到 `dest`。返回是否成功。 */
function backupOne(from, to) {
  if (!existsSync(from)) return { ok: true, skipped: true }
  try {
    cpSync(from, to, { recursive: true, force: true })
    return { ok: true, skipped: false }
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) }
  }
}

/** 恢复一份文件/目录（先删后拷，防新旧混在一起）。 */
function restoreOne(from, to) {
  if (!existsSync(from)) return { ok: true, skipped: true }
  try {
    rmSync(to, { recursive: true, force: true })
    cpSync(from, to, { recursive: true, force: true })
    return { ok: true, skipped: false }
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) }
  }
}

/** 只保留最近 N 份备份，其余删掉。 */
function pruneBackups(root) {
  let names = []
  try {
    names = readdirSync(root).filter((name) => name.startsWith('backup-')).sort()
  } catch (_error) {
    return
  }
  while (names.length > KEEP_BACKUPS) {
    const oldest = names.shift()
    try {
      rmSync(join(root, oldest), { recursive: true, force: true })
    } catch (_error) {
      /* 删不掉就算了，它只是占点空间 */
    }
  }
}

/** 读插件目录里的版本号。 */
function installedVersion(profile) {
  const json = readJson(join(profile, 'node_modules', PACKAGE_NAME, 'package.json'))
  return json !== null && typeof json.version === 'string' ? json.version : ''
}

/** 读 profile 里本插件的依赖声明。 */
function declaredSpec(profile) {
  const json = readJson(join(profile, 'package.json'))
  if (json === null || typeof json !== 'object') return ''
  const deps = json.dependencies
  if (deps === null || typeof deps !== 'object') return ''
  const value = deps[PACKAGE_NAME]
  return typeof value === 'string' ? value : ''
}

/** 装成功了吗：三条判据（见文件头）。返回 `{ ok, checks }`。 */
function verifyInstall(profile, tag, expectVersion) {
  const checks = []

  const spec = declaredSpec(profile)
  const specOk = spec.includes(tag)
  checks.push({ name: '依赖声明已指向新版', ok: specOk, detail: spec || '(没有这条依赖)' })

  const version = installedVersion(profile)
  /**
   * 期望版本为空时**不能**判「任意版本都算过」。
   *
   * 第一版写的是 `expectVersion === '' ? version !== '' : version === expectVersion`，
   * 那是个**空判据**：只要装上了一个能读出版本号的包就算通过——哪怕装错版本。
   * 而「装完版本没变」正是更新失败最常见的形态（pnpm 静默复用了旧缓存），
   * 那一条恰恰要拦住。所以没给期望版本时，至少要求**版本号读得出来**，
   * 并在 detail 里明说「没给期望版本，只验了读得出来」。
   */
  const versionOk = expectVersion === '' ? version !== '' : version === expectVersion
  checks.push({
    name: '装上的版本号正确',
    ok: versionOk,
    detail: expectVersion === ''
      ? `没给期望版本，只验了读得出来：实际 ${version || '(读不到)'}`
      : `期望 ${expectVersion}，实际 ${version || '(读不到)'}`,
  })

  // 入口文件必须能解析：语法坏了就等于插件加载不了，那是最典型的「更新失败」。
  const entry = join(profile, 'node_modules', PACKAGE_NAME, 'lib', 'index.js')
  let syntaxOk = false
  let syntaxDetail = '入口文件不存在'
  if (existsSync(entry)) {
    const checked = run(process.execPath, ['--check', entry], { timeout: 30000 })
    syntaxOk = checked.ok
    syntaxDetail = syntaxOk ? 'lib/index.js 语法通过' : (checked.stderr || checked.error || '语法检查失败').split(/\r?\n/).slice(0, 3).join(' ')
  }
  checks.push({ name: '入口文件能被解析', ok: syntaxOk, detail: syntaxDetail })

  return { ok: checks.every((one) => one.ok), checks }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const startedAt = new Date().toISOString()
  const resultPath = args.result !== '' ? args.result : join(updatesRoot(), 'last-run.json')

  const fail = (stage, error, extra = {}) => {
    writeResult(resultPath, {
      ok: false, stage, error, rolledBack: false, startedAt, finishedAt: new Date().toISOString(),
      profile: args.profile, tag: args.tag, ...extra,
    })
    console.error(`[更新失败 · ${stage}] ${error}`)
    process.exit(1)
  }

  if (args.profile === '' || !existsSync(join(args.profile, 'package.json'))) {
    fail('参数', `profile 目录不对或没有 package.json：${args.profile || '(空)'}`)
    return
  }
  if (args.tag === '') {
    fail('参数', '缺少 --tag')
    return
  }

  const profile = args.profile
  const root = updatesRoot()
  const backupDir = join(root, `backup-${stamp()}`)
  const beforeSpec = declaredSpec(profile)
  const beforeVersion = installedVersion(profile)

  // **先报「我在跑」**（见 `writeRunning` 的注释）：面板据此区分
  // 「正在装」与「根本没起来」。这一步在备份之前——备份可能就要几秒。
  writeRunning(resultPath, {
    profile, tag: args.tag, expectVersion: args.expectVersion,
    beforeSpec, beforeVersion, backupDir, phase: 'backup',
  })

  // ---- 备份三处 ----
  mkdirSync(backupDir, { recursive: true })
  const targets = [
    { key: 'package.json', from: join(profile, 'package.json'), to: join(backupDir, 'package.json') },
    { key: 'pnpm-lock.yaml', from: join(profile, 'pnpm-lock.yaml'), to: join(backupDir, 'pnpm-lock.yaml') },
    { key: 'plugin', from: join(profile, 'node_modules', PACKAGE_NAME), to: join(backupDir, 'plugin') },
  ]
  const backedUp = []
  for (const target of targets) {
    const done = backupOne(target.from, target.to)
    if (done.ok !== true) {
      fail('备份', `备份 ${target.key} 失败：${done.error}（**没有动任何东西**）`)
      return
    }
    if (done.skipped !== true) backedUp.push(target.key)
  }
  writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify({
    at: startedAt, profile, fromSpec: beforeSpec, fromVersion: beforeVersion, toTag: args.tag, files: backedUp,
  }, null, 2) + '\n')

  /** 回退：把三处都还原。返回每一步的结果，面板要如实显示。 */
  const rollback = (reason) => {
    const steps = []
    for (const target of targets) {
      const done = restoreOne(target.to, target.from)
      steps.push({ target: target.key, ok: done.ok === true, skipped: done.skipped === true, error: done.error ?? '' })
    }
    return { reason, steps, ok: steps.every((one) => one.ok) }
  }

  if (args.dryRun) {
    writeResult(resultPath, {
      ok: true, dryRun: true, stage: 'dry-run', startedAt, finishedAt: new Date().toISOString(),
      profile, tag: args.tag, backupDir, backedUp, beforeSpec, beforeVersion,
    })
    console.log(`dry-run：已备份 ${backedUp.join(' / ')} 到 ${backupDir}`)
    return
  }

  // ---- 装 ----
  const pnpm = findPnpm(args.pnpm)
  const inv = pnpmInvocation(pnpm)
  const spec = `${PACKAGE_NAME}@github:liancha22/dsh-puzzle-mode#${args.tag}`
  const installArgs = [...inv.prefix, 'add', spec]
  // 进入「正在装」阶段：pnpm 解析 git tag 可能要一两分钟，这一段最需要让面板看得见。
  writeRunning(resultPath, {
    profile, tag: args.tag, expectVersion: args.expectVersion,
    beforeSpec, beforeVersion, backupDir, phase: 'install', spec, pnpm: pnpm.path,
  })
  const installed = run(inv.command, installArgs, { cwd: profile, shell: inv.shell })
  const installLog = `${installed.stdout}\n${installed.stderr}`.trim()

  if (installed.ok !== true) {
    const back = rollback(`pnpm add 退出码 ${installed.code}${installed.error ? '（' + installed.error + '）' : ''}`)
    writeResult(resultPath, {
      ok: false, stage: 'install', error: back.reason, rolledBack: true, rollback: back,
      startedAt, finishedAt: new Date().toISOString(), profile, tag: args.tag,
      backupDir, backedUp, beforeSpec, beforeVersion, log: installLog.slice(-4000),
      pnpm: pnpm.path,
    })
    console.error(`[更新失败] ${back.reason} —— 已回退到 ${beforeVersion || beforeSpec}`)
    process.exit(1)
    return
  }

  // ---- 验 ----
  const verified = verifyInstall(profile, args.tag, args.expectVersion)
  if (verified.ok !== true) {
    const failedNames = verified.checks.filter((one) => one.ok !== true).map((one) => one.name).join('、')
    const back = rollback(`装完自检没过：${failedNames}`)
    writeResult(resultPath, {
      ok: false, stage: 'verify', error: `装完自检没过：${failedNames}`, rolledBack: true, rollback: back,
      checks: verified.checks, startedAt, finishedAt: new Date().toISOString(), profile, tag: args.tag,
      backupDir, backedUp, beforeSpec, beforeVersion, log: installLog.slice(-4000), pnpm: pnpm.path,
    })
    console.error(`[更新失败] 自检没过（${failedNames}）—— 已回退`)
    process.exit(1)
    return
  }

  // ---- 成功 ----
  const afterVersion = installedVersion(profile)
  pruneBackups(root)
  writeResult(resultPath, {
    ok: true, stage: 'done', startedAt, finishedAt: new Date().toISOString(),
    profile, tag: args.tag, backupDir, backedUp,
    beforeSpec, beforeVersion, afterSpec: declaredSpec(profile), afterVersion,
    checks: verified.checks, log: installLog.slice(-2000), pnpm: pnpm.path,
    hint: `已装 v${afterVersion}。**重启 profile** 才会生效（本插件的宿主半是 patchReload: startup）。`,
  })
  console.log(`[更新成功] v${beforeVersion} → v${afterVersion}（备份留在 ${backupDir}）`)
}

main()
