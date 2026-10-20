use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

// Only the bundled Node host can send these requests over its private pipe.
pub fn invoke(app: &AppHandle, custom: bool, request: &Value) -> Result<Value, String> {
    let value = &request["value"];
    match request["action"].as_str().unwrap_or_default() {
        "setAutoStart" | "syncAutoStart" => {
            let enabled = value.as_bool().ok_or("无效的开机启动设置")?;
            if custom || cfg!(dev) || !cfg!(windows) {
                if enabled && request["action"] == "setAutoStart" {
                    return Err("仅正式安装的 Windows 应用支持开机启动，隔离目录不可启用".into());
                }
            } else {
                set_autostart(enabled)?;
            }
            Ok(Value::Null)
        }
        "saveFile" => {
            let name = value["name"].as_str().ok_or("缺少文件名")?;
            let installer = value["kind"] == "installer";
            let (title, extension) = if installer {
                ("下载新版安装包", "exe")
            } else {
                ("导出脱敏诊断", "txt")
            };
            let file = app
                .dialog()
                .file()
                .set_title(title)
                .set_file_name(name)
                .add_filter(
                    if installer {
                        "Windows 安装包"
                    } else {
                        "Text"
                    },
                    &[extension],
                )
                .blocking_save_file();
            match file {
                Some(file) => Ok(json!(file.into_path().map_err(|e| e.to_string())?)),
                None => Ok(Value::Null),
            }
        }
        "confirmClear" => Ok(json!(app
            .dialog()
            .message("清除账号、登录会话、设置、报告和日志？请先停止任务。清除后需要重新登录。")
            .title("清除本地数据")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "清除本地数据".into(),
                "取消".into()
            ))
            .blocking_show())),
        "openDirectory" => {
            app.opener()
                .open_path(value.as_str().ok_or("缺少目录")?, None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "revealFile" => {
            app.opener()
                .reveal_item_in_dir(value.as_str().ok_or("缺少文件")?)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        _ => Err("不支持的原生操作".into()),
    }
}

#[cfg(windows)]
fn set_autostart(enabled: bool) -> Result<(), String> {
    // Preserve Electron's registry value name and quote paths containing spaces.
    const NAME: &str = "org.microsoftrewardsscript.desktop";
    let key = windows_registry::CURRENT_USER
        .create(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Run")
        .map_err(|e| e.to_string())?;
    if enabled {
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        key.set_string(NAME, startup_command(&executable))
            .map_err(|e| e.to_string())?;
    } else if let Err(error) = key.remove_value(NAME) {
        if error.code().0 != 0x80070002u32 as i32 {
            return Err(error.to_string());
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn set_autostart(_enabled: bool) -> Result<(), String> {
    Err("开机启动仅支持 Windows".into())
}

#[cfg(windows)]
fn startup_command(executable: &std::path::Path) -> String {
    format!("\"{}\" --start-in-tray", executable.display())
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn startup_command_keeps_paths_with_spaces_quoted() {
        let path = std::path::Path::new(r"C:\Program Files\Rewards Desktop\Rewards Desktop.exe");
        assert_eq!(
            super::startup_command(path),
            r#""C:\Program Files\Rewards Desktop\Rewards Desktop.exe" --start-in-tray"#
        );
    }
}
