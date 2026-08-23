-- Fresh direct-payment proof. This is an expand-only migration: old code ignores
-- the new private intent rows and the nullable purchase link until new code ships.

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

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS direct_purchase_intent_id INTEGER;
DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'purchases'::regclass AND conname = 'purchases_direct_intent_channel') THEN ALTER TABLE purchases ADD CONSTRAINT purchases_direct_intent_channel CHECK (direct_purchase_intent_id IS NULL OR verified_via = 'claim'); END IF; END$$;
DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'purchases'::regclass AND conname = 'purchases_direct_intent_listing_fk') THEN ALTER TABLE purchases ADD CONSTRAINT purchases_direct_intent_listing_fk FOREIGN KEY (listing_id, direct_purchase_intent_id) REFERENCES direct_purchase_intents(listing_id, id); END IF; END$$;
CREATE UNIQUE INDEX IF NOT EXISTS purchases_direct_intent_unique
  ON purchases (direct_purchase_intent_id) WHERE direct_purchase_intent_id IS NOT NULL;
