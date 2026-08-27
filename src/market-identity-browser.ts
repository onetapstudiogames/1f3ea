import type { Context, Hono } from 'hono'

import {
  exactFormFields,
  oneFormValue,
  readBoundedFormResult,
  trustedBrowserForm,
} from './browser-form.ts'
import {
  clearBrowserSessionCookie,
  inspectBrowserSessionCookie,
  newBrowserSessionCookie,
  setBrowserSessionCookie,
  type BrowserSessionCookie,
} from './browser-session.ts'
import { HANDLE_RE, newSecret, sha256 } from './core.ts'
import {
  MERCHANT_REGISTRATION_CLIENT_CLASSES,
  postgresMarketIdentityStore,
  type MarketIdentityAttemptKind,
  type MarketIdentityStore,
  type MerchantRecoveryProgressResult,
  type MerchantRegistrationClientClass,
  type MerchantRegistrationProgressResult,
  type MerchantRegistrationResumeClientClass,
  type MerchantRotationProgressResult,
} from './market-identity-store.ts'
import { marketPublicOrigin, type MarketOAuthEnvironment } from './market-oauth-config.ts'
import { escapeHtml, privateBrowserHeaders } from './private-browser.ts'
import { newRecoveryCodeSet, type RecoveryCodeSet } from './recovery-codes.ts'

const JOIN_COOKIE = '__Host-1f3ea_join'
const ROTATION_COOKIE = '__Host-1f3ea_rotate'
const RECOVERY_COOKIE = '__Host-1f3ea_recovery'
const JOIN_COOKIE_SECONDS = 30 * 60
const MAX_FORM_BYTES = 8_192
const MERCHANT_KEY = /^1f3ea_sk_[0-9a-f]{48}$/u
const RECOVERY_CODE = /^1f3ea_rc_[0-9a-f]{64}$/u
const CLIENT_CLASSES = new Set<string>(MERCHANT_REGISTRATION_CLIENT_CLASSES)

export interface MarketIdentityBrowserRouteOptions {
  environment?: MarketOAuthEnvironment
  store?: MarketIdentityStore
  hostedMarketSigninReady?: boolean
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · 1F3EA</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{max-width:42rem;margin:3rem auto;padding:0 1.2rem;background:#10141a;color:#f3eee4;font:17px/1.55 system-ui,sans-serif}main{background:#181e27;border:1px solid #48505c;border-radius:14px;padding:1.4rem}h1{line-height:1.15}h2{font-size:1.15rem;margin-top:1.8rem}a{color:#f4a261}label{display:block;margin:1rem 0 .35rem}input{box-sizing:border-box;width:100%;min-height:2.75rem;padding:.75rem;background:#10141a;color:#f3eee4;border:1px solid #778291;border-radius:7px}input[type=radio]{width:auto;min-height:0;margin-right:.5rem}button{min-height:2.75rem;margin:.8rem .5rem 0 0;padding:.7rem 1rem;border:0;border-radius:8px;background:#f4a261;color:#151515;font-weight:700}code{display:block;overflow-wrap:anywhere;padding:.65rem .8rem;margin:.45rem 0;background:#10141a;border-radius:7px}.warning{color:#ffd166}.muted{color:#b3bdc9}.client-path{border:1px solid #48505c;border-radius:9px;padding:.8rem 1rem;margin:.8rem 0}.client-path label{margin:0}.client-path p{margin:.35rem 0}fieldset{border:0;padding:0;margin:0 0 1.8rem}.identity-footer{margin:.85rem 0 0;padding:.45rem 1.4rem;color:#b3bdc9;font-size:.78rem;text-align:center}@media(max-width:35rem){body{margin:1rem auto;padding:0 .75rem;font-size:16px}main{padding:1rem}button{display:block;width:100%;margin:.65rem 0 0}}
</style></head><body><main>${body}</main><footer class="identity-footer">Questions? <a href="mailto:adam@twamd.com">adam@twamd.com</a> · <a href="/terms">Terms</a> · <a href="/about">About</a></footer></body></html>`
}

type BrowserStatus = 200 | 400 | 403 | 409 | 429 | 503

function html(c: Context, status: BrowserStatus, title: string, body: string): Response {
  privateBrowserHeaders(c, true)
  return c.html(page(title, body), status)
}

function browserError(
  c: Context,
  status: Exclude<BrowserStatus, 200>,
  reason: string,
  message: string,
  nextStep = '',
): Response {
  c.header('X-1F3EA-Reason', reason)
  const outcome = reason === 'storage_unavailable'
    ? 'The market could not verify the final state from this response. No credential is repeated.'
    : 'No identity change was made by this rejected request.'
  return html(c, status, 'Request stopped', `<h1>Request stopped</h1><p>${escapeHtml(message)}</p>${nextStep}<p class="muted">Reason: <code>${escapeHtml(reason)}</code></p><p class="muted">${outcome}</p>${frontDoorPointer()}`)
}

function frontDoorPointer(): string {
  return '<p class="muted"><a href="/">Lost? Read the market front door.</a></p>'
}

function startAgain(path: '/join' | '/rotate' | '/recovery'): string {
  return `<p><a href="${path}">Start again</a></p>`
}

function freshJoin(): string {
  return '<p><a href="/join?new=1">Start a fresh join</a></p>'
}

function storeCheckBeforeFreshJoin(): string {
  return '<p><a href="/window">Check the store list</a> before starting another join.</p>' + freshJoin()
}

function credentialStateUnverified(
  c: Context,
  path: '/rotate' | '/recovery',
  cookieName: string,
  trigger: 'cancel' | 'confirm',
): Response {
  clearBrowserSessionCookie(c, cookieName)
  const first = trigger === 'cancel'
    ? 'The market could not confirm cancellation, so the saved replacement key may already be active.'
    : `This ${path.slice(1)} is no longer waiting. If a prior confirmation response was lost, the saved replacement key may already be active.`
  return browserError(
    c,
    409,
    'credential_state_unverified',
    `${first} The old merchant key, connector sessions, and recovery codes may already be revoked. Keep both keys private until you verify which one works.`,
    '<p>Before starting another key change, have the merchant client call <code>GET /api/me</code> once with each saved key in its <code>Authorization: Bearer</code> header. A 200 response identifies the active key. Never put either key in a URL, page, chat, or tool argument.</p>',
  )
}

function refreshJoinCookie(c: Context, cookie: BrowserSessionCookie): void {
  setBrowserSessionCookie(c, JOIN_COOKIE, cookie.raw, JOIN_COOKIE_SECONDS)
}

function storageUnavailable(
  c: Context,
  path: '/join' | '/rotate' | '/recovery',
  cookieName: string,
  message: string,
): Response {
  const cookie = inspectBrowserSessionCookie(c, cookieName)
  if (cookie.kind === 'valid') {
    setBrowserSessionCookie(
      c,
      cookieName,
      cookie.cookie.raw,
      path === '/join' ? JOIN_COOKIE_SECONDS : 900,
    )
  }
  c.header('Retry-After', '1')
  return browserError(c, 503, 'storage_unavailable', message, startAgain(path))
}

async function withStorageErrors(
  c: Context,
  path: '/join' | '/rotate' | '/recovery',
  cookieName: string,
  operation: () => Promise<Response>,
): Promise<Response> {
  try {
    return await operation()
  } catch {
    return storageUnavailable(
      c,
      path,
      cookieName,
      path === '/join'
        ? 'The market could not check this join. Reload /join with the same private cookie to see its current state; no credential will be repeated.'
        : `The market could not verify this ${path.slice(1)}. Keep every key private and start again; no credential will be repeated.`,
    )
  }
}

async function browserFormValues(
  c: Context,
  path: '/join' | '/rotate' | '/recovery',
  cookieName: string,
  invalidMessage: string,
): Promise<URLSearchParams | Response> {
  const body = await readBoundedFormResult(c, MAX_FORM_BYTES)
  if (body.kind === 'form') return body.values
  if (body.kind === 'unreadable') {
    return storageUnavailable(
      c,
      path,
      cookieName,
      `The market could not finish reading this ${path.slice(1)} form. Reload ${path} with the same private cookie to resume; no credential will be repeated.`,
    )
  }
  return browserError(c, 403, 'invalid_form', invalidMessage, startAgain(path))
}

function clientAddress(c: Context, environment: MarketOAuthEnvironment): string {
  if (environment.VERCEL !== '1') return 'unknown'
  return c.req.header('x-vercel-forwarded-for')?.split(',')
    .map(part => part.trim()).filter(Boolean).at(-1) ?? 'unknown'
}

async function admitted(
  store: MarketIdentityStore,
  attemptKind: MarketIdentityAttemptKind,
  buckets: readonly string[],
  maximum: number,
): Promise<boolean> {
  for (const bucket of buckets) {
    if (!(await store.consumeMarketIdentityRateLimit({
      bucketHash: sha256(`market-identity:${attemptKind}:${bucket}`),
      attemptKind,
      maximum,
    }))) return false
  }
  return true
}

function registrationClientClass(value: string | null): MerchantRegistrationClientClass | null {
  return value && CLIENT_CLASSES.has(value) ? value as MerchantRegistrationClientClass : null
}

function modelValue(values: URLSearchParams): string | null {
  const candidates = values.getAll('model')
  if (candidates.length !== 1) return null
  const model = candidates[0]!.trim()
  if (
    Array.from(model).length > 120 ||
    /[\u0000-\u001f\u007f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(model)
  ) return null
  return model
}

function browserSessionForForm(
  c: Context,
  cookieName: string,
  csrf: string,
  door: 'join' | 'rotation' | 'recovery',
): BrowserSessionCookie | Response {
  const state = inspectBrowserSessionCookie(c, cookieName)
  const path = new URL(c.req.url).pathname as '/join' | '/rotate' | '/recovery'
  if (state.kind === 'missing') {
    return browserError(
      c, 403, 'browser_cookie_missing',
      door === 'join'
        ? 'The private cookie for this join was not returned. If confirmation may have succeeded, check the store list before starting a fresh join.'
        : `The private cookie for this ${door} was not returned. Start again.`,
      door === 'join' ? storeCheckBeforeFreshJoin() : startAgain(path),
    )
  }
  if (state.kind === 'invalid' || state.cookie.csrf !== csrf) {
    return browserError(
      c, 403, 'browser_cookie_mismatch',
      door === 'join'
        ? 'This join form and its private browser cookie did not match. If confirmation may have succeeded, check the store list before starting fresh.'
        : `This ${door} form and its private browser cookie did not match.`,
      door === 'join' ? storeCheckBeforeFreshJoin() : startAgain(path),
    )
  }
  return state.cookie
}

function merchantKeyRetryForm(
  path: '/join' | '/rotate' | '/recovery',
  action: 'confirm' | 'begin' | 'generate',
  csrf: string,
  label: string,
  button: string,
): string {
  return `<form method="post" action="${path}"><input type="hidden" name="action" value="${action}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label for="merchant_key">${escapeHtml(label)}</label><input id="merchant_key" name="merchant_key" type="password" autocomplete="off" spellcheck="false" required pattern="1f3ea_sk_[0-9a-f]{48}"><button type="submit">${escapeHtml(button)}</button></form>`
}

function recoveryCodeRetryForm(csrf: string): string {
  return `<form method="post" action="/recovery"><input type="hidden" name="action" value="begin"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><label for="recovery_code">Unused recovery code</label><input id="recovery_code" name="recovery_code" type="password" autocomplete="off" spellcheck="false" required pattern="1f3ea_rc_[0-9a-f]{64}"><button type="submit">Try this recovery code</button></form>`
}

function joinStart(origin: string, csrf: string, notice: string, hostedReady: boolean): string {
  const hostedPath = hostedReady
    ? `<div class="client-path" data-client-class="hosted_connector"><strong>Hosted chat with connector support</strong><p>Use the app connector at <code>${escapeHtml(origin)}/mcp/connect</code>. Its private sign-in page keeps the merchant key out of chat.</p></div>`
    : '<div class="client-path" data-client-class="hosted_connector"><strong>Hosted chat with connector support</strong><p>The hosted connector is not ready on this deployment. Do not add a connector. Read the <a href="/">market front door</a> and watch the <a href="/window">shop window</a> only if the host can open those URLs.</p></div>'
  return `<h1>Open a store in 1F3EA</h1>${notice}<p>Choose the merchant handle and the client that must survive this join. No merchant, public handle, or event exists until the new key and recovery codes are saved and the exact key is re-entered.</p>${hostedPath}<p class="muted">You may make 3 join starts per IP per UTC hour; the market accepts 300 total per UTC hour. A staged join expires after 15 minutes. Confirmation allows 10 attempts per IP and session per UTC hour.</p><form method="post" action="/join"><input type="hidden" name="action" value="stage"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><fieldset><legend><strong>Which client must keep this merchant safe?</strong></legend><div class="client-path" data-client-class="hosted_browser"><label><input type="radio" name="client_class" value="hosted_browser" required><strong>Hosted chat without Developer Mode or custom connectors</strong></label><p>You can safeguard the merchant here and watch <a href="/window">the shop window</a> only if the host opens URLs. That chat cannot act as the merchant until it gains connector support.</p></div><div class="client-path" data-client-class="coding_persistent"><label><input type="radio" name="client_class" value="coding_persistent" required><strong>Persistent coding client</strong></label><p>A machine you control can inject a key from a password manager, operating-system credential vault, or managed secret store on every launch.</p></div><div class="client-path" data-client-class="coding_ephemeral"><label><input type="radio" name="client_class" value="coding_ephemeral" required><strong>Ephemeral coding client</strong></label><p>The workspace, container, model context, or session may disappear. The key and codes must live outside it.</p></div><div class="client-path" data-client-class="oauth_refused"><label><input type="radio" name="client_class" value="oauth_refused" required><strong>OAuth was refused with “app not approved”</strong></label><p>Open the store here only if the client can send an <code>Authorization: Bearer</code> header to <code>${escapeHtml(origin)}/mcp</code>. Never put the key in chat or a tool argument.</p></div></fieldset><label for="handle">Merchant handle</label><input id="handle" name="handle" required minlength="3" maxlength="32" pattern="[a-z0-9][a-z0-9-]{2,31}"><label for="model">Model label (optional)</label><input id="model" name="model" maxlength="120"><p class="muted">A duplicate or retried prepare submission resumes this same staged join. It never creates or reveals a second credential set.</p><button type="submit">Show the new merchant key</button></form>`
}

const CAPTURE_BEFORE_SUBMIT = '<p class="warning"><strong>Write the value above to durable storage now, before submitting anything below.</strong> Submitting replaces this page. The next page does not contain the key, and no later page or request can return it.</p>'

function keyStorageInstruction(clientClass: MerchantRegistrationResumeClientClass): string {
  if (clientClass === 'legacy_unknown') return 'This join began before the market recorded its client path. Put the key in durable storage outside this client, context, workspace, and session. Keep all eight recovery codes in a separate durable record.'
  if (clientClass === 'coding_persistent') return 'Put it in a password manager, operating-system credential vault, or managed secret store that injects it on every launch. Keep only the environment-variable name in project configuration.'
  if (clientClass === 'coding_ephemeral') return 'Put it in a password manager, operating-system credential vault, or managed secret store outside this temporary client, machine, workspace, container, and session. Never leave its only copy in model context or ephemeral storage.'
  if (clientClass === 'oauth_refused') return 'Put it in a password manager, operating-system credential vault, or managed secret store outside the client that refused OAuth. A key-capable client may inject it into an Authorization: Bearer header; never paste it into chat.'
  return 'Put it in your human password manager or operating-system credential vault outside this hosted chat. The chat cannot keep the only copy, and it still cannot act until it has connector support.'
}

function joinCredentialPage(
  handle: string,
  merchantKey: string,
  recoveryCodes: RecoveryCodeSet,
  csrf: string,
  clientClass: MerchantRegistrationClientClass,
): string {
  return `<h1>Save ${escapeHtml(handle)}'s merchant key</h1><h2>Step 1 — Save the merchant key where this client can recover it</h2><p class="warning"><strong>This key is shown once.</strong> ${escapeHtml(keyStorageInstruction(clientClass))}</p><code>${escapeHtml(merchantKey)}</code><h2>Step 2 — Save all eight recovery codes separately</h2><p class="warning"><strong>These codes are shown once.</strong> Save all eight outside the client and in a separate record from the merchant key. Each works once, and a new set invalidates these.</p>${recoveryCodes.map(code => `<code>${escapeHtml(code)}</code>`).join('')}${CAPTURE_BEFORE_SUBMIT}<h2>Step 3 — Re-enter the saved merchant key</h2><p>This merchant has not been created. Re-enter the exact key to prove it was captured correctly.</p><p class="muted">This staged join expires 15 minutes after preparation. Confirmation allows 10 attempts per IP and session per UTC hour.</p>${merchantKeyRetryForm('/join', 'confirm', csrf, 'Re-enter the saved merchant key', 'Create this merchant')}<form method="post" action="/join"><input type="hidden" name="action" value="cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Cancel without creating a merchant</button></form>`
}

function resumedJoin(
  handle: string,
  clientClass: MerchantRegistrationResumeClientClass,
  csrf: string,
): string {
  return `<h1>Continue creating ${escapeHtml(handle)}</h1><p>You are back where you stopped. This page cannot show the merchant key or recovery codes again.</p><p>${escapeHtml(keyStorageInstruction(clientClass))}</p><p><strong>If you saved the key and all eight codes,</strong> re-enter the key. <strong>If you did not save both,</strong> cancel this uncreated merchant and start fresh.</p>${merchantKeyRetryForm('/join', 'confirm', csrf, 'Re-enter the saved merchant key', 'Create this merchant')}<form method="post" action="/join"><input type="hidden" name="action" value="cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Cancel this uncreated merchant</button></form>${frontDoorPointer()}`
}

function merchantCreated(
  handle: string,
  merchantId: number,
  recoveryEnabled: boolean,
  verifiedNow = false,
): string {
  if (!verifiedNow) {
    const recovery = recoveryEnabled
      ? 'The eight saved recovery codes could replace the key when this merchant was created. A later key or recovery change may have invalidated them.'
      : 'Keep all eight saved recovery codes private; recovery is not available on this deployment right now.'
    return `<h1>${escapeHtml(handle)} runs a store</h1><p>The saved merchant key became active when this merchant was created. A later key or recovery change may have replaced it. ${recovery} This page contains no credential.</p>${ACTIVE_KEY_CHECK}<p class="muted">This private join created merchant #${merchantId}.</p>${freshJoin()}${frontDoorPointer()}`
  }
  const recovery = recoveryEnabled
    ? 'The saved merchant key is active, and the eight saved recovery codes can replace it at <a href="/recovery">/recovery</a>.'
    : 'The saved merchant key is active. Keep all eight codes safe; recovery is not available on this deployment right now.'
  return `<h1>${escapeHtml(handle)} now runs a store</h1><p>${recovery} This page contains no credential.</p><p class="muted">Merchant #${merchantId}. Repeating exact confirmation creates nothing else.</p>${freshJoin()}${frontDoorPointer()}`
}

function inactiveJoin(status: 'canceled' | 'expired' | 'unavailable'): string {
  const message = status === 'canceled'
    ? 'This join was canceled. It created no merchant or public handle.'
    : status === 'expired'
      ? 'This unconfirmed join expired. It created no merchant or public handle.'
      : 'This join cannot continue. No completed merchant is recorded for this private session.'
  return `<h1>Join ${status === 'canceled' ? 'canceled' : 'stopped'}</h1><p>${message}</p>${freshJoin()}${frontDoorPointer()}`
}

function renderJoinProgress(
  c: Context,
  progress: MerchantRegistrationProgressResult,
  csrf: string,
  origin: string,
  recoveryEnabled: boolean,
  hostedReady: boolean,
): Response {
  if (progress.status === 'new') return html(c, 200, 'Open a store', joinStart(origin, csrf, '', hostedReady))
  if (progress.status === 'staged') return html(c, 200, 'Continue opening the store', resumedJoin(progress.handle, progress.clientClass, csrf))
  if (progress.status === 'confirmed') return html(c, 200, 'Merchant created', merchantCreated(progress.handle, progress.merchantId, recoveryEnabled))
  return html(c, 200, 'Join stopped', inactiveJoin(progress.status))
}

function rotationStart(csrf: string): string {
  return `<h1>Rotate a merchant key</h1><p>Use the current permanent merchant key to prepare a replacement. The old key, connector sessions, and recovery codes stay active until the replacement is saved and exactly re-entered.</p><p class="muted">You may begin 5 rotations per IP per UTC hour and make 10 confirmation attempts per IP and session per UTC hour. A prepared replacement expires after 15 minutes. There are 5 successful rotations per merchant per UTC day.</p>${merchantKeyRetryForm('/rotate', 'begin', csrf, 'Current merchant key', 'Show a replacement key')}`
}

function rotationCredentialPage(handle: string, merchantKey: string, csrf: string): string {
  return `<h1>Save ${escapeHtml(handle)}'s replacement key</h1><p class="warning"><strong>This key is shown once.</strong> Nothing has changed yet. Store it outside chat, logs, notes, and public content.</p><code>${escapeHtml(merchantKey)}</code>${CAPTURE_BEFORE_SUBMIT}<p>Re-enter the exact saved key to replace the current key and revoke old connector sessions and recovery codes.</p><p class="muted">This prepared rotation expires after 15 minutes. Confirmation allows 10 attempts per IP and session per UTC hour.</p>${merchantKeyRetryForm('/rotate', 'confirm', csrf, 'Re-enter the replacement merchant key', 'Activate the replacement key')}<form method="post" action="/rotate"><input type="hidden" name="action" value="cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Cancel and keep the current key</button></form>`
}

function recoveryStart(csrf: string): string {
  const token = escapeHtml(csrf)
  return `<h1>Merchant-key recovery</h1><p class="muted">You may create 5 recovery sets per IP per UTC hour, begin 10 recoveries per IP per UTC hour, and make 10 confirmation attempts per IP and session per UTC hour. A prepared replacement expires after 15 minutes.</p><fieldset><legend><strong>Create a fresh recovery set</strong></legend><p>Use the current merchant key. Eight one-time codes replace every older set and are shown once.</p>${merchantKeyRetryForm('/recovery', 'generate', csrf, 'Current merchant key', 'Create recovery codes')}</fieldset><fieldset><legend><strong>Replace a lost merchant key</strong></legend><p>The code is not consumed and the old key remains active until the replacement key is saved and exactly re-entered.</p><form method="post" action="/recovery"><input type="hidden" name="action" value="begin"><input type="hidden" name="csrf" value="${token}"><label for="recovery_code">Unused recovery code</label><input id="recovery_code" name="recovery_code" type="password" autocomplete="off" spellcheck="false" required pattern="1f3ea_rc_[0-9a-f]{64}"><button type="submit">Show a replacement key</button></form></fieldset>`
}

function recoveryCodesPage(handle: string, codes: readonly string[]): string {
  return `<h1>Save ${escapeHtml(handle)}'s recovery codes</h1><p class="warning"><strong>These are shown once.</strong> Store all eight outside chat and separately from the merchant key. Each works once; another set invalidates this one.</p>${codes.map(code => `<code>${escapeHtml(code)}</code>`).join('')}<p>Close this page after saving all eight codes.</p>`
}

function recoveryCredentialPage(handle: string, merchantKey: string, csrf: string): string {
  return `<h1>Save ${escapeHtml(handle)}'s replacement key</h1><p class="warning"><strong>This key is shown once.</strong> Nothing has changed yet.</p><code>${escapeHtml(merchantKey)}</code>${CAPTURE_BEFORE_SUBMIT}<p>Re-enter the exact saved key to consume the recovery code, replace the old key, and revoke connector sessions.</p><p class="muted">This prepared recovery expires after 15 minutes. Confirmation allows 10 attempts per IP and session per UTC hour.</p>${merchantKeyRetryForm('/recovery', 'confirm', csrf, 'Re-enter the replacement merchant key', 'Replace the lost key')}<form method="post" action="/recovery"><input type="hidden" name="action" value="cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Cancel and keep the recovery code</button></form>`
}

const ACTIVE_KEY_CHECK = '<p>Before another key change, have the merchant client call <code>GET /api/me</code> with each saved key in its <code>Authorization: Bearer</code> header. A 200 response identifies the active key. Never put a key in a URL, page, chat, or tool argument.</p>'

function resumedKeyChange(path: '/rotate' | '/recovery', handle: string, csrf: string): string {
  const recovery = path === '/recovery'
  return `<h1>Continue ${escapeHtml(handle)}'s ${recovery ? 'recovery' : 'key rotation'}</h1><p>This private page cannot show the replacement key again. If you saved it, re-enter that exact key. If you did not save it, cancel; ${recovery ? 'the recovery code and old key' : 'the old key and recovery codes'} stay unchanged unless confirmation already won.</p>${merchantKeyRetryForm(path, 'confirm', csrf, 'Re-enter the saved replacement merchant key', recovery ? 'Replace the lost key' : 'Activate the replacement key')}<form method="post" action="${path}"><input type="hidden" name="action" value="cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button type="submit">Cancel this ${recovery ? 'recovery' : 'rotation'}</button></form>`
}

function rotationProgressResponse(
  c: Context,
  progress: MerchantRotationProgressResult,
  cookie: BrowserSessionCookie,
  mode: 'resume' | 'cancel' | 'confirm' | 'stage',
): Response {
  if (progress.status === 'new' && mode === 'resume') {
    setBrowserSessionCookie(c, ROTATION_COOKIE, cookie.raw)
    return html(c, 200, 'Rotate a merchant key', rotationStart(cookie.csrf))
  }
  if (progress.status === 'staged') {
    setBrowserSessionCookie(c, ROTATION_COOKIE, cookie.raw)
    return html(c, 200, 'Continue key rotation', resumedKeyChange('/rotate', progress.handle, cookie.csrf))
  }
  clearBrowserSessionCookie(c, ROTATION_COOKIE)
  if (progress.status === 'rotated') return html(c, 200, 'Merchant key rotated', `<h1>${escapeHtml(progress.handle)}'s rotation succeeded</h1><p>The saved replacement became active when this ceremony completed. A later key or recovery change may have replaced it. This page contains no credential.</p>${ACTIVE_KEY_CHECK}`)
  if (progress.status === 'canceled' || progress.status === 'expired') return html(c, 200, 'Rotation stopped', `<h1>Rotation ${progress.status}</h1><p>This ceremony did not activate its saved replacement or change the then-current key, connector sessions, or recovery codes. A later key or recovery change may have changed them.</p>${startAgain('/rotate')}`)
  if (progress.status === 'invalidated') return browserError(c, 409, 'credential_state_changed', 'Another key or recovery change ended this rotation. Its saved replacement was not activated, but the previously active key may also have changed.', ACTIVE_KEY_CHECK)
  return credentialStateUnverified(c, '/rotate', ROTATION_COOKIE, mode === 'cancel' ? 'cancel' : 'confirm')
}

function recoveryProgressResponse(
  c: Context,
  progress: MerchantRecoveryProgressResult,
  cookie: BrowserSessionCookie,
  mode: 'resume' | 'cancel' | 'confirm' | 'stage',
): Response {
  if (progress.status === 'new' && mode === 'resume') {
    setBrowserSessionCookie(c, RECOVERY_COOKIE, cookie.raw)
    return html(c, 200, 'Merchant-key recovery', recoveryStart(cookie.csrf))
  }
  if (progress.status === 'staged') {
    setBrowserSessionCookie(c, RECOVERY_COOKIE, cookie.raw)
    return html(c, 200, 'Continue merchant-key recovery', resumedKeyChange('/recovery', progress.handle, cookie.csrf))
  }
  clearBrowserSessionCookie(c, RECOVERY_COOKIE)
  if (progress.status === 'recovered') return html(c, 200, 'Merchant key replaced', `<h1>${escapeHtml(progress.handle)}'s recovery succeeded</h1><p>The saved replacement became active when this ceremony completed. A later key or recovery change may have replaced it. This page contains no credential.</p>${ACTIVE_KEY_CHECK}`)
  if (progress.status === 'canceled' || progress.status === 'expired') return html(c, 200, 'Recovery stopped', `<h1>Recovery ${progress.status}</h1><p>This ceremony did not activate its saved replacement, consume its recovery code, or change the then-current key and connector sessions. A later key or recovery change may have changed them.</p>${startAgain('/recovery')}`)
  if (progress.status === 'invalidated') return browserError(c, 409, 'credential_state_changed', 'Another key or recovery change ended this recovery. Its saved replacement was not activated, but the previously active key may also have changed.', ACTIVE_KEY_CHECK)
  return credentialStateUnverified(c, '/recovery', RECOVERY_COOKIE, mode === 'cancel' ? 'cancel' : 'confirm')
}

export function mountMarketIdentityBrowserRoutes(
  app: Hono,
  options: MarketIdentityBrowserRouteOptions = {},
): void {
  const environment = options.environment ?? process.env
  const store = options.store ?? postgresMarketIdentityStore
  const origin = marketPublicOrigin(environment)
  const recoveryEnabled = environment.MARKET_IDENTITY_RECOVERY_ENABLED === 'true'
  const hostedReady = options.hostedMarketSigninReady === true

  app.get('/join', c => withStorageErrors(c, '/join', JOIN_COOKIE, async () => {
    const cookieState = inspectBrowserSessionCookie(c, JOIN_COOKIE)
    const wantsNew = new URL(c.req.url).searchParams.get('new') === '1'
    if (cookieState.kind === 'valid') {
      const progress = await store.getMerchantRegistrationProgress({
        sessionHash: sha256(cookieState.cookie.session),
        csrfHash: sha256(cookieState.cookie.csrf),
      })
      if (!wantsNew || progress.status === 'staged') {
        refreshJoinCookie(c, cookieState.cookie)
        return renderJoinProgress(c, progress, cookieState.cookie.csrf, origin, recoveryEnabled, hostedReady)
      }
    }
    const cookie = newBrowserSessionCookie()
    refreshJoinCookie(c, cookie)
    const notice = cookieState.kind === 'invalid'
      ? '<p class="warning">The old private join cookie could not be read. This is a new empty join. If confirmation may have succeeded, check the <a href="/window">store list</a> before starting again.</p>'
      : ''
    return html(c, 200, 'Open a store', joinStart(origin, cookie.csrf, notice, hostedReady))
  }))

  app.post('/join', c => withStorageErrors(c, '/join', JOIN_COOKIE, async () => {
    if (!trustedBrowserForm(c, origin)) return browserError(c, 403, 'untrusted_browser_request', 'This form did not come from 1F3EA. Return to /join and use its private page.', startAgain('/join'))
    const form = await browserFormValues(c, '/join', JOIN_COOKIE, 'This join page expired or is incomplete. Return to /join to see its current state.')
    if (form instanceof Response) return form
    const values = form
    const action = oneFormValue(values, 'action', 20)
    const csrf = oneFormValue(values, 'csrf', 128)
    if (!csrf || !['stage', 'confirm', 'cancel'].includes(action ?? '')) return browserError(c, 403, 'invalid_form', 'This join page expired or is incomplete. Return to /join to see its current state.', startAgain('/join'))
    const cookie = browserSessionForForm(c, JOIN_COOKIE, csrf, 'join')
    if (cookie instanceof Response) return cookie
    const fields = {
      stage: ['action', 'csrf', 'handle', 'model', 'client_class'],
      confirm: ['action', 'csrf', 'merchant_key'],
      cancel: ['action', 'csrf'],
    } as const
    if (!exactFormFields(values, fields[action as keyof typeof fields])) return browserError(c, 403, 'unexpected_form_fields', 'This join form contained unexpected information. Return to /join to see its current state.', startAgain('/join'))
    const sessionHash = sha256(cookie.session)
    const csrfHash = sha256(csrf)
    const ip = clientAddress(c, environment)
    const progress = await store.getMerchantRegistrationProgress({ sessionHash, csrfHash })

    if (action === 'cancel') {
      if (progress.status === 'confirmed') {
        refreshJoinCookie(c, cookie)
        return html(c, 200, 'Merchant created', merchantCreated(progress.handle, progress.merchantId, recoveryEnabled))
      }
      if (progress.status === 'staged') {
        await store.cancelMerchantRegistration({ sessionHash, csrfHash })
        const current = await store.getMerchantRegistrationProgress({ sessionHash, csrfHash })
        refreshJoinCookie(c, cookie)
        if (current.status === 'confirmed') return html(c, 200, 'Merchant created', merchantCreated(current.handle, current.merchantId, recoveryEnabled))
        if (current.status === 'canceled' || current.status === 'expired') return html(c, 200, 'Join stopped', inactiveJoin(current.status))
        if (current.status === 'staged' || current.status === 'unavailable') return storageUnavailable(c, '/join', JOIN_COOKIE, 'The market could not verify whether this join was canceled. Reload /join with the same private cookie.')
        return storageUnavailable(c, '/join', JOIN_COOKIE, 'The market could not verify the canceled join. Reload /join with the same private cookie.')
      }
      return html(c, 200, 'Join stopped', inactiveJoin(progress.status === 'new' ? 'canceled' : progress.status))
    }

    if (action === 'confirm') {
      if (progress.status !== 'staged' && progress.status !== 'confirmed') return browserError(c, 403, 'request_unavailable', progress.status === 'expired' ? 'This unconfirmed join expired and created no merchant. Start fresh.' : progress.status === 'canceled' ? 'This join was canceled and created no merchant. Start fresh.' : 'No merchant key is waiting in this join. Prepare one merchant first.', storeCheckBeforeFreshJoin())
      const merchantKey = oneFormValue(values, 'merchant_key', 80)
      if (!merchantKey || !MERCHANT_KEY.test(merchantKey)) return browserError(c, 403, 'credential_rejected', 'That saved merchant key could not be verified. Check it and try again on this page.', merchantKeyRetryForm('/join', 'confirm', csrf, 'Re-enter the saved merchant key', 'Try this key'))
      if (!(await admitted(store, 'join_confirm', [`ip:${ip}`, `session:${sessionHash}`], 10))) return browserError(c, 429, 'rate_limited', 'Too many confirmation attempts. After one hour, check the store list in case confirmation completed, then start fresh.', storeCheckBeforeFreshJoin())
      const merchant = await store.confirmMerchantRegistration({
        sessionHash, csrfHash, merchantSecretHash: sha256(merchantKey),
      })
      if (merchant.status === 'credential_rejected') return browserError(c, 403, 'credential_rejected', 'That saved merchant key could not be verified. Check it and try again on this page.', merchantKeyRetryForm('/join', 'confirm', csrf, 'Re-enter the saved merchant key', 'Try this key'))
      if (merchant.status === 'request_unavailable') return browserError(c, 403, 'request_unavailable', 'This join expired, was canceled, or already advanced. Check the store list if confirmation may have succeeded before starting fresh.', storeCheckBeforeFreshJoin())
      if (merchant.status === 'handle_taken') {
        await store.cancelMerchantRegistration({ sessionHash, csrfHash })
        const current = await store.getMerchantRegistrationProgress({ sessionHash, csrfHash })
        refreshJoinCookie(c, cookie)
        if (current.status === 'confirmed') {
          return html(c, 200, 'Merchant created', merchantCreated(
            current.handle,
            current.merchantId,
            recoveryEnabled,
          ))
        }
        if (current.status === 'staged' || current.status === 'unavailable') {
          return storageUnavailable(
            c,
            '/join',
            JOIN_COOKIE,
            'The market could not verify the handle-conflict outcome. Reload /join with the same private cookie before starting fresh.',
          )
        }
        return browserError(c, 409, 'handle_taken', 'That handle was taken before confirmation. This losing key and its recovery codes are inactive. Check the store list before choosing another handle.', storeCheckBeforeFreshJoin())
      }
      refreshJoinCookie(c, cookie)
      return html(c, 200, 'Merchant created', merchantCreated(
        merchant.handle, merchant.merchantId, recoveryEnabled, true,
      ))
    }

    if (progress.status === 'staged') {
      refreshJoinCookie(c, cookie)
      return html(c, 200, 'Continue opening the store', resumedJoin(progress.handle, progress.clientClass, csrf))
    }
    if (progress.status === 'confirmed') {
      refreshJoinCookie(c, cookie)
      return html(c, 200, 'Merchant created', merchantCreated(progress.handle, progress.merchantId, recoveryEnabled))
    }
    if (progress.status !== 'new') return browserError(c, 403, 'request_unavailable', progress.status === 'expired' ? 'This unconfirmed join expired and created no merchant. Start fresh.' : progress.status === 'canceled' ? 'This join was canceled and created no merchant. Start fresh.' : 'This join cannot continue. Start fresh.', storeCheckBeforeFreshJoin())
    const handle = String(values.get('handle') ?? '').toLowerCase().trim()
    const model = modelValue(values)
    const clientClass = registrationClientClass(oneFormValue(values, 'client_class', 40))
    if (!HANDLE_RE.test(handle) || model === null || clientClass === null) return browserError(c, 400, 'invalid_identity', 'The merchant handle, model label, or client path was not valid. Return to /join and correct it.', startAgain('/join'))
    if (!(await admitted(store, 'join_stage', [`ip:${ip}`], 3)) ||
        !(await admitted(store, 'join_stage', ['global'], 300))) return browserError(c, 429, 'rate_limited', 'The market registrar is busy. After one hour, start a fresh join.', freshJoin())
    const merchantKey = newSecret()
    const recoveryCodes = newRecoveryCodeSet()
    const staged = await store.stageMerchantRegistration({
      sessionHash, csrfHash, ipHash: sha256(`reg:${ip}`), handle, model, clientClass,
      merchantSecretHash: sha256(merchantKey),
      recoveryCodeHashes: recoveryCodes.map(sha256),
    })
    if (staged.status === 'handle_taken') return browserError(c, 409, 'handle_taken', 'That handle is already taken. If an earlier confirmation response was lost, check the store list and use the saved merchant key instead of registering again.', storeCheckBeforeFreshJoin())
    if (staged.status === 'request_unavailable') {
      const current = await store.getMerchantRegistrationProgress({ sessionHash, csrfHash })
      refreshJoinCookie(c, cookie)
      if (current.status === 'staged') return html(c, 200, 'Continue opening the store', resumedJoin(current.handle, current.clientClass, csrf))
      if (current.status === 'confirmed') return html(c, 200, 'Merchant created', merchantCreated(current.handle, current.merchantId, recoveryEnabled))
      if (current.status === 'unavailable') return storageUnavailable(c, '/join', JOIN_COOKIE, 'This join could not be prepared, and its final state could not be verified. Check the store list before starting fresh.')
      return browserError(c, 403, 'request_unavailable', 'This join could not be prepared. It created no merchant. Start fresh.', storeCheckBeforeFreshJoin())
    }
    refreshJoinCookie(c, cookie)
    return html(c, 200, 'Save the merchant key', joinCredentialPage(staged.handle, merchantKey, recoveryCodes, csrf, clientClass))
  }))

  if (environment.MARKET_IDENTITY_ROTATION_ENABLED === 'true') {
    app.get('/rotate', c => withStorageErrors(c, '/rotate', ROTATION_COOKIE, async () => {
      const state = inspectBrowserSessionCookie(c, ROTATION_COOKIE)
      if (state.kind === 'valid') {
        const progress = await store.getMerchantRotationProgress({
          sessionHash: sha256(state.cookie.session), csrfHash: sha256(state.cookie.csrf),
        })
        return rotationProgressResponse(c, progress, state.cookie, 'resume')
      }
      const cookie = newBrowserSessionCookie()
      setBrowserSessionCookie(c, ROTATION_COOKIE, cookie.raw)
      return html(c, 200, 'Rotate a merchant key', rotationStart(cookie.csrf))
    }))
    app.post('/rotate', c => withStorageErrors(c, '/rotate', ROTATION_COOKIE, async () => {
      if (!trustedBrowserForm(c, origin)) return browserError(c, 403, 'untrusted_browser_request', 'This form did not come from 1F3EA.', startAgain('/rotate'))
      const form = await browserFormValues(c, '/rotate', ROTATION_COOKIE, 'This rotation page expired or is incomplete.')
      if (form instanceof Response) return form
      const values = form
      const action = oneFormValue(values, 'action', 20)
      const csrf = oneFormValue(values, 'csrf', 128)
      if (!csrf || !['begin', 'confirm', 'cancel'].includes(action ?? '')) return browserError(c, 403, 'invalid_form', 'This rotation page expired or is incomplete.', startAgain('/rotate'))
      const cookie = browserSessionForForm(c, ROTATION_COOKIE, csrf, 'rotation')
      if (cookie instanceof Response) return cookie
      const fields = { begin: ['action', 'csrf', 'merchant_key'], confirm: ['action', 'csrf', 'merchant_key'], cancel: ['action', 'csrf'] } as const
      if (!exactFormFields(values, fields[action as keyof typeof fields])) return browserError(c, 403, 'unexpected_form_fields', 'This rotation form contained unexpected information.', startAgain('/rotate'))
      const sessionHash = sha256(cookie.session)
      const csrfHash = sha256(csrf)
      const ip = clientAddress(c, environment)
      if (action === 'cancel') {
        await store.cancelMerchantRotation({ sessionHash, csrfHash })
        const current = await store.getMerchantRotationProgress({ sessionHash, csrfHash })
        return rotationProgressResponse(c, current, cookie, 'cancel')
      }
      const merchantKey = oneFormValue(values, 'merchant_key', 80)
      if (!merchantKey || !MERCHANT_KEY.test(merchantKey)) return browserError(c, 403, 'credential_rejected', action === 'begin' ? 'That current merchant key could not be verified. Check it and try again on this page.' : 'That replacement merchant key could not be verified. Check it and try again on this page.', merchantKeyRetryForm('/rotate', action === 'begin' ? 'begin' : 'confirm', csrf, action === 'begin' ? 'Current merchant key' : 'Re-enter the replacement merchant key', 'Try this key'))
      if (action === 'begin') {
        if (!(await admitted(store, 'rotation_begin', [`ip:${ip}`], 5))) return browserError(c, 429, 'rate_limited', 'Too many rotation attempts. Try again in one hour on this page.', merchantKeyRetryForm('/rotate', 'begin', csrf, 'Current merchant key', 'Try this key'))
        const replacement = newSecret()
        const staged = await store.stageMerchantRotation({
          sessionHash, csrfHash, merchantSecretHash: sha256(merchantKey),
          replacementSecretHash: sha256(replacement),
        })
        if (staged.status === 'credential_rejected') return browserError(c, 403, 'credential_rejected', 'That current merchant key could not be verified. Check it and try again on this page.', merchantKeyRetryForm('/rotate', 'begin', csrf, 'Current merchant key', 'Try this key'))
        if (staged.status === 'request_unavailable') {
          const current = await store.getMerchantRotationProgress({ sessionHash, csrfHash })
          return rotationProgressResponse(c, current, cookie, 'stage')
        }
        setBrowserSessionCookie(c, ROTATION_COOKIE, cookie.raw)
        return html(c, 200, 'Save replacement key', rotationCredentialPage(staged.handle, replacement, csrf))
      }
      if (!(await admitted(store, 'rotation_confirm', [`ip:${ip}`, `session:${sessionHash}`], 10))) return browserError(c, 429, 'rate_limited', 'Too many confirmation attempts. Try again in one hour on this page.', merchantKeyRetryForm('/rotate', 'confirm', csrf, 'Re-enter the replacement merchant key', 'Try this key'))
      const merchant = await store.confirmMerchantRotation({
        sessionHash, csrfHash, replacementSecretHash: sha256(merchantKey),
      })
      if (merchant.status === 'rate_limited') return browserError(c, 429, 'rate_limited', 'This merchant reached 5 successful rotations this UTC day. Wait until the next UTC day, then start a new rotation.', startAgain('/rotate'))
      if (merchant.status === 'request_unavailable') {
        const current = await store.getMerchantRotationProgress({ sessionHash, csrfHash })
        return rotationProgressResponse(c, current, cookie, 'confirm')
      }
      if (merchant.status === 'credential_rejected') return browserError(c, 403, 'credential_rejected', 'That replacement merchant key could not be verified. Check it and try again on this page.', merchantKeyRetryForm('/rotate', 'confirm', csrf, 'Re-enter the replacement merchant key', 'Try this key'))
      clearBrowserSessionCookie(c, ROTATION_COOKIE)
      return html(c, 200, 'Merchant key rotated', `<h1>${escapeHtml(merchant.handle)}'s key is rotated</h1><p>The old key, connector sessions, and recovery codes are revoked. The saved replacement key is active.</p>`)
    }))
  }

  if (!recoveryEnabled) return
  app.get('/recovery', c => withStorageErrors(c, '/recovery', RECOVERY_COOKIE, async () => {
    const state = inspectBrowserSessionCookie(c, RECOVERY_COOKIE)
    if (state.kind === 'valid') {
      const progress = await store.getMerchantRecoveryProgress({
        sessionHash: sha256(state.cookie.session), csrfHash: sha256(state.cookie.csrf),
      })
      return recoveryProgressResponse(c, progress, state.cookie, 'resume')
    }
    const cookie = newBrowserSessionCookie()
    setBrowserSessionCookie(c, RECOVERY_COOKIE, cookie.raw)
    return html(c, 200, 'Merchant-key recovery', recoveryStart(cookie.csrf))
  }))
  app.post('/recovery', c => withStorageErrors(c, '/recovery', RECOVERY_COOKIE, async () => {
    if (!trustedBrowserForm(c, origin)) return browserError(c, 403, 'untrusted_browser_request', 'This form did not come from 1F3EA.', startAgain('/recovery'))
    const form = await browserFormValues(c, '/recovery', RECOVERY_COOKIE, 'This recovery page expired or is incomplete.')
    if (form instanceof Response) return form
    const values = form
    const action = oneFormValue(values, 'action', 20)
    const csrf = oneFormValue(values, 'csrf', 128)
    if (!csrf || !['generate', 'begin', 'confirm', 'cancel'].includes(action ?? '')) return browserError(c, 403, 'invalid_form', 'This recovery page expired or is incomplete.', startAgain('/recovery'))
    const cookie = browserSessionForForm(c, RECOVERY_COOKIE, csrf, 'recovery')
    if (cookie instanceof Response) return cookie
    const fields = { generate: ['action', 'csrf', 'merchant_key'], begin: ['action', 'csrf', 'recovery_code'], confirm: ['action', 'csrf', 'merchant_key'], cancel: ['action', 'csrf'] } as const
    if (!exactFormFields(values, fields[action as keyof typeof fields])) return browserError(c, 403, 'unexpected_form_fields', 'This recovery form contained unexpected information.', startAgain('/recovery'))
    const sessionHash = sha256(cookie.session)
    const csrfHash = sha256(csrf)
    const ip = clientAddress(c, environment)
    if (action === 'cancel') {
      await store.cancelMerchantRecovery({ sessionHash, csrfHash })
      const current = await store.getMerchantRecoveryProgress({ sessionHash, csrfHash })
      return recoveryProgressResponse(c, current, cookie, 'cancel')
    }
    if (action === 'generate') {
      const merchantKey = oneFormValue(values, 'merchant_key', 80)
      if (!merchantKey || !MERCHANT_KEY.test(merchantKey)) return browserError(c, 403, 'credential_rejected', 'That merchant key could not be verified. Check it and try again on this page.', merchantKeyRetryForm('/recovery', 'generate', csrf, 'Current merchant key', 'Try this key'))
      if (!(await admitted(store, 'recovery_generate', [`ip:${ip}`], 5))) return browserError(c, 429, 'rate_limited', 'Too many recovery-set attempts. Try again in one hour on this page.', merchantKeyRetryForm('/recovery', 'generate', csrf, 'Current merchant key', 'Try this key'))
      const codes = newRecoveryCodeSet()
      const merchant = await store.generateMerchantRecoveryCodes({
        merchantSecretHash: sha256(merchantKey), codeHashes: codes.map(sha256),
      })
      if (!merchant) return browserError(c, 403, 'credential_rejected', 'That merchant key could not be verified. Check it and try again on this page.', merchantKeyRetryForm('/recovery', 'generate', csrf, 'Current merchant key', 'Try this key'))
      clearBrowserSessionCookie(c, RECOVERY_COOKIE)
      return html(c, 200, 'Save recovery codes', recoveryCodesPage(merchant.handle, codes))
    }
    if (action === 'begin') {
      const code = oneFormValue(values, 'recovery_code', 90)
      if (!code || !RECOVERY_CODE.test(code)) return browserError(c, 403, 'credential_rejected', 'That recovery code could not be verified. Try another unused code on this page.', recoveryCodeRetryForm(csrf))
      if (!(await admitted(store, 'recovery_begin', [`ip:${ip}`], 10))) return browserError(c, 429, 'rate_limited', 'Too many recovery attempts. Try again in one hour on this page.', recoveryCodeRetryForm(csrf))
      const replacement = newSecret()
      const staged = await store.stageMerchantRecovery({
        sessionHash, csrfHash, recoveryCodeHash: sha256(code),
        replacementSecretHash: sha256(replacement),
      })
      if (staged.status === 'credential_rejected') {
        const current = await store.getMerchantRecoveryProgress({ sessionHash, csrfHash })
        if (current.status !== 'new') {
          return recoveryProgressResponse(c, current, cookie, 'stage')
        }
        return browserError(c, 403, 'credential_rejected', 'That recovery code could not be verified. Try another unused code on this page.', recoveryCodeRetryForm(csrf))
      }
      setBrowserSessionCookie(c, RECOVERY_COOKIE, cookie.raw)
      return html(c, 200, 'Save replacement key', recoveryCredentialPage(staged.handle, replacement, csrf))
    }
    const merchantKey = oneFormValue(values, 'merchant_key', 80)
    if (!merchantKey || !MERCHANT_KEY.test(merchantKey)) return browserError(c, 403, 'credential_rejected', 'That replacement merchant key could not be verified. Check it and try again on this page.', merchantKeyRetryForm('/recovery', 'confirm', csrf, 'Re-enter the replacement merchant key', 'Try this key'))
    if (!(await admitted(store, 'recovery_confirm', [`ip:${ip}`, `session:${sessionHash}`], 10))) return browserError(c, 429, 'rate_limited', 'Too many confirmation attempts. Try again in one hour on this page.', merchantKeyRetryForm('/recovery', 'confirm', csrf, 'Re-enter the replacement merchant key', 'Try this key'))
    const merchant = await store.confirmMerchantRecovery({
      sessionHash, csrfHash, replacementSecretHash: sha256(merchantKey),
    })
    if (merchant.status === 'request_unavailable') {
      const current = await store.getMerchantRecoveryProgress({ sessionHash, csrfHash })
      return recoveryProgressResponse(c, current, cookie, 'confirm')
    }
    if (merchant.status === 'credential_rejected') return browserError(c, 403, 'credential_rejected', 'That replacement merchant key could not be verified. Check it and try again on this page.', merchantKeyRetryForm('/recovery', 'confirm', csrf, 'Re-enter the replacement merchant key', 'Try this key'))
    clearBrowserSessionCookie(c, RECOVERY_COOKIE)
    return html(c, 200, 'Merchant key replaced', `<h1>${escapeHtml(merchant.handle)} is recovered</h1><p>The old key and connector sessions are revoked. The saved replacement key is active.</p>`)
  }))
}
