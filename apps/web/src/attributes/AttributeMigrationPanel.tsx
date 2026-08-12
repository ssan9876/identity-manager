import { useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { ApiError } from '../api/client'
import { useToast } from '../shell/ToastProvider'
import {
  commitAttributeMigration,
  previewAttributeMigration,
  type AttributeDataType,
  type AttributeDefinition,
  type AttributeMigrationReport,
} from './api'

const DATA_TYPE_LABEL: Record<AttributeDataType, string> = {
  string: 'Text',
  number: 'Number',
  boolean: 'Yes / no',
  date: 'Date',
  enum: 'Choice',
}

type PreviewPhase =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; report: AttributeMigrationReport }

type CommitPhase =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; report: AttributeMigrationReport }

/**
 * Changing a definition's `dataType`, as preview-then-commit — Milestone 8,
 * Tasks 8-10 rendered.
 *
 * WHY THIS IS NOT A FORM WITH A SAVE BUTTON. Every other field on a
 * definition is metadata; `dataType` is the one that REWRITES every value
 * already stored under this key in `users.attributes`. So it does not sit on
 * the edit form beside `label` — the API refuses it there outright, with a
 * message naming these two routes — and the console must not make a
 * directory-wide rewrite look like the same gesture as fixing a typo.
 *
 * WHAT THE CONSOLE DECIDES, WHICH IS ALMOST NOTHING. Whether a value can be
 * converted, whether the blast radius is tolerable, whether a preview still
 * authorises a commit: all three belong to the API, and all three are
 * re-derived inside the commit's own transaction against a locked row. This
 * component renders the report, disables one button, and hands the hash back
 * untouched. The single rule it applies locally — the disabled Commit button
 * — is a restatement of a refusal the API makes anyway; pressing through it
 * would earn a 400, never a partial migration.
 *
 * `appliesTo` IS PREVIEWABLE BUT DELIBERATELY NOT OFFERED. The API accepts it
 * in a preview and REFUSES it at commit: converting every value in
 * `users.attributes` and then pointing the definition at `groups.attributes`
 * orphans exactly what it just rewrote. A control whose commit can only ever
 * fail is a trap, so this panel changes the type and nothing else.
 */
export function AttributeMigrationPanel({
  definition,
  onDone,
  onCancel,
}: {
  definition: AttributeDefinition
  onDone: () => void
  onCancel: () => void
}) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const { showToast } = useToast()

  const [dataType, setDataType] = useState<AttributeDataType | ''>('')
  const [force, setForce] = useState(false)
  const [preview, setPreview] = useState<PreviewPhase>({ status: 'idle' })
  const [commit, setCommit] = useState<CommitPhase>({ status: 'idle' })

  const targets = (Object.keys(DATA_TYPE_LABEL) as AttributeDataType[]).filter(
    (candidate) => candidate !== definition.dataType,
  )

  /**
   * Any edit to the target type clears the report on screen. Not tidiness:
   * the hash authorises ONE change, and a stale report left beside a changed
   * dropdown invites an admin to read one migration's numbers and commit
   * another's.
   */
  function chooseDataType(next: AttributeDataType | '') {
    setDataType(next)
    setPreview({ status: 'idle' })
    setCommit({ status: 'idle' })
    setForce(false)
  }

  async function handlePreview() {
    if (accessToken === undefined || dataType === '') return
    setPreview({ status: 'loading' })
    setCommit({ status: 'idle' })
    try {
      const report = await previewAttributeMigration(accessToken, definition.id, { dataType })
      setPreview({ status: 'ready', report })
    } catch (cause) {
      setPreview({
        status: 'error',
        message:
          cause instanceof ApiError
            ? cause.message
            : 'Could not preview this change. Check your connection and try again.',
      })
    }
  }

  async function handleCommit() {
    if (accessToken === undefined || dataType === '' || preview.status !== 'ready') return
    setCommit({ status: 'loading' })
    try {
      const report = await commitAttributeMigration(
        accessToken,
        definition.id,
        { dataType },
        preview.report.previewHash,
        force ? { force: true } : {},
      )
      setCommit({ status: 'done', report })
      showToast(
        `${definition.key} is now ${DATA_TYPE_LABEL[dataType].toLowerCase()} — ${report.changedCount} of ${report.populationSize} stored value${report.populationSize === 1 ? '' : 's'} rewritten.`,
        report.changedCount > 0 ? 'warn' : 'neutral',
      )
    } catch (cause) {
      setCommit({
        status: 'error',
        message:
          cause instanceof ApiError
            ? cause.message
            : 'Could not commit this migration. Check your connection and try again.',
      })
    }
  }

  const report = preview.status === 'ready' ? preview.report : null
  const blocked = report !== null && report.unconvertible.length > 0
  const tripped = report !== null && report.blastRadius.tripped

  return (
    <div className="attr-migration" data-testid="attribute-migration-panel">
      <h3 className="attr-migration__heading">
        Change the type of <span className="mono">{definition.key}</span>
      </h3>
      <p className="attr-migration__intro">
        This rewrites every value already stored under this attribute. Nothing is written until you
        preview the change and commit it deliberately.
      </p>

      <div className="attr-migration__controls">
        <div className="field attr-migration__target">
          <label className="field__label" htmlFor="attr-migration-type">
            New type
          </label>
          <select
            id="attr-migration-type"
            className="select"
            value={dataType}
            disabled={commit.status === 'done'}
            onChange={(e) => chooseDataType(e.target.value as AttributeDataType | '')}
            data-testid="attribute-migration-type"
          >
            <option value="">
              Currently {DATA_TYPE_LABEL[definition.dataType].toLowerCase()} — choose a new type
            </option>
            {targets.map((candidate) => (
              <option key={candidate} value={candidate}>
                {DATA_TYPE_LABEL[candidate]}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn btn--secondary"
          disabled={dataType === '' || preview.status === 'loading' || commit.status === 'done'}
          data-loading={preview.status === 'loading' ? 'true' : undefined}
          onClick={() => void handlePreview()}
          data-testid="attribute-migration-preview"
        >
          <span className="btn__label">Preview</span>
          <span className="btn__spinner" aria-hidden="true" />
        </button>
      </div>

      {preview.status === 'error' && (
        <div className="error-panel" role="alert">
          <p className="error-panel__message" data-testid="attribute-migration-preview-error">
            {preview.message}
          </p>
          <button type="button" className="btn btn--secondary" onClick={() => void handlePreview()}>
            Try again
          </button>
        </div>
      )}

      {report !== null && commit.status !== 'done' && (
        <div className="attr-migration__report" data-testid="attribute-migration-report">
          <p className="attr-migration__safety" role="note">
            <strong>This is a preview only.</strong> Nothing has been written yet.
          </p>

          <dl className="detail-grid">
            <div>
              <dt>Holders</dt>
              <dd data-testid="attribute-migration-population">{report.populationSize}</dd>
            </div>
            <div>
              <dt>Values rewritten</dt>
              <dd data-testid="attribute-migration-changed">{report.changedCount}</dd>
            </div>
            <div>
              <dt>Blast radius</dt>
              <dd>
                {report.blastRadius.thresholdPercent}% of holders, floor {report.blastRadius.floor}
                {tripped ? ' — exceeded' : ''}
              </dd>
            </div>
          </dl>

          {blocked && (
            <section className="attr-migration__group">
              <h4 className="attr-migration__group-heading">
                Values that cannot be converted ({report.unconvertible.length}
                {report.unconvertible.length >= 50 ? '+' : ''})
              </h4>
              <p className="attr-migration__blocked-note">
                A migration that cannot convert every value is refused outright — never partially
                applied, and not overridable. Fix or clear these values on the people holding them,
                then preview again.
              </p>
              <div className="table-wrap">
                <table className="table" data-testid="attribute-migration-unconvertible">
                  <thead>
                    <tr>
                      <th scope="col">Person</th>
                      <th scope="col">Stored value</th>
                      <th scope="col">Why it cannot convert</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.unconvertible.map((entry) => (
                      <tr key={entry.userId} data-testid="attribute-migration-unconvertible-row">
                        <td className="mono cell-muted">{entry.userId}</td>
                        <td className="mono">{JSON.stringify(entry.value)}</td>
                        <td>{entry.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {tripped && !blocked && (
            <div className="attr-migration__force">
              <label className="attr-migration__check" htmlFor="attr-migration-force">
                <input
                  id="attr-migration-force"
                  type="checkbox"
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                  data-testid="attribute-migration-force"
                />
                <span>
                  This rewrites {report.blastRadius.changedCount} of{' '}
                  {report.blastRadius.populationSize} stored values, past the{' '}
                  {report.blastRadius.thresholdPercent}% guard. Commit anyway.
                </span>
              </label>
            </div>
          )}

          <div className="attr-migration__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={blocked || (tripped && !force) || commit.status === 'loading'}
              data-loading={commit.status === 'loading' ? 'true' : undefined}
              onClick={() => void handleCommit()}
              data-testid="attribute-migration-commit"
            >
              <span className="btn__label">
                {report.changedCount === 0
                  ? 'Commit — no stored value changes'
                  : `Commit — rewrite ${report.changedCount} value${report.changedCount === 1 ? '' : 's'}`}
              </span>
              <span className="btn__spinner" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={onCancel}
              disabled={commit.status === 'loading'}
            >
              Cancel
            </button>
          </div>

          {commit.status === 'error' && (
            <div className="error-panel" role="alert">
              <p className="error-panel__message" data-testid="attribute-migration-commit-error">
                {commit.message}
              </p>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => void handlePreview()}
              >
                Preview again
              </button>
            </div>
          )}
        </div>
      )}

      {commit.status === 'done' && (
        <div className="attr-migration__done" data-testid="attribute-migration-done">
          <p>
            <strong>Migrated.</strong> {commit.report.changedCount} of{' '}
            {commit.report.populationSize} stored value
            {commit.report.populationSize === 1 ? '' : 's'} rewritten. The previous values are
            recorded in the audit log.
          </p>
          <button type="button" className="btn btn--secondary" onClick={onDone}>
            Back to attributes
          </button>
        </div>
      )}

      {/* Every state that is NOT showing a report keeps a way out — including
          the error state, which previously offered "Try again" and nothing
          else, stranding an admin whose preview failed inside a panel with no
          exit but the browser's back button. */}
      {preview.status !== 'ready' && commit.status !== 'done' && (
        <div className="attr-migration__actions">
          <button
            type="button"
            className="btn btn--secondary"
            onClick={onCancel}
            disabled={preview.status === 'loading'}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
