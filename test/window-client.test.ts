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
test('the shop window fetches only public data and renders hostile listing detail as text', async () => {
  const document = new FakeDocument()
  const calls: FetchCall[] = []
  let currentUrl = new URL('https://window.example/window')
  let timerId = 0
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const hostileTitle = '<script>globalThis.pwned = true</script>'
  const hostileDescription = '<img src=x onerror="globalThis.pwned=true">'
  const hostilePreview = 'javascript:globalThis.pwned=true'
  const hostileTag = '\u202E<svg onload="globalThis.pwned=true">'
  const hostileComment = '<script>globalThis.pwned=true</script><img src=x onerror=globalThis.pwned=true>'
  const payloads: Record<string, unknown> = {
    '/api/window': {
      events: [
        { kind: 'listing', actor: 'safe-store', at: '2026-08-10T10:00:00Z', detail: { listing_id: 10 } },
        { kind: 'world_sale', actor: 'safe-store', at: '2026-08-10T10:00:02Z', detail: { listing_id: 12, amount_usdc: 2 } },
        { kind: 'world_canceled', actor: 'safe-store', at: '2026-08-10T10:00:03Z', detail: { listing_id: 13 } },
        { kind: 'flag', actor: 'anonymous', at: '2026-08-10T10:00:01Z', detail: { target_id: 10, target_type: 'listing' } },
        { kind: 'listing', actor: '<img>', at: '2026-08-10T10:00:00Z', detail: { listing_id: 'javascript:1' } },
      ],
      merchants: [
        { handle: 'safe-store', line: 'Patient tools', model: 'test-model', listings: 2, store_url: 'https://evil.example/pwn' },
        { handle: '<script>', line: 'INVALID_MERCHANT_MARKER', listings: 99 },
      ],
      aisles: [{ name: 'tools', count: 2 }],
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
        {
          id: 'javascript:globalThis.pwned=true',
          merchant: '<img>',
          title: 'INVALID_LISTING_MARKER',
          aisle: 'tools',
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
        handle: 'safe-store', line: 'Patient tools', model: 'test-model',
        joined_at: '2026-08-01T10:00:00Z',
      },
      listings: [
        { id: 10, title: 'A safe shelf label', price_usdc: 0 },
        { id: 9, title: 'An older useful thing', price_usdc: 1 },
      ],
    },
    '/api/shelves?aisle=tools': {
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
  assert.match(document.getElementById('activity-list')!.textContent, /sold city ownership for item #12/i)
  assert.match(document.getElementById('activity-list')!.textContent, /closed world item #13/i)
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

  const refreshTimer = [...timers.values()].find(timer => timer.delay === 60_000)
  assert.ok(refreshTimer, 'the market uses one-minute completion-scheduled refreshes')
  refreshTimer.callback()
  await settle()
  assert.match(document.getElementById('listing-list')!.textContent, /An aisle-only item/)
  assert.equal(calls.filter(call => call.url.pathname === '/api/shelves').length, 2)

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
