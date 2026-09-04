// World-bridge route tests fake Neon, Base RPC, and the city's public GET records.
// They never use a live service, bearer secret, wallet, transaction, or database.
import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

process.env.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
process.env.PUBLIC_ORIGIN = 'https://1f3ea.com'

const SECRET = '1f3ea_sk_' + 'ab'.repeat(24)
const SELLER = '0x1111111111111111111111111111111111111111'
const BUYER_WALLET = '0x2222222222222222222222222222222222222222'
const TREASURY = process.env.TREASURY_ADDRESS
const TX = '0x' + '31'.repeat(32)
const X402_NONCE = '0x' + '42'.repeat(32)
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const AUTHORIZATION_USED_TOPIC = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5'
const X402_PAYMENT = Buffer.from(JSON.stringify({
  x402Version: 1,
  scheme: 'exact',
  network: 'base',
  payload: {
    signature: '0x' + 'ab'.repeat(65),
    authorization: {
      from: SELLER,
      to: TREASURY,
      value: '1000000',
      validAfter: '0',
      validBefore: '4102444800',
      nonce: X402_NONCE,
    },
  },
})).toString('base64')

interface DbCall { query: string; params: unknown[] }

interface PostgresErrorFixture {
  code: string
  constraint?: string
  nested?: boolean
}

interface ListingFeeAttemptFixture extends Record<string, unknown> {
  id: number
  merchant_id: number
  listing_id: number | null
  tx_hash: string
  fee_request_kind: 'world_listing'
  fee_request_hash: string
  payer_wallet: string
  payee_wallet: string
  asset: string
  minimum_block_time: string
  maximum_block_time: string
  payment_status: 'payment_pending' | 'completed' | 'needs_review'
  finalized_block_number: string | null
  finalized_block_hash: string | null
  finalized_block_time: string | null
  finalized_at: string | null
  payment_review_reason: string | null
  world_draft_id: number
  world_offer_id: number
  world_seller_handle: string
}

interface X402PaymentAttemptFixture extends Record<string, unknown> {
  operation_key: string
  operation_kind: 'world_listing_fee'
  proof_digest: string
  requirements_digest: string
  network: 'base'
  asset: string
  payee_wallet: string
  amount_units: string
  resource: string
  status: 'settling' | 'settled' | 'verified' | 'needs_review'
  tx_hash: string | null
  payer_wallet: string
  authorization_nonce: string
  authorization_valid_after: string
  authorization_valid_before: string
  start_block: string
  review_reason: string | null
  operation_started_at: string
  settlement_started_at: string
  settled_at: string | null
  finalized_block_number: string | null
  finalized_block_hash: string | null
  finalized_block_time: string | null
  finalized_at: string | null
  created_at: string
  updated_at: string
}

const state = {
  merchantId: 7,
  draftOwner: 7,
  authValid: true,
  draftInsertError: null as PostgresErrorFixture | null,
  activationInsertError: null as PostgresErrorFixture | null,
  draftExists: true,
  draftState: 'pending',
  draftCreatedAt: new Date().toISOString(),
  draftExpiresAt: '2099-08-12T01:00:00.000Z',
  draftListingId: null as number | null,
  listingExists: true,
  listingOwner: 7,
  listingWorldState: 'active',
  listingRemoved: false,
  listingRemovedAt: null as string | null,
  listingWithdrawnReason: null as string | null,
  listingWithdrawn: false,
  listingWithdrawnAt: null as string | null,
  checkoutInsertError: null as PostgresErrorFixture | null,
  checkoutReadError: false,
  purchaseInsertError: null as PostgresErrorFixture | null,
  purchaseConflictWritesReceipt: false,
  checkoutStatus: 'active',
  checkoutCreatedAt: '2026-08-12T00:02:00.000Z',
  checkoutExpiresAt: '2099-08-12T00:10:00.000Z',
  checkoutMerchantId: 9,
  checkoutMarketBuyer: 'agent-9',
  checkoutCityHandle: 'new-neighbor',
  cityMarketBuyer: 'agent-9',
  priorReceipt: null as Record<string, unknown> | null,
  worldAttempt: null as Record<string, unknown> | null,
  worldReviewWriteError: false,
  worldReviewWriteNoop: false,
  listingFeeAttempt: null as ListingFeeAttemptFixture | null,
  x402Attempt: null as X402PaymentAttemptFixture | null,
  attemptReserveError: null as PostgresErrorFixture | null,
  cancelDraftDuringCityFetch: false,
  cityMode: 'ok' as 'ok' | 'outage' | 'bad-json' | 'framework-body' | 'huge-stream' | 'missing' | 'mismatch' | 'reserved' | 'reserved-expired' | 'payment-pending' | 'payment-invalid' | 'payment-expired' | 'founder-review' | 'unknown-phase' | 'canceled' | 'claimed',
  cityStreamPulls: 0,
  cityStreamCanceled: false,
  cityReservedAt: '2026-08-12T00:04:00.000Z',
  cityReservedUntil: '2026-08-12T00:09:00.000Z',
  cityClaimedAt: '2026-08-12T00:08:00.000Z',
  cityBlockTime: '2026-08-12T00:07:00.000Z',
  residentExists: true,
  dbCalls: [] as DbCall[],
  cityCalls: [] as string[],
  rpcCalls: 0,
  rpcUnavailable: false,
  rpcReceiptMissing: false,
  rpcFinalized: true,
  rpcCanonical: true,
  rpcListingFeeBlockTime: null as string | null,
  rpcWorldAmountUnits: 2_000_000n,
  facilitatorUnavailable: false,
  facilitatorRejectedRequest: false,
  facilitatorSettlement: 'settled' as 'settled' | 'timeout',
  facilitatorSettleCalls: 0,
}

function merchantRow(id = state.merchantId) {
  return {
    id, handle: `agent-${id}`, model: 'test-model', storefront_line: '', karma: 0,
    joined_at: '2026-08-12T00:00:00.000Z', quota_day: '2026-08-12', comments_today: 0, votes_today: 0,
  }
}

function draftRow() {
  return {
    id: 12,
    merchant_id: state.draftOwner,
    thing_id: 41,
    title: 'Pocket observatory',
    description: 'A small place to watch the sky.',
    preview: 'brass and patient glass',
    price_usdc: 2,
    seller_wallet: SELLER,
    tags: ['sky', 'tool'],
    state: state.draftState,
    listing_id: state.draftListingId,
    listing_state: state.draftListingId ? state.listingWorldState : null,
    listing_withdrawn: state.listingWithdrawn,
    listing_removed: state.listingRemoved,
    created_at: state.draftCreatedAt,
    expires_at: state.draftExpiresAt,
    canceled_at: null,
  }
}

function listingRow() {
  return {
    id: 70,
    merchant_id: state.listingOwner,
    market_seller: `agent-${state.listingOwner}`,
    merchant: `agent-${state.listingOwner}`,
    title: 'Pocket observatory',
    description: 'A small place to watch the sky.',
    preview: 'brass and patient glass',
    price_usdc: 2,
    seller_wallet: SELLER,
    tags: ['sky', 'tool'],
    aisle: 'world',
    votes: 0,
    sales: state.listingWorldState === 'sold' ? 1 : 0,
    pinned: false,
    state: 'live',
    delivery_kind: 'city_ownership',
    world_origin: 'https://1f3d9.com',
    city_url: 'https://1f3d9.com',
    world_offer_id: 33,
    world_asset_id: 41,
    world_seller_handle: 'city-smith',
    world_draft_id: 12,
    world_state: state.listingWorldState,
    city_offer_url: 'https://1f3d9.com/api/world/offer/33',
    world_asset_url: 'https://1f3d9.com/api/world/offer/33',
    requires_city_resident: true,
    removed: state.listingRemoved,
    removed_at: state.listingRemovedAt,
    withdrawn: state.listingWithdrawn,
    withdrawn_at: state.listingWithdrawnAt,
    withdrawn_reason: state.listingWithdrawnReason,
    created_at: '2026-08-12T00:01:00.000Z',
    checked_at: '2026-08-12T00:02:00.000Z',
  }
}

function checkoutRow() {
  return {
    id: 60,
    status: state.checkoutStatus,
    listing_id: 70,
    world_offer_id: 33,
    market_draft_id: 12,
    merchant_id: state.checkoutMerchantId,
    market_buyer: state.checkoutMarketBuyer,
    city_handle: state.checkoutCityHandle,
    expires_at: state.checkoutExpiresAt,
    created_at: state.checkoutCreatedAt,
  }
}

function storedWorldReceipt(overrides: Record<string, unknown> = {}) {
  return {
    city_origin: 'https://1f3d9.com',
    city_offer_id: 33,
    city_asset_id: 41,
    city_handle: state.checkoutCityHandle,
    market_buyer: state.checkoutMarketBuyer,
    buyer_wallet: BUYER_WALLET,
    city_verified_via: 'x402',
    city_block_time: state.cityBlockTime,
    payment_from: BUYER_WALLET,
    payment_to: SELLER,
    city_receipt_url: 'https://1f3d9.com/api/world/offer/33',
    ...overrides,
  }
}

function purchaseRow(worldReceipt: Record<string, unknown> | string = storedWorldReceipt()) {
  return {
    purchase_id: 81,
    listing_id: 70,
    world_checkout_id: 60,
    amount_usdc: 2,
    tx_hash: TX,
    world_receipt: worldReceipt,
    created_at: '2026-08-12T00:06:00.000Z',
  }
}

function cityOffer() {
  const checkoutBoundModes = [
    'claimed',
    'reserved',
    'reserved-expired',
    'payment-pending',
    'payment-invalid',
    'payment-expired',
    'founder-review',
  ]
  const currentCheckoutModes = checkoutBoundModes.filter(mode => mode !== 'reserved-expired')
  const paymentEvidenceModes = ['payment-pending', 'payment-invalid', 'payment-expired', 'founder-review']
  const base = {
    id: 33,
    channel: 'world',
    phase: state.cityMode === 'claimed' ? 'claimed'
      : state.cityMode === 'canceled' ? 'canceled'
        : ['reserved', 'reserved-expired'].includes(state.cityMode) ? 'reserved'
          : state.cityMode === 'payment-pending' ? 'payment_pending'
            : state.cityMode === 'payment-invalid' ? 'payment_invalid'
              : state.cityMode === 'payment-expired' ? 'payment_expired'
                : state.cityMode === 'founder-review' ? 'founder_review'
                  : state.cityMode === 'unknown-phase' ? 'surprise' : 'listed',
    asset_type: 'thing',
    asset_id: state.cityMode === 'mismatch' ? 999 : 41,
    asset_name: 'Pocket observatory',
    locked: !['claimed', 'canceled'].includes(state.cityMode),
    seller: 'city-smith',
    buyer: checkoutBoundModes.includes(state.cityMode)
      ? state.checkoutCityHandle : null,
    market_buyer: checkoutBoundModes.includes(state.cityMode)
      ? state.cityMarketBuyer : null,
    price_usdc: 2,
    seller_wallet: SELLER,
    market_origin: 'https://1f3ea.com',
    market_draft_id: 12,
    market_listing_id: state.draftListingId,
    market_checkout_id: currentCheckoutModes.includes(state.cityMode) ? 60
      : state.cityMode === 'reserved-expired' ? 59 : null,
    reserved_at: currentCheckoutModes.includes(state.cityMode) ? state.cityReservedAt
      : state.cityMode === 'reserved-expired' ? '2020-01-01T00:00:00.000Z' : null,
    reserved_until: currentCheckoutModes.includes(state.cityMode) ? state.cityReservedUntil
      : state.cityMode === 'reserved-expired' ? '2020-01-01T00:05:00.000Z' : null,
    created_at: '2026-08-12T00:00:30.000Z',
    claimed_at: state.cityMode === 'claimed' ? state.cityClaimedAt : null,
    canceled_at: state.cityMode === 'canceled' ? '2026-08-12T00:05:00.000Z' : null,
    tx_hash: state.cityMode === 'claimed' ? TX : null,
    buyer_wallet: state.cityMode === 'claimed' ? BUYER_WALLET : null,
    verified_via: state.cityMode === 'claimed' ? 'x402' : null,
    block_time: state.cityMode === 'claimed' ? state.cityBlockTime : null,
    from: state.cityMode === 'claimed' ? BUYER_WALLET : null,
    to: state.cityMode === 'claimed' ? SELLER : null,
    pending_x402_tx_hash: paymentEvidenceModes.includes(state.cityMode) ? TX : null,
    pending_x402_at: paymentEvidenceModes.includes(state.cityMode)
      ? '2026-08-12T00:05:00.000Z' : null,
  }
  return base
}

function postgresError(fixture: PostgresErrorFixture, message: string): Error {
  const detail = Object.assign(new Error(message), {
    code: fixture.code,
    constraint: fixture.constraint,
  })
  return fixture.nested ? Object.assign(new Error(`wrapped ${message}`), { sourceError: detail }) : detail
}

function dbRespond(query: string, params: unknown[]): Record<string, unknown>[] {
  if (query.includes('world-draft:cancel-lock'))
    return state.draftOwner === state.merchantId ? [{ id: 12 }] : []
  if (query.includes('WHERE secret_hash')) return state.authValid ? [merchantRow()] : []
  if (query.includes('x402-payment-attempt:read-operation')) {
    return state.x402Attempt?.operation_key === String(params[0]) ? [state.x402Attempt] : []
  }
  if (query.includes('x402-payment-attempt:read')) return state.x402Attempt ? [state.x402Attempt] : []
  if (query.includes('x402-payment-attempt:reserve')) {
    if (state.x402Attempt) return []
    const now = '2026-08-28T12:00:00.000Z'
    state.x402Attempt = {
      operation_key: String(params[0]),
      operation_kind: String(params[1]) as 'world_listing_fee',
      proof_digest: String(params[2]),
      requirements_digest: String(params[3]),
      network: 'base',
      asset: String(params[4]),
      payee_wallet: String(params[5]),
      amount_units: String(params[6]),
      resource: String(params[7]),
      payer_wallet: String(params[8]),
      authorization_nonce: String(params[9]),
      authorization_valid_after: String(params[10]),
      authorization_valid_before: String(params[11]),
      start_block: String(params[12]),
      status: 'settling',
      tx_hash: null,
      review_reason: null,
      operation_started_at: new Date(String(params[13])).toISOString(),
      settlement_started_at: now,
      settled_at: null,
      finalized_block_number: null,
      finalized_block_hash: null,
      finalized_block_time: null,
      finalized_at: null,
      created_at: now,
      updated_at: now,
    }
    return [state.x402Attempt]
  }
  if (query.includes('x402-payment-attempt:review')) {
    if (state.x402Attempt?.status === 'settling') {
      state.x402Attempt = {
        ...state.x402Attempt,
        status: 'needs_review',
        review_reason: String(params[2]),
        updated_at: '2026-08-28T12:00:01.000Z',
      }
    }
    return state.x402Attempt ? [state.x402Attempt] : []
  }
  if (query.includes('x402-payment-attempt:finality')) {
    if (
      state.x402Attempt?.operation_key === String(params[0])
      && state.x402Attempt.proof_digest === String(params[1])
      && state.x402Attempt.tx_hash === String(params[2]).toLowerCase()
      && state.x402Attempt.status === 'settled'
    ) {
      state.x402Attempt = {
        ...state.x402Attempt,
        status: String(params[3]) as 'verified' | 'needs_review',
        finalized_block_number: String(params[4]),
        finalized_block_hash: String(params[5]).toLowerCase(),
        finalized_block_time: new Date(String(params[6])).toISOString(),
        finalized_at: new Date(String(params[7])).toISOString(),
        review_reason: params[8] == null ? null : String(params[8]),
        updated_at: '2026-08-28T12:00:02.000Z',
      }
    }
    return state.x402Attempt ? [state.x402Attempt] : []
  }
  if (query.includes('x402-payment-attempt:settled')) {
    if (state.x402Attempt && ['settling', 'needs_review'].includes(state.x402Attempt.status)) {
      state.x402Attempt = {
        ...state.x402Attempt,
        status: 'settled',
        tx_hash: String(params[2]),
        settled_at: '2026-08-28T12:00:01.000Z',
        updated_at: '2026-08-28T12:00:01.000Z',
      }
    }
    return state.x402Attempt ? [state.x402Attempt] : []
  }
  if (query.includes('listing-fee-attempt:read-by-id'))
    return state.listingFeeAttempt ? [state.listingFeeAttempt] : []
  if (query.includes('listing-fee-attempt:read'))
    return state.listingFeeAttempt ? [state.listingFeeAttempt] : []
  if (query.includes('listing-fee-attempt:reserve')) {
    if (state.listingFeeAttempt) return []
    if (query.includes('locked_world_draft') && !['pending', 'expired'].includes(state.draftState)) return []
    const wallets = params.filter(value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)) as string[]
    const timestamps = params.filter(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) as string[]
    state.listingFeeAttempt = {
      id: 81,
      merchant_id: state.merchantId,
      listing_id: null,
      tx_hash: String(params.find(value => /^0x[0-9a-fA-F]{64}$/.test(String(value)))).toLowerCase(),
      fee_request_kind: 'world_listing',
      fee_request_hash: String(params.find(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))),
      payer_wallet: String(wallets[0]).toLowerCase(),
      payee_wallet: String(wallets[1]).toLowerCase(),
      asset: String(wallets[2]).toLowerCase(),
      minimum_block_time: timestamps[0]!,
      maximum_block_time: timestamps[1]!,
      payment_status: 'payment_pending',
      finalized_block_number: null,
      finalized_block_hash: null,
      finalized_block_time: null,
      finalized_at: null,
      payment_review_reason: null,
      world_draft_id: 12,
      world_offer_id: 33,
      world_seller_handle: 'city-smith',
    }
    return [state.listingFeeAttempt]
  }
  if (query.includes('listing-fee-attempt:review')) {
    if (state.listingFeeAttempt?.payment_status === 'payment_pending') {
      state.listingFeeAttempt = {
        ...state.listingFeeAttempt,
        payment_status: 'needs_review',
        payment_review_reason: String(params[0]),
        finalized_block_number: params[1] == null ? null : String(params[1]),
        finalized_block_hash: params[2] == null ? null : String(params[2]),
        finalized_block_time: params[3] == null ? null : String(params[3]),
        finalized_at: params[4] == null ? null : String(params[4]),
      }
    }
    return state.listingFeeAttempt ? [state.listingFeeAttempt] : []
  }
  if (query.includes('world-payment-attempt:read')) return state.worldAttempt ? [state.worldAttempt] : []
  if (query.includes('world-payment-attempt:reserve */')) {
    if (state.attemptReserveError)
      throw postgresError(state.attemptReserveError, 'world payment reservation failed')
    state.worldAttempt = {
      world_checkout_id: Number(params[0]),
      listing_id: Number(params[1]),
      merchant_id: Number(params[2]),
      tx_hash: String(params[3]),
      payer_wallet: String(params[4]),
      payee_wallet: String(params[5]),
      amount_units: String(params[6]),
      start_time: String(params[7]),
      end_time: String(params[8]),
      city_block_time: String(params[9]),
      verified_via: String(params[10]),
      status: 'payment_pending',
      finalized_block_number: null,
      finalized_block_hash: null,
      finalized_block_time: null,
      finalized_at: null,
      review_reason: null,
    }
    return [state.worldAttempt]
  }
  if (query.includes('world-payment-attempt:reserve-conflict')) {
    state.worldAttempt = {
      world_checkout_id: Number(params[0]),
      listing_id: Number(params[1]),
      merchant_id: Number(params[2]),
      tx_hash: String(params[3]),
      payer_wallet: String(params[4]),
      payee_wallet: String(params[5]),
      amount_units: String(params[6]),
      start_time: String(params[7]),
      end_time: String(params[8]),
      city_block_time: String(params[9]),
      verified_via: String(params[10]),
      status: 'needs_review',
      finalized_block_number: null,
      finalized_block_hash: null,
      finalized_block_time: null,
      finalized_at: null,
      review_reason: 'transaction is already reserved by another market payment',
    }
    return [state.worldAttempt]
  }
  if (query.includes('world-payment-attempt:review')) {
    if (state.worldReviewWriteError) throw new Error('world review write unavailable')
    if (state.worldReviewWriteNoop) return []
    if (state.worldAttempt?.status === 'payment_pending') {
      state.worldAttempt = {
        ...state.worldAttempt,
        status: 'needs_review',
        review_reason: String(params[0]),
        finalized_block_number: params[1] == null ? null : String(params[1]),
        finalized_block_hash: params[2] == null ? null : String(params[2]),
        finalized_block_time: params[3] == null ? null : String(params[3]),
        finalized_at: params[4] == null ? null : String(params[4]),
      }
    }
    return state.worldAttempt ? [state.worldAttempt] : []
  }
  if (query.includes('INSERT INTO world_drafts')) {
    if (state.draftInsertError) throw postgresError(state.draftInsertError, 'world draft insert failed')
    return [{ id: 12, expires_at: state.draftExpiresAt }]
  }
  if (query.includes('WITH owned_draft AS') && query.includes('canceled_draft')) {
    if (state.draftOwner !== state.merchantId) return []
    const priorState = state.draftState
    const blocksExpiredDraft = query.includes('owned.expires_at > now()')
    const blocksPendingFee = query.includes("fee_request_kind = 'world_listing'")
      && query.includes("payment_status = 'payment_pending'")
    const listingFeePending = Boolean(state.listingFeeAttempt?.fee_request_kind === 'world_listing'
      && state.listingFeeAttempt.payment_status === 'payment_pending')
      || Boolean(state.x402Attempt
        && ['settling', 'settled', 'verified'].includes(state.x402Attempt.status)
        && state.draftListingId == null)
    const canceledId = priorState === 'pending'
      && (!blocksExpiredDraft || new Date(state.draftExpiresAt).getTime() > Date.now())
      && (!blocksPendingFee || !listingFeePending) ? 12 : null
    if (canceledId) state.draftState = 'canceled'
    return [{
      state: priorState,
      listing_id: state.draftListingId,
      listing_fee_pending: listingFeePending,
      canceled_id: canceledId,
    }]
  }
  if (query.includes('INSERT INTO listings') && query.includes('world_draft')) {
    if (state.activationInsertError)
      throw postgresError(state.activationInsertError, 'world listing activation failed')
    state.draftState = 'active'
    state.draftListingId = 70
    state.draftExpiresAt = '9999-12-31T23:59:59.999Z'
    if (query.includes('locked_fee_attempt') && state.listingFeeAttempt) {
      state.listingFeeAttempt = {
        ...state.listingFeeAttempt,
        listing_id: 70,
        payment_status: 'completed',
        finalized_block_number: '256',
        finalized_block_hash: '0x' + 'bb'.repeat(32),
        finalized_block_time: new Date().toISOString(),
        finalized_at: new Date().toISOString(),
      }
    }
    return [{ id: 70 }]
  }
  if (query.includes('FROM world_drafts d')) return state.draftExists ? [draftRow()] : []
  if (query.includes('FROM world_drafts') && query.includes('WHERE id') && !query.includes('INSERT INTO listings'))
    return state.draftExists ? [draftRow()] : []
  if (query.includes('FROM listings') && query.includes('world_offer_id'))
    return state.listingExists ? [listingRow()] : []
  if (query.trimStart().startsWith("UPDATE world_checkouts SET status = 'expired'")) return []
  if (query.includes('INSERT INTO world_checkouts')) {
    if (state.checkoutInsertError) throw postgresError(state.checkoutInsertError, 'world checkout insert failed')
    return [{ id: 60, expires_at: state.checkoutExpiresAt }]
  }
  if (query.includes('FROM world_checkouts c')) {
    if (state.checkoutReadError) throw new Error('checkout read unavailable')
    return [checkoutRow()]
  }
  if (query.includes('FROM world_checkouts') && query.includes('WHERE id')) return [checkoutRow()]
  if (query.includes('world_checkout_id') && query.includes('FROM purchases'))
    return state.priorReceipt ? [state.priorReceipt] : []
  if (query.includes("CASE WHEN l.delivery_kind = 'city_ownership' THEN p.world_receipt")) {
    return state.priorReceipt ? [{
      id: 91,
      listing_id: 70,
      title: 'Pocket observatory',
      amount_usdc: 2,
      verified_via: 'world',
      created_at: '2026-08-12T00:06:00.000Z',
      delivery_kind: 'city_ownership',
      artifact: null,
      world_receipt: state.priorReceipt.world_receipt,
      city_receipt_url: 'https://1f3d9.com/api/world/offer/33',
      __total: 1,
      __cursor_valid: true,
    }] : []
  }
  if (query.includes('INSERT INTO purchases') && query.includes("'world'")) {
    if (state.purchaseInsertError) {
      if (state.purchaseConflictWritesReceipt) state.priorReceipt = purchaseRow()
      throw postgresError(state.purchaseInsertError, 'world purchase insert failed')
    }
    state.listingWorldState = 'sold'
    state.draftState = 'sold'
    state.checkoutStatus = 'completed'
    if (state.worldAttempt) state.worldAttempt = { ...state.worldAttempt, status: 'completed' }
    const storedReceipt = params.find(value => typeof value === 'string' && value.includes('city_handle'))
    state.priorReceipt = purchaseRow(typeof storedReceipt === 'string' ? storedReceipt : {})
    return [state.priorReceipt]
  }
  if (query.includes('WITH removed_listing AS') && query.includes('world_checkouts')) {
    state.listingRemoved = true
    state.listingRemovedAt = '2026-08-12T00:03:00.000Z'
    if (state.listingWorldState !== 'sold') state.listingWorldState = 'canceled'
    state.checkoutStatus = 'expired'
    if (state.draftState !== 'sold') state.draftState = 'canceled'
    return [{ id: 70 }]
  }
  if (query.includes('WITH canceled_listing AS')) {
    state.listingWorldState = 'canceled'
    state.listingWithdrawn = true
    state.listingWithdrawnReason = 'city offer canceled'
    state.draftState = 'canceled'
    return [{ id: 70 }]
  }
  if (query.includes('WITH terminal_payment_listing AS')) {
    const changed = state.listingWorldState === 'active'
    const terminalReason = params.find(value => typeof value === 'string' && value.startsWith('city '))
    if (changed) {
      state.listingWorldState = 'stale'
      state.listingWithdrawn = true
      state.listingWithdrawnReason = typeof terminalReason === 'string' ? terminalReason : 'city payment invalid'
      state.draftState = 'canceled'
      state.checkoutStatus = 'expired'
    }
    return changed ? [{ id: 70 }] : []
  }
  if (query.includes('SELECT id, merchant_id') && query.includes('FROM listings WHERE id'))
    return state.listingExists ? [listingRow()] : []
  if (query.includes('UPDATE listings SET') && query.includes('withdrawn = TRUE')) {
    state.listingWithdrawn = true
    state.listingWorldState = 'canceled'
    state.draftState = 'withdrawn'
    return [{ id: 70 }]
  }
  if (query.includes('SELECT id FROM purchases')) return []
  if (query.includes('FROM comments c JOIN merchants m')) return []
  if (query.includes('FROM listings WHERE merchant_id')) return [{
    id: 70,
    title: 'Pocket observatory',
    aisle: 'world',
    delivery_kind: 'city_ownership',
    world_state: state.listingWorldState,
    price_usdc: 2,
    votes: 0,
    sales: state.listingWorldState === 'sold' ? 1 : 0,
    pinned: false,
    removed: state.listingRemoved,
    removed_at: state.listingRemovedAt,
    withdrawn: state.listingWithdrawn,
    withdrawn_at: state.listingWithdrawnAt,
    created_at: '2026-08-12T00:01:00.000Z',
    withdrawn_reason: state.listingWithdrawnReason,
    state: state.listingWorldState === 'sold' ? 'sold'
      : state.listingRemoved ? 'removed'
        : state.listingWithdrawn && state.listingWithdrawnReason === 'withdrawn by merchant' ? 'withdrawn'
          : ['canceled', 'stale'].includes(state.listingWorldState) ? state.listingWorldState
            : state.listingWithdrawn ? 'withdrawn' : 'live',
  }]
  if (query.includes('JOIN merchants b ON b.id = p.merchant_id')) return []
  if (query.includes('FROM purchases p JOIN listings l') && query.includes('WHERE p.merchant_id')) {
    if (!state.priorReceipt) return []
    return [{
      id: 91,
      listing_id: 70,
      title: 'Pocket observatory',
      delivery_kind: 'city_ownership',
      world_receipt: state.priorReceipt.world_receipt,
      created_at: '2026-08-12T00:06:00.000Z',
      __total: 1,
      __cursor_valid: true,
    }]
  }
  if (query.includes('FROM comments c JOIN listings l')) return []
  throw new Error(`unhandled world test query: ${query}`)
}

function pgArray(values: unknown[]) {
  return `{${values.map(value => `"${String(value).replace(/(["\\])/g, '\\$1')}"`).join(',')}}`
}

function neonEncode(rows: Record<string, unknown>[]) {
  const keys = Object.keys(rows[0] ?? {})
  const typeOf = (value: unknown) => {
    if (typeof value === 'boolean') return 16
    if (typeof value === 'number') return Number.isInteger(value) ? 23 : 701
    if (Array.isArray(value)) return 1009
    if (value != null && typeof value === 'object') return 3802
    return 25
  }
  const encode = (value: unknown) => {
    if (value === null) return null
    if (typeof value === 'boolean') return value ? 't' : 'f'
    if (Array.isArray(value)) return pgArray(value)
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value)
  }
  return {
    command: 'SELECT', rowCount: rows.length,
    fields: keys.map(name => ({ name, dataTypeID: typeOf(rows[0]![name]) })),
    rows: rows.map(row => keys.map(key => encode(row[key]))),
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const pad32 = (address: string) => '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0')

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (url.includes('/sql')) {
    const body = JSON.parse(String(init?.body ?? '{}'))
    if (Array.isArray(body.queries)) {
      const results = body.queries.map((query: { query: string; params?: unknown[] }) => {
        state.dbCalls.push({ query: query.query, params: query.params ?? [] })
        return neonEncode(dbRespond(query.query, query.params ?? []))
      })
      return json({ results })
    }
    state.dbCalls.push({ query: body.query, params: body.params ?? [] })
    return json(neonEncode(dbRespond(body.query, body.params ?? [])))
  }
  if (url.startsWith('https://1f3d9.com/')) {
    state.cityCalls.push(url)
    if (state.cityMode === 'outage') throw new Error('city unavailable (test)')
    if (state.cityMode === 'bad-json') return new Response('{no', { status: 200 })
    if (state.cityMode === 'framework-body') {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ offer: cityOffer() }),
        body: { getReader() { throw new Error('manual stream reads are forbidden') } },
      } as unknown as Response
    }
    if (state.cityMode === 'huge-stream') {
      const encoder = new TextEncoder()
      return new Response(new ReadableStream({
        pull(controller) {
          state.cityStreamPulls++
          if (state.cityStreamPulls > 100) return controller.close()
          controller.enqueue(encoder.encode('x'.repeat(16 * 1024)))
        },
        cancel() { state.cityStreamCanceled = true },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/resident/')) return state.residentExists
      ? json({ resident: { handle: state.checkoutCityHandle } })
      : json({ error: 'not found' }, 404)
    if (state.cityMode === 'missing') return json({ error: 'not found' }, 404)
    if (state.cancelDraftDuringCityFetch) state.draftState = 'canceled'
    return json({ offer: cityOffer() })
  }
  if (url.includes('mainnet.base.org')) {
    state.rpcCalls++
    if (state.rpcUnavailable) return new Response('Base RPC unavailable', { status: 503 })
    const body = JSON.parse(String(init?.body ?? '{}'))
    const worldClaim = state.worldAttempt !== null || state.cityMode === 'claimed'
    const blockHash = '0x' + 'bb'.repeat(32)
    if (body.method === 'eth_chainId') {
      return json({ jsonrpc: '2.0', id: body.id, result: '0x2105' })
    }
    if (body.method === 'eth_blockNumber') {
      return json({ jsonrpc: '2.0', id: body.id, result: '0x100' })
    }
    if (body.method === 'eth_getTransactionReceipt') {
      const payer = worldClaim ? BUYER_WALLET : SELLER
      const transfer = {
        address: USDC,
        topics: [TRANSFER_TOPIC, pad32(payer), pad32(worldClaim ? SELLER : TREASURY)],
        data: pad32(worldClaim ? `0x${state.rpcWorldAmountUnits.toString(16)}` : '0x0f4240'),
      }
      const x402Attempt = state.x402Attempt?.tx_hash === String(body.params[0] ?? '').toLowerCase()
        ? state.x402Attempt
        : null
      return json({
        jsonrpc: '2.0', id: body.id, result: state.rpcReceiptMissing ? null : {
          status: '0x1', transactionHash: String(body.params[0]).toLowerCase(),
          blockHash, blockNumber: '0x100',
          logs: x402Attempt
            ? [{
                address: USDC,
                topics: [AUTHORIZATION_USED_TOPIC, pad32(payer), x402Attempt.authorization_nonce],
                data: '0x',
              }, transfer]
            : [transfer],
        },
      })
    }
    if (body.method === 'eth_getBlockByNumber') return json({
      jsonrpc: '2.0', id: body.id,
      result: body.params[0] === 'finalized'
        ? { number: state.rpcFinalized ? '0x100' : '0xff' }
        : { hash: state.rpcCanonical ? blockHash : '0x' + 'cc'.repeat(32), number: '0x100' },
    })
    if (body.method === 'eth_getBlockByHash') return json({
      jsonrpc: '2.0', id: body.id,
      result: {
        hash: blockHash,
        number: '0x100',
        timestamp: '0x' + Math.floor(
          new Date(worldClaim ? state.cityBlockTime : state.rpcListingFeeBlockTime ?? Date.now())
            .getTime() / 1000,
        ).toString(16),
      },
    })
  }
  if (url.includes('/verify')) {
    if (state.facilitatorUnavailable) return new Response('facilitator unavailable', { status: 503 })
    if (state.facilitatorRejectedRequest) {
      return json({ error: 'invalid_payment_requirements' }, 400)
    }
    return json({ isValid: true })
  }
  if (url.includes('/settle')) {
    state.facilitatorSettleCalls++
    if (state.facilitatorSettlement === 'timeout') throw new Error('facilitator settlement timed out (test)')
    return json({ success: true, transaction: TX, payer: SELLER })
  }
  throw new Error(`unexpected world test fetch: ${url}`)
}) as typeof fetch

const { default: app } = await import('../src/index.ts')
const auth = { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }

const draftBody = (extra: Record<string, unknown> = {}) => JSON.stringify({
  title: 'Pocket observatory', description: 'A small place to watch the sky.',
  preview: 'brass and patient glass', price_usdc: 2, seller_wallet: SELLER,
  tags: ['sky', 'tool'], thing_id: 41, ...extra,
})

function reset() {
  state.merchantId = 7
  state.draftOwner = 7
  state.authValid = true
  state.draftInsertError = null
  state.activationInsertError = null
  state.draftExists = true
  state.draftState = 'pending'
  state.draftCreatedAt = new Date().toISOString()
  state.draftExpiresAt = '2099-08-12T01:00:00.000Z'
  state.draftListingId = null
  state.listingExists = true
  state.listingOwner = 7
  state.listingWorldState = 'active'
  state.listingRemoved = false
  state.listingRemovedAt = null
  state.listingWithdrawnReason = null
  state.listingWithdrawn = false
  state.listingWithdrawnAt = null
  state.checkoutInsertError = null
  state.checkoutReadError = false
  state.purchaseInsertError = null
  state.purchaseConflictWritesReceipt = false
  state.checkoutStatus = 'active'
  state.checkoutCreatedAt = '2026-08-12T00:02:00.000Z'
  state.checkoutExpiresAt = '2099-08-12T00:10:00.000Z'
  state.checkoutMerchantId = 9
  state.checkoutMarketBuyer = 'agent-9'
  state.checkoutCityHandle = 'new-neighbor'
  state.cityMarketBuyer = 'agent-9'
  state.priorReceipt = null
  state.worldAttempt = null
  state.worldReviewWriteError = false
  state.worldReviewWriteNoop = false
  state.listingFeeAttempt = null
  state.x402Attempt = null
  state.attemptReserveError = null
  state.cancelDraftDuringCityFetch = false
  state.cityMode = 'ok'
  state.cityStreamPulls = 0
  state.cityStreamCanceled = false
  state.cityReservedAt = '2026-08-12T00:04:00.000Z'
  state.cityReservedUntil = '2026-08-12T00:09:00.000Z'
  state.cityClaimedAt = '2026-08-12T00:08:00.000Z'
  state.cityBlockTime = '2026-08-12T00:07:00.000Z'
  state.residentExists = true
  state.dbCalls = []
  state.cityCalls = []
  state.rpcCalls = 0
  state.rpcUnavailable = false
  state.rpcReceiptMissing = false
  state.rpcFinalized = true
  state.rpcCanonical = true
  state.rpcListingFeeBlockTime = null
  state.rpcWorldAmountUnits = 2_000_000n
  state.facilitatorUnavailable = false
  state.facilitatorRejectedRequest = false
  state.facilitatorSettlement = 'settled'
  state.facilitatorSettleCalls = 0
}

const writes = () => state.dbCalls.filter(call => /INSERT|UPDATE\s+(?!merchants SET\s+comments_today)/i.test(call.query))

test('world draft creation is exact, free, expiring, and bounded to one pending draft', async () => {
  reset()
  const noAuth = await app.request('/api/world/draft', { method: 'POST', body: draftBody() })
  assert.equal(noAuth.status, 401)

  const extra = await app.request('/api/world/draft', {
    method: 'POST', headers: auth, body: draftBody({ artifact: 'secret goods' }),
  })
  assert.equal(extra.status, 400)

  const created = await app.request('/api/world/draft', { method: 'POST', headers: auth, body: draftBody() })
  assert.equal(created.status, 201)
  const result = await created.json() as Record<string, unknown>
  assert.equal(result.draft_id, 12)
  assert.equal(result.url, 'https://1f3ea.com/api/world/draft/12')
  assert.equal(state.rpcCalls, 0)

  state.draftInsertError = { code: '23505', constraint: 'world_drafts_one_pending_per_merchant' }
  const conflict = await app.request('/api/world/draft', { method: 'POST', headers: auth, body: draftBody() })
  assert.equal(conflict.status, 409)
  assert.match((await conflict.json() as { error: string }).error, /pending draft/i)
})

test('world draft reports only the live-pending-draft constraint as a caller conflict', async () => {
  reset()
  state.draftInsertError = {
    code: '23505', constraint: 'world_drafts_one_pending_per_merchant', nested: true,
  }
  const conflict = await app.request('/api/world/draft', {
    method: 'POST', headers: auth, body: draftBody(),
  })
  assert.equal(conflict.status, 409)
  assert.deepEqual(await conflict.json(), {
    error: 'you already have a live pending draft; activate it, POST /api/world/draft/:id/cancel, or wait for expiry',
  })

  reset()
  state.draftInsertError = { code: '23505', constraint: 'world_drafts_pkey' }
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const internal = await app.request('/api/world/draft', {
      method: 'POST', headers: auth, body: draftBody(),
    })
    assert.equal(internal.status, 500)
    assert.deepEqual(await internal.json(), { error: 'internal market failure; retry later' })
  } finally {
    console.error = originalConsoleError
  }
})

test('public draft records derive expiry and expose no bearer data', async () => {
  reset()
  const pending = await app.request('/api/world/draft/12')
  assert.equal(pending.status, 200)
  const first = await pending.json() as { draft: Record<string, unknown> }
  assert.deepEqual(first.draft.world_asset, { type: 'thing', id: 41 })
  assert.equal(first.draft.delivery_kind, 'city_ownership')
  assert.equal(first.draft.status, 'pending')
  assert.equal(JSON.stringify(first).includes('secret'), false)

  state.draftExpiresAt = '2020-01-01T00:00:00.000Z'
  const expired = await app.request('/api/world/draft/12')
  assert.equal((await expired.json() as { draft: { status: string } }).draft.status, 'expired')
})

test('an active listing keeps its older-than-an-hour public draft usable by the city', async () => {
  reset()
  state.draftState = 'active'
  state.draftListingId = 70
  state.draftExpiresAt = '2026-08-12T01:00:00.000Z'

  const response = await app.request('/api/world/draft/12')
  assert.equal(response.status, 200)
  const { draft } = await response.json() as {
    draft: { status: string; listing_state: string; expires_at?: string }
  }
  assert.equal(draft.status, 'active')
  assert.equal(draft.listing_state, 'active')
  assert.ok(draft.expires_at)
  assert.equal(
    draft.status === 'active' && draft.listing_state === 'active' &&
      (!draft.expires_at || new Date(draft.expires_at).getTime() > Date.now()),
    true,
  )
})

test('a seller can cancel a pending draft and then create another', async () => {
  reset()
  const noAuth = await app.request('/api/world/draft/12/cancel', { method: 'POST' })
  assert.equal(noAuth.status, 401)

  const canceled = await app.request('/api/world/draft/12/cancel', { method: 'POST', headers: auth })
  assert.equal(canceled.status, 200)
  assert.deepEqual(await canceled.json(), { draft_id: 12, status: 'canceled' })
  assert.equal(state.draftState, 'canceled')

  const created = await app.request('/api/world/draft', {
    method: 'POST', headers: auth, body: draftBody({ thing_id: 42 }),
  })
  assert.equal(created.status, 201)
})

test('canceling a world draft twice returns the documented terminal refusal', async () => {
  reset()
  const first = await app.request('/api/world/draft/12/cancel', { method: 'POST', headers: auth })
  assert.equal(first.status, 200)

  const second = await app.request('/api/world/draft/12/cancel', { method: 'POST', headers: auth })
  assert.equal(second.status, 409)
  assert.deepEqual(await second.json(), { error: 'world draft is not pending' })
})

test('a publicly expired world draft cannot be canceled after its hour lapses', async () => {
  reset()
  state.draftExpiresAt = '2020-01-01T00:00:00.000Z'

  const response = await app.request('/api/world/draft/12/cancel', { method: 'POST', headers: auth })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'world draft is not pending' })
  assert.equal(state.draftState, 'pending')
})

test('a recorded world listing fee still reaching finality blocks draft cancellation', async () => {
  reset()
  state.rpcFinalized = false
  const waiting = await app.request('/api/world/listing', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33, fee_tx_hash: TX }),
  })
  assert.equal(waiting.status, 202)
  assert.equal(state.listingFeeAttempt?.payment_status, 'payment_pending')

  const response = await app.request('/api/world/draft/12/cancel', { method: 'POST', headers: auth })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'this draft has a recorded listing fee still reaching finality; retry the listing request instead of canceling',
  })
  assert.equal(state.draftState, 'pending')
  assert.equal(state.listingFeeAttempt?.payment_status, 'payment_pending')

  state.rpcFinalized = true
  const created = await app.request('/api/world/listing', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33, fee_tx_hash: TX }),
  })
  assert.equal(created.status, 201, await created.clone().text())
  assert.equal(state.listingFeeAttempt?.payment_status, 'completed')
})

test('a settled x402 world listing fee still reaching finality blocks draft cancellation', async () => {
  reset()
  state.rpcFinalized = false
  const waiting = await app.request('/api/world/listing', {
    method: 'POST', headers: { ...auth, 'X-PAYMENT': X402_PAYMENT },
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
  })
  assert.equal(waiting.status, 503)
  assert.equal(state.x402Attempt?.status, 'settled')

  const response = await app.request('/api/world/draft/12/cancel', { method: 'POST', headers: auth })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'this draft has a recorded listing fee still reaching finality; retry the listing request instead of canceling',
  })
  assert.equal(state.draftState, 'pending')
  const cancellation = state.dbCalls.find(call => call.query.includes('WITH owned_draft AS'))
  assert.match(cancellation?.query ?? '', /operation_kind = 'world_listing_fee'/)
  assert.match(cancellation?.query ?? '', /status IN \('settling', 'settled', 'verified'\)/)
  assert.match(cancellation?.query ?? '', /fees[\s\S]*x402_payment_operation_key/)
  assert.ok(cancellation?.params.includes('world-listing-fee:merchant:7:request:%'))
})

test('world draft cancellation hides ownership and refuses an activated draft', async () => {
  reset()
  const malformed = await app.request('/api/world/draft/0/cancel', { method: 'POST', headers: auth })
  assert.equal(malformed.status, 400)
  assert.deepEqual(await malformed.json(), { error: 'draft id must be a positive integer' })

  reset()
  state.draftOwner = 8
  const notOwned = await app.request('/api/world/draft/12/cancel', { method: 'POST', headers: auth })
  assert.equal(notOwned.status, 404)

  reset()
  state.draftState = 'active'
  state.draftListingId = 70
  const active = await app.request('/api/world/draft/12/cancel', { method: 'POST', headers: auth })
  assert.equal(active.status, 409)
  assert.deepEqual(await active.json(), { error: 'world draft is already activated' })
  assert.equal(state.draftState, 'active')
})

test('activation fails closed on city outage, malformed JSON, and ownership mismatch before fees', async () => {
  for (const [mode, status] of [['outage', 503], ['bad-json', 503], ['mismatch', 409]] as const) {
    reset()
    state.cityMode = mode
    const response = await app.request('/api/world/listing', {
      method: 'POST', headers: auth, body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
    })
    assert.equal(response.status, status)
    assert.equal(state.rpcCalls, 0)
    assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO listings')), false)
  }
})

test('hosted world-listing fees stop before payment work while custody is closed', async () => {
  reset()
  const previousEnvironment = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    PAYMENT_CUSTODY_READY: process.env.PAYMENT_CUSTODY_READY,
  }
  process.env.VERCEL_ENV = 'production'
  delete process.env.PAYMENT_CUSTODY_READY

  try {
    const response = await app.request('/api/world/listing', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
    })
    assert.equal(response.status, 503)
    assert.doesNotMatch((await response.json() as { error: string }).error, /custody/i)

    const sync = await app.request('/api/world/sync/70', {
      method: 'POST', headers: auth, body: '{}',
    })
    assert.equal(sync.status, 503)
    const syncBody = await sync.json() as { do_not_pay_again?: boolean; error?: string }
    assert.equal(syncBody.do_not_pay_again, true)
    assert.doesNotMatch(syncBody.error ?? '', /custody/i)
    assert.equal(state.rpcCalls, 0)
    assert.equal(state.dbCalls.some(call =>
      /(?:INSERT|UPDATE)\s+(?:INTO\s+)?world_payment_attempts/iu.test(call.query)), false)
    assert.equal(state.dbCalls.some(call => /INSERT\s+INTO\s+(?:fees|listings)/i.test(call.query)), false)
  } finally {
    if (previousEnvironment.VERCEL_ENV == null) delete process.env.VERCEL_ENV
    else process.env.VERCEL_ENV = previousEnvironment.VERCEL_ENV
    if (previousEnvironment.PAYMENT_CUSTODY_READY == null) delete process.env.PAYMENT_CUSTODY_READY
    else process.env.PAYMENT_CUSTODY_READY = previousEnvironment.PAYMENT_CUSTODY_READY
  }
})

test('the shopkeeper eleventh world item is fee-free and publicly logged', async () => {
  reset()
  state.merchantId = 1
  state.draftOwner = 1
  state.listingOwner = 1
  const response = await app.request('/api/world/listing', {
    method: 'POST', headers: auth, body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
  })
  assert.equal(response.status, 201)
  assert.equal((await response.json() as { listing_id: number }).listing_id, 70)
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO fees')), false)
  assert.equal(state.rpcCalls, 0)
  assert.equal(state.facilitatorSettleCalls, 0)
  assert.equal(state.draftExpiresAt, '9999-12-31T23:59:59.999Z')
  assert.equal(state.dbCalls.some(call => /SELECT count\(\*\).*FROM listings WHERE merchant_id/.test(call.query)), false)
  const activation = state.dbCalls.find(call => call.query.includes('INSERT INTO listings'))?.query ?? ''
  assert.match(activation, /SELECT 'maintainer_seed'/)
  assert.match(activation, /expires_at\s*=\s*\$\d+/u)
})

test('the shopkeeper fee-free world listing does not depend on paid-listing readiness', async () => {
  reset()
  state.merchantId = 1
  state.draftOwner = 1
  state.listingOwner = 1
  const previousEnvironment = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    PAYMENT_CUSTODY_READY: process.env.PAYMENT_CUSTODY_READY,
  }
  process.env.VERCEL_ENV = 'production'
  delete process.env.PAYMENT_CUSTODY_READY

  try {
    const response = await app.request('/api/world/listing', {
      method: 'POST', headers: auth, body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
    })
    assert.equal(response.status, 201)
    assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO listing_fee_attempts')), false)
    assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO fees')), false)
  } finally {
    if (previousEnvironment.VERCEL_ENV == null) delete process.env.VERCEL_ENV
    else process.env.VERCEL_ENV = previousEnvironment.VERCEL_ENV
    if (previousEnvironment.PAYMENT_CUSTODY_READY == null) delete process.env.PAYMENT_CUSTODY_READY
    else process.env.PAYMENT_CUSTODY_READY = previousEnvironment.PAYMENT_CUSTODY_READY
  }
})

test('a proved city lock still needs the normal fee and activates atomically after direct proof', async () => {
  reset()
  const challenge = await app.request('/api/world/listing', {
    method: 'POST', headers: auth, body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
  })
  assert.equal(challenge.status, 402)
  assert.equal(state.x402Attempt, null)
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO listings')), false)

  const activated = await app.request('/api/world/listing', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33, fee_tx_hash: TX }),
  })
  assert.equal(activated.status, 201)
  const body = await activated.json() as Record<string, unknown>
  assert.equal(body.listing_id, 70)
  assert.equal(body.delivery_kind, 'city_ownership')
  const atomic = state.dbCalls.find(call => call.query.includes('INSERT INTO listings'))?.query ?? ''
  assert.match(atomic, /UPDATE world_drafts/)
  assert.match(atomic, /INSERT INTO fees/)
  assert.match(atomic, /world_state/)
})

test('a canceled draft cannot record a direct fee after the city read', async () => {
  reset()
  state.cancelDraftDuringCityFetch = true

  const response = await app.request('/api/world/listing', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33, fee_tx_hash: TX }),
  })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'world draft is not pending and unexpired' })
  assert.equal(state.listingFeeAttempt, null)
  assert.equal(state.rpcCalls, 0)
  const reservation = state.dbCalls.find(call =>
    call.query.includes('listing-fee-attempt:reserve'))?.query ?? ''
  assert.match(reservation, /FROM world_drafts[\s\S]*state IN \('pending', 'expired'\)[\s\S]*FOR UPDATE/)
})

test('a world listing cannot switch from a preserved direct fee to x402', async () => {
  reset()
  state.rpcFinalized = false
  const waiting = await app.request('/api/world/listing', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33, fee_tx_hash: TX }),
  })
  assert.equal(waiting.status, 202)
  assert.ok(state.listingFeeAttempt)

  const cityCalls = state.cityCalls.length
  state.rpcFinalized = true
  state.facilitatorUnavailable = false
  const switched = await app.request('/api/world/listing', {
    method: 'POST',
    headers: { ...auth, 'X-PAYMENT': X402_PAYMENT },
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
  })
  assert.equal(switched.status, 409)
  assert.equal((await switched.json() as { do_not_pay_again?: boolean }).do_not_pay_again, true)
  assert.equal(state.cityCalls.length, cityCalls)
})

test('a direct world-listing fee accepted inside the draft window may finish after expiry', async () => {
  reset()
  state.rpcFinalized = false
  const requestBody = JSON.stringify({ draft_id: 12, city_offer_id: 33, fee_tx_hash: TX })

  const waiting = await app.request('/api/world/listing', {
    method: 'POST', headers: auth, body: requestBody,
  })
  assert.equal(waiting.status, 202, await waiting.clone().text())
  assert.ok(state.listingFeeAttempt)

  const acceptedAt = new Date(state.listingFeeAttempt.maximum_block_time)
  const expiresAt = new Date(acceptedAt.getTime() + 80)
  state.draftExpiresAt = expiresAt.toISOString()
  state.rpcListingFeeBlockTime = new Date(
    Math.floor(acceptedAt.getTime() / 1_000) * 1_000,
  ).toISOString()
  while (Date.now() <= expiresAt.getTime()) await delay(10)
  state.draftState = 'expired'
  state.rpcFinalized = true

  const created = await app.request('/api/world/listing', {
    method: 'POST', headers: auth, body: requestBody,
  })
  assert.equal(created.status, 201, await created.clone().text())
  assert.equal((await created.json() as { listing_id: number }).listing_id, 70)
  assert.equal(state.listingFeeAttempt.payment_status, 'completed')
  assert.ok(new Date(state.listingFeeAttempt.finalized_at!).getTime() > expiresAt.getTime())

  const activation = state.dbCalls.find(call => call.query.includes('locked_fee_attempt'))?.query ?? ''
  assert.match(activation, /maximum_block_time[\s\S]*draft\.expires_at/iu)
  assert.match(activation, /finalized_block_time|blockTime/iu)
  assert.doesNotMatch(activation, /draft\.expires_at\s*>\s*now\(\)/iu)
})

test('a finalized world listing fee cannot activate after the draft and city lock window ended', async () => {
  reset()
  state.rpcFinalized = false
  const waiting = await app.request('/api/world/listing', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33, fee_tx_hash: TX }),
  })
  assert.equal(waiting.status, 202)
  state.rpcFinalized = true
  state.draftState = 'expired'
  state.draftExpiresAt = '2026-08-12T00:01:00.000Z'
  state.cityMode = 'canceled'

  const retried = await app.request('/api/world/listing', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33, fee_tx_hash: TX }),
  })
  assert.equal(retried.status, 409)
  const body = await retried.json() as { do_not_pay_again?: boolean; error?: string }
  assert.equal(body.do_not_pay_again, true)
  assert.match(body.error ?? '', /needs review/i)
  assert.equal(state.listingFeeAttempt?.payment_status, 'needs_review')
  assert.equal(state.draftListingId, null)
})

test('a first world-listing request with both fee rails is refused before either can charge', async () => {
  reset()
  const response = await app.request('/api/world/listing', {
    method: 'POST',
    headers: { ...auth, 'X-PAYMENT': X402_PAYMENT },
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33, fee_tx_hash: TX }),
  })
  assert.equal(response.status, 400)
  assert.match((await response.json() as { error: string }).error, /choose exactly one world listing fee method/i)
  assert.equal(state.rpcCalls, 0)
})

test('world activation distinguishes unavailable x402 and Base verification from invalid payment proof', async () => {
  reset()
  const invalid = await app.request('/api/world/listing', {
    method: 'POST',
    headers: { ...auth, 'X-PAYMENT': 'not-json' },
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
  })
  assert.equal(invalid.status, 402)
  const invalidBody = await invalid.json() as {
    error: string
    payment_safety: Record<string, unknown>
  }
  assert.match(invalidBody.error,
    /^X-PAYMENT header is not valid base64 JSON Pay exactly 1\.000000 USDC/iu)
  assert.deepEqual(invalidBody.payment_safety, {
    network: 'Base',
    usdc_contract: USDC,
    recipient: TREASURY,
    amount_usdc: '1.000000',
    amount_units: '1000000',
    x_payment_max_bytes: 16_000,
    verify_with: 'official_facts through the connector or this current 402 response; /api/official if your client can open URLs',
    warning: 'Never copy a recipient from wallet history; zero-value lookalike transfers can poison wallet history.',
  })

  reset()
  state.facilitatorUnavailable = true
  const facilitator = await app.request('/api/world/listing', {
    method: 'POST',
    headers: { ...auth, 'X-PAYMENT': X402_PAYMENT },
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
  })
  assert.equal(facilitator.status, 503)
  assert.deepEqual(await facilitator.json(), {
    error: 'payment facilitator verification is unavailable; retry this request with the same X-PAYMENT proof later',
    retry: 'retry this same request with the same X-PAYMENT proof',
    do_not_pay_again: true,
  })

  reset()
  state.facilitatorRejectedRequest = true
  const unclassified = await app.request('/api/world/listing', {
    method: 'POST',
    headers: { ...auth, 'X-PAYMENT': X402_PAYMENT },
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
  })
  assert.equal(unclassified.status, 502)
  const unclassifiedReason = (await unclassified.json() as { error: string }).error
  assert.match(unclassifiedReason, /invalid payment requirements/i)
  assert.match(unclassifiedReason,
    /X-PAYMENT proof, the market's payment requirements, or facilitator request handling was at fault/i)
  assert.doesNotMatch(unclassifiedReason, /retry.*same|fresh payment proof/i)

  reset()
  state.rpcUnavailable = true
  const chain = await app.request('/api/world/listing', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33, fee_tx_hash: TX }),
  })
  assert.equal(chain.status, 503)
  assert.deepEqual(await chain.json(), {
    error: 'the market could not check this payment on Base; retry the same proof later',
    retry: 'retry the same listing request with the same fee transaction',
    do_not_pay_again: true,
  })

  reset()
  state.rpcReceiptMissing = true
  const pendingChain = await app.request('/api/world/listing', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33, fee_tx_hash: TX }),
  })
  assert.equal(pendingChain.status, 503)
  assert.deepEqual(await pendingChain.json(), {
    error: 'the market could not check this payment on Base; retry the same proof later',
    retry: 'retry the same listing request with the same fee transaction',
    do_not_pay_again: true,
  })
})

test('an uncertain world listing settlement is durable and a headerless retry never invites payment again', async () => {
  reset()
  state.facilitatorSettlement = 'timeout'

  const uncertain = await app.request('/api/world/listing', {
    method: 'POST',
    headers: { ...auth, 'X-PAYMENT': X402_PAYMENT },
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
  })
  assert.equal(uncertain.status, 409)
  const uncertainBody = await uncertain.json() as Record<string, unknown>
  assert.equal(uncertainBody.do_not_pay_again, true)
  assert.equal('accepts' in uncertainBody, false)
  assert.equal(state.x402Attempt?.status, 'needs_review')
  assert.match(state.x402Attempt?.operation_key ?? '',
    /^world-listing-fee:merchant:7:request:[0-9a-f]{64}$/u)
  assert.ok(Buffer.byteLength(state.x402Attempt?.operation_key ?? '', 'utf8') <= 240)
  assert.equal(state.facilitatorSettleCalls, 1)

  const retried = await app.request('/api/world/listing', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
  })
  assert.equal(retried.status, 409)
  const retriedBody = await retried.json() as Record<string, unknown>
  assert.equal(retriedBody.do_not_pay_again, true)
  assert.equal('accepts' in retriedBody, false)
  assert.equal(state.facilitatorSettleCalls, 1)

  const invalidHeaderRetry = await app.request('/api/world/listing', {
    method: 'POST', headers: { ...auth, 'X-PAYMENT': 'not-json' },
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
  })
  assert.equal(invalidHeaderRetry.status, 409)
  const invalidHeaderBody = await invalidHeaderRetry.json() as Record<string, unknown>
  assert.equal(invalidHeaderBody.do_not_pay_again, true)
  assert.equal('accepts' in invalidHeaderBody, false)
  assert.equal(state.facilitatorSettleCalls, 1)
})

test('a settled world listing fee awaiting Base finality resumes without facilitator or another 402', async () => {
  reset()
  state.rpcFinalized = false

  const waiting = await app.request('/api/world/listing', {
    method: 'POST',
    headers: { ...auth, 'X-PAYMENT': X402_PAYMENT },
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
  })
  assert.equal(waiting.status, 503)
  const waitingBody = await waiting.json() as Record<string, unknown>
  assert.equal(waitingBody.do_not_pay_again, true)
  assert.equal('accepts' in waitingBody, false)
  assert.equal(state.x402Attempt?.status, 'settled')
  assert.equal(state.draftListingId, null)
  assert.equal(state.facilitatorSettleCalls, 1)

  const pendingRetry = await app.request('/api/world/listing', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
  })
  assert.equal(pendingRetry.status, 503)
  const pendingBody = await pendingRetry.json() as Record<string, unknown>
  assert.equal(pendingBody.do_not_pay_again, true)
  assert.equal('accepts' in pendingBody, false)
  assert.equal(state.facilitatorSettleCalls, 1)

  state.rpcFinalized = true
  const finalized = await app.request('/api/world/listing', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
  })
  assert.equal(finalized.status, 201)
  assert.equal((await finalized.json() as { listing_id: number }).listing_id, 70)
  assert.equal(state.facilitatorSettleCalls, 1)
})

test('a shopkeeper retry honors its stored x402 world fee instead of relabeling it fee-free', async () => {
  reset()
  state.merchantId = 1
  state.draftOwner = 1
  state.listingOwner = 1
  state.rpcFinalized = false
  const requestBody = JSON.stringify({ draft_id: 12, city_offer_id: 33 })
  const waiting = await app.request('/api/world/listing', {
    method: 'POST', headers: { ...auth, 'X-PAYMENT': X402_PAYMENT }, body: requestBody,
  })
  assert.equal(waiting.status, 503)
  assert.equal(state.x402Attempt?.status, 'settled')

  const retry = await app.request('/api/world/listing', {
    method: 'POST', headers: auth, body: requestBody,
  })
  assert.equal(retry.status, 503)
  assert.equal((await retry.json() as { do_not_pay_again?: boolean }).do_not_pay_again, true)
  assert.equal(state.draftListingId, null)
  assert.equal(state.facilitatorSettleCalls, 1)
})

test('closed custody stops a saved shopkeeper x402 world retry before Base work', async () => {
  reset()
  state.merchantId = 1
  state.draftOwner = 1
  state.listingOwner = 1
  state.rpcFinalized = false
  const requestBody = JSON.stringify({ draft_id: 12, city_offer_id: 33 })
  const waiting = await app.request('/api/world/listing', {
    method: 'POST', headers: { ...auth, 'X-PAYMENT': X402_PAYMENT }, body: requestBody,
  })
  assert.equal(waiting.status, 503)
  assert.equal(state.x402Attempt?.status, 'settled')
  const previousEnvironment = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    PAYMENT_CUSTODY_READY: process.env.PAYMENT_CUSTODY_READY,
  }
  process.env.VERCEL_ENV = 'production'
  delete process.env.PAYMENT_CUSTODY_READY
  const rpcCallsBeforeRetry = state.rpcCalls

  try {
    const retry = await app.request('/api/world/listing', {
      method: 'POST', headers: auth, body: requestBody,
    })
    assert.equal(retry.status, 503)
    assert.equal(state.rpcCalls, rpcCallsBeforeRetry)
    assert.equal(state.x402Attempt?.status, 'settled')
  } finally {
    if (previousEnvironment.VERCEL_ENV == null) delete process.env.VERCEL_ENV
    else process.env.VERCEL_ENV = previousEnvironment.VERCEL_ENV
    if (previousEnvironment.PAYMENT_CUSTODY_READY == null) delete process.env.PAYMENT_CUSTODY_READY
    else process.env.PAYMENT_CUSTODY_READY = previousEnvironment.PAYMENT_CUSTODY_READY
  }
})

test('closed custody keeps main behavior for a non-shopkeeper saved world x402 retry', async () => {
  reset()
  state.rpcFinalized = false
  const requestBody = JSON.stringify({ draft_id: 12, city_offer_id: 33 })
  const waiting = await app.request('/api/world/listing', {
    method: 'POST', headers: { ...auth, 'X-PAYMENT': X402_PAYMENT }, body: requestBody,
  })
  assert.equal(waiting.status, 503)
  assert.equal(state.x402Attempt?.status, 'settled')
  const previousEnvironment = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    PAYMENT_CUSTODY_READY: process.env.PAYMENT_CUSTODY_READY,
  }
  process.env.VERCEL_ENV = 'production'
  delete process.env.PAYMENT_CUSTODY_READY
  const rpcCallsBeforeRetry = state.rpcCalls

  try {
    const retry = await app.request('/api/world/listing', {
      method: 'POST', headers: auth, body: requestBody,
    })
    assert.equal(retry.status, 503)
    assert.equal((await retry.json() as { do_not_pay_again?: boolean }).do_not_pay_again, true)
    assert.equal(state.rpcCalls, rpcCallsBeforeRetry + 3)
    assert.equal(state.facilitatorSettleCalls, 1)
  } finally {
    if (previousEnvironment.VERCEL_ENV == null) delete process.env.VERCEL_ENV
    else process.env.VERCEL_ENV = previousEnvironment.VERCEL_ENV
    if (previousEnvironment.PAYMENT_CUSTODY_READY == null) delete process.env.PAYMENT_CUSTODY_READY
    else process.env.PAYMENT_CUSTODY_READY = previousEnvironment.PAYMENT_CUSTODY_READY
  }
})

test('closed custody preserves a saved shopkeeper direct world fee without another payment', async () => {
  reset()
  state.merchantId = 1
  state.draftOwner = 1
  state.listingOwner = 1
  state.rpcFinalized = false
  const requestBody = JSON.stringify({ draft_id: 12, city_offer_id: 33, fee_tx_hash: TX })
  const waiting = await app.request('/api/world/listing', {
    method: 'POST', headers: auth, body: requestBody,
  })
  assert.equal(waiting.status, 202)
  assert.equal(state.listingFeeAttempt?.payment_status, 'payment_pending')
  const previousEnvironment = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    PAYMENT_CUSTODY_READY: process.env.PAYMENT_CUSTODY_READY,
  }
  process.env.VERCEL_ENV = 'production'
  delete process.env.PAYMENT_CUSTODY_READY
  const rpcCallsBeforeRetry = state.rpcCalls

  try {
    const retry = await app.request('/api/world/listing', {
      method: 'POST', headers: auth, body: requestBody,
    })
    assert.equal(retry.status, 503)
    assert.equal((await retry.json() as { do_not_pay_again?: boolean }).do_not_pay_again, true)
    assert.equal(state.rpcCalls, rpcCallsBeforeRetry)
    assert.equal(state.listingFeeAttempt?.payment_status, 'payment_pending')
    assert.equal(state.draftListingId, null)
  } finally {
    if (previousEnvironment.VERCEL_ENV == null) delete process.env.VERCEL_ENV
    else process.env.VERCEL_ENV = previousEnvironment.VERCEL_ENV
    if (previousEnvironment.PAYMENT_CUSTODY_READY == null) delete process.env.PAYMENT_CUSTODY_READY
    else process.env.PAYMENT_CUSTODY_READY = previousEnvironment.PAYMENT_CUSTODY_READY
  }
})

test('a resumed shopkeeper x402 world fee clears a separately preserved direct fee', async () => {
  reset()
  state.merchantId = 1
  state.draftOwner = 1
  state.listingOwner = 1
  state.rpcFinalized = false
  const requestBody = JSON.stringify({ draft_id: 12, city_offer_id: 33 })
  const directWaiting = await app.request('/api/world/listing', {
    method: 'POST', headers: auth, body: JSON.stringify({ draft_id: 12, city_offer_id: 33, fee_tx_hash: TX }),
  })
  assert.equal(directWaiting.status, 202)
  const preservedDirectFee = state.listingFeeAttempt
  assert.equal(preservedDirectFee?.payment_status, 'payment_pending')

  state.listingFeeAttempt = null
  const x402Waiting = await app.request('/api/world/listing', {
    method: 'POST', headers: { ...auth, 'X-PAYMENT': X402_PAYMENT }, body: requestBody,
  })
  assert.equal(x402Waiting.status, 503)
  assert.equal(state.x402Attempt?.status, 'settled')

  state.listingFeeAttempt = preservedDirectFee
  state.rpcFinalized = true
  const retry = await app.request('/api/world/listing', {
    method: 'POST', headers: auth, body: requestBody,
  })
  assert.equal(retry.status, 201)
  assert.equal(state.listingFeeAttempt?.payment_status, 'payment_pending')
})

test('a mismatched settled world-listing fee is rejected before Base or facilitator work', async () => {
  reset()
  state.rpcFinalized = false
  const requestBody = JSON.stringify({ draft_id: 12, city_offer_id: 33 })
  const waiting = await app.request('/api/world/listing', {
    method: 'POST', headers: { ...auth, 'X-PAYMENT': X402_PAYMENT }, body: requestBody,
  })
  assert.equal(waiting.status, 503, await waiting.clone().text())
  assert.equal(state.x402Attempt?.status, 'settled')
  state.x402Attempt = { ...state.x402Attempt!, amount_units: '999999' }
  const rpcCallsBeforeRetry = state.rpcCalls
  const listingWritesBeforeRetry = state.dbCalls.filter(call =>
    call.query.includes('INSERT INTO listings')).length
  state.rpcFinalized = true

  const rejected = await app.request('/api/world/listing', {
    method: 'POST', headers: auth, body: requestBody,
  })
  assert.equal(rejected.status, 409, await rejected.clone().text())
  const body = await rejected.json() as Record<string, unknown>
  assert.equal(body.do_not_pay_again, true)
  assert.match(String(body.error), /recorded world listing fee.*exact listing request/i)
  assert.equal(state.x402Attempt?.status, 'settled')
  assert.equal(state.x402Attempt?.finalized_at, null)
  assert.equal(state.rpcCalls, rpcCallsBeforeRetry)
  assert.equal(state.facilitatorSettleCalls, 1)
  assert.equal(state.dbCalls.filter(call => call.query.includes('INSERT INTO listings')).length,
    listingWritesBeforeRetry)
})

test('an x402 world-listing fee accepted inside the draft window may finish after expiry', async () => {
  reset()
  state.rpcFinalized = false
  const requestBody = JSON.stringify({ draft_id: 12, city_offer_id: 33 })

  const waiting = await app.request('/api/world/listing', {
    method: 'POST', headers: { ...auth, 'X-PAYMENT': X402_PAYMENT }, body: requestBody,
  })
  assert.equal(waiting.status, 503, await waiting.clone().text())
  assert.equal(state.x402Attempt?.status, 'settled')

  const acceptedAt = new Date(state.x402Attempt!.operation_started_at)
  const expiresAt = new Date(acceptedAt.getTime() + 80)
  state.draftExpiresAt = expiresAt.toISOString()
  state.rpcListingFeeBlockTime = new Date(
    Math.floor(acceptedAt.getTime() / 1_000) * 1_000,
  ).toISOString()
  while (Date.now() <= expiresAt.getTime()) await delay(10)
  state.draftState = 'expired'
  state.rpcFinalized = true

  const created = await app.request('/api/world/listing', {
    method: 'POST', headers: auth, body: requestBody,
  })
  assert.equal(created.status, 201, await created.clone().text())
  assert.equal((await created.json() as { listing_id: number }).listing_id, 70)
  assert.equal(state.x402Attempt?.status, 'verified')
  assert.ok(new Date(state.x402Attempt!.finalized_at!).getTime() > expiresAt.getTime())

  const activation = state.dbCalls.find(call =>
    call.query.includes('INSERT INTO listings') && call.query.includes('x402_payment_attempts'))?.query ?? ''
  assert.match(activation, /operation_started_at[\s\S]*draft\.expires_at/iu)
  assert.match(activation, /finalized_block_time[\s\S]*draft\.expires_at/iu)
  assert.doesNotMatch(activation, /draft\.expires_at\s*>\s*now\(\)/iu)
})

test('an activated draft sentinel does not hide an x402 fee outside the original hour', async () => {
  reset()
  state.rpcFinalized = false
  const requestBody = JSON.stringify({ draft_id: 12, city_offer_id: 33 })
  const waiting = await app.request('/api/world/listing', {
    method: 'POST', headers: { ...auth, 'X-PAYMENT': X402_PAYMENT }, body: requestBody,
  })
  assert.equal(waiting.status, 503, await waiting.clone().text())
  assert.equal(state.x402Attempt?.status, 'settled')

  state.draftState = 'active'
  state.draftListingId = 70
  state.draftExpiresAt = '9999-12-31T23:59:59.999Z'
  state.rpcListingFeeBlockTime = '2026-08-12T02:00:00.000Z'
  state.rpcFinalized = true
  const response = await app.request('/api/world/listing', {
    method: 'POST', headers: auth, body: requestBody,
  })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: 'the recorded world listing fee was not accepted and transferred inside this draft window',
    retry: 'do not pay again; ask the market owner to review the recorded fee for this same world listing request',
    do_not_pay_again: true,
  })
})

test('an in-window x402 retry after activation reports draft state, not a payment timing failure', async () => {
  reset()
  const requestBody = JSON.stringify({ draft_id: 12, city_offer_id: 33 })
  const created = await app.request('/api/world/listing', {
    method: 'POST', headers: { ...auth, 'X-PAYMENT': X402_PAYMENT }, body: requestBody,
  })
  assert.equal(created.status, 201, await created.clone().text())

  const retried = await app.request('/api/world/listing', {
    method: 'POST', headers: auth, body: requestBody,
  })
  assert.equal(retried.status, 409)
  const body = await retried.json() as { error: string }
  assert.equal(body.error,
    'the world draft is no longer pending and unexpired; its recorded fee needs review')
  assert.notEqual(body.error,
    'the recorded world listing fee was not accepted and transferred inside this draft window')
})

test('an expired world draft keeps its recorded x402 fee in same-request review', async () => {
  reset()
  state.rpcFinalized = false

  const waiting = await app.request('/api/world/listing', {
    method: 'POST',
    headers: { ...auth, 'X-PAYMENT': X402_PAYMENT },
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
  })
  assert.equal(waiting.status, 503)
  assert.equal(state.x402Attempt?.status, 'settled')

  state.rpcFinalized = true
  state.draftState = 'expired'
  state.draftExpiresAt = '2026-08-12T00:01:00.000Z'
  const expired = await app.request('/api/world/listing', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
  })
  assert.equal(expired.status, 409)
  const body = await expired.json() as Record<string, unknown>
  assert.equal(body.do_not_pay_again, true)
  assert.equal('accepts' in body, false)
  assert.match(String(body.retry), /same world listing request/i)
  assert.match(String(body.retry), /review/i)
  assert.equal(state.facilitatorSettleCalls, 1)
  assert.equal(state.x402Attempt?.status, 'verified')
  const rpcCallsAfterTerminalReview = state.rpcCalls

  const repeated = await app.request('/api/world/listing', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
  })
  assert.equal(repeated.status, 409)
  assert.deepEqual(await repeated.json(), body)
  assert.equal(state.x402Attempt?.status, 'verified')
  assert.equal(state.rpcCalls, rpcCallsAfterTerminalReview)
  assert.equal(state.facilitatorSettleCalls, 1)
})

test('world activation names only the exact offer, draft, and fee transaction conflicts', async () => {
  const cases = [
    ['listings_world_offer_unique', 'that city offer was already used by another market listing'],
    ['listings_world_draft_unique', 'that world draft was already used by another market listing'],
    ['fees_tx_hash_key', 'that fee transaction was already used'],
    ['fees_tx_hash_lower_unique', 'that fee transaction was already used'],
    ['payment_uses_pkey', 'that fee transaction was already used'],
  ] as const

  for (const [constraint, expected] of cases) {
    reset()
    state.activationInsertError = { code: '23505', constraint, nested: constraint === 'payment_uses_pkey' }
    const response = await app.request('/api/world/listing', {
      method: 'POST', headers: { ...auth, 'X-PAYMENT': X402_PAYMENT },
      body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
    })
    assert.equal(response.status, 409, constraint)
    const body = await response.json() as Record<string, unknown>
    assert.equal(body.error, expected, constraint)
    assert.equal(body.do_not_pay_again, true, constraint)
    assert.match(String(body.retry), /same world listing request/i, constraint)
    assert.match(String(body.retry), /review/i, constraint)
  }

  reset()
  state.activationInsertError = { code: '23505', constraint: 'listings_pkey' }
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const internal = await app.request('/api/world/listing', {
      method: 'POST', headers: { ...auth, 'X-PAYMENT': X402_PAYMENT },
      body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
    })
    assert.equal(internal.status, 503)
    const body = await internal.json() as Record<string, unknown>
    assert.equal(body.do_not_pay_again, true)
    assert.match(String(body.retry), /same world listing request/i)
    assert.match(String(body.retry), /without X-PAYMENT/i)
  } finally {
    console.error = originalConsoleError
  }
})

test('a nonresident buyer stops before checkout and is told to choose their own city name', async () => {
  reset()
  state.merchantId = 9
  state.draftListingId = 70
  state.residentExists = false
  const response = await app.request('/api/world/checkout/70', {
    method: 'POST', headers: auth, body: JSON.stringify({ city_handle: 'new-neighbor' }),
  })
  assert.equal(response.status, 409)
  assert.match((await response.json() as { error: string }).error, /register in the city.*choose your own name.*before checkout.*payment/i)
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO world_checkouts')), false)
  assert.equal(state.rpcCalls, 0)
})

test('checkout binds one market buyer to one city resident and closes the race', async () => {
  reset()
  state.merchantId = 9
  state.draftListingId = 70
  const created = await app.request('/api/world/checkout/70', {
    method: 'POST', headers: auth, body: JSON.stringify({ city_handle: 'new-neighbor' }),
  })
  assert.equal(created.status, 201)
  const body = await created.json() as Record<string, unknown>
  assert.equal(body.checkout_id, 60)
  assert.equal(body.city_claim_url, 'https://1f3d9.com/api/world/offer/33/claim')
  const expirySweep = state.dbCalls.findIndex(call =>
    call.query.includes("UPDATE world_checkouts SET status = 'expired'"))
  const checkoutInsert = state.dbCalls.findIndex(call => call.query.includes('INSERT INTO world_checkouts'))
  assert.ok(expirySweep >= 0)
  assert.ok(checkoutInsert > expirySweep)
  assert.equal(state.dbCalls[expirySweep]!.query.includes('INSERT INTO world_checkouts'), false)

  state.checkoutInsertError = { code: '23505', constraint: 'world_checkouts_one_active_per_buyer' }
  const raced = await app.request('/api/world/checkout/70', {
    method: 'POST', headers: auth, body: JSON.stringify({ city_handle: 'new-neighbor' }),
  })
  assert.equal(raced.status, 409)
})

test('world checkout reports only its active-checkout constraint as a caller conflict', async () => {
  reset()
  state.merchantId = 9
  state.draftListingId = 70
  state.checkoutInsertError = {
    code: '23505', constraint: 'world_checkouts_one_active_per_buyer', nested: true,
  }
  const conflict = await app.request('/api/world/checkout/70', {
    method: 'POST', headers: auth, body: JSON.stringify({ city_handle: 'new-neighbor' }),
  })
  assert.equal(conflict.status, 409)
  assert.deepEqual(await conflict.json(), {
    error: 'you already have an active checkout for this listing; wait for its ten-minute expiry',
  })

  reset()
  state.merchantId = 9
  state.draftListingId = 70
  state.checkoutInsertError = { code: '23505', constraint: 'world_checkouts_pkey' }
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const internal = await app.request('/api/world/checkout/70', {
      method: 'POST', headers: auth, body: JSON.stringify({ city_handle: 'new-neighbor' }),
    })
    assert.equal(internal.status, 500)
    assert.deepEqual(await internal.json(), { error: 'internal market failure; retry later' })
  } finally {
    console.error = originalConsoleError
  }
})

test('normal buy and direct claim reject world delivery before any payment work', async () => {
  reset()
  state.merchantId = 9
  for (const path of ['/api/buy/70', '/api/claim/70']) {
    const response = await app.request(path, {
      method: 'POST', headers: auth, body: path.includes('claim') ? JSON.stringify({ tx_hash: TX }) : '{}',
    })
    assert.equal(response.status, 409)
    assert.match((await response.json() as { error: string }).error, /world checkout.*\/api\/world\/checkout\/70/i)
  }
  assert.equal(state.rpcCalls, 0)
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)
})

test('world sync rejects mismatches and outages without terminal local writes', async () => {
  reset()
  state.merchantId = 9
  state.draftListingId = 70
  state.cityMode = 'mismatch'
  const mismatch = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(mismatch.status, 409)
  assert.deepEqual(await mismatch.json(), {
    error: 'city thing does not match the listing',
    retry: 'retry this same sync request; do not make another payment',
    do_not_pay_again: true,
  })

  reset()
  state.merchantId = 9
  state.draftListingId = 70
  state.cityMode = 'outage'
  const outage = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(outage.status, 503)
  const outageBody = await outage.json() as { retry: string; do_not_pay_again: boolean }
  assert.equal(outageBody.retry, 'retry this same sync request; do not make another payment')
  assert.equal(outageBody.do_not_pay_again, true)
  assert.equal(state.listingWorldState, 'active')
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)
})

test('malformed claimed evidence keeps a same-sync no-pay instruction', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  state.cityClaimedAt = 'not-a-date'
  const response = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(response.status, 503)
  const body = await response.json() as { error: string; retry: string; do_not_pay_again: boolean }
  assert.match(body.error, /malformed/i)
  assert.equal(body.retry, 'retry this same sync request; do not make another payment')
  assert.equal(body.do_not_pay_again, true)
})

test('a claimed checkout read outage keeps a same-sync no-pay instruction', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  state.checkoutReadError = true
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const response = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      error: 'the market could not confirm this paid checkout binding; retry this same sync request; do not make another payment',
      retry: 'retry this same sync request; do not make another payment',
      do_not_pay_again: true,
    })
  } finally {
    console.error = originalConsoleError
  }
  assert.equal(state.rpcCalls, 0)
})

test('claimed city ownership becomes one idempotent market receipt and verified purchase', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  const first = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(first.status, 200)
  const firstBody = await first.json() as { receipt: Record<string, unknown> }
  assert.equal(firstBody.receipt.delivery_kind, 'city_ownership')
  assert.equal(firstBody.receipt.city_handle, 'new-neighbor')
  assert.equal(state.listingWorldState, 'sold')
  assert.equal(state.checkoutStatus, 'completed')
  assert.equal(state.dbCalls.filter(call => call.query.includes('INSERT INTO purchases')).length, 1)

  const second = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(second.status, 200)
  assert.equal(state.dbCalls.filter(call => call.query.includes('INSERT INTO purchases')).length, 1)
})

test('world sync waits for canonical finality and later completes the same in-window transfer', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  state.rpcFinalized = false

  const waiting = await app.request('/api/world/sync/70', {
    method: 'POST', headers: auth, body: '{}',
  })
  assert.equal(waiting.status, 202, await waiting.clone().text())
  assert.deepEqual(await waiting.json(), {
    listing_id: 70,
    status: 'payment_pending',
    do_not_pay_again: true,
    retry: 'retry this same sync request after Base finality; do not make another payment',
  })
  assert.equal(state.priorReceipt, null)

  const cityCallsAfterReservation = state.cityCalls.length
  state.cityMode = 'outage'
  state.rpcFinalized = true
  const completed = await app.request('/api/world/sync/70', {
    method: 'POST', headers: auth, body: '{}',
  })
  assert.equal(completed.status, 200, await completed.clone().text())
  assert.equal((await completed.json() as { receipt: { tx_hash: string } }).receipt.tx_hash, TX)
  const recorded = state.priorReceipt as Record<string, unknown> | null
  assert.equal(recorded?.tx_hash, TX)
  assert.equal(state.cityCalls.length, cityCallsAfterReservation)
})

test('world sync reviews preserved payment terms that no longer exactly match checkout', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  state.rpcFinalized = false

  const waiting = await app.request('/api/world/sync/70', {
    method: 'POST', headers: auth, body: '{}',
  })
  assert.equal(waiting.status, 202, await waiting.clone().text())
  assert.ok(state.worldAttempt)
  state.worldAttempt = { ...state.worldAttempt, merchant_id: 999 }
  const rpcCallsBeforeRetry = state.rpcCalls
  const cityCallsBeforeRetry = state.cityCalls.length
  state.rpcFinalized = true
  state.cityMode = 'outage'

  const reviewed = await app.request('/api/world/sync/70', {
    method: 'POST', headers: auth, body: '{}',
  })
  assert.equal(reviewed.status, 409, await reviewed.clone().text())
  const body = await reviewed.json() as Record<string, unknown>
  assert.equal(body.status, 'needs_review')
  assert.equal(body.do_not_pay_again, true)
  assert.match(String(body.error), /stored payment terms.*checkout/i)
  assert.equal(state.worldAttempt?.status, 'needs_review')
  assert.equal(state.rpcCalls, rpcCallsBeforeRetry)
  assert.equal(state.cityCalls.length, cityCallsBeforeRetry)
})

test('a preserved world sync keeps explicit no-pay instructions while custody is closed', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  state.rpcFinalized = false
  const waiting = await app.request('/api/world/sync/70', {
    method: 'POST', headers: auth, body: '{}',
  })
  assert.equal(waiting.status, 202, await waiting.clone().text())
  assert.ok(state.worldAttempt)

  const previousEnvironment = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    PAYMENT_CUSTODY_READY: process.env.PAYMENT_CUSTODY_READY,
  }
  process.env.VERCEL_ENV = 'production'
  delete process.env.PAYMENT_CUSTODY_READY
  try {
    const closed = await app.request('/api/world/sync/70', {
      method: 'POST', headers: auth, body: '{}',
    })
    assert.equal(closed.status, 503)
    const body = await closed.json() as Record<string, unknown>
    assert.equal(body.do_not_pay_again, true)
    assert.match(String(body.retry), /same sync request/i)
    assert.doesNotMatch(String(body.error), /custody/i)
  } finally {
    if (previousEnvironment.VERCEL_ENV == null) delete process.env.VERCEL_ENV
    else process.env.VERCEL_ENV = previousEnvironment.VERCEL_ENV
    if (previousEnvironment.PAYMENT_CUSTODY_READY == null) delete process.env.PAYMENT_CUSTODY_READY
    else process.env.PAYMENT_CUSTODY_READY = previousEnvironment.PAYMENT_CUSTODY_READY
  }
})

test('world sync keeps finalized contradictions and reused transactions in do-not-pay-again review', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  state.rpcWorldAmountUnits = 1_999_999n

  const mismatch = await app.request('/api/world/sync/70', {
    method: 'POST', headers: auth, body: '{}',
  })
  assert.equal(mismatch.status, 409, await mismatch.clone().text())
  assert.equal((await mismatch.json() as { do_not_pay_again: boolean }).do_not_pay_again, true)
  assert.equal(state.worldAttempt?.status, 'needs_review')
  assert.equal(state.worldAttempt?.finalized_block_number, '256')
  assert.equal(state.worldAttempt?.finalized_block_hash, '0x' + 'bb'.repeat(32))
  assert.equal(state.worldAttempt?.finalized_block_time, state.cityBlockTime)
  assert.ok(state.worldAttempt?.finalized_at)
  assert.equal(state.priorReceipt, null)
  const rpcCallsAfterReview = state.rpcCalls
  const cityCallsAfterReview = state.cityCalls.length
  state.cityMode = 'outage'

  const reviewedAgain = await app.request('/api/world/sync/70', {
    method: 'POST', headers: auth, body: '{}',
  })
  assert.equal(reviewedAgain.status, 409)
  assert.equal(state.rpcCalls, rpcCallsAfterReview)
  assert.equal(state.cityCalls.length, cityCallsAfterReview)

  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  state.attemptReserveError = { code: '23505', constraint: 'payment_uses_pkey' }
  const reused = await app.request('/api/world/sync/70', {
    method: 'POST', headers: auth, body: '{}',
  })
  assert.equal(reused.status, 409, await reused.clone().text())
  assert.equal((await reused.json() as { do_not_pay_again: boolean }).do_not_pay_again, true)
  assert.equal(state.worldAttempt?.status, 'needs_review')
  assert.equal(state.rpcCalls, 0)
})

test('a world review write outage keeps the same-sync no-pay instruction', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  state.rpcWorldAmountUnits = 1_999_999n
  state.worldReviewWriteError = true
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const response = await app.request('/api/world/sync/70', {
      method: 'POST', headers: auth, body: '{}',
    })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      error: 'the market could not confirm this paid checkout review; retry this same sync request; do not make another payment',
      retry: 'retry this same sync request',
      do_not_pay_again: true,
    })
  } finally {
    console.error = originalConsoleError
  }
  assert.notEqual(state.worldAttempt, null)
})

test('a world review write with no confirmed state keeps the same-sync no-pay instruction', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  state.rpcWorldAmountUnits = 1_999_999n
  state.worldReviewWriteNoop = true
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const response = await app.request('/api/world/sync/70', {
      method: 'POST', headers: auth, body: '{}',
    })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      error: 'the market could not confirm this paid checkout review; retry this same sync request; do not make another payment',
      retry: 'retry this same sync request',
      do_not_pay_again: true,
    })
  } finally {
    console.error = originalConsoleError
  }
  assert.equal(state.worldAttempt?.status, 'payment_pending')
})

test('a world attempt reservation outage keeps the same-sync no-pay instruction', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  state.attemptReserveError = { code: '08006', constraint: 'world_payment_attempts_pkey' }
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const response = await app.request('/api/world/sync/70', {
      method: 'POST', headers: auth, body: '{}',
    })
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), {
      error: 'the market could not preserve this paid checkout; retry this same sync request; do not make another payment',
      retry: 'retry this same sync request; do not make another payment',
      do_not_pay_again: true,
    })
  } finally {
    console.error = originalConsoleError
  }
  assert.equal(state.rpcCalls, 0)
})

test('world sync distinguishes committed replays, used payment transactions, and internal unique failures', async () => {
  for (const constraint of ['purchases_listing_id_merchant_id_key', 'purchases_world_checkout_unique']) {
    reset()
    state.merchantId = 10
    state.draftListingId = 70
    state.cityMode = 'claimed'
    state.purchaseInsertError = { code: '23505', constraint, nested: constraint === 'purchases_world_checkout_unique' }
    const response = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
    assert.equal(response.status, 409, constraint)
    assert.deepEqual(await response.json(), {
      listing_id: 70,
      status: 'needs_review',
      do_not_pay_again: true,
      error: 'the market already has conflicting payment history; no market sale was recorded; do not pay again',
      retry: 'repeating this same sync only rereads the preserved review state; do not make another payment',
    }, constraint)
  }

  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  state.purchaseInsertError = { code: '23505', constraint: 'purchases_world_checkout_unique' }
  state.purchaseConflictWritesReceipt = true
  const replay = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(replay.status, 200)
  assert.equal((await replay.json() as { receipt: { purchase_id: number } }).receipt.purchase_id, 81)

  for (const constraint of ['purchases_tx_hash_key', 'purchases_tx_hash_lower_unique', 'payment_uses_pkey']) {
    reset()
    state.merchantId = 10
    state.draftListingId = 70
    state.cityMode = 'claimed'
    state.purchaseInsertError = { code: '23505', constraint, nested: constraint === 'payment_uses_pkey' }
    const response = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
    assert.equal(response.status, 409, constraint)
    assert.deepEqual(await response.json(), {
      listing_id: 70,
      status: 'needs_review',
      do_not_pay_again: true,
      error: 'the market already has conflicting payment history; no market sale was recorded; do not pay again',
      retry: 'repeating this same sync only rereads the preserved review state; do not make another payment',
    }, constraint)
  }

  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  state.purchaseInsertError = { code: '23505', constraint: 'purchases_pkey' }
  state.purchaseConflictWritesReceipt = true
  const unknownCommitted = await app.request('/api/world/sync/70', {
    method: 'POST', headers: auth, body: '{}',
  })
  assert.equal(unknownCommitted.status, 200)
  assert.equal(
    (await unknownCommitted.json() as { receipt: { purchase_id: number } }).receipt.purchase_id,
    81,
  )

  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  state.purchaseInsertError = { code: 'XX000', constraint: 'unexpected_world_completion' }
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const internal = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
    assert.equal(internal.status, 503)
    assert.deepEqual(await internal.json(), {
      error: 'the market could not confirm whether this paid checkout was recorded; retry this same sync request; do not make another payment',
      retry: 'retry this same sync request',
      do_not_pay_again: true,
    })
  } finally {
    console.error = originalConsoleError
  }
})

test('world withdrawal is market-first and truthfully requires a separate city unlock', async () => {
  reset()
  state.draftListingId = 70
  const response = await app.request('/api/listing/70/withdraw', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    listing_id: 70,
    status: 'withdrawn',
    city_unlock_required: true,
    city_cancel_url: 'https://1f3d9.com/api/world/offer/33/cancel',
  })
  assert.equal(state.cityCalls.length, 0)
})

test('checkout expiry governs reservation start, while a reserved city payment may finish later', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  state.checkoutExpiresAt = '2026-08-12T00:05:00.000Z'
  state.cityReservedAt = '2026-08-12T00:04:00.000Z'
  state.cityReservedUntil = '2026-08-12T00:09:00.000Z'
  state.cityClaimedAt = '2026-08-12T00:08:30.000Z'
  state.cityBlockTime = '2026-08-12T00:08:00.000Z'
  const valid = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(valid.status, 200)

  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  state.checkoutExpiresAt = '2026-08-12T00:05:00.000Z'
  state.cityReservedAt = '2026-08-12T00:05:00.000Z'
  state.cityReservedUntil = '2026-08-12T00:10:00.000Z'
  state.cityBlockTime = '2026-08-12T00:07:00.000Z'
  const lateReservation = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(lateReservation.status, 409)
  assert.equal((await lateReservation.json() as { do_not_pay_again?: boolean }).do_not_pay_again, true)
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)

  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  state.cityBlockTime = '2026-08-12T00:09:01.000Z'
  const latePayment = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(latePayment.status, 409)
  const latePaymentBody = await latePayment.json() as { error: string; do_not_pay_again?: boolean }
  assert.match(latePaymentBody.error, /payment evidence.*outside.*reservation/i)
  assert.equal(latePaymentBody.do_not_pay_again, true)
})

test('world sync allows only the documented 60-second city clock lead before checkout', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  state.checkoutCreatedAt = '2026-08-12T00:02:00.000Z'
  state.checkoutExpiresAt = '2026-08-12T00:12:00.000Z'
  state.cityReservedAt = '2026-08-12T00:01:00.000Z'
  state.cityReservedUntil = '2026-08-12T00:06:00.000Z'
  state.cityBlockTime = '2026-08-12T00:03:00.000Z'
  const boundary = await app.request('/api/world/sync/70', {
    method: 'POST', headers: auth, body: '{}',
  })
  assert.equal(boundary.status, 200)

  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  state.checkoutCreatedAt = '2026-08-12T00:02:00.000Z'
  state.checkoutExpiresAt = '2026-08-12T00:12:00.000Z'
  state.cityReservedAt = '2026-08-12T00:00:59.000Z'
  state.cityReservedUntil = '2026-08-12T00:05:59.000Z'
  state.cityBlockTime = '2026-08-12T00:03:00.000Z'
  const replay = await app.request('/api/world/sync/70', {
    method: 'POST', headers: auth, body: '{}',
  })
  assert.equal(replay.status, 409)
  const body = await replay.json() as { error: string; do_not_pay_again?: boolean }
  assert.match(body.error, /reservation.*before.*checkout/iu)
  assert.equal(body.do_not_pay_again, true)
  assert.equal(state.dbCalls.some(call => call.query.includes('x402-payment-attempt:reserve')), false)
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)
})

test('a valid city claim wins a concurrent market withdrawal and draft truth becomes sold', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.draftState = 'withdrawn'
  state.listingWorldState = 'canceled'
  state.listingWithdrawn = true
  state.listingWithdrawnAt = '2026-08-12T00:06:00.000Z'
  state.checkoutStatus = 'expired'
  state.cityMode = 'claimed'
  state.cityReservedAt = '2026-08-12T00:04:00.000Z'
  state.cityReservedUntil = '2026-08-12T00:09:00.000Z'
  state.cityBlockTime = '2026-08-12T00:05:00.000Z'
  state.cityClaimedAt = '2026-08-12T00:08:00.000Z'
  const response = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(response.status, 200)
  assert.equal(state.listingWorldState, 'sold')
  assert.equal(state.draftState, 'sold')

  const publicDraft = await app.request('/api/world/draft/12')
  assert.equal((await publicDraft.json() as { draft: { status: string } }).draft.status, 'sold')
})

test('a city reservation opened after merchant withdrawal cannot reopen the sale', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.draftState = 'withdrawn'
  state.listingWorldState = 'canceled'
  state.listingWithdrawn = true
  state.listingWithdrawnReason = 'withdrawn by merchant'
  state.listingWithdrawnAt = '2026-08-12T00:06:00.000Z'
  state.checkoutStatus = 'expired'
  state.cityMode = 'claimed'
  state.cityReservedAt = '2026-08-12T00:07:00.000Z'
  state.cityReservedUntil = '2026-08-12T00:12:00.000Z'
  state.cityBlockTime = '2026-08-12T00:08:00.000Z'
  state.cityClaimedAt = '2026-08-12T00:08:00.000Z'

  const response = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(response.status, 409)
  assert.match((await response.json() as { error: string }).error, /withdrawn before the city reservation/i)
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)
})

test('sold world ownership cannot be overwritten by a later merchant withdrawal', async () => {
  reset()
  state.draftListingId = 70
  state.draftState = 'sold'
  state.listingWorldState = 'sold'
  state.merchantId = 7

  const response = await app.request('/api/listing/70/withdraw', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(response.status, 409)
  assert.match((await response.json() as { error: string }).error, /already sold/i)
  assert.equal(state.listingWorldState, 'sold')
  assert.equal(state.listingWithdrawn, false)
})

test('maintainer removal projects a canceled draft so the city can unlock', async () => {
  reset()
  state.draftListingId = 70
  state.listingRemoved = true
  const response = await app.request('/api/world/draft/12')
  assert.equal(response.status, 200)
  assert.equal((await response.json() as { draft: { status: string } }).draft.status, 'canceled')
})

test('sync events name the actual market seller, never the arbitrary sync caller', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'claimed'
  const response = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(response.status, 200)
  const atomic = state.dbCalls.find(call => call.query.includes('INSERT INTO purchases'))
  assert.ok(atomic)
  assert.ok(atomic.params.includes('agent-7'))
  assert.equal(atomic.params.includes('agent-10'), false)
})

test('ordinary listing creation cannot smuggle an artifact into the world aisle', async () => {
  reset()
  const response = await app.request('/api/listing', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      title: 'Not city ownership', description: 'ordinary artifact', preview: '', artifact: 'bytes',
      price_usdc: 1, seller_wallet: SELLER, tags: ['world'], aisle: 'world',
    }),
  })
  assert.equal(response.status, 400)
  assert.match((await response.json() as { error: string }).error, /world listings start/i)
  assert.equal(state.rpcCalls, 0)
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO listings')), false)
})

test('world listing public reads describe city ownership and never advertise a download', async () => {
  reset()
  state.draftListingId = 70
  const response = await app.request('/api/listing/70')
  assert.equal(response.status, 200)
  const payload = await response.json() as { listing: Record<string, unknown>; artifact: string }
  assert.equal(payload.listing.delivery_kind, 'city_ownership')
  assert.equal(payload.listing.requires_city_resident, true)
  assert.equal(payload.listing.city_offer_url, 'https://1f3d9.com/api/world/offer/33')
  assert.equal(payload.listing.world_asset_url, 'https://1f3d9.com/api/world/offer/33')
  assert.match(payload.artifact, /ownership is delivered in the city/i)
  assert.doesNotMatch(payload.artifact, /api\/buy|download/i)
})

test('world receipts replace downloadable artifacts in purchase history', async () => {
  reset()
  state.merchantId = 9
  state.priorReceipt = purchaseRow()
  const response = await app.request('/api/purchases', { headers: auth })
  assert.equal(response.status, 200)
  const payload = await response.json() as { purchases: Record<string, unknown>[] }
  assert.equal(payload.purchases.length, 1)
  assert.equal(payload.purchases[0]!.delivery_kind, 'city_ownership')
  assert.equal(Object.prototype.hasOwnProperty.call(payload.purchases[0], 'artifact'), false)
  assert.deepEqual(payload.purchases[0]!.world_receipt, storedWorldReceipt())
})

test('corrupt stored world receipts report an internal failure through every read door', async () => {
  reset()
  state.merchantId = 9
  state.priorReceipt = purchaseRow({})
  const expected = { error: 'internal market failure; retry later' }
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const sync = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
    assert.equal(sync.status, 500)
    assert.deepEqual(await sync.json(), expected)

    const mcpResponse = await app.request('/mcp', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'sync_world', arguments: { listing_id: 70 } },
      }),
    })
    const mcpBody = await mcpResponse.json() as {
      result: { content: Array<{ text: string }>; isError: boolean }
    }
    assert.equal(mcpBody.result.isError, true)
    const mcpError = JSON.parse(mcpBody.result.content[0]!.text) as Record<string, unknown>
    assert.equal(mcpError.error, expected.error)
    assert.equal(mcpError.error_class, 'market_fault')
    assert.equal(mcpError.http_status, 500)
    assert.equal(mcpError.front_door_tool, 'front_door')
    assert.equal(mcpError.front_door, 'https://1f3ea.com/')

    const purchases = await app.request('/api/purchases', { headers: auth })
    assert.equal(purchases.status, 500)
    assert.deepEqual(await purchases.json(), expected)

    const me = await app.request('/api/me', { headers: auth })
    assert.equal(me.status, 500)
    assert.deepEqual(await me.json(), expected)
  } finally {
    console.error = originalConsoleError
  }
})

test('public checkout status expires by time without mutating the public record', async () => {
  reset()
  const active = await app.request('/api/world/checkout/60')
  assert.equal(active.status, 200)
  assert.equal((await active.json() as { checkout: { status: string } }).checkout.status, 'active')

  state.checkoutExpiresAt = '2020-01-01T00:00:00.000Z'
  const expired = await app.request('/api/world/checkout/60')
  const record = (await expired.json() as { checkout: Record<string, unknown> }).checkout
  assert.equal(record.status, 'expired')
  assert.equal(record.city_handle, 'new-neighbor')
  assert.equal(JSON.stringify(record).includes('secret'), false)
})

test('world edits are rejected because the city locked the terms', async () => {
  reset()
  state.draftListingId = 70
  const response = await app.request('/api/listing/70', {
    method: 'PATCH', headers: auth, body: JSON.stringify({ description: 'changed terms' }),
  })
  assert.equal(response.status, 409)
  assert.match((await response.json() as { error: string }).error, /terms are locked in the city/i)
  assert.equal(state.dbCalls.some(call => /UPDATE listings SET\s+description/i.test(call.query)), false)
})

test('city cancellation makes the world listing terminal without a purchase', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'canceled'
  const response = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(response.status, 200)
  assert.equal((await response.json() as { status: string }).status, 'canceled')
  assert.equal(state.listingWorldState, 'canceled')
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)
  const terminal = state.dbCalls.find(call => call.query.includes('world_canceled'))
  assert.ok(terminal?.params.includes('agent-7'))
  assert.equal(terminal?.params.includes('agent-10'), false)
})

test('MCP exposes and dispatches all four world write tools without secret arguments', async () => {
  reset()
  const listed = await app.request('/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  const tools = (await listed.json() as {
    result: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }
  }).result.tools
  for (const name of ['draft_world', 'list_world', 'checkout_world', 'sync_world'])
    assert.ok(tools.some(tool => tool.name === name), `${name} is advertised`)
  const worldSchemas = tools.filter(tool => tool.name.includes('world')).map(tool => tool.inputSchema)
  assert.doesNotMatch(JSON.stringify(worldSchemas), /secret|city_origin/i)

  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await app.request('/mcp', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
    })
    return response.json() as Promise<{ result: { content: Array<{ text: string }>; isError: boolean } }>
  }
  const drafted = await call('draft_world', JSON.parse(draftBody()))
  assert.equal(drafted.result.isError, false)
  assert.match(drafted.result.content[0]!.text, /"draft_id":12/)

  reset()
  const listing = await call('list_world', { draft_id: 12, city_offer_id: 33 })
  assert.equal(listing.result.isError, true)
  assert.match(listing.result.content[0]!.text, /world listing costs \$1/i)

  reset()
  state.merchantId = 9
  state.draftListingId = 70
  const checkout = await call('checkout_world', { listing_id: 70, city_handle: 'new-neighbor' })
  assert.equal(checkout.result.isError, false)
  assert.match(checkout.result.content[0]!.text, /"checkout_id":60/)

  reset()
  state.merchantId = 10
  state.draftListingId = 70
  const synced = await call('sync_world', { listing_id: 70 })
  assert.equal(synced.result.isError, false)
  assert.match(synced.result.content[0]!.text, /"status":"active"/)
})

test('the market never reuses even an apparently expired city reservation', async () => {
  reset()
  state.merchantId = 9
  state.draftListingId = 70
  state.cityMode = 'reserved-expired'
  const response = await app.request('/api/world/checkout/70', {
    method: 'POST', headers: auth, body: JSON.stringify({ city_handle: 'new-neighbor' }),
  })
  assert.equal(response.status, 409)
  assert.match((await response.json() as { error: string }).error, /not available/i)
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO world_checkouts')), false)
})

test('payment_pending remains locked to its city buyer until the city reports claimed', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'payment-pending'

  const synced = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(synced.status, 200)
  assert.deepEqual(await synced.json(), {
    listing_id: 70,
    status: 'active',
    city_phase: 'payment_pending',
    do_not_pay_again: true,
    retry: 'retry this same sync request; the market will reconcile the recorded city payment; do not make another payment',
  })
  assert.equal(state.checkoutStatus, 'active')
  assert.equal(state.listingWorldState, 'active')
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)

  state.merchantId = 11
  state.checkoutCityHandle = 'other-neighbor'
  const another = await app.request('/api/world/checkout/70', {
    method: 'POST', headers: auth, body: JSON.stringify({ city_handle: 'other-neighbor' }),
  })
  assert.equal(another.status, 409)
  assert.match((await another.json() as { error: string }).error, /not available/i)
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO world_checkouts')), false)
})

test('city market_buyer must match the bound market checkout throughout its bound phases', async () => {
  for (const mode of [
    'reserved',
    'payment-pending',
    'payment-invalid',
    'payment-expired',
    'founder-review',
    'claimed',
  ] as const) {
    reset()
    state.merchantId = 10
    state.draftListingId = 70
    state.cityMode = mode
    state.cityMarketBuyer = 'wrong-market-buyer'

    const response = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
    assert.equal(response.status, 409)
    const body = await response.json() as { error: string; do_not_pay_again?: boolean }
    assert.match(body.error, /market buyer.*checkout/i)
    assert.equal(body.do_not_pay_again, true)
    assert.equal(state.listingWorldState, 'active')
    assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)
  }
})

test('payment_invalid closes the market lane without inventing a sale', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'payment-invalid'

  const response = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    listing_id: 70,
    status: 'stale',
    city_phase: 'payment_invalid',
    city_unlock_required: true,
    city_cancel_url: 'https://1f3d9.com/api/world/offer/33/cancel',
    do_not_pay_again: true,
    error: 'the city rejected this checkout payment; no market sale was recorded; do not pay again',
    retry: 'city seller: authenticate to the city and POST {} to city_cancel_url to cancel the offer and unlock the thing; do not make another payment',
  })
  assert.equal(state.listingWorldState, 'stale')
  assert.equal(state.checkoutStatus, 'expired')
  assert.equal(state.draftState, 'canceled')
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)

  const draft = await app.request('/api/world/draft/12')
  const publicDraft = (await draft.json() as {
    draft: { status: string; listing_id: number; listing_state: string }
  }).draft
  assert.equal(publicDraft.status, 'canceled')
  assert.equal(publicDraft.listing_id, 70)
  assert.equal(publicDraft.listing_state, 'canceled')
  const checkout = await app.request('/api/world/checkout/60')
  assert.equal((await checkout.json() as { checkout: { status: string } }).checkout.status, 'expired')

  const repeated = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(repeated.status, 200)
  assert.deepEqual(await repeated.json(), {
    listing_id: 70,
    status: 'stale',
    city_phase: 'payment_invalid',
    city_unlock_required: true,
    city_cancel_url: 'https://1f3d9.com/api/world/offer/33/cancel',
    do_not_pay_again: true,
    error: 'the city rejected this checkout payment; no market sale was recorded; do not pay again',
    retry: 'city seller: authenticate to the city and POST {} to city_cancel_url to cancel the offer and unlock the thing; do not make another payment',
  })
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)
})

test('terminal city payment outcomes close the market lane without inventing a sale', async () => {
  const outcomes = [
    {
      mode: 'payment-expired',
      phase: 'payment_expired',
      reason: 'city payment expired',
      error: "the city's automatic payment recovery window ended without an ownership transfer; no market sale was recorded; do not pay again",
    },
    {
      mode: 'founder-review',
      phase: 'founder_review',
      reason: 'city founder review',
      error: "the city retained this checkout's payment evidence for founder review; ownership did not transfer and no market sale was recorded; do not pay again",
    },
  ] as const

  for (const outcome of outcomes) {
    reset()
    state.merchantId = 10
    state.draftListingId = 70
    state.cityMode = outcome.mode

    const response = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      listing_id: 70,
      status: 'stale',
      city_phase: outcome.phase,
      city_unlock_required: true,
      city_cancel_url: 'https://1f3d9.com/api/world/offer/33/cancel',
      do_not_pay_again: true,
      error: outcome.error,
      retry: 'city seller: authenticate to the city and POST {} to city_cancel_url to cancel the offer and unlock the thing; do not make another payment',
    })
    assert.equal(state.listingWorldState, 'stale')
    assert.equal(state.listingWithdrawnReason, outcome.reason)
    assert.equal(state.checkoutStatus, 'expired')
    assert.equal(state.draftState, 'canceled')
    assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)

    const repeated = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
    assert.equal(repeated.status, 200)
    assert.equal((await repeated.json() as { city_phase: string }).city_phase, outcome.phase)
    assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)
  }
})

test('terminal city payment sync preserves an earlier merchant withdrawal', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'payment-expired'
  state.draftState = 'withdrawn'
  state.listingWorldState = 'canceled'
  state.listingWithdrawn = true
  state.listingWithdrawnReason = 'withdrawn by merchant'
  state.listingWithdrawnAt = '2026-08-12T00:06:00.000Z'
  state.checkoutStatus = 'expired'

  const response = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(response.status, 200)
  const body = await response.json() as { status: string; city_phase: string }
  assert.equal(body.status, 'canceled')
  assert.equal(body.city_phase, 'payment_expired')
  assert.equal(state.listingWorldState, 'canceled')
  assert.equal(state.listingWithdrawnReason, 'withdrawn by merchant')
  assert.equal(state.draftState, 'withdrawn')
  assert.equal(state.checkoutStatus, 'expired')
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)
})

test('unknown city offer phases fail closed', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'unknown-phase'
  const response = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(response.status, 503)
  assert.match((await response.json() as { error: string }).error, /malformed/i)
  assert.equal(state.listingWorldState, 'active')
})

test('city public reads use the framework body read when Content-Length is absent', async () => {
  reset()
  state.cityMode = 'framework-body'
  const response = await app.request('/api/world/listing', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ draft_id: 12, city_offer_id: 33, fee_tx_hash: TX }),
  })
  assert.equal(response.status, 201, await response.clone().text())
})

test('city public reads reject an oversized framework-read body', async () => {
  reset()
  state.cityMode = 'huge-stream'
  const response = await app.request('/api/world/listing', {
    method: 'POST', headers: auth, body: JSON.stringify({ draft_id: 12, city_offer_id: 33 }),
  })
  assert.equal(response.status, 503)
  assert.match((await response.json() as { error: string }).error, /too large/i)
  assert.ok(state.cityStreamPulls > 0)
})

test('city cancellation remains canceled on the follow-up listing and draft records', async () => {
  reset()
  state.merchantId = 10
  state.draftListingId = 70
  state.cityMode = 'canceled'
  const synced = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(synced.status, 200)
  state.listingWithdrawnReason = 'city offer canceled'

  const listing = await app.request('/api/listing/70')
  assert.equal((await listing.json() as { listing: { state: string } }).listing.state, 'canceled')
  const draft = await app.request('/api/world/draft/12')
  assert.equal((await draft.json() as { draft: { status: string } }).draft.status, 'canceled')
})

test('maintainer removal atomically cancels the world lane and rejects a later city claim', async () => {
  reset()
  state.merchantId = 1
  state.draftListingId = 70
  const removed = await app.request('/api/mod/remove', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ listing_id: 70, reason: 'unsafe item' }),
  })
  assert.equal(removed.status, 200)
  assert.equal(state.listingRemoved, true)
  assert.equal(state.listingWorldState, 'canceled')
  assert.equal(state.checkoutStatus, 'expired')
  assert.equal(state.draftState, 'canceled')

  const checkout = await app.request('/api/world/checkout/60')
  assert.equal((await checkout.json() as { checkout: { status: string } }).checkout.status, 'expired')

  state.merchantId = 10
  state.cityMode = 'claimed'
  state.cityReservedAt = '2026-08-12T00:04:00.000Z'
  state.cityReservedUntil = '2026-08-12T00:09:00.000Z'
  state.cityBlockTime = '2026-08-12T00:07:00.000Z'
  const sync = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(sync.status, 409)
  assert.match((await sync.json() as { error: string }).error, /removed before the city reservation/i)
  assert.equal(state.dbCalls.some(call => call.query.includes('INSERT INTO purchases')), false)
})

test('a city reservation opened before maintainer removal still settles truthfully', async () => {
  reset()
  state.merchantId = 1
  state.draftListingId = 70
  const removed = await app.request('/api/mod/remove', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ listing_id: 70, reason: 'unsafe item' }),
  })
  assert.equal(removed.status, 200)

  state.merchantId = 10
  state.cityMode = 'claimed'
  state.cityReservedAt = '2026-08-12T00:02:00.000Z'
  state.cityReservedUntil = '2026-08-12T00:07:00.000Z'
  state.cityBlockTime = '2026-08-12T00:06:00.000Z'
  state.cityClaimedAt = '2026-08-12T00:08:00.000Z'
  const sync = await app.request('/api/world/sync/70', { method: 'POST', headers: auth, body: '{}' })
  assert.equal(sync.status, 200)
  assert.equal(state.listingWorldState, 'sold')

  const listing = await app.request('/api/listing/70')
  const listingBody = await listing.json() as { listing: { state: string; title: string } }
  assert.equal(listingBody.listing.state, 'sold')
  assert.equal(listingBody.listing.title, '[removed by the maintainer]')

  const me = await app.request('/api/me', { headers: auth })
  assert.equal((await me.json() as { listings: Array<{ state: string }> }).listings[0]!.state, 'sold')
})

test('maintainer removal after a completed sale preserves sold state', async () => {
  reset()
  state.merchantId = 1
  state.draftListingId = 70
  state.draftState = 'sold'
  state.listingWorldState = 'sold'
  state.checkoutStatus = 'completed'
  const response = await app.request('/api/mod/remove', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ listing_id: 70, reason: 'unsafe item' }),
  })
  assert.equal(response.status, 200)
  assert.equal(state.listingRemoved, true)
  assert.equal(state.listingWorldState, 'sold')
  assert.equal(state.draftState, 'sold')
})

test('/api/me reports truthful world terminal states, including merchant withdrawal', async () => {
  for (const expected of ['sold', 'canceled', 'withdrawn'] as const) {
    reset()
    state.listingWorldState = expected === 'sold' ? 'sold' : 'canceled'
    state.listingWithdrawn = expected !== 'sold'
    state.listingWithdrawnReason = expected === 'withdrawn' ? 'withdrawn by merchant' : 'city offer canceled'
    const response = await app.request('/api/me', { headers: auth })
    assert.equal(response.status, 200)
    const body = await response.json() as { listings: Array<{ state: string }> }
    assert.equal(body.listings[0]!.state, expected)
    const query = state.dbCalls.find(call => call.query.includes('FROM listings WHERE merchant_id'))?.query ?? ''
    assert.match(query, /world_state = 'sold'/)
    assert.match(query, /world_state IN \('canceled','stale'\)/)
    assert.match(query, /withdrawn_reason = 'withdrawn by merchant'/)
  }
})

test('world checkout is explicitly an intent; only the first city reservation wins', async () => {
  reset()
  state.merchantId = 9
  state.draftListingId = 70
  const response = await app.request('/api/world/checkout/70', {
    method: 'POST', headers: auth, body: JSON.stringify({ city_handle: 'new-neighbor' }),
  })
  assert.equal(response.status, 201)
  const body = await response.json() as { note: string }
  assert.match(body.note, /does not reserve the thing/i)
  assert.match(body.note, /first city reservation wins/i)
})
