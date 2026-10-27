import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertNoBundledBrowser } from '../build/browser-resources.mjs'
import { normalizeZipTimestamps } from '../build/zip-timestamps.mjs'

test('ZIP packaging clamps old dates without changing contents or valid dates', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'Rewards ZIP timestamps '))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const licenses = path.join(directory, 'backend', 'native-licenses')
    fs.mkdirSync(licenses, { recursive: true })
    const old = path.join(licenses, 'license-mit')
    const valid = path.join(directory, 'LICENSE')
    const accessed = new Date(2020, 0, 1)
    const current = new Date(2026, 9, 25, 12)
    for (const file of [old, valid]) fs.writeFileSync(file, 'license contents\n')
    fs.utimesSync(old, accessed, new Date(1973, 10, 30))
    fs.utimesSync(valid, accessed, current)
    fs.utimesSync(licenses, accessed, new Date(1973, 10, 30))

    normalizeZipTimestamps(directory)

    assert.equal(+fs.statSync(old).mtime, +new Date(1980, 0, 1))
    assert.equal(+fs.statSync(licenses).mtime, +new Date(1980, 0, 1))
    assert.equal(+fs.statSync(valid).mtime, +current)
    for (const file of [old, valid]) {
        assert.equal(+fs.statSync(file).atime, +accessed)
        assert.equal(fs.readFileSync(file, 'utf8'), 'license contents\n')
    }
})

test('desktop packaging rejects browser resources, including hidden dependency caches', t => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'system-browser-package-'))
    t.after(() => fs.rmSync(runtime, { recursive: true, force: true }))
    assert.doesNotThrow(() => assertNoBundledBrowser(runtime))
    for (const relative of [
        'browsers',
        'node_modules/patchright-core/.local-browsers',
        'node_modules/playwright-core/.local-browsers'
    ]) {
        const directory = path.join(runtime, relative)
        fs.mkdirSync(directory, { recursive: true })
        assert.throws(() => assertNoBundledBrowser(runtime), /不应携带浏览器/)
        fs.rmSync(directory, { recursive: true })
    }
})
