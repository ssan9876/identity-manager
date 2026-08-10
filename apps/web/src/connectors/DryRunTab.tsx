import { useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { ApiError } from '../api/client'
import { ConfirmDialog } from '../shell/ConfirmDialog'
import { useToast } from '../shell/ToastProvider'
import { CONNECTOR_TARGET_LABEL, runReconcile, type ConnectorTarget, type TargetReconciliationReport } from './api'

type ReportState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; report: TargetReconciliationReport }

// A plan can, in principle, list every in-scope principal — capped here so
// the browser never has to render an unbounded table. The API's own
// summary counts (populationSize / changedCount) are never truncated, only
// this row-by-row detail.
const MAX_ROWS_SHOWN = 50

function PlanSummary({ report }: { report: TargetReconciliationReport }) {
  const changedCount = report.toMutate.length + report.toMutateGroups.length
  return (
    <dl className="detail-grid dry-run__summary">
      <div>
        <dt>In-scope population</dt>
        <dd data-testid="dry-run-population">{report.populationSize}</dd>
      </div>
      <div>
        <dt>Would change</dt>
        <dd data-testid="dry-run-changed-count">{changedCount}</dd>
      </div>
      <div>
        <dt>Already converged</dt>
        <dd>{Math.max(0, report.populationSize - changedCount)}</dd>
      </div>
      <div>
        <dt>Blast-radius guard</dt>
        <dd>
          {report.blastRadius.thresholdPercent}% threshold, floor {report.blastRadius.floor}
        </dd>
      </div>
    </dl>
  )
}

function PlanTable({ report }: { report: TargetReconciliationReport }) {
  if (report.toMutate.length === 0 && report.toMutateGroups.length === 0) {
    return <p className="cell-muted">Nothing to change — every in-scope principal already matches desired state.</p>
  }

  const shownUsers = report.toMutate.slice(0, MAX_ROWS_SHOWN)
  const shownGroups = report.toMutateGroups.slice(0, MAX_ROWS_SHOWN)
  const totalShown = shownUsers.length + shownGroups.length
  const totalListed = report.toMutate.length + report.toMutateGroups.length

  return (
    <div className="table-wrap dry-run__plan-table-wrap">
      <table className="table" data-testid="dry-run-plan-table">
        <thead>
          <tr>
            <th scope="col">Principal</th>
            <th scope="col">Kind</th>
            <th scope="col">What would change</th>
          </tr>
        </thead>
        <tbody>
          {shownUsers.map((principal) => (
            <tr key={principal.userId} data-testid="dry-run-plan-row">
              <td>{principal.username}</td>
              <td className="cell-muted">Person</td>
              <td>{principal.operations.map((op) => op.description).join('; ')}</td>
            </tr>
          ))}
          {shownGroups.map((group) => (
            <tr key={group.groupId} data-testid="dry-run-plan-row">
              <td>{group.name}</td>
              <td className="cell-muted">Group</td>
              <td>{group.operations.map((op) => op.description).join('; ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {totalListed > totalShown && (
        <p className="cell-muted dry-run__more-note">
          Showing the first {totalShown} of {totalListed}.
        </p>
      )}
    </div>
  )
}

/**
 * The Dry run tab of `/connectors/:target` — "run a reconcile plan for a
 * target and read it before anything applies. Same safety-rail idiom as the
 * import preview" (this task's own BUILD section). Two SEPARATE, deliberate
 * calls, never chained automatically (mirrors ImportPage's own
 * preview-then-commit split): a dry run always writes nothing, on the
 * server AND here — nothing in this component ever calls `runReconcile`
 * with `dryRun: false` except the explicit Apply/Override actions below,
 * each its own click.
 */
export function DryRunTab({
  target,
  canManage,
  organizationId,
  onApplied,
}: {
  target: ConnectorTarget
  canManage: boolean
  /** Per-organization connector targets: which organization's population and catalog this plan/apply covers. `undefined` means master. */
  organizationId?: string
  onApplied: () => void
}) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const { showToast } = useToast()

  const [dryRun, setDryRun] = useState<ReportState>({ status: 'idle' })
  const [apply, setApply] = useState<ReportState>({ status: 'idle' })
  const [overrideOpen, setOverrideOpen] = useState(false)

  async function handleDryRun() {
    if (accessToken === undefined) return
    setDryRun({ status: 'loading' })
    setApply({ status: 'idle' })
    try {
      const report = await runReconcile(accessToken, target, { dryRun: true }, organizationId)
      setDryRun({ status: 'ready', report })
    } catch (cause) {
      setDryRun({
        status: 'error',
        message: cause instanceof ApiError ? cause.message : 'Could not compute a plan. Check your connection and try again.',
      })
    }
  }

  async function handleApply(force: boolean) {
    if (accessToken === undefined) return
    setApply({ status: 'loading' })
    try {
      const report = await runReconcile(accessToken, target, { dryRun: false, force }, organizationId)
      setApply({ status: 'ready', report })
      setOverrideOpen(false)
      if (!report.halted) {
        const total = report.appliedCount + report.appliedGroupCount
        const failedTotal = report.failed.length + report.failedGroups.length
        showToast(
          `Applied ${total} change${total === 1 ? '' : 's'} to ${CONNECTOR_TARGET_LABEL[target]}.`,
          failedTotal > 0 ? 'warn' : 'neutral',
        )
        onApplied()
      }
    } catch (cause) {
      setApply({
        status: 'error',
        message: cause instanceof ApiError ? cause.message : 'Could not apply this reconcile. Check your connection and try again.',
      })
      setOverrideOpen(false)
    }
  }

  const alreadySucceeded = apply.status === 'ready' && !apply.report.halted

  return (
    <div className="dry-run">
      <p className="dry-run__intro">
        Compute what a reconcile against {CONNECTOR_TARGET_LABEL[target]} would do — read the plan before anything
        applies.
      </p>

      {dryRun.status === 'idle' && (
        <button type="button" className="btn btn--primary" onClick={() => void handleDryRun()} data-testid="dry-run-button">
          Run dry run
        </button>
      )}

      {dryRun.status === 'loading' && (
        <div aria-hidden="true">
          <span className="skeleton" style={{ width: '100%', height: '8rem', display: 'block' }} />
        </div>
      )}

      {dryRun.status === 'error' && (
        <div className="error-panel" role="alert">
          <p className="error-panel__message">{dryRun.message}</p>
          <button type="button" className="btn btn--secondary" onClick={() => void handleDryRun()}>
            Try again
          </button>
        </div>
      )}

      {dryRun.status === 'ready' && (
        <div className="dry-run__plan" data-testid="dry-run-plan">
          <p className="dry-run__safety-note" role="note" data-testid="dry-run-safety-note">
            <strong>This is a plan only.</strong> Nothing has been written to {CONNECTOR_TARGET_LABEL[target]} yet —
            review it below, then apply when you&rsquo;re ready.
          </p>

          <PlanSummary report={dryRun.report} />
          <PlanTable report={dryRun.report} />

          <div className="dry-run__actions">
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => void handleDryRun()}
              disabled={apply.status === 'loading'}
              data-testid="dry-run-recompute"
            >
              Recompute plan
            </button>
            {canManage && !alreadySucceeded && (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void handleApply(false)}
                disabled={apply.status === 'loading' || dryRun.report.toMutate.length + dryRun.report.toMutateGroups.length === 0}
                data-loading={apply.status === 'loading' ? 'true' : undefined}
                data-testid="dry-run-apply-button"
              >
                <span className="btn__label">
                  Apply — {dryRun.report.toMutate.length + dryRun.report.toMutateGroups.length} change
                  {dryRun.report.toMutate.length + dryRun.report.toMutateGroups.length === 1 ? '' : 's'}
                </span>
                <span className="btn__spinner" aria-hidden="true" />
              </button>
            )}
          </div>

          {apply.status === 'error' && (
            <div className="error-panel" role="alert">
              <p className="error-panel__message">{apply.message}</p>
            </div>
          )}

          {apply.status === 'ready' && apply.report.halted && (
            <div className="dry-run__halted" role="alert" data-testid="dry-run-halted">
              <p>
                <strong>Halted — nothing was applied.</strong> This run would change{' '}
                {apply.report.blastRadius.changedCount} of {apply.report.blastRadius.populationSize} principals,
                past both the {apply.report.blastRadius.thresholdPercent}% threshold and the{' '}
                {apply.report.blastRadius.floor}-principal floor.
              </p>
              {canManage && (
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={() => setOverrideOpen(true)}
                  data-testid="dry-run-override-button"
                >
                  Override and apply anyway
                </button>
              )}
            </div>
          )}

          {alreadySucceeded && (
            <div className="dry-run__result" data-testid="dry-run-result">
              <p>
                Applied {apply.report.appliedCount} of {apply.report.toMutate.length} person change
                {apply.report.toMutate.length === 1 ? '' : 's'}
                {apply.report.toMutateGroups.length > 0 && (
                  <>
                    {' '}
                    and {apply.report.appliedGroupCount} of {apply.report.toMutateGroups.length} group change
                    {apply.report.toMutateGroups.length === 1 ? '' : 's'}
                  </>
                )}
                .{apply.report.overridden && ' The blast-radius guard was overridden for this run.'}
              </p>
              {apply.report.failed.length + apply.report.failedGroups.length > 0 && (
                <p className="cell-muted">
                  {apply.report.failed.length + apply.report.failedGroups.length} individual failure(s) — every
                  other change still applied; a partial failure never blocks the rest.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={overrideOpen}
        title={`Override the blast-radius guard for ${CONNECTOR_TARGET_LABEL[target]}?`}
        confirmLabel="Override and apply"
        tone="danger"
        onConfirm={() => handleApply(true)}
        onDismiss={() => setOverrideOpen(false)}
        testId="dry-run-override-dialog"
      >
        <p>
          This bypasses the safety rail and applies every change the plan above lists, even though it exceeds the
          configured threshold. The override is recorded in the audit log.
        </p>
      </ConfirmDialog>
    </div>
  )
}
