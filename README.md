# dsh-puzzle-mode · 拼图模式

> DSH（DeepSeek Harness）插件：把项目拆成 **主文档 + 若干模块文档**，让 AI 主动提问、
> 把不确定项变成已定项，并在输入框的**模型选择器左边**放一个显示**项目健康性**与五维的小按钮。

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
| `list` | 列出现有项目（名字 / 模式 / 健康性 / 模块数 / 更新时间）并标出默认用哪个 |
| `read` | 读状态（不建文件）：项目、模式、模块、**五维健康性** |
| `show` | 读某个模块文档的详情（要点 / 相关决策 / 详细记录），不建文件 |
| `init` | 新建项目：主文档 + N 份模块文档，一次建齐 |
| `main` | 更新主文档六节之一：`index` / `pit` / `quote` / `pending` / `decided` / `revoked` |
| `module` | 更新（必要时创建）模块文档：`progress` / `points` / `related` / `detail` |
| `health` | 写五维健康性（带 `name` 写模块，不带则写项目级缺省值） |
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

- `conversation.input.left`（模型选择器左边）小按钮：拼图图标 + 当前**项目健康性**百分比；
- 点开 `shell.overlay` 弹出面板：项目路径、健康性进度条、**五维条**（跨模块均值）、
  **模块图块**（未建的显示「未建」）；
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

## 项目健康性怎么算

五个维度，**每一维 0-100、越高越好**（含「维护系数」——高分表示维护负担轻）：

| 维度 | 含义 |
| --- | --- |
| 任务复杂度 | 模块实际承担的任务量；记下的要点与细节越多越完整 |
| 可拓展性 | 还能往哪里长：悬而未决与已定的决策越多，扩展空间越清晰 |
| 维护系数 | 维护负担轻的程度（高分 = 好维护）：要点写清了才敢改 |
| 代码质量 | 坑与决策的沉淀程度：踩过的坑记下来了，质量才站得住 |
| 可复用性 | 有多少可被别处复用的东西（共享模块、公共接口、抽象） |

**两条取值路径，显式优先：**

1. **显式写**：模块文档的 `## 健康性` 里一行一维，如 `任务复杂度: 80`。
   写 `维护成本: 30`（成本型）会被自动翻成 `维护系数: 70`。
2. **由文档证据推导**（没写时）：从 `## 要点`、`## 详细记录`、`悬而未决`、`已定`、主文档的 `## 坑` 计数推导。

```
任务复杂度 = 要点×12 + 详细记录×10
可拓展性   = 悬而未决×20 + 已定×20
维护系数   = 要点×18 + 详细记录×8
代码质量   = 坑×25 + 已定×15
可复用性   = 共享条目×30 + 要点×10

模块健康性 = 五维均值
项目健康性 = 各模块健康性的均值
```

**这是设计意图，不是缺陷**：健康性反映的是「已经写在文档里的证据」，不是模型凭感觉打的印象分。
空模块五维全 0——不是"看起来还行给 60"。想让数字涨，就真的把内容写进去。

返回里带 `sources`（每维是 `module` / `project` / `derived`），面板据此能区分
"评估过的" 和 "公式推出来的"。项目健康性由宿主汇总，**不要在文档里手写总分**。

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
# 四组共 45 项，都不需要 Cordis 运行时或浏览器：
#   test/10-puzzle.test.mjs       目录守卫、多文档创建、小节合并、固定收尾问、
#                                 五维健康性（显式 / 推导 / 反向维度 / 跨模块汇总）、
#                                 list 摘要、模块详情、括号行不误判、modeSource
#   test/20-client.test.mjs       bundle 格式、两个 Slot 注册、图块点开详情、
#                                 提问模板走 setDraft 且不自动发送
#   test/30-rpc.test.mjs          /puzzle-mode-rpc 的鉴权、参数与返回值（含 list/module/五维）
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
