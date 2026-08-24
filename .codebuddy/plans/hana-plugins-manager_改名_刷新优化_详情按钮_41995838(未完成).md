---
name: hana-plugins-manager 改名/刷新优化/详情按钮
overview: 对已完成的 hana-plugins-manager 插件做三处小改动：1) 插件名改为「小花插件管理」并同步所有 UI 文案；2) 优化启停/卸载后的前端视觉刷新，改为本地状态更新 + 局部重渲染，避免每次全量重新读取接口；3) 给插件卡片上的「详情」按钮添加边框使其更醒目。
todos:
  - id: rename-plugin
    content: 将插件显示名改为「小花插件管理」并同步 manifest.json、package.json、routes/api.js、app/manager.js 各处文案
    status: pending
  - id: optimize-refresh
    content: 实现本地状态刷新：新增 patchPlugin，toggle 更新 enabled、uninstall 移除该项并同步计数与徽标
    status: pending
  - id: detail-button-border
    content: 给详情按钮加边框（改 btn-secondary 或新增样式），保持其他 ghost 按钮不变
    status: pending
  - id: review-verify
    content: 用 [skill:code-review] 复核改动并验证 JS 语法与功能一致性
    status: pending
    dependencies:
      - rename-plugin
      - optimize-refresh
      - detail-button-border
---

## 需求概述

对已开发的 hana-plugins-manager 插件做三处小改动：

1. **改名**：插件显示名由「Hana 插件管理」改为「小花插件管理」，并同步所有界面文案（manifest 显示名、页面标题、顶栏标题、包描述）。

2. **启停/卸载后的视觉刷新提速**：当前启停/卸载成功后会调用 `loadPlugins()` 全量重新请求 `/api/plugins` 接口并整体重渲染，较慢。改为在本地 `STATE.plugins` 就地更新对应项（启停改 `enabled`、卸载移除该项）后局部重渲染，不再每次走网络请求，实现即时反馈。

3. **详情按钮加边框**：插件卡片上的「详情」按钮当前使用无边框的 `.btn-ghost` 样式，不明显。为其添加清晰边框使其更醒目（不影响其他复用 `.btn-ghost` 的按钮）。

## 边界

- 不改动后端 API 契约、`lib/` 核心逻辑与安装/更新/备份还原等流程。
- 保持零依赖 ESM、代码风格一致。
- `manifest.id`、插件目录名、路由 pluginId 均保持不变，仅改显示文案。

## 技术栈

- 沿用现有技术栈：Node.js ESM + 零 npm 依赖 + 原生 HTML/CSS/Vanilla JS 前端（iframe 内联）。
- 全部为现有文件的定点修改（replace_in_file），不新增文件。

## 实现方案

### 1. 改名「小花插件管理」

对以下文件做文案替换：

- `manifest.json`：`"name": "Hana 插件管理"` → `"小花插件管理"`；page 贡献 `"zh": "Hana 插件"` → `"小花插件管理"`（`en` 同步为 "Xiaohua Plugins" 或保留，以 zh 为主）。
- `routes/api.js`：`<title>Hana 插件管理</title>` → `小花插件管理`。
- `package.json`：`description` 前缀同步为「小花插件管理」。
- `app/manager.js`：顶栏 `<h1>Hana 插件管理</h1>` → `小花插件管理`。

`manifest.id` 保持 `hana-plugins-manager` 不变，保证目录与路由关联不受影响。

### 2. 启停/卸载后视觉刷新优化（app/manager.js）

- 新增辅助函数 `patchPlugin(id, patch)`：在 `STATE.plugins` 中找到对应项并合并 patch，返回是否命中。
- **toggle 成功分支**：当前仅 toast、未更新 STATE。改为成功后调用 `patchPlugin(id, { enabled })` 再 `renderManage()`，实现即时重渲染且不重新请求。
- **uninstall 成功分支**：当前调用 `loadPlugins()`。改为成功后 `STATE.plugins = STATE.plugins.filter(p => p.id !== id)` 再 `renderManage()`。
- 在 `renderManage()` 结尾或状态更新处同步刷新顶栏插件计数 `#hud-count`（基于 `STATE.plugins.length`）与 Tab 徽标 `#tab-count`，保持界面一致性。
- `bindManageActions()` 由 `renderManage()` 末尾调用，重建后开关/按钮事件自动重绑，无需额外处理。
- 保留手动「刷新」按钮仍走 `loadPlugins()`（全量同步，作为兜底）。

### 3. 详情按钮加边框（app/manager.js）

- 将详情按钮 `class="btn btn-ghost"` 改为带边框样式。最简方案：改为 `class="btn btn-secondary"`（已含 `border-color: rgba(176,141,79,0.3)` 边框）。仅改详情按钮一处，不影响「清除关联」「还原」「备注」等仍用 `.btn-ghost` 的按钮。

## 性能与可靠性

- 启停/卸载由「网络请求 + 全量重渲染」降为「本地状态更新 + 局部重渲染」，延迟明显降低，无额外网络开销。
- 本地更新与后端实际状态一致（toggle/uninstall 成功即代表后端已变更），不会产生状态漂移。
- 文案替换为纯字符串修改，无逻辑风险；改后前端文件由 `renderShell` 内联注入即时生效。

## 目录结构

全部为现有文件的修改，无新增/删除文件：

```
hana-plugins-manager/
├── manifest.json        # [MODIFY] name 与 page title.zh 改为「小花插件管理」
├── package.json         # [MODIFY] description 同步为「小花插件管理」
├── routes/api.js        # [MODIFY] <title> 改为「小花插件管理」
└── app/
    ├── manager.js       # [MODIFY] 顶栏标题改名；toggle/uninstall 改为本地状态刷新；详情按钮加边框
    └── manager.css      # [MODIFY] 可选：若新增 .btn-detail 样式则在此添加（默认复用 btn-secondary 则无需改）
```

## Agent 扩展

### Skill

- **code-review**
- 用途：三处修改完成后，对 `app/manager.js` 的刷新优化逻辑（`patchPlugin`、toggle/uninstall 本地更新、计数同步）做一次针对性复核，确认无状态漂移、无事件绑定遗漏、无死代码。
- 预期结果：发现并修正潜在缺陷（如开关重绑、计数不同步、过滤误删），确保刷新优化可靠。