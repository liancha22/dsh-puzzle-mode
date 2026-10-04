# 发布 dsh-puzzle-mode

这份部署里 DSH 插件管理器支持的来源：`npm` / `github` / `release` / `download`（任意压缩包 URL）/ `import`（本地压缩包）。

## 0. 状态

| 项 | 现状（2026-10-04） |
| --- | --- |
| 仓库 | <https://github.com/liancha22/dsh-puzzle-mode>（public） |
| 主题仓库 | <https://github.com/liancha22/dsh-puzzle-themes>（**新增**；主题不随插件打包，点一下从它下载） |
| 版本 | v0.26.0（**固定收尾问可全局关闭**，用户原话「提问到最后还要选继续还是停下？的功能加一个全局关闭功能」。① 面板左栏新增 `固定收尾问：开 · 点此关闭`；关掉后**四处**同时变：提示段换成另一份正文（明说「已全局关闭、不要再问」并要求「问到实质问题就结束」）、工具返回 `askPause:false` 且**不再下发** `pauseQuestion`/`pauseOptions`（留着文案比不带更糟——模型看到就会继续问，关掉就成了空话）、只拼不写的拒绝理由不再复述收尾问、面板右栏那句「每次提问最后都会问…」如实改口。② **默认开，且缺字段算开**：语义是「默认行为」不是「新特性」，反过来会让老用户静默变行为；只有显式布尔 `false` 才算关（`"false"`/`0`/`null`/`[]` 一律当开）。③ **全局**（`$DSH_HOME/.dsh-puzzle-mode.json`），与「关掉本会话的拼图模式」是两个开关、共用一个文件但**互不覆盖**（任一侧写入都带上另一侧，有断言钉着——本仓记过「同名不同形的字段会互相盖掉」）。④ 顺手修掉一处**测试脆弱性**：`10-puzzle`/`30-rpc` 会读运行者**真实的** `DSH_HOME`，用户关掉收尾问就会让 `npm test` 变红而代码没错；现统一走 `test/helpers/isolate-home.mjs`，且它**必须在其它 import 之前**（ESM import 提升，写在文件中间赋值环境变量太晚）。实测把真实设置改成关闭，全套测试仍绿。⑤ 新增 `test/80-ask-pause.test.mjs` 12 项、`50-contract` 补 2 条契约锚、`tools/verify-ask-pause.mjs` 7 项（走**真实 RPC** 验「设置 → 工具返回 → 提示段」三处接线——纯函数全绿而接线断了正是本仓反复记过的假绿）。测试 60+47+7+51+13+36+12 全绿，跨插件握手 18/0） |
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

### ⚠️ 这台机器上的实测推送路径（v0.26.0 走过一遍）

`release.sh` 与 `git push origin` 都假设**能直连 github**。本机实测的链路是：

| 路径 | 结果 |
| --- | --- |
| 直连 `github.com` | **通，1～2 秒**（前提：`.gitconfig` 里没有 `insteadOf` 劫持，见下） |
| `gh-proxy.com` 转发 push | **丢认证头** —— 报 `remote: No anonymous write access` |
| `ghproxy.net` 转发 push | **通**，认证头能转过去（`receive-pack` 返 200 而非 401） |
| `ghfast.top` | 坏 —— git 报 `SEC_E_CERT_EXPIRED`，耗十几秒才失败 |

能跑通的三条命令：

```bash
# 1) 凭据放**请求头**，别塞进 URL：gh-proxy 系镜像会把带凭据的 URL 拼坏（404）
HDR="Authorization: Basic $(printf 'x-access-token:%s' "$(cat ~/.dsh/.github-token)" | base64 -w0)"
# 2) **逐个提交推**：一次性推含大图的提交会被代理掐断成 HTTP 408
#    （RPC failed; HTTP 408 / send-pack: unexpected disconnect）
git -c http.extraHeader="$HDR" -c http.postBuffer=524288000 -c http.version=HTTP/1.1 \
    push "$URL" 5002363:refs/heads/main
# 3) tag 单独推
git -c http.extraHeader="$HDR" push "$URL" refs/tags/vX.Y.Z --force
```

- **`--force-with-lease` 会假失败**：本地没 fetch 过远端时它报 `stale info`。
  先 `git fetch "$URL" main` 再推，或确认是快进就直接推。
- **建 Release 用 API**（`release.sh` 依赖 bash + `jq`，Windows 上没有）：

  ```bash
  curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    --data @rel.json https://api.github.com/repos/liancha22/dsh-puzzle-mode/releases
  ```
- **传附件直连 `uploads.github.com` 就行**（不要走镜像，实测镜像反而报
  `end of response with 14 bytes missing`）：

  ```bash
  curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/gzip" \
    --data-binary @dsh-puzzle-mode-X.Y.Z.tgz \
    "https://uploads.github.com/repos/liancha22/dsh-puzzle-mode/releases/<id>/assets?name=dsh-puzzle-mode-X.Y.Z.tgz"
  ```
  **重传前先删旧附件**，否则会多一个 `-1` 后缀。
- 验证别只看 API：**匿名**下载一次附件（`curl -L` 不带 token，期望 200）才算真能装。

### 🩸 故障：市场点「更新」必失败，且回滚把插件删了

v0.26.0 发完后用户点市场更新，三次全失败，日志是
`dsh: connection to github.com timed out after 5000ms`，最后一次变成
**"restoration of the previous build could not be verified"**（这句会让人以为 profile 坏了）。

**根因不在网络，在 `~/.gitconfig` 里一条历史遗留的 `insteadOf`：**

```ini
[url "https://ghfast.top/https://github.com/liancha22/dsh-puzzle-mode"]
    insteadOf = https://github.com/liancha22/dsh-puzzle-mode
```

它把**所有**对这个仓库的访问劫持到 `ghfast.top`，而 git 走它报证书过期 ——
先耗十几秒再失败，**看起来和「直连超时」一模一样，把人和市场都骗了**。
而市场中国区的 git 路由是 `[null, gh-proxy.com, ghfast.top]`（**第一步就是直连**），
被劫持后必然失败。**删掉那两条 `insteadOf` 之后直连立刻正常（1.7 秒拿到 HEAD）。**

**回滚造成的真实损伤**（这才是要修的东西）：市场更新失败且回滚无法验证时，
会把 `dsh-puzzle-mode` 从 **`dependencies` 和 `dsh.profile.bundles` 里同时删掉**，
并删除 `node_modules/dsh-puzzle-mode`。于是：

- 插件**静默消失**（bundles 没有它 → 不加载）；
- 即使手动把目录放回去，**bundles 缺这一行也不会加载**；
- `package.json` 与 `pnpm-lock.yaml` 里都没有它，看起来像「从没装过」。

修复顺序（照这个来，别跳步）：

```bash
cd ~/.dsh/profiles/desktop
# 1) 依赖写回标准 git 写法（不要用 file: 本地 tgz —— 市场靠这个 specifier 接管更新）
#    "dsh-puzzle-mode": "git+https://github.com/liancha22/dsh-puzzle-mode.git"
# 2) **bundles 里补回 "dsh-puzzle-mode"**（漏了就不加载，这是最容易漏的一步）
# 3) 重新装（会真的联网 clone）
pnpm install
# 4) 三方对齐才算好：lockfile 的 codeload URL 里的 sha == 本地 HEAD == 远端 HEAD
```

> 顺带澄清一个**假故障**：`@deepblend/dsh-blender-bundle` 不在 `bundles` 里是**正常的** ——
> 市场 `.dsh-market/state.json` 里 `disabled` 明确列了它，不是坏了。


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
