-- Research agent v2: a request the assistant finishes as asked ("both tests
-- run", "5 dentists found and a plan prepared") ends with stop reason
-- 'finished'. Only the CHECK widens; safe to re-run.
ALTER TABLE assistant_objectives DROP CONSTRAINT IF EXISTS assistant_objectives_stop_reason_chk;
ALTER TABLE assistant_objectives ADD CONSTRAINT assistant_objectives_stop_reason_chk
  CHECK (stop_reason IS NULL OR stop_reason IN ('target_reached', 'finished', 'sources_exhausted', 'budget_spent', 'time_limit', 'cancelled', 'failed'));
