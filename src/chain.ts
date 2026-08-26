// Read-only Base mainnet access, hand-rolled JSON-RPC — no SDK, no keys, no writes.
// The market only ever LOOKS at the chain; the facilitator and the buyers move money.

export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const NETWORK = 'base'

// keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer event topic.
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
// 4-byte selector of balanceOf(address)
const BALANCE_OF = '0x70a08231'

const RPC = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org'

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
  reason: 'Base RPC could not verify payer_signature; retry the same proof later',
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

export interface VerifiedTransfer {
  from: string
  to: string
  amount: bigint
  blockTime: Date
}

export type UsdcTransferVerification =
  | { status: 'verified'; transfer: VerifiedTransfer }
  | VerificationFailure

const paymentUnavailable = (detail = 'this payment'): VerificationFailure => ({
  status: 'unavailable',
  reason: `Base RPC could not verify ${detail}; retry the same proof later`,
})

function formatUsdc(units: bigint): string {
  const whole = units / 1_000_000n
  const fraction = (units % 1_000_000n).toString().padStart(6, '0')
  return `${whole}.${fraction}`
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

  const receiptResult = await rpc<unknown>('eth_getTransactionReceipt', [txHash])
  if (receiptResult.status === 'unavailable') return paymentUnavailable()
  if (receiptResult.value === null) {
    return {
      status: 'invalid',
      reason: 'transaction was not found on Base; wait for it to finalize or check tx_hash',
    }
  }
  if (!isRecord(receiptResult.value)) {
    return paymentUnavailable('this payment because it returned an unreadable transaction receipt')
  }
  const receipt = receiptResult.value
  if (receipt.status === '0x0') return { status: 'invalid', reason: 'transaction failed on Base' }
  if (
    receipt.status !== '0x1' || typeof receipt.blockHash !== 'string' || !HASH_RE.test(receipt.blockHash) ||
    !Array.isArray(receipt.logs)
  ) {
    return paymentUnavailable('this payment because it returned an unreadable transaction receipt')
  }

  const toTopic = pad32(to)
  let hit: Log | null = null
  for (const candidate of receipt.logs) {
    if (
      !isRecord(candidate) || typeof candidate.address !== 'string' || !WALLET_RE.test(candidate.address) ||
      !Array.isArray(candidate.topics) || candidate.topics.some(topic => typeof topic !== 'string' || !HASH_RE.test(topic)) ||
      typeof candidate.data !== 'string' || !HEX_DATA_RE.test(candidate.data)
    ) {
      return paymentUnavailable('this payment because it returned an unreadable transaction receipt')
    }
    if (
      candidate.address.toLowerCase() !== USDC.toLowerCase() ||
      candidate.topics[0]?.toLowerCase() !== TRANSFER_TOPIC
    ) continue
    if (candidate.topics.length < 3 || !HASH_RE.test(candidate.data)) {
      return paymentUnavailable('this payment because it returned an unreadable transaction receipt')
    }
    if (candidate.topics[2]!.toLowerCase() !== toTopic) continue
    if (BigInt(candidate.data) >= minUnits) {
      hit = {
        address: candidate.address,
        topics: candidate.topics as string[],
        data: candidate.data,
      }
      break
    }
  }
  if (!hit) {
    return {
      status: 'invalid',
      reason: `transaction did not transfer at least ${formatUsdc(minUnits)} USDC on Base to ${to}`,
    }
  }

  const blockResult = await rpc<unknown>('eth_getBlockByHash', [receipt.blockHash, false])
  if (
    blockResult.status === 'unavailable' || !isRecord(blockResult.value) ||
    typeof blockResult.value.timestamp !== 'string' || !HEX_QUANTITY_RE.test(blockResult.value.timestamp)
  ) return paymentUnavailable('this payment block')
  const blockTime = new Date(Number(BigInt(blockResult.value.timestamp)) * 1000)
  if (Number.isNaN(blockTime.getTime())) return paymentUnavailable('this payment block')
  return {
    status: 'verified',
    transfer: {
      from: addrFromTopic(hit.topics[1]!),
      to,
      amount: BigInt(hit.data),
      blockTime,
    },
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
