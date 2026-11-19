import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { DesktopService } from '../lib/service.mjs'
import { atomicJson, defaults, initializeData } from '../lib/data.mjs'
import { legacyEmail } from '../lib/accountMigration.mjs'
import { localDate } from '../lib/dailyState.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const turn = () => new Promise(resolve => setImmediate(resolve))
function fixture(t, email) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-accounts-'))
    if (email) atomicJson(path.join(directory, 'desktop.json'), { ...defaults, email })
    const backend = new EventEmitter()
    backend.endpoint = null
    const starts = []
    let options
    const sessions = []
    backend.start = async () => {
        backend.endpoint = 'fake'
        starts.push(options.settings().email)
    }
    backend.close = async () => {
        backend.endpoint = null
    }
    backend.request = async route => (route === '/status' ? { state: 'idle' } : {})
    const service = new DesktopService({
        executable: process.execPath,
        resourceDirectory: root,
        dataDirectory: directory,
        version: 'test',
        browserDetector: () => ({
            installed: [],
            selected: { name: 'Edge', id: 'edge', executablePath: process.execPath },
            error: null
        }),
        sessionReader: () => sessions,
        backendFactory: value => {
            options = value
            return backend
        }
    })
    t.after(async () => {
        await service.close()
        fs.rmSync(directory, { recursive: true, force: true })
    })
    const add = async email => {
        await service.saveAccount({ email, name: '' })
        const account = service.settings.accounts.at(-1)
        sessions.push(
            ...['mobile', 'desktop'].map(platform => ({ email: account.email, platform, hasStorageState: true }))
        )
        return account
    }
    const finish = async (code = 0, tasks = [{ id: 'daily', title: '签到', status: 'completed' }]) => {
        const run = service.runState.value
        atomicJson(path.join(directory, 'reports', `tasks-abcdef123456-${Date.now()}.json`), {
            account: run.account,
            runId: run.runId,
            startedAt: run.startedAt,
            finishedAt: new Date().toISOString(),
            tasks
        })
        backend.emit('status', { state: 'idle', lastExit: { code, at: new Date().toISOString() } })
        await service.finishing
        await turn()
        // Drain the continuation and its asynchronous preflight.
        await turn()
    }
    return { directory, service, backend, sessions, starts, add, finish }
}

test('three accounts execute serially, failed account does not block the next, settings stay shared', async t => {
    const f = fixture(t)
    for (const email of ['a@example.com', 'b@example.com', 'c@example.com']) await f.add(email)
    await f.service.startQueue()
    assert.deepEqual(f.starts, ['a@example.com'])
    await assert.rejects(f.service.startQueue(), /队列/)
    await assert.rejects(f.service.saveAccount({ email: 'd@example.com', name: '' }), /队列/)
    await assert.rejects(f.service.saveSettings(f.service.settings), /队列/)
    await f.finish(1)
    assert.deepEqual(f.starts, ['a@example.com', 'b@example.com'])
    await f.finish()
    assert.deepEqual(f.starts, ['a@example.com', 'b@example.com', 'c@example.com'])
    await f.finish()
    assert.equal(f.service.queue.running, false)
    assert.deepEqual(
        f.service.queue.items.map(i => i.status),
        ['review', 'completed', 'completed']
    )
    const snapshot = await f.service.snapshot()
    assert.deepEqual(
        snapshot.accounts.map(a => a.automation.completedToday),
        [false, true, true]
    )
    assert.equal(snapshot.settings.mode, 'tasks')
})

test('missing sessions skip one account, stop cancels the rest and disabled accounts are excluded', async t => {
    const f = fixture(t)
    const a = await f.add('a@example.com')
    await f.add('b@example.com')
    const c = await f.add('c@example.com')
    await f.service.saveAccount({ id: c.id, name: 'C', enabled: false })
    f.sessions.splice(0, 2)
    await f.service.startQueue()
    assert.equal(f.service.queue.items.length, 2)
    assert.equal(f.service.queue.items[0].status, 'failed')
    assert.deepEqual(f.starts, ['b@example.com'])
    await f.service.stopRun()
    await f.service.finishing
    await turn()
    assert.equal(f.service.queue.running, false)
    assert.deepEqual(f.starts, ['b@example.com'])
    await assert.rejects(f.service.login('missing'), /账号不存在/)
    await assert.rejects(f.service.saveAccount({ email: 'A@EXAMPLE.COM', name: '' }), /重复/)
    assert.equal(f.service.settings.accounts[0].id, a.id)
})

test('automatic queue skips completed and disabled accounts, manual run can repeat completed work', async t => {
    const f = fixture(t)
    const a = await f.add('a@example.com')
    const b = await f.add('b@example.com')
    const c = await f.add('c@example.com')
    await f.service.saveSettings({ ...f.service.settings, schedule: { enabled: true } })
    await f.service.saveAccount({ id: c.id, name: '', enabled: false })
    f.service.daily.record({ account: a.email, mode: 'tasks', date: localDate() }, true)
    await f.service.scheduler.tick()
    assert.deepEqual(f.starts, [b.email])
    await f.finish()
    await f.service.scheduler.tick()
    assert.deepEqual(f.starts, [b.email])
    await f.service.startQueue([a.id])
    assert.deepEqual(f.starts, [b.email, a.email])
})

test('balances and reports stay associated with accounts; deletion retains history', async t => {
    const f = fixture(t)
    const a = await f.add('a@example.com')
    const b = await f.add('b@example.com')
    f.service.resetScanner = async () => ({ balance: f.service.activeAccount.id === a.id ? 10 : 20 })
    await f.service.refreshBalance(a.id)
    await f.service.refreshBalance(b.id)
    assert.deepEqual(
        (await f.service.snapshot()).accounts.map(a => a.balance.value),
        [10, 20]
    )
    for (let i = 0; i < 25; i++)
        atomicJson(path.join(f.directory, 'reports', `tasks-abcdef123456-${i}.json`), { account: b.email, tasks: [] })
    atomicJson(path.join(f.directory, 'reports', 'tasks-abcdef123456-0.json'), { account: a.email, tasks: [] })
    assert.equal((await f.service.snapshot()).reports.filter(r => r.account === a.email).length, 1)
    await f.service.removeAccount(a.id)
    assert.equal(f.service.settings.accounts.length, 1)
    assert.equal(f.service.balances[a.email], undefined)
    assert.equal((await f.service.snapshot()).reports.filter(r => r.account === a.email).length, 1)
})

test('explicit legacy migration remains available for recovery', async t => {
    const f = fixture(t, legacyEmail)
    const db = new DatabaseSync(path.join(f.directory, 'sessions', 'sessions.db'))
    db.exec(
        'CREATE TABLE sessions(email TEXT, platform TEXT, storage_state TEXT, PRIMARY KEY(email,platform)); CREATE TABLE account_metadata(email TEXT PRIMARY KEY, resolved_region TEXT)'
    )
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(legacyEmail, 'desktop', '{"cookies":[]}')
    db.prepare('INSERT INTO account_metadata VALUES(?,?)').run(legacyEmail, 'CN')
    db.close()
    f.service.daily.record({ account: legacyEmail, mode: 'tasks', date: localDate(), runId: 'original-id' }, true)
    atomicJson(path.join(f.directory, 'reports', 'tasks-abcdef123456-1.json'), {
        account: legacyEmail,
        runId: 'original-id',
        tasks: []
    })
    atomicJson(path.join(f.directory, 'balance.json'), {
        account: legacyEmail,
        value: 12,
        updatedAt: new Date().toISOString()
    })
    await f.service.completeMigration('Actual@Example.com')
    assert.equal((await f.service.snapshot()).needsMigration, false)
    assert.equal(f.service.daily.completed('actual@example.com', 'tasks', localDate()), true)
    assert.equal(f.service.reports()[0].runId, 'original-id')
    assert.equal(f.service.reports()[0].account, 'actual@example.com')
    assert.equal((await f.service.snapshot()).accounts[0].balance.value, 12)
    const check = new DatabaseSync(path.join(f.directory, 'sessions', 'sessions.db'))
    assert.equal(check.prepare('SELECT email FROM sessions').get().email, 'actual@example.com')
    assert.equal(check.prepare('SELECT email FROM account_metadata').get().email, 'actual@example.com')
    check.close()
    assert.ok(fs.existsSync(path.join(f.directory, 'account-migration-backup', 'sessions', 'sessions.db')))
    assert.equal(
        initializeData(f.directory, path.join(root, 'config.tasks.example.json')).accounts[0].email,
        'actual@example.com'
    )
})

test('failed migration preserves config and backup, retry uses the same email and finishes', async t => {
    const f = fixture(t, legacyEmail)
    const report = path.join(f.directory, 'reports', 'tasks-abcdef123456-1.json')
    fs.writeFileSync(report, '{broken')
    await assert.rejects(f.service.completeMigration('actual@example.com'))
    assert.equal(f.service.settings.accounts[0].email, legacyEmail)
    assert.equal(
        fs.readFileSync(path.join(f.directory, 'account-migration-backup', 'reports', path.basename(report)), 'utf8'),
        '{broken'
    )
    await assert.rejects(f.service.completeMigration('different@example.com'), /上次填写/)
    atomicJson(report, { account: legacyEmail, tasks: [] })
    await f.service.completeMigration('actual@example.com')
    assert.equal(f.service.reports()[0].account, 'actual@example.com')
})

test('stopping cancels the active account and all pending accounts', async t => {
    const f = fixture(t)
    for (const email of ['a@example.com', 'b@example.com', 'c@example.com']) await f.add(email)
    await f.service.startQueue()
    await f.service.stopRun()
    await f.service.finishing
    await turn()
    assert.deepEqual(f.starts, ['a@example.com'])
    assert.deepEqual(
        f.service.queue.items.map(i => i.status),
        ['cancelled', 'cancelled', 'cancelled']
    )
})

test('late report for a previous queue account reconciles after another account has started', async t => {
    const f = fixture(t)
    const a = await f.add('a@example.com')
    await f.add('b@example.com')
    await f.service.startQueue()
    const previous = { ...f.service.runState.value }
    f.backend.emit('status', { state: 'idle', lastExit: { code: 0, at: new Date().toISOString() } })
    await f.service.finishing
    await turn()
    await turn()
    assert.deepEqual(f.starts, ['a@example.com', 'b@example.com'])
    assert.equal(f.service.daily.completed(a.email, 'tasks', localDate()), false)
    atomicJson(path.join(f.directory, 'reports', 'tasks-abcdef123456-1.json'), {
        account: a.email,
        runId: previous.runId,
        startedAt: previous.startedAt,
        finishedAt: new Date().toISOString(),
        tasks: [{ id: 'daily', status: 'completed' }]
    })
    assert.equal((await f.service.snapshot()).accounts[0].automation.completedToday, true)
    assert.deepEqual(f.starts, ['a@example.com', 'b@example.com'])
})

test('legacy real email keeps its case-sensitive session key and deduplicates case-insensitively', async t => {
    const f = fixture(t, 'Existing@Example.com')
    assert.equal(f.service.settings.accounts[0].email, 'Existing@Example.com')
    f.sessions.push(
        ...['mobile', 'desktop'].map(platform => ({ email: 'Existing@Example.com', platform, hasStorageState: true }))
    )
    await assert.rejects(f.service.saveAccount({ email: 'existing@example.com', name: '' }), /重复/)
    await f.service.startQueue()
    assert.deepEqual(f.starts, ['Existing@Example.com'])
    await f.finish()
    assert.equal((await f.service.snapshot()).accounts[0].automation.completedToday, true)
})

test('automatic pending account is rechecked against its own start date after midnight', async t => {
    const f = fixture(t)
    const a = await f.add('a@example.com')
    const b = await f.add('b@example.com')
    let now = new Date(2026, 10, 18, 23, 59)
    f.service.now = () => now
    f.service.daily.record({ account: b.email, mode: 'tasks', date: '2026-11-19' }, true)
    await f.service.startQueue([a.id, b.id], '自动')
    now = new Date(2026, 10, 19, 0, 1)
    await f.finish()
    assert.deepEqual(f.starts, [a.email])
    assert.equal(f.service.queue.items[1].status, 'skipped')
    assert.equal(f.service.daily.completed(a.email, 'tasks', '2026-11-18'), true)
    assert.equal(f.service.daily.completed(a.email, 'tasks', '2026-11-19'), false)
})

test('stop during backend startup waits for submission and cancels the pending queue', async t => {
    const f = fixture(t)
    await f.add('a@example.com')
    await f.add('b@example.com')
    let ready
    let release
    const entered = new Promise(resolve => {
        ready = resolve
    })
    const gate = new Promise(resolve => {
        release = resolve
    })
    const start = f.backend.start
    let stops = 0
    const request = f.backend.request
    f.backend.start = async () => {
        ready()
        await gate
        await start()
    }
    f.backend.request = async route => {
        if (route === '/stop') stops++
        return request(route)
    }
    const starting = f.service.startQueue()
    await entered
    const stopping = f.service.stopRun()
    release()
    await starting
    await stopping
    await f.service.finishing
    await turn()
    assert.equal(stops, 1)
    assert.deepEqual(f.starts, ['a@example.com'])
    assert.equal(f.service.queue.running, false)
    assert.equal(f.service.queue.items[1].status, 'cancelled')
})

test('backend startup failure completes cleanup before the next queue account', async t => {
    const f = fixture(t)
    await f.add('a@example.com')
    await f.add('b@example.com')
    const start = f.backend.start
    let failed = false
    f.backend.start = async () => {
        if (!failed) {
            failed = true
            f.backend.emit('failure', 'test startup failure')
            throw new Error('test startup failure')
        }
        await start()
    }
    await f.service.startQueue()
    assert.deepEqual(f.starts, ['b@example.com'])
    assert.equal(f.service.queue.items[0].status, 'failed')
    assert.equal(f.service.queue.items[1].status, 'running')
})

test('legacy placeholder remains runnable without migration or email entry', async t => {
    const f = fixture(t, legacyEmail)
    f.sessions.push(...['mobile', 'desktop'].map(platform => ({ email: legacyEmail, platform, hasStorageState: true })))
    assert.equal((await f.service.snapshot()).needsMigration, false)
    await f.service.startQueue()
    assert.deepEqual(f.starts, [legacyEmail])
    await f.finish()
    assert.equal(f.service.settings.accounts[0].email, legacyEmail)
})

test('new login slots are independent and only successful complete logins create accounts', async t => {
    const f = fixture(t)
    const runtime = path.join(f.directory, 'runtime')
    fs.mkdirSync(path.join(runtime, 'scripts/main'), { recursive: true })
    const script = path.join(runtime, 'scripts/main/manualLogin.js')
    fs.writeFileSync(
        script,
        `
        const fs = require('node:fs'); const path = require('node:path');
        const { DatabaseSync } = require('node:sqlite');
        const dir = process.env.MRS_DATA_DIR; const email = process.env.ACCOUNT_1_EMAIL;
        const db = new DatabaseSync(path.join(dir, 'sessions/sessions.db'));
        db.exec('CREATE TABLE IF NOT EXISTS sessions(email TEXT, platform TEXT, storage_state TEXT, PRIMARY KEY(email, platform))');
        if (db.prepare('SELECT * FROM sessions').all().length) process.exit(2);
        for (const p of ['mobile', 'desktop']) db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(email, p, JSON.stringify({ cookies: [{ name: 'account', value: email }] }));
        db.close(); process.exit(0);
    `
    )
    const successfulLogin = fs.readFileSync(script, 'utf8')
    f.service.resourceDirectory = runtime
    f.service.refreshBalance = async () => {}
    for (let i = 0; i < 2; i++) {
        await f.service.login()
        await new Promise(resolve => f.service.loginChild.once('close', resolve))
        assert.equal(f.service.settings.accounts.length, i + 1, f.service.error)
    }
    const [a, b] = f.service.settings.accounts
    assert.notEqual(a.id, b.id)
    assert.notEqual(a.email, b.email)
    const db = new DatabaseSync(path.join(f.directory, 'sessions/sessions.db'))
    const before = db.prepare('SELECT * FROM sessions ORDER BY email, platform').all()
    assert.equal(before.length, 4)
    for (const row of before) assert.equal(JSON.parse(row.storage_state).cookies[0].value, row.email)
    fs.writeFileSync(script, successfulLogin.replace("['mobile', 'desktop']", "['mobile']"))
    await f.service.login()
    await new Promise(resolve => f.service.loginChild.once('close', resolve))
    assert.equal(f.service.settings.accounts.length, 2)
    assert.match(f.service.error, /登录保存失败/)
    assert.deepEqual(db.prepare('SELECT * FROM sessions ORDER BY email, platform').all(), before)
    fs.writeFileSync(script, 'process.exit(1)')
    await f.service.login()
    await new Promise(resolve => f.service.loginChild.once('close', resolve))
    assert.equal(f.service.settings.accounts.length, 2)
    assert.deepEqual(db.prepare('SELECT * FROM sessions ORDER BY email, platform').all(), before)
    fs.writeFileSync(script, `process.on('message', () => process.exit(0)); setInterval(() => {}, 1000)`)
    await f.service.login(a.id)
    await f.service.cancelLogin()
    assert.deepEqual(db.prepare('SELECT * FROM sessions ORDER BY email, platform').all(), before)
    db.close()
    assert.deepEqual(
        fs.readdirSync(f.directory).filter(name => name.startsWith('login-')),
        []
    )
})

test('name-only updates persist while a queue runs without changing execution or enabled state', async t => {
    const f = fixture(t)
    const a = await f.add('a@example.com')
    const b = await f.add('b@example.com')
    await f.service.startQueue()
    const queue = f.service.queue
    const execution = f.service.activeAccount
    const run = f.service.runState.value
    const attempts = [...f.service.scheduler.attempts]
    await f.service.saveAccount({ id: a.id, name: '账户甲' })
    await f.service.saveAccount({ id: b.id, name: '账户乙' })
    assert.equal(f.service.queue, queue)
    assert.equal(f.service.activeAccount, execution)
    assert.equal(f.service.runState.value, run)
    assert.deepEqual([...f.service.scheduler.attempts], attempts)
    assert.deepEqual(f.starts, [a.email])
    assert.deepEqual(
        f.service.settings.accounts.map(a => [a.name, a.enabled]),
        [
            ['账户甲', true],
            ['账户乙', true]
        ]
    )
    const saved = initializeData(f.directory, path.join(root, 'config.tasks.example.json'))
    assert.deepEqual(
        saved.accounts.map(a => a.name),
        ['账户甲', '账户乙']
    )
    await assert.rejects(f.service.saveAccount({ id: a.id, name: '停用', enabled: false }), /队列/)
    await assert.rejects(f.service.saveAccount({ id: a.id, name: 'x'.repeat(81) }), /账号设置无效/)
    assert.equal(f.service.settings.accounts[0].name, '账户甲')
    await f.finish()
    assert.deepEqual(f.starts, [a.email, b.email])
    await f.finish()
})

test('name-only update is available during task startup but cannot race structural settings writes', async t => {
    const f = fixture(t)
    const a = await f.add('a@example.com')
    f.service.operation = 'starting'
    await f.service.saveAccount({ id: a.id, name: '启动期间修改' })
    assert.equal(f.service.operation, 'starting')
    f.service.operation = 'saving'
    await assert.rejects(f.service.saveAccount({ id: a.id, name: '冲突修改' }), /稍后/)
    f.service.operation = null
    assert.equal(f.service.settings.accounts[0].name, '启动期间修改')
})
