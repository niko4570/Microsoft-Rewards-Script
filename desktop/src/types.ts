export interface Account {
    id: string
    email: string
    name: string
    enabled: boolean
}

export interface Settings {
    version: 2
    accounts: Account[]
    mode: 'tasks' | 'tasks-search'
    browser: 'auto' | 'chrome' | 'edge'
    schedule: { enabled: boolean }
    startOnLogin: boolean
}

export interface TaskReport {
    account?: string
    startedAt: string
    finishedAt?: string
    initialPoints?: number
    finalPoints?: number
    error?: string
    tasks: Array<{ id: string; title: string; status: string; reason: string }>
}

export interface InstalledBrowser {
    id: 'chrome' | 'edge'
    name: string
    executablePath: string
}

export interface Snapshot {
    browser: { installed: InstalledBrowser[]; selected: InstalledBrowser | null; error: string | null }
    accounts: Array<
        Account & {
            sessions: Array<{ platform: string; hasStorageState: boolean; updatedAt: string | null }>
            balance: { value: number | null; updatedAt: string | null; error: string | null }
            automation: {
                date: string
                completedToday: boolean
                status: 'pending' | 'running' | 'completed' | 'review'
                message: string
            }
            error: string | null
            interruption: string | null
        }
    >
    needsMigration: boolean
    migrationEmail: string
    queue: {
        running: boolean
        currentId?: string | null
        items: Array<{ id: string; status: string; error: string | null }>
    } | null
    version: string
    update: {
        status: 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'
        version: string | null
        progress: number
        error: string | null
        filePath: string | null
    }
    settings: Settings
    backendReady: boolean
    state: string
    error: string | null
    review?: string | null
    interruption?: string | null
    lastExit: { code: number | null; signal?: string | null; error?: string } | null
    reports: TaskReport[]
}

export interface DesktopBridge {
    snapshot(): Promise<Snapshot>
    detectBrowser(): Promise<Snapshot['browser']>
    downloadChrome(): Promise<void>
    downloadEdge(): Promise<void>
    checkUpdate(): Promise<void>
    downloadUpdate(): Promise<boolean>
    installUpdate(): Promise<boolean>
    showUpdateFile(): Promise<void>
    saveAccount(value: { id?: string; email?: string; name: string; enabled?: boolean }): Promise<Settings>
    removeAccount(value: { accountId: string }): Promise<void>
    completeMigration(value: { email: string }): Promise<void>
    startAll(): Promise<unknown>
    start(value: { accountId: string }): Promise<unknown>
    stop(): Promise<unknown>
    login(value?: { accountId: string }): Promise<unknown>
    refreshBalance(value: { accountId: string }): Promise<void>
    cancelLogin(): Promise<unknown>
    saveSettings(value: Settings): Promise<Settings>
    restartBackend(): Promise<unknown>
    openDataDirectory(): Promise<unknown>
    exportDiagnostics(): Promise<boolean>
    clearData(): Promise<boolean>
    quit(): Promise<unknown>
    onState(callback: (state: Snapshot) => void): () => void
}

declare global {
    interface Window {
        desktop: DesktopBridge
    }
}
