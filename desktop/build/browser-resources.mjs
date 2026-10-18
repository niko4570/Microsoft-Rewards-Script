import fs from 'node:fs'
import path from 'node:path'

// Copy only the locked full Chromium and its helpers. Build caches can still
// contain headless shells and older revisions from previous desktop versions.
export function copyDesktopBrowsers(cache, destination, manifest) {
    const names = ['chromium', 'ffmpeg', 'winldd']
    const directories = names.map(name => {
        const browser = manifest.browsers.find(browser => browser.name === name)
        if (!browser || !/^\d+$/.test(browser.revision)) throw new Error(`浏览器清单无效：${name}`)
        const directory = `${name}-${browser.revision}`
        if (!fs.statSync(path.join(cache, directory), { throwIfNoEntry: false })?.isDirectory()) {
            throw new Error(`缺少浏览器资源：${directory}`)
        }
        return directory
    })
    fs.mkdirSync(destination, { recursive: true })
    for (const directory of directories) {
        fs.cpSync(path.join(cache, directory), path.join(destination, directory), { recursive: true })
    }
}
