import fs from 'node:fs'
import { atomicJson } from './data.mjs'

export const interruptionMessage = '上次任务运行中断，请点击「开始任务」手动运行。'

export class RunState {
    constructor(file, reports = []) {
        this.file = file
        this.value = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
        if (this.value?.status === 'running') {
            // A finished report can survive an exit before the final IPC update.
            const finished = reports.some(
                report =>
                    report.account?.toLowerCase() === this.value.account &&
                    Date.parse(report.startedAt) >= Date.parse(this.value.startedAt) &&
                    Date.parse(report.finishedAt) >= Date.parse(report.startedAt)
            )
            this.save({ ...this.value, status: finished ? 'finished' : 'interrupted' })
        }
    }
    save(value) {
        atomicJson(this.file, value)
        this.value = value
    }
    start(account, nextResetAt) {
        this.save({
            account: account.toLowerCase(),
            startedAt: new Date().toISOString(),
            nextResetAt: Date.parse(nextResetAt) > Date.now() ? nextResetAt : null,
            status: 'running'
        })
    }
    observe(status) {
        if (this.value?.status !== 'running' || status?.state !== 'idle' || !status.lastExit) return
        if (!(Date.parse(status.lastExit.at) >= Date.parse(this.value.startedAt))) return
        this.save({
            ...this.value,
            status: status.lastExit.code === 0 && !status.lastExit.signal ? 'finished' : 'interrupted'
        })
    }
    interrupt() {
        if (this.value?.status === 'running') this.save({ ...this.value, status: 'interrupted' })
    }
    isInterrupted(account) {
        return this.value?.account === account.toLowerCase() && this.value.status === 'interrupted'
    }
    blocksCycle(account, nextResetAt) {
        if (!this.isInterrupted(account)) return false
        if (!this.value.nextResetAt) this.save({ ...this.value, nextResetAt })
        return Date.parse(this.value.nextResetAt) === Date.parse(nextResetAt)
    }
}
