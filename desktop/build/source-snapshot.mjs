import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const destination = path.join(root, 'desktop/windows-source')
const listing = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8'
})
if (listing.status !== 0) throw new Error('无法列出对应源码文件')
fs.rmSync(destination, { recursive: true, force: true })
fs.mkdirSync(destination, { recursive: true })
const files = [...new Set(listing.stdout.split('\0').filter(Boolean))]
for (const name of files) {
    if (/^(config|sessions|reports|diagnostics|node_modules|dist)\//.test(name)) continue
    if (/^desktop\/(windows-source|runtime|release|out|node_modules|browser-cache)\//.test(name)) continue
    if (/^(?:.*\/)?(?:\.env(?:\..*)?|config\.json|accounts\.(?:dev|main)\.json)$/.test(name)) continue
    const source = path.join(root, name)
    if (!fs.existsSync(source) || !fs.lstatSync(source).isFile()) continue
    const target = path.join(destination, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
}
console.log(`Source snapshot without user data: ${destination}`)
