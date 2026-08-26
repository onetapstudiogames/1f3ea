import { EDITABLE_LISTING_FIELDS } from './market.ts'
export const WINDOW_JS = String.raw`(() => {
  'use strict'

  const BASE_REFRESH_MS = 60_000
  const MAX_REFRESH_MS = 300_000
  const REQUEST_TIMEOUT_MS = 10_000
  const MAX_ERROR_RESPONSE_BYTES = 4_096
  const MAX_ERROR_CAUSE_BYTES = 500
  const MAX_FILTER_CHARS = 100
  const EVENT_PAGE_SIZE = 100
  const LISTING_PAGE_SIZE = 50
  const MERCHANT_PAGE_SIZE = 500
  const COMMENT_PAGE_SIZE = 200
  const INCONSISTENT_PUBLIC_DATA = 'the market returned incomplete or inconsistent public data'
  const UNREADABLE_PUBLIC_JSON = 'the market returned unreadable JSON'
  const UNREADABLE_HTTP_FAILURE = 'the market returned an unreadable HTTP failure response'
  const PUBLIC_MARKET_UNREACHABLE = 'the public market could not be reached'
  const PUBLIC_MARKET_TIMEOUT = 'the public market request took too long'
  const HANDLE_RE = /^[a-z0-9][a-z0-9-]{2,31}$/
  const SAFE_AISLES = new Set(['skills', 'prompts', 'tools', 'data', 'knowledge', 'services', 'wanted', 'world', 'other'])
  const SAFE_EVENT_KINDS = new Set(['register', 'listing', 'maintainer_seed', 'sale', 'world_sale', 'world_canceled', 'listing_edit', 'withdrawal', 'moderation'])
  const SAFE_LISTING_STATES = new Set(['live', 'withdrawn', 'removed', 'sold', 'canceled', 'stale'])
  const SAFE_CHANGED_FIELDS = new Set(${JSON.stringify(EDITABLE_LISTING_FIELDS)})
  const state = {
    events: [], eventsHaveMore: false, eventsTotal: 0, eventsMoreUrl: null,
    merchants: [], merchantTotal: 0, merchantsMoreUrl: null, showAllMerchants: false,
    listings: [], aisleListings: new Map(), snapshotCounts: new Map(), aisleCounts: new Map(),
    listingsTotal: 0, listingsMoreUrl: null, aislePages: new Map(),
    aisle: 'all', aislePhase: 'ready', aisleFailureCause: null, filter: '',
    refreshing: false, failures: 0, hasSnapshot: false, snapshotFailed: false, snapshotFailureCause: null,
    pollTimer: 0, detailController: null, detailViewKey: null, aisleController: null,
  }
  const nodes = {
    status: document.getElementById('window-status'), updated: document.getElementById('updated-at'),
    counts: document.getElementById('market-counts'), filter: document.getElementById('filter-input'),
    clearFilter: document.getElementById('clear-filter'), filterNote: document.getElementById('filter-note'),
    activity: document.getElementById('activity-list'), aisles: document.getElementById('aisle-list'),
    listings: document.getElementById('listing-list'), merchants: document.getElementById('merchant-list'),
    dialog: document.getElementById('listing-dialog'), dialogClose: document.getElementById('dialog-close'),
    detail: document.getElementById('listing-detail'), dialogTitle: document.getElementById('dialog-title'),
  }

  function element(tag, className, value) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (value !== undefined && value !== null) node.textContent = String(value)
    return node
  }
  function button(className, label, onClick) {
    const node = element('button', className, label)
    node.type = 'button'
    node.addEventListener('click', onClick)
    return node
  }
  function excerptCopy(className, value, fallback) {
    const node = element('span', className)
    const copy = safeText(value, '')
    if (!copy) {
      node.textContent = fallback
      return node
    }
    node.append(element('span', 'excerpt-marker', 'EXCERPT'), element('span', '', ' · ' + copy))
    return node
  }
  function safeText(value, fallback) { return typeof value === 'string' ? value : fallback }
  function safeHandle(value) { const handle = typeof value === 'string' ? value.toLowerCase() : ''; return HANDLE_RE.test(handle) ? handle : null }
  function safeId(value) { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : null }
  function safeNumber(value) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : 0 }
  function safeDate(value) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
    const date = new Date(typeof value === 'string' || typeof value === 'number' ? value : NaN)
    return Number.isNaN(date.getTime()) ? null : date
  }
  function formatDate(value) {
    const date = safeDate(value); if (!date) return 'time unknown'
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
  }
  function timeNode(value) {
    const date = safeDate(value)
    const node = element('time', 'movement__time', date ? formatDate(date) : 'time unknown')
    if (date) { node.dateTime = date.toISOString(); node.setAttribute('aria-label', date.toLocaleString()) }
    return node
  }
  function priceLabel(value) { const amount = safeNumber(value); return amount === 0 ? 'FREE' : amount.toLocaleString(undefined, { maximumFractionDigits: 6 }) + ' USDC' }
  function listingPath(id) { const safe = safeId(id); return safe ? '/api/listing/' + String(safe) : null }
  function publicFailure(cause) {
    const error = new Error('public market read failed')
    error.publicCause = cause
    return error
  }
  function contractFailure() { return publicFailure(INCONSISTENT_PUBLIC_DATA) }
  async function readPublicError(response) {
    const contentType = response.headers.get('content-type') || ''
    if (!/(?:^|\s|;)application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) return null
    const declaredLength = response.headers.get('content-length')
    if (declaredLength !== null && Number(declaredLength) > MAX_ERROR_RESPONSE_BYTES) {
      try { await response.body?.cancel() } catch {}
      return null
    }
    if (!response.body) return null
    const reader = response.body.getReader()
    const chunks = []
    let received = 0
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        if (!(result.value instanceof Uint8Array)) { await reader.cancel(); return null }
        received += result.value.byteLength
        if (received > MAX_ERROR_RESPONSE_BYTES) { await reader.cancel(); return null }
        chunks.push(result.value)
      }
    } catch {
      try { await reader.cancel() } catch {}
      return null
    }
    const bytes = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    let decoded
    try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return null }
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || typeof decoded.error !== 'string') return null
    const cause = decoded.error.trim()
    if (!cause || new TextEncoder().encode(cause).byteLength > MAX_ERROR_CAUSE_BYTES || /[\u0000-\u001f\u007f]/u.test(cause)) return null
    return cause
  }
  async function getJson(path, signal) {
    const url = new URL(path, window.location.origin)
    if (url.origin !== window.location.origin) throw publicFailure('the window refused a cross-origin public-data request')
    let response
    try {
      response = await fetch(url, {
        credentials: 'omit', cache: 'default', headers: { Accept: 'application/json' }, signal,
      })
    } catch {
      throw publicFailure(signal && signal.aborted ? PUBLIC_MARKET_TIMEOUT : PUBLIC_MARKET_UNREACHABLE)
    }
    if (!response.ok) {
      const publicCause = await readPublicError(response) || UNREADABLE_HTTP_FAILURE
      const error = new Error('request failed with ' + String(response.status))
      error.status = response.status
      error.publicCause = publicCause
      throw error
    }
    try { return await response.json() } catch { throw publicFailure(UNREADABLE_PUBLIC_JSON) }
  }
  function publicFailureCause(value) {
    return value && typeof value === 'object' && typeof value.publicCause === 'string'
      ? value.publicCause : typeof value === 'string' ? value : null
  }
  function failureDetail(fallback, causeOrError) {
    const cause = publicFailureCause(causeOrError)
    return cause ? fallback + ' Cause: ' + cause : fallback
  }
  function setStatus(message, mode) {
    if (!nodes.status) return false
    const nextMode = mode || 'quiet'
    if (nodes.status.dataset.message === message && nodes.status.dataset.mode === nextMode &&
      nodes.status.dataset.retry !== 'true') return false
    nodes.status.textContent = message
    nodes.status.dataset.message = message
    nodes.status.dataset.mode = nextMode
    nodes.status.dataset.retry = 'false'
    return true
  }
  function setStatusFailure(message, retry) {
    if (!nodes.status) return
    if (nodes.status.dataset.message === message && nodes.status.dataset.mode === 'error' &&
      nodes.status.dataset.retry === 'true') return
    setStatus(message, 'error')
    nodes.status.append(element('span', '', ' · '), button('text-button', 'Try again', retry))
    nodes.status.dataset.retry = 'true'
  }
  function setSnapshotFailureStatus() {
    setStatusFailure(failureDetail(
      'The latest market read failed · showing the last completed snapshot.',
      state.snapshotFailureCause,
    ), refreshMarket)
  }
  function setSettledStatus() {
    if (state.snapshotFailed) setSnapshotFailureStatus()
    else if (state.refreshing) setStatus('Checking the street…', 'working')
    else setStatus('Lights on · watching live', 'live')
  }
  function setViewParam(kind, value) {
    const url = new URL(window.location.href)
    url.searchParams.delete('item'); url.searchParams.delete('store')
    if (kind && value) url.searchParams.set(kind, String(value))
    window.history.replaceState(null, '', url)
  }
  function showDialog(title) {
    if (!nodes.dialog || !nodes.detail || !nodes.dialogTitle) return false
    nodes.dialogTitle.textContent = title
    if (!nodes.dialog.open) nodes.dialog.showModal()
    return true
  }
  function closeDialog() {
    if (state.detailController) state.detailController.abort()
    state.detailController = null
    state.detailViewKey = null
    if (nodes.dialog && nodes.dialog.open) nodes.dialog.close()
    setViewParam(null, null)
  }
  function renderLoading(target, message) {
    if (!target) return
    const wrapper = element(['UL', 'OL'].includes(target.tagName) ? 'li' : 'div', 'empty-state')
    wrapper.append(element('span', 'loading-light', '●'), element('p', '', message))
    target.replaceChildren(wrapper)
  }
  function renderMessage(target, title, detail, isError, retry) {
    if (!target) return
    const className = 'empty-state' + (isError ? ' empty-state--error' : '')
    const wrapper = element(['UL', 'OL'].includes(target.tagName) ? 'li' : 'div', className)
    wrapper.append(element('strong', '', title), element('p', '', detail))
    if (retry) wrapper.append(button('text-button', 'Try again', retry))
    target.replaceChildren(wrapper)
  }
  function renderEmpty(target, title, detail) { renderMessage(target, title, detail, false, null) }
  function renderError(target, title, detail, retry) { renderMessage(target, title, detail, true, retry) }
  function collectionNotice(copy, links, action) {
    const row = element('li', 'collection-more')
    row.append(element('p', '', copy))
    for (const link of links || []) {
      const anchor = element('a', '', link.label)
      anchor.href = link.href
      row.append(anchor)
    }
    if (action) row.append(button('text-button', action.label, action.run))
    return row
  }
  function exactContinuation(value, pathname) {
    if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/u.test(value)) return null
    const url = new URL(value, window.location.origin)
    if (url.origin !== window.location.origin || url.pathname !== pathname || url.hash) return null
    return url.pathname + url.search
  }
  function exactIdContinuation(value, pathname, parameter, expectedId, fixedParameters) {
    const relative = exactContinuation(value, pathname)
    if (!relative) return null
    const url = new URL(relative, window.location.origin)
    const entries = [...url.searchParams.entries()]
    const expected = new Map([[parameter, String(expectedId)], ...Object.entries(fixedParameters || {})])
    const seen = new Set()
    if (entries.length !== expected.size) return null
    for (const [name, value] of entries) {
      if (!expected.has(name) || expected.get(name) !== value || seen.has(name)) return null
      seen.add(name)
    }
    if (seen.size !== expected.size) return null
    return relative
  }
  function eventView(raw) {
    if (!raw || typeof raw !== 'object') return null
    const kind = safeText(raw.kind, '')
    if (!SAFE_EVENT_KINDS.has(kind)) return null
    const actor = safeHandle(raw.actor) || 'someone'
    const detail = raw.detail && typeof raw.detail === 'object' ? raw.detail : {}
    const listingId = safeId(detail.listing_id)
    let sentence = ''
    const itemId = listingId
    if (kind === 'register') sentence = 'opened a store'
    if ((kind === 'listing' || kind === 'maintainer_seed') && listingId)
      sentence = 'stocked item #' + String(listingId)
    if (kind === 'sale' && listingId) {
      const amount = safeNumber(detail.amount_usdc)
      sentence = amount > 0
        ? 'bought item #' + String(listingId) + ' for ' + priceLabel(amount)
        : 'picked up free item #' + String(listingId)
    }
    if (kind === 'world_sale' && listingId) {
      const amount = safeNumber(detail.amount_usdc)
      sentence = 'sold city ownership for item #' + String(listingId) +
        (amount > 0 ? ' for ' + priceLabel(amount) : '')
    }
    if (kind === 'world_canceled' && listingId) sentence = 'closed world item #' + String(listingId)
    if (kind === 'listing_edit' && listingId) {
      const fields = Array.isArray(detail.changed_fields)
        ? [...SAFE_CHANGED_FIELDS].filter(field => detail.changed_fields.includes(field)) : []
      sentence = fields.length
        ? 'updated ' + fields.join(', ') + ' on item #' + String(listingId)
        : 'updated item #' + String(listingId)
    }
    if (kind === 'withdrawal' && listingId) sentence = 'took item #' + String(listingId) + ' off the shelf'
    if (kind === 'moderation' && listingId) {
      const action = safeText(detail.action, '')
      if (action === 'remove') sentence = 'the shopkeeper removed item #' + String(listingId)
      if (action === 'pin') sentence = 'the shopkeeper featured item #' + String(listingId)
      if (action === 'unpin') sentence = 'the shopkeeper unfeatured item #' + String(listingId)
    }
    if (!sentence) return null
    return { actor, sentence, itemId, at: raw.at }
  }
  function collapseMovements(items) {
    return items.reduce((groups, item) => {
      const previous = groups[groups.length - 1]
      const same = previous && previous.actor === item.actor && previous.sentence === item.sentence
        && previous.itemId === item.itemId
      if (!same) return [...groups, { ...item, count: 1 }]
      return [...groups.slice(0, -1), { ...previous, count: previous.count + 1 }]
    }, [])
  }
  function renderActivity() {
    if (!nodes.activity) return
    const query = state.filter.toLowerCase()
    const visible = state.events.map(eventView).filter(Boolean)
      .filter(item => !query || item.actor.includes(query) || item.sentence.toLowerCase().includes(query))
    const loadedMovements = collapseMovements(visible)
    const movements = loadedMovements.slice(0, query ? 30 : 8)
    if (!movements.length) {
      const bounded = state.eventsHaveMore
      const title = bounded ? 'No match in this bounded activity view.' : 'No recent movement was found.'
      const message = query
        ? (bounded ? 'No movement in the newest 100 events matches “' : 'No recent movement matches “') + state.filter + '”.'
        : bounded ? 'No readable movement was found in the newest 100 events.' : 'The aisles are quiet.'
      renderEmpty(nodes.activity, title, message)
      if (state.eventsHaveMore) nodes.activity.append(collectionNotice(
        'This loaded page has no match; ' + String(state.eventsTotal) + ' ledger events are in scope.',
        [
          { href: '/api/events', label: 'Open the complete ledger' },
          { href: state.eventsMoreUrl, label: 'Continue after this loaded page' },
        ],
        null,
      ))
      return
    }
    const fragment = document.createDocumentFragment()
    for (const movement of movements) {
      const row = element('li', 'movement')
      const copy = element('div', 'movement__copy')
      const actor = button('merchant-link', movement.actor, () => selectMerchant(movement.actor))
      const sentence = element('span', '', ' ' + movement.sentence)
      copy.append(actor, sentence)
      if (movement.count > 1) copy.append(element('span', 'movement__count', ' ×' + String(movement.count)))
      if (movement.itemId) {
        const inspect = button('movement__inspect', 'View item #' + String(movement.itemId), () => openListing(movement.itemId))
        row.append(copy, timeNode(movement.at), inspect)
      } else {
        row.append(copy, timeNode(movement.at))
      }
      fragment.append(row)
    }
    if (loadedMovements.length > movements.length || state.eventsHaveMore) {
      const copy = query
        ? 'Showing ' + String(movements.length) + ' of ' + String(loadedMovements.length) +
          ' matching loaded movements from ' + String(state.eventsTotal) + ' ledger events.'
        : 'Showing ' + String(movements.length) + ' of ' + String(loadedMovements.length) +
          ' loaded movements from ' + String(state.eventsTotal) + ' ledger events.'
      const links = [{ href: '/api/events', label: 'Open the complete ledger' }]
      if (state.eventsMoreUrl)
        links.push({ href: state.eventsMoreUrl, label: 'Continue after this loaded page' })
      fragment.append(collectionNotice(copy, links, null))
    }
    nodes.activity.replaceChildren(fragment)
  }
  function aisleCount(name) {
    return safeNumber(state.aisleCounts.get(name))
  }
  function totalGoods() {
    return [...state.aisleCounts.values()].reduce((sum, count) => sum + safeNumber(count), 0)
  }
  function readAisleCounts(payload) {
    const counts = new Map()
    const aisles = Array.isArray(payload && payload.aisles) ? payload.aisles : []
    if (aisles.length !== SAFE_AISLES.size) throw contractFailure()
    for (const row of aisles) {
      const count = row && row.count
      if (!row || !SAFE_AISLES.has(row.name) || counts.has(row.name)
        || !Number.isSafeInteger(count) || count < 0) throw contractFailure()
      counts.set(row.name, count)
    }
    return counts
  }
  function readListings(value, expectedAisle) {
    if (!Array.isArray(value) || value.length > 50) throw contractFailure()
    const listings = []
    for (const listing of value) {
      const valid = listing && typeof listing === 'object' && safeId(listing.id)
        && SAFE_AISLES.has(listing.aisle)
      if (!valid) throw contractFailure()
      if (expectedAisle && listing.aisle !== expectedAisle)
        throw contractFailure()
      listings.push(listing)
    }
    return listings
  }
  function requireCountsCoverListings(counts, listings) {
    const visibleByAisle = new Map()
    for (const listing of listings)
      visibleByAisle.set(listing.aisle, (visibleByAisle.get(listing.aisle) || 0) + 1)
    for (const [aisle, visible] of visibleByAisle)
      if (safeNumber(counts.get(aisle)) < visible) throw contractFailure()
  }
  function requireBoundedRows(total, rows, bound) {
    if (!Number.isSafeInteger(total) || total < 0 || rows.length !== Math.min(total, bound)) throw contractFailure()
  }
  function readShelfPage(payload, name, listings, counts) {
    const total = payload.total
    const returned = payload.returned
    const pageSize = payload.page_size
    const hasMore = payload.has_more
    const cursor = payload.next_cursor
    if (!Number.isSafeInteger(total) || total < 0 || total !== counts.get(name) ||
      returned !== listings.length || pageSize !== LISTING_PAGE_SIZE ||
      hasMore !== (total > listings.length)) throw contractFailure()
    if (hasMore) {
      if (typeof cursor !== 'string' || !cursor || cursor.length > 2_000 ||
        /[\u0000-\u001f\u007f]/u.test(cursor)) throw contractFailure()
    } else if (cursor !== null) throw contractFailure()
    const url = new URL('/api/shelves', window.location.origin)
    url.searchParams.set('aisle', name)
    if (hasMore) url.searchParams.set('cursor', cursor)
    return { total, moreUrl: hasMore ? url.pathname + url.search : null }
  }
  function renderAisles() {
    if (!nodes.aisles) return
    const fragment = document.createDocumentFragment()
    const options = ['all', ...SAFE_AISLES]
    for (const name of options) {
      const count = name === 'all' ? totalGoods() : aisleCount(name)
      const label = name === 'all' ? 'All goods' : name
      const control = button('aisle-tab', label + ' ' + String(count), () => void selectAisle(name))
      control.setAttribute('aria-pressed', String(state.aisle === name))
      fragment.append(control)
    }
    nodes.aisles.replaceChildren(fragment)
  }
  function listingMatches(listing, query) {
    if (!query) return true
    const fields = [listing.title, listing.description, listing.preview, listing.merchant, listing.aisle]
    if (Array.isArray(listing.tags)) fields.push(...listing.tags)
    return fields.some(value => safeText(value, '').toLowerCase().includes(query))
  }
  function renderListings() {
    if (!nodes.listings) return
    if (state.aisle !== 'all' && state.aislePhase !== 'ready') {
      if (state.aislePhase === 'loading')
        renderLoading(nodes.listings, 'Reading the ' + state.aisle + ' aisle…')
      else renderError(
        nodes.listings, 'This aisle read failed.',
        failureDetail('The focused shelf could not be read.', state.aisleFailureCause),
        () => selectAisle(state.aisle),
      )
      return
    }
    const query = state.filter.toLowerCase()
    const source = state.aisle === 'all'
      ? state.listings
      : state.aisleListings.get(state.aisle) || []
    const page = state.aisle === 'all'
      ? { total: state.listingsTotal, moreUrl: state.listingsMoreUrl }
      : state.aislePages.get(state.aisle) || { total: source.length, moreUrl: null }
    const listings = source.filter(listing => {
      const aisle = SAFE_AISLES.has(listing.aisle) ? listing.aisle : 'other'
      return (state.aisle === 'all' || aisle === state.aisle) && listingMatches(listing, query)
    })
    if (!listings.length) {
      const aisleName = state.aisle === 'all' ? 'the market' : state.aisle
      const bounded = page.total > source.length
      const title = bounded ? 'No match in this bounded shelf view.' : 'No goods were found.'
      const detail = query
        ? (bounded ? 'No goods in the newest 50 match “' : 'No goods match “') + state.filter + '” in ' + aisleName + '.'
        : bounded ? 'No readable goods were found in the newest 50.' : 'No goods were found in ' + aisleName + '.'
      renderEmpty(nodes.listings, title, detail)
      if (bounded && page.moreUrl) nodes.listings.append(collectionNotice(
        'Showing 0 matches from ' + String(source.length) + ' loaded goods; ' +
          String(page.total) + ' goods are in this shelf read.',
        [{ href: page.moreUrl, label: 'Open the remaining shelf read' }],
        null,
      ))
      return
    }
    const fragment = document.createDocumentFragment()
    for (const listing of listings) {
      const id = safeId(listing.id)
      if (!id) continue
      const merchant = safeHandle(listing.merchant) || 'unknown-store'
      const aisle = SAFE_AISLES.has(listing.aisle) ? listing.aisle : 'other'
      const world = listing.delivery_kind === 'city_ownership'
      const row = element('li', 'listing-row')
      const main = button('listing-row__main', '', () => openListing(id))
      const accessibleTitle = safeText(listing.title, 'Untitled item')
      main.setAttribute('aria-label', accessibleTitle + ', item #' + String(id))
      const stamp = element('span', 'listing-row__stamp', 'ITEM #' + String(id) + ' · ' + aisle.toUpperCase())
      const title = element('strong', 'listing-row__title', safeText(listing.title, 'Untitled item'))
      const description = excerptCopy('listing-row__description', listing.description, 'No description.')
      main.append(stamp, title, description)
      const facts = element('div', 'listing-row__facts')
      const merchantButton = button('merchant-link', merchant, event => {
        event.stopPropagation()
        openStore(merchant)
      })
      facts.append(
        merchantButton,
        ...(world ? [element('span', '', 'CITY OWNERSHIP')] : []),
        element('span', '', String(Math.trunc(safeNumber(listing.sales))) + ' pickups'),
        element('span', '', String(Math.trunc(safeNumber(listing.votes))) + ' votes'),
      )
      const price = element('span', 'price-ticket', priceLabel(listing.price_usdc))
      row.append(main, facts, price)
      fragment.append(row)
    }
    if (page.total > source.length && page.moreUrl) {
      const copy = query
        ? 'Showing ' + String(listings.length) + ' matches from ' + String(source.length) +
          ' loaded goods; ' + String(page.total) + ' goods are in this shelf read.'
        : 'Showing ' + String(source.length) + ' of ' + String(page.total) + ' goods.'
      fragment.append(collectionNotice(
        copy,
        [{ href: page.moreUrl, label: 'Open the remaining shelf read' }],
        null,
      ))
    }
    nodes.listings.replaceChildren(fragment)
  }
  async function selectAisle(name, announce = true) {
    if (name !== 'all' && !SAFE_AISLES.has(name)) return
    if (state.aisleController) state.aisleController.abort()
    state.aisleController = null
    state.aisle = name
    if (name === 'all') {
      state.aisleCounts = state.snapshotCounts
      state.aislePhase = 'ready'
      state.aisleFailureCause = null
      renderAll()
      setSettledStatus()
      return
    }
    state.aislePhase = 'loading'
    state.aisleFailureCause = null
    if (announce) setStatus('Reading the ' + name + ' aisle…', 'working')
    renderAll()
    const controller = new AbortController()
    state.aisleController = controller
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const payload = await getJson('/api/shelves?aisle=' + encodeURIComponent(name), controller.signal)
      if (state.aisleController !== controller) return
      if (!payload || typeof payload !== 'object') throw contractFailure()
      const counts = readAisleCounts(payload)
      const listings = readListings(payload.listings, name)
      requireCountsCoverListings(counts, listings)
      requireBoundedRows(counts.get(name), listings, 50)
      const page = readShelfPage(payload, name, listings, counts)
      state.aisleListings = new Map(state.aisleListings).set(name, listings)
      state.aislePages = new Map(state.aislePages).set(name, page)
      state.aisleCounts = counts
      state.aislePhase = 'ready'
      state.aisleFailureCause = null
      if (state.aisle === name) {
        renderAll()
        if (announce) setSettledStatus()
      }
    } catch (error) {
      if (state.aisleController === controller && state.aisle === name) {
        state.aislePhase = 'failed'
        state.aisleFailureCause = publicFailureCause(error)
        renderListings()
        if (state.snapshotFailed) setSnapshotFailureStatus()
        else setStatusFailure(failureDetail(
          'The ' + name + ' aisle read failed.', state.aisleFailureCause,
        ), () => selectAisle(name))
      }
    } finally {
      window.clearTimeout(timeout)
      if (state.aisleController === controller) state.aisleController = null
    }
  }
  function renderMerchants() {
    if (!nodes.merchants) return
    const query = state.filter.toLowerCase()
    const matches = state.merchants
      .filter(merchant => safeHandle(merchant.handle))
      .filter(merchant => {
        if (!query) return true
        return [merchant.handle, merchant.line, merchant.model]
          .some(value => safeText(value, '').toLowerCase().includes(query))
      })
    const merchants = state.showAllMerchants ? matches : matches.slice(0, 100)
    const censusLinks = [{ href: '/api/merchants', label: 'Open the complete public census' }]
    if (state.merchantsMoreUrl)
      censusLinks.push({ href: state.merchantsMoreUrl, label: 'Continue after this loaded page' })
    if (!merchants.length) {
      const bounded = state.merchantTotal > state.merchants.length
      const title = bounded ? 'No match in this bounded shopkeeper view.' : 'No shopkeeper was found.'
      const detail = query
        ? (bounded ? 'No shopkeeper in the first 500 matches “' : 'No shopkeeper matches “') + state.filter + '”.'
        : 'No shopkeeper was found in the public census.'
      renderEmpty(nodes.merchants, title, detail)
      if (query || bounded) nodes.merchants.append(collectionNotice(
        'This view searched ' + String(state.merchants.length) + ' loaded shopkeepers; ' +
          String(state.merchantTotal) + ' are in the public census.',
        censusLinks,
        null,
      ))
      return
    }
    const fragment = document.createDocumentFragment()
    for (const merchant of merchants) {
      const handle = safeHandle(merchant.handle)
      if (!handle) continue
      const control = button('merchant-row', '', () => openStore(handle))
      control.setAttribute('aria-label', 'Look into ' + handle + ' store')
      const name = element('strong', 'merchant-row__name', handle)
      const line = excerptCopy('merchant-row__line', merchant.line, 'The sign above this door is blank.')
      const stock = element('span', 'merchant-row__stock', String(Math.trunc(safeNumber(merchant.listings))) + ' stocked')
      control.append(name, line, stock)
      fragment.append(control)
    }
    const hiddenLoaded = Math.max(0, matches.length - merchants.length)
    const unloaded = Math.max(0, state.merchantTotal - state.merchants.length)
    if (query || hiddenLoaded > 0 || unloaded > 0) {
      const copy = query
        ? 'Showing ' + String(merchants.length) + ' of ' + String(matches.length) +
          ' matching loaded shopkeepers; ' + String(state.merchantTotal) + ' total in the public census.'
        : 'Showing ' + String(merchants.length) + ' of ' + String(state.merchants.length) +
          ' loaded shopkeepers; ' + String(state.merchantTotal) + ' total in the public census.'
      fragment.append(collectionNotice(
        copy,
        censusLinks,
        hiddenLoaded > 0 ? {
          label: 'Show ' + String(hiddenLoaded) + ' more loaded shopkeepers',
          run: () => { state.showAllMerchants = true; renderMerchants() },
        } : null,
      ))
    }
    nodes.merchants.replaceChildren(fragment)
  }
  function renderCounts() {
    if (!nodes.counts) return
    const goods = totalGoods()
    const merchants = state.merchantTotal
    nodes.counts.textContent = String(merchants) + ' shopkeepers · ' + String(goods) + ' goods · public and read only'
  }
  function renderFilterNote() {
    if (!nodes.filterNote || !nodes.clearFilter) return
    if (state.filter) {
      const message = 'Watching for “' + state.filter + '”'
      if (nodes.filterNote.textContent !== message) nodes.filterNote.textContent = message
      nodes.clearFilter.hidden = false
    } else {
      const message = 'Search one agent, item, tag, or aisle.'
      if (nodes.filterNote.textContent !== message) nodes.filterNote.textContent = message
      nodes.clearFilter.hidden = true
    }
  }
  function renderAll() {
    renderCounts()
    renderFilterNote()
    renderAisles()
    renderActivity()
    renderListings()
    renderMerchants()
  }
  function renderSnapshotState(mode) {
    const panels = [
      [nodes.counts, 'Counting market totals…', 'Market totals unavailable.'],
      [nodes.aisles, 'Reading aisle totals…', 'Aisles unavailable.'],
      [nodes.activity, 'Reading recent movement…', 'Recent movement unavailable.'],
      [nodes.listings, 'Reading newest shelf labels…', 'Shelves unavailable.'],
      [nodes.merchants, 'Reading the shopkeeper census…', 'Shopkeepers unavailable.'],
    ]
    for (const [target, loading, failure] of panels) {
      if (mode === 'loading') renderLoading(target, loading)
      else renderError(target, failure,
        failureDetail('The public market read failed.', state.snapshotFailureCause), refreshMarket)
    }
    if (nodes.filterNote) {
      const message = mode === 'loading'
        ? 'Reading the public market…'
        : failureDetail('The public market read failed. Try again.', state.snapshotFailureCause)
      if (nodes.filterNote.textContent !== message) nodes.filterNote.textContent = message
    }
    if (nodes.clearFilter) nodes.clearFilter.hidden = true
  }
  function renderCurrent() {
    if (state.hasSnapshot) renderAll()
    else renderSnapshotState(state.refreshing ? 'loading' : 'failed')
  }
  function clearFilter() {
    state.filter = ''
    if (nodes.filter) nodes.filter.value = ''
    renderCurrent()
    if (nodes.filter) nodes.filter.focus()
  }
  function selectMerchant(handle) {
    const safe = safeHandle(handle)
    if (!safe) return
    state.filter = safe
    if (nodes.filter) nodes.filter.value = safe
    renderCurrent()
    document.getElementById('window-main')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  function detailSection(title, body, className) {
    const section = element('section', 'detail-section' + (className ? ' ' + className : ''))
    section.append(element('h3', '', title), body)
    return section
  }
  function renderTagList(tags) {
    const list = element('div', 'tag-list')
    const safeTags = Array.isArray(tags) ? tags : []
    for (const tag of safeTags) list.append(element('span', 'tag', safeText(tag, '')))
    return list
  }
  function readListingDetail(payload, id, previous) {
    const listing = payload && payload.listing && typeof payload.listing === 'object'
      ? payload.listing : null
    const stateName = listing ? safeText(listing.state, '') : ''
    const tags = listing && listing.tags
    const page = payload && Array.isArray(payload.comments) ? payload.comments : null
    if (!listing || safeId(listing.id) !== id || !SAFE_LISTING_STATES.has(stateName) ||
      !Array.isArray(tags) || tags.length > 8 || !page || page.length > COMMENT_PAGE_SIZE)
      throw contractFailure()
    const pageIds = new Set()
    for (const comment of page) {
      const commentId = safeId(comment && comment.id)
      if (!comment || typeof comment !== 'object' || !commentId || pageIds.has(commentId))
        throw contractFailure()
      pageIds.add(commentId)
    }
    const commentsTotal = payload.comments_total
    if (!Number.isSafeInteger(commentsTotal) || commentsTotal < 0 ||
      payload.comments_returned !== page.length || payload.comments_page_size !== COMMENT_PAGE_SIZE)
      throw contractFailure()
    const existing = previous ? previous.comments : []
    const existingIds = new Set(existing.map(comment => safeId(comment.id)))
    if (page.some(comment => existingIds.has(safeId(comment.id)))) throw contractFailure()
    const comments = [...existing, ...page]
    const hasMore = payload.comments_has_more
    if (commentsTotal < comments.length || hasMore !== (commentsTotal > comments.length))
      throw contractFailure()
    let nextAfterId = null
    if (hasMore) {
      const lastId = safeId(page.at(-1) && page.at(-1).id)
      nextAfterId = safeId(payload.comments_next_after_id)
      if (!lastId || nextAfterId !== lastId) throw contractFailure()
    } else if (payload.comments_next_after_id !== null) throw contractFailure()
    return {
      id, listing, comments, commentsTotal, hasMore, nextAfterId,
      commentsLoading: false, commentsFailureCause: null,
    }
  }
  function commentDepth(comment, commentsById) {
    const seen = new Set()
    let parent = safeId(comment.parent_id)
    let depth = 0
    while (parent && commentsById.has(parent) && !seen.has(parent) && depth < 3) {
      seen.add(parent)
      depth += 1
      parent = safeId(commentsById.get(parent).parent_id)
    }
    return depth
  }
  function renderComments(comments) {
    const wrapper = element('div', 'comments')
    const rows = Array.isArray(comments) ? comments : []
    if (!rows.length) {
      wrapper.append(element('p', 'empty-copy', 'No comments yet. The shelf is still quiet.'))
      return wrapper
    }
    const commentsById = new Map()
    for (const comment of rows) {
      const id = safeId(comment && comment.id)
      if (id) commentsById.set(id, comment)
    }
    for (const comment of rows) {
      if (!comment || typeof comment !== 'object') continue
      const row = element('article', 'comment')
      row.dataset.depth = String(commentDepth(comment, commentsById))
      const head = element('div', 'comment__head')
      const handle = safeHandle(comment.handle) || 'unknown merchant'
      head.append(element('strong', '', handle), timeNode(comment.created_at))
      if (comment.verified_buyer === true) {
        head.append(element('span', 'verified-buyer', '✓ VERIFIED BUYER'))
      }
      row.append(head, element('p', 'comment__body', safeText(comment.body, '')))
      wrapper.append(row)
    }
    return wrapper
  }
  function renderListingDetail(detail, id) {
    if (!nodes.detail || !nodes.dialogTitle) return
    const listing = detail.listing
    const stateName = safeText(listing.state, '')
    const world = listing.delivery_kind === 'city_ownership'
    const merchant = safeHandle(listing.merchant) || 'unknown-store'
    const terminalTitles = {
      withdrawn: 'WITHDRAWN BY MERCHANT', removed: 'REMOVED BY THE SHOPKEEPER', sold: 'SOLD IN THE CITY',
      canceled: 'CITY OFFER CANCELED', stale: 'CITY RECORD STALE',
    }
    nodes.dialogTitle.textContent = stateName === 'live' ? 'ITEM #' + String(id) : terminalTitles[stateName]
    const article = element('article', 'item-detail')
    const eyebrow = element('p', 'detail-eyebrow', 'ITEM #' + String(id) + ' · ' + safeText(listing.aisle, 'other').toUpperCase())
    const title = element('h2', 'detail-title', safeText(listing.title, 'Untitled item'))
    const byline = element('div', 'detail-byline')
    byline.append(
      button('merchant-link', merchant, () => openStore(merchant)),
      element('span', 'price-ticket', stateName === 'live' ? priceLabel(listing.price_usdc) : 'OFF SHELF'),
    )
    article.append(eyebrow, title, byline)
    const facts = element('p', 'detail-facts')
    facts.textContent = String(Math.trunc(safeNumber(listing.sales))) + ' pickups · ' +
      String(Math.trunc(safeNumber(listing.votes))) + ' votes · stocked ' + formatDate(listing.created_at)
    article.append(facts)
    if (world && stateName === 'live') {
      article.append(detailSection(
        'DELIVERY',
        element('p', '', 'Ownership is delivered in the city. A buyer must already be a city resident; nothing is downloaded here.'),
        'detail-section--notice',
      ))
    }
    if (stateName !== 'live') {
      const terminalMessages = {
        withdrawn: 'This item was withdrawn by its merchant. Its public comments remain.',
        removed: 'This item was removed by the shopkeeper. The public record remains.',
        sold: 'This city ownership moved to its city buyer. The market receipt and public comments remain.',
        canceled: 'The city offer was canceled. This item is no longer for sale here.',
        stale: 'The city no longer confirms this offer as available. This item is off the shelf.',
      }
      article.append(detailSection(
        'OFF THE SHELF',
        element('p', '', terminalMessages[stateName]),
        'detail-section--notice',
      ))
    }
    article.append(detailSection('WHAT IT IS', element('p', 'preserve-copy', safeText(listing.description, 'No description.'))))
    if (stateName === 'live') {
      article.append(detailSection('PUBLIC PREVIEW', element('pre', 'preview-copy', safeText(listing.preview, 'No public preview.'))))
    }
    article.append(detailSection('TAGS', renderTagList(listing.tags)))
    const reviews = element('div', 'reviews-page')
    reviews.append(renderComments(detail.comments))
    reviews.append(element(
      'p', 'collection-summary',
      detail.hasMore
        ? 'Showing ' + String(detail.comments.length) + ' of ' + String(detail.commentsTotal) + ' reviews.'
        : 'Showing all ' + String(detail.commentsTotal) + ' reviews.',
    ))
    if (detail.commentsFailureCause) {
      const failure = element('div', 'comment-page-error')
      failure.append(
        element('p', '', failureDetail('Newer reviews could not be read.', detail.commentsFailureCause)),
        button('text-button', 'Try loading newer reviews again', () => void loadMoreComments(detail)),
      )
      reviews.append(failure)
    } else if (detail.hasMore) {
      const remaining = detail.commentsTotal - detail.comments.length
      const more = button(
        'text-button comment-more',
        detail.commentsLoading
          ? 'Loading newer reviews…'
          : 'Load newer reviews (' + String(remaining) + ' remaining)',
        () => void loadMoreComments(detail),
      )
      more.disabled = detail.commentsLoading
      reviews.append(more)
    }
    article.append(detailSection('REVIEWS FROM THE AISLE', reviews))
    nodes.detail.replaceChildren(article)
  }
  async function loadMoreComments(detail) {
    const id = detail && safeId(detail.id)
    const viewKey = id ? 'item:' + String(id) : null
    if (!id || state.detailViewKey !== viewKey || !detail.hasMore ||
      !safeId(detail.nextAfterId) || state.detailController) return
    const controller = new AbortController()
    state.detailController = controller
    detail.commentsLoading = true
    detail.commentsFailureCause = null
    renderListingDetail(detail, id)
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const path = listingPath(id) + '?comments_after_id=' + String(detail.nextAfterId)
      const payload = await getJson(path, controller.signal)
      if (state.detailController !== controller || state.detailViewKey !== viewKey) return
      renderListingDetail(readListingDetail(payload, id, detail), id)
    } catch (error) {
      if (state.detailController === controller && state.detailViewKey === viewKey) {
        detail.commentsLoading = false
        detail.commentsFailureCause = publicFailureCause(error)
        renderListingDetail(detail, id)
      }
    } finally {
      window.clearTimeout(timeout)
      if (state.detailController === controller) state.detailController = null
    }
  }
  async function openListing(value) {
    const id = safeId(value)
    const path = listingPath(id)
    if (!id || !path || !showDialog('Reading item #' + String(id))) return
    state.detailViewKey = 'item:' + String(id)
    setViewParam('item', id)
    renderLoading(nodes.detail, 'Reading the shelf label and public reviews…')
    nodes.detail.focus()
    if (state.detailController) state.detailController.abort()
    const controller = new AbortController()
    state.detailController = controller
    let timedOut = false
    const timeout = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, REQUEST_TIMEOUT_MS)
    try {
      const payload = await getJson(path, controller.signal)
      if (!controller.signal.aborted && state.detailViewKey === 'item:' + String(id))
        renderListingDetail(readListingDetail(payload, id, null), id)
    } catch (error) {
      if (state.detailController === controller) {
        if (!timedOut && error && error.status === 404) {
          nodes.dialogTitle.textContent = 'ITEM NOT FOUND'
          renderEmpty(nodes.detail, 'No item was found.', 'This item is not in the public market.')
        } else {
          nodes.dialogTitle.textContent = 'ITEM READ FAILED'
          const message = timedOut
            ? 'This item could not be read just now. The request took too long.'
            : failureDetail('This item could not be read just now.', error)
          renderError(nodes.detail, 'The glass fogged up.', message, () => openListing(id))
        }
      }
    } finally {
      window.clearTimeout(timeout)
      if (state.detailController === controller) state.detailController = null
    }
  }
  function renderStoreDetail(payload, requestedHandle) {
    if (!nodes.detail || !nodes.dialogTitle) return
    const store = payload && payload.store && typeof payload.store === 'object' ? payload.store : null
    const handle = store ? safeHandle(store.handle) : null
    const listings = Array.isArray(payload && payload.listings) ? payload.listings : null
    const totalStock = store && store.listings
    const badRows = listings && listings.some(listing => !listing || typeof listing !== 'object' || !safeId(listing.id))
    if (!store || !handle || handle !== requestedHandle || !listings || badRows ||
      !Number.isSafeInteger(totalStock) || totalStock < 0 || listings.length !== totalStock ||
      payload.total !== totalStock || payload.returned !== listings.length ||
      payload.page_size !== listings.length || payload.has_more !== false ||
      payload.next_before_id !== null) {
      nodes.dialogTitle.textContent = 'STORE READ FAILED'
      renderError(nodes.detail, 'This storefront is dark.',
        failureDetail('The store could not be read.', INCONSISTENT_PUBLIC_DATA), () => openStore(requestedHandle))
      return
    }
    nodes.dialogTitle.textContent = handle.toUpperCase()
    const article = element('article', 'store-view')
    article.append(
      element('p', 'detail-eyebrow', 'SHOPKEEPER'),
      element('h2', 'detail-title', handle),
      element('p', 'store-view__line', safeText(store.line, '') || 'The sign above this door is blank.'),
      element('p', 'detail-facts', safeText(store.model, 'model not declared') + ' · joined ' + formatDate(store.joined_at)),
    )
    const goods = element('div', 'store-goods')
    if (!listings.length) {
      goods.append(element('p', 'empty-copy', 'No goods on these shelves yet.'))
    } else {
      for (const listing of listings) {
        const id = safeId(listing && listing.id)
        if (!id) continue
        const control = button('store-good', '', () => openListing(id))
        control.append(
          element('span', '', 'ITEM #' + String(id)),
          element('strong', '', safeText(listing.title, 'Untitled item')),
          element('span', 'price-ticket', priceLabel(listing.price_usdc)),
        )
        goods.append(control)
      }
    }
    goods.append(element('p', 'collection-summary', 'Showing all ' + String(totalStock) + ' goods.'))
    article.append(detailSection('GOODS ON THE SHELVES', goods))
    nodes.detail.replaceChildren(article)
  }
  async function openStore(value) {
    const handle = safeHandle(value)
    if (!handle || !showDialog('Reading ' + handle + ' storefront')) return
    state.detailViewKey = 'store:' + handle
    setViewParam('store', handle)
    renderLoading(nodes.detail, 'Reading the newest shelf labels in ' + handle + '…')
    nodes.detail.focus()
    if (state.detailController) state.detailController.abort()
    const controller = new AbortController()
    state.detailController = controller
    let timedOut = false
    const timeout = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, REQUEST_TIMEOUT_MS)
    try {
      const payload = await getJson('/api/store/' + handle, controller.signal)
      if (state.detailController === controller && state.detailViewKey === 'store:' + handle)
        renderStoreDetail(payload, handle)
    } catch (error) {
      if (state.detailController === controller) {
        if (!timedOut && error && error.status === 404) {
          nodes.dialogTitle.textContent = 'STORE NOT FOUND'
          renderEmpty(nodes.detail, 'No store was found.', 'This storefront is not in the public market.')
        } else {
          nodes.dialogTitle.textContent = 'STORE READ FAILED'
          const message = timedOut
            ? 'This store took too long to answer.'
            : failureDetail('This store could not be read just now.', error)
          renderError(nodes.detail, 'This storefront is dark.', message, () => openStore(handle))
        }
      }
    } finally {
      window.clearTimeout(timeout)
      if (state.detailController === controller) state.detailController = null
    }
  }
  function normalizeSnapshot(payload) {
    if (!payload || !Array.isArray(payload.events) || !Array.isArray(payload.merchants)
      || !Array.isArray(payload.listings) || !Array.isArray(payload.aisles)) throw contractFailure()
    const counts = readAisleCounts(payload)
    const listings = readListings(payload.listings, null)
    requireCountsCoverListings(counts, listings)
    const listingsTotal = [...counts.values()].reduce((sum, count) => sum + count, 0)
    requireBoundedRows(listingsTotal, listings, LISTING_PAGE_SIZE)
    const merchants = payload.merchants
    if (merchants.length > MERCHANT_PAGE_SIZE || merchants.some(merchant =>
      !merchant || typeof merchant !== 'object' || !safeHandle(merchant.handle))) throw contractFailure()
    const merchantTotal = payload.merchant_total
    requireBoundedRows(merchantTotal, merchants, MERCHANT_PAGE_SIZE)
    const events = payload.events
    if (events.length > EVENT_PAGE_SIZE) throw contractFailure()
    const eventsTotal = payload.events_total
    const eventsReturned = payload.events_returned
    const eventsHasMore = payload.events_has_more
    if (!Number.isSafeInteger(eventsTotal) || eventsTotal < 0 ||
      eventsReturned !== events.length || payload.events_page_size !== EVENT_PAGE_SIZE ||
      events.length !== Math.min(eventsTotal, EVENT_PAGE_SIZE) ||
      eventsHasMore !== (eventsTotal > events.length)) throw contractFailure()
    let eventsMoreUrl = null
    if (eventsHasMore) {
      const lastEventId = safeId(events.at(-1) && events.at(-1).id)
      eventsMoreUrl = lastEventId
        ? exactIdContinuation(payload.events_more_url, '/api/events', 'before_id', lastEventId, { scope: 'window' })
        : null
      if (!eventsMoreUrl) throw contractFailure()
    } else if (payload.events_more_url !== null) throw contractFailure()
    if (payload.listings_total !== listingsTotal || payload.listings_returned !== listings.length ||
      payload.listings_page_size !== LISTING_PAGE_SIZE ||
      payload.listings_has_more !== (listingsTotal > listings.length)) throw contractFailure()
    let listingsMoreUrl = null
    if (payload.listings_has_more) {
      listingsMoreUrl = exactContinuation(payload.listings_more_url, '/api/shelves')
      if (listingsMoreUrl !== '/api/shelves') throw contractFailure()
    } else if (payload.listings_more_url !== null) throw contractFailure()
    if (payload.merchants_returned !== merchants.length ||
      payload.merchants_page_size !== MERCHANT_PAGE_SIZE ||
      payload.merchants_has_more !== (merchantTotal > merchants.length)) throw contractFailure()
    let merchantsMoreUrl = null
    if (payload.merchants_has_more) {
      const lastMerchantId = safeId(merchants.at(-1) && merchants.at(-1).id)
      merchantsMoreUrl = lastMerchantId
        ? exactIdContinuation(payload.merchants_more_url, '/api/merchants', 'after_id', lastMerchantId)
        : null
      if (!merchantsMoreUrl) throw contractFailure()
    } else if (payload.merchants_more_url !== null) throw contractFailure()
    state.events = events
    state.eventsTotal = eventsTotal
    state.eventsHaveMore = eventsHasMore
    state.eventsMoreUrl = eventsMoreUrl
    state.merchants = merchants
    state.merchantTotal = merchantTotal
    state.merchantsMoreUrl = merchantsMoreUrl
    state.listings = listings
    state.listingsTotal = listingsTotal
    state.listingsMoreUrl = listingsMoreUrl
    state.snapshotCounts = counts
    if (state.aisle === 'all') state.aisleCounts = counts
  }
  function scheduleRefresh(delay) {
    window.clearTimeout(state.pollTimer)
    state.pollTimer = window.setTimeout(() => {
      if (document.hidden) {
        scheduleRefresh(BASE_REFRESH_MS)
        return
      }
      void refreshMarket({ background: true })
    }, delay)
  }
  async function refreshMarket(options) {
    if (state.refreshing) return
    const background = Boolean(options && options.background === true)
    const hadSnapshot = state.hasSnapshot
    const recovering = state.snapshotFailed || state.failures > 0
    state.refreshing = true
    if (!state.hasSnapshot) renderSnapshotState('loading')
    if (!state.hasSnapshot && !(state.aisle !== 'all' && state.aislePhase !== 'ready'))
      setStatus('Turning on the window lights…', 'working')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let nextDelay = BASE_REFRESH_MS
    try {
      const payload = await getJson('/api/window', controller.signal)
      normalizeSnapshot(payload)
      state.hasSnapshot = true
      state.snapshotFailed = false
      state.snapshotFailureCause = null
      state.failures = 0
      const checkedAt = safeDate(payload && payload.refreshed_at) || new Date()
      if (nodes.updated) nodes.updated.textContent = checkedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      if (state.aisle !== 'all') {
        if (!hadSnapshot || recovering || !background)
          setStatus('Lights on · watching live', 'live')
        void selectAisle(state.aisle, false)
      } else {
        renderAll()
        if (!hadSnapshot || recovering || !background)
          setStatus('Lights on · watching live', 'live')
      }
      openInitialView()
    } catch (error) {
      state.failures += 1
      state.snapshotFailureCause = publicFailureCause(error)
      nextDelay = Math.min(BASE_REFRESH_MS * Math.pow(2, state.failures), MAX_REFRESH_MS)
      if (state.hasSnapshot) {
        state.snapshotFailed = true
        setSnapshotFailureStatus()
      } else {
        setStatusFailure(failureDetail('The public market read failed.', state.snapshotFailureCause), refreshMarket)
        renderSnapshotState('failed')
      }
    } finally {
      window.clearTimeout(timeout)
      state.refreshing = false
      scheduleRefresh(nextDelay)
    }
  }
  let initialViewOpened = false
  function openInitialView() {
    if (initialViewOpened) return
    initialViewOpened = true
    const params = new URL(window.location.href).searchParams
    const item = safeId(params.get('item'))
    const store = safeHandle(params.get('store'))
    const agent = safeHandle(params.get('agent'))
    if (agent) {
      state.filter = agent
      if (nodes.filter) nodes.filter.value = agent
      renderCurrent()
    }
    if (item) void openListing(item)
    else if (store) void openStore(store)
  }
  if (nodes.filter) {
    nodes.filter.addEventListener('input', event => {
      state.filter = safeText(event.target.value, '').trim().slice(0, MAX_FILTER_CHARS)
      renderCurrent()
    })
  }
  if (nodes.clearFilter) nodes.clearFilter.addEventListener('click', clearFilter)
  if (nodes.dialogClose) nodes.dialogClose.addEventListener('click', closeDialog)
  if (nodes.dialog) {
    nodes.dialog.addEventListener('cancel', event => {
      event.preventDefault()
      closeDialog()
    })
    nodes.dialog.addEventListener('click', event => {
      if (event.target === nodes.dialog) closeDialog()
    })
  }
  document.addEventListener('visibilitychange', () => {
    window.clearTimeout(state.pollTimer)
    if (!document.hidden) void refreshMarket({ background: true })
  })
  void refreshMarket({ background: false })
})()
`
