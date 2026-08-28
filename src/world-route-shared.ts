export function positiveId(value: string): number | null {
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function dateIsPast(value: string): boolean {
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date <= new Date()
}

export function upstreamStatus(result: { kind: string }): 409 | 503 {
  return result.kind === 'not_found' ? 409 : 503
}
