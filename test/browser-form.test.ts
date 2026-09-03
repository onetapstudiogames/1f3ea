import test from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from 'hono'
import { Hono } from 'hono'

import {
  exactFormFields,
  oneFormValue,
  readBoundedForm,
  readBoundedFormResult,
  trustedBrowserForm,
} from '../src/browser-form.ts'

function formApp(maximumBytes = 8) {
  const app = new Hono()
  app.post('/form', async c => {
    const values = await readBoundedForm(c, maximumBytes)
    return values ? c.json({ value: values.get('a') }) : c.json({ error: 'invalid form' }, 400)
  })
  return app
}

test('browser forms trust actual bytes when Content-Length is missing, zero, or falsely large', async () => {
  for (const contentLength of [undefined, '0', '999999']) {
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    }
    if (contentLength !== undefined) headers['content-length'] = contentLength
    const response = await formApp().request('/form', {
      method: 'POST', headers, body: 'a=1',
    })
    assert.equal(response.status, 200, `declared Content-Length ${contentLength ?? 'missing'}`)
    assert.deepEqual(await response.json(), { value: '1' })
  }
})

test('browser forms reject an actually oversized, malformed, or wrong-media body', async () => {
  const oversized = await formApp().request('/form', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': '1',
    },
    body: 'a=1234567',
  })
  assert.equal(oversized.status, 400)

  const wrongType = await formApp().request('/form', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}',
  })
  assert.equal(wrongType.status, 400)

  const invalidUtf8 = await formApp().request('/form', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new Uint8Array([0x61, 0x3d, 0xff]),
  })
  assert.equal(invalidUtf8.status, 400)
})

test('a broken request stream is distinguishable from caller-invalid form bytes', async () => {
  const app = new Hono()
  app.post('/form', async c => c.json({ kind: (await readBoundedFormResult(c, 8)).kind }))
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error('socket stopped')) },
  })
  const request = new Request('http://localhost/form', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
  const response = await app.request(request)
  assert.deepEqual(await response.json(), { kind: 'unreadable' })
})

// ---------------------------------------------------------------------------------------------
// readBoundedFormResult: reads through the proven fast path (c.req.arrayBuffer()), not the raw
// c.req.raw.body stream reader — see src/bounded-json.ts for the full 2026-09-03 root-cause
// writeup (issue #39). The tests above already prove this end-to-end through a real Hono app
// (app.request() builds its Request in-process, so it does not itself exercise the hung Vercel
// stream state); this section proves the reader's own behavior against a Context modeling that
// state directly, the same way test/bounded-json.test.ts does for readBoundedJson.
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
        if (lower === 'content-type') return 'application/x-www-form-urlencoded'
        if (lower === 'content-length') return contentLength
        return undefined
      },
      raw: { body: rawBody },
      arrayBuffer,
    },
  } as unknown as Context
}

function formBytes(text: string): () => Promise<ArrayBuffer> {
  return async () => new TextEncoder().encode(text).buffer as ArrayBuffer
}

// On Vercel's deployed Node runtime, c.req.raw.body.getReader() never delivers a single chunk
// even once the body has fully arrived — every reader.read() on it hangs forever — while
// c.req.arrayBuffer() (Hono's fast path) resolves in under 1ms. This models that exact state:
// raw.body is a stream that never settles, while arrayBuffer() resolves normally.
// readBoundedFormResult must read through the fast path, never touching raw.body's reader, so it
// still returns the parsed form promptly instead of hanging.
test('readBoundedFormResult returns the parsed form promptly when raw.body never settles but arrayBuffer() does (the proven Vercel state)', async () => {
  const stuckForever = new ReadableStream<Uint8Array>({
    // Never enqueues, never closes, never errors — reading raw.body directly would hang forever.
    pull() {},
  })

  const startedAt = Date.now()
  const result = await readBoundedFormResult(contextWithFastPath({
    arrayBuffer: formBytes('a=1'),
    rawBody: stuckForever,
  }))
  const elapsedMs = Date.now() - startedAt

  assert.equal(result.kind, 'form')
  assert.equal((result as { kind: 'form'; values: URLSearchParams }).values.get('a'), '1')
  assert.ok(elapsedMs < 500, `readBoundedFormResult took ${elapsedMs}ms; it must not touch the stuck raw.body reader`)
})

test('readBoundedFormResult refuses a body whose actual bytes exceed the bound', async () => {
  const result = await readBoundedFormResult(
    contextWithFastPath({ arrayBuffer: formBytes('a=1234567') }),
    4,
  )
  assert.deepEqual(result, { kind: 'invalid' })
})

// Mirrors the top-level 'trust actual bytes' app.request() test above: a declared Content-Length
// above the bound must not refuse a request on its own — only the actual byte count of the body
// once read can.
test('readBoundedFormResult does not refuse a body on a falsely large declared Content-Length alone — only actual bytes count', async () => {
  const result = await readBoundedFormResult(
    contextWithFastPath({ arrayBuffer: formBytes('a=1'), contentLength: '999999' }),
    8_192,
  )
  assert.equal(result.kind, 'form')
  assert.equal((result as { kind: 'form'; values: URLSearchParams }).values.get('a'), '1')
})

test('browser form fields are exact, single, bounded, and control-free', () => {
  const values = new URLSearchParams('action=save&csrf=abc')
  assert.equal(exactFormFields(values, ['action', 'csrf']), true)
  assert.equal(oneFormValue(values, 'action', 10), 'save')
  assert.equal(exactFormFields(new URLSearchParams('action=save&action=again'), ['action']), false)
  assert.equal(exactFormFields(new URLSearchParams('action=save&extra=x'), ['action']), false)
  assert.equal(oneFormValue(new URLSearchParams('a=1234'), 'a', 3), null)
  assert.equal(oneFormValue(new URLSearchParams('a=line%0Abreak'), 'a', 100), null)
})

test('browser form trust accepts exact first-party evidence and rejects cross-site ambiguity', () => {
  const app = new Hono()
  app.post('/check', c => c.json({ trusted: trustedBrowserForm(c, 'https://1f3ea.com') }))
  const checks = [
    [{ origin: 'https://1f3ea.com' }, true],
    [{ referer: 'https://1f3ea.com/join' }, true],
    [{ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, true],
    [{ origin: 'https://evil.example' }, false],
    [{ referer: 'not a url' }, false],
    [{}, false],
  ] as const

  return Promise.all(checks.map(async ([headers, expected]) => {
    const response = await app.request('/check', { method: 'POST', headers })
    assert.equal((await response.json() as { trusted: boolean }).trusted, expected)
  })).then(() => undefined)
})
