import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

export type EncryptedSecret = {
    encryptedValue: string
    iv: string
    tag: string
    keyVersion: string
}

const APP_ENCRYPTION_KEY_VERSION = 'v1'
const APP_ENCRYPTION_KEY_LENGTH_BYTES = 32
const AES_GCM_IV_LENGTH_BYTES = 12

function parseBase64Key(rawKey: string): Buffer {
    const encodedKey = rawKey.startsWith('base64:')
        ? rawKey.slice('base64:'.length)
        : rawKey
    const key = Buffer.from(encodedKey, 'base64')

    if (key.length !== APP_ENCRYPTION_KEY_LENGTH_BYTES) {
        throw new Error('APP_ENCRYPTION_KEY must be a base64-encoded 32-byte key.')
    }

    return key
}

export function getAppEncryptionKey(): string {
    return process.env.APP_ENCRYPTION_KEY || ''
}

export function hasAppEncryptionKey(): boolean {
    return Boolean(getAppEncryptionKey())
}

export function encryptSecret(plaintext: string, aad: string): EncryptedSecret {
    const key = parseBase64Key(getAppEncryptionKey())
    const iv = randomBytes(AES_GCM_IV_LENGTH_BYTES)
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
        keyVersion: APP_ENCRYPTION_KEY_VERSION
    }
}

export function decryptSecret(encryptedSecret: EncryptedSecret, aad: string): string {
    if (encryptedSecret.keyVersion !== APP_ENCRYPTION_KEY_VERSION) {
        throw new Error(`Unsupported encrypted secret key version: ${encryptedSecret.keyVersion}`)
    }

    const key = parseBase64Key(getAppEncryptionKey())
    const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(encryptedSecret.iv, 'base64')
    )

    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(Buffer.from(encryptedSecret.tag, 'base64'))

    return Buffer.concat([
        decipher.update(Buffer.from(encryptedSecret.encryptedValue, 'base64')),
        decipher.final()
    ]).toString('utf8')
}
