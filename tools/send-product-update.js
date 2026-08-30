const { createHash } = require('crypto')
const { existsSync, readFileSync } = require('fs')
const { resolve } = require('path')
const { EmailClient } = require('@azure/communication-email')
const { MongoClient } = require('mongodb')
const { sendProductUpdateEmail } = require('../dist/src/lib/productUpdateEmail')

const SUCCESS_STATUSES = new Set(['Accepted', 'Succeeded', 'Delivered'])

function loadConfigurationFile(path) {
    if (!existsSync(path)) {
        return
    }

    if (path.endsWith('.json')) {
        const settings = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
        const values = settings && typeof settings === 'object' ? settings.Values : null

        for (const [key, value] of Object.entries(values || {})) {
            if (!process.env[key] && typeof value === 'string') {
                process.env[key] = value
            }
        }
        return
    }

    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim()

        if (!trimmed || trimmed.startsWith('#')) {
            continue
        }

        const separatorIndex = trimmed.indexOf('=')
        if (separatorIndex === -1) {
            continue
        }

        const key = trimmed.slice(0, separatorIndex).trim()
        let value = trimmed.slice(separatorIndex + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
        }

        if (!process.env[key]) {
            process.env[key] = value
        }
    }
}

function loadConfiguration() {
    loadConfigurationFile(resolve(process.cwd(), '.env'))
    loadConfigurationFile(resolve(process.cwd(), 'local.settings.json'))
}

function getArgument(name) {
    const index = process.argv.indexOf(name)
    return index === -1 ? '' : String(process.argv[index + 1] || '').trim()
}

function hasArgument(name) {
    return process.argv.includes(name)
}

function getMode() {
    if (hasArgument('--send')) {
        return 'send'
    }

    if (hasArgument('--test')) {
        return 'test'
    }

    return 'preview'
}

function requireValue(value, message) {
    if (!value) {
        throw new Error(message)
    }

    return value
}

function isEmailAddress(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function getConfiguration(mode) {
    const configuration = {
        mongoConnectionString: requireValue(process.env.MONGODB_URI, 'MONGODB_URI is not configured.'),
        mongoDatabaseName: requireValue(process.env.MONGODB_DB_NAME, 'MONGODB_DB_NAME is not configured.'),
        emailConnectionString: process.env.AZURE_COMMUNICATION_EMAIL_CONNECTION_STRING || '',
        senderAddress: process.env.EMAIL_SENDER_ADDRESS || '',
        replyToAddress: process.env.EMAIL_REPLY_TO_ADDRESS || '',
        publicApiBaseUrl: process.env.EMAIL_PUBLIC_API_BASE_URL || '',
        postalAddress: process.env.EMAIL_POSTAL_ADDRESS || '',
        sendIntervalMs: Math.max(2100, Number(process.env.EMAIL_SEND_INTERVAL_MS) || 2100)
    }

    if (mode !== 'preview') {
        requireValue(configuration.emailConnectionString, 'AZURE_COMMUNICATION_EMAIL_CONNECTION_STRING is not configured.')
        requireValue(configuration.senderAddress, 'EMAIL_SENDER_ADDRESS is not configured.')
        requireValue(configuration.publicApiBaseUrl, 'EMAIL_PUBLIC_API_BASE_URL is not configured.')
        requireValue(process.env.EMAIL_UNSUBSCRIBE_SECRET, 'EMAIL_UNSUBSCRIBE_SECRET is not configured.')

        if (!configuration.postalAddress) {
            console.warn('Warning: EMAIL_POSTAL_ADDRESS is not configured. Emails will be sent without a postal address.')
        }
    }

    return configuration
}

function delay(milliseconds) {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function maskEmail(email) {
    const [localPart, domain] = email.split('@')
    return `${localPart.slice(0, 2)}***@${domain}`
}

function readCampaignContent(messagePath) {
    const source = readFileSync(messagePath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
    const lines = source.split('\n')
    const subjectMatch = lines[0]?.match(/^Subject:\s*(.+)$/i)
    const subject = getArgument('--subject') || String(subjectMatch?.[1] || '').trim()

    if (subjectMatch) {
        lines.shift()
        if (!lines[0]?.trim()) {
            lines.shift()
        }
    }

    return {
        subject: requireValue(subject, 'Add a Subject: line to the message file or provide --subject.'),
        markdown: requireValue(lines.join('\n').trim(), 'The message file is empty.')
    }
}

async function getAudience(database) {
    const users = await database.collection('users')
        .find({}, { projection: { _id: 1, email: 1 } })
        .toArray()
    const emails = Array.from(new Set(users
        .map((user) => String(user.email || user._id || '').trim().toLowerCase())
        .filter(isEmailAddress)))
        .sort()
    const preferences = await database.collection('emailPreferences')
        .find({ _id: { $in: emails } })
        .toArray()
    const preferencesByEmail = new Map(preferences.map((preference) => [preference._id, preference]))
    const recipients = []
    let unsubscribedCount = 0
    let undeliverableCount = 0

    for (const email of emails) {
        const preference = preferencesByEmail.get(email)
        if (preference?.productUpdatesSubscribed === false) {
            unsubscribedCount += 1
        } else if (preference?.emailDeliverable === false) {
            undeliverableCount += 1
        } else {
            recipients.push(email)
        }
    }

    return {
        recipients,
        totalUserEmails: emails.length,
        unsubscribedCount,
        undeliverableCount
    }
}

function showPreview({ campaignId, subject, markdown, contentHash, audience }) {
    const confirmation = `${campaignId}:${audience.recipients.length}:${contentHash.slice(0, 12)}`
    console.log(`Campaign: ${campaignId}`)
    console.log(`Subject: ${subject}`)
    console.log(`Eligible recipients: ${audience.recipients.length}`)
    console.log(`Excluded as unsubscribed: ${audience.unsubscribedCount}`)
    console.log(`Excluded as undeliverable: ${audience.undeliverableCount}`)
    console.log(`Total user email addresses: ${audience.totalUserEmails}`)
    console.log(`Sample recipients: ${audience.recipients.slice(0, 5).map(maskEmail).join(', ') || 'none'}`)
    console.log('')
    console.log('Message preview:')
    console.log(markdown)
    console.log('')
    console.log(`Confirmation value: ${confirmation}`)
    console.log('No email was sent.')
}

async function sendOne({ emailClient, deliveries, campaignId, recipient, kind, subject, markdown, configuration }) {
    const now = new Date().toISOString()
    const deliveryId = kind === 'test'
        ? `${campaignId}:test:${recipient}:${Date.now()}`
        : `${campaignId}:${recipient}`

    if (kind === 'campaign') {
        const existing = await deliveries.findOne({ _id: deliveryId })
        if (existing && (SUCCESS_STATUSES.has(existing.status) || existing.status === 'Sending')) {
            return { skipped: true, status: existing.status }
        }

        if (existing?.status === 'Failed' && !hasArgument('--retry-failed')) {
            return { skipped: true, status: existing.status }
        }
    }

    await deliveries.updateOne(
        { _id: deliveryId },
        {
            $set: {
                campaignId,
                recipient,
                kind,
                status: 'Sending',
                error: '',
                updatedAt: now
            },
            $setOnInsert: {
                createdAt: now
            },
            $inc: { attemptCount: 1 }
        },
        { upsert: true }
    )

    try {
        const result = await sendProductUpdateEmail(emailClient, {
            recipient,
            subject,
            markdown,
            senderAddress: configuration.senderAddress,
            replyToAddress: configuration.replyToAddress,
            publicApiBaseUrl: configuration.publicApiBaseUrl,
            postalAddress: configuration.postalAddress
        })
        const status = String(result.status || 'Accepted')

        await deliveries.updateOne(
            { _id: deliveryId },
            {
                $set: {
                    status,
                    messageId: result.id || '',
                    updatedAt: new Date().toISOString()
                }
            }
        )

        return { skipped: false, status }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await deliveries.updateOne(
            { _id: deliveryId },
            {
                $set: {
                    status: 'Failed',
                    error: message,
                    updatedAt: new Date().toISOString()
                }
            }
        )
        return { skipped: false, status: 'Failed', error: message }
    }
}

async function isRecipientStillEligible(database, recipient) {
    const preference = await database.collection('emailPreferences').findOne({ _id: recipient })
    return preference?.productUpdatesSubscribed !== false && preference?.emailDeliverable !== false
}

async function main() {
    loadConfiguration()

    const mode = getMode()
    const configuration = getConfiguration(mode)
    const campaignId = requireValue(getArgument('--campaign'), 'Provide --campaign with a stable kebab-case campaign ID.')
    const messagePath = resolve(process.cwd(), requireValue(getArgument('--file'), 'Provide --file with the message file path.'))

    if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(campaignId)) {
        throw new Error('Campaign ID must be 3-80 lowercase letters, numbers, or hyphens.')
    }

    if (!existsSync(messagePath)) {
        throw new Error(`Message file does not exist: ${messagePath}`)
    }

    const { subject, markdown } = readCampaignContent(messagePath)
    const contentHash = createHash('sha256').update(`${subject}\n${markdown}`).digest('hex')
    const mongoClient = new MongoClient(configuration.mongoConnectionString)
    await mongoClient.connect()

    try {
        const database = mongoClient.db(configuration.mongoDatabaseName)
        const audience = await getAudience(database)

        if (mode === 'preview') {
            showPreview({ campaignId, subject, markdown, contentHash, audience })
            return
        }

        const emailClient = new EmailClient(configuration.emailConnectionString)
        const deliveries = database.collection('emailDeliveries')
        await deliveries.createIndex({ messageId: 1, recipient: 1 })
        await deliveries.createIndex({ campaignId: 1, kind: 1, status: 1 })

        if (mode === 'test') {
            const recipient = requireValue(getArgument('--to'), 'Provide --to with the test recipient email address.').toLowerCase()
            if (!isEmailAddress(recipient)) {
                throw new Error('The test recipient is not a valid email address.')
            }

            const result = await sendOne({
                emailClient,
                deliveries,
                campaignId,
                recipient,
                kind: 'test',
                subject: `[TEST] ${subject}`,
                markdown,
                configuration
            })
            console.log(`Test email status for ${maskEmail(recipient)}: ${result.status}`)
            return
        }

        if (!audience.recipients.length) {
            throw new Error('There are no eligible recipients.')
        }

        const expectedConfirmation = `${campaignId}:${audience.recipients.length}:${contentHash.slice(0, 12)}`
        if (getArgument('--confirm') !== expectedConfirmation) {
            throw new Error(`Confirmation does not match. Preview again and use: --confirm ${expectedConfirmation}`)
        }

        const campaigns = database.collection('emailCampaigns')
        const existingCampaign = await campaigns.findOne({ _id: campaignId })
        if (existingCampaign && existingCampaign.contentHash !== contentHash) {
            throw new Error('This campaign ID was already used with different content. Choose a new campaign ID.')
        }
        if (existingCampaign?.status === 'completed') {
            throw new Error('This campaign already completed. It will not be sent again.')
        }
        if (existingCampaign?.status === 'sending' && !hasArgument('--resume')) {
            throw new Error('This campaign is already marked as sending. Use --resume only after verifying that no other sender process is running.')
        }

        const startedAt = new Date().toISOString()
        await campaigns.updateOne(
            { _id: campaignId },
            {
                $set: {
                    subject,
                    markdown,
                    contentHash,
                    status: 'sending',
                    audienceCount: audience.recipients.length,
                    updatedAt: startedAt,
                    startedAt
                },
                $setOnInsert: {
                    createdAt: startedAt,
                    sentCount: 0,
                    failedCount: 0,
                    skippedCount: 0
                }
            },
            { upsert: true }
        )

        let processedCount = 0
        for (const recipient of audience.recipients) {
            if (!await isRecipientStillEligible(database, recipient)) {
                processedCount += 1
                console.log(`[${processedCount}/${audience.recipients.length}] ${maskEmail(recipient)}: Skipped after a preference or delivery-status change`)
                continue
            }

            const result = await sendOne({
                emailClient,
                deliveries,
                campaignId,
                recipient,
                kind: 'campaign',
                subject,
                markdown,
                configuration
            })
            processedCount += 1
            console.log(`[${processedCount}/${audience.recipients.length}] ${maskEmail(recipient)}: ${result.skipped ? 'Skipped ' : ''}${result.status}`)

            if (processedCount < audience.recipients.length) {
                await delay(configuration.sendIntervalMs)
            }
        }

        const campaignDeliveries = await deliveries.find({ campaignId, kind: 'campaign' }).toArray()
        const sentCount = campaignDeliveries.filter((delivery) => SUCCESS_STATUSES.has(delivery.status)).length
        const failedCount = campaignDeliveries.filter((delivery) => delivery.status === 'Failed').length
        const unresolvedCount = campaignDeliveries.filter((delivery) => delivery.status === 'Sending').length
        const skippedCount = Math.max(0, audience.recipients.length - campaignDeliveries.length)
        const completedAt = new Date().toISOString()
        const status = failedCount || unresolvedCount ? 'completed-with-errors' : 'completed'

        await campaigns.updateOne(
            { _id: campaignId },
            {
                $set: {
                    status,
                    sentCount,
                    failedCount,
                    skippedCount,
                    completedAt,
                    updatedAt: completedAt
                }
            }
        )

        console.log(`Campaign ${status}: ${sentCount} accepted, ${failedCount} failed, ${unresolvedCount} unresolved, ${skippedCount} skipped.`)
    } finally {
        await mongoClient.close()
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
})
