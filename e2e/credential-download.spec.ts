import { expect, test } from '@playwright/test'
import { harness, pageState, postForm } from '../test/support/market-identity-browser-harness.ts'

test('downloaded files gate confirmation and fallback preserves separate values', async ({ page }) => {
  const { app, memory } = harness()
  const start = await pageState(app, '/join')
  const response = await postForm(app, '/join', start.cookie, {
    action: 'stage', csrf: start.csrf, handle: 'download-test', model: '', client_class: 'hosted_browser',
  })
  const html = await response.text()
  await page.route('https://market.test/join', async route => {
    if (route.request().method() === 'POST') {
      const fields = Object.fromEntries(new URLSearchParams(route.request().postData() ?? ''))
      const confirmed = await postForm(app, '/join', start.cookie, fields)
      await route.fulfill({ status: confirmed.status, headers: Object.fromEntries(confirmed.headers), body: await confirmed.text() })
      return
    }
    await route.fulfill({ status: 200, headers: Object.fromEntries(response.headers), body: html })
  })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.name))
  await page.goto('https://market.test/join')
  const finish = page.locator('[data-finish]')
  await expect(finish).toBeDisabled()
  for (const kind of ['key', 'recovery-codes']) {
    const downloadEvent = page.waitForEvent('download')
    await page.locator(`[data-download="${kind}"]`).click()
    const download = await downloadEvent
    expect(download.suggestedFilename()).toBe(`1f3ea-download-test-${kind}.txt`)
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
    const content = Buffer.concat(chunks).toString('utf8')
    const shown = await page.locator(`[data-value="${kind}"]`).textContent()
    expect(content === shown + '\n').toBe(true)
    if (kind === 'key') await expect(finish).toBeDisabled()
  }
  await expect(finish).toBeEnabled()
  expect(memory.confirmed()).toBe(false)
  await page.reload()
  await expect(finish).toBeDisabled()
  await page.getByText("Download didn't work?").click()
  await page.locator('[data-copied]').check()
  await expect(finish).toBeEnabled()
  await expect(page.locator('[data-value="recovery-codes"]')).toHaveCSS('white-space', 'pre-wrap')
  await finish.click()
  await expect(page.getByRole('heading', { name: 'download-test now runs a store' })).toBeVisible()
  expect(memory.confirmed()).toBe(true)
  expect(errors).toEqual([])
})
