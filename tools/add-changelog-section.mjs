/**
 * 把一个版本小节插到 CHANGELOG.md 的最前面。
 *
 *   node tools/add-changelog-section.mjs <小节正文文件>
 *
 * 为什么单独成脚本：小节正文含 `**粗体**`、反引号与 `'`，在 PowerShell 里拼这种字符串
 * 会被 shell 先吃掉一层引号（本仓已栽过三次）。写成脚本 + 从文件读正文就没有这一层。
 *
 * 为什么必须有它：README 只留最近 3 个版本小节（发版约定），更早的要挪进 CHANGELOG。
 * 少了这一步，旧版本的更新日志就**只存在于 git 历史里**——用户点「更新日志」看不到。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const sectionFile = process.argv[2]
if (typeof sectionFile !== 'string' || sectionFile === '') {
  console.error('用法: node tools/add-changelog-section.mjs <小节正文文件>')
  process.exit(1)
}
const section = readFileSync(sectionFile, 'utf8').trimEnd() + '\n'
const heading = /^### (v\d+\.\d+\.\d+)/.exec(section)
if (heading === null) {
  console.error('✗ 小节正文必须以 `### vX.Y.Z` 开头（CHANGELOG 的格式契约）')
  process.exit(1)
}
const version = heading[1]

const path = join(root, 'CHANGELOG.md')
let text = readFileSync(path, 'utf8')

// 幂等：已经写过同一版就跳过（重跑发版流程不该插两遍）。
if (text.includes(`### ${version} `)) {
  console.log(`已经是新版，跳过：CHANGELOG 里已有 ${version}`)
  process.exit(0)
}

// CHANGELOG 顶部可能有一行大标题（`# 更新日志` 之类）；插在它之后、第一条 `### ` 之前。
const firstH3 = text.indexOf('### ')
const head = firstH3 < 0 ? '' : text.slice(0, firstH3)
const rest = firstH3 < 0 ? text : text.slice(firstH3)
text = head + section + '\n' + rest
writeFileSync(path, text)

const count = (text.match(/^### v\d+\.\d+\.\d+/gm) ?? []).length
console.log(`✓ 已把 ${version} 插到 CHANGELOG 顶部；现有 ${count} 个版本小节`)
