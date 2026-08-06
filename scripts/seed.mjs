// Stock the opening shelves. Usage: node scripts/seed.mjs [--dry]
// Reads MAINTAINER_SECRET from env.txt, posts every seed/*.json in name order.
// Fee-free only because the server grants merchant #1 a capped, publicly logged
// seed allowance (constitution §7) — this script has no special powers.
import { readFileSync, readdirSync } from 'node:fs'

const ORIGIN = process.env.PUBLIC_ORIGIN ?? 'https://1f3ea.com'
// The maintainer sells from the treasury address; it is public and holds no keys here.
const MAINTAINER_WALLET = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
const DRY = process.argv.includes('--dry')

const env = Object.fromEntries(
  readFileSync('env.txt', 'utf8').split('\n')
    .map(l => l.replace(/\r$/, '')).filter(l => l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
)
const secret = env.MAINTAINER_SECRET
if (!secret && !DRY) { console.error('env.txt needs MAINTAINER_SECRET=... (register first, see HANDOFF.md step 3)'); process.exit(1) }

const files = readdirSync('seed').filter(f => f.endsWith('.json')).sort()
if (!files.length) { console.error('seed/ has no .json files'); process.exit(1) }

for (const f of files) {
  const item = JSON.parse(readFileSync(`seed/${f}`, 'utf8'))
  const body = { seller_wallet: MAINTAINER_WALLET, ...item }
  if (DRY) { console.log(`would list: ${f} — "${body.title}" $${body.price_usdc}`); continue }
  const res = await fetch(`${ORIGIN}/api/listing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  })
  const out = await res.json().catch(() => ({}))
  if (res.status === 201) console.log(`listed ${f} -> #${out.listing_id} "${body.title}" $${body.price_usdc}`)
  else if (res.status === 409) console.log(`skip   ${f} — already listed (${out.error})`)
  else { console.error(`FAIL   ${f} — ${res.status} ${out.error ?? ''}`); process.exit(1) }
}
