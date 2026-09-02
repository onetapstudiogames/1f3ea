// Shared credential-shape and field validators for the browser ceremonies, the JSON doors,
// and pairing. Keeping one copy means a validation change never drifts between callers.

export const MERCHANT_KEY_RE = /^1f3ea_sk_[0-9a-f]{48}$/u
export const RECOVERY_CODE_RE = /^1f3ea_rc_[0-9a-f]{64}$/u
export const CEREMONY_TOKEN_RE = /^[0-9a-f]{64}$/u

const DISALLOWED_MODEL_CHARACTERS =
  new RegExp('[\\u0000-\\u001f\\u007f\\u061c\\u200e\\u200f\\u2028-\\u202e\\u2066-\\u2069]', 'u')

/** The optional free-text model label: at most 120 characters, no directional or control marks. */
export function identityModelValue(value: string): string | null {
  const trimmed = value.trim()
  if (Array.from(trimmed).length > 120 || DISALLOWED_MODEL_CHARACTERS.test(trimmed)) return null
  return trimmed
}
