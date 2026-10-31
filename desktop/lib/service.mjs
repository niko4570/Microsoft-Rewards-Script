import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { listStoredSessions } from '../../scripts/api/sessionStore.js'
import { DailyState, localDate, matchingReport, reportComplete } from './dailyState.mjs'
import { Backend, killTree } from './backend.mjs'
import { atomicJson, initializeData, validateSettings, DailyLog, readReports, redact } from './data.mjs'
import { backendEnvironment } from './runtime.mjs'
import { DesktopScheduler } from './scheduler.mjs'
import { RunState, interruptionMessage } from './runState.mjs'
import { detectBrowsers } from './browser.mjs'

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
        this.balance = null
        this.balanceError = null
        try {
            const saved = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'balance.json'), 'utf8'))
            if (Number.isSafeInteger(saved.value) && saved.value >= 0 && Number.isFinite(Date.parse(saved.updatedAt)))
                this.balance = saved
        } catch {}
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
            settings: () => this.settings,
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
            trigger: () => this.startRun('自动'),
            available: () =>
                !this.stopping &&
                !this.operation &&
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
    reports() {
        return readReports(path.join(this.dataDirectory, 'reports'))
    }
    sessions() {
        return this.sessionReader().filter(session => session.email.toLowerCase() === this.settings.email.toLowerCase())
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
    async exclusive(name, action) {
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
    async startRun(source = '手动') {
        let submitted = false
        let ownsBackend = false
        try {
            return await this.exclusive('starting', async () => {
                await this.ensureIdle()
                if (!this.settings.email) throw new Error('请先设置账号并登录')
                const sessions = this.sessions()
                const stored = sessions.filter(
                    session =>
                        session.email.toLowerCase() === this.settings.email.toLowerCase() && session.hasStorageState
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
                this.runState.start(this.settings.email, {
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
            })
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
    async refreshBalance() {
        try {
            const result = await this.scanReset(true)
            if (!Number.isSafeInteger(result.balance) || result.balance < 0)
                throw new Error('未读取到积分余额，请稍后重试')
            this.balanceError = null
        } catch (error) {
            this.balanceError = redact(error.message)
            throw error
        } finally {
            this.emit('change')
        }
    }
    rememberBalance(result) {
        if (!Number.isSafeInteger(result.balance) || result.balance < 0) return
        this.balance = {
            account: this.settings.email.toLowerCase(),
            value: result.balance,
            updatedAt: result.updatedAt || new Date().toISOString()
        }
        atomicJson(path.join(this.dataDirectory, 'balance.json'), this.balance)
        this.balanceError = null
    }
    async scanReset(balanceOnly = false) {
        return this.exclusive(balanceOnly ? 'balance' : 'scanning', async () => {
            await this.ensureIdle()
            const sessions = this.sessions()
            if (
                !(balanceOnly ? ['desktop'] : ['mobile', 'desktop']).every(platform =>
                    sessions.some(
                        session =>
                            session.email.toLowerCase() === this.settings.email.toLowerCase() &&
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
                            settings: this.settings,
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
        if (this.loginChild) return this.cancelLogin()
        return this.exclusive('stopping', async () => {
            if (!this.backend.endpoint) return
            this.runState.interrupt()
            const result = await this.backend.request('/stop', 'POST', {})
            void this.finishRun().catch(error => this.log(error.message))
            return result
        })
    }
    async saveSettings(value) {
        const next = validateSettings(value)
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
            if (next.email !== previous.email) {
                this.balance = null
                this.balanceError = null
                fs.rmSync(path.join(this.dataDirectory, 'balance.json'), { force: true })
            }
            this.scheduler.reset()
            if (next.email !== previous.email || next.mode !== previous.mode || next.browser !== previous.browser) {
                await this.backend.close()
            }
            this.error = null
            this.log('设置已保存')
            return next
        })
    }
    async login() {
        // The desktop app has one local account slot. Keep existing session keys
        // on upgrade; new users authenticate only in the browser.
        if (!this.settings.email) await this.saveSettings({ ...this.settings, email: 'local@rewards.invalid' })
        return this.exclusive('login', async () => {
            await this.ensureIdle()
            await this.requireBrowser()
            const env = backendEnvironment({
                ...this,
                settings: this.settings,
                browser: this.browser.selected,
                token: ''
            })
            const child = spawn(
                this.executable,
                [
                    path.join(this.resourceDirectory, 'scripts/main/manualLogin.js'),
                    '--email',
                    this.settings.email,
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
                this.error = error.message
                this.log(error.message)
            })
            child.once('exit', code => {
                if (this.loginChild === child) this.loginChild = null
                if (cancelled) this.log('登录已取消；已保存的会话仍保留')
                else if (code === 0) {
                    this.error = null
                    this.scheduler.reset()
                    this.log('登录会话已保存，可以开始任务')
                    setImmediate(() => {
                        void this.refreshBalance()
                            .catch(error => this.log(error.message))
                            .finally(() => this.scheduler.tick())
                    })
                } else {
                    this.error = '登录未完成，请重新登录或导出诊断'
                    this.log(this.error)
                }
                this.emit('change')
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
    async snapshot() {
        const status = this.lastStatus
        let sessions = []
        try {
            sessions = this.sessions()
        } catch (error) {
            this.error = error.message
        }
        const reports = this.reports().filter(
            report => !report.account || report.account.toLowerCase() === this.settings.email.toLowerCase()
        )
        const date = localDate(this.now())
        const run = this.runState.value
        // A report can become readable after the exit event. Reconcile only a
        // verified normal exit, without launching the backend or replaying work.
        if (
            run?.status === 'finished' &&
            !this.daily.error &&
            !this.daily.completed(run.account, run.mode, run.date) &&
            reportComplete(matchingReport(run, reports))
        )
            this.recordOutcome(reports)
        const completedToday = this.daily.completed(this.settings.email, this.settings.mode, date)
        const currentRun =
            run?.account === this.settings.email.toLowerCase() && run.mode === this.settings.mode && run.date === date
        const automationStatus =
            currentRun && run.status === 'running'
                ? 'running'
                : completedToday
                  ? 'completed'
                  : currentRun
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
                    ? this.review || '本次运行已结束，完成情况尚未确认，请查看运行结果。'
                    : !this.settings.schedule.enabled
                      ? '自动运行已关闭，可手动开始任务。'
                      : '今日尚无已确认的完成记录，应用将在空闲时检查自动运行条件。')
        let balance = this.balance?.account === this.settings.email.toLowerCase() ? this.balance : null
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
            balance: { value: balance?.value ?? null, updatedAt: balance?.updatedAt ?? null, error: this.balanceError },
            version: this.version,
            settings: this.settings,
            browser: this.browser,
            automation: {
                date,
                completedToday,
                status: automationStatus,
                message: automationMessage
            },
            backendReady: Boolean(this.backend.endpoint),
            state: this.stopping
                ? 'exiting'
                : this.loginChild
                  ? 'login'
                  : this.operation || (this.finishing ? 'stopping' : this.backend.endpoint ? status.state : 'sleeping'),
            error: redact(this.error || this.daily.error || this.runState.error || '') || null,
            review: this.runState.value?.account === this.settings.email.toLowerCase() ? this.review : null,
            interruption: this.runState.isInterrupted(this.settings.email) ? interruptionMessage : null,
            lastExit: status?.lastExit || null,
            sessions,
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
