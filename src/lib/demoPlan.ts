import { AppConfigDocument, getAppConfigCollection, UserDocument } from './mongo'

export const DEMO_USER_DOCUMENT_CONFIG_ID = 'demo-user-document'
export const DEMO_PLAN_ID = 'demo'

function asUserDocument(document: AppConfigDocument): UserDocument {
    return {
        ...document,
        _id: DEMO_USER_DOCUMENT_CONFIG_ID,
        email: 'demo@example.com',
        updatedAt: typeof document.updatedAt === 'string' ? document.updatedAt : ''
    } as UserDocument
}

export async function getDemoUserDocument(): Promise<UserDocument | null> {
    const appConfig = await getAppConfigCollection()
    const demoUserDocument = await appConfig.findOne({ _id: DEMO_USER_DOCUMENT_CONFIG_ID })

    if (!demoUserDocument) {
        return null
    }

    return asUserDocument(demoUserDocument)
}
