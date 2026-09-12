import { expect, test } from '@playwright/test'
import { ABOUT_HTML, CITY_BRIDGE_HTML, HELP_HTML, treasuryDocument } from '../src/human-pages.ts'
import { GUIDE_CSS } from '../src/human-style.ts'

function withInlineStyle(html: string): string {
  return html.replace('<link rel="stylesheet" href="/guide.css">', `<style>${GUIDE_CSS}</style>`)
}

const TREASURY_HTML = treasuryDocument({
  address: `0x${'ab'.repeat(20)}`,
  network: 'base',
  usdc_balance_onchain: 'rpc-unavailable — check the address yourself',
  fees_collected_usdc: 51,
  fees_count: 51,
  recent_fees: [{
    id: 51,
    handle: 'merchant-with-a-long-public-handle',
    listing_id: 41,
    amount_usdc: 1,
    tx_hash: `0x${'cd'.repeat(32)}`,
    created_at: '2026-09-12T12:00:00.000Z',
  }],
  fees_returned: 50,
  fees_page_size: 50,
  fees_has_more: true,
  fees_next_before_id: 2,
  note: 'Every accepted listing fee is verifiable on-chain.',
})

test('treasury values stay inside every release viewport and link to older fees', async ({ page }) => {
  await page.setContent(withInlineStyle(TREASURY_HTML))

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('1F3EA public books')
  await expect(page.getByRole('link', { name: 'Read older fees' }))
    .toHaveAttribute('href', '/treasury?limit=50&before_id=2')
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true)
})

for (const [name, html, heading] of [
  ['about', ABOUT_HTML, '1F3EA is a market for AI agents.'],
  ['help', HELP_HTML, 'How to enter and use the market.'],
  ['city bridge', CITY_BRIDGE_HTML, 'Use the market from inside the city.'],
] as const) {
  test(`${name} stays readable, linked, and inside every release viewport`, async ({ page }) => {
    await page.setContent(withInlineStyle(html))

    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading)
    const guide = page.getByRole('navigation', { name: 'Market guide' })
    await expect(guide.getByRole('link', { name: 'About', exact: true })).toBeVisible()
    await expect(guide.getByRole('link', { name: 'Help', exact: true })).toBeVisible()
    await expect(guide.getByRole('link', { name: 'City bridge', exact: true })).toBeVisible()
    await expect(guide.getByRole('link', { name: 'Shop window', exact: true })).toBeVisible()
    await expect(page.locator('.guide-footer .operator')).toContainText('TWAMD LLC')
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true)
  })
}
