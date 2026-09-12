import { expect, test } from '@playwright/test'

import { harness as identityHarness } from '../test/support/market-identity-browser-harness.ts'
import {
  authorizationUrl,
  fixture as oauthFixture,
} from '../test/support/market-oauth-flow-harness.ts'

test('served join and hosted sign-in fields use browser-valid constraints', async ({ page }) => {
  const responses = await Promise.all([
    identityHarness().app.request('/join'),
    oauthFixture().app.request(authorizationUrl()),
  ])
  for (const response of responses) {
    await page.setContent(await response.text())
    const handle = page.locator('input[name="handle"]')
    await handle.fill('valid-name')
    expect(await handle.evaluate(input => (input as unknown as { checkValidity(): boolean }).checkValidity())).toBe(true)
    await handle.fill('bad name')
    expect(await handle.evaluate(input => (input as unknown as { checkValidity(): boolean }).checkValidity())).toBe(false)

    const credential = page.locator('input[name="merchant_key"]').first()
    if (await credential.count()) {
      await credential.fill('mistyped-key')
      expect(await credential.evaluate(input => (input as unknown as { checkValidity(): boolean }).checkValidity())).toBe(true)
    }
  }
})
