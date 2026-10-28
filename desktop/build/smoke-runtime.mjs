import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertNoBundledBrowser } from './browser-resources.mjs'
import { detectBrowsers } from '../lib/browser.mjs'
import { Backend } from '../lib/backend.mjs'
import { defaults, initializeData } from '../lib/data.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = process.argv[2] ? path.resolve(process.argv[2]) : path.join(desktop, 'runtime')
const executable = path.join(runtime, 'node.exe')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'Rewards 桌面 smoke '))
let backend
try {
    assertNoBundledBrowser(runtime)
    const browsers = detectBrowsers().installed
    if (!browsers.length) throw new Error('构建验收需要已安装的 Chrome 或 Edge')
    if (process.env.MRS_REQUIRE_BOTH_BROWSERS === '1' && browsers.length !== 2)
        throw new Error('CI 验收要求同时安装 Chrome 和 Edge')
    initializeData(data, path.join(runtime, 'config.tasks.example.json'))
    // Load the actual login entry point without opening a browser or using an account.
    // Run from isolated user data without inherited Node injection settings.
    for (const script of ['manualLogin.js', 'scanReset.js']) {
        const login = spawnSync(executable, [path.join(runtime, 'scripts/main', script), '--help'], {
            cwd: data,
            env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
            stdio: 'inherit',
            timeout: 30000
        })
        if (login.error) throw login.error
        if (login.status !== 0) throw new Error('手动登录入口依赖检查失败')
    }
    const probe = `
        const { createRequire } = require('node:module');
        const requireRuntime = createRequire(${JSON.stringify(path.join(runtime, 'package.json'))});
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE probe (id INTEGER)'); db.close();
        const dependencies = requireRuntime('./package.json').dependencies;
        const path = require('node:path');
        const modules = ${JSON.stringify(path.join(runtime, 'node_modules'))};
        for (const name of Object.keys(dependencies)) {
            const relative = path.relative(modules, requireRuntime.resolve(name));
            if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
                throw new Error('Dependency resolved outside bundled node_modules: ' + name);
            }
        }
        requireRuntime('impit');
        const { chromium } = requireRuntime('patchright');
        (async () => {
            for (const selected of ${JSON.stringify(browsers)}) {
            for (const headless of [false, true]) {
                console.log(selected.name, 'headless=' + headless, 'starting');
                const options = requireRuntime('./dist/browser/BrowserLaunch.js').browserLaunchOptions({ MRS_DATA_DIR: ${JSON.stringify(data)}, MRS_BROWSER_EXECUTABLE: selected.executablePath, MRS_BROWSER_NAME: selected.id });
                const browser = await chromium.launch({ ...options, headless });
                try {
                    const page = await browser.newPage();
                    await page.goto('data:text/html,<title>system browser</title>');
                    if (await page.title() !== 'system browser') throw new Error('Browser page probe failed');
                    if (await page.evaluate(() => 6 * 7) !== 42) throw new Error('Browser script probe failed');
                    console.log(selected.name, browser.version(), 'headless=' + headless, 'PASS');
                } finally {
                    await browser.close();
                    console.log(selected.name, 'headless=' + headless, 'closed');
                }
            }
            }
            console.log('SQLite, native dependencies and system browsers (headed/headless): PASS');
        })().catch(error => { console.error(error); process.exit(1) });
    `
    const result = spawnSync(executable, ['-e', probe], {
        cwd: data,
        env: {
            ...process.env,
            NODE_PATH: '',
            NODE_OPTIONS: '',
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1'
        },
        stdio: 'inherit',
        // Four sequential browser lifecycles share this deadline, including
        // Windows process cleanup after each otherwise successful probe.
        timeout: 180000
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error('Windows 运行依赖检查失败')
    backend = new Backend({
        executable,
        resourceDirectory: runtime,
        dataDirectory: data,
        settings: () => defaults,
        log: line => console.log(line)
    })
    await backend.start()
    const health = await backend.request('/health')
    const sessions = await backend.request('/sessions')
    if (!health.ok || !health.authRequired || sessions.count !== 0) throw new Error('API 或空数据目录检查失败')
    const unauthorized = await fetch(backend.endpoint + '/health')
    if (unauthorized.status !== 401) throw new Error('API 鉴权检查失败')
    console.log('Isolated API startup, random port and authentication: PASS')
} finally {
    await backend?.close()
    fs.rmSync(data, { recursive: true, force: true })
}
