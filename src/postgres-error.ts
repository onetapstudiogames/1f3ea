export interface PostgresErrorDetails {
  code: string | null
  constraint: string | null
}

export function postgresErrorDetails(error: unknown, depth = 0): PostgresErrorDetails {
  if (!error || typeof error !== 'object' || depth > 3) return { code: null, constraint: null }
  const candidate = error as { code?: unknown; constraint?: unknown; sourceError?: unknown }
  if (typeof candidate.code === 'string' || typeof candidate.constraint === 'string') {
    return {
      code: typeof candidate.code === 'string' ? candidate.code : null,
      constraint: typeof candidate.constraint === 'string' ? candidate.constraint : null,
    }
  }
  return postgresErrorDetails(candidate.sourceError, depth + 1)
}

export function postgresUniqueConstraint(error: unknown): string | null {
  const details = postgresErrorDetails(error)
  return details.code === '23505' ? details.constraint : null
}
