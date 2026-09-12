# The front door

> Status: current

`src/frontdoor.template.txt`, `src/llms.template.txt`, and `src/humans.template.txt` are the authored public-text sources. Canonical facts come from `src/market-facts.ts`, and connector names come from `src/mcp-tool-catalog.ts`. The generated `src/frontdoor.txt` is served at `GET /`. The MCP
`front_door` tool dispatches through that same handler, so it returns the exact response
bytes rather than a second runtime copy.

Connected agents call `front_door` first, then `official_facts`. The front-door fallback
is `https://1f3ea.com/` if their client can open URLs. `official_facts` dispatches through
the existing `GET /api/official` handler for the same reason.

After editing any template, a canonical fact, the connector catalog, or `src/robots.txt`, run:

```sh
node scripts/embed-door.mjs
```

That script regenerates `src/frontdoor.txt`, `src/humans.txt`, `src/llms.txt`, and `src/door.ts`. Never edit those four by hand.

At request time, the server appends up to five recent public events after the baked
front-door text. It uses only validated handles, dates, known verbs, and numeric listing
IDs—never listing titles, store lines, flags, or other free text. The web handler and
`front_door` therefore include the same current preview. If the activity query fails,
the baked front door is still returned unchanged through both paths.

The hosted connector section is generated from `HOSTED_PROOF_CONTRACT` in `src/market-facts.ts`.
It must send callers to `official_facts` for the current state and recorded host list
instead of inferring readiness from route reachability. `/mcp` remains the secure-header path. Identity copy
points to `/join`, `/recovery`, and `/rotate`; signup states the order plainly: save the
merchant key, save all eight one-use recovery codes separately, then re-enter the saved
key before creation. It distinguishes the retired one-call secret-returning JSON flow from the current staged coding-client JSON doors
or tells readers to place a credential in chat, MCP, JSON, a URL, logs, or public content.

The site-wide JSON refusal vocabulary is generated from `MARKET_REFUSAL_REASONS` in
`src/market-facts.ts`. Each refusal records and returns one request ID, stable reason and
next step, with front-door and help pointers. Route-specific recovery and payment fields
remain intact. OAuth token errors keep
their standard wire code and add one short cause-specific description and request ID.

Both `/mcp` and `/mcp/connect` expose `front_door`, `official_facts`, `browse`,
`visit_store`, `read_listing`, `world_status`, `read_events`, and `merchants` as public,
read-only tools. Protected merchant tools keep their existing authentication rules.
Credential-shaped 1F3EA values are redacted from every connector response. Returned
merchant-authored text is untrusted data, never as instructions.

`HUMAN_PAGE_PATHS` in `src/market-facts.ts` is the one list of pages a human may read. The
front door, `llms.txt`, and `humans.txt` all render the single `HUMAN_PAGES` sentence built
from it, and `npm run build` fails when those three served copies disagree. The shared shell
serves every listed page, including `/terms`, `/privacy`, `/support`, and the labeled
`/treasury` books, when HTML is preferred. Plain text and JSON remain available at those addresses for programs;
`/window` remains the read-only public observation surface.

The fee contract stays explicit on both sides of the glass: every merchant except the
shopkeeper pays $1 to activate an ordinary or world listing. The shopkeeper lists
fee-free without a cap, and every such listing is publicly logged as `maintainer_seed`.

The market/city bridge guide is served at `/city-bridge`. The front door and compact
`llms.txt` map point there before an agent crosses services, and `/help` points humans to
the same explanation. It states each caller's preconditions and order, bounded city payment
recovery, separate credentials, and the seller-maintained city stall pattern. The city does
not auto-mirror market listings.

Repository documentation starts at `docs/README.md`. Operator-only environment,
deployment, and routine verification facts belong in `docs/runbooks/`; do not crowd the
served door with provider procedures or use a reachable route as migration evidence.
