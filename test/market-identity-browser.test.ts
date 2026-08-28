import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sha256 } from '../src/core.ts'
import {
  MARKET_RECOVERY_CODE_PREFIX,
  collectMarketRecoveryCodeSet,
} from '../src/recovery-codes.ts'
import type { MarketIdentityStore } from '../src/market-identity-store.ts'
import {
  MERCHANT_KEY,
  ORIGIN,
  OTHER_MERCHANT_KEY,
  assertPrivate,
  brokenPost,
  credentials,
  harness,
  memoryStore,
  pageState,
  postBody,
  postForm,
  type AttemptKind,
} from './support/market-identity-browser-harness.ts'

test('identity pages are private, independently gated, market-voiced, and honest about hosted sign-in', async () => {
  const dormant = harness()
  const join = await pageState(dormant.app, '/join')
  assertPrivate(join.response)
  assert.match(join.setCookie, /__Host-1f3ea_join=.*Max-Age=1800; Secure; HttpOnly; SameSite=Lax/iu)
  assert.doesNotMatch(join.html, /Gentry/iu)
  for (const clientClass of [
    'hosted_connector', 'hosted_browser', 'coding_persistent', 'coding_ephemeral', 'oauth_refused',
  ]) assert.match(join.html, new RegExp(`data-client-class="${clientClass}"`, 'u'))
  const dormantPath = join.html.match(
    /<div class="client-path" data-client-class="hosted_connector">([\s\S]*?)<\/div>/u,
  )?.[1] ?? ''
  assert.match(dormantPath, /unavailable on this deployment|not ready on this deployment/iu)
  assert.match(dormantPath, /do not add (?:it|a connector)/iu)
  assert.match(dormantPath, /front door[\s\S]*shop window/iu)
  assert.doesNotMatch(dormantPath, /\/mcp\/connect/u)
  assert.equal((await dormant.app.request('/rotate')).status, 404)
  assert.equal((await dormant.app.request('/recovery')).status, 404)

  const active = harness({
    environment: {
      MARKET_IDENTITY_ROTATION_ENABLED: 'true',
      MARKET_IDENTITY_RECOVERY_ENABLED: 'true',
    },
    hostedMarketSigninReady: true,
  })
  const readyJoin = await pageState(active.app, '/join')
  const readyPath = readyJoin.html.match(
    /<div class="client-path" data-client-class="hosted_connector">([\s\S]*?)<\/div>/u,
  )?.[1] ?? ''
  assert.match(readyPath, new RegExp(`${ORIGIN}/mcp/connect`, 'u'))
  assert.match(readyPath, /private sign-in page|keeps the merchant key out of chat/iu)
  assert.doesNotMatch(readyPath, /unavailable|not ready/iu)

  const rotation = await pageState(active.app, '/rotate')
  const recovery = await pageState(active.app, '/recovery')
  for (const page of [rotation, recovery]) {
    assertPrivate(page.response)
    assert.doesNotMatch(page.html, /Gentry/iu)
  }
  assert.match(rotation.setCookie, /__Host-1f3ea_rotate=/u)
  assert.match(recovery.setCookie, /__Host-1f3ea_recovery=/u)
  assert.match(rotation.html, /5 successful rotations[^.]*merchant[^.]*UTC day/iu)
  assert.match(rotation.html, /begin 5 rotations[^.]*per IP[^.]*UTC hour/iu)
  assert.match(rotation.html, /10[^.]*confirmation[^.]*IP and session[^.]*UTC hour/iu)
  assert.match(recovery.html, /5[^.]*recovery sets?[^.]*per IP[^.]*UTC hour/iu)
  assert.match(recovery.html, /10[^.]*recoveries[^.]*per IP[^.]*UTC hour/iu)
})

test('join reads actual bytes, ignores Content-Length claims, and rejects ambiguous forms before secrets', async () => {
  for (const contentLength of [undefined, '0', '999999']) {
    const { app } = harness()
    const start = await pageState(app, '/join')
    const headers: Record<string, string> = {}
    if (contentLength !== undefined) headers['content-length'] = contentLength
    const response = await postForm(app, '/join', start.cookie, {
      action: 'stage', csrf: start.csrf, handle: `bytes-${contentLength ?? 'missing'}`,
      model: '', client_class: 'coding_ephemeral',
    }, headers)
    assert.equal(response.status, 200, `Content-Length ${contentLength ?? 'missing'}`)
    assert.equal(credentials(await response.text()).length, 9)
  }

  const rejectedCases: Array<{
    body: URLSearchParams | string
    headers?: Record<string, string>
    cookie?: string
  }> = []
  const { app, memory } = harness()
  const start = await pageState(app, '/join')
  rejectedCases.push(
    {
      body: new URLSearchParams({
        action: 'stage', csrf: start.csrf, handle: 'cross-site', model: '',
        client_class: 'coding_persistent',
      }),
      headers: { origin: 'https://attacker.invalid' },
    },
    {
      body: new URLSearchParams(
        `action=stage&csrf=${start.csrf}&handle=extra-field&model=&client_class=coding_persistent&extra=1`,
      ),
    },
    {
      body: new URLSearchParams(
        `action=stage&action=confirm&csrf=${start.csrf}&handle=duplicate&model=&client_class=coding_persistent`,
      ),
    },
    {
      body: new URLSearchParams({
        action: 'stage', csrf: start.csrf, handle: 'bad-cookie', model: '',
        client_class: 'coding_persistent',
      }),
      cookie: '__Host-1f3ea_join=bad',
    },
    { body: `action=stage&csrf=${start.csrf}&handle=${'x'.repeat(9_000)}` },
  )

  for (const candidate of rejectedCases) {
    const response = await postBody(
      app, '/join', candidate.cookie ?? start.cookie, candidate.body, candidate.headers,
    )
    assert.ok([400, 403].includes(response.status))
    const body = await response.text()
    assert.equal(credentials(body).length, 0)
    assert.doesNotMatch(body, /Gentry/iu)
    assertPrivate(response)
  }
  assert.equal(memory.calls.some(call => call.method === 'stageRegistration'), false)
})

test('broken form streams are transient on join, rotation, and recovery without credential echo', async () => {
  const { app } = harness({ environment: {
    MARKET_IDENTITY_ROTATION_ENABLED: 'true', MARKET_IDENTITY_RECOVERY_ENABLED: 'true',
  } })
  for (const path of ['/join', '/rotate', '/recovery'] as const) {
    const start = await pageState(app, path)
    const response = await brokenPost(app, path, start.cookie)
    assert.equal(response.status, 503, path)
    assert.equal(response.headers.get('retry-after'), '1', path)
    assertPrivate(response)
    assert.equal(credentials(await response.text()).length, 0, path)
  }
})

test('join stages hashes, reveals one credential set once, resumes, and creates only after exact re-entry', async () => {
  const { app, memory } = harness({
    environment: { MARKET_IDENTITY_ROTATION_ENABLED: 'true' },
  })
  const start = await pageState(app, '/join')
  assert.match(start.html, /3[^.]*join starts?[^.]*per IP[^.]*UTC hour/iu)
  assert.match(start.html, /300[^.]*total[^.]*UTC hour/iu)
  assert.match(start.html, /15 minutes/iu)
  assert.match(start.html, /No merchant[^.]*exists until[^.]*key[^.]*re-entered/iu)

  const stagedResponse = await postForm(app, '/join', start.cookie, {
    action: 'stage', csrf: start.csrf, handle: 'new-merchant', model: 'test-model',
    client_class: 'coding_ephemeral',
  }, { 'x-forwarded-for': 'spoofed', 'x-vercel-forwarded-for': 'edge, 203.0.113.7' })
  assert.equal(stagedResponse.status, 200)
  const stagedBody = await stagedResponse.text()
  const stagedCredentials = credentials(stagedBody)
  const merchantKey = stagedCredentials.find(value => value.startsWith('1f3ea_sk_'))
  const recoveryCodes = stagedCredentials.filter(value => value.startsWith('1f3ea_rc_'))
  assert.ok(merchantKey)
  assert.equal(recoveryCodes.length, 8)
  assert.equal(new Set(recoveryCodes).size, 8)
  assert.ok(stagedBody.indexOf('Step 1') < stagedBody.indexOf(merchantKey))
  assert.ok(stagedBody.indexOf(merchantKey) < stagedBody.indexOf('Step 2'))
  assert.ok(stagedBody.indexOf('Step 2') < stagedBody.indexOf(recoveryCodes[0]!))
  assert.ok(stagedBody.indexOf(recoveryCodes[0]!) < stagedBody.indexOf('Step 3'))
  assert.match(stagedBody, /Write the value above to durable storage now, before submitting/iu)
  assert.match(stagedBody, /next page[^.]*does not contain the key/iu)
  assert.equal(memory.confirmed(), false)
  assert.equal(memory.registration()?.merchantSecretHash, sha256(merchantKey))
  assert.deepEqual(memory.registration()?.recoveryCodeHashes, recoveryCodes.map(sha256))
  assert.doesNotMatch(JSON.stringify(memory.calls), new RegExp(merchantKey, 'u'))
  for (const code of recoveryCodes) assert.doesNotMatch(JSON.stringify(memory.calls), new RegExp(code, 'u'))

  const resumed = await app.request('/join', { headers: { cookie: start.cookie } })
  const resumedBody = await resumed.text()
  assert.equal(resumed.status, 200)
  assert.match(resumedBody, /continue creating|where you stopped/iu)
  assert.match(resumedBody, /If you saved the key and all eight codes/iu)
  assert.equal(credentials(resumedBody).length, 0)

  const repeatedStage = await postForm(app, '/join', start.cookie, {
    action: 'stage', csrf: start.csrf, handle: 'new-merchant', model: 'test-model',
    client_class: 'coding_ephemeral',
  })
  assert.equal(repeatedStage.status, 200)
  assert.equal(credentials(await repeatedStage.text()).length, 0)
  assert.equal(memory.calls.filter(call => call.method === 'stageRegistration').length, 1)

  const wrong = await postForm(app, '/join', start.cookie, {
    action: 'confirm', csrf: start.csrf, merchant_key: OTHER_MERCHANT_KEY,
  })
  assert.equal(wrong.status, 403)
  const wrongBody = await wrong.text()
  assert.match(wrongBody, /saved merchant key could not be verified/iu)
  assert.match(wrongBody, /name="action" value="confirm"/u)
  assert.equal(credentials(wrongBody).length, 0)
  assert.equal(memory.confirmed(), false)

  const confirmed = await postForm(app, '/join', start.cookie, {
    action: 'confirm', csrf: start.csrf, merchant_key: merchantKey,
  })
  assert.equal(confirmed.status, 200)
  const confirmedBody = await confirmed.text()
  assert.match(confirmedBody, /new-merchant[^<]*(?:open|runs|has) (?:a )?store|new-merchant[^<]*merchant/iu)
  assert.match(confirmedBody, /saved merchant key is active/iu)
  assert.equal(credentials(confirmedBody).length, 0)
  assert.equal(memory.confirmed(), true)

  const rotationStart = await pageState(app, '/rotate')
  const stagedRotation = await postForm(app, '/rotate', rotationStart.cookie, {
    action: 'begin', csrf: rotationStart.csrf, merchant_key: merchantKey,
  })
  const replacement = credentials(await stagedRotation.text())[0]
  if (!replacement) assert.fail('rotation must reveal one replacement key')
  assert.ok(replacement.startsWith('1f3ea_sk_'))
  assert.equal((await postForm(app, '/rotate', rotationStart.cookie, {
    action: 'confirm', csrf: rotationStart.csrf, merchant_key: replacement,
  })).status, 200)
  const oldJoin = await app.request('/join', { headers: { cookie: start.cookie } })
  const oldJoinBody = await oldJoin.text()
  assert.match(oldJoinBody, /became active when this merchant was created/iu)
  assert.match(oldJoinBody, /later key or recovery change may have replaced it/iu)
  assert.equal(credentials(oldJoinBody).length, 0)

  const rateInputs = memory.calls
    .filter(call => call.method === 'rate')
    .map(call => call.input as { bucketHash: string; attemptKind: AttemptKind; maximum: number })
  assert.ok(rateInputs.some(input => input.attemptKind === 'join_stage' && input.maximum === 3))
  assert.ok(rateInputs.some(input => input.attemptKind === 'join_stage' && input.maximum === 300))
  assert.ok(rateInputs.some(input => input.attemptKind === 'join_confirm' && input.maximum === 10))
  assert.equal(rateInputs.every(input => /^[0-9a-f]{64}$/u.test(input.bucketHash)), true)
  assert.doesNotMatch(JSON.stringify(rateInputs), /203\.0\.113\.7|spoofed/u)
})

test('overlapping stage and confirmation races never disclose the wrong credential outcome', async () => {
  let arrivals = 0
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const memory = memoryStore({
    stageBarrier: async () => {
      arrivals += 1
      if (arrivals === 2) release()
      await gate
    },
  })
  const stagedHarness = harness({ memory })
  const start = await pageState(stagedHarness.app, '/join')
  const stageValues = {
    action: 'stage', csrf: start.csrf, handle: 'overlap-merchant', model: '',
    client_class: 'coding_ephemeral',
  }
  const responses = await Promise.all([
    postForm(stagedHarness.app, '/join', start.cookie, stageValues),
    postForm(stagedHarness.app, '/join', start.cookie, stageValues),
  ])
  const bodies = await Promise.all(responses.map(response => response.text()))
  const secretSets = bodies.map(credentials)
  assert.deepEqual(responses.map(response => response.status), [200, 200])
  assert.deepEqual(secretSets.map(secrets => secrets.length).sort((a, b) => a - b), [0, 9])
  const revealed = secretSets.find(secrets => secrets.length === 9)!
  assert.equal(memory.registration()?.merchantSecretHash, sha256(revealed[0]!))
  assert.deepEqual(memory.registration()?.recoveryCodeHashes, revealed.slice(1).map(sha256))

  const raceMemory = memoryStore({
    registrationConfirmHandleTaken: true,
    confirmationRaceCompleted: true,
  })
  const race = harness({ memory: raceMemory })
  const raceStart = await pageState(race.app, '/join')
  const stage = await postForm(race.app, '/join', raceStart.cookie, {
    action: 'stage', csrf: raceStart.csrf, handle: 'confirmation-winner', model: '',
    client_class: 'coding_persistent',
  })
  const key = credentials(await stage.text()).find(value => value.startsWith('1f3ea_sk_'))
  assert.ok(key)
  const confirmed = await postForm(race.app, '/join', raceStart.cookie, {
    action: 'confirm', csrf: raceStart.csrf, merchant_key: key,
  })
  assert.equal(confirmed.status, 200)
  const confirmedBody = await confirmed.text()
  assert.match(confirmedBody, /confirmation-winner[^<]*runs a store/iu)
  assert.equal(credentials(confirmedBody).length, 0)
})

test('eight recovery codes stay unique or generation fails closed', () => {
  const draws = [1, 1, 2, 3, 4, 5, 6, 7, 8]
  let index = 0
  const codes = collectMarketRecoveryCodeSet(() =>
    `${MARKET_RECOVERY_CODE_PREFIX}${(draws[index++] ?? 255).toString(16).padStart(64, '0')}`)
  assert.equal(codes.length, 8)
  assert.equal(new Set(codes).size, 8)
  assert.equal(index, 9)
  assert.throws(
    () => collectMarketRecoveryCodeSet(() => `${MARKET_RECOVERY_CODE_PREFIX}${'0'.repeat(64)}`),
    /secure recovery-code generation failed/iu,
  )
})

test('rotation stages hashes and activates a replacement only after exact re-entry', async () => {
  const { app, memory } = harness({
    environment: { MARKET_IDENTITY_ROTATION_ENABLED: 'true' },
  })
  const start = await pageState(app, '/rotate')
  const staged = await postForm(app, '/rotate', start.cookie, {
    action: 'begin', csrf: start.csrf, merchant_key: MERCHANT_KEY,
  })
  assert.equal(staged.status, 200)
  const stagedBody = await staged.text()
  const replacement = credentials(stagedBody).find(value => value.startsWith('1f3ea_sk_'))
  assert.ok(replacement)
  assert.notEqual(replacement, MERCHANT_KEY)
  assert.match(stagedBody, /shown once/iu)
  assert.match(stagedBody, /before submitting/iu)
  assert.equal(memory.stagedRotation()?.merchantSecretHash, sha256(MERCHANT_KEY))
  assert.equal(memory.stagedRotation()?.replacementSecretHash, sha256(replacement))
  assert.doesNotMatch(JSON.stringify(memory.calls), new RegExp(replacement, 'u'))
  const resumed = await app.request('/rotate', { headers: { cookie: start.cookie } })
  assert.match(await resumed.text(), /cannot show the replacement key again|saved replacement key/iu)
  assert.match(resumed.headers.get('set-cookie') ?? '', new RegExp(start.cookie.replace('.', '\\.'), 'u'))

  const wrong = await postForm(app, '/rotate', start.cookie, {
    action: 'confirm', csrf: start.csrf, merchant_key: OTHER_MERCHANT_KEY,
  })
  assert.equal(wrong.status, 403)
  assert.match(await wrong.text(), /replacement merchant key could not be verified/iu)
  assert.equal(memory.currentSecretHash(), sha256(MERCHANT_KEY))

  const confirmed = await postForm(app, '/rotate', start.cookie, {
    action: 'confirm', csrf: start.csrf, merchant_key: replacement,
  })
  assert.equal(confirmed.status, 200)
  assert.match(await confirmed.text(), /key is rotated|key was rotated/iu)
  assert.match(confirmed.headers.get('set-cookie') ?? '', /__Host-1f3ea_rotate=;.*Max-Age=0/iu)
  assert.equal(memory.currentSecretHash(), sha256(replacement))
  const retried = await postForm(app, '/rotate', start.cookie, { action: 'confirm', csrf: start.csrf, merchant_key: replacement })
  const retriedBody = await retried.text()
  assert.match(retriedBody, /rotation succeeded/iu)
  assert.match(retriedBody, /became active when this ceremony completed/iu)
  assert.match(retriedBody, /later key or recovery change may have replaced it/iu)
  assert.equal(credentials(retriedBody).length, 0)
  const rates = memory.calls.filter(call => call.method === 'rate')
    .map(call => call.input as { attemptKind: AttemptKind; maximum: number })
  assert.ok(rates.some(input => input.attemptKind === 'rotation_begin' && input.maximum === 5))
  assert.ok(rates.some(input => input.attemptKind === 'rotation_confirm' && input.maximum === 10))
})

test('recovery generation and replacement reveal plaintext only on their one private pages', async () => {
  const { app, memory } = harness({
    environment: { MARKET_IDENTITY_RECOVERY_ENABLED: 'true' },
  })
  const generationStart = await pageState(app, '/recovery')
  const generated = await postForm(app, '/recovery', generationStart.cookie, {
    action: 'generate', csrf: generationStart.csrf, merchant_key: MERCHANT_KEY,
  })
  assert.equal(generated.status, 200)
  const generatedBody = await generated.text()
  const codes = credentials(generatedBody).filter(value => value.startsWith('1f3ea_rc_'))
  assert.equal(codes.length, 8)
  assert.deepEqual(memory.recoveryCodeHashes(), codes.map(sha256))
  assert.doesNotMatch(JSON.stringify(memory.calls), /1f3ea_rc_/u)
  assert.match(generatedBody, /shown once/iu)

  const recoveryStart = await pageState(app, '/recovery')
  const staged = await postForm(app, '/recovery', recoveryStart.cookie, {
    action: 'begin', csrf: recoveryStart.csrf, recovery_code: codes[0]!,
  })
  assert.equal(staged.status, 200)
  const stagedBody = await staged.text()
  const replacement = credentials(stagedBody).find(value => value.startsWith('1f3ea_sk_'))
  assert.ok(replacement)
  assert.match(stagedBody, /shown once/iu)
  assert.match(stagedBody, /before submitting/iu)
  assert.equal(memory.stagedRecovery()?.recoveryCodeHash, sha256(codes[0]!))
  assert.equal(memory.stagedRecovery()?.replacementSecretHash, sha256(replacement))
  const resumed = await app.request('/recovery', { headers: { cookie: recoveryStart.cookie } })
  assert.match(await resumed.text(), /cannot show the replacement key again|saved replacement key/iu)
  assert.match(resumed.headers.get('set-cookie') ?? '', new RegExp(recoveryStart.cookie.replace('.', '\\.'), 'u'))

  const wrong = await postForm(app, '/recovery', recoveryStart.cookie, {
    action: 'confirm', csrf: recoveryStart.csrf, merchant_key: OTHER_MERCHANT_KEY,
  })
  assert.equal(wrong.status, 403)
  assert.match(await wrong.text(), /replacement merchant key could not be verified/iu)
  assert.equal(memory.currentSecretHash(), sha256(MERCHANT_KEY))

  const confirmed = await postForm(app, '/recovery', recoveryStart.cookie, {
    action: 'confirm', csrf: recoveryStart.csrf, merchant_key: replacement,
  })
  assert.equal(confirmed.status, 200)
  assert.match(await confirmed.text(), /recovered|key is replaced/iu)
  assert.equal(memory.currentSecretHash(), sha256(replacement))
  assert.deepEqual(memory.recoveryCodeHashes(), [])
  const retried = await postForm(app, '/recovery', recoveryStart.cookie, { action: 'confirm', csrf: recoveryStart.csrf, merchant_key: replacement })
  const retriedBody = await retried.text()
  assert.match(retriedBody, /recovery succeeded/iu)
  assert.match(retriedBody, /became active when this ceremony completed/iu)
  assert.match(retriedBody, /later key or recovery change may have replaced it/iu)
  assert.equal(credentials(retriedBody).length, 0)
  const rates = memory.calls.filter(call => call.method === 'rate')
    .map(call => call.input as { attemptKind: AttemptKind; maximum: number })
  assert.ok(rates.some(input => input.attemptKind === 'recovery_generate' && input.maximum === 5))
  assert.ok(rates.some(input => input.attemptKind === 'recovery_begin' && input.maximum === 10))
  assert.ok(rates.some(input => input.attemptKind === 'recovery_confirm' && input.maximum === 10))
})

test('rate denials and cancellations keep old credentials active and return no new secret', async () => {
  for (const attemptKind of ['join_stage', 'rotation_begin', 'recovery_begin'] as const) {
    const memory = memoryStore({ deniedAttemptKind: attemptKind })
    const { app } = harness({
      memory,
      environment: {
        MARKET_IDENTITY_ROTATION_ENABLED: 'true',
        MARKET_IDENTITY_RECOVERY_ENABLED: 'true',
      },
    })
    const path = attemptKind === 'join_stage' ? '/join'
      : attemptKind === 'rotation_begin' ? '/rotate' : '/recovery'
    const start = await pageState(app, path)
    let values: Record<string, string>
    if (attemptKind === 'join_stage') {
      values = {
        action: 'stage', csrf: start.csrf, handle: 'limited-merchant', model: '',
        client_class: 'coding_persistent',
      }
    } else if (attemptKind === 'rotation_begin') {
      values = { action: 'begin', csrf: start.csrf, merchant_key: MERCHANT_KEY }
    } else {
      values = {
        action: 'begin', csrf: start.csrf,
        recovery_code: `1f3ea_rc_${'3'.repeat(64)}`,
      }
    }
    const denied = await postForm(app, path, start.cookie, values)
    assert.equal(denied.status, 429, attemptKind)
    assert.equal(credentials(await denied.text()).length, 0, attemptKind)
    assert.equal(memory.currentSecretHash(), sha256(MERCHANT_KEY), attemptKind)
  }

  const rotation = harness({
    environment: { MARKET_IDENTITY_ROTATION_ENABLED: 'true' },
  })
  const start = await pageState(rotation.app, '/rotate')
  const staged = await postForm(rotation.app, '/rotate', start.cookie, {
    action: 'begin', csrf: start.csrf, merchant_key: MERCHANT_KEY,
  })
  assert.equal(staged.status, 200)
  const canceled = await postForm(rotation.app, '/rotate', start.cookie, {
    action: 'cancel', csrf: start.csrf,
  })
  assert.equal(canceled.status, 200)
  const canceledBody = await canceled.text()
  assert.match(canceledBody, /ceremony did not activate/iu)
  assert.match(canceledBody, /then-current key/iu)
  assert.match(canceledBody, /later key or recovery change may have changed/iu)
  assert.equal(rotation.memory.currentSecretHash(), sha256(MERCHANT_KEY))
  assert.equal(rotation.memory.stagedRotation(), null)
})

test('caller-visible refusals distinguish cookie, identity, storage, and terminal store outcomes', async () => {
  const join = harness()
  const start = await pageState(join.app, '/join')
  const missingCookie = await postForm(join.app, '/join', '', {
    action: 'confirm', csrf: start.csrf, merchant_key: MERCHANT_KEY,
  })
  assert.equal(missingCookie.headers.get('x-1f3ea-reason'), 'browser_cookie_missing')
  const wrongCsrf = await postForm(join.app, '/join', start.cookie, {
    action: 'confirm', csrf: 'a'.repeat(64), merchant_key: MERCHANT_KEY,
  })
  assert.equal(wrongCsrf.headers.get('x-1f3ea-reason'), 'browser_cookie_mismatch')
  const invalidIdentity = await postForm(join.app, '/join', start.cookie, {
    action: 'stage', csrf: start.csrf, handle: 'bad handle', model: '',
    client_class: 'coding_persistent',
  })
  assert.equal(invalidIdentity.status, 400)
  assert.equal(invalidIdentity.headers.get('x-1f3ea-reason'), 'invalid_identity')
  assert.equal((await postForm(join.app, '/join', start.cookie, { action: 'stage', csrf: start.csrf, handle: 'valid-handle', model: '', client_class: 'not-a-client' })).status, 400)

  const cancelHarness = harness()
  const cancelStart = await pageState(cancelHarness.app, '/join')
  const staged = await postForm(cancelHarness.app, '/join', cancelStart.cookie, {
    action: 'stage', csrf: cancelStart.csrf, handle: 'cancel-me', model: '',
    client_class: 'coding_persistent',
  })
  assert.equal(staged.status, 200)
  const canceled = await postForm(cancelHarness.app, '/join', cancelStart.cookie, {
    action: 'cancel', csrf: cancelStart.csrf,
  })
  assert.match(await canceled.text(), /Join canceled|created no merchant/iu)

  let failProgress = false
  const failingMemory = memoryStore()
  const failingStore = {
    ...failingMemory.store,
    getMerchantRegistrationProgress: async (input: Parameters<MarketIdentityStore['getMerchantRegistrationProgress']>[0]) => {
      if (failProgress) throw new Error('storage unavailable')
      return failingMemory.store.getMerchantRegistrationProgress(input)
    },
  }
  const failing = harness({ memory: failingMemory, store: failingStore })
  const resumable = await pageState(failing.app, '/join')
  failProgress = true
  const unavailable = await failing.app.request('/join', { headers: { cookie: resumable.cookie } })
  assert.equal(unavailable.status, 503)
  assert.equal(unavailable.headers.get('retry-after'), '1')
  assert.match(unavailable.headers.get('set-cookie') ?? '', /Max-Age=1800/u)
  assert.equal(credentials(await unavailable.text()).length, 0)

  const rotationMemory = memoryStore()
  const rotationStore = {
    ...rotationMemory.store,
    stageMerchantRotation: async () => ({ status: 'request_unavailable' as const }),
  }
  const rotation = harness({
    memory: rotationMemory, store: rotationStore,
    environment: { MARKET_IDENTITY_ROTATION_ENABLED: 'true' },
  })
  const rotationStart = await pageState(rotation.app, '/rotate')
  const unavailableRotation = await postForm(rotation.app, '/rotate', rotationStart.cookie, {
    action: 'begin', csrf: rotationStart.csrf, merchant_key: MERCHANT_KEY,
  })
  assert.equal(unavailableRotation.headers.get('x-1f3ea-reason'), 'credential_state_unverified')
  const uncertainRotation = await postForm(rotation.app, '/rotate', rotationStart.cookie, { action: 'cancel', csrf: rotationStart.csrf })
  assert.match(await uncertainRotation.text(), /could not confirm cancellation[^.]*may already be active/iu)

  const recovery = harness({ environment: { MARKET_IDENTITY_RECOVERY_ENABLED: 'true' } })
  const recoveryStart = await pageState(recovery.app, '/recovery')
  const wrongKey = await postForm(recovery.app, '/recovery', recoveryStart.cookie, {
    action: 'generate', csrf: recoveryStart.csrf, merchant_key: OTHER_MERCHANT_KEY,
  })
  assert.equal(wrongKey.headers.get('x-1f3ea-reason'), 'credential_rejected')
  const unusedCode = await postForm(recovery.app, '/recovery', recoveryStart.cookie, {
    action: 'begin', csrf: recoveryStart.csrf, recovery_code: `1f3ea_rc_${'4'.repeat(64)}`,
  })
  assert.equal(unusedCode.headers.get('x-1f3ea-reason'), 'credential_rejected')
  const uncertainRecovery = await postForm(recovery.app, '/recovery', recoveryStart.cookie, { action: 'cancel', csrf: recoveryStart.csrf })
  assert.match(await uncertainRecovery.text(), /could not confirm cancellation[^.]*may already be active/iu)
})

test('rotation and recovery reject crossed sessions, extra fields, malformed credentials, and foreign forms', async () => {
  const { app } = harness({ environment: { VERCEL: '0', MARKET_IDENTITY_ROTATION_ENABLED: 'true',
    MARKET_IDENTITY_RECOVERY_ENABLED: 'true' } })
  for (const [path, action, field, value] of [
    ['/rotate', 'begin', 'merchant_key', MERCHANT_KEY],
    ['/rotate', 'confirm', 'merchant_key', MERCHANT_KEY],
    ['/recovery', 'generate', 'merchant_key', MERCHANT_KEY],
    ['/recovery', 'begin', 'recovery_code', `1f3ea_rc_${'5'.repeat(64)}`],
    ['/recovery', 'confirm', 'merchant_key', MERCHANT_KEY],
  ] as const) {
    const start = await pageState(app, path)
    const base = { action, csrf: start.csrf, [field]: value }
    const cases: Array<[string, Record<string, string>, Record<string, string>, string]> = [
      [start.cookie, { action }, {}, 'invalid_form'],
      [start.cookie, { action: 'not-an-action', csrf: start.csrf }, {}, 'invalid_form'],
      ['', base, {}, 'browser_cookie_missing'],
      [start.cookie, { ...base, csrf: 'a'.repeat(64) }, {}, 'browser_cookie_mismatch'],
      [start.cookie, { ...base, extra: 'not-accepted' }, {}, 'unexpected_form_fields'],
      [start.cookie, { ...base, [field]: 'malformed' }, {}, 'credential_rejected'],
      [start.cookie, base, { origin: 'https://foreign.test' }, 'untrusted_browser_request'],
    ]
    for (const [cookie, form, headers, reason] of cases) {
      const response = await postForm(app, path, cookie, form, headers)
      assert.equal(response.headers.get('x-1f3ea-reason'), reason)
    }
    assert.equal((await postForm(app, path, start.cookie, { action: 'cancel', csrf: start.csrf })).status, 409)
  }
})
