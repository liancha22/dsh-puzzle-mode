/**
 * 会话日志探针 v5：**按轮分组**数注入，并支持 `--since` 只统计某个时刻之后。
 *
 * 为什么必须能切时间：会话日志横跨 4 天、跨了好几个插件版本。
 * 拿整份日志的平均值去评判当前版本，等于用老版本的账骂新代码。
 * 本机 DSH 进程在 2026-10-09 12:56:03（本地）重启过——`--since` 就是为它准备的。
 *
 * 用法：
 *   node tools/probe-session.mjs <会话目录> [--since 2026-10-09T12:56:03+08:00]
 *   node tools/probe-session.mjs <会话目录> --per-turn
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decompressAll(buf) {
  const starts = []
  let at = buf.indexOf(MAGIC)
  while (at !== -1) {
    starts.push(at)
    at = buf.indexOf(MAGIC, at + 4)
  }
  if (starts.length === 0) return buf.toString('utf8')
  const parts = []
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : buf.length
    try {
      parts.push(zstdDecompressSync(buf.subarray(from, to)))
    } catch {
      /* 尾帧可能被截断 */
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

function load(target) {
  const st = statSync(target)
  const files = st.isDirectory()
    ? readdirSync(target).filter((n) => n.includes('jsonl')).map((n) => join(target, n))
    : [target]
  return files.map((file) => decompressAll(readFileSync(file))).join('')
}

function textsOf(value, out = [], depth = 0) {
  if (depth > 8 || value === null || value === undefined) return out
  if (typeof value === 'string') {
    out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) textsOf(item, out, depth + 1)
    return out
  }
  if (typeof value === 'object') for (const key of Object.keys(value)) textsOf(value[key], out, depth + 1)
  return out
}

const MARKS = [
  ['【拼图模式 · 工作流触发】', 'workflow'],
  ['【拼图模式 · 催促】', 'nudge'],
  ['【拼图模式 · 重复思考熔断】', 'loop'],
  ['【拼图模式 · 说话纠正】', 'speech'],
  ['【拼图模式 · 文件观察', 'fsguard'],
  ['【拼图模式 · 首轮自动判定】', 'firstrun'],
  ['【拼图模式 · 只拼不写】', 'readonly'],
]

const args = process.argv.slice(2)
const target = args.find((one) => !one.startsWith('--'))
const sinceArg = args.includes('--since') ? args[args.indexOf('--since') + 1] : ''
const since = sinceArg === '' ? 0 : Date.parse(sinceArg)
const perTurn = args.includes('--per-turn')

const rows = []
for (const line of load(target).split('\n')) {
  if (line.trim() === '') continue
  try {
    rows.push(JSON.parse(line))
  } catch {
    /* 坏行 */
  }
}

// 按 seq 排序（日志就是按 seq 写的），收集需要的事件
const events = []
for (const row of rows) {
  const stack = [row]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === null || typeof node !== 'object') continue
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item)
      continue
    }
    if (typeof node.type === 'string') {
      const seq = typeof node.seq === 'number' ? node.seq : 0
      const time = typeof node.time === 'number' ? node.time : 0
      if (node.type === 'user/message') {
        events.push({ seq, time, type: 'user', text: textsOf(node).join('\n'), source: node.data?.source ?? null })
      } else if (node.type === 'assistant/message') {
        events.push({ seq, time, type: 'assistant', text: textsOf(node).join('\n') })
      } else if (node.type === 'step/start') {
        events.push({ seq, time, type: 'step', turn: node.data?.turn, step: node.data?.step })
      } else if (node.type === 'tool/call') {
        events.push({ seq, time, type: 'tool', name: String(node.data?.name ?? node.name ?? '') })
      } else if (node.type === 'turn/start') {
        events.push({ seq, time, type: 'turn', turn: node.data?.turn })
      }
    }
    for (const key of Object.keys(node)) stack.push(node[key])
  }
}
events.sort((a, b) => a.seq - b.seq)

const fmt = (ms) => (ms > 0 ? new Date(ms + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) : '?')

const filtered = since > 0 ? events.filter((one) => one.time >= since) : events
console.log(`事件 ${events.length}，筛选后 ${filtered.length}${since > 0 ? `（>= ${fmt(since)} 本地）` : ''}`)

// ---- 注入计数（整体 / 筛选后）----
const labelOf = (one) => {
  if (one.type !== 'user') return ''
  for (const [mark, label] of MARKS) if (one.text.includes(mark)) return label
  return ''
}
const countBy = (list) => {
  const out = new Map()
  for (const one of list) {
    const label = labelOf(one)
    if (label !== '') out.set(label, (out.get(label) ?? 0) + 1)
  }
  return out
}
console.log('\n== 注入条数 ==')
console.log('类型        全量    筛选后')
const all = countBy(events)
const some = countBy(filtered)
for (const label of new Set([...all.keys(), ...some.keys()])) {
  console.log(label.padEnd(11), String(all.get(label) ?? 0).padStart(6), String(some.get(label) ?? 0).padStart(8))
}

// ---- 筛选后：注入 vs 助手消息 ----
let inj = 0
let asst = 0
let tools = 0
for (const one of filtered) {
  if (labelOf(one) !== '') inj += 1
  if (one.type === 'assistant') asst += 1
  if (one.type === 'tool') tools += 1
}
console.log(`\n筛选后：注入 ${inj} / 助手消息 ${asst} / 工具调用 ${tools}`)
if (inj > 0) console.log(`  平均每 ${(tools / inj).toFixed(1)} 次工具调用插一条；每 ${(asst / inj).toFixed(2)} 条助手消息插一条`)

// ---- 按轮分组 ----
const turns = []
let current = null
for (const one of filtered) {
  if (one.type === 'turn') {
    current = { turn: one.turn, at: one.time, inj: [], tools: 0 }
    turns.push(current)
    continue
  }
  if (current === null) {
    current = { turn: '?', at: one.time, inj: [], tools: 0 }
    turns.push(current)
  }
  if (one.type === 'tool') current.tools += 1
  const label = labelOf(one)
  if (label !== '') current.inj.push(label)
}
console.log('\n== 按轮 ==')
console.log('轮  工具  注入  明细')
for (const one of turns) {
  const detail = one.inj.length === 0 ? '' : (() => {
    const m = new Map()
    for (const label of one.inj) m.set(label, (m.get(label) ?? 0) + 1)
    return [...m].map(([k, v]) => `${k}×${v}`).join(' ')
  })()
  console.log(String(one.turn).padStart(3), String(one.tools).padStart(5), String(one.inj.length).padStart(5), ' ', detail)
}

// ---- 工作流触发的前一步工具（区分只读 / 改动）----
const MUTATING = new Set(['write', 'edit', 'pwsh', 'bash', 'puzzle_mode'])
const byTool = new Map()
let lastTool = ''
for (const one of filtered) {
  if (one.type === 'tool') lastTool = one.name
  if (one.type === 'user' && one.text.includes('【拼图模式 · 工作流触发】')) {
    const kind = MUTATING.has(lastTool) ? '改动' : '只读'
    const key = `${lastTool}(${kind})`
    byTool.set(key, (byTool.get(key) ?? 0) + 1)
  }
}
console.log('\n== 工作流触发的前一步工具 ==')
for (const [key, n] of [...byTool].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(5), key)

// ---- 工作流触发的正文去重 ----
const wfBodies = new Map()
for (const one of filtered) {
  if (one.type !== 'user' || !one.text.includes('【拼图模式 · 工作流触发】')) continue
  const names = [...one.text.matchAll(/^### (.+)$/gm)].map((m) => m[1]).join(' + ')
  wfBodies.set(names, (wfBodies.get(names) ?? 0) + 1)
}
console.log('\n== 工作流触发正文（命中集合）==')
for (const [names, n] of [...wfBodies].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(5), names)

if (perTurn) {
  console.log('\n== 最后 5 条注入的时间 ==')
  for (const one of filtered.filter((x) => labelOf(x) !== '').slice(-5)) {
    console.log('  ', fmt(one.time), labelOf(one))
  }
}
