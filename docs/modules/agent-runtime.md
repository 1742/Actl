# Agent 执行与上下文模块

## 1. 运行入口

[main.ts](../../agent/src/main.ts) 加载 dotenv/config，读取环境配置，校验本地令牌，创建文件日志和应用依赖，然后装配 Express。生命周期路由先于业务路由注册；关机中业务请求返回 503。

HTTP 中间件包括 cors、请求日志、JSON 解析、全局 10 分钟请求期限和统一错误处理。prompt-settings 的 JSON 上限单独设为 512 KiB，其余使用 express.json 默认。server.timeout=0，keep-alive 为 5 分钟，headers timeout 比它长 5 秒；不能据此认为 HTTP 请求无限时长。

[app/dependencies.ts](../../agent/src/app/dependencies.ts) 负责装配实例，[http/routes.ts](../../agent/src/http/routes.ts) 负责路由挂载。handler 做边界校验与 DTO 转换，将业务交给运行时。

## 2. 领域模型

[model/types.ts](../../agent/src/model/types.ts) 定义统一 Transcript 和 ModelTurn 数据；[agent-domain.ts](../../agent/src/runtime/agent-domain.ts) 定义 Run、权限批次、领域事件。

Run 保存模型快照、权限快照、输入消息、时间线、可选批次/错误、时间戳及 nextSequenceNumber。时间线包含 message、reasoning、tool_call、tool_result、web_search 和 permission_request。

`buildModelTranscript()` 跳过已被滚动摘要覆盖的 Run，将剩余 Run 输入与时间线拼接，并过滤 permission_request。审批是宿主交互，不作为普通模型对话项重放。

## 3. WorkspaceStore

[workspace-store.ts](../../agent/src/runtime/workspace-store.ts) 将 SQLite 仓库包装为运行状态服务：

- initialize 只加载项目和会话索引，不一次读取所有完整历史。
- getSession 首次加载运行、文件变化、摘要、压缩记录和 provider response IDs，然后缓存。
- 创建/更新/删除、写时间线经 mutationQueue 顺序提交。
- touch 比较当前时间线 JSON 与已持久化 payload，只写变化项。
- 模型 usage 更新 lastInputTokens；summary 和 compression 分别记录当前状态与历史。

list 方法通常提供拷贝，getSession 提供运行时对象；AgentLoop 会更新同一 Run，再通过 touch 落库。修改此行为需同时考虑引用一致性和写入顺序。

## 4. 执行生命周期拆分

| 文件                                                                                                          | 职责                                            |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| [agent-loop.ts](../../agent/src/runtime/agent-loop/agent-loop.ts)                                             | 创建、继续、审批恢复、取消、压缩和模型事件消费  |
| [response-execution-lifecycle.ts](../../agent/src/runtime/agent-loop/response-execution-lifecycle.ts)         | 预留/占用范围、跟踪 promise、终态释放、维护操作 |
| [response-concurrency-coordinator.ts](../../agent/src/runtime/agent-loop/response-concurrency-coordinator.ts) | 按 project/session key 协调执行和维护互斥       |
| [run-execution-manager.ts](../../agent/src/runtime/agent-loop/run-execution-manager.ts)                       | Run 的 AbortController、运行 promise 和取消协作 |
| [tool-batch-executor.ts](../../agent/src/runtime/agent-loop/tool-batch-executor.ts)                           | 工具准备、权限批次、并行/串行执行、结果记录     |
| [agent-run-finalizer.ts](../../agent/src/runtime/agent-loop/agent-run-finalizer.ts)                           | 终态、取消/失败补齐、持久化及事件               |

项目会话使用 project 范围，独立会话使用 session 范围。创建前先预留，失败释放；waiting_permission 保持占用；终态释放。恢复占用时检查持久化历史，防止重启后待审批 Run 被绕过。

maintenance 用于删除/绑定/压缩等操作，阻止与新 Run 创建交错。idle maintenance 额外检查当前范围无活动 Run，删除 handler 则在 maintenance 内取消、停止进程、删除数据。

## 5. 创建与执行循环

run 先解析模型版本快照并检查历史/当前输入兼容性，再进入 lifecycle.create。预留范围后，按需压缩旧历史，校验显式 Skills/MCP，创建响应和权限快照，发 run_created。

continue 每次至多 100 步：

1. 检查取消；如时间线有未解决的工具调用，先执行或进入审批。
2. 根据当前搜索设置和模型快照选择原生/外部搜索策略。
3. 从 ToolRegistry 取模型可用工具；使用原生搜索时移除普通 web_search 工具。
4. 取得摘要之后的模型上下文，物化 stored_file 和历史图片，再物化当前输入的 Skill/MCP 引用。
5. PromptCompiler 生成 instructions 和 transcript。
6. 根据快照拿模型客户端，调用 runTurn 并消费增量事件。
7. 记录供应商响应 ID/usage，补入只在最终结果出现的 output 项。
8. unknown finish 视为错误，length/content_filter 结束为 incomplete；存在 function calls 时处理批次并继续。
9. 无工具调用时发 Stop hook，未阻止则 completed；阻止则追加提示继续。

期间异常归入 failed；signal 已取消则 cancelled。工具层产生普通错误结果不一定使 Run 失败。

模型快照固定；工具名单、提示词设置、项目指令和搜索设置在后续模型轮次仍可能重新读取，不能将“Run 快照”扩大为全部运行环境被冻结。

## 6. 提示词编译

[prompt-compiler.ts](../../agent/src/runtime/prompt-compiler.ts) 顺序拼接：

1. 运行环境/会话 cwd。
2. 有 cwd 时读取其根目录 AGENTS.md。
3. 同目录 instructions.md。
4. 用户设置中的启用且非空文本块，按数组顺序。
5. 已有滚动摘要，以 conversation_summary 标记为上下文。

默认说明是 `createDefaultPromptSettings()` 返回的一个可编辑用户块，不另行不可变追加同样的基础说明。文件缺失忽略，其他读取错误会传播。sources 记录各部分来源/字符数，当前响应 DTO 未将完整 sources 暴露为单独业务 API。

项目指令每次编译读取，不递归发现父目录或子目录 AGENTS.md。编译器不执行 Skill 脚本，显式 Skill 只转为提示引用，完整正文按需读取。

## 7. 压缩

自动触发以最后一次供应商 inputTokens 和 contextWindow×0.8 判断，不是扫描本地所有文本估算。只压缩当前尚未覆盖的历史 Run；将旧摘要加入压缩 instructions，使用 tools=[]、parallelToolCalls=false 请求替换摘要。

成功后保存 summary、累计 summarizedRunCount 和 compression 记录，不删除原始 Run。新上下文跳过覆盖前缀并在 prompt 中带摘要。手动 compact 使用指定模型且要求范围空闲；如果没有新的未总结 Run，返回 compressed=false。

## 8. 持久化与恢复的时机

文字增量先修改内存与推送 SSE，不每个 token 都独立写数据库；output item 完成、工具结果、权限状态和终态等时机 touch。进程突然退出可能丢失尚未落库的局部增量。

首次加载会话时，in_progress 改 failed/runtime_interrupted；非 waiting_permission Run 的未配对工具调用补错误结果，避免跨模型重放无效工具历史。waiting_permission 保留批次用于再次审批。

取消/失败 finalizer 拒绝尚未解决权限并补齐工具结果，再写终态。已发生的文件副作用不会因 Run 取消自动撤销。

## 9. Hook 扩展点

[event-bus.ts](../../agent/src/hooks/event-bus.ts) 提供 PreToolUse、PostToolUse、Stop，依注册顺序执行，遇 blocked 返回。当前 app 装配为空的进程内 bus，未注册默认 hook，也没有配置驱动的用户 hook 或外部 hook HTTP API。

PostToolUse 的返回阻止信息目前不用于回滚工具；Stop 阻止时只促使循环继续。扩展 hook 需考虑取消、失败与持久化，不应把事件名称当成已有插件系统。
