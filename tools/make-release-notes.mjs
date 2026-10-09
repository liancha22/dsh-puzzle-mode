/**
 * 由「README 里那一节」生成 `.github/release-vX.Y.Z.md`，并追加「验收判据」。
 *
 *   node tools/make-release-notes.mjs <版本> <小节正文文件> <验收判据文件>
 *
 * 为什么单独成脚本：Release 正文里含中文引号、反引号与 `|` 表格，
 * 在 PowerShell 里拼这种字符串会被 shell 先吃掉一层引号（本仓已栽五次）。
 * 脚本 + 从文件读正文是唯一稳的做法。
 *
 * 另一个好处：**README 小节与 Release 正文同源**，不会出现两份说法漂移。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const version = process.argv[2]
const sectionFile = process.argv[3]
const acceptFile = process.argv[4]
if (typeof version !== 'string' || version === '' || typeof sectionFile !== 'string' || typeof acceptFile !== 'string') {
  console.error('用法: node tools/make-release-notes.mjs <版本> <小节正文文件> <验收判据文件>')
  process.exit(1)
}

const section = readFileSync(sectionFile, 'utf8').trimEnd()
const lines = section.split('\n')
// 第一行是 `### vX.Y.Z · 标题` → 转成一级标题。
const first = lines[0]
if (!first.startsWith('### ')) {
  console.error('✗ 小节正文的第一行必须是 `### vX.Y.Z · 标题`')
  process.exit(1)
}
const title = '# ' + first.slice(4)
const body = lines.slice(1).join('\n')

const accept = readFileSync(acceptFile, 'utf8').trimEnd()
const text = `${title}\n${body}\n\n---\n\n${accept}\n`

const path = join(root, '.github', `release-v${version}.md`)
writeFileSync(path, text)
console.log(`✓ 已写出 .github/release-v${version}.md（${text.length} 字符）`)
