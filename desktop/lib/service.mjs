import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { listStoredSessions } from '../../scripts/api/sessionStore.js'
import { DailyState, dayKey, localDate, matchingReport, reportComplete } from './dailyState.mjs'
import { Backend, killTree } from './backend.mjs'
import { atomicJson, initializeData, validateSettings, DailyLog, readReports, redact } from './data.mjs'
import { backendEnvironment } from './runtime.mjs'
import { DesktopScheduler } from './scheduler.mjs'
import { RunState, interruptionMessage } from './runState.mjs'
import { legacyEmail, migrateLegacy } from './accountMigration.mjs'
import { newAccount } from './data.mjs'
import { DatabaseSync } from 'node:sqlite'
import { detectBrowsers } from './browser.mjs'
import { prepareLogin, commitLogin } from './loginSessions.mjs'

export class DesktopService extends EventEmitter {
    constructor({
        executable,
        resourceDirectory,
        dataDirectory,
        version,
        backendFactory = options => new Backend(options),
        resetScanner,
        sessionReader,
        now = () => new Date(),
        browserDetector = detectBrowsers,
        setAutoStart = () => {}
    }) {
        super()
        Object.assign(this, { executable, resourceDirectory, dataDirectory, version, setAutoStart })
        this.settings = initializeData(dataDirectory, path.join(resourceDirectory, 'config.tasks.example.json'))
        this.browserDetector = browserDetector
        this.browser = this.browserDetector(this.settings.browser)
        this.logger = new DailyLog(path.join(dataDirectory, 'logs'))
        this.balances = {}
        this.balance = null
        this.balanceError = null
        try {
            const saved = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'balance.json'), 'utf8'))
            if (Number.isSafeInteger(saved.value) && saved.value >= 0 && Number.isFinite(Date.parse(saved.updatedAt)))
                this.balance = saved
        } catch {}
        try {
            this.balances = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'balances.json'), 'utf8'))
        } catch {}
        if (this.balance?.account) this.balances[this.balance.account] = this.balance
        this.queue = null
        this.accountErrors = {}
        this.activeAccount = null
        this.resetScanner = resetScanner
        this.now = now
        this.sessionReader =
            sessionReader || (() => listStoredSessions(resourceDirectory, 'sessions', dataDirectory).sessions)
        this.lastStatus = { state: 'idle', lastExit: null }
        this.daily = new DailyState(path.join(dataDirectory, 'daily-state.json'))
        this.error = null
        this.operation = null
        this.loginChild = null
        this.stopping = false
        this.runState = new RunState(path.join(dataDirectory, 'run-state.json'))
        this.backend = backendFactory({
            executable,
            resourceDirectory,
            dataDirectory,
            settings: () => this.executionSettings,
            browser: () => this.browser.selected,
            log: line => this.log(line)
        })
        this.backend.on('failure', message => {
            this.runState.interrupt()
            this.error = message
            this.log(message)
            void this.finishRun().catch(error => this.log(error.message))
        })
        this.backend.on('status', status => this.observeStatus(status))
        this.scheduler = new DesktopScheduler({
            settings: () => this.settings,
            daily: this.daily,
            trigger: account =>
                this.startQueue(
                    this.settings.accounts
                        .filter(
                            a =>
                                a.enabled &&
                                !this.daily.completed(a.email, this.settings.mode, localDate(this.now())) &&
                                (!this.scheduler.attempts.has(
                                    dayKey(a.email, this.settings.mode, localDate(this.now()))
                                ) ||
                                    a.id === account.id)
                        )
                        .map(a => a.id),
                    '自动'
                ),
            available: () =>
                !this.stopping &&
                !this.operation &&
                !this.queue?.running &&
                !this.needsMigration &&
                !this.loginChild &&
                !this.finishing &&
                this.runState.value?.status !== 'running' &&
                !this.runState.error,
            now,
            log: line => this.log(line)
        })
        this.review = null
        // Recover a crash between report verification and saving the daily flag.
        if (this.runState.value?.runId && this.runState.value.status !== 'running') this.recordOutcome()
    }
    get needsMigration() {
        return false // Existing internal session keys remain valid; no email migration is required.
    }
    get executionSettings() {
        return { ...this.settings, email: this.activeAccount?.email || '' }
    }
    account(id) {
        const account = this.settings.accounts.find(a => a.id === id)
        if (!account) throw new Error('账号不存在')
        return account
    }
    async saveAccount(value) {
        // A name-only update is presentation metadata. Keep execution and queue
        // objects untouched, and do not turn the running operation into "saving".
        if (value.id && !Object.hasOwn(value, 'enabled') && !Object.hasOwn(value, 'email')) {
            if (this.stopping || ['saving', 'migration', 'clearing', 'updating'].includes(this.operation))
                throw new Error('账户设置正在变更，请稍后修改备注')
            const previous = this.account(value.id)
            const next = validateSettings({
                ...this.settings,
                accounts: this.settings.accounts.map(account =>
                    account.id === previous.id ? { ...account, name: value.name } : account
                )
            })
            atomicJson(path.join(this.dataDirectory, 'desktop.json'), next)
            this.settings = next
            this.emit('change')
            return next
        }
        return this.exclusive('saving', async () => {
            await this.ensureIdle()
            const accounts = [...this.settings.accounts]
            if (value.id) {
                const previous = this.account(value.id)
                accounts[accounts.indexOf(previous)] = { ...previous, name: value.name, enabled: value.enabled }
            } else {
                const account = newAccount(value.email, value.name)
                if (account.email === legacyEmail) throw new Error('请填写真实 Microsoft 邮箱')
                accounts.push(account)
            }
            const next = validateSettings({ ...this.settings, accounts })
            atomicJson(path.join(this.dataDirectory, 'desktop.json'), next)
            this.settings = next
            return this.settings
        })
    }
    async removeAccount(id) {
        return this.exclusive('saving', async () => {
            await this.ensureIdle()
            if (this.daily.error) throw new Error(this.daily.error)
            const account = this.account(id)
            await this.backend.close()
            const dbFile = path.join(this.dataDirectory, 'sessions', 'sessions.db')
            if (fs.existsSync(dbFile)) {
                const db = new DatabaseSync(dbFile)
                try {
                    db.exec('BEGIN IMMEDIATE')
                    for (const table of ['sessions', 'account_metadata']) {
                        if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))
                            db.prepare(`DELETE FROM ${table} WHERE LOWER(email)=?`).run(account.email.toLowerCase())
                    }
                    db.exec('COMMIT')
                } finally {
                    db.close()
                }
            }
            const days = Object.fromEntries(
                Object.entries(this.daily.value.days).filter(
                    ([key]) => JSON.parse(key)[0] !== account.email.toLowerCase()
                )
            )
            this.daily.value = { ...this.daily.value, days }
            atomicJson(this.daily.file, this.daily.value)
            if (this.runState.value?.account === account.email.toLowerCase()) this.runState.save(null)
            this.scheduler.attempts = new Set(
                [...this.scheduler.attempts].filter(key => JSON.parse(key)[0] !== account.email.toLowerCase())
            )
            delete this.balances[account.email.toLowerCase()]
            atomicJson(path.join(this.dataDirectory, 'balances.json'), this.balances)
            fs.rmSync(path.join(this.dataDirectory, 'balance.json'), { force: true })
            delete this.accountErrors[id]
            this.settings = { ...this.settings, accounts: this.settings.accounts.filter(a => a.id !== id) }
            atomicJson(path.join(this.dataDirectory, 'desktop.json'), this.settings)
            if (this.activeAccount?.id === id) this.activeAccount = null
        })
    }
    async completeMigration(email) {
        return this.exclusive('migration', async () => {
            await this.ensureIdle()
            if (!this.settings.accounts.some(a => a.email === legacyEmail)) throw new Error('没有需要迁移的账号')
            await this.backend.close()
            this.settings = migrateLegacy(this.dataDirectory, this.settings, email)
            this.daily = new DailyState(path.join(this.dataDirectory, 'daily-state.json'))
            this.scheduler.daily = this.daily
            this.runState = new RunState(path.join(this.dataDirectory, 'run-state.json'))
            this.balance = null
            try {
                this.balance = JSON.parse(fs.readFileSync(path.join(this.dataDirectory, 'balance.json'), 'utf8'))
            } catch {}
            if (this.balance?.account) this.balances[this.balance.account] = this.balance
            this.activeAccount = null
        })
    }
    async startQueue(ids = this.settings.accounts.filter(a => a.enabled).map(a => a.id), source = '手动') {
        const result = await this.exclusive('queueing', async () => {
            await this.ensureIdle()
            if (this.needsMigration) throw new Error('请先补填原有账号邮箱')
            const accounts = ids.map(id => this.account(id))
            if (!accounts.length) throw new Error('请先添加并启用账号')
            this.queue = {
                running: true,
                source,
                mode: this.settings.mode,
                items: accounts.map(a => ({ id: a.id, status: 'pending', error: null }))
            }
            return { queued: accounts.length }
        })
        await this.advanceQueue()
        if (source === '自动' && this.queue.items.every(i => i.status === 'failed'))
            throw Object.assign(new Error(this.queue.items[0].error), {
                safeToRetry: this.queue.items.every(i => i.safeToRetry)
            })
        return result
    }
    async advanceQueue() {
        if (this.advancing || !this.queue?.running || this.stopping) return
        this.advancing = true
        try {
            for (const item of this.queue.items) {
                if (!this.queue.running || this.stopping) break
                if (item.status !== 'pending') continue
                if (
                    this.queue.source === '自动' &&
                    this.daily.completed(this.account(item.id).email, this.queue.mode, localDate(this.now()))
                ) {
                    item.status = 'skipped'
                    continue
                }
                item.status = 'running'
                this.queue.currentId = item.id
                this.emit('change')
                try {
                    await this.startRun(this.queue.source, item.id, true)
                    return // finishRun advances only after the task process exits.
                } catch (error) {
                    if (this.finishing) await this.finishing
                    item.status = 'failed'
                    item.safeToRetry = Boolean(error.safeToRetry)
                    item.error = redact(error.message)
                    this.accountErrors[item.id] = item.error
                    if (this.queue.source === '自动') {
                        const account = this.account(item.id)
                        const run = { account: account.email, mode: this.queue.mode, date: localDate(this.now()) }
                        if (error.safeToRetry) this.scheduler.attempts.delete(dayKey(run.account, run.mode, run.date))
                        else this.scheduler.markAttempt(run)
                    }
                }
            }
            this.queue.running = false
            this.queue.currentId = null
        } finally {
            this.advancing = false
            this.emit('change')
        }
    }
    reports() {
        return readReports(path.join(this.dataDirectory, 'reports'))
    }
    sessions(email = this.executionSettings.email) {
        return this.sessionReader().filter(session => session.email.toLowerCase() === email.toLowerCase())
    }
    recordOutcome(reports = this.reports()) {
        const run = this.runState.value
        if (!run?.runId || !run.date || !run.mode) return
        const report = matchingReport(run, reports)
        const complete = run.status === 'finished' && reportComplete(report)
        // Never overwrite a corrupt daily file automatically during recovery.
        if (!this.daily.error) this.daily.record(run, complete)
        this.scheduler.message = complete
            ? '今日任务已完成；等待系统日期跨日'
            : '今日任务尚未完成，请查看运行结果并导出诊断'
        this.review = complete
            ? null
            : report
              ? '仍有任务未完成或未确认，请查看运行结果并导出诊断，检查失败步骤。'
              : '本次运行缺少有效报告，无法确认完成；请导出诊断并检查日志。'
    }
    observeStatus(status) {
        this.lastStatus = status
        if (
            this.runState.value?.status === 'running' &&
            status.state === 'idle' &&
            status.lastExit &&
            Date.parse(status.lastExit.at) >= Date.parse(this.runState.value.startedAt)
        ) {
            this.runState.observe(status)
            void this.finishRun().catch(error => {
                this.error = error.message
                this.log(error.message)
            })
        }
        this.emit('change')
    }
    finishRun() {
        if (this.finishing) return this.finishing
        const operation = this.activeOperation
        this.finishing = (async () => {
            // Do not close the API before the /start or /stop response is consumed.
            await operation
            try {
                this.recordOutcome()
            } finally {
                await this.backend.close()
                this.lastStatus = { ...this.lastStatus, state: 'idle' }
                this.emit('change')
            }
        })().finally(() => {
            this.finishing = null
            if (this.queue?.running && this.runState.value?.status !== 'running') {
                const item = this.queue.items.find(i => i.id === this.queue.currentId)
                if (item?.status === 'running') {
                    item.status = this.daily.completed(
                        this.runState.value.account,
                        this.runState.value.mode,
                        this.runState.value.date
                    )
                        ? 'completed'
                        : 'review'
                }
                if (!this.queue.items.some(i => i.status === 'pending')) {
                    this.queue.running = false
                    this.queue.currentId = null
                } else
                    setImmediate(
                        () =>
                            void this.advanceQueue().catch(error => {
                                this.error = error.message
                                this.queue.running = false
                                this.emit('change')
                            })
                    )
            }
        })
        return this.finishing
    }
    async ensureBackend() {
        if (this.backend.endpoint) return
        if (!this.backendStarting) {
            this.backendStarting = this.backend.start().finally(() => {
                this.backendStarting = null
            })
        }
        await this.backendStarting
    }

    log(message) {
        this.logger.write(message)
        this.emit('change')
    }
    async start() {
        this.log('桌面服务已就绪；任务后台按需启动，自动运行使用电脑系统日期')
        this.timer = setInterval(() => {
            void this.scheduler.tick().catch(error => {
                this.error = error.message
                this.log(error.message)
            })
        }, 60000)
        this.pruneTimer = setInterval(() => this.logger.cleanup(), 86400000)
        void this.scheduler.tick()
    }
    async exclusive(name, action, fromQueue = false) {
        if (this.needsMigration && !['migration', 'clearing'].includes(name)) throw new Error('请先补填原有账号邮箱')
        if (this.queue?.running && !fromQueue && name !== 'stopping') throw new Error('任务队列正在运行，请先停止')
        if (this.stopping) throw new Error('应用正在退出')
        if (this.operation || this.loginChild || this.finishing)
            throw new Error('登录或其他操作正在进行，请先完成或取消')
        this.operation = name
        let finished
        this.activeOperation = new Promise(resolve => {
            finished = resolve
        })
        this.emit('change')
        try {
            return await action()
        } finally {
            this.operation = null
            finished()
            this.activeOperation = null
            this.emit('change')
        }
    }
    async ensureIdle() {
        if (this.runState.value?.status === 'running' || this.finishing) throw new Error('任务正在运行，请先停止')
        if (!this.backend.endpoint) return
        const status = await this.backend.request('/status')
        if (status.state !== 'idle') throw new Error('任务正在运行，请先停止')
    }
    async detectBrowser() {
        this.browser = this.browserDetector(this.settings.browser)
        this.emit('change')
        return this.browser
    }
    async requireBrowser() {
        await this.detectBrowser()
        if (!this.browser.selected) throw new Error(this.browser.error)
        this.log(`使用 ${this.browser.selected.name}`)
    }
    async startRun(source = '手动', accountId, fromQueue = false) {
        let submitted = false
        let ownsBackend = false
        try {
            return await this.exclusive(
                'starting',
                async () => {
                    await this.ensureIdle()
                    this.activeAccount = this.account(accountId)
                    this.balance = this.balances[this.activeAccount.email.toLowerCase()] || null
                    delete this.accountErrors[accountId]
                    const sessions = this.sessions()
                    const stored = sessions.filter(
                        session =>
                            session.email.toLowerCase() === this.executionSettings.email.toLowerCase() &&
                            session.hasStorageState
                    )
                    if (!['mobile', 'desktop'].every(platform => stored.some(session => session.platform === platform)))
                        throw new Error('请先完成手机和桌面会话登录')
                    const runId = randomUUID()
                    await this.requireBrowser()
                    ownsBackend = true
                    // Each run gets a fresh environment and correlation ID.
                    await this.backend.close()
                    this.backend.runId = runId
                    await this.ensureBackend()
                    this.runState.start(this.executionSettings.email, {
                        date: localDate(this.now()),
                        mode: this.settings.mode,
                        runId
                    })
                    this.daily.record(this.runState.value, false)
                    this.scheduler.markAttempt(this.runState.value)
                    this.review = null
                    this.error = null
                    submitted = true
                    this.lastStatus = { state: 'running', lastExit: null }
                    const result = await this.backend.request('/start', 'POST', { accountIndex: 1 })
                    this.scheduler.message = `${source}任务已启动；完成情况请查看运行结果`
                    this.log(`${source}任务已启动`)
                    return result
                },
                fromQueue
            )
        } catch (error) {
            // Once /start was sent, an uncertain response must not cause a
            // second automatic run after a timeout or lost connection.
            error.safeToRetry = !submitted
            if (ownsBackend) {
                this.runState.interrupt()
                if (submitted) await this.finishRun()
                else await this.backend.close()
            }
            throw error
        }
    }
    async refreshBalance(accountId) {
        try {
            const result = await this.scanReset(true, accountId)
            if (!Number.isSafeInteger(result.balance) || result.balance < 0)
                throw new Error('未读取到积分余额，请稍后重试')
            this.balanceError = null
            delete this.accountErrors[accountId]
        } catch (error) {
            this.balanceError = redact(error.message)
            this.accountErrors[accountId] = this.balanceError
            throw error
        } finally {
            this.emit('change')
        }
    }
    rememberBalance(result) {
        if (!Number.isSafeInteger(result.balance) || result.balance < 0) return
        this.balance = {
            account: this.executionSettings.email.toLowerCase(),
            value: result.balance,
            updatedAt: result.updatedAt || new Date().toISOString()
        }
        this.balances[this.balance.account] = this.balance
        atomicJson(path.join(this.dataDirectory, 'balances.json'), this.balances)
        this.balanceError = null
    }
    async scanReset(balanceOnly = false, accountId) {
        return this.exclusive(balanceOnly ? 'balance' : 'scanning', async () => {
            await this.ensureIdle()
            this.activeAccount = this.account(accountId)
            this.balance = this.balances[this.activeAccount.email.toLowerCase()] || null
            const sessions = this.sessions()
            if (
                !(balanceOnly ? ['desktop'] : ['mobile', 'desktop']).every(platform =>
                    sessions.some(
                        session =>
                            session.email.toLowerCase() === this.executionSettings.email.toLowerCase() &&
                            session.platform === platform &&
                            session.hasStorageState
                    )
                )
            )
                throw new Error(balanceOnly ? '请先完成桌面会话登录' : '请先完成手机和桌面会话登录')
            if (this.stopping) throw new Error('应用正在退出')
            await this.requireBrowser()
            if (this.resetScanner) {
                const result = await this.resetScanner(balanceOnly)
                this.rememberBalance(result)
                return result
            }
            const result = await new Promise((resolve, reject) => {
                const child = spawn(
                    this.executable,
                    [
                        path.join(this.resourceDirectory, 'scripts/main/scanReset.js'),
                        ...(balanceOnly ? ['--balance'] : [])
                    ],
                    {
                        cwd: this.dataDirectory,
                        env: backendEnvironment({
                            ...this,
                            settings: this.executionSettings,
                            browser: this.browser.selected,
                            token: ''
                        }),
                        detached: process.platform !== 'win32',
                        windowsHide: true,
                        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
                    }
                )
                this.scanChild = child
                let result
                let failure
                const timer = setTimeout(() => {
                    failure = new Error(balanceOnly ? '积分余额查询超时' : '重置时间检查超时')
                    void killTree(child.pid)
                }, 90000)
                child.on('message', message => {
                    if (message?.type === 'desktop:reset') result = message
                    if (message?.type === 'desktop:reset-error') failure = new Error(message.error)
                })
                child.stdout.on('data', chunk => this.log(chunk.toString()))
                child.stderr.on('data', chunk => this.log(chunk.toString()))
                const finish = error => {
                    clearTimeout(timer)
                    if (this.scanChild === child) this.scanChild = null
                    if (error || failure || !result) reject(failure || error || new Error('重置时间检查未完成'))
                    else resolve(result)
                }
                child.once('error', finish)
                child.once('exit', code =>
                    finish(code === 0 ? null : new Error(balanceOnly ? '积分余额查询未完成' : '重置时间检查未完成'))
                )
            })
            this.rememberBalance(result)
            return result
        })
    }
    async stopRun() {
        if (this.queue) {
            this.queue.running = false
            for (const item of this.queue.items)
                if (['pending', 'running'].includes(item.status)) item.status = 'cancelled'
            this.emit('change')
        }
        if (this.loginChild) return this.cancelLogin()
        // Cancel queue ownership immediately, then allow an in-flight start to
        // finish before stopping its newly created task process.
        if (['starting', 'queueing'].includes(this.operation)) await this.activeOperation
        if (this.finishing) await this.finishing
        return this.exclusive('stopping', async () => {
            if (!this.backend.endpoint) return
            this.runState.interrupt()
            const result = await this.backend.request('/stop', 'POST', {})
            void this.finishRun().catch(error => this.log(error.message))
            return result
        })
    }
    async saveSettings(value) {
        const next = validateSettings({
            version: 2,
            accounts: this.settings.accounts,
            mode: value.mode,
            browser: value.browser,
            schedule: value.schedule,
            startOnLogin: value.startOnLogin
        })
        return this.exclusive('saving', async () => {
            await this.ensureIdle()
            const previous = this.settings
            await this.setAutoStart(next.startOnLogin)
            try {
                fs.copyFileSync(
                    path.join(this.dataDirectory, 'desktop.json'),
                    path.join(this.dataDirectory, 'desktop.json.bak')
                )
                atomicJson(path.join(this.dataDirectory, 'desktop.json'), next)
            } catch (error) {
                await this.setAutoStart(previous.startOnLogin)
                throw error
            }
            this.settings = next
            await this.detectBrowser()
            this.scheduler.reset()
            if (next.mode !== previous.mode || next.browser !== previous.browser) await this.backend.close()
            this.error = null
            this.log('设置已保存')
            return next
        })
    }
    async login(accountId) {
        return this.exclusive('login', async () => {
            await this.ensureIdle()
            const pending = !accountId
            const account = pending
                ? newAccount(`account-${randomUUID()}@rewards.invalid`, `账户 ${this.settings.accounts.length + 1}`)
                : this.account(accountId)
            this.activeAccount = account
            await this.backend.close()
            await this.requireBrowser()
            const loginDirectory = prepareLogin(this.dataDirectory, account.email)
            const env = backendEnvironment({
                ...this,
                dataDirectory: loginDirectory,
                settings: this.executionSettings,
                browser: this.browser.selected,
                token: ''
            })
            const child = spawn(
                this.executable,
                [
                    path.join(this.resourceDirectory, 'scripts/main/manualLogin.js'),
                    '--email',
                    this.executionSettings.email,
                    '--platform',
                    'both'
                ],
                {
                    cwd: this.dataDirectory,
                    env,
                    detached: process.platform !== 'win32',
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
                }
            )
            this.loginChild = child
            let cancelled = false
            this.cancelCurrentLogin = () => {
                cancelled = true
            }
            child.stdout.on('data', chunk => this.log(chunk.toString()))
            child.stderr.on('data', chunk => this.log(chunk.toString()))
            child.once('error', error => {
                this.loginChild = null
                fs.rmSync(loginDirectory, { recursive: true, force: true })
                this.error = error.message
                this.log(error.message)
            })
            child.once('exit', code => {
                try {
                    if (this.loginChild === child) this.loginChild = null
                    if (cancelled) this.log('登录已取消；已保存的会话仍保留')
                    else if (code === 0) {
                        commitLogin(loginDirectory, this.dataDirectory, account.email)
                        if (pending) {
                            const next = validateSettings({
                                ...this.settings,
                                accounts: [...this.settings.accounts, account]
                            })
                            atomicJson(path.join(this.dataDirectory, 'desktop.json'), next)
                            this.settings = next
                        }
                        this.error = null
                        this.scheduler.reset()
                        this.log('登录会话已保存，可以开始任务')
                        setImmediate(() => {
                            void this.refreshBalance(account.id)
                                .catch(error => this.log(error.message))
                                .finally(() => this.scheduler.tick())
                        })
                    } else {
                        this.error = '登录未完成，请重新登录或导出诊断'
                        this.log(this.error)
                    }
                } catch (error) {
                    this.error = `登录保存失败：${error.message}`
                    this.log(this.error)
                } finally {
                    fs.rmSync(loginDirectory, { recursive: true, force: true })
                    this.emit('change')
                }
            })
            this.log('请在打开的浏览器里完成登录；手机和桌面会话会依次打开')
        })
    }
    async cancelLogin() {
        const child = this.loginChild
        if (!child) return
        this.cancelCurrentLogin?.()
        const done = new Promise(resolve => {
            child.once('exit', resolve)
            child.once('error', resolve)
        })
        try {
            if (child.connected) child.send({ type: 'desktop:cancel-login' }, () => {})
        } catch {}
        let timer
        await Promise.race([
            done,
            new Promise(resolve => {
                timer = setTimeout(resolve, 3000)
            })
        ])
        clearTimeout(timer)
        if (this.loginChild) await killTree(child.pid)
        await done
        this.loginChild = null
    }
    async restartBackend() {
        return this.exclusive('restarting', async () => {
            if (this.backend.endpoint) await this.ensureIdle()
            await this.backend.close()
            await this.ensureBackend()
            await this.backend.request('/health')
            await this.backend.close()
            this.error = null
            this.log('后台检查完成，已回到按需启动状态')
        })
    }
    accountSnapshot(account, allReports, allSessions, date) {
        const reports = allReports.filter(r => r.account?.toLowerCase() === account.email.toLowerCase())
        const sessions = allSessions.filter(s => s.email.toLowerCase() === account.email.toLowerCase())
        const run = this.runState.value
        const completedToday = this.daily.completed(account.email, this.settings.mode, date)
        const currentRun =
            run?.account === account.email.toLowerCase() && run.mode === this.settings.mode && run.date === date
        const automationStatus =
            currentRun && run.status === 'running'
                ? 'running'
                : completedToday
                  ? 'completed'
                  : currentRun || this.daily.value.days[dayKey(account.email, this.settings.mode, date)]
                    ? 'review'
                    : 'pending'
        const automationMessage =
            this.daily.error ||
            this.runState.error ||
            (automationStatus === 'running'
                ? '任务正在运行，结束后自动同步完成情况。'
                : automationStatus === 'completed'
                  ? '当前账号和模式今日已完成，跨日后可自动运行。'
                  : automationStatus === 'review'
                    ? (run?.account === account.email.toLowerCase() ? this.review : null) ||
                      '本次运行已结束，完成情况尚未确认，请查看运行结果。'
                    : !this.settings.schedule.enabled
                      ? '自动运行已关闭，可手动开始任务。'
                      : '今日尚无已确认的完成记录，应用将在空闲时检查自动运行条件。')
        let balance = this.balances[account.email.toLowerCase()] || null
        for (const report of reports) {
            const value = report.finalPoints ?? report.initialPoints
            const updatedAt = report.finalPoints != null ? report.finishedAt : report.startedAt
            if (
                Number.isSafeInteger(value) &&
                value >= 0 &&
                Number.isFinite(Date.parse(updatedAt)) &&
                (!balance || Date.parse(updatedAt) > Date.parse(balance.updatedAt))
            )
                balance = { value, updatedAt }
        }
        return {
            ...account,
            sessions,
            balance: {
                value: balance?.value ?? null,
                updatedAt: balance?.updatedAt ?? null,
                error: this.accountErrors[account.id] || null
            },
            automation: { date, completedToday, status: automationStatus, message: automationMessage },
            error: this.accountErrors[account.id] || null,
            review: run?.account === account.email.toLowerCase() ? this.review : null,
            interruption:
                this.runState.isInterrupted(account.email) ||
                this.daily.value.days[dayKey(account.email, this.settings.mode, date)]?.run?.status === 'interrupted'
                    ? interruptionMessage
                    : null
        }
    }
    async snapshot() {
        let allSessions = []
        try {
            allSessions = this.sessionReader()
        } catch (error) {
            this.error = error.message
        }
        const reports = this.reports()
        const run = this.runState.value
        if (
            run?.status === 'finished' &&
            !this.daily.error &&
            !this.daily.completed(run.account, run.mode, run.date) &&
            reportComplete(matchingReport(run, reports))
        )
            this.recordOutcome(reports)
        if (!this.daily.error) {
            for (const [key, day] of Object.entries(this.daily.value.days)) {
                const previous = day.run
                if (
                    !day.completed &&
                    previous?.status === 'finished' &&
                    previous.runId === day.runId &&
                    dayKey(previous.account, previous.mode, previous.date) === key &&
                    previous.lastExit?.code === 0 &&
                    !previous.lastExit.signal &&
                    reportComplete(matchingReport(previous, reports))
                )
                    this.daily.record(previous, true)
            }
        }
        const date = localDate(this.now())
        return {
            version: this.version,
            settings: this.settings,
            browser: this.browser,
            needsMigration: this.needsMigration,
            migrationEmail:
                this.needsMigration && fs.existsSync(path.join(this.dataDirectory, 'account-migration.json'))
                    ? JSON.parse(fs.readFileSync(path.join(this.dataDirectory, 'account-migration.json'), 'utf8')).email
                    : '',
            accounts: this.settings.accounts.map(account => this.accountSnapshot(account, reports, allSessions, date)),
            queue: this.queue,
            backendReady: Boolean(this.backend.endpoint),
            state: this.stopping
                ? 'exiting'
                : this.loginChild
                  ? 'login'
                  : this.operation ||
                    (this.finishing ? 'stopping' : this.backend.endpoint ? this.lastStatus.state : 'sleeping'),
            error: redact(this.error || this.daily.error || this.runState.error || '') || null,
            lastExit: this.lastStatus?.lastExit || null,
            reports
        }
    }
    diagnosticText() {
        return (
            `Rewards Desktop ${this.version}\nPlatform: ${process.platform} ${process.arch}\nNode: ${process.version}\n` +
            `Local date: ${localDate(this.now())}\nTimezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}\n` +
            `Daily state: ${redact(JSON.stringify(this.daily.value))}\nRun: ${redact(JSON.stringify(this.runState.value))}\n` +
            `Reports: ${redact(JSON.stringify(this.reports().slice(0, 3)))}\n` +
            `Schedule: ${JSON.stringify(this.settings.schedule)}\nError: ${redact(this.error || 'none')}\n` +
            this.logger.exportText()
        )
    }
    async clearData() {
        return this.exclusive('clearing', async () => {
            await this.ensureIdle()
            await this.backend.close()
            await this.setAutoStart(false)
            // Fixed application-owned entries only; never follow an arbitrary UI path.
            for (const name of [
                'sessions',
                'reports',
                'diagnostics',
                'logs',
                'config.json',
                'desktop.json',
                'desktop.json.bak',
                'schedule-state.json',
                'run-state.json',
                'balance.json',
                'balances.json',
                'account-migration.json',
                'account-migration-backup',
                'desktop.json.v1.bak',
                'daily-state.json'
            ]) {
                fs.rmSync(path.join(this.dataDirectory, name), { force: true, recursive: true })
            }
            this.settings = initializeData(
                this.dataDirectory,
                path.join(this.resourceDirectory, 'config.tasks.example.json')
            )
            this.browser = this.browserDetector(this.settings.browser)
            this.logger = new DailyLog(path.join(this.dataDirectory, 'logs'))
            this.daily.clear()
            this.scheduler.attempts.clear()
            this.review = null
            this.runState.error = null
            this.lastStatus = { state: 'idle', lastExit: null }
            this.runState.value = null
            this.balance = null
            this.balances = {}
            this.queue = null
            this.accountErrors = {}
            this.activeAccount = null
            this.balanceError = null
            this.scheduler.reset()
            this.error = null
            this.log('本地数据已清除，请重新设置账号')
        })
    }
    async close() {
        if (!this.closed) this.closed = this.closeService()
        return this.closed
    }
    async closeService() {
        this.stopping = true
        if (this.queue) this.queue.running = false
        clearInterval(this.timer)
        clearInterval(this.pruneTimer)
        if (this.scanChild) await killTree(this.scanChild.pid)
        await this.activeOperation
        await this.cancelLogin()
        if (this.backend.endpoint) {
            try {
                this.runState.observe(await this.backend.request('/status'))
            } catch {
                // Keep the running marker when the backend cannot confirm its exit.
            }
        }
        this.runState.interrupt()
        if (this.finishing) await this.finishing
        try {
            this.recordOutcome()
        } finally {
            await this.backend.close()
        }
    }
}
