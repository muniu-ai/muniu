use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

struct ManagedDaemon(Mutex<Option<CommandChild>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopRuntimeStatus {
    runtime: &'static str,
    platform: &'static str,
    tray: bool,
    window_label: &'static str,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct DesktopSettings {
    theme: String,
    close_behavior: String,
    launch_at_login: bool,
    lightweight_mode: bool,
    api_url: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayProvider {
    id: String,
    name: String,
    enabled: bool,
}

#[derive(Deserialize)]
struct TrayProviderList {
    providers: Vec<TrayProvider>,
}

#[derive(Deserialize)]
struct TrayProxyRuntime {
    running: bool,
}

#[derive(Deserialize)]
struct TrayProxyStatus {
    runtime: TrayProxyRuntime,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            close_behavior: "tray".to_string(),
            launch_at_login: false,
            lightweight_mode: false,
            api_url: "http://127.0.0.1:7318".to_string(),
        }
    }
}

#[tauri::command]
fn desktop_runtime_status() -> DesktopRuntimeStatus {
    DesktopRuntimeStatus {
        runtime: "Tauri 2",
        platform: "macOS-first",
        tray: true,
        window_label: "main",
    }
}

#[tauri::command]
fn read_desktop_settings() -> Result<DesktopSettings, String> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(DesktopSettings::default());
    }
    let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    serde_json::from_str::<DesktopSettings>(&raw).map_err(|error| error.to_string())
}

#[tauri::command]
fn write_desktop_settings(settings: DesktopSettings) -> Result<DesktopSettings, String> {
    let path = settings_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "settings path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let normalized = normalize_settings(settings);
    let raw = serde_json::to_string_pretty(&normalized).map_err(|error| error.to_string())?;
    let tmp_path = path.with_extension("json.tmp");
    fs::write(&tmp_path, raw).map_err(|error| error.to_string())?;
    fs::rename(&tmp_path, &path).map_err(|error| error.to_string())?;
    Ok(normalized)
}

#[tauri::command]
fn enter_lightweight_mode(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.destroy().map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn run() {
    install_panic_log_hook();

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("木牛")
                .build(),
        )
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let daemon = spawn_managed_daemon(app.handle())?;
            app.manage(ManagedDaemon(Mutex::new(daemon)));
            build_tray(app)?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = refresh_tray_providers(&handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_runtime_status,
            read_desktop_settings,
            write_desktop_settings,
            enter_lightweight_mode
        ])
        .build(tauri::generate_context!())
        .expect("error while building 木牛 desktop");

    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            stop_managed_daemon(handle);
        }
    });
}

fn stop_managed_daemon(app: &tauri::AppHandle) {
    if let Ok(mut child) = app.state::<ManagedDaemon>().0.lock() {
        if let Some(child) = child.take() {
            let _ = child.kill();
        }
    }
}

fn install_panic_log_hook() {
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = write_panic_log(info);
        previous_hook(info);
    }));
}

fn write_panic_log(info: &std::panic::PanicHookInfo<'_>) -> Result<(), String> {
    let path = panic_log_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "panic log path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    let thread = std::thread::current();
    let thread_name = thread.name().unwrap_or("unnamed");
    let location = info
        .location()
        .map(|location| {
            format!(
                "{}:{}:{}",
                location.file(),
                location.line(),
                location.column()
            )
        })
        .unwrap_or_else(|| "unknown".to_string());
    writeln!(file, "--- mniu desktop panic ---").map_err(|error| error.to_string())?;
    writeln!(file, "unix_seconds={timestamp}").map_err(|error| error.to_string())?;
    writeln!(file, "thread={thread_name}").map_err(|error| error.to_string())?;
    writeln!(file, "location={location}").map_err(|error| error.to_string())?;
    writeln!(
        file,
        "message={}",
        sanitize_panic_message(&panic_message(info))
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn panic_log_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home)
        .join("Library")
        .join("Logs")
        .join("dev.muniu.desktop")
        .join("panic.log"))
}

fn panic_message(info: &std::panic::PanicHookInfo<'_>) -> String {
    if let Some(message) = info.payload().downcast_ref::<&str>() {
        return (*message).to_string();
    }
    if let Some(message) = info.payload().downcast_ref::<String>() {
        return message.clone();
    }
    "non-string panic payload".to_string()
}

fn sanitize_panic_message(message: &str) -> String {
    let normalized = message.replace('\r', "\\n").replace('\n', "\\n");
    let lower = normalized.to_ascii_lowercase();
    if ["api_key", "apikey", "bearer", "password", "secret", "token"]
        .iter()
        .any(|marker| lower.contains(marker))
    {
        return "[REDACTED: panic message contained sensitive marker]".to_string();
    }
    const MAX_PANIC_MESSAGE_CHARS: usize = 2048;
    if normalized.chars().count() > MAX_PANIC_MESSAGE_CHARS {
        return format!(
            "{}...[truncated]",
            normalized
                .chars()
                .take(MAX_PANIC_MESSAGE_CHARS)
                .collect::<String>()
        );
    }
    normalized
}

fn settings_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".mniu").join("settings.json"))
}

fn normalize_settings(mut settings: DesktopSettings) -> DesktopSettings {
    if !matches!(settings.theme.as_str(), "system" | "light" | "dark") {
        settings.theme = DesktopSettings::default().theme;
    }
    if !matches!(
        settings.close_behavior.as_str(),
        "quit" | "tray" | "lightweight"
    ) {
        settings.close_behavior = DesktopSettings::default().close_behavior;
    }
    if settings.api_url.trim().is_empty() {
        settings.api_url = DesktopSettings::default().api_url;
    }
    settings
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::tray::TrayIconBuilder;

    let menu = tray_menu(app, &[], &[], false)?;

    TrayIconBuilder::with_id("main")
        .tooltip("木牛")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let event_id = event.id().as_ref();
            match event_id {
                "open" => {
                    let _ = show_or_recreate_main_window(app);
                }
                "light_mode" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.destroy();
                    }
                }
                "refresh_providers" => {
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = refresh_tray_providers(&handle).await;
                    });
                }
                "toggle_proxy" => {
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = toggle_tray_proxy(&handle).await {
                            let _ = handle.emit("tray-action-error", error);
                        }
                    });
                }
                "quit" => app.exit(0),
                _ => {
                    if let Some((app_id, provider_id)) = parse_tray_provider_event(event_id) {
                        let app_id = app_id.to_string();
                        let provider_id = provider_id.to_string();
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(error) =
                                switch_tray_provider(&handle, &app_id, &provider_id).await
                            {
                                let _ = handle.emit("tray-provider-error", error);
                            }
                        });
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}

fn tray_menu(
    app: &impl Manager<tauri::Wry>,
    claude: &[TrayProvider],
    codex: &[TrayProvider],
    proxy_running: bool,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};

    fn provider_submenu(
        app: &impl Manager<tauri::Wry>,
        label: &str,
        app_id: &str,
        providers: &[TrayProvider],
    ) -> tauri::Result<Submenu<tauri::Wry>> {
        let mut items = Vec::new();
        if providers.is_empty() {
            items.push(MenuItem::with_id(
                app,
                format!("provider_empty:{app_id}"),
                "暂无 Provider",
                false,
                None::<&str>,
            )?);
        } else {
            for provider in providers {
                let state = if provider.enabled { "✓ " } else { "" };
                items.push(MenuItem::with_id(
                    app,
                    format!("provider:{app_id}:{}", provider.id),
                    format!("{state}{}", provider.name),
                    !provider.enabled,
                    None::<&str>,
                )?);
            }
        }
        let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = items
            .iter()
            .map(|item| item as &dyn IsMenuItem<tauri::Wry>)
            .collect();
        Submenu::with_items(app, label, true, &refs)
    }

    let claude_menu = provider_submenu(app, "Claude Code", "claude", claude)?;
    let codex_menu = provider_submenu(app, "Codex", "codex", codex)?;
    let refresh = MenuItem::with_id(
        app,
        "refresh_providers",
        "刷新 Provider",
        true,
        None::<&str>,
    )?;
    let proxy = MenuItem::with_id(
        app,
        "toggle_proxy",
        if proxy_running {
            "本地代理：停止"
        } else {
            "本地代理：启动"
        },
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let open = MenuItem::with_id(app, "open", "打开主界面", true, None::<&str>)?;
    let light_mode = MenuItem::with_id(app, "light_mode", "轻量模式", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &open,
            &claude_menu,
            &codex_menu,
            &refresh,
            &proxy,
            &separator,
            &light_mode,
            &quit,
        ],
    )
}

async fn refresh_tray_providers(app: &tauri::AppHandle) -> Result<(), String> {
    let api_url = desktop_api_url();
    let client = reqwest::Client::new();
    let claude = fetch_tray_providers(&client, &api_url, "claude")
        .await
        .map_err(|error| error.to_string())?;
    let codex = fetch_tray_providers(&client, &api_url, "codex")
        .await
        .map_err(|error| error.to_string())?;
    let proxy_running = fetch_tray_proxy_running(&client, &api_url)
        .await
        .map_err(|error| error.to_string())?;
    let menu = tray_menu(app, &claude, &codex, proxy_running).map_err(|error| error.to_string())?;
    let tray = app
        .tray_by_id("main")
        .ok_or_else(|| "main tray is missing".to_string())?;
    tray.set_menu(Some(menu)).map_err(|error| error.to_string())
}

async fn fetch_tray_proxy_running(
    client: &reqwest::Client,
    api_url: &str,
) -> Result<bool, reqwest::Error> {
    Ok(client
        .get(format!("{api_url}/v1/proxy/status"))
        .send()
        .await?
        .error_for_status()?
        .json::<TrayProxyStatus>()
        .await?
        .runtime
        .running)
}

async fn toggle_tray_proxy(app: &tauri::AppHandle) -> Result<(), String> {
    let api_url = desktop_api_url();
    let client = reqwest::Client::new();
    let running = fetch_tray_proxy_running(&client, &api_url)
        .await
        .map_err(|error| error.to_string())?;
    let action = if running { "stop" } else { "start" };
    client
        .post(format!("{api_url}/v1/proxy/{action}"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    refresh_tray_providers(app).await?;
    app.emit(
        "tray-proxy-changed",
        serde_json::json!({ "running": !running }),
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

async fn fetch_tray_providers(
    client: &reqwest::Client,
    api_url: &str,
    app_id: &str,
) -> Result<Vec<TrayProvider>, reqwest::Error> {
    Ok(client
        .get(format!("{api_url}/v1/providers?app={app_id}"))
        .send()
        .await?
        .error_for_status()?
        .json::<TrayProviderList>()
        .await?
        .providers)
}

async fn switch_tray_provider(
    app: &tauri::AppHandle,
    app_id: &str,
    provider_id: &str,
) -> Result<(), String> {
    let api_url = desktop_api_url();
    let client = reqwest::Client::new();
    request_tray_provider_switch(&client, &api_url, app_id, provider_id).await?;
    show_or_recreate_main_window(app)?;
    app.emit(
        "tray-provider-preview",
        serde_json::json!({ "app": app_id, "providerId": provider_id }),
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn parse_tray_provider_event(event_id: &str) -> Option<(&str, &str)> {
    let mut parts = event_id.split(':');
    if parts.next()? != "provider" {
        return None;
    }
    let app_id = parts.next()?;
    let provider_id = parts.next()?;
    if parts.next().is_some() || !matches!(app_id, "claude" | "codex") || provider_id.is_empty() {
        return None;
    }
    Some((app_id, provider_id))
}

async fn request_tray_provider_switch(
    client: &reqwest::Client,
    api_url: &str,
    app_id: &str,
    provider_id: &str,
) -> Result<(), String> {
    let url = format!("{api_url}/v1/providers/{provider_id}/enable");
    client
        .post(&url)
        .json(&serde_json::json!({ "app": app_id, "dryRun": true }))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn desktop_api_url() -> String {
    read_desktop_settings()
        .unwrap_or_default()
        .api_url
        .trim_end_matches('/')
        .to_string()
}

fn spawn_managed_daemon(
    app: &tauri::AppHandle,
) -> Result<Option<CommandChild>, Box<dyn std::error::Error>> {
    let settings = read_desktop_settings().unwrap_or_default();
    let api_url = reqwest::Url::parse(&settings.api_url)?;
    let host = api_url.host_str().unwrap_or("127.0.0.1");
    if !matches!(host, "127.0.0.1" | "localhost" | "::1") {
        return Ok(None);
    }
    let port = api_url.port_or_known_default().unwrap_or(7318).to_string();
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let mniu_root = PathBuf::from(&home).join(".mniu");
    fs::create_dir_all(&mniu_root)?;
    let (mut events, child) = app
        .shell()
        .sidecar("mn-api")?
        .current_dir(&mniu_root)
        .env("MN_API_HOST", "127.0.0.1")
        .env("MN_API_PORT", &port)
        .env("MN_MNIU_ROOT", mniu_root.as_os_str())
        .env(
            "MN_API_STATE_PATH",
            mniu_root.join("api-state.json").as_os_str(),
        )
        .env("MN_WORKSPACE_ROOT", mniu_root.join("worktrees").as_os_str())
        .env("MN_DESKTOP_PACKAGED", "1")
        .env("MN_DESKTOP_PARENT_PID", std::process::id().to_string())
        .spawn()?;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let _ = handle.emit("daemon-log", String::from_utf8_lossy(&line).to_string());
                }
                CommandEvent::Stderr(line) => {
                    let _ = handle.emit("daemon-log", String::from_utf8_lossy(&line).to_string());
                }
                CommandEvent::Terminated(status) => {
                    let _ = handle.emit(
                        "daemon-status",
                        serde_json::json!({ "running": false, "code": status.code }),
                    );
                }
                _ => {}
            }
        }
    });
    Ok(Some(child))
}

fn show_or_recreate_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let config = app.config();
    let window_config = config
        .app
        .windows
        .first()
        .ok_or_else(|| "main window config is missing".to_string())?;
    let window = tauri::WebviewWindowBuilder::from_config(app, window_config)
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{parse_tray_provider_event, request_tray_provider_switch};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn tray_provider_event_parser_rejects_invalid_targets() {
        assert_eq!(
            parse_tray_provider_event("provider:claude:p-1"),
            Some(("claude", "p-1"))
        );
        assert_eq!(
            parse_tray_provider_event("provider:codex:p-2"),
            Some(("codex", "p-2"))
        );
        assert_eq!(parse_tray_provider_event("provider:other:p-3"), None);
        assert_eq!(parse_tray_provider_event("provider:codex:"), None);
        assert_eq!(parse_tray_provider_event("provider:codex:p-2:extra"), None);
        assert_eq!(parse_tray_provider_event("refresh_providers"), None);
    }

    #[test]
    fn tray_provider_switch_only_runs_preview() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock provider server");
        let address = listener.local_addr().expect("read mock server address");
        let server = thread::spawn(move || {
            let mut requests = Vec::new();
            for _ in 0..1 {
                let (mut stream, _) = listener.accept().expect("accept provider request");
                let mut bytes = Vec::new();
                let mut buffer = [0_u8; 2048];
                loop {
                    let read = stream.read(&mut buffer).expect("read provider request");
                    if read == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..read]);
                    let text = String::from_utf8_lossy(&bytes);
                    if let Some(header_end) = text.find("\r\n\r\n") {
                        let content_length = text[..header_end]
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|value| value.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= header_end + 4 + content_length {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(bytes).expect("valid HTTP request"));
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
                    )
                    .expect("write provider response");
            }
            requests
        });

        tauri::async_runtime::block_on(request_tray_provider_switch(
            &reqwest::Client::new(),
            &format!("http://{address}"),
            "codex",
            "provider-1",
        ))
        .expect("switch provider through tray request flow");

        let requests = server.join().expect("join mock provider server");
        assert!(requests[0].starts_with("POST /v1/providers/provider-1/enable HTTP/1.1"));
        assert!(requests[0].contains(r#"{"app":"codex","dryRun":true}"#));
        assert_eq!(requests.len(), 1);
    }
}
