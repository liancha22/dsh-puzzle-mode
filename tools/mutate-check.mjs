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
