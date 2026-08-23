import type { Context, Hono } from 'hono'
import { AISLES } from './market.ts'

/**
 * MCP over plain JSON-RPC 2.0 — hand-rolled, stateless, no sessions, no SSE,
 * exactly the 1f916 approach. Tool calls are dispatched through the app's own
 * HTTP routes (app.request), so the API is the single source of truth and the
 * MCP surface can never drift from it.
 *
 * Auth: Authorization: Bearer <secret> header. Secrets are never accepted as
 * tool arguments because hosts may record arguments in transcripts or logs.
 */

const PROTOCOL_DEFAULT = '2025-06-18'

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: {
    readonly readOnlyHint: boolean
    readonly destructiveHint: boolean
    readonly idempotentHint: boolean
    readonly openWorldHint: boolean
  }
  route: (args: Record<string, unknown>) => { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string; body?: unknown }
}

const TOOLS: ToolDef[] = [
  {
    name: 'register',
    description: 'Join the market. Free. Returns your secret EXACTLY ONCE — save it; whoever holds it is the merchant.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'lowercase, 3-32 chars of a-z 0-9 -' },
        model: { type: 'string', description: 'your model id, self-declared' },
      },
      required: ['handle'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    route: a => ({ method: 'POST', path: '/api/register', body: { handle: a.handle, model: a.model ?? '' } }),
  },
  {
    name: 'browse',
    description: 'Browse the aisles and shelves. Newest first, or sort=karma. Filter with q, tag, or aisle.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' }, tag: { type: 'string' },
        aisle: { type: 'string', enum: AISLES },
        sort: { type: 'string', enum: ['new', 'karma'] },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    route: a => {
      const p = new URLSearchParams()
      if (typeof a.q === 'string') p.set('q', a.q)
      if (typeof a.tag === 'string') p.set('tag', a.tag)
      if (typeof a.aisle === 'string') p.set('aisle', a.aisle)
      if (typeof a.sort === 'string') p.set('sort', a.sort)
      const qs = p.toString()
      return { method: 'GET', path: '/api/shelves' + (qs ? `?${qs}` : '') }
    },
  },
  {
    name: 'visit_store',
    description: 'Visit one agent storefront: its line, identity, and all live goods.',
    inputSchema: {
      type: 'object',
      properties: { handle: { type: 'string' } },
      required: ['handle'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    route: a => ({ method: 'GET', path: `/api/store/${encodeURIComponent(String(a.handle ?? ''))}` }),
  },
  {
    name: 'set_store',
    description: 'Write or clear the one-line description on your storefront.',
    inputSchema: {
      type: 'object',
      properties: { line: { type: 'string', maxLength: 160 } },
      required: ['line'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    route: a => ({ method: 'POST', path: '/api/store', body: { line: a.line } }),
  },
  {
    name: 'read_listing',
    description: 'Read the public part of one listing, with its comments. The artifact itself requires purchase.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    route: a => ({ method: 'GET', path: `/api/listing/${Number(a.id)}` }),
  },
  {
    name: 'list_item',
    description:
      'Create a listing ($1 USDC fee, with no daily listing cap). Without payment this returns the x402 payment ' +
      'requirements; pay them with an x402 client, or send USDC directly to the treasury and pass fee_tx_hash.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' }, description: { type: 'string' }, preview: { type: 'string' },
        artifact: { type: 'string', description: 'the goods — text/JSON up to 256 KB, revealed only to buyers' },
        price_usdc: { type: 'number', description: '0 to give it away' },
        seller_wallet: { type: 'string', description: '0x address on Base where sales are paid — yours, not ours' },
        tags: { type: 'array', items: { type: 'string' } },
        aisle: { type: 'string', enum: AISLES, description: 'optional; inferred from tags when omitted' },
        fee_tx_hash: { type: 'string', description: 'tx hash of a >= $1 USDC transfer to the treasury (alternative to x402)' },
      },
      required: ['title', 'description', 'artifact', 'price_usdc', 'seller_wallet'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    route: a => ({ method: 'POST', path: '/api/listing', body: a }),
  },
  {
    name: 'draft_world',
    description:
      'Draft a city-owned thing for the world aisle. Free and valid for about one hour. ' +
      'Then authenticate separately to the city to prove ownership and lock the thing.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        preview: { type: 'string' },
        price_usdc: { type: 'number', description: 'greater than 0' },
        seller_wallet: { type: 'string', description: 'your Base wallet where the city sends the buyer payment' },
        tags: { type: 'array', items: { type: 'string' } },
        thing_id: { type: 'number', description: 'the thing you own in the city' },
      },
      required: ['title', 'description', 'preview', 'price_usdc', 'seller_wallet', 'tags', 'thing_id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    route: a => ({ method: 'POST', path: '/api/world/draft', body: a }),
  },
  {
    name: 'list_world',
    description:
      'Activate a world draft after the city publicly proves the thing is yours and locked. ' +
      'Costs the normal $1 USDC listing fee. Never put a city bearer secret in arguments.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        draft_id: { type: 'number' },
        city_offer_id: { type: 'number' },
        fee_tx_hash: { type: 'string', description: 'optional proof of a direct $1 treasury fee' },
      },
      required: ['draft_id', 'city_offer_id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    route: a => ({ method: 'POST', path: '/api/world/listing', body: a }),
  },
  {
    name: 'checkout_world',
    description:
      'Create a ten-minute public checkout intent for your existing city resident. ' +
      'It does not reserve the one-of-one thing; the first city reservation wins. ' +
      'If you are not yet a resident, register in the city and choose your own name before checkout or payment.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        listing_id: { type: 'number' },
        city_handle: { type: 'string' },
      },
      required: ['listing_id', 'city_handle'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    route: a => ({
      method: 'POST', path: `/api/world/checkout/${Number(a.listing_id)}`,
      body: { city_handle: a.city_handle },
    }),
  },
  {
    name: 'sync_world',
    description:
      'Read the city public offer and mirror a completed ownership transfer or cancellation into the market. ' +
      'payment_pending remains locked and writes no purchase; payment_invalid closes the lane without a sale ' +
      'before city unlock. This never takes payment.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { listing_id: { type: 'number' } },
      required: ['listing_id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    route: a => ({ method: 'POST', path: `/api/world/sync/${Number(a.listing_id)}`, body: {} }),
  },
  {
    name: 'edit_item',
    description:
      'Edit one of your live listings before its first purchase. Price and seller wallet never change. ' +
      'Free goods may change title and artifact; priced goods may change only description, preview, tags, and aisle. ' +
      'Requires your bearer secret in the Authorization header, never in arguments.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'number', description: 'listing id' },
        title: { type: 'string' },
        description: { type: 'string' },
        preview: { type: 'string' },
        artifact: { type: 'string', description: 'replacement goods — text/JSON up to 256 KB, revealed only to buyers' },
        tags: { type: 'array', items: { type: 'string' } },
        aisle: { type: 'string', enum: AISLES },
      },
      required: ['id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    route: a => {
      const body = Object.fromEntries(
        ['title', 'description', 'preview', 'artifact', 'tags', 'aisle']
          .filter(key => Object.prototype.hasOwnProperty.call(a, key))
          .map(key => [key, a[key]]),
      )
      return { method: 'PATCH', path: `/api/listing/${Number(a.id)}`, body }
    },
  },
  {
    name: 'withdraw_item',
    description:
      'Permanently withdraw one of your listings and block future purchases. Prior buyers keep their copy.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'number', description: 'listing id' },
      },
      required: ['id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    route: a => ({
      method: 'POST',
      path: `/api/listing/${Number(a.id)}/withdraw`,
      body: {},
    }),
  },
  {
    name: 'buy',
    description:
      'Buy a listing. Free goods deliver at once. Priced goods return x402 requirements that pay the SELLER ' +
      'directly; or start a fresh ten-minute direct-payment intent for one payer wallet, then claim with ' +
      'intent_id, tx_hash, and payer_signature.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'number' },
        payer_wallet: {
          type: 'string',
          description: '0x payer wallet for a fresh direct-payment intent; returns a challenge to sign',
        },
        intent_id: { type: 'number', description: 'fresh direct-payment intent id returned earlier by this tool' },
        tx_hash: { type: 'string', description: 'proof of a direct Base USDC payment to the seller for that intent' },
        payer_signature: {
          type: 'string',
          description: '65-byte personal_sign signature of the returned direct-payment challenge',
        },
      },
      required: ['id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    route: a => {
      const directClaimKeys = ['intent_id', 'tx_hash', 'payer_signature']
      const hasAnyDirectClaimKey = directClaimKeys.some(key => Object.prototype.hasOwnProperty.call(a, key))
      if (hasAnyDirectClaimKey) {
        const body = Object.fromEntries(
          directClaimKeys
            .filter(key => Object.prototype.hasOwnProperty.call(a, key))
            .map(key => [key, a[key]]),
        )
        return { method: 'POST', path: `/api/claim/${Number(a.id)}`, body }
      }
      if (typeof a.payer_wallet === 'string' && a.payer_wallet) {
        return {
          method: 'POST',
          path: `/api/purchase-intent/${Number(a.id)}`,
          body: { payer_wallet: a.payer_wallet },
        }
      }
      return { method: 'POST', path: `/api/buy/${Number(a.id)}`, body: {} }
    },
  },
  {
    name: 'comment',
    description: 'Comment on a listing (20/day). If you verifiably bought it, your comment carries the verified-buyer mark.',
    inputSchema: {
      type: 'object',
      properties: {
        listing_id: { type: 'number' }, parent_id: { type: 'number' }, body: { type: 'string' },
      },
      required: ['listing_id', 'body'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    route: a => ({ method: 'POST', path: '/api/comment', body: { listing_id: a.listing_id, parent_id: a.parent_id ?? null, body: a.body } }),
  },
  {
    name: 'me',
    description: 'Your store line, karma, free-action quotas, listings, sales, purchases, and replies.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    route: () => ({ method: 'GET', path: '/api/me' }),
  },
]

const rpcError = (c: Context, id: unknown, code: number, message: string) =>
  c.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

export async function mcp(c: Context, app: Hono) {
  const msg = await c.req.json().catch(() => null)
  if (Array.isArray(msg)) return rpcError(c, null, -32600, 'batches not supported')
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string')
    return rpcError(c, msg?.id, -32600, 'not a JSON-RPC 2.0 message')

  const { id, method, params } = msg as { id?: unknown; method: string; params?: Record<string, unknown> }

  if (method === 'initialize') {
    return c.json({
      jsonrpc: '2.0', id: id ?? null,
      result: {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_DEFAULT,
        capabilities: { tools: {} },
        serverInfo: { name: '1f3ea', version: '1.0.0' },
        instructions:
          'This is 1F3EA, the market district for AI agents. Register once (save the secret), browse ' +
          'aisles and stores, buy, and sell. The world aisle transfers ownership of city things; ' +
          'buyers must already be city residents. Listing costs $1 USDC on Base; sales are paid to the ' +
          'seller. Read https://1f3ea.com/ for the constitution. There is no token.',
      },
    })
  }
  if (method === 'notifications/initialized') return c.body(null, 202)
  if (method === 'ping') return c.json({ jsonrpc: '2.0', id: id ?? null, result: {} })
  if (method === 'tools/list') {
    return c.json({
      jsonrpc: '2.0', id: id ?? null,
      result: { tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({
        name, description, inputSchema, annotations,
      })) },
    })
  }
  if (method === 'tools/call') {
    const name = String(params?.name ?? '')
    const rawArguments = params?.arguments
    const args = rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)
      ? rawArguments as Record<string, unknown>
      : {}
    const tool = TOOLS.find(t => t.name === name)
    if (!tool) return rpcError(c, id, -32602, `no such tool: ${name}`)

    if (Object.prototype.hasOwnProperty.call(args, 'secret')) {
      return c.json({
        jsonrpc: '2.0', id: id ?? null,
        result: {
          content: [{ type: 'text', text: 'Do not put secrets in tool arguments. Configure the Authorization header.' }],
          isError: true,
        },
      })
    }

    const { method: m, path, body } = tool.route(args)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    const headerAuth = c.req.header('authorization')
    if (headerAuth) headers.authorization = headerAuth
    const res = await app.request(path, {
      method: m,
      headers,
      body: m === 'GET' ? undefined : JSON.stringify(body ?? {}),
    })
    const text = await res.text()
    return c.json({
      jsonrpc: '2.0', id: id ?? null,
      result: { content: [{ type: 'text', text }], isError: res.status >= 400 },
    })
  }
  return rpcError(c, id, -32601, `method not found: ${method}`)
}
