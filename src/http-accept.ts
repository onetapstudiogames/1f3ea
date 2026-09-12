function qualityForRange(rawRange: string, mediaType: string): { quality: number; specificity: number } | null {
  const [wantedType, wantedSubtype] = mediaType.toLowerCase().split('/')
  const [rawMedia = '', ...parameters] = rawRange.trim().split(';')
  const [rangeType, rangeSubtype] = rawMedia.trim().toLowerCase().split('/')
  const specificity = rangeType === wantedType && rangeSubtype === wantedSubtype
    ? 2
    : rangeType === wantedType && rangeSubtype === '*'
      ? 1
      : rangeType === '*' && rangeSubtype === '*'
        ? 0
        : -1
  if (specificity < 0) return null
  const qualityMatch = parameters
    .map(parameter => /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/iu.exec(parameter))
    .find(match => match !== null)
  return { quality: qualityMatch ? Number(qualityMatch[1]) : 1, specificity }
}

export function acceptedQuality(accept: string, mediaType: string): number {
  let best = { quality: 0, specificity: -1 }
  for (const rawRange of accept.split(',')) {
    const candidate = qualityForRange(rawRange, mediaType)
    if (!candidate) continue
    if (
      candidate.specificity > best.specificity ||
      (candidate.specificity === best.specificity && candidate.quality > best.quality)
    ) best = candidate
  }
  return best.quality
}

function exactAcceptedQuality(accept: string, mediaType: string): number {
  let quality = 0
  for (const rawRange of accept.split(',')) {
    const candidate = qualityForRange(rawRange, mediaType)
    if (candidate?.specificity === 2) quality = Math.max(quality, candidate.quality)
  }
  return quality
}

function acceptedHtmlQuality(accept: string): number {
  return Math.max(
    acceptedQuality(accept, 'text/html'),
    exactAcceptedQuality(accept, 'application/xhtml+xml'),
  )
}

export function acceptsHtml(
  accept: string | undefined,
  machineType = 'application/json',
): boolean {
  if (!accept) return false
  const htmlQuality = acceptedHtmlQuality(accept)
  return htmlQuality > 0 && htmlQuality > acceptedQuality(accept, machineType)
}

export function explicitlyPrefersJson(accept: string | undefined): boolean {
  if (!accept) return false
  const jsonQuality = acceptedQuality(accept, 'application/json')
  if (jsonQuality <= 0) return false
  const htmlQuality = acceptedHtmlQuality(accept)
  return jsonQuality >= htmlQuality
}
