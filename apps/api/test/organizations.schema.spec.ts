import { describe, expect, it } from 'vitest'
import { organizations } from '../src/db/schema/organizations'

describe('organizations schema', () => {
  it('exposes the columns the design requires', () => {
    const columns = Object.keys(organizations)
    for (const name of [
      'id', 'slug', 'name', 'realm', 'status', 'isMaster', 'realmProvisionedAt',
    ]) {
      expect(columns).toContain(name)
    }
  })
})
