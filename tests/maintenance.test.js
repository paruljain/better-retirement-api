const assert = require('node:assert/strict')
const test = require('node:test')
const {
    MAINTENANCE_MODE_CODE,
    isSchemaVersionMismatch,
    withMaintenanceGuard
} = require('../dist/src/lib/maintenance')

test('schema validation rejects missing or stale versions after migration', () => {
    assert.equal(isSchemaVersionMismatch(48, 48), false)
    assert.equal(isSchemaVersionMismatch(47, 48), true)
    assert.equal(isSchemaVersionMismatch(undefined, 48), true)
    assert.equal(isSchemaVersionMismatch(47, null), false)
})

function createRequest(method = 'GET') {
    return {
        method,
        headers: new Headers({
            origin: 'https://better-retirement.com'
        })
    }
}

function createContext() {
    return {
        error() {}
    }
}

function createConfig(overrides = {}) {
    return {
        enabled: false,
        message: 'Scheduled maintenance.',
        expectedEndAt: '',
        operationId: '',
        requiredSchemaVersion: 48,
        retryAfterSeconds: 120,
        ...overrides
    }
}

test('maintenance guard blocks requests before the route handler', async () => {
    let handlerCalled = false
    const handler = async () => {
        handlerCalled = true
        return { status: 200 }
    }
    const guardedHandler = withMaintenanceGuard(handler, async () => createConfig({ enabled: true }))

    const response = await guardedHandler(createRequest(), createContext())

    assert.equal(response.status, 503)
    assert.equal(response.jsonBody.code, MAINTENANCE_MODE_CODE)
    assert.equal(response.jsonBody.message, 'Scheduled maintenance.')
    assert.equal(response.headers['Retry-After'], '120')
    assert.equal(response.headers['Cache-Control'], 'no-store')
    assert.equal(handlerCalled, false)
})

test('maintenance guard allows browser preflight requests without reading configuration', async () => {
    let configRead = false
    const handler = async () => ({ status: 204 })
    const guardedHandler = withMaintenanceGuard(handler, async () => {
        configRead = true
        return createConfig({ enabled: true })
    })

    const response = await guardedHandler(createRequest('OPTIONS'), createContext())

    assert.equal(response.status, 204)
    assert.equal(configRead, false)
})

test('maintenance guard allows normal requests when maintenance is disabled', async () => {
    const handler = async () => ({ status: 201 })
    const guardedHandler = withMaintenanceGuard(handler, async () => createConfig())

    const response = await guardedHandler(createRequest(), createContext())

    assert.equal(response.status, 201)
})

test('maintenance guard fails closed when configuration cannot be read', async () => {
    let handlerCalled = false
    const handler = async () => {
        handlerCalled = true
        return { status: 200 }
    }
    const guardedHandler = withMaintenanceGuard(handler, async () => {
        throw new Error('MongoDB unavailable')
    })

    const response = await guardedHandler(createRequest(), createContext())

    assert.equal(response.status, 503)
    assert.equal(response.jsonBody.code, MAINTENANCE_MODE_CODE)
    assert.equal(handlerCalled, false)
})
