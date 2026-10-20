use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

type Reply = Result<Value, String>;

pub struct Host {
    input: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Reply>>>,
    sequence: AtomicU64,
    // A Windows job kills the entire backend tree even if the shell crashes.
    #[cfg(windows)]
    _job: job::Job,
}

impl Host {
    pub fn start(
        app: AppHandle,
        resources: &Path,
        data: &Path,
        custom: bool,
    ) -> Result<Arc<Self>, String> {
        let node = if cfg!(dev) {
            std::env::var_os("MRS_DESKTOP_NODE")
                .map(Into::into)
                .ok_or("开发模式需设置 MRS_DESKTOP_NODE 为 Node.js 24 的绝对路径")?
        } else {
            resources.join("node.exe")
        };
        let script = resources.join("desktop/host.mjs");
        if !node.is_absolute() || !node.is_file() || !script.is_file() {
            return Err("缺少 Node.js 或桌面后台文件，请重新安装".into());
        }
        std::fs::create_dir_all(data.join("logs")).map_err(|e| e.to_string())?;
        let mut command = Command::new(node);
        command
            .args([script.as_os_str(), resources.as_os_str(), data.as_os_str()])
            .arg(app.package_info().version.to_string())
            .current_dir(data)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for key in [
            "PATH",
            "Path",
            "SystemRoot",
            "SYSTEMROOT",
            "WINDIR",
            "TEMP",
            "TMP",
            "TMPDIR",
            "HOME",
            "USERPROFILE",
            "LOCALAPPDATA",
            "APPDATA",
            "COMSPEC",
            "LANG",
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "XDG_RUNTIME_DIR",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("无法启动桌面后台：{e}"))?;
        #[cfg(windows)]
        let job = match job::Job::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let input = child.stdin.take().ok_or("后台 stdin 不可用")?;
        let output = child.stdout.take().ok_or("后台 stdout 不可用")?;
        let stderr = child.stderr.take().ok_or("后台 stderr 不可用")?;
        let error_directory = data.join("logs");
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = std::fs::create_dir_all(&error_directory);
                let file = error_directory.join("host.log");
                if std::fs::metadata(&file).is_ok_and(|info| info.len() > 1024 * 1024) {
                    let _ = std::fs::rename(&file, error_directory.join("host.old.log"));
                }
                if let Ok(mut file) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&file)
                {
                    let _ = writeln!(file, "{line}");
                }
            }
        });
        let host = Arc::new(Self {
            input: Mutex::new(input),
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(0),
            #[cfg(windows)]
            _job: job,
        });
        let reader = host.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = message["id"].as_u64() {
                    if let Some(sender) = reader.pending.lock().unwrap().remove(&id) {
                        let result = if let Some(error) = message["error"].as_str() {
                            Err(error.into())
                        } else {
                            Ok(message["value"].clone())
                        };
                        let _ = sender.send(result);
                    }
                } else if let Some(request) = message.get("native") {
                    let request = request.clone();
                    let native_app = app.clone();
                    let writer = reader.clone();
                    std::thread::spawn(move || {
                        let result = crate::native::invoke(&native_app, custom, &request);
                        let response = match result {
                            Ok(value) => json!({"nativeResult": request["id"], "value": value}),
                            Err(error) => json!({"nativeResult": request["id"], "error": error}),
                        };
                        let _ = writer.send(&response);
                    });
                } else if let Some(event) = message["event"].as_str() {
                    let _ = app.emit(event, &message["value"]);
                }
            }
            for (_, sender) in reader.pending.lock().unwrap().drain() {
                let _ = sender.send(Err("桌面后台已退出，请退出并重新打开应用".into()));
            }
            let _ = app.emit("desktop:error", "桌面后台已退出，请退出并重新打开应用");
        });
        Ok(host)
    }

    fn send(&self, message: &Value) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|e| e.to_string())?;
        writeln!(input, "{message}")
            .and_then(|_| input.flush())
            .map_err(|e| format!("后台连接已断开：{e}"))
    }

    pub fn request(&self, action: &str, value: Value) -> Reply {
        let id = self.sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, sender);
        if let Err(error) = self.send(&json!({"id": id, "action": action, "value": value})) {
            self.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        let seconds = match action {
            "downloadUpdate" => 1900,
            "shutdown" => 35,
            _ => 120,
        };
        let result = receiver
            .recv_timeout(Duration::from_secs(seconds))
            .map_err(|_| "后台操作未返回；请检查日志，勿重复提交任务".to_string());
        self.pending.lock().unwrap().remove(&id);
        result?
    }

    pub fn shutdown(&self) {
        let _ = self.request("shutdown", Value::Null);
        let until = Instant::now() + Duration::from_secs(3);
        loop {
            let mut child = self.child.lock().unwrap();
            if child.try_wait().ok().flatten().is_some() {
                break;
            }
            if Instant::now() >= until {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            drop(child);
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

#[cfg(windows)]
mod job {
    use std::{mem::size_of, os::windows::io::AsRawHandle, process::Child};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };

    pub struct Job(HANDLE);
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}
    impl Job {
        pub fn attach(child: &Child) -> Result<Self, String> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                let job = Self(handle);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                    || AssignProcessToJobObject(handle, child.as_raw_handle() as HANDLE) == 0
                {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                Ok(job)
            }
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
