import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DesktopScheduler } from '../lib/scheduler.mjs'

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-schedule-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    let now = new Date('2026-10-13T07:00:00Z')
    let count = 0
    let scans = 0
    const settings = { email: 'person@example.com', schedule: { enabled: true } }
    let result = { nextStreakResetAt: '2026-10-13T08:00:00Z', pending: true }
    const options = {
        file: path.join(directory, 'state.json'),
        settings: () => settings,
        scan: async () => {
            scans++
            return result
        },
        trigger: async () => {
            assert.equal(JSON.parse(fs.readFileSync(options.file)).attempts.length > 0, true)
            count++
        },
        log: () => {},
        now: () => now
    }
    const scheduler = new DesktopScheduler(options)
    return {
        scheduler,
        options,
        settings,
        count: () => count,
        scans: () => scans,
        time: value => {
            now = new Date(value)
        },
        result: value => {
            result = value
        }
    }
}

test('startup inspects unfinished current tasks and restart cannot repeat the cycle', async t => {
    const f = fixture(t)
    await f.scheduler.tick()
    assert.equal(f.count(), 1)
    await new DesktopScheduler(f.options).tick()
    assert.equal(f.count(), 1)
})

test('empty cycles recheck but preserve the server reset buffer', async t => {
    const f = fixture(t)
    f.result({ nextStreakResetAt: '2026-10-13T08:00:00Z', pending: false })
    await f.scheduler.tick()
    f.time('2026-10-13T07:55:00Z')
    await f.scheduler.tick()
    f.time('2026-10-13T08:00:30Z')
    await f.scheduler.tick()
    assert.equal(f.scans(), 2)
    f.result({ nextStreakResetAt: '2026-10-14T09:30:00Z', pending: true })
    f.time('2026-10-13T08:01:00Z')
    await f.scheduler.tick()
    assert.equal(f.count(), 1)
    assert.equal(f.scheduler.state.nextResetAt, '2026-10-14T09:30:00.000Z')
})

test('a cycle not yet run rechecks newly appearing cards without waiting for reset', async t => {
    const f = fixture(t)
    f.result({ nextStreakResetAt: '2026-10-13T08:00:00Z', pending: false })
    await f.scheduler.tick()
    assert.equal(f.count(), 0)
    f.time('2026-10-13T07:04:59Z')
    await f.scheduler.tick()
    assert.equal(f.scans(), 1)
    f.time('2026-10-13T07:05:00Z')
    f.result({ nextStreakResetAt: '2026-10-13T08:00:00Z', pending: true })
    await f.scheduler.tick()
    assert.equal(f.count(), 1)
    f.time('2026-10-13T07:10:00Z')
    await f.scheduler.tick()
    assert.equal(f.scans(), 2)
    await new DesktopScheduler(f.options).tick()
    assert.equal(f.count(), 1)
})

test('resume after reset checks current tasks, with no historical runs', async t => {
    const f = fixture(t)
    await f.scheduler.tick()
    f.time('2026-10-16T10:00:00Z')
    f.result({ nextStreakResetAt: '2026-10-17T08:00:00Z', pending: true })
    f.scheduler.reset()
    await f.scheduler.tick()
    assert.equal(f.count(), 2)
})

test('missing, invalid and stale reset timestamps retry without running or inventing a time', async t => {
    const f = fixture(t)
    for (const nextStreakResetAt of [null, 'bad', '2026-10-12T08:00:00Z']) {
        f.result({ nextStreakResetAt, pending: true })
        f.scheduler.reset()
        await f.scheduler.tick()
        assert.equal(f.count(), 0)
        const scans = f.scans()
        await f.scheduler.tick()
        assert.equal(f.scans(), scans)
    }
    f.time('2026-10-13T07:05:00Z')
    f.result({ nextStreakResetAt: '2026-10-13T08:00:00Z', pending: true })
    await f.scheduler.tick()
    assert.equal(f.count(), 1)
})

test('busy start retries without consuming a cycle; disabled and missing account do not scan', async t => {
    const f = fixture(t)
    f.settings.schedule.enabled = false
    await f.scheduler.tick()
    f.settings.schedule.enabled = true
    f.settings.email = ''
    await f.scheduler.tick()
    assert.equal(f.scans(), 0)
    f.settings.email = 'person@example.com'
    f.scheduler.trigger = async () => {
        throw Object.assign(new Error('busy'), { safeToRetry: true })
    }
    await f.scheduler.tick()
    assert.deepEqual(f.scheduler.state.attempts, [])
    f.scheduler.trigger = f.options.trigger
    f.time('2026-10-13T07:05:00Z')
    await f.scheduler.tick()
    assert.equal(f.count(), 1)
})

test('concurrent ticks share one inspection, and switching accounts uses separate cycles', async t => {
    const f = fixture(t)
    await Promise.all([f.scheduler.tick(), f.scheduler.tick(), f.scheduler.tick()])
    assert.equal(f.scans(), 1)
    assert.equal(f.count(), 1)
    f.settings.email = 'second@example.com'
    f.scheduler.reset()
    await f.scheduler.tick()
    assert.equal(f.count(), 2)
})

test('lost start response keeps the reservation to prevent a duplicate automatic run', async t => {
    const f = fixture(t)
    let submissions = 0
    f.scheduler.trigger = async () => {
        submissions++
        throw new Error('response lost')
    }
    await f.scheduler.tick()
    f.scheduler.reset()
    await f.scheduler.tick()
    assert.equal(submissions, 1)
    assert.equal(f.scheduler.state.attempts.length, 1)
})
