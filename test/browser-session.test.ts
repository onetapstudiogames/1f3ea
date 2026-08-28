import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'

import {
  inspectBrowserSessionCookie,
  newBrowserSessionCookie,
  setBrowserSessionCookie,
} from '../src/browser-session.ts'

test('browser session cookies are strong, host-only, private, and duplicate-intolerant', async () => {
  const created = newBrowserSessionCookie()
  assert.match(created.raw, /^[0-9a-f]{64}\.[0-9a-f]{64}$/u)

  const app = new Hono()
  app.get('/cookie', c => {
    setBrowserSessionCookie(c, '__Host-1f3ea_test', created.raw, 900)
    return c.json(inspectBrowserSessionCookie(c, '__Host-1f3ea_test'))
  })

  const missing = await app.request('/cookie')
  assert.match(missing.headers.get('set-cookie') ?? '',
    /__Host-1f3ea_test=.*Path=\/; Max-Age=900; Secure; HttpOnly; SameSite=Lax/iu)
  assert.deepEqual(await missing.json(), { kind: 'missing' })

  const valid = await app.request('/cookie', {
    headers: { cookie: `__Host-1f3ea_test=${created.raw}` },
  })
  assert.deepEqual(await valid.json(), {
    kind: 'valid',
    cookie: { raw: created.raw, session: created.session, csrf: created.csrf },
  })

  for (const cookie of [
    '__Host-1f3ea_test=bad',
    `__Host-1f3ea_test=${created.raw}; __Host-1f3ea_test=${created.raw}`,
  ]) {
    const response = await app.request('/cookie', { headers: { cookie } })
    assert.deepEqual(await response.json(), { kind: 'invalid' })
  }
})
