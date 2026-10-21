import type { PageSnapshot, ParsedOffer } from './ReactFunc'
import type { BasePromotion, Dashboard, DashboardData } from '../interface/DashboardData'

/** Adapt only the fields consumed by tasksOnly; unavailable API-only data stays empty. */
export function mapEarnToDashboard(snapshot: PageSnapshot, today: string): DashboardData {
    const balance = snapshot.account.availablePoints
    if (snapshot.account.level === null && balance === null) {
        throw new Error('LOGIN_STATE_UNCONFIRMED: Rewards page did not return account data')
    }
    const pointsKnown = typeof balance === 'number' && Number.isSafeInteger(balance) && balance >= 0
    const [month, day, year] = today.split('/')
    const date = `${year}-${month?.padStart(2, '0')}-${day?.padStart(2, '0')}`
    const current = snapshot.offers.filter(offer => !offer.date || offer.date === date)
    const daily = current.filter(offer => offer.date === date).map(toPromotion)
    const more = current.filter(offer => !offer.date).map(toPromotion)
    const profile = { attributes: { country: '' } }
    const dashboard = {
        userStatus: {
            // Consumers must honor availablePointsKnown; zero is only the legacy shape's placeholder.
            availablePoints: pointsKnown ? balance : 0,
            isRewardsUser: true,
            counters: {
                pcSearch: snapshot.searchCounters?.pcSearch ?? [],
                mobileSearch: snapshot.searchCounters?.mobileSearch ?? [],
                activityAndQuiz: [],
                dailyPoint: []
            }
        },
        userWarnings: (snapshot.warnings ?? []).map(name => ({ name })),
        userProfile: profile,
        dailySetPromotions: { [today]: daily },
        morePromotions: more,
        morePromotionsWithoutPromotionalItems: [],
        punchCards: [],
        promotionalItems: []
    } as unknown as Dashboard
    return { dashboard, profile, source: 'earn-page', availablePointsKnown: pointsKnown } as DashboardData
}

function toPromotion(offer: ParsedOffer): BasePromotion {
    // Current link cards provide a destination and signed hash, but no legacy promotionType.
    // Keep explicitly unsupported types and non-link cards unhandled.
    let linkCard = false
    try {
        const destination = new URL(offer.destination)
        linkCard = ['https:', 'http:'].includes(destination.protocol) && Boolean(offer.hash)
    } catch {
        /* No usable link metadata. */
    }
    return {
        offerId: offer.offerId,
        name: offer.name ?? offer.offerId,
        title: offer.title || offer.offerId,
        description: offer.description,
        destinationUrl: offer.destination,
        hash: offer.hash ?? '',
        complete: offer.isCompleted,
        pointProgress: offer.isCompleted ? Math.max(0, offer.points) : 0,
        pointProgressMax: Math.max(0, offer.points),
        priority: offer.priority ?? 0,
        promotionType: offer.promotionType ?? (linkCard ? 'urlreward' : 'unknown'),
        promotionSubtype: offer.promotionSubtype ?? '',
        activityType: offer.activityType === null ? '' : String(offer.activityType),
        exclusiveLockedFeatureStatus: offer.isLocked ? 'locked' : undefined,
        attributes: { promotional: offer.isPromotional ? 'True' : 'False' }
    } as BasePromotion
}
