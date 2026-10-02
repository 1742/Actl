# 模型与协议适配模块

## 1. 账号、目标和快照

[ModelStore](../../agent/src/runtime/model-store.ts) 管理供应商账号、用户模型目标、偏好以及执行快照；配置类型在 [catalog-types.ts](../../agent/src/model/catalog-types.ts)。

账号保存显示名、Base URL、启用状态、currentVersion 和 credentialVersion。模型目标引用 accountId，保存 providerModel、协议和能力。HTTP `model` 传的是本地 targetId，不是供应商模型名。

账号地址/显示名/启用状态变更增加账号版本；替换凭据增加凭据版本并增加账号版本。resolveSnapshot 检查目标、账号启用状态、凭据及推理强度，固定：

```text
targetId / displayName / providerModel
accountId / accountVersion / credentialVersion / baseURL
protocol / capabilities / reasoningEffort
```

getClientForSnapshot 读取该账号版本和凭据版本，解密后创建客户端。暂停审批后继续沿用快照，当前偏好不覆盖已创建 Run。删除/清凭据涉及历史版本处理，具体保留规则在[存储模块](storage.md)，不能认为所有旧凭据始终可用。

## 2. 模型能力

| 字段                                    | 实际作用                                                       |
| --------------------------------------- | -------------------------------------------------------------- |
| input.text                              | schema 固定为 true                                             |
| input.imageMimeTypes                    | 图片兼容判断、图片历史占位及 read_image 工具过滤               |
| input.audioMimeTypes                    | 通用 transcript 兼容信息；当前上传链路不物化音频附件           |
| toolCalling                             | 不支持时不给工具；有未压缩工具历史时可能拒绝模型切换           |
| parallelToolCalls                       | 供应商可否生成并行工具调用；不等于宿主批次执行全部并行         |
| nativeWebSearch                         | Responses 原生搜索策略候选，toolCalling=false 时规范化为 false |
| reasoningEfforts/defaultReasoningEffort | 请求验证与默认推理选项                                         |
| contextWindow                           | 80% 自动压缩阈值                                               |
| maxOutputTokens                         | 传入统一 turn 请求；当前 Anthropic encoder 写入 max_tokens     |

能力来自用户设置，不通过供应商探测。默认 `TEXT_TOOL_CAPABILITIES` 为文本、工具调用及并行调用，无图片/音频、无原生搜索/推理强度。无效默认推理值不作为有效选项使用。

GET models 可传 sessionId，handler 结合当前未压缩历史附 compatible/incompatibilityReasons。新输入还会在 AgentLoop 再检查。历史图片可改为占位；当前新图仍必须支持。

## 3. 客户端接口与统一表示

[client.ts](../../agent/src/model/client.ts) 的核心是 `runTurn(request, emit, options)`。request 包含 instructions、transcript、tools、parallelToolCalls、reasoningEffort 和可选 nativeWebSearch/maxOutputTokens；options 可携带 AbortSignal。

结果包含 output、finishReason、供应商 response ID 和 usage；增量转换成 output_item_started/completed、text_delta、reasoning_delta、tool_call_delta、usage。AgentLoop 不直接解释供应商 SSE 字段。

[client-factory.ts](../../agent/src/model/client-factory.ts) 根据 protocol 选择 AnthropicMessagesDriver 或 OpenAICompatibleDriver，后者委托 ResponsesDriverBase/ChatCompletionsDriverBase。

## 4. 已接入协议

| protocol           | 请求与驱动                                      | 转换目录                                                                                      |
| ------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| responses          | OpenAI SDK responses.create，stream=true        | [protocols/responses](../../agent/src/model/protocols/responses/encoder.ts)                   |
| chat_completions   | OpenAI SDK chat.completions.create，stream=true | [protocols/chat-completions](../../agent/src/model/protocols/chat-completions/encoder.ts)     |
| anthropic_messages | fetch Messages endpoint，SSE，自定义 decoder    | [protocols/anthropic-messages](../../agent/src/model/protocols/anthropic-messages/encoder.ts) |

Responses 将 instructions 独立传递，开启 reasoning encrypted_content 重放；原生搜索启用时加入 web_search 工具并请求 sources。终端必须收到 completed/incomplete；failed/error 抛异常。

Chat Completions 编码 instructions 为消息，转换 function calls/results，请求 stream_options.include_usage 和 reasoning_effort。decoder 将文本、工具参数和支持的推理字段统一为领域项。

Anthropic 使用 x-api-key、anthropic-version 请求头；Base URL 根路径时补 `/v1/messages`，已有路径时追加 `/messages`。编码器合并相邻同角色 block，tool_result 作为 user 内容，thinking 重放保留原签名/redacted 数据。max_tokens 默认 8192；effort 只在 low/medium/high/xhigh/max 时写入 output_config。

reasoningEfforts 为统一可配置值，不表示每种协议及每个模型都接受全部选项；配置错误仍可能被供应商拒绝。

## 5. 工具结果与媒体

工具结果首先包含结构化 JSON；`RichToolOutput` 可另带 stored_file 图片快照。调用模型前物化为图像数据，协议层 [tool-result-media.ts](../../agent/src/model/protocols/tool-result-media.ts) 将图片转换到相应消息位置，避免供应商不支持 tool result 内图片的限制。

兼容性检查见 [compatibility.ts](../../agent/src/model/compatibility.ts)。当前直接 file 内容被兼容性判断标为不支持；即使某个 encoder 有 PDF document 分支，也不代表用户上传 PDF 已在业务链路接入。

## 6. 超时、取消和重试的实际行为

OpenAI 驱动默认 timeout 300000 ms，SDK maxRetries=0，并逐事件检查流时长超过 timeout+30 秒。Anthropic 使用 300000 ms 的 AbortSignal.timeout 与用户取消信号组合。

[retry.ts](../../agent/src/model/retry.ts) 提供退避工具，但当前驱动不调用 withRetry；不要将它的默认三次重试描述为当前模型请求行为。Agent HTTP 层另有 10 分钟请求期限。

当前 Responses/Chat 驱动 body 未写入统一请求的 maxOutputTokens；Anthropic encoder 会写入。此为实际实现差异，后续补齐时需同步更新此处。

## 7. 接口与维护

账号路由位于 [provider-account.routes.ts](../../agent/src/http/provider-accounts/provider-account.routes.ts)，模型路由位于 [model.routes.ts](../../agent/src/http/models/model.routes.ts)。完整接口见[API](../api.md)。

新增协议时应同时接入 factory、协议类型/schema、能力兼容判断、编码/解码和终态识别，并确认前端设置支持该值。仅新增 driver 文件不构成完整可选协议。
