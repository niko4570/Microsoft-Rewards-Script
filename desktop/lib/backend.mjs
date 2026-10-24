import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { backendEnvironment } from './runtime.mjs'

export async function killTree(pid) {
    if (!pid) return
    if (process.platform === 'win32') {
        await new Promise(resolve => {
            const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
            killer.once('error', resolve)
            killer.once('exit', resolve)
        })
    } else {
        try {
            process.kill(-pid, 'SIGKILL')
        } catch {
            try {
                process.kill(pid, 'SIGKILL')
            } catch {}
        }
    }
}

export class Backend extends EventEmitter {
    constructor({ executable, resourceDirectory, dataDirectory, settings, log }) {
        super()
        Object.assign(this, { executable, resourceDirectory, dataDirectory, settings, log })
        this.child = null
        this.taskPid = null
        this.endpoint = null
        this.closing = false
    }
    async start() {
        if (this.child) throw new Error('后台已启动')
        this.closing = false
        this.token = randomBytes(32).toString('hex')
        this.env = backendEnvironment({ ...this, settings: this.settings(), token: this.token })
        const child = spawn(this.executable, [path.join(this.resourceDirectory, 'scripts/api/server.js')], {
            cwd: this.dataDirectory,
            env: this.env,
            detached: process.platform !== 'win32',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc']
        })
        this.child = child
        child.on('message', message => {
            if (message?.type === 'desktop:status') {
                this.taskPid = message.pid || null
                this.emit('status', message)
            }
        })
        await new Promise((resolve, reject) => {
            let ready = false
            let buffer = ''
            const timeout = setTimeout(() => {
                reject(new Error('后台启动超时（30 秒），请导出诊断日志'))
                void this.close()
            }, 30000)
            child.stdout.on('data', chunk => {
                buffer += chunk.toString()
                let boundary
                while ((boundary = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, boundary)
                    buffer = buffer.slice(boundary + 1)
                    if (line.startsWith('__API_READY__ ')) {
                        try {
                            const info = JSON.parse(line.slice('__API_READY__ '.length))
                            if (
                                info.host !== '127.0.0.1' ||
                                !Number.isInteger(info.port) ||
                                info.port < 1 ||
                                !info.auth
                            )
                                throw new Error('后台就绪信息无效')
                            this.endpoint = `http://127.0.0.1:${info.port}`
                            ready = true
                            clearTimeout(timeout)
                            resolve()
                        } catch (error) {
                            clearTimeout(timeout)
                            reject(error)
                        }
                    } else this.log(line)
                }
            })
            child.stderr.on('data', chunk => this.log(chunk.toString()))
            child.once('error', error => {
                clearTimeout(timeout)
                this.child = null
                this.endpoint = null
                reject(error)
                this.log(`后台无法启动：${error.message}`)
            })
            child.once('exit', (code, signal) => {
                clearTimeout(timeout)
                this.child = null
                this.endpoint = null
                const pid = this.taskPid
                this.taskPid = null
                void killTree(pid)
                if (!ready) reject(new Error(`后台启动失败（${code ?? signal}）`))
                if (!this.closing) this.emit('failure', `后台已退出（${code ?? signal}），请重启后台`)
            })
        })
    }
    async request(route, method = 'GET', body) {
        if (!this.endpoint) throw new Error('后台尚未就绪，请重启后台')
        const response = await fetch(this.endpoint + route, {
            method,
            headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(10000)
        })
        const value = await response.json()
        if (!response.ok) throw new Error(value.error || `后台请求失败：${response.status}`)
        return value
    }
    async close() {
        this.closing = true
        const child = this.child
        if (!child) return
        const exit = new Promise(resolve => {
            child.once('exit', resolve)
            child.once('error', resolve)
        })
        try {
            if (child.connected) child.send({ type: 'desktop:shutdown' }, () => {})
        } catch {}
        let timer
        const timeout = new Promise(resolve => {
            timer = setTimeout(resolve, 17000)
        })
        await Promise.race([exit, timeout])
        clearTimeout(timer)
        if (this.child) {
            await killTree(this.taskPid)
            await killTree(child.pid)
            await exit
        }
        this.endpoint = null
        this.taskPid = null
    }
}
