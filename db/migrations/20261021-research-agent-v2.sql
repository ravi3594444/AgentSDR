-- Research agent v2: the organization switch that turns it on
-- (organization_features key 'research_agent_v2'), and a request the
-- assistant finishes as asked ("both tests run", "5 dentists found and a plan
-- prepared") ends with stop reason 'finished'. Only CHECKs widen; safe to re-run.
ALTER TABLE organization_features DROP CONSTRAINT IF EXISTS organization_features_key_chk;
ALTER TABLE organization_features ADD CONSTRAINT organization_features_key_chk
  CHECK (key IN ('instagram', 'web_discovery', 'inquiry_intake', 'apify_discovery', 'treg', 'brightdata', 'research_agent_v2'));

ALTER TABLE assistant_objectives DROP CONSTRAINT IF EXISTS assistant_objectives_stop_reason_chk;
ALTER TABLE assistant_objectives ADD CONSTRAINT assistant_objectives_stop_reason_chk
  CHECK (stop_reason IS NULL OR stop_reason IN ('target_reached', 'finished', 'sources_exhausted', 'budget_spent', 'time_limit', 'cancelled', 'failed'));
