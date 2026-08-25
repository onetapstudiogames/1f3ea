// Chain failure tests replace fetch before importing the module. No live RPC,
// wallet, transaction, or deployment is touched.
import test from 'node:test'
import assert from 'node:assert/strict'

const RECOVERED = '0x1111111111111111111111111111111111111111'
const SENDER = '0x2222222222222222222222222222222222222222'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const HASH = `0x${'aa'.repeat(32)}`
const TX = `0x${'bb'.repeat(32)}`
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
  classifyUsdcTransfer,
  recoverPersonalSigner,
  verifyPersonalSignature,
  verifyUsdcTransfer,
  usdcBalance,
} = await import('../src/chain.ts')

const result = (value: unknown) => () => new Response(JSON.stringify({ result: value }), {
  headers: { 'content-type': 'application/json' },
})
const failedHttp = () => new Response('unavailable', { status: 503 })
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

test('USDC proof rejects failed receipts, mismatched logs, and missing blocks', async () => {
  queue(result(null))
  assert.equal(await verifyUsdcTransfer(TX, RECOVERED, 1_000_000n), null)

  queue(
    result({ status: '0x0', blockHash: HASH, blockNumber: '0x100', logs: [] }),
    result({ hash: HASH, number: '0x100' }),
    result({ number: '0x100' }),
  )
  assert.equal(await verifyUsdcTransfer(TX, RECOVERED, 1_000_000n), null)

  const toTopic = `0x${RECOVERED.slice(2).padStart(64, '0')}`
  const fromTopic = `0x${SENDER.slice(2).padStart(64, '0')}`
  queue(
    result({
      status: '0x1', blockHash: HASH, blockNumber: '0x100',
      logs: [
        { address: RECOVERED, topics: [TRANSFER_TOPIC, fromTopic, toTopic], data: '0xf4240' },
        { address: USDC, topics: ['0xwrong', fromTopic, toTopic], data: '0xf4240' },
        { address: USDC, topics: [TRANSFER_TOPIC], data: '0xf4240' },
        { address: USDC, topics: [TRANSFER_TOPIC, fromTopic, `0x${'22'.repeat(32)}`], data: '0xf4240' },
        { address: USDC, topics: [TRANSFER_TOPIC, fromTopic, toTopic], data: '0x1' },
      ],
    }),
    result({ hash: HASH, number: '0x100' }),
    result({ number: '0x100' }),
  )
  assert.equal(await verifyUsdcTransfer(TX, RECOVERED, 1_000_000n), null)

  queue(
    result({
      status: '0x1', blockHash: HASH, blockNumber: '0x100',
      logs: [{ address: USDC, topics: [TRANSFER_TOPIC, fromTopic, toTopic], data: '0xf4240' }],
    }),
    result({ hash: HASH, number: '0x100' }),
    result({ number: '0x100' }),
    result(null),
  )
  assert.equal(await verifyUsdcTransfer(TX, RECOVERED, 1_000_000n), null)
  assert.equal(steps.length, 0)
})

test('USDC proof and treasury balance return normalized public facts on valid RPC replies', async () => {
  const toTopic = `0x${RECOVERED.slice(2).padStart(64, '0')}`
  const fromTopic = `0x${SENDER.slice(2).padStart(64, '0')}`
  queue(
    result({
      status: '0x1', blockHash: HASH, blockNumber: '0x100',
      logs: [{ address: USDC, topics: [TRANSFER_TOPIC, fromTopic, toTopic], data: '0x1e8480' }],
    }),
    result({ hash: HASH, number: '0x100' }),
    result({ number: '0x100' }),
    result({ timestamp: '0x64' }),
  )
  const transfer = await verifyUsdcTransfer(TX, RECOVERED, 1_000_000n)
  assert.ok(transfer)
  assert.equal(transfer.from, SENDER)
  assert.equal(transfer.to, RECOVERED)
  assert.equal(transfer.amount, 2_000_000n)
  assert.deepEqual(transfer.blockTime, new Date(100_000))
  assert.equal(transfer.blockNumber, 256n)
  assert.equal(transfer.blockHash, HASH)
  assert.ok(transfer.finalizedAt instanceof Date)

  queue(result(null))
  assert.equal(await usdcBalance(RECOVERED), null)

  queue(result('0x1e8480'))
  assert.equal(await usdcBalance(RECOVERED), '2.000000')
  assert.equal(steps.length, 0)
  assert.ok(rpcCalls.some(call => call.method === 'eth_getBlockByHash'))
})

test('USDC classification keeps unfinalized and reorged receipts pending', async () => {
  const toTopic = `0x${RECOVERED.slice(2).padStart(64, '0')}`
  const fromTopic = `0x${SENDER.slice(2).padStart(64, '0')}`
  const receipt = {
    status: '0x1', blockHash: HASH, blockNumber: '0x100',
    logs: [{ address: USDC, topics: [TRANSFER_TOPIC, fromTopic, toTopic], data: '0xf4240' }],
  }

  queue(result(receipt), result({ hash: HASH, number: '0x100' }), result({ number: '0xff' }))
  assert.deepEqual(await classifyUsdcTransfer(TX, RECOVERED, 1_000_000n), { state: 'pending' })

  queue(result(receipt), result({ hash: `0x${'cc'.repeat(32)}`, number: '0x100' }))
  assert.deepEqual(await classifyUsdcTransfer(TX, RECOVERED, 1_000_000n), { state: 'pending' })
  assert.equal(steps.length, 0)
})

test('only canonical finalized failed or mismatched receipts become final invalid evidence', async () => {
  queue(
    result({ status: '0x0', blockHash: HASH, blockNumber: '0x100', logs: [] }),
    result({ hash: HASH, number: '0x100' }),
    result({ number: '0x100' }),
  )
  assert.deepEqual(await classifyUsdcTransfer(TX, RECOVERED, 1_000_000n), {
    state: 'invalid_final', reason: 'failed_transaction',
  })

  queue(
    result({ status: '0x1', blockHash: HASH, blockNumber: '0x100', logs: [] }),
    result({ hash: HASH, number: '0x100' }),
    result({ number: '0x100' }),
  )
  assert.deepEqual(await classifyUsdcTransfer(TX, RECOVERED, 1_000_000n), {
    state: 'invalid_final', reason: 'confirmed_mismatch',
  })
  assert.equal(steps.length, 0)
})
