# Electron 桌面模块

## 1. 职责与窗口

[main/index.ts](../../src/main/index.ts) 管理应用和窗口，[DesktopAgent](../../src/main/desktop-agent.ts) 管理业务 IPC、设置、目录及系统通知，[AgentProcessHost](../../src/main/agent-process-host.ts) 管理 utility process。[preload/index.ts](../../src/preload/index.ts) 将受限 API 暴露给 Vue。

默认窗口 1280×800，最小 860×650，就绪后显示。应用使用单实例锁，再次启动会恢复并聚焦现有窗口。关闭全部窗口会退出应用，没有常驻托盘模式。

渲染配置为 `contextIsolation=true`、`sandbox=true`、`nodeIntegration=false`。页面不能直接调用 Node 或通用 IPC；新窗口、外部导航和页面权限请求默认被阻止。

## 2. 桌面接口

`window.actlAgent` 的完整类型见 [agent-ipc.ts](../../src/shared/agent-ipc.ts)。

| 方法 | 行为 |
| --- | --- |
| `ready()` | 确保 Agent 初始化，返回模式、owner 与模型配置能力 |
| `request(command)` | 执行业务操作，返回 AgentResult |
| `stream(id, command)` / `onEvents(listener)` | 订阅关联事件并等待完整业务结果 |
| `detach(id)` | 解除事件订阅，不等同于业务取消 |
| `restart()` | 等待旧 Agent 关闭；下一次 ready/请求按最新设置启动 |
| `getSettings()` / `saveSettings(settings)` | 读取/保存 storageDirectory；保存不自动重启 |
| `pickDirectory()` | 选择或创建目录，取消返回 null |
| `openDirectory(kind)` | 打开 storage/logs/skills/config；必要时创建目录 |
| `notify(kind, title, detail)` | 完成或审批通知 |

主进程限定业务命令白名单；只有 `responses.create` 和 `responses.permissions` 可走 stream。IPC 来源必须是应用主窗口的主 frame，页面 URL 必须符合当前开发或生产入口。

## 3. 设置与资源

用户配置目录固定为 `%APPDATA%/Actl-Electron`，设置文件为 `desktop-settings.json`，默认数据目录为其 `data` 子目录。`storageDirectory` 必须非空且为绝对路径。切换目录不迁移数据，也不改变桌面设置文件位置。

`openDirectory('config')` 打开桌面用户配置目录；storage 打开当前 home，logs 和 skills 打开该 home 下对应子目录。

开发页面 URL 由 electron-vite 提供；生产由受限 `actl://app` 协议读取 renderer 产物。协议只接受 app 主机的 GET/HEAD，拒绝越界路径和任意本机文件读取。前端使用 hash 路由。

## 4. AgentProcessHost

Host 复用初始化 promise，通过 `utilityProcess.fork()` 启动 `agent-worker.cjs`。Worker 的 ready 只表示可以接收初始化；主进程必须先将其加入 Windows Job，再发送 home/mode。

初始化最长等待 30 秒，启动错误附有限 stderr。每个 Host 同时最多保留 64 个待回复请求；请求 ID 不得重复。事件和最终结果按 ID 关联，不依赖会话在前端是否被选中。

Agent 意外退出使在途请求失败，错误码为 `runtime_interrupted`，不会自动重复模型请求。后续请求就绪时可启动新 Agent；新的启动先等待旧 Job 清理完成。

## 5. 关闭与 Job Object

[windows-process-job.ts](../../src/main/windows-process-job.ts) 通过 Koffi 调用 kernel32。每个 Agent 使用匿名 Job，启用 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，不允许 breakaway；唯一句柄留在主进程且不可继承。

正常关闭发送 shutdown，要求 Worker 的 stopped 确认和退出码 0。12 秒后仍未退出则终止直接进程，15 秒为最终等待期限；随后终止 Job 中剩余进程并查询活动数，最长确认 5 秒。关闭完成前不会把“已请求终止”当成“全部退出”。

普通 Shell/MCP 后代自动继承 Job，父启动器先退出不会丢失管理关系。主进程被强制结束时由 Windows 关闭句柄并回收进程。通过系统服务或 WMI 在 Job 外创建的进程不受此 Job 管理。

正常业务收尾只取消正在运行的 Run，待审批记录保留。完整业务清理顺序和历史恢复见[架构](../architecture.md)与[Agent 模块](agent-runtime.md)。

## 6. 通知

仅支持 completed 和 permission_requested。主窗口聚焦时抑制通知；标题输入最多 80 字符，详情最多 160 字符。点击通知恢复并聚焦窗口，不自动切换到来源会话。

通知是业务事件的提醒，审批真实状态保存在 Agent。前端必须同步显示 pending batch，不应以系统通知替代审批面板。

## 7. 构建与诊断

[electron.vite.config.ts](../../electron.vite.config.ts) 构建 main、runtime-worker、agent-worker、preload 和 renderer；[electron-builder.yml](../../electron-builder.yml) 配置 ASAR、额外 fixture、NSIS 和数据保留行为。开发和发布都使用同一工程，命令见[开发文档](../development.md)。

`window.actl.runChecks()` 是基础兼容性检查接口，不是任意业务调用入口。命令行验证使用独立 profile，绕过正常应用的单实例竞争并隔离数据；正常用户启动仍使用单实例约束。
