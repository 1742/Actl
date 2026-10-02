use rand::{rngs::OsRng, RngCore};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, RunEvent, State};

const AGENT_HEARTBEAT_TIMEOUT_MS: &str = "20000";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSettings {
    port: u16,
    storage_directory: String,
}

fn default_storage_directory() -> Result<PathBuf, String> {
    Ok(std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .ok_or("Unable to locate the Actl executable directory.")?
        .join("data"))
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(default_storage_directory()?.join("agent-settings.json"))
}

#[tauri::command]
fn get_agent_settings() -> Result<AgentSettings, String> {
    let path = settings_path()?;
    if path.exists() {
        return serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string());
    }
    Ok(AgentSettings {
        port: 0,
        storage_directory: default_storage_directory()?.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn save_agent_settings(settings: AgentSettings) -> Result<(), String> {
    if settings.storage_directory.trim().is_empty()
        || !PathBuf::from(&settings.storage_directory).is_absolute()
    {
        return Err("存储目录必须是绝对路径。".into());
    }
    let path = settings_path()?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(
        path,
        serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn restart_agent(
    app: AppHandle,
    manager: State<'_, AgentManager>,
) -> Result<RuntimeConfig, String> {
    manager.shutdown();
    manager.ensure_started(&app)
}

#[tauri::command]
fn open_agent_directory(kind: String) -> Result<(), String> {
    let settings = get_agent_settings()?;
    let home = PathBuf::from(settings.storage_directory);
    let directory = match kind.as_str() {
        "storage" => home,
        "logs" => home.join("logs"),
        "skills" => home.join("skills"),
        "config" => settings_path()?.parent().unwrap().to_path_buf(),
        _ => return Err("未知目录。".into()),
    };
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Command::new("explorer.exe")
        .arg(directory)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeConfig {
    agent_url: String,
    agent_token: String,
}

struct AgentProcess {
    child: Child,
    config: RuntimeConfig,
    heartbeat_stop: Arc<AtomicBool>,
}

#[derive(Default)]
struct AgentManager {
    process: Mutex<Option<AgentProcess>>,
}

impl AgentManager {
    fn ensure_started(&self, app: &AppHandle) -> Result<RuntimeConfig, String> {
        let mut process = self
            .process
            .lock()
            .map_err(|_| "Agent process state is unavailable.")?;
        if let Some(active) = process.as_mut() {
            if active
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
            {
                return Ok(active.config.clone());
            }
            active.heartbeat_stop.store(true, Ordering::Release);
            *process = None;
        }

        let settings = get_agent_settings()?;
        let port = if settings.port == 0 {
            reserve_loopback_port()?
        } else {
            settings.port
        };
        let port_check = TcpListener::bind(("127.0.0.1", port))
            .map_err(|e| format!("Agent 端口 {port} 不可用：{e}"))?;
        drop(port_check);
        let token = random_token();
        let config = RuntimeConfig {
            agent_url: format!("http://127.0.0.1:{port}"),
            agent_token: token.clone(),
        };
        let mut command = agent_command(app)?;
        let home = PathBuf::from(settings.storage_directory);
        std::fs::create_dir_all(&home).map_err(|error| error.to_string())?;
        command
            .env("ACTL_AGENT_HOME", home)
            .env("ACTL_AGENT_PORT", port.to_string())
            .env("ACTL_AGENT_LOCAL_TOKEN", token)
            .env(
                "ACTL_AGENT_HEARTBEAT_TIMEOUT_MS",
                AGENT_HEARTBEAT_TIMEOUT_MS,
            )
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let child = command
            .spawn()
            .map_err(|error| format!("Unable to start local Agent: {error}"))?;
        let heartbeat_stop = Arc::new(AtomicBool::new(false));
        start_heartbeat(config.clone(), Arc::clone(&heartbeat_stop));
        *process = Some(AgentProcess {
            child,
            config: config.clone(),
            heartbeat_stop,
        });
        Ok(config)
    }

    fn shutdown(&self) {
        let Ok(mut process) = self.process.lock() else {
            return;
        };
        let Some(mut active) = process.take() else {
            return;
        };
        active.heartbeat_stop.store(true, Ordering::Release);
        send_shutdown(&active.config);
        for _ in 0..10 {
            if active.child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = active.child.kill();
        let _ = active.child.wait();
    }
}

fn start_heartbeat(config: RuntimeConfig, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        while !stop.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_secs(5));
            if stop.load(Ordering::Acquire) {
                return;
            }
            send_lifecycle_post(&config, "/_lifecycle/heartbeat");
        }
    });
}

fn reserve_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| error.to_string())
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn agent_command(app: &AppHandle) -> Result<Command, String> {
    if let Ok(executable) = std::env::var("ACTL_AGENT_EXECUTABLE") {
        return Ok(Command::new(executable));
    }
    if cfg!(debug_assertions) {
        let entrypoint = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..\\agent\\dist\\main.js");
        if !entrypoint.is_file() {
            return Err(format!(
                "Agent development entrypoint is missing: {}",
                entrypoint.display()
            ));
        }
        let node = std::env::var("ACTL_AGENT_NODE_PATH").unwrap_or_else(|_| "node".to_owned());
        let mut command = Command::new(node);
        command.arg(entrypoint);
        return Ok(command);
    }
    let executable = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("binaries")
        .join("actl_windows_agent_x64.exe");
    if !executable.is_file() {
        return Err(format!(
            "Bundled Agent executable is missing: {}",
            executable.display()
        ));
    }
    Ok(Command::new(executable))
}

fn send_shutdown(config: &RuntimeConfig) {
    send_lifecycle_post(config, "/_lifecycle/shutdown");
}

fn send_lifecycle_post(config: &RuntimeConfig, path: &str) {
    let Ok(address) = config.agent_url.trim_start_matches("http://").parse() else {
        return;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_secs(1)) else {
        return;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {address}\r\nX-Actl-Agent-Token: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        config.agent_token,
    );
    let _ = stream.write_all(request.as_bytes());
    let mut response = [0_u8; 64];
    let _ = stream.read(&mut response);
}

#[tauri::command]
fn get_runtime_config(
    app: AppHandle,
    manager: State<'_, AgentManager>,
) -> Result<RuntimeConfig, String> {
    manager.ensure_started(&app)
}

#[tauri::command]
fn pick_directory() -> Option<String> {
    rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_skills_directory() -> Result<(), String> {
    open_agent_directory("skills".into())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum AgentNotificationKind {
    Completed,
    PermissionRequested,
}

#[tauri::command]
fn notify_agent_event(
    app: AppHandle,
    kind: AgentNotificationKind,
    session_title: String,
    detail: String,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window is unavailable.")?;
    if window.is_focused().map_err(|error| error.to_string())? {
        return Ok(());
    }

    let title = match kind {
        AgentNotificationKind::Completed => "任务已完成",
        AgentNotificationKind::PermissionRequested => "需要权限确认",
    };
    let session_title = session_title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let session_title = session_title.chars().take(80).collect::<String>();
    let detail = detail.split_whitespace().collect::<Vec<_>>().join(" ");
    let detail = detail.chars().take(160).collect::<String>();
    let body = if detail.is_empty() {
        session_title
    } else if session_title.is_empty() {
        detail
    } else {
        format!("{session_title}：{detail}")
    };
    let mut notification = notify_rust::Notification::new();
    notification.summary(title).body(&body).auto_icon();

    let exe = tauri::utils::platform::current_exe().map_err(|error| error.to_string())?;
    let exe_dir = exe
        .parent()
        .ok_or("Unable to locate Actl executable directory.")?;
    if !exe_dir.ends_with("target\\debug") && !exe_dir.ends_with("target\\release") {
        notification.app_id(&app.config().identifier);
    }

    let handle = notification.show().map_err(|error| error.to_string())?;
    // The desktop Tauri notification plugin drops this handle, losing body-click events.
    std::thread::spawn(move || {
        let _ = handle.wait_for_response(move |response: &notify_rust::NotificationResponse| {
            if !matches!(response, notify_rust::NotificationResponse::Default) {
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        });
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AgentManager::default())
        .invoke_handler(tauri::generate_handler![
            get_runtime_config,
            pick_directory,
            open_skills_directory,
            get_agent_settings,
            save_agent_settings,
            restart_agent,
            open_agent_directory,
            notify_agent_event
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application");
    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            app_handle.state::<AgentManager>().shutdown();
        }
    });
}
