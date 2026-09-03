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
// readBoundedJson: reads through the proven fast path (c.req.arrayBuffer()), not the raw
// c.req.raw.body stream reader — see src/bounded-json.ts for the full 2026-09-03 root-cause
// writeup (issue #39).
// ---------------------------------------------------------------------------------------------

function contextWithFastPath(options: {
  arrayBuffer: () => Promise<ArrayBuffer>
  rawBody?: ReadableStream<Uint8Array> | null
  contentLength?: string
}): Context {
  const { arrayBuffer, rawBody = new ReadableStream(), contentLength } = options
  return {
    req: {
      header: (name: string) => {
        const lower = name.toLowerCase()
        if (lower === 'content-type') return 'application/json'
        if (lower === 'content-length') return contentLength
        return undefined
      },
      raw: { body: rawBody },
      arrayBuffer,
    },
  } as unknown as Context
}

function jsonBytes(text: string): () => Promise<ArrayBuffer> {
  return async () => new TextEncoder().encode(text).buffer as ArrayBuffer
}

// Regression test for the 2026-09-03 production incident, root-caused on a deployed Vercel
// preview with a dedicated probe route (issue #39): on that runtime's Node adapter,
// c.req.raw.body.getReader() never delivers a single chunk even once the body has fully
// arrived — every reader.read() on it hangs forever — while c.req.arrayBuffer() (Hono's fast
// path, which reads the underlying Node stream directly instead of through Readable.toWeb())
// resolves in under 1ms. This models that exact state: raw.body is a stream that never settles,
// while arrayBuffer() resolves normally. readBoundedJson must read through the fast path, never
// touching raw.body's reader, so it still returns the parsed body promptly instead of hanging.
test('readBoundedJson returns the parsed body promptly when raw.body never settles but arrayBuffer() does (the proven Vercel state)', async () => {
  const stuckForever = new ReadableStream<Uint8Array>({
    // Never enqueues, never closes, never errors — reading raw.body directly would hang forever.
    pull() {},
  })

  const startedAt = Date.now()
  const result = await readBoundedJson(contextWithFastPath({
    arrayBuffer: jsonBytes('{"action":"stage"}'),
    rawBody: stuckForever,
  }))
  const elapsedMs = Date.now() - startedAt

  assert.deepEqual(result, { kind: 'json', value: { action: 'stage' } })
  assert.ok(elapsedMs < 500, `readBoundedJson took ${elapsedMs}ms; it must not touch the stuck raw.body reader`)
})

// A body read through the fast path either resolves or rejects on its own (there is no separate
// stream construction step left to hang); a rejection must still land on the documented
// 'unreadable' outcome rather than throwing out of readBoundedJson.
test('readBoundedJson resolves to unreadable, not throwing, when the fast-path read itself rejects', async () => {
  const result = await readBoundedJson(contextWithFastPath({
    arrayBuffer: async () => { throw new Error('socket stopped') },
  }))
  assert.deepEqual(result, { kind: 'unreadable' })
})

test('readBoundedJson still parses a well-behaved body', async () => {
  const result = await readBoundedJson(contextWithFastPath({ arrayBuffer: jsonBytes('{"action":"stage"}') }))
  assert.deepEqual(result, { kind: 'json', value: { action: 'stage' } })
})

test('readBoundedJson refuses a body whose actual bytes exceed the bound', async () => {
  const result = await readBoundedJson(
    contextWithFastPath({ arrayBuffer: jsonBytes(`{"padding":"${'x'.repeat(20)}"}`) }),
    16,
  )
  assert.deepEqual(result, { kind: 'invalid' })
})

// Mirrors the 'ignores Content-Length claims' contract already covered for form bodies in
// test/browser-form.test.ts and for /join in test/market-identity-browser.test.ts: a declared
// Content-Length above the bound must not refuse a request on its own — only the actual byte
// count of the body once read can. An absent or falsely large declaration is equally unusable
// as a refusal signal by itself.
test('readBoundedJson refuses malformed JSON text sent with the correct content type', async () => {
  const result = await readBoundedJson(contextWithFastPath({ arrayBuffer: jsonBytes('not json') }))
  assert.deepEqual(result, { kind: 'invalid' })
})

test('readBoundedJson does not refuse a body on a falsely large declared Content-Length alone — only actual bytes count', async () => {
  const result = await readBoundedJson(
    contextWithFastPath({ arrayBuffer: jsonBytes('{"action":"stage"}'), contentLength: '999999' }),
    8_192,
  )
  assert.deepEqual(result, { kind: 'json', value: { action: 'stage' } })
})
