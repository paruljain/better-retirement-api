import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { createHash } from 'crypto'
import { getAuthenticationErrorPayload, getEmailFromToken, getJwtSecret } from '../lib/auth'
import { decryptSecret, encryptSecret, hasAppEncryptionKey } from '../lib/encryption'
import { isOptionsRequest, jsonResponse, optionsResponse } from '../lib/http'
import { withMaintenanceGuard } from '../lib/maintenance'
import { getUserPlaidConnectionsCollection, getUsersCollection, PlaidAccountSnapshot, PlaidConnectionItem, PlaidHoldingSnapshot, PlaidSecuritySnapshot, UserDocument, UserPlaidConnectionDocument } from '../lib/mongo'

type PlaidEnvironment = 'sandbox' | 'development' | 'production'

type PlaidCredentials = {
    clientId: string
    secret: string
    environment: PlaidEnvironment
}

type LinkApplyResult = {
    status: 'updated' | 'skipped'
    message?: string
    targetAccountId?: string
    targetAccountName?: string
    targetHoldingId?: string
    targetHoldingName?: string
    oldValue?: number
    newValue?: number
}

const PLAID_ENVIRONMENTS: PlaidEnvironment[] = ['sandbox', 'development', 'production']
const PLAID_BASE_URLS: Record<PlaidEnvironment, string> = {
    sandbox: 'https://sandbox.plaid.com',
    development: 'https://development.plaid.com',
    production: 'https://production.plaid.com'
}
const DEFAULT_PLAID_OAUTH_REDIRECT_URI = 'https://better-retirement.com/connections/oauth-return'

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeEnvironment(value: unknown): PlaidEnvironment {
    return PLAID_ENVIRONMENTS.includes(value as PlaidEnvironment)
        ? value as PlaidEnvironment
        : 'production'
}

function getPlaidClientUserId(email: string): string {
    return createHash('sha256')
        .update(`better-retirement:plaid:${email.trim().toLowerCase()}`)
        .digest('hex')
}

function getPlaidOauthRedirectUri(value: string): string {
    const configuredRedirectUri = (process.env.PLAID_OAUTH_REDIRECT_URI || '').trim()

    if (configuredRedirectUri) {
        return configuredRedirectUri
    }

    try {
        const url = new URL(value)

        if (url.protocol === 'https:') {
            return value
        }
    } catch {
        return DEFAULT_PLAID_OAUTH_REDIRECT_URI
    }

    return DEFAULT_PLAID_OAUTH_REDIRECT_URI
}

function getRequiredAuthEmail(request: HttpRequest, context: InvocationContext): string | HttpResponseInit {
    if (!getJwtSecret()) {
        context.error('APP_JWT_SECRET is not configured.')
        return jsonResponse(request, 500, { error: 'Server configuration is incomplete.' })
    }

    try {
        return getEmailFromToken(request)
    } catch (error) {
        return jsonResponse(request, 401, getAuthenticationErrorPayload(error))
    }
}

async function readJsonObject(request: HttpRequest): Promise<Record<string, unknown> | HttpResponseInit> {
    let body: unknown

    try {
        body = await request.json()
    } catch {
        return jsonResponse(request, 400, { error: 'Request body must be valid JSON.' })
    }

    if (!isPlainObject(body)) {
        return jsonResponse(request, 400, { error: 'Request body must be a JSON object.' })
    }

    return body
}

function getEncryptedField(record: UserPlaidConnectionDocument, field: 'plaidClientId' | 'plaidSecret', aad: string): string {
    const encryptedValue = record[`${field}Encrypted`]
    const iv = record[`${field}Iv`]
    const tag = record[`${field}Tag`]
    const keyVersion = record[`${field}KeyVersion`]

    if (!encryptedValue || !iv || !tag || !keyVersion) {
        return ''
    }

    return decryptSecret({
        encryptedValue,
        iv,
        tag,
        keyVersion
    }, aad)
}

function getPlaidCredentials(record: UserPlaidConnectionDocument | null, email: string): PlaidCredentials | null {
    if (!record) {
        return null
    }

    const clientId = getEncryptedField(record, 'plaidClientId', `userPlaidConnections:${email}:plaidClientId`)
    const secret = getEncryptedField(record, 'plaidSecret', `userPlaidConnections:${email}:plaidSecret`)

    if (!clientId || !secret) {
        return null
    }

    return {
        clientId,
        secret,
        environment: sanitizeEnvironment(record.environment)
    }
}

function decryptAccessToken(item: PlaidConnectionItem, email: string): string {
    return decryptSecret({
        encryptedValue: item.accessTokenEncrypted,
        iv: item.accessTokenIv,
        tag: item.accessTokenTag,
        keyVersion: item.accessTokenKeyVersion
    }, `userPlaidConnections:${email}:items:${item.itemId}:accessToken`)
}

async function callPlaid(credentials: PlaidCredentials, path: string, payload: Record<string, unknown>) {
    const response = await fetch(`${PLAID_BASE_URLS[credentials.environment]}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            client_id: credentials.clientId,
            secret: credentials.secret,
            ...payload
        })
    })

    const responsePayload = await response.json().catch(() => ({}))

    if (!response.ok) {
        const errorMessage = typeof responsePayload?.error_message === 'string'
            ? responsePayload.error_message
            : 'Plaid request failed.'
        throw new Error(errorMessage)
    }

    return responsePayload
}

function mapPlaidAccount(account: any): PlaidAccountSnapshot {
    return {
        accountId: String(account?.account_id || ''),
        name: String(account?.name || account?.official_name || 'Account'),
        officialName: typeof account?.official_name === 'string' ? account.official_name : undefined,
        mask: typeof account?.mask === 'string' ? account.mask : undefined,
        type: typeof account?.type === 'string' ? account.type : undefined,
        subtype: typeof account?.subtype === 'string' ? account.subtype : undefined,
        balances: {
            available: typeof account?.balances?.available === 'number' ? account.balances.available : null,
            current: typeof account?.balances?.current === 'number' ? account.balances.current : null,
            limit: typeof account?.balances?.limit === 'number' ? account.balances.limit : null,
            isoCurrencyCode: typeof account?.balances?.iso_currency_code === 'string' ? account.balances.iso_currency_code : null,
            unofficialCurrencyCode: typeof account?.balances?.unofficial_currency_code === 'string' ? account.balances.unofficial_currency_code : null
        }
    }
}

function mapPlaidHolding(holding: any): PlaidHoldingSnapshot {
    return {
        accountId: String(holding?.account_id || ''),
        securityId: String(holding?.security_id || ''),
        quantity: typeof holding?.quantity === 'number' ? holding.quantity : null,
        costBasis: typeof holding?.cost_basis === 'number' ? holding.cost_basis : null,
        institutionPrice: typeof holding?.institution_price === 'number' ? holding.institution_price : null,
        institutionPriceAsOf: typeof holding?.institution_price_as_of === 'string' ? holding.institution_price_as_of : null,
        institutionPriceDatetime: typeof holding?.institution_price_datetime === 'string' ? holding.institution_price_datetime : null,
        institutionValue: typeof holding?.institution_value === 'number' ? holding.institution_value : null,
        isoCurrencyCode: typeof holding?.iso_currency_code === 'string' ? holding.iso_currency_code : null,
        unofficialCurrencyCode: typeof holding?.unofficial_currency_code === 'string' ? holding.unofficial_currency_code : null
    }
}

function mapPlaidSecurity(security: any): PlaidSecuritySnapshot {
    return {
        securityId: String(security?.security_id || ''),
        name: typeof security?.name === 'string' ? security.name : null,
        tickerSymbol: typeof security?.ticker_symbol === 'string' ? security.ticker_symbol : null,
        type: typeof security?.type === 'string' ? security.type : null,
        closePrice: typeof security?.close_price === 'number' ? security.close_price : null,
        closePriceAsOf: typeof security?.close_price_as_of === 'string' ? security.close_price_as_of : null,
        updateDatetime: typeof security?.update_datetime === 'string' ? security.update_datetime : null,
        isoCurrencyCode: typeof security?.iso_currency_code === 'string' ? security.iso_currency_code : null,
        unofficialCurrencyCode: typeof security?.unofficial_currency_code === 'string' ? security.unofficial_currency_code : null
    }
}

async function getPlaidAccountSnapshots(credentials: PlaidCredentials, accessToken: string): Promise<PlaidAccountSnapshot[]> {
    const accountsResponse = await callPlaid(credentials, '/accounts/get', {
        access_token: accessToken
    })

    return Array.isArray(accountsResponse.accounts)
        ? accountsResponse.accounts.map(mapPlaidAccount).filter((account: PlaidAccountSnapshot) => account.accountId)
        : []
}

async function getPlaidInvestmentSnapshots(
    credentials: PlaidCredentials,
    accessToken: string,
    refreshInvestments = false
): Promise<{
    holdings: PlaidHoldingSnapshot[]
    securities: PlaidSecuritySnapshot[]
    error: string
    refreshError: string
}> {
    let refreshError = ''

    if (refreshInvestments) {
        try {
            await callPlaid(credentials, '/investments/refresh', {
                access_token: accessToken
            })
        } catch (error) {
            refreshError = error instanceof Error ? error.message : 'Failed to request investment refresh.'
        }
    }

    try {
        const holdingsResponse = await callPlaid(credentials, '/investments/holdings/get', {
            access_token: accessToken
        })

        return {
            holdings: Array.isArray(holdingsResponse.holdings)
                ? holdingsResponse.holdings.map(mapPlaidHolding).filter((holding: PlaidHoldingSnapshot) => holding.accountId && holding.securityId)
                : [],
            securities: Array.isArray(holdingsResponse.securities)
                ? holdingsResponse.securities.map(mapPlaidSecurity).filter((security: PlaidSecuritySnapshot) => security.securityId)
                : [],
            error: '',
            refreshError
        }
    } catch (error) {
        return {
            holdings: [],
            securities: [],
            error: error instanceof Error ? error.message : 'Failed to load investment holdings.',
            refreshError
        }
    }
}

function getPublicItem(item: PlaidConnectionItem) {
    return {
        itemId: item.itemId,
        institutionId: item.institutionId || '',
        institutionName: item.institutionName || 'Financial institution',
        accounts: Array.isArray(item.accounts) ? item.accounts : [],
        holdings: Array.isArray(item.holdings) ? item.holdings : [],
        securities: Array.isArray(item.securities) ? item.securities : [],
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        lastSyncedAt: item.lastSyncedAt || '',
        lastError: item.lastError || '',
        holdingsLastSyncedAt: item.holdingsLastSyncedAt || '',
        holdingsError: item.holdingsError || '',
        holdingsRefreshRequestedAt: item.holdingsRefreshRequestedAt || '',
        holdingsRefreshError: item.holdingsRefreshError || ''
    }
}

function getPublicConnections(record: UserPlaidConnectionDocument | null) {
    const environment = sanitizeEnvironment(record?.environment)
    return {
        credentialsConfigured: Boolean(record?.plaidClientIdEncrypted && record?.plaidSecretEncrypted),
        environment,
        updatedAt: record?.updatedAt || '',
        items: (Array.isArray(record?.items) ? record.items : []).map(getPublicItem)
    }
}

function getAccountLinkValue(account: PlaidAccountSnapshot | undefined): number | null {
    const value = account?.balances?.current
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function getPositionLinkValue(holding: PlaidHoldingSnapshot | undefined): number | null {
    const value = holding?.institutionValue
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function getAccountTargetField(account: any): 'amount' | 'currentValue' {
    return account?.type === 'investment-account' ? 'currentValue' : 'amount'
}

function getLinkedSourceValue(account: any, item: PlaidConnectionItem): number | null {
    const link = account?.plaidLink

    if (!isPlainObject(link) || link.itemId !== item.itemId || typeof link.accountId !== 'string') {
        return null
    }

    if (link.sourceType === 'account' && link.sourceField === 'currentBalance') {
        return getAccountLinkValue(item.accounts.find((sourceAccount) => sourceAccount.accountId === link.accountId))
    }

    if (link.sourceType === 'position' && link.sourceField === 'institutionValue' && typeof link.securityId === 'string') {
        return getPositionLinkValue((item.holdings || []).find((holding) => {
            return holding.accountId === link.accountId && holding.securityId === link.securityId
        }))
    }

    return null
}

function applyAccountLinksToUserDocument(user: UserDocument | null, item: PlaidConnectionItem): {
    user: UserDocument | null
    results: LinkApplyResult[]
    changed: boolean
} {
    if (!user || !Array.isArray(user.plans)) {
        return {
            user,
            results: [{
                status: 'skipped',
                message: 'Saved plan document was not found.'
            }],
            changed: false
        }
    }

    let changed = false
    const results: LinkApplyResult[] = []
    const nextPlans = user.plans.map((plan: any) => {
        const accounts = Array.isArray(plan.accounts) ? [...plan.accounts] : []
        if (accounts.length === 0) {
            return plan
        }

        let planChanged = false

        accounts.forEach((account: any, targetIndex: number) => {
            let nextAccount = account
            let accountChanged = false

            if (isPlainObject(account?.plaidLink) && account.plaidLink.itemId === item.itemId) {
                const newValue = getLinkedSourceValue(account, item)
                if (newValue === null) {
                    results.push({
                        status: 'skipped',
                        targetAccountId: account.id,
                        targetAccountName: account.name || '',
                        message: 'Plaid source value was not available.'
                    })
                } else {
                    const targetField = getAccountTargetField(account)
                    const oldValue = typeof account[targetField] === 'number' && Number.isFinite(account[targetField])
                        ? account[targetField]
                        : 0
                    nextAccount = {
                        ...account,
                        [targetField]: newValue
                    }
                    accountChanged = true
                    results.push({
                        status: 'updated',
                        targetAccountId: account.id,
                        targetAccountName: account?.name || '',
                        oldValue,
                        newValue
                    })
                }
            }

            const holdings = Array.isArray(account?.holdings) ? account.holdings : []
            let holdingChanged = false
            const nextHoldings = holdings.map((holding: any) => {
                if (!isPlainObject(holding?.plaidLink) || holding.plaidLink.itemId !== item.itemId) {
                    return holding
                }

                const newValue = getLinkedSourceValue(holding, item)
                if (newValue === null) {
                    results.push({
                        status: 'skipped',
                        targetAccountId: account.id,
                        targetAccountName: account.name || '',
                        targetHoldingId: holding.id,
                        targetHoldingName: holding.name || '',
                        message: 'Plaid source value was not available.'
                    })
                    return holding
                }

                const oldValue = typeof holding.currentValue === 'number' && Number.isFinite(holding.currentValue)
                    ? holding.currentValue
                    : 0
                holdingChanged = true
                results.push({
                    status: 'updated',
                    targetAccountId: account.id,
                    targetAccountName: account.name || '',
                    targetHoldingId: holding.id,
                    targetHoldingName: holding.name || '',
                    oldValue,
                    newValue
                })
                return {
                    ...holding,
                    currentValue: newValue
                }
            })

            if (holdingChanged) {
                const targetField = getAccountTargetField(account)
                const totalValue = nextHoldings.reduce((total: number, holding: any) => {
                    return total + (typeof holding.currentValue === 'number' && Number.isFinite(holding.currentValue)
                        ? holding.currentValue
                        : 0)
                }, 0)
                nextAccount = {
                    ...nextAccount,
                    holdings: nextHoldings,
                    [targetField]: totalValue
                }
                accountChanged = true
            }

            if (accountChanged) {
                accounts[targetIndex] = nextAccount
                changed = true
                planChanged = true
            }
        })

        return planChanged
            ? {
                ...plan,
                accounts
            }
            : plan
    })

    if (!changed) {
        return {
            user,
            results,
            changed
        }
    }

    return {
        user: {
            ...user,
            plans: nextPlans,
            updatedAt: new Date().toISOString()
        },
        results,
        changed
    }
}

export async function getPlaidConnections(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    if (isOptionsRequest(request)) {
        return optionsResponse(request)
    }

    const authEmail = getRequiredAuthEmail(request, context)
    if (typeof authEmail !== 'string') {
        return authEmail
    }

    try {
        const collection = await getUserPlaidConnectionsCollection()
        const record = await collection.findOne({ _id: authEmail })
        return jsonResponse(request, 200, getPublicConnections(record))
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown MongoDB error.'
        context.error(`Failed to load Plaid connections: ${message}`)
        return jsonResponse(request, 500, { error: 'Failed to load Plaid connections.' })
    }
}

export async function savePlaidCredentials(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    if (isOptionsRequest(request)) {
        return optionsResponse(request)
    }

    if (request.method !== 'POST') {
        return jsonResponse(request, 405, { error: 'Method not allowed. Use POST.' })
    }

    if (!hasAppEncryptionKey()) {
        context.error('APP_ENCRYPTION_KEY is not configured.')
        return jsonResponse(request, 500, { error: 'Server configuration is incomplete.' })
    }

    const authEmail = getRequiredAuthEmail(request, context)
    if (typeof authEmail !== 'string') {
        return authEmail
    }

    const body = await readJsonObject(request)
    if ('status' in body) {
        return body as HttpResponseInit
    }
    const requestBody = body as Record<string, unknown>

    const clientId = typeof requestBody.clientId === 'string' ? requestBody.clientId.trim() : ''
    const secret = typeof requestBody.secret === 'string' ? requestBody.secret.trim() : ''
    const environment = sanitizeEnvironment(requestBody.environment)

    if (!clientId || !secret) {
        return jsonResponse(request, 400, { error: 'Client ID and secret are required.' })
    }

    try {
        const collection = await getUserPlaidConnectionsCollection()
        const encryptedClientId = encryptSecret(clientId, `userPlaidConnections:${authEmail}:plaidClientId`)
        const encryptedSecret = encryptSecret(secret, `userPlaidConnections:${authEmail}:plaidSecret`)
        const updatedAt = new Date().toISOString()

        await collection.updateOne(
            { _id: authEmail },
            {
                $set: {
                    _id: authEmail,
                    plaidClientIdEncrypted: encryptedClientId.encryptedValue,
                    plaidClientIdIv: encryptedClientId.iv,
                    plaidClientIdTag: encryptedClientId.tag,
                    plaidClientIdKeyVersion: encryptedClientId.keyVersion,
                    plaidSecretEncrypted: encryptedSecret.encryptedValue,
                    plaidSecretIv: encryptedSecret.iv,
                    plaidSecretTag: encryptedSecret.tag,
                    plaidSecretKeyVersion: encryptedSecret.keyVersion,
                    environment,
                    updatedAt
                },
                $setOnInsert: {
                    items: []
                }
            },
            { upsert: true }
        )

        const record = await collection.findOne({ _id: authEmail })
        return jsonResponse(request, 200, getPublicConnections(record))
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown MongoDB error.'
        context.error(`Failed to save Plaid credentials: ${message}`)
        return jsonResponse(request, 500, { error: 'Failed to save Plaid credentials.' })
    }
}

export async function createPlaidLinkToken(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    if (isOptionsRequest(request)) {
        return optionsResponse(request)
    }

    const authEmail = getRequiredAuthEmail(request, context)
    if (typeof authEmail !== 'string') {
        return authEmail
    }

    const body = await readJsonObject(request)
    if ('status' in body) {
        return body as HttpResponseInit
    }
    const requestBody = body as Record<string, unknown>

    const redirectUri = typeof requestBody.redirectUri === 'string' ? requestBody.redirectUri.trim() : ''

    try {
        const collection = await getUserPlaidConnectionsCollection()
        const record = await collection.findOne({ _id: authEmail })
        const credentials = getPlaidCredentials(record, authEmail)

        if (!credentials) {
            return jsonResponse(request, 400, { error: 'Save Plaid credentials before linking an institution.' })
        }

        const payload: Record<string, unknown> = {
            client_name: 'Better Retirement',
            country_codes: ['US'],
            language: 'en',
            products: ['transactions'],
            optional_products: ['investments'],
            user: {
                client_user_id: getPlaidClientUserId(authEmail)
            }
        }

        payload.redirect_uri = getPlaidOauthRedirectUri(redirectUri)

        const plaidResponse = await callPlaid(credentials, '/link/token/create', payload)
        return jsonResponse(request, 200, {
            linkToken: plaidResponse.link_token,
            expiration: plaidResponse.expiration
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create Plaid Link token.'
        context.error(`Failed to create Plaid Link token: ${message}`)
        return jsonResponse(request, 500, { error: message })
    }
}

export async function exchangePlaidPublicToken(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    if (isOptionsRequest(request)) {
        return optionsResponse(request)
    }

    if (!hasAppEncryptionKey()) {
        context.error('APP_ENCRYPTION_KEY is not configured.')
        return jsonResponse(request, 500, { error: 'Server configuration is incomplete.' })
    }

    const authEmail = getRequiredAuthEmail(request, context)
    if (typeof authEmail !== 'string') {
        return authEmail
    }

    const body = await readJsonObject(request)
    if ('status' in body) {
        return body as HttpResponseInit
    }
    const requestBody = body as Record<string, unknown>

    const publicToken = typeof requestBody.publicToken === 'string' ? requestBody.publicToken.trim() : ''
    const institutionId = typeof requestBody.institutionId === 'string' ? requestBody.institutionId.trim() : ''
    const institutionName = typeof requestBody.institutionName === 'string' ? requestBody.institutionName.trim() : ''

    if (!publicToken) {
        return jsonResponse(request, 400, { error: 'publicToken is required.' })
    }

    try {
        const collection = await getUserPlaidConnectionsCollection()
        const record = await collection.findOne({ _id: authEmail })
        const credentials = getPlaidCredentials(record, authEmail)

        if (!credentials) {
            return jsonResponse(request, 400, { error: 'Save Plaid credentials before linking an institution.' })
        }

        const exchangeResponse = await callPlaid(credentials, '/item/public_token/exchange', {
            public_token: publicToken
        })
        const accessToken = String(exchangeResponse.access_token || '')
        const itemId = String(exchangeResponse.item_id || '')

        if (!accessToken || !itemId) {
            return jsonResponse(request, 502, { error: 'Plaid did not return an access token.' })
        }

        const accounts = await getPlaidAccountSnapshots(credentials, accessToken)
        const investments = await getPlaidInvestmentSnapshots(credentials, accessToken)
        const encryptedAccessToken = encryptSecret(accessToken, `userPlaidConnections:${authEmail}:items:${itemId}:accessToken`)
        const now = new Date().toISOString()
        const existingItems = Array.isArray(record?.items) ? record.items : []
        const nextItem: PlaidConnectionItem = {
            itemId,
            institutionId,
            institutionName,
            accessTokenEncrypted: encryptedAccessToken.encryptedValue,
            accessTokenIv: encryptedAccessToken.iv,
            accessTokenTag: encryptedAccessToken.tag,
            accessTokenKeyVersion: encryptedAccessToken.keyVersion,
            accounts,
            holdings: investments.holdings,
            securities: investments.securities,
            createdAt: existingItems.find((item) => item.itemId === itemId)?.createdAt || now,
            updatedAt: now,
            lastSyncedAt: now,
            lastError: '',
            holdingsLastSyncedAt: investments.error ? '' : now,
            holdingsError: investments.error,
            holdingsRefreshError: investments.refreshError
        }
        const nextItems = [
            ...existingItems.filter((item) => item.itemId !== itemId),
            nextItem
        ]

        await collection.updateOne(
            { _id: authEmail },
            {
                $set: {
                    items: nextItems,
                    updatedAt: now
                }
            }
        )

        const refreshedItem = nextItems.find((candidate) => candidate.itemId === itemId)
        let applyResults: LinkApplyResult[] = []
        let updatedUser: UserDocument | null = null

        if (refreshedItem) {
            const users = await getUsersCollection()
            const user = await users.findOne({ _id: authEmail })
            const applied = applyAccountLinksToUserDocument(user, refreshedItem)
            applyResults = applied.results
            updatedUser = applied.user

            if (applied.changed && applied.user) {
                await users.updateOne(
                    { _id: authEmail },
                    {
                        $set: {
                            plans: applied.user.plans,
                            updatedAt: applied.user.updatedAt
                        }
                    }
                )
            }
        }

        const updatedRecord = await collection.findOne({ _id: authEmail })
        return jsonResponse(request, 200, {
            ...getPublicConnections(updatedRecord),
            applyResults,
            user: updatedUser || undefined
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to connect Plaid institution.'
        context.error(`Failed to exchange Plaid public token: ${message}`)
        return jsonResponse(request, 500, { error: message })
    }
}

export async function refreshPlaidConnection(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    if (isOptionsRequest(request)) {
        return optionsResponse(request)
    }

    const authEmail = getRequiredAuthEmail(request, context)
    if (typeof authEmail !== 'string') {
        return authEmail
    }

    const itemId = String(request.params?.itemId || '').trim()
    if (!itemId) {
        return jsonResponse(request, 400, { error: 'itemId is required.' })
    }

    try {
        const collection = await getUserPlaidConnectionsCollection()
        const record = await collection.findOne({ _id: authEmail })
        const credentials = getPlaidCredentials(record, authEmail)
        const items = Array.isArray(record?.items) ? record.items : []
        const item = items.find((candidate) => candidate.itemId === itemId)

        if (!credentials || !item) {
            return jsonResponse(request, 404, { error: 'Plaid connection was not found.' })
        }

        const accessToken = decryptAccessToken(item, authEmail)
        const accounts = await getPlaidAccountSnapshots(credentials, accessToken)
        const investments = await getPlaidInvestmentSnapshots(credentials, accessToken, true)
        const now = new Date().toISOString()
        const nextItems = items.map((candidate) => {
            if (candidate.itemId !== itemId) {
                return candidate
            }

            return {
                ...candidate,
                accounts,
                holdings: investments.holdings,
                securities: investments.securities,
                updatedAt: now,
                lastSyncedAt: now,
                lastError: '',
                holdingsLastSyncedAt: investments.error ? candidate.holdingsLastSyncedAt : now,
                holdingsError: investments.error,
                holdingsRefreshRequestedAt: now,
                holdingsRefreshError: investments.refreshError
            }
        })

        await collection.updateOne(
            { _id: authEmail },
            {
                $set: {
                    items: nextItems,
                    updatedAt: now
                }
            }
        )

        const refreshedItem = nextItems.find((candidate) => candidate.itemId === itemId)
        let applyResults: LinkApplyResult[] = []
        let updatedUser: UserDocument | null = null

        if (refreshedItem) {
            const users = await getUsersCollection()
            const user = await users.findOne({ _id: authEmail })
            const applied = applyAccountLinksToUserDocument(user, refreshedItem)
            applyResults = applied.results
            updatedUser = applied.user

            if (applied.changed && applied.user) {
                await users.updateOne(
                    { _id: authEmail },
                    {
                        $set: {
                            plans: applied.user.plans,
                            updatedAt: applied.user.updatedAt
                        }
                    }
                )
            }
        }

        const updatedRecord = await collection.findOne({ _id: authEmail })
        return jsonResponse(request, 200, {
            ...getPublicConnections(updatedRecord),
            applyResults,
            user: updatedUser || undefined
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to refresh Plaid balances.'
        context.error(`Failed to refresh Plaid connection: ${message}`)
        return jsonResponse(request, 500, { error: message })
    }
}

export async function deletePlaidConnection(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    if (isOptionsRequest(request)) {
        return optionsResponse(request)
    }

    const authEmail = getRequiredAuthEmail(request, context)
    if (typeof authEmail !== 'string') {
        return authEmail
    }

    const itemId = String(request.params?.itemId || '').trim()
    if (!itemId) {
        return jsonResponse(request, 400, { error: 'itemId is required.' })
    }

    try {
        const collection = await getUserPlaidConnectionsCollection()
        const record = await collection.findOne({ _id: authEmail })
        const credentials = getPlaidCredentials(record, authEmail)
        const items = Array.isArray(record?.items) ? record.items : []
        const item = items.find((candidate) => candidate.itemId === itemId)

        if (credentials && item) {
            try {
                await callPlaid(credentials, '/item/remove', {
                    access_token: decryptAccessToken(item, authEmail)
                })
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown Plaid error.'
                context.warn(`Failed to remove Plaid item before local deletion: ${message}`)
            }
        }

        const now = new Date().toISOString()
        await collection.updateOne(
            { _id: authEmail },
            {
                $set: {
                    items: items.filter((candidate) => candidate.itemId !== itemId),
                    updatedAt: now
                }
            }
        )

        const updatedRecord = await collection.findOne({ _id: authEmail })
        return jsonResponse(request, 200, getPublicConnections(updatedRecord))
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to disconnect Plaid institution.'
        context.error(`Failed to delete Plaid connection: ${message}`)
        return jsonResponse(request, 500, { error: message })
    }
}

app.http('get-plaid-connections', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'plaid/connections',
    handler: withMaintenanceGuard(getPlaidConnections)
})

app.http('save-plaid-credentials', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'plaid/credentials',
    handler: withMaintenanceGuard(savePlaidCredentials)
})

app.http('create-plaid-link-token', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'plaid/link-token',
    handler: withMaintenanceGuard(createPlaidLinkToken)
})

app.http('exchange-plaid-public-token', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'plaid/exchange-public-token',
    handler: withMaintenanceGuard(exchangePlaidPublicToken)
})

app.http('refresh-plaid-connection', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'plaid/connections/{itemId}/refresh',
    handler: withMaintenanceGuard(refreshPlaidConnection)
})

app.http('delete-plaid-connection', {
    methods: ['DELETE', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'plaid/connections/{itemId}',
    handler: withMaintenanceGuard(deletePlaidConnection)
})
