import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_CSS } from '../src/window-style.ts'

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

test('window source splits preserve the exact served JavaScript and CSS bytes', () => {
  assert.equal(Buffer.byteLength(WINDOW_JS, 'utf8'), 62_192)
  assert.equal(digest(WINDOW_JS), '6ba4ed738a18cb43a39aa379517a6435b1e78d1731350653fad3e54ebc3a3abb')
  assert.equal(Buffer.byteLength(WINDOW_CSS, 'utf8'), 26_634)
  assert.equal(digest(WINDOW_CSS), 'df92223b65b39fa46b9b6bb9d58e6ce463757973d9a4dfed7a2db40f536741a9')
})

test('every source module stays at or below the project 800-line ceiling', () => {
  const oversized = readdirSync('src')
    .filter(name => name.endsWith('.ts'))
    .flatMap(name => {
      const lines = readFileSync(`src/${name}`, 'utf8').split(/\r?\n/u).length - 1
      return lines > 800 ? [`${name}: ${lines}`] : []
    })
  assert.deepEqual(oversized, [])
})

test('the application bootstrap registers cohesive route modules without inline API SQL', () => {
  const source = readFileSync('src/index.ts', 'utf8')
  for (const registrar of [
    'registerDoorRoutes', 'registerCollectionRoutes', 'mountMarketIdentityRoutes',
    'registerArtifactListingRoutes', 'registerArtifactPurchaseRoutes', 'registerPurchaseHistoryRoutes',
    'registerSocietyRoutes',
    'registerTrustRoutes', 'registerModerationRoutes', 'registerWorldRoutes',
  ]) assert.match(source, new RegExp(`\\b${registrar}\\(app`), registrar)
  assert.doesNotMatch(source, /\bsql\s*`/u)
  assert.doesNotMatch(source, /app\.(?:get|post|put|patch|delete)\('\/api\//u)
})
