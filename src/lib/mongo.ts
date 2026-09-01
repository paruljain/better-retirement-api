import { Collection, Document, MongoClient } from 'mongodb'

export type UserDocument = Document & {
    _id: string
    email: string
    updatedAt: string
    lastActiveAt?: Date
}

export type UserActivityDailyDocument = Document & {
    _id: string
    userId: string
    activityDate: string
    lastSeenAt: Date
}

export type UserAiCredentialDocument = Document & {
    _id: string
    aiApiKey?: string
    aiApiKeyEncrypted?: string
    aiApiKeyIv?: string
    aiApiKeyTag?: string
    aiApiKeyKeyVersion?: string
    updatedAt: string
}

export type EmailPreferenceDocument = Document & {
    _id: string
    email: string
    productUpdatesSubscribed: boolean
    emailDeliverable: boolean
    source: 'existing-account' | 'account-preferences' | 'email-unsubscribe' | 'delivery-event'
    subscribedAt?: string
    unsubscribedAt?: string
    updatedAt: string
    deliveryStatus?: string
    lastDeliveryEventAt?: string
    lastBounceAt?: string
}

export type EmailCampaignDocument = Document & {
    _id: string
    subject: string
    contentHash: string
    markdown: string
    status: 'draft' | 'testing' | 'sending' | 'completed' | 'completed-with-errors'
    audienceCount: number
    sentCount: number
    failedCount: number
    skippedCount: number
    createdAt: string
    updatedAt: string
    startedAt?: string
    completedAt?: string
}

export type EmailDeliveryDocument = Document & {
    _id: string
    campaignId: string
    recipient: string
    kind: 'test' | 'campaign'
    status: string
    attemptCount: number
    messageId?: string
    error?: string
    createdAt: string
    updatedAt: string
}

export type PlaidAccountSnapshot = {
    accountId: string
    name: string
    officialName?: string
    mask?: string
    type?: string
    subtype?: string
    balances?: {
        available?: number | null
        current?: number | null
        limit?: number | null
        isoCurrencyCode?: string | null
        unofficialCurrencyCode?: string | null
    }
}

export type PlaidHoldingSnapshot = {
    accountId: string
    securityId: string
    quantity?: number | null
    costBasis?: number | null
    institutionPrice?: number | null
    institutionPriceAsOf?: string | null
    institutionPriceDatetime?: string | null
    institutionValue?: number | null
    isoCurrencyCode?: string | null
    unofficialCurrencyCode?: string | null
}

export type PlaidSecuritySnapshot = {
    securityId: string
    name?: string | null
    tickerSymbol?: string | null
    type?: string | null
    closePrice?: number | null
    closePriceAsOf?: string | null
    updateDatetime?: string | null
    isoCurrencyCode?: string | null
    unofficialCurrencyCode?: string | null
}

export type PlaidConnectionItem = {
    itemId: string
    institutionId?: string
    institutionName?: string
    accessTokenEncrypted: string
    accessTokenIv: string
    accessTokenTag: string
    accessTokenKeyVersion: string
    accounts: PlaidAccountSnapshot[]
    holdings?: PlaidHoldingSnapshot[]
    securities?: PlaidSecuritySnapshot[]
    createdAt: string
    updatedAt: string
    lastSyncedAt?: string
    lastError?: string
    holdingsLastSyncedAt?: string
    holdingsError?: string
    holdingsRefreshRequestedAt?: string
    holdingsRefreshError?: string
}

export type UserPlaidConnectionDocument = Document & {
    _id: string
    plaidClientIdEncrypted?: string
    plaidClientIdIv?: string
    plaidClientIdTag?: string
    plaidClientIdKeyVersion?: string
    plaidSecretEncrypted?: string
    plaidSecretIv?: string
    plaidSecretTag?: string
    plaidSecretKeyVersion?: string
    environment?: 'sandbox' | 'development' | 'production'
    items?: PlaidConnectionItem[]
    updatedAt: string
}

export type AiChatFeedbackDocument = Document & {
    userId: string
    userName: string
    createdAt: string
    rating: 'up' | 'down'
    reason?: string
    comment?: string
    route?: string
    browser?: string
    screen?: string
    activePlan?: string
    user?: string
    assistant?: string
    appVersion?: string
}

export type AiChatPromptDocument = Document & {
    _id: string
    title?: string
    description?: string
    content: string
    sourceFile?: string
    enabled?: boolean
    updatedAt?: Date
    updatedBy?: string
}

export type AccessListDocument = Document & {
    _id: string
    emails: string[]
    updatedAt?: string
}

export type AppConfigDocument = Document & {
    _id: string
    schemaVersion?: number
    plans?: Document[]
    enabled?: boolean
    message?: string
    expectedEndAt?: string
    operationId?: string
    requiredSchemaVersion?: number
    retryAfterSeconds?: number
    startedAt?: string
    updatedAt?: string
}

let mongoClient: MongoClient | null = null

function getMongoConnectionString(): string {
    return process.env.MONGODB_URI || ''
}

function getMongoDatabaseName(): string {
    return process.env.MONGODB_DB_NAME || ''
}

async function getDatabase() {
    const connectionString = getMongoConnectionString()
    const databaseName = getMongoDatabaseName()

    if (!connectionString || !databaseName) {
        throw new Error('MongoDB configuration is incomplete.')
    }

    if (!mongoClient) {
        mongoClient = new MongoClient(connectionString)
        await mongoClient.connect()
    }

    return mongoClient.db(databaseName)
}

export async function getUsersCollection(): Promise<Collection<UserDocument>> {
    const database = await getDatabase()
    return database.collection<UserDocument>('users')
}

export async function getUserActivityDailyCollection(): Promise<Collection<UserActivityDailyDocument>> {
    const database = await getDatabase()
    return database.collection<UserActivityDailyDocument>('userActivityDaily')
}

export async function getUserAiCredentialsCollection(): Promise<Collection<UserAiCredentialDocument>> {
    const database = await getDatabase()
    return database.collection<UserAiCredentialDocument>('userAiCredentials')
}

export async function getEmailPreferencesCollection(): Promise<Collection<EmailPreferenceDocument>> {
    const database = await getDatabase()
    return database.collection<EmailPreferenceDocument>('emailPreferences')
}

export async function getEmailCampaignsCollection(): Promise<Collection<EmailCampaignDocument>> {
    const database = await getDatabase()
    return database.collection<EmailCampaignDocument>('emailCampaigns')
}

export async function getEmailDeliveriesCollection(): Promise<Collection<EmailDeliveryDocument>> {
    const database = await getDatabase()
    return database.collection<EmailDeliveryDocument>('emailDeliveries')
}

export async function getUserPlaidConnectionsCollection(): Promise<Collection<UserPlaidConnectionDocument>> {
    const database = await getDatabase()
    return database.collection<UserPlaidConnectionDocument>('userPlaidConnections')
}

export async function getAiChatFeedbackCollection(): Promise<Collection<AiChatFeedbackDocument>> {
    const database = await getDatabase()
    return database.collection<AiChatFeedbackDocument>('aiChatFeedback')
}

export async function getAiChatPromptsCollection(): Promise<Collection<AiChatPromptDocument>> {
    const database = await getDatabase()
    return database.collection<AiChatPromptDocument>('ai-chat-prompts')
}

export async function getAccessListCollection(): Promise<Collection<AccessListDocument>> {
    const database = await getDatabase()
    return database.collection<AccessListDocument>('accessList')
}

export async function getAppConfigCollection(): Promise<Collection<AppConfigDocument>> {
    const database = await getDatabase()
    return database.collection<AppConfigDocument>('appConfig')
}
