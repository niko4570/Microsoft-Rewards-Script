# 中国区任务模式：WSL 测试与 Windows Docker Desktop 部署

此模式每天北京时间 13:00 先应用签到、搜索打卡，再读取当天的每日活动。

任务模式从当前 `/earn` 和 `/dashboard` 页面读取余额、活动和打卡状态，不再依赖旧的 `api/getuserinfo` 或 Bing 弹窗接口。缺失的积分和印章保持“无法核验”；没有返回当天活动列表时，只有页面明确标记当天每日打卡已完成，才报告完成。
只执行任务需要的搜索，不获取额外电脑或移动搜索积分。未知类型、未解锁任务和需要验证的任务会报告原因。
搜索打卡必须能读取当天剩余次数；无法确定要求时不会猜测次数。
每日活动连续打卡要等每日活动完成后才能核验，不能在活动之前提前完成。

## WSL 首次配置

需要 Node.js 24+、WSLg 或可用图形桌面。以下命令会安装浏览器和构建程序，但不会执行积分任务：

```bash
npm ci
npm run install:browser
cp config.tasks.example.json config.json
cp env.example .env
npm run build
```

在 `.env` 中配置单个账户和 Telegram。密码、TOTP 不需要配置，任务模式只复用手动登录会话。

```dotenv
ACCOUNT_1_EMAIL=你的邮箱
ACCOUNT_1_GEO_LOCALE=CN
ACCOUNT_1_LANG_CODE=zh-CN
ACCOUNT_1_SAVE_FINGERPRINT_MOBILE=true
ACCOUNT_1_SAVE_FINGERPRINT_DESKTOP=true
TZ=Asia/Shanghai
CONFIG_TELEGRAM_ENABLED=true
CONFIG_TELEGRAM_BOTTOKEN=你的机器人令牌
CONFIG_TELEGRAM_CHATID=你的聊天ID
```

先在 Telegram 中打开自己的机器人并发送 `/start`。令牌和聊天 ID 只保存在本地，不提交到 Git。

```bash
npm run manual-login -- --email 你的邮箱 --platform both
```

浏览器窗口中手动完成登录和验证。该命令不会执行奖励任务。
手动登录会话与应用授权不是同一回事：如果应用令牌无法获取，程序会通知你核对应用授权；不能保证一次网页登录会解决应用授权问题。

确认配置后，以下命令会执行真实账户任务：

```bash
TZ=Asia/Shanghai npm start
```

核对 Rewards 页面当天的完成标记、签到、搜索打卡及印章，与 `reports/` 中的 JSON 报告对比。
完成状态以微软返回的状态为准，余额增加不代表所有打卡完成。建议跨七天检查连续进度。

## Windows Docker Desktop

启用 Docker Desktop 的 Linux 容器及 WSL 集成，在这个 repo 所在目录执行：

```bash
docker compose build
# 首次部署或更换配置时，把 WSL 测试使用的配置放入容器挂载目录。
mkdir -p config
cp config.tasks.example.json config/config.json
docker compose up -d
```

已有 `config/config.json` 时先备份再决定是否替换。会话目录 `sessions/`、配置目录 `config/` 和报告目录 `reports/` 均使用挂载，重建容器不会删除它们。
当前 Compose 使用本地镜像，地区 CN、语言 zh-CN、时区 Asia/Shanghai，调度 `0 13 * * *`。
关闭无条件启动执行和调度前随机等待。每天北京时间 13:00 执行；容器启动时和每 5 分钟检查当天是否漏跑。13:00 前等待，13:00 后尚未成功则补跑；当天成功后，重启也不会重复自动执行。

执行状态保存在挂载目录 `config/daily-run-state.json`，只补跑当天，不补历史日期。失败或中断后至少等待 30 分钟再尝试，每天最多 3 次（含首次）；可通过 `DAILY_RETRY_MINUTES` 和 `DAILY_MAX_ATTEMPTS` 调整。`DAILY_CATCH_UP=false` 可关闭补跑。这里的成功指任务进程成功退出，具体活动是否到账以任务报告为准。

脚本从 Rewards 页面“每日连胜重置”的倒计时组件读取 `expiresAt` 精确时间戳，写入任务报告和调度状态的 `nextStreakResetAt`，并在中文摘要中显示北京时间。已读取时间后，固定每日调度优先等待微软提供的重置时间，再留 1 分钟缓冲，由每 5 分钟的补跑检查触发新周期；本地跨过零点不会提前启动。新周期重置尝试计数，失败仍遵守冷却和最多 3 次限制。页面没有有效时间戳时明确报告无法核验，回退原定时规则，不猜测 16:00；手动运行仍可核验当前状态。首次运行尚未取得时间时使用原定时规则。

补跑依赖 Docker Desktop 和容器随电脑启动。休眠恢复后，已运行的容器也会在后续检查时补跑。
Windows 需保持唤醒，Docker Desktop 和容器需处于运行状态，容器不会唤醒主机。
定时任务以镜像内 `node` 用户（UID 1000）运行，匹配当前 WSL 仓库所有者，避免报告和会话变成 root 所有。
入口程序仍以 root 配置 cron；Telegram 凭据在启动日志中隐藏。
WSL 集成刚开启后若提示 Docker 套接字权限不足，重新打开 WSL 终端；当前用户已属于 `docker` 组时也可使用 `sg docker -c 'docker compose ps'`。

```bash
docker compose logs --tail=100 -f
# 以下命令手动执行真实任务，绕过定时等待。
docker compose exec microsoft-rewards-script bash scripts/docker/run_daily.sh
```

需要重新登录时，在 WSL 再运行 `manual-login`，会话写入同一个挂载目录，然后手动重试。
默认 Docker 镜像只有无头浏览器，不在容器内显示登录窗口。

## 通知、核验与限制

每次运行发送中文 Telegram 摘要，列出完成、跳过、失败、待确认及人工事项，并记录积分变化、打卡和可读取的印章进度。登录失效或账户警告会终止相关运行并发送通知。
报告保留最近 30 天。任务类型支持范围仍以原 repo 的处理器为准；卡片奖励默认不自动领取。
普通网页签到、应用签到、每日活动与搜索打卡分别核验；未读到状态时明确报告无法确认。
Telegram 发送失败写入本地日志。首次实测需确认容器网络能够访问 Telegram；中国网络环境下如不可达，应在主机网络层配置可访问的出口，不更改账户地区。不要把 Telegram 网络需求误当成需要改变 Rewards 地区。
不会自动兑换礼品、不扩展未知任务类型、不启用实验性的 API 搜索、视觉搜索或 Edge 浏览任务。

旧配置未开启 `tasksOnly` 时保留旧流程。今后若需要额外搜索积分，应明确评估后再调整模式；仅开启普通搜索 worker 不会在 tasksOnly 模式下执行额度搜索。

## 本地验证

```bash
npm run test:tasks
npm run test:log-parser
npm run lint
```

模拟测试不访问账户、不执行积分任务、不发送真实 Telegram 消息。
