#!/usr/bin/env node
// Fails when documentation claims something the code contradicts.
//
// SCOPE, DELIBERATELY NARROW. This checks only what a machine can PROVE. It
// would NOT have caught docs/12-security.md describing a ReDoS that commit
// 6b75107 had already closed — that needed a human reading a claim against an
// implementation. A guard that is narrow and trusted beats one that is broad
// and noisy, because a noisy guard gets suppressed and then catches nothing.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { extractFacts } from './extract-doc-facts.mjs'

const read = (p) => readFileSync(p, 'utf8').replace(/\r\n?/g, '\n')

/** Documents that present a complete list of the operator-facing CLIs. */
const CLI_LIST_DOCS = ['docs/11-operations.md']

/** The scripts an operator runs on a host, as opposed to build plumbing. */
const OPERATOR_CLIS = [
  'db:migrate', 'db:generate', 'bootstrap:admin', 'reconcile',
  'target-reconcile', 'role-reconcile', 'jml:lifecycle', 'hr:sync',
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
