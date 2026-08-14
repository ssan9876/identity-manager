import { describe, expect, it } from 'vitest'
import { OutboxRepository, sanitizeLastError } from '../src/outbox/outbox.repository'
import { withTestDatabase } from './support/pg'

// Every control character below is written as an ESCAPE, never typed
// literally. A literal NUL in a source file makes it binary to git, grep and
// every reviewer's editor — which is a fair description of the bug this file
// exists to pin, arriving through the test for it.
const NUL = '\u0000'

/**
 * A connector's error message is whatever a remote directory, or the vendor
 * library talking to it, happened to hand back — and it is stored verbatim in
 * `outbox_events.last_error`.
 *
 * Found by running the thing. A failing Active Directory sync produced a
 * message containing a NUL byte; Postgres rejected the UPDATE with `invalid
 * byte sequence for encoding "UTF8": 0x00`; and because that throw happened
 * INSIDE the failure-recording path, it escaped the per-event handler and
 * aborted the entire drain — every target's events, not only the one that
 * failed. The worker retried the same poison event each tick and died the
 * same way, so the outbox stopped moving permanently while every row still
 * looked merely `pending`. The original connector error was destroyed in the
 * process: it is never logged before this write, so the failure that needed
 * diagnosing was replaced by an encoding complaint about recording it.
 */
describe('outbox last_error sanitisation', () => {
  const ctx = withTestDatabase()

  describe('sanitizeLastError', () => {
    it('strips the NUL byte that wedged the drain', () => {
      expect(sanitizeLastError(`ldap failure ${NUL}trailing`)).toBe('ldap failure trailing')
    })

    it('strips other control characters that have no business in a diagnostic', () => {
      expect(sanitizeLastError('a\u0001b\u001fc')).toBe('abc')
    })

    /** Newlines and tabs SURVIVE — a multi-line vendor error is still readable, and readability is the point. */
    it('keeps newlines and tabs', () => {
      expect(sanitizeLastError('line one\nline two\tindented')).toBe('line one\nline two\tindented')
    })

    /** `last_error` is a diagnostic, not a log sink — a vendor can return an entire payload. */
    it('caps a runaway message', () => {
      const result = sanitizeLastError('x'.repeat(5000))
      expect(result.length).toBeLessThan(2100)
      expect(result.endsWith('… (truncated)')).toBe(true)
    })

    it('leaves an ordinary message exactly alone', () => {
      const message = 'ActiveDirectoryConnector: organizational unit "OU=x,DC=y" does not exist'
      expect(sanitizeLastError(message)).toBe(message)
    })
  })

  /**
   * The regression proper: the write must SUCCEED. Asserting only on the
   * helper would have missed the actual defect, which was that a
   * reasonable-looking string killed the statement carrying it.
   */
  describe('the failure-recording path accepts a poisoned message', () => {
    async function insertPendingEvent(): Promise<number> {
      const { rows } = await ctx.pool.query<{ id: string }>(
        `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, status, attempts, target)
         VALUES ('org_unit', gen_random_uuid(), 'created', '{}'::jsonb, 'pending', 0, 'active_directory')
         RETURNING id`,
      )
      return Number(rows[0]!.id)
    }

    async function lastErrorOf(id: number): Promise<string | null> {
      const { rows } = await ctx.pool.query<{ last_error: string | null }>(
        'SELECT last_error FROM outbox_events WHERE id = $1',
        [id],
      )
      return rows[0]?.last_error ?? null
    }

    it('markForRetry stores a NUL-bearing message instead of throwing', async () => {
      const id = await insertPendingEvent()
      const repo = new OutboxRepository()

      await ctx.db.transaction(async (tx) => {
        await repo.markForRetry(tx, id, {
          attempts: 1,
          nextAttemptAt: new Date(),
          lastError: `ldapts: connection reset${NUL}`,
        })
      })

      expect(await lastErrorOf(id)).toBe('ldapts: connection reset')
    })

    it('markFailed does too — the dead-letter path shares the hazard', async () => {
      const id = await insertPendingEvent()
      const repo = new OutboxRepository()

      await ctx.db.transaction(async (tx) => {
        await repo.markFailed(tx, id, { attempts: 8, lastError: `fatal ${NUL}boom` })
      })

      expect(await lastErrorOf(id)).toBe('fatal boom')
    })
  })
})
