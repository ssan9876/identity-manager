import { describe, expect, it } from 'vitest'
import {
  ALL_ACTIONS,
  ALL_ROLE_KEYS,
  ROLE_PERMISSIONS,
  ROLE_RANK,
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
})
