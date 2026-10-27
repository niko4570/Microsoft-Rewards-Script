import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { DesktopHost } from '../lib/host.mjs'

test('renderer actions match the native allowlist and have host handlers', () => {
    const bridge = readFileSync(new URL('../src/bridge.ts', import.meta.url), 'utf8')
    const native = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8')
    const rendererList = bridge.match(/const actions = \[([\s\S]*?)\] as const/)
    const nativeList = native.match(/const ACTIONS: &\[&str\] = &\[([\s\S]*?)\];/)
    assert.ok(rendererList, 'renderer action list must be found')
    assert.ok(nativeList, 'native action allowlist must be found')
    const rendererActions = new Set([...rendererList[1].matchAll(/'([^']+)'/g)].map(match => match[1]))
    const nativeActions = new Set([...nativeList[1].matchAll(/"([^"]+)"/g)].map(match => match[1]))
    assert.ok(rendererActions.size > 0)
    assert.deepEqual(nativeActions, rendererActions)
    const host = new DesktopHost({ service: new EventEmitter(), native: () => {}, version: 'test' })
    for (const action of rendererActions) {
        // quit is handled directly by the native shell; resume is host-internal.
        if (action !== 'quit') assert.ok(Object.hasOwn(host.actions, action), `missing host handler: ${action}`)
    }
})

test('private desktop bridge rejects extra login arguments and unknown privileged actions', async () => {
    const service = new EventEmitter()
    let logins = 0
    service.login = () => ++logins
    const host = new DesktopHost({ service, native: () => {}, version: '0.1.9' })
    assert.equal(await host.invoke('login'), 1)
    await assert.rejects(host.invoke('login', 'unused@example.com'), /此操作不接受参数/)
    for (const action of ['constructor', '__proto__', 'shutdown', 'openDirectory', 'setAutoStart'])
        await assert.rejects(host.invoke(action), /不支持的操作/)
    assert.equal(logins, 1)
})

test('diagnostic export and clearing data require a native destination or confirmation', async () => {
    const service = new EventEmitter()
    let clears = 0
    service.clearData = () => ++clears
    const requests = []
    const host = new DesktopHost({
        service,
        version: '0.1.9',
        native: async (...args) => {
            requests.push(args)
            return null
        }
    })
    assert.equal(await host.invoke('exportDiagnostics'), false)
    assert.equal(await host.invoke('clearData'), false)
    assert.equal(clears, 0)
    assert.equal(requests[0][0], 'saveFile')
    assert.equal(requests[1][0], 'confirmClear')
})

test('balance refresh is exposed through the private bridge without arguments', async () => {
    const service = new EventEmitter()
    let refreshes = 0
    service.refreshBalance = () => ++refreshes
    const host = new DesktopHost({ service, native: () => {}, version: 'test' })
    assert.equal(await host.invoke('refreshBalance'), 1)
    await assert.rejects(host.invoke('refreshBalance', { account: 'other' }), /此操作不接受参数/)
    assert.equal(refreshes, 1)
})

test('browser detection and fixed download actions cross the private bridge without arbitrary URLs', async () => {
    const service = new EventEmitter()
    service.detectBrowser = () => ({ selected: null })
    const requests = []
    const host = new DesktopHost({ service, version: 'test', native: (...args) => requests.push(args) })
    assert.deepEqual(await host.invoke('detectBrowser'), { selected: null })
    await host.invoke('downloadChrome')
    await host.invoke('downloadEdge')
    assert.deepEqual(requests, [['downloadChrome'], ['downloadEdge']])
    await assert.rejects(host.invoke('downloadChrome', 'https://other.example'), /不接受参数/)
})
