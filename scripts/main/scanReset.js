// Read only: restore the saved session and inspect Rewards page data. This
// process never invokes task handlers, searches or reward submission actions.
import path from 'node:path'
import { createRequire } from 'node:module'
import { chromium } from 'patchright'
import { newInjectedContext } from 'fingerprint-injector'
import { getSessionDbPath, openSessionDb, loadSessionRow, closeSessionDb } from '../utils.js'
import { readResetPage } from './readResetPage.js'

if (process.argv.includes('--help')) {
    console.log('Rewards Desktop read-only reset inspection; uses the saved account session and desktop environment.')
    process.exit(0)
}

const require = createRequire(import.meta.url)
const { URLs } = require(path.join(process.env.MRS_RESOURCE_DIR, 'dist/constants/urls.js'))
const ReactFunc = require(path.join(process.env.MRS_RESOURCE_DIR, 'dist/browser/ReactFunc.js')).default
const { hasPendingEarnTasks } = require(path.join(process.env.MRS_RESOURCE_DIR, 'dist/functions/TaskPolicy.js'))
const balanceOnly = process.argv.includes('--balance')
let browser
process.on('disconnect', () => {
    void browser?.close().finally(() => process.exit(130))
})
try {
    const { dbPath, exists } = getSessionDbPath(process.env.MRS_DATA_DIR, 'sessions')
    if (!exists) throw new Error('请先完成会话登录')
    const db = openSessionDb(dbPath, { readonly: true })
    let session
    try {
        session = loadSessionRow(db, process.env.ACCOUNT_1_EMAIL, 'desktop')
    } finally {
        closeSessionDb(db)
    }
    if (!session?.storageState) throw new Error('请先完成桌面会话登录')
    browser = await chromium.launch({ headless: true, channel: 'chromium' })
    const options = { storageState: session.storageState }
    const context = session.fingerprint
        ? await newInjectedContext(browser, { fingerprint: session.fingerprint, newContextOptions: options })
        : await browser.newContext(options)
    const page = await context.newPage()
    const html = []
    for (const url of balanceOnly
        ? [URLs.rewards.earn]
        : [URLs.rewards.earn, URLs.rewards.earnStreaks, URLs.rewards.dashboard]) {
        html.push(await readResetPage(page, url))
    }
    const logger = { info() {}, debug() {}, warn() {}, error() {} }
    const snapshot = new ReactFunc({
        logger,
        isMobile: false,
        currentAccountEmail: process.env.ACCOUNT_1_EMAIL
    }).snapshotPage(html)
    if (snapshot.account.level === null && snapshot.account.availablePoints === null)
        throw new Error('未确认登录状态，请重新登录')
    if (snapshot.warnings?.length) throw new Error('Rewards 返回账户警告，请手动检查')
    const balance = snapshot.account.availablePoints
    const updatedAt = new Date().toISOString()
    if (balanceOnly) {
        if (!Number.isSafeInteger(balance) || balance < 0) throw new Error('未读取到积分余额，请稍后重试')
        process.send?.({ type: 'desktop:reset', balance, updatedAt })
    } else {
        const today = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Shanghai',
            month: '2-digit',
            day: '2-digit',
            year: 'numeric'
        }).format(new Date())
        const searchesEnabled =
            process.env.CONFIG_WORKER_DESKTOP_SEARCH === 'true' || process.env.CONFIG_WORKER_MOBILE_SEARCH === 'true'
        const pendingSearch =
            searchesEnabled &&
            (!snapshot.searchCounters ||
                Object.values(snapshot.searchCounters)
                    .flat()
                    .some(counter => counter.pointProgress < counter.pointProgressMax))
        const pending = hasPendingEarnTasks(snapshot, today) || pendingSearch
        if (!snapshot.streaks.length && !pending) throw new Error('未读取到每日任务状态')
        process.send?.({
            type: 'desktop:reset',
            nextStreakResetAt: snapshot.nextStreakResetAt,
            pending,
            balance,
            updatedAt
        })
    }
} catch (error) {
    process.send?.({ type: 'desktop:reset-error', error: error.message })
    process.exitCode = 1
} finally {
    await browser?.close()
    process.disconnect?.()
}
