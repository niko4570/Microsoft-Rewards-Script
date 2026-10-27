import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const browserNames = { chrome: 'Google Chrome', edge: 'Microsoft Edge' }
export const missingBrowserMessage = '请安装 Chrome 或 Microsoft Edge 后继续'

// Query fixed registry keys once and serialize as UTF-8. reg.exe's legacy output
// encoding can corrupt non-ASCII installation paths. Registry values are data,
// never command lines to execute.
function registryReader(env) {
    const executable = path.win32.join(
        env.SystemRoot || env.SYSTEMROOT || 'C:/Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe'
    )
    const script = `
        [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new();
        $values = @{};
        foreach ($hive in @('HKCU', 'HKLM')) {
            foreach ($exe in @('chrome.exe', 'msedge.exe')) {
                $key = "Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$exe";
                try { $values["$hive\\$key|"] = (Get-Item -LiteralPath ("{0}:\\{1}" -f $hive, $key) -ErrorAction Stop).GetValue('') } catch {}
            }
        }
        $key = 'Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice';
        try { $values["HKCU\\$key|ProgId"] = (Get-Item -LiteralPath "HKCU:\\$key" -ErrorAction Stop).GetValue('ProgId') } catch {}
        ConvertTo-Json -InputObject $values -Compress
    `
    const result = spawnSync(
        executable,
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 5000
        }
    )
    let values = {}
    try {
        if (result.status === 0) values = JSON.parse(result.stdout.replace(/^\uFEFF/, ''))
    } catch {}
    return (key, name = '') => (typeof values[`${key}|${name}`] === 'string' ? values[`${key}|${name}`] : null)
}

export function detectBrowsers(
    preference = 'auto',
    {
        platform = process.platform,
        env = process.env,
        readRegistry,
        isFile = file => fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true
    } = {}
) {
    const installed = []
    if (platform === 'win32') {
        const query = readRegistry || registryReader(env)
        const read = (key, name) => {
            try {
                return query(key, name)
            } catch {
                return null
            }
        }
        for (const [id, executable, suffix] of [
            ['edge', 'msedge.exe', 'Microsoft/Edge/Application/msedge.exe'],
            ['chrome', 'chrome.exe', 'Google/Chrome/Application/chrome.exe']
        ]) {
            const key = `Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executable}`
            const candidates = [read(`HKCU\\${key}`), read(`HKLM\\${key}`)]
            for (const base of [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]) {
                if (base) candidates.push(path.win32.join(base, suffix))
            }
            for (let candidate of candidates) {
                if (!candidate) continue
                candidate = candidate
                    .replace(
                        /%([^%]+)%/g,
                        (match, key) =>
                            Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] || match
                    )
                    .replace(/^"(.*)"$/, '$1')
                if (!path.win32.isAbsolute(candidate) || path.win32.basename(candidate).toLowerCase() !== executable)
                    continue
                if (/(?:Chrome|Edge) (?:Beta|Dev|SxS)[\\/]/i.test(candidate)) continue
                try {
                    if (isFile(candidate)) {
                        installed.push({ id, name: browserNames[id], executablePath: candidate })
                        break
                    }
                } catch {
                    /* Unreadable installation: try the next location. */
                }
            }
        }
        const progId =
            read(
                'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
                'ProgId'
            ) || ''
        const defaultId = /^ChromeHTML(?:\.|$)/i.test(progId)
            ? 'chrome'
            : /^MSEdgeHTM(?:\.|$)/i.test(progId)
              ? 'edge'
              : null
        const selected =
            preference === 'auto'
                ? installed.find(browser => browser.id === defaultId) || installed[0] || null
                : installed.find(browser => browser.id === preference) || null
        return {
            installed,
            selected,
            error: selected
                ? null
                : preference === 'auto'
                  ? missingBrowserMessage
                  : `未找到 ${browserNames[preference]}，请安装或更改浏览器选择`
        }
    }
    return { installed, selected: null, error: '系统浏览器模式仅支持 Windows 桌面版' }
}
