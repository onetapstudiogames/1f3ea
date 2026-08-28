// Focused payment-attempt tests use in-memory database and chain fakes only.
// They never contact Base, PostgreSQL, a wallet, or a deployed market.
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'

const TX = `0x${'ab'.repeat(32)}`
const PAYER = '0x1111111111111111111111111111111111111111'
const TREASURY = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
const BLOCK_HASH = `0x${'cd'.repeat(32)}`

interface AttemptRow {
  id: number
  merchant_id: number
  listing_id: number | null
  tx_hash: string
  fee_request_kind: string
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
  world_draft_id: number | null
  world_offer_id: number | null
  world_seller_handle: string | null
}

let attempt: AttemptRow | null = null
let chainState: 'payment_pending' | 'unavailable' | 'verified' = 'payment_pending'
let chainBlockTime = new Date('2026-08-27T11:30:00.000Z')
const checkedWindows: Date[] = []
let reviewWriteError = false
let reviewWriteNoop = false

const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const query = strings.join('?')
  if (query.includes('listing-fee-attempt:read')) return attempt ? [{ ...attempt }] : []
  if (query.includes('listing-fee-attempt:reserve')) {
    if (!attempt) {
      attempt = {
        id: 91,
        merchant_id: Number(values[0]),
        listing_id: null,
        tx_hash: String(values[3]),
        fee_request_kind: String(values[1]),
        fee_request_hash: String(values[2]),
        payer_wallet: String(values[4]),
        payee_wallet: TREASURY,
        asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        minimum_block_time: String(values[8]),
        maximum_block_time: String(values[9]),
        payment_status: 'payment_pending',
        finalized_block_number: null,
        finalized_block_hash: null,
        finalized_block_time: null,
        finalized_at: null,
        payment_review_reason: null,
        world_draft_id: null,
        world_offer_id: null,
        world_seller_handle: null,
      }
    }
    return [{ ...attempt }]
  }
  if (query.includes('listing-fee-attempt:review')) {
    if (reviewWriteError) throw new Error('listing fee review write unavailable')
    if (reviewWriteNoop) return []
    if (attempt?.payment_status === 'payment_pending') {
      attempt = {
        ...attempt,
        payment_status: 'needs_review',
        payment_review_reason: String(values[0]),
        finalized_block_number: values[1] == null ? null : String(values[1]),
        finalized_block_hash: values[2] == null ? null : String(values[2]),
        finalized_block_time: values[3] == null ? null : String(values[3]),
        finalized_at: values[4] == null ? null : String(values[4]),
      }
    }
    return attempt ? [{ ...attempt }] : []
  }
  throw new Error(`unhandled query: ${query}`)
}

mock.module(new URL('../src/db.ts', import.meta.url).href, {
  namedExports: { sql, logEvent: async () => undefined },
})
mock.module(new URL('../src/pay.ts', import.meta.url).href, {
  namedExports: {
    LISTING_FEE_USDC: 1,
    TREASURY,
    canonicalTxHash: (value: unknown) => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value)
      ? value.toLowerCase()
      : null,
    verifyDirectPayment: async (
      _txHash: string,
      _to: string,
      _amount: number,
      notBefore: Date,
    ) => {
      checkedWindows.push(notBefore)
      if (chainState === 'unavailable') {
        return {
          status: 'unavailable',
          reason: 'the market could not check this payment on Base; retry the same proof later',
        }
      }
      return chainState === 'payment_pending'
        ? { status: 'payment_pending', from: PAYER, amount: '1.000000' }
        : {
            status: 'verified',
            from: PAYER,
            amount: '1.000000',
            blockTime: chainBlockTime,
            blockNumber: 256n,
            blockHash: BLOCK_HASH,
            finalizedAt: new Date('2026-08-27T14:00:00.000Z'),
          }
    },
  },
})

const { resolveListingFeePayment } = await import('../src/listing-fee-payment.ts')

test('a listing fee keeps its first one-hour window when finality arrives later', async () => {
  attempt = null
  chainState = 'payment_pending'
  chainBlockTime = new Date('2026-08-27T11:30:00.000Z')
  checkedWindows.length = 0
  const firstStartedAt = new Date('2026-08-27T12:00:00.000Z')
  const request = {
    merchantId: 7,
    requestKind: 'artifact_listing' as const,
    requestHash: 'ef'.repeat(32),
    txHash: TX,
    payerWallet: PAYER,
    requestStartedAt: firstStartedAt,
  }

  const waiting = await resolveListingFeePayment(request)
  assert.equal(waiting.state, 'response')
  assert.equal(waiting.state === 'response' && waiting.status, 202)
  assert.equal(waiting.state === 'response' && waiting.body.do_not_pay_again, true)
  assert.equal((attempt as AttemptRow | null)?.payment_status, 'payment_pending')
  assert.equal((attempt as AttemptRow | null)?.minimum_block_time, '2026-08-27T11:00:00.000Z')
  assert.equal((attempt as AttemptRow | null)?.maximum_block_time, '2026-08-27T12:00:00.000Z')

  chainState = 'verified'
  const finalized = await resolveListingFeePayment({
    ...request,
    requestStartedAt: new Date('2026-08-27T14:00:00.000Z'),
  })
  assert.equal(finalized.state, 'verified')
  assert.deepEqual(checkedWindows.map(value => value.toISOString()), [
    '2026-08-27T11:00:00.000Z',
    '2026-08-27T11:00:00.000Z',
  ])
  assert.equal(finalized.state === 'verified' && finalized.attemptId, 91)
  assert.equal(finalized.state === 'verified' && finalized.finality.blockHash, BLOCK_HASH)
})

test('a finalized fee after the first request boundary is preserved for review', async () => {
  attempt = null
  reviewWriteError = false
  reviewWriteNoop = false
  chainState = 'verified'
  chainBlockTime = new Date('2026-08-27T12:00:01.000Z')
  checkedWindows.length = 0

  const result = await resolveListingFeePayment({
    merchantId: 7,
    requestKind: 'artifact_listing',
    requestHash: '12'.repeat(32),
    txHash: TX,
    payerWallet: PAYER,
    requestStartedAt: new Date('2026-08-27T12:00:00.000Z'),
  })

  assert.equal(result.state, 'response')
  assert.equal(result.state === 'response' && result.status, 409)
  assert.equal(result.state === 'response' && result.body.do_not_pay_again, true)
  assert.equal((attempt as AttemptRow | null)?.payment_status, 'needs_review')
  assert.equal((attempt as AttemptRow | null)?.finalized_block_number, '256')
  assert.equal((attempt as AttemptRow | null)?.finalized_block_hash, BLOCK_HASH)
  assert.equal((attempt as AttemptRow | null)?.finalized_block_time, chainBlockTime.toISOString())
  assert.equal((attempt as AttemptRow | null)?.finalized_at, '2026-08-27T14:00:00.000Z')
})

for (const mode of ['throws', 'returns no confirmed state'] as const) {
  test(`a fee review that ${mode} keeps the same-payment no-pay instruction`, async () => {
    attempt = null
    reviewWriteError = mode === 'throws'
    reviewWriteNoop = mode === 'returns no confirmed state'
    chainState = 'verified'
    chainBlockTime = new Date('2026-08-27T12:00:01.000Z')
    const originalConsoleError = console.error
    console.error = () => undefined
    try {
      const result = await resolveListingFeePayment({
        merchantId: 7,
        requestKind: 'artifact_listing',
        requestHash: '56'.repeat(32),
        txHash: TX,
        payerWallet: PAYER,
        requestStartedAt: new Date('2026-08-27T12:00:00.000Z'),
      })
      assert.equal(result.state, 'response')
      assert.equal(result.state === 'response' && result.status, 503)
      assert.deepEqual(result.state === 'response' && result.body, {
        error: 'the market could not confirm this fee review; retry the same listing request and transaction; do not pay again',
        retry: 'retry the same listing request with the same fee transaction',
        do_not_pay_again: true,
      })
    } finally {
      console.error = originalConsoleError
      reviewWriteError = false
      reviewWriteNoop = false
    }
  })
}

test('an unavailable first chain read still anchors the original fee window', async () => {
  attempt = null
  chainState = 'unavailable'
  chainBlockTime = new Date('2026-08-27T11:30:00.000Z')
  checkedWindows.length = 0
  const request = {
    merchantId: 7,
    requestKind: 'artifact_listing' as const,
    requestHash: '34'.repeat(32),
    txHash: TX,
    payerWallet: PAYER,
    requestStartedAt: new Date('2026-08-27T12:00:00.000Z'),
  }

  const unavailable = await resolveListingFeePayment(request)
  assert.equal(unavailable.state, 'response')
  assert.equal(unavailable.state === 'response' && unavailable.status, 503)
  assert.equal(unavailable.state === 'response' && unavailable.body.do_not_pay_again, true)
  assert.equal((attempt as AttemptRow | null)?.payment_status, 'payment_pending')
  assert.equal((attempt as AttemptRow | null)?.minimum_block_time, '2026-08-27T11:00:00.000Z')
  assert.equal((attempt as AttemptRow | null)?.maximum_block_time, '2026-08-27T12:00:00.000Z')

  chainState = 'verified'
  const retried = await resolveListingFeePayment({
    ...request,
    requestStartedAt: new Date('2026-08-27T14:00:00.000Z'),
  })
  assert.equal(retried.state, 'verified')
  assert.deepEqual(checkedWindows.map(value => value.toISOString()), [
    '2026-08-27T11:00:00.000Z',
    '2026-08-27T11:00:00.000Z',
  ])
})
