import { HttpRequest, HttpResponseInit } from '@azure/functions'

const allowedHostnames = new Set([
    'localhost',
    '127.0.0.1',
    'better-retirement.com'
])

function getAllowedOrigin(request: HttpRequest): string {
    const origin = request.headers.get('origin')

    if (!origin) {
        return 'https://better-retirement.com'
    }

    try {
        const url = new URL(origin)
        const isLocalOrigin = (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
            && (url.protocol === 'http:' || url.protocol === 'https:')
        const isProductionOrigin = url.hostname === 'better-retirement.com' && url.protocol === 'https:'

        if (allowedHostnames.has(url.hostname) && (isLocalOrigin || isProductionOrigin)) {
            return origin
        }
    } catch {
        return 'https://better-retirement.com'
    }

    return 'https://better-retirement.com'
}

export function corsHeaders(request: HttpRequest): Record<string, string> {
    return {
        'Access-Control-Allow-Origin': getAllowedOrigin(request),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin'
    }
}

export function jsonResponse(request: HttpRequest, status: number, body: unknown): HttpResponseInit {
    return {
        status,
        headers: corsHeaders(request),
        jsonBody: body
    }
}

export function optionsResponse(request: HttpRequest): HttpResponseInit {
    return {
        status: 204,
        headers: corsHeaders(request)
    }
}

export function isOptionsRequest(request: HttpRequest): boolean {
    return request.method === 'OPTIONS'
}
