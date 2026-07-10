import { HttpRequest } from '@azure/functions'
import jwt, { JwtPayload } from 'jsonwebtoken'

type AppJwtPayload = JwtPayload & {
    email?: string
    name?: string
}

export type AuthenticationErrorCode = 'AUTH_REQUIRED' | 'AUTH_SESSION_EXPIRED' | 'AUTH_INVALID'

export class AuthenticationError extends Error {
    code: AuthenticationErrorCode

    constructor(code: AuthenticationErrorCode, message: string) {
        super(message)
        this.name = 'AuthenticationError'
        this.code = code
    }
}

export function getAuthenticationErrorPayload(error: unknown) {
    if (error instanceof AuthenticationError) {
        return {
            code: error.code,
            error: error.message
        }
    }

    return {
        code: 'AUTH_INVALID' as const,
        error: 'Your session is invalid. Sign in again to continue.'
    }
}

export function getJwtSecret(): string {
    return process.env.APP_JWT_SECRET || ''
}

export function readBearerToken(request: HttpRequest): string {
    const authorization = request.headers.get('authorization') || ''

    if (!authorization.startsWith('Bearer ')) {
        return ''
    }

    return authorization.slice('Bearer '.length).trim()
}

export function verifyAppToken(token: string): AppJwtPayload {
    try {
        return jwt.verify(token, getJwtSecret()) as AppJwtPayload
    } catch (error) {
        if (error instanceof jwt.TokenExpiredError) {
            throw new AuthenticationError('AUTH_SESSION_EXPIRED', 'Your session expired. Sign in again to continue.')
        }

        throw new AuthenticationError('AUTH_INVALID', 'Your session is invalid. Sign in again to continue.')
    }
}

export function getEmailFromToken(request: HttpRequest): string {
    const token = readBearerToken(request)

    if (!token) {
        throw new AuthenticationError('AUTH_REQUIRED', 'Sign in to continue.')
    }

    const payload = verifyAppToken(token)
    const email = payload.email?.trim()

    if (!email) {
        throw new AuthenticationError('AUTH_INVALID', 'Your session is invalid. Sign in again to continue.')
    }

    return email
}

export function getNameFromToken(request: HttpRequest): string {
    const token = readBearerToken(request)

    if (!token) {
        throw new AuthenticationError('AUTH_REQUIRED', 'Sign in to continue.')
    }

    const payload = verifyAppToken(token)
    return payload.name?.trim() || ''
}
