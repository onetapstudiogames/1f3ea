// Redemption side of pairing: POST /oauth/authorize action=pair (reserve), then
// action=confirm_pair (redeem). Split into two steps so the human sees which merchant a code
// names before anything is granted. The mint side (POST /api/pair) is covered in
// test/market-pairing.test.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { PairingReservation, ResolvedPairingCode } from '../src/market-pairing-store.ts'
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
const RESERVED_HANDLE = 'tinylantern'

async function startSignin(app: Awaited<ReturnType<typeof fixture>>['app']) {
  const start = await app.request(authorizationUrl())
  assert.equal(start.status, 200)
  const html = await start.text()
  return { html, cookie: cookiePair(start), csrf: hiddenCsrf(html) }
}

function formRequest(
  app: Awaited<ReturnType<typeof fixture>>['app'],
  cookie: string,
  fields: Record<string, string>,
) {
  return app.request('/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, cookie },
    body: new URLSearchParams(fields),
  })
}

function pairRequest(
  app: Awaited<ReturnType<typeof fixture>>['app'],
  cookie: string,
  csrf: string,
  pairingCode: string,
) {
  return formRequest(app, cookie, { action: 'pair', csrf, pairing_code: pairingCode })
}

function confirmPairRequest(
  app: Awaited<ReturnType<typeof fixture>>['app'],
  cookie: string,
  csrf: string,
) {
  return formRequest(app, cookie, { action: 'confirm_pair', csrf })
}

test('the consent page offers a pairing-code panel that never asks for the merchant key', async () => {
  const { app } = fixture()
  const { html } = await startSignin(app)
  assert.match(html, /name="action" value="pair"/u)
  assert.match(html, /name="pairing_code"/u)
  assert.doesNotMatch(html, /1f3ea_sk_[0-9a-f]{48}/u)
})

test('reserving a valid pairing code shows which merchant it names, without granting anything yet', async () => {
  const { app } = fixture({
    reservePairingCode: async (input): Promise<PairingReservation | null> => {
      assert.match(input.codeHash, /^[0-9a-f]{64}$/u)
      assert.equal(input.codeHash, sha256(PAIRING_CODE))
      return { merchantId: 7, handle: RESERVED_HANDLE, expiresAt: '2026-09-02T00:10:00.000Z' }
    },
  })
  const { cookie, csrf } = await startSignin(app)
  const response = await pairRequest(app, cookie, csrf, PAIRING_CODE)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('location'), null)
  const html = await response.text()
  assert.match(html, new RegExp(`@${RESERVED_HANDLE}`, 'u'))
  assert.match(html, /name="action" value="confirm_pair"/u)
  // Confirming re-uses the same csrf handed back on the page — no code re-entry.
  assert.equal(hiddenCsrf(html), csrf)
})

test('confirming a reservation issues the authorization code without ever sending the key', async () => {
  const { app } = fixture({
    reservePairingCode: async () => ({ merchantId: 7, handle: RESERVED_HANDLE, expiresAt: '2026-09-02T00:10:00.000Z' }),
    takeReservedPairingCode: async () => ({ codeHash: sha256(PAIRING_CODE) }),
    resolvePairingCode: async (input): Promise<ResolvedPairingCode | null> => {
      assert.equal(input.codeHash, sha256(PAIRING_CODE))
      return { merchantId: 7, merchantSecretHash: sha256(MERCHANT_KEY) }
    },
  })
  const { cookie, csrf } = await startSignin(app)
  const reserved = await pairRequest(app, cookie, csrf, PAIRING_CODE)
  assert.equal(reserved.status, 200)

  const response = await confirmPairRequest(app, cookie, csrf)
  assert.equal(response.status, 302)
  const location = new URL(response.headers.get('location')!)
  assert.ok(location.searchParams.get('code'))
})

test('confirming without a live reservation is refused the same way a bad code would be', async () => {
  const { app } = fixture({
    takeReservedPairingCode: async () => null,
  })
  const { cookie, csrf } = await startSignin(app)
  // No prior "pair" call, so nothing was ever reserved.
  const response = await confirmPairRequest(app, cookie, csrf)
  assert.equal(response.status, 403)
  assert.match(await response.text(), /could not be verified, was already used, or expired/iu)
})

test('an expired, used, or unknown pairing code is refused at the reserve step, without a redirect', async () => {
  const { app } = fixture({ reservePairingCode: async () => null })
  const { cookie, csrf } = await startSignin(app)
  const response = await pairRequest(app, cookie, csrf, PAIRING_CODE)
  assert.equal(response.status, 403)
  assert.match(await response.text(), /could not be verified, was already used, or expired/iu)
})

test('a malformed pairing code is refused before any reservation attempt', async () => {
  let called = false
  const { app } = fixture({ reservePairingCode: async () => { called = true; return null } })
  const { cookie, csrf } = await startSignin(app)
  const response = await pairRequest(app, cookie, csrf, 'not-a-real-code')
  assert.equal(response.status, 403)
  assert.equal(called, false)
})

// This in-memory harness cannot prove "a code minted before rotation is refused after it" —
// resolveAndConsumePairingCode (market-pairing-store.ts), which the confirm step calls, always
// reads the merchant's CURRENT secret hash fresh, so a resolver faked to return a hash
// mismatched from the merchant it names is a scenario the real store can never produce. That
// real, store-level proof lives in test/integration/market-identity-postgres.test.ts ("rotation
// invalidates every outstanding pairing code, against the real store" and its recovery
// counterpart). What this harness can still test honestly is the door's own refusal once a
// resolved grant matches no merchant it knows about — the same "merchant_key_rejected" outcome,
// reached without any claim about why. Reservation itself succeeds and shows a handle; only the
// final confirm-time resolution is the mismatch this test is about.
test('a resolved pairing grant matching no current merchant is refused, not treated as a stale key', async () => {
  const { app } = fixture({
    reservePairingCode: async () => ({ merchantId: 999, handle: RESERVED_HANDLE, expiresAt: '2026-09-02T00:10:00.000Z' }),
    takeReservedPairingCode: async () => ({ codeHash: sha256(PAIRING_CODE) }),
    resolvePairingCode: async () => ({ merchantId: 999, merchantSecretHash: sha256('no-such-merchant-key') }),
  })
  const { cookie, csrf } = await startSignin(app)
  const reserved = await pairRequest(app, cookie, csrf, PAIRING_CODE)
  assert.equal(reserved.status, 200)

  const response = await confirmPairRequest(app, cookie, csrf)
  assert.equal(response.status, 403)
  assert.match(await response.text(), /no longer matches a current merchant key/iu)
})

test('a repeated confirm click after success cannot redeem or approve a second time', async () => {
  const { app } = fixture({
    reservePairingCode: async () => ({ merchantId: 7, handle: RESERVED_HANDLE, expiresAt: '2026-09-02T00:10:00.000Z' }),
    takeReservedPairingCode: async () => ({ codeHash: sha256(PAIRING_CODE) }),
    resolvePairingCode: async () => ({ merchantId: 7, merchantSecretHash: sha256(MERCHANT_KEY) }),
  })
  const { cookie, csrf } = await startSignin(app)
  await pairRequest(app, cookie, csrf, PAIRING_CODE)

  const first = await confirmPairRequest(app, cookie, csrf)
  assert.equal(first.status, 302)

  // The sign-in request itself is now used up (approveExistingMerchantAndIssueAuthorizationCode
  // consumed it), so a second confirm click never even gets far enough to re-take the
  // reservation — it hits the same terminal-request refusal any other repeated action would.
  const second = await confirmPairRequest(app, cookie, csrf)
  assert.equal(second.status, 403)
  assert.match(await second.text(), /already completed|already used|no longer available/iu)
})
