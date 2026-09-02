// POST /api/pair — a signed-in coding client mints a short-lived single-use pairing code so
// the human at the hosted connector sign-in page never has to type the merchant key.
import type { Context, Hono } from 'hono'

import { exactJsonFields, readBoundedJson } from './bounded-json.ts'
import { auth, sha256, type Merchant } from './core.ts'
import { admittedMarketIdentity, identityClientAddress } from './market-identity-rate.ts'
import { postgresMarketIdentityStore, type MarketIdentityStore } from './market-identity-store.ts'
import type { MarketOAuthEnvironment } from './market-oauth-config.ts'
import {
  createMerchantPairingCode,
  newPairingCode,
  PAIRING_CODE_SECONDS,
} from './market-pairing-store.ts'
import { privateBrowserHeaders } from './private-browser.ts'

const MAX_PAIR_JSON_BYTES = 4_096
const NO_CREDENTIAL_MESSAGE =
  'This door takes its credential only from Authorization: Bearer <merchant_key>. Send no ' +
  'request body, or an empty JSON object.'

export interface MarketPairingRouteOptions {
  environment?: MarketOAuthEnvironment
  identityStore?: MarketIdentityStore
  hostedMarketSigninReady?: boolean
  createPairingCode?: typeof createMerchantPairingCode
  authenticate?: (c: Context) => Promise<Merchant | null>
}

function fail(c: Context, status: 400 | 401 | 429 | 503, reason: string, message: string): Response {
  privateBrowserHeaders(c)
  c.header('X-1F3EA-Reason', reason)
  return c.json({ error: message, reason }, status)
}

/**
 * This door carries no fields of its own — the credential is the caller's Authorization:
 * Bearer header, never the body. A caller may still omit the body entirely (the door's
 * original, still-supported contract), but a body that is present must be exactly `{}`.
 */
async function rejectNonEmptyBody(c: Context): Promise<Response | null> {
  if (!c.req.header('content-type')) return null
  const result = await readBoundedJson(c, MAX_PAIR_JSON_BYTES)
  if (result.kind === 'unreadable') {
    return fail(c, 503, 'storage_unavailable', 'The request body could not be fully read. Retry the same request; no code was issued.')
  }
  if (result.kind === 'invalid' || !exactJsonFields(result.value, [])) {
    return fail(c, 400, 'unexpected_fields', NO_CREDENTIAL_MESSAGE)
  }
  return null
}

export function mountMarketPairingRoutes(app: Hono, options: MarketPairingRouteOptions = {}): void {
  const environment = options.environment ?? process.env
  const identityStore = options.identityStore ?? postgresMarketIdentityStore
  const createPairingCode = options.createPairingCode ?? createMerchantPairingCode
  const authenticate = options.authenticate ?? auth
  const hostedReady = options.hostedMarketSigninReady === true

  app.post('/api/pair', async c => {
    let merchant: Merchant | null
    try {
      merchant = await authenticate(c)
    } catch {
      return fail(c, 503, 'storage_unavailable', 'The market could not verify this merchant key. Retry the same request; no code was issued.')
    }
    if (!merchant) {
      return fail(
        c, 401, 'auth_required',
        'Send Authorization: Bearer <merchant_key> for the merchant this pairing code should link. ' +
          'Never put the key anywhere else — this is the one door that turns it into a short-lived code instead.',
      )
    }
    const bodyError = await rejectNonEmptyBody(c)
    if (bodyError) return bodyError
    const ip = identityClientAddress(c, environment)
    let allowed: boolean
    try {
      allowed = await admittedMarketIdentity(
        identityStore, 'pair_create', [`ip:${ip}`, `merchant:${merchant.id}`], 20,
      )
    } catch {
      return fail(c, 503, 'storage_unavailable', 'The market could not create a pairing code. Retry the same request; no code was issued.')
    }
    if (!allowed) {
      return fail(c, 429, 'rate_limited', 'Pairing-code creation is limited to 20 attempts per IP and per merchant per UTC hour. Retry after the next UTC hour begins.')
    }
    const code = newPairingCode()
    let created
    try {
      created = await createPairingCode({ merchantId: merchant.id, codeHash: sha256(code) })
    } catch {
      return fail(c, 503, 'storage_unavailable', 'The market could not create a pairing code. Retry the same request; no code was issued.')
    }
    privateBrowserHeaders(c)
    return c.json({
      status: 'created',
      pairing_code: code,
      expires_in_seconds: PAIRING_CODE_SECONDS,
      expires_at: created.expiresAt,
      one_use: true,
      instructions: hostedReady
        ? 'Shown exactly once. Within 10 minutes, have the human enter this code — instead of the merchant ' +
          'key — on the "I already have a store" panel of the hosted connector sign-in page. It links that ' +
          'connector grant to this merchant and reveals no key.'
        : 'Shown exactly once. The hosted connector sign-in door is not enabled on this deployment, so there ' +
          'is nowhere to redeem this code yet; it will simply expire unused in 10 minutes.',
    }, 200)
  })
}
