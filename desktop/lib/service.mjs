import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Backend, killTree } from './backend.mjs'
import { atomicJson, initializeData, validateSettings, DailyLog, readReports, redact } from './data.mjs'
import { backendEnvironment } from './runtime.mjs'
import { DesktopScheduler } from './scheduler.mjs'

export class DesktopService extends EventEmitter {
    constructor({
        executable,
        resourceDirectory,
        dataDirectory,
        version,
        backendFactory = options => new Backend(options),
        resetScanner,
        setAutoStart = () => {}
    }) {
        super()
        Object.assign(this, { executable, resourceDirectory, dataDirectory, version, setAutoStart })
        this.settings = initializeData(dataDirectory, path.join(resourceDirectory, 'config.tasks.example.json'))
        this.logger = new DailyLog(path.join(dataDirectory, 'logs'))
        this.resetScanner = resetScanner
        this.error = null
        this.operation = null
        this.loginChild = null
        this.stopping = false
        this.backend = backendFactory({
            executable,
            resourceDirectory,
            dataDirectory,
            settings: () => this.settings,
            log: line => this.log(line)
        })
        this.backend.on('failure', message => {
            this.error = message
            this.log(message)
        })
        this.scheduler = new DesktopScheduler({
            file: path.join(dataDirectory, 'schedule-state.json'),
            settings: () => this.settings,
            scan: () => this.scanReset(),
            trigger: () => this.startRun('自动'),
            log: line => this.log(line)
        })
    }
    log(message) {
        this.logger.write(message)
        this.emit('change')
    }
    async start() {
        try {
            await this.backend.start()
            this.error = null
            this.log('后台已就绪；开启自动运行后按 Rewards 重置时间检查任务')
        } catch (error) {
            this.error = error.message
            this.log(error.message)
        }
        this.timer = setInterval(() => {
            void this.scheduler.tick().catch(error => {
                this.error = error.message
                this.log(error.message)
            })
        }, 10000)
        this.pruneTimer = setInterval(() => this.logger.cleanup(), 86400000)
        void this.scheduler.tick()
    }
    async exclusive(name, action) {
        if (this.stopping) throw new Error('应用正在退出')
        if (this.operation || this.loginChild) throw new Error('登录或其他操作正在进行，请先完成或取消')
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
        const status = await this.backend.request('/status')
        if (status.state !== 'idle') throw new Error('任务正在运行，请先停止')
    }
    async startRun(source = '手动') {
        let submitted = false
        try {
            return await this.exclusive('starting', async () => {
                await this.ensureIdle()
                if (!this.settings.email) throw new Error('请先设置账号并登录')
                const { sessions } = await this.backend.request('/sessions')
                const stored = sessions.filter(
                    session =>
                        session.email.toLowerCase() === this.settings.email.toLowerCase() && session.hasStorageState
                )
                if (!['mobile', 'desktop'].every(platform => stored.some(session => session.platform === platform)))
                    throw new Error('请先完成手机和桌面会话登录')
                submitted = true
                const result = await this.backend.request('/start', 'POST', { accountIndex: 1 })
                this.log(`${source}任务已启动`)
                return result
            })
        } catch (error) {
            // Once /start was sent, an uncertain response must not cause a
            // second automatic run after a timeout or lost connection.
            error.safeToRetry = !submitted
            throw error
        }
    }
    async scanReset() {
        return this.exclusive('scanning', async () => {
            await this.ensureIdle()
            const { sessions } = await this.backend.request('/sessions')
            if (
                !['mobile', 'desktop'].every(platform =>
                    sessions.some(
                        session =>
                            session.email.toLowerCase() === this.settings.email.toLowerCase() &&
                            session.platform === platform &&
                            session.hasStorageState
                    )
                )
            )
                throw new Error('请先完成手机和桌面会话登录')
            if (this.stopping) throw new Error('应用正在退出')
            if (this.resetScanner) return this.resetScanner()
            return new Promise((resolve, reject) => {
                const child = spawn(this.executable, [path.join(this.resourceDirectory, 'scripts/main/scanReset.js')], {
                    cwd: this.dataDirectory,
                    env: backendEnvironment({ ...this, settings: this.settings, token: '' }),
                    detached: process.platform !== 'win32',
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
                })
                this.scanChild = child
                let result
                let failure
                const timer = setTimeout(() => {
                    failure = new Error('重置时间检查超时')
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
                    if (error || failure || !result) reject(error || failure || new Error('重置时间检查未完成'))
                    else resolve(result)
                }
                child.once('error', finish)
                child.once('exit', () => finish())
            })
        })
    }
    async stopRun() {
        if (this.loginChild) return this.cancelLogin()
        return this.backend.request('/stop', 'POST', {})
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
            this.scheduler.reset()
            if (next.email !== previous.email || next.mode !== previous.mode) {
                await this.backend.close()
                await this.backend.start()
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
            const env = backendEnvironment({ ...this, settings: this.settings, token: '' })
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
                    void this.scheduler.tick()
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
            await this.backend.start()
            this.error = null
            this.log('后台已重启')
        })
    }
    async snapshot() {
        let status = null
        let sessions = []
        if (this.backend.endpoint) {
            try {
                const results = await Promise.all([this.backend.request('/status'), this.backend.request('/sessions')])
                status = results[0]
                sessions = results[1].sessions.filter(
                    session => session.email.toLowerCase() === this.settings.email.toLowerCase()
                )
            } catch (error) {
                this.error = error.message
            }
        }
        return {
            version: this.version,
            settings: this.settings,
            automation: {
                nextResetAt:
                    this.scheduler.state.account === this.settings.email.toLowerCase()
                        ? this.scheduler.state.nextResetAt || null
                        : null,
                message: this.scheduler.message
            },
            backendReady: Boolean(this.backend.endpoint),
            state: this.stopping ? 'exiting' : this.loginChild ? 'login' : this.operation || status?.state || 'offline',
            error: this.error ? redact(this.error) : null,
            lastExit: status?.lastExit || null,
            sessions,
            reports: readReports(path.join(this.dataDirectory, 'reports')).filter(
                report => !report.account || report.account.toLowerCase() === this.settings.email.toLowerCase()
            ),
            logs: this.logger.lines.slice(-300)
        }
    }
    diagnosticText() {
        return (
            `Rewards Desktop ${this.version}\nPlatform: ${process.platform} ${process.arch}\nNode: ${process.version}\n` +
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
                'schedule-state.json'
            ]) {
                fs.rmSync(path.join(this.dataDirectory, name), { force: true, recursive: true })
            }
            this.settings = initializeData(
                this.dataDirectory,
                path.join(this.resourceDirectory, 'config.tasks.example.json')
            )
            this.logger = new DailyLog(path.join(this.dataDirectory, 'logs'))
            this.scheduler.state = { attempts: [] }
            this.scheduler.reset()
            await this.backend.start()
            this.error = null
            this.log('本地数据已清除，请重新设置账号')
        })
    }
    async close() {
        this.stopping = true
        clearInterval(this.timer)
        clearInterval(this.pruneTimer)
        if (this.scanChild) await killTree(this.scanChild.pid)
        await this.activeOperation
        await this.cancelLogin()
        await this.backend.close()
    }
}
