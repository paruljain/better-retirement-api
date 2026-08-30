import jwt, { JwtPayload } from 'jsonwebtoken'
import { EmailPreferenceDocument, getEmailPreferencesCollection } from './mongo'

type UnsubscribeTokenPayload = JwtPayload & {
    email?: string
    purpose?: string
    version?: number
}

export const DEFAULT_EMAIL_PREFERENCES = {
    productUpdatesSubscribed: true,
    emailDeliverable: true
} as const

export function normalizeEmailAddress(value: unknown): string {
    return String(value || '').trim().toLowerCase()
}

export function getEmailUnsubscribeSecret(): string {
    return String(process.env.EMAIL_UNSUBSCRIBE_SECRET || '').trim()
}

export function createUnsubscribeToken(email: string): string {
    const secret = getEmailUnsubscribeSecret()

    if (!secret) {
        throw new Error('EMAIL_UNSUBSCRIBE_SECRET is not configured.')
    }

    return jwt.sign({
        email: normalizeEmailAddress(email),
        purpose: 'product-updates-unsubscribe',
        version: 1
    }, secret)
}

export function readUnsubscribeToken(token: string): string {
    const secret = getEmailUnsubscribeSecret()

    if (!secret) {
        throw new Error('EMAIL_UNSUBSCRIBE_SECRET is not configured.')
    }

    const payload = jwt.verify(token, secret) as UnsubscribeTokenPayload
    const email = normalizeEmailAddress(payload.email)

    if (payload.purpose !== 'product-updates-unsubscribe' || payload.version !== 1 || !email) {
        throw new Error('The unsubscribe link is invalid.')
    }

    return email
}

export function resolveEmailPreferences(document: EmailPreferenceDocument | null) {
    return {
        productUpdatesSubscribed: document?.productUpdatesSubscribed
            ?? DEFAULT_EMAIL_PREFERENCES.productUpdatesSubscribed,
        emailDeliverable: document?.emailDeliverable
            ?? DEFAULT_EMAIL_PREFERENCES.emailDeliverable,
        unsubscribedAt: document?.unsubscribedAt || null
    }
}

export async function updateProductUpdatePreference(
    emailValue: string,
    subscribed: boolean,
    source: EmailPreferenceDocument['source']
) {
    const email = normalizeEmailAddress(emailValue)
    const now = new Date().toISOString()
    const emailPreferences = await getEmailPreferencesCollection()
    const subscriptionDates = subscribed
        ? { subscribedAt: now }
        : { unsubscribedAt: now }
    const dateToClear = subscribed ? 'unsubscribedAt' : 'subscribedAt'
    const explicitResubscription = subscribed && source === 'account-preferences'

    await emailPreferences.updateOne(
        { _id: email },
        {
            $set: {
                email,
                productUpdatesSubscribed: subscribed,
                source,
                updatedAt: now,
                ...(explicitResubscription
                    ? {
                        emailDeliverable: true,
                        deliveryStatus: 'Pending'
                    }
                    : {}),
                ...subscriptionDates
            },
            $setOnInsert: {
                emailDeliverable: true
            },
            $unset: {
                [dateToClear]: ''
            }
        },
        { upsert: true }
    )

    return resolveEmailPreferences(await emailPreferences.findOne({ _id: email }))
}
