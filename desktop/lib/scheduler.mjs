import fs from 'node:fs'
import { atomicJson } from './data.mjs'
import { interruptionMessage } from './runState.mjs'

// The server's next reset identifies the current cycle. Never derive it from
// local midnight or assume a daily interval. Persist attempts before starting.
export class DesktopScheduler {
    constructor({ file, settings, scan, trigger, log, interrupted = () => false, now = () => new Date() }) {
        Object.assign(this, { file, settings, scan, trigger, log, interrupted, now })
        this.state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
        if (!this.state || typeof this.state !== 'object' || Array.isArray(this.state))
            throw new Error('定时记录损坏，请检查数据目录')
        this.state.attempts ??= [] // migrate old date-based records
        if (!Array.isArray(this.state.attempts) || this.state.attempts.some(key => typeof key !== 'string'))
            throw new Error('定时记录损坏，请检查数据目录')
        this.busy = false
        this.reset()
    }
    reset() {
        this.checkAt = 0
        this.message = '等待检查 Rewards 重置时间'
    }
    async tick() {
        const settings = this.settings()
        if (this.busy || !settings.schedule.enabled || !settings.email || +this.now() < this.checkAt) return
        this.busy = true
        try {
            this.message = '正在检查 Rewards 重置时间'
            const result = await this.scan()
            const now = +this.now()
            if (typeof result.pending !== 'boolean') throw new Error('页面未返回有效的每日任务状态')
            const reset = Date.parse(result.nextStreakResetAt)
            if (!Number.isFinite(reset) || reset <= now) throw new Error('页面未返回有效的下一次重置时间')
            const cycle = `${settings.email.toLowerCase()}|${new Date(reset).toISOString()}`
            this.state.nextResetAt = new Date(reset).toISOString()
            this.state.account = settings.email.toLowerCase()
            this.checkAt = reset + 60000 // allow the server a minute to refresh
            if (this.interrupted(settings.email, this.state.nextResetAt)) {
                this.message = interruptionMessage
            } else if (!this.state.attempts.includes(cycle) && result.pending) {
                // Busy gates run before a cycle is consumed; failed starts retry
                // later. A successful start is the single automatic attempt.
                this.state.attempts.push(cycle)
                atomicJson(this.file, this.state)
                try {
                    await this.trigger()
                } catch (error) {
                    if (error.safeToRetry) {
                        this.state.attempts = this.state.attempts.filter(key => key !== cycle)
                        atomicJson(this.file, this.state)
                    }
                    throw error
                }
                this.message = '本周期自动任务已启动；等待下一次重置'
            } else {
                // Before the cycle has run, new point cards may appear after a
                // completed scan. Recheck without creating another run attempt.
                if (this.state.attempts.includes(cycle)) {
                    this.message = '本周期已自动运行；等待下一次重置'
                } else {
                    this.checkAt = now + 300000 < reset ? now + 300000 : reset + 60000
                    this.message = '当前未发现待执行任务；5 分钟后再次检查'
                }
            }
            atomicJson(this.file, this.state)
            this.log(`${this.message}（${this.state.nextResetAt}）`)
        } catch (error) {
            this.checkAt = +this.now() + 300000
            this.message = `检查未完成，5 分钟后重试：${error.message}`
            this.log(this.message)
        } finally {
            this.busy = false
        }
    }
}
