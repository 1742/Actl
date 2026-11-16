# Multi-Agent Harness 架构重设计方案

> 状态：设计基线 / 待按现有仓库落地  
> 范围：同一根对话（Root Conversation）下的持久化多 Agent 协作  
> 原则：**先重建清晰的内核抽象，再修改工具表面；禁止以兼容性补丁代替架构调整。**

## 0. 交付目标与非目标

### 目标

建立三套相互独立、通过明确事件和标识关联的机制：

1. **通信（Messaging）**：持久邮箱；任意有权限的同根对话 Agent 之间可以发信、搜索、回复和等待；不承担任务状态的权威变更。
2. **任务（Tasks）**：发布、依赖、委派、认领、执行、提交验收及最终验收；Task Store 是任务状态的唯一权威来源。
3. **执行与结果（Execution & Results）**：Session 可复用、Run 是一次执行、最终回复形成一次 Run 的结果；关联到 Task 的成功 Run 可自动提交待验收成果，不需额外唤醒模型“补交结果”。

保留角色预设、根对话的可替换 Plan、Agent Directory；将内部 ID、并发控制、路由、事件订阅、去重尽可能留在 Runtime。

### 非目标

- 不将 Harness 改造成通用操作系统、微内核或跨机器 Actor 平台；“小型操作系统”只是帮助划分职责的类比。
- 不在第一版实现基于 LLM 的自动调度评分、复杂能力推断或跨 Root 的代理发现。
- 不追求邮件语义上的全局严格顺序、分布式 exactly-once；目标是**可靠持久化 + 幂等处理 + 单 Agent 同时只有一个活跃 Run**。
- 不让自然语言消息本身成为任务完成、领取、取消的状态变更指令。
- 不为旧 API 叠加无休止的 wrapper、callback 链或带大量可选字段的万能 DTO。

## 1. 已确定的产品决策

| 主题 | 决策 |
|---|---|
| 全局 Plan | 每个 Root 一份当前 Plan，后写覆盖前写；用于向用户展示和提醒父 Agent，**不参与执行调度** |
| Task | 独立于 Plan，具有类型、依赖、状态、负责人和成果；发布到共享任务板 |
| 角色 | Agent 创建时注入 Role Preset（General、Explore、Reviewer 等）；角色不是组织关系和权限的同义词 |
| Agent 生命周期 | **复用 Session**，每次唤醒创建新 Run；上下文组装和压缩沿用现有 Harness 能力（方案 B） |
| 委派 | 父 Agent 可创建新子 Agent、指定现有 Agent，或让 Runtime 自动寻找匹配的空闲 Agent |
| 自动分配 | 显式指定优先；否则按确定性的 FIFO 匹配同类型空闲 Agent；无匹配者时任务保留 Pending，通知父 Agent 决策 |
| 认领 | 原子操作；抢同一任务只有一个成功，失败者收到工具结果但**不额外唤醒** |
| 结果 | 正常完成一个承载任务的 Run 后，将最终回复作为任务成果提交，进入 `review_required`；不再为了提醒“声明结果”额外运行一轮模型 |
| 验收 | 父 Agent（或明确授权的验收者）审查后接受/退回；**Run 成功 ≠ Task 完成** |
| 通信 | 邮箱是独立机制，允许父子及兄弟 Agent 交流，支持关键词、时间、发件人、主题与关联回复筛选 |
| 等待 | 一个统一等待机制，既可等待邮件，也可等待 Run/Agent/Task 状态变化；无关但需处理的来信允许提前唤醒 |
| 消息唤醒 | 同一 Agent 最多一个活跃 Run，事件排队、合并、去重；进度消息默认不强行打断 |
| Agent Directory | 可查询同 Root 成员、角色、状态、当前任务、最近活动摘要；用于寻找协作者 |

## 2. 核心概念和边界

**Root**：一个多 Agent 协作空间，拥有当前 Plan、Task Store、Agent Directory 与邮箱作用域。

**Plan**：面向用户和父 Agent 的自然语言计划；可覆盖；没有任务状态权威性。

**Agent**：持久身份，绑定角色、权限、所属 Root、可复用 Session；可以跨多个 Run/Task 存在。

**Session**：Agent 的持久会话上下文。**现有上下文装配/压缩机制应复用，不重造**。

**Run**：对某 Session 的一次执行（正常结束、等待/挂起、失败、取消等）；必须有明确终止原因。

**Task**：工作契约及执行状态，由 Task Store 管理；有类型、依赖、指派者、认领者、验收者等。

**Task Attempt**：Task 的一次执行/交付尝试，关联一个或多个 Run（例如等待邮件后恢复执行）；审查退回后开启新 Attempt，而非覆写历史。

**Message**：持久信件（sender、recipient、subject、body、purpose、thread/reply-to、timestamps 等）；表达意图，不是状态机命令。

**Result**：某次 Attempt 的交付内容，通常来自成功完成的 Run 的 final output；与 Message 分离。一个 Attempt 至多有一个权威的已提交 Result。

**Event**：Runtime 内部不可变事实（MessageReceived、TaskAssigned、TaskReviewRequested、RunFinished 等），用于唤醒和投递；事件不是新的 Agent 自然语言消息。

### 权威来源（Single Source of Truth）

- Task 状态：Task Store。
- Agent 身份与角色：Agent Registry/Directory。
- Session 历史：既有 Session Store。
- Run 状态与输出：Execution Store。
- 邮件原件和已读/已处理标记：Mailbox Store。
- 结果与验收记录：Result / Task Attempt Store。
- Plan：Root Plan Store。

不同视图可以组合读取，但不可互相猜测、倒推或复制状态。例如“我完成了任务”的邮件不会自动把任务设为 `completed`。

## 3. 推荐的模块划分

仅供参考， actl 本身也有划分合理的设计。

```text
RootCoordinator（仅编排边界，不承载所有业务逻辑）
 ├─ PlanService          # 单份当前 Plan；覆写与读取
 ├─ AgentRegistry        # 身份、角色、能力/权限、目录查询
 ├─ TaskService          # 状态机、依赖、原子认领、分配、审查
 ├─ MailService          # 持久邮箱、检索、回复关系、投递
 ├─ ExecutionService     # Session/Run 生命周期、final output、恢复
 ├─ Scheduler            # 匹配空闲 Agent、FIFO、公平队列
 └─ EventDispatcher      # 可靠事件、等待订阅、唤醒、合并
```

模块之间通过**少量明确命令和领域事件**连接，不通过任意 callback 嵌套连接。业务状态迁移封装在所属 Service；协调层不直接更新别人的存储字段。

不必为每个方框建一个网络服务或独立线程；在单进程 Harness 中可以是普通内聚模块和接口。优先**可理解的单体架构**，而非提前微服务化。

## 4. 任务状态机

建议的最小状态集合：

```text
pending --(依赖满足、分配/领取)--> assigned --(开始执行)--> running
   ^                                      |                    |
   |                                      |                    | 成功交付 Result
   |                                      |                    v
   |                                      +--------------> review_required
   |                                                            |
   |                                      +---------------------+------------------+
   |                                      |                                        |
   |                                   accept                                   reject
   |                                      v                                        v
   |                                  completed                            pending/assigned
   |
   +---- 运行失败/租约过期后依据重试政策恢复

其他终态：cancelled；无法恢复时 failed。依赖未满足是 pending 的阻塞原因，
不必一开始增加独立的 blocked 状态。
```

### 强制约束

1. 只有依赖均满足的 Pending Task 才能进入可领取/分配集合。
2. 认领必须原子完成；同一时刻 Task 只有一个有效占有者。
3. `review_required` 只表示提交了成果，**不能自动进入 completed**。
4. 审查接受必须由授权验收者显式调用；审查退回记录理由并增加 Attempt。
5. 任务完成/取消后，依赖它的任务由 Runtime 重新计算可调度性；不可在 LLM 中轮询依赖。
6. 依赖图必须拒绝环；已运行任务的依赖修改应限制或明确重新调度语义。
7. Agent 失联不能让任务永久锁死；Runtime 维护心跳或任务租约，超时后执行回收策略。
8. Task 变更事件与持久状态一致提交，避免“改完任务但忘了通知”。

### 任务分配规则

1. `delegate(task, agent=...)`：指定现有 Agent，校验 Root、权限、空闲/可用性和能力。
2. `delegate(task, create={role,...})`：创建子 Agent 并分配；必要时提供初始提示/执行上下文。
3. 未指定时：从匹配类型且空闲的 Agent 中按确定性 FIFO 选择（稳定 tie-breaker，例如 idle_since、创建顺序、内部 ID）。
4. 无匹配时：Task 保持 `pending`，记录 `unassigned` 原因，向发布者或父 Agent 发送此次工具调用结果；让其选择创建、指定或等待，不回滚已创建任务。
5. 可由子 Agent `claim(task)` 主动认领，仍遵守同一原子状态机；竞争失败只返回工具错误/冲突结果。
6. Agent Role 与 Task Type 暂时用规则表匹配；保留将来扩展 capabilities 的空间，**不要先做万能可选字段能力模型**。

### 提交和验收

- 若执行属于 Task Attempt，且 Run 正常产出 final output，则 Runtime 以唯一键 `(task_id, attempt_id)` 提交 Result、将任务转为 `review_required`，通知验收者。
- 同一个 Attempt 重复收到 RunFinished 事件不能生成第二份 Result。
- 若 Run 异常、取消、超时：按失败/重试策略处理，**不能误认为已完成**。
- 邮件仅为沟通，不触发任务状态变成 completed；父 Agent可以据此沟通或审查，但最终状态变化走 TaskService。

## 5. 邮箱与通信

### 邮件数据

推荐明确的必填核心字段：`id, root_id, sender_agent_id, recipient_agent_id, subject, body, created_at`；可选的领域字段使用清楚的类型表达，例如 `purpose = information | question | progress | urgent`、`thread_id`、`in_reply_to`。不要求所有邮件都有 reply-to，不使用通用的任意 `metadata: Record<string, any>` 替代核心语义。

- 邮箱可按发件人、关键词、主题、时间范围、purpose、未读/待处理、线程筛选。
- 支持父子与兄弟 Agent 的同 Root 定向通信；跨 Root 默认禁止。
- 默认提供语义别名 `@parent`、当前作用域下唯一的 `@reviewer` 等；多匹配必须提示明确选择。
- 内部保存稳定、唯一 ID；工具层可显示 `#12` 等短别名，但**不把标题/昵称当数据库主键**。
- 对没有显式关联的 `reply`，仅在待回复请求唯一且无歧义时补全；否则要求选择。
- 消息持久化不等于马上执行 LLM；投递、唤醒和读取分别定义。

### 结果与消息的区别

- `send_mail` 永远是**显式通信**；可以说“我完成了”，但不会因此改变 Task 的权威状态。
- 子 Agent final output 是**执行结果**，由 Runtime 交付给 Task Attempt；不自动伪装成“Agent 发来的一封普通邮件”。
- 父 Agent 可在 Inbox 视图里看到 ResultAvailable 的系统通知，但通知只引用 Result ID，不能复制 Result 成第二个权威数据副本。

## 7. 统一等待和唤醒

一个 Runtime 等待原语，支持等待条件的判别联合：

```ts
 type WaitCondition =
   | { kind: 'mail'; from?: AgentRef; replyTo?: MessageRef }
   | { kind: 'task_state'; task: TaskRef; states: TaskState[] }
   | { kind: 'agent_state'; agent: AgentRef; states: AgentState[] }
   | { kind: 'run_finished'; run: RunRef };
```

工具层可以提供简洁的 `wait(...)`，将引用解析、订阅创建与恢复交给 Runtime。实现上不能将缺省参数组合成含糊的“随便等任何事件”。

### 唤醒策略

1. 期望事件满足订阅：恢复 Agent，并带上触发事件。
2. 不匹配订阅的来信：`question/urgent` 默认可提前唤醒；`progress/information` 默认入队、不中断（可配置）。
3. 被非预期消息唤醒时，向 Agent 注入原等待条件和截止时间。Agent 可在此 Run 中回信，随后调用 `wait` 继续原条件和原截止时间。若匹配事件已到，Runtime 可以把结果交给当前 Run。若 Agent 只处理来信就输出 final，保留这轮 Run 的历史和原等待，继续等待匹配事件或超时。只有匹配、超时或显式取消已交付给执行时，后续 final 才能提交为当前 Attempt 的 Result。
4. 同 Agent 同时只允许一个 Run，其他事件入队；恢复时批处理多封信件，避免 N 条邮件产生 N 次 Run。
5. 保留事件游标/消费标记，确保已经处理的邮件不会在每次恢复时重复当成新消息。
6. 支持明确的等待超时与取消；超时是事件/结果，不应伪装成邮件。
7. 订阅注册与当前条件检查必须避免竞态：例如“检查尚未完成 → 状态刚好变化 → 开始监听”导致永久错过事件。采用原子检查/订阅，或事件游标+二次检查。

## 8. Agent Directory

同一 Root 下的 Agent 可见：`alias, role, status, current_task, recent_activity`；可加 `capabilities` 但不是第一版必需项。

- `recent_activity` 优先由已有任务标题/状态、最近结果、已有会话摘要机械组合；不要额外建立独立的 LLM 摘要流水线。
- Directory 用于人工/模型决定委派和邮件对象；不能代替权限校验。
- 查询结果里提供短别名，模型不用复制难读的 Session UUID。

## 9. 存储与事件一致性

- 若使用关系数据库：任务认领使用条件更新、行锁或 CAS；不要只依赖进程内互斥锁。
- 每个状态变更必须在持久化成功后才对 Agent 报告成功。
- 采用**事务性 Outbox** 思路：Task/Run 状态变化与待投递事件写入同一事务；分发可重试。
- 事件携带全局或作用域唯一 `event_id`；消费者幂等。`Result` 采用 `(task_id, attempt_id)` 唯一约束。
- 确认真实需要后再引入分布式队列。单进程 + 一个 DB 中的 outbox/事件队列足以构建第一版可靠实现。
- 不要承诺无法证明的 exactly-once 交付；使用 at-least-once + 幂等。
- 任务占有权要有租约或其他故障恢复路径；租约过期需要防止旧执行者晚到的结果覆盖新 Attempt（使用 attempt/lease token 校验）。

## 10. 面向 LLM 的工具 API（建议语义，不强制命名）

| 工具 | 作用 | 核心原则 |
|---|---|---|
| `plan` | 查看/替换根 Plan | 纯展示与提醒，不驱动 Task |
| `tasks` | 发布、查看、认领、进度、验收/退回、取消 | 子动作类型清楚，内部原子化 |
| `delegate` | 显式委派到现有 Agent 或创建 Agent | 与 TaskService 使用同一分配路径 |
| `agents` | 查看 Agent Directory 与状态 | 语义别名、当前任务、最近活动 |
| `mail` | 发送、搜索、读、回复 | 消息无权直接改变任务状态 |
| `wait` | 等待邮件、Task、Agent 或 Run 事件 | 唤醒由 Runtime 控制 |

这些是**建议的工具表面**，不是要求把所有动作做成大量可选参数的万能工具；每个工具内部应使用明确命令类型/判别联合。若现有仓库已经有更清晰的工具组织，可以保留命名，优先保证语义一致。

## 11. 核心端到端流程

### A. 父 Agent 发布并自动分配任务

1. Parent 创建 Task，声明 Type、依赖与验收者（默认 Parent）。
2. TaskService 持久化任务；若依赖不满足，保持 Pending。
3. 依赖满足后 Scheduler 优先使用显式 Agent，否则 FIFO 匹配闲置 Agent。
4. 无匹配：Task 保留 Pending，通知 Parent，可等待未来 Agent 空闲。
5. 分配成功：原子记录负责人/Attempt，ExecutionService 在对应 Session 发起新 Run，并注入任务说明。
6. 子 Agent 可发进度邮件、请求帮助、等待回复。
7. Run 正常 final：Result 写入当前 Attempt，Task 转 `review_required`，通知验收者。
8. Parent 检查后 `accept` → Completed；或 `reject` → 创建新 Attempt 并重新安排。

### B. 子 Agent 协作通信

1. Explore 通过 Directory 找到 Reviewer，发送问题邮件（携带 subject/thread）。
2. Reviewer 收到邮件，若其在等待中且该消息值得打断，Runtime 恢复它；若忙则排队。
3. Reviewer 通过 `reply` 回答；Explore 等待的 `reply_to` 条件满足。
4. Runtime 恢复 Explore，同 Session 继续原 Task Attempt。
5. 回复不会自动完成任务；Explore 正常交付 final 才进入审查。

### C. 意外消息打断等待

1. Parent 正等待 Reviewer 的回答。
2. Coder 发送 `question`；其优先级满足中断策略。
3. Runtime 保留原等待条件，恢复 Parent，告知“等待 Reviewer 中收到 Coder 来信”。
4. Parent 处理问题后继续等待；若 Reviewer 的回复已同时到达，应一起呈现而不是丢弃或重复启动。

### D. 故障与重试

1. Agent 执行时崩溃/超时，Run 标记失败。
2. Runtime 根据重试策略恢复原 Attempt 或使其失败并创建新 Attempt；不得重用已经失效的 lease token。
3. 出现重复完成事件时唯一约束阻止重复 Result；任务状态变更对消费者幂等。
4. Parent 可以看到清晰的失败、重试和验收历史。

## 12. 重构约束（给 Codex 的硬性要求）

1. **先读现有实现，再改造**：定位 Session/Run、上下文压缩、角色预设、任务板、工具注册、消息传递和持久化现状；给出现状与目标映射。
2. **先确定权威数据模型与状态机**，再调整工具层；不得在工具 handler 里各写一份任务状态逻辑。
3. **拒绝补丁式包装**：不能通过层层 wrapper、临时 callback、事件互相转发来维持旧设计；允许破坏内部 API 并统一替换调用点。
4. **拒绝可选字段泛滥**：使用明确类型、判别联合和不变量；避免 `agentId?`, `runId?`, `taskId?`, `result?` 同时可空的万能载荷。
5. **同一概念只维护一套状态**：特别避免 Agent 状态、Run 状态、Task 状态互相复制并漂移。
6. **所有事件处理可重试且幂等**：不要假设事件只会投递一次。
7. **同步和异步职责清晰**：状态变化的事务边界明确；通知/唤醒由事件分发完成，不在持锁事务内调用 LLM。
8. **优先删掉旧机制**：替换后移除废弃工具与字段；确需迁移时只提供短期、明确范围的兼容层并写删除计划。
9. **优先内聚而非抽象层数**：不为“像 OS”而生造 ProcessManager/Kernel/IPCAdapter 等空壳类；命名须对应真实业务不变量。
10. **现有上下文机制继续使用**：Agent 复用 Session，调用既有组装/压缩，不重复实现。
11. **对外不泄露内部 UUID 负担**：模型界面提供作用域受限的短引用，歧义显式报错。
12. **先用类型和测试证明边界可靠**，再优化调度策略或性能。

## 13. 关键验收测试

- 两个 Agent 同时认领同一任务，仅一个成功，失败者只收到当前工具调用结果。
- 依赖未满足不能领取；依赖满足后自动成为可分配状态；循环依赖被拒绝。
- 没有可用 Agent 时任务仍存在；后来出现符合条件 Agent 能被调度。
- 子 Agent 成功 final 后恰好生成一份 Result、任务进入 `review_required`，父 Agent 验收前不会 Completed。
- progress 邮件不改变 Task 状态；子 Agent final 不转成重复的普通结果邮件。
- Run waiting、failed、cancelled 均不能自动提交成功 Result。
- Task 审查退回后保存旧 Attempt/Result，新尝试能继续原 Session。
- 任意两个同 Root Agent 可以发信、筛选、回复；跨 Root 未授权通信被拒绝。
- 等待回复时收到意外 question 会被唤醒；原等待条件不丢；progress 可只入队。
- 多封邮件同时到达时不会为同 Agent 创建多个并行 Run；恢复后只呈现一次未处理事件。
- 在等待注册竞态边界发生的事件不会丢失。
- EventDispatcher 重试、重复 RunFinished、重复通知不会造成重复任务结果或状态回退。
- Agent 崩溃/租约过期后任务可恢复，旧 Attempt 晚到结果不能覆盖新 Attempt。
- 角色与权限校验、Root 隔离生效；Agent Directory 输出稳定别名和合理的最近活动。
- 覆盖 Plan 不取消已启动的 Task/Run；Plan 与 Task 状态各自独立。

## 14. 实施次序（允许大改，避免半新半旧）

**阶段 1：现状审计和目标数据结构。** 画出当前模块依赖图、列出所有旧工具/状态/消息路径，确定保留与删除名单；先设计实体、判别联合、状态机及不变量。

**阶段 2：内核数据与生命周期。** 实现 Task、Attempt、Result、Agent/Run 的权威状态迁移、原子认领和持久化事件；单元测试覆盖状态机。

**阶段 3：邮箱与事件等待。** 持久通信、检索、回复关联、统一订阅/等待、单 Agent Run 排他、批量唤醒、事件去重。

**阶段 4：调度和工具表面。** 显式分配/FIFO、Agent Directory、语义引用、面向 LLM 的简洁工具参数。

**阶段 5：替换旧路径并清理。** 切换调用方、迁移必要持久数据、删除重复结果邮件和“结束后再次唤醒交结果”机制、移除旧 wrapper/callback/冗余字段。

**阶段 6：端到端与故障注入。** 按第 13 节运行并发、重复事件、崩溃、意外唤醒、退回重做的测试，再确认可观测性和性能。

每阶段应能在代码评审中说明“新增了哪个权威抽象、删除了哪个旧抽象”，而不是只列新增文件。

## 15. 实现前仍需确定的少量策略

这些不是架构阻塞项，可以先使用给定默认值，之后根据实际体验调整：

1. **新任务到达已在等待的 Agent**：默认不抢占它当前拥有的 Task Attempt；仅入队，除非 Parent 显式取消/重排当前任务。避免同 Agent 两个活跃任务竞争上下文。
2. **一个 Agent 的并发任务数**：第一版默认最多一个正在执行/等待的主任务；跨任务并发由多个 Agent 实例承载。
3. **Role/TaskType 匹配**：默认精确同名或明确配置的兼容表；非匹配不偷偷兜底给 General。
4. **等待唤醒优先级**：`urgent/question` 可打断；`progress/information` 不打断，除非显式等待这些消息。
5. **审查者**：默认任务发布的父 Agent；允许未来显式委托，不在初版实现复杂审查委员会。
6. **任务移除**：建议完成后归档而非物理删除，保留结果、尝试及审计历史；UI 可隐藏已完成任务。
7. **Run 成功但没有可用 final 文本**：不应提交空白 Result，明确报错或进入需要处理的失败/异常状态；**不自动再启动一轮模型催交**。
8. **任务创建与新 Agent 创建事务**：任一创建步骤失败时要有明确补偿/回滚策略，不能留下已绑定但不存在的 Agent。

## 16. 交给 Codex 的执行说明

> 请以这份文档作为目标架构，而非要求你逐字实现所有建议命名。先完整审查现有 Harness 的相关代码，输出一份简短的“现状 → 目标 → 将删除的旧机制”映射，然后从核心领域模型与状态机开始做**结构性重构**。允许修改内部 API，优先删除重复抽象和旧回调路径，不要通过继续包函数、增加大量 optional 字段来假装兼容。Agent Session 必须复用已有上下文组装及压缩机制。先落实通信、任务、运行/结果三个权威边界，再实现调度和工具 UX。每完成一个阶段运行相应测试，遇到文档未规定且会影响持久数据或生命周期的歧义时，明确列出选项及推荐方案，不要私自扩充系统范围。
