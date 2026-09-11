// Hosted OAuth's "pair" and "confirm_pair" actions: a human redeems a coding client's
// short-lived pairing code instead of typing the merchant key on the "I already have a store"
// panel. Split into two steps on purpose — reserve, then confirm — so the human sees which
// merchant the code names ("connect <client> to merchant @handle?") before anything is
// granted: a code typo or a stale clipboard entry would otherwise link the wrong store
// silently. Split out of market-oauth.ts to keep that module under the project's 800-line
// ceiling.
import type { Context } from 'hono'

import { oneFormValue } from './browser-form.ts'
import { sha256 } from './core.ts'
import { MARKET_LIMITS } from './market-facts.ts'
import { MARKET_OAUTH_AUTHORIZATION_CODE_PREFIX } from './market-oauth-config.ts'
import {
  isInitialAuthorizationRequest,
  oauthBrowserError as browserError,
  oauthPairingBrowserError as pairingError,
  oauthHtml as html,
  pairingConfirmPage,
  terminalAuthorizationResponse,
} from './market-oauth-browser.ts'
import {
  admitted,
  callbackUrl,
  clientAddress,
  opaque,
  redirect,
  type Runtime,
} from './market-oauth-runtime.ts'
import type { AuthorizationRequestRecord } from './market-oauth-store.ts'
import {
  PAIRING_CODE_RE,
  reservePairingCode,
  resolveAndConsumePairingCode,
  takeReservedPairingCode,
} from './market-pairing-store.ts'

export type PairingCodeResolver = typeof resolveAndConsumePairingCode
export type PairingCodeReserver = typeof reservePairingCode
export type PairingReservationTaker = typeof takeReservedPairingCode

/**
 * Step 1: reserve. Validates the code's shape, rate-limits attempts the same way the old
 * single-step door did, and — if the code currently resolves to a merchant — reserves it
 * against this browser session and renders the confirmation page naming that merchant. The
 * code itself is not consumed here; see reservePairingCode's own docstring for why an
 * unconfirmed reservation is safe to just let expire.
 */
export async function handlePairAction(
  c: Context,
  oauth: Runtime,
  pending: AuthorizationRequestRecord,
  csrf: string,
  values: URLSearchParams,
  sessionHash: string,
  csrfHash: string,
  reservePairing: PairingCodeReserver = reservePairingCode,
): Promise<Response> {
  if (!isInitialAuthorizationRequest(pending)) {
    return browserError(c, 403, 'request_conflict', 'This sign-in is already preparing a new merchant. Continue that signup or cancel it first.')
  }
  const pairingCode = oneFormValue(values, 'pairing_code', 80)
  if (!pairingCode || !PAIRING_CODE_RE.test(pairingCode)) {
    return pairingError(c, 'pairing_code_malformed', 'The pairing_code field did not have the expected shape.', pending.client_display_name, csrf)
  }
  const allowed = await admitted(
    oauth,
    [`ip:${clientAddress(c, oauth.environment)}`, `client:${pending.client_id}`],
    'merchant_key',
    MARKET_LIMITS.oauth.keyAttemptsPerIpAndClientUtcHour,
  )
  if (!allowed) return browserError(c, 429, 'rate_limited', 'Too many pairing attempts. Try again after the next UTC hour.')
  const reserved = await reservePairing({ sessionHash, csrfHash, codeHash: sha256(pairingCode) })
  if (!reserved) {
    return pairingError(c, 'pairing_code_unavailable', 'That pairing code was not accepted.', pending.client_display_name, csrf)
  }
  return html(
    c,
    200,
    `Connect ${pending.client_display_name} to @${reserved.handle}?`,
    pairingConfirmPage(pending.client_display_name, reserved.handle, csrf),
  )
}

/**
 * Step 2: confirm. Takes this session's reservation (if any is still there and unexpired) and
 * redeems its code through the same atomic resolveAndConsumePairingCode the original single-
 * step door always used, so this still reads the merchant's CURRENT secret hash at the moment
 * of redemption, never at reservation time. A reservation gone missing here (never made,
 * already taken by an earlier confirm, or simply expired) gets the same "not verified" refusal
 * a bad code typed straight in would — there is nothing left to distinguish those cases by,
 * and there should not be: neither one grants anything.
 */
export async function handleConfirmPairAction(
  c: Context,
  oauth: Runtime,
  pending: AuthorizationRequestRecord,
  csrf: string,
  sessionHash: string,
  csrfHash: string,
  takeReservation: PairingReservationTaker = takeReservedPairingCode,
  resolvePairingCode: PairingCodeResolver = resolveAndConsumePairingCode,
): Promise<Response> {
  if (!isInitialAuthorizationRequest(pending)) {
    return browserError(c, 403, 'request_conflict', 'This sign-in is already preparing a new merchant. Continue that signup or cancel it first.')
  }
  const reservation = await takeReservation({ sessionHash, csrfHash })
  if (!reservation) {
    return pairingError(c, 'pairing_reservation_missing', 'No reserved pairing code is waiting for this sign-in.', pending.client_display_name, csrf)
  }
  const resolved = await resolvePairingCode({ codeHash: reservation.codeHash })
  if (!resolved) {
    return pairingError(c, 'pairing_code_expired_or_revoked', 'The reserved pairing code was already used, expired, or revoked.', pending.client_display_name, csrf)
  }
  const code = opaque(MARKET_OAUTH_AUTHORIZATION_CODE_PREFIX)
  const approved = await oauth.store.approveExistingMerchantAndIssueAuthorizationCode({
    sessionHash, csrfHash, merchantSecretHash: resolved.merchantSecretHash,
    authorizationCodeHash: sha256(code),
  })
  if (approved.status === 'request_unavailable') {
    const progress = await oauth.store.getAuthorizationRequestProgress({ sessionHash, csrfHash })
    return progress
      ? terminalAuthorizationResponse(c, progress)
      : browserError(c, 403, 'request_unavailable', 'This sign-in request is no longer available.')
  }
  if (approved.status === 'merchant_key_rejected') {
    return pairingError(c, 'pairing_merchant_key_changed', 'That pairing code no longer matches a current merchant key.', pending.client_display_name, csrf)
  }
  return redirect(c, callbackUrl(approved.redirectUri, approved.state, oauth.origin, { code }))
}
