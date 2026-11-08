import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
const { default: app } = await import('../src/index.ts')
const facts = await import('../src/market-facts.ts')
const { marketRefusalNextStep } = await import('../src/market-refusal.ts')
const { MCP_TOOLS } = await import('../src/mcp-tool-catalog.ts')
const { FRONTDOOR, LLMS } = await import('../src/door.ts')

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const tool = (name: string) => {
  const found = MCP_TOOLS.find(entry => entry.name === name)
  assert.ok(found, name)
  return found
}

// The city's own end-program sentence, as the live city reference and its pinned recipe test give it.
const WAKING_HEAD = 'When this ends it becomes a remnant, then, if waking is on for it and its room lets it wake, ' +
  "the next time a resident is in its room it runs <trait>'s end steps once"

test('thing_ended joins the frozen refusal vocabulary with its own next step', () => {
  assert.ok(facts.MARKET_REFUSAL_REASONS.includes('thing_ended'))
  assert.equal(
    marketRefusalNextStep('thing_ended'),
    'Do not pay. Read the city record named in the error; the thing is a remnant now and cannot be sold here.',
  )
  assert.match(facts.REFUSAL_REASON_CONTRACT, /\bthing_ended\b/u)
})

test('the ending facts carry the city sentence with its waking condition and the remnant', () => {
  assert.ok(facts.WORLD_THING_ENDINGS.includes(WAKING_HEAD), 'waking condition')
  assert.ok(facts.WORLD_THING_ENDINGS.includes('"When this ends it becomes a remnant."'))
  assert.match(facts.WORLD_THING_ENDINGS, /becomes a remnant at the same number/u)
  assert.match(facts.WORLD_THING_ENDINGS, /would come within its five-minute payment window/u)
  assert.match(facts.WORLD_THING_ENDINGS, /moves the remnant whole to the buyer/u)
  assert.match(facts.WORLD_THING_ENDINGS, /POSTs \{\} to city_cancel_url once no payment window is open/u)
  for (const key of ['state', 'phase', 'asset_state', 'ending', 'end_program_summary', 'ending_checked_at', 'checkout_open'])
    assert.match(facts.WORLD_CARD_STATUS, new RegExp(`\\b${key}\\b`, 'u'), key)
  assert.match(facts.WORLD_CARD_STATUS, /private, no-store/u)
  assert.match(facts.WORLD_THING_ENDED_RULE, /409 thing_ended/u)
  for (const value of [facts.WORLD_CARD_STATUS, facts.WORLD_THING_ENDINGS, facts.WORLD_THING_ENDED_RULE, facts.WORLD_CARD_TOOL_NOTE])
    assert.doesNotMatch(value, /[\u2013\u2014\u2018\u2019\u201c\u201d]/u)
})

test('the doors, docs and served pages carry the same ending facts', async () => {
  assert.ok(FRONTDOOR.includes(facts.WORLD_THING_ENDED_RULE), 'front door')
  for (const value of [facts.WORLD_THING_ENDED_RULE, facts.WORLD_CARD_STATUS, facts.WORLD_THING_ENDINGS])
    assert.ok(LLMS.includes(value), `llms.txt ${value.slice(0, 40)}`)
  const spec = read('docs/SPEC.md')
  for (const value of [facts.WORLD_CARD_STATUS, facts.WORLD_THING_ENDINGS])
    assert.ok(spec.includes(value), `SPEC ${value.slice(0, 40)}`)
  assert.match(read('README.md'), /`thing_ended`[^.]*remnant/u)

  const official = await (await app.request('/api/official')).json() as { world: Record<string, unknown> }
  assert.equal(official.world.card_status, facts.WORLD_CARD_STATUS)
  assert.equal(official.world.thing_endings, facts.WORLD_THING_ENDINGS)

  const bridge = await (await app.request('/city-bridge')).text()
  assert.match(bridge, /<code>thing_ended<\/code>: the thing's end came with no accepted payment evidence/u)
  assert.match(bridge, /checkout answers 409 with reason <code>thing_ended<\/code>/u)
  assert.match(bridge, /<code>city_status<\/code>/u)
  assert.match(bridge, /if waking is on for it and its room lets it wake/u)

  const terms = await (await app.request('/terms', { headers: { accept: 'text/plain' } })).text()
  assert.match(terms, /A city thing may end; once its end has come it is a remnant and cannot be sold here\./u)
})

test('the world tools describe city_status, the remnant and the thing_ended results', () => {
  for (const name of ['browse', 'visit_store', 'read_listing', 'me', 'my_purchases'])
    assert.ok(tool(name).description.includes(facts.WORLD_CARD_TOOL_NOTE), name)
  assert.match(tool('checkout_world').description, /409 with reason thing_ended[^.]*\. Do not pay\./u)
  assert.match(tool('sync_world').description, /phase thing_ended[^.]*records the listing as thing_ended with no sale/u)
  assert.match(tool('sync_world').description, /city_cancel_url once no payment window is open/u)
  assert.match(tool('list_world').description, /A remnant cannot be offered in the city/u)
  assert.match(tool('world_status').description, /thing_ended[^.]*reads canceled/u)
})

test('decision 34 adds thing_ended to the decision 31 vocabulary', () => {
  const row = read('docs/DECISIONS.md').split('\n').find(line => line.startsWith('| 34 |'))
  assert.ok(row, 'row 34')
  assert.match(row, /`thing_ended`/u)
  assert.match(row, /#31/u)
  assert.match(row, /#27/u)
})
