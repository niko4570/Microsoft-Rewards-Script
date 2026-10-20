import test from 'node:test'
import assert from 'node:assert/strict'
import { readResetPage } from '../../scripts/main/readResetPage.js'

const url = 'https://rewards.bing.com/earn'

test('reset inspection reads full server data without waiting for background network traffic', async () => {
    const html = '<script>self.__next_f.push([1,"complete streamed reset metadata"])</script>'
    const page = {
        async goto(target, options) {
            assert.equal(target, url)
            // Model a page whose background requests never become idle.
            if (options.waitUntil === 'networkidle') throw new Error('Timeout 25000ms exceeded')
            assert.equal(options.waitUntil, 'domcontentloaded')
            assert.equal(options.timeout, 25000)
            return { ok: () => true, text: async () => html }
        },
        url: () => url,
        content() {
            throw new Error('DOM snapshot must not replace the complete server response')
        }
    }
    assert.equal(await readResetPage(page, url), html)
})

test('HTTP failures, missing responses and login redirects still reject reset inspection', async () => {
    for (const [response, destination] of [
        [null, url],
        [{ ok: () => false }, url],
        [{ ok: () => true }, 'https://login.live.com/'],
        [{ ok: () => true }, 'https://rewards.bing.com.example.org/']
    ]) {
        await assert.rejects(
            readResetPage({ goto: async () => response, url: () => destination }, url),
            /页面读取失败或会话已过期/
        )
    }
})

test('navigation and document read failures propagate to the scheduler retry', async () => {
    await assert.rejects(
        readResetPage(
            {
                goto: async () => {
                    throw new Error('connection reset')
                }
            },
            url
        ),
        /connection reset/
    )
    await assert.rejects(
        readResetPage(
            {
                goto: async () => ({
                    ok: () => true,
                    text: async () => {
                        throw new Error('incomplete document')
                    }
                }),
                url: () => url
            },
            url
        ),
        /incomplete document/
    )
})
