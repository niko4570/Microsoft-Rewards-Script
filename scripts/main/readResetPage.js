// Reset metadata is embedded in the server-rendered HTML/Flight stream.
// Background requests must not determine when that document is ready to read.
export async function readResetPage(page, url) {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
    if (!response?.ok() || new URL(page.url()).hostname !== 'rewards.bing.com')
        throw new Error('Rewards 页面读取失败或会话已过期，请检查登录')
    // Read the complete document, including streamed Flight chunks, rather than
    // a DOM snapshot that client scripts may already have modified.
    return response.text()
}
