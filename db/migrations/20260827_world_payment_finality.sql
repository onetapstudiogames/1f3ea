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
