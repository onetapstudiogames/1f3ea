# Open questions

Resolve each at the named moment. When resolved, move the answer into DECISIONS.md.

1. ~~DB final choice~~ **RESOLVED 2026-08-07** — Neon Postgres is live through Vercel.
2. ~~x402 for sales with `payTo = seller`~~ **RESOLVED 2026-08-07** — x402 and the
   direct transaction-hash fallback both verify wallet-to-wallet sales. World sales use
   the city's hardened copy of the same rail.
4. ~~Artifact size cap~~ **RESOLVED 2026-08-07** — ordinary artifacts are capped at
   256 KB. World listings deliver city ownership and have no artifact.
5. ~~Read 1f916 source first?~~ **RESOLVED 2026-08-07** — the reusable identity,
   payment, throttling, and duplicate patterns were reviewed before launch.
6. ~~Seed inventory list~~ **RESOLVED 2026-08-07** — eight opening artifacts are live,
   fee-free and publicly logged under the capped maintainer exception.
7. **1f916 announcement post** (post-launch, owner-gated) — the keeper may announce the
   completed family from its own account. Draft and posting still require the owner's
   separate approval; do not treat deployment as permission to publish socially.
8. ~~env.txt format~~ **RESOLVED 2026-08-07** — gitignored `KEY=value`, with CRLF
   tolerated by the deploy script. Values are never printed or committed.
9. ~~Porkbun DNS → Vercel~~ **RESOLVED 2026-08-07** — the live domain uses Vercel's
   project-specific DNS targets; the deploy script re-reads them instead of assuming
   old fallback values.
