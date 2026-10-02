# 开发、验证与 Windows 打包

## 1. 环境与入口

项目仅面向 Windows。当前 Agent 的 [package.json](../agent/package.json) 要求 **Node.js >= 26.4.0**；根目录与 Agent 均声明 **pnpm 12.3.4**。Agent 使用 Node 内置 SQLite，SEA 打包也使用当前 Node 可执行文件，不能以旧版 Node 替代。

桌面开发还需要 Rust/Cargo、Windows C++ 构建工具与 WebView2 环境。当前 [Cargo.toml](../src-tauri/Cargo.toml) 使用 Rust 2021 edition 和 Tauri 2；具体依赖版本以清单与锁文件为准。SEA 构建脚本只接受 Windows x64，当前发布链路没有 ARM64 产物。

在仓库根目录安装工作区依赖：

```powershell
pnpm install
```

工作区包含根前端和 `agent`，见 [pnpm-workspace.yaml](../pnpm-workspace.yaml)。当前脚本与配置来源：[根 package.json](../package.json)、[Agent package.json](../agent/package.json)、[tauri.conf.json](../src-tauri/tauri.conf.json)。

## 2. 桌面开发

```powershell
pnpm tauri:dev
```

Tauri 的 beforeDevCommand 先执行 `pnpm agent:build`，再启动 Vite。前端地址为 `http://localhost:1420`，Vite 启用 strictPort，端口占用时直接报错。Rust debug 构建通过 `node agent/dist/main.js` 启动 Agent，自动注入 home、实际端口、随机 token 和心跳配置。

开发期间修改前端由 Vite 更新。修改 Agent 源码后需要重新编译并重启桌面管理的 Agent；此模式运行的是 `dist/main.js`，没有自动启用 `tsx watch`。修改 Rust 则由 Tauri 开发流程重编译。

仅执行 `pnpm dev` 会启动网页开发服务器。桌面能力和正常 Agent 连接依赖 Tauri invoke，普通浏览器运行不等同于完整桌面应用；部分前端测试使用 mock，不代表浏览器会自动启动后端。

## 3. 独立 Agent 开发

可以用 `tsx watch` 单独运行 Agent，供 HTTP 调试。下面的 token 必须替换为本次开发用的随机值，调用 API 时在 `X-Actl-Agent-Token` header 中携带同一值。

```powershell
$env:ACTL_AGENT_HOME = Join-Path (Get-Location) 'agent/.runtime'
$env:ACTL_AGENT_PORT = '3000'
$env:ACTL_AGENT_LOCAL_TOKEN = '<本次开发的随机令牌>'
pnpm agent:dev
```

独立模式未设置心跳变量时不会因缺少桌面心跳自动退出。没有 local token 会直接启动失败；模型凭据仍需通过业务接口配置，环境中的通用 `OPENAI_API_KEY` 不是当前模型目录的配置入口。

上述 home 是开发示例目录；代码缺省 home 是进程 cwd。`dotenv/config` 会从工作目录加载 `.env`，环境配置的最终来源应一并检查。构建后也可以在 `agent/` 中运行 `pnpm start`，它执行 `node dist/main.js`。

## 4. 环境变量与本地设置

来源：[config.ts](../agent/src/app/config.ts)、[runtime-auth.ts](../agent/src/auth/runtime-auth.ts)、[desktop-lifecycle.ts](../agent/src/app/desktop-lifecycle.ts)、[lib.rs](../src-tauri/src/lib.rs)。

| 变量                            | 使用方              | 默认值/行为                                                            |
| ------------------------------- | ------------------- | ---------------------------------------------------------------------- |
| ACTL_AGENT_HOME                 | Agent；桌面注入     | Agent 缺省 cwd，路径转为绝对路径                                       |
| ACTL_AGENT_PORT                 | Agent；桌面注入     | Agent 缺省3000；无效或非正整数回退3000                                 |
| ACTL_AGENT_LOCAL_TOKEN          | Agent；桌面注入     | 必填，本地 HTTP 认证令牌                                               |
| ACTL_AGENT_RUNTIME_MODE         | Agent               | development/release；缺省跟随构建 flavor，release 构建拒绝 development |
| ACTL_AGENT_LOG_DIR              | Agent               | `<home>/logs`                                                          |
| ACTL_AGENT_LOG_LEVEL            | Agent               | debug/info/warn/error，其他值回退 info                                 |
| ACTL_AGENT_LOG_RETENTION_DAYS   | Agent               | 正整数，默认14                                                         |
| ACTL_AGENT_LOG_MAX_FILE_SIZE    | Agent               | 字节数，默认50 MiB                                                     |
| ACTL_AGENT_HEARTBEAT_TIMEOUT_MS | Agent；桌面注入     | 出现即启用 managed 生命周期；有效范围100–3600000，桌面传20000          |
| ACTL_AGENT_EXECUTABLE           | 桌面壳              | 优先选择的 Agent 可执行文件路径                                        |
| ACTL_AGENT_NODE_PATH            | 桌面壳 debug        | 默认 node；用于启动 Agent JS                                           |
| ACTL_AGENT_RELEASE_NOTES        | 独立 Agent 发布脚本 | 默认 `Actl Agent <版本>`                                               |
| TAURI_DEV_HOST                  | Vite                | 指定开发 host，设置后配置 HMR 主机与1421端口                           |

桌面用户设置保存在默认数据目录下的 `agent-settings.json`，包含 Agent home 和端口。端口0在**桌面设置**中表示自动分配；直接传给 Agent 的环境变量0会回退3000。桌面启动值通过环境注入，不能仅修改某个开发终端的变量就假定桌面已采用它。

修改 home 不会自动搬迁旧数据。development/release 使用 `<home>/database/<mode>` 分别存库；日志、Skills 等目录另见[存储模块](modules/storage.md)。

## 5. 验证命令

| 命令（根目录）                                   | 范围                                            |
| ------------------------------------------------ | ----------------------------------------------- |
| pnpm build                                       | 前端 vue-tsc 检查及 Vite 生产构建               |
| pnpm lint                                        | ESLint 检查 src                                 |
| pnpm format:check                                | Prettier 检查 src                               |
| pnpm test                                        | Vitest 前端测试                                 |
| pnpm agent:typecheck                             | Agent TypeScript，无输出构建                    |
| pnpm agent:test                                  | Node test runner，通过 tsx 执行 Agent test 文件 |
| pnpm agent:build                                 | Agent tsc，产物到 agent/dist                    |
| cargo check --manifest-path src-tauri/Cargo.toml | Rust 类型与依赖检查                             |

目前测试文件覆盖范围：

| 文件                                                                         | 主要对象                                             |
| ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| [catalog.test.ts](../src/i18n/catalog.test.ts)                               | 前端语言目录                                         |
| [anthropic-messages.test.ts](../agent/test/anthropic-messages.test.ts)       | Anthropic 编解码与流事件                             |
| [images.test.ts](../agent/test/images.test.ts)                               | 图片输入、捕获与模型投影                             |
| [mcp.test.ts](../agent/test/mcp.test.ts)                                     | stdio、审批、热更新、加密配置、迁移与文件系统 Server |
| [process-output-buffer.test.ts](../agent/test/process-output-buffer.test.ts) | 命令输出缓冲与读取                                   |
| [shell.test.ts](../agent/test/shell.test.ts)                                 | Windows 命令工具和进程管理                           |
| [prompt-settings.test.ts](../agent/test/prompt-settings.test.ts)             | 提示词设置及编译                                     |
| [web-search.test.ts](../agent/test/web-search.test.ts)                       | 搜索配置、请求、策略与结果                           |

这些测试不是所有页面、运行状态和安装包的完整验收。涉及桌面生命周期、目录选择、通知或打包的变更，应在 Windows 桌面模式中验证对应操作。搜索设置的“测试”以及真实模型调用会访问配置的供应商，应使用有效开发配置。

## 6. 桌面安装包

```powershell
pnpm tauri build --bundles nsis
```

Tauri beforeBuildCommand 执行 `pnpm agent:package:tauri && pnpm build`，因此不用手工预先复制 exe。链路如下：

1. esbuild 将 Agent 入口打成 `agent/build/main.cjs`，目标 node26，注入 release flavor。
2. `build-sea.mjs` 用当前 Node 的 `--build-sea` 构建 Windows x64 单文件 exe，并生成 SHA-256 校验文件。
3. `prepare-tauri-agent.mjs` 复制 exe 到 `src-tauri/binaries/`。
4. Vite 构建前端至根 `dist/`。
5. Tauri 构建 Rust 壳并把 binaries 作为资源打入安装包。

当前 Agent 版本1.0.0时，中间 exe 为 `agent/build/release-inputs/v1.0.0/actl_windows_agent_x64.exe`。发布桌面应用从资源目录运行该 exe，不要求用户另外安装 Node；工具执行或 MCP Server 所需的外部程序仍由用户系统提供。

NSIS 安装包通常位于 `src-tauri/target/release/bundle/nsis/`（Cargo target 目录未被环境覆盖时）。Tauri 配置的 targets 为 all，命令中的 `--bundles nsis` 明确选择 NSIS。桌面版本与 Agent 版本分别来自 Tauri 配置和 Agent package.json，目前分别是0.1.0与1.0.0。

打包源码：[bundle.mjs](../agent/scripts/bundle.mjs)、[build-sea.mjs](../agent/scripts/build-sea.mjs)、[prepare-tauri-agent.mjs](../scripts/prepare-tauri-agent.mjs)。

## 7. 独立 Agent 发布包

```powershell
pnpm --dir agent package:win
```

该命令先 bundle/SEA，再运行 [package-agent-release.mjs](../agent/scripts/package-agent-release.mjs)。当前1.0.0产物：

```text
agent/releases/v1.0.0/
  manifest.cj
  win-x64/
    actl-agent-win-x64-1.0.0.zip
```

zip 内包含 exe、release.json 和 checksums.sha256。`manifest.cj` 是当前脚本实际文件名，不是文档笔误。脚本会重建对应版本发布目录；它是生成发布材料的工具，当前桌面壳没有消费 manifest 的自动更新流程。

## 8. 常见问题与数据维护

| 现象                | 首先检查                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------- |
| 桌面找不到 Agent    | debug 是否已有 agent/dist/main.js；release 是否包含 binaries exe；可执行文件覆盖变量是否正确 |
| Agent 独立启动失败  | Node 版本、local token、runtime mode、home 是否可写、SQLite schema 兼容性                    |
| 前端无法连接        | Rust ensure/start 返回值、Agent 实际端口/token、桌面日志目录、端口是否被占用                 |
| 修改后端源码无变化  | 桌面 debug 运行 dist，重新编译并重启 Agent                                                   |
| 模型列表为空/不可选 | 账号是否启用并有凭据、模型目标是否启用、当前会话兼容性及 diagnostics                         |
| 命令执行语法不符    | 当前工具通过 Windows cmd 执行，不能按 PowerShell 默认语法理解                                |
| MCP 连接失败        | command 是否在 PATH、参数/cwd/env、Server 是否支持 stdio；查看状态错误与日志                 |
| Skill 未出现        | `<home>/skills/<名称>/SKILL.md` 是否存在、frontmatter是否合法、刷新目录缓存                  |
| 搜索工具报不可用    | enabled、模式、模型原生能力、独立搜索供应商与凭据                                            |
| 旧库拒绝启动        | 检查 schema generation/version 和日志，备份后分析迁移；代码不会自动删除不兼容库              |

退出应用后备份 `<home>/database/<mode>`（包含 workspace.db 和 files），以及 `<home>/secrets/<mode>-master-key.bin`；恢复加密凭据必须使用对应密钥。在线复制 SQLite 可能遗漏 WAL 中未归并的数据，优先正常退出后备份。不要只备份 workspace.db 或只移动 exe 后假定凭据与附件也会迁移。具体目录与迁移行为见[存储模块](modules/storage.md)。

日志默认在 `<home>/logs`，桌面设置页可以打开日志/存储/Skills/配置目录。日志会对部分敏感字段和文本模式脱敏，但外部程序 stderr 不保证无敏感内容；提交故障材料前查看实际文件内容。

## 9. 当前实现边界

- 没有远程多用户登录、网络部署或跨平台桌面发行链路；HTTP 业务身份为本地开发者。
- 项目 cwd 和权限分类不构成 OS 文件沙箱。
- Skills 为手工安装目录；MCP 支持 stdio；外部搜索不提供任意网页正文抓取工具。
- SSE 没有持久事件重放，断流不等于取消；运行恢复通过当前响应与会话历史进行对齐。
- 全局 Hook、模型重试辅助函数、部分历史数据库表虽存在，接入程度以对应模块文档为准。

新增功能或修复时，依据实际调用更新相关架构、业务、模块及 API 文档。
