import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { getAuthenticationErrorPayload, getEmailFromToken, getJwtSecret } from '../lib/auth'
import { resolveEmailPreferences, updateProductUpdatePreference } from '../lib/emailPreferences'
import { jsonResponse, optionsResponse, isOptionsRequest } from '../lib/http'
import { getEmailPreferencesCollection } from '../lib/mongo'

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function emailPreferences(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    if (isOptionsRequest(request)) {
        return optionsResponse(request)
    }

    if (request.method !== 'GET' && request.method !== 'POST') {
        return jsonResponse(request, 405, { error: 'Method not allowed. Use GET or POST.' })
    }

    if (!getJwtSecret()) {
        context.error('APP_JWT_SECRET is not configured.')
        return jsonResponse(request, 500, { error: 'Server configuration is incomplete.' })
    }

    let email: string

    try {
        email = getEmailFromToken(request).trim().toLowerCase()
    } catch (error) {
        return jsonResponse(request, 401, getAuthenticationErrorPayload(error))
    }

    try {
        if (request.method === 'GET') {
            const preferences = await getEmailPreferencesCollection()
            return jsonResponse(request, 200, {
                preferences: resolveEmailPreferences(await preferences.findOne({ _id: email }))
            })
        }

        let body: unknown

        try {
            body = await request.json()
        } catch {
            return jsonResponse(request, 400, { error: 'Request body must be valid JSON.' })
        }

        if (!isPlainObject(body) || typeof body.productUpdatesSubscribed !== 'boolean') {
            return jsonResponse(request, 400, {
                error: 'productUpdatesSubscribed must be true or false.'
            })
        }

        const preferences = await updateProductUpdatePreference(
            email,
            body.productUpdatesSubscribed,
            'account-preferences'
        )

        return jsonResponse(request, 200, { saved: true, preferences })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown MongoDB error.'
        context.error(`Failed to manage email preferences: ${message}`)
        return jsonResponse(request, 500, { error: 'Failed to manage email preferences.' })
    }
}

app.http('email-preferences', {
    methods: ['GET', 'POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'users/me/email-preferences',
    handler: emailPreferences
})
