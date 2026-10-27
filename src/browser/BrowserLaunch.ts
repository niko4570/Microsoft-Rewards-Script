import fs from 'node:fs'
import path from 'node:path'

// Desktop children receive an application-resolved installation, never a user profile.
// Non-desktop CLI and Docker runs retain Patchright's original defaults.
export function browserLaunchOptions(env: NodeJS.ProcessEnv = process.env): {
    executablePath?: string
    channel?: string
} {
    if (!env.MRS_DATA_DIR) return {}
    const executablePath = env.MRS_BROWSER_EXECUTABLE
    const channel =
        env.MRS_BROWSER_NAME === 'edge' ? 'msedge' : env.MRS_BROWSER_NAME === 'chrome' ? 'chrome' : undefined
    if (
        !executablePath ||
        !channel ||
        !path.isAbsolute(executablePath) ||
        !fs.statSync(executablePath, { throwIfNoEntry: false })?.isFile()
    ) {
        throw new Error('未找到可用的系统浏览器，请安装 Chrome 或 Microsoft Edge 后重新检测')
    }
    return { executablePath, channel }
}
