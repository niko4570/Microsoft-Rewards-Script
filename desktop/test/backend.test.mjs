import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Backend } from '../lib/backend.mjs'
import { RunState } from '../lib/runState.mjs'
import { initializeData } from '../lib/data.mjs'
import { loadConfigSafe } from '../../scripts/api/lib.js'
import { readConfig } from '../../scripts/api/configEditor.js'
import { loadConfig, getSessionDbPath } from '../../scripts/utils.js'
import { once } from 'node:events'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)

test('API readiness uses a real random port, authenticates and respects isolated data', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'Rewards API 测试 '))
    let backend
    t.after(async () => {
        await backend?.close()
        await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })
    const settings = initializeData(directory, path.join(root, 'config.tasks.example.json'))
    backend = new Backend({
        executable: process.execPath,
        resourceDirectory: root,
        dataDirectory: directory,
        settings: () => settings,
        log: () => {}
    })
    await backend.start()
    assert.match(backend.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/)
    const health = await backend.request('/health')
    assert.equal(health.authRequired, true)
    assert.equal(health.state, 'idle')
    assert.equal((await fetch(backend.endpoint + '/health')).status, 401)
    assert.equal((await backend.request('/sessions')).count, 0)
    assert.equal((await backend.request('/accounts')).count, 0)
    await assert.rejects(backend.request('/config', 'PATCH', { tasksOnly: false }), /disabled/)
    await backend.close()
    assert.equal(backend.child, null)
})

test('all config readers select desktop data even when cwd and resource config exist', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-paths-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    initializeData(directory, path.join(root, 'config.tasks.example.json'))
    const oldData = process.env.MRS_DATA_DIR
    process.env.MRS_DATA_DIR = directory
    t.after(() => {
        if (oldData === undefined) delete process.env.MRS_DATA_DIR
        else process.env.MRS_DATA_DIR = oldData
    })
    const expected = path.join(directory, 'config.json')
    assert.equal(loadConfigSafe(root).path, expected)
    assert.equal(readConfig(root).path, expected)
    assert.equal(loadConfig(root).path, expected)
    assert.equal(require('../../dist/util/ConfigSync.js').resolveConfigPath(root), expected)
    assert.equal(require('../../dist/util/Load.js').loadConfig().tasksOnly, true)
    assert.equal(getSessionDbPath(root, 'sessions').dbPath, path.join(directory, 'sessions/sessions.db'))
    fs.unlinkSync(expected)
    assert.equal(loadConfigSafe(root), null)
    assert.throws(() => readConfig(root), /ENOENT/)
})

test('backend crash terminates its tracked task instead of leaving it running', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-process-test-'))
    let backend
    t.after(async () => {
        await backend?.close()
        await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })
    const resources = path.join(directory, 'resources')
    const data = path.join(directory, 'data')
    fs.mkdirSync(path.join(resources, 'scripts'), { recursive: true })
    fs.mkdirSync(path.join(resources, 'dist'), { recursive: true })
    fs.cpSync(path.join(root, 'scripts/api'), path.join(resources, 'scripts/api'), { recursive: true })
    for (const name of ['package.json', 'env.js', 'runtimePaths.js'])
        fs.copyFileSync(path.join(root, 'scripts', name), path.join(resources, 'scripts', name))
    fs.writeFileSync(path.join(resources, 'package.json'), '{"name":"desktop-test-runtime"}')
    fs.writeFileSync(path.join(resources, 'dist/index.js'), 'setInterval(() => {}, 1000)')
    initializeData(data, path.join(root, 'config.tasks.example.json'))
    backend = new Backend({
        executable: process.execPath,
        resourceDirectory: resources,
        dataDirectory: data,
        settings: () => defaultsForTest(),
        log: () => {}
    })
    await backend.start()
    const result = await backend.request('/start', 'POST', {})
    const pid = result.pid
    assert.ok(pid > 0)
    for (let attempt = 0; attempt < 100 && backend.taskPid !== pid; attempt++)
        await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(backend.taskPid, pid)
    const failure = once(backend, 'failure')
    backend.child.kill('SIGKILL')
    await failure
    let alive = true
    for (let attempt = 0; attempt < 100 && alive; attempt++) {
        try {
            process.kill(pid, 0)
        } catch {
            alive = false
        }
        if (alive) await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(alive, false, 'task process should be terminated after API crash')
})

function defaultsForTest() {
    return { email: '', schedule: { enabled: false, time: '13:00', timezone: 'Asia/Shanghai' }, startOnLogin: false }
}

test('real backend publishes completion so the run marker clears without renderer polling', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-completion-test-'))
    let backend
    let timeout
    t.after(async () => {
        clearTimeout(timeout)
        // Windows keeps the child's working directory locked until it exits.
        await backend?.close()
        await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })
    const resources = path.join(directory, 'resources')
    const data = path.join(directory, 'data')
    fs.mkdirSync(path.join(resources, 'scripts'), { recursive: true })
    fs.mkdirSync(path.join(resources, 'dist'), { recursive: true })
    fs.cpSync(path.join(root, 'scripts/api'), path.join(resources, 'scripts/api'), { recursive: true })
    for (const name of ['package.json', 'env.js', 'runtimePaths.js'])
        fs.copyFileSync(path.join(root, 'scripts', name), path.join(resources, 'scripts', name))
    fs.writeFileSync(path.join(resources, 'package.json'), '{"name":"desktop-test-runtime"}')
    fs.writeFileSync(path.join(resources, 'dist/index.js'), 'process.exit(0)')
    initializeData(data, path.join(root, 'config.tasks.example.json'))
    backend = new Backend({
        executable: process.execPath,
        resourceDirectory: resources,
        dataDirectory: data,
        settings: () => defaultsForTest(),
        log: () => {}
    })
    const file = path.join(data, 'run-state.json')
    const state = new RunState(file)
    state.start('test@example.com', null)
    const completed = new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('completion status was not published')), 5000)
        backend.on('status', status => {
            state.observe(status)
            if (status.state === 'idle' && status.lastExit) resolve(status)
        })
    })
    await backend.start()
    await backend.request('/start', 'POST', {})
    const status = await completed
    clearTimeout(timeout)
    assert.equal(status.lastExit.code, 0)
    assert.equal(new RunState(file).value.status, 'finished')
})
