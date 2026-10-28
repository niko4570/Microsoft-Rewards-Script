import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DesktopScheduler } from '../lib/scheduler.mjs'
import { DailyState, localDate } from '../lib/dailyState.mjs'

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-schedule-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    let now = new Date(2026, 9, 28, 12)
    let count = 0
    const settings = { email: 'person@example.com', mode: 'tasks', schedule: { enabled: true } }
    const daily = new DailyState(path.join(directory, 'daily.json'))
    const options = {
        settings: () => settings,
        daily,
        now: () => now,
        log: () => {},
        trigger: async () => {
            count++
        }
    }
    const scheduler = new DesktopScheduler(options)
    return {
        scheduler,
        options,
        settings,
        daily,
        count: () => count,
        time: value => {
            now = value
        }
    }
}

test('only one attempt per host day, but restart retries incomplete work', async t => {
    const f = fixture(t)
    await Promise.all([f.scheduler.tick(), f.scheduler.tick(), f.scheduler.tick()])
    f.scheduler.reset()
    await f.scheduler.tick()
    assert.equal(f.count(), 1)
    await new DesktopScheduler(f.options).tick()
    assert.equal(f.count(), 2)
})

test('persisted completed date skips startup and next local day naturally becomes incomplete', async t => {
    const f = fixture(t)
    f.daily.record({ account: f.settings.email, mode: 'tasks', date: '2026-10-28' }, true)
    await f.scheduler.tick()
    assert.equal(f.count(), 0)
    f.time(new Date(2026, 9, 29, 0, 1))
    await f.scheduler.tick()
    assert.equal(f.count(), 1)
    f.time(new Date(2026, 9, 28, 23, 0)) // Clock moved back to a completed date.
    await f.scheduler.tick()
    assert.equal(f.count(), 1)
})

test('wake after several days runs only the current date', async t => {
    const f = fixture(t)
    await f.scheduler.tick()
    f.time(new Date(2026, 10, 2, 10))
    await f.scheduler.tick()
    assert.equal(f.count(), 2)
})

test('disabled, missing account, busy and corrupt states do not trigger work', async t => {
    const f = fixture(t)
    f.settings.schedule.enabled = false
    await f.scheduler.tick()
    f.settings.schedule.enabled = true
    f.settings.email = ''
    await f.scheduler.tick()
    f.settings.email = 'person@example.com'
    f.scheduler.available = () => false
    await f.scheduler.tick()
    f.scheduler.available = () => true
    f.daily.error = '损坏'
    await f.scheduler.tick()
    assert.equal(f.count(), 0)
    assert.equal(f.scheduler.attempts.size, 0)
})

test('known pre-submission failure retries but uncertain submission waits for restart', async t => {
    const f = fixture(t)
    f.scheduler.trigger = async () => {
        throw Object.assign(new Error('missing session'), { safeToRetry: true })
    }
    await f.scheduler.tick()
    assert.equal(f.scheduler.attempts.size, 0)
    let submissions = 0
    f.scheduler.trigger = async () => {
        submissions++
        throw new Error('lost response')
    }
    await f.scheduler.tick()
    await f.scheduler.tick()
    assert.equal(submissions, 1)
})

test('accounts and modes have independent completion and attempt records', async t => {
    const f = fixture(t)
    await f.scheduler.tick()
    f.settings.mode = 'tasks-search'
    await f.scheduler.tick()
    f.settings.email = 'other@example.com'
    await f.scheduler.tick()
    assert.equal(f.count(), 3)
})

test('manual run consumes this hosts automatic opportunity without persisting an automatic ban', async t => {
    const f = fixture(t)
    f.scheduler.markAttempt({ account: f.settings.email, mode: f.settings.mode, date: localDate(f.options.now()) })
    await f.scheduler.tick()
    assert.equal(f.count(), 0)
    await new DesktopScheduler(f.options).tick()
    assert.equal(f.count(), 1)
})
