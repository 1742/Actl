# 多 Agent 协作

Actl 的协作范围是同一个根会话（Root）。Root 及其子 Agent 共享工作目录，每个 Agent 有独立的身份、角色快照和 Session，可以复用同一个 Session 处理多个任务。Runtime 沿用已有的上下文装配和压缩。空闲 Agent 收到需要处理的事件时可以启动新 Run，执行中的 `wait` 在当前 Run 内恢复。

## 架构与数据边界

`AgentCoordinator` 在 Electron Agent Runtime 内编排任务分配、Run 启动和事件分发。Task 状态机和原子认领由 SQLite 持久层实现。`AgentMailbox` 负责邮件查询和回复，`AgentDirectory` 负责成员查找和短引用，`CoordinationWaits` 负责匹配等待条件。工具把参数解析为明确的命令，由各自的模块校验权限并执行。

| 概念 | 权威来源和职责 |
| --- | --- |
| Root Plan | 每个 Root 保存一份当前计划。根 Agent 按当前 revision 替换，用于展示和提醒。Task 调度读取任务及其依赖 |
| Agent / Session | Session 持久层保存身份、Root 关系、角色快照和会话历史。Directory 从 Session、Run 和 Task 投影成员状态 |
| Run | 执行持久层保存一次 Session 执行的状态、时间线和 final。每个 Agent 最多有一个活跃 Run |
| Task / Attempt | Task Store 保存工作目标、类型、依赖、状态和验收者。每次分配或认领创建一个 Attempt，记录执行者、关联 Run、交付与审查历史 |
| Result | 每个 Attempt 至多有一份 Result，引用已完成 Run 的 final。验收决定保存在 Task 和 Attempt 历史 |
| Mailbox | 保存同 Root 邮件、线程、回复关系以及已读和投递标记。邮件可以用于报告进度，任务变更走 Task 工具 |
| Wait / 事件 | Wait 记录绑定到当前 Run。协调事件记录邮件到达、任务或 Agent 状态变化、Run 结束和待验收通知等事实 |

## 任务分配与验收

任务的正常路径是 `pending → assigned → running → review_required → completed`。子 Agent 主动认领时，在调用工具的 Run 中直接进入 `running`。

- 根 Agent 发布任务并担任验收者。依赖只能引用同 Root 的已有任务，发布时确定，由此形成有向无环图。任务在所有依赖验收后可分配。依赖失败或取消时，任务保持 `pending`。
- 根 Agent 可委派给指定的空闲子 Agent、创建匹配角色的子 Agent，或请求自动匹配。需要指定目标时，发布任务可设置 `autoAssign: false`，再调用 `delegate_task`。新建目标可传 `{ kind: 'create', role: 'review', name: '代码审查' }`，父 Agent 从 `attempt.agent` 得到 `@代码审查`。自动分配按任务发布顺序和 Agent 空闲时间匹配，角色 ID 必须与任务类型一致。当前没有匹配者时，任务会留在 `pending` 等待后续调度。
- 分配与主动认领使用同一套原子占有规则。一个 Task 最多有一个有效执行者，一个 Agent 最多有一个活跃 Attempt。竞争失败的调用直接收到工具错误。等待中的 Agent 继续占有当前 Attempt。
- 关联 Run 正常结束并产出非空 final 时，Runtime 写入 Result，把任务推进到 `review_required`，并向验收者发送含成果引用的系统通知。验收者通过 `tasks show` 查看成果，显式接受后任务进入 `completed`，Runtime 据此重新计算依赖方的可分配性。
- 退回时记录理由，保留原 Attempt 和 Result，任务回到 `pending`。再次分配或认领创建新 Attempt，可以复用原 Session。Run 失败、未完整结束或缺少非空 final 时，Attempt 进入失败处理，验收者可重试。显式取消会终止相关的活跃 Attempt。

## 邮箱与代理目录

同 Root 的父子和兄弟 Agent 可以定向通信。邮件包含发件人、收件人、主题、正文、用途和时间，可选关联原邮件。搜索支持发件人、关键词、主题、时间范围、用途、已读状态和线程。未指定原邮件的回复仅在待回复的问题唯一时自动关联。

`agents` 返回同 Root 成员的名称、`@名字` 引用、角色、状态、当前任务和最近一次 Run。子代理的名字就是会话标题。创建和改名都要求在同一个 Root 内唯一，比较时忽略首尾空白、大小写与全半角差异。创建时省略 `name` 会从角色名称生成可用名字，必要时加序号。名字支持中文和空格。系统引用 `@root`、`@parent` 和 `@self` 保留。

发信的 `to`、查信的 `from`、等待的 `from` 或 `agent` 都可用 `@名字`。例如查找 `@代码审查` 发来的邮件可传 `{ action: 'search', from: '@代码审查' }`。任务和邮件仍用 `#1`、`m#2` 等引用。已保存的邮件和等待关联 Session ID，改名后继续指向同一个 Agent。

运行中的 Agent 在下一次模型调用前接收可投递邮件。空闲 Agent 可以由问题或紧急邮件启动，同一次启动会合并待投递内容。进度和普通信息在等待期间排队，匹配邮件等待条件时可以立即交付。

## 等待和唤醒

`wait` 每次单独调用，可等待邮件（含指定回复）、任务状态、Agent 状态或指定 Run 结束。首次调用持久化条件、事件游标和截止时间。工具在 Root 串行锁外等待，保持原 Run 和 Attempt，并继续占用子 Agent 并发名额。

1. 条件满足时返回 `matched`。到达截止时间时返回 `timed_out`。结果作为当前 Run 的工具结果交给模型。
2. 不匹配原条件的 `question` 或 `urgent` 可以提前返回 `interrupted`。工具结果附带完整来信，原条件和截止时间继续有效。
3. 处理来信后，Agent 可调用 `wait resume` 继续原等待。如果模型直接输出 final，Runtime 会保留该回复，并在调用 Stop hook 和提交任务成果前补一条 `wait resume` 工具调用。若匹配事件此时已到，工具立即返回。
4. `wait cancel` 可以显式结束等待。工具结果、等待状态更新和该结果所含邮件的投递确认在同一事务提交。超时后到达的邮件仍可按自己的用途投递。

## 持久化与故障恢复

- SQLite 在同一事务内写入领域状态和待分发事件（事务性 Outbox）。事件有唯一序号，分发可重试。等待用事件游标和条件复查处理登记期间的状态变化。
- Task Store 校验 Attempt 的执行归属并维护租约。`agent_results` 对 Attempt 有唯一约束，重复结束事件或旧 Attempt 的晚到结果不会覆盖当前成果。
- 停止会话会取消对应子树中相关的等待和执行。异常退出遗留的活跃 Run 在恢复时标为失败并清除等待，队列中的邮件和未分发事件继续处理。失败任务可由验收者发起重试。

表结构和 schema 版本见[存储模块](storage.md)。

## 工具

| 工具 | 操作 |
| --- | --- |
| `plan` | 读取或替换根 Plan |
| `tasks` | 发布、列表、查看含 Attempt 历史和 Result 的任务、认领、接受、退回、取消、重试 |
| `delegate_task` | 指定已有 Agent、新建匹配角色的 Agent，或请求自动匹配 |
| `agents` | 查询同 Root 的代理目录 |
| `mail` | 发送、回复、搜索、阅读 |
| `wait` | 开始、继续或取消等待 |
| `list_agent_profiles` | 查询可分配的角色 |
| `interrupt_agent` | 父 Agent 停止直属子 Agent |

## 角色、权限和界面

内置角色为 `general`、`explore`、`review` 和 `edit`。根 Agent 可发布 `type: 'edit'` 的任务，并用 `delegate_task` 创建同角色的子 Agent。用户也可在 Actl 数据目录下创建 `agents/<id>.md` 覆盖或增加角色。文件名是角色 ID，YAML frontmatter 中 `name` 和 `description` 必填，正文提供角色指令。`access` 可设为 `read_only` 或 `edit`，默认为 `read_only`。`modelTargetId` 和 `reasoningEffort` 可指定角色首选的模型。角色快照在 Agent 创建时保存。

只读角色使用 `plan` 模式。编辑角色在 `ask` 下请求用户审批，在 `accept_edits` 或 `full_access` 下自动执行获准的文件编辑，根会话或任务来源是 `plan` 时执行只读 Run。编辑工具为 `write_file` 和 `apply_patch`，目标必须位于已绑定的工作区内。每个 Root 最多有 12 个子 Session，最多同时执行 3 个子 Agent，等待计入该上限。共享目录中的编辑即时生效，任务退回后仍可在每轮 Run 的文件改动中查看。

前端按根会话维护 Agent 树，树内保存成员对话、运行状态、计划和任务。父会话输入区显示树内的待审批请求，每张卡携带发起者的会话、Run 和批次标识，并可打开对应的子会话。右侧栏显示 Plan、任务状态、当前 Attempt 成果和子 Agent Run，分别标注工具等待和审批等待。时间线展开 `Roles`、`Plan`、`Tasks`、`Delegate`、`Agents`、`Mail` 和 `Wait` 时，通过卡片显示适合阅读的字段。

## 实现与验证

- [协调器](../../src/agent-core/runtime/multi-agents/agent-coordinator.ts)、[等待条件](../../src/agent-core/runtime/multi-agents/coordination-waits.ts)和 [Run 收尾](../../src/agent-core/runtime/agent-loop/agent-loop.ts)
- [SQLite 协作持久层](../../src/agent-core/repositories/sqlite/agent-coordination-repository.ts)、[协作表与事件](../../src/agent-core/repositories/sqlite/coordination-schema.ts)和[工具入口](../../src/agent-core/tools/builtin/agent-team.ts)
- [工具卡片](../../src/renderer/src/agent/components/conversation/AgentTeamToolCard.vue)和[字段展示](../../src/renderer/src/agent/utils/agentTeamCards.ts)

多 Agent 单元测试覆盖原子认领、依赖解锁、重复成果与旧 Attempt、跨 Root 隔离、意外来信后的同 Run 续等、超时及并发名额。Electron 集成测试验证同一 Run 中的自动续等调用及工具结果能通过流式事件和持久历史读取。相关命令为 `pnpm test:multi-agent`、`pnpm test:agent-ui` 和 `pnpm verify:agent`。
