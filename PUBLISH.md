# 发布 dsh-puzzle-mode

这份部署里 DSH 插件管理器支持的来源：`npm` / `github` / `release` / `download`（任意压缩包 URL）/ `import`（本地压缩包）。

## 0. 状态

| 项 | 现状（2026-09-19） |
| --- | --- |
| 仓库 | <https://github.com/liancha22/dsh-puzzle-mode>（public） |
| 版本 | v0.1.0（首个可装版本） |
| npm | **未发布**（本机装的是 GitHub 源） |
| 测试 | 25 项通过（4 组，无需 Cordis 运行时或浏览器） |
| 依赖 | 无。只 peer 依赖 `@deepseek-ai/dsh-tools`（运行时提供） |

## 1. 别人怎么装（GitHub 源，推荐）

**前提：仓库必须 public** —— 下载器不带鉴权（匿名请求 `api.github.com`），私有仓库在别人机器上拉不到。

```bash
# 1) 插件管理器（App 的插件页「添加插件」用的就是它）
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v0.1.0   # 指定标签/分支
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode main/lib # 分支 + 子目录

# 2) dsh CLI：来源前缀 + owner + repo
dsh plugin --profile web add github liancha22 dsh-puzzle-mode

# 3) 通过 git（走 pnpm 的 git 依赖）
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
cd ~/.dsh/plugin-src/dsh-puzzle-mode
npm test                       # 25 项必须全绿
# 改 package.json 的 version（例如 0.1.1）
git add -A && git commit -m "chore(release): v0.1.1"
git tag v0.1.1 && git push origin HEAD --tags
```

需要一个 GitHub Release（而不是只打 tag）时：

```bash
curl -sS -X POST -H "Authorization: Bearer $(cat /root/.dsh/.github-token)" \
  -H 'Content-Type: application/json' \
  -d '{"tag_name":"v0.1.1","name":"v0.1.1","generate_release_notes":true}' \
  https://api.github.com/repos/liancha22/dsh-puzzle-mode/releases
```

`dsh plugin --profile web add liancha22/dsh-puzzle-mode#v0.1.1` 也能按 tag 装。

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
| 测试 | `npm test` | 25 项通过 |
| 语法 | `node --check lib/*.js` | 无输出 |
| 打包内容 | `npm pack --dry-run` | 只有 `lib/ test/ cordis.patch.yml README.md LICENSE package.json`，无密钥 |
| 配置可组合 | `dsh --profile web --dump-config \| grep -A2 dsh-puzzle-mode` | 出现 `# == dsh-puzzle-mode` |
