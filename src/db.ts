import { neon, type NeonQueryFunction } from '@neondatabase/serverless'

// One database, reached over HTTP — no pools to babysit in serverless.
// Lazily initialized so pure modules stay importable (tests) without a DATABASE_URL.
type Sql = NeonQueryFunction<false, false>
let _sql: Sql | null = null
function client(): Sql {
  if (!_sql) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not set')
    _sql = neon(url)
  }
  return _sql
}

export const sql: Sql = new Proxy((() => {}) as unknown as Sql, {
  apply: (_t, _this, args) => (client() as unknown as (...a: unknown[]) => unknown)(...args),
  get: (_t, prop) => (client() as unknown as Record<PropertyKey, unknown>)[prop],
}) as Sql

export async function logEvent(kind: string, actor: string, detail: Record<string, unknown> = {}) {
  await sql`INSERT INTO events (kind, actor, detail) VALUES (${kind}, ${actor}, ${JSON.stringify(detail)}::jsonb)`
}
