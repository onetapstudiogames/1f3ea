// Payment failure tests use a local fetch queue only. They never contact the
// facilitator, Base, a wallet, a database, or a live deployment.
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'

type FetchStep = () => Response | Promise<Response>
const steps: FetchStep[] = []

globalThis.fetch = (async () => {
  const step = steps.shift()
  assert.ok(step, 'unexpected facilitator call')
  return step()
}) as typeof fetch

const {
  canonicalTxHash,
  requirements,
  settleX402,
} = await import('../src/pay.ts')

const TX = `0x${'ab'.repeat(32)}`
const PAYER = '0x1111111111111111111111111111111111111111'
const reqs = requirements(process.env.TREASURY_ADDRESS, 1, '/api/listing', 'listing fee')
const payload = (value: unknown = { payload: { authorization: { from: PAYER } } }) =>
  Buffer.from(JSON.stringify(value)).toString('base64')
const json = (value: unknown, status = 200) => () => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
})
const invalidJson = (status = 200) => () => new Response('not json', { status })

function queue(...next: FetchStep[]) {
  assert.equal(steps.length, 0)
  steps.push(...next)
}

test('x402 separates malformed caller proofs from unavailable verification upstreams', async () => {
  assert.deepEqual(await settleX402('%%%', reqs), {
    status: 'invalid',
    reason: 'X-PAYMENT header is not valid base64 JSON',
  })

  queue(invalidJson(503))
  assert.deepEqual(await settleX402(payload(), reqs), {
    status: 'unavailable',
    reason: 'payment facilitator verification is unavailable; retry this request with the same X-PAYMENT proof later',
  })

  queue(json({ isValid: false, invalidReason: 'signature rejected' }))
  assert.deepEqual(await settleX402(payload(), reqs), {
    status: 'unavailable',
    reason: 'payment facilitator could not classify X-PAYMENT verification: signature rejected; ' +
      'retry this request with the same X-PAYMENT proof later',
  })

  queue(json({ isValid: false, invalidReason: 'invalid_payload' }, 400))
  assert.deepEqual(await settleX402(payload(), reqs), {
    status: 'invalid',
    reason: 'X-PAYMENT payload is malformed or missing required fields',
  })

  queue(json({ isValid: false, invalidReason: 'unexpected_verify_error' }))
  assert.deepEqual(await settleX402(payload(), reqs), {
    status: 'unavailable',
    reason: 'payment facilitator could not verify X-PAYMENT: unexpected verify error; ' +
      'retry this request with the same X-PAYMENT proof later',
  })

  queue(json({ isValid: false, invalidReason: 'new_unknown_verify_reason' }))
  assert.deepEqual(await settleX402(payload(), reqs), {
    status: 'unavailable',
    reason: 'payment facilitator could not classify X-PAYMENT verification: new unknown verify reason; ' +
      'retry this request with the same X-PAYMENT proof later',
  })

  for (const [rejected, publishedCause] of [
    [{ error: 'invalid_payment_requirements' }, 'invalid payment requirements'],
    [{ message: 'payload or requirements rejected' }, 'payload or requirements rejected'],
  ]) {
    queue(json(rejected, 400))
    const result = await settleX402(payload(), reqs)
    assert.equal(result.status, 'unclassified')
    assert.match(result.reason, /facilitator rejected the verification request/i)
    assert.match(result.reason, new RegExp(String(publishedCause), 'i'))
    assert.match(result.reason,
      /X-PAYMENT proof, the market's payment requirements, or facilitator request handling/i)
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
    status: 'unavailable',
    reason: 'payment facilitator could not classify X-PAYMENT verification: ' +
      'unrecognized verification failure; retry this request with the same X-PAYMENT proof later',
  })
  assert.doesNotMatch(JSON.stringify(redacted), /1f3ea_sk_/i)

  for (const unreadable of [
    new Response('not json'),
    new Response(JSON.stringify({ unexpected: true })),
  ]) {
    queue(() => unreadable)
    assert.deepEqual(await settleX402(payload(), reqs), {
      status: 'unavailable',
      reason: 'payment facilitator returned an unreadable verification response; retry this request with the same X-PAYMENT proof later',
    })
  }
})

test('x402 separates unconfirmed settlements from unclassified request rejections', async () => {
  queue(json({ isValid: true }), invalidJson())
  assert.deepEqual(await settleX402(payload(), reqs), {
    status: 'unavailable',
    reason: 'payment facilitator returned an unreadable settlement response; retry this request with the same X-PAYMENT proof later',
  })

  queue(json({ isValid: true }), json({ success: false, errorReason: 'not settled' }))
  assert.deepEqual(await settleX402(payload(), reqs), {
    status: 'unavailable',
    reason: 'payment facilitator did not confirm settlement: not settled; ' +
      'retry this request with the same X-PAYMENT proof later; do not pay again',
  })

  for (const [errorReason, reason] of [
    ['insufficient_funds', 'payer wallet does not have enough USDC for this payment'],
    ['invalid_exact_evm_payload_authorization_valid_after', 'X-PAYMENT authorization is not valid yet'],
    ['invalid_exact_evm_payload_authorization_valid_before', 'X-PAYMENT authorization expired'],
    ['invalid_exact_evm_payload_authorization_value', 'X-PAYMENT amount is below the required payment'],
    ['invalid_exact_evm_payload_signature', 'X-PAYMENT signature is invalid'],
    ['invalid_exact_evm_payload_recipient_mismatch', 'X-PAYMENT recipient does not match this payment'],
    ['invalid_network', 'X-PAYMENT uses the wrong or unsupported network'],
    ['invalid_payload', 'X-PAYMENT payload is malformed or missing required fields'],
    ['invalid_scheme', 'X-PAYMENT uses the wrong payment scheme'],
    ['unsupported_scheme', 'X-PAYMENT uses a payment scheme the facilitator does not support'],
    ['invalid_x402_version', 'X-PAYMENT uses an unsupported x402 version'],
    ['invalid_transaction_state', 'X-PAYMENT transaction failed or was rejected'],
  ]) {
    queue(json({ isValid: true }), json({ success: false, errorReason }, 400))
    assert.deepEqual(await settleX402(payload(), reqs), {
      status: 'invalid',
      reason,
    }, errorReason)
  }

  for (const errorReason of [
    'invalid_payment_requirements',
    'unexpected_settle_error',
    'new_unknown_settlement_error',
  ]) {
    queue(json({ isValid: true }), json({ success: false, errorReason }))
    const result = await settleX402(payload(), reqs)
    assert.equal(result.status, 'unavailable', errorReason)
    assert.match(result.reason, /did not confirm settlement.*retry.*same X-PAYMENT proof.*do not pay again/i,
      errorReason)
  }

  queue(json({ isValid: true }), json({ success: false, errorReason: 'private upstream detail' }, 503))
  assert.deepEqual(await settleX402(payload(), reqs), {
    status: 'unavailable',
    reason: 'payment facilitator settlement is unavailable; retry this request with the same X-PAYMENT proof later',
  })

  for (const [rejected, publishedCause] of [
    [{ errorReason: 'invalid_payment_requirements' }, 'invalid payment requirements'],
    [{ invalidReason: 'payload or requirements rejected' }, 'payload or requirements rejected'],
  ]) {
    queue(json({ isValid: true }), json(rejected, 400))
    const result = await settleX402(payload(), reqs)
    assert.equal(result.status, 'unclassified')
    assert.match(result.reason, /facilitator rejected the settlement request/i)
    assert.match(result.reason, new RegExp(String(publishedCause), 'i'))
    assert.match(result.reason,
      /X-PAYMENT proof, the market's payment requirements, or facilitator request handling/i)
    assert.doesNotMatch(result.reason, /retry.*same|fresh payment proof/i)
  }

  queue(json({ isValid: true }), json({ success: true }))
  assert.deepEqual(await settleX402(payload(), reqs), {
    status: 'unavailable',
    reason: 'payment facilitator returned an unreadable settlement response; retry this request with the same X-PAYMENT proof later',
  })

  queue(json({ isValid: true }), json({ success: true, transaction: 'not-a-hash' }))
  assert.deepEqual(await settleX402(payload(), reqs), {
    status: 'unavailable',
    reason: 'payment facilitator returned an unreadable settlement response; retry this request with the same X-PAYMENT proof later',
  })
})

test('x402 returns the facilitator payer or the signed fallback without changing the proof', async () => {
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

  queue(json({ isValid: true }), json({ success: true, transaction: TX }))
  const absent = await settleX402(payload({}), reqs)
  assert.equal(absent.status, 'verified')
  if (absent.status === 'verified') assert.equal(absent.payer, '')
})

test('x402 reports verification and settlement network outages without leaking thrown errors', async () => {
  queue(() => { throw new Error('private upstream detail') })
  assert.deepEqual(await settleX402(payload(), reqs), {
    status: 'unavailable',
    reason: 'payment facilitator verification is unavailable; retry this request with the same X-PAYMENT proof later',
  })

  queue(json({ isValid: true }), () => { throw new Error('private upstream detail') })
  assert.deepEqual(await settleX402(payload(), reqs), {
    status: 'unavailable',
    reason: 'payment facilitator settlement is unavailable; retry this request with the same X-PAYMENT proof later',
  })
  assert.equal(canonicalTxHash(7), null)
  assert.equal(steps.length, 0)
})
