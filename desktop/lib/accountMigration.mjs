import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { atomicJson, validateEmail } from './data.mjs'

export const legacyEmail = 'local@rewards.invalid'

// Called only while all browser and task processes are closed. A journal makes
// the cross-file migration repeatable; the desktop settings are committed last.
export function migrateLegacy(directory, settings, value) {
    const email = validateEmail(value)
    if (email === legacyEmail || settings.accounts.some(a => a.email === email)) throw new Error('邮箱已存在或不可用')
    const journalFile = path.join(directory, 'account-migration.json')
    let journal
    if (fs.existsSync(journalFile)) {
        journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'))
        if (journal.email !== email) throw new Error('请使用上次填写的邮箱继续迁移')
    } else {
        const backup = path.join(directory, 'account-migration-backup')
        if (fs.existsSync(backup)) throw new Error('迁移备份已存在，请导出诊断后检查')
        fs.mkdirSync(backup)
        for (const name of [
            'desktop.json',
            'sessions',
            'reports',
            'balance.json',
            'daily-state.json',
            'run-state.json'
        ]) {
            const source = path.join(directory, name)
            if (fs.existsSync(source)) fs.cpSync(source, path.join(backup, name), { recursive: true })
        }
        journal = { email }
        atomicJson(journalFile, journal)
    }
    const dbFile = path.join(directory, 'sessions', 'sessions.db')
    if (fs.existsSync(dbFile)) {
        const db = new DatabaseSync(dbFile)
        try {
            db.exec('BEGIN IMMEDIATE')
            for (const table of ['sessions', 'account_metadata']) {
                if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue
                const old = db.prepare(`SELECT 1 FROM ${table} WHERE LOWER(email)=?`).get(legacyEmail)
                const target = db.prepare(`SELECT 1 FROM ${table} WHERE LOWER(email)=?`).get(email)
                if (old && target) throw new Error('目标邮箱已有登录数据，迁移已停止')
                db.prepare(`UPDATE ${table} SET email=? WHERE LOWER(email)=?`).run(email, legacyEmail)
            }
            db.exec('COMMIT')
        } catch (error) {
            db.exec('ROLLBACK')
            throw error
        } finally {
            db.close()
        }
    }
    function replace(value) {
        if (typeof value === 'string') return value.toLowerCase() === legacyEmail ? email : value
        if (Array.isArray(value)) return value.map(replace)
        if (!value || typeof value !== 'object') return value
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => {
                let next = key
                if (key.startsWith('[')) {
                    const parts = JSON.parse(key)
                    if (parts[0] === legacyEmail) {
                        parts[0] = email
                        next = JSON.stringify(parts)
                    }
                }
                if (next !== key && Object.hasOwn(value, next)) throw new Error('目标邮箱已有完成记录')
                return [next, replace(entry)]
            })
        )
    }
    for (const name of [
        'balance.json',
        'daily-state.json',
        'run-state.json',
        ...fs
            .readdirSync(path.join(directory, 'reports'))
            .filter(n => /^tasks-[a-f0-9]{12}-\d+\.json$/.test(n))
            .map(n => `reports/${n}`)
    ]) {
        const file = path.join(directory, name)
        if (fs.existsSync(file)) atomicJson(file, replace(JSON.parse(fs.readFileSync(file, 'utf8'))))
    }
    const next = { ...settings, accounts: settings.accounts.map(a => (a.email === legacyEmail ? { ...a, email } : a)) }
    atomicJson(path.join(directory, 'desktop.json'), next)
    fs.rmSync(journalFile)
    return next
}
