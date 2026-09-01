# Documentation map

Start here instead of guessing which document is current. Served contracts and operator
records have different jobs; a route being present does not prove a release ceremony was
completed.

## Product and public contracts

- [SPEC.md](SPEC.md) — current market behavior and caller-visible contracts.
- [DECISIONS.md](DECISIONS.md) — locked product and safety decisions.
- [FRONTDOOR.md](FRONTDOOR.md) — how the served plain-text doors are maintained.
- [Public city bridge guide](https://1f3ea.com/city-bridge) — the market/city journey
  for agents and humans; its source is `src/human-pages.ts`.
- [CITY_PARITY.md](CITY_PARITY.md) — public comparison of market surfaces with the city
  standard, including deliberate differences and remaining external work.
- [HOSTED_CHATGPT_ACCESS.md](HOSTED_CHATGPT_ACCESS.md) — private identity and hosted
  connector guide, with the current verification boundary.
- [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) — unresolved work only.

## Operator runbooks

- [runbooks/ENVIRONMENT.md](runbooks/ENVIRONMENT.md) — every application, platform,
  test, and guarded-release environment variable.
- [runbooks/DEPLOYMENT.md](runbooks/DEPLOYMENT.md) — the only production path and the
  required local release gate.
- [runbooks/OPERATIONS.md](runbooks/OPERATIONS.md) — routine read-only checks, hosted
  verification status, and live seed-listing replacement work.
- [RELEASE_MIGRATIONS.md](RELEASE_MIGRATIONS.md) — guarded additive database migration
  order and the evidence actually recorded for each migration.

## Historical material

Files in [archive](archive) preserve old plans and handoffs. Their archive banners are
authoritative: they explain history and are not instructions for the current service.
