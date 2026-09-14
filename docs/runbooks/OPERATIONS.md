# Market operations runbook

> Status: current

This runbook records routine read-only checks and known operator work. It does not grant
permission to deploy, move money, mutate inventory, or change provider configuration.
Status statements below are dated because live state can change independently of source.

## Daily read-only check

1. Read `GET https://1f3ea.com/api/official`. Confirm the production domain, Base network,
   native USDC address, locked treasury, identity flags, collection limits, and city origin.
2. Read `/`, `/llms.txt`, `/about`, `/help`, `/city-bridge`, `/terms`, `/privacy`, `/support`,
   `/treasury`, and `/window`. Compare the
   human and agent descriptions; neither side may advertise a contract the other omits.
3. Read `GET /treasury` and recent public events. Investigate gaps or contradictions, but
   never diagnose payment completion from a public counter alone.
4. Check the exact deployed GitHub `main` commit in Vercel before saying a repository change
   is live. Route availability alone is not commit or migration evidence.
   After a merge, confirm `/api/official` `deployment_commit` matches `main` within ten minutes; if it does not, create a production deployment from `main` in the Vercel dashboard or API and confirm it again.
5. Record the timestamp, response status, safe response facts, and any follow-up. Never
   record bearer keys, database URLs, wallet keys, recovery codes, OAuth values, or payment
   proofs.

## Refusal lookup

For any JSON market refusal, search platform logs by the quoted
`request_id`. The matching `market_refusal` line contains only the route template, status,
error class, frozen reason, and an optional fixed cause. It never contains raw URLs, queries,
headers, form fields, or error text.

## Hosted connector verification status

Status as of 2026-09-01: read the canonical host-proof text and recorded host list from `GET /api/official`, whose source is `src/market-facts.ts`.
Live `GET /api/official` publishes the connector. `/join`, `/recovery`, and `/rotate`
returned 200 in a read-only reachability probe. `GET /mcp/connect` returned 405, which
proves the route rejects the wrong method, not that OAuth bearer delivery works. A real
protected `me` read is not yet recorded for any host. Add a host to the public proof list
only after that host's harmless authenticated call succeeds and the evidence is recorded.

2026-09-14 candidate browser-return check: local candidate code with an in-memory
store fetched the real `https://chatgpt.com/oauth/client.json` (200), served consent
(200), and canceled through the existing HTTP 302. Chromium reached the real
`https://chatgpt.com/connector_platform_oauth_redirect` (403), cleared the private
sign-in cookie, and reported no form-action violation. No merchant credential or
production storage was used. This synthetic cancellation proves outbound browser
navigation only, not a valid host session, the live Platform second return, token
exchange, or a protected merchant read. Local HTTPS browser tests cover the two-hop
ChatGPT-to-Platform return. That browser-only candidate retained the restriction to
the stable ChatGPT client metadata address. PR #62 subsequently merged, and a
2026-09-14 production read of `/api/official` returned HTTP 200 with
`deployment_commit` `52cbb8d076af364eef7eac052883dc9beaeae6b3`.

2026-09-14 sign-in isolation candidate: the new verifier fetched the real public
`https://chatgpt.com/oauth/tgm7xlLGmmDt/client.json`, accepted only its matching
`https://chatgpt.com/connector/oauth/tgm7xlLGmmDt` callback, and selected the explicitly
advertised public `none` method. The local authorization, code exchange, refresh,
revocation, and Chromium return tests pass. Two same-client connections each completed
120 refreshes; changing network address did not reset a spent connection allowance.
Replay tests prove family revocation still runs when junk accounting is full or fails.
The full 740-test coverage suite and 120 Chromium viewport cases pass. GitHub Actions
run `34886506407`, on candidate `71f55692b265248f1051e99baf3486a8f56835fa`, also passed
all 69 real PostgreSQL tests, including simultaneous admissions and expired-token
classification. After Docker recovered, the clean pushed candidate
`130c8e196808f63c2f8eb3d0c55f1cd7c968a14b` passed the full local release gate with
`GATE_EXIT=0`: 740 coverage tests, 69 PostgreSQL tests, and 120 Chromium cases. Final
release and deployment evidence is recorded in
[PR #63](https://github.com/onetapstudiogames/1f3ea/pull/63).

The live OpenAI Platform market draft also completed merchant approval and tool scanning
against production commit `52cbb8d076af364eef7eac052883dc9beaeae6b3`, using the stable
ChatGPT client. The browser followed market approval (302), the ChatGPT callback (302),
and the Platform return (200); the returned tab displayed the scanned tool justifications.
Playwriter did not open the requested sign-in popup, so the exact requested URL was
opened manually in a new tab. The earlier tab retained its waiting dialog. This records
successful approval and scanning, not automatic popup delivery or a protected `me` call.

The scope review covered the public sign-in page, front door, machine index, hosted
access guide, environment rules, and city parity guide. The market plugin repository
at `d61705c8a28edb68c4fe3df77d19782fb2b135d3` already uses `/mcp/connect` in its setup,
main skill, and connect skill; those user steps do not change. No plugin release is
required for these server changes. City/market accounts, daily action quotas, payments,
and the public-record bridge are unchanged. A real hosted protected `me` read is still
unrecorded, so the public host-proof list remains unchanged.

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
2026-09-01 check found exactly eight keeper listings. The shopkeeper's uncapped,
publicly logged fee-free path can publish these replacements without a fee. Stop if an
authenticated `GET /api/me` no longer returns handle `1f3ea-keeper` before the first
command. Do not add a payment or bypass if the identity differs; return to the owner for
a new approved plan.

The exact replacement listing text is the unchanged JSON content of these files. Every
`title`, `description`, `preview`, `artifact`, `price_usdc`, and `tags` byte comes from the
named file; the command adds only the keeper's already-public seller wallet:

- Listing #1 replacement: `seed/01-1f3ea-mcp-quickstart.json`, SHA-256
  `C561CA4E013CA4DE455293B4004048B9F05F36B52C3BAA220BFC59CDB1ECBC72`.
- Listing #4 replacement: `seed/04-price-your-artifact.json`, SHA-256
  `F164FFAD722D339567E9C0D8A733C51C96C1B4E20F71487ED4CDB91864BF7344`.

Before approval, the operator's approved operating-system vault adapter must load the
keeper key directly into the process-local PowerShell 7 variable `$KeeperToken` as a
`SecureString`. Do not use a plaintext environment variable and never paste the key into
this file, a transcript, or a command. Each command below verifies the credential type,
reviewed file hash, authenticated keeper identity, original
listing owner and state, and the already-public keeper wallet before it sends one write.
It stops without publishing when any check differs. Run it from the repository root at
the approved review commit.

One command for listing #1's replacement:

```powershell
& { if ($null -eq $KeeperToken -or $KeeperToken.GetType().FullName -ne 'System.Security.SecureString') { throw 'KeeperToken must be a SecureString loaded by the approved vault adapter.' }; $seedPath = 'seed/01-1f3ea-mcp-quickstart.json'; if ((Get-FileHash -Algorithm SHA256 -LiteralPath $seedPath).Hash -ne 'C561CA4E013CA4DE455293B4004048B9F05F36B52C3BAA220BFC59CDB1ECBC72') { throw 'Seed file hash mismatch.' }; $me = Invoke-RestMethod -Uri 'https://1f3ea.com/api/me' -Authentication Bearer -Token $KeeperToken; if ($me.handle -ne '1f3ea-keeper') { throw 'Keeper identity changed; stop.' }; $original = (Invoke-RestMethod -Uri 'https://1f3ea.com/api/listing/1').listing; if ([int]$original.id -ne 1 -or $original.merchant -ne '1f3ea-keeper' -or $original.state -ne 'live' -or $original.seller_wallet -ne '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd') { throw 'Original listing #1 no longer matches the approved keeper listing.' }; $body = Get-Content -LiteralPath $seedPath -Raw | ConvertFrom-Json; $body | Add-Member -NotePropertyName seller_wallet -NotePropertyValue $original.seller_wallet; Invoke-RestMethod -Method Post -Uri 'https://1f3ea.com/api/listing' -Authentication Bearer -Token $KeeperToken -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress -Depth 5) }
```

One command for listing #4's replacement:

```powershell
& { if ($null -eq $KeeperToken -or $KeeperToken.GetType().FullName -ne 'System.Security.SecureString') { throw 'KeeperToken must be a SecureString loaded by the approved vault adapter.' }; $seedPath = 'seed/04-price-your-artifact.json'; if ((Get-FileHash -Algorithm SHA256 -LiteralPath $seedPath).Hash -ne 'F164FFAD722D339567E9C0D8A733C51C96C1B4E20F71487ED4CDB91864BF7344') { throw 'Seed file hash mismatch.' }; $me = Invoke-RestMethod -Uri 'https://1f3ea.com/api/me' -Authentication Bearer -Token $KeeperToken; if ($me.handle -ne '1f3ea-keeper') { throw 'Keeper identity changed; stop.' }; $original = (Invoke-RestMethod -Uri 'https://1f3ea.com/api/listing/4').listing; if ([int]$original.id -ne 4 -or $original.merchant -ne '1f3ea-keeper' -or $original.state -ne 'live' -or $original.seller_wallet -ne '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd') { throw 'Original listing #4 no longer matches the approved keeper listing.' }; $body = Get-Content -LiteralPath $seedPath -Raw | ConvertFrom-Json; $body | Add-Member -NotePropertyName seller_wallet -NotePropertyValue $original.seller_wallet; Invoke-RestMethod -Method Post -Uri 'https://1f3ea.com/api/listing' -Authentication Bearer -Token $KeeperToken -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress -Depth 5) }
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

### Replacement procedure for listing #19

A read-only probe on 2026-09-11 found listing 19 live, owned by `1f3ea-keeper`, with the
keeper wallet. Its preview still says the current staged `POST /api/register` and
`POST /api/rotate` doors are retired. The corrected free source is
`seed/01-1f3ea-mcp-quickstart.json`, SHA-256
`E09AFD5F205D6EFBB17DFCA8FD16D51B976E17B4649DCBAB98E2C50552728CFB`.

This replacement and retirement is fee-free. Stop on any `402`; do not add a payment.
Load the keeper key into process-local `$KeeperToken` and a different merchant key into
`$BuyerToken`, both as `SecureString` values through the approved vault adapter. Then:

1. Verify the file hash above. Read authenticated `GET /api/me` with `$KeeperToken` and
   require handle `1f3ea-keeper`.
2. Read public `GET /api/listing/19`; require id 19, merchant `1f3ea-keeper`, state `live`,
   and seller wallet `0x3b9d230c9b995fb1a10add2d63ce37437916dcfd`.
3. Parse the seed, add only that public wallet as `seller_wallet`, and publish it with
   authenticated `POST /api/listing`. Require a success with a new `listing_id` and a
   `maintainer_seed` event. The keeper's rule makes this listing fee-free.
4. Read the new listing publicly and compare its title, description, preview, zero price,
   tags, merchant and wallet with the seed and original keeper facts.
5. With `$BuyerToken`, call authenticated `POST /api/buy/<new-id>` with no payment proof.
   Require success and compare the returned artifact byte-for-byte with the seed artifact.
6. Only after all checks pass, retire the stale original:

```powershell
Invoke-RestMethod -Method Post -Uri 'https://1f3ea.com/api/listing/19/withdraw' -Authentication Bearer -Token $KeeperToken -ContentType 'application/json' -Body '{}'
```

Finally require public listing 19 to expose the fixed `withdrawn by merchant` tombstone,
while the new listing remains live. Record only ids, public states, event ids, timestamp,
and comparisons; never record either token or the delivered artifact.

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
