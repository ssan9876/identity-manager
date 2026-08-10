import { useState, type FormEvent } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError } from '../api/client'
import { useOrgUnits } from '../org-units/OrgUnitsContext'
import { useSelfPermissions } from '../shell/permissions'
import { useToast } from '../shell/ToastProvider'
import {
  FIELD_LABEL,
  OPERATOR_LABEL,
  adoptMiningRecommendation,
  runRoleMining,
  type ConditionField,
  type ConditionOperator,
  type MiningCandidate,
  type MiningGroupRecommendation,
  type MiningPersonSample,
  type MiningReport,
  type RoleCondition,
} from './api'
import './MiningPage.css'

/** How many of a residual sample this page renders. The counts are always the true totals. */
const RESIDUAL_RENDER_LIMIT = 15

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(ratio === 1 ? 0 : 1)}%`
}

/**
 * One condition, in the words an admin uses — the same labels the
 * DefinitionEditor uses, with org-unit ids resolved to names where the
 * console knows them and ltree paths rendered mono.
 */
function ConditionPhrase({ condition }: { condition: RoleCondition }) {
  const orgUnits = useOrgUnits()
  const fieldLabel = FIELD_LABEL[condition.field as ConditionField] ?? condition.field
  const operatorLabel = OPERATOR_LABEL[condition.operator as ConditionOperator] ?? condition.operator

  let value: string
  let mono = false
  if (condition.operator === 'in_org_subtree' && typeof condition.value === 'string') {
    const unit =
      orgUnits.status === 'ready'
        ? orgUnits.list.find((candidate) => candidate.path === condition.value)
        : undefined
    value = unit !== undefined ? `${unit.name} (${condition.value})` : condition.value
    mono = unit === undefined
  } else if (condition.field === 'orgUnitId' && typeof condition.value === 'string') {
    value =
      orgUnits.status === 'ready'
        ? (orgUnits.byId.get(condition.value)?.name ?? condition.value)
        : condition.value
  } else {
    value = typeof condition.value === 'string' ? condition.value : JSON.stringify(condition.value)
  }

  return (
    <span className="mining__condition">
      <span className="mining__condition-field">{fieldLabel}</span> {operatorLabel}{' '}
      <span className={mono ? 'mono' : 'mining__condition-value'}>{value}</span>
    </span>
  )
}

function ResidualList({
  heading,
  tone,
  residual,
  emptyLine,
  testId,
}: {
  heading: string
  tone: 'gained' | 'lost'
  residual: MiningPersonSample
  emptyLine: string
  testId: string
}) {
  const shown = residual.sample.slice(0, RESIDUAL_RENDER_LIMIT)
  return (
    <div className={`mining__residual mining__residual--${tone}`} data-testid={testId}>
      <h5 className="mining__residual-heading">
        {heading} <span className="mining__residual-count">{residual.count}</span>
      </h5>
      {residual.count === 0 ? (
        <p className="mining__residual-empty">{emptyLine}</p>
      ) : (
        <>
          <ul className="mining__residual-people">
            {shown.map((person) => (
              <li key={person.userId}>
                <Link to={`/people/${person.userId}`} className="row-link">
                  {person.username}
                </Link>
              </li>
            ))}
          </ul>
          {(residual.truncated || residual.count > shown.length) && (
            <p className="mining__residual-more">
              Showing {shown.length} of {residual.count}. The count is the whole population; this
              list is a sample.
            </p>
          )}
        </>
      )}
    </div>
  )
}

function CandidateCard({
  group,
  candidate,
  index,
}: {
  group: MiningGroupRecommendation
  candidate: MiningCandidate
  index: number
}) {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const navigate = useNavigate()
  const { showToast } = useToast()

  const [adopting, setAdopting] = useState(false)
  const [draftName, setDraftName] = useState(`${group.groupName} — mined role`)
  const [submitting, setSubmitting] = useState(false)
  const [adoptError, setAdoptError] = useState<string | null>(null)

  async function handleAdopt(event: FormEvent) {
    event.preventDefault()
    if (accessToken === undefined) return
    const trimmed = draftName.trim()
    if (trimmed.length === 0) {
      setAdoptError('Give the role a name.')
      return
    }
    setSubmitting(true)
    setAdoptError(null)
    try {
      const role = await adoptMiningRecommendation(accessToken, {
        name: trimmed,
        description: `Mined from the manual membership of "${group.groupName}".`,
        groupId: group.groupId,
        conditions: candidate.conditions,
      })
      showToast(
        `Draft created — disabled, unpublished, nobody's access has changed. Simulate it before publishing.`,
      )
      navigate(`/business-roles/${role.id}`)
    } catch (cause) {
      setAdoptError(
        cause instanceof ApiError
          ? cause.message
          : 'Could not create the draft. Check your connection and try again.',
      )
      setSubmitting(false)
    }
  }

  return (
    <div className="mining__candidate" data-testid="mining-candidate">
      <div className="mining__candidate-head">
        <p className="mining__formula">
          Everyone where{' '}
          {candidate.conditions.map((condition, i) => (
            <span key={i}>
              {i > 0 && <span className="mining__and"> and </span>}
              <ConditionPhrase condition={condition} />
            </span>
          ))}
        </p>
        {!adopting && (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => setAdopting(true)}
            data-testid={`mining-adopt-${index}`}
          >
            Open as draft
          </button>
        )}
      </div>

      <dl className="mining__scores">
        <div className="mining__score">
          <dt>Precision</dt>
          <dd>{formatPercent(candidate.precision)}</dd>
          <p className="mining__score-hint">
            of the {candidate.cohortSize} people the formula matches are members today
          </p>
        </div>
        <div className="mining__score">
          <dt>Coverage</dt>
          <dd>{formatPercent(candidate.coverage)}</dd>
          <p className="mining__score-hint">
            of the group&rsquo;s {group.memberCount} manual members are matched
          </p>
        </div>
      </dl>

      <div className="mining__residuals">
        <ResidualList
          heading="Would newly gain the group"
          tone="gained"
          residual={candidate.gained}
          emptyLine="Nobody — the formula matches no one outside today's membership."
          testId="mining-gained"
        />
        <ResidualList
          heading="Members the formula does not describe"
          tone="lost"
          residual={candidate.lost}
          emptyLine="Nobody — every current member is described by the formula."
          testId="mining-lost"
        />
      </div>

      {adopting && (
        <form className="mining__adopt" onSubmit={(e) => void handleAdopt(e)}>
          <div className="field mining__adopt-name">
            <label className="field__label" htmlFor={`mining-draft-name-${group.groupId}-${index}`}>
              Role name
            </label>
            <input
              id={`mining-draft-name-${group.groupId}-${index}`}
              className="input"
              value={draftName}
              maxLength={255}
              disabled={submitting}
              onChange={(e) => setDraftName(e.target.value)}
            />
          </div>
          {adoptError !== null && (
            <p className="field__error" role="alert">
              {adoptError}
            </p>
          )}
          <div className="mining__adopt-actions">
            <button
              type="button"
              className="btn btn--secondary"
              disabled={submitting}
              onClick={() => {
                setAdopting(false)
                setAdoptError(null)
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={submitting}
              data-loading={submitting ? 'true' : undefined}
              data-testid="mining-adopt-submit"
            >
              <span className="btn__label">Create draft</span>
              <span className="btn__spinner" aria-hidden="true" />
            </button>
          </div>
        </form>
      )}
    </div>
  )
}

/**
 * `/business-roles/mining` — recommend candidate business-role formulas from
 * existing MANUAL group memberships.
 *
 * THE RESIDUALS ARE THE POINT. A recommendation is rendered with the exact
 * people it would newly grant and the exact members it fails to describe,
 * beside the scores — because a plausible-but-wrong formula is caught by a
 * human reading those two lists, not by a percentage. Running the analysis
 * writes nothing; the only action here creates a DISABLED draft that still
 * has to walk the same simulate → publish gate as any hand-written one.
 */
export default function MiningPage() {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const permissions = useSelfPermissions()
  const orgUnits = useOrgUnits()

  const canManage = permissions.status === 'ready' && permissions.actions.has('business_role:manage')

  const [minPrecision, setMinPrecision] = useState('90')
  const [minCoverage, setMinCoverage] = useState('80')
  const [scopeOrgUnitId, setScopeOrgUnitId] = useState('')
  const [report, setReport] = useState<MiningReport | null>(null)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)

  async function handleRun(event: FormEvent) {
    event.preventDefault()
    if (accessToken === undefined) return
    const precision = Number(minPrecision) / 100
    const coverage = Number(minCoverage) / 100
    if (!Number.isFinite(precision) || precision < 0 || precision > 1 || !Number.isFinite(coverage) || coverage < 0 || coverage > 1) {
      setRunError('Thresholds are percentages between 0 and 100.')
      return
    }

    setRunning(true)
    setRunError(null)
    try {
      const next = await runRoleMining(accessToken, {
        minPrecision: precision,
        minCoverage: coverage,
        scopeOrgUnitId: scopeOrgUnitId === '' ? null : scopeOrgUnitId,
      })
      setReport(next)
    } catch (cause) {
      setRunError(
        cause instanceof ApiError
          ? `Mining failed: ${cause.message}`
          : 'Mining failed. Check your connection and try again.',
      )
    } finally {
      setRunning(false)
    }
  }

  if (permissions.status === 'ready' && !canManage) {
    return (
      <div className="mining">
        <div className="page-header">
          <div className="page-header__text">
            <h1 className="text-title">Role mining</h1>
          </div>
        </div>
        <p className="cell-muted" data-testid="mining-permission-note">
          Role mining reads the whole directory&rsquo;s manual memberships cross-tabulated with
          everyone&rsquo;s attributes, so it requires the global business_role:manage permission —
          the same grant adopting a recommendation needs.
        </p>
      </div>
    )
  }

  return (
    <div className="mining">
      <div className="page-header">
        <div className="page-header__text">
          <h1 className="text-title">Role mining</h1>
          <p className="page-header__subtitle">
            Finds groups whose hand-granted membership already follows a pattern — a job title, a
            location, an org-unit subtree — and proposes that pattern as a business-role formula.
            Analysis only: nothing is applied. Adopting a proposal creates a disabled draft that
            still has to be simulated and published like any other.
          </p>
        </div>
        <Link to="/business-roles" className="btn btn--secondary">
          Back to roles
        </Link>
      </div>

      <form className="mining__controls" onSubmit={(e) => void handleRun(e)} data-testid="mining-controls">
        <div className="field mining__threshold">
          <label className="field__label" htmlFor="mining-precision">
            Min precision %
          </label>
          <input
            id="mining-precision"
            className="input"
            inputMode="numeric"
            value={minPrecision}
            disabled={running}
            onChange={(e) => setMinPrecision(e.target.value)}
          />
          <p className="mining__control-hint">How exclusive the match must be</p>
        </div>
        <div className="field mining__threshold">
          <label className="field__label" htmlFor="mining-coverage">
            Min coverage %
          </label>
          <input
            id="mining-coverage"
            className="input"
            inputMode="numeric"
            value={minCoverage}
            disabled={running}
            onChange={(e) => setMinCoverage(e.target.value)}
          />
          <p className="mining__control-hint">How much of the group it must explain</p>
        </div>
        <div className="field mining__scope">
          <label className="field__label" htmlFor="mining-scope">
            Scope to org unit
          </label>
          <select
            id="mining-scope"
            className="input"
            value={scopeOrgUnitId}
            disabled={running || orgUnits.status !== 'ready'}
            onChange={(e) => setScopeOrgUnitId(e.target.value)}
          >
            <option value="">Whole directory</option>
            {orgUnits.status === 'ready' &&
              [...orgUnits.list]
                .sort((a, b) => (a.path < b.path ? -1 : 1))
                .map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.path}
                  </option>
                ))}
          </select>
          <p className="mining__control-hint">People and memberships outside it are ignored</p>
        </div>
        <div className="mining__run">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={running || accessToken === undefined}
            data-loading={running ? 'true' : undefined}
            data-testid="mining-run"
          >
            <span className="btn__label">Run analysis</span>
            <span className="btn__spinner" aria-hidden="true" />
          </button>
        </div>
      </form>

      {runError !== null && (
        <div className="banner banner--error" role="alert" data-testid="mining-error">
          {runError}
        </div>
      )}

      {running && report === null ? (
        <div className="mining__skeletons" aria-hidden="true">
          <span className="skeleton" style={{ width: '100%', height: '4rem', display: 'block' }} />
          <span className="skeleton" style={{ width: '80%', height: '1rem', display: 'block' }} />
          <span className="skeleton" style={{ width: '60%', height: '1rem', display: 'block' }} />
        </div>
      ) : report === null ? (
        <p className="cell-muted" data-testid="mining-idle">
          No analysis yet. Running one is read-only — it changes nobody&rsquo;s access.
        </p>
      ) : (
        <>
          <p className="mining__summary" data-testid="mining-summary">
            Examined {report.scannedUsers.toLocaleString()} people,{' '}
            {report.manualMemberships.toLocaleString()} manual memberships across{' '}
            {report.groupsExamined.toLocaleString()} groups —{' '}
            {report.recommendations.length === 0
              ? 'no group cleared the thresholds.'
              : `${report.recommendations.length} ${
                  report.recommendations.length === 1 ? 'group has' : 'groups have'
                } a candidate formula.`}
          </p>

          {report.recommendations.map((group) => (
            <section key={group.groupId} className="mining__group" data-testid="mining-group">
              <div className="mining__group-head">
                <h3 className="mining__group-name">{group.groupName}</h3>
                <span className="cell-muted">
                  {group.memberCount} manual {group.memberCount === 1 ? 'member' : 'members'}
                </span>
              </div>
              {group.candidates.map((candidate, index) => (
                <CandidateCard key={index} group={group} candidate={candidate} index={index} />
              ))}
            </section>
          ))}
        </>
      )}
    </div>
  )
}
