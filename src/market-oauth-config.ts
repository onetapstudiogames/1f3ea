import { createHash, timingSafeEqual } from 'node:crypto'

export const MARKET_OAUTH_RESOURCE = 'https://1f3ea.com/mcp/connect'
export const MARKET_OAUTH_SCOPE = 'market:merchant'
export const MARKET_OAUTH_AUTHORIZATION_CODE_PREFIX = '1f3ea_ac_'
export const MARKET_OAUTH_ACCESS_TOKEN_PREFIX = '1f3ea_at_'
export const MARKET_OAUTH_REFRESH_TOKEN_PREFIX = '1f3ea_rt_'

export const CHATGPT_CIMD_ORIGIN = 'https://chatgpt.com'
export const CHATGPT_OAUTH_CLIENT_ID = 'https://chatgpt.com/oauth/client.json'
export const CHATGPT_OAUTH_REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect'

const DEFAULT_PUBLIC_ORIGIN = 'https://1f3ea.com'
const HTTPS_PROTOCOL = 'https:'
const MAX_CLIENT_ID_BYTES = 2_048
const MAX_CLIENT_NAME_BYTES = 240
const MAX_REDIRECT_URI_BYTES = 4_096
const MAX_STATE_BYTES = 4_096
const MAX_CIMD_BODY_BYTES = 65_536
const CIMD_TIMEOUT_MS = 4_000
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/
const MARKET_CREDENTIAL_PATTERN = /1f3ea_(?:sk|at|rt|ac|rc)_[0-9a-f]{8,}/i

export type MarketOAuthEnvironment = Readonly<Record<string, string | undefined>>

export interface MarketOAuthClient {
  clientId: string
  clientName: string
  redirectUris: string[]
  tokenEndpointAuthMethod: 'none'
}

export class MarketOAuthClientError extends Error {
  readonly status: 400 | 503

  constructor(status: 400 | 503, message: string) {
    super(message)
    this.name = 'MarketOAuthClientError'
    this.status = status
  }
}

export interface ValidMarketAuthorizationRequest {
  clientId: string
  clientName: string
  redirectUri: string
  resource: string
  scope: string
  state: string
  codeChallenge: string
}

interface CimdDocument {
  client_id?: unknown
  client_name?: unknown
  redirect_uris?: unknown
  token_endpoint_auth_method?: unknown
  token_endpoint_auth_methods_supported?: unknown
}

export function hostedMarketSigninEnabled(
  environment: MarketOAuthEnvironment = process.env,
): boolean {
  return environment.HOSTED_MARKET_SIGNIN_ENABLED === 'true'
}

export function marketTokenLooksSensitive(value: unknown): boolean {
  if (typeof value !== 'string') return false
  let candidate = value
  for (let pass = 0; pass < 3; pass += 1) {
    if (MARKET_CREDENTIAL_PATTERN.test(candidate)) return true
    try {
      const decoded = decodeURIComponent(candidate)
      if (decoded === candidate) return false
      candidate = decoded
    } catch {
      return false
    }
  }
  return MARKET_CREDENTIAL_PATTERN.test(candidate)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function safeText(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    marketTokenLooksSensitive(value)
  ) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function safeStringArray(
  value: unknown,
  label: string,
  maximumItems = 20,
  maximumItemBytes = MAX_REDIRECT_URI_BYTES,
): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems) {
    throw new Error(`${label} must be a non-empty array`)
  }
  return value.map(item => safeText(item, label, maximumItemBytes))
}

function exactHttpsRedirect(value: unknown): string {
  const candidate = safeText(value, 'redirect URI', MAX_REDIRECT_URI_BYTES)
  if (candidate.includes('*')) throw new Error('redirect URI must be exact')

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error('redirect URI must be a valid URL')
  }
  if (
    parsed.protocol !== HTTPS_PROTOCOL ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.origin === 'null'
  ) {
    throw new Error('redirect URI must be an exact HTTPS URL without credentials or a fragment')
  }
  return parsed.href
}

function exactHttpsOrigin(value: string, label: string): string {
  if (marketTokenLooksSensitive(value) || value.includes('*') || value !== value.trim()) {
    throw new Error(`${label} must be an exact HTTPS origin`)
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} must be an exact HTTPS origin`)
  }
  if (
    parsed.protocol !== HTTPS_PROTOCOL ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.origin === 'null' ||
    value !== parsed.origin
  ) {
    throw new Error(`${label} must be an exact HTTPS origin`)
  }
  return parsed.origin
}

export function marketPublicOrigin(
  environment: MarketOAuthEnvironment = process.env,
): string {
  return exactHttpsOrigin(environment.PUBLIC_ORIGIN ?? DEFAULT_PUBLIC_ORIGIN, 'PUBLIC_ORIGIN')
}

export function marketOAuthResource(
  environment: MarketOAuthEnvironment = process.env,
): string {
  return `${marketPublicOrigin(environment)}/mcp/connect`
}

export function parseMarketOAuthClients(raw: string | undefined): MarketOAuthClient[] {
  if (!raw) return []

  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    throw new Error('HOSTED_MARKET_OAUTH_CLIENTS must be valid JSON')
  }
  if (!Array.isArray(decoded) || decoded.length > 50) {
    throw new Error('HOSTED_MARKET_OAUTH_CLIENTS must be an array of at most 50 clients')
  }

  const clients = decoded.map((candidate, index): MarketOAuthClient => {
    const item = record(candidate, `OAuth client ${index + 1}`)
    const allowedFields = new Set(['client_id', 'client_name', 'redirect_uris'])
    if (Object.keys(item).some(key => !allowedFields.has(key))) {
      throw new Error(`OAuth client ${index + 1} contains an unsupported field`)
    }

    const clientId = safeText(item.client_id, 'client_id', MAX_CLIENT_ID_BYTES)
    const clientName = safeText(item.client_name, 'client_name', MAX_CLIENT_NAME_BYTES)
    const redirectUris = [...new Set(
      safeStringArray(item.redirect_uris, 'redirect_uris').map(exactHttpsRedirect),
    )]
    return { clientId, clientName, redirectUris, tokenEndpointAuthMethod: 'none' }
  })

  if (new Set(clients.map(client => client.clientId)).size !== clients.length) {
    throw new Error('OAuth client IDs must be unique')
  }
  return clients
}

export function parseMarketCimdOrigins(raw: string | undefined): string[] {
  if (!raw) return [CHATGPT_CIMD_ORIGIN]

  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    throw new Error('HOSTED_MARKET_CIMD_ORIGINS must be valid JSON')
  }
  const configured = safeStringArray(
    decoded,
    'HOSTED_MARKET_CIMD_ORIGINS',
    20,
    MAX_CLIENT_ID_BYTES,
  ).map(value => exactHttpsOrigin(value, 'CIMD origin'))
  return [...new Set([CHATGPT_CIMD_ORIGIN, ...configured])]
}

export function validateMarketAuthorizationRequest(
  request: Record<string, unknown>,
  clients: readonly MarketOAuthClient[],
  expectedResource = MARKET_OAUTH_RESOURCE,
): ValidMarketAuthorizationRequest {
  if (request.response_type !== 'code') {
    throw new Error('only the authorization code flow is supported')
  }
  const clientId = safeText(request.client_id, 'client_id', MAX_CLIENT_ID_BYTES)
  const client = clients.find(candidate => candidate.clientId === clientId)
  if (!client) throw new Error('unknown OAuth client')

  const redirectUri = safeText(request.redirect_uri, 'redirect_uri', MAX_REDIRECT_URI_BYTES)
  if (!client.redirectUris.includes(redirectUri)) {
    throw new Error('redirect_uri is not registered')
  }
  if (request.resource !== expectedResource) throw new Error('wrong protected resource')
  if (request.scope !== MARKET_OAUTH_SCOPE) throw new Error('wrong OAuth scope')
  if (request.code_challenge_method !== 'S256') throw new Error('PKCE S256 is required')

  const codeChallenge = safeText(request.code_challenge, 'code_challenge', 128)
  if (!PKCE_CHALLENGE_PATTERN.test(codeChallenge)) {
    throw new Error('invalid PKCE challenge')
  }
  const state = safeText(request.state, 'state', MAX_STATE_BYTES)

  return {
    clientId,
    clientName: client.clientName,
    redirectUri,
    resource: expectedResource,
    scope: MARKET_OAUTH_SCOPE,
    state,
    codeChallenge,
  }
}

function calculatePkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

export function verifyMarketPkceS256(verifier: string, expectedChallenge: string): boolean {
  if (
    !PKCE_VERIFIER_PATTERN.test(verifier) ||
    !PKCE_CHALLENGE_PATTERN.test(expectedChallenge)
  ) {
    return false
  }
  const actual = Buffer.from(calculatePkceChallenge(verifier), 'ascii')
  const expected = Buffer.from(expectedChallenge, 'ascii')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    byteLength += value.byteLength
    if (byteLength > MAX_CIMD_BODY_BYTES) {
      await reader.cancel()
      throw new Error('OAuth client metadata is too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, byteLength).toString('utf8')
}

function selectedPublicAuthMethod(
  clientId: string,
  metadataUrl: URL,
  document: CimdDocument,
): 'none' {
  const method = document.token_endpoint_auth_method
  const supported = document.token_endpoint_auth_methods_supported === undefined
    ? undefined
    : safeStringArray(
      document.token_endpoint_auth_methods_supported,
      'token_endpoint_auth_methods_supported',
      10,
      100,
    )

  if (method === 'none' && (supported === undefined || supported.includes('none'))) {
    return 'none'
  }
  const stableChatGptChoice =
    clientId === CHATGPT_OAUTH_CLIENT_ID &&
    metadataUrl.origin === CHATGPT_CIMD_ORIGIN &&
    method === 'private_key_jwt' &&
    supported?.includes('none') === true &&
    supported.includes('private_key_jwt')
  if (stableChatGptChoice) return 'none'

  throw new Error('OAuth client must support public PKCE exchange')
}

function validateCimdClientId(clientId: string, cimdOrigins: readonly string[]): URL {
  if (
    Buffer.byteLength(clientId, 'utf8') > MAX_CLIENT_ID_BYTES ||
    marketTokenLooksSensitive(clientId) ||
    /[\u0000-\u001f\u007f]/u.test(clientId)
  ) {
    throw new Error('unknown OAuth client')
  }

  let metadataUrl: URL
  try {
    metadataUrl = new URL(clientId)
  } catch {
    throw new Error('unknown OAuth client')
  }
  if (
    metadataUrl.protocol !== HTTPS_PROTOCOL ||
    metadataUrl.username ||
    metadataUrl.password ||
    metadataUrl.pathname === '/' ||
    metadataUrl.search ||
    metadataUrl.hash ||
    !cimdOrigins.includes(metadataUrl.origin)
  ) {
    throw new Error('unknown OAuth client')
  }
  if (metadataUrl.origin === CHATGPT_CIMD_ORIGIN && clientId !== CHATGPT_OAUTH_CLIENT_ID) {
    throw new Error('unknown OAuth client')
  }
  return metadataUrl
}

export async function resolveMarketOAuthClient(
  clientId: string,
  staticClients: readonly MarketOAuthClient[],
  cimdOrigins: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<MarketOAuthClient> {
  if (
    typeof clientId !== 'string' ||
    Buffer.byteLength(clientId, 'utf8') > MAX_CLIENT_ID_BYTES ||
    marketTokenLooksSensitive(clientId)
  ) {
    throw new MarketOAuthClientError(400, 'unknown OAuth client')
  }
  const configured = staticClients.find(client => client.clientId === clientId)
  if (configured) return configured

  let metadataUrl: URL
  try {
    metadataUrl = validateCimdClientId(clientId, cimdOrigins)
  } catch (error) {
    throw new MarketOAuthClientError(
      400,
      error instanceof Error ? error.message : 'unknown OAuth client',
    )
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CIMD_TIMEOUT_MS)

  try {
    let response: Response
    try {
      response = await fetcher(metadataUrl.href, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
    } catch {
      throw new MarketOAuthClientError(
        503,
        'OAuth client metadata is unavailable; try again in a moment',
      )
    }
    if (!response.ok || response.status >= 300) {
      throw new MarketOAuthClientError(
        503,
        'OAuth client metadata is unavailable because its fetch was rejected; try again in a moment',
      )
    }

    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (!contentType || !/^application\/(?:[a-z0-9.+-]+\+)?json$/i.test(contentType)) {
      throw new MarketOAuthClientError(
        503,
        'OAuth client metadata is unreadable because it was not JSON; try again in a moment',
      )
    }

    let body: string
    try {
      body = await boundedResponseText(response)
    } catch (error) {
      const detail = error instanceof Error && /too large/i.test(error.message)
        ? ' because it is too large'
        : ''
      throw new MarketOAuthClientError(
        503,
        `OAuth client metadata is unreadable${detail}; try again in a moment`,
      )
    }
    if (marketTokenLooksSensitive(body)) {
      throw new MarketOAuthClientError(400, 'OAuth client metadata contains a credential')
    }

    let decoded: CimdDocument
    try {
      decoded = record(JSON.parse(body), 'OAuth client metadata') as CimdDocument
    } catch {
      throw new MarketOAuthClientError(
        503,
        'OAuth client metadata is unreadable; try again in a moment',
      )
    }
    if (decoded.client_id !== clientId) {
      throw new MarketOAuthClientError(400, 'OAuth client metadata identity mismatch')
    }

    try {
      const tokenEndpointAuthMethod = selectedPublicAuthMethod(clientId, metadataUrl, decoded)
      const clientName = safeText(decoded.client_name, 'client_name', MAX_CLIENT_NAME_BYTES)
      const redirectUris = [...new Set(
        safeStringArray(decoded.redirect_uris, 'redirect_uris').map(exactHttpsRedirect),
      )]
      if (
        clientId === CHATGPT_OAUTH_CLIENT_ID &&
        (redirectUris.length !== 1 || redirectUris[0] !== CHATGPT_OAUTH_REDIRECT_URI)
      ) {
        throw new Error('ChatGPT OAuth client metadata has an unexpected redirect URI')
      }

      return { clientId, clientName, redirectUris, tokenEndpointAuthMethod }
    } catch (error) {
      throw new MarketOAuthClientError(
        400,
        error instanceof Error ? error.message : 'OAuth client metadata is invalid',
      )
    }
  } finally {
    clearTimeout(timeout)
  }
}
