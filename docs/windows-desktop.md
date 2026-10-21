# Rewards Desktop 预览版使用与发布指南

Rewards Desktop 是本仓库基于 [TheNetsky/Microsoft-Rewards-Script](https://github.com/TheNetsky/Microsoft-Rewards-Script) 扩展的中文 Windows 桌面应用。上游提供脚本基础，本 fork 增加桌面界面与中国区域单账号任务流程适配，并独立维护桌面发布。项目沿用 [GPL-3.0-or-later](../LICENSE)。

应用内置 Node.js 和 Chromium，使用时无需安装 Git、Node.js、Docker 或 WSL。已验证环境为 Windows 11 x64；其他 Windows 版本、其他地区与多账号桌面使用尚未完成验证。

桌面最新版以 [最新发布页](https://github.com/niko4570/Microsoft-Rewards-Script/releases/latest) 为准。0.2.0 起使用 Tauri / WebView2；旧版 Electron 的人工验收不代表新外壳已完成同样验收。请从 GitHub Release 的 **Assets** 下载发布文件。

## 下载与首次运行

打开 [桌面最新发布页](https://github.com/niko4570/Microsoft-Rewards-Script/releases/latest)，在 **Assets** 中选择：

- **推荐安装版**：`Rewards-Desktop-X.Y.Z-x64.exe`，下载后按向导安装。
- **便携版**：`Rewards-Desktop-X.Y.Z-x64.zip`，解压到单独目录后运行 `Rewards Desktop.exe`。
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

These checks do not need Microsoft credentials or real browser sessions. Native
Rust compilation/tests, actual WebView2 UI, Windows packaging and installer checks
run in the separate Windows workflow. Backend integration tests use isolated data
and local authenticated API ports.
The existing formatting workflow checks pull requests separately.

After this workflow is pushed, its results appear under **Actions → CI** and in
pull request checks. To require passing CI before merging, add
`Checks (ubuntu-latest)` and `Checks (windows-latest)` to the target branch's required
status checks in GitHub branch protection or rulesets.

## Build from source

Use Node.js 24 and install root and desktop dependencies separately. To build or
launch the native shell on Windows, also install Rust stable with the MSVC target,
Visual Studio C++ Build Tools (Desktop development with C++ and Windows SDK), and
WebView2 Evergreen Runtime. End users do not need Rust or Node.js.

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

Check the native shell and build Windows distributions on Windows x64:

```powershell
npm run test:native --prefix desktop
npm run desktop:package
```

Packaging prepares Windows production dependencies and one full Chromium bundle,
checks visible and headless browser startup, validates the isolated backend API,
builds a Tauri NSIS installer and portable ZIP, and tests the packaged WebView2 UI.
The installer downloads the shared Evergreen WebView2 Runtime only if missing.
Portable users must already have WebView2 Runtime installed. Linux/WSL dependencies cannot be copied into a Windows
release. Build resources exclude local config, credentials, sessions, and reports.

The **Windows desktop test package** GitHub Actions workflow supports manual
execution, `desktop-v*` tags, and relevant pull requests. Successful builds upload
installers, portable archives, corresponding source, checksums, and this guide as
CI artifacts. The **Publish v4 updates** workflow calls this same validation chain
when runtime changes reach `v4`, then automatically creates a `desktop-vX.Y.Z`
GitHub Release after all checks pass. Manual desktop test runs and pull requests
produce artifacts only. Explicit version tags remain supported.
The workflow also silently installs the NSIS package into a fresh directory on
the disposable Windows runner and checks the installed runtime and UI with Node.js,
npm, Git and Docker removed from the application PATH. It uploads an installed UI
screenshot separately. This checks bundled dependencies on a hosted development
image; it does not establish acceptance on a Windows image with no developer tools
installed. The workflow does not execute real account tasks or interactive
Microsoft login. See the publishing steps below.

## Tauri 0.2.0 migration (unreleased)

The React interface uses `src/bridge.ts` to call a narrow Rust command. The native
shell owns windows, tray, single-instance handling, autostart, dialogs and file
opening. `host.mjs` runs the existing Node service/scheduler over private
stdin/stdout JSON messages, retaining the authenticated loopback task API.
Renderer code receives neither its token nor unrestricted filesystem/process APIs.

Closing the window destroys the WebView; the tray and Node scheduler remain.
Opening the tray recreates the UI and reads a fresh snapshot. Quit stops the Node
service, API, login/inspection/task processes. On Windows, a kill-on-close Job
Object also covers abrupt shell termination. A clock-gap check resets scheduling
after sleep; server reset reservations remain in the existing scheduler state.

Data remains in `%APPDATA%\Rewards Desktop`, including `desktop.json`, sessions,
reports and `schedule-state.json`. The WebView's own cache is separate. For the
first Electron-to-Tauri upgrade, quit the old app from its tray and back up this
data directory. Uninstall the old application while preserving its data before
installing Tauri; do not run the two shells or another account scheduler together.
The new installer need not select the old Electron installation directory.

`npm run test:ui --prefix desktop` checks a previously built native executable.
The Windows package command runs it against the portable app, and the installer
workflow repeats it against the installed app without development tools on PATH.
The harness enables WebView2 CDP only through its test process environment; it
checks real API connection, settings persistence, argument rejection, destroying
and reopening a window, single-instance behavior and graceful exit. Update
selection/download/checksum behavior is covered by Node tests, without a real
release download or a mocked native UI dialog.

Local migration validation on October 20, 2026 passed:

- Frontend build and repository ESLint.
- 37 desktop tests, 48 task/dashboard/OAuth tests, and 17 log/scheduler tests.
- Windows GNU target compilation, including the native resources.
- A Windows WebView2 UI smoke test using a cross-compiled shell and isolated
  temporary data: real backend connection, settings, window destruction/recreation,
  single instance and graceful exit. This reused the Windows Node/dependency
  runtime from the local 0.1.9 artifact; it did not exercise a new NSIS installer.

The full Windows MSVC/NSIS pipeline and real-account login/task, sleep/resume,
autostart, update and Electron-to-Tauri upgrade acceptance still need to run for
this shell. The following results concern the old Electron releases and must not
be treated as Tauri acceptance.

## Historical validation and known limits

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
Node.js license, backend dependency notices, Rust/Tauri dependency notices and
license files, and renderer licenses. Provide the corresponding source archive alongside binary releases.

## Publish desktop updates

1. Merge reviewed runtime changes into `v4`. **Publish v4 updates** compares each
   component with its last reachable release tag; documentation and test-only changes
   do not create versions. Desktop and Docker changes are evaluated separately;
   shared backend changes affect both.
2. The planner records the triggering source commit and component versions in one
   release-plan artifact without modifying the checkout. An explicit version higher
   than existing tags is preserved; otherwise `feat:` increments minor, breaking
   Conventional Commits increment major, and other runtime changes increment patch.
   A new backend major requires a new release branch rather than publishing v5 from
   `v4`. Published stable releases remain the version authority; repository manifests
   are version hints and are no longer automatically updated after every release.
3. Linux/Windows CI, desktop packaging and Docker publishing download the same plan,
   verify that its source SHA matches their checkout, and stamp npm manifests/lockfiles
   plus the desktop Cargo manifest/lockfile only in the build workspace. No release
   step creates a commit or pushes to `v4`.
4. Linux/Windows CI validates that exact source with the planned versions applied.
   Windows builds additionally run Rust tests, packaged WebView2 checks and
   installed-app checks. Only after these succeed are desktop assets uploaded to a
   draft and published with a tag pointing to the original source commit. Docker
   builds/pushes its versioned multi-platform image after CI succeeds, then promotes
   `:4` / `:latest` and creates its own script Release. Script releases do not replace
   the desktop GitHub Latest marker.
5. Both component releases include a corresponding source ZIP with the effective
   version files used during the build. Its `RELEASE-BUILD.json` records the original
   source SHA, effective component versions and SHA-256 hashes of the version files.
   The desktop source ZIP is covered by `SHA256SUMS.txt`; the script source ZIP has
   its own `.sha256` file. GitHub's automatically generated tag source archives still
   reflect the original commit's version hints; use the attached corresponding-source
   ZIP to reproduce the exact build versions.
6. Failed checks do not publish a desktop release or promote a Docker image. Rerun
   **Publish v4 updates** to retry an unpublished version. A retry computes the plan
   from published releases, not from a reservation commit. If another update reached
   `v4`, an older build refuses promotion and the queued run covers pending changes
   since the last tag. A failed desktop asset upload can leave an unpublished draft;
   rerunning uploads the assets before making it public. Do not manually reuse or
   move a published version tag.
7. Check the resulting assets, release notes and checksums. Hosted UI tests do not
   validate real Microsoft login/tasks, upgrade on a user's machine, sleep/resume or
   code signing. Verify those separately when relevant. The desktop test workflow
   can still be run manually without publishing. An explicit `desktop-vX.Y.Z` tag
   can also run validation/publication when the source manifests already match that
   tag; retry automatic releases through the release controller so they receive
   the complete version plan.

The release controller runs directly on pushes to `v4` (including merges), using
`GITHUB_TOKEN`. It pins every reusable workflow to the original source SHA and
shares one immutable version plan; its planning job has read-only contents access.
Only the component publication jobs receive write permission for tags, Releases
and packages. Neither a personal access token nor a branch-protection bypass is
needed. Releases are serialized and do not cancel in progress. Manual controller
runs on other branches are skipped. This workflow change does not configure branch
protection; PR and required-check rules can be enabled separately after review.

The updater selects the highest numeric `desktop-vX.Y.Z` release and ignores script
releases, drafts and prereleases. Publish both the installer and checksum file;
incomplete releases display a retry message. Desktop downloads use
`Rewards-Desktop-X.Y.Z-x64.exe` and `Rewards-Desktop-X.Y.Z-x64.zip`; the source ZIP
is for building from source, not for running the desktop app.

安装验收已包含在 **Windows desktop test package** 工作流中，打包成功后会自动
校验安装包、静默安装、检查安装后的应用并上传截图，无需再启动独立验收工作流。

仓库保留四份工作流：**CI** 负责 PR 检查、手动检查及发布前验证；
**Publish v4 updates** 负责合并后的版本规划与发布调度；
**Windows desktop test package** 和 **Publish tested Docker image** 分别负责平台构建与发布。
PR 的格式检查只检查变更文件，并入 CI，不再自动提交格式修复 PR。

### 运行模式

任务总览的“运行模式”按钮可在以下两种模式之间切换，选择会保存到本地，从下一次手动或自动运行生效。任务运行、登录或后台检查期间不能切换。

- **任务模式**：执行签到、每日活动、阅读等现有任务，只执行任务要求的搜索。
- **任务＋搜索模式**：执行相同任务，再执行普通搜索，获取服务端返回的电脑和手机每日搜索额度积分。未提供的额度不会凭空补出，已完成的额度会跳过；搜索停止后仍有剩余额度会报告“未确认”。

两种模式都保留当前任务页面读取、完成核验与运行报告。普通搜索读取当前页面的 `pointsCounters`，不依赖旧版账户接口。未读取到额度时报告失败，不把缺失数据当作已完成。普通搜索仍遵守现有的次数上限与无积分增长停止规则，微软是否计分以页面进度为准。

升级后默认保留任务模式。切换模式不会清除本周期已自动运行的记录；若今天已经自动运行，切换后可手动开始任务，下个周期按保存的模式自动运行。
