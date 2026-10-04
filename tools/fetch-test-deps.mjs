/**
 * 把 @deepseek-ai/dsh-tools 的真实产物解到 node_modules 下（不走 npm 解析器）。
 *
 * 为什么需要这个脚本：本仓的 30-rpc / 40-pre-execute / 60-loopguard 三个测试文件
 * 在**没装 dsh-tools** 时会 `skip` 退出——那是对的（不该在裸克隆上红），
 * 但后果是「RPC 路由与 pre-execute 拦截」这两块**在本地从来没被真跑过**。
 * 而 npm 的解析器因为 peer 冲突（dsh-tools 要 dsh-llm@^0.1.7-alpha.1，
 * 而 profile 里是 rc.2）不肯装它。这个脚本绕开解析器，只取 tarball 解包。
 *
 * 它**只为本机测试服务**：解出来的目录在 node_modules/ 下，已被 .gitignore 忽略，
 * 不会进包、不会进版本库。CI 里若装得上就直接 npm install，不必用这个。
 *
 *   node tools/fetch-test-deps.mjs
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, renameSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const nodeModules = join(root, 'node_modules')
const scopeDir = join(nodeModules, '@deepseek-ai')

const WANT = process.argv[2] || '@deepseek-ai/dsh-tools@0.1.7-alpha.1'

/**
 * `--all` 的清单：跑满全部测试套件所需的**完整依赖闭包**。
 *
 * 为什么要一次装全、而不是一个个装：npm 的解析器因为 peer 冲突（dsh-tools 要
 * dsh-llm@^0.1.7-alpha.1，而 profile 里是 rc.2）**不肯保留** dsh-tools——
 * 每跑一次 `npm install` 就把它连同别的一起删掉（实测「added 1, removed 21」）。
 * 所以顺序是：先用 npm 装闭包里 npm 肯装的部分，再用这个脚本把 dsh-tools / cordis
 * 这类被剪掉的手动放回去。这条命令就是那个「放回去」的收尾。
 */
const CLOSURE = [
  '@deepseek-ai/cordis@4.0.3',
  '@deepseek-ai/dsh-tools@0.1.7-alpha.1',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/dsh-brand@0.1.7-alpha.1',
  '@deepseek-ai/dsh-util-values@0.1.7-alpha.1',
  '@deepseek-ai/schemastery@3.18.3',
  '@deepseek-ai/dsh-agent@0.1.7-alpha.1',
  '@deepseek-ai/dsh-ptc-runtime@0.1.7-alpha.1',
  '@deepseek-ai/dsh-invariants@0.1.7-alpha.1',
  '@deepseek-ai/dsh-llm@0.1.7-alpha.1',
  '@deepseek-ai/dsh-scope@0.1.7-alpha.1',
  '@deepseek-ai/dsh-session@0.1.7-alpha.1',
  '@deepseek-ai/dsh-system-prompt@0.1.7-alpha.1',
  '@deepseek-ai/dsh-user-approval@0.1.7-alpha.1',
  '@deepseek-ai/dsh-sandbox@0.1.7-alpha.1',
  '@deepseek-ai/dsh-sandbox-policy@0.1.7-alpha.1',
  '@deepseek-ai/dsh-timeout@0.1.7-alpha.1',
  '@deepseek-ai/dsh-typert-protocol@0.1.7-alpha.1',
  '@deepseek-ai/dsh-util-crypto@0.1.7-alpha.1',
]

async function registryMeta(name) {
  const url = 'https://registry.npmjs.org/' + name.replace('/', '%2F')
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
  if (res.status !== 200) throw new Error('registry HTTP ' + res.status + ' for ' + name)
  return res.json()
}

const at = WANT.lastIndexOf('@')
const name = WANT.slice(0, at)
const version = WANT.slice(at + 1)

/** 装一个包（registry 拿元数据 → 下 tarball → 解到 node_modules）。 */
async function installOne(want) {
  // 作用域名（`@scope/name`）本身以 `@` 开头，所以版本分隔符要**从第 1 个字符之后**找：
  // 从 0 找的话 `@deepseek-ai/cosmokit` 会被切成 name='' / version='deepseek-ai/cosmokit'。
  const cut = want.indexOf('@', 1)
  const pkgName = cut < 0 ? want : want.slice(0, cut)
  const wantVersion = cut < 0 ? '' : want.slice(cut + 1)
  console.log('查 registry：' + pkgName)
  const meta = await registryMeta(pkgName)
  // 没写版本（`@deepseek-ai/cosmokit`）就走 dist-tags.latest；写了就认那个版本。
  const version2 = wantVersion === '' ? meta['dist-tags'].latest : wantVersion
  const entry = meta.versions[version2]
  if (entry === undefined) throw new Error('registry 里没有 ' + pkgName + '@' + version2)
  const tarball = entry.dist.tarball
  console.log('下载 ' + pkgName + '@' + version2)

  const res = await fetch(tarball, { signal: AbortSignal.timeout(120000) })
  if (res.status !== 200) throw new Error('tarball HTTP ' + res.status)
  const buf = Buffer.from(await res.arrayBuffer())

  const tmpDir = join(root, '.tmp-dep-' + pkgName.replace(/[@/]/g, '_'))
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  const tgz = join(tmpDir, 'pkg.tgz')
  writeFileSync(tgz, buf)
  // Windows 自带 tar（bsdtar），能解 .tgz。
  execFileSync('tar', ['-xzf', tgz, '-C', tmpDir], { stdio: 'ignore' })

  const pkgRoot = join(tmpDir, 'package')
  const dest = join(scopeDir, pkgName.split('/')[1])
  mkdirSync(scopeDir, { recursive: true })
  rmSync(dest, { recursive: true, force: true })
  try {
    renameSync(pkgRoot, dest)
  } catch (_error) {
    mkdirSync(dest, { recursive: true })
    for (const entryName of readdirSync(pkgRoot)) {
      renameSync(join(pkgRoot, entryName), join(dest, entryName))
    }
  }
  rmSync(tmpDir, { recursive: true, force: true })
  const installed = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))
  console.log('  ✓ ' + installed.name + '@' + installed.version + '（' + Math.round(buf.length / 1024) + 'KB）')
}

if (WANT === '--all') {
  console.log('装完整测试依赖闭包（' + CLOSURE.length + ' 个包）…\n')
  let failedCount = 0
  for (const want of CLOSURE) {
    try {
      await installOne(want)
    } catch (error) {
      failedCount += 1
      console.error('  ✗ ' + want + '：' + (error && error.message ? error.message : String(error)))
    }
  }
  console.log('')
  console.log(failedCount === 0
    ? '全部就绪。现在可以跑：npm test（30-rpc / 40-pre-execute / 60-loopguard 不再 skip）'
    : failedCount + ' 个包没装上——上面有逐条原因。')
  process.exit(failedCount === 0 ? 0 : 1)
}

console.log('查 registry：' + name)
const meta = await registryMeta(name)
const entry = meta.versions[version]
if (entry === undefined) throw new Error('registry 里没有 ' + WANT)
const tarball = entry.dist.tarball
console.log('下载 ' + tarball)

const res = await fetch(tarball, { signal: AbortSignal.timeout(120000) })
if (res.status !== 200) throw new Error('tarball HTTP ' + res.status)
const buf = Buffer.from(await res.arrayBuffer())
console.log('大小 ' + buf.length + ' 字节')

const tmpDir = join(root, '.tmp-dep-' + version)
rmSync(tmpDir, { recursive: true, force: true })
mkdirSync(tmpDir, { recursive: true })
const tgz = join(tmpDir, 'pkg.tgz')
writeFileSync(tgz, buf)

// Windows 自带 tar（bsdtar），能解 .tgz。
execFileSync('tar', ['-xzf', tgz, '-C', tmpDir], { stdio: 'inherit' })

const pkgRoot = join(tmpDir, 'package')
const dest = join(scopeDir, name.split('/')[1])
mkdirSync(scopeDir, { recursive: true })
rmSync(dest, { recursive: true, force: true })
// 直接改名会跨设备失败的风险；同盘则 rename 最快，失败就退回逐项复制。
try {
  renameSync(pkgRoot, dest)
} catch (_error) {
  mkdirSync(dest, { recursive: true })
  for (const entryName of readdirSync(pkgRoot)) {
    renameSync(join(pkgRoot, entryName), join(dest, entryName))
  }
}
rmSync(tmpDir, { recursive: true, force: true })

const installed = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))
console.log('已安装到 node_modules：' + installed.name + '@' + installed.version)
console.log('现在可以跑：npm test（30-rpc / 40-pre-execute / 60-loopguard 不再 skip）')
