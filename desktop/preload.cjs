// Sandboxed Electron preloads use CommonJS, independently of the UI build.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron')

const actions = [
    'snapshot',
    'start',
    'stop',
    'login',
    'cancelLogin',
    'saveSettings',
    'restartBackend',
    'openDataDirectory',
    'exportDiagnostics',
    'clearData',
    'quit'
]
const bridge = Object.fromEntries(
    actions.map(action => [action, value => ipcRenderer.invoke('desktop:invoke', action, value)])
)
bridge.onState = callback => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('desktop:state', listener)
    return () => ipcRenderer.removeListener('desktop:state', listener)
}
contextBridge.exposeInMainWorld('desktop', bridge)
