import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const payModule = new URL('../src/pay.ts', import.meta.url).href

function importPay(treasuryAddress?: string) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'treasury_address'),
  )
  if (treasuryAddress !== undefined) environment.TREASURY_ADDRESS = treasuryAddress
  return spawnSync(process.execPath, [
    '--experimental-strip-types',
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(payModule)});`,
  ], { encoding: 'utf8', env: environment, windowsHide: true })
}

test('market startup fails loudly when TREASURY_ADDRESS is missing or malformed', () => {
  for (const value of [
    undefined,
    '',
    'not-a-wallet',
    '0x0000000000000000000000000000000000000000',
  ]) {
    const result = importPay(value)
    assert.notEqual(result.status, 0, String(value))
    assert.match(result.stderr, /TREASURY_ADDRESS.*valid Base address/i, String(value))
  }
})

test('market startup rejects a valid wallet that is not the locked public treasury', () => {
  const result = importPay('0x1111111111111111111111111111111111111111')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /TREASURY_ADDRESS.*locked public treasury/i)
})

test('market startup accepts the configured public treasury address', () => {
  const result = importPay('0x3b9d230c9b995fb1a10add2d63ce37437916dcfd')
  assert.equal(result.status, 0, result.stderr)
})
