/**
 * 测试用的 `DSH_HOME` 隔离（**必须最先 import**）。
 *
 *   import './helpers/isolate-home.mjs'   // ← 放在其它 import 之前
 *
 * 为什么需要它：v0.26.0 起「固定收尾问」是一个**全局**开关，存在
 * `$DSH_HOME/.dsh-puzzle-mode.json`。测试若不隔离，就会去读**用户真实的设置**——
 * 用户在面板上关掉收尾问之后，`npm test` 里那些「返回必须带收尾问」的断言
 * 立刻变红，而代码一行没错。**测试不该依赖运行者的个人设置。**
 *
 * 为什么必须放在**其它 import 之前**：ESM 的 import 会被提升，模块体在
 * 依赖求值**之后**才跑。写在文件中间赋值 `process.env.DSH_HOME` 是**太晚了**——
 * 那时 `lib/settings.js` 已经求值完，`settingsDir()` 每次调用虽然会重读 env，
 * 但任何在 import 期就缓存了路径的东西都会拿到旧值。
 * 用一个前置的副作用模块，把「先设环境、再加载被测代码」这件事变成 import 顺序，
 * 不靠注释提醒。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'puzzle-home-'))

/** 这个临时 DSH_HOME 的路径（测试想往里写设置文件时用）。 */
export const TEST_DSH_HOME = process.env.DSH_HOME
