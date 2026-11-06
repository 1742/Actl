# Electron 迁移第一阶段验证记录

日期：2026-11-06。新工程在 Actl 独立初始化、安装依赖、构建和打包；Actl-tauri 没有修改。

## 结果

可采用 Electron 内部 utility process 承载已验证的旧 Agent 基础能力。基线固定为
Electron 43.8.7、内置 Node 24.22.1、Windows x64；开发机为 Node 26.13.0。

| 验证项 | 结果 | 范围 |
| --- | --- | --- |
| 独立 utility process | 通过 | PID 与主进程不同，使用 Electron 内置 Node，不启动业务 HTTP 服务 |
| SQLite | 通过 | 原 schema v18、原 migration runner 的当前版本校验、WAL、外键、事务回滚及持久化重开 |
| 文件与凭据 | 通过 | 中文/空格路径、SHA-256、原 AES-256-GCM 实现、主密钥重载与篡改拒绝 |
| 日志 | 通过 | 原 pino/pino-roll 实现、NDJSON、请求上下文、中文及敏感字段脱敏 |
| Windows 命令 | 通过 | 原 ProcessSupervisor、cmd 代码页 936、中文输出、后台轮询、停止和子进程退出确认 |
| MCP stdio | 通过 | 原锁文件对应 SDK 2.0.0、初始化、发现工具、19+23=42、连接关闭及进程退出 |
| 运行时关闭 | 通过 | 收到关闭确认后退出，退出码 0 |
| Vue/preload/IPC | 通过 | 开发窗口与实际打包窗口均从按钮触发检查，显示 6/6 通过 |
| 打包页面加载 | 通过 | `actl://app/index.html`，CSP、生效的渲染沙箱、关闭 Node integration |
| Windows NSIS 构建 | 通过 | x64 验证安装包成功生成，实际 ASAR 内运行时及外置 fixture 均通过检查 |

源码和打包应用的自动检查均以退出码 0 结束。打包检查确认 `app.isPackaged=true`。
MCP Server 及长任务 fixture 使用应用自身可执行文件，不依赖 PATH 中的外部 Node。

## 可复查证据

- 源码报告：`artifacts/compatibility/source/2026-11-06T00-21-37-971Z/latest.json`
- 打包报告：`artifacts/compatibility/packaged/2026-11-06T00-22-25-673Z/latest.json`
- 开发界面 IPC 报告：`artifacts/ui-dev-final/latest.json`
- 打包界面 IPC 报告：`artifacts/ui-packaged-visible/latest.json`
- 安装包：`dist/Actl-0.1.0-windows-x64-setup.exe`，118,296,317 字节（约 118 MB）

报告及构建产物不提交到 Git。重跑会创建新的独立目录，以上为本轮记录。
旧代码验证副本保持原样，来源提交及 11 个源码文件的 SHA-256 见 `src/runtime/legacy`。

## 本机兼容性发现

Windows 11 26H2，build 26300.9711：

- Electron 45.2.3 的 utility process 基础能力通过，但渲染进程退出码为
  `-2147483645`（0x80000003），使页面加载返回 `ERR_FAILED`。
- 去除 Vue、preload、IPC 和外部资源后的最小沙箱空白窗口仍复现。
- 软件渲染、独立 profile、复制运行时到 C 盘临时目录均未解决。
- 对运行目录补充应用沙箱读取权限也未解决，临时添加的 ACE 已撤销。
- 同一个最小程序在 Electron 43.8.7 下通过，实际开发窗口和打包窗口也通过。

因此本阶段选择 43.8.7，保留 `sandbox=true`、`contextIsolation=true` 和
`nodeIntegration=false`。这些结果只证明本机版本对照，尚未定位 45.2.3 的底层根因，
不能推断所有 Windows 机器都会失败。官方仓库存在
[相似的 26H2 渲染崩溃报告](https://github.com/electron/electron/issues/54614)，仅作排查参考。
后续应跟踪 Electron 修复和支持周期，在更新版本通过同套验收后升级。

cmd 输出需先探测代码页，再按旧实现选择解码；不能假设 Windows 命令全部输出 UTF-8。

## 验证边界及下一阶段

验证不读取旧用户数据，不调用模型 API，不需要 API Key。尚未迁移或验证完整
AgentLoop、全部 SDK/供应商兼容性、完整 SQLite 仓库、旧库导入和历史迁移链、
附件业务、审批恢复、Skills/MCP 管理、应用强制崩溃后的全部后代清理。
没有在无开发环境的另一台机器上测试，也没有执行 NSIS 安装/卸载流程。
安装包使用默认 Electron 图标，尚未签名和配置自动更新。

下一阶段可复用此工程结构，将正式 Agent 核心模块迁入 utility process，
抽出独立业务用例，建立类型化请求/事件协议，再迁移项目、会话、流式输出、审批、取消和历史恢复闭环。
旧数据导入、加密格式变化和数据库重构应独立处理。
