import test from 'node:test'
import assert from 'node:assert/strict'

const RECOVERED = '0x1111111111111111111111111111111111111111'
const HASH = '0x' + 'aa'.repeat(32)
const calls: { method: string; params: unknown[] }[] = []

globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
  const body = JSON.parse(init?.body ?? '{}') as { id: number; method: string; params: unknown[] }
  calls.push({ method: body.method, params: body.params })
  const result = body.method === 'web3_sha3'
    ? HASH
    : '0x' + '00'.repeat(12) + RECOVERED.slice(2)
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
    headers: { 'content-type': 'application/json' },
  })
}) as typeof fetch

const { recoverPersonalSigner, verifyPersonalSignature } = await import('../src/chain.ts')

const r = '01'.padStart(64, '0')
const s = '02'.padStart(64, '0')
const signature = `0x${r}${s}1b`

test('personal-sign recovery hashes the exact EIP-191 bytes and calls only the Base ecrecover precompile', async () => {
  calls.length = 0
  const message = '1F3EA intent\nexact fields'
  assert.equal(await recoverPersonalSigner(message, signature), RECOVERED)
  assert.equal(calls.length, 2)
  assert.equal(calls[0]!.method, 'web3_sha3')
  const prefixed = Buffer.concat([
    Buffer.from(`\x19Ethereum Signed Message:\n${Buffer.byteLength(message, 'utf8')}`, 'utf8'),
    Buffer.from(message, 'utf8'),
  ])
  assert.deepEqual(calls[0]!.params, [`0x${prefixed.toString('hex')}`])
  assert.equal(calls[1]!.method, 'eth_call')
  const call = calls[1]!.params[0] as { to: string; data: string }
  assert.equal(call.to, '0x0000000000000000000000000000000000000001')
  assert.equal(call.data, `0x${HASH.slice(2)}${'1b'.padStart(64, '0')}${r}${s}`)
  assert.equal(calls[1]!.params[1], 'latest')
})

test('personal-sign verification binds the recovered wallet case-insensitively', async () => {
  assert.equal(await verifyPersonalSignature('bound intent', signature, RECOVERED.toUpperCase()), true)
  assert.equal(await verifyPersonalSignature(
    'bound intent', signature, '0x2222222222222222222222222222222222222222',
  ), false)
})

test('malformed, invalid-v, zero-r, and high-s signatures fail closed without RPC work', async () => {
  const halfOrder = BigInt('0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0')
  const invalid = [
    'not-a-signature',
    `0x${r}${s}05`,
    `0x${'00'.repeat(32)}${s}1b`,
    `0x${r}${(halfOrder + 1n).toString(16).padStart(64, '0')}1b`,
  ]
  for (const candidate of invalid) {
    calls.length = 0
    assert.equal(await recoverPersonalSigner('bound intent', candidate), null)
    assert.equal(calls.length, 0)
  }
})
