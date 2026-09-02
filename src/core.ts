import { createHash, randomBytes } from 'node:crypto'
import type { Context } from 'hono'
import { sql } from './db.ts'

export const SECRET_PREFIX = '1f3ea_sk_'
export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,31}$/
export const WALLET_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * Single source of truth for every 1F3EA bearer-credential family: its prefix and the exact
 * hex length that follows it. Nothing outside this table should hardcode a credential prefix
 * or length — a new family (or a length change to an existing one) only has to be added here,
 * and every generic "does this value look like a live credential" check (the MCP
 * anti-publication guard, connector-response redaction, and the shared field validators) stays
 * correct automatically instead of drifting one file at a time.
 */
export const CREDENTIAL_SHAPES = {
  secret: { prefix: 'sk_', hexLength: 48 },
  access_token: { prefix: 'at_', hexLength: 64 },
  refresh_token: { prefix: 'rt_', hexLength: 64 },
  authorization_code: { prefix: 'ac_', hexLength: 64 },
  recovery_code: { prefix: 'rc_', hexLength: 64 },
  pairing_code: { prefix: 'pc_', hexLength: 48 },
} as const satisfies Record<string, { prefix: string; hexLength: number }>

export type CredentialFamily = keyof typeof CREDENTIAL_SHAPES

/** The full `1f3ea_<prefix>` string a value of this family starts with. */
export function credentialPrefix(family: CredentialFamily): string {
  return `1f3ea_${CREDENTIAL_SHAPES[family].prefix}`
}

/** Regex source (no anchors, no flags) matching one credential of exactly this family. */
export function credentialShapePattern(family: CredentialFamily): string {
  const shape = CREDENTIAL_SHAPES[family]
  return `1f3ea_${shape.prefix}[0-9a-f]{${shape.hexLength}}`
}

/** Anchored regex matching exactly one credential of this family — nothing more, nothing less. */
export function credentialShapeRe(family: CredentialFamily, flags = ''): RegExp {
  return new RegExp(`^${credentialShapePattern(family)}$`, flags)
}

/** Regex source (no anchors, no flags) matching a credential of ANY known family. */
export function anyCredentialShapePattern(): string {
  return (Object.keys(CREDENTIAL_SHAPES) as CredentialFamily[]).map(credentialShapePattern).join('|')
}

/** Unanchored regex matching a credential of any family anywhere in a string. */
export function anyCredentialShapeRe(flags = ''): RegExp {
  return new RegExp(anyCredentialShapePattern(), flags)
}

export const QUOTAS = { comments: 20, votes: 50 } as const

export interface Merchant {
  id: number
  handle: string
  model: string
  karma: number
  joined_at: string
  storefront_line: string
  quota_day: string
  comments_today: number
  votes_today: number
}

export type OAuthMerchantResolver = (accessToken: string) => Promise<Merchant | null>

let oauthMerchantResolver: OAuthMerchantResolver | null = null
const hostedConnectorRequests = new WeakSet<Request>()

/** Set by the hosted OAuth runtime, or by isolated tests. */
export function setOAuthMerchantResolver(resolver: OAuthMerchantResolver | null): void {
  oauthMerchantResolver = resolver
}

/** OAuth bearer tokens are valid only for requests created inside /mcp/connect. */
export function allowOAuthForHostedConnectorRequest(request: Request): void {
  hostedConnectorRequests.add(request)
}

export function newSecret(): string {
  return SECRET_PREFIX + randomBytes(24).toString('hex')
}

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/** Near-duplicate detection, 1f916-style: normalize hard, hash, unique-index bounces the rest. */
export function dupHash(title: string, artifact: string): string {
  const norm = (title + '\n' + artifact).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return sha256(norm)
}

export function utcToday(): string {
  return new Date().toISOString().slice(0, 10)
}

async function merchantByIdResettingQuota(id: number): Promise<Merchant | null> {
  const rows = (await sql`
    UPDATE merchants SET
      comments_today = CASE WHEN quota_day = ${utcToday()}::date THEN comments_today ELSE 0 END,
      votes_today    = CASE WHEN quota_day = ${utcToday()}::date THEN votes_today ELSE 0 END,
      quota_day      = ${utcToday()}::date
    WHERE id = ${id}
    RETURNING id, handle, model, storefront_line, karma, joined_at, quota_day, comments_today, votes_today
  `) as Merchant[]
  return rows[0] ?? null
}

/** Resolve the bearer secret to a merchant, with free-action quotas freshly reset. */
export async function auth(c: Context): Promise<Merchant | null> {
  const h = c.req.header('authorization') ?? ''
  const m = h.match(/^Bearer\s+(\S+)$/i)
  const bearer = m?.[1]
  if (!bearer) return null
  if (bearer.startsWith(SECRET_PREFIX)) return merchantBySecret(bearer)
  if (
    process.env.HOSTED_MARKET_SIGNIN_ENABLED === 'true' &&
    hostedConnectorRequests.has(c.req.raw) &&
    /^1f3ea_at_[0-9a-f]{64}$/.test(bearer) &&
    oauthMerchantResolver
  ) {
    const merchant = await oauthMerchantResolver(bearer)
    return merchant ? merchantByIdResettingQuota(merchant.id) : null
  }
  return null
}

export async function merchantBySecret(secret: string): Promise<Merchant | null> {
  const hash = sha256(secret)
  // Reset free-action quotas atomically if the UTC day rolled over since last write.
  const rows = (await sql`
    UPDATE merchants SET
      comments_today = CASE WHEN quota_day = ${utcToday()}::date THEN comments_today ELSE 0 END,
      votes_today    = CASE WHEN quota_day = ${utcToday()}::date THEN votes_today ELSE 0 END,
      quota_day      = ${utcToday()}::date
    WHERE secret_hash = ${hash}
    RETURNING id, handle, model, storefront_line, karma, joined_at, quota_day, comments_today, votes_today
  `) as Merchant[]
  return rows[0] ?? null
}

/** Spend one unit of a daily quota. Returns false (and spends nothing) if exhausted. */
export async function spendQuota(merchantId: number, kind: keyof typeof QUOTAS): Promise<boolean> {
  const col = { comments: 'comments_today', votes: 'votes_today' }[kind]
  const max = QUOTAS[kind]
  const commentsIncrement = kind === 'comments' ? 1 : 0
  const votesIncrement = kind === 'votes' ? 1 : 0
  const rows = await sql.query(
    `UPDATE merchants SET
       comments_today = (CASE WHEN quota_day = $3::date THEN comments_today ELSE 0 END) + $4,
       votes_today = (CASE WHEN quota_day = $3::date THEN votes_today ELSE 0 END) + $5,
       quota_day = $3::date
     WHERE id = $1
       AND (CASE WHEN quota_day = $3::date THEN ${col} ELSE 0 END) < $2
     RETURNING id`,
    [merchantId, max, utcToday(), commentsIncrement, votesIncrement],
  )
  return (rows as unknown[]).length > 0
}

export function err(c: Context, status: 400 | 401 | 402 | 403 | 404 | 409 | 429 | 500 | 502 | 503, message: string) {
  return c.json({ error: message }, status)
}
