import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { localDate } from '../lib/dailyState.mjs'
import { DesktopService } from '../lib/service.mjs'

const availableBrowser = preference => {
    const id = preference === 'chrome' ? 'chrome' : 'edge'
    const selected = { id, name: id, executablePath: process.execPath }
    return { installed: [selected], selected, error: null }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
class FakeBackend extends EventEmitter {
    constructor() {
        super()
        this.endpoint = null
        this.state = 'idle'
        this.starts = 0
        this.launches = 0
        this.sessions = []
    }
    async start() {
        this.launches++
        this.endpoint = 'local'
    }
    async close() {
        this.endpoint = null
        this.state = 'idle'
    }
    async request(route) {
        if (!this.endpoint) throw new Error('backend asleep')
        if (route === '/health') return { state: this.state }
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
function fixture(t, savedSettings, initialRunState) {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-service-'))
    if (savedSettings) fs.writeFileSync(path.join(dataDirectory, 'desktop.json'), JSON.stringify(savedSettings))
    if (initialRunState !== undefined)
        fs.writeFileSync(path.join(dataDirectory, 'run-state.json'), JSON.stringify(initialRunState))
    const backend = new FakeBackend()
    const service = new DesktopService({
        executable: process.execPath,
        resourceDirectory: root,
        dataDirectory,
        version: '0.1.0',
        browserDetector: availableBrowser,
        sessionReader: () => backend.sessions,
        backendFactory: () => backend
    })
    t.after(async () => {
        await service.close()
        fs.rmSync(dataDirectory, { recursive: true, force: true })
    })
    return { service, backend, dataDirectory }
}

test('mode changes persist without starting the backend and cannot happen during a run', async t => {
    const { service, backend } = fixture(t)
    let restarts = 0
    backend.start = async () => {
        backend.endpoint = 'local'
        restarts++
    }
    await service.saveSettings({ ...service.settings, mode: 'tasks-search' })
    assert.equal(restarts, 0)
    assert.equal(JSON.parse(fs.readFileSync(path.join(service.dataDirectory, 'desktop.json'))).mode, 'tasks-search')
    backend.endpoint = 'local'
    backend.state = 'running'
    await assert.rejects(service.saveSettings({ ...service.settings, mode: 'tasks' }), /正在运行/)
    assert.equal(service.settings.mode, 'tasks-search')
    backend.state = 'idle'
    await service.saveSettings({ ...service.settings, mode: 'tasks' })
    assert.equal(restarts, 0)
    assert.equal(service.settings.mode, 'tasks')
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
    await service.finishing
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
                'process.send({ args: process.argv.slice(2), email: process.env.ACCOUNT_1_EMAIL, browser: process.env.MRS_BROWSER_NAME, executablePath: process.env.MRS_BROWSER_EXECUTABLE }); setInterval(() => {}, 1000)'
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
            assert.equal(message.browser, 'edge')
            assert.equal(message.executablePath, process.execPath)
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
    assert.equal((await service.snapshot()).state, 'sleeping')
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
        browserDetector: availableBrowser,
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
    backend.endpoint = 'local'
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

test('missing browsers block login, balance, manual and automatic work without reserving a cycle', async t => {
    const { service, backend } = fixture(t, {
        email: 'person@example.com',
        startOnLogin: false,
        schedule: { enabled: true }
    })
    backend.sessions = ['mobile', 'desktop'].map(platform => ({
        email: service.settings.email,
        platform,
        hasStorageState: true
    }))
    service.browserDetector = () => ({ installed: [], selected: null, error: '请安装 Chrome 或 Microsoft Edge 后继续' })
    service.resetScanner = () => {
        throw new Error('must not scan')
    }
    await assert.rejects(service.login(), /请安装/)
    await assert.rejects(service.refreshBalance(), /请安装/)
    const error = await service.startRun().catch(error => error)
    assert.match(error.message, /请安装/)
    assert.equal(error.safeToRetry, true)
    await service.scheduler.tick()
    assert.match(service.scheduler.message, /请安装/)
    assert.equal(backend.starts, 0)
    assert.equal(service.scheduler.attempts.size, 0)
    assert.equal(service.runState.value, null)
    assert.equal((await service.snapshot()).state, 'sleeping')
    service.browserDetector = availableBrowser
    await service.detectBrowser()
    assert.ok((await service.snapshot()).browser.selected)
    await service.startRun()
    assert.equal(backend.starts, 1)
})

test('browser settings stay lazy and old sessions survive', async t => {
    const { service, backend } = fixture(t)
    let restarts = 0
    backend.start = async () => {
        restarts++
        backend.endpoint = 'local'
    }
    fs.writeFileSync(path.join(service.dataDirectory, 'sessions/marker'), 'saved-session')
    await service.saveSettings({ ...service.settings, browser: 'chrome' })
    assert.equal(service.browser.selected.id, 'chrome')
    assert.equal(restarts, 0)
    assert.equal(fs.readFileSync(path.join(service.dataDirectory, 'sessions/marker'), 'utf8'), 'saved-session')
    backend.endpoint = 'local'
    backend.state = 'running'
    await assert.rejects(service.saveSettings({ ...service.settings, browser: 'edge' }), /正在运行/)
    assert.equal(service.settings.browser, 'chrome')
})

function configure(service, backend) {
    service.settings.email = 'person@example.com'
    backend.sessions = ['mobile', 'desktop'].map(platform => ({
        email: service.settings.email,
        platform,
        hasStorageState: true
    }))
}
function writeReport(
    service,
    dataDirectory,
    tasks = [{ id: 'daily', title: '每日任务', status: 'completed' }],
    overrides = {}
) {
    const run = service.runState.value
    const report = {
        account: run.account,
        runId: run.runId,
        startedAt: run.startedAt,
        finishedAt: new Date().toISOString(),
        tasks,
        ...overrides
    }
    fs.writeFileSync(path.join(dataDirectory, `reports/tasks-abcdef123456-${Date.now()}.json`), JSON.stringify(report))
    return report
}
async function finish(service, backend, code = 0) {
    backend.state = 'idle'
    backend.emit('status', { state: 'idle', lastExit: { code, at: new Date().toISOString() } })
    await service.finishing
}

test('startup and repeated snapshots never launch API or reset scanner when today is complete', async t => {
    const { service, backend } = fixture(t)
    configure(service, backend)
    service.settings.schedule.enabled = true
    service.daily.record({ account: service.settings.email, mode: service.settings.mode, date: localDate() }, true)
    service.resetScanner = () => {
        throw new Error('must not scan')
    }
    await service.start()
    await service.scheduler.tick()
    for (let i = 0; i < 5; i++) {
        const snapshot = await service.snapshot()
        assert.equal(snapshot.state, 'sleeping')
        assert.equal(snapshot.automation.completedToday, true)
        assert.equal(snapshot.sessions.length, 2)
    }
    assert.equal(backend.launches, 0)
    assert.equal(backend.starts, 0)
})

test('successful report marks today complete, closes API, and manual start overrides completion', async t => {
    const { service, backend, dataDirectory } = fixture(t)
    configure(service, backend)
    service.settings.schedule.enabled = true
    await service.scheduler.tick()
    writeReport(service, dataDirectory, [{ status: 'completed' }, { status: 'skipped' }])
    await finish(service, backend)
    assert.equal((await service.snapshot()).automation.completedToday, true)
    assert.equal(backend.endpoint, null)
    assert.equal((await service.snapshot()).review, null)
    await service.scheduler.tick()
    assert.equal(backend.starts, 1)
    await service.startRun()
    assert.equal(backend.starts, 2)
    assert.equal((await service.snapshot()).automation.completedToday, false)
})

test('failed or uncertain reports never mark completion or continuously retry', async t => {
    for (const status of [
        'failed',
        'manual',
        'unconfirmed',
        'missing',
        'empty',
        'stale',
        'other-account',
        'bad-time',
        'corrupt'
    ]) {
        await t.test(status, async t => {
            const { service, backend, dataDirectory } = fixture(t)
            configure(service, backend)
            service.settings.schedule.enabled = true
            await service.scheduler.tick()
            if (status !== 'missing') {
                writeReport(
                    service,
                    dataDirectory,
                    status === 'empty' ? [] : [{ status: status === 'stale' ? 'completed' : status }],
                    status === 'stale'
                        ? { runId: 'old-run' }
                        : status === 'other-account'
                          ? { account: 'other@example.com' }
                          : status === 'bad-time'
                            ? { finishedAt: 'invalid' }
                            : {}
                )
                if (status === 'corrupt')
                    fs.writeFileSync(
                        path.join(
                            dataDirectory,
                            fs.readdirSync(path.join(dataDirectory, 'reports')).map(name => 'reports/' + name)[0]
                        ),
                        '{'
                    )
            }
            await finish(service, backend)
            assert.equal((await service.snapshot()).automation.completedToday, false)
            assert.match((await service.snapshot()).review, /导出诊断/)
            await service.scheduler.tick()
            service.scheduler.reset() // Reopening the tray window must not reset attempts.
            await service.scheduler.tick()
            assert.equal(backend.starts, 1)
            assert.equal(backend.endpoint, null)
        })
    }
})

test('a complete report with abnormal exit remains incomplete', async t => {
    const { service, backend, dataDirectory } = fixture(t)
    configure(service, backend)
    await service.startRun()
    writeReport(service, dataDirectory)
    await finish(service, backend, 1)
    assert.equal((await service.snapshot()).automation.completedToday, false)
})

test('restarting host retries incomplete work but skips verified completed work', async t => {
    for (const complete of [false, true]) {
        await t.test(String(complete), async t => {
            const { service, backend, dataDirectory } = fixture(t, {
                email: 'person@example.com',
                startOnLogin: false,
                schedule: { enabled: true }
            })
            configure(service, backend)
            await service.scheduler.tick()
            writeReport(service, dataDirectory, [{ status: complete ? 'completed' : 'failed' }])
            await finish(service, backend)
            await service.close()
            const next = new FakeBackend()
            next.sessions = backend.sessions
            const reopened = new DesktopService({
                executable: process.execPath,
                resourceDirectory: root,
                dataDirectory,
                version: 'test',
                browserDetector: availableBrowser,
                backendFactory: () => next,
                sessionReader: () => next.sessions
            })
            await reopened.scheduler.tick()
            assert.equal(next.starts, complete ? 0 : 1)
            await reopened.close()
        })
    }
})

test('two-day automation never carries today completion into tomorrow, resident or restarted', async t => {
    for (const mode of ['tasks', 'tasks-search']) {
        for (const restart of [false, true]) {
            await t.test(`${mode}, ${restart ? 'restart overnight' : 'resident overnight'}`, async t => {
                let active
                t.after(() => active?.close())
                const { service, backend, dataDirectory } = fixture(t)
                configure(service, backend)
                let now = new Date(2026, 9, 28, 23, 58)
                service.now = () => now
                service.scheduler.now = () => now
                await service.saveSettings({ ...service.settings, mode, schedule: { enabled: true } })
                active = service
                let currentBackend = backend
                const complete = async () => {
                    writeReport(active, dataDirectory)
                    currentBackend.state = 'idle'
                    currentBackend.emit('status', {
                        state: 'idle',
                        lastExit: { code: 0, at: new Date().toISOString() }
                    })
                    await active.finishing
                }
                await active.scheduler.tick()
                assert.equal(backend.starts, 1, 'today starts normally')
                const todayRunId = active.runState.value.runId
                await complete()
                assert.equal((await active.snapshot()).automation.completedToday, true)
                await active.scheduler.tick()
                assert.equal(backend.starts, 1, 'today completion prevents duplicate work')

                if (restart) {
                    await service.close()
                    currentBackend = new FakeBackend()
                    currentBackend.sessions = backend.sessions
                    active = new DesktopService({
                        executable: process.execPath,
                        resourceDirectory: root,
                        dataDirectory,
                        version: 'test',
                        browserDetector: availableBrowser,
                        backendFactory: () => currentBackend,
                        sessionReader: () => currentBackend.sessions,
                        now: () => now
                    })
                    await active.scheduler.tick()
                    assert.equal(currentBackend.starts, 0, 'persisted completion survives same-day restart')
                }

                now = new Date(2026, 9, 29, 0, 1)
                const before = await active.snapshot()
                assert.equal(before.automation.date, '2026-10-29')
                assert.equal(before.automation.completedToday, false, 'yesterday does not complete today')
                const starts = currentBackend.starts
                await active.scheduler.tick()
                assert.equal(currentBackend.starts, starts + 1, 'tomorrow starts despite yesterday completion')
                assert.equal(active.runState.value.date, '2026-10-29')
                assert.notEqual(active.runState.value.runId, todayRunId)
                assert.equal(
                    (await active.snapshot()).automation.completedToday,
                    false,
                    'old report cannot complete new run'
                )
                await complete()
                assert.equal((await active.snapshot()).automation.completedToday, true)
                await active.scheduler.tick()
                assert.equal(currentBackend.starts, starts + 1, 'tomorrow also runs only once')
            })
        }
    }
})

test('cross-midnight running work is attributed to its start date and next day waits', async t => {
    const { service, backend, dataDirectory } = fixture(t)
    configure(service, backend)
    let now = new Date(2026, 9, 28, 23, 59)
    service.now = () => now
    service.scheduler.now = () => now
    service.settings.schedule.enabled = true
    await service.scheduler.tick()
    now = new Date(2026, 9, 29, 0, 1)
    await service.scheduler.tick()
    assert.equal(backend.starts, 1)
    writeReport(service, dataDirectory)
    await finish(service, backend)
    assert.equal(service.daily.completed(service.settings.email, service.settings.mode, '2026-10-28'), true)
    assert.equal((await service.snapshot()).automation.completedToday, false)
    await service.scheduler.tick()
    assert.equal(backend.starts, 2)
})

test('corrupt daily state pauses automation and manual run repairs it without losing original', async t => {
    const { service, backend, dataDirectory } = fixture(t)
    configure(service, backend)
    service.settings.schedule.enabled = true
    service.daily.error = '每日运行记录损坏'
    fs.writeFileSync(service.daily.file, '{broken')
    await service.scheduler.tick()
    assert.equal(backend.starts, 0)
    await service.startRun()
    assert.equal(backend.starts, 1)
    assert.equal(service.daily.error, null)
    assert.ok(fs.readdirSync(dataDirectory).some(name => name.startsWith('daily-state.json.corrupt-')))
})

test('status received before /start returns is finalized after its response', async t => {
    const { service, backend, dataDirectory } = fixture(t)
    configure(service, backend)
    const request = backend.request.bind(backend)
    backend.request = async route => {
        const result = await request(route)
        if (route === '/start') {
            writeReport(service, dataDirectory)
            backend.emit('status', { state: 'idle', lastExit: { code: 0, at: new Date().toISOString() } })
            assert.ok(backend.endpoint)
        }
        return result
    }
    await service.startRun()
    await service.finishing
    assert.equal(backend.endpoint, null)
    assert.equal((await service.snapshot()).automation.completedToday, true)
})

test('explicit backend check returns to sleep and API failure recycles task processes', async t => {
    const { service, backend } = fixture(t)
    await service.restartBackend()
    assert.equal(backend.endpoint, null)
    configure(service, backend)
    await service.startRun()
    backend.emit('failure', '后台已退出')
    await service.finishing
    assert.equal(backend.endpoint, null)
    assert.match((await service.snapshot()).interruption, /运行中断/)
    assert.match(service.diagnosticText(), /Local date:.*[\s\S]*Timezone:/)
})

test('uncertain start failure recycles the backend and cannot repeat automatically in this process', async t => {
    const { service, backend } = fixture(t)
    configure(service, backend)
    service.settings.schedule.enabled = true
    const request = backend.request.bind(backend)
    backend.request = async route => {
        const result = await request(route)
        if (route === '/start') throw new Error('lost start response')
        return result
    }
    await service.scheduler.tick()
    await service.scheduler.tick()
    assert.equal(backend.starts, 1)
    assert.equal(backend.endpoint, null)
    assert.equal((await service.snapshot()).automation.completedToday, false)
})

test('invalid persisted running records pause automation without blocking manual recovery or maintenance', async t => {
    for (const corrupt of [
        { status: 'running', account: 'person@example.com', startedAt: 'invalid' },
        { status: 'running', account: 42, startedAt: new Date().toISOString() }
    ]) {
        await t.test(JSON.stringify(corrupt), async t => {
            const { service, backend, dataDirectory } = fixture(t, undefined, corrupt)
            configure(service, backend)
            service.settings.schedule.enabled = true
            let now = new Date(2026, 9, 28, 12)
            service.scheduler.now = () => now
            const file = path.join(dataDirectory, 'run-state.json')
            const original = fs.readFileSync(file, 'utf8')
            await service.scheduler.tick()
            now = new Date(2026, 9, 29, 12)
            await service.scheduler.tick()
            assert.equal(backend.starts, 0)
            assert.match((await service.snapshot()).error, /运行记录损坏/)
            await service.ensureIdle()
            await service.startRun()
            assert.equal(backend.starts, 1)
            assert.equal(service.runState.error, null)
            const backups = fs.readdirSync(dataDirectory).filter(name => name.startsWith('run-state.json.corrupt-'))
            assert.equal(backups.length, 1)
            assert.equal(fs.readFileSync(path.join(dataDirectory, backups[0]), 'utf8'), original)
            await assert.rejects(service.startRun(), /正在运行/)
            await service.stopRun()
            await service.finishing
        })
    }
    await t.test('login reaches the browser guard and clearing data remains available', async t => {
        const { service } = fixture(t, undefined, { status: 'running', account: null, startedAt: 'invalid' })
        service.settings.email = 'person@example.com'
        service.browserDetector = () => ({
            installed: [],
            selected: null,
            error: '请安装 Chrome 或 Microsoft Edge 后继续'
        })
        await assert.rejects(service.login(), /请安装/)
        await service.clearData()
        assert.equal(service.runState.value, null)
        assert.equal(service.runState.error, null)
        assert.equal((await service.snapshot()).state, 'sleeping')
    })
})

test('late matching report reconciles completion on the next snapshot without replaying tasks', async t => {
    const { service, backend, dataDirectory } = fixture(t)
    configure(service, backend)
    await service.startRun()
    assert.equal((await service.snapshot()).automation.status, 'running')
    await finish(service, backend)
    assert.equal((await service.snapshot()).automation.status, 'review')
    writeReport(service, dataDirectory)
    const snapshot = await service.snapshot()
    assert.equal(snapshot.automation.completedToday, true)
    assert.equal(snapshot.automation.status, 'completed')
    assert.match(snapshot.automation.message, /今日已完成/)
    assert.equal(snapshot.review, null)
    assert.equal(backend.starts, 1)
    assert.equal(backend.endpoint, null)
    const saved = fs.readFileSync(service.daily.file, 'utf8')
    await service.snapshot()
    assert.equal(fs.readFileSync(service.daily.file, 'utf8'), saved)
})

test('late reports cannot complete abnormal exits or a different run', async t => {
    for (const code of [0, 1]) {
        await t.test(`exit ${code}`, async t => {
            const { service, backend, dataDirectory } = fixture(t)
            configure(service, backend)
            await service.startRun()
            await finish(service, backend, code)
            writeReport(service, dataDirectory, undefined, code === 0 ? { runId: 'other' } : {})
            const snapshot = await service.snapshot()
            assert.equal(snapshot.automation.completedToday, false)
            assert.equal(snapshot.automation.status, 'review')
        })
    }
})

test('completion display stays current with automation disabled and after a scheduler reset', async t => {
    const { service, backend, dataDirectory } = fixture(t)
    configure(service, backend)
    await service.startRun()
    writeReport(service, dataDirectory)
    await finish(service, backend)
    service.scheduler.reset()
    const snapshot = await service.snapshot()
    assert.equal(snapshot.settings.schedule.enabled, false)
    assert.equal(snapshot.automation.status, 'completed')
    assert.match(snapshot.automation.message, /今日已完成/)
})
