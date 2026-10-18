import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../release')
const files = fs
    .readdirSync(directory)
    .filter(name => /\.(exe|zip)$/.test(name))
    .sort()
if (!files.length) throw new Error('没有可校验的 Windows 发布产物')
fs.writeFileSync(
    path.join(directory, 'SHA256SUMS.txt'),
    files
        .map(
            name =>
                `${createHash('sha256')
                    .update(fs.readFileSync(path.join(directory, name)))
                    .digest('hex')}  ${name}`
        )
        .join('\n') + '\n'
)
