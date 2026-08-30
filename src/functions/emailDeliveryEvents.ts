import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { normalizeEmailAddress } from '../lib/emailPreferences'
import { getEmailDeliveriesCollection, getEmailPreferencesCollection } from '../lib/mongo'

type EventGridEvent = {
    eventType?: string
    eventTime?: string
    data?: {
        validationCode?: string
        messageId?: string
        recipient?: string
        status?: string
    }
}

export async function emailDeliveryEvents(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    if (request.method !== 'POST') {
        return { status: 405, jsonBody: { error: 'Method not allowed. Use POST.' } }
    }

    let events: EventGridEvent[]

    try {
        const body = await request.json()
        events = Array.isArray(body) ? body as EventGridEvent[] : []
    } catch {
        return { status: 400, jsonBody: { error: 'Request body must be valid JSON.' } }
    }

    const validationEvent = events.find((event) =>
        event.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent'
    )

    if (validationEvent?.data?.validationCode) {
        return {
            status: 200,
            jsonBody: { validationResponse: validationEvent.data.validationCode }
        }
    }

    try {
        const preferences = await getEmailPreferencesCollection()
        const deliveries = await getEmailDeliveriesCollection()

        for (const event of events) {
            if (event.eventType !== 'Microsoft.Communication.EmailDeliveryReportReceived') {
                continue
            }

            const email = normalizeEmailAddress(event.data?.recipient)
            const status = String(event.data?.status || '').trim()
            const messageId = String(event.data?.messageId || '').trim()

            if (!email || !status) {
                continue
            }

            const eventTime = event.eventTime || new Date().toISOString()
            const emailDeliverable = !['Bounced', 'Suppressed', 'FilteredSpam'].includes(status)
            const preferenceUpdate: Record<string, unknown> = {
                email,
                emailDeliverable,
                deliveryStatus: status,
                lastDeliveryEventAt: eventTime,
                source: 'delivery-event',
                updatedAt: eventTime
            }

            if (status === 'Bounced') {
                preferenceUpdate.lastBounceAt = eventTime
            }

            await preferences.updateOne(
                { _id: email },
                {
                    $set: preferenceUpdate,
                    $setOnInsert: { productUpdatesSubscribed: true }
                },
                { upsert: true }
            )

            if (messageId) {
                await deliveries.updateOne(
                    { messageId, recipient: email },
                    {
                        $set: {
                            status,
                            updatedAt: eventTime
                        }
                    }
                )
            }
        }

        return { status: 200, jsonBody: { processed: events.length } }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown delivery event error.'
        context.error(`Failed to process email delivery events: ${message}`)
        return { status: 500, jsonBody: { error: 'Failed to process delivery events.' } }
    }
}

app.http('email-delivery-events', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'email/events',
    handler: emailDeliveryEvents
})
