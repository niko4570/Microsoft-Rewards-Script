import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createManifest } from './versions.mjs'

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export function compare(left, right) {
    if (!versionPattern.test(left) || !versionPattern.test(right)) throw new Error('Expected stable semantic versions')
    const a = left.split('.').map(Number)
    const b = right.split('.').map(Number)
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i])
    return 0
}

export function affects(file, component) {
    if (
        /\.md$/i.test(file) ||
        file.startsWith('docs/') ||
        /(^|\/)(test|tests)\//.test(file) ||
        /\.test\.[cm]?[jt]s$/.test(file)
    )
        return false
    const shared =
        /^(src\/|scripts\/(api\/|main\/|utils\.js$|env\.js$|runtimePaths\.js$|package\.json$)|package(-lock)?\.json$|tsconfig\.json$)/.test(
            file
        )
    if (component === 'desktop')
        return shared || file.startsWith('desktop/') || file === '.github/workflows/desktop-windows.yml'
    return shared || /^(Dockerfile$|\.dockerignore$|compose\.ya?ml$|scripts\/docker\/)/.test(file)
}

export function nextVersion(current, latest, messages) {
    if (!versionPattern.test(current)) throw new Error('Invalid package version')
    if (!latest || compare(current, latest) > 0) return current
    const parts = latest.split('.').map(Number)
    const level = /(^|\n)[^\n:]+!\s*:|(^|\n)BREAKING[ -]CHANGE:/m.test(messages)
        ? 0
        : /(^|\n)feat(?:\([^\n)]*\))?:/m.test(messages)
          ? 1
          : 2
    parts[level]++
    for (let i = level + 1; i < 3; i++) parts[i] = 0
    return parts.join('.')
}

export function plan(cwd = process.cwd(), publishedTags = null) {
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    const read = file => fs.readFileSync(path.join(cwd, file), 'utf8')
    const outputs = {}
    for (const component of ['desktop', 'docker']) {
        const prefix = component === 'desktop' ? 'desktop-v' : 'v'
        const tags = git('tag', '--list', `${prefix}*`)
            .split('\n')
            .filter(tag => tag.startsWith(prefix) && versionPattern.test(tag.slice(prefix.length)))
            .filter(tag => publishedTags === null || publishedTags.includes(tag))
            .filter(tag => component === 'desktop' || tag.startsWith('v4.'))
            .sort((a, b) => compare(b.slice(prefix.length), a.slice(prefix.length)))
        const baseline = tags.find(tag => {
            try {
                git('merge-base', '--is-ancestor', tag, 'HEAD')
                return true
            } catch {
                return false
            }
        })
        const files = (baseline ? git('diff', '--name-only', `${baseline}..HEAD`) : git('ls-files')).split('\n')
        // A Docker-only release bumps the root package version. Do not let that
        // bookkeeping commit cause an unrelated desktop release on the next push.
        const authored = baseline
            ? new Set(
                  git(
                      'log',
                      '--format=',
                      '--name-only',
                      '--diff-merges=first-parent',
                      '--fixed-strings',
                      '--invert-grep',
                      '--grep=chore(release): reserve automatic versions [skip ci]',
                      `${baseline}..HEAD`
                  ).split('\n')
              )
            : null
        const changed = files.filter(file => affects(file, component) && (authored === null || authored.has(file)))
        outputs[component] = String(changed.length > 0)
        if (!changed.length) continue
        const manifest = component === 'desktop' ? 'desktop/package.json' : 'package.json'
        const current = JSON.parse(read(manifest)).version
        const messages = git('log', '--format=%B', ...(baseline ? [`${baseline}..HEAD`] : ['HEAD']), '--', ...changed)
        const version = nextVersion(current, tags[0]?.slice(prefix.length), messages)
        if (component === 'docker' && !version.startsWith('4.'))
            throw new Error('v4 cannot publish a new major; prepare a new release branch')
        outputs[`${component}_tag`] = `${prefix}${version}`
        outputs[`${component}_version`] = version
    }
    return outputs
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const publishedTags = process.env.PUBLISHED_TAGS_FILE
        ? fs.readFileSync(process.env.PUBLISHED_TAGS_FILE, 'utf8').trim().split('\n')
        : null
    const outputs = plan(process.cwd(), publishedTags)
    const manifest = createManifest(process.cwd(), outputs)
    const args = process.argv.slice(2)
    if (args.length) {
        if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: plan.mjs [--output release-plan.json]')
        fs.writeFileSync(args[1], JSON.stringify(manifest, null, 2) + '\n')
    }
    outputs.sha = manifest.sourceSha
    const lines =
        Object.entries(outputs)
            .map(([key, value]) => `${key}=${value}`)
            .join('\n') + '\n'
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, lines)
    if (process.env.GITHUB_STEP_SUMMARY)
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Release plan\n\n\`\`\`text\n${lines}\`\`\`\n`)
    console.log(lines)
}
