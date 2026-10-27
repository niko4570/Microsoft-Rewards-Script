import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { detectBrowsers } from '../lib/browser.mjs'

const require = createRequire(import.meta.url)
const { browserLaunchOptions } = require('../../dist/browser/BrowserLaunch.js')
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const chrome = 'C:\\Users\\测试 用户\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'
function detect(
    preference = 'auto',
    { files = [edge, chrome], progId = 'ChromeHTML', registryError = false, appPath } = {}
) {
    return detectBrowsers(preference, {
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\测试 用户\\AppData\\Local', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
        isFile: file => files.includes(file),
        readRegistry: (key, name) => {
            if (registryError) throw new Error('registry unavailable')
            if (name === 'ProgId') return progId
            return key.endsWith('chrome.exe') ? appPath : null
        }
    })
}

test('automatic selection follows supported defaults, otherwise Edge then Chrome', () => {
    assert.equal(detect().selected.id, 'chrome')
    assert.equal(detect('auto', { progId: 'MSEdgeHTM' }).selected.id, 'edge')
    assert.equal(detect('auto', { progId: 'FirefoxURL' }).selected.id, 'edge')
    assert.equal(detect('auto', { registryError: true }).selected.id, 'edge')
    assert.equal(detect('auto', { files: [chrome], progId: 'MSEdgeHTM' }).selected.id, 'chrome')
    assert.equal(detect('auto', { files: [edge] }).selected.id, 'edge')
    assert.equal(detect('edge').selected.id, 'edge')
})

test('missing or explicitly selected missing browsers never fall back silently', () => {
    assert.equal(detect('chrome', { files: [edge] }).selected, null)
    assert.match(detect('chrome', { files: [edge] }).error, /Chrome/)
    assert.match(detect('auto', { files: [] }).error, /请安装 Chrome 或 Microsoft Edge/)
    assert.equal(detectBrowsers('auto', { platform: 'linux' }).selected, null)
})

test('registry installation paths support spaces and are never interpreted as commands', () => {
    const executablePath = 'D:\\Browsers 测试\\chrome.exe'
    assert.equal(
        detect('chrome', { files: [executablePath], appPath: `"${executablePath}"` }).selected.executablePath,
        executablePath
    )
    assert.equal(
        detect('chrome', { files: [], appPath: `"${executablePath}" --remote-debugging-port=1234` }).selected,
        null
    )
    assert.equal(detect('chrome', { files: ['chrome.exe'], appPath: 'chrome.exe' }).selected, null)
    const beta = 'D:\\Google\\Chrome Beta\\Application\\chrome.exe'
    assert.equal(detect('chrome', { files: [beta], appPath: beta }).selected, null)
})

test('desktop launch requires a valid resolved installation and preserves non-desktop defaults', () => {
    assert.deepEqual(browserLaunchOptions({}), {})
    for (const id of ['chrome', 'edge']) {
        assert.deepEqual(
            browserLaunchOptions({
                MRS_DATA_DIR: '/data',
                MRS_BROWSER_NAME: id,
                MRS_BROWSER_EXECUTABLE: process.execPath
            }),
            {
                executablePath: process.execPath,
                channel: id === 'edge' ? 'msedge' : 'chrome'
            }
        )
    }
    for (const env of [
        {},
        { MRS_BROWSER_EXECUTABLE: process.execPath },
        { MRS_BROWSER_NAME: 'chrome', MRS_BROWSER_EXECUTABLE: '/missing-browser/chrome.exe' },
        { MRS_BROWSER_NAME: 'firefox', MRS_BROWSER_EXECUTABLE: process.execPath },
        { MRS_BROWSER_NAME: 'chrome', MRS_BROWSER_EXECUTABLE: '.' }
    ])
        assert.throws(() => browserLaunchOptions({ ...env, MRS_DATA_DIR: '/data' }), /系统浏览器/)
})
