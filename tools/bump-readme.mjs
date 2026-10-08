/**
 * 发版时同步 README 里的版本号引用（幂等，跑几次都一样）。
 *
 *   node tools/bump-readme.mjs 1.0.0 0.30.0
 *
 * 为什么写成脚本而不是手改：README 里版本号出现在**三处**（最新版行、安装命令、
 * 附件链接），手改漏一处的后果是「按 README 装不到对应版本」——而且不会报错。
 * 上一轮我就是在 PowerShell 里做字符串替换，反引号与 `$` 反复把替换搞成静默不匹配，
 * 所以这里改成 Node 脚本：**替换没生效就明确报错**。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const next = process.argv[2]
const prev = process.argv[3]
if (typeof next !== 'string' || next === '') {
  console.error('用法: node tools/bump-readme.mjs <新版本> [旧版本]')
  process.exit(1)
}

/** 逐处替换；每处都必须命中，否则报错退出（静默不匹配 = 文档与包不一致）。 */
const EDITS = [
  {
    label: '最新版行',
    file: 'README.md',
    from: prev === undefined ? null : `- 最新版：**v${prev}**`,
    to: `- 最新版：**v${next}**`,
  },
  {
    label: '安装命令',
    file: 'README.md',
    from: prev === undefined ? null : `dsh-puzzle-mode v${prev}`,
    to: `dsh-puzzle-mode v${next}`,
  },
  {
    label: '附件链接',
    file: 'README.md',
    from: prev === undefined ? null : `releases/download/v${prev}/dsh-puzzle-mode-${prev}.tgz`,
    to: `releases/download/v${next}/dsh-puzzle-mode-${next}.tgz`,
  },
  {
    label: '附件文件名',
    file: 'README.md',
    from: prev === undefined ? null : `[dsh-puzzle-mode-${prev}.tgz]`,
    to: `[dsh-puzzle-mode-${next}.tgz]`,
  },
  {
    label: 'UI.md 头部',
    file: 'UI.md',
    from: prev === undefined ? null : `> 对应 v${prev}。`,
    to: `> 对应 v${next}。`,
  },
]

let failed = 0
for (const edit of EDITS) {
  const path = join(root, edit.file)
  const text = readFileSync(path, 'utf8')
  if (edit.from === null) {
    console.log(`跳过（没给旧版本）：${edit.label}`)
    continue
  }
  if (text.includes(edit.to)) {
    console.log(`已经是新版，跳过：${edit.label}`)
    continue
  }
  if (!text.includes(edit.from)) {
    console.error(`✗ 找不到要替换的片段（${edit.label}）：${edit.from}`)
    failed += 1
    continue
  }
  writeFileSync(path, text.split(edit.from).join(edit.to))
  console.log(`✓ ${edit.label}：${edit.file}`)
}

// PUBLISH 第 0 节的版本行单独处理：它是一整段长文本，用「版本 | vX.Y.Z」这个前缀定位。
{
  const path = join(root, 'PUBLISH.md')
  const text = readFileSync(path, 'utf8')
  const marker = '| 版本 | v'
  const at = text.indexOf(marker)
  if (at < 0) {
    console.error('✗ PUBLISH.md 里找不到「| 版本 | v」这一行')
    failed += 1
  } else if (prev !== undefined && text.slice(at).startsWith(`| 版本 | v${next}`)) {
    console.log('已经是新版，跳过：PUBLISH 第 0 节')
  } else if (prev !== undefined && !text.slice(at).startsWith(`| 版本 | v${prev}`)) {
    console.error('✗ PUBLISH.md 第 0 节的版本不是 ' + prev + '（先确认现状再改）')
    failed += 1
  } else if (prev !== undefined) {
    const head = text.slice(0, at) + `| 版本 | v${next}`
    const tail = text.slice(at + `| 版本 | v${prev}`.length)
    writeFileSync(path, head + tail)
    console.log('✓ PUBLISH 第 0 节版本号已改（正文说明需手工补）')
  }
}

process.exit(failed === 0 ? 0 : 1)
