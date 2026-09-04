import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'

const { default: app } = await import('../src/index.ts')

test('GET /window serves a human-facing read-only shell with strict browser boundaries', async () => {
  const response = await app.request('/window')
  const html = await response.text()

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/html\b/)
  assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.match(response.headers.get('permissions-policy') ?? '', /payment=\(\)/)
  assert.match(response.headers.get('cache-control') ?? '', /max-age=0/)

  const csp = response.headers.get('content-security-policy') ?? ''
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /base-uri 'none'/)
  assert.match(csp, /script-src 'self'/)
  assert.match(csp, /style-src 'self'/)
  assert.match(csp, /connect-src 'self'/)
  assert.match(csp, /object-src 'none'/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.match(csp, /form-action 'none'/)
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/)

  assert.match(html, /<html lang="en">/)
  assert.match(html, /THE SHOP WINDOW/)
  assert.match(html, /Humans may look\. Agents do the shopping\./)
  assert.match(html, /Read only/)
  assert.match(html, /href="\/window\.css"/)
  assert.match(html, /src="\/window\.js"/)
  assert.match(html, /aria-live="polite"/)
  assert.match(html, /id="filter-input"[\s\S]*maxlength="100"/)
  assert.match(html, /meta name="robots" content="noindex, nofollow, noarchive"/)
  assert.match(html, /meta name="color-scheme" content="dark light"/)
  assert.match(html, /href="https:\/\/1f916\.ai\/"[^>]*>A separate square other people run<\/a>/)
  assert.match(html, /href="https:\/\/1f3d9\.com\/"/)
  assert.match(html, /World aisle delivers city ownership/i)
  assert.match(html, /shopkeeper, whose uncapped fee-free listings are publicly logged as maintainer_seed/i)
  const footer = html.match(/<footer class="window-footer">([\s\S]*?)<\/footer>/)?.[1] ?? ''
  assert.match(footer, /Run by TWAMD LLC/)
  assert.match(footer, /href="mailto:adam@twamd\.com">adam@twamd\.com<\/a>/)
  assert.match(
    footer,
    /href="https:\/\/github\.com\/onetapstudiogames\/1f3ea\/blob\/main\/LICENSE"[^>]*>AGPL-3\.0<\/a>/,
  )
  assert.doesNotMatch(html, /Gentry/iu)
  assert.doesNotMatch(html, /<form\b|Authorization|1f3ea_sk_|seller_wallet/i)
})

test('window aisle links have canonical Open Graph and Twitter cards without a data read', async () => {
  const response = await app.request('/window?aisle=tools&utm_source=discarded')
  const html = await response.text()

  assert.equal(response.status, 200)
  assert.match(html, /<title>Tools aisle — 1F3EA<\/title>/)
  assert.match(html, /<link rel="canonical" href="https:\/\/1f3ea\.com\/window\?aisle=tools">/)
  assert.match(html, /property="og:title" content="Tools aisle — 1F3EA"/)
  assert.match(html, /property="og:url" content="https:\/\/1f3ea\.com\/window\?aisle=tools"/)
  assert.match(html, /property="og:image" content="https:\/\/1f3ea\.com\/window-card\.png"/)
  assert.match(html, /name="twitter:card" content="summary"/)
  assert.doesNotMatch(html, /utm_source|discarded/)
})

test('the window card is the finished self-contained PNG with cross-origin preview headers', async () => {
  const response = await app.request('/window-card.png')
  const bytes = new Uint8Array(await response.arrayBuffer())

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin')
  assert.match(response.headers.get('cache-control') ?? '', /s-maxage=604800/)
  assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert.equal(view.getUint32(16), 512)
  assert.equal(view.getUint32(20), 512)
  assert.ok(bytes.byteLength > 10_000)
})

test('window assets are dependency-free, responsive, and safe for untrusted market text', async () => {
  const [styleResponse, scriptResponse] = await Promise.all([
    app.request('/window.css'),
    app.request('/window.js'),
  ])
  const css = await styleResponse.text()
  const script = await scriptResponse.text()

  assert.equal(styleResponse.status, 200)
  assert.match(styleResponse.headers.get('content-type') ?? '', /^text\/css\b/)
  assert.equal(styleResponse.headers.get('x-content-type-options'), 'nosniff')
  assert.match(css, /@media \(max-width:/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(css, /:focus-visible/)
  assert.match(css, /\.window-footer \.operator-line/)

  assert.equal(scriptResponse.status, 200)
  assert.match(scriptResponse.headers.get('content-type') ?? '', /javascript/)
  assert.equal(scriptResponse.headers.get('x-content-type-options'), 'nosniff')
  assert.match(script, /\/api\/window/)
  assert.match(script, /\/api\/shelves/)
  assert.match(script, /\/api\/store\//)
  assert.match(script, /\/api\/listing\//)
  assert.match(script, /verified_buyer/)
  assert.match(script, /verified_buyer\s*===\s*true/)
  assert.match(script, /parent_id/)
  assert.match(script, /textContent/)
  assert.match(script, /replaceChildren/)
  assert.match(script, /credentials:\s*['"]omit['"]/)
  assert.match(script, /setTimeout/)
  assert.match(script, /document\.hidden/)
  assert.match(script, /AbortController/)
  assert.match(script, /SAFE_EVENT_KINDS/)
  assert.match(script, /changed_fields/)
  assert.match(script, /MAX_FILTER_CHARS\s*=\s*100/)
  assert.match(script, /events_total/)
  assert.match(script, /listings_more_url/)
  assert.match(script, /merchants_more_url/)
  assert.match(script, /comments_after_id/)
  assert.doesNotMatch(script, /\/api\/store\/['"]?\s*\+\s*handle\s*\+\s*['"]\?limit=50/)
  assert.doesNotMatch(script, /['"]flag['"]/)

  assert.match(styleResponse.headers.get('cache-control') ?? '', /max-age=0/)
  assert.match(scriptResponse.headers.get('cache-control') ?? '', /max-age=0/)

  assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
  assert.doesNotMatch(script, /localStorage|sessionStorage|document\.cookie/)
  assert.doesNotMatch(script, /Authorization|1f3ea_sk_|seller_wallet/)
  assert.doesNotMatch(script, /\b(?:POST|PUT|PATCH|DELETE)\b/)
  assert.doesNotMatch(script, /\.artifact\b/)
  assert.doesNotMatch(script, /\.store_url\b|detail\.(?:reason|title)/)
  assert.doesNotMatch(script, /\/api\/(?:me|purchases|buy|claim|comment|vote|flag)\b/)
})

test('the human window remains separate from the agent front door', async () => {
  const [doorResponse, humanResponse, llmsResponse] = await Promise.all([
    app.request('/'),
    app.request('/humans.txt'),
    app.request('/llms.txt'),
  ])
  const door = await doorResponse.text()
  const humans = await humanResponse.text()
  const llms = await llmsResponse.text()

  assert.match(doorResponse.headers.get('content-type') ?? '', /^text\/plain\b/)
  assert.doesNotMatch(door, /<html\b/i)
  assert.match(door, /Humans may watch through the read-only shop window:/)
  assert.match(door, /https:\/\/1f3ea\.com\/window/)

  assert.match(humans, /Allow: \/window/)
  assert.match(humans, /Humans may look\. Agents do the shopping\./)
  assert.doesNotMatch(llms, /(?<!\/api)\/window\b/)
})
