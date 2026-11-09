# v2.5.0 · 还原古早的「绑定会话模式」，与面板模式并存

> 装完**必须重启客户端**才生效。

## 摘要

v2.0.0 曾把入口整个换成「侧边栏 + 主区面板」。这一版把「输入框左侧那颗按钮 + 浮窗」请回来，作为**会话模式**，与面板模式并存：面板常驻，会话模式默认不启用，点那颗按钮才算启用——而且是真的给这个会话装上 `puzzle_mode` 工具与拼图规则。浮窗里只有文档视图，没有主题页和更新页。

---

## 两个模式，各管一段

| 模式 | 入口 | 默认 | 管什么 |
| --- | --- | --- | --- |
| **面板模式** | 侧边栏「拼图」→ 主区工作台 | **常驻** | 全局：数据工作区下的全部项目，看板、主题、更新都在这 |
| **会话模式** | **输入框左侧那颗「拼图」** | **不启用** | 这一个会话：它自己选中的那一个项目，只有文档视图 |

## 「启用」是字面意思

点按钮不只是开个浮窗，它走 `sessionMode action:'enable'`：

1. `sessionController.resolveAgent(sessionId)` 拿到这个会话的 **agent**（返回的是信封 `{agent}`，不是 agent 本身——v2.1.6 踩过这个坑）；
2. `installSessionTools(agent)` 把 `puzzle_mode` 与拼图规则段装进**这个会话的作用域**；
3. **装成功了才** `enableSessionMode(sessionId)` 登记。

第 3 步的顺序是刻意的：**先装、装成了再记**。反了会造出「名单里有、实际没装」的假记录——钩子于是去管一个没有 `puzzle_mode` 的会话，模型照规则调工具然后撞「不存在」。这个顺序在测试里用变异验证过。

## 关掉只说真话

`action:'disable'` 只清设置里的登记、浮窗不再出现。**已经注册进那个会话的工具拿不回来**——宿主 `tools.register` 的 disposer 属于装配那一刻的作用域，这里没有它的句柄。

所以关闭提示的原文是：「已经装进这个会话的工具与规则**没有卸载**」。把「关不掉」写成「已关闭」，用户会以为工具也走了。

## 浮窗为什么没有主题页和更新页

那两页是**全局**的（主题是整机皮肤、更新是整包升级）。塞进「这个会话的浮窗」会让语义错位：用户会以为「在这个会话里换主题 / 升级」。

所以浮窗只有文档视图：**选项目 → 主文档全文 + 模块标签 + 健康性**。

## 项目绑定与面板各管各的

会话模式读写的都是 `sessionMode[sessionId].project`，**从不碰**面板的 `openProject`。于是「面板在看 A 项目、会话模式在看 B 项目」是合法状态，不需要谁去同步谁。

## 改了哪些文件

| 文件 | 改动 |
| --- | --- |
| `lib/settings.js` | 新增 `sessionMode` 字段（`会话 id → {project}`，默认空表）+ `sessionModeOf` / `enableSessionMode` / `disableSessionMode` / `setSessionModeProject` |
| `lib/puzzle.js` | barrel 导出四个新函数 |
| `lib/index.js` | 新增 `rpcSessionMode`（`state` / `enable` / `disable` / `project` 四个 action），注册进 `RPC_HANDLERS` |
| `lib/client.js` | 新增 `SessionModeButton` + `SessionModeFloat`；注册 `conversation.input.left` 与 `shell.overlay`；新增浮窗 CSS（11 条规则）；`Button` 那段注释改写 |
| `test/smoke.test.mjs` | 新增 5 条断言 |

## 验证

- 冒烟 **71 项通过**（原 66 + 新增 5）。
- **7 个变异全部被抓到**：默认值改成总是启用 / 解析时丢条目 / 不真装工具却当成功 / 装失败也继续登记 / 按钮注册到错误槽位 / 两个模式用同一 id / 浮窗改成拉主题。
- 27 个 `lib/*.js` 语法全过；跨插件 18/0；安装规范 ✓；文档门禁 799 条出处 / 失效 0。
- 安装副本 54/54 逐字节一致，清空后重解包，双向无残留。
- 宿主侧实测注册状态：`conversation.input.left` → `registrant:"dsh-puzzle-mode" id:"puzzle-session-mode" active:true`；面板的 `sidebar.panellist` 与 `main` 同时仍在。

## 未验证

**没有在真机 DSH 客户端里点过那颗按钮。** 冒烟测的是纯函数、源码契约与注册事实；宿主侧 `resolveAgent → installSessionTools` 那条真实链路只在离线夹具里走过。浮窗的实际观感、输入框左侧的位置、与面板同时打开时的遮挡关系，都没在真实界面里看过。

## 升级注意

- 会话模式**默认不启用**，你原有的面板用法一点没变。
- 想用会话模式：在输入框左侧点一下「拼图」，它会启用并弹出浮窗。
- 装完**重启 DSH 客户端**。

---

## 安装

**方式一 · 插件管理器（推荐）**

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v2.5.0
```

**方式二 · 下载附件**

下载下面的 `dsh-puzzle-mode-2.5.0.tgz`，用插件管理器的 `import` 装本地压缩包。

**方式三 · 面板一键更新**

面板「更新」页 → 「一键更新到 v2.5.0」。

装完**重启 DSH 客户端**。
