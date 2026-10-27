import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { DesktopBridge, Snapshot } from './types'

const actions = [
    'snapshot',
    'detectBrowser',
    'downloadChrome',
    'downloadEdge',
    'checkUpdate',
    'downloadUpdate',
    'showUpdateFile',
    'start',
    'stop',
    'login',
    'cancelLogin',
    'refreshBalance',
    'saveSettings',
    'restartBackend',
    'openDataDirectory',
    'exportDiagnostics',
    'clearData',
    'quit'
] as const

let latest: Snapshot | undefined
window.desktop = {
    ...Object.fromEntries(
        actions.map(action => [
            action,
            (value?: unknown) =>
                invoke('desktop_invoke', { action, value: value ?? null })
                    .then(result => {
                        if (action === 'snapshot') latest = result as Snapshot
                        return result
                    })
                    .catch(error => {
                        throw new Error(String(error))
                    })
        ])
    ),
    onState(callback: (value: Snapshot) => void) {
        let disposed = false
        const unsubscribe: Array<() => void> = []
        const subscriptions = [
            listen<Snapshot>('desktop:state', event => {
                latest = event.payload
                if (!disposed) callback(event.payload)
            }),
            listen<string>('desktop:error', event => {
                if (!disposed && latest) {
                    latest = { ...latest, backendReady: false, state: 'offline', error: event.payload }
                    callback(latest)
                }
            })
        ]
        for (const subscription of subscriptions)
            void subscription.then(stop => {
                if (disposed) stop()
                else unsubscribe.push(stop)
            })
        return () => {
            disposed = true
            unsubscribe.forEach(stop => stop())
        }
    }
} as DesktopBridge
