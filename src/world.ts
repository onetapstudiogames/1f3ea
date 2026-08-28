import { HANDLE_RE, WALLET_RE } from './core.ts'
import { canonicalTxHash } from './pay.ts'

const DEFAULT_CITY_ORIGIN = 'https://1f3d9.com'
const PUBLIC_READ_TIMEOUT_MS = 3_000
const PUBLIC_RECORD_MAX_BYTES = 64 * 1024

function configuredOrigin(value: string): string {
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash)
    throw new Error('CITY_ORIGIN must be a bare https origin')
  return parsed.origin
}

/** Trusted deployment configuration, never request input. */
export const CITY_ORIGIN = configuredOrigin(process.env.CITY_ORIGIN ?? DEFAULT_CITY_ORIGIN)

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
  | 'claimed'
  | 'canceled'

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
    .map(tag => tag.slice(0, 40)).slice(0, 8)
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
  if (title.length < 3 || title.length > 120) return 'title: 3-120 chars'
  if (!description || description.length > 4000) return 'description: 1-4000 chars'
  if (preview.length > 4000) return 'preview: max 4000 chars'
  if (!Number.isFinite(price) || price <= 0 || price > 10000) return 'price_usdc must be greater than 0 and at most 10000'
  if (!WALLET_RE.test(wallet)) return 'seller_wallet: 0x + 40 hex chars (an address on Base)'
  if (!tags) return 'tags must be an array of strings'
  if (!thingId) return 'thing_id must be a positive integer'
  return {
    title,
    description,
    preview,
    price_usdc: Math.round(price * 1e6) / 1e6,
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

function validOfferCore(value: unknown): value is CityOffer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const offer = value as Record<string, unknown>
  const pendingHash = offer.pending_x402_tx_hash == null
    ? null
    : canonicalTxHash(offer.pending_x402_tx_hash)
  const validDate = (candidate: unknown) =>
    typeof candidate === 'string' && !Number.isNaN(new Date(candidate).getTime())
  const validNullableDate = (candidate: unknown) => candidate === null || validDate(candidate)
  const pendingPhase = ['payment_pending', 'payment_invalid'].includes(String(offer.phase))
  return Boolean(positiveId(offer.id)) && typeof offer.channel === 'string' &&
    ['listed', 'reserved', 'payment_pending', 'payment_invalid', 'claimed', 'canceled']
      .includes(String(offer.phase)) &&
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
    (!pendingPhase || (pendingHash != null && offer.pending_x402_at != null))
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

export function cityOfferMatchesListing(
  value: unknown, listing: ListingBinding, marketOrigin: string,
): string | null {
  if (!validOfferCore(value)) return 'city offer record is malformed'
  const offer = value as CityOffer
  if (offer.id !== listing.world_offer_id || offer.channel !== 'world') return 'city offer id or channel does not match'
  if (offer.asset_type !== 'thing' || offer.asset_id !== listing.world_asset_id) return 'city thing does not match the listing'
  if (offer.market_draft_id !== listing.world_draft_id) return 'city offer draft does not match the listing'
  if (offer.market_listing_id !== null && offer.market_listing_id !== listing.id)
    return 'city offer market listing does not match'
  if (offer.market_origin !== marketOrigin) return 'city offer market origin does not match'
  if (offer.seller !== listing.world_seller_handle) return 'city seller does not match the listing'
  if (!sameMoney(offer.price_usdc, listing.price_usdc)) return 'city offer price does not match the listing'
  if (!WALLET_RE.test(offer.seller_wallet) || offer.seller_wallet.toLowerCase() !== listing.seller_wallet.toLowerCase())
    return 'city offer seller wallet does not match the listing'
  return null
}

export function isCityOfferAvailable(value: unknown, now = new Date()): boolean {
  if (!validOfferCore(value)) return false
  const offer = value as CityOffer
  void now
  return offer.locked && offer.phase === 'listed' && offer.buyer === null &&
    offer.market_buyer === null && offer.market_checkout_id === null &&
    offer.reserved_at === null && offer.reserved_until === null
}

export type PublicRecordResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'not_found' | 'unavailable' | 'invalid'; message: string }

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
      return { ok: false, kind: 'invalid', message: 'city public record is too large' }
    const text = await response.text()
    if (text.length === 0)
      return { ok: false, kind: 'invalid', message: 'city returned an empty public record' }
    if (new TextEncoder().encode(text).byteLength > PUBLIC_RECORD_MAX_BYTES)
      return { ok: false, kind: 'invalid', message: 'city public record is too large' }
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
