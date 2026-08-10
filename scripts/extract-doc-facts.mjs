#!/usr/bin/env node
// Derives the facts documentation asserts, from the code that decides them.
//
// WHY THIS EXISTS. The recurring docs failure here is not one wrong sentence,
// it is ONE FACT STATED IN SEVERAL FILES and updated in some. Connector
// targets appear in docs/03, 06, 09 and 11; on 2026-08-10 three of them had no
// mention of SCIM while six scim_* targets were live. That is one fact with
// four chances to go stale. Everything that needs such a fact reads it from
// here, so there is one place to be right.
//
// Anchored parses over regex-scraping wherever a declaration has a stable
// name: an anchor that MOVES makes this script fail loudly, whereas a loose
// regex silently yields an empty set and every check downstream passes while
// proving nothing. That failure mode is the whole reason to prefer noisy.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const uniqSorted = (xs) => [...new Set(xs)].sort()

/** Read a source file with CRLF normalised — this repo has core.autocrlf=true. */
function read(path) {
  return readFileSync(path, 'utf8').replace(/\r\n?/g, '\n')
}

/** Every file under `dir` matching `test`, recursively. */
function walk(dir, test, acc = []) {
  if (!existsSync(dir)) return acc
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, test, acc)
    else if (test(full)) acc.push(full)
  }
  return acc
}

/** Join a @Controller prefix and a method sub-path into one canonical path. */
export function joinRoute(prefix, sub) {
  const parts = [prefix, sub].filter((p) => p != null && p !== '').join('/')
  const path = '/' + parts.split('/').filter(Boolean).join('/')
  return path
}

export function extractRoutes(repoRoot) {
  const files = walk(join(repoRoot, 'apps/api/src'), (f) => f.endsWith('.controller.ts'))
  const routes = []
  for (const file of files) {
    const src = read(file)
    const prefixMatch = src.match(/@Controller\(\s*'([^']*)'\s*\)/)
    if (!prefixMatch) continue
    const prefix = prefixMatch[1]
    const re = /@(Get|Post|Patch|Put|Delete)\(\s*(?:'([^']*)')?\s*\)/g
    let m
    while ((m = re.exec(src)) !== null) {
      routes.push({ method: m[1].toUpperCase(), path: joinRoute(prefix, m[2] ?? '') })
    }
  }
  const seen = new Set()
  return routes
    .filter((r) => {
      const k = `${r.method} ${r.path}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method))
}

/**
 * Anchored on the literal declaration text. If ALL_CONNECTOR_TARGETS is ever
 * renamed this THROWS rather than returning [] — see the header. The same
 * anchoring discipline as apps/web/scripts/check-connector-targets.mjs.
 */
export function extractConnectorTargets(repoRoot) {
  const file = join(repoRoot, 'apps/api/src/connectors/connector.ts')
  const src = read(file)
  const anchor = 'export const ALL_CONNECTOR_TARGETS = ['
  const start = src.indexOf(anchor)
  if (start === -1) {
    throw new Error(
      `could not find \`${anchor}\` in apps/api/src/connectors/connector.ts.\n` +
        '  That declaration anchors scripts/extract-doc-facts.mjs. If it was renamed,\n' +
        '  update the anchor here — do not delete the extraction.',
    )
  }
  const open = start + anchor.length - 1
  const close = src.indexOf(']', open)
  if (close === -1) throw new Error('ALL_CONNECTOR_TARGETS has no closing bracket')
  const body = src.slice(open + 1, close)
  const withoutComments = body.replace(/\/\/[^\n]*/g, '')
  return uniqSorted([...withoutComments.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]))
}

export function extractCliScripts(repoRoot) {
  const pkg = JSON.parse(read(join(repoRoot, 'apps/api/package.json')))
  return uniqSorted(Object.keys(pkg.scripts ?? {}))
}

export function extractMigrations(repoRoot) {
  const dir = join(repoRoot, 'apps/api/src/db/migrations')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : []
  return { count: files.length, latest: files[files.length - 1] ?? '' }
}

/** ALL_ACTIONS and the role keys, both from authz/actions.ts. */
export function extractActionsAndRoles(repoRoot) {
  const src = read(join(repoRoot, 'apps/api/src/authz/actions.ts'))
  const anchor = 'export const ALL_ACTIONS'
  const start = src.indexOf(anchor)
  if (start === -1) throw new Error(`could not find \`${anchor}\` in apps/api/src/authz/actions.ts`)
  // Skip past the `=` before hunting for `[`: the declaration is
  // `export const ALL_ACTIONS: readonly Action[] = [...]` and the `Action[]`
  // type annotation has its own bracket pair BEFORE the real array literal.
  // `indexOf('[', start)` finds that empty `[]` first and silently yields
  // zero actions instead of the real 24 -- exactly the "loose anchor
  // silently proves nothing" failure mode this script exists to avoid.
  const eq = src.indexOf('=', start)
  const open = src.indexOf('[', eq)
  const close = src.indexOf(']', open)
  const actions = uniqSorted(
    [...src.slice(open + 1, close).replace(/\/\/[^\n]*/g, '').matchAll(/'([a-z_]+:[a-z_]+)'/g)].map((m) => m[1]),
  )
  // Back up to the start of the `super_admin:` line, not the match itself:
  // slicing at the match loses that line's own leading 4-space indent, so
  // the `^\s{4}` anchor below fails on the FIRST role only and silently
  // drops `super_admin` -- 4 roles found instead of 5, no error, no crash.
  const superAdminAt = src.indexOf('super_admin:')
  const roleBlock = src.slice(src.lastIndexOf('\n', superAdminAt) + 1)
  const roles = uniqSorted([...roleBlock.matchAll(/^\s{4}([a-z_]+):\s*\[/gm)].map((m) => m[1]))
  return { actions, roles }
}

export function extractEnvVars(repoRoot) {
  const src = read(join(repoRoot, 'apps/api/src/config/env.ts'))
  return uniqSorted([...src.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s*z\./gm)].map((m) => m[1]))
}

export function extractSystemdUnits(repoRoot) {
  const dir = join(repoRoot, 'deploy/systemd')
  return existsSync(dir) ? uniqSorted(readdirSync(dir)) : []
}

/** Every docs/*.md path cited from apps/, deploy/ or scripts/. */
export function extractDocPathsCitedFromCode(repoRoot) {
  const roots = ['apps', 'deploy', 'scripts'].map((d) => join(repoRoot, d))
  const exts = ['.ts', '.tsx', '.mjs', '.js', '.sh', '.service', '.timer', '.conf', '.json']
  const cited = []
  for (const root of roots) {
    for (const file of walk(root, (f) => exts.some((e) => f.endsWith(e)))) {
      for (const m of read(file).matchAll(/docs\/[0-9A-Za-z_./-]+\.md/g)) cited.push(m[0])
    }
  }
  return uniqSorted(cited)
}

export function extractFacts(repoRoot) {
  const { actions, roles } = extractActionsAndRoles(repoRoot)
  return {
    routes: extractRoutes(repoRoot),
    connectorTargets: extractConnectorTargets(repoRoot),
    cliScripts: extractCliScripts(repoRoot),
    migrations: extractMigrations(repoRoot),
    actions,
    roles,
    envVars: extractEnvVars(repoRoot),
    systemdUnits: extractSystemdUnits(repoRoot),
    docPathsCitedFromCode: extractDocPathsCitedFromCode(repoRoot),
  }
}

// CLI: write docs/.facts.json. Status to stderr, path to stdout.
//
// pathToFileURL, NOT a hand-built `file://${argv[1]}` template: on Windows
// argv[1] is `D:\path\file.mjs` and import.meta.url is `file:///D:/path/file.mjs`
// — three slashes and forward separators — so the naive comparison never
// matches and the CLI block silently never runs.
//
// The `process.argv[1] &&` guard matters separately: argv[1] is undefined
// under `node -e "import(...)"`, the REPL, and some test-runner invocations,
// and an unguarded `pathToFileURL(undefined)` throws TypeError
// [ERR_INVALID_ARG_TYPE] before the comparison ever runs — crashing a plain
// import of this module instead of just skipping the CLI block.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = process.cwd()
  const facts = extractFacts(repoRoot)
  const out = join(repoRoot, 'docs/.facts.json')
  writeFileSync(out, JSON.stringify(facts, null, 2) + '\n')
  console.error(
    `[extract-doc-facts] ${facts.routes.length} routes, ${facts.connectorTargets.length} targets, ` +
      `${facts.cliScripts.length} scripts, ${facts.migrations.count} migrations, ` +
      `${facts.actions.length} actions, ${facts.systemdUnits.length} units`,
  )
  console.log(relative(repoRoot, out))
}
