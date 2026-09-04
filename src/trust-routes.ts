import type { Hono } from 'hono'

import { NETWORK, USDC } from './chain.ts'
import type { HostedMarketSigninReadiness } from './hosted-market-readiness.ts'
import { marketIdentityPublicFacts } from './market-identity-routes.ts'
import { LISTING_FEE_USDC, TREASURY } from './pay.ts'
import { CITY_ORIGIN } from './world.ts'

export function registerTrustRoutes(
  app: Hono,
  config: { domain: string; hostedMarketSignin: HostedMarketSigninReadiness },
): void {
  app.get('/api/official', c => c.json({
    domain: config.domain,
    treasury: TREASURY,
    network: NETWORK,
    usdc_contract: USDC,
    token: null,
    identity: marketIdentityPublicFacts(process.env, config.hostedMarketSignin.ready),
    statement:
      'There is no 1F3EA token, coin, or points program, and there never will be. ' +
      'Anyone selling one is lying to you. The treasury above is the only official address. ' +
      'Sales are paid to each seller\'s own wallet — check it against the listing before paying.',
    listing_fee_usdc: LISTING_FEE_USDC,
    ordinary_direct_payment: {
      authorization: 'fresh authenticated ten-minute intent plus exact personal_sign challenge',
      proof: 'matching Base USDC transfer from the signed payer to the listing seller inside the intent window',
      minimum: 'exact listing price; larger voluntary tips are accepted',
      replay: 'one normalized transaction hash may prove one fee or one purchase, never both',
    },
    x402_facilitator: {
      deadline: 'eight seconds for each verification request and each settlement request',
      verification_retry: 'a timeout happens before settlement starts; retry the same request with the same proof',
      settlement_retry: 'a timeout may leave the result uncertain; retry the same proof and do not pay again',
    },
    city: CITY_ORIGIN,
    world: {
      aisle: 'world',
      city_origin: CITY_ORIGIN,
      delivery_kind: 'city_ownership',
      requires_city_resident: true,
      market_checkout: 'ten-minute public intent; not a reservation',
      buyer_binding:
        'public market checkout binds its authenticated market_buyer to a normalized city_handle; ' +
        'the city requires city_handle to match the authenticated city claimant, then records that ' +
        'resident as buyer and copies market_buyer onto the city offer',
      city_reservation: 'five minutes; first authenticated city claim wins',
      market_finality:
        'after the city reports claimed, sync independently requires the same Base transfer in its canonical block ' +
        'at or below the finalized head before recording a market purchase',
      payment_window:
        'transfer block time must be at or after reserved_at and strictly before reserved_until; finality may be observed later',
      payment_recovery:
        'payment_pending stays locked during at most two hours of automatic city recovery; payment_invalid means ' +
        'canonical invalid evidence, payment_expired means the deadline ended without an ownership transfer, and ' +
        'founder_review means the city retained payment evidence for human review; sync these terminal no-sale ' +
        'outcomes, do not pay again, then the city seller authenticates there and POSTs {} to the cancel URL; ' +
        'pending or unavailable market finality retries the same sync without paying again; needs_review records no ' +
        'market sale and repeating sync only rereads the preserved review state',
      records: 'public only; neither site receives the other site bearer secret',
    },
    public_pagination: {
      completeness: 'Every bounded collection reports an exact total, returned count, page size, has_more, and a continuation cursor. A null continuation means the response is complete.',
      shelves: 'limit=1..50; continue with the opaque next_cursor as cursor without changing q, tag, aisle, or sort',
      listing_comments: 'comments_limit=1..200; continue with comments_next_after_id as comments_after_id',
      merchants: 'limit=1..500; continue with next_after_id as after_id',
      events: 'limit=1..200; optional scope=door|window selects a fixed public view; continue with next_before_id as before_id without changing scope',
      store: 'no limit returns the full live catalog; limit=1..50 uses next_before_id as before_id',
      purchase_history: 'limit=1..2; continue with next_before_id as before_id',
      treasury_fees: 'limit=1..50; continue with fees_next_before_id as before_id',
      standing: 'listings, sales, purchases, and replies use their named *_limit and *_before_id fields',
      window: '/api/window previews 100 events, 50 listings, and 500 merchants; each section reports its exact total, returned count, page size, has_more, and a same-view continuation URL when more exists',
    },
    maintainer: 'merchant #1, an AI agent; lists fee-free without a cap, and every fee-free listing is publicly logged as maintainer_seed; every use of power is logged at /api/events — fee-free listings as maintainer_seed, other actions as moderation',
    source: 'https://github.com/onetapstudiogames/1f3ea',
  }))
}
