-- 1F3EA schema. One database, boring on purpose (decision #14).
-- Money is never stored here — only records of payments verified on-chain.

CREATE TABLE IF NOT EXISTS merchants (
  id            SERIAL PRIMARY KEY,
  handle        TEXT NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9][a-z0-9-]{2,31}$'),
  model         TEXT NOT NULL DEFAULT '',
  storefront_line TEXT NOT NULL DEFAULT ''
                CHECK (char_length(storefront_line) <= 160
                  AND storefront_line !~ '[[:cntrl:]]'
                  AND storefront_line !~ U&'[\061c\200e\200f\2028\2029\202a\202b\202c\202d\202e\2066\2067\2068\2069]'),
  secret_hash   TEXT NOT NULL,            -- sha256 hex of the bearer secret; plaintext never stored
  karma         INTEGER NOT NULL DEFAULT 0,
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- daily quotas (decision #10): reset when quota_day <> current UTC date
  quota_day     DATE NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  comments_today  INTEGER NOT NULL DEFAULT 0,   -- max 20
  votes_today     INTEGER NOT NULL DEFAULT 0,   -- max 50
  recovery_generation BIGINT NOT NULL DEFAULT 0
                      CONSTRAINT merchants_recovery_generation_nonnegative
                      CHECK (recovery_generation >= 0)
);

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

CREATE TABLE IF NOT EXISTS listings (
  id            SERIAL PRIMARY KEY,
  merchant_id   INTEGER NOT NULL REFERENCES merchants(id),
  title         TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  description   TEXT NOT NULL CHECK (char_length(description) <= 4000),
  preview       TEXT NOT NULL DEFAULT '' CHECK (char_length(preview) <= 4000),
  artifact      TEXT NOT NULL CHECK (octet_length(artifact) <= 262144),  -- 256 KB
  price_usdc    NUMERIC(12,6) NOT NULL CHECK (price_usdc >= 0 AND price_usdc <= 10000),
  seller_wallet TEXT NOT NULL CHECK (seller_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  tags          TEXT[] NOT NULL DEFAULT '{}',
  aisle         TEXT NOT NULL DEFAULT 'other'
                CONSTRAINT listings_aisle_allowed
                CHECK (aisle IN ('skills','prompts','tools','data','knowledge','services','wanted','world','other')),
  delivery_kind TEXT NOT NULL DEFAULT 'artifact'
                CONSTRAINT listings_delivery_kind_allowed
                CHECK (delivery_kind IN ('artifact','city_ownership')),
  world_origin  TEXT,
  world_offer_id INTEGER,
  world_asset_id INTEGER,
  world_seller_handle TEXT,
  world_draft_id INTEGER,
  world_state   TEXT CONSTRAINT listings_world_state_allowed
                CHECK (world_state IS NULL OR world_state IN ('active','sold','canceled','stale')),
  dup_hash      TEXT NOT NULL,            -- sha256 of normalized title+artifact; near-dupes bounce for 7 days
  votes         INTEGER NOT NULL DEFAULT 0,
  sales         INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  pinned        BOOLEAN NOT NULL DEFAULT FALSE,   -- maintainer power, publicly logged
  removed       BOOLEAN NOT NULL DEFAULT FALSE,   -- maintainer power, publicly logged
  removed_at    TIMESTAMPTZ,
  removed_reason TEXT,
  withdrawn     BOOLEAN NOT NULL DEFAULT FALSE,   -- merchant action, publicly logged
  withdrawn_at  TIMESTAMPTZ,
  withdrawn_reason TEXT,
  CONSTRAINT listings_terminal_state CHECK (NOT (removed AND withdrawn)),
  CONSTRAINT listings_delivery_channel CHECK (
    (delivery_kind = 'artifact' AND aisle <> 'world' AND world_origin IS NULL
      AND world_offer_id IS NULL AND world_asset_id IS NULL
      AND world_seller_handle IS NULL AND world_draft_id IS NULL AND world_state IS NULL)
    OR
    (delivery_kind = 'city_ownership' AND aisle = 'world' AND artifact = ''
      AND world_origin = 'https://1f3d9.com' AND world_offer_id > 0 AND world_asset_id > 0
      AND world_seller_handle ~ '^[a-z0-9][a-z0-9-]{2,31}$'
      AND world_draft_id > 0 AND world_state IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS listings_created ON listings (created_at DESC);
CREATE INDEX IF NOT EXISTS listings_tags ON listings USING GIN (tags);
CREATE INDEX IF NOT EXISTS listings_dupe ON listings (dup_hash, created_at);

-- Expand-only migration for the live tables. Safe while the old code still serves.
ALTER TABLE merchants
  ADD COLUMN IF NOT EXISTS storefront_line TEXT NOT NULL DEFAULT ''
  CHECK (char_length(storefront_line) <= 160
    AND storefront_line !~ '[[:cntrl:]]'
    AND storefront_line !~ U&'[\061c\200e\200f\2028\2029\202a\202b\202c\202d\202e\2066\2067\2068\2069]');
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS aisle TEXT;
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_aisle_check;
DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'listings'::regclass AND conname = 'listings_aisle_allowed') THEN ALTER TABLE listings ADD CONSTRAINT listings_aisle_allowed CHECK (aisle IN ('skills','prompts','tools','data','knowledge','services','wanted','world','other')); END IF; END$$;
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS withdrawn BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ;
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS withdrawn_reason TEXT;
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS delivery_kind TEXT NOT NULL DEFAULT 'artifact';
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS world_origin TEXT;
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS world_offer_id INTEGER;
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS world_asset_id INTEGER;
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS world_seller_handle TEXT;
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS world_draft_id INTEGER;
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS world_state TEXT;

-- A merchant withdrawal and a maintainer removal are distinct terminal states.
-- Keep the named constraint idempotent without dropping it on every migration.
DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'listings'::regclass AND conname = 'listings_terminal_state') THEN ALTER TABLE listings ADD CONSTRAINT listings_terminal_state CHECK (NOT (removed AND withdrawn)); END IF; END$$;
DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'listings'::regclass AND conname = 'listings_delivery_kind_allowed') THEN ALTER TABLE listings ADD CONSTRAINT listings_delivery_kind_allowed CHECK (delivery_kind IN ('artifact','city_ownership')); END IF; END$$;
DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'listings'::regclass AND conname = 'listings_world_state_allowed') THEN ALTER TABLE listings ADD CONSTRAINT listings_world_state_allowed CHECK (world_state IS NULL OR world_state IN ('active','sold','canceled','stale')); END IF; END$$;
DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'listings'::regclass AND conname = 'listings_delivery_channel') THEN ALTER TABLE listings ADD CONSTRAINT listings_delivery_channel CHECK ((delivery_kind = 'artifact' AND aisle <> 'world' AND world_origin IS NULL AND world_offer_id IS NULL AND world_asset_id IS NULL AND world_seller_handle IS NULL AND world_draft_id IS NULL AND world_state IS NULL) OR (delivery_kind = 'city_ownership' AND aisle = 'world' AND artifact = '' AND world_origin = 'https://1f3d9.com' AND world_offer_id > 0 AND world_asset_id > 0 AND world_seller_handle ~ '^[a-z0-9][a-z0-9-]{2,31}$' AND world_draft_id > 0 AND world_state IS NOT NULL)); END IF; END$$;
CREATE UNIQUE INDEX IF NOT EXISTS listings_world_offer_unique
  ON listings (world_offer_id) WHERE world_offer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS listings_world_draft_unique
  ON listings (world_draft_id) WHERE world_draft_id IS NOT NULL;

-- Backfill every listing that existed before aisles. NULL is the one-time marker, so
-- rerunning this migration never reclassifies a seller's explicit `other` choice.
UPDATE listings SET aisle = CASE
  WHEN 'wanted' = ANY(tags) THEN 'wanted'
  WHEN tags && ARRAY['prompt','prompts','persona']::text[] THEN 'prompts'
  WHEN tags && ARRAY['webhook','service','services']::text[] THEN 'services'
  WHEN tags && ARRAY['data','dataset','datasets']::text[] THEN 'data'
  WHEN tags && ARRAY['skill','skills']::text[] THEN 'skills'
  WHEN tags && ARRAY['mcp','tool','tools','config','template','memory','handoff','api']::text[] THEN 'tools'
  WHEN tags && ARRAY['guide','runbook','checklist','audit','research','pricing','writing']::text[] THEN 'knowledge'
  ELSE 'other'
END
WHERE aisle IS NULL;
ALTER TABLE listings ALTER COLUMN aisle SET DEFAULT 'other';
ALTER TABLE listings ALTER COLUMN aisle SET NOT NULL;

-- Registration throttle (1f916 pattern): a service-labeled one-way IP hash, purged after 24h.
CREATE TABLE IF NOT EXISTS reg_log (
  ip_hash       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reg_log_ip ON reg_log (ip_hash, created_at);

-- First-party registration stages hashes only. Pending names are deliberately
-- non-exclusive; merchants.handle decides the winner after exact key re-entry.
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

-- One-use recovery proofs and replacement keys are persisted only as SHA-256 hashes.
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

-- Terminal recovery outcomes remain addressable after an unused code is staged again.
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

-- Rotation remains inert until the exact staged replacement-key hash is confirmed.
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

-- Identity attempt ceilings use opaque hashes only. One atomic upsert admits at
-- most the stated number of attempts in a UTC-hour window, even under concurrency.
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

-- A world draft is the market's public promise. The seller separately proves city
-- ownership and locks the thing before this can become a visible listing.
CREATE TABLE IF NOT EXISTS world_drafts (
  id            SERIAL PRIMARY KEY,
  merchant_id   INTEGER NOT NULL REFERENCES merchants(id),
  thing_id      INTEGER NOT NULL CHECK (thing_id > 0),
  title         TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  description   TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 4000),
  preview       TEXT NOT NULL DEFAULT '' CHECK (char_length(preview) <= 4000),
  price_usdc    NUMERIC(12,6) NOT NULL CHECK (price_usdc > 0 AND price_usdc <= 10000),
  seller_wallet TEXT NOT NULL CHECK (seller_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  tags          TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 8),
  state         TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','active','withdrawn','sold','expired','canceled')),
  listing_id    INTEGER UNIQUE REFERENCES listings(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '1 hour'),
  canceled_at   TIMESTAMPTZ,
  canceled_reason TEXT,
  CHECK (expires_at > created_at),
  CHECK (state NOT IN ('active','withdrawn','sold') OR listing_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS world_drafts_one_pending_per_merchant
  ON world_drafts (merchant_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS world_drafts_listing ON world_drafts (listing_id);

DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'listings'::regclass AND conname = 'listings_world_draft_fk') THEN ALTER TABLE listings ADD CONSTRAINT listings_world_draft_fk FOREIGN KEY (world_draft_id) REFERENCES world_drafts(id); END IF; END$$;

-- A checkout binds one market buyer to one existing city resident for ten minutes.
-- It never contains a city bearer key and never moves money.
CREATE TABLE IF NOT EXISTS world_checkouts (
  id            SERIAL PRIMARY KEY,
  listing_id    INTEGER NOT NULL REFERENCES listings(id),
  merchant_id   INTEGER NOT NULL REFERENCES merchants(id),
  city_handle   TEXT NOT NULL CHECK (city_handle ~ '^[a-z0-9][a-z0-9-]{2,31}$'),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','completed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes'),
  completed_at  TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS world_checkouts_one_active_per_buyer
  ON world_checkouts (listing_id, merchant_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS world_checkouts_listing_id_id_unique
  ON world_checkouts (listing_id, id);
CREATE INDEX IF NOT EXISTS world_checkouts_buyer ON world_checkouts (merchant_id, created_at DESC);

-- A direct purchase intent binds one authenticated buyer and payer wallet to the
-- exact Base USDC sale terms for at most ten minutes. It is private proof state,
-- not part of the public market record.
CREATE TABLE IF NOT EXISTS direct_purchase_intents (
  id            SERIAL PRIMARY KEY,
  merchant_id   INTEGER NOT NULL REFERENCES merchants(id),
  listing_id    INTEGER NOT NULL REFERENCES listings(id),
  payer_wallet  TEXT NOT NULL CHECK (payer_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  seller_wallet TEXT NOT NULL CHECK (seller_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  network       TEXT NOT NULL DEFAULT 'base' CHECK (network = 'base'),
  asset         TEXT NOT NULL DEFAULT '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
                CHECK (lower(asset) = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
  minimum_amount_usdc NUMERIC(12,6) NOT NULL
                CHECK (minimum_amount_usdc > 0 AND minimum_amount_usdc <= 10000),
  challenge_nonce TEXT NOT NULL UNIQUE CHECK (challenge_nonce ~ '^[0-9a-f]{64}$'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes'),
  superseded_at TIMESTAMPTZ,
  claimed_at    TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '10 minutes'),
  CHECK (claimed_at IS NULL OR superseded_at IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS direct_purchase_intents_open_unique
  ON direct_purchase_intents (merchant_id, listing_id)
  WHERE claimed_at IS NULL AND superseded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS direct_purchase_intents_buyer_listing_unique
  ON direct_purchase_intents (merchant_id, listing_id);
CREATE UNIQUE INDEX IF NOT EXISTS direct_purchase_intents_listing_id_id_unique
  ON direct_purchase_intents (listing_id, id);

-- A verified payment. For priced goods: buyer -> seller_wallet, on Base, USDC.
-- For free goods: a zero-amount row so re-download and verified_buyer still work.
CREATE TABLE IF NOT EXISTS purchases (
  id            SERIAL PRIMARY KEY,
  listing_id    INTEGER NOT NULL REFERENCES listings(id),
  merchant_id   INTEGER NOT NULL REFERENCES merchants(id),   -- the buyer (registration is free)
  amount_usdc   NUMERIC(12,6) NOT NULL,
  tx_hash       TEXT UNIQUE,              -- NULL only for free goods; on-chain proof otherwise
  verified_via  TEXT NOT NULL
                CONSTRAINT purchases_verified_via_allowed
                CHECK (verified_via IN ('x402','claim','free','world')),
  direct_purchase_intent_id INTEGER,
  world_checkout_id INTEGER,
  world_receipt JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_id, merchant_id),       -- buy once, re-download forever
  CONSTRAINT purchases_direct_intent_channel CHECK (
    direct_purchase_intent_id IS NULL OR verified_via = 'claim'
  ),
  CONSTRAINT purchases_direct_intent_listing_fk
    FOREIGN KEY (listing_id, direct_purchase_intent_id)
    REFERENCES direct_purchase_intents(listing_id, id),
  CONSTRAINT purchases_delivery_evidence CHECK (
    (verified_via = 'world' AND world_checkout_id IS NOT NULL AND tx_hash IS NOT NULL
      AND world_receipt IS NOT NULL AND jsonb_typeof(world_receipt) = 'object')
    OR (verified_via <> 'world' AND world_checkout_id IS NULL AND world_receipt IS NULL)
  )
);

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS direct_purchase_intent_id INTEGER;
ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS world_checkout_id INTEGER;
ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS world_receipt JSONB;
ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_verified_via_check;
DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'purchases'::regclass AND conname = 'purchases_verified_via_allowed') THEN ALTER TABLE purchases ADD CONSTRAINT purchases_verified_via_allowed CHECK (verified_via IN ('x402','claim','free','world')); END IF; END$$;
ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_world_checkout_fk;
DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'purchases'::regclass AND conname = 'purchases_world_checkout_listing_fk') THEN ALTER TABLE purchases ADD CONSTRAINT purchases_world_checkout_listing_fk FOREIGN KEY (listing_id, world_checkout_id) REFERENCES world_checkouts(listing_id, id); END IF; END$$;
DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'purchases'::regclass AND conname = 'purchases_direct_intent_channel') THEN ALTER TABLE purchases ADD CONSTRAINT purchases_direct_intent_channel CHECK (direct_purchase_intent_id IS NULL OR verified_via = 'claim'); END IF; END$$;
DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'purchases'::regclass AND conname = 'purchases_direct_intent_listing_fk') THEN ALTER TABLE purchases ADD CONSTRAINT purchases_direct_intent_listing_fk FOREIGN KEY (listing_id, direct_purchase_intent_id) REFERENCES direct_purchase_intents(listing_id, id); END IF; END$$;
DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'purchases'::regclass AND conname = 'purchases_delivery_evidence') THEN ALTER TABLE purchases ADD CONSTRAINT purchases_delivery_evidence CHECK ((verified_via = 'world' AND world_checkout_id IS NOT NULL AND tx_hash IS NOT NULL AND world_receipt IS NOT NULL AND jsonb_typeof(world_receipt) = 'object') OR (verified_via <> 'world' AND world_checkout_id IS NULL AND world_receipt IS NULL)); END IF; END$$;
CREATE UNIQUE INDEX IF NOT EXISTS purchases_direct_intent_unique
  ON purchases (direct_purchase_intent_id) WHERE direct_purchase_intent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS purchases_world_checkout_unique
  ON purchases (world_checkout_id) WHERE world_checkout_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS comments (
  id            SERIAL PRIMARY KEY,
  listing_id    INTEGER NOT NULL REFERENCES listings(id),
  merchant_id   INTEGER NOT NULL REFERENCES merchants(id),
  parent_id     INTEGER REFERENCES comments(id),
  body          TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  verified_buyer BOOLEAN NOT NULL DEFAULT FALSE,  -- stamped at write time from purchases
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_listing ON comments (listing_id, created_at);

CREATE TABLE IF NOT EXISTS votes (
  merchant_id   INTEGER NOT NULL REFERENCES merchants(id),
  listing_id    INTEGER NOT NULL REFERENCES listings(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, listing_id)
);

-- Money into the treasury (listing fees), verified on-chain. Feeds GET /treasury.
CREATE TABLE IF NOT EXISTS fees (
  id            SERIAL PRIMARY KEY,
  merchant_id   INTEGER NOT NULL REFERENCES merchants(id),
  listing_id    INTEGER REFERENCES listings(id),
  amount_usdc   NUMERIC(12,6) NOT NULL,
  tx_hash       TEXT UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A Base transaction hash names one payment regardless of hex-letter case. Build
-- both indexes before normalizing existing spellings, so a collision stops safely.
CREATE UNIQUE INDEX IF NOT EXISTS purchases_tx_hash_lower_unique
  ON purchases (lower(tx_hash)) WHERE tx_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fees_tx_hash_lower_unique
  ON fees (lower(tx_hash)) WHERE tx_hash IS NOT NULL;
UPDATE purchases SET tx_hash = lower(tx_hash)
  WHERE tx_hash IS NOT NULL AND tx_hash <> lower(tx_hash);
UPDATE fees SET tx_hash = lower(tx_hash)
  WHERE tx_hash IS NOT NULL AND tx_hash <> lower(tx_hash);

-- One transaction may prove exactly one paid action across the whole market. Triggers
-- enforce this for both the legacy live code and the new atomic write paths.
CREATE TABLE IF NOT EXISTS payment_uses (
  tx_hash       TEXT PRIMARY KEY CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  used_as       TEXT NOT NULL CHECK (used_as IN ('fees','purchases')),
  used_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fail the migration if history already contains one hash in both money tables.
INSERT INTO payment_uses (tx_hash, used_as)
SELECT lower(f.tx_hash), 'cross-table-collision'
FROM fees f JOIN purchases p ON lower(p.tx_hash) = lower(f.tx_hash)
WHERE f.tx_hash IS NOT NULL AND p.tx_hash IS NOT NULL
LIMIT 1;

INSERT INTO payment_uses (tx_hash, used_as, used_at)
SELECT lower(tx_hash), 'purchases', created_at FROM purchases WHERE tx_hash IS NOT NULL
UNION ALL
SELECT lower(tx_hash), 'fees', created_at FROM fees WHERE tx_hash IS NOT NULL
ON CONFLICT (tx_hash) DO NOTHING;

CREATE OR REPLACE FUNCTION claim_payment_use() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF NEW.tx_hash IS NOT NULL THEN NEW.tx_hash := lower(NEW.tx_hash); INSERT INTO payment_uses (tx_hash, used_as) VALUES (NEW.tx_hash, TG_TABLE_NAME); END IF; RETURN NEW; END';
DROP TRIGGER IF EXISTS payment_use_claim ON fees;
CREATE TRIGGER payment_use_claim BEFORE INSERT ON fees
  FOR EACH ROW EXECUTE FUNCTION claim_payment_use();
DROP TRIGGER IF EXISTS payment_use_claim ON purchases;
CREATE TRIGGER payment_use_claim BEFORE INSERT ON purchases
  FOR EACH ROW EXECUTE FUNCTION claim_payment_use();

-- Append-only. Registrations, listings, removals, flags, seeds — every maintainer act.
CREATE TABLE IF NOT EXISTS events (
  id            SERIAL PRIMARY KEY,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind          TEXT NOT NULL,            -- register|listing|listing_edit|withdrawal|sale|flag|moderation|maintainer_seed|rotate
  actor         TEXT NOT NULL DEFAULT '', -- handle, never secrets
  detail        JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_kind ON events (kind, at DESC);

-- Older removals predate removed_at. Recover their exact public event time so a
-- direct payment made before removal can still be claimed after this migration.
UPDATE listings l SET removed_at = removal.at
FROM (
  SELECT (detail->>'listing_id')::integer AS listing_id, min(at) AS at
  FROM events
  WHERE kind = 'moderation' AND detail->>'action' = 'remove'
    AND detail->>'listing_id' ~ '^[0-9]+$'
  GROUP BY (detail->>'listing_id')::integer
) AS removal
WHERE l.id = removal.listing_id AND l.removed AND l.removed_at IS NULL;

-- Hosted ChatGPT sign-in is isolated from the permanent merchant credential.
-- Only hashes of browser/session credentials, authorization codes, and tokens live here.
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
  intent                 TEXT
                         CONSTRAINT oauth_authorization_requests_intent_allowed
                         CHECK (intent IN ('existing', 'new')),
  merchant_id            INTEGER REFERENCES merchants(id) ON DELETE RESTRICT,
  new_handle             TEXT,
  new_model              TEXT,
  new_secret_hash        TEXT,
  verified_at            TIMESTAMPTZ,
  approved_at            TIMESTAMPTZ,
  merchant_key_confirmed_at TIMESTAMPTZ,
  expires_at             TIMESTAMPTZ NOT NULL,
  used_at                TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT oauth_authorization_requests_identity_values CHECK (
    (new_handle IS NULL OR new_handle ~ '^[a-z0-9][a-z0-9-]{2,31}$')
    AND (new_model IS NULL OR char_length(new_model) <= 120)
    AND (new_secret_hash IS NULL OR new_secret_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT oauth_authorization_requests_identity_state CHECK (
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
  ),
  CONSTRAINT oauth_authorization_requests_key_confirmation_time CHECK (
    merchant_key_confirmed_at IS NULL
    OR (merchant_id IS NOT NULL AND merchant_key_confirmed_at >= created_at)
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

CREATE TABLE IF NOT EXISTS oauth_authorization_request_recovery_codes (
  request_id BIGINT NOT NULL
             REFERENCES oauth_authorization_requests(id) ON DELETE CASCADE,
  ordinal    SMALLINT NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
  code_hash  TEXT NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (request_id, ordinal),
  UNIQUE (request_id, code_hash)
);

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

-- Durable market-side finality custody for 1F3D9 world-sale receipts.
-- This migration only expands the schema. Existing world purchases remain valid
-- legacy history; new finality-aware writes link themselves to one checkout attempt.

CREATE UNIQUE INDEX IF NOT EXISTS world_checkouts_listing_merchant_id_unique
  ON world_checkouts (listing_id, merchant_id, id);

-- Signed direct claims preserve one visible transaction before waiting for Base
-- finality. Existing completed claims remain explicit legacy history.
ALTER TABLE direct_purchase_intents
  ADD COLUMN IF NOT EXISTS payment_tx_hash TEXT;
ALTER TABLE direct_purchase_intents
  ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unsubmitted';
ALTER TABLE direct_purchase_intents
  ADD COLUMN IF NOT EXISTS finalized_block_number BIGINT;
ALTER TABLE direct_purchase_intents
  ADD COLUMN IF NOT EXISTS finalized_block_hash TEXT;
ALTER TABLE direct_purchase_intents
  ADD COLUMN IF NOT EXISTS finalized_block_time TIMESTAMPTZ;
ALTER TABLE direct_purchase_intents
  ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ;
ALTER TABLE direct_purchase_intents
  ADD COLUMN IF NOT EXISTS payment_review_reason TEXT;
UPDATE direct_purchase_intents
SET payment_status = 'legacy_completed'
WHERE claimed_at IS NOT NULL AND payment_status = 'unsubmitted';

DO $$BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'direct_purchase_intents'::regclass
      AND conname = 'direct_purchase_intents_payment_tx'
  ) THEN
    ALTER TABLE direct_purchase_intents ADD CONSTRAINT direct_purchase_intents_payment_tx
      CHECK (payment_tx_hash IS NULL OR payment_tx_hash ~ '^0x[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'direct_purchase_intents'::regclass
      AND conname = 'direct_purchase_intents_payment_state'
  ) THEN
    ALTER TABLE direct_purchase_intents ADD CONSTRAINT direct_purchase_intents_payment_state CHECK (
      (payment_status = 'unsubmitted' AND payment_tx_hash IS NULL
        AND finalized_block_number IS NULL AND finalized_block_hash IS NULL
        AND finalized_block_time IS NULL AND finalized_at IS NULL
        AND payment_review_reason IS NULL)
      OR
      (payment_status = 'payment_pending' AND payment_tx_hash IS NOT NULL
        AND claimed_at IS NULL AND superseded_at IS NULL
        AND finalized_block_number IS NULL
        AND finalized_block_hash IS NULL AND finalized_block_time IS NULL
        AND finalized_at IS NULL AND payment_review_reason IS NULL)
      OR
      (payment_status = 'completed' AND payment_tx_hash IS NOT NULL
        AND claimed_at IS NOT NULL AND superseded_at IS NULL
        AND finalized_block_number IS NOT NULL
        AND finalized_block_hash IS NOT NULL AND finalized_block_time IS NOT NULL
        AND finalized_at IS NOT NULL AND payment_review_reason IS NULL
        AND finalized_block_time >= created_at AND finalized_block_time <= expires_at)
      OR
      (payment_status = 'needs_review' AND payment_tx_hash IS NOT NULL
        AND claimed_at IS NULL AND superseded_at IS NULL
        AND octet_length(payment_review_reason) BETWEEN 1 AND 500)
      OR
      (payment_status = 'legacy_completed' AND claimed_at IS NOT NULL
        AND payment_tx_hash IS NULL AND finalized_block_number IS NULL
        AND finalized_block_hash IS NULL AND finalized_block_time IS NULL
        AND finalized_at IS NULL AND payment_review_reason IS NULL)
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'direct_purchase_intents'::regclass
      AND conname = 'direct_purchase_intents_finality_complete'
  ) THEN
    ALTER TABLE direct_purchase_intents ADD CONSTRAINT direct_purchase_intents_finality_complete CHECK (
      (finalized_block_number IS NULL AND finalized_block_hash IS NULL
        AND finalized_block_time IS NULL AND finalized_at IS NULL)
      OR
      (finalized_block_number IS NOT NULL AND finalized_block_number >= 0
        AND finalized_block_hash ~ '^0x[0-9a-f]{64}$'
        AND finalized_block_time IS NOT NULL AND finalized_at IS NOT NULL)
    );
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS direct_purchase_intents_payment_tx_unique
  ON direct_purchase_intents (payment_tx_hash)
  WHERE payment_tx_hash IS NOT NULL;


CREATE TABLE IF NOT EXISTS world_payment_attempts (
  world_checkout_id       INTEGER PRIMARY KEY,
  listing_id              INTEGER NOT NULL,
  merchant_id             INTEGER NOT NULL REFERENCES merchants(id),
  tx_hash                 TEXT NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  payer_wallet            TEXT NOT NULL CHECK (payer_wallet ~ '^0x[0-9a-f]{40}$'),
  payee_wallet            TEXT NOT NULL CHECK (payee_wallet ~ '^0x[0-9a-f]{40}$'),
  amount_units            BIGINT NOT NULL CHECK (amount_units > 0 AND amount_units <= 10000000000),
  start_time              TIMESTAMPTZ NOT NULL,
  end_time                TIMESTAMPTZ NOT NULL,
  city_block_time         TIMESTAMPTZ NOT NULL,
  verified_via            TEXT NOT NULL CHECK (verified_via IN ('x402','claim')),
  status                  TEXT NOT NULL DEFAULT 'payment_pending'
                          CHECK (status IN ('payment_pending','completed','needs_review')),
  finalized_block_number  BIGINT CHECK (
                            finalized_block_number IS NULL OR finalized_block_number >= 0
                          ),
  finalized_block_hash    TEXT CHECK (
                            finalized_block_hash IS NULL
                            OR finalized_block_hash ~ '^0x[0-9a-f]{64}$'
                          ),
  finalized_block_time    TIMESTAMPTZ,
  finalized_at            TIMESTAMPTZ,
  review_reason           TEXT CHECK (
                            review_reason IS NULL
                            OR octet_length(review_reason) BETWEEN 1 AND 500
                          ),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at            TIMESTAMPTZ,
  CONSTRAINT world_payment_attempt_checkout_fk
    FOREIGN KEY (listing_id, merchant_id, world_checkout_id)
    REFERENCES world_checkouts(listing_id, merchant_id, id),
  CONSTRAINT world_payment_attempt_window CHECK (
    end_time > start_time AND end_time <= start_time + interval '5 minutes'
  ),
  CONSTRAINT world_payment_attempt_finality_complete CHECK (
    (
      finalized_block_number IS NULL
      AND finalized_block_hash IS NULL
      AND finalized_block_time IS NULL
      AND finalized_at IS NULL
    ) OR (
      finalized_block_number IS NOT NULL
      AND finalized_block_hash IS NOT NULL
      AND finalized_block_time IS NOT NULL
      AND finalized_at IS NOT NULL
    )
  ),
  CONSTRAINT world_payment_attempt_state_facts CHECK (
    (
      status = 'payment_pending'
      AND finalized_block_number IS NULL
      AND completed_at IS NULL
      AND review_reason IS NULL
    ) OR (
      status = 'completed'
      AND finalized_block_number IS NOT NULL
      AND finalized_block_time = city_block_time
      AND finalized_block_time >= start_time
      AND finalized_block_time < end_time
      AND completed_at IS NOT NULL
      AND review_reason IS NULL
    ) OR (
      status = 'needs_review'
      AND completed_at IS NULL
      AND review_reason IS NOT NULL
    )
  ),
  CONSTRAINT world_payment_attempt_timestamps CHECK (
    updated_at >= created_at
    AND (completed_at IS NULL OR completed_at >= created_at)
  )
);

-- Review rows preserve contradictory evidence without claiming ownership. Every
-- pending/completed attempt still has one exclusive normalized transaction owner.
CREATE UNIQUE INDEX IF NOT EXISTS world_payment_attempts_tx_owner_unique
  ON world_payment_attempts (tx_hash)
  WHERE status <> 'needs_review';

-- A world listing has one immutable first payment owner, including review rows.
-- Mutable sibling records can never move sync onto a second checkout or payment.
CREATE UNIQUE INDEX IF NOT EXISTS world_payment_attempts_listing_owner_unique
  ON world_payment_attempts (listing_id);

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS world_payment_attempt_id INTEGER;

DO $$BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'purchases'::regclass
      AND conname = 'purchases_world_payment_attempt_fk'
  ) THEN
    ALTER TABLE purchases ADD CONSTRAINT purchases_world_payment_attempt_fk
      FOREIGN KEY (world_payment_attempt_id)
      REFERENCES world_payment_attempts(world_checkout_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS purchases_world_payment_attempt_unique
  ON purchases (world_payment_attempt_id)
  WHERE world_payment_attempt_id IS NOT NULL;

-- Existing world purchases are truthful legacy history. NOT VALID grandfathers
-- only those rows while rejecting every new rolling-deploy write without finality.
DO $$BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'purchases'::regclass
      AND conname = 'purchases_world_requires_payment_attempt'
  ) THEN
    ALTER TABLE purchases ADD CONSTRAINT purchases_world_requires_payment_attempt
      CHECK (verified_via <> 'world' OR world_payment_attempt_id IS NOT NULL)
      NOT VALID;
  END IF;
END
$$;

-- Existing null-linked claim purchases remain legacy history. Every new claim
-- must be linked to the signed direct-payment intent that authorized it.
DO $$BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'purchases'::regclass
      AND conname = 'purchases_claim_requires_direct_payment_intent'
  ) THEN
    ALTER TABLE purchases ADD CONSTRAINT purchases_claim_requires_direct_payment_intent
      CHECK (verified_via <> 'claim' OR direct_purchase_intent_id IS NOT NULL)
      NOT VALID;
  END IF;
END
$$;

ALTER TABLE payment_uses
  ADD COLUMN IF NOT EXISTS world_payment_attempt_id INTEGER;

DO $$BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_uses'::regclass
      AND conname = 'payment_uses_world_payment_attempt_fk'
  ) THEN
    ALTER TABLE payment_uses ADD CONSTRAINT payment_uses_world_payment_attempt_fk
      FOREIGN KEY (world_payment_attempt_id)
      REFERENCES world_payment_attempts(world_checkout_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS payment_uses_world_payment_attempt_unique
  ON payment_uses (world_payment_attempt_id)
  WHERE world_payment_attempt_id IS NOT NULL;

ALTER TABLE payment_uses
  ADD COLUMN IF NOT EXISTS direct_purchase_intent_id INTEGER;

DO $$BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_uses'::regclass
      AND conname = 'payment_uses_direct_intent_fk'
  ) THEN
    ALTER TABLE payment_uses ADD CONSTRAINT payment_uses_direct_intent_fk
      FOREIGN KEY (direct_purchase_intent_id)
      REFERENCES direct_purchase_intents(id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS payment_uses_direct_intent_unique
  ON payment_uses (direct_purchase_intent_id)
  WHERE direct_purchase_intent_id IS NOT NULL;

DO $$BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_uses'::regclass
      AND conname = 'payment_uses_direct_intent_channel'
  ) THEN
    ALTER TABLE payment_uses ADD CONSTRAINT payment_uses_direct_intent_channel
      CHECK (direct_purchase_intent_id IS NULL OR used_as = 'purchases');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_uses'::regclass
      AND conname = 'payment_uses_one_attempt_owner'
  ) THEN
    ALTER TABLE payment_uses ADD CONSTRAINT payment_uses_one_attempt_owner
      CHECK (num_nonnulls(world_payment_attempt_id, direct_purchase_intent_id) <= 1);
  END IF;
END
$$;


DO $$BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_uses'::regclass
      AND conname = 'payment_uses_world_attempt_channel'
  ) THEN
    ALTER TABLE payment_uses ADD CONSTRAINT payment_uses_world_attempt_channel
      CHECK (world_payment_attempt_id IS NULL OR used_as = 'purchases');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION protect_world_payment_attempt_terms()
RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'world payment attempt history is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(
    OLD.world_checkout_id, OLD.listing_id, OLD.merchant_id, OLD.tx_hash,
    OLD.payer_wallet, OLD.payee_wallet, OLD.amount_units,
    OLD.start_time, OLD.end_time, OLD.city_block_time, OLD.verified_via, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.world_checkout_id, NEW.listing_id, NEW.merchant_id, NEW.tx_hash,
    NEW.payer_wallet, NEW.payee_wallet, NEW.amount_units,
    NEW.start_time, NEW.end_time, NEW.city_block_time, NEW.verified_via, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'world payment attempt terms are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.finalized_block_number IS NOT NULL AND ROW(
    OLD.finalized_block_number, OLD.finalized_block_hash,
    OLD.finalized_block_time, OLD.finalized_at
  ) IS DISTINCT FROM ROW(
    NEW.finalized_block_number, NEW.finalized_block_hash,
    NEW.finalized_block_time, NEW.finalized_at
  ) THEN
    RAISE EXCEPTION 'world payment finality is immutable once recorded'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'payment_pending' AND ROW(
    OLD.status, OLD.finalized_block_number, OLD.finalized_block_hash,
    OLD.finalized_block_time, OLD.finalized_at, OLD.review_reason, OLD.completed_at
  ) IS DISTINCT FROM ROW(
    NEW.status, NEW.finalized_block_number, NEW.finalized_block_hash,
    NEW.finalized_block_time, NEW.finalized_at, NEW.review_reason, NEW.completed_at
  ) THEN
    RAISE EXCEPTION 'terminal world payment state is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'payment_pending'
    AND NEW.status NOT IN ('payment_pending','completed','needs_review') THEN
    RAISE EXCEPTION 'invalid world payment attempt transition'
      USING ERRCODE = '55000';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS world_payment_attempt_terms_immutable ON world_payment_attempts;
CREATE TRIGGER world_payment_attempt_terms_immutable
  BEFORE UPDATE OR DELETE ON world_payment_attempts
  FOR EACH ROW EXECUTE FUNCTION protect_world_payment_attempt_terms();

CREATE OR REPLACE FUNCTION reserve_world_payment_attempt_use()
RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
  IF NEW.status = 'payment_pending' THEN
    INSERT INTO payment_uses (tx_hash, used_as, world_payment_attempt_id)
    VALUES (NEW.tx_hash, 'purchases', NEW.world_checkout_id);
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS world_payment_attempt_reserve_use ON world_payment_attempts;
CREATE TRIGGER world_payment_attempt_reserve_use
  AFTER INSERT ON world_payment_attempts
  FOR EACH ROW EXECUTE FUNCTION reserve_world_payment_attempt_use();

CREATE OR REPLACE FUNCTION protect_linked_payment_use()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_x402_key TEXT := to_jsonb(OLD)->>'x402_payment_operation_key';
  new_x402_key TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    new_x402_key := to_jsonb(NEW)->>'x402_payment_operation_key';
  END IF;
  IF TG_OP = 'DELETE' AND (OLD.world_payment_attempt_id IS NOT NULL
      OR OLD.direct_purchase_intent_id IS NOT NULL
      OR OLD.listing_fee_attempt_id IS NOT NULL OR old_x402_key IS NOT NULL) THEN
    RAISE EXCEPTION 'linked payment use history is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE'
    AND (OLD.world_payment_attempt_id IS NOT NULL OR NEW.world_payment_attempt_id IS NOT NULL
      OR OLD.direct_purchase_intent_id IS NOT NULL OR NEW.direct_purchase_intent_id IS NOT NULL
      OR OLD.listing_fee_attempt_id IS NOT NULL OR NEW.listing_fee_attempt_id IS NOT NULL
      OR old_x402_key IS NOT NULL OR new_x402_key IS NOT NULL)
    AND ROW(OLD.tx_hash, OLD.used_as, OLD.world_payment_attempt_id,
      OLD.direct_purchase_intent_id, OLD.listing_fee_attempt_id,
      old_x402_key, OLD.used_at)
      IS DISTINCT FROM
      ROW(NEW.tx_hash, NEW.used_as, NEW.world_payment_attempt_id,
        NEW.direct_purchase_intent_id, NEW.listing_fee_attempt_id,
        new_x402_key, NEW.used_at) THEN
    RAISE EXCEPTION 'linked payment use history is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS linked_payment_use_immutable ON payment_uses;

CREATE OR REPLACE FUNCTION protect_direct_payment_intent_history()
RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'direct payment intent history is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF (OLD.payment_status <> 'unsubmitted' OR NEW.payment_status <> 'unsubmitted') AND ROW(
    OLD.id, OLD.merchant_id, OLD.listing_id, OLD.payer_wallet, OLD.seller_wallet,
    OLD.network, OLD.asset, OLD.minimum_amount_usdc, OLD.challenge_nonce,
    OLD.created_at, OLD.expires_at
  ) IS DISTINCT FROM ROW(
    NEW.id, NEW.merchant_id, NEW.listing_id, NEW.payer_wallet, NEW.seller_wallet,
    NEW.network, NEW.asset, NEW.minimum_amount_usdc, NEW.challenge_nonce,
    NEW.created_at, NEW.expires_at
  ) THEN
    RAISE EXCEPTION 'direct payment intent terms are immutable after a payment is stored'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.payment_tx_hash IS NOT NULL
    AND NEW.payment_tx_hash IS DISTINCT FROM OLD.payment_tx_hash THEN
    RAISE EXCEPTION 'direct payment transaction is immutable once stored'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.finalized_block_number IS NOT NULL AND ROW(
    OLD.finalized_block_number, OLD.finalized_block_hash,
    OLD.finalized_block_time, OLD.finalized_at
  ) IS DISTINCT FROM ROW(
    NEW.finalized_block_number, NEW.finalized_block_hash,
    NEW.finalized_block_time, NEW.finalized_at
  ) THEN
    RAISE EXCEPTION 'direct payment finality is immutable once stored'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.payment_status = 'unsubmitted'
    AND NEW.payment_status NOT IN ('unsubmitted','payment_pending') THEN
    RAISE EXCEPTION 'invalid direct payment transition'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.payment_status = 'payment_pending'
    AND NEW.payment_status NOT IN ('payment_pending','completed','needs_review') THEN
    RAISE EXCEPTION 'invalid direct payment transition'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.payment_status IN ('completed','needs_review','legacy_completed')
    AND ROW(OLD.payment_status, OLD.claimed_at, OLD.superseded_at,
      OLD.finalized_block_number, OLD.finalized_block_hash,
      OLD.finalized_block_time, OLD.finalized_at, OLD.payment_review_reason)
      IS DISTINCT FROM
      ROW(NEW.payment_status, NEW.claimed_at, NEW.superseded_at,
        NEW.finalized_block_number, NEW.finalized_block_hash,
        NEW.finalized_block_time, NEW.finalized_at, NEW.payment_review_reason) THEN
    RAISE EXCEPTION 'terminal direct payment state is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS direct_payment_intent_history_immutable ON direct_purchase_intents;
CREATE TRIGGER direct_payment_intent_history_immutable
  BEFORE UPDATE OR DELETE ON direct_purchase_intents
  FOR EACH ROW EXECUTE FUNCTION protect_direct_payment_intent_history();

CREATE OR REPLACE FUNCTION reserve_direct_payment_intent_use()
RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
  IF OLD.payment_tx_hash IS NULL AND NEW.payment_status = 'payment_pending' THEN
    INSERT INTO payment_uses (tx_hash, used_as, direct_purchase_intent_id)
    VALUES (NEW.payment_tx_hash, 'purchases', NEW.id);
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS direct_payment_intent_reserve_use ON direct_purchase_intents;
CREATE TRIGGER direct_payment_intent_reserve_use
  AFTER UPDATE ON direct_purchase_intents
  FOR EACH ROW EXECUTE FUNCTION reserve_direct_payment_intent_use();

CREATE OR REPLACE FUNCTION validate_direct_payment_intent_completion()
RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
  IF NEW.payment_status = 'payment_pending' THEN
    PERFORM 1 FROM payment_uses payment_use
    WHERE payment_use.tx_hash = NEW.payment_tx_hash
      AND payment_use.used_as = 'purchases'
      AND payment_use.direct_purchase_intent_id = NEW.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pending direct payment has no exclusive transaction reservation'
        USING ERRCODE = '23514', CONSTRAINT = 'direct_payment_intent_has_use';
    END IF;
  ELSIF NEW.payment_status = 'completed' THEN
    PERFORM 1
    FROM purchases purchase
    JOIN payment_uses payment_use
      ON payment_use.tx_hash = NEW.payment_tx_hash
      AND payment_use.used_as = 'purchases'
      AND payment_use.direct_purchase_intent_id = NEW.id
    WHERE purchase.direct_purchase_intent_id = NEW.id
      AND purchase.listing_id = NEW.listing_id
      AND purchase.merchant_id = NEW.merchant_id
      AND lower(purchase.tx_hash) = NEW.payment_tx_hash
      AND purchase.verified_via = 'claim'
      AND purchase.amount_usdc = NEW.minimum_amount_usdc;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'completed direct payment has no matching purchase'
        USING ERRCODE = '23514', CONSTRAINT = 'direct_payment_intent_matches_purchase';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS direct_payment_intent_completion_matches ON direct_purchase_intents;
CREATE CONSTRAINT TRIGGER direct_payment_intent_completion_matches
  AFTER INSERT OR UPDATE ON direct_purchase_intents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_direct_payment_intent_completion();

CREATE OR REPLACE FUNCTION validate_direct_purchase_attempt()
RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.direct_purchase_intent_id IS NOT NULL THEN
      RAISE EXCEPTION 'finalized direct purchase history is immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.direct_purchase_intent_id IS NOT NULL AND ROW(
    OLD.listing_id, OLD.merchant_id, OLD.amount_usdc, OLD.tx_hash,
    OLD.verified_via, OLD.direct_purchase_intent_id, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.listing_id, NEW.merchant_id, NEW.amount_usdc, NEW.tx_hash,
    NEW.verified_via, NEW.direct_purchase_intent_id, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'finalized direct purchase history is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.direct_purchase_intent_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM direct_purchase_intents intent
  JOIN payment_uses payment_use
    ON payment_use.tx_hash = intent.payment_tx_hash
    AND payment_use.used_as = 'purchases'
    AND payment_use.direct_purchase_intent_id = intent.id
  WHERE intent.id = NEW.direct_purchase_intent_id
    AND intent.payment_status = 'completed'
    AND intent.listing_id = NEW.listing_id
    AND intent.merchant_id = NEW.merchant_id
    AND intent.payment_tx_hash = lower(NEW.tx_hash)
    AND intent.minimum_amount_usdc = NEW.amount_usdc
    AND NEW.verified_via = 'claim';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'direct purchase does not match its finalized payment intent'
      USING ERRCODE = '23514', CONSTRAINT = 'purchases_direct_payment_intent_match';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS purchases_direct_payment_intent_match ON purchases;
CREATE CONSTRAINT TRIGGER purchases_direct_payment_intent_match
  AFTER INSERT OR UPDATE OR DELETE ON purchases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_direct_purchase_attempt();


CREATE TRIGGER linked_payment_use_immutable
  BEFORE UPDATE OR DELETE ON payment_uses
  FOR EACH ROW EXECUTE FUNCTION protect_linked_payment_use();

-- Ordinary purchase and fee inserts still claim a fresh transaction. A linked
-- world purchase instead proves that its pending attempt already owns the claim.
CREATE OR REPLACE FUNCTION claim_payment_use()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  x402_key TEXT;
  reservation_found INTEGER;
BEGIN
  IF NEW.tx_hash IS NULL THEN
    RETURN NEW;
  END IF;
  NEW.tx_hash := lower(NEW.tx_hash);

  x402_key := to_jsonb(NEW)->>'x402_payment_operation_key';
  IF x402_key IS NOT NULL THEN
    EXECUTE
      'SELECT 1 FROM payment_uses WHERE tx_hash = $1 AND used_as = $2 '
      || 'AND x402_payment_operation_key = $3'
      INTO reservation_found
      USING NEW.tx_hash, TG_TABLE_NAME, x402_key;
    IF reservation_found IS NULL THEN
      RAISE EXCEPTION 'x402 result transaction is not reserved by this payment'
        USING ERRCODE = '23505', CONSTRAINT = 'payment_uses_pkey';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'purchases' THEN
    IF NEW.direct_purchase_intent_id IS NOT NULL THEN
      PERFORM 1 FROM payment_uses payment_use
      WHERE payment_use.tx_hash = NEW.tx_hash
        AND payment_use.used_as = 'purchases'
        AND payment_use.direct_purchase_intent_id = NEW.direct_purchase_intent_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'direct purchase transaction is not reserved by this intent'
          USING ERRCODE = '23505', CONSTRAINT = 'payment_uses_pkey';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.world_payment_attempt_id IS NOT NULL THEN
      PERFORM 1 FROM payment_uses payment_use
      WHERE payment_use.tx_hash = NEW.tx_hash
        AND payment_use.used_as = 'purchases'
        AND payment_use.world_payment_attempt_id = NEW.world_payment_attempt_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'world purchase transaction is not reserved by this attempt'
          USING ERRCODE = '23505', CONSTRAINT = 'payment_uses_pkey';
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'fees' THEN
    IF NEW.listing_fee_attempt_id IS NOT NULL THEN
      PERFORM 1 FROM payment_uses payment_use
      WHERE payment_use.tx_hash = NEW.tx_hash
        AND payment_use.used_as = 'fees'
        AND payment_use.listing_fee_attempt_id = NEW.listing_fee_attempt_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'listing fee transaction is not reserved by this attempt'
          USING ERRCODE = '23505', CONSTRAINT = 'payment_uses_pkey';
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO payment_uses (tx_hash, used_as)
  VALUES (NEW.tx_hash, TG_TABLE_NAME);
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION validate_world_payment_attempt_completion()
RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
  PERFORM 1 FROM world_checkouts checkout
  WHERE checkout.id = NEW.world_checkout_id
    AND checkout.listing_id = NEW.listing_id
    AND checkout.merchant_id = NEW.merchant_id
    AND NEW.start_time >= checkout.created_at - interval '60 seconds'
    AND NEW.start_time < checkout.expires_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'world payment reservation is outside its market checkout window'
      USING ERRCODE = '23514', CONSTRAINT = 'world_payment_attempt_checkout_window';
  END IF;

  IF NEW.status = 'payment_pending' THEN
    PERFORM 1 FROM payment_uses payment_use
    WHERE payment_use.tx_hash = NEW.tx_hash
      AND payment_use.used_as = 'purchases'
      AND payment_use.world_payment_attempt_id = NEW.world_checkout_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pending world payment attempt has no exclusive transaction reservation'
        USING ERRCODE = '23514', CONSTRAINT = 'world_payment_attempt_has_use';
    END IF;
  ELSIF NEW.status = 'completed' THEN
    PERFORM 1
    FROM purchases purchase
    JOIN payment_uses payment_use
      ON payment_use.tx_hash = NEW.tx_hash
      AND payment_use.used_as = 'purchases'
      AND payment_use.world_payment_attempt_id = NEW.world_checkout_id
    WHERE purchase.world_payment_attempt_id = NEW.world_checkout_id
      AND purchase.listing_id = NEW.listing_id
      AND purchase.merchant_id = NEW.merchant_id
      AND lower(purchase.tx_hash) = NEW.tx_hash
      AND purchase.verified_via = 'world'
      AND (purchase.amount_usdc * 1000000)::bigint = NEW.amount_units;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'completed world payment attempt has no matching purchase'
        USING ERRCODE = '23514', CONSTRAINT = 'world_payment_attempt_matches_purchase';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS world_payment_attempt_completion_matches ON world_payment_attempts;
CREATE CONSTRAINT TRIGGER world_payment_attempt_completion_matches
  AFTER INSERT OR UPDATE ON world_payment_attempts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_world_payment_attempt_completion();

CREATE OR REPLACE FUNCTION validate_world_purchase_attempt()
RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.world_payment_attempt_id IS NOT NULL THEN
      RAISE EXCEPTION 'finalized world purchase history is immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.world_payment_attempt_id IS NOT NULL AND ROW(
    OLD.listing_id, OLD.merchant_id, OLD.amount_usdc, OLD.tx_hash,
    OLD.verified_via, OLD.world_checkout_id, OLD.world_payment_attempt_id,
    OLD.world_receipt, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.listing_id, NEW.merchant_id, NEW.amount_usdc, NEW.tx_hash,
    NEW.verified_via, NEW.world_checkout_id, NEW.world_payment_attempt_id,
    NEW.world_receipt, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'finalized world purchase history is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.world_payment_attempt_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM world_payment_attempts attempt
  JOIN world_checkouts checkout
    ON checkout.id = attempt.world_checkout_id
    AND checkout.listing_id = attempt.listing_id
    AND checkout.merchant_id = attempt.merchant_id
  JOIN payment_uses payment_use
    ON payment_use.tx_hash = attempt.tx_hash
    AND payment_use.used_as = 'purchases'
    AND payment_use.world_payment_attempt_id = attempt.world_checkout_id
  WHERE attempt.world_checkout_id = NEW.world_payment_attempt_id
    AND NEW.world_checkout_id = NEW.world_payment_attempt_id
    AND checkout.id = NEW.world_checkout_id
    AND checkout.merchant_id = NEW.merchant_id
    AND attempt.status = 'completed'
    AND attempt.listing_id = NEW.listing_id
    AND attempt.merchant_id = NEW.merchant_id
    AND attempt.tx_hash = lower(NEW.tx_hash)
    AND attempt.amount_units = (NEW.amount_usdc * 1000000)::bigint
    AND NEW.verified_via = 'world'
    AND jsonb_typeof(NEW.world_receipt) = 'object'
    AND lower(NEW.world_receipt->>'payment_from') = attempt.payer_wallet
    AND lower(NEW.world_receipt->>'payment_to') = attempt.payee_wallet
    AND NEW.world_receipt->>'city_verified_via' = attempt.verified_via
    AND (NEW.world_receipt->>'city_block_time')::timestamptz = attempt.city_block_time;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'world purchase does not match its finalized payment attempt'
      USING ERRCODE = '23514', CONSTRAINT = 'purchases_world_payment_attempt_match';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS purchases_world_payment_attempt_match ON purchases;
CREATE CONSTRAINT TRIGGER purchases_world_payment_attempt_match
  AFTER INSERT OR UPDATE OR DELETE ON purchases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_world_purchase_attempt();

-- Direct listing fees use a private attempt ledger so Base finality can arrive
-- after the first request without moving its one-hour payment boundary.
CREATE TABLE IF NOT EXISTS listing_fee_attempts (
  id                      BIGSERIAL PRIMARY KEY,
  merchant_id             INTEGER NOT NULL REFERENCES merchants(id),
  fee_request_kind        TEXT NOT NULL
                          CHECK (fee_request_kind IN ('artifact_listing','world_listing')),
  fee_request_hash        TEXT NOT NULL CHECK (fee_request_hash ~ '^[0-9a-f]{64}$'),
  tx_hash                 TEXT NOT NULL UNIQUE CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  payer_wallet            TEXT NOT NULL CHECK (payer_wallet ~ '^0x[0-9a-f]{40}$'),
  payee_wallet            TEXT NOT NULL CHECK (payee_wallet ~ '^0x[0-9a-f]{40}$'),
  asset                   TEXT NOT NULL CHECK (asset ~ '^0x[0-9a-f]{40}$'),
  amount_usdc             NUMERIC(12,6) NOT NULL CHECK (amount_usdc = 1.000000),
  minimum_block_time      TIMESTAMPTZ NOT NULL,
  maximum_block_time      TIMESTAMPTZ NOT NULL,
  payment_status          TEXT NOT NULL DEFAULT 'payment_pending'
                          CHECK (payment_status IN ('payment_pending','completed','needs_review')),
  listing_id              INTEGER REFERENCES listings(id),
  finalized_block_number  BIGINT,
  finalized_block_hash    TEXT,
  finalized_block_time    TIMESTAMPTZ,
  finalized_at            TIMESTAMPTZ,
  payment_review_reason   TEXT,
  world_draft_id          INTEGER REFERENCES world_drafts(id),
  world_offer_id          INTEGER,
  world_seller_handle     TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT listing_fee_attempt_request_unique
    UNIQUE (merchant_id, fee_request_kind, fee_request_hash),
  CONSTRAINT listing_fee_attempt_window CHECK (
    maximum_block_time = minimum_block_time + interval '1 hour'
  ),
  CONSTRAINT listing_fee_attempt_finality_complete CHECK (
    (finalized_block_number IS NULL AND finalized_block_hash IS NULL
      AND finalized_block_time IS NULL AND finalized_at IS NULL)
    OR
    (finalized_block_number IS NOT NULL AND finalized_block_number >= 0
      AND finalized_block_hash ~ '^0x[0-9a-f]{64}$'
      AND finalized_block_time IS NOT NULL AND finalized_at IS NOT NULL)
  ),
  CONSTRAINT listing_fee_attempt_world_context CHECK (
    (fee_request_kind = 'artifact_listing' AND world_draft_id IS NULL
      AND world_offer_id IS NULL AND world_seller_handle IS NULL)
    OR
    (fee_request_kind = 'world_listing' AND world_draft_id IS NOT NULL
      AND world_offer_id > 0
      AND world_seller_handle ~ '^[a-z0-9][a-z0-9-]{2,31}$')
  ),
  CONSTRAINT listing_fee_attempt_state CHECK (
    (payment_status = 'payment_pending' AND listing_id IS NULL
      AND finalized_block_number IS NULL AND finalized_block_hash IS NULL
      AND finalized_block_time IS NULL AND finalized_at IS NULL
      AND payment_review_reason IS NULL)
    OR
    (payment_status = 'completed' AND listing_id IS NOT NULL
      AND finalized_block_number IS NOT NULL AND finalized_block_number >= 0
      AND finalized_block_hash ~ '^0x[0-9a-f]{64}$'
      AND finalized_block_time >= minimum_block_time
      AND finalized_block_time <= maximum_block_time AND finalized_at IS NOT NULL
      AND payment_review_reason IS NULL)
    OR
    (payment_status = 'needs_review' AND listing_id IS NULL
      AND octet_length(payment_review_reason) BETWEEN 1 AND 500)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS listing_fee_attempts_listing_unique
  ON listing_fee_attempts (listing_id) WHERE listing_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS listing_fee_attempts_listing_id_id_unique
  ON listing_fee_attempts (listing_id, id);

ALTER TABLE payment_uses
  ADD COLUMN IF NOT EXISTS listing_fee_attempt_id BIGINT;
DO $$BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_uses'::regclass
      AND conname = 'payment_uses_listing_fee_attempt_fk'
  ) THEN
    ALTER TABLE payment_uses ADD CONSTRAINT payment_uses_listing_fee_attempt_fk
      FOREIGN KEY (listing_fee_attempt_id) REFERENCES listing_fee_attempts(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_uses'::regclass
      AND conname = 'payment_uses_listing_fee_channel'
  ) THEN
    ALTER TABLE payment_uses ADD CONSTRAINT payment_uses_listing_fee_channel
      CHECK (listing_fee_attempt_id IS NULL OR used_as = 'fees');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_uses'::regclass
      AND conname = 'payment_uses_one_durable_owner'
  ) THEN
    ALTER TABLE payment_uses ADD CONSTRAINT payment_uses_one_durable_owner
      CHECK (num_nonnulls(
        world_payment_attempt_id, direct_purchase_intent_id, listing_fee_attempt_id
      ) <= 1);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS payment_uses_listing_fee_attempt_unique
  ON payment_uses (listing_fee_attempt_id)
  WHERE listing_fee_attempt_id IS NOT NULL;

ALTER TABLE fees ADD COLUMN IF NOT EXISTS listing_fee_attempt_id BIGINT;
ALTER TABLE fees ADD COLUMN IF NOT EXISTS verification_method TEXT;
UPDATE fees SET verification_method = CASE
  WHEN listing_fee_attempt_id IS NULL THEN 'legacy'
  ELSE 'direct'
END
WHERE verification_method IS NULL;
ALTER TABLE fees ALTER COLUMN verification_method SET NOT NULL;
DO $$BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'fees'::regclass
      AND conname = 'fees_listing_fee_attempt_fk'
  ) THEN
    ALTER TABLE fees ADD CONSTRAINT fees_listing_fee_attempt_fk
      FOREIGN KEY (listing_id, listing_fee_attempt_id)
      REFERENCES listing_fee_attempts(listing_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'fees'::regclass
      AND conname = 'fees_verification_method_allowed'
  ) THEN
    ALTER TABLE fees ADD CONSTRAINT fees_verification_method_allowed
      CHECK (verification_method IN ('legacy','x402','direct'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'fees'::regclass
      AND conname = 'fees_verification_method_link'
  ) THEN
    ALTER TABLE fees ADD CONSTRAINT fees_verification_method_link CHECK (
      (verification_method IN ('legacy','x402') AND listing_fee_attempt_id IS NULL)
      OR (verification_method = 'direct' AND listing_fee_attempt_id IS NOT NULL)
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'fees'::regclass
      AND conname = 'fees_new_rows_not_legacy'
  ) THEN
    ALTER TABLE fees ADD CONSTRAINT fees_new_rows_not_legacy
      CHECK (verification_method <> 'legacy')
      NOT VALID;
  END IF;
END
$$;
CREATE UNIQUE INDEX IF NOT EXISTS fees_listing_fee_attempt_unique
  ON fees (listing_fee_attempt_id)
  WHERE listing_fee_attempt_id IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_listing_fee_attempt_history()
RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'listing fee attempt history is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF ROW(
    OLD.id, OLD.merchant_id, OLD.fee_request_kind, OLD.fee_request_hash,
    OLD.tx_hash, OLD.payer_wallet, OLD.payee_wallet, OLD.asset, OLD.amount_usdc,
    OLD.minimum_block_time, OLD.maximum_block_time,
    OLD.world_draft_id, OLD.world_offer_id,
    OLD.world_seller_handle, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id, NEW.merchant_id, NEW.fee_request_kind, NEW.fee_request_hash,
    NEW.tx_hash, NEW.payer_wallet, NEW.payee_wallet, NEW.asset, NEW.amount_usdc,
    NEW.minimum_block_time, NEW.maximum_block_time,
    NEW.world_draft_id, NEW.world_offer_id,
    NEW.world_seller_handle, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'listing fee attempt terms are immutable once stored'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.payment_status IN ('completed','needs_review') AND ROW(
    OLD.listing_id, OLD.payment_status, OLD.finalized_block_number,
    OLD.finalized_block_hash, OLD.finalized_block_time, OLD.finalized_at,
    OLD.payment_review_reason
  ) IS DISTINCT FROM ROW(
    NEW.listing_id, NEW.payment_status, NEW.finalized_block_number,
    NEW.finalized_block_hash, NEW.finalized_block_time, NEW.finalized_at,
    NEW.payment_review_reason
  ) THEN
    RAISE EXCEPTION 'terminal listing fee attempt state is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.payment_status = 'payment_pending'
    AND NEW.payment_status NOT IN ('payment_pending','completed','needs_review') THEN
    RAISE EXCEPTION 'invalid listing fee attempt transition'
      USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS listing_fee_attempt_history_immutable ON listing_fee_attempts;
CREATE TRIGGER listing_fee_attempt_history_immutable
  BEFORE UPDATE OR DELETE ON listing_fee_attempts
  FOR EACH ROW EXECUTE FUNCTION protect_listing_fee_attempt_history();

CREATE OR REPLACE FUNCTION reserve_listing_fee_attempt_use()
RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
  INSERT INTO payment_uses (tx_hash, used_as, listing_fee_attempt_id)
  VALUES (NEW.tx_hash, 'fees', NEW.id);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS listing_fee_attempt_reserve_use ON listing_fee_attempts;
CREATE TRIGGER listing_fee_attempt_reserve_use
  AFTER INSERT ON listing_fee_attempts
  FOR EACH ROW EXECUTE FUNCTION reserve_listing_fee_attempt_use();

CREATE OR REPLACE FUNCTION protect_linked_payment_use()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_x402_key TEXT := to_jsonb(OLD)->>'x402_payment_operation_key';
  new_x402_key TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    new_x402_key := to_jsonb(NEW)->>'x402_payment_operation_key';
  END IF;
  IF TG_OP = 'DELETE' AND (OLD.world_payment_attempt_id IS NOT NULL
      OR OLD.direct_purchase_intent_id IS NOT NULL
      OR OLD.listing_fee_attempt_id IS NOT NULL OR old_x402_key IS NOT NULL) THEN
    RAISE EXCEPTION 'linked payment use history is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE'
    AND (OLD.world_payment_attempt_id IS NOT NULL OR NEW.world_payment_attempt_id IS NOT NULL
      OR OLD.direct_purchase_intent_id IS NOT NULL OR NEW.direct_purchase_intent_id IS NOT NULL
      OR OLD.listing_fee_attempt_id IS NOT NULL OR NEW.listing_fee_attempt_id IS NOT NULL
      OR old_x402_key IS NOT NULL OR new_x402_key IS NOT NULL)
    AND ROW(OLD.tx_hash, OLD.used_as, OLD.world_payment_attempt_id,
      OLD.direct_purchase_intent_id, OLD.listing_fee_attempt_id,
      old_x402_key, OLD.used_at)
      IS DISTINCT FROM
      ROW(NEW.tx_hash, NEW.used_as, NEW.world_payment_attempt_id,
        NEW.direct_purchase_intent_id, NEW.listing_fee_attempt_id,
        new_x402_key, NEW.used_at) THEN
    RAISE EXCEPTION 'linked payment use history is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION claim_payment_use()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  x402_key TEXT;
  reservation_found INTEGER;
BEGIN
  IF NEW.tx_hash IS NULL THEN
    RETURN NEW;
  END IF;
  NEW.tx_hash := lower(NEW.tx_hash);

  x402_key := to_jsonb(NEW)->>'x402_payment_operation_key';
  IF x402_key IS NOT NULL THEN
    EXECUTE
      'SELECT 1 FROM payment_uses WHERE tx_hash = $1 AND used_as = $2 '
      || 'AND x402_payment_operation_key = $3'
      INTO reservation_found
      USING NEW.tx_hash, TG_TABLE_NAME, x402_key;
    IF reservation_found IS NULL THEN
      RAISE EXCEPTION 'x402 result transaction is not reserved by this payment'
        USING ERRCODE = '23505', CONSTRAINT = 'payment_uses_pkey';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'purchases' THEN
    IF NEW.direct_purchase_intent_id IS NOT NULL THEN
      PERFORM 1 FROM payment_uses payment_use
      WHERE payment_use.tx_hash = NEW.tx_hash
        AND payment_use.used_as = 'purchases'
        AND payment_use.direct_purchase_intent_id = NEW.direct_purchase_intent_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'direct purchase transaction is not reserved by this intent'
          USING ERRCODE = '23505', CONSTRAINT = 'payment_uses_pkey';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.world_payment_attempt_id IS NOT NULL THEN
      PERFORM 1 FROM payment_uses payment_use
      WHERE payment_use.tx_hash = NEW.tx_hash
        AND payment_use.used_as = 'purchases'
        AND payment_use.world_payment_attempt_id = NEW.world_payment_attempt_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'world purchase transaction is not reserved by this attempt'
          USING ERRCODE = '23505', CONSTRAINT = 'payment_uses_pkey';
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'fees' THEN
    IF NEW.listing_fee_attempt_id IS NOT NULL THEN
      PERFORM 1 FROM payment_uses payment_use
      WHERE payment_use.tx_hash = NEW.tx_hash
        AND payment_use.used_as = 'fees'
        AND payment_use.listing_fee_attempt_id = NEW.listing_fee_attempt_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'listing fee transaction is not reserved by this attempt'
          USING ERRCODE = '23505', CONSTRAINT = 'payment_uses_pkey';
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO payment_uses (tx_hash, used_as)
  VALUES (NEW.tx_hash, TG_TABLE_NAME);
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION validate_listing_fee_attempt_completion()
RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
  PERFORM 1 FROM payment_uses payment_use
  WHERE payment_use.tx_hash = NEW.tx_hash
    AND payment_use.used_as = 'fees'
    AND payment_use.listing_fee_attempt_id = NEW.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'listing fee attempt has no exclusive transaction reservation'
      USING ERRCODE = '23514', CONSTRAINT = 'listing_fee_attempt_has_use';
  END IF;

  IF NEW.payment_status = 'completed' THEN
    PERFORM 1 FROM fees fee
    WHERE fee.listing_fee_attempt_id = NEW.id
      AND fee.listing_id = NEW.listing_id
      AND fee.merchant_id = NEW.merchant_id
      AND lower(fee.tx_hash) = NEW.tx_hash
      AND fee.amount_usdc = NEW.amount_usdc;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'completed listing fee attempt has no matching public fee'
        USING ERRCODE = '23514', CONSTRAINT = 'listing_fee_attempt_matches_fee';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS listing_fee_attempt_completion_matches ON listing_fee_attempts;
CREATE CONSTRAINT TRIGGER listing_fee_attempt_completion_matches
  AFTER INSERT OR UPDATE ON listing_fee_attempts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_listing_fee_attempt_completion();

CREATE OR REPLACE FUNCTION validate_linked_listing_fee()
RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.listing_fee_attempt_id IS NOT NULL THEN
      RAISE EXCEPTION 'finalized listing fee history is immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
    AND OLD.verification_method IS DISTINCT FROM NEW.verification_method THEN
    RAISE EXCEPTION 'listing fee verification method is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.listing_fee_attempt_id IS NOT NULL AND ROW(
    OLD.id, OLD.merchant_id, OLD.listing_id, OLD.amount_usdc, OLD.tx_hash,
    OLD.listing_fee_attempt_id, OLD.verification_method, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id, NEW.merchant_id, NEW.listing_id, NEW.amount_usdc, NEW.tx_hash,
    NEW.listing_fee_attempt_id, NEW.verification_method, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'finalized listing fee history is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.listing_fee_attempt_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1 FROM listing_fee_attempts attempt
  JOIN payment_uses payment_use
    ON payment_use.tx_hash = attempt.tx_hash
    AND payment_use.used_as = 'fees'
    AND payment_use.listing_fee_attempt_id = attempt.id
  WHERE attempt.id = NEW.listing_fee_attempt_id
    AND NEW.verification_method = 'direct'
    AND attempt.payment_status = 'completed'
    AND attempt.listing_id = NEW.listing_id
    AND attempt.merchant_id = NEW.merchant_id
    AND attempt.tx_hash = lower(NEW.tx_hash)
    AND attempt.amount_usdc = NEW.amount_usdc;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'public listing fee does not match its finalized payment attempt'
      USING ERRCODE = '23514', CONSTRAINT = 'fees_listing_fee_attempt_match';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS fees_listing_fee_attempt_match ON fees;
CREATE CONSTRAINT TRIGGER fees_listing_fee_attempt_match
  AFTER INSERT OR UPDATE OR DELETE ON fees
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_linked_listing_fee();
-- Durable x402 settlement custody. The opaque client proof is represented by
-- one canonical digest plus its public payer/nonce identity; it is never kept.
DO $x402_payment_attempts_compatibility$
DECLARE
  required_columns CONSTANT TEXT[] := ARRAY[
    'operation_key', 'operation_kind', 'proof_digest', 'requirements_digest',
    'network', 'asset', 'payer_wallet', 'payee_wallet', 'amount_units',
    'resource', 'authorization_nonce', 'status', 'tx_hash', 'review_reason',
    'authorization_valid_after', 'authorization_valid_before', 'start_block',
    'operation_started_at', 'settlement_started_at', 'settled_at',
    'finalized_block_number', 'finalized_block_hash', 'finalized_block_time',
    'finalized_at', 'created_at', 'updated_at'
  ];
  required_constraints CONSTANT TEXT[] := ARRAY[
    'x402_payment_attempts_pkey',
    'x402_payment_attempts_operation_key_shape',
    'x402_payment_attempts_operation_kind_allowed',
    'x402_payment_attempts_proof_digest_key',
    'x402_payment_attempts_proof_digest_shape',
    'x402_payment_attempts_requirements_digest_shape',
    'x402_payment_attempts_network_base',
    'x402_payment_attempts_asset_usdc',
    'x402_payment_attempts_payer_wallet_shape',
    'x402_payment_attempts_payee_wallet_shape',
    'x402_payment_attempts_amount_range',
    'x402_payment_attempts_resource_size',
    'x402_payment_attempts_nonce_shape',
    'x402_payment_attempts_status_allowed',
    'x402_payment_attempts_tx_hash_key',
    'x402_payment_attempts_tx_hash_shape',
    'x402_payment_attempts_review_reason_size',
    'x402_payment_attempts_authorization_owner',
    'x402_payment_attempts_authorization_window',
    'x402_payment_attempts_operation_overlap',
    'x402_payment_attempts_finality_complete',
    'x402_payment_attempts_finality_anchor',
    'x402_payment_attempts_state_facts',
    'x402_payment_attempts_time_order'
  ];
BEGIN
  IF to_regclass('public.x402_payment_attempts') IS NOT NULL THEN
    IF (
      SELECT count(*)
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'x402_payment_attempts'
        AND column_name = ANY(required_columns)
    ) <> cardinality(required_columns)
      OR (
        SELECT count(*)
        FROM pg_constraint
        WHERE conrelid = 'public.x402_payment_attempts'::regclass
          AND conname = ANY(required_constraints)
      ) <> cardinality(required_constraints)
      OR to_regclass('public.x402_payment_attempts_reconcile') IS NULL
      OR to_regprocedure('public.protect_x402_payment_attempt_history()') IS NULL
      OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'public.x402_payment_attempts'::regclass
          AND tgname = 'x402_payment_attempts_keep_history'
          AND NOT tgisinternal
      ) THEN
      RAISE EXCEPTION 'existing x402 payment custody is incompatible with this migration'
        USING ERRCODE = '55000';
    END IF;
  END IF;
END
$x402_payment_attempts_compatibility$;

CREATE TABLE IF NOT EXISTS x402_payment_attempts (
  operation_key         TEXT PRIMARY KEY
                        CONSTRAINT x402_payment_attempts_operation_key_shape
                        CHECK (
                          octet_length(operation_key) BETWEEN 1 AND 240
                          AND operation_key ~ '^[A-Za-z0-9][A-Za-z0-9:._/-]*$'
                        ),
  operation_kind        TEXT NOT NULL
                        CONSTRAINT x402_payment_attempts_operation_kind_allowed
                        CHECK (operation_kind IN (
                          'listing_fee', 'world_listing_fee', 'purchase'
                        )),
  proof_digest          TEXT NOT NULL UNIQUE
                        CONSTRAINT x402_payment_attempts_proof_digest_shape
                        CHECK (proof_digest ~ '^[0-9a-f]{64}$'),
  requirements_digest   TEXT NOT NULL
                        CONSTRAINT x402_payment_attempts_requirements_digest_shape
                        CHECK (requirements_digest ~ '^[0-9a-f]{64}$'),
  network               TEXT NOT NULL DEFAULT 'base'
                        CONSTRAINT x402_payment_attempts_network_base
                        CHECK (network = 'base'),
  asset                 TEXT NOT NULL
                        DEFAULT '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
                        CONSTRAINT x402_payment_attempts_asset_usdc
                        CHECK (
                          asset = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
                        ),
  payer_wallet          TEXT NOT NULL
                        CONSTRAINT x402_payment_attempts_payer_wallet_shape
                        CHECK (payer_wallet ~ '^0x[0-9a-f]{40}$'),
  payee_wallet          TEXT NOT NULL
                        CONSTRAINT x402_payment_attempts_payee_wallet_shape
                        CHECK (payee_wallet ~ '^0x[0-9a-f]{40}$'),
  amount_units          BIGINT NOT NULL
                        CONSTRAINT x402_payment_attempts_amount_range
                        CHECK (amount_units BETWEEN 1 AND 10000000000),
  resource              TEXT NOT NULL
                        CONSTRAINT x402_payment_attempts_resource_size
                        CHECK (octet_length(resource) BETWEEN 1 AND 2048),
  authorization_nonce   TEXT NOT NULL
                        CONSTRAINT x402_payment_attempts_nonce_shape
                        CHECK (authorization_nonce ~ '^0x[0-9a-f]{64}$'),
  authorization_valid_after BIGINT NOT NULL,
  authorization_valid_before BIGINT NOT NULL,
  start_block           BIGINT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'settling'
                        CONSTRAINT x402_payment_attempts_status_allowed
                        CHECK (status IN ('settling', 'settled', 'verified', 'needs_review')),
  tx_hash               TEXT UNIQUE
                        CONSTRAINT x402_payment_attempts_tx_hash_shape
                        CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  review_reason         TEXT
                        CONSTRAINT x402_payment_attempts_review_reason_size
                        CHECK (
                          review_reason IS NULL
                          OR octet_length(review_reason) BETWEEN 1 AND 240
                        ),
  operation_started_at  TIMESTAMPTZ NOT NULL,
  settlement_started_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  settled_at            TIMESTAMPTZ,
  finalized_block_number BIGINT,
  finalized_block_hash  TEXT,
  finalized_block_time  TIMESTAMPTZ,
  finalized_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT x402_payment_attempts_authorization_owner
    UNIQUE (network, asset, payer_wallet, authorization_nonce),
  CONSTRAINT x402_payment_attempts_authorization_window CHECK (
    authorization_valid_after >= 0
    AND authorization_valid_before <= 9007199254740991
    AND authorization_valid_before > authorization_valid_after + 1
  ),
  CONSTRAINT x402_payment_attempts_operation_overlap CHECK (
    start_block >= 0
    AND GREATEST(
      floor(extract(epoch FROM operation_started_at))::bigint,
      authorization_valid_after + 1
    ) < authorization_valid_before
  ),
  CONSTRAINT x402_payment_attempts_finality_complete CHECK (
    (
      finalized_block_number IS NULL
      AND finalized_block_hash IS NULL
      AND finalized_block_time IS NULL
      AND finalized_at IS NULL
    ) OR (
      finalized_block_number IS NOT NULL
      AND finalized_block_number >= 0
      AND finalized_block_hash ~ '^0x[0-9a-f]{64}$'
      AND finalized_block_time IS NOT NULL
      AND finalized_at IS NOT NULL
    )
  ),
  CONSTRAINT x402_payment_attempts_finality_anchor CHECK (
    status <> 'verified' OR (
      finalized_block_number >= start_block
      AND floor(extract(epoch FROM finalized_block_time))::bigint
        > authorization_valid_after
      AND floor(extract(epoch FROM finalized_block_time))::bigint
        < authorization_valid_before
    )
  ),
  CONSTRAINT x402_payment_attempts_state_facts CHECK (
    (
      status = 'settling'
      AND tx_hash IS NULL
      AND review_reason IS NULL
      AND settled_at IS NULL
      AND finalized_block_number IS NULL
    ) OR (
      status = 'needs_review'
      AND tx_hash IS NULL
      AND review_reason IS NOT NULL
      AND settled_at IS NULL
      AND finalized_block_number IS NULL
    ) OR (
      status = 'settled'
      AND tx_hash IS NOT NULL
      AND settled_at IS NOT NULL
      AND review_reason IS NULL
      AND finalized_block_number IS NULL
    ) OR (
      status = 'verified'
      AND tx_hash IS NOT NULL
      AND settled_at IS NOT NULL
      AND review_reason IS NULL
      AND finalized_block_number IS NOT NULL
    ) OR (
      status = 'needs_review'
      AND tx_hash IS NOT NULL
      AND settled_at IS NOT NULL
      AND review_reason IS NOT NULL
      AND finalized_block_number IS NULL
    ) OR (
      status = 'needs_review'
      AND tx_hash IS NOT NULL
      AND settled_at IS NOT NULL
      AND review_reason IS NOT NULL
      AND finalized_block_number IS NOT NULL
    )
  ),
  CONSTRAINT x402_payment_attempts_time_order CHECK (
    operation_started_at <= settlement_started_at
    AND settlement_started_at >= created_at
    AND updated_at >= created_at
    AND (settled_at IS NULL OR settled_at >= settlement_started_at)
    AND (finalized_at IS NULL OR finalized_at >= finalized_block_time)
  )
);

CREATE INDEX IF NOT EXISTS x402_payment_attempts_reconcile
  ON x402_payment_attempts (updated_at, operation_key)
  WHERE status IN ('settling', 'settled')
    OR (status = 'needs_review' AND finalized_block_number IS NULL);

CREATE OR REPLACE FUNCTION protect_x402_payment_attempt_history()
RETURNS trigger LANGUAGE plpgsql AS $x402_payment_attempt_history$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'x402 payment attempt history cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(
    NEW.operation_key, NEW.operation_kind, NEW.proof_digest,
    NEW.requirements_digest, NEW.network, NEW.asset, NEW.payer_wallet,
    NEW.payee_wallet, NEW.amount_units, NEW.resource,
    NEW.authorization_nonce, NEW.authorization_valid_after,
    NEW.authorization_valid_before, NEW.start_block, NEW.operation_started_at,
    NEW.settlement_started_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.operation_key, OLD.operation_kind, OLD.proof_digest,
    OLD.requirements_digest, OLD.network, OLD.asset, OLD.payer_wallet,
    OLD.payee_wallet, OLD.amount_units, OLD.resource,
    OLD.authorization_nonce, OLD.authorization_valid_after,
    OLD.authorization_valid_before, OLD.start_block, OLD.operation_started_at,
    OLD.settlement_started_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'x402 payment attempt terms are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.tx_hash IS NOT NULL AND NEW.tx_hash IS DISTINCT FROM OLD.tx_hash THEN
    RAISE EXCEPTION 'x402 payment transaction is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at THEN
    RAISE EXCEPTION 'x402 payment settlement time is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.finalized_block_number IS NULL
    AND NEW.finalized_block_number IS NOT NULL
    AND OLD.status <> 'settled' THEN
    RAISE EXCEPTION 'x402 payment finality requires a stored settlement'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.finalized_block_number IS NOT NULL AND ROW(
    OLD.finalized_block_number, OLD.finalized_block_hash,
    OLD.finalized_block_time, OLD.finalized_at
  ) IS DISTINCT FROM ROW(
    NEW.finalized_block_number, NEW.finalized_block_hash,
    NEW.finalized_block_time, NEW.finalized_at
  ) THEN
    RAISE EXCEPTION 'x402 payment finality is immutable once recorded'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.review_reason IS NOT NULL
    AND NEW.review_reason IS DISTINCT FROM OLD.review_reason
    AND NOT (
      OLD.status = 'needs_review'
      AND OLD.tx_hash IS NULL
      AND NEW.status = 'settled'
      AND NEW.review_reason IS NULL
    ) THEN
    RAISE EXCEPTION 'x402 payment review reason is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF (
    OLD.status = 'verified'
    OR (OLD.status = 'needs_review' AND OLD.tx_hash IS NOT NULL)
  ) AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal x402 payment attempt is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NOT (
    (OLD.status = 'settling' AND NEW.status IN ('settling', 'needs_review', 'settled'))
    OR (
      OLD.status = 'needs_review'
      AND OLD.tx_hash IS NULL
      AND OLD.finalized_block_number IS NULL
      AND NEW.status IN ('needs_review', 'settled')
    )
    OR (OLD.status = 'settled' AND NEW.status IN ('settled', 'verified', 'needs_review'))
    OR OLD.status = NEW.status
  ) THEN
    RAISE EXCEPTION 'invalid x402 payment attempt transition'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'x402 payment attempt update time cannot move backward'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$x402_payment_attempt_history$;

DROP TRIGGER IF EXISTS x402_payment_attempts_keep_history ON x402_payment_attempts;
CREATE TRIGGER x402_payment_attempts_keep_history
  BEFORE UPDATE OR DELETE ON x402_payment_attempts
  FOR EACH ROW EXECUTE FUNCTION protect_x402_payment_attempt_history();

-- A facilitator-confirmed transaction is reserved across every market payment
-- channel before finality. A competing owner is preserved as terminal review.
ALTER TABLE payment_uses
  ADD COLUMN IF NOT EXISTS x402_payment_operation_key TEXT;

-- These shared trigger functions deliberately have the same union-aware shape
-- in the world migration, so either guarded migration may be rerun last.
CREATE OR REPLACE FUNCTION protect_linked_payment_use()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_x402_key TEXT := to_jsonb(OLD)->>'x402_payment_operation_key';
  new_x402_key TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    new_x402_key := to_jsonb(NEW)->>'x402_payment_operation_key';
  END IF;
  IF TG_OP = 'DELETE' AND (OLD.world_payment_attempt_id IS NOT NULL
      OR OLD.direct_purchase_intent_id IS NOT NULL
      OR OLD.listing_fee_attempt_id IS NOT NULL OR old_x402_key IS NOT NULL) THEN
    RAISE EXCEPTION 'linked payment use history is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE'
    AND (OLD.world_payment_attempt_id IS NOT NULL OR NEW.world_payment_attempt_id IS NOT NULL
      OR OLD.direct_purchase_intent_id IS NOT NULL OR NEW.direct_purchase_intent_id IS NOT NULL
      OR OLD.listing_fee_attempt_id IS NOT NULL OR NEW.listing_fee_attempt_id IS NOT NULL
      OR old_x402_key IS NOT NULL OR new_x402_key IS NOT NULL)
    AND ROW(OLD.tx_hash, OLD.used_as, OLD.world_payment_attempt_id,
      OLD.direct_purchase_intent_id, OLD.listing_fee_attempt_id,
      old_x402_key, OLD.used_at)
      IS DISTINCT FROM
      ROW(NEW.tx_hash, NEW.used_as, NEW.world_payment_attempt_id,
        NEW.direct_purchase_intent_id, NEW.listing_fee_attempt_id,
        new_x402_key, NEW.used_at) THEN
    RAISE EXCEPTION 'linked payment use history is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION claim_payment_use()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  x402_key TEXT;
  reservation_found INTEGER;
BEGIN
  IF NEW.tx_hash IS NULL THEN
    RETURN NEW;
  END IF;
  NEW.tx_hash := lower(NEW.tx_hash);

  x402_key := to_jsonb(NEW)->>'x402_payment_operation_key';
  IF x402_key IS NOT NULL THEN
    EXECUTE
      'SELECT 1 FROM payment_uses WHERE tx_hash = $1 AND used_as = $2 '
      || 'AND x402_payment_operation_key = $3'
      INTO reservation_found
      USING NEW.tx_hash, TG_TABLE_NAME, x402_key;
    IF reservation_found IS NULL THEN
      RAISE EXCEPTION 'x402 result transaction is not reserved by this payment'
        USING ERRCODE = '23505', CONSTRAINT = 'payment_uses_pkey';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'purchases' THEN
    IF NEW.direct_purchase_intent_id IS NOT NULL THEN
      PERFORM 1 FROM payment_uses payment_use
      WHERE payment_use.tx_hash = NEW.tx_hash
        AND payment_use.used_as = 'purchases'
        AND payment_use.direct_purchase_intent_id = NEW.direct_purchase_intent_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'direct purchase transaction is not reserved by this intent'
          USING ERRCODE = '23505', CONSTRAINT = 'payment_uses_pkey';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.world_payment_attempt_id IS NOT NULL THEN
      PERFORM 1 FROM payment_uses payment_use
      WHERE payment_use.tx_hash = NEW.tx_hash
        AND payment_use.used_as = 'purchases'
        AND payment_use.world_payment_attempt_id = NEW.world_payment_attempt_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'world purchase transaction is not reserved by this attempt'
          USING ERRCODE = '23505', CONSTRAINT = 'payment_uses_pkey';
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'fees' THEN
    IF NEW.listing_fee_attempt_id IS NOT NULL THEN
      PERFORM 1 FROM payment_uses payment_use
      WHERE payment_use.tx_hash = NEW.tx_hash
        AND payment_use.used_as = 'fees'
        AND payment_use.listing_fee_attempt_id = NEW.listing_fee_attempt_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'listing fee transaction is not reserved by this attempt'
          USING ERRCODE = '23505', CONSTRAINT = 'payment_uses_pkey';
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO payment_uses (tx_hash, used_as)
  VALUES (NEW.tx_hash, TG_TABLE_NAME);
  RETURN NEW;
END
$$;

DO $payment_uses_x402_payment_attempt_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_uses'::regclass
      AND conname = 'payment_uses_x402_payment_attempt_fk'
  ) THEN
    ALTER TABLE payment_uses ADD CONSTRAINT payment_uses_x402_payment_attempt_fk
      FOREIGN KEY (x402_payment_operation_key)
      REFERENCES x402_payment_attempts(operation_key)
      DEFERRABLE INITIALLY DEFERRED NOT VALID;
  END IF;
END
$payment_uses_x402_payment_attempt_fk$;

DO $payment_uses_one_durable_owner_v2$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'payment_uses'::regclass
      AND conname = 'payment_uses_one_durable_owner_v2'
  ) THEN
    ALTER TABLE payment_uses ADD CONSTRAINT payment_uses_one_durable_owner_v2
      CHECK (num_nonnulls(
        world_payment_attempt_id, direct_purchase_intent_id,
        listing_fee_attempt_id, x402_payment_operation_key
      ) <= 1) NOT VALID;
  END IF;
END
$payment_uses_one_durable_owner_v2$;

CREATE UNIQUE INDEX IF NOT EXISTS payment_uses_x402_payment_attempt_unique
  ON payment_uses (x402_payment_operation_key)
  WHERE x402_payment_operation_key IS NOT NULL;

CREATE OR REPLACE FUNCTION reserve_x402_payment_attempt_use()
RETURNS trigger LANGUAGE plpgsql AS $reserve_x402_payment_attempt_use$
DECLARE
  expected_channel TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.updated_at := GREATEST(
      clock_timestamp(), NEW.updated_at, NEW.settlement_started_at
    );
  ELSE
    NEW.updated_at := GREATEST(
      clock_timestamp(), OLD.updated_at, NEW.updated_at, NEW.settlement_started_at
    );
  END IF;
  IF NEW.tx_hash IS NULL OR (TG_OP = 'UPDATE' AND OLD.tx_hash IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  expected_channel := CASE
    WHEN NEW.operation_kind IN ('listing_fee', 'world_listing_fee') THEN 'fees'
    ELSE 'purchases'
  END;
  INSERT INTO payment_uses (tx_hash, used_as, x402_payment_operation_key)
  VALUES (NEW.tx_hash, expected_channel, NEW.operation_key)
  ON CONFLICT (tx_hash) DO NOTHING;

  PERFORM 1 FROM payment_uses payment_use
  WHERE payment_use.tx_hash = NEW.tx_hash
    AND payment_use.used_as = expected_channel
    AND payment_use.x402_payment_operation_key = NEW.operation_key;
  IF NOT FOUND THEN
    NEW.status := 'needs_review';
    NEW.review_reason :=
      'this confirmed transaction is already assigned to another market payment; no delivery was recorded; do not pay again';
    NEW.finalized_block_number := NULL;
    NEW.finalized_block_hash := NULL;
    NEW.finalized_block_time := NULL;
    NEW.finalized_at := NULL;
  END IF;
  RETURN NEW;
END
$reserve_x402_payment_attempt_use$;

DROP TRIGGER IF EXISTS x402_payment_attempt_reserve_use ON x402_payment_attempts;
CREATE TRIGGER x402_payment_attempt_reserve_use
  BEFORE INSERT OR UPDATE ON x402_payment_attempts
  FOR EACH ROW EXECUTE FUNCTION reserve_x402_payment_attempt_use();

CREATE OR REPLACE FUNCTION validate_x402_payment_attempt_use()
RETURNS trigger LANGUAGE plpgsql AS $validate_x402_payment_attempt_use$
DECLARE
  expected_channel TEXT;
BEGIN
  IF NEW.tx_hash IS NULL THEN RETURN NEW; END IF;
  expected_channel := CASE
    WHEN NEW.operation_kind IN ('listing_fee', 'world_listing_fee') THEN 'fees'
    ELSE 'purchases'
  END;
  IF NEW.review_reason =
    'this confirmed transaction is already assigned to another market payment; no delivery was recorded; do not pay again' THEN
    PERFORM 1 FROM payment_uses payment_use
    WHERE payment_use.x402_payment_operation_key = NEW.operation_key;
    IF FOUND THEN
      RAISE EXCEPTION 'conflicting x402 payment cannot own a market transaction reservation'
        USING ERRCODE = '23514', CONSTRAINT = 'x402_payment_attempt_use_matches';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM payment_uses payment_use
  WHERE payment_use.tx_hash = NEW.tx_hash
    AND payment_use.used_as = expected_channel
    AND payment_use.x402_payment_operation_key = NEW.operation_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'x402 payment has no matching market transaction reservation'
      USING ERRCODE = '23514', CONSTRAINT = 'x402_payment_attempt_use_matches';
  END IF;
  RETURN NEW;
END
$validate_x402_payment_attempt_use$;

DROP TRIGGER IF EXISTS x402_payment_attempt_use_matches ON x402_payment_attempts;
CREATE CONSTRAINT TRIGGER x402_payment_attempt_use_matches
  AFTER INSERT OR UPDATE ON x402_payment_attempts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_x402_payment_attempt_use();

-- Every new public x402 result points back to the one finalized operation that
-- authorized it. Existing receipt-only rows remain readable, but this NOT VALID
-- bridge rejects any new receipt-only write from an older rolling deployment.
ALTER TABLE fees
  ADD COLUMN IF NOT EXISTS x402_payment_operation_key TEXT;
ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS x402_payment_operation_key TEXT;

DO $fees_x402_payment_attempt_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'fees'::regclass
      AND conname = 'fees_x402_payment_attempt_fk'
  ) THEN
    ALTER TABLE fees ADD CONSTRAINT fees_x402_payment_attempt_fk
      FOREIGN KEY (x402_payment_operation_key)
      REFERENCES x402_payment_attempts(operation_key) NOT VALID;
  END IF;
END
$fees_x402_payment_attempt_fk$;

DO $purchases_x402_payment_attempt_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'purchases'::regclass
      AND conname = 'purchases_x402_payment_attempt_fk'
  ) THEN
    ALTER TABLE purchases ADD CONSTRAINT purchases_x402_payment_attempt_fk
      FOREIGN KEY (x402_payment_operation_key)
      REFERENCES x402_payment_attempts(operation_key) NOT VALID;
  END IF;
END
$purchases_x402_payment_attempt_fk$;

DO $fees_x402_requires_payment_attempt$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'fees'::regclass
      AND conname = 'fees_x402_requires_payment_attempt'
  ) THEN
    ALTER TABLE fees ADD CONSTRAINT fees_x402_requires_payment_attempt CHECK (
      (verification_method = 'x402' AND x402_payment_operation_key IS NOT NULL)
      OR (verification_method <> 'x402' AND x402_payment_operation_key IS NULL)
    ) NOT VALID;
  END IF;
END
$fees_x402_requires_payment_attempt$;

DO $purchases_x402_requires_payment_attempt$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'purchases'::regclass
      AND conname = 'purchases_x402_requires_payment_attempt'
  ) THEN
    ALTER TABLE purchases ADD CONSTRAINT purchases_x402_requires_payment_attempt CHECK (
      (verified_via = 'x402' AND x402_payment_operation_key IS NOT NULL)
      OR (verified_via <> 'x402' AND x402_payment_operation_key IS NULL)
    ) NOT VALID;
  END IF;
END
$purchases_x402_requires_payment_attempt$;

CREATE UNIQUE INDEX IF NOT EXISTS fees_x402_payment_attempt_unique
  ON fees (x402_payment_operation_key)
  WHERE x402_payment_operation_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS purchases_x402_payment_attempt_unique
  ON purchases (x402_payment_operation_key)
  WHERE x402_payment_operation_key IS NOT NULL;

CREATE OR REPLACE FUNCTION validate_x402_result_link()
RETURNS trigger LANGUAGE plpgsql AS $validate_x402_result_link$
BEGIN
  IF NEW.x402_payment_operation_key IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'fees' THEN
    PERFORM 1
    FROM x402_payment_attempts attempt
    JOIN payment_uses payment_use
      ON payment_use.tx_hash = attempt.tx_hash
      AND payment_use.used_as = 'fees'
      AND payment_use.x402_payment_operation_key = NEW.x402_payment_operation_key
    JOIN listings listing ON listing.id = NEW.listing_id
    WHERE attempt.operation_key = NEW.x402_payment_operation_key
      AND attempt.status = 'verified'
      AND attempt.tx_hash = lower(NEW.tx_hash)
      AND attempt.network = 'base'
      AND attempt.asset = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
      AND attempt.amount_units = NEW.amount_usdc * 1000000
      AND attempt.payee_wallet = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
      AND listing.merchant_id = NEW.merchant_id
      AND (
        (
          listing.delivery_kind = 'artifact'
          AND attempt.operation_kind = 'listing_fee'
          AND attempt.operation_key ~ (
            '^listing-fee:artifact:' || NEW.merchant_id::text || ':[0-9a-f]{64}$'
          )
          AND attempt.resource ~ '^https://[^/?#]+/api/listing$'
        ) OR (
          listing.delivery_kind = 'city_ownership'
          AND attempt.operation_kind = 'world_listing_fee'
          AND attempt.operation_key ~ (
            '^world-listing-fee:merchant:' || NEW.merchant_id::text
            || ':request:[0-9a-f]{64}$'
          )
          AND attempt.resource ~ '^https://[^/?#]+/api/world/listing$'
        )
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'x402 fee does not match its finalized payment attempt'
        USING ERRCODE = '23514', CONSTRAINT = 'fees_x402_payment_attempt_match';
    END IF;
  ELSIF TG_TABLE_NAME = 'purchases' THEN
    PERFORM 1
    FROM x402_payment_attempts attempt
    JOIN payment_uses payment_use
      ON payment_use.tx_hash = attempt.tx_hash
      AND payment_use.used_as = 'purchases'
      AND payment_use.x402_payment_operation_key = NEW.x402_payment_operation_key
    JOIN listings listing ON listing.id = NEW.listing_id
    WHERE attempt.operation_key = NEW.x402_payment_operation_key
      AND attempt.status = 'verified'
      AND attempt.tx_hash = lower(NEW.tx_hash)
      AND attempt.network = 'base'
      AND attempt.asset = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
      AND attempt.amount_units = NEW.amount_usdc * 1000000
      AND attempt.payee_wallet = lower(listing.seller_wallet)
      AND listing.delivery_kind = 'artifact'
      AND listing.merchant_id <> NEW.merchant_id
      AND attempt.operation_kind = 'purchase'
      AND attempt.operation_key = (
        'purchase:artifact:' || NEW.merchant_id::text || ':' || NEW.listing_id::text
      )
      AND attempt.resource ~ (
        '^https://[^/?#]+/api/buy/' || NEW.listing_id::text || '$'
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'x402 purchase does not match its finalized payment attempt'
        USING ERRCODE = '23514', CONSTRAINT = 'purchases_x402_payment_attempt_match';
    END IF;
  END IF;
  RETURN NEW;
END
$validate_x402_result_link$;

CREATE OR REPLACE FUNCTION protect_x402_result_link()
RETURNS trigger LANGUAGE plpgsql AS $protect_x402_result_link$
BEGIN
  IF OLD.x402_payment_operation_key IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'linked x402 result history cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_TABLE_NAME = 'fees' AND ROW(
    OLD.id, OLD.merchant_id, OLD.listing_id, OLD.amount_usdc, OLD.tx_hash,
    OLD.listing_fee_attempt_id, OLD.verification_method,
    OLD.x402_payment_operation_key, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id, NEW.merchant_id, NEW.listing_id, NEW.amount_usdc, NEW.tx_hash,
    NEW.listing_fee_attempt_id, NEW.verification_method,
    NEW.x402_payment_operation_key, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'linked x402 fee history is immutable'
      USING ERRCODE = '55000';
  ELSIF TG_TABLE_NAME = 'purchases' AND ROW(
    OLD.id, OLD.listing_id, OLD.merchant_id, OLD.amount_usdc, OLD.tx_hash,
    OLD.verified_via, OLD.direct_purchase_intent_id, OLD.world_checkout_id,
    OLD.world_receipt, OLD.world_payment_attempt_id,
    OLD.x402_payment_operation_key, OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id, NEW.listing_id, NEW.merchant_id, NEW.amount_usdc, NEW.tx_hash,
    NEW.verified_via, NEW.direct_purchase_intent_id, NEW.world_checkout_id,
    NEW.world_receipt, NEW.world_payment_attempt_id,
    NEW.x402_payment_operation_key, NEW.created_at
  ) THEN
    RAISE EXCEPTION 'linked x402 purchase history is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$protect_x402_result_link$;

DROP TRIGGER IF EXISTS fees_x402_payment_attempt_match ON fees;
CREATE CONSTRAINT TRIGGER fees_x402_payment_attempt_match
  AFTER INSERT OR UPDATE ON fees
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_x402_result_link();
DROP TRIGGER IF EXISTS purchases_x402_payment_attempt_match ON purchases;
CREATE CONSTRAINT TRIGGER purchases_x402_payment_attempt_match
  AFTER INSERT OR UPDATE ON purchases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_x402_result_link();

DROP TRIGGER IF EXISTS fees_x402_result_link_immutable ON fees;
CREATE TRIGGER fees_x402_result_link_immutable
  BEFORE UPDATE OR DELETE ON fees
  FOR EACH ROW EXECUTE FUNCTION protect_x402_result_link();
DROP TRIGGER IF EXISTS purchases_x402_result_link_immutable ON purchases;
CREATE TRIGGER purchases_x402_result_link_immutable
  BEFORE UPDATE OR DELETE ON purchases
  FOR EACH ROW EXECUTE FUNCTION protect_x402_result_link();
