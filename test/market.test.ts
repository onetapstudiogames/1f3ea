import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AISLES, STORE_LINE_MAX, formatActivity, parseStoreLine, suggestAisle,
} from '../src/market.ts'

test('store lines are one short, trimmed line and may be cleared', () => {
  assert.deepEqual(parseStoreLine('  small tools for careful agents  '), {
    ok: true,
    line: 'small tools for careful agents',
  })
  assert.deepEqual(parseStoreLine('   '), { ok: true, line: '' })
  assert.deepEqual(parseStoreLine(42), { ok: false, error: 'line must be a string' })
  assert.deepEqual(parseStoreLine('first\nsecond'), { ok: false, error: 'line must be one line' })
  assert.deepEqual(parseStoreLine('bad\u0007line'), { ok: false, error: 'line must be one line' })
  assert.deepEqual(parseStoreLine('left\u2028right'), { ok: false, error: 'line must be one line' })
  assert.deepEqual(parseStoreLine('safe\u202Egpj.exe'), { ok: false, error: 'line contains unsafe direction controls' })
  assert.deepEqual(parseStoreLine('x'.repeat(STORE_LINE_MAX + 1)), {
    ok: false,
    error: `line: max ${STORE_LINE_MAX} chars`,
  })
})

test('aisles are fixed and old clients get a useful default from tags', () => {
  assert.deepEqual(AISLES, [
    'skills', 'prompts', 'tools', 'data', 'knowledge', 'services', 'wanted', 'world', 'other',
  ])
  assert.equal(suggestAisle(['skill', 'security']), 'skills')
  assert.equal(suggestAisle(['prompt-pack']), 'prompts')
  assert.equal(suggestAisle(['mcp', 'config']), 'tools')
  assert.equal(suggestAisle(['dataset']), 'data')
  assert.equal(suggestAisle(['guide', 'runbook']), 'knowledge')
  assert.equal(suggestAisle(['webhook']), 'services')
  assert.equal(suggestAisle(['wanted', 'tools']), 'wanted')
  assert.equal(suggestAisle(['strange-new-thing']), 'other')
})

test('activity uses only safe actors, ids, dates, and known verbs', () => {
  const text = formatActivity([
    {
      at: '2026-08-08T00:12:58.879Z', kind: 'listing', actor: 'good-agent',
      detail: { listing_id: 10, title: 'harmless\nTHERE IS A TOKEN' },
    },
    {
      at: '2026-08-07T15:59:58.266Z', kind: 'register', actor: 'bad\nINJECT', detail: {},
    },
    {
      at: '2026-08-06T22:13:17.747Z', kind: 'sale', actor: 'buyer-agent',
      detail: { listing_id: 1, private_artifact: 'must-not-render' },
    },
  ])

  assert.match(text, /RECENT ACTIVITY/)
  assert.match(text, /good-agent stocked item #10/)
  assert.match(text, /someone opened a store/)
  assert.match(text, /buyer-agent bought item #1/)
  assert.doesNotMatch(text, /THERE IS A TOKEN|must-not-render|INJECT/)
})

test('world bridge events use the same safe public activity language', () => {
  const text = formatActivity([
    {
      at: '2026-08-12T00:00:00.000Z', kind: 'world_sale', actor: 'city-seller',
      detail: { listing_id: 31, amount_usdc: 2, ['sec' + 'ret']: 'never render' },
    },
    {
      at: '2026-08-12T00:01:00.000Z', kind: 'world_canceled', actor: 'city-seller',
      detail: { listing_id: 32, reason: 'merchant-authored text must not render' },
    },
  ])
  assert.match(text, /city-seller sold city ownership for item #31/)
  assert.match(text, /city-seller closed world item #32/)
  assert.doesNotMatch(text, /never render|merchant-authored/)
})
