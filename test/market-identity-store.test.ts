import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  retryMarketIdentityDeadlockOnce,
  stageMerchantRegistration,
} from '../src/market-identity-store.ts'

const hash = (character: string) => character.repeat(64)

test('market identity confirmation retries one deadlock and no other database failure', async t => {
  await t.test('one deadlock is retried once', async () => {
    let attempts = 0
    const result = await retryMarketIdentityDeadlockOnce(async () => {
      attempts += 1
      if (attempts === 1) {
        throw Object.assign(new Error('deadlock'), { sourceError: { code: '40P01' } })
      }
      return { merchantId: 7, handle: 'tinylantern' }
    })
    assert.deepEqual(result, { merchantId: 7, handle: 'tinylantern' })
    assert.equal(attempts, 2)
  })

  await t.test('a second deadlock is returned to the caller', async () => {
    let attempts = 0
    await assert.rejects(
      retryMarketIdentityDeadlockOnce(async () => {
        attempts += 1
        throw Object.assign(new Error('deadlock'), { code: '40P01' })
      }),
      (error: unknown) => (error as { code?: unknown }).code === '40P01',
    )
    assert.equal(attempts, 2)
  })

  await t.test('another database error is never retried', async () => {
    let attempts = 0
    await assert.rejects(
      retryMarketIdentityDeadlockOnce(async () => {
        attempts += 1
        throw Object.assign(new Error('constraint'), { code: '23514' })
      }),
      (error: unknown) => (error as { code?: unknown }).code === '23514',
    )
    assert.equal(attempts, 1)
  })
})

test('registration refuses anything except eight unique SHA-256 recovery-code hashes before SQL', async () => {
  const input = {
    sessionHash: hash('1'),
    csrfHash: hash('2'),
    ipHash: hash('3'),
    handle: 'storage-test',
    model: 'unit-test',
    clientClass: 'coding_ephemeral' as const,
    merchantSecretHash: hash('4'),
    recoveryCodeHashes: Array.from({ length: 8 }, (_, index) => hash(String(index + 1))),
  }

  for (const recoveryCodeHashes of [
    input.recoveryCodeHashes.slice(0, 7),
    [...input.recoveryCodeHashes.slice(0, 7), input.recoveryCodeHashes[0]!],
    [...input.recoveryCodeHashes.slice(0, 7), 'not-a-hash'],
  ]) {
    await assert.rejects(
      stageMerchantRegistration({ ...input, recoveryCodeHashes }),
      /exactly eight unique sha256 recovery-code hashes/i,
    )
  }
})

test('identity schema and migration keep only hashes and the full atomic-revocation boundary', async () => {
  const [schema, migration, identitySource, recoverySource] = await Promise.all([
    readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'),
    readFile(new URL('../db/migrations/20260827_market_identity.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/market-identity-store.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/market-identity-recovery-store.ts', import.meta.url), 'utf8'),
  ])
  const source = identitySource + recoverySource

  for (const sql of [schema, migration]) {
    assert.match(sql, /merchants[\s\S]*recovery_generation/i)
    for (const table of [
      'pending_merchant_registrations',
      'pending_merchant_registration_recovery_codes',
      'merchant_recovery_codes',
      'merchant_recovery_ceremony_results',
      'merchant_key_rotations',
      'merchant_identity_rate_limits',
      'oauth_authorization_request_recovery_codes',
    ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'i'), table)
    assert.match(sql, /ordinal\s+SMALLINT[^\n]*BETWEEN 1 AND 8/i)
    assert.match(sql, /code_hash\s+TEXT NOT NULL UNIQUE[\s\S]{0,100}\^\[0-9a-f\]\{64\}\$/i)
    assert.match(sql, /CONSTRAINT merchant_recovery_codes_ceremony_state CHECK/i)
    assert.match(sql, /CONSTRAINT merchant_recovery_codes_expiry_window CHECK/i)
    assert.match(sql, /CONSTRAINT merchant_recovery_ceremony_results_outcome_allowed CHECK/i)
    assert.match(sql, /CONSTRAINT merchant_recovery_ceremony_results_retention_window CHECK/i)
    assert.match(sql, /merchant_recovery_ceremony_results_expiry/i)
    assert.match(sql, /CREATE TRIGGER merchant_recovery_ceremony_result/i)
    assert.match(sql, /expires_at <= terminal_at \+ interval '24 hours'/i)
  }

  assert.doesNotMatch(migration, /\b(?:DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM)\b/i)
  assert.doesNotMatch(migration, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;\s*$/im)
  assert.match(source, /UPDATE merchants[\s\S]*secret_hash[\s\S]*recovery_generation/i)
  assert.match(source, /UPDATE oauth_token_families[\s\S]*revoked_at/i)
  assert.match(source, /UPDATE oauth_tokens[\s\S]*revoked_at/i)
  assert.match(source, /UPDATE oauth_authorization_codes[\s\S]*used_at/i)
  assert.match(source, /INSERT INTO events[\s\S]*'rotate'/i)
  assert.match(source, /consumeMarketIdentityRateLimit[\s\S]*ON CONFLICT[\s\S]*used \+ 1/i)

  for (const column of [
    'intent', 'new_handle', 'new_model', 'new_secret_hash', 'merchant_key_confirmed_at',
  ]) assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, 'i'), column)
  assert.match(migration, /intent IN \('existing', 'new'\)/i)
  assert.match(migration, /oauth_authorization_requests_identity_state/i)
  assert.match(migration, /intent = 'existing'[\s\S]*verified_at IS NOT NULL[\s\S]*used_at IS NOT NULL/i)
  assert.match(migration, /merchant_id IS NULL AND new_secret_hash IS NOT NULL[\s\S]*used_at IS NULL/i)
  assert.match(migration, /merchant_id IS NOT NULL AND new_secret_hash IS NULL[\s\S]*used_at IS NOT NULL/i)
  assert.match(migration, /UNIQUE \(request_id, code_hash\)/i)
})
