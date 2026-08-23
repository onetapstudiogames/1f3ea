// Apply one reviewed, expand-only market migration to an explicitly named target.
// Connection strings are selected from target-specific environment variables and
// never printed. The operator must separately name the expected database and endpoint.
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { neon, type NeonQueryFunction } from '@neondatabase/serverless'

export type ReleaseTarget = 'preview' | 'production'
export type ReleaseMigration = 'direct-payments' | 'hosted-market-signin'
type SqlMode = 'normal' | 'single-quote' | 'double-quote' | 'line-comment' | 'block-comment' | 'dollar-quote'

type MigrationEnvironment = Readonly<Record<string, string | undefined>>

type Postcondition = Readonly<{
  kind: 'relation' | 'column' | 'constraint'
  name: string
  table?: string
}>

export type ReleaseMigrationRun = Readonly<{
  target: ReleaseTarget
  migration: ReleaseMigration
  migrationFile: string
  databaseUrl: string
  databaseName: string
  endpoint: string
  postconditions: readonly Postcondition[]
}>

export type MigrationDatabase = Readonly<{
  identify(): Promise<Readonly<{ databaseName: string }>>
  migrate(statements: readonly string[]): Promise<void>
  missingPostconditions(postconditions: readonly Postcondition[]): Promise<readonly string[]>
}>

export const PREVIEW_MIGRATION_ACKNOWLEDGEMENT =
  'APPLY_ADDITIVE_MARKET_SCHEMA_TO_ISOLATED_PREVIEW'
export const PRODUCTION_MIGRATION_ACKNOWLEDGEMENT =
  'APPLY_ADDITIVE_MARKET_SCHEMA_TO_PRODUCTION'

const DATABASE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/u
const ENDPOINT = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u

const MIGRATIONS = Object.freeze({
  'direct-payments': {
    file: 'db/migrations/20260823_direct_payments.sql',
    postconditions: [
      { kind: 'relation', name: 'direct_purchase_intents' },
      { kind: 'relation', name: 'direct_purchase_intents_open_unique' },
      { kind: 'relation', name: 'direct_purchase_intents_buyer_listing_unique' },
      { kind: 'relation', name: 'direct_purchase_intents_listing_id_id_unique' },
      { kind: 'column', table: 'purchases', name: 'direct_purchase_intent_id' },
      { kind: 'constraint', table: 'purchases', name: 'purchases_direct_intent_channel' },
      { kind: 'constraint', table: 'purchases', name: 'purchases_direct_intent_listing_fk' },
      { kind: 'relation', name: 'purchases_direct_intent_unique' },
    ],
  },
  'hosted-market-signin': {
    file: 'db/migrations/20260822_hosted_market_signin.sql',
    postconditions: [
      { kind: 'relation', name: 'oauth_authorization_requests' },
      { kind: 'relation', name: 'oauth_authorization_codes' },
      { kind: 'relation', name: 'oauth_token_families' },
      { kind: 'relation', name: 'oauth_tokens' },
      { kind: 'relation', name: 'oauth_rate_limits' },
      { kind: 'relation', name: 'oauth_authorization_requests_expiry' },
      { kind: 'relation', name: 'oauth_authorization_codes_expiry' },
      { kind: 'relation', name: 'oauth_token_families_active' },
      { kind: 'relation', name: 'oauth_tokens_active_expiry' },
      { kind: 'relation', name: 'oauth_rate_limits_expiry' },
    ],
  },
} as const satisfies Readonly<Record<ReleaseMigration, Readonly<{
  file: string
  postconditions: readonly Postcondition[]
}>>>)

function namedArgument(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`
  const joined = args.find(argument => argument.startsWith(prefix))
  if (joined) return joined.slice(prefix.length)
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}

function requireSafeDatabaseName(value: string | undefined): string {
  if (!value || !DATABASE_NAME.test(value)) {
    throw new Error('migration requires --database <expected-safe-name>')
  }
  return value
}

function requireEndpoint(value: string | undefined, argument: string): string {
  const endpoint = value?.trim().toLowerCase()
  if (!endpoint || !ENDPOINT.test(endpoint) || endpoint.includes(':')) {
    throw new Error(`migration requires --${argument} <exact-hostname>`)
  }
  return endpoint
}

function requireDirectDatabaseUrl(value: string | undefined, variableName: string): URL {
  if (!value) throw new Error(`${variableName} not set`)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${variableName} must be a valid Postgres URL`)
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`${variableName} must be a Postgres URL`)
  }
  if (!parsed.hostname || !parsed.username || !parsed.password || !parsed.pathname.slice(1)) {
    throw new Error(`${variableName} must name a host, role, password, and database`)
  }
  if (parsed.hostname.toLowerCase().includes('-pooler')) {
    throw new Error(`${variableName} must use a direct, non-pooled connection`)
  }
  if (!['require', 'verify-full'].includes(parsed.searchParams.get('sslmode') ?? '')) {
    throw new Error(`${variableName} must require TLS with sslmode=require or verify-full`)
  }
  return parsed
}

function decodedDatabaseName(parsed: URL, variableName: string): string {
  let databaseName: string
  try {
    databaseName = decodeURIComponent(parsed.pathname.slice(1))
  } catch {
    throw new Error(`${variableName} contains an invalid database name`)
  }
  if (!DATABASE_NAME.test(databaseName)) {
    throw new Error(`${variableName} contains an unsafe database name`)
  }
  return databaseName
}

/** Resolve all safety facts before any database connection can be opened. */
export function resolveReleaseMigration(
  args: readonly string[],
  environment: MigrationEnvironment,
): ReleaseMigrationRun {
  const target = namedArgument(args, 'target')
  if (target !== 'preview' && target !== 'production') {
    throw new Error('release migration requires --target preview|production')
  }
  const migration = namedArgument(args, 'migration')
  if (migration !== 'direct-payments' && migration !== 'hosted-market-signin') {
    throw new Error('release migration requires --migration direct-payments|hosted-market-signin')
  }
  const databaseName = requireSafeDatabaseName(namedArgument(args, 'database'))
  const endpoint = requireEndpoint(namedArgument(args, 'endpoint'), 'endpoint')

  const isPreview = target === 'preview'
  const acknowledgementName = isPreview
    ? 'CONFIRM_MARKET_PREVIEW_MIGRATION'
    : 'CONFIRM_MARKET_PRODUCTION_MIGRATION'
  const acknowledgement = isPreview
    ? PREVIEW_MIGRATION_ACKNOWLEDGEMENT
    : PRODUCTION_MIGRATION_ACKNOWLEDGEMENT
  if (environment[acknowledgementName] !== acknowledgement) {
    throw new Error(`${target} migration requires ${acknowledgementName}=${acknowledgement}`)
  }

  if (isPreview) {
    const productionEndpoint = requireEndpoint(
      namedArgument(args, 'production-endpoint'),
      'production-endpoint',
    )
    if (endpoint === productionEndpoint) {
      throw new Error('preview endpoint must differ from production endpoint')
    }
  }

  const variableName = isPreview
    ? 'PREVIEW_DATABASE_URL_UNPOOLED'
    : 'PRODUCTION_DATABASE_URL_UNPOOLED'
  const rawDatabaseUrl = environment[variableName]
  const parsed = requireDirectDatabaseUrl(rawDatabaseUrl, variableName)
  const urlDatabaseName = decodedDatabaseName(parsed, variableName)
  if (urlDatabaseName !== databaseName) {
    throw new Error(`${variableName} database name does not match --database`)
  }
  if (parsed.hostname.toLowerCase() !== endpoint) {
    throw new Error(`${variableName} endpoint does not match --endpoint`)
  }

  const definition = MIGRATIONS[migration]
  return Object.freeze({
    target,
    migration,
    migrationFile: definition.file,
    databaseUrl: rawDatabaseUrl!,
    databaseName,
    endpoint,
    postconditions: definition.postconditions,
  })
}

export function splitMigrationSql(ddl: string): readonly string[] {
  const statements: string[] = []
  let statement = ''
  let mode: SqlMode = 'normal'
  let blockCommentDepth = 0
  let dollarDelimiter = ''

  const finishStatement = () => {
    const trimmed = statement.trim()
    if (trimmed) statements.push(trimmed)
    statement = ''
  }

  for (let index = 0; index < ddl.length; index += 1) {
    const character = ddl[index]!
    const next = ddl[index + 1]

    if (mode === 'normal') {
      if (character === '-' && next === '-') {
        statement += '--'
        index += 1
        mode = 'line-comment'
      } else if (character === '/' && next === '*') {
        statement += '/*'
        index += 1
        blockCommentDepth = 1
        mode = 'block-comment'
      } else if (character === "'") {
        statement += character
        mode = 'single-quote'
      } else if (character === '"') {
        statement += character
        mode = 'double-quote'
      } else if (character === '$') {
        const delimiter = ddl.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u)?.[0]
        if (delimiter) {
          statement += delimiter
          index += delimiter.length - 1
          dollarDelimiter = delimiter
          mode = 'dollar-quote'
        } else {
          statement += character
        }
      } else if (character === ';') {
        finishStatement()
      } else {
        statement += character
      }
      continue
    }

    if (mode === 'line-comment') {
      statement += character
      if (character === '\n') mode = 'normal'
      continue
    }

    if (mode === 'block-comment') {
      if (character === '/' && next === '*') {
        statement += '/*'
        index += 1
        blockCommentDepth += 1
      } else if (character === '*' && next === '/') {
        statement += '*/'
        index += 1
        blockCommentDepth -= 1
        if (blockCommentDepth === 0) mode = 'normal'
      } else {
        statement += character
      }
      continue
    }

    if (mode === 'dollar-quote') {
      if (ddl.startsWith(dollarDelimiter, index)) {
        statement += dollarDelimiter
        index += dollarDelimiter.length - 1
        dollarDelimiter = ''
        mode = 'normal'
      } else {
        statement += character
      }
      continue
    }

    statement += character
    if (mode === 'single-quote' && character === "'") {
      if (next === "'") {
        statement += next
        index += 1
      } else {
        mode = 'normal'
      }
    } else if (mode === 'double-quote' && character === '"') {
      if (next === '"') {
        statement += next
        index += 1
      } else {
        mode = 'normal'
      }
    }
  }

  if (mode === 'single-quote') throw new Error('migration SQL has an unterminated single-quoted string')
  if (mode === 'double-quote') throw new Error('migration SQL has an unterminated quoted identifier')
  if (mode === 'block-comment') throw new Error('migration SQL has an unterminated block comment')
  if (mode === 'dollar-quote') throw new Error(`migration SQL has an unterminated ${dollarDelimiter} block`)

  finishStatement()
  return statements
}

function migrationFileUrl(file: string): URL {
  return new URL(`../${file}`, import.meta.url)
}

/** Prove the connected database, apply one transaction, then prove required objects exist. */
export async function executeReleaseMigration(
  run: ReleaseMigrationRun,
  database: MigrationDatabase,
): Promise<Readonly<{ statementCount: number; postconditionCount: number }>> {
  const identity = await database.identify()
  if (identity.databaseName !== run.databaseName) {
    throw new Error(
      `connected database ${JSON.stringify(identity.databaseName)} does not match expected ` +
      `${JSON.stringify(run.databaseName)}`,
    )
  }

  const ddl = await readFile(migrationFileUrl(run.migrationFile), 'utf8')
  const statements = splitMigrationSql(ddl)
  if (statements.length === 0) throw new Error('migration file has no statements')
  await database.migrate(statements)

  const missing = await database.missingPostconditions(run.postconditions)
  if (missing.length > 0) {
    throw new Error(`migration postconditions failed: ${missing.join(', ')}`)
  }
  return Object.freeze({
    statementCount: statements.length,
    postconditionCount: run.postconditions.length,
  })
}

function rowsFromQuery(result: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(result)) throw new Error('database returned an invalid result')
  return result.filter(
    (row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row),
  )
}

function postgresDatabase(databaseUrl: string): MigrationDatabase {
  const sql: NeonQueryFunction<false, false> = neon(databaseUrl)
  return Object.freeze({
    async identify() {
      const rows = rowsFromQuery(await sql.query('SELECT current_database() AS database_name'))
      const databaseName = rows[0]?.database_name
      if (typeof databaseName !== 'string') throw new Error('could not identify connected database')
      return Object.freeze({ databaseName })
    },
    async migrate(statements) {
      await sql.transaction(transaction => statements.map(statement => transaction.query(statement)))
    },
    async missingPostconditions(postconditions) {
      const missing: string[] = []
      for (const postcondition of postconditions) {
        let present = false
        if (postcondition.kind === 'relation') {
          const rows = rowsFromQuery(await sql.query(
            'SELECT to_regclass($1) IS NOT NULL AS present',
            [`public.${postcondition.name}`],
          ))
          present = rows[0]?.present === true
        } else if (postcondition.kind === 'column') {
          const rows = rowsFromQuery(await sql.query(
            `SELECT EXISTS (
               SELECT 1 FROM pg_attribute
               WHERE attrelid = to_regclass($1) AND attname = $2 AND NOT attisdropped
             ) AS present`,
            [`public.${postcondition.table}`, postcondition.name],
          ))
          present = rows[0]?.present === true
        } else {
          const rows = rowsFromQuery(await sql.query(
            `SELECT EXISTS (
               SELECT 1 FROM pg_constraint
               WHERE conrelid = to_regclass($1) AND conname = $2
             ) AS present`,
            [`public.${postcondition.table}`, postcondition.name],
          ))
          present = rows[0]?.present === true
        }
        if (!present) missing.push(`${postcondition.kind}:${postcondition.name}`)
      }
      return missing
    },
  })
}

async function main(): Promise<void> {
  const run = resolveReleaseMigration(process.argv.slice(2), process.env)
  const result = await executeReleaseMigration(run, postgresDatabase(run.databaseUrl))
  console.log(JSON.stringify({
    target: run.target,
    migration: run.migration,
    database: run.databaseName,
    endpoint: run.endpoint,
    statements: result.statementCount,
    postconditions: result.postconditionCount,
  }))
}

const entry = process.argv[1]
if (entry && import.meta.url === pathToFileURL(entry).href) {
  await main().catch(error => {
    console.error(error instanceof Error ? error.message : 'release migration failed')
    process.exitCode = 1
  })
}
