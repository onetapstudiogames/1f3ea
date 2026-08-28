// Focused x402 orchestration tests use in-memory collaborators only. They never
// contact PayAI, Base, PostgreSQL, a wallet, or a deployed market.
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { x402ProofDigest } from '../src/x402-proof.ts'

process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const PAYEE = '0x2222222222222222222222222222222222222222'
const PAYER = '0x1111111111111111111111111111111111111111'
const TX_HASH = `0x${'ab'.repeat(32)}`
const OPERATION_KEY = 'listing-fee:merchant:7:request:' + 'cd'.repeat(32)
const AUTHORIZATION_NONCE = `0x${'44'.repeat(32)}`
const PAYMENT_HEADER = Buffer.from(JSON.stringify({
  x402Version: 1,
  scheme: 'exact',
  network: 'base',
  payload: {
    signature: `0x${'99'.repeat(65)}`,
    authorization: {
      from: PAYER,
      to: PAYEE,
      value: '1000000',
      validAfter: '0',
      validBefore: '1788000000',
      nonce: AUTHORIZATION_NONCE,
    },
  },
})).toString('base64')
const PROOF_DIGEST = x402ProofDigest(PAYMENT_HEADER)

type AttemptStatus = 'settling' | 'settled' | 'verified' | 'needs_review'
type Attempt = {
  operation_key: string
  operation_kind: 'listing_fee'
  proof_digest: string
  requirements_digest: string
  network: 'base'
  asset: string
  payee_wallet: string
  amount_units: string
  resource: string
  status: AttemptStatus
  tx_hash: string | null
  payer_wallet: string
  authorization_nonce: string
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

const events: string[] = []
let storedAttempt: Attempt | null = null
let beginDisposition: 'created' | 'existing' = 'created'
let beginError: Error | null = null
let finalityError: Error | null = null
let finalityNoop = false
let currentHead: bigint | null = 100n
let transferState: Record<string, unknown> = {
  state: 'matched',
  from: PAYER,
  to: PAYEE,
  amount: 1_000_000n,
  blockTime: new Date('2026-08-28T12:00:00.000Z'),
  blockNumber: 101n,
  blockHash: `0x${'77'.repeat(32)}`,
  finalizedAt: new Date('2026-08-28T12:01:00.000Z'),
}

function attempt(status: AttemptStatus, txHash: string | null = null): Attempt {
  const now = '2026-08-28T12:00:00.000Z'
  return {
    operation_key: OPERATION_KEY,
    operation_kind: 'listing_fee',
    proof_digest: PROOF_DIGEST,
    requirements_digest: '12'.repeat(32),
    network: 'base',
    asset: USDC,
    payee_wallet: PAYEE,
    amount_units: '1000000',
    resource: 'https://1f3ea.com/api/listing',
    status,
    tx_hash: txHash,
    payer_wallet: PAYER,
    authorization_nonce: AUTHORIZATION_NONCE,
    review_reason: status === 'needs_review' ? 'settlement result was uncertain' : null,
    operation_started_at: '2026-08-28T11:59:59.000Z',
    settlement_started_at: now,
    settled_at: status === 'settled' ? now : null,
    finalized_block_number: null,
    finalized_block_hash: null,
    finalized_block_time: null,
    finalized_at: null,
    created_at: now,
    updated_at: now,
  }
}

class X402PaymentAttemptConflictError extends Error {}

mock.module(new URL('../src/chain.ts', import.meta.url).href, {
  namedExports: {
    NETWORK: 'base',
    USDC,
    currentBaseBlockNumber: async () => {
      events.push('head')
      return currentHead
    },
    toUnits: (usdc: number) => BigInt(Math.round(usdc * 1_000_000)),
    classifyUsdcTransfer: async (
      txHash: string,
      payee: string,
      amount: bigint,
      options: { expectedFrom?: string; exactAmount?: boolean },
    ) => {
      events.push('classify')
      assert.equal(txHash, TX_HASH)
      assert.equal(payee, PAYEE)
      assert.equal(amount, 1_000_000n)
      assert.deepEqual(options, {
        expectedFrom: PAYER,
        exactAmount: true,
        expectedAuthorizationNonce: AUTHORIZATION_NONCE,
      })
      return transferState
    },
  },
})

mock.module(new URL('../src/x402-payment-attempts.ts', import.meta.url).href, {
  namedExports: {
    X402PaymentAttemptConflictError,
    beginX402Settlement: async (input: { operationStartedAt: Date; startBlock: bigint }) => {
      events.push('begin')
      if (beginError) throw beginError
      assert.deepEqual(input.operationStartedAt, new Date('2026-08-28T11:59:59.000Z'))
      assert.equal(input.startBlock, 100n)
      storedAttempt ??= attempt('settling')
      return { disposition: beginDisposition, attempt: { ...storedAttempt } }
    },
    markX402SettlementNeedsReview: async (input: { reason: string }) => {
      events.push('review')
      assert.ok(storedAttempt)
      storedAttempt = {
        ...storedAttempt,
        status: 'needs_review',
        review_reason: input.reason,
      }
      return { ...storedAttempt }
    },
    readX402PaymentAttempt: async (operationKey: string) => {
      events.push('read')
      assert.equal(operationKey, OPERATION_KEY)
      return storedAttempt == null ? null : { ...storedAttempt }
    },
    recordX402Settlement: async (input: { transaction: string; payerWallet: string }) => {
      events.push('record')
      assert.equal(input.transaction, TX_HASH)
      assert.equal(input.payerWallet, PAYER)
      assert.ok(storedAttempt)
      storedAttempt = {
        ...storedAttempt,
        status: 'settled',
        tx_hash: TX_HASH,
        settled_at: '2026-08-28T12:00:01.000Z',
      }
      return { ...storedAttempt }
    },
    recordX402Finality: async (input: {
      outcome: 'verified' | 'needs_review'
      reason?: string
      blockNumber: bigint
      blockHash: string
      blockTime: Date
      finalizedAt: Date
    }) => {
      events.push('finality')
      if (finalityError) throw finalityError
      assert.ok(storedAttempt)
      if (finalityNoop) return { ...storedAttempt }
      storedAttempt = {
        ...storedAttempt,
        status: input.outcome,
        review_reason: input.outcome === 'needs_review' ? input.reason ?? null : null,
        finalized_block_number: input.blockNumber.toString(),
        finalized_block_hash: input.blockHash,
        finalized_block_time: input.blockTime.toISOString(),
        finalized_at: input.finalizedAt.toISOString(),
      }
      return { ...storedAttempt }
    },
    x402PaymentRetryInstruction: () => ({
      retry: 'retry this same request with the same X-PAYMENT proof',
      do_not_pay_again: true as const,
    }),
    x402PaymentAttemptMatches: () => true,
  },
})

const fetchSteps: Array<(path: string) => Response | Promise<Response>> = []
globalThis.fetch = (async (input: string | URL | Request) => {
  const path = String(input)
  events.push(path.endsWith('/verify') ? 'verify' : 'settle')
  const step = fetchSteps.shift()
  assert.ok(step, `unexpected facilitator call to ${path}`)
  return step(path)
}) as typeof fetch

const {
  requirements,
  resumeX402Payment,
  settleX402,
} = await import('../src/pay.ts')

const reqs = requirements(PAYEE, 1, 'https://1f3ea.com/api/listing', 'listing fee')
const operation = {
  operationKey: OPERATION_KEY,
  operationKind: 'listing_fee' as const,
  operationStartedAt: new Date('2026-08-28T11:59:59.000Z'),
}
const json = (body: unknown) => () => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
})

function reset(): void {
  events.length = 0
  fetchSteps.length = 0
  storedAttempt = null
  beginDisposition = 'created'
  beginError = null
  finalityError = null
  finalityNoop = false
  currentHead = 100n
  transferState = {
    state: 'matched',
    from: PAYER,
    to: PAYEE,
    amount: 1_000_000n,
    blockTime: new Date('2026-08-28T12:00:00.000Z'),
    blockNumber: 101n,
    blockHash: `0x${'77'.repeat(32)}`,
    finalizedAt: new Date('2026-08-28T12:01:00.000Z'),
  }
}

test('x402 settlement cannot bypass durable custody when operation context is omitted', async () => {
  reset()

  const callWithoutOperation = settleX402 as unknown as (
    paymentHeader: string,
    requirements: typeof reqs,
  ) => Promise<unknown>

  await assert.rejects(
    callWithoutOperation(PAYMENT_HEADER, reqs),
    /payment operation context is required/i,
  )
  assert.deepEqual(events, [])
})

test('durable x402 reserves after verify and unlocks only after exact finalized Base transfer', async () => {
  reset()
  fetchSteps.push(json({ isValid: true }), json({ success: true, transaction: TX_HASH, payer: PAYER }))

  const result = await settleX402(PAYMENT_HEADER, reqs, operation)

  assert.equal(result.status, 'verified')
  if (result.status === 'verified') {
    assert.equal(result.transaction, TX_HASH)
    assert.equal(result.payer, PAYER)
  }
  assert.deepEqual(events, ['read', 'head', 'verify', 'begin', 'settle', 'record', 'classify', 'finality'])
})

test('an unavailable Base head stops before facilitator verification or durable settlement', async () => {
  reset()
  currentHead = null

  const result = await settleX402(PAYMENT_HEADER, reqs, operation)

  assert.equal(result.status, 'unavailable')
  if (result.status === 'unavailable') {
    assert.match(result.reason, /anchor.*Base block.*payment did not start/iu)
    assert.match(result.retry, /same X-PAYMENT proof/iu)
  }
  assert.deepEqual(events, ['read', 'head'])
  assert.equal(fetchSteps.length, 0)
  assert.equal(storedAttempt, null)
})

test('an existing attempt never settles again and headerless resume rechecks finality', async () => {
  reset()
  storedAttempt = attempt('settled', TX_HASH)
  beginDisposition = 'existing'
  const retried = await settleX402(PAYMENT_HEADER, reqs, operation)
  assert.equal(retried.status, 'verified')
  assert.deepEqual(events, ['read', 'classify', 'finality'])

  events.length = 0
  const resumed = await resumeX402Payment(OPERATION_KEY)
  assert.ok(resumed)
  assert.equal(resumed.status, 'verified')
  assert.deepEqual(events, ['read'])
})

test('settlement uncertainty is durably reviewed and never invites another payment', async () => {
  reset()
  fetchSteps.push(json({ isValid: true }), () => { throw new Error('private timeout detail') })

  const result = await settleX402(PAYMENT_HEADER, reqs, operation)

  assert.equal(result.status, 'needs_review')
  if (result.status === 'needs_review') {
    assert.equal(result.do_not_pay_again, true)
    assert.match(result.retry, /same request.*same X-PAYMENT proof/i)
    assert.doesNotMatch(result.reason, /private timeout detail/i)
  }
  assert.equal(storedAttempt?.status, 'needs_review')
  assert.deepEqual(events, ['read', 'head', 'verify', 'begin', 'settle', 'review'])
})

test('facilitator success is recorded but pending or mismatched chain evidence never unlocks', async () => {
  for (const [state, expectedStatus] of [
    [{ state: 'matched_pending', from: PAYER, to: PAYEE, amount: 1_000_000n }, 'unavailable'],
    [{
      state: 'invalid_final',
      reason: 'confirmed_mismatch',
      blockTime: new Date('2026-08-28T12:00:00.000Z'),
      blockNumber: 101n,
      blockHash: `0x${'77'.repeat(32)}`,
      finalizedAt: new Date('2026-08-28T12:01:00.000Z'),
    }, 'needs_review'],
  ] as const) {
    reset()
    transferState = state
    fetchSteps.push(json({ isValid: true }), json({ success: true, transaction: TX_HASH, payer: PAYER }))

    const result = await settleX402(PAYMENT_HEADER, reqs, operation)

    assert.equal(result.status, expectedStatus)
    assert.notEqual(result.status, 'verified')
    if (
      result.status === 'unavailable'
      || result.status === 'needs_review'
      || result.status === 'conflict'
    ) {
      assert.equal(result.do_not_pay_again, true)
      assert.match(result.retry, /same request.*same X-PAYMENT proof/i)
    } else {
      assert.fail(`expected a no-pay result, received ${result.status}`)
    }
    assert.equal(storedAttempt?.tx_hash, TX_HASH)
    assert.deepEqual(events, [
      'read', 'head', 'verify', 'begin', 'settle', 'record', 'classify',
      ...(state.state === 'invalid_final' ? ['finality'] : []),
    ])
  }
})

test('a failed or no-op finality write never unlocks a matched transfer', async () => {
  for (const mode of ['error', 'noop'] as const) {
    reset()
    if (mode === 'error') finalityError = new Error('private database detail')
    else finalityNoop = true
    fetchSteps.push(json({ isValid: true }), json({ success: true, transaction: TX_HASH, payer: PAYER }))

    const result = await settleX402(PAYMENT_HEADER, reqs, operation)

    assert.equal(result.status, 'unavailable', mode)
    if (result.status === 'unavailable') {
      assert.equal(result.do_not_pay_again, true)
      assert.doesNotMatch(result.reason, /private database detail/i)
    }
    assert.notEqual(storedAttempt?.status, 'verified')
    assert.deepEqual(events, ['read', 'head', 'verify', 'begin', 'settle', 'record', 'classify', 'finality'])
  }
})

test('a changed proof or payment terms after custody is a conflict and never settles', async () => {
  reset()
  beginError = new X402PaymentAttemptConflictError('engine wording must not escape')
  fetchSteps.push(json({ isValid: true }))

  const result = await settleX402(PAYMENT_HEADER, reqs, operation)

  assert.equal(result.status, 'conflict')
  if (result.status === 'conflict') {
    assert.equal(result.do_not_pay_again, true)
    assert.match(result.reason, /already bound.*original request.*proof/i)
    assert.doesNotMatch(result.reason, /engine wording/i)
  }
  assert.deepEqual(events, ['read', 'head', 'verify', 'begin'])
})

test('an attempt with no transaction stays in manual review on headerless retry', async () => {
  reset()
  storedAttempt = attempt('settling')

  const result = await resumeX402Payment(OPERATION_KEY)

  assert.ok(result)
  assert.equal(result.status, 'needs_review')
  if (result.status === 'needs_review') {
    assert.equal(result.do_not_pay_again, true)
    assert.match(result.reason, /settlement outcome.*manual review/i)
  }
  assert.deepEqual(events, ['read', 'review'])
})
