import test from 'node:test'

import { runMarketPostgresFinalityCases } from '../support/market-postgres-finality-cases.ts'
import { startMarketPostgresHarness } from '../support/market-postgres-harness.ts'
import { runMarketPostgresMigrationCases } from '../support/market-postgres-migration-cases.ts'
import { runMarketPostgresX402ResultCases } from '../support/market-postgres-x402-result-cases.ts'

test('real PostgreSQL prepares every public read and the direct purchase timing sentinel', async t => {
  const app = await startMarketPostgresHarness(t)
  await runMarketPostgresMigrationCases(t, app)
  await runMarketPostgresFinalityCases(t, app)
  await runMarketPostgresX402ResultCases(t, app)
})
