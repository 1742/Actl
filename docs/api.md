# HTTP API 与流协议

## 1. 通用约定

API 根是本地 Agent URL，无统一 `/api` 前缀。入口见 [http/routes.ts](../agent/src/http/routes.ts)。本文 `:sessionId/:projectId` 均为后端原始 ID，不包含前端 `local:` 前缀。

除 `/health` 和 `/_lifecycle/status` 外，业务接口要求：

```http
X-Actl-Agent-Token: <本次 Agent 启动令牌>
Content-Type: application/json
```

生命周期 POST 也验证同一 header，但只在 managed 模式启用有效写操作。业务身份固定 developer:local，没有登录/注册接口。

大部分请求用 strict Zod schema，未知字段会拒绝。返回格式按端点定义，不统一包 `{data}`；项目/会话列表是数组，模型/Skill/文件列表有各自 envelope。时间戳通常为 ISO 字符串。

## 2. 状态与生命周期

| 方法/路径                  | 返回或行为                                                   |
| -------------------------- | ------------------------------------------------------------ |
| GET /health                | `{ok:true}`，公开                                            |
| GET /runtime               | `{mode, ownerId, modelConfigurationEnabled:true}`，认证      |
| GET /_lifecycle/status     | `{protocol:1, managed, stopping, remainingMs}`，公开         |
| POST /_lifecycle/heartbeat | managed 且 token 有效时续期，204；无效 403，stopping 409     |
| POST /_lifecycle/shutdown  | managed 且 token 有效时请求关闭，202；无效 403，stopping 409 |

## 3. 项目

源码：[project.routes.ts](../agent/src/http/projects/project.routes.ts)、[project.schemas.ts](../agent/src/http/projects/project.schemas.ts)。

| 方法/路径                             | 请求                                           | 返回                                                   |
| ------------------------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| GET /projects                         | 无                                             | Project[]                                              |
| POST /projects                        | `{cwd, name?}`                                 | 201 Project                                            |
| GET /projects/:projectId              | 无                                             | Project                                                |
| PATCH /projects/:projectId            | `{name:string或null}`                          | Project                                                |
| DELETE /projects/:projectId           | 无                                             | 204，删除会话/元数据，不删真实目录                     |
| GET /projects/:projectId/sessions     | 无                                             | Session[]                                              |
| GET /projects/:projectId/files/search | q?（默认空），limit?（1–100，默认20）          | `{data:[{type:"workspace_file",path,name}],truncated}` |
| GET /projects/:projectId/files/tree   | path?（默认 .），maxEntries?（1–500，默认200） | `{path,entries:[{type,name,path}],truncated}`          |

Project 返回 id/cwd/name?/created_at/updated_at，不返回 ownerId。不能 PATCH cwd。

## 4. 会话与上下文

源码：[session.routes.ts](../agent/src/http/sessions/session.routes.ts)、[session.schemas.ts](../agent/src/http/sessions/session.schemas.ts)。

| 方法/路径                         | 请求                                          | 返回                                   |
| --------------------------------- | --------------------------------------------- | -------------------------------------- |
| GET /sessions                     | scope=standalone 或 projectId，互斥；缺省全部 | Session[]                              |
| POST /sessions                    | `{projectId?,title?}`，空 body 可视作 {}      | 201 Session                            |
| GET /sessions/:sessionId          | 无                                            | Session                                |
| PATCH /sessions/:sessionId        | `{title:string或null}`                        | Session                                |
| DELETE /sessions/:sessionId       | 无                                            | 204                                    |
| PUT /sessions/:sessionId/project  | `{projectId}`                                 | 绑定后 Session，只支持独立会话首次绑定 |
| GET /sessions/:sessionId/context  | 无                                            | `{session_id,responses,context}`       |
| POST /sessions/:sessionId/compact | `{model,reasoningEffort?}`                    | `{compressed,summarized_run_count}`    |

Session presenter 移除 ownerId/runs/cwd/fileChanges，保留其他状态字段；完整响应历史应取 context，不依赖列表返回 runs。

context 中含 last_input_tokens（可缺省）、summarized_run_count 和 compressions（summary/数量/时间）。compact 要求当前 project/session 执行范围空闲。

## 5. 附件

| 方法/路径                                      | 请求/返回                                               |
| ---------------------------------------------- | ------------------------------------------------------- |
| POST /sessions/:sessionId/files                | multipart/form-data，单个 file 文件字段；201 StoredFile |
| GET /sessions/:sessionId/files                 | `{data:StoredFile[]}`                                   |
| GET /sessions/:sessionId/files/:fileId         | StoredFile                                              |
| GET /sessions/:sessionId/files/:fileId/content | 下载字节与文件名                                        |

StoredFile 为 id/object="stored_file"/session_id/filename/media_type/size/created_at。单文件 25 MiB；上传不接受额外表单字段。文件 ID 必须属于路径中的会话。

## 6. 创建 Response

`POST /sessions/:sessionId/responses`：

```json
{
  "model": "model_实际本地配置ID",
  "reasoningEffort": "medium",
  "permissionMode": "accept_edits",
  "stream": true,
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [{ "type": "input_text", "text": "检查这个项目的入口" }]
    }
  ]
}
```

示例中的 model 为占位，reasoningEffort 只能在目标模型支持时提交。mode 可取 plan/ask/accept_edits/full_access，缺省 ask。

input 与每条 content 必须非空，仅接受 user message。内容字段：

| type                 | 必需字段      | 语义                                              |
| -------------------- | ------------- | ------------------------------------------------- |
| input_text           | text          | 非空文本                                          |
| input_workspace_file | path          | 项目内现有普通文件相对路径，内容不自动附加        |
| input_file           | file_id       | 先上传的会话文件，不接受 filename/size 等展示字段 |
| input_skill          | id；name 可选 | 显式引用 Skill                                    |
| input_mcp_server     | name          | 显式引用 Server                                   |

stream=true 或 Accept:text/event-stream 时返回 200 SSE；否则等待本次执行边界后返回 201 Response。工具等待审批也是执行边界，不会让一个请求一直等待用户决策。

Response 的字段见 [types.ts](../agent/src/http/agent-responses/types.ts)：id/object/session_id/status/model/reasoning_effort?/permission_mode/input/output/pending_permission_batch?/error?/created_at/updated_at/completed_at?。

output 类型为 message、reasoning、function_call、function_call_output、web_search_call、permission_request。内部 tool_call/tool_result 由 presenter 转为外部 function_call/function_call_output；function_call_output.output 为序列化字符串，可能另含 content 媒体。

## 7. 查询、取消和审批

| 方法/路径                                                   | 请求/返回                                                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| GET /sessions/:sessionId/responses/:responseId              | 当前完整 Response                                                                |
| POST /sessions/:sessionId/responses/:responseId/cancel      | Response；仅 in_progress/waiting_permission 可取消，已 cancelled 幂等            |
| POST /sessions/:sessionId/responses/:responseId/permissions | `{batchId,decisions}`；Accept:text/event-stream 返回新的 SSE，否则 JSON Response |

审批请求：

```json
{
  "batchId": "permission_batch_实际批次ID",
  "decisions": [
    { "permission_id": "permission_实际ID", "decision": "approve" },
    { "permission_id": "permission_另一ID", "decision": "deny", "reason": "不执行这个操作" }
  ]
}
```

必须覆盖当前批次全部权限 ID，无重复或未知项；approve 不接受 reason。审批恢复沿用原 Run，新的 HTTP 流首先可能是 agent.permissions.resolved，无新的 response.created。

## 8. 模型和供应商账号

源码：[provider-account.schemas.ts](../agent/src/http/provider-accounts/provider-account.schemas.ts)、[model.schemas.ts](../agent/src/http/models/model.schemas.ts)。

| 方法/路径                                       | 请求/返回                                                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| GET /provider-accounts                          | `{data:账号视图[]}`；凭据为 hasCredential                                        |
| POST /provider-accounts                         | `{displayName,baseURL,apiKey}` → 201 账号视图                                    |
| PATCH /provider-accounts/:accountId             | displayName?/baseURL?/enabled?，至少一项 → 账号视图                              |
| PUT /provider-accounts/:accountId/credential    | `{apiKey}` → 204                                                                 |
| DELETE /provider-accounts/:accountId/credential | 清除所有凭据版本，204                                                            |
| DELETE /provider-accounts/:accountId            | 删除账号及目标/凭据，204                                                         |
| POST /provider-accounts/:accountId/models       | `{providerModel,displayName,protocol,capabilities?}` → 201 模型目标记录          |
| GET /models                                     | sessionId?；`{data,selectedModelTargetId?,selectedReasoningEffort?,diagnostics}` |
| PATCH /models/:modelTargetId                    | providerModel?/displayName?/protocol?/capabilities?/enabled?，至少一项           |
| DELETE /models/:modelTargetId                   | 删除模型目标，204                                                                |
| PUT /models/preference                          | `{modelTargetId:string或null,reasoningEffort?:值或null}` → 204                   |

protocol 取 responses/chat_completions/anthropic_messages；reasoningEffort 取 none/minimal/low/medium/high/xhigh/max。能力 schema 和驱动差异见[模型模块](modules/models.md)。

账号视图包含 id/displayName/baseURL/enabled/hasCredential/createdAt/updatedAt。模型创建与编辑直接返回 ModelTargetRecord（含 ownerId/accountId 等内部字段）；GET /models 返回选择目录的模型视图与诊断，不能假定这三者返回同一 DTO。

## 9. 提示词、搜索、Skills 和 MCP

| 方法/路径                     | 请求/返回                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------- |
| GET /prompt-settings          | 当前 settings 或默认值                                                          |
| GET /prompt-settings/defaults | 默认 revision=0 的 blocks                                                       |
| PUT /prompt-settings          | `{revision,blocks}` → 增加 revision 的 settings                                 |
| GET /web-search               | 当前设置/hasCredential                                                          |
| PUT /web-search               | `{enabled,provider?,mode?,baseUrl?,apiKey?}`                                    |
| DELETE /web-search/credential | 清除独立搜索 key，返回设置                                                      |
| POST /web-search/test         | 真实外部搜索结果，不测试模型原生能力                                            |
| GET /skills                   | q?/category?/page?/limit?/sessionId?/projectId?，返回 `{data,total,page,limit}` |
| GET /skills/:skillId          | Skill 详情，含 manifest/files/languages/digest/diagnostics                      |
| GET /mcp                      | 状态摘要 `{servers}`                                                            |
| GET /mcp/servers              | 完整配置/状态 `{servers}`                                                       |
| GET /mcp/catalog              | 菜单摘要 `{servers}`                                                            |
| PUT /mcp/servers/:name        | command/args?/cwd?/env?/enabled?                                                |
| DELETE /mcp/servers/:name     | 204                                                                             |
| POST /mcp/test                | `{name,config}` → `{tools}`                                                     |

提示词 block 为 id/title/text/enabled，最多40块，单块正文最多30000字符，总正文最多120000字符，ID唯一；revision 与当前值不符返回409。Skills sessionId/projectId 查询互斥，分页具体范围以 [skill.schemas.ts](../agent/src/http/skills/skill.schemas.ts) 为准。

## 10. SSE 协议

SSE 来源为当前 POST 执行，普通 frame：

```text
data: {"type":"response.output_text.delta","response_id":"resp_...","sequence_number":3,"item_id":"msg_...","output_index":0,"content_index":0,"delta":"你好"}

```

每15秒发 `:keep-alive` 注释。领域事件投影带 response_id 和递增 sequence_number，前端按序去重。当前没有持久化完整事件日志或 Last-Event-ID 重放接口。

| 事件组    | 事件                                                                                   |
| --------- | -------------------------------------------------------------------------------------- |
| Run       | response.created/completed/failed/incomplete/cancelled                                 |
| output 项 | response.output_item.added/done                                                        |
| 文本      | response.content_part.added/done、response.output_text.delta/done                      |
| 推理摘要  | response.reasoning_summary_part.added/done、response.reasoning_summary_text.delta/done |
| 推理正文  | response.reasoning_text.delta/done                                                     |
| 工具参数  | response.function_call_arguments.delta/done                                            |
| 工具完成  | agent.tool.completed                                                                   |
| 权限      | agent.permissions.requested/resolved                                                   |
| 领域错误  | type=error                                                                             |

run 方法在校验/创建/恢复阶段抛出的控制错误可能在已经发出200头之后以 `event:error`、`data:{error:{code,message,details?}}` 返回。它不是普通 type=error 领域事件，也不能仅通过 HTTP 状态判断成功。

正常边界为四种 response 终态或 agent.permissions.requested；服务器随即 end。无需等待 `[DONE]`，当前服务不以它作为正常结束标记。断开读取不自动取消执行，停止应调用 cancel。

## 11. 错误

普通 JSON 错误结构：

```json
{
  "error": {
    "code": "project_active_response_exists",
    "message": "Project already has an active response.",
    "details": { "sessionId": "session_...", "responseId": "resp_..." }
  }
}
```

验证错误 details 为 source 和 issues（path/code/message）。未知异常返回500/internal_error，详细错误写日志；执行中失败可表现为200流内 response.failed。常见分类：

| HTTP            | 例子                                                               |
| --------------- | ------------------------------------------------------------------ |
| 400             | invalid_request、无效项目路径、审批决定不完整、推理强度不支持      |
| 401             | 本地业务 token 无效                                                |
| 404             | 项目/会话/响应/附件/Skill/模型不存在                               |
| 409             | 活动执行冲突、旧审批批次、模型不兼容、已绑定、提示词 revision 冲突 |
| 413             | 文件大小/累计附件超限                                              |
| 415             | 文本工具读取不支持类型/编码                                        |
| 422             | MCP 测试连接失败                                                   |
| 429 / 502 / 504 | 外部搜索限流/不可用/超时                                           |

最终映射见 [api-error.ts](../agent/src/http/common/api-error.ts)。
