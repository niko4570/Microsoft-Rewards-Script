import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const releaseRepository = 'niko4570/Microsoft-Rewards-Script'
const versionParts = value => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)?.slice(1).map(Number)
export function compareVersions(left, right) {
    const a = versionParts(left)
    const b = versionParts(right)
    if (!a || !b) throw new Error('无法识别桌面版本号')
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
    return 0
}

function assetURL(asset, tag) {
    const url = new URL(asset.browser_download_url)
    const prefix = `https://github.com/${releaseRepository}/releases/download/${encodeURIComponent(tag)}/`
    if (!url.href.startsWith(prefix) || url.username || url.password || url.search || url.hash) {
        throw new Error('更新文件地址不属于本项目的 GitHub Release')
    }
    return url.href
}

export class DesktopUpdater {
    constructor({ version, fetch: fetcher = globalThis.fetch, onChange = () => {} }) {
        this.version = version
        this.fetch = fetcher
        this.onChange = onChange
        this.state = { status: 'idle', version: null, progress: 0, error: null, filePath: null }
        this.release = null
        this.busy = false
    }

    setState(value) {
        this.state = { ...this.state, ...value }
        this.onChange()
    }

    async request(url, timeout = 30000) {
        const response = await this.fetch(url, {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Rewards-Desktop/${this.version}` },
            signal: AbortSignal.timeout(timeout)
        })
        if (!response.ok) {
            if (response.status === 403 || response.status === 429) throw new Error('GitHub 请求受限，请稍后重试')
            throw new Error(`GitHub 请求失败（HTTP ${response.status}），请检查网络后重试`)
        }
        return response
    }

    async check() {
        if (this.busy || this.state.status === 'installing') throw new Error('正在检查、下载或安装更新，请稍候')
        this.busy = true
        this.release = null
        this.setState({ status: 'checking', error: null, version: null, progress: 0, filePath: null })
        try {
            let selected = null
            for (let page = 1; ; page++) {
                if (page > 10) throw new Error('发布记录过多，无法完成版本检查，请稍后重试')
                const response = await this.request(
                    `https://api.github.com/repos/${releaseRepository}/releases?per_page=100&page=${page}`
                )
                const releases = await response.json()
                if (!Array.isArray(releases)) throw new Error('GitHub 返回的发布信息无效')
                for (const release of releases) {
                    const version = /^desktop-v(.+)$/.exec(release.tag_name)?.[1]
                    if (release.draft || release.prerelease || !versionParts(version)) continue
                    if (compareVersions(version, this.version) <= 0) continue
                    if (!selected || compareVersions(version, selected.version) > 0) selected = { ...release, version }
                }
                if (!response.headers.get('link')?.includes('rel="next"')) break
            }
            if (!selected) {
                this.setState({ status: 'latest' })
                return
            }
            const name = `Rewards-Desktop-${selected.version}-x64.exe`
            const asset = selected.assets?.find(item => item.name === name && item.state === 'uploaded')
            if (!asset) throw new Error(`v${selected.version} 的安装包尚未发布完整，请稍后重试`)
            this.release = {
                version: selected.version,
                name,
                size: asset.size,
                url: assetURL(asset, selected.tag_name)
            }
            this.setState({ status: 'available', version: selected.version })
        } catch (error) {
            this.setState({ status: 'error', error: error.message })
            throw error
        } finally {
            this.busy = false
        }
    }

    async download(choosePath) {
        if (this.busy || this.state.status === 'installing') throw new Error('正在检查、下载或安装更新，请稍候')
        if (!this.release) throw new Error('请先检查更新')
        this.busy = true
        let temporary
        try {
            const release = this.release
            const destination = await choosePath(release.name)
            if (!destination) return false
            this.setState({ status: 'downloading', progress: 0, error: null, filePath: null })
            const response = await this.request(release.url, 30 * 60 * 1000)
            if (!response.body) throw new Error('下载内容为空')
            temporary = path.join(path.dirname(destination), `.rewards-update-${randomUUID()}.part`)
            let received = 0
            let lastProgress = -1
            const track = new Transform({
                transform: (chunk, _encoding, callback) => {
                    received += chunk.length
                    const progress = release.size > 0 ? Math.min(99, Math.floor((received / release.size) * 100)) : 0
                    if (progress !== lastProgress) {
                        lastProgress = progress
                        this.setState({ progress })
                    }
                    callback(null, chunk)
                }
            })
            await pipeline(Readable.fromWeb(response.body), track, fs.createWriteStream(temporary, { flags: 'wx' }))
            if (release.size > 0 && received !== release.size) {
                throw new Error('安装包下载不完整，请重新下载')
            }
            await fs.promises.rename(temporary, destination)
            temporary = null
            this.setState({ status: 'downloaded', progress: 100, filePath: destination })
            return true
        } catch (error) {
            this.setState({ status: 'available', error: error.message })
            throw error
        } finally {
            if (temporary) await fs.promises.rm(temporary, { force: true }).catch(() => {})
            this.busy = false
        }
    }

    async install(launch) {
        if (this.busy || this.state.status === 'installing') throw new Error('正在检查、下载或安装更新，请稍候')
        if (this.state.status !== 'downloaded' || !this.state.filePath) throw new Error('请先下载安装包')
        this.busy = true
        try {
            const stat = await fs.promises.stat(this.state.filePath)
            if (!stat.isFile() || (this.release?.size > 0 && stat.size !== this.release.size))
                throw new Error('安装包下载不完整，请重新检查更新并下载')
            this.setState({ status: 'installing', error: null })
            await launch(this.state.filePath)
            return true
        } catch (error) {
            this.setState({ status: 'downloaded', error: error.message })
            throw error
        } finally {
            this.busy = false
        }
    }
}
