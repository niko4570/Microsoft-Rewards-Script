import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { initializeData } from '../lib/data.mjs'
import { backendEnvironment } from '../lib/runtime.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const entry = path.join(root, 'scripts/main/manualLogin.js')

async function runLogin(t, script, args) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'Rewards 首次登录 '))
    const settings = initializeData(data, path.join(root, 'config.tasks.example.json'))
    settings.email = 'local@rewards.invalid'
    const child = spawn(process.execPath, [script, ...args], {
        cwd: data,
        env: backendEnvironment({
            dataDirectory: data,
            resourceDirectory: root,
            settings,
            token: '',
            // A real executable that rejects Chromium flags: stop before any
            // navigation, while exercising the actual fresh-login entry point.
            browser: { id: 'chrome', executablePath: process.execPath }
        }),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    })
    const closed = new Promise(resolve => child.once('close', resolve))
    t.after(async () => {
        if (child.exitCode === null) child.kill()
        await closed
        fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill()
            reject(new Error(`Login entry stalled without exiting: ${stdout}\n${stderr}`))
        }, 15000)
        child.once('error', error => {
            clearTimeout(timer)
            reject(error)
        })
        child.once('close', code => {
            clearTimeout(timer)
            resolve({ code, stdout, stderr, data })
        })
    })
}

for (const [name, script] of [
    ['ordinary path', entry],
    ...(process.platform === 'win32' ? [['Windows namespaced path', path.toNamespacedPath(entry)]] : [])
]) {
    test(`real manual login with IPC enters and exits through ${name}`, async t => {
        const help = await runLogin(t, script, ['--help'])
        assert.equal(help.code, 0, help.stderr)
        assert.match(help.stdout, /Microsoft Rewards manual login/)

        const fresh = await runLogin(t, script, ['--email', 'local@rewards.invalid', '--platform', 'both'])
        assert.equal(fresh.code, 1, fresh.stderr)
        assert.match(fresh.stdout, /Opening mobile manual login/)
        assert.match(fresh.stdout, /Existing cookies: 0/)
        assert.match(fresh.stdout, /manualLogin failed: browserType\.launch/)
        assert.equal(fs.existsSync(path.join(fresh.data, 'sessions/sessions.db')), false)
    })
}
