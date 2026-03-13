import { Collection, Document, MongoClient } from 'mongodb'

export type UserDocument = Document & {
    _id: string
    email: string
    updatedAt: string
}

let mongoClient: MongoClient | null = null

function getMongoConnectionString(): string {
    return process.env.MONGODB_URI || ''
}

function getMongoDatabaseName(): string {
    return process.env.MONGODB_DB_NAME || ''
}

function getMongoCollectionName(): string {
    return process.env.MONGODB_USERS_COLLECTION || 'users'
}

export async function getUsersCollection(): Promise<Collection<UserDocument>> {
    const connectionString = getMongoConnectionString()
    const databaseName = getMongoDatabaseName()

    if (!connectionString || !databaseName) {
        throw new Error('MongoDB configuration is incomplete.')
    }

    if (!mongoClient) {
        mongoClient = new MongoClient(connectionString)
        await mongoClient.connect()
    }

    return mongoClient.db(databaseName).collection<UserDocument>(getMongoCollectionName())
}
