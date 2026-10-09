/**
 * 找出文档里「数字没测法」的条目（复现 `lib/entries.js` 的判据）。
 *
 *   node tools/find-nomeasure.mjs
 *
 * 为什么单独一个脚本：审查只报**第一条**当例子（「有 3 条数字没测法」），
 * 要一次改对就必须把命中的条目全部列出来。判据从 lib 里 import，不重写一份
 * ——重写一份就会与实现漂移（本仓的老教训）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { measureWithoutMethod, entryBody } from '../lib/entries.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const puzzle = join(root, '..', '拼图')

/** 逐行扫描一份文档，打印命中「数字没测法」的行。 */
function scan(file, label) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return 0
  }
  const lines = text.split(/\r?\n/)
  let hits = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!/^\s*[-*]\s+/.test(line)) continue
    const body = entryBody(line.trim().replace(/^\s*[-*]\s*/, '').trim())
    const measure = measureWithoutMethod(body)
    if (measure === null) continue
    hits += 1
    console.log(`${label}:${i + 1}  [${measure}]  ${body}`)
  }
  return hits
}

let total = 0
total += scan(join(puzzle, '主文档.md'), '主文档')

const moduleDir = join(puzzle, '模块')
for (const name of readdirSync(moduleDir)) {
  if (!name.endsWith('.md')) continue
  total += scan(join(moduleDir, name), `模块/${name}`)
}
console.log(`\n合计 ${total} 条`)
