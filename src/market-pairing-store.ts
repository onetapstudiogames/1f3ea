import { randomBytes } from 'node:crypto'
import { sql } from './db.ts'
import { requireMarketIdentityHash as requireHash } from './market-identity-validation.ts'

export const PAIRING_CODE_PREFIX = '1f3ea_pc_'
export const PAIRING_CODE_RE = /^1f3ea_pc_[0-9a-f]{48}$/u
export const PAIRING_CODE_SECONDS = 10 * 60

export function newPairingCode(): string {
  return PAIRING_CODE_PREFIX + randomBytes(24).toString('hex')
}

export interface CreatedPairingCode {
  expiresAt: string
}

/**
 * Mints one 10-minute single-use pairing code for an already-authenticated merchant (the
 * caller proved its key through the ordinary Authorization: Bearer door before reaching this
 * store call, so no secret is re-verified here).
 */
export async function createMerchantPairingCode(input: {
  merchantId: number
  codeHash: string
}): Promise<CreatedPairingCode> {
  requireHash(input.codeHash, 'pairing-code hash')
  const rows = (await sql`
    WITH cleanup AS (
      DELETE FROM merchant_pairing_codes WHERE expires_at <= now()
    ), inserted AS (
      INSERT INTO merchant_pairing_codes (merchant_id, code_hash, expires_at)
      VALUES (${input.merchantId}, ${input.codeHash}, now() + interval '10 minutes')
      RETURNING expires_at
    )
    SELECT expires_at FROM inserted
  `) as Array<{ expires_at: string }>
  const row = rows[0]
  if (!row) throw new Error('pairing-code creation produced no outcome')
  return { expiresAt: row.expires_at }
}

export interface ResolvedPairingCode {
  merchantId: number
  merchantSecretHash: string
}

/**
 * Atomically consumes one unused, unexpired, uninvalidated pairing code and returns the
 * merchant's CURRENT secret hash — never the pairing code itself, and the code is spent
 * whether or not the caller goes on to use the returned hash. Reading the current hash here
 * is not what makes rotation or recovery fail closed: confirmMerchantRotation (in
 * market-identity-store.ts) and confirmMerchantRecovery (in
 * market-identity-recovery-store.ts) each invalidate every one of a merchant's outstanding
 * pairing codes the moment the key changes, in the same transaction as the change itself. So
 * a code minted under a stolen key stops resolving as soon as the legitimate owner rotates or
 * recovers — it does not have to wait out its own ten-minute clock.
 */
export async function resolveAndConsumePairingCode(input: {
  codeHash: string
}): Promise<ResolvedPairingCode | null> {
  requireHash(input.codeHash, 'pairing-code hash')
  const consumed = (await sql`
    UPDATE merchant_pairing_codes
    SET used_at = now()
    WHERE code_hash = ${input.codeHash} AND used_at IS NULL AND expires_at > now()
      AND invalidated_at IS NULL
    RETURNING merchant_id
  `) as Array<{ merchant_id: number }>
  const merchantId = consumed[0]?.merchant_id
  if (merchantId === undefined) return null
  const merchant = (await sql`
    SELECT secret_hash FROM merchants WHERE id = ${merchantId}
  `) as Array<{ secret_hash: string }>
  return merchant[0] ? { merchantId, merchantSecretHash: merchant[0].secret_hash } : null
}

// ------------------------------------------------------------------------------------------
// Two-step browser redemption: reserve, then confirm. Splitting the single atomic consume
// above into these two steps lets the human SEE which merchant a pairing code names — "connect
// <client> to merchant @handle?" — before anything is granted, instead of a code typo or a
// stale clipboard entry silently linking the wrong store. See market-oauth-pairing.ts.
// ------------------------------------------------------------------------------------------

export interface PairingReservation {
  merchantId: number
  handle: string
  expiresAt: string
}

/**
 * Reserving never marks the underlying merchant_pairing_codes row used — it is a read of that
 * row (plus an upsert of this browser session's own reservation row) — so a reservation the
 * human never confirms simply expires alongside its code, exactly like an unused code, never
 * longer. One reservation per browser sign-in session (session_hash is UNIQUE): reserving a
 * second code for the same session replaces the first, and re-reserving the same code refreshes
 * which merchant it will show. The reservation's own expiry is pinned to the code's real
 * expires_at, never extended past it.
 */
export async function reservePairingCode(input: {
  sessionHash: string
  csrfHash: string
  codeHash: string
}): Promise<PairingReservation | null> {
  requireHash(input.sessionHash, 'session hash')
  requireHash(input.csrfHash, 'csrf hash')
  requireHash(input.codeHash, 'pairing-code hash')
  const rows = (await sql`
    WITH cleanup AS (
      DELETE FROM oauth_pairing_reservations WHERE expires_at <= now()
    ), peeked AS MATERIALIZED (
      SELECT code.merchant_id, code.expires_at, merchant.handle
      FROM merchant_pairing_codes code
      JOIN merchants merchant ON merchant.id = code.merchant_id
      WHERE code.code_hash = ${input.codeHash} AND code.used_at IS NULL AND code.expires_at > now()
        AND code.invalidated_at IS NULL
    ), upserted AS (
      INSERT INTO oauth_pairing_reservations (
        session_hash, csrf_hash, pairing_code_hash, merchant_id, expires_at
      )
      SELECT ${input.sessionHash}, ${input.csrfHash}, ${input.codeHash}, peeked.merchant_id, peeked.expires_at
      FROM peeked
      ON CONFLICT (session_hash) DO UPDATE SET
        csrf_hash = EXCLUDED.csrf_hash,
        pairing_code_hash = EXCLUDED.pairing_code_hash,
        merchant_id = EXCLUDED.merchant_id,
        expires_at = EXCLUDED.expires_at,
        created_at = now()
      RETURNING merchant_id, expires_at
    )
    SELECT upserted.merchant_id, upserted.expires_at, peeked.handle
    FROM upserted JOIN peeked ON true
  `) as Array<{ merchant_id: number; expires_at: string; handle: string }>
  const row = rows[0]
  return row ? { merchantId: row.merchant_id, handle: row.handle, expiresAt: row.expires_at } : null
}

/**
 * Atomically reads and deletes this session's reservation, handing back the reserved code's
 * hash for the caller to redeem through resolveAndConsumePairingCode above — the same atomic
 * consume the single-step flow always used, so the confirm step still reads the merchant's
 * CURRENT secret hash at the moment of redemption, not at reservation time. Returns null once
 * the reservation is gone (never made, already taken by an earlier confirm, or expired), so a
 * duplicate or replayed confirm click cannot redeem the same reservation twice.
 */
export async function takeReservedPairingCode(input: {
  sessionHash: string
  csrfHash: string
}): Promise<{ codeHash: string } | null> {
  requireHash(input.sessionHash, 'session hash')
  requireHash(input.csrfHash, 'csrf hash')
  const rows = (await sql`
    DELETE FROM oauth_pairing_reservations
    WHERE session_hash = ${input.sessionHash} AND csrf_hash = ${input.csrfHash} AND expires_at > now()
    RETURNING pairing_code_hash
  `) as Array<{ pairing_code_hash: string }>
  const row = rows[0]
  return row ? { codeHash: row.pairing_code_hash } : null
}
