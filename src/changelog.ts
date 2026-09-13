import type { Context, Hono } from 'hono'

import { CHANGELOG_MARKDOWN } from './changelog-source.ts'
import { guideDocument } from './human-pages.ts'
import { SEARCH_DESCRIPTION } from './market-facts.ts'

export const CHANGELOG_TEXT = CHANGELOG_MARKDOWN

interface ChangelogCategory { readonly name: string; readonly items: readonly string[] }
interface ChangelogEntry { readonly date: string; readonly categories: readonly ChangelogCategory[] }

export function parseChangelog(markdown: string): readonly ChangelogEntry[] {
  const entries: Array<{ date: string; categories: Array<{ name: string; items: string[] }> }> = []
  let entry: (typeof entries)[number] | null = null
  let category: { name: string; items: string[] } | null = null
  for (const rawLine of markdown.split(/\r?\n/u)) {
    const line = rawLine.trimEnd()
    const date = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/u.exec(line)
    if (date) {
      entry = { date: date[1]!, categories: [] }
      entries.push(entry)
      category = null
      continue
    }
    const heading = /^###\s+(.+?)\s*$/u.exec(line)
    if (heading && entry) {
      category = { name: heading[1]!, items: [] }
      entry.categories.push(category)
      continue
    }
    const bullet = /^-\s+(.+?)\s*$/u.exec(line)
    if (bullet && category) category.items.push(bullet[1]!)
  }
  return entries
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}

function renderBody(entries: readonly ChangelogEntry[]): string {
  const sections = entries.map(entry => {
    const categories = entry.categories.map(category => `
      <section class="changelog-category">
        <h3>${escapeHtml(category.name)}</h3>
        <ul>${category.items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
      </section>`).join('')
    return `<article class="changelog-entry"><h2>${entry.date}</h2>${categories}</article>`
  }).join('')
  return `<main id="main-content" class="guide-main">
    <section class="guide-hero changelog-hero"><div><p class="kicker">Changelog</p>
    <h1>What changed on 1F3EA.</h1><p class="lede">Plain-language notes about the market, grouped by date and audience.</p>
    <p class="hero-note">Also available at <a href="/changelog.txt">/changelog.txt</a>.</p></div></section>
    <div class="changelog-entries">${sections}</div>
  </main>`
}

export const CHANGELOG_ENTRIES = parseChangelog(CHANGELOG_TEXT)
export const CHANGELOG_HTML = guideDocument({
  path: '/changelog', title: 'Changelog: what changed on 1F3EA',
  description: SEARCH_DESCRIPTION, current: 'changelog',
  body: renderBody(CHANGELOG_ENTRIES),
})

function headers(c: Context): void {
  c.header('Cache-Control', 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400')
  c.header('Content-Security-Policy', "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'none'; style-src 'self'; img-src 'self'; font-src 'none'; connect-src 'none'")
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Frame-Options', 'DENY')
  c.header('X-Robots-Tag', 'index, follow')
}

export function mountChangelogRoutes(app: Hono): void {
  app.get('/changelog', c => { headers(c); return c.html(CHANGELOG_HTML) })
  app.get('/changelog.txt', c => { headers(c); return c.text(CHANGELOG_TEXT) })
}
