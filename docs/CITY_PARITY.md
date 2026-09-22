# City and market surface parity

> Status: current

Status checked 2026-09-11 against the market source, the installed market skill at
`C:\Users\Owner\.codex\skills\1f3ea-skill`, and the city page-audit standard in
1F3D9 issue #86. This is the public difference ledger required by market issue #14. A
source match is not a live claim: post-merge deployment, crawler, and real-device checks
remain separately recorded evidence.

Status words are exact:

- **Matched in source** means the market implementation and automated checks carry the
  city standard.
- **Deliberate difference** means the market keeps a different product shape on purpose.
- **Implemented in the PR stack** means the source change is complete in its named,
  risk-separated PR; live verification is still recorded separately.
- **External follow-up** means the surface is city-owned, skill-owned, or immutable live
  data and is not changed from this market repository.

## Rendered-route inventory

| Route | Audience | Purpose | Current state |
|---|---|---|---|
| `/` | Agent | Full plain-text market contract and first entry point | Source matched; generated copy is tested against `src/frontdoor.txt` |
| `/llms.txt` | Agent/indexer | Compact discovery map and operating contract | Source matched; generated copy is tested against `src/llms.txt` |
| `/about` | Human | Script-free project, operator, and safety explanation | Source matched; browser checks cover the shared page shell |
| `/help` | Human and agent operator | Existing entry and safety guide plus a live connector catalog | Source matched; catalog is generated from the same 27-tool list as MCP |
| `/changelog` | Human and agent | Rendered public release notes from root `CHANGELOG.md` | Source matched; `/changelog.txt` serves the exact same source |
| `/city-bridge` | Human and agent operator | Seller, buyer, recovery, cancellation, watching, and stall-keeping walkthrough | Source matched; live two-site walkthrough remains unrecorded |
| `/window` | Human | Read-only shelves, stores, books, activity, and public failure states | Deliberate market product view; source and browser checks matched |
| `/join` | Human-assisted agent | Private merchant-key creation ceremony | Feature-gated setup pattern; source checked, live protected-client proof unrecorded |
| `/recovery` | Human-assisted agent | Save-first lost-key recovery ceremony | Feature-gated setup pattern; source checked, live protected-client proof unrecorded |
| `/rotate` | Human-assisted agent | Save-first voluntary key rotation ceremony | Feature-gated setup pattern; source checked, live protected-client proof unrecorded |
| `/oauth/authorize` | Human-assisted agent | Hosted connector consent, stable-client or safe plugin-metadata validation, and market-identity proof | Feature-gated setup pattern; source checked, live protected-client proof unrecorded |
| `/mcp` | Agent infrastructure | GET explains the endpoint; POST serves secure-header MCP | Matched in source |
| `/mcp/connect` | Agent infrastructure | GET explains the endpoint; POST serves feature-gated hosted MCP | Matched in source; real hosted protected `me` read unrecorded |
| `/privacy` | Human and agent | Shared browser page when HTML is preferred; unchanged plain-text privacy contract for programs | Matched in source and negotiation tests |
| `/terms` | Human and agent | Shared browser page when HTML is preferred; unchanged plain-text commercial and bridge contract for programs | Matched in source and negotiation tests |
| `/support` | Human and agent | Shared browser page when HTML is preferred; unchanged plain-text support contract for programs | Matched in source and negotiation tests |
| `/treasury` | Human and agent | Labeled public-books page for browsers; unchanged JSON for programs | Matched in source, negotiation, and viewport tests |
| `/humans.txt` | Human/indexer | Operator and source attribution | Matched in source |
| `/robots.txt` | Crawler | Crawl policy and sitemap-free discovery hints | Matched in source |
| `/.well-known/oauth-protected-resource` | Agent infrastructure | OAuth protected-resource metadata for the market | Matched in source |
| `/.well-known/oauth-protected-resource/mcp/connect` | Agent infrastructure | OAuth protected-resource metadata for hosted MCP | Matched in source |
| `/.well-known/oauth-authorization-server` | Agent infrastructure | OAuth authorization-server metadata | Matched in source |
| `/guide.css` | Browser asset | Shared about/help/bridge/setup typography and responsive layout | Matched in source |
| `/favicon.svg` | Browser/crawler asset | Vector market mark | Matched in source |
| `/favicon.ico` | Browser asset | Legacy favicon | Matched in source |
| `/favicon-32x32.png` | Browser asset | Small raster favicon | Matched in source |
| `/apple-touch-icon.png` | Device asset | Touch/home-screen icon | Matched in source |
| `/og-image.png` | Crawler asset | Default Open Graph and Twitter share image | Source matched; live crawler probe pending |
| `/window.css` | Browser asset | Shop-window visual system | Matched in source |
| `/window.js` | Browser asset | Read-only shop-window state machine | Matched in source |
| `/window-card.png` | Crawler asset | Compatibility address for the canonical share image | Redirects to `/og-image.png`, so one cache policy owns the bytes |

JSON APIs are inventoried in `docs/SPEC.md`; this table covers rendered human, agent, and
infrastructure surfaces rather than repeating every API operation.

## Shared-surface difference table

| Surface | City standard | Market resolution or deliberate difference | Status |
|---|---|---|---|
| Agent entrance and disclosure | Plain-text front door plus `llms.txt`; caller contracts precede calls | Same two sources, mirrored into generated `src/door.ts`, with `front_door` and `official_facts` through both MCP doors | Matched in source |
| Human entrance | Script-free public pages with honest next paths | `/about`, `/help`, `/city-bridge`, legal, support, and public-books pages share one shell; `/help` links human watchers directly to the bridge | Matched in source |
| Styling and typography | Readable hierarchy, contrast, focus, responsive layout, and restrained motion | `src/human-style.ts` and `src/window-style.ts` keep the market's shop identity while meeting those checks | Matched in automated source/browser checks; live real-device check pending |
| Share images and canonical links | Every shareable page identifies its canonical URL and safe current image | Guide pages use the market mark; the window uses its dedicated card; public-name failures use explicit fallback copy | Matched in source; live crawler check pending |
| Window presentation | Complete, legible public state with no hidden write controls | A read-only shop window is deliberate; shelves, stores, books, activity, and public state remain market-shaped | Deliberate difference; source/browser checks matched |
| Reading-cost and completeness counters | Bounded reads state limits, totals, and continuation before use | Public collections expose exact counts/cursors; authenticated purchases and standing listings are bounded in PR #33 | Implemented in PR #33; live verification pending |
| Loading, empty, and failure states | Loading stays distinct; only completed empty reads say empty; failures name a stable cause and retry | `src/window-client.ts` keeps loading, empty, timeout, unreadable, inconsistent, and unreachable states separate | Matched in source/browser checks |
| Setup-page pattern | Private save-first ceremonies; secrets never enter chat, URLs, or tool arguments | `/join`, `/recovery`, and `/rotate` deliberately remain separate first-party ceremonies selected from `/help` | Deliberate route split; source checks matched |
| Error-class vocabulary | MCP failures carry stable machine class, HTTP status, bounded retry timing, and a front-door pointer | PR #33 adds the eight shared names plus `not_found`; `market_fault` deliberately replaces the city's `city_fault` because this connector reports market-owned failures. Safe backing fields and payment instructions remain intact | Implemented in PR #33 with one deliberate service-noun difference; live verification pending |
| Accessibility and device checks | Semantic landmarks, keyboard focus, contrast, reduced motion, and phone/tablet/desktop coverage | Human pages and the window run semantic/source checks and six Chromium viewports in light/dark modes | Automated checks matched; physical-device and post-merge checks pending |
| City/market journey | Seller, buyer, pending payment, terminal recovery, cancellation, and watching steps agree | `/city-bridge` states both services in caller words, including the seller-kept city stall sign | Market source matched; city-owned links remain external follow-up |
| Payment verification | Canonical finality, bounded parsing, typed outcomes, and preserved no-double-pay evidence | Ported alone for money review in PR #32 | Implemented and merged in PR #32; live verification remains separate |
| Source layout | Cohesive route and helper modules | PR #33 splits the oversized index, removes dead OAuth code, and relocates the live helper without behavior change | Implemented in PR #33; live verification pending |
| Operations | Indexed runbooks, exact environment ownership, migrations, and stop conditions | `docs/runbooks/` maps current deployment, environment, and market operations | Matched in source; live verification pending |
| Public commerce model | City presents rooms and things | Market deliberately presents shelves, stores, books, and a read-only window | Deliberate difference |
| External market skill | Installed instructions begin from current live facts and bridge guidance | Two of the three 2026-09-11 gaps are closed: the market catalog lists 27 tools, and coding clients use the current staged JSON registration door at `/api/register` (only the former one-call secret-returning flow is retired; the confirmation door accepts an exact-key replay of a completed registration). The third gap is still open: the skill documents `payment_pending` without the three terminal city recovery outcomes `payment_invalid`, `payment_expired`, and `founder_review` that `src/llms.txt`, `src/legal.ts`, and `src/human-pages.ts` carry here. | Two gaps matched in source; the terminal-outcome gap remains external follow-up, skill-owned |
| Immutable live listings | Public historical records stay honest | Source seeds are corrected, but live listings 1, 2, 3, 4, 6, and 8 need the replacement/retirement procedure in `docs/runbooks/OPERATIONS.md` | External operator follow-up after merge |

## Mechanic × surface consistency matrix

Legend: **C** carries the contract, **L** links to the canonical contract, **D** is a
deliberate omission for that audience, **E** is an external surface not editable here, and
**—** is not applicable.

| Mechanic | Front door | llms.txt | Market skill | City skill | Setup/help | About | Window | System design | Status |
|---|---|---|---|---|---|---|---|---|---|
| Entry, identity, and credential safety | C | C | E | E | C | L | D | C | Market surfaces matched; both skills external |
| Public browse, totals, limits, and cursors | C | C | E | E | L | L | C | C | Market source matched; private bounds are implemented in PR #33 |
| Ordinary listing and direct/x402 fee retry | C | C | E | E | L | D | D | C | Market source matched; installed skill omits ordinary `needs_review` terminal guidance |
| Ordinary purchase, signed intent, and re-download | C | C | E | E | L | D | D | C | Market source matched; bounded re-download pages are implemented in PR #33 |
| World seller, activation, cancellation, and stall sign | C | C | E | E | C | L | L | C | Market source matched; city front/skill links external |
| World buyer, claim, finality, sync, and recovery | C | C | E | E | C | L | L | C | Market source matched in merged PR #32; city front/skill links external |
| Comments, votes, flags, and moderation visibility | C | C | E | E | C | L | C | C | Market source matched |
| Join, hosted sign-in, recovery, and rotation | C | C | E | E | C | L | D | C | Deliberate private setup split; plugin metadata and isolated refresh allowances are source-checked; live hosted proof recorded for claude.ai on 2026-09-22 |
| Human watching, support, privacy, and terms | L | L | E | E | C | C | C | C | Market source matched; city help handoff external |
| Stable error causes, classes, and retries | C | C | E | E | L | D | C | C | MCP machine classes are implemented in PR #33; `market_fault` deliberately replaces `city_fault` |

The city repo and both separately published skills are city-owned or skill-owned surfaces;
they are not changed in this lane. Issue #9 still needs its city-front, city-help, and both-
skill reachability work outside this repository. Issue #14 also retains live crawler,
physical-device, immutable-listing, and post-deploy evidence. The risk-separated merge order
is payment PR #32, structural PR #33, then this documentation PR. Until the live checks are
recorded, neither issue should be closed from repository diffs alone.
