import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const test = require('node:test')
const assert = require('node:assert/strict')
const { default: ReactFunc } = require('../../dist/browser/ReactFunc')
const { default: BrowserFunc } = require('../../dist/browser/BrowserFunc')
const { mapEarnToDashboard } = require('../../dist/browser/EarnDashboard')
const { offerSkipReason, hasPendingEarnTasks } = require('../../dist/functions/TaskPolicy')

const logger = { info() {}, debug() {}, warn() {}, error() {} }
const today = '10/12/2026'
function payload(objects) {
    return `<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify(objects))}])</script>`
}
function parse(objects) {
    return new ReactFunc({ logger, isMobile: true }).snapshotPage(payload(objects))
}
const account = { balance: 1367, level: 1 }

test('app service 502 remains a recoverable warning; authentication failures retain error severity', async () => {
    const logs = []
    let status = 502
    const bot = {
        config: { tasksOnly: true },
        isMobile: true,
        accessToken: 'test-token',
        userData: { geoLocale: 'CN', langCode: 'zh-CN' },
        logger: {
            warn: () => logs.push('warn'),
            error: () => logs.push('error')
        },
        http: {
            request: async () => {
                throw Object.assign(new Error(`HTTP ${status}`), { status })
            }
        }
    }
    const func = new BrowserFunc(bot)
    await assert.rejects(func.getAppDashboardData(), { status: 502 })
    assert.deepEqual(logs, ['warn'])
    status = 401
    await assert.rejects(func.getAppDashboardData(), { status: 401 })
    assert.deepEqual(logs, ['warn', 'error'])
})

const link = {
    offerId: 'dynamic-link',
    title: 'Daily link',
    name: 'dynamic-link',
    hash: 'signed-task',
    destination: 'https://www.bing.com/search?q=weather',
    points: 5,
    isCompleted: false,
    priority: 0
}

test('automatic inspection includes point cards after daily streak completion', () => {
    const completedStreak = { partner: 'dailyset', dailyPoints: [5], isCurrentDayCompleted: true }
    const snapshot = parse([account, completedStreak, link])
    assert.equal(snapshot.streaks.some(streak => !streak.isCurrentDayCompleted), false)
    assert.equal(hasPendingEarnTasks(snapshot, today), true)
    assert.equal(hasPendingEarnTasks(parse([account, link]), today), true)
    assert.equal(hasPendingEarnTasks(parse([account, completedStreak]), today), false)
})

test('automatic inspection follows task eligibility and current-day filtering', () => {
    const completedStreak = { partner: 'dailyset', dailyPoints: [5], isCurrentDayCompleted: true }
    for (const patch of [
        { isCompleted: true }, { isLocked: true }, { isPromotional: true },
        { promotionType: 'quiz' }, { points: 0 }, { priority: -1 },
        { hash: null }, { date: '2000-01-01' }, { date: '2099-01-01' }
    ]) {
        assert.equal(hasPendingEarnTasks(parse([account, completedStreak, { ...link, ...patch }]), today), false, JSON.stringify(patch))
    }
    assert.equal(hasPendingEarnTasks(parse([account, { ...completedStreak, isCurrentDayCompleted: false }]), today), true)
})

test('current balance header is parsed; progress and lifetime totals are never mistaken for balance', () => {
    const snapshot = parse([account, { level: 1, pointsProgress: 469, pointsRemaining: 31, lifetimeEarn: 9999 }, link])
    assert.equal(snapshot.account.availablePoints, 1367)
    assert.equal(snapshot.account.level, 1)
    const absent = parse([{ level: 1, pointsProgress: 469, pointsRemaining: 31 }, { balance: 99 }, link])
    assert.equal(absent.account.availablePoints, null)
    const dashboard = mapEarnToDashboard(absent, today)
    assert.equal(dashboard.availablePointsKnown, false)
    assert.equal(parse([{ ...account, balance: 0 }]).account.availablePoints, 0)
})

test('adapts page link cards, preserves completion, locks, promotional and unsupported types', () => {
    const snapshot = parse([
        account,
        link,
        { ...link, offerId: 'done', isCompleted: true },
        { ...link, offerId: 'locked', isLocked: true },
        { ...link, offerId: 'promo', isPromotional: true },
        { ...link, offerId: 'quiz', promotionType: 'quiz' },
        { offerId: 'unknown', points: 5, hash: 'opaque' }
    ])
    const data = mapEarnToDashboard(snapshot, today)
    const byId = id => data.dashboard.morePromotions.find(offer => offer.offerId === id)
    assert.equal(byId('dynamic-link').promotionType, 'urlreward')
    assert.equal(offerSkipReason(byId('dynamic-link')), undefined)
    assert.equal(byId('done').complete, true)
    assert.equal(offerSkipReason(byId('locked')), '任务未解锁')
    assert.match(offerSkipReason(byId('promo')), /促销/)
    assert.match(offerSkipReason(byId('quiz')), /quiz/)
    assert.match(offerSkipReason(byId('unknown')), /unknown/)
    assert.deepEqual(data.dashboard.userStatus.counters.activityAndQuiz, [])
})

test('daily list includes only today; ISO and slash dates do not expose future or old tasks', () => {
    const data = mapEarnToDashboard(
        parse([
            account,
            { ...link, date: '10/12/2026' },
            { ...link, offerId: 'iso', date: '2026-10-12' },
            { ...link, offerId: 'future', date: '2026-10-13' },
            { ...link, offerId: 'old', date: '10/11/2026' }
        ]),
        today
    )
    assert.deepEqual(
        data.dashboard.dailySetPromotions[today].map(offer => offer.offerId),
        ['dynamic-link', 'iso']
    )
    assert.deepEqual(data.dashboard.morePromotions, [])
})

test('task mode reads the page without touching either unavailable legacy endpoint', async () => {
    let legacyCalls = 0
    const bot = {
        config: { tasksOnly: true },
        logger,
        isMobile: true,
        reactSnapshots: {},
        utils: { getFormattedDate: () => today },
        http: {
            request: () => {
                legacyCalls++
                throw new Error('legacy HTTP 500')
            }
        }
    }
    const func = new BrowserFunc(bot)
    func.refreshEarnSnapshot = async () => parse([account, link])
    const data = await func.getDashboardData()
    assert.equal(data.dashboard.userStatus.availablePoints, 1367)
    assert.equal(data.source, 'earn-page')
    assert.equal(await func.getCurrentPoints(), 1367)
    assert.equal(legacyCalls, 0)
    assert.equal(bot.reactSnapshots.mobile.account.availablePoints, 1367)
})

test('task mode rejects missing account data, keeps unknown balances unknown and retains warnings', async () => {
    assert.throws(() => mapEarnToDashboard(parse([link]), today), /LOGIN_STATE_UNCONFIRMED/)
    const snapshot = parse([
        { level: 1, pointsProgress: 10, pointsRemaining: 490 },
        link,
        { userWarnings: [{ name: 'Fraud_UserWarning_BotScore_UX' }] }
    ])
    const data = mapEarnToDashboard(snapshot, today)
    assert.equal(data.availablePointsKnown, false)
    assert.deepEqual(data.dashboard.userWarnings, [{ name: 'Fraud_UserWarning_BotScore_UX' }])
    const bot = {
        config: { tasksOnly: true },
        logger,
        isMobile: true,
        reactSnapshots: {},
        utils: { getFormattedDate: () => today }
    }
    const func = new BrowserFunc(bot)
    func.refreshEarnSnapshot = async () => snapshot
    await assert.rejects(func.getCurrentPoints(), /balance is unavailable/)
    func.refreshEarnSnapshot = async () => null
    await assert.rejects(func.getDashboardData(), /page data is unavailable/)
})

test('task page reads prefer the active browser session to standalone HTTP', async () => {
    let standalone = 0
    const bot = {
        config: { tasksOnly: true },
        logger,
        isMobile: true,
        mainMobilePage: {
            isClosed: () => false,
            request: { get: async () => ({ ok: () => true, text: async () => payload([account, link]) }) }
        },
        http: {
            request: () => {
                standalone++
                throw new Error('standalone unavailable')
            }
        }
    }
    const func = new BrowserFunc(bot)
    func.syncActiveCookies = async () => {}
    const html = await func.getRewardsPageHtml('https://rewards.bing.com/earn', '/earn')
    assert.ok(html.includes('balance'))
    assert.equal(standalone, 0)
})

test('generic mode retains its original dashboard API path', async () => {
    const urls = []
    const expected = { dashboard: { userStatus: { availablePoints: 50 } } }
    const bot = {
        config: { tasksOnly: false },
        logger,
        isMobile: true,
        fingerprint: { headers: {} },
        cookies: { mobile: [] },
        http: {
            request: async request => {
                urls.push(request.url)
                return { data: expected, headers: {} }
            }
        }
    }
    const func = new BrowserFunc(bot)
    func.applyResponseCookies = async () => {}
    assert.equal(await func.getDashboardData(), expected)
    assert.deepEqual(urls, ['https://rewards.bing.com/api/getuserinfo'])
})

test('refresh updates live cached task state and refuses an empty login page', async () => {
    const bot = {
        config: { tasksOnly: true },
        logger,
        isMobile: true,
        reactSnapshots: {},
        mainMobilePage: { isClosed: () => false },
        browser: {}
    }
    bot.browser.react = new ReactFunc(bot)
    const func = new BrowserFunc(bot)
    func.getRewardsPageHtml = async () => payload([account, { ...link, isCompleted: true }])
    const snapshot = await func.refreshEarnSnapshot()
    assert.equal(snapshot.offers[0].isCompleted, true)
    assert.equal(bot.reactSnapshot, snapshot)
    assert.equal(bot.reactSnapshots.mobile, snapshot)
    func.getRewardsPageHtml = async () => '<html>Sign in</html>'
    assert.equal(await func.refreshEarnSnapshot(), null)
})

test('daily streak timer reads the server timestamp and excludes unrelated or invalid timers', () => {
    const future = new Date(Date.now() + 86400000).toISOString()
    const earlier = new Date(Date.now() + 3600000).toISOString()
    assert.equal(
        parse([
            { expiresAt: '$D' + earlier, prefix: 'Coupon expires' },
            { expiresAt: '$D' + future, prefix: 'Daily streaks reset', updateInterval: 1000 }
        ]).nextStreakResetAt,
        future
    )
    assert.equal(parse([{ expiresAt: '$D' + future, prefix: '每日连胜重置' }]).nextStreakResetAt, future)
    assert.equal(
        parse([{ expiresAt: '$D2000-01-01T00:00:00.000Z', prefix: 'Daily streaks reset' }]).nextStreakResetAt,
        null
    )
    assert.equal(parse([{ expiresAt: 'invalid', prefix: 'Daily streaks reset' }]).nextStreakResetAt, null)
    assert.equal(parse([]).nextStreakResetAt, null)
})
