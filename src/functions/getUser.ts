import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { getAuthenticationErrorPayload, getEmailFromToken, getJwtSecret } from '../lib/auth'
import { jsonResponse, optionsResponse, isOptionsRequest } from '../lib/http'
import { getUserActivityDailyCollection, getUsersCollection } from '../lib/mongo'

function getUtcDateKey(date: Date): string {
    return date.toISOString().slice(0, 10)
}

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
        return jsonResponse(request, 401, getAuthenticationErrorPayload(error))
    }

    try {
        const users = await getUsersCollection()
        const user = await users.findOne({ _id: email })

        if (!user) {
            return jsonResponse(request, 404, { error: 'User not found.' })
        }

        const now = new Date()
        const activityDate = getUtcDateKey(now)
        const userActivityDaily = await getUserActivityDailyCollection()

        await Promise.all([
            users.updateOne(
                { _id: email },
                { $set: { lastActiveAt: now } }
            ),
            userActivityDaily.updateOne(
                { _id: `${email}:${activityDate}` },
                {
                    $set: {
                        userId: email,
                        activityDate,
                        lastSeenAt: now
                    }
                },
                { upsert: true }
            )
        ])

        return jsonResponse(request, 200, {
            user: {
                ...user,
                lastActiveAt: now
            }
        })
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
