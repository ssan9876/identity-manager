import { describe, expect, it } from 'vitest'
import {
  ALL_ACTIONS,
  ALL_ROLE_KEYS,
  ROLE_PERMISSIONS,
  ROLE_RANK,
  type Action,
} from '../src/authz/actions'

describe('role catalog', () => {
  it('defines permissions for every role', () => {
    for (const role of ALL_ROLE_KEYS) {
      expect(ROLE_PERMISSIONS[role]).toBeDefined()
    }
  })

  it('defines a rank for every role', () => {
    for (const role of ALL_ROLE_KEYS) {
      expect(typeof ROLE_RANK[role]).toBe('number')
    }
  })

  it('grants super_admin every action', () => {
    expect([...ROLE_PERMISSIONS.super_admin].sort()).toEqual([...ALL_ACTIONS].sort())
  })

  it('ranks super_admin above every other role', () => {
    for (const role of ALL_ROLE_KEYS.filter((r) => r !== 'super_admin')) {
      expect(ROLE_RANK.super_admin).toBeGreaterThan(ROLE_RANK[role])
    }
  })

  it('gives read_only no mutating action', () => {
    for (const action of ROLE_PERMISSIONS.read_only) {
      expect(action.endsWith(':read')).toBe(true)
    }
  })

  it('gives auditor read access to the audit log and nothing mutating', () => {
    expect(ROLE_PERMISSIONS.auditor).toContain('audit:read')
    for (const action of ROLE_PERMISSIONS.auditor) {
      expect(action.endsWith(':read')).toBe(true)
    }
  })

  it('reserves role:assign to super_admin alone', () => {
    for (const role of ALL_ROLE_KEYS.filter((r) => r !== 'super_admin')) {
      expect(ROLE_PERMISSIONS[role]).not.toContain('role:assign')
    }
  })

  it('references no action outside the declared union', () => {
    const known = new Set<string>(ALL_ACTIONS)
    for (const role of ALL_ROLE_KEYS) {
      for (const action of ROLE_PERMISSIONS[role]) {
        expect(known.has(action)).toBe(true)
      }
    }
  })

  // Fix round 2, Critical: role_key is a Postgres enum, so a value like
  // 'constructor' or 'toString' is ordinary, valid SQL
  // (`ALTER TYPE role_key ADD VALUE 'constructor'`). An ordinary object
  // literal inherits Object.prototype, so ROLE_RANK['constructor'] would
  // resolve to the inherited Object function instead of undefined — a real,
  // truthy, non-nullish value that defeats both an `in` check (walks the
  // prototype chain) and a bare `?? fallback` (only catches null/undefined,
  // and a function is neither). A null prototype removes the hazard at its
  // source: every property lookup on a colliding key is genuinely
  // undefined, with no inherited fallback to accidentally observe.
  it('has no prototype on ROLE_RANK or ROLE_PERMISSIONS, so a role_key colliding with an inherited Object.prototype property cannot resolve to anything', () => {
    expect(Object.getPrototypeOf(ROLE_RANK)).toBeNull()
    expect(Object.getPrototypeOf(ROLE_PERMISSIONS)).toBeNull()
  })

  it('does not alias ROLE_PERMISSIONS.super_admin to ALL_ACTIONS', () => {
    // Reference-equality check: super_admin's permission array must be an
    // independent array, not literally the same object as ALL_ACTIONS.
    expect(ROLE_PERMISSIONS.super_admin).not.toBe(ALL_ACTIONS)

    // More useful than reference equality alone: prove mutation cannot
    // cross between them. `readonly Action[]` only blocks mutation through
    // typed call sites — a cast defeats it and is legal under `strict:
    // true` with no `any`/`@ts-ignore`. Simulate exactly that cast and
    // confirm ALL_ACTIONS is unaffected. Always restored via `finally`, so
    // this test never leaves either array mutated for tests that run after
    // it, whichever way the assertion goes.
    const mutable = ROLE_PERMISSIONS.super_admin as Action[]
    const originalLength = ALL_ACTIONS.length
    mutable.push('user:read')
    try {
      expect(ALL_ACTIONS.length).toBe(originalLength)
    } finally {
      mutable.pop()
    }
  })
})
