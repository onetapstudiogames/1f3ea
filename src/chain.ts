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

let rpcId = 0
async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    })
    if (!res.ok) return null
    const j = (await res.json()) as { result?: T }
    return j.result ?? null
  } catch {
    return null
  }
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

/** Recover a wallet from a canonical 65-byte EIP-191 personal signature. */
export async function recoverPersonalSigner(message: string, signature: string): Promise<string | null> {
  if (typeof message !== 'string' || typeof signature !== 'string') return null
  const parsed = parsePersonalSignature(signature)
  if (!parsed) return null

  const messageBytes = Buffer.from(message, 'utf8')
  const prefixBytes = Buffer.from(`\x19Ethereum Signed Message:\n${messageBytes.byteLength}`, 'utf8')
  const personalBytes = Buffer.concat([prefixBytes, messageBytes])
  const hash = await rpc<unknown>('web3_sha3', [`0x${personalBytes.toString('hex')}`])
  if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) return null

  const callData = [
    hash.slice(2).toLowerCase(),
    parsed.v.toString(16).padStart(64, '0'),
    parsed.r,
    parsed.s,
  ].join('')
  const recovered = await rpc<unknown>('eth_call', [
    { to: ECRECOVER_PRECOMPILE, data: `0x${callData}` },
    'latest',
  ])
  if (typeof recovered !== 'string') return null
  const paddedAddress = /^0x0{24}([0-9a-f]{40})$/i.exec(recovered)
  if (!paddedAddress?.[1] || /^0{40}$/.test(paddedAddress[1])) return null
  return `0x${paddedAddress[1].toLowerCase()}`
}

/** Verify that a personal signature was made by the expected Base wallet. */
export async function verifyPersonalSignature(
  message: string,
  signature: string,
  expectedWallet: string,
): Promise<boolean> {
  if (typeof expectedWallet !== 'string' || !WALLET_RE.test(expectedWallet)) return false
  const recovered = await recoverPersonalSigner(message, signature)
  return recovered !== null && recovered === expectedWallet.toLowerCase()
}

export function toUnits(usdc: number): bigint {
  // numeric(12,6) from the DB → 6-decimal atomic units, exact.
  return BigInt(Math.round(usdc * 1e6))
}

const pad32 = (addr: string) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')
const addrFromTopic = (topic: string) => '0x' + topic.slice(-40)

function parseHexBigInt(value: string): bigint | null {
  if (!/^0x[0-9a-fA-F]+$/u.test(value)) return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

interface Log { address: string; topics: string[]; data: string }
interface Receipt { status: string; blockHash: string; blockNumber: string; logs: Log[] }

export interface VerifiedTransfer {
  from: string
  to: string
  amount: bigint
  blockTime: Date
  blockNumber: bigint
  blockHash: string
  finalizedAt: Date
}

export type TransferCheck =
  | ({ state: 'matched' } & VerifiedTransfer)
  | { state: 'pending' }
  | { state: 'invalid_final'; reason: 'failed_transaction' | 'confirmed_mismatch' }

function completeReceipt(value: unknown): Receipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const receipt = value as Partial<Receipt>
  if (
    !['0x0', '0x1'].includes(String(receipt.status)) ||
    typeof receipt.blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/u.test(receipt.blockHash) ||
    typeof receipt.blockNumber !== 'string' || !/^0x[0-9a-fA-F]+$/u.test(receipt.blockNumber) ||
    !Array.isArray(receipt.logs)
  ) return null
  for (const log of receipt.logs) {
    if (
      !log || typeof log !== 'object' || typeof log.address !== 'string' ||
      !Array.isArray(log.topics) || log.topics.some(topic => typeof topic !== 'string') ||
      typeof log.data !== 'string' || !/^0x[0-9a-fA-F]*$/u.test(log.data)
    ) return null
  }
  return receipt as Receipt
}

async function finalizedReceipt(receipt: Receipt): Promise<'finalized' | 'pending'> {
  const canonical = await rpc<{ hash?: unknown; number?: unknown }>(
    'eth_getBlockByNumber',
    [receipt.blockNumber, false],
  )
  if (
    !canonical || typeof canonical.hash !== 'string' || typeof canonical.number !== 'string' ||
    canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    canonical.number.toLowerCase() !== receipt.blockNumber.toLowerCase()
  ) return 'pending'
  const finalized = await rpc<{ number?: unknown }>('eth_getBlockByNumber', ['finalized', false])
  if (!finalized || typeof finalized.number !== 'string' || !/^0x[0-9a-fA-F]+$/u.test(finalized.number)) {
    return 'pending'
  }
  try {
    return BigInt(finalized.number) >= BigInt(receipt.blockNumber) ? 'finalized' : 'pending'
  } catch {
    return 'pending'
  }
}

/**
 * Proof check for /api/claim and fee_tx_hash: did this tx move >= minUnits of USDC
 * to `to`, successfully, on Base? Uniqueness (one tx, one use) is the caller's
 * DB constraint.
 */
export async function classifyUsdcTransfer(
  txHash: string,
  to: string,
  minUnits: bigint,
  options: { expectedFrom?: string; exactAmount?: boolean } = {},
): Promise<TransferCheck> {
  const rawReceipt = await rpc<unknown>('eth_getTransactionReceipt', [txHash])
  if (!rawReceipt) return { state: 'pending' }
  const receipt = completeReceipt(rawReceipt)
  if (!receipt) return { state: 'pending' }
  if (receipt.status === '0x0') {
    return await finalizedReceipt(receipt) === 'finalized'
      ? { state: 'invalid_final', reason: 'failed_transaction' }
      : { state: 'pending' }
  }

  const toTopic = pad32(to)
  let transfer: { log: Log; amount: bigint } | undefined
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() !== USDC.toLowerCase() ||
      log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC ||
      (log.topics[2] ?? '').toLowerCase() !== toTopic ||
      (options.expectedFrom != null &&
        addrFromTopic(log.topics[1] ?? '').toLowerCase() !== options.expectedFrom.toLowerCase())
    ) continue

    const amount = parseHexBigInt(log.data)
    if (amount == null) continue
    if (options.exactAmount === true ? amount === minUnits : amount >= minUnits) {
      transfer = { log, amount }
      break
    }
  }
  if (!transfer) {
    return await finalizedReceipt(receipt) === 'finalized'
      ? { state: 'invalid_final', reason: 'confirmed_mismatch' }
      : { state: 'pending' }
  }
  const fromTopic = transfer.log.topics[1]
  if (!fromTopic || !/^0x[0-9a-fA-F]{64}$/u.test(fromTopic)) return { state: 'pending' }
  if (await finalizedReceipt(receipt) !== 'finalized') return { state: 'pending' }

  const block = await rpc<{ timestamp: string }>('eth_getBlockByHash', [receipt.blockHash, false])
  if (!block || typeof block.timestamp !== 'string' || !/^0x[0-9a-fA-F]+$/u.test(block.timestamp)) {
    return { state: 'pending' }
  }
  const blockTime = new Date(Number(BigInt(block.timestamp)) * 1000)
  if (Number.isNaN(blockTime.getTime())) return { state: 'pending' }
  return {
    state: 'matched',
    from: addrFromTopic(fromTopic),
    to,
    amount: transfer.amount,
    blockTime,
    blockNumber: BigInt(receipt.blockNumber),
    blockHash: receipt.blockHash.toLowerCase(),
    finalizedAt: new Date(),
  }
}

export async function verifyUsdcTransfer(
  txHash: string,
  to: string,
  minUnits: bigint,
): Promise<VerifiedTransfer | null> {
  const checked = await classifyUsdcTransfer(txHash, to, minUnits)
  return checked.state === 'matched'
    ? {
      from: checked.from,
      to: checked.to,
      amount: checked.amount,
      blockTime: checked.blockTime,
      blockNumber: checked.blockNumber,
      blockHash: checked.blockHash,
      finalizedAt: checked.finalizedAt,
    }
    : null
}

/** Treasury balance for the public books. Returns a decimal string or null if the RPC is down. */
export async function usdcBalance(address: string): Promise<string | null> {
  const result = await rpc<string>('eth_call', [
    { to: USDC, data: BALANCE_OF + pad32(address).slice(2) },
    'latest',
  ])
  if (!result) return null
  return (Number(BigInt(result)) / 1e6).toFixed(6)
}
