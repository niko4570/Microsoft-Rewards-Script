import fs from 'node:fs'
/* global window */
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') throw new Error('Tauri WebView2 UI smoke requires Windows')
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.resolve(directory, '../package.json'))
const { chromium } = require('patchright')
// Patchright evaluates in an isolated world by default; inspect the app's actual realm.
const mainWorld = (page, operation) => page.evaluate(operation, undefined, false)
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-tauri-smoke-'))
// Seed an existing account slot to check upgrade persistence without opening login.
fs.writeFileSync(
    path.join(data, 'desktop.json'),
    JSON.stringify({ email: 'smoke@example.com', schedule: { enabled: false }, startOnLogin: false })
)
const executable =
    process.env.MRS_PACKAGED_EXECUTABLE || path.join(directory, 'src-tauri/target/debug/rewards-desktop.exe')
const portProbe = net.createServer()
portProbe.listen(0, '127.0.0.1')
await once(portProbe, 'listening')
const port = portProbe.address().port
await new Promise(resolve => portProbe.close(resolve))
const args = [`--user-data-dir=${data}`]
const env = {
    ...process.env,
    MRS_DESKTOP_NODE: process.env.MRS_PACKAGED_EXECUTABLE ? 'not-a-system-node' : process.execPath,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`
}
const policyState = path.join(data, 'webview2-test-policy.json')
function testPolicy(mode) {
    const result = spawnSync(
        'powershell.exe',
        [
            '-NoProfile',
            '-NonInteractive',
            '-File',
            path.join(directory, 'build/webview2-debug-policy.ps1'),
            '-Mode',
            mode,
            '-Executable',
            executable,
            '-Port',
            String(port),
            '-StateFile',
            policyState
        ],
        { encoding: 'utf8', timeout: 15000, windowsHide: true }
    )
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`WebView2 test policy ${mode} failed: ${result.stderr || result.stdout}`)
    console.log(result.stdout.trim())
}
let child
let browser
let output = ''
let connectionError = ''
try {
    if (process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Windows') testPolicy('enable')
    child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let launchError
    child.on('error', error => {
        launchError = error
    })
    child.stderr.on('data', chunk => {
        output += chunk
    })
    for (let attempt = 0; attempt < 120; attempt++) {
        if (launchError) throw launchError
        if (child.exitCode !== null) throw new Error(`Tauri exited (${child.exitCode}): ${output}`)
        try {
            browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 })
            break
        } catch (error) {
            connectionError = String(error.message || error)
            await new Promise(resolve => setTimeout(resolve, 500))
        }
    }
    if (!browser) throw new Error(`WebView2 debug endpoint unavailable: ${connectionError}\n${output}`)
    async function findPage() {
        for (let attempt = 0; attempt < 120; attempt++) {
            const page = browser
                .contexts()
                .flatMap(context => context.pages())
                .find(page => page.url().includes('tauri.localhost'))
            if (page) return page
            await new Promise(resolve => setTimeout(resolve, 250))
        }
        throw new Error('Tauri application page did not appear')
    }
    let page = await findPage()
    await page.getByRole('heading', { name: '任务总览', exact: true }).waitFor({ timeout: 45000 })
    await page.getByText('本地服务已连接').waitFor()
    assert.equal(await mainWorld(page, () => typeof window.require), 'undefined')
    assert.equal(await mainWorld(page, () => typeof window.process), 'undefined')
    assert.equal(await page.getByLabel('账号邮箱').count(), 0)
    await mainWorld(page, () =>
        window.desktop.saveSettings({ email: 'smoke@example.com', schedule: { enabled: false }, startOnLogin: false })
    )
    await assert.rejects(
        mainWorld(page, () => window.desktop.login('unexpected argument')),
        /此操作不接受参数/
    )
    await page.getByRole('button', { name: '应用设置', exact: true }).click()
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '设置已保存' }).waitFor()
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'desktop.json'), 'utf8')).email, 'smoke@example.com')
    await page.getByRole('button', { name: '任务总览', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: '开始任务', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: '运行结果', exact: true }).click()
    await page.getByRole('heading', { name: '还没有运行报告' }).waitFor()
    await page.getByRole('button', { name: '实时日志', exact: true }).click()
    await page.getByLabel('运行日志').waitFor()
    const screenshot = process.env.MRS_SMOKE_SCREENSHOT || path.join(os.tmpdir(), 'rewards-desktop-smoke.png')
    await page.screenshot({ path: screenshot })
    const closed = page.waitForEvent('close', { timeout: 10000 })
    await mainWorld(page, () => {
        void window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' })
    })
    await closed
    assert.equal(child.exitCode, null, 'Closing the WebView must keep the scheduler alive')
    const second = spawn(executable, args, { env, stdio: 'ignore' })
    await once(second, 'exit')
    assert.equal(second.exitCode, 0)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 })
    page = await findPage()
    await page.getByText('本地服务已连接').waitFor()
    assert.equal((await mainWorld(page, () => window.desktop.snapshot())).settings.email, 'smoke@example.com')
    const exited = once(child, 'exit')
    await mainWorld(page, () => {
        void window.desktop.quit()
    })
    await Promise.race([
        exited,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Tauri shutdown timed out')), 45000).unref())
    ])
    assert.equal(child.exitCode, 0)
    console.log(
        `Tauri WebView2, real backend, settings, destroyed/recreated window, single instance and graceful exit: PASS\nScreenshot: ${screenshot}`
    )
} catch (error) {
    const evidence = [String(error.stack || error), `App stderr: ${output}`]
    const diagnostics = spawnSync(
        'powershell.exe',
        [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Get-Process -Id ${child?.pid || 0} -ErrorAction SilentlyContinue | Select-Object Id,MainWindowTitle,Responding | ConvertTo-Json -Compress; Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${child?.pid || 0} -or $_.Name -eq 'msedgewebview2.exe' } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`
        ],
        { encoding: 'utf8', timeout: 15000, windowsHide: true }
    )
    evidence.push(`Windows processes: ${diagnostics.stdout || diagnostics.stderr || diagnostics.error || ''}`)
    const logs = path.join(data, 'logs')
    if (fs.existsSync(logs)) {
        for (const name of fs.readdirSync(logs).filter(name => name.endsWith('.log'))) {
            evidence.push(
                `${name}:\n${fs.readFileSync(path.join(logs, name), 'utf8').split('\n').slice(-25).join('\n')}`
            )
        }
    }
    fs.mkdirSync(path.join(directory, 'release'), { recursive: true })
    fs.writeFileSync(path.join(directory, 'release/ui-smoke-failure.txt'), evidence.join('\n\n'))
    console.error(evidence.join('\n\n'))
    throw error
} finally {
    if (child && child.exitCode === null)
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    if (fs.existsSync(policyState)) testPolicy('restore')
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })
}
