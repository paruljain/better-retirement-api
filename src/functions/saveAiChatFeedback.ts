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
            assistant: trimString(body.assistant),
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
