import { AuditWriter } from '../audit/audit.writer'
import { PermissionEngine } from '../authz/permission.engine'
import { loadEnv } from '../config/env'
import { createDbClient } from '../db/client'
import type { AttributeDataType } from './attribute-conversion'
import {
  AttributeMigrationJob,
  type AttributeMigrationChange,
  type AttributeMigrationReport,
} from './attribute-migration.job'

const DATA_TYPES = ['string', 'number', 'boolean', 'date', 'enum'] as const
const APPLIES_TO = ['user', 'group'] as const

const USAGE =
  'usage: pnpm --filter @idm/api run attribute-migrate -- <definition-id> --actor=<username> ' +
  '[--data-type=<string|number|boolean|date|enum>] [--applies-to=<user|group>] ' +
  '[--commit --preview-hash=<hash> [--force]]'

interface ParsedArgs {
  definitionId: string
  actorUsername: string
  change: AttributeMigrationChange
  commit: boolean
  previewHash: string | null
  force: boolean
}

/**
 * `process.argv.slice(2)`, filtering out a literal `"--"` token — the same
 * defensive shape `role-reconcile-cli.ts`, `hr-sync-cli.ts` and
 * `target-reconcile-cli.ts` all document (pnpm's own arg forwarding can
 * deliver `['--', ...]` rather than stripping it).
 *
 * DRY RUN IS THE DEFAULT. Without `--commit` this runs `preview` and prints
 * the report; the same posture as `hr:sync`'s `--commit` and `activate`'s
 * `--apply`, and for a stronger reason than either — a `dataType` migration
 * overwrites values in `users.attributes` in place, so the default has to be
 * the half that writes nothing.
 *
 * `--actor=<username>` is REQUIRED, as it is for `hr:sync`: the migration
 * writes an audit row, and there is deliberately no anonymous or system
 * actor for an operation that rewrites stored values across the whole
 * directory. The username is resolved to a real, ACTIVE local user and its
 * real role assignments, so a CLI invocation holds exactly the authority
 * that human holds and is not an escalation path.
 *
 * `--preview-hash=` is REQUIRED WITH `--commit`, and that is this CLI's one
 * deliberate departure from the plainest reading of the plan. The obvious
 * shape — `--commit` takes its own fresh preview and immediately commits it
 * — would let this CLI mint its own authorisation, which is precisely the
 * guard the HTTP route enforces by refusing a commit with no hash (400).
 * A CLI that could route around it would not be a convenience, it would be
 * the hole. So the flow is two invocations: run it dry, READ the report, then
 * re-run with the hash it printed. The dry run prints the exact command.
 */
function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.filter((arg) => arg !== '--')
  let definitionId: string | null = null
  let actorUsername: string | null = null
  let dataType: AttributeDataType | undefined
  let appliesTo: 'user' | 'group' | undefined
  let commit = false
  let previewHash: string | null = null
  let force = false

  for (const arg of args) {
    if (arg === '--commit') {
      commit = true
      continue
    }
    if (arg === '--force') {
      force = true
      continue
    }
    if (arg.startsWith('--actor=')) {
      actorUsername = arg.slice('--actor='.length)
      continue
    }
    if (arg.startsWith('--preview-hash=')) {
      previewHash = arg.slice('--preview-hash='.length)
      continue
    }
    if (arg.startsWith('--data-type=')) {
      const value = arg.slice('--data-type='.length)
      if (!isDataType(value)) {
        throw new Error(
          `attribute-migrate: --data-type must be one of ${DATA_TYPES.join(', ')} (got "${value}")`,
        )
      }
      dataType = value
      continue
    }
    if (arg.startsWith('--applies-to=')) {
      const value = arg.slice('--applies-to='.length)
      if (!isAppliesTo(value)) {
        throw new Error(
          `attribute-migrate: --applies-to must be one of ${APPLIES_TO.join(', ')} (got "${value}")`,
        )
      }
      appliesTo = value
      continue
    }
    if (arg.startsWith('--')) {
      throw new Error(`attribute-migrate: unrecognized argument "${arg}"\n${USAGE}`)
    }
    if (definitionId !== null) {
      throw new Error(
        `attribute-migrate: more than one definition given ("${definitionId}" and "${arg}")`,
      )
    }
    definitionId = arg
  }

  if (definitionId === null) {
    throw new Error(`attribute-migrate: an attribute definition id is required\n${USAGE}`)
  }
  if (actorUsername === null || actorUsername.length === 0) {
    throw new Error(
      'attribute-migrate: --actor=<username> is required — every migration is attributed to a ' +
        'real user, and its audit row is the only record of the values it overwrites',
    )
  }
  // Refused HERE as well as in the job, because the message an operator needs
  // at the CLI is about the flags, not about the change object.
  if (dataType === undefined && appliesTo === undefined) {
    throw new Error(
      `attribute-migrate: name a change — --data-type=, --applies-to=, or both\n${USAGE}`,
    )
  }
  if (commit && (previewHash === null || previewHash.length === 0)) {
    throw new Error(
      'attribute-migrate: --commit requires --preview-hash=<hash> from a dry run of this exact ' +
        'change. Run it without --commit first, read the report, then re-run with the hash it ' +
        'printed — the hash is what keeps the report a human approved and the migration that ' +
        'actually runs the same event, and it is the same requirement the HTTP route enforces.',
    )
  }
  if (!commit && previewHash !== null) {
    throw new Error(
      'attribute-migrate: --preview-hash= has no meaning without --commit — a dry run MINTS a ' +
        'hash, it does not consume one',
    )
  }

  return { definitionId, actorUsername, change: { dataType, appliesTo }, commit, previewHash, force }
}

function isDataType(value: string): value is AttributeDataType {
  return (DATA_TYPES as readonly string[]).includes(value)
}

function isAppliesTo(value: string): value is 'user' | 'group' {
  return (APPLIES_TO as readonly string[]).includes(value)
}

/**
 * The report, as an operator reads it before deciding.
 *
 * The unconvertible sample is printed in full up to the job's own
 * `MAX_UNCONVERTIBLE_SAMPLE` bound, because it is the list the operator has
 * to go and fix. For a `sensitive` definition the job has already replaced
 * every value and every reason in that sample with its redaction text — see
 * `REDACTED_SENSITIVE_VALUE` — so this function cannot print a sensitive
 * value even by accident; it never sees one.
 */
function printReport(report: AttributeMigrationReport): void {
  console.log(
    `[attribute-migrate] population: ${report.populationSize} holder(s); this change would ` +
      `rewrite ${report.changedCount}`,
  )

  const blast = report.blastRadius
  console.log(
    `[attribute-migrate] blast radius: ${blast.changedCount}/${blast.populationSize} ` +
      `(threshold ${blast.thresholdPercent}%, floor ${blast.floor})` +
      (blast.tripped ? ' — TRIPPED, --force required to commit' : ''),
  )

  if (report.unconvertible.length > 0) {
    console.error(
      `[attribute-migrate] ${report.unconvertible.length} stored value(s) CANNOT be converted. ` +
        'A commit will refuse while any of these stand, and --force does not override it:',
    )
    for (const entry of report.unconvertible) {
      console.error(
        `[attribute-migrate]   user ${entry.userId}: ${JSON.stringify(entry.value)} — ${entry.reason}`,
      )
    }
  }
}

/**
 * The runtime entrypoint for `pnpm --filter @idm/api run attribute-migrate` —
 * Milestone 8, Task 10. Mirrors `hr-sync-cli.ts` and `role-reconcile-cli.ts`
 * exactly: a plain `tsx` script wiring the job's dependencies by hand (a CLI
 * must not boot the HTTP app to run one pass), connecting as the RUNTIME role
 * (finding H1, docs/archive/audits/audit-integrity.md) because every write it
 * makes — user rows and one audit row — is ordinary DML that role already
 * holds.
 *
 * THE PERMISSION CHECK IS NOT OPTIONAL HERE. `AttributeMigrationJob` performs
 * no authorisation of its own — on the HTTP path that is `PermissionGuard`
 * plus the controller's `requireGlobalManageGrant`, and there is no guard on
 * this path at all. Without the identical check below, `--actor=<anyone>`
 * would run a directory-wide value rewrite attributed to a person who holds
 * no such authority, which is exactly the escalation `hr-sync-cli.ts` says a
 * CLI invocation must not be. A GLOBAL grant, for the reason the controller
 * gives: `attribute_definitions` has no org unit to narrow a grant to, and
 * the walk crosses every org unit in the deployment.
 */
async function main(): Promise<void> {
  const { definitionId, actorUsername, change, commit, previewHash, force } = parseArgs(
    process.argv.slice(2),
  )
  const env = loadEnv(process.env)
  const { db, pool } = createDbClient(env.runtimeDatabaseUrl, { max: env.dbPoolMax })

  try {
    const engine = new PermissionEngine(db)
    const job = new AttributeMigrationJob(db, new AuditWriter())

    const actor = await engine.resolveActor({
      subject: 'cli:attribute-migrate',
      username: actorUsername,
      email: null,
    })
    // `null` means a global grant; `[]` means no grant at all, and both are
    // refused by the same comparison. Same idiom as
    // `AttributeDefinitionsController.requireGlobalManageGrant`.
    const scopePaths = await engine.scopePathsFor(actor, 'attribute:manage')
    if (scopePaths !== null) {
      throw new Error(
        `attribute-migrate: ${actorUsername} does not hold a GLOBAL grant of attribute:manage. ` +
          'An attribute definition is directory-wide schema with no org unit to narrow it to, ' +
          'and this migration rewrites stored values in every organization.',
      )
    }

    const described = [
      change.dataType === undefined ? null : `dataType -> ${change.dataType}`,
      change.appliesTo === undefined ? null : `appliesTo -> ${change.appliesTo}`,
    ]
      .filter((part): part is string => part !== null)
      .join(', ')

    console.log(
      `[attribute-migrate] definition ${definitionId}: ${described} — ` +
        `${commit ? 'COMMIT' : 'dry run'}, as ${actor.username}`,
    )

    if (!commit) {
      const report = await job.preview(definitionId, change)
      printReport(report)
      console.log(
        '[attribute-migrate] DRY RUN — nothing was written. Read the report above, then re-run:',
      )
      console.log(
        `[attribute-migrate]   pnpm --filter @idm/api run attribute-migrate -- ${definitionId} ` +
          `--actor=${actorUsername}` +
          (change.dataType === undefined ? '' : ` --data-type=${change.dataType}`) +
          (change.appliesTo === undefined ? '' : ` --applies-to=${change.appliesTo}`) +
          ` --commit --preview-hash=${report.previewHash}` +
          (report.blastRadius.tripped ? ' --force' : ''),
      )
      return
    }

    // `previewHash` is non-null here — `parseArgs` refuses `--commit`
    // without it — but the job's signature takes a `string`, so narrow
    // rather than assert.
    const report = await job.commit(definitionId, change, previewHash ?? '', {
      force,
      actorUserId: actor.userId,
    })
    printReport(report)
    console.log(
      `[attribute-migrate] COMMITTED — ${report.changedCount} stored value(s) converted` +
        (force && report.blastRadius.tripped ? ', blast-radius guard overridden with --force' : '') +
        '. The audit row carries every prior value; it is what makes this reversible.',
    )
  } finally {
    await pool.end()
  }
}

main()
  .then(() => {
    console.log('[attribute-migrate] done.')
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[attribute-migrate] failed: ${message}`)
    process.exitCode = 1
  })
