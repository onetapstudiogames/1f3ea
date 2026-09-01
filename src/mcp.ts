import type { Context, Hono } from 'hono'
import { allowOAuthForHostedConnectorRequest, SECRET_PREFIX } from './core.ts'
import { MARKET_OAUTH_SCOPE, marketOAuthChallenge } from './market-oauth-config.ts'
import {
  MCP_TOOLS,
  PUBLIC_MCP_TOOL_NAMES,
  ROTATION_POLICY,
  ToolInputError,
  UNTRUSTED_MARKET_TEXT,
} from './mcp-tool-catalog.ts'

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
const CREDENTIAL_VALUE = /1f3ea_(?:sk_[0-9a-f]{48}|(?:at|rt|ac|rc)_[0-9a-f]{64})/i
const CREDENTIAL_REDACTION = /1f3ea_(?:sk_[0-9a-f]{48}|(?:at|rt|ac|rc)_[0-9a-f]{64})/gi
const CREDENTIAL_FIELD = /^(?:secret|merchant_key|replacement_key|recovery_code|access_token|refresh_token|authorization_code|code)$/i
const SAFE_ARGUMENT_NAME = /^[a-z][a-z0-9_]{0,63}$/

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

const rpcError = (c: Context, id: unknown, code: number, message: string) =>
  c.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

export async function mcp(c: Context, app: Hono, options: McpOptions = {}) {
  const hostedChat = options.hostedChat === true
  const catalog = MCP_TOOLS
  const msg = await c.req.json().catch(() => null)
  if (Array.isArray(msg)) return rpcError(c, null, -32600, 'batches not supported')
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string')
    return rpcError(c, msg?.id, -32600, 'not a JSON-RPC 2.0 message')

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
            'buyers must already be city residents. Listing costs $1 USDC on Base; sales are paid to the ' +
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
        if (!hostedChat) return { name, description, inputSchema, annotations }
        const securitySchemes = PUBLIC_MCP_TOOL_NAMES.has(name)
          ? [NOAUTH_SCHEME, OAUTH_SCHEME]
          : [OAUTH_SCHEME]
        return {
          name, description, inputSchema, annotations, securitySchemes,
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
    if (!tool) return rpcError(c, id, -32602, `no such tool: ${name}`)

    if (containsCredential(args)) {
      return c.json({
        jsonrpc: '2.0', id: id ?? null,
        result: {
          content: [{
            type: 'text',
            text: hostedChat
              ? 'Do not put secrets or credentials in tool arguments. Use the private 1F3EA sign-in page.'
              : 'Do not put secrets or credentials in tool arguments. Configure the Authorization header.',
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
            text: 'A permanent merchant key is not accepted by the hosted connector. Enter it only on the private 1F3EA sign-in page opened by ChatGPT.',
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
            text: 'Wrong 1F3EA connector address. Remove or delete this connection, then add or create it again with https://1f3ea.com/mcp/connect.',
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
          content: [{ type: 'text', text: 'Sign in to 1F3EA to use merchant tools.' }],
          isError: true,
          _meta: { 'mcp/www_authenticate': [challenge] },
        },
      }
      return options.forwardUnauthorizedStatus ? c.json(response, 401) : c.json(response)
    }

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
      const backingRequest = new Request(new URL(path, c.req.url), {
        method: m,
        headers,
        body: m === 'GET' ? undefined : JSON.stringify(body ?? {}),
      })
      if (hostedChat && bearer?.startsWith('1f3ea_at_')) {
        allowOAuthForHostedConnectorRequest(backingRequest)
      }
      const res = await app.request(backingRequest)
      const text = redactCredentials(await res.text())
      if (hostedChat && res.status === 401) {
        const challenge = marketOAuthChallenge()
        hostedAuthenticationHeaders(c, challenge)
        const response = {
          jsonrpc: '2.0', id: id ?? null,
          result: {
            content: [{ type: 'text', text }],
            isError: true,
            _meta: { 'mcp/www_authenticate': [challenge] },
          },
        }
        return options.forwardUnauthorizedStatus ? c.json(response, 401) : c.json(response)
      }
      return c.json({
        jsonrpc: '2.0', id: id ?? null,
        result: { content: [{ type: 'text', text }], isError: res.status >= 400 },
      })
    } catch (error) {
      if (error instanceof ToolInputError) {
        return c.json({
          jsonrpc: '2.0', id: id ?? null,
          result: {
            content: [{ type: 'text', text: redactCredentials(JSON.stringify({ error: error.message })) }],
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
            text: JSON.stringify({ error: 'internal connector failure; retry later' }),
          }],
          isError: true,
        },
      })
    }
  }
  return rpcError(c, id, -32601, `method not found: ${method}`)
}
