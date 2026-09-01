import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { registerArtifactListingRoutes, validListing } from './artifact-listing-routes.ts'
import { registerArtifactPurchaseRoutes } from './artifact-purchase-routes.ts'
import { registerCollectionRoutes } from './collection-routes.ts'
import { registerDoorRoutes } from './door-routes.ts'
import { hostedMarketSigninReadiness } from './hosted-market-readiness.ts'
import { mountMarketIdentityRoutes } from './market-identity-routes.ts'
import {
  configureMarketOAuthMerchantResolver,
  mountMarketOAuthRoutes,
} from './market-oauth.ts'
import { mcp } from './mcp.ts'
import { registerModerationRoutes } from './moderation-routes.ts'
import { registerPurchaseHistoryRoutes } from './purchase-history-routes.ts'
import { registerSocietyRoutes } from './society-routes.ts'
import { registerTrustRoutes } from './trust-routes.ts'
import { registerWorldRoutes } from './world-routes.ts'

export { validListing }

const DOMAIN = process.env.PUBLIC_ORIGIN ?? 'https://1f3ea.com'
const MAINTAINER_ID = Number(process.env.MAINTAINER_ID ?? 1)
const SEED_CAP = 10

const app = new Hono()
const HOSTED_MARKET_SIGNIN = hostedMarketSigninReadiness()

const missingShelf = () => ({
  error:
    'no such shelf. Use the front_door tool through MCP, or GET / if your client can open URLs.',
  front_door_tool: 'front_door',
  front_door: `${DOMAIN.replace(/\/+$/u, '')}/`,
})

const publicCors = cors({ origin: '*', allowHeaders: ['Content-Type', 'Authorization', 'X-PAYMENT'] })
app.use('*', (c, next) => c.req.path.startsWith('/oauth/') ? next() : publicCors(c, next))
if (HOSTED_MARKET_SIGNIN.ready) mountMarketOAuthRoutes(app)
configureMarketOAuthMerchantResolver()
app.onError((error, c) => {
  console.error(error)
  return c.json({ error: 'internal market failure; retry later' }, 500)
})
app.notFound(c => c.json(missingShelf(), 404))

registerDoorRoutes(app)
registerCollectionRoutes(app)
mountMarketIdentityRoutes(app, { hostedMarketSigninReady: HOSTED_MARKET_SIGNIN.ready })
registerArtifactListingRoutes(app, {
  domain: DOMAIN,
  maintainerId: MAINTAINER_ID,
  seedCap: SEED_CAP,
})
registerArtifactPurchaseRoutes(app, { domain: DOMAIN })
registerPurchaseHistoryRoutes(app)
registerSocietyRoutes(app)
registerTrustRoutes(app, { domain: DOMAIN, hostedMarketSignin: HOSTED_MARKET_SIGNIN })
registerModerationRoutes(app, MAINTAINER_ID)
registerWorldRoutes(app, { marketOrigin: DOMAIN, maintainerId: MAINTAINER_ID, seedCap: SEED_CAP })

app.post('/mcp', c => mcp(c, app))
app.get('/mcp', c => c.text('MCP endpoint. POST JSON-RPC 2.0 messages here.', 405))
if (HOSTED_MARKET_SIGNIN.ready) {
  app.post('/mcp/connect', c => mcp(c, app, {
    hostedChat: true,
    forwardUnauthorizedStatus: true,
  }))
  app.get('/mcp/connect', c => c.text('Hosted MCP endpoint. POST JSON-RPC 2.0 messages here.', 405))
}

export default app
