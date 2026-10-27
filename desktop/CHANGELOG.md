# 0.2.0 — 开发中，尚未发布

- 桌面任务、登录、余额与重置扫描统一使用系统 Chrome / Edge；取消内置 Chromium。
- 新增自动/指定浏览器选择、缺失提示、官方下载和重新检测，保留独立会话及旧设置兼容。
- Windows 打包验收覆盖两种系统浏览器的有窗口和无窗口启动，拒绝携带浏览器缓存。

- 将 Electron 外壳替换为 Tauri 2 / Windows WebView2 Evergreen，复用 React 界面和 Node 任务核心。
- 关闭窗口销毁 WebView，托盘继续运行；再次打开时恢复设置和后台状态。
- 保留原用户数据目录、登录入口、服务端周期调度、报告、诊断与更新校验。
- 使用私有管道连接桌面管理进程，Windows Job Object 回收异常退出后的后台进程树。
- 更新 Windows NSIS / 便携打包与 WebView2 冒烟检查；Windows 和真实账号验收仍需重新执行。

# Rewards Desktop changelog

## 0.1.9 — 2026-10-20

- 在应用设置中检查 GitHub 桌面新版本，直接下载安装包，显示下载进度并校验 SHA256。
- 下载失败可重试，校验失败不会覆盖已有文件；下载完成后可打开文件位置，退出应用后手动安装。
- 匹配版本的 `desktop-vX.Y.Z` 标签通过 Windows 打包验证后，自动发布安装包、便携包、源码与校验文件。
- 新增 Windows 云端安装版验收及复用既有打包产物的独立检查流程。0.1.9 已通过云端构建、打包、安装及移除开发工具 PATH 后的运行环境和界面检查；真实账号登录/任务未在本轮云端验收中执行。

## 0.1.8

- Recheck unconfirmed app check-in after other tasks, then up to three times at one-minute intervals.
- Allow one compensating submission per account and reset cycle when the original response was acknowledged and the app service remains available.
- Persist the compensation reservation across restarts and manual runs; stop compensation when the response, streak state, or reset cycle is uncertain.
- Verify completion from page state and avoid treating a balance increase as confirmed check-in.
- Pass 48 task tests, 33 desktop tests, and Windows runtime and packaged UI checks. 签到自动恢复已完成实际验证（用户确认）。

## 0.1.7

- 修复自动扫描仅检查每日连胜、遗漏普通积分卡片的问题；连胜完成后仍会检查当天可执行的积分任务。
- 尚未自动运行的周期每 5 分钟检查新增任务；保持每周期最多自动运行一次和服务端重置后的缓冲。
- 更新自动运行状态及休眠恢复提示。

## 0.1.6

- 应用内部会话索引不再作为真实邮箱传入 OAuth 登录提示；真实邮箱仍保留登录提示。

## 0.1.4

- 移除登录前的邮箱输入，直接打开浏览器登录；应用内部管理会话索引，并保留已有账号的会话。
- 修复登录调用携带参数时被桌面主进程拒绝的问题，并补充会话索引兼容与 IPC 回归检查。

## 0.1.3

- 邮箱输入移至登录会话，自动运行设置无需再次填写账号。
- 移除固定执行时间，打开应用、登录完成及休眠恢复后只读检查 Rewards 每日任务状态与服务端重置时间。
- 当前周期未完成则自动运行；已完成则等服务端重置一分钟后检查。读取失败五分钟后重试。
- 按账号和重置周期持久记录自动启动，避免重启及启动响应丢失导致重复运行。
- 打包并检查新的只读扫描入口；自动运行开关初始关闭，开启后需保持托盘运行。

## 0.1.2

- 登录和后台任务统一使用完整 Chromium，有窗口与无窗口模式共用同一套浏览器文件。
- 不再下载或打包 Chromium Headless Shell；构建时仅复制锁定版本的完整浏览器及必要辅助程序。
- 打包前后均验证两种浏览器模式，并检查包中没有额外的 Headless Shell。

## 0.1.1

- 修复 Windows 分发包遗漏后端 `node_modules`，导致手动登录报 `ERR_MODULE_NOT_FOUND: fingerprint-generator` 的问题。
- 打包后检查真实登录入口、全部直接生产依赖、SQLite、原生依赖、浏览器和 API，避免仅后台启动成功掩盖依赖缺失。

## 0.1.0

- 新增中文桌面界面，支持单账号每日任务、手动浏览器登录、任务控制和持久报告。
- 新增独立用户数据目录、脱敏日志和诊断导出。
- 新增托盘每日调度，不补跑、不自动重试；支持选择登录 Windows 后启动。
- 新增 Windows x64 运行依赖准备、冒烟检查、NSIS/ZIP 打包和 CI 产物。
- Windows 人工安装、真实账号任务、朋友试用与 0.1.1 升级验收尚需实际完成。
- Windows 11 的开发窗口与打包程序检查、18 项桌面测试及携带的运行依赖检查通过；NSIS/ZIP 和对应源码已生成。
