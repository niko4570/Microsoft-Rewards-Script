import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DesktopUpdater, compareVersions, releaseRepository } from '../lib/updater.mjs'

const payload = Buffer.from('test installer')
const digest = createHash('sha256').update(payload).digest('hex')
function release(version, overrides = {}) {
    const tag = `desktop-v${version}`
    const asset = name => ({
        name,
        state: 'uploaded',
        size: payload.length,
        browser_download_url: `https://github.com/${releaseRepository}/releases/download/${tag}/${name}`
    })
    return {
        tag_name: tag,
        assets: [asset(`Rewards-Desktop-${version}-x64.exe`), asset('SHA256SUMS.txt')],
        ...overrides
    }
}
function updater(releases, sums = digest, body = payload) {
    return new DesktopUpdater({
        version: '0.1.8',
        fetch: async url => {
            if (url.includes('api.github.com')) return Response.json(releases)
            if (url.endsWith('SHA256SUMS.txt')) return new Response(`${sums}  Rewards-Desktop-0.1.10-x64.exe\n`)
            return new Response(body)
        }
    })
}

test('selects highest desktop version across pages, ignoring script releases, drafts and prereleases', async () => {
    assert.equal(compareVersions('0.1.10', '0.1.9'), 1)
    const instance = new DesktopUpdater({
        version: '0.1.8',
        fetch: async url => {
            const first = url.endsWith('page=1')
            return Response.json(
                first
                    ? [
                          release('0.1.9'),
                          { tag_name: 'v4.3.2' },
                          release('9.0.0', { draft: true }),
                          release('8.0.0', { prerelease: true })
                      ]
                    : [release('0.1.10')],
                {
                    headers: first ? { link: '<next>; rel="next"' } : {}
                }
            )
        }
    })
    await instance.check()
    assert.equal(instance.state.version, '0.1.10')
    assert.equal(instance.state.status, 'available')
    const current = updater([release('0.1.8'), release('0.1.7')])
    await current.check()
    assert.equal(current.state.status, 'latest')
})

test('downloads and verifies installer, supports cancel and cleans corrupt downloads without overwriting files', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-update-test-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const destination = path.join(directory, 'installer.exe')
    const instance = updater([release('0.1.10')])
    await instance.check()
    assert.equal(await instance.download(async () => null), false)
    assert.equal(instance.state.status, 'available')
    await instance.download(async () => destination)
    assert.deepEqual(fs.readFileSync(destination), payload)
    assert.equal(instance.state.progress, 100)
    assert.equal(instance.state.filePath, destination)
    const corrupt = updater([release('0.1.10')], '0'.repeat(64))
    await corrupt.check()
    await assert.rejects(
        corrupt.download(async () => destination),
        /校验失败/
    )
    assert.deepEqual(fs.readFileSync(destination), payload)
    assert.deepEqual(fs.readdirSync(directory), ['installer.exe'])
    assert.equal(corrupt.state.status, 'available')
})

test('rejects missing assets, foreign download URLs, rate limits and concurrent requests', async () => {
    const missing = updater([release('0.1.10', { assets: [] })])
    await assert.rejects(missing.check(), /尚未发布完整/)
    const foreignRelease = release('0.1.10')
    foreignRelease.assets[0].browser_download_url = 'https://example.com/installer.exe'
    await assert.rejects(updater([foreignRelease]).check(), /不属于本项目/)
    const limited = new DesktopUpdater({ version: '0.1.8', fetch: async () => new Response('', { status: 403 }) })
    await assert.rejects(limited.check(), /请求受限/)
    assert.equal(limited.state.status, 'error')
    const instance = updater([release('0.1.10')])
    await instance.check()
    let finish
    const downloading = instance.download(
        () =>
            new Promise(resolve => {
                finish = resolve
            })
    )
    await assert.rejects(instance.check(), /请稍候/)
    await assert.rejects(
        instance.download(async () => null),
        /请稍候/
    )
    finish(null)
    await downloading
})

test('installation rechecks the cached checksum, retains retry state and prevents overlapping updates', async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-install-test-'))
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const file = path.join(directory, 'installer.exe')
    const instance = updater([release('0.1.10')])
    await assert.rejects(
        instance.install(() => {}),
        /请先下载/
    )
    await instance.check()
    await instance.download(async () => file)
    let launches = 0
    await assert.rejects(
        instance.install(() => {
            launches++
            throw new Error('无法启动安装程序')
        }),
        /无法启动/
    )
    assert.equal(instance.state.status, 'downloaded')
    assert.equal(instance.state.error, '无法启动安装程序')
    fs.writeFileSync(file, 'tampered')
    await assert.rejects(
        instance.install(() => {
            launches++
        }),
        /校验失败/
    )
    assert.equal(launches, 1)
    fs.writeFileSync(file, payload)
    let releaseLaunch
    const installing = instance.install(async destination => {
        assert.equal(destination, file)
        await new Promise(resolve => {
            releaseLaunch = resolve
        })
    })
    while (!releaseLaunch) await new Promise(resolve => setImmediate(resolve))
    await assert.rejects(instance.check(), /请稍候/)
    await assert.rejects(
        instance.download(() => file),
        /请稍候/
    )
    await assert.rejects(
        instance.install(() => {}),
        /请稍候/
    )
    releaseLaunch()
    assert.equal(await installing, true)
    assert.equal(instance.state.status, 'installing')
    assert.equal(instance.state.error, null)
    await assert.rejects(instance.check(), /请稍候/)
})
