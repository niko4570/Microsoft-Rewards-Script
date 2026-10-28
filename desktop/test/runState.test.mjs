import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RunState } from '../lib/runState.mjs'
import { DailyState, localDate, matchingReport, reportComplete } from '../lib/dailyState.mjs'
import { spawnSync } from 'node:child_process'

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-run-state-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const file = path.join(directory, 'run-state.json')
    return { directory, file, state: new RunState(file) }
}
const account = 'person@example.com'
const options = { date: '2026-10-28', mode: 'tasks', runId: 'unique-run' }

test('unfinished process is interrupted on restart; old server cycles do not block a fresh host', t => {
    const { state, file } = fixture(t)
    state.start(account, options)
    const restored = new RunState(file)
    assert.equal(restored.isInterrupted(account), true)
    restored.start(account, { ...options, runId: 'new-run' })
    assert.equal(restored.isInterrupted(account), false)
})

test('normal exit and explicit stop remain distinct, stale exit cannot finish a new run', t => {
    const { state, file } = fixture(t)
    state.start(account, options)
    state.observe({ state: 'idle', lastExit: { code: 0, at: '2000-01-01T00:00:00Z' } })
    assert.equal(state.value.status, 'running')
    state.observe({ state: 'idle', lastExit: { code: 0, at: new Date().toISOString() } })
    assert.equal(new RunState(file).value.status, 'finished')
    state.start(account, options)
    state.interrupt()
    state.observe({ state: 'idle', lastExit: { code: 0, at: new Date().toISOString() } })
    assert.equal(new RunState(file).isInterrupted(account), true)
})

test('matching reports require exact run identity, account and complete timestamps', t => {
    const { state } = fixture(t)
    state.start(account, options)
    const report = {
        runId: options.runId,
        account,
        startedAt: state.value.startedAt,
        finishedAt: new Date().toISOString(),
        tasks: [{ status: 'completed' }]
    }
    assert.equal(matchingReport(state.value, [report]), report)
    for (const change of [
        { runId: 'old' },
        { account: 'other@example.com' },
        { finishedAt: null },
        { startedAt: '2000-01-01' }
    ]) {
        assert.equal(matchingReport(state.value, [{ ...report, ...change }]), null)
    }
    assert.equal(reportComplete(report), true)
    for (const tasks of [
        [],
        [{ status: 'failed' }],
        [{ status: 'unconfirmed' }],
        [{ status: 'manual' }],
        [{ status: 'unknown' }]
    ]) {
        assert.equal(reportComplete({ ...report, tasks }), false)
    }
})

test('corrupt and invalid daily state pauses automation, explicit repair preserves original', t => {
    const { directory } = fixture(t)
    const file = path.join(directory, 'daily.json')
    for (const text of ['{', '[]', '{"version":1,"days":{"x":{}}}']) {
        fs.writeFileSync(file, text)
        const daily = new DailyState(file)
        assert.match(daily.error, /损坏/)
        assert.equal(daily.completed(account, 'tasks', options.date), false)
    }
    const daily = new DailyState(file)
    daily.record({ ...options, account }, true)
    assert.equal(new DailyState(file).completed(account, 'tasks', options.date), true)
    assert.ok(fs.readdirSync(directory).some(name => name.startsWith('daily.json.corrupt-')))
})

test('invalid run records clear the memory lock, preserve original bytes and back up before repair', t => {
    const { file, directory } = fixture(t)
    const valid = { status: 'running', account, startedAt: new Date().toISOString() }
    for (const original of [
        '{',
        JSON.stringify({ ...valid, startedAt: 'invalid' }),
        JSON.stringify({ ...valid, account: 42 }),
        JSON.stringify({ ...valid, account: null })
    ]) {
        fs.writeFileSync(file, original)
        const state = new RunState(file)
        assert.match(state.error, /损坏/)
        assert.equal(state.value, null)
        assert.equal(fs.readFileSync(file, 'utf8'), original)
        state.interrupt()
        assert.equal(fs.readFileSync(file, 'utf8'), original)
        state.start(account, options)
        assert.equal(state.error, null)
        assert.equal(state.value.status, 'running')
        const backups = fs.readdirSync(directory).filter(name => name.startsWith('run-state.json.corrupt-'))
        assert.ok(backups.some(name => fs.readFileSync(path.join(directory, name), 'utf8') === original))
    }
})

test('local dates follow the system timezone rather than UTC, including DST boundaries', () => {
    const module = new URL('../lib/dailyState.mjs', import.meta.url).href
    for (const [tz, date, expected] of [
        ['Asia/Singapore', '2026-10-28T17:00:00Z', '2026-10-29'],
        ['America/Los_Angeles', '2026-10-28T01:00:00Z', '2026-10-27'],
        ['America/New_York', '2026-11-01T06:30:00Z', '2026-11-01']
    ]) {
        const result = spawnSync(
            process.execPath,
            [
                '--input-type=module',
                '-e',
                `import {localDate} from ${JSON.stringify(module)}; process.stdout.write(localDate(new Date(${JSON.stringify(date)})))`
            ],
            { env: { ...process.env, TZ: tz }, encoding: 'utf8' }
        )
        assert.equal(result.status, 0, result.stderr)
        assert.equal(result.stdout, expected)
    }
    assert.match(localDate(), /^\d{4}-\d{2}-\d{2}$/)
})
