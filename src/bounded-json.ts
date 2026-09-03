import type { Context } from 'hono'

export type BoundedJsonReadResult =
  | { kind: 'json'; value: Record<string, unknown> }
  | { kind: 'invalid' }
  | { kind: 'unreadable' }

const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/u

// A JSON body reaches us as decoded UTF-8 text, but a `\uXXXX` escape inside a JSON string is
// unconstrained: JSON.parse happily produces a JS string holding a lone (unpaired) surrogate
// code unit, something no real UTF-8 byte stream — and so no browser form submission, which
// browser-form.ts decodes from real bytes — can ever produce. Left unrejected here, the JSON
// register door would accept a value (e.g. `model`) the equivalent browser door can never
// receive, so the two doors would not refuse the same input. Reject any lone surrogate so both
// doors agree.
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u

// 2026-09-03 production incident, root-caused 2026-09-03 on a deployed Vercel preview with a
// dedicated probe route (issue #39): with MARKET_CODING_IDENTITY_ENABLED=true, POST
// /api/register, /api/rotate, and /api/recovery never answered a `{}` or `{"action":"stage"}`
// body on Vercel's deployed Node runtime (Node v24.18.0) — curl gave up at 45s on every attempt.
// The probe proved the exact mechanism: on that runtime the IncomingMessage arrives already
// complete (complete=true, readableLength=body bytes, readableFlowing=null, no listeners,
// readableDidRead=false, no rawBody). In that state, @hono/node-server 2.1.0's fast path
// (c.req.text() / c.req.json() / c.req.arrayBuffer(), which reads the Node stream with
// data/end listeners) returns the body in under 1ms — but touching c.req.raw.body, which builds
// a web ReadableStream through Readable.toWeb(incoming), never delivers a single chunk: every
// reader.read() on it hangs forever. A local Node server does not reproduce this, so CI's
// app.request() helper (an in-process Request, never a real socket) cannot catch it either —
// this gap is why no test caught it originally. Read through the fast path instead of hand-driving
// the raw stream reader, matching every other JSON-body door in this codebase (which already
// uses c.req.json()/text() and never hung). A body read through the fast path either resolves or
// rejects on its own; there is no hang left here to bound with a deadline, so (unlike the
// short-lived 4s-timeout version of this fix) none is needed.
//
// Round 2 (2026-09-03, PR #40): the round-1 fix above still hung on the deployed Vercel runtime,
// because this function's own "does a body exist" guard read `c.req.raw.body` — the exact getter
// that triggers the failure. In @hono/node-server 2.1.0
// (node_modules/@hono/node-server/dist/index.mjs), `get body()` (~line 373) calls
// `this[getRequestCache]()`, which builds and CACHES a real global `Request` whose body is
// `Readable.toWeb(incoming)` (~line 350-372). Once that cache exists, `readBodyWithFastPath`
// (~line 216-234, which backs c.req.arrayBuffer()/text()/json()) sees `request[requestCache]` is
// already set and returns `request[requestCache][method]()` — i.e. it now reads through the very
// toWeb-wrapped cached Request instead of driving the Node stream directly, and that stream never
// delivers a chunk on Vercel's runtime. So merely evaluating `c.req.raw.body` for its presence —
// even without ever reading from it — poisons every later c.req.arrayBuffer()/text()/json() call
// on that same request into hanging forever. The fix is to never touch `c.req.raw.body` (or
// `.clone()`, `.formData()`, or `c.req.parseBody()`) on the request path at all: an absent body
// reads through c.req.arrayBuffer() as a zero-length buffer, which this function already refuses
// as 'invalid' via the same JSON-parse-failure path used for any other malformed body, so the
// content-type check alone is enough to gate this door.
//
// strict UTF-8 decoding is preserved deliberately rather than delegated to c.req.text(): the
// Fetch `Body.text()` UTF-8 decode is lenient (invalid sequences become U+FFFD) where this door's
// documented contract is fatal (invalid UTF-8 refuses as 'invalid'). Reading raw bytes via
// c.req.arrayBuffer() — the same proven fast path — and decoding them ourselves with a fatal
// TextDecoder keeps that contract exactly.
//
// Content-Length is deliberately never trusted to refuse a request on its own (see
// test/browser-form.test.ts and test/market-identity-browser.test.ts: a falsely large declared
// Content-Length with a small actual body must still succeed). Only the actual byte count of the
// body once read can refuse it.
async function readBoundedBytes(
  c: Context,
  maximumBytes: number,
): Promise<{ kind: 'bytes'; bytes: Uint8Array } | { kind: 'invalid' } | { kind: 'unreadable' }> {
  let buffer: ArrayBuffer
  try {
    buffer = await c.req.arrayBuffer()
  } catch {
    return { kind: 'unreadable' }
  }
  if (buffer.byteLength > maximumBytes) return { kind: 'invalid' }
  return { kind: 'bytes', bytes: new Uint8Array(buffer) }
}

/** Reads a bounded JSON object body the same way browser-form.ts bounds form bodies. */
export async function readBoundedJson(
  c: Context,
  maximumBytes = 8_192,
): Promise<BoundedJsonReadResult> {
  const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') return { kind: 'invalid' }

  const drained = await readBoundedBytes(c, maximumBytes)
  if (drained.kind !== 'bytes') return drained

  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(drained.bytes)
    const parsed: unknown = JSON.parse(decoded)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'invalid' }
    return { kind: 'json', value: parsed as Record<string, unknown> }
  } catch {
    return { kind: 'invalid' }
  }
}

/** One required string field: present, non-empty, byte-bounded, no control characters. */
export function jsonStringField(
  obj: Record<string, unknown>,
  name: string,
  maximumBytes = 4_096,
): string | null {
  const value = obj[name]
  if (
    typeof value !== 'string' || value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximumBytes ||
    CONTROL_CHARACTERS.test(value) || UNPAIRED_SURROGATE.test(value)
  ) return null
  return value
}

/** An optional string field: absent is null; present must still be a bounded, safe string (empty allowed). */
export function jsonOptionalStringField(
  obj: Record<string, unknown>,
  name: string,
  maximumBytes = 4_096,
): string | null | undefined {
  if (!(name in obj)) return undefined
  const value = obj[name]
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > maximumBytes ||
    CONTROL_CHARACTERS.test(value) || UNPAIRED_SURROGATE.test(value)
  ) return null
  return value
}

export function exactJsonFields(obj: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedNames = new Set(allowed)
  return Object.keys(obj).every(key => allowedNames.has(key))
}
