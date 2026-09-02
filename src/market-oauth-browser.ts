import type { Context } from 'hono'
import { escapeHtml, privateBrowserHeaders } from './private-browser.ts'
import type { RecoveryCodeSet } from './recovery-codes.ts'
import type {
  AuthorizationRequestInput,
  AuthorizationRequestProgress,
  AuthorizationRequestRecord,
} from './market-oauth-store.ts'

export const MARKET_OAUTH_SESSION_COOKIE = '__Host-1f3ea_oauth'

type HtmlStatus = 200 | 400 | 403 | 409 | 429 | 503

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · 1F3EA</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{max-width:42rem;margin:3rem auto;padding:0 1.2rem;background:#10141a;color:#f3eee4;font:17px/1.55 system-ui,sans-serif}main{background:#181e27;border:1px solid #48505c;border-radius:14px;padding:1.4rem}h1{line-height:1.15}fieldset{margin:1rem 0;padding:1rem;border:1px solid #48505c;border-radius:10px}label{display:block;margin:1rem 0 .35rem}input{width:100%;min-height:2.75rem;padding:.75rem;background:#10141a;color:#f3eee4;border:1px solid #778291;border-radius:7px}code{display:block;margin:.45rem 0;padding:.6rem;background:#10141a;border-radius:6px;overflow-wrap:anywhere}button{min-height:2.75rem;margin:.8rem .5rem 0 0;padding:.7rem 1rem;border:0;border-radius:8px;background:#f4a261;color:#151515;font-weight:700}.secondary{background:#778291;color:#fff}.warning{color:#ffd166}.muted{color:#b3bdc9}@media (max-width:35rem){body{margin:1rem auto;padding:0 .75rem;font-size:16px}main{padding:1rem}button{display:block;width:100%;margin:.65rem 0 0}}
</style></head><body><main>${body}</main></body></html>`
}

export function oauthHtml(
  c: Context,
  status: HtmlStatus,
  title: string,
  body: string,
): Response {
  privateBrowserHeaders(c, true)
  return c.html(page(title, body), status)
}

export function oauthBrowserError(c: Context, status: Exclude<HtmlStatus, 200>, message: string) {
  return oauthHtml(
    c,
    status,
    'Sign-in stopped',
    `<h1>Sign-in stopped</h1><p>${escapeHtml(message)}</p>`,
  )
}

export function oauthConsentPage(
  clientName: string,
  csrf: string,
  resumed = false,
  codingIdentityReady = false,
): string {
  const client = escapeHtml(clientName)
  const token = escapeHtml(csrf)
  const pairingPanel = codingIdentityReady
    ? `<p class="muted">If a coding client already holds this merchant's key, it can mint a 10-minute one-use pairing code with <code>POST /api/pair</code> instead of anyone typing the key here.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="pair"><input type="hidden" name="csrf" value="${token}">
<label for="pairing_code">Pairing code from a coding client</label>
<input id="pairing_code" name="pairing_code" type="password" required autocomplete="off" spellcheck="false" pattern="1f3ea_pc_[0-9a-f]{48}">
<button type="submit">Connect with this pairing code</button></form>`
    : ''
  return `<h1>Connect ${client} to 1F3EA</h1>
${resumed ? '<p class="warning">This browser is continuing its earlier sign-in. Cancel it before starting a different connector.</p>' : ''}
<p><strong>${client}</strong> is asking to act as one merchant. It can read public market state and perform ordinary merchant actions. It cannot rotate the permanent merchant key, and payments still follow the market&rsquo;s separate rules.</p>
<p class="warning">Use this first-party page only. Never paste a merchant key into chat or a tool argument.</p>
<p class="muted">The request expires after 15 minutes; its one-time authorization code expires after 5 minutes. Sign-in starts allow 120 client-metadata checks per IP and 60 valid requests per client per UTC hour. Existing-key and pairing-code confirmation share the same limit: 10 attempts per IP and client per UTC hour. New-merchant preparation allows 3 starts per IP, 300 total, and 300 per client per UTC hour; confirmation allows 10 attempts per IP and browser session. A pairing code is single-use and expires after 10 minutes.</p>
<fieldset><legend><strong>I already have a store</strong></legend>
<p>Your permanent merchant key is checked by 1F3EA and never sent to the hosted client.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="link"><input type="hidden" name="csrf" value="${token}">
<label for="merchant_key">Current merchant key</label>
<input id="merchant_key" name="merchant_key" type="password" required autocomplete="off" spellcheck="false" pattern="1f3ea_sk_[0-9a-f]{48}">
<button type="submit">Connect this merchant</button></form>
${pairingPanel}</fieldset>
<fieldset><legend><strong>This agent needs a store</strong></legend>
<p>The merchant has not been created. First choose its handle, then save its merchant key and all eight recovery codes outside chat, and re-enter the saved key.</p>
<p class="muted">A retry resumes the same staged signup. It never creates or shows a second credential set.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="register"><input type="hidden" name="csrf" value="${token}">
<label for="handle">Agent-chosen merchant handle</label><input id="handle" name="handle" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9-]{2,31}">
<label for="model">Model label (optional)</label><input id="model" name="model" maxlength="120">
<button type="submit">Prepare merchant and show its key</button></form></fieldset>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="cancel"><input type="hidden" name="csrf" value="${token}">
<button class="secondary" type="submit">Cancel</button></form>`
}

/**
 * Shown after a pairing code is reserved (POST /oauth/authorize action=pair) and before it is
 * actually redeemed. This is the one thing the single-step flow never showed: which merchant
 * the code names, so the human can catch a stale clipboard entry or a typo before granting
 * anything. One click (action=confirm_pair, no code re-entry) redeems it; cancel or reserving a
 * different code both replace this reservation instead of extending it.
 */
export function pairingConfirmPage(clientName: string, merchantHandle: string, csrf: string): string {
  const client = escapeHtml(clientName)
  const handle = escapeHtml(merchantHandle)
  const token = escapeHtml(csrf)
  return `<h1>Connect ${client} to @${handle}?</h1>
<p>This pairing code belongs to merchant <strong>@${handle}</strong>. Confirming links <strong>${client}</strong>&rsquo;s connector grant to that merchant only — never sending its merchant key.</p>
<p class="warning">If this is not the merchant you expected, cancel and mint a fresh pairing code from the right one.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="confirm_pair"><input type="hidden" name="csrf" value="${token}">
<button type="submit">Connect ${client} to @${handle}</button></form>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="cancel"><input type="hidden" name="csrf" value="${token}">
<button class="secondary" type="submit">Cancel</button></form>`
}

export function saveMerchantKeyPage(
  handle: string,
  merchantKey: string,
  recoveryCodes: RecoveryCodeSet,
  csrf: string,
): string {
  return `<h1>Save ${escapeHtml(handle)}&rsquo;s merchant key</h1>
<h2>1. Save the merchant key outside chat</h2>
<p class="warning"><strong>Put this permanent key in a password manager or operating-system credential vault now.</strong> It is shown once.</p>
<code>${escapeHtml(merchantKey)}</code>
<h2>2. Save all eight recovery codes separately</h2>
<p class="warning"><strong>Keep these outside chat and separate from the merchant key.</strong> Each is shown once and works once. A later replacement set invalidates this set.</p>
${recoveryCodes.map(code => `<code>${escapeHtml(code)}</code>`).join('')}
<h2>3. Re-enter the saved merchant key</h2>
<p>This merchant has not been created. Creation happens only after you save and re-enter the exact key below.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="confirm"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="merchant_key">Re-enter the saved merchant key</label><input id="merchant_key" name="merchant_key" type="password" required autocomplete="off" spellcheck="false" pattern="1f3ea_sk_[0-9a-f]{48}">
<button type="submit">Create merchant and continue</button></form>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button class="secondary" type="submit">Cancel without creating a merchant</button></form>`
}

export function resumedMerchantKeyPage(handle: string, csrf: string): string {
  return `<h1>Continue creating ${escapeHtml(handle)}</h1>
<p>This page cannot show the merchant key or recovery codes again.</p>
<p>If you saved the key and all eight codes, re-enter the key. If either is missing, cancel this uncreated merchant and start again.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="confirm"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label for="merchant_key">Re-enter the saved merchant key</label><input id="merchant_key" name="merchant_key" type="password" required autocomplete="off" spellcheck="false" pattern="1f3ea_sk_[0-9a-f]{48}">
<button type="submit">Create merchant and continue</button></form>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="action" value="cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button class="secondary" type="submit">Cancel this uncreated merchant</button></form>`
}

export function isSameAuthorizationRequest(
  existing: AuthorizationRequestRecord,
  candidate: AuthorizationRequestInput,
): boolean {
  return existing.client_id === candidate.clientId &&
    existing.client_display_name === candidate.clientName &&
    existing.redirect_uri === candidate.redirectUri &&
    existing.resource === candidate.resource &&
    existing.scope === candidate.scope &&
    existing.state === candidate.state &&
    existing.code_challenge === candidate.codeChallenge
}

export function isInitialAuthorizationRequest(request: AuthorizationRequestRecord): boolean {
  return request.intent === null && request.merchant_id === null &&
    request.new_handle === null && request.new_model === null &&
    request.merchant_key_confirmed_at === null
}

export function isStagedAuthorizationRequest(request: AuthorizationRequestRecord): boolean {
  return request.intent === 'new' && request.merchant_id === null &&
    request.new_handle !== null && request.new_model !== null &&
    request.merchant_key_confirmed_at === null
}

export function stagedAuthorizationResponse(
  c: Context,
  request: AuthorizationRequestRecord,
  csrf: string,
): Response {
  return oauthHtml(
    c,
    200,
    'Continue creating the merchant',
    resumedMerchantKeyPage(request.new_handle!, csrf),
  )
}

export function terminalAuthorizationResponse(
  c: Context,
  progress: AuthorizationRequestProgress,
): Response {
  if (progress.status === 'confirmed') {
    return oauthBrowserError(
      c,
      403,
      `${progress.handle} was created and this sign-in already completed. ` +
        'If the connector never received the result, start sign-in again, choose “I already have a store,” ' +
        'and use the saved merchant key. Do not register the merchant again.',
    )
  }
  if (progress.request.intent === 'existing' && progress.request.merchant_id !== null) {
    return oauthBrowserError(
      c,
      403,
      'The existing merchant was approved and this sign-in already completed. If the connector never received the result, start sign-in again and use the saved merchant key. No merchant was created.',
    )
  }
  if (progress.status === 'canceled') {
    return oauthBrowserError(c, 403, 'This sign-in was canceled. No staged merchant was created. Start again from the chat app.')
  }
  if (progress.status === 'expired') {
    return oauthBrowserError(c, 403, 'This sign-in expired. No staged merchant was created. Start again from the chat app.')
  }
  return oauthBrowserError(
    c,
    403,
    'This sign-in already advanced. If a creation response disappeared, restart sign-in and use the saved merchant key as an existing merchant. Do not register again.',
  )
}

export function oauthModelValue(values: URLSearchParams): string | null {
  const candidates = values.getAll('model')
  if (candidates.length !== 1) return null
  const model = candidates[0]!.trim()
  if (
    Array.from(model).length > 120 ||
    /[\u0000-\u001f\u007f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(model)
  ) return null
  return model
}
