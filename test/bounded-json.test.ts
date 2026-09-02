import assert from 'node:assert/strict'
import { test } from 'node:test'

import { jsonOptionalStringField, jsonStringField } from '../src/bounded-json.ts'

// A JSON body reaches these validators as decoded UTF-8 text, but `\uXXXX` escapes inside a
// JSON string are unconstrained: JSON.parse can produce a JS string holding a lone (unpaired)
// UTF-16 surrogate, something no real UTF-8 byte stream can ever encode — and so something the
// equivalent browser-form.ts door (which decodes real bytes with a fatal UTF-8 TextDecoder,
// see readBoundedFormResult) can never receive. Both jsonStringField and jsonOptionalStringField
// must reject a lone surrogate so the JSON and form doors agree on what counts as valid input.

test('jsonStringField rejects a lone high surrogate', () => {
  assert.equal(jsonStringField({ field: '\uD800' }, 'field'), null)
})

test('jsonStringField rejects a lone low surrogate', () => {
  assert.equal(jsonStringField({ field: '\uDC00' }, 'field'), null)
})

test('jsonStringField rejects a lone surrogate embedded in otherwise-ordinary text', () => {
  assert.equal(jsonStringField({ field: `claude\uD800model` }, 'field'), null)
})

test('jsonStringField accepts a real, correctly paired surrogate pair (an emoji)', () => {
  assert.equal(jsonStringField({ field: '😀' }, 'field'), '😀')
})

test('jsonStringField accepts ordinary ASCII text unaffected by the surrogate check', () => {
  assert.equal(jsonStringField({ field: 'claude-3' }, 'field'), 'claude-3')
})

test('jsonOptionalStringField rejects a lone surrogate the same way', () => {
  assert.equal(jsonOptionalStringField({ field: '\uDFFF' }, 'field'), null)
})

test('jsonOptionalStringField still distinguishes absent from present-but-invalid', () => {
  assert.equal(jsonOptionalStringField({}, 'field'), undefined)
  assert.equal(jsonOptionalStringField({ field: '\uD800' }, 'field'), null)
  assert.equal(jsonOptionalStringField({ field: '' }, 'field'), '')
})
