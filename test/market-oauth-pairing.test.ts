// Redemption side of pairing: POST /oauth/authorize action=pair. The mint side (POST
// /api/pair) is covered in test/market-pairing.test.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ResolvedPairingCode } from '../src/market-pairing-store.ts'
import {
  ORIGIN,
  authorizationUrl,
  cookiePair,
  fixture,
  hiddenCsrf,
  sha256,
} from './support/market-oauth-flow-harness.ts'

const MERCHANT_KEY = `1f3ea_sk_${'ab'.repeat(24)}`
const PAIRING_CODE = `1f3ea_pc_${'11'.repeat(24)}`

async function startSignin(app: Awaited<ReturnType<typeof fixture>>['app']) {
  const start = await app.request(authorizationUrl())
  assert.equal(start.status, 200)
  const html = await start.text()
  return { html, cookie: cookiePair(start), csrf: hiddenCsrf(html) }
}

function pairRequest(
  app: Awaited<ReturnType<typeof fixture>>['app'],
  cookie: string,
  csrf: string,
  pairingCode: string,
) {
  return app.request('/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, cookie },
    body: new URLSearchParams({ action: 'pair', csrf, pairing_code: pairingCode }),
  })
}

test('the consent page offers a pairing-code panel that never asks for the merchant key', async () => {
  const { app } = fixture()
  const { html } = await startSignin(app)
  assert.match(html, /name="action" value="pair"/u)
  assert.match(html, /name="pairing_code"/u)
  assert.doesNotMatch(html, /1f3ea_sk_[0-9a-f]{48}/u)
})

test('a valid pairing code links the connector grant to the merchant without ever sending the key', async () => {
  const { app } = fixture({
    resolvePairingCode: async (input: { codeHash: string }): Promise<ResolvedPairingCode | null> => {
      assert.match(input.codeHash, /^[0-9a-f]{64}$/u)
      assert.equal(input.codeHash, sha256(PAIRING_CODE))
      return { merchantId: 7, merchantSecretHash: sha256(MERCHANT_KEY) }
    },
  })
  const { cookie, csrf } = await startSignin(app)
  const response = await pairRequest(app, cookie, csrf, PAIRING_CODE)
  assert.equal(response.status, 302)
  const location = new URL(response.headers.get('location')!)
  assert.ok(location.searchParams.get('code'))
})

test('an expired, used, or unknown pairing code is refused without a redirect', async () => {
  const { app } = fixture({ resolvePairingCode: async () => null })
  const { cookie, csrf } = await startSignin(app)
  const response = await pairRequest(app, cookie, csrf, PAIRING_CODE)
  assert.equal(response.status, 403)
  assert.match(await response.text(), /could not be verified, was already used, or expired/iu)
})

test('a malformed pairing code is refused before any resolution attempt', async () => {
  let called = false
  const { app } = fixture({ resolvePairingCode: async () => { called = true; return null } })
  const { cookie, csrf } = await startSignin(app)
  const response = await pairRequest(app, cookie, csrf, 'not-a-real-code')
  assert.equal(response.status, 403)
  assert.equal(called, false)
})

test('a pairing code whose merchant key has since rotated fails closed, never falling back to a stale key', async () => {
  const { app } = fixture({
    resolvePairingCode: async () => ({ merchantId: 7, merchantSecretHash: sha256('some-other-now-stale-key') }),
  })
  const { cookie, csrf } = await startSignin(app)
  const response = await pairRequest(app, cookie, csrf, PAIRING_CODE)
  assert.equal(response.status, 403)
  assert.match(await response.text(), /no longer matches a current merchant key/iu)
})
