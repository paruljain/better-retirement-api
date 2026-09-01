import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { getAuthenticationErrorPayload, getEmailFromToken, getJwtSecret, getNameFromToken } from '../lib/auth'
import { isOptionsRequest, jsonResponse, optionsResponse } from '../lib/http'
import { withMaintenanceGuard } from '../lib/maintenance'

const DEFAULT_GITHUB_OWNER = 'paruljain'
const DEFAULT_GITHUB_REPO = 'better-retirement-issues'
const ISSUE_TITLE_MAX_LENGTH = 120
const ISSUE_DESCRIPTION_MAX_LENGTH = 5000

export type IssueType = 'bug' | 'enhancement'

type GithubIssueTypeLabel = {
    name: string
    color: string
    description: string
}

export class IssueValidationError extends Error {}

export type IssueContext = {
    currentUrl?: string
    activePlanId?: string
    activePlanName?: string
    appVersion?: string
    schemaVersion?: number | null
    timeZone?: string
    viewport?: {
        width?: number
        height?: number
    }
}

export type IssueRequestBody = {
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
        currentUrl: sanitizeOptionalText(value.currentUrl, 1000),
        activePlanId: sanitizeOptionalText(value.activePlanId),
        activePlanName: sanitizeOptionalText(value.activePlanName),
        appVersion: sanitizeOptionalText(value.appVersion),
        schemaVersion: Number.isFinite(value.schemaVersion) ? Number(value.schemaVersion) : null,
        timeZone: sanitizeOptionalText(value.timeZone),
        viewport
    }
}

function buildIssueTitle(type: IssueType, title: string): string {
    const prefix = type === 'enhancement' ? '[Enhancement]' : '[Bug]'
    return `${prefix} ${title}`
}

function getGithubIssueTypeLabel(type: IssueType): GithubIssueTypeLabel {
    if (type === 'enhancement') {
        return {
            name: 'enhancement',
            color: 'a2eeef',
            description: 'New feature or request'
        }
    }

    return {
        name: 'bug',
        color: 'd73a4a',
        description: 'Something is not working'
    }
}

function getGithubReportedFromAppLabel(): GithubIssueTypeLabel {
    return {
        name: 'reported-from-app',
        color: '1d76db',
        description: 'Submitted through the Better Retirement app'
    }
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
    const viewportSummary = context.viewport?.width && context.viewport?.height
        ? `${context.viewport.width} x ${context.viewport.height}`
        : ''

    return [
        '## Description',
        description,
        '',
        '## User Contact',
        formatLine('Name', userName),
        formatLine('Email', userEmail),
        '',
        '## App Context',
        formatLine('Current URL', context.currentUrl || ''),
        formatLine('Active Plan ID', context.activePlanId || ''),
        formatLine('Active Plan Name', context.activePlanName || ''),
        formatLine('App Version', context.appVersion || ''),
        formatLine('Schema Version', context.schemaVersion == null ? '' : String(context.schemaVersion)),
        formatLine('Browser Time Zone', context.timeZone || ''),
        formatLine('Viewport', viewportSummary),
        formatLine('User Agent', requestUserAgent)
    ].join('\n')
}

async function createGithubIssue(params: {
    owner: string
    repo: string
    token: string
    title: string
    body: string
    labels: string[]
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
            body: params.body,
            labels: params.labels
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

async function ensureGithubLabel(params: {
    owner: string
    repo: string
    token: string
    label: GithubIssueTypeLabel
}) {
    const response = await fetch(`https://api.github.com/repos/${params.owner}/${params.repo}/labels`, {
        method: 'POST',
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${params.token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'better-retirement-api'
        },
        body: JSON.stringify({
            name: params.label.name,
            color: params.label.color,
            description: params.label.description
        })
    })

    if (response.ok) {
        return
    }

    const text = await response.text()
    let payload: Record<string, unknown> | null = null

    try {
        payload = text ? JSON.parse(text) as Record<string, unknown> : null
    } catch {
        payload = null
    }

    const alreadyExists = Array.isArray(payload?.errors)
        && payload.errors.some((error) => isPlainObject(error) && error.code === 'already_exists')

    if (response.status === 422 && alreadyExists) {
        return
    }

    const githubMessage = typeof payload?.message === 'string' ? payload.message : 'GitHub label creation failed.'
    throw new Error(githubMessage)
}

export async function createGithubIssueFromReport(params: {
    request: HttpRequest
    context: InvocationContext
    body: IssueRequestBody
    userEmail: string
    userName: string
}): Promise<Record<string, unknown>> {
    const githubToken = readRequiredEnv('GITHUB_ISSUES_TOKEN')
    const githubOwner = readRequiredEnv('GITHUB_OWNER') || DEFAULT_GITHUB_OWNER
    const githubRepo = readRequiredEnv('GITHUB_REPO') || DEFAULT_GITHUB_REPO

    if (!githubToken) {
        params.context.error('GITHUB_ISSUES_TOKEN is not configured.')
        throw new Error('Issue reporting is not configured yet.')
    }

    const issueType = sanitizeIssueType(params.body.type)
    const title = sanitizeText(params.body.title, ISSUE_TITLE_MAX_LENGTH)
    const description = sanitizeText(params.body.description, ISSUE_DESCRIPTION_MAX_LENGTH)
    const sanitizedContext = sanitizeContext(params.body.context)

    if (!title) {
        throw new IssueValidationError('Issue title is required.')
    }

    if (!description) {
        throw new IssueValidationError('Issue description is required.')
    }

    const githubTitle = buildIssueTitle(issueType, title)
    const githubLabel = getGithubIssueTypeLabel(issueType)
    const reportedFromAppLabel = getGithubReportedFromAppLabel()
    const githubBody = buildIssueBody({
        type: issueType,
        title,
        description,
        userName: params.userName,
        userEmail: params.userEmail,
        context: sanitizedContext,
        request: params.request
    })

    await ensureGithubLabel({
        owner: githubOwner,
        repo: githubRepo,
        token: githubToken,
        label: githubLabel
    })

    await ensureGithubLabel({
        owner: githubOwner,
        repo: githubRepo,
        token: githubToken,
        label: reportedFromAppLabel
    })

    return createGithubIssue({
        owner: githubOwner,
        repo: githubRepo,
        token: githubToken,
        title: githubTitle,
        body: githubBody,
        labels: [githubLabel.name, reportedFromAppLabel.name]
    })
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

    let userEmail: string
    let userName: string

    try {
        userEmail = getEmailFromToken(request)
        userName = getNameFromToken(request)
    } catch (error) {
        return jsonResponse(request, 401, getAuthenticationErrorPayload(error))
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

    try {
        const githubIssue = await createGithubIssueFromReport({
            request,
            context,
            body,
            userEmail,
            userName
        })

        return jsonResponse(request, 201, {
            issueNumber: githubIssue.number,
            issueUrl: githubIssue.html_url
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown GitHub error.'

        if (error instanceof IssueValidationError) {
            return jsonResponse(request, 400, { error: message })
        }

        context.error(`Failed to create GitHub issue: ${message}`)

        return jsonResponse(request, 502, { error: 'Failed to create the GitHub issue.' })
    }
}

app.http('create-issue', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'issues',
    handler: withMaintenanceGuard(createIssue)
})
