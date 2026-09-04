import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { ReadableStream } from 'stream/web'
import OpenAI from 'openai'
import { getAuthenticationErrorPayload, getEmailFromToken, getJwtSecret, getNameFromToken } from '../lib/auth'
import { decryptSecret } from '../lib/encryption'
import { corsHeaders, isOptionsRequest, jsonResponse, optionsResponse } from '../lib/http'
import { withMaintenanceGuard } from '../lib/maintenance'
import { buildActivePlanPromptDigest } from '../lib/aiChatPromptDigest'
import { DEMO_PLAN_ID, getDemoUserDocument } from '../lib/demoPlan'
import { AiChatPromptDocument, getAiChatPromptsCollection, getUserAiCredentialsCollection, getUsersCollection, UserAiCredentialDocument, UserDocument } from '../lib/mongo'
import { createGithubIssueFromReport, IssueContext, IssueValidationError } from './createIssue'

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'
const GEMINI_MODEL = 'gemini-3.5-flash-lite'
const INSTRUCTIONS_PROMPT_ID = 'instructions'
const ACTIVE_PLAN_DIGEST_SECTION_ID = 'active-plan-digest'
const GET_PROMPT_SECTIONS_TOOL_NAME = 'get_prompt_sections'
const CREATE_ISSUE_TOOL_NAME = 'create_issue'
const MAX_TOOL_ROUNDS = 10

type ChatRequestBody = Record<string, unknown> & {
    messages: OpenAI.Chat.ChatCompletionMessageParam[]
    activePlanId?: string
    computedContext?: Record<string, unknown>
    clientContext?: IssueContext
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isChatRequestBody(value: unknown): value is ChatRequestBody {
    return isPlainObject(value) && Array.isArray(value.messages)
}

function createChatClient(apiKey: string): OpenAI {
    return new OpenAI({
        apiKey,
        baseURL: GEMINI_BASE_URL
    })
}

function getSavedAiApiKey(record: UserAiCredentialDocument, email: string): string {
    if (record.aiApiKeyEncrypted && record.aiApiKeyIv && record.aiApiKeyTag && record.aiApiKeyKeyVersion) {
        return decryptSecret({
            encryptedValue: record.aiApiKeyEncrypted,
            iv: record.aiApiKeyIv,
            tag: record.aiApiKeyTag,
            keyVersion: record.aiApiKeyKeyVersion
        }, `userAiCredentials:${email}:aiApiKey`)
    }

    return String(record.aiApiKey || '').trim()
}

function getTextContent(value: unknown): string {
    if (typeof value === 'string') {
        return value.trim()
    }

    if (Array.isArray(value)) {
        return value
            .map((item) => {
                if (typeof item === 'string') {
                    return item
                }

                if (isPlainObject(item) && item.type === 'text' && typeof item.text === 'string') {
                    return item.text
                }

                return ''
            })
            .join('')
            .trim()
    }

    return ''
}

function sanitizeChatMessages(messages: OpenAI.Chat.ChatCompletionMessageParam[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages
        .filter((message) => message?.role === 'user' || message?.role === 'assistant')
        .map((message) => ({
            role: message.role,
            content: getTextContent(message.content)
        } as OpenAI.Chat.ChatCompletionMessageParam))
        .filter((message) => Boolean(getTextContent(message.content)))
}

async function buildSystemPrompt(): Promise<string> {
    const prompts = await getAiChatPromptsCollection()
    const instructions = await prompts.findOne({ _id: INSTRUCTIONS_PROMPT_ID })
    const instructionsContent = String(instructions?.content || '').trim()

    if (!instructionsContent) {
        throw new Error('AI chat instructions prompt is missing.')
    }

    return instructionsContent
}

function parseToolArguments(rawArguments: unknown): { sectionIds: string[] } {
    if (isPlainObject(rawArguments) && Array.isArray(rawArguments.sectionIds)) {
        return {
            sectionIds: rawArguments.sectionIds.filter((sectionId) => typeof sectionId === 'string')
        }
    }

    if (typeof rawArguments !== 'string') {
        return { sectionIds: [] }
    }

    try {
        const parsed = JSON.parse(rawArguments)

        if (isPlainObject(parsed) && Array.isArray(parsed.sectionIds)) {
            return {
                sectionIds: parsed.sectionIds.filter((sectionId) => typeof sectionId === 'string')
            }
        }
    } catch {
        return { sectionIds: [] }
    }

    return { sectionIds: [] }
}

function parseJsonObject(rawArguments: unknown): Record<string, unknown> {
    if (isPlainObject(rawArguments)) {
        return rawArguments
    }

    if (typeof rawArguments !== 'string') {
        return {}
    }

    try {
        const parsed = JSON.parse(rawArguments)
        return isPlainObject(parsed) ? parsed : {}
    } catch {
        return {}
    }
}

function parseCreateIssueArguments(rawArguments: unknown): {
    type: 'bug' | 'enhancement'
    title: string
    description: string
} {
    const parsed = parseJsonObject(rawArguments)

    return {
        type: parsed.type === 'enhancement' ? 'enhancement' : 'bug',
        title: typeof parsed.title === 'string' ? parsed.title : '',
        description: typeof parsed.description === 'string' ? parsed.description : ''
    }
}

function sanitizeClientIssueContext(value: unknown): IssueContext {
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
        currentUrl: typeof value.currentUrl === 'string' ? value.currentUrl : '',
        activePlanId: typeof value.activePlanId === 'string' ? value.activePlanId : '',
        activePlanName: typeof value.activePlanName === 'string' ? value.activePlanName : '',
        appVersion: typeof value.appVersion === 'string' ? value.appVersion : '',
        schemaVersion: Number.isFinite(value.schemaVersion) ? Number(value.schemaVersion) : null,
        timeZone: typeof value.timeZone === 'string' ? value.timeZone : '',
        viewport
    }
}

function sanitizeComputedContext(value: unknown): Record<string, unknown> {
    return isPlainObject(value) ? value : {}
}

function hasPlan(user: UserDocument | null, planId: string): boolean {
    return Array.isArray(user?.plans) && user.plans.some((plan) => plan?.id === planId)
}

function buildRuntimeContextText(clientContext: IssueContext, activePlanId: string): string {
    const activePlanName = String(clientContext.activePlanName || '').trim()
    const contextLines = [
        'Runtime client context for this request:',
        `- Active Plan ID: ${activePlanId || clientContext.activePlanId || 'unknown'}`,
        `- Active Plan Name: ${activePlanName || 'unknown'}`,
        `- Current URL: ${clientContext.currentUrl || 'unknown'}`,
        `- App Version: ${clientContext.appVersion || 'unknown'}`,
        `- Schema Version: ${clientContext.schemaVersion ?? 'unknown'}`,
        `- Time Zone: ${clientContext.timeZone || 'unknown'}`
    ]

    return `${contextLines.join('\n')}\n\nWhen the user asks which plan is active, answer from this runtime context. If plan details are needed, request the ${ACTIVE_PLAN_DIGEST_SECTION_ID} section.`
}

async function buildPromptSectionBundle(sectionIds: string[], user: UserDocument, activePlanId: string, computedContext: Record<string, unknown>): Promise<string> {
    const uniqueSectionIds = sectionIds
        .map((sectionId) => String(sectionId || '').trim())
        .filter(Boolean)
        .filter((sectionId, index, values) => values.indexOf(sectionId) === index)

    if (uniqueSectionIds.length === 0) {
        return 'No prompt section IDs were requested.'
    }

    const databaseSectionIds = uniqueSectionIds.filter((sectionId) => sectionId !== ACTIVE_PLAN_DIGEST_SECTION_ID)
    const prompts = await getAiChatPromptsCollection()
    const databaseSections = databaseSectionIds.length > 0
        ? await prompts.find({
            _id: { $in: databaseSectionIds },
            enabled: true
        }).toArray()
        : []
    const databaseSectionMap = new Map(databaseSections.map((section) => [section._id, String(section.content || '').trim()]))

    return uniqueSectionIds.map((sectionId) => {
        if (sectionId === ACTIVE_PLAN_DIGEST_SECTION_ID) {
            return `Section: ${ACTIVE_PLAN_DIGEST_SECTION_ID}\n${buildActivePlanPromptDigest(user, activePlanId, computedContext)}`
        }

        const content = databaseSectionMap.get(sectionId)

        if (!content) {
            return `Section: ${sectionId}\nNo enabled prompt section was found for this ID.`
        }

        return `Section: ${sectionId}\n${content}`
    }).join('\n\n')
}

function getPromptSectionTool(): OpenAI.Chat.ChatCompletionTool {
    return {
        type: 'function',
        function: {
            name: GET_PROMPT_SECTIONS_TOOL_NAME,
            description: 'Retrieve one or more Better Retirement prompt sections by ID.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    sectionIds: {
                        type: 'array',
                        description: 'Prompt section IDs from the available prompt section catalog.',
                        items: {
                            type: 'string'
                        }
                    }
                },
                required: ['sectionIds']
            }
        }
    }
}

function getCreateIssueTool(): OpenAI.Chat.ChatCompletionTool {
    return {
        type: 'function',
        function: {
            name: CREATE_ISSUE_TOOL_NAME,
            description: 'Create a GitHub issue in the Better Retirement issue tracker after triaging that the user has described a real product defect or a broadly useful enhancement.',
            parameters: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    type: {
                        type: 'string',
                        enum: ['bug', 'enhancement'],
                        description: 'Use bug for incorrect product behavior and enhancement for broadly useful new product capability.'
                    },
                    title: {
                        type: 'string',
                        description: 'Short issue title without the [Bug] or [Enhancement] prefix.'
                    },
                    description: {
                        type: 'string',
                        description: 'Markdown issue body content. Include the same sections you would want in the public tracker, such as summary, user impact, reproduction steps, expected behavior, actual behavior, workaround, and evidence.'
                    }
                },
                required: ['type', 'title', 'description']
            }
        }
    }
}

function createSseStream(stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()

    return new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                for await (const chunk of stream) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
                }

                controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                controller.close()
            } catch (error) {
                controller.error(error)
            }
        }
    })
}

async function createFinalChatStream({
    client,
    messages,
    user,
    activePlanId,
    computedContext,
    clientContext,
    request,
    context,
    userEmail,
    userName
}: {
    client: OpenAI
    messages: OpenAI.Chat.ChatCompletionMessageParam[]
    user: UserDocument
    activePlanId: string
    computedContext: Record<string, unknown>
    clientContext: IssueContext
    request: HttpRequest
    context: InvocationContext
    userEmail: string
    userName: string
}): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> {
    const tools = [getPromptSectionTool(), getCreateIssueTool()]
    const systemPrompt = [
        await buildSystemPrompt(),
        buildRuntimeContextText(clientContext, activePlanId)
    ].join('\n\n')
    const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        {
            role: 'system',
            content: systemPrompt
        },
        ...messages
    ]

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const response = await client.chat.completions.create({
            model: GEMINI_MODEL,
            reasoning_effort: 'medium',
            messages: chatMessages,
            tools,
            tool_choice: 'auto',
            stream: false
        } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming)
        const assistantMessage = response.choices?.[0]?.message
        const toolCalls = assistantMessage?.tool_calls || []

        if (!assistantMessage) {
            throw new Error('AI chat did not return a response.')
        }

        if (toolCalls.length === 0) {
            return client.chat.completions.create({
                model: GEMINI_MODEL,
                reasoning_effort: 'medium',
                messages: chatMessages,
                stream: true
            } as OpenAI.Chat.ChatCompletionCreateParamsStreaming)
        }

        chatMessages.push(assistantMessage as OpenAI.Chat.ChatCompletionMessageParam)

        for (const toolCall of toolCalls) {
            if (toolCall.type !== 'function') {
                continue
            }

            if (toolCall.function?.name === GET_PROMPT_SECTIONS_TOOL_NAME) {
                const args = parseToolArguments(toolCall.function.arguments)
                const sectionBundle = await buildPromptSectionBundle(args.sectionIds, user, activePlanId, computedContext)

                chatMessages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: sectionBundle
                } as OpenAI.Chat.ChatCompletionMessageParam)
                continue
            }

            if (toolCall.function?.name === CREATE_ISSUE_TOOL_NAME) {
                try {
                    const args = parseCreateIssueArguments(toolCall.function.arguments)
                    const githubIssue = await createGithubIssueFromReport({
                        request,
                        context,
                        body: {
                            type: args.type,
                            title: args.title,
                            description: args.description,
                            context: {
                                ...clientContext,
                                activePlanId: clientContext.activePlanId || activePlanId
                            }
                        },
                        userEmail,
                        userName
                    })

                    chatMessages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: JSON.stringify({
                            ok: true,
                            issueNumber: githubIssue.number,
                            issueUrl: githubIssue.html_url
                        })
                    } as OpenAI.Chat.ChatCompletionMessageParam)
                } catch (error) {
                    const message = error instanceof Error ? error.message : 'Issue creation failed.'
                    const isValidationError = error instanceof IssueValidationError

                    if (!isValidationError) {
                        context.error(`AI chat issue creation failed for "${userEmail}": ${message}`)
                    }

                    chatMessages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: JSON.stringify({
                            ok: false,
                            error: isValidationError ? message : 'Could not create the issue.'
                        })
                    } as OpenAI.Chat.ChatCompletionMessageParam)
                }
            }
        }
    }

    throw new Error('AI chat exceeded the maximum number of prompt section request rounds.')
}

export async function proxyChatCompletions(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    let userName: string

    try {
        email = getEmailFromToken(request)
        userName = getNameFromToken(request)
    } catch (error) {
        return jsonResponse(request, 401, getAuthenticationErrorPayload(error))
    }

    let body: unknown

    try {
        body = await request.json()
    } catch {
        return jsonResponse(request, 400, { error: 'Request body must be valid JSON.' })
    }

    if (!isChatRequestBody(body)) {
        return jsonResponse(request, 400, { error: 'Request body must be a JSON object with a messages array.' })
    }

    const activePlanId = String(body.activePlanId || '').trim()
    let aiApiKey = ''
    let user: UserDocument | null = null
    let promptUser: UserDocument | null = null

    try {
        const [credentials, users] = await Promise.all([
            getUserAiCredentialsCollection(),
            getUsersCollection()
        ])
        const [record, userRecord] = await Promise.all([
            credentials.findOne({ _id: email }),
            users.findOne({ _id: email })
        ])

        if (!record) {
            return jsonResponse(request, 404, { error: 'No AI API key has been saved for this user.' })
        }

        aiApiKey = getSavedAiApiKey(record, email)

        if (!aiApiKey) {
            return jsonResponse(request, 404, { error: 'No AI API key has been saved for this user.' })
        }

        if (!userRecord) {
            return jsonResponse(request, 404, { error: 'User not found.' })
        }

        user = userRecord
        promptUser = userRecord

        if (activePlanId === DEMO_PLAN_ID && !hasPlan(userRecord, activePlanId)) {
            promptUser = await getDemoUserDocument()

            if (!promptUser) {
                return jsonResponse(request, 404, { error: 'Demo plan configuration was not found.' })
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown MongoDB error.'
        context.error(`Failed to load chat context: ${message}`)

        return jsonResponse(request, 500, { error: 'Failed to load chat context.' })
    }

    try {
        const client = createChatClient(aiApiKey)
        const messages = sanitizeChatMessages(body.messages)
        const computedContext = sanitizeComputedContext(body.computedContext)
        const clientContext = sanitizeClientIssueContext(body.clientContext)

        if (messages.length === 0) {
            return jsonResponse(request, 400, { error: 'At least one user or assistant message is required.' })
        }

        const upstreamStream = await createFinalChatStream({
            client,
            messages,
            user: promptUser as UserDocument,
            activePlanId,
            computedContext,
            clientContext,
            request,
            context,
            userEmail: email,
            userName
        })

        return {
            status: 200,
            headers: {
                ...corsHeaders(request),
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
                'Content-Type': 'text/event-stream; charset=utf-8',
                'X-Accel-Buffering': 'no'
            },
            body: createSseStream(upstreamStream)
        }
    } catch (error) {
        const status = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
            ? error.status
            : 502
        const message = error instanceof Error ? error.message : 'Upstream AI request failed.'

        context.error(`Chat proxy request failed for "${email}": ${message}`)

        return jsonResponse(request, status, { error: 'Failed to generate chat completion.' })
    }
}

app.http('proxy-chat-completions', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'chat/completions',
    handler: withMaintenanceGuard(proxyChatCompletions)
})
