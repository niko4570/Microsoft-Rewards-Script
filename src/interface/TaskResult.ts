export type TaskStatus = 'completed' | 'skipped' | 'failed' | 'manual' | 'unconfirmed'

export interface TaskResult {
    id: string
    title: string
    status: TaskStatus
    reason: string
    before?: number | boolean
    after?: number | boolean
    pointsGained?: number
}

export interface TaskReport {
    nextStreakResetAt?: string | null
    account: string
    startedAt: string
    finishedAt?: string
    initialPoints?: number
    finalPoints?: number
    tasks: TaskResult[]
    streaks: Array<{ partner: string; today: boolean; days: number; total: number }>
    stamps: string | null
}
