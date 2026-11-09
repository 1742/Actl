# IPC API 与事件协议

## 1. 调用边界

渲染进程通过 `window.actlAgent` 调用业务，契约见 [agent-ipc.ts](../src/shared/agent-ipc.ts)。preload 通过 Electron IPC 转发给主进程，再交给 Agent utility process 的 [AgentApplication](../src/runtime/agent-application.ts)。本文件描述应用内部 API，不是对外 HTTP 服务。

主进程检查窗口、主 frame、页面 URL 和操作白名单；Agent 校验 schema、归属、引用及业务权限。身份固定为 `developer:local`。业务 ID 使用原始 ID，不含前端导航使用的 `local:` 前缀。

```ts
interface AgentCommand {
  operation: AgentOperation;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

type AgentResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; status?: number; details?: unknown } };
```

表格中 params/query/body 分别指上述字段。query 的值以字符串提交，再由 schema 转换；大部分 body 使用 strict Zod 校验，未知字段会拒绝。时间戳通常为 ISO 字符串。无返回内容的操作成功时 value 为 undefined。

前端 [desktopTransport.ts](../src/renderer/src/agent/services/desktopTransport.ts) 解包 AgentResult，将失败转换为 RuntimeRequestError。主进程来源、白名单或订阅校验失败也可能直接拒绝 IPC Promise，调用者必须处理 Promise 异常。

前端客户端直接构造 AgentCommand，不经过 URL、HTTP 方法或路径映射。共享的 agentOperations 是主进程允许的操作列表，新增调用需同时接入该列表和 AgentApplication 用例。

## 2. 就绪与桌面 API

| 方法 | 参数与返回 |
| --- | --- |
| ready | 无；确保初始化，返回 `{mode,ownerId,modelConfigurationEnabled}` |
| request | AgentCommand；返回 AgentResult |
| stream | subscriptionId、AgentCommand；订阅事件并返回最终 AgentResult |
| onEvents | listener；返回移除监听函数 |
| watchTree | subscriptionId、sessionId；先返回树快照事件，随后持续订阅，Promise 只确认建立订阅 |
| onTreeEvents | listener；接收 `{subscriptionId,event}`，返回移除监听函数 |
| detach | subscriptionId；停止转发请求事件或树事件，不停止后台执行 |
| restart | 无；关闭现有 Agent，下一次 ready/请求按最新设置启动 |
| getSettings | 无；返回 `{storageDirectory}` |
| saveSettings | `{storageDirectory}`，非空绝对路径；不自动重启或搬迁数据 |
| pickDirectory | 无；返回选中路径，取消返回 null |
| openDirectory | storage/logs/skills/config |
| notify | completed/permission_requested、title、detail |

业务操作 `runtime.info` 也返回运行模式、owner 和模型配置能力。桌面资源与生命周期详见[桌面模块](modules/desktop.md)。

## 3. 项目、工作区与会话

| 操作 | 输入 | 返回 |
| --- | --- | --- |
| projects.list | 无 | Project[] |
| projects.create | body=`{cwd,name?}` | Project |
| projects.delete | params.projectId | undefined；不删除真实目录 |
| workspace.search | params.projectId；query=`{q?,limit?}` | `{data:[{type:"workspace_file",path,name}],truncated}` |
| workspace.tree | params.projectId；query=`{path?,maxEntries?}` | `{path,entries,truncated}` |
| sessions.list | query.scope=standalone 或 projectId，互斥；缺省全部 | Session[] |
| sessions.create | body=`{projectId?,title?}`，可省略 | Session |
| sessions.rename | params.sessionId；body=`{title:string或null}` | Session |
| sessions.delete | params.sessionId | undefined |
| sessions.context | params.sessionId | `{session_id,responses,context}` |
| sessions.compact | params.sessionId；body=`{model,reasoningEffort?}` | `{compressed,summarized_run_count}` |

Project 包含 id/cwd/name?/created_at/updated_at；Session 列表不内嵌完整 Run 历史。context 包含 last_input_tokens（可缺省）、summarized_run_count 和 compressions。压缩要求相应执行范围空闲，项目/会话删除执行取消与清理。

workspace.search 的 limit 为 1–100，默认 20；workspace.tree 的 path 默认 `.`，maxEntries 为 1–500，默认 200。当前没有独立项目重命名、单项目详情、单会话详情操作，完整会话数据从列表与 context 获取。

Session 另含 `parentSessionId?`、`rootSessionId`。创建子会话由运行时的 `spawn_agent` 工具负责，普通 sessions.create 不接受父会话参数。

### 多 Agent 协作

| 操作 | 输入 | 返回 |
| --- | --- | --- |
| agents.tree | params.sessionId，树内任一会话 | `{rootSessionId,members,plan}`；成员含 session、最新 response 和 sequenceNumber |
| agents.watch | 由桌面 watchTree 封装，params.sessionId | 订阅确认；事件持续至 detach 或运行时退出 |
| agents.message | params.sessionId 为发送方；body=`{targetSessionId,message}` | `{sessionId,accepted:true}`；只允许同树直接父子通信 |
| agents.stop | params.sessionId | 停止该会话及后代，并抑制排队自动唤醒 |

树事件包括初始 `snapshot`、带 sessionId 和 response 事件数组的 `response`、需刷新快照的 `changed`。旧请求流和树订阅共用 response 序号，客户端去重；切换页面后重新订阅通过快照恢复，不重放无限事件日志。计划更新由根 Agent 的 update_plan 工具执行，使用 revision 防止覆盖。当前工具与限制见[多 Agent 协作](modules/multi-agent.md)。

源码：[project.schemas.ts](../src/agent-core/contracts/projects/project.schemas.ts)、[session.schemas.ts](../src/agent-core/contracts/sessions/session.schemas.ts)。

## 4. 附件

| 操作 | 输入 | 返回 |
| --- | --- | --- |
| files.upload | params.sessionId；body=`{filename,mediaType,bytes:Uint8Array}` | StoredFile |
| files.content | params.sessionId、fileId | `{bytes:Uint8Array,mediaType}` |

前端从 File.arrayBuffer() 取得字节，再经 IPC 上传；下载由前端构造 Blob 和对象 URL。没有 multipart、下载 URL 或通用磁盘路径读取接口。

StoredFile 包含 id/object="stored_file"/session_id/filename/media_type/size/created_at。单文件最多 25 MiB。创建 Response 时最多引用 10 个不同 file ID，累计最多 100 MiB，全部必须属于目标会话。详情与清理见[存储模块](modules/storage.md)。

## 5. 创建、取消与审批

`responses.create` 的 params 为 `{sessionId}`，body 示例：

```json
{
  "model": "model_实际本地配置ID",
  "reasoningEffort": "medium",
  "permissionMode": "accept_edits",
  "input": [{
    "type": "message",
    "role": "user",
    "content": [{ "type": "input_text", "text": "检查这个项目的入口" }]
  }]
}
```

model 是本地目标 ID，不是 providerModel。reasoningEffort 只能在目标模型支持时提交。permissionMode 取 plan/ask/accept_edits/full_access，缺省 ask。input 与每条 content 必须非空，仅接受 user message。

| content type | 必需字段 | 含义 |
| --- | --- | --- |
| input_text | text | 非空文本 |
| input_workspace_file | path | 项目内已有普通文件的相对路径，不自动附内容 |
| input_file | file_id | 已上传会话文件；不接受 filename/size 等展示字段 |
| input_skill | id，name 可选 | 显式 Skill 引用 |
| input_mcp_server | name | 显式 MCP Server 引用 |

| 操作 | 输入 | 返回 |
| --- | --- | --- |
| responses.create | params.sessionId，以上 body | 完整 Response |
| responses.cancel | params.sessionId、responseId | cancelled Response；已取消时幂等 |
| responses.permissions | params.sessionId、responseId；body=`{batchId,decisions}` | 本轮继续执行到边界后的完整 Response |

Response 字段见 [responses.ts](../src/shared/agent/responses.ts)：id/object/session_id/status/model/reasoning_effort?/permission_mode/input/output/pending_permission_batch?/error?/created_at/updated_at/completed_at?。output 包含 message、reasoning、function_call、function_call_output、web_search_call 和 permission_request。工具结果 output 为序列化 JSON 字符串，可另带媒体 content。

创建与审批操作可走 request 或 stream。订阅由 stream 调用决定，body 不接受 stream 标志。到达终态或 waiting_permission 都会完成当前请求，不会保持一个请求一直等待用户决策。

审批 body：

```json
{
  "batchId": "permission_batch_实际批次ID",
  "decisions": [
    { "permission_id": "permission_实际ID", "decision": "approve" },
    { "permission_id": "permission_另一ID", "decision": "deny", "reason": "不执行这个操作" }
  ]
}
```

必须覆盖当前批次全部权限 ID，无重复或未知项；approve 不接受 reason。审批续跑沿用原 Run 与快照，第一条事件可以是 agent.permissions.resolved，不要求新的 response.created。当前没有单条 Response 查询操作，重新加载通过 sessions.context 获取历史。

## 6. 账号与模型

| 操作 | 输入 | 返回 |
| --- | --- | --- |
| accounts.list | 无 | `{data:账号视图[]}` |
| accounts.create | body=`{displayName,baseURL,apiKey}` | 账号视图 |
| accounts.update | params.accountId；displayName?/baseURL?/enabled?，至少一项 | 账号视图 |
| accounts.delete | params.accountId | undefined |
| accounts.credential.replace | params.accountId；body=`{apiKey}` | undefined |
| accounts.credential.clear | params.accountId | undefined；删除全部凭据版本 |
| models.create | params.accountId；body=`{providerModel,displayName,protocol,capabilities?}` | ModelTargetRecord |
| models.list | query.sessionId 可选 | `{data,selectedModelTargetId?,selectedReasoningEffort?,diagnostics}` |
| models.update | params.modelTargetId；providerModel?/displayName?/protocol?/capabilities?/enabled? | ModelTargetRecord |
| models.delete | params.modelTargetId | undefined |
| models.preference | body=`{modelTargetId:string或null,reasoningEffort?:值或null}` | undefined |

账号视图包含 id/displayName/baseURL/enabled/hasCredential/createdAt/updatedAt，不返回 Key。模型创建和编辑返回目标记录，models.list 返回选择目录及兼容性信息，不能假定三者是同一 DTO。

protocol 取 responses/chat_completions/anthropic_messages；reasoningEffort 取 none/minimal/low/medium/high/xhigh/max。能力与驱动差异见[模型模块](modules/models.md)。请求 schema 见 [provider-account.schemas.ts](../src/agent-core/contracts/provider-accounts/provider-account.schemas.ts)、[model.schemas.ts](../src/agent-core/contracts/models/model.schemas.ts)。

## 7. 提示词、搜索、Skills 与 MCP

| 操作 | 输入与返回 |
| --- | --- |
| prompts.get / prompts.defaults | 当前提示词设置或默认设置 |
| prompts.save | body=`{revision,blocks}`；返回新设置，revision 冲突拒绝 |
| search.get | 搜索设置，凭据只返回存在状态 |
| search.save | body=`{enabled,provider?,mode?,baseUrl?,apiKey?}` |
| search.clear | 删除搜索凭据 |
| search.test | 使用已保存外部凭据做真实搜索 |
| skills.list | query=`{q?,category?,page?,limit?,sessionId?,projectId?}`；返回摘要分页 |
| skills.detail | params.skillId；可传上下文 query；返回 manifest、文件、digest 与诊断 |
| mcp.list | 完整配置、状态、错误与工具摘要 |
| mcp.catalog | 启用 Server 的摘要，不含 command/env |
| mcp.save | params.name；body 为 stdio 配置，保存并热更新 |
| mcp.delete | params.name；删除配置 |
| mcp.test | body=`{name,config}`；临时连接并返回工具列表 |

提示词 blocks 含 id/title/text/enabled，最多 40 块、每块正文 30000 字符、总正文 120000 字符，ID 唯一。Skills 的 sessionId/projectId 互斥，分页和详情 query 以 [skill.schemas.ts](../src/agent-core/contracts/skills/skill.schemas.ts) 为准。

MCP 管理返回解密配置，包括 env；不能当作脱敏 catalog 使用。更多规则见 [Skills 与搜索](modules/skills-search.md)、[MCP](mcp.md)。

## 8. 事件订阅

仅 responses.create 和 responses.permissions 支持 stream。subscriptionId 必须是唯一 UUID，重复活动订阅被拒绝。先注册监听，再启动请求：

```ts
const id = crypto.randomUUID();
const off = window.actlAgent.onEvents((batch) => {
  if (batch.subscriptionId !== id) return;
  for (const event of batch.events) applyEvent(event);
});
try {
  const result = await window.actlAgent.stream(id, command);
  if (!result.ok) throw new Error(result.error.message);
  applyFinalResponse(result.value);
} finally {
  off();
}
```

主进程推送 `{subscriptionId,events}`；每条投影事件带 response_id 与递增 sequence_number。Worker 每 16 ms 或 64 条刷新，返回最终结果前刷新剩余事件。推送与 invoke 回复是两个交付通道，界面应消费完整返回快照，不能只依赖最后一批事件来确定审批状态。

| 事件组 | 事件 |
| --- | --- |
| Run | response.created/completed/failed/incomplete/cancelled |
| output 项 | response.output_item.added/done |
| 文本 | response.content_part.added/done、response.output_text.delta/done |
| 推理摘要 | response.reasoning_summary_part.added/done、response.reasoning_summary_text.delta/done |
| 推理正文 | response.reasoning_text.delta/done |
| 工具参数 | response.function_call_arguments.delta/done |
| 工具完成 | agent.tool.completed |
| 权限 | agent.permissions.requested/resolved |
| 领域错误 | type=error |

没有 SSE frame、keep-alive 注释、[DONE] 或 Last-Event-ID 重放。detached 请求的业务仍可能继续执行；用户停止应调用 responses.cancel。请求关联、事件批次及完整返回值定义见 [agent-ipc.ts](../src/shared/agent-ipc.ts)，投影见 [stream-projector.ts](../src/agent-core/contracts/agent-responses/stream-projector.ts)。

## 9. 错误与期限

Agent 控制错误通过 `{ok:false,error}` 返回。error.status 沿用业务错误分类数字，是元数据，不是 HTTP 响应状态。验证错误 details 包含 source/issues；当前 Worker 将 Zod 错误的 source 统一标为 body，即使错误发生在 params/query，调用者应同时根据操作和 issues 定位。

| 分类 | 常见错误 |
| --- | --- |
| 参数/输入 | invalid_request、无效目录、审批决定不完整 |
| 资源缺失 | 项目、会话、附件、Skill、模型不存在 |
| 冲突 | active_response_exists、project_active_response_exists、旧审批批次、模型不兼容、prompt_settings_conflict |
| 文件 | file_too_large、files_total_too_large、unsupported_file_type、unsupported_text_encoding |
| 外部服务 | 搜索限流/超时/不可用、mcp_connection_failed |
| 进程 | runtime_interrupted、初始化失败、关闭未确认 |

执行过程中模型或循环异常也可能正常返回一个 status=failed 的 Response；AgentResult.ok 表示业务用例成功返回，不代表 Run 一定 completed。错误映射见 [api-error.ts](../src/agent-core/contracts/common/api-error.ts)。

IPC 没有统一的业务请求总超时。主进程就绪/关闭、模型请求、MCP 握手、Shell 观察等待和后台最长运行分别有自己的期限，详见对应模块。不能把 yieldTimeMs 当作整个请求或命令的硬超时。
