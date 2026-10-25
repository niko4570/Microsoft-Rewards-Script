import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { DesktopService } from '../lib/service.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
class FakeBackend extends EventEmitter {
    constructor() {
        super()
        this.endpoint = 'local'
        this.state = 'idle'
        this.starts = 0
        this.sessions = []
    }
    async start() {
        this.endpoint = 'local'
    }
    async close() {
        this.endpoint = null
        this.state = 'idle'
    }
    async request(route) {
        if (route === '/status') return { state: this.state }
        if (route === '/sessions') return { sessions: this.sessions }
        if (route === '/start') {
            this.state = 'running'
            this.starts++
            return {}
        }
        if (route === '/stop') {
            this.state = 'idle'
            return {}
        }
        throw new Error(`unexpected route: ${route}`)
    }
}
function fixture(t, savedSettings) {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-service-'))
    if (savedSettings) fs.writeFileSync(path.join(dataDirectory, 'desktop.json'), JSON.stringify(savedSettings))
    const backend = new FakeBackend()
    const service = new DesktopService({
        executable: process.execPath,
        resourceDirectory: root,
        dataDirectory,
        version: '0.1.0',
        backendFactory: () => backend
    })
    t.after(async () => {
        await service.close()
        fs.rmSync(dataDirectory, { recursive: true, force: true })
    })
    return { service, backend, dataDirectory }
}

test('mode changes persist, restart the backend, and cannot happen during a run', async t => {
    const { service, backend } = fixture(t)
    let restarts = 0
    backend.start = async () => {
        backend.endpoint = 'local'
        restarts++
    }
    await service.saveSettings({ ...service.settings, mode: 'tasks-search' })
    assert.equal(restarts, 1)
    assert.equal(JSON.parse(fs.readFileSync(path.join(service.dataDirectory, 'desktop.json'))).mode, 'tasks-search')
    backend.state = 'running'
    await assert.rejects(service.saveSettings({ ...service.settings, mode: 'tasks' }), /正在运行/)
    assert.equal(service.settings.mode, 'tasks-search')
    backend.state = 'idle'
    await service.saveSettings({ ...service.settings, mode: 'tasks' })
    assert.equal(restarts, 2)
    assert.equal(service.settings.mode, 'tasks')
})

test('startup with saved automatic settings runs point cards even when streaks are complete', async t => {
    const require = createRequire(import.meta.url)
    const ReactFunc = require('../../dist/browser/ReactFunc.js').default
    const { hasPendingEarnTasks } = require('../../dist/functions/TaskPolicy.js')
    const { service, backend } = fixture(t, {
        email: 'person@example.com',
        startOnLogin: true,
        schedule: { enabled: true }
    })
    backend.sessions = ['mobile', 'desktop'].map(platform => ({
        email: 'person@example.com',
        platform,
        hasStorageState: true
    }))
    const objects = [
        { balance: 123, level: 1 },
        { partner: 'dailyset', dailyPoints: [5], isCurrentDayCompleted: true },
        { offerId: 'point-card', hash: 'signed', points: 5, destination: 'https://www.bing.com/search?q=test' }
    ]
    const html = `<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify(objects))}])</script>`
    const snapshot = new ReactFunc({
        logger: { info() {}, debug() {}, warn() {}, error() {} },
        isMobile: false
    }).snapshotPage(html)
    service.resetScanner = async () => ({
        nextStreakResetAt: new Date(Date.now() + 3600000).toISOString(),
        pending: hasPendingEarnTasks(snapshot, '10/14/2026')
    })
    await service.start()
    while (service.scheduler.busy) await new Promise(resolve => setImmediate(resolve))
    assert.equal(backend.starts, 1)
    assert.match(service.scheduler.message, /自动任务已启动/)
})

test('manual and scheduled starts share the same gate and require both sessions', async t => {
    const { service, backend } = fixture(t)
    await assert.rejects(service.startRun(), /设置账号/)
    await service.saveSettings({ ...service.settings, email: 'person@example.com' })
    await assert.rejects(service.startRun(), /会话登录/)
    backend.sessions = ['mobile', 'desktop'].map(platform => ({
        email: 'person@example.com',
        platform,
        hasStorageState: true
    }))
    await service.startRun()
    await assert.rejects(service.startRun('定时'), /正在运行/)
    await assert.rejects(service.saveSettings(service.settings), /正在运行/)
    assert.equal(backend.starts, 1)
    await service.stopRun()
    await service.startRun()
    assert.equal(backend.starts, 2)
})

test('login and pending operations block new tasks; settings persist without credentials', async t => {
    const { service, dataDirectory } = fixture(t)
    service.operation = 'login'
    await assert.rejects(service.startRun(), /登录或其他操作/)
    service.operation = null
    await service.saveSettings({ ...service.settings, email: 'person@example.com' })
    const saved = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'desktop.json')))
    assert.equal(saved.email, 'person@example.com')
    assert.equal(saved.password, undefined)
    assert.equal(fs.existsSync(path.join(dataDirectory, '.env')), false)
})

test('browser login needs no email input and keeps the session key on upgrade', async t => {
    for (const existingEmail of ['', 'person@example.com']) {
        await t.test(existingEmail ? 'existing sessions' : 'new account slot', async t => {
            const { service, dataDirectory } = fixture(t)
            if (existingEmail) await service.saveSettings({ ...service.settings, email: existingEmail })
            // Exercise the real child-process invocation without opening a browser.
            const runtime = path.join(dataDirectory, 'test-runtime')
            fs.mkdirSync(path.join(runtime, 'scripts/main'), { recursive: true })
            fs.writeFileSync(
                path.join(runtime, 'scripts/main/manualLogin.js'),
                'process.send({ args: process.argv.slice(2), email: process.env.ACCOUNT_1_EMAIL }); setInterval(() => {}, 1000)'
            )
            service.resourceDirectory = runtime
            await service.login()
            const child = service.loginChild
            const message = await new Promise((resolve, reject) => {
                child.once('message', resolve)
                child.once('error', reject)
            })
            const key = existingEmail || 'local@rewards.invalid'
            assert.deepEqual(message.args, ['--email', key, '--platform', 'both'])
            assert.equal(message.email, key)
            assert.equal(JSON.parse(fs.readFileSync(path.join(dataDirectory, 'desktop.json'))).email, key)
            await service.cancelLogin()
        })
    }
})

test('clear data resets the account and schedule and remains usable', async t => {
    const { service, dataDirectory } = fixture(t)
    await service.saveSettings({ ...service.settings, email: 'person@example.com' })
    fs.writeFileSync(path.join(dataDirectory, 'sessions/marker'), 'private')
    await service.clearData()
    assert.equal(service.settings.email, '')
    assert.equal(service.settings.schedule.enabled, false)
    assert.equal(fs.existsSync(path.join(dataDirectory, 'sessions/marker')), false)
    assert.equal((await service.snapshot()).state, 'idle')
})

test('exit waits for an in-flight start before stopping the backend', async t => {
    const { service, backend } = fixture(t)
    service.settings.email = 'person@example.com'
    backend.sessions = ['mobile', 'desktop'].map(platform => ({
        email: 'person@example.com',
        platform,
        hasStorageState: true
    }))
    const request = backend.request.bind(backend)
    let release
    const gate = new Promise(resolve => {
        release = resolve
    })
    backend.request = async route => {
        if (route === '/start') await gate
        return request(route)
    }
    const starting = service.startRun()
    await new Promise(resolve => setImmediate(resolve))
    const closing = service.close()
    release()
    await starting
    await closing
    assert.equal(backend.endpoint, null)
    assert.equal(backend.state, 'idle')
    await assert.rejects(service.startRun(), /退出/)
})

test('automatic inspection waits for both sessions and exposes reset time', async t => {
    const { service, backend } = fixture(t)
    await service.saveSettings({ ...service.settings, email: 'person@example.com', schedule: { enabled: true } })
    let scans = 0
    const nextStreakResetAt = new Date(Date.now() + 3600000).toISOString()
    service.resetScanner = async () => {
        scans++
        return { nextStreakResetAt, pending: true }
    }
    await service.scheduler.tick()
    assert.equal(scans, 0)
    assert.equal(backend.starts, 0)
    backend.sessions = ['mobile', 'desktop'].map(platform => ({
        email: 'person@example.com',
        platform,
        hasStorageState: true
    }))
    service.scheduler.reset()
    await service.scheduler.tick()
    assert.equal(scans, 1)
    assert.equal(backend.starts, 1)
    assert.ok((await service.snapshot()).automation.nextResetAt)
    await service.stopRun()
    service.scheduler.reset()
    await service.scheduler.tick()
    assert.equal(backend.starts, 1)
})

test('inspection holds the operation gate and releases it on failure', async t => {
    const { service, backend } = fixture(t)
    service.settings.email = 'person@example.com'
    backend.sessions = ['mobile', 'desktop'].map(platform => ({
        email: 'person@example.com',
        platform,
        hasStorageState: true
    }))
    let release
    service.resetScanner = () =>
        new Promise(resolve => {
            release = resolve
        })
    const scan = service.scanReset()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal((await service.snapshot()).state, 'scanning')
    await assert.rejects(service.startRun(), /其他操作/)
    release({ pending: false, nextStreakResetAt: new Date(Date.now() + 3600000).toISOString() })
    await scan
    service.resetScanner = async () => {
        throw new Error('offline')
    }
    await assert.rejects(service.scanReset(), /offline/)
    assert.equal(service.operation, null)
})

test('exit during an automatic run persists a visible manual-action notice and does not rerun', async t => {
    const { service, backend, dataDirectory } = fixture(t, {
        email: 'person@example.com',
        startOnLogin: false,
        schedule: { enabled: true }
    })
    backend.sessions = ['mobile', 'desktop'].map(platform => ({
        email: service.settings.email,
        platform,
        hasStorageState: true
    }))
    const reset = new Date(Date.now() + 3600000).toISOString()
    service.resetScanner = async () => ({ nextStreakResetAt: reset, pending: true })
    await service.scheduler.tick()
    assert.equal(backend.starts, 1)
    await service.close()

    const reopenedBackend = new FakeBackend()
    reopenedBackend.sessions = backend.sessions
    const reopened = new DesktopService({
        executable: process.execPath,
        resourceDirectory: root,
        dataDirectory,
        version: 'test',
        backendFactory: () => reopenedBackend,
        resetScanner: async () => ({ nextStreakResetAt: reset, pending: true })
    })
    assert.match((await reopened.snapshot()).interruption, /运行中断.*手动运行/)
    await reopened.scheduler.tick()
    assert.equal(reopenedBackend.starts, 0)
    assert.match(reopened.scheduler.message, /运行中断/)
    await reopened.startRun()
    assert.equal(reopenedBackend.starts, 1)
    assert.equal((await reopened.snapshot()).interruption, null)
    assert.doesNotMatch((await reopened.snapshot()).automation.message, /运行中断/)
    reopenedBackend.state = 'idle'
    reopenedBackend.emit('status', { state: 'idle', lastExit: { code: 0, at: new Date().toISOString() } })
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDirectory, 'run-state.json'))).status, 'finished')
    await reopened.close()
})

test('manual interruption remains visible with automation disabled and blocks same-cycle automation when enabled', async t => {
    const { service, backend } = fixture(t, {
        email: 'person@example.com',
        startOnLogin: false,
        schedule: { enabled: false }
    })
    backend.sessions = ['mobile', 'desktop'].map(platform => ({
        email: service.settings.email,
        platform,
        hasStorageState: true
    }))
    await service.startRun()
    await service.stopRun()
    assert.match((await service.snapshot()).interruption, /运行中断/)
    await service.saveSettings({ ...service.settings, schedule: { enabled: true } })
    service.resetScanner = async () => ({
        nextStreakResetAt: new Date(Date.now() + 3600000).toISOString(),
        pending: true
    })
    await service.scheduler.tick()
    assert.equal(backend.starts, 1)
    assert.match(service.scheduler.message, /运行中断/)
})

test('normal completion and backend failure update the persisted run state without an open window', async t => {
    const { service, backend } = fixture(t, {
        email: 'person@example.com',
        startOnLogin: false,
        schedule: { enabled: false }
    })
    backend.sessions = ['mobile', 'desktop'].map(platform => ({
        email: service.settings.email,
        platform,
        hasStorageState: true
    }))
    await service.startRun()
    backend.state = 'idle'
    backend.emit('status', { state: 'idle', lastExit: { code: 0, at: new Date().toISOString() } })
    assert.equal(service.runState.value.status, 'finished')
    await service.startRun()
    backend.emit('failure', '后台已退出')
    assert.match((await service.snapshot()).interruption, /运行中断/)
})

test('balance refresh needs only desktop login, persists zero, and does not start tasks', async t => {
    const { service, backend, dataDirectory } = fixture(t, {
        email: 'person@example.com',
        startOnLogin: false,
        schedule: { enabled: false }
    })
    await assert.rejects(service.refreshBalance(), /桌面会话登录/)
    backend.sessions = [{ email: service.settings.email, platform: 'desktop', hasStorageState: true }]
    service.resetScanner = async balanceOnly => {
        assert.equal(balanceOnly, true)
        assert.equal(service.operation, 'balance')
        return { balance: 0, updatedAt: '2026-10-24T01:00:00Z' }
    }
    await service.refreshBalance()
    assert.deepEqual((await service.snapshot()).balance, { value: 0, updatedAt: '2026-10-24T01:00:00Z', error: null })
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDirectory, 'balance.json'))).value, 0)
    assert.equal(backend.starts, 0)
    const reopened = new DesktopService({
        executable: process.execPath,
        resourceDirectory: root,
        dataDirectory,
        version: 'test',
        backendFactory: () => new FakeBackend()
    })
    assert.equal((await reopened.snapshot()).balance.value, 0)
    await reopened.close()
    service.resetScanner = async () => {
        throw new Error('会话过期')
    }
    await assert.rejects(service.refreshBalance(), /会话过期/)
    assert.equal((await service.snapshot()).balance.value, 0)
    assert.match((await service.snapshot()).balance.error, /会话过期/)
    service.resetScanner = async () => ({ balance: null })
    await assert.rejects(service.refreshBalance(), /未读取到积分余额/)
    assert.equal((await service.snapshot()).balance.value, 0)
    backend.state = 'running'
    await assert.rejects(service.refreshBalance(), /正在运行/)
    backend.state = 'idle'
    await service.clearData()
    assert.equal((await service.snapshot()).balance.value, null)
    assert.equal(fs.existsSync(path.join(dataDirectory, 'balance.json')), false)
})

test('balance selects newest account observation including a lower post-redemption balance', async t => {
    const { service, dataDirectory } = fixture(t, {
        email: 'person@example.com',
        startOnLogin: false,
        schedule: { enabled: false }
    })
    service.rememberBalance({ balance: 9000, updatedAt: '2026-10-24T01:00:00Z' })
    const reportFile = path.join(dataDirectory, 'reports/tasks-abcdef123456-1.json')
    fs.writeFileSync(
        reportFile,
        JSON.stringify({
            account: 'person@example.com',
            initialPoints: 9000,
            finalPoints: 100,
            startedAt: '2026-10-24T02:00:00Z',
            finishedAt: '2026-10-24T02:01:00Z',
            tasks: []
        })
    )
    assert.equal((await service.snapshot()).balance.value, 100)
    service.rememberBalance({ balance: 50, updatedAt: '2026-10-24T03:00:00Z' })
    assert.equal((await service.snapshot()).balance.value, 50)
    await service.saveSettings({ ...service.settings, email: 'other@example.com' })
    assert.equal((await service.snapshot()).balance.value, null)
    assert.equal(fs.existsSync(path.join(dataDirectory, 'balance.json')), false)
})

test('reset inspection preserves the child error when it exits unsuccessfully', async t => {
    const { service, backend, dataDirectory } = fixture(t)
    service.settings.email = 'person@example.com'
    backend.sessions = ['mobile', 'desktop'].map(platform => ({
        email: service.settings.email,
        platform,
        hasStorageState: true
    }))
    const runtime = path.join(dataDirectory, 'failed-scan-runtime')
    fs.mkdirSync(path.join(runtime, 'scripts/main'), { recursive: true })
    fs.writeFileSync(
        path.join(runtime, 'scripts/main/scanReset.js'),
        `
        process.send({ type: 'desktop:reset-error', error: 'synthetic navigation error' }, () => {
            process.exitCode = 1
            process.disconnect()
        })
    `
    )
    service.resourceDirectory = runtime
    await assert.rejects(service.scanReset(), /synthetic navigation error/)
    assert.equal(service.operation, null)
    assert.equal(service.scanChild, null)
    assert.equal(backend.starts, 0)
})

test('balance refresh uses a read-only child flag and releases the operation gate', async t => {
    const { service, backend, dataDirectory } = fixture(t)
    service.settings.email = 'person@example.com'
    backend.sessions = [{ email: service.settings.email, platform: 'desktop', hasStorageState: true }]
    const runtime = path.join(dataDirectory, 'balance-runtime')
    fs.mkdirSync(path.join(runtime, 'scripts/main'), { recursive: true })
    fs.writeFileSync(
        path.join(runtime, 'scripts/main/scanReset.js'),
        `
        if (!process.argv.includes('--balance')) process.exit(1)
        process.send({ type: 'desktop:reset', balance: 12480, updatedAt: '2026-10-24T04:00:00Z' })
        process.disconnect()
    `
    )
    service.resourceDirectory = runtime
    await service.refreshBalance()
    assert.equal((await service.snapshot()).balance.value, 12480)
    assert.equal(service.operation, null)
    assert.equal(service.scanChild, null)
    assert.equal(backend.starts, 0)
})
