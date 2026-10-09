/**
 * 从 asar 里按路径片段列出 / 抽取文件。
 *
 * asar 格式：前 16 字节 pickle 头（其中 offset 12 是 JSON 头长度），
 * 之后是 JSON 头，再之后是各文件**原样存放**的字节（未压缩）。
 *
 * 用法：
 *   node tools/asar-tool.mjs list <路径片段>
 *   node tools/asar-tool.mjs grep <路径片段> <正则>
 *   node tools/asar-tool.mjs cat <完整路径> [最多字节]
 */
import { readFileSync } from 'node:fs'

const file = 'D:/dsh/resources/app.asar'
const buf = readFileSync(file)
const jsonSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + jsonSize).toString('utf8'))
const dataStart = 16 + jsonSize

const entries = []
;(function walk(node, prefix) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const path = prefix + '/' + name
    if (value.files !== undefined) walk(value, path)
    else entries.push({ path, offset: Number(value.offset), size: value.size })
  }
})(header, '')

const contentOf = (entry) => buf.subarray(dataStart + entry.offset, dataStart + entry.offset + entry.size)

const [, , command, ...rest] = process.argv

if (command === 'list') {
  const needle = rest[0] ?? ''
  const hits = entries.filter((one) => one.path.includes(needle))
  console.log('命中', hits.length)
  for (const one of hits.slice(0, 200)) console.log('  ', one.path, one.size)
} else if (command === 'grep') {
  const needle = rest[0] ?? ''
  const pattern = new RegExp(rest[1] ?? '.', 'g')
  const hits = entries.filter((one) => one.path.includes(needle) && /\.(js|mjs|cjs|json|ts)$/.test(one.path))
  console.log('候选文件', hits.length)
  for (const one of hits) {
    const text = contentOf(one).toString('utf8')
    const found = new Set()
    let m
    while ((m = pattern.exec(text)) !== null) {
      found.add(text.slice(Math.max(0, m.index - 90), m.index + 130).replace(/\s+/g, ' '))
      if (found.size > 6) break
    }
    if (found.size > 0) {
      console.log('\n=== ' + one.path)
      for (const line of found) console.log('   ', line)
    }
  }
} else if (command === 'cat') {
  const target = rest[0]
  const limit = Number(rest[1] ?? 40000)
  const entry = entries.find((one) => one.path === target || one.path.endsWith(target))
  if (entry === undefined) {
    console.log('没找到', target)
  } else {
    console.log(contentOf(entry).subarray(0, limit).toString('utf8'))
  }
} else {
  console.log('用法：list <片段> | grep <片段> <正则> | cat <路径> [字节]')
}
