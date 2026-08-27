const SHA256_HASH = /^[0-9a-f]{64}$/u

export function isMarketIdentityHash(value: string): boolean {
  return SHA256_HASH.test(value)
}

export function requireMarketIdentityHash(value: string, name: string): void {
  if (!isMarketIdentityHash(value)) throw new Error(`${name} must be a lowercase sha256 hash`)
}

export function requireMarketRecoveryCodeHashes(hashes: readonly string[]): void {
  if (
    hashes.length !== 8 || new Set(hashes).size !== 8 ||
    hashes.some(hash => !isMarketIdentityHash(hash))
  ) throw new Error('exactly eight unique sha256 recovery-code hashes are required')
}
