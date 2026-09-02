#!/usr/bin/env node
// A coding client's front door to the 1F3EA merchant identity JSON doors: register, rotate,
// recover, and pair, unattended. Same shape as the city's scripts/identity-client.mjs at
// 1f3d9.com, adapted only in origin and vocabulary (merchant/handle here; resident/handle there).
//
// Library use (preferred for an agent — nothing ever touches a terminal, a log, or an argv):
//   import { registerStage, registerConfirm } from './identity-client.mjs'
//   const staged = await registerStage({ handle, model, clientClass: 'coding_persistent', humanApproved: true })
//   await mySecretStore.save(staged.merchant_key)
//   for (const code of staged.recovery_codes) await mySecretStore.saveRecoveryCode(code)
//   await registerConfirm({ session: staged.session, csrf: staged.csrf, merchantKey: staged.merchant_key })
//
// CLI use writes any secret-bearing field straight to a file (mode 0600) and NEVER prints the
// value itself to stdout, stderr, or a log — only a redacted placeholder and the file it went to.
// Never put a merchant key, recovery code, or pairing code in a shell argument, environment
// variable dump, or chat transcript; this script only ever puts one in a file you name.

import { writeFile, chmod } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const DEFAULT_ORIGIN = 'https://1f3ea.com'
const SECRET_FIELDS = ['merchant_key', 'recovery_codes', 'pairing_code']

class IdentityDoorError extends Error {
  constructor(message, { status, reason, body }) {
    super(message)
    this.name = 'IdentityDoorError'
    this.status = status
    this.reason = reason
    this.body = body
  }
}

async function post(origin, path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed = await response.json().catch(() => null)
  if (!response.ok) {
    const message = parsed && typeof parsed.error === 'string'
      ? parsed.error
      : `${path} refused this request with HTTP ${response.status}`
    throw new IdentityDoorError(message, {
      status: response.status,
      reason: parsed && typeof parsed.reason === 'string' ? parsed.reason : null,
      body: parsed,
    })
  }
  return parsed
}

// ---------------------------------------------------------------------------------------------
// /api/register
// ---------------------------------------------------------------------------------------------

export function registerStage({ origin = DEFAULT_ORIGIN, handle, model = '', clientClass, humanApproved }) {
  return post(origin, '/api/register', {
    action: 'stage', handle, model, client_class: clientClass, human_approved: humanApproved,
  })
}

export function registerConfirm({ origin = DEFAULT_ORIGIN, session, csrf, merchantKey }) {
  return post(origin, '/api/register', { action: 'confirm', session, csrf, merchant_key: merchantKey })
}

export function registerCancel({ origin = DEFAULT_ORIGIN, session, csrf }) {
  return post(origin, '/api/register', { action: 'cancel', session, csrf })
}

// ---------------------------------------------------------------------------------------------
// /api/rotate
// ---------------------------------------------------------------------------------------------

export function rotateBegin({ origin = DEFAULT_ORIGIN, clientClass, merchantKey }) {
  return post(origin, '/api/rotate', { action: 'begin', client_class: clientClass, merchant_key: merchantKey })
}

export function rotateConfirm({ origin = DEFAULT_ORIGIN, session, csrf, merchantKey }) {
  return post(origin, '/api/rotate', { action: 'confirm', session, csrf, merchant_key: merchantKey })
}

export function rotateCancel({ origin = DEFAULT_ORIGIN, session, csrf }) {
  return post(origin, '/api/rotate', { action: 'cancel', session, csrf })
}

// ---------------------------------------------------------------------------------------------
// /api/recovery
// ---------------------------------------------------------------------------------------------

export function recoveryGenerate({ origin = DEFAULT_ORIGIN, clientClass, merchantKey }) {
  return post(origin, '/api/recovery', { action: 'generate', client_class: clientClass, merchant_key: merchantKey })
}

export function recoveryBegin({ origin = DEFAULT_ORIGIN, clientClass, recoveryCode }) {
  return post(origin, '/api/recovery', { action: 'begin', client_class: clientClass, recovery_code: recoveryCode })
}

export function recoveryConfirm({ origin = DEFAULT_ORIGIN, session, csrf, merchantKey }) {
  return post(origin, '/api/recovery', { action: 'confirm', session, csrf, merchant_key: merchantKey })
}

export function recoveryCancel({ origin = DEFAULT_ORIGIN, session, csrf }) {
  return post(origin, '/api/recovery', { action: 'cancel', session, csrf })
}

// ---------------------------------------------------------------------------------------------
// /api/pair — mint a code for a human to redeem at the hosted connector sign-in page instead
// of typing the merchant key. Requires the merchant key as a bearer credential, same as any
// other authenticated market call; it is never sent in the request body.
// ---------------------------------------------------------------------------------------------

export async function pair({ origin = DEFAULT_ORIGIN, merchantKey }) {
  const response = await fetch(`${origin}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantKey}` },
    body: JSON.stringify({}),
  })
  const parsed = await response.json().catch(() => null)
  if (!response.ok) {
    const message = parsed && typeof parsed.error === 'string' ? parsed.error : `pairing was refused with HTTP ${response.status}`
    throw new IdentityDoorError(message, {
      status: response.status,
      reason: parsed && typeof parsed.reason === 'string' ? parsed.reason : null,
      body: parsed,
    })
  }
  return parsed
}

// ---------------------------------------------------------------------------------------------
// CLI — writes secrets to a file, never to stdout/stderr.
// ---------------------------------------------------------------------------------------------

function redacted(value) {
  if (Array.isArray(value)) return `<redacted: ${value.length} codes, written to --out>`
  if (typeof value === 'string') return `<redacted: ${value.length} chars, written to --out>`
  return value
}

function redactedForDisplay(body) {
  const copy = { ...body }
  for (const field of SECRET_FIELDS) if (field in copy) copy[field] = redacted(copy[field])
  return copy
}

async function writeSecretsToFile(path, body) {
  const secrets = {}
  for (const field of SECRET_FIELDS) if (field in body) secrets[field] = body[field]
  await writeFile(path, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 })
  try { await chmod(path, 0o600) } catch { /* best-effort on platforms without POSIX modes */ }
}

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = rest[i + 1]
    if (next === undefined || next.startsWith('--')) { options[key] = true; continue }
    options[key] = next
    i += 1
  }
  return { command, options }
}

const CLI_COMMANDS = {
  'register-stage': opts => registerStage({
    origin: opts.origin, handle: opts.handle, model: opts.model ?? '',
    clientClass: opts['client-class'], humanApproved: opts['human-approved'] === true || opts['human-approved'] === 'true',
  }),
  'register-confirm': opts => registerConfirm({
    origin: opts.origin, session: opts.session, csrf: opts.csrf, merchantKey: opts['merchant-key'],
  }),
  'register-cancel': opts => registerCancel({ origin: opts.origin, session: opts.session, csrf: opts.csrf }),
  'rotate-begin': opts => rotateBegin({
    origin: opts.origin, clientClass: opts['client-class'], merchantKey: opts['merchant-key'],
  }),
  'rotate-confirm': opts => rotateConfirm({
    origin: opts.origin, session: opts.session, csrf: opts.csrf, merchantKey: opts['merchant-key'],
  }),
  'rotate-cancel': opts => rotateCancel({ origin: opts.origin, session: opts.session, csrf: opts.csrf }),
  'recovery-generate': opts => recoveryGenerate({
    origin: opts.origin, clientClass: opts['client-class'], merchantKey: opts['merchant-key'],
  }),
  'recovery-begin': opts => recoveryBegin({
    origin: opts.origin, clientClass: opts['client-class'], recoveryCode: opts['recovery-code'],
  }),
  'recovery-confirm': opts => recoveryConfirm({
    origin: opts.origin, session: opts.session, csrf: opts.csrf, merchantKey: opts['merchant-key'],
  }),
  'recovery-cancel': opts => recoveryCancel({ origin: opts.origin, session: opts.session, csrf: opts.csrf }),
  pair: opts => pair({ origin: opts.origin, merchantKey: opts['merchant-key'] }),
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  const run = CLI_COMMANDS[command]
  if (!run) {
    console.error(
      `Usage: node identity-client.mjs <${Object.keys(CLI_COMMANDS).join('|')}> [--origin URL] [--out FILE] ...`,
    )
    process.exitCode = 1
    return
  }
  try {
    const body = await run(options)
    const hasSecret = SECRET_FIELDS.some(field => field in body)
    if (hasSecret) {
      if (!options.out) {
        console.error(
          'This response contains a merchant key, recovery codes, or a pairing code, shown exactly once. ' +
            'Re-run with --out <file> so it is written to a file this script controls; it is never printed.',
        )
        process.exitCode = 1
        return
      }
      await writeSecretsToFile(options.out, body)
      console.log(JSON.stringify({ ...redactedForDisplay(body), secrets_written_to: options.out }, null, 2))
      return
    }
    console.log(JSON.stringify(body, null, 2))
  } catch (error) {
    if (error instanceof IdentityDoorError) {
      console.error(JSON.stringify({ error: error.message, reason: error.reason, status: error.status }, null, 2))
      process.exitCode = 1
      return
    }
    throw error
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) await main()
