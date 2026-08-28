import { randomBytes } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { sql } from './db.ts'
import { auth, err, WALLET_RE, type Merchant } from './core.ts'
import { NETWORK, USDC, type FinalityEvidence } from './chain.ts'
import {
  canonicalTxHash,
  challenge402,
  paymentReadinessResponse,
  paymentResponseHeader,
  requirements,
  resumeX402PaymentForTerms,
  settleX402,
} from './pay.ts'
import { readX402PaymentAttempt, x402ProofDigest } from './x402-payment-attempts.ts'
import {
  DIRECT_PURCHASE_INTENT_TTL_MS,
  purchaseIntentChallenge,
  type DirectPurchaseIntent,
} from './direct-payments.ts'
import type { DirectPaymentAttempt } from './direct-payment-attempts.ts'
import { resolveDirectPaymentClaim, reviewDirectPaymentClaim } from './direct-payment-claim.ts'
import { postgresUniqueConstraint } from './postgres-error.ts'
import { x402CustodyFailureResponse, x402NoPayResponse } from './x402-route-response.ts'

const PURCHASE_TX_CONSTRAINTS: readonly string[] = [
  'purchases_tx_hash_key',
  'purchases_tx_hash_lower_unique',
  'payment_uses_pkey',
]
const OPEN_INTENT_CONSTRAINTS: readonly string[] = [
  'direct_purchase_intents_open_unique',
  'direct_purchase_intents_buyer_listing_unique',
]

interface BuyableListing {
  id: number; merchant_id: number; title: string; price_usdc: number
  seller_wallet: string
  removed: boolean; removed_at: string | null
  withdrawn: boolean; withdrawn_at: string | null
  created_at: string; checked_at?: string
  delivery_kind: 'artifact' | 'city_ownership'
}

type DirectPurchaseIntentRow = Omit<DirectPurchaseIntent, 'buyer'> & DirectPaymentAttempt & {
  merchant_id: number
  superseded_at: string | null
  claimed_at: string | null
}

function directIntentForBuyer(row: DirectPurchaseIntentRow, buyer: string): DirectPurchaseIntent {
  return {
    id: row.id,
    listing_id: row.listing_id,
    buyer,
    payer_wallet: row.payer_wallet,
    seller_wallet: row.seller_wallet,
    network: row.network,
    asset: row.asset,
    minimum_amount_usdc: row.minimum_amount_usdc,
    challenge_nonce: row.challenge_nonce,
    created_at: row.created_at,
    expires_at: row.expires_at,
  }
}

function parseDirectIntentBody(input: unknown): { payer_wallet: string } | string {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return 'body must contain exactly: payer_wallet'
  const keys = Object.keys(input)
  if (keys.length !== 1 || keys[0] !== 'payer_wallet')
    return 'body must contain exactly: payer_wallet'
  const payerWallet = (input as { payer_wallet?: unknown }).payer_wallet
  if (typeof payerWallet !== 'string' || !WALLET_RE.test(payerWallet))
    return 'payer_wallet must be a 0x wallet address'
  return { payer_wallet: payerWallet.toLowerCase() }
}

interface DirectClaimBody {
  intent_id: number
  tx_hash: string
  payer_signature: string
}

function parseDirectClaimBody(input: unknown): DirectClaimBody | string {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return 'body must contain exactly: intent_id, tx_hash, payer_signature'
  const keys = Object.keys(input).sort()
  if (keys.join(',') !== 'intent_id,payer_signature,tx_hash')
    return 'body must contain exactly: intent_id, tx_hash, payer_signature'
  const body = input as Record<string, unknown>
  if (typeof body.intent_id !== 'number' || !Number.isInteger(body.intent_id) || body.intent_id < 1)
    return 'intent_id must be a positive integer'
  const txHash = canonicalTxHash(body.tx_hash)
  if (!txHash) return 'tx_hash must be 0x followed by 64 hex characters'
  if (typeof body.payer_signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(body.payer_signature))
    return 'payer_signature must be a 65-byte personal_sign signature'
  return { intent_id: body.intent_id, tx_hash: txHash, payer_signature: body.payer_signature }
}

async function getPurchaseListing(
  c: Context, m: Merchant, id: number, allowTerminal: boolean,
): Promise<BuyableListing | Response> {
  if (!Number.isInteger(id)) return err(c, 400, 'bad id')
  const rows = (await sql`
    SELECT id, merchant_id, title, price_usdc::float8 AS price_usdc, seller_wallet, delivery_kind,
      removed, removed_at, withdrawn, withdrawn_at, created_at, clock_timestamp() AS checked_at
    FROM listings WHERE id = ${id}`) as BuyableListing[]
  if (!rows[0]) return err(c, 404, 'no such listing')
  if (rows[0].merchant_id === m.id) return err(c, 403, 'you cannot buy your own goods (constitution §5)')
  if (rows[0].delivery_kind === 'city_ownership')
    return err(c, 409, `world checkout is required for city ownership — POST /api/world/checkout/${id}`)
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

async function createDirectPurchaseIntent(
  c: Context,
  merchant: Merchant,
  listing: BuyableListing,
  payerWallet: string,
  startedAt: Date,
) {
  const createdAt = startedAt.toISOString()
  const expiresAt = new Date(startedAt.getTime() + DIRECT_PURCHASE_INTENT_TTL_MS).toISOString()
  const nonce = randomBytes(32).toString('hex')
  try {
    const rows = (await sql`
      WITH current_terms AS (
        SELECT l.id, l.price_usdc, lower(l.seller_wallet) AS seller_wallet
        FROM listings l
        WHERE l.id = ${listing.id} AND l.merchant_id <> ${merchant.id}
          AND l.delivery_kind = 'artifact' AND NOT l.removed AND NOT l.withdrawn
          AND l.price_usdc = ${listing.price_usdc}
          AND lower(l.seller_wallet) = lower(${listing.seller_wallet})
          AND NOT EXISTS (
            SELECT 1 FROM purchases p WHERE p.listing_id = l.id AND p.merchant_id = ${merchant.id}
          )
      ), fresh_intent AS (
        INSERT INTO direct_purchase_intents (
          merchant_id, listing_id, payer_wallet, seller_wallet, network, asset,
          minimum_amount_usdc, challenge_nonce, created_at, expires_at
        )
        SELECT ${merchant.id}, id, ${payerWallet}, seller_wallet, ${NETWORK}, lower(${USDC}),
          price_usdc, ${nonce}, ${createdAt}::timestamptz, ${expiresAt}::timestamptz
        FROM current_terms
        ON CONFLICT (merchant_id, listing_id) DO UPDATE SET
          payer_wallet = EXCLUDED.payer_wallet,
          seller_wallet = EXCLUDED.seller_wallet,
          network = EXCLUDED.network,
          asset = EXCLUDED.asset,
          minimum_amount_usdc = EXCLUDED.minimum_amount_usdc,
          challenge_nonce = EXCLUDED.challenge_nonce,
          created_at = EXCLUDED.created_at,
          expires_at = EXCLUDED.expires_at,
          superseded_at = NULL
        WHERE direct_purchase_intents.claimed_at IS NULL
          AND direct_purchase_intents.payment_status = 'unsubmitted'
          AND (
            direct_purchase_intents.superseded_at IS NOT NULL
            OR direct_purchase_intents.expires_at <= EXCLUDED.created_at
          )
        RETURNING id, merchant_id, listing_id, payer_wallet, seller_wallet, network, asset,
          minimum_amount_usdc::text, challenge_nonce, created_at, expires_at,
          superseded_at, claimed_at, payment_tx_hash, payment_status,
          finalized_block_number::text AS finalized_block_number,
          finalized_block_hash, finalized_block_time, finalized_at, payment_review_reason
      )
      SELECT * FROM fresh_intent`) as DirectPurchaseIntentRow[]
    const row = rows[0]
    if (row) return directPurchaseIntentResponse(c, row, merchant.handle, 201)
  } catch (error) {
    const constraint = postgresUniqueConstraint(error)
    if (!constraint || !OPEN_INTENT_CONSTRAINTS.includes(constraint)) throw error
  }
  const existing = (await sql`
    SELECT i.id, i.merchant_id, i.listing_id, i.payer_wallet, i.seller_wallet,
      i.network, i.asset, i.minimum_amount_usdc::text, i.challenge_nonce,
      i.created_at, i.expires_at, i.superseded_at, i.claimed_at,
      i.payment_tx_hash, i.payment_status,
      i.finalized_block_number::text AS finalized_block_number,
      i.finalized_block_hash, i.finalized_block_time, i.finalized_at,
      i.payment_review_reason
    FROM direct_purchase_intents i
    JOIN listings l ON l.id = i.listing_id
    WHERE i.listing_id = ${listing.id} AND i.merchant_id = ${merchant.id}
      AND i.payer_wallet = ${payerWallet} AND i.claimed_at IS NULL AND i.superseded_at IS NULL
      AND (
        (i.payment_status = 'unsubmitted' AND i.expires_at > ${createdAt}::timestamptz)
        OR i.payment_status IN ('payment_pending','needs_review')
      )
      AND l.merchant_id <> ${merchant.id} AND l.delivery_kind = 'artifact'
      AND NOT l.removed AND NOT l.withdrawn
      AND i.seller_wallet = lower(l.seller_wallet) AND i.minimum_amount_usdc = l.price_usdc
      AND i.network = ${NETWORK} AND i.asset = lower(${USDC})
      AND NOT EXISTS (
        SELECT 1 FROM purchases p WHERE p.listing_id = l.id AND p.merchant_id = ${merchant.id}
      )`) as DirectPurchaseIntentRow[]
  if (existing[0]?.payment_status === 'payment_pending') {
    return c.json({
      error: 'this purchase intent already has a payment awaiting finality; do not pay again',
      do_not_pay_again: true,
      retry: `POST /api/claim/${listing.id} again with the same intent, transaction, and signature`,
    }, 409)
  }
  if (existing[0]?.payment_status === 'needs_review') {
    return c.json({
      error: 'this purchase intent has a payment that needs review; do not pay again',
      do_not_pay_again: true,
    }, 409)
  }
  if (existing[0]) return directPurchaseIntentResponse(c, existing[0], merchant.handle, 200)
  return err(c, 409, 'listing changed, was purchased, or another payer has a fresh intent; re-read it before paying')
}

function directPurchaseIntentResponse(
  c: Context,
  row: DirectPurchaseIntentRow,
  buyer: string,
  status: 200 | 201,
) {
  const intent = directIntentForBuyer(row, buyer)
  return c.json({
    purchase_intent: {
      ...intent,
      signature_method: 'personal_sign',
      challenge: purchaseIntentChallenge(intent),
      tip_allowed: true,
      next: `Sign the exact challenge with payer_wallet, pay after created_at, then POST /api/claim/${intent.listing_id} before expires_at.`,
    },
  }, status)
}

async function recordPurchase(
  c: Context, m: Merchant, l: BuyableListing, via: 'x402' | 'claim' | 'free', txHash: string | null, amount: number,
  acceptedOrPaidAt: Date | null,
  x402OperationKey: string | null = null,
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
          INSERT INTO purchases (listing_id, merchant_id, amount_usdc, tx_hash, verified_via, x402_payment_operation_key)
          SELECT id, ${m.id}, ${amount}, ${txHash}, ${via}, ${x402OperationKey} FROM locked_listing
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
          INSERT INTO purchases (listing_id, merchant_id, amount_usdc, tx_hash, verified_via, x402_payment_operation_key)
          SELECT id, ${m.id}, ${amount}, ${txHash}, ${via}, ${x402OperationKey} FROM locked_listing
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
    if (!rows.length && x402OperationKey) {
      return x402NoPayResponse(
        c,
        409,
        'the market could not finish delivery because this listing changed after this paid request began',
        `retry POST /api/buy/${l.id} without X-PAYMENT so the market can finish this exact paid request`,
      )
    }
    if (!rows.length)
      return err(c, 409, 'listing changed or became unavailable; re-read it before paying')
  } catch (error) {
    const constraint = postgresUniqueConstraint(error)
    if (constraint === 'purchases_listing_id_merchant_id_key' && x402OperationKey) {
      try {
        return await deliver(c, l.id)
      } catch (deliveryError) {
        console.error('x402 purchase replay delivery failed after purchase was preserved', deliveryError)
        return x402NoPayResponse(
          c,
          503,
          'the market could not deliver this already-recorded purchase',
          `retry POST /api/buy/${l.id} without X-PAYMENT`,
        )
      }
    }
    if (constraint === 'purchases_listing_id_merchant_id_key')
      return err(c, 409, 'already purchased; re-download via GET /api/purchases')
    if (constraint && PURCHASE_TX_CONSTRAINTS.includes(constraint) && x402OperationKey) {
      return x402NoPayResponse(
        c,
        409,
        'this preserved payment transaction conflicts with another market payment record',
        `retry POST /api/buy/${l.id} without X-PAYMENT for payment review`,
      )
    }
    if (constraint && PURCHASE_TX_CONSTRAINTS.includes(constraint))
      return err(c, 409, 'that transaction hash was already used for another market payment')
    if (x402OperationKey) {
      console.error('x402 purchase write failed after payment was preserved', error)
      return x402NoPayResponse(
        c,
        503,
        'the market could not confirm that this paid purchase was recorded',
        `retry POST /api/buy/${l.id} without X-PAYMENT`,
      )
    }
    throw error
  }
  try {
    return await deliver(c, l.id)
  } catch (error) {
    if (!x402OperationKey) throw error
    console.error('x402 purchase delivery failed after purchase was preserved', error)
    return x402NoPayResponse(
      c,
      503,
      'the market recorded this purchase but could not deliver it in this response',
      `retry POST /api/buy/${l.id} without X-PAYMENT`,
    )
  }
}

async function recordDirectPurchase(
  c: Context,
  merchant: Merchant,
  listing: BuyableListing,
  intent: DirectPurchaseIntentRow,
  txHash: string,
  payerWallet: string,
  paidAt: Date,
  finality: FinalityEvidence,
) {
  const review = async (reason: string) => {
    const reviewed = await reviewDirectPaymentClaim(intent.id, reason, finality)
    if (reviewed.state === 'completed') return deliver(c, listing.id)
    return c.json(reviewed.body, reviewed.status)
  }
  try {
    const rows = await sql`
      WITH locked_claim AS (
        SELECT l.id AS listing_id, i.id AS direct_purchase_intent_id
        FROM listings l
        JOIN direct_purchase_intents i ON i.id = ${intent.id} AND i.listing_id = l.id
        WHERE l.id = ${listing.id} AND l.merchant_id <> ${merchant.id}
          AND l.delivery_kind = 'artifact' AND l.price_usdc = ${listing.price_usdc}
          AND lower(l.seller_wallet) = lower(${listing.seller_wallet})
          AND i.merchant_id = ${merchant.id}
          AND i.payer_wallet = lower(${payerWallet})
          AND i.seller_wallet = lower(l.seller_wallet)
          AND i.network = ${NETWORK} AND i.asset = lower(${USDC})
          AND i.minimum_amount_usdc = l.price_usdc
          AND i.claimed_at IS NULL AND i.superseded_at IS NULL
          AND i.payment_status = 'payment_pending'
          AND i.payment_tx_hash = lower(${txHash})
          AND i.created_at <= ${paidAt.toISOString()}::timestamptz
          AND i.expires_at >= ${paidAt.toISOString()}::timestamptz
          AND (
            (NOT l.removed AND NOT l.withdrawn)
            OR ${paidAt.toISOString()}::timestamptz <= coalesce(
              least(l.removed_at, l.withdrawn_at), l.removed_at, l.withdrawn_at
            )
          )
        FOR UPDATE OF l, i
      ), new_purchase AS (
        INSERT INTO purchases (
          listing_id, merchant_id, amount_usdc, tx_hash, verified_via, direct_purchase_intent_id
        )
        SELECT listing_id, ${merchant.id}, ${listing.price_usdc}, ${txHash}, 'claim',
          direct_purchase_intent_id FROM locked_claim
        RETURNING listing_id, direct_purchase_intent_id
      ), completed_intent AS (
        UPDATE direct_purchase_intents SET
          payment_status = 'completed', claimed_at = clock_timestamp(),
          finalized_block_number = ${finality.blockNumber.toString()},
          finalized_block_hash = ${finality.blockHash},
          finalized_block_time = ${paidAt.toISOString()},
          finalized_at = ${finality.finalizedAt.toISOString()}
        WHERE id IN (SELECT direct_purchase_intent_id FROM new_purchase)
          AND payment_status = 'payment_pending' AND payment_tx_hash = lower(${txHash})
      ), new_sale_count AS (
        UPDATE listings SET sales = sales + 1
        WHERE id IN (SELECT listing_id FROM new_purchase)
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'sale', ${merchant.handle}, jsonb_build_object(
          'listing_id', listing_id, 'amount_usdc', ${listing.price_usdc}::numeric, 'via', 'claim'
        ) FROM new_purchase
      )
      SELECT listing_id FROM new_purchase`
    if (!rows.length) {
      return review('the listing or purchase intent changed before the finalized payment could be delivered')
    }
  } catch (error) {
    const constraint = postgresUniqueConstraint(error)
    if (constraint === 'purchases_listing_id_merchant_id_key' ||
        constraint === 'purchases_direct_intent_unique' ||
        (constraint != null && PURCHASE_TX_CONSTRAINTS.includes(constraint))) {
      return review('the finalized payment conflicts with existing market purchase history')
    }
    console.error('direct purchase delivery failed after its payment was preserved', error)
    return c.json({
      error: 'the market could not finish delivery; retry this same claim; do not pay again',
      retry: 'retry the same claim with the same intent, transaction, and signature',
      do_not_pay_again: true,
    }, 503)
  }
  return deliver(c, listing.id)
}

export function registerArtifactPurchaseRoutes(app: Hono, config: { domain: string }) {
  const { domain: DOMAIN } = config

app.post('/api/purchase-intent/:id', async c => {
  const requestStartedAt = new Date()
  const merchant = await auth(c)
  if (!merchant) return err(c, 401, 'open /join first to create a merchant, then send its saved key as a bearer credential')
  const listing = await getBuyable(c, merchant, Number(c.req.param('id')))
  if (listing instanceof Response) return listing
  if (listing.price_usdc === 0) return err(c, 409, 'this listing is free; use POST /api/buy/:id')

  const unavailable = paymentReadinessResponse(c)
  if (unavailable) return unavailable
  const parsed = parseDirectIntentBody(await c.req.json().catch(() => null))
  if (typeof parsed === 'string') return err(c, 400, parsed)

  const prior = await sql`SELECT id FROM purchases WHERE listing_id = ${listing.id} AND merchant_id = ${merchant.id}`
  if (prior.length) return err(c, 409, 'already purchased; re-download via GET /api/purchases')
  return createDirectPurchaseIntent(c, merchant, listing, parsed.payer_wallet, requestStartedAt)
})

app.post('/api/buy/:id', async c => {
  const requestStartedAt = new Date()
  const m = await auth(c)
  if (!m) return err(c, 401, 'open /join first to create a merchant, then send its saved key as a bearer credential')
  const l = await getPurchaseListing(c, m, Number(c.req.param('id')), true)
  if (l instanceof Response) return l
  const terminalResponse = () => l.removed
    ? err(c, 404, 'listing was removed')
    : err(c, 404, 'listing was withdrawn and is not available')
  const x402Operation = {
    operationKey: `purchase:artifact:${m.id}:${l.id}`,
    operationKind: 'purchase' as const,
    operationStartedAt: requestStartedAt,
  }

  const prior = await sql`SELECT id FROM purchases WHERE listing_id = ${l.id} AND merchant_id = ${m.id}`
  if (l.price_usdc === 0) {
    if (prior.length) return deliver(c, l.id)
    if (l.removed || l.withdrawn) return terminalResponse()
    return recordPurchase(c, m, l, 'free', null, 0, null)
  }

  // The money goes to the SELLER. The market is not a party to this transaction.
  const reqs = requirements(l.seller_wallet, l.price_usdc, `${DOMAIN}/api/buy/${l.id}`, `1F3EA: ${l.title}`)
  const header = c.req.header('x-payment')
  let settled = await resumeX402PaymentForTerms(
    x402Operation.operationKey, x402Operation.operationKind, reqs,
  )
  if ((l.removed || l.withdrawn) && !settled) return terminalResponse()
  if (settled && header) {
    let originalProof = false
    try {
      const stored = await readX402PaymentAttempt(x402Operation.operationKey)
      originalProof = stored != null && stored.proof_digest === x402ProofDigest(header)
    } catch {
      originalProof = false
    }
    if (!originalProof) {
      return x402NoPayResponse(
        c,
        409,
        'this saved purchase is already bound to its original X-PAYMENT proof',
        `retry POST /api/buy/${l.id} without X-PAYMENT so the market can resume the stored proof`,
      )
    }
  }
  if (settled && settled.status !== 'verified') {
    return x402CustodyFailureResponse(c, reqs, settled)
  }
  if (prior.length) {
    try {
      return await deliver(c, l.id)
    } catch (error) {
      if (!settled) throw error
      console.error('x402 prior-purchase delivery failed after payment was preserved', error)
      return x402NoPayResponse(
        c,
        503,
        'the market could not deliver this already-recorded purchase',
        `retry POST /api/buy/${l.id} without X-PAYMENT`,
      )
    }
  }

  const unavailable = paymentReadinessResponse(c)
  if (unavailable) return unavailable

  if (!header && !settled)
    return challenge402(
      c,
      reqs,
      `costs $${l.price_usdc} USDC, paid directly to the seller — retry with X-PAYMENT, ` +
      `or start a signed ten-minute direct-payment intent at POST /api/purchase-intent/${l.id} before paying`,
    )
  if (!settled) settled = await settleX402(header!, reqs, x402Operation)
  if (settled.status !== 'verified') {
    return x402CustodyFailureResponse(c, reqs, settled)
  }

  let attempt: Awaited<ReturnType<typeof readX402PaymentAttempt>>
  try {
    attempt = await readX402PaymentAttempt(x402Operation.operationKey)
  } catch (error) {
    console.error('x402 purchase boundary lookup failed after payment was preserved', error)
    return x402NoPayResponse(
      c,
      503,
      'the market could not read when this saved payment began',
      `retry POST /api/buy/${l.id} without X-PAYMENT`,
    )
  }
  const operationStartedAt = new Date(attempt?.operation_started_at ?? '')
  if (
    !attempt
    || attempt.tx_hash !== settled.transaction
    || Number.isNaN(operationStartedAt.getTime())
  ) {
    return x402NoPayResponse(
      c,
      503,
      'the market could not confirm the fixed start time for this preserved payment',
      `retry POST /api/buy/${l.id} without X-PAYMENT for payment review`,
    )
  }
  if (settled.raw) {
    c.header('X-PAYMENT-RESPONSE', paymentResponseHeader({
      status: 'verified', transaction: settled.transaction, payer: settled.payer, raw: settled.raw,
    }))
  }
  return recordPurchase(
    c, m, l, 'x402', settled.transaction, l.price_usdc, operationStartedAt, x402Operation.operationKey,
  )
})

app.post('/api/claim/:id', async c => {
  const requestStartedAt = new Date()
  const m = await auth(c)
  if (!m) return err(c, 401, 'open /join first to create a merchant, then send its saved key as a bearer credential')
  const l = await getClaimable(c, m, Number(c.req.param('id')))
  if (l instanceof Response) return l
  if (l.price_usdc === 0) {
    if (l.removed || l.withdrawn) return err(c, 404, 'listing is no longer available')
    return recordPurchase(c, m, l, 'free', null, 0, null)
  }

  const unavailable = paymentReadinessResponse(c)
  if (unavailable) return unavailable

  const parsed = parseDirectClaimBody(await c.req.json().catch(() => null))
  if (typeof parsed === 'string') return err(c, 400, parsed)
  const rows = (await sql`
    SELECT i.id, i.merchant_id, i.listing_id, i.payer_wallet, i.seller_wallet,
      i.network, i.asset, i.minimum_amount_usdc::text, i.challenge_nonce,
      i.created_at, i.expires_at, i.superseded_at, i.claimed_at,
      i.payment_tx_hash, i.payment_status,
      i.finalized_block_number::text AS finalized_block_number,
      i.finalized_block_hash, i.finalized_block_time, i.finalized_at,
      i.payment_review_reason
    FROM direct_purchase_intents i
    JOIN listings current_listing ON current_listing.id = i.listing_id
    WHERE i.id = ${parsed.intent_id} AND i.listing_id = ${l.id} AND i.merchant_id = ${m.id}
      AND i.seller_wallet = lower(current_listing.seller_wallet)
      AND i.minimum_amount_usdc = current_listing.price_usdc
      AND i.network = ${NETWORK} AND i.asset = lower(${USDC})`) as DirectPurchaseIntentRow[]
  const intentRow = rows[0]
  if (!intentRow || intentRow.superseded_at ||
      (intentRow.claimed_at && !['completed', 'legacy_completed'].includes(intentRow.payment_status)))
    return err(c, 409, `no open signed purchase intent; POST /api/purchase-intent/${l.id} before paying`)

  const intent = directIntentForBuyer(intentRow, m.handle)
  const resolved = await resolveDirectPaymentClaim({
    intent: { ...intentRow, buyer: intent.buyer },
    txHash: parsed.tx_hash,
    payerSignature: parsed.payer_signature,
    requestStartedAt,
  })
  if (resolved.state === 'response')
    return c.json(resolved.body, resolved.status)
  if (resolved.state === 'completed') return deliver(c, l.id)
  if (l.removed || l.withdrawn) {
    const terminalTimes = [l.removed_at, l.withdrawn_at]
      .filter((value): value is string => Boolean(value))
      .map(value => new Date(value))
      .filter(value => !Number.isNaN(value.getTime()))
      .sort((a, b) => a.getTime() - b.getTime())
    const terminalAt = terminalTimes[0]
    if (!terminalAt || resolved.paidAt > terminalAt) {
      const reviewed = await reviewDirectPaymentClaim(
        intentRow.id,
        'the payment happened after this listing left the market',
        resolved.finality,
      )
      if (reviewed.state === 'completed') return deliver(c, l.id)
      return c.json(reviewed.body, reviewed.status)
    }
  }
  return recordDirectPurchase(
    c, m, l, intentRow, resolved.txHash, resolved.payerWallet, resolved.paidAt, resolved.finality,
  )
})
}
