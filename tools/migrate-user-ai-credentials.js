const { createCipheriv, randomBytes } = require('crypto')
const { existsSync, readFileSync } = require('fs')
const { resolve } = require('path')
const { MongoClient } = require('mongodb')

const KEY_VERSION = 'v1'
const KEY_LENGTH_BYTES = 32
const IV_LENGTH_BYTES = 12

function loadDotEnv() {
    const envPath = resolve(process.cwd(), '.env')

    if (!existsSync(envPath)) {
        return
    }

    const lines = readFileSync(envPath, 'utf8').split(/\r?\n/)

    for (const line of lines) {
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

function loadLocalSettings() {
    const settingsPath = resolve(process.cwd(), 'local.settings.json')

    if (!existsSync(settingsPath)) {
        return
    }

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''))
    const values = settings && typeof settings === 'object' ? settings.Values : null

    if (!values || typeof values !== 'object') {
        return
    }

    for (const [key, value] of Object.entries(values)) {
        if (!process.env[key] && typeof value === 'string') {
            process.env[key] = value
        }
    }
}

function parseBase64Key(rawKey) {
    const encodedKey = rawKey.startsWith('base64:')
        ? rawKey.slice('base64:'.length)
        : rawKey
    const key = Buffer.from(encodedKey, 'base64')

    if (key.length !== KEY_LENGTH_BYTES) {
        throw new Error('APP_ENCRYPTION_KEY must be a base64-encoded 32-byte key.')
    }

    return key
}

function encryptSecret(plaintext, aad, key) {
    const iv = randomBytes(IV_LENGTH_BYTES)
    const cipher = createCipheriv('aes-256-gcm', key, iv)

    cipher.setAAD(Buffer.from(aad, 'utf8'))

    const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final()
    ])
    const tag = cipher.getAuthTag()

    return {
        encryptedValue: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        keyVersion: KEY_VERSION
    }
}

async function main() {
    loadDotEnv()
    loadLocalSettings()

    const dryRun = process.argv.includes('--dry-run')
    const connectionString = process.env.MONGODB_URI || ''
    const databaseName = process.env.MONGODB_DB_NAME || ''
    const encryptionKey = process.env.APP_ENCRYPTION_KEY || ''

    if (!connectionString || !databaseName) {
        throw new Error('MONGODB_URI and MONGODB_DB_NAME must be configured.')
    }

    if (!encryptionKey) {
        throw new Error('APP_ENCRYPTION_KEY must be configured.')
    }

    const key = parseBase64Key(encryptionKey)
    const client = new MongoClient(connectionString)

    await client.connect()

    try {
        const credentials = client.db(databaseName).collection('userAiCredentials')
        const records = await credentials.find({
            aiApiKey: {
                $type: 'string',
                $ne: ''
            }
        }).toArray()

        let encryptedCount = 0
        let plaintextRemovedCount = 0

        for (const record of records) {
            const userId = String(record._id || '').trim()

            if (!userId) {
                continue
            }

            const hasEncryptedKey = Boolean(
                record.aiApiKeyEncrypted &&
                record.aiApiKeyIv &&
                record.aiApiKeyTag &&
                record.aiApiKeyKeyVersion
            )

            if (dryRun) {
                if (hasEncryptedKey) {
                    plaintextRemovedCount += 1
                } else {
                    encryptedCount += 1
                }
                continue
            }

            if (hasEncryptedKey) {
                await credentials.updateOne(
                    { _id: record._id },
                    {
                        $unset: {
                            aiApiKey: ''
                        }
                    }
                )
                plaintextRemovedCount += 1
                continue
            }

            const encryptedApiKey = encryptSecret(
                String(record.aiApiKey).trim(),
                `userAiCredentials:${userId}:aiApiKey`,
                key
            )

            await credentials.updateOne(
                { _id: record._id },
                {
                    $set: {
                        aiApiKeyEncrypted: encryptedApiKey.encryptedValue,
                        aiApiKeyIv: encryptedApiKey.iv,
                        aiApiKeyTag: encryptedApiKey.tag,
                        aiApiKeyKeyVersion: encryptedApiKey.keyVersion,
                        updatedAt: new Date().toISOString()
                    },
                    $unset: {
                        aiApiKey: ''
                    }
                }
            )
            encryptedCount += 1
        }

        console.log(`${dryRun ? 'Would encrypt' : 'Encrypted'} ${encryptedCount} user AI credential record(s).`)
        console.log(`${dryRun ? 'Would remove' : 'Removed'} plaintext aiApiKey from ${plaintextRemovedCount} already-encrypted record(s).`)
    } finally {
        await client.close()
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
})
