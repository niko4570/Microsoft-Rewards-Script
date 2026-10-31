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
            start: () => service.startRun(),
            stop: () => service.stopRun(),
            login: () => service.login(),
            refreshBalance: () => service.refreshBalance(),
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
        if (action !== 'saveSettings' && value !== undefined && value !== null) throw new Error('此操作不接受参数')
        try {
            return (await this.actions[action](value)) ?? null
        } finally {
            this.changed()
        }
    }
}
