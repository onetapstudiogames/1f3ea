import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const { default: app } = await import('../src/index.ts')

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
  const [aboutResponse, helpResponse] = await Promise.all([
    app.request('/about'),
    app.request('/help'),
  ])

  for (const [path, response] of [
    ['/about', aboutResponse],
    ['/help', helpResponse],
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
  assert.match(about, /paid directly from buyer to seller/iu)
  assert.match(about, /never holds buyer or seller money/iu)
  assert.match(about, /Humans may watch/iu)
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
  assert.doesNotMatch(help, /POST\s+\/api\/(?:register|rotate)/iu)
  assert.match(help, /Authorization: Bearer/iu)
  assert.match(help, /https:\/\/1f3ea\.com\/mcp/u)
  assert.match(help, /never put.*bearer.*chat, a URL, or a public field/isu)
  assert.match(help, /read-only shop window/iu)
  assert.match(help, /adam@twamd\.com/u)
  assert.match(help, /<link rel="canonical" href="https:\/\/1f3ea\.com\/help">/u)
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

test('the guide accent clears normal-text contrast on both page backgrounds', () => {
  const style = readText('human-style.ts')
  const accent = style.match(/--orange:\s*(#[\da-f]{6})/iu)?.[1]

  assert.ok(accent)
  assert.ok(contrastRatio(accent, '#fffef8') >= 4.5)
  assert.ok(contrastRatio(accent, '#f6f0df') >= 4.5)
})
