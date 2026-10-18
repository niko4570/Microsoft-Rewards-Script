import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSchedule } from './scheduleStore.js'

// Only fixed daily schedules have a meaningful "today's run" to catch up.
export function dailyTime(schedule) {
    if (!schedule.enabled) return null
    const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(schedule.cron?.trim() || '')
    if (!match || Number(match[1]) > 59 || Number(match[2]) > 23) return null
    return Number(match[2]) * 60 + Number(match[1])
}

export function localClock(now, timezone) {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-GB', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23'
        })
            .formatToParts(now)
            .map(part => [part.type, part.value])
    )
    return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) }
}

export function shouldRun(schedule, state, now, { maxAttempts = 3, retryMinutes = 30 } = {}) {
    const target = dailyTime(schedule)
    if (target === null) return false
    if (state.nextStreakResetAt) {
        // The server's absolute timestamp takes precedence over local midnight and cron.
        if (state.completed) return now.getTime() >= Date.parse(state.nextStreakResetAt) + 60_000
        if (state.attempts >= maxAttempts) return false
        return !state.lastAttemptAt || now.getTime() - Date.parse(state.lastAttemptAt) >= retryMinutes * 60_000
    }
    const clock = localClock(now, schedule.timezone)
    if (clock.minute < target) return false
    if (state.date !== clock.date) return true
    if (state.completed || state.attempts >= maxAttempts) return false
    return !state.lastAttemptAt || now.getTime() - Date.parse(state.lastAttemptAt) >= retryMinutes * 60_000
}

export function readState(file) {
    if (!fs.existsSync(file)) return {}
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (
        !state ||
        !/^\d{4}-\d{2}-\d{2}$/.test(state.date) ||
        !Number.isSafeInteger(state.attempts) ||
        state.attempts < 0 ||
        typeof state.completed !== 'boolean' ||
        (state.nextStreakResetAt != null && !Number.isFinite(Date.parse(state.nextStreakResetAt))) ||
        !Number.isFinite(Date.parse(state.lastAttemptAt))
    ) {
        throw new Error(`Invalid daily scheduler state: ${file}. Restore or remove it after checking today's run.`)
    }
    return state
}

export function reportResetTime(directory, since) {
    if (!fs.existsSync(directory)) return null
    const times = []
    for (const name of fs.readdirSync(directory)) {
        if (!/^tasks-[a-f0-9]{12}-\d+\.json$/.test(name)) continue
        const report = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))
        if (!Number.isFinite(Date.parse(report.startedAt)) || Date.parse(report.startedAt) < Date.parse(since)) continue
        const time = Date.parse(report.nextStreakResetAt)
        if (Number.isFinite(time)) times.push(time)
    }
    return times.length ? new Date(Math.min(...times)).toISOString() : null
}

export function writeState(file, state) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
}

function positiveInteger(name, fallback) {
    const value = Number(process.env[name] ?? fallback)
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
    return value
}

export function main() {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
    const [command, trigger, date] = process.argv.slice(2)
    const file = process.env.DAILY_STATE_FILE || path.join(root, 'config', 'daily-run-state.json')
    const now = new Date()
    if (command === 'finish') {
        const state = readState(file)
        if (state.date !== date) throw new Error('Daily scheduler attempt date changed during the run')
        const nextStreakResetAt = reportResetTime(path.join(root, 'reports'), state.lastAttemptAt)
        writeState(file, { ...state, completed: true, completedAt: now.toISOString(), nextStreakResetAt })
        return 0
    }
    const schedule = readSchedule(root)
    if (trigger === 'catchup' && process.env.DAILY_CATCH_UP === 'false') return 10
    if (!schedule.enabled) return trigger === 'manual' ? 0 : 10
    if (dailyTime(schedule) === null) {
        // Preserve normal cron behavior for weekly / multiple-times-per-day schedules.
        return trigger === 'cron' || trigger === 'manual' ? 0 : 10
    }
    const state = readState(file)
    const options = {
        maxAttempts: positiveInteger('DAILY_MAX_ATTEMPTS', 3),
        retryMinutes: positiveInteger('DAILY_RETRY_MINUTES', 30)
    }
    if (trigger !== 'manual' && !shouldRun(schedule, state, now, options)) return 10
    if (command === 'begin') {
        const clock = localClock(now, schedule.timezone)
        writeState(file, {
            date: clock.date,
            nextStreakResetAt: state.nextStreakResetAt ?? null,
            attempts: state.nextStreakResetAt
                ? state.completed && now.getTime() >= Date.parse(state.nextStreakResetAt) + 60_000
                    ? 1
                    : state.attempts + 1
                : state.date === clock.date
                  ? state.attempts + 1
                  : 1,
            lastAttemptAt: now.toISOString(),
            completed: false
        })
        console.log(clock.date)
    } else if (command !== 'check') {
        throw new Error(`Unknown daily scheduler command: ${command}`)
    }
    return 0
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.exitCode = main()
    } catch (error) {
        console.error(`[daily-schedule] ${error.message}`)
        process.exitCode = 1
    }
}
