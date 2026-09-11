import { Hono } from 'hono'
import { cors } from 'hono/cors'

import { registerArtifactListingRoutes, validListing } from './artifact-listing-routes.ts'
import { registerArtifactPurchaseRoutes } from './artifact-purchase-routes.ts'
import { registerCollectionRoutes } from './collection-routes.ts'
import { registerDoorRoutes } from './door-routes.ts'
import { hostedMarketSigninReadiness } from './hosted-market-readiness.ts'
import { mountMarketIdentityRoutes } from './market-identity-routes.ts'
import { unexpectedMarketFailure } from './market-failure.ts'
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

function acceptedQuality(accept: string, mediaType: string): number {
  const [wantedType, wantedSubtype] = mediaType.toLowerCase().split('/')
  let best = { specificity: -1, quality: 0 }
  for (const rawRange of accept.split(',')) {
    const [rawMedia = '', ...parameters] = rawRange.trim().split(';')
    const [rangeType, rangeSubtype] = rawMedia.trim().toLowerCase().split('/')
    if (!rangeType || !rangeSubtype) continue
    const specificity = rangeType === wantedType && rangeSubtype === wantedSubtype
      ? 2
      : rangeType === wantedType && rangeSubtype === '*'
        ? 1
        : rangeType === '*' && rangeSubtype === '*'
          ? 0
          : -1
    if (specificity < 0) continue
    const qualityMatch = parameters
      .map(parameter => /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/iu.exec(parameter))
      .find(match => match !== null)
    const quality = qualityMatch ? Number(qualityMatch[1]) : 1
    if (specificity > best.specificity || (specificity === best.specificity && quality > best.quality)) {
      best = { specificity, quality }
    }
  }
  return best.quality
}

function acceptsHtml(accept: string | undefined): boolean {
  if (!accept) return false
  const htmlQuality = Math.max(
    acceptedQuality(accept, 'text/html'),
    acceptedQuality(accept, 'application/xhtml+xml'),
  )
  return htmlQuality > 0 && htmlQuality > acceptedQuality(accept, 'application/json')
}

const publicCors = cors({ origin: '*', allowHeaders: ['Content-Type', 'Authorization', 'X-PAYMENT'] })
app.use('*', (c, next) => c.req.path.startsWith('/oauth/') ? next() : publicCors(c, next))
app.use('*', async (c, next) => {
  await next()
  if (c.res.status >= 400) {
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
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page not found · 1F3EA</title></head><body><main><h1>Page not found</h1><p>That market address does not exist.</p><p><a href="/">Read the market front door</a> or <a href="/window">watch the shop window</a>.</p></main></body></html>`, 404)
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
app.get('/mcp', c => c.text('MCP endpoint. POST JSON-RPC 2.0 messages here.', 405))
if (HOSTED_MARKET_SIGNIN.ready) {
  app.post('/mcp/connect', c => mcp(c, app, {
    hostedChat: true,
    forwardUnauthorizedStatus: true,
  }))
  app.get('/mcp/connect', c => c.text('Hosted MCP endpoint. POST JSON-RPC 2.0 messages here.', 405))
}

export default app
