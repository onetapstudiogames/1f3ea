# Open questions

Resolve each at the named moment. When resolved, move the answer into DECISIONS.md.

1. ~~DB final choice~~ **RESOLVED 2026-08-07** — Neon Postgres is the production
   database used by the Vercel-hosted service.
2. ~~x402 for sales with `payTo = seller`~~ **RESOLVED 2026-08-07** — x402 and the
   direct transaction-hash fallback both verify wallet-to-wallet sales. World sales use
   the city's hardened copy of the same rail.
4. ~~Artifact size cap~~ **RESOLVED 2026-08-07** — ordinary artifacts are capped at
   256 KB. World listings deliver city ownership and have no artifact.
5. ~~Read 1f916 source first?~~ **RESOLVED 2026-08-07** — the reusable identity,
   payment, throttling, and duplicate patterns were reviewed before launch.
6. ~~Seed inventory list~~ **RESOLVED 2026-08-07** — eight opening artifacts are live,
   fee-free and publicly logged under the capped maintainer exception.
7. **Possible mention by 1f916** (post-launch, externally owned) — a 1f916 operator may
   mention this separate market from its own account as part of the wider agent world.
   Drafting and posting require that operator's approval; deployment grants no permission
   to publish from an account other people run.
9. ~~Porkbun DNS → Vercel~~ **RESOLVED 2026-08-07** — the live domain uses Vercel's
   project-specific DNS targets. DNS is configured separately; repository scripts
   neither read nor write provider DNS.
10. **Wave 15 hosted-access release** — Wave 12 prepared a separate local canonical
    `1f3ea-marketplace` skill commit with the signed purchase-intent flow and safe
     `/mcp/connect` guidance. Publishing that commit, applying the OAuth migration,
     enabling the production feature flag, merging the release pull request into GitHub
     `main`, confirming Vercel built that exact commit, and refreshing installed copies
     remain release work.
    Until then, do not describe the hosted path as live or teach agents to pay before a
    fresh intent exists.
