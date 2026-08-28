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
