import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { normalizeZipTimestamps } from './zip-timestamps.mjs'

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('请在 Windows x64 上构建安装包')
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const release = path.join(desktop, 'release')
const version = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).version
function run(script, args = []) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: desktop, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`构建步骤失败：${script}`)
}
run(path.join(desktop, 'build/prepare-runtime.mjs'))
run(path.join(desktop, 'build/smoke-runtime.mjs'))
run(path.join(desktop, 'build/prepare-native-notices.mjs'))
run(path.join(desktop, 'node_modules/@tauri-apps/cli/tauri.js'), [
    'build',
    '--config',
    'src-tauri/tauri.bundle.conf.json',
    '--features',
    'custom-protocol',
    '--no-bundle',
    '--',
    '--locked'
])
const target = path.join(desktop, 'src-tauri/target/release')
fs.mkdirSync(release, { recursive: true })
const portable = path.join(release, 'portable')
fs.rmSync(portable, { recursive: true, force: true })
fs.mkdirSync(portable)
fs.copyFileSync(path.join(target, 'Rewards Desktop.exe'), path.join(portable, 'Rewards Desktop.exe'))
fs.cpSync(path.join(desktop, 'runtime'), path.join(portable, 'backend'), { recursive: true })
fs.copyFileSync(path.join(desktop, '../LICENSE'), path.join(portable, 'LICENSE'))
// Fail UI checks before spending time compressing an installer and archive.
run(path.join(desktop, 'build/packaged-smoke.mjs'))
run(path.join(desktop, 'node_modules/@tauri-apps/cli/tauri.js'), [
    'bundle',
    '--config',
    'src-tauri/tauri.bundle.conf.json',
    '--features',
    'custom-protocol',
    '--bundles',
    'nsis'
])
const installers = fs
    .readdirSync(path.join(target, 'bundle/nsis'))
    .filter(name => name.endsWith('.exe') && name.includes(version))
if (installers.length !== 1) throw new Error('找不到唯一的当前版本安装程序')
fs.mkdirSync(release, { recursive: true })
fs.copyFileSync(
    path.join(target, 'bundle/nsis', installers[0]),
    path.join(release, `Rewards-Desktop-${version}-x64.exe`)
)
normalizeZipTimestamps(portable)
const quote = value => "'" + value.replaceAll("'", "''") + "'"
const zip = spawnSync(
    'powershell.exe',
    [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference = 'Stop'; Compress-Archive -Path ${quote(path.join(portable, '*'))} -DestinationPath ${quote(path.join(release, `Rewards-Desktop-${version}-x64.zip`))} -Force`
    ],
    { stdio: 'inherit' }
)
if (zip.error) throw zip.error
if (zip.status !== 0) throw new Error('便携 ZIP 打包失败')
run(path.join(desktop, 'build/checksums.mjs'))
