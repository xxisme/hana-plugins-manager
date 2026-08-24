---
name: hana-plugins-manager 改名/刷新优化/详情按钮 + GitHub 标签/更新 Tab 实时/安装状态区域
overview: 在上一轮计划基础上追加 3 个用户反馈：(1) 已关联 GitHub 的插件在管理卡片上以更醒目的绿色 chip（带 GitHub 图标 + 仓库名）展示；(2) 详情页保存/清除 GitHub 关联后，更新 Tab 能立即看到新的关联状态（结合 STATE.plugins 与缓存控制）；(3) 安装页的安装过程文字状态（解析/下载/风险检测/安装）单独做成内联状态更新区域，不再用虚化背景的 loading 遮罩。
---

## 产品概述

本轮对已完成的 hana-plugins-manager 插件做第二轮迭代修复，承接上一轮的改名/刷新优化/详情按钮边框/复核基础上，再处理 3 个用户反馈问题。

## 核心功能

- **GitHub 关联标签强化**：插件卡片上「已关联 GitHub」的视觉提示要更醒目，做成带 GitHub 图标的绿色标签（chip），含仓库名/分支信息，可点击直达仓库。
- **更新 Tab 实时同步**：在详情页保存或清除 GitHub 关联后，切到更新 Tab 应能立即看到关联状态变化，不再因 5min 缓存而显示「未关联」。
- **安装页状态区独立化**：GitHub/本地安装流程的阶段文字（解析/下载/检测风险/确认安装/实际安装）单独做一块状态更新区域，不要用全屏 loading-overlay 虚化背景。

## 技术栈

沿用现有技术栈不变：Node.js ESM + 零 npm 依赖 + 原生 HTML/CSS/Vanilla JS 前端（iframe 内联）。全部为现有文件的定点修改。

## 实现方案

### 1. GitHub 关联标签强化（app/manager.js + app/manager.css）

现状：`renderManage` 中 `<a class="github-link" ...>github ↗</a>` 文字小、蓝色，融入背景不醒目。

方案：将 `.github-link` 文字链替换为带内联 GitHub SVG 图标的绿色 tag，复用现有 `.tag.ok` 绿色底色，并在标签内显示 `owner/repo` 仓库名（不显示 raw URL，更紧凑）。点击在新窗口打开仓库。

- app/manager.js 替换渲染逻辑为 `<a class="tag github-tag" href="..." target="_blank"><svg>...</svg>owner/repo</a>`。
- app/manager.css 新增 `.github-tag` 规则：绿色背景、内联 SVG、cursor:pointer、hover 提亮。

### 2. 更新 Tab 实时同步（routes/api.js + app/manager.js）

**根因**：后端 `UPDATE_CHECK_CACHE` 5min 缓存，详情页保存/清除关联后未清缓存 → 即便插件已关联，缓存里的 status 仍是 `no-source`。

**方案**：

- 后端 routes/api.js：`POST /api/plugins/:id/source` 与 `DELETE /api/plugins/:id/source` 成功后 `UPDATE_CHECK_CACHE.clear()`（与 github-token 写入处同款做法）。
- 前端 app/manager.js：详情页保存/清除关联成功后不再走 `loadPlugins()`，改为：

1. `patchPlugin(id, { github: ... })` 同步本地状态。
2. 若当前 Tab 已是「更新」，立即调用 `loadUpdates(true)` 强制重检测；否则用户在切到更新 Tab 时自然重新检测。
3. 关闭抽屉。

### 3. 安装页内联状态区（app/manager.js + app/manager.css）

**根因**：所有阶段都用 `showLoading('...')` 触发全屏 `loading-overlay`（虚化背景 + spinner + 文字），用户要求不要虚化背景，文字单独成区。

**方案**：

- 在安装页 gh-panel 与 local-panel 内各增加 `<div id="install-status" class="install-status"></div>`。
- 新增 `setInstallStatus(stage, msg)` 工具函数，stage ∈ {idle, parsing, downloading, analyzing, ready, installing, success, failed, warning}：
- idle/ready：空或显示引导文字。
- parsing/downloading/analyzing/installing：阶段小图标 + 文字 + 内联小 spinner（CSS 动画 14px）。
- success：绿色勾 + 完成文字。
- failed：红色叉 + 错误文字。
- warning：黄色叹号 + 警告文字。
- 替换 `bindGithubActions`/`bindLocalActions`/`confirmInstall` 中所有 `showLoading/hideLoading` 为 `setInstallStatus` 阶段性调用。
- 批量更新的全屏 loading 保留（可能耗时较长，且不影响核心视觉反馈）。
- CSS：app/manager.css 新增 `.install-status`、`.install-status .spinner-inline`、各 stage 颜色规则。

## 性能与可靠性

- GitHub 标签无额外网络。
- 缓存清理是同步 map.clear()，无开销。
- 状态区用 innerHTML 增量更新，DOM 节点复用同一个 div，无重排开销。
- 批量更新/备份/卸载仍可用 showLoading 兜底（用户允许背景遮罩的耗时操作）。