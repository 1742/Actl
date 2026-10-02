# Skills 与联网搜索模块

## 1. Skill 安装和目录

[SkillCatalog](../../agent/src/skills/index.ts) 当前只扫描 `<ACTL_AGENT_HOME>/skills`，provider=actl、scope=user。虽然部分方法接收 projectCwd，当前并不扫描项目自己的 Skill 目录，也不自动读取 Codex/Claude 技能库。

安装方式为手动放置目录，无下载、市场、安装或删除 Skill 的 HTTP API：

```text
<home>/skills/example-skill/
  SKILL.md
  scripts/
  references/
```

SKILL.md 必须以 YAML frontmatter 开始：

```markdown
---
name: example-skill
description: 描述何时使用这套工作流。
category: office
tags: [document]
version: '1.0'
---

这里编写具体步骤、输入输出和验证要求。
```

name 最长 64，使用小写字母数字和连字符，必须与父目录名一致；description 非空、最长 1024。license/compatibility/metadata 及显示扩展 category/tags/version/icon 可选。未知扩展保留，allowed-tools 只保存提示，不授予或收窄运行权限。

解析与诊断见 [loadSkillsDir.ts](../../agent/src/skills/loadSkillsDir.ts)。非法 Skill 返回 available=false 和 diagnostics，而不是整库隐藏，便于定位缺 frontmatter、非法 YAML、名称不符等问题。

## 2. 发现与缓存

listSkillSummaries 使用 `<home>/.cache/skills-catalog.json` 缓存，根据文件 stat 判断摘要可复用，支持 q/category/page/limit；findSkill 找到摘要后重新加载完整包。正文保存 contentDigest，供详情/工具返回。

HTTP `GET /skills` 返回摘要分页，`GET /skills/:skillId` 返回 manifest、文件路径/列表、推断语言、digest 与诊断；详情并未返回独立 instructions 正文字段。界面通过侧栏能力目录和详情查看已安装包；库主页面本身主要提示从侧栏选择。

HTTP sessionId/projectId 可用于归属检查和上下文路由，但不会改变当前 Skill 搜索根。

## 3. 模型按需加载

输入中显式选择最多 8 个不同 Skill。Agent 校验存在且 available，记录输入中的显示名，将当前用户消息追加 selected_skill_reference 元数据；历史引用仅保留紧凑标记。

模型工具见 [skill-resources.ts](../../agent/src/tools/builtin/skill-resources.ts)：

| 工具                   | 内容                                              |
| ---------------------- | ------------------------------------------------- |
| search_skills          | 可用技能 ID、名称、描述、分类/标签，默认最多 20   |
| get_skill_instructions | 完整工作流正文、包根、digest 和资源提示           |
| list_skill_files       | 包内路径/绝对路径、类型及大小，默认深度 6、500 项 |

选中不自动注入全部正文，发现不自动执行脚本。包内 path 必须相对、realpath 后仍在包内；列目录不递归符号链接。读取说明为只读自动允许，执行包脚本仍走 shell 权限。

显式引用转换见 [model-context.ts](../../agent/src/skills/model-context.ts)。修改 Skill 文件可能影响后续读取；没有把整个包固定成每次 Run 独立不可变版本。

## 4. 搜索配置

[WebSearchService](../../agent/src/web-search/search-service.ts) 保存 owner 的 provider/mode/enabled/baseUrl 与加密 Key。默认 provider=brave、mode=auto、enabled=false。

| provider | 默认完整搜索 endpoint                          |
| -------- | ---------------------------------------------- |
| brave    | https://api.search.brave.com/res/v1/web/search |
| tavily   | https://api.tavily.com/search                  |
| serper   | https://google.serper.dev/search               |
| bocha    | https://api.bocha.cn/v1/web-search             |

baseUrl 是完整 endpoint，不只是域名；服务要求 HTTPS，并移除 URL 用户名/密码和 hash。切换 provider 未提供新 key 时不沿用旧 provider 凭据。external 启用要求 key；auto/native 可以不配置外部 key，是否可执行取决于选中模型。

API 为 GET/PUT web-search、DELETE credential、POST test。test 使用已存外部服务 key 做一次实际搜索，**不测试当前模型原生搜索能力**，也不要求设置处于 enabled。

## 5. 策略选择

[strategy.ts](../../agent/src/web-search/strategy.ts) 的原生能力条件为 protocol=responses 且 nativeWebSearch=true。

| 模式          | 选择规则                                         |
| ------------- | ------------------------------------------------ |
| auto          | 支持原生则原生；否则有 key 则外部，无 key 不可用 |
| native        | 支持才原生，否则 native_unsupported              |
| external      | 有 key 则外部，否则 credential_missing           |
| enabled=false | disabled                                         |

原生策略在模型 turn 请求中启用 nativeWebSearch，并移除普通 web_search；其他策略仍可暴露普通工具，由工具调用返回禁用/未配置等错误。auto 是执行前策略选择，不是原生请求失败后自动再向外部供应商重试。

## 6. 外部工具调用

[web-search.ts](../../agent/src/tools/builtin/web-search.ts) 接收 query（1–400 字符）、maxResults（1–10，默认 8）、freshness（日/周/月/年）、domains（最多 5 个 hostname）。

权限 capability=network.search、action=read，所有模式默认允许这一查询。service 从当前 session 取 owner，组合取消信号和 30 秒外部请求超时；各供应商字段由适配函数转换为统一 result。

结果包含 provider、query、searchedAt、results、citationFormat 和 citationInstructions。每条 source 有 citationId、title、url、snippet、可选 publishedAt；模型被提示使用紧邻论断的 Markdown 链接。前端用 web search block/source card 展示外部和原生搜索记录。

只提供搜索与结果摘要，没有为外部服务实现通用 open_page/find_in_page 浏览器工具。原生搜索可能由供应商产生这些 action，属于供应商协议输出。

## 7. 错误与边界

disabled/native_unavailable/credential_missing 为 409；配置/认证错误 400，限流 429，超时 504，供应商不可用 502。以服务错误码判断原因，不以“没有搜索结果”代替未配置状态。

Skills、搜索和 MCP 都能为 Agent 提供能力，但生命周期不同：Skill 是本地按需读取的目录，搜索是外部 HTTP 调用，MCP 是长连接子进程。修改功能时沿各自模块和设置接口处理。
