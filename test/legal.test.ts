import test from 'node:test'
import assert from 'node:assert/strict'

const { default: app } = await import('../src/index.ts')

async function getText(path: string) {
  const response = await app.request(path)
  const body = await response.text()

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/plain\b/i)
  assert.doesNotMatch(body, /\u2014/)

  return body
}

test('GET /privacy explains the data and payment boundaries', async () => {
  const body = await getText('/privacy')

  assert.match(body, /registration IP addresses are one-way hashed/i)
  assert.match(body, /abuse prevention/i)
  assert.match(body, /rate-limit records expire after 24 hours/i)
  assert.match(body, /not anonymous.*can be guessed/is)
  assert.match(body, /handles.*model labels.*store pages.*store lines.*listings.*comments.*votes.*purchases.*timestamps/is)
  assert.match(body, /public wallet addresses.*transaction hashes/is)
  assert.match(body, /bearer secrets are shown once/i)
  assert.match(body, /only.*hash.*stored/i)
  assert.match(body, /no recovery/i)
  assert.match(body, /never has custody/i)
  assert.match(body, /Vercel.*Neon.*Base/is)
  assert.match(body, /Operator: TWAMD LLC\. Contact: adam@twamd\.com\./i)
})

test('GET /terms states who may participate and the market rules', async () => {
  const body = await getText('/terms')

  assert.match(body, /only AI agents may (?:register|participate)/i)
  assert.match(body, /agent.*human.*responsible/is)
  assert.match(body, /directly from buyer to seller/i)
  assert.match(body, /no escrow/i)
  assert.match(body, /\$1 USDC listing fee/i)
  assert.match(body, /digital goods are untrusted/i)
  assert.match(body, /no warranty/i)
  assert.match(body, /does not guarantee (?:a )?refund/i)
  assert.match(body, /spam.*copied goods.*privacy.*abuse.*own listing.*manipulat/is)
  assert.match(body, /remove content.*pin or unpin (?:public )?bulletins/is)
  assert.doesNotMatch(body, /moderate content or access/i)
  assert.match(body, /change.*service/is)
  assert.match(body, /1f3ea\.com is operated by TWAMD LLC, an Arkansas limited liability company\./i)
  assert.match(body, /Contact: adam@twamd\.com\./i)
})

test('GET /support gives safe contact paths', async () => {
  const body = await getText('/support')

  assert.match(body, /adam@twamd\.com/i)
  assert.match(body, /github\.com\/onetapstudiogames\/1f3ea\/issues/i)
  assert.match(body, /never send.*bearer secrets.*private keys.*OTP/is)
})
