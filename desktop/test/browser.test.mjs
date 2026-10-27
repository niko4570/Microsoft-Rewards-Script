import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { default: Browser } = require('../../dist/browser/Browser.js')
const { chromium } = require('patchright')

test('desktop task launcher uses the selected system browser in both modes; ordinary runs retain defaults', async t => {
    const oldEnv = { ...process.env }
    const oldData = process.env.MRS_DATA_DIR
    process.env.MRS_BROWSER_EXECUTABLE = process.execPath
    process.env.MRS_BROWSER_NAME = 'edge'
    t.after(() => {
        for (const key of ['MRS_BROWSER_EXECUTABLE', 'MRS_BROWSER_NAME']) {
            if (oldEnv[key] === undefined) delete process.env[key]
            else process.env[key] = oldEnv[key]
        }
        if (oldData === undefined) delete process.env.MRS_DATA_DIR
        else process.env.MRS_DATA_DIR = oldData
    })
    const launches = []
    const stop = new Error('stop after capturing browser launch')
    t.mock.method(chromium, 'launch', async options => {
        launches.push(options)
        throw stop
    })
    for (const desktop of [true, false]) {
        if (desktop) process.env.MRS_DATA_DIR = 'desktop-test-data'
        else delete process.env.MRS_DATA_DIR
        for (const headless of [true, false]) {
            const browser = new Browser({
                config: { headless, proxy: {} },
                logger: { info() {}, error() {} }
            })
            await assert.rejects(browser.createBrowser({ proxy: { url: '' } }), error => error === stop)
            const options = launches.at(-1)
            assert.equal(options.headless, headless)
            assert.equal(options.channel, desktop ? 'msedge' : undefined)
            assert.equal(options.executablePath, desktop ? process.execPath : undefined)
        }
    }
})
