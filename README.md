# Actl

Actl 是面向 Windows 的桌面 Agent harness，提供项目与会话管理、模型对话、工具执行和审批、附件、Skills、MCP 及联网搜索。

应用使用 Electron、Vue 和 TypeScript。Agent 运行在 Electron utility process 中，业务通过内部 IPC 调用；安装后无需单独启动本地服务或安装应用自身的 Node 运行时。

## 开发

开发环境要求 Windows x64、Node.js 24.19+ 和 pnpm 12.16.1。Electron 版本由项目锁定为 43.8.7，应用使用其内置 Node.js 24.22.1。

```powershell
pnpm install
pnpm dev
```

首次使用需在设置中添加供应商账号和模型。模型、搜索和第三方 MCP 所需的凭据及外部程序由用户配置。

## 检查与打包

```powershell
pnpm typecheck
pnpm test:agent-ui
pnpm verify:agent
pnpm pack:win
pnpm verify:agent:packaged
```

Windows 安装包输出到 `dist/Actl-<版本>-windows-x64-setup.exe`。可直接运行的应用位于 `dist/win-unpacked/Actl.exe`。

## 文档

- [文档目录与术语](docs/README.md)
- [架构与进程生命周期](docs/architecture.md)
- [业务规则](docs/business.md)
- [IPC API 与事件协议](docs/api.md)
- [开发、配置、验证与打包](docs/development.md)
- [模块说明](docs/README.md#模块详解)

默认设置位于 `%APPDATA%/Actl-Electron/desktop-settings.json`，数据默认位于同目录的 `data`。开发与发布使用不同的数据库和主密钥；修改存储目录不会自动迁移数据，备份和恢复方式见[存储文档](docs/modules/storage.md)。

当前安装包未配置产品图标、发布签名和自动更新。支持范围、运行限制及诊断方式见[开发文档](docs/development.md)。
