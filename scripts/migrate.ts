// Apply db/schema.sql to DATABASE_URL. Idempotent (IF NOT EXISTS everywhere).
// Usage: DATABASE_URL=... npm run migrate
import { readFileSync } from 'node:fs'
import { neon } from '@neondatabase/serverless'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL not set')
  process.exit(1)
}
const sql = neon(url)
const ddl = readFileSync('db/schema.sql', 'utf8')

// Split on semicolons at end-of-statement; naive but our schema has no functions/triggers.
const statements = ddl.split(/;\s*(?:\r?\n|$)/).map(s => s.trim()).filter(Boolean)
for (const st of statements) {
  await sql.query(st)
}
console.log(`applied ${statements.length} statements`)
