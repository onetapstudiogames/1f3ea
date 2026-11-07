-- Additive migration for city things that end: a world listing may record thing_ended
-- when the city says its thing ended before it sold. The listing state check is widened;
-- no row, column, or other constraint is removed or narrowed, and no row is changed.
-- Old application code never writes the new value. The runner wraps both statements in
-- one transaction, so listings stays locked until that transaction commits.
DO $listings_world_state_allowed$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'listings'::regclass
      AND conname = 'listings_world_state_allowed'
  ) THEN
    ALTER TABLE listings DROP CONSTRAINT listings_world_state_allowed;
  END IF;
  ALTER TABLE listings
    ADD CONSTRAINT listings_world_state_allowed CHECK (
      world_state IS NULL OR world_state IN ('active','sold','canceled','stale','thing_ended')
    ) NOT VALID;
END
$listings_world_state_allowed$;

ALTER TABLE listings VALIDATE CONSTRAINT listings_world_state_allowed;
