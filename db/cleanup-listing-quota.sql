-- CONTRACT migration: run only after the storefront build is live and smoke-tested.
-- The old production code reads this column during auth, so never run this pre-deploy.
ALTER TABLE merchants DROP COLUMN IF EXISTS listings_today;
