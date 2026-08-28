import { runReadCommittedTransaction, sql } from './db.ts'
import { postgresErrorDetails, retryPostgresDeadlockOnce } from './postgres-error.ts'
import {
  MARKET_IDENTITY_ATTEMPT_KINDS,
  MERCHANT_REGISTRATION_CLIENT_CLASSES,
  type MarketIdentityAttemptKind,
  type MerchantRegistrationClientClass,
  type MerchantRegistrationConfirmationResult,
  type MerchantRegistrationProgressResult,
  type MerchantRegistrationStageInput,
  type MerchantRegistrationStageResult,
  type MerchantRotationConfirmationResult,
  type MerchantRotationStageResult,
} from './market-identity-types.ts'
import {
  requireMarketIdentityHash as requireHash,
  requireMarketRecoveryCodeHashes,
} from './market-identity-validation.ts'
import { getMerchantRecoveryProgress, getMerchantRotationProgress } from './market-identity-progress-store.ts'
import {
  cancelMerchantRecovery,
  confirmMerchantRecovery,
  generateMerchantRecoveryCodes,
  stageMerchantRecovery,
} from './market-identity-recovery-store.ts'
export * from './market-identity-types.ts'
export { getMerchantRecoveryProgress, getMerchantRotationProgress }
export {
  cancelMerchantRecovery,
  confirmMerchantRecovery,
  generateMerchantRecoveryCodes,
  stageMerchantRecovery,
}

const HANDLE = /^[a-z0-9][a-z0-9-]{2,31}$/u

function requireRegistrationInput(input: MerchantRegistrationStageInput): void {
  requireHash(input.sessionHash, 'session hash')
  requireHash(input.csrfHash, 'csrf hash')
  requireHash(input.ipHash, 'ip hash')
  requireHash(input.merchantSecretHash, 'merchant-secret hash')
  if (!HANDLE.test(input.handle)) throw new Error('merchant handle is invalid')
  if (Array.from(input.model).length > 120) {
    throw new Error('merchant model is longer than 120 characters')
  }
  if (!MERCHANT_REGISTRATION_CLIENT_CLASSES.includes(input.clientClass)) {
    throw new Error('registration client class is invalid')
  }
  requireMarketRecoveryCodeHashes(input.recoveryCodeHashes)
}

/** One atomic identity confirmation may safely be retried after PostgreSQL aborts a deadlock. */
export async function retryMarketIdentityDeadlockOnce<T>(operation: () => Promise<T>): Promise<T> {
  return retryPostgresDeadlockOnce(operation)
}

/** Atomically admits one hashed identity attempt in the current UTC-hour window. */
export async function consumeMarketIdentityRateLimit(input: {
  bucketHash: string
  attemptKind: MarketIdentityAttemptKind
  maximum: number
}): Promise<boolean> {
  requireHash(input.bucketHash, 'identity rate-limit bucket hash')
  if (!MARKET_IDENTITY_ATTEMPT_KINDS.includes(input.attemptKind)) {
    throw new Error('identity attempt kind is invalid')
  }
  if (!Number.isInteger(input.maximum) || input.maximum < 1 || input.maximum > 10_000) {
    throw new Error('identity attempt maximum must be an integer from 1 through 10000')
  }
  const rows = (await sql`
    WITH current_window AS MATERIALIZED (
      SELECT date_trunc('hour', now(), 'UTC') AS window_start
    ), cleanup AS (
      DELETE FROM merchant_identity_rate_limits
      WHERE window_start < (SELECT window_start FROM current_window) - interval '24 hours'
    ), admitted AS (
      INSERT INTO merchant_identity_rate_limits (bucket_hash, attempt_kind, window_start, used)
      SELECT ${input.bucketHash}, ${input.attemptKind}, window_start, 1 FROM current_window
      ON CONFLICT (bucket_hash, attempt_kind, window_start) DO UPDATE
      SET used = merchant_identity_rate_limits.used + 1
      WHERE merchant_identity_rate_limits.used < ${input.maximum}
      RETURNING used
    )
    SELECT used FROM admitted
  `) as Array<{ used: number }>
  return rows.length === 1
}

export async function stageMerchantRegistration(
  input: MerchantRegistrationStageInput,
): Promise<MerchantRegistrationStageResult> {
  requireRegistrationInput(input)
  const rows = (await sql`
    WITH cleared_expired AS MATERIALIZED (
      UPDATE pending_merchant_registrations
      SET canceled_at = now(), handle = NULL, model = NULL, client_class = NULL,
          secret_hash = NULL, ip_hash = NULL
      WHERE confirmed_at IS NULL AND canceled_at IS NULL AND expires_at <= now()
      RETURNING session_hash
    ), cleared_expired_codes AS (
      DELETE FROM pending_merchant_registration_recovery_codes code
      USING cleared_expired expired
      WHERE code.registration_session_hash = expired.session_hash
    ), staged AS MATERIALIZED (
      INSERT INTO pending_merchant_registrations (
        session_hash, csrf_hash, ip_hash, handle, model, client_class, secret_hash, expires_at
      )
      SELECT ${input.sessionHash}, ${input.csrfHash}, ${input.ipHash}, ${input.handle},
        ${input.model}, ${input.clientClass}, ${input.merchantSecretHash},
        now() + interval '15 minutes'
      WHERE NOT EXISTS (SELECT 1 FROM merchants WHERE handle = ${input.handle})
      ON CONFLICT DO NOTHING
      RETURNING session_hash, handle
    ), staged_codes AS (
      INSERT INTO pending_merchant_registration_recovery_codes (
        registration_session_hash, ordinal, code_hash
      )
      SELECT staged.session_hash, code.ordinality::smallint, code.code_hash
      FROM staged
      CROSS JOIN unnest(${input.recoveryCodeHashes}::text[])
        WITH ORDINALITY AS code(code_hash, ordinality)
      RETURNING registration_session_hash
    )
    SELECT
      EXISTS (SELECT 1 FROM merchants WHERE handle = ${input.handle}) AS handle_taken,
      (SELECT handle FROM staged WHERE (SELECT count(*) FROM staged_codes) = 8) AS handle
  `) as Array<{ handle_taken: boolean; handle: string | null }>
  const result = rows[0]
  if (result?.handle) return { status: 'staged', handle: result.handle }
  if (result?.handle_taken) return { status: 'handle_taken' }
  return { status: 'request_unavailable' }
}

export async function getMerchantRegistrationProgress(input: {
  sessionHash: string
  csrfHash: string
}): Promise<MerchantRegistrationProgressResult> {
  requireHash(input.sessionHash, 'session hash')
  requireHash(input.csrfHash, 'csrf hash')
  const rows = (await sql`
    SELECT CASE
      WHEN pending.merchant_id IS NOT NULL AND pending.confirmed_at IS NOT NULL
        AND pending.canceled_at IS NULL AND merchant.id IS NOT NULL THEN 'confirmed'
      WHEN pending.canceled_at IS NOT NULL AND pending.merchant_id IS NULL
        AND pending.canceled_at < pending.expires_at THEN 'canceled'
      WHEN pending.merchant_id IS NULL AND pending.confirmed_at IS NULL
        AND pending.expires_at <= now() THEN 'expired'
      WHEN pending.merchant_id IS NULL AND pending.confirmed_at IS NULL
        AND pending.canceled_at IS NULL AND pending.expires_at > now()
        AND pending.handle IS NOT NULL AND pending.model IS NOT NULL
        AND pending.client_class IS NOT NULL AND pending.secret_hash IS NOT NULL
        AND (SELECT count(*) FROM pending_merchant_registration_recovery_codes code
             WHERE code.registration_session_hash = pending.session_hash) = 8 THEN 'staged'
      ELSE 'unavailable'
    END AS status,
    pending.merchant_id, COALESCE(merchant.handle, pending.handle) AS handle,
    pending.client_class
    FROM pending_merchant_registrations pending
    LEFT JOIN merchants merchant ON merchant.id = pending.merchant_id
    WHERE pending.session_hash = ${input.sessionHash}
      AND pending.csrf_hash = ${input.csrfHash}
    LIMIT 1
  `) as Array<{
    status: 'confirmed' | 'canceled' | 'expired' | 'staged' | 'unavailable'
    merchant_id: number | null
    handle: string | null
    client_class: MerchantRegistrationClientClass | null
  }>
  const result = rows[0]
  if (!result) return { status: 'new' }
  if (result.status === 'confirmed') {
    if (result.merchant_id === null || result.handle === null) return { status: 'unavailable' }
    return { status: 'confirmed', merchantId: result.merchant_id, handle: result.handle }
  }
  if (result.status === 'staged') {
    if (result.handle === null) return { status: 'unavailable' }
    return {
      status: 'staged', handle: result.handle,
      clientClass: result.client_class ?? 'legacy_unknown',
    }
  }
  return { status: result.status }
}

async function confirmMerchantRegistrationOnce(input: {
  sessionHash: string
  csrfHash: string
  merchantSecretHash: string
}): Promise<MerchantRegistrationConfirmationResult> {
  try {
    const rows = (await sql`
      WITH active_request AS MATERIALIZED (
        SELECT session_hash, ip_hash, handle, model, secret_hash
        FROM pending_merchant_registrations
        WHERE session_hash = ${input.sessionHash} AND csrf_hash = ${input.csrfHash}
          AND confirmed_at IS NULL AND canceled_at IS NULL AND expires_at > now()
        FOR UPDATE
      ), completed_request AS MATERIALIZED (
        SELECT merchant.id AS merchant_id, merchant.handle, merchant.secret_hash
        FROM pending_merchant_registrations pending
        JOIN merchants merchant ON merchant.id = pending.merchant_id
        WHERE pending.session_hash = ${input.sessionHash}
          AND pending.csrf_hash = ${input.csrfHash}
          AND pending.confirmed_at IS NOT NULL AND pending.canceled_at IS NULL
      ), eligible AS MATERIALIZED (
        SELECT * FROM active_request WHERE secret_hash = ${input.merchantSecretHash}
      ), handle_conflict AS MATERIALIZED (
        SELECT merchant.handle FROM merchants merchant
        JOIN eligible ON eligible.handle = merchant.handle
      ), canceled_conflict AS MATERIALIZED (
        UPDATE pending_merchant_registrations pending
        SET canceled_at = now(), handle = NULL, model = NULL, client_class = NULL,
            secret_hash = NULL, ip_hash = NULL
        FROM eligible
        WHERE pending.session_hash = eligible.session_hash
          AND EXISTS (SELECT 1 FROM handle_conflict)
        RETURNING pending.session_hash
      ), scrubbed_conflict_codes AS (
        DELETE FROM pending_merchant_registration_recovery_codes code
        USING canceled_conflict canceled
        WHERE code.registration_session_hash = canceled.session_hash
        RETURNING code.registration_session_hash
      ), pending_codes AS MATERIALIZED (
        SELECT code.code_hash
        FROM pending_merchant_registration_recovery_codes code
        JOIN eligible ON eligible.session_hash = code.registration_session_hash
        WHERE NOT EXISTS (SELECT 1 FROM handle_conflict)
        ORDER BY code.ordinal FOR UPDATE OF code
      ), valid_code_set AS MATERIALIZED (
        SELECT count(*) AS code_count FROM pending_codes
        HAVING count(*) = 8 AND count(DISTINCT code_hash) = 8
      ), new_merchant AS (
        INSERT INTO merchants (handle, model, secret_hash, recovery_generation)
        SELECT eligible.handle, eligible.model, eligible.secret_hash, 1
        FROM eligible CROSS JOIN valid_code_set
        WHERE NOT EXISTS (SELECT 1 FROM handle_conflict)
        RETURNING id, handle, model
      ), inserted_recovery_codes AS (
        INSERT INTO merchant_recovery_codes (merchant_id, generation, code_hash)
        SELECT merchant.id, 1, code.code_hash
        FROM new_merchant merchant CROSS JOIN pending_codes code
        RETURNING merchant_id
      ), consumed AS (
        UPDATE pending_merchant_registrations pending
        SET merchant_id = merchant.id, confirmed_at = now(), handle = NULL, model = NULL,
            client_class = NULL, secret_hash = NULL, ip_hash = NULL
        FROM eligible CROSS JOIN new_merchant merchant
        WHERE pending.session_hash = eligible.session_hash
        RETURNING merchant.id, merchant.handle, merchant.model, eligible.ip_hash,
          eligible.session_hash
      ), scrubbed_pending_codes AS (
        DELETE FROM pending_merchant_registration_recovery_codes code
        USING consumed
        WHERE code.registration_session_hash = consumed.session_hash
        RETURNING code.registration_session_hash
      ), registration_log AS (
        INSERT INTO reg_log (ip_hash) SELECT ip_hash FROM consumed RETURNING ip_hash
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'register', handle, jsonb_build_object('id', id, 'model', model)
        FROM consumed RETURNING actor
      ), completed AS MATERIALIZED (
        SELECT consumed.id AS merchant_id, consumed.handle FROM consumed
        WHERE (SELECT count(*) FROM inserted_recovery_codes) = 8
          AND (SELECT count(*) FROM scrubbed_pending_codes) = 8
          AND EXISTS (SELECT 1 FROM registration_log)
          AND EXISTS (SELECT 1 FROM new_event)
      )
      SELECT 'confirmed'::text AS status, completed.merchant_id, completed.handle
      FROM completed
      UNION ALL
      SELECT 'confirmed'::text, completed_request.merchant_id, completed_request.handle
      FROM completed_request WHERE completed_request.secret_hash = ${input.merchantSecretHash}
      UNION ALL
      SELECT 'request_unavailable'::text, NULL::integer, NULL::text
      WHERE NOT EXISTS (SELECT 1 FROM active_request)
        AND NOT EXISTS (SELECT 1 FROM completed_request)
      UNION ALL
      SELECT 'credential_rejected'::text, NULL::integer, NULL::text
      WHERE EXISTS (SELECT 1 FROM active_request) AND NOT EXISTS (SELECT 1 FROM eligible)
      UNION ALL
      SELECT 'credential_rejected'::text, NULL::integer, NULL::text
      WHERE EXISTS (SELECT 1 FROM completed_request)
        AND NOT EXISTS (
          SELECT 1 FROM completed_request
          WHERE completed_request.secret_hash = ${input.merchantSecretHash}
        )
      UNION ALL
      SELECT 'handle_taken'::text, NULL::integer, NULL::text
      WHERE EXISTS (SELECT 1 FROM canceled_conflict)
        AND (SELECT count(*) FROM scrubbed_conflict_codes) = 8
    `) as Array<{
      status: 'confirmed' | 'credential_rejected' | 'handle_taken' | 'request_unavailable'
      merchant_id: number | null
      handle: string | null
    }>
    const result = rows[0]
    if (!result) throw new Error('merchant registration confirmation produced no outcome')
    if (result.status === 'request_unavailable') {
      const completed = (await sql`
        SELECT merchant.id, merchant.handle,
          merchant.secret_hash = ${input.merchantSecretHash} AS secret_matches
        FROM pending_merchant_registrations pending
        JOIN merchants merchant ON merchant.id = pending.merchant_id
        WHERE pending.session_hash = ${input.sessionHash}
          AND pending.csrf_hash = ${input.csrfHash}
          AND pending.confirmed_at IS NOT NULL AND pending.canceled_at IS NULL
        LIMIT 1
      `) as Array<{ id: number; handle: string; secret_matches: boolean }>
      const confirmed = completed[0]
      if (confirmed) return confirmed.secret_matches
        ? { status: 'confirmed', merchantId: confirmed.id, handle: confirmed.handle }
        : { status: 'credential_rejected' }
    }
    if (result.status !== 'confirmed') return { status: result.status }
    if (result.merchant_id === null || result.handle === null) {
      throw new Error('merchant registration confirmation returned an incomplete merchant')
    }
    return { status: 'confirmed', merchantId: result.merchant_id, handle: result.handle }
  } catch (error) {
    const details = postgresErrorDetails(error)
    if (details.code === '23505' && details.constraint === 'merchants_handle_key') {
      await cancelMerchantRegistration({
        sessionHash: input.sessionHash, csrfHash: input.csrfHash,
      })
      return { status: 'handle_taken' }
    }
    throw error
  }
}

export async function confirmMerchantRegistration(input: {
  sessionHash: string
  csrfHash: string
  merchantSecretHash: string
}): Promise<MerchantRegistrationConfirmationResult> {
  requireHash(input.sessionHash, 'session hash')
  requireHash(input.csrfHash, 'csrf hash')
  requireHash(input.merchantSecretHash, 'merchant-secret hash')
  return retryMarketIdentityDeadlockOnce(() => confirmMerchantRegistrationOnce(input))
}

export async function cancelMerchantRegistration(input: {
  sessionHash: string
  csrfHash: string
}): Promise<boolean> {
  requireHash(input.sessionHash, 'session hash')
  requireHash(input.csrfHash, 'csrf hash')
  const rows = (await sql`
    WITH canceled AS MATERIALIZED (
      UPDATE pending_merchant_registrations
      SET canceled_at = now(), handle = NULL, model = NULL, client_class = NULL,
          secret_hash = NULL, ip_hash = NULL
      WHERE session_hash = ${input.sessionHash} AND csrf_hash = ${input.csrfHash}
        AND merchant_id IS NULL AND confirmed_at IS NULL AND canceled_at IS NULL
        AND expires_at > now()
      RETURNING session_hash
    ), scrubbed_codes AS (
      DELETE FROM pending_merchant_registration_recovery_codes code
      USING canceled
      WHERE code.registration_session_hash = canceled.session_hash
    )
    SELECT session_hash FROM canceled
  `) as Array<{ session_hash: string }>
  return rows.length === 1
}

export async function stageMerchantRotation(input: {
  sessionHash: string
  csrfHash: string
  merchantSecretHash: string
  replacementSecretHash: string
}): Promise<MerchantRotationStageResult> {
  for (const [name, value] of Object.entries(input)) requireHash(value, name)
  const rows = (await sql`
    WITH cleared_expired AS (
      UPDATE merchant_key_rotations
      SET canceled_at = now(), merchant_secret_hash = NULL, replacement_secret_hash = NULL
      WHERE expires_at <= now() AND confirmed_at IS NULL AND canceled_at IS NULL
        AND invalidated_at IS NULL
    ), proven AS MATERIALIZED (
      SELECT id, handle, secret_hash, recovery_generation FROM merchants
      WHERE secret_hash = ${input.merchantSecretHash} FOR UPDATE
    ), staged AS (
      INSERT INTO merchant_key_rotations (
        merchant_id, recovery_generation, session_hash, csrf_hash,
        merchant_secret_hash, replacement_secret_hash, expires_at
      )
      SELECT proven.id, proven.recovery_generation, ${input.sessionHash}, ${input.csrfHash},
        proven.secret_hash, ${input.replacementSecretHash}, now() + interval '15 minutes'
      FROM proven WHERE proven.secret_hash <> ${input.replacementSecretHash}
      ON CONFLICT DO NOTHING RETURNING merchant_id
    )
    SELECT 'staged'::text AS status, proven.id AS merchant_id, proven.handle
    FROM proven JOIN staged ON staged.merchant_id = proven.id
    UNION ALL
    SELECT 'credential_rejected'::text, NULL::integer, NULL::text
    WHERE NOT EXISTS (SELECT 1 FROM proven)
    UNION ALL
    SELECT 'request_unavailable'::text, NULL::integer, NULL::text
    WHERE EXISTS (SELECT 1 FROM proven) AND NOT EXISTS (SELECT 1 FROM staged)
  `) as Array<{
    status: 'staged' | 'credential_rejected' | 'request_unavailable'
    merchant_id: number | null
    handle: string | null
  }>
  const result = rows[0]
  if (!result) throw new Error('merchant rotation staging produced no outcome')
  if (result.status !== 'staged') return { status: result.status }
  if (result.merchant_id === null || result.handle === null) {
    throw new Error('merchant rotation staging returned an incomplete merchant')
  }
  return { status: 'staged', merchantId: result.merchant_id, handle: result.handle }
}

async function confirmMerchantRotationOnce(input: {
  sessionHash: string
  csrfHash: string
  replacementSecretHash: string
}): Promise<MerchantRotationConfirmationResult> {
  const transaction = await runReadCommittedTransaction(transactionSql => [
    transactionSql`
      -- Every credential-changing path locks the merchant before its own child rows.
      SELECT merchant.id
      FROM merchant_key_rotations rotation
      JOIN merchants merchant ON merchant.id = rotation.merchant_id
      WHERE rotation.session_hash = ${input.sessionHash}
        AND rotation.csrf_hash = ${input.csrfHash}
        AND rotation.expires_at > now() AND rotation.confirmed_at IS NULL
        AND rotation.canceled_at IS NULL AND rotation.invalidated_at IS NULL
      FOR UPDATE OF merchant
    `,
    transactionSql`
    WITH cleared_expired AS (
      UPDATE merchant_key_rotations
      SET canceled_at = now(), merchant_secret_hash = NULL, replacement_secret_hash = NULL
      WHERE expires_at <= now() AND confirmed_at IS NULL AND canceled_at IS NULL
        AND invalidated_at IS NULL
    ), active_rotation AS MATERIALIZED (
      SELECT rotation.id AS rotation_id, rotation.merchant_id,
        rotation.recovery_generation, rotation.merchant_secret_hash,
        rotation.replacement_secret_hash, merchant.handle,
        merchant.secret_hash AS current_secret_hash,
        merchant.recovery_generation AS current_generation
      FROM merchant_key_rotations rotation
      JOIN merchants merchant ON merchant.id = rotation.merchant_id
      WHERE rotation.session_hash = ${input.sessionHash} AND rotation.csrf_hash = ${input.csrfHash}
        AND rotation.expires_at > now() AND rotation.confirmed_at IS NULL
        AND rotation.canceled_at IS NULL AND rotation.invalidated_at IS NULL
      FOR UPDATE OF rotation
    ), available_rotation AS MATERIALIZED (
      SELECT * FROM active_rotation
      WHERE merchant_secret_hash = current_secret_hash
        AND recovery_generation = current_generation
    ), eligible AS MATERIALIZED (
      SELECT * FROM available_rotation
      WHERE replacement_secret_hash = ${input.replacementSecretHash}
    ), admission AS MATERIALIZED (
      SELECT eligible.*,
        (SELECT count(*)::integer FROM merchant_key_rotations prior
         WHERE prior.merchant_id = eligible.merchant_id
           AND prior.confirmed_at >= date_trunc('day', now(), 'UTC')) AS daily_successes
      FROM eligible
    ), rate_limited AS (
      UPDATE merchant_key_rotations rotation
      SET canceled_at = now(), merchant_secret_hash = NULL, replacement_secret_hash = NULL
      FROM admission WHERE rotation.id = admission.rotation_id
        AND admission.daily_successes >= 5 RETURNING rotation.id
    ), changed AS (
      UPDATE merchants merchant
      SET secret_hash = admission.replacement_secret_hash,
          recovery_generation = merchant.recovery_generation + 1
      FROM admission WHERE merchant.id = admission.merchant_id
        AND admission.daily_successes < 5
        AND merchant.secret_hash = admission.merchant_secret_hash
        AND merchant.recovery_generation = admission.recovery_generation
      RETURNING merchant.id, merchant.handle
    ), confirmed AS (
      UPDATE merchant_key_rotations rotation
      SET confirmed_at = now(), merchant_secret_hash = NULL, replacement_secret_hash = NULL
      FROM admission JOIN changed ON changed.id = admission.merchant_id
      WHERE rotation.id = admission.rotation_id
      RETURNING rotation.id, changed.id AS merchant_id, changed.handle
    ), invalidated_rotation_siblings AS (
      UPDATE merchant_key_rotations rotation
      SET invalidated_at = now(), merchant_secret_hash = NULL, replacement_secret_hash = NULL
      FROM confirmed WHERE rotation.merchant_id = confirmed.merchant_id
        AND rotation.id <> confirmed.id AND rotation.confirmed_at IS NULL
        AND rotation.canceled_at IS NULL AND rotation.invalidated_at IS NULL
    ), invalidated_recovery AS (
      UPDATE merchant_recovery_codes code
      SET invalidated_at = coalesce(code.invalidated_at, now()),
          recovery_session_hash = NULL, recovery_csrf_hash = NULL,
          replacement_secret_hash = NULL, recovery_expires_at = NULL, staged_at = NULL
      FROM confirmed WHERE code.merchant_id = confirmed.merchant_id
        AND code.used_at IS NULL AND code.invalidated_at IS NULL
    ), revoked_families AS (
      UPDATE oauth_token_families family
      SET revoked_at = coalesce(family.revoked_at, now()),
          revoke_reason = coalesce(family.revoke_reason, 'merchant key rotation')
      FROM confirmed WHERE family.merchant_id = confirmed.merchant_id
      RETURNING family.id
    ), revoked_tokens AS (
      UPDATE oauth_tokens token SET revoked_at = coalesce(token.revoked_at, now())
      FROM oauth_token_families family, confirmed
      WHERE token.family_id = family.id AND family.merchant_id = confirmed.merchant_id
    ), invalidated_codes AS (
      UPDATE oauth_authorization_codes code SET used_at = coalesce(code.used_at, now())
      FROM confirmed WHERE code.merchant_id = confirmed.merchant_id
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'rotate', handle, '{}'::jsonb FROM confirmed RETURNING actor
    )
    SELECT 'rotated'::text AS status, confirmed.merchant_id, confirmed.handle
    FROM confirmed WHERE EXISTS (SELECT 1 FROM new_event)
    UNION ALL
    SELECT 'rate_limited'::text, NULL::integer, NULL::text FROM rate_limited
    UNION ALL
    SELECT 'request_unavailable'::text, NULL::integer, NULL::text
    WHERE NOT EXISTS (SELECT 1 FROM active_rotation)
      OR NOT EXISTS (SELECT 1 FROM available_rotation)
    UNION ALL
    SELECT 'credential_rejected'::text, NULL::integer, NULL::text
    WHERE EXISTS (SELECT 1 FROM available_rotation) AND NOT EXISTS (SELECT 1 FROM eligible)
    `,
  ])
  const rows = transaction[1] as Array<{
    status: 'rotated' | 'rate_limited' | 'credential_rejected' | 'request_unavailable'
    merchant_id: number | null
    handle: string | null
  }>
  const result = rows[0]
  if (!result) throw new Error('merchant rotation confirmation produced no outcome')
  if (result.status !== 'rotated') return { status: result.status }
  if (result.merchant_id === null || result.handle === null) {
    throw new Error('merchant rotation confirmation returned an incomplete merchant')
  }
  return { status: 'rotated', merchantId: result.merchant_id, handle: result.handle }
}

export async function confirmMerchantRotation(input: {
  sessionHash: string
  csrfHash: string
  replacementSecretHash: string
}): Promise<MerchantRotationConfirmationResult> {
  for (const [name, value] of Object.entries(input)) requireHash(value, name)
  return retryMarketIdentityDeadlockOnce(() => confirmMerchantRotationOnce(input))
}

export async function cancelMerchantRotation(input: {
  sessionHash: string
  csrfHash: string
}): Promise<boolean> {
  requireHash(input.sessionHash, 'session hash')
  requireHash(input.csrfHash, 'csrf hash')
  const rows = (await sql`
    UPDATE merchant_key_rotations
    SET canceled_at = now(), merchant_secret_hash = NULL, replacement_secret_hash = NULL
    WHERE session_hash = ${input.sessionHash} AND csrf_hash = ${input.csrfHash}
      AND expires_at > now() AND confirmed_at IS NULL AND canceled_at IS NULL
      AND invalidated_at IS NULL RETURNING id
  `) as Array<{ id: number }>
  return rows.length === 1
}

export const postgresMarketIdentityStore = {
  consumeMarketIdentityRateLimit,
  getMerchantRegistrationProgress,
  stageMerchantRegistration,
  confirmMerchantRegistration,
  cancelMerchantRegistration,
  generateMerchantRecoveryCodes,
  getMerchantRecoveryProgress,
  stageMerchantRecovery,
  confirmMerchantRecovery,
  cancelMerchantRecovery,
  getMerchantRotationProgress,
  stageMerchantRotation,
  confirmMerchantRotation,
  cancelMerchantRotation,
} as const

export type MarketIdentityStore = typeof postgresMarketIdentityStore
