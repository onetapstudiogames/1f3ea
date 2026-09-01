import { createHash } from 'node:crypto'

export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

const WALLET_RE = /^0x[0-9a-f]{40}$/u
const TX_HASH_RE = /^0x[0-9a-f]{64}$/u
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/u
export const X402_PAYMENT_HEADER_MAX_BYTES = 16_000
const MAX_RESOURCE_BYTES = 2_048
const MAX_PROOF_JSON_DEPTH = 64
const MAX_PROOF_JSON_NODES = 2_048
const MAX_MARKET_PAYMENT_UNITS = 10_000_000_000n
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER)

export interface X402PaymentRequirements {
  network: 'base'
  asset: string
  payTo: string
  maxAmountRequired: string
  resource: string
}

export type NormalizedX402Requirements = Readonly<{
  digest: string
  asset: string
  payeeWallet: string
  amountUnits: string
  resource: string
}>

export type X402ProofIdentity = Readonly<{
  digest: string
  payerWallet: string
  payeeWallet: string
  amountUnits: string
  authorizationNonce: string
  authorizationValidAfter: string
  authorizationValidBefore: string
}>

type CanonicalJson = null | boolean | string | number | CanonicalJson[] | {
  [key: string]: CanonicalJson
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export function requireWallet(value: string, label: string): string {
  const normalized = value.toLowerCase()
  if (!WALLET_RE.test(normalized)) throw new TypeError(`${label} must be a Base wallet address`)
  return normalized
}

export function requireTransaction(value: string, label = 'settled transaction'): string {
  const normalized = value.toLowerCase()
  if (!TX_HASH_RE.test(normalized)) {
    throw new TypeError(`${label} must be a 0x-prefixed 32-byte hash`)
  }
  return normalized
}

export function requireAmountUnits(value: string): string {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError('payment amount must be a positive whole number of USDC units')
  }
  const units = BigInt(value)
  if (units > MAX_MARKET_PAYMENT_UNITS) {
    throw new TypeError('payment amount exceeds the market limit of 10000 USDC')
  }
  return units.toString()
}

export function requireResource(value: string): string {
  if (
    byteLength(value) < 1
    || byteLength(value) > MAX_RESOURCE_BYTES
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new TypeError('payment resource is invalid')
  return value
}

export function requireAuthorizationSecond(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError('X-PAYMENT authorization window is invalid')
  }
  const second = BigInt(value)
  if (second > MAX_SAFE_INTEGER) throw new TypeError('X-PAYMENT authorization window is invalid')
  return second.toString()
}

function normalizeJson(value: unknown, seen: Set<object>): CanonicalJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('X-PAYMENT proof uses an unsafe number')
    return value
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) {
      throw new TypeError('X-PAYMENT proof contains a sparse array')
    }
    return value.map(item => normalizeJson(item, seen))
  }
  if (!value || typeof value !== 'object') {
    throw new TypeError('X-PAYMENT proof must contain JSON values only')
  }
  if (seen.has(value)) throw new TypeError('X-PAYMENT proof contains a cycle')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('X-PAYMENT proof must contain plain JSON objects')
  }
  seen.add(value)
  try {
    const output = Object.create(null) as Record<string, CanonicalJson>
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = normalizeJson((value as Record<string, unknown>)[key], seen)
    }
    return output
  } finally {
    seen.delete(value)
  }
}

function assertBoundedProofComplexity(root: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    nodes += 1
    if (nodes > MAX_PROOF_JSON_NODES) {
      throw new TypeError('X-PAYMENT proof is too complex')
    }
    if (current.value === null || typeof current.value !== 'object') continue
    if (current.depth >= MAX_PROOF_JSON_DEPTH) {
      throw new TypeError('X-PAYMENT proof is too deeply nested')
    }
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>)
    for (const value of children) pending.push({ value, depth: current.depth + 1 })
  }
}

function parsedPaymentProof(paymentHeader: string): Readonly<{
  paymentPayload: Record<string, unknown>
  identity: X402ProofIdentity
}> {
  if (typeof paymentHeader !== 'string') {
    throw new TypeError('X-PAYMENT header is not valid base64 JSON')
  }
  const paymentHeaderBytes = byteLength(paymentHeader)
  if (paymentHeaderBytes < 1) throw new TypeError('X-PAYMENT header is not valid base64 JSON')
  if (paymentHeaderBytes > X402_PAYMENT_HEADER_MAX_BYTES) {
    throw new TypeError('X-PAYMENT proof is too large; the limit is 16,000 bytes')
  }
  if (!BASE64_RE.test(paymentHeader)) throw new TypeError('X-PAYMENT header is not valid base64 JSON')
  const decoded = Buffer.from(paymentHeader, 'base64')
  if (decoded.byteLength < 1 || decoded.toString('base64') !== paymentHeader) {
    throw new TypeError('X-PAYMENT proof must be canonical base64')
  }
  let value: unknown
  try {
    value = JSON.parse(decoded.toString('utf8'))
  } catch {
    throw new TypeError('X-PAYMENT proof must contain one JSON object')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('X-PAYMENT proof must contain one JSON object')
  }
  assertBoundedProofComplexity(value)
  const paymentPayload = value as Record<string, unknown>
  if (
    paymentPayload.x402Version !== 1
    || paymentPayload.scheme !== 'exact'
    || paymentPayload.network !== 'base'
  ) {
    throw new TypeError('X-PAYMENT proof must use x402 exact payment on Base')
  }
  const payload = paymentPayload.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('X-PAYMENT proof is missing its authorization')
  }
  const signature = (payload as Record<string, unknown>).signature
  const authorization = (payload as Record<string, unknown>).authorization
  if (
    typeof signature !== 'string'
    || byteLength(signature) < 1
    || byteLength(signature) > 512
    || !authorization
    || typeof authorization !== 'object'
    || Array.isArray(authorization)
  ) throw new TypeError('X-PAYMENT proof is missing its signed authorization')
  const fields = authorization as Record<string, unknown>
  const authorizationValidAfter = requireAuthorizationSecond(fields.validAfter)
  const authorizationValidBefore = requireAuthorizationSecond(fields.validBefore)
  if (BigInt(authorizationValidBefore) <= BigInt(authorizationValidAfter) + 1n) {
    throw new TypeError('X-PAYMENT authorization window is invalid')
  }
  const canonical = JSON.stringify(normalizeJson(value, new Set()))
  return {
    paymentPayload,
    identity: {
      digest: createHash('sha256').update(canonical, 'utf8').digest('hex'),
      payerWallet: requireWallet(String(fields.from ?? ''), 'X-PAYMENT payer'),
      payeeWallet: requireWallet(String(fields.to ?? ''), 'X-PAYMENT recipient'),
      amountUnits: requireAmountUnits(String(fields.value ?? '')),
      authorizationNonce: requireTransaction(String(fields.nonce ?? ''), 'X-PAYMENT authorization nonce'),
      authorizationValidAfter,
      authorizationValidBefore,
    },
  }
}

export function proofIdentity(paymentHeader: string): X402ProofIdentity {
  return parsedPaymentProof(paymentHeader).identity
}

export function x402ProofDigest(paymentHeader: string): string {
  return proofIdentity(paymentHeader).digest
}

export function normalizeRequirements(
  requirements: X402PaymentRequirements,
): NormalizedX402Requirements {
  if (requirements.network !== 'base') throw new TypeError('x402 payment custody supports Base only')
  const asset = requirements.asset.toLowerCase()
  if (asset !== BASE_USDC) throw new TypeError('x402 payment custody supports Base USDC only')
  const payeeWallet = requireWallet(requirements.payTo, 'payment recipient')
  const amountUnits = requireAmountUnits(requirements.maxAmountRequired)
  const resource = requireResource(requirements.resource)
  const digest = createHash('sha256').update(JSON.stringify([
    requirements.network, asset, payeeWallet, amountUnits, resource,
  ])).digest('hex')
  return { digest, asset, payeeWallet, amountUnits, resource }
}

/** Validate signed public terms locally before any Base or facilitator call. */
export function validateX402ProofForOperation(
  paymentHeader: string,
  requirementsInput: X402PaymentRequirements,
  operationStartedAtInput: Date,
) {
  const { paymentPayload, identity: proof } = parsedPaymentProof(paymentHeader)
  const requirements = normalizeRequirements(requirementsInput)
  if (proof.payeeWallet !== requirements.payeeWallet || proof.amountUnits !== requirements.amountUnits) {
    throw new TypeError('X-PAYMENT authorization does not match these payment requirements')
  }
  if (!(operationStartedAtInput instanceof Date) || !Number.isFinite(operationStartedAtInput.getTime())) {
    throw new TypeError('payment operation start must be a valid timestamp')
  }
  const operationStartedAt = new Date(operationStartedAtInput.getTime())
  if (BigInt(Math.floor(operationStartedAt.getTime() / 1000)) >= BigInt(proof.authorizationValidBefore)) {
    throw new TypeError('X-PAYMENT authorization window does not overlap this payment operation')
  }
  return { proof, requirements, operationStartedAt, paymentPayload }
}
