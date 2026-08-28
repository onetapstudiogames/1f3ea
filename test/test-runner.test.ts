import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import {
  buildCoverageRunnerArguments,
  buildNodeTestArguments,
  buildTestEnvironment,
  parseTestRunnerArguments,
  withIsolatedTestEnvironment,
} from '../scripts/run-tests.ts'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> }

test('package test commands use the isolated runner without widening unit coverage', () => {
  assert.equal(
    packageJson.scripts.test,
    'node --experimental-strip-types scripts/run-tests.ts',
  )
  assert.equal(
    packageJson.scripts['test:coverage'],
    'node --experimental-strip-types scripts/run-tests.ts --coverage',
  )
  assert.equal(
    packageJson.scripts['test:postgres'],
    'node --test --test-concurrency=1 --experimental-strip-types ' +
      '--experimental-test-module-mocks test/integration/*.test.ts',
  )
})

test('test runner accepts only the optional coverage mode', () => {
  assert.equal(parseTestRunnerArguments([]), false)
  assert.equal(parseTestRunnerArguments(['--coverage']), true)
  assert.throws(
    () => parseTestRunnerArguments(['--watch']),
    /Usage: npm (?:test|run test:coverage)/,
  )
})

test('test runner keeps the existing top-level unit-test surface', () => {
  assert.deepEqual(buildNodeTestArguments(), [
    '--test',
    '--experimental-strip-types',
    '--experimental-test-module-mocks',
    'test/*.test.ts',
  ])
})

test('coverage runner preserves the existing src and api coverage surface', () => {
  const arguments_ = buildCoverageRunnerArguments('C:\\isolated-suite')
  assert.deepEqual(arguments_.slice(0, 18), [
    '--all',
    '--src', 'src',
    '--src', 'api',
    '--extension', '.ts',
    '--check-coverage',
    '--lines', '80',
    '--branches', '80',
    '--functions', '80',
    '--statements', '80',
    '--reporter', 'text',
  ])
  assert.deepEqual(arguments_.slice(-6), [
    '--',
    process.execPath,
    '--test',
    '--experimental-strip-types',
    '--experimental-test-module-mocks',
    'test/*.test.ts',
  ])
  assert.match(arguments_.join(' '), /coverage-report/)
  assert.match(arguments_.join(' '), /coverage-raw/)
})

test('isolated environment redirects temp state and prefers Git Bash on Windows', () => {
  const environment = buildTestEnvironment(
    'C:\\suite-temp',
    {
      KEEP_ME: 'yes',
      NODE_TEST_CONTEXT: 'child-v8',
      Path: 'C:\\Windows\\System32',
      TEMP: 'C:\\old-temp',
      tmp: 'C:\\old-tmp',
      TmpDir: 'C:\\old-tmpdir',
    },
    {
      platform: 'win32',
      gitBashDirectory: 'C:\\Program Files\\Git\\bin',
    },
  )

  assert.equal(environment.TEMP, 'C:\\suite-temp')
  assert.equal(environment.TMP, 'C:\\suite-temp')
  assert.equal(environment.TMPDIR, 'C:\\suite-temp')
  assert.equal(
    environment.PATH,
    `C:\\Program Files\\Git\\bin${delimiter}C:\\Windows\\System32`,
  )
  assert.equal(environment.Path, undefined)
  assert.equal(environment.NODE_TEST_CONTEXT, undefined)
  assert.equal(environment.KEEP_ME, 'yes')
})

test('suite-owned temp directory is removed after success and failure', () => {
  let successfulRoot = ''
  withIsolatedTestEnvironment(({ root }) => {
    successfulRoot = root
    mkdirSync(join(root, 'nested'))
  }, {
    baseEnvironment: {},
    platform: 'linux',
    tempParent: tmpdir(),
  })
  assert.equal(existsSync(successfulRoot), false)

  let failedRoot = ''
  assert.throws(
    () => withIsolatedTestEnvironment(({ root }) => {
      failedRoot = root
      mkdirSync(join(root, 'nested'))
      throw new Error('simulated test failure')
    }, {
      baseEnvironment: {},
      platform: 'linux',
      tempParent: tmpdir(),
    }),
    /simulated test failure/,
  )
  assert.equal(existsSync(failedRoot), false)
})
