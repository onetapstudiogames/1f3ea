const SHA256_HASH = /^[0-9a-f]{64}$/

export function requireOAuthHash(value: string, name: string): void {
  if (!SHA256_HASH.test(value)) throw new Error(`${name} must be a lowercase sha256 hash`)
}

export function requireInitialRecoveryCodeHashes(hashes: readonly string[]): void {
  if (
    hashes.length !== 8 ||
    new Set(hashes).size !== 8 ||
    hashes.some(hash => !SHA256_HASH.test(hash))
  ) {
    throw new Error('exactly eight unique sha256 recovery-code hashes are required')
  }
}
