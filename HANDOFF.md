# 1F3EA — handoff

Written 2026-08-06. Read this, `CLAUDE.md`, and `docs/DECISIONS.md`, then start at step 1.

## What this project is

A JSON API for a marketplace whose users are AI agents, sister site to
[1f916.ai](https://1f916.ai). Agents register, list text artifacts (skills, prompts, MCP
configs) and buy each other's. Plain-text front door, no human UI. TypeScript + Hono, one
Vercel function, Neon Postgres. Domain `1f3ea.com` is bought; repo is
`github.com/onetapstudiogames/1f3ea` (AGPL-3.0).

**How money works, precisely** — this matters for reading the code correctly:

- A listing costs $1 USDC on Base. That dollar goes to a treasury address the project owner
  controls from their own phone wallet.
- Sales are peer-to-peer. The 402 challenge for a purchase names the **seller's** address as
  the recipient, so funds move buyer→seller and never through this project.
- The server holds **no private keys and no funds**, and moves nothing. It only (a) asks a
  public facilitator to verify/settle a payment the buyer signed, and (b) makes read-only
  JSON-RPC calls to a public Base endpoint to confirm a transfer happened. `src/chain.ts` is
  read-only by construction: `eth_getTransactionReceipt`, `eth_getBlockByHash`, `eth_call`.
- Nothing in the remaining work involves creating a wallet, handling a seed phrase, or
  transferring anything. The one payment that must be sent by a human (the end-to-end fee
  test, step 5) is sent by the project owner from their own phone.

## State

Done: all knowledge docs; full API in `src/`; MCP endpoint; schema; unit tests (7 pass);
`npx tsc --noEmit` clean; front door, `/llms.txt`, `/api/official`, and the MCP handshake
verified locally; `scripts/deploy.sh` written and syntax-checked. Two commits pushed.

Not done: the three fixes below, seeding, deployment.

Files: `src/index.ts` (all routes), `src/core.ts` (identity, quotas), `src/pay.ts` (x402),
`src/chain.ts` (read-only chain), `src/mcp.ts`, `src/db.ts`, `db/schema.sql`,
`src/frontdoor.txt` → `src/door.ts` via `node scripts/embed-door.mjs`.

## Step 1 — fix three defects found by adversarial review

Each was confirmed by a second agent that tried to refute it. Fix all three before deploying;
they are cheap.

**1.1 HIGH — the direct-payment fee path isn't bound to the payer.**
`src/index.ts:189` accepts any `fee_tx_hash` whose transaction moved ≥$1 USDC to the treasury
within 7 days and hasn't been used before. It ignores who sent it. The treasury address is
public and `GET /treasury` invites unsolicited patronage, so anyone can watch for an inbound
donation, submit its hash as their own listing fee, and list for free. Only the
`fees.tx_hash` unique constraint stops reuse, and a donation has no competing claimant.

Fix: `verifyDirectPayment` already returns `from`. Require it to equal the `seller_wallet`
the merchant declares on the listing, and shrink the window from 7 days to 1 hour:

```ts
const direct = await verifyDirectPayment(v.fee_tx_hash, TREASURY, LISTING_FEE_USDC, new Date(Date.now() - 3600e3))
if (!direct) return err(c, 402, 'fee_tx_hash did not verify: need >= $1 USDC on Base to the treasury, within the last hour, unused')
if (direct.from.toLowerCase() !== v.seller_wallet.toLowerCase())
  return err(c, 402, 'the fee must be paid from the same wallet you list as seller_wallet')
```

Then say so on the front door: `src/frontdoor.txt`, HOW TO SELL — the fallback fee must come
from your own seller wallet, within the hour. Re-run `node scripts/embed-door.mjs` and keep
the fenced block in `docs/FRONTDOOR.md` identical.

**1.2 MEDIUM — a seller can buy their own listing and mint a verified-buyer mark.**
Neither `/api/buy/:id` nor `/api/claim/:id` checks the caller against
`listing.merchant_id`, and `src/index.ts:322` stamps `verified_buyer` from any purchase row.
On a free listing this costs nothing; on a priced one the seller pays their own wallet. The
verified-buyer mark is the market's only trust signal, and the code already forbids the
analogous self-vote at `src/index.ts:336`.

Fix: in `getBuyable` (`src/index.ts:224`), after the removed check:

```ts
if (rows[0].merchant_id === m.id) return err(c, 403, 'you cannot buy your own goods (constitution §5)')
```

`getBuyable` needs the merchant passed in; both call sites already have it. Add §5 wording to
the constitution line in `src/frontdoor.txt` if you touch it.

**1.3 MEDIUM — the fee settles before the daily quota is claimed.**
`src/index.ts:179` reads `m.listings_today` from a snapshot taken at auth time, then payment
settles at 184/189, and only at 197 does the atomic `spendQuota` run. Two concurrent requests
from one merchant (a timeout retry, say) both pass the stale check, both settle $1, and the
loser gets a 429 *after* its money moved — before the `fees` row is written, so the treasury
books never record it.

Fix: reserve the quota first, settle second, release the quota if settlement fails.

```ts
if (!isSeed && !(await spendQuota(m.id, 'listings'))) return err(c, 429, 'one new listing per UTC day')
// ... settle here; on every failure path before the INSERT:
await sql`UPDATE merchants SET listings_today = greatest(listings_today - 1, 0) WHERE id = ${m.id}`
```

Delete the now-redundant pre-check at 179. Note the honest tradeoff: a crash between reserve
and settle costs the merchant that day's listing slot instead of costing them a dollar. That
is the right direction.

After the fixes: `npx tsc --noEmit`, then
`TREASURY_ADDRESS=0x3b9d230c9b995fb1a10add2d63ce37437916dcfd node --test --experimental-strip-types test/core.test.ts`,
and add a test per fix.

## Step 2 — deploy

Blocked on one thing: `env.txt` in the repo root is empty (0 bytes). The project owner has a
Vercel token and Porkbun API keys and needs to paste them in, one per line:

```
VERCEL_TOKEN=...
PORKBUN_API_KEY=pk1_...
PORKBUN_SECRET_KEY=sk1_...
```

`env.txt` is gitignored. Do not print its values or commit it. Porkbun also requires API
access to be switched on for `1f3ea.com` in their dashboard (Domain Management → the domain →
Details → API Access); `scripts/deploy.sh` step 0 detects that and says so.

Then:

```bash
bash scripts/deploy.sh
```

It is idempotent. It creates/links the Vercel project, provisions Neon Postgres through the
Vercel Marketplace (token-only; if it hits the one-time marketplace terms prompt it tells you
the single interactive command to run), sets `TREASURY_ADDRESS` / `PUBLIC_ORIGIN` /
`MAINTAINER_ID`, applies `db/schema.sql`, deploys to production, attaches the apex and www
domains, reads the A and CNAME values Vercel actually wants from
`GET /v6/domains/1f3ea.com/config` (they are per-project now — never hardcode the old
`76.76.21.21`), writes those records at Porkbun, waits for DNS and TLS, then smoke-checks the
live front door, `/api/official`, `/api/shelves`, and `/treasury`.

## Step 3 — register the maintainer, then seed the shelves

Registration order matters: whoever registers first is merchant #1, and `MAINTAINER_ID=1` is
what grants the pin/remove powers and the fee-free seed allowance. Register the maintainer
before announcing the site anywhere.

```bash
curl -sS -X POST https://1f3ea.com/api/register \
  -H 'Content-Type: application/json' \
  -d '{"handle":"1f3ea-keeper","model":"claude-fable-5"}'
```

The secret comes back once. Add it to `env.txt` as `MAINTAINER_SECRET=...`.

Then write 5–10 artifacts an agent would genuinely pay a dollar for and list them with that
secret. Fee-free seeding is capped at 10 listings and every one is logged publicly as
`maintainer_seed` — that cap and that log are promised in constitution §7 on the front door,
so do not raise the cap. Price them honestly; free (`price_usdc: 0`) is fine and several
should be, so the first visiting agent can take something home without a wallet. Ideas that
fit what the site is for: a skill file for reading and posting to 1f916, an MCP config for
1F3EA itself, a "how to price your own artifact" checklist, a memory-template for agents that
wake up blank.

Empty shelves are the main launch risk. An agent that arrives, finds nothing, and leaves does
not come back.

## Step 4 — verify the fee rail with one real payment

Sending the money is the project owner's job, from their own phone wallet — do not ask for
keys and do not attempt it yourself. Ask them to send $1 USDC on Base to the treasury address,
send you the transaction hash, and then confirm the fallback path end to end by creating one
listing with `fee_tx_hash` set to it. After that, `GET /treasury` should show the fee, and the
on-chain balance should agree. Note the x402 path itself can only be exercised by a client
that signs payments; the fallback is what you can verify by hand.

## Step 5 — announce

The maintainer registers on 1f916.ai and spends its one daily post there. That society is
already arguing about whether agents can pay their own rent; this market is a concrete answer,
so write the post to that thread rather than as an advertisement — it will be read by a room
of agents who dislike being sold to. Draft it, show the project owner, post only with their
say-so. They handle any Reddit post themselves.

## Rules that are settled

`docs/DECISIONS.md` has all 14; these are the ones easiest to break by accident:

- **#14 simplicity is law.** Match 1f916's complexity. Before adding anything, ask what the
  1f916 analog is; if there is none, cut it. 1f916 uses no framework and no payment SDK at
  all. Do not add reviews, star scores, dashboards, or a human posting UI.
- **#5 no custody.** The market never holds funds, takes no cut, runs no escrow. If a change
  would put money through the project, it is the wrong change.
- **#12 no keys, ever.** The project owner controls the treasury wallet. This project's code
  reads the chain and nothing more.
- **#13 there is no token.** Someone will probably launch a coin using the site's name, as
  happened to 1f916 within a day. `/api/official` disowns it by default. Never create one.
- The project owner's own tooling rules ban `--dangerously-skip-permissions`. Long builds run
  with normal approvals.
