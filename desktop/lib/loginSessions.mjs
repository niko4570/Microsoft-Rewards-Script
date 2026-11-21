import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const tables = ['sessions', 'account_metadata']
const database = directory => path.join(directory, 'sessions', 'sessions.db')

// Copy only the selected session slot. Browsers never see another account's
// cookies, even during a failed or cancelled login.
function copyAccount(sourceFile, destinationFile, email, requireBoth = false) {
    const source = new DatabaseSync(sourceFile, { readOnly: true })
    let destination
    try {
        if (requireBoth) {
            const sessions = source.prepare('SELECT platform, storage_state FROM sessions WHERE email=?').all(email)
            if (
                !['mobile', 'desktop'].every(platform =>
                    sessions.some(row => {
                        if (row.platform !== platform) return false
                        try {
                            return JSON.parse(row.storage_state).cookies?.length > 0
                        } catch {
                            return false
                        }
                    })
                )
            )
                throw new Error('手机和桌面登录会话尚未全部保存')
        }
        destination = new DatabaseSync(destinationFile)
        destination.exec('BEGIN IMMEDIATE')
        for (const table of tables) {
            const schema = source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)
            if (!schema) continue
            if (!destination.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
                destination.exec(schema.sql)
            const rows = source.prepare(`SELECT * FROM ${table} WHERE email=?`).all(email)
            for (const row of rows) {
                const columns = Object.keys(row)
                    .map(name => `"${name.replaceAll('"', '""')}"`)
                    .join(',')
                destination
                    .prepare(
                        `INSERT OR REPLACE INTO ${table} (${columns}) VALUES (${Object.keys(row)
                            .map(() => '?')
                            .join(',')})`
                    )
                    .run(...Object.values(row))
            }
        }
        destination.exec('COMMIT')
    } catch (error) {
        if (destination?.isTransaction) destination.exec('ROLLBACK')
        throw error
    } finally {
        destination?.close()
        source.close()
    }
}

export function prepareLogin(directory, email) {
    const temporary = fs.mkdtempSync(path.join(directory, 'login-'))
    try {
        fs.mkdirSync(path.join(temporary, 'sessions'), { mode: 0o700 })
        const config = path.join(directory, 'config.json')
        if (fs.existsSync(config)) fs.copyFileSync(config, path.join(temporary, 'config.json'))
        if (fs.existsSync(database(directory))) copyAccount(database(directory), database(temporary), email)
        return temporary
    } catch (error) {
        fs.rmSync(temporary, { recursive: true, force: true })
        throw error
    }
}

export function commitLogin(temporary, directory, email) {
    copyAccount(database(temporary), database(directory), email, true)
}
