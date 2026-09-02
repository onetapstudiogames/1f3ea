-- Additive migration for the coding-client JSON identity doors (POST /api/register,
-- /api/rotate, /api/recovery) and pairing (POST /api/pair). No existing row, column, or
-- constraint is removed or narrowed. Not run against any database by this change.

-- The three JSON doors reuse the same ceremony tables and the same
-- merchant_identity_rate_limits bucket as the browser pages (see 20260827_market_identity.sql);
-- only the new pairing-mint attempt kind needs to be added to that table's allowed set.
DO $merchant_identity_rate_limits_attempt_kind_allowed$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'merchant_identity_rate_limits'::regclass
      AND conname = 'merchant_identity_rate_limits_attempt_kind_allowed'
  ) THEN
    ALTER TABLE merchant_identity_rate_limits
      DROP CONSTRAINT merchant_identity_rate_limits_attempt_kind_allowed;
  END IF;
  ALTER TABLE merchant_identity_rate_limits
    ADD CONSTRAINT merchant_identity_rate_limits_attempt_kind_allowed CHECK (
      attempt_kind IN (
        'join_stage', 'join_confirm', 'recovery_generate',
        'recovery_begin', 'recovery_confirm',
        'rotation_begin', 'rotation_confirm', 'pair_create'
      )
    ) NOT VALID;
END
$merchant_identity_rate_limits_attempt_kind_allowed$;

ALTER TABLE merchant_identity_rate_limits
  VALIDATE CONSTRAINT merchant_identity_rate_limits_attempt_kind_allowed;

-- One 10-minute single-use pairing code per row. It never stores the merchant key or a
-- reusable secret; redeeming it (at POST /oauth/authorize action=pair) reads the merchant's
-- CURRENT secret hash at redemption time. Every unused code is also invalidated the moment
-- its merchant's key is rotated or recovered (see confirmMerchantRotation in
-- market-identity-store.ts and confirmMerchantRecovery in market-identity-recovery-store.ts),
-- so a code minted under a stolen key stops working the moment the legitimate owner changes
-- the key, not merely when its own ten-minute clock runs out.
CREATE TABLE IF NOT EXISTS merchant_pairing_codes (
  id             BIGSERIAL PRIMARY KEY,
  merchant_id    INTEGER NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  code_hash      TEXT NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CHECK (used_at IS NULL OR (used_at >= created_at AND used_at <= expires_at)),
  CHECK (invalidated_at IS NULL OR invalidated_at >= created_at)
);
-- Idempotent for a partial earlier apply of this same migration file.
ALTER TABLE merchant_pairing_codes ADD COLUMN IF NOT EXISTS invalidated_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS merchant_pairing_codes_merchant
  ON merchant_pairing_codes (merchant_id, id);
CREATE INDEX IF NOT EXISTS merchant_pairing_codes_expiry
  ON merchant_pairing_codes (expires_at)
  WHERE used_at IS NULL;
