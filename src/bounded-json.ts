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

/** Reads a bounded JSON object body the same way browser-form.ts bounds form bodies. */
export async function readBoundedJson(
  c: Context,
  maximumBytes = 8_192,
): Promise<BoundedJsonReadResult> {
  const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json' || !c.req.raw.body) return { kind: 'invalid' }

  const reader = c.req.raw.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      received += result.value.byteLength
      if (received > maximumBytes) {
        await reader.cancel()
        return { kind: 'invalid' }
      }
      chunks.push(result.value)
    }
  } catch {
    try { await reader.cancel() } catch {}
    return { kind: 'unreadable' }
  }

  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
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
