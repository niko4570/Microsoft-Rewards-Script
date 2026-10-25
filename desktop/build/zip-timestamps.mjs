import fs from 'node:fs'
import path from 'node:path'

// ZIP stores local DOS dates starting at 1980-01-01.
// Only normalize copies in the packaging directory, never dependency sources.
export function normalizeZipTimestamps(directory) {
    const earliest = new Date(1980, 0, 1)
    function visit(file) {
        const stat = fs.lstatSync(file)
        if (stat.isSymbolicLink()) return
        if (stat.isDirectory()) {
            for (const name of fs.readdirSync(file)) visit(path.join(file, name))
        }
        if (stat.mtime < earliest) fs.utimesSync(file, stat.atime, earliest)
    }
    visit(directory)
}
