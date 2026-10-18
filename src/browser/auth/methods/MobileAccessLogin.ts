import { randomBytes } from 'crypto'
import type { Page } from 'patchright'
import { URLSearchParams } from 'url'

import { URLs } from '../../../constants/urls'
import type { MicrosoftRewardsBot } from '../../../index'

interface TokenResponse {
    access_token?: string
    error?: string
    error_description?: string
}

export class MobileAccessLogin {
    private clientId = '0000000040170455'
    private authUrl = URLs.auth.oauthAuthorize
    private redirectUrl = URLs.auth.oauthRedirect
    private tokenUrl = URLs.auth.oauthToken
    private scope = 'service::prod.rewardsplatform.microsoft.com::MBI_SSL'

    constructor(
        private bot: MicrosoftRewardsBot,
        private page: Page
    ) {}

    async get(email: string): Promise<string> {
        try {
            const authorizeUrl = new URL(this.authUrl)
            authorizeUrl.searchParams.append('response_type', 'code')
            authorizeUrl.searchParams.append('client_id', this.clientId)
            authorizeUrl.searchParams.append('redirect_uri', this.redirectUrl)
            authorizeUrl.searchParams.append('scope', this.scope)
            authorizeUrl.searchParams.append('state', randomBytes(16).toString('hex'))
            authorizeUrl.searchParams.append('access_type', 'offline_access')
            // Desktop's local session key is not a Microsoft account identity.
            const loginHint = email.trim()
            if (loginHint && !/@[^@]*\.invalid$/i.test(loginHint)) {
                authorizeUrl.searchParams.append('login_hint', loginHint)
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'LOGIN-APP',
                `Auth URL constructed: ${authorizeUrl.origin}${authorizeUrl.pathname}`
            )

            let code = await this.resolveCodeViaRequest(authorizeUrl)
            if (!code) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN-APP',
                    'Request-based OAuth did not return a code, retrying through the active browser context'
                )
                code = await this.resolveCodeViaBrowser(authorizeUrl)
            }

            if (!code) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN-APP',
                    'Could not resolve mobile OAuth code - app activities will be skipped this run'
                )
                return ''
            }

            this.bot.logger.debug(this.bot.isMobile, 'LOGIN-APP', 'OAuth code resolved, exchanging for access token')

            const data = new URLSearchParams()
            data.append('grant_type', 'authorization_code')
            data.append('client_id', this.clientId)
            data.append('code', code)
            data.append('redirect_uri', this.redirectUrl)
            data.append('scope', this.scope)

            const response = await this.bot.http.request<TokenResponse>({
                url: this.tokenUrl,
                method: 'POST',
                retries: 0,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                data: data.toString()
            })

            const token = response?.data?.access_token ?? ''
            if (!token) {
                const error = response?.data?.error ?? 'unknown_error'
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN-APP',
                    `Mobile token exchange failed | error=${this.safeErrorCode(error)}`
                )
                return ''
            }

            this.bot.logger.info(this.bot.isMobile, 'LOGIN-APP', 'Mobile access token received')
            return token
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-APP',
                `MobileAccess failed | errorType=${error instanceof Error ? error.name : 'unknown'}`
            )
            return ''
        }
    }

    private async resolveCodeViaRequest(authorizeUrl: URL): Promise<string> {
        try {
            this.bot.logger.debug(this.bot.isMobile, 'LOGIN-APP', 'Resolving mobile OAuth code via request')

            const response = await this.page.request.get(authorizeUrl.href, { maxRedirects: 20, timeout: 30000 })
            const finalUrl = response.url()

            const code = this.extractCode(finalUrl, authorizeUrl.searchParams.get('state')!)
            this.bot.logger[code ? 'debug' : 'warn'](
                this.bot.isMobile,
                'LOGIN-APP',
                `OAuth request resolved → ${this.safeUrl(finalUrl)} | status=${response.status()} | code=${code ? 'present' : 'missing'}`
            )

            return code
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-APP',
                `OAuth code request failed | errorType=${error instanceof Error ? error.name : 'unknown'}`
            )
            return ''
        }
    }

    private async resolveCodeViaBrowser(authorizeUrl: URL): Promise<string> {
        let oauthPage: Page | null = null

        try {
            oauthPage = await this.page.context().newPage()
            await oauthPage.goto(authorizeUrl.href, { waitUntil: 'domcontentloaded', timeout: 30000 })

            const state = authorizeUrl.searchParams.get('state')!
            let code = this.extractCode(oauthPage.url(), state)
            if (code) return code

            await oauthPage.waitForURL(url => this.isCallback(url), { timeout: 30000 }).catch(() => {})

            code = this.extractCode(oauthPage.url(), state)
            const reason = code ? 'authorized' : await this.failureReason(oauthPage)
            this.bot.logger[code ? 'debug' : 'warn'](
                this.bot.isMobile,
                'LOGIN-APP',
                `OAuth browser resolved → ${this.safeUrl(oauthPage.url())} | code=${code ? 'present' : 'missing'} | reason=${reason}`
            )

            return code
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-APP',
                `OAuth browser fallback failed | page=${oauthPage ? this.safeUrl(oauthPage.url()) : 'unavailable'} | errorType=${error instanceof Error ? error.name : 'unknown'}`
            )
            return ''
        } finally {
            await oauthPage?.close().catch(() => {})
        }
    }

    private isCallback(url: URL): boolean {
        const redirect = new URL(this.redirectUrl)
        return url.origin === redirect.origin && url.pathname.toLowerCase() === redirect.pathname.toLowerCase()
    }

    private extractCode(rawUrl: string, state: string): string {
        try {
            const url = new URL(rawUrl)
            if (!this.isCallback(url) || !state || url.searchParams.get('state') !== state) return ''
            if (url.searchParams.has('error')) return ''
            return url.searchParams.get('code') ?? ''
        } catch {
            return ''
        }
    }

    private async failureReason(page: Page): Promise<string> {
        const url = new URL(page.url())
        if (url.searchParams.has('error')) return `oauth_error:${this.safeErrorCode(url.searchParams.get('error')!)}`
        if (this.isCallback(url)) return 'callback_missing_code_or_state_mismatch'
        if (url.hostname === 'login.live.com' || url.hostname === 'login.microsoftonline.com') {
            const checks = [
                ['input[type="password"], input#usernameEntry, input[name="loginfmt"]', 'sign_in_required'],
                ['#idBtn_Accept, form[action*="consent"]', 'consent_required'],
                [
                    'input[name="otc"], [data-testid="codeEntry"], #proof-confirmation-email-input',
                    'verification_required'
                ]
            ] as const
            for (const [selector, reason] of checks) {
                if (
                    await page
                        .locator(selector)
                        .first()
                        .isVisible()
                        .catch(() => false)
                )
                    return reason
            }
            return 'interaction_or_redirect_required'
        }
        return 'unexpected_page_or_redirect_timeout'
    }

    private safeErrorCode(value: string): string {
        return /^[a-zA-Z0-9_]{1,80}$/.test(value) ? value : 'unknown_error'
    }

    private safeUrl(rawUrl: string): string {
        try {
            const url = new URL(rawUrl)
            const error = url.searchParams.get('error')
            return `${url.origin}${url.pathname}${error ? `?error=${this.safeErrorCode(error)}` : ''}`
        } catch {
            return '(invalid URL)'
        }
    }
}
