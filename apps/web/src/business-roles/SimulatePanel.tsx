import { useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { Link } from 'react-router-dom'
import { useGroups } from '../groups/GroupsContext'
import { useOrgUnits } from '../org-units/OrgUnitsContext'
import { CONNECTOR_TARGET_LABEL } from '../connectors/api'
import { fetchPeopleByIds, type Person } from '../people/api'
import type { SimulationEntry, SimulationReport } from './api'
import './SimulatePanel.css'

/**
 * How many of each list this panel renders, and therefore how many people it
 * resolves to real names. The API already caps its own sample at 500 per
 * side; rendering all of those would be a wall nobody reads, and resolving
 * them would be several id-batch round trips for rows below the fold. The
 * COUNTS above the lists are always the true totals either way, and the
 * panel says plainly when it is showing a sample of them.
 */
const SAMPLE_RENDER_LIMIT = 25

type PeopleState = Map<string, Person>

function useResolvedPeople(entries: SimulationEntry[]): PeopleState {
  const auth = useAuth()
  const accessToken = auth.user?.access_token
  const [people, setPeople] = useState<PeopleState>(new Map())
  const ids = entries.map((e) => e.userId).join(',')

  useEffect(() => {
    if (accessToken === undefined || ids.length === 0) return
    let cancelled = false

    void fetchPeopleByIds(accessToken, ids.split(','))
      .then((page) => {
        if (cancelled) return
        setPeople(new Map(page.items.map((person) => [person.id, person])))
      })
      // A failure here costs the DISPLAY NAME and nothing else — the entry
      // still renders with the username the simulation itself returned, which
      // is a real identifier, never a bare uuid. Silently degrading is right:
      // an error banner about name resolution on top of a simulation diff
      // would bury the thing the admin actually opened this for.
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [accessToken, ids])

  return people
}

interface EntryListProps {
  title: string
  verb: string
  entries: SimulationEntry[]
  total: number
  truncated: boolean
  people: PeopleState
  testId: string
}

function EntryList({ title, verb, entries, total, truncated, people, testId }: EntryListProps) {
  const groups = useGroups()
  const orgUnits = useOrgUnits()
  const shown = entries.slice(0, SAMPLE_RENDER_LIMIT)

  if (total === 0) {
    return (
      <section className="simulate__list" aria-labelledby={`${testId}-heading`}>
        <h4 id={`${testId}-heading`} className="simulate__list-heading">
          {title}
        </h4>
        <p className="cell-muted" data-testid={`${testId}-none`}>
          Nobody.
        </p>
      </section>
    )
  }

  return (
    <section className="simulate__list" aria-labelledby={`${testId}-heading`}>
      <h4 id={`${testId}-heading`} className="simulate__list-heading">
        {title}
      </h4>
      <ul className="simulate__entries" data-testid={testId}>
        {shown.map((entry) => {
          const person = people.get(entry.userId)
          const orgUnitPath =
            person !== undefined && orgUnits.status === 'ready'
              ? (orgUnits.byId.get(person.orgUnitId)?.path ?? null)
              : null
          const what = [
            ...entry.groupIds.map((id) =>
              groups.status === 'ready' ? (groups.byId.get(id)?.name ?? id) : id,
            ),
            ...entry.targets.map((target) => `${CONNECTOR_TARGET_LABEL[target]} account`),
          ]

          return (
            <li key={entry.userId} className="simulate__entry" data-testid={`${testId}-entry`}>
              <div className="simulate__entry-who">
                <Link to={`/people/${entry.userId}`} className="row-link">
                  {person?.displayName ?? entry.username}
                </Link>
                {orgUnitPath !== null && <span className="mono simulate__entry-org">{orgUnitPath}</span>}
              </div>
              <p className="simulate__entry-what">
                {verb} {what.length === 0 ? 'nothing this role tracks' : what.join(', ')}
              </p>
            </li>
          )
        })}
      </ul>
      {(truncated || total > shown.length) && (
        <p className="simulate__more" data-testid={`${testId}-more`}>
          Showing {shown.length} of {total}. The count above is the whole directory; this list is a
          sample.
        </p>
      )}
    </section>
  )
}

export interface SimulatePanelProps {
  report: SimulationReport | null
  running: boolean
  error: string | null
  /** True when the caller may run a simulation at all (`business_role:manage`, held globally). */
  canSimulate: boolean
  /** False when there is no draft to simulate — the API answers that with a 409, so the panel says so first. */
  hasDraft: boolean
  /** True when the editor above holds unsaved edits: simulating now would report on the SAVED draft, which is not what is on screen. */
  dirty: boolean
  onSimulate: () => void
}

/**
 * The safety rail in front of publish — Milestone 17, Task 18, Step 1.
 *
 * WHAT THE NUMBERS ARE, said on screen and not only here: `simulate` compares
 * this role AS PUBLISHED against this role AS DRAFTED, per person, and reports
 * the difference ROLE-LOCALLY. It is what this role will start and stop
 * granting — not a prediction of which membership rows will move. Another
 * enabled role, or a grant made by hand, may already hold the same group open
 * for somebody counted here, and the reconciler never revokes a row it did not
 * make. The API is deliberately conservative in one direction: losses can be
 * over-stated, never under-stated. Presenting these as exact row movement
 * would be the one misreading that matters, so the panel states the caveat
 * beside the figures rather than in a tooltip.
 *
 * Losses come FIRST whenever there are any. That is the list an admin
 * actually reads before publishing.
 */
export function SimulatePanel({
  report,
  running,
  error,
  canSimulate,
  hasDraft,
  dirty,
  onSimulate,
}: SimulatePanelProps) {
  const people = useResolvedPeople([...(report?.losses ?? []), ...(report?.gains ?? [])])

  return (
    <div className="simulate" data-testid="simulate-panel">
      <div className="simulate__head">
        <div>
          <h3 className="simulate__heading">Simulate</h3>
          <p className="simulate__hint">
            A dry run of this draft across the whole directory. It commits nothing — it exists so the
            number in front of you is real before you publish.
          </p>
        </div>
        {/* ONE trigger for this action, and it is the page header's — the
            header is where the draft/simulate/publish story is told and
            where Publish sits, and two Simulate buttons on one screen is
            exactly the inconsistent-affordance failure the product register
            names. Once a report exists the header's primary action becomes
            Publish, so the re-run lives here, secondary, beside the diff it
            would replace. */}
        {canSimulate && report !== null && (
          <button
            type="button"
            className="btn btn--secondary"
            disabled={running || !hasDraft || dirty}
            data-loading={running ? 'true' : undefined}
            onClick={onSimulate}
            data-testid="run-simulation-again"
          >
            <span className="btn__label">Simulate again</span>
            <span className="btn__spinner" aria-hidden="true" />
          </button>
        )}
      </div>

      {error !== null && (
        <div className="banner banner--error" role="alert" data-testid="simulate-error">
          {error}
        </div>
      )}

      {running && report === null ? (
        <div className="simulate__skeletons" aria-hidden="true">
          <span className="skeleton" style={{ width: '100%', height: '3.5rem', display: 'block' }} />
          <span className="skeleton" style={{ width: '80%', height: '1rem', display: 'block' }} />
          <span className="skeleton" style={{ width: '60%', height: '1rem', display: 'block' }} />
        </div>
      ) : report === null ? (
        <p className="cell-muted" data-testid="simulate-idle">
          {dirty
            ? 'Save the draft first — a simulation runs against what is stored, not against unsaved edits.'
            : hasDraft
              ? 'No simulation for this draft yet. Publishing is blocked until there is one.'
              : 'There are no pending changes to simulate.'}
        </p>
      ) : (
        <>
          <div className="simulate__figures">
            <div className="simulate__figure" data-testid="simulate-losses-count">
              <span className="simulate__figure-value">{report.lossCount}</span>
              <span className="simulate__figure-label">
                {report.lossCount === 1 ? 'person loses' : 'people lose'} what this role grants
              </span>
            </div>
            <div className="simulate__figure" data-testid="simulate-gains-count">
              <span className="simulate__figure-value">{report.gainCount}</span>
              <span className="simulate__figure-label">
                {report.gainCount === 1 ? 'person gains' : 'people gain'} what this role grants
              </span>
            </div>
            <p className="simulate__scanned">
              {report.scanned.toLocaleString()} people examined
            </p>
          </div>

          <p className="simulate__caveat" data-testid="simulate-caveat">
            Counted for this role alone: what it will start and stop granting, not which membership
            rows will move. Someone counted as gaining may already hold that group from another role
            or by hand, and losses are a ceiling — this role never revokes a grant it did not make.
          </p>

          <div className="simulate__lists">
            <EntryList
              title="People who lose access"
              verb="Loses"
              entries={report.losses}
              total={report.lossCount}
              truncated={report.truncated}
              people={people}
              testId="simulate-losses"
            />
            <EntryList
              title="People who gain access"
              verb="Gains"
              entries={report.gains}
              total={report.gainCount}
              truncated={report.truncated}
              people={people}
              testId="simulate-gains"
            />
          </div>
        </>
      )}
    </div>
  )
}
