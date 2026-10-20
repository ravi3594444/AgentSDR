-- Pilot fixes (docs/plans/PILOT_FIXES_2026-10-19.md).
--
-- lead_audience_members.fit_*: a lead's verdict against the owner request
-- its list serves (src/lib/assistant/leadFit.ts, qualify.server.ts). Only
-- a contactable lead that matches the request counts toward the request's
-- lead target; the verdict is stored once, so a plan, a retried step or
-- another report reuses it instead of asking the model again. fit_claimed_at
-- is the lease while one process judges the lead.
--
-- whatsapp_accounts.last_refusal*: why the campaign sender last held back
-- a number (WhatsApp refused, a gap or cap, disconnected), shown in the
-- plan's sending status until the next accepted send clears it. Never a
-- message body.
--
-- Additive and re-runnable.

ALTER TABLE lead_audience_members ADD COLUMN IF NOT EXISTS fit text;
ALTER TABLE lead_audience_members ADD COLUMN IF NOT EXISTS fit_reason text;
ALTER TABLE lead_audience_members ADD COLUMN IF NOT EXISTS fit_group text;
ALTER TABLE lead_audience_members ADD COLUMN IF NOT EXISTS fit_approach text;
ALTER TABLE lead_audience_members ADD COLUMN IF NOT EXISTS fit_request_id uuid;
ALTER TABLE lead_audience_members ADD COLUMN IF NOT EXISTS fit_at timestamp with time zone;
ALTER TABLE lead_audience_members ADD COLUMN IF NOT EXISTS fit_claimed_at timestamp with time zone;
ALTER TABLE lead_audience_members DROP CONSTRAINT IF EXISTS lead_audience_members_fit_chk;
ALTER TABLE lead_audience_members ADD CONSTRAINT lead_audience_members_fit_chk
  CHECK (fit IS NULL OR fit IN ('match', 'unconfirmed', 'no_match'));
ALTER TABLE lead_audience_members DROP CONSTRAINT IF EXISTS lead_audience_members_fit_approach_chk;
ALTER TABLE lead_audience_members ADD CONSTRAINT lead_audience_members_fit_approach_chk
  CHECK (fit_approach IS NULL OR fit_approach IN ('standard', 'personal', 'skip'));

ALTER TABLE whatsapp_accounts ADD COLUMN IF NOT EXISTS last_refusal text;
ALTER TABLE whatsapp_accounts ADD COLUMN IF NOT EXISTS last_refusal_at timestamp with time zone;
