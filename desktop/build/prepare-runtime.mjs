import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { copyDesktopBrowsers } from './browser-resources.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(desktop, '..')
const runtime = path.join(desktop, 'runtime')
const browserCache = path.join(desktop, 'browser-cache')
if (process.platform !== 'win32' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) !== 24) {
    throw new Error('Windows 分发包必须使用 Windows x64 的 Node.js 24 构建，不能复制 WSL 依赖')
}
if (!fs.existsSync(path.join(root, 'dist/index.js'))) throw new Error('请先在仓库根目录运行 npm run build')
if (!fs.existsSync(browserCache) && fs.existsSync(path.join(runtime, 'browsers'))) {
    fs.cpSync(path.join(runtime, 'browsers'), browserCache, { recursive: true })
}
fs.rmSync(runtime, { recursive: true, force: true })
fs.mkdirSync(runtime, { recursive: true })
for (const name of [
    'dist',
    'package.json',
    'package-lock.json',
    'config.example.json',
    'config.tasks.example.json',
    'LICENSE'
]) {
    fs.cpSync(path.join(root, name), path.join(runtime, name), { recursive: true })
}
fs.mkdirSync(path.join(runtime, 'scripts/main'), { recursive: true })
fs.mkdirSync(path.join(runtime, 'scripts/api'), { recursive: true })
for (const name of ['package.json', 'env.js', 'utils.js', 'runtimePaths.js'])
    fs.copyFileSync(path.join(root, 'scripts', name), path.join(runtime, 'scripts', name))
for (const name of ['manualLogin.js', 'scanReset.js', 'readResetPage.js'])
    fs.copyFileSync(path.join(root, 'scripts/main', name), path.join(runtime, 'scripts/main', name))
for (const name of fs.readdirSync(path.join(root, 'scripts/api'))) {
    if (name.endsWith('.js') && !name.endsWith('.test.js'))
        fs.copyFileSync(path.join(root, 'scripts/api', name), path.join(runtime, 'scripts/api', name))
}
fs.copyFileSync(process.execPath, path.join(runtime, 'node.exe'))
const npmCli = process.env.npm_execpath
if (!npmCli || !fs.existsSync(npmCli)) throw new Error('请通过 npm run prepare:runtime 执行，以定位 npm CLI')
function run(args, env = process.env) {
    const result = spawnSync(process.execPath, args, { cwd: runtime, env, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`运行环境准备失败：${args.join(' ')}`)
}
run([npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'])
run([path.join(runtime, 'node_modules/patchright/cli.js'), 'install', 'chromium', '--no-shell'], {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browserCache
})
copyDesktopBrowsers(
    browserCache,
    path.join(runtime, 'browsers'),
    JSON.parse(fs.readFileSync(path.join(runtime, 'node_modules/patchright-core/browsers.json'), 'utf8'))
)

// Node's license is included alongside dependency notices for private distribution.
const nodeLicense = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`)
if (!nodeLicense.ok) throw new Error('无法获取对应 Node.js 版本的许可证')
fs.writeFileSync(path.join(runtime, 'NODE-LICENSE.txt'), await nodeLicense.text())
const notices = [
    `Node.js ${process.versions.node}: NODE-LICENSE.txt`,
    'Microsoft Rewards Script: LICENSE (GPL-3.0-or-later)'
]
function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        const target = path.join(directory, entry.name)
        if (entry.name.startsWith('@')) {
            collect(target)
            continue
        }
        const manifest = path.join(target, 'package.json')
        if (fs.existsSync(manifest)) {
            const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
            notices.push(
                `${pkg.name}@${pkg.version}: ${JSON.stringify(pkg.license || 'See package notices')} (${path.relative(runtime, target)})`
            )
        }
        if (fs.existsSync(path.join(target, 'node_modules'))) collect(path.join(target, 'node_modules'))
    }
}
collect(path.join(runtime, 'node_modules'))
fs.mkdirSync(path.join(runtime, 'renderer-licenses'), { recursive: true })
for (const name of ['react', 'react-dom', 'scheduler']) {
    const packageDirectory = path.join(desktop, 'node_modules', name)
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'))
    notices.push(`${pkg.name}@${pkg.version}: ${pkg.license} (renderer-licenses/${name}.txt)`)
    fs.copyFileSync(path.join(packageDirectory, 'LICENSE'), path.join(runtime, 'renderer-licenses', `${name}.txt`))
}
fs.writeFileSync(path.join(runtime, 'THIRD-PARTY-NOTICES.txt'), notices.sort().join('\n') + '\n')
fs.writeFileSync(
    path.join(runtime, 'runtime.json'),
    JSON.stringify(
        {
            node: process.versions.node,
            platform: process.platform,
            arch: process.arch,
            lockSha256: createHash('sha256')
                .update(fs.readFileSync(path.join(root, 'package-lock.json')))
                .digest('hex')
        },
        null,
        2
    )
)
console.log('Windows Node.js、生产依赖和 Patchright 浏览器已准备，未复制任何本地用户数据。')
