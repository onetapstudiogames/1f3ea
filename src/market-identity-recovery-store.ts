import { runReadCommittedTransaction, sql } from './db.ts'
import type {
  MerchantRecoveryConfirmationResult,
  MerchantRecoveryGenerationResult,
  MerchantRecoveryStageResult,
} from './market-identity-types.ts'
import {
  requireMarketIdentityHash as requireHash,
  requireMarketRecoveryCodeHashes,
} from './market-identity-validation.ts'
import { retryPostgresDeadlockOnce } from './postgres-error.ts'

export async function generateMerchantRecoveryCodes(input: {
  merchantSecretHash: string
  codeHashes: string[]
}): Promise<MerchantRecoveryGenerationResult | null> {
  requireHash(input.merchantSecretHash, 'merchant-secret hash')
  requireMarketRecoveryCodeHashes(input.codeHashes)
  const rows = (await sql`
    WITH proven AS MATERIALIZED (
      SELECT id, handle, recovery_generation FROM merchants
      WHERE secret_hash = ${input.merchantSecretHash} FOR UPDATE
    ), advanced AS (
      UPDATE merchants merchant
      SET recovery_generation = merchant.recovery_generation + 1
      FROM proven WHERE merchant.id = proven.id
      RETURNING merchant.id, merchant.handle, merchant.recovery_generation
    ), invalidated AS (
      UPDATE merchant_recovery_codes code
      SET invalidated_at = coalesce(code.invalidated_at, now()),
          recovery_session_hash = NULL, recovery_csrf_hash = NULL,
          replacement_secret_hash = NULL, recovery_expires_at = NULL, staged_at = NULL
      FROM advanced WHERE code.merchant_id = advanced.id
        AND code.used_at IS NULL AND code.invalidated_at IS NULL
    ), invalidated_rotations AS (
      UPDATE merchant_key_rotations rotation
      SET invalidated_at = now(), merchant_secret_hash = NULL, replacement_secret_hash = NULL
      FROM advanced WHERE rotation.merchant_id = advanced.id
        AND rotation.confirmed_at IS NULL AND rotation.canceled_at IS NULL
        AND rotation.invalidated_at IS NULL
    ), inserted AS (
      INSERT INTO merchant_recovery_codes (merchant_id, generation, code_hash)
      SELECT advanced.id, advanced.recovery_generation, hash
      FROM advanced CROSS JOIN unnest(${input.codeHashes}::text[]) AS hash
      RETURNING merchant_id
    )
    SELECT advanced.id AS merchant_id, advanced.handle,
      advanced.recovery_generation AS generation
    FROM advanced WHERE (SELECT count(*) FROM inserted) = 8
  `) as Array<{ merchant_id: number; handle: string; generation: number }>
  const merchant = rows[0]
  return merchant ? {
    merchantId: merchant.merchant_id,
    handle: merchant.handle,
    generation: Number(merchant.generation),
  } : null
}

export async function stageMerchantRecovery(input: {
  sessionHash: string
  csrfHash: string
  recoveryCodeHash: string
  replacementSecretHash: string
}): Promise<MerchantRecoveryStageResult> {
  for (const [name, value] of Object.entries(input)) requireHash(value, name)
  const rows = (await sql`
    WITH pruned_results AS MATERIALIZED (
      DELETE FROM merchant_recovery_ceremony_results WHERE expires_at <= now()
      RETURNING session_hash
    ), cleared_expired AS (
      UPDATE merchant_recovery_codes
      SET recovery_session_hash = NULL, recovery_csrf_hash = NULL,
          replacement_secret_hash = NULL, recovery_expires_at = NULL, staged_at = NULL
      WHERE used_at IS NULL AND invalidated_at IS NULL AND recovery_expires_at <= now()
        AND code_hash <> ${input.recoveryCodeHash}
    ), eligible AS MATERIALIZED (
      SELECT code.id, merchant.handle
      FROM merchant_recovery_codes code
      JOIN merchants merchant ON merchant.id = code.merchant_id
      WHERE code.code_hash = ${input.recoveryCodeHash}
        AND code.generation = merchant.recovery_generation
        AND code.used_at IS NULL AND code.invalidated_at IS NULL
        AND (code.recovery_session_hash IS NULL OR code.replacement_secret_hash IS NULL
          OR code.recovery_expires_at <= now())
        AND NOT (
          code.recovery_expires_at IS NOT NULL
          AND code.recovery_expires_at <= now()
          AND (code.recovery_session_hash = ${input.sessionHash}
            OR code.recovery_csrf_hash = ${input.csrfHash})
        )
        AND NOT EXISTS (
          SELECT 1 FROM merchant_recovery_ceremony_results result
          WHERE (result.session_hash = ${input.sessionHash} OR result.csrf_hash = ${input.csrfHash})
            AND result.expires_at > now()
        )
        AND (SELECT count(*) FROM pruned_results) >= 0
      FOR UPDATE OF code
    ), staged AS (
      UPDATE merchant_recovery_codes code
      SET recovery_session_hash = ${input.sessionHash}, recovery_csrf_hash = ${input.csrfHash},
          replacement_secret_hash = ${input.replacementSecretHash},
          recovery_expires_at = now() + interval '15 minutes', staged_at = now()
      FROM eligible WHERE code.id = eligible.id RETURNING eligible.handle
    )
    SELECT handle FROM staged
  `) as Array<{ handle: string }>
  return rows[0]
    ? { status: 'staged', handle: rows[0].handle }
    : { status: 'credential_rejected' }
}

async function confirmMerchantRecoveryOnce(input: {
  sessionHash: string
  csrfHash: string
  replacementSecretHash: string
}): Promise<MerchantRecoveryConfirmationResult> {
  const transaction = await runReadCommittedTransaction(transactionSql => [
    transactionSql`
      -- Every credential-changing path locks the merchant before its own child rows.
      SELECT merchant.id
      FROM merchant_recovery_codes code
      JOIN merchants merchant ON merchant.id = code.merchant_id
      WHERE code.recovery_session_hash = ${input.sessionHash}
        AND code.recovery_csrf_hash = ${input.csrfHash}
        AND code.recovery_expires_at > now()
        AND code.used_at IS NULL AND code.invalidated_at IS NULL
        AND code.replacement_secret_hash IS NOT NULL
      FOR UPDATE OF merchant
    `,
    transactionSql`
    WITH active_request AS MATERIALIZED (
      SELECT code.id AS code_id, code.merchant_id, code.generation,
        code.replacement_secret_hash, merchant.handle,
        merchant.recovery_generation AS current_generation
      FROM merchant_recovery_codes code
      JOIN merchants merchant ON merchant.id = code.merchant_id
      WHERE code.recovery_session_hash = ${input.sessionHash}
        AND code.recovery_csrf_hash = ${input.csrfHash}
        AND code.recovery_expires_at > now()
        AND code.used_at IS NULL AND code.invalidated_at IS NULL
        AND code.replacement_secret_hash IS NOT NULL
      FOR UPDATE OF code
    ), available_request AS MATERIALIZED (
      SELECT * FROM active_request WHERE generation = current_generation
    ), eligible AS MATERIALIZED (
      SELECT * FROM available_request
      WHERE replacement_secret_hash = ${input.replacementSecretHash}
    ), changed AS (
      UPDATE merchants merchant
      SET secret_hash = eligible.replacement_secret_hash,
          recovery_generation = merchant.recovery_generation + 1
      FROM eligible WHERE merchant.id = eligible.merchant_id
        AND merchant.recovery_generation = eligible.generation
      RETURNING merchant.id, merchant.handle
    ), used AS (
      UPDATE merchant_recovery_codes code
      SET used_at = now(), recovery_session_hash = NULL, recovery_csrf_hash = NULL,
          replacement_secret_hash = NULL, recovery_expires_at = NULL, staged_at = NULL
      FROM eligible JOIN changed ON changed.id = eligible.merchant_id
      WHERE code.id = eligible.code_id RETURNING code.id, code.merchant_id
    ), invalidated_siblings AS (
      UPDATE merchant_recovery_codes code
      SET invalidated_at = coalesce(code.invalidated_at, now()),
          recovery_session_hash = NULL, recovery_csrf_hash = NULL,
          replacement_secret_hash = NULL, recovery_expires_at = NULL, staged_at = NULL
      FROM used WHERE code.merchant_id = used.merchant_id AND code.id <> used.id
        AND code.used_at IS NULL AND code.invalidated_at IS NULL
    ), invalidated_rotations AS (
      UPDATE merchant_key_rotations rotation
      SET invalidated_at = now(), merchant_secret_hash = NULL, replacement_secret_hash = NULL
      FROM used WHERE rotation.merchant_id = used.merchant_id
        AND rotation.confirmed_at IS NULL AND rotation.canceled_at IS NULL
        AND rotation.invalidated_at IS NULL
    ), invalidated_pairing_codes AS (
      -- A pairing code only proves its minter held a valid key at mint time, never a specific
      -- hash; without this, a code minted under a stolen key would still redeem after the
      -- legitimate owner recovers away from that key. See market-pairing-store.ts.
      UPDATE merchant_pairing_codes code
      SET invalidated_at = coalesce(code.invalidated_at, now())
      FROM used WHERE code.merchant_id = used.merchant_id
        AND code.used_at IS NULL AND code.invalidated_at IS NULL
    ), revoked_families AS (
      UPDATE oauth_token_families family
      SET revoked_at = coalesce(family.revoked_at, now()),
          revoke_reason = coalesce(family.revoke_reason, 'merchant key recovery')
      FROM used WHERE family.merchant_id = used.merchant_id
      RETURNING family.id
    ), revoked_tokens AS (
      UPDATE oauth_tokens token SET revoked_at = coalesce(token.revoked_at, now())
      FROM oauth_token_families family, used
      WHERE token.family_id = family.id AND family.merchant_id = used.merchant_id
    ), invalidated_codes AS (
      UPDATE oauth_authorization_codes code SET used_at = coalesce(code.used_at, now())
      FROM used WHERE code.merchant_id = used.merchant_id
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'rotate', handle, '{}'::jsonb FROM changed RETURNING actor
    ), completed AS MATERIALIZED (
      SELECT changed.id AS merchant_id, changed.handle FROM changed
      JOIN used ON used.merchant_id = changed.id
      WHERE EXISTS (SELECT 1 FROM new_event)
    )
    SELECT 'recovered'::text AS status, completed.merchant_id, completed.handle FROM completed
    UNION ALL
    SELECT 'request_unavailable'::text, NULL::integer, NULL::text
    WHERE NOT EXISTS (SELECT 1 FROM active_request)
      OR NOT EXISTS (SELECT 1 FROM available_request)
    UNION ALL
    SELECT 'credential_rejected'::text, NULL::integer, NULL::text
    WHERE EXISTS (SELECT 1 FROM available_request) AND NOT EXISTS (SELECT 1 FROM eligible)
    `,
  ])
  const rows = transaction[1] as Array<{
    status: 'recovered' | 'credential_rejected' | 'request_unavailable'
    merchant_id: number | null
    handle: string | null
  }>
  const result = rows[0]
  if (!result) throw new Error('merchant recovery confirmation produced no outcome')
  if (result.status !== 'recovered') return { status: result.status }
  if (result.merchant_id === null || result.handle === null) {
    throw new Error('merchant recovery confirmation returned an incomplete merchant')
  }
  return { status: 'recovered', merchantId: result.merchant_id, handle: result.handle }
}

export async function confirmMerchantRecovery(input: {
  sessionHash: string
  csrfHash: string
  replacementSecretHash: string
}): Promise<MerchantRecoveryConfirmationResult> {
  for (const [name, value] of Object.entries(input)) requireHash(value, name)
  return retryPostgresDeadlockOnce(() => confirmMerchantRecoveryOnce(input))
}

export async function cancelMerchantRecovery(input: {
  sessionHash: string
  csrfHash: string
}): Promise<boolean> {
  requireHash(input.sessionHash, 'session hash')
  requireHash(input.csrfHash, 'csrf hash')
  const rows = (await sql`
    UPDATE merchant_recovery_codes
    SET recovery_session_hash = NULL, recovery_csrf_hash = NULL,
        replacement_secret_hash = NULL, recovery_expires_at = NULL, staged_at = NULL
    WHERE recovery_session_hash = ${input.sessionHash}
      AND recovery_csrf_hash = ${input.csrfHash} AND recovery_expires_at > now()
      AND used_at IS NULL AND invalidated_at IS NULL RETURNING id
  `) as Array<{ id: number }>
  return rows.length === 1
}
