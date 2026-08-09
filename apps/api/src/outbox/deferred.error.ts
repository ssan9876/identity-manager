/**
 * Not a failure — a "not yet". Organizations milestone, Task 14.
 *
 * The worker reschedules the event with backoff WITHOUT incrementing
 * `attempts`, so waiting on a prerequisite never spends the dead-letter
 * budget. That distinction is the whole point: a retryable ERROR is a real
 * failure that happens to be worth retrying, and eight of them mean
 * something is genuinely broken and an operator should be told. A deferral
 * is the system correctly declining to act yet, and however many of those
 * happen, nothing is wrong.
 *
 * The motivating case is a person created in a brand-new organization. Their
 * `user` event and their organization's `organization` event are written
 * seconds apart, and the realm the person belongs in does not exist until
 * the second one has been drained. Treating that as a failure would burn
 * roughly forty minutes of exponential backoff — and, because ordering is
 * per (aggregate, target), head-of-line block every later event for that
 * person for the same duration — before dead-lettering a user who was never
 * wrong about anything.
 *
 * A plain `Error` subclass rather than a `DomainError`: this never reaches
 * the HTTP layer at all. It is raised inside `SyncWorker.applyEvent` and
 * caught by `runOnce`, and there is no request to answer.
 */
export class DeferredError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'DeferredError'
  }
}
