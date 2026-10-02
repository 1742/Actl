# Actl 项目文档

本套文档依据当前仓库实现编写，核对日期为 **2026-10-02**。面向开发和维护，描述已接入的行为；源码中的接口预留、历史字段和未接入功能会单独说明。源码链接均相对本仓库，不依赖开发者机器路径。

## 阅读顺序

| 文档                         | 解决的问题                                                   |
| ---------------------------- | ------------------------------------------------------------ |
| [架构说明](architecture.md)  | 三个运行层如何协作，Agent 如何启动、退出，数据和事件如何流动 |
| [业务说明](business.md)      | 用户操作对应哪些业务对象、状态和规则                         |
| [HTTP API 与流协议](api.md)  | 前后端接口、请求字段、错误和 SSE 事件如何使用                |
| [开发与打包](development.md) | 如何启动、验证、配置、构建 Windows 安装包和定位问题          |

## 模块详解

| 文档                                                 | 主要源码                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| [前端](modules/frontend.md)                          | `src/agent/`、`src/stores/`、`src/services/`                                |
| [Tauri 桌面壳](modules/desktop.md)                   | `src-tauri/src/lib.rs`、`src-tauri/tauri.conf.json`                         |
| [Agent 执行与上下文](modules/agent-runtime.md)       | `agent/src/runtime/`、`agent/src/hooks/`                                    |
| [模型与协议适配](modules/models.md)                  | `agent/src/model/`、`agent/src/runtime/model-store.ts`                      |
| [工具、权限与命令进程](modules/tools-permissions.md) | `agent/src/tools/`、`agent/src/permissions/`、`agent/src/runtime/process/`  |
| [SQLite、文件和凭据存储](modules/storage.md)         | `agent/src/repositories/`、`agent/src/stored-files/`、`agent/src/security/` |
| [Skills 与联网搜索](modules/skills-search.md)        | `agent/src/skills/`、`agent/src/web-search/`                                |
| [MCP](mcp.md)                                        | `agent/src/mcp/`、`agent/src/http/mcp/`                                     |

## 其他文档

- [前端代码整理规范](FRONTEND_CODE_STYLE.md)：针对前端整理任务的约定，保留为独立规范。
- [原 ACTL 入口](ACTL.md)：兼容原有链接，指向新的开发与打包说明。

## 术语

| 名称                    | 在本项目中的含义                                                                 |
| ----------------------- | -------------------------------------------------------------------------------- |
| 桌面壳                  | Tauri/Rust 进程，管理窗口、系统能力及 Agent 生命周期                             |
| Agent / 运行时          | `agent/` 中的独立 Node HTTP 服务                                                 |
| Project / 项目          | 已登记的本地目录及元数据，不要求目录是 Git 仓库                                  |
| Session / 会话          | 持有历史、附件和上下文摘要的对话容器，可独立存在或绑定项目                       |
| Run / Response          | 一次用户提交产生的完整执行，可包含多次模型请求和工具调用；HTTP DTO 使用 Response |
| Timeline / 时间线       | Run 的消息、推理、工具调用、工具结果、搜索和审批记录                             |
| Model target / 模型目标 | 本地登记的配置 ID；与供应商模型名 `providerModel` 区分                           |
| Provider account        | 供应商地址、账号显示名及版本化凭据                                               |
| Stored file             | 归属于会话的上传文件或工具捕获的图片快照                                         |
| Skill                   | 安装在 Agent home 下的工作流目录，入口为 `SKILL.md`                              |
| MCP Server              | 通过 stdio 连接的外部工具子进程                                                  |

## 维护文档

新增业务时同时检查业务文档、模块文档和 API 文档。变更环境变量、路径、工具参数、默认值或数据库迁移时，更新相应表格。以路由与 Zod schema 判断外部接口，以实际依赖装配和调用判断功能是否接入；依赖包或类型存在本身不代表功能已可用。
