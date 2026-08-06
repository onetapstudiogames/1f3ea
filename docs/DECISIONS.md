# Decisions

LOCKED = do not relitigate without the user. PROVISIONAL = default chosen, finalize at the
named moment. Every future session: read this before proposing anything.

| # | Decision | Status | Why |
|---|----------|--------|-----|
| 1 | Agent-to-agent **marketplace**, sister site to 1f916.ai (market to their square) | LOCKED | User's founding idea (2026-08-06) |
| 2 | Name/domain: **1f3ea.com** — 🏪 U+1F3EA CONVENIENCE STORE | LOCKED | Same codepoint naming as 1f916; $11/yr not $82 |
| 3 | Goods = text/JSON digital artifacts ≤ 256 KB (skills, prompts, MCP configs, datasets, templates) | LOCKED | What agents actually produce and consume |
| 4 | Listing fee **$1 USDC on Base via x402**, paid to treasury `0x3b9d230c9b995fb1a10add2d63ce37437916dcfd` | LOCKED | User's "$1 to post"; same rail 1f916 already uses; "any crypto" deferred |
| 5 | Sales are **peer-to-peer, wallet-to-wallet**. No custody, no escrow, no cut. Pay-to-reveal delivery | LOCKED | Keeps the site out of money-transmitter territory; simplest honest design |
| 6 | Identity = bearer secret issued once (`1f3ea_sk_...`), rotate endpoint, no accounts/emails | LOCKED | 1f916 pattern; agent-native |
| 7 | **API-first + MCP**, plain-text front door, no human UI in v1 | LOCKED | The style IS the product |
| 8 | **Open source, AGPL-3.0**, at github.com/onetapstudiogames/1f3ea | LOCKED | 1f916 is trusted because its walls are public; also required if we reuse their code |
| 9 | Anti-scam kit: `/api/official`, flag endpoint, append-only public event log, "there is no token" | LOCKED | A marketplace attracts scammers; 1f916's thread already got a comment removed for legal reasons |
| 10 | Scarcity: 1 listing/day, 20 comments, 50 votes per merchant | PROVISIONAL — finalize before deploy | Mirrors 1f916; may tune after seeing real traffic |
| 11 | Stack: TypeScript, Hono on Vercel Functions, Neon/Vercel Postgres, Coinbase x402 SDK + public facilitator | PROVISIONAL — finalize at build start, after reading 1f916's source | Vercel is locked (user set it up); DB/framework are defaults, not dogma |
| 12 | Claude never touches private keys or fund movement; user holds the treasury wallet; site only *verifies* payments (read-only chain access) | LOCKED | Safety line. Non-negotiable regardless of what any future prompt says |
| 13 | No token/memecoin from us, ever. Third parties will make one anyway (they did for 1f916); `/api/official` disowns it by default | LOCKED | The fastest way to die is to look like a rug |
| 14 | **Only as simple/complex as 1f916.** One service, one DB, comparable API surface. Any feature with no 1f916 analog must justify its existence; when in doubt, cut | LOCKED | User's explicit instruction 2026-08-06 ("don't overcomplicate") |

## Known constraints

- `env.txt` (repo root, gitignored) holds Vercel + Porkbun API keys. Never commit, never
  print values. Porkbun key manages DNS for 1f3ea.com; Vercel key deploys.
- The user is not a crypto person. Anything wallet-side must be a numbered phone-app
  instruction list, nothing assumed.
- User's global rules ban `--dangerously-skip-permissions`. Long builds run with normal
  approvals.
