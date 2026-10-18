import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, shell, powerMonitor } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DesktopService } from './lib/service.mjs'

const directory = path.dirname(fileURLToPath(import.meta.url))
let window
let tray
let service
let quitting = false
let refreshBusy = false
let refreshTimer
const indexFile = path.join(directory, 'out/index.html')

// Keep the same identity across portable/installed builds and future upgrades.
app.setName('Rewards Desktop')
app.setAppUserModelId('org.microsoftrewardsscript.desktop')
const customData = process.argv
    .find(argument => argument.startsWith('--user-data-dir='))
    ?.slice('--user-data-dir='.length)
if (customData) {
    if (!path.isAbsolute(customData)) throw new Error('--user-data-dir 必须是绝对路径')
    fs.mkdirSync(customData, { recursive: true })
    app.setPath('userData', customData)
}
const hasLock = app.requestSingleInstanceLock()
if (!hasLock) app.quit()
else {
    app.on('second-instance', () => showWindow())
    app.on('window-all-closed', () => {})
    app.on('before-quit', event => {
        if (quitting) return
        event.preventDefault()
        quitting = true
        clearInterval(refreshTimer)
        void (async () => {
            try {
                await service?.close()
            } finally {
                tray?.destroy()
                app.quit()
            }
        })()
    })
    void app
        .whenReady()
        .then(bootstrap)
        .catch(error => {
            dialog.showErrorBox('Rewards Desktop 无法启动', error.message)
            app.quit()
        })
}

function showWindow() {
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
}

async function refresh() {
    if (!service || !window || window.isDestroyed() || refreshBusy) return
    refreshBusy = true
    try {
        window.webContents.send('desktop:state', await service.snapshot())
    } catch (error) {
        service.error = error.message
    } finally {
        refreshBusy = false
    }
}

async function bootstrap() {
    const resourceDirectory = app.isPackaged
        ? path.join(process.resourcesPath, 'backend')
        : path.resolve(directory, '..')
    const executable = app.isPackaged ? path.join(resourceDirectory, 'node.exe') : process.env.MRS_DESKTOP_NODE
    if (!executable || !path.isAbsolute(executable) || !fs.existsSync(executable)) {
        throw new Error('开发模式需将 MRS_DESKTOP_NODE 设为 Node.js 24 可执行文件的绝对路径；安装版自动携带 Node.js')
    }
    const setAutoStart = enabled => {
        if (customData) {
            if (enabled) throw new Error('隔离测试数据目录不支持开机启动')
            return
        }
        if (process.platform !== 'win32' || !app.isPackaged) {
            if (enabled) throw new Error('开机启动仅支持已打包的 Windows 应用')
            return
        }
        app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ['--start-in-tray'] })
    }
    service = new DesktopService({
        executable,
        resourceDirectory,
        dataDirectory: app.getPath('userData'),
        version: app.getVersion(),
        setAutoStart
    })
    if (process.platform === 'win32' && app.isPackaged) setAutoStart(service.settings.startOnLogin)
    window = new BrowserWindow({
        width: 1120,
        height: 800,
        minWidth: 820,
        minHeight: 600,
        show: false,
        title: 'Rewards Desktop',
        icon: path.join(directory, 'assets/icon.png'),
        backgroundColor: '#f5f6f8',
        webPreferences: {
            preload: path.join(directory, 'preload.cjs'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    })
    window.removeMenu()
    window.on('close', event => {
        if (!quitting) {
            event.preventDefault()
            window.hide()
        }
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    const icon = nativeImage.createFromPath(path.join(directory, 'assets/icon.png'))
    tray = new Tray(icon.resize({ width: 20, height: 20 }))
    tray.setToolTip('Rewards Desktop · 关闭窗口后继续运行')
    tray.setContextMenu(
        Menu.buildFromTemplate([
            { label: '打开应用', click: showWindow },
            { type: 'separator' },
            { label: '退出并停止任务', click: () => app.quit() }
        ])
    )
    tray.on('double-click', showWindow)
    registerBridge()
    powerMonitor.on('suspend', () => service.scheduler.reset())
    powerMonitor.on('resume', () => {
        service.scheduler.reset()
        service.log('电脑已恢复，将检查当前 Rewards 周期的待执行任务')
    })
    service.on('change', () => void refresh())
    await window.loadFile(indexFile)
    if (!process.argv.includes('--start-in-tray')) showWindow()
    await service.start()
    refreshTimer = setInterval(() => void refresh(), 1500)
    await refresh()
}

function registerBridge() {
    const handlers = {
        snapshot: () => service.snapshot(),
        start: () => service.startRun(),
        stop: () => service.stopRun(),
        login: () => service.login(),
        cancelLogin: () => service.cancelLogin(),
        saveSettings: value => service.saveSettings(value),
        restartBackend: () => service.restartBackend(),
        openDataDirectory: async () => {
            const error = await shell.openPath(service.dataDirectory)
            if (error) throw new Error(error)
        },
        exportDiagnostics: async () => {
            const result = await dialog.showSaveDialog(window, {
                title: '导出脱敏诊断',
                defaultPath: `rewards-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`,
                filters: [{ name: 'Text', extensions: ['txt'] }]
            })
            if (result.canceled) return false
            fs.writeFileSync(result.filePath, service.diagnosticText(), { mode: 0o600 })
            return true
        },
        clearData: async () => {
            const result = await dialog.showMessageBox(window, {
                type: 'warning',
                buttons: ['取消', '清除本地数据'],
                defaultId: 0,
                cancelId: 0,
                message: '清除账号、登录会话、设置、报告和日志？',
                detail: '请先停止任务。清除后需要重新登录。'
            })
            if (result.response !== 1) return false
            await service.clearData()
            return true
        },
        quit: () => app.quit()
    }
    ipcMain.handle('desktop:invoke', async (event, action, value) => {
        if (
            event.sender !== window.webContents ||
            event.senderFrame !== window.webContents.mainFrame ||
            event.senderFrame.url !== pathToFileURL(indexFile).href
        )
            throw new Error('不允许的调用来源')
        if (typeof action !== 'string' || !Object.hasOwn(handlers, action)) throw new Error('不支持的操作')
        if (action !== 'saveSettings' && value !== undefined) throw new Error('此操作不接受参数')
        try {
            return await handlers[action](value)
        } finally {
            void refresh()
        }
    })
}
