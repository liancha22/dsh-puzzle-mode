# v2.4.21 · 适配 DSH 0.2.2-rc.1

> 装完**必须重启客户端**才生效。

## 摘要

DSH 升到 `0.2.2-rc.1` 后拼图面板消失——侧边栏没按钮，插件的 207 个 entry 里一条拼图都没有。**不是代码不兼容，是插件的版本声明不匹配新宿主的门禁，被静默跳过了。** 代码一行没改，只改了 manifest 的版本声明，并修回 profile 的 bundles 清单。

---

## 现象：装了，但一条 entry 都没有

`plugin_manager` 列出 207 个 entry，其中没有 `dsh-puzzle-mode`。而 `node_modules` 里文件齐全、`package.json` 依赖也在——所以从外面看「明明装着」。

## 根因一：预发布版的 semver 规则

新宿主对 bundle 层加了 DSH 要求校验，原文：

> When the manifest declares `engines.dsh`, that range alone decides and
> `peerDependencies` are ignored. Otherwise **every** `peerDependencies` range on
> `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` must match.
> **Prereleases participate in range matching.**

我们只有 peer：

```
"@deepseek-ai/dsh-tools": "^0.1.5-alpha.1 || ... || ^0.2.0-rc.1"
```

`^0.2.0-rc.1` 按预发布规则**不覆盖 `0.2.2-rc.1`**：预发布版只有在 `[major,minor,patch]`
完全相同时才进 range，而 `0.2.0 ≠ 0.2.2`。判定「不兼容」→ bundle 被跳过，
**不报错、不崩，只是不加载**。

同一机制在别的插件上也是这么表现的（同日安装日志）：

```
dsh: warning: Plugin @dshgzq/dsh-agent-team-remove@1.0.0 is incompatible with dsh 0.2.2-rc.1
dsh: it stays installed but profile startup denies it until you grant an exemption
```

## 根因二：bundles 清单被重写过

profile 的 `dsh.profile.bundles` 在 `2026-11-09 12:33` 那次改写里丢了 `dsh-puzzle-mode`
（10-18 的备份里还在）。**bundles 才是唯一决定加载哪些插件的清单**——依赖在不在无关紧要。

## 修法

```json
"engines": { "dsh": "^0.2.2-rc.1" },
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.1",
  "@deepseek-ai/dsh-tools": "^0.1.5-alpha.1 || ... || ^0.2.0-rc.1 || ^0.2.1-rc.1 || ^0.2.2-rc.1"
}
```

`engines.dsh` 是**单一真值**：声明了它就只看它，peer 列表不再参与判定。
peer 里同时补 `^0.2.1-rc.1` 与 `^0.2.2-rc.1`，是让没读 `engines` 的工具链也不误判。

同时把 `dsh-puzzle-mode` 加回 profile 的 `dsh.profile.bundles`。

## 契约核对：新宿主只读 Inspect 逐项确认

| 项 | 结论 |
| --- | --- |
| `defineTool` 的 `output.schema` + `output.render` | 仍必填，本插件本来就这么写，无需改 |
| `tools.register/restrict/get/execute/guard` | 未变 |
| `systemPrompt.section/context` | 未变 |
| `sessionController.resolveAgent/prompt/cancel/fork/modelCatalog` | 未变 |
| 客户端 `layout / slots / uiWorkspace / workspaces / sessions` | 全部存在 |
| `sidebar.panellist` / `main` 注册字段 | 未变（`{id,order,label}` / `{key}`） |
| `conversation.content` | 是 **Component Factory** 不是 Slot，仍在 |
| `inputActions` 标准 prop | `main` 槽位本来就没有，插件早已按可空处理 |

**结论：代码零改动。**

## 验证（真装真加载）

```
plugin_manager     → include:dsh-puzzle-mode  enabled:true  fiberPhase:active
sidebar.panellist  → registrant:"dsh-puzzle-mode" id:"puzzle" active:true
main               → registrant:"dsh-puzzle-mode" key:"puzzle"  active:true
main.children      → puzzle.build.chat (single, session) 已声明
entry 总数         → 207 → 208
安装副本            → 54/54 逐字节一致，清空后重解包，双向无残留
```

冒烟 66 项通过、跨插件 18/0、安装规范 ✓、27 个 `lib/*.js` 语法全过。

## 未验证

**没有真的点开面板走一遍。** 上面是宿主自己的 Inspect 接口读到的注册状态
（槽位 occupant、fiber 相位、entry 启用态），证明插件已挂载且声明生效；
面板内交互、动效、派单链路没有实机点过。

## 升级注意

- 如果你之前的 profile 依赖被钉在某个具体提交，先改成 `v2.4.21`。
- **`dsh.profile.bundles` 必须含 `dsh-puzzle-mode`**，只写在 dependencies 里不算装上。
- 装完**重启 DSH 客户端**。

---

## 安装

**方式一 · 插件管理器（推荐）**

```bash
python3 "$DSH_HOME/plugin-manager.py" github liancha22 dsh-puzzle-mode v2.4.21
```

**方式二 · 下载附件**

下载下面的 `dsh-puzzle-mode-2.4.21.tgz`，用插件管理器的 `import` 装本地压缩包。

**方式三 · 面板一键更新**

面板「更新」页 → 「一键更新到 v2.4.21」。

装完**重启 DSH 客户端**。
