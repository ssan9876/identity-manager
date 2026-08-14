import { Injectable } from '@nestjs/common'
import { Attribute, Change, Client, EqualityFilter } from 'ldapts'
import type tls from 'node:tls'
import { escapeDnValue, escapeFilterValue, guidBufferToString, guidStringToBuffer } from './ad-guid'
import type {
  ConnectorHealth,
  ConnectorOperation,
  DesiredGroup,
  DesiredOrgUnit,
  DesiredUser,
  DirectoryConnector,
  DirectoryGroupConnector,
  DirectoryOrgUnitConnector,
} from './connector'
import { resolveSecret } from './secrets'

// userAccountControl bits this connector reads/writes — MS-ADTS 2.2.16. Only
// the three this connector actually touches; every OTHER bit AD may have set
// (LOCKOUT, DONT_EXPIRE_PASSWORD, an interactive admin's own choices...) is
// preserved by the read-modify-write discipline in `setEnabledPreservingOtherBits`
// below, never blindly overwritten — this task's own explicit BUILD requirement.
const UAC_ACCOUNTDISABLE = 0x0002
const UAC_NORMAL_ACCOUNT = 0x0200
// "Never set, generate or transmit a password... AD creates the account
// without one; it stays disabled until enabled" (this task's own BUILD
// requirement). Verified empirically against a real Samba AD DC: AD refuses
// to ENABLE (clear ACCOUNTDISABLE on) an account with no password unless
// PASSWD_NOTREQD is also set — set unconditionally, on every create, so an
// account can reach `enabled: true` through this connector's normal
// reconcile path with NO password ever having existed. This is the
// documented, load-bearing reason this bit is always present, not an
// unrelated relaxation: credentials remain Keycloak's, permanently — this
// connector has no code path that could set one even if it wanted to (no
// `unicodePwd`/`userPassword` ever appears anywhere below).
const UAC_PASSWD_NOTREQD = 0x0020

// MS-ADTS 2.2.13 `groupType` bit flags. Milestone 11, Task 6 — every group
// this connector ever creates is a GLOBAL SECURITY group, uniformly. See
// this class's own "nesting decision" doc comment below for the full
// reasoning; the short version: within a single AD domain (this connector's
// own, documented scope — design doc, "Out of scope": "single domain per
// configured target"), Global-in-Global nesting has no group-SCOPE
// compatibility ceiling on real Windows AD, so a uniform choice here is what
// removes group scope from ever being a reason THIS connector's own nesting
// could fail — independent of whatever the target DC does or does not
// enforce at the raw LDAP layer (verified empirically, against the real
// Samba AD container this task tests against, that scope-mismatch nesting —
// e.g. a Domain Local group nested inside a Global one — is NOT rejected at
// all at that layer; real Windows AD is documented to reject it, so this
// connector never relies on the DC to catch a mistake it can simply never
// make by construction). The signed-32-bit encoding: `0x80000002` as a
// signed int32 is `-2147483646` — LDAP transmits `groupType` as a decimal
// string of the SIGNED value, the same convention `userAccountControl`
// already uses elsewhere in this file.
const GROUP_TYPE_GLOBAL_SECURITY = '-2147483646'

/**
 * `connector_targets.config` for `target = 'active_directory'` — the
 * NON-SECRET half (decision 4: a secret's NAME lives here, never its
 * value). Parsed once per `configure()` call by `parseConfig` below, which
 * throws a clear, actionable error for a missing/malformed field rather than
 * failing confusingly deep inside an LDAP call.
 */
export interface ActiveDirectoryConnectorConfig {
  /** A single LDAPS URL, e.g. `ldaps://dc1.corp.example.com:636`. Plain `ldap://` is deliberately never accepted — see `parseConfig`. */
  url: string
  /** The domain root, e.g. `DC=corp,DC=example,DC=com`. Every managed user AND every auto-resolved org-unit OU lives under this. */
  baseDN: string
  /** The DN this connector binds as, e.g. `CN=svc-idm-sync,CN=Users,DC=corp,DC=example,DC=com`. */
  bindDN: string
  /** Names the environment variable `secrets.ts#resolveSecret` reads the bind PASSWORD from — never a value stored here. Same config-key convention `EchoConnector` already established. */
  credentialSecretName: string
  /** PEM-encoded CA certificate(s) this connector trusts for the LDAPS server certificate. Omitted = Node's own built-in trusted root store (a legitimate default for a cert issued by a public or already-OS-trusted CA) — NOT a relaxation; `rejectUnauthorized` is `true` either way. */
  caCertificate?: string
  /** Overrides the hostname Node validates the presented certificate's identity against (SNI + `checkServerIdentity`), independent of the host actually dialled. Legitimate when connecting via an IP or a load-balanced/mapped address whose cert was issued for a different, canonical name — full verification still runs, this only names WHICH identity to check it against. */
  tlsServerName?: string
  /**
   * EXPLICIT, obvious-named escape hatch — the ONLY way certificate
   * verification is ever relaxed by this connector, and never the default
   * (absent/false = full verification, always). Setting this `true` maps to
   * `tls.ConnectionOptions.rejectUnauthorized = false`. This task's own
   * BUILD requirement: "Any relaxation is explicit configuration with an
   * obvious name, never a silent fallback, and never the default."
   */
  allowInsecureTls?: boolean
  /**
   * When `true`, a user's org unit path resolving to an AD OU that does not
   * yet exist is created (the full missing chain, root-to-leaf). When
   * false/absent (the default), a missing OU is a clear, per-row failure
   * naming the OU DN — never a silent skip, never a silent fallback
   * location. This task's own BUILD requirement.
   */
  createMissingOrgUnits?: boolean
  connectTimeoutMs?: number
  operationTimeoutMs?: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const DEFAULT_OPERATION_TIMEOUT_MS = 15_000

function requireString(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `ActiveDirectoryConnector: connector_targets.config.${key} is required and must be a non-empty string`,
    )
  }
  return value
}

function optionalString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalBoolean(config: Record<string, unknown>, key: string): boolean | undefined {
  const value = config[key]
  return typeof value === 'boolean' ? value : undefined
}

function optionalNumber(config: Record<string, unknown>, key: string): number | undefined {
  const value = config[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Parses+validates raw `connector_targets.config` JSON into `ActiveDirectoryConnectorConfig` — fails clean and immediately on a missing/wrong-shaped field, the same "clean, actionable error, never a guess" posture `ConnectorRegistry.resolve`/`secrets.ts` already establish elsewhere in this module family. */
export function parseAdConfig(config: Record<string, unknown>): ActiveDirectoryConnectorConfig {
  const url = requireString(config, 'url')
  if (!url.toLowerCase().startsWith('ldaps://')) {
    throw new Error(
      `ActiveDirectoryConnector: connector_targets.config.url must be an "ldaps://" URL (certificate verification is on by default and there is no supported plaintext path) — got "${url}"`,
    )
  }
  return {
    url,
    baseDN: requireString(config, 'baseDN'),
    bindDN: requireString(config, 'bindDN'),
    credentialSecretName: requireString(config, 'credentialSecretName'),
    caCertificate: optionalString(config, 'caCertificate'),
    tlsServerName: optionalString(config, 'tlsServerName'),
    allowInsecureTls: optionalBoolean(config, 'allowInsecureTls'),
    createMissingOrgUnits: optionalBoolean(config, 'createMissingOrgUnits'),
    connectTimeoutMs: optionalNumber(config, 'connectTimeoutMs'),
    operationTimeoutMs: optionalNumber(config, 'operationTimeoutMs'),
  }
}

/** Order-independent equality on two `Record<string, string[]>` attribute maps — the SAME shape/reasoning `KeycloakConnector`/`EchoConnector` each re-derive locally rather than import (see either's own doc comment: a deliberate, repeated convention in `connectors/`, not an oversight). */
function attributesEqual(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const aKeys = Object.keys(a).sort()
  const bKeys = Object.keys(b).sort()
  if (aKeys.length !== bKeys.length || aKeys.some((key, i) => key !== bKeys[i])) {
    return false
  }
  return aKeys.every((key) => {
    const av = [...(a[key] ?? [])].sort()
    const bv = [...(b[key] ?? [])].sort()
    return av.length === bv.length && av.every((value, i) => value === bv[i])
  })
}

/** An `Entry` value (see ldapts's own type: `Buffer | Buffer[] | string[] | string`) normalised to `string[]` — a single value comes back as a bare string, not a one-element array, the same ambiguous-cardinality shape `buildTargetAttributes`/`buildSyncedAttributes` already normalise elsewhere in this codebase. `undefined`/`null` (attribute absent) becomes `[]`. Takes `unknown` because `readEntry`'s own return type is a plain `Record<string, unknown>` (an `Entry`'s index signature, re-widened — see that method's own doc comment) — this is where the runtime shape is actually narrowed. */
function toStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map((entry: unknown) => String(entry))
  if (Buffer.isBuffer(value)) return [value.toString()]
  return [String(value)]
}

/** The fixed set of AD attributes this connector always asserts, keyed by their AD remote name — never subject to default-deny, mirroring `DesiredUser`'s own top-level fields (username/email/firstName/lastName) which "are never subject to default-deny" (connector.ts's own doc comment). `userPrincipalName` is `desired.email` directly rather than `username@<some suffix>`: AD does not require (or validate, at the LDAP layer) that a UPN's suffix be a forest-registered one, and using the email the system already has avoids inventing a second, possibly-inconsistent identifier — this connector manages directory PRESENCE, not login (Keycloak remains the credential authority), so UPN-based interactive logon is out of scope regardless. */
function coreProfileAttributes(desired: DesiredUser): Record<string, string> {
  return {
    sAMAccountName: desired.username,
    userPrincipalName: desired.email,
    givenName: desired.firstName,
    sn: desired.lastName,
    mail: desired.email,
    displayName: `${desired.firstName} ${desired.lastName}`.trim(),
  }
}

interface ExistingEntry {
  dn: string
  externalId: string
}

/**
 * A `(objectGUID=...)` filter as a Buffer-valued `EqualityFilter` OBJECT —
 * never a hex-escaped STRING filter. Confirmed empirically against `ldapts`
 * 7.4.0, against this task's own real Samba AD container: a search for a
 * just-created entry's own `objectGUID`, filtered via a plain string
 * (`` `(objectGUID=${hexEscaped})` ``), returned ZERO results EVERY time —
 * `ldapts`'s string-filter parser unescapes `\xx` into a JS string of raw
 * byte values, but its `EqualityFilter.writeFilter` only special-cases an
 * ACTUAL `Buffer`-typed `value`; a string value is written via
 * `writer.writeString`, which UTF-8-encodes it, corrupting any byte
 * `>= 0x80` — which a 16-byte GUID is virtually guaranteed to contain. The
 * IDENTICAL bytes, passed as a real `Buffer` through THIS function, found
 * the entry every time. See `ad-guid.ts`'s own `guidBufferToFilterHex` doc
 * comment for the full write-up. Every `objectGUID` filter in this file
 * goes through this function — never a hand-built string.
 */
function objectGuidFilter(externalId: string): EqualityFilter {
  return new EqualityFilter({ attribute: 'objectGUID', value: guidStringToBuffer(externalId) })
}

/**
 * The on-prem Active Directory adapter — LDAPS via `ldapts`, against a real
 * domain controller. Implements exactly the four `DirectoryConnector`
 * methods; per that interface's own doc comment, THERE IS NO delete, on this
 * class or anywhere it reaches — `disable()` is the only removal-shaped
 * operation, and it is `userAccountControl`'s `ACCOUNTDISABLE` bit, read-
 * modify-written, never a removal of the AD object.
 *
 * CORRELATION is on `objectGUID` — AD's own immutable key — NEVER the DN,
 * NEVER `sAMAccountName`, NEVER `mail`: this task's own binding rule, because
 * all three MOVE (a rename changes the DN and, via this connector's own
 * design, `sAMAccountName`; an OU move changes the DN; an admin can edit
 * `mail` directly in AD). `apply(desired)` has no `externalId` parameter of
 * its own (Milestone 10, Task 2 — settled interface), so re-identifying an
 * already-known principal uses `desired.existingExternalId` (Milestone 11,
 * Task 5's own additive `DesiredUser` field) — search by `objectGUID` FIRST;
 * only when that is absent (first-ever sync) or stale does this fall back to
 * `sAMAccountName`, the same "find by username" shape `KeycloakConnector`
 * already uses. `guidBufferToString`/`guidStringToBuffer` (ad-guid.ts) are
 * the canonical `externalId` <-> AD-wire-bytes conversions — every
 * `external_identities.external_id` row this connector ever writes is a
 * standard dashed GUID string, the same form ADUC/PowerShell/`samba-tool`
 * display, chosen deliberately over an opaque hex blob (see that module's
 * own doc comment). Every `objectGUID` LDAP FILTER, in turn, goes through
 * this file's own `objectGuidFilter` (a Buffer-valued `EqualityFilter`
 * object, never a hex-escaped string — see that function's own doc comment
 * for the `ldapts` string-filter encoding bug this avoids).
 *
 * CONNECTION LIFECYCLE: one `ldapts.Client`, connected+bound LAZILY on first
 * use and REUSED across every subsequent `plan`/`apply`/`disable`/`health`
 * call — mirrors `KeycloakConnector`'s own implicit connection/token reuse
 * (Milestone 10, Task 2) rather than paying a fresh TLS handshake + bind per
 * call. ANY thrown error from an operation invalidates the cached client
 * (see `withClient`) so the NEXT call reconnects from scratch instead of
 * retrying a connection already known to be bad — this is what lets the
 * connector SELF-HEAL after a transient outage (a dropped DC, a network
 * blip) without needing a process restart; see
 * test/active-directory.connector.spec.ts's "a connection failure mid-batch"
 * proof. `configure()` may be called again with a DIFFERENT config (a live
 * admin edit to `connector_targets.config`) — the next operation detects the
 * change and reconnects using the NEW config rather than continuing to use a
 * stale one.
 *
 * CONNECTION DISCIPLINE (`DirectoryConnector`'s own doc comment): this class
 * never opens a Postgres connection of any kind — its only I/O is LDAP,
 * against the config `ConnectorRegistry.resolve` already read via the
 * caller's own transaction.
 *
 * NEVER SENDS A PASSWORD. No method below ever references `unicodePwd` or
 * `userPassword`. `UAC_PASSWD_NOTREQD`'s own doc comment records exactly why
 * an always-disabled-until-enabled account can still reach `enabled: true`
 * with no password ever having existed.
 *
 * ---------------------------------------------------------------------
 * MILESTONE 11, TASK 6 — GROUPS AND MEMBERSHIP: THE NESTING DECISION
 * ---------------------------------------------------------------------
 *
 * This system models groups as a DAG: direct edges (`group_group_members`,
 * `group_user_members`) plus a recursive, effective closure over them
 * (`GroupsRepository.listEffectiveUserMembers`/`listEffectiveGroupsForUser`).
 * AD represents group containment with its own native mechanism — a
 * group's `member` attribute can hold another group's DN, and AD evaluates
 * that transitively (confirmed empirically against the real Samba container
 * this task tests against, via the `LDAP_MATCHING_RULE_IN_CHAIN` OID,
 * `1.2.840.113556.1.4.1941` — a transitive query for "every group that
 * contains this leaf, at any depth" returned every ancestor correctly). The
 * question this task poses is which local shapes map onto that native
 * mechanism, and which do not.
 *
 * THE RULE THIS CONNECTOR IMPLEMENTS:
 *
 * 1. Every local group syncs to AD as its own GLOBAL SECURITY group
 *    (`GROUP_TYPE_GLOBAL_SECURITY`), uniformly — never Domain Local, never
 *    Universal. Domain Local groups are conventionally for resource ACLs
 *    (file shares, printers), not portable role/team containers; Universal
 *    groups exist to span multiple domains in a forest, which this
 *    connector never does (design doc, "Out of scope": "single domain per
 *    configured target") — choosing Universal here would buy nothing while
 *    adding real Global-Catalog replication cost for every membership
 *    change. Global is the idiomatic default for exactly this system's
 *    shape: one domain, admin-recognisable role/team groups.
 *
 * 2. A local group-to-group edge (one row of `group_group_members`) maps
 *    onto a NATIVE nested `member` edge — the child group's own AD DN added
 *    to the parent's `member` attribute — WHENEVER the child has already
 *    been correlated for this target (a row in `external_group_identities`
 *    exists, i.e. it has synced before and this connector knows its
 *    objectGUID). Within one domain, with every group here uniformly Global
 *    scope, Global-in-Global nesting has no depth ceiling and no
 *    scope-compatibility wall on real Windows AD (documented: nesting is
 *    supported "indefinitely" for same-domain Global-in-Global from Windows
 *    2000 native mode onward) — so this is the rule for the OVERWHELMING
 *    majority of real traffic: nest natively, always, once both sides
 *    exist.
 *
 * 3. THE ONE SHAPE THAT DOES NOT FIT NATIVE NESTING, CONCRETELY: a child
 *    group that has NEVER YET SYNCED to this target. LDAP's `member`
 *    attribute is DN-valued — it cannot reference an object that does not
 *    exist yet, and each local group is its own independent sync unit (its
 *    own outbox aggregate, its own `external_group_identities` row, able to
 *    fail and retry independently of every other group — see this task's
 *    own "a group whose membership sync fails does not corrupt another
 *    group's membership" requirement). A parent can therefore legitimately
 *    be reconciled before a brand-new child has ever reached AD. Rather
 *    than leave the parent's membership silently incomplete (or fail the
 *    parent's ENTIRE sync over one not-yet-provisioned child, which would
 *    also block converging every OTHER, unrelated edge on that same
 *    parent), this connector FLATTENS: it substitutes that child's current
 *    LOCAL EFFECTIVE users (already-correlated ones only) as DIRECT members
 *    of the parent instead of a nested group reference. This is real
 *    "flattened effective membership," not a fallback for its own sake —
 *    see `DesiredGroup.memberExternalIds`'s own doc comment
 *    (connector.ts) for exactly how `SyncWorker.
 *    buildDesiredGroupMemberExternalIds` computes it. It is also
 *    SELF-HEALING with no special "upgrade" step: reconcile-to-desired-state
 *    means the very next reconcile pass, once the child itself has synced
 *    and gained a correlated objectGUID, recomputes desired state fresh and
 *    naturally emits the real nested edge instead — the flattened stand-in
 *    simply stops being computed, and this connector's own diff (in
 *    `applyGroup`) removes the flattened member DNs and adds the one real
 *    nested one, same as any other membership change.
 *
 * WHAT THIS CONNECTOR DELIBERATELY DOES NOT RELY ON: AD/Samba itself to
 * reject an unsupported shape. Empirically (this task's own probes, against
 * the real Samba container): a group-in-group CYCLE is not rejected, a
 * group added as its OWN direct member is not rejected, and even a
 * Domain-Local-inside-Global SCOPE MISMATCH is not rejected — Samba's LDAP
 * layer enforces none of the higher-level business rules real Windows AD
 * tooling is documented to enforce. This connector never depends on any of
 * that: cycles and self-membership can never reach this connector at all
 * (`GroupsRepository.addChildGroup`'s advisory-locked cycle check is the
 * ACTUAL, sole guarantee — this connector adds no second layer of cycle
 * defence, and does not need to), and the scope question is sidestepped
 * entirely by rule 1 (uniform Global scope means there is never a
 * DIFFERENT scope to mismatch against, for any group this connector itself
 * manages).
 *
 * RENAME: a group rename is a PLAIN `modifyDN` on the CN component — the
 * exact same primitive `apply()` already uses to rename a USER (see this
 * class's own CONNECTION LIFECYCLE doc comment above), and nothing more.
 * This is deliberate, not an oversight: verified empirically (this task's
 * own probes) that AD/Samba maintains `member`/`memberOf` DN references
 * AUTOMATICALLY across a `modifyDN` — renaming a nested group updates every
 * PARENT that references it (the stale old DN disappears from their
 * `member` list, the new DN appears, with no separate write from this
 * connector), and renaming a USER updates every GROUP that has them as a
 * direct member the same way. `applyGroup`'s own UPDATE path therefore does
 * exactly one thing for a name change — `modifyDN` — and trusts AD's own
 * referential-integrity behaviour for everything downstream of it, exactly
 * as confirmed by `test/active-directory-groups.connector.spec.ts`'s own
 * rename-preserves-membership proof (re-read over a fresh bind, per this
 * task's own instruction to verify rather than assume).
 */
@Injectable()
export class ActiveDirectoryConnector
  implements DirectoryConnector, DirectoryGroupConnector, DirectoryOrgUnitConnector
{
  private rawConfig: Record<string, unknown> = {}
  private client: Client | null = null
  private boundConfig: ActiveDirectoryConnectorConfig | null = null
  /** Confirmed-existing OU DNs for the CURRENT connection — cleared on every reconnect (a fresh connection might follow a config change pointing at a different domain entirely). Purely a latency optimisation: `ensureOrgUnitChain` re-checks AD directly on a cache miss, never trusts an entry it did not itself confirm or create. */
  private readonly knownOrgUnitDns = new Set<string>()

  /** Rebinds this connector to a FRESH read of `connector_targets.config`, exactly like `EchoConnector.configure` (Milestone 10, Task 2) — called by `ConnectorRegistry.resolve`, never by a caller directly. Returns `this` so `resolve` can `factory(config)` in one expression. */
  configure(config: Record<string, unknown>): this {
    this.rawConfig = config
    return this
  }

  async plan(desired: DesiredUser): Promise<ConnectorOperation[]> {
    return this.withClient(async (client, config) => {
      const existing = await this.findExisting(client, config, desired)
      if (existing === null) {
        return [
          {
            kind: 'create',
            description: `create AD user "${desired.username}" (enabled=${desired.enabled})`,
          },
        ]
      }

      const ops: ConnectorOperation[] = []
      const desiredDn = this.computeTargetDn(config, desired)
      if (!dnEquals(existing.dn, desiredDn)) {
        ops.push({
          kind: 'update',
          description: `move/rename AD user "${desired.username}" from "${existing.dn}" to "${desiredDn}"`,
        })
      }

      const desiredAttributes = this.buildAttributePayload(desired)
      // Same `clearCandidates` reasoning as `apply()`'s own UPDATE path —
      // see that method's doc comment: a name this target is configured to
      // manage (`managedAttributeRemoteNames`) but that has dropped out of
      // `attributePayload` still needs to be reported as a pending change
      // if AD currently has a value for it, or a dry-run plan would
      // under-report exactly the change `apply()` would actually make.
      const clearCandidates = (desired.managedAttributeRemoteNames ?? []).filter(
        (name) => !Object.hasOwn(desiredAttributes, name),
      )
      const currentEntry = await this.readEntry(client, existing.dn, [
        'sAMAccountName',
        'userPrincipalName',
        'givenName',
        'sn',
        'mail',
        'displayName',
        'userAccountControl',
        ...Object.keys(desiredAttributes),
        ...clearCandidates,
      ])

      const currentAttributes: Record<string, string[]> = {}
      for (const key of Object.keys(desiredAttributes)) {
        currentAttributes[key] = toStringArray(currentEntry[key])
      }
      const desiredAttributesAsArrays: Record<string, string[]> = {}
      for (const [key, value] of Object.entries(desiredAttributes)) {
        desiredAttributesAsArrays[key] = Array.isArray(value) ? value : [value]
      }
      const hasStaleClearableAttribute = clearCandidates.some(
        (name) => toStringArray(currentEntry[name]).length > 0,
      )
      if (!attributesEqual(currentAttributes, desiredAttributesAsArrays) || hasStaleClearableAttribute) {
        ops.push({
          kind: 'update',
          description: `update AD user "${desired.username}" profile/attributes`,
        })
      }

      const currentUac = Number(toStringArray(currentEntry.userAccountControl)[0] ?? '0')
      const currentEnabled = (currentUac & UAC_ACCOUNTDISABLE) === 0
      if (currentEnabled !== desired.enabled) {
        ops.push({
          kind: desired.enabled ? 'update' : 'disable',
          description: `set AD user "${desired.username}" enabled=${desired.enabled}`,
        })
      }

      return ops
    })
  }

  async apply(desired: DesiredUser): Promise<{ externalId: string }> {
    return this.withClient(async (client, config) => {
      const existing = await this.findExisting(client, config, desired)
      // The WRITE-path OU resolution (`ensureOrgUnitChain`, confirms or
      // CREATES each missing ancestor per `config.createMissingOrgUnits`) —
      // NOT `computeTargetDn`'s pure string arithmetic, which `plan()` uses
      // instead specifically because a plan must write nothing. Skipping
      // this and computing the DN by string concatenation alone (an earlier
      // version of this method's own bug, caught by this task's own OU
      // tests) means `add()`/`modifyDN` below fail outright the moment an
      // org unit's OU does not already exist — "parent does not exist"
      // (LDAP result 32) — rather than creating it as configured.
      const ouDn = await this.ensureOrgUnitChain(client, config, desired.orgUnitPath ?? [])
      const targetDn = `CN=${escapeDnValue(desired.username)},${ouDn}`
      const attributePayload = this.buildAttributePayload(desired)

      if (existing === null) {
        // CREATE — one single, atomic `add()` carrying the WHOLE initial
        // state (profile + mapped attributes + the correctly-computed
        // initial userAccountControl) in one LDAP wire operation: either
        // this entry is created complete, or it does not exist at all —
        // there is no "half-created" state a connection drop could leave
        // behind (this task's own "a connection failure mid-batch leaves no
        // partially-applied user" requirement, satisfied for the CREATE
        // path by construction, not by extra bookkeeping).
        const uac = UAC_NORMAL_ACCOUNT | UAC_PASSWD_NOTREQD | (desired.enabled ? 0 : UAC_ACCOUNTDISABLE)
        await client.add(targetDn, {
          objectClass: ['top', 'person', 'organizationalPerson', 'user'],
          cn: desired.username,
          ...attributePayload,
          userAccountControl: String(uac),
        })
        const guid = await this.readObjectGuid(client, targetDn)
        return { externalId: guidBufferToString(guid) }
      }

      // UPDATE — three INDEPENDENTLY-atomic wire operations (attribute
      // modify, then DN placement, then UAC), deliberately in THIS order:
      // if a connection drop lands between any two of them, the entry is
      // left in a well-defined, SAFE intermediate state — never corrupted,
      // never invisible, always still findable by `objectGUID` — that the
      // NEXT reconcile pass (this system's whole model: reconcile to
      // desired state, never a delta) simply finishes converging. Profile
      // attributes first (the least identity-sensitive change); placement
      // (rename/move) second; `userAccountControl` LAST specifically so a
      // partial failure never leaves an account MORE enabled than intended
      // partway through an update — the safer side to fail toward.
      // `clearCandidates` — Milestone 11, Task 5's own fix for a real gap
      // found empirically while proving default-deny against AD: LDAP
      // `modify` only touches attribute NAMES explicitly present in the
      // request. Unlike Keycloak's Admin REST API (a whole-object update —
      // simply omitting a key already clears it there), simply no longer
      // including a remote name in `attributePayload` (because its mapping
      // was just disabled, say) leaves whatever AD already has for that
      // name COMPLETELY untouched forever. Every name this target is
      // CONFIGURED to manage (`desired.managedAttributeRemoteNames` — every
      // ENABLED `attribute_target_mappings` row's remote name, custom and
      // core alike) that is NOT a key of `attributePayload` right now is a
      // name that must be ACTIVELY CLEARED if AD currently has a value for
      // it — never left stale. Names AD manages that this target was never
      // configured to touch at all (system attributes, another connector's
      // own writes) are never in `managedAttributeRemoteNames` and are
      // therefore never read or written here.
      const clearCandidates = (desired.managedAttributeRemoteNames ?? []).filter(
        (name) => !Object.hasOwn(attributePayload, name),
      )
      const readNames = [...new Set([...Object.keys(attributePayload), ...clearCandidates])]
      const currentAttributes = await this.readEntry(client, existing.dn, readNames)

      const updateChanges = Object.entries(attributePayload)
        .filter(([key, value]) => {
          const desiredValues = Array.isArray(value) ? value : [value]
          return !attributesEqual({ [key]: toStringArray(currentAttributes[key]) }, { [key]: desiredValues })
        })
        .map(
          ([key, value]) =>
            new Change({
              operation: 'replace',
              modification: new Attribute({ type: key, values: Array.isArray(value) ? value : [value] }),
            }),
        )
      const clearChanges = clearCandidates
        .filter((name) => toStringArray(currentAttributes[name]).length > 0)
        .map(
          (name) =>
            new Change({
              // A `replace` with NO values is the standard LDAP way to
              // clear an attribute entirely (RFC 4511 §4.6) — used here
              // rather than `delete` so this is idempotent even if the
              // value happened to already be unset (a `delete` against an
              // attribute with no values can itself error on some servers).
              operation: 'replace',
              modification: new Attribute({ type: name, values: [] }),
            }),
        )
      const changes = [...updateChanges, ...clearChanges]
      if (changes.length > 0) {
        await client.modify(existing.dn, changes)
      }

      let currentDn = existing.dn
      if (!dnEquals(existing.dn, targetDn)) {
        await client.modifyDN(existing.dn, targetDn)
        currentDn = targetDn
        // The OU this user just moved INTO is now definitely real (we just
        // placed a child under it) — but `ensureOrgUnitChain` already
        // confirmed/created every ancestor before this point, so nothing
        // further to cache here.
      }

      await this.setEnabledPreservingOtherBits(client, currentDn, desired.enabled)

      return { externalId: existing.externalId }
    })
  }

  /**
   * The ONLY removal-shaped operation (per `DirectoryConnector`'s own doc
   * comment) — takes ONLY the immutable id, finds the entry by `objectGUID`
   * (never a DN, never a username the caller does not even have to supply),
   * and read-modify-writes `userAccountControl`'s `ACCOUNTDISABLE` bit.
   * Never touches any other attribute, never removes the AD object.
   */
  async disable(externalId: string): Promise<void> {
    return this.withClient(async (client, config) => {
      const dn = await this.findDnByGuid(client, config, externalId)
      if (dn === null) {
        throw new Error(
          `ActiveDirectoryConnector.disable: no entry found for objectGUID "${externalId}" under "${config.baseDN}"`,
        )
      }
      await this.setEnabledPreservingOtherBits(client, dn, false)
    })
  }

  async health(): Promise<ConnectorHealth> {
    try {
      const { config } = await this.getClient()
      return {
        ok: true,
        detail: `Active Directory reachable at ${config.url}; bound as "${config.bindDN}"`,
      }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  // -------------------------------------------------------------------
  // Group sync (Milestone 11, Task 6) — see this class's own "THE NESTING
  // DECISION" doc comment above for the full rule these two methods
  // implement.
  // -------------------------------------------------------------------

  async planGroup(desired: DesiredGroup): Promise<ConnectorOperation[]> {
    return this.withClient(async (client, config) => {
      const existing = await this.findExistingGroup(client, config, desired)
      if (existing === null) {
        return [{ kind: 'create', description: `create AD group "${desired.name}"` }]
      }

      const ops: ConnectorOperation[] = []
      const targetDn = `CN=${escapeDnValue(desired.name)},${config.baseDN}`
      if (!dnEquals(existing.dn, targetDn)) {
        ops.push({
          kind: 'update',
          description: `rename AD group "${existing.dn}" to "${targetDn}"`,
        })
      }

      const desiredMemberDns = await this.resolveMemberDns(client, config, desired.memberExternalIds)
      const currentMemberDns = await this.readGroupMemberDns(client, existing.dn)
      if (!sameDnSet(currentMemberDns, desiredMemberDns)) {
        ops.push({
          kind: 'update',
          description: `reconcile AD group "${desired.name}" membership`,
        })
      }

      return ops
    })
  }

  /**
   * Asserts one group's own identity (create, or rename-in-place via
   * `modifyDN` — see this class's own "THE NESTING DECISION" doc comment for
   * why a rename needs nothing beyond that) and its DIRECT `member` edges,
   * reconciled to `desired.memberExternalIds` exactly — added edges are
   * missing DNs, removed edges are DNs no longer desired, every OTHER
   * existing member is left untouched. CREATE carries the group's initial
   * member list in the SAME atomic `add()` as its own identity (mirroring
   * `apply()`'s own CREATE-path atomicity for users — "either this entry is
   * created complete, or it does not exist at all"); UPDATE places identity
   * (rename) BEFORE membership, so a connection drop between the two still
   * leaves the group correctly named and findable by `objectGUID`, with
   * membership simply catching up on the next reconcile — the identical
   * "safe, self-healing intermediate state" discipline `apply()` already
   * uses for a user's own UPDATE path.
   */
  async applyGroup(desired: DesiredGroup): Promise<{ externalId: string }> {
    return this.withClient(async (client, config) => {
      const existing = await this.findExistingGroup(client, config, desired)
      const targetDn = `CN=${escapeDnValue(desired.name)},${config.baseDN}`
      const desiredMemberDns = await this.resolveMemberDns(client, config, desired.memberExternalIds)

      if (existing === null) {
        const attributes: Record<string, string | string[]> = {
          objectClass: ['top', 'group'],
          sAMAccountName: desired.name,
          groupType: GROUP_TYPE_GLOBAL_SECURITY,
        }
        if (desiredMemberDns.length > 0) {
          attributes.member = desiredMemberDns
        }
        await client.add(targetDn, attributes)
        const guid = await this.readObjectGuid(client, targetDn)
        return { externalId: guidBufferToString(guid) }
      }

      let currentDn = existing.dn
      if (!dnEquals(existing.dn, targetDn)) {
        // A REAL bug caught empirically while writing this task's own rename
        // test (the very kind of discovery Task 5's report already warned a
        // future reader to expect): `modifyDN` renames the RDN (the `cn`
        // attribute) but does NOT touch `sAMAccountName` — a SEPARATE
        // attribute AD never keeps in sync with the DN on its own. This
        // connector derives BOTH `targetDn`'s CN component and
        // `sAMAccountName` from the SAME `desired.name`, so the two must be
        // kept in lockstep explicitly. Attribute change FIRST, placement
        // SECOND — the identical ordering discipline `apply()` already uses
        // for a user's own rename (profile attributes, including
        // `sAMAccountName`, before `modifyDN` there too), for the identical
        // reason: a connection drop between the two still leaves the group
        // correctly findable by `objectGUID`, in a safe, self-healing
        // intermediate state.
        await client.modify(
          existing.dn,
          new Change({
            operation: 'replace',
            modification: new Attribute({ type: 'sAMAccountName', values: [desired.name] }),
          }),
        )
        await client.modifyDN(existing.dn, targetDn)
        currentDn = targetDn
      }

      const currentMemberDns = await this.readGroupMemberDns(client, currentDn)
      const toAdd = desiredMemberDns.filter((dn) => !currentMemberDns.some((current) => dnEquals(current, dn)))
      const toRemove = currentMemberDns.filter((dn) => !desiredMemberDns.some((wanted) => dnEquals(wanted, dn)))

      const changes: Change[] = []
      if (toAdd.length > 0) {
        changes.push(new Change({ operation: 'add', modification: new Attribute({ type: 'member', values: toAdd }) }))
      }
      if (toRemove.length > 0) {
        changes.push(
          new Change({ operation: 'delete', modification: new Attribute({ type: 'member', values: toRemove }) }),
        )
      }
      if (changes.length > 0) {
        await client.modify(currentDn, changes)
      }

      return { externalId: existing.externalId }
    })
  }

  // -------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------

  private parsedConfig(): ActiveDirectoryConnectorConfig {
    return parseAdConfig(this.rawConfig)
  }

  /** Runs `fn` against a live, bound client — reusing the cached connection when possible (see this class's own doc comment), reconnecting first when the config changed, and invalidating the cache on ANY thrown error so the NEXT call starts fresh rather than retrying a connection already known to be bad. */
  private async withClient<T>(
    fn: (client: Client, config: ActiveDirectoryConnectorConfig) => Promise<T>,
  ): Promise<T> {
    const { client, config } = await this.getClient()
    try {
      return await fn(client, config)
    } catch (error) {
      await this.discardClient()
      throw error
    }
  }

  private async getClient(): Promise<{ client: Client; config: ActiveDirectoryConnectorConfig }> {
    const config = this.parsedConfig()

    if (this.client !== null && this.boundConfig !== null && sameConnectionIdentity(this.boundConfig, config)) {
      return { client: this.client, config }
    }

    await this.discardClient()

    const password = resolveSecret(config.credentialSecretName)
    const tlsOptions: tls.ConnectionOptions = {}
    if (config.caCertificate !== undefined) {
      tlsOptions.ca = config.caCertificate
    }
    if (config.tlsServerName !== undefined) {
      tlsOptions.servername = config.tlsServerName
    }
    if (config.allowInsecureTls === true) {
      // The ONE explicit, obvious-named relaxation — never reached unless
      // an admin set this config key themselves. `rejectUnauthorized`
      // otherwise stays at Node's own secure default (`true`).
      tlsOptions.rejectUnauthorized = false
    }

    const client = new Client({
      url: config.url,
      connectTimeout: config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      timeout: config.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
      tlsOptions,
    })
    // `password` lives only in this local scope and inside `client`'s own
    // internal bind call — never assigned to a field, never logged, never
    // included in any error this class constructs (see secrets.ts's own
    // doc comment: resolve transiently, use, discard).
    await client.bind(config.bindDN, password)

    this.client = client
    this.boundConfig = config
    this.knownOrgUnitDns.clear()
    return { client, config }
  }

  private async discardClient(): Promise<void> {
    const client = this.client
    this.client = null
    this.boundConfig = null
    if (client !== null) {
      try {
        await client.unbind()
      } catch {
        // Best-effort — the connection is already being discarded because
        // something went wrong; a failure to cleanly unbind a socket that
        // may already be dead is not itself a new error worth surfacing.
      }
    }
  }

  // -------------------------------------------------------------------
  // Org-unit resolution
  // -------------------------------------------------------------------

  /** Pure string computation — `orgUnitPath` segments (root-to-leaf) reversed into DN order, nested directly under `baseDN`. NEVER under the built-in `CN=Users` container: real AD refuses to create an `organizationalUnit` as a child of that `container`-class object, so every managed principal's home is its resolved OU (or `baseDN` itself for an empty path), never `CN=Users`. */
  private ouDnForPath(config: ActiveDirectoryConnectorConfig, orgUnitPath: readonly string[]): string {
    let dn = config.baseDN
    for (const label of orgUnitPath) {
      dn = `OU=${escapeDnValue(label)},${dn}`
    }
    return dn
  }

  private computeTargetDn(config: ActiveDirectoryConnectorConfig, desired: DesiredUser): string {
    const ouDn = this.ouDnForPath(config, desired.orgUnitPath ?? [])
    return `CN=${escapeDnValue(desired.username)},${ouDn}`
  }

  /**
   * The org-unit half of this connector — Active Directory is the only
   * target in the catalog with a native OU tree, which is why this
   * capability exists as its own interface (see `DirectoryOrgUnitConnector`).
   *
   * Both methods reuse `ouDnForPath`/`ensureOrgUnitChain` rather than
   * re-deriving a DN, so an org unit created ahead of its people lands at
   * EXACTLY the DN `apply()` would later place a user into. Two code paths
   * computing the same placement independently is how a directory ends up
   * with `OU=sales` and `OU=Sales` side by side.
   */
  async planOrgUnit(desired: DesiredOrgUnit): Promise<ConnectorOperation[]> {
    // An empty path is the tree's own root, which IS `baseDN` — it already
    // exists by definition and there is nothing to create.
    if (desired.path.length === 0) return []

    return this.withClient(async (client, config) => {
      const targetDn = this.ouDnForPath(config, desired.path)

      if (desired.previousPath !== undefined && desired.previousPath.length > 0) {
        const previousDn = this.ouDnForPath(config, desired.previousPath)
        if (!dnEquals(previousDn, targetDn) && (await this.organizationalUnitExists(client, previousDn))) {
          return [{ kind: 'update' as const, description: `move ${previousDn} to ${targetDn}` }]
        }
      }

      const operations: ConnectorOperation[] = []
      let parentDn = config.baseDN
      for (const label of desired.path) {
        const dn = `OU=${escapeDnValue(label)},${parentDn}`
        if (!(await this.organizationalUnitExists(client, dn))) {
          operations.push({ kind: 'create', description: `create organizational unit ${dn}` })
        }
        parentDn = dn
      }
      return operations
    })
  }

  async applyOrgUnit(desired: DesiredOrgUnit): Promise<void> {
    if (desired.path.length === 0) return

    await this.withClient(async (client, config) => {
      const targetDn = this.ouDnForPath(config, desired.path)

      // RENAME: one move of one node, not a create-and-abandon.
      //
      // This system rewrites the path of the unit AND every descendant,
      // because its tree is a materialised ltree path. AD's tree is real, so
      // the identical change is a single `modifyDN` on this node and every
      // child moves with it atomically — the same property `applyGroup`
      // already relies on for nested groups.
      //
      // Unlike a GROUP rename, no companion attribute write is needed here.
      // A group's `sAMAccountName` is a separate attribute AD never keeps in
      // step with the DN, which is the bug that path had to fix; an OU's
      // naming attribute IS `ou`, so `modifyDN` updates it as part of
      // changing the RDN. Writing `ou` separately would be redundant at best.
      if (desired.previousPath !== undefined && desired.previousPath.length > 0) {
        const previousDn = this.ouDnForPath(config, desired.previousPath)
        if (!dnEquals(previousDn, targetDn) && (await this.organizationalUnitExists(client, previousDn))) {
          // The DESTINATION's ancestors first: nothing may move into a
          // container that does not exist yet. `slice(0, -1)` is the parent
          // chain — the node itself is what is being moved, not created.
          await this.ensureOrgUnitChain(client, config, desired.path.slice(0, -1))
          await client.modifyDN(previousDn, targetDn)

          // The per-connection cache now holds a DN that no longer exists
          // and is missing the one that does. Left stale, a later user sync
          // on this same connection would "confirm" a container that moved.
          this.knownOrgUnitDns.delete(previousDn)
          this.knownOrgUnitDns.add(targetDn)
          return
        }
        // Nothing at the old DN — fall through and create at the new one.
        // That is the right answer for a rename applied twice (already
        // moved) and for one whose target was never created in the first
        // place, and it is why this method is safe to re-run.
      }

      await this.ensureOrgUnitChain(client, config, desired.path)
    })
  }

  /**
   * WRITE path only (`apply`) — `plan()` uses `ouDnForPath` directly and
   * NEVER calls this, since plan() must write nothing (design doc decision
   * 7) and creating a missing OU is itself a write. Walks `orgUnitPath`
   * root-to-leaf, confirming (or creating, per `config.createMissingOrgUnits`)
   * each level before moving to the next — an ancestor is always resolved
   * before its child is ever referenced. A level already confirmed on THIS
   * connection is skipped (`knownOrgUnitDns`); everything else is checked
   * directly against AD, never assumed.
   */
  private async ensureOrgUnitChain(
    client: Client,
    config: ActiveDirectoryConnectorConfig,
    orgUnitPath: readonly string[],
  ): Promise<string> {
    let parentDn = config.baseDN
    for (const label of orgUnitPath) {
      const dn = `OU=${escapeDnValue(label)},${parentDn}`
      if (!this.knownOrgUnitDns.has(dn)) {
        const exists = await this.organizationalUnitExists(client, dn)
        if (!exists) {
          if (config.createMissingOrgUnits !== true) {
            throw new Error(
              `ActiveDirectoryConnector: organizational unit "${dn}" does not exist — set connector_targets.config.createMissingOrgUnits to create it automatically, or create it in AD first`,
            )
          }
          await client.add(dn, { objectClass: ['top', 'organizationalUnit'], ou: label })
        }
        this.knownOrgUnitDns.add(dn)
      }
      parentDn = dn
    }
    return parentDn
  }

  private async organizationalUnitExists(client: Client, dn: string): Promise<boolean> {
    try {
      const { searchEntries } = await client.search(dn, {
        scope: 'base',
        filter: '(objectClass=organizationalUnit)',
        attributes: ['1.1'],
      })
      return searchEntries.length > 0
    } catch (error) {
      if (isNoSuchObjectError(error)) {
        return false
      }
      throw error
    }
  }

  // -------------------------------------------------------------------
  // Find / read
  // -------------------------------------------------------------------

  /**
   * `objectGUID` FIRST (via `desired.existingExternalId`, when present),
   * `sAMAccountName` as the fallback — see this class's own doc comment for
   * why. Both branches read `objectGUID` back as an explicit buffer
   * (`explicitBufferAttributes`) — ldapts decodes an unrequested binary
   * attribute as a lossy string by default (confirmed empirically: a raw
   * 16-byte `objectGUID` comes back as a 15-CHARACTER string without this
   * option), which would silently corrupt the very value this method exists
   * to return correctly.
   */
  private async findExisting(
    client: Client,
    config: ActiveDirectoryConnectorConfig,
    desired: DesiredUser,
  ): Promise<ExistingEntry | null> {
    if (desired.existingExternalId !== undefined) {
      const { searchEntries } = await client.search(config.baseDN, {
        scope: 'sub',
        filter: objectGuidFilter(desired.existingExternalId),
        attributes: ['distinguishedName'],
      })
      const entry = searchEntries[0]
      if (entry !== undefined) {
        return { dn: String(entry.dn), externalId: desired.existingExternalId }
      }
      // Falls through deliberately: a stored id AD no longer recognises
      // (should not happen — AD never deletes it and this system never
      // asks it to — but "fall back to the same lookup a first-ever sync
      // would use" is a safer response than assuming corruption) still
      // gets a real chance to resolve by username below, rather than racing
      // straight to CREATE and risking a duplicate.
    }

    const { searchEntries } = await client.search(config.baseDN, {
      scope: 'sub',
      filter: `(sAMAccountName=${escapeFilterValue(desired.username)})`,
      attributes: ['distinguishedName', 'objectGUID'],
      explicitBufferAttributes: ['objectGUID'],
    })
    const entry = searchEntries[0]
    if (entry === undefined) {
      return null
    }
    const guid = entry.objectGUID
    if (!Buffer.isBuffer(guid)) {
      throw new Error(`ActiveDirectoryConnector: expected objectGUID to be returned as a buffer for "${entry.dn}"`)
    }
    return { dn: String(entry.dn), externalId: guidBufferToString(guid) }
  }

  private async findDnByGuid(
    client: Client,
    config: ActiveDirectoryConnectorConfig,
    externalId: string,
  ): Promise<string | null> {
    const { searchEntries } = await client.search(config.baseDN, {
      scope: 'sub',
      filter: objectGuidFilter(externalId),
      attributes: ['distinguishedName'],
    })
    const entry = searchEntries[0]
    return entry === undefined ? null : String(entry.dn)
  }

  /**
   * `objectGUID` FIRST (via `desired.existingExternalId`), `sAMAccountName`
   * fallback — the GROUP-shaped mirror of `findExisting` above (see its own
   * doc comment for the full reasoning; identical here, just scoped to
   * `(objectClass=group)` so a name collision with a differently-typed
   * object, however unlikely, is never mistaken for the group being
   * resolved).
   */
  private async findExistingGroup(
    client: Client,
    config: ActiveDirectoryConnectorConfig,
    desired: DesiredGroup,
  ): Promise<ExistingEntry | null> {
    if (desired.existingExternalId !== undefined) {
      const { searchEntries } = await client.search(config.baseDN, {
        scope: 'sub',
        filter: objectGuidFilter(desired.existingExternalId),
        attributes: ['distinguishedName'],
      })
      const entry = searchEntries[0]
      if (entry !== undefined) {
        return { dn: String(entry.dn), externalId: desired.existingExternalId }
      }
      // Same deliberate fall-through as `findExisting` — see its own doc
      // comment.
    }

    const { searchEntries } = await client.search(config.baseDN, {
      scope: 'sub',
      filter: `(&(objectClass=group)(sAMAccountName=${escapeFilterValue(desired.name)}))`,
      attributes: ['distinguishedName', 'objectGUID'],
      explicitBufferAttributes: ['objectGUID'],
    })
    const entry = searchEntries[0]
    if (entry === undefined) {
      return null
    }
    const guid = entry.objectGUID
    if (!Buffer.isBuffer(guid)) {
      throw new Error(`ActiveDirectoryConnector: expected objectGUID to be returned as a buffer for "${entry.dn}"`)
    }
    return { dn: String(entry.dn), externalId: guidBufferToString(guid) }
  }

  /**
   * `DesiredGroup.memberExternalIds` (a set of objectGUID strings — see that
   * field's own doc comment) resolved to each principal's CURRENT DN, via
   * the SAME `findDnByGuid` `disable()` already uses. A correlated id that
   * no longer resolves in AD (should not happen — neither this system nor
   * AD ever deletes) is skipped rather than failing the whole group sync
   * over one stale reference.
   */
  private async resolveMemberDns(
    client: Client,
    config: ActiveDirectoryConnectorConfig,
    externalIds: readonly string[],
  ): Promise<string[]> {
    const dns: string[] = []
    for (const externalId of externalIds) {
      const dn = await this.findDnByGuid(client, config, externalId)
      if (dn !== null) {
        dns.push(dn)
      }
    }
    return dns
  }

  /** This group's CURRENT direct `member` DNs, as plain strings — reuses `readEntry`/`toStringArray`, the same normalisation every other attribute read in this file already goes through. */
  private async readGroupMemberDns(client: Client, dn: string): Promise<string[]> {
    const entry = await this.readEntry(client, dn, ['member'])
    return toStringArray(entry.member)
  }

  private async readObjectGuid(client: Client, dn: string): Promise<Buffer> {
    const { searchEntries } = await client.search(dn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['objectGUID'],
      explicitBufferAttributes: ['objectGUID'],
    })
    const guid = searchEntries[0]?.objectGUID
    if (!Buffer.isBuffer(guid)) {
      throw new Error(`ActiveDirectoryConnector: newly-created entry "${dn}" did not return an objectGUID`)
    }
    return guid
  }

  private async readEntry(client: Client, dn: string, attributes: string[]): Promise<Record<string, unknown>> {
    const { searchEntries } = await client.search(dn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes,
    })
    const entry = searchEntries[0]
    if (entry === undefined) {
      throw new Error(`ActiveDirectoryConnector: entry "${dn}" not found`)
    }
    return entry as unknown as Record<string, unknown>
  }

  // -------------------------------------------------------------------
  // Attribute / userAccountControl assertion
  // -------------------------------------------------------------------

  /** Core, always-on profile fields FIRST, then default-deny-filtered `desired.attributes` (Milestone 10, Task 3 — already scoped to exactly this target's enabled `attribute_target_mappings` rows before this connector ever sees them) spread OVER them — core fields intentionally take precedence on a naming collision, so a misconfigured custom mapping can never override this connector's own identity-critical writes (`sAMAccountName`/`userPrincipalName` above all). `cn` is deliberately EXCLUDED here: renaming the RDN attribute goes through `modifyDN` only (see `apply`'s own doc comment) — attempting to `modify` it directly is both unnecessary (`modifyDN` already updates it) and, on some directories, rejected outright for the attribute currently serving as the RDN. */
  private buildAttributePayload(desired: DesiredUser): Record<string, string | string[]> {
    return { ...desired.attributes, ...coreProfileAttributes(desired) }
  }

  /** Read-modify-write, per this task's own explicit requirement: fetches the CURRENT `userAccountControl`, flips ONLY `ACCOUNTDISABLE`, and writes back the result — every other bit AD has set (for its own reasons, or a prior admin action) survives untouched. A no-op (no LDAP write at all) when the bit is already correct. */
  private async setEnabledPreservingOtherBits(client: Client, dn: string, enabled: boolean): Promise<void> {
    const entry = await this.readEntry(client, dn, ['userAccountControl'])
    const current = Number(toStringArray(entry.userAccountControl)[0] ?? '0')
    const next = enabled ? current & ~UAC_ACCOUNTDISABLE : current | UAC_ACCOUNTDISABLE
    if (next === current) {
      return
    }
    await client.modify(
      dn,
      new Change({
        operation: 'replace',
        modification: new Attribute({ type: 'userAccountControl', values: [String(next)] }),
      }),
    )
  }
}

/** Case-insensitive DN comparison — AD DNs are case-preserving but case-insensitive (matching AD's own `distinguishedName` semantics); comparing case-sensitively would report a spurious "move" for a DN AD itself considers unchanged. */
function dnEquals(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Order-independent, case-insensitive DN SET equality — `planGroup`'s own "would membership actually change" check, the group-membership analogue of `attributesEqual` elsewhere in this file. */
function sameDnSet(a: readonly string[], b: readonly string[]): boolean {
  const setA = new Set(a.map((dn) => dn.toLowerCase()))
  const setB = new Set(b.map((dn) => dn.toLowerCase()))
  return setA.size === setB.size && [...setA].every((dn) => setB.has(dn))
}

/** Whether reconnecting is necessary: the fields that actually determine WHERE/WHO/HOW we connect. `createMissingOrgUnits`/timeouts changing does not need a fresh socket. */
function sameConnectionIdentity(a: ActiveDirectoryConnectorConfig, b: ActiveDirectoryConnectorConfig): boolean {
  return (
    a.url === b.url &&
    a.bindDN === b.bindDN &&
    a.credentialSecretName === b.credentialSecretName &&
    a.caCertificate === b.caCertificate &&
    a.tlsServerName === b.tlsServerName &&
    a.allowInsecureTls === b.allowInsecureTls
  )
}

/** `ldapts` throws a typed `NoSuchObjectError` for LDAP result code 32 (see its own export list) — matched by NAME, not `instanceof` against an imported class, so this stays correct even if a future `ldapts` major changes the class identity across a version this project has not yet upgraded to; mirrors this project's own established "match by the stable, documented signal" preference (e.g. `UsersRepository.translateWriteError` matching a Postgres constraint NAME rather than SQLSTATE alone). */
function isNoSuchObjectError(error: unknown): boolean {
  return error instanceof Error && error.name === 'NoSuchObjectError'
}
