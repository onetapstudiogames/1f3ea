import { randomUUID } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { allowOAuthForHostedConnectorRequest, anyCredentialShapeRe, SECRET_PREFIX } from './core.ts'
import { MARKET_OAUTH_SCOPE, marketOAuthChallenge, marketPublicOrigin } from './market-oauth-config.ts'
import {
  MCP_TOOLS,
  marketToolTitle,
  PUBLIC_MCP_TOOL_NAMES,
  ROTATION_POLICY,
  ToolInputError,
  UNTRUSTED_MARKET_TEXT,
} from './mcp-tool-catalog.ts'
import { marketRefusalNextStep, type MarketRefusalReason } from './market-refusal.ts'

/**
 * MCP over plain JSON-RPC 2.0 — hand-rolled, stateless, no sessions, no SSE,
 * exactly the 1f916 approach. Tool calls are dispatched through the app's own
 * HTTP routes (app.request), so the API is the single source of truth and the
 * MCP surface can never drift from it.
 *
 * Auth: Authorization: Bearer <secret> header. Secrets are never accepted as
 * tool arguments because hosts may record arguments in transcripts or logs.
 */

const PROTOCOL_DEFAULT = '2025-06-18'

export interface McpOptions {
  hostedChat?: boolean
  forwardUnauthorizedStatus?: boolean
}

const OAUTH_SCHEME = Object.freeze({ type: 'oauth2', scopes: [MARKET_OAUTH_SCOPE] })
const NOAUTH_SCHEME = Object.freeze({ type: 'noauth' })
// Built from core.ts's CREDENTIAL_SHAPES table so a new credential family (or a length change
// to an existing one) can never land recognized by only one of the guard below and the
// connector-response redaction — both read the exact same pattern.
const CREDENTIAL_VALUE = anyCredentialShapeRe('i')
const CREDENTIAL_REDACTION = anyCredentialShapeRe('gi')
const CREDENTIAL_FIELD =
  /^(?:secret|merchant_key|replacement_key|recovery_code|access_token|refresh_token|authorization_code|pairing_code|code)$/i
const SAFE_ARGUMENT_NAME = /^[a-z][a-z0-9_]{0,63}$/
const FALLBACK_FRONT_DOOR = 'https://1f3ea.com/'

function containsCredential(value: unknown): boolean {
  if (typeof value === 'string') return CREDENTIAL_VALUE.test(value)
  if (Array.isArray(value)) return value.some(containsCredential)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, nested]) =>
    CREDENTIAL_FIELD.test(key) || CREDENTIAL_VALUE.test(key) || containsCredential(nested))
}

function redactCredentials(value: string): string {
  return value.replace(CREDENTIAL_REDACTION, '[redacted 1F3EA credential]')
}

function safeguardToolResponseText(value: string): { text: string; withheld: boolean } {
  const directlyRedacted = redactCredentials(value)

  let parsed: unknown
  try {
    parsed = JSON.parse(directlyRedacted)
  } catch {
    return { text: directlyRedacted, withheld: false }
  }

  try {
    const normalized = JSON.stringify(parsed)
    if (normalized === undefined) {
      return {
        text: JSON.stringify({ error: 'The market response was withheld because it could not be handled safely.' }),
        withheld: true,
      }
    }
    const normalizedRedacted = redactCredentials(normalized)
    return normalizedRedacted === normalized
      ? { text: directlyRedacted, withheld: false }
      : { text: normalizedRedacted, withheld: false }
  } catch {
    return {
      text: JSON.stringify({ error: 'The market response was withheld because it could not be handled safely.' }),
      withheld: true,
    }
  }
}

function configuredFrontDoor(): string {
  try {
    return `${marketPublicOrigin()}/`
  } catch {
    return FALLBACK_FRONT_DOOR
  }
}

function appendResponseHeader(c: Context, name: string, value: string): void {
  const current = c.res.headers.get(name)?.split(',').map(part => part.trim()).filter(Boolean) ?? []
  if (!current.some(part => part.toLowerCase() === value.toLowerCase())) current.push(value)
  c.header(name, current.join(', '))
}

function hostedAuthenticationHeaders(c: Context, challenge: string): void {
  c.header('WWW-Authenticate', challenge)
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  appendResponseHeader(c, 'Vary', 'Authorization')
  appendResponseHeader(c, 'Access-Control-Expose-Headers', 'WWW-Authenticate')
}

type McpErrorClass =
  | 'bad_input'
  | 'not_found'
  | 'auth_required'
  | 'forbidden'
  | 'payment_required'
  | 'conflict'
  | 'rate_limited'
  | 'market_fault'
  | 'unreachable'

function reasonForErrorClass(errorClass: McpErrorClass): MarketRefusalReason {
  if (errorClass === 'auth_required') return 'auth_required'
  if (errorClass === 'payment_required') return 'payment_required'
  if (errorClass === 'forbidden') return 'forbidden'
  if (errorClass === 'not_found') return 'not_found'
  if (errorClass === 'conflict') return 'request_conflict'
  if (errorClass === 'rate_limited') return 'rate_limited'
  if (errorClass === 'market_fault' || errorClass === 'unreachable') return 'market_fault'
  return 'invalid_request'
}

function connectorRefusalEnvelope(
  c: Context,
  errorClass: McpErrorClass,
  trustedRequestId?: string | null,
  nextStep?: string,
  transportStatus = 200,
): Record<string, unknown> {
  const reason = reasonForErrorClass(errorClass)
  const requestId = trustedRequestId || randomUUID()
  c.header('X-Request-ID', requestId)
  c.header('X-1F3EA-Error-Class', errorClass)
  c.header('X-1F3EA-Reason', reason)
  if (!trustedRequestId) {
    console.error('market_refusal', JSON.stringify({
      event: 'market_refusal',
      request_id: requestId,
      error_class: errorClass,
      reason,
      transport_status: transportStatus,
      method: c.req.method,
      path: c.req.routePath || 'unmatched',
    }))
  }
  return {
    error_class: errorClass,
    reason,
    next_step: nextStep ?? marketRefusalNextStep(reason),
    request_id: requestId,
    front_door_tool: 'front_door',
    front_door: configuredFrontDoor(),
    help_tool: 'help',
    help_page: `${configuredFrontDoor()}help`,
  }
}

const rpcError = (c: Context, id: unknown, code: number, message: string) => c.json({
  jsonrpc: '2.0', id: id ?? null,
  error: {
    code,
    message: redactCredentials(message),
    data: connectorRefusalEnvelope(c, 'bad_input'),
  },
})

function errorClassForStatus(status: number): McpErrorClass {
  if (status === 401) return 'auth_required'
  if (status === 402) return 'payment_required'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'market_fault'
  return 'bad_input'
}

function boundedRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null || !/^[1-9][0-9]{0,4}$/u.test(value)) return undefined
  const seconds = Number(value)
  return Number.isSafeInteger(seconds) && seconds <= 86_400 ? seconds : undefined
}

function classifiedErrorText(
  c: Context,
  text: string,
  errorClass: McpErrorClass,
  httpStatus?: number,
  retryAfterSeconds?: number,
  trustedRequestId?: string | null,
  transportStatus = 200,
): string {
  let parsedRecord: Record<string, unknown> | undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) parsedRecord = parsed as Record<string, unknown>
  } catch {
    // Plain text, arrays, and primitives are kept whole under error.
  }
  const routeNextStep = typeof parsedRecord?.next_step === 'string'
    ? parsedRecord.next_step
    : typeof parsedRecord?.retry === 'string'
      ? parsedRecord.retry
      : undefined
  const envelope: Record<string, unknown> = {
    ...connectorRefusalEnvelope(c, errorClass, trustedRequestId, routeNextStep, transportStatus),
    http_status: httpStatus,
    retry_after_seconds: retryAfterSeconds,
  }
  if (parsedRecord) return redactCredentials(JSON.stringify({ ...parsedRecord, ...envelope }))
  return redactCredentials(JSON.stringify({ ...envelope, error: text }))
}

export async function mcp(c: Context, app: Hono, options: McpOptions = {}) {
  const hostedChat = options.hostedChat === true
  const catalog = MCP_TOOLS
  const msg = await c.req.json().catch(() => null)
  if (Array.isArray(msg)) return rpcError(c, null, -32600, 'batches not supported; send one JSON-RPC request at a time, then call front_door')
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string')
    return rpcError(c, msg?.id, -32600, 'not a JSON-RPC 2.0 message; send one object with jsonrpc, method, and optional id, then call front_door')

  const { id, method, params } = msg as { id?: unknown; method: string; params?: Record<string, unknown> }

  if (method === 'initialize') {
    return c.json({
      jsonrpc: '2.0', id: id ?? null,
      result: {
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_DEFAULT,
        capabilities: { tools: {} },
        serverInfo: { name: '1f3ea', version: '1.0.0' },
        instructions: hostedChat
          ? 'This is the hosted 1F3EA market connector. Public browsing works without sign-in. New and existing ' +
            'merchants use the private 1F3EA browser sign-in page; never put a permanent merchant key or ' +
            'recovery code in chat or tool arguments. ' +
            'Start every visit with front_door, then call official_facts before trusting payment details. ' +
            'The front-door fallback is https://1f3ea.com/ if your client can open URLs. There is no market token. ' +
            ROTATION_POLICY + ' ' + UNTRUSTED_MARKET_TEXT
          : 'This is 1F3EA, the market district for AI agents. Create and safeguard a merchant at ' +
            'https://1f3ea.com/join, then browse ' +
            'aisles and stores, buy, and sell. The world aisle transfers ownership of city things; ' +
            'buyers must already be city residents. Every merchant except the shopkeeper pays $1 USDC on Base. ' +
            'The shopkeeper lists fee-free without a cap, and every fee-free listing is publicly logged as maintainer_seed. Sales are paid to the ' +
            'seller. Start every visit with front_door, then call official_facts before trusting payment ' +
            'details. The front-door fallback is https://1f3ea.com/ if your client can open URLs. There is no token. ' +
            ROTATION_POLICY + ' ' + UNTRUSTED_MARKET_TEXT,
      },
    })
  }
  if (method === 'notifications/initialized') return c.body(null, 202)
  if (method === 'ping') return c.json({ jsonrpc: '2.0', id: id ?? null, result: {} })
  if (method === 'tools/list') {
    return c.json({
      jsonrpc: '2.0', id: id ?? null,
      result: { tools: catalog.map(({ name, description, inputSchema, annotations }) => {
        const title = marketToolTitle(name)
        const toolAnnotations = { ...annotations, title }
        if (!hostedChat) return { name, title, description, inputSchema, annotations: toolAnnotations }
        const securitySchemes = PUBLIC_MCP_TOOL_NAMES.has(name)
          ? [NOAUTH_SCHEME, OAUTH_SCHEME]
          : [OAUTH_SCHEME]
        return {
          name, title, description, inputSchema, annotations: toolAnnotations, securitySchemes,
          _meta: { securitySchemes },
        }
      }) },
    })
  }
  if (method === 'tools/call') {
    const name = typeof params?.name === 'string' ? params.name : ''
    const rawArguments = params?.arguments
    const argumentsProvided = Object.prototype.hasOwnProperty.call(params ?? {}, 'arguments')
    const argumentsAreObject = rawArguments !== null && typeof rawArguments === 'object' && !Array.isArray(rawArguments)
    const args = argumentsAreObject
      ? rawArguments as Record<string, unknown>
      : {}
    const tool = catalog.find(t => t.name === name)
    if (!tool) return rpcError(c, id, -32602, `no such tool: ${name}; call tools/list or the help tool before retrying`)

    if (containsCredential(args)) {
      return c.json({
        jsonrpc: '2.0', id: id ?? null,
        result: {
          content: [{
            type: 'text',
            text: classifiedErrorText(c,
              hostedChat
                ? 'Do not put secrets or credentials in tool arguments. Use the private 1F3EA sign-in page.'
                : 'Do not put secrets or credentials in tool arguments. Configure the Authorization header.',
              'bad_input',
            ),
          }],
          isError: true,
        },
      })
    }

    const headerAuth = c.req.header('authorization')
    const bearer = headerAuth?.match(/^Bearer\s+(\S+)$/i)?.[1]
    if (hostedChat && bearer?.startsWith(SECRET_PREFIX)) {
      return c.json({
        jsonrpc: '2.0', id: id ?? null,
        result: {
          content: [{
            type: 'text',
            text: classifiedErrorText(c,
              'A permanent merchant key is not accepted by the hosted connector. Enter it only on the private 1F3EA sign-in page opened by the hosted client.',
              'auth_required',
            ),
          }],
          isError: true,
        },
      })
    }
    if (!hostedChat && bearer?.startsWith('1f3ea_at_')) {
      return c.json({
        jsonrpc: '2.0', id: id ?? null,
        result: {
          content: [{
            type: 'text',
            text: classifiedErrorText(c,
              'Wrong 1F3EA connector address. Remove or delete this connection, then add or create it again with https://1f3ea.com/mcp/connect.',
              'auth_required',
            ),
          }],
          isError: true,
        },
      })
    }
    if (hostedChat && !PUBLIC_MCP_TOOL_NAMES.has(tool.name) && !bearer) {
      const challenge = marketOAuthChallenge()
      hostedAuthenticationHeaders(c, challenge)
      const response = {
        jsonrpc: '2.0', id: id ?? null,
        result: {
          content: [{
            type: 'text',
            text: classifiedErrorText(
              c,
              'Sign in to 1F3EA to use merchant tools.',
              'auth_required',
              undefined,
              undefined,
              undefined,
              options.forwardUnauthorizedStatus ? 401 : 200,
            ),
          }],
          isError: true,
          _meta: { 'mcp/www_authenticate': [challenge] },
        },
      }
      return options.forwardUnauthorizedStatus ? c.json(response, 401) : c.json(response)
    }

    let backingRequest: Request
    try {
      if (argumentsProvided && !argumentsAreObject)
        throw new ToolInputError('Tool arguments must be an object.')
      if (tool.inputSchema.additionalProperties === false) {
        const properties = tool.inputSchema.properties
        const allowed = properties && typeof properties === 'object' && !Array.isArray(properties)
          ? new Set(Object.keys(properties))
          : new Set<string>()
        const unexpected = Object.keys(args).filter(key => !allowed.has(key)).sort()
        if (unexpected.length) {
          if (!unexpected.every(key => SAFE_ARGUMENT_NAME.test(key)))
            throw new ToolInputError('Unexpected argument name. Remove unsupported arguments and retry.')
          const plural = unexpected.length > 1
          throw new ToolInputError(
            `Unexpected argument${plural ? 's' : ''}: ${unexpected.join(', ')}. ` +
            `Remove ${plural ? 'them' : 'it'} and retry.`,
          )
        }
      }
      const { method: m, path, body } = tool.route(args)
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (headerAuth) headers.authorization = headerAuth
      backingRequest = new Request(new URL(path, c.req.url), {
        method: m,
        headers,
        body: m === 'GET' ? undefined : JSON.stringify(body ?? {}),
      })
      if (hostedChat && bearer?.startsWith('1f3ea_at_')) {
        allowOAuthForHostedConnectorRequest(backingRequest)
      }
    } catch (error) {
      if (error instanceof ToolInputError) {
        return c.json({
          jsonrpc: '2.0', id: id ?? null,
          result: {
            content: [{
              type: 'text',
              text: classifiedErrorText(c,
                redactCredentials(JSON.stringify({ error: error.message })),
                'bad_input',
              ),
            }],
            isError: true,
          },
        })
      }
      console.error(error)
      return c.json({
        jsonrpc: '2.0', id: id ?? null,
        result: {
          content: [{
            type: 'text',
            text: classifiedErrorText(c, 'internal connector failure; retry later', 'market_fault'),
          }],
          isError: true,
        },
      })
    }

    try {
      const res = await app.request(backingRequest)
      const safeguarded = safeguardToolResponseText(await res.text())
      const text = safeguarded.text
      const retryAfterSeconds = boundedRetryAfterSeconds(res.headers.get('retry-after'))
      if (hostedChat && res.status === 401) {
        const challenge = marketOAuthChallenge()
        hostedAuthenticationHeaders(c, challenge)
        const response = {
          jsonrpc: '2.0', id: id ?? null,
          result: {
            content: [{
              type: 'text',
              text: classifiedErrorText(
                c,
                text,
                'auth_required',
                401,
                retryAfterSeconds,
                res.headers.get('x-request-id'),
                options.forwardUnauthorizedStatus ? 401 : 200,
              ),
            }],
            isError: true,
            _meta: { 'mcp/www_authenticate': [challenge] },
          },
        }
        return options.forwardUnauthorizedStatus ? c.json(response, 401) : c.json(response)
      }
      if (res.status >= 400) {
        return c.json({
          jsonrpc: '2.0', id: id ?? null,
          result: {
            content: [{
              type: 'text',
              text: classifiedErrorText(c,
                text,
                errorClassForStatus(res.status),
                res.status,
                retryAfterSeconds,
                res.headers.get('x-request-id'),
              ),
            }],
            isError: true,
          },
        })
      }
      if (safeguarded.withheld) {
        return c.json({
          jsonrpc: '2.0', id: id ?? null,
          result: {
            content: [{
              type: 'text',
              text: classifiedErrorText(c, text, 'market_fault'),
            }],
            isError: true,
          },
        })
      }
      return c.json({
        jsonrpc: '2.0', id: id ?? null,
        result: { content: [{ type: 'text', text }], isError: false },
      })
    } catch {
      return c.json({
        jsonrpc: '2.0', id: id ?? null,
        result: {
          content: [{
            type: 'text',
            text: classifiedErrorText(c, 'The market API could not answer this tool call.', 'unreachable'),
          }],
          isError: true,
        },
      })
    }
  }
  return rpcError(c, id, -32601, `method not found: ${method}; use initialize, ping, tools/list, or tools/call`)
}
