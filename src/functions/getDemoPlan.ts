import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { getAuthenticationErrorPayload, getEmailFromToken, getJwtSecret } from '../lib/auth'
import { jsonResponse, optionsResponse, isOptionsRequest } from '../lib/http'
import { getDemoUserDocument } from '../lib/demoPlan'

export async function getDemoPlan(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    if (isOptionsRequest(request)) {
        return optionsResponse(request)
    }

    if (request.method !== 'GET') {
        return jsonResponse(request, 405, { error: 'Method not allowed. Use GET.' })
    }

    if (!getJwtSecret()) {
        context.error('APP_JWT_SECRET is not configured.')
        return jsonResponse(request, 500, { error: 'Server configuration is incomplete.' })
    }

    try {
        getEmailFromToken(request)
    } catch (error) {
        return jsonResponse(request, 401, getAuthenticationErrorPayload(error))
    }

    try {
        const demoUserDocument = await getDemoUserDocument()

        if (!demoUserDocument) {
            return jsonResponse(request, 404, { error: 'Demo plan configuration was not found.' })
        }

        return jsonResponse(request, 200, {
            demoUserDocument
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown MongoDB error.'
        context.error(`Failed to fetch demo plan configuration: ${message}`)

        return jsonResponse(request, 500, { error: 'Failed to fetch demo plan configuration.' })
    }
}

app.http('get-demo-plan', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'app-config/demo-plan',
    handler: getDemoPlan
})
