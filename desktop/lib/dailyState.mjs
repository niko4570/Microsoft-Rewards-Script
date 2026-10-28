import fs from 'node:fs'
import { atomicJson } from './data.mjs'

export function localDate(now = new Date()) {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function dayKey(account, mode, date) {
    return JSON.stringify([account.toLowerCase(), mode, date])
}

export class DailyState {
    constructor(file) {
        this.file = file
        this.value = { version: 1, days: {} }
        this.error = null
        try {
            if (fs.existsSync(file)) {
                const value = JSON.parse(fs.readFileSync(file, 'utf8'))
                if (
                    value?.version !== 1 ||
                    !value.days ||
                    typeof value.days !== 'object' ||
                    Array.isArray(value.days) ||
                    Object.values(value.days).some(day => !day || typeof day.completed !== 'boolean')
                )
                    throw new Error('invalid daily state')
                this.value = value
            }
        } catch {
            this.error = '每日运行记录损坏，自动运行已暂停；请导出诊断并手动运行以恢复。'
        }
    }
    completed(account, mode, date) {
        return !this.error && this.value.days[dayKey(account, mode, date)]?.completed === true
    }
    record(run, completed) {
        // Preserve the corrupt original before a deliberate manual run repairs it.
        if (this.error && fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`)
        const value = {
            ...this.value,
            days: {
                ...this.value.days,
                [dayKey(run.account, run.mode, run.date)]: { completed, runId: run.runId, startedAt: run.startedAt }
            }
        }
        atomicJson(this.file, value)
        this.value = value
        this.error = null
    }
    clear() {
        this.value = { version: 1, days: {} }
        this.error = null
    }
}

export function matchingReport(run, reports) {
    if (!run?.runId) return null
    return (
        reports.find(
            report =>
                report.runId === run.runId &&
                typeof report.account === 'string' &&
                report.account.toLowerCase() === run.account &&
                Date.parse(report.startedAt) >= Date.parse(run.startedAt) &&
                Date.parse(report.finishedAt) >= Date.parse(report.startedAt)
        ) || null
    )
}

export function reportComplete(report) {
    return Boolean(
        report &&
        !report.error &&
        Array.isArray(report.tasks) &&
        report.tasks.length &&
        report.tasks.every(task => task && ['completed', 'skipped'].includes(task.status))
    )
}
