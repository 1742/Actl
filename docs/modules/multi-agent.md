# 多 Agent 协作

Root 会话及其子 Agent 共享工作目录。每个 Agent 都有持久的身份、角色快照和自己的 Session。同一个 Agent 可以用原 Session 处理多个任务。每次从等待中唤醒时，Runtime 在该 Session 上创建新的 Run，并沿用已有上下文装配和压缩。每个 Agent 一次只执行一个 Run。

## 状态和持久化

- 根会话的 Plan 保存一份当前计划，根 Agent 可以按 revision 覆盖。更新 Plan 不会驱动调度或取消任务。
- Task 保存目标、类型、依赖和验收者。Task Store 管理状态和原子认领。依赖在发布时引用同 Root 的已有任务，只有全部依赖被验收后才能分派。依赖的取消或失败会让依赖方继续等待。
- Attempt 保存一次执行尝试、执行者和审查结论。认领或分派创建 Attempt，一个 Attempt 可以关联多个 Run。单个 Agent 最多拥有一个活跃 Attempt。
- 正常结束的任务 Run 有非空 final 时，Runtime 创建唯一的 Result 并将 Task 转到 `review_required`。Result 引用 Run 中保存的 final。接受将 Task 转为 `completed`。退回要求理由，会保留原 Attempt 和 Result，并让 Task 重新排队。失败或超时退出的 Run 进入失败处理，可由验收者重试。
- Mailbox 保存信件、线程、回复关系以及已读和投递状态。同 Root 中的父子和兄弟 Agent 都可通信。派单通过任务事件驱动。进度、问题和回复只更新邮箱。
- SQLite 在同一事务内写入状态变更和待分发事件。分发可以重试，过期或已撤销 Attempt 的 Run 不能提交成果。停止会取消相关等待和正在执行的任务。重启会接续持久化等待、队列和未分发事件，仍在执行且无已登记等待的 Run 会被标为失败。

任务经历 `pending → assigned → running → review_required → completed`。主动认领会在调用的 Run 开始执行。取消和失败是独立状态。没有匹配 Agent 时任务保留在 Pending，自动分配按任务发布顺序和 Agent 空闲时间选择，角色必须匹配任务类型。指定已有 Agent 时要求其空闲。需要明确指定或新建 Agent 时，发布任务可设置 `autoAssign: false`，然后调用 `delegate_task`。匹配了任务的 Agent 如果仍在等待当前 Attempt，不会接新任务。

## 等待和唤醒

`wait` 支持等待邮件、Task 状态、Agent 状态和指定 Run 结束。初次调用先检查状态和事件游标，暂无匹配时保存条件及截止时间。暂停的 Run 状态为 `waiting`，释放执行名额。同一 Session 被唤醒后仍能继续原 Attempt。

- 匹配事件和超时会唤醒 Agent。超时以 `timed_out` 交给模型，由模型决定如何继续。
- 不匹配的 `question` 或 `urgent` 可以提前唤醒，`progress` 和 `information` 默认排队。唤醒时合并可投递消息，保留原等待条件和截止时间。若原事件已就绪，一并交给同一 Run。
- 处理中途来信后用 `wait` 的 `resume` 继续原等待。此时若已有结果，可在当前 Run 得到。否则再次释放执行名额。若 Agent 直接输出 final，Runtime 保存这轮历史并继续原等待，不提交任务成果。
- `cancel` 可显式取消等待。即使等待超时，之后到达的回复仍进入邮箱，并根据自身邮件用途参与普通投递。

## 工具

| 工具 | 操作 |
| --- | --- |
| `plan` | 读取或替换根 Plan |
| `tasks` | 发布、列表、查看含 Attempt 历史和 Result 的任务、认领、接受、退回、取消、重试 |
| `delegate_task` | 指定已有 Agent、新建匹配角色的 Agent，或请求自动匹配 |
| `agents` | 查找同 Root 上的 Agent，显示角色、状态、当前任务和最近 Run |
| `mail` | 发送、回复、搜索、阅读，支持按时间、关键词、主题、已读状态和线程筛选 |
| `wait` | 开始、继续或取消等待。每次单独调用 |
| `list_agent_profiles` | 查询可分配的角色 |
| `interrupt_agent` | 父 Agent 停止直属子 Agent |

模型使用 `#1`、`m#2`、`@parent` 等引用。角色别名有多个匹配时，需从 `agents` 结果中选择具体 Agent。

## 角色、权限和界面

内置角色为 `general`、`explore` 和 `review`。用户可在 Actl 数据目录下创建 `agents/<id>.md` 覆盖或增加角色。文件名是角色 ID，YAML frontmatter 中 `name` 和 `description` 必填，正文提供角色指令。可选的 `modelTargetId` 和 `reasoningEffort` 决定该角色首选的模型配置。角色快照在 Agent 创建时保存。

子 Agent 继续使用只读工具和 `plan` 权限模式。文件修改与最终整合由根 Agent 执行。当前限制为每个 Root 最多 12 个子 Session、最多 3 个同时执行的子 Agent。只读并行会话使用根工作目录，可以看到根 Agent 对文件的实时修改。

右侧栏显示根 Plan、任务状态、当前 Attempt 成果和子 Agent Run。暂停等待和审批等待单独显示。界面通过根会话订阅接收自动唤醒的 Run 和任务更新。停止操作处理对应子树，关闭订阅只解除显示。

主要实现见[协调器](../../src/agent-core/runtime/multi-agents/agent-coordinator.ts)、[等待条件](../../src/agent-core/runtime/multi-agents/coordination-waits.ts)、[SQLite 协作持久层](../../src/agent-core/repositories/sqlite/agent-coordination-repository.ts)和[工具入口](../../src/agent-core/tools/builtin/agent-team.ts)。
