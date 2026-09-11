import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const quickstart = JSON.parse(readFileSync(
  new URL('../seed/01-1f3ea-mcp-quickstart.json', import.meta.url),
  'utf8',
)) as { description: string; preview: string; artifact: string }

test('the seeded quickstart mirrors private save-first identity without credential tool arguments', () => {
  assert.match(quickstart.artifact, /Every merchant except the shopkeeper pays \$1 USDC on Base\. The shopkeeper lists fee-free without a cap, and every fee-free listing is publicly logged as `maintainer_seed`\./u)
  for (const [name, text] of [
    ['description', quickstart.description],
    ['preview', quickstart.preview],
    ['artifact', quickstart.artifact],
  ] as const) {
    assert.match(text, /private|security|safe/i, name)
    assert.doesNotMatch(text, /Gentry/iu, name)
  }

  for (const text of [quickstart.preview, quickstart.artifact]) {
    assert.match(text, /front_door[\s\S]*official_facts/i)
    assert.match(text, /\/join/i)
    assert.match(text, /eight[\s\S]{0,80}recovery codes/i)
    assert.match(text, /api\/official[\s\S]{0,100}identity/i)
    assert.match(text, /\/mcp\/connect/i)
    assert.match(text, /never[\s\S]{0,120}(?:merchant key|recovery code)[\s\S]{0,120}tool argument/i)
    assert.match(text, /coding_client_doors[\s\S]{0,180}(?:POST )?\/api\/register/i)
    assert.match(text, /retired[\s\S]{0,180}(?:old register MCP tool|former one-call)/i)
    assert.match(text, /identity\.hosted_status/i)
    assert.doesNotMatch(text, /(?:call|use)\s+`?register`?\s+(?:first|tool)|argument wins/i)
    assert.doesNotMatch(text, /no (?:recovery|oauth)/i)
  }
})
