// Route-level tests use one fetch fake for Neon, Base JSON-RPC, and the x402 facilitator.
// No live service, wallet, secret, payment, deployment, or production database is touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'

process.env.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'

const TREASURY = process.env.TREASURY_ADDRESS
const SELLER = '0x1111111111111111111111111111111111111111'
const STRANGER = '0x2222222222222222222222222222222222222222'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const SECRET = '1f3ea_sk_' + 'ab'.repeat(24)
const TX1 = '0x' + '11'.repeat(32)
const TX2 = '0x' + '22'.repeat(32)
const TX_CASE_LOWER = '0x' + 'ab'.repeat(32)
const TX_CASE_UPPER = '0x' + 'AB'.repeat(32)
const SIGNATURE = `0x${'01'.padStart(64, '0')}${'02'.padStart(64, '0')}1b`
const DOOR_EVENT_KINDS = new Set(['register', 'listing', 'maintainer_seed', 'sale', 'world_sale', 'world_canceled'])
const WINDOW_EVENT_KINDS = new Set([
  ...DOOR_EVENT_KINDS, 'listing_edit', 'withdrawal', 'moderation',
])

interface PurchaseIntentRow {
  id: number
  merchant_id: number
  listing_id: number
  payer_wallet: string
  seller_wallet: string
  network: 'base'
  asset: string
  minimum_amount_usdc: string
  challenge_nonce: string
  created_at: string
  expires_at: string
  superseded_at: string | null
  claimed_at: string | null
}

interface DbCall { url: string; query?: string; params?: unknown[] }

interface PostgresErrorFixture {
  code: string
  constraint?: string
  nested?: boolean
}

interface PublicEventFixture extends Record<string, unknown> {
  id: number
  at: string
  kind: string
  actor: string
  detail: Record<string, unknown>
}

const pad32 = (addr: string) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')

const state = {
  authValid: true,
  merchantId: 7,
  legacyListingsToday: 1,
  feeFrom: SELLER,
  feeAgeSeconds: 60,
  listingOwner: 7,
  listingExists: true,
  listingRemoved: false,
  listingRemovedAt: null as string | null,
  listingWithdrawn: false,
  listingWithdrawnAt: null as string | null,
  listingTitle: 'A useful thing',
  listingDescription: 'does work',
  listingPreview: 'sample',
  listingArtifact: 'the goods',
  listingPrice: 0,
  listingWallet: SELLER,
  listingTags: ['mcp'],
  listingAisle: 'tools',
  listingSales: 0,
  priorPurchase: false,
  duplicateId: null as number | null,
  duplicateWithdrawn: false,
  seedCount: 10,
  nextListingId: 42,
  registrationInsertError: null as PostgresErrorFixture | null,
  registrationEventError: null as PostgresErrorFixture | null,
  voteInsertErrorCode: null as string | null,
  voteInsertErrorConstraint: null as string | null,
  failFeeInsert: false,
  feeInsertErrorCode: '23505',
  feeInsertErrorConstraint: 'fees_tx_hash_lower_unique',
  paymentHashes: new Set<string>(),
  nextIntentId: 100,
  purchaseIntents: [] as PurchaseIntentRow[],
  failPurchaseInsert: false,
  purchaseInsertErrorCode: '23505',
  purchaseInsertErrorConstraint: 'purchases_listing_id_merchant_id_key',
  facilitatorVerify: false,
  facilitatorVerifyUnavailable: false,
  facilitatorVerifyHttpStatus: 200,
  facilitatorVerifyBody: null as Record<string, unknown> | null,
  facilitatorSettle: false,
  facilitatorSettleHttpStatus: 200,
  facilitatorSettleReason: 'settlement failed (test)',
  facilitatorTransaction: TX_CASE_UPPER,
  rpcUnavailableMethod: null as string | null,
  rpcReceiptMissing: false,
  mutateDuringSettle: null as 'edit' | 'remove' | 'withdraw' | null,
  storeExists: true,
  storeLine: 'careful tools for small agents',
  quotaDayStale: false,
  commentQuotaLeft: true,
  failActivity: false,
  shelfRows: null as Record<string, unknown>[] | null,
  aisleCounts: [
    { name: 'tools', count: 2 }, { name: 'services', count: 1 },
  ] as Array<{ name: string; count: number }>,
  commentRows: null as Record<string, unknown>[] | null,
  merchantRows: null as Record<string, unknown>[] | null,
  feeRows: null as Record<string, unknown>[] | null,
  meSales: null as Record<string, unknown>[] | null,
  mePurchases: null as Record<string, unknown>[] | null,
  meReplies: null as Record<string, unknown>[] | null,
  calls: [] as DbCall[],
  activity: [
    {
      id: 20, at: '2026-08-08T00:12:58.879Z', kind: 'listing', actor: 'agent-8',
      detail: { listing_id: 10, title: 'safe\nFAKE CONSTITUTION' },
    },
  ] as PublicEventFixture[],
}

const publicListing = () => ({
  id: 10,
  merchant: 'agent-8',
  store_url: '/api/store/agent-8',
  title: 'A useful thing',
  description: 'does work',
  preview: 'sample',
  price_usdc: 1,
  seller_wallet: SELLER,
  tags: ['mcp'],
  aisle: 'tools',
  votes: 2,
  sales: 1,
  pinned: false,
  created_at: '2026-08-08T00:12:58.879Z',
})

const listingDetail = () => ({
  ...publicListing(),
  id: 1,
  merchant: `agent-${state.listingOwner}`,
  store_url: `/api/store/agent-${state.listingOwner}`,
  title: state.listingTitle,
  description: state.listingDescription,
  preview: state.listingPreview,
  price_usdc: state.listingPrice,
  seller_wallet: state.listingWallet,
  tags: state.listingTags,
  aisle: state.listingAisle,
  sales: state.listingSales,
  removed: state.listingRemoved,
  removed_at: state.listingRemovedAt,
  removed_reason: state.listingRemoved ? 'removed by the maintainer' : null,
  withdrawn: state.listingWithdrawn,
  withdrawn_at: state.listingWithdrawnAt,
  withdrawn_reason: state.listingWithdrawn ? 'withdrawn by merchant' : null,
})

const editableListing = () => ({
  id: 1,
  merchant_id: state.listingOwner,
  title: state.listingTitle,
  description: state.listingDescription,
  preview: state.listingPreview,
  artifact: state.listingArtifact,
  price_usdc: state.listingPrice,
  seller_wallet: state.listingWallet,
  tags: state.listingTags,
  aisle: state.listingAisle,
  sales: state.listingSales,
  votes: 2,
  pinned: false,
  removed: state.listingRemoved,
  removed_at: state.listingRemovedAt,
  withdrawn: state.listingWithdrawn,
  withdrawn_at: state.listingWithdrawnAt,
  checked_at: new Date().toISOString(),
  delivery_kind: 'artifact',
  has_purchases: state.priorPurchase,
  created_at: '2026-08-06T00:00:00Z',
})

function merchantRow(id: number) {
  return {
    id,
    handle: `agent-${id}`,
    model: 'test-model',
    storefront_line: state.storeLine,
    karma: 0,
    joined_at: '2026-08-06T00:00:00Z',
    quota_day: state.quotaDayStale ? '2026-08-07' : '2026-08-08',
    listings_today: state.legacyListingsToday,
    comments_today: state.commentQuotaLeft ? 0 : 20,
    votes_today: 0,
  }
}

function assignedParam(query: string, params: unknown[], column: string): unknown {
  const match = query.match(new RegExp(`\\b${column}\\s*=\\s*\\$(\\d+)`, 'i'))
  return match ? params[Number(match[1]) - 1] : undefined
}

function applyListingEdit(query: string, params: unknown[]) {
  const stringFields = [
    ['title', 'listingTitle'],
    ['description', 'listingDescription'],
    ['preview', 'listingPreview'],
    ['artifact', 'listingArtifact'],
    ['seller_wallet', 'listingWallet'],
    ['aisle', 'listingAisle'],
  ] as const
  for (const [column, stateKey] of stringFields) {
    const value = assignedParam(query, params, column)
    if (value !== undefined) state[stateKey] = String(value)
  }
  const price = assignedParam(query, params, 'price_usdc')
  if (price !== undefined) state.listingPrice = Number(price)
  const tags = assignedParam(query, params, 'tags')
  if (Array.isArray(tags)) state.listingTags = tags.map(String)
}

function postgresError(fixture: PostgresErrorFixture, message: string): Error {
  const detail = Object.assign(new Error(message), {
    code: fixture.code,
    constraint: fixture.constraint,
  })
  return fixture.nested ? Object.assign(new Error(`wrapped ${message}`), { sourceError: detail }) : detail
}

function dbRespond(query: string, params: unknown[]): Record<string, unknown>[] {
  const byIdDescending = (left: Record<string, unknown>, right: Record<string, unknown>) =>
    Number(right.id) - Number(left.id)
  const byCreatedDescending = (left: Record<string, unknown>, right: Record<string, unknown>) =>
    String(right.created_at).localeCompare(String(left.created_at)) || byIdDescending(left, right)
  const byCreatedAscending = (left: Record<string, unknown>, right: Record<string, unknown>) =>
    String(left.created_at).localeCompare(String(right.created_at)) || Number(left.id) - Number(right.id)
  const byMerchantJoin = (left: Record<string, unknown>, right: Record<string, unknown>) =>
    String(left.joined_at).localeCompare(String(right.joined_at)) || Number(left.id) - Number(right.id)
  const byStoreOrder = (left: Record<string, unknown>, right: Record<string, unknown>) =>
    Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || byCreatedDescending(left, right)
  const anchoredPage = (
    rows: Record<string, unknown>[], cursor: unknown, fetchLimit: unknown,
    compare: (left: Record<string, unknown>, right: Record<string, unknown>) => number,
  ): Record<string, unknown>[] => {
    const ordered = [...rows].sort(compare)
    const anchor = cursor == null ? -1 : ordered.findIndex(row => Number(row.id) === Number(cursor))
    if (cursor != null && anchor < 0) return [{ id: null, __total: rows.length, __cursor_valid: false }]
    const page = ordered.slice(anchor + 1, anchor + 1 + Number(fetchLimit))
    return page.length
      ? page.map(row => ({ ...row, __total: rows.length, __cursor_valid: true }))
      : [{ id: null, __total: rows.length, __cursor_valid: true }]
  }
  const descendingPage = (rows: Record<string, unknown>[], cursor: unknown, fetchLimit: unknown) => {
    const page = rows
      .filter(row => cursor == null || Number(row.id) < Number(cursor))
      .sort((left, right) => Number(right.id) - Number(left.id))
      .slice(0, Number(fetchLimit))
    return page.length
      ? page.map(row => ({ ...row, __total: rows.length }))
      : [{ id: null, __total: rows.length }]
  }
  if (query.includes('/* public:shelves */')) {
    const rows: Record<string, unknown>[] = state.shelfRows ?? [publicListing()]
    const compare = query.includes('votes DESC')
      ? (left: Record<string, unknown>, right: Record<string, unknown>) =>
          Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) ||
          Number(right.votes) - Number(left.votes) || byCreatedDescending(left, right)
      : byStoreOrder
    return anchoredPage(rows, params.at(-2), params.at(-1), compare).map(row => ({
      ...row,
      __aisles: JSON.stringify(state.aisleCounts),
      __cursor_created_at: row.id == null
        ? null
        : row.__cursor_created_at ?? (row.created_at instanceof Date
            ? row.created_at.toISOString()
            : String(row.created_at)),
    }))
  }
  if (query.includes('/* public:listing-comments */')) {
    const rows = state.commentRows ?? []
    return anchoredPage(rows, params.at(-2), params.at(-1), byCreatedAscending)
  }
  if (query.includes('/* public:merchants */')) {
    const rows = state.merchantRows ?? [{
      id: 8, handle: 'agent-8', model: 'test-model', line: state.storeLine, karma: 3,
      joined_at: '2026-08-06T00:00:00Z', store_url: '/api/store/agent-8', listings: 1,
    }]
    return anchoredPage(rows, params.at(-2), params.at(-1), byMerchantJoin)
  }
  if (query.includes('/* public:events */')) {
    const kind = typeof params[0] === 'string' ? params[0] : null
    const scopeValue = params[1]
    const kinds = scopeValue == null
      ? null
      : new Set((Array.isArray(scopeValue) ? scopeValue : String(scopeValue).replace(/^\{|\}$/g, '').split(','))
          .map(value => String(value).replace(/^"|"$/g, '')))
    const rows = state.activity.filter(row => (!kind || row.kind === kind) && (!kinds || kinds.has(row.kind)))
    return anchoredPage(rows, params.at(-2), params.at(-1), byIdDescending)
  }
  if (query.includes('/* public:treasury-fees */')) {
    const rows = anchoredPage(state.feeRows ?? [], params.at(-2), params.at(-1), byIdDescending)
    const collected = (state.feeRows ?? []).reduce((sum, row) => sum + Number(row.amount_usdc), 0)
    return rows.map(row => ({ ...row, __collected: collected }))
  }
  if (query.includes('/* private:me-sales */'))
    return anchoredPage(state.meSales ?? [], params.at(-2), params.at(-1), byCreatedDescending)
  if (query.includes('/* private:me-purchases */'))
    return anchoredPage(state.mePurchases ?? [], params.at(-2), params.at(-1), byCreatedDescending)
  if (query.includes('/* private:me-replies */'))
    return anchoredPage(state.meReplies ?? [], params.at(-2), params.at(-1), byCreatedDescending)
  if (query.includes('/* public:door-activity */')) {
    const rows = descendingPage(state.activity.filter(row => DOOR_EVENT_KINDS.has(row.kind)), null, params.at(-1))
    return rows
  }
  if (query.includes('/* public:store-page */')) {
    const rows = state.shelfRows ?? [publicListing()]
    return anchoredPage(rows, params.at(-2), params.at(-1), byStoreOrder)
  }
  if (query.includes('/* public:store-complete */')) return state.shelfRows ?? [publicListing()]
  if (query.includes('/* public:window-merchants */')) {
    const rows = state.merchantRows ?? [{
      id: 8, handle: 'agent-8', model: 'test-model', line: state.storeLine, karma: 3,
      joined_at: '2026-08-06T00:00:00Z', listings: 1,
    }]
    return anchoredPage(rows, null, 500, byMerchantJoin).map(row => ({
      ...row, total_merchants: rows.length,
    }))
  }
  if (query.includes('/* public:window-listings */')) {
    const rows = state.shelfRows ?? [publicListing()]
    return anchoredPage(rows, null, 50, byStoreOrder).map(row => ({
      ...row, __aisles: JSON.stringify(state.aisleCounts),
    }))
  }
  if (query.includes('DELETE FROM reg_log')) return []
  if (query.includes('FROM reg_log')) return [{ ip: 0, all: 0 }]
  if (query.includes('INSERT INTO merchants')) {
    if (state.registrationInsertError)
      throw postgresError(state.registrationInsertError, 'merchant insert failed')
    return [{ id: 77 }]
  }
  if (query.includes('INSERT INTO reg_log')) return []
  if (query.includes('INSERT INTO votes')) {
    if (state.voteInsertErrorCode)
      throw Object.assign(new Error('vote insert failed'), {
        code: state.voteInsertErrorCode,
        constraint: state.voteInsertErrorConstraint,
      })
    return []
  }
  if (query.includes('comments_today = CASE WHEN quota_day') && query.includes('WHERE secret_hash')) {
    if (!state.authValid) return []
    if (state.quotaDayStale) {
      state.quotaDayStale = false
      state.commentQuotaLeft = true
    }
    return [merchantRow(state.merchantId)]
  }
  if (query.includes('comments_today = CASE WHEN quota_day') && query.includes('WHERE id =')) {
    if (!state.authValid) return []
    if (state.quotaDayStale) {
      state.quotaDayStale = false
      state.commentQuotaLeft = true
    }
    return [merchantRow(state.merchantId)]
  }
  if (query.includes('SELECT id FROM listings WHERE dup_hash')) {
    if (state.duplicateId == null) return []
    if (state.duplicateWithdrawn && /NOT\s+(?:l\.)?withdrawn/i.test(query)) return []
    return [{ id: state.duplicateId }]
  }
  if (query.includes('SELECT count(*)::int AS n FROM listings WHERE merchant_id'))
    return [{ n: state.seedCount }]
  if (query.includes('INSERT INTO listings')) {
    const id = state.nextListingId++
    if (query.includes('INSERT INTO fees')) {
      if (state.failFeeInsert)
        throw Object.assign(new Error('fee insert failed'), {
          code: state.feeInsertErrorCode,
          constraint: state.feeInsertErrorConstraint,
        })
      const rawHash = params.find(value => /^0x[0-9a-fA-F]{64}$/.test(String(value)))
      const hash = String(rawHash ?? '').toLowerCase()
      if (state.paymentHashes.has(hash))
        throw Object.assign(new Error('duplicate fee'), { code: '23505', constraint: 'payment_uses_pkey' })
      state.paymentHashes.add(hash)
    }
    return [{ id }]
  }
  if (query.includes('INSERT INTO fees')) {
    if (state.failFeeInsert)
      throw Object.assign(new Error('fee insert failed'), {
        code: state.feeInsertErrorCode,
        constraint: state.feeInsertErrorConstraint,
      })
    const hash = String(params[3] ?? '').toLowerCase()
    if (state.paymentHashes.has(hash))
      throw Object.assign(new Error('duplicate fee'), { code: '23505', constraint: 'payment_uses_pkey' })
    state.paymentHashes.add(hash)
    return []
  }
  if (query.includes('FROM listings l JOIN merchants m') && query.includes('WHERE l.id'))
    return state.listingExists ? [listingDetail()] : []
  if (query.includes('FROM listings WHERE id') && query.includes('merchant_id') && !query.includes('SELECT id, merchant_id, title')) {
    return state.listingExists ? [editableListing()] : []
  }
  if (/UPDATE listings SET\s+withdrawn\s*=/i.test(query)) {
    if (!state.listingExists || state.listingOwner !== state.merchantId) return []
    if (state.listingWithdrawn && query.includes('NOT withdrawn')) return []
    state.listingWithdrawn = true
    state.listingWithdrawnAt = new Date().toISOString()
    return [{ id: 1, withdrawn: true, already_withdrawn: false }]
  }
  if (/UPDATE listings SET\s+removed\s*=/i.test(query)) {
    if (!state.listingExists) return []
    if (state.listingWithdrawn && /NOT\s+withdrawn/i.test(query)) return []
    state.listingRemoved = true
    state.listingRemovedAt = new Date().toISOString()
    if (/withdrawn\s*=\s*(?:FALSE|\$\d+)/i.test(query)) state.listingWithdrawn = false
    return [{ id: 1 }]
  }
  if (query.includes('UPDATE listings SET') && !query.includes('SET sales') &&
      !query.includes('SET pinned') && !query.includes('SET removed')) {
    if (!state.listingExists || state.listingOwner !== state.merchantId) return []
    applyListingEdit(query, params)
    return [editableListing()]
  }
  if (query.includes('DELETE FROM listings')) return []
  if (query.includes('INSERT INTO events') && !query.includes('INSERT INTO purchases')) {
    if (state.registrationEventError && params[0] === 'register')
      throw postgresError(state.registrationEventError, 'registration event insert failed')
    return []
  }
  if (query.includes('UPDATE merchants SET storefront_line')) {
    state.storeLine = String(params[0] ?? '')
    return [{ line: state.storeLine }]
  }
  if (query.includes('count(l.id)::int AS listings') && query.includes('GROUP BY m.id')) {
    return [{
      handle: 'agent-8', model: 'test-model', line: state.storeLine, karma: 3,
      joined_at: '2026-08-06T00:00:00Z', listings: 1, total_merchants: 1,
    }]
  }
  if (query.includes('storefront_line AS line') && query.includes('FROM merchants')) {
    return state.storeExists
      ? [{
        id: 8, handle: 'agent-8', model: 'test-model', line: state.storeLine, karma: 3,
        joined_at: '2026-08-06T00:00:00Z', listings: 1,
      }]
      : []
  }
  if (query.includes('GROUP BY aisle')) return [{ aisle: 'tools', count: 2 }, { aisle: 'services', count: 1 }]
  if (query.includes('FROM listings l JOIN merchants m') && query.includes('l.merchant_id')) return [publicListing()]
  if (query.includes('FROM listings l JOIN merchants m') && query.includes('NOT l.removed')) return [publicListing()]
  if (query.includes('SELECT id, merchant_id, title')) {
    return state.listingExists ? [editableListing()] : []
  }
  if (query.includes('SELECT id FROM purchases')) return state.priorPurchase ? [{ id: 55 }] : []
  if (query.includes('INSERT INTO direct_purchase_intents')) {
    const dates = params.filter(value => typeof value === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) as string[]
    const wallets = params.filter(value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)) as string[]
    const next: PurchaseIntentRow = {
      id: state.nextIntentId++,
      merchant_id: state.merchantId,
      listing_id: 1,
      payer_wallet: String(wallets.find(wallet => wallet.toLowerCase() !== state.listingWallet.toLowerCase()
        && wallet.toLowerCase() !== USDC.toLowerCase()) ?? state.feeFrom).toLowerCase(),
      seller_wallet: state.listingWallet.toLowerCase(),
      network: 'base',
      asset: USDC.toLowerCase(),
      minimum_amount_usdc: state.listingPrice.toFixed(6),
      challenge_nonce: String(params.find(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))),
      created_at: dates.at(-2)!,
      expires_at: dates.at(-1)!,
      superseded_at: null,
      claimed_at: null,
    }
    state.purchaseIntents = state.purchaseIntents.map(intent => intent.claimed_at || intent.superseded_at
      ? intent
      : { ...intent, superseded_at: next.created_at })
    state.purchaseIntents = [...state.purchaseIntents, next]
    return [{ ...next }]
  }
  if (query.includes('FROM direct_purchase_intents')) {
    const intentId = Number(params.find(value =>
      (typeof value === 'number' && Number.isInteger(value) && value >= 100)
      || (typeof value === 'string' && /^\d+$/.test(value) && Number(value) >= 100)))
    const intent = state.purchaseIntents.find(candidate => candidate.id === intentId)
    return intent ? [{ ...intent }] : []
  }
  if (query.includes('FROM listings WHERE merchant_id')) return [{
    id: 10, title: 'A useful thing', aisle: 'tools', price_usdc: 1, votes: 2,
    sales: 1, pinned: false, removed: false, created_at: '2026-08-08T00:12:58.879Z',
  }]
  if (query.includes('FROM purchases p JOIN listings l') && query.includes('l.artifact')) {
    return state.priorPurchase ? [{
      listing_id: 1,
      title: 'private operator identifier in title',
      amount_usdc: 1,
      verified_via: 'claim',
      created_at: '2026-08-07T00:00:00Z',
      artifact: 'previously purchased private artifact',
    }] : []
  }
  if (query.includes('FROM purchases p JOIN listings l')) return []
  if (query.includes('FROM comments c JOIN listings l')) return []
  if (query.includes('FROM comments c JOIN merchants m')) return []
  if (query.includes('INSERT INTO purchases')) {
    if (state.failPurchaseInsert)
      throw Object.assign(new Error('purchase insert failed'), {
        code: state.purchaseInsertErrorCode,
        constraint: state.purchaseInsertErrorConstraint,
      })
    const rawHash = params.find(value => /^0x[0-9a-fA-F]{64}$/.test(String(value)))
    if (rawHash) {
      const hash = String(rawHash).toLowerCase()
      if (state.paymentHashes.has(hash))
        throw Object.assign(new Error('duplicate payment use'), { code: '23505', constraint: 'payment_uses_pkey' })
      state.paymentHashes.add(hash)
    }
    const intentId = Number(params.find(value =>
      (typeof value === 'number' && Number.isInteger(value) && value >= 100)
      || (typeof value === 'string' && /^\d+$/.test(value) && Number(value) >= 100)))
    if (Number.isInteger(intentId)) {
      const intent = state.purchaseIntents.find(candidate => candidate.id === intentId)
      if (!intent || intent.claimed_at || intent.superseded_at) return []
      state.purchaseIntents = state.purchaseIntents.map(candidate => candidate.id === intentId
        ? { ...candidate, claimed_at: new Date().toISOString() }
        : candidate)
    }
    const terminalAt = [state.listingRemovedAt, state.listingWithdrawnAt]
      .filter((value): value is string => Boolean(value))
      .map(value => Date.parse(value))
      .sort((a, b) => a - b)[0]
    if (terminalAt != null) {
      const hasTemporalBoundary = /removed_at|withdrawn_at/i.test(query)
      const paidAt = params
        .map(value => typeof value === 'string' ? Date.parse(value) : NaN)
        .find(value => Number.isFinite(value))
      if (!hasTemporalBoundary || paidAt == null || paidAt > terminalAt) return []
    }
    return [{ listing_id: 1 }]
  }
  if (query.includes('UPDATE listings SET sales')) return []
  if (query.includes('SELECT title, artifact'))
    return [{ title: state.listingTitle, artifact: state.listingArtifact }]
  if (query.includes('SELECT id FROM listings WHERE id')) return state.listingExists ? [{ id: 1 }] : []
  if (query.includes('comments_today = (CASE WHEN quota_day')) {
    if (state.quotaDayStale) {
      state.quotaDayStale = false
      state.commentQuotaLeft = true
    }
    return state.commentQuotaLeft ? [{ id: state.merchantId }] : []
  }
  if (query.includes('SELECT at, kind, actor, detail FROM events')) return state.activity
  if (query.includes('/* public:window-events */')) {
    const eligible = state.activity.filter(row => WINDOW_EVENT_KINDS.has(row.kind))
    const requested = Number(query.match(/LIMIT\s+(\d+)/i)?.[1] ?? state.activity.length)
    return eligible.slice(0, requested).map(row => ({ ...row, total_events: eligible.length }))
  }
  if (query.includes('SELECT id, at, kind, actor, detail FROM events') && query.includes('kind IN')) {
    const requested = Number(query.match(/LIMIT\s+(\d+)/i)?.[1] ?? state.activity.length)
    return state.activity.slice(0, requested)
  }
  throw new Error(`unhandled query: ${query}`)
}

function chainRespond(method: string): unknown {
  if (method === 'web3_sha3') return '0x' + 'aa'.repeat(32)
  if (method === 'eth_call') return '0x' + '00'.repeat(12) + state.feeFrom.toLowerCase().slice(2)
  if (method === 'eth_getTransactionReceipt') {
    if (state.rpcReceiptMissing) return null
    return {
      status: '0x1',
      blockHash: '0x' + 'bb'.repeat(32),
      logs: [{
        address: USDC,
        topics: [TRANSFER_TOPIC, pad32(state.feeFrom), pad32(TREASURY)],
        data: pad32('0x0f4240'),
      }],
    }
  }
  if (method === 'eth_getBlockByHash') {
    return { timestamp: '0x' + Math.floor((Date.now() - state.feeAgeSeconds * 1000) / 1000).toString(16) }
  }
  throw new Error(`unhandled rpc: ${method}`)
}

const jsonRes = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })

function pgArray(values: unknown[]) {
  return `{${values.map(v => `"${String(v).replace(/(["\\])/g, '\\$1')}"`).join(',')}}`
}

function neonEncode(rows: Record<string, unknown>[]) {
  const keys = Object.keys(rows[0] ?? {})
  const typeOf = (v: unknown) => {
    if (typeof v === 'boolean') return 16
    if (typeof v === 'number') return Number.isInteger(v) ? 23 : 701
    if (v instanceof Date) return 1184
    if (Array.isArray(v)) return 1009
    if (v != null && typeof v === 'object') return 3802
    return 25
  }
  const encode = (v: unknown) => {
    if (v === null) return null
    if (typeof v === 'boolean') return v ? 't' : 'f'
    if (v instanceof Date) return v.toISOString()
    if (Array.isArray(v)) return pgArray(v)
    if (typeof v === 'object') return JSON.stringify(v)
    return String(v)
  }
  return {
    command: 'SELECT',
    rowCount: rows.length,
    fields: keys.map(name => ({ name, dataTypeID: typeOf(rows[0]![name]) })),
    rows: rows.map(row => keys.map(key => encode(row[key]))),
  }
}

globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
  const url = String(input)
  const body = init?.body ? JSON.parse(init.body) : null
  state.calls.push({ url, query: body?.query, params: body?.params })
  if (url.includes('/sql')) {
    if (state.failActivity && String(body.query).includes('/* public:door-activity */'))
      return jsonRes({ message: 'database unavailable' }, 503)
    return jsonRes(neonEncode(dbRespond(body.query, body.params ?? [])))
  }
  if (url.includes('mainnet.base.org'))
    return state.rpcUnavailableMethod === body.method
      ? new Response('Base RPC unavailable', { status: 503 })
      : jsonRes({ jsonrpc: '2.0', id: body.id, result: chainRespond(body.method) })
  if (url.includes('/verify')) return state.facilitatorVerifyUnavailable
    ? new Response('facilitator unavailable', { status: 503 })
    : jsonRes(state.facilitatorVerifyBody ?? (state.facilitatorVerify
      ? { isValid: true }
      : { isValid: false, invalidReason: 'facilitator says no (test)' }),
    state.facilitatorVerifyHttpStatus)
  if (url.includes('/settle')) {
    if (!state.facilitatorSettle)
      return jsonRes({ success: false, errorReason: state.facilitatorSettleReason },
        state.facilitatorSettleHttpStatus)
    const terminalAt = new Date(Date.now() + 500).toISOString()
    if (state.mutateDuringSettle === 'edit') state.listingDescription = 'edited after settlement'
    if (state.mutateDuringSettle === 'withdraw') {
      state.listingWithdrawn = true
      state.listingWithdrawnAt = terminalAt
    }
    if (state.mutateDuringSettle === 'remove') {
      state.listingRemoved = true
      state.listingRemovedAt = terminalAt
    }
    return jsonRes({ success: true, transaction: state.facilitatorTransaction, payer: SELLER })
  }
  throw new Error(`unexpected fetch: ${url}`)
}) as typeof fetch

const { default: app } = await import('../src/index.ts')
const { FRONTDOOR } = await import('../src/door.ts')
const { AISLES } = await import('../src/market.ts')
const { decodeShelfCursor } = await import('../src/public-pagination.ts')
const {
  allowOAuthForHostedConnectorRequest,
  auth,
  dupHash,
  setOAuthMerchantResolver,
  spendQuota,
} = await import('../src/core.ts')

const authed = { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }
const listingBody = (feeTx?: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  title: 'A test artifact',
  description: 'd',
  preview: '',
  artifact: 'x',
  price_usdc: 0,
  seller_wallet: SELLER,
  tags: ['mcp'],
  ...(feeTx ? { fee_tx_hash: feeTx } : {}),
  ...extra,
})

function reset() {
  state.authValid = true
  state.merchantId = 7
  state.legacyListingsToday = 1
  state.feeFrom = SELLER
  state.feeAgeSeconds = 60
  state.listingOwner = 7
  state.listingExists = true
  state.listingRemoved = false
  state.listingRemovedAt = null
  state.listingWithdrawn = false
  state.listingWithdrawnAt = null
  state.listingTitle = 'A useful thing'
  state.listingDescription = 'does work'
  state.listingPreview = 'sample'
  state.listingArtifact = 'the goods'
  state.listingPrice = 0
  state.listingWallet = SELLER
  state.listingTags = ['mcp']
  state.listingAisle = 'tools'
  state.listingSales = 0
  state.priorPurchase = false
  state.duplicateId = null
  state.duplicateWithdrawn = false
  state.seedCount = 10
  state.nextListingId = 42
  state.registrationInsertError = null
  state.registrationEventError = null
  state.voteInsertErrorCode = null
  state.voteInsertErrorConstraint = null
  state.failFeeInsert = false
  state.feeInsertErrorCode = '23505'
  state.feeInsertErrorConstraint = 'fees_tx_hash_lower_unique'
  state.paymentHashes = new Set()
  state.nextIntentId = 100
  state.purchaseIntents = []
  state.failPurchaseInsert = false
  state.purchaseInsertErrorCode = '23505'
  state.purchaseInsertErrorConstraint = 'purchases_listing_id_merchant_id_key'
  state.facilitatorVerify = false
  state.facilitatorVerifyUnavailable = false
  state.facilitatorVerifyHttpStatus = 200
  state.facilitatorVerifyBody = null
  state.facilitatorSettle = false
  state.facilitatorSettleHttpStatus = 200
  state.facilitatorSettleReason = 'settlement failed (test)'
  state.facilitatorTransaction = TX_CASE_UPPER
  state.rpcUnavailableMethod = null
  state.rpcReceiptMissing = false
  state.mutateDuringSettle = null
  state.storeExists = true
  state.storeLine = 'careful tools for small agents'
  state.quotaDayStale = false
  state.commentQuotaLeft = true
  state.failActivity = false
  state.shelfRows = null
  state.aisleCounts = [{ name: 'tools', count: 2 }, { name: 'services', count: 1 }]
  state.commentRows = null
  state.merchantRows = null
  state.feeRows = null
  state.meSales = null
  state.mePurchases = null
  state.meReplies = null
  state.calls = []
}

const sqlCalls = () => state.calls.filter(call => call.query)
const hasSql = (pattern: RegExp) => sqlCalls().some(call => pattern.test(call.query ?? ''))
const inserted = (table: string) => sqlCalls().filter(call => call.query?.includes(`INSERT INTO ${table}`)).length

async function openDirectIntent() {
  const response = await app.request('/api/purchase-intent/1', {
    method: 'POST', headers: authed, body: JSON.stringify({ payer_wallet: state.feeFrom }),
  })
  assert.equal(response.status, 201)
  return (await response.json() as { purchase_intent: PurchaseIntentRow }).purchase_intent
}

function directClaimBody(intentId: number, txHash: string) {
  return JSON.stringify({ intent_id: intentId, tx_hash: txHash, payer_signature: SIGNATURE })
}

test('registration reports only a nested merchants_handle_key violation as a taken handle', async () => {
  reset()
  state.registrationInsertError = {
    code: '23505', constraint: 'merchants_handle_key', nested: true,
  }
  const res = await app.request('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle: 'taken-handle', model: 'test-model' }),
  })
  assert.equal(res.status, 409)
  assert.deepEqual(await res.json(), { error: 'handle taken' })
})

test('registration does not misreport another merchant unique violation as a taken handle', async () => {
  reset()
  state.registrationInsertError = { code: '23505', constraint: 'merchants_pkey' }
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const res = await app.request('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'new-handle', model: 'test-model' }),
    })
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: 'internal market failure; retry later' })
  } finally {
    console.error = originalConsoleError
  }
})

test('registration reports a non-conflict database failure as internal', async () => {
  reset()
  state.registrationInsertError = { code: '08006' }
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const res = await app.request('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'new-handle', model: 'test-model' }),
    })
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: 'internal market failure; retry later' })
  } finally {
    console.error = originalConsoleError
  }
})

test('registration reports a late event unique violation as internal', async () => {
  reset()
  state.registrationEventError = { code: '23505', constraint: 'events_pkey' }
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const res = await app.request('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'new-handle', model: 'test-model' }),
    })
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: 'internal market failure; retry later' })
  } finally {
    console.error = originalConsoleError
  }
})

test('voting reports a unique vote conflict as a caller-correctable refusal', async () => {
  reset()
  state.listingOwner = 8
  state.voteInsertErrorCode = '23505'
  state.voteInsertErrorConstraint = 'votes_pkey'
  const res = await app.request('/api/vote', {
    method: 'POST', headers: authed, body: JSON.stringify({ listing_id: 1 }),
  })
  assert.equal(res.status, 409)
  assert.deepEqual(await res.json(), { error: 'already voted for that listing' })
})

test('voting reports an unrelated unique violation as internal', async () => {
  reset()
  state.listingOwner = 8
  state.voteInsertErrorCode = '23505'
  state.voteInsertErrorConstraint = 'votes_created_at_key'
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const res = await app.request('/api/vote', {
      method: 'POST', headers: authed, body: JSON.stringify({ listing_id: 1 }),
    })
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: 'internal market failure; retry later' })
  } finally {
    console.error = originalConsoleError
  }
})

test('voting reports a non-conflict database failure as internal', async () => {
  reset()
  state.listingOwner = 8
  state.voteInsertErrorCode = '08006'
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const res = await app.request('/api/vote', {
      method: 'POST', headers: authed, body: JSON.stringify({ listing_id: 1 }),
    })
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: 'internal market failure; retry later' })
  } finally {
    console.error = originalConsoleError
  }
})

test('every market action route returns a caller-facing cause when it refuses a request', async () => {
  const cases = [
    ['register', '/api/register', 'POST', { handle: 'x' }, /handle must match/iu],
    ['rotate key', '/api/rotate', 'POST', {}, /bad or missing bearer secret/iu],
    ['set store', '/api/store', 'POST', {}, /bad or missing bearer secret/iu],
    ['list item', '/api/listing', 'POST', {}, /bad or missing bearer secret/iu],
    ['edit item', '/api/listing/1', 'PATCH', {}, /bad or missing bearer secret/iu],
    ['withdraw item', '/api/listing/1/withdraw', 'POST', {}, /bad or missing bearer secret/iu],
    ['create purchase intent', '/api/purchase-intent/1', 'POST', {}, /register first/iu],
    ['buy item', '/api/buy/1', 'POST', {}, /register first/iu],
    ['claim purchase', '/api/claim/1', 'POST', {}, /register first/iu],
    ['comment', '/api/comment', 'POST', {}, /bad or missing bearer secret/iu],
    ['vote', '/api/vote', 'POST', {}, /bad or missing bearer secret/iu],
    ['flag', '/api/flag', 'POST', {}, /need target_type.*target_id.*reason/iu],
    ['remove listing', '/api/mod/remove', 'POST', {}, /bad or missing bearer secret/iu],
    ['pin listing', '/api/mod/pin', 'POST', {}, /bad or missing bearer secret/iu],
    ['draft world item', '/api/world/draft', 'POST', {}, /bad or missing bearer secret/iu],
    ['list world item', '/api/world/listing', 'POST', {}, /bad or missing bearer secret/iu],
    ['checkout world item', '/api/world/checkout/1', 'POST', {}, /register in the market first/iu],
    ['sync world item', '/api/world/sync/1', 'POST', {}, /bad or missing bearer secret/iu],
  ] as const

  for (const [verb, path, method, body, cause] of cases) {
    reset()
    const response = await app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.ok(response.status >= 400, verb)
    const refusal = await response.json() as { error?: unknown }
    assert.equal(typeof refusal.error, 'string', verb)
    assert.match(String(refusal.error), cause, verb)
  }
})

test('a seller cannot buy its own listing', async () => {
  reset()
  const res = await app.request('/api/buy/1', { method: 'POST', headers: authed })
  assert.equal(res.status, 403)
  assert.match(((await res.json()) as { error: string }).error, /your own goods/)
})

test('another merchant can still buy free goods', async () => {
  reset()
  state.listingOwner = 8
  const res = await app.request('/api/buy/1', { method: 'POST', headers: authed })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as { artifact: string }).artifact, 'the goods')
  const write = sqlCalls().find(call => call.query?.includes('INSERT INTO purchases'))
  assert.match(write?.query ?? '', /UPDATE listings SET sales/)
  assert.match(write?.query ?? '', /INSERT INTO events/)
  assert.match(write?.query ?? '', /'via', \$\d+::text/)
})

test('hosted paid listing, buy, and direct-claim routes stop before payment work while custody is closed', async () => {
  reset()
  const previousEnvironment = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    PAYMENT_CUSTODY_READY: process.env.PAYMENT_CUSTODY_READY,
  }
  process.env.VERCEL_ENV = 'production'
  delete process.env.PAYMENT_CUSTODY_READY

  try {
    const listing = await app.request('/api/listing', {
      method: 'POST', headers: authed, body: listingBody(),
    })
    assert.equal(listing.status, 503)

    state.listingOwner = 8
    state.listingPrice = 1
    const buy = await app.request('/api/buy/1', { method: 'POST', headers: authed })
    assert.equal(buy.status, 503)

    const claim = await app.request('/api/claim/1', {
      method: 'POST', headers: authed, body: JSON.stringify({ tx_hash: TX1 }),
    })
    assert.equal(claim.status, 503)

    assert.equal(state.calls.some(call => /facilitator|mainnet\.base/i.test(call.url)), false)
    assert.equal(inserted('fees'), 0)
    assert.equal(inserted('purchases'), 0)
  } finally {
    if (previousEnvironment.VERCEL_ENV == null) delete process.env.VERCEL_ENV
    else process.env.VERCEL_ENV = previousEnvironment.VERCEL_ENV
    if (previousEnvironment.PAYMENT_CUSTODY_READY == null) delete process.env.PAYMENT_CUSTODY_READY
    else process.env.PAYMENT_CUSTODY_READY = previousEnvironment.PAYMENT_CUSTODY_READY
  }
})

test('listing withdrawal rejects missing, malformed, and unknown bearer secrets without writes', async () => {
  reset()
  const missing = await app.request('/api/listing/1/withdraw', { method: 'POST' })
  assert.equal(missing.status, 401)

  const malformed = await app.request('/api/listing/1/withdraw', {
    method: 'POST', headers: { Authorization: 'Bearer not-a-1f3ea-secret' },
  })
  assert.equal(malformed.status, 401)

  state.authValid = false
  const unknown = await app.request('/api/listing/1/withdraw', { method: 'POST', headers: authed })
  assert.equal(unknown.status, 401)
  assert.equal(hasSql(/UPDATE listings SET[\s\S]*withdrawn/i), false)
  assert.equal(inserted('events'), 0)
})

test('a merchant cannot withdraw another merchant\'s listing', async () => {
  reset()
  state.listingOwner = 8
  const res = await app.request('/api/listing/1/withdraw', { method: 'POST', headers: authed })
  assert.equal(res.status, 403)
  assert.equal(state.listingWithdrawn, false)
  assert.equal(inserted('events'), 0)
})

test('withdrawing a listing that does not exist returns 404', async () => {
  reset()
  state.listingExists = false
  const res = await app.request('/api/listing/999/withdraw', { method: 'POST', headers: authed })
  assert.equal(res.status, 404)
  assert.match(((await res.json()) as { error: string }).error, /no such listing/i)
  assert.equal(inserted('events'), 0)
})

test('an owner can withdraw a listing and the public event names the merchant actor', async () => {
  reset()
  const res = await app.request('/api/listing/1/withdraw', { method: 'POST', headers: authed })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, listing_id: 1, status: 'withdrawn' })
  assert.equal(state.listingWithdrawn, true)

  const write = sqlCalls().find(call => /UPDATE listings SET[\s\S]*withdrawn/i.test(call.query ?? ''))
  assert.match(write?.query ?? '', /merchant_id/i)
  const events = sqlCalls().filter(call => call.query?.includes('INSERT INTO events'))
  assert.equal(events.length, 1)
  const publicReceipt = `${events[0]!.query}\n${JSON.stringify(events[0]!.params)}`
  assert.match(publicReceipt, /withdrawal/i)
  assert.match(publicReceipt, /agent-7/)
  assert.match(publicReceipt, /listing_id/)
  assert.match(publicReceipt, /withdrawn by merchant/)
  assert.doesNotMatch(publicReceipt, /private operator identifier/)
})

test('withdrawal rejects merchant-authored public text and always uses the fixed reason', async () => {
  reset()
  const merchantText = 'please publish this merchant-authored explanation'
  const rejected = await app.request('/api/listing/1/withdraw', {
    method: 'POST', headers: authed, body: JSON.stringify({ reason: merchantText }),
  })
  assert.equal(rejected.status, 400)
  assert.equal(state.listingWithdrawn, false)
  assert.equal(inserted('events'), 0)

  const accepted = await app.request('/api/listing/1/withdraw', {
    method: 'POST', headers: authed, body: JSON.stringify({}),
  })
  assert.equal(accepted.status, 200)
  const event = sqlCalls().find(call => call.query?.includes('INSERT INTO events'))
  const receipt = `${event?.query}\n${JSON.stringify(event?.params)}`
  assert.match(receipt, /withdrawn by merchant/)
  assert.doesNotMatch(receipt, new RegExp(merchantText))
})

test('repeating an owner withdrawal is an idempotent success with no second event', async () => {
  reset()
  const first = await app.request('/api/listing/1/withdraw', { method: 'POST', headers: authed })
  const second = await app.request('/api/listing/1/withdraw', { method: 'POST', headers: authed })
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.deepEqual(await second.json(), { ok: true, listing_id: 1, status: 'withdrawn' })
  assert.equal(inserted('events'), 1)
})

test('an owner may withdraw a priced listing even after prior purchases', async () => {
  reset()
  state.listingPrice = 1
  state.listingSales = 2
  state.priorPurchase = true
  const res = await app.request('/api/listing/1/withdraw', { method: 'POST', headers: authed })
  assert.equal(res.status, 200)
  assert.equal(state.listingWithdrawn, true)
  assert.equal(inserted('events'), 1)
})

test('maintainer removal may supersede a merchant withdrawal and becomes the public tombstone', async () => {
  reset()
  state.merchantId = 1
  state.listingOwner = 7
  state.listingWithdrawn = true
  state.listingWithdrawnAt = new Date(Date.now() - 60_000).toISOString()
  const removed = await app.request('/api/mod/remove', {
    method: 'POST', headers: authed,
    body: JSON.stringify({ listing_id: 1, reason: 'privacy redaction' }),
  })
  assert.equal(removed.status, 200)
  assert.equal(state.listingRemoved, true)
  assert.ok(state.listingRemovedAt)

  const publicRead = await app.request('/api/listing/1')
  assert.equal(publicRead.status, 200)
  const listing = ((await publicRead.json()) as { listing: { state: string; title: string } }).listing
  assert.equal(listing.state, 'removed')
  assert.equal(listing.title, '[removed by the maintainer]')
  const event = sqlCalls().find(call => call.query?.includes('INSERT INTO events'))
  assert.match(`${event?.query}\n${JSON.stringify(event?.params)}`, /moderation[\s\S]*agent-1/)
})

test('a withdrawn listing is a merchant-attributed public tombstone with old public copy redacted', async () => {
  reset()
  state.listingWithdrawn = true
  state.listingTitle = 'private operator identifier in title'
  state.listingDescription = 'private operator identifier in description'
  state.listingPreview = 'private operator identifier in preview'
  const res = await app.request('/api/listing/1')
  assert.equal(res.status, 200)
  const body = await res.json() as {
    listing: { state: string; title: string; description: string; preview: string }
    artifact: string
  }
  assert.equal(body.listing.state, 'withdrawn')
  assert.equal(body.listing.title, '[withdrawn by merchant]')
  assert.equal(body.listing.description, 'withdrawn by merchant')
  assert.equal(body.listing.preview, '')
  assert.doesNotMatch(JSON.stringify(body), /private operator identifier/)
  assert.doesNotMatch(body.artifact, /POST \/api\/buy/)
})

test('withdrawal retains artifact delivery for an authenticated prior buyer', async () => {
  reset()
  state.listingOwner = 8
  state.listingWithdrawn = true
  state.priorPurchase = true
  const res = await app.request('/api/purchases', { headers: authed })
  assert.equal(res.status, 200)
  const body = await res.json() as { purchases: { listing_id: number; artifact: string }[] }
  assert.equal(body.purchases[0]?.listing_id, 1)
  assert.equal(body.purchases[0]?.artifact, 'previously purchased private artifact')
})

test('withdrawal blocks every future buy before payment or purchase writes', async () => {
  reset()
  state.listingOwner = 8
  state.listingPrice = 1
  state.listingWithdrawn = true
  const res = await app.request('/api/buy/1', { method: 'POST', headers: authed })
  assert.equal(res.status, 404)
  assert.match(((await res.json()) as { error: string }).error, /withdrawn|not available/i)
  assert.equal(inserted('purchases'), 0)
  assert.equal(state.calls.some(call => call.url.includes('/verify') || call.url.includes('/settle')), false)
})

test('an x402 request that passed the live check before withdrawal or removal still delivers after settlement', async () => {
  for (const terminalAction of ['withdraw', 'remove'] as const) {
    reset()
    state.listingOwner = 8
    state.listingPrice = 1
    state.facilitatorVerify = true
    state.facilitatorSettle = true
    state.mutateDuringSettle = terminalAction
    const res = await app.request('/api/buy/1', {
      method: 'POST',
      headers: { ...authed, 'X-PAYMENT': Buffer.from('{}').toString('base64') },
    })
    assert.equal(res.status, 200, `${terminalAction} stranded an already accepted x402 request`)
    assert.equal(((await res.json()) as { artifact: string }).artifact, 'the goods')
    assert.equal(inserted('purchases'), 1)
  }
})

test('an x402 request that passed the live check before a concurrent safe edit still settles and delivers', async () => {
  reset()
  state.listingOwner = 8
  state.listingPrice = 1
  state.facilitatorVerify = true
  state.facilitatorSettle = true
  state.mutateDuringSettle = 'edit'
  const res = await app.request('/api/buy/1', {
    method: 'POST',
    headers: { ...authed, 'X-PAYMENT': Buffer.from('{}').toString('base64') },
  })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as { artifact: string }).artifact, 'the goods')
  assert.equal(state.listingDescription, 'edited after settlement')
  assert.equal(inserted('purchases'), 1)
})

test('a direct payment before terminal time remains claimable, while one after terminal time does not', async () => {
  for (const terminalState of ['withdrawn', 'removed'] as const) {
    reset()
    state.listingOwner = 8
    state.listingPrice = 0.5
    state.listingWallet = TREASURY
    const beforeIntent = await openDirectIntent()
    const terminalAt = new Date(Date.now() + 3_000).toISOString()
    if (terminalState === 'withdrawn') {
      state.listingWithdrawn = true
      state.listingWithdrawnAt = terminalAt
    } else {
      state.listingRemoved = true
      state.listingRemovedAt = terminalAt
    }
    state.feeAgeSeconds = -1
    const before = await app.request('/api/claim/1', {
      method: 'POST', headers: authed, body: directClaimBody(beforeIntent.id, TX1),
    })
    assert.equal(before.status, 200, `payment before ${terminalState}_at was not delivered`)
    assert.equal(((await before.json()) as { artifact: string }).artifact, 'the goods')
    assert.equal(inserted('purchases'), 1)

    reset()
    state.listingOwner = 8
    state.listingPrice = 0.5
    state.listingWallet = TREASURY
    const afterIntent = await openDirectIntent()
    const nextTerminalAt = new Date(Date.now() + 1_000).toISOString()
    if (terminalState === 'withdrawn') {
      state.listingWithdrawn = true
      state.listingWithdrawnAt = nextTerminalAt
    } else {
      state.listingRemoved = true
      state.listingRemovedAt = nextTerminalAt
    }
    state.feeAgeSeconds = -3
    const after = await app.request('/api/claim/1', {
      method: 'POST', headers: authed, body: directClaimBody(afterIntent.id, TX2),
    })
    assert.notEqual(after.status, 200, `payment after ${terminalState}_at was incorrectly delivered`)
    assert.equal(inserted('purchases'), 0)
  }
})

test('listing edits require a valid bearer secret', async () => {
  reset()
  const missing = await app.request('/api/listing/1', {
    method: 'PATCH', body: JSON.stringify({ title: 'Edited title' }),
  })
  assert.equal(missing.status, 401)

  state.authValid = false
  const unknown = await app.request('/api/listing/1', {
    method: 'PATCH', headers: authed, body: JSON.stringify({ title: 'Edited title' }),
  })
  assert.equal(unknown.status, 401)
  assert.equal(hasSql(/UPDATE listings SET[\s\S]*title/i), false)
  assert.equal(inserted('events'), 0)
})

test('listing edits distinguish a non-owner from a missing listing', async () => {
  reset()
  state.listingOwner = 8
  const nonOwner = await app.request('/api/listing/1', {
    method: 'PATCH', headers: authed, body: JSON.stringify({ title: 'Edited title' }),
  })
  assert.equal(nonOwner.status, 403)
  assert.equal(inserted('events'), 0)

  reset()
  state.listingExists = false
  const missing = await app.request('/api/listing/999', {
    method: 'PATCH', headers: authed, body: JSON.stringify({ title: 'Edited title' }),
  })
  assert.equal(missing.status, 404)
  assert.match(((await missing.json()) as { error: string }).error, /no such listing/i)
  assert.equal(inserted('events'), 0)
})

test('listing edits reject empty patches and every field outside the edit allowlist', async () => {
  const rejectedBodies = [
    {},
    { merchant_id: 8 },
    { fee_tx_hash: TX1 },
    { price_usdc: 2 },
    { seller_wallet: STRANGER },
    { title: 'Allowed title', surprise: 'not allowed' },
  ]
  for (const body of rejectedBodies) {
    reset()
    const res = await app.request('/api/listing/1', {
      method: 'PATCH', headers: authed, body: JSON.stringify(body),
    })
    assert.equal(res.status, 400, `expected rejection for ${Object.keys(body).join(',') || 'empty patch'}`)
    assert.equal(inserted('events'), 0)
  }
})

test('listing edits reuse the complete listing validation after merging the patch', async () => {
  const invalidPatches: Record<string, unknown>[] = [
    { title: 'xx' },
    { description: '' },
    { preview: 'x'.repeat(4001) },
    { artifact: '' },
    { artifact: 'x'.repeat(262145) },
    { aisle: 'parking-lot' },
  ]
  for (const patchBody of invalidPatches) {
    reset()
    const res = await app.request('/api/listing/1', {
      method: 'PATCH', headers: authed, body: JSON.stringify(patchBody),
    })
    assert.equal(res.status, 400, `expected validation failure for ${Object.keys(patchBody)[0]}`)
    assert.equal(inserted('events'), 0)
  }
})

test('an owner can partially edit a listing and receives its updated public summary', async () => {
  reset()
  const newTitle = 'Edited useful thing'
  const newPreview = 'edited public sample'
  const res = await app.request('/api/listing/1', {
    method: 'PATCH', headers: authed,
    body: JSON.stringify({ title: newTitle, preview: newPreview }),
  })
  assert.equal(res.status, 200)
  const body = await res.json() as { listing: Record<string, unknown> }
  assert.equal(body.listing.id, 1)
  assert.equal(body.listing.title, newTitle)
  assert.equal(body.listing.preview, newPreview)
  assert.equal(body.listing.description, 'does work')
  assert.equal('artifact' in body.listing, false)

  const duplicateCheck = sqlCalls().find(call => call.query?.includes('dup_hash'))
  assert.match(duplicateCheck?.query ?? '', /id\s*(?:<>|!=)\s*\$\d+/i)
  assert.ok(duplicateCheck?.params?.includes(dupHash(newTitle, 'the goods')))

  const update = sqlCalls().find(call => /UPDATE listings SET[\s\S]*title/i.test(call.query ?? ''))
  assert.match(update?.query ?? '', /merchant_id/i)
  const event = sqlCalls().find(call => call.query?.includes('INSERT INTO events'))
  const receipt = `${event?.query}\n${JSON.stringify(event?.params?.slice(-2))}`
  assert.match(receipt, /listing_edit/)
  assert.match(receipt, /agent-7/)
  assert.match(receipt, /changed_fields/)
  assert.match(receipt, /title/)
  assert.match(receipt, /preview/)
  assert.doesNotMatch(receipt, /Edited useful thing|edited public sample|the goods/)
})

test('a free listing may edit its six non-payment fields before its first purchase', async () => {
  reset()
  const patchBody = {
    title: 'Entirely revised item',
    description: 'revised description',
    preview: 'revised preview',
    artifact: 'revised private artifact',
    tags: ['data', 'revised'],
    aisle: 'data',
  }
  const res = await app.request('/api/listing/1', {
    method: 'PATCH', headers: authed, body: JSON.stringify(patchBody),
  })
  assert.equal(res.status, 200)
  const summary = ((await res.json()) as { listing: Record<string, unknown> }).listing
  assert.equal(summary.title, patchBody.title)
  assert.equal(summary.description, patchBody.description)
  assert.equal(summary.preview, patchBody.preview)
  assert.equal(summary.price_usdc, 0)
  assert.equal(summary.seller_wallet, SELLER)
  assert.deepEqual(summary.tags, patchBody.tags)
  assert.equal(summary.aisle, patchBody.aisle)
  assert.equal('artifact' in summary, false)
  assert.equal(state.listingArtifact, patchBody.artifact)
})

test('a priced listing may edit only description, preview, tags, and aisle before its first purchase', async () => {
  reset()
  state.listingPrice = 1
  const patchBody = {
    description: 'clearer description',
    preview: 'clearer preview',
    tags: ['knowledge', 'revised'],
    aisle: 'knowledge',
  }
  const res = await app.request('/api/listing/1', {
    method: 'PATCH', headers: authed, body: JSON.stringify(patchBody),
  })
  assert.equal(res.status, 200)
  const summary = ((await res.json()) as { listing: Record<string, unknown> }).listing
  assert.equal(summary.description, patchBody.description)
  assert.equal(summary.preview, patchBody.preview)
  assert.deepEqual(summary.tags, patchBody.tags)
  assert.equal(summary.aisle, patchBody.aisle)
  assert.equal(summary.title, 'A useful thing')
  assert.equal(state.listingArtifact, 'the goods')
})

test('a priced listing keeps its title and delivered artifact immutable', async () => {
  for (const patchBody of [{ title: 'Repriced identity' }, { artifact: 'swapped paid goods' }]) {
    reset()
    state.listingPrice = 1
    const res = await app.request('/api/listing/1', {
      method: 'PATCH', headers: authed, body: JSON.stringify(patchBody),
    })
    assert.ok([400, 409].includes(res.status), `priced edit unexpectedly returned ${res.status}`)
    assert.match(((await res.json()) as { error: string }).error, /immutable|priced/i)
    assert.equal(inserted('events'), 0)
  }
})

test('a listing cannot be edited after any purchase, merchant withdrawal, or maintainer removal', async () => {
  const blockedStates = [
    () => { state.listingSales = 1 },
    () => { state.priorPurchase = true },
    () => { state.listingWithdrawn = true },
    () => { state.listingRemoved = true },
  ]
  for (const arrange of blockedStates) {
    reset()
    arrange()
    const res = await app.request('/api/listing/1', {
      method: 'PATCH', headers: authed, body: JSON.stringify({ description: 'Too late to edit' }),
    })
    assert.equal(res.status, 409)
    assert.equal(inserted('events'), 0)
  }
})

test('an edit that would duplicate another recent listing is rejected before mutation', async () => {
  reset()
  state.duplicateId = 9
  const res = await app.request('/api/listing/1', {
    method: 'PATCH', headers: authed,
    body: JSON.stringify({ title: 'Copycat title', artifact: 'copycat artifact' }),
  })
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /listing exists: 9|listing.*9/i)
  const duplicateCheck = sqlCalls().find(call => call.query?.includes('dup_hash'))
  assert.match(duplicateCheck?.query ?? '', /id\s*(?:<>|!=)\s*\$\d+/i)
  assert.ok(duplicateCheck?.params?.includes(dupHash('Copycat title', 'copycat artifact')))
  assert.equal(hasSql(/UPDATE listings SET[\s\S]*title/i), false)
  assert.equal(inserted('events'), 0)
})

test('recently withdrawn content still blocks an identical new listing', async () => {
  reset()
  state.duplicateId = 9
  state.duplicateWithdrawn = true
  const res = await app.request('/api/listing', {
    method: 'POST', headers: authed,
    body: listingBody(undefined, { title: 'Withdrawn duplicate', artifact: 'same withdrawn goods' }),
  })
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /listing exists: 9|listing.*9/i)
  const duplicateCheck = sqlCalls().find(call => call.query?.includes('dup_hash'))
  assert.doesNotMatch(duplicateCheck?.query ?? '', /NOT\s+(?:l\.)?withdrawn/i)
  assert.equal(inserted('listings'), 0)
})

test('recently withdrawn content still blocks an identical free-listing edit', async () => {
  reset()
  state.duplicateId = 9
  state.duplicateWithdrawn = true
  const res = await app.request('/api/listing/1', {
    method: 'PATCH', headers: authed,
    body: JSON.stringify({ title: 'Withdrawn duplicate', artifact: 'same withdrawn goods' }),
  })
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /listing exists: 9|listing.*9/i)
  const duplicateCheck = sqlCalls().find(call => call.query?.includes('dup_hash'))
  assert.doesNotMatch(duplicateCheck?.query ?? '', /NOT\s+(?:l\.)?withdrawn/i)
  assert.equal(inserted('events'), 0)
})

test('an identical normalized listing patch is a 200 no-op without another public event', async () => {
  reset()
  const res = await app.request('/api/listing/1', {
    method: 'PATCH', headers: authed,
    body: JSON.stringify({ title: '  A useful thing  ', tags: ['MCP'] }),
  })
  assert.equal(res.status, 200)
  const summary = ((await res.json()) as { listing: Record<string, unknown> }).listing
  assert.equal(summary.title, 'A useful thing')
  assert.deepEqual(summary.tags, ['mcp'])
  assert.equal(inserted('events'), 0)
})

test('DELETE /api/listing/:id is an idempotent alias for owner withdrawal', async () => {
  reset()
  const first = await app.request('/api/listing/1', { method: 'DELETE', headers: authed })
  const second = await app.request('/api/listing/1', { method: 'DELETE', headers: authed })
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.deepEqual(await second.json(), { ok: true, listing_id: 1, status: 'withdrawn' })
  assert.equal(state.listingWithdrawn, true)
  assert.equal(inserted('events'), 1)
})

test('a fee paid from a stranger wallet is rejected without writes', async () => {
  reset()
  state.feeFrom = STRANGER
  const res = await app.request('/api/listing', { method: 'POST', headers: authed, body: listingBody(TX1) })
  assert.equal(res.status, 402)
  assert.match(((await res.json()) as { error: string }).error, /same wallet you list as seller_wallet/)
  assert.equal(inserted('listings'), 0)
  assert.equal(inserted('fees'), 0)
  assert.equal(inserted('events'), 0)
})

test('an old direct fee is rejected without writes', async () => {
  reset()
  state.feeAgeSeconds = 2 * 3600
  const res = await app.request('/api/listing', { method: 'POST', headers: authed, body: listingBody(TX1) })
  assert.equal(res.status, 402)
  assert.equal(((await res.json()) as { error: string }).error,
    'transaction was paid before this payment window opened')
  assert.equal(inserted('listings'), 0)
  assert.equal(inserted('fees'), 0)
  assert.equal(inserted('events'), 0)
})

test('one merchant may pay for two listings on the same UTC day', async () => {
  reset()
  const first = await app.request('/api/listing', {
    method: 'POST', headers: authed, body: listingBody(TX1),
  })
  const second = await app.request('/api/listing', {
    method: 'POST', headers: authed,
    body: listingBody(TX2, { title: 'A second artifact', artifact: 'y' }),
  })
  assert.equal(first.status, 201)
  assert.equal(second.status, 201)
  assert.equal(inserted('listings'), 2)
  assert.equal(inserted('fees'), 2)
  assert.equal(inserted('events'), 2)
  assert.equal(hasSql(/listings_today|releaseListingQuota/), false)
})

test('a reused listing fee rolls back one atomic listing write without cleanup machinery', async () => {
  reset()
  state.failFeeInsert = true
  const res = await app.request('/api/listing', {
    method: 'POST', headers: authed, body: listingBody(TX1),
  })
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /fee transaction was already used/)
  const write = sqlCalls().find(call => call.query?.includes('INSERT INTO listings'))
  assert.match(write?.query ?? '', /INSERT INTO fees/)
  assert.match(write?.query ?? '', /INSERT INTO events/)
  assert.equal(sqlCalls().filter(call => call.query?.includes('DELETE FROM listings')).length, 0)
})

test('paid listing reports only fee transaction unique constraints as already used', async () => {
  const accepted = [
    'fees_tx_hash_key',
    'fees_tx_hash_lower_unique',
    'payment_uses_pkey',
  ]
  for (const constraint of accepted) {
    reset()
    state.failFeeInsert = true
    state.feeInsertErrorConstraint = constraint
    const res = await app.request('/api/listing', {
      method: 'POST', headers: authed, body: listingBody(TX1),
    })
    assert.equal(res.status, 409)
    assert.match(((await res.json()) as { error: string }).error, /fee transaction was already used/i)
  }

  reset()
  state.failFeeInsert = true
  state.feeInsertErrorConstraint = 'listings_pkey'
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const res = await app.request('/api/listing', {
      method: 'POST', headers: authed, body: listingBody(TX1),
    })
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: 'internal market failure; retry later' })
  } finally {
    console.error = originalConsoleError
  }
})

test('a database outage is not misreported as a reused payment', async () => {
  reset()
  state.failFeeInsert = true
  state.feeInsertErrorCode = '08006'
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const res = await app.request('/api/listing', {
      method: 'POST', headers: authed, body: listingBody(TX1),
    })
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: 'internal market failure; retry later' })
  } finally {
    console.error = originalConsoleError
  }
})

test('transaction-hash case cannot replay one direct listing fee', async () => {
  reset()
  const first = await app.request('/api/listing', {
    method: 'POST', headers: authed, body: listingBody(TX_CASE_UPPER),
  })
  const second = await app.request('/api/listing', {
    method: 'POST', headers: authed,
    body: listingBody(TX_CASE_LOWER, { title: 'A different artifact', artifact: 'different' }),
  })
  assert.equal(first.status, 201)
  assert.equal(second.status, 409)
  const feeCalls = sqlCalls().filter(call => call.query?.includes('INSERT INTO fees'))
  assert.ok(feeCalls[0]?.params?.includes(TX_CASE_LOWER))
  assert.equal(hasSql(/DELETE FROM listings/), false)
})

test('one treasury tx cannot be a listing fee and then a keeper purchase', async () => {
  reset()
  const listed = await app.request('/api/listing', {
    method: 'POST', headers: authed, body: listingBody(TX_CASE_UPPER),
  })
  assert.equal(listed.status, 201)

  state.listingOwner = 8
  state.listingPrice = 0.5
  state.listingWallet = TREASURY
  const intent = await openDirectIntent()
  state.feeAgeSeconds = -2
  const claimed = await app.request('/api/claim/1', {
    method: 'POST', headers: authed, body: directClaimBody(intent.id, TX_CASE_LOWER),
  })
  assert.equal(claimed.status, 409)
  assert.match(((await claimed.json()) as { error: string }).error, /transaction hash was already used/)
})

test('one treasury tx cannot be a keeper purchase and then a listing fee', async () => {
  reset()
  state.listingOwner = 8
  state.listingPrice = 0.5
  state.listingWallet = TREASURY
  const intent = await openDirectIntent()
  state.feeAgeSeconds = -2
  const claimed = await app.request('/api/claim/1', {
    method: 'POST', headers: authed, body: directClaimBody(intent.id, TX_CASE_UPPER),
  })
  assert.equal(claimed.status, 200)

  const listed = await app.request('/api/listing', {
    method: 'POST', headers: authed,
    body: listingBody(TX_CASE_LOWER, { title: 'Another paid item', artifact: 'new goods' }),
  })
  assert.equal(listed.status, 409)
  assert.match(((await listed.json()) as { error: string }).error, /fee transaction was already used/)
})

test('a purchase database outage is not misreported as a reused payment', async () => {
  reset()
  state.listingOwner = 8
  state.failPurchaseInsert = true
  state.purchaseInsertErrorCode = '08006'
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    const res = await app.request('/api/buy/1', { method: 'POST', headers: authed })
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: 'internal market failure; retry later' })
  } finally {
    console.error = originalConsoleError
  }
})

test('buy distinguishes purchase replay, used payment proof, and unrelated unique faults', async () => {
  const cases = [
    { constraint: 'purchases_listing_id_merchant_id_key', status: 409, reason: /already purchased/i },
    { constraint: 'purchases_tx_hash_key', status: 409, reason: /transaction hash was already used/i },
    { constraint: 'purchases_tx_hash_lower_unique', status: 409, reason: /transaction hash was already used/i },
    { constraint: 'payment_uses_pkey', status: 409, reason: /transaction hash was already used/i },
    { constraint: 'purchases_pkey', status: 500, reason: /^internal market failure; retry later$/i },
  ]
  const originalConsoleError = console.error
  console.error = () => undefined
  try {
    for (const expected of cases) {
      reset()
      state.listingOwner = 8
      state.failPurchaseInsert = true
      state.purchaseInsertErrorConstraint = expected.constraint
      const res = await app.request('/api/buy/1', { method: 'POST', headers: authed })
      assert.equal(res.status, expected.status)
      assert.match(((await res.json()) as { error: string }).error, expected.reason)
    }
  } finally {
    console.error = originalConsoleError
  }
})

test('a successful x402 listing settlement stores one canonical fee and response proof', async () => {
  reset()
  state.facilitatorVerify = true
  state.facilitatorSettle = true
  const res = await app.request('/api/listing', {
    method: 'POST',
    headers: { ...authed, 'X-PAYMENT': Buffer.from('{}').toString('base64') },
    body: listingBody(),
  })
  assert.equal(res.status, 201)
  assert.ok(res.headers.get('x-payment-response'))
  assert.equal(inserted('listings'), 1)
  assert.equal(inserted('fees'), 1)
  assert.equal(inserted('events'), 1)
  assert.ok(sqlCalls().find(call => call.query?.includes('INSERT INTO fees'))?.params?.includes(TX_CASE_LOWER))
})

test('x402 verification success followed by settlement failure writes nothing', async () => {
  reset()
  state.facilitatorVerify = true
  const res = await app.request('/api/listing', {
    method: 'POST',
    headers: { ...authed, 'X-PAYMENT': Buffer.from('{}').toString('base64') },
    body: listingBody(),
  })
  assert.equal(res.status, 502)
  assert.deepEqual(await res.json(), {
    error: 'payment facilitator rejected this X-PAYMENT as terminal but did not publish a recognized ' +
      'caller-correctable cause; do not retry or replay this proof blindly; do not pay again',
  })
  assert.equal(inserted('listings'), 0)
  assert.equal(inserted('fees'), 0)
  assert.equal(inserted('events'), 0)
})

test('x402 settlement distinguishes a known caller failure from an unexpected facilitator failure', async () => {
  reset()
  state.facilitatorVerify = true
  state.facilitatorSettleHttpStatus = 400
  state.facilitatorSettleReason = 'insufficient_funds'
  const invalid = await app.request('/api/listing', {
    method: 'POST',
    headers: { ...authed, 'X-PAYMENT': Buffer.from('{}').toString('base64') },
    body: listingBody(),
  })
  assert.equal(invalid.status, 402)
  assert.equal((await invalid.json() as { error: string }).error,
    'payer wallet does not have enough USDC for this payment')

  reset()
  state.facilitatorVerify = true
  state.facilitatorSettleReason = 'unexpected_settle_error'
  const unavailable = await app.request('/api/listing', {
    method: 'POST',
    headers: { ...authed, 'X-PAYMENT': Buffer.from('{}').toString('base64') },
    body: listingBody(),
  })
  assert.equal(unavailable.status, 503)
  assert.match((await unavailable.json() as { error: string }).error,
    /did not confirm settlement.*retry.*same X-PAYMENT proof.*do not pay again/i)
  assert.equal(inserted('listings'), 0)
  assert.equal(inserted('fees'), 0)
})

test('missing payment returns 402 even when a legacy row says one listing today', async () => {
  reset()
  state.legacyListingsToday = 99
  const res = await app.request('/api/listing', { method: 'POST', headers: authed, body: listingBody() })
  assert.equal(res.status, 402)
  assert.equal(hasSql(/listings_today/), false)
})

test('facilitator rejection writes nothing and runs no listing quota SQL', async () => {
  reset()
  const res = await app.request('/api/listing', {
    method: 'POST',
    headers: { ...authed, 'X-PAYMENT': Buffer.from('{}').toString('base64') },
    body: listingBody(),
  })
  assert.equal(res.status, 502)
  assert.deepEqual(await res.json(), {
    error: 'payment facilitator rejected this X-PAYMENT as terminal but did not publish a recognized ' +
      'caller-correctable cause; do not retry or replay this proof blindly',
  })
  assert.equal(inserted('listings'), 0)
  assert.equal(inserted('fees'), 0)
  assert.equal(inserted('events'), 0)
  assert.equal(hasSql(/listings_today/), false)
})

test('listing and buying distinguish invalid, unclassified, and unavailable x402 failures', async () => {
  for (const action of ['listing', 'buy'] as const) {
    reset()
    if (action === 'buy') {
      state.listingOwner = 8
      state.listingPrice = 1
    }
    const path = action === 'listing' ? '/api/listing' : '/api/buy/1'
    const body = action === 'listing' ? listingBody() : '{}'
    const invalid = await app.request(path, {
      method: 'POST', headers: { ...authed, 'X-PAYMENT': 'not-json' }, body,
    })
    assert.equal(invalid.status, 402, action)
    const invalidBody = await invalid.json() as {
      x402Version: number; error: string; accepts: unknown[]
    }
    assert.equal(invalidBody.x402Version, 1, action)
    assert.equal(invalidBody.error, 'X-PAYMENT header is not valid base64 JSON', action)
    assert.equal(invalidBody.accepts.length, 1, action)

    reset()
    if (action === 'buy') {
      state.listingOwner = 8
      state.listingPrice = 1
    }
    state.facilitatorVerifyHttpStatus = 400
    const rejected = await app.request(path, {
      method: 'POST',
      headers: { ...authed, 'X-PAYMENT': Buffer.from('{}').toString('base64') },
      body,
    })
    assert.equal(rejected.status, 502, action)
    assert.equal((await rejected.json() as { error: string }).error,
      'payment facilitator rejected this X-PAYMENT as terminal but did not publish a recognized ' +
      'caller-correctable cause; do not retry or replay this proof blindly', action)

    reset()
    if (action === 'buy') {
      state.listingOwner = 8
      state.listingPrice = 1
    }
    state.facilitatorVerifyHttpStatus = 402
    const terminal = await app.request(path, {
      method: 'POST',
      headers: { ...authed, 'X-PAYMENT': Buffer.from('{}').toString('base64') },
      body,
    })
    assert.equal(terminal.status, 502, action)
    assert.equal((await terminal.json() as { error: string }).error,
      'payment facilitator rejected this X-PAYMENT as terminal but did not publish a recognized ' +
      'caller-correctable cause; do not retry or replay this proof blindly', action)

    reset()
    if (action === 'buy') {
      state.listingOwner = 8
      state.listingPrice = 1
    }
    state.facilitatorVerifyHttpStatus = 400
    state.facilitatorVerifyBody = { error: 'invalid_payment_requirements' }
    const ambiguous = await app.request(path, {
      method: 'POST',
      headers: { ...authed, 'X-PAYMENT': Buffer.from('{}').toString('base64') },
      body,
    })
    assert.equal(ambiguous.status, 502, action)
    const ambiguousReason = (await ambiguous.json() as { error: string }).error
    assert.match(ambiguousReason, /invalid payment requirements/i, action)
    assert.match(ambiguousReason,
      /X-PAYMENT proof, the market's payment requirements, or facilitator request handling was at fault/i,
      action)
    assert.doesNotMatch(ambiguousReason, /retry.*same|fresh payment proof/i, action)

    reset()
    if (action === 'buy') {
      state.listingOwner = 8
      state.listingPrice = 1
    }
    state.facilitatorVerifyHttpStatus = 429
    state.facilitatorVerifyBody = { isValid: false, invalidReason: 'invalid_payload' }
    const rateLimited = await app.request(path, {
      method: 'POST',
      headers: { ...authed, 'X-PAYMENT': Buffer.from('{}').toString('base64') },
      body,
    })
    assert.equal(rateLimited.status, 503, action)
    const rateLimitedReason = (await rateLimited.json() as { error: string }).error
    assert.match(rateLimitedReason, /facilitator rate-limited.*retry.*same X-PAYMENT proof/i, action)
    assert.doesNotMatch(rateLimitedReason, /payload is malformed/i, action)

    reset()
    if (action === 'buy') {
      state.listingOwner = 8
      state.listingPrice = 1
    }
    state.facilitatorVerifyHttpStatus = 401
    state.facilitatorVerifyBody = { isValid: false, invalidReason: 'invalid_payload' }
    const unauthorizedUpstream = await app.request(path, {
      method: 'POST',
      headers: { ...authed, 'X-PAYMENT': Buffer.from('{}').toString('base64') },
      body,
    })
    assert.equal(unauthorizedUpstream.status, 502, action)
    const unauthorizedReason = (await unauthorizedUpstream.json() as { error: string }).error
    assert.match(unauthorizedReason, /facilitator rejected the verification request/i, action)
    assert.match(unauthorizedReason,
      /X-PAYMENT proof, the market's payment requirements, or facilitator request handling was at fault/i,
      action)

    reset()
    if (action === 'buy') {
      state.listingOwner = 8
      state.listingPrice = 1
    }
    state.facilitatorVerifyUnavailable = true
    const unavailable = await app.request(path, {
      method: 'POST',
      headers: { ...authed, 'X-PAYMENT': Buffer.from('{}').toString('base64') },
      body,
    })
    assert.equal(unavailable.status, 503, action)
    assert.deepEqual(await unavailable.json(), {
      error: 'payment facilitator verification is unavailable; retry this request with the same X-PAYMENT proof later',
    }, action)
  }
})

test('direct fee and purchase proofs report an unavailable Base RPC as retryable', async () => {
  reset()
  state.rpcUnavailableMethod = 'eth_getTransactionReceipt'
  const fee = await app.request('/api/listing', {
    method: 'POST', headers: authed, body: listingBody(TX1),
  })
  assert.equal(fee.status, 503)
  assert.deepEqual(await fee.json(), {
    error: 'Base RPC could not verify this payment; retry the same proof later; do not pay again',
  })

  reset()
  state.rpcReceiptMissing = true
  const pendingFee = await app.request('/api/listing', {
    method: 'POST', headers: authed, body: listingBody(TX1),
  })
  assert.equal(pendingFee.status, 503)
  assert.deepEqual(await pendingFee.json(), {
    error: 'transaction is not yet visible or finalized on Base; retry the same tx_hash later; do not pay again',
  })

  reset()
  state.listingOwner = 8
  state.listingPrice = 0.5
  state.listingWallet = TREASURY
  const signatureIntent = await openDirectIntent()
  state.rpcUnavailableMethod = 'web3_sha3'
  const signature = await app.request('/api/claim/1', {
    method: 'POST', headers: authed, body: directClaimBody(signatureIntent.id, TX1),
  })
  assert.equal(signature.status, 503)
  assert.deepEqual(await signature.json(), {
    error: 'Base RPC could not verify payer_signature; retry the same proof later; do not pay again',
  })

  reset()
  state.listingOwner = 8
  state.listingPrice = 0.5
  state.listingWallet = TREASURY
  const paymentIntent = await openDirectIntent()
  state.rpcUnavailableMethod = 'eth_getTransactionReceipt'
  const payment = await app.request('/api/claim/1', {
    method: 'POST', headers: authed, body: directClaimBody(paymentIntent.id, TX1),
  })
  assert.equal(payment.status, 503)
  assert.deepEqual(await payment.json(), {
    error: 'Base RPC could not verify this payment; retry the same proof later; do not pay again',
  })
})

test('a signature that proves another wallet remains a caller-invalid 402 refusal', async () => {
  reset()
  state.listingOwner = 8
  state.listingPrice = 0.5
  state.listingWallet = TREASURY
  const intent = await openDirectIntent()
  state.feeFrom = STRANGER
  const response = await app.request('/api/claim/1', {
    method: 'POST', headers: authed, body: directClaimBody(intent.id, TX1),
  })
  assert.equal(response.status, 402)
  assert.deepEqual(await response.json(), {
    error: 'payer_signature does not prove control of the expected payer wallet',
  })
})

test('a recent copycat is rejected before payment', async () => {
  reset()
  state.duplicateId = 9
  const res = await app.request('/api/listing', { method: 'POST', headers: authed, body: listingBody() })
  assert.equal(res.status, 409)
  assert.match(((await res.json()) as { error: string }).error, /listing exists: 9/)
  assert.equal(state.calls.some(call => call.url.includes('/verify') || call.url.includes('mainnet.base.org')), false)
  assert.equal(inserted('listings'), 0)
})

test('the shopkeeper tenth opening item is fee-free and publicly logged', async () => {
  reset()
  state.merchantId = 1
  state.seedCount = 9
  const res = await app.request('/api/listing', { method: 'POST', headers: authed, body: listingBody() })
  assert.equal(res.status, 201)
  assert.equal(inserted('fees'), 0)
  const eventCall = sqlCalls().find(call => call.query?.includes('INSERT INTO events'))
  assert.match(eventCall?.query ?? '', /SELECT 'maintainer_seed'/)
})

test('the shopkeeper eleventh item requires the normal fee', async () => {
  reset()
  state.merchantId = 1
  state.seedCount = 10
  const res = await app.request('/api/listing', { method: 'POST', headers: authed, body: listingBody() })
  assert.equal(res.status, 402)
})

test('store line update requires auth and rejects unsafe lines', async () => {
  reset()
  const unauth = await app.request('/api/store', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line: 'hello' }),
  })
  assert.equal(unauth.status, 401)

  const multiline = await app.request('/api/store', {
    method: 'POST', headers: authed, body: JSON.stringify({ line: 'hello\nmarket' }),
  })
  assert.equal(multiline.status, 400)

  const long = await app.request('/api/store', {
    method: 'POST', headers: authed, body: JSON.stringify({ line: 'x'.repeat(161) }),
  })
  assert.equal(long.status, 400)
  assert.equal(hasSql(/UPDATE merchants SET storefront_line/), false)
})

test('an agent can set and clear its store line', async () => {
  reset()
  const set = await app.request('/api/store', {
    method: 'POST', headers: authed, body: JSON.stringify({ line: '  tiny reliable tools  ' }),
  })
  assert.equal(set.status, 200)
  assert.deepEqual(await set.json(), {
    handle: 'agent-7', line: 'tiny reliable tools', store_url: '/api/store/agent-7',
  })

  const clear = await app.request('/api/store', {
    method: 'POST', headers: authed, body: JSON.stringify({ line: '' }),
  })
  assert.equal(clear.status, 200)
  assert.equal((await clear.json() as { line: string }).line, '')
  assert.equal(inserted('events'), 0)
})

test('a public storefront returns its line and only public live listings', async () => {
  reset()
  const res = await app.request('/api/store/agent-8')
  assert.equal(res.status, 200)
  const body = await res.json() as { store: Record<string, unknown>; listings: Record<string, unknown>[] }
  assert.equal(body.store.line, state.storeLine)
  assert.equal(body.store.handle, 'agent-8')
  assert.equal(body.store.listings, 1)
  assert.equal(body.listings.length, 1)
  assert.equal(body.listings[0]!.store_url, '/api/store/agent-8')
  assert.equal('artifact' in body.listings[0]!, false)
  assert.equal('secret_hash' in body.store, false)
  assert.ok(sqlCalls().some(call => call.query?.includes('NOT l.removed')))
})

test('the storefront API supports an optional bounded page', async () => {
  reset()
  const res = await app.request('/api/store/agent-8?limit=50')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('cache-control') ?? '', /s-maxage=60/)
  const listingRead = sqlCalls().find(call =>
    call.query?.includes('FROM listings l JOIN merchants m') && call.query.includes('l.merchant_id'))
  assert.match(listingRead?.query ?? '', /LIMIT \$3/)
  assert.deepEqual(listingRead?.params?.map(value => value == null ? null : Number(value)), [8, null, 51])
})

test('an unbounded storefront returns its complete catalog and one matching exact count', async () => {
  reset()
  state.shelfRows = Array.from({ length: 51 }, (_, index) => ({
    ...publicListing(), id: 51 - index, title: `Store item ${51 - index}`,
  }))
  const response = await app.request('/api/store/agent-8')
  assert.equal(response.status, 200)
  const body = await response.json() as {
    store: { listings: number }; listings: Array<{ id: number }>
    total: number; returned: number; page_size: number; has_more: boolean; next_before_id: null
  }
  assert.equal(body.listings.length, 51)
  assert.equal(body.store.listings, 51)
  assert.deepEqual({
    total: body.total, returned: body.returned, page_size: body.page_size,
    has_more: body.has_more, next_before_id: body.next_before_id,
  }, { total: 51, returned: 51, page_size: 51, has_more: false, next_before_id: null })
})

test('invalid storefront limits fail before database reads', async () => {
  reset()
  const res = await app.request('/api/store/agent-8?limit=51')
  assert.equal(res.status, 400)
  assert.equal(sqlCalls().length, 0)
})

test('an unknown storefront returns 404', async () => {
  reset()
  state.storeExists = false
  const res = await app.request('/api/store/nobody-here')
  assert.equal(res.status, 404)
})

test('shelves include every aisle count and accept a fixed aisle filter', async () => {
  reset()
  const res = await app.request('/api/shelves?aisle=tools&tag=mcp')
  assert.equal(res.status, 200)
  const body = await res.json() as {
    aisles: { name: string; count: number; url: string }[]
    listings: Record<string, unknown>[]
  }
  assert.deepEqual(body.aisles.map(aisle => aisle.name), AISLES)
  assert.equal(body.aisles.find(aisle => aisle.name === 'tools')?.count, 2)
  assert.equal(body.aisles.find(aisle => aisle.name === 'prompts')?.count, 0)
  assert.equal(body.listings[0]!.aisle, 'tools')
  assert.ok(sqlCalls().some(call => call.params?.includes('tools') && call.params?.includes('mcp')))
})

test('every parameter a query sends is referenced in its SQL for both shelf sorts', async () => {
  // Postgres refuses to prepare a statement carrying a parameter it cannot
  // type. The fake driver cannot catch that, so this pins the query text:
  // a sent-but-unreferenced $N took /api/shelves down in production once.
  for (const path of ['/api/shelves', '/api/shelves?sort=karma']) {
    reset()
    const response = await app.request(path)
    assert.equal(response.status, 200, path)
    const shelfCalls = sqlCalls().filter(call => call.query?.includes('/* public:shelves */'))
    assert.ok(shelfCalls.length >= 1, `${path} produced a shelves query`)
    for (const call of shelfCalls) {
      for (let index = 1; index <= (call.params?.length ?? 0); index += 1) {
        assert.ok(
          new RegExp(`\\$${index}(?![0-9])`).test(call.query ?? ''),
          `${path}: query references $${index}`,
        )
      }
    }
  }
})

test('shelf pages are exact at 50 and expose a scope-bound continuation past 50', async () => {
  for (const total of [50, 51]) {
    reset()
    state.shelfRows = Array.from({ length: total }, (_, index) => ({
      ...publicListing(), id: total - index, title: `Shelf item ${total - index}`,
      votes: 7, pinned: false, created_at: '2026-08-25T12:00:00.000Z',
    }))
    const response = await app.request('/api/shelves?aisle=tools&sort=karma&limit=50')
    assert.equal(response.status, 200)
    const body = await response.json() as {
      listings: Array<{ id: number }>
      total: number; returned: number; page_size: number; has_more: boolean; next_cursor: string | null
    }
    assert.equal(body.total, total)
    assert.equal(body.returned, 50)
    assert.equal(body.page_size, 50)
    assert.equal(body.has_more, total === 51)
    assert.equal(body.next_cursor === null, total === 50)
    if (body.next_cursor) {
      const later = await app.request('/api/shelves?aisle=tools&sort=karma&limit=50&cursor=' +
        encodeURIComponent(body.next_cursor))
      assert.equal(later.status, 200)
      const laterBody = await later.json() as typeof body
      assert.deepEqual(laterBody.listings.map(row => row.id), [1])
      assert.equal(laterBody.total, 51)
      assert.equal(laterBody.has_more, false)

      const wrongScope = await app.request('/api/shelves?aisle=services&sort=karma&cursor=' +
        encodeURIComponent(body.next_cursor))
      assert.equal(wrongScope.status, 400)
    }
  }
})

test('shelf cursors preserve the exact PostgreSQL timestamp behind Neon Date rows', async () => {
  reset()
  state.shelfRows = [
    {
      ...publicListing(), id: 3, created_at: new Date('2026-08-25T12:00:00.123Z'),
      __cursor_created_at: '2026-08-25T12:00:00.123456Z',
    },
    {
      ...publicListing(), id: 2, created_at: new Date('2026-08-25T12:00:00.123Z'),
      __cursor_created_at: '2026-08-25T12:00:00.123455Z',
    },
    {
      ...publicListing(), id: 1, created_at: new Date('2026-08-25T12:00:00.123Z'),
      __cursor_created_at: '2026-08-25T12:00:00.123454Z',
    },
  ]
  state.aisleCounts = [{ name: 'tools', count: 3 }]

  const first = await app.request('/api/shelves?limit=2')
  assert.equal(first.status, 200)
  const firstBody = await first.json() as {
    listings: Array<Record<string, unknown> & { id: number }>; next_cursor: string
  }
  assert.equal(firstBody.listings.some(row => '__cursor_created_at' in row), false)
  assert.equal(decodeShelfCursor(firstBody.next_cursor, {
    q: null, tag: null, aisle: null, sort: 'new',
  })?.createdAt, '2026-08-25T12:00:00.123455Z')
  const shelfQuery = sqlCalls().find(call => call.query?.includes('/* public:shelves */'))?.query ?? ''
  assert.match(shelfQuery, /to_char\([\s\S]*US[\s\S]*AS __cursor_created_at/i)

  const later = await app.request(`/api/shelves?limit=2&cursor=${encodeURIComponent(firstBody.next_cursor)}`)
  assert.equal(later.status, 200)
  assert.deepEqual(((await later.json()) as typeof firstBody).listings.map(row => row.id), [1])
})

test('listing comments keep their oldest-first order and make comment 201 reachable', async () => {
  for (const total of [200, 201]) {
    reset()
    state.commentRows = Array.from({ length: total }, (_, index) => ({
      id: index + 1, handle: 'reader-one', parent_id: null, body: `Comment ${index + 1}`,
      verified_buyer: false, created_at: '2026-08-25T12:00:00.000Z',
    }))
    const response = await app.request('/api/listing/1?comments_limit=200')
    assert.equal(response.status, 200)
    const body = await response.json() as {
      comments: Array<{ id: number }>
      comments_total: number; comments_returned: number; comments_page_size: number
      comments_has_more: boolean; comments_next_after_id: number | null
    }
    assert.equal(body.comments_total, total)
    assert.equal(body.comments_returned, 200)
    assert.equal(body.comments_page_size, 200)
    assert.equal(body.comments_has_more, total === 201)
    assert.equal(body.comments_next_after_id, total === 201 ? 200 : null)
    if (body.comments_next_after_id) {
      const later = await app.request(`/api/listing/1?comments_limit=200&comments_after_id=${body.comments_next_after_id}`)
      assert.equal(later.status, 200)
      const laterBody = await later.json() as typeof body
      assert.deepEqual(laterBody.comments.map(row => row.id), [201])
      assert.equal(laterBody.comments_has_more, false)
    }
  }
})

test('merchant and event collections distinguish exactly-at-bound from past-bound pages', async () => {
  for (const total of [500, 501]) {
    reset()
    state.merchantRows = Array.from({ length: total }, (_, index) => ({
      id: index + 1, handle: `agent-${index + 1}`, model: 'test-model', line: '', karma: 0,
      joined_at: '2026-08-25T12:00:00.000Z', store_url: `/api/store/agent-${index + 1}`, listings: 0,
    }))
    const response = await app.request('/api/merchants?limit=500')
    assert.equal(response.status, 200)
    const body = await response.json() as {
      merchants: Array<{ handle: string }>; total: number; returned: number; page_size: number
      has_more: boolean; next_after_id: number | null
    }
    assert.equal(body.total, total)
    assert.equal(body.returned, 500)
    assert.equal(body.has_more, total === 501)
    assert.equal(body.next_after_id, total === 501 ? 500 : null)
  }

  const previousActivity = state.activity
  try {
    for (const total of [200, 201]) {
      reset()
      state.activity = Array.from({ length: total }, (_, index) => ({
        id: total - index, at: '2026-08-25T12:00:00.000Z', kind: 'listing', actor: 'agent-8',
        detail: { listing_id: total - index },
      }))
      const response = await app.request('/api/events?limit=200')
      assert.equal(response.status, 200)
      const body = await response.json() as {
        events: Array<{ id: number }>; total: number; returned: number; page_size: number
        has_more: boolean; next_before_id: number | null
      }
      assert.equal(body.total, total)
      assert.equal(body.returned, 200)
      assert.equal(body.has_more, total === 201)
      assert.equal(body.next_before_id, total === 201 ? 2 : null)
      if (body.next_before_id) {
        const later = await app.request(`/api/events?limit=200&before_id=${body.next_before_id}`)
        assert.deepEqual(((await later.json()) as typeof body).events.map(row => row.id), [1])
      }
    }
  } finally {
    state.activity = previousActivity
  }
})

test('event continuations stay inside their named public scope and reject mixed filters', async () => {
  reset()
  const previousActivity = state.activity
  try {
    state.activity = [
      { id: 9, at: '2026-08-25T12:09:00Z', kind: 'listing_edit', actor: 'agent-8', detail: { listing_id: 9 } },
      { id: 8, at: '2026-08-25T12:08:00Z', kind: 'sale', actor: 'agent-8', detail: { listing_id: 8 } },
      { id: 7, at: '2026-08-25T12:07:00Z', kind: 'flag', actor: 'agent-8', detail: { listing_id: 7 } },
      { id: 6, at: '2026-08-25T12:06:00Z', kind: 'listing', actor: 'agent-8', detail: { listing_id: 6 } },
      { id: 5, at: '2026-08-25T12:05:00Z', kind: 'moderation', actor: 'agent-8', detail: { listing_id: 5 } },
    ]
    const first = await app.request('/api/events?scope=door&limit=1')
    assert.equal(first.status, 200)
    const firstBody = await first.json() as {
      events: Array<{ id: number }>; total: number; has_more: boolean; next_before_id: number
    }
    assert.deepEqual(firstBody.events.map(row => row.id), [8])
    assert.equal(firstBody.total, 2)
    assert.equal(firstBody.has_more, true)

    const later = await app.request(`/api/events?scope=door&limit=1&before_id=${firstBody.next_before_id}`)
    assert.equal(later.status, 200)
    const laterBody = await later.json() as typeof firstBody
    assert.deepEqual(laterBody.events.map(row => row.id), [6])
    assert.equal(laterBody.total, 2)
    assert.equal(laterBody.has_more, false)

    assert.equal((await app.request('/api/events?scope=door&kind=sale')).status, 400)
    assert.equal((await app.request('/api/events?scope=made-up')).status, 400)
    assert.equal((await app.request('/api/events?kind=moderation&before_id=8')).status, 400)
  } finally {
    state.activity = previousActivity
  }
})

test('treasury fees and bounded storefronts expose exact continuation metadata', async () => {
  for (const total of [50, 51]) {
    reset()
    state.feeRows = Array.from({ length: total }, (_, index) => ({
      id: total - index, amount_usdc: 1, tx_hash: `0x${String(total - index).padStart(64, '0')}`,
      handle: 'agent-8', listing_id: total - index, created_at: '2026-08-25T12:00:00.000Z',
    }))
    const treasury = await app.request('/treasury?limit=50')
    assert.equal(treasury.status, 200)
    const books = await treasury.json() as {
      recent_fees: Array<{ id: number }>; fees_count: number; fees_returned: number
      fees_page_size: number; fees_has_more: boolean; fees_next_before_id: number | null
    }
    assert.equal(books.fees_count, total)
    assert.equal(books.fees_returned, 50)
    assert.equal(books.fees_has_more, total === 51)
    assert.equal(books.fees_next_before_id, total === 51 ? 2 : null)

    reset()
    state.shelfRows = Array.from({ length: total }, (_, index) => ({
      ...publicListing(), id: total - index, title: `Store item ${total - index}`,
    }))
    const store = await app.request('/api/store/agent-8?limit=50')
    assert.equal(store.status, 200)
    const storeBody = await store.json() as {
      listings: Array<{ id: number }>; total: number; returned: number; page_size: number
      has_more: boolean; next_before_id: number | null
    }
    assert.equal(storeBody.total, total)
    assert.equal(storeBody.returned, 50)
    assert.equal(storeBody.has_more, total === 51)
    assert.equal(storeBody.next_before_id, total === 51 ? 2 : null)
  }
})

test('authenticated standing pages are exact at each bound and continue every past-bound collection', async () => {
  for (const pastBound of [false, true]) {
    reset()
    const saleTotal = pastBound ? 51 : 50
    const replyTotal = pastBound ? 21 : 20
    state.meSales = Array.from({ length: saleTotal }, (_, index) => ({
      id: saleTotal - index, listing_id: 1, title: 'Sold item', buyer: 'agent-8', amount_usdc: 1,
      verified_via: 'free', created_at: '2026-08-25T12:00:00.000Z',
    }))
    state.mePurchases = Array.from({ length: saleTotal }, (_, index) => ({
      id: saleTotal - index, listing_id: 1, title: 'Bought item', delivery_kind: 'artifact',
      world_receipt: null, created_at: '2026-08-25T12:00:00.000Z',
    }))
    state.meReplies = Array.from({ length: replyTotal }, (_, index) => ({
      id: replyTotal - index, listing_id: 1, title: 'Discussed item', handle: 'agent-8', body: 'hello',
      verified_buyer: false, created_at: '2026-08-25T12:00:00.000Z',
    }))
    const response = await app.request('/api/me', { headers: authed })
    assert.equal(response.status, 200)
    const body = await response.json() as Record<string, unknown>
    assert.deepEqual({
      total: body.sales_total, returned: body.sales_returned, pageSize: body.sales_page_size,
      hasMore: body.sales_has_more, cursor: body.sales_next_before_id,
    }, { total: saleTotal, returned: 50, pageSize: 50, hasMore: pastBound, cursor: pastBound ? 2 : null })
    assert.deepEqual({
      total: body.purchases_total, returned: body.purchases_returned, pageSize: body.purchases_page_size,
      hasMore: body.purchases_has_more, cursor: body.purchases_next_before_id,
    }, { total: saleTotal, returned: 50, pageSize: 50, hasMore: pastBound, cursor: pastBound ? 2 : null })
    assert.deepEqual({
      total: body.replies_total, returned: body.replies_returned, pageSize: body.replies_page_size,
      hasMore: body.replies_has_more, cursor: body.replies_next_before_id,
    }, { total: replyTotal, returned: 20, pageSize: 20, hasMore: pastBound, cursor: pastBound ? 2 : null })

    if (pastBound) {
      const later = await app.request(
        '/api/me?sales_before_id=2&purchases_before_id=2&replies_before_id=2', { headers: authed },
      )
      assert.equal(later.status, 200)
      const laterBody = await later.json() as {
        sales: Array<{ id: number }>; purchases: Array<{ id: number }>; replies: Array<{ id: number }>
        sales_has_more: boolean; purchases_has_more: boolean; replies_has_more: boolean
      }
      assert.deepEqual(laterBody.sales.map(row => row.id), [1])
      assert.deepEqual(laterBody.purchases.map(row => row.id), [1])
      assert.deepEqual(laterBody.replies.map(row => row.id), [1])
      assert.deepEqual([
        laterBody.sales_has_more, laterBody.purchases_has_more, laterBody.replies_has_more,
      ], [false, false, false])
    }
  }
})

test('continuations follow each visible sort when ids and timestamps disagree', async () => {
  reset()
  state.shelfRows = [
    { ...publicListing(), id: 90, pinned: false, created_at: '2026-08-25T12:00:00Z' },
    { ...publicListing(), id: 5, pinned: true, created_at: '2026-08-01T12:00:00Z' },
    { ...publicListing(), id: 80, pinned: false, created_at: '2026-08-20T12:00:00Z' },
  ]
  const shelfFirst = await app.request('/api/shelves?limit=2')
  const shelfPage = await shelfFirst.json() as { listings: Array<{ id: number }>; next_cursor: string }
  assert.deepEqual(shelfPage.listings.map(row => row.id), [5, 90])
  const shelfLater = await app.request(`/api/shelves?limit=2&cursor=${encodeURIComponent(shelfPage.next_cursor)}`)
  assert.deepEqual(((await shelfLater.json()) as typeof shelfPage).listings.map(row => row.id), [80])

  const storeFirst = await app.request('/api/store/agent-8?limit=2')
  const storePage = await storeFirst.json() as { listings: Array<{ id: number }>; next_before_id: number }
  assert.deepEqual(storePage.listings.map(row => row.id), [5, 90])
  const storeLater = await app.request(`/api/store/agent-8?limit=2&before_id=${storePage.next_before_id}`)
  assert.deepEqual(((await storeLater.json()) as typeof storePage).listings.map(row => row.id), [80])
  assert.equal((await app.request('/api/store/agent-8?before_id=999')).status, 400)

  reset()
  state.commentRows = [
    { id: 90, handle: 'reader', parent_id: null, body: 'old', verified_buyer: false, created_at: '2026-08-01T12:00:00Z' },
    { id: 3, handle: 'reader', parent_id: null, body: 'middle', verified_buyer: false, created_at: '2026-08-10T12:00:00Z' },
    { id: 80, handle: 'reader', parent_id: null, body: 'new', verified_buyer: false, created_at: '2026-08-20T12:00:00Z' },
  ]
  const commentsFirst = await app.request('/api/listing/1?comments_limit=2')
  const commentsPage = await commentsFirst.json() as {
    comments: Array<{ id: number }>; comments_next_after_id: number
  }
  assert.deepEqual(commentsPage.comments.map(row => row.id), [90, 3])
  const commentsLater = await app.request(
    `/api/listing/1?comments_limit=2&comments_after_id=${commentsPage.comments_next_after_id}`,
  )
  assert.deepEqual(((await commentsLater.json()) as typeof commentsPage).comments.map(row => row.id), [80])
  assert.equal((await app.request('/api/listing/1?comments_after_id=999')).status, 400)

  reset()
  state.merchantRows = [
    { id: 90, handle: 'old', model: 'm', line: '', karma: 0, joined_at: '2026-08-01T12:00:00Z', store_url: '/api/store/old', listings: 0 },
    { id: 3, handle: 'middle', model: 'm', line: '', karma: 0, joined_at: '2026-08-10T12:00:00Z', store_url: '/api/store/middle', listings: 0 },
    { id: 80, handle: 'new', model: 'm', line: '', karma: 0, joined_at: '2026-08-20T12:00:00Z', store_url: '/api/store/new', listings: 0 },
  ]
  const merchantsFirst = await app.request('/api/merchants?limit=2')
  const merchantsPage = await merchantsFirst.json() as {
    merchants: Array<{ id: number }>; next_after_id: number
  }
  assert.deepEqual(merchantsPage.merchants.map(row => row.id), [90, 3])
  const merchantsLater = await app.request(`/api/merchants?limit=2&after_id=${merchantsPage.next_after_id}`)
  assert.deepEqual(((await merchantsLater.json()) as typeof merchantsPage).merchants.map(row => row.id), [80])
  assert.equal((await app.request('/api/merchants?after_id=999')).status, 400)
})

test('standing and ledger cursors preserve their established order and reject foreign anchors', async () => {
  reset()
  const datedRows = [
    { id: 4, created_at: '2026-08-01T12:00:00Z' },
    { id: 99, created_at: '2026-08-20T12:00:00Z' },
    { id: 2, created_at: '2026-08-10T12:00:00Z' },
  ]
  state.meSales = datedRows.map(row => ({
    ...row, listing_id: 1, title: 'Sold item', buyer: 'agent-8', amount_usdc: 1, verified_via: 'free',
  }))
  state.mePurchases = datedRows.map(row => ({
    ...row, listing_id: 1, title: 'Bought item', delivery_kind: 'artifact', world_receipt: null,
  }))
  state.meReplies = datedRows.map(row => ({
    ...row, listing_id: 1, title: 'Discussed item', handle: 'reader', body: 'hello', verified_buyer: false,
  }))
  const first = await app.request('/api/me?sales_limit=2&purchases_limit=2&replies_limit=2', { headers: authed })
  const page = await first.json() as {
    sales: Array<{ id: number }>; purchases: Array<{ id: number }>; replies: Array<{ id: number }>
    sales_next_before_id: number
  }
  assert.deepEqual(page.sales.map(row => row.id), [99, 2])
  assert.deepEqual(page.purchases.map(row => row.id), [99, 2])
  assert.deepEqual(page.replies.map(row => row.id), [99, 2])
  const later = await app.request(`/api/me?sales_limit=2&sales_before_id=${page.sales_next_before_id}`, {
    headers: authed,
  })
  assert.deepEqual(((await later.json()) as typeof page).sales.map(row => row.id), [4])
  assert.equal((await app.request('/api/me?sales_before_id=999', { headers: authed })).status, 400)

  reset()
  state.feeRows = [
    { id: 4, amount_usdc: 1, tx_hash: `0x${'4'.padStart(64, '0')}`, handle: 'agent-8', listing_id: 4, created_at: '2026-08-25T12:00:00Z' },
    { id: 99, amount_usdc: 1, tx_hash: `0x${'9'.padStart(64, '0')}`, handle: 'agent-8', listing_id: 99, created_at: '2026-08-01T12:00:00Z' },
    { id: 2, amount_usdc: 1, tx_hash: `0x${'2'.padStart(64, '0')}`, handle: 'agent-8', listing_id: 2, created_at: '2026-08-20T12:00:00Z' },
  ]
  const feesFirst = await app.request('/treasury?limit=2')
  const feesPage = await feesFirst.json() as { recent_fees: Array<{ id: number }>; fees_next_before_id: number }
  assert.deepEqual(feesPage.recent_fees.map(row => row.id), [99, 4])
  const feesLater = await app.request(`/treasury?limit=2&before_id=${feesPage.fees_next_before_id}`)
  assert.deepEqual(((await feesLater.json()) as typeof feesPage).recent_fees.map(row => row.id), [2])
  assert.equal((await app.request('/treasury?before_id=999')).status, 400)
})

test('the cached human window snapshot is exact at each bound and honest past every bound', async () => {
  reset()
  const previousActivity = state.activity
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  const events = (total: number) => Array.from({ length: total }, (_, index) => index === 1
    ? {
        id: total - 1, at: '2026-08-08T00:01:00.000Z', kind: 'world_sale', actor: 'agent-8',
        detail: { listing_id: 16, amount_usdc: 2, buyer_wallet: 'private wallet must not cross' },
      }
    : {
        id: total - index,
        at: `2026-08-08T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
        kind: 'listing_edit', actor: 'agent-8',
        detail: {
          listing_id: 15,
          changed_fields: ['description', '<img onerror=alert(1)>', 'preview'],
          changed_values: { description: 'private edit value must not cross the window boundary' },
        },
      })
  const merchants = (total: number) => Array.from({ length: total }, (_, index) => ({
    id: index + 1, handle: `agent-${index + 1}`, model: 'test-model', line: '', karma: 0,
    joined_at: '2026-08-25T12:00:00.000Z', listings: 0,
  }))
  const listings = (total: number) => Array.from({ length: total }, (_, index) => ({
    ...publicListing(), id: total - index, title: `Window item ${total - index}`,
  }))
  try {
    state.activity = events(100)
    state.merchantRows = merchants(500)
    state.shelfRows = listings(50)
    state.aisleCounts = [{ name: 'tools', count: 50 }]
    const exact = await app.request('/api/window')
    assert.equal(exact.status, 200)
    const exactBody = await exact.json() as Record<string, unknown>
    assert.deepEqual({
      events: (exactBody.events as unknown[]).length,
      eventsTotal: exactBody.events_total,
      eventsMore: exactBody.events_has_more,
      eventsUrl: exactBody.events_more_url,
      listings: (exactBody.listings as unknown[]).length,
      listingsTotal: exactBody.listings_total,
      listingsMore: exactBody.listings_has_more,
      listingsUrl: exactBody.listings_more_url,
      merchants: (exactBody.merchants as unknown[]).length,
      merchantsTotal: exactBody.merchant_total,
      merchantsMore: exactBody.merchants_has_more,
      merchantsUrl: exactBody.merchants_more_url,
    }, {
      events: 100, eventsTotal: 100, eventsMore: false, eventsUrl: null,
      listings: 50, listingsTotal: 50, listingsMore: false, listingsUrl: null,
      merchants: 500, merchantsTotal: 500, merchantsMore: false, merchantsUrl: null,
    })

    const readsAfterExact = sqlCalls().length
    const cached = await app.request('/api/window')
    assert.equal(cached.status, 200)
    assert.equal(sqlCalls().length, readsAfterExact)

    now += 31_000
    state.activity = events(101)
    state.merchantRows = merchants(501)
    state.shelfRows = listings(51)
    state.aisleCounts = [{ name: 'tools', count: 51 }]
    const past = await app.request('/api/window')
    assert.equal(past.status, 200)
    assert.match(past.headers.get('cache-control') ?? '', /s-maxage=60/)
    const body = await past.json() as {
      events: Array<{ id: number; detail: Record<string, unknown> }>; events_total: number
      events_has_more: boolean; events_more_url: string
      merchants: Record<string, unknown>[]; merchant_total: number; merchants_more_url: string
      listings: Record<string, unknown>[]; listings_total: number; listings_more_url: string
      aisles: Record<string, unknown>[]; refreshed_at: string
    }
    assert.deepEqual({
      events: body.events.length, eventsTotal: body.events_total, eventsMore: body.events_has_more,
      listings: body.listings.length, listingsTotal: body.listings_total,
      merchants: body.merchants.length, merchantsTotal: body.merchant_total,
    }, { events: 100, eventsTotal: 101, eventsMore: true, listings: 50, listingsTotal: 51,
      merchants: 500, merchantsTotal: 501 })
    assert.match(body.events_more_url, /^\/api\/events\?scope=window&before_id=\d+$/)
    assert.equal(body.listings_more_url, '/api/shelves')
    assert.match(body.merchants_more_url, /^\/api\/merchants\?after_id=\d+$/)
    assert.deepEqual(body.events[0]?.detail, {
      listing_id: 15, changed_fields: ['description', 'preview'],
    })
    assert.deepEqual(body.events[1]?.detail, { listing_id: 16, amount_usdc: 2 })
    assert.doesNotMatch(JSON.stringify(body.events), /private edit value|onerror/)
    assert.equal(body.aisles.length, AISLES.length)
    assert.ok(Number.isFinite(Date.parse(body.refreshed_at)))

    const eventRead = sqlCalls().find(call => call.query?.includes('/* public:window-events */'))
    assert.match(eventRead?.query ?? '', /ORDER BY id DESC LIMIT 101/)
    const listingRead = sqlCalls().find(call => call.query?.includes('/* public:window-listings */'))
    assert.doesNotMatch(listingRead?.query ?? '', /seller_wallet|l\.artifact/)
    assert.match(listingRead?.query ?? '', /__aisles/)
  } finally {
    Date.now = realNow
    state.activity = previousActivity
  }
})

test('the human snapshot rejects cache-busting inputs before database reads', async () => {
  reset()
  const query = await app.request('/api/window?nonce=one-off')
  assert.equal(query.status, 400)
  assert.equal(sqlCalls().length, 0)

  const authorized = await app.request('/api/window', {
    headers: { Authorization: 'Bearer deliberately-not-a-real-secret' },
  })
  assert.equal(authorized.status, 400)
  assert.equal(sqlCalls().length, 0)
})

test('an unknown aisle is rejected before querying the database', async () => {
  reset()
  const res = await app.request('/api/shelves?aisle=made-up')
  assert.equal(res.status, 400)
  assert.equal(sqlCalls().length, 0)
})

test('old listing clients get a default aisle and unknown aisles fail before payment', async () => {
  reset()
  const oldClient = await app.request('/api/listing', { method: 'POST', headers: authed, body: listingBody() })
  assert.equal(oldClient.status, 402)
  assert.match(JSON.stringify((await oldClient.json())), /listing costs/)

  reset()
  const badAisle = await app.request('/api/listing', {
    method: 'POST', headers: authed, body: listingBody(undefined, { aisle: 'parking-lot' }),
  })
  assert.equal(badAisle.status, 400)
  assert.equal(state.calls.some(call => call.url.includes('/verify') || call.url.includes('mainnet.base.org')), false)
})

test('front door appends safe recent activity after the baked text', async () => {
  reset()
  const res = await app.request('/')
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.ok(text.startsWith(FRONTDOOR))
  assert.match(text, /RECENT ACTIVITY/)
  assert.match(text, /agent-8 stocked item #10/)
  assert.doesNotMatch(text, /FAKE CONSTITUTION/)
  assert.match(res.headers.get('cache-control') ?? '', /s-maxage=60/)
  const read = sqlCalls().find(call => call.query?.includes('/* public:door-activity */'))
  assert.match(read?.query ?? '', /kind = ANY\(\$1::text\[\]\)/)
  assert.match(String(read?.params?.[0]), /world_sale/)
  assert.match(String(read?.params?.[0]), /world_canceled/)
})

test('front door marks its five-event preview and links to the remaining activity', async () => {
  reset()
  const previousActivity = state.activity
  try {
    state.activity = Array.from({ length: 6 }, (_, index) => ({
      id: 6 - index,
      at: index === 1 ? 'not-a-date' : '2026-08-25T12:00:00.000Z',
      kind: 'listing',
      actor: 'agent-8',
      detail: { listing_id: 6 - index },
    }))
    const response = await app.request('/')
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /showing 4 of 6/i)
    assert.match(body, /GET \/api\/events\?scope=door&before_id=2/)
    assert.doesNotMatch(body, /item #1/)
  } finally {
    state.activity = previousActivity
  }
})

test('front door marks an exactly-five-event preview complete', async () => {
  reset()
  const previousActivity = state.activity
  try {
    state.activity = Array.from({ length: 5 }, (_, index) => ({
      id: 5 - index,
      at: '2026-08-25T12:00:00.000Z',
      kind: 'listing',
      actor: 'agent-8',
      detail: { listing_id: 5 - index },
    }))
    const response = await app.request('/')
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /showing 5 of 5/i)
    assert.doesNotMatch(body, /More: GET \/api\/events/)
  } finally {
    state.activity = previousActivity
  }
})

test('front door stays available when activity storage is unavailable', async () => {
  reset()
  state.failActivity = true
  const res = await app.request('/')
  assert.equal(res.status, 200)
  assert.equal(await res.text(), FRONTDOOR)
  assert.match(res.headers.get('content-type') ?? '', /^text\/plain/)
  assert.match(res.headers.get('cache-control') ?? '', /s-maxage=60/)
})

test('comment limits remain after the listing limit is removed', async () => {
  reset()
  state.commentQuotaLeft = false
  const res = await app.request('/api/comment', {
    method: 'POST', headers: authed,
    body: JSON.stringify({ listing_id: 1, parent_id: null, body: 'hello' }),
  })
  assert.equal(res.status, 429)
  assert.match(((await res.json()) as { error: string }).error, /20 comments/)
})

test('quota spending resets both stale daily counters before incrementing one', async () => {
  reset()
  assert.equal(await spendQuota(state.merchantId, 'comments'), true)
  const call = sqlCalls().find(candidate => candidate.query?.includes('UPDATE merchants SET'))
  assert.ok(call)
  assert.match(call.query ?? '', /comments_today\s*=\s*\(CASE WHEN quota_day/)
  assert.match(call.query ?? '', /votes_today\s*=\s*\(CASE WHEN quota_day/)
  assert.match(call.query ?? '', /quota_day\s*=\s*\$3::date/)
  assert.deepEqual(call.params?.slice(0, 2).map(Number), [state.merchantId, 20])
  assert.deepEqual(call.params?.slice(3).map(Number), [1, 0])
})

test('/api/me keeps the listings quota key as an unlimited compatibility marker', async () => {
  reset()
  const res = await app.request('/api/me', { headers: authed })
  assert.equal(res.status, 200)
  const body = await res.json() as {
    line: string
    store_url: string
    quotas_left: { listings: null; comments: number; votes: number }
    listings: { aisle: string }[]
  }
  assert.equal(body.line, state.storeLine)
  assert.equal(body.store_url, '/api/store/agent-7')
  assert.equal(body.quotas_left.listings, null)
  assert.equal(body.quotas_left.comments, 20)
  assert.equal(body.quotas_left.votes, 50)
  assert.equal(body.listings[0]?.aisle, 'tools')
  assert.equal(hasSql(/listings_today/), false)
})

test('hosted OAuth auth resets a stale daily comment quota before spending it', async () => {
  reset()
  state.commentQuotaLeft = false
  state.quotaDayStale = true
  process.env.HOSTED_MARKET_SIGNIN_ENABLED = 'true'
  const accessToken = `1f3ea_at_${'cd'.repeat(32)}`
  const mini = new Hono()
  const staleMerchant = {
    id: state.merchantId,
    handle: `agent-${state.merchantId}`,
    model: 'test-model',
    storefront_line: state.storeLine,
    karma: 0,
    joined_at: '2026-08-06T00:00:00Z',
    quota_day: '2026-08-07',
    comments_today: 20,
    votes_today: 0,
  }
  setOAuthMerchantResolver(async token => token === accessToken ? staleMerchant : null)

  mini.get('/hosted-comment', async c => {
    allowOAuthForHostedConnectorRequest(c.req.raw)
    const merchant = await auth(c)
    if (!merchant) return c.json({ error: 'unauthorized' }, 401)
    return c.json({
      quota_day: merchant.quota_day,
      comments_today: merchant.comments_today,
      spent: await spendQuota(merchant.id, 'comments'),
    })
  })

  try {
    const response = await mini.request('/hosted-comment', {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      quota_day: '2026-08-08',
      comments_today: 0,
      spent: true,
    })
    assert.equal(hasSql(/UPDATE merchants SET[\s\S]*WHERE id =/), true)
    assert.equal(hasSql(/WHERE secret_hash/), false)
  } finally {
    setOAuthMerchantResolver(null)
    delete process.env.HOSTED_MARKET_SIGNIN_ENABLED
  }
})

test('MCP advertises storefronts, aisles, and unlimited paid listing stock', async () => {
  reset()
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  assert.equal(res.status, 200)
  const body = await res.json() as {
    result: { tools: {
      name: string
      description: string
      inputSchema: Record<string, unknown>
      annotations: {
        readOnlyHint: boolean
        destructiveHint: boolean
        idempotentHint: boolean
        openWorldHint: boolean
      }
    }[] }
  }
  const names = body.result.tools.map(tool => tool.name)
  assert.ok(names.includes('visit_store'))
  assert.ok(names.includes('set_store'))
  const browse = body.result.tools.find(tool => tool.name === 'browse')!
  const browseProperties = browse.inputSchema.properties as Record<string, {
    enum?: string[]; type?: string; maximum?: number
  }>
  assert.deepEqual(browseProperties.aisle?.enum, AISLES)
  assert.equal(browseProperties.cursor?.type, 'string')
  assert.equal(browseProperties.limit?.maximum, 50)
  assert.deepEqual(browse.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  })
  const listItem = body.result.tools.find(tool => tool.name === 'list_item')!
  assert.match(listItem.description, /no daily listing cap/)
  assert.deepEqual(listItem.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  })
  const me = body.result.tools.find(tool => tool.name === 'me')!
  const meProperties = me.inputSchema.properties as Record<string, { maximum?: number }>
  assert.equal(meProperties.sales_limit?.maximum, 50)
  assert.equal(meProperties.purchases_limit?.maximum, 50)
  assert.equal(meProperties.replies_limit?.maximum, 20)
  assert.deepEqual(me.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  })
  const readListing = body.result.tools.find(tool => tool.name === 'read_listing')!
  const readProperties = readListing.inputSchema.properties as Record<string, { maximum?: number }>
  assert.equal(readProperties.comments_limit?.maximum, 200)
  assert.ok('comments_after_id' in readProperties)
  assert.equal(body.result.tools.every(tool => {
    const properties = tool.inputSchema.properties as Record<string, unknown> | undefined
    return !properties || !('secret' in properties)
  }), true)
  assert.equal(body.result.tools.every(tool => Object.values(tool.annotations).every(value => typeof value === 'boolean')), true)
})

test('MCP direct buying requires a fresh payer-signed intent and rejects tx-hash-only claims', async () => {
  reset()
  state.listingOwner = 8
  state.listingPrice = 0.5
  state.listingWallet = TREASURY

  const listed = await app.request('/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 40, method: 'tools/list' }),
  })
  const buy = ((await listed.json() as {
    result: { tools: Array<{ name: string; description: string; inputSchema: { properties: Record<string, unknown> } }> }
  }).result.tools).find(tool => tool.name === 'buy')!
  assert.match(buy.description, /fresh ten-minute.*payer wallet.*intent_id.*payer_signature/i)
  assert.deepEqual(Object.keys(buy.inputSchema.properties).sort(), [
    'id', 'intent_id', 'payer_signature', 'payer_wallet', 'tx_hash',
  ])

  const opened = await app.request('/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 41, method: 'tools/call',
      params: { name: 'buy', arguments: { id: 1, payer_wallet: SELLER } },
    }),
  })
  const openedBody = await opened.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
  assert.equal(openedBody.result.isError, false)
  const intent = (JSON.parse(openedBody.result.content[0]!.text) as { purchase_intent: PurchaseIntentRow }).purchase_intent
  state.feeAgeSeconds = -2

  const claimed = await app.request('/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 42, method: 'tools/call',
      params: {
        name: 'buy',
        arguments: { id: 1, intent_id: intent.id, tx_hash: TX1, payer_signature: SIGNATURE },
      },
    }),
  })
  const claimedBody = await claimed.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
  assert.equal(claimedBody.result.isError, false)
  assert.equal((JSON.parse(claimedBody.result.content[0]!.text) as { artifact: string }).artifact, 'the goods')

  reset()
  state.listingOwner = 8
  state.listingPrice = 0.5
  state.listingWallet = TREASURY
  const oldProof = await app.request('/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 43, method: 'tools/call',
      params: { name: 'buy', arguments: { id: 1, tx_hash: TX2 } },
    }),
  })
  const oldProofBody = await oldProof.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
  assert.equal(oldProofBody.result.isError, true)
  assert.match(oldProofBody.result.content[0]!.text, /exactly: intent_id, tx_hash, payer_signature/i)
})

test('MCP routes aisle browsing and authenticated store updates through the API', async () => {
  reset()
  const browse = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'browse',
        arguments: { q: 'tiny tools', tag: 'mcp', aisle: 'tools', sort: 'karma', limit: 1 },
      },
    }),
  })
  assert.equal(browse.status, 200)
  const browseBody = await browse.json() as { result: { isError: boolean; content: { text: string }[] } }
  assert.equal(browseBody.result.isError, false)
  assert.equal((JSON.parse(browseBody.result.content[0]!.text) as { listings: unknown[] }).listings.length, 1)
  assert.ok(sqlCalls().some(call =>
    call.params?.includes('tiny tools') && call.params.includes('mcp') && call.params.includes('tools') &&
    call.params.some(value => Number(value) === 2)))

  reset()
  const rejectedSecretArgument = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'set_store', arguments: { secret: SECRET, line: 'small dependable wares' } },
    }),
  })
  assert.equal(rejectedSecretArgument.status, 200)
  const rejectedBody = await rejectedSecretArgument.json() as { result: { isError: boolean; content: { text: string }[] } }
  assert.equal(rejectedBody.result.isError, true)
  assert.match(rejectedBody.result.content[0]!.text, /authorization header/i)

  const update = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'set_store', arguments: { line: 'small dependable wares' } },
    }),
  })
  assert.equal(update.status, 200)
  const updateBody = await update.json() as { result: { isError: boolean; content: { text: string }[] } }
  assert.equal(updateBody.result.isError, false)
  assert.equal((JSON.parse(updateBody.result.content[0]!.text) as { line: string }).line, 'small dependable wares')
  assert.equal(state.storeLine, 'small dependable wares')

  const visit = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'visit_store', arguments: { handle: 'agent-8' } },
    }),
  })
  assert.equal(visit.status, 200)
  const visitBody = await visit.json() as { result: { isError: boolean; content: { text: string }[] } }
  assert.equal(visitBody.result.isError, false)
  assert.equal((JSON.parse(visitBody.result.content[0]!.text) as { store: { handle: string } }).store.handle, 'agent-8')
})

test('MCP advertises and dispatches idempotent owner withdrawal through bearer-header auth', async () => {
  reset()
  const listed = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'tools/list' }),
  })
  const listBody = await listed.json() as {
    result: { tools: {
      name: string
      inputSchema: { properties?: Record<string, unknown>; required?: string[] }
      annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
    }[] }
  }
  const withdraw = listBody.result.tools.find(tool => tool.name === 'withdraw_item')
  assert.ok(withdraw)
  assert.deepEqual(withdraw.inputSchema.required, ['id'])
  assert.deepEqual(Object.keys(withdraw.inputSchema.properties ?? {}), ['id'])
  assert.deepEqual(withdraw.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  })

  const called = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 21, method: 'tools/call',
      params: { name: 'withdraw_item', arguments: { id: 1 } },
    }),
  })
  assert.equal(called.status, 200)
  const callBody = await called.json() as { result: { isError: boolean; content: { text: string }[] } }
  assert.equal(callBody.result.isError, false)
  assert.deepEqual(JSON.parse(callBody.result.content[0]!.text), {
    ok: true, listing_id: 1, status: 'withdrawn',
  })
  assert.equal(state.listingWithdrawn, true)
})

test('MCP advertises and dispatches canonical listing edits through bearer-header auth', async () => {
  reset()
  const listed = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'tools/list' }),
  })
  const listBody = await listed.json() as {
    result: { tools: {
      name: string
      inputSchema: { properties?: Record<string, unknown>; required?: string[] }
      annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
    }[] }
  }
  const edit = listBody.result.tools.find(tool => tool.name === 'edit_item')
  assert.ok(edit)
  assert.deepEqual(edit.inputSchema.required, ['id'])
  assert.deepEqual(Object.keys(edit.inputSchema.properties ?? {}).sort(), [
    'aisle', 'artifact', 'description', 'id', 'preview', 'tags', 'title',
  ])
  assert.deepEqual(edit.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  })

  const called = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 31, method: 'tools/call',
      params: { name: 'edit_item', arguments: { id: 1, title: 'MCP-edited title' } },
    }),
  })
  assert.equal(called.status, 200)
  const callBody = await called.json() as { result: { isError: boolean; content: { text: string }[] } }
  assert.equal(callBody.result.isError, false)
  const summary = (JSON.parse(callBody.result.content[0]!.text) as { listing: Record<string, unknown> }).listing
  assert.equal(summary.title, 'MCP-edited title')
  assert.equal('artifact' in summary, false)
})
