import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { sourceSha, versionFiles } from './versions.mjs'

// A temporary index overlays the stamped manifests on HEAD for git archive.
// No commit, branch update, or change to the checkout's index is needed.
export function sourceArchive(cwd, output) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-source-'))
    const env = { ...process.env, GIT_INDEX_FILE: path.join(temporary, 'index') }
    const git = (args, input) => execFileSync('git', args, { cwd, env, input, encoding: 'utf8' }).trim()
    try {
        const sha = sourceSha(cwd)
        git(['read-tree', sha])
        const files = {}
        for (const file of versionFiles) {
            const content = fs.readFileSync(path.join(cwd, file))
            files[file] = createHash('sha256').update(content).digest('hex')
            const blob = git(['hash-object', '-w', '--stdin'], content)
            git(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`])
        }
        const readVersion = file => JSON.parse(fs.readFileSync(path.join(cwd, file), 'utf8')).version
        const metadata = {
            schemaVersion: 1,
            sourceSha: sha,
            versions: { desktop: readVersion('desktop/package.json'), docker: readVersion('package.json') },
            versionFiles: files
        }
        const text = JSON.stringify(metadata, null, 2) + '\n'
        const blob = git(['hash-object', '-w', '--stdin'], text)
        git(['update-index', '--add', '--cacheinfo', `100644,${blob},RELEASE-BUILD.json`])
        const tree = git(['write-tree'])
        const archive = path.resolve(cwd, output)
        fs.mkdirSync(path.dirname(archive), { recursive: true })
        git(['archive', '--format=zip', `--output=${archive}`, tree])
        const checksum = createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
        fs.writeFileSync(`${archive}.sha256`, `${checksum}  ${path.basename(archive)}\n`)
        return { tree, ...metadata }
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true })
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/release/source-archive.mjs <output.zip>')
    console.log(JSON.stringify(sourceArchive(process.cwd(), process.argv[2])))
}
