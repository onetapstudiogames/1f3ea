import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Hono } from 'hono'

process.env.TREASURY_ADDRESS ??= '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'

const [{ default: app }, { FRONTDOOR, LLMS }, facts, { CONNECTOR_TOOL_HELP }, { MCP_TOOLS }, { registerTrustRoutes }, { formatActivity }, { WINDOW_JS }] = await Promise.all([
  import('../src/index.ts'),
  import('../src/door.ts'),
  import('../src/market-facts.ts'),
  import('../src/market-help.ts'),
  import('../src/mcp-tool-catalog.ts'),
  import('../src/trust-routes.ts'),
  import('../src/market.ts'),
  import('../src/window-client.ts'),
])

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const publicDoorFacts = [
  facts.MARKET_ONE_LINE,
  facts.AGENT_ONLY_BY_DESIGN,
  facts.REQUEST_FIELD_CONVENTION,
  facts.IDENTITY_FIELD_LIMITS,
  facts.COLLECTION_LIMITS,
  facts.SOCIAL_LIMITS,
  facts.PAYMENT_TRANSPORT_LIMITS,
  facts.PUBLIC_READ_LIMITS,
  facts.HOSTED_SIGNIN_LIMITS,
  facts.IDENTITY_LIMITS,
  facts.ORDINARY_LISTING_CONTRACT,
  facts.LISTING_SUBMISSION_RULES,
  facts.WORLD_PENDING_DRAFT_RULE,
  facts.MACHINE_WINDOW_RULE,
  facts.WORLD_DRAFT_FIELDS,
  facts.WORLD_ACTIVATION_FIELDS,
  facts.ORDINARY_PAYMENT_TERMINALS,
  facts.HOSTED_PROOF_CONTRACT,
  facts.FINE_PRINT_ROUTES,
] as const
for (const value of publicDoorFacts) {
  assert(FRONTDOOR.includes(value), `front door omits canonical fact: ${value.slice(0, 60)}`)
  assert(LLMS.includes(value), `machine index omits canonical fact: ${value.slice(0, 60)}`)
}

assert(Buffer.byteLength(FRONTDOOR) <= 36 * 1024, 'front door exceeds its 36 KiB public-text budget')
const maxActivity = formatActivity(Array.from({ length: 5 }, () => ({
  at: '9999-12-31T23:59:59.999Z', kind: 'world_sale', actor: 'a'.repeat(facts.MARKET_LIMITS.identityFields.handleMaxChars),
  detail: { listing_id: 2_147_483_647 },
})), { total: 2_147_483_647, hasMore: true, nextBeforeId: 2_147_483_647, scope: 'window' })
assert(Buffer.byteLength(`${FRONTDOOR.trimEnd()}\n\n${maxActivity}`) <= 36 * 1024,
  'served front door exceeds its 36 KiB budget under maximum public activity')
for (const tool of MCP_TOOLS)
  assert(Buffer.byteLength(tool.description) <= 4 * 1024, `${tool.name} description exceeds 4 KiB`)
for (const [name, value] of [
  ['MAX_FILTER_CHARS', facts.MARKET_LIMITS.collection.queryMaxChars],
  ['EVENT_PAGE_SIZE', facts.MARKET_LIMITS.collection.windowEvents],
  ['LISTING_PAGE_SIZE', facts.MARKET_LIMITS.collection.windowListings],
  ['MERCHANT_PAGE_SIZE', facts.MARKET_LIMITS.collection.windowMerchants],
  ['COMMENT_PAGE_SIZE', facts.MARKET_LIMITS.collection.listingCommentsPage],
] as const)
  assert(WINDOW_JS.includes(`const ${name} = ${value}`), `window client ${name} differs from canonical collection facts`)

const servedFrontDoor = await (await app.request('/')).text()
assert(servedFrontDoor.startsWith(FRONTDOOR.trimEnd()), 'GET / does not serve the generated front door')
assert(Buffer.byteLength(servedFrontDoor) <= 36 * 1024, 'served front door exceeds its 36 KiB budget')
assert(await (await app.request('/llms.txt')).text() === LLMS, 'GET /llms.txt does not serve the generated machine index')
const servedHelp = await (await app.request('/api/help')).json() as { tools?: unknown }
assert(JSON.stringify(servedHelp.tools) === JSON.stringify(CONNECTOR_TOOL_HELP), 'GET /api/help differs from the connector catalog')
const humanHelp = await (await app.request('/help')).text()
for (const tool of CONNECTOR_TOOL_HELP) assert(humanHelp.includes(tool.name), `/help omits ${tool.name}`)
const official = await (await app.request('/api/official')).json() as {
  ordinary_direct_payment?: { terminal_no_delivery?: string }
}
assert(official.ordinary_direct_payment?.terminal_no_delivery === facts.ORDINARY_PAYMENT_TERMINALS,
  'GET /api/official omits the canonical ordinary-payment terminal states')
const toolList = await (await app.request('/mcp', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
})).json() as { result?: { tools?: Array<{ name: string; description: string; inputSchema: unknown; annotations: unknown }> } }
const canonicalTools = MCP_TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }))
assert(JSON.stringify(toolList.result?.tools) === JSON.stringify(canonicalTools), 'served MCP tool names, descriptions, schemas, or annotations differ from the canonical catalog')
for (const tool of toolList.result?.tools ?? [])
  assert(Buffer.byteLength(tool.description) <= 4 * 1024, `served ${tool.name} description exceeds 4 KiB`)

const schema = readFileSync('db/schema.sql', 'utf8')
const handlePattern = `^[a-z0-9][a-z0-9-]{${facts.MARKET_LIMITS.identityFields.handleMinChars - 1},${facts.MARKET_LIMITS.identityFields.handleMaxChars - 1}}$`
assert(schema.includes(`CHECK (handle ~ '${handlePattern}')`) && schema.includes(`handle ~ '${handlePattern}'`),
  'merchant handle limits differ from database constraints')
assert(schema.includes(`char_length(model) <= ${facts.MARKET_LIMITS.identityFields.modelMaxChars}`),
  'merchant model limit differs from its database constraint')
assert(schema.includes(`char_length(storefront_line) <= ${facts.MARKET_LIMITS.identityFields.storefrontLineMaxChars}`),
  'store-line limit differs from its database constraint')
assert(schema.includes(`char_length(body) BETWEEN 1 AND ${facts.MARKET_LIMITS.social.commentMaxChars}`),
  'comment limit differs from its database constraint')
assert(facts.MARKET_LIMITS.world.pendingDraftsPerSeller === 1 &&
  schema.includes("CREATE UNIQUE INDEX IF NOT EXISTS world_drafts_one_pending_per_merchant\n  ON world_drafts (merchant_id) WHERE state = 'pending';"),
  'world pending-draft limit differs from its database constraint')
assert(facts.MARKET_LIMITS.world.draftLifetimeMinutes === 60 && schema.includes("expires_at    TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '1 hour')"),
  'world draft lifetime differs from its database default')
assert(schema.includes(`expires_at    TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '${facts.MARKET_LIMITS.world.checkoutMinutes} minutes')`),
  'world checkout lifetime differs from its database default')
assert(schema.includes(`CHECK (expires_at > created_at AND expires_at <= created_at + interval '${facts.MARKET_LIMITS.purchase.directIntentMinutes} minutes')`),
  'direct purchase-intent lifetime differs from its database constraint')

const oldIdentity = {
  recovery: process.env.MARKET_IDENTITY_RECOVERY_ENABLED,
  rotation: process.env.MARKET_IDENTITY_ROTATION_ENABLED,
  coding: process.env.MARKET_CODING_IDENTITY_ENABLED,
  origin: process.env.PUBLIC_ORIGIN,
}
Object.assign(process.env, {
  MARKET_IDENTITY_RECOVERY_ENABLED: 'true',
  MARKET_IDENTITY_ROTATION_ENABLED: 'true',
  MARKET_CODING_IDENTITY_ENABLED: 'true',
  PUBLIC_ORIGIN: 'https://1f3ea.com',
})
const enabledApp = new Hono()
registerTrustRoutes(enabledApp, {
  domain: 'https://1f3ea.com', hostedMarketSignin: { ready: true, origin: 'https://1f3ea.com' },
})
const enabledOfficial = await (await enabledApp.request('/api/official')).json() as {
  identity?: { hosted_status?: string; coding_client_doors?: unknown }
}
assert(enabledOfficial.identity?.hosted_status === facts.HOSTED_PROOF_CONTRACT,
  'enabled official facts do not use the canonical host-proof sentence')
assert(Boolean(enabledOfficial.identity?.coding_client_doors), 'enabled official facts omit current coding-client doors')
for (const [name, value] of Object.entries(oldIdentity)) {
  const key = ({ recovery: 'MARKET_IDENTITY_RECOVERY_ENABLED', rotation: 'MARKET_IDENTITY_ROTATION_ENABLED', coding: 'MARKET_CODING_IDENTITY_ENABLED', origin: 'PUBLIC_ORIGIN' } as const)[name as keyof typeof oldIdentity]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

const mounted = app.routes.filter(route => route.method !== 'ALL')
function isMounted(method: string, endpoint: string): boolean {
  const wanted = endpoint.split('/').filter(Boolean)
  return mounted.some(route => {
    if (route.method !== method) return false
    const actual = route.path.split('/').filter(Boolean)
    return actual.length === wanted.length && actual.every((segment, index) =>
      segment.startsWith(':') || segment === wanted[index])
  })
}
for (const tool of CONNECTOR_TOOL_HELP) for (const route of tool.endpoints)
  assert(isMounted(route.method, route.path), `${tool.name} advertises unmounted route ${route.method} ${route.path}`)

function sampleValue(schema: Record<string, unknown>): unknown {
  if (Array.isArray(schema.enum)) return schema.enum[0]
  if (schema.type === 'integer' || schema.type === 'number') return schema.minimum ?? 1
  if (schema.type === 'boolean') return false
  if (schema.type === 'array') return []
  return 'agent'
}
function requiredArguments(tool: (typeof MCP_TOOLS)[number]): Record<string, unknown> {
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>
  const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required as string[] : []
  return Object.fromEntries(required.map(name => [name, sampleValue(properties[name] ?? {})]))
}
function matchesTemplate(actual: { method: string; path: string }, template: { method: string; path: string }): boolean {
  if (actual.method !== template.method) return false
  const left = actual.path.split('?')[0]!.split('/').filter(Boolean)
  const right = template.path.split('/').filter(Boolean)
  return left.length === right.length && right.every((part, index) => part.startsWith(':') || part === left[index])
}
for (const tool of MCP_TOOLS) {
  const base = requiredArguments(tool)
  const samples = tool.name === 'world_status'
    ? [{ draft_id: 1 }, { checkout_id: 1 }]
    : tool.name === 'buy'
      ? [{ id: 1 }, { id: 1, payer_wallet: '0x1111111111111111111111111111111111111111' }, { id: 1, intent_id: 1, tx_hash: '0x1', payer_signature: '0x2' }]
      : [base]
  const dispatched = samples.map(args => tool.route(args))
  for (const actual of dispatched)
    assert(tool.routeTemplates.some(template => matchesTemplate(actual, template)), `${tool.name} dispatches an undocumented route`)
  for (const template of tool.routeTemplates)
    assert(dispatched.some(actual => matchesTemplate(actual, template)), `${tool.name} route template lacks a dispatch branch: ${template.path}`)
}

const generated = new Set(['src/door.ts', 'src/frontdoor.txt', 'src/llms.txt', 'src/changelog-source.ts'])
const roots = ['src', 'docs', 'seed', 'README.md', 'CHANGELOG.md']
function filesUnder(path: string): string[] {
  const absolute = resolve(path)
  if (!statSync(absolute).isDirectory()) return [path.replaceAll('\\', '/')]
  return readdirSync(absolute, { withFileTypes: true }).flatMap(entry =>
    filesUnder(`${path}/${entry.name}`))
}
const authored = roots.flatMap(root => filesUnder(root)).filter(path =>
  !generated.has(path) && /\.(?:md|txt|ts|json)$/u.test(path))
const paragraphs = new Map<string, string>()
function proseBlocks(path: string, source: string): string[] {
  if (!path.endsWith('.ts')) return source
    .replace(/```[\s\S]*?```/gu, '')
    .split(/\r?\n\s*\r?\n/gu)
    .filter(block => !/^\s*(?:#{1,6}\s|\|.*\|| {4}\S)/u.test(block))
  return [...source.matchAll(/\/\*[\s\S]*?\*\/|`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/gu)]
    .map(match => match[0].replace(/^\/\*|\*\/$/gu, '').replace(/^['"`]|['"`]$/gu, ''))
}
function duplicateProse(entries: readonly { path: string; source: string }[]): string | null {
  const seen = new Map<string, string>()
  for (const { path, source } of entries) {
    for (const raw of proseBlocks(path, source)) {
      const normalized = raw.replace(/\s+/gu, ' ').trim()
      const wordCount = normalized.match(/[\p{L}\p{N}_'-]+/gu)?.length ?? 0
      const sentenceCount = normalized.match(/[.!?](?=\s|$)/gu)?.length ?? 0
      const proseStart = /^(?:<[^>]+>\s*)*[A-Z0-9]/u.test(normalized)
      const meaningfulParagraph = proseStart && wordCount >= 3 && sentenceCount >= 1
      if (!meaningfulParagraph) continue
      const prior = seen.get(normalized)
      if (prior) return `duplicate authored paragraph in ${prior} and ${path}: ${normalized.slice(0, 120)}`
      seen.set(normalized, path)
    }
  }
  return null
}
assert(duplicateProse([
  { path: 'one.md', source: 'Never share your key.' },
  { path: 'two.md', source: 'Never share your key.' },
]) !== null, 'duplicate prose detector does not catch injected duplicate paragraphs')
assert(duplicateProse([{ path: 'same.md', source: 'A same-file paragraph repeated by mistake.\n\nA same-file paragraph repeated by mistake.' }]) !== null,
  'duplicate prose detector does not catch same-file duplicates')
assert(duplicateProse([
  { path: 'one.ts', source: 'const one = "Do not pay again."' },
  { path: 'two.ts', source: 'const two = "Do not pay again."' },
]) !== null, 'duplicate prose detector does not catch TypeScript string duplicates')
const authoredSources = authored.map(path => ({ path, source: readFileSync(path, 'utf8') }))
const authoredDuplicate = duplicateProse(authoredSources)
assert(!authoredDuplicate, authoredDuplicate ?? '')
for (const entry of authoredSources) for (const raw of proseBlocks(entry.path, entry.source)) {
  const normalized = raw.replace(/\s+/gu, ' ').trim()
  const wordCount = normalized.match(/[\p{L}\p{N}_'-]+/gu)?.length ?? 0
  const sentenceCount = normalized.match(/[.!?](?=\s|$)/gu)?.length ?? 0
  if (/^(?:<[^>]+>\s*)*[A-Z0-9]/u.test(normalized) && wordCount >= 3 && sentenceCount >= 1)
    paragraphs.set(normalized, entry.path)
}

const endpointCount = CONNECTOR_TOOL_HELP.reduce((count, tool) => count + tool.endpoints.length, 0)
console.log(`contract checks passed: ${MCP_TOOLS.length} tools, ${endpointCount} mounted routes, ${paragraphs.size} complete-sentence authored prose blocks, 0 duplicates in that scope`)
