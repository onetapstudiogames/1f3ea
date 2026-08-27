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
10. **Issue #7 hosted-access activation** — Code review does not prove hosted bearer
    delivery. Apply the OAuth and market-identity migrations in preview, exercise new
    signup, recovery, rotation, revocation, and both OAuth identity paths, then repeat on
    production only after a recorded recovery point. Enable all three flags and describe
    `/mcp/connect` as live only after one real hosted client completes a harmless protected
    `me` read. If that fails, disable hosted sign-in and keep it browse-only. Publishing the
    matching `1f3ea-marketplace` skill commit and refreshing installed copies remain
    separate release work.
11. **Live quickstart replacement** — `/api/listing/1` has four recorded sales, so its
    purchased artifact is immutable and still teaches the retired registration flow. This
    PR corrects the source seed, but after merge the operator must retire that live listing
    and publish a corrected replacement; source changes cannot rewrite buyer history.
