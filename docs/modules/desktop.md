# Tauri 桌面壳模块

## 1. 定位

核心实现集中在 [lib.rs](../../src-tauri/src/lib.rs)。[main.rs](../../src-tauri/src/main.rs) 调用库入口；壳不执行模型循环，不直接读写 Agent 会话数据库。它管理桌面窗口、本地 Agent 直接子进程、系统目录和通知。

[tauri.conf.json](../../src-tauri/tauri.conf.json) 配置默认 1280×768 窗口、最小 800×600、开发 URL localhost:1420、前端产物 dist 和 binaries 资源。当前 CSP 为 null；不要在架构文档中称已配置严格内容策略。

## 2. 前端命令接口

命令在 `invoke_handler` 注册，前端封装于 [bridge.ts](../../src/services/bridge.ts)。

| 命令                    | 参数                     | 行为/返回                                              |
| ----------------------- | ------------------------ | ------------------------------------------------------ |
| `get_runtime_config`    | 无                       | 确保 Agent 启动，返回 agentUrl/agentToken              |
| `get_agent_settings`    | 无                       | 读取 port/storageDirectory                             |
| `save_agent_settings`   | settings                 | 校验绝对存储路径并保存，不自动重启                     |
| `restart_agent`         | 无                       | 关闭旧进程并按最新设置启动，返回新连接配置             |
| `pick_directory`        | 无                       | rfd 目录选择，取消返回空                               |
| `open_agent_directory`  | kind                     | storage/logs/skills/config，创建目录并用 Explorer 打开 |
| `open_skills_directory` | 无                       | 打开 home/skills 的兼容入口                            |
| `notify_agent_event`    | kind/sessionTitle/detail | 完成或审批系统通知                                     |

## 3. 设置位置与端口

默认 home 是**当前桌面可执行文件父目录的 data 子目录**，不是固定的仓库 data，也不是 AppData。开发时通常落到 Rust target/debug/data，发布时落到安装后的 exe 旁。

设置文件固定为默认位置的 `agent-settings.json`：

```json
{
  "port": 0,
  "storageDirectory": "D:\\ActlData"
}
```

改变 storageDirectory 不改变设置文件位置，也不搬迁已有数据库、密钥或 Skill。保存要求路径非空且绝对；端口 Rust 类型为 u16，前端检查 0–65535。

port=0 使用 `TcpListener` 临时分配端口，再释放并启动 Agent；固定端口也先 bind 检查。检查和 Agent 实际监听不是同一个 socket，存在短暂竞争窗口，不是持有监听句柄传递给子进程。

## 4. AgentManager

`Mutex<Option<AgentProcess>>` 保存 Child、RuntimeConfig 和 heartbeat_stop 原子标志。ensure_started 串行检查状态：

- 现有 Child 未退出：返回原配置，不重复启动。
- 已退出：停止旧心跳，丢弃旧记录，重新读取设置。
- 新进程：随机生成 32 字节 token，设置环境变量并 spawn，注册 5 秒心跳线程。

不会在后台主动重启崩溃进程；再次请求 get_runtime_config 或显式重启才会进入 ensure_started。前端健康轮询判断服务是否真正可用，spawn 成功本身不保证启动成功。

启动命令优先级：

1. ACTL_AGENT_EXECUTABLE 指定的可执行文件。
2. debug 构建：ACTL_AGENT_NODE_PATH 或 PATH node，参数为 `agent/dist/main.js`。
3. release 构建：Tauri resource_dir/binaries/actl_windows_agent_x64.exe。

Windows 使用 CREATE_NO_WINDOW，stdin/stdout/stderr 为 null。日常故障信息看 Agent 文件日志；在文件日志创建前就失败的 stderr 不会由桌面壳展示。

## 5. 心跳与关闭

壳用 TcpStream 发原始 HTTP POST，请求带 `X-Actl-Agent-Token`；连接/读取有 1 秒超时。每 5 秒发 heartbeat，Agent 20 秒未收到则关闭。

shutdown 取走进程记录、停止心跳、发 shutdown，最多 10 次、每次 100 ms 检查退出；仍存活则 Child.kill/wait。退出事件 `ExitRequested/Exit` 均调用，取走记录使重复关闭成为空操作。

Agent 自己负责 shell/MCP 子进程处置；壳的 Child.kill 只管理直接子进程，没有在这里实现 Windows Job Object 的整个后代生命周期约束。Agent 10 秒清理期限与壳约 1 秒等待不同，详见[架构](../architecture.md)。

## 6. 系统通知

仅支持 completed 和 permission_requested。主窗口已聚焦时直接返回；标题由事件类型确定，会话标题规范化后最多 80 字符，详情最多 160 字符。

使用 notify-rust，持有返回 handle 并在线程中等待默认点击响应。点击会 show、unminimize、set_focus 主窗口，没有携带会话 ID 跳转。安装版设置应用 identifier，Rust target/debug/release 中开发运行有对应判断。

## 7. 构建和资源

beforeDevCommand 编译 Agent 再启动 Vite；beforeBuildCommand 构建 Agent SEA、复制 exe，再构建前端。binaries 作为 resources 分发，不通过 Tauri externalBin 声明 sidecar。

配置权限见 [capabilities/default.json](../../src-tauri/capabilities/default.json)，具体打包路径、脚本和开发热更新限制见[开发说明](../development.md)。
