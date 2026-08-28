// Chain failure tests replace fetch before importing the module. No live RPC,
// wallet, transaction, or deployment is touched.
import test from 'node:test'
import assert from 'node:assert/strict'

const RECOVERED = '0x1111111111111111111111111111111111111111'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const AUTHORIZATION_USED_TOPIC = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5'
const HASH = `0x${'aa'.repeat(32)}`
const TX = `0x${'bb'.repeat(32)}`
const NONCE = `0x${'44'.repeat(32)}`
const OTHER_NONCE = `0x${'55'.repeat(32)}`
const BLOCK_NUMBER = '0x100'
const word = (hex: string) => `0x${hex.replace(/^0x/, '').padStart(64, '0')}`
const r = '01'.padStart(64, '0')
const s = '02'.padStart(64, '0')
const signature = `0x${r}${s}1b`
const addressTopic = (address: string) => `0x${address.slice(2).padStart(64, '0')}`
const transferLog = (from: string, to: string, amount: bigint) => ({
  address: USDC,
  topics: [TRANSFER_TOPIC, addressTopic(from), addressTopic(to)],
  data: word(amount.toString(16)),
})
const authorizationUsedLog = (payer: string, nonce: string) => ({
  address: USDC,
  topics: [AUTHORIZATION_USED_TOPIC, addressTopic(payer), nonce],
  data: '0x',
})

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
  classifyUsdcTransfer,
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

function rpcFixture(responses: Readonly<Record<string, unknown>>): FetchStep {
  return () => {
    const method = rpcCalls.at(-1)?.method
    assert.ok(method, 'RPC fixture was called without a recorded method')
    assert.ok(Object.hasOwn(responses, method), `missing RPC fixture for ${method}`)
    return result(responses[method])()
  }
}

function queue(...next: FetchStep[]) {
  assert.equal(steps.length, 0)
  steps.push(...next)
}

function queueBase(...next: FetchStep[]) {
  queue(result('0x2105'), ...next)
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
    assert.match(proof.reason, /payer_signature.*Base.*retry.*same proof/i)
  }

  queue(result(HASH), result(`0x${'00'.repeat(32)}`))
  assert.deepEqual(await verifyPersonalSignatureProof('intent', signature, RECOVERED), {
    status: 'invalid',
    reason: 'payer_signature does not prove control of the expected payer wallet',
  })
  assert.equal(steps.length, 0)
})

test('USDC proof keeps a missing receipt retryable with the same proof', async () => {
  queueBase(result(null))
  assert.deepEqual(await verifyUsdcTransfer(TX, RECOVERED, 1_000_000n), {
    status: 'unavailable',
    reason: 'transaction is not yet visible or finalized on Base; retry the same tx_hash later',
  })

  assert.equal(steps.length, 0)
})

test('USDC proof waits for a canonical finalized block before accepting a receipt', async () => {
  const toTopic = `0x${RECOVERED.slice(2).padStart(64, '0')}`
  const receipt = {
    status: '0x1', transactionHash: TX, blockHash: HASH, blockNumber: BLOCK_NUMBER,
    logs: [{ address: USDC, topics: [TRANSFER_TOPIC, toTopic, toTopic], data: word('f4240') }],
  }

  const pendingCallStart = rpcCalls.length
  queueBase(
    result(receipt),
    result({ number: '0xff' }),
  )
  assert.deepEqual(await classifyUsdcTransfer(TX, RECOVERED, 1_000_000n), {
    state: 'matched_pending',
    from: RECOVERED,
    to: RECOVERED,
    amount: 1_000_000n,
    blockNumber: 256n,
    blockHash: HASH,
  })
  const pendingCalls = rpcCalls.slice(pendingCallStart)
  assert.equal(pendingCalls[2]?.method, 'eth_getBlockByNumber')
  assert.equal(pendingCalls[2]?.params[0], 'finalized',
    'the finalized head must be read before the receipt block is accepted as canonical')

  queueBase(
    result(receipt),
    result({ number: BLOCK_NUMBER }),
    result({ hash: `0x${'cc'.repeat(32)}`, number: BLOCK_NUMBER }),
  )
  assert.deepEqual(await classifyUsdcTransfer(TX, RECOVERED, 1_000_000n), { state: 'pending' })
  assert.equal(steps.length, 0)
})

test('USDC classification proves the RPC is Base before reading payment evidence', async () => {
  const callStart = rpcCalls.length
  queue(rpcFixture({
    eth_chainId: '0x1',
    eth_getTransactionReceipt: {
      status: '0x1', transactionHash: TX, blockHash: HASH, blockNumber: BLOCK_NUMBER, logs: [],
    },
  }))

  assert.deepEqual(await classifyUsdcTransfer(TX, RECOVERED, 1_000_000n), { state: 'unavailable' })
  assert.deepEqual(rpcCalls.slice(callStart).map(call => call.method), ['eth_chainId'])
  assert.equal(steps.length, 0)
})

test('USDC classification binds the receipt transaction identity to the requested hash', async () => {
  const callStart = rpcCalls.length
  const fixture = rpcFixture({
    eth_chainId: '0x2105',
    eth_getTransactionReceipt: {
      status: '0x1', transactionHash: `0x${'cc'.repeat(32)}`,
      blockHash: HASH, blockNumber: BLOCK_NUMBER,
      logs: [transferLog(RECOVERED, RECOVERED, 1_000_000n)],
    },
    eth_getBlockByNumber: { number: BLOCK_NUMBER },
  })
  queue(fixture, fixture)

  assert.deepEqual(await classifyUsdcTransfer(TX, RECOVERED, 1_000_000n), { state: 'unavailable' })
  assert.deepEqual(rpcCalls.slice(callStart).map(call => call.method), [
    'eth_chainId', 'eth_getTransactionReceipt',
  ])
  assert.equal(steps.length, 0)
})

test('USDC classification binds a block-by-hash reply to the receipt hash and number', async () => {
  for (const block of [
    { hash: `0x${'cc'.repeat(32)}`, number: BLOCK_NUMBER, timestamp: '0x64' },
    { hash: HASH, number: '0x101', timestamp: '0x64' },
  ]) {
    const callStart = rpcCalls.length
    const fixture = rpcFixture({
      eth_chainId: '0x2105',
      eth_getTransactionReceipt: {
        status: '0x1', transactionHash: TX, blockHash: HASH, blockNumber: BLOCK_NUMBER,
        logs: [transferLog(RECOVERED, RECOVERED, 1_000_000n)],
      },
      eth_getBlockByNumber: { hash: HASH, number: BLOCK_NUMBER },
      eth_getBlockByHash: block,
    })
    queue(fixture, fixture, fixture, fixture, fixture)
    try {
      assert.deepEqual(await classifyUsdcTransfer(TX, RECOVERED, 1_000_000n), { state: 'unavailable' })
      assert.deepEqual(rpcCalls.slice(callStart).map(call => call.method), [
        'eth_chainId',
        'eth_getTransactionReceipt',
        'eth_getBlockByNumber',
        'eth_getBlockByNumber',
        'eth_getBlockByHash',
      ])
    } finally {
      steps.length = 0
    }
  }
})

test('x402 proof requires the exact finalized USDC authorization event and transfer together', async () => {
  const otherPayer = '0x2222222222222222222222222222222222222222'
  const receipt = (logs: Array<ReturnType<typeof transferLog> | ReturnType<typeof authorizationUsedLog>>) => ({
    status: '0x1',
    transactionHash: TX,
    blockHash: HASH,
    blockNumber: BLOCK_NUMBER,
    logs,
  })
  const classify = async (logs: Array<ReturnType<typeof transferLog> | ReturnType<typeof authorizationUsedLog>>) => {
    queueBase(
      result(receipt(logs)),
      result({ number: BLOCK_NUMBER }),
      result({ hash: HASH, number: BLOCK_NUMBER }),
      result({ hash: HASH, number: BLOCK_NUMBER, timestamp: '0x64' }),
    )
    return classifyUsdcTransfer(TX, RECOVERED, 1_000_000n, {
      expectedFrom: RECOVERED,
      exactAmount: true,
      expectedAuthorizationNonce: NONCE,
    })
  }

  for (const logs of [
    [transferLog(RECOVERED, RECOVERED, 1_000_000n)],
    [transferLog(RECOVERED, RECOVERED, 1_000_000n), authorizationUsedLog(otherPayer, NONCE)],
    [transferLog(RECOVERED, RECOVERED, 1_000_000n), authorizationUsedLog(RECOVERED, OTHER_NONCE)],
    [
      transferLog(RECOVERED, RECOVERED, 1_000_000n),
      { ...authorizationUsedLog(RECOVERED, NONCE), address: otherPayer },
    ],
  ]) {
    assert.equal((await classify(logs)).state, 'invalid_final')
  }

  const matched = await classify([
    authorizationUsedLog(RECOVERED, NONCE),
    transferLog(RECOVERED, RECOVERED, 1_000_000n),
  ])
  assert.equal(matched.state, 'matched')
  assert.equal(steps.length, 0)
})

test('a missing x402 authorization event remains retryable before finality', async () => {
  queueBase(
    result({
      status: '0x1',
      transactionHash: TX,
      blockHash: HASH,
      blockNumber: BLOCK_NUMBER,
      logs: [transferLog(RECOVERED, RECOVERED, 1_000_000n)],
    }),
    result({ number: '0xff' }),
  )

  assert.deepEqual(await classifyUsdcTransfer(TX, RECOVERED, 1_000_000n, {
    expectedFrom: RECOVERED,
    exactAmount: true,
    expectedAuthorizationNonce: NONCE,
  }), { state: 'pending' })
  assert.equal(steps.length, 0)
})

test('USDC proof names caller-invalid confirmed receipts and transfer requirements', async () => {

  queueBase(
    result({ status: '0x0', transactionHash: TX, blockHash: HASH, blockNumber: BLOCK_NUMBER, logs: [] }),
    result({ number: BLOCK_NUMBER }),
    result({ hash: HASH, number: BLOCK_NUMBER }),
    result({ hash: HASH, number: BLOCK_NUMBER, timestamp: '0x64' }),
  )
  const failed = await verifyUsdcTransfer(TX, RECOVERED, 1_000_000n)
  assert.equal(failed.status, 'invalid')
  assert.equal(failed.reason, 'transaction failed on Base')
  assert.equal(failed.finality?.blockHash, HASH)

  const toTopic = `0x${RECOVERED.slice(2).padStart(64, '0')}`
  queueBase(result({
    status: '0x1', transactionHash: TX, blockHash: HASH, blockNumber: BLOCK_NUMBER,
    logs: [
      { address: RECOVERED, topics: [TRANSFER_TOPIC, toTopic, toTopic], data: word('f4240') },
      { address: USDC, topics: [`0x${'99'.repeat(32)}`, toTopic, toTopic], data: word('f4240') },
      { address: USDC, topics: [TRANSFER_TOPIC, toTopic, `0x${'22'.repeat(32)}`], data: word('f4240') },
      { address: USDC, topics: [TRANSFER_TOPIC, toTopic, toTopic], data: word('1') },
    ],
  }), result({ number: BLOCK_NUMBER }), result({ hash: HASH, number: BLOCK_NUMBER }),
  result({ hash: HASH, number: BLOCK_NUMBER, timestamp: '0x64' }))
  const mismatch = await verifyUsdcTransfer(TX, RECOVERED, 1_000_000n)
  assert.equal(mismatch.status, 'invalid')
  assert.equal(mismatch.reason,
    `transaction did not transfer at least 1.000000 USDC on Base to ${RECOVERED}`)
  assert.equal(mismatch.finality?.blockHash, HASH)

  assert.equal(steps.length, 0)
})

test('a finalized mismatch carries its canonical block evidence into review handling', async () => {
  queueBase(
    result({ status: '0x0', transactionHash: TX, blockHash: HASH, blockNumber: BLOCK_NUMBER, logs: [] }),
    result({ number: BLOCK_NUMBER }),
    result({ hash: HASH, number: BLOCK_NUMBER }),
    result({ hash: HASH, number: BLOCK_NUMBER, timestamp: '0x64' }),
  )
  const observedAt = Date.now()
  const check = await classifyUsdcTransfer(TX, RECOVERED, 1_000_000n)
  assert.equal(check.state, 'invalid_final')
  if (check.state === 'invalid_final') {
    assert.equal(check.reason, 'failed_transaction')
    assert.equal(check.blockNumber, 256n)
    assert.equal(check.blockHash, HASH)
    assert.deepEqual(check.blockTime, new Date(100_000))
    assert.ok(check.finalizedAt.getTime() >= observedAt)
  }
  assert.equal(steps.length, 0)
})

test('USDC proof reports RPC transport, HTTP, JSON, shape, and block failures as retryable', async () => {
  for (const unavailable of [throws, failedHttp, invalidJson]) {
    queue(unavailable)
    const proof = await verifyUsdcTransfer(TX, RECOVERED, 1_000_000n)
    assert.equal(proof.status, 'unavailable')
    assert.match(proof.reason, /market.*check.*Base.*retry.*same proof/i)
  }

  queueBase(result({
    status: '0x1', transactionHash: TX, blockHash: HASH, blockNumber: BLOCK_NUMBER, logs: 'not-an-array',
  }))
  const malformedReceipt = await verifyUsdcTransfer(TX, RECOVERED, 1_000_000n)
  assert.equal(malformedReceipt.status, 'unavailable')
  assert.match(malformedReceipt.reason, /unreadable transaction receipt.*retry.*same proof/i)

  const toTopic = `0x${RECOVERED.slice(2).padStart(64, '0')}`
  queueBase(
    result({
      status: '0x1', transactionHash: TX, blockHash: HASH, blockNumber: BLOCK_NUMBER,
      logs: [{ address: USDC, topics: [TRANSFER_TOPIC, toTopic, toTopic], data: word('f4240') }],
    }),
    result({ number: BLOCK_NUMBER }),
    result({ hash: HASH, number: BLOCK_NUMBER }),
    result(null),
  )
  const missingBlock = await verifyUsdcTransfer(TX, RECOVERED, 1_000_000n)
  assert.equal(missingBlock.status, 'unavailable')
  assert.match(missingBlock.reason, /market.*check.*Base.*retry.*same proof/i)
  assert.equal(steps.length, 0)
})

test('USDC proof and treasury balance return normalized public facts on valid RPC replies', async () => {
  const toTopic = `0x${RECOVERED.slice(2).padStart(64, '0')}`
  queueBase(
    result({
      status: '0x1', transactionHash: TX, blockHash: HASH, blockNumber: BLOCK_NUMBER,
      logs: [{ address: USDC, topics: [TRANSFER_TOPIC, toTopic, toTopic], data: word('1e8480') }],
    }),
    result({ number: BLOCK_NUMBER }),
    result({ hash: HASH, number: BLOCK_NUMBER }),
    result({ hash: HASH, number: BLOCK_NUMBER, timestamp: '0x64' }),
  )
  const finalizedObservationStartedAt = Date.now()
  const transfer = await verifyUsdcTransfer(TX, RECOVERED, 1_000_000n)
  assert.equal(transfer.status, 'verified')
  if (transfer.status === 'verified') {
    assert.equal(transfer.transfer.from, RECOVERED)
    assert.equal(transfer.transfer.to, RECOVERED)
    assert.equal(transfer.transfer.amount, 2_000_000n)
    assert.deepEqual(transfer.transfer.blockTime, new Date(100_000))
    assert.equal(transfer.transfer.blockNumber, 256n)
    assert.equal(transfer.transfer.blockHash, HASH)
    assert.ok(transfer.transfer.finalizedAt.getTime() >= finalizedObservationStartedAt)
  }

  queue(result(null))
  assert.equal(await usdcBalance(RECOVERED), null)

  queue(result('0x1e8480'))
  assert.equal(await usdcBalance(RECOVERED), '2.000000')
  assert.equal(steps.length, 0)
  assert.ok(rpcCalls.some(call => call.method === 'eth_getBlockByHash'))
})
