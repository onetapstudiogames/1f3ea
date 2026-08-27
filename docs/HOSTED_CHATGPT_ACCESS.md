# Hosted ChatGPT access

`https://1f3ea.com/mcp/connect` is the feature-gated OAuth address for a ChatGPT
surface that supports custom MCP apps or connectors. A new merchant can sign up there,
or an existing merchant can link its store. A permanent merchant key appears or is entered only on a private 1F3EA sign-in page. Keys, recovery codes, and OAuth credentials
never belong in chat, tool arguments, connection settings, URLs, logs, or public content.

Until the release checklist's real protected read succeeds, treat production as
ordinary-door only. A discoverable or anonymously callable hosted route does not prove
merchant bearer delivery. Hosted sign-in stays dormant until both additive migrations are applied, all three feature switches are true,
the exact origin and client configuration are valid, the release pull request is merged,
and Vercel builds that exact commit. It is not considered working until a harmless protected `me` merchant read succeeds in one real hosted client after OAuth. A local test or an
anonymous catalog read does not prove bearer delivery. If that live check fails, turn the
hosted switch off and leave the connector browse-only. Ordinary `/mcp` and public reads
remain available.

The private identity pages are one gated ceremony too. Until the market-identity
migration is applied and both identity flags are true, `/join`, `/recovery`, and
`/rotate` return 503 and create or change nothing. Read `GET /api/official`, then inspect
its `identity` object before attempting one of those pages.

## Connect

1. In a ChatGPT surface that offers custom MCP apps or connectors, add
   `https://1f3ea.com/mcp/connect`. ChatGPT discovers 1F3EA's OAuth metadata and opens
   the private 1F3EA authorization page.
2. Existing merchant: enter the saved permanent merchant key only on that 1F3EA
   sign-in page. It is checked against the stored hash and discarded. It is never sent
   to ChatGPT.
3. New merchant: choose the handle on that page. First save the merchant key in a
   password manager or operating-system credential vault. Second save all eight recovery codes separately. Third re-enter the saved key. The merchant does not exist until
   that exact re-entry succeeds. A reload resumes the same attempt without repeating any
   credential; if the key or codes were not saved, cancel and start a fresh attempt.
4. Approve the link. ChatGPT receives short-lived OAuth access and rotating refresh
   credentials; 1F3EA stores only their hashes. Public `front_door`, `official_facts`,
   browse, store, and listing reads also work without sign-in.

Key-capable clients can create a merchant through the same save-first ceremony at
`https://1f3ea.com/join`, then use `Authorization: Bearer <merchant-key>` only on
`https://1f3ea.com/mcp`. The old JSON registration route is retired because a permanent key and
recovery codes must not be returned through MCP, JSON responses, or tool transcripts.

Start every visit through the connector with `front_door`, then `official_facts`. The
front-door fallback is `https://1f3ea.com/` if the client can open URLs. Both tools
dispatch through the existing public HTTP handlers, so the connector receives the same
bytes without asking the host to open that URL.

The authorization and identity pages have a phone-width layout, large controls, no
JavaScript, no third-party resources, no framing, no storage caching, and no wildcard
credential CORS. On a small screen or mobile browser the controls stack vertically.
Form limits are enforced from the bytes actually read; a missing or false
`Content-Length` never decides whether a safe request body is accepted. Host support for
adding a custom connector may still vary independently of those responsive pages.

## Recover or rotate a merchant key

- Lost key: open `https://1f3ea.com/recovery` and use one unused recovery code. Save
  the prepared replacement key, then re-enter it. The code and old key remain usable if
  the attempt is canceled; confirmation consumes the code and revokes the old key and
  connector sessions atomically.
- Current key exposed or deliberately replaced: open `https://1f3ea.com/rotate`. Save
  the prepared replacement, then re-enter it. The old key remains active until that
  confirmation succeeds. Confirmation also revokes connector sessions and all eight
  superseded recovery codes.
- A current key can create a fresh set of eight one-use recovery codes at `/recovery`.
  The new set invalidates the older set. Store the codes separately from the key.

## Fix or reconnect

- Wrong address: remove or delete the ChatGPT connection that uses
  `https://1f3ea.com/mcp`, then add or create one with
  `https://1f3ea.com/mcp/connect`.
- Expired or broken link: disconnect or revoke it, then connect again. Reusing an old
  rotating refresh token revokes that whole connection family and requires reconnect.
- Never paste the permanent key, an access token, a refresh token, an authorization
  code, any recovery code, or a browser cookie into ChatGPT, a tool argument, a URL, an
  issue, or support.

The original `https://1f3ea.com/mcp` address remains the secure-header path for local
agents and other clients that can protect a permanent merchant key. OAuth access
tokens are rejected at that address and on raw JSON API routes; they work only through
the internally isolated `/mcp/connect` request path.

## Payment safeguards are unchanged

Payments still go directly from buyer to seller; the market never holds funds. For a
direct ordinary purchase, create a fresh ten-minute direct-payment intent at
`/api/purchase-intent/:id` before paying, sign its
exact challenge, then claim with `intent_id`, `tx_hash`, and `payer_signature` before
expiry. The intent binds the market buyer, listing, payer wallet, seller wallet, Base
USDC asset, minimum amount, nonce, and inclusive time window. A public transaction
hash alone, an old payment, a replay, or a mismatched payer is rejected. One normalized
transaction hash proves only one paid action across purchases and listing fees.

## Release checklist

1. Follow `docs/RELEASE_MIGRATIONS.md`: apply the hosted OAuth migration, then the
   market-identity migration with the guarded preview commands. Test the full save-first
   ceremony and OAuth in preview. Create a production recovery point before using the
   separately guarded production commands. Do not apply the full schema remotely.
2. Set the exact public origin and approved OAuth clients; the stable ChatGPT client
   metadata is restricted to `https://chatgpt.com/oauth/client.json` and its exact
   published redirect.
3. Set `MARKET_IDENTITY_RECOVERY_ENABLED=true` and
   `MARKET_IDENTITY_ROTATION_ENABLED=true` only after their migration and preview tests.
   Set `HOSTED_MARKET_SIGNIN_ENABLED=true` only for the hosted connector test. Merge the
   release pull request into GitHub `main`, confirm Vercel built that exact commit, then
   test discovery, new and existing approval, a real protected `me` merchant read,
   disconnect/revocation, reconnect, recovery, rotation, and small screens.
4. If any item fails, turn the feature flag off. The ordinary `/mcp` and JSON doors
   continue to work.
