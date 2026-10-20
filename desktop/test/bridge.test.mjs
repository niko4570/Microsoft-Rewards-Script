import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { DesktopHost } from '../lib/host.mjs'

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
