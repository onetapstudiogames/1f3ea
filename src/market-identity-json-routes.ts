// JSON doors for a persistent or ephemeral coding client to register, rotate, or recover a
// merchant without a human at a browser. Every ceremony, limit, and one-time reveal mirrors
// /join, /rotate, and /recovery — this module only swaps cookies for a caller-held session/csrf
// pair, because a headless client has no cookie jar to resume from. See AGENTS.md #5: this file
// is one of the mirror surfaces a contract-visible identity change must move together with.
import type { Context, Hono } from 'hono'

import {
  exactJsonFields,
  jsonOptionalStringField,
  jsonStringField,
  readBoundedJson,
} from './bounded-json.ts'
import { newBrowserSessionCookie } from './browser-session.ts'
import { HANDLE_RE, newSecret, sha256 } from './core.ts'
import {
  CEREMONY_TOKEN_RE,
  identityModelValue,
  MERCHANT_KEY_RE,
  RECOVERY_CODE_RE,
} from './market-identity-fields.ts'
import { admittedMarketIdentity, identityClientAddress } from './market-identity-rate.ts'
import {
  postgresMarketIdentityStore,
  type MarketIdentityStore,
  type MerchantRegistrationClientClass,
} from './market-identity-store.ts'
import type { MarketOAuthEnvironment } from './market-oauth-config.ts'
import { privateBrowserHeaders } from './private-browser.ts'
import { newRecoveryCodeSet } from './recovery-codes.ts'

export interface MarketIdentityJsonRouteOptions {
  environment?: MarketOAuthEnvironment
  store?: MarketIdentityStore
}

interface Runtime {
  environment: MarketOAuthEnvironment
  store: MarketIdentityStore
}

const MAX_JSON_BYTES = 4_096
const CODING_CLIENT_CLASSES = new Set(['coding_persistent', 'coding_ephemeral'])
const CEREMONY_SECONDS = 900

type JsonStatus = 400 | 403 | 409 | 429 | 503

function ok(c: Context, body: Record<string, unknown>): Response {
  privateBrowserHeaders(c)
  return c.json(body, 200)
}

function fail(c: Context, status: JsonStatus, reason: string, message: string): Response {
  privateBrowserHeaders(c)
  c.header('X-1F3EA-Reason', reason)
  return c.json({ error: message, reason }, status)
}

async function readBody(c: Context): Promise<Record<string, unknown> | Response> {
  const result = await readBoundedJson(c, MAX_JSON_BYTES)
  if (result.kind === 'json') return result.value
  if (result.kind === 'unreadable') {
    return fail(
      c, 503, 'storage_unavailable',
      'The request body could not be fully read. Retry the same request; no credential was created or changed.',
    )
  }
  return fail(
    c, 400, 'invalid_json',
    'Send a JSON object body no larger than 4096 bytes with Content-Type: application/json.',
  )
}

function requireAction<T extends string>(
  c: Context,
  body: Record<string, unknown>,
  allowed: readonly T[],
): T | Response {
  const action = jsonStringField(body, 'action', 20)
  if (action && (allowed as readonly string[]).includes(action)) return action as T
  return fail(c, 400, 'invalid_action', `action must be one of: ${allowed.join(', ')}.`)
}

function requireFields(
  c: Context,
  body: Record<string, unknown>,
  allowed: readonly string[],
): Response | null {
  if (exactJsonFields(body, allowed)) return null
  return fail(c, 400, 'unexpected_fields', `This action accepts exactly these fields: ${allowed.join(', ')}.`)
}

function requireClientClass(c: Context, body: Record<string, unknown>): MerchantRegistrationClientClass | Response {
  const clientClass = jsonStringField(body, 'client_class', 40)
  if (clientClass && CODING_CLIENT_CLASSES.has(clientClass)) {
    return clientClass as MerchantRegistrationClientClass
  }
  return fail(
    c, 400, 'invalid_client_class',
    'client_class must be "coding_persistent" or "coding_ephemeral". A human without a key-capable ' +
      'client should use the private browser page instead.',
  )
}

function requireMerchantKey(c: Context, body: Record<string, unknown>): string | Response {
  const key = jsonStringField(body, 'merchant_key', 80)
  if (key && MERCHANT_KEY_RE.test(key)) return key
  return fail(c, 403, 'credential_rejected', 'That merchant key could not be verified. Check it and retry.')
}

function requireRecoveryCode(c: Context, body: Record<string, unknown>): string | Response {
  const code = jsonStringField(body, 'recovery_code', 90)
  if (code && RECOVERY_CODE_RE.test(code)) return code
  return fail(
    c, 403, 'credential_rejected',
    'That recovery code could not be verified. Use an unused code from the last saved set and retry.',
  )
}

interface CeremonyRef { session: string; csrf: string; sessionHash: string; csrfHash: string }

function requireCeremony(c: Context, body: Record<string, unknown>): CeremonyRef | Response {
  const session = jsonStringField(body, 'session', 64)
  const csrf = jsonStringField(body, 'csrf', 64)
  if (!session || !csrf || !CEREMONY_TOKEN_RE.test(session) || !CEREMONY_TOKEN_RE.test(csrf)) {
    return fail(
      c, 403, 'invalid_ceremony',
      'session and csrf must be the exact 64-character hex values returned by the earlier stage, ' +
        'begin, or generate response.',
    )
  }
  return { session, csrf, sessionHash: sha256(session), csrfHash: sha256(csrf) }
}

function requireHandleAndModel(
  c: Context,
  body: Record<string, unknown>,
): { handle: string; model: string } | Response {
  const rawHandle = jsonStringField(body, 'handle', 64)
  const handle = rawHandle ? rawHandle.toLowerCase().trim() : null
  const rawModel = jsonOptionalStringField(body, 'model', 4_096)
  const model = rawModel == null ? null : identityModelValue(rawModel)
  if (!handle || !HANDLE_RE.test(handle) || model === null) {
    return fail(
      c, 400, 'invalid_identity',
      'handle must match ^[a-z0-9][a-z0-9-]{2,31}$ and model (present, "" allowed) must be at most ' +
        '120 ordinary characters with no directional or control marks.',
    )
  }
  return { handle, model }
}

// ---------------------------------------------------------------------------------------------
// /api/register
// ---------------------------------------------------------------------------------------------

const REGISTER_STAGE_FIELDS = ['action', 'handle', 'model', 'client_class', 'human_approved'] as const
const REGISTER_CONFIRM_FIELDS = ['action', 'session', 'csrf', 'merchant_key'] as const
const REGISTER_CANCEL_FIELDS = ['action', 'session', 'csrf'] as const

async function registerStage(c: Context, runtime: Runtime, body: Record<string, unknown>): Promise<Response> {
  const fieldsError = requireFields(c, body, REGISTER_STAGE_FIELDS)
  if (fieldsError) return fieldsError
  const clientClass = requireClientClass(c, body)
  if (clientClass instanceof Response) return clientClass
  if (body.human_approved !== true) {
    return fail(
      c, 403, 'human_approval_required',
      'human_approved must be true: a human must approve this permanent public handle before it is created.',
    )
  }
  const identity = requireHandleAndModel(c, body)
  if (identity instanceof Response) return identity
  const ip = identityClientAddress(c, runtime.environment)
  if (
    !(await admittedMarketIdentity(runtime.store, 'join_stage', [`ip:${ip}`], 3)) ||
    !(await admittedMarketIdentity(runtime.store, 'join_stage', ['global'], 300))
  ) {
    return fail(
      c, 429, 'rate_limited',
      'Registration staging is limited to 3 attempts per IP and 300 total per UTC hour. Retry after the next UTC hour begins.',
    )
  }
  const merchantKey = newSecret()
  const recoveryCodes = newRecoveryCodeSet()
  const ceremony = newBrowserSessionCookie()
  const staged = await runtime.store.stageMerchantRegistration({
    sessionHash: sha256(ceremony.session),
    csrfHash: sha256(ceremony.csrf),
    ipHash: sha256(`reg:${ip}`),
    handle: identity.handle,
    model: identity.model,
    clientClass,
    merchantSecretHash: sha256(merchantKey),
    recoveryCodeHashes: recoveryCodes.map(sha256),
  })
  if (staged.status === 'handle_taken') {
    return fail(
      c, 409, 'handle_taken',
      `The handle "${identity.handle}" is already taken. Check GET /api/store/${identity.handle} before ` +
        'choosing another handle; this attempt created nothing.',
    )
  }
  if (staged.status !== 'staged') {
    return fail(
      c, 503, 'storage_unavailable',
      'The market could not stage this registration. Retry the same request; no merchant or key was created.',
    )
  }
  return ok(c, {
    status: 'staged',
    handle: staged.handle,
    client_class: clientClass,
    session: ceremony.session,
    csrf: ceremony.csrf,
    expires_in_seconds: CEREMONY_SECONDS,
    merchant_key: merchantKey,
    recovery_codes: recoveryCodes,
    instructions:
      'The merchant key and all eight recovery codes are shown exactly once here and are not retrievable ' +
      'again from this API. Save the merchant key where this client can read it on every launch (a password ' +
      'manager, OS credential vault, or managed secret store), and save all eight recovery codes in a ' +
      `separate durable place. Within ${CEREMONY_SECONDS / 60} minutes, POST {"action":"confirm","session",` +
      '"csrf","merchant_key"} with the exact saved key to create the merchant, or POST ' +
      '{"action":"cancel","session","csrf"} to abandon it. No merchant exists until confirm succeeds.',
  })
}

async function registerConfirm(c: Context, runtime: Runtime, body: Record<string, unknown>): Promise<Response> {
  const fieldsError = requireFields(c, body, REGISTER_CONFIRM_FIELDS)
  if (fieldsError) return fieldsError
  const ceremony = requireCeremony(c, body)
  if (ceremony instanceof Response) return ceremony
  const merchantKey = requireMerchantKey(c, body)
  if (merchantKey instanceof Response) return merchantKey
  const ip = identityClientAddress(c, runtime.environment)
  if (!(await admittedMarketIdentity(
    runtime.store, 'join_confirm', [`ip:${ip}`, `session:${ceremony.sessionHash}`], 10,
  ))) {
    return fail(
      c, 429, 'rate_limited',
      'Confirmation is limited to 10 attempts per IP and per staged registration per UTC hour. Check ' +
        'GET /api/merchants for this handle before retrying after the next UTC hour begins.',
    )
  }
  const merchant = await runtime.store.confirmMerchantRegistration({
    sessionHash: ceremony.sessionHash, csrfHash: ceremony.csrfHash, merchantSecretHash: sha256(merchantKey),
  })
  if (merchant.status === 'credential_rejected') {
    return fail(c, 403, 'credential_rejected', 'That saved merchant key could not be verified. Check it and retry confirm.')
  }
  if (merchant.status === 'request_unavailable') {
    return fail(
      c, 403, 'request_unavailable',
      'This registration expired, was canceled, or already advanced. Stage a fresh registration; check ' +
        'GET /api/merchants first in case an earlier confirm response was lost.',
    )
  }
  if (merchant.status === 'handle_taken') {
    await runtime.store.cancelMerchantRegistration({ sessionHash: ceremony.sessionHash, csrfHash: ceremony.csrfHash })
    return fail(
      c, 409, 'handle_taken',
      'That handle was taken by another registration before this one confirmed. This losing key and its ' +
        'recovery codes are inactive. Check GET /api/merchants before choosing another handle.',
    )
  }
  return ok(c, { status: 'confirmed', merchant_id: merchant.merchantId, handle: merchant.handle })
}

async function registerCancel(c: Context, runtime: Runtime, body: Record<string, unknown>): Promise<Response> {
  const fieldsError = requireFields(c, body, REGISTER_CANCEL_FIELDS)
  if (fieldsError) return fieldsError
  const ceremony = requireCeremony(c, body)
  if (ceremony instanceof Response) return ceremony
  const canceled = await runtime.store.cancelMerchantRegistration({
    sessionHash: ceremony.sessionHash, csrfHash: ceremony.csrfHash,
  })
  if (canceled) return ok(c, { status: 'canceled' })
  const progress = await runtime.store.getMerchantRegistrationProgress({
    sessionHash: ceremony.sessionHash, csrfHash: ceremony.csrfHash,
  })
  if (progress.status === 'confirmed') {
    return fail(
      c, 403, 'request_unavailable',
      `This registration already confirmed as merchant #${progress.merchantId} (${progress.handle}); it cannot be canceled.`,
    )
  }
  if (progress.status === 'canceled') return ok(c, { status: 'canceled' })
  if (progress.status === 'expired') return fail(c, 403, 'request_unavailable', 'This registration already expired; nothing to cancel.')
  if (progress.status === 'new') return fail(c, 403, 'request_unavailable', 'No staged registration is waiting for this session and csrf.')
  return fail(
    c, 503, 'storage_unavailable',
    'The market could not verify whether this registration was canceled. Retry the same cancel request.',
  )
}

async function registerHandler(c: Context, runtime: Runtime): Promise<Response> {
  const body = await readBody(c)
  if (body instanceof Response) return body
  const action = requireAction(c, body, ['stage', 'confirm', 'cancel'] as const)
  if (action instanceof Response) return action
  if (action === 'stage') return registerStage(c, runtime, body)
  if (action === 'confirm') return registerConfirm(c, runtime, body)
  return registerCancel(c, runtime, body)
}

// ---------------------------------------------------------------------------------------------
// /api/rotate
// ---------------------------------------------------------------------------------------------

const ROTATE_BEGIN_FIELDS = ['action', 'client_class', 'merchant_key'] as const
const ROTATE_CONFIRM_FIELDS = ['action', 'session', 'csrf', 'merchant_key'] as const
const ROTATE_CANCEL_FIELDS = ['action', 'session', 'csrf'] as const

async function rotateBegin(c: Context, runtime: Runtime, body: Record<string, unknown>): Promise<Response> {
  const fieldsError = requireFields(c, body, ROTATE_BEGIN_FIELDS)
  if (fieldsError) return fieldsError
  const clientClass = requireClientClass(c, body)
  if (clientClass instanceof Response) return clientClass
  const merchantKey = requireMerchantKey(c, body)
  if (merchantKey instanceof Response) return merchantKey
  const ip = identityClientAddress(c, runtime.environment)
  if (!(await admittedMarketIdentity(runtime.store, 'rotation_begin', [`ip:${ip}`], 5))) {
    return fail(c, 429, 'rate_limited', 'Rotation begins are limited to 5 attempts per IP per UTC hour. Retry after the next UTC hour begins.')
  }
  const ceremony = newBrowserSessionCookie()
  const replacement = newSecret()
  const staged = await runtime.store.stageMerchantRotation({
    sessionHash: sha256(ceremony.session), csrfHash: sha256(ceremony.csrf),
    merchantSecretHash: sha256(merchantKey), replacementSecretHash: sha256(replacement),
  })
  if (staged.status === 'credential_rejected') {
    return fail(c, 403, 'credential_rejected', 'That current merchant key could not be verified. Check it and retry.')
  }
  if (staged.status !== 'staged') {
    return fail(c, 503, 'storage_unavailable', 'The market could not stage this rotation. Retry the same request; no key was changed.')
  }
  return ok(c, {
    status: 'staged',
    handle: staged.handle,
    client_class: clientClass,
    session: ceremony.session,
    csrf: ceremony.csrf,
    expires_in_seconds: CEREMONY_SECONDS,
    merchant_key: replacement,
    instructions:
      'This replacement merchant key is shown exactly once and is not retrievable again. Nothing has changed ' +
      `yet: the current key stays active. Save the replacement, then within ${CEREMONY_SECONDS / 60} minutes ` +
      'POST {"action":"confirm","session","csrf","merchant_key"} with the exact saved replacement to activate ' +
      'it and revoke the old key, connector sessions, and recovery codes; or POST ' +
      '{"action":"cancel","session","csrf"} to keep the current key.',
  })
}

async function rotateConfirm(c: Context, runtime: Runtime, body: Record<string, unknown>): Promise<Response> {
  const fieldsError = requireFields(c, body, ROTATE_CONFIRM_FIELDS)
  if (fieldsError) return fieldsError
  const ceremony = requireCeremony(c, body)
  if (ceremony instanceof Response) return ceremony
  const merchantKey = requireMerchantKey(c, body)
  if (merchantKey instanceof Response) return merchantKey
  const ip = identityClientAddress(c, runtime.environment)
  if (!(await admittedMarketIdentity(
    runtime.store, 'rotation_confirm', [`ip:${ip}`, `session:${ceremony.sessionHash}`], 10,
  ))) {
    return fail(c, 429, 'rate_limited', 'Confirmation is limited to 10 attempts per IP and per rotation per UTC hour. Retry after the next UTC hour begins.')
  }
  const merchant = await runtime.store.confirmMerchantRotation({
    sessionHash: ceremony.sessionHash, csrfHash: ceremony.csrfHash, replacementSecretHash: sha256(merchantKey),
  })
  if (merchant.status === 'rate_limited') {
    return fail(c, 429, 'rate_limited', 'This merchant reached 5 successful rotations this UTC day. Wait until the next UTC day, then begin a new rotation.')
  }
  if (merchant.status === 'request_unavailable') {
    return fail(
      c, 403, 'request_unavailable',
      'This rotation expired, was canceled, or the merchant changed since it was staged. Begin a fresh rotation with the current key.',
    )
  }
  if (merchant.status === 'credential_rejected') {
    return fail(c, 403, 'credential_rejected', 'That saved replacement merchant key could not be verified. Check it and retry confirm.')
  }
  return ok(c, { status: 'rotated', merchant_id: merchant.merchantId, handle: merchant.handle })
}

async function rotateCancel(c: Context, runtime: Runtime, body: Record<string, unknown>): Promise<Response> {
  const fieldsError = requireFields(c, body, ROTATE_CANCEL_FIELDS)
  if (fieldsError) return fieldsError
  const ceremony = requireCeremony(c, body)
  if (ceremony instanceof Response) return ceremony
  const canceled = await runtime.store.cancelMerchantRotation({
    sessionHash: ceremony.sessionHash, csrfHash: ceremony.csrfHash,
  })
  if (canceled) return ok(c, { status: 'canceled' })
  const progress = await runtime.store.getMerchantRotationProgress({
    sessionHash: ceremony.sessionHash, csrfHash: ceremony.csrfHash,
  })
  if (progress.status === 'rotated') {
    return fail(c, 403, 'request_unavailable', `This rotation already activated for ${progress.handle}; it cannot be canceled.`)
  }
  if (progress.status === 'canceled') return ok(c, { status: 'canceled' })
  if (progress.status === 'invalidated') {
    return fail(c, 409, 'credential_state_changed', 'Another key or recovery change ended this rotation. The old and new keys may both be stale; verify with GET /api/me.')
  }
  if (progress.status === 'expired') return fail(c, 403, 'request_unavailable', 'This rotation already expired; nothing to cancel.')
  if (progress.status === 'new') return fail(c, 403, 'request_unavailable', 'No staged rotation is waiting for this session and csrf.')
  return fail(c, 503, 'storage_unavailable', 'The market could not verify whether this rotation was canceled. Retry the same cancel request.')
}

async function rotateHandler(c: Context, runtime: Runtime): Promise<Response> {
  const body = await readBody(c)
  if (body instanceof Response) return body
  const action = requireAction(c, body, ['begin', 'confirm', 'cancel'] as const)
  if (action instanceof Response) return action
  if (action === 'begin') return rotateBegin(c, runtime, body)
  if (action === 'confirm') return rotateConfirm(c, runtime, body)
  return rotateCancel(c, runtime, body)
}

// ---------------------------------------------------------------------------------------------
// /api/recovery
// ---------------------------------------------------------------------------------------------

const RECOVERY_GENERATE_FIELDS = ['action', 'client_class', 'merchant_key'] as const
const RECOVERY_BEGIN_FIELDS = ['action', 'client_class', 'recovery_code'] as const
const RECOVERY_CONFIRM_FIELDS = ['action', 'session', 'csrf', 'merchant_key'] as const
const RECOVERY_CANCEL_FIELDS = ['action', 'session', 'csrf'] as const

async function recoveryGenerate(c: Context, runtime: Runtime, body: Record<string, unknown>): Promise<Response> {
  const fieldsError = requireFields(c, body, RECOVERY_GENERATE_FIELDS)
  if (fieldsError) return fieldsError
  const clientClass = requireClientClass(c, body)
  if (clientClass instanceof Response) return clientClass
  const merchantKey = requireMerchantKey(c, body)
  if (merchantKey instanceof Response) return merchantKey
  const ip = identityClientAddress(c, runtime.environment)
  if (!(await admittedMarketIdentity(runtime.store, 'recovery_generate', [`ip:${ip}`], 5))) {
    return fail(c, 429, 'rate_limited', 'Recovery-set creation is limited to 5 attempts per IP per UTC hour. Retry after the next UTC hour begins.')
  }
  const codes = newRecoveryCodeSet()
  const generated = await runtime.store.generateMerchantRecoveryCodes({
    merchantSecretHash: sha256(merchantKey), codeHashes: codes.map(sha256),
  })
  if (!generated) {
    return fail(c, 403, 'credential_rejected', 'That merchant key could not be verified. Check it and retry.')
  }
  return ok(c, {
    status: 'generated',
    handle: generated.handle,
    merchant_id: generated.merchantId,
    generation: generated.generation,
    client_class: clientClass,
    recovery_codes: codes,
    instructions:
      'These eight recovery codes are shown exactly once and replace every earlier set immediately; the ' +
      'merchant key is unchanged. Save all eight in a durable place separate from the merchant key.',
  })
}

async function recoveryBegin(c: Context, runtime: Runtime, body: Record<string, unknown>): Promise<Response> {
  const fieldsError = requireFields(c, body, RECOVERY_BEGIN_FIELDS)
  if (fieldsError) return fieldsError
  const clientClass = requireClientClass(c, body)
  if (clientClass instanceof Response) return clientClass
  const recoveryCode = requireRecoveryCode(c, body)
  if (recoveryCode instanceof Response) return recoveryCode
  const ip = identityClientAddress(c, runtime.environment)
  if (!(await admittedMarketIdentity(runtime.store, 'recovery_begin', [`ip:${ip}`], 10))) {
    return fail(c, 429, 'rate_limited', 'Recovery begins are limited to 10 attempts per IP per UTC hour. Retry after the next UTC hour begins.')
  }
  const ceremony = newBrowserSessionCookie()
  const replacement = newSecret()
  const staged = await runtime.store.stageMerchantRecovery({
    sessionHash: sha256(ceremony.session), csrfHash: sha256(ceremony.csrf),
    recoveryCodeHash: sha256(recoveryCode), replacementSecretHash: sha256(replacement),
  })
  if (staged.status === 'credential_rejected') {
    return fail(
      c, 403, 'credential_rejected',
      'That recovery code could not be verified, was already used, or belongs to a superseded set.',
    )
  }
  return ok(c, {
    status: 'staged',
    handle: staged.handle,
    client_class: clientClass,
    session: ceremony.session,
    csrf: ceremony.csrf,
    expires_in_seconds: CEREMONY_SECONDS,
    merchant_key: replacement,
    instructions:
      'This replacement merchant key is shown exactly once. The recovery code is not yet consumed and the old ' +
      `key stays active. Save the replacement, then within ${CEREMONY_SECONDS / 60} minutes POST ` +
      '{"action":"confirm","session","csrf","merchant_key"} with the exact saved replacement to consume the ' +
      'code and activate it, or POST {"action":"cancel","session","csrf"} to keep the recovery code unused.',
  })
}

async function recoveryConfirm(c: Context, runtime: Runtime, body: Record<string, unknown>): Promise<Response> {
  const fieldsError = requireFields(c, body, RECOVERY_CONFIRM_FIELDS)
  if (fieldsError) return fieldsError
  const ceremony = requireCeremony(c, body)
  if (ceremony instanceof Response) return ceremony
  const merchantKey = requireMerchantKey(c, body)
  if (merchantKey instanceof Response) return merchantKey
  const ip = identityClientAddress(c, runtime.environment)
  if (!(await admittedMarketIdentity(
    runtime.store, 'recovery_confirm', [`ip:${ip}`, `session:${ceremony.sessionHash}`], 10,
  ))) {
    return fail(c, 429, 'rate_limited', 'Confirmation is limited to 10 attempts per IP and per recovery per UTC hour. Retry after the next UTC hour begins.')
  }
  const merchant = await runtime.store.confirmMerchantRecovery({
    sessionHash: ceremony.sessionHash, csrfHash: ceremony.csrfHash, replacementSecretHash: sha256(merchantKey),
  })
  if (merchant.status === 'request_unavailable') {
    return fail(
      c, 403, 'request_unavailable',
      'This recovery expired, was canceled, or the merchant changed since it was staged. Begin a fresh recovery with an unused code.',
    )
  }
  if (merchant.status === 'credential_rejected') {
    return fail(c, 403, 'credential_rejected', 'That saved replacement merchant key could not be verified. Check it and retry confirm.')
  }
  return ok(c, { status: 'recovered', merchant_id: merchant.merchantId, handle: merchant.handle })
}

async function recoveryCancel(c: Context, runtime: Runtime, body: Record<string, unknown>): Promise<Response> {
  const fieldsError = requireFields(c, body, RECOVERY_CANCEL_FIELDS)
  if (fieldsError) return fieldsError
  const ceremony = requireCeremony(c, body)
  if (ceremony instanceof Response) return ceremony
  const canceled = await runtime.store.cancelMerchantRecovery({
    sessionHash: ceremony.sessionHash, csrfHash: ceremony.csrfHash,
  })
  if (canceled) return ok(c, { status: 'canceled' })
  const progress = await runtime.store.getMerchantRecoveryProgress({
    sessionHash: ceremony.sessionHash, csrfHash: ceremony.csrfHash,
  })
  if (progress.status === 'recovered') {
    return fail(c, 403, 'request_unavailable', `This recovery already activated for ${progress.handle}; it cannot be canceled.`)
  }
  if (progress.status === 'canceled') return ok(c, { status: 'canceled' })
  if (progress.status === 'invalidated') {
    return fail(c, 409, 'credential_state_changed', 'Another key or recovery change ended this recovery. Verify the active key with GET /api/me.')
  }
  if (progress.status === 'expired') return fail(c, 403, 'request_unavailable', 'This recovery already expired; nothing to cancel.')
  if (progress.status === 'new') return fail(c, 403, 'request_unavailable', 'No staged recovery is waiting for this session and csrf.')
  return fail(c, 503, 'storage_unavailable', 'The market could not verify whether this recovery was canceled. Retry the same cancel request.')
}

async function recoveryHandler(c: Context, runtime: Runtime): Promise<Response> {
  const body = await readBody(c)
  if (body instanceof Response) return body
  const action = requireAction(c, body, ['generate', 'begin', 'confirm', 'cancel'] as const)
  if (action instanceof Response) return action
  if (action === 'generate') return recoveryGenerate(c, runtime, body)
  if (action === 'begin') return recoveryBegin(c, runtime, body)
  if (action === 'confirm') return recoveryConfirm(c, runtime, body)
  return recoveryCancel(c, runtime, body)
}

export function mountMarketIdentityJsonRoutes(app: Hono, options: MarketIdentityJsonRouteOptions = {}): void {
  const runtime: Runtime = {
    environment: options.environment ?? process.env,
    store: options.store ?? postgresMarketIdentityStore,
  }
  app.post('/api/register', c => registerHandler(c, runtime))
  app.post('/api/rotate', c => rotateHandler(c, runtime))
  app.post('/api/recovery', c => recoveryHandler(c, runtime))
}
