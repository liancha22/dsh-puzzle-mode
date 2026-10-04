#!/usr/bin/env node
/**
 * 拿**本插件自己的校验器**去验一个**主题仓库的实际产物**。
 *
 *   node tools/verify-themes.mjs [主题仓库路径]        # 默认 ../dsh-puzzle-themes
 *   node tools/verify-themes.mjs --remote [owner/repo] # 真联网拉一次（验镜像通道）
 *
 * 为什么需要它（本仓的老教训：「守卫只测纯函数会漏接线断开」）：
 * 主题仓库与插件是**两个仓库**，各自的测试都只测自己那一半——
 * 主题仓库的 `build-index` 只做基础自查，插件侧的 `test/70-themes.test.mjs`
 * 只用构造的假样本。于是「作者写的那份主题真能被插件装上吗」这件事**没人验**，
 * 直到用户在真机上点下去。这个脚本把两边接起来：
 *
 *   读真实 index.json → 用插件的 validateThemeIndex 校验
 *   → 逐个主题用插件的 validateThemeCss 校验 CSS
 *   → 重算 sha256 与清单比对
 *
 * `--remote` 那一档是给「镜像通道」用的：它走**插件真正的下载路径**
 * （`fetchThemeFile` 的多镜像回退），所以能证明 jsDelivr / gh-proxy / raw
 * 到底哪条通——而不是只证明「我本地文件读得出来」。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validateThemeCss,
  validateThemeIndex,
  sha256Hex,
  fetchThemeFile,
  THEME_API_VERSION,
} from '../lib/puzzle.js'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)

let failed = 0
const fail = (msg) => { failed += 1; console.error('FAIL ' + msg) }
const ok = (msg) => console.log('ok   ' + msg)

/* ------------------------------- 远端模式 ------------------------------- */

if (args[0] === '--remote') {
  const repo = args[1] || 'liancha22/dsh-puzzle-themes'
  console.log('走插件真实下载路径拉 ' + repo + ' 的 index.json …')
  const fetched = await fetchThemeFile('index.json', { repo, maxBytes: 128 * 1024 })
  if (fetched.ok !== true) {
    fail('所有镜像都拉不到 index.json：' + fetched.error)
    for (const row of fetched.tried) console.error('  - ' + row.channel + ' → ' + row.error)
    console.log('')
    console.log(failed + ' 项失败')
    process.exit(1)
  }
  ok('镜像通道可用：' + fetched.channel + '（' + fetched.url + '）')
  let parsed = null
  try {
    parsed = JSON.parse(fetched.text)
  } catch (error) {
    fail('远端 index.json 不是合法 JSON：' + error.message)
  }
  if (parsed !== null) {
    const validated = validateThemeIndex(parsed)
    if (validated.ok !== true) fail('远端清单没通过校验：' + validated.error)
    else ok('远端清单通过校验：' + validated.themes.length + ' 套主题（apiVersion=' + THEME_API_VERSION + '）')
  }
  console.log('')
  console.log(failed === 0 ? '远端自检通过' : failed + ' 项失败')
  process.exit(failed === 0 ? 0 : 1)
}

/* ------------------------------- 本地模式 ------------------------------- */

const repo = args[0] || join(here, '..', '..', 'dsh-puzzle-themes')

let index = null
try {
  index = JSON.parse(readFileSync(join(repo, 'index.json'), 'utf8'))
} catch (error) {
  console.error('读不到 ' + join(repo, 'index.json') + '：' + error.message)
  console.error('用法：node tools/verify-themes.mjs [主题仓库路径] | --remote [owner/repo]')
  process.exit(1)
}

const validated = validateThemeIndex(index)
if (validated.ok !== true) fail('插件的 validateThemeIndex 拒绝了 index.json：' + validated.error)
else ok('插件的 validateThemeIndex 接受 index.json（apiVersion=' + THEME_API_VERSION + '）')

if (validated.ok === true) {
  if (validated.themes.length !== index.themes.length) {
    fail('有主题被清单校验丢掉：声明 ' + index.themes.length + ' 套，通过 ' + validated.themes.length + ' 套')
  } else {
    ok('全部 ' + validated.themes.length + ' 套主题都通过了清单校验')
  }
  for (const theme of validated.themes) {
    if (theme.sha256 === '') { fail(theme.id + '：清单里的 sha256 不合法'); continue }
    let css = null
    try {
      css = readFileSync(join(repo, theme.file), 'utf8')
    } catch (_error) {
      fail(theme.id + '：读不到 ' + theme.file)
      continue
    }
    const cssCheck = validateThemeCss(css)
    if (cssCheck.ok !== true) fail(theme.id + '：插件的白名单拒绝了它 —— ' + cssCheck.error)
    else ok(theme.id + '：通过插件白名单（' + cssCheck.bytes + ' 字节）')
    const actual = sha256Hex(css)
    if (actual !== theme.sha256) {
      fail(theme.id + '：sha256 不匹配（清单 ' + theme.sha256.slice(0, 12) + '… 实际 ' + actual.slice(0, 12) + '…）—— 忘了跑 build-index？')
    } else {
      ok(theme.id + '：sha256 与清单一致')
    }
    if (!/--dshpz-/.test(css)) fail(theme.id + '：没有声明任何 --dshpz-* 变量（应用了也不会有变化）')
  }
}

console.log('')
console.log(failed === 0 ? '主题仓库自检通过' : failed + ' 项失败')
process.exit(failed === 0 ? 0 : 1)
