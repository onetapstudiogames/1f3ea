# Unshittily Work Receipt

- **Task ID:** UNSLY-20260826-ACTION-FAILURE-CAUSES-MARKET-RESTART
- **Project:** 1F3EA at `C:\Users\Owner\Documents\1f3ea`
- **Created:** 2026-08-26

## Plain-English Outcome

**Outcome:** VALID / COMPLETE

The interrupted market action-failure sweep has been recovered and completed. Caller mistakes, rule refusals, unavailable dependencies, ambiguous payment verdicts, and internal failures now remain distinct through the raw API, ordinary and hosted MCP, and the read-only human window. Corrupt stored world receipts also fail honestly instead of producing an apparent successful receipt containing null or `NaN` fields.

## Execution Contract

- **Requested task:** Verify and finish the full market-side sweep for actions that fail without a cause; preserve causes through every public door; pin every verb; update public contracts; run all gates; push one branch; open one unmerged pull request.
- **Non-goals:** Mutate production listings, purchases, wallets, OAuth tokens, or city records; spend money; deploy, merge, or add write controls to the human window; fix adjacent transactionality or missing-cancel findings.
- **External effects authorized:** Read-only external checks plus pushing the requested branch and opening one unmerged pull request.

## Baseline and Protected Work

- **Restart baseline:** Clean pushed commit `9680bf65557eb30964786438263b522c83b6865d` on `fix/action-failure-causes-20260826`.
- **Declared product paths:** `e2e/window.spec.ts`, `src/chain.ts`, `src/door.ts`, `src/frontdoor.txt`, `src/index.ts`, `src/llms.txt`, `src/market-oauth.ts`, `src/mcp.ts`, `src/pay.ts`, `src/window-client.ts`, `src/world-routes.ts`, `test/chain-failures.test.ts`, `test/direct-payment-routes.test.ts`, `test/market-oauth-flow.test.ts`, `test/mcp-protocol-edges.test.ts`, `test/pay-failures.test.ts`, `test/routes.test.ts`, `test/source.test.ts`, `test/window-client.test.ts`, `test/world-routes.test.ts`.
- **Protected areas:** Production data and money, database schema and migrations, wallet authorization, unrelated source/docs/tests, and the human window's read-only boundary.

## Design and Root Cause

- **Root cause addressed:** YES.
- **Why durable:** Shared payment, chain, OAuth, connector, window, and world-receipt boundaries now classify their own failures once. Routes translate typed outcomes without guessing. PostgreSQL conflicts are named only for exact constraints. Unknown external verdicts are never reflected verbatim or treated as caller mistakes. Genuine unexpected faults use one safe, explicit internal-failure cause.
- **Class swept:** Registration, rotation, storefront update, listing creation/edit/withdrawal, purchase intent, buy/direct claim, comment, vote, flag, moderation remove/pin, world draft/list/checkout/sync, OAuth authorize/token/revoke, raw JSON, ordinary and hosted MCP, and human-window reads.

## Acceptance Checks

1. **Every reachable market/world action refusal names a cause — PROVEN.** One raw-route matrix covers all 18 domain verbs; OAuth and payment boundary tests cover their additional actions.
2. **Every door preserves the cause — PROVEN.** Raw JSON, ordinary/hosted MCP, and bounded inert window rendering are pinned.
3. **Payment failures retain safe retry meaning — PROVEN.** Invalid proof, unknown verdict, pending settlement, duplicate settlement, unavailable RPC/facilitator, and terminal transaction failure remain distinct and never advise a second payment after settlement uncertainty.
4. **Contracts match code — PROVEN.** `frontdoor.txt`, `llms.txt`, generated `door.ts`, and MCP tool descriptions are exact-tested.
5. **Restart state is complete and independently approved — PROVEN.** Two independent reviewers approved the exact guarded source digest with zero findings.

## Changes Made

- **Failure classification:** Exact database constraints, Base proof outcomes, x402 verify/settle outcomes, OAuth rate/storage/body failures, and connector construction failures now return safe causes.
- **Cause transport:** MCP retains API error bodies with `isError: true`; the human window bounded-stream parses safe API errors and renders them as inert text with fixed network/malformed/internal categories.
- **World receipt integrity:** A shared validator rejects malformed or incomplete stored receipt evidence through sync, MCP, purchase history, and account history.
- **Contract/test coverage:** Public text mirrors and tool descriptions state the returned shapes; unit/integration/E2E tests pin each action and door.
- **Payment retry safety:** Ambiguous settlement-side facilitator refusals and unavailable direct-claim signature checks say to reuse the same proof and not pay again.
- **Skill sweep:** The separately published 1F3EA skill remains accurate: it delegates live mechanics to front-door/tool discovery, requires checking MCP `isError`, and already forbids paying twice. No third-repository edit was needed or authorized.

## Pre-Change Proof

- New tests failed first on silent OAuth operational failures, false caller-invalid payment classifications, swallowed MCP construction failures, window failure text that did not survive translation, and corrupt stored world receipts returned as success.
- After implementation, the same tests pass with exact caller-facing causes and no production mutation.

## Anti-Band-Aid Gate

- **Tests weakened:** NO
- **Errors hidden:** NO
- **Silent fallback added:** NO
- **Hardcoded specimen workaround:** NO
- **Duplicate rule added:** NO
- **Permission/security loosened:** NO
- **Dependency added:** NO
- **Suppression/skip added:** NO

## Verification Evidence

- **Focused payment/chain/raw-action regression suite:** RED produced the expected 3 failures; GREEN passed 93/93.
- **Focused OAuth/MCP/window/world/contract suite:** 95/95 passed in independent review.
- **Full unit/integration suite:** `npm test` — 283/283 passed.
- **TypeScript:** `npm run typecheck` — passed with no diagnostics.
- **Human-window E2E:** `npm run test:e2e` — 36/36 passed across six phone/tablet/desktop light/dark projects.
- **Coverage:** `npm run test:coverage` — 95.98% statements/lines, 83.90% branches, 96.38% functions; all project thresholds passed.
- **Dependency audit:** `npm audit --audit-level=high` — 0 vulnerabilities.
- **Diff integrity:** `git diff --check` — passed.
- **Generated artifacts:** Baseline coverage files and timestamps were restored exactly; generated `test-results` was removed after its target was resolved inside the repository.

## Reviewer Findings

- **Specialist review:** APPROVED exact digest `f933c6d24088ad330745f5e0fd8c159a9cc77037cbd30ec11c03e98325db6629`; Critical 0, High 0, Medium 0, Low 0.
- **Overseer review:** APPROVED the same exact digest; Blocker 0, High 0, Medium 0, Low 0. The reviewer independently repeated the focused suites, typecheck, and guard.
- **Blockers remaining:** 0.

## Change Guard Result

- **Result:** `only_claimed_changes`; all product/test/doc paths were sealed.
- **Final source digest:** `f933c6d24088ad330745f5e0fd8c159a9cc77037cbd30ec11c03e98325db6629`
- **Unexpected paths:** 0
- **Changed after seal:** 0

## Remaining Limits and Adjacent Findings

- The branch is not deployed. Deployed response verification must wait for owner-approved merge.
- Adjacent findings intentionally remain outside the diff: registration and several quota/moderation flows have partial-mutation risk; world cancellation lacks a matching market route/tool; city cancellation provenance has a separate gap; recent-activity failure silently falls back to the static front door.

## Rollback and Handoff

The eventual implementation commit is migration-free and can be reverted as one market-side change. Keep the pull request unmerged. No production state, token, or payment was created, changed, or revoked during this run.
