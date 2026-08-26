# Unshittily Work Receipt

- **Task ID:** UNSLY-20260826-ACTION-FAILURE-CAUSES-MARKET
- **Project:** 1F3EA at `C:\Users\Owner\Documents\1f3ea`
- **Created:** 2026-08-26T11:35:00Z

## Plain-English Outcome

**Outcome:** INVALID - UNEXPECTED PROJECT CHANGE

The market failure-contract sweep is implemented, green, and independently approved. Every market and world action returns a caller-facing cause, and payment, chain, database, OAuth, API, and MCP failures retain distinct meanings. This receipt is nevertheless INVALID because the coverage tool deleted 23 pre-existing ignored `coverage/tmp` JSON artifacts recorded by the change guard. No tracked or product source was lost, but those exact temporary bytes cannot be recovered, so the guard cannot certify this run.

## Execution Contract

- **Requested task:** Sweep every market action verb for cause-less or falsely classified failures, preserve the cause through raw JSON and MCP, keep the human window truthful, update caller contracts, run full verification, and prepare one unmerged pull request.
- **Non-goals:** Mutate live listings, purchases, wallets, OAuth tokens, or city records; spend money; merge or deploy; add write controls to the read-only human window; or fix adjacent transactionality and missing-cancel findings.
- **External effects authorized:** Read-only live market/facilitator/Base probes, then later push one branch and open one unmerged pull request. No production write or payment was authorized or performed.

## Baseline and Protected Work

- **Pre-existing work:** The repository began at the merged observation-window baseline. The existing human window, source contract test, tracked files, and unrelated work were protected; an accidentally touched source test was restored byte-for-byte before the final diff.
- **Declared files:** `docs/FRONTDOOR.md`, `src/chain.ts`, `src/door.ts`, `src/frontdoor.txt`, `src/index.ts`, `src/llms.txt`, `src/market-oauth-config.ts`, `src/market-oauth.ts`, `src/mcp.ts`, `src/pay.ts`, `src/postgres-error.ts`, `src/world-routes.ts`, `test/chain-failures.test.ts`, `test/chain.test.ts`, `test/direct-payment-routes.test.ts`, `test/direct-payments.test.ts`, `test/market-oauth-config.test.ts`, `test/market-oauth-flow.test.ts`, `test/mcp-protocol-edges.test.ts`, `test/pay-failures.test.ts`, `test/postgres-error.test.ts`, `test/routes.test.ts`, `test/world-routes.test.ts`
- **Protected areas:** Database schema and migrations, wallet custody and limits, production market/city state, the read-only window design, unrelated docs and tests, and every path outside the declared set.

## Impact and Connection Map

Market actions enter through raw JSON or an MCP tool, validate identity and input, may call PostgreSQL, Base RPC, an x402 facilitator, OAuth storage, or the sibling city, and then translate the result back through the caller's door. The fix establishes explicit caller-invalid, unclassified-upstream, unavailable/retryable, conflict, and internal results at those boundaries. Raw API routes map them to honest status codes and `{ "error": "..." }`; MCP retains that body and marks failures. The human shop window exposes no action verbs or credentials, remains read-only, and continues to distinguish failed reads from empty results.

## Design and Root Cause

- **Root cause addressed:** YES
- **Why durable:** Shared boundary functions now return typed outcomes instead of booleans or generic catches. PostgreSQL unique conflicts are named only when the exact constraint matches the requested action. X402 maps only allowlisted caller defects to 402, keeps protocol-ambiguous 4xx rejections at 502, and treats unknown explicit verification faults as retryable 503. Base RPC faults remain distinct from invalid proofs. OAuth revocation no longer swallows rate/storage failures into false 200 success.
- **Similar paths checked:** Registration, secret rotation, storefront update, ordinary listing/create/edit/withdraw, purchase intent, buy, direct claim, comment, vote, flag, moderation remove/pin, world draft/activation/checkout/sync, x402 verify/settle, direct Base proof, OAuth authorization/token/revocation, raw JSON, ordinary/hosted MCP, and the read-only window boundary.

## Acceptance Checks

### AC-001: Every reachable market and world action refusal names its cause

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-003

### AC-002: Payment and chain failures distinguish caller mistakes from ambiguous or unavailable verification

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-001

### AC-003: OAuth revocation never reports operational failure as success

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-001

### AC-004: Raw JSON, MCP, and published contracts preserve the same cause

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-003

### AC-005: The read-only human window is not regressed into a write surface or silent empty state

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-004

### AC-006: The exact final product source is independently approved

- **Required:** YES
- **Status:** PROVEN
- **Evidence:** EVD-006

## Changes Made

### CHG-001: Classify database and route failures by their actual cause

- **Paths:** `src/index.ts`, `src/postgres-error.ts`, `test/postgres-error.test.ts`, `test/routes.test.ts`
- **Requirement:** AC-001
- **Why:** A PostgreSQL code alone cannot say which caller rule failed; exact constraint provenance prevents unrelated unique or database faults from being mislabeled as a known conflict.

### CHG-002: Separate invalid payment proofs from verifier failure

- **Paths:** `src/chain.ts`, `src/pay.ts`, `test/chain-failures.test.ts`, `test/direct-payment-routes.test.ts`, `test/pay-failures.test.ts`
- **Requirement:** AC-002
- **Why:** Boolean and catch-all payment results made outages and unknown facilitator verdicts look like caller mistakes, encouraging replacement proofs or duplicate payment.

### CHG-003: Carry the same distinctions through world actions

- **Paths:** `src/world-routes.ts`, `test/world-routes.test.ts`
- **Requirement:** AC-001, AC-002
- **Why:** World listing and checkout actions use the same money and sibling-service boundaries and must not collapse their causes.

### CHG-004: Make OAuth caller and operational outcomes honest

- **Paths:** `src/market-oauth-config.ts`, `src/market-oauth.ts`, `test/market-oauth-config.test.ts`, `test/market-oauth-flow.test.ts`
- **Requirement:** AC-003
- **Why:** Revocation previously swallowed rate-limit and storage failures into empty 200 responses even when the token family remained active. The repaired 429/503 responses remain token-state opaque, name the cause, and state the exact hourly rule.

### CHG-005: Preserve and document the cause through public doors

- **Paths:** `src/door.ts`, `src/frontdoor.txt`, `src/llms.txt`, `src/mcp.ts`, `test/mcp-protocol-edges.test.ts`
- **Requirement:** AC-004, AC-005
- **Why:** Callers need the same 402/502/503 and OAuth meanings before acting, and MCP must retain the raw API cause rather than translating it away.

## Pre-Change Proof

- **Method:** FAILING TEST
- **Observed before implementation:** New tests showed unrelated PostgreSQL faults mislabeled as known conflicts, Base/facilitator outages collapsed with invalid proof, unknown x402 failures returned caller-invalid 402, and OAuth revocation rate/storage failures returned empty 200 while the access token remained usable. Existing catch and translation paths also lacked per-verb cause assertions.
- **Observed after implementation:** Exact constraints determine conflicts; every verb test receives a non-empty cause; payment outcomes retain 402/502/503 distinctions; revocation uses opaque 200 only for malformed or unknown-token no-ops, 429 with the 120-per-UTC-hour rule and conservative 3,600-second retry for rate refusal, and 503 for operational failure.

## Anti-Band-Aid Gate

- **Tests weakened:** NO
- **Errors hidden:** NO
- **Silent fallback added:** NO
- **Hardcoded workaround added:** NO
- **Duplicate rule added:** NO
- **Permission or security loosened:** NO
- **Unnecessary dependency added:** NO
- **Suppression or skip added:** NO
- **Old implementation left active:** NO

## Verification Evidence

### EVD-001: Test-first payment and OAuth failure regressions

- **Check:** Focused Node tests in `test/pay-failures.test.ts`, `test/routes.test.ts`, `test/market-oauth-flow.test.ts`, and `test/mcp-protocol-edges.test.ts`
- **Working folder:** `C:\Users\Owner\Documents\1f3ea`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** New cases first failed on unknown x402 402 classification, silent revocation 200, and the false one-second hourly retry. After repair, affected OAuth/MCP tests passed 22/22 and all payment route cases passed.
- **Side effects:** NONE

### EVD-002: TypeScript typecheck

- **Check:** `npm run typecheck`
- **Working folder:** `C:\Users\Owner\Documents\1f3ea`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** TypeScript completed without diagnostics on the final source.
- **Side effects:** NONE

### EVD-003: Full unit and integration suite

- **Check:** `npm test`
- **Working folder:** `C:\Users\Owner\Documents\1f3ea`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** 275/275 tests passed on the final implementation.
- **Side effects:** Local mocked and in-memory test work only.

### EVD-004: Human-window browser matrix

- **Check:** `npm run test:e2e`
- **Working folder:** `C:\Users\Owner\Documents\1f3ea`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** 30/30 Playwright tests passed across phone, tablet, desktop, light, and dark projects. The window remains read-only and renders failed reads distinctly from empty results.
- **Side effects:** Playwright's generated `test-results` artifact was removed after verifying its resolved path inside this repository; no product file changed.

### EVD-005: Coverage threshold run before the final narrow OAuth/payment review patches

- **Check:** `npm run test:coverage`
- **Working folder:** `C:\Users\Owner\Documents\1f3ea`
- **Exit code:** 0
- **Result:** PASSED
- **Important output:** 95.78% statements/lines, 82.76% branches, and 96.24% functions, above the 80% project thresholds. The final added branches are directly exercised, but coverage was not rerun after c8 deleted baseline temp artifacts.
- **Side effects:** c8 deleted 23 ignored pre-existing `coverage/tmp` JSON files; this caused the guard-invalid outcome.

### EVD-006: Independent final review

- **Check:** Fresh read-only overseer review of sealed source digest `f60ed5d3d03aa37b26ca71b64025e29e99e8e859dd6036e3f34ecc54e03dd06c`
- **Working folder:** `C:\Users\Owner\Documents\1f3ea`
- **Exit code:** NOT APPLICABLE
- **Result:** MANUAL
- **Important output:** APPROVED with 0 blockers, 0 Critical, 0 High, and 0 Medium findings. The reviewer independently confirmed the digest, typecheck, affected 22/22 tests, full 275/275 suite on the immediately preceding product state, exact constraints, every verb/door, redaction, docs, and diff integrity.
- **Side effects:** NONE

### EVD-007: Read-only live external boundary probes

- **Check:** No-payment probes against `https://facilitator.payai.network/verify`, `https://mainnet.base.org`, and public 1F3EA OAuth metadata
- **Working folder:** `C:\Users\Owner\Documents\1f3ea`
- **Exit code:** 0
- **Result:** MANUAL
- **Important output:** The live facilitator returned a 400 response to an empty invalid proof, Base reported a zero transaction hash as not found, and public OAuth metadata remained readable. These probes characterized real outside response shapes without creating a listing, purchase, token, or payment.
- **Side effects:** External request logs only; no durable application state or money movement.

### EVD-008: Guard integrity check

- **Check:** `change_guard.py digest` and `change_guard.py finish`
- **Working folder:** `C:\Users\Owner\Documents\1f3ea`
- **Exit code:** 1
- **Result:** FAILED
- **Important output:** Product changes were all claimed and sealed with no changed-after-seal paths, but 23 baseline ignored coverage temp files were missing.
- **Side effects:** NONE

## Reviewer Findings

- **Specialist review:** COMPLETED
- **Specialist reviewed state digest:** f60ed5d3d03aa37b26ca71b64025e29e99e8e859dd6036e3f34ecc54e03dd06c
- **Blockers remaining:** 0
- **High issues remaining:** 0
- **Other issues:** NONE in the requested product scope; the guard-integrity failure remains.

## Overseer Decision

- **Fresh overseer:** COMPLETED
- **Reviewer separation:** CONFIRMED
- **Decision:** APPROVED
- **Overseen state digest:** f60ed5d3d03aa37b26ca71b64025e29e99e8e859dd6036e3f34ecc54e03dd06c

## Change Guard Result

- **Result:** UNEXPECTED END-STATE CHANGE
- **Final state digest:** f60ed5d3d03aa37b26ca71b64025e29e99e8e859dd6036e3f34ecc54e03dd06c
- **Verification state digest:** f60ed5d3d03aa37b26ca71b64025e29e99e8e859dd6036e3f34ecc54e03dd06c
- **Unexpected paths:** `coverage/tmp/coverage-846024-1787725403608-0.json`, `coverage/tmp/coverage-850320-1787725403428-0.json`, `coverage/tmp/coverage-884488-1787725403454-0.json`, `coverage/tmp/coverage-887156-1787725403754-0.json`, `coverage/tmp/coverage-887548-1787725403293-0.json`, `coverage/tmp/coverage-940720-1787725403435-0.json`, `coverage/tmp/coverage-947636-1787725403194-0.json`, `coverage/tmp/coverage-948136-1787725403429-0.json`, `coverage/tmp/coverage-949860-1787725402911-0.json`, `coverage/tmp/coverage-954288-1787725403582-0.json`, `coverage/tmp/coverage-954900-1787725403061-0.json`, `coverage/tmp/coverage-957112-1787725403356-0.json`, `coverage/tmp/coverage-958624-1787725403238-0.json`, `coverage/tmp/coverage-959244-1787725403584-0.json`, `coverage/tmp/coverage-959328-1787725403739-0.json`, `coverage/tmp/coverage-959900-1787725403091-0.json`, `coverage/tmp/coverage-960096-1787725403483-0.json`, `coverage/tmp/coverage-960140-1787725403073-0.json`, `coverage/tmp/coverage-960216-1787725403824-0.json`, `coverage/tmp/coverage-960420-1787725403089-0.json`, `coverage/tmp/coverage-960476-1787725403311-0.json`, `coverage/tmp/coverage-960668-1787725403816-0.json`, `coverage/tmp/coverage-960784-1787725403349-0.json`
- **Changed after seal:** NONE

## Remaining Limits

The exact ignored coverage temp files cannot be restored, so this receipt remains invalid even though all tracked product work is approved. The branch is not deployed; live verification of the repaired responses must wait for an owner-approved merge. Adjacent findings intentionally left out of the diff: registration can commit a merchant before a later registration-log/event failure; rotation, comment/vote quota, and moderation pin flows have partial-mutation risks; the world instructions mention cancellation without a market cancel route/tool, and city cancellation provenance has a separate gap.

## Rollback and Handoff

Keep the pull request unmerged for review. Reverting its eventual implementation commit removes the code and contract changes without a migration. Do not reconstruct or commit ignored coverage temp files. After an owner merges, verify safe invalid/unavailable payment and OAuth revocation failures through the deployed JSON/MCP doors without spending money or revoking a real token.
