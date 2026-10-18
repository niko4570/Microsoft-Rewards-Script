# Rewards Desktop 0.1.8 preview

Rewards Desktop is a Chinese-language Windows app for one China-region Microsoft
Rewards account. It bundles Node.js and Chromium; users do not need Git, Node.js,
Docker, or WSL. Windows 11 x64 is the validated build environment. Other Windows
versions, regions, and multiple accounts have not been validated for this app.

## Download and first run

Download a desktop installer or portable archive from this fork's
[Releases](https://github.com/niko4570/Microsoft-Rewards-Script/releases) when
available. Desktop artifacts use the `Rewards-Desktop-<version>-x64` name.
Source archives and upstream script releases are not desktop installers.

1. Verify the download against the release's `SHA256SUMS.txt`. Preview builds are
   unsigned; use a trusted source and do not disable system protection.
2. Run the `.exe` installer, or extract the portable ZIP and open `Rewards Desktop.exe`.
3. In the task overview, click **打开浏览器登录**. Complete the mobile and desktop
   browser logins with the same Microsoft account. The windows open in sequence,
   save each stable session, and close. No email or password needs to be entered
   into the app itself. Login can be cancelled.
4. Start one manual run and inspect the results. Completed, skipped, failed,
   manual, and unconfirmed tasks are reported separately. Exit code 0 does not
   mean every task completed or every advertised reward was credited.
5. Pause any older Docker or script schedule for the same account before enabling
   automatic runs in the desktop app.

Saved sessions can expire. Additional verification or app authorization may still
require interaction. Review the report and log in again when necessary.

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

## App check-in recovery in 0.1.8

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

In-app update checking and automatic application updates are not implemented.

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
execution, `desktop-v*` tags, and relevant pull requests. It uploads installers,
portable archives, corresponding source, checksums, and this guide as CI artifacts.
It does not publish a desktop GitHub Release or execute real account tasks.

For a desktop release, tag the tested source commit, run the Windows build, and
attach the installer, portable archive, corresponding source archive, and checksum
file to the matching GitHub Release. Include known limits and validation results.

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
Microsoft backend cause of the initial unconfirmed check-in. The new automatic
recovery path uses simulated waits in tests and still needs a real-cycle trial.

Clean-machine installation, upgrade/rollback, long-running sleep/startup behavior,
and independent first-time user acceptance remain to be checked. The preview
supports a limited account/region scope and does not guarantee task completion,
point credit, or future compatibility with Microsoft service changes.

## License

This fork retains GPL-3.0-or-later. Distributions include the project license,
Node.js license, backend dependency notices, Electron notices, and renderer
licenses. Provide the corresponding source archive alongside binary releases.
