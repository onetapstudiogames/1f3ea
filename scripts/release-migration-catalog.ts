import { createHash } from 'node:crypto'
import type { Postcondition } from './release-migration-types.ts'

export function rowsFromQuery(result: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(result)) throw new Error('database returned an invalid result')
  return result.filter(
    (row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row),
  )
}

type CatalogQuery = (text: string, values: readonly unknown[]) => Promise<unknown>

function catalogDefinitionSha256(definition: string): string {
  const normalized = definition.replace(/\s+/gu, ' ').trim().toLowerCase()
  return createHash('sha256').update(normalized).digest('hex')
}

async function exactDefinitionMatches(
  postcondition: Extract<Postcondition, { kind: 'index' | 'constraint' | 'function' | 'trigger' }>,
  query: CatalogQuery,
): Promise<boolean> {
  if (!postcondition.definitionSha256) return true
  let rows: readonly Record<string, unknown>[]
  if (postcondition.kind === 'index') {
    rows = rowsFromQuery(await query(
      'SELECT pg_get_indexdef(to_regclass($1)) AS definition',
      [`public.${postcondition.name}`],
    ))
  } else if (postcondition.kind === 'constraint') {
    rows = rowsFromQuery(await query(
      `SELECT pg_get_constraintdef(oid, true) AS definition
       FROM pg_constraint WHERE conrelid = to_regclass($1) AND conname = $2`,
      [`public.${postcondition.table}`, postcondition.name],
    ))
  } else if (postcondition.kind === 'function') {
    rows = rowsFromQuery(await query(
      'SELECT pg_get_functiondef(to_regprocedure($1)) AS definition',
      [`public.${postcondition.name}()`],
    ))
  } else {
    rows = rowsFromQuery(await query(
      `SELECT pg_get_triggerdef(oid, true) AS definition
       FROM pg_trigger WHERE tgrelid = to_regclass($1) AND tgname = $2 AND NOT tgisinternal`,
      [`public.${postcondition.table}`, postcondition.name],
    ))
  }
  const definition = rows[0]?.definition
  return typeof definition === 'string'
    && catalogDefinitionSha256(definition) === postcondition.definitionSha256
}

/** Check every declared migration object against PostgreSQL's catalogs. */
export async function missingMigrationPostconditions(
  postconditions: readonly Postcondition[],
  query: CatalogQuery,
): Promise<readonly string[]> {
  const missing: string[] = []
  for (const postcondition of postconditions) {
    let present = false
    if (postcondition.kind === 'table') {
      const rows = rowsFromQuery(await query(
        `SELECT EXISTS (
           SELECT 1 FROM pg_class
           WHERE oid = to_regclass($1) AND relkind IN ('r', 'p')
         ) AS present`,
        [`public.${postcondition.name}`],
      ))
      present = rows[0]?.present === true
    } else if (postcondition.kind === 'index') {
      const rows = rowsFromQuery(await query(
        `SELECT EXISTS (
           SELECT 1 FROM pg_class relation
           JOIN pg_index index_record ON index_record.indexrelid = relation.oid
           WHERE relation.oid = to_regclass($1)
             AND index_record.indrelid = to_regclass($2)
             AND index_record.indisvalid AND index_record.indisready
             AND ($3::boolean IS NULL OR index_record.indisunique = $3)
             AND NOT EXISTS (
               SELECT 1 FROM unnest($4::text[]) fragment
               WHERE position(fragment IN lower(pg_get_indexdef(index_record.indexrelid))) = 0
             )
         ) AS present`,
        [
          `public.${postcondition.name}`,
          `public.${postcondition.table}`,
          postcondition.unique ?? null,
          (postcondition.definitionIncludes ?? []).map(fragment => fragment.toLowerCase()),
        ],
      ))
      present = rows[0]?.present === true
    } else if (postcondition.kind === 'column') {
      const checksDefault = Object.prototype.hasOwnProperty.call(
        postcondition,
        'defaultExpression',
      )
      const rows = rowsFromQuery(await query(
        `SELECT EXISTS (
           SELECT 1 FROM pg_attribute attribute
           LEFT JOIN pg_attrdef default_record
             ON default_record.adrelid = attribute.attrelid
             AND default_record.adnum = attribute.attnum
           WHERE attribute.attrelid = to_regclass($1)
             AND attribute.attname = $2 AND NOT attribute.attisdropped
             AND ($3::text IS NULL OR format_type(attribute.atttypid, attribute.atttypmod) = $3)
             AND ($4::boolean IS NULL OR attribute.attnotnull = $4)
             AND (
               NOT $5::boolean
               OR ($6::text IS NULL AND default_record.oid IS NULL)
               OR pg_get_expr(default_record.adbin, default_record.adrelid) = $6
             )
         ) AS present`,
        [
          `public.${postcondition.table}`,
          postcondition.name,
          postcondition.dataType ?? null,
          postcondition.notNull ?? null,
          checksDefault,
          postcondition.defaultExpression ?? null,
        ],
      ))
      present = rows[0]?.present === true
    } else if (postcondition.kind === 'constraint') {
      const rows = rowsFromQuery(await query(
        `SELECT EXISTS (
           SELECT 1 FROM pg_constraint
           WHERE conrelid = to_regclass($1) AND conname = $2
             AND ($3::boolean IS NULL OR convalidated = $3)
             AND ($4::boolean IS NULL OR condeferrable = $4)
             AND ($5::boolean IS NULL OR condeferred = $5)
             AND NOT EXISTS (
               SELECT 1 FROM unnest($6::text[]) fragment
               WHERE position(fragment IN lower(pg_get_constraintdef(oid, true))) = 0
             )
         ) AS present`,
        [
          `public.${postcondition.table}`,
          postcondition.name,
          postcondition.validated ?? null,
          postcondition.deferrable ?? null,
          postcondition.initiallyDeferred ?? null,
          (postcondition.definitionIncludes ?? []).map(fragment => fragment.toLowerCase()),
        ],
      ))
      present = rows[0]?.present === true
    } else if (postcondition.kind === 'function') {
      const rows = rowsFromQuery(await query(
        `SELECT EXISTS (
           SELECT 1 FROM pg_proc
           WHERE oid = to_regprocedure($1)
             AND prorettype = 'trigger'::regtype
             AND ($2 = '' OR position($2 IN prosrc) > 0)
             AND NOT EXISTS (
               SELECT 1 FROM unnest($3::text[]) fragment
               WHERE position(fragment IN lower(prosrc)) = 0
             )
         ) AS present`,
        [
          `public.${postcondition.name}()`,
          postcondition.contains ?? '',
          (postcondition.containsAll ?? []).map(fragment => fragment.toLowerCase()),
        ],
      ))
      present = rows[0]?.present === true
    } else {
      const rows = rowsFromQuery(await query(
        `SELECT EXISTS (
           SELECT 1 FROM pg_trigger
           WHERE tgrelid = to_regclass($1) AND tgname = $2 AND NOT tgisinternal
             AND tgfoid = to_regprocedure($3)
             AND tgdeferrable = $4 AND tginitdeferred = $4
             AND ($5::text IS NULL OR tgenabled::text = $5)
             AND NOT EXISTS (
               SELECT 1 FROM unnest($6::text[]) fragment
               WHERE position(fragment IN lower(pg_get_triggerdef(oid, true))) = 0
             )
         ) AS present`,
        [
          `public.${postcondition.table}`,
          postcondition.name,
          `public.${postcondition.functionName}()`,
          postcondition.deferred,
          postcondition.enabled ?? null,
          (postcondition.definitionIncludes ?? []).map(fragment => fragment.toLowerCase()),
        ],
      ))
      present = rows[0]?.present === true
    }
    if (
      present && postcondition.kind !== 'table' && postcondition.kind !== 'column'
      && postcondition.definitionSha256
    ) {
      present = await exactDefinitionMatches(postcondition, query)
    }
    if (!present) {
      const owner = 'table' in postcondition ? `${postcondition.table}.` : ''
      missing.push(`${postcondition.kind}:${owner}${postcondition.name}`)
    }
  }
  return missing
}
