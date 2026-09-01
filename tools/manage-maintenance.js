const { existsSync, readFileSync } = require('fs')
const { resolve } = require('path')
const { MongoClient } = require('mongodb')

const MAINTENANCE_CONFIG_ID = 'maintenance'

function loadSettingsFile(path, getValues) {
    if (!existsSync(path)) {
        return
    }

    const values = getValues(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))

    for (const [key, value] of Object.entries(values || {})) {
        if (!process.env[key] && typeof value === 'string') {
            process.env[key] = value
        }
    }
}

function loadSettings() {
    loadSettingsFile(resolve(process.cwd(), '.env'), (contents) => {
        return contents.split(/\r?\n/).reduce((values, line) => {
            const trimmed = line.trim()

            if (!trimmed || trimmed.startsWith('#')) {
                return values
            }

            const separatorIndex = trimmed.indexOf('=')

            if (separatorIndex < 0) {
                return values
            }

            const key = trimmed.slice(0, separatorIndex).trim()
            let value = trimmed.slice(separatorIndex + 1).trim()

            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1)
            }

            values[key] = value
            return values
        }, {})
    })
    loadSettingsFile(resolve(process.cwd(), 'local.settings.json'), (contents) => {
        return JSON.parse(contents)?.Values || {}
    })
}

function getArgumentValue(name) {
    const index = process.argv.indexOf(name)
    return index >= 0 ? process.argv[index + 1] || '' : ''
}

function getPositiveIntegerArgument(name) {
    const rawValue = getArgumentValue(name)

    if (!rawValue) {
        return null
    }

    const value = Number(rawValue)

    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer.`)
    }

    return value
}

function validateIsoDate(name, value) {
    if (value && Number.isNaN(Date.parse(value))) {
        throw new Error(`${name} must be a valid ISO date.`)
    }
}

function printUsage() {
    console.log([
        'Usage:',
        '  npm run maintenance -- status',
        '  npm run maintenance -- enable --message "..." [--expected-end-at ISO] [--operation-id ID] [--required-schema-version N] [--retry-after-seconds N]',
        '  npm run maintenance -- disable'
    ].join('\n'))
}

async function main() {
    loadSettings()

    const command = process.argv[2] || 'status'

    if (!['status', 'enable', 'disable'].includes(command)) {
        printUsage()
        throw new Error(`Unknown command: ${command}`)
    }

    const connectionString = process.env.MONGODB_URI || ''
    const databaseName = process.env.MONGODB_DB_NAME || ''

    if (!connectionString || !databaseName) {
        throw new Error('MONGODB_URI and MONGODB_DB_NAME must be configured.')
    }

    const client = new MongoClient(connectionString)
    await client.connect()

    try {
        const appConfig = client.db(databaseName).collection('appConfig')

        if (command === 'enable') {
            const message = getArgumentValue('--message').trim()
            const expectedEndAt = getArgumentValue('--expected-end-at').trim()
            const operationId = getArgumentValue('--operation-id').trim()
            const requiredSchemaVersion = getPositiveIntegerArgument('--required-schema-version')
            const retryAfterSeconds = getPositiveIntegerArgument('--retry-after-seconds')

            if (!message) {
                throw new Error('--message is required when enabling maintenance mode.')
            }

            validateIsoDate('--expected-end-at', expectedEndAt)

            const setValues = {
                enabled: true,
                message,
                startedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            }

            if (expectedEndAt) {
                setValues.expectedEndAt = new Date(expectedEndAt).toISOString()
            }

            if (operationId) {
                setValues.operationId = operationId
            }

            if (requiredSchemaVersion !== null) {
                setValues.requiredSchemaVersion = requiredSchemaVersion
            }

            if (retryAfterSeconds !== null) {
                setValues.retryAfterSeconds = retryAfterSeconds
            }

            await appConfig.updateOne(
                { _id: MAINTENANCE_CONFIG_ID },
                { $set: setValues },
                { upsert: true }
            )
        } else if (command === 'disable') {
            await appConfig.updateOne(
                { _id: MAINTENANCE_CONFIG_ID },
                {
                    $set: {
                        enabled: false,
                        updatedAt: new Date().toISOString()
                    },
                    $unset: {
                        expectedEndAt: '',
                        startedAt: ''
                    }
                },
                { upsert: true }
            )
        }

        const document = await appConfig.findOne({ _id: MAINTENANCE_CONFIG_ID })
        console.log(JSON.stringify(document || { _id: MAINTENANCE_CONFIG_ID, enabled: false }, null, 2))
    } finally {
        await client.close()
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
})
