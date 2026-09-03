// scripts/identity-client.mjs's CLI layer, exercised as a real subprocess: bare secret flags
// must be refused before any network call, and --*-file / stdin must be the only way in. The
// exported library functions (registerStage, pair, ...) are not covered here — they take a
// value directly by design, per the file's own docstring, and are exercised by whatever calls
// them as a library.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/identity-client.mjs', import.meta.url))

type RunResult = { status: number | null; stdout: string; stderr: string }

function run(args: readonly string[], options: { input?: string } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', status => resolve({ status, stdout, stderr }))
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

async function withTempDir<T>(operation: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'identity-client-test-'))
  try {
    return await operation(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function withCapturingServer<T>(
  operation: (origin: string, requests: () => readonly { headers: IncomingMessage['headers']; body: string }[]) => Promise<T>,
): Promise<T> {
  const seen: { headers: IncomingMessage['headers']; body: string }[] = []
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      seen.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'created', pairing_code: 'ignored', expires_in_seconds: 600, one_use: true, instructions: '' }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind a port')
  try {
    return await operation(`http://127.0.0.1:${address.port}`, () => seen)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

async function withRespondingServer<T>(
  responseBody: Record<string, unknown>,
  operation: (origin: string) => Promise<T>,
): Promise<T> {
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(responseBody))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind a port')
  try {
    return await operation(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

test('a bare --merchant-key is refused before any network call', async () => {
  const result = await run(['rotate-begin', '--client-class', 'coding_persistent', '--merchant-key', '1f3ea_sk_leaked'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /--merchant-key is refused as a bare flag/iu)
  assert.match(result.stderr, /--merchant-key-file/u)
  assert.doesNotMatch(result.stdout + result.stderr, /1f3ea_sk_leaked/u)
})

test('a bare --session or --csrf is refused the same way', async () => {
  for (const flag of ['session', 'csrf']) {
    const result = await run(['rotate-cancel', `--${flag}`, 'leaked-value'])
    assert.notEqual(result.status, 0, flag)
    assert.match(result.stderr, new RegExp(`--${flag} is refused as a bare flag`, 'iu'), flag)
  }
})

test('a bare --recovery-code is refused the same way', async () => {
  const result = await run(['recovery-begin', '--client-class', 'coding_ephemeral', '--recovery-code', `1f3ea_rc_${'a'.repeat(64)}`])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /--recovery-code is refused as a bare flag/iu)
  assert.match(result.stderr, /--recovery-code-file/u)
})

// Real-shaped fake credentials: 1f3ea_sk_ plus 48 lowercase hex characters, matching
// MERCHANT_KEY_RE in src/market-identity-fields.ts. These are what the shape validation in
// resolveSecretFields (identity-client.mjs) requires before it will use a value at all.
const FROM_FILE_KEY = `1f3ea_sk_${'a'.repeat(48)}`
const FROM_STDIN_KEY = `1f3ea_sk_${'b'.repeat(48)}`

test('--merchant-key-file reads the credential from a file and never echoes it', async () => {
  await withTempDir(async dir => {
    await withCapturingServer(async (origin, requests) => {
      const keyPath = join(dir, 'merchant.key')
      const outPath = join(dir, 'pair-result.json')
      await writeFile(keyPath, `${FROM_FILE_KEY}\n`)
      const result = await run(['pair', '--origin', origin, '--merchant-key-file', keyPath, '--out', outPath])
      assert.equal(result.status, 0, result.stderr)
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(FROM_FILE_KEY, 'u'))
      const [request] = requests()
      assert.ok(request)
      assert.equal(request!.headers.authorization, `Bearer ${FROM_FILE_KEY}`)
    })
  })
})

test('--merchant-key-file - reads the credential from stdin', async () => {
  await withTempDir(async dir => {
    await withCapturingServer(async (origin, requests) => {
      const outPath = join(dir, 'pair-result.json')
      const result = await run(['pair', '--origin', origin, '--merchant-key-file', '-', '--out', outPath], {
        input: `${FROM_STDIN_KEY}\n`,
      })
      assert.equal(result.status, 0, result.stderr)
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(FROM_STDIN_KEY, 'u'))
      const [request] = requests()
      assert.ok(request)
      assert.equal(request!.headers.authorization, `Bearer ${FROM_STDIN_KEY}`)
    })
  })
})

test('an empty secret file is refused with a clear error, not silently sent empty', async () => {
  await withTempDir(async dir => {
    const emptyPath = join(dir, 'empty.key')
    await writeFile(emptyPath, '   \n')
    const result = await run(['rotate-begin', '--client-class', 'coding_persistent', '--merchant-key-file', emptyPath])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /no value read from/iu)
  })
})

test('a --merchant-key-file whose content is not shaped like a merchant key is refused before any network call, with no raw value echoed', async () => {
  await withTempDir(async dir => {
    const wrongShapePath = join(dir, 'not-a-key.txt')
    const wrongShapeValue = 'this-is-not-a-merchant-key'
    await writeFile(wrongShapePath, `${wrongShapeValue}\n`)
    const result = await run(['rotate-begin', '--client-class', 'coding_persistent', '--merchant-key-file', wrongShapePath])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /does not have the shape a --merchant-key value must have/iu)
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(wrongShapeValue, 'u'))
  })
})

// This is the exact failure this test guards against: pointing --merchant-key-file at the
// multi-field JSON file this script's own --out just wrote for an earlier command (rotate-begin
// here, which — like register-stage — returns a real merchant_key alongside session/csrf).
// Before shape validation existed, the whole pretty-printed JSON blob (including the real key
// inside it) was read as a single value, sent as a malformed Authorization header, and the
// resulting fetch() TypeError was re-thrown uncaught — printing the merchant key to stderr.
// Shape validation must refuse this file outright, before any network call, and the catch-all
// in main() must never echo a header or body value even if something else slips past it.
test('the JSON file --out writes for one command is refused as --merchant-key-file for another, and the real key inside it is never printed', async () => {
  await withTempDir(async dir => {
    const realMerchantKey = `1f3ea_sk_${'f'.repeat(48)}`
    await withRespondingServer(
      {
        status: 'staged', handle: 'existing-store', client_class: 'coding_persistent',
        session: 'a'.repeat(64), csrf: 'b'.repeat(64), expires_in_seconds: 900,
        merchant_key: realMerchantKey, instructions: 'save the replacement',
      },
      async origin => {
        const firstOutPath = join(dir, 'rotate-result.json')
        const staged = await run([
          'rotate-begin', '--origin', origin, '--client-class', 'coding_persistent',
          '--merchant-key-file', '-', '--out', firstOutPath,
        ], { input: `${FROM_FILE_KEY}\n` })
        assert.equal(staged.status, 0, staged.stderr)
        // Sanity check on the test itself: the file really does hold the real key, unredacted,
        // so the assertions below are meaningful.
        assert.match(await readFile(firstOutPath, 'utf8'), new RegExp(realMerchantKey, 'u'))

        const result = await run(['pair', '--origin', origin, '--merchant-key-file', firstOutPath, '--out', join(dir, 'pair-result.json')])
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /does not have the shape a --merchant-key value must have/iu)
        assert.doesNotMatch(result.stdout + result.stderr, new RegExp(realMerchantKey, 'u'))
        assert.doesNotMatch(result.stdout + result.stderr, /1f3ea_sk_[0-9a-f]{48}/iu)
      },
    )
  })
})

// session and csrf are refused as bare argv flags going in (see the "bare --session or --csrf"
// test above) precisely because each authenticates the matching confirm/cancel call. A stage
// or begin response hands both of them back, so they must get the same protection coming out:
// written to --out, never printed in the console summary.
test('register-stage writes session, csrf, merchant_key, and recovery_codes to --out and redacts all four in the printed summary', async () => {
  await withTempDir(async dir => {
    const session = 'c'.repeat(64)
    const csrf = 'd'.repeat(64)
    const merchantKey = `1f3ea_sk_${'e'.repeat(48)}`
    const recoveryCodes = Array.from({ length: 8 }, (_, i) => `1f3ea_rc_${String(i).repeat(64)}`.slice(0, 73))
    await withRespondingServer(
      {
        status: 'staged', handle: 'new-store', client_class: 'coding_persistent',
        session, csrf, expires_in_seconds: 900, merchant_key: merchantKey, recovery_codes: recoveryCodes,
        instructions: 'save everything',
      },
      async origin => {
        const outPath = join(dir, 'register-result.json')
        const result = await run([
          'register-stage', '--origin', origin, '--handle', 'new-store', '--model', 'claude',
          '--client-class', 'coding_persistent', '--human-approved', 'true', '--out', outPath,
        ])
        assert.equal(result.status, 0, result.stderr)
        for (const secret of [session, csrf, merchantKey, ...recoveryCodes]) {
          assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret, 'u'))
        }
        const printed = JSON.parse(result.stdout) as Record<string, unknown>
        assert.equal(printed.session, '<redacted: 64 chars, written to --out>')
        assert.equal(printed.csrf, '<redacted: 64 chars, written to --out>')
        assert.equal(printed.merchant_key, `<redacted: ${merchantKey.length} chars, written to --out>`)
        assert.equal(printed.recovery_codes, '<redacted: 8 codes, written to --out>')
        assert.equal(printed.secrets_written_to, outPath)

        const written = JSON.parse(await readFile(outPath, 'utf8')) as Record<string, unknown>
        assert.equal(written.session, session)
        assert.equal(written.csrf, csrf)
        assert.equal(written.merchant_key, merchantKey)
        assert.deepEqual(written.recovery_codes, recoveryCodes)
      },
    )
  })
})

test('register-stage without --out refuses to print session and csrf to the console', async () => {
  await withTempDir(async () => {
    await withRespondingServer(
      {
        status: 'staged', handle: 'new-store', client_class: 'coding_persistent',
        session: 'c'.repeat(64), csrf: 'd'.repeat(64), expires_in_seconds: 900,
        merchant_key: `1f3ea_sk_${'e'.repeat(48)}`, recovery_codes: [],
        instructions: 'save everything',
      },
      async origin => {
        const result = await run([
          'register-stage', '--origin', origin, '--handle', 'new-store', '--model', 'claude',
          '--client-class', 'coding_persistent', '--human-approved', 'true',
        ])
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /re-run with --out/iu)
        assert.doesNotMatch(result.stdout + result.stderr, /c{64}|d{64}/u)
      },
    )
  })
})

// The bug this guards against: --out was previously checked only after the door call
// succeeded, so a recovery-generate (which activates a fresh eight-code set immediately, with
// no confirm/cancel step) with an unwritable --out would throw away a set the server had
// already made active. --out must now be required and probed for a secret-revealing command
// BEFORE the network call, so a bad path costs nothing.
test('a secret-revealing command with no --out is refused before any network call', async () => {
  await withCapturingServer(async (origin, requests) => {
    const result = await run(['pair', '--origin', origin, '--merchant-key-file', '-'], {
      input: `${`1f3ea_sk_${'a'.repeat(48)}`}\n`,
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /can return a merchant key, recovery codes, or a pairing code/iu)
    assert.match(result.stderr, /checked before the request is sent/iu)
    assert.equal(requests().length, 0)
  })
})

test('a secret-revealing command with an --out path that cannot be opened for writing is refused before any network call', async () => {
  await withTempDir(async dir => {
    await withCapturingServer(async (origin, requests) => {
      const unwritableOutPath = join(dir, 'no-such-subdir', 'out.json')
      const result = await run([
        'pair', '--origin', origin, '--merchant-key-file', '-', '--out', unwritableOutPath,
      ], { input: `${`1f3ea_sk_${'a'.repeat(48)}`}\n` })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /could not be opened for writing/iu)
      assert.match(result.stderr, /checked before the request is sent/iu)
      assert.equal(requests().length, 0)
    })
  })
})

// The bug this guards against: the --out pre-flight probe used to open the file with the
// platform default mode (no `mode` argument), so on a fresh path it created the file
// world-readable and only tightened it to 0600 after the real write finished — leaving a
// staged-or-active credential briefly world-readable on disk. The probe must create the file at
// 0600 from the very first open, and the file must stay at 0600 through the real write that
// follows. Mode bits do not exist on Windows, so this assertion only makes sense on POSIX.
test('--out is created at mode 0600 by the pre-flight probe and stays 0600 after the real write', async () => {
  if (process.platform === 'win32') return
  await withTempDir(async dir => {
    await withRespondingServer(
      {
        status: 'created', pairing_code: `1f3ea_rc_${'a'.repeat(64)}`, expires_in_seconds: 600,
        one_use: true, instructions: '',
      },
      async origin => {
        const outPath = join(dir, 'pair-result.json')
        const result = await run([
          'pair', '--origin', origin, '--merchant-key-file', '-', '--out', outPath,
        ], { input: `${`1f3ea_sk_${'a'.repeat(48)}`}\n` })
        assert.equal(result.status, 0, result.stderr)
        const info = await stat(outPath)
        assert.equal(info.mode & 0o777, 0o600)
      },
    )
  })
})

// A command that does NOT reveal a secret (rotate-cancel's response is just {"status":...}, no
// key or code) must not be forced to pass --out at all — the pre-flight check is scoped to
// SECRET_REVEALING_COMMANDS, not every command.
test('a non-secret-revealing command needs no --out and is not refused by the pre-flight check', async () => {
  await withTempDir(async dir => {
    const sessionPath = join(dir, 'session')
    const csrfPath = join(dir, 'csrf')
    await writeFile(sessionPath, `${'a'.repeat(64)}\n`)
    await writeFile(csrfPath, `${'b'.repeat(64)}\n`)
    await withRespondingServer({ status: 'canceled' }, async origin => {
      const result = await run([
        'rotate-cancel', '--origin', origin, '--session-file', sessionPath, '--csrf-file', csrfPath,
      ])
      assert.equal(result.status, 0, result.stderr)
      assert.doesNotMatch(result.stderr, /--out/u)
      assert.deepEqual(JSON.parse(result.stdout), { status: 'canceled' })
    })
  })
})

