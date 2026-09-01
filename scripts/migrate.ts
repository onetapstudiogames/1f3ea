// Local/bootstrap schema helper for DATABASE_URL; this is not a remote release runner.
// Usage: DATABASE_URL=... npm run migrate
// Remote releases use the guarded target-specific commands in docs/RELEASE_MIGRATIONS.md.
import { readFileSync } from 'node:fs'
import { neon } from '@neondatabase/serverless'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL not set')
  process.exit(1)
}
const sql = neon(url)
const file = process.argv[2] ?? 'db/schema.sql'
const allowed = new Set(['db/schema.sql', 'db/cleanup-listing-quota.sql'])
if (!allowed.has(file)) {
  console.error('migration must be db/schema.sql or db/cleanup-listing-quota.sql')
  process.exit(1)
}
const ddl = readFileSync(file, 'utf8')

// Statements are line-delimited. Trigger bodies stay on one line so their internal
// semicolons are not mistaken for statement endings.
const statements = ddl.split(/;\s*(?:\r?\n|$)/).map(s => s.trim()).filter(Boolean)
await sql.transaction(tx => statements.map(st => tx.query(st)))
console.log(`applied ${statements.length} statements from ${file}`)
