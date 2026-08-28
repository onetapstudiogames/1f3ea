import test from 'node:test'
import assert from 'node:assert/strict'
import { dupHash, HANDLE_RE, newSecret, sha256, WALLET_RE } from '../src/core.ts'
import { toUnits } from '../src/chain.ts'

process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
const { paymentCustodyReady, requirements } = await import('../src/pay.ts')

test('secrets are prefixed, long, and unique', () => {
  const a = newSecret()
  const b = newSecret()
  assert.match(a, /^1f3ea_sk_[0-9a-f]{48}$/)
  assert.notEqual(a, b)
})

test('sha256 is stable', () => {
  assert.equal(sha256('1f3ea'), sha256('1f3ea'))
  assert.equal(sha256('a').length, 64)
})

test('dupHash ignores case, whitespace, punctuation', () => {
  assert.equal(dupHash('Hello World', 'the-artifact!'), dupHash('hello,   world', 'THE ARTIFACT'))
  assert.notEqual(dupHash('hello world', 'a'), dupHash('hello world', 'b'))
})

test('handle regex', () => {
  for (const good of ['abc', 'a1-b2', 'x'.repeat(32), '0-agent']) assert.match(good, HANDLE_RE)
  for (const bad of ['ab', '-abc', 'UPPER', 'has space', 'x'.repeat(33), 'emoji🏪']) assert.doesNotMatch(bad, HANDLE_RE)
})

test('wallet regex', () => {
  assert.match('0x3b9d230c9b995fb1a10add2d63ce37437916dcfd', WALLET_RE)
  assert.doesNotMatch('0x123', WALLET_RE)
  assert.doesNotMatch('3b9d230c9b995fb1a10add2d63ce37437916dcfd', WALLET_RE)
})

test('USDC units are exact at 6 decimals', () => {
  assert.equal(toUnits(1), 1_000_000n)
  assert.equal(toUnits(0.000001), 1n)
  assert.equal(toUnits(2.5), 2_500_000n)
  assert.equal(toUnits(9999.999999), 9_999_999_999n)
})

test('payment requirements carry the Base USDC EIP-712 domain', () => {
  const r = requirements('0x3b9d230c9b995fb1a10add2d63ce37437916dcfd', 1, 'https://1f3ea.com/api/listing', 'fee')
  assert.equal(r.scheme, 'exact')
  assert.equal(r.network, 'base')
  assert.equal(r.maxAmountRequired, '1000000')
  assert.equal(r.asset, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
  assert.deepEqual(r.extra, { name: 'USD Coin', version: '2' })
})

test('hosted market payments stay closed until durable custody is explicitly enabled', () => {
  assert.equal(paymentCustodyReady({}), true)
  assert.equal(paymentCustodyReady({ VERCEL: '1' }), false)
  assert.equal(paymentCustodyReady({ VERCEL_ENV: 'preview' }), false)
  assert.equal(paymentCustodyReady({ VERCEL_ENV: 'production' }), false)
  assert.equal(paymentCustodyReady({ NODE_ENV: 'production' }), false)
  assert.equal(
    paymentCustodyReady({ VERCEL_ENV: 'production', PAYMENT_CUSTODY_READY: '1' }),
    true,
  )
})
