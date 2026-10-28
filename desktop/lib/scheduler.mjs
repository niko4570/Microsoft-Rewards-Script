import { dayKey, localDate } from './dailyState.mjs'

// Completion is persisted; attempts belong to this host process only.
export class DesktopScheduler {
    constructor({ settings, daily, trigger, log, available = () => true, now = () => new Date() }) {
        Object.assign(this, { settings, daily, trigger, log, available, now })
        this.attempts = new Set()
        this.busy = false
        this.reset()
    }
    reset() {
        this.message = '按电脑系统日期检查今日任务'
    }
    markAttempt(run) {
        this.attempts.add(dayKey(run.account, run.mode, run.date))
    }
    async tick() {
        const settings = this.settings()
        if (this.busy || !settings.schedule.enabled || !settings.email) return
        const date = localDate(this.now())
        const key = dayKey(settings.email, settings.mode, date)
        if (this.daily.error) {
            this.message = this.daily.error
            return
        }
        if (this.daily.completed(settings.email, settings.mode, date)) {
            this.message = '今日任务已完成；等待系统日期跨日'
            return
        }
        if (this.attempts.has(key)) {
            this.message = '今日已尝试；未完成时可手动运行，完全退出并重新启动应用也可重试'
            return
        }
        if (!this.available()) return
        this.busy = true
        this.attempts.add(key)
        try {
            await this.trigger()
            this.message = '今日自动任务已启动；完成情况请查看运行结果'
        } catch (error) {
            if (error.safeToRetry) this.attempts.delete(key)
            this.message = `自动运行未完成：${error.message}`
            if (this.lastError !== this.message) this.log(this.message)
            this.lastError = this.message
        } finally {
            this.busy = false
        }
    }
}
