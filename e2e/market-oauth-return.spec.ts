import { expect, test, type Page } from '@playwright/test'
import { authorizationUrl, MERCHANT_KEY, STATE } from '../test/support/market-oauth-flow-harness.ts'
import {
  RETURN_CALLBACKS, RETURN_TEST_CLIENT, RETURN_TEST_ORIGIN, RETURN_TEST_PORT,
  startReturnTestServer,
} from './market-oauth-return-server.ts'

test.use({
  ignoreHTTPSErrors: true,
  launchOptions: { args: [
    '--no-proxy-server',
    `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${RETURN_TEST_PORT}, MAP platform.openai.com 127.0.0.1:${RETURN_TEST_PORT}, MAP chat.example.test 127.0.0.1:${RETURN_TEST_PORT}, MAP unapproved.example 127.0.0.1:${RETURN_TEST_PORT}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`,
  ] },
})

let server: Awaited<ReturnType<typeof startReturnTestServer>>
test.beforeAll(async () => { server = await startReturnTestServer() })
test.beforeEach(() => server.reset())
test.afterEach(async ({ page }) => { await page.close() })
test.afterAll(async () => { await server?.close() })

async function openConsent(page: Page, callback: string) {
  const response = await page.goto(`${RETURN_TEST_ORIGIN}${authorizationUrl({
    client_id: RETURN_TEST_CLIENT,
    redirect_uri: callback,
    resource: `${RETURN_TEST_ORIGIN}/mcp/connect`,
  })}`)
  expect(response?.status()).toBe(200)
}

async function submit(page: Page, action: 'approve' | 'cancel') {
  if (action === 'approve') await page.getByLabel('Current merchant key').fill(MERCHANT_KEY)
  const response = page.waitForResponse(value => value.url() === `${RETURN_TEST_ORIGIN}/oauth/authorize`
    && value.request().method() === 'POST')
  await page.getByRole('button', { name: action === 'approve' ? 'Connect this merchant' : 'Cancel', exact: true }).click()
  const returned = await response
  expect(returned.status()).toBe(302)
  expect((await page.context().cookies()).some(cookie => cookie.name === '__Host-1f3ea_oauth')).toBe(false)
  return returned
}

for (const action of ['approve', 'cancel'] as const) {
  for (const destination of ['direct', 'platform'] as const) {
    test(`${action} preserves the market 302 and completes the ${destination} OpenAI return`, async ({ page }) => {
      const callback = RETURN_CALLBACKS[destination]
      await openConsent(page, callback)
      const blocked = new Promise<never>((_resolve, reject) => {
        page.on('console', message => {
          if (/form-action/iu.test(message.text())) reject(new Error(`Chromium blocked the return: ${message.text()}`))
        })
      })
      const response = await Promise.race([submit(page, action), blocked])
      const location = new URL(response.headers().location!)
      expect(location.origin + location.pathname).toBe(callback)
      expect(location.searchParams.get('state')).toBe(STATE)
      expect(location.searchParams.get('iss')).toBe(RETURN_TEST_ORIGIN)
      if (action === 'approve') {
        expect(location.searchParams.get('code')).toMatch(/^1f3ea_ac_[0-9a-f]{64}$/u)
        expect(location.searchParams.has('error')).toBe(false)
      } else {
        expect(location.searchParams.get('error')).toBe('access_denied')
        expect(location.searchParams.has('code')).toBe(false)
      }
      await expect(page.getByRole('heading', { name: destination === 'direct'
        ? 'ChatGPT callback reached' : 'OpenAI app return completed' })).toBeVisible()
      expect(server.receipts()).toEqual([
        { origin: 'https://chatgpt.com', path: new URL(callback).pathname, method: 'GET', status: destination === 'direct' ? 200 : 302 },
        ...(destination === 'platform' ? [{ origin: 'https://platform.openai.com', path: '/apps-manage/oauth', method: 'GET', status: 200 }] : []),
      ])
    })
  }
}

for (const destination of ['unapproved', 'otherClient'] as const) {
  test(`${destination} cannot continue through an unapproved return origin`, async ({ page }) => {
    await openConsent(page, RETURN_CALLBACKS[destination])
    const violation = page.waitForEvent('console', { predicate: message => /form-action/iu.test(message.text()) })
    await submit(page, 'approve')
    expect((await violation).text()).toContain('form-action')
    expect(server.receipts()).toEqual(destination === 'unapproved' ? [
      { origin: 'https://chatgpt.com', path: '/connector/oauth/e2e-unapproved', method: 'GET', status: 302 },
      { origin: 'https://platform.openai.com', path: '/apps-manage/oauth', method: 'GET', status: 302 },
    ] : [
      { origin: 'https://chat.example.test', path: '/oauth/callback', method: 'GET', status: 302 },
    ])
    await expect(page.getByRole('heading', { name: /return (completed|reached)/u })).toHaveCount(0)
  })
}
