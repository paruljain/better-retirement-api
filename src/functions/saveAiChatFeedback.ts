import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { getEmailFromToken, getJwtSecret, getNameFromToken } from '../lib/auth'
import { isOptionsRequest, jsonResponse, optionsResponse } from '../lib/http'
import { getAiChatFeedbackCollection } from '../lib/mongo'

const MAX_COMMENT_LENGTH = 2000
const MAX_STRING_LENGTH = 100000

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function trimString(value: unknown, maxLength = MAX_STRING_LENGTH): string {
    if (typeof value !== 'string') {
        return ''
    }

    return value.trim().slice(0, maxLength)
}

function decodeHtmlEntities(value: string): string {
    return value
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&#(\d+);/g, (_match, codePoint) => {
            const value = Number(codePoint)
            return Number.isFinite(value) ? String.fromCodePoint(value) : ''
        })
        .replace(/&#x([0-9a-f]+);/gi, (_match, codePoint) => {
            const value = Number.parseInt(codePoint, 16)
            return Number.isFinite(value) ? String.fromCodePoint(value) : ''
        })
}

function htmlToPlainText(value: unknown, maxLength = MAX_STRING_LENGTH): string {
    if (typeof value !== 'string') {
        return ''
    }

    return decodeHtmlEntities(value)
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\s*\/\s*(p|div|li|h[1-6]|blockquote|pre|tr)\s*>/gi, '\n')
        .replace(/<\s*li\b[^>]*>/gi, '- ')
        .replace(/<[^>]*>/g, '')
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
        .slice(0, maxLength)
}

export async function saveAiChatFeedback(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    if (isOptionsRequest(request)) {
        return optionsResponse(request)
    }

    if (request.method !== 'POST') {
        return jsonResponse(request, 405, { error: 'Method not allowed. Use POST.' })
    }

    if (!getJwtSecret()) {
        context.error('APP_JWT_SECRET is not configured.')
        return jsonResponse(request, 500, { error: 'Server configuration is incomplete.' })
    }

    let email: string
    let name: string

    try {
        email = getEmailFromToken(request)
        name = getNameFromToken(request)
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid token.'
        return jsonResponse(request, 401, { error: message })
    }

    let body: unknown

    try {
        body = await request.json()
    } catch {
        return jsonResponse(request, 400, { error: 'Request body must be valid JSON.' })
    }

    if (!isPlainObject(body)) {
        return jsonResponse(request, 400, { error: 'Request body must be a JSON object.' })
    }

    const rating: 'up' | 'down' | '' = body.rating === 'up' || body.rating === 'down' ? body.rating : ''

    if (!rating) {
        return jsonResponse(request, 400, { error: 'rating must be up or down.' })
    }

    try {
        const feedback = await getAiChatFeedbackCollection()
        const createdAt = new Date().toISOString()
        const documentToSave = {
            userId: email,
            userName: name,
            createdAt,
            rating,
            reason: trimString(body.reason, 120),
            comment: trimString(body.comment, MAX_COMMENT_LENGTH),
            route: trimString(body.route, 1000),
            browser: trimString(body.browser, 120),
            screen: trimString(body.screen, 80),
            activePlan: trimString(body.activePlan, 200),
            user: trimString(body.user),
            assistant: htmlToPlainText(body.assistant),
            appVersion: trimString(body.appVersion, 80)
        }

        const result = await feedback.insertOne(documentToSave)

        return jsonResponse(request, 200, {
            saved: true,
            feedbackId: result.insertedId.toString()
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown MongoDB error.'
        context.error(`Failed to save AI chat feedback for "${email}": ${message}`)

        return jsonResponse(request, 500, { error: 'Failed to save AI chat feedback.' })
    }
}

app.http('save-ai-chat-feedback', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'ai-chat/feedback',
    handler: saveAiChatFeedback
})
