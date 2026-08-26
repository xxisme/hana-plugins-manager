# Hana Plugin Topic Harvester

把 GitHub 上三个 topic 页面（`oh-plugin` / `openhanako-plugin` / `hanaagent-plugin`）的 HanaAgent 插件生态，梳理成一份机器可读、人可读的 JSON 清单，并支持增量更新。

## 适用范围

只收录**可独立安装的 plugin 单元**。三类项目会被过滤掉：

1. **Skill 类项目**：repo 名字或 description 里强调是 "skill" 而非 "plugin"，或 topics 包含 `skill` 但不包含任何 plugin topic。
2. **插件集合（collection）**：description 写明是"插件集合"、"plugin collection"等定位，自身不是一个完整插件，下面挂着若干子插件。集合本身不收录，只收录下面展开的子插件。
3. **与 HanaAgent 无关的仓库**：即便命中某个 plugin topic（比如项目自加 tag），但 description 没有任何 Hana/Hanako/OpenHanako 字样，标记为待人工确认而不是直接收录。

## 数据来源

三个 GitHub topic 都是去中心化的，有重叠也有盲区。skill 默认全量抓取、合并去重：

| Topic | API 查询 |
|---|---|
| oh-plugin | `https://api.github.com/search/repositories?q=topic:oh-plugin&sort=updated&per_page=100` |
| openhanako-plugin | `https://api.github.com/search/repositories?q=topic:openhanako-plugin&sort=updated&per_page=100` |
| hanaagent-plugin | `https://api.github.com/search/repositories?q=topic:hanaagent-plugin&sort=updated&per_page=100` |

匿名访问限制是 60 req/hr，跑一次完整流程大约 6–10 个请求（3 个 topic + 集合展开 + 几个 README 抓取），完全够用。如果遇到 403 限流，等 `X-RateLimit-Reset` 时间戳后重试，或换登录态（用户自己提供 `GITHUB_TOKEN` 环境变量）。

## 工作流

### Step 0 — 工具选择（先读这一节再动手）

**默认用 `web_fetch` 抓 GitHub API**：它是宿主提供的网络通道，不受 shell sandbox 网络限制，能稳定返回 GitHub API 的 JSON 响应。本 skill 在执行环境里验证过：PowerShell `Invoke-RestMethod` / `curl` / `python urllib` 在默认沙箱下都会因网络被拦而失败，只有 `web_fetch` 能直接拿到数据。

**`exec_command` + PowerShell/curl 作为备选**：仅在 `web_fetch` 不可用或需登录态时使用，且需要 `sandbox_permissions="require_escalated"`。首次执行发现 escalate 失败时，立刻退回 `web_fetch` 路径，不要反复试 `exec_command`。

**`web_fetch` 分页参数**：

- `maxLength` 默认 12000，建议起步设 50000（GitHub Search API 单 topic 响应 60~130KB）
- 当响应里出现 `[... N KB 已省略 (原始长度 X KB) ...]` 字样时，说明被截断，按 `startChar=50000*N`（N 从 1 起）续读
- 当响应末尾出现 `[已到末尾]` 或没有"已省略"字样时停
- 单 topic 一般 2~3 次 `web_fetch` 调用就能拿全

### Step 1 — 抓三个 topic 页面

```text
# 用 web_fetch 抓 GitHub Search API 的标准姿势
# Topic: oh-plugin
URL: https://api.github.com/search/repositories?q=topic:oh-plugin&sort=updated&per_page=100
参数: maxLength=50000, startChar=0 → 若截断则 startChar=50000 → startChar=100000 → ...

# Topic: openhanako-plugin（同上）
URL: https://api.github.com/search/repositories?q=topic:openhanako-plugin&sort=updated&per_page=100

# Topic: hanaagent-plugin（同上）
URL: https://api.github.com/search/repositories?q=topic:hanaagent-plugin&sort=updated&per_page=100
```

备选（仅 web_fetch 不可用时）：

```powershell
$topics = @("oh-plugin", "openhanako-plugin", "hanaagent-plugin")
$all = @()
foreach ($t in $topics) {
  $url = "https://api.github.com/search/repositories?q=topic:$t&sort=updated&per_page=100"
  $resp = Invoke-RestMethod -Uri $url -Headers @{"User-Agent"="hana-plugin-harvester"}
  $all += $resp.items
}
```

合并后按 `full_name`（owner/repo）去重。**不要**按 description 去重——多个插件可能 description 一样。

每个 item 提取这些字段（Step 5 写 JSON 用）：

| 字段 | 用途 |
|---|---|
| `full_name` | 拼 github URL（`https://github.com/{full_name}`） |
| `html_url` | 备用 github URL |
| `description` | 写中文简介或直用 |
| `stargazers_count` | **stars 字段**，写入 JSON |
| `topics` | 过滤判定 |
| `default_branch` | 后续抓 README 时拼 raw URL |
| `updated_at` | 内部使用，识别"长期不更新" |

### Step 2 — 过滤

逐个仓库判断：

**判定为 "skill 而非 plugin"，排除的迹象**：
- repo name 含 `skill` 且 description 也强调是 skill
- topics 含 `skill-*` 但不含 `oh-plugin` / `openhanako-plugin` / `hanaagent-plugin` 之外的有效 plugin topic
- 仓库根目录有 `SKILL.md` 而没有 `manifest.json`（manifest.json 是 Hana plugin 的标志）

**判定为 "插件集合"，需要展开的迹象**：
- description 含"集合"、"collection"、"汇总"、"plugins collection"等字样
- repo 名字以 `Plugins`、`plugin-collection`、`-all` 结尾
- description 里列出"包括 XX、XX"并使用顿号/逗号罗列多个独立功能名

**判定为 "与 HanaAgent 无关"**：description 完全不提 Hana/Hanako/OpenHanako，直接丢弃。

判断不确定时，**跳过该条目并提示用户**，宁可漏收也不误收。

### Step 3 — 展开插件集合

对识别为"集合"的 repo：

1. `GET https://api.github.com/repos/{owner}/{repo}/contents/` 看顶层目录
2. `GET https://raw.githubusercontent.com/{owner}/{repo}/{default_branch}/README.md` 找子插件说明
3. 子插件的 GitHub 地址用 `https://github.com/{owner}/{repo}/tree/{branch}/{path}` 形式
4. 集合 repo 本身**不写入** JSON

### Step 4 — 写简介

按以下优先级给每条记录生成 `description`（目标 ≤ 200 字中文）：

1. **GitHub description 已经是中文且 ≤ 200 字**：直接用
2. **GitHub description 是英文**：用 README 第一段翻译压缩，保留核心动词和名词
3. **GitHub description 为空**：从 README 第一段（H1 + 紧跟段落）抽取
4. **两者都没有**：写一句"无项目说明"占位

简介必须能让读者一眼看出：
- 这是给 HanaAgent / OpenHanako 用的**什么类型**的插件（功能）
- 关键能力点（一两个名词短语）
- 不要堆形容词，不要写"很棒"之类主观评价

### Step 5 — 更新 JSON

JSON 文件默认放在主工作台：

```
<工作台>/hanaagent-plugins.json
```

读取已有文件（如有），按 `github` 字段作为唯一键：

| 情况 | 操作 |
|---|---|
| 新 github URL | 追加新条目，stars 取本次 API 值 |
| 已存在的 github URL | 更新 description 和 stars |
| 之前有但这次没抓到 | 直接从列表中移除（搜索 API 不会漏掉真正存在的仓库；漏掉 = 仓库被删/改名/转 private） |

每次运行后输出报告：

```
新增：N 条
更新：N 条
移除：N 条
总数：N 条
```

## JSON 结构

```json
{
  "version": "1.1.0",
  "lastUpdated": "2026-08-26T09:58:00+08:00",
  "projects": [
    {
      "github": "https://github.com/Nyasers/dsh-hanako",
      "description": "把 DeepSeek Harness（DSH）接进 Hana...",
      "stars": 38
    }
  ]
}
```

字段说明：

| 字段 | 含义 |
|---|---|
| `version` | schema 版本号（1.0.0 首次，1.1.0 加 `stars` 字段，未来再加字段继续升 1.2.0） |
| `lastUpdated` | 本次刷新时间（ISO 8601） |
| `github` | 完整 GitHub URL，**唯一键** |
| `description` | 200 字以内中文简介 |
| `stars` | 当前 GitHub stars 数（int，本次抓取时刻的快照） |

**为什么 stars 要保留在 JSON**：作为热度快照，方便快速识别生态里受关注的插件，无需再调 GitHub API；按 `stars desc` 排序后输出的 Top 5 即来自本字段。

**老 JSON 兼容性**：1.0.0 文件无 `stars` 字段，增量更新时缺失值按本次 API 抓到的值补齐（不会保留旧值），写入时统一为 int。

**为什么不存更多元数据**（language / topics / forks 等）：维护成本低、git diff 清晰、人工手改不痛苦。如果未来需要，升级 `version` 加字段即可，老 JSON 不会破坏（缺失字段取 null）。

## 增量更新触发

- "更新插件清单" / "刷一下 topic" / "看看新插件没" → 按 Step 0–5 跑一遍
- "加一个插件：xxx/yyy" → 直接追加一条新记录（stars 留空或标 0），description 让用户提供或从该 repo 的 description/README 抓
- "删掉 xxx/yyy" → 从列表移除
- "修正 xxx 的简介" → 更新对应条目的 description 字段
- "刷一下 stars" → 仅重跑 Step 1 + Step 5（跳过 Step 4 简介生成，description 不变）

## 注意事项

- **工具选择**：默认走 `web_fetch`，不要开局就尝试 `exec_command` 跑 PowerShell/curl——沙箱默认拦网络
- **不要把"集合"项目本身收录进 projects 数组**——只收录从集合里展开的子插件
- **不要把 skill 收录进去**——哪怕它打了 plugin topic
- **README 抓不到时**（404 / rate limit），用 GitHub API 仓库详情接口的 description 兜底，不要凭空编
- **API 返回的 description 已经是机翻中文的不必改**——保留原文即可
- **空 description + README 也抓不到**：丢弃该条目，在报告里提示用户
- **web_fetch 截断判断**：响应里出现 `[... N KB 已省略 (原始长度 X KB) ...]` 字样就是截断，按 `startChar` 续读

## 首次执行（bootstrap）

如果 JSON 文件还不存在，按完整流程跑一遍，生成初始文件。然后给用户一份简报：

- 总数
- 排名前 5（按 `stars` 字段 desc 排序，仅展示，不写入 JSON）
- 是否包含用户自己的仓库（检测 owner 字段）

把 JSON 文件路径告诉用户，并 stage_files 交付。
