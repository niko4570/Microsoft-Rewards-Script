// Standalone Windows integration harness. Uses fake installer/application copies;
// never installs a release, touches the registry, or starts the real desktop app.
#[path = "../src-tauri/src/update.rs"]
mod update;
use std::{
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

fn wait_for(file: &Path) {
    let until = Instant::now() + Duration::from_secs(20);
    while !file.is_file() {
        assert!(
            Instant::now() < until,
            "Timed out waiting for {}",
            file.display()
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(windows)]
fn main() {
    if update::run_helper() {
        return;
    }
    let args: Vec<_> = std::env::args_os().collect();
    let exe = std::env::current_exe().unwrap();
    if args.get(1).is_some_and(|arg| arg == "/S") {
        let root = exe.parent().unwrap().parent().unwrap();
        assert!(
            root.join("parent-exited").is_file(),
            "Installer ran before parent exit"
        );
        if root.join("fail-install").exists() {
            std::process::exit(23);
        }
        let install = root.join("安装 directory with spaces");
        assert_eq!(args[2], "/UPDATE");
        // NSIS reads the final /D from the raw command line without quotes.
        // Rust's argv parser splits spaces; reconstruct the fixture's single-spaced path.
        let target = args[3..]
            .iter()
            .map(|arg| arg.to_str().unwrap())
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(target, format!("/D={}", install.display()));
        std::fs::write(root.join("installed"), b"installed").unwrap();
        return;
    }
    if exe.file_name().unwrap() == "Rewards Desktop.exe" {
        let root = exe.parent().unwrap().parent().unwrap();
        assert!(root.join("installed").is_file());
        std::fs::write(root.join("restarted"), b"restarted").unwrap();
        return;
    }
    if args.get(1).is_some_and(|arg| arg == "--failure-parent") {
        std::thread::sleep(Duration::from_millis(300));
        return;
    }
    if args.get(1).is_some_and(|arg| arg == "--parent") {
        let root = Path::new(&args[2]);
        let cache = root.join("cache");
        update::prepare(
            &cache,
            cache
                .join("Rewards-Desktop-0.2.0-x64.exe")
                .to_str()
                .unwrap(),
            &root.join("安装 directory with spaces/Rewards Desktop.exe"),
        )
        .unwrap();
        assert!(!root.join("installed").exists());
        assert_eq!(
            std::fs::read(cache.join("WebView2Loader.dll")).unwrap(),
            b"fixture loader"
        );
        std::thread::sleep(Duration::from_millis(300));
        assert!(!root.join("installed").exists());
        std::fs::write(root.join("parent-exited"), b"exiting").unwrap();
        return;
    }
    let root = std::env::temp_dir().join(format!("Rewards update smoke {}", std::process::id()));
    let install = root.join("安装 directory with spaces");
    let cache = root.join("cache");
    std::fs::create_dir_all(&install).unwrap();
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::copy(&exe, install.join("Rewards Desktop.exe")).unwrap();
    std::fs::write(install.join("WebView2Loader.dll"), b"fixture loader").unwrap();
    std::fs::copy(&exe, cache.join("Rewards-Desktop-0.2.0-x64.exe")).unwrap();
    let mut parent = Command::new(&exe)
        .arg("--parent")
        .arg(&root)
        .spawn()
        .unwrap();
    assert!(parent.wait().unwrap().success());
    wait_for(&root.join("restarted"));
    wait_for(&cache.join("completed"));
    assert!(!cache.join("Rewards-Desktop-0.2.0-x64.exe").exists());
    // A real nonzero installer exit must not launch the application.
    std::fs::remove_file(root.join("restarted")).unwrap();
    std::fs::write(root.join("fail-install"), b"fail").unwrap();
    let installer = cache.join("Rewards-Desktop-0.2.0-x64.exe");
    std::fs::copy(&exe, &installer).unwrap();
    let mut parent = Command::new(&exe).arg("--failure-parent").spawn().unwrap();
    let args = vec![
        std::ffi::OsString::new(),
        "--rewards-update-helper".into(),
        parent.id().to_string().into(),
        installer.into_os_string(),
        install.join("Rewards Desktop.exe").into_os_string(),
    ];
    let error = update::helper(&args).unwrap_err();
    assert!(error.starts_with("安装程序退出码：Some(23)"), "{error}");
    assert!(parent.wait().unwrap().success());
    assert!(!root.join("restarted").exists());
    // Wait briefly for the helper EXE to unlock before reclaiming the smoke directory.
    for _ in 0..40 {
        if std::fs::remove_dir_all(&root).is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!root.exists());
    println!("PASS: helper handshake, parent exit wait, /S /UPDATE, Unicode/spaced /D, restart, nonzero failure and cleanup");
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Update helper smoke requires Windows");
    std::process::exit(1);
}
