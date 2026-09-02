// Full hosted sign-in tests use only an in-memory OAuth store.
// No live service, database, wallet, merchant, or deployment is touched.
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { sha256, type Merchant } from '../../src/core.ts'
import {
  configureMarketOAuthMerchantResolver,
  merchantByOAuthAccessToken,
  mountMarketOAuthRoutes,
  type MarketOAuthRouteOptions,
} from '../../src/market-oauth.ts'
import {
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_REDIRECT_URI,
} from '../../src/market-oauth-config.ts'
import type {
  AuthorizationCodeRecord,
  AuthorizationRequestInput,
  AuthorizationRequestRecord,
} from '../../src/market-oauth-store.ts'

type OAuthStore = typeof import('../../src/market-oauth-store.ts').postgresMarketOAuthStore

const ORIGIN = 'https://1f3ea.com'
const RESOURCE = `${ORIGIN}/mcp/connect`
const CLIENT_ID = 'hosted-chat-flow-test'
const CALLBACK = 'https://chat.example.test/oauth/callback'
const STATE = 'opaque-state-that-must-survive'
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
const MERCHANT_KEY = `1f3ea_sk_${'ab'.repeat(24)}`

const environment = {
  PUBLIC_ORIGIN: ORIGIN,
  HOSTED_MARKET_SIGNIN_ENABLED: 'true',
  MARKET_IDENTITY_RECOVERY_ENABLED: 'true',
  MARKET_IDENTITY_ROTATION_ENABLED: 'true',
  HOSTED_MARKET_OAUTH_CLIENTS: JSON.stringify([{
    client_id: CLIENT_ID,
    client_name: 'Hosted Chat Flow Test',
    redirect_uris: [CALLBACK],
  }]),
  HOSTED_MARKET_CIMD_ORIGINS: '',
} as const

const merchant = (): Merchant => ({
  id: 7,
  handle: 'tinylantern',
  model: 'hosted-chat',
  karma: 2,
  joined_at: '2026-08-22T00:00:00.000Z',
  storefront_line: '',
  quota_day: '2026-08-22',
  comments_today: 0,
  votes_today: 0,
})

interface MemoryRequest extends AuthorizationRequestRecord {
  sessionHash: string
  csrfHash: string
  newSecretHash: string | null
  expiresAt: number
  used: boolean
}

interface MemoryMerchant {
  record: Merchant
  secretHash: string
  recoveryCodeHashes: string[]
}

interface MemoryCode extends AuthorizationCodeRecord {
  codeHash: string
  expiresAt: number
  used: boolean
}

interface MemoryFamily {
  id: number
  merchantId: number
  clientId: string
  resource: string
  scope: string
  expiresAt: number
  revoked: boolean
}

interface MemoryToken {
  tokenHash: string
  type: 'access' | 'refresh'
  familyId: number
  expiresAt: number
  used: boolean
  revoked: boolean
}

class MemoryOAuthStore {
  private readonly requests = new Map<string, MemoryRequest>()
  private readonly codes = new Map<string, MemoryCode>()
  private readonly families = new Map<number, MemoryFamily>()
  private readonly tokens = new Map<string, MemoryToken>()
  private readonly merchants = new Map<number, MemoryMerchant>([[7, {
    record: merchant(),
    secretHash: sha256(MERCHANT_KEY),
    recoveryCodeHashes: [],
  }]])
  private readonly stagedRecoveryCodeHashes = new Map<number, string[]>()
  private nextRequestId = 1
  private nextFamilyId = 1
  private nextMerchantId = 8

  readonly api = {
    createAuthorizationRequest: async (input: AuthorizationRequestInput): Promise<void> => {
      this.requests.set(input.sessionHash, {
        id: this.nextRequestId++,
        sessionHash: input.sessionHash,
        csrfHash: input.csrfHash,
        client_id: input.clientId,
        client_display_name: input.clientName,
        redirect_uri: input.redirectUri,
        resource: input.resource,
        scope: input.scope,
        state: input.state,
        code_challenge: input.codeChallenge,
        intent: null,
        merchant_id: null,
        new_handle: null,
        new_model: null,
        newSecretHash: null,
        merchant_key_confirmed_at: null,
        expiresAt: Date.now() + 15 * 60_000,
        used: false,
      })
    },
    getAuthorizationRequest: async (sessionHash: string): Promise<AuthorizationRequestRecord | null> => {
      const request = this.validRequest(sessionHash)
      return request ? { ...request } : null
    },
    getAuthorizationRequestProgress: async (
      input: Parameters<OAuthStore['getAuthorizationRequestProgress']>[0],
    ) => {
      const request = this.requests.get(input.sessionHash)
      if (!request || request.csrfHash !== input.csrfHash) return null
      if (request.merchant_id !== null && request.merchant_key_confirmed_at && request.used) {
        const linked = this.merchants.get(request.merchant_id)
        return linked
          ? {
              status: 'confirmed' as const,
              request: { ...request },
              merchantId: request.merchant_id,
              handle: linked.record.handle,
            }
          : { status: 'unavailable' as const, request: { ...request } }
      }
      if (request.merchant_id === null && request.used && request.expiresAt > Date.now()) {
        return { status: 'canceled' as const, request: { ...request } }
      }
      if (request.merchant_id === null && request.expiresAt <= Date.now()) {
        return { status: 'expired' as const, request: { ...request } }
      }
      return { status: 'unavailable' as const, request: { ...request } }
    },
    cancelAuthorizationRequest: async (input: { sessionHash: string; csrfHash: string }) => {
      const request = this.validRequest(input.sessionHash)
      if (!request || request.csrfHash !== input.csrfHash) return null
      request.used = true
      request.intent = null
      request.new_handle = null
      request.new_model = null
      request.newSecretHash = null
      this.stagedRecoveryCodeHashes.delete(request.id)
      return { redirectUri: request.redirect_uri, state: request.state }
    },
    approveExistingMerchantAndIssueAuthorizationCode: async (
      input: Parameters<OAuthStore['approveExistingMerchantAndIssueAuthorizationCode']>[0],
    ) => {
      const request = this.validRequest(input.sessionHash)
      if (
        !request || request.csrfHash !== input.csrfHash ||
        !this.isInitial(request)
      ) return { status: 'request_unavailable' as const }
      const linked = [...this.merchants.values()].find(
        candidate => candidate.secretHash === input.merchantSecretHash,
      )
      if (!linked) return { status: 'merchant_key_rejected' as const }
      request.used = true
      request.intent = 'existing'
      request.merchant_id = linked.record.id
      this.codes.set(input.authorizationCodeHash, {
        codeHash: input.authorizationCodeHash,
        merchantId: linked.record.id,
        clientId: request.client_id,
        redirectUri: request.redirect_uri,
        resource: request.resource,
        scope: request.scope,
        codeChallenge: request.code_challenge,
        expiresAt: Date.now() + 5 * 60_000,
        used: false,
      })
      return {
        status: 'approved' as const,
        redirectUri: request.redirect_uri,
        state: request.state,
      }
    },
    stageNewMerchantRegistration: async (
      input: Parameters<OAuthStore['stageNewMerchantRegistration']>[0],
    ) => {
      const request = this.validRequest(input.sessionHash)
      if (!request || request.csrfHash !== input.csrfHash || !this.isInitial(request)) {
        return { status: 'request_unavailable' as const }
      }
      if ([...this.merchants.values()].some(candidate => candidate.record.handle === input.handle)) {
        return { status: 'handle_taken' as const }
      }
      request.intent = 'new'
      request.new_handle = input.handle
      request.new_model = input.model
      request.newSecretHash = input.merchantSecretHash
      this.stagedRecoveryCodeHashes.set(request.id, [...input.recoveryCodeHashes])
      return { status: 'staged' as const, handle: input.handle }
    },
    confirmNewMerchantAndIssueAuthorizationCode: async (
      input: Parameters<OAuthStore['confirmNewMerchantAndIssueAuthorizationCode']>[0],
    ) => {
      const request = this.validRequest(input.sessionHash)
      if (!request || request.csrfHash !== input.csrfHash) {
        return { status: 'request_unavailable' as const }
      }
      if (!this.isStaged(request)) return { status: 'confirmation_not_ready' as const }
      if (request.newSecretHash !== input.merchantSecretHash) {
        return { status: 'confirmation_rejected' as const }
      }
      if ([...this.merchants.values()].some(candidate => candidate.record.handle === request.new_handle)) {
        request.used = true
        request.intent = null
        request.new_handle = null
        request.new_model = null
        request.newSecretHash = null
        this.stagedRecoveryCodeHashes.delete(request.id)
        return { status: 'handle_taken' as const }
      }
      const recoveryCodeHashes = this.stagedRecoveryCodeHashes.get(request.id) ?? []
      if (recoveryCodeHashes.length !== 8 || new Set(recoveryCodeHashes).size !== 8) {
        throw new Error('staged recovery set is incomplete')
      }
      const newMerchantId = this.nextMerchantId++
      const handle = request.new_handle!
      this.merchants.set(newMerchantId, {
        record: { ...merchant(), id: newMerchantId, handle, model: request.new_model! },
        secretHash: request.newSecretHash!,
        recoveryCodeHashes: [...recoveryCodeHashes],
      })
      request.used = true
      request.merchant_id = newMerchantId
      request.newSecretHash = null
      request.merchant_key_confirmed_at = new Date().toISOString()
      this.stagedRecoveryCodeHashes.delete(request.id)
      this.codes.set(input.authorizationCodeHash, {
        codeHash: input.authorizationCodeHash,
        merchantId: newMerchantId,
        clientId: request.client_id,
        redirectUri: request.redirect_uri,
        resource: request.resource,
        scope: request.scope,
        codeChallenge: request.code_challenge,
        expiresAt: Date.now() + 5 * 60_000,
        used: false,
      })
      return {
        status: 'approved' as const,
        redirectUri: request.redirect_uri,
        state: request.state,
      }
    },
    getAuthorizationCode: async (codeHash: string): Promise<AuthorizationCodeRecord | null> => {
      const code = this.codes.get(codeHash)
      return code && !code.used && code.expiresAt > Date.now() ? { ...code } : null
    },
    exchangeAuthorizationCode: async (
      input: Parameters<OAuthStore['exchangeAuthorizationCode']>[0],
    ): Promise<boolean> => {
      const code = this.codes.get(input.codeHash)
      if (
        !code || code.used || code.expiresAt <= Date.now() || code.clientId !== input.clientId ||
        code.redirectUri !== input.redirectUri || code.resource !== input.resource
      ) return false
      code.used = true
      const family: MemoryFamily = {
        id: this.nextFamilyId++, merchantId: code.merchantId, clientId: code.clientId,
        resource: code.resource, scope: code.scope, expiresAt: Date.now() + 30 * 24 * 60 * 60_000,
        revoked: false,
      }
      this.families.set(family.id, family)
      this.addToken(input.accessTokenHash, 'access', family.id, Date.now() + 10 * 60_000)
      this.addToken(input.refreshTokenHash, 'refresh', family.id, family.expiresAt)
      return true
    },
    rotateRefreshToken: async (input: Parameters<OAuthStore['rotateRefreshToken']>[0]) => {
      const token = this.tokens.get(input.presentedRefreshTokenHash)
      const family = token ? this.families.get(token.familyId) : undefined
      if (
        token?.type === 'refresh' && token.used && family &&
        family.clientId === input.clientId && family.resource === input.resource
      ) {
        this.revokeFamily(family.id)
        return 'reused' as const
      }
      if (
        !token || token.type !== 'refresh' || token.used || token.revoked || token.expiresAt <= Date.now() ||
        !family || family.revoked || family.expiresAt <= Date.now() || family.clientId !== input.clientId ||
        family.resource !== input.resource
      ) return 'invalid' as const
      token.used = true
      this.addToken(input.accessTokenHash, 'access', family.id, Date.now() + 10 * 60_000)
      this.addToken(input.newRefreshTokenHash, 'refresh', family.id, family.expiresAt)
      return 'rotated' as const
    },
    revokeTokenFamilyByToken: async (input: Parameters<OAuthStore['revokeTokenFamilyByToken']>[0]) => {
      const token = this.tokens.get(input.tokenHash)
      const family = token ? this.families.get(token.familyId) : undefined
      if (family?.clientId === input.clientId) this.revokeFamily(family.id)
    },
    resolveOAuthAccessToken: async (
      input: Parameters<OAuthStore['resolveOAuthAccessToken']>[0],
    ): Promise<Merchant | null> => {
      const token = this.tokens.get(input.accessTokenHash)
      const family = token ? this.families.get(token.familyId) : undefined
      if (
        !token || token.type !== 'access' || token.used || token.revoked || token.expiresAt <= Date.now() ||
        !family || family.revoked || family.expiresAt <= Date.now() || family.resource !== input.resource ||
        family.scope !== input.scope
      ) return null
      return this.merchants.get(family.merchantId)?.record ?? null
    },
    consumeOAuthRateLimit: async (): Promise<boolean> => true,
  } satisfies OAuthStore

  safeState(): string {
    return JSON.stringify({
      requests: [...this.requests.values()], codes: [...this.codes.values()],
      families: [...this.families.values()], tokens: [...this.tokens.values()],
      merchants: [...this.merchants.values()],
      stagedRecoveryCodeHashes: [...this.stagedRecoveryCodeHashes.values()],
    })
  }

  merchantCount(): number {
    return this.merchants.size
  }

  recoveryCodeCount(handle: string): number {
    return [...this.merchants.values()].find(candidate => candidate.record.handle === handle)
      ?.recoveryCodeHashes.length ?? 0
  }

  stagedRecoveryCodeCount(): number {
    return [...this.stagedRecoveryCodeHashes.values()].reduce(
      (total, hashes) => total + hashes.length,
      0,
    )
  }

  takeHandle(handle: string): void {
    const id = this.nextMerchantId++
    this.merchants.set(id, {
      record: { ...merchant(), id, handle },
      secretHash: sha256(`unrelated:${handle}`),
      recoveryCodeHashes: [],
    })
  }

  private isInitial(request: MemoryRequest): boolean {
    return request.intent === null && request.merchant_id === null &&
      request.new_handle === null && request.new_model === null &&
      request.merchant_key_confirmed_at === null
  }

  private isStaged(request: MemoryRequest): boolean {
    return request.intent === 'new' && request.merchant_id === null &&
      request.new_handle !== null && request.new_model !== null &&
      request.merchant_key_confirmed_at === null && request.newSecretHash !== null
  }

  private validRequest(sessionHash: string): MemoryRequest | null {
    const request = this.requests.get(sessionHash)
    return request && !request.used && request.expiresAt > Date.now() ? request : null
  }

  private addToken(tokenHash: string, type: MemoryToken['type'], familyId: number, expiresAt: number): void {
    this.tokens.set(tokenHash, { tokenHash, type, familyId, expiresAt, used: false, revoked: false })
  }

  private revokeFamily(familyId: number): void {
    const family = this.families.get(familyId)
    if (family) family.revoked = true
    for (const token of this.tokens.values()) if (token.familyId === familyId) token.revoked = true
  }
}

function fixture(options: {
  reservePairingCode?: MarketOAuthRouteOptions['reservePairingCode']
  takeReservedPairingCode?: MarketOAuthRouteOptions['takeReservedPairingCode']
  resolvePairingCode?: MarketOAuthRouteOptions['resolvePairingCode']
} = {}) {
  const store = new MemoryOAuthStore()
  const app = new Hono()
  mountMarketOAuthRoutes(app, {
    environment,
    store: store.api,
    fetcher: (async input => { throw new Error(`unexpected network call: ${String(input)}`) }) as typeof fetch,
    reservePairingCode: options.reservePairingCode,
    takeReservedPairingCode: options.takeReservedPairingCode,
    resolvePairingCode: options.resolvePairingCode,
  })
  return { app, store }
}

function authorizationUrl(patch: Record<string, string> = {}): string {
  const values = {
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: CALLBACK, resource: RESOURCE,
    scope: 'market:merchant', state: STATE, code_challenge: CHALLENGE,
    code_challenge_method: 'S256', ...patch,
  }
  return `/oauth/authorize?${new URLSearchParams(values)}`
}

function cookiePair(response: Response): string {
  return (response.headers.get('set-cookie') ?? '').split(';')[0]!
}

function hiddenCsrf(html: string): string {
  const match = html.match(/name="csrf" value="([^"]+)"/)
  assert.ok(match)
  return match[1]!
}

async function approve(app: Hono) {
  const start = await app.request(authorizationUrl())
  assert.equal(start.status, 200)
  const html = await start.text()
  const cookie = cookiePair(start)
  const csrf = hiddenCsrf(html)
  const response = await app.request('/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
      cookie,
    },
    body: new URLSearchParams({ action: 'link', csrf, merchant_key: MERCHANT_KEY }),
  })
  assert.equal(response.status, 302)
  const location = new URL(response.headers.get('location')!)
  return { html, cookie, csrf, location, code: location.searchParams.get('code')! }
}

async function exchange(app: Hono, code: string, verifier = VERIFIER) {
  const response = await app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: CLIENT_ID, redirect_uri: CALLBACK,
      resource: RESOURCE, code, code_verifier: verifier,
    }),
  })
  return { response, body: await response.json() as Record<string, unknown> }
}

async function prepareMerchant(app: Hono, handle = 'new-shop', model = 'openai-codex') {
  const start = await app.request(authorizationUrl())
  assert.equal(start.status, 200)
  const startBody = await start.text()
  const cookie = cookiePair(start)
  const csrf = hiddenCsrf(startBody)
  const response = await app.request('/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
      cookie,
    },
    body: new URLSearchParams({ action: 'register', csrf, handle, model }),
  })
  const body = await response.text()
  const merchantKey = body.match(/1f3ea_sk_[0-9a-f]{48}/u)?.[0] ?? ''
  const recoveryCodes = [...body.matchAll(/1f3ea_rc_[0-9a-f]{64}/gu)].map(match => match[0])
  return { response, body, cookie, csrf, merchantKey, recoveryCodes, handle }
}

async function confirmMerchant(
  app: Hono,
  prepared: Awaited<ReturnType<typeof prepareMerchant>>,
  merchantKey = prepared.merchantKey,
): Promise<Response> {
  return app.request('/oauth/authorize', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
      cookie: prepared.cookie,
    },
    body: new URLSearchParams({
      action: 'confirm', csrf: prepared.csrf, merchant_key: merchantKey,
    }),
  })
}

function brokenFormRequest(path: '/oauth/authorize' | '/oauth/token'): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error('private body-stream detail')) },
  })
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(path === '/oauth/authorize' ? { origin: ORIGIN } : {}),
    },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
}


export {
  CALLBACK,
  CHALLENGE,
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_REDIRECT_URI,
  CLIENT_ID,
  Hono,
  MERCHANT_KEY,
  MemoryOAuthStore,
  ORIGIN,
  RESOURCE,
  STATE,
  VERIFIER,
  approve,
  authorizationUrl,
  brokenFormRequest,
  configureMarketOAuthMerchantResolver,
  confirmMerchant,
  cookiePair,
  environment,
  exchange,
  fixture,
  hiddenCsrf,
  merchant,
  merchantByOAuthAccessToken,
  mountMarketOAuthRoutes,
  prepareMerchant,
  sha256,
}
