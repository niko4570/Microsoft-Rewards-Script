/* global window */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chromium } from 'playwright-core'
import { DesktopService } from '../lib/service.mjs'
import { DesktopHost } from '../lib/host.mjs'

// Browser UI integration with the real desktop Host/Service and an inert task
// backend. No Microsoft login or Rewards request is made.
const root = path.resolve(import.meta.dirname, '../..')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-accounts-ui-'))
const backend = new EventEmitter()
backend.close = async () => {}
const service = new DesktopService({
    executable: process.execPath,
    resourceDirectory: root,
    dataDirectory: directory,
    version: 'test',
    browserDetector: () => ({ installed: [], selected: { id: 'edge', name: 'Edge', executablePath: '' }, error: null }),
    backendFactory: () => backend
})
const host = new DesktopHost({ service, native: async () => {}, version: 'test' })
const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname
    const file = path.resolve(root, 'desktop/out', pathname === '/' ? 'index.html' : '.' + pathname)
    if (!file.startsWith(path.join(root, 'desktop/out') + path.sep) || !fs.existsSync(file)) {
        res.writeHead(404).end()
        return
    }
    res.setHeader(
        'Content-Type',
        file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'
    )
    res.end(fs.readFileSync(file))
})
let browser
try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const launch = { headless: true }
    if (process.env.MRS_UI_BROWSER) launch.executablePath = process.env.MRS_UI_BROWSER
    browser = await chromium.launch(launch)
    const page = await browser.newPage({ viewport: { width: 1120, height: 900 } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.exposeFunction('desktopInvoke', (action, value) => host.invoke(action, value))
    await page.addInitScript(() => {
        window.__TAURI_INTERNALS__ = {
            transformCallback: () => 0,
            invoke: (command, args) =>
                command === 'desktop_invoke' ? window.desktopInvoke(args.action, args.value) : Promise.resolve(0)
        }
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
    })
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByRole('button', { name: '打开浏览器登录', exact: true }).waitFor()
    assert.equal(await page.locator('input[type=email]').count(), 0)
    const runtime = path.join(directory, 'runtime')
    fs.mkdirSync(path.join(runtime, 'scripts/main'), { recursive: true })
    fs.writeFileSync(
        path.join(runtime, 'scripts/main/manualLogin.js'),
        `
        const path = require('node:path'); const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(path.join(process.env.MRS_DATA_DIR, 'sessions/sessions.db'));
        db.exec('CREATE TABLE IF NOT EXISTS sessions(email TEXT, platform TEXT, storage_state TEXT, fingerprint TEXT, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(email,platform))');
        for (const p of ['mobile','desktop']) db.prepare('INSERT INTO sessions(email,platform,storage_state) VALUES(?,?,?)').run(process.env.ACCOUNT_1_EMAIL, p, JSON.stringify({ cookies: [{ name: 'account', value: process.env.ACCOUNT_1_EMAIL }] }));
        db.close(); process.exit(0);
    `
    )
    service.resourceDirectory = runtime
    service.resetScanner = async () => ({ balance: service.activeAccount.name === '账户 1' ? 10 : 20 })
    await page.getByRole('button', { name: '打开浏览器登录', exact: true }).click()
    await new Promise(resolve => (service.loginChild ? service.loginChild.once('close', resolve) : resolve()))
    await host.refresh()
    await page.evaluate(async () => {
        const snapshot = await window.desktop.snapshot()
        // The smoke transport has no Tauri event delivery. Publish via a normal UI refresh below.
        return snapshot.accounts.length
    })
    await page.getByRole('button', { name: '重新检测', exact: true }).click()
    await page.getByRole('tab', { name: '账户 1', exact: true }).waitFor()
    await page.getByRole('button', { name: '＋ 添加其他账户', exact: true }).click()
    await new Promise(resolve => (service.loginChild ? service.loginChild.once('close', resolve) : resolve()))
    await page.getByRole('button', { name: '重新检测', exact: true }).click()
    await page.getByRole('tab', { name: '账户 2', exact: true }).waitFor()
    assert.equal(service.settings.accounts.length, 2)
    await page.getByRole('button', { name: '刷新总余额', exact: true }).click()
    await page.getByText('总余额已更新', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('所有账户总余额').locator('strong').textContent(), '30')
    assert.equal(await page.locator('.account-row').count(), 1)
    await page.getByRole('tab', { name: '账户 1', exact: true }).click()
    await page.getByRole('heading', { name: '账户 1', exact: true }).waitFor()
    await page.getByRole('button', { name: '停用', exact: true }).click()
    await page.getByRole('button', { name: '启用', exact: true }).waitFor()
    assert.equal(service.settings.accounts[0].enabled, false)
    for (const [index, account] of service.settings.accounts.entries()) {
        fs.writeFileSync(
            path.join(directory, 'reports', `tasks-abcdef123456-${index}.json`),
            JSON.stringify({
                account: account.email,
                startedAt: new Date().toISOString(),
                tasks: []
            })
        )
    }
    await page.getByRole('button', { name: '重新检测', exact: true }).click()
    await page.getByRole('button', { name: '应用设置', exact: true }).click()
    await page.getByLabel('按电脑系统日期每天自动运行').check()
    await page.getByRole('button', { name: '保存设置', exact: true }).click()
    await page.getByText('设置已保存', { exact: true }).waitFor()
    assert.equal(service.settings.schedule.enabled, true)
    await page.getByRole('button', { name: '运行结果', exact: true }).click()
    await page.getByLabel('筛选报告账号').waitFor()
    assert.equal(await page.locator('.report-heading').count(), 2)
    await page.getByLabel('筛选报告账号').selectOption(service.settings.accounts[0].email)
    assert.equal(await page.locator('.report-heading').count(), 1)
    assert.match(await page.locator('.report-heading').innerText(), /账户 1/)
    await page.getByRole('button', { name: '任务总览', exact: true }).click()
    // Legacy fallback and in-flight queue: only the presentation name is editable.
    const first = service.settings.accounts[0]
    service.settings = {
        ...service.settings,
        accounts: service.settings.accounts.map(a =>
            a.id === first.id ? { ...a, email: 'local@rewards.invalid', name: '' } : a
        )
    }
    await page.getByRole('button', { name: '重新检测', exact: true }).click()
    await page.getByRole('tab', { name: '账户 1', exact: true }).click()
    assert.equal(await page.getByText('原有账户', { exact: true }).count(), 0)
    service.queue = { running: true, currentId: first.id, items: [{ id: first.id, status: 'running', error: null }] }
    const queue = service.queue
    await page.getByRole('button', { name: '重新检测', exact: true }).click()
    await page.getByRole('heading', { name: '队列运行中', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '修改备注', exact: true }).isEnabled(), true)
    assert.equal(await page.getByRole('button', { name: '移除', exact: true }).isDisabled(), true)
    page.once('dialog', dialog => void dialog.accept('运行时备注'))
    await page.getByRole('button', { name: '修改备注', exact: true }).click()
    await page.getByRole('tab', { name: '运行时备注', exact: true }).waitFor()
    assert.equal(service.settings.accounts[0].name, '运行时备注')
    assert.equal(service.settings.accounts[0].enabled, false)
    assert.equal(service.queue, queue)
    assert.equal(queue.running, true)
    service.queue = null
    await page.screenshot({ path: path.join(directory, 'accounts.png'), fullPage: true })
    const screenshot = process.env.MRS_UI_SCREENSHOT
    if (screenshot) fs.copyFileSync(path.join(directory, 'accounts.png'), screenshot)
    assert.deepEqual(errors, [])
    console.log(
        'PASS: multi-account React UI → bridge → Host → Service; browser login, independent slots, tabs, total balance, global settings, report filter'
    )
} finally {
    await browser?.close()
    await service.close()
    await new Promise(resolve => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
}
