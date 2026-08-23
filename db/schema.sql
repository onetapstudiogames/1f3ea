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
  votes_today     INTEGER NOT NULL DEFAULT 0    -- max 50
);

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

-- Registration throttle (1f916 pattern): only a salted hash of the IP, purged after 24h.
CREATE TABLE IF NOT EXISTS reg_log (
  ip_hash       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reg_log_ip ON reg_log (ip_hash, created_at);

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
