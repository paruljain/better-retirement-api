import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { getEmailFromToken, getJwtSecret } from '../lib/auth'
import { jsonResponse, optionsResponse, isOptionsRequest } from '../lib/http'
import { getUsersCollection } from '../lib/mongo'

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function saveUser(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

    const document = {
        ...body,
        _id: email,
        email,
        updatedAt: new Date().toISOString()
    }

    try {
        const users = await getUsersCollection()

        await users.replaceOne(
            { _id: email },
            document,
            { upsert: true }
        )

        return jsonResponse(request, 200, {
            saved: true,
            user: document
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown MongoDB error.'
        context.error(`Failed to save user document: ${message}`)

        return jsonResponse(request, 500, { error: 'Failed to save user data.' })
    }
}

app.http('save-user', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'users',
    handler: saveUser
})
