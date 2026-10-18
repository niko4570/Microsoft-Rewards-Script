import path from 'node:path'

// Explicit desktop paths never fall back to a checkout's private configuration.
export function dataFile(name) {
    return process.env.MRS_DATA_DIR ? path.resolve(process.env.MRS_DATA_DIR, name) : null
}

export function sessionDirectory(sessionPath) {
    return path.resolve(process.env.MRS_DATA_DIR || process.cwd(), sessionPath)
}
