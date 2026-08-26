import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { WINDOW_JS } from '../src/window-client.ts'
type FakeListener = (event: FakeEvent) => unknown
class FakeEvent {
  readonly target: FakeElement
  readonly currentTarget: FakeElement
  defaultPrevented = false
  propagationStopped = false
  constructor(target: FakeElement) {
    this.target = target
    this.currentTarget = target
  }
  preventDefault() { this.defaultPrevented = true }
  stopPropagation() { this.propagationStopped = true }
}
class FakeNode {
  readonly childNodes: FakeNode[] = []
  parentNode: FakeNode | null = null
  private ownText = ''
  get textContent(): string {
    return this.ownText + this.childNodes.map(node => node.textContent).join('')
  }
  set textContent(value: string) {
    this.ownText = String(value ?? '')
    this.replaceChildren()
  }
  append(...nodes: FakeNode[]) {
    for (const node of nodes) {
      if (node instanceof FakeDocumentFragment) {
        this.append(...[...node.childNodes])
        node.replaceChildren()
        continue
      }
      node.parentNode = this
      this.childNodes.push(node)
    }
  }
  replaceChildren(...nodes: FakeNode[]) {
    for (const child of this.childNodes) child.parentNode = null
    this.childNodes.length = 0
    this.append(...nodes)
  }
}
class FakeDocumentFragment extends FakeNode {}
class FakeElement extends FakeNode {
  readonly tagName: string
  readonly attributes = new Map<string, string>()
  readonly dataset: Record<string, string> = {}
  readonly listeners = new Map<string, FakeListener[]>()
  className = ''
  dateTime = ''
  hidden = false
  focused = false
  open = false
  type = ''
  value = ''
  constructor(tagName: string) {
    super()
    this.tagName = tagName.toUpperCase()
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, String(value)) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  addEventListener(type: string, listener: FakeListener) {
    const listeners = this.listeners.get(type) ?? []
    this.listeners.set(type, [...listeners, listener])
  }
  async click() {
    const event = new FakeEvent(this)
    for (const listener of this.listeners.get('click') ?? []) await listener(event)
  }
  showModal() { this.open = true }
  close() { this.open = false }
  focus() { this.focused = true }
  scrollIntoView() {}
}
class FakeDocument {
  readonly hidden = false
  readonly roots = new Map<string, FakeElement>()
  readonly listeners = new Map<string, FakeListener[]>()
  constructor() {
    for (const id of [
      'window-status', 'updated-at', 'market-counts', 'filter-input', 'clear-filter',
      'filter-note', 'activity-list', 'aisle-list', 'listing-list', 'merchant-list',
      'listing-dialog', 'dialog-close', 'listing-detail', 'dialog-title', 'window-main',
    ]) {
      const tag = id === 'listing-dialog'
        ? 'dialog'
        : id === 'activity-list' ? 'ol' : ['listing-list', 'merchant-list'].includes(id) ? 'ul' : 'div'
      this.roots.set(id, new FakeElement(tag))
    }
  }
  getElementById(id: string) { return this.roots.get(id) ?? null }
  createElement(tagName: string) { return new FakeElement(tagName) }
  createDocumentFragment() { return new FakeDocumentFragment() }
  addEventListener(type: string, listener: FakeListener) {
    const listeners = this.listeners.get(type) ?? []
    this.listeners.set(type, [...listeners, listener])
  }
}
interface FetchCall {
  url: URL
  init: Record<string, unknown>
}
function descendants(node: FakeNode): FakeElement[] {
  const found: FakeElement[] = []
  for (const child of node.childNodes) {
    if (child instanceof FakeElement) found.push(child)
    found.push(...descendants(child))
  }
  return found
}
function allElements(document: FakeDocument) {
  return [...document.roots.values()].flatMap(root => [root, ...descendants(root)])
}
function byAttribute(document: FakeDocument, name: string, value: string) {
  return allElements(document).find(element => element.getAttribute(name) === value)
}
async function settle() {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

const AISLE_NAMES = [
  'skills', 'prompts', 'tools', 'data', 'knowledge', 'services', 'wanted', 'world', 'other',
] as const

function aisleVector(counts: Partial<Record<(typeof AISLE_NAMES)[number], number>> = {}) {
  return AISLE_NAMES.map(name => ({ name, count: counts[name] ?? 0 }))
}

function listingFixture(id: number, aisle = 'tools') {
  return {
    id, merchant: `store-${id}`, title: `Shelf item ${id}`, description: 'Public row',
    price_usdc: 0, sales: 0, votes: 0, tags: [], aisle,
  }
}

function merchantFixture(id: number) {
  return { handle: `store-${id}`, line: `Store ${id}`, model: 'test-model', listings: 0 }
}

function boundedSnapshot(goodsTotal: number, goodsRows: number, merchantTotal: number, merchantRows: number) {
  return {
    events: [], events_has_more: false,
    merchants: Array.from({ length: merchantRows }, (_, index) => merchantFixture(index + 1)),
    merchant_total: merchantTotal,
    listings: Array.from({ length: goodsRows }, (_, index) => listingFixture(index + 1)),
    aisles: aisleVector({ tools: goodsTotal }),
    refreshed_at: '2026-08-10T10:00:00Z',
  }
}

function startWindowClient(fetch: (input: unknown, init?: Record<string, unknown>) => Promise<unknown>) {
  const document = new FakeDocument()
  let currentUrl = new URL('https://window.example/window')
  let timerId = 0
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const fakeWindow = {
    location: { href: currentUrl.href, origin: currentUrl.origin },
    history: {
      replaceState(_state: unknown, _title: string, value: unknown) {
        currentUrl = new URL(String(value), currentUrl)
        fakeWindow.location.href = currentUrl.href
        fakeWindow.location.origin = currentUrl.origin
      },
    },
    setTimeout(callback: () => void, delay: number) {
      timerId += 1
      timers.set(timerId, { callback, delay })
      return timerId
    },
    clearTimeout(id: number) { timers.delete(id) },
  }
  const context = vm.createContext({
    AbortController, Date, Intl, Map, Math, Number, Promise, Set, String, URL, console,
    document, fetch, globalThis: undefined, window: fakeWindow,
  })
  vm.runInContext(WINDOW_JS, context, { timeout: 1_000 })
  return { document, timers }
}

async function enterFilter(document: FakeDocument, value: string) {
  const filter = document.getElementById('filter-input')
  assert.ok(filter)
  filter.value = value
  for (const listener of filter.listeners.get('input') ?? []) await listener(new FakeEvent(filter))
}

function assertPanelsMatch(document: FakeDocument, pattern: RegExp) {
  for (const id of [
    'market-counts', 'aisle-list', 'activity-list', 'listing-list', 'merchant-list', 'filter-note',
  ]) {
    const panel = document.getElementById(id)
    assert.ok(panel)
    assert.match(panel.textContent, pattern, `${id} must name the same read state`)
  }
}

test('the shop window fetches only public data and renders hostile listing detail as text', async () => {
  const document = new FakeDocument()
  const calls: FetchCall[] = []
  let currentUrl = new URL('https://window.example/window')
  let timerId = 0
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const hostileTitle = '<script>globalThis.pwned = true</script>'
  const hostileDescription = '<img src=x onerror="globalThis.pwned=true"> ' +
    'A complete focused description must keep every public word. '.repeat(40) + 'END-OF-DESCRIPTION'
  const hostilePreview = 'javascript:globalThis.pwned=true'
  const hostileTag = '\u202E<svg onload="globalThis.pwned=true">'
  const hostileComment = '<script>globalThis.pwned=true</script><img src=x onerror=globalThis.pwned=true>'
  const longStoreLine = 'Patient tools. '.repeat(8) + 'END-OF-STOREFRONT'
  const heldCachedAisleRead = deferred<ReturnType<typeof jsonResponse>>()
  const heldRefreshAisleRead = deferred<ReturnType<typeof jsonResponse>>()
  let aisleAttempts = 0
  const payloads: Record<string, unknown> = {
    '/api/window': {
      events: [
        {
          kind: 'listing_edit', actor: 'safe-store', at: '2026-08-10T10:00:04Z',
          detail: { listing_id: 15, changed_fields: ['description', 'preview'] },
        },
        { kind: 'world_canceled', actor: 'other-store', at: '2026-08-10T10:00:03.500Z', detail: { listing_id: 14 } },
        {
          kind: 'listing_edit', actor: 'safe-store', at: '2026-08-10T10:00:03Z',
          detail: { listing_id: 15, changed_fields: ['description', 'preview'] },
        },
        { kind: 'listing', actor: 'safe-store', at: '2026-08-10T10:00:00Z', detail: { listing_id: 10 } },
        { kind: 'world_sale', actor: 'safe-store', at: '2026-08-10T10:00:02Z', detail: { listing_id: 12, amount_usdc: 2 } },
        { kind: 'world_canceled', actor: 'safe-store', at: '2026-08-10T10:00:03Z', detail: { listing_id: 13 } },
        { kind: 'flag', actor: 'anonymous', at: '2026-08-10T10:00:01Z', detail: { target_id: 10, target_type: 'listing' } },
        { kind: 'listing', actor: '<img>', at: '2026-08-10T10:00:00Z', detail: { listing_id: 'javascript:1' } },
      ],
      merchants: [
        { handle: 'safe-store', line: 'Patient tools', model: 'test-model', listings: 2, store_url: 'https://evil.example/pwn' },
      ],
      merchant_total: 1,
      events_has_more: false,
      aisles: aisleVector({ tools: 2, world: 1 }),
      listings: [
        {
          id: 10,
          merchant: 'safe-store',
          title: 'A safe shelf label',
          description: 'Open to read reviews',
          preview: 'public',
          price_usdc: 0,
          sales: 1,
          votes: 2,
          tags: ['safe'],
          aisle: 'tools',
          store_url: 'javascript:globalThis.pwned=true',
        },
        {
          id: 11,
          merchant: 'safe-store',
          title: 'A slow shelf label',
          description: 'Used to test the timeout state',
          price_usdc: 0,
          sales: 0,
          votes: 0,
          tags: ['slow'],
          aisle: 'tools',
        },
        {
          id: 12,
          merchant: 'safe-store',
          title: 'A city lantern',
          description: 'One unique thing in 1F3D9',
          price_usdc: 2,
          sales: 0,
          votes: 0,
          tags: ['city'],
          aisle: 'world',
          delivery_kind: 'city_ownership',
        },
      ],
      refreshed_at: '2026-08-10T10:00:00Z',
    },
    '/api/listing/10': {
      listing: {
        id: 10,
        merchant: 'safe-store',
        title: hostileTitle,
        description: hostileDescription,
        preview: hostilePreview,
        tags: [hostileTag, 'ordinary'],
        aisle: 'tools',
        price_usdc: 0,
        sales: 1,
        votes: 2,
        state: 'live',
        created_at: '2026-08-10T10:00:00Z',
        store_url: 'https://evil.example/pwn',
      },
      comments: [
        { id: 1, parent_id: 2, handle: 'buyer-one', body: hostileComment, verified_buyer: true, created_at: '2026-08-10T10:01:00Z' },
        { id: 2, parent_id: 1, handle: 'buyer-two', body: '\u202Ejavascript:alert(1)', verified_buyer: 'true', created_at: '2026-08-10T10:02:00Z' },
        { id: -4, parent_id: 'javascript:1', handle: '<img>', body: 'INVALID_HANDLE_MARKER', verified_buyer: 1, created_at: 'bad date' },
      ],
    },
    '/api/listing/12': {
      listing: {
        id: 12,
        merchant: 'safe-store',
        title: 'A city lantern',
        description: 'Ownership moved to a city resident.',
        preview: '',
        tags: ['city'],
        aisle: 'world',
        delivery_kind: 'city_ownership',
        price_usdc: 2,
        sales: 1,
        votes: 0,
        state: 'sold',
        created_at: '2026-08-10T10:00:00Z',
      },
      comments: [],
    },
    '/api/store/safe-store?limit=50': {
      store: {
        handle: 'safe-store', line: longStoreLine, model: 'test-model',
        joined_at: '2026-08-01T10:00:00Z', listings: 2,
      },
      listings: [
        { id: 10, title: 'A safe shelf label', price_usdc: 0 },
        { id: 9, title: 'An older useful thing', price_usdc: 1 },
      ],
    },
    '/api/shelves?aisle=tools': {
      aisles: aisleVector({ tools: 1, services: 3 }),
      listings: [
        {
          id: 8, merchant: 'safe-store', title: 'An aisle-only item', description: 'Older stock',
          price_usdc: 0, sales: 0, votes: 0, tags: ['older'], aisle: 'tools',
        },
      ],
    },
  }
  const fetch = async (input: unknown, init: Record<string, unknown> = {}) => {
    const url = new URL(String(input), currentUrl)
    calls.push({ url, init: { ...init } })
    if (url.pathname === '/api/shelves') {
      aisleAttempts += 1
      if (aisleAttempts === 2) return heldCachedAisleRead.promise
      if (aisleAttempts === 4) return heldRefreshAisleRead.promise
    }
    if (url.pathname === '/api/listing/11') {
      return new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal | undefined
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    const body = payloads[url.pathname + url.search] ?? payloads[url.pathname]
    if (body === undefined) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
    return { ok: true, status: 200, json: async () => body }
  }
  const fakeWindow = {
    location: { href: currentUrl.href, origin: currentUrl.origin },
    history: {
      replaceState(_state: unknown, _title: string, value: unknown) {
        currentUrl = new URL(String(value), currentUrl)
        fakeWindow.location.href = currentUrl.href
        fakeWindow.location.origin = currentUrl.origin
      },
    },
    setTimeout(callback: () => void, delay: number) {
      timerId += 1
      timers.set(timerId, { callback, delay })
      return timerId
    },
    clearTimeout(id: number) { timers.delete(id) },
  }
  const context = vm.createContext({
    AbortController, Date, Intl, Map, Math, Number, Promise, Set, String, URL, console, document, fetch,
    globalThis: undefined,
    pwned: false,
    window: fakeWindow,
  })
  vm.runInContext(WINDOW_JS, context, { timeout: 1_000 })
  await settle()
  assert.deepEqual(calls.map(call => call.url.pathname), ['/api/window'])
  for (const call of calls) {
    assert.equal(call.url.origin, currentUrl.origin)
    assert.ok(call.init.method === undefined || call.init.method === 'GET')
    assert.equal(call.init.credentials, 'omit')
  }
  assert.equal(calls.some(call => /\/api\/(?:me|purchases|buy|claim|comment|vote|flag)(?:\/|$)/.test(call.url.pathname)), false)
  assert.equal(calls.some(call => call.url.pathname.startsWith('/api/listing/')), false)
  assert.doesNotMatch(allElements(document).map(element => element.textContent).join('\n'), /INVALID_(?:MERCHANT|LISTING)_MARKER/)
  const listingControl = byAttribute(document, 'aria-label', 'A safe shelf label, item #10')
  assert.ok(listingControl, 'valid listing control was rendered')
  const worldListingControl = byAttribute(document, 'aria-label', 'A city lantern, item #12')
  assert.ok(worldListingControl, 'world listing control was rendered')
  assert.match(document.getElementById('listing-list')!.textContent, /CITY OWNERSHIP/)
  assert.match(document.getElementById('activity-list')!.textContent, /sold city ownership for item #12[^.]*2 USDC/i)
  assert.match(document.getElementById('activity-list')!.textContent, /closed world item #13/i)
  assert.match(
    document.getElementById('activity-list')!.textContent,
    /updated[^.]*description[^.]*preview[^.]*item #15|updated[^.]*item #15[^.]*description[^.]*preview/i,
  )
  assert.doesNotMatch(document.getElementById('activity-list')!.textContent, /(?:×\s*2|2\s+(?:times|receipts))/i)
  assert.equal(
    descendants(document.getElementById('activity-list')!)
      .filter(element => element.tagName === 'LI' && element.className === 'movement').length,
    6,
    'an intervening visible movement keeps otherwise identical edits separate',
  )
  await enterFilter(document, 'safe-store')
  assert.match(document.getElementById('activity-list')!.textContent, /(?:×\s*2|2\s+(?:times|receipts))/i)
  assert.equal(
    descendants(document.getElementById('activity-list')!)
      .filter(element => element.tagName === 'LI' && element.className === 'movement').length,
    4,
    'filtering happens before consecutive identical visible lines collapse',
  )
  await enterFilter(document, '')
  await listingControl.click()
  await settle()
  const detailCalls = calls.filter(call => call.url.pathname === '/api/listing/10')
  assert.equal(detailCalls.length, 1)
  assert.equal(calls.some(call => call.url.origin !== currentUrl.origin), false)
  assert.equal(calls.some(call => !['/api/window', '/api/listing/10'].includes(call.url.pathname)), false)
  const detail = document.getElementById('listing-detail')
  assert.ok(detail)
  assert.match(detail.textContent, new RegExp(hostileTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(detail.textContent, new RegExp(hostileDescription.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(detail.textContent, /javascript:globalThis\.pwned=true/)
  assert.match(detail.textContent, /<svg onload=/)
  assert.match(detail.textContent, /<img src=x onerror=/)
  assert.match(detail.textContent, /END-OF-DESCRIPTION/)
  const createdTags = allElements(document).map(element => element.tagName)
  assert.equal(createdTags.some(tag => ['SCRIPT', 'IMG', 'SVG'].includes(tag)), false)
  assert.equal(vm.runInContext('pwned', context), false)
  assert.equal(vm.runInContext('window.pwned', context), undefined)
  const comments = descendants(detail).filter(element => element.tagName === 'ARTICLE' && element.className === 'comment')
  assert.equal(comments.length, 3)
  assert.ok(comments.every(comment => Number(comment.dataset.depth) <= 3), 'cyclic reply parents terminate at a bounded depth')
  assert.equal(comments.filter(comment => descendants(comment).some(child => child.className === 'verified-buyer')).length, 1)
  assert.equal(detail.textContent.includes('<img>'), false, 'invalid comment handles are never used as rendered identities')
  assert.doesNotMatch(document.getElementById('activity-list')!.textContent, /flagged/i)

  await worldListingControl.click()
  await settle()
  assert.equal(calls.filter(call => call.url.pathname === '/api/listing/12').length, 1)
  assert.match(document.getElementById('dialog-title')!.textContent, /SOLD IN THE CITY/i)
  assert.match(detail.textContent, /ownership moved to its city buyer/i)
  assert.match(detail.textContent, /OFF SHELF/)

  const merchantControl = byAttribute(document, 'aria-label', 'Look into safe-store store')
  assert.ok(merchantControl, 'valid merchant control was rendered')
  detail.focused = false
  await merchantControl.click()
  await settle()
  assert.equal(calls.filter(call => call.url.pathname === '/api/store/safe-store').length, 1)
  assert.match(detail.textContent, /An older useful thing/)
  assert.match(detail.textContent, /recent goods/i)
  assert.match(detail.textContent, /END-OF-STOREFRONT/)
  assert.equal(detail.focused, true)

  const slowListingControl = byAttribute(document, 'aria-label', 'A slow shelf label, item #11')
  assert.ok(slowListingControl, 'slow listing control was rendered')
  void slowListingControl.click()
  await settle()
  const timeout = [...timers.values()].find(timer => timer.delay === 10_000)
  assert.ok(timeout, 'detail request has a bounded timeout')
  timeout.callback()
  await settle()
  assert.match(detail.textContent, /could not be read just now/i)
  assert.match(detail.textContent, /Try again/)

  const toolsAisle = allElements(document).find(element =>
    element.tagName === 'BUTTON' && element.textContent === 'tools 2')
  assert.ok(toolsAisle, 'aisle control was rendered')
  await toolsAisle.click()
  await settle()
  assert.equal(calls.filter(call => call.url.pathname === '/api/shelves').length, 1)
  assert.match(document.getElementById('listing-list')!.textContent, /An aisle-only item/)
  assert.equal(
    allElements(document).some(element => element.tagName === 'BUTTON' && element.textContent === 'tools 1'),
    true,
    'the focused aisle count moves with its focused rows',
  )
  assert.match(document.getElementById('market-counts')!.textContent, /4 goods/)

  const allGoods = allElements(document).find(element =>
    element.tagName === 'BUTTON' && element.textContent === 'All goods 4')
  assert.ok(allGoods)
  await allGoods.click()
  await settle()
  assert.match(document.getElementById('market-counts')!.textContent, /3 goods/)
  assert.equal(
    allElements(document).some(element => element.tagName === 'BUTTON' && element.textContent === 'tools 2'),
    true,
    'returning to All restores the snapshot counts with the snapshot rows',
  )
  assert.match(document.getElementById('listing-list')!.textContent, /A safe shelf label/)

  const refreshedToolsAisle = allElements(document).find(element =>
    element.tagName === 'BUTTON' && element.textContent === 'tools 2')
  assert.ok(refreshedToolsAisle)
  await refreshedToolsAisle.click()
  await settle()
  assert.match(document.getElementById('listing-list')!.textContent, /reading|loading|looking/i)
  await enterFilter(document, 'safe-store')
  assert.match(document.getElementById('listing-list')!.textContent, /reading|loading|looking/i)
  heldCachedAisleRead.resolve(jsonResponse({ error: 'focused aisle failed' }, 503))
  await settle()
  assert.match(document.getElementById('listing-list')!.textContent, /failed|out of view|could not/i)
  await enterFilter(document, 'safe')
  assert.match(document.getElementById('listing-list')!.textContent, /failed|out of view|could not/i)
  assert.match(document.getElementById('window-status')!.textContent, /failed|could not/i)
  const aisleRetry = descendants(document.getElementById('listing-list')!).find(element =>
    element.tagName === 'BUTTON' && /try again|retry/i.test(element.textContent))
  assert.ok(aisleRetry)
  await aisleRetry.click()
  await settle()
  assert.match(document.getElementById('listing-list')!.textContent, /An aisle-only item/)

  const refreshTimer = [...timers.values()].find(timer => timer.delay === 60_000)
  assert.ok(refreshTimer, 'the market uses one-minute completion-scheduled refreshes')
  refreshTimer.callback()
  await settle()
  assert.match(document.getElementById('listing-list')!.textContent, /reading|loading|looking/i)
  assert.match(document.getElementById('window-status')!.textContent, /reading|loading|looking/i)
  assert.doesNotMatch(document.getElementById('window-status')!.textContent, /lights on|watching live/i)
  assert.equal(calls.filter(call => call.url.pathname === '/api/shelves').length, 4)
  heldRefreshAisleRead.resolve(jsonResponse(payloads['/api/shelves?aisle=tools']))
  await settle()
  assert.match(document.getElementById('listing-list')!.textContent, /An aisle-only item/)
  assert.match(document.getElementById('window-status')!.textContent, /lights on|watching live/i)

  const filter = document.getElementById('filter-input')
  assert.ok(filter)
  filter.value = 'no-such-market-record'
  for (const listener of filter.listeners.get('input') ?? []) await listener(new FakeEvent(filter))
  for (const id of ['activity-list', 'listing-list', 'merchant-list']) {
    const list = document.getElementById(id)
    assert.ok(list)
    assert.ok(list.childNodes.every(child => child instanceof FakeElement && child.tagName === 'LI'))
  }
})

test('focused aisle reads reject partial counts and wrong-aisle rows as one failed bundle', async () => {
  const snapshotPayload = {
    events: [], events_has_more: false, merchants: [], merchant_total: 0,
    listings: [
      {
        id: 10, merchant: 'safe-store', title: 'Snapshot tool', description: 'Snapshot row',
        price_usdc: 0, sales: 0, votes: 0, tags: [], aisle: 'tools',
      },
    ],
    aisles: aisleVector({ tools: 1 }),
    refreshed_at: '2026-08-10T10:00:00Z',
  }
  const badPayloads = [
    {
      aisles: aisleVector({ tools: 1 }).slice(0, -1),
      listings: [
        {
          id: 8, merchant: 'safe-store', title: 'Partial vector row', description: '',
          price_usdc: 0, sales: 0, votes: 0, tags: [], aisle: 'tools',
        },
      ],
    },
    {
      aisles: aisleVector({ tools: 1, services: 3 }),
      listings: [
        {
          id: 7, merchant: 'safe-store', title: 'Wrong aisle row', description: '',
          price_usdc: 0, sales: 0, votes: 0, tags: [], aisle: 'services',
        },
      ],
    },
    {
      aisles: aisleVector({ tools: 0 }),
      listings: [
        {
          id: 6, merchant: 'safe-store', title: 'Count contradiction row', description: '',
          price_usdc: 0, sales: 0, votes: 0, tags: [], aisle: 'tools',
        },
      ],
    },
    {
      aisles: aisleVector({ tools: 1 }),
      listings: [],
    },
    {
      aisles: aisleVector({ tools: 51 }),
      listings: Array.from({ length: 49 }, (_, index) => listingFixture(index + 20)),
    },
    {
      aisles: AISLE_NAMES.map(name => ({ name, count: name === 'tools' ? null : 0 })),
      listings: [],
    },
  ]

  for (const focusedPayload of badPayloads) {
    const { document } = startWindowClient(async input => {
      const url = new URL(String(input), 'https://window.example')
      return jsonResponse(url.pathname === '/api/window' ? snapshotPayload : focusedPayload)
    })
    await settle()
    const tools = allElements(document).find(element =>
      element.tagName === 'BUTTON' && element.textContent === 'tools 1')
    assert.ok(tools)
    await tools.click()
    await settle()

    const listings = document.getElementById('listing-list')!
    assert.match(listings.textContent, /failed|could not|out of view/i)
    assert.equal(
      descendants(listings).some(element =>
        element.tagName === 'BUTTON' && /try again|retry/i.test(element.textContent)),
      true,
    )
    assert.match(document.getElementById('market-counts')!.textContent, /1 goods/)
    assert.doesNotMatch(listings.textContent, /Partial vector row|Wrong aisle row|Count contradiction row/)
  }
})

test('snapshot bounded rows reject underfill, overflow, and malformed records', async () => {
  const invalidSnapshots = [
    boundedSnapshot(1, 0, 0, 0),
    boundedSnapshot(0, 0, 1, 0),
    boundedSnapshot(51, 49, 0, 0),
    boundedSnapshot(51, 51, 0, 0),
    boundedSnapshot(0, 0, 501, 499),
    boundedSnapshot(0, 0, 501, 501),
    { ...boundedSnapshot(0, 0, 0, 0), merchant_total: null },
    {
      ...boundedSnapshot(0, 0, 0, 0),
      aisles: AISLE_NAMES.map(name => ({ name, count: name === 'tools' ? null : 0 })),
    },
    { ...boundedSnapshot(1, 0, 0, 0), listings: [{ id: 'not-an-id', aisle: 'tools' }] },
    { ...boundedSnapshot(0, 0, 1, 0), merchants: [{ handle: '<invalid>' }] },
  ]

  for (const payload of invalidSnapshots) {
    const { document } = startWindowClient(async () => jsonResponse(payload))
    await settle()
    assertPanelsMatch(document, /failed|unavailable|could not/i)
    assert.match(document.getElementById('window-status')!.textContent, /failed/i)
    assert.match(document.getElementById('window-status')!.textContent, /try again/i)
  }
})

test('snapshot and focused aisle rows accept the exact 50-row boundary and a larger total', async () => {
  for (const total of [50, 51]) {
    const snapshot = boundedSnapshot(total, 50, 0, 0)
    const { document } = startWindowClient(async input => {
      const url = new URL(String(input), 'https://window.example')
      return jsonResponse(url.pathname === '/api/window'
        ? snapshot
        : { aisles: aisleVector({ tools: total }), listings: snapshot.listings })
    })
    await settle()
    assert.match(document.getElementById('window-status')!.textContent, /lights on|watching live/i)
    const tools = allElements(document).find(element =>
      element.tagName === 'BUTTON' && element.textContent === `tools ${total}`)
    assert.ok(tools)
    await tools.click()
    await settle()
    assert.match(document.getElementById('window-status')!.textContent, /lights on|watching live/i)
    assert.equal(
      descendants(document.getElementById('listing-list')!)
        .filter(element => element.tagName === 'LI' && element.className === 'listing-row').length,
      50,
    )
  }
})

test('merchant census accepts exactly 500 rows at and above its public bound', async () => {
  for (const total of [500, 501]) {
    const { document } = startWindowClient(async () => jsonResponse(boundedSnapshot(0, 0, total, 500)))
    await settle()
    assert.match(document.getElementById('window-status')!.textContent, /lights on|watching live/i)
    assert.match(document.getElementById('market-counts')!.textContent, new RegExp(`${total} shopkeepers`))
    assert.doesNotMatch(document.getElementById('merchant-list')!.textContent, /failed|unavailable/i)
  }
})

test('focused store goods reject underfill and accept the exact 50-row boundary', async () => {
  const snapshot = boundedSnapshot(0, 0, 1, 1)
  for (const storePayload of [
    { store: { ...merchantFixture(1), listings: 1 }, listings: [] },
    { store: { ...merchantFixture(1), listings: null }, listings: [] },
    {
      store: { ...merchantFixture(1), listings: 51 },
      listings: Array.from({ length: 49 }, (_, index) => listingFixture(index + 1)),
    },
    {
      store: { ...merchantFixture(1), listings: 51 },
      listings: Array.from({ length: 51 }, (_, index) => listingFixture(index + 1)),
    },
  ]) {
    const { document } = startWindowClient(async input => {
      const url = new URL(String(input), 'https://window.example')
      return jsonResponse(url.pathname === '/api/window' ? snapshot : storePayload)
    })
    await settle()
    const merchant = byAttribute(document, 'aria-label', 'Look into store-1 store')
    assert.ok(merchant)
    await merchant.click()
    await settle()
    assert.match(document.getElementById('dialog-title')!.textContent, /store read failed/i)
    assert.match(document.getElementById('listing-detail')!.textContent, /try again/i)
  }

  for (const total of [50, 51]) {
    const listings = Array.from({ length: 50 }, (_, index) => listingFixture(index + 1))
    const { document } = startWindowClient(async input => {
      const url = new URL(String(input), 'https://window.example')
      return jsonResponse(url.pathname === '/api/window' ? snapshot : {
        store: { ...merchantFixture(1), listings: total }, listings,
      })
    })
    await settle()
    const merchant = byAttribute(document, 'aria-label', 'Look into store-1 store')
    assert.ok(merchant)
    await merchant.click()
    await settle()
    assert.equal(document.getElementById('dialog-title')!.textContent, 'STORE-1')
    assert.doesNotMatch(document.getElementById('listing-detail')!.textContent, /failed|dark/i)
  }
})

test('detail reads distinguish completed 404s from malformed successful payloads', async () => {
  let listingAttempts = 0
  let storeAttempts = 0
  const ready = {
    events: [], events_has_more: false,
    merchants: [
      { handle: 'safe-store', line: 'Patient tools', model: 'test-model', listings: 1 },
    ],
    merchant_total: 1,
    listings: [
      {
        id: 10, merchant: 'safe-store', title: 'Known shelf label', description: 'Public row',
        price_usdc: 0, sales: 0, votes: 0, tags: [], aisle: 'tools',
      },
    ],
    aisles: aisleVector({ tools: 1 }),
    refreshed_at: '2026-08-10T10:00:00Z',
  }
  const { document } = startWindowClient(async input => {
    const url = new URL(String(input), 'https://window.example')
    if (url.pathname === '/api/window') return jsonResponse(ready)
    if (url.pathname === '/api/listing/10') {
      listingAttempts += 1
      return listingAttempts === 1
        ? jsonResponse({ error: 'not found' }, 404)
        : jsonResponse({ listing: { id: 10, merchant: 'safe-store' }, comments: [] })
    }
    if (url.pathname === '/api/store/safe-store') {
      storeAttempts += 1
      return storeAttempts === 1
        ? jsonResponse({ error: 'not found' }, 404)
        : jsonResponse({ store: { handle: 'safe-store', listings: 1 }, listings: null })
    }
    return jsonResponse({ error: 'unexpected' }, 500)
  })
  await settle()
  const detail = document.getElementById('listing-detail')!
  const listing = byAttribute(document, 'aria-label', 'Known shelf label, item #10')
  assert.ok(listing)
  await listing.click()
  await settle()
  assert.match(detail.textContent, /no item was found|item was not found/i)
  assert.match(document.getElementById('dialog-title')!.textContent, /item not found/i)
  assert.doesNotMatch(document.getElementById('dialog-title')!.textContent, /reading/i)
  assert.equal(descendants(detail).some(element => element.className.includes('empty-state--error')), false)
  assert.doesNotMatch(detail.textContent, /try again|retry/i)

  await listing.click()
  await settle()
  assert.match(detail.textContent, /failed|could not|fogged/i)
  assert.match(document.getElementById('dialog-title')!.textContent, /item read failed/i)
  assert.doesNotMatch(document.getElementById('dialog-title')!.textContent, /reading/i)
  assert.equal(descendants(detail).some(element => element.className.includes('empty-state--error')), true)
  assert.match(detail.textContent, /try again|retry/i)

  const merchant = byAttribute(document, 'aria-label', 'Look into safe-store store')
  assert.ok(merchant)
  await merchant.click()
  await settle()
  assert.match(detail.textContent, /no store was found|store was not found/i)
  assert.match(document.getElementById('dialog-title')!.textContent, /store not found/i)
  assert.equal(descendants(detail).some(element => element.className.includes('empty-state--error')), false)
  assert.doesNotMatch(detail.textContent, /try again|retry/i)

  await merchant.click()
  await settle()
  assert.match(detail.textContent, /failed|could not|dark/i)
  assert.match(document.getElementById('dialog-title')!.textContent, /store read failed/i)
  assert.equal(descendants(detail).some(element => element.className.includes('empty-state--error')), true)
  assert.match(detail.textContent, /try again|retry/i)
})

test('snapshot and focused counts cannot be lower than their neighboring renderable rows', async () => {
  const contradictorySnapshot = {
    events: [], events_has_more: false,
    merchants: [{ handle: 'safe-store', line: 'Patient tools', model: 'test-model', listings: 1 }],
    merchant_total: 1,
    listings: [{
      id: 10, merchant: 'safe-store', title: 'Impossible snapshot row', description: '',
      price_usdc: 0, sales: 0, votes: 0, tags: [], aisle: 'tools',
    }],
    aisles: aisleVector({ tools: 0 }),
    refreshed_at: '2026-08-10T10:00:00Z',
  }
  const snapshotWindow = startWindowClient(async () => jsonResponse(contradictorySnapshot))
  await settle()
  assertPanelsMatch(snapshotWindow.document, /failed|unavailable|could not/i)
  assert.doesNotMatch(snapshotWindow.document.getElementById('listing-list')!.textContent, /Impossible snapshot row/)

  const merchantWindow = startWindowClient(async () => jsonResponse({
    ...contradictorySnapshot,
    merchant_total: 0,
    listings: [],
    aisles: aisleVector(),
  }))
  await settle()
  assertPanelsMatch(merchantWindow.document, /failed|unavailable|could not/i)

  const ready = {
    ...contradictorySnapshot,
    merchant_total: 1,
    listings: [listingFixture(10)],
    aisles: aisleVector({ tools: 1 }),
  }
  const focusedWindow = startWindowClient(async input => {
    const url = new URL(String(input), 'https://window.example')
    return jsonResponse(url.pathname === '/api/window' ? ready : {
      aisles: aisleVector({ tools: 0 }),
      listings: [{
        id: 8, merchant: 'safe-store', title: 'Impossible focused row', description: '',
        price_usdc: 0, sales: 0, votes: 0, tags: [], aisle: 'tools',
      }],
    })
  })
  await settle()
  const tools = allElements(focusedWindow.document).find(element =>
    element.tagName === 'BUTTON' && element.textContent === 'tools 1')
  assert.ok(tools)
  await tools.click()
  await settle()
  const focusedListings = focusedWindow.document.getElementById('listing-list')!
  assert.match(focusedListings.textContent, /failed|could not/i)
  assert.doesNotMatch(focusedListings.textContent, /Impossible focused row/)
})

test('a background snapshot failure stays visible after a concurrent focused aisle settles', async () => {
  const focused = deferred<ReturnType<typeof jsonResponse>>()
  let snapshotReads = 0
  const ready = {
    events: [], events_has_more: false,
    merchants: [], merchant_total: 0, listings: [listingFixture(10)],
    aisles: aisleVector({ tools: 1 }), refreshed_at: '2026-08-10T10:00:00Z',
  }
  const { document, timers } = startWindowClient(async input => {
    const url = new URL(String(input), 'https://window.example')
    if (url.pathname === '/api/window') {
      snapshotReads += 1
      return snapshotReads === 1 ? jsonResponse(ready) : jsonResponse({ error: 'background failed' }, 503)
    }
    return focused.promise
  })
  await settle()
  const tools = allElements(document).find(element =>
    element.tagName === 'BUTTON' && element.textContent === 'tools 1')
  assert.ok(tools)
  void tools.click()
  await settle()

  const refresh = [...timers.values()].find(timer => timer.delay === 60_000)
  assert.ok(refresh)
  refresh.callback()
  await settle()
  const status = document.getElementById('window-status')!
  assert.match(status.textContent, /latest market read failed|background.*failed/i)
  assert.match(status.textContent, /try again/i)

  focused.resolve(jsonResponse({
    aisles: aisleVector({ tools: 1 }),
    listings: [{
      id: 8, merchant: 'safe-store', title: 'Focused row', description: '',
      price_usdc: 0, sales: 0, votes: 0, tags: [], aisle: 'tools',
    }],
  }))
  await settle()
  assert.match(document.getElementById('listing-list')!.textContent, /Focused row/)
  assert.match(status.textContent, /latest market read failed|background.*failed/i)
  assert.match(status.textContent, /try again/i)
})

test('every panel stays loading, names a failed snapshot with retry, then renders completed empty plainly', async () => {
  const first = deferred<ReturnType<typeof jsonResponse>>()
  const second = deferred<ReturnType<typeof jsonResponse>>()
  let attempts = 0
  const { document } = startWindowClient(async () => {
    attempts += 1
    return attempts === 1 ? first.promise : second.promise
  })
  await settle()

  await enterFilter(document, 'still-loading')
  assertPanelsMatch(document, /reading|loading|counting|turning on/i)
  assert.equal(document.getElementById('clear-filter')?.hidden, true)
  assert.doesNotMatch(
    ['activity-list', 'listing-list', 'merchant-list']
      .map(id => document.getElementById(id)?.textContent ?? '').join('\n'),
    /no |nothing |bare|quiet/i,
  )

  first.resolve(jsonResponse({ error: 'test snapshot failure' }, 503))
  await settle()
  assertPanelsMatch(document, /could not|failed|unavailable|out of view|fogged/i)
  assert.equal(document.getElementById('clear-filter')?.hidden, true)
  const retry = allElements(document).find(element =>
    element.tagName === 'BUTTON' && /try again|retry/i.test(element.textContent))
  assert.ok(retry, 'a failed read offers a manual retry')

  void retry.click()
  await enterFilter(document, '')
  await settle()
  assertPanelsMatch(document, /reading|loading|counting|turning on/i)

  second.resolve(jsonResponse({
    events: [],
    events_has_more: false,
    merchants: [],
    merchant_total: 0,
    listings: [],
    aisles: aisleVector(),
    refreshed_at: '2026-08-10T10:00:00Z',
  }))
  await settle()

  for (const id of ['activity-list', 'listing-list', 'merchant-list']) {
    const panel = document.getElementById(id)
    assert.ok(panel)
    assert.equal(
      descendants(panel).some(element => element.className.includes('empty-state--error')),
      false,
      `${id} completed empty is not a failure`,
    )
    assert.doesNotMatch(panel.textContent, /bounded|newest \d+|first \d+|try another/i)
  }
  assert.match(document.getElementById('activity-list')!.textContent, /no |nothing |quiet/i)
  assert.match(document.getElementById('listing-list')!.textContent, /nothing |no goods|bare/i)
  assert.match(document.getElementById('merchant-list')!.textContent, /no shopkeeper/i)
})

test('filter empties name only the bounds that actually hide more records', async () => {
  const { document } = startWindowClient(async () => jsonResponse({
    events: [
      { kind: 'listing', actor: 'safe-store', at: '2026-08-10T10:00:00Z', detail: { listing_id: 10 } },
    ],
    events_has_more: true,
    merchants: Array.from({ length: 500 }, (_, index) => merchantFixture(index + 1)),
    merchant_total: 501,
    listings: Array.from({ length: 50 }, (_, index) => listingFixture(index + 1)),
    aisles: aisleVector({ tools: 51 }),
    refreshed_at: '2026-08-10T10:00:00Z',
  }))
  await settle()
  await enterFilter(document, 'not-in-the-loaded-slice')

  assert.match(document.getElementById('activity-list')!.textContent, /bounded|newest 100/i)
  assert.match(document.getElementById('listing-list')!.textContent, /bounded|newest 50/i)
  assert.match(document.getElementById('merchant-list')!.textContent, /bounded|first 500/i)
  for (const id of ['activity-list', 'listing-list', 'merchant-list']) {
    const panel = document.getElementById(id)
    assert.ok(panel)
    assert.equal(
      descendants(panel).some(element =>
        element.tagName === 'BUTTON' && /try again|retry/i.test(element.textContent)),
      false,
      `${id} completed empty must not pretend clearing a filter retries a read`,
    )
  }
  assert.equal(document.getElementById('clear-filter')?.hidden, false)
})

test('a failed background refresh names failure and offers an immediate status retry', async () => {
  let attempts = 0
  const ready = {
    events: [], events_has_more: false, merchants: [], merchant_total: 0,
    listings: [], aisles: aisleVector(), refreshed_at: '2026-08-10T10:00:00Z',
  }
  const { document, timers } = startWindowClient(async () => {
    attempts += 1
    return attempts === 2 ? jsonResponse({ error: 'refresh failed' }, 503) : jsonResponse(ready)
  })
  await settle()
  const refresh = [...timers.values()].find(timer => timer.delay === 60_000)
  assert.ok(refresh)
  refresh.callback()
  await settle()

  const status = document.getElementById('window-status')
  assert.ok(status)
  assert.match(status.textContent, /failed|could not|unavailable/i)
  const retry = descendants(status).find(element =>
    element.tagName === 'BUTTON' && /try again|retry/i.test(element.textContent))
  assert.ok(retry)
  await retry.click()
  await settle()
  assert.equal(attempts, 3)
  assert.match(status.textContent, /lights on|watching live/i)
})
