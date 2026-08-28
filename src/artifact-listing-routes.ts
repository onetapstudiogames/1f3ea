import type { Context, Hono } from 'hono'
import { sql } from './db.ts'
import { auth, dupHash, err, sha256, WALLET_RE } from './core.ts'
import {
  AISLES,
  EDITABLE_LISTING_FIELDS,
  isAisle,
  suggestAisle,
  type Aisle,
} from './market.ts'
import {
  canonicalTxHash,
  challenge402,
  LISTING_FEE_USDC,
  paymentReadinessResponse,
  paymentResponseHeader,
  requirements,
  resumeX402PaymentForTerms,
  settleX402,
  TREASURY,
} from './pay.ts'
import { readX402PaymentAttempt, x402ProofDigest } from './x402-payment-attempts.ts'
import { cityCancelUrl } from './world.ts'
import { postgresUniqueConstraint } from './postgres-error.ts'
import {
  readListingFeeAttempt,
  resolveListingFeePayment,
  reviewListingFeePayment,
  type ListingFeeResolution,
} from './listing-fee-payment.ts'
import { x402CustodyFailureResponse, x402NoPayResponse } from './x402-route-response.ts'

const DUPE_WINDOW_DAYS = 7
const FEE_TX_CONSTRAINTS: readonly string[] = [
  'fees_tx_hash_key',
  'fees_tx_hash_lower_unique',
  'payment_uses_pkey',
]

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
  if (rawAisle === 'world') return 'world listings start at POST /api/world/draft; artifact listings cannot use the world aisle'
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
  delivery_kind: 'artifact' | 'city_ownership'
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
    delivery_kind: 'artifact' as const,
    world_origin: null,
    world_offer_id: null,
    world_asset_id: null,
    world_seller_handle: null,
    world_draft_id: null,
    world_state: null,
    requires_city_resident: false,
    votes: Number(row.votes),
    sales: Number(row.sales),
    pinned: Boolean(row.pinned),
    created_at: row.created_at,
    state: 'live',
  }
}

export function registerArtifactListingRoutes(
  app: Hono,
  config: { domain: string; maintainerId: number; seedCap: number },
) {
  const { domain: DOMAIN, maintainerId: MAINTAINER_ID, seedCap: SEED_CAP } = config

app.post('/api/listing', async c => {
  const requestStartedAt = new Date()
  const m = await auth(c)
  if (!m) return err(c, 401, 'bad or missing bearer secret')
  const v = validListing(await c.req.json().catch(() => null))
  if (typeof v === 'string') return err(c, 400, v)
  const unavailable = paymentReadinessResponse(c)
  if (unavailable) return unavailable

  const hash = dupHash(v.title, v.artifact)
  const feeRequestHash = sha256(JSON.stringify({
    version: 1,
    merchant_id: m.id,
    kind: 'artifact_listing',
    title: v.title,
    description: v.description,
    preview: v.preview,
    artifact: v.artifact,
    price_usdc: v.price_usdc,
    seller_wallet: v.seller_wallet.toLowerCase(),
    tags: v.tags,
    aisle: v.aisle,
  }))
  const paymentHeader = c.req.header('x-payment')
  const x402Operation = {
    operationKey: `listing-fee:artifact:${m.id}:${feeRequestHash}`,
    operationKind: 'listing_fee' as const,
    operationStartedAt: requestStartedAt,
  }
  const x402Requirements = requirements(
    TREASURY, LISTING_FEE_USDC, `${DOMAIN}/api/listing`, '1F3EA listing fee',
  )
  const preservedFee = await readListingFeeAttempt(m.id, 'artifact_listing', feeRequestHash)
  if (!preservedFee && paymentHeader && v.fee_tx_hash) {
    return err(c, 400,
      'choose exactly one listing fee method: X-PAYMENT or fee_tx_hash; neither fee was processed')
  }
  if (preservedFee && paymentHeader) {
    return c.json({
      error: 'this listing request already has a direct fee transaction; remove X-PAYMENT and retry; do not pay again',
      retry: 'retry the same listing body without X-PAYMENT',
      fee_tx_hash: preservedFee.tx_hash,
      do_not_pay_again: true,
    }, 409)
  }
  let x402Payment = await resumeX402PaymentForTerms(
    x402Operation.operationKey, x402Operation.operationKind, x402Requirements,
  )
  if (x402Payment && v.fee_tx_hash) {
    return x402NoPayResponse(
      c,
      409,
      'this listing request already has an X-PAYMENT operation; its direct fee transaction was not used',
      'retry this exact listing request without fee_tx_hash or X-PAYMENT',
    )
  }
  if (x402Payment && paymentHeader) {
    let originalProof = false
    try {
      const stored = await readX402PaymentAttempt(x402Operation.operationKey)
      originalProof = stored != null && stored.proof_digest === x402ProofDigest(paymentHeader)
    } catch {
      originalProof = false
    }
    if (!originalProof) {
      return x402NoPayResponse(
        c,
        409,
        'this saved listing fee is already bound to its original X-PAYMENT proof',
        'retry this exact listing request without X-PAYMENT so the market can resume the stored proof',
      )
    }
  }
  if (x402Payment && x402Payment.status !== 'verified') {
    return x402CustodyFailureResponse(c, x402Requirements, x402Payment)
  }
  if (x402Payment) {
    try {
      const completed = (await sql`
        /* x402-listing:completed */
        SELECT l.id FROM fees f
        JOIN listings l ON l.id = f.listing_id
        WHERE f.merchant_id = ${m.id} AND lower(f.tx_hash) = ${x402Payment.transaction}
          AND l.merchant_id = ${m.id} AND l.dup_hash = ${hash}
        LIMIT 1`) as { id: number }[]
      if (completed[0]) {
        return c.json({
          listing_id: completed[0].id,
          url: `${DOMAIN}/api/listing/${completed[0].id}`,
          fee_tx: x402Payment.transaction,
        })
      }
    } catch (error) {
      console.error('x402 listing replay lookup failed after payment was preserved', error)
      return x402NoPayResponse(
        c,
        503,
        'the market could not check whether this paid listing was already created',
        'retry this exact listing request without X-PAYMENT',
      )
    }
  }
  let directFee: Extract<ListingFeeResolution, { state: 'verified' }> | null = null
  if (preservedFee && !x402Payment) {
    const resolved = await resolveListingFeePayment({
      merchantId: m.id,
      requestKind: 'artifact_listing',
      requestHash: feeRequestHash,
      txHash: v.fee_tx_hash ?? preservedFee.tx_hash,
      payerWallet: v.seller_wallet,
      requestStartedAt,
    })
    if (resolved.state === 'response') return c.json(resolved.body, resolved.status)
    if (resolved.state === 'completed') {
      return c.json({
        listing_id: resolved.listingId,
        url: `${DOMAIN}/api/listing/${resolved.listingId}`,
        fee_tx: preservedFee.tx_hash,
      })
    }
    directFee = resolved
  }
  let dup: { id: number }[]
  try {
    dup = (await sql`
      SELECT id FROM listings WHERE dup_hash = ${hash} AND NOT removed
        AND created_at > now() - make_interval(days => ${DUPE_WINDOW_DAYS})`) as { id: number }[]
  } catch (error) {
    if (!x402Payment) throw error
    console.error('x402 listing duplicate check failed after payment was preserved', error)
    return x402NoPayResponse(
      c,
      503,
      'the market could not safely check this paid listing for recent duplicates',
      'retry this exact listing request without X-PAYMENT',
    )
  }
  if (dup.length) {
    if (directFee) {
      const reviewed = await reviewListingFeePayment(
        directFee.attemptId,
        `a near-identical listing already exists: ${dup[0]!.id}`,
        directFee.finality,
      )
      if (reviewed.state === 'completed') {
        return c.json({
          listing_id: reviewed.listingId,
          url: `${DOMAIN}/api/listing/${reviewed.listingId}`,
          fee_tx: v.fee_tx_hash,
        })
      }
      return c.json(reviewed.body, reviewed.status)
    }
    if (x402Payment) {
      return x402NoPayResponse(
        c,
        409,
        `this paid listing request now conflicts with near-identical listing ${dup[0]!.id}`,
        'retry this exact listing request without X-PAYMENT for payment review',
      )
    }
    return err(c, 409, `a near-identical listing exists: ${dup[0]!.id}. Make something new.`)
  }

  // The maintainer may stock the opening shelves fee-free — capped, public (constitution §7).
  const isSeed = !x402Payment && m.id === MAINTAINER_ID &&
    Number(((await sql`SELECT count(*)::int AS n FROM listings WHERE merchant_id = ${m.id}`) as { n: number }[])[0]!.n) < SEED_CAP

  let feeTx: string | null = x402Payment?.transaction ?? null
  let responseHeader: string | null = null
  if (!isSeed || x402Payment) {
    const reqs = x402Requirements
    if (!paymentHeader && !v.fee_tx_hash && !directFee && !x402Payment)
      return challenge402(c, reqs, 'listing costs $1 USDC — pay via x402 (X-PAYMENT header) or include fee_tx_hash')

    if (paymentHeader && !x402Payment) {
      const settled = await settleX402(paymentHeader, reqs, x402Operation)
      if (settled.status !== 'verified') {
        return x402CustodyFailureResponse(c, reqs, settled)
      }
      x402Payment = settled
      feeTx = settled.transaction
      if (settled.raw) {
        responseHeader = paymentResponseHeader({
          status: 'verified', transaction: settled.transaction, payer: settled.payer, raw: settled.raw,
        })
      }
    } else if (!x402Payment) {
      if (!directFee) {
        const resolved = await resolveListingFeePayment({
          merchantId: m.id,
          requestKind: 'artifact_listing',
          requestHash: feeRequestHash,
          txHash: v.fee_tx_hash!,
          payerWallet: v.seller_wallet,
          requestStartedAt,
        })
        if (resolved.state === 'response') return c.json(resolved.body, resolved.status)
        if (resolved.state === 'completed') {
          return c.json({
            listing_id: resolved.listingId,
            url: `${DOMAIN}/api/listing/${resolved.listingId}`,
            fee_tx: v.fee_tx_hash,
          })
        }
        directFee = resolved
      }
      feeTx = directFee.txHash
    }
  }

  let rows: { id: number }[]
  if (directFee) {
    const { finality } = directFee
    rows = (await sql`
      WITH locked_fee_attempt AS (
        SELECT id FROM listing_fee_attempts
        WHERE id = ${directFee.attemptId} AND merchant_id = ${m.id}
          AND fee_request_kind = 'artifact_listing'
          AND fee_request_hash = ${feeRequestHash}
          AND tx_hash = ${directFee.txHash} AND payment_status = 'payment_pending'
        FOR UPDATE
      ), new_listing AS (
        INSERT INTO listings (
          merchant_id, title, description, preview, artifact, price_usdc,
          seller_wallet, tags, aisle, dup_hash
        )
        SELECT ${m.id}, ${v.title}, ${v.description}, ${v.preview}, ${v.artifact},
          ${v.price_usdc}, ${v.seller_wallet}, ${v.tags}, ${v.aisle}, ${hash}
        FROM locked_fee_attempt
        RETURNING id, title, price_usdc
      ), completed_attempt AS (
        UPDATE listing_fee_attempts attempt SET
          payment_status = 'completed', listing_id = listing.id,
          finalized_block_number = ${finality.blockNumber.toString()},
          finalized_block_hash = ${finality.blockHash},
          finalized_block_time = ${finality.blockTime.toISOString()},
          finalized_at = ${finality.finalizedAt.toISOString()}
        FROM new_listing listing
        WHERE attempt.id = ${directFee.attemptId} AND attempt.payment_status = 'payment_pending'
        RETURNING attempt.id, attempt.listing_id
      ), new_fee AS (
        INSERT INTO fees (
          merchant_id, listing_id, amount_usdc, tx_hash,
          listing_fee_attempt_id, verification_method
        )
        SELECT ${m.id}, listing.id, ${LISTING_FEE_USDC},
          ${directFee.txHash}, attempt.id, 'direct'
        FROM new_listing listing
        JOIN completed_attempt attempt ON attempt.listing_id = listing.id
        RETURNING listing_id, listing_fee_attempt_id
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'listing', ${m.handle}, jsonb_build_object(
          'listing_id', listing.id, 'title', listing.title, 'price_usdc', listing.price_usdc
        )
        FROM new_listing listing
        JOIN new_fee fee ON fee.listing_id = listing.id
      )
      SELECT listing.id FROM new_listing listing
      JOIN completed_attempt attempt ON attempt.listing_id = listing.id
      JOIN new_fee fee ON fee.listing_id = listing.id`) as { id: number }[]
    if (!rows.length) {
      const reviewed = await reviewListingFeePayment(
        directFee.attemptId,
        'the listing changed before its finalized fee could create it',
        directFee.finality,
      )
      if (reviewed.state === 'completed') {
        return c.json({
          listing_id: reviewed.listingId,
          url: `${DOMAIN}/api/listing/${reviewed.listingId}`,
          fee_tx: directFee.txHash,
        })
      }
      return c.json(reviewed.body, reviewed.status)
    }
  } else if (feeTx) {
    try {
      rows = (await sql`
        WITH new_listing AS (
          INSERT INTO listings (merchant_id, title, description, preview, artifact, price_usdc, seller_wallet, tags, aisle, dup_hash)
          VALUES (${m.id}, ${v.title}, ${v.description}, ${v.preview}, ${v.artifact}, ${v.price_usdc}, ${v.seller_wallet}, ${v.tags}, ${v.aisle}, ${hash})
          RETURNING id, title, price_usdc
        ), new_fee AS (
          INSERT INTO fees (merchant_id, listing_id, amount_usdc, tx_hash,
            x402_payment_operation_key, verification_method)
          SELECT ${m.id}, id, ${LISTING_FEE_USDC}, ${feeTx}, ${x402Operation.operationKey}, 'x402' FROM new_listing
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'listing', ${m.handle}, jsonb_build_object(
            'listing_id', id, 'title', title, 'price_usdc', price_usdc
          ) FROM new_listing
        )
        SELECT id FROM new_listing`) as { id: number }[]
    } catch (error) {
      const constraint = postgresUniqueConstraint(error)
      console.error('x402 listing creation failed after payment was preserved', error)
      return x402NoPayResponse(
        c,
        constraint && FEE_TX_CONSTRAINTS.includes(constraint) ? 409 : 503,
        constraint && FEE_TX_CONSTRAINTS.includes(constraint)
          ? 'this preserved fee transaction conflicts with another market payment record'
          : 'the market could not confirm that this paid listing was created',
        'retry this exact listing request without X-PAYMENT',
      )
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
  if (!rows[0] && x402Payment) {
    return x402NoPayResponse(
      c,
      503,
      'the market could not confirm that this paid listing was created',
      'retry this exact listing request without X-PAYMENT',
    )
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
      price_usdc::float8 AS price_usdc, seller_wallet, tags, aisle, delivery_kind, votes, sales,
      pinned, removed, removed_at, withdrawn, withdrawn_at, created_at,
      EXISTS (SELECT 1 FROM purchases p WHERE p.listing_id = listings.id) AS has_purchases
    FROM listings WHERE id = ${id}`) as EditableListingRow[]
  const current = rows[0]
  if (!current) return err(c, 404, 'no such listing')
  if (current.merchant_id !== m.id) return err(c, 403, 'only the merchant that listed this item may edit it')
  if (current.delivery_kind === 'city_ownership')
    return err(c, 409, 'world listing terms are locked in the city and cannot be edited')
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
    SELECT id, merchant_id, removed, removed_at, withdrawn, withdrawn_at,
      delivery_kind, world_offer_id, world_draft_id, world_state
    FROM listings WHERE id = ${id}`) as {
      id: number; merchant_id: number; removed: boolean; removed_at: string | null
      withdrawn: boolean; withdrawn_at: string | null
      delivery_kind: 'artifact' | 'city_ownership'; world_offer_id: number | null
      world_draft_id: number | null; world_state: string | null
    }[]
  const listing = existing[0]
  if (!listing) return err(c, 404, 'no such listing')
  if (listing.merchant_id !== m.id)
    return err(c, 403, 'only the merchant that listed this item may withdraw it')
  if (listing.delivery_kind === 'city_ownership' && listing.world_state === 'sold')
    return err(c, 409, 'city ownership was already sold; its market receipt is permanent')
  if (listing.withdrawn)
    return c.json({
      ok: true, listing_id: id, status: 'withdrawn' as const,
      ...(listing.delivery_kind === 'city_ownership' && listing.world_offer_id
        ? { city_unlock_required: true, city_cancel_url: cityCancelUrl(listing.world_offer_id) }
        : {}),
    })
  if (listing.removed)
    return err(c, 409, 'this listing was already removed by the maintainer')

  const withdrawn = await sql`
    WITH withdrawn_listing AS (
      UPDATE listings SET withdrawn = TRUE, withdrawn_at = now(), withdrawn_reason = ${reason},
        world_state = CASE WHEN delivery_kind = 'city_ownership' THEN 'canceled' ELSE world_state END
      WHERE id = ${id} AND merchant_id = ${m.id} AND NOT removed AND NOT withdrawn
        AND (delivery_kind <> 'city_ownership' OR world_state <> 'sold')
      RETURNING id, delivery_kind, world_offer_id, world_draft_id
    ), withdrawn_world_draft AS (
      UPDATE world_drafts d SET state = 'withdrawn', canceled_at = now(),
        canceled_reason = 'withdrawn by merchant'
      FROM withdrawn_listing l
      WHERE l.delivery_kind = 'city_ownership' AND d.id = l.world_draft_id
    ), expired_world_checkouts AS (
      UPDATE world_checkouts SET status = 'expired'
      WHERE listing_id IN (SELECT id FROM withdrawn_listing) AND status = 'active'
    ), new_event AS (
      INSERT INTO events (kind, actor, detail)
      SELECT 'withdrawal', ${m.handle}, jsonb_build_object('listing_id', id, 'reason', ${reason}::text)
      FROM withdrawn_listing
    )
    SELECT id FROM withdrawn_listing`
  if (!withdrawn.length) {
    const raced = (await sql`
      SELECT id, merchant_id, removed, removed_at, withdrawn, withdrawn_at,
        delivery_kind, world_offer_id, world_draft_id, world_state
      FROM listings WHERE id = ${id}`) as {
        id: number; merchant_id: number; removed: boolean; removed_at: string | null
        withdrawn: boolean; withdrawn_at: string | null
        delivery_kind: 'artifact' | 'city_ownership'; world_offer_id: number | null
        world_draft_id: number | null; world_state: string | null
      }[]
    if (raced[0]?.merchant_id === m.id && raced[0].withdrawn)
      return c.json({
        ok: true, listing_id: id, status: 'withdrawn' as const,
        ...(raced[0].delivery_kind === 'city_ownership' && raced[0].world_offer_id
          ? { city_unlock_required: true, city_cancel_url: cityCancelUrl(raced[0].world_offer_id) }
          : {}),
      })
    return err(c, 409, 'the listing changed before withdrawal could be saved')
  }
  return c.json({
    ok: true, listing_id: id, status: 'withdrawn' as const,
    ...(listing.delivery_kind === 'city_ownership' && listing.world_offer_id
      ? { city_unlock_required: true, city_cancel_url: cityCancelUrl(listing.world_offer_id) }
      : {}),
  })
}

app.post('/api/listing/:id/withdraw', withdrawListing)
app.delete('/api/listing/:id', withdrawListing)
}
