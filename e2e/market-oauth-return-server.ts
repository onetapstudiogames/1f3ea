import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:https'
import { getRequestListener } from '@hono/node-server'
import { environment, fixture } from '../test/support/market-oauth-flow-harness.ts'

export const RETURN_TEST_PORT = Number(process.env.MARKET_RETURN_E2E_PORT ?? 41_839)
export const RETURN_TEST_ORIGIN = `https://127.0.0.1:${RETURN_TEST_PORT}`
export const RETURN_TEST_CLIENT = 'https://chatgpt.com/oauth/e2e-plugin-browser/client.json'
export const RETURN_TEST_PLUGIN_ID = 'e2e-plugin-browser'
export const RETURN_TEST_PLUGIN_CALLBACK = `https://chatgpt.com/connector/oauth/${RETURN_TEST_PLUGIN_ID}`
const RETURN_TEST_STATIC_CLIENT = 'market-browser-return-test'
export const RETURN_CALLBACKS = {
  direct: 'https://chatgpt.com/connector/oauth/e2e-direct',
  platform: 'https://chatgpt.com/connector/oauth/e2e-platform',
  unapproved: 'https://chatgpt.com/connector/oauth/e2e-unapproved',
  otherClient: 'https://chat.example.test/oauth/callback',
} as const

function certificate(): { key: string; cert: string } {
  const generated = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', '-', '-out', '-',
    '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ], { encoding: 'utf8' })
  if (generated.status !== 0) throw new Error('Could not generate the disposable OAuth E2E certificate')
  const key = generated.stdout.match(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/)?.[0]
  const cert = generated.stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0]
  if (!key || !cert) throw new Error('OpenSSL returned an incomplete disposable E2E certificate')
  return { key, cert }
}

export async function startReturnTestServer() {
  const { app } = fixture({ environment: {
    ...environment,
    PUBLIC_ORIGIN: RETURN_TEST_ORIGIN,
    HOSTED_MARKET_OAUTH_CLIENTS: JSON.stringify([{
      client_id: RETURN_TEST_STATIC_CLIENT,
      client_name: 'Browser Return Test',
      redirect_uris: Object.values(RETURN_CALLBACKS),
    }]),
  }, fetcher: async (input, init) => {
    if (
      String(input) !== RETURN_TEST_CLIENT ||
      init?.method !== 'GET' ||
      init.redirect !== 'manual'
    ) {
      throw new Error(`unexpected OAuth client metadata fetch: ${String(input)}`)
    }
    metadataRequests = [...metadataRequests, { url: String(input), method: init.method }]
    return new Response(JSON.stringify({
      client_id: RETURN_TEST_CLIENT,
      client_name: 'ChatGPT browser plugin',
      redirect_uris: [RETURN_TEST_PLUGIN_CALLBACK],
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
    }), { headers: { 'content-type': 'application/json' } })
  } })
  let receipts: ReadonlyArray<{ origin: string; path: string; method: string; status: number }> = []
  let metadataRequests: ReadonlyArray<{ url: string; method: string }> = []
  for (const path of ['/connector/oauth/*', '/apps-manage/oauth', '/oauth/callback', '/oauth/return']) {
    app.use(path, async (c, next) => {
      await next()
      const url = new URL(c.req.url)
      receipts = [...receipts, {
        origin: url.origin, path: url.pathname, method: c.req.method, status: c.res.status,
      }]
    })
  }
  app.get('/connector/oauth/e2e-direct', c => c.html('<h1>ChatGPT callback reached</h1>'))
  app.get('/connector/oauth/e2e-platform', c => c.redirect('https://platform.openai.com/apps-manage/oauth', 302))
  app.get('/connector/oauth/e2e-unapproved', c => c.redirect('https://platform.openai.com/apps-manage/oauth?unapproved=1', 302))
  app.get(`/connector/oauth/${RETURN_TEST_PLUGIN_ID}`, c => c.redirect('https://platform.openai.com/apps-manage/oauth', 302))
  app.get('/oauth/callback', c => c.redirect('https://platform.openai.com/apps-manage/oauth', 302))
  app.get('/apps-manage/oauth', c => c.req.query('unapproved')
    ? c.redirect('https://unapproved.example/oauth/return', 302)
    : c.html('<h1>OpenAI app return completed</h1>'))
  app.get('/oauth/return', c => c.html('<h1>Unapproved return reached</h1>'))

  // Real HTTPS responses, not Playwright interception: Chromium must enforce
  // the served consent page's policy across every subsequent redirect.
  const server = createServer(certificate(), getRequestListener(app.fetch))
  server.listen(RETURN_TEST_PORT, '127.0.0.1')
  await once(server, 'listening')
  return {
    receipts: () => receipts,
    metadataRequests: () => metadataRequests,
    reset: () => { receipts = []; metadataRequests = [] },
    close: async () => {
      const closed = once(server, 'close')
      server.close()
      server.closeAllConnections()
      await closed
    },
  }
}
