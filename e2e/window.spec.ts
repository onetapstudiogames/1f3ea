import { expect, test, type Page } from '@playwright/test'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'
import { WINDOW_CSS } from '../src/window-style.ts'

const ORIGIN = 'https://market-window.test'
const LONG_DESCRIPTION = 'Every public word stays available in the focused read. '.repeat(40) +
  'END-OF-DESCRIPTION'
const LONG_STOREFRONT = 'Patient tools for small agents. '.repeat(4) + 'END-OF-STOREFRONT'

const AISLE_NAMES = [
  'skills', 'prompts', 'tools', 'data', 'knowledge', 'services', 'wanted', 'world', 'other',
] as const

function aisleVector(counts: Partial<Record<(typeof AISLE_NAMES)[number], number>> = {}) {
  return AISLE_NAMES.map(name => ({ name, count: counts[name] ?? 0 }))
}

interface Reply {
  status?: number
  body: unknown
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function snapshot(overrides: Record<string, unknown> = {}) {
  const payload = {
    events: [
      {
        id: 15,
        kind: 'listing_edit', actor: 'safe-store', at: '2026-08-10T10:00:04Z',
        detail: { listing_id: 15, changed_fields: ['description', 'preview'] },
      },
      {
        id: 14,
        kind: 'world_canceled', actor: 'other-store', at: '2026-08-10T10:00:03.500Z',
        detail: { listing_id: 14 },
      },
      {
        id: 13,
        kind: 'listing_edit', actor: 'safe-store', at: '2026-08-10T10:00:03Z',
        detail: { listing_id: 15, changed_fields: ['description', 'preview'] },
      },
      {
        id: 12,
        kind: 'listing', actor: 'safe-store', at: '2026-08-10T10:00:02Z',
        detail: { listing_id: 10 },
      },
      {
        id: 11,
        kind: 'world_sale', actor: 'safe-store', at: '2026-08-10T10:00:01Z',
        detail: { listing_id: 12, amount_usdc: 2 },
      },
      {
        id: 10,
        kind: 'world_canceled', actor: 'safe-store', at: '2026-08-10T10:00:00Z',
        detail: { listing_id: 13 },
      },
    ],
    merchants: [
      { id: 1, handle: 'safe-store', line: LONG_STOREFRONT, model: 'test-model', listings: 2 },
    ],
    merchant_total: 1,
    aisles: aisleVector({ tools: 2 }),
    listings: [
      {
        id: 10, merchant: 'safe-store', title: 'Long listing',
        description: LONG_DESCRIPTION, preview: 'public',
        price_usdc: 0, sales: 1, votes: 2, tags: ['safe'], aisle: 'tools',
      },
      {
        id: 11, merchant: 'safe-store', title: 'Second listing',
        description: 'A second coherent snapshot row', preview: 'public',
        price_usdc: 0, sales: 0, votes: 0, tags: ['safe'], aisle: 'tools',
      },
    ],
    refreshed_at: '2026-08-10T10:00:00Z',
    ...overrides,
  }
  const events = payload.events as Array<{ id?: unknown }>
  const merchants = payload.merchants as Array<{ id?: unknown }>
  const listings = payload.listings as unknown[]
  const aisles = payload.aisles as Array<{ count?: unknown }>
  const eventsTotal = Number(overrides.events_total ?? events.length)
  const listingsTotal = Number(overrides.listings_total ?? aisles.reduce(
    (sum, row) => sum + (Number.isSafeInteger(row.count) ? Number(row.count) : 0), 0,
  ))
  const merchantTotal = Number(payload.merchant_total)
  const eventsHaveMore = eventsTotal > events.length
  const listingsHaveMore = listingsTotal > listings.length
  const merchantsHaveMore = merchantTotal > merchants.length
  return {
    ...payload,
    events_total: eventsTotal,
    events_returned: events.length,
    events_page_size: 100,
    events_has_more: eventsHaveMore,
    events_more_url: eventsHaveMore
      ? `/api/events?scope=window&before_id=${String(events.at(-1)?.id)}`
      : null,
    listings_total: listingsTotal,
    listings_returned: listings.length,
    listings_page_size: 50,
    listings_has_more: listingsHaveMore,
    listings_more_url: listingsHaveMore ? '/api/shelves' : null,
    merchants_returned: merchants.length,
    merchants_page_size: 500,
    merchants_has_more: merchantsHaveMore,
    merchants_more_url: merchantsHaveMore
      ? `/api/merchants?after_id=${String(merchants.at(-1)?.id)}`
      : null,
  }
}

async function serveWindow(
  page: Page,
  replyFor: (url: URL) => Reply | null | Promise<Reply | null>,
) {
  const unexpected: string[] = []
  await page.route(ORIGIN + '/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/window') {
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: WINDOW_HTML })
      return
    }
    if (url.pathname === '/window.css') {
      await route.fulfill({ contentType: 'text/css; charset=utf-8', body: WINDOW_CSS })
      return
    }
    if (url.pathname === '/window.js') {
      await route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: WINDOW_JS })
      return
    }
    const reply = await replyFor(url)
    if (!reply) {
      unexpected.push(url.pathname + url.search)
      await route.abort('failed')
      return
    }
    await route.fulfill({
      status: reply.status ?? 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(reply.body),
    })
  })
  return unexpected
}

async function expectWindowFits(page: Page, projectName: string) {
  const fits = await page.evaluate(
    'document.documentElement.scrollWidth <= document.documentElement.clientWidth',
  ) as boolean
  expect(fits).toBe(true)
  const scheme = projectName.endsWith('-dark') ? 'dark' : 'light'
  const preferred = await page.evaluate(
    "matchMedia('(prefers-color-scheme: " + scheme + ")').matches",
  ) as boolean
  expect(preferred).toBe(true)
  const headlineContained = await page.locator('.activity-label').evaluate(label => {
    const heading = label.querySelector('h1')
    if (!heading) return false
    const labelBounds = label.getBoundingClientRect()
    const headingBounds = heading.getBoundingClientRect()
    return heading.scrollWidth <= heading.clientWidth &&
      headingBounds.left >= labelBounds.left && headingBounds.right <= labelBounds.right
  })
  expect(headlineContained).toBe(true)
}

test('focused reads keep counts and complete text with the source that supplied the rows', async (
  { page },
  testInfo,
) => {
  const requests = new Map<string, number>()
  const unexpected = await serveWindow(page, url => {
    const key = url.pathname + url.search
    requests.set(key, (requests.get(key) ?? 0) + 1)
    if (key === '/api/window') return { body: snapshot() }
    if (key === '/api/listing/10') {
      return {
        body: {
          listing: {
            id: 10, merchant: 'safe-store', title: 'Long listing',
            description: LONG_DESCRIPTION, preview: 'public', tags: ['safe'], aisle: 'tools',
            price_usdc: 0, sales: 1, votes: 2, state: 'live',
            created_at: '2026-08-10T10:00:00Z',
          },
          comments: [],
          comments_total: 0,
          comments_returned: 0,
          comments_page_size: 200,
          comments_has_more: false,
          comments_next_after_id: null,
        },
      }
    }
    if (key === '/api/store/safe-store') {
      return {
        body: {
          store: {
            handle: 'safe-store', line: LONG_STOREFRONT, model: 'test-model',
            joined_at: '2026-08-01T10:00:00Z', listings: 2,
          },
          listings: [
            { id: 10, title: 'Long listing', price_usdc: 0 },
            { id: 9, title: 'Older listing', price_usdc: 1 },
          ],
          total: 2,
          returned: 2,
          page_size: 2,
          has_more: false,
          next_before_id: null,
        },
      }
    }
    if (key === '/api/shelves?aisle=tools') {
      return {
        body: {
          aisles: aisleVector({ tools: 1, services: 3 }),
          listings: [
            {
              id: 8, merchant: 'safe-store', title: 'Focused aisle item',
              description: 'One row from this focused read', price_usdc: 0,
              sales: 0, votes: 0, tags: ['safe'], aisle: 'tools',
            },
          ],
          total: 1,
          returned: 1,
          page_size: 50,
          has_more: false,
          next_cursor: null,
        },
      }
    }
    return null
  })

  await page.goto(ORIGIN + '/window')
  await expect(page.locator('#window-status')).toContainText('Lights on')
  const listingExcerpt = page.getByRole('button', { name: 'Long listing, item #10' })
    .locator('.listing-row__description')
  const listingMarker = listingExcerpt.locator('.excerpt-marker')
  await expect(listingMarker).toBeVisible()
  await expect(listingMarker).toHaveText('EXCERPT')
  expect(await listingExcerpt.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  const storefrontExcerpt = page.getByRole('button', { name: 'Look into safe-store store' })
    .locator('.merchant-row__line')
  const storefrontMarker = storefrontExcerpt.locator('.excerpt-marker')
  await expect(storefrontMarker).toBeVisible()
  await expect(storefrontMarker).toHaveText('EXCERPT')
  await expect(storefrontExcerpt).toHaveCSS('-webkit-line-clamp', '2')
  const storefrontClipped = await storefrontExcerpt.evaluate(element => element.scrollHeight > element.clientHeight)
  if (!testInfo.project.name.startsWith('tablet-')) expect(storefrontClipped).toBe(true)
  await expect(page.locator('#activity-list')).toContainText(/updated description, preview on item #15/i)
  await expect(page.locator('#activity-list')).toContainText(/sold city ownership for item #12[^.]*2 USDC/i)
  await expect(page.locator('#activity-list')).not.toContainText('×2')
  await expect(page.locator('#activity-list > li.movement')).toHaveCount(6)
  await page.locator('#filter-input').fill('safe-store')
  await expect(page.locator('#activity-list')).toContainText('×2')
  await expect(page.locator('#activity-list > li.movement')).toHaveCount(4)
  await page.locator('#filter-input').fill('')

  await page.getByRole('button', { name: 'Long listing, item #10' }).click()
  await expect(page.locator('#listing-detail')).toContainText('END-OF-DESCRIPTION')
  await expect(page.locator('#listing-detail')).not.toContainText(/\bEXCERPT\b/)
  expect(requests.get('/api/listing/10')).toBe(1)
  await page.getByRole('button', { name: 'Close item details' }).click()

  await page.getByRole('button', { name: 'Look into safe-store store' }).click()
  await expect(page.locator('#listing-detail')).toContainText('END-OF-STOREFRONT')
  await expect(page.locator('#listing-detail')).not.toContainText(/\bEXCERPT\b/)
  expect(requests.get('/api/store/safe-store')).toBe(1)
  await page.getByRole('button', { name: 'Close item details' }).click()
  await expect(page.getByRole('button', { name: /show more|read more/i })).toHaveCount(0)

  await page.getByRole('button', { name: 'tools 2', exact: true }).click()
  await expect(page.getByRole('button', { name: 'tools 1', exact: true })).toBeVisible()
  await expect(page.locator('#market-counts')).toContainText('4 goods')
  await expect(page.locator('#listing-list')).toContainText('Focused aisle item')
  expect(requests.get('/api/shelves?aisle=tools')).toBe(1)
  await page.getByRole('button', { name: 'All goods 4', exact: true }).click()
  await expect(page.getByRole('button', { name: 'tools 2', exact: true })).toBeVisible()
  await expect(page.locator('#market-counts')).toContainText('2 goods')
  await expect(page.locator('#listing-list')).toContainText('Long listing')
  expect(unexpected).toEqual([])
  await expectWindowFits(page, testInfo.project.name)
})

test('focused item and store reads distinguish loading, not found, failure, and recovery', async (
  { page },
  testInfo,
) => {
  const heldListing404 = deferred<Reply>()
  const heldStore404 = deferred<Reply>()
  let listingReads = 0
  let storeReads = 0
  const unexpected = await serveWindow(page, url => {
    const key = url.pathname + url.search
    if (key === '/api/window') return { body: snapshot() }
    if (key === '/api/listing/10') {
      listingReads += 1
      if (listingReads === 1) return heldListing404.promise
      if (listingReads === 2) {
        return {
          body: {
            listing: { id: 10, merchant: 'safe-store', state: 'unexpected-state' },
            comments: [],
          },
        }
      }
      return {
        body: {
          listing: {
            id: 10, merchant: 'safe-store', title: 'Recovered listing',
            description: 'The complete item read recovered.', preview: 'public',
            tags: ['safe'], aisle: 'tools', price_usdc: 0, sales: 1, votes: 2,
            state: 'live', created_at: '2026-08-10T10:00:00Z',
          },
          comments: [],
          comments_total: 0,
          comments_returned: 0,
          comments_page_size: 200,
          comments_has_more: false,
          comments_next_after_id: null,
        },
      }
    }
    if (key === '/api/store/safe-store') {
      storeReads += 1
      if (storeReads === 1) return heldStore404.promise
      if (storeReads === 2) {
        return {
          body: {
            store: { handle: 'safe-store', line: 'Unreadable store payload', listings: 1 },
            listings: [],
          },
        }
      }
      return {
        body: {
          store: {
            handle: 'safe-store', line: 'The complete storefront read recovered.',
            model: 'test-model', joined_at: '2026-08-01T10:00:00Z', listings: 1,
          },
          listings: [{ id: 10, title: 'Recovered listing', price_usdc: 0 }],
          total: 1,
          returned: 1,
          page_size: 1,
          has_more: false,
          next_before_id: null,
        },
      }
    }
    return null
  })

  await page.goto(ORIGIN + '/window')
  await expect(page.locator('#window-status')).toContainText('Lights on')

  await page.getByRole('button', { name: 'Long listing, item #10' }).click()
  await expect(page.locator('#dialog-title')).toHaveText('Reading item #10')
  await expect(page.locator('#listing-detail')).toContainText(/reading the shelf label/i)
  heldListing404.resolve({ status: 404, body: { error: 'not found' } })
  await expect(page.locator('#dialog-title')).toHaveText('ITEM NOT FOUND')
  await expect(page.locator('#listing-detail')).toContainText(/no item was found/i)
  await expect(page.locator('#listing-detail').getByRole('button', { name: 'Try again' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Close item details' }).click()

  await page.getByRole('button', { name: 'Long listing, item #10' }).click()
  await expect(page.locator('#dialog-title')).toHaveText('ITEM READ FAILED')
  const listingRetry = page.locator('#listing-detail').getByRole('button', { name: 'Try again' })
  await expect(listingRetry).toBeVisible()
  await listingRetry.click()
  await expect(page.locator('#dialog-title')).toHaveText('ITEM #10')
  await expect(page.locator('#listing-detail')).toContainText('The complete item read recovered.')
  await page.getByRole('button', { name: 'Close item details' }).click()

  await page.getByRole('button', { name: 'Look into safe-store store' }).click()
  await expect(page.locator('#dialog-title')).toHaveText('Reading safe-store storefront')
  await expect(page.locator('#listing-detail')).toContainText(/reading the newest shelf labels/i)
  heldStore404.resolve({ status: 404, body: { error: 'not found' } })
  await expect(page.locator('#dialog-title')).toHaveText('STORE NOT FOUND')
  await expect(page.locator('#listing-detail')).toContainText(/no store was found/i)
  await expect(page.locator('#listing-detail').getByRole('button', { name: 'Try again' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Close item details' }).click()

  await page.getByRole('button', { name: 'Look into safe-store store' }).click()
  await expect(page.locator('#dialog-title')).toHaveText('STORE READ FAILED')
  const storeRetry = page.locator('#listing-detail').getByRole('button', { name: 'Try again' })
  await expect(storeRetry).toBeVisible()
  await storeRetry.click()
  await expect(page.locator('#dialog-title')).toHaveText('SAFE-STORE')
  await expect(page.locator('#listing-detail')).toContainText('The complete storefront read recovered.')

  expect(listingReads).toBe(3)
  expect(storeReads).toBe(3)
  expect(unexpected).toEqual([])
  await expectWindowFits(page, testInfo.project.name)
})

test('bounded API causes survive every HTTP failure view as inert text', async ({ page }, testInfo) => {
  const causes = {
    snapshot: 'market snapshot storage is unavailable; retry later',
    aisle: 'aisle index is unavailable; retry later',
    listing: '<img src=x onerror="window.pwned=true"> listing storage is unavailable',
    store: 'store ledger is unavailable; retry later',
  }
  let snapshotReads = 0
  const unexpected = await serveWindow(page, url => {
    const key = url.pathname + url.search
    if (key === '/api/window') {
      snapshotReads += 1
      return snapshotReads === 1
        ? { body: snapshot() }
        : { status: 503, body: { error: causes.snapshot } }
    }
    if (key === '/api/shelves?aisle=tools') return { status: 503, body: { error: causes.aisle } }
    if (key === '/api/listing/10') return { status: 503, body: { error: causes.listing } }
    if (key === '/api/store/safe-store') return { status: 503, body: { error: causes.store } }
    return null
  })

  await page.goto(ORIGIN + '/window')
  await expect(page.locator('#window-status')).toContainText('Lights on')

  await page.getByRole('button', { name: 'Long listing, item #10' }).click()
  await expect(page.locator('#listing-detail')).toContainText(causes.listing)
  await expect(page.locator('#listing-detail img')).toHaveCount(0)
  await expect.poll(() => page.evaluate('window.pwned')).toBeUndefined()
  await page.getByRole('button', { name: 'Close item details' }).click()

  await page.getByRole('button', { name: 'Look into safe-store store' }).click()
  await expect(page.locator('#listing-detail')).toContainText(causes.store)
  await page.getByRole('button', { name: 'Close item details' }).click()

  await page.getByRole('button', { name: 'tools 2', exact: true }).click()
  await expect(page.locator('#listing-list')).toContainText(causes.aisle)

  await page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
  await expect.poll(() => snapshotReads).toBe(2)
  await expect(page.locator('#window-status')).toContainText(causes.snapshot)

  expect(unexpected).toEqual([])
  await expectWindowFits(page, testInfo.project.name)
})

test('background failure survives focused settlement and invalid focused bundles fail together', async (
  { page },
  testInfo,
) => {
  const toolsRead = deferred<Reply>()
  let snapshotReads = 0
  const unexpected = await serveWindow(page, url => {
    const key = url.pathname + url.search
    if (key === '/api/window') {
      snapshotReads += 1
      return snapshotReads === 1
        ? { body: snapshot() }
        : { status: 503, body: { error: 'background snapshot failed' } }
    }
    if (key === '/api/shelves?aisle=tools') return toolsRead.promise
    if (key === '/api/shelves?aisle=services') {
      return {
        body: {
          aisles: aisleVector({ tools: 1, services: 1 }),
          listings: [],
          total: 1,
          returned: 0,
          page_size: 50,
          has_more: true,
          next_cursor: null,
        },
      }
    }
    return null
  })

  await page.goto(ORIGIN + '/window')
  await expect(page.locator('#window-status')).toContainText('Lights on')
  await page.getByRole('button', { name: 'tools 2', exact: true }).click()
  await expect(page.locator('#window-status')).toContainText(/reading|loading/i)
  await page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
  await expect.poll(() => snapshotReads).toBe(2)
  await expect(page.locator('#window-status')).toContainText(/latest market read failed|background.*failed/i)
  await expect(page.locator('#window-status').getByRole('button', { name: 'Try again' })).toBeVisible()

  toolsRead.resolve({
    body: {
      aisles: aisleVector({ tools: 1, services: 3 }),
      listings: [{
        id: 8, merchant: 'safe-store', title: 'Focused aisle item', description: '',
        price_usdc: 0, sales: 0, votes: 0, tags: [], aisle: 'tools',
      }],
      total: 1,
      returned: 1,
      page_size: 50,
      has_more: false,
      next_cursor: null,
    },
  })
  await expect(page.locator('#listing-list')).toContainText('Focused aisle item')
  await expect(page.locator('#window-status')).toContainText(/latest market read failed|background.*failed/i)
  await expect(page.locator('#window-status').getByRole('button', { name: 'Try again' })).toBeVisible()

  await page.getByRole('button', { name: 'services 3', exact: true }).click()
  await expect(page.locator('#listing-list')).toContainText(/failed|could not/i)
  await expect(page.locator('#listing-list')).not.toContainText('No goods were found')
  await expect(page.locator('#listing-list').getByRole('button', { name: 'Try again' })).toBeVisible()
  expect(unexpected).toEqual([])
  await expectWindowFits(page, testInfo.project.name)
})

test('every snapshot panel distinguishes loading, failure, retry, and completed empty', async (
  { page },
  testInfo,
) => {
  const first = deferred<Reply>()
  const second = deferred<Reply>()
  let attempts = 0
  const unexpected = await serveWindow(page, url => {
    if (url.pathname !== '/api/window') return null
    attempts += 1
    return attempts === 1 ? first.promise : second.promise
  })
  const panels = [
    '#market-counts', '#aisle-list', '#activity-list', '#listing-list', '#merchant-list',
  ]

  await page.goto(ORIGIN + '/window')
  await page.locator('#filter-input').fill('still-loading')
  for (const selector of panels)
    await expect(page.locator(selector)).toContainText(/reading|loading|counting|turning on/i)

  first.resolve({ status: 503, body: { error: 'test failure' } })
  for (const selector of panels)
    await expect(page.locator(selector)).toContainText(/failed|unavailable|out of view|fogged/i)
  await page.getByRole('button', { name: 'Try again' }).first().click()
  await expect.poll(() => attempts).toBe(2)
  await page.locator('#filter-input').fill('')
  for (const selector of panels)
    await expect(page.locator(selector)).toContainText(/reading|loading|counting|turning on/i)

  second.resolve({
    body: snapshot({
      events: [], events_has_more: false, merchants: [], merchant_total: 0,
      aisles: aisleVector(), listings: [],
    }),
  })
  await expect(page.locator('#window-status')).toContainText('Lights on')
  await expect(page.locator('#activity-list')).toContainText(/no recent movement|quiet/i)
  await expect(page.locator('#listing-list')).toContainText(/no goods/i)
  await expect(page.locator('#merchant-list')).toContainText(/no shopkeeper/i)
  for (const selector of ['#activity-list', '#listing-list', '#merchant-list']) {
    await expect(page.locator(selector).locator('.empty-state--error')).toHaveCount(0)
    await expect(page.locator(selector)).not.toContainText(/bounded|newest \d+|first \d+|try another/i)
  }
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
  expect(unexpected).toEqual([])
  await expectWindowFits(page, testInfo.project.name)
})

test('filter empties name only bounds that can hide another matching record', async (
  { page },
  testInfo,
) => {
  const unexpected = await serveWindow(page, url => url.pathname === '/api/window'
    ? {
        body: snapshot({
          events: Array.from({ length: 100 }, (_, index) => ({
            id: 101 - index,
            kind: 'listing', actor: 'safe-store', at: '2026-08-10T10:00:00Z',
            detail: { listing_id: 101 - index },
          })),
          events_total: 101,
          merchants: Array.from({ length: 500 }, (_, index) => ({
            id: index + 1, handle: `store-${index + 1}`,
            line: 'Patient tools', model: 'test-model', listings: 1,
          })),
          merchant_total: 501,
          aisles: aisleVector({ tools: 51 }),
          listings: Array.from({ length: 50 }, (_, index) => ({
            id: index + 1, merchant: `store-${index + 1}`, title: `Patient tool ${index + 1}`,
            description: 'A known shelf item', price_usdc: 0, sales: 0, votes: 0,
            tags: ['safe'], aisle: 'tools',
          })),
        }),
      }
    : null)

  await page.goto(ORIGIN + '/window')
  await expect(page.locator('#window-status')).toContainText('Lights on')
  await page.locator('#filter-input').fill('not-in-the-loaded-slice')
  await expect(page.locator('#activity-list')).toContainText(/bounded|newest 100/i)
  await expect(page.locator('#listing-list')).toContainText(/bounded|newest 50/i)
  await expect(page.locator('#merchant-list')).toContainText(/bounded|first 500/i)
  await expect(page.locator('#merchant-list a[href="/api/merchants"]')).toBeVisible()
  for (const selector of ['#activity-list', '#listing-list', '#merchant-list'])
    await expect(page.locator(selector).getByRole('button', { name: 'Try again' })).toHaveCount(0)
  await expect(page.locator('#clear-filter')).toBeVisible()
  expect(unexpected).toEqual([])
  await expectWindowFits(page, testInfo.project.name)
})
