export type ReleaseTarget = 'preview' | 'production'
export type ReleaseMigration =
  | 'direct-payments'
  | 'hosted-market-signin'
  | 'market-identity'
  | 'market-coding-identity'
  | 'world-payment-finality'
  | 'x402-payment-attempts'

export type MigrationEnvironment = Readonly<Record<string, string | undefined>>

export type Postcondition = Readonly<
  | { kind: 'table'; name: string }
  | {
      kind: 'index'
      name: string
      table: string
      unique?: boolean
      definitionIncludes?: readonly string[]
      definitionSha256?: string
    }
  | {
      kind: 'column'
      name: string
      table: string
      dataType?: string
      notNull?: boolean
      defaultExpression?: string | null
    }
  | {
      kind: 'constraint'
      name: string
      table: string
      validated?: boolean
      deferrable?: boolean
      initiallyDeferred?: boolean
      definitionIncludes?: readonly string[]
      definitionSha256?: string
    }
  | {
      kind: 'function'
      name: string
      contains?: string
      containsAll?: readonly string[]
      definitionSha256?: string
    }
  | {
      kind: 'trigger'
      name: string
      table: string
      functionName: string
      deferred: boolean
      enabled?: 'O'
      definitionIncludes?: readonly string[]
      definitionSha256?: string
    }
>

export type ReleaseMigrationRun = Readonly<{
  target: ReleaseTarget
  migration: ReleaseMigration
  migrationFile: string
  databaseUrl: string
  databaseName: string
  endpoint: string
  postconditions: readonly Postcondition[]
  preflightTable?: string
}>

export type MigrationQuery = (
  text: string,
  values?: readonly unknown[],
) => Promise<unknown>

export type MigrationDatabase = Readonly<{
  identify(): Promise<Readonly<{ databaseName: string }>>
  inspect: MigrationQuery
  transaction<T>(operation: (query: MigrationQuery) => Promise<T>): Promise<T>
}>

export const PREVIEW_MIGRATION_ACKNOWLEDGEMENT =
  'APPLY_ADDITIVE_MARKET_SCHEMA_TO_ISOLATED_PREVIEW'
export const PRODUCTION_MIGRATION_ACKNOWLEDGEMENT =
  'APPLY_ADDITIVE_MARKET_SCHEMA_TO_PRODUCTION'
