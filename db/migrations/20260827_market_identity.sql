-- Additive merchant identity migration: resumable registration, one-use recovery,
-- and confirm-before-change key rotation. Every credential-shaped value is a hash.

ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS recovery_generation BIGINT NOT NULL DEFAULT 0;

DO $merchant_recovery_generation$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'merchants'::regclass
      AND conname = 'merchants_recovery_generation_nonnegative'
  ) THEN
    ALTER TABLE merchants
      ADD CONSTRAINT merchants_recovery_generation_nonnegative
      CHECK (recovery_generation >= 0) NOT VALID;
  END IF;
END
$merchant_recovery_generation$;

ALTER TABLE merchants
  VALIDATE CONSTRAINT merchants_recovery_generation_nonnegative;

-- Pending names are intentionally not exclusive. The merchants unique constraint
-- decides the one winner only after that caller re-enters the displayed key.
CREATE TABLE IF NOT EXISTS pending_merchant_registrations (
  session_hash  TEXT PRIMARY KEY CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  csrf_hash     TEXT NOT NULL UNIQUE CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  ip_hash       TEXT CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
  handle        TEXT CHECK (handle IS NULL OR handle ~ '^[a-z0-9][a-z0-9-]{2,31}$'),
  model         TEXT CHECK (model IS NULL OR char_length(model) <= 120),
  client_class  TEXT CHECK (
                  client_class IS NULL OR client_class IN (
                    'hosted_browser', 'coding_persistent', 'coding_ephemeral', 'oauth_refused'
                  )
                ),
  secret_hash   TEXT CHECK (secret_hash IS NULL OR secret_hash ~ '^[0-9a-f]{64}$'),
  merchant_id   INTEGER UNIQUE REFERENCES merchants(id) ON DELETE RESTRICT,
  expires_at    TIMESTAMPTZ NOT NULL,
  confirmed_at  TIMESTAMPTZ,
  canceled_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (merchant_id IS NULL AND confirmed_at IS NULL AND canceled_at IS NULL
      AND ip_hash IS NOT NULL AND handle IS NOT NULL AND model IS NOT NULL
      AND client_class IS NOT NULL AND secret_hash IS NOT NULL)
    OR
    (merchant_id IS NOT NULL AND confirmed_at IS NOT NULL AND canceled_at IS NULL
      AND ip_hash IS NULL AND handle IS NULL AND model IS NULL
      AND client_class IS NULL AND secret_hash IS NULL)
    OR
    (merchant_id IS NULL AND confirmed_at IS NULL AND canceled_at IS NOT NULL
      AND ip_hash IS NULL AND handle IS NULL AND model IS NULL
      AND client_class IS NULL AND secret_hash IS NULL)
  ),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
  CHECK (confirmed_at IS NULL OR confirmed_at >= created_at),
  CHECK (canceled_at IS NULL OR canceled_at >= created_at)
);
CREATE INDEX IF NOT EXISTS pending_merchant_registrations_expiry
  ON pending_merchant_registrations (expires_at, session_hash)
  WHERE confirmed_at IS NULL AND canceled_at IS NULL;

CREATE TABLE IF NOT EXISTS pending_merchant_registration_recovery_codes (
  registration_session_hash TEXT NOT NULL
                            REFERENCES pending_merchant_registrations(session_hash)
                            ON DELETE CASCADE,
  ordinal                   SMALLINT NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
  code_hash                 TEXT NOT NULL UNIQUE
                            CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (registration_session_hash, ordinal)
);

CREATE TABLE IF NOT EXISTS merchant_recovery_codes (
  id                       BIGSERIAL PRIMARY KEY,
  merchant_id              INTEGER NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  generation               BIGINT NOT NULL CHECK (generation > 0),
  code_hash                TEXT NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  recovery_session_hash    TEXT UNIQUE CHECK (
                             recovery_session_hash IS NULL OR recovery_session_hash ~ '^[0-9a-f]{64}$'
                           ),
  recovery_csrf_hash       TEXT UNIQUE CHECK (
                             recovery_csrf_hash IS NULL OR recovery_csrf_hash ~ '^[0-9a-f]{64}$'
                           ),
  replacement_secret_hash TEXT CHECK (
                             replacement_secret_hash IS NULL OR replacement_secret_hash ~ '^[0-9a-f]{64}$'
                           ),
  recovery_expires_at      TIMESTAMPTZ,
  staged_at                TIMESTAMPTZ,
  used_at                  TIMESTAMPTZ,
  invalidated_at           TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (used_at IS NULL OR invalidated_at IS NULL),
  CONSTRAINT merchant_recovery_codes_ceremony_state CHECK (
    (recovery_session_hash IS NULL AND recovery_csrf_hash IS NULL
      AND replacement_secret_hash IS NULL AND recovery_expires_at IS NULL AND staged_at IS NULL)
    OR
    (recovery_session_hash IS NOT NULL AND recovery_csrf_hash IS NOT NULL
      AND (
        (replacement_secret_hash IS NOT NULL AND recovery_expires_at IS NOT NULL
          AND staged_at IS NOT NULL AND used_at IS NULL AND invalidated_at IS NULL)
        OR
        (replacement_secret_hash IS NULL AND (
          (recovery_expires_at IS NULL AND staged_at IS NULL)
          OR (recovery_expires_at IS NOT NULL AND staged_at IS NOT NULL
            AND used_at IS NULL AND invalidated_at IS NULL)
        ))
      ))
  ),
  CONSTRAINT merchant_recovery_codes_expiry_window CHECK (
    recovery_expires_at IS NULL
    OR (recovery_expires_at > staged_at
      AND recovery_expires_at <= staged_at + interval '15 minutes')
  ),
  CHECK (used_at IS NULL OR used_at >= created_at),
  CHECK (invalidated_at IS NULL OR invalidated_at >= created_at)
);
CREATE INDEX IF NOT EXISTS merchant_recovery_codes_merchant
  ON merchant_recovery_codes (merchant_id, generation, id);
CREATE INDEX IF NOT EXISTS merchant_recovery_codes_active
  ON merchant_recovery_codes (merchant_id, generation, id)
  WHERE used_at IS NULL AND invalidated_at IS NULL;

CREATE TABLE IF NOT EXISTS merchant_recovery_ceremony_results (
  session_hash TEXT PRIMARY KEY CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  csrf_hash    TEXT NOT NULL UNIQUE CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  merchant_id INTEGER NOT NULL CHECK (merchant_id > 0),
  outcome     TEXT NOT NULL,
  terminal_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  CONSTRAINT merchant_recovery_ceremony_results_outcome_allowed CHECK (
    outcome IN ('recovered', 'canceled', 'expired', 'invalidated')
  ),
  CONSTRAINT merchant_recovery_ceremony_results_retention_window CHECK (
    expires_at > terminal_at AND expires_at <= terminal_at + interval '24 hours'
  )
);
CREATE INDEX IF NOT EXISTS merchant_recovery_ceremony_results_expiry
  ON merchant_recovery_ceremony_results (expires_at, session_hash);

INSERT INTO merchant_recovery_ceremony_results (
  session_hash, csrf_hash, merchant_id, outcome, terminal_at, expires_at
)
SELECT code.recovery_session_hash, code.recovery_csrf_hash, code.merchant_id,
  CASE
    WHEN code.used_at IS NOT NULL THEN 'recovered'
    WHEN code.invalidated_at IS NOT NULL THEN 'invalidated'
    WHEN code.recovery_expires_at IS NULL AND code.staged_at IS NULL THEN 'canceled'
    ELSE 'expired'
  END,
  coalesce(code.used_at, code.invalidated_at, code.recovery_expires_at, now()),
  coalesce(code.used_at, code.invalidated_at, code.recovery_expires_at, now())
    + interval '24 hours'
FROM merchant_recovery_codes code
WHERE code.recovery_session_hash IS NOT NULL AND code.recovery_csrf_hash IS NOT NULL
  AND (code.used_at IS NOT NULL OR code.invalidated_at IS NOT NULL
    OR (code.replacement_secret_hash IS NULL
      AND code.recovery_expires_at IS NULL AND code.staged_at IS NULL)
    OR code.recovery_expires_at <= now())
ON CONFLICT (session_hash) DO NOTHING;

CREATE OR REPLACE FUNCTION record_merchant_recovery_ceremony_result()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  result_outcome TEXT;
  result_time TIMESTAMPTZ;
BEGIN
  IF OLD.recovery_session_hash IS NULL OR OLD.recovery_csrf_hash IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.recovery_session_hash IS NOT DISTINCT FROM OLD.recovery_session_hash
    AND NEW.recovery_csrf_hash IS NOT DISTINCT FROM OLD.recovery_csrf_hash
    AND NEW.used_at IS NULL AND NEW.invalidated_at IS NULL
    AND NEW.replacement_secret_hash IS NOT NULL AND NEW.recovery_expires_at > now() THEN
    RETURN NEW;
  END IF;
  IF OLD.used_at IS NOT NULL OR NEW.used_at IS NOT NULL THEN
    result_outcome := 'recovered';
    result_time := coalesce(OLD.used_at, NEW.used_at);
  ELSIF OLD.invalidated_at IS NOT NULL THEN
    result_outcome := 'invalidated';
    result_time := OLD.invalidated_at;
  ELSIF OLD.recovery_expires_at IS NOT NULL AND OLD.recovery_expires_at <= now() THEN
    result_outcome := 'expired';
    result_time := OLD.recovery_expires_at;
  ELSIF OLD.replacement_secret_hash IS NULL AND OLD.recovery_expires_at IS NULL
    AND OLD.staged_at IS NULL THEN
    result_outcome := 'canceled';
    result_time := now();
  ELSIF NEW.invalidated_at IS NOT NULL THEN
    result_outcome := 'invalidated';
    result_time := NEW.invalidated_at;
  ELSIF NEW.replacement_secret_hash IS NULL AND NEW.recovery_expires_at IS NULL
    AND NEW.staged_at IS NULL THEN
    result_outcome := 'canceled';
    result_time := now();
  ELSE
    RETURN NEW;
  END IF;
  INSERT INTO merchant_recovery_ceremony_results (
    session_hash, csrf_hash, merchant_id, outcome, terminal_at, expires_at
  ) VALUES (
    OLD.recovery_session_hash, OLD.recovery_csrf_hash, OLD.merchant_id,
    result_outcome, result_time, result_time + interval '24 hours'
  ) ON CONFLICT (session_hash) DO NOTHING;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS merchant_recovery_ceremony_result ON merchant_recovery_codes;
CREATE TRIGGER merchant_recovery_ceremony_result
AFTER UPDATE ON merchant_recovery_codes
FOR EACH ROW EXECUTE FUNCTION record_merchant_recovery_ceremony_result();

CREATE TABLE IF NOT EXISTS merchant_key_rotations (
  id                       BIGSERIAL PRIMARY KEY,
  merchant_id              INTEGER NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  recovery_generation      BIGINT NOT NULL CHECK (recovery_generation >= 0),
  session_hash             TEXT UNIQUE CHECK (
                             session_hash IS NULL OR session_hash ~ '^[0-9a-f]{64}$'
                           ),
  csrf_hash                TEXT UNIQUE CHECK (
                             csrf_hash IS NULL OR csrf_hash ~ '^[0-9a-f]{64}$'
                           ),
  merchant_secret_hash    TEXT CHECK (
                             merchant_secret_hash IS NULL OR merchant_secret_hash ~ '^[0-9a-f]{64}$'
                           ),
  replacement_secret_hash TEXT CHECK (
                             replacement_secret_hash IS NULL OR replacement_secret_hash ~ '^[0-9a-f]{64}$'
                           ),
  expires_at               TIMESTAMPTZ NOT NULL,
  confirmed_at             TIMESTAMPTZ,
  canceled_at              TIMESTAMPTZ,
  invalidated_at           TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (merchant_secret_hash IS NULL OR replacement_secret_hash <> merchant_secret_hash),
  CHECK (num_nonnulls(confirmed_at, canceled_at, invalidated_at) <= 1),
  CHECK (
    (
      confirmed_at IS NULL AND canceled_at IS NULL AND invalidated_at IS NULL
      AND session_hash IS NOT NULL AND csrf_hash IS NOT NULL
      AND merchant_secret_hash IS NOT NULL AND replacement_secret_hash IS NOT NULL
    )
    OR
    (
      num_nonnulls(confirmed_at, canceled_at, invalidated_at) = 1
      AND session_hash IS NOT NULL AND csrf_hash IS NOT NULL
      AND merchant_secret_hash IS NULL AND replacement_secret_hash IS NULL
    )
  ),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
  CHECK (confirmed_at IS NULL OR confirmed_at >= created_at),
  CHECK (canceled_at IS NULL OR canceled_at >= created_at),
  CHECK (invalidated_at IS NULL OR invalidated_at >= created_at)
);
CREATE INDEX IF NOT EXISTS merchant_key_rotations_merchant
  ON merchant_key_rotations (merchant_id, recovery_generation, id);
CREATE INDEX IF NOT EXISTS merchant_key_rotations_active_expiry
  ON merchant_key_rotations (expires_at, id)
  WHERE confirmed_at IS NULL AND canceled_at IS NULL AND invalidated_at IS NULL;
CREATE INDEX IF NOT EXISTS merchant_key_rotations_daily_success
  ON merchant_key_rotations (merchant_id, confirmed_at DESC)
  WHERE confirmed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS merchant_identity_rate_limits (
  bucket_hash   TEXT NOT NULL CHECK (bucket_hash ~ '^[0-9a-f]{64}$'),
  attempt_kind  TEXT NOT NULL
                CONSTRAINT merchant_identity_rate_limits_attempt_kind_allowed CHECK (
                  attempt_kind IN (
                    'join_stage', 'join_confirm', 'recovery_generate',
                    'recovery_begin', 'recovery_confirm',
                    'rotation_begin', 'rotation_confirm'
                  )
                ),
  window_start  TIMESTAMPTZ NOT NULL,
  used          SMALLINT NOT NULL DEFAULT 1 CHECK (used BETWEEN 1 AND 10000),
  PRIMARY KEY (bucket_hash, attempt_kind, window_start)
);
CREATE INDEX IF NOT EXISTS merchant_identity_rate_limits_expiry
  ON merchant_identity_rate_limits (window_start, attempt_kind);

-- Hosted sign-in can now stage a new merchant without creating it until the
-- displayed key is re-entered exactly. All staged credentials remain hashes.
ALTER TABLE oauth_authorization_requests
  ADD COLUMN IF NOT EXISTS intent TEXT,
  ADD COLUMN IF NOT EXISTS new_handle TEXT,
  ADD COLUMN IF NOT EXISTS new_model TEXT,
  ADD COLUMN IF NOT EXISTS new_secret_hash TEXT,
  ADD COLUMN IF NOT EXISTS merchant_key_confirmed_at TIMESTAMPTZ;

-- Rows completed by the earlier existing-merchant flow retain their meaning.
UPDATE oauth_authorization_requests
SET intent = 'existing'
WHERE intent IS NULL AND merchant_id IS NOT NULL;

DO $oauth_authorization_request_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'oauth_authorization_requests'::regclass
      AND conname = 'oauth_authorization_requests_intent_allowed'
  ) THEN
    ALTER TABLE oauth_authorization_requests
      ADD CONSTRAINT oauth_authorization_requests_intent_allowed
      CHECK (intent IN ('existing', 'new')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'oauth_authorization_requests'::regclass
      AND conname = 'oauth_authorization_requests_identity_values'
  ) THEN
    ALTER TABLE oauth_authorization_requests
      ADD CONSTRAINT oauth_authorization_requests_identity_values CHECK (
        (new_handle IS NULL OR new_handle ~ '^[a-z0-9][a-z0-9-]{2,31}$')
        AND (new_model IS NULL OR char_length(new_model) <= 120)
        AND (new_secret_hash IS NULL OR new_secret_hash ~ '^[0-9a-f]{64}$')
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'oauth_authorization_requests'::regclass
      AND conname = 'oauth_authorization_requests_identity_state'
  ) THEN
    ALTER TABLE oauth_authorization_requests
      ADD CONSTRAINT oauth_authorization_requests_identity_state CHECK (
        (intent IS NULL AND merchant_id IS NULL AND new_handle IS NULL
          AND new_model IS NULL AND new_secret_hash IS NULL
          AND verified_at IS NULL AND approved_at IS NULL
          AND merchant_key_confirmed_at IS NULL)
        OR
        (intent = 'existing' AND merchant_id IS NOT NULL
          AND new_handle IS NULL AND new_model IS NULL AND new_secret_hash IS NULL
          AND merchant_key_confirmed_at IS NULL
          AND verified_at IS NOT NULL AND approved_at IS NOT NULL AND used_at IS NOT NULL)
        OR
        (intent = 'new' AND new_handle IS NOT NULL AND new_model IS NOT NULL
          AND (
            (merchant_id IS NULL AND new_secret_hash IS NOT NULL
              AND merchant_key_confirmed_at IS NULL
              AND verified_at IS NULL AND approved_at IS NULL AND used_at IS NULL)
            OR
            (merchant_id IS NOT NULL AND new_secret_hash IS NULL
              AND merchant_key_confirmed_at IS NOT NULL
              AND verified_at IS NOT NULL AND approved_at IS NOT NULL AND used_at IS NOT NULL)
          ))
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'oauth_authorization_requests'::regclass
      AND conname = 'oauth_authorization_requests_key_confirmation_time'
  ) THEN
    ALTER TABLE oauth_authorization_requests
      ADD CONSTRAINT oauth_authorization_requests_key_confirmation_time CHECK (
        merchant_key_confirmed_at IS NULL
        OR (merchant_id IS NOT NULL AND merchant_key_confirmed_at >= created_at)
      ) NOT VALID;
  END IF;
END
$oauth_authorization_request_constraints$;

ALTER TABLE oauth_authorization_requests
  VALIDATE CONSTRAINT oauth_authorization_requests_intent_allowed,
  VALIDATE CONSTRAINT oauth_authorization_requests_identity_values,
  VALIDATE CONSTRAINT oauth_authorization_requests_identity_state,
  VALIDATE CONSTRAINT oauth_authorization_requests_key_confirmation_time;

CREATE TABLE IF NOT EXISTS oauth_authorization_request_recovery_codes (
  request_id BIGINT NOT NULL
             REFERENCES oauth_authorization_requests(id) ON DELETE CASCADE,
  ordinal    SMALLINT NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
  code_hash  TEXT NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (request_id, ordinal),
  UNIQUE (request_id, code_hash)
);
