# 开发、配置、验证与 Windows 打包

## 1. 环境

本项目仅构建 Windows x64 应用。开发需要 Node.js **24.19+** 和 **pnpm 12.16.1**，具体版本和依赖以根目录 [package.json](../package.json)、[pnpm-lock.yaml](../pnpm-lock.yaml) 为准。

应用运行于 **Electron 43.8.7 / 内置 Node.js 24.22.1**。开发机 Node 用于包管理、构建和源码测试，不替代 Electron 运行时。当前没有 Rust、Tauri、独立 Agent SEA 或第二个工作区安装步骤。

```powershell
pnpm install
```

安装脚本下载 Electron；首次打包可能下载 electron-builder 的 Windows 工具。运行依赖包含 Koffi 的 Windows x64 原生模块，负责调用 Job Object API。

## 2. 开发与预览

```powershell
pnpm dev
```

该命令先构建验证 fixture，再启动 electron-vite。主进程、preload 和 Vue 界面由同一工程构建。界面支持 HMR；涉及主进程或 Agent 状态的修改，应确认进程已经重新启动，不以界面热更新代替运行时重启。

普通浏览器没有 `window.actlAgent`，不能独立承担完整桌面业务。Vite 开发端口仅供页面与 HMR，不是业务 API。

```powershell
pnpm build
pnpm start
```

`start` 预览已有生产构建；`pnpm start:packaged` 启动已有 `dist/win-unpacked/Actl.exe`。两者均不自动执行完整打包。

## 3. 配置与目录

| 项目 | 位置或行为 |
| --- | --- |
| 桌面用户配置目录 | `%APPDATA%/Actl-Electron` |
| 桌面设置 | 上述目录中的 `desktop-settings.json` |
| 默认 Agent home | 上述目录中的 `data` |
| 开发数据库 | `<home>/database/development/workspace.db` |
| 发布数据库 | `<home>/database/release/workspace.db` |
| 主密钥 | `<home>/secrets/<mode>-master-key.bin` |
| 日志 | `<home>/logs` |
| 用户 Skills | `<home>/skills` |

桌面设置体只包含绝对存储路径：

```json
{ "storageDirectory": "D:\\ActlData" }
```

通过设置选择目录，保存后重启 Agent 才切换。保存不复制数据库、密钥、附件或 Skills。完整布局和手动备份恢复见[存储模块](modules/storage.md)。

主进程显式传入 home 和运行模式；`app.isPackaged` 决定 `release/development`。Worker 调用 `loadAppConfig(mode, { ACTL_AGENT_HOME: home })`，当前不会将终端中的 `ACTL_AGENT_LOG_*`、`ACTL_AGENT_RUNTIME_MODE` 等变量转为桌面配置；也不自动加载 `.env`。核心配置函数虽有环境变量解析能力，不代表桌面入口已接入这些选项。

当前日志配置为 info、50 MiB 滚动阈值、保留参数 14；保留实际按文件数量控制。供应商 Key 在应用业务设置中保存，通用 `OPENAI_API_KEY` 不是模型目录的自动配置入口。

## 4. 验证命令

| 命令 | 范围 |
| --- | --- |
| `pnpm typecheck` | main、preload、runtime、核心及 Vue 类型检查 |
| `pnpm test:agent-ui` | 审批状态、IPC 订阅隔离/取消、直接命令及语言目录 |
| `pnpm build` | 类型检查、fixture 和三端生产构建 |
| `pnpm verify:agent` | 构建后验证当前核心及真实 Agent 业务闭环 |
| `pnpm verify:agent:packaged` | 使用已有打包应用重跑 Agent 集成检查 |
| `pnpm diagnose:renderer` | 不加载 Vue/preload/业务数据的最小窗口诊断 |

统一验证入口使用当前产品源码：先在 Electron 运行时检查 SQLite schema/WAL/事务、凭据篡改检测、日志脱敏和 Shell 轮询/停止，再通过真实 Agent 验证项目/会话、附件、流事件、审批、MCP 配置/调用/移除、待审批重启、并发取消、异常恢复及正常/强制退出后的进程回收。模型服务只监听本机，使用合成凭据，不需要真实模型 Key。

验证代码集中在 src/verification/，通过 --verify-agent 启用，不维护冻结核心副本或第二套验证 Worker。MCP fixture 不等于任意第三方 Server 的完整测试。前端测试使用 Node test runner，覆盖真实 Pinia 用例、IPC 时间顺序及语言目录，不等同于完整图形交互验收。

每次命令行集成检查创建隔离目录，写入报告并以退出码表示结果：

```text
artifacts/agent/source/<时间>/agent-report.json
artifacts/agent/packaged/<时间>/agent-report.json
```

测试 home 与正常用户数据分开，包含中文/空格路径；基础检查与业务检查合并在同一个 agent-report.json。产品界面和 preload 不暴露验证入口。测试目录可在检查进程退出后清理。

## 5. Windows 打包

```powershell
pnpm pack:win
pnpm verify:agent:packaged
```

[electron-builder.yml](../electron-builder.yml) 定义 NSIS x64 安装包，版本统一取根 package.json。链路为类型检查 → esbuild fixture → electron-vite → electron-builder。产物：

```text
out/main/                                  main 与 utility process 的 CJS 产物
out/preload/                               preload CJS
out/renderer/                              Vue 页面和资源
out/fixtures/                              MCP/命令验证程序
dist/win-unpacked/Actl.exe                  可直接运行的应用
dist/Actl-<版本>-windows-x64-setup.exe       NSIS 安装包
```

主程序代码和依赖使用 ASAR，原生模块由打包器放入 `app.asar.unpacked`；fixture 作为 `verification-fixtures` 额外资源分发。`npmRebuild=false`，当前使用 Koffi 的预编译模块。更新原生依赖后必须在真实打包环境验证加载。

`pnpm pack:dir` 只生成解包应用。构建与打包共用 `out` 和 `dist/win-unpacked`，不要并行重建这些目录和运行其验证。

安装器支持选择安装目录，当前为非强制系统级安装；卸载配置保留应用数据。安装包尚未配置正式图标、发布签名和自动更新。应用无需外部 Node，但用户命令和第三方 MCP 的依赖由系统提供。

## 6. 排查

| 现象 | 检查顺序 |
| --- | --- |
| Agent 启动失败 | 核对存储路径权限、启动错误、日志、数据库 schema 和主密钥；不要直接删除数据目录 |
| 无法使用模型 | 核对账号启用、Base URL、凭据、providerModel、协议和能力声明 |
| 工具一直运行 | 区分等待审批、`yieldTimeMs` 等待和后台进程；通过 `shell_poll` 看状态，`shell_stop` 明确停止 |
| 通知出现但未见审批 | 检查选中的来源会话与 pending batch；实时事件、最终快照和历史回读应保持一致 |
| 后台进程残留 | 确认由当前 Agent 启动并处于 Job 内；系统服务、WMI 和其他应用进程不属于 Agent Job |
| MCP 无法连接 | 检查可执行文件、args、cwd、依赖及 stderr；先用设置中的测试，再保存 |
| 数据库不兼容 | 关闭应用并备份完整 home，核对 schema 迁移链；选择兼容版本或新目录 |
| 渲染窗口崩溃 | 运行最小 renderer 诊断，再检查页面、preload 与业务初始化 |

当前在本机 Windows 11 26H2 环境中固定使用 Electron 43；Electron 45 的最小渲染窗口曾出现异常，后续版本升级按专项验证处理。升级时重跑最小窗口、实际界面、原生依赖和打包检查，不以关闭沙箱作为默认兼容措施。

真实模型、联网搜索和第三方 MCP 测试会使用用户配置并可能访问外部服务。旧用户数据导入没有自动化向导；完整迁移链、所有供应商组合及独立机器安装环境需按实际使用范围验证。
