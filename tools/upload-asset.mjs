/**
 * 往 Release 传附件（走 uploads.github.com，本机可达）。
 *
 *   node tools/upload-asset.mjs <release id> <文件路径>
 *
 * 传之前先删同名旧附件：GitHub 对重名附件会存成 `xxx-1.tgz`，
 * 而面板按固定文件名找它——留着旧的会让「下载到的版本」与「显示的版本」不一致。
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const [, , releaseId, file] = process.argv
if (typeof releaseId !== 'string' || releaseId === '' || typeof file !== 'string' || file === '') {
  console.error('用法: node tools/upload-asset.mjs <release id> <文件路径>')
  process.exit(1)
}
const token = readFileSync('C:/Users/admin/.dsh/.github-token', 'utf8').trim()
const slug = 'liancha22/dsh-puzzle-mode'
const name = basename(file)
const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-puzzle-mode-release',
}

// 1) 删同名旧附件。
const listed = await fetch(`https://api.github.com/repos/${slug}/releases/${releaseId}/assets?per_page=100`, {
  headers,
  signal: AbortSignal.timeout(60000),
})
const assets = listed.status === 200 ? await listed.json() : []
for (const asset of assets) {
  if (asset.name !== name) continue
  const deleted = await fetch(`https://api.github.com/repos/${slug}/releases/assets/${asset.id}`, {
    method: 'DELETE',
    headers,
    signal: AbortSignal.timeout(60000),
  })
  console.log(`  删旧附件 ${asset.name}（id ${asset.id}）→ HTTP ${deleted.status}`)
}

// 2) 传新的。
const bytes = readFileSync(file)
const uploaded = await fetch(
  `https://uploads.github.com/repos/${slug}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
  {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/gzip' },
    body: bytes,
    signal: AbortSignal.timeout(180000),
  },
)
const text = await uploaded.text()
if (uploaded.status !== 201) {
  console.error(`✗ 上传失败：HTTP ${uploaded.status} ${text.slice(0, 300)}`)
  process.exit(1)
}
const json = JSON.parse(text)
console.log(`✓ 已上传 ${json.name}：${json.size} 字节`)
console.log(`  下载地址：${json.browser_download_url}`)
