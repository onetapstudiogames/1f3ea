import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from 'hono'

import { jsonOptionalStringField, jsonStringField, readBoundedJson } from '../src/bounded-json.ts'

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

// ---------------------------------------------------------------------------------------------
// readBoundedJson: bounded wait, not an unbounded one
// ---------------------------------------------------------------------------------------------

function contextWithBody(body: ReadableStream<Uint8Array> | null): Context {
  return {
    req: {
      header: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : undefined),
      raw: { body },
    },
  } as unknown as Context
}

// Regression test for the 2026-09-03 production incident: POST /api/register, /api/rotate, and
// /api/recovery never answered on Vercel's deployed runtime because the request body reader
// awaited a chunk that never arrived, with no deadline. This never depends on any particular
// runtime's stream quirk to prove the fix: a reader whose `pull` never enqueues or closes is a
// stream that, by construction, never settles on its own — exactly the shape "an await with no
// timeout" takes — and readBoundedJson must still resolve to 'unreadable' well inside its own
// configured deadline rather than hang the caller.
test('readBoundedJson resolves to unreadable instead of hanging when the body stream never settles', async () => {
  let canceled = false
  const stuckForever = new ReadableStream<Uint8Array>({
    // Never enqueues, never closes, never errors — reader.read() on this stream would await
    // forever with no timeout wrapped around it.
    pull() {},
    cancel() { canceled = true },
  })

  const startedAt = Date.now()
  const result = await readBoundedJson(contextWithBody(stuckForever), 8_192, 50)
  const elapsedMs = Date.now() - startedAt

  assert.deepEqual(result, { kind: 'unreadable' })
  assert.ok(elapsedMs < 2_000, `readBoundedJson took ${elapsedMs}ms to give up on a stuck body`)
  assert.equal(canceled, true)
})

test('readBoundedJson still parses a well-behaved body well within its deadline', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"action":"stage"}'))
      controller.close()
    },
  })
  const result = await readBoundedJson(contextWithBody(body), 8_192, 50)
  assert.deepEqual(result, { kind: 'json', value: { action: 'stage' } })
})
