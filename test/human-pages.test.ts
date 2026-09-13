import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { HOSTED_PROOF_CONTRACT, SEARCH_DESCRIPTION } from '../src/market-facts.ts'

process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
const { default: app } = await import('../src/index.ts')
const { treasuryDocument } = await import('../src/human-pages.ts')
const { LISTING_METADATA } = await import('../src/listing-metadata.ts')

test('every human page has search metadata from market facts', async () => {
  for (const path of ['/','/about','/help','/city-bridge','/window','/terms','/privacy','/support','/treasury','/changelog']) {
    const html = path === '/treasury' ? treasuryDocument({ address: '', network: 'Base', usdc_balance_onchain: 0, fees_collected_usdc: 0, fees_count: 0, recent_fees: [], fees_returned: 0, fees_page_size: 10, fees_has_more: false, fees_next_before_id: null, note: '' }) : await (async () => {
      const response = await app.request(path, { headers: { accept: 'text/html' } })
      assert.equal(response.status, 200, path)
      return response.text()
    })()
    const title = /<title>([^<]+)<\/title>/u.exec(html)?.[1]
    assert.ok(title?.includes('1F3EA') && title.length < 60, path)
    assert.ok(html.includes(`<meta name="description" content="${SEARCH_DESCRIPTION}">`), path)
    assert.ok(SEARCH_DESCRIPTION.length < 160)
    assert.match(html, /<link rel="canonical" href="https:\/\/1f3ea\.com\//u, path)
    assert.match(html, /<meta property="og:image" content="https:\/\/1f3ea\.com\/og-image\.png">/u, path)
    assert.match(html, /<meta name="twitter:image" content="https:\/\/1f3ea\.com\/og-image\.png">/u, path)
    assert.equal((html.match(/<script type="application\/ld\+json">/gu) ?? []).length, 1, path)
    for (const tag of [/<title>/gu, /<meta name="description"/gu, /<link rel="canonical"/gu, /<meta property="og:image"/gu, /<meta name="twitter:image"/gu]) {
      assert.equal((html.match(tag) ?? []).length, 1, `${path}: ${tag}`)
    }
  }
  const agentRoot = await app.request('/')
  assert.match(agentRoot.headers.get('content-type') ?? '', /^text\/plain\b/u)
  assert.equal(agentRoot.headers.get('vary'), 'Accept')
  const browserRoot = await app.request('/', { headers: { accept: 'text/html' } })
  assert.equal(browserRoot.headers.get('vary'), 'Accept')
  const root = await browserRoot.text()
  const rootSchema = JSON.parse(/<script type="application\/ld\+json">([^<]+)<\/script>/u.exec(root)?.[1] ?? '{}')
  assert.equal(rootSchema['@type'], 'WebSite')
  const robots = await (await app.request('/robots.txt')).text()
  assert.match(robots, /Sitemap: https:\/\/1f3ea\.com\/sitemap\.xml/u)
  const sitemap = await (await app.request('/sitemap.xml')).text()
  for (const path of ['/','/about','/help','/city-bridge','/window','/terms','/privacy','/support','/treasury','/changelog']) {
    assert.ok(sitemap.includes(`<loc>https://1f3ea.com${path}</loc>`), path)
  }
  const about = await (await app.request('/about')).text()
  const schema = JSON.parse(/<script type="application\/ld\+json">([^<]+)<\/script>/u.exec(about)?.[1] ?? '{}')
  assert.equal(schema['@type'], 'SoftwareApplication')
  assert.equal(schema.name, LISTING_METADATA.displayName)
  assert.equal(schema.description, LISTING_METADATA.longDescription)
  for (const listing of LISTING_METADATA.directories.filter(row => row.status !== 'owner submits')) {
    assert.ok(about.includes(listing.directory), listing.directory)
    if (listing.listingUrl.startsWith('https://')) assert.ok(about.includes(listing.listingUrl), listing.directory)
  }
})

const readAsset = (name: string) => readFileSync(new URL(`../src/assets/${name}`, import.meta.url))
const readText = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const [red, green, blue] = channels.map(value => (
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ))
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first)
  const secondLuminance = relativeLuminance(second)
  return (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
}

test('human guide pages state the market, participation, observation, and operator facts', async () => {
  const [aboutResponse, helpResponse, bridgeResponse] = await Promise.all([
    app.request('/about'),
    app.request('/help'),
    app.request('/city-bridge'),
  ])

  for (const [path, response] of [
    ['/about', aboutResponse],
    ['/help', helpResponse],
    ['/city-bridge', bridgeResponse],
  ] as const) {
    assert.equal(response.status, 200, path)
    assert.match(response.headers.get('content-type') ?? '', /^text\/html\b/iu, path)
    assert.equal(response.headers.get('x-robots-tag'), 'index, follow', path)
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/u, path)
  }

  const about = await aboutResponse.text()
  assert.match(about, /1F3EA is a market for AI agents\./u)
  assert.match(about, /agents run the stores/iu)
  assert.match(about, /text or JSON/iu)
  assert.match(about, /unique city things/iu)
  assert.match(about, /Installed copies[^.]*marketplace skill can lag/iu)
  assert.doesNotMatch(about, /released marketplace skill carries the same working instructions/iu)
  assert.match(about, /paid directly from buyer to seller/iu)
  assert.match(about, /never holds buyer or seller money/iu)
  assert.match(about, /Humans may watch/iu)
  assert.ok(about.includes(HOSTED_PROOF_CONTRACT))
  assert.match(about, /cannot join, buy, sell, comment, or vote/iu)
  assert.match(about, /TWAMD LLC/u)
  assert.match(about, /adam@twamd\.com/u)
  assert.match(about, /<link rel="canonical" href="https:\/\/1f3ea\.com\/about">/u)
  assert.match(about, /<meta property="og:image" content="https:\/\/1f3ea\.com\/og-image\.png">/u)
  assert.match(about, /<meta name="twitter:card" content="summary">/u)
  assert.match(about, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png" sizes="180x180">/u)

  const help = await helpResponse.text()
  assert.match(help, /Start at the agent front door/iu)
  assert.match(help, /register one merchant identity/iu)
  assert.match(help, /href="\/join"[\s\S]{0,400}eight recovery codes/iu)
  assert.match(help, /href="\/recovery"/u)
  assert.match(help, /href="\/rotate"/u)
  assert.doesNotMatch(help, /one-call POST\s+\/api\/(?:register|rotate)/iu)
  assert.match(help, /Authorization: Bearer/iu)
  assert.match(help, /https:\/\/1f3ea\.com\/mcp/u)
  assert.match(help, /never put.*bearer.*chat, a URL, or a public field/isu)
  assert.match(help, /read-only shop window/iu)
  assert.ok(help.includes(HOSTED_PROOF_CONTRACT))
  assert.match(help, /adam@twamd\.com/u)
  assert.match(help, /<link rel="canonical" href="https:\/\/1f3ea\.com\/help">/u)

  const bridge = await bridgeResponse.text()
  assert.match(bridge, /market and city/iu)
  assert.match(bridge, /For agents/iu)
  assert.match(bridge, /For humans/iu)
  assert.match(bridge, /<link rel="canonical" href="https:\/\/1f3ea\.com\/city-bridge">/u)

  const walletAdvice = [about, help, bridge].join('\n')
    .match(/Get a wallet; some wallets allow agent autonomy\./gu) ?? []
  assert.equal(walletAdvice.length, 1)
  assert.doesNotMatch([about, help, bridge].join('\n'), /MetaMask|Coinbase|Circle|rank|compare/iu)
})

test('routed icon and preview bytes exactly match the supplied repository assets', async () => {
  const cases = [
    ['/favicon.svg', '1f3ea-icon.svg', 'image/svg+xml'],
    ['/favicon.ico', '1f3ea-32.png', 'image/png'],
    ['/favicon-32x32.png', '1f3ea-32.png', 'image/png'],
    ['/apple-touch-icon.png', '1f3ea-180.png', 'image/png'],
    ['/og-image.png', '1f3ea-512.png', 'image/png'],
  ] as const

  for (const [path, assetName, contentType] of cases) {
    const response = await app.request(path)
    assert.equal(response.status, 200, path)
    assert.equal(response.headers.get('content-type'), contentType, path)
    assert.match(response.headers.get('cache-control') ?? '', /public/iu, path)
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin', path)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), readAsset(assetName), path)
  }

  assert.deepEqual(pngDimensions(readAsset('1f3ea-32.png')), { width: 32, height: 32 })
  assert.deepEqual(pngDimensions(readAsset('1f3ea-180.png')), { width: 180, height: 180 })
  assert.deepEqual(pngDimensions(readAsset('1f3ea-512.png')), { width: 512, height: 512 })
})

test('the routed human guide stylesheet is cacheable CSS', async () => {
  const response = await app.request('/guide.css')

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/css\b/iu)
  assert.match(response.headers.get('cache-control') ?? '', /public/iu)
  assert.match(await response.text(), /--cream:\s*#fffef8/iu)
})

test('the served stylesheet keeps the market seal square instead of stretching it', async () => {
  const css = await (await app.request('/guide.css')).text()
  const sealRule = css.match(/\.market-seal img \{([^}]*)\}/u)?.[1]

  assert.ok(sealRule, 'the served stylesheet declares a .market-seal img rule')
  assert.match(sealRule, /height:\s*auto/u)
  assert.match(css, /(?:^|\n)img \{[^}]*max-width:\s*100%/u)
})

test('every page that shows the market seal loads the one guide stylesheet', async () => {
  for (const path of ['/about', '/help', '/city-bridge']) {
    const html = await (await app.request(path, { headers: { accept: 'text/html' } })).text()

    assert.match(html, /class="market-seal"/u, path)
    assert.match(html, /<link rel="stylesheet" href="\/guide\.css">/u, path)
  }
})

test('the guide accent clears normal-text contrast on both page backgrounds', () => {
  const style = readText('human-style.ts')
  const accent = style.match(/--orange:\s*(#[\da-f]{6})/iu)?.[1]

  assert.ok(accent)
  assert.ok(contrastRatio(accent, '#fffef8') >= 4.5)
  assert.ok(contrastRatio(accent, '#f6f0df') >= 4.5)
})
