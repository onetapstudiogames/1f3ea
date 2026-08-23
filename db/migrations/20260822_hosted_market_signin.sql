-- Hosted ChatGPT sign-in. These additive tables link a short OAuth grant to an
-- existing merchant. Credential material is retained only as SHA-256 hashes.

CREATE TABLE IF NOT EXISTS oauth_authorization_requests (
  id                     BIGSERIAL PRIMARY KEY,
  session_hash           TEXT NOT NULL UNIQUE
                         CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  csrf_hash              TEXT NOT NULL UNIQUE
                         CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  client_id              TEXT NOT NULL CHECK (octet_length(client_id) BETWEEN 1 AND 2048),
  client_display_name    TEXT NOT NULL DEFAULT ''
                         CHECK (octet_length(client_display_name) <= 240),
  redirect_uri           TEXT NOT NULL CHECK (octet_length(redirect_uri) BETWEEN 1 AND 4096),
  resource               TEXT NOT NULL CHECK (octet_length(resource) BETWEEN 1 AND 2048),
  scope                  TEXT NOT NULL CHECK (scope = 'market:merchant'),
  state                  TEXT NOT NULL CHECK (octet_length(state) BETWEEN 1 AND 4096),
  code_challenge         TEXT NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  code_challenge_method  TEXT NOT NULL DEFAULT 'S256'
                         CHECK (code_challenge_method = 'S256'),
  merchant_id            INTEGER REFERENCES merchants(id) ON DELETE RESTRICT,
  verified_at            TIMESTAMPTZ,
  approved_at            TIMESTAMPTZ,
  expires_at             TIMESTAMPTZ NOT NULL,
  used_at                TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (merchant_id IS NULL AND verified_at IS NULL AND approved_at IS NULL)
    OR
    (merchant_id IS NOT NULL AND verified_at IS NOT NULL AND approved_at IS NOT NULL
      AND used_at IS NOT NULL)
  ),
  CHECK (verified_at IS NULL OR verified_at >= created_at),
  CHECK (approved_at IS NULL OR approved_at >= verified_at),
  CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '15 minutes'),
  CHECK (used_at IS NULL OR used_at >= created_at)
);
CREATE INDEX IF NOT EXISTS oauth_authorization_requests_expiry
  ON oauth_authorization_requests (expires_at, id) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS oauth_authorization_requests_merchant
  ON oauth_authorization_requests (merchant_id, created_at DESC)
  WHERE merchant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS oauth_authorization_requests_retention
  ON oauth_authorization_requests (expires_at, id);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id                     BIGSERIAL PRIMARY KEY,
  request_id             BIGINT NOT NULL UNIQUE
                         REFERENCES oauth_authorization_requests(id) ON DELETE RESTRICT,
  code_hash              TEXT NOT NULL UNIQUE
                         CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  merchant_id            INTEGER NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  client_id              TEXT NOT NULL CHECK (octet_length(client_id) BETWEEN 1 AND 2048),
  redirect_uri           TEXT NOT NULL CHECK (octet_length(redirect_uri) BETWEEN 1 AND 4096),
  resource               TEXT NOT NULL CHECK (octet_length(resource) BETWEEN 1 AND 2048),
  scope                  TEXT NOT NULL CHECK (scope = 'market:merchant'),
  code_challenge         TEXT NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  code_challenge_method  TEXT NOT NULL DEFAULT 'S256'
                         CHECK (code_challenge_method = 'S256'),
  expires_at             TIMESTAMPTZ NOT NULL,
  used_at                TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '5 minutes'),
  CHECK (used_at IS NULL OR used_at >= created_at)
);
CREATE INDEX IF NOT EXISTS oauth_authorization_codes_expiry
  ON oauth_authorization_codes (expires_at, id) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS oauth_authorization_codes_merchant
  ON oauth_authorization_codes (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS oauth_authorization_codes_retention
  ON oauth_authorization_codes (expires_at, id);

CREATE TABLE IF NOT EXISTS oauth_token_families (
  id            BIGSERIAL PRIMARY KEY,
  merchant_id   INTEGER NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  client_id     TEXT NOT NULL CHECK (octet_length(client_id) BETWEEN 1 AND 2048),
  resource      TEXT NOT NULL CHECK (octet_length(resource) BETWEEN 1 AND 2048),
  scope         TEXT NOT NULL CHECK (scope = 'market:merchant'),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  revoke_reason TEXT CHECK (revoke_reason IS NULL OR octet_length(revoke_reason) <= 120),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '30 days'),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX IF NOT EXISTS oauth_token_families_merchant
  ON oauth_token_families (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS oauth_token_families_active
  ON oauth_token_families (expires_at, id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS oauth_token_families_retention
  ON oauth_token_families (expires_at, id);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id                    BIGSERIAL PRIMARY KEY,
  token_hash            TEXT NOT NULL UNIQUE
                        CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  token_type            TEXT NOT NULL CHECK (token_type ~ '^(access|refresh)$'),
  family_id             BIGINT NOT NULL REFERENCES oauth_token_families(id) ON DELETE RESTRICT,
  rotated_from_token_id BIGINT UNIQUE REFERENCES oauth_tokens(id) ON DELETE RESTRICT,
  expires_at            TIMESTAMPTZ NOT NULL,
  used_at               TIMESTAMPTZ,
  revoked_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    expires_at > created_at
    AND expires_at <= created_at + CASE token_type
      WHEN 'access' THEN INTERVAL '10 minutes'
      ELSE INTERVAL '30 days'
    END
  ),
  CHECK (used_at IS NULL OR used_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (rotated_from_token_id IS NULL OR token_type = 'refresh')
);
CREATE INDEX IF NOT EXISTS oauth_tokens_family
  ON oauth_tokens (family_id, token_type, created_at DESC);
CREATE INDEX IF NOT EXISTS oauth_tokens_active_expiry
  ON oauth_tokens (expires_at, id) WHERE revoked_at IS NULL;

-- A bucket represents an IP, client, or merchant only after application-side hashing.
CREATE TABLE IF NOT EXISTS oauth_rate_limits (
  bucket_hash   TEXT NOT NULL CHECK (bucket_hash ~ '^[0-9a-f]{64}$'),
  attempt_kind  TEXT NOT NULL CHECK (
                  attempt_kind IN ('authorize', 'merchant_key', 'token', 'refresh', 'revoke')
                ),
  window_start  TIMESTAMPTZ NOT NULL,
  used          SMALLINT NOT NULL DEFAULT 1 CHECK (used BETWEEN 1 AND 10000),
  PRIMARY KEY (bucket_hash, attempt_kind, window_start)
);
CREATE INDEX IF NOT EXISTS oauth_rate_limits_expiry
  ON oauth_rate_limits (window_start, attempt_kind);
