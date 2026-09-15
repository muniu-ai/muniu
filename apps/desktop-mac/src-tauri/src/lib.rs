use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

const HOST_ADDRESS: &str = "127.0.0.1";
const HOST_PORT: u16 = 7318;

struct ManagedHost(Mutex<Option<CommandChild>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopRuntimeStatus {
    runtime: &'static str,
    platform: &'static str,
    agent_os: &'static str,
    state_generation: &'static str,
    host_managed: bool,
}

#[derive(Clone, Deserialize, Serialize, Debug, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
struct DesktopSettings {
    theme: String,
    close_behavior: String,
    launch_at_login: bool,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            close_behavior: "tray".to_string(),
            launch_at_login: false,
        }
    }
}

#[tauri::command]
fn desktop_runtime_status(app: tauri::AppHandle) -> DesktopRuntimeStatus {
    let host_managed = app
        .state::<ManagedHost>()
        .0
        .lock()
        .map(|child| child.is_some())
        .unwrap_or(false);
    DesktopRuntimeStatus {
        runtime: "Tauri 2",
        platform: "macOS-first",
        agent_os: "0.2",
        state_generation: "v2",
        host_managed,
    }
}

#[tauri::command]
fn read_desktop_settings(app: tauri::AppHandle) -> Result<DesktopSettings, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(DesktopSettings::default());
    }
    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str::<DesktopSettings>(&raw)
        .map(normalize_settings)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn write_desktop_settings(
    app: tauri::AppHandle,
    settings: DesktopSettings,
) -> Result<DesktopSettings, String> {
    let path = settings_path(&app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "设置文件路径无效".to_string())?;
    create_private_state_directory(parent).map_err(|error| error.to_string())?;
    let normalized = normalize_settings(settings);
    let raw = serde_json::to_vec_pretty(&normalized).map_err(|error| error.to_string())?;
    write_private_atomic(&path, &raw)?;
    Ok(normalized)
}

fn validate_export(file_name: &str, content: &str) -> Result<(), String> {
    if file_name.is_empty()
        || file_name.len() > 240
        || !file_name.ends_with(".json")
        || file_name.starts_with('.')
        || file_name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err("请使用不含路径的 JSON 文件名".to_string());
    }
    if content.len() > 20 * 1024 * 1024 {
        return Err("成果文件超过 20 MiB".to_string());
    }
    serde_json::from_str::<serde_json::Value>(content)
        .map(|_| ())
        .map_err(|_| "成果不是有效 JSON".to_string())
}

fn write_new_export(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("保存位置必须是绝对路径".to_string());
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("文件名无效")?;
    let content = std::str::from_utf8(bytes).map_err(|_| "成果不是 UTF-8 文本")?;
    validate_export(name, content)?;
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "文件已存在或目录不可写，请选择新的文件名".to_string())?;
    if file.write_all(bytes).and_then(|_| file.sync_all()).is_err() {
        drop(file);
        return Err(if fs::remove_file(path).is_ok() {
            "成果写入失败，本次未完成的文件已清理"
        } else {
            "成果写入失败，请检查并清理本次未完成的文件"
        }
        .to_string());
    }
    let parent = path.parent().ok_or("保存目录无效")?;
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "文件已写入，但目录同步失败，请核对文件".to_string())
}

#[tauri::command]
async fn save_json_export(
    app: tauri::AppHandle,
    file_name: String,
    content: String,
) -> Result<bool, String> {
    validate_export(&file_name, &content)?;
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("保存机会成果")
            .set_file_name(&file_name)
            .add_filter("JSON 成果", &["json"])
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(false);
        };
        let path = selected
            .into_path()
            .map_err(|_| "保存位置不是本地文件".to_string())?;
        write_new_export(&path, content.as_bytes())?;
        Ok(true)
    })
    .await
    .map_err(|_| "文件保存任务未完成".to_string())?
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("木牛")
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if host_port_is_occupied() {
                app.dialog()
                    .message("检测到另一个木牛后台进程。请先退出旧版木牛，再重新打开 0.2。")
                    .title("木牛无法启动")
                    .kind(MessageDialogKind::Warning)
                    .blocking_show();
                return Err("another daemon is already listening on port 7318".into());
            }

            let host = spawn_managed_host(app.handle())?;
            app.manage(ManagedHost(Mutex::new(Some(host))));
            build_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_runtime_status,
            read_desktop_settings,
            write_desktop_settings,
            save_json_export
        ])
        .build(tauri::generate_context!())
        .expect("failed to build 木牛 desktop");

    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            stop_managed_host(handle);
        }
    });
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;

    let open = MenuItem::with_id(app, "open", "打开木牛", true, None::<&str>)?;
    let inbox = MenuItem::with_id(app, "inbox", "收件箱", true, None::<&str>)?;
    let capture = MenuItem::with_id(app, "capture", "快速记录", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &inbox, &capture, &separator, &quit])?;

    TrayIconBuilder::with_id("main")
        .tooltip("木牛 Agent OS")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                let _ = show_main_window(app);
            }
            "inbox" => {
                let _ = show_main_window(app);
                let _ = app.emit("desktop:navigate", "inbox");
            }
            "capture" => {
                let _ = show_main_window(app);
                let _ = app.emit("desktop:quick-capture", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不可用".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

fn spawn_managed_host(app: &tauri::AppHandle) -> Result<CommandChild, Box<dyn std::error::Error>> {
    let state_root = v2_state_root(app)?;
    create_private_state_directory(&state_root)?;
    let (mut events, child) = app
        .shell()
        .sidecar("mn-host")?
        .current_dir(&state_root)
        .env("MN_HOST_ADDRESS", HOST_ADDRESS)
        .env("MN_HOST_PORT", HOST_PORT.to_string())
        .env("MN_V2_STATE_ROOT", state_root.as_os_str())
        .env("MN_DESKTOP_PARENT_PID", std::process::id().to_string())
        .spawn()?;

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Terminated(status) => {
                    let _ = handle.emit(
                        "desktop:host-status",
                        serde_json::json!({ "running": false, "code": status.code }),
                    );
                }
                CommandEvent::Error(error) => {
                    let _ = handle.emit(
                        "desktop:host-status",
                        serde_json::json!({ "running": false, "message": redact_message(&error) }),
                    );
                }
                CommandEvent::Stdout(_) | CommandEvent::Stderr(_) => {}
                _ => {}
            }
        }
    });

    Ok(child)
}

fn stop_managed_host(app: &tauri::AppHandle) {
    if let Ok(mut child) = app.state::<ManagedHost>().0.lock() {
        if let Some(child) = child.take() {
            let _ = child.kill();
        }
    }
}

fn v2_state_root(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(v2_state_root_from_home(&app.path().home_dir()?))
}

fn v2_state_root_from_home(home: &Path) -> PathBuf {
    home.join(".muniu").join("v2")
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    v2_state_root(app)
        .map(|root| root.join("desktop-settings.json"))
        .map_err(|error| error.to_string())
}

fn normalize_settings(mut settings: DesktopSettings) -> DesktopSettings {
    if !matches!(settings.theme.as_str(), "system" | "light" | "dark") {
        settings.theme = DesktopSettings::default().theme;
    }
    if !matches!(settings.close_behavior.as_str(), "quit" | "tray") {
        settings.close_behavior = DesktopSettings::default().close_behavior;
    }
    settings
}

fn host_port_is_occupied() -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], HOST_PORT));
    TcpStream::connect_timeout(&address, Duration::from_millis(180)).is_ok()
}

fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn create_private_state_directory(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "v2 状态目录必须是权限为 0700 的普通目录，不能使用符号链接",
        ));
    }
    Ok(())
}

fn redact_message(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if ["api_key", "apikey", "bearer", "password", "secret", "token"]
        .iter()
        .any(|marker| lower.contains(marker))
    {
        return "mn-host 运行失败，错误详情中的敏感信息已隐藏".to_string();
    }
    message.chars().take(512).collect()
}

#[cfg(test)]
mod tests {
    use super::{normalize_settings, redact_message, v2_state_root_from_home, DesktopSettings};

    #[test]
    fn native_state_directory_is_private_and_rejects_symlinks() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = std::env::temp_dir().join(format!(
            "mn-native-state-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let state = root.join("v2");
        super::create_private_state_directory(&state).unwrap();
        assert_eq!(
            std::fs::metadata(&state).unwrap().permissions().mode() & 0o077,
            0
        );
        symlink(&state, root.join("alias")).unwrap();
        assert!(super::create_private_state_directory(&root.join("alias")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    use std::path::Path;

    #[test]
    fn export_rejects_paths_invalid_json_and_oversized_content() {
        for name in [
            "../result.json",
            "/tmp/result.json",
            "result.exe",
            "bad\nname.json",
        ] {
            assert!(super::validate_export(name, "{}").is_err());
        }
        assert!(super::validate_export("成果.json", "not json").is_err());
        assert!(super::validate_export("成果.json", &" ".repeat(20 * 1024 * 1024 + 1)).is_err());
        assert!(super::validate_export("机会成果.json", "{\"schemaVersion\":1}").is_ok());
    }

    #[test]
    fn export_creates_private_file_without_overwriting_existing_or_symlink_targets() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = std::env::temp_dir().join(format!(
            "muniu-export-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("成果.json");
        super::write_new_export(&path, b"{\"result\":1}").unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(super::write_new_export(&path, b"{}").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"result\":1}");
        let link = root.join("link.json");
        symlink(&path, &link).unwrap();
        assert!(super::write_new_export(&link, b"{}").is_err());
        assert!(super::write_new_export(&root.join("script.sh"), b"{}").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn v2_state_is_isolated_from_every_legacy_path() {
        assert_eq!(
            v2_state_root_from_home(Path::new("/Users/test")),
            Path::new("/Users/test/.muniu/v2")
        );
    }

    #[test]
    fn settings_reject_hidden_legacy_modes() {
        assert_eq!(
            normalize_settings(DesktopSettings {
                theme: "neon".to_string(),
                close_behavior: "lightweight".to_string(),
                launch_at_login: true,
            }),
            DesktopSettings {
                theme: "system".to_string(),
                close_behavior: "tray".to_string(),
                launch_at_login: true,
            }
        );
    }

    #[test]
    fn host_errors_are_redacted_before_the_webview_sees_them() {
        assert_eq!(
            redact_message("request failed with bearer token"),
            "mn-host 运行失败，错误详情中的敏感信息已隐藏"
        );
        assert_eq!(
            redact_message("address already in use"),
            "address already in use"
        );
    }
}
