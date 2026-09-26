# dsh-puzzle-mode · 拼图模式

> DSH（DeepSeek Harness）插件：把项目拆成 **主文档 + 若干模块文档**，让 AI 主动提问、
> 把不确定项变成已定项，并在输入框的**模型选择器左边**放一个显示完整度与图块的小按钮。

仓库：<https://github.com/liancha22/dsh-puzzle-mode>

不是独立模式：装进宿主组成后，**标准模式（或任何 preset）的会话**都带上它。

## 它做什么

**1. 一段宿主提示段 `puzzle-mode:policy`**（order 10500）——规定四件事：

- AI **主动提问**，一轮 ≤3 问，优先给选项；
- **每一次提问的最后固定问「要不要先停下？」**，两个选项：
  ① 停下，等我看过再说 → 只回写文档 + 一句话说明，本轮立即结束，不执行任何动作；
  ② 继续，不用停 → 按当前模式继续；
- 用户没说明基于某个项目 → 新建；新建时**一次同时创建主文档与每个模块一份文档**；
- 两种执行模式的许可边界（见下）。

**2. 模型工具 `puzzle_mode`**

| op | 作用 |
| --- | --- |
| `list` | 列出现有项目（名字 / 模式 / 完整度 / 模块数 / 更新时间）并标出默认用哪个 |
| `read` | 读状态（不建文件）：项目、模式、模块、图块、总完整度 |
| `show` | 读某个模块文档的详情（要点 / 相关决策 / 详细记录），不建文件 |
| `init` | 新建项目：主文档 + N 份模块文档，一次建齐 |
| `main` | 更新主文档六节之一：`index` / `pit` / `quote` / `pending` / `decided` / `revoked` |
| `module` | 更新（必要时创建）模块文档：`progress` / `points` / `related` / `detail` |
| `mode` | 切换执行模式 |

每次返回都带 `askPause: true` 与固定收尾问的原文，确保模型不会漏问。
每次返回还带 `projectSource`（`explicit` / `latest` / `default`）与 `cwdSource`：
多项目工作区里「用的是哪个项目」、以及「项目根从哪来」都是可见的，不会静默选错。

**3. 两种执行模式**

| 模式 | 提问 | 文档 | 执行（bash / write / edit …） |
| --- | --- | --- | --- |
| 只拼不写 | 可以（每次带固定收尾问） | 可以 | **禁止**（宿主 `tools/pre-execute` 返回 `deny`） |
| 边拼边写 | 小改动问一次、大改动问一次 | 可以 | 允许 |

拦截点是 `tools/pre-execute`（运行时官方钩子，`deny` 的理由会作为该次调用的错误回到模型）。
**不用 `agent/pre-step`**：那个事件的 `decision.messages` 契约是 `UserMessage[]`，里面没有 tool-call，
在它上面做拦截是永远不生效的死代码。

`write` / `edit` 有意**不在**白名单里——它们能绕过 `puzzle_mode` 的 slug 过滤与路径守卫。
文档写入一律走 `puzzle_mode`。

**4. 拼图面板 UI**

- `conversation.input.left`（模型选择器左边）小按钮：拼图图标 + 当前完整度百分比；
- 点开 `shell.overlay` 弹出面板：项目路径、总完整度进度条、**图块网格**
  （初始化 + 主文档六节 + 每个模块一块，未建的显示「未建」）；
- **图块可点开**：点模块块读该模块文档的要点 / 相关决策 / 详细记录；
- **提问模板**：一键把「带固定收尾问」的提问填进输入框（`inputActions.setDraft`），
  **不自动发送**——把「每次提问必带固定收尾问」从"靠模型自觉"变成"UI 直接给模板"；
- 多项目时出现项目下拉；模式切换写回主文档 front-matter，与工具口径同一份数据；
- 拿不到会话工作目录时（`cwdSource !== 'session'`）面板显式警告，不静默写错地方。

## 文档布局

```
<项目根>/<项目名>/拼图/
├── 主文档.md                 # 只做检索、坑、原话、三类决策；每节精简一行
└── 模块/
    ├── auth-flow.md
    └── session-store.md
```

主文档固定六节：`## 检索索引`、`## 坑`、`## 用户原话`、`## 悬而未决`、`## 已定`、`## 撤销`。
撤销不删旧行：`~~旧结论~~ → 改判为 ⇒ 新结论（时间，原因）`。

## 完整度怎么算

确定性算法（不是模型的估计值），九类图块等权平均：

```
初始化 10（六节齐 + 模块文档齐）· 检索索引 行数×20 · 坑/原话 条数×25
悬而未决/已定 条数×20 · 撤销 条数×50 · 模块覆盖（已建/计划）
模块细化（各模块 front-matter 的 完成度:，未填时按要点/详细记录推算）
```

工具返回的 `pieces[]` 与 UI 渲染的是同一份数据，所以两处永远一致。

## 安装

包内声明了 `dsh.bundle.patch`，`dsh plugin add` 会自动把这一行插进 profile 组合，`remove` 自动移除：

```yaml
- insert:
    - id: dsh-puzzle-mode
      name: 'dsh-puzzle-mode'
```

**A. 从 GitHub（推荐，仓库必须 public）**

```bash
# 1) 插件管理器（App 插件页「添加插件」用的就是它；支持标签/分支/子目录）
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.1.0   # 指定标签/分支
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode main/lib # 分支 + 子目录

# 2) dsh CLI 走 pnpm，只认 npm 名或 git 协议（不认 owner/repo）
dsh plugin --profile web add github:liancha22/dsh-puzzle-mode
```

装完**重启该 profile**（`patchReload: startup`），然后刷新浏览器页面。
卸载：`dsh plugin --profile web remove dsh-puzzle-mode`。

**B. 本地目录（开发 / 自测）**

```bash
git clone https://github.com/liancha22/dsh-puzzle-mode ~/.dsh/plugin-src/dsh-puzzle-mode
ln -s ~/.dsh/plugin-src/dsh-puzzle-mode <profile>/node_modules/dsh-puzzle-mode
# 然后在 <profile>/package.json 里加：
#   dependencies:        "dsh-puzzle-mode": "link:/abs/path/to/dsh-puzzle-mode"
#   dsh.profile.bundles: [ ..., "dsh-puzzle-mode" ]
```

本插件不发布任何 Cordis 服务，只消费 `tools` / `systemPrompt` / `webServer` / `sessions`，
除 `@deepseek-ai/dsh-tools`（由运行时提供）外**没有任何依赖**，不需要 `npm install`。
`/sdcard` 这类 FUSE 挂载上读取略慢，源码更适合放在 `plugin-src` 或硬盘目录。

**离线 / 手工**：把 `cordis.patch.yml` 里的 `insert` 段合并进 profile 的 `cordis.patch.yml`（用户补丁层在 bundle 层之后生效）。

## 卸载

从 `dsh.profile.bundles` 与 `dependencies` 里删掉那两行、删掉符号链接、重启。
工作区里的拼图文档不受影响。

## 测试

```bash
npm test
# 四组共 39 项，都不需要 Cordis 运行时或浏览器：
#   test/10-puzzle.test.mjs       目录守卫、多文档创建、小节合并、计分定值、固定收尾问、
#                                 list 摘要、模块详情、括号行不误判、modeSource
#   test/20-client.test.mjs       bundle 格式、两个 Slot 注册、图块点开详情、
#                                 提问模板走 setDraft 且不自动发送
#   test/30-rpc.test.mjs          /puzzle-mode-rpc 的鉴权、参数与返回值（含 list/module）
#   test/40-pre-execute.test.mjs  只拼不写 deny / 边拼边写放行（真实 ToolExecution 契约）
```

最后一组要 import 宿主半，因此需要 `@deepseek-ai/dsh-tools` 能被解析——也就是插件已装进
某个 DSH profile（运行时提供）。在没装 DSH 的裸目录里跑，这一组会明确输出跳过原因而不是报错。

### 一个值得记住的教训

拦截最初写在 `agent/pre-step` 上，并且测试是**绿的**——但那是假绿：
`agent/pre-step` 的 `decision.messages` 契约是 `UserMessage[]`，里面根本没有 tool-call，
所以真实运行时永远走不到那个分支，而测试自己伪造了一条带 tool-call 的 assistant 消息。
换成 `tools/pre-execute`（真实契约：返回 `{kind:'deny',reason}`）后，断言才对得上真实行为。
**写测试时要用权威契约的形状，不要用自己以为的形状。**
