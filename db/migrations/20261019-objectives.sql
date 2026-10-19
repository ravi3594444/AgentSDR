-- Objectives (src/lib/assistant/objective*.ts): one owner request pursued to
-- an end, with its lead target, time limit and spend cap, its status and the
-- exact reason it stopped, and its one final report (report_key, written
-- with the stop; reported_at, set in the same transaction as the chat
-- event). One per request: unique by (organization, request message). Its
-- searches stay ordinary assistant_jobs carrying the request's id; a driver
-- job of the new kind "objective" continues the request when they finish
-- short of the target. treg_calls.request_id attributes a Treg call to the
-- request it served, so the request's spend is read from its own ledgers.
-- Additive and re-runnable.

CREATE TABLE IF NOT EXISTS assistant_objectives (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
  request_message_id uuid NOT NULL REFERENCES assistant_messages(id) ON DELETE CASCADE,
  lead_target integer NOT NULL,
  time_limit_minutes integer NOT NULL,
  deadline_at timestamptz NOT NULL,
  spend_cap_usd double precision NOT NULL,
  controls jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  stop_reason text,
  stop_detail text,
  stopped_at timestamptz,
  next_eligible_at timestamptz,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  report_key text,
  reported_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assistant_objectives_status_chk CHECK (status IN ('active', 'paused', 'stopped')),
  CONSTRAINT assistant_objectives_stop_reason_chk CHECK (stop_reason IS NULL OR stop_reason IN ('target_reached', 'sources_exhausted', 'budget_spent', 'time_limit', 'cancelled', 'failed')),
  CONSTRAINT assistant_objectives_limits_chk CHECK (lead_target >= 1 AND time_limit_minutes >= 1 AND spend_cap_usd >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS assistant_objectives_org_request_uq ON assistant_objectives (organization_id, request_message_id);
CREATE INDEX IF NOT EXISTS assistant_objectives_thread_idx ON assistant_objectives (thread_id, created_at);

ALTER TABLE assistant_jobs DROP CONSTRAINT IF EXISTS assistant_jobs_kind_chk;
ALTER TABLE assistant_jobs ADD CONSTRAINT assistant_jobs_kind_chk
  CHECK (kind IN ('discovery', 'outreach_start', 'linkedin_search', 'web_discovery', 'apify_instagram', 'objective'));

ALTER TABLE treg_calls ADD COLUMN IF NOT EXISTS request_id text;
