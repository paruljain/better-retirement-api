import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { ReadableStream } from 'stream/web'
import OpenAI from 'openai'
import { getEmailFromToken, getJwtSecret } from '../lib/auth'
import { corsHeaders, isOptionsRequest, jsonResponse, optionsResponse } from '../lib/http'
import { buildActivePlanPromptDigest } from '../lib/aiChatPromptDigest'
import { AiChatPromptDocument, getAiChatPromptsCollection, getUserAiCredentialsCollection, getUsersCollection, UserDocument } from '../lib/mongo'

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'
const GEMINI_MODEL = 'gemini-3-flash-preview'
const INSTRUCTIONS_PROMPT_ID = 'instructions'
const ACTIVE_PLAN_DIGEST_SECTION_ID = 'active-plan-digest'
const GET_PROMPT_SECTIONS_TOOL_NAME = 'get_prompt_sections'
const MAX_TOOL_ROUNDS = 5

type ChatRequestBody = Record<string, unknown> & {
    messages: OpenAI.Chat.ChatCompletionMessageParam[]
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

function buildPromptSectionCatalogText(promptSections: AiChatPromptDocument[]): string {
    const staticSections = [
        `- ${ACTIVE_PLAN_DIGEST_SECTION_ID}: The current active plan summarized from the saved plan document, including household, account, income, expense, transfer, healthcare, and Roth conversion inputs.`
    ]
    const databaseSections = promptSections
        .filter((section) => section._id !== INSTRUCTIONS_PROMPT_ID && section.enabled !== false)
        .sort((left, right) => left._id.localeCompare(right._id))
        .map((section) => {
            const description = String(section.description || section.title || '').trim()
            return `- ${section._id}: ${description || section._id}`
        })

    return [...staticSections, ...databaseSections].join('\n')
}

async function buildSystemPrompt(): Promise<string> {
    const prompts = await getAiChatPromptsCollection()
    const promptSections = await prompts.find({
        $or: [
            { enabled: true },
            { _id: INSTRUCTIONS_PROMPT_ID }
        ]
    }).toArray()
    const instructions = promptSections.find((section) => section._id === INSTRUCTIONS_PROMPT_ID)
    const instructionsContent = String(instructions?.content || '').trim()

    if (!instructionsContent) {
        throw new Error('AI chat instructions prompt is missing.')
    }

    return `${instructionsContent}

Available prompt sections:
${buildPromptSectionCatalogText(promptSections)}

Use the ${GET_PROMPT_SECTIONS_TOOL_NAME} tool to retrieve any sections needed before answering. Do not ask the user to retrieve prompt sections.`
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

async function buildPromptSectionBundle(sectionIds: string[], user: UserDocument): Promise<string> {
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
            return `Section: ${ACTIVE_PLAN_DIGEST_SECTION_ID}\n${buildActivePlanPromptDigest(user)}`
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

async function* createTextCompletionStream(text: string): AsyncIterable<OpenAI.Chat.ChatCompletionChunk> {
    yield {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: GEMINI_MODEL,
        choices: [
            {
                index: 0,
                delta: {
                    content: text
                },
                finish_reason: null
            }
        ]
    } as OpenAI.Chat.ChatCompletionChunk

    yield {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: GEMINI_MODEL,
        choices: [
            {
                index: 0,
                delta: {},
                finish_reason: 'stop'
            }
        ]
    } as OpenAI.Chat.ChatCompletionChunk
}

async function createFinalChatStream({
    client,
    messages,
    user
}: {
    client: OpenAI
    messages: OpenAI.Chat.ChatCompletionMessageParam[]
    user: UserDocument
}): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> {
    const tools = [getPromptSectionTool()]
    const chatMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        {
            role: 'system',
            content: await buildSystemPrompt()
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
            return createTextCompletionStream(getTextContent(assistantMessage.content))
        }

        chatMessages.push(assistantMessage as OpenAI.Chat.ChatCompletionMessageParam)

        for (const toolCall of toolCalls) {
            if (toolCall.type !== 'function' || toolCall.function?.name !== GET_PROMPT_SECTIONS_TOOL_NAME) {
                continue
            }

            const args = parseToolArguments(toolCall.function.arguments)
            const sectionBundle = await buildPromptSectionBundle(args.sectionIds, user)

            chatMessages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: sectionBundle
            } as OpenAI.Chat.ChatCompletionMessageParam)
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

    try {
        email = getEmailFromToken(request)
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid token.'
        return jsonResponse(request, 401, { error: message })
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

    let aiApiKey = ''
    let user: UserDocument | null = null

    try {
        const [credentials, users] = await Promise.all([
            getUserAiCredentialsCollection(),
            getUsersCollection()
        ])
        const [record, userRecord] = await Promise.all([
            credentials.findOne({ _id: email }),
            users.findOne({ _id: email })
        ])

        if (!record?.aiApiKey) {
            return jsonResponse(request, 404, { error: 'No AI API key has been saved for this user.' })
        }

        if (!userRecord) {
            return jsonResponse(request, 404, { error: 'User not found.' })
        }

        aiApiKey = record.aiApiKey
        user = userRecord
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown MongoDB error.'
        context.error(`Failed to load chat context: ${message}`)

        return jsonResponse(request, 500, { error: 'Failed to load chat context.' })
    }

    try {
        const client = createChatClient(aiApiKey)
        const messages = sanitizeChatMessages(body.messages)

        if (messages.length === 0) {
            return jsonResponse(request, 400, { error: 'At least one user or assistant message is required.' })
        }

        const upstreamStream = await createFinalChatStream({
            client,
            messages,
            user: user as UserDocument
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
    handler: proxyChatCompletions
})
