import { Link } from 'react-router-dom'
import { ALL_ROLE_KEYS, ROLE_DESCRIPTION, ROLE_LABEL, ROLE_RANK } from './api'
import './RolesCatalogPage.css'

/**
 * `/roles` — Milestone 8, Task 4. This nav destination (shell/nav-items.tsx,
 * Task 2) has held an honest "coming in a later task" placeholder since
 * Task 2 built the shell; THIS is that later task, so it earns a real
 * screen rather than staying a permanent dead end (docs/design-system.md and
 * Milestone 8's Task 2 brief: no dead links).
 *
 * Deliberately a static REFERENCE table, not a cross-directory "every role
 * assignment, for every person" browser: `role_assignments` has no list-all
 * endpoint (Milestone 8 "adds no new endpoints except where a screen
 * genuinely needs one" — a directory-wide role browser was not something
 * this task's own contract asked for, and role assignment is inherently a
 * PER-PERSON operation — task-4-brief.md's own error-message language
 * ("without disclosing anything about principals... they cannot see")
 * frames it that way throughout). Granting and revoking happens on a
 * person's own Roles tab (PersonRolesTab.tsx), reachable from People — this
 * page's own closing link. What this page adds instead: the rank ordering
 * every `assertCanModifyPrincipal` rejection depends on, made legible,
 * since "this person outranks you" means nothing without seeing the ladder.
 */
export default function RolesCatalogPage() {
  const rolesByRank = [...ALL_ROLE_KEYS].sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])

  return (
    <div className="roles-catalog">
      <h1 className="text-title">Roles</h1>
      <p className="roles-catalog__intro">
        Every role in the system, highest-privilege first. Granting and revoking is done from a person's
        own profile — open their <span className="mono">Roles</span> tab from{' '}
        <Link to="/people">People</Link> to manage an assignment.
      </p>

      <div className="table-wrap">
        <table className="table" data-testid="roles-catalog-table">
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Can do</th>
            </tr>
          </thead>
          <tbody>
            {rolesByRank.map((key) => (
              <tr key={key} data-testid="roles-catalog-row">
                <td className="roles-catalog__name">{ROLE_LABEL[key]}</td>
                <td className="cell-muted">{ROLE_DESCRIPTION[key]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="roles-catalog__note">
        A role can be granted <strong>globally</strong> (everywhere) or <strong>scoped</strong> to one org
        unit and everything beneath it. An administrator may only grant a role they hold themselves, at a
        scope their own holding covers, and may never modify a principal who holds a higher-ranked role
        than they do — even at equal rank, one holder of a role can always modify another.
      </p>
    </div>
  )
}
