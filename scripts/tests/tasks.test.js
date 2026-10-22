import { createRequire } from 'node:module'
const loadCompiled = createRequire(import.meta.url)
const test = loadCompiled('node:test')
const assert = loadCompiled('node:assert/strict')
const fs = loadCompiled('node:fs/promises')
const os = loadCompiled('node:os')
const path = loadCompiled('node:path')
const { TaskRunner } = loadCompiled('../../dist/functions/TaskRunner')
const { dailyOffers, offerSkipReason, readingOffer, readWithRetry, remainingStreakSearches } = loadCompiled(
    '../../dist/functions/TaskPolicy'
)
const { fallbackQueries } = loadCompiled('../../dist/functions/activities/search/SearchOnBingShared')
const { splitTelegramMessage, sendTelegram } = loadCompiled('../../dist/logging/Telegram')
const { SearchQueryQueue } = loadCompiled('../../dist/functions/SearchQueryQueue')
const { ReadToEarn } = loadCompiled('../../dist/functions/activities/app/ReadToEarn')
const { UrlReward } = loadCompiled('../../dist/functions/activities/api/UrlReward')
const { Login } = loadCompiled('../../dist/browser/auth/Login')
const { default: BrowserFunc } = loadCompiled('../../dist/browser/BrowserFunc')
const { validateConfig } = loadCompiled('../../dist/util/Validator')
const { computeOverrides } = loadCompiled('../../dist/util/ConfigEnvOverrides')
const http = loadCompiled('../../dist/util/Http')
const { execFileSync } = loadCompiled('node:child_process')

const date = '10/11/2026'
const offer = (id = 'offer', extra = {}) => ({
    offerId: id,
    title: `Task ${id}`,
    name: id,
    complete: false,
    pointProgress: 0,
    pointProgressMax: 10,
    priority: 0,
    promotionType: 'urlreward',
    attributes: {},
    ...extra
})
const streak = (extra = {}) => ({
    partner: 'bing',
    isEnabled: true,
    isCurrentDayCompleted: false,
    activitiesTotal: 1,
    activitiesCompleted: 0,
    completedDays: 2,
    totalDays: 7,
    ...extra
})

function fixture(offers = []) {
    const events = []
    const snapshot = {
        offers: offers.map(item => ({ offerId: item.offerId, reportable: true, isCompleted: false })),
        streaks: [streak({ partner: 'mobile' })]
    }
    const data = {
        dashboard: {
            dailySetPromotions: { [date]: offers },
            morePromotions: [],
            userStatus: {
                availablePoints: 100,
                counters: { activityAndQuiz: [], pcSearch: [], mobileSearch: [] }
            }
        }
    }
    const config = {
        workers: { doDailyCheckIn: true, doDailySet: true, doMorePromotions: true },
        activities: { urlReward: true, searchOnBing: true },
        webhook: { telegram: { enabled: false } }
    }
    const app = { response: { promotions: [] } }
    const bot = {
        config,
        accessToken: 'test-token',
        userData: { currentPoints: 100 },
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        utils: { getFormattedDate: () => date, wait: async () => {}, randomDelay: () => 0 },
        browser: {
            func: {
                refreshEarnSnapshot: async () => snapshot,
                getDashboardData: async () => data,
                getCurrentPoints: async () => data.dashboard.userStatus.availablePoints,
                getAppDashboardData: async () => app,
                synchronizeActiveBrowserCookies: async () => {}
            },
            utils: { tryDismissAllMessages: async () => {} }
        },
        activities: {
            doDailyCheckIn: async () => {
                events.push('checkin')
                snapshot.streaks[0].isCurrentDayCompleted = true
            },
            doUrlReward: async item => {
                events.push(item.offerId)
                item.complete = true
            },
            doSearch: async () => {
                throw new Error('ordinary search must not run')
            }
        }
    }
    const runner = new TaskRunner(bot, 'test@example.com')
    runner.publish = async () => {}
    return { runner, bot, data, app, events, snapshot }
}

test('check-in precedes dynamic activities; duplicate and completed offers are not executed', async () => {
    const first = offer('random-today')
    const f = fixture([first, offer('done', { complete: true })])
    f.data.dashboard.morePromotions = [first]
    await f.runner.run(f.data, f.app)
    assert.deepEqual(f.events, ['checkin', 'random-today'])
    assert.equal(f.runner.report.tasks.find(task => task.id === first.offerId).status, 'completed')
    assert.equal(dailyOffers(f.data, date).length, 2)
    const next = fixture([offer('different-tomorrow')])
    await next.runner.run(next.data, next.app)
    assert.deepEqual(next.events, ['checkin', 'different-tomorrow'])
})

test('credit or a successful request without completion is unconfirmed', async () => {
    const f = fixture([offer()])
    f.bot.activities.doUrlReward = async () => {
        f.bot.userData.currentPoints += 10
    }
    await f.runner.run(f.data, f.app)
    const result = f.runner.report.tasks.find(task => task.id === 'offer')
    assert.equal(result.status, 'unconfirmed')
    assert.equal(result.pointsGained, 10)
    assert.equal(f.runner.report.stamps, null)
})

test('unknown, locked and disabled activities skip; empty daily data is not completion', async () => {
    const f = fixture([
        offer('quiz', { promotionType: 'quiz' }),
        offer('locked', { exclusiveLockedFeatureStatus: 'locked' })
    ])
    await f.runner.run(f.data, f.app)
    assert.deepEqual(f.events, ['checkin'])
    assert.equal(f.runner.report.tasks.find(task => task.id === 'quiz').status, 'skipped')
    assert.equal(offerSkipReason(offer('x', { pointProgressMax: 0 })), '无直接积分，保留现有跳过规则')
    const empty = fixture()
    await empty.runner.run(empty.data, empty.app)
    assert.equal(empty.runner.report.tasks.find(task => task.id === 'daily-set').status, 'unconfirmed')
})

test('missing app token reports manual action while browser tasks continue', async () => {
    const f = fixture([offer()])
    f.bot.accessToken = ''
    await f.runner.run(f.data, null)
    assert.equal(f.runner.report.tasks.find(task => task.id === 'app-checkin').status, 'manual')
    assert.deepEqual(f.events, ['offer'])
})

test('page dailyset streak confirms completion without an API list; unknown balance stays unreported', async () => {
    const f = fixture()
    f.data.availablePointsKnown = false
    f.snapshot.streaks.push(streak({ partner: 'dailyset', isCurrentDayCompleted: true }))
    await f.runner.run(f.data, f.app)
    assert.equal(f.runner.report.tasks.find(task => task.id === 'daily-set').status, 'completed')
    assert.equal(f.runner.report.initialPoints, undefined)
    assert.equal(f.runner.report.finalPoints, undefined)
    assert.equal(f.runner.report.stamps, null)
})

test('confirmed app check-in does not require the unavailable app API', async () => {
    const f = fixture()
    f.snapshot.streaks = [streak({ partner: 'bingapp', isCurrentDayCompleted: true })]
    await f.runner.run(f.data, null)
    assert.equal(f.runner.report.tasks.find(task => task.id === 'app-checkin').status, 'completed')
    assert.deepEqual(f.events, [])
})

test('unavailable app data with a valid token stays unconfirmed while browser tasks continue', async () => {
    const f = fixture([offer()])
    f.bot.config.workers.doAppPromotions = true
    f.bot.config.workers.doReadToEarn = true
    await f.runner.run(f.data, null)
    assert.deepEqual(f.events, ['offer'])
    for (const id of ['app-checkin', 'app-promotions', 'read-to-earn'])
        assert.equal(f.runner.report.tasks.find(task => task.id === id).status, 'unconfirmed')
    assert.equal(
        f.runner.report.tasks.some(task => task.status === 'manual'),
        false
    )
})

test('zero quota does not block required streak search; confirmed day stops searches', async t => {
    t.mock.method(SearchQueryQueue.prototype, 'prepare', async () => 3)
    t.mock.method(SearchQueryQueue.prototype, 'next', async () => '中国天气')
    const f = fixture()
    f.bot.config.workers.doSearchStreak = true
    const destination = 'https://www.bing.com/?form=ML2PCO'
    const search = streak({ activitiesTotal: 3, destinationUrl: destination })
    f.snapshot.streaks.push(search)
    let searches = 0
    const visited = []
    f.bot.mainMobilePage = {
        goto: async url => visited.push(url),
        waitForLoadState: async () => {},
        locator: () => ({
            fill: async () => {},
            press: async () => {
                searches++
                search.isCurrentDayCompleted = true
            }
        })
    }
    await f.runner.run(f.data, f.app)
    assert.equal(searches, 1)
    assert.deepEqual(visited, [destination])
    assert.equal(f.runner.report.tasks.find(task => task.id === 'search-streak').status, 'completed')
})

test('uncertain streak requirements never cause guessed or quota searches', async () => {
    assert.equal(remainingStreakSearches(streak({ activitiesTotal: 0 })), null)
    assert.equal(remainingStreakSearches(streak({ activitiesTotal: 100 })), null)
    const f = fixture()
    f.bot.config.workers.doSearchStreak = true
    await f.runner.run(f.data, f.app)
    assert.equal(f.runner.report.tasks.find(task => task.id === 'search-streak').status, 'skipped')
})

test('reading uses returned Chinese offer; no offer never submits', async () => {
    const app = {
        response: {
            promotions: [{ attributes: { type: 'msnreadearn', offerid: 'CN_read', pointmax: '6', pointprogress: '0' } }]
        }
    }
    assert.deepEqual(readingOffer(app), { id: 'CN_read', remaining: 6 })
    assert.equal(readingOffer({ response: { promotions: [] } }), undefined)
    const f = fixture()
    f.bot.config.searchSettings = { readDelay: { min: 0, max: 0 } }
    let requests = 0
    f.bot.http = {
        request: async config => {
            requests++
            assert.equal(JSON.parse(config.data).attributes.offerid, 'CN_read')
            app.response.promotions[0].attributes.pointprogress = '6'
            return { status: 200, data: { response: { balance: 106 } } }
        }
    }
    await new ReadToEarn(f.bot).doReadToEarn()
    assert.equal(requests, 0)
    f.bot.browser.func.getAppDashboardData = async () => app
    await new ReadToEarn(f.bot).doReadToEarn()
    assert.equal(requests, 1)
})

test('Chinese instruction and provided Bing query are usable without fixed daily task names', () => {
    const queries = fallbackQueries(
        offer('a', {
            title: '今天的活动',
            description: '在必应上搜索：长城历史',
            destinationUrl: 'https://www.bing.com/search?q=%E5%8C%97%E4%BA%AC'
        })
    )
    assert.deepEqual(queries.slice(0, 2), ['北京', '长城历史'])
    assert.ok(queries.length <= 3)
})

test('transient reads retry twice; submission uncertainty never resubmits URL reward', async () => {
    let reads = 0
    const value = await readWithRetry(
        async () => {
            if (++reads < 3) throw new Error('temporary')
            return 42
        },
        async () => {}
    )
    assert.equal(value, 42)
    assert.equal(reads, 3)
    const f = fixture()
    f.bot.config.tasksOnly = true
    f.bot.config.skipNonPointTasks = true
    f.bot.nextActions = { reportActivity: 'test-action' }
    let submissions = 0
    f.bot.browser.react = { routerStateTree: () => 'test-tree' }
    f.bot.browser.func.ensureOffer = async () => ({ reportable: true, points: 10, hash: 'h' })
    f.bot.browser.func.reportServerAction = async () => {
        submissions++
        return { acknowledged: false, status: 200, availablePoints: 100 }
    }
    f.bot.refreshCurrentRewardsContext = async () => {
        throw new Error('must not replay')
    }
    await new UrlReward(f.bot).doUrlReward(offer())
    assert.equal(submissions, 1)
})

test('tasks-only login never invokes credential handlers on verification page', async () => {
    const f = fixture()
    f.bot.config.tasksOnly = true
    f.bot.browser.utils.reloadBadPage = async () => {}
    f.bot.browser.utils.disableFido = async () => {}
    const page = {
        context: () => ({ route: async () => {}, unroute: async () => {} }),
        goto: async () => {},
        waitForURL: async () => {
            throw new Error('timeout')
        },
        url: () => 'https://login.live.com/'
    }
    await assert.rejects(new Login(f.bot).login(page, {}), /MANUAL_LOGIN_REQUIRED/)
})

test('tasks-only login accepts authenticated modern dashboard without legacy dailyset element', async () => {
    const f = fixture()
    f.bot.config.tasksOnly = true
    f.bot.browser.utils.reloadBadPage = async () => {}
    f.bot.browser.utils.disableFido = async () => {}
    f.bot.browser.react = { snapshotPage: () => ({ account: { level: 1, availablePoints: null } }) }
    const page = {
        context: () => ({ route: async () => {}, unroute: async () => {} }),
        goto: async () => {},
        url: () => 'https://rewards.bing.com/dashboard',
        content: async () => '<html>modern dashboard</html>'
    }
    const login = new Login(f.bot)
    let finalized = false
    login.finalizeLogin = async () => {
        finalized = true
    }
    await login.login(page, {})
    assert.equal(finalized, true)
    finalized = false
    f.bot.browser.react.snapshotPage = () => ({ account: { level: null, availablePoints: null } })
    await assert.rejects(login.login(page, {}), /LOGIN_STATE_UNCONFIRMED/)
    assert.equal(finalized, false)
})

test('bootstrap accepts modern task data without legacy markup and rejects an empty page', async () => {
    const f = fixture()
    let snapshot = { offers: [{ offerId: 'today' }], streaks: [], reportable: [], account: {} }
    f.bot.browser.react = {
        buildId: () => 'test-build',
        routerStateTree: () => 'test-tree',
        snapshotPage: () => snapshot
    }
    f.bot.reactSnapshots = {}
    f.bot.isMobile = true
    const func = new BrowserFunc(f.bot)
    func.dismissRewardsWelcomeDialog = async () => {}
    func.fetchBootstrapHtml = async () => ''
    func.resolveActionIds = async () => ({ report: 'test-action' })
    const page = {
        goto: async () => {},
        content: async () => '<html>modern task page</html>',
        url: () => 'https://rewards.bing.com/earn'
    }
    await func.bootstrap(page)
    snapshot = { ...snapshot, offers: [] }
    await assert.rejects(func.bootstrap(page), /Rewards task data did not render/)
})

test('Telegram special characters are plain text; long messages split, failures stay local', async t => {
    const sent = []
    t.mock.method(http, 'httpRequest', async config => {
        sent.push(config.data)
        return {}
    })
    const text = '[]_*`中文😀'.repeat(500)
    assert.equal(splitTelegramMessage(text).join(''), text)
    assert.ok(splitTelegramMessage(text).every(part => part.length <= 3500))
    await sendTelegram({ botToken: 'fake-token', chatId: 'fake-chat' }, text, 'warn')
    assert.ok(sent.length > 1)
    assert.ok(sent.every(data => !data.parse_mode))
    t.mock.method(http, 'httpRequest', async () => {
        throw new Error('fake-token should never appear')
    })
    const logs = []
    t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')))
    await sendTelegram({ botToken: 'fake-token', chatId: 'fake-chat' }, 'failure', 'warn')
    assert.ok(logs.length)
    assert.ok(logs.every(line => !line.includes('fake-token')))
})

test('legacy notification config is ignored while Telegram logging and filtering still work', async t => {
    const { Logger } = loadCompiled('../../dist/logging/Logger')
    const { flushTelegramQueue } = loadCompiled('../../dist/logging/Telegram')
    const example = JSON.parse(await fs.readFile(new URL('../../config.tasks.example.json', import.meta.url)))
    example.webhook.discord = { enabled: true, url: 'https://retired.invalid/discord' }
    example.webhook.ntfy = { enabled: true, url: 'https://retired.invalid/ntfy', token: 'old-token' }
    example.webhook.telegram = { enabled: true, botToken: 'fake-token', chatId: 'fake-chat' }
    example.webhook.webhookLogFilter = { enabled: true, mode: 'whitelist', levels: ['error'] }
    const config = validateConfig(example)
    assert.equal(config.webhook.discord, undefined)
    assert.equal(config.webhook.ntfy, undefined)
    const overrides = computeOverrides({
        CONFIG_DISCORD_ENABLED: 'true',
        CONFIG_NTFY_ENABLED: 'true',
        CONFIG_TELEGRAM_ENABLED: 'true'
    })
    assert.deepEqual(overrides.errors, [])
    assert.deepEqual(
        overrides.applied.map(item => item.path),
        ['webhook.telegram.enabled']
    )
    const sent = []
    t.mock.method(http, 'httpRequest', async request => {
        sent.push(request)
        return {}
    })
    t.mock.method(console, 'log', () => {})
    t.mock.method(console, 'error', () => {})
    const logger = new Logger({ config, userData: { userName: 'test' } })
    logger.info('main', 'TEST', 'filtered info')
    logger.error('main', 'TEST', 'preserved error')
    await flushTelegramQueue()
    assert.equal(sent.length, 1)
    assert.equal(sent[0].url, 'https://api.telegram.org/botfake-token/sendMessage')
    assert.match(sent[0].data.text, /preserved error/)
})

test('reports retain only recent own files and Telegram summary lists manual action', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rewards-report-test-'))
    t.after(() => fs.rm(directory, { recursive: true, force: true }))
    const old = path.join(directory, 'tasks-123456789abc-1.json')
    await fs.writeFile(old, '{}')
    await fs.utimes(old, new Date(0), new Date(0))
    await fs.writeFile(path.join(directory, 'unrelated.txt'), 'keep')
    const sent = []
    t.mock.method(http, 'httpRequest', async config => {
        sent.push(config.data.text)
        return {}
    })
    const f = fixture()
    f.bot.config.webhook.telegram = { enabled: true, botToken: 'test', chatId: 'test' }
    const runner = new TaskRunner(f.bot, 'test@example.com', directory)
    await runner.abort('请手动登录')
    await runner.publish()
    const files = await fs.readdir(directory)
    assert.equal(files.filter(file => file.endsWith('.json')).length, 1)
    assert.ok(files.includes('unrelated.txt'))
    assert.equal(sent.length, 1)
    assert.match(sent[0], /请手动登录/)
    assert.match(sent[0], /印章进度：无法核验/)
})

test('generic defaults remain compatible; env options enable tasks profile', () => {
    const config = loadCompiled('../../config.example.json')
    delete config.tasksOnly
    delete config.workers.doSearchStreak
    assert.equal(validateConfig(config).tasksOnly, false)
    assert.equal(validateConfig(config).workers.doSearchStreak, false)
    const overrides = computeOverrides({ CONFIG_TASKS_ONLY: 'true', CONFIG_WORKER_SEARCH_STREAK: 'true' })
    assert.equal(overrides.errors.length, 0)
    assert.equal(overrides.applied.length, 2)
})

test('streak search stops at the declared requirement even if it never completes', async t => {
    t.mock.method(SearchQueryQueue.prototype, 'prepare', async () => 3)
    t.mock.method(SearchQueryQueue.prototype, 'next', async () => '上海天气')
    const f = fixture()
    f.bot.config.workers.doSearchStreak = true
    f.snapshot.streaks.push(streak({ activitiesTotal: 2 }))
    let searches = 0
    f.bot.mainMobilePage = {
        goto: async () => {},
        waitForLoadState: async () => {},
        locator: () => ({
            fill: async () => {},
            press: async () => {
                searches++
            }
        })
    }
    await f.runner.run(f.data, f.app)
    assert.equal(searches, 2)
    assert.equal(f.runner.report.tasks.find(task => task.id === 'search-streak').status, 'unconfirmed')
})

test('a failed check-in does not prevent the remaining supported daily activities', async () => {
    const f = fixture([offer('still-available')])
    f.bot.activities.doDailyCheckIn = async () => {
        throw new Error('temporary failure')
    }
    await f.runner.run(f.data, f.app)
    assert.equal(f.runner.report.tasks.find(task => task.id === 'app-checkin').status, 'failed')
    assert.deepEqual(f.events, ['still-available'])
})

test('search activation uses discovered metadata once and verifies enabled state', async t => {
    t.mock.method(SearchQueryQueue.prototype, 'prepare', async () => 1)
    t.mock.method(SearchQueryQueue.prototype, 'next', async () => '杭州天气')
    const f = fixture()
    f.bot.config.workers.doSearchStreak = true
    const current = streak({
        isEnabled: false,
        activationOfferId: 'activation',
        activationHash: 'live',
        activationActivityType: 11
    })
    f.snapshot.streaks.push(current)
    f.bot.nextActions = { reportActivity: 'discovered-action' }
    let activations = 0
    f.bot.browser.func.reportServerAction = async (id, body) => {
        assert.equal(id, 'discovered-action')
        assert.equal(body[0], 'live')
        activations++
        current.isEnabled = true
    }
    f.bot.mainMobilePage = {
        goto: async () => {},
        waitForLoadState: async () => {},
        locator: () => ({
            fill: async () => {},
            press: async () => {
                current.isCurrentDayCompleted = true
            }
        })
    }
    await f.runner.run(f.data, f.app)
    assert.equal(activations, 1)
    assert.equal(f.runner.report.tasks.find(task => task.id === 'search-streak').status, 'completed')
})

test('Bing session verification also propagates manual-login requirements', async () => {
    const f = fixture()
    f.bot.config.tasksOnly = true
    const page = {
        goto: async () => {},
        waitForURL: async () => {
            throw new Error('timeout')
        },
        isClosed: () => false,
        url: () => 'https://login.live.com/'
    }
    await assert.rejects(new Login(f.bot).verifyBingSession(page, {}), /MANUAL_LOGIN_REQUIRED/)
})

test('Bing verification waits for a passive authentication redirect before requesting manual login', async () => {
    const f = fixture()
    f.bot.config.tasksOnly = true
    f.bot.isMobile = true
    let currentUrl = 'https://login.live.com/oauth20_authorize.srf'
    let waited = false
    const page = {
        goto: async () => {},
        waitForURL: async (predicate, options) => {
            assert.equal(options.timeout, 30000)
            assert.equal(predicate(new URL(currentUrl)), false)
            assert.equal(predicate(new URL('https://rewards.bing.com/')), false)
            currentUrl = 'https://www.bing.com/'
            assert.equal(predicate(new URL(currentUrl)), true)
            waited = true
        },
        isClosed: () => false,
        url: () => currentUrl,
        waitForSelector: async () => ({})
    }
    await new Login(f.bot).verifyBingSession(page, {})
    assert.equal(waited, true)
})

test('container override CLI applies Telegram credentials without printing them', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rewards-log-redaction-'))
    const configFile = path.join(dir, 'config.json')
    try {
        await fs.writeFile(configFile, '{}')
        const token = 'test-sensitive-bot-token'
        const chatId = 'test-sensitive-chat-id'
        const output = execFileSync(
            process.execPath,
            [path.resolve('dist/util/ConfigEnvOverrides.js'), 'apply', '--config', configFile],
            {
                env: { CONFIG_TELEGRAM_BOTTOKEN: token, CONFIG_TELEGRAM_CHATID: chatId },
                encoding: 'utf8'
            }
        )
        assert.equal(output.includes(token), false)
        assert.equal(output.includes(chatId), false)
        assert.ok(output.includes('[redacted]'))
        const config = JSON.parse(await fs.readFile(configFile, 'utf8'))
        assert.equal(config.webhook.telegram.botToken, token)
        assert.equal(config.webhook.telegram.chatId, chatId)
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
})

async function recoveryFixture(t) {
    const f = fixture()
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'checkin-recovery-'))
    t.after(() => fs.rm(directory, { recursive: true, force: true }))
    f.runner = new TaskRunner(f.bot, 'recovery@example.com', directory)
    f.runner.publish = async () => {}
    f.snapshot.nextStreakResetAt = new Date(Date.now() + 86400000).toISOString()
    f.bot.activities.doDailyCheckIn = async () => {
        f.events.push('checkin')
        return { acknowledged: true }
    }
    return { ...f, directory }
}

test('delayed check-in confirmation updates the existing task without another POST', async t => {
    const f = await recoveryFixture(t)
    let waits = 0
    f.bot.utils.wait = async ms => {
        assert.equal(ms, 60000)
        waits++
        f.snapshot.streaks[0].isCurrentDayCompleted = true
    }
    await f.runner.run(f.data, f.app)
    assert.equal(waits, 1)
    assert.deepEqual(f.events, ['checkin'])
    const tasks = f.runner.report.tasks.filter(task => task.id === 'app-checkin')
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].status, 'completed')
    assert.equal(f.runner.report.streaks[0].today, true)
})

test('unconfirmed acknowledged check-in receives only one persisted compensating submission', async t => {
    const f = await recoveryFixture(t)
    let waits = 0
    f.bot.utils.wait = async () => {
        waits++
    }
    await f.runner.run(f.data, f.app)
    assert.deepEqual(f.events, ['checkin', 'checkin'])
    assert.equal(waits, 6)
    assert.match(f.runner.report.tasks[0].reason, /已补试一次/)
    assert.equal((await fs.readdir(path.join(f.directory, 'app-checkin-recovery'))).length, 1)
    // A restarted runner may make its normal submission but cannot compensate twice.
    const second = new TaskRunner(f.bot, 'recovery@example.com', f.directory)
    second.publish = async () => {}
    await second.run(f.data, f.app)
    assert.equal(f.events.length, 3)
    assert.match(second.report.tasks[0].reason, /本周期已使用一次/)
})

test('compensating check-in is confirmed by page state, never by balance alone', async t => {
    const f = await recoveryFixture(t)
    f.bot.activities.doDailyCheckIn = async () => {
        f.events.push('checkin')
        f.bot.userData.currentPoints += 15
        if (f.events.length === 2) f.snapshot.streaks[0].isCurrentDayCompleted = true
        return { acknowledged: true }
    }
    await f.runner.run(f.data, f.app)
    assert.equal(f.events.length, 2)
    assert.equal(f.runner.report.tasks[0].status, 'completed')
    assert.equal(f.runner.report.streaks[0].today, true)
})

test('uncertain transport outcome allows reads but no compensating POST', async t => {
    const f = await recoveryFixture(t)
    f.bot.activities.doDailyCheckIn = async () => {
        f.events.push('checkin')
        return { acknowledged: false }
    }
    await f.runner.run(f.data, f.app)
    assert.equal(f.events.length, 1)
    assert.equal(f.runner.report.tasks[0].status, 'unconfirmed')
})

test('missing streak, changed cycle and failed app recheck block compensation', async t => {
    for (const mode of ['missing-streak', 'new-cycle', 'app-unavailable']) {
        const f = await recoveryFixture(t)
        f.bot.utils.wait = async () => {
            if (mode === 'missing-streak') f.snapshot.streaks = []
            if (mode === 'new-cycle') f.snapshot.nextStreakResetAt = new Date(Date.now() + 172800000).toISOString()
        }
        if (mode === 'app-unavailable') f.bot.browser.func.getAppDashboardData = async () => null
        await f.runner.run(f.data, f.app)
        assert.equal(f.events.length, 1, mode)
        assert.equal(f.runner.report.tasks[0].status, 'unconfirmed')
    }
})

test('check-in response validation rejects business errors and transport uncertainty', async () => {
    const { DailyCheckIn } = loadCompiled('../../dist/functions/activities/app/DailyCheckIn')
    for (const response of [
        { status: 200, data: { code: 123, response: { balance: 115 } } },
        { status: 200, data: { code: 0 } },
        { status: 503, data: { response: { balance: 115 } } },
        null
    ]) {
        const f = fixture()
        f.bot.config.tasksOnly = true
        f.bot.http = {
            request: async config => {
                assert.equal(config.retries, 0)
                if (!response) throw new Error('connection reset')
                return response
            }
        }
        assert.deepEqual(await new DailyCheckIn(f.bot).doDailyCheckIn(), { acknowledged: false })
        assert.equal(f.bot.userData.currentPoints, 100)
    }
    const f = fixture()
    f.bot.http = { request: async () => ({ status: 200, data: { code: 0, response: { balance: 115 } } }) }
    assert.deepEqual(await new DailyCheckIn(f.bot).doDailyCheckIn(), { acknowledged: true })
    assert.equal(f.bot.userData.currentPoints, 115)
})

test('state confirmed during other tasks needs no delayed wait or compensation', async t => {
    const f = await recoveryFixture(t)
    f.bot.utils.wait = async () => {
        throw new Error('should not wait')
    }
    const original = f.bot.browser.func.getDashboardData
    let reads = 0
    f.bot.browser.func.getDashboardData = async () => {
        if (++reads === 1) f.snapshot.streaks[0].isCurrentDayCompleted = true
        return original()
    }
    await f.runner.run(f.data, f.app)
    assert.equal(f.events.length, 1)
    assert.equal(f.runner.report.tasks[0].status, 'completed')
})

test('concurrent recovery reserves only one compensation', async t => {
    const f = await recoveryFixture(t)
    const second = new TaskRunner(f.bot, 'recovery@example.com', f.directory)
    second.publish = async () => {}
    await Promise.all([f.runner.run(f.data, f.app), second.run(f.data, f.app)])
    assert.equal(f.events.length, 3) // two initial requests and one compensation
    assert.equal((await fs.readdir(path.join(f.directory, 'app-checkin-recovery'))).length, 1)
})

test('ordinary searches extend the same task workflow and remain disabled in task mode', async () => {
    const f = fixture([offer('daily')])
    let searches = 0
    const search = async () => {
        searches++
        f.events.push('ordinary-search')
        f.data.dashboard.userStatus.availablePoints += 3
        return [{ id: 'ordinary-mobile-search', title: '手机普通搜索', status: 'completed', reason: 'quota confirmed' }]
    }
    await f.runner.run(f.data, f.app, undefined, search)
    assert.equal(searches, 0)
    f.bot.config.workers.doMobileSearch = true
    await f.runner.run(f.data, f.app, undefined, search)
    assert.equal(searches, 1)
    assert.ok(f.events.indexOf('daily') < f.events.indexOf('ordinary-search'))
    assert.equal(f.runner.report.finalPoints, 103)
    assert.equal(f.runner.report.tasks.at(-1).id, 'ordinary-mobile-search')
})

test('ordinary search skips complete quotas, verifies remaining points and isolates platform failures', async () => {
    const { runTaskSearches } = loadCompiled('../../dist/functions/TaskSearch')
    const f = fixture()
    Object.assign(f.bot.config.workers, { doMobileSearch: true, doDesktopSearch: true })
    let mobileMissing = 0,
        desktopMissing = 6
    const manager = { getSearchPoints: async () => ({ mobileMissing, desktopMissing }) }
    const searched = []
    let results = await runTaskSearches(f.bot, manager, async mobile => {
        searched.push(mobile)
        desktopMissing = 3
        return 3
    })
    assert.deepEqual(searched, [false])
    assert.equal(results[0].status, 'completed')
    assert.equal(results[1].status, 'unconfirmed')
    assert.equal(results[1].after, 3)
    mobileMissing = 3
    results = await runTaskSearches(f.bot, manager, async mobile => {
        if (mobile) throw new Error('test failure')
        desktopMissing = 0
        return 3
    })
    assert.equal(results[0].status, 'failed')
    assert.equal(results[1].status, 'completed')
})
