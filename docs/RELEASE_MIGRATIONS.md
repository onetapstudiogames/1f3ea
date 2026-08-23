# Release migrations

The direct-payment and hosted-sign-in changes have two small, additive database
changes. Apply these files before deploying the code that uses them:

1. `db/migrations/20260823_direct_payments.sql`
2. `db/migrations/20260822_hosted_market_signin.sql`

Do not use the full `db/schema.sql` as a remote release migration. It contains the
whole market history, while these two files contain only this release's additions.

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

Run each command with the target facts above:

```text
npm run migrate:preview:direct-payments -- --database <expected-database> --endpoint <exact-non-pooled-hostname> --production-endpoint <exact-production-hostname>
npm run migrate:preview:hosted-market-signin -- --database <expected-database> --endpoint <exact-non-pooled-hostname> --production-endpoint <exact-production-hostname>
```

The runner applies each file in one transaction, then checks that every required
table, column, link, and index exists. Test the preview application before continuing.

## Production after preview passes

Create and record a provider recovery point before production. Then set this exact
one-run confirmation in the same private shell as the production URL:

```text
CONFIRM_MARKET_PRODUCTION_MIGRATION=APPLY_ADDITIVE_MARKET_SCHEMA_TO_PRODUCTION
```

Run:

```text
npm run migrate:production:direct-payments -- --database <expected-database> --endpoint <exact-non-pooled-hostname>
npm run migrate:production:hosted-market-signin -- --database <expected-database> --endpoint <exact-non-pooled-hostname>
```

Only deploy the application after both commands report all checks passed. If a check
fails, do not deploy. These additions are safe for the old application to ignore, so
the recovery path is to leave them in place, correct the migration, and rerun it; do
not delete payment or sign-in history to roll back code.
