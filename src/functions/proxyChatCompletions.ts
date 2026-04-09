import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { ReadableStream } from 'stream/web'
import OpenAI from 'openai'
import { getEmailFromToken, getJwtSecret } from '../lib/auth'
import { corsHeaders, isOptionsRequest, jsonResponse, optionsResponse } from '../lib/http'
import { getUserAiCredentialsCollection } from '../lib/mongo'

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai'
const GEMINI_MODEL = 'gemini-3-flash-preview'

type ChatRequestBody = Record<string, unknown> & {
    messages: OpenAI.Chat.ChatCompletionMessageParam[]
}

function serializeUnknown(value: unknown, seen = new WeakSet<object>()): unknown {
    if (value === null || value === undefined) {
        return value
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value
    }

    if (Array.isArray(value)) {
        return value.map((item) => serializeUnknown(item, seen))
    }

    if (typeof value === 'object') {
        if (seen.has(value)) {
            return '[Circular]'
        }

        seen.add(value)

        const result: Record<string, unknown> = {}
        for (const key of Object.getOwnPropertyNames(value)) {
            result[key] = serializeUnknown((value as Record<string, unknown>)[key], seen)
        }

        return result
    }

    return String(value)
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

    try {
        const credentials = await getUserAiCredentialsCollection()
        const record = await credentials.findOne({ _id: email })

        if (!record?.aiApiKey) {
            return jsonResponse(request, 404, { error: 'No AI API key has been saved for this user.' })
        }

        aiApiKey = record.aiApiKey
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown MongoDB error.'
        context.error(`Failed to load user AI key: ${message}`)

        return jsonResponse(request, 500, { error: 'Failed to load AI key.' })
    }

    try {
        const client = createChatClient(aiApiKey)
        const upstreamStream = await client.chat.completions.create({
            ...body,
            model: GEMINI_MODEL,
            reasoning_effort: 'medium',
            stream: true,
            stream_options: {
                include_usage: true
            }
        } as OpenAI.Chat.ChatCompletionCreateParamsStreaming)

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
        const serializedError = serializeUnknown(error)

        context.error(`Chat proxy request failed for "${email}": ${message}`)

        return jsonResponse(request, status, {
            error: message || 'Failed to generate chat completion.',
            upstreamError: serializedError
        })
    }
}

app.http('proxy-chat-completions', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'chat/completions',
    handler: proxyChatCompletions
})
