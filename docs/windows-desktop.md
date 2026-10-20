# Rewards Desktop 预览版使用与发布指南

Rewards Desktop 是本仓库基于 [TheNetsky/Microsoft-Rewards-Script](https://github.com/TheNetsky/Microsoft-Rewards-Script) 扩展的中文 Windows 桌面应用。上游提供脚本基础，本 fork 增加桌面界面与中国区域单账号任务流程适配，并独立维护桌面发布。项目沿用 [GPL-3.0-or-later](../LICENSE)。

应用内置 Node.js 和 Chromium，使用时无需安装 Git、Node.js、Docker 或 WSL。已验证环境为 Windows 11 x64；其他 Windows 版本、其他地区与多账号桌面使用尚未完成验证。

当前桌面版本为 **0.1.9**。请从 GitHub Release 的 **Assets** 下载发布文件。

## 下载与首次运行

打开 [0.1.9 发布页](https://github.com/niko4570/Microsoft-Rewards-Script/releases/tag/desktop-v0.1.9)，在 **Assets** 中选择：

- **推荐安装版**：`Rewards-Desktop-0.1.9-x64.exe`，下载后按向导安装。
- **便携版**：`Rewards-Desktop-0.1.9-x64.zip`，解压到单独目录后运行 `Rewards Desktop.exe`。
- **校验文件**：`SHA256SUMS.txt`；**对应源码**：`rewards-desktop-source.zip`。

后续版本请查看本仓库的 [Releases](https://github.com/niko4570/Microsoft-Rewards-Script/releases)。

GitHub 的 **Code → Download ZIP**、**Source code (zip/tar.gz)** 和 `rewards-desktop-source-*.zip` 均为源码，需要自行构建。上游脚本发布包也不包含本 fork 的桌面安装程序。

1. 下载发布页提供的 `SHA256SUMS.txt`，核对安装包或便携包的 SHA-256。预览版安装程序尚未签名，请使用可信下载来源，不要关闭系统防护。
2. 安装 EXE，或解压便携版后运行 `Rewards Desktop.exe`。
3. 在任务概览点击 **打开浏览器登录**，依次完成移动端和桌面端浏览器登录，两次使用同一个 Microsoft 账号。应用内无需填写邮箱或密码；登录可取消。
4. 先手动执行一次任务并查看报告。完成、跳过、失败、需人工处理和未确认会分别记录；退出码为 0 不代表所有任务完成或所有积分到账。
5. 开启桌面自动运行前，暂停同账号的旧 Docker 或脚本定时任务。自动运行和开机启动默认关闭，开启后需保持应用或托盘运行。

保存的会话可能过期，额外验证或应用授权仍可能需要交互操作。遇到提示时请查看报告，必要时重新登录。后续章节说明自动运行、升级、数据位置及构建验证。

## Automatic runs

Automatic runs and Windows startup are disabled by default. Enable them in app
settings as needed. The app must remain running, including in the tray.

On startup, after login, and after resume, the app reads the saved session's
current task state and next Rewards reset time. It runs eligible unfinished tasks
once per account and server reset cycle. After a reset, it waits one minute before
checking again. An unrun cycle with no pending tasks is checked again every five
minutes so newly available point cards are not missed.

The cycle reservation is saved before launch. Restarting the app or losing a start
response does not create another automatic full run. Busy operations defer checks;
missing reset data, network failures, and expired sessions are checked again after
five minutes. Failed full runs can be retried manually. Sleep and exit pause all
work; resume checks only the current cycle and does not replay missed days.

Closing the window leaves the app in the tray. Exiting the app stops its backend,
tasks, and inspection processes.

## App check-in recovery (0.1.8 and later)

签到自动恢复已完成实际验证（用户确认）。下文说明其复查、补交和防重复机制。

A balance increase alone does not confirm app check-in. The app checks the page's
current-day streak state after submission.

If check-in remains unconfirmed, the task process checks again after the other
tasks finish, then at one-minute intervals up to three times. One compensating
submission is allowed only if the original response was acknowledged, the app
service is available, and the returned streak belongs to the same future reset
cycle. Up to three further one-minute checks follow if necessary.

Compensation reservations persist across restarts and manual runs. Uncertain
transport results, missing streak data, or a changed reset cycle prevent
compensation. The report asks for manual checking if completion remains uncertain.
This recovery runs within the original task process and does not start another
full task run.

## Upgrade and rollback

0.1.9 起可在 **应用设置 → 维护与版本 → 检查更新** 查找 GitHub 上的桌面正式发布。
发现新版本后点击 **下载新版安装包**，选择保存位置；应用显示下载进度并自动校验 SHA256。
完成后点击 **打开下载位置**，退出托盘中的应用，再运行安装包。更新不会自动退出应用或启动安装程序。
下载失败可重试；校验失败的临时文件会删除。旧版本首次升级到包含此功能的版本仍需手动下载。
便携版用户如需继续便携使用，可从发布页下载 ZIP 并解压到新目录。

1. Exit the old app from the tray and back up `%APPDATA%\Rewards Desktop` while it
   is stopped, including any SQLite WAL/SHM files.
2. Keep the previous installer. Run the new installer using the same installation
   location; uninstalling the previous version first is normally unnecessary.
   For portable builds, extract the new ZIP into a separate directory.
3. Open the new version and check that sessions, settings, reports, and automatic
   run preferences remain available. Do not run both versions together.
4. If rollback is necessary, exit the new version and reinstall the previous one.
   Restore the backup if data compatibility requires it.

Installation and user data are separate. Initialization preserves existing
configuration and sessions; uninstalling keeps user data by default. Upgrade,
uninstall, and rollback behavior still need clean-machine acceptance testing.

## Local data and diagnostics

Installed and portable builds use `%APPDATA%\Rewards Desktop` by default.

| Data                                                    | Location                        |
| ------------------------------------------------------- | ------------------------------- |
| Account session key, automatic runs, startup preference | `desktop.json`                  |
| Task configuration                                      | `config.json`                   |
| Browser sessions and fingerprints                       | `sessions/`                     |
| Task reports                                            | `reports/`                      |
| Check-in compensation reservations                      | `reports/app-checkin-recovery/` |
| Automatic cycle reservations                            | `schedule-state.json`           |
| Redacted logs, retained for 30 days                     | `logs/`                         |

Use settings to open the data folder or export diagnostics. Diagnostics contain
runtime information and the latest seven days of redacted logs, excluding config,
session databases, and screenshots. Review exports before sharing. Local session
databases are not additionally encrypted; do not publish the data directory.

If the backend disconnects, export diagnostics and use **重启后台**. Stop active
tasks before changing settings or clearing data. Clearing data removes account
state, sessions, reports, and logs and disables Windows startup.

## Continuous integration

The **CI** workflow (`.github/workflows/ci.yml`) runs on every branch push, pull
request and manual invocation. Node.js 24 checks run on both Ubuntu and Windows:
ESLint, backend compilation and task/dashboard/OAuth tests, desktop compilation,
log parsing, scheduling, and desktop service/updater tests. New runs cancel older
runs for the same event and branch or pull request. The Linux job also runs the
Docker shell scheduler integration that is skipped on Windows.

These checks do not need Microsoft credentials or real browser sessions. Electron
binary downloads are skipped because these tests mock browser launches; actual UI,
Windows packaging and installer checks remain in the separate Windows workflows.
The existing formatting workflow checks pull requests separately.

After this workflow is pushed, its results appear under **Actions → CI** and in
pull request checks. To require passing CI before merging, add
`Checks (ubuntu-latest)` and `Checks (windows-latest)` to the target branch's required
status checks in GitHub branch protection or rulesets.

## Build from source

Use Node.js 24 and install root and desktop dependencies separately:

```bash
npm ci
npm ci --prefix desktop
npm run desktop:build
npm run desktop:test
```

For development, explicitly select an external Node.js executable for the backend:

```powershell
$env:MRS_DESKTOP_NODE = (Get-Command node.exe).Source
npm run desktop:start
```

Build Windows distributions on Windows x64 with Node.js 24:

```powershell
npm run desktop:package
```

Packaging prepares Windows production dependencies and one full Chromium bundle,
checks visible and headless browser startup, validates the isolated backend API,
and tests the packaged UI. Linux/WSL dependencies cannot be copied into a Windows
release. Build resources exclude local config, credentials, sessions, and reports.

The **Windows desktop test package** GitHub Actions workflow supports manual
execution, `desktop-v*` tags, and relevant pull requests. Successful builds upload
installers, portable archives, corresponding source, checksums, and this guide as
CI artifacts. Matching `desktop-vX.Y.Z` tag builds also publish a GitHub Release
after packaging succeeds; manual and pull-request builds produce artifacts only.
The workflow also silently installs the NSIS package into a fresh directory on
the disposable Windows runner and checks the installed runtime and UI with Node.js,
npm, Git and Docker removed from the application PATH. It uploads an installed UI
screenshot separately. This checks bundled dependencies on a hosted development
image; it does not establish acceptance on a Windows image with no developer tools
installed. The workflow does not execute real account tasks or interactive
Microsoft login. See the publishing steps below.

## Validation and known limits

The October 18, 2026 Windows build of 0.1.8 passed:

- TypeScript build and repository ESLint.
- 48 task/dashboard/OAuth tests, including bounded check-in recovery.
- 33 desktop tests and 9 log parser tests.
- 7 cross-platform scheduler tests; Linux-only Docker shell integration was skipped on Windows.
- Bundled dependencies, SQLite, visible/headless Chromium, isolated authenticated
  API startup, and development and packaged Electron UI checks.

Existing 0.1.7 real-account logs confirm successful browser login, task execution,
point changes, and app check-in after a manual rerun. They do not establish the
Microsoft backend cause of the initial unconfirmed check-in.

签到自动恢复已完成实际验证（用户确认），不再列为待验收项。该确认不代表已确定最初签到未确认的服务端原因。

当前 0.1.9 工作区已通过本地构建、ESLint、48 项任务/dashboard/OAuth 测试、
36 项桌面测试、8 项调度测试、日志解析测试，以及 Electron 界面冒烟检查
（含模拟更新下载与校验）。这些结果来自 Linux/WSL 检查，不替代当前版本的
Windows 安装包和真实 Release 更新链路验收。

无人值守运行（Windows 开机启动、休眠唤醒、断网恢复及跨日调度）已验证（用户确认），不再列为待验收项。

2026-10-20 的 0.1.9 Windows 云端验证已通过：

- [完整构建与打包](https://github.com/niko4570/Microsoft-Rewards-Script/actions/runs/39364661685)：构建、ESLint、任务与桌面测试、开发及打包后界面检查，生成 EXE、ZIP、对应源码和校验文件；安装包来自提交 `1b777a0`。
- [安装版验收](https://github.com/niko4570/Microsoft-Rewards-Script/actions/runs/39365904315)：使用同一安装包，在 Windows Server 2025 云端运行器的新目录中静默安装；校验 SHA-256，验证安装后的内置依赖、SQLite、有窗口/无窗口 Chromium、后台 API 鉴权、界面、设置保存、模拟更新下载及关闭到托盘，并上传截图。验收脚本来自提交 `550f7b5`。
- 安装后启动时，应用 PATH 仅提供所需 Windows 系统命令；Node.js、npm、Git、Docker 不在应用 PATH 中。测试使用隔离用户数据，未登录 Microsoft 或执行真实账号任务。

干净 Windows 11 的首次使用与真实账号登录/任务、升级回滚、真实 GitHub Release
更新下载安装链路及独立新用户验收仍待完成。云端验证不等同于这些人工验收。 The preview
supports a limited account/region scope and does not guarantee task completion,
point credit, or future compatibility with Microsoft service changes.

## License

This fork retains GPL-3.0-or-later. Distributions include the project license,
Node.js license, backend dependency notices, Electron notices, and renderer
licenses. Provide the corresponding source archive alongside binary releases.

## Publish desktop updates

1. Set `desktop/package.json` and its lockfile to the new desktop version. Update
   this guide, the README download instructions and the desktop changelog.
2. Commit all release changes, including new files and workflow changes, and run
   the Windows validation/package workflow for that commit. Resolve the remaining
   acceptance items above before describing the build as stable.
3. Push the matching `desktop-vX.Y.Z` tag for the tested commit. The workflow checks
   the tag against the desktop version and repeats validation and packaging. After
   success it publishes the EXE, ZIP, `rewards-desktop-source.zip` (from the tagged
   commit), and `SHA256SUMS.txt` as a GitHub Release. Manual workflow runs produce
   Actions artifacts only.
4. Check the release assets and checksums, include known limits and validation
   results in the release notes, and update download links after publication.
   Exercise the update/download/install flow from the previous version.

The updater selects the highest numeric `desktop-vX.Y.Z` release and ignores script
releases, drafts and prereleases. Publish both the installer and checksum file;
incomplete releases display a retry message. Desktop downloads use
`Rewards-Desktop-X.Y.Z-x64.exe` and `Rewards-Desktop-X.Y.Z-x64.zip`; the source ZIP
is for building from source, not for running the desktop app.

已有打包产物可通过 **Windows desktop installer acceptance** 工作流单独复核：
手动填写成功的 Windows 打包任务编号 `artifact_run_id`。工作流下载该任务的
`rewards-desktop-windows-x64` 产物，校验并安装与当前桌面版本匹配的 EXE，
执行安装后检查并上传截图，不重新打包或发布 Release。
