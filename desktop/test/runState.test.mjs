import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RunState } from '../lib/runState.mjs'

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-run-state-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const file = path.join(directory, 'run-state.json')
    return { file, state: new RunState(file) }
}
const account = 'person@example.com'
const reset = () => new Date(Date.now() + 3600000).toISOString()

test('unexpected exit is recovered as interrupted and only blocks its own account and cycle', t => {
    const { file, state } = fixture(t)
    const nextReset = reset()
    state.start(account, nextReset)
    const restored = new RunState(file)
    assert.equal(restored.isInterrupted(account), true)
    assert.equal(restored.blocksCycle(account, nextReset), true)
    assert.equal(restored.blocksCycle('other@example.com', nextReset), false)
    assert.equal(restored.blocksCycle(account, new Date(Date.parse(nextReset) + 86400000).toISOString()), false)
    restored.start(account, nextReset)
    assert.equal(restored.isInterrupted(account), false)
})

test('normal exit persists without a report and stale exit status cannot finish a new run', t => {
    const { file, state } = fixture(t)
    state.start(account, reset())
    state.observe({ state: 'idle', lastExit: { code: 0, at: '2000-01-01T00:00:00Z' } })
    assert.equal(state.value.status, 'running')
    state.observe({ state: 'idle', lastExit: { code: 0, at: new Date().toISOString() } })
    assert.equal(new RunState(file).isInterrupted(account), false)
    assert.equal(new RunState(file).value.status, 'finished')
})

test('matching finished report recovers completion when the final status was not delivered', t => {
    const { file, state } = fixture(t)
    state.start(account, reset())
    const report = { account, startedAt: state.value.startedAt, finishedAt: new Date().toISOString() }
    assert.equal(new RunState(file, [{ ...report, account: 'other@example.com' }]).isInterrupted(account), true)
    state.start(account, reset())
    report.startedAt = state.value.startedAt
    report.finishedAt = new Date().toISOString()
    assert.equal(new RunState(file, [report]).value.status, 'finished')
})

test('explicit stop stays interrupted even if shutdown reports code zero or a report exists', t => {
    const { file, state } = fixture(t)
    state.start(account, null)
    state.interrupt()
    state.observe({ state: 'idle', lastExit: { code: 0, at: new Date().toISOString() } })
    const restored = new RunState(file, [
        { account, startedAt: state.value.startedAt, finishedAt: new Date().toISOString() }
    ])
    assert.equal(restored.isInterrupted(account), true)
    assert.equal(restored.blocksCycle(account, reset()), true)
})

test('abnormal exit requires manual action', t => {
    const { file, state } = fixture(t)
    state.start(account, reset())
    state.observe({ state: 'idle', lastExit: { code: null, signal: 'SIGTERM', at: new Date().toISOString() } })
    assert.equal(new RunState(file).isInterrupted(account), true)
})
