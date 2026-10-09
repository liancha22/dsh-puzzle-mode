/**
 * 建 Release（或更新已有 Release 的正文），走 api.github.com（本机可达）。
 *
 *   node tools/make-release.mjs <tag> <正文文件>
 *
 * 为什么走 api.github.com 而不是 github.com：本机实测 github.com:443 **不通**
 * （见 v1.1.1 的排查），api.github.com 通。
 */
import { readFileSync } from 'node:fs'

const [, , tag, bodyFile] = process.argv
if (typeof tag !== 'string' || tag === '' || typeof bodyFile !== 'string' || bodyFile === '') {
  console.error('用法: node tools/make-release.mjs <tag> <正文文件>')
  process.exit(1)
}
const token = readFileSync('C:/Users/admin/.dsh/.github-token', 'utf8').trim()
const body = readFileSync(bodyFile, 'utf8')
const slug = 'liancha22/dsh-puzzle-mode'
const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'content-type': 'application/json',
  'user-agent': 'dsh-puzzle-mode-release',
}

async function api(url, init) {
  const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(60000) })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON */
  }
  return { status: response.status, json, text }
}

// 1) 已存在就改正文（幂等），不存在就建。
const list = await api(`https://api.github.com/repos/${slug}/releases?per_page=100`)
if (list.status !== 200) {
  console.error(`✗ 列 Release 失败：HTTP ${list.status} ${list.text.slice(0, 200)}`)
  process.exit(1)
}
const existing = (list.json ?? []).find((one) => one.tag_name === tag)

let release = null
if (existing !== undefined) {
  const patched = await api(`https://api.github.com/repos/${slug}/releases/${existing.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ body, name: tag, draft: false, prerelease: false }),
  })
  if (patched.status !== 200) {
    console.error(`✗ 更新 Release 失败：HTTP ${patched.status} ${patched.text.slice(0, 300)}`)
    process.exit(1)
  }
  release = patched.json
  console.log(`✓ 已更新已有 Release ${tag}（id ${release.id}）`)
} else {
  const created = await api(`https://api.github.com/repos/${slug}/releases`, {
    method: 'POST',
    body: JSON.stringify({
      tag_name: tag,
      name: tag,
      body,
      draft: false,
      prerelease: false,
    }),
  })
  if (created.status !== 201) {
    console.error(`✗ 建 Release 失败：HTTP ${created.status} ${created.text.slice(0, 300)}`)
    process.exit(1)
  }
  release = created.json
  console.log(`✓ 已建 Release ${tag}（id ${release.id}）`)
}

console.log(`  正文 ${body.length} 字符`)
console.log(`  附件上传地址：${release.upload_url}`)
console.log(`  页面：${release.html_url}`)
