# Release migrations

The direct-payment, hosted-sign-in, save-first identity, coding-client-identity,
world-payment-finality, and x402-attempt changes have six additive database changes:

1. `db/migrations/20260823_direct_payments.sql`
2. `db/migrations/20260822_hosted_market_signin.sql`
3. `db/migrations/20260827_market_identity.sql`
4. `db/migrations/20260902_market_identity_json_doors.sql`
5. `db/migrations/20260827_world_payment_finality.sql`
6. `db/migrations/20260828_x402_payment_attempts.sql`

## Recorded application status

**Status as of 2026-09-01:** this repository contains no retained provider log or
successful guarded-runner transcript for any of the six preview or production applications. The
honest state is therefore “not recorded here,” not “not applied.” Route availability does not prove a migration was applied:
code can expose a route before its first database write,
and flags can describe intent without showing schema postconditions. In particular,
`MARKET_IDENTITY_RECOVERY_ENABLED` and `MARKET_IDENTITY_ROTATION_ENABLED` are already `true` in
production (see README.md), which is evidence only for `20260827_market_identity.sql` — it is
not evidence that `20260902_market_identity_json_doors.sql` ran. That migration has its own
gate, `MARKET_CODING_IDENTITY_ENABLED`, precisely so the two are never conflated.

| Migration file | Preview evidence in this repository | Production evidence in this repository |
|---|---|---|
| `20260823_direct_payments.sql` | **Not recorded.** | **Not recorded.** Reconcile provider history and rerun the guarded semantic inspection before deciding whether any action is needed. |
| `20260822_hosted_market_signin.sql` | **Not recorded.** | **Not recorded.** Reachable OAuth or identity routes are insufficient evidence. |
| `20260827_market_identity.sql` | **Not recorded.** | **Not recorded.** Reachable `/join`, `/recovery`, and `/rotate` pages are insufficient evidence. |
| `20260902_market_identity_json_doors.sql` | **2026-09-03 01:06Z**, runner `market-coding-identity`, fresh preview branch `br-curly-thunder-aw4b3209` (created from production parent `br-plain-moon-awqm279s`; the pinned `br-shy-sea-aw8771mn` was found stale and unusable), endpoint `ep-hidden-sound-aweqyvaa.c-12.us-east-1.aws.neon.tech`, database `neondb`. Runner reported `{"target":"preview","migration":"market-coding-identity","database":"neondb","endpoint":"ep-hidden-sound-aweqyvaa.c-12.us-east-1.aws.neon.tech","statements":8,"postconditions":20}`, exit 0. Read-only check confirmed `merchant_pairing_codes` (`id`, `merchant_id`, `code_hash`, `created_at`, `expires_at`, `used_at`, `invalidated_at`) and the widened `merchant_identity_rate_limits_attempt_kind_allowed` constraint including `pair_create`. Rehearsal branch deleted afterward. See "Recorded run evidence: market-coding-identity" below. | **2026-09-03 01:06Z**, runner `market-coding-identity`, production endpoint `ep-blue-lab-awti0skv.c-12.us-east-1.aws.neon.tech`, database `neondb`, preceded by labelled snapshot branch `snapshot/pre-coding-identity-20260903-0106` (`br-floral-base-aw54cx5o`). Runner reported `{"target":"production","migration":"market-coding-identity","database":"neondb","endpoint":"ep-blue-lab-awti0skv.c-12.us-east-1.aws.neon.tech","statements":8,"postconditions":20}`, exit 0. Read-only verification confirmed the same columns and constraint; `listings` 18 and `merchants` 23 unchanged. Live smoke with `MARKET_CODING_IDENTITY_ENABLED` still unset: `/api/official` `coding_client_doors` `null`; `POST /api/register` and `POST /api/pair` answer 503 `coding_identity_dormant`; `/join` 200. The flag has **not** been set yet — the four coding-client doors remain dormant until an operator sets it and redeploys. See "Recorded run evidence: market-coding-identity" below. |
| `20260827_world_payment_finality.sql` | **Not recorded.** | **Not recorded.** Served finality copy and application tests do not prove the production writer fence exists. |
| `20260828_x402_payment_attempts.sql` | **Not recorded.** | **Not recorded.** Source support for durable attempts does not prove its production table and triggers exist. |

Before any new run, inspect provider migration records and the target schema without
changing it. Then use the guarded runner for the intended target and require every declared
semantic postcondition. Never apply a migration merely because this documentation lacks a
receipt, and never rewrite this table from inference; record the dated runner evidence.

Do not use the full `db/schema.sql` as a remote release migration. It contains the
whole market history, while these files contain only their reviewed additions.
The market-identity migration extends the hosted-sign-in tables, so apply hosted sign-in
before market identity on an environment that has neither. The coding-client-identity
migration (`market-coding-identity`) in turn extends market-identity — it adds the
`merchant_pairing_codes` table and widens `merchant_identity_rate_limits_attempt_kind_allowed`
to accept `pair_create` — so apply market-identity first on an environment that has neither.

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

`market-coding-identity` is additive and unrelated to payment custody, but it is deliberately
not folded into the first-three schema-first group: production can already have both
`MARKET_IDENTITY_RECOVERY_ENABLED` and `MARKET_IDENTITY_ROTATION_ENABLED` set to `true` from
the market-identity migration while this later one has never run, and the application code
gates the four coding-client doors (`/api/register`, `/api/rotate`, `/api/recovery`,
`/api/pair`) on the separate `MARKET_CODING_IDENTITY_ENABLED` flag for exactly that reason —
so run this migration and require its postconditions before setting that flag, never merely
because the two identity flags are already on.

## Recorded run evidence: market-coding-identity

- **2026-09-03 01:06Z, preview rehearsal.** The pinned preview branch (`br-shy-sea-aw8771mn`,
  created 2026-08-23) was found stale (17 tables, no market-identity tables) and unusable, so
  a fresh Neon branch was created from production (parent `br-plain-moon-awqm279s`, branch
  `br-curly-thunder-aw4b3209`, endpoint `ep-hidden-sound-aweqyvaa.c-12.us-east-1.aws.neon.tech`,
  database `neondb`).
  `npm run migrate:preview:market-coding-identity -- --database neondb --endpoint ep-hidden-sound-aweqyvaa.c-12.us-east-1.aws.neon.tech --production-endpoint ep-blue-lab-awti0skv.c-12.us-east-1.aws.neon.tech`
  reported
  `{"target":"preview","migration":"market-coding-identity","database":"neondb","endpoint":"ep-hidden-sound-aweqyvaa.c-12.us-east-1.aws.neon.tech","statements":8,"postconditions":20}`,
  exit 0. A read-only check found `merchant_pairing_codes` with columns `id`, `merchant_id`,
  `code_hash`, `created_at`, `expires_at`, `used_at`, `invalidated_at` and
  `merchant_identity_rate_limits_attempt_kind_allowed` including `pair_create`. The rehearsal
  branch was deleted afterwards.
- **2026-09-03 01:06Z, production.** A labelled snapshot branch
  `snapshot/pre-coding-identity-20260903-0106` (`br-floral-base-aw54cx5o`) was taken from
  production first.
  `npm run migrate:production:market-coding-identity -- --database neondb --endpoint ep-blue-lab-awti0skv.c-12.us-east-1.aws.neon.tech`
  reported
  `{"target":"production","migration":"market-coding-identity","database":"neondb","endpoint":"ep-blue-lab-awti0skv.c-12.us-east-1.aws.neon.tech","statements":8,"postconditions":20}`,
  exit 0. Read-only verification: the same columns and constraint; `listings` 18 and
  `merchants` 23 unchanged. Live smoke with `MARKET_CODING_IDENTITY_ENABLED` still unset:
  `/api/official` `coding_client_doors` `null`; `POST /api/register` and `POST /api/pair`
  answer 503 `coding_identity_dormant`; `/join` 200. The flag has **not** been set yet; the
  doors remain dormant until an operator sets it and redeploys.
- **Operator finding.** The pinned preview branch `br-shy-sea-aw8771mn` is stale relative to
  production (missing the 2026-08-27 and 2026-08-28 migrations) and should be recreated from
  production or migrated before it is used as evidence for anything.

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

Then run the coding-client-identity migration separately, after market-identity:

```text
npm run migrate:preview:market-coding-identity -- --database <expected-database> --endpoint <exact-non-pooled-hostname> --production-endpoint <exact-production-hostname>
```

Require its runner to report the `merchant_pairing_codes` table (with its `invalidated_at`
column) and the widened `merchant_identity_rate_limits_attempt_kind_allowed` constraint
present, then set `MARKET_CODING_IDENTITY_ENABLED=true` and redeploy before treating
`/api/register`, `/api/rotate`, `/api/recovery`, or `/api/pair` as live in preview.

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
until their own live checks pass.

Then run the coding-client-identity migration, separately after market-identity:

```text
npm run migrate:production:market-coding-identity -- --database <expected-database> --endpoint <exact-non-pooled-hostname>
```

Require its runner to report the `merchant_pairing_codes` table (with its `invalidated_at`
column) and the widened `merchant_identity_rate_limits_attempt_kind_allowed` constraint
present. Only then set `MARKET_CODING_IDENTITY_ENABLED=true` and redeploy — production
already having both `MARKET_IDENTITY_RECOVERY_ENABLED` and `MARKET_IDENTITY_ROTATION_ENABLED`
set to `true` is not sufficient by itself, and `/api/register`, `/api/rotate`,
`/api/recovery`, and `/api/pair` keep answering 503 with no side effect until this migration
has run and that flag is set, even while `/join`, `/recovery`, and `/rotate` are already live.

Then use this strict order for
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
