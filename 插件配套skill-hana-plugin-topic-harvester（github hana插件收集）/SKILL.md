---
name: hana-plugin-topic-harvester
description: "抓取 GitHub 上 oh-plugin / openhanako-plugin / hanaagent-plugin 三个 topic 页面下的 HanaAgent 插件仓库（排除 skill、排除插件集合本身、展开插件集合里的子插件），并把结果维护进一份可扩展的 JSON 文件。触发场景：用户说'更新 hanaagent 插件清单'、'刷一下插件列表'、'看看 topic 上新插件没'、'维护插件 JSON'、'新增插件收一下'，或首次要求生成这份清单。"
compatibility: "Requires GitHub public Search API access (anonymous, 60 req/hr). No auth needed. Uses web_fetch for README fallback. Uses PowerShell + python3 for data processing."
---

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

### Step 1 — 抓三个 topic 页面

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
2. `GET https://raw.githubusercontent.com/{owner}/{repo}/main/README.md`（fallback 到 `master`）找子插件说明
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
| 新 github URL | 追加新条目 |
| 已存在的 github URL | 仅更新 `description` |
| 之前有但这次没抓到 | 直接从列表中移除（搜索 API 不会漏掉真正存在的仓库；漏掉 = 仓库被删/改名/转 private） |

每次运行后输出报告：

```
新增：N 条
更新：N 条
移除：N 条
总数：N 条
```

## JSON 结构

极简设计，方便维护。整份文件只有四个字段：

```json
{
  "version": "1.0.0",
  "lastUpdated": "2026-08-25T20:00:00+08:00",
  "projects": [
    {
      "github": "https://github.com/Nyasers/dsh-hanako",
      "description": "把 DeepSeek Harness（dsh）接进 Hana 作为进程外 subagent..."
    }
  ]
}
```

字段说明：

| 字段 | 含义 |
|---|---|
| `version` | schema 版本号（首次为 1.0.0，未来字段调整时升级） |
| `lastUpdated` | 本次刷新时间（ISO 8601） |
| `github` | 完整 GitHub URL，**唯一键** |
| `description` | 200 字以内中文简介 |

**为什么这么简**：维护成本低、git diff 清晰、人工手改不痛苦。如果未来需要加 stars / language / topics 等元数据，升级 `version` 加字段即可，老 JSON 不会破坏（缺失字段取 null）。

## 增量更新触发

- "更新插件清单" / "刷一下 topic" / "看看新插件没" → 按 Step 1–5 跑一遍
- "加一个插件：xxx/yyy" → 直接追加一条新记录，description 让用户提供或从该 repo 的 description/README 抓
- "删掉 xxx/yyy" → 从列表移除
- "修正 xxx 的简介" → 更新对应条目的 description 字段

## 注意事项

- **不要把"集合"项目本身收录进 projects 数组**——只收录从集合里展开的子插件
- **不要把 skill 收录进去**——哪怕它打了 plugin topic
- **README 抓不到时**（404 / rate limit），用 GitHub API 仓库详情接口的 description 兜底，不要凭空编
- **API 返回的 description 已经是机翻中文的不必改**——保留原文即可
- **空 description + README 也抓不到**：丢弃该条目，在报告里提示用户

## 首次执行（bootstrap）

如果 JSON 文件还不存在，按完整流程跑一遍，生成初始文件。然后给用户一份简报：

- 总数
- 排名前 5（按 stars，仅展示，不写入 JSON）
- 是否包含用户自己的仓库（检测 owner 字段）

把 JSON 文件路径告诉用户，并 stage_files 交付。