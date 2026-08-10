import { Inject, Injectable, Optional } from '@nestjs/common'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { AuditWriter } from '../audit/audit.writer'
import type { Actor } from '../authz/permission.engine'
import { PermissionEngine } from '../authz/permission.engine'
import type { AuthorizedRequest } from '../authz/permission.guard'
import { PrivilegeGuards } from '../authz/privilege.guards'
import { DB_CLIENT } from '../common/db.token'
import { DomainError, NotFoundError, ValidationError } from '../common/errors'
import type { HrSource } from '../db/schema/hr-sources'
import * as schema from '../db/schema/index'
import {
  IMPORTS_CONFIG,
  ImportsController,
  type ImportCommitResponse,
  type ImportPreviewResponse,
  type ImportsConfig,
} from '../imports/imports.controller'
import { OrgUnitsRepository } from '../org-units/org-units.repository'
import { OutboxWriter } from '../outbox/outbox.writer'
import type { BlastRadiusEvaluation } from '../outbox/target-reconciliation.job'
import { UsersRepository } from '../users/users.repository'
import { evaluateHrRun, mapFeedCsv, mapJsonFeed, parseJsonFeedConfig } from './hr-feed'
import { DEFAULT_HR_FETCH_MAX_BYTES, fetchFeedCsv, fetchFeedJson } from './hr-fetch'
import { HrSourcesRepository, type HrRunOutcome } from './hr-sources.repository'

/** DI token for `HrSyncConfig` — same reasoning as IMPORTS_CONFIG (a plain TS interface erases at runtime). */
export const HR_SYNC_CONFIG = Symbol('HR_SYNC_CONFIG')

export interface HrSyncConfig {
  /** Byte ceiling on a fetched feed body — see hr-fetch.ts's DEFAULT_HR_FETCH_MAX_BYTES for why a PULLED feed must self-bound. */
  maxFetchBytes: number
  /**
   * Test seam ONLY (test/hr-sync.spec.ts routes the source's https URL to a
   * local `node:http` fixture through this): the URL/https validation and
   * the streaming byte cap in `fetchFeedCsv` still run unchanged around
   * whatever is passed here — production never sets it.
   */
  fetchImpl?: typeof fetch
}

const DEFAULT_HR_SYNC_CONFIG: HrSyncConfig = { maxFetchBytes: DEFAULT_HR_FETCH_MAX_BYTES }

/**
 * What one FETCH phase produced, before any mapping. Kept as a union rather
 * than collapsing both kinds to CSV inside the fetch step, because the two
 * phases must keep reporting DIFFERENT outcomes: a transport problem is
 * `fetch_failed` ("nothing was previewed"), while a mapping that does not fit
 * the feed is `preview_failed`. Collapsing them would relabel every
 * bad-mapping run as an upstream outage and send an operator hunting for a
 * network fault that does not exist.
 */
type FeedPayload =
  | { kind: 'csv_url'; text: string }
  | { kind: 'rest_json'; records: readonly unknown[] }

interface FeedLoader {
  /** Network phase. Anything thrown here is recorded as `fetch_failed`. */
  fetch(source: HrSource, config: HrSyncConfig): Promise<FeedPayload>
  /** Pure transform to the import pipeline's CSV. Anything thrown here is recorded as `preview_failed`. */
  toCsv(payload: FeedPayload, source: HrSource): string
}

/** Both kinds resolve their credential the same way — a header name plus the NAME of a `CONNECTOR_*` environment variable, or nothing at all. */
function authFor(source: HrSource) {
  return source.authHeaderName !== null && source.authSecretName !== null
    ? { headerName: source.authHeaderName, secretName: source.authSecretName }
    : null
}

/**
 * Source kind -> how to read it. `Object.create(null)` plus `Object.hasOwn`
 * before indexing (see `loaderFor`), never a bare lookup: `source.kind` is
 * read back out of a Postgres enum column, and "a Postgres enum column can
 * hold any label a migration ever added, past or future"
 * (jml/rule-engine.ts) — the same prototype-chain-bypass hazard
 * `ConnectorRegistry.factories` documents at length, for the same reason.
 * `hr_source_kind`'s own doc comment states the rule this satisfies:
 * dispatch through an allowlisted lookup, never Drizzle's compile-time-only
 * typing.
 *
 * The `satisfies` on the literal is what makes a newly-added kind a COMPILE
 * error here rather than a runtime "unsupported source kind" in production.
 */
const FEED_LOADERS: Record<HrSource['kind'], FeedLoader> = Object.assign(
  Object.create(null) as Record<HrSource['kind'], FeedLoader>,
  {
    csv_url: {
      async fetch(source: HrSource, config: HrSyncConfig): Promise<FeedPayload> {
        return {
          kind: 'csv_url',
          text: await fetchFeedCsv(source.url, {
            auth: authFor(source),
            maxBytes: config.maxFetchBytes,
            fetchImpl: config.fetchImpl,
          }),
        }
      },
      toCsv(payload: FeedPayload, source: HrSource): string {
        // Narrowing, not a cast: `run` always pairs a payload with the
        // loader that produced it, and this keeps that invariant checkable.
        if (payload.kind !== 'csv_url') throw new Error('feed payload/kind mismatch')
        return mapFeedCsv(payload.text, source.columnMapping)
      },
    },
    rest_json: {
      async fetch(source: HrSource, config: HrSyncConfig): Promise<FeedPayload> {
        const feedConfig = parseJsonFeedConfig(source.config)
        return {
          kind: 'rest_json',
          records: await fetchFeedJson(source.url, {
            auth: authFor(source),
            maxBytes: config.maxFetchBytes,
            fetchImpl: config.fetchImpl,
            recordsPath: feedConfig.recordsPath,
            pagination: feedConfig.pagination,
          }),
        }
      },
      toCsv(payload: FeedPayload, source: HrSource): string {
        if (payload.kind !== 'rest_json') throw new Error('feed payload/kind mismatch')
        return mapJsonFeed(payload.records, source.columnMapping)
      },
    },
  } satisfies Record<HrSource['kind'], FeedLoader>,
)

/** Resolves a source's loader, refusing an unrecognised kind loudly rather than defaulting to CSV — a target absent from the catalog must never be silently misprocessed as another one (the exact failure mode `ConnectorRegistry.resolve` refuses for connectors). */
function loaderFor(source: HrSource): FeedLoader {
  if (!Object.hasOwn(FEED_LOADERS, source.kind)) {
    throw new ValidationError([
      `source: unsupported feed kind "${source.kind}" — supported kinds: ${Object.keys(FEED_LOADERS).join(', ')}`,
    ])
  }
  return FEED_LOADERS[source.kind]
}

export interface HrSyncOptions {
  /** `false` (the default posture everywhere this is invoked): preview only, write nothing about any user. */
  commit: boolean
  /** Commit the non-failing rows even though some rows failed the preview. */
  allowPartial?: boolean
  /** Proceed even though the blast-radius guard tripped. */
  force?: boolean
  /** The human this run acts AS — the import pipeline's own per-row scope checks run against this actor, and every audit row names them. Never a system default: an HR sync writes people, and people-writes are attributed. */
  actor: Actor
}

export interface HrSyncReport {
  sourceId: string
  sourceName: string
  outcome: HrRunOutcome
  /** Present whenever the feed was fetched and previewed (every outcome except fetch_failed/preview_failed). */
  preview: ImportPreviewResponse | null
  blastRadius: BlastRadiusEvaluation | null
  /** Why an aborted run aborted — empty on success. */
  reasons: string[]
  /** Present only when a commit actually ran. */
  commit: ImportCommitResponse | null
  /** The commit's batchId — the handle every audit row of the batch shares. */
  batchId: string | null
}

/**
 * Pull-based HR sync: fetch a source's CSV over HTTPS, apply its column
 * mapping, and hand the result to the EXISTING import pipeline UNCHANGED.
 *
 * This class is a FRONT DOOR, not a fork: it constructs a real
 * `ImportsController` from the same collaborators AppModule wires into the
 * HTTP one and calls its actual `preview`/`commit` methods — the same
 * technique test/imports.write.spec.ts uses — so every row resolves through
 * `resolveRow` with identical semantics (idempotent on employeeId, one
 * batchId per commit, per-row scope checks against the acting user, one
 * audit row per mutation, no-op update suppression). Nothing about the
 * resolver is duplicated here; if the pipeline's behaviour changes, this
 * front door inherits it.
 *
 * PREVIEW-FIRST IS STRUCTURAL: `run` always previews; a commit happens only
 * after `evaluateHrRun` (hr-feed.ts, pure) passes both rails — zero failing
 * rows (unless allow-partial) and the blast-radius guard (percentage AND
 * floor, the exact `evaluateBlastRadius` the reconcile job uses). A refused
 * run reports and records its outcome; it never half-applies.
 *
 * There is deliberately NO scheduler here — `hr:sync` is an on-demand CLI
 * (hr-sync-cli.ts) exactly like jml:lifecycle and reconcile; the operator
 * owns the cadence.
 */
@Injectable()
export class HrSyncService {
  private readonly config: HrSyncConfig
  private readonly imports: ImportsController

  constructor(
    @Inject(HrSourcesRepository) private readonly sources: HrSourcesRepository,
    @Inject(UsersRepository) users: UsersRepository,
    @Inject(OrgUnitsRepository) orgUnits: OrgUnitsRepository,
    @Inject(PermissionEngine) engine: PermissionEngine,
    @Inject(PrivilegeGuards) privileges: PrivilegeGuards,
    @Inject(AuditWriter) private readonly auditWriter: AuditWriter,
    @Inject(OutboxWriter) outbox: OutboxWriter,
    @Inject(DB_CLIENT) private readonly db: NodePgDatabase<typeof schema>,
    @Optional() @Inject(IMPORTS_CONFIG) importsConfig?: Partial<ImportsConfig>,
    @Optional() @Inject(HR_SYNC_CONFIG) config?: Partial<HrSyncConfig>,
  ) {
    this.config = { ...DEFAULT_HR_SYNC_CONFIG, ...config }
    // The SAME constructor call AppModule performs for the HTTP controller,
    // with the SAME row cap (IMPORTS_CONFIG) — a pulled feed obeys the
    // exact limits a pushed file does.
    this.imports = new ImportsController(
      users,
      orgUnits,
      engine,
      privileges,
      this.auditWriter,
      outbox,
      this.db,
      importsConfig,
    )
  }

  /**
   * One sync run against one source. Every terminal state — including every
   * refusal — is recorded twice: on the source row (`last_run_*`, the
   * console's health view) and as one append-only `hr_source:sync` audit
   * row (the run history), both in the same transaction. Counts only, never
   * row-level PII and never anything credential-shaped.
   */
  async run(source: HrSource, options: HrSyncOptions): Promise<HrSyncReport> {
    if (options.commit && !source.enabled) {
      throw new ValidationError([
        `source: "${source.name}" is disabled — preview runs are allowed, but enable it before committing`,
      ])
    }

    await this.sources.recordRunStarted(source.id)

    // ------------------------------------------------------------------ fetch
    // Kind-dispatched through the allowlisted `FEED_LOADERS` catalog — the
    // ONLY place this service branches on `source.kind`. Everything after
    // this point is identical for every feed kind, which is what keeps a new
    // kind from becoming a second code path through the parts that write to
    // people.
    let payload: FeedPayload
    let loader: FeedLoader
    try {
      loader = loaderFor(source)
      payload = await loader.fetch(source, this.config)
    } catch (error) {
      return this.finishFailed(source, options, 'fetch_failed', error)
    }

    // -------------------------------------------------------- map + preview
    let preview: ImportPreviewResponse
    try {
      const csv = loader.toCsv(payload, source)
      preview = await this.imports.preview({ csv }, this.asRequest(options.actor))
    } catch (error) {
      return this.finishFailed(source, options, 'preview_failed', error)
    }

    const populationSize = await this.sources.countUsersInOrganization(source.organizationId)
    const decision = evaluateHrRun(preview, populationSize, source, {
      allowPartial: options.allowPartial,
      force: options.force,
    })

    // ------------------------------------------------------------ dry run
    if (!options.commit) {
      const report: HrSyncReport = {
        sourceId: source.id,
        sourceName: source.name,
        outcome: 'previewed',
        preview,
        blastRadius: decision.blastRadius,
        reasons: decision.reasons,
        commit: null,
        batchId: null,
      }
      await this.finish(source, options, report)
      return report
    }

    // ------------------------------------------------------------- guards
    if (decision.abort !== null) {
      const report: HrSyncReport = {
        sourceId: source.id,
        sourceName: source.name,
        outcome: decision.abort,
        preview,
        blastRadius: decision.blastRadius,
        reasons: decision.reasons,
        commit: null,
        batchId: null,
      }
      await this.finish(source, options, report)
      return report
    }

    // ------------------------------------------------------------- commit
    // The SAME mapped csv the preview ran on — re-resolved by `commit`
    // itself (both routes share resolveRow), exactly as a human operator
    // pressing "commit" after "preview" re-resolves through the HTTP API.
    // Re-mapped from the SAME already-fetched payload, so this is never a
    // second trip to the upstream: a feed that changed between preview and
    // commit must not be what gets committed.
    const csv = loader.toCsv(payload, source)
    const commit = await this.imports.commit({ csv }, this.asRequest(options.actor))

    const report: HrSyncReport = {
      sourceId: source.id,
      sourceName: source.name,
      outcome: commit.failed > 0 ? 'committed_partial' : 'committed',
      preview,
      blastRadius: decision.blastRadius,
      reasons: decision.reasons,
      commit,
      batchId: commit.batchId,
    }
    await this.finish(source, options, report)
    return report
  }

  /** Convenience for callers holding only an id — the HTTP route and the CLI both resolve-then-run. */
  async runById(sourceId: string, options: HrSyncOptions): Promise<HrSyncReport> {
    const source = await this.sources.findById(sourceId)
    if (source === null) {
      throw new NotFoundError('HR source', sourceId)
    }
    return this.run(source, options)
  }

  /**
   * `preview`/`commit` read exactly one thing off the request object: the
   * resolved actor. Constructing the narrow shape directly is the same
   * technique every controller spec in this suite uses — no HTTP layer, no
   * fake JWT, the REAL permission checks still run against the real actor.
   */
  private asRequest(actor: Actor): AuthorizedRequest {
    return { actor } as AuthorizedRequest
  }

  /**
   * A fetch/preview-stage failure: record the outcome with the error's own
   * (never-credential-bearing — see hr-fetch.ts) reasons, then rethrow a
   * DomainError so the caller still gets its normal 400/404 mapping.
   * Anything that is NOT a DomainError is a genuine bug and is rethrown
   * verbatim AFTER the outcome is recorded — the record must survive either
   * way, or a crashing feed looks permanently "running".
   */
  private async finishFailed(
    source: HrSource,
    options: HrSyncOptions,
    outcome: 'fetch_failed' | 'preview_failed',
    error: unknown,
  ): Promise<never> {
    const reasons =
      error instanceof ValidationError
        ? error.issues
        : error instanceof DomainError
          ? [error.message]
          : ['an unexpected error occurred during this run']

    const report: HrSyncReport = {
      sourceId: source.id,
      sourceName: source.name,
      outcome,
      preview: null,
      blastRadius: null,
      reasons,
      commit: null,
      batchId: null,
    }
    await this.finish(source, options, report)
    throw error
  }

  /** The one terminal write: last_run_* on the source row plus one append-only `hr_source:sync` audit row, same transaction. */
  private async finish(source: HrSource, options: HrSyncOptions, report: HrSyncReport): Promise<void> {
    const counts: Record<string, unknown> = {
      dryRun: !options.commit,
      reasons: report.reasons,
      ...(report.preview !== null ? { ...report.preview.summary } : {}),
      ...(report.commit !== null
        ? {
            created: report.commit.created,
            updated: report.commit.updated,
            unchanged: report.commit.unchanged,
            commitFailed: report.commit.failed,
          }
        : {}),
      ...(report.batchId !== null ? { batchId: report.batchId } : {}),
    }

    await this.db.transaction(async (tx) => {
      await this.sources.recordRunFinished(tx, source.id, { outcome: report.outcome, counts })
      await this.auditWriter.record(tx, {
        actorUserId: options.actor.userId,
        action: 'hr_source:sync',
        resourceType: 'hr_source',
        resourceId: source.id,
        before: null,
        after: { sourceName: source.name, outcome: report.outcome, ...counts },
        batchId: report.batchId,
      })
    })
  }
}
