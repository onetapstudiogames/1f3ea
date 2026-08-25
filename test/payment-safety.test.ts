import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'

const OFFICIAL_TREASURY = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
const SELLER = '0x1234567890abcdef1234567890abcdef12345678'
const previousTreasury = process.env.TREASURY_ADDRESS
delete process.env.TREASURY_ADDRESS
const { challenge402, requirements, TREASURY } = await import('../src/pay.ts')
const { mcp } = await import('../src/mcp.ts')
if (previousTreasury === undefined) delete process.env.TREASURY_ADDRESS
else process.env.TREASURY_ADDRESS = previousTreasury

test('an omitted treasury environment value uses the exact public market treasury', () => {
  assert.equal(TREASURY, OFFICIAL_TREASURY)
  assert.match(TREASURY, /^0x[0-9a-f]{40}$/u)
})

test('every x402 challenge names exact Base payment facts and the wallet-history poisoning risk', async () => {
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
      verify_with: 'this current 402 response or /api/official',
      warning: 'Never copy a recipient from wallet history; zero-value lookalike transfers can poison wallet history.',
    })
    assert.match(body.error, new RegExp(recipient, 'iu'))
    assert.match(body.error, new RegExp(amount.toFixed(6).replace('.', '\\.')))
    assert.match(body.error, /Base/iu)
    assert.match(body.error, /wallet history|lookalike/iu)
  }
})

test('public payment contracts repeat the safe source and finalized-proof rules', async () => {
  const publicContracts = [
    readFileSync(new URL('../src/frontdoor.txt', import.meta.url), 'utf8'),
    readFileSync(new URL('../src/llms.txt', import.meta.url), 'utf8'),
    readFileSync(new URL('../docs/SPEC.md', import.meta.url), 'utf8'),
  ]
  for (const contract of publicContracts) {
    assert.match(contract, /current 402[\s\S]{0,120}\/api\/official/iu)
    assert.match(contract, /wallet history/iu)
    assert.match(contract, /zero-value lookalike/iu)
    assert.match(
      contract,
      /direct(?:-| )(?:chain proof|transfer receipt)[\s\S]{0,120}canonical[\s\S]{0,40}finalized/iu,
    )
  }

  const decisions = readFileSync(new URL('../docs/DECISIONS.md', import.meta.url), 'utf8')
  assert.match(decisions, /parity-managed/iu)
  assert.match(decisions, /personal_sign/u)

  for (const hostedChat of [false, true]) {
    const market = new Hono()
    const gateway = new Hono()
    gateway.post('/mcp', c => mcp(c, market, { hostedChat }))
    const response = await gateway.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    const body = await response.json() as { result: { instructions: string } }
    assert.match(body.result.instructions, /current 402[\s\S]{0,120}\/api\/official/iu)
    assert.match(body.result.instructions, /wallet history/iu)
    assert.match(body.result.instructions, /zero-value lookalike/iu)
  }
})
