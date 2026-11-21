# 工具、权限与命令进程

## 1. 工具注册

[ToolRegistry](../../src/agent-core/tools/registry.ts) 汇总 ToolProvider。内置工具用 Zod 描述输入，转 draft-07 JSON Schema 给模型；外部工具可直接提供 JSON Schema。

provider name 必须唯一，全局工具 name 必须唯一。prepareToolCall 验证并规范化输入；getPermissionRequirement 取得 capability/resource/action；getExecutionPolicy 决定并行或独占；callTool 将输出包装为 ok/result，普通异常包装为错误，取消信号继续抛出。

ToolCallContext 带 cwd、sessionId、授权信息、AbortSignal 和模型能力。授权由宿主生成，不由模型输入。大部分内置工具在执行前再次确认授权资源与实际解析路径相符。

toolCalling=false 不暴露工具；requiresImageInput 工具只暴露给有图片能力的模型。实际执行再做能力检查，防止调用历史中旧工具绕过当前模型限制。

## 2. 内置工具目录

| 工具                   | 核心参数                                        | 权限                          | 执行策略  |
| ---------------------- | ----------------------------------------------- | ----------------------------- | --------- |
| read_file              | path、startLine、maxLines、maxBytes             | filesystem.read               | parallel  |
| write_file             | path、content、expectedSha256?                  | filesystem.write              | exclusive |
| apply_patch            | patches：path、expectedSha256、replacements     | filesystem.patch              | exclusive |
| search_files           | pattern(glob)、path?、maxResults、includeHidden | filesystem.search             | parallel  |
| search_content         | pattern(regex)、path?、fileTypes?、contextLines | filesystem.search             | parallel  |
| list_directory         | path、depth、maxEntries、includeHidden          | filesystem.read/list          | parallel  |
| move_path              | source、destination                             | filesystem.move               | exclusive |
| delete_path            | path、recursive                                 | filesystem.delete             | exclusive |
| shell                  | command、cwd?、yieldTimeMs?                     | process.spawn                 | exclusive |
| shell_poll             | processId、cursor 或 line、waitMs、waitForExit  | process.read                  | parallel  |
| shell_stop             | processId、cursor 或 line                       | process.terminate             | exclusive |
| read_uploaded_file     | file_id、offset?、limit?                        | stored_file.read              | parallel  |
| read_image             | path                                            | filesystem.read，要求视觉能力 | parallel  |
| search_skills          | query?、limit?                                  | skill.read/list               | parallel  |
| get_skill_instructions | skillId                                         | filesystem.read               | parallel  |
| list_skill_files       | skillId、path?、depth?、maxEntries?             | filesystem.read/list          | parallel  |
| web_search             | query、maxResults?、freshness?、domains?        | network.search/read           | parallel  |
| search_mcp_tools       | query?、server?、limit?、offset?                | mcp.read/list                 | parallel  |
| call_mcp_tool          | toolName、arguments                             | mcp.<server>/execute          | exclusive |

未声明 execution 的工具默认 exclusive。并行只适用于连续的 parallel 组，最多 4 个；遇 exclusive 先等待该组，再串行执行。结果按输入顺序落时间线，不按完成先后排列。

文件系统实现位于 [builtin/filesystem/provider.ts](../../src/agent-core/tools/builtin/filesystem/provider.ts)，其余工具位于 [builtin](../../src/agent-core/tools/builtin/shell.ts)。MCP 只有两个入口直接给模型，不把全部动态工具挂进请求。

## 3. 文件路径语义

普通工具的相对路径基于 session.cwd。独立会话使用专属目录，项目会话使用项目目录。工作区提供相对路径的起点，实际访问范围由宿主进程权限和工具权限规则决定。

[path-security.ts](../../src/agent-core/tools/path-security.ts) 使用 realpath 规范化已有路径；不存在路径从最近已有父目录拼回缺失段。write/read/patch 在执行时重解析并对照授权，防止授权资源与执行资源不一致。

move/delete 保留最后一级目录项语义，并禁止文件系统根目录；move 不覆盖已有目标，delete 非递归目录仅可删除空目录。full_access 也不绕过这些工具约束。

工作区引用与项目文件树不同：引用必须是项目内已有普通文件的相对路径，不得穿过符号链接；文件树/搜索有范围与忽略规则。不能将这些 UI 查询限制等同于所有普通工具只能操作项目内文件。

## 4. 文本读写与补丁

read_file 读取 UTF-8，默认从第 1 行返回最多 2000 行/256 KiB，最大参数为 10000 行/1 MiB，附原始文件字节的 SHA-256、总行数、大小和 truncated。返回的文本保留所选行之间原有的换行符。此限制是返回内容限制，内部仍读取整个文件。

write_file 省略 `expectedSha256` 时只创建新文件，可以创建缺失的父目录。替换已有文件时，用 `read_file` 返回的 `sha256` 作为 `expectedSha256`。目标不存在或版本已变更时，读取当前内容后再尝试编辑。

apply_patch 采用**JSON 精确字符串替换**，不接受 unified diff 或 Begin Patch 文本。示例：

```json
{
  "patches": [
    {
      "path": "src/example.ts",
      "expectedSha256": "8de5c07db8deb3b75dedd9b5bc999669936cea181ae0033c27c4e2071a6e434d",
      "replacements": [
        {
          "oldText": "const value = 1;",
          "newText": "const value = 2;",
          "expectedOccurrences": 1
        }
      ]
    }
  ]
}
```

每批最多 50 个文件。先校验全部文件的哈希和文本匹配数量，全部通过才开始逐个替换文件。写入失败时尝试逆序恢复本批已写的内容，并报告任何恢复失败。

项目内所有 Run 的内置写入、补丁、移动和删除共用一把写锁，独立会话以根会话为范围。锁覆盖执行时的路径解析、版本校验和落盘，审批和模型推理期间不会占用锁。外部编辑器和命令进程可独立修改文件。

搜索使用 TypeScript 文件遍历和自定义 glob/regex，不依赖 rg 命令。默认跳过隐藏文件、符号链接、.git/node_modules/dist/build，并应用根 .gitignore 的实现规则。search_content 跳过超过 5 MiB 或前段含 NUL 的文件；不要将这套简化忽略匹配称为完整 Git ignore 语义。

## 5. 权限引擎

[run-policy.ts](../../src/agent-core/permissions/run-policy.ts) 依次判断：

1. action=read/list、capability 以 .read 结尾或 filesystem.search，自动允许。
2. full_access 允许其他操作。
3. plan 拒绝其他操作。
4. accept_edits 允许 filesystem.write/patch/move，以及 Windows 工作区沙箱中的 shell 启动。
5. 其余 ask。

因此 shell_poll 自动允许，shell_stop 仍为副作用操作；plan 即使遇只读 shell 命令也拒绝 shell 启动。联网搜索被声明为 read，所以 plan 可以查询。MCP 实际调用为 execute，外部只读标注不降低审批要求。

capability 分类是工具实现的可信声明，不能让模型通过输入自定义 action=read 获取授权。权限模式冻结在 Run，而不是从每次工具调用推断。

## 6. Windows 工作区写入沙箱

在 accept_edits 下，shell 以会话工作区作为写入授权根目录。调用方的 cwd 只指定命令的工作目录。独立 runner 使用受限令牌、低完整性级别与 NTFS ACL 启动 pwsh 及其普通子进程，并给每次执行分配私有 TEMP/TMP。初始化失败时返回错误。shell_poll 和 shell_stop 继续使用原进程 ID。

工作区可写包含删除。读取与网络仍使用宿主可用资源；硬链接指向同一文件对象。工作区 ACL 和可继承的低完整性标签会保留，这也影响同用户的其他低完整性进程。子进程捕获孙进程输出时可能遇到 Windows 命名管道权限限制。

工具可以通过 hostAccessReason 请求单次宿主权限。审批绑定命令、工作目录与理由，通过后启动新进程。重试前应检查上次执行产生的部分修改。ask 仍逐次审批宿主命令，plan 拒绝 shell 启动，full_access 直接使用宿主权限。

## 7. 权限批次执行

[ToolBatchExecutor](../../src/agent-core/runtime/agent-loop/tool-batch-executor.ts) 先处理全部输入校验、工具可用性、PreToolUse 和权限判定。只要有 ask 项，保存 pending batch 和 permission_request 时间线，设 waiting_permission，并暂停整个批次。

恢复时 AgentLoop 验证状态、当前 batchId、全部 permission ID。批准项获得 approvedByUser=true，拒绝项形成错误；原自动允许项同时继续。保存 decisions 后发 permissions_resolved，再执行并记录工具结果。

每个工具结果 JSON 带 `execution.permissionMode`，并可带 automatic/user_approved/user_denied/policy_denied。取消和失败时补齐未执行调用，避免模型历史出现 tool_call 无 tool_result。

## 8. Windows shell 和 ProcessSupervisor

[shell.ts](../../src/agent-core/tools/builtin/shell.ts) 使用 PowerShell 7。按 PATH 中的绝对目录和标准安装目录查找 pwsh.exe，传入 -NoProfile -NonInteractive -Command 执行。找不到时报告安装提示。环境复制 process.env，使用宿主现有 PATH；不会自动安装 Node/Python。

shell 返回退出结果或 processId，不必阻塞直到命令结束。yieldTimeMs 默认 10000，最大 120000；超时返回控制不代表命令被结束。shell_poll 支持 cursor 增量或 1-based line 两种互斥读取；waitForExit 可等待最终状态。仅 status=exited 时 exitCode 才表示自然命令结果，stopped 表示请求了终止。

[process-supervisor.ts](../../src/agent-core/runtime/process/process-supervisor.ts) 默认：

| 设置           | 值      |
| -------------- | ------- |
| 每会话活动命令 | 3       |
| 全局活动命令   | 10      |
| 单进程运行上限 | 2 小时  |
| 输出保留缓冲   | 1 MiB   |
| 结束记录保留   | 10 分钟 |
| 强制终止延迟   | 1 秒    |
| 终止确认宽限   | 3 秒    |

输出由 [process-output-buffer.ts](../../src/agent-core/runtime/process/process-output-buffer.ts) 限界保存，返回截断信息，cursor/line 不提供无限日志历史。PowerShell 输出按 UTF-8 解码。

进程由 session owner 管理，其他会话不能 poll/stop。Windows 用 taskkill `/T` 处置树，必要时 `/F`；无法确认时记日志。删除会话/项目或 Agent.dispose 会回收；进程表在内存，不跨重启恢复。停止 Run 的信号会中止正在等待的启动/轮询，但已返回到会话的长期进程应通过明确回收入口处置。

## 9. 桌面进程归属与等待边界

主进程在 Agent 初始化前将其加入独立 Windows Job Object，普通 Shell/MCP 后代继承该归属。Agent 退出后统一回收剩余进程，主应用被强制结束时由 Windows 关闭 Job 句柄触发回收；父启动器提前退出不影响 Job 的归属。Job 不覆盖通过系统服务或 WMI 在其外部创建的进程，见[桌面模块](desktop.md)。

单条 shell_stop 仍使用 ProcessSupervisor 的命令记录和 taskkill；不能把 Agent 级 Job 统一清理理解为每次 shell_stop 都有独立 Job。

yieldTimeMs 只限制命令启动后的观察等待，不是硬执行超时，也不包括审批。排查长期等待时应区分审批、准备、启动观察、后台运行及 shell_poll。
