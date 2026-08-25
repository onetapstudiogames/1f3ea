// Payment failure tests use a local fetch queue only. They never contact the
// facilitator, Base, a wallet, a database, or a live deployment.
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'

type FetchStep = (init?: RequestInit) => Response | Promise<Response>
const steps: FetchStep[] = []
const facilitatorSignals: Array<AbortSignal | null> = []

globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
  const step = steps.shift()
  assert.ok(step, 'unexpected facilitator call')
  facilitatorSignals.push(init?.signal instanceof AbortSignal ? init.signal : null)
  return step(init)
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
const oversizedJson = (onCancel: () => void) => () => {
  const encoder = new TextEncoder()
  let canceled = false
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"padding":"'))
      controller.enqueue(encoder.encode('x'.repeat(70_000)))
      controller.enqueue(encoder.encode('"}'))
      setTimeout(() => {
        if (!canceled) controller.close()
      }, 0)
    },
    cancel() {
      canceled = true
      onCancel()
    },
  }), { headers: { 'content-type': 'application/json' } })
}

function queue(...next: FetchStep[]) {
  assert.equal(steps.length, 0)
  steps.push(...next)
}

test('x402 rejects malformed headers and verification failures with safe public reasons', async () => {
  assert.deepEqual(await settleX402('%%%', reqs), {
    error: 'X-PAYMENT header is not base64 JSON',
  })
  assert.deepEqual(await settleX402('A'.repeat(32_769), reqs), {
    error: 'X-PAYMENT header is too large',
  })

  queue(invalidJson(503))
  assert.deepEqual(await settleX402(payload(), reqs), {
    error: 'facilitator rejected the payment',
  })

  queue(json({ isValid: false, invalidReason: 'signature rejected' }))
  assert.deepEqual(await settleX402(payload(), reqs), { error: 'signature rejected' })
})

test('x402 rejects every incomplete or invalid settlement shape', async () => {
  queue(json({ isValid: true }), invalidJson())
  assert.deepEqual(await settleX402(payload(), reqs), { error: 'settlement failed' })

  queue(json({ isValid: true }), json({ success: false, errorReason: 'not settled' }, 503))
  assert.deepEqual(await settleX402(payload(), reqs), { error: 'not settled' })

  queue(json({ isValid: true }), json({ success: true }))
  assert.deepEqual(await settleX402(payload(), reqs), { error: 'settlement failed' })

  queue(json({ isValid: true }), json({ success: true, transaction: 'not-a-hash' }))
  assert.deepEqual(await settleX402(payload(), reqs), {
    error: 'settlement returned an invalid transaction hash',
  })
})

test('x402 returns the facilitator payer or the signed fallback without changing the proof', async () => {
  queue(json({ isValid: true }), json({ success: true, transaction: TX, payer: PAYER }))
  const explicit = await settleX402(payload(), reqs)
  assert.equal('error' in explicit, false)
  if (!('error' in explicit)) {
    assert.equal(explicit.transaction, TX)
    assert.equal(explicit.payer, PAYER)
  }

  queue(json({ isValid: true }), json({ success: true, transaction: TX.toUpperCase().replace('0X', '0x') }))
  const fallback = await settleX402(payload(), reqs)
  assert.equal('error' in fallback, false)
  if (!('error' in fallback)) {
    assert.equal(fallback.transaction, TX)
    assert.equal(fallback.payer, PAYER)
  }

  queue(json({ isValid: true }), json({ success: true, transaction: TX }))
  const absent = await settleX402(payload({}), reqs)
  assert.equal('error' in absent, false)
  if (!('error' in absent)) assert.equal(absent.payer, '')
})

test('x402 reports a facilitator outage without leaking the thrown error', async () => {
  queue(() => { throw new Error('private upstream detail') })
  assert.deepEqual(await settleX402(payload(), reqs), {
    error: 'facilitator unreachable — start a fresh signed direct-payment intent before paying',
  })
  assert.equal(canonicalTxHash(7), null)
  assert.equal(steps.length, 0)
})

test('x402 bounds both facilitator responses and stops reading after the cap', async () => {
  let verificationCanceled = false
  queue(oversizedJson(() => { verificationCanceled = true }))
  assert.deepEqual(await settleX402(payload(), reqs), {
    error: 'facilitator verification response was too large',
  })
  assert.equal(verificationCanceled, true)
  assert.equal(steps.length, 0, 'settlement must not run after an oversized verification response')

  let settlementCanceled = false
  queue(
    json({ isValid: true }),
    oversizedJson(() => { settlementCanceled = true }),
  )
  assert.deepEqual(await settleX402(payload(), reqs), {
    error: 'facilitator settlement response was too large',
  })
  assert.equal(settlementCanceled, true)
  assert.equal(steps.length, 0)
})

test('x402 gives verify and settle separate eight-second deadlines', async () => {
  const originalTimeout = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')
  const timeoutCalls: number[] = []
  Object.defineProperty(AbortSignal, 'timeout', {
    configurable: true,
    value: (milliseconds: number) => {
      timeoutCalls.push(milliseconds)
      return new AbortController().signal
    },
  })
  facilitatorSignals.length = 0
  try {
    queue(json({ isValid: true }), json({ success: true, transaction: TX, payer: PAYER }))
    const settled = await settleX402(payload(), reqs)
    assert.equal('error' in settled, false)
  } finally {
    if (originalTimeout) Object.defineProperty(AbortSignal, 'timeout', originalTimeout)
  }

  assert.deepEqual(timeoutCalls, [8_000, 8_000])
  assert.equal(facilitatorSignals.length, 2)
  assert.ok(facilitatorSignals.every(signal => signal instanceof AbortSignal))
  assert.notEqual(facilitatorSignals[0], facilitatorSignals[1])
})
