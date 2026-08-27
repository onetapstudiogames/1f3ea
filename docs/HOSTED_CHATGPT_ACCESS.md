# Hosted ChatGPT access

`https://1f3ea.com/mcp/connect` is the feature-gated OAuth address for a ChatGPT
surface that supports custom MCP apps or connectors. It links an existing merchant
without putting the permanent `1f3ea_sk_...` key in chat, tool arguments, connection
headers, URLs, or logs.

The current production site still has only the ordinary door until the database
migration is run, `HOSTED_MARKET_SIGNIN_ENABLED=true` is configured, the release pull
request is merged into GitHub `main`, and Vercel builds that exact commit. A local build
neither enables nor ships this path. Custom MCP availability also depends on the
ChatGPT account, workspace policy, and surface. Unsupported surfaces remain browse-only
through public market reads.

## Connect

1. Register once through `https://1f3ea.com/mcp` with a secure header-capable client,
   or through `POST https://1f3ea.com/api/register`. Save the permanent merchant key
   in secure host storage. Hosted sign-in links an existing merchant; registration is
   deliberately separate.

Hosted registration is separate: `/mcp/connect` links an existing merchant only.
2. In a ChatGPT surface that offers custom MCP apps or connectors, add
   `https://1f3ea.com/mcp/connect`. ChatGPT discovers 1F3EA's OAuth metadata and opens
   the private 1F3EA authorization page.
3. Enter the permanent merchant key only on that 1F3EA sign-in page. It is checked
   against the stored hash and discarded. It is never sent to ChatGPT.
4. Approve the link. ChatGPT receives short-lived OAuth access and rotating refresh
   credentials; 1F3EA stores only their hashes. Public `front_door`, `official_facts`,
   browse, store, and listing reads also work without sign-in.

Start every visit through the connector with `front_door`, then `official_facts`. The
front-door fallback is `https://1f3ea.com/` if the client can open URLs. Both tools
dispatch through the existing public HTTP handlers, so the connector receives the same
bytes without asking the host to open that URL.

The authorization page has a phone-width layout, large controls, no JavaScript, no
third-party resources, no framing, and no wildcard credential CORS. On a small screen
the controls stack vertically. Host support for adding a custom connector may still
vary independently of that responsive page.

## Fix or reconnect

- Wrong address: remove or delete the ChatGPT connection that uses
  `https://1f3ea.com/mcp`, then add or create one with
  `https://1f3ea.com/mcp/connect`.
- Expired or broken link: disconnect or revoke it, then connect again. Reusing an old
  rotating refresh token revokes that whole connection family and requires reconnect.
- Never paste the permanent key, an access token, a refresh token, an authorization
  code, or a browser cookie into ChatGPT, a tool argument, a URL, an issue, or support.

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

1. Follow `docs/RELEASE_MIGRATIONS.md`: use the guarded preview command, test preview,
   create a production recovery point, then use the separately guarded production
   command. Do not apply the full schema as this release's remote migration.
2. Set the exact public origin and approved OAuth clients; the stable ChatGPT client
   metadata is restricted to `https://chatgpt.com/oauth/client.json` and its exact
   published redirect.
3. Set `HOSTED_MARKET_SIGNIN_ENABLED=true`, then merge the release pull request into
   GitHub `main`. Confirm Vercel built that exact commit, then test discovery, approval,
   protected reads, disconnect/revocation, reconnect, and small screens.
4. If any item fails, turn the feature flag off. The ordinary `/mcp` and JSON doors
   continue to work.
