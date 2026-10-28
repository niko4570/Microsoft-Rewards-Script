import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { MicrosoftRewardsBot } from '../index'
import type { TaskReport, TaskResult } from '../interface/TaskResult'
import type { DashboardData, BasePromotion } from '../interface/DashboardData'
import type { AppDashboardData } from '../interface/AppDashBoardData'
import type { PageSnapshot } from '../browser/ReactFunc'
import { URLs } from '../constants/urls'
import { SearchQueryQueue } from './SearchQueryQueue'
import { sendTelegram } from '../logging/Telegram'
import {
    dailyOffers,
    offerSkipReason,
    readingOffer,
    readWithRetry,
    remainingStreakSearches,
    searchStreak
} from './TaskPolicy'

export class TaskRunner {
    public readonly report: TaskReport
    private published = false
    private snapshot: PageSnapshot | null = null
    private checkInSubmissionAcknowledged = false
    private checkInCycle: string | null = null

    constructor(
        private readonly bot: MicrosoftRewardsBot,
        account: string,
        private readonly reportDirectory = process.env.MRS_DATA_DIR
            ? path.join(process.env.MRS_DATA_DIR, 'reports')
            : 'reports'
    ) {
        this.report = {
            runId: process.env.MRS_RUN_ID || undefined,
            account,
            startedAt: new Date().toISOString(),
            tasks: [],
            streaks: [],
            stamps: null
        }
    }

    private add(result: TaskResult): TaskResult {
        this.report.tasks.push(result)
        this.bot.logger.info('main', 'TASK-RESULT', `${result.title} | ${result.status} | ${result.reason}`)
        return result
    }

    private async phase(id: string, title: string, execute: () => Promise<void>): Promise<void> {
        try {
            await execute()
        } catch (error) {
            if (error instanceof Error && error.message.includes('MANUAL_LOGIN_REQUIRED')) throw error
            this.add({
                id,
                title,
                status: 'failed',
                reason: '执行或状态读取失败，继续处理其他可用任务；请查看本地日志'
            })
        }
    }

    private async read<T>(operation: () => Promise<T>): Promise<T> {
        return readWithRetry(operation, ms => this.bot.utils.wait(ms))
    }

    private async refresh(): Promise<PageSnapshot> {
        this.snapshot = await this.read(async () => {
            const snapshot = await this.bot.browser.func.refreshEarnSnapshot()
            if (!snapshot) throw new Error('任务页面未返回有效数据')
            return snapshot
        })
        this.report.streaks = this.snapshot.streaks.map(streak => ({
            partner: streak.partner,
            today: streak.isCurrentDayCompleted,
            days: streak.completedDays,
            total: streak.totalDays
        }))
        this.report.nextStreakResetAt = this.snapshot.nextStreakResetAt ?? null
        return this.snapshot
    }

    private async dashboard(): Promise<DashboardData> {
        const data = await this.read(() => this.bot.browser.func.getDashboardData())
        const counters = data.dashboard.userStatus.counters.activityAndQuiz ?? []
        this.report.stamps =
            counters
                .map(
                    counter =>
                        counter.hvaPuzzlePiecesCompletedAmount ?? counter.attributes?.hva_puzzle_pieces_completed_amount
                )
                .find(value => value !== undefined) ??
            data.dashboard.userStatus.levelInfo?.benefitsPromotion?.hvaPuzzlePiecesCompletedAmount ??
            data.dashboard.userStatus.levelInfo?.benefitsPromotion?.attributes?.hva_puzzle_pieces_completed_amount ??
            null
        return data
    }

    async run(
        initial: DashboardData,
        app: AppDashboardData | null,
        desktopCards?: () => Promise<void>,
        ordinarySearch?: () => Promise<TaskResult[]>
    ): Promise<void> {
        this.report.initialPoints =
            initial.availablePointsKnown === false ? undefined : initial.dashboard.userStatus.availablePoints
        await this.refresh()
        // App check-in is deliberately first. Daily Set completion itself is checked after activities.
        if (this.bot.config.workers.doDailyCheckIn) await this.phase('app-checkin', '应用签到', () => this.checkIn(app))
        if (this.bot.config.workers.doSearchStreak)
            await this.phase('search-streak', '搜索打卡', () => this.streakSearch())
        if (this.bot.config.ensureStreakProtection) await this.bot.activities.doEnsureStreakProtection()

        const data = await this.dashboard()
        const today = this.bot.utils.getFormattedDate()
        const dailyIds = new Set((data.dashboard.dailySetPromotions[today] ?? []).map(offer => offer.offerId))
        if (this.bot.config.workers.doDailySet && !data.dashboard.dailySetPromotions[today]?.length) {
            const completed = this.snapshot?.streaks.some(
                streak => streak.partner === 'dailyset' && streak.isCurrentDayCompleted
            )
            this.add({
                id: 'daily-set',
                title: '每日活动列表',
                status: completed ? 'completed' : 'unconfirmed',
                reason: completed ? '页面已确认当天每日活动完成' : '当天列表为空，不能确认已完成或已刷新'
            })
        }
        for (const offer of dailyOffers(data, today)) {
            if (
                dailyIds.has(offer.offerId)
                    ? !this.bot.config.workers.doDailySet
                    : !this.bot.config.workers.doMorePromotions
            )
                continue
            await this.promotion(offer)
        }
        if (this.bot.config.workers.doAppPromotions)
            await this.phase('app-promotions', '应用活动', () => this.appPromotions(app))
        if (this.bot.config.workers.doReadToEarn) await this.phase('read-to-earn', '阅读活动', () => this.reading(app))
        if (this.bot.config.workers.doPunchCards)
            await this.phase('punchcards', '打卡卡片', async () =>
                this.punchCards(await this.dashboard(), desktopCards)
            )
        if (this.bot.config.workers.doClaimBonusPoints) {
            await this.phase('bonus-claim', '领取可用积分', async () => {
                const before = await this.bot.browser.func.getCurrentPoints()
                await this.bot.activities.doClaimBonusPoints()
                const after = await this.bot.browser.func.getCurrentPoints()
                this.add({
                    id: 'bonus-claim',
                    title: '领取可用积分',
                    status: after > before ? 'completed' : 'unconfirmed',
                    reason: after > before ? '余额增加，具体奖励来源以微软记录为准' : '没有确认新增积分',
                    pointsGained: after - before
                })
            })
        }
        if (ordinarySearch && (this.bot.config.workers.doMobileSearch || this.bot.config.workers.doDesktopSearch)) {
            await this.phase('ordinary-search', '普通搜索积分', async () => {
                for (const result of await ordinarySearch()) this.add(result)
            })
        }
        if (this.report.tasks.some(task => task.id === 'app-checkin' && task.status === 'unconfirmed')) {
            await this.phase('app-checkin-recovery', '签到后续核验', () => this.recoverCheckIn())
        }
        await this.refresh()
        const final = await this.dashboard()
        this.report.finalPoints =
            final.availablePointsKnown === false ? undefined : final.dashboard.userStatus.availablePoints
        await this.publish()
    }

    private async checkIn(app: AppDashboardData | null): Promise<void> {
        const before = this.snapshot?.streaks.find(streak => /mobile|app|sapphire/i.test(streak.partner))
        if (before?.isCurrentDayCompleted) {
            this.add({
                id: 'app-checkin',
                title: '应用签到',
                status: 'completed',
                reason: '当天已签到',
                before: true,
                after: true
            })
            return
        }
        if (!this.bot.accessToken || !app) {
            this.add({
                id: 'app-checkin',
                title: '应用签到',
                status: this.bot.accessToken ? 'unconfirmed' : 'manual',
                reason: this.bot.accessToken
                    ? '应用活动接口暂不可用，未执行签到；请稍后核验'
                    : '应用令牌不可用，请手动核对应用授权'
            })
            return
        }
        this.checkInCycle = this.snapshot?.nextStreakResetAt ?? null
        const submission = await this.bot.activities.doDailyCheckIn()
        this.checkInSubmissionAcknowledged = submission?.acknowledged === true
        const after = (await this.refresh()).streaks.find(streak => /mobile|app|sapphire/i.test(streak.partner))
        this.add({
            id: 'app-checkin',
            title: '应用签到',
            status: after?.isCurrentDayCompleted ? 'completed' : 'unconfirmed',
            reason: after?.isCurrentDayCompleted ? '当天签到状态已确认' : '尚未读到当天签到完成状态',
            before: before?.isCurrentDayCompleted,
            after: after?.isCurrentDayCompleted
        })
    }

    private async recoverCheckIn(): Promise<void> {
        const result = this.report.tasks.find(task => task.id === 'app-checkin')!
        const confirm = async (): Promise<boolean> => {
            const snapshot = await this.refresh()
            const state = snapshot.streaks.find(streak => /mobile|app|sapphire/i.test(streak.partner))
            if (
                !state ||
                !this.checkInCycle ||
                snapshot.nextStreakResetAt !== this.checkInCycle ||
                !Number.isFinite(Date.parse(this.checkInCycle)) ||
                Date.parse(this.checkInCycle) <= Date.now()
            ) {
                throw new Error('签到状态或重置周期不明确，停止补试')
            }
            if (!state.isCurrentDayCompleted) return false
            result.status = 'completed'
            result.after = true
            result.reason = '后续核验已确认当天签到完成'
            this.bot.logger.info('main', 'TASK-RESULT', `${result.title} | completed | ${result.reason}`)
            return true
        }
        // Other tasks have already given the server time to settle. Never replay
        // an uncertain transport failure, an absent app dashboard, or a new cycle.
        if (!this.checkInCycle) return
        if (await confirm()) return
        this.bot.logger.info('main', 'APP-CHECKIN-RECOVERY', '签到尚未确认，每隔 1 分钟只读核验，最多 3 次')
        for (let attempt = 0; attempt < 3; attempt++) {
            await this.bot.utils.wait(60000)
            if (await confirm()) return
        }
        result.reason = '延迟核验后仍未完成；未满足补试条件，请手动核对必应应用'
        if (!this.checkInSubmissionAcknowledged || !this.bot.accessToken) return
        const app = await this.read(() => this.bot.browser.func.getAppDashboardData())
        if (!app?.response || (app.code !== undefined && app.code !== 0)) return
        if (await confirm()) return
        // Reserve before submitting. Exclusive creation survives restarts and
        // prevents concurrent runners from both issuing a compensating POST.
        const key = createHash('sha256')
            .update(`${this.report.account.toLowerCase()}|${this.checkInCycle}`)
            .digest('hex')
        const directory = path.resolve(this.reportDirectory, 'app-checkin-recovery')
        await fs.mkdir(directory, { recursive: true })
        try {
            const reservation = await fs.open(path.join(directory, `${key}.json`), 'wx', 0o600)
            await reservation.close()
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            result.reason = '本周期已使用一次签到补试，仍未确认；请手动核对必应应用'
            return
        }
        this.bot.logger.warn('main', 'APP-CHECKIN-RECOVERY', '延迟核验仍未完成，执行本周期唯一一次签到补试')
        await this.bot.activities.doDailyCheckIn()
        if (await confirm()) return
        for (let attempt = 0; attempt < 3; attempt++) {
            await this.bot.utils.wait(60000)
            if (await confirm()) return
        }
        result.reason = '已补试一次，后续核验仍未确认签到完成；请手动核对必应应用'
        this.bot.logger.warn('main', 'APP-CHECKIN-RECOVERY', result.reason)
    }

    private async streakSearch(): Promise<void> {
        let before = searchStreak((await this.refresh()).streaks)
        if (
            before &&
            !before.isEnabled &&
            !before.isCurrentDayCompleted &&
            before.activationOfferId &&
            before.activationHash &&
            before.activationActivityType &&
            this.bot.nextActions.reportActivity
        ) {
            await this.bot.browser.func.reportServerAction(
                this.bot.nextActions.reportActivity,
                [
                    before.activationHash,
                    before.activationActivityType,
                    {
                        offerid: before.activationOfferId,
                        isPromotional: '$undefined',
                        timezoneOffset: this.bot.userData.timezoneOffset
                    }
                ],
                { url: URLs.rewards.earnStreaks, referer: URLs.rewards.earnStreaks }
            )
            before = searchStreak((await this.refresh()).streaks)
        }
        const count = before ? remainingStreakSearches(before) : null
        if (!before || count === null) {
            this.add({
                id: 'search-streak',
                title: '搜索打卡',
                status: 'skipped',
                reason: '无法确定已启用打卡的当天搜索要求，不执行额度搜索'
            })
            return
        }
        if (count === 0) {
            this.add({
                id: 'search-streak',
                title: '搜索打卡',
                status: 'completed',
                reason: '当天已完成',
                before: true,
                after: true
            })
            return
        }
        const queue = new SearchQueryQueue(this.bot)
        await queue.prepare()
        const page = this.bot.mainMobilePage
        let after = before
        for (let attempt = 0; attempt < count; attempt++) {
            const query = await queue.next()
            if (!query) break
            // Keep the entry parameters supplied by the Rewards streak card.
            await page.goto(before.destinationUrl || URLs.bing.origin, { waitUntil: 'domcontentloaded' })
            await this.bot.browser.utils.tryDismissAllMessages(page)
            await page.locator('#sb_form_q').fill(query)
            await page.locator('#sb_form_q').press('Enter')
            await page.waitForLoadState('domcontentloaded')
            await this.bot.utils.wait(5000)
            await this.bot.browser.func.synchronizeActiveBrowserCookies('STREAK-SEARCH')
            const refreshed = searchStreak((await this.refresh()).streaks)
            if (!refreshed) break
            after = refreshed
            if (after.isCurrentDayCompleted) break
            if (attempt + 1 < count) await this.bot.utils.wait(this.bot.utils.randomDelay('30sec', '1min'))
        }
        this.add({
            id: 'search-streak',
            title: '搜索打卡',
            status: after.isCurrentDayCompleted ? 'completed' : 'unconfirmed',
            reason: after.isCurrentDayCompleted ? '当天打卡状态已确认' : '达到页面要求次数，尚未确认完成；停止搜索',
            before: before.activitiesCompleted,
            after: after.activitiesCompleted
        })
    }

    private async promotion(offer: BasePromotion): Promise<TaskResult> {
        const reason = offerSkipReason(offer)
        if (reason)
            return this.add({
                id: offer.offerId,
                title: offer.title,
                status: offer.complete ? 'completed' : 'skipped',
                reason
            })
        try {
            const fresh = dailyOffers(await this.dashboard(), this.bot.utils.getFormattedDate()).find(
                item => item.offerId === offer.offerId
            )
            if (!fresh)
                return this.add({
                    id: offer.offerId,
                    title: offer.title,
                    status: 'unconfirmed',
                    reason: '任务不再出现在当天数据中'
                })
            const freshReason = offerSkipReason(fresh)
            if (freshReason)
                return this.add({
                    id: offer.offerId,
                    title: offer.title,
                    status: fresh.complete ? 'completed' : 'skipped',
                    reason: freshReason
                })
            const live = (await this.refresh()).offers.find(item => item.offerId === offer.offerId)
            if (!live?.reportable)
                return this.add({
                    id: offer.offerId,
                    title: offer.title,
                    status: live?.isCompleted ? 'completed' : 'skipped',
                    reason: '任务已完成、锁定或缺少提交信息'
                })
            const search = fresh.name?.toLowerCase().includes('exploreonbing')
            if (search ? !this.bot.config.activities.searchOnBing : !this.bot.config.activities.urlReward) {
                return this.add({
                    id: offer.offerId,
                    title: offer.title,
                    status: 'skipped',
                    reason: '活动处理器已关闭'
                })
            }
            const balance = this.bot.userData.currentPoints
            if (search) await this.bot.activities.doSearchOnBing(fresh, this.bot.mainMobilePage)
            else await this.bot.activities.doUrlReward(fresh)
            const snapshot = await this.refresh()
            const after = dailyOffers(await this.dashboard(), this.bot.utils.getFormattedDate()).find(
                item => item.offerId === offer.offerId
            )
            const completed =
                after?.complete === true ||
                snapshot.offers.find(item => item.offerId === offer.offerId)?.isCompleted === true
            return this.add({
                id: offer.offerId,
                title: offer.title,
                status: completed ? 'completed' : 'unconfirmed',
                reason: completed ? '任务完成标记已确认' : '执行后尚未确认任务完成，不重复提交',
                before: fresh.pointProgress,
                after: after?.pointProgress,
                pointsGained:
                    this.report.initialPoints === undefined ? undefined : this.bot.userData.currentPoints - balance
            })
        } catch {
            return this.add({
                id: offer.offerId,
                title: offer.title,
                status: 'failed',
                reason: '任务执行或状态读取失败，请查看本地日志'
            })
        }
    }

    private async appPromotions(app: AppDashboardData | null): Promise<void> {
        if (!app || !this.bot.accessToken) {
            this.add({
                id: 'app-promotions',
                title: '应用活动',
                status: this.bot.accessToken ? 'unconfirmed' : 'manual',
                reason: this.bot.accessToken ? '应用活动接口暂不可用，本次未执行应用活动' : '应用令牌不可用'
            })
            return
        }
        const seen = new Set(this.report.tasks.map(task => task.id))
        const fresh = await this.read(() => this.bot.browser.func.getAppDashboardData())
        for (const offer of fresh.response.promotions) {
            const id = offer.attributes.offerid
            if (!id || seen.has(id) || ['checkin', 'msnreadearn'].includes(offer.attributes.type ?? '')) continue
            seen.add(id)
            if (offer.attributes.complete?.toLowerCase() === 'true') continue
            if (offer.attributes.type !== 'sapphire') {
                this.add({
                    id,
                    title: offer.attributes.title ?? offer.name,
                    status: 'skipped',
                    reason: '尚不支持此应用活动类型'
                })
                continue
            }
            await this.bot.activities.doAppReward(offer)
            const after = (await this.read(() => this.bot.browser.func.getAppDashboardData())).response.promotions.find(
                item => item.attributes.offerid === id
            )
            const done = after?.attributes.complete?.toLowerCase() === 'true'
            this.add({
                id,
                title: offer.attributes.title ?? offer.name,
                status: done ? 'completed' : 'unconfirmed',
                reason: done ? '应用任务完成标记已确认' : '尚未确认应用任务完成'
            })
        }
    }

    private async reading(app: AppDashboardData | null): Promise<void> {
        const offer =
            app && this.bot.accessToken
                ? readingOffer(await this.read(() => this.bot.browser.func.getAppDashboardData()))
                : undefined
        if (!offer) {
            this.add({
                id: 'read-to-earn',
                title: '阅读活动',
                status: !app && this.bot.accessToken ? 'unconfirmed' : 'skipped',
                reason:
                    !app && this.bot.accessToken ? '应用活动数据暂不可用，未执行阅读' : '未返回可用阅读活动或剩余额度'
            })
            return
        }
        await this.bot.activities.doReadToEarn()
        const after = await this.read(() => this.bot.browser.func.getAppDashboardData())
        const current = after.response.promotions.find(item => item.attributes.offerid === offer.id)
        const done =
            current?.attributes.complete?.toLowerCase() === 'true' ||
            (!!current && Number(current.attributes.pointprogress) >= Number(current.attributes.pointmax))
        this.add({
            id: offer.id,
            title: '阅读活动',
            status: done ? 'completed' : 'unconfirmed',
            reason: done ? '阅读额度完成已确认' : '阅读后未确认完成'
        })
    }

    private async punchCards(data: DashboardData, desktopCards?: () => Promise<void>): Promise<void> {
        const html = await this.read(() => this.bot.browser.func.getRewardsPageHtml(URLs.rewards.earn, '/earn'))
        if (!html) {
            this.add({ id: 'punchcards', title: '打卡卡片', status: 'unconfirmed', reason: '卡片列表不可用' })
            return
        }
        const parents = this.bot.browser.react.snapshotQuestList(html)
        if (!parents.length) {
            this.add({
                id: 'punchcards',
                title: '打卡卡片',
                status: 'skipped',
                reason: '未发现可处理卡片，不能据此确认印章奖励完成'
            })
            return
        }
        await this.bot.activities.doPunchCardsMobile(data)
        if (desktopCards) await desktopCards()
        const afterHtml = await this.read(() => this.bot.browser.func.getRewardsPageHtml(URLs.rewards.earn, '/earn'))
        const after = afterHtml ? this.bot.browser.react.snapshotQuestList(afterHtml) : []
        for (const parent of parents) {
            const done = after.find(item => item.offerId === parent.offerId)?.complete === true
            this.add({
                id: parent.offerId,
                title: parent.title || '打卡卡片',
                status: done ? 'completed' : 'unconfirmed',
                reason: done ? '卡片完成标记已确认' : '卡片仍需累计天数、人工领取或进一步核验',
                before: parent.complete,
                after: done
            })
        }
    }

    async abort(reason: string): Promise<void> {
        this.add({ id: 'run-blocked', title: '运行中断', status: 'manual', reason })
        await this.publish()
    }

    async publish(): Promise<void> {
        if (this.published) return
        this.published = true
        this.report.finishedAt = new Date().toISOString()
        const directory = path.resolve(this.reportDirectory)
        try {
            await fs.mkdir(directory, { recursive: true })
            const accountId = createHash('sha256').update(this.report.account).digest('hex').slice(0, 12)
            const filename = `tasks-${accountId}-${Date.now()}.json`
            await fs.writeFile(path.join(directory, filename), JSON.stringify(this.report, null, 2), { mode: 0o600 })
            for (const entry of await fs.readdir(directory)) {
                if (!/^tasks-[a-f0-9]{12}-\d+\.json$/.test(entry)) continue
                const file = path.join(directory, entry)
                if (Date.now() - (await fs.stat(file)).mtimeMs > 30 * 86400000) await fs.unlink(file)
            }
        } catch {
            this.bot.logger.error('main', 'TASK-REPORT', '本地运行报告保存失败')
        }
        const completed = this.report.tasks.filter(task => task.status === 'completed').length
        const skipped = this.report.tasks.filter(task => task.status === 'skipped').length
        const needsReview = this.report.tasks.filter(task => !['completed', 'skipped'].includes(task.status))
        const reviewTitles = [...new Set(needsReview.map(task => task.title))]
        const review = reviewTitles.slice(0, 3).join('、') + (reviewTitles.length > 3 ? '等' : '')
        const delta =
            this.report.finalPoints !== undefined && this.report.initialPoints !== undefined
                ? this.report.finalPoints - this.report.initialPoints
                : '无法核验'
        const message = [
            `每日任务报告：完成 ${completed} 项，正常跳过 ${skipped} 项`,
            needsReview.length ? `需要检查 ${needsReview.length} 项：${review}（原因见明细）` : '需要检查：无',
            `积分变化：${delta}`,
            `下次打卡重置：${this.report.nextStreakResetAt ? new Date(this.report.nextStreakResetAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间，微软页面）' : '页面未提供，无法核验'}`
        ].join('\n')
        const telegram = this.bot.config.webhook.telegram
        if (telegram?.enabled) await sendTelegram(telegram, message, needsReview.length ? 'warn' : 'info')
        this.bot.logger.info('main', 'TASK-SUMMARY', message)
    }
}
