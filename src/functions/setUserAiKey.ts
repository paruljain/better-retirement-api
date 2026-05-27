import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { getEmailFromToken, getJwtSecret } from '../lib/auth'
import { encryptSecret, hasAppEncryptionKey } from '../lib/encryption'
import { isOptionsRequest, jsonResponse, optionsResponse } from '../lib/http'
import { getUserAiCredentialsCollection } from '../lib/mongo'

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function setUserAiKey(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

    if (!hasAppEncryptionKey()) {
        context.error('APP_ENCRYPTION_KEY is not configured.')
        return jsonResponse(request, 500, { error: 'Server configuration is incomplete.' })
    }

    let email: string

    try {
        email = getEmailFromToken(request)
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

    const aiApiKey = typeof body.aiApiKey === 'string' ? body.aiApiKey.trim() : ''

    if (!aiApiKey) {
        return jsonResponse(request, 400, { error: 'aiApiKey is required.' })
    }

    try {
        const credentials = await getUserAiCredentialsCollection()
        const encryptedApiKey = encryptSecret(aiApiKey, `userAiCredentials:${email}:aiApiKey`)

        await credentials.updateOne(
            { _id: email },
            {
                $set: {
                    _id: email,
                    aiApiKeyEncrypted: encryptedApiKey.encryptedValue,
                    aiApiKeyIv: encryptedApiKey.iv,
                    aiApiKeyTag: encryptedApiKey.tag,
                    aiApiKeyKeyVersion: encryptedApiKey.keyVersion,
                    updatedAt: new Date().toISOString()
                },
                $unset: {
                    aiApiKey: ''
                }
            },
            { upsert: true }
        )

        return jsonResponse(request, 200, { saved: true })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown MongoDB error.'
        context.error(`Failed to save user AI key: ${message}`)

        return jsonResponse(request, 500, { error: 'Failed to save AI key.' })
    }
}

app.http('set-user-ai-key', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'users/me/ai-key',
    handler: setUserAiKey
})
