# Hana 插件管理 — SDK 规范核对 + UI 可用性审计报告

> 依据：`C:\Users\Administrator\Desktop\OH-WorkSpace\Desk\码农\devkit.zip`(解压于 `devkit-extracted\devkit`)
> 核对对象：`c:\Users\Administrator\.hanako\plugins\hana-plugins-manager`(index.js / routes/api.js / lib/* / tool-modules/* / app/* / manifest.json)
> 日期：2026-08-25

---

## 一、总评

插件采用 **full-access 类式插件** 形态，生命周期、路由、工具注册的"骨架"与 SDK 完全吻合，且具备自研的安装/更新/备份/风险检测闭环，可用性良好。

主要差异集中在三个层面：

1. **WebView 通信机制自建**(管理 token 注入 iframe + 内联 CSS/JS)，绕过 SDK 的 assets 通道与会话机制，存在真实安全隐患；
2. **manifest 能力声明不规范或空挂**(`filesystem.*` 非规范命名、`ui.hostCapabilities` 声明 5 项但一行宿主能力代码都没用、缺少 `network` 声明)；
3. **若干界面元素有 UI 无功能**，另有少量后端接口存在但前端无入口。

---

## 二、与 SDK 规范的一致性核对

### 2.1 符合规范的部分

| 维度 | SDK 规范(devkit 文档) | 现状 | 判定 |
|---|---|---|---|
| 插件形态 | full-access 类式插件，onload(ctx)/onunload | `index.js` class 导出，两钩子齐全 | ✅ |
| 数据目录 | `${HANA_HOME}/plugin-data/{pluginId}/` 自动分配 | `resolveDataDir()` 推导路径一致 | ✅ |
| 工具形态 | tools 导出 `name/description/parameters/execute` | `tool-modules/*.js` 结构一致 | ✅ |
| 工具命名 | 宿主自动加 `{pluginId}_` 前缀 | `hana_*` 命名合理 | ✅ |
| 路由形态 | routes 工厂函数 `(app, ctx)`，挂载于 `/api/plugins/{pluginId}/*` | `routes/api.js` 一致；前端 base=`/api/plugins/hana-plugins-manager` | ✅ |
| 请求取值 | 示例用 `c.req.query(...)` | 一致 | ✅ |
| 安装链路 | 走宿主插件管理 API 完成 staging/校验/热加载/回滚 | `lib/hana-api.js` 封装 `/api/plugins/*` | ✅ |
| 卸载/启停 | 优先宿主 API | 一致，失败才降级写 `preferences.json` | ✅(降级属兜底) |
| 路径安全 | 插件 id 必须防路径穿越 | `safePathSegment` + smoke-test 覆盖 | ✅ |
| 风险自检 | —(自定义能力) | `runRiskCheck` + zip-slip 防护完善 | ✅ |

### 2.2 与 SDK 规范冲突 / 存疑的部分

**P1 严重**

1. **管理 token 注入 iframe，WebView 绕过宿主会话认证**
   - `routes/api.js:renderShell` 读取 `server-info.json` 的管理 token，写入 `<script>window.HANA_PLUGIN_TOKEN=…</script>`；前端 `manager.js api()` 再拼 `Authorization: Bearer <token>`。
   - SDK 规范：WebView 认证由宿主下发 HttpOnly cookie / `pluginSurfaceSession` 处理；**不应**在浏览器代码硬编码 `/api/plugins/{pluginId}/...`，不得自建 ticket/token 通道。
   - 风险：token 具有 hana 服务**完整管理权限**，被注入页面 JS 后，任何 iframe 内脚本/XSS 均可直接拿到管理凭证。

2. **静态资源未走 SDK assets 通道，而是内联进 HTML**
   - `manager.css`/`manager.js` 被路由 `fs.readFileSync` 后内联。SDK 建议：静态资源放 `assets/`，经 `/api/plugins/{pluginId}/assets/*` 提供，不应为静态资源创建自定义 route。
   - 后果：无浏览器缓存、每次请求重读磁盘、样式与脚本无法热更新、token 注入与 shell 强耦合。

3. **manifest 能力声明不规范 / 空挂**
   - `capabilities: ["filesystem.read","filesystem.write"]`：SDK 规范能力名为 `resource.read/write/search/materialize/watch` 与 `network.fetch`，`filesystem.*` 无规范出处；且代码并未使用 `ctx.resources`，纯原生 fs。
   - `ui.hostCapabilities` 声明 `external.open / clipboard.writeText / resource.open / resource.pick / resource.requestAccess` **5 项，但前端没有任何 hana SDK 代码**：GitHub 链接用 `<a target="_blank">`，备份目录不打开，全部能力形同虚设。
   - **无 `network` 声明**：`lib/github.js` 直接 `fetch` `api.github.com` / `codeload.github.com`。SDK 明确：旧插件直接 fetch 兼容，但新/重构代码必须 `ctx.network.fetch()` + `network.allowedHosts/methods/defaultTimeoutMs/maxResponseBytes`，否则诊断无法解释限流/失败。

4. **工具执行丢弃宿主 toolCtx，依赖全局单例**
   - `index.js` 注册工具时把整个 plugin ctx 透传，但 5 个 tool-module 的 `execute()` 全部通过内部全局单例 `getContext()`(plugin-context.js)取上下文，未使用传入 ctx。
   - SDK 的 toolCtx 含 `sessionId/sessionRef/sessionPath/bus/network/config/resources/registerSessionFile/stageFile`，宿主每次调用构建；全局单例一旦宿主隔离运行环境或工具在 dev slot 运行即失效。工具也未声明 `sessionPermission`。

**P2 中等**

5. **业务逻辑双轨重复**：`routes/api.js` 与 `tool-modules/*` 重复实现安装/卸载/启停/更新/备份，容易漂移。
6. **插件目录硬编码 `${home}/plugins`**：SDK/README 指出真实插件目录可经 `/api/plugins/settings` 的 `plugins_dir` 查看、由用户自定义；`getStatus()` 已请求 settings 却仅用于连通性判断，未采用 `plugins_dir`。自定义目录时列表/备份/卸载/还原全部错位。
7. **插件 id 白名单缺 `:`**：`safePathSegment` 为 `[A-Za-z0-9._-]`，SDK id 规则为 `[A-Za-z0-9][A-Za-z0-9._:-]*`，含冒号的 id 会被拒绝。

**P3 轻微**

8. `contributes.page` 属 SDK legacy UI 形态(SDK：新插件用 `contributes.cards[]`；dev loop 会拒绝 page 插件)，可继续兼容但无法走 `plugin.dev.install` 调试。
9. 未声明 `activationEvents` → 等价 onStartup，兼容。
10. class 插件未用 `this.register()` 注册资源(onunload 手动清 disposer)，依赖宿主时可能泄漏。
11. 缺 `icons`/`formFactors` 等可选字段，不影响运行。

---

## 三、"界面已开发但实际不可用 / 仅有展示"清单

| # | 位置 | 现象 | 原因与后果 |
|---|---|---|---|
| 1 | `manager.js` init：`<span class="badge" id="tab-update">` | 更新 Tab 徽标永远空白 | 没有任何代码写入该元素 → **本轮已修复**：`loadUpdates()` 后写入可更新数 |
| 2 | `manager.js` `btn-restore-open`「打开备份目录」 | 点击仅弹 toast，不打开目录 | 后端无打开目录接口；manifest 声明了 `resource.open` hostCapability 但前端未调用宿主能力。toast 路径还少了 `/plugins` 一层 → **本轮已修复**：改名「查看备份位置」+ 修正路径提示 |
| 3 | `routes/api.js` `GET/POST/DELETE /api/github-token*` | 后端实现 GitHub token 配置，**前端无任何入口** | 界面无法配置 token，GitHub 限流只能靠 env `GITHUB_TOKEN` |
| 4 | `routes/api.js` `POST /api/restore/plugin` | 后端实现单插件还原，备份页 UI 只有「全量还原」 | 单插件还原能力界面不可达 |
| 5 | `routes/api.js` `GET /api/homes` + `POST /api/current-home` | 后端实现多主目录候选与切换，前端无选择器 | Hana 主目录切换界面不可达(顶栏只读显示) |
| 6 | `manager.js` 顶栏 `hud-server`/`hud-count` | 初始「服务…」「…」表述含糊 | → **本轮已修复**：「连接中…」「—」，运行时「运行中 · 端口 N」「未连接」 |
| 7 | `manager.js` 详情抽屉「信任」字段 | 直接显示英文枚举 `restricted/full-access` | → **本轮已修复**：映射「完全访问/受限/未知」 |
| 8 | `manager.js` 卡片标签 `fs`/`trust?` | 内部代号暴露给用户 | → **本轮已修复**：「本地」「权限未知」 |
| 9 | `manager.js` 管理页底部「降级模式（API 不可用）」 | 用户不懂 | → **本轮已修复**：「本地模式（服务未连接）」+ 生效说明 |
| 10 | `manager.js` `update-status`/`install-status` | 更新页复用安装页 STAGE_META 状态区 | 功能正常，仅语义混用(建议独立状态区) |

---

## 四、可优化设计建议(按优先级)

1. **P1** 移除 `window.HANA_PLUGIN_TOKEN` 注入，WebView 改用宿主 session 认证(或至少将 token 收敛为仅后端持有)。
2. **P1** 静态资源迁移至 `assets/`，去掉内联 CSS/JS 与 shell 的读文件逻辑。
3. **P1** manifest 补 `network` 声明 + 代码改 `ctx.network.fetch()`；修正 `capabilities` 为规范命名。
4. **P2** 工具改为消费传入的 toolCtx，废除 `getContext()` 全局单例。
5. **P2** 以 `/api/plugins/settings.plugins_dir` 为权威目录，替换硬编码 `${home}/plugins`。
6. **P2** 将 routes 与 tool-modules 的双轨逻辑收敛到 `lib/*` 单一实现。
7. **P3** `safePathSegment` 字符集补 `:`。
8. **P3** 前端补充 GitHub token 配置入口、单插件还原入口、主目录选择器，消除能力空挂。

---

## 五、本轮文案与术语优化(已完成)

| 位置 | 原文 | 现文 |
|---|---|---|
| 顶栏标签 | `HANA_HOME` | `Hana 主目录` |
| 顶栏状态 | `服务…`/`服务 :8080`/`离线` | `连接中…`/`运行中 · 端口 8080`/`未连接` |
| 顶栏计数 | `…` | `—` |
| 管理页副标题 | `管理本机 hanaagent 的插件，支持更新、卸载、启停` | `管理本机 Hana 的插件：安装、更新、卸载、启停与备份还原` |
| 模式提示 | `降级模式（API 不可用）` | `本地模式（服务未连接）` |
| 标签 | `fs` / `trust?` | `本地` / `权限未知` |
| 详情信任 | 英文枚举 | `完全访问` / `受限` / `未知` |
| 备份按钮 | `打开备份目录` | `查看备份位置` |
| 备份提示 | `…plugin-data/…/backups` | `…backups/plugins`(路径补全) |
| 降级提示 | `…需重启 hana 生效` | `…重启 Hana 后完全生效` |
| 空态 | `…确认 HANA_HOME 路径正确` | `…确认 Hana 主目录路径正确` |
| 全量还原文案 | `…替换当前 plugins 目录…` | `…替换当前插件目录…` |
| 更新页 | `未关联 GitHub` | `未关联更新源` / `未关联仓库地址` |
| 更新 Tab 徽标 | 空置 | 显示可更新数量 |
| manifest/package.json | `hanaagent` | `Hana` |
| 配置项 title | `HANA_HOME 路径` | `Hana 主目录路径` |
| 后端/工具错误信息 | `HANA_HOME 未配置` | `未配置 Hana 主目录` / `未检测到 Hana 主目录` |

> 术语约定：正文统一使用「Hana」，主目录路径用「Hana 主目录」；`HANA_HOME` 仅保留为环境变量名引用。
