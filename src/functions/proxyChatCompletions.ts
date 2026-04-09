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

type TimingLogDetails = {
    email?: string
    requestId?: string
    elapsedMs: number
    extra?: Record<string, unknown>
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

function logTiming(context: InvocationContext, step: string, details: TimingLogDetails): void {
    const suffix = details.extra ? ` ${JSON.stringify(details.extra)}` : ''
    const emailPart = details.email ? ` email="${details.email}"` : ''
    const requestIdPart = details.requestId ? ` requestId="${details.requestId}"` : ''

    context.log(`[chat-proxy] ${step}${emailPart}${requestIdPart} elapsedMs=${details.elapsedMs}${suffix}`)
}

function createSseStream(
    stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    context: InvocationContext,
    details: {
        email: string
        requestId?: string
        requestStartedAt: number
        upstreamStartedAt: number
    }
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()

    return new ReadableStream<Uint8Array>({
        async start(controller) {
            let chunkCount = 0
            let firstChunkAt: number | null = null

            try {
                for await (const chunk of stream) {
                    chunkCount += 1

                    if (firstChunkAt === null) {
                        firstChunkAt = Date.now()
                        logTiming(context, 'upstream-first-chunk', {
                            email: details.email,
                            requestId: details.requestId,
                            elapsedMs: firstChunkAt - details.requestStartedAt,
                            extra: {
                                upstreamWaitMs: firstChunkAt - details.upstreamStartedAt
                            }
                        })
                    }

                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
                }

                logTiming(context, 'upstream-complete', {
                    email: details.email,
                    requestId: details.requestId,
                    elapsedMs: Date.now() - details.requestStartedAt,
                    extra: {
                        upstreamDurationMs: Date.now() - details.upstreamStartedAt,
                        chunkCount
                    }
                })
                controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                controller.close()
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown streaming error.'
                context.error(`[chat-proxy] upstream-stream-error email="${details.email}" requestId="${details.requestId ?? ''}" elapsedMs=${Date.now() - details.requestStartedAt} message="${message}"`)
                controller.error(error)
            }
        }
    })
}

export async function proxyChatCompletions(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const requestStartedAt = Date.now()
    const requestId = request.headers.get('x-ms-request-id') ?? request.headers.get('x-request-id') ?? undefined

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
        logTiming(context, 'jwt-validated', {
            email,
            requestId,
            elapsedMs: Date.now() - requestStartedAt
        })
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
        logTiming(context, 'ai-key-loaded', {
            email,
            requestId,
            elapsedMs: Date.now() - requestStartedAt
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown MongoDB error.'
        context.error(`Failed to load user AI key: ${message}`)

        return jsonResponse(request, 500, { error: 'Failed to load AI key.' })
    }

    try {
        const client = createChatClient(aiApiKey)
        const upstreamStartedAt = Date.now()
        logTiming(context, 'upstream-request-started', {
            email,
            requestId,
            elapsedMs: upstreamStartedAt - requestStartedAt,
            extra: {
                messageCount: body.messages.length
            }
        })
        const upstreamStream = await client.chat.completions.create({
            ...body,
            model: GEMINI_MODEL,
            reasoning_effort: 'medium',
            stream: true,
            stream_options: {
                include_usage: true
            }
        } as OpenAI.Chat.ChatCompletionCreateParamsStreaming)
        logTiming(context, 'upstream-stream-opened', {
            email,
            requestId,
            elapsedMs: Date.now() - requestStartedAt,
            extra: {
                upstreamOpenMs: Date.now() - upstreamStartedAt
            }
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
            body: createSseStream(upstreamStream, context, {
                email,
                requestId,
                requestStartedAt,
                upstreamStartedAt
            })
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
