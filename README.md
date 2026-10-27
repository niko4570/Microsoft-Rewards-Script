# Rewards Desktop · 微软 Rewards 自动签到与任务助手

基于 [TheNetsky/Microsoft-Rewards-Script](https://github.com/TheNetsky/Microsoft-Rewards-Script) 扩展的中文 Windows 桌面应用，支持浏览器登录、每日任务、积分余额查询、运行报告和托盘自动运行。本 fork 主要适配中国区域单账号使用，同时保留脚本、WSL 和 Docker 部署方式。

**Windows 用户下载安装包即可使用，无需安装 Git、Node.js、Docker 或 WSL。** 应用内置 Node.js，任务使用系统已安装的 Chrome 或 Microsoft Edge 稳定版。

[下载桌面版](https://github.com/niko4570/Microsoft-Rewards-Script/releases/latest) · [Windows 使用指南](docs/windows-desktop.md) · [WSL / Docker 部署](docs/china-tasks.md) · [脚本技术文档](#table-of-contents)

## 选择使用方式

| 使用方式               | 适合谁                                   | 从哪里开始                            |
| ---------------------- | ---------------------------------------- | ------------------------------------- |
| Windows 桌面版         | 希望通过中文界面登录、运行和查看结果     | [下载与首次使用](#windows-下载)       |
| WSL / Docker 任务模式  | 已有本地环境，希望后台定时执行中国区任务 | [中国区部署指南](docs/china-tasks.md) |
| 源码脚本 / Control API | 需要自定义配置或对接其他工具             | [脚本技术文档](#table-of-contents)    |

## Windows 下载

当前桌面正式发布为 [0.4.4](https://github.com/niko4570/Microsoft-Rewards-Script/releases/tag/desktop-v0.4.4)（2026-10-27），采用 **Tauri 2 / Windows WebView2**，已改用系统 Chrome / Edge，不再打包 Chromium。后续版本请以[最新发布页](https://github.com/niko4570/Microsoft-Rewards-Script/releases/latest)为准。

在发布页展开 **Assets**，按用途选择：

| 文件                            | 用途                                      |
| ------------------------------- | ----------------------------------------- |
| `Rewards-Desktop-X.Y.Z-x64.exe` | 推荐安装版，按向导安装                    |
| `Rewards-Desktop-X.Y.Z-x64.zip` | 便携版，解压后运行 `Rewards Desktop.exe`  |
| `SHA256SUMS.txt`                | 安装包、便携包和对应源码的 SHA-256 校验值 |
| `rewards-desktop-source.zip`    | 对应版本的构建源码，供开发者使用          |

运行环境以 **Windows 11 x64** 为主要验证目标。需要已安装 Chrome 或 Edge 稳定版，以及 WebView2 Runtime；安装版会在缺少 WebView2 时联网补装，便携版需自行准备。安装程序目前尚未签名。

> **下载提示：** 想直接运行应用，请选择 EXE 或桌面便携 ZIP。`Code → Download ZIP`、`Source code (zip/tar.gz)` 和 `rewards-desktop-source.zip` 都是源码。

## 第一次使用

1. 安装 EXE，或将便携 ZIP 解压到独立目录后打开 `Rewards Desktop.exe`。
2. 确认检测到任务浏览器。默认跟随系统的 Chrome / Edge；默认浏览器不受支持时优先选择 Edge，再选择 Chrome。可在 **应用设置 → 任务浏览器** 中修改；未检测到时按提示安装并重新检测。
3. 在 **任务总览** 点击 **打开浏览器登录**，依次完成移动端和桌面端登录，两次使用同一个 Microsoft 账号。应用内无需输入邮箱或密码，额外验证在浏览器中完成。
4. 选择运行模式，先手动执行一次，再到 **运行结果** 查看完成、跳过、失败、未确认及需人工处理的事项。
5. 需要后台执行时，在设置中开启自动运行，并按需开启 Windows 登录后启动。两项默认关闭；开启后需保持应用或托盘运行。

任务浏览器使用应用自己的独立会话，不读取日常浏览器个人资料。切换浏览器或会话过期后，可能需要重新登录。

## 桌面功能

| 功能           | 行为说明                                                             |
| -------------- | -------------------------------------------------------------------- |
| 任务模式       | 执行签到、每日活动、阅读等已支持任务，仅执行任务要求的搜索           |
| 任务＋搜索模式 | 在相同任务基础上执行普通电脑和手机搜索，额度以服务端返回的数据为准   |
| 积分余额       | 显示最近读取的可用积分与更新时间；可单独刷新，本地保存后重启仍可查看 |
| 运行结果       | 保存任务状态、运行前后积分及失败原因，方便与 Rewards 页面核对        |
| 自动运行       | 根据微软服务端重置周期检查未完成任务，按账号和周期保存自动启动记录   |
| 托盘与开机启动 | 关闭窗口后托盘继续调度；从托盘退出会停止后台工作                     |
| 更新与诊断     | 检查桌面新版本、下载安装包并校验 SHA-256，也可导出脱敏诊断           |

切换运行模式会保存设置，从下一次手动或自动运行生效，不会清除本周期已自动执行的记录。任务运行、登录或后台检查期间不能切换；若本周期已经自动运行，可在切换后手动开始任务。

### 自动运行与完成核验

应用在启动、登录完成及休眠恢复后读取当前任务状态和服务端重置时间。符合条件的未完成任务每个账号、每个重置周期最多自动启动一次；重置后留一分钟缓冲再检查。读取失败、网络异常或会话过期时，通常每五分钟重试检查；失败的完整任务可手动重试。

电脑休眠或应用退出期间不会执行，恢复后只检查当前周期，不补跑历史日期。桌面调度依据服务端周期，Docker 的首次定时配置则默认使用北京时间 13:00，具体规则见[中国区部署指南](docs/china-tasks.md)。

应用签到未确认时，会在原任务进程内复查；仅在原提交已获有效响应、签到服务可用且仍属同一重置周期时允许一次补交。防重复记录会持久保存。无法可靠确认的结果会提示人工核对。

**程序运行结束或余额增加，不代表全部任务完成或积分均已到账。** 请结合运行报告与微软页面的完成标记判断。

## 升级与本地数据

- 在 **应用设置 → 维护与版本 → 检查更新** 中查找新版。下载完成并通过 SHA-256 校验后，从托盘退出应用，再手动运行安装包。便携版用户可从发布页下载新 ZIP。
- **首次从 Electron 旧版迁移到 Tauri 版**：先退出旧程序，备份 `%APPDATA%\Rewards Desktop`，卸载旧程序时保留数据，再安装新版。不要同时运行两个版本。
- 安装版和便携版默认均使用 `%APPDATA%\Rewards Desktop` 保存会话、设置、报告和调度记录。备份时先退出应用；升级、卸载和回滚细节见[完整指南](docs/windows-desktop.md)。
- 排查问题先查看 **运行结果**，再通过 **应用设置 → 维护与版本** 导出诊断或打开数据目录查看 `logs/`。日志保留 30 天，诊断包含最近 7 天的脱敏日志。
- 开启桌面自动运行前，暂停同账号已有的脚本或 Docker 定时任务，避免多个调度器同时执行。

## 版本与验证范围

桌面发布版本以 [Releases](https://github.com/niko4570/Microsoft-Rewards-Script/releases) 为准；仓库中的 npm / Cargo 版本可能只是构建提示，不一定等于最新发布版本。[历史更新记录](desktop/CHANGELOG.md)中的开发中描述也应结合对应 Release 阅读。

当前发布流程包含 CI、Windows 构建打包、打包后界面及安装后运行检查。自动检查不执行真实 Microsoft 登录或账户任务；真实账号任务、旧版升级、休眠恢复和用户机器上的更新链路仍需单独验证。旧 Electron 版本的人工验收不代表新外壳已通过同样验证。其他 Windows 版本、地区及多账号桌面使用尚未完成验证。

## 项目来源与许可

上游 [TheNetsky/Microsoft-Rewards-Script](https://github.com/TheNetsky/Microsoft-Rewards-Script) 提供脚本基础与任务执行能力。本 fork 增加中文桌面界面、中国区域任务适配、服务端周期调度、持久报告与诊断，并独立维护桌面发布。

项目沿用 [GPL-3.0-or-later](LICENSE)，保留上游版权和许可证声明；桌面发布同时提供对应源码。桌面版与上游脚本分别编号，上游构建或镜像不能代表本 fork 的桌面版本。

---

> [!TIP]
> This version supports the **new, modern Bing Rewards dashboard only** - it does **not** support the legacy dashboard.
> If your account still uses the old dashboard, use the [v3 branch](https://github.com/TheNetsky/Microsoft-Rewards-Script/tree/v3) and v3.x releases instead!
>
> Use at your own risk - some features may not work as expected.

---

## Table of Contents

Windows 桌面版请先阅读上方的 [下载指引](#windows-下载) 和 [首次使用步骤](#第一次使用)。以下目录用于脚本与 Docker 部署。

- [Table of Contents](#table-of-contents)
- [Quick Setup](#quick-setup)
    - [Bare metal](#bare-metal)
        - [Get the script](#get-the-script)
- [Account Setup](#account-setup)
- [Config Setup](#config-setup)
    - [Build and run the script (bare metal version)](#build-and-run-the-script-bare-metal-version)
- [Docker](#docker)
- [Control API and Dashboard](#control-api-and-dashboard)
- [Configuration Options](#configuration-options)
    - [Core](#core)
    - [Workers](#workers)
    - [Activities](#activities)
    - [Search Settings](#search-settings)
        - [Query sources](#query-sources)
    - [Experimental](#experimental)
        - [Activity source layout](#activity-source-layout)
    - [Logging](#logging)
    - [Proxy](#proxy)
    - [Webhooks](#webhooks)
- [Troubleshooting](#troubleshooting)
    - [Manual login](#manual-login)
    - [Session management](#session-management)
- [Disclaimer](#disclaimer)

---

## Quick Setup

### Bare metal

**Requirements:** Node.js >= 24 and Git  
Works on Windows, Linux, macOS, and WSL.

#### Get the script

```bash
git clone https://github.com/niko4570/Microsoft-Rewards-Script.git
cd Microsoft-Rewards-Script
```

Or, download the corresponding source archive from [Releases](https://github.com/niko4570/Microsoft-Rewards-Script/releases) and extract it. For desktop releases, use `rewards-desktop-source.zip` to obtain the effective build versions; `Rewards-Desktop-*-x64.zip` is a packaged Windows app, not a script source checkout.

## Account Setup

- Copy and rename [`env.example`](env.example) to `.env` and add your account credentials:

```env
ACCOUNT_1_EMAIL=email@example.com
# ACCOUNT_1_PASSWORD=your_password
```

> [!NOTE]
> `ACCOUNT_N_PASSWORD` is optional. Set it when password sign-in should be available; leave it unset for passwordless/Authenticator-only accounts.
>
> Add one `ACCOUNT_N_*` block per account. Account slots do not need to be contiguous: `ACCOUNT_2` or `ACCOUNT_4` can be configured even when earlier slots are missing. Accounts run in ascending slot order. Optional per-account fields cover recovery email, locale, language, proxy, and fingerprint persistence - see [`env.example`](env.example) for all of them.

`ACCOUNT_N_LANG_CODE` accepts a BCP 47 language tag such as `nl`, `it`, or `pt-BR`. `ACCOUNT_N_GEO_LOCALE` accepts a two-letter country code or defaults to `auto`. The selected language and country are applied consistently to browser fingerprints, `Accept-Language`, Microsoft Rewards app headers, and market-specific requests. In `auto` mode, the country reported by the Microsoft profile is cached after the first successful dashboard request; changing either locale setting automatically replaces an incompatible saved fingerprint.

> [!TIP]
> For 2FA accounts, set `ACCOUNT_N_TOTP_SECRET` and the script will generate and enter the 6-digit code automatically. To get the secret: in your Microsoft Security settings open 'Manage how you sign in', add an Authenticator app, and when the QR code appears choose 'enter code manually' - use that code as the value in your `.env`.

> [!WARNING]
> You must rebuild your script after making any changes to the `.env`.

## Config Setup

> [!WARNING]
> Do **not** skip this step if you are running the script bare metal.

- **Bare metal:** Copy or rename `config.example.json` to `config.json` (in the project root) and customize your preferences.
- **Docker:** A valid `config.json` is automatically created on first run and saved locally to `./config/`. You can optionally manually create a `config.json` (e.g., if you need to specify regex values) using the provided `config.example.json`

> [!CAUTION]
> Prior versions of accounts.json and config.json are not compatible with current release.

### Build and run the script (bare metal version)

```bash
npm run pre-build
npm run build
npm run start
```

## Docker

The supplied [`compose.yaml`](compose.yaml) builds this fork from local source and defaults to the single-account China tasks-only profile. Clone the repository first; copying the Compose file alone is insufficient. For initial setup and interactive login, follow [中国区部署指南](docs/china-tasks.md).

- Review [`compose.yaml`](compose.yaml)
- Copy and rename [`env.example`](env.example) to `.env` and add your account credentials:

```env
ACCOUNT_1_EMAIL=email@example.com
# ACCOUNT_1_PASSWORD=your_password
```

`ACCOUNT_N_PASSWORD` is optional; omit it for passwordless/Authenticator-only accounts.

- The supplied Compose file enables Telegram notifications and requires `CONFIG_TELEGRAM_BOTTOKEN` and `CONFIG_TELEGRAM_CHATID` in `.env`. To run without notifications, set `CONFIG_TELEGRAM_ENABLED: 'false'` and remove the two required token/chat-ID entries from Compose.
- Create the mobile and desktop sessions on the host before starting the tasks-only container. See [manual login](#manual-login); the default container cannot display the login window.
- Review `compose.yaml` to adjust scheduling, timezone, and config options.

> [!NOTE]
> A valid `config.json` is auto-generated on first run using default values, and saved locally to `./config/`.
> Optionally, use `CONFIG_*` variables in the `environment:` section of the `compose.yaml` to customise your options (e.g., clusters, webhook, etc.).
> A full list of available options are in the [table below](#configuration-options).
> `CONFIG_*` variables are applied on every startup and always take precedence over `./config/config.json`.

> [!TIP]
> If a new image adds config options you're missing, a warning will appear in the container logs.
> To update, delete `./config/config.json` and restart - a fresh one will be generated from the latest example, with your `compose.yaml` overrides re-applied.

- Build and start the container: `docker compose up -d --build`

> [!TIP]
> Monitor logs with `docker logs microsoft-rewards-script`, useful for viewing passwordless login codes or diagnosing issues.
> You can also enable a webhook in `compose.yaml` for notifications.

---

## Control API and Dashboard

The optional Control API lets a local dashboard or another trusted tool monitor
and control the script over HTTP. See the [complete Control API
documentation](scripts/api/README.md) for setup, authentication, every endpoint,
request fields, response examples, and security guidance.

Common uses include:

- checking API health and the current run state with `GET /health` and
  `GET /status`;
- reading live points, logs, errors, account summaries, run history, and error
  diagnostics;
- listing safe stored-session metadata and deleting the mobile/desktop sessions
  for one account;
- starting all accounts with `POST /start` and an empty JSON body;
- running only one account with `POST /start` and `{"accountIndex":2}`;
- running all accounts except selected slots with `POST /start` and
  `{"excludedAccountIndexes":[2,4]}`;
- stopping or restarting a run with `POST /stop` or `POST /restart`;
- streaming live logs and status updates from `GET /events` using
  Server-Sent Events (SSE);
- reading the active configuration and schedule, with config and schedule
  changes available only when their explicit `API_ALLOW_*` options are enabled.

For example, start only `ACCOUNT_2` with cURL:

```bash
curl --request POST \
  --url http://127.0.0.1:3010/start \
  --header 'Authorization: Bearer YOUR_API_TOKEN' \
  --header 'Content-Type: application/json' \
  --data '{"accountIndex":2}'
```

For a ready-made web interface, use the supported and endorsed
[Rewards Dashboard](https://github.com/mgrimace/rewards-dashboard). It connects
to this Control API to manage runs, accounts, schedules, logs, points, and
related script settings.

---

## Configuration Options

Edit `config.json` to customize behavior, or set `CONFIG_*` environment variables in `compose.yaml` (Docker). Below are all currently available options.

> [!WARNING]
> Rebuild the script (bare metal), or recreate the container (Docker) after all config changes.

### Core

| Setting                     | Type    | Default      | Description                                                        | Docker environment variable           |
| --------------------------- | ------- | ------------ | ------------------------------------------------------------------ | ------------------------------------- |
| `sessionPath`               | string  | `"sessions"` | Directory to store browser sessions                                |                                       |
| `headless`                  | boolean | `false`      | Run browser invisibly                                              | Always `true` in Docker               |
| `clusters`                  | number  | `1`          | Number of concurrent account clusters                              | `CONFIG_CLUSTERS`                     |
| `errorDiagnostics`          | boolean | `false`      | Save error and unknown-login page diagnostics under `diagnostics/` | `CONFIG_ERROR_DIAGNOSTICS`            |
| `ensureStreakProtection`    | boolean | `true`       | Ensure streak protection is enabled                                | `CONFIG_ENSURE_STREAK_PROTECTION`     |
| `autoClaimPunchcardRewards` | boolean | `false`      | Auto-claim completed punchcard rewards                             | `CONFIG_AUTO_CLAIM_PUNCHCARD_REWARDS` |
| `contintueOnBotWarning`     | boolean | `false`      | Continue despite the Microsoft bot-score warning (not recommended) | `CONFIG_CONTINTUE_ON_BOT_WARNING`     |
| `skipNonPointTasks`         | boolean | `true`       | Skip tasks that award no points                                    | `CONFIG_SKIP_NON_POINT_TASKS`         |
| `accountDelay.min`          | string  | `"1min"`     | Minimum delay before starting the next configured account          | `CONFIG_ACCOUNT_DELAY_MIN`            |
| `accountDelay.max`          | string  | `"3min"`     | Maximum delay before starting the next configured account          | `CONFIG_ACCOUNT_DELAY_MAX`            |
| `searchOnBingLocalQueries`  | boolean | `false`      | Use the local query list for ExploreOnBing                         | `CONFIG_SEARCH_ON_BING_LOCAL`         |
| `globalTimeout`             | string  | `"30sec"`    | Timeout for all actions                                            | `CONFIG_GLOBAL_TIMEOUT`               |

### Workers

| Setting                        | Type    | Default | Description                                                                | Docker environment variable          |
| ------------------------------ | ------- | ------- | -------------------------------------------------------------------------- | ------------------------------------ |
| `workers.doDailySet`           | boolean | `true`  | Complete daily set                                                         | `CONFIG_WORKER_DAILY_SET`            |
| `workers.doClaimBonusPoints`   | boolean | `true`  | Claim bonus points                                                         | `CONFIG_WORKER_CLAIM_BONUS_POINTS`   |
| `workers.doMorePromotions`     | boolean | `true`  | Complete "more activities"                                                 | `CONFIG_WORKER_MORE_PROMOTIONS`      |
| `workers.doPunchCards`         | boolean | `true`  | Complete punchcards                                                        | `CONFIG_WORKER_PUNCH_CARDS`          |
| `workers.doAppPromotions`      | boolean | `true`  | Complete app promotions                                                    | `CONFIG_WORKER_APP_PROMOTIONS`       |
| `workers.doDesktopSearch`      | boolean | `true`  | Perform desktop searches                                                   | `CONFIG_WORKER_DESKTOP_SEARCH`       |
| `workers.doMobileSearch`       | boolean | `true`  | Perform mobile searches                                                    | `CONFIG_WORKER_MOBILE_SEARCH`        |
| `workers.doBonusSearches`      | boolean | `false` | Farm bonus searches beyond the cap                                         | `CONFIG_WORKER_BONUS_SEARCHES`       |
| `workers.doDailyCheckIn`       | boolean | `true`  | Complete daily check-in                                                    | `CONFIG_WORKER_DAILY_CHECKIN`        |
| `workers.doReadToEarn`         | boolean | `true`  | Complete Read-to-Earn                                                      | `CONFIG_WORKER_READ_TO_EARN`         |
| `workers.doActivateSearchPerk` | boolean | `true`  | Activate the "search Nx more" perk when present (runs after the daily set) | `CONFIG_WORKER_ACTIVATE_SEARCH_PERK` |
| `workers.doVisualSearch`       | boolean | `false` | Activate the visual-search streak and perform visual searches              | `CONFIG_WORKER_VISUAL_SEARCH`        |

### Activities

| Setting                   | Type    | Default | Description                    | Docker environment variable      |
| ------------------------- | ------- | ------- | ------------------------------ | -------------------------------- |
| `activities.urlReward`    | boolean | `true`  | Complete URL reward activities | `CONFIG_ACTIVITY_URL_REWARD`     |
| `activities.searchOnBing` | boolean | `true`  | Complete ExploreOnBing offers  | `CONFIG_ACTIVITY_SEARCH_ON_BING` |

### Search Settings

| Setting                                | Type     | Default                             | Description                                               | Docker environment variable        |
| -------------------------------------- | -------- | ----------------------------------- | --------------------------------------------------------- | ---------------------------------- |
| `searchSettings.scrollRandomResults`   | boolean  | `false`                             | Scroll randomly on results                                | `CONFIG_SEARCH_SCROLL_RANDOM`      |
| `searchSettings.clickRandomResults`    | boolean  | `false`                             | Click random links                                        | `CONFIG_SEARCH_CLICK_RANDOM`       |
| `searchSettings.runOnZeroPoints`       | boolean  | `false`                             | Run searches even when no search points remain            | `CONFIG_SEARCH_RUN_ON_ZERO_POINTS` |
| `searchSettings.maxBonusSearches`      | number   | `110`                               | Max bonus searches per run (when `doBonusSearches` is on) | `CONFIG_SEARCH_MAX_BONUS_SEARCHES` |
| `searchSettings.parallelSearching`     | boolean  | `true`                              | Run searches in parallel                                  | `CONFIG_SEARCH_PARALLEL`           |
| `searchSettings.clusterSearch`         | boolean  | `true`                              | Cluster each main topic with Bing suggestions             | `CONFIG_SEARCH_CLUSTER`            |
| `searchSettings.queryEngines`          | string[] | see [Query sources](#query-sources) | Sources used to build the search query pool               | `CONFIG_SEARCH_QUERY_ENGINES` \*   |
| `searchSettings.searchResultVisitTime` | string   | `"10sec"`                           | Time to spend on each search result                       | `CONFIG_SEARCH_VISIT_TIME`         |
| `searchSettings.searchDelay.min`       | string   | `"30sec"`                           | Minimum delay between searches                            | `CONFIG_SEARCH_DELAY_MIN`          |
| `searchSettings.searchDelay.max`       | string   | `"1min"`                            | Maximum delay between searches                            | `CONFIG_SEARCH_DELAY_MAX`          |
| `searchSettings.readDelay.min`         | string   | `"30sec"`                           | Minimum delay for reading                                 | `CONFIG_SEARCH_READ_DELAY_MIN`     |
| `searchSettings.readDelay.max`         | string   | `"1min"`                            | Maximum delay for reading                                 | `CONFIG_SEARCH_READ_DELAY_MAX`     |

Desktop and mobile search quotas are tracked independently from the dashboard counters. All `mobileSearch` entries are combined for the mobile quota, while all `pcSearch` entries are combined for desktop execution; a counter explicitly identified as Edge is also shown separately for diagnostics. The script skips only the completed platform, so a completed `60/60` mobile quota does not prevent an incomplete desktop quota from running. With `parallelSearching` enabled, both incomplete quotas can run concurrently in their own browser contexts.

> [!NOTE]
>
> \* Docker `CONFIG_*` array values are comma-separated strings e.g. `"error,warn"`. Regex patterns must be set directly in `config.json`.

#### Query sources

`searchSettings.queryEngines` controls where the main search topics come from. Pick any combination; topics from all selected sources are pooled and de-duplicated. When `searchSettings.clusterSearch` is enabled, each main topic is expanded on demand with Bing suggestions, that topic cluster is shuffled and completed, and only then does searching move to the next main topic.

Core sources:

| Selector     | Source                                           |
| ------------ | ------------------------------------------------ |
| `google`     | Google Trends (trending searches)                |
| `wikipedia`  | Wikipedia most-read articles (previous day)      |
| `wikirandom` | Random Wikipedia articles                        |
| `hackernews` | Hacker News front-page stories                   |
| `reddit`     | Reddit r/popular post titles                     |
| `local`      | Bundled `src/functions/search-queries.json` list |

RSS feeds use a dotted path - `rss` for every feed, `rss.<site>` for a whole site, or `rss.<site>.<endpoint>` for a single feed:

| Selector           | Feeds                                                          |
| ------------------ | -------------------------------------------------------------- |
| `rss.googleTrends` | Google Trends RSS (`gb`, `us`)                                 |
| `rss.googleNews`   | Google News (`gb`, `us`, `world`, `technology`, `business`)    |
| `rss.bbc`          | BBC News (`top`, `world`, `technology`, `business`, `science`) |
| `rss.guardian`     | The Guardian (`international`, `world`, `technology`)          |
| `rss.theVerge`     | The Verge (`all`)                                              |
| `rss.arsTechnica`  | Ars Technica (`all`)                                           |
| `rss.reddit`       | Reddit listing feeds (`popular`, `worldnews`, `technology`)    |

Add your own feeds in `src/constants/rssFeeds.ts`.

Default:

```json
[
    "google",
    "wikipedia",
    "wikirandom",
    "hackernews",
    "reddit",
    "local",
    "rss.googleTrends",
    "rss.googleNews",
    "rss.bbc",
    "rss.guardian.world",
    "rss.theVerge.all"
]
```

### Experimental

Opt-in features that may change. Disabled by default.

| Setting                        | Type    | Default | Description                                                             | Docker environment variable              |
| ------------------------------ | ------- | ------- | ----------------------------------------------------------------------- | ---------------------------------------- |
| `experimental.apiSearch`       | boolean | `false` | Perform Bing searches over HTTP instead of driving a browser page       | `CONFIG_EXPERIMENTAL_API_SEARCH`         |
| `experimental.apiSearchOnBing` | boolean | `false` | Complete ExploreOnBing offers over HTTP instead of the browser          | `CONFIG_EXPERIMENTAL_API_SEARCH_ON_BING` |
| `experimental.blockMedia`      | boolean | `false` | Block post-login browser `image` and `media` requests to reduce traffic | `CONFIG_EXPERIMENTAL_BLOCK_MEDIA`        |
| `experimental.edgeBrowsing`    | boolean | `false` | Report the 30-minute Edge browsing activity as a background HTTP task   | `CONFIG_EXPERIMENTAL_EDGE_BROWSING`      |

When `experimental.blockMedia` is enabled, the automated flow activates it only after authentication has been
verified and the session has been saved. The manual-login flow keeps media enabled throughout; `npm run open-session` still
applies the configured blocker immediately because it opens an already-saved session.

When `experimental.edgeBrowsing` is enabled, the task starts before the normal activity sequence and runs as a separate Promise alongside Daily Set, promotions, app activities, and searches. If foreground work finishes first, the account remains open until this Promise settles. Accounts without the promotion, an access token, or remaining Edge work are skipped immediately.

#### Activity source layout

Standard activities live under `src/functions/activities`, grouped by responsibility:

- `rewards`: Daily Set, More Promotions, Punch Cards, and shared promotion dispatch
- `api`: individual Rewards API actions
- `app`: individual mobile-app activities and App Promotions orchestration
- `search`: browser search flows, search tracking, and shared SearchOnBing behavior
- `visualSearch`: the visual-search activity and its browser transport
- `experimental`: API Search, API SearchOnBing, Edge Browsing, and their supporting transports

Experimental activities live with the other activities under `src/functions/activities/experimental`. The browser-only media blocker lives at `src/browser/MediaBlocker.ts`. `BrowserFunc` contains shared Rewards/browser/session transport only, rather than individual search or visual-search implementations.

> [!NOTE]
> [Playwright documents](https://playwright.dev/docs/api/class-browsercontext#browser-context-route) that request routing disables the browser HTTP cache while routing is active. Image-heavy pages will usually transfer substantially less data with media blocking enabled, but cache-heavy sites are not guaranteed to use less total bandwidth or load faster. Keep this option disabled if a site depends on image/media load events.

> [!NOTE]
> The API paths are faster but depend on the modern dashboard's endpoints. If an ExploreOnBing offer ever fails to be credited, turn `apiSearchOnBing` off to fall back to the browser path.

Regardless of the experimental search settings, normal Rewards actions use the cookies and action data captured during bootstrap without refreshing the visible page. The browser remains idle until a browser-backed search starts. A failed or unacknowledged URL-reward request triggers one context refresh and one retry; successful requests use the balance returned by the server action.

### Logging

| Setting                          | Type     | Default                | Description                       | Docker environment variable     |
| -------------------------------- | -------- | ---------------------- | --------------------------------- | ------------------------------- |
| `debugLogs`                      | boolean  | `false`                | Enable debug logging              | `CONFIG_DEBUG_LOGS`             |
| `consoleLogFilter.enabled`       | boolean  | `false`                | Enable console log filtering      | `CONFIG_LOG_FILTER_ENABLED`     |
| `consoleLogFilter.mode`          | string   | `"whitelist"`          | Filter mode (whitelist/blacklist) | `CONFIG_LOG_FILTER_MODE`        |
| `consoleLogFilter.levels`        | string[] | `["error", "warn"]`    | Log levels to filter              | `CONFIG_LOG_FILTER_LEVELS` \*   |
| `consoleLogFilter.keywords`      | string[] | `["starting account"]` | Keywords to filter                | `CONFIG_LOG_FILTER_KEYWORDS` \* |
| `consoleLogFilter.regexPatterns` | string[] | `[]`                   | Regex patterns for filtering      |                                 |

> [!NOTE]
>
> \* Docker `CONFIG_*` array values are comma-separated strings e.g. `"error,warn"`. Regex patterns must be set directly in `config.json`.

### Proxy

| Setting                         | Type    | Default | Description                                                        | Docker environment variable              |
| ------------------------------- | ------- | ------- | ------------------------------------------------------------------ | ---------------------------------------- |
| `proxy.queryEngine`             | boolean | `true`  | Proxy query engine requests                                        | `CONFIG_PROXY_QUERY_ENGINE`              |
| `proxy.ignoreCertificateErrors` | boolean | `false` | Disable browser TLS certificate verification for intercept proxies | `CONFIG_PROXY_IGNORE_CERTIFICATE_ERRORS` |

Leave `proxy.ignoreCertificateErrors` disabled for normal HTTP(S)/SOCKS proxies. Enabling it weakens TLS protection for the entire browser context and should only be used when a trusted intercepting proxy cannot otherwise present a valid certificate.

`proxy.queryEngine` controls whether query-source HTTP requests use the account HTTP proxy. Set the corresponding `ACCOUNT_N_PROXY_HTTP=true` (and configure `ACCOUNT_N_PROXY_*`) for those HTTP requests to have a proxy available; browser traffic uses `ACCOUNT_N_PROXY_URL` independently.

Account browser proxies support `http://`, `https://`, `socks4://`, and `socks5://` (a bare hostname is treated as HTTP). HTTP(S) proxies may use `ACCOUNT_N_PROXY_USERNAME` and `ACCOUNT_N_PROXY_PASSWORD`; Patchright does not support browser authentication for SOCKS4/SOCKS5 proxies. Invalid protocols, ports, partial credentials, and authenticated SOCKS proxy configurations are rejected during account validation before the browser starts.

### Webhooks

| Setting                                  | Type     | Default                                              | Description                       | Docker environment variable             |
| ---------------------------------------- | -------- | ---------------------------------------------------- | --------------------------------- | --------------------------------------- |
| `webhook.telegram.enabled`               | boolean  | `false`                                              | Enable Telegram webhook           | `CONFIG_TELEGRAM_ENABLED`               |
| `webhook.telegram.botToken`              | string   | `""`                                                 | Telegram bot token                | `CONFIG_TELEGRAM_BOTTOKEN`              |
| `webhook.telegram.chatId`                | string   | `""`                                                 | Telegram chat id                  | `CONFIG_TELEGRAM_CHATID`                |
| `webhook.webhookLogFilter.enabled`       | boolean  | `false`                                              | Enable webhook log filtering      | `CONFIG_WEBHOOK_LOG_FILTER_ENABLED`     |
| `webhook.webhookLogFilter.mode`          | string   | `"whitelist"`                                        | Filter mode (whitelist/blacklist) | `CONFIG_WEBHOOK_LOG_FILTER_MODE`        |
| `webhook.webhookLogFilter.levels`        | string[] | `["error"]`                                          | Log levels to send                | `CONFIG_WEBHOOK_LOG_FILTER_LEVELS` \*   |
| `webhook.webhookLogFilter.keywords`      | string[] | `["starting account", "select number", "collected"]` | Keywords to filter                | `CONFIG_WEBHOOK_LOG_FILTER_KEYWORDS` \* |
| `webhook.webhookLogFilter.regexPatterns` | string[] | `[]`                                                 | Regex patterns for filtering      |                                         |

> [!NOTE]
>
> \* Docker `CONFIG_*` array values are comma-separated strings e.g. `"error,warn"`. Regex patterns must be set directly in `config.json`.

---

## Troubleshooting

> [!TIP]
> Most login issues can be fixed by deleting your /sessions folder, and redeploying the script

### Manual login

Use the manual-login command when an account needs an interactive Microsoft sign-in. It opens the same bundled
patched Chromium browser in headful mode and does not invoke the automated login handler. After you finish signing
in, the command waits until the browser remains on `rewards.bing.com` for five continuous seconds, saves the session,
and closes the browser automatically.

```bash
# Create or refresh the mobile session used at the start of automated runs
npm run manual-login -- --email user@example.com

# Create or refresh only the desktop session
npm run manual-login -- --email user@example.com --platform desktop

# Create mobile and desktop sessions sequentially
npm run manual-login -- --email user@example.com --platform both

# Ignore existing cookies and perform a clean sign-in
npm run manual-login -- --email user@example.com --fresh
```

The email must match an `ACCOUNT_N_EMAIL` entry in `.env`. Existing cookies are restored by default, while `--fresh`
starts without them but retains a compatible saved fingerprint when fingerprint persistence is enabled. The command
uses the selected account's language, region, proxy, proxy credentials, and fingerprint settings from `.env`. For
consistent device identity between the manual and automated browser, enable `ACCOUNT_N_SAVE_FINGERPRINT_MOBILE=true`
and/or
`ACCOUNT_N_SAVE_FINGERPRINT_DESKTOP=true` for the platforms you use.

The session path, global timeout, media-blocking option, and proxy TLS option come from `config.json`. The corresponding
`CONFIG_GLOBAL_TIMEOUT`, `CONFIG_EXPERIMENTAL_BLOCK_MEDIA`, and
`CONFIG_PROXY_IGNORE_CERTIFICATE_ERRORS` environment overrides are also applied after `.env` is loaded. Manual login
forces a visible browser and defers media blocking for the entire interactive authentication flow, even when
`experimental.blockMedia` is enabled. Automated runs resume the configured blocker only after login verification and
session saving, so authentication SVGs, QR codes, and videos cannot be blocked by this option.

Run this command directly on a computer with a graphical desktop and a full Patchright Chromium installation. The
default Docker image contains only the headless browser shell and cannot display this interactive window.

### Session management

The session utility requires an explicit command, so running it without an
argument only displays help and never deletes anything.

```bash
# List stored mobile and desktop sessions
npm run clear-sessions -- list

# Delete the sessions belonging to one account
npm run clear-sessions -- email user@example.com

# Delete every stored session
npm run clear-sessions -- all
```

```bash
# List safe session metadata
curl --request GET \
  --url http://127.0.0.1:3010/sessions \
  --header 'Authorization: Bearer YOUR_API_TOKEN'

# Delete only user@example.com's mobile and desktop sessions
curl --request DELETE \
  --url http://127.0.0.1:3010/sessions/user%40example.com \
  --header 'Authorization: Bearer YOUR_API_TOKEN'
```

See the [Control API session documentation](scripts/api/README.md#session-management)
for response data, Axios examples, and error behavior.

---

## Disclaimer

Use at your own risk.  
Automation of Microsoft Rewards may lead to account suspension or bans.  
This software is provided for educational purposes only.  
The authors are not responsible for any actions taken by Microsoft.

## China tasks-only profile

For the single-account WSL / Windows Docker Desktop setup, see
[中国区每日任务部署说明](docs/china-tasks.md). The supplied Compose profile builds local
source and schedules tasks at 13:00 Asia/Shanghai. `tasksOnly` uses saved manual
login sessions, checks task completion separately from search points, and leaves
ordinary search quota earning disabled. The generic config default remains the
original flow; copy `config.tasks.example.json` for WSL task-mode testing.

In tasks-only mode, an unconfirmed app check-in is checked again after the other
tasks finish, then once per minute up to three times. If the original request
returned a valid successful response and the app service is still available, a
single compensating submission is allowed while the same server reset cycle is
still active. Another three one-minute checks follow if needed. Balance changes
alone never confirm completion. Transport uncertainty, missing streak data and a
changed reset cycle prevent compensation; unresolved results ask for a manual
check. Exclusive reservation files under `reports/app-checkin-recovery/` preserve
the one-compensation-per-account-and-cycle limit across restarts and manual runs.
These checks run inside the task process, without launching another full run.

The Docker daily scheduler also checks on container startup and every five minutes
for a missed run. Before a valid server reset time has been recorded, a fixed daily cron such as
`0 13 * * *` waits until the scheduled time in `TZ`, then runs only if today's
run has not succeeded. Once the Rewards page provides a valid reset timestamp,
the scheduler prioritizes that server cycle, waits one minute after reset, and
uses the five-minute catch-up checks to start eligible work. A local midnight
does not start a new cycle early. Missing reset timestamps fall back to the
fixed schedule; see [中国区部署指南](docs/china-tasks.md) for details. Completion
and attempts are saved atomically in `./config/daily-run-state.json`, so restarts
and container recreation retain them. Missed previous days are not replayed.
An interrupted or failed process can retry after `DAILY_RETRY_MINUTES` (default
30), up to `DAILY_MAX_ATTEMPTS` total attempts per day (default 3). A shared lock
prevents scheduled checks from starting concurrent runs. Success means the task
process exited successfully; it does not guarantee every Microsoft activity was
credited. Manual runs through `run_daily.sh` bypass the daily limit and also save
successful completion; direct `npm start` or API `/start` runs do not update this
scheduler record.

Set `DAILY_CATCH_UP=false` to disable startup and periodic catch-up. `RUN_ON_START=true`
still forces an unconditional startup run. Disabled schedules are respected, and
weekly or multiple-times-per-day cron expressions retain normal cron behavior
without daily catch-up. Saved `config/schedule.json` overrides are restored in both
Docker modes. After updating, rebuild and recreate the container with
`docker compose up -d --build`. The computer's Docker service and this container
must start automatically for startup catch-up to work.
