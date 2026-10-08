/**
 * 发版时替换 PUBLISH.md 第 0 节那一整行「| 版本 | … |」。
 *
 *   node tools/set-publish-status.mjs <新版本> <正文文件>
 *
 * 为什么单独成脚本：那一行是一整段长文本，而正文里含 `**粗体**`、`` `代码` ``、
 * 反引号与 `$`。在 PowerShell 里拼这种字符串，反引号与 `$` 会被 shell 先吃掉一层，
 * 结果是「替换没生效」或「语法错误」——本仓已经在这上面栽过两次
 * （见 `tools/bump-readme.mjs` 的文件头）。写成脚本 + 从文件读正文就没有这一层。
 *
 * 用法：把要写进那一行的说明先写进一个文本文件，再调本脚本。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const version = process.argv[2]
const bodyFile = process.argv[3]
if (typeof version !== 'string' || version === '') {
  console.error('用法: node tools/set-publish-status.mjs <新版本> <正文文件>')
  process.exit(1)
}
if (typeof bodyFile !== 'string' || bodyFile === '') {
  console.error('缺少正文文件')
  process.exit(1)
}

const path = join(root, 'PUBLISH.md')
const text = readFileSync(path, 'utf8')
const body = readFileSync(bodyFile, 'utf8').trim()

const marker = '| 版本 | v'
const at = text.indexOf(marker)
if (at < 0) {
  console.error('✗ PUBLISH.md 里找不到「| 版本 | v」这一行')
  process.exit(1)
}
const end = text.indexOf('|\n', at)
if (end < 0) {
  console.error('✗ 那一行没有正常结束（找不到行尾的 `|`）')
  process.exit(1)
}

const next = `| 版本 | v${version}（${body}） |`
writeFileSync(path, text.slice(0, at) + next + text.slice(end + 1))
console.log(`✓ PUBLISH 第 0 节版本行已更新为 v${version}（${next.length} 字符）`)
