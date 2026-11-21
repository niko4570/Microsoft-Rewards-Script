import fs from 'node:fs'
import { DesktopUpdater } from './updater.mjs'

// The transport is private stdin/stdout, never a renderer-accessible HTTP port.
// Native dialogs and OS operations are delegated to the trusted Tauri shell.
export class DesktopHost {
    constructor({ service, native, version, publish = () => {}, updater }) {
        Object.assign(this, { service, native, publish })
        this.updater = updater || new DesktopUpdater({ version, onChange: () => this.changed() })
        this.uiVisible = false
        this.actions = {
            snapshot: () => {
                this.uiVisible = true
                return this.snapshot()
            },
            detectBrowser: () => service.detectBrowser(),
            downloadChrome: () => this.native('downloadChrome'),
            downloadEdge: () => this.native('downloadEdge'),
            checkUpdate: () => this.updater.check(),
            downloadUpdate: () => this.updateApp(true),
            installUpdate: () => this.updateApp(false),
            showUpdateFile: () => {
                if (!this.updater.state.filePath) throw new Error('请先下载安装包')
                return this.native('revealFile', this.updater.state.filePath)
            },
            start: value => service.startQueue([value.accountId]),
            startAll: () => service.startQueue(),
            saveAccount: value => service.saveAccount(value),
            removeAccount: value => service.removeAccount(value.accountId),
            completeMigration: value => service.completeMigration(value.email),
            stop: () => service.stopRun(),
            login: value => service.login(value?.accountId),
            refreshBalance: value => service.refreshBalance(value.accountId),
            cancelLogin: () => service.cancelLogin(),
            saveSettings: value => service.saveSettings(value),
            restartBackend: () => service.restartBackend(),
            openDataDirectory: () => this.native('openDirectory', service.dataDirectory),
            exportDiagnostics: async () => {
                const destination = await this.native('saveFile', {
                    name: `rewards-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`,
                    kind: 'diagnostics'
                })
                if (!destination) return false
                fs.writeFileSync(destination, service.diagnosticText(), { mode: 0o600 })
                return true
            },
            clearData: async () => {
                if (!(await this.native('confirmClear'))) return false
                await service.clearData()
                return true
            },
            suspend: () => {
                this.uiVisible = false
            },
            resume: () => {
                this.uiVisible = true
                service.scheduler.reset()
                return service.scheduler.tick()
            }
        }
        service.on('change', () => this.changed())
    }

    async updateApp(download) {
        try {
            return await this.service.exclusive('updating', async () => {
                await this.service.ensureIdle()
                if (download) await this.updater.download(name => this.native('updateDestination', name))
                const result = await this.updater.install(file => this.native('installUpdate', file))
                // Keep the scheduler and other operations blocked until the shell exits.
                this.service.stopping = true
                return result
            })
        } catch (error) {
            this.updater.setState({ error: error.message })
            throw error
        }
    }

    snapshot() {
        return this.service.snapshot().then(value => ({ ...value, update: this.updater.state }))
    }

    changed() {
        this.dirty = true
    }

    async refresh() {
        if (this.refreshBusy) return
        this.refreshBusy = true
        try {
            this.dirty = false
            this.publish(await this.snapshot())
        } catch (error) {
            this.service.error = error.message
        } finally {
            this.refreshBusy = false
        }
    }

    async invoke(action, value) {
        if (typeof action !== 'string' || !Object.hasOwn(this.actions, action)) throw new Error('不支持的操作')
        validateAction(action, value)
        try {
            return (await this.actions[action](value)) ?? null
        } finally {
            this.changed()
        }
    }
}

export function validateAction(action, value) {
    if (action === 'login' && value == null) return
    const fields = {
        start: ['accountId'],
        login: ['accountId'],
        refreshBalance: ['accountId'],
        removeAccount: ['accountId'],
        completeMigration: ['email'],
        saveAccount: ['id', 'email', 'name', 'enabled']
    }
    if (action === 'saveSettings') return
    if (!fields[action]) {
        if (value !== undefined && value !== null) throw new Error('此操作不接受参数')
        return
    }
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some(k => !fields[action].includes(k))
    )
        throw new Error('操作参数无效')
    if (
        fields[action].includes('accountId') &&
        (typeof value.accountId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(value.accountId))
    )
        throw new Error('账号标识无效')
    if (action === 'completeMigration' && typeof value.email !== 'string') throw new Error('邮箱无效')
    if (
        action === 'saveAccount' &&
        (typeof value.name !== 'string' ||
            (value.id
                ? Object.hasOwn(value, 'enabled') && typeof value.enabled !== 'boolean'
                : typeof value.email !== 'string'))
    )
        throw new Error('账号参数无效')
}
