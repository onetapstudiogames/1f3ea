import assert from 'node:assert/strict'
import test from 'node:test'

import { validateDocumentation } from '../scripts/check-docs-index.ts'

test('every Markdown document declares its status and appears in the documentation map', () => {
  assert.deepEqual(validateDocumentation(), [])
})
