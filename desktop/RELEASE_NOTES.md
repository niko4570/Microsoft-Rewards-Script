# Rewards Desktop — Windows Tauri / WebView2

桌面外壳迁移到 Tauri 2 / Windows WebView2，继续使用原来的 React 界面、Node 后端和 Patchright 自动化。关闭窗口会释放 WebView，托盘继续负责调度；再次打开时恢复后台状态。

- 安装版：`Rewards-Desktop-X.Y.Z-x64.exe`。缺少 WebView2 Runtime 时，安装程序联网补装共享 Evergreen Runtime。
- 便携版：`Rewards-Desktop-X.Y.Z-x64.zip`。解压后运行 `Rewards Desktop.exe`；系统需已安装 WebView2 Runtime。
- 内置 Node.js，任务改用系统 Chrome / Edge 稳定版，不再打包 Chromium。默认跟随系统默认浏览器，不受支持时优先 Edge；设置中可手动选择。未安装时提供官方下载和重新检测入口。最终包体以 Windows 构建结果为准。

从 Electron 版本迁移前，请从托盘退出旧程序，并备份 `%APPDATA%\Rewards Desktop`。卸载旧程序时保留数据，再安装新版；不要同时运行两个版本或同账号的其他调度器。原账号槽、会话、报告及服务端周期记录继续使用该数据目录。安装目录可以与旧版不同。

此前 Tauri 外壳迁移已通过前端构建、ESLint、桌面与任务回归测试、Windows 目标编译，以及隔离 Windows WebView2 界面验证。这些历史结果不代表系统浏览器改造已完成验收。界面验证复用了本地 0.1.9 产物中的 Windows Node/依赖，没有登录 Microsoft 或执行真实账号任务。

发布流水线要求完整 Windows MSVC 构建、打包后界面和 NSIS 安装后运行检查全部通过，再公开此版本。真实账号登录与任务、开机启动、休眠唤醒、旧版升级及用户机器上的 Release 更新链路仍需单独验收。此前 Electron 版本的人工验收结果不代表新外壳已通过这些验证。

[使用与构建说明](docs/windows-desktop.md)
