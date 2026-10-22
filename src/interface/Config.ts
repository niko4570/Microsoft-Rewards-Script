export interface Config {
    tasksOnly: boolean
    sessionPath: string
    headless: boolean
    clusters: number
    errorDiagnostics: boolean
    ensureStreakProtection: boolean
    autoClaimPunchcardRewards: boolean
    contintueOnBotWarning: boolean
    skipNonPointTasks: boolean
    accountDelay: ConfigDelay
    workers: ConfigWorkers
    activities: ConfigActivities
    searchOnBingLocalQueries: boolean
    globalTimeout: number | string
    searchSettings: ConfigSearchSettings
    experimental: ConfigExperimental
    debugLogs: boolean
    proxy: ConfigProxy
    consoleLogFilter: LogFilter
    webhook: ConfigWebhook
}

export type QueryEngine = 'google' | 'wikipedia' | 'wikirandom' | 'hackernews' | 'reddit' | 'local'

export type RssFeedSelector = 'rss' | `rss.${string}`
export type QueryEngineEntry = QueryEngine | RssFeedSelector

export interface ConfigSearchSettings {
    scrollRandomResults: boolean
    clickRandomResults: boolean
    runOnZeroPoints: boolean
    maxBonusSearches: number
    parallelSearching: boolean
    clusterSearch: boolean
    queryEngines: QueryEngineEntry[]
    searchResultVisitTime: number | string
    searchDelay: ConfigDelay
    readDelay: ConfigDelay
}

export interface ConfigDelay {
    min: number | string
    max: number | string
}

export interface ConfigExperimental {
    apiSearch: boolean
    apiSearchOnBing: boolean
    blockMedia: boolean
    edgeBrowsing: boolean
}

export interface ConfigProxy {
    queryEngine: boolean
    ignoreCertificateErrors: boolean
}

export interface ConfigWorkers {
    doDailySet: boolean
    doMorePromotions: boolean
    doClaimBonusPoints: boolean
    doPunchCards: boolean
    doAppPromotions: boolean
    doDesktopSearch: boolean
    doMobileSearch: boolean
    doBonusSearches: boolean
    doDailyCheckIn: boolean
    doReadToEarn: boolean
    doActivateSearchPerk: boolean
    doSearchStreak: boolean
    doVisualSearch: boolean
}

export interface ConfigActivities {
    urlReward: boolean
    searchOnBing: boolean
}

export interface ConfigWebhook {
    telegram?: WebhookTelegramConfig
    webhookLogFilter: LogFilter
}

export interface LogFilter {
    enabled: boolean
    mode: 'whitelist' | 'blacklist'
    levels?: Array<'debug' | 'info' | 'warn' | 'error'>
    keywords?: string[]
    regexPatterns?: string[]
}

export interface WebhookTelegramConfig {
    enabled?: boolean
    botToken: string
    chatId: string | number
}
