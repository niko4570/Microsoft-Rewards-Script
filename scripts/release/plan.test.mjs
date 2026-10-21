import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { affects, nextVersion, plan } from './plan.mjs'
import { createManifest, applyManifest, versionFiles } from './versions.mjs'
import { sourceArchive } from './source-archive.mjs'
import { inflateRawSync } from 'node:zlib'
import { createHash } from 'node:crypto'

// Real Git fixtures verify baselines, retries and all four desktop version files.
function fixture(t) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-release-'))
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
    const git = (...args) =>
        execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const write = (file, value) => {
        fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
        fs.writeFileSync(path.join(cwd, file), value)
    }
    const json = file => JSON.parse(fs.readFileSync(path.join(cwd, file), 'utf8'))
    git('init')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'Release test')
    for (const [prefix, version] of [
        ['', '4.3.2'],
        ['desktop/', '0.2.0']
    ]) {
        write(`${prefix}package.json`, JSON.stringify({ name: 'fixture', version }))
        write(`${prefix}package-lock.json`, JSON.stringify({ version, packages: { '': { version } } }))
    }
    write('desktop/src-tauri/Cargo.toml', '[package]\nname = "rewards-desktop"\nversion = "0.2.0"\n')
    write(
        'desktop/src-tauri/Cargo.lock',
        '[[package]]\nname = "other"\nversion = "9.0.0"\n\n[[package]]\nname = "rewards-desktop"\nversion = "0.2.0"\n'
    )
    write('desktop/src/main.tsx', 'initial desktop')
    write('src/index.ts', 'initial backend')
    const commit = message => {
        git('add', '.')
        git('commit', '-m', message)
    }
    commit('initial')
    git('tag', 'desktop-v0.2.0')
    git('tag', 'v4.3.2')
    return { cwd, git, write, json, commit }
}

test('component filters separate Docker, desktop and shared runtime; docs/tests do not release', () => {
    for (const file of ['README.md', 'docs/guide.svg', 'desktop/test/host.test.mjs', 'scripts/api/logParser.test.js']) {
        assert.equal(affects(file, 'desktop'), false, file)
        assert.equal(affects(file, 'docker'), false, file)
    }
    for (const file of ['desktop/src/main.tsx', 'desktop/assets/icon.png', 'desktop/src-tauri/Cargo.lock']) {
        assert.equal(affects(file, 'desktop'), true)
        assert.equal(affects(file, 'docker'), false)
    }
    assert.equal(affects('scripts/docker/entrypoint.sh', 'desktop'), false)
    assert.equal(affects('scripts/docker/entrypoint.sh', 'docker'), true)
    for (const file of ['src/index.ts', 'scripts/api/server.js', 'scripts/utils.js', 'package-lock.json']) {
        assert.equal(affects(file, 'desktop'), true)
        assert.equal(affects(file, 'docker'), true)
    }
})

test('versions honor semantic changes, explicit versions and unpublished retries', () => {
    assert.equal(nextVersion('0.2.0', '0.2.0', 'fix: correct startup'), '0.2.1')
    assert.equal(nextVersion('0.2.0', '0.2.0', 'feat(ui): add tray control'), '0.3.0')
    assert.equal(nextVersion('1.2.3', '1.2.3', 'refactor(api)!: new interface'), '2.0.0')
    assert.equal(nextVersion('1.2.3', '1.2.3', 'fix: update\n\nBREAKING CHANGE: incompatible'), '2.0.0')
    assert.equal(nextVersion('0.3.0', '0.2.0', 'feat: add control'), '0.3.0')
    assert.equal(nextVersion('0.2.0', null, 'initial'), '0.2.0')
    assert.throws(() => nextVersion('0.2.0-beta', '0.2.0', ''), /Invalid/)
})

test('no changes or documentation-only commits produce no releases', t => {
    const f = fixture(t)
    assert.deepEqual(plan(f.cwd), { desktop: 'false', docker: 'false' })
    f.write('README.md', 'new guide')
    f.commit('docs: guide')
    assert.deepEqual(plan(f.cwd), { desktop: 'false', docker: 'false' })
})

test('desktop release synchronizes JSON, lockfiles and only the native app crate', t => {
    const f = fixture(t)
    f.write('desktop/src/main.tsx', 'fixed desktop')
    f.commit('fix: restore window')
    const output = plan(f.cwd)
    assert.equal(output.desktop_tag, 'desktop-v0.2.1')
    assert.equal(output.docker, 'false')
    assert.equal(f.git('status', '--porcelain'), '', 'planning must not modify the checkout')
    applyManifest(f.cwd, createManifest(f.cwd, output))
    assert.equal(f.json('desktop/package.json').version, '0.2.1')
    assert.equal(f.json('desktop/package-lock.json').packages[''].version, '0.2.1')
    const cargo = fs.readFileSync(path.join(f.cwd, 'desktop/src-tauri/Cargo.lock'), 'utf8')
    assert.match(cargo, /name = "other"\nversion = "9.0.0"/)
    assert.match(cargo, /name = "rewards-desktop"\nversion = "0.2.1"/)
    assert.deepEqual(plan(f.cwd), output, 'a failed build retries the same planned version without a commit')
    f.git('tag', output.desktop_tag)
    assert.deepEqual(plan(f.cwd), { desktop: 'false', docker: 'false' })
})

test('shared feature releases both components; Docker-only fixes release only Docker', t => {
    const f = fixture(t)
    f.write('src/index.ts', 'feature')
    f.commit('feat: new task')
    assert.equal(plan(f.cwd).docker_tag, 'v4.4.0')
    applyManifest(f.cwd, createManifest(f.cwd, plan(f.cwd)))
    assert.equal(f.json('package-lock.json').version, '4.4.0')
    assert.equal(f.json('desktop/package.json').version, '0.3.0')
    f.git('restore', '--', ...versionFiles)
    f.git('tag', 'v4.4.0')
    f.git('tag', 'desktop-v0.3.0')
    f.write('scripts/docker/entrypoint.sh', 'fix Docker startup')
    f.commit('fix: container startup')
    const output = plan(f.cwd)
    assert.equal(output.desktop, 'false')
    assert.equal(output.docker_tag, 'v4.4.1')
})

test('pending release recovers changes across later commits and ignores v3 tags', t => {
    const f = fixture(t)
    f.git('tag', 'v3.99.0')
    f.write('desktop/src/main.tsx', 'pending fix')
    f.commit('fix: pending')
    f.write('README.md', 'later documentation')
    f.commit('docs: later')
    assert.equal(plan(f.cwd).desktop_tag, 'desktop-v0.2.1')
})

test('a v4 breaking change requires an explicit new major release branch', t => {
    const f = fixture(t)
    f.write('src/index.ts', 'breaking')
    f.commit('feat!: breaking backend')
    assert.throws(() => plan(f.cwd), /new major/)
})

test('draft and prerelease tags do not mark pending runtime changes as published', t => {
    const f = fixture(t)
    f.write('desktop/src/main.tsx', 'pending upload')
    f.commit('fix: pending upload')
    f.git('tag', 'desktop-v0.2.1')
    const output = plan(f.cwd, ['desktop-v0.2.0', 'v4.3.2'])
    assert.equal(output.desktop_tag, 'desktop-v0.2.1')
    assert.equal(output.docker, 'false')
})

test('Docker version bookkeeping cannot cause a desktop release on a later test-only push', t => {
    const f = fixture(t)
    f.write('scripts/docker/entrypoint.sh', 'fixed entrypoint')
    f.commit('fix: Docker startup')
    assert.equal(plan(f.cwd).desktop, 'false')
    applyManifest(f.cwd, createManifest(f.cwd, plan(f.cwd)))
    f.commit('chore(release): reserve automatic versions [skip ci]')
    f.git('tag', 'v4.3.3')
    f.write('scripts/tests/extra.test.js', 'test-only change')
    f.commit('test: extra coverage')
    assert.deepEqual(plan(f.cwd), { desktop: 'false', docker: 'false' })
})

// Read stored/deflated ZIP entries without platform-specific archive tools.
function zipEntry(file, name) {
    const zip = fs.readFileSync(file)
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    let offset = zip.readUInt32LE(end + 16)
    const count = zip.readUInt16LE(end + 10)
    for (let i = 0; i < count; i++) {
        const nameLength = zip.readUInt16LE(offset + 28)
        const extraLength = zip.readUInt16LE(offset + 30)
        const commentLength = zip.readUInt16LE(offset + 32)
        const entryName = zip.subarray(offset + 46, offset + 46 + nameLength).toString()
        if (entryName === name) {
            const local = zip.readUInt32LE(offset + 42)
            const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
            const content = zip.subarray(start, start + zip.readUInt32LE(offset + 20))
            return (zip.readUInt16LE(offset + 10) === 8 ? inflateRawSync(content) : content).toString()
        }
        offset += 46 + nameLength + extraLength + commentLength
    }
    return null
}

test('release plan CLI is read-only and every consumer applies the exact same pinned versions', t => {
    const f = fixture(t)
    f.write('src/index.ts', 'new feature')
    f.commit('feat: new task')
    const before = f.git('rev-parse', 'HEAD')
    const artifact = path.join(os.tmpdir(), `release-plan-${path.basename(f.cwd)}.json`)
    t.after(() => fs.rmSync(artifact, { force: true }))
    execFileSync(process.execPath, [path.resolve('scripts/release/plan.mjs'), '--output', artifact], { cwd: f.cwd })
    assert.equal(f.git('status', '--porcelain'), '')
    const manifest = JSON.parse(fs.readFileSync(artifact))
    assert.equal(manifest.sourceSha, before)
    assert.deepEqual(manifest.versions, { desktop: '0.3.0', docker: '4.4.0' })
    execFileSync(process.execPath, [path.resolve('scripts/release/versions.mjs'), artifact], { cwd: f.cwd })
    const stamped = versionFiles.map(file => fs.readFileSync(path.join(f.cwd, file), 'utf8'))
    f.git('restore', '--', ...versionFiles)
    applyManifest(f.cwd, manifest)
    assert.deepEqual(
        versionFiles.map(file => fs.readFileSync(path.join(f.cwd, file), 'utf8')),
        stamped
    )
    assert.equal(f.git('rev-parse', 'HEAD'), before)
    assert.equal(f.git('show', 'HEAD:desktop/package.json'), '{"name":"fixture","version":"0.2.0"}')
})

test('invalid or stale manifests and missing native files fail before changing versions', t => {
    const f = fixture(t)
    f.write('src/index.ts', 'new feature')
    f.commit('feat: new task')
    const manifest = createManifest(f.cwd, plan(f.cwd))
    const original = fs.readFileSync(path.join(f.cwd, 'desktop/package.json'), 'utf8')
    for (const value of [
        { ...manifest, sourceSha: '0'.repeat(40) },
        { ...manifest, schemaVersion: 2 },
        { ...manifest, versions: { ...manifest.versions, desktop: '1.0.0-beta' } },
        { ...manifest, versions: { ...manifest.versions, docker: '5.0.0' } },
        { ...manifest, versions: {} }
    ]) {
        assert.throws(() => applyManifest(f.cwd, value), /Invalid|does not match|new major/)
        assert.equal(fs.readFileSync(path.join(f.cwd, 'desktop/package.json'), 'utf8'), original)
    }
    f.write('desktop/src-tauri/Cargo.lock', 'missing application crate')
    assert.throws(() => applyManifest(f.cwd, manifest), /Cannot update crate/)
    assert.equal(fs.readFileSync(path.join(f.cwd, 'desktop/package.json'), 'utf8'), original)
})

test('source archive matches stamped versions, records source identity, and leaves refs and index untouched', t => {
    const f = fixture(t)
    f.write('src/index.ts', 'new feature')
    f.commit('feat: new task')
    const manifest = createManifest(f.cwd, plan(f.cwd))
    applyManifest(f.cwd, manifest)
    f.write('.env', 'SECRET=must-not-enter-source-archive')
    const indexBefore = f.git('write-tree')
    const refsBefore = f.git('show-ref')
    const output = path.join(f.cwd, 'release/source.zip')
    const metadata = sourceArchive(f.cwd, output)
    assert.equal(metadata.sourceSha, manifest.sourceSha)
    assert.deepEqual(metadata.versions, manifest.versions)
    for (const file of versionFiles) {
        const text = fs.readFileSync(path.join(f.cwd, file), 'utf8')
        assert.equal(zipEntry(output, file), text, file)
        assert.equal(metadata.versionFiles[file], createHash('sha256').update(text).digest('hex'))
    }
    assert.deepEqual(JSON.parse(zipEntry(output, 'RELEASE-BUILD.json')), {
        schemaVersion: metadata.schemaVersion,
        sourceSha: metadata.sourceSha,
        versions: metadata.versions,
        versionFiles: metadata.versionFiles
    })
    assert.equal(zipEntry(output, '.env'), null)
    assert.equal(f.git('write-tree'), indexBefore)
    assert.equal(f.git('show-ref'), refsBefore)
    assert.equal(
        fs.readFileSync(`${output}.sha256`, 'utf8').split(' ')[0],
        createHash('sha256').update(fs.readFileSync(output)).digest('hex')
    )
})
