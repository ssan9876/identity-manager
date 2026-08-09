import type { Organization } from './api'

export type OrganizationSyncLabel = 'Active' | 'Provisioning' | 'Suspended'

/**
 * TWO INDEPENDENT FACTS, collapsed into one word for the row: the
 * organization's own `status`, and whether its Keycloak realm exists yet.
 *
 * The order matters. A suspended organization reads "Suspended" whether or
 * not its realm was ever created, because that is the fact an operator acted
 * on and the one they need to see; "Provisioning" on a tenant somebody
 * deliberately switched off would read as progress toward something nobody
 * asked for.
 *
 * "Provisioning" rather than "Pending" deliberately, even though the badge
 * treatment is the same one the people list gives "Pending": what is in
 * flight here is not the person's account but the REALM itself, created
 * asynchronously by the sync worker seconds after the row lands. Master is
 * never "Provisioning" — its realm predates this system, so
 * `realmProvisionedAt` is null forever and the branch below would be wrong
 * for it; see `MASTER_SYNC_LABEL`'s use in OrganizationsPage.
 */
export function syncLabel(org: Organization): OrganizationSyncLabel {
  if (org.status === 'suspended') return 'Suspended'
  if (org.isMaster) return 'Active'
  return org.realmProvisionedAt === null ? 'Provisioning' : 'Active'
}

/**
 * `Provisioning` is in flight and reversible -> warn, exactly as the people
 * list treats `pending`. `Suspended` mirrors the person badge's own
 * `suspended` -> warn: reversible, not terminal. `Active` is the uncoloured
 * norm, per docs/design-system.md ("Active is uncoloured").
 */
export const SYNC_LABEL_VARIANT: Record<OrganizationSyncLabel, 'neutral' | 'warn'> = {
  Active: 'neutral',
  Provisioning: 'warn',
  Suspended: 'warn',
}
