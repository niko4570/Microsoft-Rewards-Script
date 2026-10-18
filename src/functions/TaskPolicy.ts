import type { AppDashboardData } from '../interface/AppDashBoardData'
import type { BasePromotion, DashboardData } from '../interface/DashboardData'
import type { PageSnapshot, StreakState } from '../browser/ReactFunc'
import { mapEarnToDashboard } from '../browser/EarnDashboard'

// Streak completion does not imply completion of the ordinary point cards.
// Use the same adapter and skip rules as TaskRunner, including today's date.
export function hasPendingEarnTasks(snapshot: PageSnapshot, today: string): boolean {
    if (snapshot.streaks.some(streak => !streak.isCurrentDayCompleted)) return true
    const reportable = new Set(snapshot.reportable.map(offer => offer.offerId))
    return dailyOffers(mapEarnToDashboard(snapshot, today), today).some(
        offer => reportable.has(offer.offerId) && !offerSkipReason(offer)
    )
}

export function dailyOffers(data: DashboardData, date: string): BasePromotion[] {
    return [
        ...new Map(
            [
                ...(data.dashboard.dailySetPromotions[date] ?? []),
                ...(data.dashboard.morePromotions ?? []),
                ...(data.dashboard.morePromotionsWithoutPromotionalItems ?? [])
            ].map(offer => [offer.offerId, offer])
        ).values()
    ]
}

export function offerSkipReason(offer: BasePromotion): string | undefined {
    if (offer.complete) return '已经完成'
    if (offer.exclusiveLockedFeatureStatus === 'locked') return '任务未解锁'
    if (offer.pointProgressMax <= 0) return '无直接积分，保留现有跳过规则'
    if (offer.priority < 0 && offer.exclusiveLockedFeatureStatus !== 'unlocked') return '任务当前不可用'
    if ((offer.attributes as Record<string, unknown> | null)?.promotional === 'True') return '保留现有促销过滤规则'
    if (offer.promotionType?.toLowerCase() !== 'urlreward') return `尚不支持任务类型：${offer.promotionType ?? '未知'}`
    return undefined
}

export function searchStreak(streaks: StreakState[]): StreakState | undefined {
    return streaks.find(
        streak => /bing|search/i.test(streak.partner) && !/visual|edge|mobile|app|sapphire/i.test(streak.partner)
    )
}

export function remainingStreakSearches(streak: StreakState): number | null {
    if (streak.isCurrentDayCompleted) return 0
    const remaining = streak.activitiesTotal - streak.activitiesCompleted
    if (!streak.isEnabled || !Number.isInteger(remaining) || remaining < 1 || remaining > 10) return null
    return remaining
}

export function readingOffer(data: AppDashboardData): { id: string; remaining: number } | undefined {
    for (const promotion of data.response.promotions) {
        const attrs = promotion.attributes
        if (attrs.type !== 'msnreadearn' || !attrs.offerid || attrs.complete?.toLowerCase() === 'true') continue
        const max = Number(attrs.pointmax)
        const progress = Number(attrs.pointprogress)
        if (Number.isFinite(max) && Number.isFinite(progress) && max > progress && progress >= 0) {
            return { id: attrs.offerid, remaining: Math.ceil(max - progress) }
        }
    }
    return undefined
}

export async function readWithRetry<T>(read: () => Promise<T>, wait: (ms: number) => Promise<void>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await read()
        } catch (error) {
            if (attempt >= 2) throw error
            await wait(1000 * (attempt + 1))
        }
    }
}
