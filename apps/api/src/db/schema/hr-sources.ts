import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { organizations } from './organizations'

/**
 * The kinds of upstream HR system a source can be. A CLOSED set, enforced by
 * Postgres at the column level — exactly one kind ships today (`csv_url`: an
 * HTTPS URL serving CSV), and the enum exists so a real HR API (Workday,
 * BambooHR, ...) can be added later as a NEW value plus a new fetch
 * implementation, without a schema redesign. Same caveat as `jml_trigger`
 * (db/schema/jml-rules.ts): `ALTER TYPE ... ADD VALUE` is ordinary SQL, so
 * application code treats a value read back from this column as untrusted
 * input and dispatches through an allowlisted lookup, never Drizzle's
 * compile-time-only typing.
 */
export const hrSourceKind = pgEnum('hr_source_kind', ['csv_url'])

/**
 * What the LAST sync run of a source concluded. Closed set, one value per
 * distinct terminal state `HrSyncService.run` can reach — the console's
 * run-history view renders these verbatim, so a new terminal state must be
 * added HERE, deliberately, not smuggled through a free-text column.
 */
export const hrRunOutcome = pgEnum('hr_run_outcome', [
  /** The upstream fetch itself failed (unreachable, non-2xx, oversized body, bad TLS/redirect). Nothing was previewed. */
  'fetch_failed',
  /** Fetched, but the file could not be previewed at all (malformed CSV, missing required columns after mapping, over the row cap). */
  'preview_failed',
  /** A preview-only run (dry run) completed. Nothing was written about any user. */
  'previewed',
  /** The preview had failing rows and no allow-partial override was given — refused to commit, wrote nothing. */
  'aborted_failures',
  /** The blast-radius guard tripped (too large a fraction of existing people would change) — refused to commit, wrote nothing. */
  'aborted_blast_radius',
  /** Committed with zero failing rows. */
  'committed',
  /** Committed under an explicit allow-partial override; some rows failed and are reported in the counts. */
  'committed_partial',
])

/**
 * HR inbound feed — a PULL-based source this system fetches FROM, feeding
 * the EXISTING bulk-import pipeline (imports/imports.controller.ts). The
 * standing rule is "nothing writes into this system except its own API": an
 * HR feed is never a pushed webhook or SCIM inbound — this table only
 * describes where WE go to fetch, and `HrSyncService` is the only reader.
 *
 * NO SECRET EVER LANDS IN THIS TABLE — the same discipline as
 * `connector_targets` (see that table's doc comment, decision 4 of the
 * connectors design): `auth_secret_name` stores the NAME of a
 * `CONNECTOR_*`-namespaced environment variable, resolved at the point of
 * use through the same `resolveSecret` every connector uses (connectors/
 * secrets.ts — one audited site, one namespace guard). Reading a source
 * through the API returns configuration with no secret VALUE present — not
 * redacted, ABSENT — because none is ever stored here to redact.
 *
 * NO DELETE, by design — a source that has ever run is named by append-only
 * audit rows (`hr_source:sync`), so it is disabled instead of removed,
 * exactly like `jml_rules`/`connector_targets`. Nothing in this codebase
 * issues a DELETE against this table.
 */
export const hrSources = pgTable(
  'hr_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // The tenant this feed belongs to. A feed's rows are previewed and
    // committed against people, and people are tenanted (users.organization_id,
    // 0025/0029) — so an untenanted feed would be one tenant's HR system
    // writing into another tenant's directory. ON DELETE RESTRICT, matching
    // every other table that carries this column (users, jml_rules, ...).
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    name: varchar('name', { length: 255 }).notNull(),

    kind: hrSourceKind('kind').notNull(),

    /**
     * Where to fetch — HTTPS only, checked at the column level as well as by
     * the controller's Zod schema (belt and braces, same posture as
     * `connector_targets_threshold_range`): a plain-HTTP feed would carry
     * every employee's PII and the auth header in cleartext.
     */
    url: varchar('url', { length: 2048 }).notNull(),

    /** Header NAME to send the credential in (e.g. `Authorization`, `X-Api-Key`) — or NULL for an unauthenticated feed. Paired with `auth_secret_name` (both set or both null, enforced below). */
    authHeaderName: varchar('auth_header_name', { length: 128 }),

    /** The NAME of the `CONNECTOR_*` environment variable holding the credential — never the credential itself. See this table's doc comment. */
    authSecretName: varchar('auth_secret_name', { length: 128 }),

    /**
     * Source column -> import pipeline column (import-row.ts's headers, or
     * an extra header that becomes a custom attribute). ONLY mapped columns
     * are forwarded to the pipeline — an HR export's dozens of unmapped
     * payroll columns are dropped rather than surfacing as "unrecognized
     * attribute" failures on every row. Validated by `parseColumnMapping`
     * (hr/hr-feed.ts): flat string->string, no duplicate targets.
     */
    columnMapping: jsonb('column_mapping').$type<Record<string, string>>().notNull().default({}),

    /** Default FALSE, like `jml_rules.enabled`/`connector_targets.enabled`: a freshly created source cannot COMMIT anything until deliberately enabled. Preview-only runs are allowed while disabled — that is how an operator validates the mapping before switching it on. */
    enabled: boolean('enabled').notNull().default(false),

    // The blast-radius guard's two halves, same semantics and same defaults
    // as connector_targets (see that table's extensive doc comments): a run
    // whose preview would UPDATE more than `threshold` percent of the
    // organization's existing people — AND more than `floor` people in
    // absolute terms — halts and reports instead of committing. Percentage
    // alone misfires at small scale; a floor alone misfires at large scale.
    blastRadiusThreshold: integer('blast_radius_threshold').notNull().default(20),
    blastRadiusFloor: integer('blast_radius_floor').notNull().default(5),

    // last_run metadata. Two-phase: `HrSyncService.run` sets started_at (and
    // clears the other three) when a run begins, then fills finished_at/
    // outcome/counts when it ends — so a crashed run is visible as "started,
    // never finished" rather than silently wearing the previous outcome.
    lastRunStartedAt: timestamp('last_run_started_at', { withTimezone: true }),
    lastRunFinishedAt: timestamp('last_run_finished_at', { withTimezone: true }),
    lastRunOutcome: hrRunOutcome('last_run_outcome'),
    /** Summary counts of the last run (toCreate/toUpdate/failed/..., plus `batchId` on a commit) — never row-level PII, never a secret. */
    lastRunCounts: jsonb('last_run_counts').$type<Record<string, unknown>>(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Names are unique PER ORGANIZATION, same reasoning as 0028/0030 made
    // usernames and business-role names per-tenant: a global unique name
    // would be an existence oracle across the tenant boundary.
    orgNameUnique: uniqueIndex('hr_sources_org_name_unique').on(table.organizationId, table.name),
    thresholdRange: check(
      'hr_sources_threshold_range',
      sql`${table.blastRadiusThreshold} BETWEEN 1 AND 100`,
    ),
    floorNonNegative: check('hr_sources_floor_non_negative', sql`${table.blastRadiusFloor} >= 0`),
    // Both halves of the auth pair or neither — a header name with no secret
    // to put in it (or vice versa) is always a misconfiguration.
    authPair: check(
      'hr_sources_auth_pair',
      sql`(${table.authHeaderName} IS NULL) = (${table.authSecretName} IS NULL)`,
    ),
    urlHttps: check('hr_sources_url_https', sql`${table.url} LIKE 'https://%'`),
  }),
)

export type HrSource = typeof hrSources.$inferSelect
