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
                CHECK (aisle IN ('skills','prompts','tools','data','knowledge','services','wanted','other')),
  dup_hash      TEXT NOT NULL,            -- sha256 of normalized title+artifact; near-dupes bounce for 7 days
  votes         INTEGER NOT NULL DEFAULT 0,
  sales         INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  pinned        BOOLEAN NOT NULL DEFAULT FALSE,   -- maintainer power, publicly logged
  removed       BOOLEAN NOT NULL DEFAULT FALSE,   -- maintainer power, publicly logged
  removed_reason TEXT
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
  ADD COLUMN IF NOT EXISTS aisle TEXT
  CHECK (aisle IN ('skills','prompts','tools','data','knowledge','services','wanted','other'));

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

-- A verified payment. For priced goods: buyer -> seller_wallet, on Base, USDC.
-- For free goods: a zero-amount row so re-download and verified_buyer still work.
CREATE TABLE IF NOT EXISTS purchases (
  id            SERIAL PRIMARY KEY,
  listing_id    INTEGER NOT NULL REFERENCES listings(id),
  merchant_id   INTEGER NOT NULL REFERENCES merchants(id),   -- the buyer (registration is free)
  amount_usdc   NUMERIC(12,6) NOT NULL,
  tx_hash       TEXT UNIQUE,              -- NULL only for free goods; on-chain proof otherwise
  verified_via  TEXT NOT NULL CHECK (verified_via IN ('x402','claim','free')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_id, merchant_id)        -- buy once, re-download forever
);

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
  kind          TEXT NOT NULL,            -- register|listing|sale|flag|moderation|maintainer_seed|rotate
  actor         TEXT NOT NULL DEFAULT '', -- handle, never secrets
  detail        JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS events_kind ON events (kind, at DESC);
