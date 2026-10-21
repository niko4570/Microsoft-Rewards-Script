export interface Settings {
    email: string
    mode: 'tasks' | 'tasks-search'
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

export interface Snapshot {
    version: string
    update: {
        status: 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'downloaded' | 'error'
        version: string | null
        progress: number
        error: string | null
        filePath: string | null
    }
    settings: Settings
    automation: { nextResetAt: string | null; message: string }
    backendReady: boolean
    state: string
    error: string | null
    lastExit: { code: number | null; signal?: string | null; error?: string } | null
    sessions: Array<{ platform: string; hasStorageState: boolean; updatedAt: string | null }>
    reports: TaskReport[]
    logs: string[]
}

export interface DesktopBridge {
    snapshot(): Promise<Snapshot>
    checkUpdate(): Promise<void>
    downloadUpdate(): Promise<boolean>
    showUpdateFile(): Promise<void>
    start(): Promise<unknown>
    stop(): Promise<unknown>
    login(): Promise<unknown>
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
