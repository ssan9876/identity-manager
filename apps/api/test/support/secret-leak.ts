/**
 * The one assertion every secret-leak proof in this suite funnels through —
 * originally local to `connector-secrets.spec.ts` (Milestone 10, Task 2),
 * extracted here so `connector-targets.controller.spec.ts` (Milestone 14,
 * Task 9 — "add a test proving the target-config endpoint's response
 * contains no resolved secret — reuse the sentinel helper") genuinely
 * REUSES this one implementation rather than growing a second, independently
 * -maintained copy. "Did we grep everything" reduces to "did we call this
 * enough times," and the meta-test in either spec file ("assertNoLeak is not
 * a vacuous check") only has to prove this ONE function actually detects a
 * leak, not each individual call site across both files.
 */
export function assertNoLeak(haystack: string, sentinel: string, where: string): void {
  if (haystack.includes(sentinel)) {
    throw new Error(`SECRET LEAK in ${where}: sentinel value found — "${haystack}"`)
  }
}
