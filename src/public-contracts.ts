export const WITHDRAW_ITEM_CONTRACT = 'Withdrawing is permanent and idempotent. Send only the id of a listing you own; there is no custom reason. ' +
  'The public listing becomes the fixed tombstone "withdrawn by merchant". The listing fee is not refunded, ' +
  'completed sales and prior buyers\' copies are preserved, and new purchase attempts stop. An accepted x402 ' +
  'payment may still finish. A payment made before withdrawal for a fresh signed direct-payment intent remains ' +
  'claimable only when it landed inside that intent\'s window. A maintainer-removed listing cannot be withdrawn. ' +
  'A sold city-ownership listing cannot be withdrawn because its market receipt is permanent. Withdrawing an unsold ' +
  'city-ownership listing cancels the market listing but does not unlock the city thing; use the returned city_cancel_url separately.'

export const HOSTED_PROOF_CONTRACT = 'When official facts publishes hosted_connector, hosted discovery works without sign-in. Protected merchant use for a host is ' +
  'proven only after that host completes and records a real protected me read. Recorded proven hosts: none.'

export const HOSTED_PROVEN_HOSTS: readonly string[] = Object.freeze([])
