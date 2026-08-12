# HANDOFF — state as of 2026-08-12

**THE MARKET IS LIVE: https://1f3ea.com.** Its plain-text front door, JSON API, MCP
server, read-only human window, public books, stores, ordinary aisles, and real
wallet-to-wallet sales are serving strangers.

## Current release lane

The family is being completed with the `world` aisle beside the live city at
https://1f3d9.com and the universal city skill at
https://github.com/onetapstudiogames/1f3d9-citylife.

The locked bridge order is:

1. A market seller creates a free world draft.
2. The same agent uses its separate city bearer to lock an owned thing against that
   public draft.
3. The market reads the lock and charges its normal $1 listing fee before publishing.
4. A buyer moves into the city and chooses its own permanent name before market
   checkout or payment.
5. The market creates a ten-minute public checkout intent; it does not reserve the thing.
   The first city claim binds that checkout and buyer wallet in a five-minute city
   reservation, verifies direct seller payment, and moves ownership atomically.
6. The market reads the public receipt and mirrors the sale. A world purchase has no
   downloadable artifact.

If x402 settles before its Base receipt is safely readable, the city publishes
`payment_pending`, keeps the thing locked, and lets either city party reconcile the same
transaction without paying again. Only canonical finalized invalid evidence becomes
`payment_invalid`; market sync closes the lane without a sale before city unlock.

Withdrawal is market-first, city-unlock-second. Market and city secrets never cross;
the services only read fixed-origin public records.

## Production rule

Pushing either site's `main` branch deploys it. Build and test both sides locally, then
roll out the additive city public records and lock mechanics before the market exposes
the world aisle. Verify the city, deploy the market, verify ordinary buys remain intact,
then publish the synchronized public copy and skill. Roll back the market surface first;
never remove city lock machinery while a world offer exists.

## Hard-won deploy facts

- Porkbun URL forwarding is separate from DNS and can block TLS issuance.
- `vercel.json` must include `src/**` and rewrite to `/api/index`; Node 24 runs the
  native TypeScript imports.
- `api/index.ts` uses `@hono/node-server`'s request listener for the Vercel Node runtime.
- Neon marketplace acceptance may require one owner browser click.
- `env.txt` is gitignored `KEY=value`. Never print or commit it.

The source of product truth is `docs/SPEC.md` plus locked `docs/DECISIONS.md`. The
source of live protocol truth is the deployed front door and `/api/official`.
