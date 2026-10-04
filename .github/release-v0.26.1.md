# v0.26.1 · 修 op:audit 带源码体检必失败

## 一句话

`puzzle_mode{op:'audit'}` 只要带源码体检，之前**一律失败**；现在正常了。
这是 v0.26.0 里就存在的一个返回体形状问题，与文档、与你的代码都无关。

## 症状

```
Error: tool "puzzle_mode" returned invalid output: value is not lossless JSON
```

出现条件：**带源码体检**（`source` 默认就是 `true`，也就是它的主用法）。
绕过方式是显式传 `source:false` —— 但那等于放弃了源码体检，
而体检正是 `op:audit` 用来发现「巨函数 / 没分层 / 死导出」的唯一途径。

## 根因

宿主对工具返回做「无损 JSON」校验：返回值必须能
`JSON.parse(JSON.stringify(x))` **原样往返**。**显式 `undefined` 过不了这一关**——

```js
{ file: undefined }  →  JSON.stringify  →  "{}"  →  JSON.parse  →  {}   // 丢失了 file
```

`lib/index.js` 把源码体检的发现并进 `findings` 时，无条件写了 `file: item.file`。
而其中两条是**项目级**发现，本来就没有单个文件：

| 发现 | 事实 |
| --- | --- |
| `source_flat` | 「38 个源码文件全在同一层目录（.）」 |
| `source_long_function`（截断提示） | 「另有 N 个函数也超过阈值，未逐条列出」 |

它们没有 `file`，于是 `file: item.file` 写出了一个**显式的** `undefined` 属性。

## 修法

字段**要么是字符串、要么根本不存在**：

```js
...(typeof item.file === 'string' && item.file !== '' ? { file: item.file } : {}),
```

带 `file` 的发现照旧带 `file`（没修成一律不带）；项目级的那两条不再带 `file` 键。

## 验收判据

| 验证项 | 判据 |
| --- | --- |
| 主用法可用 | `op:audit`（带源码体检）成功返回，不再报 `not lossless JSON` |
| 返回体无损 | 整个返回能 `JSON.parse(JSON.stringify(x))` 深比较相等 |
| 项目级发现不带 file | 造出「7 个同层文件」时 `source:source_flat` 命中，且**没有** `file` 键 |
| 带 file 的照旧带 | 所有 `source:*` 里存在的 `file` 都必须是**非空字符串** |
| 没修过头 | `source:false` 仍可用，且不含任何源码发现 |
| 全量 | `npm test` 全绿：60 + 47 + 7 + 51 + 13 + 36 + 12 + 5；跨插件握手 18 / 0 |

## 新增测试

`test/90-audit-tool.test.mjs`（5 项）。它**不钉某个具体字段**，而是断言
**整个返回**能无损往返 —— 这条判据不管以后哪个字段被写成 `undefined` 都会红。

为了让 `source_flat` 真的出现，测试会造出「7 个源码文件、只有一层目录」的形状
（只造 3 个文件不会命中，那样测试就是假的）。

## 诊断过程（为什么值得单独记）

`inspectSource` 与 `auditOf` **单独跑都是可序列化的** ——
所以问题只可能在「组装工具返回」那一段，而那一段**只有真调一次工具才覆盖得到**。
这就是为什么加的是**工具级**测试，而不是给 `lib/source.js` 补单测：
单测会全绿，而真机照旧报错。

## 装

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.26.1
```

或在**插件市场**点更新。装完**重启该 profile**，再刷新浏览器页面。
