import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
const { default: app } = await import('../src/index.ts')

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('the public city bridge guide states the complete agent contract before use', async () => {
  const response = await app.request('/city-bridge')
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/html\b/iu)

  const guide = await response.text()
  assert.match(guide, /separate market and city identities/iu)
  assert.match(guide, /Authorization: Bearer/iu)
  assert.match(guide, /market secret[^.]*1f3ea\.com/iu)
  assert.match(guide, /city secret[^.]*1f3d9\.com/iu)
  assert.match(guide, /one-hour[^.]*market draft/iu)
  assert.match(guide, /one pending[^.]*draft/iu)
  assert.match(guide, /\$1[^.]*listing fee/iu)
  assert.match(guide, /title[^.]*3[^.]*120[^.]*description[^.]*1[^.]*4000[^.]*preview[^.]*4000/iu)
  assert.match(guide, /price_usdc[^.]*greater than 0[^.]*at most 10,?000[^.]*six decimal/iu)
  assert.match(guide, /seller_wallet[^.]*0x[^.]*40 hex/iu)
  assert.match(guide, /tags[^.]*at most 8[^.]*40 characters/iu)
  assert.match(guide, /thing_id[^.]*positive integer/iu)
  assert.match(guide, /replace (?:the )?example values[^.]*returned[^.]*your flow/iu)
  assert.match(guide, /omit[^.]*fee_tx_hash[^.]*402/iu)
  assert.match(guide, /402[^.]*accepts/iu)
  assert.match(guide, /same endpoint and (?:exact )?same body[^.]*X-PAYMENT/iu)
  assert.match(guide, /at least \$1[^.]*seller_wallet[^.]*official treasury/iu)
  assert.match(guide, /first exact activation request[^.]*inclusive one-hour[^.]*ends when that request begins/iu)
  assert.doesNotMatch(guide, /draft's fixed one-hour window/iu)
  assert.match(guide, /do_not_pay_again/iu)
  assert.match(guide, /thing_id[\s\S]*market_draft_id[\s\S]*draft_id[\s\S]*city_offer_id/iu)
  assert.match(guide, /draft_id[^.]*city_offer_id[^.]*positive integers/iu)
  assert.match(guide, /fee_tx_hash[^.]*0x[^.]*64 hex/iu)
  assert.match(guide, /ten-minute[^.]*checkout[^.]*not a reservation/iu)
  assert.match(guide, /city_handle[^.]*lowercase[^.]*\^\[a-z0-9\]/iu)
  assert.match(guide, /one active checkout[^.]*buyer[^.]*listing[^.]*ten-minute expiry/iu)
  assert.match(guide, /market_checkout_id[\s\S]*buyer_wallet[\s\S]*five-minute/iu)
  assert.match(guide, /city[^.]*402[^.]*X-PAYMENT/iu)
  assert.match(guide, /payer[^.]*buyer_wallet/iu)
  assert.match(guide, /pay the seller once/iu)
  assert.match(guide, /sync[^.]*empty JSON object or no body/iu)
  assert.match(guide, /reconcile[\s\S]*empty JSON object|empty JSON object[\s\S]*reconcile/iu)
  assert.match(guide, /at most two hours/iu)
  assert.match(guide, /payment_expired[^.]*deadline[^.]*without an ownership transfer/iu)
  assert.match(guide, /founder_review[^.]*retained[^.]*payment evidence[^.]*human review/iu)
  assert.match(guide, /terminal[^.]*no-sale[^.]*do not pay again/iu)
  assert.match(guide, /city seller[^.]*authenticate[^.]*POST[^.]*\{\}[^.]*cancel[^.]*unlock/iu)
  assert.match(guide, /GET \/api\/listing\/:id/iu)
  assert.match(guide, /city_offer_url/iu)
  assert.match(guide, /POST \/api\/listing\/:id\/withdraw[^.]*no body/iu)
  assert.match(guide, /POST \/api\/world\/offer\/:id\/cancel[^.]*\{\}/iu)
  assert.match(guide, /POST \/api\/world\/offer\/:id\/reconcile[^.]*\{\}/iu)
  assert.match(guide, /Do not cancel[^.]*claimed[^.]*ownership moved/iu)
})

test('world MCP schemas state every accepted value contract before use', async () => {
  const response = await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  assert.equal(response.status, 200)
  const tools = (await response.json() as {
    result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> }
  }).result.tools
  const schema = (name: string) => {
    const tool = tools.find(candidate => candidate.name === name)
    assert.ok(tool, name)
    return tool as { description: string; inputSchema: {
      properties: Record<string, Record<string, unknown>>
    } }
  }

  const draft = schema('draft_world')
  const draftFields = draft.inputSchema.properties
  assert.match(String(draftFields.title?.description), /trim[^.]*3-120/iu)
  assert.match(String(draftFields.description?.description), /trim[^.]*1-4000/iu)
  assert.match(String(draftFields.preview?.description), /trim[^.]*at most 4000[^.]*empty/iu)
  assert.equal(draftFields.title?.maxLength, undefined)
  assert.equal(draftFields.description?.maxLength, undefined)
  assert.equal(draftFields.preview?.maxLength, undefined)
  assert.deepEqual(
    [draftFields.price_usdc?.exclusiveMinimum, draftFields.price_usdc?.maximum],
    [0, 10000],
  )
  assert.match(String(draftFields.price_usdc?.description), /rounded to 6 decimal places/iu)
  assert.equal(draftFields.seller_wallet?.pattern, '^0x[0-9a-fA-F]{40}$')
  assert.equal(draftFields.tags?.maxItems, undefined)
  assert.doesNotMatch(JSON.stringify(draftFields.tags), /maxLength/iu)
  assert.match(
    String(draftFields.tags?.description),
    /lowercase[^.]*trim[^.]*empty[^.]*duplicate[^.]*truncate[^.]*40[^.]*first 8/iu,
  )
  assert.deepEqual(
    [draftFields.thing_id?.type, draftFields.thing_id?.minimum],
    ['integer', 1],
  )

  const listing = schema('list_world').inputSchema.properties
  for (const name of ['draft_id', 'city_offer_id']) {
    assert.deepEqual([listing[name]?.type, listing[name]?.minimum], ['integer', 1], name)
  }
  assert.equal(listing.fee_tx_hash?.pattern, '^0x[0-9a-fA-F]{64}$')
  assert.match(String(listing.fee_tx_hash?.description), /optional[^.]*at least \$1[^.]*treasury/iu)

  const checkout = schema('checkout_world')
  const checkoutFields = checkout.inputSchema.properties
  assert.deepEqual(
    [checkoutFields.listing_id?.type, checkoutFields.listing_id?.minimum],
    ['integer', 1],
  )
  assert.equal(checkoutFields.city_handle?.pattern, undefined)
  assert.match(
    String(checkoutFields.city_handle?.description),
    /lowercase[^.]*trim[^.]*\^\[a-z0-9\]\[a-z0-9-\]\{2,31\}\$/iu,
  )
  assert.match(checkout.description, /one active checkout[^.]*buyer[^.]*listing[^.]*ten-minute expiry/iu)

  const sync = schema('sync_world').inputSchema.properties
  assert.deepEqual(
    [sync.listing_id?.type, sync.listing_id?.minimum, sync.listing_id?.maximum],
    ['integer', 1, 2_147_483_647],
  )
})

test('the bridge guide teaches seller-kept stalls and human-readable status meanings', async () => {
  const guide = await (await app.request('/city-bridge')).text()

  assert.match(guide, /stall-sign thing[^.]*ordinary city room/iu)
  assert.match(guide, /text[^.]*current market (?:items|listings)/iu)
  assert.match(guide, /seller refreshes[^.]*stock changes/iu)
  assert.match(guide, /city deliberately does not auto-mirror the market/iu)
  assert.match(guide, /verify every listing at 1F3EA before paying/iu)
  assert.match(guide, /do not put secrets or payment proofs/iu)
  assert.match(guide, /do not list the sign itself[^.]*editable/iu)

  for (const phase of [
    'listed', 'reserved', 'payment_pending', 'claimed',
    'payment_invalid', 'payment_expired', 'founder_review', 'needs_review', 'canceled',
  ]) assert.match(guide, new RegExp(`\\b${phase}\\b`, 'u'), phase)

  assert.match(guide, /Terminal city results[\s\S]*claimed[\s\S]*payment_invalid[\s\S]*payment_expired[\s\S]*founder_review[\s\S]*canceled/iu)
  assert.doesNotMatch(guide, /Terminal city results[\s\S]*needs_review[\s\S]*canceled/iu)
  assert.match(guide, /Market sync result[\s\S]*needs_review/iu)
  assert.match(guide, /claimed[^.]*sync[^.]*completed transfer[^.]*never cancel/iu)
  assert.match(guide, /market window[^.]*listings[^.]*sellers[^.]*purchases[^.]*market events/iu)
  assert.match(guide, /city_offer_url[^.]*lock[^.]*reservation[^.]*payment state[^.]*owner/iu)
  assert.doesNotMatch(guide, /market window[^.]*checkout/iu)
})

test('market entry surfaces all point to the one public bridge guide', () => {
  for (const path of ['README.md', 'src/frontdoor.txt', 'src/llms.txt']) {
    assert.match(read(path), /https:\/\/1f3ea\.com\/city-bridge/iu, path)
  }

  const pages = read('src/human-pages.ts')
  assert.match(pages, /href="\/city-bridge"/u)
  assert.match(pages, /href="\/city-bridge"[^>]*>City bridge</u)
})

test('market help gives human observers a direct bridge handoff', async () => {
  const help = await (await app.request('/help')).text()
  assert.match(help, /human[^.]*watch[^.]*city thing/iu)
  assert.match(help, /href="\/city-bridge"[^>]*>[^<]*bridge/iu)
})
