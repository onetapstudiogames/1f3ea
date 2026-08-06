// Vercel entrypoint: every request is rewritten here (vercel.json) and handed to Hono.
import { handle } from 'hono/vercel'
import app from '../src/index.ts'

export default handle(app)
