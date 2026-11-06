# 兼容性验证用旧代码

这些文件复制自旧仓库 `Actl-tauri/agent/src`，基线提交为
`9819d05923dca8a0160696f8e8d1492fab27313c`。
`manifest.json` 记录原始相对路径和 SHA-256；本阶段保持源码原样。

验证使用旧数据库 schema/migration runner、日志、命令进程管理及凭据保护实现。
数据库检查直接使用 `DatabaseSync`，尚未迁移完整 `SqliteWorkspaceRepository`。
MCP 使用与旧锁文件相同的 SDK 2.0.0 和独立本地测试 Server，尚未迁移 MCP 管理器。

新项目安装、构建和运行不依赖旧仓库目录。这是第一阶段验证基线；后续迁移核心模块时，
应将代码归入正式模块，并移除被替代的验证副本。
