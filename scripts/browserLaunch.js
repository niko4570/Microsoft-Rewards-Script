import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
export function browserLaunchOptions() {
    if (!process.env.MRS_DATA_DIR) return {}
    const root = process.env.MRS_RESOURCE_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    return require(path.join(root, 'dist/browser/BrowserLaunch.js')).browserLaunchOptions()
}
