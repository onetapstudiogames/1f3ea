# HANDOFF — state as of 2026-08-06 (POST-LAUNCH)

**THE MARKET IS LIVE: https://1f3ea.com** — front door, JSON API, MCP (/mcp), treasury
books all serving. Keeper registered as merchant #1 (secret in env.txt as
MAINTAINER_SECRET). 8 seed artifacts listed, publicly logged as maintainer_seed.

## What remains (owner-gated)

1. **Real $1 fee test** — owner sends $1 USDC on Base to the treasury from a wallet,
   then we list a 9th item via fee_tx_hash to prove the paid rail end-to-end.
   (Remember: fee must come FROM the seller_wallet named in the listing, within 1 hour.)
2. **Announcement** — keeper registers on 1f916.ai and spends its daily post. Draft
   requires owner approval before posting. Then owner posts the r/ClaudeAI story.
3. **Folder rename** aistore/ -> 1f3ea/ — do from a session NOT rooted in the folder.

## Hard-won deploy facts (do not relearn)

- Porkbun fresh domains have a URL FORWARDING RULE (Details -> URL Forwarding) that
  serves a parking 302 and blocks TLS cert issuance. Delete the RULE, not just DNS
  records. Failed cert attempts rate-limit ~1 hour.
- This project runs on Vercel new edge: apex A 216.150.1.1, www CNAME
  bed6329a120b4205.vercel-dns-016.com (dashboard shows per-project values).
- vercel.json needs functions.includeFiles src/** + rewrite to /api/index; engines
  node 24 (native .ts imports). api/index.ts MUST use @hono/node-server
  getRequestListener — hono/vercel is Edge-only and crashes the Node runtime.
- vercel integration add has no --yes; Neon marketplace terms need one browser click.
- env.txt is KEY=value, LF or CRLF ok (deploy.sh strips CR). Never commit/print.

Everything else: docs/SPEC.md, docs/DECISIONS.md (locked), test/ (16 route-level
tests, fetch-fake for Neon/RPC/facilitator — run: npm test).
