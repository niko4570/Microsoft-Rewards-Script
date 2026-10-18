export interface Settings {
    email: string
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
