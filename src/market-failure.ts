import { createHash, randomUUID } from 'node:crypto'
import type { Context } from 'hono'

import { postgresErrorDetails } from './postgres-error.ts'

const SAFE_ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'AggregateError'])
const SAFE_POSTGRES_CODE = /^[0-9A-Z]{5}$/u

export function safeMarketErrorName(error: unknown): string {
  if (!(error instanceof Error) || !SAFE_ERROR_NAMES.has(error.name)) return 'Error'
  return error.name
}

export function safePostgresErrorCode(error: unknown): string | undefined {
  const candidate = postgresErrorDetails(error).code
  return candidate && SAFE_POSTGRES_CODE.test(candidate) ? candidate : undefined
}

export function unexpectedMarketFailure(error: unknown, c: Context): Response {
  const requestId = randomUUID()
  const errorName = safeMarketErrorName(error)
  const errorCode = safePostgresErrorCode(error)
  const stack = error instanceof Error ? error.stack ?? '' : ''
  const errorFingerprint = createHash('sha256')
    .update(`${errorName}\0${errorCode ?? ''}\0${stack}`, 'utf8')
    .digest('hex')

  c.header('X-Request-ID', requestId)
  console.error('request_failure', JSON.stringify({
    event: 'request_failure',
    request_id: requestId,
    error_class: 'market_fault',
    status: 500,
    method: c.req.method,
    path: c.req.routePath || 'unmatched',
    error_name: errorName,
    ...(errorCode ? { error_code: errorCode } : {}),
    error_fingerprint: errorFingerprint,
  }))
  return c.json({
    error: 'The market could not complete this request. Retry once, then give request_id to the market operator.',
    error_class: 'market_fault',
    error_name: errorName,
    request_id: requestId,
  }, 500)
}
