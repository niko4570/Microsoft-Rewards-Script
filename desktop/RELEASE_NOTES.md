# Rewards Desktop 0.1.9

Windows x64 桌面版，内置 Node.js 和 Chromium，无需安装 Git、Node.js、Docker 或 WSL。

## 下载

请展开本发布页下方的 **Assets**：

- **安装版**：`Rewards-Desktop-0.1.9-x64.exe`，推荐首次使用。
- **便携版**：`Rewards-Desktop-0.1.9-x64.zip`，解压后运行 `Rewards Desktop.exe`。
- **校验文件**：`SHA256SUMS.txt`，用于核对发布文件的 SHA-256。
- **对应源码**：`rewards-desktop-source.zip`，用于查看或自行构建。

GitHub 自动生成的 **Source code (zip/tar.gz)** 是源码，不是桌面应用。

## 本次更新

- 设置页新增检查更新、下载安装包、下载进度和 SHA-256 校验。
- 下载失败可重试，校验失败不会覆盖已有文件；下载后可打开文件位置。
- 新增 Linux、Windows 双平台 push/PR CI，以及 Windows 云端打包和安装后启动验收。
- 发布文件直接附在本页 Assets 中。

## 安装与升级

**本版本未进行代码签名**，Windows 可能显示未知发布者或安全提示。请使用本仓库的发布文件并核对 SHA-256，无需关闭系统防护。

升级前从托盘退出旧版并备份 `%APPDATA%\Rewards Desktop`；安装版沿用原安装目录。
便携版解压到新目录。下载更新后需退出应用并手动安装，不会自动执行安装程序。
0.1.8 及更早版本首次升级到 0.1.9 需从本页手动下载。

## 验证范围

- Linux、Windows CI 的构建、ESLint、任务、调度、日志及桌面测试已通过。
- 0.1.9 已通过 Windows 云端打包及实际安装、内置 Chromium、后台 API 和界面检查；安装后启动验证排除了应用 PATH 中的 Node.js、npm、Git、Docker。
- 签到自动恢复和无人值守运行已获用户实际验证确认。
- 云端使用 Windows Server 2025，未在云端执行真实账号登录或积分任务。
- 干净 Windows 11 首次使用、升级回滚及真实新版更新安装链路仍待进一步验收。

当前桌面支持范围为中国区域单账号、Windows x64；其他地区、多账号及其他 Windows 版本尚未完成验证。任务结束不代表所有任务完成或积分到账。

本项目是 TheNetsky/Microsoft-Rewards-Script 的 fork，沿用 GPL-3.0-or-later；Assets 包含对应源码。

[完整使用指南](https://github.com/niko4570/Microsoft-Rewards-Script/blob/desktop-v0.1.9/docs/windows-desktop.md)
