# 发布 dsh-puzzle-mode

这份部署里 DSH 插件管理器支持的来源：`npm` / `github` / `release` / `download`（任意压缩包 URL）/ `import`（本地压缩包）。

## 0. 状态

| 项 | 现状（2026-10-07） |
| --- | --- |
| 仓库 | <https://github.com/liancha22/dsh-puzzle-mode>（public） |
| 主题仓库 | <https://github.com/liancha22/dsh-puzzle-themes>（**新增**；主题不随插件打包，点一下从它下载） |
| 版本 | v1.0.1（**各版本日志 + 一键更新（失败自动回退）**。两条需求都是对 v1.0.0 更新页的返工。① **各版本更新日志**：用户原话「我要的是有个地方看各个版本的更新日志，而且要洁简，不要一大堆字」——v1.0.0 只显示最新那版且把整篇正文铺出来（实测 6194 字符）。现在从 **Release 列表 API**（`/releases?per_page=20`，带 gh-proxy 回退）拉各版本，**每版最多 3 行摘要**：丢标题行 / 图片行 / 分隔线 / 空行，剥粗体与行内代码记号，列表符号统一成 `·`，**表格行压平保留**（发版正文的关键信息常在表里），超出行数**明说**「…还有 N 行」（静默截断会让人以为这版就这么点内容）。截断在**宿主半**做（`summarizeNotes`），这样规则能被测试直接钉住。当前那版打「当前」标记，草稿直接剔掉。② **一键更新，失败自动回退**：v1.0.0 不敢做一键的理由（装坏了插件加载不了、面板跟着消失）是对的，但**解法不是不让装**，而是让**回退逻辑不依赖插件活着**——安装器是独立脚本（`tools/dsh-puzzle-update.mjs`），运行前先被复制到 `$DSH_HOME/puzzle-mode-updates/` 下（不属于任何包），自己备份三处（`node_modules` / `package.json` / 锁文件）、自己 `pnpm add`、自己自检（依赖声明 · 版本号 · 入口能否被 `node --check` 解析），**任何一步不过就整体回退三处**。三处一起恢复是用户裁定：只恢复 `node_modules` 不够——`package.json` 还指着新版，下次 `install` 会把坏版本装回来。**实测抓到三个真缺陷**（读代码看不出来）：结果文件只在结束时写 → 面板分不清「正在装」与「根本没起来」（实测进程在跑面板却什么都没有；修法是干重活**之前**先写 `running:true`，轮询上限也从 90 秒放宽到 5 分钟，因为 pnpm 解析 git tag 实测要几秒到一两分钟）；`--expect-version` 为空时是**空判据**（`version !== ''` 就算过，而「装完版本没变」正是最常见的失败形态）；**变异打偏位置**（`rollback` 有两个调用点、`writeRunning` 有两处调用，只改一处另一处仍生效）。**变异验证 20 项全红**（v1.0.0 是 12 项），新增 8 项里有 **3 项第一轮全绿**——因为断言写成了**结构断言**（查源码里有没有某字符串），改成坏代码后字符串还在；已改为**真跑一次验行为**（安装期间轮询结果文件必须观察到 `running:true`；失败路径断言三处 `skipped:false`）。新增 `test/150-installer` 12 项，全部**跑真脚本**（造假 profile，依赖指向不存在的 tag，几秒走完「失败→回退」整条路径，真 profile 一个字节都不碰）。测试 60+47+7+51+17+36+12+9+21+23+21+31+22+12 全绿，握手 18/0。上一版 v1.0.0（**自动更新 / 主题开发分享 / 工作流去重 / 液态玻璃**。用户一次点了五件事。① 自动更新：面板一角检测线上版本、拉更新日志、把新版下到暂存区校验后给一条安装命令——**不自己装进 profile**（用户裁定）。通道按 2026-10-08 **实测**可达性排序：`api.github.com` 通(615ms) / jsDelivr 通 / gh-proxy 通 / **raw.githubusercontent 不通**(DNS 失败)。**校验的锚点写在 Release 正文里**（正文与附件是两条不同的下载路径）——正文没写哈希的老版本退化成结构校验并**如实标注**。**解包是唯一攻击面**：拦 `..` 穿越 / 绝对路径 / Windows 盘符 / 反斜杠穿越 / tar 链接条目，且**先全量校验路径再落盘**。② 主题开发与分享（用户澄清「上传是让别人能够分享自己做的主题风格」）：推主题仓库（插件只做 `git add/commit/push`，**代码里没有任何令牌路径**，凭据由 git 自己的凭据链取）+ 导出单文件主题包（带 sha256，同 id 先问再替换）。③ 默认皮肤正名为液态玻璃并做实（网格归零、blur 18→24px、顶部彩色扫描线换成白色高光边）。④ 工作流注入去重：判据「这个命中集合在最近 6 步内注入过吗」，按整个命中集合记签名并挡掉 A→B→A 横跳。⑤ 主题仓库新增「新拟物」。测试 60+47+7+51+17+36+12+9+21+23+21+22+22 全绿，握手 18/0。上一版 v0.30.0（自动审查只报漏洞）、v0.29.0（说话纠正）、v0.28.2（催促节拍改为每 6 步）、v0.28.1（催促改成纯节拍）、v0.28.0（说话方式 + 读文件一次读全 + 催促）、v0.27.1（删掉面板遮罩；主题页改为主界面切换）、v0.27.0（熔断之后继续推）、v0.26.1（修 op:audit 带源码体检必失败）、v0.26.0（固定收尾问可全局关闭））） |
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

#### 🩸 手动升版本时的坑：pnpm 有**三处**锁文件，只改一处它就说「Already up to date」

v0.27.0 实测（`github:` 源装在 profile 里，非符号链接）：

| 位置 | 内容 |
| --- | --- |
| `pnpm-lock.yaml`（profile 根） | 权威锁文件，`github:` 依赖在这里被解析成 **codeload tar.gz + sha** |
| `node_modules/.pnpm/lock.yaml` | pnpm 自己的副本，**它会先看这份** |
| `node_modules/.modules.yaml` | `hoistedLocations` 里记着**旧 sha 的 key**，匹配上就跳过 |

只改第一处 → `pnpm install --frozen-lockfile` 打印 **`Already up to date`**（退出码 0），
**插件却还是旧版**。三处都改成新 sha 之后仍可能被 `--force` 无视，因为
`.modules.yaml` 的 hoisted key 命中了旧条目。

**另一个坑**：`pnpm update dsh-puzzle-mode` 会走 `git+ssh`（`git ls-remote git+ssh://git@github.com/...`），
本机**没有 SSH key** → `Host key verification failed`。所以手动升级时**别用 `pnpm update`**，
改锁文件 + `install` 才走得通（codeload 是 HTTPS，可达）。

**手动升级的正确顺序**（v0.27.0 走过）：

```bash
# 1) 拉新 commit 的 tarball 并**验内容**（版本号 + 关键改动都在，别只信 sha）
curl -sSL -o /tmp/new.tar.gz \
  https://codeload.github.com/liancha22/dsh-puzzle-mode/tar.gz/<新sha>
tar -xzf /tmp/new.tar.gz -C /tmp && grep '"version"' /tmp/dsh-puzzle-mode-<新sha>/package.json
# 2) 算 integrity（sha512，与 lockfile 里同算法）：
#    openssl dgst -sha512 -binary /tmp/new.tar.gz | base64 -w0
#    ⚠️ 先拿**旧 sha** 的 tarball 复算一遍，确认算出的值与 lockfile 里的旧 integrity 一致 ——
#       这一步能证明算法没错，否则新 integrity 写错会以「integrity 校验失败」的形式炸掉
# 3) 三处锁文件同步改：pnpm-lock.yaml、node_modules/.pnpm/lock.yaml、
#    node_modules/.modules.yaml（hoistedLocations 的 key）+ integrity + version
# 4) pnpm install --frozen-lockfile
```

**若 pnpm 死活不重装**：安装副本就是 `npm pack` 的 48 文件形状
（**没有 `.github/`**，因为 pnpm 对 git-hosted 依赖走 packlist）。所以可以
`tar -xzf dsh-puzzle-mode-X.Y.Z.tgz` 后**逐文件覆盖** `node_modules/dsh-puzzle-mode/`——
但**先 `Compare-Object` 两边文件清单**，确认完全一致再覆盖（v0.27.0 实测两边都是 48 个文件、清单相同）。

**验收**：三方 sha 对齐（本地 HEAD == 远端 main == lockfile 里的 sha），
且**真 import 一次纯逻辑半**验行为（`lib/index.js` 在 profile 里 import 会因
`@deepseek-ai/dsh-tools` 由运行时提供而报 ERR_MODULE_NOT_FOUND，**这是正常的**；
`lib/puzzle.js` 才是能单独 import 的那半）。


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
