import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') throw new Error('Windows packaged smoke test requires Windows')
const directory = path.dirname(fileURLToPath(import.meta.url))
const resources = path.resolve(directory, '../release/win-unpacked/resources/backend')
const result = spawnSync(process.execPath, [path.join(directory, 'smoke-runtime.mjs'), resources], {
    stdio: 'inherit',
    timeout: 120000
})
if (result.error) throw result.error
if (result.status !== 0) throw new Error('打包后的后端运行依赖检查失败')
process.env.MRS_PACKAGED_EXECUTABLE = path.resolve(directory, '../release/win-unpacked/Rewards Desktop.exe')
await import('./ui-smoke.mjs')
