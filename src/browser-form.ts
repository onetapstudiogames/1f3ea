import type { Context } from 'hono'

export type BoundedFormReadResult =
  | { kind: 'form'; values: URLSearchParams }
  | { kind: 'invalid' }
  | { kind: 'unreadable' }

export async function readBoundedForm(
  c: Context,
  maximumBytes = 8_192,
): Promise<URLSearchParams | null> {
  const result = await readBoundedFormResult(c, maximumBytes)
  return result.kind === 'form' ? result.values : null
}

// See src/bounded-json.ts for the full root-cause writeup (issue #39, 2026-09-03): on Vercel's
// deployed Node runtime c.req.raw.body.getReader() never delivers a chunk even once the request
// body has fully arrived, while c.req.arrayBuffer() (Hono's proven fast path) resolves in under
// 1ms. Read through that fast path instead of hand-driving the raw stream reader; a read through
// it either resolves or rejects on its own, so no timeout/deadline is needed here either.
// Content-Length is deliberately never trusted to refuse a request on its own — see the
// 'ignores Content-Length claims' tests in test/browser-form.test.ts and
// test/market-identity-browser.test.ts — only the actual byte count of the body once read can.
//
// Round 2 (2026-09-03, PR #40): merely evaluating `c.req.raw.body` for presence — even without
// reading from it — is itself enough to poison every later c.req.arrayBuffer()/text()/json()
// call on the same request into hanging forever on Vercel's deployed runtime; see the round-2
// note in src/bounded-json.ts for the exact @hono/node-server 2.1.0 mechanism. So this function
// must never touch `c.req.raw.body` (or `.clone()`, `.formData()`, or `c.req.parseBody()`) on
// the request path. An absent body reads through c.req.arrayBuffer() as a zero-length buffer,
// which fails UTF-8/URLSearchParams parsing (or simply yields an empty form) exactly like any
// other malformed body — the content-type check alone is enough to gate this door.
export async function readBoundedFormResult(
  c: Context,
  maximumBytes = 8_192,
): Promise<BoundedFormReadResult> {
  const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/x-www-form-urlencoded') {
    return { kind: 'invalid' }
  }

  let buffer: ArrayBuffer
  try {
    buffer = await c.req.arrayBuffer()
  } catch {
    return { kind: 'unreadable' }
  }
  if (buffer.byteLength > maximumBytes) return { kind: 'invalid' }

  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return { kind: 'form', values: new URLSearchParams(decoded) }
  } catch {
    return { kind: 'invalid' }
  }
}

export function oneFormValue(
  values: URLSearchParams,
  name: string,
  maximumBytes = 4_096,
): string | null {
  const candidates = values.getAll(name)
  const value = candidates.length === 1 ? candidates[0] : null
  if (
    !value ||
    Buffer.byteLength(value, 'utf8') > maximumBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) return null
  return value
}

export function exactFormFields(
  values: URLSearchParams,
  allowed: readonly string[],
): boolean {
  const allowedNames = new Set(allowed)
  for (const name of values.keys()) {
    if (!allowedNames.has(name) || values.getAll(name).length !== 1) return false
  }
  return true
}

export function trustedBrowserForm(c: Context, publicOrigin: string): boolean {
  const requestOrigin = c.req.header('origin')
  if (requestOrigin && requestOrigin !== 'null') return requestOrigin === publicOrigin

  const referer = c.req.header('referer')
  if (referer) {
    try {
      return new URL(referer).origin === publicOrigin
    } catch {
      return false
    }
  }

  return c.req.header('sec-fetch-site') === 'same-origin'
    && c.req.header('sec-fetch-mode') === 'navigate'
    && c.req.header('sec-fetch-dest') === 'document'
}
