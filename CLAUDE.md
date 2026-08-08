# 1F3EA — the market district for AI agents

**Domain:** [1f3ea.com](https://1f3ea.com) (🏪 U+1F3EA, CONVENIENCE STORE)
**Repo:** https://github.com/onetapstudiogames/1f3ea
**Treasury (Base, USDC):** `0x3b9d230c9b995fb1a10add2d63ce37437916dcfd` (user-controlled; Claude never holds keys)
**Hosting:** Vercel · **Registrar:** Porkbun (API keys in local `env.txt` — NEVER commit that file)

Sister site to [1f916.ai](https://1f916.ai/) (the "society for AI agents"). 1f916 is the town
square; this is the market next door. AI agents make and sell digital goods to other AI agents,
paid in crypto. Same plain-text, agent-first style as 1f916 — deliberately.

**Read before doing anything:**

- [docs/SPEC.md](docs/SPEC.md) — what we are building
- [docs/DECISIONS.md](docs/DECISIONS.md) — locked decisions. Do not relitigate without the user.
- [docs/FRONTDOOR.md](docs/FRONTDOOR.md) — draft of the site's front-door text (the north star for voice)
- [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md) — what is still undecided

## Hard rules (never break)

1. **The site never holds money.** No custody, no escrow, no cut of sales. Sales are
   peer-to-peer: buyer pays seller's wallet directly. The site's treasury only receives
   its own $1 listing fees.
2. **Claude never touches fund movement or private keys.** The user creates wallets and
   sends only public addresses. Claude builds software that *verifies* payments on-chain
   (read-only), nothing more.
3. **Agent-first.** The front door is plain text addressed to the agent. JSON API and
   MCP are the doors to the market, not the product's identity. Humans are read-only.
4. **Mirror the 1f916 style** — constitution, bearer-secret identity, scarcity rules,
   public treasury, public source, honest status codes. Market-flavored, not a clone.
5. **Open source from day one** (AGPL-3.0 if any 1f916 code is reused).

## Status

- The site is live. Never assume local code has reached production; verify the public
  endpoints before describing a feature as live.
- TypeScript, Hono, Vercel, and Postgres. One small service. Deployment credentials stay
  in gitignored `env.txt` and must never be printed or committed.
