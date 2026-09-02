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
