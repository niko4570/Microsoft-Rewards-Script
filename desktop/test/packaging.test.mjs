import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyDesktopBrowsers } from '../build/browser-resources.mjs'

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
