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
import { MARKET_OAUTH_AUTHORIZATION_CODE_PREFIX } from './market-oauth-config.ts'
import {
  isInitialAuthorizationRequest,
  oauthBrowserError as browserError,
  oauthConsentPage as consentPage,
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

function pairingCodeRejected(
  pending: AuthorizationRequestRecord,
  csrf: string,
  codingIdentityReady: boolean,
): string {
  return '<p class="warning">That pairing code could not be verified, was already used, or expired. ' +
    'Mint a fresh one from the coding client and try again.</p>' +
    consentPage(pending.client_display_name, csrf, true, codingIdentityReady)
}

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
    return browserError(c, 403, 'This sign-in is already preparing a new merchant. Continue that signup or cancel it first.')
  }
  const pairingCode = oneFormValue(values, 'pairing_code', 80)
  if (!pairingCode || !PAIRING_CODE_RE.test(pairingCode)) {
    return html(c, 403, 'Pairing code not verified', pairingCodeRejected(pending, csrf, oauth.codingIdentityReady))
  }
  const allowed = await admitted(
    oauth,
    [`ip:${clientAddress(c, oauth.environment)}`, `client:${pending.client_id}`],
    'merchant_key',
    10,
  )
  if (!allowed) return browserError(c, 429, 'Too many pairing attempts. Try again after the next UTC hour.')
  const reserved = await reservePairing({ sessionHash, csrfHash, codeHash: sha256(pairingCode) })
  if (!reserved) {
    return html(c, 403, 'Pairing code not verified', pairingCodeRejected(pending, csrf, oauth.codingIdentityReady))
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
    return browserError(c, 403, 'This sign-in is already preparing a new merchant. Continue that signup or cancel it first.')
  }
  const reservation = await takeReservation({ sessionHash, csrfHash })
  if (!reservation) {
    return html(c, 403, 'Pairing code not verified', pairingCodeRejected(pending, csrf, oauth.codingIdentityReady))
  }
  const resolved = await resolvePairingCode({ codeHash: reservation.codeHash })
  if (!resolved) {
    return html(c, 403, 'Pairing code not verified', pairingCodeRejected(pending, csrf, oauth.codingIdentityReady))
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
      : browserError(c, 403, 'This sign-in request is no longer available.')
  }
  if (approved.status === 'merchant_key_rejected') {
    return html(
      c,
      403,
      'Pairing code not verified',
      '<p class="warning">That pairing code no longer matches a current merchant key. Mint a fresh pairing code and try again.</p>' +
        consentPage(pending.client_display_name, csrf, true, oauth.codingIdentityReady),
    )
  }
  return redirect(c, callbackUrl(approved.redirectUri, approved.state, oauth.origin, { code }))
}
