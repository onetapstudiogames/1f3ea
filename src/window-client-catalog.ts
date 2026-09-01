import { EDITABLE_LISTING_FIELDS } from './market.ts'
export const WINDOW_JS_CATALOG = String.raw`(() => {
  'use strict'

  const BASE_REFRESH_MS = 60_000
  const MAX_REFRESH_MS = 300_000
  const REQUEST_TIMEOUT_MS = 10_000
  const MAX_ERROR_RESPONSE_BYTES = 4_096
  const MAX_ERROR_CAUSE_BYTES = 500
  const MAX_FILTER_CHARS = 100
  const PUBLIC_WINDOW_URL = 'https://1f3ea.com/window'
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
    viewShareKey: null, detailShareKey: null, detailBody: null, urlAgent: null,
  }
  const nodes = {
    status: document.getElementById('window-status'), updated: document.getElementById('updated-at'),
    counts: document.getElementById('market-counts'), filter: document.getElementById('filter-input'),
    clearFilter: document.getElementById('clear-filter'), filterNote: document.getElementById('filter-note'),
    activity: document.getElementById('activity-list'), aisles: document.getElementById('aisle-list'),
    listings: document.getElementById('listing-list'), merchants: document.getElementById('merchant-list'),
    viewShare: document.getElementById('view-share'),
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
  function safeQueryId(value) {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null
    const id = Number(value)
    return Number.isSafeInteger(id) ? id : null
  }
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
  function viewUrl(origin, kind, value, agent) {
    const url = new URL('/window', origin)
    if (kind && value !== null && value !== undefined) url.searchParams.set(kind, String(value))
    if (agent) url.searchParams.set('agent', agent)
    return url
  }
  function canonicalViewUrl(kind, value) {
    return viewUrl(new URL(PUBLIC_WINDOW_URL).origin, kind, value, null).href
  }
  function replaceViewLocation(kind, value) {
    const url = viewUrl(window.location.origin, kind, value, state.urlAgent)
    window.history.replaceState(null, '', url.pathname + url.search)
  }
  function setViewParam(kind, value) {
    if (kind === 'item' || kind === 'store') replaceViewLocation(kind, value)
    else if (state.aisle !== 'all') replaceViewLocation('aisle', state.aisle)
    else replaceViewLocation(null, null)
  }
  function syncCurrentViewLocation() {
    if (typeof state.detailViewKey === 'string' && state.detailViewKey.startsWith('item:')) {
      replaceViewLocation('item', safeId(state.detailViewKey.slice(5)))
    } else if (typeof state.detailViewKey === 'string' && state.detailViewKey.startsWith('store:')) {
      replaceViewLocation('store', safeHandle(state.detailViewKey.slice(6)))
    } else if (state.aisle !== 'all') replaceViewLocation('aisle', state.aisle)
    else replaceViewLocation(null, null)
  }
  function shareControl(url, subject) {
    const wrapper = element('div', 'share-control')
    let copying = false
    const copy = button('share-button', 'Copy public link', async () => {
      if (copying) return
      copying = true
      copy.disabled = true
      status.textContent = 'Copying…'
      try {
        if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function')
          throw new Error('clipboard unavailable')
        await navigator.clipboard.writeText(url)
        status.textContent = 'Link copied.'
        fallback.hidden = true
      } catch {
        status.textContent = 'Copy failed. Open the public link and copy it from the address bar.'
        fallback.hidden = false
      } finally {
        copying = false
        copy.disabled = false
      }
    })
    copy.setAttribute('aria-label', 'Copy public link for ' + subject)
    const status = element('span', 'share-status', '')
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    const fallback = element('a', 'share-link', 'Open public link')
    fallback.href = url
    fallback.hidden = true
    wrapper.append(element('span', 'share-label', 'Share ' + subject), copy, status, fallback)
    return wrapper
  }
  function renderViewShare() {
    if (!nodes.viewShare) return
    const focused = state.aisle !== 'all'
    const subject = focused ? 'the ' + state.aisle + ' aisle' : 'the full shop window'
    const url = canonicalViewUrl(focused ? 'aisle' : null, focused ? state.aisle : null)
    const key = url
    if (state.viewShareKey === key && nodes.viewShare.childNodes.length) return
    state.viewShareKey = key
    nodes.viewShare.replaceChildren(shareControl(url, subject))
  }
  function detailShare(kind, value, subject) {
    return shareControl(canonicalViewUrl(kind, value), subject)
  }
  function detailContent(kind, value, subject) {
    if (!nodes.detail) return null
    const key = kind + ':' + String(value)
    if (state.detailShareKey !== key || !state.detailBody) {
      const shell = element('div', 'detail-state')
      const body = element('div', 'detail-content')
      shell.append(detailShare(kind, value, subject), body)
      nodes.detail.replaceChildren(shell)
      state.detailShareKey = key
      state.detailBody = body
    }
    return state.detailBody
  }
  function renderDetailLoading(kind, value, subject, message) {
    const body = detailContent(kind, value, subject)
    if (!body) return
    const loading = element('div', 'empty-state')
    loading.append(element('span', 'loading-light', '●'), element('p', '', message))
    body.replaceChildren(loading)
  }
  function renderDetailMessage(kind, value, subject, title, detail, isError, retry) {
    const body = detailContent(kind, value, subject)
    if (!body) return
    const className = 'empty-state' + (isError ? ' empty-state--error' : '')
    const message = element('div', className)
    message.append(element('strong', '', title), element('p', '', detail))
    if (retry) message.append(button('text-button', 'Try again', retry))
    body.replaceChildren(message)
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
    state.detailShareKey = null
    state.detailBody = null
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
`
