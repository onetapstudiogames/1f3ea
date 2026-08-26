// Chain failure tests replace fetch before importing the module. No live RPC,
// wallet, transaction, or deployment is touched.
import test from 'node:test'
import assert from 'node:assert/strict'

const RECOVERED = '0x1111111111111111111111111111111111111111'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const HASH = `0x${'aa'.repeat(32)}`
const TX = `0x${'bb'.repeat(32)}`
const word = (hex: string) => `0x${hex.replace(/^0x/, '').padStart(64, '0')}`
const r = '01'.padStart(64, '0')
const s = '02'.padStart(64, '0')
const signature = `0x${r}${s}1b`

type FetchStep = () => Response | Promise<Response>
const steps: FetchStep[] = []
const rpcCalls: Array<{ method: string; params: unknown[] }> = []

globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
  const call = JSON.parse(init?.body ?? '{}') as { method: string; params: unknown[] }
  rpcCalls.push(call)
  const step = steps.shift()
  assert.ok(step, `unexpected RPC call: ${call.method}`)
  return step()
}) as typeof fetch

const {
  recoverPersonalSigner,
  verifyPersonalSignature,
  verifyPersonalSignatureProof,
  verifyUsdcTransfer,
  usdcBalance,
} = await import('../src/chain.ts')

const result = (value: unknown) => () => new Response(JSON.stringify({ result: value }), {
  headers: { 'content-type': 'application/json' },
})
const failedHttp = () => new Response('unavailable', { status: 503 })
const invalidJson = () => new Response('not json', { headers: { 'content-type': 'application/json' } })
const throws = () => { throw new Error('offline') }

function queue(...next: FetchStep[]) {
  assert.equal(steps.length, 0)
  steps.push(...next)
}

test('personal-sign recovery fails closed for every RPC and precompile failure shape', async () => {
  queue(failedHttp)
  assert.equal(await recoverPersonalSigner('intent', signature), null)

  queue(result(undefined))
  assert.equal(await recoverPersonalSigner('intent', signature), null)

  queue(throws)
  assert.equal(await recoverPersonalSigner('intent', signature), null)

  queue(result(7))
  assert.equal(await recoverPersonalSigner('intent', signature), null)

  queue(result('0x12'))
  assert.equal(await recoverPersonalSigner('intent', signature), null)

  queue(result(HASH), result(null))
  assert.equal(await recoverPersonalSigner('intent', signature), null)

  queue(result(HASH), result('0x1234'))
  assert.equal(await recoverPersonalSigner('intent', signature), null)

  queue(result(HASH), result(`0x${'00'.repeat(32)}`))
  assert.equal(await recoverPersonalSigner('intent', signature), null)

  assert.equal(await recoverPersonalSigner(7 as unknown as string, signature), null)
  assert.equal(await verifyPersonalSignature('intent', signature, 7 as unknown as string), false)
  assert.equal(await verifyPersonalSignature('intent', signature, 'not-a-wallet'), false)
  assert.equal(steps.length, 0)
})

test('personal-sign proof separates an invalid signature from an unavailable Base RPC', async () => {
  for (const unavailable of [failedHttp, invalidJson, throws]) {
    queue(unavailable)
    const proof = await verifyPersonalSignatureProof('intent', signature, RECOVERED)
    assert.equal(proof.status, 'unavailable')
    assert.match(proof.reason, /Base RPC.*payer_signature.*retry.*same proof/i)
    assert.match(proof.reason, /do not pay again/i)
  }

  queue(result(HASH), result(`0x${'00'.repeat(32)}`))
  assert.deepEqual(await verifyPersonalSignatureProof('intent', signature, RECOVERED), {
    status: 'invalid',
    reason: 'payer_signature does not prove control of the expected payer wallet',
  })
  assert.equal(steps.length, 0)
})

test('USDC proof keeps a missing receipt retryable with the same proof', async () => {
  queue(result(null))
  assert.deepEqual(await verifyUsdcTransfer(TX, RECOVERED, 1_000_000n), {
    status: 'unavailable',
    reason: 'transaction is not yet visible or finalized on Base; retry the same tx_hash later; do not pay again',
  })

  assert.equal(steps.length, 0)
})

test('USDC proof names caller-invalid confirmed receipts and transfer requirements', async () => {

  queue(result({ status: '0x0', blockHash: HASH, logs: [] }))
  assert.deepEqual(await verifyUsdcTransfer(TX, RECOVERED, 1_000_000n), {
    status: 'invalid',
    reason: 'transaction failed on Base',
  })

  const toTopic = `0x${RECOVERED.slice(2).padStart(64, '0')}`
  queue(result({
    status: '0x1', blockHash: HASH,
    logs: [
      { address: RECOVERED, topics: [TRANSFER_TOPIC, toTopic, toTopic], data: word('f4240') },
      { address: USDC, topics: [`0x${'99'.repeat(32)}`, toTopic, toTopic], data: word('f4240') },
      { address: USDC, topics: [TRANSFER_TOPIC, toTopic, `0x${'22'.repeat(32)}`], data: word('f4240') },
      { address: USDC, topics: [TRANSFER_TOPIC, toTopic, toTopic], data: word('1') },
    ],
  }))
  assert.deepEqual(await verifyUsdcTransfer(TX, RECOVERED, 1_000_000n), {
    status: 'invalid',
    reason: `transaction did not transfer at least 1.000000 USDC on Base to ${RECOVERED}`,
  })

  assert.equal(steps.length, 0)
})

test('USDC proof reports RPC transport, HTTP, JSON, shape, and block failures as retryable', async () => {
  for (const unavailable of [throws, failedHttp, invalidJson]) {
    queue(unavailable)
    const proof = await verifyUsdcTransfer(TX, RECOVERED, 1_000_000n)
    assert.equal(proof.status, 'unavailable')
    assert.match(proof.reason, /Base RPC.*retry.*same proof.*do not pay again/i)
  }

  queue(result({ status: '0x1', blockHash: HASH, logs: 'not-an-array' }))
  const malformedReceipt = await verifyUsdcTransfer(TX, RECOVERED, 1_000_000n)
  assert.equal(malformedReceipt.status, 'unavailable')
  assert.match(malformedReceipt.reason, /unreadable transaction receipt.*retry.*same proof.*do not pay again/i)

  const toTopic = `0x${RECOVERED.slice(2).padStart(64, '0')}`
  queue(
    result({
      status: '0x1', blockHash: HASH,
      logs: [{ address: USDC, topics: [TRANSFER_TOPIC, toTopic, toTopic], data: word('f4240') }],
    }),
    result(null),
  )
  const missingBlock = await verifyUsdcTransfer(TX, RECOVERED, 1_000_000n)
  assert.equal(missingBlock.status, 'unavailable')
  assert.match(missingBlock.reason, /Base RPC.*payment block.*retry.*same proof.*do not pay again/i)
  assert.equal(steps.length, 0)
})

test('USDC proof and treasury balance return normalized public facts on valid RPC replies', async () => {
  const toTopic = `0x${RECOVERED.slice(2).padStart(64, '0')}`
  queue(
    result({
      status: '0x1', blockHash: HASH,
      logs: [{ address: USDC, topics: [TRANSFER_TOPIC, toTopic, toTopic], data: word('1e8480') }],
    }),
    result({ timestamp: '0x64' }),
  )
  const transfer = await verifyUsdcTransfer(TX, RECOVERED, 1_000_000n)
  assert.deepEqual(transfer, {
    status: 'verified',
    transfer: {
      from: RECOVERED,
      to: RECOVERED,
      amount: 2_000_000n,
      blockTime: new Date(100_000),
    },
  })

  queue(result(null))
  assert.equal(await usdcBalance(RECOVERED), null)

  queue(result('0x1e8480'))
  assert.equal(await usdcBalance(RECOVERED), '2.000000')
  assert.equal(steps.length, 0)
  assert.ok(rpcCalls.some(call => call.method === 'eth_getBlockByHash'))
})
