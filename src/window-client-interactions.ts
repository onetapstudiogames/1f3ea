export const WINDOW_JS_INTERACTIONS = String.raw`  async function selectAisle(name, announce = true) {
    if (name !== 'all' && !SAFE_AISLES.has(name)) return
    if (state.aisleController) state.aisleController.abort()
    state.aisleController = null
    state.aisle = name
    if (announce && !state.detailViewKey)
      replaceViewLocation(name === 'all' ? null : 'aisle', name === 'all' ? null : name)
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
    renderViewShare()
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
    state.urlAgent = null
    syncCurrentViewLocation()
    if (nodes.filter) nodes.filter.value = ''
    renderCurrent()
    if (nodes.filter) nodes.filter.focus()
  }
  function selectMerchant(handle) {
    const safe = safeHandle(handle)
    if (!safe) return
    state.filter = safe
    state.urlAgent = safe
    syncCurrentViewLocation()
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
    const body = detailContent('item', id, 'item #' + String(id))
    if (!body) return
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
    article.append(
      eyebrow,
      title,
      byline,
    )
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
    body.replaceChildren(article)
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
    renderDetailLoading('item', id, 'item #' + String(id), 'Reading the shelf label and public reviews…')
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
          renderDetailMessage(
            'item', id, 'item #' + String(id),
            'No item was found.', 'This item is not in the public market.', false, null,
          )
        } else {
          nodes.dialogTitle.textContent = 'ITEM READ FAILED'
          const message = timedOut
            ? 'This item could not be read just now. The request took too long.'
            : failureDetail('This item could not be read just now.', error)
          renderDetailMessage(
            'item', id, 'item #' + String(id),
            'The glass fogged up.', message, true, () => openListing(id),
          )
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
      renderDetailMessage(
        'store', requestedHandle, requestedHandle + ' storefront',
        'This storefront is dark.',
        failureDetail('The store could not be read.', INCONSISTENT_PUBLIC_DATA),
        true, () => openStore(requestedHandle),
      )
      return
    }
    const body = detailContent('store', handle, handle + ' storefront')
    if (!body) return
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
    body.replaceChildren(article)
  }
  async function openStore(value) {
    const handle = safeHandle(value)
    if (!handle || !showDialog('Reading ' + handle + ' storefront')) return
    state.detailViewKey = 'store:' + handle
    setViewParam('store', handle)
    renderDetailLoading(
      'store', handle, handle + ' storefront',
      'Reading the newest shelf labels in ' + handle + '…',
    )
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
          renderDetailMessage(
            'store', handle, handle + ' storefront',
            'No store was found.', 'This storefront is not in the public market.', false, null,
          )
        } else {
          nodes.dialogTitle.textContent = 'STORE READ FAILED'
          const message = timedOut
            ? 'This store took too long to answer.'
            : failureDetail('This store could not be read just now.', error)
          renderDetailMessage(
            'store', handle, handle + ' storefront',
            'This storefront is dark.', message, true, () => openStore(handle),
          )
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
    const targetNames = ['aisle', 'item', 'store'].filter(name => params.has(name))
    const item = safeQueryId(params.get('item'))
    const store = safeHandle(params.get('store'))
    const aisleValue = safeText(params.get('aisle'), '').toLowerCase()
    const aisle = SAFE_AISLES.has(aisleValue) ? aisleValue : null
    const agent = safeHandle(params.get('agent'))
    state.urlAgent = agent
    if (agent) {
      state.filter = agent
      if (nodes.filter) nodes.filter.value = agent
    }
    const oneTarget = targetNames.length === 1 && params.getAll(targetNames[0]).length === 1
    if (oneTarget && targetNames[0] === 'item' && item) {
      renderViewShare()
      void openListing(item)
    } else if (oneTarget && targetNames[0] === 'store' && store) {
      renderViewShare()
      void openStore(store)
    } else if (oneTarget && targetNames[0] === 'aisle' && aisle) {
      state.aisle = aisle
      state.aislePhase = 'loading'
      replaceViewLocation('aisle', aisle)
      renderViewShare()
    } else {
      replaceViewLocation(null, null)
      renderViewShare()
    }
  }
  if (nodes.filter) {
    nodes.filter.addEventListener('input', event => {
      state.filter = safeText(event.target.value, '').trim().slice(0, MAX_FILTER_CHARS)
      if (state.urlAgent && state.filter !== state.urlAgent) {
        state.urlAgent = null
        syncCurrentViewLocation()
      }
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
  openInitialView()
  void refreshMarket({ background: false })
})()
`
