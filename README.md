# Actl

Windows Electron 桌面 harness。此目录独立安装依赖、开发和打包；旧 Tauri 实现在相邻的
`Actl-tauri` 仓库，不参与本项目构建。

当前为迁移版 **0.2.2**：旧 Vue 聊天界面和 Agent 核心已迁入 Electron。
项目、会话、模型配置、流式输出、工具审批、取消、附件、Skills/MCP 和设置通过内部 IPC 调用，
业务运行在长期存活的 utility process 中。新工程不再依赖 Tauri、Rust、Express 或独立 Agent exe。

运行基线固定为 **Electron 43.8.7 / Node 24.22.1**。本机 Windows 11 26H2
（26300.9711）中，Electron 45.2.3 连不含应用代码的最小沙箱窗口也会崩溃，
43.8.7 的相同程序与实际界面可以正常运行。没有关闭渲染沙箱或硬件加速作为默认绕过。
升级 Electron 时需重新执行最小渲染诊断、界面及打包验证，并跟踪受支持版本的更新。

## 开发

要求 Windows x64、Node.js 24.19+（建议 24 LTS 或现有 Node 26）和 pnpm 12.16.1。
应用实际运行于 Electron 内置的 Node 24；开发机 Node 版本不替代应用运行时。

```powershell
pnpm install
pnpm dev
```

安装脚本会下载官方 Electron 运行时。首次打包也会下载 Windows 打包工具。
主进程及 preload 修改后由 electron-vite 重载，Vue 界面支持 HMR。

## 检查与打包

```powershell
pnpm typecheck
pnpm test:agent-ui
pnpm verify:agent
pnpm verify:runtime
pnpm pack:win
pnpm verify:agent:packaged
pnpm verify:packaged
pnpm diagnose:renderer
```

- `verify:agent`：构建后使用真实 utility process 和本机模拟模型服务验证对话闭环，不需要 API Key。
- `test:agent-ui`：验证审批续跑快照、实时审批与历史回读竞争、完成状态恢复及连续审批请求的归属。
- `verify:agent:packaged`：用已打包应用重跑完整 Agent 集成检查。
- `verify:runtime`：保留第一阶段 SQLite、日志、Shell、MCP 等基础检查，不创建窗口。
- `pack:dir`：仅生成 `dist/win-unpacked/Actl.exe` 及其资源。
- `pack:win`：生成 Windows x64 NSIS 安装包，同时保留 `win-unpacked`。
- `verify:packaged`：使用 `win-unpacked/Actl.exe`、ASAR 内的运行时代码及分发资源重跑检查。
- `start`：启动生产构建的聊天界面预览。模型和供应商在应用设置中配置。
- `start:packaged`：打开 `win-unpacked` 中的实际打包应用，无需先安装。
- `diagnose:renderer`：运行没有 Vue、preload、IPC 或业务数据的最小沙箱窗口，用于区分系统/运行时与应用代码问题。

输出目录：

```text
out/                         编译结果
dist/                        安装包和打包后的应用
artifacts/compatibility/     命令行验证报告、隔离数据库、日志和合成主密钥
artifacts/agent/             对话闭环验证报告和独立测试数据
```

每次命令行验证创建独立目录，基础检查写入 `latest.json`，Agent 集成检查写入 `agent-report.json`。CLI 以非零退出码报告失败，
并验证源码/打包运行模式。测试数据位于带中文与空格的路径，保留供排查；可在应用关闭后手动清理。
图形界面的验证数据位于 `%APPDATA%/Actl-Electron/compatibility`，不会打开旧数据库。
基础诊断页面保留在 `#/compatibility`；正常启动默认进入聊天界面。

正常应用配置位于 `%APPDATA%/Actl-Electron/desktop-settings.json`，默认数据目录为同目录下的 `data`。
开发和发布分别使用 `database/development`、`database/release` 与对应的主密钥。
设置中支持选择其他绝对存储目录，保存后需重启 Agent；不会自动搬迁旧数据。

安装包尚未配置发布签名、自动更新和正式产品图标。当前只是迁移验证包。

## 代码结构

```text
src/main/          窗口、桌面能力、IPC 校验、Agent 进程管理及集成检查
src/preload/       暴露受限的业务/桌面 API，不暴露通用 ipcRenderer 或 Node
src/renderer/      迁入的 Vue 聊天、项目、模型、Skills、MCP 与设置界面
src/agent-core/    迁入的 AgentLoop、模型驱动、工具、权限、仓库与存储
src/shared/        进程间数据契约
src/runtime/       utility process 入口、检查程序、旧代码验证基线
scripts/           从源码或打包应用运行验证
```

主进程管理桌面能力和进程；SQLite、模型调用、工具、权限、日志、文件及 MCP 都在独立 utility process 内执行。
不启动业务 HTTP 服务。开发时 electron-vite 的页面/HMR 服务不随安装包运行。
Agent 初始化前加入主进程持有的 Windows Job Object，Shell/MCP 子进程随之纳入管理。
重启或退出时先等待业务收尾，再清理剩余后代；主进程被强制结束时由 Windows 自动回收。

渲染进程开启 `contextIsolation` 和 `sandbox`，关闭 `nodeIntegration`。
IPC 限定主窗口主 frame 和页面 URL，业务操作使用白名单及运行时 schema 校验。
文件工具和命令仍走 Agent 的权限判断；项目目录不是操作系统沙箱。
页面阻止新窗口及外部导航，消息 Markdown 禁止原始 HTML。
生产页面通过受限 `actl://app/index.html` 协议加载，只能读取编译后的 renderer 目录，
保留 CSP，不提供任意本机文件读取能力。

## 验证边界

检查覆盖进程隔离、SQLite 旧 schema v18 建库和重开、WAL/外键/回滚、文件哈希、旧凭据加密、
旧日志脱敏、旧 ProcessSupervisor、MCP 初始化/工具发现/调用/关闭，以及运行时关闭确认。

MCP Server 和后台命令测试复用应用自身 Electron 可执行文件，以 `ELECTRON_RUN_AS_NODE=1`
运行随包分发的测试 fixture，因此验证不依赖 PATH 中的 Node。该模式目前仅用于兼容性验证；
后续设计正式 Node MCP 启动策略和 Electron fuses 时必须一起评估。

Agent 集成检查覆盖项目/会话创建、附件传输与归属校验、真实模型循环和流事件顺序、
工具批准/拒绝、过期审批拒绝、待审批跨重启续跑、项目并发冲突、显式取消、
运行时被终止后的请求失败及持久化恢复，以及正常退出。
额外覆盖启动器已退出的后台进程在 Agent 重启、Agent 异常退出、主进程被强制结束时的实际回收。
模型响应来自仅本机可达的模拟服务；真实模型对话、工具使用和历史待审批恢复另已由用户验证。

旧用户数据导入、完整历史迁移链、真实外部模型/搜索供应商联网、所有第三方 MCP Server、
日志滚动仍需专项验收。安装及其他功能的人工测试按用户反馈通过。

记录：[第一阶段验证](docs/electron-migration-stage-1.md)、[第二阶段迁移](docs/electron-migration-stage-2.md)。
