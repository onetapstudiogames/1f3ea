import test from 'node:test'
import assert from 'node:assert/strict'

import {
  decodeShelfCursor,
  encodeShelfCursor,
  finalizePage,
  parseNumericPage,
  type ShelfCursorScope,
} from '../src/public-pagination.ts'

test('numeric public pages use limit plus one and reject invalid or repeated options', () => {
  assert.deepEqual(parseNumericPage(new URLSearchParams(), {
    cursorName: 'before_id', defaultLimit: 50, maxLimit: 200,
  }), { ok: true, cursor: null, limit: 50, fetchLimit: 51 })

  assert.deepEqual(parseNumericPage(new URLSearchParams('before_id=90&limit=200'), {
    cursorName: 'before_id', defaultLimit: 50, maxLimit: 200,
  }), { ok: true, cursor: 90, limit: 200, fetchLimit: 201 })

  for (const query of [
    'before_id=0', 'before_id=-1', 'before_id=abc', 'before_id=1&before_id=2',
    'limit=0', 'limit=201', 'limit=1.5', 'limit=1&limit=2',
  ]) {
    const parsed = parseNumericPage(new URLSearchParams(query), {
      cursorName: 'before_id', defaultLimit: 50, maxLimit: 200,
    })
    assert.equal(parsed.ok, false, query)
  }
})

test('page finalization distinguishes exactly-at-bound from past-bound without losing the cursor row', () => {
  const exact = finalizePage(Array.from({ length: 50 }, (_, index) => ({ id: 50 - index })), 50)
  assert.equal(exact.items.length, 50)
  assert.equal(exact.hasMore, false)
  assert.equal(exact.nextCursor, null)

  const past = finalizePage(Array.from({ length: 51 }, (_, index) => ({ id: 51 - index })), 50)
  assert.equal(past.items.length, 50)
  assert.equal(past.hasMore, true)
  assert.equal(past.nextCursor, 2)
  assert.equal(past.items.some(row => row.id === 1), false)
})

test('shelf cursors round-trip their composite order and are bound to the complete browse scope', () => {
  const scope: ShelfCursorScope = {
    q: 'quiet tool', tag: 'mcp', aisle: 'tools', sort: 'karma',
  }
  const encoded = encodeShelfCursor(scope, {
    pinned: true,
    votes: 17,
    createdAt: '2026-08-25T12:34:56.123456Z',
    id: 42,
  })

  assert.deepEqual(decodeShelfCursor(encoded, scope), {
    pinned: true,
    votes: 17,
    createdAt: '2026-08-25T12:34:56.123456Z',
    id: 42,
  })
  assert.equal(decodeShelfCursor(encoded, { ...scope, q: 'different' }), null)
  assert.equal(decodeShelfCursor(encoded, { ...scope, sort: 'new' }), null)

  for (const malformed of [
    '', 'not+base64', Buffer.from('[0]').toString('base64url'),
    Buffer.from(JSON.stringify([1, null, null, null, 'new', false, null, 'not-a-date', 1])).toString('base64url'),
  ]) assert.equal(decodeShelfCursor(malformed, { q: null, tag: null, aisle: null, sort: 'new' }), null)

  const negativeKarma = encodeShelfCursor(scope, {
    pinned: false, votes: -12, createdAt: '2026-08-25T12:34:56Z', id: 7,
  })
  assert.equal(decodeShelfCursor(negativeKarma, scope)?.votes, -12)
})
