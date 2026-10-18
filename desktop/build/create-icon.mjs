import fs from 'node:fs'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

// Code-native application mark; no external image asset or runtime dependency.
const size = 256
const raw = Buffer.alloc(size * (1 + size * 4))
const glyph = ['11110', '10001', '10001', '11110', '10100', '10010', '10001']
for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
        const offset = y * (size * 4 + 1) + 1 + x * 4
        const inside = Math.hypot(Math.max(28 - x, 0, x - 227), Math.max(28 - y, 0, y - 227)) <= 28
        const gx = Math.floor((x - 73) / 22)
        const gy = Math.floor((y - 51) / 22)
        const white = gx >= 0 && gx < 5 && gy >= 0 && gy < 7 && glyph[gy][gx] === '1'
        raw.set(white ? [255, 255, 255, 255] : [35, 91, 195, inside ? 255 : 0], offset)
    }
}
function crc32(buffer) {
    let crc = 0xffffffff
    for (const byte of buffer) {
        crc ^= byte
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, bytes) {
    const name = Buffer.from(type)
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])))
    return Buffer.concat([length, name, bytes, crc])
}
const header = Buffer.alloc(13)
header.writeUInt32BE(size, 0)
header.writeUInt32BE(size, 4)
header[8] = 8
header[9] = 6
const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/icon.png')
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.writeFileSync(
    target,
    Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0))
    ])
)
