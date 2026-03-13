import { HttpRequest } from '@azure/functions'
import jwt, { JwtPayload } from 'jsonwebtoken'

type AppJwtPayload = JwtPayload & {
    email?: string
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
    return jwt.verify(token, getJwtSecret()) as AppJwtPayload
}

export function getEmailFromToken(request: HttpRequest): string {
    const token = readBearerToken(request)

    if (!token) {
        throw new Error('Missing bearer token.')
    }

    const payload = verifyAppToken(token)
    const email = payload.email?.trim()

    if (!email) {
        throw new Error('JWT does not contain an email claim.')
    }

    return email
}
