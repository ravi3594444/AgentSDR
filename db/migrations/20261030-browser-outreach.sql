-- Browser outreach: messages sent through the owner's own signed-in Chrome
-- (the 22nd x ai Browser Assistant) on X, Instagram, Facebook and LinkedIn,
-- for sites without a provider integration or when the owner asks for the
-- browser. Additive and safe to re-run.

-- A person's profile on a messaging site, and what the owner's browser found
-- when it last opened it: whether the owner can message them there.
CREATE TABLE IF NOT EXISTS browser_contact_routes (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  site text NOT NULL,
  handle text NOT NULL,
  profile_url text NOT NULL,
  state text NOT NULL DEFAULT 'unverified',
  detail text,
  source_url text,
  checked_at timestamptz,
  -- The direct-message conversation's address, once one exists; read for replies.
  thread_url text,
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT browser_contact_routes_site_chk CHECK (site IN ('x', 'instagram', 'facebook', 'linkedin')),
  CONSTRAINT browser_contact_routes_state_chk CHECK (state IN ('unverified', 'messageable', 'not_messageable', 'not_found')),
  CONSTRAINT browser_contact_routes_org_site_handle_uq UNIQUE (organization_id, site, handle)
);
CREATE INDEX IF NOT EXISTS browser_contact_routes_org_person_idx ON browser_contact_routes (organization_id, person_id);
CREATE INDEX IF NOT EXISTS browser_contact_routes_sync_idx ON browser_contact_routes (organization_id, synced_at) WHERE thread_url IS NOT NULL;

-- The account each person's browser is signed in as on a site, as its pages
-- showed it: later sends must come from the same account.
CREATE TABLE IF NOT EXISTS browser_sender_accounts (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site text NOT NULL,
  handle text NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id, site),
  CONSTRAINT browser_sender_accounts_site_chk CHECK (site IN ('x', 'instagram', 'facebook', 'linkedin'))
);

-- One message to deliver through the owner's browser: a step of an approved
-- run, or a reply. The row is the claim that keeps it from ever being sent
-- twice; one whose answer was lost stays 'uncertain' and is never resent.
CREATE TABLE IF NOT EXISTS browser_outreach_sends (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES outreach_runs(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  route_id uuid NOT NULL REFERENCES browser_contact_routes(id) ON DELETE CASCADE,
  -- The person whose connected browser sends it (the run's approver, or the reply's sender).
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL DEFAULT 'step',
  step integer NOT NULL DEFAULT 0,
  body text NOT NULL,
  draft_id uuid,
  status text NOT NULL DEFAULT 'queued',
  -- Why it is not sending yet, said plainly (Chrome offline, the owner's sign-in), and when it is looked at again.
  wait_reason text,
  next_check_at timestamptz,
  due_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_until timestamptz,
  attempted_at timestamptz,
  sent_at timestamptz,
  sender_handle text,
  thread_url text,
  -- What the courier did, step by step, for the record and the activity view.
  log jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT browser_outreach_sends_kind_chk CHECK (kind IN ('step', 'reply')),
  CONSTRAINT browser_outreach_sends_status_chk CHECK (status IN ('queued', 'waiting', 'sending', 'sent', 'failed', 'uncertain', 'blocked', 'cancelled')),
  CONSTRAINT browser_outreach_sends_step_chk CHECK ((kind = 'step' AND run_id IS NOT NULL) OR (kind = 'reply' AND draft_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS browser_outreach_sends_run_person_step_uq ON browser_outreach_sends (run_id, person_id, step) WHERE kind = 'step';
CREATE UNIQUE INDEX IF NOT EXISTS browser_outreach_sends_draft_uq ON browser_outreach_sends (draft_id) WHERE kind = 'reply';
CREATE INDEX IF NOT EXISTS browser_outreach_sends_due_idx ON browser_outreach_sends (organization_id, status, due_at);
CREATE INDEX IF NOT EXISTS browser_outreach_sends_attempted_idx ON browser_outreach_sends (organization_id, user_id, attempted_at);

-- "browser" is a channel wherever a channel is recorded: CRM conversations,
-- messages, drafts, records, routes, first contacts and run leads.
ALTER TABLE crm_conversation_messages DROP CONSTRAINT IF EXISTS crm_conversation_messages_channel_chk;
ALTER TABLE crm_conversation_messages ADD CONSTRAINT crm_conversation_messages_channel_chk CHECK (channel IN ('email', 'linkedin', 'whatsapp', 'instagram', 'browser'));
ALTER TABLE crm_conversations DROP CONSTRAINT IF EXISTS crm_conversations_channel_chk;
ALTER TABLE crm_conversations ADD CONSTRAINT crm_conversations_channel_chk CHECK (channel IN ('email', 'linkedin', 'whatsapp', 'instagram', 'browser'));
ALTER TABLE crm_drafts DROP CONSTRAINT IF EXISTS crm_drafts_channel_chk;
ALTER TABLE crm_drafts ADD CONSTRAINT crm_drafts_channel_chk CHECK (channel IN ('email', 'linkedin', 'whatsapp', 'instagram', 'browser'));
ALTER TABLE crm_drafts DROP CONSTRAINT IF EXISTS crm_drafts_browser_subject_chk;
ALTER TABLE crm_drafts ADD CONSTRAINT crm_drafts_browser_subject_chk CHECK (channel <> 'browser' OR subject IS NULL);
ALTER TABLE crm_identity_exceptions DROP CONSTRAINT IF EXISTS crm_identity_exceptions_channel_chk;
ALTER TABLE crm_identity_exceptions ADD CONSTRAINT crm_identity_exceptions_channel_chk CHECK (channel IN ('email', 'linkedin', 'whatsapp', 'instagram', 'browser'));
ALTER TABLE crm_records DROP CONSTRAINT IF EXISTS crm_records_active_channel_chk;
ALTER TABLE crm_records ADD CONSTRAINT crm_records_active_channel_chk CHECK (active_channel IS NULL OR active_channel IN ('email', 'linkedin', 'whatsapp', 'instagram', 'browser'));
ALTER TABLE crm_wrong_routes DROP CONSTRAINT IF EXISTS crm_wrong_routes_channel_chk;
ALTER TABLE crm_wrong_routes ADD CONSTRAINT crm_wrong_routes_channel_chk CHECK (channel IN ('email', 'whatsapp', 'linkedin', 'instagram', 'browser'));
ALTER TABLE lead_first_contacts DROP CONSTRAINT IF EXISTS lead_first_contacts_channel_chk;
ALTER TABLE lead_first_contacts ADD CONSTRAINT lead_first_contacts_channel_chk CHECK (channel IN ('email', 'linkedin', 'whatsapp', 'instagram', 'browser'));
ALTER TABLE outreach_run_leads DROP CONSTRAINT IF EXISTS outreach_run_leads_channel_chk;
ALTER TABLE outreach_run_leads ADD CONSTRAINT outreach_run_leads_channel_chk CHECK (channel IN ('email', 'whatsapp', 'linkedin', 'instagram', 'browser'));
