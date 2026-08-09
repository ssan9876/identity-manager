import { describe, expect, it } from 'vitest'
import type { AttributeDefinition } from '../src/attributes/attribute-validator'
import {
  REDACTED_ATTRIBUTE,
  sensitiveAttributeKeys,
  snapshotUser,
  snapshotUserForAudit,
} from '../src/users/users.controller'
import type { User } from '../src/users/users.repository'

/**
 * Finding SEC-M1 (docs/archive/audits/carried-findings-verification.md):
 * attribute values were copied verbatim into `audit_log.before`/`after` on
 * every user write, with no per-attribute read control — and that table's
 * UPDATE/DELETE/TRUNCATE are blocked by both privilege and trigger, so a value
 * written there cannot be removed afterwards.
 *
 * No container needed: `snapshotUserForAudit` is a pure function, and the
 * property under test is entirely about what it puts in the returned object.
 * The end-to-end assertion that this is the shape actually written — and that
 * the OUTBOX row is not redacted — lives in users.write.spec.ts, which has a
 * real database.
 */

function definition(key: string, sensitive: boolean): AttributeDefinition {
  return {
    id: `def-${key}`,
    key,
    label: key,
    dataType: 'string',
    required: false,
    validationRules: {},
    appliesTo: 'user',
    isActive: true,
    selfEditable: false,
    sensitive,
  }
}

function userWith(attributes: Record<string, unknown>): User {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    status: 'active',
    primaryEmail: 'ada@example.com',
    username: 'ada',
    firstName: 'Ada',
    lastName: 'Lovelace',
    displayName: 'Ada Lovelace',
    employeeId: 'E-1',
    jobTitle: 'Engineer',
    orgUnitId: '00000000-0000-0000-0000-0000000000ff',
    managerId: null,
    location: 'London',
    startDate: null,
    endDate: null,
    attributes,
    deactivatedAt: null,
  } as unknown as User
}

describe('audit attribute redaction (finding SEC-M1)', () => {
  it('withholds a sensitive value and names the key it withheld', () => {
    const keys = sensitiveAttributeKeys([
      definition('mail_quota_mb', false),
      definition('salary_band', true),
    ])

    const snapshot = snapshotUserForAudit(
      userWith({ mail_quota_mb: 2048, salary_band: 'B4-confidential' }),
      keys,
    )

    const attributes = snapshot.attributes as Record<string, unknown>
    expect(attributes.salary_band).toBe(REDACTED_ATTRIBUTE)
    // The real value must appear nowhere in the row, under any key.
    expect(JSON.stringify(snapshot)).not.toContain('B4-confidential')

    // Non-sensitive attributes are untouched — this is a targeted withholding,
    // not a blanket one, or the audit log stops being useful.
    expect(attributes.mail_quota_mb).toBe(2048)

    // Saying WHAT was withheld, so a reader can tell "redacted" from "the
    // value genuinely was the string [redacted]". Same convention as
    // UserSyncDetail.errorDetailRedacted.
    expect(snapshot.attributesRedacted).toEqual(['salary_band'])
  })

  it('leaves the snapshot byte-identical when nothing is sensitive', () => {
    const user = userWith({ mail_quota_mb: 2048, location_pref: 'remote' })
    const keys = sensitiveAttributeKeys([
      definition('mail_quota_mb', false),
      definition('location_pref', false),
    ])

    // Not merely equivalent: no `attributesRedacted` key is added at all, so
    // an unchanged deployment's audit rows keep exactly the shape they had.
    expect(snapshotUserForAudit(user, keys)).toEqual(snapshotUser(user))
    expect(snapshotUserForAudit(user, keys)).not.toHaveProperty('attributesRedacted')
  })

  it('adds nothing when a sensitive definition exists but the user has no such attribute', () => {
    const keys = sensitiveAttributeKeys([definition('salary_band', true)])
    const user = userWith({ mail_quota_mb: 2048 })

    expect(snapshotUserForAudit(user, keys)).toEqual(snapshotUser(user))
    expect(snapshotUserForAudit(user, keys)).not.toHaveProperty('attributesRedacted')
  })

  it('redacts every sensitive key, and reports them in a stable order', () => {
    const keys = sensitiveAttributeKeys([
      definition('salary_band', true),
      definition('home_address', true),
      definition('jobTitle_note', false),
    ])

    const snapshot = snapshotUserForAudit(
      userWith({
        home_address: '10 Downing St',
        salary_band: 'B4',
        jobTitle_note: 'promotion pending',
      }),
      keys,
    )

    const attributes = snapshot.attributes as Record<string, unknown>
    expect(attributes.home_address).toBe(REDACTED_ATTRIBUTE)
    expect(attributes.salary_band).toBe(REDACTED_ATTRIBUTE)
    expect(attributes.jobTitle_note).toBe('promotion pending')
    // Sorted, so a diff of two audit rows does not churn on key order.
    expect(snapshot.attributesRedacted).toEqual(['home_address', 'salary_band'])
  })

  it('does not let a __proto__ key in a stored attribute bag reach Object.prototype', () => {
    // A bag can contain `__proto__` as a genuine own property: attribute
    // values arrive as JSON, and JSON.parse creates it as own data rather
    // than invoking the inherited setter (the INJ-H-1 mechanism).
    const attributes = JSON.parse('{"__proto__":{"polluted":true},"salary_band":"B4"}') as Record<
      string,
      unknown
    >
    const keys = sensitiveAttributeKeys([definition('salary_band', true)])

    const snapshot = snapshotUserForAudit(userWith(attributes), keys)

    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect((snapshot.attributes as Record<string, unknown>).salary_band).toBe(REDACTED_ATTRIBUTE)
  })

  it('passes a non-object attribute bag through untouched rather than throwing', () => {
    const keys = sensitiveAttributeKeys([definition('salary_band', true)])

    // Nothing should construct these, but a snapshot helper on the audit path
    // must not be the thing that throws if one ever exists.
    for (const bag of [null, undefined, 'a string', 42, ['an', 'array']]) {
      const user = userWith(bag as unknown as Record<string, unknown>)
      expect(() => snapshotUserForAudit(user, keys)).not.toThrow()
      expect(snapshotUserForAudit(user, keys)).toEqual(snapshotUser(user))
    }
  })
})
