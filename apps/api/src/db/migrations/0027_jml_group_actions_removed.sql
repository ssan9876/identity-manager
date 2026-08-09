-- Milestone 19, Task 16. JML no longer grants group membership; business
-- roles own desired state (the reconciler runs on every user write and sweeps
-- every user, so a JML rule granting a membership would be a second, competing
-- writer that the next reconcile would simply revoke).
--
-- Postgres cannot DROP VALUE from an enum, so 'add_to_group'/'remove_from_group'
-- survive in the jml_action type and a stored row can still carry one.
-- Application code rejects them (rule-engine.ts's closed KNOWN_ACTIONS set).
--
-- Fail LOUDLY rather than leaving behind a rule that will never fire again:
-- a silently dead rule is a permission somebody believes is being maintained.
-- This is a guard, not a data change — it writes nothing, so re-running it
-- against a clean table is a no-op and the migration stays idempotent.
DO $$
DECLARE stranded integer;
BEGIN
  SELECT count(*) INTO stranded FROM jml_rules WHERE action IN ('add_to_group', 'remove_from_group');
  IF stranded > 0 THEN
    RAISE EXCEPTION
      'Migration 0027: % jml_rules row(s) still use add_to_group/remove_from_group. Re-create them as business roles, delete them, then re-run.', stranded;
  END IF;
END $$;
