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

Status as of 2026-09-01: When official facts publishes hosted_connector, hosted discovery works without sign-in. Protected merchant use for a host is proven only after that host completes and records a real protected me read. Recorded proven hosts: none.
Live `GET /api/official` publishes the connector. `/join`, `/recovery`, and `/rotate`
returned 200 in a read-only reachability probe. `GET /mcp/connect` returned 405, which
proves the route rejects the wrong method, not that OAuth bearer delivery works. A real
protected `me` read is not yet recorded for any host. Add a host to the public proof list
only after that host's harmless authenticated call succeeds and the evidence is recorded.

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

### Approval package for listings #1 and #4

No live action was executed by this PR. The owner must approve publication and later
withdrawal separately. Merchant #1, handle `1f3ea-keeper`, is the seller. The read-only
2026-09-01 check found exactly eight keeper listings, so the existing capped first-ten
opening-stock path can publish these two replacements without a fee. This is the existing
keeper path, not a new exception. Stop if an authenticated `GET /api/me` no longer returns
handle `1f3ea-keeper` and `listings_total: 8` before the first command. After the first
publish, require `listings_total: 9` before the second. If either count differs, do not add
a payment or bypass; return to the owner for a new approved plan.

The exact replacement listing text is the unchanged JSON content of these files. Every
`title`, `description`, `preview`, `artifact`, `price_usdc`, and `tags` byte comes from the
named file; the command adds only the keeper's already-public seller wallet:

- Listing #1 replacement: `seed/01-1f3ea-mcp-quickstart.json`, SHA-256
  `CDBFDAF6645490BE7C436C8A958C949F21110DDC3B290A9B18B97962E28CB12B`.
- Listing #4 replacement: `seed/04-price-your-artifact.json`, SHA-256
  `689E95F589E79D3C1C7ABCD1908FDCD4C7A005D6FB0E61D18FDE5008DF9CB0B0`.

Before approval, the operator's approved operating-system vault adapter must load the
keeper key directly into the process-local PowerShell 7 variable `$KeeperToken` as a
`SecureString`. Do not use a plaintext environment variable and never paste the key into
this file, a transcript, or a command. Each command below verifies the credential type,
reviewed file hash, authenticated keeper identity and expected listing count, original
listing owner and state, and the already-public keeper wallet before it sends one write.
It stops without publishing when any check differs. Run it from the repository root at
the approved review commit.

One command for listing #1's replacement:

```powershell
& { if ($null -eq $KeeperToken -or $KeeperToken.GetType().FullName -ne 'System.Security.SecureString') { throw 'KeeperToken must be a SecureString loaded by the approved vault adapter.' }; $seedPath = 'seed/01-1f3ea-mcp-quickstart.json'; if ((Get-FileHash -Algorithm SHA256 -LiteralPath $seedPath).Hash -ne 'CDBFDAF6645490BE7C436C8A958C949F21110DDC3B290A9B18B97962E28CB12B') { throw 'Seed file hash mismatch.' }; $me = Invoke-RestMethod -Uri 'https://1f3ea.com/api/me' -Authentication Bearer -Token $KeeperToken; if ($me.handle -ne '1f3ea-keeper' -or [int]$me.listings_total -ne 8) { throw 'Keeper identity or listing count changed; stop.' }; $original = (Invoke-RestMethod -Uri 'https://1f3ea.com/api/listing/1').listing; if ([int]$original.id -ne 1 -or $original.merchant -ne '1f3ea-keeper' -or $original.state -ne 'live' -or $original.seller_wallet -ne '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd') { throw 'Original listing #1 no longer matches the approved keeper listing.' }; $body = Get-Content -LiteralPath $seedPath -Raw | ConvertFrom-Json; $body | Add-Member -NotePropertyName seller_wallet -NotePropertyValue $original.seller_wallet; Invoke-RestMethod -Method Post -Uri 'https://1f3ea.com/api/listing' -Authentication Bearer -Token $KeeperToken -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress -Depth 5) }
```

One command for listing #4's replacement:

```powershell
& { if ($null -eq $KeeperToken -or $KeeperToken.GetType().FullName -ne 'System.Security.SecureString') { throw 'KeeperToken must be a SecureString loaded by the approved vault adapter.' }; $seedPath = 'seed/04-price-your-artifact.json'; if ((Get-FileHash -Algorithm SHA256 -LiteralPath $seedPath).Hash -ne '689E95F589E79D3C1C7ABCD1908FDCD4C7A005D6FB0E61D18FDE5008DF9CB0B0') { throw 'Seed file hash mismatch.' }; $me = Invoke-RestMethod -Uri 'https://1f3ea.com/api/me' -Authentication Bearer -Token $KeeperToken; if ($me.handle -ne '1f3ea-keeper' -or [int]$me.listings_total -ne 9) { throw 'Keeper identity or listing count changed; stop.' }; $original = (Invoke-RestMethod -Uri 'https://1f3ea.com/api/listing/4').listing; if ([int]$original.id -ne 4 -or $original.merchant -ne '1f3ea-keeper' -or $original.state -ne 'live' -or $original.seller_wallet -ne '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd') { throw 'Original listing #4 no longer matches the approved keeper listing.' }; $body = Get-Content -LiteralPath $seedPath -Raw | ConvertFrom-Json; $body | Add-Member -NotePropertyName seller_wallet -NotePropertyValue $original.seller_wallet; Invoke-RestMethod -Method Post -Uri 'https://1f3ea.com/api/listing' -Authentication Bearer -Token $KeeperToken -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress -Depth 5) }
```

Record each returned replacement ID. Read it back publicly and compare its public fields
with the exact source file. Perform a separately approved safe acquisition and compare the
delivered artifact before asking the owner to approve retirement. Never combine publishing,
verification, and withdrawal in one command.

Only after that approval, permanently withdraw each stale original with its own command:

```powershell
Invoke-RestMethod -Method Post -Uri 'https://1f3ea.com/api/listing/1/withdraw' -Authentication Bearer -Token $KeeperToken -ContentType 'application/json' -Body '{}'
```

```powershell
Invoke-RestMethod -Method Post -Uri 'https://1f3ea.com/api/listing/4/withdraw' -Authentication Bearer -Token $KeeperToken -ContentType 'application/json' -Body '{}'
```

Confirm each original now exposes the fixed `withdrawn by merchant` tombstone, while prior
buyers and completed sales remain. Record replacement IDs and safe verification evidence.

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
