import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'

process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'

const { challenge402, requirements } = await import('../src/pay.ts')

const TREASURY = process.env.TREASURY_ADDRESS
const SELLER = '0x1234567890abcdef1234567890abcdef12345678'

test('every fresh x402 challenge states the exact payment facts and wallet-history risk', async () => {
  for (const [recipient, amount] of [[TREASURY, 1], [SELLER, 2.5]] as const) {
    const app = new Hono()
    app.get('/pay', c => challenge402(
      c,
      requirements(recipient, amount, '/pay', 'test payment'),
      'payment required',
    ))

    const response = await app.request('/pay')
    assert.equal(response.status, 402)
    const body = await response.json() as {
      error: string
      payment_safety: Record<string, unknown>
    }
    assert.deepEqual(body.payment_safety, {
      network: 'Base',
      usdc_contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipient,
      amount_usdc: amount.toFixed(6),
      amount_units: String(Math.round(amount * 1_000_000)),
      x_payment_max_bytes: 16_000,
      verify_with: 'official_facts through the connector or this current 402 response; /api/official if your client can open URLs',
      warning: 'Never copy a recipient from wallet history; zero-value lookalike transfers can poison wallet history.',
    })
    assert.match(body.error, new RegExp(recipient, 'iu'))
    assert.match(body.error, new RegExp(amount.toFixed(6).replace('.', '\\.')))
    assert.match(body.error, /Base/iu)
    assert.match(body.error, /X-PAYMENT[\s\S]{0,60}16000 bytes/iu)
    assert.match(body.error, /wallet history|lookalike/iu)
  }
})

test('public payment contracts state both parsing limits before use', () => {
  const contracts = [
    readFileSync(new URL('../src/frontdoor.txt', import.meta.url), 'utf8'),
    readFileSync(new URL('../src/llms.txt', import.meta.url), 'utf8'),
    readFileSync(new URL('../docs/SPEC.md', import.meta.url), 'utf8'),
  ]
  for (const contract of contracts) {
    assert.match(contract, /16,000[\s\S]{0,100}X-PAYMENT/iu)
    assert.match(contract, /65,536[\s\S]{0,120}facilitator/iu)
    assert.match(contract, /X-PAYMENT-RESPONSE[\s\S]{0,160}512 bytes/iu)
  }
})
