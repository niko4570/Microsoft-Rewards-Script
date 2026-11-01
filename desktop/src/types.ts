export interface Settings {
    email: string
    mode: 'tasks' | 'tasks-search'
    browser: 'auto' | 'chrome' | 'edge'
    schedule: { enabled: boolean }
    startOnLogin: boolean
}

export interface TaskReport {
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
    balance: { value: number | null; updatedAt: string | null; error: string | null }
    version: string
    update: {
        status: 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'
        version: string | null
        progress: number
        error: string | null
        filePath: string | null
    }
    settings: Settings
    automation: {
        date: string
        completedToday: boolean
        status: 'pending' | 'running' | 'completed' | 'review'
        message: string
    }
    backendReady: boolean
    state: string
    error: string | null
    review?: string | null
    interruption?: string | null
    lastExit: { code: number | null; signal?: string | null; error?: string } | null
    sessions: Array<{ platform: string; hasStorageState: boolean; updatedAt: string | null }>
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
    start(): Promise<unknown>
    stop(): Promise<unknown>
    login(): Promise<unknown>
    refreshBalance(): Promise<void>
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
