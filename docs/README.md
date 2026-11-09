# Actl 项目文档

本套文档描述当前 Windows Electron 应用的实际行为，面向使用、开发和维护。接口以 IPC 操作白名单和运行时 schema 为准；源码链接相对本仓库。

## 阅读顺序

| 文档 | 解决的问题 |
| --- | --- |
| [架构说明](architecture.md) | 进程如何协作、启动退出、业务和事件如何流动 |
| [业务说明](business.md) | 用户操作对应的业务对象、状态和规则 |
| [IPC API 与事件协议](api.md) | 业务命令、请求字段、错误、事件订阅和桌面接口 |
| [开发与打包](development.md) | 环境、配置、验证、Windows 安装包及故障排查 |
| [测试目录](../tests/README.md) | 单元测试、Electron 集成验证与 fixture 的组织方式 |

## 模块详解

| 文档 | 主要源码 |
| --- | --- |
| [前端](modules/frontend.md) | `src/renderer/src/agent/`、`src/renderer/src/services/` |
| [Electron 桌面](modules/desktop.md) | `src/main/`、`src/preload/`、`src/shared/agent-ipc.ts` |
| [Agent 执行与上下文](modules/agent-runtime.md) | `src/runtime/`、`src/agent-core/runtime/`、`src/agent-core/hooks/` |
| [多 Agent 协作](modules/multi-agent.md) | `src/agent-core/runtime/multi-agents/`、`src/agent-core/tools/builtin/subagent.ts` |
| [模型与协议适配](modules/models.md) | `src/agent-core/model/`、`src/agent-core/runtime/model-store.ts` |
| [工具、权限与命令进程](modules/tools-permissions.md) | `src/agent-core/tools/`、`src/agent-core/permissions/`、`src/agent-core/runtime/process/` |
| [SQLite、文件和凭据](modules/storage.md) | `src/agent-core/repositories/`、`src/agent-core/stored-files/`、`src/agent-core/security/` |
| [Skills 与联网搜索](modules/skills-search.md) | `src/agent-core/skills/`、`src/agent-core/web-search/` |
| [MCP](mcp.md) | `src/agent-core/mcp/` |
| [前端代码规范](FRONTEND_CODE_STYLE.md) | 前端整理、类型、组件和验证约定 |

## 术语

| 名称 | 在本项目中的含义 |
| --- | --- |
| 主进程 | Electron main，管理窗口、桌面能力、IPC 及 Agent 生命周期 |
| 渲染进程 | Vue 界面，通过 preload 暴露的受限 API 调用业务 |
| Agent / 运行时 | 长期存活的 Electron utility process，承载模型、工具、权限与持久化 |
| Agent home | 当前存储目录，包含数据库、附件、密钥、日志、Skills 和缓存 |
| Project / 项目 | 已登记的本地目录及元数据，不要求目录是 Git 仓库 |
| Session / 会话 | 持有历史、附件和上下文摘要的对话容器，可独立存在或绑定项目 |
| Run / Response | 一次用户提交的完整执行，可包含多次模型请求和工具调用；对外 DTO 使用 Response |
| Timeline / 时间线 | Run 的消息、推理、工具调用、工具结果、搜索和审批记录 |
| Model target / 模型目标 | 本地登记的配置 ID，与供应商模型名 `providerModel` 区分 |
| Provider account | 供应商地址、账号显示名及版本化凭据 |
| Stored file | 归属于会话的上传文件或工具捕获的图片快照 |
| Skill | 安装在 Agent home 下的工作流目录，入口为 `SKILL.md` |
| MCP Server | 通过 stdio 连接的外部工具子进程 |

## 维护约定

文档按当前职责和行为组织。业务规则、接口、参数默认值、存储布局或生命周期发生变化时，直接更新对应章节，不在文件末尾追加版本修复记录。开发脚本以根目录 [package.json](../package.json) 为准；依赖存在、类型预留或诊断 fixture 通过，不等同于产品已接入相应能力。
