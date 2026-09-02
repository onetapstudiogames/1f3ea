import {
  PREVIEW_MIGRATION_ACKNOWLEDGEMENT, PRODUCTION_MIGRATION_ACKNOWLEDGEMENT,
  type MigrationEnvironment, type ReleaseMigrationRun,
} from './release-migration-types.ts'
import { MIGRATIONS } from './release-migration-registry.ts'

const DATABASE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/u
const ENDPOINT = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u

const ARGUMENT_NAMES = new Set([
  'target',
  'migration',
  'database',
  'endpoint',
  'production-endpoint',
])

function parseNamedArguments(args: readonly string[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (!argument.startsWith('--')) throw new Error(`unknown argument ${JSON.stringify(argument)}`)
    const equals = argument.indexOf('=')
    const name = argument.slice(2, equals === -1 ? undefined : equals)
    if (!ARGUMENT_NAMES.has(name)) throw new Error(`unknown argument --${name}`)
    if (values.has(name)) throw new Error(`--${name} must appear exactly once`)

    const value = equals === -1 ? args[index + 1] : argument.slice(equals + 1)
    if (!value || (equals === -1 && value.startsWith('--'))) {
      throw new Error(`--${name} requires a value`)
    }
    values.set(name, value)
    if (equals === -1) index += 1
  }
  return values
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
  const argumentsByName = parseNamedArguments(args)
  const target = argumentsByName.get('target')
  if (target !== 'preview' && target !== 'production') {
    throw new Error('release migration requires --target preview|production')
  }
  const migration = argumentsByName.get('migration')
  if (
    migration !== 'direct-payments'
    && migration !== 'hosted-market-signin'
    && migration !== 'market-identity'
    && migration !== 'market-coding-identity'
    && migration !== 'world-payment-finality'
    && migration !== 'x402-payment-attempts'
  ) {
    throw new Error(
      'release migration requires --migration direct-payments|hosted-market-signin|market-identity|' +
      'market-coding-identity|world-payment-finality|x402-payment-attempts',
    )
  }
  const databaseName = requireSafeDatabaseName(argumentsByName.get('database'))
  const endpoint = requireEndpoint(argumentsByName.get('endpoint'), 'endpoint')

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
      argumentsByName.get('production-endpoint'),
      'production-endpoint',
    )
    if (endpoint === productionEndpoint) {
      throw new Error('preview endpoint must differ from production endpoint')
    }
  } else if (argumentsByName.has('production-endpoint')) {
    throw new Error('--production-endpoint is valid only for preview migrations')
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
    ...('preflightTable' in definition
      ? { preflightTable: definition.preflightTable }
      : {}),
  })
}
