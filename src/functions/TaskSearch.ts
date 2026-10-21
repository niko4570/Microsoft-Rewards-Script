import type { MicrosoftRewardsBot } from '../index'
import type { TaskResult } from '../interface/TaskResult'
import type { SearchManager } from './activities/search/SearchManager'

// Keep quota searches inside the task workflow so check-ins, reports and recovery survive mode changes.
export async function runTaskSearches(
    bot: MicrosoftRewardsBot,
    manager: Pick<SearchManager, 'getSearchPoints'>,
    search: (isMobile: boolean) => Promise<number>
): Promise<TaskResult[]> {
    const results: TaskResult[] = []
    for (const isMobile of [true, false]) {
        if (!(isMobile ? bot.config.workers.doMobileSearch : bot.config.workers.doDesktopSearch)) continue
        const result: TaskResult = {
            id: isMobile ? 'ordinary-mobile-search' : 'ordinary-desktop-search',
            title: isMobile ? '手机普通搜索' : '电脑普通搜索',
            status: 'unconfirmed',
            reason: '尚未确认搜索额度完成'
        }
        try {
            const before = await manager.getSearchPoints()
            const missing = isMobile ? before.mobileMissing : before.desktopMissing
            result.before = missing
            if (missing > 0) result.pointsGained = await search(isMobile)
            const after = await manager.getSearchPoints()
            const remaining = isMobile ? after.mobileMissing : after.desktopMissing
            result.after = remaining
            result.status = remaining === 0 ? 'completed' : 'unconfirmed'
            result.reason = remaining === 0 ? '普通搜索额度完成已确认' : `仍有 ${remaining} 分未完成；请查看搜索日志`
        } catch (error) {
            result.status = 'failed'
            result.reason = '无法读取额度或执行搜索，请查看日志后重试'
            bot.logger.warn('main', 'TASK-SEARCH', error instanceof Error ? error.message : String(error))
        }
        results.push(result)
    }
    return results
}
