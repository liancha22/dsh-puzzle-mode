# 发布 dsh-puzzle-mode

这份部署里 DSH 插件管理器支持的来源：`npm` / `github` / `release` / `download`（任意压缩包 URL）/ `import`（本地压缩包）。

## 0. 状态

| 项 | 现状（2026-10-04） |
| --- | --- |
| 仓库 | <https://github.com/liancha22/dsh-puzzle-mode>（public） |
| 主题仓库 | <https://github.com/liancha22/dsh-puzzle-themes>（**新增**；主题不随插件打包，点一下从它下载） |
| 版本 | v0.25.0（**换主题：主题不在包里，点一下从主题仓库下**。面板右上角一颗主题图标 → 全屏主题管理页：卡片墙 + 「下载并应用」+ 卸载 + 顶部常驻「恢复默认」。① **主题不随插件打包**：`package.json` 的 `files` 里没有任何主题目录、`lib/` 下没有 `.css`，皮肤全部从主题仓库现取；新增两条**双向**守卫（`files` 不含主题目录 **且** 下载通路必须在包里——只测前者的话把功能删了也算通过）。② **下载链路**：先拉几 KB 的 `index.json`（列表 + 预览色 + `sha256`），点应用才下该主题 CSS；镜像 jsDelivr → gh-proxy → raw 顺序回退（本机实测 GitHub 直连超时、raw 也不通，只有前两条可用，单镜像方案不可接受）；下完比对 `sha256`，不符拒绝安装且**不覆盖**已装主题；落盘 `$DSH_HOME/puzzle-mode-themes/<id>.css`；清单拉不到就用上次缓存并明示「当前离线」。③ **只允许 CSS**（用户先选「允许带 JS」后改口「不要 JS，只 CSS」，以后者为准）：插件里没有任何 JS 求值路径。白名单拒绝 `@import` / 外部 `url()` / `javascript:` / `expression(` / `</` / 花括号不配平 / 越界选择器；`html` 与 `:root` 块里**只能声明 `--dshpz-*`**（实测抓到 `html.dark{…}` 曾被前缀判断放过，已改成全等判断）；`url(data:image/…)` 放行、`@media`/`@supports` 递归逐条判、`@keyframes` 放行。④ **小按钮跟着换皮**：令牌原先声明在 `.dshpz-panel` 上，而小按钮属于 `conversation.input.left`、不在那个节点里，`var(--dshpz-*)` 全部取不到值；改为挂 `:root`，作用域靠前缀 + `.dshpz-*` 选择器收窄。⑤ 新仓 `dsh-puzzle-themes`：`themes/<id>/{manifest.json,theme.css}` + `tools/build-index.mjs` 现算清单（hash 手写必漂移），首发 4 套（樱花 / 墨黑 / 终端绿 / 深海）；插件侧新增 `tools/verify-themes.mjs`（拿插件自己的校验器验主题仓库实际产物，`--remote` 走真实下载路径验镜像）。⑥ 新增 `test/70-themes.test.mjs` 36 项，关键一组是拿同一批恶意样本**同时喂给宿主半与浏览器半**（浏览器半是手写 module-loader 包、拿不到 ESM 导出，所以重复实现了硬规则；重复实现必然漂移，除非有测试同时钉两边）；`test/30-rpc.test.mjs` 补 6 条 theme RPC 用例，全部在**未绑项目**的会话上跑以钉住「主题与项目无关」。顺手修掉 10-puzzle 里一处不可移植断言（写死 `/tmp`，Windows 上恒红）。测试 60+47+7+49+13+36 全绿，跨插件握手 18/0） |
| 兼容 | DSH `^0.1.5-alpha.1 \|\| ^0.1.6-alpha.1 \|\| ^0.1.7-alpha.1 \|\| ^0.2.0-rc.1`（peer 只声明 `@deepseek-ai/dsh-tools`；13 个已发布版本全覆盖） |
| Release | <https://github.com/liancha22/dsh-puzzle-mode/releases> |
| npm | **未发布**（本机装的是 GitHub 源） |
| 注意 | GitHub API token 已实测有效（HTTP 200）；`git push` 走 SSH |
| 测试 | **v3 起旧自检已过期**（断言钉死 v2 形状）；按工作约定不维护、不追红。验收判据见各版本 Release 正文的「验收判据」一节 |
| 依赖 | 无。只 peer 依赖 `@deepseek-ai/dsh-tools`（运行时提供） |

## 0.5 市场收录（两个市场，规矩完全不同）

生态里有**两个**都叫 dsh-market 的市场，别混——收录路径不一样：

| 市场 | 入口 | 收录方式 | 我们的状态 |
| --- | --- | --- | --- |
| **dsh-market/dsh-market**（官方） | DSH 里 Settings → **Plugin Market** | **不往它仓库提 PR**（README 原话：*This repo is the market app, not the catalog*）。目录数据在 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，**往那里提一个 yml 文件的 PR** | 见下 |
| **2BingLing/dsh-market** | <https://dsh.market> | **每日 03:00 UTC 自动扫 `dsh-plugin` topic**，无需提交 | **已自动收录**（描述由管道生成，会滞后若干天） |

### 往 awesome-dsh-plugin 提收录（官方市场的数据源）

**一个文件就是全部投稿**：`data/plugins/<owner>__<repo>.yml`。

```yaml
url: https://github.com/liancha22/dsh-puzzle-mode
name: liancha22/dsh-puzzle-mode
category: memory
tarball: https://github.com/liancha22/dsh-puzzle-mode/releases/download/vX.Y.Z/dsh-puzzle-mode-X.Y.Z.tgz
description:
  en: '一句话，句号结尾。含 `: ` 必须加引号，否则 YAML 解析失败。'
  zh: '中文可选，维护者会补。'
```

要点（都是 `contributing.md` 里的硬规矩，踩过就懂）：

- **别手工改两个 README** —— 它们由 `data/plugins/*.yml` 生成。CI 的判据是「PR 有没有碰 README」：
  没碰就重新生成后 `exit 0`（**通过**）；碰了就必须与生成结果逐字一致。**所以只加 yml、不碰 README 最稳。**
- **`description` 会被拿代码核对**。写数字/API 名就得真有——夸大是打回的头号原因。
  所以描述里只写能对着源码数出来的事实（五维是哪五个、格式 v几、档位有哪几档）。
- 仓库要有 `dsh.bundle`（**只声明 `dsh.client` 不算可安装**，这是最常见的被拒原因）、真实代码、
  满 1 天、活跃维护，并打上 `dsh-plugin` topic。
- 分类选最接近的即可，**不会因分类被打回**（维护者直接改）。我们选 `memory`：
  核心是「跨会话带着项目决策走 + 每条带出处」，与 `00080000/dsh-project-memory` 同架。

**提 PR 前先本地预跑 CI 的那把尺子**（省一轮来回）：

```bash
git clone git@github.com:<你>/awesome-dsh-plugin.git && cd awesome-dsh-plugin
npm ci
cp <你的>.yml data/plugins/<owner>__<repo>.yml
git add -A && git commit -m "Add <owner>/<repo> to the list"
GITHUB_TOKEN=<token> node scripts/check-submission.mjs --base HEAD~1
# 期望：checking 1 entry / ok <url> / all checked entries pass
```

⚠️ **`--base` 必须给**：不给的话它会把**全部 4400+ 条**当成「本 PR 新增」，
报「This pull request adds 4413 entries; the limit is 3」——那是假警报，不是你的问题。

- 提交记录：PR [#6546](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/6546)（2026-10-04）。
- 收录后：市场与站点通常在一天内自动拾取，**不需要再动本仓**。
- 以后**更新自己的条目**：只改 `data/plugins/<owner>__<repo>.yml` 这一个文件，
  别去改别人的行（README 生成制就是为了避免行号漂移改错邻居）。

## 1. 别人怎么装（GitHub 源，推荐）

**前提：仓库必须 public** —— 下载器不带鉴权（匿名请求 `api.github.com`），私有仓库在别人机器上拉不到。
```bash
# 1) 插件管理器（App 插件页「添加插件」用的就是它；支持标签/分支/子目录）
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.1.0   # 指定标签/分支
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode main/lib # 分支 + 子目录

# 2) dsh CLI 走 pnpm，只认 npm 名或 git 协议（不认 owner/repo）
dsh plugin --profile web add github:liancha22/dsh-puzzle-mode
```

装完**重启该 profile**（`patchReload: startup`），然后刷新浏览器页面。
`dsh plugin add` 会做三件事：把包放进 profile 的 `node_modules`、写进 `package.json` 的
`dependencies`、按包内 `dsh.bundle.patch` 把一行 `insert` 合并进 profile 组合。

卸载：`dsh plugin --profile web remove dsh-puzzle-mode`（或插件页删除），再重启。

## 2. 手工装（离线 / 自测）

```bash
git clone https://github.com/liancha22/dsh-puzzle-mode ~/.dsh/plugin-src/dsh-puzzle-mode
ln -s ~/.dsh/plugin-src/dsh-puzzle-mode <profile>/node_modules/dsh-puzzle-mode
# <profile>/package.json：
#   dependencies:        "dsh-puzzle-mode": "link:/root/.dsh/plugin-src/dsh-puzzle-mode"
#   dsh.profile.bundles: [ ..., "dsh-puzzle-mode" ]
# 重启 DSH（profile patchReload: startup），刷新页面
```

## 3. 发布新版本

```bash
cd /root/.dsh/plugin-src/dsh-puzzle-mode
# 1) 改 package.json 的 version（例如 0.16.6）+ 在 .github/ 写好 release-vX.Y.Z.md
# 2) **同步文档版本引用**（漏了会被用户抓到，见下「发版检查清单」）
# 3) 跑测试（v0.19.8 起**本项目放开**「不写测试/不跑测试」约定，见下）
npm test                              # 全绿才继续；红了先修
for f in lib/*.js; do node --check "$f" || echo "FAIL $f"; done   # 语法解析，防手滑
git add -A && git commit -m "feat: …（vX.Y.Z）"
git tag -f vX.Y.Z && git push origin HEAD --tags
bash tools/release.sh vX.Y.Z          # 建 Release（**内置测试门禁**，正文取 .github/release-vX.Y.Z.md）
```

### ⚠️ 测试约定：**本项目已放开**（v0.19.8，用户裁定）

全局约定（`~/.dsh/AGENTS.md`）是「不写测试、不跑测试」，理由是**断言钉死中间写法**、
产品一改就连带改一堆断言，而真机才能判正确性。**本项目从 v0.19.8 起是例外**：

| | 做法 |
| --- | --- |
| 为什么放开 | 长期不维护的结果是**测试整片脱节**：v4→v6 改造后 `npm test` 三红一绿，红成常态没人再看，v0.19.7 的 tag 是在全红下打出来的。**测试不是没用，是没人守** |
| 怎么防复发 | ① 断言**引 `lib/constants.js` 的常量**（改实现不必满仓找断言）；② 新增 `test/50-contract.test.mjs` **格式契约测试**（格式一变必须红，且**故意钉字面量**）；③ `release.sh` **内置门禁**：测试红 → 不建 Release |
| 边界 | 只约束**本仓**。别的项目仍按全局约定。**绿 ≠ 能用**——真机验收判据仍在 Release 正文里，测试只是地板不是天花板 |

> 契约测试为什么**故意**不引常量：常量与模板同源，改常量时两边一起动、测试照样绿
> （实测漏过：把 `SECTION_HEADINGS.pit` 改成「## 踩过的坑」，15 条全绿）。
> 所以 `50-contract.test.mjs` 里有一组「**契约锚**」把格式钉成字面量——
> 这正是它与单元测试的分界：单元测试引常量（不碍改动），契约测试钉字面量（拦下改动）。

### ⚠️ 发版检查清单（每次都要过一遍）

改完代码**不等于**发完版。README / PUBLISH / UI / package.json **都在 npm 包的 `files` 里**，
一改旧附件就过期，必须重传。逐项核对：

| # | 文件 | 要改什么 |
| --- | --- | --- |
| 1 | `README.md` | 头部「最新版」、安装命令、tgz 下载链接**三处**，再加一个新版本小节 |
| 2 | `README.md` | 只留最近 3 个版本的小节，更早的挪进 `CHANGELOG.md` |
| 3 | `CHANGELOG.md` | 接收从 README 挪下来的旧版本小节 |
| 4 | `UI.md` | 头部「对应 vX.Y.Z」 |
| 5 | `PUBLISH.md` | 第 0 节状态表的版本与日期 |
| 6 | `package.json` | `version`；`description` 是**对外介绍**（插件管理器 / npm / GitHub 侧栏显示的那段），**只讲这个插件是干什么的**，见下「description 别写成开发日志」 |
| 7 | `.github/release-vX.Y.Z.md` | 新版本的正文 + 「验收判据」一节 |
| 8 | `.github/images/` | **改过 `UI.md` 就必须重渲染**：`npm run render-tutorial`（见下） |
| 9 | **GitHub 仓库 About** | 仓库页右上角那段介绍（**不在仓库文件里**，改不到 git，只能走 API）：`PATCH /repos/liancha22/dsh-puzzle-mode`。与 `package.json` 的 `description` 同一读者、同一规矩——**别抄用户原话、别写开发流程** |

> 第 9 条为什么单列：About **不在任何被 `git push` 覆盖的文件里**，所以「提交推送」永远
> 不会顺带更新它。实测它从 v0.20.0 起一路停在「一个会话只绑一个项目…文档格式 v6」，
> 与事实相反地挂了三个版本，直到 v0.21.0 之后才被发现。

> 第 1 条是**用户明确要求**的（2026-10-01）：「每次有更新都要改 readme」。

### ⚠️ `description` 别写成开发日志（v0.19.8 用户抓过一次）

`package.json` 的 `description` 是**对外介绍**——插件管理器列表、npm 页、GitHub 侧栏
显示的就是它。读者是**要用这个插件的人**，不是维护者。

**只写「这个插件是干什么的 + 当前能力」**。这些**不要**写进去：

| 别写 | 为什么 | 该写在哪 |
| --- | --- | --- |
| **用户原话 / 提问原文**（「原话：…」「用户问：…」） | 那是**聊天记录**，不是对外介绍；读者要看的是这版改了什么，不是谁怎么提的 | Release 正文、`CHANGELOG.md` |
| 测试约定 / 契约测试文件路径 / 发版门禁 | 仓库内部流程，用户不关心 | `PUBLISH.md`、`~/.dsh/AGENTS.md` |
| 「三红一绿」「tag 在全红下打的」 | 开发过程的事 | Release 正文、`## 致谢` |
| 逐版本历史堆叠（v0.19.8 干了啥、v0.19.7 干了啥…） | 撑爆介绍，且 README 已有 | `README.md`「最新版本」、`CHANGELOG.md` |

**同一条规矩管三处**：`package.json` 的 `description`、GitHub 仓库 About、
**README 的版本小节**。三者都是对外介绍，读者都是「要用这个插件的人」。

**实测教训（第二条）**：v0.21.0 的 README 版本小节里把三条需求原话、两条提问原文
**逐字抄了进去**（`（原话：「造着项目建文档加…」）`），被用户当场抓到——
「你怎么把用户问写在介绍了」。原话留在 Release 正文与 CHANGELOG 就够了。

**实测教训**：description 曾一路从 270 → 311 → 340 → 386 → 406 → 424 → 466 字符，
每发一版就把「本版改了什么」追加一句，最后成了开发日志。
v0.19.8 被抓到后清理回 **282 字符**（纯对外介绍）。

**自查**：改完 description 后读一遍，问「一个只想装插件的人，需要知道这句吗？」——
不需要就删。长度参考 **≤ 320 字符**（超出多半是混进了开发侧内容）。
> 已经写进拼图文档的 `## 工作流`，每一步都会注入。

### ⚠️ 改过 `UI.md` 就要重渲染教程图（第 8 条）

`.github/images/` 里那 10 张图是**照着 `UI.md` 渲染**的（README 顶部 1 张 + UI.md 各节 8 张
+ 整份长图 1 张）。`UI.md` 一改，图就与正文不一致——**图与文字对不上比没有图更糟**。

```bash
npm run render-tutorial        # 需要 marked（devDependency）+ playwright 的 chromium
```

脚本的三条硬约束（都踩过，改脚本时别丢）：

1. **页面宽必须按 830px 渲染**，不是 1400。GitHub 会把宽于正文的图等比缩到约 830，
   按 1400 渲染的图进页面实际是 0.59x，字小到读不清；
2. **渲染前要剥掉正文里的 `![](...)`**。图被 `UI.md` 自己引用，而脚本又照着 `UI.md`
   渲染——不剥就是自引用，`setContent` 没有 base URL，渲染结果里会出现一排**破图图标**；
3. **表格要 `table-layout:fixed` + `word-break`**，否则窄宽下「内容」列的长句会把表格撑出画布。

产出后跑一次量化（脚本内自动做）：256 色，约 5.6MB → 2.2MB，文字仍锐利。

> 真面板截图（`预览/面板-*.png` 那类）**不能**由本脚本生成——它必须真面板跑起来截。
> 本脚本产出的是「`UI.md` 的渲染图」，两者不是一回事。

> 标签已存在时要 `git tag -f` **加** `git push -f origin vX.Y.Z`：
> 只 `git push origin HEAD --tags` 会被 `! [rejected] (already exists)` 挡回来。

### ⚠️ 附件必须单独上传（`release.sh` **不会**做这件事）

`tools/release.sh` 只建 Release，**不传 tgz**。漏了这一步，Release 页就没有下载附件
（v0.16.0 曾因此缺附件，事后才补）。补传：

```bash
npm pack                              # 产出 dsh-puzzle-mode-X.Y.Z.tgz
TOKEN=$(cat /root/.dsh/.github-token)
RID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/liancha22/dsh-puzzle-mode/releases/tags/vX.Y.Z \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/gzip" \
  --data-binary @dsh-puzzle-mode-X.Y.Z.tgz \
  "https://uploads.github.com/repos/liancha22/dsh-puzzle-mode/releases/$RID/assets?name=dsh-puzzle-mode-X.Y.Z.tgz"
```

**重传（改了文档要刷新附件）**：先删旧附件再传，否则会多出一个 `-1` 后缀的同名附件。

```bash
AID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/liancha22/dsh-puzzle-mode/releases/$RID/assets \
  | python3 -c "import sys,json;a=json.load(sys.stdin);print(a[0]['id'] if a else '')")
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/liancha22/dsh-puzzle-mode/releases/assets/$AID
```

改过 Release 正文（`.github/release-vX.Y.Z.md`）后同步到页面上：

```bash
python3 - "$TOKEN" <<'EOF'
import json,sys,urllib.request
tok=sys.argv[1]; rid=0  # ← 填 release id
body=open('.github/release-vX.Y.Z.md',encoding='utf-8').read()
req=urllib.request.Request(f"https://api.github.com/repos/liancha22/dsh-puzzle-mode/releases/{rid}",
  data=json.dumps({"body":body}).encode(), method="PATCH",
  headers={"Authorization":f"Bearer {tok}","Content-Type":"application/json"})
urllib.request.urlopen(req)
EOF
```

`dsh plugin --profile web add liancha22/dsh-puzzle-mode#vX.Y.Z` 也能按 tag 装。

## 4. 关于发 npm（暂不做）

本机 token 只有 `public_repo` 作用域，**不能发 npm**；而 npm 现在的写权限 token 强制 2FA、
最长 90 天，长期 CI 要走 Trusted Publishing（OIDC）。既然 GitHub 源已经能一条命令装，
本插件暂不发布 npm。真要发时的前置改动：

- `package.json` 补 `publishConfig.access`（包名无 scope，可省）；
- 加 `.github/workflows/publish.yml`（tag 触发，`id-token: write` + `npm publish --provenance`）；
- README 的安装段把 GitHub 源换成 `dsh plugin add dsh-puzzle-mode`。

## 5. 提交前检查

| 项 | 命令 | 期望 |
| --- | --- | --- |
| 测试 | `npm test` | **必须全绿**（v0.19.8 起本项目放开全局约定，见「3. 发布新版本」下的测试约定）。红 → `release.sh` 拒绝建 Release。绿只是地板：真机验收判据仍在 Release 正文里 |
| 语法 | `for f in lib/*.js; do node --check "$f"; done` | 无输出 |
| 打包内容 | `npm pack --dry-run` | 只有 `lib/ test/ cordis.patch.yml README.md UI.md PUBLISH.md LICENSE package.json`，无密钥 |
| Release 附件 | 见「3. 发布新版本」 | Release 页有 `dsh-puzzle-mode-X.Y.Z.tgz`（**`release.sh` 不会自动传**） |
| 配置可组合 | `dsh --profile web --dump-config \| grep -A2 dsh-puzzle-mode` | 出现 `# == dsh-puzzle-mode` |
