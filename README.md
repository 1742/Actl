# Actl

Actl 是面向 Windows 的本地 Agent 桌面软件。Vue 前端负责交互，Tauri 管理窗口和本地 Agent 进程，`agent/` 中的 Node.js 程序负责模型调用、工具执行、权限审批和数据持久化。当前仅提供本地运行时，模型服务由用户配置供应商账号和 API Key。

## 项目文档

完整导航见 [docs/README.md](docs/README.md)。

- [架构说明](docs/architecture.md)：进程边界、依赖关系、生命周期和事件链路。
- [业务说明](docs/business.md)：项目、会话、执行、审批、附件、压缩和设置。
- [模块详解](docs/README.md#模块详解)：前端、桌面壳、Agent、模型、工具权限、存储、Skills 和搜索。
- [HTTP API 与流协议](docs/api.md)。
- [开发、测试与 Windows 打包](docs/development.md)。
- [MCP 接入与实现](docs/mcp.md)。

## 开发入口

在 Windows x64 环境安装 Node.js（Agent 要求 `>=26.4.0`）、pnpm、Rust 与 Tauri Windows 构建依赖后，在仓库根目录运行：

```powershell
pnpm install
pnpm tauri:dev
```

Tauri 会先编译 Agent，再启动 Vite。Agent 源码修改后需重新编译并重启 Agent，详见开发说明。

Windows NSIS 安装包：

```powershell
pnpm tauri build --bundles nsis
```

打包钩子会构建包含 Node 运行时的 Agent SEA 可执行文件，并作为 Tauri 资源一起分发。开发和发布环境使用不同数据库目录。
