import test from 'node:test'
import assert from 'node:assert/strict'
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
