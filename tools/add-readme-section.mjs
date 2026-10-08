/**
 * 往 README 的「## 最新版本」里插一个小节，并把超出的旧小节挪走（只留最近 3 个）。
 *
 *   node tools/add-readme-section.mjs <小节正文文件>
 *
 * 为什么单独成脚本：小节正文里含 `**粗体**`、反引号与 `'`，在 PowerShell 里拼
 * 这种字符串会被 shell 先吃掉一层引号（本仓已栽过三次）。写成脚本 + 从文件读正文就没有这一层。
 *
 * 「只留最近 3 个」是本仓的发版约定（README 只放最近 3 版，更早的进 CHANGELOG）。
 * 这里把它做成机械动作：数出小节数，超出的从**最旧**开始删，并在原位补一句指路。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** README 里保留几个版本小节（发版约定）。 */
const KEEP_SECTIONS = 3

const sectionFile = process.argv[2]
if (typeof sectionFile !== 'string' || sectionFile === '') {
  console.error('用法: node tools/add-readme-section.mjs <小节正文文件>')
  process.exit(1)
}
const section = readFileSync(sectionFile, 'utf8').trimEnd() + '\n'

const path = join(root, 'README.md')
let text = readFileSync(path, 'utf8')

const anchor = '## 最新版本\n\n'
const at = text.indexOf(anchor)
if (at < 0) {
  console.error('✗ README 里找不到「## 最新版本」')
  process.exit(1)
}

// 1) 插入新小节（紧跟标题）。
text = text.slice(0, at) + anchor + section + text.slice(at + anchor.length)

// 2) 只留最近 KEEP_SECTIONS 个：从最旧的那个开始删，删到只剩 KEEP_SECTIONS 个。
const headingRe = /^### (v\d+\.\d+\.\d+)/gm
const collect = () => {
  const out = []
  let match = headingRe.exec(text)
  while (match !== null) {
    out.push({ version: match[1], index: match.index })
    match = headingRe.exec(text)
  }
  headingRe.lastIndex = 0
  return out
}

const all = collect()
if (all.length > KEEP_SECTIONS) {
  // 每个小节的结束位置：下一个 `### ` 或下一个 `## ` 或文件末尾。
  const stopOf = (start) => {
    const nextH3 = text.indexOf('\n### ', start + 1)
    const nextH2 = text.indexOf('\n## ', start + 1)
    const candidates = [nextH3, nextH2].filter((one) => one >= 0)
    return candidates.length === 0 ? text.length : Math.min(...candidates) + 1
  }
  // 从后往前删（删前面的不会影响后面已算好的下标）。
  const doomed = all.slice(KEEP_SECTIONS).reverse()
  let oldestKept = all[KEEP_SECTIONS - 1].version
  for (const item of doomed) {
    const stop = stopOf(item.index)
    text = text.slice(0, item.index) + text.slice(stop)
    oldestKept = item.version
  }
  // 在「最新版本」节尾补一句指路（放在最后一个小节之后、下一个 `## ` 之前）。
  const last = collect()[KEEP_SECTIONS - 1]
  const stop = stopOf(last.index)
  const guide = `\n> 更早的版本（${oldestKept} 及以前）见 [CHANGELOG.md](CHANGELOG.md)。\n\n`
  // 已经有一句指路就先删掉旧的，免得堆两句。
  text = text.replace(/\n> 更早的版本（[^）]*）见 \[CHANGELOG\.md\]\(CHANGELOG\.md\)。\n/g, '\n')
  const last2 = collect()[KEEP_SECTIONS - 1]
  const stop2 = stopOf(last2.index)
  text = text.slice(0, stop2) + guide + text.slice(stop2)
}

writeFileSync(path, text)
const final = collect()
console.log(`✓ 已插入小节；README 现有 ${final.length} 个版本小节：${final.map((one) => one.version).join(' / ')}`)
