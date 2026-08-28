// Focused durable-settlement tests use an in-memory database fake only.
// They never contact a facilitator, Base, PostgreSQL, or a wallet.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test, { mock } from 'node:test'

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const PAYEE = '0x2222222222222222222222222222222222222222'
const PAYER = '0x1111111111111111111111111111111111111111'
const TX_HASH = `0x${'ab'.repeat(32)}`
const SIGNATURE = `0x${'99'.repeat(65)}`
const PAYMENT_HEADER = Buffer.from(JSON.stringify({
  x402Version: 1,
  scheme: 'exact',
  network: 'base',
  payload: {
    signature: SIGNATURE,
    authorization: {
      from: PAYER,
      to: PAYEE,
      value: '1000000',
      validAfter: '0',
      validBefore: '1788000000',
      nonce: `0x${'44'.repeat(32)}`,
    },
  },
})).toString('base64')
const REORDERED_PAYMENT_HEADER = Buffer.from(JSON.stringify({
  payload: {
    authorization: {
      nonce: `0x${'44'.repeat(32)}`,
      validBefore: '1788000000',
      validAfter: '0',
      value: '1000000',
      to: PAYEE,
      from: PAYER,
    },
    signature: SIGNATURE,
  },
  network: 'base',
  scheme: 'exact',
  x402Version: 1,
})).toString('base64')

type AttemptStatus = 'settling' | 'settled' | 'verified' | 'needs_review'

interface AttemptRow {
  operation_key: string
  operation_kind: 'listing_fee' | 'world_listing_fee' | 'purchase'
  proof_digest: string
  requirements_digest: string
  network: 'base'
  asset: string
  payee_wallet: string
  amount_units: string
  resource: string
  authorization_nonce: string
  authorization_valid_after: string
  authorization_valid_before: string
  start_block: string
  status: AttemptStatus
  tx_hash: string | null
  payer_wallet: string
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

let attempt: AttemptRow | null = null
let insertRace: AttemptRow | null = null
let reviewNoop = false
const sqlCalls: Array<{ query: string; values: unknown[] }> = []

const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const query = strings.join('?')
  sqlCalls.push({ query, values: [...values] })
  if (query.includes('x402-payment-attempt:read')) {
    const [operationKey, proofDigest, payerWallet, nonce] = values.map(String)
    return attempt && (
      attempt.operation_key === operationKey
      || attempt.proof_digest === proofDigest
      || (attempt.payer_wallet === payerWallet && attempt.authorization_nonce === nonce)
    ) ? [{ ...attempt }] : []
  }
  if (query.includes('x402-payment-attempt:reserve')) {
    if (!attempt && insertRace) {
      attempt = { ...insertRace }
      return []
    }
    if (attempt) return []
    const now = '2026-08-28T12:00:01.000Z'
    attempt = {
      operation_key: String(values[0]),
      operation_kind: values[1] as AttemptRow['operation_kind'],
      proof_digest: String(values[2]),
      requirements_digest: String(values[3]),
      network: 'base',
      asset: String(values[4]),
      payee_wallet: String(values[5]),
      amount_units: String(values[6]),
      resource: String(values[7]),
      payer_wallet: String(values[8]),
      authorization_nonce: String(values[9]),
      authorization_valid_after: String(values[10]),
      authorization_valid_before: String(values[11]),
      start_block: String(values[12]),
      status: 'settling',
      tx_hash: null,
      review_reason: null,
      operation_started_at: values[13] instanceof Date
        ? values[13].toISOString()
        : new Date(String(values[13])).toISOString(),
      settlement_started_at: now,
      settled_at: null,
      finalized_block_number: null,
      finalized_block_hash: null,
      finalized_block_time: null,
      finalized_at: null,
      created_at: now,
      updated_at: now,
    }
    return [{ ...attempt }]
  }
  if (query.includes('x402-payment-attempt:review')) {
    if (!reviewNoop && attempt?.status === 'settling') {
      attempt = {
        ...attempt,
        status: 'needs_review',
        review_reason: String(values[2]),
        updated_at: '2026-08-28T12:00:08.000Z',
      }
      return [{ ...attempt }]
    }
    return []
  }
  if (query.includes('x402-payment-attempt:settled')) {
    if (attempt && ['settling', 'needs_review'].includes(attempt.status)) {
      assert.equal(String(values[3]), attempt.payer_wallet)
      attempt = {
        ...attempt,
        status: 'settled',
        tx_hash: String(values[2]),
        review_reason: null,
        settled_at: '2026-08-28T12:00:09.000Z',
        updated_at: '2026-08-28T12:00:09.000Z',
      }
      return [{ ...attempt }]
    }
    return []
  }
  if (query.includes('x402-payment-attempt:finality')) {
    const requestedStatus = String(values[3]) as 'verified' | 'needs_review'
    const blockTime = new Date(String(values[6]))
    const finalizedAt = new Date(String(values[7]))
    if (
      attempt?.status === 'settled'
      && attempt.tx_hash === String(values[2])
      && finalizedAt >= blockTime
    ) {
      attempt = {
        ...attempt,
        status: requestedStatus,
        finalized_block_number: String(values[4]),
        finalized_block_hash: String(values[5]),
        finalized_block_time: blockTime.toISOString(),
        finalized_at: finalizedAt.toISOString(),
        review_reason: values[8] == null ? null : String(values[8]),
        updated_at: '2026-08-28T13:00:00.000Z',
      }
      return [{ ...attempt }]
    }
    return []
  }
  throw new Error(`unhandled query: ${query}`)
}

mock.module(new URL('../src/db.ts', import.meta.url).href, {
  namedExports: { sql, logEvent: async () => undefined },
})

const {
  X402PaymentAttemptConflictError,
  beginX402Settlement,
  markX402SettlementNeedsReview,
  readX402PaymentAttempt,
  recordX402Finality,
  recordX402Settlement,
  x402PaymentAttemptMatches,
  x402PaymentRetryInstruction,
  x402ProofDigest,
} = await import('../src/x402-payment-attempts.ts')

function input(overrides: Partial<Parameters<typeof beginX402Settlement>[0]> = {}) {
  return {
    operationKey: 'listing-fee:merchant:7:request:' + 'ef'.repeat(32),
    operationKind: 'listing_fee' as const,
    startBlock: 123n,
    operationStartedAt: new Date('2026-08-28T12:00:00.000Z'),
    paymentHeader: PAYMENT_HEADER,
    requirements: {
      network: 'base' as const,
      asset: USDC,
      payTo: PAYEE,
      maxAmountRequired: '1000000',
      resource: 'https://1f3ea.com/api/listings',
    },
    ...overrides,
  }
}

function paymentHeaderWithAuthorization(
  overrides: Partial<Record<'validAfter' | 'validBefore', unknown>>,
): string {
  const decoded = JSON.parse(Buffer.from(PAYMENT_HEADER, 'base64').toString('utf8')) as {
    payload: { authorization: Record<string, unknown> }
  }
  return Buffer.from(JSON.stringify({
    ...decoded,
    payload: {
      ...decoded.payload,
      authorization: { ...decoded.payload.authorization, ...overrides },
    },
  })).toString('base64')
}

function reset(): void {
  attempt = null
  insertRace = null
  reviewNoop = false
  sqlCalls.length = 0
}

test('begin stores one immutable operation/proof fingerprint before settlement', async () => {
  reset()

  const result = await beginX402Settlement(input())

  assert.equal(result.disposition, 'created')
  assert.equal(result.attempt.status, 'settling')
  assert.equal(result.attempt.proof_digest, x402ProofDigest(PAYMENT_HEADER))
  assert.equal(result.attempt.payee_wallet, PAYEE)
  assert.equal(result.attempt.payer_wallet, PAYER)
  assert.equal(result.attempt.authorization_nonce, `0x${'44'.repeat(32)}`)
  assert.equal(result.attempt.authorization_valid_after, '0')
  assert.equal(result.attempt.authorization_valid_before, '1788000000')
  assert.equal(result.attempt.start_block, '123')
  assert.equal(result.attempt.amount_units, '1000000')
  assert.equal(result.attempt.operation_started_at, '2026-08-28T12:00:00.000Z')
  assert.equal(result.attempt.settlement_started_at, '2026-08-28T12:00:01.000Z')
  assert.match(sqlCalls[0]?.query ?? '', /x402-payment-attempt:read/iu)
  assert.match(sqlCalls[1]?.query ?? '', /x402-payment-attempt:reserve/iu)
  assert.match(
    sqlCalls[1]?.query ?? '',
    /GREATEST\(statement_timestamp\(\),\s*\?\)/u,
    'database clock skew must not make settlement appear to start before the server operation',
  )
  assert.equal((sqlCalls[1]?.values[14] as Date).toISOString(), '2026-08-28T12:00:00.000Z')
  const storedParameters = JSON.stringify(sqlCalls.flatMap(call => call.values))
  assert.doesNotMatch(storedParameters, new RegExp(SIGNATURE.slice(2), 'iu'))
  assert.doesNotMatch(storedParameters, new RegExp(PAYMENT_HEADER, 'u'))
})

test('begin rejects unsafe authorization windows and invalid Base anchors before SQL', async () => {
  for (const invalid of [
    { validAfter: '1', validBefore: '2' },
    { validAfter: '-1', validBefore: '1788000000' },
    { validAfter: '0', validBefore: String(BigInt(Number.MAX_SAFE_INTEGER) + 1n) },
  ]) {
    reset()
    await assert.rejects(
      beginX402Settlement(input({ paymentHeader: paymentHeaderWithAuthorization(invalid) })),
      /authorization window/iu,
    )
    assert.equal(sqlCalls.length, 0)
  }

  reset()
  await assert.rejects(beginX402Settlement(input({ startBlock: -1n })), /start block/iu)
  assert.equal(sqlCalls.length, 0)
})

test('stored payment attempts match only their exact route and public payment requirements', async () => {
  reset()
  const stored = (await beginX402Settlement(input())).attempt
  const expected = {
    operationKey: stored.operation_key,
    operationKind: 'listing_fee' as const,
    requirements: input().requirements,
  }

  assert.equal(x402PaymentAttemptMatches(stored, expected), true)
  for (const changed of [
    { ...expected, operationKey: `${expected.operationKey}:changed` },
    { ...expected, operationKind: 'purchase' as const },
    { ...expected, requirements: { ...expected.requirements, network: 'not-base' as 'base' } },
    { ...expected, requirements: { ...expected.requirements, asset: `0x${'33'.repeat(20)}` } },
    { ...expected, requirements: { ...expected.requirements, payTo: PAYER } },
    { ...expected, requirements: { ...expected.requirements, maxAmountRequired: '1000001' } },
    { ...expected, requirements: { ...expected.requirements, resource: `${expected.requirements.resource}/changed` } },
  ]) {
    assert.equal(x402PaymentAttemptMatches(stored, changed), false)
  }
})

test('equivalent reordered proof JSON has one canonical identity', async () => {
  reset()
  const original = await beginX402Settlement(input())
  sqlCalls.length = 0

  const reordered = await beginX402Settlement(input({ paymentHeader: REORDERED_PAYMENT_HEADER }))

  assert.equal(x402ProofDigest(REORDERED_PAYMENT_HEADER), x402ProofDigest(PAYMENT_HEADER))
  assert.equal(reordered.disposition, 'existing')
  assert.equal(reordered.attempt.proof_digest, original.attempt.proof_digest)
  assert.equal(sqlCalls.length, 1)
})

test('the same operation and proof replays the existing attempt without another insert', async () => {
  reset()
  await beginX402Settlement(input())
  sqlCalls.length = 0

  const replay = await beginX402Settlement(input())

  assert.equal(replay.disposition, 'existing')
  assert.equal(replay.attempt.status, 'settling')
  assert.equal(sqlCalls.length, 1)
  assert.equal(x402PaymentRetryInstruction(replay.attempt).do_not_pay_again, true)
})

test('a retry cannot move the original pre-verification acceptance anchor', async () => {
  reset()
  await beginX402Settlement(input())

  await assert.rejects(
    beginX402Settlement(input({
      operationStartedAt: new Date('2026-08-28T12:00:00.001Z'),
    })),
    (error: unknown) => error instanceof X402PaymentAttemptConflictError,
  )
})

test('equivalent PostgreSQL timestamp text preserves the same acceptance anchor', async () => {
  reset()
  await beginX402Settlement(input())
  assert.ok(attempt)
  attempt.operation_started_at = '2026-08-28 12:00:00+00'

  const replay = await beginX402Settlement(input())

  assert.equal(replay.disposition, 'existing')
  assert.equal(replay.attempt.operation_started_at, '2026-08-28T12:00:00.000Z')
})

test('a route can find custody by operation before deciding whether to issue a 402', async () => {
  reset()
  const reserved = await beginX402Settlement(input())
  sqlCalls.length = 0

  const found = await readX402PaymentAttempt(reserved.attempt.operation_key)

  assert.equal(found?.proof_digest, reserved.attempt.proof_digest)
  assert.equal(found?.status, 'settling')
  assert.equal(sqlCalls.length, 1)
  assert.match(sqlCalls[0]?.query ?? '', /x402-payment-attempt:read-operation/iu)
  assert.equal(sqlCalls[0]?.values.includes(PAYMENT_HEADER), false)
})

test('a changed proof cannot replace an operation after settlement began', async () => {
  reset()
  await beginX402Settlement(input())
  const changedProof = JSON.parse(
    Buffer.from(PAYMENT_HEADER, 'base64').toString('utf8'),
  ) as { payload: { signature: string } }
  changedProof.payload.signature = `0x${'88'.repeat(65)}`
  const changedHeader = Buffer.from(JSON.stringify(changedProof)).toString('base64')

  await assert.rejects(
    beginX402Settlement(input({ paymentHeader: changedHeader })),
    (error: unknown) => error instanceof X402PaymentAttemptConflictError,
  )
})

test('one proof cannot be rebound to another operation', async () => {
  reset()
  await beginX402Settlement(input())

  await assert.rejects(
    beginX402Settlement(input({
      operationKey: 'purchase:listing:91:buyer:7',
      operationKind: 'purchase',
    })),
    (error: unknown) => error instanceof X402PaymentAttemptConflictError,
  )
})

test('an exact concurrent reservation re-reads the winner', async () => {
  reset()
  const first = await beginX402Settlement(input())
  const winner = { ...first.attempt }
  reset()
  insertRace = winner

  const result = await beginX402Settlement(input())

  assert.equal(result.disposition, 'existing')
  assert.equal(result.attempt.proof_digest, winner.proof_digest)
  assert.equal(sqlCalls.length, 3)
})

test('an ambiguous facilitator outcome becomes durable review with no new-payment path', async () => {
  reset()
  const reserved = await beginX402Settlement(input())

  const reviewed = await markX402SettlementNeedsReview({
    operationKey: reserved.attempt.operation_key,
    proofDigest: reserved.attempt.proof_digest,
    reason: 'the facilitator did not confirm whether this payment settled',
  })

  assert.equal(reviewed.status, 'needs_review')
  assert.deepEqual(x402PaymentRetryInstruction(reviewed), {
    retry: 'retry this same request without X-PAYMENT',
    do_not_pay_again: true,
  })
})

test('a no-op review write stays honestly settling and still says not to pay again', async () => {
  reset()
  const reserved = await beginX402Settlement(input())
  reviewNoop = true

  const current = await markX402SettlementNeedsReview({
    operationKey: reserved.attempt.operation_key,
    proofDigest: reserved.attempt.proof_digest,
    reason: 'the facilitator did not confirm whether this payment settled',
  })

  assert.equal(current.status, 'settling')
  assert.equal(x402PaymentRetryInstruction(current).do_not_pay_again, true)
  const reviewCall = sqlCalls.find(call => call.query.includes('x402-payment-attempt:review'))
  assert.match(
    reviewCall?.query ?? '',
    /GREATEST\(\s*clock_timestamp\(\),\s*attempt\.updated_at,\s*attempt\.settlement_started_at\s*\)/u,
    'review time must not move behind an app-clock-ahead reservation',
  )
})

test('a confirmed facilitator transaction is recorded without the signed proof', async () => {
  reset()
  const reserved = await beginX402Settlement(input())

  const settled = await recordX402Settlement({
    operationKey: reserved.attempt.operation_key,
    proofDigest: reserved.attempt.proof_digest,
    transaction: TX_HASH.toUpperCase().replace('0X', '0x'),
    payerWallet: PAYER.toUpperCase().replace('0X', '0x'),
  })

  assert.equal(settled.status, 'settled')
  assert.equal(settled.tx_hash, TX_HASH)
  assert.equal(settled.payer_wallet, PAYER)
  assert.equal(x402PaymentRetryInstruction(settled).do_not_pay_again, true)
  const settlementCall = sqlCalls.find(call => call.query.includes('x402-payment-attempt:settled'))
  assert.match(
    settlementCall?.query ?? '',
    /GREATEST\(\s*clock_timestamp\(\),\s*attempt\.updated_at,\s*attempt\.settlement_started_at\s*\)/u,
    'database clock skew must not make the confirmed settlement predate its reservation',
  )
})

test('an exact transfer becomes terminal verified with complete late finality evidence', async () => {
  reset()
  const reserved = await beginX402Settlement(input())
  const settled = await recordX402Settlement({
    operationKey: reserved.attempt.operation_key,
    proofDigest: reserved.attempt.proof_digest,
    transaction: TX_HASH,
    payerWallet: PAYER,
  })

  const verified = await recordX402Finality({
    operationKey: settled.operation_key,
    proofDigest: settled.proof_digest,
    transaction: TX_HASH,
    outcome: 'verified',
    blockNumber: 31_337_777n,
    blockHash: `0x${'cd'.repeat(32)}`,
    blockTime: new Date('2026-08-28T12:00:03.000Z'),
    finalizedAt: new Date('2026-08-28T13:00:00.000Z'),
  })

  assert.equal(verified.status, 'verified')
  assert.equal(verified.finalized_block_number, '31337777')
  assert.equal(verified.finalized_block_hash, `0x${'cd'.repeat(32)}`)
  assert.equal(verified.finalized_block_time, '2026-08-28T12:00:03.000Z')
  assert.equal(verified.finalized_at, '2026-08-28T13:00:00.000Z')
  const finalityCall = sqlCalls.find(call => call.query.includes('x402-payment-attempt:finality'))
  assert.match(
    finalityCall?.query ?? '',
    /GREATEST\(\s*clock_timestamp\(\),\s*attempt\.updated_at,\s*requested\.finalized_at\s*\)/u,
    'finality time must not move behind custody or the supplied observation time',
  )
  assert.equal(verified.review_reason, null)
  assert.equal(x402PaymentRetryInstruction(verified).do_not_pay_again, true)
})

test('a finalized contradiction stores its transaction and complete evidence as terminal review', async () => {
  reset()
  const reserved = await beginX402Settlement(input())
  const settled = await recordX402Settlement({
    operationKey: reserved.attempt.operation_key,
    proofDigest: reserved.attempt.proof_digest,
    transaction: TX_HASH,
    payerWallet: PAYER,
  })
  const finality = {
    operationKey: settled.operation_key,
    proofDigest: settled.proof_digest,
    transaction: TX_HASH,
    blockNumber: 31_337_778n,
    blockHash: `0x${'de'.repeat(32)}`,
    blockTime: new Date('2026-08-28T12:00:04.000Z'),
    finalizedAt: new Date('2026-08-28T13:05:00.000Z'),
  }

  const reviewed = await recordX402Finality({
    ...finality,
    outcome: 'needs_review',
    reason: 'the finalized transaction did not contain the authorized USDC transfer',
  })

  assert.equal(reviewed.status, 'needs_review')
  assert.equal(reviewed.tx_hash, TX_HASH)
  assert.equal(reviewed.finalized_block_number, '31337778')
  assert.equal(reviewed.finalized_block_hash, finality.blockHash)
  assert.equal(reviewed.finalized_block_time, finality.blockTime.toISOString())
  assert.equal(reviewed.finalized_at, finality.finalizedAt.toISOString())
  assert.match(reviewed.review_reason ?? '', /did not contain/iu)
  await assert.rejects(
    recordX402Finality({ ...finality, outcome: 'verified' }),
    (error: unknown) => error instanceof X402PaymentAttemptConflictError,
  )
})

test('recording the same terminal finality result is idempotent', async () => {
  reset()
  const reserved = await beginX402Settlement(input())
  const settled = await recordX402Settlement({
    operationKey: reserved.attempt.operation_key,
    proofDigest: reserved.attempt.proof_digest,
    transaction: TX_HASH,
    payerWallet: PAYER,
  })
  const finality = {
    operationKey: settled.operation_key,
    proofDigest: settled.proof_digest,
    transaction: TX_HASH,
    outcome: 'verified' as const,
    blockNumber: 31_337_779n,
    blockHash: `0x${'ef'.repeat(32)}`,
    blockTime: new Date('2026-08-28T12:00:05.000Z'),
    finalizedAt: new Date('2026-08-28T13:10:00.000Z'),
  }
  await recordX402Finality(finality)

  const replay = await recordX402Finality(finality)

  assert.equal(replay.status, 'verified')
  assert.equal(replay.finalized_block_hash, finality.blockHash)
})

test('a same-second coarse Base block time can precede the millisecond operation timestamp', async () => {
  reset()
  const reserved = await beginX402Settlement(input({
    operationStartedAt: new Date('2026-08-28T12:00:00.900Z'),
  }))
  const reserveCall = sqlCalls.find(call => call.query.includes('x402-payment-attempt:reserve'))
  assert.ok(reserveCall)
  assert.equal((reserveCall.values[13] as Date).toISOString(), '2026-08-28T12:00:00.900Z')
  assert.equal(reserved.attempt.operation_started_at, '2026-08-28T12:00:00.900Z')
  const settled = await recordX402Settlement({
    operationKey: reserved.attempt.operation_key,
    proofDigest: reserved.attempt.proof_digest,
    transaction: TX_HASH,
    payerWallet: PAYER,
  })

  const verified = await recordX402Finality({
    operationKey: settled.operation_key,
    proofDigest: settled.proof_digest,
    transaction: TX_HASH,
    outcome: 'verified',
    blockNumber: 31_337_776n,
    blockHash: `0x${'bc'.repeat(32)}`,
    blockTime: new Date('2026-08-28T12:00:00.000Z'),
    finalizedAt: new Date('2026-08-28T13:00:00.000Z'),
  })

  assert.equal(verified.status, 'verified')
  assert.equal(verified.operation_started_at, '2026-08-28T12:00:00.900Z')
  assert.equal(verified.finalized_block_time, '2026-08-28T12:00:00.000Z')
})

test('the additive migration guards immutable terms and never creates a signed-proof column', async () => {
  const migration = await readFile(
    new URL('../db/migrations/20260828_x402_payment_attempts.sql', import.meta.url),
    'utf8',
  )

  assert.match(migration, /CREATE TABLE IF NOT EXISTS x402_payment_attempts/iu)
  assert.match(migration, /proof_digest\s+TEXT\s+NOT NULL\s+UNIQUE/iu)
  assert.match(
    migration,
    /UNIQUE\s*\(\s*network\s*,\s*asset\s*,\s*payer_wallet\s*,\s*authorization_nonce\s*\)/iu,
  )
  assert.match(migration, /status\s+TEXT\s+NOT NULL\s+DEFAULT\s+'settling'/iu)
  assert.match(migration, /operation_started_at\s+TIMESTAMPTZ\s+NOT NULL/iu)
  assert.match(migration, /authorization_valid_after\s+BIGINT\s+NOT NULL/iu)
  assert.match(migration, /authorization_valid_before\s+BIGINT\s+NOT NULL/iu)
  assert.match(migration, /start_block\s+BIGINT\s+NOT NULL/iu)
  assert.match(migration, /finalized_block_number >= start_block/iu)
  assert.match(migration, /status IN \('settling', 'settled', 'verified', 'needs_review'\)/iu)
  assert.match(migration, /finalized_block_number\s+BIGINT/iu)
  assert.match(migration, /x402_payment_attempts_finality_complete/iu)
  assert.doesNotMatch(
    migration,
    /finalized_block_time IS NULL OR finalized_block_time >= operation_started_at/iu,
  )
  assert.match(migration, /finalized_at IS NULL OR finalized_at >= finalized_block_time/iu)
  assert.match(migration, /OLD\.status = 'verified'/iu)
  assert.match(migration, /OLD\.finalized_block_number IS NOT NULL/iu)
  assert.match(migration, /OLD\.settled_at IS NOT NULL/iu)
  assert.match(migration, /protect_x402_payment_attempt_history/iu)
  assert.match(
    migration,
    /NEW\.updated_at := GREATEST\([\s\S]*OLD\.updated_at[\s\S]*NEW\.settlement_started_at/iu,
  )
  assert.doesNotMatch(migration, /payment_header|payment_signature|signed_payload/iu)

  const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8')
  assert.equal(schema.endsWith(migration), true)
})
