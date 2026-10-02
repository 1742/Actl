# MCP 接入与实现

## 1. 当前能力

Actl 是 MCP Host/Client，可连接**本地 stdio Server**并提供其 Tools。当前未接入 MCP Resources、Prompts、远程 HTTP/SSE Server 或 MCP OAuth。

入口：[McpServerManager](../agent/src/mcp/mcp-server-manager.ts)、[McpToolProvider](../agent/src/mcp/mcp-tool-provider.ts)、[HTTP 路由](../agent/src/http/mcp/mcp.routes.ts)、[McpLibraryView.vue](../src/agent/components/mcp/McpLibraryView.vue)。

**当前不读取 mcp.json。** 配置通过 UI/API 保存到当前运行模式 SQLite 的 mcp_servers 表，整份配置使用 SecretProtector 加密。原文档中手工写 mcp.json 后重启的方式不适用于当前实现。

## 2. 添加 Server

在侧栏进入 MCP Servers，填写名称、command、args、可选 cwd/env 及启用状态。保存立即连接/更新，不必重启；连接失败仍可保存，UI 可查看错误。测试使用独立临时连接，完成后关闭，不保存配置。

示例配置体（用于 PUT `/mcp/servers/math`）：

```json
{
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": ["D:\\McpServers\\math\\server.mjs"],
  "cwd": "D:\\McpServers\\math",
  "env": { "EXAMPLE_MODE": "local" },
  "enabled": true
}
```

| 字段        | 规则                                                  |
| ----------- | ----------------------------------------------------- |
| Server name | 以英文字母开头，其后字母、数字、下划线或连字符        |
| command     | 非空可执行文件路径或 PATH 命令；不是完整 shell 命令串 |
| args        | 字符串数组，默认 []                                   |
| cwd         | 可选；相对值基于 Agent home，缺省用 home              |
| env         | 可选字符串键值；与 SDK getDefaultEnvironment 合并     |
| enabled     | 默认 true                                             |

Agent SEA 包含自身 Node 运行时，不保证用户 PATH 有 node/npx。依赖 Node 的外部 Server 应使用用户机器真实 node.exe 路径及已安装依赖；Actl 不自动安装外部运行环境。

配置 schema 见 [mcp-config.ts](../agent/src/mcp/mcp-config.ts)。前端会通过管理接口取得配置，包括 env；加密落库不代表管理接口隐藏这些字段。

## 3. 连接管理

启动时读取、解密、校验所有配置，为启用项创建 provider，并并发连接。client.connect 握手超时 10 秒；listTools 按 cursor 读取所有页。单个 Server 连接失败不阻止 Agent 完成启动。

断线清空 client 和工具列表、记录错误并设 retryAfter。后续 listTools 调用在冷却结束后尝试重连，冷却为 15 秒；**没有后台每 15 秒必定重连的定时任务**。

saveServer 先创建并尝试连接新 provider，配置持久化成功后替换旧 provider。持久化失败关闭新连接并保留旧状态。旧 provider retire：无活动调用就关闭，有活动调用等其结束再关闭。

deleteServer 删除落库配置并移除 provider，旧连接同样退休；close 等待配置修改队列、活动 provider 和退休任务，属于 Agent 正常关闭的一部分。

## 4. 模型如何发现与调用

模型只接收两个固定入口：

| 工具             | 参数/返回                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| search_mcp_tools | query?、server?、limit?（默认 10，最大 20）、offset?；返回精确名称、description、inputSchema、total/nextOffset |
| call_mcp_tool    | toolName（以 mcp__ 开头）、arguments 对象；按发现的 schema 调用                                                |

公共工具名格式为 `mcp__<server>__<tool>`，非字母数字下划线替换为下划线。例如 `my-server` 前缀为 `my_server`；保存时拒绝 Server 公共前缀碰撞。

模型不会每次请求接收全部 Server 的工具 schema。输入菜单选择 Server 产生 input_mcp_server，当前消息物化为 selected_mcp_reference，提示模型先发现再调用。最多选择 8 个不同 Server，校验存在且启用，不保证此时已连接。

历史引用仅保留紧凑标记，不能视作当前工具仍可用。转换见 [model-context.ts](../agent/src/mcp/model-context.ts)。

## 5. 权限和结果

发现为 mcp.read/list，自动允许；实际调用 capability=mcp.<server>、action=execute。ask/accept_edits 询问，plan 拒绝，full_access 允许。Server 提供的 readOnlyHint 等标注不自动降权。

授权 resource 包含原始工具名与 provider instanceId。若审批等待期间 Server 配置更新，替换 provider 具有新 instanceId，旧授权不能直接用于新实例调用。

底层 client.callTool 携带取消 signal。result.isError 被转为工具错误；其他结果作为对象返回给 Agent。当前没有把 MCP image/audio content 自动转换为内置 read_image 那样的 RichToolOutput 图片快照。

## 6. 管理 API

全部需要 X-Actl-Agent-Token：

| 方法和路径                | 内容                                                         |
| ------------------------- | ------------------------------------------------------------ |
| GET /mcp                  | 连接状态、错误、工具数量摘要                                 |
| GET /mcp/servers          | 完整配置、状态、工具名/描述                                  |
| GET /mcp/catalog          | 启用 provider 的名称、connected、toolCount，不含 command/env |
| PUT /mcp/servers/:name    | 新增或覆盖配置并热更新                                       |
| DELETE /mcp/servers/:name | 删除，204                                                    |
| POST /mcp/test            | `{name, config}`，临时连接，返回 tools                       |

名称碰撞为 409/mcp_name_collision，不存在删除项为 404，测试连接失败为 422/mcp_connection_failed。catalog 会调用 provider.listTools，可能触发冷却后的重连；完整管理列表本身主要读取当前状态。

## 7. 验证与排查

仓库测试可运行：

```powershell
pnpm --dir agent exec tsx --test test/mcp.test.ts
```

[mcp.test.ts](../agent/test/mcp.test.ts) 使用真实 stdio fixture，并覆盖官方 filesystem Server 等集成情形。执行前确保开发依赖已安装；测试不等于验证任意第三方 Server。

手动排查顺序：验证 command/cwd/依赖能独立运行 → UI 测试握手/工具发现 → 保存并查看 connected/error → 对话中发现/调用 → 检查审批及结果。MCP stdout 用于协议，Server 普通日志应写 stderr。

Agent 会将 stderr 最多 2000 字符写入结构化日志，事件包括 mcp.server.connected/start_failed/connect_failed/stderr/close_failed。不要把日志输出本身理解为 Server 返回的工具结果。
