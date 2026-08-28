# Release migrations

The direct-payment, hosted-sign-in, save-first identity, world-payment-finality, and
x402-attempt changes have five additive database changes:

1. `db/migrations/20260823_direct_payments.sql`
2. `db/migrations/20260822_hosted_market_signin.sql`
3. `db/migrations/20260827_market_identity.sql`
4. `db/migrations/20260827_world_payment_finality.sql`
5. `db/migrations/20260828_x402_payment_attempts.sql`

Do not use the full `db/schema.sql` as a remote release migration. It contains the
whole market history, while these files contain only their reviewed additions.
The market-identity migration extends the hosted-sign-in tables, so apply hosted sign-in
before market identity on an environment that has neither.

The first three migrations use the normal schema-first order. The
`world-payment-finality` migration is deliberately stricter: after it lands, an old
application instance cannot record a receipt-only direct or world purchase. Deploy the
new build with hosted payment custody closed before applying that migration. This chooses
a bounded, honest 503 window instead of accepting an unfinalized payment during rollout.
The migration also adds a required, no-default `fees.verification_method`: the new build
writes `x402` or `direct`, existing rows become `legacy`, and an old listing-fee writer
that omits the field is rejected. This is a database writer fence, not a substitute for
draining the old deployment before migration; an old request must never settle and then
reach that fence.

Apply `x402-payment-attempts` only after `world-payment-finality`. Keep payment custody
closed until both runners report all checks passed. The x402 migration adds the durable
record that is created before a facilitator settlement starts; it stores only a digest
and public payment identity, never the opaque signed payment proof.

## Required target facts

Copy the database name and exact direct, non-pooled hostname from the intended Neon
environment. Do not infer them from a branch name. The runner checks both the URL and
the connected database before it applies anything. It never prints the connection URL.

For preview, provide `PREVIEW_DATABASE_URL_UNPOOLED` in the process environment. Also
provide the production hostname separately so the preview command can refuse a
production connection:

```text
--database <expected-database>
--endpoint <exact-non-pooled-hostname>
--production-endpoint <exact-production-hostname>
```

For production, provide `PRODUCTION_DATABASE_URL_UNPOOLED` and:

```text
--database <expected-database>
--endpoint <exact-non-pooled-hostname>
```

Both URLs must include `sslmode=require` or `sslmode=verify-full`. A generic
`DATABASE_URL` is deliberately ignored, and a pooled URL is refused.

## Preview first

Set this exact one-run confirmation in the same private shell as the preview URL:

```text
CONFIRM_MARKET_PREVIEW_MIGRATION=APPLY_ADDITIVE_MARKET_SCHEMA_TO_ISOLATED_PREVIEW
```

Run the existing schema-first migrations, when needed, with the target facts above:

```text
npm run migrate:preview:direct-payments -- --database <expected-database> --endpoint <exact-non-pooled-hostname> --production-endpoint <exact-production-hostname>
npm run migrate:preview:hosted-market-signin -- --database <expected-database> --endpoint <exact-non-pooled-hostname> --production-endpoint <exact-production-hostname>
npm run migrate:preview:market-identity -- --database <expected-database> --endpoint <exact-non-pooled-hostname> --production-endpoint <exact-production-hostname>
```

For `world-payment-finality`, use this order:

1. Deploy the candidate to preview with `PAYMENT_CUSTODY_READY` absent.
2. Prove paid listing, paid buy, direct intent/claim, world listing, and world sync stop
   with 503 before facilitator, Base, or new payment-table work. Public reads stay live.
3. Run:

   ```text
   npm run migrate:preview:world-payment-finality -- --database <expected-database> --endpoint <exact-non-pooled-hostname> --production-endpoint <exact-production-hostname>
   ```

4. Require the runner to report every table, column, index, constraint, trigger, and
   trigger function present with its declared money-safety definition. Prove a legacy
   receipt-only direct purchase, world purchase, and fee insert without
   `verification_method` are rejected.
5. With custody still closed, run the x402-attempt migration after world finality:

   ```text
   npm run migrate:preview:x402-payment-attempts -- --database <expected-database> --endpoint <exact-non-pooled-hostname> --production-endpoint <exact-production-hostname>
   ```

6. Require all x402 table, column, index, constraint, trigger, and trigger-function
   checks to pass. Then set `PAYMENT_CUSTODY_READY=1`, redeploy the same candidate
   commit, and perform the real preview payment probes.

## Production after preview passes

Create and record a provider recovery point before production. Then set this exact
one-run confirmation in the same private shell as the production URL:

```text
CONFIRM_MARKET_PRODUCTION_MIGRATION=APPLY_ADDITIVE_MARKET_SCHEMA_TO_PRODUCTION
```

Run the existing schema-first migrations before their application changes, when needed:

```text
npm run migrate:production:direct-payments -- --database <expected-database> --endpoint <exact-non-pooled-hostname>
npm run migrate:production:hosted-market-signin -- --database <expected-database> --endpoint <exact-non-pooled-hostname>
npm run migrate:production:market-identity -- --database <expected-database> --endpoint <exact-non-pooled-hostname>
```

After all three commands report all checks passed, keep their identity features gated
until their own live checks pass. Then use this strict order for
`world-payment-finality`:

1. Confirm production does not have `PAYMENT_CUSTODY_READY=1`, then merge the reviewed
   application PR. Vercel must deploy that exact commit with payment custody closed.
2. Probe the production domain and record the same 503-before-payment evidence used in
   preview. Confirm the domain serves the new commit. Before migration, require the
   provider to report the prior deployment inactive and no prior-deployment invocation
   for one full provider maximum function duration; record both facts. A timed wait alone
   or one successful domain probe is not drain evidence.
3. Run:

   ```text
   npm run migrate:production:world-payment-finality -- --database <expected-database> --endpoint <exact-non-pooled-hostname>
   ```

4. Require every semantic runner postcondition to pass. Prove the three legacy
   receipt-only writes above are fenced.
5. With custody still closed, run the x402-attempt migration after world finality:

   ```text
   npm run migrate:production:x402-payment-attempts -- --database <expected-database> --endpoint <exact-non-pooled-hostname>
   ```

6. Require all x402 semantic runner postconditions to pass. Set
   `PAYMENT_CUSTODY_READY=1`, let Vercel redeploy the same commit, then perform and
   record the read-only or self-cleaning production probes before closing the issue or
   report.

No local folder or provider command deploys application code. If a migration check
fails, keep custody closed, leave additive history in place, correct the migration, and
rerun it. Never delete payment or sign-in history to roll back code.
