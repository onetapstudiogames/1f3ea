import { readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const DOCS_INDEX = resolve(REPO_ROOT, 'docs/README.md')
const EXCLUDED_DIRECTORIES = new Set([
  '.git', 'coverage', 'node_modules', 'playwright-report', 'test-results',
])

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) return []
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return markdownFiles(path)
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : []
  })
}

function repoPath(path: string): string {
  return relative(REPO_ROOT, path).replaceAll('\\', '/')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

export function documentStatus(text: string): string | null {
  const match = text.slice(0, 600).match(/^> Status: (current|archived|historical \(\d{4}-\d{2}-\d{2}\))\s*$/mu)
  return match?.[1] ?? null
}

export function validateDocumentation(): string[] {
  const errors: string[] = []
  const files = markdownFiles(REPO_ROOT).sort()
  const index = readFileSync(DOCS_INDEX, 'utf8')

  for (const file of files) {
    const relativePath = repoPath(file)
    const status = documentStatus(readFileSync(file, 'utf8'))
    if (!status) {
      errors.push(`${relativePath} has no valid status line near its top`)
      continue
    }
    const indexLink = relative(dirname(DOCS_INDEX), file).replaceAll('\\', '/')
    const row = new RegExp(
      `\\[${escapeRegExp(relativePath)}\\]\\(${escapeRegExp(indexLink)}\\) — ${escapeRegExp(status)}\\b`,
      'gu',
    )
    const count = index.match(row)?.length ?? 0
    if (count !== 1) errors.push(`${relativePath} must appear exactly once with status ${status}`)
    if (status !== 'current' && !relativePath.startsWith('docs/archive/')) {
      errors.push(`${relativePath} is ${status} but is outside docs/archive`)
    }
  }

  const indexedLinks = [...index.matchAll(/\[[^\]]+\]\(([^)]+\.md)\)/gu)]
    .map(match => resolve(dirname(DOCS_INDEX), match[1]!))
  const fileSet = new Set(files)
  for (const link of indexedLinks) {
    if (!fileSet.has(link)) errors.push(`${repoPath(link)} is indexed but does not exist`)
  }
  return errors
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = validateDocumentation()
  if (errors.length > 0) {
    for (const error of errors) console.error(error)
    process.exitCode = 1
  } else {
    console.log('Documentation index is complete and statuses match.')
  }
}
