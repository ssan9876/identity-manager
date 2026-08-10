#!/usr/bin/env node
// Fails when documentation claims something the code contradicts.
//
// SCOPE, DELIBERATELY NARROW. This checks only what a machine can PROVE. It
// would NOT have caught docs/12-security.md describing a ReDoS that commit
// 6b75107 had already closed — that needed a human reading a claim against an
// implementation. A guard that is narrow and trusted beats one that is broad
// and noisy, because a noisy guard gets suppressed and then catches nothing.
//
// SUBSTRING MATCHING FRAGILITY: The target and CLI checks use substring
// matching (body.includes()), which has latent false-negative risks:
//   - 'echo' is an English word; prose like "output will echo to the console"
//     in a document would satisfy the check despite a missing 'echo' target.
//   - 'keycloak' is a prefix of 'keycloak_sso', so a document could mention
//     only the longer form yet pass a substring check for 'keycloak'.
// Today's checks pass (all "present" verdicts verified), but future changes
// to documentation should account for this limitation.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { extractFacts } from './extract-doc-facts.mjs'

const read = (p) => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n')

/** Documents that present a complete list of the operator-facing CLIs. */
const CLI_LIST_DOCS = ['docs/11-operations.md']

const API_REFERENCE = 'docs/10-api-reference.md'

/** The scripts an operator runs on a host, as opposed to build plumbing. */
const OPERATOR_CLIS = [
  'db:migrate', 'db:generate', 'bootstrap:admin', 'reconcile',
  'target-reconcile', 'role-reconcile', 'jml:lifecycle', 'hr:sync',
]

/**
 * Documents whose connector-target lists present themselves as complete.
 * A target missing from one of these is a target an operator does not learn
 * exists. Run scripts/check-docs.mjs to see the current gap.
 */
const TARGET_LIST_DOCS = [
  'docs/03-data-model.md',
  'docs/06-configuration.md',
  'docs/09-connectors-and-sync.md',
  'docs/11-operations.md',
]

export function checkDocs(repoRoot) {
  const facts = extractFacts(repoRoot)
  const problems = []

  // 1. Every docs path cited from code must resolve. A dead pointer in a
  //    systemd Documentation= line or a script's help text sends an operator
  //    to a file that is not there, mid-incident.
  for (const rel of facts.docPathsCitedFromCode) {
    if (!existsSync(join(repoRoot, rel))) {
      problems.push(
        `${rel} is cited from code but does not exist.\n` +
          `    Find the citation with: grep -rn "${rel}" apps/ deploy/ scripts/\n` +
          '    Either restore the document or update the citation.',
      )
    }
  }

  // 2. Documents listing the operator CLIs must list all of them. Missing one
  //    means an operator never learns a command exists.
  for (const rel of CLI_LIST_DOCS) {
    const full = join(repoRoot, rel)
    if (!existsSync(full)) continue
    const body = read(full)
    for (const cli of OPERATOR_CLIS) {
      if (!facts.cliScripts.includes(cli)) continue
      if (!body.includes(cli)) {
        problems.push(
          `${rel} does not mention the \`${cli}\` CLI, which exists in apps/api/package.json.\n` +
            `    Add it to the command reference. If it is deliberately undocumented,\n` +
            '    remove it from OPERATOR_CLIS in scripts/check-docs.mjs and say why.',
        )
      }
    }
  }

  // 3. Every document presenting a complete target list must name every
  //    target. Checked per document rather than repo-wide: "mentioned
  //    somewhere in docs/" is not the same as "listed where a reader looks".
  for (const rel of TARGET_LIST_DOCS) {
    const full = join(repoRoot, rel)
    if (!existsSync(full)) continue
    const body = read(full)
    const missing = facts.connectorTargets.filter((t) => !body.includes(t))
    if (missing.length > 0) {
      problems.push(
        `${rel} lists connector targets but omits ${missing.length} of ${facts.connectorTargets.length}:\n` +
          `      ${missing.join(', ')}\n` +
          '    The canonical list is ALL_CONNECTOR_TARGETS in apps/api/src/connectors/connector.ts.\n' +
          '    If this document deliberately covers only some targets, remove it from\n' +
          '    TARGET_LIST_DOCS in scripts/check-docs.mjs and say why in a comment.',
      )
    }
  }

  // 4. Routes, BOTH directions. A documented endpoint that does not exist is
  //    as harmful as an undocumented one: it sends an integrator to build
  //    against a 404. Matching is on the canonical `METHOD /path` token, which
  //    is why prose forms such as "`GET`/`POST` on `/users`" must be
  //    normalised into that shape rather than left for a looser regex.
  const apiRefPath = join(repoRoot, API_REFERENCE)
  if (existsSync(apiRefPath)) {
    const body = read(apiRefPath)
    const documented = new Set(
      [...body.matchAll(/`(GET|POST|PATCH|PUT|DELETE) (\/[A-Za-z0-9:_/-]*)`/g)].map(
        (m) => `${m[1]} ${m[2].replace(/\/$/, '') || '/'}`,
      ),
    )
    const real = new Set(facts.routes.map((r) => `${r.method} ${r.path}`))

    const undocumented = [...real].filter((r) => !documented.has(r)).sort()
    if (undocumented.length > 0) {
      problems.push(
        `${API_REFERENCE} does not document ${undocumented.length} route(s) the API exposes:\n` +
          undocumented.map((r) => `      ${r}`).join('\n') +
          '\n    Document each as a `METHOD /path` token so this check can see it.',
      )
    }

    const phantom = [...documented].filter((r) => !real.has(r)).sort()
    if (phantom.length > 0) {
      problems.push(
        `${API_REFERENCE} documents ${phantom.length} route(s) that do not exist:\n` +
          phantom.map((r) => `      ${r}`).join('\n') +
          '\n    Either the route was removed and the doc kept it, or the path is mistyped.\n' +
          '    A documented endpoint that 404s costs an integrator more than a missing one.',
      )
    }
  }

  return problems
}

// pathToFileURL for the same Windows reason documented in extract-doc-facts.mjs.
// The `process.argv[1] &&` guard matters separately: argv[1] is undefined
// under `node -e "import(...)"`, the REPL, and some test-runner invocations,
// and an unguarded `pathToFileURL(undefined)` throws TypeError
// [ERR_INVALID_ARG_TYPE] before the comparison ever runs — crashing a plain
// import of this module instead of just skipping the CLI block.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = checkDocs(process.cwd())
  if (problems.length === 0) {
    console.error('[check-docs] OK — documentation matches the code on every checked claim.')
    process.exit(0)
  }
  console.error(`[check-docs] FAILED — ${problems.length} problem(s):\n`)
  for (const p of problems) console.error(`  - ${p}\n`)
  process.exit(1)
}
