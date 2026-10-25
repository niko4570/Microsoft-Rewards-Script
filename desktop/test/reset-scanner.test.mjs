import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fork } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))

// Exercise the actual scanner entry point and IPC lifecycle, without a live
// account or browser. Real page parsing runs against synthetic server HTML.
async function scan(t, { balanceOnly = false, fail = false } = {}) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-scanner-'))
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
    const objects = [
        { balance: 123, level: 1 },
        { partner: 'dailyset', dailyPoints: [5], isCurrentDayCompleted: true },
        { prefix: '每日连胜', expiresAt: new Date(Date.now() + 86400000).toISOString() }
    ]
    const html = `<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify(objects))}])</script>`
    const modules = {
        patchright: `export const chromium = { async launch() { return {
            async close() { console.log('browser closed') },
            async newContext() { return { async newPage() { return {
                async goto() {
                    if (${fail}) throw new Error('synthetic connection failure')
                    return { ok: () => true, text: async () => ${JSON.stringify(html)} }
                },
                url: () => 'https://rewards.bing.com/earn'
            } } } }
        } } }`,
        'fingerprint-injector': 'export const newInjectedContext = () => { throw new Error("unexpected fingerprint") }',
        '../utils.js': `export const getSessionDbPath = () => ({ dbPath: 'unused', exists: true });
            export const openSessionDb = () => ({});
            export const closeSessionDb = () => {};
            export const loadSessionRow = () => ({ storageState: {} });`
    }
    const preload = path.join(temporary, 'preload.mjs')
    fs.writeFileSync(
        preload,
        `import { registerHooks } from 'node:module';
        const modules = ${JSON.stringify(modules)};
        registerHooks({ resolve(specifier, context, next) {
            if (context.parentURL?.endsWith('/scripts/main/scanReset.js') && specifier in modules)
                return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]) };
            return next(specifier, context);
        } });`
    )
    const child = fork(path.join(root, 'scripts/main/scanReset.js'), balanceOnly ? ['--balance'] : [], {
        execArgv: ['--import', pathToFileURL(preload).href],
        env: { ...process.env, MRS_RESOURCE_DIR: root, ACCOUNT_1_EMAIL: 'test@example.com' },
        silent: true
    })
    t.after(() => {
        if (child.exitCode === null) child.kill()
    })
    const messages = []
    let output = ''
    child.on('message', message => messages.push(message))
    child.stdout.on('data', chunk => {
        output += chunk
    })
    child.stderr.on('data', chunk => {
        output += chunk
    })
    const code = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
    })
    return { code, messages, output }
}

for (const balanceOnly of [false, true]) {
    test(
        `successful ${balanceOnly ? 'balance' : 'reset'} scan disconnects with exit 0`,
        { timeout: 10000 },
        async t => {
            const { code, messages, output } = await scan(t, { balanceOnly })
            assert.equal(code, 0, output)
            assert.equal(messages.length, 1)
            assert.equal(messages[0].type, 'desktop:reset')
            assert.equal(messages[0].balance, 123)
            if (!balanceOnly) assert.ok(Date.parse(messages[0].nextStreakResetAt) > Date.now())
            assert.equal(output.match(/browser closed/g)?.length, 1, output)
        }
    )
}

test('failed scan sends its cause and keeps exit 1 on disconnect', { timeout: 10000 }, async t => {
    const { code, messages, output } = await scan(t, { fail: true })
    assert.equal(code, 1, output)
    assert.deepEqual(messages, [{ type: 'desktop:reset-error', error: 'synthetic connection failure' }])
    assert.equal(output.match(/browser closed/g)?.length, 1, output)
})
