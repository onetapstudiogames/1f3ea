import type { Hono } from 'hono'

import { sql } from './db.ts'
import { mountChangelogRoutes } from './changelog.ts'
import { FRONTDOOR, HUMANS, LLMS, ROBOTS } from './door.ts'
import { acceptsHtml } from './http-accept.ts'
import {
  guidePage, mountHumanPages, PRIVACY_HTML, SUPPORT_HTML, TERMS_HTML,
} from './human-pages.ts'
import { PRIVACY, SUPPORT, TERMS } from './legal.ts'
import { formatActivity, PUBLIC_EVENT_SCOPES, type ActivityEvent } from './market.ts'
import { agentHelp } from './market-help.ts'
import { countedPage, type CountedRow } from './public-pagination.ts'
import { windowPage, windowScript, windowSnapshot, windowStyle } from './window.ts'

export function registerDoorRoutes(app: Hono): void {
  const legalPage = (c: Parameters<typeof guidePage>[0], html: string, plain: string): Response => {
    c.header('Vary', 'Accept')
    return acceptsHtml(c.req.header('accept'), 'text/plain') ? guidePage(c, html) : c.text(plain)
  }
  app.get('/', async c => {
    c.header('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
    try {
      const rawActivity = (await sql`
        /* public:door-activity */
        WITH eligible AS (
          SELECT id, at, kind, actor, detail FROM events
          WHERE kind = ANY(${[...PUBLIC_EVENT_SCOPES.door]}::text[])
        ), page AS (
          SELECT * FROM eligible ORDER BY id DESC LIMIT ${6}
        )
        SELECT page.*, (SELECT count(*)::int FROM eligible) AS __total
        FROM page ORDER BY id DESC`) as (ActivityEvent & CountedRow)[]
      const activityPage = countedPage(rawActivity, 5)
      return c.text(`${FRONTDOOR.trimEnd()}\n\n${formatActivity(
        activityPage.items as unknown as ActivityEvent[],
        {
          total: activityPage.total,
          hasMore: activityPage.hasMore,
          nextBeforeId: activityPage.nextCursor,
          scope: 'door',
        },
      )}\n`)
    } catch {
      return c.text(FRONTDOOR)
    }
  })
  app.get('/llms.txt', c => c.text(LLMS))
  app.get('/api/help', agentHelp)
  app.get('/robots.txt', c => c.text(ROBOTS))
  app.get('/humans.txt', c => c.text(HUMANS))
  app.get('/privacy', c => legalPage(c, PRIVACY_HTML, PRIVACY))
  app.get('/terms', c => legalPage(c, TERMS_HTML, TERMS))
  app.get('/support', c => legalPage(c, SUPPORT_HTML, SUPPORT))
  mountHumanPages(app)
  mountChangelogRoutes(app)
  app.get('/window', c => windowPage(c, async path => app.request(path, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  })))
  app.get('/window.css', windowStyle)
  app.get('/window.js', windowScript)
  app.get('/window-card.png', c => c.redirect('/og-image.png', 308))
  app.get('/api/window', windowSnapshot)
}
