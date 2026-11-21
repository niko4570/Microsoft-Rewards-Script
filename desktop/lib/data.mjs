import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const defaults = {
    version: 2,
    accounts: [],
    mode: 'tasks',
    browser: 'auto',
    schedule: { enabled: false },
    startOnLogin: false
}

export function atomicJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(temporary, file)
}

export function validateSettings(value) {
    if (!value || typeof value !== 'object') throw new Error('设置格式无效')
    const accounts = Object.hasOwn(value, 'email')
        ? value.email
            ? [{ id: 'legacy', email: value.email, name: '', enabled: true }]
            : []
        : (value.accounts ?? [])
    if (!Array.isArray(accounts)) throw new Error('账号列表无效')
    const seen = new Set()
    const ids = new Set()
    const normalized = accounts.map(account => {
        const email = validateEmail(account.email)
        if (
            seen.has(email) ||
            typeof account.id !== 'string' ||
            !/^[a-zA-Z0-9-]{1,64}$/.test(account.id) ||
            ids.has(account.id)
        )
            throw new Error('账号重复或标识无效')
        if (typeof account.name !== 'string' || account.name.length > 80 || typeof account.enabled !== 'boolean')
            throw new Error('账号设置无效')
        seen.add(email)
        ids.add(account.id)
        return { id: account.id, email: account.email.trim(), name: account.name.trim(), enabled: account.enabled }
    })
    const mode = value.mode ?? 'tasks'
    if (!['tasks', 'tasks-search'].includes(mode)) throw new Error('运行模式无效')
    const browser = value.browser ?? 'auto'
    if (!['auto', 'chrome', 'edge'].includes(browser)) throw new Error('浏览器选择无效')
    const schedule = value.schedule
    if (!schedule || typeof schedule.enabled !== 'boolean') throw new Error('自动运行设置无效')
    if (typeof value.startOnLogin !== 'boolean') throw new Error('开机启动设置无效')
    return {
        version: 2,
        accounts: normalized,
        mode,
        browser,
        schedule: { enabled: schedule.enabled },
        startOnLogin: value.startOnLogin
    }
}

export function validateEmail(value) {
    if (
        typeof value !== 'string' ||
        value.length > 254 ||
        !/^[^\s@"'=#<>\\]+@[^\s@"'=#<>\\]+\.[^\s@"'=#<>\\]+$/.test(value.trim())
    )
        throw new Error('请输入有效的账号邮箱')
    return value.trim().toLowerCase()
}

export function newAccount(email, name = '') {
    return { id: randomUUID(), email: validateEmail(email), name, enabled: true }
}

export function initializeData(directory, template) {
    fs.mkdirSync(directory, { recursive: true })
    for (const name of ['sessions', 'reports', 'logs', 'diagnostics'])
        fs.mkdirSync(path.join(directory, name), { recursive: true })
    const settingsFile = path.join(directory, 'desktop.json')
    if (!fs.existsSync(settingsFile)) atomicJson(settingsFile, defaults)
    const original = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    const settings = validateSettings(original)
    if (original.version !== 2) {
        if (!fs.existsSync(settingsFile + '.v1.bak')) fs.copyFileSync(settingsFile, settingsFile + '.v1.bak')
        atomicJson(settingsFile, settings)
    }
    const configFile = path.join(directory, 'config.json')
    if (!fs.existsSync(configFile)) {
        const config = JSON.parse(fs.readFileSync(template, 'utf8'))
        config.tasksOnly = true
        config.headless = true
        config.clusters = 1
        config.sessionPath = 'sessions'
        config.workers.doDesktopSearch = false
        config.workers.doMobileSearch = false
        config.workers.doBonusSearches = false
        for (const webhook of ['telegram']) {
            config.webhook[webhook].enabled = false
            for (const field of ['url', 'token', 'topic', 'botToken', 'chatId']) {
                if (field in config.webhook[webhook]) config.webhook[webhook][field] = ''
            }
        }
        atomicJson(configFile, config)
    }
    return settings
}

export function redact(value) {
    return String(value)
        .replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '')
        .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]')
        .replace(/https?:\/\/[^\s<>"']+/gi, '[URL已隐藏]')
        .replace(/(?:bearer\s+)[\w.+/=-]+/gi, 'Bearer [已隐藏]')
        .replace(
            /((?:password|token|secret|chat.?id|cookie|authorization)\s*["']?\s*[:=]\s*)[^\r\n,}]+/gi,
            '$1[已隐藏]'
        )
        .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[令牌已隐藏]')
}

export class DailyLog {
    constructor(directory) {
        this.directory = directory
        this.cleanup()
    }
    cleanup(now = Date.now()) {
        fs.mkdirSync(this.directory, { recursive: true })
        for (const name of fs.readdirSync(this.directory)) {
            if (/^\d{4}-\d{2}-\d{2}\.log$/.test(name) && now - Date.parse(name.slice(0, 10)) > 30 * 86400000) {
                fs.unlinkSync(path.join(this.directory, name))
            }
        }
    }
    write(message) {
        const now = new Date().toISOString()
        const line = `${now} ${redact(message)}`
        fs.appendFileSync(path.join(this.directory, `${now.slice(0, 10)}.log`), line + '\n', { mode: 0o600 })
        return line
    }
    exportText() {
        this.cleanup()
        return fs
            .readdirSync(this.directory)
            .filter(name => /^\d{4}-\d{2}-\d{2}\.log$/.test(name))
            .sort()
            .slice(-7)
            .map(name => `\n--- ${name} ---\n${redact(fs.readFileSync(path.join(this.directory, name), 'utf8'))}`)
            .join('')
    }
}

export function readReports(directory) {
    return fs
        .readdirSync(directory)
        .filter(name => /^tasks-[a-f0-9]{12}-\d+\.json$/.test(name))
        .sort((a, b) => Number(b.match(/-(\d+)\.json$/)[1]) - Number(a.match(/-(\d+)\.json$/)[1]))
        .map(name => {
            try {
                const report = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))
                if (
                    !report ||
                    typeof report !== 'object' ||
                    !Array.isArray(report.tasks) ||
                    (report.account !== undefined && typeof report.account !== 'string')
                )
                    throw new Error('invalid report')
                return report
            } catch {
                return { tasks: [], startedAt: '', error: '报告文件损坏，无法读取' }
            }
        })
}
