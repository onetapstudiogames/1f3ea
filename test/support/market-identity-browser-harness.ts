import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { sha256 } from '../../src/core.ts'
import { mountMarketIdentityBrowserRoutes } from '../../src/market-identity-browser.ts'
import type { MarketIdentityStore } from '../../src/market-identity-store.ts'

export const ORIGIN = 'https://market.test'
export const MERCHANT_KEY = `1f3ea_sk_${'11'.repeat(24)}`
export const OTHER_MERCHANT_KEY = `1f3ea_sk_${'22'.repeat(24)}`
const CREDENTIAL = /1f3ea_(?:sk_[0-9a-f]{48}|rc_[0-9a-f]{64})/gu

export type AttemptKind =
  | 'join_stage' | 'join_confirm'
  | 'recovery_generate' | 'recovery_begin' | 'recovery_confirm'
  | 'rotation_begin' | 'rotation_confirm'

type Registration = {
  sessionHash: string; csrfHash: string; ipHash: string
  handle: string; model: string
  clientClass: 'hosted_browser' | 'coding_persistent' | 'coding_ephemeral' | 'oauth_refused'
  merchantSecretHash: string; recoveryCodeHashes: string[]
}

type MemoryStoreOptions = Readonly<{
  confirmationRaceCompleted?: boolean; deniedAttemptKind?: AttemptKind
  registrationConfirmHandleTaken?: boolean; rotationConfirmRateLimited?: boolean
  stageBarrier?: () => Promise<void>
}>

function validRecoveryHashes(hashes: readonly string[]): boolean {
  return hashes.length === 8 && new Set(hashes).size === 8 &&
    hashes.every(hash => /^[0-9a-f]{64}$/u.test(hash))
}

export function memoryStore(options: MemoryStoreOptions = {}) {
  let registration: Registration | null = null
  let confirmed = false
  let canceled = false
  let currentSecretHash = sha256(MERCHANT_KEY)
  let recoveryCodeHashes: string[] = []
  let stagedRecovery: {
    sessionHash: string
    csrfHash: string
    recoveryCodeHash: string
    replacementSecretHash: string
  } | null = null
  let recoveryTerminal: { sessionHash: string; csrfHash: string; status: 'recovered' | 'canceled' } | null = null
  let stagedRotation: {
    sessionHash: string
    csrfHash: string
    merchantSecretHash: string
    replacementSecretHash: string
  } | null = null
  let rotationTerminal: { sessionHash: string; csrfHash: string; status: 'rotated' | 'canceled' } | null = null
  const calls: Array<{ method: string; input: unknown }> = []

  const store = {
    async consumeMarketIdentityRateLimit(input: {
      bucketHash: string
      attemptKind: AttemptKind
      maximum: number
    }) {
      calls.push({ method: 'rate', input })
      return input.attemptKind !== options.deniedAttemptKind
    },
    async getMerchantRegistrationProgress(input: { sessionHash: string; csrfHash: string }) {
      calls.push({ method: 'progress', input })
      if (!registration || registration.sessionHash !== input.sessionHash ||
          registration.csrfHash !== input.csrfHash) return { status: 'new' as const }
      if (confirmed) {
        return { status: 'confirmed' as const, merchantId: 27, handle: registration.handle }
      }
      if (canceled) return { status: 'canceled' as const }
      return {
        status: 'staged' as const,
        handle: registration.handle,
        clientClass: registration.clientClass,
      }
    },
    async stageMerchantRegistration(input: Registration) {
      calls.push({ method: 'stageRegistration', input })
      await options.stageBarrier?.()
      if (registration) return { status: 'request_unavailable' as const }
      if (!validRecoveryHashes(input.recoveryCodeHashes)) {
        throw new Error('invalid recovery hashes')
      }
      registration = { ...input, recoveryCodeHashes: [...input.recoveryCodeHashes] }
      return { status: 'staged' as const, handle: input.handle }
    },
    async confirmMerchantRegistration(input: {
      sessionHash: string
      csrfHash: string
      merchantSecretHash: string
    }) {
      calls.push({ method: 'confirmRegistration', input })
      if (options.registrationConfirmHandleTaken) {
        if (options.confirmationRaceCompleted) confirmed = true
        return { status: 'handle_taken' as const }
      }
      if (!registration || registration.sessionHash !== input.sessionHash ||
          registration.csrfHash !== input.csrfHash) {
        return { status: 'request_unavailable' as const }
      }
      if (registration.merchantSecretHash !== input.merchantSecretHash) {
        return { status: 'credential_rejected' as const }
      }
      confirmed = true
      currentSecretHash = input.merchantSecretHash
      recoveryCodeHashes = [...registration.recoveryCodeHashes]
      return { status: 'confirmed' as const, merchantId: 27, handle: registration.handle }
    },
    async cancelMerchantRegistration(input: { sessionHash: string; csrfHash: string }) {
      calls.push({ method: 'cancelRegistration', input })
      if (!registration || confirmed || registration.sessionHash !== input.sessionHash ||
          registration.csrfHash !== input.csrfHash) return false
      canceled = true
      return true
    },
    async generateMerchantRecoveryCodes(input: {
      merchantSecretHash: string
      codeHashes: string[]
    }) {
      calls.push({ method: 'generateRecoveryCodes', input })
      if (input.merchantSecretHash !== currentSecretHash) return null
      if (!validRecoveryHashes(input.codeHashes)) throw new Error('invalid recovery hashes')
      recoveryCodeHashes = [...input.codeHashes]
      return { merchantId: 7, handle: 'existing-merchant', generation: 1 }
    },
    async getMerchantRecoveryProgress(input: { sessionHash: string; csrfHash: string }) {
      calls.push({ method: 'recoveryProgress', input })
      if (stagedRecovery?.sessionHash === input.sessionHash && stagedRecovery.csrfHash === input.csrfHash) {
        return { status: 'staged' as const, merchantId: 7, handle: 'existing-merchant' }
      }
      if (recoveryTerminal?.sessionHash === input.sessionHash && recoveryTerminal.csrfHash === input.csrfHash) {
        return recoveryTerminal.status === 'recovered'
          ? { status: 'recovered' as const, merchantId: 7, handle: 'existing-merchant' }
          : { status: 'canceled' as const }
      }
      return { status: 'new' as const }
    },
    async stageMerchantRecovery(input: {
      sessionHash: string
      csrfHash: string
      recoveryCodeHash: string
      replacementSecretHash: string
    }) {
      calls.push({ method: 'stageRecovery', input })
      if (!recoveryCodeHashes.includes(input.recoveryCodeHash)) {
        return { status: 'credential_rejected' as const }
      }
      stagedRecovery = { ...input }
      return { status: 'staged' as const, handle: 'existing-merchant' }
    },
    async confirmMerchantRecovery(input: {
      sessionHash: string
      csrfHash: string
      replacementSecretHash: string
    }) {
      calls.push({ method: 'confirmRecovery', input })
      if (!stagedRecovery || stagedRecovery.sessionHash !== input.sessionHash ||
          stagedRecovery.csrfHash !== input.csrfHash) {
        return { status: 'request_unavailable' as const }
      }
      if (stagedRecovery.replacementSecretHash !== input.replacementSecretHash) {
        return { status: 'credential_rejected' as const }
      }
      currentSecretHash = input.replacementSecretHash
      recoveryCodeHashes = []
      recoveryTerminal = { sessionHash: input.sessionHash, csrfHash: input.csrfHash, status: 'recovered' }
      stagedRecovery = null
      return { status: 'recovered' as const, merchantId: 7, handle: 'existing-merchant' }
    },
    async cancelMerchantRecovery(input: { sessionHash: string; csrfHash: string }) {
      calls.push({ method: 'cancelRecovery', input })
      if (!stagedRecovery || stagedRecovery.sessionHash !== input.sessionHash ||
          stagedRecovery.csrfHash !== input.csrfHash) return false
      recoveryTerminal = { sessionHash: input.sessionHash, csrfHash: input.csrfHash, status: 'canceled' }
      stagedRecovery = null
      return true
    },
    async stageMerchantRotation(input: {
      sessionHash: string
      csrfHash: string
      merchantSecretHash: string
      replacementSecretHash: string
    }) {
      calls.push({ method: 'stageRotation', input })
      if (input.merchantSecretHash !== currentSecretHash) {
        return { status: 'credential_rejected' as const }
      }
      if (input.merchantSecretHash === input.replacementSecretHash || stagedRotation) {
        return { status: 'request_unavailable' as const }
      }
      stagedRotation = { ...input }
      return { status: 'staged' as const, merchantId: 7, handle: 'existing-merchant' }
    },
    async getMerchantRotationProgress(input: { sessionHash: string; csrfHash: string }) {
      calls.push({ method: 'rotationProgress', input })
      if (stagedRotation?.sessionHash === input.sessionHash && stagedRotation.csrfHash === input.csrfHash) {
        return { status: 'staged' as const, merchantId: 7, handle: 'existing-merchant' }
      }
      if (rotationTerminal?.sessionHash === input.sessionHash && rotationTerminal.csrfHash === input.csrfHash) {
        return rotationTerminal.status === 'rotated'
          ? { status: 'rotated' as const, merchantId: 7, handle: 'existing-merchant' }
          : { status: 'canceled' as const }
      }
      return { status: 'new' as const }
    },
    async confirmMerchantRotation(input: {
      sessionHash: string
      csrfHash: string
      replacementSecretHash: string
    }) {
      calls.push({ method: 'confirmRotation', input })
      if (options.rotationConfirmRateLimited) return { status: 'rate_limited' as const }
      if (!stagedRotation || stagedRotation.sessionHash !== input.sessionHash ||
          stagedRotation.csrfHash !== input.csrfHash) {
        return { status: 'request_unavailable' as const }
      }
      if (stagedRotation.replacementSecretHash !== input.replacementSecretHash) {
        return { status: 'credential_rejected' as const }
      }
      currentSecretHash = input.replacementSecretHash
      recoveryCodeHashes = []
      rotationTerminal = { sessionHash: input.sessionHash, csrfHash: input.csrfHash, status: 'rotated' }
      stagedRotation = null
      return { status: 'rotated' as const, merchantId: 7, handle: 'existing-merchant' }
    },
    async cancelMerchantRotation(input: { sessionHash: string; csrfHash: string }) {
      calls.push({ method: 'cancelRotation', input })
      if (!stagedRotation || stagedRotation.sessionHash !== input.sessionHash ||
          stagedRotation.csrfHash !== input.csrfHash) return false
      rotationTerminal = { sessionHash: input.sessionHash, csrfHash: input.csrfHash, status: 'canceled' }
      stagedRotation = null
      return true
    },
  }

  return {
    store: store as unknown as MarketIdentityStore,
    calls,
    registration: () => registration,
    confirmed: () => confirmed,
    currentSecretHash: () => currentSecretHash,
    recoveryCodeHashes: () => [...recoveryCodeHashes],
    stagedRecovery: () => stagedRecovery,
    stagedRotation: () => stagedRotation,
  }
}

export function harness(options: Readonly<{
  environment?: Record<string, string | undefined>
  hostedMarketSigninReady?: boolean
  memory?: ReturnType<typeof memoryStore>
  store?: MarketIdentityStore
}> = {}) {
  const app = new Hono()
  app.use('*', cors({ origin: '*' }))
  const memory = options.memory ?? memoryStore()
  mountMarketIdentityBrowserRoutes(app, {
    environment: {
      PUBLIC_ORIGIN: ORIGIN,
      VERCEL: '1',
      ...options.environment,
    },
    store: options.store ?? memory.store,
    hostedMarketSigninReady: options.hostedMarketSigninReady,
  })
  return { app, memory }
}

type IdentityPath = '/join' | '/rotate' | '/recovery'

export async function pageState(app: Hono, path: IdentityPath) {
  const response = await app.request(path)
  const html = await response.text()
  const setCookie = response.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';', 1)[0]!
  const csrf = html.match(/name="csrf" value="([^"]+)"/u)?.[1]
  assert.equal(response.status, 200)
  assert.ok(cookie)
  assert.ok(csrf)
  return { response, html, setCookie, cookie, csrf }
}

export function postBody(
  app: Hono,
  path: IdentityPath,
  cookie: string,
  body: URLSearchParams | string,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      origin: ORIGIN,
      cookie,
      ...headers,
    },
    body,
  })
}

export function postForm(
  app: Hono,
  path: IdentityPath,
  cookie: string,
  values: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return postBody(app, path, cookie, new URLSearchParams(values), headers)
}

export function brokenPost(app: Hono, path: IdentityPath, cookie: string) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error('socket stopped')) },
  })
  return app.request(new Request(`${ORIGIN}${path}`, {
    method: 'POST', headers: {
      'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, cookie,
    }, body, duplex: 'half',
  } as RequestInit & { duplex: 'half' }))
}

export function assertPrivate(response: Response): void {
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('pragma'), 'no-cache')
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/u)
  assert.match(response.headers.get('content-security-policy') ?? '', /form-action 'self'/u)
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
  assert.equal(response.headers.get('access-control-allow-origin'), null)
}

export function credentials(body: string): string[] {
  return body.match(CREDENTIAL) ?? []
}
