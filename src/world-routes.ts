import type { Hono } from 'hono'
import { auth, dupHash, err, sha256 } from './core.ts'
import { sql } from './db.ts'
import {
  challenge402,
  LISTING_FEE_USDC,
  paymentReadinessResponse,
  paymentResponseHeader,
  requirements,
  resumeX402PaymentForTerms,
  settleX402,
  TREASURY,
  type FinalizedX402Payment,
  type X402NoPayResult,
} from './pay.ts'
import {
  CITY_ORIGIN,
  cityOfferMatchesDraft,
  cityOfferUrl,
  fetchCityOffer,
  validWorldActivation,
  validWorldDraft,
  type WorldDraftInput,
} from './world.ts'
import { postgresErrorDetails } from './postgres-error.ts'
import {
  readListingFeeAttempt,
  resolveListingFeePayment,
  reviewListingFeePayment,
  type ListingFeeResolution,
} from './listing-fee-payment.ts'
import {
  readX402PaymentAttempt,
  x402PaymentAttemptMatches,
  type X402PaymentAttempt,
} from './x402-payment-attempts.ts'
import { registerWorldCheckoutRoutes } from './world-checkout-routes.ts'
import { dateIsPast, positiveId, upstreamStatus } from './world-route-shared.ts'

export { requireValidWorldReceipt } from './world-payment-sync.ts'

interface WorldRouteConfig {
  marketOrigin: string
  maintainerId: number
}

interface WorldDraftRow extends WorldDraftInput {
  id: number
  merchant_id: number
  state: 'pending' | 'active' | 'withdrawn' | 'sold' | 'expired' | 'canceled'
  listing_id: number | null
  listing_state: string | null
  listing_withdrawn?: boolean
  listing_removed?: boolean
  created_at: string
  expires_at: string
  canceled_at: string | null
}

function publicDraftStatus(row: WorldDraftRow) {
  if (row.state === 'pending' && dateIsPast(row.expires_at)) return 'expired' as const
  if (row.listing_state === 'sold') return 'sold' as const
  if (row.listing_removed || row.state === 'canceled') return 'canceled' as const
  if (row.state === 'withdrawn') return 'withdrawn' as const
  if (row.listing_state === 'canceled' || row.listing_state === 'stale') return 'canceled' as const
  if (row.listing_withdrawn) return 'withdrawn' as const
  return row.state
}

function draftEnvelope(row: WorldDraftRow) {
  const listingState = row.listing_state === 'stale' ? 'canceled' : row.listing_state ?? null
  return {
    id: Number(row.id),
    status: publicDraftStatus(row),
    delivery_kind: 'city_ownership' as const,
    world_asset: { type: 'thing' as const, id: Number(row.thing_id) },
    title: row.title,
    description: row.description,
    preview: row.preview,
    price_usdc: Number(row.price_usdc),
    seller_wallet: row.seller_wallet,
    listing_id: row.listing_id == null ? null : Number(row.listing_id),
    listing_state: listingState,
    expires_at: row.expires_at,
    created_at: row.created_at,
  }
}

async function readDraft(id: number): Promise<WorldDraftRow | null> {
  const rows = (await sql`
    SELECT d.id, d.merchant_id, d.thing_id, d.title, d.description, d.preview,
      d.price_usdc::float8 AS price_usdc, d.seller_wallet, d.tags, d.state,
      d.listing_id, d.created_at, d.expires_at, d.canceled_at,
      l.world_state AS listing_state, l.withdrawn AS listing_withdrawn,
      l.removed AS listing_removed
    FROM world_drafts d LEFT JOIN listings l ON l.id = d.listing_id
    WHERE d.id = ${id}`) as WorldDraftRow[]
  return rows[0] ?? null
}

function x402AttemptFitsDraft(attempt: X402PaymentAttempt, draft: WorldDraftRow): boolean {
  const createdAt = new Date(draft.created_at)
  const expiresAt = new Date(draft.expires_at)
  const operationStartedAt = new Date(attempt.operation_started_at)
  const blockTime = new Date(attempt.finalized_block_time ?? '')
  if ([createdAt, expiresAt, operationStartedAt, blockTime]
    .some(value => Number.isNaN(value.getTime()))) return false
  const lowerBound = Math.floor(createdAt.getTime() / 1_000) * 1_000
  return operationStartedAt.getTime() >= lowerBound
    && operationStartedAt <= expiresAt
    && blockTime.getTime() >= lowerBound
    && blockTime <= expiresAt
}
export function registerWorldRoutes(app: Hono, config: WorldRouteConfig) {
  app.post('/api/world/draft', async c => {
    const merchant = await auth(c)
    if (!merchant) return err(c, 401, 'bad or missing bearer secret')
    const parsed = validWorldDraft(await c.req.json().catch(() => null))
    if (typeof parsed === 'string') return err(c, 400, parsed)
    try {
      await sql`
        UPDATE world_drafts SET state = 'expired'
        WHERE merchant_id = ${merchant.id} AND state = 'pending' AND expires_at <= now()`
      const rows = (await sql`
        INSERT INTO world_drafts (
          merchant_id, thing_id, title, description, preview, price_usdc, seller_wallet, tags
        ) VALUES (
          ${merchant.id}, ${parsed.thing_id}, ${parsed.title}, ${parsed.description}, ${parsed.preview},
          ${parsed.price_usdc}, ${parsed.seller_wallet}, ${parsed.tags}
        )
        RETURNING id, expires_at`) as { id: number; expires_at: string }[]
      const draft = rows[0]!
      return c.json({
        draft_id: Number(draft.id),
        url: `${config.marketOrigin}/api/world/draft/${draft.id}`,
        expires_at: draft.expires_at,
        next: 'Authenticate separately to the city and POST its world listing route with this public draft id.',
      }, 201)
    } catch (error) {
      const details = postgresErrorDetails(error)
      if (details.code === '23505' && details.constraint === 'world_drafts_one_pending_per_merchant')
        return err(c, 409, 'you already have a live pending draft; activate it, cancel it, or wait for expiry')
      throw error
    }
  })

  app.get('/api/world/draft/:id', async c => {
    const id = positiveId(c.req.param('id'))
    if (!id) return err(c, 400, 'draft id must be a positive integer')
    const draft = await readDraft(id)
    if (!draft) return err(c, 404, 'no such world draft')
    c.header('Cache-Control', 'public, max-age=5, s-maxage=10')
    return c.json({ draft: draftEnvelope(draft) })
  })

  app.post('/api/world/listing', async c => {
    const requestStartedAt = new Date()
    const merchant = await auth(c)
    if (!merchant) return err(c, 401, 'bad or missing bearer secret')
    const parsed = validWorldActivation(await c.req.json().catch(() => null))
    if (typeof parsed === 'string') return err(c, 400, parsed)
    const draft = await readDraft(parsed.draft_id)
    if (!draft) return err(c, 404, 'no such world draft')
    if (draft.merchant_id !== merchant.id) return err(c, 403, 'only the market merchant that made this draft may list it')
    const feeRequestHash = sha256(JSON.stringify({
      version: 1,
      merchant_id: merchant.id,
      kind: 'world_listing',
      draft_id: draft.id,
      city_offer_id: parsed.city_offer_id,
      thing_id: draft.thing_id,
      title: draft.title,
      description: draft.description,
      preview: draft.preview,
      price_usdc: draft.price_usdc,
      seller_wallet: draft.seller_wallet.toLowerCase(),
      tags: draft.tags,
    }))
    const x402OperationKey = `world-listing-fee:merchant:${merchant.id}:request:${feeRequestHash}`
    const x402Operation = {
      operationKey: x402OperationKey,
      operationKind: 'world_listing_fee' as const,
      operationStartedAt: requestStartedAt,
    }
    const feeRequirements = requirements(
      TREASURY,
      LISTING_FEE_USDC,
      `${config.marketOrigin}/api/world/listing`,
      '1F3EA world listing fee',
    )
    const retryRecordedX402 =
      'retry this same world listing request without X-PAYMENT; do not pay again'
    const reviewRecordedX402 =
      'do not pay again; ask the market owner to review the recorded fee for this same world listing request'
    const refuseRecordedX402 = (
      error: string,
      status: 409 | 503,
      retry: string,
    ) => c.json({ error, retry, do_not_pay_again: true as const }, status)
    const refuseResumedX402 = (failure: X402NoPayResult) => refuseRecordedX402(
      failure.status === 'conflict'
        ? 'the recorded world listing fee does not match this exact listing request'
        : failure.reason,
      failure.status === 'unavailable' ? 503 : 409,
      failure.status === 'conflict' ? reviewRecordedX402 : failure.retry,
    )
    const confirmRecordedX402 = async (payment: FinalizedX402Payment) => {
      try {
        const attempt = await readX402PaymentAttempt(x402OperationKey)
        if (
          !attempt
          || attempt.status !== 'verified'
          || attempt.tx_hash !== payment.transaction
          || attempt.payer_wallet !== payment.payer.toLowerCase()
          || !x402PaymentAttemptMatches(attempt, {
            operationKey: x402OperationKey,
            operationKind: 'world_listing_fee',
            requirements: feeRequirements,
          })
        ) return { state: 'mismatch' as const }
        if (!x402AttemptFitsDraft(attempt, draft)) return { state: 'outside_draft' as const }
        return { state: 'matched' as const, attempt }
      } catch (error) {
        console.error('recorded world listing x402 terms could not be read', error)
        return { state: 'unavailable' as const }
      }
    }
    const paymentHeader = c.req.header('x-payment')
    const keeperRequest = merchant.id === config.maintainerId
    const seedCandidate = keeperRequest && !paymentHeader && !parsed.fee_tx_hash
    let hasSavedX402 = false; let preservedFee: Awaited<ReturnType<typeof readListingFeeAttempt>> = null
    if (keeperRequest) try {
      hasSavedX402 = await readX402PaymentAttempt(x402OperationKey) != null
      preservedFee = await readListingFeeAttempt(merchant.id, 'world_listing', feeRequestHash)
    } catch { return c.json({ error: 'world listing payment records are temporarily unavailable', retry: 'retry this exact world listing request later', do_not_pay_again: true }, 503) }
    const isSeed = seedCandidate && !hasSavedX402 && !preservedFee
    const keeperUnavailable = keeperRequest && !isSeed ? paymentReadinessResponse(c) : null
    if (keeperUnavailable && preservedFee) return c.json({
      error: 'the market cannot finish this recorded world listing fee right now', retry: 'retry this same world listing body later with the same fee_tx_hash',
      fee_tx_hash: preservedFee.tx_hash, do_not_pay_again: true }, 503)
    if (keeperUnavailable && hasSavedX402) return refuseRecordedX402(
      'the market cannot finish this recorded world listing fee right now', 503, retryRecordedX402)
    if (keeperUnavailable) return c.json({ error: 'world listing payments are temporarily unavailable',
      retry: 'retry this same world listing request later and wait for new payment instructions' }, 503)
    let x402Payment: FinalizedX402Payment | null = null
    let x402Attempt: X402PaymentAttempt | null = null
    const resumedX402 = isSeed ? null : await resumeX402PaymentForTerms(
      x402OperationKey, 'world_listing_fee', feeRequirements,
    )
    if (resumedX402) {
      if (resumedX402.status === 'verified') {
        x402Payment = resumedX402
      } else if ('retry' in resumedX402) {
        return refuseResumedX402(resumedX402)
      } else {
        return c.json({
          error: resumedX402.reason,
          retry: reviewRecordedX402,
          do_not_pay_again: true,
        }, resumedX402.status === 'unclassified' ? 502 : 409)
      }
    }
    const unavailable = keeperRequest ? null : paymentReadinessResponse(c)
    if (unavailable) return x402Payment
      ? refuseRecordedX402('the market cannot finish this recorded world listing fee right now', 503, retryRecordedX402)
      : c.json({ error: 'world listing payments are temporarily unavailable',
        retry: 'retry this same world listing request later and wait for new payment instructions' }, 503)
    preservedFee = x402Payment ? null : keeperRequest ? preservedFee
      : await readListingFeeAttempt(merchant.id, 'world_listing', feeRequestHash)
    if (x402Payment) {
      const confirmation = await confirmRecordedX402(x402Payment)
      if (confirmation.state === 'unavailable') {
        return refuseRecordedX402(
          'the market could not confirm the recorded terms for this world listing fee',
          503,
          retryRecordedX402,
        )
      }
      if (confirmation.state === 'mismatch') {
        return refuseRecordedX402(
          'the recorded world listing fee does not match this exact listing request',
          409,
          reviewRecordedX402,
        )
      }
      if (confirmation.state === 'outside_draft') {
        return refuseRecordedX402(
          'the recorded world listing fee was not accepted and transferred inside this draft window',
          409,
          reviewRecordedX402,
        )
      }
      x402Attempt = confirmation.attempt
    }
    if (x402Payment && parsed.fee_tx_hash) {
      return refuseRecordedX402(
        'this world listing request already has a recorded X-PAYMENT fee; remove fee_tx_hash and do not pay again',
        409,
        'retry this same world listing request without X-PAYMENT or fee_tx_hash; do not pay again',
      )
    }
    if (!preservedFee && paymentHeader && parsed.fee_tx_hash) {
      return err(c, 400,
        'choose exactly one world listing fee method: X-PAYMENT or fee_tx_hash; neither fee was processed')
    }
    if (preservedFee && paymentHeader) {
      return c.json({
        error: 'this world listing request already has a direct fee transaction; remove X-PAYMENT and retry; do not pay again',
        retry: 'retry the same world listing body without X-PAYMENT',
        fee_tx_hash: preservedFee.tx_hash,
        do_not_pay_again: true,
      }, 409)
    }
    let directFee: Extract<ListingFeeResolution, { state: 'verified' }> | null = null
    let worldSellerHandle: string
    const hasRecordedFee = Boolean(preservedFee || x402Payment)
    const paidDraftUnavailable = hasRecordedFee && !['pending', 'expired'].includes(draft.state)
    const unpaidDraftUnavailable = !hasRecordedFee &&
      (draft.state !== 'pending' || dateIsPast(draft.expires_at))
    if (paidDraftUnavailable || unpaidDraftUnavailable) {
      if (!preservedFee) {
        return x402Payment
          ? refuseRecordedX402(
              'the world draft is no longer pending and unexpired; its recorded fee needs review',
              409,
              reviewRecordedX402,
            )
          : err(c, 409, 'world draft is not pending and unexpired')
      }
      const reviewed = await reviewListingFeePayment(
        preservedFee.id,
        'the world draft expired before its fee reached finality',
      )
      if (reviewed.state === 'completed') {
        return c.json({
          listing_id: reviewed.listingId,
          url: `${config.marketOrigin}/api/listing/${reviewed.listingId}`,
          delivery_kind: 'city_ownership',
          city_offer_url: cityOfferUrl(parsed.city_offer_id),
          fee_tx: preservedFee.tx_hash,
        })
      }
      return c.json(reviewed.body, reviewed.status)
    }
    const cityRecord = await fetchCityOffer(parsed.city_offer_id)
    if (!cityRecord.ok) {
      if (!preservedFee) {
        if (!x402Payment) return err(c, upstreamStatus(cityRecord), cityRecord.message)
        const status = upstreamStatus(cityRecord)
        return refuseRecordedX402(
          cityRecord.message,
          status,
          status === 503 ? retryRecordedX402 : reviewRecordedX402,
        )
      }
      if (cityRecord.kind !== 'not_found') {
        return c.json({
          error: `${cityRecord.message}; retry the same world listing request; do not pay again`,
          retry: 'retry the same world listing body and direct fee transaction',
          do_not_pay_again: true,
        }, 503)
      }
      const reviewed = await reviewListingFeePayment(
        preservedFee.id,
        'the city offer disappeared before its fee reached finality',
      )
      return reviewed.state === 'completed'
        ? c.json({
            listing_id: reviewed.listingId,
            url: `${config.marketOrigin}/api/listing/${reviewed.listingId}`,
            delivery_kind: 'city_ownership',
            city_offer_url: cityOfferUrl(parsed.city_offer_id),
            fee_tx: preservedFee.tx_hash,
          })
        : c.json(reviewed.body, reviewed.status)
    }
    const mismatch = cityOfferMatchesDraft(cityRecord.value, draft, parsed.city_offer_id, config.marketOrigin)
    if (mismatch) {
      if (!preservedFee) {
        return x402Payment
          ? refuseRecordedX402(mismatch, 409, reviewRecordedX402)
          : err(c, 409, mismatch)
      }
      const reviewed = await reviewListingFeePayment(
        preservedFee.id,
        `the city could no longer keep this world listing locked: ${mismatch}`,
      )
      return reviewed.state === 'completed'
        ? c.json({
            listing_id: reviewed.listingId,
            url: `${config.marketOrigin}/api/listing/${reviewed.listingId}`,
            delivery_kind: 'city_ownership',
            city_offer_url: cityOfferUrl(parsed.city_offer_id),
            fee_tx: preservedFee.tx_hash,
          })
        : c.json(reviewed.body, reviewed.status)
    }
    worldSellerHandle = cityRecord.value.seller
    if (preservedFee) {
      const resolved = await resolveListingFeePayment({
        merchantId: merchant.id,
        requestKind: 'world_listing',
        requestHash: feeRequestHash,
        txHash: parsed.fee_tx_hash ?? preservedFee.tx_hash,
        payerWallet: draft.seller_wallet,
        requestStartedAt,
        world: {
          draftId: draft.id,
          offerId: parsed.city_offer_id,
          sellerHandle: worldSellerHandle,
        },
      })
      if (resolved.state === 'response') return c.json(resolved.body, resolved.status)
      if (resolved.state === 'completed') {
        return c.json({
          listing_id: resolved.listingId,
          url: `${config.marketOrigin}/api/listing/${resolved.listingId}`,
          delivery_kind: 'city_ownership',
          city_offer_url: cityOfferUrl(parsed.city_offer_id),
          fee_tx: preservedFee.tx_hash,
        })
      }
      directFee = resolved
    }

    let feeTx: string | null = null
    let responseHeader: string | null = null
    if (!isSeed) {
      if (x402Payment) {
        feeTx = x402Payment.transaction
      } else if (!paymentHeader && !parsed.fee_tx_hash && !directFee) {
        return challenge402(c, feeRequirements, 'world listing costs $1 USDC — pay via x402 or include fee_tx_hash')
      } else if (paymentHeader) {
        const settled = await settleX402(paymentHeader, feeRequirements, x402Operation)
        if (settled.status !== 'verified') {
          if (settled.status === 'invalid') {
            const current = await resumeX402PaymentForTerms(
              x402OperationKey, 'world_listing_fee', feeRequirements,
            )
            if (!current) return challenge402(c, feeRequirements, settled.reason)
            if (current.status === 'verified') {
              x402Payment = current
              feeTx = current.transaction
            } else if ('retry' in current) {
              return refuseResumedX402(current)
            } else {
              return c.json({
                error: current.reason,
                retry: reviewRecordedX402,
                do_not_pay_again: true,
              }, current.status === 'unclassified' ? 502 : 409)
            }
          } else if ('retry' in settled) {
            return c.json({
              error: settled.reason,
              retry: settled.retry,
              do_not_pay_again: true,
            }, settled.status === 'unavailable' ? 503 : 409)
          } else {
            return err(c, 502, settled.reason)
          }
        } else {
          x402Payment = settled
          feeTx = settled.transaction
          if (settled.raw) {
            responseHeader = paymentResponseHeader({
              status: 'verified',
              transaction: settled.transaction,
              payer: settled.payer,
              raw: settled.raw,
            })
          }
        }
      } else {
        if (!directFee) {
          const resolved = await resolveListingFeePayment({
            merchantId: merchant.id,
            requestKind: 'world_listing',
            requestHash: feeRequestHash,
            txHash: parsed.fee_tx_hash!,
            payerWallet: draft.seller_wallet,
            requestStartedAt,
            world: {
              draftId: draft.id,
              offerId: parsed.city_offer_id,
              sellerHandle: worldSellerHandle,
            },
          })
          if (resolved.state === 'response') return c.json(resolved.body, resolved.status)
          if (resolved.state === 'completed') {
            return c.json({
              listing_id: resolved.listingId,
              url: `${config.marketOrigin}/api/listing/${resolved.listingId}`,
              delivery_kind: 'city_ownership',
              city_offer_url: cityOfferUrl(parsed.city_offer_id),
              fee_tx: parsed.fee_tx_hash,
            })
          }
          directFee = resolved
        }
        feeTx = directFee.txHash
      }
    }

    if (x402Payment && !x402Attempt) {
      const confirmation = await confirmRecordedX402(x402Payment)
      if (confirmation.state === 'unavailable') {
        return refuseRecordedX402(
          'the market could not confirm the recorded terms for this world listing fee',
          503,
          retryRecordedX402,
        )
      }
      if (confirmation.state === 'mismatch') {
        return refuseRecordedX402(
          'the recorded world listing fee does not match this exact listing request',
          409,
          reviewRecordedX402,
        )
      }
      if (confirmation.state === 'outside_draft') {
        return refuseRecordedX402(
          'the recorded world listing fee was not accepted and transferred inside this draft window',
          409,
          reviewRecordedX402,
        )
      }
      x402Attempt = confirmation.attempt
    }

    const listingHash = dupHash(draft.title, `city:${draft.thing_id}:offer:${parsed.city_offer_id}`)
    try {
      let rows: Record<string, unknown>[]
      if (directFee) {
        const { finality } = directFee
        rows = await sql`
          WITH locked_fee_attempt AS (
            SELECT id, world_seller_handle, minimum_block_time, maximum_block_time,
              ${finality.blockTime.toISOString()}::timestamptz AS verified_block_time
            FROM listing_fee_attempts
            WHERE id = ${directFee.attemptId} AND merchant_id = ${merchant.id}
              AND fee_request_kind = 'world_listing'
              AND fee_request_hash = ${feeRequestHash}
              AND tx_hash = ${directFee.txHash} AND payment_status = 'payment_pending'
              AND world_draft_id = ${draft.id} AND world_offer_id = ${parsed.city_offer_id}
            FOR UPDATE
          ), locked_world_draft AS (
            SELECT draft.id, attempt.world_seller_handle
            FROM world_drafts draft
            JOIN locked_fee_attempt attempt ON TRUE
            WHERE draft.id = ${draft.id} AND draft.merchant_id = ${merchant.id}
              AND draft.state IN ('pending', 'expired')
              AND attempt.maximum_block_time >= date_trunc('second', draft.created_at)
              AND attempt.maximum_block_time <= draft.expires_at
              AND attempt.verified_block_time >= date_trunc('second', draft.created_at)
              AND attempt.verified_block_time <= draft.expires_at
            FOR UPDATE OF draft
          ), new_listing AS (
            INSERT INTO listings (
              merchant_id, title, description, preview, artifact, price_usdc, seller_wallet,
              tags, aisle, dup_hash, delivery_kind, world_origin, world_offer_id,
              world_asset_id, world_seller_handle, world_draft_id, world_state
            )
            SELECT ${merchant.id}, ${draft.title}, ${draft.description}, ${draft.preview}, '',
              ${draft.price_usdc}, ${draft.seller_wallet}, ${draft.tags}, 'world', ${listingHash},
              'city_ownership', ${CITY_ORIGIN}, ${parsed.city_offer_id}, ${draft.thing_id},
              world_seller_handle, id, 'active'
            FROM locked_world_draft
            RETURNING id, title, price_usdc, world_draft_id
          ), activated_world_draft AS (
            UPDATE world_drafts draft SET state = 'active', listing_id = listing.id
            FROM new_listing listing WHERE draft.id = listing.world_draft_id
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
            SELECT ${merchant.id}, listing.id, ${LISTING_FEE_USDC},
              ${directFee.txHash}, attempt.id, 'direct'
            FROM new_listing listing
            JOIN completed_attempt attempt ON attempt.listing_id = listing.id
            RETURNING listing_id, listing_fee_attempt_id
          ), new_event AS (
            INSERT INTO events (kind, actor, detail)
            SELECT 'listing', ${merchant.handle}, jsonb_build_object(
              'listing_id', listing.id, 'title', listing.title,
              'price_usdc', listing.price_usdc, 'delivery_kind', 'city_ownership'
            )
            FROM new_listing listing
            JOIN new_fee fee ON fee.listing_id = listing.id
          )
          SELECT listing.id FROM new_listing listing
          JOIN completed_attempt attempt ON attempt.listing_id = listing.id
          JOIN new_fee fee ON fee.listing_id = listing.id`
      } else {
        rows = feeTx
          ? await sql`
          WITH locked_x402_attempt AS (
            SELECT operation_started_at, finalized_block_time
            FROM x402_payment_attempts
            WHERE operation_key = ${x402OperationKey}
              AND operation_kind = 'world_listing_fee' AND status = 'verified'
              AND proof_digest = ${x402Attempt!.proof_digest}
              AND tx_hash = ${feeTx} AND payer_wallet = ${x402Payment!.payer.toLowerCase()}
              AND network = 'base' AND asset = ${feeRequirements.asset.toLowerCase()}
              AND payee_wallet = ${feeRequirements.payTo.toLowerCase()}
              AND amount_units = ${feeRequirements.maxAmountRequired}
              AND resource = ${feeRequirements.resource}
            FOR UPDATE
          ), locked_world_draft AS (
            SELECT draft.id FROM world_drafts draft
            JOIN locked_x402_attempt attempt ON TRUE
            WHERE draft.id = ${draft.id} AND draft.merchant_id = ${merchant.id}
              AND draft.state IN ('pending', 'expired')
              AND attempt.operation_started_at >= date_trunc('second', draft.created_at)
              AND attempt.operation_started_at <= draft.expires_at
              AND attempt.finalized_block_time >= date_trunc('second', draft.created_at)
              AND attempt.finalized_block_time <= draft.expires_at
            FOR UPDATE OF draft
          ), new_listing AS (
            INSERT INTO listings (
              merchant_id, title, description, preview, artifact, price_usdc, seller_wallet,
              tags, aisle, dup_hash, delivery_kind, world_origin, world_offer_id,
              world_asset_id, world_seller_handle, world_draft_id, world_state
            )
            SELECT ${merchant.id}, ${draft.title}, ${draft.description}, ${draft.preview}, '',
              ${draft.price_usdc}, ${draft.seller_wallet}, ${draft.tags}, 'world', ${listingHash},
              'city_ownership', ${CITY_ORIGIN}, ${parsed.city_offer_id}, ${draft.thing_id},
              ${worldSellerHandle}, id, 'active'
            FROM locked_world_draft
            RETURNING id, title, price_usdc, world_draft_id
          ), activated_world_draft AS (
            UPDATE world_drafts d SET state = 'active', listing_id = l.id
            FROM new_listing l WHERE d.id = l.world_draft_id
          ), new_fee AS (
            INSERT INTO fees (merchant_id, listing_id, amount_usdc, tx_hash,
              x402_payment_operation_key, verification_method)
            SELECT ${merchant.id}, id, ${LISTING_FEE_USDC}, ${feeTx}, ${x402OperationKey}, 'x402' FROM new_listing
          ), new_event AS (
            INSERT INTO events (kind, actor, detail)
            SELECT 'listing', ${merchant.handle}, jsonb_build_object(
              'listing_id', id, 'title', title, 'price_usdc', price_usdc,
              'delivery_kind', 'city_ownership'
            ) FROM new_listing
          )
          SELECT id FROM new_listing`
        : await sql`
          WITH locked_world_draft AS (
            SELECT id FROM world_drafts
            WHERE id = ${draft.id} AND merchant_id = ${merchant.id}
              AND state = 'pending' AND expires_at > now()
            FOR UPDATE
          ), new_listing AS (
            INSERT INTO listings (
              merchant_id, title, description, preview, artifact, price_usdc, seller_wallet,
              tags, aisle, dup_hash, delivery_kind, world_origin, world_offer_id,
              world_asset_id, world_seller_handle, world_draft_id, world_state
            )
            SELECT ${merchant.id}, ${draft.title}, ${draft.description}, ${draft.preview}, '',
              ${draft.price_usdc}, ${draft.seller_wallet}, ${draft.tags}, 'world', ${listingHash},
              'city_ownership', ${CITY_ORIGIN}, ${parsed.city_offer_id}, ${draft.thing_id},
              ${worldSellerHandle}, id, 'active'
            FROM locked_world_draft
            RETURNING id, title, price_usdc, world_draft_id
          ), activated_world_draft AS (
            UPDATE world_drafts d SET state = 'active', listing_id = l.id
            FROM new_listing l WHERE d.id = l.world_draft_id
          ), new_event AS (
            INSERT INTO events (kind, actor, detail)
            SELECT 'maintainer_seed', ${merchant.handle}, jsonb_build_object(
              'listing_id', id, 'title', title, 'price_usdc', price_usdc,
              'delivery_kind', 'city_ownership'
            ) FROM new_listing
          )
          SELECT id FROM new_listing`
      }
      if (!rows.length) {
        if (directFee) {
          const reviewed = await reviewListingFeePayment(
            directFee.attemptId,
            'the world draft changed before its finalized fee could create the listing',
            directFee.finality,
          )
          if (reviewed.state === 'completed') {
            return c.json({
              listing_id: reviewed.listingId,
              url: `${config.marketOrigin}/api/listing/${reviewed.listingId}`,
              delivery_kind: 'city_ownership',
              city_offer_url: cityOfferUrl(parsed.city_offer_id),
              fee_tx: directFee.txHash,
            })
          }
          return c.json(reviewed.body, reviewed.status)
        }
        return x402Payment
          ? refuseRecordedX402(
              'the world draft changed before the listing could be activated; its recorded fee needs review',
              409,
              reviewRecordedX402,
            )
          : err(c, 409, 'world draft changed before the listing could be activated')
      }
      const listingId = Number((rows[0] as { id: number }).id)
      if (responseHeader) c.header('X-PAYMENT-RESPONSE', responseHeader)
      return c.json({
        listing_id: listingId,
        url: `${config.marketOrigin}/api/listing/${listingId}`,
        delivery_kind: 'city_ownership',
        city_offer_url: cityOfferUrl(parsed.city_offer_id),
        fee_tx: feeTx,
      }, 201)
    } catch (error) {
      const details = postgresErrorDetails(error)
      if (directFee) {
        const knownConflict = details.code === '23505' && [
          'listings_world_offer_unique',
          'listings_world_draft_unique',
          'fees_tx_hash_key',
          'fees_tx_hash_lower_unique',
          'payment_uses_pkey',
        ].includes(details.constraint ?? '')
        if (knownConflict) {
          const reviewed = await reviewListingFeePayment(
            directFee.attemptId,
            'the finalized fee could not create this world listing because its draft, city offer, or payment was already used',
            directFee.finality,
          )
          if (reviewed.state === 'completed') {
            return c.json({
              listing_id: reviewed.listingId,
              url: `${config.marketOrigin}/api/listing/${reviewed.listingId}`,
              delivery_kind: 'city_ownership',
              city_offer_url: cityOfferUrl(parsed.city_offer_id),
              fee_tx: directFee.txHash,
            })
          }
          return c.json(reviewed.body, reviewed.status)
        }
        console.error('world listing activation failed after its fee was preserved', error)
        return c.json({
          error: 'the market could not finish this listing; retry the same request and fee transaction; do not pay again',
          retry: 'retry the same listing request with the same fee transaction',
          do_not_pay_again: true,
        }, 503)
      }
      if (x402Payment) {
        const knownConflict = details.code === '23505' && [
          'listings_world_offer_unique',
          'listings_world_draft_unique',
          'fees_tx_hash_key',
          'fees_tx_hash_lower_unique',
          'payment_uses_pkey',
        ].includes(details.constraint ?? '')
        if (knownConflict) {
          const conflict = details.constraint === 'listings_world_offer_unique'
            ? 'that city offer was already used by another market listing'
            : details.constraint === 'listings_world_draft_unique'
              ? 'that world draft was already used by another market listing'
              : 'that fee transaction was already used'
          return refuseRecordedX402(conflict, 409, reviewRecordedX402)
        }
        console.error('world listing activation failed after its X-PAYMENT fee was recorded', error)
        return refuseRecordedX402(
          'the market could not finish this world listing after recording its fee',
          503,
          retryRecordedX402,
        )
      }
      if (details.code !== '23505') throw error
      switch (details.constraint) {
        case 'listings_world_offer_unique':
          return err(c, 409, 'that city offer was already used by another market listing')
        case 'listings_world_draft_unique':
          return err(c, 409, 'that world draft was already used by another market listing')
        case 'fees_tx_hash_key':
        case 'fees_tx_hash_lower_unique':
        case 'payment_uses_pkey':
          return err(c, 409, 'that fee transaction was already used')
        default:
          throw error
      }
    }
  })

  registerWorldCheckoutRoutes(app, { marketOrigin: config.marketOrigin })
}
