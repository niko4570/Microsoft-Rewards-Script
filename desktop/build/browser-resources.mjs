import fs from 'node:fs'
import path from 'node:path'

export function assertNoBundledBrowser(runtime) {
    for (const relative of [
        'browsers',
        'node_modules/patchright-core/.local-browsers',
        'node_modules/playwright-core/.local-browsers'
    ]) {
        if (fs.existsSync(path.join(runtime, relative))) throw new Error(`桌面包不应携带浏览器资源：${relative}`)
    }
}
