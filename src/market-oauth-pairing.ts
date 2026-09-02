// Hosted OAuth's "pair" action: a human redeems a coding client's short-lived pairing code
// instead of typing the merchant key on the "I already have a store" panel. Split out of
// market-oauth.ts to keep that module under the project's 800-line ceiling.
import type { Context } from 'hono'

import { oneFormValue } from './browser-form.ts'
import { sha256 } from './core.ts'
import { MARKET_OAUTH_AUTHORIZATION_CODE_PREFIX } from './market-oauth-config.ts'
import {
  isInitialAuthorizationRequest,
  oauthBrowserError as browserError,
  oauthConsentPage as consentPage,
  oauthHtml as html,
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
import { PAIRING_CODE_RE, resolveAndConsumePairingCode } from './market-pairing-store.ts'

export type PairingCodeResolver = typeof resolveAndConsumePairingCode

function pairingCodeRejected(pending: AuthorizationRequestRecord, csrf: string): string {
  return '<p class="warning">That pairing code could not be verified, was already used, or expired. ' +
    'Mint a fresh one from the coding client and try again.</p>' +
    consentPage(pending.client_display_name, csrf, true)
}

export async function handlePairAction(
  c: Context,
  oauth: Runtime,
  pending: AuthorizationRequestRecord,
  csrf: string,
  values: URLSearchParams,
  sessionHash: string,
  csrfHash: string,
  resolvePairingCode: PairingCodeResolver = resolveAndConsumePairingCode,
): Promise<Response> {
  if (!isInitialAuthorizationRequest(pending)) {
    return browserError(c, 403, 'This sign-in is already preparing a new merchant. Continue that signup or cancel it first.')
  }
  const pairingCode = oneFormValue(values, 'pairing_code', 80)
  if (!pairingCode || !PAIRING_CODE_RE.test(pairingCode)) {
    return html(c, 403, 'Pairing code not verified', pairingCodeRejected(pending, csrf))
  }
  const allowed = await admitted(
    oauth,
    [`ip:${clientAddress(c, oauth.environment)}`, `client:${pending.client_id}`],
    'merchant_key',
    10,
  )
  if (!allowed) return browserError(c, 429, 'Too many pairing attempts. Try again after the next UTC hour.')
  const resolved = await resolvePairingCode({ codeHash: sha256(pairingCode) })
  if (!resolved) {
    return html(c, 403, 'Pairing code not verified', pairingCodeRejected(pending, csrf))
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
        consentPage(pending.client_display_name, csrf, true),
    )
  }
  return redirect(c, callbackUrl(approved.redirectUri, approved.state, oauth.origin, { code }))
}
