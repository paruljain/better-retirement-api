import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { getEmailFromToken, getJwtSecret } from '../lib/auth'
import { jsonResponse, optionsResponse, isOptionsRequest } from '../lib/http'
import { getUsersCollection } from '../lib/mongo'

export async function getUser(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

    let email: string

    try {
        email = getEmailFromToken(request)
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid token.'
        return jsonResponse(request, 401, { error: message })
    }

    try {
        const users = await getUsersCollection()
        const user = await users.findOne({ _id: email })

        if (!user) {
            return jsonResponse(request, 404, { error: 'User not found.' })
        }

        return jsonResponse(request, 200, { user })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown MongoDB error.'
        context.error(`Failed to fetch user document: ${message}`)

        return jsonResponse(request, 500, { error: 'Failed to fetch user data.' })
    }
}

app.http('get-user', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'users/me',
    handler: getUser
})
