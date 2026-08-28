import { sql } from './db.ts'
import type {
  MerchantRecoveryProgressResult,
  MerchantRotationProgressResult,
} from './market-identity-types.ts'
import { requireMarketIdentityHash } from './market-identity-validation.ts'

type ProgressInput = Readonly<{ sessionHash: string; csrfHash: string }>
type ProgressRow = Readonly<{
  status: string
  merchant_id: number | null
  handle: string | null
}>

function requireProgressInput(input: ProgressInput): void {
  requireMarketIdentityHash(input.sessionHash, 'session hash')
  requireMarketIdentityHash(input.csrfHash, 'csrf hash')
}

function merchantProgress<T extends MerchantRecoveryProgressResult | MerchantRotationProgressResult>(
  rows: readonly ProgressRow[],
  merchantStatuses: ReadonlySet<string>,
  terminalStatuses: ReadonlySet<string>,
): T {
  if (rows.length === 0) return { status: 'new' } as T
  const row = rows.length === 1 ? rows[0] : null
  if (!row || (!merchantStatuses.has(row.status) && !terminalStatuses.has(row.status))) {
    return { status: 'unavailable' } as T
  }
  if (merchantStatuses.has(row.status)) {
    if (row.merchant_id === null || row.handle === null) return { status: 'unavailable' } as T
    return { status: row.status, merchantId: row.merchant_id, handle: row.handle } as T
  }
  return { status: row.status } as T
}

export async function getMerchantRotationProgress(
  input: ProgressInput,
): Promise<MerchantRotationProgressResult> {
  requireProgressInput(input)
  const rows = (await sql`
    WITH scrubbed_expired AS MATERIALIZED (
      UPDATE merchant_key_rotations
      SET canceled_at = now(), merchant_secret_hash = NULL, replacement_secret_hash = NULL
      WHERE session_hash = ${input.sessionHash} AND csrf_hash = ${input.csrfHash}
        AND expires_at <= now() AND confirmed_at IS NULL AND canceled_at IS NULL
        AND invalidated_at IS NULL
      RETURNING id
    )
    SELECT CASE
      WHEN rotation.confirmed_at IS NOT NULL THEN 'rotated'
      WHEN rotation.invalidated_at IS NOT NULL THEN 'invalidated'
      WHEN rotation.canceled_at IS NOT NULL AND rotation.canceled_at < rotation.expires_at
        THEN 'canceled'
      WHEN rotation.expires_at <= now() THEN 'expired'
      WHEN rotation.recovery_generation <> merchant.recovery_generation
        OR rotation.merchant_secret_hash IS DISTINCT FROM merchant.secret_hash THEN 'invalidated'
      WHEN rotation.merchant_secret_hash IS NOT NULL
        AND rotation.replacement_secret_hash IS NOT NULL THEN 'staged'
      ELSE 'unavailable'
    END AS status, merchant.id AS merchant_id, merchant.handle
    FROM merchant_key_rotations rotation
    JOIN merchants merchant ON merchant.id = rotation.merchant_id
    WHERE rotation.session_hash = ${input.sessionHash} AND rotation.csrf_hash = ${input.csrfHash}
    LIMIT 2
  `) as ProgressRow[]
  return merchantProgress<MerchantRotationProgressResult>(
    rows,
    new Set(['staged', 'rotated']),
    new Set(['canceled', 'expired', 'invalidated']),
  )
}

export async function getMerchantRecoveryProgress(
  input: ProgressInput,
): Promise<MerchantRecoveryProgressResult> {
  requireProgressInput(input)
  await sql`
    WITH pruned_results AS MATERIALIZED (
      DELETE FROM merchant_recovery_ceremony_results WHERE expires_at <= now()
      RETURNING session_hash
    )
    UPDATE merchant_recovery_codes
    SET recovery_session_hash = NULL, recovery_csrf_hash = NULL,
        replacement_secret_hash = NULL, recovery_expires_at = NULL, staged_at = NULL
    WHERE recovery_session_hash = ${input.sessionHash}
      AND recovery_csrf_hash = ${input.csrfHash}
      AND recovery_expires_at <= now() AND used_at IS NULL AND invalidated_at IS NULL
      AND (SELECT count(*) FROM pruned_results) >= 0
  `
  const rows = (await sql`
    WITH current_progress AS MATERIALIZED (
    SELECT CASE
      WHEN code.used_at IS NOT NULL THEN 'recovered'
      WHEN code.invalidated_at IS NOT NULL OR code.generation <> merchant.recovery_generation
        THEN 'invalidated'
      WHEN code.replacement_secret_hash IS NULL AND code.recovery_expires_at IS NULL
        AND code.staged_at IS NULL THEN 'canceled'
      WHEN code.recovery_expires_at <= now() THEN 'expired'
      WHEN code.replacement_secret_hash IS NOT NULL AND code.recovery_expires_at > now()
        THEN 'staged'
      ELSE 'unavailable'
    END AS status, merchant.id AS merchant_id, merchant.handle
    FROM merchant_recovery_codes code
    JOIN merchants merchant ON merchant.id = code.merchant_id
    WHERE code.recovery_session_hash = ${input.sessionHash}
      AND code.recovery_csrf_hash = ${input.csrfHash}
    ), historical_progress AS MATERIALIZED (
      SELECT result.outcome AS status, merchant.id AS merchant_id, merchant.handle
      FROM merchant_recovery_ceremony_results result
      JOIN merchants merchant ON merchant.id = result.merchant_id
      WHERE result.session_hash = ${input.sessionHash} AND result.csrf_hash = ${input.csrfHash}
        AND result.expires_at > now()
        AND NOT EXISTS (SELECT 1 FROM current_progress)
    )
    SELECT status, merchant_id, handle FROM current_progress
    UNION ALL
    SELECT status, merchant_id, handle FROM historical_progress
  `) as ProgressRow[]
  return merchantProgress<MerchantRecoveryProgressResult>(
    rows,
    new Set(['staged', 'recovered']),
    new Set(['canceled', 'expired', 'invalidated']),
  )
}
