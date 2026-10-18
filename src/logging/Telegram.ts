import { httpRequest } from '../util/Http'
import type { HttpRequestConfig } from '../util/Http'
import PQueue from 'p-queue'
import type { WebhookTelegramConfig } from '../interface/Config'
import type { LogLevel } from './Logger'
import { flushQueue } from './Queue'

const telegramQueue = new PQueue({
    interval: 1000,
    intervalCap: 2,
    carryoverConcurrencyCount: true
})

function getTelegramEmoji(level: LogLevel): string {
    switch (level) {
        case 'error':
            return '❌'
        case 'warn':
            return '⚠️'
        case 'info':
            return 'ℹ️'
        case 'debug':
            return '🐛'
        default:
            return '📝'
    }
}

export async function sendTelegram(config: WebhookTelegramConfig, content: string, level: LogLevel): Promise<void> {
    if (!config?.botToken || !config?.chatId) return

    const emoji = getTelegramEmoji(level)
    const message = `${emoji}\n${content}`

    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`

    const request: HttpRequestConfig = {
        method: 'POST',
        url: url,
        headers: { 'Content-Type': 'application/json' },
        data: {
            chat_id: config.chatId,
            text: message,
            disable_notification: level === 'debug'
        },
        timeout: 10000
    }

    for (const part of splitTelegramMessage(message)) {
        await telegramQueue.add(async () => {
            try {
                await httpRequest({ ...request, data: { ...(request.data as object), text: part } })
            } catch {
                // Never log the request URL: it contains the bot token.
                console.error('[TELEGRAM] Notification delivery failed; see local run report.')
            }
        })
    }
}

export function flushTelegramQueue(timeoutMs = 5000): Promise<void> {
    return flushQueue(telegramQueue, timeoutMs)
}

export function splitTelegramMessage(message: string): string[] {
    const chunks: string[] = []
    let chunk = ''
    for (const character of message) {
        if (chunk.length + character.length > 3500) {
            chunks.push(chunk)
            chunk = ''
        }
        chunk += character
    }
    if (chunk) chunks.push(chunk)
    return chunks
}
