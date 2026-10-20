import fs from 'node:fs'
/* global window */
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.resolve(directory, '../package.json'))
const { _electron } = require('patchright')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-electron-smoke-'))
const packaged = process.env.MRS_PACKAGED_EXECUTABLE
const electronBinary =
    packaged ||
    (process.platform === 'win32'
        ? path.join(directory, 'node_modules/electron/dist/electron.exe')
        : path.join(directory, 'node_modules/electron/dist/electron'))
let application
try {
    application = await _electron.launch({
        executablePath: electronBinary,
        args: [
            ...(packaged ? [] : [directory]),
            `--user-data-dir=${data}`,
            ...(process.platform === 'linux' ? ['--no-sandbox'] : [])
        ],
        env: { ...process.env, MRS_DESKTOP_NODE: packaged ? 'not-a-system-node' : process.execPath },
        timeout: 30000
    })
    const page = await application.firstWindow()
    await page.getByRole('heading', { name: '任务总览', exact: true }).waitFor()
    await page.getByText('本地服务已连接').waitFor()
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
    const preferences = await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    )
    assert.equal(preferences.contextIsolation, true)
    assert.equal(preferences.nodeIntegration, false)
    assert.equal(preferences.sandbox, true)
    assert.equal(await page.getByLabel('账号邮箱').count(), 0)
    assert.equal(await page.getByRole('button', { name: '打开浏览器登录', exact: true }).isDisabled(), false)
    await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
            "window.desktop.saveSettings({ email: 'smoke@example.com', schedule: { enabled: false }, startOnLogin: false })"
        )
    )
    await page.getByRole('button', { name: '应用设置', exact: true }).click()
    assert.equal(await page.getByLabel('账号邮箱').count(), 0)
    assert.equal(await page.locator('input[type=time]').count(), 0)
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '设置已保存' }).waitFor()
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'desktop.json'), 'utf8')).email, 'smoke@example.com')
    const installer = 'smoke installer'
    const updateFile = path.join(data, 'smoke-update.exe')
    await application.evaluate(
        ({ net, dialog }, fixture) => {
            const originalFetch = net.fetch
            const originalDialog = dialog.showSaveDialog
            globalThis.restoreUpdateSmoke = () => {
                net.fetch = originalFetch
                dialog.showSaveDialog = originalDialog
            }
            const base = 'https://github.com/niko4570/Microsoft-Rewards-Script/releases/download/desktop-v999.0.0/'
            const name = 'Rewards-Desktop-999.0.0-x64.exe'
            net.fetch = async url => {
                if (url.startsWith('https://api.github.com/'))
                    return Response.json([
                        {
                            tag_name: 'desktop-v999.0.0',
                            assets: [name, 'SHA256SUMS.txt'].map(file => ({
                                name: file,
                                state: 'uploaded',
                                size: fixture.installer.length,
                                browser_download_url: base + file
                            }))
                        }
                    ])
                if (url.endsWith('SHA256SUMS.txt')) return new Response(`${fixture.digest}  ${name}\n`)
                return new Response(fixture.installer)
            }
            dialog.showSaveDialog = async () => ({ canceled: false, filePath: fixture.updateFile })
        },
        { installer, updateFile, digest: createHash('sha256').update(installer).digest('hex') }
    )
    try {
        await page.getByRole('button', { name: '检查更新', exact: true }).click()
        await page.getByText('发现新版本 v999.0.0', { exact: true }).waitFor()
        await page.getByRole('button', { name: '下载新版安装包', exact: true }).click()
        await page.getByText('v999.0.0 下载完成，SHA256 校验通过。请退出应用后运行安装包。', { exact: true }).waitFor()
        assert.equal(fs.readFileSync(updateFile, 'utf8'), installer)
        assert.equal(await page.getByRole('button', { name: '打开下载位置', exact: true }).count(), 1)
    } finally {
        await application.evaluate(() => {
            globalThis.restoreUpdateSmoke()
            delete globalThis.restoreUpdateSmoke
        })
    }
    await page.getByRole('button', { name: '任务总览', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: '开始任务', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: '运行结果', exact: true }).click()
    await page.getByRole('heading', { name: '还没有运行报告' }).waitFor()
    await page.getByRole('button', { name: '实时日志', exact: true }).click()
    await page.getByLabel('运行日志').waitFor()
    const screenshot = process.env.MRS_SMOKE_SCREENSHOT || path.join(os.tmpdir(), 'rewards-desktop-smoke.png')
    await page.screenshot({ path: screenshot })
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false)
    console.log(
        `Electron UI, real backend, settings persistence, sandbox and close-to-tray: PASS\nScreenshot: ${screenshot}`
    )
} finally {
    await application?.close()
    fs.rmSync(data, { recursive: true, force: true })
}
