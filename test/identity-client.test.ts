// scripts/identity-client.mjs's CLI layer, exercised as a real subprocess: bare secret flags
// must be refused before any network call, and --*-file / stdin must be the only way in. The
// exported library functions (registerStage, pair, ...) are not covered here — they take a
// value directly by design, per the file's own docstring, and are exercised by whatever calls
// them as a library.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

test('--merchant-key-file reads the credential from a file and never echoes it', async () => {
  await withTempDir(async dir => {
    await withCapturingServer(async (origin, requests) => {
      const keyPath = join(dir, 'merchant.key')
      const outPath = join(dir, 'pair-result.json')
      await writeFile(keyPath, '1f3ea_sk_fromfile\n')
      const result = await run(['pair', '--origin', origin, '--merchant-key-file', keyPath, '--out', outPath])
      assert.equal(result.status, 0, result.stderr)
      assert.doesNotMatch(result.stdout + result.stderr, /1f3ea_sk_fromfile/u)
      const [request] = requests()
      assert.ok(request)
      assert.equal(request!.headers.authorization, 'Bearer 1f3ea_sk_fromfile')
    })
  })
})

test('--merchant-key-file - reads the credential from stdin', async () => {
  await withTempDir(async dir => {
    await withCapturingServer(async (origin, requests) => {
      const outPath = join(dir, 'pair-result.json')
      const result = await run(['pair', '--origin', origin, '--merchant-key-file', '-', '--out', outPath], {
        input: '1f3ea_sk_fromstdin\n',
      })
      assert.equal(result.status, 0, result.stderr)
      assert.doesNotMatch(result.stdout + result.stderr, /1f3ea_sk_fromstdin/u)
      const [request] = requests()
      assert.ok(request)
      assert.equal(request!.headers.authorization, 'Bearer 1f3ea_sk_fromstdin')
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

