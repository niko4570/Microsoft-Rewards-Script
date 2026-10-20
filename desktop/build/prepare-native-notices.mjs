import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = path.join(desktop, 'runtime')
const metadata = spawnSync(
    'cargo',
    ['metadata', '--manifest-path', path.join(desktop, 'src-tauri/Cargo.toml'), '--format-version', '1', '--locked'],
    {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024
    }
)
if (metadata.error) throw metadata.error
if (metadata.status !== 0) throw new Error(metadata.stderr || '无法读取 Rust 依赖许可证')
const notices = []
for (const pkg of JSON.parse(metadata.stdout).packages) {
    const directory = path.dirname(pkg.manifest_path)
    const destination = path.join(runtime, 'native-licenses', `${pkg.name}-${pkg.version}`)
    const files = new Set(fs.readdirSync(directory).filter(name => /^(LICENSE|COPYING|NOTICE|UNLICENSE)/i.test(name)))
    if (pkg.license_file) files.add(pkg.license_file)
    fs.mkdirSync(destination, { recursive: true })
    for (const name of files) {
        const source = path.join(directory, name)
        if (fs.statSync(source).isFile()) fs.copyFileSync(source, path.join(destination, path.basename(name)))
    }
    notices.push(
        `${pkg.name}@${pkg.version}: ${pkg.license || 'See package notices'} (native-licenses/${pkg.name}-${pkg.version})`
    )
}
fs.writeFileSync(path.join(runtime, 'NATIVE-THIRD-PARTY-NOTICES.txt'), notices.sort().join('\n') + '\n')
