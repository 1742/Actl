# 前端模块

## 1. 职责和入口

前端负责本地 Agent 的交互、状态展示和请求编排。业务 API 通过 fetch 调用 Agent，桌面功能通过 Tauri invoke 调用 Rust。

| 入口                                                            | 职责                                     |
| --------------------------------------------------------------- | ---------------------------------------- |
| [src/main.ts](../../src/main.ts)                                | Vue、Pinia、i18n、主题和路由初始化       |
| [src/router.ts](../../src/router.ts)                            | `/` 与 `/index.html` 重定向到 `/ai`      |
| [agent/router.ts](../../src/agent/router.ts)                    | Agent 功能路由，组件懒加载               |
| [AIView.vue](../../src/agent/components/layout/AIView.vue)      | 服务初始化、导航布局、重启恢复和侧栏宽度 |
| [runtimeUsecase.ts](../../src/agent/services/runtimeUsecase.ts) | 启动 Agent、保存 URL/token、等待健康     |

路由如下：

| 路径                        | 组件/用途                                  |
| --------------------------- | ------------------------------------------ |
| `/ai/agent`                 | `Agent.vue`：主对话                        |
| `/ai/agent/sidebars`        | `AgentSidebarHome.vue`：右侧栏入口         |
| `/ai/agent/sidebars/files`  | `AgentWorkspacePanel.vue`：工作区文件树    |
| `/ai/agent/settings`        | `Settings.vue`，query section 决定设置分类 |
| `/ai/agent/skills`          | `SkillLibraryView.vue`                     |
| `/ai/agent/skills/:skillId` | `SkillDetailView.vue`                      |
| `/ai/agent/mcp`             | `McpLibraryView.vue`                       |

会话选中状态位于 Pinia，不作为路由中的 sessionId。`/ai` 重定向到 Agent 主页面。

## 2. 状态层

[runtime.ts](../../src/stores/runtime.ts) 只保存当前服务 URL/token、前端 ready 状态和配色字段。新配置通过 `apply()` 写入，令牌不持久化为用户设置。

[agent.ts](../../src/agent/stores/agent.ts) 保存业务视图状态：

- 当前 runtime、可用性、能力及错误。
- 供应商账号、模型目录、模型/推理/权限选择；UI 初始权限为 accept_edits。
- 项目/会话列表、选中会话和项目草稿。
- `runtimeBySessionId`：每个会话独立的历史、加载状态、活动响应、权限批次、冲突和上下文指标。
- `composerDrafts/attachmentDrafts`：按编辑上下文隔离的输入草稿。

前端资源 ID 使用 `local:<后端ID>`，同时保存 `runtimeId`。调用 API 使用 runtimeId，store、导航和冲突定位使用带前缀 ID。模型 ID、附件 ID、响应 ID不采用同一装饰方式，修改接口时不能把 UI ID 直接传给后端。

草稿 key 为 `session:<UI会话ID>`、`project:<UI项目ID>:draft`、`standalone:local:draft`。这些草稿保存在内存 store；localStorage 保存的是上次视图，而不是完整输入和全部聊天内容。

## 3. 服务层与用例层

| 文件                                                          | 输入/输出和边界                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [services/bridge.ts](../../src/services/bridge.ts)            | 类型化 Tauri 调用，不处理 HTTP 业务                                       |
| [runtimeClient.ts](../../src/agent/services/runtimeClient.ts) | `AgentRuntimeClient` 接口、能力声明、客户端选择；当前始终返回 localClient |
| [local/service.ts](../../src/agent/services/local/service.ts) | URL 编码、token header、JSON 请求、multipart 上传、Blob 下载、SSE 读取    |
| [useAgent.ts](../../src/agent/composables/useAgent.ts)        | 项目/会话用例、加载版本管理、乐观响应、上传、取消、审批、冲突恢复和通知   |

普通错误转换为 `RuntimeRequestError`，包含 code/message/details。发送内容中的附件元数据用于本地展示，服务层真正提交时只保留 `type/input_file + file_id`，以符合后端 strict schema。

`useAgent.ts` 使用模型、Skill 和历史请求版本号避免较早请求覆盖较新上下文。activeStreamControllers 按会话保存，切换页面或选中其他会话不会把输出归到当前会话。

管理操作在前端先做活动检查。模型配置锁是 UI 约束，不能推断 HTTP 端点也统一具备该锁；后端 Run 快照承担配置一致性。

## 4. 输入模块

主对话输入通过 [Input.vue](../../src/agent/components/composer/Input.vue) 和 [AgentComposerEditor.vue](../../src/agent/components/composer/AgentComposerEditor.vue) 接入 Tiptap 编辑器。引用扩展定义在 [composerExtensions.ts](../../src/agent/composerExtensions.ts)，JSON 与结构化草稿转换在 [useAgentComposer.ts](../../src/agent/composables/useAgentComposer.ts)。

引用是 inline atom：Skill 携带 ID/名称，MCP 携带 Server 名，工作区文件携带相对路径/名称。提交时转为 input_skill、input_mcp_server、input_workspace_file，不靠解析普通文字模拟引用。

`ComposerReferenceMenu` 和输入逻辑提供 Skills、MCP、文件、附件、最近会话和压缩入口。工作区文件候选来源于项目文件搜索，只有项目绑定上下文才能使用。

附件通过 [useFileBridge.ts](../../src/agent/composables/useFileBridge.ts) 选择浏览器 File。发送时复用已上传且属于目标会话的 storedFile，其他逐个上传；错误写回对应附件状态。预览使用浏览器对象 URL。

`AgentMessageInputCore/Floating` 是可复用输入展示组件；描述功能时应沿实际主页面引用，不将所有输入组件理解为重复业务入口。

## 5. SSE 和响应归并

1. local/service 使用 POST fetch，不使用 EventSource；可以附带 token 和 JSON body。
2. [ResponseStreamParser](../../src/agent/composables/useResponseStream.ts) 缓冲跨 chunk 的 LF/CRLF frame，合并多行 data，忽略注释，识别兼容的 `[DONE]`。
3. local/service 解析 JSON，处理 `event:error`，检查流是否达到终态或权限等待边界；普通断流算异常。
4. `useAgent.applyRuntimeEvent()` 负责响应创建、权限请求/解决、通知和会话视图状态。
5. [reduceResponseEvent](../../src/agent/composables/useResponseReducer.ts) 按 output/content index 更新文本、推理和 function arguments；使用 sequence_number 忽略重复/旧事件。

归并器支持增量和最终完整 DTO：done/terminal 可覆盖增量结果。`agent.permissions.resolved` 在新审批流开始时就切换运行状态，避免等待工具输出时 UI 仍停留在审批状态。

首次发送流结束或请求失败后，`reconcileSessionContext()` 重新读取后端历史。当前没有 SSE 断点重放、Last-Event-ID 订阅或持续重连轮询；重新读取 context 是恢复快照，不恢复丢失的流。

## 6. 展示组件职责

| 目录                        | 主要职责                                            |
| --------------------------- | --------------------------------------------------- |
| `components/layout`         | 活动栏、项目/会话导航、上下文侧栏、工作区树         |
| `components/conversation`   | 时间线、推理、工具、搜索来源、恢复提示和消息区域    |
| `components/responses`      | 规范化消息/内容渲染、工具结果、运行跳转、未知项兜底 |
| `components/permissions`    | 权限模式和批次决策                                  |
| `components/settings`       | 服务、模型账号、提示词、搜索、外观设置              |
| `components/skills` / `mcp` | 本地能力库及详情/连接配置                           |
| `components/dialogs`        | 管理、会话菜单、前端标题搜索                        |

响应规范化位于 [utils/aiResponse.ts](../../src/agent/utils/aiResponse.ts)，Markdown 渲染位于 [utils/markdown.ts](../../src/utils/markdown.ts)。统一类型分布在 `agent/types/index.ts` 和 `aiResponse.ts`，与后端类型独立维护；修改 DTO 要同步校验两端。

## 7. 前端持久化与系统能力

主题由 [theme.ts](../../src/composables/theme.ts) 初始化，语言由 [i18n/index.ts](../../src/i18n/index.ts) 初始化，中文/英文目录保存在 locales。localStorage 还保存上次视图和侧栏宽度。会话、模型、附件和权限真实记录以 Agent SQLite 为准。

通知仅在 `isTauri()` 时经 bridge 发送；Rust 决定窗口聚焦时是否抑制。纯 Vite 页面仍依赖 Tauri bridge 完成默认服务初始化，不能认为 `pnpm dev` 自动带有独立浏览器完整运行模式。

整理约定见[前端代码规范](../FRONTEND_CODE_STYLE.md)，业务规则见[业务说明](../business.md)。
