import {
  postgresUniqueConstraint,
  retryPostgresDeadlockOnce,
} from './postgres-error.ts'
import {
  requireInitialRecoveryCodeHashes,
  requireOAuthHash,
} from './market-oauth-hashes.ts'
import type {
  AuthorizationRedirect,
  AuthorizationRequestProgress,
  MarketOAuthQuery,
} from './market-oauth-store.ts'

export type PendingMerchantRegistrationResult =
  | { status: 'staged'; handle: string }
  | { status: 'handle_taken' }
  | { status: 'request_unavailable' }

export type NewMerchantConfirmationResult =
  | ({ status: 'approved' } & AuthorizationRedirect)
  | { status: 'confirmation_not_ready' }
  | { status: 'confirmation_rejected' }
  | { status: 'handle_taken' }
  | { status: 'request_unavailable' }

export interface StageNewMerchantRegistrationInput {
  sessionHash: string
  csrfHash: string
  handle: string
  model: string
  merchantSecretHash: string
  recoveryCodeHashes: string[]
}

export interface ConfirmNewMerchantInput {
  sessionHash: string
  csrfHash: string
  merchantSecretHash: string
  authorizationCodeHash: string
}

interface RegistrationDependencies {
  cancelAuthorizationRequest(input: {
    sessionHash: string
    csrfHash: string
  }): Promise<AuthorizationRedirect | null>
  getAuthorizationRequestProgress(input: {
    sessionHash: string
    csrfHash: string
  }): Promise<AuthorizationRequestProgress | null>
}

export function createMarketOAuthRegistrationStore(
  query: MarketOAuthQuery,
  dependencies: RegistrationDependencies,
) {
  async function stageNewMerchantRegistration(
    input: StageNewMerchantRegistrationInput,
  ): Promise<PendingMerchantRegistrationResult> {
    requireOAuthHash(input.sessionHash, 'sessionHash')
    requireOAuthHash(input.csrfHash, 'csrfHash')
    requireOAuthHash(input.merchantSecretHash, 'merchantSecretHash')
    requireInitialRecoveryCodeHashes(input.recoveryCodeHashes)
    const rows = await query`
      WITH eligible AS MATERIALIZED (
        SELECT id
        FROM oauth_authorization_requests
        WHERE session_hash = ${input.sessionHash}
          AND csrf_hash = ${input.csrfHash}
          AND intent IS NULL
          AND merchant_id IS NULL
          AND used_at IS NULL
          AND expires_at > now()
        FOR UPDATE
      ), staged AS MATERIALIZED (
        UPDATE oauth_authorization_requests request
        SET intent = 'new',
            new_handle = ${input.handle},
            new_model = ${input.model},
            new_secret_hash = ${input.merchantSecretHash}
        FROM eligible
        WHERE request.id = eligible.id
          AND NOT EXISTS (
            SELECT 1 FROM merchants WHERE handle = ${input.handle}
          )
        RETURNING request.id, request.new_handle AS handle
      ), staged_codes AS (
        INSERT INTO oauth_authorization_request_recovery_codes (
          request_id, ordinal, code_hash
        )
        SELECT staged.id, code.ordinality::smallint, code.code_hash
        FROM staged
        CROSS JOIN unnest(${input.recoveryCodeHashes}::text[])
          WITH ORDINALITY AS code(code_hash, ordinality)
        RETURNING request_id
      )
      SELECT
        EXISTS (SELECT 1 FROM eligible) AS eligible,
        (SELECT handle FROM staged
          WHERE (SELECT count(*) FROM staged_codes) = 8) AS handle
    ` as unknown as { eligible: boolean; handle: string | null }[]
    const result = rows[0]
    if (!result?.eligible) return { status: 'request_unavailable' }
    return result.handle
      ? { status: 'staged', handle: result.handle }
      : { status: 'handle_taken' }
  }

  async function confirmNewMerchantOnce(
    input: ConfirmNewMerchantInput,
  ): Promise<NewMerchantConfirmationResult> {
    try {
      const rows = await query`
        WITH active_request AS MATERIALIZED (
          SELECT id, client_id, redirect_uri, resource, scope, state,
            code_challenge, intent, merchant_id, new_handle, new_model,
            new_secret_hash, verified_at, approved_at, merchant_key_confirmed_at
          FROM oauth_authorization_requests
          WHERE session_hash = ${input.sessionHash}
            AND csrf_hash = ${input.csrfHash}
            AND used_at IS NULL
            AND expires_at > now()
          FOR UPDATE
        ), confirmable_request AS MATERIALIZED (
          SELECT *
          FROM active_request
          WHERE intent = 'new'
            AND merchant_id IS NULL
            AND new_handle IS NOT NULL
            AND new_model IS NOT NULL
            AND new_secret_hash IS NOT NULL
            AND verified_at IS NULL
            AND approved_at IS NULL
            AND merchant_key_confirmed_at IS NULL
        ), eligible AS MATERIALIZED (
          SELECT id, client_id, redirect_uri, resource, scope, state,
            code_challenge, new_handle, new_model, new_secret_hash
          FROM confirmable_request
          WHERE new_secret_hash = ${input.merchantSecretHash}
        ), handle_conflict AS MATERIALIZED (
          SELECT merchant.handle
          FROM merchants merchant
          JOIN eligible ON eligible.new_handle = merchant.handle
        ), canceled_handle_conflict AS MATERIALIZED (
          UPDATE oauth_authorization_requests request
          SET used_at = now(),
              intent = NULL,
              new_handle = NULL,
              new_model = NULL,
              new_secret_hash = NULL,
              verified_at = NULL,
              approved_at = NULL,
              merchant_key_confirmed_at = NULL
          FROM eligible
          WHERE request.id = eligible.id
            AND EXISTS (SELECT 1 FROM handle_conflict)
          RETURNING request.id
        ), scrubbed_conflict_codes AS (
          DELETE FROM oauth_authorization_request_recovery_codes code
          USING canceled_handle_conflict request
          WHERE code.request_id = request.id
          RETURNING code.request_id
        ), completed_handle_conflict AS MATERIALIZED (
          SELECT request.id
          FROM canceled_handle_conflict request
          LEFT JOIN scrubbed_conflict_codes code ON code.request_id = request.id
          GROUP BY request.id
        ), pending_codes AS MATERIALIZED (
          SELECT code.code_hash
          FROM oauth_authorization_request_recovery_codes code
          JOIN eligible ON eligible.id = code.request_id
          ORDER BY code.ordinal
          FOR UPDATE OF code
        ), valid_code_set AS MATERIALIZED (
          SELECT count(*) AS code_count
          FROM pending_codes
          HAVING count(*) = 8 AND count(DISTINCT code_hash) = 8
        ), new_merchant AS (
          INSERT INTO merchants (handle, model, secret_hash, recovery_generation)
          SELECT eligible.new_handle, eligible.new_model, eligible.new_secret_hash, 1
          FROM eligible
          WHERE EXISTS (SELECT 1 FROM valid_code_set)
            AND NOT EXISTS (SELECT 1 FROM handle_conflict)
          RETURNING id, handle, model
        ), inserted_recovery_codes AS (
          INSERT INTO merchant_recovery_codes (merchant_id, generation, code_hash)
          SELECT merchant.id, 1, code.code_hash
          FROM new_merchant merchant
          CROSS JOIN pending_codes code
          RETURNING merchant_id
        ), consumed_request AS (
          UPDATE oauth_authorization_requests request
          SET merchant_id = merchant.id,
              new_secret_hash = NULL,
              verified_at = now(),
              approved_at = now(),
              merchant_key_confirmed_at = now(),
              used_at = now()
          FROM eligible
          CROSS JOIN new_merchant merchant
          WHERE request.id = eligible.id
          RETURNING request.id, merchant.id AS merchant_id, merchant.handle,
            merchant.model, request.client_id, request.redirect_uri,
            request.resource, request.scope, request.state, request.code_challenge
        ), scrubbed_pending_codes AS (
          DELETE FROM oauth_authorization_request_recovery_codes code
          USING consumed_request request
          WHERE code.request_id = request.id
          RETURNING code.request_id
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'register', handle,
            jsonb_build_object('id', merchant_id, 'model', model)
          FROM consumed_request
          RETURNING actor
        ), issued_code AS (
          INSERT INTO oauth_authorization_codes (
            request_id, code_hash, merchant_id, client_id, redirect_uri, resource,
            scope, code_challenge, code_challenge_method, expires_at
          )
          SELECT id, ${input.authorizationCodeHash}, merchant_id, client_id, redirect_uri,
            resource, scope, code_challenge, 'S256', now() + interval '5 minutes'
          FROM consumed_request
          WHERE EXISTS (
            SELECT 1 FROM new_event WHERE actor = consumed_request.handle
          )
            AND (SELECT count(*) FROM inserted_recovery_codes) = 8
            AND (SELECT count(*) FROM scrubbed_pending_codes) = 8
          RETURNING request_id
        ), completed AS MATERIALIZED (
          SELECT request.redirect_uri, request.state
          FROM consumed_request request
          JOIN issued_code code ON code.request_id = request.id
        )
        SELECT 'approved'::text AS status, completed.redirect_uri, completed.state
        FROM completed
        UNION ALL
        SELECT 'request_unavailable'::text, NULL::text, NULL::text
        WHERE NOT EXISTS (SELECT 1 FROM active_request)
        UNION ALL
        SELECT 'confirmation_not_ready'::text, NULL::text, NULL::text
        WHERE EXISTS (SELECT 1 FROM active_request)
          AND NOT EXISTS (SELECT 1 FROM confirmable_request)
        UNION ALL
        SELECT 'confirmation_rejected'::text, NULL::text, NULL::text
        WHERE EXISTS (SELECT 1 FROM confirmable_request)
          AND NOT EXISTS (SELECT 1 FROM eligible)
        UNION ALL
        SELECT 'handle_taken'::text, NULL::text, NULL::text
        FROM completed_handle_conflict
      ` as unknown as {
        status:
          | 'approved'
          | 'confirmation_not_ready'
          | 'confirmation_rejected'
          | 'handle_taken'
          | 'request_unavailable'
        redirect_uri: string | null
        state: string | null
      }[]
      const result = rows[0]
      if (!result) throw new Error('new-merchant confirmation produced no outcome')
      if (result.status !== 'approved') return { status: result.status }
      if (result.redirect_uri === null || result.state === null) {
        throw new Error('new-merchant confirmation returned an incomplete redirect')
      }
      return { status: 'approved', redirectUri: result.redirect_uri, state: result.state }
    } catch (error) {
      if (postgresUniqueConstraint(error) === 'merchants_handle_key') {
        const canceled = await dependencies.cancelAuthorizationRequest({
          sessionHash: input.sessionHash,
          csrfHash: input.csrfHash,
        })
        if (canceled) return { status: 'handle_taken' }
        const progress = await dependencies.getAuthorizationRequestProgress({
          sessionHash: input.sessionHash,
          csrfHash: input.csrfHash,
        })
        if (progress?.status === 'canceled') return { status: 'handle_taken' }
      }
      throw error
    }
  }

  async function confirmNewMerchantAndIssueAuthorizationCode(
    input: ConfirmNewMerchantInput,
  ): Promise<NewMerchantConfirmationResult> {
    requireOAuthHash(input.sessionHash, 'sessionHash')
    requireOAuthHash(input.csrfHash, 'csrfHash')
    requireOAuthHash(input.merchantSecretHash, 'merchantSecretHash')
    requireOAuthHash(input.authorizationCodeHash, 'authorizationCodeHash')
    return retryPostgresDeadlockOnce(() => confirmNewMerchantOnce(input))
  }

  return { stageNewMerchantRegistration, confirmNewMerchantAndIssueAuthorizationCode }
}
