# Docs Accuracy Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every factual claim in `docs/*.md` true again, and leave behind an automated check that fails when the machine-checkable subset drifts.

**Architecture:** Derive checkable facts from the code once into a generated `docs/.facts.json`; have all correction work copy from that single source rather than each re-deriving it; ship `scripts/check-docs.mjs` asserting the subset a machine can prove, wired into `pnpm verify`. Guards land *before* corrections so each one is observed failing on the known-broken tree and passing after.

**Tech Stack:** Node 20 ESM (`.mjs`, no dependencies — matching `apps/web/scripts/check-connector-targets.mjs`), pnpm workspace, existing `scripts/verify.mjs` stage runner.

## Global Constraints

- **Worktree:** `D:\identity-manager-docs`, branch `docs/accuracy-pass`, based on `df50174`. Never edit `D:\identity-manager` — other sessions share it.
- **Never run the full API suite** (`pnpm --filter @idm/api test`, bare `pnpm vitest run`). It starts a Testcontainers Postgres per spec file and at default parallelism exhausts the disk, producing ~49 fake failures. No task here needs it.
- **Scripts take no dependencies.** Plain Node ESM, readable with `node scripts/<name>.mjs` from the repo root.
- **All status output to stderr; only DATA on stdout.** Repo-wide convention — these scripts get captured with `$(...)`.
- **Line endings:** the repo has `core.autocrlf=true` and `.gitattributes` pins `*.sh` to LF. When rewriting a `.md` or `.json` file with a script, read bytes, normalise `\r\n`→`\n`, edit, then write back in the file's original convention. A naive literal string match against a CRLF file silently fails to match.
- **`docs/.facts.json` is generated and gitignored.** Never hand-edit it, never commit it. A committed generated file that goes stale is the defect this plan exists to fix.
- **Every documentation correction must cite its evidence** (file path, or commit hash). Anything that cannot be settled from source is marked uncertain *in the document*, never guessed.
- **Plans and specs live in `docs/archive/`**, not `docs/superpowers/` — that path was reorganised away on 2026-08-08.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/extract-doc-facts.mjs` | **Create.** Derives the eight fact families from source. Exports pure functions plus a CLI that writes `docs/.facts.json`. |
| `scripts/check-docs.mjs` | **Create.** Asserts the checkable claims in `docs/*.md` against the fact base. Fails loudly with actionable messages. |
| `scripts/verify.mjs` | **Modify.** Add a `docs checks` stage. |
| `package.json` | **Modify.** Add a `check:docs` script. |
| `.gitignore` | **Modify.** Ignore `docs/.facts.json`. |
| `docs/*.md` | **Modify.** The corrections, in six groups. |
| `docs/TODO-business-roles.md` | **Move** to `docs/archive/`. |

---

### Task 1: Fact extractor

**Files:**
- Create: `scripts/extract-doc-facts.mjs`
- Create: `scripts/extract-doc-facts.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `extractFacts(repoRoot) -> Facts`, where `Facts` is
  ```
  {
    routes: [{ method: 'GET'|'POST'|'PATCH'|'PUT'|'DELETE', path: string }],
    connectorTargets: string[],
    cliScripts: string[],
    migrations: { count: number, latest: string },
    actions: string[],
    roles: string[],
    envVars: string[],
    systemdUnits: string[],
    docPathsCitedFromCode: string[]
  }
  ```
  All arrays sorted, no duplicates. `routes[].path` is the full path, controller prefix joined to the method sub-path, always leading-slash, never trailing-slash (`/health/ready`, `/users`, `/users/:id/activate`).
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `scripts/extract-doc-facts.test.mjs`. It runs against the real repository — these are facts about this tree, and a fixture would be a second thing to keep in sync.

```js
#!/usr/bin/env node
// Run: node scripts/extract-doc-facts.test.mjs
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { extractFacts } from './extract-doc-facts.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const f = extractFacts(repoRoot)
let failures = 0
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`) }
  catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message}`) }
}

check('finds the readiness route added 2026-08-10', () => {
  assert.ok(
    f.routes.some((r) => r.method === 'GET' && r.path === '/health/ready'),
    `no GET /health/ready among ${f.routes.length} routes`,
  )
})
check('finds a parameterised route', () => {
  assert.ok(f.routes.some((r) => r.path.includes(':id')), 'no :id route found')
})
check('all 13 connector targets, including scim', () => {
  assert.equal(f.connectorTargets.length, 13)
  assert.ok(f.connectorTargets.includes('scim_slack'))
  assert.ok(f.connectorTargets.includes('keycloak_sso'))
})
check('cli scripts include the ones docs missed', () => {
  for (const s of ['role-reconcile', 'hr:sync', 'db:migrate']) {
    assert.ok(f.cliScripts.includes(s), `missing ${s}`)
  }
})
check('migrations counted', () => {
  assert.ok(f.migrations.count >= 43, `only ${f.migrations.count}`)
  assert.match(f.migrations.latest, /^\d{4}_.*\.sql$/)
})
check('24 actions and 5 roles', () => {
  assert.equal(f.actions.length, 24)
  assert.equal(f.roles.length, 5)
  assert.ok(f.actions.includes('user:read'))
})
check('env vars include DATABASE_URL', () => {
  assert.ok(f.envVars.includes('DATABASE_URL'))
})
check('7 systemd units including the backup pair', () => {
  assert.equal(f.systemdUnits.length, 7)
  assert.ok(f.systemdUnits.includes('idm-backup.timer'))
})
check('doc paths cited from code are found', () => {
  assert.ok(f.docPathsCitedFromCode.length >= 20)
  assert.ok(f.docPathsCitedFromCode.every((p) => p.startsWith('docs/')))
})
check('every array is sorted and deduplicated', () => {
  for (const key of ['connectorTargets','cliScripts','actions','roles','envVars','systemdUnits','docPathsCitedFromCode']) {
    const a = f[key]
    assert.deepEqual(a, [...new Set(a)], `${key} has duplicates`)
    assert.deepEqual(a, [...a].sort(), `${key} is not sorted`)
  }
})

console.log(failures === 0 ? '\nextract-doc-facts: ALL PASS' : `\nextract-doc-facts: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/extract-doc-facts.test.mjs`
Expected: FAIL — `Cannot find module ... extract-doc-facts.mjs`

- [ ] **Step 3: Write the extractor**

Create `scripts/extract-doc-facts.mjs`:

```js
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
  const open = src.indexOf('[', start)
  const close = src.indexOf(']', open)
  const actions = uniqSorted(
    [...src.slice(open + 1, close).replace(/\/\/[^\n]*/g, '').matchAll(/'([a-z_]+:[a-z_]+)'/g)].map((m) => m[1]),
  )
  const roleBlock = src.slice(src.indexOf('super_admin:'))
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
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/extract-doc-facts.test.mjs`
Expected: all `ok`, then `extract-doc-facts: ALL PASS`, exit 0.

If a count assertion fails, the code moved since this plan was written — **update the test to the real number and say so in the commit**, do not loosen the assertion to make it pass.

- [ ] **Step 5: Prove the anchor guard is real**

Temporarily rename `ALL_CONNECTOR_TARGETS` in `apps/api/src/connectors/connector.ts`, run the test, and confirm it throws the "could not find" error rather than returning an empty list. Restore with `git checkout -- apps/api/src/connectors/connector.ts`. Paste both outputs into the commit body.

- [ ] **Step 6: Ignore the generated file**

Append to `.gitignore`:

```
# Generated by scripts/extract-doc-facts.mjs; never commit — a committed
# generated file that goes stale is the defect this exists to prevent.
docs/.facts.json
```

- [ ] **Step 7: Commit**

```bash
git add scripts/extract-doc-facts.mjs scripts/extract-doc-facts.test.mjs .gitignore
git commit -m "feat(docs): derive the facts documentation asserts, from the code

One fact stated in four files is how docs/03, 06, 09 and 11 all came to list
connector targets with no mention of SCIM. This derives them once so anything
that needs one reads it from a single place.

Anchored parses throw when a declaration is renamed rather than returning an
empty set, because a check that silently proves nothing is worse than no check.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Guard — cited doc paths and CLI lists

The two simplest checks, first, to establish the failure-message shape the rest follow.

**Files:**
- Create: `scripts/check-docs.mjs`

**Interfaces:**
- Consumes: `extractFacts` from Task 1.
- Produces: `checkDocs(repoRoot) -> string[]` (array of human-readable problems; empty means pass). The CLI prints them and exits 1 if non-empty.

- [ ] **Step 1: Observe the current failure before writing the check**

`docs/11-operations.md` is missing `role-reconcile` and `hr:sync`. Confirm:

```bash
grep -c "role-reconcile\|hr:sync" docs/11-operations.md
```
Expected: `0`. Record this — the guard must reproduce it.

- [ ] **Step 2: Write the guard**

Create `scripts/check-docs.mjs`:

```js
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
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = checkDocs(process.cwd())
  if (problems.length === 0) {
    console.error('[check-docs] OK — documentation matches the code on every checked claim.')
    process.exit(0)
  }
  console.error(`[check-docs] FAILED — ${problems.length} problem(s):\n`)
  for (const p of problems) console.error(`  - ${p}\n`)
  process.exit(1)
}
```

- [ ] **Step 3: Run it and confirm it FAILS on the known-broken tree**

Run: `node scripts/check-docs.mjs`
Expected: exit 1, reporting that `docs/11-operations.md` does not mention `role-reconcile` and `hr:sync`.

**A guard that passes on a tree we know is broken is not a guard.** If it passes here, the check is wrong — fix it before continuing.

- [ ] **Step 4: Prove the doc-path check too**

Temporarily add `// see docs/99-nonexistent.md` to `scripts/verify.mjs`, run the guard, confirm it reports the dead path, then revert with `git checkout -- scripts/verify.mjs`. Paste both outputs into the commit body.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-docs.mjs
git commit -m "feat(docs): fail the build when docs contradict the code

Starts with the two claims that need no interpretation: a docs/ path cited
from code must resolve, and a document listing the operator CLIs must list all
of them. docs/11-operations.md currently fails the second — it documents two
of the five CLIs an operator actually has.

Deliberately narrow. It would NOT have caught the stale ReDoS entry in
12-security.md, which needed a human reading a claim against an implementation.
A narrow trusted guard beats a broad noisy one; noisy guards get suppressed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Guard — connector targets

**Files:**
- Modify: `scripts/check-docs.mjs`

**Interfaces:**
- Consumes: `facts.connectorTargets` from Task 1.
- Produces: nothing new; extends `checkDocs`.

- [ ] **Step 1: Observe the current failure**

```bash
for f in docs/03-data-model.md docs/06-configuration.md docs/09-connectors-and-sync.md docs/11-operations.md; do
  printf "%-34s scim mentions: %s\n" "$f" "$(grep -ci scim $f)"
done
```
Expected: `09` non-zero; `03`, `06`, `11` all `0`. Record it.

- [ ] **Step 2: Add the check**

In `scripts/check-docs.mjs`, add above `export function checkDocs`:

```js
/**
 * Documents whose connector-target lists present themselves as complete.
 * A target missing from one of these is a target an operator does not learn
 * exists — which on 2026-08-10 was six of thirteen, every SCIM application.
 */
const TARGET_LIST_DOCS = [
  'docs/03-data-model.md',
  'docs/06-configuration.md',
  'docs/09-connectors-and-sync.md',
  'docs/11-operations.md',
]
```

and inside `checkDocs`, before `return problems`:

```js
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
```

- [ ] **Step 3: Run and confirm it fails on exactly the three known files**

Run: `node scripts/check-docs.mjs`
Expected: exit 1, naming `03`, `06` and `11` with the six `scim_*` targets missing. `09` must NOT be reported.

If `09` is reported, read it before changing the guard — it may genuinely be missing a target, which is a finding, not a false positive.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-docs.mjs
git commit -m "feat(docs): fail when a connector-target list omits a live target

Three of the four documents that list targets have no mention of SCIM while
six scim_* targets are live. Checked per document rather than repo-wide:
mentioned somewhere in docs/ is not the same as listed where a reader looks.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Guard — routes, and normalise the API reference

Routes are the coupled task: `docs/10-api-reference.md` documents them in **two** formats — canonical tokens in tables (`` | `GET /sso-apps` | ``) and prose (`` `GET`/`POST` on `/users` ``). A both-directions check cannot pass until the prose forms are normalised, so the guard and the normalisation land together.

**Files:**
- Modify: `scripts/check-docs.mjs`
- Modify: `docs/10-api-reference.md`

**Interfaces:**
- Consumes: `facts.routes` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Measure the gap first**

```bash
grep -coE '`(GET|POST|PATCH|PUT|DELETE) /[a-z]' docs/10-api-reference.md
node -e "import('./scripts/extract-doc-facts.mjs').then(m=>console.log(m.extractFacts(process.cwd()).routes.length))"
```
Record both numbers. The first was 66 and the second 22 controllers' worth when this plan was written; the shortfall is what you are fixing.

- [ ] **Step 2: Add the check**

In `scripts/check-docs.mjs`, add near the other constants:

```js
const API_REFERENCE = 'docs/10-api-reference.md'
```

and inside `checkDocs`, before `return problems`:

```js
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
```

- [ ] **Step 3: Run and record the full gap**

Run: `node scripts/check-docs.mjs 2>&1 | tee /tmp/routes-before.txt`
Expected: exit 1, with a list of undocumented routes (certainly including `GET /health/ready`) and possibly phantom ones.

- [ ] **Step 4: Fix `docs/10-api-reference.md`**

Work through the reported list. For each undocumented route, add a `METHOD /path` token in the table that covers that resource, matching the existing table shape:

```markdown
| `GET /health/ready` | — | Readiness: database reachable and migrations applied. 503 when not. |
```

Normalise prose mentions into canonical tokens as you go — for example line 74's `` `GET`/`POST` on `/users` `` becomes explicit `` `GET /users` `` and `` `POST /users` `` entries.

For each phantom route, verify against the code before deleting: `grep -rn "'<path-segment>'" apps/api/src --include=*.controller.ts`. If the route genuinely exists but the extractor missed it, that is an extractor bug — fix Task 1's code and its test, do not delete true documentation.

- [ ] **Step 5: Run until clean**

Run: `node scripts/check-docs.mjs`
Expected: no route problems reported.

- [ ] **Step 6: Prove non-vacuity**

Add a fake route `@Get('drift-probe')` to `apps/api/src/health/health.controller.ts`, run the guard, confirm it reports `GET /health/drift-probe` as undocumented. Then remove the fake route, add a fake line `` | `GET /health/does-not-exist` | `` to the doc, run again, confirm it reports a phantom. Revert both. Paste all output into the commit body.

- [ ] **Step 7: Commit**

```bash
git add scripts/check-docs.mjs docs/10-api-reference.md
git commit -m "feat(docs): check documented routes against real ones, both directions

An endpoint documented but absent sends an integrator to build against a 404,
which costs more than an undocumented one. The reference documented routes in
two shapes — canonical tokens in tables and prose elsewhere — so the prose is
normalised here; a looser regex would have let the next drift through.

GET /health/ready, shipped 2026-08-10, was undocumented.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Wire into `pnpm verify`

**Files:**
- Modify: `package.json`
- Modify: `scripts/verify.mjs`

**Interfaces:**
- Consumes: `scripts/check-docs.mjs` CLI from Tasks 2–4.
- Produces: a `docs checks` stage in the verify pipeline; `pnpm check:docs` at the root.

- [ ] **Step 1: Add the root scripts**

In `package.json`, alongside the existing scripts:

```json
    "check:docs": "node scripts/extract-doc-facts.test.mjs && node scripts/check-docs.mjs",
```

Both, chained. The extractor test is what proves the fact base is right, and the
guard is only as trustworthy as the facts it reads — an extractor that silently
returned `[]` would make every check pass while proving nothing. A test nothing
runs is a file, not a test.

- [ ] **Step 2: Add the verify stage**

In `scripts/verify.mjs`, immediately after the `web checks` stage at line ~130:

```js
  stage('docs checks', 'pnpm', ['run', 'check:docs'])
```

Placed after `web checks` and **before** the `if (quick)` branch, so it runs
under `verify:quick` as well as the full gate. A docs check that only runs in
the container-backed full gate would rarely run at all.

Update the numbered stage list in that file's header doc block to include it, matching how `web checks` is described there.

- [ ] **Step 3: Run the stage in isolation**

Run: `pnpm check:docs`
Expected: `extract-doc-facts: ALL PASS`, then the guard's verdict — passing by
now if Tasks 2–4 are complete.

- [ ] **Step 4: Confirm it runs inside verify**

Run: `pnpm verify:quick`
Expected: output contains `docs checks ...` then `docs checks OK.`

`verify:quick` is used because it skips the container-backed API suite. Do not run plain `pnpm verify` here — see Global Constraints.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/verify.mjs
git commit -m "feat(docs): run the docs checks in pnpm verify

Same gate as the CSS-token and connector-target checks. A guard nobody runs is
a file, not a guard.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Correct `docs/12-security.md`

Its own task, ahead of the other documents: it holds the worst known error, and it is the document a reader is least able to verify independently.

**Files:**
- Modify: `docs/12-security.md`

**Interfaces:**
- Consumes: `docs/.facts.json` (regenerate with `node scripts/extract-doc-facts.mjs` first).
- Produces: a corrected security document. Task 12 depends on this landing first.

- [ ] **Step 1: Verify the known error**

```bash
sed -n '195,215p' docs/12-security.md
grep -n "new RegExp\|rules.pattern" apps/api/src/attributes/attribute-validator.ts
git log --oneline -1 6b75107
```
Expected: the doc describes `new RegExp(rules.pattern)` as live; the validator no longer contains it and rejects `validationRules.pattern` outright; `6b75107` is *fix(security): close the attribute-validator ReDoS with a closed vocabulary*.

- [ ] **Step 2: Correct the ReDoS entry**

Move it out of "Known open items" into the closed/resolved section, stating what closed it (`6b75107`), what the code does now (rejects `validationRules.pattern`, failing *closed* rather than silently skipping a constraint an admin set), and that it therefore no longer blocks the attribute-definitions write path.

Keep the description of what the vulnerability *was*. A resolved finding that explains the original defect is how the next person avoids reintroducing it.

- [ ] **Step 3: Audit every remaining claim in the file**

Go section by section. For each factual assertion, verify against code or `git log` and cite what you checked. Specifically re-check every entry in "Known open items" — the roadmap already records that this list has drifted, so treat all of it as suspect, not just the ReDoS entry.

Where a claim cannot be settled from source, mark it uncertain **in the document** (e.g. "carried forward from the 2026-08-08 audit; not independently re-verified") rather than deleting or asserting it.

- [ ] **Step 4: Add CS-M2 as resolved**

The Content-Security-Policy shipped on 2026-08-10 and is live on the deployment. Record it as closed, including the trap it caught: the HTML parser normalises CRLF to LF before CSP hashes a script's source text, so hashing raw bytes of a Windows checkout blocks the script — invisible on a Linux host, fatal for a Windows-built artifact.

- [ ] **Step 5: Verify no dead links**

```bash
grep -oE '\]\((\.\./)?[0-9A-Za-z_./-]+\.md(#[a-z0-9-]+)?\)' docs/12-security.md | sed 's/[])(]//g'
```
Confirm each target file exists, and each `#anchor` matches a real heading in it.

- [ ] **Step 6: Commit**

```bash
git add docs/12-security.md
git commit -m "docs(security): the ReDoS is closed, and the rest of the list is re-verified

12-security.md described \`new RegExp(rules.pattern)\` as a live vulnerability.
6b75107 removed it: validationRules.pattern is now rejected outright and fails
closed. This is the security document — the one a reader is least able to check
independently and most likely to trust — so a false entry here is the most
expensive kind.

Every other claim re-verified against code or git log. Anything undecidable
from source is marked as such in the file rather than guessed. CS-M2 recorded
as closed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Correct connectors and sync

**Files:**
- Modify: `docs/06-configuration.md`
- Modify: `docs/09-connectors-and-sync.md`
- Modify: `docs/03-data-model.md`

**Interfaces:**
- Consumes: `docs/.facts.json` — `connectorTargets`, `envVars`, `migrations`.
- Produces: `node scripts/check-docs.mjs` reports no target-list problems.

- [ ] **Step 1: Regenerate the facts and read them**

```bash
node scripts/extract-doc-facts.mjs
node -e "const f=require('./docs/.facts.json');console.log(f.connectorTargets.join('\n'))"
```

- [ ] **Step 2: Fix the target lists**

Add the six SCIM targets to the lists in `03`, `06` and `09`. Copy the names from the facts file — do not retype them.

Explain the shape rather than just listing: six target *values* share one adapter (`scim.connector.ts`), because `(organization_id, target)` is `connector_targets`' primary key and `(user_id, system)` is unique in `external_identities` — one configured instance per target value is load-bearing for the outbox and correlation design. That is why each application is named rather than there being a single `scim` target.

- [ ] **Step 3: Fix the business-roles heading in `03-data-model.md`**

Line 356 reads `## Business roles — schema landed, engine not yet built`. Verify the engine exists, then correct the heading and the section:

```bash
ls apps/api/src/business-roles/role-reconciler.ts
grep -n "RoleReconciler" apps/api/src/app.module.ts
```

Note that `14-roadmap.md` links to this heading — check whether the anchor it uses still resolves after your edit, and fix the link if not.

- [ ] **Step 4: Audit the rest of both files**

Every remaining claim in `06` and `09`, plus `03`'s connector and HR sections, verified against code. `03` also asserts a migration count — check it against `facts.migrations.count`.

- [ ] **Step 5: Run the guard**

Run: `node scripts/check-docs.mjs`
Expected: no problems reported for `03`, `06`, `09`.

- [ ] **Step 6: Commit**

```bash
git add docs/03-data-model.md docs/06-configuration.md docs/09-connectors-and-sync.md
git commit -m "docs: SCIM targets, and the business-roles engine that shipped

Three documents listed connector targets with no mention of SCIM while six
scim_* targets were live — an operator reading any of them would not learn the
integrations existed. 03-data-model.md also still headed a section 'engine not
yet built' for an engine that is merged, registered in app.module.ts and
deliberately not @Optional().

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Correct authorization

**Files:**
- Modify: `docs/08-authorization.md`

**Interfaces:**
- Consumes: `docs/.facts.json` — `actions` (24), `roles` (5).
- Produces: an accurate authorization reference.

- [ ] **Step 1: Compare documented actions against real ones**

```bash
node scripts/extract-doc-facts.mjs
node -e "
const f=require('./docs/.facts.json'), fs=require('fs');
const body=fs.readFileSync('docs/08-authorization.md','utf8');
const missing=f.actions.filter(a=>!body.includes(a));
console.log('actions total:', f.actions.length);
console.log('missing from doc:', missing.length ? missing.join(', ') : 'none');
console.log('roles:', f.roles.join(', '));
"
```

- [ ] **Step 2: Correct the action and role tables**

Add every missing action with its role assignments, read from `apps/api/src/authz/actions.ts`. The roadmap found this document claiming "fourteen actions" when there are 24 — check for any such count in the prose and correct it.

- [ ] **Step 3: Audit the remaining claims**

The three authorization dimensions, scoping behaviour, and which routes require a *global* grant (`GET /audit` and dead letters do — verify against `requireGlobalAuditGrant` in the code).

- [ ] **Step 4: Commit**

```bash
git add docs/08-authorization.md
git commit -m "docs(authz): all 24 actions, and the counts that had drifted

The prose said fourteen actions; ALL_ACTIONS has 24. An authorization document
that undercounts permissions is one somebody plans a role model against.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Correct install and operate

**Files:**
- Modify: `docs/05-installation.md`
- Modify: `docs/11-operations.md`

**Interfaces:**
- Consumes: `docs/.facts.json` — `cliScripts`, `systemdUnits`, `envVars`.
- Produces: `node scripts/check-docs.mjs` reports no CLI-list or target-list problems.

- [ ] **Step 1: Fix the CLI reference**

`docs/11-operations.md` documents two of the five operator CLIs. Add `role-reconcile` and `hr:sync` to the command reference table, with a one-line description of what each does, read from its CLI source (`apps/api/src/business-roles/role-reconcile-cli.ts` and the HR sync entry point).

- [ ] **Step 2: Fix the systemd unit lists**

Both documents describe the installed units. There are now 7, including `idm-backup.service` and `idm-backup.timer` added 2026-08-10. Verify against `facts.systemdUnits` and correct both.

- [ ] **Step 3: Audit the rest**

Every command, path and claim in both files. These are the documents an operator follows during an incident, so a wrong path costs the most here. Where a claim is about runtime behaviour rather than source, check it against the live deployment (ct:211, serving `df50174`) via the proxmox tools rather than assuming.

- [ ] **Step 4: Run the guard**

Run: `node scripts/check-docs.mjs`
Expected: no CLI-list problems, no target-list problem for `11`.

- [ ] **Step 5: Commit**

```bash
git add docs/05-installation.md docs/11-operations.md
git commit -m "docs(ops): the three CLIs and two units an operator could not find

11-operations.md documented two of the five operator CLIs; role-reconcile and
hr:sync existed with no mention anywhere an operator looks. Both documents also
predated idm-backup.service/.timer.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Correct orientation

**Files:**
- Modify: `docs/01-overview.md`
- Modify: `docs/02-architecture.md`
- Modify: `docs/04-quickstart.md`
- Modify: `docs/README.md`

**Interfaces:**
- Consumes: `docs/.facts.json`.
- Produces: accurate entry-point documents.

Note: `01-overview.md` and `README.md` were partially corrected on 2026-08-10 in the roadmap pass. Verify rather than assume they are clean — that pass was scoped to claims the roadmap touched.

- [ ] **Step 1: Audit each file**

For every capability claimed as existing, confirm it. For every one claimed as absent or planned, confirm that too — the roadmap pass found several things listed as unbuilt that had shipped (SoD, recertification, request catalogue, SAML, per-organization connector targets).

- [ ] **Step 2: Verify the quickstart actually works as written**

`04-quickstart.md` gives commands. Check each against the real scripts in `package.json` and `apps/api/package.json`. A quickstart with one wrong command is worse than none — it is the first thing a new reader runs.

- [ ] **Step 3: Check every internal link**

```bash
for f in docs/01-overview.md docs/02-architecture.md docs/04-quickstart.md docs/README.md; do
  grep -oE '\]\([0-9A-Za-z_./-]+\.md' "$f" | sed 's/](//' | while read t; do
    [ -e "docs/$t" ] || echo "$f -> MISSING docs/$t"
  done
done
```
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add docs/01-overview.md docs/02-architecture.md docs/04-quickstart.md docs/README.md
git commit -m "docs: correct the entry-point documents

These are what a new reader meets first, so a false claim here shapes
everything they do next. Verified each capability claim in both directions —
several things described as unbuilt had shipped.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: Correct admin guide and development

**Files:**
- Modify: `docs/07-admin-guide.md`
- Modify: `docs/13-development.md`

**Interfaces:**
- Consumes: `docs/.facts.json` — `cliScripts`, `routes`.
- Produces: accurate admin and contributor documents.

- [ ] **Step 1: Audit `07-admin-guide.md`**

552 lines, the largest file. It describes console workflows — verify each against the actual console routes in `apps/web/src/App.tsx` and the pages under `apps/web/src/`. Features added since it was written (business roles, recertification, request catalogue, SoD, organizations, SSO apps, data flows) are likely missing entirely; add what is absent.

- [ ] **Step 2: Audit `13-development.md`**

Verify every command against `package.json`. It must state the fork-cap rule for the API suite, which is a real operational trap:

```
pnpm vitest run --poolOptions.forks.minForks=1 --poolOptions.forks.maxForks=3
```

Both bounds are required — `maxForks` alone aborts with a `RangeError` that vitest reports as `Test Files no tests`, which reads like a filter problem and is not. If the document does not say this, add it.

Also add the new docs gate: `pnpm check:docs`, and what it does and does not cover.

- [ ] **Step 3: Run the guard**

Run: `node scripts/check-docs.mjs`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add docs/07-admin-guide.md docs/13-development.md
git commit -m "docs: admin workflows that shipped, and the test-running trap

The admin guide predated business roles, recertification, the request
catalogue, SoD, organizations and SSO apps. 13-development.md now records the
vitest fork cap: maxForks alone aborts with a RangeError that vitest reports as
'no tests', which reads like a filter problem and costs a run to diagnose.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Cleanup and final verification

Depends on Task 6 landing first — the roadmap's warnings must not be removed until the document they warn about is fixed.

**Files:**
- Modify: `docs/14-roadmap.md`
- Move: `docs/TODO-business-roles.md` → `docs/archive/TODO-business-roles.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a clean `pnpm verify:quick` and no cross-document contradictions.

- [ ] **Step 1: Confirm Task 6 landed**

```bash
git log --oneline --all -- docs/12-security.md | head -3
grep -n "ReDoS" docs/12-security.md
```
Do not proceed until the security document is corrected.

- [ ] **Step 2: Remove the roadmap's stale-entry warnings**

```bash
grep -n "that entry is stale\|is itself out of date\|has been shown to drift" docs/14-roadmap.md
```

Remove each, now that the document they point at is correct. Keep the substance of the roadmap entries themselves — only the "and that other document is wrong" asides go.

- [ ] **Step 3: Archive the business-roles scratchpad**

```bash
git mv docs/TODO-business-roles.md docs/archive/TODO-business-roles.md
grep -rn "TODO-business-roles" docs/ TODO.md
```

Update every reference to the new path. Add a one-line note at the top of the moved file recording that it is a historical working document, superseded, and not maintained.

- [ ] **Step 4: Full link check across all docs**

```bash
for f in docs/*.md; do
  grep -oE '\]\([0-9A-Za-z_./-]+\.md' "$f" | sed 's/](//' | while read t; do
    [ -e "docs/$t" ] || echo "$f -> MISSING docs/$t"
  done
done
```
Expected: no output.

- [ ] **Step 5: Full guard and verify**

```bash
node scripts/extract-doc-facts.mjs
node scripts/check-docs.mjs
pnpm verify:quick
```
Expected: guard OK, verify clean. Paste the real output — do not summarise it.

- [ ] **Step 6: Prove the guard still bites**

Re-run the two non-vacuity probes from Tasks 3 and 4 (a fake connector target, a fake route) and confirm each still fails the guard. Revert both. This proves the guard survived every edit made since.

- [ ] **Step 7: Commit**

```bash
git add docs/14-roadmap.md docs/archive/TODO-business-roles.md TODO.md
git commit -m "docs: drop the cross-document corrections, archive the scratchpad

14-roadmap.md carried lines saying 12-security.md's entries were stale. That
was right when written and is a stopgap, not an end state; the entries are now
fixed, so the asides go. TODO-business-roles.md moves to archive — it is a
working scratchpad, and leaving it in docs/ implied a currency it never had.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Notes for the executor

- **Batch the correction tasks 3 at a time**, not all six at once. Five concurrent agents exhausted a session quota on 2026-08-10.
- **Tasks 6–11 are independent** and may run in parallel. **Task 12 must run last**, and depends specifically on Task 6.
- **Tasks 1–5 are strictly sequential** — each builds on the previous script.
- When a guard fails, read the document before changing the guard. A guard reporting a problem is the normal case, not a bug in the guard.
