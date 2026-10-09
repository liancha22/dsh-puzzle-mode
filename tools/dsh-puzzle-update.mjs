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

/**
 * 仓库 slug（`owner/name`）。
 *
 * 与 `lib/updater.js` 的 `UPDATE_REPO` 必须一致——但这里是**独立脚本**，
 * 它要能在插件自己被装坏时照常跑（那正是它存在的理由），所以不能 import 插件的代码。
 * 两处的值由 `tools/check-install-spec.mjs` 与 `test/130-updater.test.mjs` 钉住。
 */
const REPO_SLUG = 'liancha22/dsh-puzzle-mode'

/**
 * ## 为什么装的是 **codeload 的 tarball URL**，不是 `github:` 也不是 `git+https://`
 *
 * 本机实测（2026-10-09）：
 *
 * | 域名 | 443 |
 * |---|---|
 * | `api.github.com` | 通 |
 * | `codeload.github.com` | 通 |
 * | `objects.githubusercontent.com` | 通 |
 * | **`github.com`** | **不通** |
 *
 * 而 pnpm 装 git 依赖要**两步**：①`github.com` 上 `git ls-remote` 解析 tag → SHA；
 * ② 按 SHA 从 codeload 下 tarball。第一步就死了，所以两种 git 规格都装不上：
 *
 * - `github:owner/repo#tag` → pnpm 按环境挑协议，实测挑中 `git+ssh` →
 *   `Host key verification failed`（本机没有 GitHub 的 SSH 主机密钥）；
 * - `git+https://github.com/...#tag` → 直连 `github.com:443` →
 *   `Failed to connect to github.com:443 after 21119 ms`。
 *
 * **解法是把第一步挪到插件里做**：插件走 `api.github.com`（可达）解析出 SHA，
 * 然后把「SHA 版」的 codeload URL 交给 pnpm——那一步 pnpm **不需要**碰 `github.com`。
 *
 * 这不是权宜之计：pnpm 自己在 `pnpm-lock.yaml` 里存的就是这个形式
 * （实测本机锁文件：`version: https://codeload.github.com/liancha22/dsh-puzzle-mode/tar.gz/<sha>`），
 * 所以装完 `package.json` / 锁文件的形状与原来**完全一致**，回退与后续升级都不受影响。
 */
const CODELOAD_BASE = 'https://codeload.github.com'

/**
 * `owner/name` → `https://codeload.github.com/owner/name/tar.gz/<sha>`。
 *
 * 用 SHA 而不是 tag：tag 可以被移动（本仓发版时确实 `git tag -f` 过），
 * 而 SHA 指向的字节是固定的——这正是「装的东西可复现」的前提。
 */
function codeloadUrl(slug, sha) {
  return `${CODELOAD_BASE}/${slug}/tar.gz/${sha}`
}

/** pnpm 命令的超时：装包要联网，给足 5 分钟。 */
const PNPM_TIMEOUT_MS = 300000

/** 保留的备份份数：多了会把 `$DSH_HOME` 撑大，少了不够回退。 */
const KEEP_BACKUPS = 3

function parseArgs(argv) {
  const out = { profile: '', tag: '', sha: '', expectVersion: '', result: '', pnpm: '', dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === '--profile') { out.profile = String(value ?? ''); i += 1 } else if (key === '--tag') { out.tag = String(value ?? ''); i += 1 } else if (key === '--sha') { out.sha = String(value ?? ''); i += 1 } else if (key === '--expect-version') { out.expectVersion = String(value ?? ''); i += 1 } else if (key === '--result') { out.result = String(value ?? ''); i += 1 } else if (key === '--pnpm') { out.pnpm = String(value ?? ''); i += 1 } else if (key === '--dry-run') { out.dryRun = true }
  }
  return out
}

/**
 * 把一个 tag 解析成 commit SHA（走 `api.github.com`，**实测可达**）。
 *
 * 解析不出来返回空串（调用方据此回退），**不抛错**——脚本的任何异常都不该
 * 让 profile 停在半装状态。
 *
 * 两种 tag 都要处理：轻量 tag 的 `object.type` 是 `commit`；
 * 附注 tag 是 `tag`，要再请求一次 `object.url` 才拿到真正的 commit。
 * 本仓用的是轻量 tag，但别人 clone 后可能打附注 tag，所以两条都走。
 */
async function resolveTagSha(tag) {
  const ref = `https://api.github.com/repos/${REPO_SLUG}/git/refs/tags/${encodeURIComponent(tag)}`
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dsh-puzzle-mode-updater',
    // 公开仓库匿名可读；有 token 就带上（提高配额、避免被限流）。
    ...(githubToken() === '' ? {} : { Authorization: `token ${githubToken()}` }),
  }
  const first = await httpJson(ref, headers)
  if (first.ok !== true) return ''
  const object = first.json !== null && typeof first.json === 'object' ? first.json.object : null
  if (object === null || typeof object !== 'object') return ''
  const sha = typeof object.sha === 'string' ? object.sha : ''
  if (object.type === 'commit') return sha
  if (object.type === 'tag' && typeof object.url === 'string' && object.url !== '') {
    const second = await httpJson(object.url, headers)
    if (second.ok !== true) return ''
    const target = second.json !== null && typeof second.json === 'object' ? second.json.object : null
    return target !== null && typeof target === 'object' && typeof target.sha === 'string' ? target.sha : ''
  }
  return ''
}

/**
 * 读 GitHub token（可选）。
 *
 * 位置与插件的 `githubToken()` 一致，但这里**独立实现**：本脚本要能在
 * 插件被装坏时照常跑，不能 import 插件的代码。
 * 读不到就返回空串——匿名也能读公开仓库，只是配额低。
 */
function githubToken() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  for (const file of [join(home, '.github-token'), join(homedir(), '.dsh', '.github-token')]) {
    try {
      const text = readFileSync(file, 'utf8').trim()
      if (text !== '') return text
    } catch (_error) {
      /* 读不到就试下一个 */
    }
  }
  return ''
}

/**
 * 发一个 GET 并解析 JSON。**不抛错**，失败返回 `{ ok: false, error }`。
 *
 * 用全局 `fetch`（Node 18+ 自带，本机 v24）。这个脚本只在本机跑，
 * 而「本机有 Node」是它存在的前提——不必为更老的环境做兼容。
 */
async function httpJson(url, headers) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) })
    if (response.ok !== true) return { ok: false, error: `HTTP ${response.status}` }
    return { ok: true, json: await response.json() }
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) }
  }
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
function verifyInstall(profile, tag, expectVersion, sha) {
  const checks = []

  /**
   * 判据一：依赖声明指向**这次要装的那一版**。
   *
   * ## ⚠️ 判据从「含 tag」改成「含 SHA」（v1.1.1 实测踩到）
   *
   * 改成 codeload 的 SHA 版 URL 之后，声明里**不再有 tag**——于是这条自检
   * 把一次**成功**的安装判成了失败（实测：`pnpm add` 通过、版本号也对，
   * 却被这条拦下并回退）。
   *
   * 判据的**本意**没变：确认「装的是这次要装的那一版」。
   * 而 SHA 比 tag 更精确地表达了这件事——tag 可以被移动（本仓发版时确实
   * `git tag -f` 过），SHA 不能。所以：有 SHA 就认 SHA，没给 SHA 才退回认 tag。
   */
  const spec = declaredSpec(profile)
  const specOk = sha !== '' ? spec.includes(sha) : spec.includes(tag)
  checks.push({
    name: sha !== '' ? '依赖声明已指向这次的 commit' : '依赖声明已指向新版',
    ok: specOk,
    detail: spec || '(没有这条依赖)',
  })

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

async function main() {
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

  /**
   * ① **先在插件侧把 tag 解析成 SHA**（走 `api.github.com`，实测可达）。
   *
   * 这一步就是 pnpm 自己做不到的那一步——它要用 `github.com` 做 `git ls-remote`，
   * 而本机 `github.com:443` 不通（实测 21 秒后超时）。
   * 详见 `CODELOAD_BASE` 上方那张可达性表。
   *
   * `--sha` 允许调用方直接给（插件已经解析过，就不必再解析一次）；
   * 没给才在这里解析——这样「面板拿到 SHA → 传给安装器」与
   * 「命令行直接跑安装器」两条路都能走。
   */
  const sha = args.sha !== '' ? args.sha : await resolveTagSha(args.tag)
  if (sha === '') {
    const back = rollback(`解析 tag ${args.tag} 失败（api.github.com 不可达或这个 tag 不存在）`)
    writeResult(resultPath, {
      ok: false, stage: 'resolve', error: back.reason, rolledBack: true, rollback: back,
      startedAt, finishedAt: new Date().toISOString(), profile, tag: args.tag,
      backupDir, backedUp, beforeSpec, beforeVersion,
    })
    console.error(`[更新失败] ${back.reason} —— 已回退`)
    process.exit(1)
    return
  }

  /**
   * ② 用 **SHA 版的 codeload URL** 装——这一步 pnpm 不必碰 `github.com`。
   *
   * 形状与 pnpm 自己写进锁文件的一模一样（实测本机锁文件就是
   * `https://codeload.github.com/.../tar.gz/<sha>`），所以装完
   * `package.json` / 锁文件的形状不变，回退与后续升级都不受影响。
   */
  const spec = `${PACKAGE_NAME}@${codeloadUrl(REPO_SLUG, sha)}`
  const installArgs = [...inv.prefix, 'add', spec]
  // 进入「正在装」阶段：pnpm 要下载并解包，这一段最需要让面板看得见。
  writeRunning(resultPath, {
    profile, tag: args.tag, expectVersion: args.expectVersion,
    beforeSpec, beforeVersion, backupDir, phase: 'install', spec, sha, pnpm: pnpm.path,
  })
  const installed = run(inv.command, installArgs, { cwd: profile, shell: inv.shell })
  const installLog = `${installed.stdout}\n${installed.stderr}`.trim()

  if (installed.ok !== true) {
    /**
     * 失败原因要把**协议**与**日志尾巴**一起带上。
     *
     * 第一版只写「pnpm add 退出码 1」——用户看到的是一句无信息量的话，
     * 而真正的死因（`Host key verification failed`）躺在 4000 字符的日志里。
     * 失败信息的第一职责是**让人知道下一步该干什么**。
     */
    const tail = installLog.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    const hint = tail.find((line) => /Host key|Could not read from remote|Permission denied|not found|ETIMEDOUT|ENOTFOUND/i.test(line))
      ?? tail.slice(-1)[0] ?? ''
    const back = rollback(`pnpm add 退出码 ${installed.code}${installed.error ? '（' + installed.error + '）' : ''}${hint ? '：' + hint.slice(0, 200) : ''}`)
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
  const verified = verifyInstall(profile, args.tag, args.expectVersion, sha)
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

/**
 * 起主流程，并把**任何**异常兜住。
 *
 * `main()` 是 async（要 `await fetch` 解析 tag），所以末尾那句 `main()` 返回的是
 * Promise——不接 `.catch` 的话，抛出的异常会变成**未处理的 rejection**：
 * Node 默认打一行警告就退出（退出码 0），于是面板看到的「进程结束」是「成功」，
 * 而结果文件里什么都没写 → **面板永远转圈**。
 *
 * 兜底动作与失败路径一致：**把失败写进结果文件**。这里不重试回退——
 * 能走到这里说明异常发生在 `main()` 的某处，而回退逻辑自己也在 `main()` 里，
 * 状态已经不可信；此时最该做的是让用户**看见**出了什么事，而不是猜着去改盘。
 */
main().catch((error) => {
  const message = String(error && error.message ? error.message : error)
  try {
    const args = parseArgs(process.argv.slice(2))
    const resultPath = args.result !== '' ? args.result : join(updatesRoot(), 'last-run.json')
    writeResult(resultPath, {
      ok: false, stage: 'crash', error: `安装器内部错误：${message}`, rolledBack: false,
      finishedAt: new Date().toISOString(),
      hint: '这是安装器自身的缺陷，不是你操作的问题。插件应该还可用；若不可用，用 backup-* 目录手工恢复。',
    })
  } catch (_writeError) {
    /* 结果文件都写不出去：只能靠 stderr 了 */
  }
  console.error(`[更新失败] 安装器内部错误：${message}`)
  process.exit(1)
})
