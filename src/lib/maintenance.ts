import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions'
import { isOptionsRequest, jsonResponse } from './http'
import { getAppConfigCollection } from './mongo'

export const MAINTENANCE_CONFIG_ID = 'maintenance'
export const MAINTENANCE_MODE_CODE = 'MAINTENANCE_MODE'
export const SCHEMA_VERSION_MISMATCH_CODE = 'SCHEMA_VERSION_MISMATCH'

const DEFAULT_MAINTENANCE_MESSAGE = 'The system is temporarily unavailable for maintenance. Please try again later.'
const DEFAULT_RETRY_AFTER_SECONDS = 300

export type MaintenanceConfig = {
    enabled: boolean
    message: string
    expectedEndAt: string
    operationId: string
    requiredSchemaVersion: number | null
    retryAfterSeconds: number
}

type MaintenanceGuardedHandler = (
    request: HttpRequest,
    context: InvocationContext
) => Promise<HttpResponseInit>

function normalizePositiveInteger(value: unknown, fallback: number): number {
    const parsedValue = Number(value)

    return Number.isInteger(parsedValue) && parsedValue > 0
        ? parsedValue
        : fallback
}

export async function getMaintenanceConfig(): Promise<MaintenanceConfig> {
    const appConfig = await getAppConfigCollection()
    const document = await appConfig.findOne({ _id: MAINTENANCE_CONFIG_ID })
    const requiredSchemaVersion = Number(document?.requiredSchemaVersion)

    return {
        enabled: document?.enabled === true,
        message: typeof document?.message === 'string' && document.message.trim()
            ? document.message.trim()
            : DEFAULT_MAINTENANCE_MESSAGE,
        expectedEndAt: typeof document?.expectedEndAt === 'string' ? document.expectedEndAt : '',
        operationId: typeof document?.operationId === 'string' ? document.operationId : '',
        requiredSchemaVersion: Number.isInteger(requiredSchemaVersion) && requiredSchemaVersion > 0
            ? requiredSchemaVersion
            : null,
        retryAfterSeconds: normalizePositiveInteger(
            document?.retryAfterSeconds,
            DEFAULT_RETRY_AFTER_SECONDS
        )
    }
}

export function isSchemaVersionMismatch(
    schemaVersion: unknown,
    requiredSchemaVersion: number | null
): boolean {
    if (requiredSchemaVersion === null) return false

    return typeof schemaVersion !== 'number'
        || !Number.isSafeInteger(schemaVersion)
        || schemaVersion < requiredSchemaVersion
}

function maintenanceResponse(request: HttpRequest, config: MaintenanceConfig): HttpResponseInit {
    return jsonResponse(
        request,
        503,
        {
            code: MAINTENANCE_MODE_CODE,
            message: config.message,
            expectedEndAt: config.expectedEndAt || undefined
        },
        {
            'Cache-Control': 'no-store',
            'Retry-After': String(config.retryAfterSeconds)
        }
    )
}

export function withMaintenanceGuard(
    handler: MaintenanceGuardedHandler,
    loadConfig: () => Promise<MaintenanceConfig> = getMaintenanceConfig
): MaintenanceGuardedHandler {
    return async (request, context) => {
        if (isOptionsRequest(request)) {
            return handler(request, context)
        }

        try {
            const config = await loadConfig()

            if (config.enabled) {
                return maintenanceResponse(request, config)
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown maintenance configuration error.'
            context.error(`Failed to check maintenance configuration: ${message}`)

            return maintenanceResponse(request, {
                enabled: true,
                message: DEFAULT_MAINTENANCE_MESSAGE,
                expectedEndAt: '',
                operationId: '',
                requiredSchemaVersion: null,
                retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS
            })
        }

        return handler(request, context)
    }
}
