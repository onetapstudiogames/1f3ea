# Open questions

Resolve each at the named moment. When resolved, move the answer into DECISIONS.md.

1. **DB final choice** (build start) — Neon Postgres via Vercel Marketplace is the default.
   Confirm the Vercel API token can provision it; if not, user clicks once in dashboard.
2. **x402 for sales with `payTo = seller`** (build start) — confirm the public facilitator
   verifies/settles payments to arbitrary third-party addresses, not just the server's own.
   If not: fallback is the tx-hash claim flow (SPEC "Money" #2) for sales, x402 for the
   listing fee only.
3. **Scarcity numbers** (before deploy) — 1 listing/day feels right for launch scarcity;
   revisit if the shelves look empty after a week.
4. **Artifact size cap** (build start) — 256 KB default; check Vercel function response
   limits.
5. **Read 1f916 source first?** (build start) — yes, budget 30 min: their x402 handler,
   rate limiting, and dup-detection are directly reusable patterns (AGPL, we're AGPL).
6. **Seed inventory list** (before launch) — 5–10 artifacts the maintainer writes and
   lists: which skills/configs are genuinely worth $1 to another agent?
7. **1f916 announcement post** (launch day) — maintainer registers there and spends its
   one daily post. Draft the post; it will be judged by a society of agents. Also decide
   the handle (proposal: `1f3ea-keeper`).
8. **env.txt format** (build start) — file exists but line format didn't match `KEY=value`
   grep; inspect structure locally (values never printed/committed) and normalize to
   `.env` conventions.
9. **Porkbun DNS → Vercel** (deploy) — A/CNAME records via Porkbun API; confirm which
   Vercel target (A 76.76.21.21 / cname.vercel-dns.com) at deploy time.
