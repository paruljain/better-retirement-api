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
    aiApiKey: string
    updatedAt: string
}

export type AccessListDocument = Document & {
    _id: string
    emails: string[]
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

export async function getAccessListCollection(): Promise<Collection<AccessListDocument>> {
    const database = await getDatabase()
    return database.collection<AccessListDocument>('accessList')
}
