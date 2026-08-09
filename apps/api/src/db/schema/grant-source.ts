import { pgEnum } from 'drizzle-orm/pg-core'

/**
 * Where a grant came from — shared by `group_user_members` and
 * `user_target_accounts`, because the reconciler's central rule ("only ever
 * revoke what you granted") applies identically to both.
 *
 * EXACTLY TWO VALUES, deliberately. A `jml_rule` value would be dead on
 * arrival: Milestone 19 removes JML's `add_to_group`/`remove_from_group`, so
 * nothing in JML will ever grant a membership again. An `import` value would
 * be dead too — the CSV import does not touch group membership at all. Both
 * are tempting to add speculatively and both would be permanent, because
 * Postgres can `ADD VALUE` to an enum but can never drop one. That asymmetry
 * decides it: ship the two sources that genuinely exist, and add a third the
 * day something genuinely becomes a third.
 */
export const grantSource = pgEnum('grant_source', ['business_role', 'manual'])
