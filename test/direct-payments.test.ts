import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DIRECT_PURCHASE_INTENT_TTL_MS,
  directPaymentWindowError,
  purchaseIntentChallenge,
  type DirectPurchaseIntent,
} from '../src/direct-payments.ts'

const intent: DirectPurchaseIntent = {
  id: 41,
  listing_id: 9,
  buyer: 'buyer-7',
  payer_wallet: '0x1111111111111111111111111111111111111111',
  seller_wallet: '0x2222222222222222222222222222222222222222',
  network: 'base',
  asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  minimum_amount_usdc: '1.250000',
  challenge_nonce: 'ab'.repeat(32),
  created_at: '2026-08-22T12:00:00.000Z',
  expires_at: '2026-08-22T12:10:00.000Z',
}

test('a direct purchase challenge binds every payment and identity field without the artifact', () => {
  assert.equal(DIRECT_PURCHASE_INTENT_TTL_MS, 10 * 60 * 1000)
  assert.equal(purchaseIntentChallenge(intent), [
    '1F3EA direct purchase intent v1',
    'intent: 41',
    'buyer: buyer-7',
    'listing: 9',
    'payer: 0x1111111111111111111111111111111111111111',
    'seller: 0x2222222222222222222222222222222222222222',
    'network: base',
    'asset: 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    'minimum_usdc: 1.250000',
    'created_at: 2026-08-22T12:00:00.000Z',
    'expires_at: 2026-08-22T12:10:00.000Z',
    `nonce: ${'ab'.repeat(32)}`,
    'This signature proves control of the payer wallet only. It does not move money.',
  ].join('\n'))
  assert.doesNotMatch(purchaseIntentChallenge(intent), /artifact|description|preview/i)
})

test('direct payment timing accepts both exact intent edges using one request-start time', () => {
  assert.equal(directPaymentWindowError(intent, new Date(intent.created_at), new Date(intent.expires_at)), null)
  assert.equal(directPaymentWindowError(intent, new Date(intent.expires_at), new Date(intent.expires_at)), null)
})

test('direct payment timing rejects proof before, after, or requested after its fixed window', () => {
  assert.equal(directPaymentWindowError(
    intent,
    new Date('2026-08-22T11:59:59.999Z'),
    new Date('2026-08-22T12:05:00.000Z'),
  ), 'payment predates this purchase intent')
  assert.equal(directPaymentWindowError(
    intent,
    new Date('2026-08-22T12:10:00.001Z'),
    new Date('2026-08-22T12:05:00.000Z'),
  ), 'payment is outside this purchase intent')
  assert.equal(directPaymentWindowError(
    intent,
    new Date('2026-08-22T12:09:59.000Z'),
    new Date('2026-08-22T12:10:00.001Z'),
  ), 'purchase intent expired before this request started')
})

test('direct payment timing fails closed on malformed stored dates', () => {
  assert.equal(directPaymentWindowError(
    { ...intent, created_at: 'not-a-date' },
    new Date('2026-08-22T12:05:00.000Z'),
    new Date('2026-08-22T12:05:00.000Z'),
  ), 'purchase intent has invalid timing')
})

test('direct payment timing rejects a request start that predates its intent', () => {
  assert.equal(directPaymentWindowError(
    intent,
    new Date('2026-08-22T12:05:00.000Z'),
    new Date('2026-08-22T11:59:59.999Z'),
  ), 'purchase intent has invalid timing')
})
