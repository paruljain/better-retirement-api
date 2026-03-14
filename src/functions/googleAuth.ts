import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { OAuth2Client, TokenPayload } from 'google-auth-library'
import jwt from 'jsonwebtoken'
import { getJwtSecret } from '../lib/auth'
import { jsonResponse, optionsResponse, isOptionsRequest } from '../lib/http'

const googleClient = new OAuth2Client()

function getAudience(): string {
    return process.env.GOOGLE_CLIENT_ID || ''
}

function mapPayload(payload: TokenPayload) {
    return {
        userId: payload.sub,
        email: payload.email,
        emailVerified: payload.email_verified,
        name: payload.name,
        givenName: payload.given_name,
        familyName: payload.family_name,
        picture: payload.picture,
        locale: payload.locale,
        issuer: payload.iss,
        audience: payload.aud,
        expiresAt: payload.exp
    }
}

export async function validateGoogleIdToken(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    if (isOptionsRequest(request)) {
        return optionsResponse(request)
    }

    if (request.method !== 'POST') {
        return jsonResponse(request, 405, { error: 'Method not allowed. Use POST.' })
    }

    const audience = getAudience()
    if (!audience) {
        context.error('GOOGLE_CLIENT_ID is not configured.')
        return jsonResponse(request, 500, { error: 'Server configuration is incomplete.' })
    }

    const jwtSecret = getJwtSecret()
    if (!jwtSecret) {
        context.error('APP_JWT_SECRET is not configured.')
        return jsonResponse(request, 500, { error: 'Server configuration is incomplete.' })
    }

    let body: { idToken?: string }

    try {
        body = await request.json() as { idToken?: string }
    } catch {
        return jsonResponse(request, 400, { error: 'Request body must be valid JSON.' })
    }

    const idToken = body?.idToken?.trim()
    if (!idToken) {
        return jsonResponse(request, 400, { error: 'idToken is required.' })
    }

    try {
        const ticket = await googleClient.verifyIdToken({
            idToken,
            audience
        })

        const payload = ticket.getPayload()
        if (!payload) {
            return jsonResponse(request, 401, { error: 'Token payload is missing.' })
        }

        if (!payload.email) {
            return jsonResponse(request, 401, { error: 'Google token did not include an email.' })
        }

        if (payload.email_verified !== true) {
            return jsonResponse(request, 401, { error: 'Google account email is not verified.' })
        }

        const apiToken = jwt.sign(
            {
                email: payload.email
            },
            jwtSecret,
            {
                subject: payload.sub,
                expiresIn: '8h'
            }
        )

        // context.log(`Validated Google user: email="${payload.email || ''}", name="${payload.name || ''}"`)

        return jsonResponse(request, 200, {
            valid: true,
            token: apiToken,
            user: mapPayload(payload)
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown Google token validation error.'
        context.warn(`Google token validation failed: ${message}`)

        return jsonResponse(request, 401, {
            valid: false,
            error: 'Invalid Google ID token.'
        })
    }
}

app.http('google-auth-login', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'auth/google/login',
    handler: validateGoogleIdToken
})
