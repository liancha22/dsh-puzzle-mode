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
| `read` | 读状态（不建文件）：项目、模式、模块、图块、总完整度 |
| `init` | 新建项目：主文档 + N 份模块文档，一次建齐 |
| `main` | 更新主文档六节之一：`index` / `pit` / `quote` / `pending` / `decided` / `revoked` |
| `module` | 更新（必要时创建）模块文档：`progress` / `points` / `related` / `detail` |
| `mode` | 切换执行模式 |

每次返回都带 `askPause: true` 与固定收尾问的原文，确保模型不会漏问。

**3. 两种执行模式**

| 模式 | 提问 | 文档 | 执行（bash / write / edit …） |
| --- | --- | --- | --- |
| 只拼不写 | 可以（每次带固定收尾问） | 可以 | **禁止**（由宿主 `agent/pre-step` 拦下越权工具） |
| 边拼边写 | 小改动问一次、大改动问一次 | 可以 | 允许 |

**4. 拼图面板 UI**

- `conversation.input.left`（模型选择器左边）小按钮：拼图图标 + 当前完整度百分比；
- 点开 `shell.overlay` 弹出面板：项目路径、总完整度进度条、**图块网格**
  （11 类：初始化 + 主文档六节 + 每个模块一块，未建的显示「未建」）；
- 面板底部可直接切换两种模式（写回主文档 front-matter，与工具口径同一份数据）。

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
# 四组，都不需要 Cordis 运行时或浏览器（跑到最后一组时，按文件名顺序执行）：
#   test/10-puzzle.test.mjs   目录守卫、多文档创建、小节合并、计分定值、固定收尾问
#   test/20-client.test.mjs   浏览器 bundle 格式、两个 Slot 的注册契约、首渲染
#   test/30-rpc.test.mjs      /puzzle-mode-rpc 的鉴权、参数与返回值
#   test/40-pre-step.test.mjs 只拼不写拦截 / 边拼边写放行
```

最后一组要 import 宿主半，因此需要 `@deepseek-ai/dsh-tools` 能被解析——也就是插件已装进
某个 DSH profile（运行时提供）。在没装 DSH 的裸目录里跑，这一组会明确输出跳过原因而不是报错。
