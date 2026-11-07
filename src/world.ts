import { HANDLE_RE, WALLET_RE } from './core.ts'
import { MARKET_LIMITS } from './market-facts.ts'
import { canonicalTxHash } from './pay.ts'

const DEFAULT_CITY_ORIGIN = 'https://1f3d9.com'
const PUBLIC_READ_TIMEOUT_MS = MARKET_LIMITS.publicRead.cityTimeoutMs
const PUBLIC_RECORD_MAX_BYTES = MARKET_LIMITS.publicRead.cityMaxBytes

function configuredOrigin(value: string): string {
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash)
    throw new Error('CITY_ORIGIN must be a bare https origin')
  return parsed.origin
}

/** Trusted deployment configuration, never request input. */
export const CITY_ORIGIN = configuredOrigin(process.env.CITY_ORIGIN ?? DEFAULT_CITY_ORIGIN)

/** This market's own public origin, the one every city offer must name. */
export const MARKET_ORIGIN = process.env.PUBLIC_ORIGIN ?? 'https://1f3ea.com'

export interface WorldDraftInput {
  title: string
  description: string
  preview: string
  price_usdc: number
  seller_wallet: string
  tags: string[]
  thing_id: number
}

export interface WorldActivationInput {
  draft_id: number
  city_offer_id: number
  fee_tx_hash?: string
}

export interface WorldCheckoutInput {
  city_handle: string
}

export type CityOfferPhase =
  | 'listed'
  | 'reserved'
  | 'payment_pending'
  | 'payment_invalid'
  | 'payment_expired'
  | 'founder_review'
  | 'claimed'
  | 'canceled'
  | 'thing_ended'

export type CityAssetState = 'active' | 'remnant' | 'withdrawn'

const CITY_OFFER_PHASES: readonly CityOfferPhase[] = [
  'listed',
  'reserved',
  'payment_pending',
  'payment_invalid',
  'payment_expired',
  'founder_review',
  'claimed',
  'canceled',
  'thing_ended',
]

const CITY_ASSET_STATES: readonly CityAssetState[] = ['active', 'remnant', 'withdrawn']

export interface CityOffer {
  id: number
  channel: string
  phase: CityOfferPhase
  asset_type: string
  asset_id: number
  asset_name: string
  locked: boolean
  seller: string
  buyer: string | null
  market_buyer: string | null
  price_usdc: number
  seller_wallet: string
  market_origin: string
  market_draft_id: number
  market_listing_id: number | null
  market_checkout_id: number | null
  reserved_at: string | null
  reserved_until: string | null
  created_at: string
  claimed_at: string | null
  canceled_at: string | null
  tx_hash?: string | null
  buyer_wallet?: string | null
  verified_via?: string | null
  block_time?: string | null
  from?: string | null
  to?: string | null
  receipt?: Record<string, unknown> | null
  pending_x402_tx_hash: string | null
  pending_x402_at: string | null
  asset_state?: CityAssetState
  ending?: Record<string, unknown> | null
  end_program_summary?: string | null
  ending_checked_at?: string | null
}

export interface DraftBinding {
  id: number
  thing_id: number
  price_usdc: number
  seller_wallet: string
}

export interface ListingBinding {
  id: number
  world_offer_id: number
  world_asset_id: number
  world_draft_id: number
  world_seller_handle: string
  price_usdc: number
  seller_wallet: string
}

/** A world card binding; public reads that never select the draft or wallet omit them. */
export type WorldCardBinding = Omit<ListingBinding, 'world_draft_id' | 'seller_wallet'> &
  Partial<Pick<ListingBinding, 'world_draft_id' | 'seller_wallet'>>

const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]) => {
  const keys = Object.keys(value).sort()
  const expected = [...allowed].sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

const exactOptionalKeys = (
  value: Record<string, unknown>, required: readonly string[], optional: readonly string[],
) => {
  const keys = Object.keys(value)
  return required.every(key => keys.includes(key)) &&
    keys.every(key => required.includes(key) || optional.includes(key))
}

const positiveId = (value: unknown) => {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

const normalizedTags = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null
  if (value.some(tag => typeof tag !== 'string')) return null
  return [...new Set(value.map(tag => tag.toLowerCase().trim()).filter(Boolean))]
    .map(tag => tag.slice(0, MARKET_LIMITS.listing.tagMaxChars)).slice(0, MARKET_LIMITS.listing.tagsMaxCount)
}

export function validWorldDraft(body: unknown): WorldDraftInput | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be JSON'
  const value = body as Record<string, unknown>
  const fields = ['title', 'description', 'preview', 'price_usdc', 'seller_wallet', 'tags', 'thing_id'] as const
  if (!exactKeys(value, fields)) return `body must contain exactly: ${fields.join(', ')}`
  const title = typeof value.title === 'string' ? value.title.trim() : ''
  const description = typeof value.description === 'string' ? value.description.trim() : ''
  const preview = typeof value.preview === 'string' ? value.preview.trim() : ''
  const price = Number(value.price_usdc)
  const wallet = typeof value.seller_wallet === 'string' ? value.seller_wallet : ''
  const tags = normalizedTags(value.tags)
  const thingId = positiveId(value.thing_id)
  if (title.length < MARKET_LIMITS.listing.titleMinChars || title.length > MARKET_LIMITS.listing.titleMaxChars) return `title: ${MARKET_LIMITS.listing.titleMinChars}-${MARKET_LIMITS.listing.titleMaxChars} chars`
  if (!description || description.length > MARKET_LIMITS.listing.descriptionMaxChars) return `description: ${MARKET_LIMITS.listing.descriptionMinChars}-${MARKET_LIMITS.listing.descriptionMaxChars} chars`
  if (preview.length > MARKET_LIMITS.listing.previewMaxChars) return `preview: max ${MARKET_LIMITS.listing.previewMaxChars} chars`
  if (!Number.isFinite(price) || price <= MARKET_LIMITS.listing.worldPriceExclusiveMinUsdc || price > MARKET_LIMITS.listing.priceMaxUsdc) return `price_usdc must be greater than ${MARKET_LIMITS.listing.worldPriceExclusiveMinUsdc} and at most ${MARKET_LIMITS.listing.priceMaxUsdc}`
  if (!WALLET_RE.test(wallet)) return 'seller_wallet: 0x + 40 hex chars (an address on Base)'
  if (!tags) return 'tags must be an array of strings'
  if (!thingId) return 'thing_id must be a positive integer'
  return {
    title,
    description,
    preview,
    price_usdc: Math.round(price * 10 ** MARKET_LIMITS.listing.priceDecimals) / 10 ** MARKET_LIMITS.listing.priceDecimals,
    seller_wallet: wallet,
    tags,
    thing_id: thingId,
  }
}

export function validWorldActivation(body: unknown): WorldActivationInput | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be JSON'
  const value = body as Record<string, unknown>
  const required = ['draft_id', 'city_offer_id'] as const
  if (!exactOptionalKeys(value, required, ['fee_tx_hash']))
    return 'body must contain exactly: draft_id, city_offer_id, and optional fee_tx_hash'
  const draftId = positiveId(value.draft_id)
  const offerId = positiveId(value.city_offer_id)
  const feeTxHash = value.fee_tx_hash == null ? undefined : canonicalTxHash(value.fee_tx_hash)
  if (!draftId) return 'draft_id must be a positive integer'
  if (!offerId) return 'city_offer_id must be a positive integer'
  if (value.fee_tx_hash != null && !feeTxHash) return 'fee_tx_hash: 0x + 64 hex chars'
  return { draft_id: draftId, city_offer_id: offerId, fee_tx_hash: feeTxHash ?? undefined }
}

export function validWorldCheckout(body: unknown): WorldCheckoutInput | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be JSON'
  const value = body as Record<string, unknown>
  if (!exactKeys(value, ['city_handle'])) return 'body must contain exactly: city_handle'
  const handle = typeof value.city_handle === 'string' ? value.city_handle.toLowerCase().trim() : ''
  if (!HANDLE_RE.test(handle)) return 'city_handle must match ^[a-z0-9][a-z0-9-]{2,31}$'
  return { city_handle: handle }
}

function sameMoney(left: unknown, right: unknown): boolean {
  const a = Number(left)
  const b = Number(right)
  return Number.isFinite(a) && Number.isFinite(b) && Math.round(a * 1e6) === Math.round(b * 1e6)
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const validDate = (candidate: unknown) =>
  typeof candidate === 'string' && !Number.isNaN(new Date(candidate).getTime())

const validNullableDate = (candidate: unknown) => candidate === null || validDate(candidate)

// The four ending fields arrive with the city's thing-endings release. Today's
// city omits them, so each is checked only when present.
function validEndingFields(offer: Record<string, unknown>): boolean {
  return (!('asset_state' in offer) || CITY_ASSET_STATES.includes(offer.asset_state as CityAssetState)) &&
    (!('ending' in offer) || offer.ending === null || isPlainObject(offer.ending)) &&
    (!('end_program_summary' in offer) || offer.end_program_summary === null ||
      typeof offer.end_program_summary === 'string') &&
    (!('ending_checked_at' in offer) || validNullableDate(offer.ending_checked_at))
}

function validOfferCore(value: unknown): value is CityOffer {
  if (!isPlainObject(value)) return false
  const offer = value
  const pendingHash = offer.pending_x402_tx_hash == null
    ? null
    : canonicalTxHash(offer.pending_x402_tx_hash)
  const paymentEvidencePhase = [
    'payment_pending',
    'payment_invalid',
    'payment_expired',
    'founder_review',
  ].includes(String(offer.phase))
  return Boolean(positiveId(offer.id)) && typeof offer.channel === 'string' &&
    CITY_OFFER_PHASES.includes(offer.phase as CityOfferPhase) &&
    typeof offer.asset_type === 'string' &&
    Boolean(positiveId(offer.asset_id)) && typeof offer.asset_name === 'string' &&
    typeof offer.locked === 'boolean' && typeof offer.seller === 'string' &&
    (offer.buyer === null || typeof offer.buyer === 'string') &&
    (offer.market_buyer === null ||
      (typeof offer.market_buyer === 'string' && HANDLE_RE.test(offer.market_buyer))) &&
    Number.isFinite(Number(offer.price_usdc)) &&
    typeof offer.seller_wallet === 'string' && typeof offer.market_origin === 'string' &&
    Boolean(positiveId(offer.market_draft_id)) &&
    (offer.market_listing_id === null || Boolean(positiveId(offer.market_listing_id))) &&
    (offer.market_checkout_id === null || Boolean(positiveId(offer.market_checkout_id))) &&
    (offer.pending_x402_tx_hash == null || pendingHash != null) &&
    validDate(offer.created_at) && validNullableDate(offer.reserved_at) &&
    validNullableDate(offer.reserved_until) && validNullableDate(offer.claimed_at) &&
    validNullableDate(offer.canceled_at) && validNullableDate(offer.pending_x402_at) &&
    ((offer.pending_x402_tx_hash == null) === (offer.pending_x402_at == null)) &&
    (!paymentEvidencePhase || (
      offer.locked === true && pendingHash != null && offer.pending_x402_at != null
    )) &&
    // thing_ended means the thing is due or ended with no payment evidence recorded.
    (offer.phase !== 'thing_ended' || pendingHash == null) &&
    validEndingFields(offer)
}

export function cityOfferMatchesDraft(
  value: unknown, draft: DraftBinding, expectedOfferId: number, marketOrigin: string,
): string | null {
  if (!validOfferCore(value)) return 'city offer record is malformed'
  const offer = value as CityOffer
  if (offer.id !== expectedOfferId || offer.channel !== 'world') return 'city offer id or channel does not match'
  if (offer.phase !== 'listed') return 'city offer is not listed'
  if (!offer.locked) return 'city thing is not locked'
  if (offer.asset_type !== 'thing' || offer.asset_id !== draft.thing_id) return 'city thing does not match the draft'
  if (!HANDLE_RE.test(offer.seller)) return 'city seller handle is invalid'
  if (offer.buyer !== null || offer.market_buyer !== null ||
      offer.market_listing_id !== null || offer.market_checkout_id !== null)
    return 'city offer must still be unbound'
  if (!sameMoney(offer.price_usdc, draft.price_usdc)) return 'city offer price does not match the draft'
  if (!WALLET_RE.test(offer.seller_wallet) || offer.seller_wallet.toLowerCase() !== draft.seller_wallet.toLowerCase())
    return 'city offer seller wallet does not match the draft'
  if (offer.market_origin !== marketOrigin) return 'city offer market origin does not match'
  if (offer.market_draft_id !== draft.id) return 'city offer market draft does not match'
  return null
}

function cityOfferCardMismatch(
  value: unknown, listing: WorldCardBinding, marketOrigin: string,
): string | null {
  if (!validOfferCore(value)) return 'city offer record is malformed'
  const offer = value as CityOffer
  if (offer.id !== listing.world_offer_id || offer.channel !== 'world') return 'city offer id or channel does not match'
  if (offer.asset_type !== 'thing' || offer.asset_id !== listing.world_asset_id) return 'city thing does not match the listing'
  if (listing.world_draft_id !== undefined && offer.market_draft_id !== listing.world_draft_id)
    return 'city offer draft does not match the listing'
  if (offer.market_listing_id !== null && offer.market_listing_id !== listing.id)
    return 'city offer market listing does not match'
  if (offer.market_origin !== marketOrigin) return 'city offer market origin does not match'
  if (offer.seller !== listing.world_seller_handle) return 'city seller does not match the listing'
  if (!sameMoney(offer.price_usdc, listing.price_usdc)) return 'city offer price does not match the listing'
  if (listing.seller_wallet !== undefined && (!WALLET_RE.test(offer.seller_wallet) ||
      offer.seller_wallet.toLowerCase() !== listing.seller_wallet.toLowerCase()))
    return 'city offer seller wallet does not match the listing'
  return null
}

/**
 * The checkout and sync match. Unlike a card, it never skips the draft or wallet check:
 * a binding read without either is refused, so a narrower SELECT cannot weaken it.
 */
export function cityOfferMatchesListing(
  value: unknown, listing: ListingBinding, marketOrigin: string,
): string | null {
  if (typeof listing.world_draft_id !== 'number') return 'city offer draft does not match the listing'
  if (typeof listing.seller_wallet !== 'string') return 'city offer seller wallet does not match the listing'
  return cityOfferCardMismatch(value, listing, marketOrigin)
}

export function isCityOfferAvailable(value: unknown, now = new Date()): boolean {
  if (!validOfferCore(value)) return false
  const offer = value as CityOffer
  void now
  return offer.locked && offer.phase === 'listed' && offer.buyer === null &&
    offer.market_buyer === null && offer.market_checkout_id === null &&
    offer.reserved_at === null && offer.reserved_until === null &&
    (offer.asset_state === undefined || offer.asset_state === 'active')
}

export type PublicRecordResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'not_found' | 'unavailable' | 'invalid'; message: string }

const RECORD_TOO_LARGE = 'city public record is too large'

async function publicJson(path: string): Promise<PublicRecordResult<Record<string, unknown>>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PUBLIC_READ_TIMEOUT_MS)
  try {
    const response = await fetch(`${CITY_ORIGIN}${path}`, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (response.status === 404) return { ok: false, kind: 'not_found', message: 'city record not found' }
    if (!response.ok) return { ok: false, kind: 'unavailable', message: 'city public records are unavailable' }
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > PUBLIC_RECORD_MAX_BYTES)
      return { ok: false, kind: 'invalid', message: RECORD_TOO_LARGE }
    const text = await response.text()
    if (text.length === 0)
      return { ok: false, kind: 'invalid', message: 'city returned an empty public record' }
    if (new TextEncoder().encode(text).byteLength > PUBLIC_RECORD_MAX_BYTES)
      return { ok: false, kind: 'invalid', message: RECORD_TOO_LARGE }
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch {
      return { ok: false, kind: 'invalid', message: 'city returned invalid JSON' }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { ok: false, kind: 'invalid', message: 'city returned a malformed public record' }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch {
    return { ok: false, kind: 'unavailable', message: 'city public records are unavailable' }
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchCityOffer(id: number): Promise<PublicRecordResult<CityOffer>> {
  const response = await publicJson(`/api/world/offer/${id}`)
  if (!response.ok) return response
  if (!validOfferCore(response.value.offer))
    return { ok: false, kind: 'invalid', message: 'city returned a malformed offer record' }
  return { ok: true, value: response.value.offer as CityOffer }
}

/** The city's batch read (GET /api/world/offers?ids=) answers at most this many ids at once. */
export const CITY_OFFER_BATCH_MAX = 50

type OfferResult = PublicRecordResult<CityOffer>

const MALFORMED_OFFER: OfferResult = { ok: false, kind: 'invalid', message: 'city returned a malformed offer record' }
const MALFORMED_OFFER_LIST: OfferResult = { ok: false, kind: 'invalid', message: 'city returned a malformed offer list' }

// One batch entry is a public offer, or {id, status} for a hidden or missing offer.
// null means the entry breaks the list contract, which fails the whole page.
function batchEntry(value: unknown, id: number): OfferResult | null {
  if (!isPlainObject(value) || value.id !== id) return null
  if (!('status' in value)) return validOfferCore(value) ? { ok: true, value: value as CityOffer } : MALFORMED_OFFER
  if (Object.keys(value).length !== 2) return null
  if (value.status === 'maintainer_hidden') return { ok: false, kind: 'not_found', message: 'city offer is not public' }
  if (value.status === 'not_found') return { ok: false, kind: 'not_found', message: 'city record not found' }
  return null
}

async function fetchOfferPage(ids: readonly number[]): Promise<Array<[number, OfferResult]>> {
  const response = await publicJson(`/api/world/offers?ids=${ids.join(',')}`)
  if (!response.ok && response.message === RECORD_TOO_LARGE && ids.length > 1) {
    // One city read stays within the stated byte limit, so an oversized page is read in halves.
    const half = Math.floor(ids.length / 2)
    const first = await fetchOfferPage(ids.slice(0, half))
    return [...first, ...await fetchOfferPage(ids.slice(half))]
  }
  const offers = response.ok ? response.value.offers : null
  const entries = Array.isArray(offers) && offers.length === ids.length
    ? ids.map((id, index) => batchEntry(offers[index], id))
    : null
  if (entries && entries.every(entry => entry !== null))
    return ids.map((id, index) => [id, entries[index] as OfferResult])
  const failure = response.ok ? MALFORMED_OFFER_LIST : response
  return ids.map(id => [id, failure])
}

/** Reads many city offers fresh, never cached; every distinct requested id gets an entry. */
export async function fetchCityOffers(ids: readonly number[]): Promise<Map<number, OfferResult>> {
  const distinct = [...new Set(ids)]
  const pages = Array.from({ length: Math.ceil(distinct.length / CITY_OFFER_BATCH_MAX) },
    (_, index) => distinct.slice(index * CITY_OFFER_BATCH_MAX, (index + 1) * CITY_OFFER_BATCH_MAX))
  const answered = await Promise.all(pages.map(fetchOfferPage))
  return new Map(answered.flat())
}

/** The fresh city status a world card carries; checkout is open only when every check passes. */
export interface WorldCardCityStatus {
  state: 'current' | 'unavailable'
  phase: CityOfferPhase | null
  asset_state: CityAssetState | null
  ending: Record<string, unknown> | null
  end_program_summary: string | null
  ending_checked_at: string | null
  checkout_open: boolean
}

const UNAVAILABLE_CITY_STATUS: Readonly<WorldCardCityStatus> = Object.freeze({
  state: 'unavailable',
  phase: null,
  asset_state: null,
  ending: null,
  end_program_summary: null,
  ending_checked_at: null,
  checkout_open: false,
})

function worldCardBinding(value: unknown): WorldCardBinding | null {
  if (!isPlainObject(value)) return null
  const id = positiveId(value.id)
  const offerId = positiveId(value.world_offer_id)
  const assetId = positiveId(value.world_asset_id)
  const price = Number(value.price_usdc)
  if (!id || !offerId || !assetId || typeof value.world_seller_handle !== 'string' || !Number.isFinite(price))
    return null
  const draftId = value.world_draft_id === undefined ? undefined : positiveId(value.world_draft_id)
  const wallet = value.seller_wallet
  if (draftId === null || (wallet !== undefined && typeof wallet !== 'string')) return null
  return {
    id, world_offer_id: offerId, world_asset_id: assetId, world_seller_handle: value.world_seller_handle,
    price_usdc: price,
    ...(draftId === undefined ? {} : { world_draft_id: draftId }),
    ...(wallet === undefined ? {} : { seller_wallet: wallet }),
  }
}

function worldCardStatus(
  result: OfferResult | undefined, binding: WorldCardBinding, live: boolean,
): WorldCardCityStatus {
  if (!result?.ok || cityOfferCardMismatch(result.value, binding, MARKET_ORIGIN)) return UNAVAILABLE_CITY_STATUS
  const offer = result.value
  return {
    state: 'current',
    phase: offer.phase,
    asset_state: offer.asset_state ?? null,
    ending: offer.ending ?? null,
    end_program_summary: offer.end_program_summary ?? null,
    ending_checked_at: offer.ending_checked_at ?? null,
    checkout_open: live && isCityOfferAvailable(offer),
  }
}

export type WithCityStatus<T> = T & { city_status?: WorldCardCityStatus }

/**
 * Adds city_status to each world card from one fresh batch read. bindings[i] is the
 * card's listing binding, or null for an artifact card. A card read as live whose
 * city offer is thing_ended reads state thing_ended; nothing is written.
 */
export async function attachCityStatus<T extends Record<string, unknown>>(
  items: readonly T[], bindings: readonly unknown[],
): Promise<{ items: WithCityStatus<T>[]; hasWorldCards: boolean }> {
  const cards = items.map((_, index) => bindings[index] == null
    ? null
    : { binding: worldCardBinding(bindings[index]) })
  const offerIds = cards.flatMap(card => card?.binding ? [card.binding.world_offer_id] : [])
  const results = offerIds.length ? await fetchCityOffers(offerIds) : new Map<number, OfferResult>()
  const withStatus = items.map((item, index): WithCityStatus<T> => {
    const card = cards[index]
    if (!card) return item
    const live = item.state === 'live'
    const status = card.binding
      ? worldCardStatus(results.get(card.binding.world_offer_id), card.binding, live)
      : UNAVAILABLE_CITY_STATUS
    return {
      ...item,
      ...(live && status.phase === 'thing_ended' ? { state: 'thing_ended' } : {}),
      city_status: { ...status },
    }
  })
  return { items: withStatus, hasWorldCards: cards.some(card => card !== null) }
}

/** Bindings for rows whose SQL selected a hidden __world_binding column, matched by row id. */
export function hiddenWorldBindings(
  rawRows: readonly Record<string, unknown>[], items: readonly { id: number }[],
): unknown[] {
  const byId = new Map(rawRows.map(row => [Number(row.id), row.__world_binding]))
  return items.map(item => byId.get(item.id) ?? null)
}

/** Public world listing rows carry their own binding columns. */
export const worldRowBinding = (row: Record<string, unknown>): Record<string, unknown> | null =>
  row.delivery_kind === 'city_ownership' ? row : null

/** Answers holding a world card are never shared from a cache: each read asks the city fresh. */
export const WORLD_CARD_CACHE_CONTROL = 'private, no-store'

export async function fetchCityResident(handle: string): Promise<PublicRecordResult<{ handle: string }>> {
  const response = await publicJson(`/api/world/resident/${encodeURIComponent(handle)}`)
  if (!response.ok) return response
  const resident = response.value.resident
  if (!resident || typeof resident !== 'object' || Array.isArray(resident) ||
      (resident as Record<string, unknown>).handle !== handle)
    return { ok: false, kind: 'invalid', message: 'city returned a malformed resident record' }
  return { ok: true, value: { handle } }
}

export function cityOfferUrl(offerId: number): string {
  return `${CITY_ORIGIN}/api/world/offer/${offerId}`
}

export function cityCancelUrl(offerId: number): string {
  return `${cityOfferUrl(offerId)}/cancel`
}

export function cityClaimUrl(offerId: number): string {
  return `${cityOfferUrl(offerId)}/claim`
}
