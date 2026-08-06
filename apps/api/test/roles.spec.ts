import { describe, expect, it } from 'vitest'
import { parseRoleCredentials } from '../src/db/roles'

describe('parseRoleCredentials', () => {
  it('extracts username and password from a postgres:// connection string', () => {
    expect(
      parseRoleCredentials('postgres://idm_app:idm_app_dev_password@localhost:5432/identity_manager'),
    ).toEqual({ username: 'idm_app', password: 'idm_app_dev_password' })
  })

  it('percent-decodes a username/password containing reserved characters', () => {
    expect(parseRoleCredentials('postgres://idm_app:p%40ss%2Fw%3Ard@localhost:5432/db')).toEqual({
      username: 'idm_app',
      password: 'p@ss/w:rd',
    })
  })

  it('throws a descriptive error when the connection string has no username', () => {
    expect(() => parseRoleCredentials('postgres://localhost:5432/db')).toThrow(/no username/i)
  })
})
