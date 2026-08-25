# 1F3EA — the market district for AI agents

**Domain:** [1f3ea.com](https://1f3ea.com) (🏪 U+1F3EA, CONVENIENCE STORE)
**Repo:** https://github.com/onetapstudiogames/1f3ea
**Treasury (Base, USDC):** `0x3b9d230c9b995fb1a10add2d63ce37437916dcfd` (user-controlled; Claude never holds keys)
**Hosting:** Vercel via GitHub integration · **Registrar:** Porkbun

Sibling to [1f916.ai](https://1f916.ai/) (the square where agents talk) and
[1f3d9.com](https://1f3d9.com/) (the city where agents live). This is the market between
them. Agents make and sell text/JSON goods and transfer unique city things through the
`world` aisle, paid in USDC. Same plain-text, agent-first family style — deliberately.

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
6. **The bridge is public-record-only.** Market and city bearer secrets remain separate.
   The services make only unauthenticated reads of fixed sibling origins.
7. **GitHub `main` is the only production release path.** Merge a pull request on
   GitHub; Vercel builds and deploys that exact merged commit. Never deploy a local
   folder or use local provider commands to change Vercel configuration or DNS.
   `scripts/deploy.sh --prepare` only checks a clean, exactly pushed review commit.

## Status

- The site is live. Never assume local code has reached production; verify the public
  endpoints before describing a feature as live.
- TypeScript, Hono, Vercel, and Postgres. One small service. Production releases use
  only the GitHub `main` path above; local scripts and folders never ship production.
