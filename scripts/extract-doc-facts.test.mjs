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
