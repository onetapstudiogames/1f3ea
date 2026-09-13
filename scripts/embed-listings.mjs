import { readFileSync, writeFileSync } from 'node:fs'

const commit = readFileSync(new URL('./listing-source.txt', import.meta.url), 'utf8').trim()
if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('listing-source.txt must contain a plugin commit SHA')
const base = 'https://raw.githubusercontent.com/onetapstudiogames/1f3ea-marketplace'
const path = 'docs/listing-metadata.json'
const fetchText = async url => {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error(`Listing source returned ${response.status}: ${url}`)
  return response.text()
}
const pinned = JSON.parse(await fetchText(`${base}/${commit}/${path}`))
if (typeof pinned.displayName !== 'string' || typeof pinned.longDescription !== 'string' || !Array.isArray(pinned.directories)) {
  throw new Error('Pinned listing metadata is incomplete')
}
const current = await fetch(`${base}/main/${path}`, { signal: AbortSignal.timeout(10000) })
if (current.status === 404) {
  // Bootstrap only: the site PR can be checked before the plugin kit reaches main.
  const manifest = JSON.parse(await fetchText(`${base}/main/.claude-plugin/plugin.json`))
  const parts = version => /^\d+\.\d+\.\d+$/u.test(version) ? version.split('.').map(Number) : null
  const published = parts(manifest.version)
  const pinnedVersion = parts(pinned.version)
  if (!published || !pinnedVersion || !pinnedVersion.some((value, index) =>
    value > published[index] && pinnedVersion.slice(0, index).every((part, earlier) => part === published[earlier]))) {
    throw new Error('Plugin main has no listing metadata and is not older than the pinned kit')
  }
} else {
  if (!current.ok) throw new Error(`Current listing source returned ${current.status}`)
  const main = JSON.parse(await current.text())
  if (JSON.stringify(main) !== JSON.stringify(pinned)) {
    throw new Error('Plugin listing metadata changed on main. Update scripts/listing-source.txt to its current commit and run npm run generate.')
  }
}
const generated = `// GENERATED from 1f3ea-marketplace ${commit} ${path} by scripts/embed-listings.mjs.\nexport const LISTING_METADATA = ${JSON.stringify(pinned, null, 2)} as const\n`
const output = new URL('../src/listing-metadata.ts', import.meta.url)
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== generated) throw new Error('listing-metadata.ts is stale; run npm run generate')
} else {
  writeFileSync(output, generated)
}
