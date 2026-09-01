import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { getAuthenticationErrorPayload, getEmailFromToken, getJwtSecret, getNameFromToken } from '../lib/auth'
import { jsonResponse, optionsResponse, isOptionsRequest } from '../lib/http'
import {
    getMaintenanceConfig,
    isSchemaVersionMismatch,
    SCHEMA_VERSION_MISMATCH_CODE,
    withMaintenanceGuard
} from '../lib/maintenance'
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
    let name: string

    try {
        email = getEmailFromToken(request)
        name = getNameFromToken(request)
    } catch (error) {
        return jsonResponse(request, 401, getAuthenticationErrorPayload(error))
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

    try {
        const maintenanceConfig = await getMaintenanceConfig()

        if (isSchemaVersionMismatch(body.schemaVersion, maintenanceConfig.requiredSchemaVersion)) {
            return jsonResponse(request, 409, {
                code: SCHEMA_VERSION_MISMATCH_CODE,
                message: 'Your application is out of date. Sign in again to reload the latest version of your plan.',
                requiredSchemaVersion: maintenanceConfig.requiredSchemaVersion
            })
        }

        const users = await getUsersCollection()
        const documentToSave = {
            ...body,
            _id: email,
            email,
            name,
            updatedAt: new Date().toISOString()
        }

        await users.updateOne(
            { _id: email },
            { $set: documentToSave },
            { upsert: true }
        )

        return jsonResponse(request, 200, {
            saved: true,
            user: documentToSave
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
    handler: withMaintenanceGuard(saveUser)
})
