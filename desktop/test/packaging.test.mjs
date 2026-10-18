import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { copyDesktopBrowsers } from '../build/browser-resources.mjs'

const require = createRequire(import.meta.url)
const { getFileMatchers, copyFiles } = require('app-builder-lib/out/fileMatcher.js')
const { build } = require('../package.json')

test('extraResources copies backend dependencies, including scoped and nested packages', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'Rewards packaging 测试 '))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const project = path.join(directory, 'desktop')
    const resources = path.join(directory, 'resources')
    const files = [
        'package.json',
        'scripts/main/manualLogin.js',
        'node_modules/fingerprint-generator/package.json',
        'node_modules/@scope/native/addon.node',
        'node_modules/fingerprint-generator/node_modules/nested/index.js'
    ]
    for (const file of files) {
        const target = path.join(project, 'runtime', file)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, file)
    }
    fs.writeFileSync(path.join(directory, 'LICENSE'), 'license')
    const matchers = getFileMatchers(build, 'extraResources', resources, {
        defaultSrc: project,
        macroExpander: value => value,
        customBuildOptions: {},
        globalOutDir: path.join(project, 'release')
    })
    await copyFiles(matchers)
    for (const file of files) {
        assert.equal(fs.readFileSync(path.join(resources, 'backend', file), 'utf8'), file)
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
