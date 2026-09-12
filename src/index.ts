import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { registerArtifactListingRoutes, validListing } from './artifact-listing-routes.ts'
import { registerArtifactPurchaseRoutes } from './artifact-purchase-routes.ts'
import { registerCollectionRoutes } from './collection-routes.ts'
import { registerDoorRoutes } from './door-routes.ts'
import { acceptsHtml } from './http-accept.ts'
import { notFoundDocument } from './human-pages.ts'
import { hostedMarketSigninReadiness } from './hosted-market-readiness.ts'
import { mountMarketIdentityRoutes } from './market-identity-routes.ts'
import { unexpectedMarketFailure } from './market-failure.ts'
import { ensureMarketJsonRefusal, marketJsonRefusal, markMarketRefusal } from './market-refusal.ts'
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
app.use('*', async (c, next) => {
  await next()
  if (c.res.status >= 400) {
    await ensureMarketJsonRefusal(c)
    const helpLink = '</help>; rel="help"'
    const current = c.res.headers.get('Link')
    c.header('Link', current ? `${current}, ${helpLink}` : helpLink)
  }
})
if (HOSTED_MARKET_SIGNIN.ready) mountMarketOAuthRoutes(app)
configureMarketOAuthMerchantResolver()
app.onError(unexpectedMarketFailure)
app.notFound(c => {
  c.header('Vary', 'Accept')
  if (acceptsHtml(c.req.header('accept'))) {
    const reference = markMarketRefusal(c, 404, 'not_found')
    return c.html(notFoundDocument(reference.requestId), 404)
  }
  return c.json(missingShelf(), 404)
})

registerDoorRoutes(app)
registerCollectionRoutes(app)
mountMarketIdentityRoutes(app, { hostedMarketSigninReady: HOSTED_MARKET_SIGNIN.ready })
registerArtifactListingRoutes(app, {
  domain: DOMAIN,
  maintainerId: MAINTAINER_ID,
})
registerArtifactPurchaseRoutes(app, { domain: DOMAIN })
registerPurchaseHistoryRoutes(app)
registerSocietyRoutes(app)
registerTrustRoutes(app, { domain: DOMAIN, hostedMarketSignin: HOSTED_MARKET_SIGNIN })
registerModerationRoutes(app, MAINTAINER_ID)
registerWorldRoutes(app, { marketOrigin: DOMAIN, maintainerId: MAINTAINER_ID })

app.post('/mcp', c => mcp(c, app))
app.get('/mcp', c => {
  c.header('Allow', 'POST')
  return marketJsonRefusal(
    c, 405, 'invalid_request', 'MCP endpoint accepts POST JSON-RPC 2.0 messages.',
    'POST one JSON-RPC 2.0 message here, then call front_door.',
  )
})
if (HOSTED_MARKET_SIGNIN.ready) {
  app.post('/mcp/connect', c => mcp(c, app, {
    hostedChat: true,
    forwardUnauthorizedStatus: true,
  }))
  app.get('/mcp/connect', c => {
    c.header('Allow', 'POST')
    return marketJsonRefusal(
      c, 405, 'invalid_request', 'Hosted MCP endpoint accepts POST JSON-RPC 2.0 messages.',
      'POST one JSON-RPC 2.0 message to this hosted endpoint, then call front_door.',
    )
  })
}

export default app
