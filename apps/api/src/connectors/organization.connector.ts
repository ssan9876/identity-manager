import { Inject, Injectable } from '@nestjs/common'
import { KeycloakAdminClientFactory } from '../keycloak/keycloak-admin-client.factory'

/**
 * Realm lifecycle — the only place in this system that calls Keycloak's
 * server-level realm endpoints (Organizations milestone, Task 11).
 *
 * NOT a `DirectoryConnector`, and deliberately not registered in
 * `ConnectorRegistry`. That interface is about users and groups INSIDE a
 * realm — `planUser`/`applyUser`/`planGroup`/`applyGroup`, all keyed by a
 * principal — and this operates on the realm itself, the container those
 * live in. Folding realm creation into it would mean widening a deliberately
 * narrow, settled interface with two methods that no other target could ever
 * implement (Active Directory, Entra, Google and the mail server have no
 * realm concept at all — see target-fanout.ts, which encodes exactly that
 * fact for fan-out).
 *
 * IDEMPOTENT, per the rule every connector in this directory follows: each
 * method states DESIRED STATE, and returning normally means that state holds.
 * `ensureRealm` called twice is not an error, and neither is
 * `setRealmEnabled` to a value the realm already has. That is what lets the
 * outbox retry an `organization` event freely — the worker reconciles by
 * re-asserting current desired state, never by replaying a delta (see
 * `OutboxWriter.record`'s doc comment on `payload`).
 *
 * CREDENTIAL. Every call here goes through `KeycloakAdminClientFactory`, so
 * it authenticates as the master-realm PROVISIONING service account
 * (`KEYCLOAK_PROVISION_CLIENT_ID`). The realm-scoped credential this system
 * has always used cannot reach another realm at all — Task 9 proved both
 * halves of that against a real Keycloak 26 container. Nothing in this file
 * interpolates a secret into a string; the errors it raises carry Keycloak's
 * OWN response body, which never echoes back the client secret that was sent.
 */
@Injectable()
export class OrganizationConnector {
  constructor(
    @Inject(KeycloakAdminClientFactory) private readonly factory: KeycloakAdminClientFactory,
  ) {}

  /**
   * Desired state, not a create: returning normally means a realm named
   * `input.realm` exists, is enabled, and is administrable by this
   * deployment. A 409 means it already existed — which IS the first half of
   * that desired state — so it is not on its own a failure, the same
   * reasoning `KeycloakAdminClient.ensureGroup` already applies to a group
   * another racer created first.
   *
   * WHAT A 409 DOES NOT PROVE, and the reason this comment is long. Task 9
   * settled, empirically, that a service account holding only `create-realm`
   * retains admin rights on a realm IT created — it read and wrote there with
   * no further grant, which is why nothing here assigns a `<realm>-realm`
   * role. That result covers a realm this credential created. It says nothing
   * about a realm it did NOT create: one an operator made by hand, or one
   * created before the provisioning client was rotated. On that path the 409
   * lands, and without the probe below this method would report success while
   * the first actual failure surfaced much later, from an unrelated user
   * sync, as a bare 403.
   *
   * So the 409 path re-asserts the second half explicitly — see
   * `probeAdministrable`. It costs one extra round trip on the
   * already-exists path ONLY; first creation, which is the path Task 12 takes
   * for every new organization, pays nothing.
   *
   * THE TOKEN INVALIDATION ON THE 201 PATH IS LOAD-BEARING, and it is the
   * one thing here that cannot be guessed from the API docs. Keycloak grants
   * the `<realm>-realm` client roles to a realm's creator AT creation, so the
   * access token this client already holds — minted moments earlier, to make
   * the create call itself — does not carry them. Without the invalidation,
   * the client that just created a realm is the one client guaranteed to be
   * refused on it: `POST /admin/realms` answers 201 and the very next call
   * answers 403. Observed exactly that against Keycloak 26 while building
   * this task; see `KeycloakAdminClient.invalidateCachedToken`.
   */
  async ensureRealm(input: { realm: string; displayName: string }): Promise<void> {
    this.refuseMasterRealm(input.realm, 'create or adopt')

    const client = this.factory.forRealm(input.realm)
    const res = await client.requestServerLevel('POST', '/admin/realms', {
      realm: input.realm,
      displayName: input.displayName,
      enabled: true,
    })

    if (res.status === 409) {
      // Drained even though nothing reads it, so the connection is released
      // rather than left for the GC to reap.
      await res.text()
      await this.probeAdministrable(input.realm)
      return
    }
    if (!res.ok) {
      throw new Error(`create realm failed: ${res.status} ${await res.text()}`)
    }

    // See this method's doc comment: the token that made the call above
    // predates the role grant the call itself produced.
    client.invalidateCachedToken()
  }

  /**
   * Never a delete. Deleting a realm destroys its users, sessions, clients
   * and every credential inside it irreversibly — and Identity Manager has no
   * delete for any aggregate anywhere else either: a suspended organization
   * is `enabled: false`, exactly as a terminated person is `deactivated`
   * rather than gone (see `outboxEventType`'s doc comment for the same rule
   * stated at the outbox level).
   *
   * A PARTIAL update on purpose. Keycloak's realm PUT merges the fields it is
   * given rather than replacing the whole representation, so sending
   * `{ realm, enabled }` leaves login themes, token lifespans, password
   * policies and everything else an operator configured by hand untouched.
   * `realm` is in the body because Keycloak requires it to identify the realm
   * being updated; it is always the SAME name as the path segment, never a
   * rename — renaming a realm would strand every `external_identities` row
   * pointing into it.
   */
  async setRealmEnabled(realm: string, enabled: boolean): Promise<void> {
    this.refuseMasterRealm(realm, enabled ? 'enable' : 'disable')

    const res = await this.factory
      .forRealm(realm)
      .requestServerLevel('PUT', `/admin/realms/${encodeURIComponent(realm)}`, { realm, enabled })

    if (!res.ok) {
      throw new Error(`set realm enabled failed: ${res.status} ${await res.text()}`)
    }
  }

  /**
   * The master organization's realm is off limits to BOTH methods above.
   *
   * Two independent reasons, either one sufficient:
   *
   *  1. SAFETY. `setRealmEnabled(master, false)` would disable the realm this
   *     system authenticates its own administrators against — every operator,
   *     including whoever would have to undo it, locked out at once, with no
   *     API path back in. There is no legitimate caller: Task 12 creates only
   *     non-master organizations, and the master organization is pinned at
   *     startup (Task 6's `master-organization.ts`) precisely because it is
   *     not a thing the API manages.
   *  2. CREDENTIAL. `forRealm(master)` deliberately returns the REALM-SCOPED
   *     client, whose token is minted in the master organization's own realm
   *     and is not admin at `/admin/realms` at all. Every call here would
   *     answer 403 regardless; refusing early turns that into an actionable
   *     message instead of an authorization error an operator has to decode.
   */
  private refuseMasterRealm(realm: string, attempted: string): void {
    if (realm === this.factory.masterRealmName()) {
      throw new Error(
        `refusing to ${attempted} the master organization's realm "${realm}": ` +
          'it is pinned at startup and is not managed through this connector',
      )
    }
  }

  /**
   * Cheap proof that the provisioning credential can actually ADMINISTER a
   * realm found already existing — see `ensureRealm`'s 409 path.
   *
   * `GET /admin/realms/<realm>/users/count` is the probe, and the choice is
   * NOT arbitrary — the obvious candidate, `GET /admin/realms/<realm>`, is
   * useless here. Keycloak 26 answers that one 200 for ANY principal holding
   * an admin role anywhere, including a bare `create-realm` holder with no
   * rights whatsoever in the realm being asked about; it simply returns a
   * stub representation instead of the full one. Measured, not assumed: the
   * first version of this probe used it, and it cheerfully "verified" a realm
   * created by a completely different administrator. `users/count` requires
   * `view-users` ON THAT REALM, which is one of the roles the `<realm>-realm`
   * grant confers, so it separates the two cases — and it is a counting read
   * with no side effect.
   *
   * A 404 is an error here too: it would mean the realm vanished between the
   * 409 and this call, so "it exists" is no longer true and the caller should
   * retry rather than record a provisioned organization.
   *
   * The message names the remedy and the realm, and nothing else — in
   * particular not the credential, per the rule in
   * `KeycloakFactoryConfig.provisionClientId`'s doc comment.
   */
  private async probeAdministrable(realm: string): Promise<void> {
    const res = await this.factory
      .forRealm(realm)
      .requestServerLevel('GET', `/admin/realms/${encodeURIComponent(realm)}/users/count`)

    if (res.ok) {
      await res.text()
      return
    }
    throw new Error(
      `realm "${realm}" already exists but is not administrable with the configured ` +
        `provisioning credential (${res.status}) — it was created by someone else, or before ` +
        'that credential was rotated; grant its service account the ' +
        `"${realm}-realm" client roles in the master realm, or choose a different slug`,
    )
  }
}
