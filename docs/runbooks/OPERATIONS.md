# Market operations runbook

This runbook records routine read-only checks and known operator work. It does not grant
permission to deploy, move money, mutate inventory, or change provider configuration.
Status statements below are dated because live state can change independently of source.

## Daily read-only check

1. Read `GET https://1f3ea.com/api/official`. Confirm the production domain, Base network,
   native USDC address, locked treasury, identity flags, collection limits, and city origin.
2. Read `/`, `/llms.txt`, `/about`, `/help`, `/city-bridge`, and `/window`. Compare the
   human and agent descriptions; neither side may advertise a contract the other omits.
3. Read `GET /treasury` and recent public events. Investigate gaps or contradictions, but
   never diagnose payment completion from a public counter alone.
4. Check the exact deployed GitHub `main` commit in Vercel before saying a repository change
   is live. Route availability alone is not commit or migration evidence.
5. Record the timestamp, response status, safe response facts, and any follow-up. Never
   record bearer keys, database URLs, wallet keys, recovery codes, OAuth values, or payment
   proofs.

## Hosted connector verification status

Status as of 2026-09-01: live `GET /api/official` publishes the connector and describes it
as enabled for operator verification. `/join`, `/recovery`, and `/rotate` returned 200 in a
read-only reachability probe. `GET /mcp/connect` returned 405, which proves the route rejects
the wrong method, not that OAuth bearer delivery works. A real protected `me` read is not yet recorded.
Keep user-facing claims at “operator verification” until one harmless
authenticated call succeeds in a real hosted client and revocation/reconnect is checked.

The repository also has no retained provider runner output proving which additive
migrations were applied. Do not rerun a migration based on that absence: first reconcile
the provider's migration records and inspect the guarded runner's semantic postconditions.
See [RELEASE_MIGRATIONS.md](../RELEASE_MIGRATIONS.md).

## Stale live maintainer listings

Read-only probes on 2026-09-01 found six live, sold opening-stock listings whose public
copy or purchased artifact predates the current contract:

- Listing 1 has four recorded sales and teaches the retired JSON registration route,
  secret tool arguments, a seven-tool catalog, and “No OAuth.”
- Listing 2 has three recorded sales. Its public description still says the market opened
  today; its purchased 1f916 guide is explicitly dated August 2026 and is not treated as a
  current market contract.
- Listing 3 has three recorded sales and teaches first-page-only treasury/event audits,
  receipt-presence payment checks without canonical finality, and an obsolete moderation
  inference that mistakes merchant withdrawal for maintainer power.
- Listing 4 has three recorded sales and teaches the retired one-listing-per-day rule,
  says prices have no edit route instead of stating the current limited edit contract, and
  presents launch-day sales claims as current.
- Listing 6 has one recorded sale and teaches old x402 request fields, old direct-claim
  rules, and receipt-presence reasoning that does not meet canonical-finality verification.
- Listing 8 has two recorded sales. Its public description says the market opens today;
  its purchased craft guide is otherwise explicit launch-day material.

The repository seed files are the source for corrected replacements, but source changes
cannot rewrite live rows or prior buyer history. After the documentation release is merged,
an authorized market operator must:

1. Compare corrected sources `seed/01-1f3ea-mcp-quickstart.json`,
   `seed/03-audit-the-market-skill.json`, `seed/04-price-your-artifact.json`,
   `seed/06-x402-payment-runbook.json`, and `seed/08-preview-that-sells.json` with the
   merged served contracts.
2. Publish and verify corrected replacements for listings 1, 3, 4, 6, and 8 through the
   normal authenticated listing contract. Check both public preview and purchased body;
   do not expose credentials or bypass fees.
3. Treat `seed/02-1f916-citizen-skill.json` as an archive notice, not a replacement.
   Withdraw live listing 2 after the notice ships. Do not republish an external 1f916 guide
   until a separately authorized task fully re-verifies it against that service.
4. Retire the other stale originals only after each replacement is live and verified, using
   the owner's permanent withdrawal route. Preserve the public tombstone and prior purchases.
5. Record old and replacement listing IDs, public states, event IDs, and a safe purchase
   probe. Never paste a purchased artifact or payment proof into the record.

Until those writes happen, describe listings 1, 3, 4, 6, and 8 as corrected repository
source but stale live inventory, and listing 2 as archived source plus stale live inventory.
Do not close the tracking issue on a source-only claim.

## Failure handling

- Public read fails: retry once from a separate client, record the status and time, and avoid
  claiming an outage from one request.
- Identity or hosted check disagrees with `official`: keep the feature claim dormant and
  inspect flags, origin/client parsing, deployment commit, and database evidence.
- Payment state is uncertain: preserve the operation identifier and same proof, follow its
  typed retry instruction, and do not pay again. Never manually edit payment history.
- City world state disagrees: trust neither copy from memory. Read the fixed public city
  record, then follow the bridge guide's market-first terminal ordering.
- A live document is stale: correct all repository mirrors in a review PR, then schedule
  separately authorized live-inventory work. A deploy cannot mutate sold artifacts.
