/**
 * 由「README 里那一节」生成 `.github/release-vX.Y.Z.md`（v1.1.3 起正文只留标题 + 摘要 + 附件校验）。
 *
 *   node tools/make-release-notes.mjs <版本> <小节正文文件> [附件校验文件]
 *
 * 为什么单独成脚本：Release 正文里含中文引号、反引号与 `|` 表格，
 * 在 PowerShell 里拼这种字符串会被 shell 先吃掉一层引号（本仓已栽五次）。
 * 脚本 + 从文件读正文是唯一稳的做法。
 *
 * 另一个好处：**README 小节与 Release 正文同源**，不会出现两份说法漂移。
 *
 * ## v1.1.3：正文只留「标题 + ## 摘要 + 附件校验」
 *
 * 用户裁定：「更新日志的信息改为**简短三句交代更新了什么**就行」。所以正文不再
 * 带上「先量再改」「验收判据」这些过程内容——那些留在 `CHANGELOG.md` 与测试里。
 * 面板读的是**正文里的 `## 摘要` 区块**（见 `lib/updater.js` 的 `summarySectionOf`），
 * 所以这个脚本的职责就是：把 README 小节的三句包成那个区块。
 *
 * README 小节里**不写** `## 摘要` 标题（那会变成 README 自己的二级标题，打乱它的结构），
 * 由本脚本包；首行 `### vX.Y.Z · 标题` 转成 `# vX.Y.Z · 标题`。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const version = process.argv[2]
const sectionFile = process.argv[3]
const assetFile = process.argv[4]
if (typeof version !== 'string' || version === '' || typeof sectionFile !== 'string') {
  console.error('用法: node tools/make-release-notes.mjs <版本> <小节正文文件> [附件校验文件]')
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
const summary = lines.slice(1).join('\n').trim()
if (summary === '') {
  console.error('✗ 小节正文里没有摘要三句——面板会显示「这版没写摘要」')
  process.exit(1)
}

let text = `${title}\n\n## 摘要\n\n${summary}\n`
if (typeof assetFile === 'string' && assetFile !== '') {
  const asset = readFileSync(assetFile, 'utf8').trimEnd()
  text += `\n---\n\n${asset}\n`
}

const path = join(root, '.github', `release-v${version}.md`)
writeFileSync(path, text)
console.log(`✓ 已写出 .github/release-v${version}.md（${text.length} 字符）`)
