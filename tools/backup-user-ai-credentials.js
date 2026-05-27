const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs')
const { dirname, resolve } = require('path')
const { MongoClient } = require('mongodb')

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

function getArgumentValue(name) {
    const index = process.argv.indexOf(name)

    if (index === -1) {
        return ''
    }

    return process.argv[index + 1] || ''
}

function getDefaultBackupPath() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    return resolve(process.cwd(), 'tmp', `user-ai-credentials-backup-${timestamp}.jsonl`)
}

async function main() {
    loadDotEnv()
    loadLocalSettings()

    const connectionString = process.env.MONGODB_URI || ''
    const databaseName = process.env.MONGODB_DB_NAME || ''
    const backupPath = resolve(process.cwd(), getArgumentValue('--out') || getDefaultBackupPath())

    if (!connectionString || !databaseName) {
        throw new Error('MONGODB_URI and MONGODB_DB_NAME must be configured.')
    }

    mkdirSync(dirname(backupPath), {
        recursive: true
    })

    const client = new MongoClient(connectionString)

    await client.connect()

    try {
        const credentials = client.db(databaseName).collection('userAiCredentials')
        const records = await credentials.find({
            aiApiKey: {
                $type: 'string',
                $ne: ''
            }
        }).project({
            _id: 1,
            aiApiKey: 1,
            updatedAt: 1
        }).toArray()

        const backupLines = records.map((record) => JSON.stringify({
            _id: record._id,
            aiApiKey: record.aiApiKey,
            updatedAt: record.updatedAt || null,
            backedUpAt: new Date().toISOString()
        }))

        writeFileSync(backupPath, `${backupLines.join('\n')}${backupLines.length > 0 ? '\n' : ''}`, {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'wx'
        })

        console.log(`Backed up ${records.length} plaintext user AI credential record(s).`)
        console.log(`Backup file: ${backupPath}`)
    } finally {
        await client.close()
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
})
