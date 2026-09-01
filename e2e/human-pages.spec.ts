import { expect, test } from '@playwright/test'
import { ABOUT_HTML, CITY_BRIDGE_HTML, HELP_HTML } from '../src/human-pages.ts'
import { GUIDE_CSS } from '../src/human-style.ts'

function withInlineStyle(html: string): string {
  return html.replace('<link rel="stylesheet" href="/guide.css">', `<style>${GUIDE_CSS}</style>`)
}

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
