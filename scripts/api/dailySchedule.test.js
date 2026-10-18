import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dailyTime, localClock, shouldRun, readState, writeState, reportResetTime } from './dailySchedule.js'

const schedule = { enabled: true, cron: '0 13 * * *', timezone: 'Asia/Shanghai' }
const now = new Date('2026-10-12T07:00:00Z') // 15:00 Shanghai
const attempt = { date: '2026-10-12', attempts: 1, completed: false, lastAttemptAt: now.toISOString() }

test('waits before 13:00; runs at 13:00 and catches up after it', () => {
    assert.equal(shouldRun(schedule, {}, new Date('2026-10-12T04:59:00Z')), false)
    assert.equal(shouldRun(schedule, {}, new Date('2026-10-12T05:00:00Z')), true)
    assert.equal(shouldRun(schedule, {}, now), true)
    assert.equal(shouldRun(schedule, { ...attempt, completed: true }, now), false)
    assert.equal(shouldRun(schedule, { ...attempt, date: '2026-10-10', completed: true }, now), true)
})

test('uses schedule timezone and configured time rather than host time or hardcoded 13:00', () => {
    assert.deepEqual(localClock(new Date('2026-10-11T16:00:00Z'), 'Asia/Shanghai'), {
        date: '2026-10-12',
        minute: 0
    })
    assert.equal(shouldRun({ ...schedule, cron: '30 16 * * *' }, {}, now), false)
    assert.equal(shouldRun({ ...schedule, timezone: 'UTC' }, {}, now), false)
})

test('disabled and non-daily schedules are ineligible for catch-up', () => {
    for (const cron of ['0 13 * * 1', '0 13,18 * * *', '*/5 * * * *', '0 25 * * *']) {
        assert.equal(dailyTime({ ...schedule, cron }), null)
        assert.equal(shouldRun({ ...schedule, cron }, {}, now), false)
    }
    assert.equal(shouldRun({ ...schedule, enabled: false }, {}, now), false)
})

test('failed or interrupted attempts respect cooldown and daily limit, then reset tomorrow', () => {
    assert.equal(shouldRun(schedule, attempt, new Date('2026-10-12T07:29:00Z')), false)
    assert.equal(shouldRun(schedule, attempt, new Date('2026-10-12T07:30:00Z')), true)
    assert.equal(shouldRun(schedule, { ...attempt, attempts: 3 }, new Date('2026-10-12T08:00:00Z')), false)
    assert.equal(shouldRun(schedule, { ...attempt, attempts: 3 }, new Date('2026-10-13T07:00:00Z')), true)
    assert.equal(
        shouldRun(schedule, attempt, new Date('2026-10-12T07:10:00Z'), { retryMinutes: 10, maxAttempts: 1 }),
        false
    )
})

test('state survives reload and corrupt state fails closed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-state-'))
    try {
        const file = path.join(dir, 'state.json')
        writeState(file, attempt)
        assert.deepEqual(readState(file), attempt)
        fs.writeFileSync(file, '{}')
        assert.throws(() => readState(file), /Invalid daily scheduler state/)
        fs.writeFileSync(file, '{')
        assert.throws(() => readState(file))
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test(
    'real shell runner records success once, skips repeat, and retains failed attempt',
    { skip: process.platform === 'win32' ? 'Docker shell integration requires Linux' : false },
    () => {
        const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-runner-'))
        try {
            fs.mkdirSync(path.join(dir, 'scripts/docker'), { recursive: true })
            fs.symlinkSync(path.join(root, 'scripts/api'), path.join(dir, 'scripts/api'))
            const runner = path.join(dir, 'scripts/docker/run_daily.sh')
            fs.writeFileSync(
                runner,
                fs
                    .readFileSync(path.join(root, 'scripts/docker/run_daily.sh'), 'utf8')
                    .replace('cd /usr/src/microsoft-rewards-script', `cd '${dir}'`)
                    .replace('LOCKFILE=/tmp/run_daily.lock', `LOCKFILE='${dir}/lock'`)
                    .replaceAll('/etc/container_env', `${dir}/container_env`)
            )
            const bin = path.join(dir, 'bin')
            fs.mkdirSync(bin)
            fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho run >> "$RUN_LOG"\nexit "${MOCK_EXIT:-0}"\n', {
                mode: 0o755
            })
            const scheduleFile = path.join(dir, 'schedule.json')
            fs.writeFileSync(scheduleFile, JSON.stringify({ enabled: true, cron: '0 0 * * *' }))
            const stateFile = path.join(dir, 'state.json')
            const env = {
                ...process.env,
                PATH: `${bin}:${process.env.PATH}`,
                SCHEDULE_FILE: scheduleFile,
                DAILY_STATE_FILE: stateFile,
                DAILY_TRIGGER: 'catchup',
                TZ: 'UTC',
                SKIP_RANDOM_SLEEP: 'true',
                DAILY_CATCH_UP: 'true',
                DAILY_MAX_ATTEMPTS: '3',
                DAILY_RETRY_MINUTES: '30',
                API_MODE: 'false',
                TASK_RUN_USER: '',
                RUN_LOG: path.join(dir, 'runs')
            }
            const run = () => spawnSync('bash', [runner], { env, encoding: 'utf8', timeout: 10_000 })
            let result = run()
            assert.equal(result.status, 0, result.stderr + result.stdout)
            assert.equal(readState(stateFile).completed, true)
            assert.equal(run().status, 0)
            assert.equal(fs.readFileSync(env.RUN_LOG, 'utf8'), 'run\n')
            writeState(stateFile, { ...attempt, date: '2020-01-01' })
            env.MOCK_EXIT = '1'
            result = run()
            assert.equal(result.status, 1, result.stderr + result.stdout)
            assert.equal(readState(stateFile).completed, false)
            assert.equal(readState(stateFile).attempts, 1)
            assert.equal(run().status, 0) // cooldown, no second execution
            assert.equal(fs.readFileSync(env.RUN_LOG, 'utf8'), 'run\nrun\n')
            assert.equal(fs.existsSync(path.join(dir, 'lock')), false)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    }
)

test('server reset controls the next run across midnight and allows a new cycle on the same date', () => {
    const state = { ...attempt, completed: true, nextStreakResetAt: '2026-10-12T08:00:00.000Z' }
    assert.equal(shouldRun(schedule, state, new Date('2026-10-12T07:59:59Z')), false)
    assert.equal(shouldRun(schedule, state, new Date('2026-10-12T08:00:30Z')), false)
    assert.equal(shouldRun(schedule, state, new Date('2026-10-12T08:01:00Z')), true)
    assert.equal(
        shouldRun(schedule, { ...state, nextStreakResetAt: '2026-10-13T08:00:00Z' }, new Date('2026-10-13T05:00:00Z')),
        false
    )
    const failed = { ...state, completed: false, attempts: 1, lastAttemptAt: '2026-10-12T08:01:00Z' }
    assert.equal(shouldRun(schedule, failed, new Date('2026-10-12T08:10:00Z')), false)
    assert.equal(shouldRun(schedule, failed, new Date('2026-10-12T08:31:00Z')), true)
    assert.equal(shouldRun(schedule, { ...failed, attempts: 3 }, new Date('2026-10-13T05:00:00Z')), false)
})

test('only reports from the current attempt supply a reset timestamp', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-reports-'))
    try {
        fs.writeFileSync(
            path.join(dir, 'tasks-aaaaaaaaaaaa-1.json'),
            JSON.stringify({ startedAt: '2026-10-11T08:00:00Z', nextStreakResetAt: '2026-10-12T08:00:00Z' })
        )
        fs.writeFileSync(
            path.join(dir, 'tasks-aaaaaaaaaaaa-2.json'),
            JSON.stringify({ startedAt: '2026-10-12T08:01:00Z', nextStreakResetAt: '2026-10-13T08:00:00Z' })
        )
        assert.equal(reportResetTime(dir, '2026-10-12T08:00:00Z'), '2026-10-13T08:00:00.000Z')
        assert.equal(reportResetTime(dir, '2026-10-14T08:00:00Z'), null)
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
