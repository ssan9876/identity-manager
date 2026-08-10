/**
 * Verifies that the CSP nginx will serve matches the console nginx will serve.
 *
 * Finding CS-M2. `dist/csp.conf` is generated during the build (vite.config.ts,
 * plugin `idm-csp`); this re-derives the same facts from `dist/index.html` by a
 * deliberately DIFFERENT route — strip HTML comments, then regex — so that a
 * bug in the generator's scanner cannot also hide itself here.
 *
 * A mismatch means the served page's inline theme script is blocked by the
 * served policy: a console that renders nothing, with the only clue in the
 * browser's own console. That is worth failing a build over.
 *
 * Skips (exit 0, loudly) when there is no build output, so that `pnpm test` on
 * a fresh clone is not a false alarm. It fails only when a build EXISTS and is
 * inconsistent.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const htmlPath = resolve(webRoot, 'dist/index.html')
const confPath = resolve(webRoot, 'dist/csp.conf')

if (!existsSync(htmlPath)) {
  console.log('check-csp: no dist/index.html — nothing built yet, skipping')
  process.exit(0)
}

const fail = (msg) => {
  console.error(`check-csp: ${msg}`)
  process.exitCode = 1
}

if (!existsSync(confPath)) {
  fail(
    `dist/index.html exists but dist/csp.conf does not. Both nginx vhosts ` +
      `include that file, so nginx -t would reject the config. Rebuild with ` +
      `pnpm --filter @idm/web build.`,
  )
  process.exit(1)
}

const html = readFileSync(htmlPath, 'utf8')
const conf = readFileSync(confPath, 'utf8')

// Independent extraction: drop comments first, then take every <script> that
// has no src attribute.
const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '')
const expected = []
for (const m of withoutComments.matchAll(
  /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
)) {
  if (/\bsrc\s*=/i.test(m[1])) continue
  // CRLF -> LF: the HTML parser normalizes newlines before CSP ever sees the
  // script's source text. Hashing the raw bytes matches nothing on a
  // Windows checkout — see scriptSourceText() in scripts/csp.mjs.
  const text = m[2].replace(/\r\n?/g, '\n')
  expected.push(createHash('sha256').update(text, 'utf8').digest('base64'))
}

const policyLine = conf
  .split('\n')
  .find((l) => l.trimStart().startsWith('add_header Content-Security-Policy'))
if (!policyLine) fail('dist/csp.conf carries no Content-Security-Policy header')

const policy = policyLine ?? ''
const present = [...policy.matchAll(/'sha256-([A-Za-z0-9+/=]+)'/g)].map(
  (m) => m[1],
)

for (const hash of expected) {
  if (!present.includes(hash)) {
    fail(
      `inline script in dist/index.html hashes to sha256-${hash}, which the ` +
        `policy does not allow — that script would be BLOCKED. Policy carries: ` +
        `${present.map((h) => `sha256-${h}`).join(', ') || '(no hashes)'}`,
    )
  }
}
for (const hash of present) {
  if (!expected.includes(hash)) {
    fail(
      `policy allows sha256-${hash}, which matches no inline script in ` +
        `dist/index.html — a stale hash, so the real script is probably ` +
        `blocked too`,
    )
  }
}

// Cheap sanity checks on the rest of the policy. These are not style rules:
// each one, if absent, is a way the console silently half-works.
if (!/script-src [^;"]*'self'/.test(policy)) {
  fail(`script-src does not allow 'self' — the bundle itself would not load`)
}
if (/'unsafe-inline'/.test(policy) && /script-src[^;"]*'unsafe-inline'/.test(policy)) {
  fail(`script-src carries 'unsafe-inline', which defeats the point of hashing`)
}
if (!/connect-src [^;"]*'self'/.test(policy)) {
  fail(`connect-src does not allow 'self' — every /api call would be blocked`)
}

if (process.exitCode) {
  console.error('check-csp: FAILED')
  process.exit(1)
}
console.log(
  `check-csp: ok — ${expected.length} inline script hash(es) match dist/csp.conf`,
)
