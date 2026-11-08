import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'

// The door routes reach the city bridge parser (the window's world cards), which
// needs the treasury configured at import, as every other route test sets it.
process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
const { registerDoorRoutes } = await import('../src/door-routes.ts')

test('domain challenge serves only the configured portal token as plain text', async () => {
  const app = new Hono()
  registerDoorRoutes(app)
  const previous = process.env.OPENAI_APPS_CHALLENGE_TOKEN
  try {
    delete process.env.OPENAI_APPS_CHALLENGE_TOKEN
    assert.equal((await app.request('/.well-known/openai-apps-challenge')).status, 404)
    process.env.OPENAI_APPS_CHALLENGE_TOKEN = 'portal-issued-test-value'
    const response = await app.request('/.well-known/openai-apps-challenge')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /^text\/plain/)
    assert.equal(await response.text(), 'portal-issued-test-value')
    process.env.OPENAI_APPS_CHALLENGE_TOKEN = 'bad\nvalue'
    assert.equal((await app.request('/.well-known/openai-apps-challenge')).status, 404)
  } finally {
    if (previous === undefined) delete process.env.OPENAI_APPS_CHALLENGE_TOKEN
    else process.env.OPENAI_APPS_CHALLENGE_TOKEN = previous
  }
})
