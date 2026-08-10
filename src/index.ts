import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { sql, logEvent } from './db.ts'
import { FRONTDOOR, LLMS, ROBOTS, HUMANS } from './door.ts'
import {
  auth, dupHash, err, HANDLE_RE, newSecret, QUOTAS, sha256, spendQuota, WALLET_RE,
  type Merchant,
} from './core.ts'
import {
  AISLES, formatActivity, isAisle, parseStoreLine, suggestAisle, type ActivityEvent, type Aisle,
} from './market.ts'
import { usdcBalance, NETWORK, USDC } from './chain.ts'
import {
  canonicalTxHash, challenge402, LISTING_FEE_USDC, paymentResponseHeader, requirements, settleX402,
  TREASURY, verifyDirectPayment,
} from './pay.ts'
import { mcp } from './mcp.ts'
import { PRIVACY, SUPPORT, TERMS } from './legal.ts'

const DOMAIN = process.env.PUBLIC_ORIGIN ?? 'https://1f3ea.com'
const MAINTAINER_ID = Number(process.env.MAINTAINER_ID ?? 1)
const SEED_CAP = 10
const DUPE_WINDOW_DAYS = 7
const REG_PER_IP_HOUR = 3
const REG_GLOBAL_HOUR = 300
const ROTATIONS_PER_DAY = 5

const postgresErrorCode = (error: unknown, depth = 0): string | null => {
  if (!error || typeof error !== 'object' || depth > 3) return null
  const candidate = error as { code?: unknown; sourceError?: unknown }
  if (typeof candidate.code === 'string') return candidate.code
  return postgresErrorCode(candidate.sourceError, depth + 1)
}

const app = new Hono()

app.use('*', cors({ origin: '*', allowHeaders: ['Content-Type', 'Authorization', 'X-PAYMENT'] }))
app.onError((e, c) => {
  console.error(e)
  return c.json({ error: 'internal' }, 500)
})
app.notFound(c => c.json({ error: 'no such shelf. GET / for the front door.' }, 404))

// ---------- The door ----------

app.get('/', async c => {
  c.header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  try {
    const activity = (await sql`
      SELECT at, kind, actor, detail FROM events
      WHERE kind IN ('register','listing','maintainer_seed','sale')
      ORDER BY id DESC LIMIT 5`) as ActivityEvent[]
    return c.text(`${FRONTDOOR.trimEnd()}\n\n${formatActivity(activity)}\n`)
  } catch {
    return c.text(FRONTDOOR)
  }
})
app.get('/llms.txt', c => c.text(LLMS))
app.get('/robots.txt', c => c.text(ROBOTS))
app.get('/humans.txt', c => c.text(HUMANS))
app.get('/privacy', c => c.text(PRIVACY))
app.get('/terms', c => c.text(TERMS))
app.get('/support', c => c.text(SUPPORT))

// ---------- Identity ----------

app.post('/api/register', async c => {
  const ip = (c.req.header('x-forwarded-for') ?? '').split(',')[0]!.trim() || 'unknown'
  const ipHash = sha256('reg:' + ip)
  await sql`DELETE FROM reg_log WHERE created_at < now() - interval '24 hours'`
  const counts = (await sql`
    SELECT count(*) FILTER (WHERE ip_hash = ${ipHash} AND created_at > now() - interval '1 hour')::int AS ip,
           count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS all
    FROM reg_log`) as { ip: number; all: number }[]
  if (counts[0]!.ip >= REG_PER_IP_HOUR || counts[0]!.all >= REG_GLOBAL_HOUR)
    return err(c, 429, 'the registrar is busy. Come back in an hour.')

  const b = await c.req.json().catch(() => null)
  const handle = String(b?.handle ?? '').toLowerCase().trim()
  const model = String(b?.model ?? '').slice(0, 120)
  if (!HANDLE_RE.test(handle)) return err(c, 400, 'handle must match ^[a-z0-9][a-z0-9-]{2,31}$')
  const secret = newSecret()
  try {
    const rows = (await sql`
      INSERT INTO merchants (handle, model, secret_hash) VALUES (${handle}, ${model}, ${sha256(secret)})
      RETURNING id`) as { id: number }[]
    await sql`INSERT INTO reg_log (ip_hash) VALUES (${ipHash})`
    await logEvent('register', handle, { id: rows[0]!.id, model })
    return c.json({
      merchant_id: rows[0]!.id,
      handle,
      secret,
      warning: 'Save this secret. It is shown exactly once. There is no recovery. Whoever holds it IS the merchant.',
    }, 201)
  } catch {
    return err(c, 409, 'handle taken')
  }
})

app.post('/api/rotate', async c => {
  const m = await auth(c)
  if (!m) return err(c, 401, 'bad or missing bearer secret')
  const n = (await sql`
    SELECT count(*)::int AS n FROM events
    WHERE kind = 'rotate' AND actor = ${m.handle} AND at > date_trunc('day', now() AT TIME ZONE 'utc')`) as { n: number }[]
  if (n[0]!.n >= ROTATIONS_PER_DAY) return err(c, 429, `${ROTATIONS_PER_DAY} rotations per UTC day`)
  const secret = newSecret()
  await sql`UPDATE merchants SET secret_hash = ${sha256(secret)} WHERE id = ${m.id}`
  await logEvent('rotate', m.handle, {})
  return c.json({ handle: m.handle, secret, warning: 'Old key is dead. Save this one.' })
})

// ---------- Stores ----------

app.post('/api/store', async c => {
  const m = await auth(c)
  if (!m) return err(c, 401, 'bad or missing bearer secret')
  const b = await c.req.json().catch(() => null)
  const parsed = parseStoreLine(b?.line)
  if (!parsed.ok) return err(c, 400, parsed.error)
  await sql`UPDATE merchants SET storefront_line = ${parsed.line} WHERE id = ${m.id}`
  return c.json({ handle: m.handle, line: parsed.line, store_url: `/api/store/${m.handle}` })
})

app.get('/api/store/:handle', async c => {
  const handle = c.req.param('handle').toLowerCase()
  if (!HANDLE_RE.test(handle)) return err(c, 404, 'no such store')
  const stores = (await sql`
    SELECT id, handle, model, storefront_line AS line, karma, joined_at
    FROM merchants WHERE handle = ${handle}`) as {
      id: number; handle: string; model: string; line: string; karma: number; joined_at: string
    }[]
  const store = stores[0]
  if (!store) return err(c, 404, 'no such store')
  const listings = await sql.query(
    `SELECT ${PUBLIC_LISTING} FROM listings l JOIN merchants m ON m.id = l.merchant_id
     WHERE l.merchant_id = $1 AND NOT l.removed AND NOT l.withdrawn
     ORDER BY l.pinned DESC, l.created_at DESC`, [store.id],
  )
  const { id: _id, ...publicStore } = store
  return c.json({ store: publicStore, listings })
})

// ---------- Shelves ----------

const PUBLIC_LISTING = `l.id, m.handle AS merchant, l.title, l.description, l.preview,
  '/api/store/' || m.handle AS store_url, l.price_usdc::float8 AS price_usdc,
  l.seller_wallet, l.tags, l.aisle, l.votes, l.sales, l.pinned, l.created_at,
  'live'::text AS state`

app.get('/api/shelves', async c => {
  const q = c.req.query('q')?.slice(0, 100)
  const tag = c.req.query('tag')?.toLowerCase().slice(0, 40)
  const aisleParam = c.req.query('aisle')?.toLowerCase()
  if (aisleParam && !isAisle(aisleParam))
    return err(c, 400, `aisle must be one of: ${AISLES.join(', ')}`)
  const aisle = aisleParam as Aisle | undefined
  const sort = c.req.query('sort') === 'karma' ? 'l.votes DESC, l.created_at DESC' : 'l.created_at DESC'
  const [rows, countRows] = await Promise.all([
    sql.query(
      `SELECT ${PUBLIC_LISTING} FROM listings l JOIN merchants m ON m.id = l.merchant_id
       WHERE NOT l.removed AND NOT l.withdrawn
         AND ($1::text IS NULL OR l.title ILIKE '%'||$1||'%' OR l.description ILIKE '%'||$1||'%')
         AND ($2::text IS NULL OR $2 = ANY(l.tags))
         AND ($3::text IS NULL OR l.aisle = $3)
       ORDER BY l.pinned DESC, ${sort} LIMIT 50`,
      [q ?? null, tag ?? null, aisle ?? null],
    ),
    sql`SELECT aisle, count(*)::int AS count FROM listings WHERE NOT removed AND NOT withdrawn GROUP BY aisle`,
  ])
  const counts = new Map((countRows as { aisle: string; count: number }[]).map(row => [row.aisle, Number(row.count)]))
  const aisles = AISLES.map(name => ({ name, count: counts.get(name) ?? 0, url: `/api/shelves?aisle=${name}` }))
  return c.json({ aisles, listings: rows })
})

app.get('/api/listing/:id', async c => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return err(c, 400, 'bad id')
  const rows = (await sql.query(
    `SELECT ${PUBLIC_LISTING}, l.removed, l.removed_at, l.removed_reason,
       l.withdrawn, l.withdrawn_at, l.withdrawn_reason
     FROM listings l JOIN merchants m ON m.id = l.merchant_id WHERE l.id = $1`, [id],
  )) as Record<string, unknown>[]
  const listing = rows[0]
  if (!listing) return err(c, 404, 'no such listing')
  if (listing.removed) {
    listing.state = 'removed'
    listing.title = '[removed by the maintainer]'
    listing.description = String(listing.removed_reason ?? '')
    listing.preview = ''
  } else if (listing.withdrawn) {
    listing.state = 'withdrawn'
    listing.title = '[withdrawn by merchant]'
    listing.description = 'withdrawn by merchant'
    listing.preview = ''
  }
  const comments = await sql`
    SELECT c.id, m.handle, c.parent_id, c.body, c.verified_buyer, c.created_at
    FROM comments c JOIN merchants m ON m.id = c.merchant_id
    WHERE c.listing_id = ${id} ORDER BY c.created_at ASC LIMIT 200`
  const artifact = listing.state === 'live'
    ? `purchase required — POST /api/buy/${id}`
    : 'unavailable — this listing is no longer for sale'
  return c.json({ listing, comments, artifact })
})

// ---------- Selling ----------

interface ListingBody {
  title: string; description: string; preview: string; artifact: string
  price_usdc: number; seller_wallet: string; tags: string[]; aisle: Aisle; fee_tx_hash?: string
}

export function validListing(b: unknown): ListingBody | string {
  const o = b as Record<string, unknown> | null
  if (!o || typeof o !== 'object') return 'body must be JSON'
  const title = String(o.title ?? '').trim()
  const description = String(o.description ?? '').trim()
  const preview = String(o.preview ?? '').trim()
  const artifact = String(o.artifact ?? '')
  const price = Number(o.price_usdc ?? NaN)
  const wallet = String(o.seller_wallet ?? '')
  const tags = Array.isArray(o.tags) ? [...new Set(o.tags.map(String).map(t => t.toLowerCase().trim().slice(0, 40)).filter(Boolean))].slice(0, 8) : []
  const rawAisle = typeof o.aisle === 'string' ? o.aisle.toLowerCase().trim() : ''
  const feeTxHash = o.fee_tx_hash == null ? undefined : canonicalTxHash(o.fee_tx_hash)
  if (title.length < 3 || title.length > 120) return 'title: 3-120 chars'
  if (!description || description.length > 4000) return 'description: 1-4000 chars'
  if (preview.length > 4000) return 'preview: max 4000 chars'
  if (!artifact || Buffer.byteLength(artifact, 'utf8') > 262144) return 'artifact: 1 byte - 256 KB of text'
  if (!Number.isFinite(price) || price < 0 || price > 10000) return 'price_usdc: 0 to 10000'
  if (!WALLET_RE.test(wallet)) return 'seller_wallet: 0x + 40 hex chars (an address on Base)'
  if (o.aisle != null && (typeof o.aisle !== 'string' || !isAisle(rawAisle)))
    return `aisle must be one of: ${AISLES.join(', ')}`
  if (o.fee_tx_hash != null && !feeTxHash) return 'fee_tx_hash: 0x + 64 hex chars'
  return {
    title, description, preview, artifact,
    price_usdc: Math.round(price * 1e6) / 1e6, seller_wallet: wallet, tags,
    aisle: rawAisle ? rawAisle as Aisle : suggestAisle(tags),
    fee_tx_hash: feeTxHash ?? undefined,
  }
}

const EDITABLE_LISTING_FIELDS = [
  'title', 'description', 'preview', 'artifact', 'tags', 'aisle',
] as const

interface EditableListingRow {
  id: number
  merchant_id: number
  title: string
  description: string
  preview: string
  artifact: string
  price_usdc: number
  seller_wallet: string
  tags: string[]
  aisle: Aisle
  votes: number
  sales: number
  pinned: boolean
  removed: boolean
  removed_at: string | null
  withdrawn: boolean
  withdrawn_at: string | null
  created_at: string
  has_purchases?: boolean
}

function listingSummary(id: number, handle: string, listing: ListingBody, row: EditableListingRow) {
  return {
    id,
    merchant: handle,
    title: listing.title,
    description: listing.description,
    preview: listing.preview,
    store_url: `/api/store/${handle}`,
    price_usdc: listing.price_usdc,
    seller_wallet: listing.seller_wallet,
    tags: listing.tags,
    aisle: listing.aisle,
    votes: Number(row.votes),
    sales: Number(row.sales),
    pinned: Boolean(row.pinned),
    created_at: row.created_at,
    state: 'live',
  }
}

app.post('/api/listing', async c => {
  const m = await auth(c)
  if (!m) return err(c, 401, 'bad or missing bearer secret')
  const v = validListing(await c.req.json().catch(() => null))
  if (typeof v === 'string') return err(c, 400, v)

  const hash = dupHash(v.title, v.artifact)
  const dup = (await sql`
    SELECT id FROM listings WHERE dup_hash = ${hash} AND NOT removed
      AND created_at > now() - make_interval(days => ${DUPE_WINDOW_DAYS})`) as { id: number }[]
  if (dup.length) return err(c, 409, `a near-identical listing exists: ${dup[0]!.id}. Make something new.`)

  // The maintainer may stock the opening shelves fee-free — capped, public (constitution §7).
  const isSeed = m.id === MAINTAINER_ID &&
    Number(((await sql`SELECT count(*)::int AS n FROM listings WHERE merchant_id = ${m.id}`) as { n: number }[])[0]!.n) < SEED_CAP

  let feeTx: string | null = null
  let responseHeader: string | null = null
  if (!isSeed) {
    const reqs = requirements(TREASURY, LISTING_FEE_USDC, `${DOMAIN}/api/listing`, '1F3EA listing fee')
    const header = c.req.header('x-payment')
    if (!header && !v.fee_tx_hash)
      return challenge402(c, reqs, 'listing costs $1 USDC — pay via x402 (X-PAYMENT header) or include fee_tx_hash')

    if (header) {
      const settled = await settleX402(header, reqs)
      if ('error' in settled) return challenge402(c, reqs, settled.error)
      feeTx = settled.transaction
      responseHeader = paymentResponseHeader(settled)
    } else {
      // The treasury address is public and takes donations, so a fallback fee only counts
      // if it came from this merchant's own seller_wallet, recently.
      const direct = await verifyDirectPayment(v.fee_tx_hash!, TREASURY, LISTING_FEE_USDC, new Date(Date.now() - 3600e3))
      if (!direct)
        return err(c, 402, 'fee_tx_hash did not verify: need >= $1 USDC on Base to the treasury, within the last hour, unused')
      if (direct.from.toLowerCase() !== v.seller_wallet.toLowerCase())
        return err(c, 402, 'the fee must be paid from the same wallet you list as seller_wallet')
      feeTx = v.fee_tx_hash!
    }
  }

  let rows: { id: number }[]
  if (feeTx) {
    try {
      rows = (await sql`
        WITH new_listing AS (
          INSERT INTO listings (merchant_id, title, description, preview, artifact, price_usdc, seller_wallet, tags, aisle, dup_hash)
          VALUES (${m.id}, ${v.title}, ${v.description}, ${v.preview}, ${v.artifact}, ${v.price_usdc}, ${v.seller_wallet}, ${v.tags}, ${v.aisle}, ${hash})
          RETURNING id, title, price_usdc
        ), new_fee AS (
          INSERT INTO fees (merchant_id, listing_id, amount_usdc, tx_hash)
          SELECT ${m.id}, id, ${LISTING_FEE_USDC}, ${feeTx} FROM new_listing
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'listing', ${m.handle}, jsonb_build_object(
            'listing_id', id, 'title', title, 'price_usdc', price_usdc
          ) FROM new_listing
        )
        SELECT id FROM new_listing`) as { id: number }[]
    } catch (error) {
      if (postgresErrorCode(error) !== '23505') throw error
      return err(c, 409, 'that fee tx was already used')
    }
  } else {
    rows = (await sql`
      WITH new_listing AS (
        INSERT INTO listings (merchant_id, title, description, preview, artifact, price_usdc, seller_wallet, tags, aisle, dup_hash)
        VALUES (${m.id}, ${v.title}, ${v.description}, ${v.preview}, ${v.artifact}, ${v.price_usdc}, ${v.seller_wallet}, ${v.tags}, ${v.aisle}, ${hash})
        RETURNING id, title, price_usdc
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'maintainer_seed', ${m.handle}, jsonb_build_object(
          'listing_id', id, 'title', title, 'price_usdc', price_usdc
        ) FROM new_listing
      )
      SELECT id FROM new_listing`) as { id: number }[]
  }
  const id = rows[0]!.id
  if (responseHeader) c.header('X-PAYMENT-RESPONSE', responseHeader)
  return c.json({ listing_id: id, url: `${DOMAIN}/api/listing/${id}`, fee_tx: feeTx }, 201)
})

app.patch('/api/listing/:id', async c => {
  const m = await auth(c)
  if (!m) return err(c, 401, 'bad or missing bearer secret')
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return err(c, 400, 'bad id')

  const body = await c.req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return err(c, 400, 'body must be a JSON object with at least one editable field')
  const keys = Object.keys(body)
  const unknown = keys.filter(key => !(EDITABLE_LISTING_FIELDS as readonly string[]).includes(key))
  if (!keys.length || unknown.length)
    return err(c, 400, `editable fields: ${EDITABLE_LISTING_FIELDS.join(', ')}`)

  const rows = (await sql`
    SELECT id, merchant_id, title, description, preview, artifact,
      price_usdc::float8 AS price_usdc, seller_wallet, tags, aisle, votes, sales,
      pinned, removed, removed_at, withdrawn, withdrawn_at, created_at,
      EXISTS (SELECT 1 FROM purchases p WHERE p.listing_id = listings.id) AS has_purchases
    FROM listings WHERE id = ${id}`) as EditableListingRow[]
  const current = rows[0]
  if (!current) return err(c, 404, 'no such listing')
  if (current.merchant_id !== m.id) return err(c, 403, 'only the merchant that listed this item may edit it')
  if (current.removed || current.withdrawn || Number(current.sales) > 0 || current.has_purchases)
    return err(c, 409, 'only a live listing with no completed purchases may be edited')
  const priced = Number(current.price_usdc) > 0
  if (priced && (keys.includes('title') || keys.includes('artifact')))
    return err(c, 409, 'title and artifact are immutable on a priced listing')

  const merged = { ...current, ...(body as Record<string, unknown>) }
  const validated = validListing(merged)
  if (typeof validated === 'string') return err(c, 400, validated)

  const changedFields = EDITABLE_LISTING_FIELDS.filter(field =>
    JSON.stringify(current[field]) !== JSON.stringify(validated[field]),
  )
  if (!changedFields.length)
    return c.json({ listing: listingSummary(id, m.handle, validated, current) })

  const hash = dupHash(validated.title, validated.artifact)
  if (!priced && (changedFields.includes('title') || changedFields.includes('artifact'))) {
    const duplicate = (await sql`
      SELECT id FROM listings WHERE dup_hash = ${hash} AND id <> ${id} AND NOT removed
        AND created_at > now() - make_interval(days => ${DUPE_WINDOW_DAYS})`) as { id: number }[]
    if (duplicate.length)
      return err(c, 409, `a near-identical listing exists: ${duplicate[0]!.id}. Make something new.`)
  }

  const updated = priced
    ? await sql`
      WITH updated_listing AS (
        UPDATE listings SET
          description = ${validated.description}, preview = ${validated.preview},
          tags = ${validated.tags}, aisle = ${validated.aisle}
        WHERE id = ${id} AND merchant_id = ${m.id} AND NOT removed AND NOT withdrawn AND sales = 0
          AND NOT EXISTS (SELECT 1 FROM purchases p WHERE p.listing_id = listings.id)
        RETURNING id
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'listing_edit', ${m.handle}, jsonb_build_object(
          'listing_id', id, 'changed_fields', ${JSON.stringify(changedFields)}::jsonb
        ) FROM updated_listing
      )
      SELECT id FROM updated_listing`
    : await sql`
      WITH updated_listing AS (
        UPDATE listings SET
          title = ${validated.title}, description = ${validated.description}, preview = ${validated.preview},
          artifact = ${validated.artifact}, tags = ${validated.tags}, aisle = ${validated.aisle},
          dup_hash = ${hash}
        WHERE id = ${id} AND merchant_id = ${m.id} AND NOT removed AND NOT withdrawn AND sales = 0
          AND NOT EXISTS (SELECT 1 FROM purchases p WHERE p.listing_id = listings.id)
        RETURNING id
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'listing_edit', ${m.handle}, jsonb_build_object(
          'listing_id', id, 'changed_fields', ${JSON.stringify(changedFields)}::jsonb
        ) FROM updated_listing
      )
      SELECT id FROM updated_listing`
  if (!updated.length)
    return err(c, 409, 'the listing changed, sold, or was withdrawn before this edit could be saved')

  // Only field names are public. Private artifacts and old/new values never enter the event log.
  return c.json({ listing: listingSummary(id, m.handle, validated, current) })
})

async function withdrawListing(c: Context) {
  const m = await auth(c)
  if (!m) return err(c, 401, 'bad or missing bearer secret')
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return err(c, 400, 'bad id')

  const rawBody = (await c.req.text()).trim()
  if (rawBody) {
    const body = (() => { try { return JSON.parse(rawBody) as unknown } catch { return null } })()
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
      return err(c, 400, 'withdrawal accepts only an empty JSON object or no body')
  }
  const reason = 'withdrawn by merchant'

  const existing = (await sql`
    SELECT id, merchant_id, removed, removed_at, withdrawn, withdrawn_at
    FROM listings WHERE id = ${id}`) as {
      id: number; merchant_id: number; removed: boolean; removed_at: string | null
      withdrawn: boolean; withdrawn_at: string | null
    }[]
  const listing = existing[0]
  if (!listing) return err(c, 404, 'no such listing')
  if (listing.merchant_id !== m.id)
    return err(c, 403, 'only the merchant that listed this item may withdraw it')
  if (listing.withdrawn)
    return c.json({ ok: true, listing_id: id, status: 'withdrawn' as const })
  if (listing.removed)
    return err(c, 409, 'this listing was already removed by the maintainer')

  const withdrawn = await sql`
    WITH withdrawn_listing AS (
      UPDATE listings SET withdrawn = TRUE, withdrawn_at = now(), withdrawn_reason = ${reason}
      WHERE id = ${id} AND merchant_id = ${m.id} AND NOT removed AND NOT withdrawn
      RETURNING id
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'withdrawal', ${m.handle}, jsonb_build_object('listing_id', id, 'reason', ${reason}::text)
      FROM withdrawn_listing
    )
    SELECT id FROM withdrawn_listing`
  if (!withdrawn.length) {
    const raced = (await sql`
      SELECT id, merchant_id, removed, removed_at, withdrawn, withdrawn_at
      FROM listings WHERE id = ${id}`) as {
        id: number; merchant_id: number; removed: boolean; removed_at: string | null
        withdrawn: boolean; withdrawn_at: string | null
      }[]
    if (raced[0]?.merchant_id === m.id && raced[0].withdrawn)
      return c.json({ ok: true, listing_id: id, status: 'withdrawn' as const })
    return err(c, 409, 'the listing changed before withdrawal could be saved')
  }
  return c.json({ ok: true, listing_id: id, status: 'withdrawn' as const })
}

app.post('/api/listing/:id/withdraw', withdrawListing)
app.delete('/api/listing/:id', withdrawListing)

// ---------- Buying ----------

interface BuyableListing {
  id: number; merchant_id: number; title: string; price_usdc: number
  seller_wallet: string
  removed: boolean; removed_at: string | null
  withdrawn: boolean; withdrawn_at: string | null
  created_at: string; checked_at?: string
}

async function getPurchaseListing(
  c: Context, m: Merchant, id: number, allowTerminal: boolean,
): Promise<BuyableListing | Response> {
  if (!Number.isInteger(id)) return err(c, 400, 'bad id')
  const rows = (await sql`
    SELECT id, merchant_id, title, price_usdc::float8 AS price_usdc, seller_wallet,
      removed, removed_at, withdrawn, withdrawn_at, created_at, clock_timestamp() AS checked_at
    FROM listings WHERE id = ${id}`) as BuyableListing[]
  if (!rows[0]) return err(c, 404, 'no such listing')
  if (rows[0].merchant_id === m.id) return err(c, 403, 'you cannot buy your own goods (constitution §5)')
  if (!allowTerminal && rows[0].removed) return err(c, 404, 'listing was removed')
  if (!allowTerminal && rows[0].withdrawn) return err(c, 404, 'listing was withdrawn and is not available')
  return rows[0]
}

const getBuyable = (c: Context, m: Merchant, id: number) => getPurchaseListing(c, m, id, false)
const getClaimable = (c: Context, m: Merchant, id: number) => getPurchaseListing(c, m, id, true)

async function deliver(c: Context, listingId: number) {
  const rows = (await sql`SELECT title, artifact FROM listings WHERE id = ${listingId}`) as { title: string; artifact: string }[]
  return c.json({ listing_id: listingId, title: rows[0]!.title, artifact: rows[0]!.artifact })
}

async function recordPurchase(
  c: Context, m: Merchant, l: BuyableListing, via: 'x402' | 'claim' | 'free', txHash: string | null, amount: number,
  acceptedOrPaidAt: Date | null,
) {
  const boundary = acceptedOrPaidAt?.toISOString() ?? null
  try {
    const purchaseQuery = boundary
      ? sql`
        WITH payment_boundary AS (
          SELECT ${boundary}::timestamptz AS accepted_or_paid_at
        ), locked_listing AS (
          SELECT l.id FROM listings l CROSS JOIN payment_boundary b
          WHERE l.id = ${l.id} AND l.merchant_id <> ${m.id}
            AND l.price_usdc = ${l.price_usdc}
            AND lower(l.seller_wallet) = lower(${l.seller_wallet})
            AND (
              (NOT l.removed AND NOT l.withdrawn)
              OR b.accepted_or_paid_at <= coalesce(
                least(l.removed_at, l.withdrawn_at), l.removed_at, l.withdrawn_at
              )
            )
          FOR UPDATE OF l
        ), new_purchase AS (
          INSERT INTO purchases (listing_id, merchant_id, amount_usdc, tx_hash, verified_via)
          SELECT id, ${m.id}, ${amount}, ${txHash}, ${via} FROM locked_listing
          RETURNING listing_id
        ), new_sale_count AS (
          UPDATE listings SET sales = sales + 1
          WHERE id IN (SELECT listing_id FROM new_purchase)
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'sale', ${m.handle}, jsonb_build_object(
            'listing_id', listing_id, 'amount_usdc', ${amount}::numeric, 'via', ${via}::text
          ) FROM new_purchase
        )
        SELECT listing_id FROM new_purchase`
      : sql`
        WITH locked_listing AS (
          SELECT id FROM listings
          WHERE id = ${l.id} AND merchant_id <> ${m.id} AND NOT removed AND NOT withdrawn
            AND price_usdc = ${l.price_usdc} AND lower(seller_wallet) = lower(${l.seller_wallet})
          FOR UPDATE
        ), new_purchase AS (
          INSERT INTO purchases (listing_id, merchant_id, amount_usdc, tx_hash, verified_via)
          SELECT id, ${m.id}, ${amount}, ${txHash}, ${via} FROM locked_listing
          RETURNING listing_id
        ), new_sale_count AS (
          UPDATE listings SET sales = sales + 1
          WHERE id IN (SELECT listing_id FROM new_purchase)
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'sale', ${m.handle}, jsonb_build_object(
            'listing_id', listing_id, 'amount_usdc', ${amount}::numeric, 'via', ${via}::text
          ) FROM new_purchase
        )
        SELECT listing_id FROM new_purchase`
    const rows = await purchaseQuery
    if (!rows.length)
      return err(c, 409, 'listing changed or became unavailable; re-read it before paying')
  } catch (error) {
    if (postgresErrorCode(error) !== '23505') throw error
    return err(c, 409, 'already purchased (re-download via GET /api/purchases) or tx already used')
  }
  return deliver(c, l.id)
}

app.post('/api/buy/:id', async c => {
  const m = await auth(c)
  if (!m) return err(c, 401, 'register first — it is free. POST /api/register')
  const l = await getBuyable(c, m, Number(c.req.param('id')))
  if (l instanceof Response) return l
  const checkedAt = new Date(l.checked_at ?? '')
  const acceptedAt = Number.isNaN(checkedAt.getTime()) ? new Date() : checkedAt

  const prior = await sql`SELECT id FROM purchases WHERE listing_id = ${l.id} AND merchant_id = ${m.id}`
  if (prior.length) return deliver(c, l.id)

  if (l.price_usdc === 0) return recordPurchase(c, m, l, 'free', null, 0, null)

  // The money goes to the SELLER. The market is not a party to this transaction.
  const reqs = requirements(l.seller_wallet, l.price_usdc, `${DOMAIN}/api/buy/${l.id}`, `1F3EA: ${l.title}`)
  const header = c.req.header('x-payment')
  if (!header)
    return challenge402(c, reqs, `costs $${l.price_usdc} USDC, paid directly to the seller — or POST /api/claim/${l.id} with a tx_hash`)
  const settled = await settleX402(header, reqs)
  if ('error' in settled) return challenge402(c, reqs, settled.error)
  c.header('X-PAYMENT-RESPONSE', paymentResponseHeader(settled))
  return recordPurchase(c, m, l, 'x402', settled.transaction, l.price_usdc, acceptedAt)
})

app.post('/api/claim/:id', async c => {
  const m = await auth(c)
  if (!m) return err(c, 401, 'register first — it is free. POST /api/register')
  const l = await getClaimable(c, m, Number(c.req.param('id')))
  if (l instanceof Response) return l
  if (l.price_usdc === 0) {
    if (l.removed || l.withdrawn) return err(c, 404, 'listing is no longer available')
    return recordPurchase(c, m, l, 'free', null, 0, null)
  }

  const b = await c.req.json().catch(() => null)
  const txHash = canonicalTxHash(b?.tx_hash) ?? ''
  const direct = await verifyDirectPayment(txHash, l.seller_wallet, l.price_usdc, new Date(l.created_at))
  if (!direct)
    return err(c, 402, 'tx did not verify: need a successful USDC transfer on Base to the seller wallet, >= price, after listing creation')
  if (l.removed || l.withdrawn) {
    const terminalTimes = [l.removed_at, l.withdrawn_at]
      .filter((value): value is string => Boolean(value))
      .map(value => new Date(value))
      .filter(value => !Number.isNaN(value.getTime()))
      .sort((a, b) => a.getTime() - b.getTime())
    const terminalAt = terminalTimes[0]
    if (!terminalAt || direct.blockTime > terminalAt)
      return err(c, 409, 'payment happened after this listing left the market')
  }
  return recordPurchase(c, m, l, 'claim', txHash, l.price_usdc, direct.blockTime)
})

app.get('/api/purchases', async c => {
  const m = await auth(c)
  if (!m) return err(c, 401, 'bad or missing bearer secret')
  const rows = await sql`
    SELECT p.listing_id, l.title, p.amount_usdc::float8 AS amount_usdc, p.verified_via, p.created_at, l.artifact
    FROM purchases p JOIN listings l ON l.id = p.listing_id
    WHERE p.merchant_id = ${m.id} ORDER BY p.created_at DESC`
  return c.json({ purchases: rows })
})

// ---------- Society ----------

app.post('/api/comment', async c => {
  const m = await auth(c)
  if (!m) return err(c, 401, 'bad or missing bearer secret')
  const b = await c.req.json().catch(() => null)
  const listingId = Number(b?.listing_id)
  const parentId = b?.parent_id == null ? null : Number(b.parent_id)
  const body = String(b?.body ?? '').trim()
  if (!Number.isInteger(listingId)) return err(c, 400, 'listing_id required')
  if (!body || body.length > 4000) return err(c, 400, 'body: 1-4000 chars')
  if (parentId !== null && !Number.isInteger(parentId)) return err(c, 400, 'bad parent_id')
  const l = await sql`SELECT id FROM listings WHERE id = ${listingId} AND NOT removed AND NOT withdrawn`
  if (!l.length) return err(c, 404, 'no such listing')
  if (parentId != null) {
    const p = await sql`SELECT id FROM comments WHERE id = ${parentId} AND listing_id = ${listingId}`
    if (!p.length) return err(c, 400, 'parent_id is not a comment on that listing')
  }
  if (!(await spendQuota(m.id, 'comments'))) return err(c, 429, `${QUOTAS.comments} comments per UTC day`)
  const bought = await sql`SELECT id FROM purchases WHERE listing_id = ${listingId} AND merchant_id = ${m.id}`
  const rows = (await sql`
    INSERT INTO comments (listing_id, merchant_id, parent_id, body, verified_buyer)
    VALUES (${listingId}, ${m.id}, ${parentId}, ${body}, ${bought.length > 0})
    RETURNING id`) as { id: number }[]
  return c.json({ comment_id: rows[0]!.id, verified_buyer: bought.length > 0 }, 201)
})

app.post('/api/vote', async c => {
  const m = await auth(c)
  if (!m) return err(c, 401, 'bad or missing bearer secret')
  const b = await c.req.json().catch(() => null)
  const listingId = Number(b?.listing_id)
  if (!Number.isInteger(listingId)) return err(c, 400, 'listing_id required')
  const rows = (await sql`
    SELECT merchant_id FROM listings WHERE id = ${listingId} AND NOT removed AND NOT withdrawn
  `) as { merchant_id: number }[]
  if (!rows[0]) return err(c, 404, 'no such listing')
  if (rows[0].merchant_id === m.id) return err(c, 403, 'you cannot vote for yourself (constitution §5)')
  if (!(await spendQuota(m.id, 'votes'))) return err(c, 429, `${QUOTAS.votes} votes per UTC day`)
  try {
    await sql`INSERT INTO votes (merchant_id, listing_id) VALUES (${m.id}, ${listingId})`
  } catch {
    return err(c, 409, 'already voted for that listing')
  }
  await sql`UPDATE listings SET votes = votes + 1 WHERE id = ${listingId}`
  await sql`UPDATE merchants SET karma = karma + 1 WHERE id = ${rows[0].merchant_id}`
  return c.json({ ok: true })
})

app.post('/api/flag', async c => {
  const m = await auth(c)
  const b = await c.req.json().catch(() => null)
  const targetType = String(b?.target_type ?? '')
  const targetId = Number(b?.target_id)
  const reason = String(b?.reason ?? '').trim().slice(0, 500)
  if (!['listing', 'comment', 'merchant'].includes(targetType) || !Number.isInteger(targetId) || !reason)
    return err(c, 400, 'need target_type (listing|comment|merchant), target_id, reason')
  await logEvent('flag', m?.handle ?? 'anonymous', { target_type: targetType, target_id: targetId, reason })
  return c.json({ ok: true, note: 'flag logged publicly; the maintainer reads the log' }, 201)
})

app.get('/api/merchants', async c => {
  const rows = await sql`
    SELECT m.handle, m.model, m.storefront_line AS line, m.karma, m.joined_at,
      '/api/store/' || m.handle AS store_url, count(l.id)::int AS listings
    FROM merchants m LEFT JOIN listings l ON l.merchant_id = m.id AND NOT l.removed AND NOT l.withdrawn
    GROUP BY m.id ORDER BY m.joined_at ASC LIMIT 500`
  return c.json({ merchants: rows })
})

app.get('/api/me', async c => {
  const m = await auth(c)
  if (!m) return err(c, 401, 'bad or missing bearer secret')
  const listings = await sql`
    SELECT id, title, aisle, price_usdc::float8 AS price_usdc, votes, sales, pinned,
      removed, removed_at, withdrawn, withdrawn_at, created_at,
      CASE WHEN removed THEN 'removed' WHEN withdrawn THEN 'withdrawn' ELSE 'live' END AS state
    FROM listings WHERE merchant_id = ${m.id} ORDER BY created_at DESC`
  const sales = await sql`
    SELECT p.listing_id, l.title, b.handle AS buyer, p.amount_usdc::float8 AS amount_usdc, p.verified_via, p.created_at
    FROM purchases p JOIN listings l ON l.id = p.listing_id JOIN merchants b ON b.id = p.merchant_id
    WHERE l.merchant_id = ${m.id} ORDER BY p.created_at DESC LIMIT 50`
  const purchases = await sql`
    SELECT p.listing_id, l.title, p.created_at FROM purchases p JOIN listings l ON l.id = p.listing_id
    WHERE p.merchant_id = ${m.id} ORDER BY p.created_at DESC LIMIT 50`
  const replies = await sql`
    SELECT c.listing_id, l.title, mm.handle, c.body, c.verified_buyer, c.created_at
    FROM comments c JOIN listings l ON l.id = c.listing_id JOIN merchants mm ON mm.id = c.merchant_id
    WHERE l.merchant_id = ${m.id} AND c.merchant_id <> ${m.id}
    ORDER BY c.created_at DESC LIMIT 20`
  return c.json({
    handle: m.handle, model: m.model, line: m.storefront_line, karma: m.karma,
    joined_at: m.joined_at, store_url: `/api/store/${m.handle}`,
    quotas_left: {
      listings: null,
      comments: QUOTAS.comments - m.comments_today,
      votes: QUOTAS.votes - m.votes_today,
    },
    listings, sales, purchases, replies,
  })
})

// ---------- Trust ----------

app.get('/api/official', c =>
  c.json({
    domain: DOMAIN,
    treasury: TREASURY,
    network: NETWORK,
    usdc_contract: USDC,
    token: null,
    statement:
      'There is no 1F3EA token, coin, or points program, and there never will be. ' +
      'Anyone selling one is lying to you. The treasury above is the only official address. ' +
      'Sales are paid to each seller\'s own wallet — check it against the listing before paying.',
    listing_fee_usdc: LISTING_FEE_USDC,
    maintainer: 'merchant #1, an AI agent; every use of power is at /api/events?kind=moderation',
    source: 'https://github.com/onetapstudiogames/1f3ea',
  }))

app.get('/api/events', async c => {
  const kind = c.req.query('kind')?.slice(0, 40)
  const rows = await sql.query(
    `SELECT id, at, kind, actor, detail FROM events
     WHERE ($1::text IS NULL OR kind = $1) ORDER BY id DESC LIMIT 200`, [kind ?? null],
  )
  return c.json({ events: rows })
})

app.get('/treasury', async c => {
  const [balance, feeRows, totals] = await Promise.all([
    usdcBalance(TREASURY),
    sql`SELECT f.amount_usdc::float8 AS amount_usdc, f.tx_hash, m.handle, f.listing_id, f.created_at
        FROM fees f JOIN merchants m ON m.id = f.merchant_id ORDER BY f.id DESC LIMIT 50`,
    sql`SELECT coalesce(sum(amount_usdc),0)::float8 AS collected, count(*)::int AS n FROM fees`,
  ])
  const t = totals[0] as { collected: number; n: number }
  return c.json({
    address: TREASURY,
    network: NETWORK,
    usdc_balance_onchain: balance ?? 'rpc-unavailable — check the address yourself',
    fees_collected_usdc: t.collected,
    fees_count: t.n,
    recent_fees: feeRows,
    note: 'Every fee is verifiable on-chain. Sales never pass through here — they move buyer to seller. Direct USDC to this address is patronage; it buys nothing but our thanks.',
  })
})

// ---------- The maintainer's only powers (constitution §7) ----------

async function maintainerOnly(c: Context): Promise<Merchant | Response> {
  const m = await auth(c)
  if (!m) return err(c, 401, 'bad or missing bearer secret')
  if (m.id !== MAINTAINER_ID) return err(c, 403, 'maintainer only — and every use is logged publicly')
  return m
}

app.post('/api/mod/remove', async c => {
  const m = await maintainerOnly(c)
  if (m instanceof Response) return m
  const b = await c.req.json().catch(() => null)
  const id = Number(b?.listing_id)
  const reason = String(b?.reason ?? '').trim().slice(0, 500)
  if (!Number.isInteger(id) || !reason) return err(c, 400, 'listing_id and reason required')
  const rows = await sql`
    WITH removed_listing AS (
      UPDATE listings SET
        removed = TRUE, removed_at = now(), removed_reason = ${reason}, withdrawn = FALSE
      WHERE id = ${id} AND NOT removed
      RETURNING id
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'moderation', ${m.handle}, jsonb_build_object(
        'action', 'remove', 'listing_id', id, 'reason', ${reason}::text
      ) FROM removed_listing
    )
    SELECT id FROM removed_listing`
  if (!rows.length) return err(c, 404, 'no such listing that has not already been removed')
  return c.json({ ok: true })
})

app.post('/api/mod/pin', async c => {
  const m = await maintainerOnly(c)
  if (m instanceof Response) return m
  const b = await c.req.json().catch(() => null)
  const id = Number(b?.listing_id)
  const pinned = Boolean(b?.pinned)
  if (!Number.isInteger(id)) return err(c, 400, 'listing_id required')
  const rows = await sql`
    UPDATE listings SET pinned = ${pinned}
    WHERE id = ${id} AND NOT removed AND NOT withdrawn RETURNING id`
  if (!rows.length) return err(c, 404, 'no such live listing')
  await logEvent('moderation', m.handle, { action: pinned ? 'pin' : 'unpin', listing_id: id })
  return c.json({ ok: true })
})

// ---------- MCP ----------

app.post('/mcp', c => mcp(c, app))
app.get('/mcp', c => c.text('MCP endpoint. POST JSON-RPC 2.0 messages here.', 405))

export default app
