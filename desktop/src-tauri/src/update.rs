use std::path::{Path, PathBuf};

const HELPER_FLAG: &str = "--rewards-update-helper";

fn valid_installer(name: &str) -> bool {
    let Some(version) = name
        .strip_prefix("Rewards-Desktop-")
        .and_then(|name| name.strip_suffix("-x64.exe"))
    else {
        return false;
    };
    let parts: Vec<_> = version.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0'))
        })
}

pub fn destination(cache: &Path, name: &str) -> Result<PathBuf, String> {
    if !valid_installer(name) {
        return Err("无效的安装包文件名".into());
    }
    std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    // Successful helpers cannot delete their own running EXE; reclaim them next time.
    if let Ok(entries) = std::fs::read_dir(cache) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|kind| kind.is_dir())
                && entry.path().join("completed").is_file()
            {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    // A separate directory prevents a retry/check from overwriting an active helper.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let directory = cache.join(format!("{}-{nonce}", std::process::id()));
    std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
    Ok(directory.join(name))
}

#[cfg(windows)]
pub fn installed_executable() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let location = windows_registry::CURRENT_USER
        .open(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Rewards Desktop")
        .and_then(|key| key.get_string("InstallLocation"))
        .map_err(|_| "自动更新仅支持当前用户安装版；便携版请下载新版 ZIP".to_string())?;
    let installed = Path::new(location.trim_matches('"'))
        .join("Rewards Desktop.exe")
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if installed != executable.canonicalize().map_err(|e| e.to_string())? {
        return Err("当前运行目录与安装记录不一致，请使用安装版更新".into());
    }
    Ok(executable)
}

#[cfg(not(windows))]
pub fn installed_executable() -> Result<PathBuf, String> {
    Err("自动更新仅支持 Windows".into())
}

pub fn prepare(cache: &Path, installer: &str, executable: &Path) -> Result<(), String> {
    let installer = Path::new(installer)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let root = cache.canonicalize().map_err(|e| e.to_string())?;
    if !installer.starts_with(&root)
        || !installer.is_file()
        || !installer
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(valid_installer)
    {
        return Err("安装包不在更新缓存目录中".into());
    }
    start_helper(&installer, executable)
}

#[cfg(not(windows))]
fn start_helper(_installer: &Path, _executable: &Path) -> Result<(), String> {
    Err("自动更新仅支持 Windows".into())
}

#[cfg(windows)]
fn start_helper(installer: &Path, executable: &Path) -> Result<(), String> {
    use std::{
        os::windows::process::CommandExt,
        process::Command,
        time::{Duration, Instant},
    };
    let directory = installer.parent().ok_or("缺少更新目录")?;
    let helper = directory.join("update-helper.exe");
    let ready = directory.join("ready");
    let _ = std::fs::remove_file(&ready);
    std::fs::copy(executable, &helper).map_err(|e| e.to_string())?;
    // GNU Windows builds import this loader DLL before entering helper mode.
    // MSVC builds normally link it statically and have no sidecar to copy.
    let loader = executable
        .parent()
        .ok_or("缺少应用目录")?
        .join("WebView2Loader.dll");
    if loader.is_file() {
        std::fs::copy(&loader, directory.join("WebView2Loader.dll"))
            .map_err(|e| format!("无法准备更新辅助程序的 WebView2 加载库：{e}"))?;
    }

    let mut child = Command::new(&helper)
        .arg(HELPER_FLAG)
        .arg(std::process::id().to_string())
        .arg(installer)
        .arg(executable)
        .current_dir(directory)
        .creation_flags(0x08000000) // Outside the backend's kill-on-close job.
        .spawn()
        .map_err(|e| format!("无法启动更新安装程序：{e}"))?;
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        if ready.is_file() {
            return Ok(());
        }
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            return Err("更新辅助程序启动失败，请检查更新缓存中的 update-error.txt".into());
        }
        if Instant::now() >= until {
            let _ = child.kill();
            let _ = child.wait();
            return Err("更新辅助程序启动超时，可重试安装".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

// This mode runs from a cache copy, before Tauri/Node/single-instance initialization.
pub fn run_helper() -> bool {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).is_none_or(|arg| arg != HELPER_FLAG) {
        return false;
    }
    #[cfg(windows)]
    if let Err(error) = helper(&args) {
        if let Ok(executable) = std::env::current_exe() {
            if let Some(directory) = executable.parent() {
                let _ = std::fs::write(directory.join("update-error.txt"), &error);
            }
        }
        // The application has already exited; report failure without silently disappearing.
        unsafe {
            use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
            let message =
                format!("更新未完成：{error}\n请重新打开应用重试，或从发布页下载安装包。");
            let message: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
            let title: Vec<u16> = "Rewards Desktop 更新失败"
                .encode_utf16()
                .chain(Some(0))
                .collect();
            MessageBoxW(
                std::ptr::null_mut(),
                message.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }
    true
}

#[cfg(windows)]
pub(crate) fn helper(args: &[std::ffi::OsString]) -> Result<(), String> {
    use std::{os::windows::process::CommandExt, process::Command};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_OBJECT_0},
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    if args.len() != 5 {
        return Err("无效的更新辅助程序参数".into());
    }
    let pid = args[2]
        .to_str()
        .and_then(|s| s.parse::<u32>().ok())
        .ok_or("无效进程编号")?;
    let installer = Path::new(&args[3]);
    let executable = Path::new(&args[4]);
    if !installer.is_absolute()
        || !installer.is_file()
        || !executable.is_absolute()
        || !executable.is_file()
    {
        return Err("缺少更新安装包或应用程序".into());
    }
    let directory = installer.parent().ok_or("缺少更新目录")?.to_owned();
    // Hold a real process handle before acknowledging readiness, avoiding PID reuse.
    let parent = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if parent.is_null() {
        return Err(format!(
            "无法等待应用退出：{}",
            std::io::Error::last_os_error()
        ));
    }
    let ready = std::fs::write(directory.join("ready"), b"ready");
    if let Err(error) = ready {
        unsafe {
            CloseHandle(parent);
        }
        return Err(error.to_string());
    }
    let result = unsafe { WaitForSingleObject(parent, 90_000) };
    unsafe {
        CloseHandle(parent);
    }
    if result != WAIT_OBJECT_0 {
        return Err("应用未在 90 秒内退出，未执行安装".into());
    }
    let install_directory = executable.parent().ok_or("缺少安装目录")?;
    // /D must be last and unquoted, including directories containing spaces.
    // /UPDATE preserves data/shortcuts. Restart explicitly after checking the exit code.
    let mut target = std::ffi::OsString::from("/D=");
    target.push(install_directory);
    let status = Command::new(installer)
        .args(["/S", "/UPDATE"])
        .raw_arg(target)
        .current_dir(&directory)
        .status()
        .map_err(|e| format!("无法运行安装包：{e}"))?;
    if !status.success() {
        return Err(format!(
            "安装程序退出码：{:?}；安装包保留在 {}",
            status.code(),
            installer.display()
        ));
    }
    Command::new(executable)
        .current_dir(install_directory)
        .spawn()
        .map_err(|e| format!("安装完成，但无法重新启动应用：{e}"))?;
    let _ = std::fs::remove_file(installer);
    let _ = std::fs::remove_file(directory.join("ready"));
    let _ = std::fs::remove_file(directory.join("update-error.txt"));
    let _ = std::fs::write(directory.join("completed"), b"completed");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_release_installer_names() {
        assert!(valid_installer("Rewards-Desktop-0.2.10-x64.exe"));
        for name in [
            "../Rewards-Desktop-0.2.0-x64.exe",
            "Rewards-Desktop-01.2.0-x64.exe",
            "Rewards-Desktop-0.2-x64.exe",
            "Rewards-Desktop-0.2.0-x64.exe /S",
            "evil.exe",
        ] {
            assert!(!valid_installer(name), "{name}");
        }
    }
    #[test]
    fn refuses_installers_outside_cache() {
        let cache =
            std::env::temp_dir().join(format!("rewards-update-native-{}", std::process::id()));
        std::fs::create_dir_all(&cache).unwrap();
        let installer = cache.join("Rewards-Desktop-0.2.0-x64.exe");
        std::fs::write(&installer, b"test").unwrap();
        let result = prepare(
            &cache.join("missing"),
            installer.to_str().unwrap(),
            &installer,
        );
        assert!(result.is_err());
        let nested = cache.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(
            prepare(&nested, installer.to_str().unwrap(), &installer),
            Err("安装包不在更新缓存目录中".into())
        );
        std::fs::remove_dir_all(cache).unwrap();
    }
    #[test]
    fn cache_destinations_are_unique_and_reclaim_only_completed_updates() {
        let root =
            std::env::temp_dir().join(format!("rewards-update-cache-{}", std::process::id()));
        let name = "Rewards-Desktop-0.2.0-x64.exe";
        let first = destination(&root, name).unwrap();
        std::fs::write(first.parent().unwrap().join("completed"), b"done").unwrap();
        let failed = root.join("failed");
        std::fs::create_dir_all(&failed).unwrap();
        std::fs::write(failed.join("update-error.txt"), b"keep").unwrap();
        let second = destination(&root, name).unwrap();
        assert_ne!(first, second);
        assert!(!first.parent().unwrap().exists());
        assert!(failed.join("update-error.txt").is_file());
        assert!(destination(&root, "../bad.exe").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn installer_launch_failure_returns_error_without_attempting_restart() {
        use std::{ffi::OsString, process::Command};
        let root =
            std::env::temp_dir().join(format!("rewards-failed-update-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let executable = root.join("must-not-restart.exe");
        std::fs::write(&executable, b"not executable").unwrap();
        let shell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut parent = Command::new(shell)
            .args(["-NoProfile", "-Command", "Start-Sleep -Milliseconds 500"])
            .spawn()
            .unwrap();
        let installer = root.join("invalid-installer.exe");
        std::fs::write(&installer, b"not executable").unwrap();
        let args = vec![
            OsString::new(),
            HELPER_FLAG.into(),
            parent.id().to_string().into(),
            installer.clone().into_os_string(),
            executable.into_os_string(),
        ];
        let error = helper(&args).unwrap_err();
        assert!(error.starts_with("无法运行安装包："), "{error}");
        assert!(parent.wait().unwrap().success());
        let _ = std::fs::remove_file(root.join("ready"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
