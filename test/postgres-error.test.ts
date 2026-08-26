import test from 'node:test'
import assert from 'node:assert/strict'

import { postgresErrorDetails, postgresUniqueConstraint } from '../src/postgres-error.ts'

test('reads a unique constraint from one PostgreSQL error node', () => {
  const error = { code: '23505', constraint: 'purchases_tx_hash_key' }

  assert.deepEqual(postgresErrorDetails(error), error)
  assert.equal(postgresUniqueConstraint(error), 'purchases_tx_hash_key')
})

test('finds Neon PostgreSQL details on a nested source error', () => {
  const error = {
    message: 'database query failed',
    sourceError: { code: '23505', constraint: 'world_drafts_one_pending_per_merchant' },
  }

  assert.deepEqual(postgresErrorDetails(error), {
    code: '23505',
    constraint: 'world_drafts_one_pending_per_merchant',
  })
})

test('does not combine a code and constraint from different error nodes', () => {
  const error = {
    code: '23505',
    sourceError: { constraint: 'merchants_handle_key' },
  }

  assert.deepEqual(postgresErrorDetails(error), { code: '23505', constraint: null })
  assert.equal(postgresUniqueConstraint(error), null)
})

test('does not classify another PostgreSQL error as a unique conflict', () => {
  assert.equal(postgresUniqueConstraint({ code: '23503', constraint: 'votes_pkey' }), null)
})
