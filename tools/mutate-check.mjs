/**
 * 变异验证：证明新测试的守卫**真的会红**，而不是恒绿。
 *
 *   node tools/mutate-check.mjs
 *
 * ## 为什么需要它
 *
 * 一组「全过」的测试可能什么也没守住——把守卫整段删掉、把阈值改成 0、
 * 让判据恒真，测试照样全绿。那是本仓最忌讳的假绿。
 * 所以每加一个守卫，都要能证明「改坏它 → 测试变红」，并在输出里点出是**哪条**断言红的。
 *
 * ## 为什么用 Node 而不是 PowerShell 脚本
 *
 * 上一轮的教训（写进 `PUBLISH.md`）：PowerShell 里带反引号与引号的字符串替换
 * 会**静默不匹配**——变异没生效，脚本却报「守卫通过」，看起来一切正常。
 * 这里用 Node 的 `String.prototype.replace`，替换没生效就明确报错。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** 一次变异：改哪个文件、把什么换成什么、期望哪个测试变红。 */
const MUTATIONS = [
  {
    label: '去重整段失效（永远注入）',
    file: 'lib/workflowguard.js',
    test: 'test/120-workflowguard.test.mjs',
    from: 'if (gap < WORKFLOW_MIN_INTERVAL) {',
    to: 'if (false) {',
  },
  {
    label: '最小间隔降为 0（等于不去重）',
    file: 'lib/workflowguard.js',
    test: 'test/120-workflowguard.test.mjs',
    from: 'export const WORKFLOW_MIN_INTERVAL = 6',
    to: 'export const WORKFLOW_MIN_INTERVAL = 0',
  },
  {
    label: '签名只留项目名（集合内容被忽略）',
    file: 'lib/workflowguard.js',
    test: 'test/120-workflowguard.test.mjs',
    from: 'parts.push(project + \'#\' + names.join(\'+\'))',
    to: 'parts.push(project)',
  },
  {
    label: '签名排序被去掉（顺序影响判定）',
    file: 'lib/workflowguard.js',
    test: 'test/120-workflowguard.test.mjs',
    from: '    names.sort()\n    parts.push(project',
    to: '    parts.push(project',
  },
  {
    label: '没命中也算一次注入（间隔分母丢）',
    file: 'lib/workflowguard.js',
    test: 'test/120-workflowguard.test.mjs',
    from: "  if (sig === '') {\n    save({ steps, lastAt: previous.lastAt, injected: previous.injected, skipped: previous.skipped })",
    to: "  if (sig === '') {\n    save({ steps, lastAt: previous.lastAt, injected: previous.injected + 1, skipped: previous.skipped })",
  },
  {
    label: '钩子不再调去重（退回每步都注入）',
    file: 'lib/index.js',
    test: 'test/120-workflowguard.test.mjs',
    from: 'const verdict = noteWorkflowTrigger(sessionId, workflowSignature(hits))',
    to: 'const verdict = { inject: true }',
  },
  {
    // v1.1.2 用户报的「复读机」：重复注入必须压成一行指路，不能再塞完整步骤。
    // 把判据改成「永远给全文」= 退回改之前的行为，这条必须红。
    label: '重复注入也给全文（退回「复读机」）',
    file: 'lib/index.js',
    test: 'test/120-workflowguard.test.mjs',
    from: 'const full = verdict.reason === WORKFLOW_REASON_FIRST',
    to: 'const full = true',
  },
  {
    // 反过来：如果永远给「指路」，模型就**再也看不到完整步骤**了——规则静默失效。
    label: '首次也只给指路（模型看不到完整步骤）',
    file: 'lib/index.js',
    test: 'test/120-workflowguard.test.mjs',
    from: 'const full = verdict.reason === WORKFLOW_REASON_FIRST',
    to: 'const full = false',
  },
  {
    // 用户指定那句必须真的进了催促文案（否则等于没加）。
    label: '催促丢掉用户指定那句',
    file: 'lib/nudge.js',
    test: 'test/100-nudge.test.mjs',
    from: "export const NUDGE_PUSH = '你怎么这么慢，快点做啊'",
    to: "export const NUDGE_PUSH = ''",
  },
  {
    // v1.1.2 的行为反转：第 1 档**不许**再叫模型「报进度」（那是复读机的来源）。
    // 退回旧文案，那条「不许出现报进度」的断言必须红。
    label: '催促退回「要求报进度」（复读机的来源）',
    file: 'lib/nudge.js',
    test: 'test/100-nudge.test.mjs',
    from: 'return `${NUDGE_MARK} 第 ${steps} 步了——${NUDGE_PUSH}。直接做下一步。`',
    to: 'return `${NUDGE_MARK} 第 ${steps} 步了——${NUDGE_PUSH}。一句话报进度 + 直接做下一步。`',
  },
  {
    label: '版本比较恒等（永远判「已是最新」）',
    file: 'lib/updater.js',
    test: 'test/130-updater.test.mjs',
    from: '  if (left === null || right === null) return 0',
    to: '  if (left === null || right === null) return 0\n  return 0',
  },
  {
    label: 'tar 路径穿越不拦（解包逃逸）',
    file: 'lib/updater.js',
    test: 'test/130-updater.test.mjs',
    from: '    if (part === \'..\') return false',
    to: '    if (false) return false',
  },
  {
    label: '哈希锚点不比对（校验形同虚设）',
    file: 'lib/updater.js',
    test: 'test/130-updater.test.mjs',
    from: '    if (actual !== anchor) {',
    to: '    if (false) {',
  },
  {
    label: '主题包 sha256 不校验',
    file: 'lib/themedev.js',
    test: 'test/140-themedev.test.mjs',
    from: '  if (declared !== \'\' && declared !== actual) {',
    to: '  if (false) {',
  },
  {
    label: '上传前不校验 CSS（坏主题能推上去）',
    file: 'lib/themedev.js',
    test: 'test/140-themedev.test.mjs',
    from: '  const valid = validateThemeCss(css)\n  if (valid.ok !== true) return { ok: false, error: \'theme.css 未通过安全校验，拒绝上传：\' + valid.error }',
    to: '  const valid = validateThemeCss(css)',
  },
  {
    label: '脚手架覆盖已有文件（删掉用户的工作）',
    file: 'lib/themedev.js',
    test: 'test/140-themedev.test.mjs',
    from: '    if (existsSync(file)) {\n      skipped.push(file)\n      continue\n    }',
    to: '    if (false) {\n      skipped.push(file)\n      continue\n    }',
  },
  {
    label: '摘要不限行（退回「一大堆字」）',
    file: 'lib/updater.js',
    test: 'test/130-updater.test.mjs',
    from: '  const head = lines.slice(0, limit)',
    to: '  const head = lines.slice(0, lines.length)',
  },
  {
    label: '摘要丢掉表格行（漏掉「改了什么」）',
    file: 'lib/updater.js',
    test: 'test/130-updater.test.mjs',
    from: '    if (clean.startsWith(\'|\')) {',
    to: '    if (clean.startsWith(\'|\')) continue\n    if (false) {',
  },
  {
    // v1.1.3 用户的要求：「更新日志的信息改为简短三句交代更新了什么」。
    // 退回「取正文前 3 行」= 又拿背景铺垫冒充摘要（v1.1.2 上实测三句里没有一句说改了什么）。
    label: '摘要退回「取正文前 3 行」（拿背景铺垫冒充摘要）',
    file: 'lib/updater.js',
    test: 'test/130-updater.test.mjs',
    from: '    const section = summarySectionOf(body)',
    to: '    const section = body',
  },
  {
    // 反过来：没有「## 摘要」区块时必须**空**（面板据此说「这版没写摘要」）。
    // 若给个兜底文案，面板就分不清「没写摘要」与「写了摘要」。
    label: '没写摘要时也编一段兜底（分不清写没写）',
    file: 'lib/updater.js',
    test: 'test/130-updater.test.mjs',
    from: "  if (start === -1) return ''",
    to: "  if (start === -1) return '（这版没写摘要）'",
  },
  {
    label: '更新器脚本暂存到 node_modules（装坏就没得救）',
    file: 'lib/updater.js',
    test: 'test/130-updater.test.mjs',
    from: '  return join(updatesDir(), UPDATER_SCRIPT)',
    to: '  return join(updatesDir(), \'node_modules\', UPDATER_SCRIPT)',
  },
  {
    label: 'Release 列表不剔草稿（把未发布的当成版本）',
    file: 'lib/updater.js',
    test: 'test/130-updater.test.mjs',
    from: '    if (raw.draft === true) continue',
    to: '    if (false) continue',
  },
  {
    label: 'Release 列表不标当前版（用户得自己找）',
    file: 'lib/updater.js',
    test: 'test/130-updater.test.mjs',
    from: '      current: current !== \'\' && version === current,',
    to: '      current: false,',
  },
  {
    label: '安装器不先报「我在跑」（面板分不清在装还是没起来）',
    file: 'tools/dsh-puzzle-update.mjs',
    test: 'test/150-installer.test.mjs',
    // ⚠️ 要改的是**函数体**，不是某一个调用点：`writeRunning` 有两处调用
    // （备份前 + 安装前），只改一处另一处仍然会写出 `running: true`，
    // 守卫还在、测试自然不红——第一版就是这么写的，白跑一轮。
    from: "function writeRunning(path, payload) {\n  writeResult(path, {\n    ok: false, stage: 'running', running: true, startedAt: new Date().toISOString(),\n    pid: process.pid, ...payload,\n  })\n}",
    to: 'function writeRunning(path, payload) {\n  void path\n  void payload\n}',
  },
  {
    label: '安装器不验入口文件（语法坏了也算装好）',
    file: 'tools/dsh-puzzle-update.mjs',
    test: 'test/150-installer.test.mjs',
    from: '  const checked = run(process.execPath, [\'--check\', entry], { timeout: 30000 })',
    to: '  const checked = { ok: true, stderr: \'\', error: \'\' }',
  },
  {
    label: '安装器失败不回退（用户拿到半坏的插件）',
    file: 'tools/dsh-puzzle-update.mjs',
    test: 'test/150-installer.test.mjs',
    // 同样要改**函数体**：`rollback` 被两个失败路径调用（pnpm 失败 / 自检失败），
    // 只改一处的话另一处仍会回退。改 `restoreOne` 更彻底——回退会「假装成功」。
    from: 'function restoreOne(from, to) {\n  if (!existsSync(from)) return { ok: true, skipped: true }',
    to: 'function restoreOne(from, to) {\n  if (true) return { ok: true, skipped: true }\n  if (!existsSync(from)) return { ok: true, skipped: true }',
  },
  {
    label: '更新页用了不存在的变量（面板一打开就消失）',
    file: 'lib/client.js',
    test: 'test/20-client.test.mjs',
    // 这是**用户真机报过的 bug**：`updatePage` 里用了 `sessionId`，而它没有这个变量 →
    // ReferenceError → React 整棵子树卸载 → 面板一打开就没了。
    // 当时测试全绿，因为夹具对 `update` 回的是空 result，那条会崩的分支根本没走到。
    from: '        body.push(releaseList(view))',
    to: '        body.push(releaseList(view, sessionId))',
  },
  {
    label: '入参只认对象（退回那个静默失效的真 bug）',
    file: 'lib/toolargs.js',
    test: 'test/160-toolargs-fsguard.test.mjs',
    // 这是**真缺陷**的复现：真实 `exec.arguments` 是字符串（会话日志 248/248 条），
    // 只认对象会让「只拼不写拦截」等五处静默失效——不报错，只是永远不生效。
    from: '  if (typeof raw === \'string\') {',
    to: '  if (false) {',
  },
  {
    label: 'FS 错误码只认顶层（退回 cot-guard 踩过的假绿）',
    file: 'lib/fsguard.js',
    test: 'test/160-toolargs-fsguard.test.mjs',
    from: '  const nested = error.info !== undefined && error.info !== null ? error.info.code : undefined',
    to: '  const nested = undefined',
  },
  {
    label: '观察表不刷新（刚改过的文件被误报）',
    file: 'lib/fsguard.js',
    test: 'test/160-toolargs-fsguard.test.mjs',
    from: '  state.log.refresh(path, state.step)\n  return outcome',
    to: '  return outcome',
  },
  {
    label: '闸门在信息不足时也拦（把熔断升级路径吃掉）',
    file: 'lib/injectgate.js',
    test: 'test/160-toolargs-fsguard.test.mjs',
    from: '  if (state.turn < 0) {',
    to: '  if (false) {',
  },
]

let failed = 0
for (const mutation of MUTATIONS) {
  const path = join(root, mutation.file)
  const original = readFileSync(path, 'utf8')
  const mutated = original.replace(mutation.from, mutation.to)
  if (mutated === original) {
    console.log(`✗ 变异没生效（字符串没匹配上）：${mutation.label}  [${mutation.file}]`)
    failed += 1
    continue
  }
  writeFileSync(path, mutated)
  let out = ''
  try {
    const run = spawnSync(process.execPath, [join(root, mutation.test)], { encoding: 'utf8', timeout: 180000 })
    out = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
    if (run.status === 0) {
      console.log(`✗ 变异后测试仍然全绿（守卫没守住）：${mutation.label}`)
      failed += 1
    } else {
      const line = out.split(/\r?\n/).find((one) => one.includes('AssertionError')) ?? ''
      console.log(`✓ 变红：${mutation.label}`)
      console.log(`    ${line.trim().slice(0, 140)}`)
    }
  } finally {
    writeFileSync(path, original)
  }
}

console.log(`\n变异验证： ${MUTATIONS.length - failed} 项按预期变红 / ${failed} 项异常`)
process.exit(failed === 0 ? 0 : 1)
