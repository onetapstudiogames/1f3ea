// Payment failure tests use a local fetch queue only. They never contact the
// facilitator, Base, a wallet, a database, or a live deployment.
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'

process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'

type FetchStep = (init?: RequestInit) => Response | Promise<Response>
const steps: FetchStep[] = []
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const PAYEE = process.env.TREASURY_ADDRESS
const NONCE = `0x${'44'.repeat(32)}`
const OPERATION = {
  operationKey: 'listing-fee:failure-tests:request:' + 'cd'.repeat(32),
  operationKind: 'listing_fee' as const,
  operationStartedAt: new Date('2026-08-28T11:59:59.000Z'),
}

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
  status: 'settling' | 'settled' | 'verified' | 'needs_review'
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

let activeAttempt: Attempt | null = null

class X402PaymentAttemptConflictError extends Error {}

mock.module(new URL('../src/chain.ts', import.meta.url).href, {
  namedExports: {
    NETWORK: 'base',
    USDC,
    currentBaseBlockNumber: async () => 100n,
    toUnits: (usdc: number) => BigInt(Math.round(usdc * 1_000_000)),
    classifyUsdcTransfer: async (
      _txHash: string,
      payee: string,
      amount: bigint,
      options: { expectedFrom?: string; expectedAuthorizationNonce?: string },
    ) => ({
      state: 'matched',
      from: options.expectedFrom,
      to: payee,
      amount,
      blockTime: new Date('2026-08-28T12:00:00.000Z'),
      blockNumber: 101n,
      blockHash: `0x${'77'.repeat(32)}`,
      finalizedAt: new Date('2026-08-28T12:01:00.000Z'),
    }),
  },
})

mock.module(new URL('../src/x402-payment-attempts.ts', import.meta.url).href, {
  namedExports: {
    X402PaymentAttemptConflictError,
    beginX402Settlement: async (input: {
      operationKey: string
      operationStartedAt: Date
      requirements: { asset: string; payTo: string; maxAmountRequired: string; resource: string }
    }) => {
      const now = '2026-08-28T12:00:00.000Z'
      assert.deepEqual(input.operationStartedAt, OPERATION.operationStartedAt)
      activeAttempt = {
        operation_key: input.operationKey,
        operation_kind: 'listing_fee',
        proof_digest: 'ef'.repeat(32),
        requirements_digest: '12'.repeat(32),
        network: 'base',
        asset: input.requirements.asset.toLowerCase(),
        payee_wallet: input.requirements.payTo.toLowerCase(),
        amount_units: input.requirements.maxAmountRequired,
        resource: input.requirements.resource,
        status: 'settling',
        tx_hash: null,
        payer_wallet: PAYER,
        authorization_nonce: NONCE,
        review_reason: null,
        operation_started_at: input.operationStartedAt.toISOString(),
        settlement_started_at: now,
        settled_at: null,
        finalized_block_number: null,
        finalized_block_hash: null,
        finalized_block_time: null,
        finalized_at: null,
        created_at: now,
        updated_at: now,
      }
      return { disposition: 'created' as const, attempt: { ...activeAttempt } }
    },
    markX402SettlementNeedsReview: async (input: { reason: string }) => {
      assert.ok(activeAttempt)
      activeAttempt = {
        ...activeAttempt,
        status: 'needs_review',
        review_reason: input.reason,
      }
      return { ...activeAttempt }
    },
    readX402PaymentAttempt: async () => null,
    recordX402Settlement: async (input: { transaction: string }) => {
      assert.ok(activeAttempt)
      activeAttempt = {
        ...activeAttempt,
        status: 'settled',
        tx_hash: input.transaction,
        settled_at: '2026-08-28T12:00:01.000Z',
      }
      return { ...activeAttempt }
    },
    recordX402Finality: async (input: {
      outcome: 'verified' | 'needs_review'
      reason?: string
      blockNumber: bigint
      blockHash: string
      blockTime: Date
      finalizedAt: Date
    }) => {
      assert.ok(activeAttempt)
      activeAttempt = {
        ...activeAttempt,
        status: input.outcome,
        review_reason: input.outcome === 'needs_review' ? input.reason ?? null : null,
        finalized_block_number: input.blockNumber.toString(),
        finalized_block_hash: input.blockHash,
        finalized_block_time: input.blockTime.toISOString(),
        finalized_at: input.finalizedAt.toISOString(),
      }
      return { ...activeAttempt }
    },
    x402PaymentRetryInstruction: () => ({
      retry: 'retry this same request with the same X-PAYMENT proof',
      do_not_pay_again: true as const,
    }),
    x402PaymentAttemptMatches: () => true,
  },
})

globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
  const step = steps.shift()
  assert.ok(step, 'unexpected facilitator call')
  return step(init)
}) as typeof fetch

const {
  canonicalTxHash,
  requirements,
  settleX402: settleX402WithCustody,
} = await import('../src/pay.ts')

const TX = `0x${'ab'.repeat(32)}`
const PAYER = '0x1111111111111111111111111111111111111111'
const reqs = requirements(PAYEE, 1, '/api/listing', 'listing fee')
const settleX402 = (paymentHeader: string, paymentRequirements: typeof reqs) =>
  settleX402WithCustody(paymentHeader, paymentRequirements, OPERATION)
const TERMINAL_UNCLASSIFIED = 'payment facilitator rejected this X-PAYMENT as terminal but did not publish a ' +
  'recognized caller-correctable cause; do not retry or replay this proof blindly'
const payload = (value: unknown = {
  x402Version: 1,
  scheme: 'exact',
  network: 'base',
  payload: {
    signature: `0x${'99'.repeat(65)}`,
    authorization: {
      from: PAYER, to: PAYEE, value: '1000000', validAfter: '0',
      validBefore: '1788000000', nonce: NONCE,
    },
  },
}) =>
  Buffer.from(JSON.stringify(value)).toString('base64')
const json = (value: unknown, status = 200) => () => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
})
const invalidJson = (status = 200) => () => new Response('not json', { status })

function queue(...next: FetchStep[]) {
  assert.equal(steps.length, 0)
  steps.push(...next)
}

function assertVerificationRetry(
  result: Awaited<ReturnType<typeof settleX402>>,
  reason: RegExp,
): void {
  assert.equal(result.status, 'unavailable')
  if (result.status !== 'unavailable') return
  assert.match(result.reason, reason)
  assert.equal(result.do_not_pay_again, true)
  assert.match(result.retry, /same request.*same X-PAYMENT proof/i)
}

function assertSettlementReview(
  result: Awaited<ReturnType<typeof settleX402>>,
): void {
  assert.deepEqual(result, {
    status: 'needs_review',
    reason: 'the payment facilitator did not conclusively confirm settlement; this payment needs manual review',
    retry: 'retry this same request with the same X-PAYMENT proof',
    do_not_pay_again: true,
  })
}

test('x402 separates malformed caller proofs from unavailable verification upstreams', async () => {
  assert.deepEqual(await settleX402('%%%', reqs), {
    status: 'invalid',
    reason: 'X-PAYMENT header is not valid base64 JSON',
  })

  queue(invalidJson(503))
  assertVerificationRetry(
    await settleX402(payload(), reqs),
    /facilitator verification is unavailable.*same X-PAYMENT proof/i,
  )

  queue(json({ isValid: false, invalidReason: 'signature rejected' }))
  assert.deepEqual(await settleX402(payload(), reqs), {
    status: 'unclassified',
    reason: TERMINAL_UNCLASSIFIED,
  })

  queue(json({ isValid: false, invalidReason: 'invalid_payload' }, 400))
  assert.deepEqual(await settleX402(payload(), reqs), {
    status: 'invalid',
    reason: 'X-PAYMENT payload is malformed or missing required fields',
  })

  queue(json({ isValid: false, invalidReason: 'invalid_payload' }, 402))
  assert.deepEqual(await settleX402(payload(), reqs), {
    status: 'invalid',
    reason: 'X-PAYMENT payload is malformed or missing required fields',
  })

  queue(json({ isValid: false, invalidReason: 'new_unknown_verify_reason' }, 402))
  assert.deepEqual(await settleX402(payload(), reqs), {
    status: 'unclassified',
    reason: TERMINAL_UNCLASSIFIED,
  })

  queue(json({ isValid: false, invalidReason: 'invalid_payment_requirements' }, 402))
  assert.deepEqual(await settleX402(payload(), reqs), {
    status: 'unclassified',
    reason: 'payment facilitator rejected this X-PAYMENT as terminal: invalid payment requirements; ' +
      'do not retry or replay this proof blindly',
  })

  for (const status of [408, 429]) {
    queue(json({ isValid: false, invalidReason: 'invalid_payload' }, status))
    const retryable = await settleX402(payload(), reqs)
    assert.equal(retryable.status, 'unavailable', String(status))
    assert.match(retryable.reason, /facilitator.*(?:timed out|rate-limited).*retry.*same X-PAYMENT proof/i,
      String(status))
    assert.doesNotMatch(retryable.reason, /payload is malformed/i, String(status))
  }

  for (const status of [401, 422]) {
    queue(json({ isValid: false, invalidReason: 'invalid_payload' }, status))
    const ambiguousStatus = await settleX402(payload(), reqs)
    assert.equal(ambiguousStatus.status, 'unclassified', String(status))
    assert.match(ambiguousStatus.reason, /facilitator rejected the verification request/i, String(status))
    assert.match(ambiguousStatus.reason,
      /X-PAYMENT proof, the market's payment requirements, or facilitator request handling/i, String(status))
  }

  queue(json({ isValid: false, invalidReason: 'unexpected_verify_error' }))
  assertVerificationRetry(
    await settleX402(payload(), reqs),
    /could not verify X-PAYMENT: unexpected verify error.*same X-PAYMENT proof/i,
  )

  queue(json({ isValid: false, invalidReason: 'new_unknown_verify_reason' }))
  assert.deepEqual(await settleX402(payload(), reqs), {
    status: 'unclassified',
    reason: TERMINAL_UNCLASSIFIED,
  })

  queue(json({ isValid: false, invalidReason: 'constructor' }))
  assert.deepEqual(await settleX402(payload(), reqs), {
    status: 'unclassified',
    reason: TERMINAL_UNCLASSIFIED,
  })

  queue(json({ error: 'invalid_payment_requirements' }, 400))
  const knownRejected = await settleX402(payload(), reqs)
  assert.equal(knownRejected.status, 'unclassified')
  assert.match(knownRejected.reason, /facilitator rejected the verification request.*invalid payment requirements/i)
  assert.match(knownRejected.reason,
    /X-PAYMENT proof, the market's payment requirements, or facilitator request handling/i)

  for (const privateDetail of [
    'payload or requirements rejected',
    'SQLSTATE 23505 at payment-db.internal:5432',
  ]) {
    queue(json({ message: privateDetail }, 400))
    const result = await settleX402(payload(), reqs)
    assert.equal(result.status, 'unclassified')
    assert.match(result.reason, /facilitator rejected the verification request/i)
    assert.match(result.reason,
      /X-PAYMENT proof, the market's payment requirements, or facilitator request handling/i)
    assert.doesNotMatch(result.reason, new RegExp(privateDetail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
    assert.doesNotMatch(result.reason, /retry.*same|fresh payment proof/i)
  }

  queue(json({ error: `rejected 1f3ea_sk_${'cd'.repeat(24)}` }, 400))
  const ambiguous = await settleX402(payload(), reqs)
  assert.deepEqual(ambiguous, {
    status: 'unclassified',
    reason: 'payment facilitator rejected the verification request; it did not identify whether the ' +
      "X-PAYMENT proof, the market's payment requirements, or facilitator request handling was at fault",
  })
  assert.doesNotMatch(JSON.stringify(ambiguous), /1f3ea_sk_/i)

  const reflectedSecret = `1f3ea_sk_${'ab'.repeat(24)}`
  queue(json({ isValid: false, invalidReason: `rejected ${reflectedSecret}` }))
  const redacted = await settleX402(payload(), reqs)
  assert.deepEqual(redacted, {
    status: 'unclassified',
    reason: TERMINAL_UNCLASSIFIED,
  })
  assert.doesNotMatch(JSON.stringify(redacted), /1f3ea_sk_/i)

  for (const unreadable of [
    new Response('not json'),
    new Response(JSON.stringify({ unexpected: true })),
  ]) {
    queue(() => unreadable)
    assertVerificationRetry(
      await settleX402(payload(), reqs),
      /unreadable verification response.*same X-PAYMENT proof/i,
    )
  }
})

test('every non-confirmed settlement is durably held for review without another payment', async () => {
  const settlementReplies: Array<{ label: string; step: FetchStep; privateDetail?: string }> = [
    { label: 'unreadable JSON', step: invalidJson() },
    { label: 'unknown terminal cause', step: json({ success: false, errorReason: 'not settled' }) },
    ...[
      'insufficient_funds',
      'invalid_exact_evm_payload_authorization_valid_after',
      'invalid_exact_evm_payload_authorization_valid_before',
      'invalid_exact_evm_payload_authorization_value',
      'invalid_exact_evm_payload_signature',
      'invalid_exact_evm_payload_recipient_mismatch',
      'invalid_network',
      'invalid_payload',
      'invalid_scheme',
      'unsupported_scheme',
      'invalid_x402_version',
      'invalid_transaction_state',
    ].map(errorReason => ({
      label: `HTTP 400 ${errorReason}`,
      step: json({ success: false, errorReason }, 400),
    })),
    { label: 'HTTP 402 caller failure', step: json({ success: false, errorReason: 'invalid_payload' }, 402) },
    {
      label: 'HTTP 402 unknown failure',
      step: json({ success: false, errorReason: 'new_unknown_settlement_error' }, 402),
    },
    {
      label: 'HTTP 402 requirements failure',
      step: json({ success: false, errorReason: 'invalid_payment_requirements' }, 402),
    },
    {
      label: 'HTTP 409 duplicate',
      step: json({ success: false, errorReason: 'duplicate_settlement' }, 409),
    },
    { label: 'HTTP 408', step: json({ success: false, errorReason: 'invalid_payload' }, 408) },
    { label: 'HTTP 429', step: json({ success: false, errorReason: 'invalid_payload' }, 429) },
    { label: 'HTTP 401', step: json({ success: false, errorReason: 'invalid_payload' }, 401) },
    { label: 'HTTP 422', step: json({ success: false, errorReason: 'invalid_payload' }, 422) },
    {
      label: 'requirements unavailable',
      step: json({ success: false, errorReason: 'invalid_payment_requirements' }),
    },
    {
      label: 'unexpected settle unavailable',
      step: json({ success: false, errorReason: 'unexpected_settle_error' }),
    },
    {
      label: 'unknown settlement error',
      step: json({ success: false, errorReason: 'new_unknown_settlement_error' }),
    },
    { label: 'settlement pending', step: json({ success: false, errorReason: 'settlement_pending' }) },
    { label: 'duplicate settlement', step: json({ success: false, errorReason: 'duplicate_settlement' }) },
    { label: 'transaction failed', step: json({ success: false, errorReason: 'transaction_failed' }) },
    {
      label: 'private upstream 503',
      step: json({ success: false, errorReason: 'private upstream detail' }, 503),
      privateDetail: 'private upstream detail',
    },
    {
      label: 'known rejected request',
      step: json({ errorReason: 'invalid_payment_requirements' }, 400),
    },
    {
      label: 'private rejection detail',
      step: json({ invalidReason: 'SQLSTATE 23505 at payment-db.internal:5432' }, 400),
      privateDetail: 'SQLSTATE 23505 at payment-db.internal:5432',
    },
    { label: 'missing transaction', step: json({ success: true }) },
    { label: 'malformed transaction', step: json({ success: true, transaction: 'not-a-hash' }) },
  ]

  for (const reply of settlementReplies) {
    queue(json({ isValid: true }), reply.step)
    const result = await settleX402(payload(), reqs)
    assertSettlementReview(result)
    assert.equal(activeAttempt?.status, 'needs_review', reply.label)
    if (reply.privateDetail) {
      assert.doesNotMatch(
        JSON.stringify(result),
        new RegExp(reply.privateDetail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
        reply.label,
      )
    }
  }
})

test('x402 reports the payer bound in durable custody, with or without a facilitator payer field', async () => {
  queue(json({ isValid: true }), json({ success: true, transaction: TX, payer: PAYER }))
  const explicit = await settleX402(payload(), reqs)
  assert.equal(explicit.status, 'verified')
  if (explicit.status === 'verified') {
    assert.equal(explicit.transaction, TX)
    assert.equal(explicit.payer, PAYER)
  }

  queue(json({ isValid: true }), json({ success: true, transaction: TX.toUpperCase().replace('0X', '0x') }))
  const fallback = await settleX402(payload(), reqs)
  assert.equal(fallback.status, 'verified')
  if (fallback.status === 'verified') {
    assert.equal(fallback.transaction, TX)
    assert.equal(fallback.payer, PAYER)
  }

})

test('x402 reports verification and settlement network outages without leaking thrown errors', async () => {
  queue(() => { throw new Error('private upstream detail') })
  assertVerificationRetry(
    await settleX402(payload(), reqs),
    /facilitator verification is unavailable.*same X-PAYMENT proof/i,
  )

  queue(json({ isValid: true }), () => { throw new Error('private upstream detail') })
  assertSettlementReview(await settleX402(payload(), reqs))
  assert.equal(canonicalTxHash(7), null)
  assert.equal(steps.length, 0)
})

test('x402 gives each facilitator call an eight-second deadline and blocks redirects', async t => {
  const originalTimeout = AbortSignal.timeout
  const deadlines: number[] = []
  AbortSignal.timeout = ((milliseconds: number) => {
    deadlines.push(milliseconds)
    return AbortSignal.abort()
  }) as typeof AbortSignal.timeout
  t.after(() => { AbortSignal.timeout = originalTimeout })

  const timedOut = (init?: RequestInit) => {
    assert.equal(init?.redirect, 'error')
    assert.equal(init?.signal?.aborted, true)
    throw new DOMException('timed out', 'AbortError')
  }

  queue(timedOut)
  const verification = await settleX402(payload(), reqs)
  assert.equal(verification.status, 'unavailable')
  assert.match(verification.reason, /verification.*same X-PAYMENT proof/i)
  assert.doesNotMatch(verification.reason, /do not pay again/i)

  queue(json({ isValid: true }), timedOut)
  const settlement = await settleX402(payload(), reqs)
  assertSettlementReview(settlement)
  assert.deepEqual(deadlines, [8_000, 8_000, 8_000])
})
