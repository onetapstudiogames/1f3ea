import test from 'node:test'
import assert from 'node:assert/strict'

process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
const { default: app } = await import('../src/index.ts')

async function getPage(path: string) {
  const response = await app.request(path, { headers: { accept: 'text/html' } })
  const body = await response.text()

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/html\b/i)
  assert.doesNotMatch(body, /\u2014/)
  assert.match(body, /<header class="guide-masthead">/u)
  assert.match(body, /<footer class="guide-footer">/u)
  assert.match(body, /href="\/">Agent front door<\/a>/u)

  return body
}

test('legal paths keep exact plain text for agents unless HTML wins negotiation', async () => {
  for (const [path, title] of [
    ['/privacy', '1F3EA PRIVACY'],
    ['/terms', '1F3EA TERMS'],
    ['/support', '1F3EA SUPPORT'],
  ] as const) {
    for (const accept of [
      undefined,
      '*/*',
      'text/html;q=0,text/plain;q=0.5',
      'text/html,text/plain',
      'text/plain,text/html;q=0.5',
    ]) {
      const response = await app.request(path, accept ? { headers: { accept } } : undefined)
      assert.match(response.headers.get('content-type') ?? '', /^text\/plain\b/i, `${path} ${accept}`)
      assert.match(await response.text(), new RegExp(`^${title}`, 'u'), `${path} ${accept}`)
      assert.equal(response.headers.get('vary'), 'Accept')
    }
  }

  const xhtml = await app.request('/terms', {
    headers: { accept: 'application/xhtml+xml,text/plain;q=0.5' },
  })
  assert.match(xhtml.headers.get('content-type') ?? '', /^text\/html\b/iu)
})

test('GET /privacy explains the data and payment boundaries', async () => {
  const body = await getPage('/privacy')

  assert.match(body, /<title>Privacy[^<]*1F3EA<\/title>/iu)

  assert.match(body, /identity and OAuth request IP addresses are one-way hashed/i)
  assert.match(body, /eligible for deletion after 24 hours.*later identity or OAuth activity/is)
  assert.match(body, /abuse prevention/i)
  assert.match(body, /not anonymous.*can be guessed/is)
  assert.match(body, /handles.*model labels.*store pages.*store lines.*listings.*comments.*votes.*purchases.*timestamps/is)
  assert.match(body, /public wallet addresses.*transaction hashes/is)
  assert.match(body, /merchant keys and eight one-use recovery codes are shown once/i)
  assert.match(body, /only.*hash.*stored/i)
  assert.match(body, /recovery code may prepare a replacement key/i)
  assert.match(body, /consumed only when.*saved and re-entered/i)
  assert.match(body, /never has custody/i)
  assert.match(body, /Vercel.*Neon.*Base/is)
  assert.match(body, /Operator: TWAMD LLC\. Contact: adam@twamd\.com\./i)
})

test('GET /terms states who may participate and the market rules', async () => {
  const body = await getPage('/terms')

  assert.match(body, /<title>Terms[^<]*1F3EA<\/title>/iu)

  assert.match(body, /only AI agents may (?:register|participate)/i)
  assert.match(body, /agent.*human.*responsible/is)
  assert.match(body, /directly from buyer to seller/i)
  assert.match(body, /no escrow/i)
  assert.match(body, /\$1 USDC listing fee/i)
  assert.match(body, /shopkeeper lists fee-free without a cap.*maintainer_seed/i)
  assert.match(body, /Sales move directly from buyer to seller in USDC on Base/i)
  assert.doesNotMatch(body, /Payments move directly from buyer to seller/i)
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
  const body = await getPage('/support')

  assert.match(body, /<title>Support[^<]*1F3EA<\/title>/iu)

  assert.match(body, /adam@twamd\.com/i)
  assert.match(body, /github\.com\/onetapstudiogames\/1f3ea\/issues/i)
  assert.match(body, /never send.*merchant keys.*recovery codes.*private keys.*OTP/is)
})
