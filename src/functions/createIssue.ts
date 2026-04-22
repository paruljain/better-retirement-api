import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { getEmailFromToken, getJwtSecret, getNameFromToken } from '../lib/auth'
import { isOptionsRequest, jsonResponse, optionsResponse } from '../lib/http'

const DEFAULT_GITHUB_OWNER = 'paruljain'
const DEFAULT_GITHUB_REPO = 'better-retirement-issues'
const ISSUE_TITLE_MAX_LENGTH = 120
const ISSUE_DESCRIPTION_MAX_LENGTH = 5000

type IssueType = 'bug' | 'enhancement'

type IssueContext = {
    route?: string
    routeName?: string
    currentUrl?: string
    activePlanId?: string
    activePlanName?: string
    appVersion?: string
    schemaVersion?: number | null
    userAgent?: string
    language?: string
    timeZone?: string
    viewport?: {
        width?: number
        height?: number
    }
}

type IssueRequestBody = {
    type?: string
    title?: string
    description?: string
    context?: IssueContext
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRequiredEnv(name: string): string {
    return String(process.env[name] || '').trim()
}

function sanitizeText(value: unknown, maxLength: number): string {
    if (typeof value !== 'string') {
        return ''
    }

    return value.trim().replace(/\r\n/g, '\n').slice(0, maxLength)
}

function sanitizeOptionalText(value: unknown, maxLength = 500): string {
    return sanitizeText(value, maxLength)
}

function sanitizeIssueType(value: unknown): IssueType {
    return value === 'enhancement' ? 'enhancement' : 'bug'
}

function sanitizeContext(value: unknown): IssueContext {
    if (!isPlainObject(value)) {
        return {}
    }

    const viewport = isPlainObject(value.viewport)
        ? {
            width: Number.isFinite(value.viewport.width) ? Number(value.viewport.width) : undefined,
            height: Number.isFinite(value.viewport.height) ? Number(value.viewport.height) : undefined
        }
        : undefined

    return {
        route: sanitizeOptionalText(value.route),
        routeName: sanitizeOptionalText(value.routeName),
        currentUrl: sanitizeOptionalText(value.currentUrl, 1000),
        activePlanId: sanitizeOptionalText(value.activePlanId),
        activePlanName: sanitizeOptionalText(value.activePlanName),
        appVersion: sanitizeOptionalText(value.appVersion),
        schemaVersion: Number.isFinite(value.schemaVersion) ? Number(value.schemaVersion) : null,
        userAgent: sanitizeOptionalText(value.userAgent, 1000),
        language: sanitizeOptionalText(value.language),
        timeZone: sanitizeOptionalText(value.timeZone),
        viewport
    }
}

function buildIssueTitle(type: IssueType, title: string): string {
    const prefix = type === 'enhancement' ? '[Enhancement]' : '[Bug]'
    return `${prefix} ${title}`
}

function formatLine(label: string, value: string): string {
    return `- ${label}: ${value || 'Not provided'}`
}

function buildIssueBody(params: {
    type: IssueType
    title: string
    description: string
    userName: string
    userEmail: string
    context: IssueContext
    request: HttpRequest
}): string {
    const { type, description, userName, userEmail, context, request } = params
    const requestUserAgent = sanitizeOptionalText(request.headers.get('user-agent'), 1000)
    const submittedAt = new Date().toISOString()
    const viewportSummary = context.viewport?.width && context.viewport?.height
        ? `${context.viewport.width} x ${context.viewport.height}`
        : ''

    return [
        `Issue type: ${type === 'enhancement' ? 'Enhancement request' : 'Bug report'}`,
        '',
        '## Description',
        description,
        '',
        '## User Contact',
        formatLine('Name', userName),
        formatLine('Email', userEmail),
        '',
        '## App Context',
        formatLine('Route', context.route || ''),
        formatLine('Route Name', context.routeName || ''),
        formatLine('Current URL', context.currentUrl || ''),
        formatLine('Active Plan ID', context.activePlanId || ''),
        formatLine('Active Plan Name', context.activePlanName || ''),
        formatLine('App Version', context.appVersion || ''),
        formatLine('Schema Version', context.schemaVersion == null ? '' : String(context.schemaVersion)),
        formatLine('Browser Language', context.language || ''),
        formatLine('Browser Time Zone', context.timeZone || ''),
        formatLine('Viewport', viewportSummary),
        formatLine('Client User Agent', context.userAgent || ''),
        formatLine('Request User Agent', requestUserAgent),
        formatLine('Submitted At', submittedAt)
    ].join('\n')
}

async function createGithubIssue(params: {
    owner: string
    repo: string
    token: string
    title: string
    body: string
}) {
    const response = await fetch(`https://api.github.com/repos/${params.owner}/${params.repo}/issues`, {
        method: 'POST',
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${params.token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'better-retirement-api'
        },
        body: JSON.stringify({
            title: params.title,
            body: params.body
        })
    })

    const text = await response.text()
    let payload: Record<string, unknown> | null = null

    try {
        payload = text ? JSON.parse(text) as Record<string, unknown> : null
    } catch {
        payload = null
    }

    if (!response.ok) {
        const githubMessage = typeof payload?.message === 'string' ? payload.message : 'GitHub issue creation failed.'
        throw new Error(githubMessage)
    }

    return payload || {}
}

export async function createIssue(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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

    const githubToken = readRequiredEnv('GITHUB_ISSUES_TOKEN')
    const githubOwner = readRequiredEnv('GITHUB_OWNER') || DEFAULT_GITHUB_OWNER
    const githubRepo = readRequiredEnv('GITHUB_REPO') || DEFAULT_GITHUB_REPO

    if (!githubToken) {
        context.error('GITHUB_ISSUES_TOKEN is not configured.')
        return jsonResponse(request, 500, { error: 'Issue reporting is not configured yet.' })
    }

    let userEmail: string
    let userName: string

    try {
        userEmail = getEmailFromToken(request)
        userName = getNameFromToken(request)
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid token.'
        return jsonResponse(request, 401, { error: message })
    }

    let body: IssueRequestBody

    try {
        body = await request.json() as IssueRequestBody
    } catch {
        return jsonResponse(request, 400, { error: 'Request body must be valid JSON.' })
    }

    if (!isPlainObject(body)) {
        return jsonResponse(request, 400, { error: 'Request body must be a JSON object.' })
    }

    const issueType = sanitizeIssueType(body.type)
    const title = sanitizeText(body.title, ISSUE_TITLE_MAX_LENGTH)
    const description = sanitizeText(body.description, ISSUE_DESCRIPTION_MAX_LENGTH)
    const sanitizedContext = sanitizeContext(body.context)

    if (!title) {
        return jsonResponse(request, 400, { error: 'Issue title is required.' })
    }

    if (!description) {
        return jsonResponse(request, 400, { error: 'Issue description is required.' })
    }

    const githubTitle = buildIssueTitle(issueType, title)
    const githubBody = buildIssueBody({
        type: issueType,
        title,
        description,
        userName,
        userEmail,
        context: sanitizedContext,
        request
    })

    try {
        const githubIssue = await createGithubIssue({
            owner: githubOwner,
            repo: githubRepo,
            token: githubToken,
            title: githubTitle,
            body: githubBody
        })

        return jsonResponse(request, 201, {
            issueNumber: githubIssue.number,
            issueUrl: githubIssue.html_url
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown GitHub error.'
        context.error(`Failed to create GitHub issue: ${message}`)

        return jsonResponse(request, 502, { error: 'Failed to create the GitHub issue.' })
    }
}

app.http('create-issue', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'issues',
    handler: createIssue
})
