import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyDesktopBrowsers } from '../build/browser-resources.mjs'
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

test('desktop browser resources exclude cached shells and older Chromium revisions', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'Rewards browser resources '))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const cache = path.join(directory, 'cache')
    const destination = path.join(directory, 'browsers')
    const wanted = ['chromium-1228', 'ffmpeg-1011', 'winldd-1007']
    for (const name of [...wanted, 'chromium_headless_shell-1228', 'chromium-1200', 'firefox-1532']) {
        fs.mkdirSync(path.join(cache, name), { recursive: true })
        fs.writeFileSync(path.join(cache, name, 'binary'), name)
    }
    const manifest = {
        browsers: [
            { name: 'chromium', revision: '1228' },
            { name: 'chromium-headless-shell', revision: '1228' },
            { name: 'ffmpeg', revision: '1011' },
            { name: 'winldd', revision: '1007' }
        ]
    }
    copyDesktopBrowsers(cache, destination, manifest)
    assert.deepEqual(fs.readdirSync(destination).sort(), wanted.sort())
    for (const name of wanted) assert.equal(fs.readFileSync(path.join(destination, name, 'binary'), 'utf8'), name)
    assert.throws(
        () => copyDesktopBrowsers(cache, destination, { browsers: [{ name: 'chromium', revision: '9999' }] }),
        /缺少浏览器资源：chromium-9999/
    )
})
