import { createRequire } from 'node:module'
import test from 'node:test'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const { MobileAccessLogin } = require('../../dist/browser/auth/methods/MobileAccessLogin')
const callback = 'https://login.live.com/oauth20_desktop.srf'

function fixture({ requestResult, browserResult, visibleSelector = '' } = {}) {
    const logs = []
    const requests = []
    let browserUrl = ''
    let closed = false
    let exchanged = false
    const bot = {
        isMobile: true,
        logger: Object.fromEntries(
            ['debug', 'info', 'warn', 'error'].map(level => [level, (_, __, message) => logs.push({ level, message })])
        ),
        http: {
            request: async options => {
                exchanged = true
                assert.equal(options.retries, 0)
                assert.equal(new URLSearchParams(options.data).get('code'), 'test-code')
                return { data: { access_token: 'test-token' } }
            }
        }
    }
    const resultUrl = (authorize, result) => {
        if (result) return result(authorize)
        return `${callback}?code=test-code&state=${authorize.searchParams.get('state')}`
    }
    const oauthPage = {
        goto: async raw => {
            browserUrl = resultUrl(new URL(raw), browserResult)
        },
        url: () => browserUrl,
        waitForURL: async predicate => {
            if (!predicate(new URL(browserUrl))) throw new Error('timeout')
        },
        locator: selector => ({
            first: () => ({ isVisible: async () => selector.includes(visibleSelector) && Boolean(visibleSelector) })
        }),
        close: async () => {
            closed = true
        }
    }
    const page = {
        request: {
            get: async raw => {
                const url = new URL(raw)
                requests.push(url)
                return { url: () => resultUrl(url, requestResult), status: () => 200 }
            }
        },
        context: () => ({ newPage: async () => oauthPage })
    }
    return { login: new MobileAccessLogin(bot, page), logs, requests, exchanged: () => exchanged, closed: () => closed }
}

test('Desktop session placeholder is omitted from OAuth while real email remains a login hint', async () => {
    for (const email of ['local@rewards.invalid', 'LOCAL@REWARDS.INVALID', 'person@example.com']) {
        const f = fixture()
        assert.equal(await f.login.get(email), 'test-token')
        assert.equal(f.requests[0].searchParams.get('login_hint'), email === 'person@example.com' ? email : null)
    }
})

test('request without a code falls back to the active browser session and closes its page', async () => {
    const f = fixture({ requestResult: () => 'https://login.live.com/consent' })
    assert.equal(await f.login.get('local@rewards.invalid'), 'test-token')
    assert.equal(f.closed(), true)
})

test('OAuth rejects wrong origin, missing or mismatched state, and error callbacks', async () => {
    for (const makeUrl of [
        url => `https://example.com/oauth20_desktop.srf?code=test-code&state=${url.searchParams.get('state')}`,
        () => `${callback}?code=test-code`,
        () => `${callback}?code=test-code&state=wrong`,
        url => `${callback}?code=test-code&state=${url.searchParams.get('state')}&error=access_denied`
    ]) {
        const f = fixture({ requestResult: makeUrl, browserResult: makeUrl })
        assert.equal(await f.login.get('local@rewards.invalid'), '')
        assert.equal(f.exchanged(), false)
        assert.equal(f.closed(), true)
    }
})

test('interactive authorization blockers are visible without debug logging and omit secrets', async () => {
    for (const [selector, reason] of [
        ['input[type="password"]', 'sign_in_required'],
        ['#idBtn_Accept', 'consent_required'],
        ['input[name="otc"]', 'verification_required']
    ]) {
        const blocked = () => 'https://login.live.com/login.srf?code=secret-code&login_hint=private@example.com'
        const f = fixture({ requestResult: blocked, browserResult: blocked, visibleSelector: selector })
        assert.equal(await f.login.get('local@rewards.invalid'), '')
        assert.ok(f.logs.some(log => log.level === 'warn' && log.message.includes(`reason=${reason}`)))
        assert.equal(JSON.stringify(f.logs).includes('secret-code'), false)
        assert.equal(JSON.stringify(f.logs).includes('private@example.com'), false)
    }
})
