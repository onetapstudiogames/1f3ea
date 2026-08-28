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

export async function readBoundedFormResult(
  c: Context,
  maximumBytes = 8_192,
): Promise<BoundedFormReadResult> {
  const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/x-www-form-urlencoded' || !c.req.raw.body) {
    return { kind: 'invalid' }
  }

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
