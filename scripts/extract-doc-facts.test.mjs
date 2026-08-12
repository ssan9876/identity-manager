#!/usr/bin/env node
// Run: node scripts/extract-doc-facts.test.mjs
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { extractFacts, citationsIn } from './extract-doc-facts.mjs'

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
check('26 actions and 5 roles', () => {
  // Attribute definitions write path (2026-08-10 SDD), Task 3: ALL_ACTIONS
  // gains `attribute:read` and `attribute:manage`, 24 -> 26. Update this
  // count in the same change that adds/removes an action -- do not let it
  // drift, see docs/archive/plans/2026-08-10-docs-accuracy.md for what
  // happens when it does.
  assert.equal(f.actions.length, 26)
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

// This file lives under scripts/, which extractDocPathsCitedFromCode scans, so
// a literal `docs/<name>.md` written here would be picked up as a real citation
// and reported as a dead pointer. Every fixture below is therefore assembled
// from `D` plus a tail, which no scan can see as one token. Do not inline them.
const D = 'docs/'
check('a citation wrapped across two comment lines is found', () => {
  // The exact shape 7adaed9 left in sync-state.repository.ts: the break falls
  // after `docs/`, so nothing on either line is a complete path.
  const src = ' * (finding H3, ' + D + '\n * archive/audits/audit-integrity.md): the group half\n'
  assert.deepEqual(citationsIn(src), [D + 'archive/audits/audit-integrity.md'])
})
check('a citation wrapped after a partial segment is found', () => {
  // The RolesCatalogPage shape: the break falls mid-filename, before the `.md`.
  const src = ' * dead end (' + D + 'design-system.md and task-2-\n * brief.md: no dead links)\n'
  assert.ok(citationsIn(src).includes(D + 'design-system.md'))
})
check('// and # comment leaders wrap too', () => {
  assert.deepEqual(citationsIn('// see ' + D + '\n// 12-security.md\n'), [D + '12-security.md'])
  assert.deepEqual(citationsIn('# see ' + D + '\n#  12-security.md\n'), [D + '12-security.md'])
})
check('two complete citations on consecutive lines do NOT fuse', () => {
  // The false positive the ordered alternation exists to prevent: greedy
  // joining would yield one run-together path that exists nowhere, and the
  // guard would report a dead pointer that is really two live ones.
  const src = ' * ' + D + '12-security.md\n * ' + D + '14-roadmap.md\n'
  assert.deepEqual(citationsIn(src), [D + '12-security.md', D + '14-roadmap.md'])
})
check('a sentence ending in docs/ does not swallow the next line', () => {
  const src = ' * everything under ' + D + '\n * is non-authoritative prose, not a path\n'
  assert.deepEqual(citationsIn(src), [])
})
check('a citation is not joined across more than one break', () => {
  const src = ' * ' + D + '\n * archive/\n * audits/audit-integrity.md\n'
  assert.deepEqual(citationsIn(src), [])
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
