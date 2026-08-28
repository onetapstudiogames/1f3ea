import { readFile } from 'node:fs/promises'
import { Client, neon, type NeonQueryFunction } from '@neondatabase/serverless'
import { missingMigrationPostconditions, rowsFromQuery } from './release-migration-catalog.ts'
import { MIGRATIONS } from './release-migration-registry.ts'
import type {
  MigrationDatabase, MigrationQuery, ReleaseMigrationRun,
} from './release-migration-types.ts'

type SqlMode = 'normal' | 'single-quote' | 'double-quote' | 'line-comment' | 'block-comment' | 'dollar-quote'

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

async function publicTableExists(tableName: string, query: MigrationQuery): Promise<boolean> {
  const rows = rowsFromQuery(await query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_class
       WHERE oid = to_regclass($1) AND relkind IN ('r', 'p')
     ) AS present`,
    [`public.${tableName}`],
  ))
  return rows[0]?.present === true
}

async function requireMigrationPrerequisites(
  run: ReleaseMigrationRun,
  query: MigrationQuery,
): Promise<void> {
  if (run.migration !== 'x402-payment-attempts') return
  const missing = await missingMigrationPostconditions(
    MIGRATIONS['world-payment-finality'].postconditions,
    query,
  )
  if (missing.length === 0) return
  throw new Error(
    'x402-payment-attempts requires world-payment-finality to be applied and verified first; ' +
    `run the ${run.target} world-payment-finality migration before retrying x402-payment-attempts`,
  )
}

/** Prove the target, then apply and verify one migration in one database transaction. */
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

  await requireMigrationPrerequisites(run, database.inspect)

  const ddl = await readFile(migrationFileUrl(run.migrationFile), 'utf8')
  const statements = splitMigrationSql(ddl)
  if (statements.length === 0) throw new Error('migration file has no statements')

  return database.transaction(async query => {
    await requireMigrationPrerequisites(run, query)
    if (run.preflightTable && await publicTableExists(run.preflightTable, query)) {
      const drifted = await missingMigrationPostconditions(run.postconditions, query)
      if (drifted.length > 0) {
        throw new Error(`existing migration objects drifted: ${drifted.join(', ')}`)
      }
    }

    for (const statement of statements) await query(statement)
    const missing = await missingMigrationPostconditions(run.postconditions, query)
    if (missing.length > 0) {
      throw new Error(`migration postconditions failed: ${missing.join(', ')}`)
    }
    return Object.freeze({
      statementCount: statements.length,
      postconditionCount: run.postconditions.length,
    })
  })
}

export function postgresDatabase(databaseUrl: string): MigrationDatabase {
  const sql: NeonQueryFunction<false, false> = neon(databaseUrl)
  return Object.freeze({
    async identify() {
      const rows = rowsFromQuery(await sql.query('SELECT current_database() AS database_name'))
      const databaseName = rows[0]?.database_name
      if (typeof databaseName !== 'string') throw new Error('could not identify connected database')
      return Object.freeze({ databaseName })
    },
    async inspect(text, values = []) {
      return rowsFromQuery(await sql.query(text, [...values]))
    },
    async transaction<T>(operation: (query: MigrationQuery) => Promise<T>): Promise<T> {
      const client = new Client(databaseUrl)
      try {
        await client.connect()
        await client.query('BEGIN')
        const result = await operation(async (text, values = []) =>
          (await client.query(text, [...values])).rows)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        await client.end().catch(() => undefined)
      }
    },
  })
}
