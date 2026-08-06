// Read-only Base mainnet access, hand-rolled JSON-RPC — no SDK, no keys, no writes.
// The market only ever LOOKS at the chain; the facilitator and the buyers move money.

export const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
export const NETWORK = 'base'

// keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer event topic.
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
// 4-byte selector of balanceOf(address)
const BALANCE_OF = '0x70a08231'

const RPC = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org'

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

export function toUnits(usdc: number): bigint {
  // numeric(12,6) from the DB → 6-decimal atomic units, exact.
  return BigInt(Math.round(usdc * 1e6))
}

const pad32 = (addr: string) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')
const addrFromTopic = (topic: string) => '0x' + topic.slice(-40)

interface Log { address: string; topics: string[]; data: string }
interface Receipt { status: string; blockHash: string; logs: Log[] }

export interface VerifiedTransfer {
  from: string
  to: string
  amount: bigint
  blockTime: Date
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
): Promise<VerifiedTransfer | null> {
  const receipt = await rpc<Receipt>('eth_getTransactionReceipt', [txHash])
  if (!receipt || receipt.status !== '0x1') return null

  const toTopic = pad32(to)
  const hit = receipt.logs.find(
    l =>
      l.address.toLowerCase() === USDC.toLowerCase() &&
      l.topics[0] === TRANSFER_TOPIC &&
      (l.topics[2] ?? '').toLowerCase() === toTopic &&
      BigInt(l.data) >= minUnits,
  )
  if (!hit) return null

  const block = await rpc<{ timestamp: string }>('eth_getBlockByHash', [receipt.blockHash, false])
  if (!block) return null
  return {
    from: addrFromTopic(hit.topics[1] ?? ''),
    to,
    amount: BigInt(hit.data),
    blockTime: new Date(Number(BigInt(block.timestamp)) * 1000),
  }
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
