# 测试与集成验证

所有测试、验证程序与 fixture 集中在本目录；`src/` 保存产品实现。

```text
tests/
  unit/
    agent/                 审批状态、IPC 传输与客户端测试
    i18n/                  语言目录及前端翻译引用检查
  electron/
    agent-checks.ts        真实 Agent 业务与进程生命周期验证
    core-checks.ts         Electron 运行时中的核心能力检查
    types.ts               统一验证结果类型
    fixtures/              本地 MCP Server 和命令进程 fixture
```

## 单元测试

```powershell
pnpm test:agent-ui
pnpm test:multi-agent
```

通过 Node test runner 和 tsx 执行。测试直接导入产品模块，模拟 IPC 时序；不启动 Electron、不读取用户数据库，也不访问真实模型服务。

语言引用检查扫描 `src/renderer/src/`，测试文件移动不改变其检查范围。

multiAgent.test.ts 使用临时 SQLite、真实 AgentLoop/Coordinator 和本地内存模型替身，覆盖 v20→v21 迁移、计划 revision、并发子会话、只读执行防护、消息去重、审批暂停和整树取消。Electron 集成验证另覆盖持续树订阅、detach 后执行、follow-up 自动唤醒与重启恢复。

## Electron 集成验证

```powershell
pnpm verify:agent
pnpm verify:agent:packaged
```

这部分是必须在 Electron 环境执行的验证程序，不是 Node 自动发现的 `.test.ts`。源码验证先构建应用；打包验证使用已有 `dist/win-unpacked/Actl.exe`。两者共用同一验证入口，以隔离数据、本地模拟模型和真实 utility process 检查当前实现。

主进程仅在 `--verify-agent` 模式下加载集成验证模块；构建器将其编译为 main 产物中的独立代码块。fixture 单独构建到 `out/fixtures/`，并作为 `verification-fixtures` 随安装包分发，供打包验证使用。目录位于 `src/` 外不代表这些集成验证资源不参与构建。

验证报告与临时数据位于 `artifacts/agent/`，不放进测试源码目录。完整环境、构建和排查说明见[开发文档](../docs/development.md)。
