import { randomUUID } from 'node:crypto'
import type { Context } from 'hono'

import {
  MARKET_REFUSAL_REASONS,
  type MarketRefusalReason,
} from './market-facts.ts'
import { privateBrowserHeaders } from './private-browser.ts'

export { MARKET_REFUSAL_REASONS, type MarketRefusalReason }

export type MarketErrorClass =
  | 'bad_input'
  | 'not_found'
  | 'auth_required'
  | 'forbidden'
  | 'payment_required'
  | 'conflict'
  | 'rate_limited'
  | 'market_fault'

export type MarketRetryWindow = 'utc_hour' | 'utc_day'

const MARKET_OPERATOR_RETRY = 'Retry once, then give request_id to the market operator if it fails again.'

export interface MarketRefusalReference {
  errorClass: MarketErrorClass
  reason: MarketRefusalReason
  requestId: string
  detail?: MarketRefusalDetail
}

export type MarketRefusalDetail =
  | 'authorization_code_fields'
  | 'authorization_code_mismatch'
  | 'authorization_code_spent'
  | 'client_contract_mismatch'
  | 'invalid_grant_fields'
  | 'pairing_code_expired_or_revoked'
  | 'pairing_code_malformed'
  | 'pairing_code_unavailable'
  | 'pairing_merchant_key_changed'
  | 'pairing_reservation_missing'
  | 'refresh_token_rejected'
  | 'refresh_token_shape'
  | 'signin_client_id'
  | 'signin_contract'
  | 'signin_query_fields'
  | 'signin_rate_store'
  | 'signin_request_create'
  | 'unsupported_client_authentication'

function marketRefusalReasonForStatus(status: number): MarketRefusalReason {
  if (status === 401) return 'auth_required'
  if (status === 402) return 'payment_required'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'request_conflict'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'market_fault'
  return 'invalid_request'
}

function secondsUntil(nextUtcMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((nextUtcMs - nowMs) / 1_000))
}

export function secondsUntilNextUtcHour(nowMs = Date.now()): number {
  const now = new Date(nowMs)
  return secondsUntil(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1,
  ), nowMs)
}

export function secondsUntilNextUtcDay(nowMs = Date.now()): number {
  const now = new Date(nowMs)
  return secondsUntil(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1,
  ), nowMs)
}

export function marketErrorClassForStatus(status: number): MarketErrorClass {
  if (status === 401) return 'auth_required'
  if (status === 402) return 'payment_required'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'market_fault'
  return 'bad_input'
}

export function markMarketRefusal(
  c: Context,
  status: number,
  reason: MarketRefusalReason,
  requestId = c.res.headers.get('X-Request-ID') ?? randomUUID(),
  detail?: MarketRefusalDetail,
): MarketRefusalReference {
  const errorClass = marketErrorClassForStatus(status)
  c.header('X-Request-ID', requestId)
  c.header('X-1F3EA-Error-Class', errorClass)
  c.header('X-1F3EA-Reason', reason)
  if (detail) c.header('X-1F3EA-Cause', detail)
  console.error('market_refusal', JSON.stringify({
    event: 'market_refusal',
    request_id: requestId,
    error_class: errorClass,
    reason,
    ...(detail ? { detail } : {}),
    status,
    method: c.req.method,
    // Route templates are safe to record. Raw URLs, query strings, headers, and path values are not.
    path: c.req.routePath || 'unmatched',
  }))
  return { errorClass, reason, requestId, ...(detail ? { detail } : {}) }
}

export function marketRefusalNextStep(reason: MarketRefusalReason): string {
  if (reason === 'auth_required') return 'Send the merchant key only in the Authorization: Bearer header, then retry.'
  if (reason === 'payment_required') return 'Follow the accepts and payment_safety fields exactly. Reuse preserved payment proof when told, and do not pay again.'
  if (reason === 'market_fault') return MARKET_OPERATOR_RETRY
  if (reason === 'rate_limited') return 'Wait for the time stated in Retry-After, then retry once.'
  if (reason === 'storage_unavailable') return MARKET_OPERATOR_RETRY
  if (reason === 'pairing_unavailable') return 'Read GET /api/official before trying pairing again.'
  if (reason === 'identity_dormant') return 'The operator must apply the reviewed migration and enable both identity flags before retrying.'
  if (reason === 'coding_identity_dormant') return 'The operator must apply the reviewed coding identity migration and enable MARKET_CODING_IDENTITY_ENABLED before retrying.'
  return 'Read GET /help, correct the named field or state, then retry.'
}

function retrySeconds(window: MarketRetryWindow): number {
  return window === 'utc_day' ? secondsUntilNextUtcDay() : secondsUntilNextUtcHour()
}

export function marketJsonRefusal(
  c: Context,
  status: 400 | 401 | 402 | 403 | 404 | 405 | 409 | 429 | 500 | 502 | 503,
  reason: MarketRefusalReason,
  message: string,
  nextStep = marketRefusalNextStep(reason),
  retryWindow?: MarketRetryWindow,
  detail?: MarketRefusalDetail,
): Response {
  privateBrowserHeaders(c)
  const retryAfterSeconds = status === 429
    ? Number(c.res.headers.get('Retry-After') ?? (retryWindow ? retrySeconds(retryWindow) : NaN))
    : undefined
  if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)) {
    c.header('Retry-After', String(retryAfterSeconds))
  }
  const reference = markMarketRefusal(c, status, reason, undefined, detail)
  return c.json({
    error: message,
    error_class: reference.errorClass,
    http_status: status,
    reason: reference.reason,
    ...(detail ? { cause: detail } : {}),
    next_step: nextStep,
    request_id: reference.requestId,
    ...(retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds)
      ? {}
      : { retry_after_seconds: retryAfterSeconds }),
    front_door_tool: 'front_door',
    front_door: 'https://1f3ea.com/',
    help_page: 'https://1f3ea.com/help',
  }, status)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isMarketRefusalReason(value: string | null): value is MarketRefusalReason {
  return value !== null && MARKET_REFUSAL_REASONS.includes(value as MarketRefusalReason)
}

/** Add the shared envelope to JSON refusals while retaining route-specific payment and OAuth fields. */
export async function ensureMarketJsonRefusal(c: Context): Promise<void> {
  const status = c.res.status
  if (status < 400 || !/\bapplication\/json\b/iu.test(c.res.headers.get('Content-Type') ?? '')) return
  const body = await c.res.clone().json().catch(() => null)
  if (!isRecord(body)) return
  if (body.jsonrpc === '2.0') return

  const reasonHeader = c.res.headers.get('X-1F3EA-Reason')
  const reason = isMarketRefusalReason(reasonHeader)
    ? reasonHeader
    : marketRefusalReasonForStatus(status)
  const requestId = c.res.headers.get('X-Request-ID') ?? randomUUID()
  const errorClass = marketErrorClassForStatus(status)
  if (!c.res.headers.has('X-Request-ID')) markMarketRefusal(c, status, reason, requestId)
  else {
    c.header('X-1F3EA-Error-Class', errorClass)
    c.header('X-1F3EA-Reason', reason)
  }

  const retryAfter = Number(c.res.headers.get('Retry-After'))
  const headers = new Headers(c.res.headers)
  for (const name of ['Content-Length', 'Content-MD5', 'Digest', 'Content-Digest', 'Repr-Digest']) {
    headers.delete(name)
  }
  headers.set('Content-Type', 'application/json; charset=UTF-8')
  c.res = new Response(JSON.stringify({
    ...body,
    error_class: errorClass,
    http_status: status,
    reason,
    next_step: typeof body.next_step === 'string'
      ? body.next_step
      : typeof body.retry === 'string'
        ? body.retry
        : marketRefusalNextStep(reason),
    request_id: requestId,
    ...(Number.isFinite(retryAfter) && retryAfter >= 1 && retryAfter <= 86_400
      ? { retry_after_seconds: retryAfter }
      : {}),
    front_door_tool: 'front_door',
    front_door: 'https://1f3ea.com/',
    help_page: 'https://1f3ea.com/help',
  }), { status, headers })
  for (const name of ['Content-Length', 'Content-MD5', 'Digest', 'Content-Digest', 'Repr-Digest']) {
    c.res.headers.delete(name)
  }
}
