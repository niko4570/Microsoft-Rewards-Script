import fs from 'node:fs'
import { atomicJson } from './data.mjs'

export const interruptionMessage = '上次任务运行中断，请查看运行结果并导出诊断；可手动运行或重新启动应用重试。'

export class RunState {
    constructor(file) {
        this.file = file
        this.value = null
        this.error = null
        try {
            if (fs.existsSync(file)) {
                this.value = JSON.parse(fs.readFileSync(file, 'utf8'))
                if (
                    this.value &&
                    (!['running', 'finished', 'interrupted'].includes(this.value.status) ||
                        typeof this.value.account !== 'string' ||
                        !Number.isFinite(Date.parse(this.value.startedAt)))
                )
                    throw new Error('invalid run state')
                // A report alone cannot prove the process exited successfully.
                if (this.value?.status === 'running') this.save({ ...this.value, status: 'interrupted' })
            }
        } catch {
            // Invalid persisted data must never act as a live process lock.
            this.value = null
            this.error = '运行记录损坏，自动运行已暂停；请导出诊断并手动运行以恢复。'
        }
    }
    save(value) {
        if (this.error && fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`)
        atomicJson(this.file, value)
        this.value = value
        this.error = null
    }
    start(account, { date, mode, runId }) {
        this.save({
            account: account.toLowerCase(),
            date,
            mode,
            runId,
            startedAt: new Date().toISOString(),
            status: 'running'
        })
    }
    observe(status) {
        if (this.value?.status !== 'running' || status?.state !== 'idle' || !status.lastExit) return
        if (!(Date.parse(status.lastExit.at) >= Date.parse(this.value.startedAt))) return
        this.save({
            ...this.value,
            lastExit: status.lastExit,
            status: status.lastExit.code === 0 && !status.lastExit.signal ? 'finished' : 'interrupted'
        })
    }
    interrupt() {
        if (this.value?.status === 'running') this.save({ ...this.value, status: 'interrupted' })
    }
    isInterrupted(account) {
        return this.value?.account === account.toLowerCase() && this.value.status === 'interrupted'
    }
}
