#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod host;
mod native;

use host::Host;
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewUrl, WebviewWindowBuilder,
};

struct Desktop {
    host: Arc<Host>,
    data_directory: PathBuf,
    quitting: AtomicBool,
}

fn notify_host(app: &tauri::AppHandle, action: &'static str) {
    if let Some(state) = app.try_state::<Desktop>() {
        let host = state.host.clone();
        std::thread::spawn(move || {
            let _ = host.request(action, Value::Null);
        });
    }
}

fn show_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.unminimize()?;
        window.show()?;
        notify_host(app, "resume");
        return window.set_focus();
    }
    let data = app.state::<Desktop>().data_directory.join("webview");
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .data_directory(data)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .title("Rewards Desktop")
        .inner_size(1120.0, 800.0)
        .min_inner_size(820.0, 600.0)
        .on_navigation(|url| {
            url.port().is_none()
                && url.username().is_empty()
                && url.password().is_none()
                && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                    || (matches!(url.scheme(), "http" | "https")
                        && url.host_str() == Some("tauri.localhost")))
        })
        .build()?;
    notify_host(app, "resume");
    Ok(())
}

const ACTIONS: &[&str] = &[
    "snapshot",
    "detectBrowser",
    "downloadChrome",
    "downloadEdge",
    "checkUpdate",
    "downloadUpdate",
    "showUpdateFile",
    "start",
    "stop",
    "login",
    "cancelLogin",
    "refreshBalance",
    "saveSettings",
    "restartBackend",
    "openDataDirectory",
    "exportDiagnostics",
    "clearData",
    "quit",
];

fn validate_action(action: &str, value: &Value) -> Result<(), String> {
    if !ACTIONS.contains(&action) {
        return Err("不支持的操作".into());
    }
    if action != "saveSettings" && !value.is_null() {
        return Err("此操作不接受参数".into());
    }
    Ok(())
}

#[tauri::command]
async fn desktop_invoke(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    action: String,
    value: Option<Value>,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("不允许的调用来源".into());
    }
    let value = value.unwrap_or(Value::Null);
    validate_action(&action, &value)?;
    if action == "quit" {
        app.exit(0);
        return Ok(Value::Null);
    }
    let host = app.state::<Desktop>().host.clone();
    tauri::async_runtime::spawn_blocking(move || host.request(&action, value))
        .await
        .map_err(|e| e.to_string())?
}

fn main() {
    let mut context = tauri::generate_context!();
    if let Some(data) =
        std::env::args().find_map(|arg| arg.strip_prefix("--user-data-dir=").map(str::to_owned))
    {
        use std::hash::{DefaultHasher, Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        data.replace('/', "\\").to_lowercase().hash(&mut hasher);
        context
            .config_mut()
            .identifier
            .push_str(&format!(".isolated{:x}", hasher.finish()));
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let _ = show_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![desktop_invoke])
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                notify_host(window.app_handle(), "suspend");
            }
        })
        .setup(|app| {
            let custom = std::env::args()
                .find_map(|arg| arg.strip_prefix("--user-data-dir=").map(PathBuf::from));
            let data = match &custom {
                Some(path) if path.is_absolute() => path.clone(),
                Some(_) => return Err("--user-data-dir 必须是绝对路径".into()),
                // Electron app.getPath('userData') used Roaming/Rewards Desktop.
                None => app.path().config_dir()?.join("Rewards Desktop"),
            };
            std::fs::create_dir_all(&data)?;
            let resources = if cfg!(dev) {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../..")
                    .canonicalize()?
            } else {
                app.path().resource_dir()?.join("backend")
            };
            let host = Host::start(app.handle().clone(), &resources, &data, custom.is_some())?;
            app.manage(Desktop {
                host,
                data_directory: data,
                quitting: AtomicBool::new(false),
            });
            let show = MenuItem::with_id(app, "show", "打开应用", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出并停止任务", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().ok_or("缺少应用图标")?.clone())
                .tooltip("Rewards Desktop · 关闭窗口后继续运行")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        let _ = show_window(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        let _ = show_window(tray.app_handle());
                    }
                })
                .build(app)?;
            if !std::env::args().any(|arg| arg == "--start-in-tray") {
                show_window(app.handle())?;
            }
            Ok(())
        })
        .build(context);
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            let message = format!("Rewards Desktop 无法启动：{error}");
            eprintln!("{message}");
            // Isolated runs must fail with diagnostics rather than wait on a modal dialog.
            #[cfg(windows)]
            if !std::env::args().any(|arg| arg.starts_with("--user-data-dir=")) {
                unsafe {
                    use windows_sys::Win32::UI::WindowsAndMessaging::{
                        MessageBoxW, MB_ICONERROR, MB_OK,
                    };
                    let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
                    let title: Vec<u16> = "Rewards Desktop".encode_utf16().chain(Some(0)).collect();
                    MessageBoxW(
                        std::ptr::null_mut(),
                        text.as_ptr(),
                        title.as_ptr(),
                        MB_OK | MB_ICONERROR,
                    );
                }
            }
            std::process::exit(1);
        }
    };
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none() {
                api.prevent_exit();
                return;
            }
            if let Some(state) = app.try_state::<Desktop>() {
                if !state.quitting.swap(true, Ordering::SeqCst) {
                    api.prevent_exit();
                    let host = state.host.clone();
                    let app = app.clone();
                    std::thread::spawn(move || {
                        host.shutdown();
                        app.exit(0);
                    });
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn balance_refresh_accepts_no_arguments() {
        assert!(validate_action("refreshBalance", &Value::Null).is_ok());
        assert_eq!(
            validate_action("refreshBalance", &serde_json::json!({ "account": "other" })),
            Err("此操作不接受参数".into())
        );
    }

    #[test]
    fn commands_reject_unknown_actions_and_unexpected_arguments() {
        assert!(validate_action("login", &Value::Null).is_ok());
        assert!(validate_action("login", &Value::String("account".into())).is_err());
        assert!(validate_action("shutdown", &Value::Null).is_err());
        assert!(validate_action("resume", &Value::Null).is_err());
        assert!(validate_action("openDirectory", &Value::Null).is_err());
    }
}
