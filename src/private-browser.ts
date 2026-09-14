import type { Context } from 'hono'

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}

export function privateBrowserHeaders(c: Context, html = false, validatedRedirectUri?: string): void {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  c.header('Referrer-Policy', html ? 'same-origin' : 'no-referrer')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.res.headers.delete('Access-Control-Allow-Origin')
  c.res.headers.delete('Access-Control-Allow-Credentials')
  if (html) {
    // Only OAuth forms supply a callback already matched to the client's registration.
    // Keep its exact origin, including a verified loopback client's ephemeral port.
    const callbackOrigin = validatedRedirectUri ? new URL(validatedRedirectUri).origin : undefined
    const callbackSources = callbackOrigin === 'https://chatgpt.com'
      ? `${callbackOrigin} https://platform.openai.com`
      : callbackOrigin
    const formAction = callbackSources ? `form-action 'self' ${callbackSources}; ` : "form-action 'self'; "
    c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; " + formAction + "base-uri 'none'; frame-ancestors 'none'",
    )
  }
}
