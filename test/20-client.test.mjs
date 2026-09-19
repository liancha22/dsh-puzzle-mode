/**
 * 浏览器半的「无浏览器」冒烟测试。
 *
 * bundle 是手写的 `window.__ModuleLoader__.load({ id, factory })`，所以这里造一个
 * 最小 window/document/React 替身，真的把 factory 跑起来、再真的调一次 `apply`，
 * 验证两个 Slot 注册的 id/order/name 都符合契约。
 *
 *   node test/20-client.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let loaded = null
const fakeWindow = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry
    },
  },
  setInterval() {
    return 1
  },
  clearInterval() {},
  addEventListener() {},
  removeEventListener() {},
}

const fakeReact = {
  createElement(type, props, ...children) {
    return { type: type, props: props === null || props === undefined ? {} : props, children: children }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, function () {}]
  },
  useEffect() {},
}

// 最小的 window 替身：让 bundle 顶层能安全执行。
const run = new Function('window', 'document', 'fetch', source)
run(fakeWindow, { createElement: () => ({ setAttribute() {}, textContent: '' }), head: { appendChild() {} }, body: {} }, () => Promise.reject(new Error('no fetch in test')))

assert.ok(loaded !== null, 'bundle 必须调用 window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-puzzle-mode')
assert.equal(typeof loaded.factory, 'function')

const mod = loaded.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error('unexpected require: ' + name)
})
assert.equal(typeof mod.apply, 'function')

const registered = []
const slots = {
  inject(name, callback) {
    registered.push(['inject', name])
    callback()
    return () => {}
  },
  register(options, component) {
    registered.push(['register', options, component])
    return () => {}
  },
}

let effects = 0
mod.apply({
  get(name) {
    return name === 'slots' ? slots : undefined
  },
  effect() {
    effects += 1
    return () => {}
  },
})

const registrations = registered.filter((row) => row[0] === 'register')
assert.equal(registrations.length, 2, '应注册两个 Slot')
const button = registrations.find((row) => row[1].name === 'conversation.input.left')
const panel = registrations.find((row) => row[1].name === 'shell.overlay')
assert.ok(button !== undefined, '按钮必须挂在 conversation.input.left（模型选择器左边）')
assert.equal(button[1].id, 'puzzle-mode-button')
assert.equal(button[1].order, 100)
assert.equal(typeof button[2], 'function')
assert.ok(panel !== undefined, '面板必须挂在 shell.overlay')
assert.equal(panel[1].id, 'puzzle-mode-panel')
assert.equal(panel[1].order, 50)
assert.ok(effects >= 1, '样式注入必须挂在 ctx.effect 上（可随 Fiber 卸载）')

// 两个组件都能被渲染调用（不抛错即通过）。
const buttonTree = button[2]({ sessionId: 'session-x' })
assert.equal(buttonTree.type, 'button')
const panelTree = panel[2]({})
assert.equal(panelTree, null, '未打开时面板不渲染任何东西')

console.log('ok   bundle 格式、两个 Slot 注册与组件首渲染均通过')
