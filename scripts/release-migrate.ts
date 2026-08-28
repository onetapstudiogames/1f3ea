// Apply one reviewed, expand-only market migration to an explicitly named target.
// Connection strings are selected from target-specific environment variables and
// never printed. The operator must separately name the expected database and endpoint.
import { pathToFileURL } from 'node:url'
import { executeReleaseMigration, postgresDatabase } from './release-migration-execution.ts'
import { resolveReleaseMigration } from './release-migration-resolution.ts'

export type {
  MigrationDatabase, MigrationQuery, Postcondition, ReleaseMigration,
  ReleaseMigrationRun, ReleaseTarget,
} from './release-migration-types.ts'
export {
  PREVIEW_MIGRATION_ACKNOWLEDGEMENT, PRODUCTION_MIGRATION_ACKNOWLEDGEMENT,
} from './release-migration-types.ts'
export { missingMigrationPostconditions } from './release-migration-catalog.ts'
export { executeReleaseMigration, splitMigrationSql } from './release-migration-execution.ts'
export { resolveReleaseMigration } from './release-migration-resolution.ts'

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
