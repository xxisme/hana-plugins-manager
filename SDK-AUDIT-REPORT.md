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

---

## 六、追加修订(2026-08-25)：安装/更新判定放宽 + 更新页选择修复

### 6.1 判定放宽的背景

对照 SDK 目录契约(PLUGINS.md「目录结构」)后确认，原实现的判定比 SDK 严格：

| SDK 标准 | 原实现 | 问题 |
|---|---|---|
| `manifest.json` **可选**，无 manifest 时 id 取目录名、权限默认 restricted | manifest 存在时必须同时有 `id/name/version`，缺失即拒绝 | 误杀大量仅缺 version/name 的仓库 |
| id 规则 `[A-Za-z0-9][A-Za-z0-9._:-]*` | 白名单 `[a-zA-Z0-9._-]` | 拒绝含 `:` 的 id |
| 插件可位于仓库子目录(monorepo / 包裹目录) | 只认根目录 manifest 或单层唯一包裹目录 | 多层嵌套(如 `repo-main/plugins/my-plugin/`)被误判为"非插件" |
| 目录契约含 `assets/`、`extensions/` | 未列入贡献目录 | 纯 `extensions/` 插件的结构判断偏严 |

### 6.2 已实施的放宽(本轮完成)

1. **`lib/zip-check.js`**
   - 新增 `locatePluginRoot()`：BFS 下探最多 4 层定位插件根目录，优先含 `manifest.json` 的目录，其次含 `index.js`/贡献目录的目录；同层多候选时交由宿主判定。
   - manifest 字段校验放宽：`id/name/version` 缺失从 error 降级为 warning；id 白名单补 `:`。
   - 贡献目录对齐 SDK 契约(增加 `assets`、`extensions`，保留 legacy `widgets/pages`)。
   - 仅"无 manifest 且无 index 且无任何贡献目录"这类真正非插件目录才拒绝。
   - **原则：前置校验只负责"定位 + 元数据 + 风险检测"，最终结构判定交给宿主 `POST /api/plugins/install`。**
2. **`lib/github.js` `getRemoteVersion()`**
   - 探测顺序扩展为：根目录 manifest/package.json → 嵌套目录(顶层单包裹目录 / `plugins/` 子目录) → **release tag 兜底**(去掉 `v` 前缀)。
   - 对 monorepo、包裹仓库、无 version 但打了 release tag 的仓库，更新检测不再误报 `check-failed`。
3. **`lib/hana-api.js` `safePathSegment()`**：白名单补 `:`，对齐 SDK id 规范。
4. **`lib/scanner.js`**：贡献目录清单补 `extensions`。
5. **`lib/updater.js`**：结构校验失败时错误信息附带 warnings，便于定位。

### 6.3 "是否有必要前置调用 hana 的工具"结论

- **安装/更新执行**：当前已经走宿主 `POST /api/plugins/install`(`installFromPath`)完成 staging/校验/热加载/回滚，**不需要再前置调用宿主工具**。
- **前置校验应保留但放宽**：它承载了**风险检测(安全)与 staging 定位**，价值独立于宿主校验；本轮已把它从"结构门禁"改为"安全检测 + 提示"，不再因字段瑕疵阻断。
- **更新检测宿主无此能力**：宿主不提供"检查远端版本"API，只能插件自己访问 GitHub；已通过嵌套探测与 release 兜底提高识别率。

### 6.4 更新页选择逻辑修复(本轮完成)

原实现更新表格虽有隐藏的 `<input type="checkbox">`，但无可见选项样式、无全选/清空，且「更新选中」始终可点，UI 与逻辑脱节。已改为：

- 表格行首自定义勾选方块(选中显示对勾 SVG)，**点击整行即可切换选择**；
- 页头新增「全选」「清空」按钮；
- 摘要改为「已选 x / 可更新 y」实时计数；
- 「更新选中」在未选择时置灰禁用，避免空跑。

### 6.5 验证

- `scripts/smoke-test.mjs`：59 → **64 项全通过**，新增用例覆盖多层嵌套定位、manifest 缺字段放行、无 manifest 纯工具插件、冒号 id 放行。
- 所有改动 lint 零报错。

---

## 七、追加修订(2026-08-25)：插件合集仓库识别与单选安装

### 7.1 背景

以 `github.com/JohnGalt0802/HanaAgent-Plugins` 为代表的仓库是**插件合集**：同一仓库/压缩包内含多个插件，甚至混合不同层级(根目录 + `plugins/` 子目录)。原实现对"同层多候选"返回失败或交由宿主判定，无法提示用户选择。

真实结构(已用 GitHub API 核对)：
```text
HanaAgent-Plugins/
├── plugins/
│   ├── download-progress/   (插件 manifest)
│   ├── easymodel-viewer/    (插件 manifest)
│   └── ns-new-session/      (插件 manifest)
└── qq-group-patrol-skill/   (无 manifest，单文件 SKILL.md 形态)
```

### 7.2 实现

1. **`lib/zip-check.js`**
   - `collectCandidates()`：BFS 下探最多 4 层，收集所有"看起来像插件"的目录(含 `manifest.json` / `index.js|ts` / 贡献目录 / 根目录 `SKILL.md`)；排序为含 manifest 优先、深度优先。
   - 多候选时返回 `{ ok: true, multiple: true, candidates: [...] }`，不再视为错误。
   - 单候选/零候选逻辑不变。
2. **`routes/api.js`**
   - `github-apply` 与 `install/local` 端点：检测到 `check.multiple` 时，为每个候选运行风险检测，返回 `candidates: [{ pluginRoot, pluginId, pluginName, version, trust, risk }]`。
3. **`app/manager.js`**
   - 新增 `renderCandidates()`：在安装页渲染候选卡片(名称/版本/信任/风险)，**点击选中某项**后显示"继续安装"；
   - 安装状态提示"该来源包含 N 个插件，请选择要安装的一项"；
   - 新增 `resetInstallPanel()` 统一清理候选区/继续按钮/仓库信息，修复了 GitHub 流程"继续安装"按钮在下载完成前过早出现的问题。
4. **`app/manager.css`**：候选卡片(选中描边、hover)样式。

### 7.3 端到端验证

- **真实仓库** `JohnGalt0802/HanaAgent-Plugins` 下载 zip 实测：识别出 **4 个候选**——
  `download-progress`(v0.5.6)、`easymodel-viewer`(v2.0.0)、`ns-new-session`(v1.0.0)、`qq-group-patrol-skill`(SKILL.md 形态)。
- `scripts/smoke-test.mjs`：64 → **68 项全通过**，新增用例覆盖"插件合集 multiple 识别、候选数量、manifest/SKILL.md 混合候选"。
- lint 零报错。

> 说明：用户选择后，所选候选的 `pluginRoot`(staging 内目录)会作为 `sourcePath` 交给宿主 `POST /api/plugins/install` 完成安装与热加载；未选中的 staging 目录保留在 `dataDir/tmp`，随插件卸载时清理。

---

## 八、追加修订(2026-08-25)：更新页勾选与检测状态优化

### 8.1 用户反馈

更新 tab 出现两个问题：

1. **没有选择框**：表格中检测失败的插件(DSHana / Hanako Mail / SQLite)无法勾选——原逻辑只在 `hasUpdate=true` 时才渲染勾选框。
2. **检测更新状态全部失败**：所有失败被归为同一 `check-failed` 状态，错误信息也笼统地显示"远端未找到 version(manifest/package.json 均缺失，也无 release tag)"，用户无法区分是 **仓库不存在(404)**、**仓库存在但无 version 字段**，还是 **网络/限流**。

### 8.2 修复

1. **`lib/github.js`**
   - `readVersionFrom()` 现在把 `upstreamStatus` 透传出来，区分文件级 404 与无 version 字段两种情形。
   - `findNestedVersion()` 候选目录从 `plugins` 扩展到 `plugins / plugin / packages / src / apps / tools / services` 七种常见命名；列表 API 失败直接判定为 **仓库不存在(404)**。
   - `getRemoteVersion()` 失败时返回细分状态：
     - `status: 'upstream-404'` — 仓库/文件 404(不存在、链接错误或私有仓库无权限)
     - `status: 'no-version'` — 仓库存在但 manifest/package.json 均无 `version`、也无 release tag
     - `status: 'check-failed'` — 网络/限流等其他失败
2. **`lib/updater.js`** 把 `rv.status` 透传成 updater 项的 `status` 字段。
3. **`app/manager.js renderUpdates`**
   - 勾选框显示条件从 `p.hasUpdate` 放宽为 `p.status !== 'no-source'`(有 GitHub 关联即显示)；用户可对 `upstream-404` / `no-version` / `check-failed` 状态项勾选后**强制重试/重装**。
   - 状态 chip 颜色映射新增 `upstream-404` / `no-version`。
   - 失败/无 version 的行在版本列展示具体错误 + **「打开仓库」按钮**(链接取自关联 `github.url`)，方便用户直接核实关联地址是否正确。
   - 「打开仓库」链接 `stopPropagation`，不会触发行切换。
4. **`app/manager.css`**：新增 `.status-chip.upstream-404` / `.status-chip.no-version` 颜色、`.upd-err` 错误行排版、`.upd-gh` 打开仓库按钮。

### 8.3 验证

- `scripts/smoke-test.mjs`：**68 项全通过**(本次未新增离线用例；端到端状态字段在路由/UI 层透传)。如需为状态机加单测，可对 `getRemoteVersion` 做基于 mock fetch 的覆盖。
- lint 零报错。
- 用户体验路径：现在看到"检测失败"或"仓库 404"或"无 version"时，一眼能区分是关联错了、还是仓库本身没版本信息；点"打开仓库"直接核实。
