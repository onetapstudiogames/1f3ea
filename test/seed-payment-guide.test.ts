import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { WITHDRAW_ITEM_CONTRACT } from '../src/public-contracts.ts'

type Seed = { description: string; preview: string; artifact: string }

function readSeed(name: string): Seed {
  return JSON.parse(readFileSync(new URL(`../seed/${name}`, import.meta.url), 'utf8')) as Seed
}

const paymentSeed = readSeed('06-x402-payment-runbook.json')

test('the replacement payment seed teaches the current bounded and finality-safe contracts', () => {
  const publicCopy = `${paymentSeed.description}\n${paymentSeed.preview}`
  const allCopy = `${publicCopy}\n${paymentSeed.artifact}`

  assert.doesNotMatch(publicCopy, /market opened today|no sales have happened/iu)
  assert.match(allCopy, /fresh ten-minute intent/iu)
  assert.match(allCopy, /payer_signature/iu)
  assert.match(allCopy, /canonical[^.]*finalized head/iu)
  assert.match(allCopy, /status[^.]*0x1[^.]*not (?:enough|final)/iu)
  assert.match(allCopy, /same (?:request|proof)/iu)
  assert.match(allCopy, /do not pay again/iu)
  assert.doesNotMatch(allCopy, /POST[^\n]*\/api\/claim\/:id\s*\{\s*"tx_hash"/iu)
  assert.doesNotMatch(allCopy, /buys are not payer-bound/iu)
})

test('opening-stock descriptions date launch-day claims instead of presenting them as current', () => {
  for (const name of [
    '02-1f916-citizen-skill.json',
    '03-audit-the-market-skill.json',
    '04-price-your-artifact.json',
    '08-preview-that-sells.json',
  ]) {
    const seed = readSeed(name)
    const allCopy = `${seed.description}\n${seed.preview}\n${seed.artifact}`
    assert.doesNotMatch(allCopy, /market (?:opens|opened) today|market opened with empty shelves today/iu, name)
    assert.match(allCopy, /2026-08-06/iu, name)
  }
})

test('the retired 1f916 seed is archival and cannot be mistaken for a current install guide', () => {
  const seed = readSeed('02-1f916-citizen-skill.json')
  const allCopy = `${seed.description}\n${seed.preview}\n${seed.artifact}`

  assert.match(seed.description, /historical|archived/iu)
  assert.match(allCopy, /do not install|not current instructions/iu)
  assert.match(allCopy, /externally owned/iu)
  assert.doesNotMatch(allCopy, /checked against the live site|complete SKILL\.md/iu)
})

test('the replacement auditor seed pages complete collections and checks canonical finality', () => {
  const seed = readSeed('03-audit-the-market-skill.json')
  const allCopy = `${seed.description}\n${seed.preview}\n${seed.artifact}`

  assert.match(allCopy, /fees_next_before_id/iu)
  assert.match(allCopy, /next_before_id/iu)
  assert.match(allCopy, /canonical block hash/iu)
  assert.match(allCopy, /finalized head/iu)
  assert.match(allCopy, /merchant withdrawal/iu)
  assert.doesNotMatch(allCopy, /fees and patronage|occasional patronage/iu)
  assert.doesNotMatch(allCopy, /prints the whole moderation log/iu)
  assert.doesNotMatch(allCopy, /shows the 50 most recent fee rows/iu)
  assert.doesNotMatch(allCopy, /returns the most recent 200 events/iu)
})

test('the replacement pricing seed teaches the current listing and edit contract', () => {
  const seed = readSeed('04-price-your-artifact.json')
  const publicCopy = `${seed.description}\n${seed.preview}`
  const allCopy = `${seed.description}\n${seed.preview}\n${seed.artifact}`

  assert.ok(seed.preview.includes(WITHDRAW_ITEM_CONTRACT))
  assert.ok(seed.artifact.includes(WITHDRAW_ITEM_CONTRACT))
  assert.match(allCopy, /no daily listing cap/iu)
  assert.match(publicCopy, /shopkeeper[^.]*uncapped fee-free listings[^.]*maintainer_seed/iu)
  assert.match(publicCopy, /every (?:other|non-shopkeeper) (?:ordinary )?merchant[^.]*\$1 USDC/iu)
  assert.match(seed.preview, /Every accepted ordinary listing must pass the seven-day near-duplicate guard\. Every merchant except the shopkeeper also pays its own \$1 USDC listing fee\./u)
  assert.match(seed.artifact, /Every accepted ordinary listing must pass the seven-day near-duplicate guard\. Every merchant except the shopkeeper also pays its own \$1 USDC listing fee\./u)
  assert.match(seed.artifact, /Because every merchant except the shopkeeper pays \$1 USDC to publish an ordinary listing, a price below \$1/iu)
  assert.match(allCopy, /price and seller wallet never change/iu)
  assert.match(allCopy, /after any purchase[^.]*no listing fields may be edited/iu)
  assert.match(allCopy, /permanent withdrawal remains available[^.]*preserves prior (?:purchases|delivery)/iu)
  assert.doesNotMatch(allCopy, /one new listing per UTC day|dollar and the day|slot is spent/iu)
  assert.doesNotMatch(allCopy, /no price-edit endpoint/iu)
  assert.doesNotMatch(allCopy, /market opened today|no price history yet|no sales to dissect/iu)
})
