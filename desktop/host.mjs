import path from 'node:path'
import readline from 'node:readline'
import { DesktopService } from './lib/service.mjs'
import { DesktopHost } from './lib/host.mjs'

const [resourceDirectory, dataDirectory, version] = process.argv.slice(2)
if (
    !resourceDirectory ||
    !dataDirectory ||
    !version ||
    !path.isAbsolute(resourceDirectory) ||
    !path.isAbsolute(dataDirectory)
)
    throw new Error('桌面服务需要绝对资源目录、数据目录和版本号')

const send = value => process.stdout.write(JSON.stringify(value) + '\n')
// Keep stdout exclusively for the framed protocol.
console.log = (...values) => console.error(...values)
const pending = new Map()
let nextId = 0
let closing = false
function native(action, value) {
    return new Promise((resolve, reject) => {
        const id = ++nextId
        pending.set(id, { resolve, reject })
        send({ native: { id, action, value } })
    })
}

const service = new DesktopService({
    executable: process.execPath,
    resourceDirectory,
    dataDirectory,
    version,
    setAutoStart: enabled => native('setAutoStart', enabled)
})
const host = new DesktopHost({ service, native, version, publish: value => send({ event: 'desktop:state', value }) })
const ready = (async () => {
    await native('syncAutoStart', service.settings.startOnLogin)
    await service.start()
    await host.refresh()
})()
// Install a rejection handler immediately; commands still receive the error.
ready.catch(error => send({ event: 'desktop:error', value: error.message }))

const timer = setInterval(() => {
    if (!closing) void ready.then(() => host.refresh()).catch(() => {})
}, 1500)
let lastWake = Date.now()
const wakeTimer = setInterval(() => {
    const now = Date.now()
    if (now - lastWake > 30000 || now < lastWake) service.scheduler.reset()
    lastWake = now
}, 10000)

async function close() {
    if (closing) return
    closing = true
    clearInterval(timer)
    clearInterval(wakeTimer)
    for (const request of pending.values()) request.reject(new Error('桌面外壳已断开'))
    pending.clear()
    await ready.catch(() => {})
    await service.close()
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', line => {
    void (async () => {
        let request
        try {
            request = JSON.parse(line)
            if (Object.hasOwn(request, 'nativeResult')) {
                const promise = pending.get(request.nativeResult)
                pending.delete(request.nativeResult)
                if (request.error) promise?.reject(new Error(request.error))
                else promise?.resolve(request.value)
                return
            }
            if (!Number.isSafeInteger(request.id)) throw new Error('无效请求编号')
            if (request.action === 'shutdown') {
                await close()
                send({ id: request.id, value: null })
                input.close()
                process.stdin.destroy()
                return
            }
            if (closing) throw new Error('应用正在退出')
            await ready
            send({ id: request.id, value: await host.invoke(request.action, request.value) })
        } catch (error) {
            send({ id: request?.id ?? null, error: error.message })
        }
    })()
})
input.on('close', () => void close().then(() => process.exit(0)))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void close().then(() => process.exit(0)))
