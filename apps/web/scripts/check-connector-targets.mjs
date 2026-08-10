#!/usr/bin/env node
// Fails if apps/web's hand-maintained connector-target catalogue drifts from
// the API's single source of truth: `ALL_CONNECTOR_TARGETS` in
// apps/api/src/connectors/connector.ts.
//
// WHY THIS EXISTS
// ---------------
// The API keeps ONE canonical catalogue — a `const` array from which the
// `ConnectorTarget` union derives — and test/connector-target-catalog.spec.ts
// asserts it matches the `outbox_target` pgEnum in BOTH directions. The web
// console has no such link: apps/web/src/connectors/api.ts hand-writes its own
// `ConnectorTarget` union, its own `ALL_CONNECTOR_TARGETS` array and a
// `CONNECTOR_TARGET_LABEL` record, and its own doc comment admits they "must be
// updated BY HAND whenever a target is added."
//
// That has already shipped a real bug. When `mail_server` was added, the
// hand-copied lists went stale, and TypeScript could not see it because a
// narrower literal list is perfectly assignable to a wider union. The result
// was a live connector target the console could not list, configure, enable or
// DISABLE (no way to switch off a live outbound integration without direct
// database access), that the dead-letter view rejected as an unknown filter,
// and whose dead letters rendered `CONNECTOR_TARGET_LABEL[event.target]` as
// `undefined` in the UI. A target present in the union but MISSING FROM THE
// LABEL RECORD reproduces that last symptom on its own, so this script checks
// the labels too, not just the list.
//
// The risk went up, not down: the catalogue grew from 7 targets to 13 in one
// merge (the six SCIM slots). Batch, by-hand growth is exactly when a mirrored
// list rots.
//
// APPROACH, AND WHY NOT THE ALTERNATIVES
// --------------------------------------
// This parses the two source files textually and compares three sets. The
// alternatives considered:
//
//   * A GENERATED SHARED ARTIFACT (the API emits JSON; the web imports it).
//     Sturdier at the type level — the web union could derive rather than be
//     copied — but it adds a generation step someone must remember to re-run,
//     and a checked-in generated file that goes stale silently is the SAME
//     class of defect this guard exists to catch, just relocated. Rejected.
//
//   * A SHARED PACKAGE. The correct long-term fix, and explicitly out of scope:
//     restructuring two apps to protect one 13-line list is not proportionate.
//
//   * TYPE-LEVEL PROOF (importing the API type into a web typecheck). Requires
//     apps/web's tsconfig to reach into apps/api, i.e. the cross-app coupling a
//     shared package would exist to formalise, without the package. Also cannot
//     see the LABEL record's completeness any better than this can, and cannot
//     produce an instructive failure message.
//
//   * TEXT PARSING (chosen). No build step, no generated file, no framework —
//     apps/web deliberately has no test runner, and its sibling
//     check-css-tokens.mjs establishes the plain-Node-script pattern. The cost
//     is a coupling to the API file's SOURCE LAYOUT: this script knows the
//     three declaration anchors below. That coupling is made safe by failing
//     LOUDLY when an anchor cannot be found (see `extractBlock`) rather than
//     quietly checking nothing — a silent-pass parser would be worse than no
//     guard at all.
//
// Membership is compared as a SET, deliberately not as an ordered list: the
// order of apps/web's array is display order in the console and is a legitimate
// product decision, whereas a MISSING or UNKNOWN target is always a bug.
//
// Wired into apps/web's own `test` script, which `pnpm verify`'s "web checks"
// stage runs (scripts/verify.mjs) and the CI workflow's "Verify" step runs in
// turn — so this is part of the gate, not a script nobody executes. It touches
// only the filesystem: no containers, no network, so it also runs under
// `pnpm verify --quick`.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..', '..')
const API_FILE = path.join(repoRoot, 'apps', 'api', 'src', 'connectors', 'connector.ts')
const WEB_FILE = path.join(repoRoot, 'apps', 'web', 'src', 'connectors', 'api.ts')

const API_REL = 'apps/api/src/connectors/connector.ts'
const WEB_REL = 'apps/web/src/connectors/api.ts'

/**
 * Reads a source file with CRLF normalised away. This repo is developed on
 * Windows as well as CI's Linux runners, and the union scanner below delimits
 * on a blank line: without this, `\n\n` never matches in a CRLF checkout and
 * the union "extends" to the end of the file, silently swallowing every other
 * string literal in it.
 */
function readSource(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
}

/**
 * Blanks out comments while leaving string literals (and every line number)
 * intact. Done quote-aware rather than with a regex because both files carry
 * long prose doc comments containing apostrophes, quotes and brackets that a
 * naive stripper would mis-pair — and because the block scanner below counts
 * brackets, which must not see one that lives inside a comment.
 */
function blankComments(source) {
  let out = ''
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' '
        i += 1
      }
      continue
    }
    if (c === '/' && next === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' '
        i += 1
      }
      out += '  '
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      out += c
      i += 1
      while (i < source.length) {
        if (source[i] === '\\') {
          out += source.slice(i, i + 2)
          i += 2
          continue
        }
        out += source[i]
        if (source[i] === quote) {
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    out += c
    i += 1
  }
  return out
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

/** Fails the run with an explanation instead of returning a wrong answer. */
function bail(message) {
  console.error(`[check-connector-targets] FAILED: ${message}`)
  process.exit(1)
}

/**
 * Returns the text between the bracket the `anchor` ENDS with and its matching
 * `close`. The anchor must end with `open` — scanning forward for the first
 * `open` instead would latch onto the `[` in the type annotation
 * `readonly ConnectorTarget[]` and match an empty array. Bails if the anchor is
 * gone: the anchors ARE this script's coupling to source layout, so a rename
 * must stop the build with a pointer to here, never silently degrade into
 * comparing empty sets.
 */
function extractBlock(source, file, anchor, open, close) {
  if (!anchor.endsWith(open)) bail(`anchor \`${anchor}\` must end with \`${open}\` (bug in this script).`)
  const at = source.indexOf(anchor)
  if (at === -1) {
    bail(
      `could not find \`${anchor}\` in ${file}.\n` +
        `  That declaration is an anchor for this guard (apps/web/scripts/check-connector-targets.mjs).\n` +
        '  If it was renamed or moved, update the anchor in this script — do not delete the check.',
    )
  }
  const start = at + anchor.length - 1
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === open) depth += 1
    else if (source[i] === close) {
      depth -= 1
      if (depth === 0) return { body: source.slice(start + 1, i), line: lineOf(source, at) }
    }
  }
  return bail(`unbalanced \`${open}\` after \`${anchor}\` in ${file}.`)
}

/** Literal target names, e.g. 'scim_slack', in declaration order. */
function stringLiterals(body) {
  return [...body.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])
}

/** Object keys, e.g. `scim_slack: 'Slack (SCIM)'` -> scim_slack. */
function recordKeys(body) {
  return [...body.matchAll(/(?:^|,)\s*([a-z0-9_]+)\s*:/g)].map((m) => m[1])
}

/**
 * The `export type ConnectorTarget = | 'a' | 'b'` union, which has no brackets
 * to match on: read to the first blank line after the declaration.
 */
function extractUnion(source, file, anchor) {
  const at = source.indexOf(anchor)
  if (at === -1) {
    bail(
      `could not find \`${anchor}\` in ${file}.\n` +
        '  That declaration is an anchor for this guard (apps/web/scripts/check-connector-targets.mjs).',
    )
  }
  const end = source.indexOf('\n\n', at)
  return { body: source.slice(at, end === -1 ? source.length : end), line: lineOf(source, at) }
}

function main() {
  for (const [file, rel] of [
    [API_FILE, API_REL],
    [WEB_FILE, WEB_REL],
  ]) {
    if (!fs.existsSync(file)) bail(`expected ${rel} to exist at ${file}.`)
  }

  const apiSource = blankComments(readSource(API_FILE))
  const webSource = blankComments(readSource(WEB_FILE))

  const apiBlock = extractBlock(apiSource, API_REL, 'export const ALL_CONNECTOR_TARGETS = [', '[', ']')
  const apiTargets = stringLiterals(apiBlock.body)
  if (apiTargets.length === 0) {
    bail(`parsed \`ALL_CONNECTOR_TARGETS\` in ${API_REL} but found no target literals in it.`)
  }

  const union = extractUnion(webSource, WEB_REL, 'export type ConnectorTarget =')
  const webArray = extractBlock(
    webSource,
    WEB_REL,
    'export const ALL_CONNECTOR_TARGETS: readonly ConnectorTarget[] = [',
    '[',
    ']',
  )
  const webLabels = extractBlock(
    webSource,
    WEB_REL,
    'export const CONNECTOR_TARGET_LABEL: Record<ConnectorTarget, string> = {',
    '{',
    '}',
  )

  const checks = [
    {
      what: `the \`ConnectorTarget\` union (${WEB_REL}:${union.line})`,
      values: stringLiterals(union.body),
      addHint: (t) => `add a \`| '${t}'\` arm to the union`,
      dropHint: (t) => `delete the \`| '${t}'\` arm from the union`,
      why: 'a target missing here is not even expressible in the console.',
    },
    {
      what: `\`ALL_CONNECTOR_TARGETS\` (${WEB_REL}:${webArray.line})`,
      values: stringLiterals(webArray.body),
      addHint: (t) => `add \`'${t}',\` to the array`,
      dropHint: (t) => `remove \`'${t}',\` from the array`,
      why: 'this array is what the console lists, configures, enables/DISABLES and filters dead letters by.',
    },
    {
      what: `\`CONNECTOR_TARGET_LABEL\` (${WEB_REL}:${webLabels.line})`,
      values: recordKeys(webLabels.body),
      addHint: (t) => `add \`${t}: 'Human readable name',\` to the record`,
      dropHint: (t) => `remove the \`${t}:\` entry from the record`,
      why: 'an unlabelled target renders as `undefined` in the UI.',
    },
  ]

  const problems = []
  const apiSet = new Set(apiTargets)

  for (const check of checks) {
    const seen = new Set(check.values)
    const missing = apiTargets.filter((t) => !seen.has(t))
    const unknown = check.values.filter((t) => !apiSet.has(t))
    if (missing.length === 0 && unknown.length === 0) continue

    const lines = [`  ${check.what} has drifted — ${check.why}`]
    for (const t of missing) lines.push(`    MISSING '${t}'  ->  ${check.addHint(t)}`)
    for (const t of unknown) lines.push(`    UNKNOWN '${t}'  ->  ${check.dropHint(t)}`)
    problems.push(lines.join('\n'))
  }

  if (problems.length > 0) {
    console.error(
      `[check-connector-targets] FAILED: the web console's connector-target catalogue does not match the API's.\n\n` +
        `The API's single source of truth is \`ALL_CONNECTOR_TARGETS\` in\n` +
        `  ${API_REL}:${apiBlock.line}\n` +
        `which currently holds ${apiTargets.length} target(s):\n` +
        `  ${apiTargets.join(', ')}\n\n` +
        `${problems.join('\n\n')}\n\n` +
        `TO FIX: edit ${WEB_REL} so all three of the above list exactly the\n` +
        `API's targets. All three must be updated together — the union alone is not enough,\n` +
        `because TypeScript CANNOT catch this: a narrower literal list is perfectly assignable\n` +
        `to a wider union, which is precisely how \`mail_server\` once shipped as a live target\n` +
        `the console could not disable. If a target should exist in the API but genuinely not\n` +
        `in the console, it still needs a union arm and a label — omit it from the ARRAY only,\n` +
        `and give this script an explicit exception rather than leaving the lists mismatched.`,
    )
    process.exitCode = 1
    return
  }

  console.log(
    `[check-connector-targets] OK — ${apiTargets.length} target(s) in ${API_REL} match the union, ` +
      `ALL_CONNECTOR_TARGETS and CONNECTOR_TARGET_LABEL in ${WEB_REL}.`,
  )
}

main()
