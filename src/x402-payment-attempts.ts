import { sql } from './db.ts'
import {
  BASE_USDC,
  normalizeRequirements,
  requireAmountUnits,
  requireAuthorizationSecond,
  requireResource,
  requireTransaction,
  requireWallet,
  validateX402ProofForOperation,
  type X402PaymentRequirements,
} from './x402-proof.ts'

export { x402ProofDigest } from './x402-proof.ts'
export type { X402PaymentRequirements } from './x402-proof.ts'

const DIGEST_RE = /^[0-9a-f]{64}$/u
const OPERATION_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u
const MAX_OPERATION_KEY_BYTES = 240
const MAX_REASON_BYTES = 240
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n
const OLD_BLOCK_REVIEW = 'this confirmed transaction predates this payment operation; no delivery was recorded; do not pay again'
const AUTH_WINDOW_REVIEW = 'this confirmed transaction is outside its signed authorization window; no delivery was recorded; do not pay again'

const OPERATION_KINDS = ['listing_fee', 'world_listing_fee', 'purchase'] as const
const ATTEMPT_STATUSES = ['settling', 'settled', 'verified', 'needs_review'] as const

export type X402PaymentOperationKind = typeof OPERATION_KINDS[number]
export type X402PaymentAttemptStatus = typeof ATTEMPT_STATUSES[number]

export interface X402PaymentAttempt {
  operation_key: string
  operation_kind: X402PaymentOperationKind
  proof_digest: string
  requirements_digest: string
  network: 'base'
  asset: string
  payee_wallet: string
  amount_units: string
  resource: string
  status: X402PaymentAttemptStatus
  tx_hash: string | null
  payer_wallet: string
  authorization_nonce: string
  authorization_valid_after: string
  authorization_valid_before: string
  start_block: string
  review_reason: string | null
  operation_started_at: string
  settlement_started_at: string
  settled_at: string | null
  finalized_block_number: string | null
  finalized_block_hash: string | null
  finalized_block_time: string | null
  finalized_at: string | null
  created_at: string
  updated_at: string
}

export interface BeginX402SettlementInput {
  operationKey: string
  operationKind: X402PaymentOperationKind
  operationStartedAt: Date
  startBlock: bigint
  paymentHeader: string
  requirements: X402PaymentRequirements
}

interface X402FinalityFactsInput {
  operationKey: string
  proofDigest: string
  transaction: string
  blockNumber: bigint
  blockHash: string
  blockTime: Date
  finalizedAt: Date
}

export type RecordX402FinalityInput = X402FinalityFactsInput & (
  | { outcome: 'verified'; reason?: never }
  | { outcome: 'needs_review'; reason: string }
)

type NormalizedTerms = Readonly<{
  operationKey: string
  operationKind: X402PaymentOperationKind
  proofDigest: string
  requirementsDigest: string
  asset: string
  payeeWallet: string
  amountUnits: string
  resource: string
  payerWallet: string
  authorizationNonce: string
  authorizationValidAfter: string
  authorizationValidBefore: string
  startBlock: string
  operationStartedAt: Date
}>

type NormalizedFinality = Readonly<{
  operationKey: string
  proofDigest: string
  transaction: string
  outcome: 'verified' | 'needs_review'
  blockNumber: string
  blockHash: string
  blockTime: Date
  finalizedAt: Date
  reviewReason: string | null
}>

export class X402PaymentAttemptConflictError extends Error {
  constructor(message = 'this payment operation is already bound to another proof or payment') {
    super(message)
    this.name = 'X402PaymentAttemptConflictError'
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function requireDigest(value: string, label: string): string {
  const normalized = value.toLowerCase()
  if (!DIGEST_RE.test(normalized)) throw new TypeError(`${label} must be a SHA-256 digest`)
  return normalized
}

function requireOperationKey(value: string): string {
  if (
    byteLength(value) < 1
    || byteLength(value) > MAX_OPERATION_KEY_BYTES
    || !OPERATION_KEY_RE.test(value)
  ) throw new TypeError('payment operation key is invalid')
  return value
}

function requireOperationKind(value: string): X402PaymentOperationKind {
  if (!(OPERATION_KINDS as readonly string[]).includes(value)) {
    throw new TypeError('payment operation kind is invalid')
  }
  return value as X402PaymentOperationKind
}

function requireTimestamp(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} must be a valid timestamp`)
  }
  return new Date(value.getTime())
}

function requireBlockNumber(value: bigint): string {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_POSTGRES_BIGINT) {
    throw new TypeError('finalized block number is outside the supported range')
  }
  return value.toString()
}

function requireStartBlock(value: bigint): string {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_POSTGRES_BIGINT) {
    throw new TypeError('payment start block is outside the supported range')
  }
  return value.toString()
}

function requireReason(value: string): string {
  if (byteLength(value) < 1 || byteLength(value) > MAX_REASON_BYTES) {
    throw new TypeError('payment review reason is outside its byte limit')
  }
  return value
}

function normalizeTerms(input: BeginX402SettlementInput): NormalizedTerms {
  const operationKey = requireOperationKey(input.operationKey)
  const operationKind = requireOperationKind(input.operationKind)
  const validated = validateX402ProofForOperation(
    input.paymentHeader, input.requirements, input.operationStartedAt,
  )
  const { proof, requirements, operationStartedAt } = validated
  const { asset, payeeWallet, amountUnits, resource } = requirements
  return {
    operationKey,
    operationKind,
    proofDigest: proof.digest,
    requirementsDigest: requirements.digest,
    asset,
    payeeWallet,
    amountUnits,
    resource,
    payerWallet: proof.payerWallet,
    authorizationNonce: proof.authorizationNonce,
    authorizationValidAfter: proof.authorizationValidAfter,
    authorizationValidBefore: proof.authorizationValidBefore,
    startBlock: requireStartBlock(input.startBlock),
    operationStartedAt,
  }
}

/** Fail closed unless a stored attempt still belongs to these exact public route terms. */
export function x402PaymentAttemptMatches(
  attempt: X402PaymentAttempt,
  expected: Readonly<{
    operationKey: string
    operationKind: X402PaymentOperationKind
    requirements: X402PaymentRequirements
  }>,
): boolean {
  try {
    const operationKey = requireOperationKey(expected.operationKey)
    const operationKind = requireOperationKind(expected.operationKind)
    const requirements = normalizeRequirements(expected.requirements)
    return attempt.operation_key === operationKey
      && attempt.operation_kind === operationKind
      && attempt.requirements_digest === requirements.digest
      && attempt.network === 'base'
      && attempt.asset === requirements.asset
      && attempt.payee_wallet === requirements.payeeWallet
      && attempt.amount_units === requirements.amountUnits
      && attempt.resource === requirements.resource
  } catch {
    return false
  }
}

function normalizeFinality(input: RecordX402FinalityInput): NormalizedFinality {
  if (input.outcome !== 'verified' && input.outcome !== 'needs_review') {
    throw new TypeError('finalized payment outcome is invalid')
  }
  const blockTime = requireTimestamp(input.blockTime, 'finalized transfer block time')
  const finalizedAt = requireTimestamp(input.finalizedAt, 'finality observation time')
  if (finalizedAt.getTime() < blockTime.getTime()) {
    throw new TypeError('finality observation cannot predate the finalized transfer block')
  }
  return {
    operationKey: requireOperationKey(input.operationKey),
    proofDigest: requireDigest(input.proofDigest, 'payment proof digest'),
    transaction: requireTransaction(input.transaction),
    outcome: input.outcome,
    blockNumber: requireBlockNumber(input.blockNumber),
    blockHash: requireTransaction(input.blockHash),
    blockTime,
    finalizedAt,
    reviewReason: input.outcome === 'needs_review' ? requireReason(input.reason) : null,
  }
}

function anchorFinality(attempt: X402PaymentAttempt, facts: NormalizedFinality): NormalizedFinality {
  if (facts.outcome !== 'verified') return facts
  if (BigInt(facts.blockNumber) < BigInt(attempt.start_block)) {
    return { ...facts, outcome: 'needs_review', reviewReason: OLD_BLOCK_REVIEW }
  }
  const blockSecond = BigInt(Math.floor(facts.blockTime.getTime() / 1000))
  if (
    blockSecond <= BigInt(attempt.authorization_valid_after)
    || blockSecond >= BigInt(attempt.authorization_valid_before)
  ) return { ...facts, outcome: 'needs_review', reviewReason: AUTH_WINDOW_REVIEW }
  return facts
}

function rowText(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (value == null) throw new TypeError(`stored payment attempt is missing ${key}`)
  return value instanceof Date ? value.toISOString() : String(value)
}

function nullableText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

function timestampText(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (value == null) throw new TypeError(`stored payment attempt is missing ${key}`)
  const timestamp = value instanceof Date ? value : new Date(String(value))
  if (!Number.isFinite(timestamp.getTime())) {
    throw new TypeError(`stored payment attempt has an invalid ${key}`)
  }
  return timestamp.toISOString()
}

function nullableTimestampText(row: Record<string, unknown>, key: string): string | null {
  return row[key] == null ? null : timestampText(row, key)
}

function attemptFromRow(row: Record<string, unknown> | undefined): X402PaymentAttempt | null {
  if (!row) return null
  const operationKind = requireOperationKind(rowText(row, 'operation_kind'))
  const statusValue = rowText(row, 'status')
  if (!(ATTEMPT_STATUSES as readonly string[]).includes(statusValue)) {
    throw new TypeError('stored payment attempt has an invalid state')
  }
  const network = rowText(row, 'network')
  if (network !== 'base') throw new TypeError('stored payment attempt has an invalid network')
  const asset = rowText(row, 'asset').toLowerCase()
  if (asset !== BASE_USDC) throw new TypeError('stored payment attempt has an invalid asset')
  const txHash = nullableText(row, 'tx_hash')
  const payerWallet = nullableText(row, 'payer_wallet')
  return {
    operation_key: requireOperationKey(rowText(row, 'operation_key')),
    operation_kind: operationKind,
    proof_digest: requireDigest(rowText(row, 'proof_digest'), 'stored proof digest'),
    requirements_digest: requireDigest(
      rowText(row, 'requirements_digest'),
      'stored requirements digest',
    ),
    network: 'base',
    asset,
    payee_wallet: requireWallet(rowText(row, 'payee_wallet'), 'stored payment recipient'),
    amount_units: requireAmountUnits(rowText(row, 'amount_units')),
    resource: requireResource(rowText(row, 'resource')),
    authorization_nonce: requireTransaction(rowText(row, 'authorization_nonce')),
    authorization_valid_after: requireAuthorizationSecond(rowText(row, 'authorization_valid_after')),
    authorization_valid_before: requireAuthorizationSecond(rowText(row, 'authorization_valid_before')),
    start_block: requireStartBlock(BigInt(rowText(row, 'start_block'))),
    status: statusValue as X402PaymentAttemptStatus,
    tx_hash: txHash == null ? null : requireTransaction(txHash),
    payer_wallet: payerWallet == null
      ? requireWallet('', 'stored payer')
      : requireWallet(payerWallet, 'stored payer'),
    review_reason: nullableText(row, 'review_reason'),
    operation_started_at: timestampText(row, 'operation_started_at'),
    settlement_started_at: timestampText(row, 'settlement_started_at'),
    settled_at: nullableTimestampText(row, 'settled_at'),
    finalized_block_number: nullableText(row, 'finalized_block_number'),
    finalized_block_hash: nullableText(row, 'finalized_block_hash'),
    finalized_block_time: nullableTimestampText(row, 'finalized_block_time'),
    finalized_at: nullableTimestampText(row, 'finalized_at'),
    created_at: timestampText(row, 'created_at'),
    updated_at: timestampText(row, 'updated_at'),
  }
}

function matchesTerms(attempt: X402PaymentAttempt, terms: NormalizedTerms): boolean {
  return attempt.operation_key === terms.operationKey
    && attempt.operation_kind === terms.operationKind
    && attempt.proof_digest === terms.proofDigest
    && attempt.requirements_digest === terms.requirementsDigest
    && attempt.network === 'base'
    && attempt.asset === terms.asset
    && attempt.payee_wallet === terms.payeeWallet
    && attempt.amount_units === terms.amountUnits
    && attempt.resource === terms.resource
    && attempt.payer_wallet === terms.payerWallet
    && attempt.authorization_nonce === terms.authorizationNonce
    && attempt.authorization_valid_after === terms.authorizationValidAfter
    && attempt.authorization_valid_before === terms.authorizationValidBefore
    && attempt.start_block === terms.startBlock
    && attempt.operation_started_at === terms.operationStartedAt.toISOString()
}

function matchesFinality(attempt: X402PaymentAttempt, facts: NormalizedFinality): boolean {
  return attempt.operation_key === facts.operationKey
    && attempt.proof_digest === facts.proofDigest
    && attempt.tx_hash === facts.transaction
    && attempt.status === facts.outcome
    && attempt.finalized_block_number === facts.blockNumber
    && attempt.finalized_block_hash === facts.blockHash
    && attempt.finalized_block_time === facts.blockTime.toISOString()
    && attempt.finalized_at === facts.finalizedAt.toISOString()
    && attempt.review_reason === facts.reviewReason
}

async function readAttempt(
  operationKey: string,
  proofDigest: string,
  payerWallet: string | null = null,
  authorizationNonce: string | null = null,
): Promise<X402PaymentAttempt | null> {
  const rows = (await sql`
    /* x402-payment-attempt:read */
    SELECT operation_key, operation_kind, proof_digest, requirements_digest,
      network, asset, payee_wallet, amount_units::text AS amount_units, resource,
      payer_wallet, authorization_nonce, authorization_valid_after::text,
      authorization_valid_before::text, start_block::text, status, tx_hash, review_reason,
      operation_started_at, settlement_started_at, settled_at,
      finalized_block_number::text AS finalized_block_number,
      finalized_block_hash, finalized_block_time, finalized_at, created_at, updated_at
    FROM x402_payment_attempts
    WHERE operation_key = ${operationKey} OR proof_digest = ${proofDigest}
      OR (
        ${payerWallet}::text IS NOT NULL AND ${authorizationNonce}::text IS NOT NULL
        AND network = 'base' AND asset = ${BASE_USDC}
        AND payer_wallet = ${payerWallet} AND authorization_nonce = ${authorizationNonce}
      )
    ORDER BY (operation_key = ${operationKey}) DESC
    LIMIT 1`) as Record<string, unknown>[]
  return attemptFromRow(rows[0])
}

/** Read custody before a route decides whether an unpaid request may receive a 402. */
export async function readX402PaymentAttempt(
  operationKey: string,
): Promise<X402PaymentAttempt | null> {
  const normalizedKey = requireOperationKey(operationKey)
  const rows = (await sql`
    /* x402-payment-attempt:read-operation */
    SELECT operation_key, operation_kind, proof_digest, requirements_digest,
      network, asset, payee_wallet, amount_units::text AS amount_units, resource,
      payer_wallet, authorization_nonce, authorization_valid_after::text,
      authorization_valid_before::text, start_block::text, status, tx_hash, review_reason,
      operation_started_at, settlement_started_at, settled_at,
      finalized_block_number::text AS finalized_block_number,
      finalized_block_hash, finalized_block_time, finalized_at, created_at, updated_at
    FROM x402_payment_attempts
    WHERE operation_key = ${normalizedKey}
    LIMIT 1`) as Record<string, unknown>[]
  return attemptFromRow(rows[0])
}

function conflict(): never {
  throw new X402PaymentAttemptConflictError()
}

/**
 * Call only after `/verify` approves these exact public requirements and
 * immediately before `/settle`. `operationStartedAt` must be captured by the
 * server before `/verify`; facilitator latency must never move that acceptance
 * anchor. Only a newly created attempt may start the facilitator call. Every
 * existing attempt means retry the same request and proof without paying again.
 */
export async function beginX402Settlement(
  input: BeginX402SettlementInput,
): Promise<{ disposition: 'created' | 'existing'; attempt: X402PaymentAttempt }> {
  const terms = normalizeTerms(input)
  const existing = await readAttempt(
    terms.operationKey,
    terms.proofDigest,
    terms.payerWallet,
    terms.authorizationNonce,
  )
  if (existing) {
    if (!matchesTerms(existing, terms)) conflict()
    return { disposition: 'existing', attempt: existing }
  }

  const rows = (await sql`
    /* x402-payment-attempt:reserve */
    INSERT INTO x402_payment_attempts (
      operation_key, operation_kind, proof_digest, requirements_digest,
      network, asset, payee_wallet, amount_units, resource,
      payer_wallet, authorization_nonce, authorization_valid_after,
      authorization_valid_before, start_block, operation_started_at,
      settlement_started_at, status
    ) VALUES (
      ${terms.operationKey}, ${terms.operationKind}, ${terms.proofDigest},
      ${terms.requirementsDigest}, 'base', ${terms.asset}, ${terms.payeeWallet},
      ${terms.amountUnits}, ${terms.resource}, ${terms.payerWallet},
      ${terms.authorizationNonce}, ${terms.authorizationValidAfter},
      ${terms.authorizationValidBefore}, ${terms.startBlock}, ${terms.operationStartedAt},
      GREATEST(statement_timestamp(), ${terms.operationStartedAt}), 'settling'
    )
    ON CONFLICT DO NOTHING
    RETURNING operation_key, operation_kind, proof_digest, requirements_digest,
      network, asset, payee_wallet, amount_units::text AS amount_units, resource,
      payer_wallet, authorization_nonce, authorization_valid_after::text,
      authorization_valid_before::text, start_block::text, status, tx_hash, review_reason,
      operation_started_at, settlement_started_at, settled_at,
      finalized_block_number::text AS finalized_block_number,
      finalized_block_hash, finalized_block_time, finalized_at,
      created_at, updated_at`) as Record<string, unknown>[]
  const created = attemptFromRow(rows[0])
  if (created) return { disposition: 'created', attempt: created }

  const raced = await readAttempt(
    terms.operationKey,
    terms.proofDigest,
    terms.payerWallet,
    terms.authorizationNonce,
  )
  if (!raced || !matchesTerms(raced, terms)) conflict()
  return { disposition: 'existing', attempt: raced }
}

export async function markX402SettlementNeedsReview(input: {
  operationKey: string
  proofDigest: string
  reason: string
}): Promise<X402PaymentAttempt> {
  const operationKey = requireOperationKey(input.operationKey)
  const proofDigest = requireDigest(input.proofDigest, 'payment proof digest')
  const reason = requireReason(input.reason)
  const rows = (await sql`
    /* x402-payment-attempt:review */
    WITH requested AS (
      SELECT ${operationKey}::text AS operation_key,
        ${proofDigest}::text AS proof_digest,
        ${reason}::text AS review_reason
    )
    UPDATE x402_payment_attempts AS attempt
    SET status = 'needs_review', review_reason = requested.review_reason,
      updated_at = GREATEST(
        clock_timestamp(), attempt.updated_at, attempt.settlement_started_at
      )
    FROM requested
    WHERE attempt.operation_key = requested.operation_key
      AND attempt.proof_digest = requested.proof_digest
      AND attempt.status = 'settling'
    RETURNING attempt.operation_key, attempt.operation_kind, attempt.proof_digest,
      attempt.requirements_digest, attempt.network, attempt.asset,
      attempt.payee_wallet, attempt.amount_units::text AS amount_units,
      attempt.resource, attempt.payer_wallet, attempt.authorization_nonce,
      attempt.authorization_valid_after::text, attempt.authorization_valid_before::text,
      attempt.start_block::text,
      attempt.status, attempt.tx_hash,
      attempt.review_reason, attempt.operation_started_at,
      attempt.settlement_started_at, attempt.settled_at,
      attempt.finalized_block_number::text AS finalized_block_number,
      attempt.finalized_block_hash, attempt.finalized_block_time,
      attempt.finalized_at, attempt.created_at, attempt.updated_at`) as Record<string, unknown>[]
  const reviewed = attemptFromRow(rows[0])
  if (reviewed) return reviewed
  const current = await readAttempt(operationKey, proofDigest)
  if (!current || current.operation_key !== operationKey || current.proof_digest !== proofDigest) conflict()
  return current
}

/**
 * Record only the facilitator-reported transaction. This state is not chain
 * finality and must never authorize delivery by itself.
 */
export async function recordX402Settlement(input: {
  operationKey: string
  proofDigest: string
  transaction: string
  payerWallet: string
}): Promise<X402PaymentAttempt> {
  const operationKey = requireOperationKey(input.operationKey)
  const proofDigest = requireDigest(input.proofDigest, 'payment proof digest')
  const transaction = requireTransaction(input.transaction)
  const payerWallet = requireWallet(input.payerWallet, 'settled payer')
  const rows = (await sql`
    /* x402-payment-attempt:settled */
    WITH requested AS (
      SELECT ${operationKey}::text AS operation_key,
        ${proofDigest}::text AS proof_digest,
        ${transaction}::text AS tx_hash,
        ${payerWallet}::text AS payer_wallet
    )
    UPDATE x402_payment_attempts AS attempt
    SET status = 'settled', tx_hash = requested.tx_hash,
      review_reason = NULL,
      settled_at = coalesce(
        attempt.settled_at,
        GREATEST(
          clock_timestamp(), attempt.updated_at, attempt.settlement_started_at
        )
      ),
      updated_at = GREATEST(
        clock_timestamp(), attempt.updated_at, attempt.settlement_started_at
      )
    FROM requested
    WHERE attempt.operation_key = requested.operation_key
      AND attempt.proof_digest = requested.proof_digest
      AND attempt.status IN ('settling', 'needs_review')
      AND attempt.tx_hash IS NULL
      AND attempt.finalized_block_number IS NULL
      AND attempt.payer_wallet = requested.payer_wallet
    RETURNING attempt.operation_key, attempt.operation_kind, attempt.proof_digest,
      attempt.requirements_digest, attempt.network, attempt.asset,
      attempt.payee_wallet, attempt.amount_units::text AS amount_units,
      attempt.resource, attempt.payer_wallet, attempt.authorization_nonce,
      attempt.authorization_valid_after::text, attempt.authorization_valid_before::text,
      attempt.start_block::text,
      attempt.status, attempt.tx_hash,
      attempt.review_reason, attempt.operation_started_at,
      attempt.settlement_started_at, attempt.settled_at,
      attempt.finalized_block_number::text AS finalized_block_number,
      attempt.finalized_block_hash, attempt.finalized_block_time,
      attempt.finalized_at, attempt.created_at, attempt.updated_at`) as Record<string, unknown>[]
  const settled = attemptFromRow(rows[0])
  if (settled) return settled
  const current = await readAttempt(operationKey, proofDigest)
  if (
    !current
    || current.operation_key !== operationKey
    || current.proof_digest !== proofDigest
    || !['settled', 'verified', 'needs_review'].includes(current.status)
    || current.tx_hash !== transaction
    || current.payer_wallet !== payerWallet
  ) conflict()
  return current
}

/**
 * Persist the canonical Base observation after a facilitator transaction has
 * been stored. A matching exact transfer becomes terminal `verified`; a
 * finalized contradiction becomes terminal `needs_review` with the same full
 * evidence. Observation time may be later than the transfer block time.
 */
export async function recordX402Finality(
  input: RecordX402FinalityInput,
): Promise<X402PaymentAttempt> {
  const requestedFacts = normalizeFinality(input)
  const stored = await readAttempt(requestedFacts.operationKey, requestedFacts.proofDigest)
  if (
    !stored
    || stored.operation_key !== requestedFacts.operationKey
    || stored.proof_digest !== requestedFacts.proofDigest
    || stored.tx_hash !== requestedFacts.transaction
  ) conflict()
  const facts = anchorFinality(stored, requestedFacts)
  if (stored.status !== 'settled') {
    if (matchesFinality(stored, facts)) return stored
    conflict()
  }
  const rows = (await sql`
    /* x402-payment-attempt:finality */
    WITH requested AS (
      SELECT ${facts.operationKey}::text AS operation_key,
        ${facts.proofDigest}::text AS proof_digest,
        ${facts.transaction}::text AS tx_hash,
        ${facts.outcome}::text AS status,
        ${facts.blockNumber}::bigint AS finalized_block_number,
        ${facts.blockHash}::text AS finalized_block_hash,
        ${facts.blockTime}::timestamptz AS finalized_block_time,
        ${facts.finalizedAt}::timestamptz AS finalized_at,
        ${facts.reviewReason}::text AS review_reason
    )
    UPDATE x402_payment_attempts AS attempt
    SET status = requested.status,
      finalized_block_number = requested.finalized_block_number,
      finalized_block_hash = requested.finalized_block_hash,
      finalized_block_time = requested.finalized_block_time,
      finalized_at = requested.finalized_at,
      review_reason = requested.review_reason,
      updated_at = GREATEST(
        clock_timestamp(), attempt.updated_at, requested.finalized_at
      )
    FROM requested
    WHERE attempt.operation_key = requested.operation_key
      AND attempt.proof_digest = requested.proof_digest
      AND attempt.tx_hash = requested.tx_hash
      AND attempt.status = 'settled'
      AND requested.finalized_at >= requested.finalized_block_time
    RETURNING attempt.operation_key, attempt.operation_kind, attempt.proof_digest,
      attempt.requirements_digest, attempt.network, attempt.asset,
      attempt.payee_wallet, attempt.amount_units::text AS amount_units,
      attempt.resource, attempt.payer_wallet, attempt.authorization_nonce,
      attempt.authorization_valid_after::text, attempt.authorization_valid_before::text,
      attempt.start_block::text,
      attempt.status, attempt.tx_hash, attempt.review_reason,
      attempt.operation_started_at, attempt.settlement_started_at,
      attempt.settled_at,
      attempt.finalized_block_number::text AS finalized_block_number,
      attempt.finalized_block_hash, attempt.finalized_block_time,
      attempt.finalized_at, attempt.created_at, attempt.updated_at`) as Record<string, unknown>[]
  const recorded = attemptFromRow(rows[0])
  if (recorded) return recorded

  const current = await readAttempt(facts.operationKey, facts.proofDigest)
  if (!current || !matchesFinality(current, facts)) conflict()
  return current
}

export function x402PaymentRetryInstruction(
  _attempt: X402PaymentAttempt,
): { retry: string; do_not_pay_again: true } {
  return {
    retry: 'retry this same request without X-PAYMENT',
    do_not_pay_again: true,
  }
}
