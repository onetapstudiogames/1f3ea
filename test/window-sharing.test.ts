import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GENERIC_WINDOW_SHARE,
  resolveWindowShare,
  type WindowPublicRead,
} from '../src/window-sharing.ts'
import { renderWindowHtml } from '../src/window-page.ts'

function jsonBytes(value: unknown, status = 200) {
  return new Response(new TextEncoder().encode(JSON.stringify(value)), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

test('listing and store cards use current public reads without forwarding request credentials', async () => {
  const paths: string[] = []
  const read: WindowPublicRead = async path => {
    paths.push(path)
    if (path === '/api/listing/12?comments_limit=1') {
      const response = jsonBytes({
        listing: {
          id: 12,
          merchant: 'tiny-shop',
          title: '</title><script>unsafe()</script> Patient tool\u202Emoc.live',
          description: 'A public shelf\u2066 description.',
          aisle: 'tools',
          state: 'live',
        },
      })
      assert.equal(response.headers.has('content-length'), false)
      return response
    }
    return jsonBytes({
      store: {
        handle: 'tiny-shop',
        line: 'Careful tools & patient service.',
      },
    })
  }

  const item = await resolveWindowShare(
    'https://preview.example/window?utm_source=discarded&item=12',
    read,
  )
  assert.equal(item.canonicalUrl, 'https://1f3ea.com/window?item=12')
  assert.match(item.title, /Patient tool/)
  assert.match(item.description, /tiny-shop/)
  const itemHtml = renderWindowHtml(item)
  assert.match(itemHtml, /<link rel="canonical" href="https:\/\/1f3ea\.com\/window\?item=12">/)
  assert.match(itemHtml, /property="og:title"/)
  assert.match(itemHtml, /property="og:type" content="website"/)
  assert.match(itemHtml, /property="og:url" content="https:\/\/1f3ea\.com\/window\?item=12"/)
  assert.match(itemHtml, /property="og:image" content="https:\/\/1f3ea\.com\/window-card\.png"/)
  assert.match(itemHtml, /property="og:image:type" content="image\/png"/)
  assert.match(itemHtml, /property="og:image:width" content="512"/)
  assert.match(itemHtml, /property="og:image:height" content="512"/)
  assert.match(itemHtml, /name="twitter:card" content="summary"/)
  assert.match(itemHtml, /name="twitter:title"/)
  assert.match(itemHtml, /name="twitter:image" content="https:\/\/1f3ea\.com\/window-card\.png"/)
  assert.doesNotMatch(itemHtml, /<script>unsafe\(\)<\/script>/)
  assert.doesNotMatch(itemHtml, /\u202e|\u2066/u)
  assert.match(itemHtml, /&lt;\/title&gt;&lt;script&gt;unsafe\(\)&lt;\/script&gt;/)

  const store = await resolveWindowShare(
    'https://preview.example/window?store=TINY-SHOP&tracking=discarded',
    read,
  )
  assert.equal(store.canonicalUrl, 'https://1f3ea.com/window?store=tiny-shop')
  assert.match(store.title, /tiny-shop storefront/i)
  assert.match(store.description, /Careful tools & patient service\./)
  assert.deepEqual(paths, [
    '/api/listing/12?comments_limit=1',
    '/api/store/tiny-shop?limit=1',
  ])
})

test('aisle and invalid window links canonicalize without a database read', async () => {
  let reads = 0
  const read: WindowPublicRead = async () => {
    reads += 1
    throw new Error('must not read')
  }

  const aisle = await resolveWindowShare('https://preview.example/window?aisle=tools', read)
  assert.equal(aisle.canonicalUrl, 'https://1f3ea.com/window?aisle=tools')
  assert.equal(aisle.title, 'Tools aisle — 1F3EA')

  for (const href of [
    'https://preview.example/window?aisle=not-real',
    'https://preview.example/window?item=12&store=tiny-shop',
    'https://preview.example/window?item=0',
    'https://preview.example/window?store=not_ok',
  ]) {
    assert.deepEqual(await resolveWindowShare(href, read), GENERIC_WINDOW_SHARE)
  }
  assert.equal(reads, 0)
})

test('failed, non-JSON, and oversized public card reads fall back without stale names', async () => {
  const replies = [
    new Response('down', { status: 503 }),
    new Response('<html>not json</html>', { headers: { 'content-type': 'text/html' } }),
    jsonBytes({ listing: { title: 'x'.repeat(70_000) } }),
  ]
  for (const response of replies) {
    const meta = await resolveWindowShare(
      'https://preview.example/window?item=31',
      async () => response,
    )
    assert.equal(meta.canonicalUrl, 'https://1f3ea.com/window?item=31')
    assert.equal(meta.title, 'Item #31 — 1F3EA')
    assert.doesNotMatch(meta.title + meta.description, /x{100}|stale/i)
  }

  const missing = await resolveWindowShare(
    'https://preview.example/window?item=31',
    async () => jsonBytes({ error: 'no such listing' }, 404),
  )
  assert.equal(missing.title, 'Item #31 is not in 1F3EA')
  assert.match(missing.description, /No item with this number/i)

  for (const response of [
    jsonBytes({ error: 'temporarily unavailable' }, 503),
    new Response('{not-json', { headers: { 'content-type': 'application/json' } }),
    jsonBytes({ store: { handle: 'another-store', line: 'wrong row' } }),
  ]) {
    const store = await resolveWindowShare(
      'https://preview.example/window?store=tiny-shop',
      async () => response,
    )
    assert.equal(store.canonicalUrl, 'https://1f3ea.com/window?store=tiny-shop')
    assert.equal(store.title, 'Storefront unavailable — 1F3EA')
    assert.doesNotMatch(store.title + store.description, /tiny-shop|another-store|wrong row/i)
  }
})

test('a stalled public read reaches the honest card fallback after its fixed deadline', async () => {
  const started = Date.now()
  const meta = await resolveWindowShare(
    'https://preview.example/window?item=77',
    async () => new Promise<Response>(() => {}),
    10,
  )
  assert.equal(meta.title, 'Item #77 — 1F3EA')
  assert.match(meta.description, /could not be read just now/i)
  assert.ok(Date.now() - started < 500)
})

test('a public response body that stalls after headers reaches the same deadline', { timeout: 500 }, async () => {
  const started = Date.now()
  const meta = await resolveWindowShare(
    'https://preview.example/window?store=tiny-shop',
    async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"store":'))
      },
    }), { headers: { 'content-type': 'application/json' } }),
    10,
  )
  assert.equal(meta.title, 'Storefront unavailable — 1F3EA')
  assert.match(meta.description, /could not be read just now/i)
  assert.ok(Date.now() - started < 500)
})
