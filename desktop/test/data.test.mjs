import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaults, initializeData, validateSettings, redact, DailyLog, readReports } from '../lib/data.mjs'
import { backendEnvironment } from '../lib/runtime.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
function temporary(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'Rewards 测试 '))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    return directory
}

test('fresh data is private, tasks-only and upgrades preserve existing data', t => {
    const directory = temporary(t)
    const template = path.join(root, 'config.tasks.example.json')
    assert.deepEqual(initializeData(directory, template), defaults)
    const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json')))
    assert.equal(config.tasksOnly, true)
    assert.equal(config.headless, true)
    assert.equal(config.workers.doDesktopSearch, false)
    assert.equal(config.webhook.telegram.botToken, '')
    const settings = { ...defaults, email: 'someone@example.com' }
    fs.writeFileSync(path.join(directory, 'desktop.json'), JSON.stringify(settings))
    fs.writeFileSync(path.join(directory, 'sessions/marker'), 'persistent session')
    const before = fs.readFileSync(path.join(directory, 'config.json'))
    assert.deepEqual(initializeData(directory, template), settings)
    assert.deepEqual(fs.readFileSync(path.join(directory, 'config.json')), before)
    assert.equal(fs.readFileSync(path.join(directory, 'sessions/marker'), 'utf8'), 'persistent session')
})

test('rejects account injection and invalid automatic settings; migrates fixed schedules', () => {
    for (const email of ['a@example.com\nAPI_TOKEN=x', 'a@example.com"', 'no-email']) {
        assert.throws(() => validateSettings({ ...defaults, email }))
    }
    assert.deepEqual(
        validateSettings({ ...defaults, schedule: { enabled: true, time: '13:00', timezone: 'Asia/Shanghai' } })
            .schedule,
        { enabled: true }
    )
    assert.throws(() => validateSettings({ ...defaults, schedule: { enabled: 'true' } }))
    assert.throws(() => validateSettings({ ...defaults, startOnLogin: 'true' }))
})

test('backend inherits OS essentials but never developer credentials or injection', () => {
    const env = backendEnvironment({
        dataDirectory: '/data',
        resourceDirectory: '/resources',
        settings: { ...defaults, email: 'chosen@example.com' },
        token: 'fresh',
        source: {
            PATH: '/bin',
            NODE_OPTIONS: '--require=evil',
            ACCOUNT_2_EMAIL: 'private@example.com',
            CONFIG_TASKS_ONLY: 'false',
            API_TOKEN: 'old',
            HTTPS_PROXY: 'private'
        }
    })
    assert.equal(env.PATH, '/bin')
    assert.equal(env.ACCOUNT_1_EMAIL, 'chosen@example.com')
    assert.equal(env.API_TOKEN, 'fresh')
    for (const name of ['NODE_OPTIONS', 'ACCOUNT_2_EMAIL', 'HTTPS_PROXY']) assert.equal(env[name], undefined)
    assert.equal(env.CONFIG_TASKS_ONLY, 'true')
})

test('persistent logs and diagnostic export redact credentials, email and URLs', t => {
    const directory = temporary(t)
    const log = new DailyLog(directory)
    log.write('user@example.com https://host/path?token=abc password=supersecret Bearer abc.def token: hidden-value')
    const content = log.exportText()
    for (const secret of ['user@example.com', 'host/path', 'supersecret', 'abc.def', 'hidden-value'])
        assert.ok(!content.includes(secret))
    assert.ok(redact('123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456').includes('[令牌已隐藏]'))
    fs.writeFileSync(path.join(directory, '2020-01-01.log'), 'old')
    log.cleanup()
    assert.equal(fs.existsSync(path.join(directory, '2020-01-01.log')), false)
})

test('report reader ignores unrelated files and returns corrupt report as an error', t => {
    const directory = temporary(t)
    fs.writeFileSync(path.join(directory, 'private.json'), '{"secret":true}')
    fs.writeFileSync(path.join(directory, 'tasks-abcdef123456-1.json'), '{"tasks":[],"startedAt":"2026-10-13"}')
    fs.writeFileSync(path.join(directory, 'tasks-abcdef123456-2.json'), 'invalid')
    const reports = readReports(directory)
    assert.equal(reports.length, 2)
    assert.ok(reports[0].error)
    assert.equal(reports[1].startedAt, '2026-10-13')
})
