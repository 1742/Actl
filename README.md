# Actl

Windows Electron 桌面 harness。此目录独立安装依赖、开发和打包；旧 Tauri 实现在相邻的
`Actl-tauri` 仓库，不参与本项目构建。

当前完成范围为迁移第一阶段：建立 Electron + Vue + TypeScript 工程，并验证内部
utility process 对旧 Agent 关键能力的兼容性。完整聊天功能尚未迁入。

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
pnpm verify:runtime
pnpm pack:win
pnpm verify:packaged
pnpm diagnose:renderer
```

- `verify:runtime`：构建后用真实 Electron utility process 运行检查，不创建窗口。
- `pack:dir`：仅生成 `dist/win-unpacked/Actl.exe` 及其资源。
- `pack:win`：生成 Windows x64 NSIS 安装包，同时保留 `win-unpacked`。
- `verify:packaged`：使用 `win-unpacked/Actl.exe`、ASAR 内的运行时代码及分发资源重跑检查。
- `start`：启动生产构建预览；点击“运行兼容性验证”可检查 preload → IPC → utility process 的完整链路。
- `start:packaged`：打开 `win-unpacked` 中的实际打包应用，无需先安装。
- `diagnose:renderer`：运行没有 Vue、preload、IPC 或业务数据的最小沙箱窗口，用于区分系统/运行时与应用代码问题。

输出目录：

```text
out/                         编译结果
dist/                        安装包和打包后的应用
artifacts/compatibility/     命令行验证报告、隔离数据库、日志和合成主密钥
```

每次命令行验证创建独立目录，结果写入该次目录的 `latest.json`。CLI 以非零退出码报告失败，
并验证源码/打包运行模式。测试数据位于带中文与空格的路径，保留供排查；可在应用关闭后手动清理。
图形界面的验证数据位于 `%APPDATA%/Actl-Electron/compatibility`，不会打开旧数据库。

安装包尚未配置发布签名、自动更新和正式产品图标。当前只是迁移验证包。

## 代码结构

```text
src/main/          窗口、受限 IPC、内部运行时生命周期
src/preload/       仅暴露 runChecks()，不向界面暴露通用 IPC 或 Node
src/renderer/      Vue 兼容性验证界面
src/shared/        进程间数据契约
src/runtime/       utility process 入口、检查程序、旧代码验证基线
scripts/           从源码或打包应用运行验证
```

主进程只管理桌面能力；SQLite、日志、文件、Shell、MCP 验证均在独立 utility process 内执行。
不启动业务 HTTP 服务。开发时 electron-vite 的页面/HMR 服务不随安装包运行。

渲染进程开启 `contextIsolation` 和 `sandbox`，关闭 `nodeIntegration`。
IPC 限定主窗口主 frame 和页面 URL，不接受路径、命令或任意参数。页面阻止新窗口及导航，
不渲染外来 HTML。运行时检查使用主进程生成的专用目录和内置测试命令。
生产页面通过受限 `actl://app/index.html` 协议加载，只能读取编译后的 renderer 目录，
保留 CSP，不提供任意本机文件读取能力。

## 验证边界

检查覆盖进程隔离、SQLite 旧 schema v18 建库和重开、WAL/外键/回滚、文件哈希、旧凭据加密、
旧日志脱敏、旧 ProcessSupervisor、MCP 初始化/工具发现/调用/关闭，以及运行时关闭确认。

MCP Server 和后台命令测试复用应用自身 Electron 可执行文件，以 `ELECTRON_RUN_AS_NODE=1`
运行随包分发的测试 fixture，因此验证不依赖 PATH 中的 Node。该模式目前仅用于兼容性验证；
后续设计正式 Node MCP 启动策略和 Electron fuses 时必须一起评估。

这些检查不代表完整 AgentLoop、旧用户数据库导入、历史 schema 升级、模型联网、附件业务、
审批恢复、日志滚动或应用被强制终止后的所有后代清理已经验证。后续阶段应逐项接入验收。

本轮验收结果和版本选择依据见 [第一阶段验证记录](docs/electron-migration-stage-1.md)。
