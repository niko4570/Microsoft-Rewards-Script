import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const versionFiles = [
    'package.json',
    'package-lock.json',
    'desktop/package.json',
    'desktop/package-lock.json',
    'desktop/src-tauri/Cargo.toml',
    'desktop/src-tauri/Cargo.lock'
]

export function sourceSha(cwd) {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
}

export function createManifest(cwd, outputs) {
    return {
        schemaVersion: 1,
        sourceSha: sourceSha(cwd),
        versions: {
            desktop: outputs.desktop === 'true' ? outputs.desktop_version : null,
            docker: outputs.docker === 'true' ? outputs.docker_version : null
        }
    }
}

export function validateManifest(cwd, manifest) {
    if (manifest?.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest.sourceSha ?? ''))
        throw new Error('Invalid release manifest')
    if (manifest.sourceSha !== sourceSha(cwd)) throw new Error('Release manifest source does not match HEAD')
    for (const component of ['desktop', 'docker']) {
        const version = manifest.versions?.[component]
        if (
            version !== null &&
            (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
        )
            throw new Error(`Invalid ${component} release version`)
        if (component === 'docker' && version !== null && !version.startsWith('4.'))
            throw new Error('v4 cannot publish a new major; prepare a new release branch')
    }
    return manifest
}

// Stamp only the build workspace. Never commit, update a ref, or push a branch.
export function applyManifest(cwd, manifest) {
    validateManifest(cwd, manifest)
    const updates = new Map()
    const read = file => fs.readFileSync(path.join(cwd, file), 'utf8')
    for (const component of ['desktop', 'docker']) {
        const version = manifest.versions[component]
        if (version === null) continue
        const prefix = component === 'desktop' ? 'desktop/' : ''
        for (const file of [`${prefix}package.json`, `${prefix}package-lock.json`]) {
            const value = JSON.parse(read(file))
            value.version = version
            if (value.packages?.['']) value.packages[''].version = version
            updates.set(file, JSON.stringify(value, null, 4) + '\n')
        }
        if (component === 'desktop') {
            for (const file of versionFiles.slice(4)) {
                const source = read(file)
                const cratePattern = /(name = "rewards-desktop"\r?\nversion = ")[^"]+(")/
                // Match this crate only; dependency versions remain unchanged.
                if (!cratePattern.test(source)) throw new Error(`Cannot update crate version in ${file}`)
                updates.set(file, source.replace(cratePattern, `$1${version}$2`))
            }
        }
    }
    // Validate every input before changing any version file.
    for (const [file, value] of updates) fs.writeFileSync(path.join(cwd, file), value)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/release/versions.mjs <release-plan.json>')
    const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
    applyManifest(process.cwd(), manifest)
    console.log(`Applied build versions for source ${manifest.sourceSha}`)
}
