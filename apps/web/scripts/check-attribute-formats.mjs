#!/usr/bin/env node
// Fails if apps/web's mirrored attribute-format vocabulary drifts from the
// API's single source of truth: `ALL_ATTRIBUTE_FORMATS` in
// apps/api/src/attributes/attribute-formats.ts.
//
// WHY THIS EXISTS
// ---------------
// `validationRules.format` is a CLOSED vocabulary of named validators the API
// owns. The attribute console renders it as a dropdown, which means apps/web
// has to hold a copy — and a hand-copied closed vocabulary is exactly the
// "catalog drift" defect class documented in docs/12-security.md. Its most
// expensive instance in this repo: when the `mail_server` connector target was
// added, the web console's hand-written list went stale and TypeScript could
// not see it, because a narrower literal list is perfectly assignable to a
// wider union. The result was a live outbound integration the console could
// not disable. apps/web/scripts/check-connector-targets.mjs exists to stop that
// recurring; this is the same guard for the same hazard in a second place.
//
// The failure mode here is quieter but the same shape. A format the API has
// added and this list has not is a validator an admin cannot choose, with
// nothing anywhere saying so — the dropdown simply looks complete. A format
// this list has and the API does not is worse: the option is offered, the
// admin picks it, and the save fails with a message naming a vocabulary that
// does not include the thing the console just suggested.
//
// Membership is compared as a SET, deliberately not as an ordered list: the
// order of the web array is the order of the dropdown, which is a legitimate
// product decision. The LABEL TEXT is likewise not checked — only that every
// format has one, because an unlabelled entry renders as `undefined` in the UI.
//
// Technique, anchors and the reasons for rejecting the alternatives (a
// generated artifact, a shared package, type-level proof) are all as
// check-connector-targets.mjs sets out at length; this file follows it rather
// than restating it. Same plain-Node shape, no test framework, filesystem only
// — so it runs under `pnpm verify --quick` too.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..', '..')

const API_REL = 'apps/api/src/attributes/attribute-formats.ts'
const WEB_REL = 'apps/web/src/attributes/api.ts'
const API_FILE = path.join(repoRoot, ...API_REL.split('/'))
const WEB_FILE = path.join(repoRoot, ...WEB_REL.split('/'))

/** CRLF normalised away: this repo is developed on Windows and read on Linux CI, and the union scanner below delimits on a blank line. */
function readSource(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
}

/**
 * Blanks comments while leaving string literals and every line number intact.
 * Quote-aware rather than regex-based because both files carry long prose doc
 * comments full of apostrophes and brackets that a naive stripper mis-pairs —
 * and because the block scanner counts brackets, which must never see one
 * that lives inside a comment.
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
  console.error(`[check-attribute-formats] FAILED: ${message}`)
  process.exit(1)
}

/**
 * The text between the bracket the `anchor` ENDS with and its match. Bails if
 * the anchor is gone: the anchors ARE this script's coupling to source layout,
 * so a rename must stop the build with a pointer to here rather than quietly
 * degrade into comparing empty sets. A silent-pass parser is worse than no
 * guard at all.
 */
function extractBlock(source, file, anchor, open, close) {
  if (!anchor.endsWith(open)) bail(`anchor \`${anchor}\` must end with \`${open}\` (bug in this script).`)
  const at = source.indexOf(anchor)
  if (at === -1) {
    bail(
      `could not find \`${anchor}\` in ${file}.\n` +
        '  That declaration is an anchor for this guard (apps/web/scripts/check-attribute-formats.mjs).\n' +
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

/** The `export type AttributeFormat = | 'a' | 'b'` union has no brackets to match on: read to the first blank line. */
function extractUnion(source, file, anchor) {
  const at = source.indexOf(anchor)
  if (at === -1) {
    bail(
      `could not find \`${anchor}\` in ${file}.\n` +
        '  That declaration is an anchor for this guard (apps/web/scripts/check-attribute-formats.mjs).',
    )
  }
  const end = source.indexOf('\n\n', at)
  return { body: source.slice(at, end === -1 ? source.length : end), line: lineOf(source, at) }
}

const stringLiterals = (body) => [...body.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])
const recordKeys = (body) => [...body.matchAll(/(?:^|,)\s*([a-z0-9_]+)\s*:/g)].map((m) => m[1])

function main() {
  for (const [file, rel] of [
    [API_FILE, API_REL],
    [WEB_FILE, WEB_REL],
  ]) {
    if (!fs.existsSync(file)) bail(`expected ${rel} to exist at ${file}.`)
  }

  const apiSource = blankComments(readSource(API_FILE))
  const webSource = blankComments(readSource(WEB_FILE))

  const apiBlock = extractBlock(apiSource, API_REL, 'export const ALL_ATTRIBUTE_FORMATS = [', '[', ']')
  const apiFormats = stringLiterals(apiBlock.body)
  if (apiFormats.length === 0) {
    bail(`parsed \`ALL_ATTRIBUTE_FORMATS\` in ${API_REL} but found no format literals in it.`)
  }

  const union = extractUnion(webSource, WEB_REL, 'export type AttributeFormat =')
  const webArray = extractBlock(
    webSource,
    WEB_REL,
    'export const ALL_ATTRIBUTE_FORMATS: readonly AttributeFormat[] = [',
    '[',
    ']',
  )
  const webLabels = extractBlock(
    webSource,
    WEB_REL,
    'export const ATTRIBUTE_FORMAT_LABEL: Record<AttributeFormat, string> = {',
    '{',
    '}',
  )

  const checks = [
    {
      what: `the \`AttributeFormat\` union (${WEB_REL}:${union.line})`,
      values: stringLiterals(union.body),
      addHint: (f) => `add a \`| '${f}'\` arm to the union`,
      dropHint: (f) => `delete the \`| '${f}'\` arm from the union`,
      why: 'a format missing here is not even expressible in the console.',
    },
    {
      what: `\`ALL_ATTRIBUTE_FORMATS\` (${WEB_REL}:${webArray.line})`,
      values: stringLiterals(webArray.body),
      addHint: (f) => `add \`'${f}',\` to the array`,
      dropHint: (f) => `remove \`'${f}',\` from the array`,
      why: 'this array IS the format dropdown on the attribute page.',
    },
    {
      what: `\`ATTRIBUTE_FORMAT_LABEL\` (${WEB_REL}:${webLabels.line})`,
      values: recordKeys(webLabels.body),
      addHint: (f) => `add \`${f}: 'Human readable name',\` to the record`,
      dropHint: (f) => `remove the \`${f}:\` entry from the record`,
      why: 'an unlabelled format renders as `undefined` in the dropdown.',
    },
  ]

  const apiSet = new Set(apiFormats)
  const problems = []

  for (const check of checks) {
    const seen = new Set(check.values)
    const missing = apiFormats.filter((f) => !seen.has(f))
    const unknown = check.values.filter((f) => !apiSet.has(f))
    if (missing.length === 0 && unknown.length === 0) continue

    const lines = [`  ${check.what} has drifted — ${check.why}`]
    for (const f of missing) lines.push(`    MISSING '${f}'  ->  ${check.addHint(f)}`)
    for (const f of unknown) lines.push(`    UNKNOWN '${f}'  ->  ${check.dropHint(f)}`)
    problems.push(lines.join('\n'))
  }

  if (problems.length > 0) {
    console.error(
      `[check-attribute-formats] FAILED: the console's attribute-format vocabulary does not match the API's.\n\n` +
        `The API's single source of truth is \`ALL_ATTRIBUTE_FORMATS\` in\n` +
        `  ${API_REL}:${apiBlock.line}\n` +
        `which currently holds ${apiFormats.length} format(s):\n` +
        `  ${apiFormats.join(', ')}\n\n` +
        `${problems.join('\n\n')}\n\n` +
        `TO FIX: edit ${WEB_REL} so all three list exactly the API's formats.\n` +
        `All three must move together — the union alone is not enough, because TypeScript\n` +
        `CANNOT catch this: a narrower literal list is perfectly assignable to a wider union.\n` +
        `An UNKNOWN entry is the worse direction: the console offers the admin a validator the\n` +
        `API will reject, in a 400 naming a vocabulary that does not contain it.`,
    )
    process.exitCode = 1
    return
  }

  console.log(
    `[check-attribute-formats] OK — ${apiFormats.length} format(s) in ${API_REL} match the union, ` +
      `ALL_ATTRIBUTE_FORMATS and ATTRIBUTE_FORMAT_LABEL in ${WEB_REL}.`,
  )
}

main()
