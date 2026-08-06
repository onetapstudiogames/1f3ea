// Vercel entrypoint: every request is rewritten here (vercel.json) and handed to Hono.
// This runs on the NODE runtime: getRequestListener bridges Node's (req, res) to the
// web-standard Request that Hono speaks. (hono/vercel is the Edge adapter — it crashes here.)
import { getRequestListener } from '@hono/node-server'
import app from '../src/index.ts'

export const config = { api: { bodyParser: false } }

export default getRequestListener(app.fetch)
