import { customType } from 'drizzle-orm/pg-core'

/**
 * Postgres `ltree` column. Labels must match [A-Za-z0-9_]+ and are
 * dot-separated; use `toLabel()` in the org-units repository to build them.
 */
export const ltree = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'ltree'
  },
})
