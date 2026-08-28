// Read-only Base mainnet access, hand-rolled JSON-RPC — no SDK, no keys, no writes.
// The market only ever LOOKS at the chain; the facilitator and the buyers move money.

export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const NETWORK = 'base'
const BASE_CHAIN_ID = '0x2105'

// keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer event topic.
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
// keccak256("AuthorizationUsed(address,bytes32)") — EIP-3009 replay protection.
const AUTHORIZATION_USED_TOPIC = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5'
// 4-byte selector of balanceOf(address)
const BALANCE_OF = '0x70a08231'

const RPC = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org'
const RPC_TIMEOUT_MS = 4_000

const SECP256K1_ORDER = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n
const ECRECOVER_PRECOMPILE = '0x0000000000000000000000000000000000000001'
const PERSONAL_SIGNATURE_RE = /^0x[0-9a-f]{130}$/i
const WALLET_RE = /^0x[0-9a-f]{40}$/i
const HASH_RE = /^0x[0-9a-f]{64}$/i
const HEX_DATA_RE = /^0x(?:[0-9a-f]{2})*$/i
const HEX_QUANTITY_RE = /^0x[0-9a-f]+$/i

export interface VerificationFailure {
  status: 'invalid' | 'unavailable'
  reason: string
  finality?: FinalityEvidence
}

type RpcResult<T> = { status: 'ok'; value: T } | { status: 'unavailable' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

let rpcId = 0
async function rpc<T>(method: string, params: unknown[]): Promise<RpcResult<T>> {
  let response: Response
  try {
    response = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    })
  } catch {
    return { status: 'unavailable' }
  }
  if (!response.ok) return { status: 'unavailable' }

  let decoded: unknown
  try {
    decoded = await response.json()
  } catch {
    return { status: 'unavailable' }
  }
  if (!isRecord(decoded) || !Object.hasOwn(decoded, 'result') || decoded.result === undefined) {
    return { status: 'unavailable' }
  }
  return { status: 'ok', value: decoded.result as T }
}

async function rpcIsBase(): Promise<boolean> {
  const chainId = await rpc<unknown>('eth_chainId', [])
  return chainId.status === 'ok' && chainId.value === BASE_CHAIN_ID
}

/** Capture the Base head before a facilitator can verify or broadcast a payment. */
export async function currentBaseBlockNumber(): Promise<bigint | null> {
  const block = await rpc<unknown>('eth_blockNumber', [])
  if (block.status === 'unavailable' || typeof block.value !== 'string' || !HEX_QUANTITY_RE.test(block.value)) {
    return null
  }
  try { return BigInt(block.value) } catch { return null }
}

interface ParsedPersonalSignature {
  r: string
  s: string
  v: number
}

function parsePersonalSignature(signature: string): ParsedPersonalSignature | null {
  if (!PERSONAL_SIGNATURE_RE.test(signature)) return null
  const bytes = signature.slice(2).toLowerCase()
  const r = bytes.slice(0, 64)
  const s = bytes.slice(64, 128)
  const suppliedV = Number.parseInt(bytes.slice(128), 16)
  if (suppliedV !== 0 && suppliedV !== 1 && suppliedV !== 27 && suppliedV !== 28) return null

  const rValue = BigInt(`0x${r}`)
  const sValue = BigInt(`0x${s}`)
  if (rValue < 1n || rValue >= SECP256K1_ORDER) return null
  if (sValue < 1n || sValue >= SECP256K1_ORDER || sValue > SECP256K1_HALF_ORDER) return null

  return { r, s, v: suppliedV < 27 ? suppliedV + 27 : suppliedV }
}

type PersonalSignerProof =
  | { status: 'verified'; signer: string }
  | VerificationFailure

const signatureUnavailable = (): VerificationFailure => ({
  status: 'unavailable',
  reason: 'the market could not check payer_signature on Base; retry the same proof later',
})

async function recoverPersonalSignerProof(message: string, signature: string): Promise<PersonalSignerProof> {
  if (typeof message !== 'string' || typeof signature !== 'string') {
    return { status: 'invalid', reason: 'payer_signature must be a canonical Base personal signature' }
  }
  const parsed = parsePersonalSignature(signature)
  if (!parsed) {
    return { status: 'invalid', reason: 'payer_signature must be a canonical Base personal signature' }
  }

  const messageBytes = Buffer.from(message, 'utf8')
  const prefixBytes = Buffer.from(`\x19Ethereum Signed Message:\n${messageBytes.byteLength}`, 'utf8')
  const personalBytes = Buffer.concat([prefixBytes, messageBytes])
  const hashResult = await rpc<unknown>('web3_sha3', [`0x${personalBytes.toString('hex')}`])
  if (hashResult.status === 'unavailable' || typeof hashResult.value !== 'string' || !HASH_RE.test(hashResult.value)) {
    return signatureUnavailable()
  }
  const hash = hashResult.value

  const callData = [
    hash.slice(2).toLowerCase(),
    parsed.v.toString(16).padStart(64, '0'),
    parsed.r,
    parsed.s,
  ].join('')
  const recoveredResult = await rpc<unknown>('eth_call', [
    { to: ECRECOVER_PRECOMPILE, data: `0x${callData}` },
    'latest',
  ])
  if (recoveredResult.status === 'unavailable' || typeof recoveredResult.value !== 'string') {
    return signatureUnavailable()
  }
  const recovered = recoveredResult.value
  const paddedAddress = /^0x0{24}([0-9a-f]{40})$/i.exec(recovered)
  if (!paddedAddress?.[1]) {
    if (recovered === '0x' || /^0x0{64}$/i.test(recovered)) {
      return {
        status: 'invalid',
        reason: 'payer_signature does not prove control of the expected payer wallet',
      }
    }
    return signatureUnavailable()
  }
  if (/^0{40}$/.test(paddedAddress[1])) {
    return {
      status: 'invalid',
      reason: 'payer_signature does not prove control of the expected payer wallet',
    }
  }
  return { status: 'verified', signer: `0x${paddedAddress[1].toLowerCase()}` }
}

/** Recover a wallet from a canonical 65-byte EIP-191 personal signature. */
export async function recoverPersonalSigner(message: string, signature: string): Promise<string | null> {
  const proof = await recoverPersonalSignerProof(message, signature)
  return proof.status === 'verified' ? proof.signer : null
}

/** Classify a signature as verified, caller-invalid, or temporarily unverifiable. */
export async function verifyPersonalSignatureProof(
  message: string,
  signature: string,
  expectedWallet: string,
): Promise<{ status: 'verified'; signer: string } | VerificationFailure> {
  if (typeof expectedWallet !== 'string' || !WALLET_RE.test(expectedWallet)) {
    return { status: 'invalid', reason: 'expected payer wallet is not a valid Base address' }
  }
  const proof = await recoverPersonalSignerProof(message, signature)
  if (proof.status !== 'verified') return proof
  if (proof.signer !== expectedWallet.toLowerCase()) {
    return {
      status: 'invalid',
      reason: 'payer_signature does not prove control of the expected payer wallet',
    }
  }
  return proof
}

/** Verify that a personal signature was made by the expected Base wallet. */
export async function verifyPersonalSignature(
  message: string,
  signature: string,
  expectedWallet: string,
): Promise<boolean> {
  const proof = await verifyPersonalSignatureProof(message, signature, expectedWallet)
  return proof.status === 'verified'
}

export function toUnits(usdc: number): bigint {
  // numeric(12,6) from the DB → 6-decimal atomic units, exact.
  return BigInt(Math.round(usdc * 1e6))
}

const pad32 = (addr: string) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')
const addrFromTopic = (topic: string) => '0x' + topic.slice(-40)

interface Log { address: string; topics: string[]; data: string }

export interface FinalityEvidence {
  blockTime: Date
  blockNumber: bigint
  blockHash: string
  finalizedAt: Date
}

export interface VerifiedTransfer extends FinalityEvidence {
  from: string
  to: string
  amount: bigint
}

export interface ObservedTransfer {
  from: string
  to: string
  amount: bigint
  blockNumber: bigint
  blockHash: string
}

export type TransferCheck =
  | ({ state: 'matched' } & VerifiedTransfer)
  | ({ state: 'matched_pending' } & ObservedTransfer)
  | { state: 'pending' }
  | { state: 'unavailable' }
  | ({ state: 'invalid_final'; reason: 'failed_transaction' | 'confirmed_mismatch' } & FinalityEvidence)

export type UsdcTransferVerification =
  | { status: 'verified'; transfer: VerifiedTransfer }
  | VerificationFailure

const paymentUnavailable = (detail = 'this payment'): VerificationFailure => ({
  status: 'unavailable',
  reason: `the market could not check ${detail} on Base; retry the same proof later`,
})

function formatUsdc(units: bigint): string {
  const whole = units / 1_000_000n
  const fraction = (units % 1_000_000n).toString().padStart(6, '0')
  return `${whole}.${fraction}`
}

interface Receipt {
  status: '0x0' | '0x1'
  transactionHash: string
  blockHash: string
  blockNumber: string
  logs: Log[]
}

function completeReceipt(value: unknown, expectedTransactionHash: string): Receipt | null {
  if (!isRecord(value)) return null
  if (
    !['0x0', '0x1'].includes(String(value.status)) ||
    typeof value.transactionHash !== 'string' || !HASH_RE.test(value.transactionHash) ||
    value.transactionHash.toLowerCase() !== expectedTransactionHash.toLowerCase() ||
    typeof value.blockHash !== 'string' || !HASH_RE.test(value.blockHash) ||
    typeof value.blockNumber !== 'string' || !HEX_QUANTITY_RE.test(value.blockNumber) ||
    !Array.isArray(value.logs)
  ) return null
  for (const log of value.logs) {
    if (
      !isRecord(log) || typeof log.address !== 'string' || !WALLET_RE.test(log.address) ||
      !Array.isArray(log.topics) || log.topics.some(topic => typeof topic !== 'string' || !HASH_RE.test(topic)) ||
      typeof log.data !== 'string' || !HEX_DATA_RE.test(log.data)
    ) return null
  }
  return value as unknown as Receipt
}

type ReceiptFinality =
  | ({ state: 'finalized' } & FinalityEvidence)
  | { state: 'canonical_pending' | 'pending' | 'unavailable' }

async function receiptFinality(receipt: Receipt): Promise<ReceiptFinality> {
  const finalized = await rpc<unknown>('eth_getBlockByNumber', ['finalized', false])
  if (finalized.status === 'unavailable') return { state: 'unavailable' }
  if (
    !isRecord(finalized.value) ||
    typeof finalized.value.number !== 'string' || !HEX_QUANTITY_RE.test(finalized.value.number)
  ) return { state: 'unavailable' }
  if (BigInt(finalized.value.number) < BigInt(receipt.blockNumber)) {
    return { state: 'canonical_pending' }
  }

  // Read the numbered block after observing a finalized head at or above it.
  // Reversing these calls can accept a receipt orphaned between the two reads.
  const canonical = await rpc<unknown>('eth_getBlockByNumber', [receipt.blockNumber, false])
  if (canonical.status === 'unavailable') return { state: 'unavailable' }
  if (canonical.value === null) return { state: 'pending' }
  if (
    !isRecord(canonical.value) ||
    typeof canonical.value.hash !== 'string' || !HASH_RE.test(canonical.value.hash) ||
    typeof canonical.value.number !== 'string' || !HEX_QUANTITY_RE.test(canonical.value.number)
  ) return { state: 'unavailable' }
  if (
    canonical.value.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    BigInt(canonical.value.number) !== BigInt(receipt.blockNumber)
  ) return { state: 'pending' }

  const blockResult = await rpc<unknown>('eth_getBlockByHash', [receipt.blockHash, false])
  if (
    blockResult.status === 'unavailable' || !isRecord(blockResult.value) ||
    typeof blockResult.value.hash !== 'string' || !HASH_RE.test(blockResult.value.hash) ||
    blockResult.value.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    typeof blockResult.value.number !== 'string' || !HEX_QUANTITY_RE.test(blockResult.value.number) ||
    BigInt(blockResult.value.number) !== BigInt(receipt.blockNumber) ||
    typeof blockResult.value.timestamp !== 'string' || !HEX_QUANTITY_RE.test(blockResult.value.timestamp)
  ) return { state: 'unavailable' }
  const blockTime = new Date(Number(BigInt(blockResult.value.timestamp)) * 1000)
  if (Number.isNaN(blockTime.getTime())) return { state: 'unavailable' }
  return {
    state: 'finalized',
    blockTime,
    blockNumber: BigInt(receipt.blockNumber),
    blockHash: receipt.blockHash.toLowerCase(),
    finalizedAt: new Date(),
  }
}

/**
 * Classify a Base USDC receipt only after its block is still canonical and the
 * finalized head has reached it. A pre-finality mismatch is never treated as
 * permanent because a reorg can still replace the receipt.
 */
export async function classifyUsdcTransfer(
  txHash: string,
  to: string,
  minimum: bigint,
  options: {
    expectedFrom?: string
    exactAmount?: boolean
    expectedAuthorizationNonce?: string
  } = {},
): Promise<TransferCheck> {
  if (!HASH_RE.test(txHash) || !WALLET_RE.test(to) || minimum <= 0n) return { state: 'pending' }
  if (options.expectedFrom != null && !WALLET_RE.test(options.expectedFrom)) return { state: 'pending' }
  if (
    options.expectedAuthorizationNonce != null
    && (!options.expectedFrom || !HASH_RE.test(options.expectedAuthorizationNonce))
  ) return { state: 'pending' }

  if (!await rpcIsBase()) return { state: 'unavailable' }
  const receiptResult = await rpc<unknown>('eth_getTransactionReceipt', [txHash])
  if (receiptResult.status === 'unavailable') return { state: 'unavailable' }
  if (receiptResult.value === null) return { state: 'pending' }
  const receipt = completeReceipt(receiptResult.value, txHash)
  if (!receipt) return { state: 'unavailable' }

  return classifyReceiptTransfer(receipt, to, minimum, options)
}

async function classifyReceiptTransfer(
  receipt: Receipt,
  to: string,
  minimum: bigint,
  options: {
    expectedFrom?: string
    exactAmount?: boolean
    expectedAuthorizationNonce?: string
  } = {},
): Promise<TransferCheck> {

  if (receipt.status === '0x0') {
    const finality = await receiptFinality(receipt)
    return finality.state === 'finalized'
      ? { ...finality, state: 'invalid_final', reason: 'failed_transaction' }
      : { state: finality.state === 'canonical_pending' ? 'pending' : finality.state }
  }

  const toTopic = pad32(to)
  let hit: Log | null = null
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() !== USDC.toLowerCase() ||
      log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC ||
      log.topics.length < 3 || log.topics[2]!.toLowerCase() !== toTopic
    ) continue
    const from = addrFromTopic(log.topics[1]!)
    if (options.expectedFrom != null && from.toLowerCase() !== options.expectedFrom.toLowerCase()) continue
    if (!HASH_RE.test(log.data)) continue
    const amount = BigInt(log.data)
    if (options.exactAmount === true ? amount === minimum : amount >= minimum) {
      hit = log
      break
    }
  }

  const authorizationUsed = options.expectedAuthorizationNonce == null
    ? true
    : receipt.logs.some(log =>
        log.address.toLowerCase() === USDC.toLowerCase()
        && log.topics.length === 3
        && log.topics[0]?.toLowerCase() === AUTHORIZATION_USED_TOPIC
        && log.topics[1]?.toLowerCase() === pad32(options.expectedFrom!)
        && log.topics[2]?.toLowerCase() === options.expectedAuthorizationNonce!.toLowerCase()
        && log.data === '0x',
      )

  if (!hit || !authorizationUsed) {
    const finality = await receiptFinality(receipt)
    return finality.state === 'finalized'
      ? { ...finality, state: 'invalid_final', reason: 'confirmed_mismatch' }
      : { state: finality.state === 'canonical_pending' ? 'pending' : finality.state }
  }
  const finality = await receiptFinality(receipt)
  if (finality.state === 'canonical_pending') {
    return {
      state: 'matched_pending',
      from: addrFromTopic(hit.topics[1]!),
      to,
      amount: BigInt(hit.data),
      blockNumber: BigInt(receipt.blockNumber),
      blockHash: receipt.blockHash.toLowerCase(),
    }
  }
  if (finality.state !== 'finalized') return { state: finality.state }

  return {
    state: 'matched',
    from: addrFromTopic(hit.topics[1]!),
    to,
    amount: BigInt(hit.data),
    blockTime: finality.blockTime,
    blockNumber: finality.blockNumber,
    blockHash: finality.blockHash,
    finalizedAt: finality.finalizedAt,
  }
}

/**
 * Proof check for /api/claim and fee_tx_hash: did this tx move >= minUnits of USDC
 * to `to`, successfully, on Base? Uniqueness (one tx, one use) is the caller's
 * DB constraint.
 */
export async function verifyUsdcTransfer(
  txHash: string,
  to: string,
  minUnits: bigint,
): Promise<UsdcTransferVerification> {
  if (!HASH_RE.test(txHash)) {
    return { status: 'invalid', reason: 'tx_hash must be a 0x-prefixed 32-byte transaction hash' }
  }
  if (!WALLET_RE.test(to)) {
    return { status: 'invalid', reason: 'payment destination must be a valid Base address' }
  }
  if (minUnits <= 0n) return { status: 'invalid', reason: 'payment minimum must be positive' }

  if (!await rpcIsBase()) return paymentUnavailable()
  const receiptResult = await rpc<unknown>('eth_getTransactionReceipt', [txHash])
  if (receiptResult.status === 'unavailable') return paymentUnavailable()
  if (receiptResult.value === null) {
    return {
      status: 'unavailable',
      reason: 'transaction is not yet visible or finalized on Base; retry the same tx_hash later',
    }
  }
  if (!isRecord(receiptResult.value)) {
    return paymentUnavailable('this payment because it returned an unreadable transaction receipt')
  }
  const receipt = completeReceipt(receiptResult.value, txHash)
  if (!receipt) {
    return paymentUnavailable('this payment because it returned an unreadable transaction receipt')
  }
  const check = await classifyReceiptTransfer(receipt, to, minUnits)
  if (check.state === 'pending' || check.state === 'matched_pending' || check.state === 'unavailable')
    return paymentUnavailable()
  if (check.state === 'invalid_final') {
    return check.reason === 'failed_transaction'
      ? {
          status: 'invalid',
          reason: 'transaction failed on Base',
          finality: check,
        }
      : {
          status: 'invalid',
          reason: `transaction did not transfer at least ${formatUsdc(minUnits)} USDC on Base to ${to}`,
          finality: check,
        }
  }
  return {
    status: 'verified',
    transfer: check,
  }
}

/** Treasury balance for the public books. Returns a decimal string or null if the RPC is down. */
export async function usdcBalance(address: string): Promise<string | null> {
  const response = await rpc<unknown>('eth_call', [
    { to: USDC, data: BALANCE_OF + pad32(address).slice(2) },
    'latest',
  ])
  if (
    response.status === 'unavailable' || typeof response.value !== 'string' ||
    !HEX_QUANTITY_RE.test(response.value)
  ) return null
  return (Number(BigInt(response.value)) / 1e6).toFixed(6)
}
