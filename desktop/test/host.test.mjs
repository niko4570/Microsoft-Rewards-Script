import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('Tauri Node host uses private pipes, persists settings and closes its real API on EOF', async t => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'Rewards Tauri host 测试 '))
    const child = spawn(process.execPath, [path.join(root, 'desktop/host.mjs'), root, data, '0.1.9'], {
        stdio: ['pipe', 'pipe', 'pipe']
    })
    const exited = once(child, 'exit')
    t.after(async () => {
        child.stdin.end()
        await exited
        fs.rmSync(data, { recursive: true, force: true })
    })
    let sequence = 0
    const pending = new Map()
    const native = []
    let rejectAutostart = false
    const send = value => child.stdin.write(JSON.stringify(value) + '\n')
    const input = readline.createInterface({ input: child.stdout })
    input.on('line', line => {
        const message = JSON.parse(line)
        if (message.native) {
            native.push(message.native)
            send({
                nativeResult: message.native.id,
                value: null,
                ...(rejectAutostart ? { error: 'autostart fixture rejected' } : {})
            })
        } else if (message.id) {
            const request = pending.get(message.id)
            pending.delete(message.id)
            if (message.error) request.reject(new Error(message.error))
            else request.resolve(message.value)
        }
    })
    function request(action, value) {
        return new Promise((resolve, reject) => {
            const id = ++sequence
            pending.set(id, { resolve, reject })
            send({ id, action, value })
        })
    }
    const initial = await request('snapshot')
    assert.equal(initial.backendReady, true)
    assert.equal(initial.state, 'idle')
    assert.deepEqual(
        native.map(message => [message.action, message.value]),
        [['syncAutoStart', false]]
    )
    await assert.rejects(request('login', 'unexpected@example.com'), /此操作不接受参数/)
    await assert.rejects(request('constructor'), /不支持的操作/)
    const settings = { mode: 'tasks', email: 'host@example.com', schedule: { enabled: false }, startOnLogin: true }
    rejectAutostart = true
    await assert.rejects(request('saveSettings', settings), /autostart fixture rejected/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'desktop.json'))).email, '')
    rejectAutostart = false
    assert.deepEqual(await request('saveSettings', settings), settings)
    assert.deepEqual((await request('snapshot')).settings, settings)
    child.stdin.end()
    assert.deepEqual(await exited, [0, null])
})
