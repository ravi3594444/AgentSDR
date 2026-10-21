-- Always-on sending (docs/workspace/sending-rules.mdx).
--
-- Sending hours were removed from the product: every engine sends at any
-- time of day, every day, and the one sending setting is the daily lead
-- limit (general.newLeadsPerDay). This brings stored data in line, so no
-- value saved before can restrict sending:
--
-- outreach_mailboxes.working_hours: every day enabled from 00:00 to 00:00,
--   which the app reads as always open (isAlwaysOpen,
--   src/lib/outreach/workingHours.ts). Each mailbox's timezone is KEPT: it
--   is the day its daily counter resets on. Nothing else on the row changes
--   (today_emails_sent, send_counter_reset_at, next_email_time), so no
--   day's usage is reset and no gap between sends is skipped.
-- outreach_mailboxes.working_hours default: always open, in UTC (the app
--   sets the organization's time zone on the mailboxes it creates).
-- "LinkedInAccount" work* fields: cleared; null means any time.
-- channel_settings: the stored copies of the retired hour rules removed
--   (sendingHours of email, WhatsApp and Instagram; LinkedIn workingHours).
--
-- Data only, apart from the column default. Re-runnable: each statement
-- touches only rows that still differ.

UPDATE outreach_mailboxes
   SET working_hours = jsonb_build_object(
         'timezone', coalesce(working_hours->>'timezone', 'UTC'),
         'days', '{"monday": {"enabled": true, "from": "00:00", "to": "00:00"}, "tuesday": {"enabled": true, "from": "00:00", "to": "00:00"}, "wednesday": {"enabled": true, "from": "00:00", "to": "00:00"}, "thursday": {"enabled": true, "from": "00:00", "to": "00:00"}, "friday": {"enabled": true, "from": "00:00", "to": "00:00"}, "saturday": {"enabled": true, "from": "00:00", "to": "00:00"}, "sunday": {"enabled": true, "from": "00:00", "to": "00:00"}}'::jsonb),
       updated_at = now()
 WHERE working_hours->'days' IS DISTINCT FROM '{"monday": {"enabled": true, "from": "00:00", "to": "00:00"}, "tuesday": {"enabled": true, "from": "00:00", "to": "00:00"}, "wednesday": {"enabled": true, "from": "00:00", "to": "00:00"}, "thursday": {"enabled": true, "from": "00:00", "to": "00:00"}, "friday": {"enabled": true, "from": "00:00", "to": "00:00"}, "saturday": {"enabled": true, "from": "00:00", "to": "00:00"}, "sunday": {"enabled": true, "from": "00:00", "to": "00:00"}}'::jsonb
    OR working_hours->>'timezone' IS NULL;

ALTER TABLE outreach_mailboxes ALTER COLUMN working_hours SET DEFAULT
  '{"timezone": "UTC", "days": {"monday": {"enabled": true, "from": "00:00", "to": "00:00"}, "tuesday": {"enabled": true, "from": "00:00", "to": "00:00"}, "wednesday": {"enabled": true, "from": "00:00", "to": "00:00"}, "thursday": {"enabled": true, "from": "00:00", "to": "00:00"}, "friday": {"enabled": true, "from": "00:00", "to": "00:00"}, "saturday": {"enabled": true, "from": "00:00", "to": "00:00"}, "sunday": {"enabled": true, "from": "00:00", "to": "00:00"}}}'::jsonb;

-- The LinkedIn tables keep UTC in timestamp without time zone.
UPDATE "LinkedInAccount"
   SET "workTimezone" = NULL, "workStartTime" = NULL, "workEndTime" = NULL, "workDays" = NULL,
       "updatedAt" = (now() AT TIME ZONE 'UTC')
 WHERE "workTimezone" IS NOT NULL OR "workStartTime" IS NOT NULL OR "workEndTime" IS NOT NULL OR "workDays" IS NOT NULL;

UPDATE channel_settings
   SET values = values - 'sendingHours', updated_at = now()
 WHERE channel IN ('email', 'whatsapp', 'instagram') AND values ? 'sendingHours';

UPDATE channel_settings
   SET values = values - 'workingHours', updated_at = now()
 WHERE channel = 'linkedin' AND values ? 'workingHours';

-- The daily lead limit's ledger (src/lib/channels/dailyLeadLimit.server.ts):
-- each person's first automated contact, written in the same transaction as
-- the engine's claim. Deleting a campaign, a lead or a claim gives no place
-- back; only an engine's definite failure releases it. Filled once from the
-- claims already recorded (the earliest per person; re-runs keep the
-- earliest).
CREATE TABLE IF NOT EXISTS lead_first_contacts (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  first_at timestamptz NOT NULL,
  channel text NOT NULL,
  CONSTRAINT lead_first_contacts_pkey PRIMARY KEY (organization_id, person_id),
  CONSTRAINT lead_first_contacts_channel_chk CHECK (channel IN ('email', 'linkedin', 'whatsapp', 'instagram'))
);
CREATE INDEX IF NOT EXISTS lead_first_contacts_day_idx ON lead_first_contacts (organization_id, first_at);

INSERT INTO lead_first_contacts (organization_id, person_id, first_at, channel)
SELECT DISTINCT ON (organization_id, person_id) organization_id, person_id, at, channel FROM (
  SELECT c.organization_id, l.person_id, coalesce(e.created_at, e.sent_at) AS at, 'email' AS channel
    FROM outreach_emails e
    JOIN outreach_leads l ON l.id = e.lead_id
    JOIN outreach_campaigns c ON c.id = l.campaign_id
   WHERE NOT (e.status = 'failed' AND e.error IS NOT DISTINCT FROM 'Blocked by Person-global Do Not Contact policy before provider submission')
  UNION ALL
  SELECT m."organizationId", ld."personId", (m."createdAt" AT TIME ZONE 'UTC'), 'linkedin'
    FROM "Message" m
    JOIN "Lead" ld ON ld.id = m."leadId" AND ld."organizationId" = m."organizationId"
   WHERE m.type = 'INVITATION' AND m."duplicateOfMessageId" IS NULL
  UNION ALL
  SELECT wc.organization_id, wl.person_id, s.created_at, 'whatsapp'
    FROM whatsapp_campaign_sends s
    JOIN whatsapp_campaign_leads wl ON wl.id = s.lead_id
    JOIN whatsapp_campaigns wc ON wc.id = wl.campaign_id
   WHERE s.status IN ('sending', 'sent')
) touched
WHERE person_id IS NOT NULL AND at IS NOT NULL
ORDER BY organization_id, person_id, at
ON CONFLICT (organization_id, person_id) DO UPDATE
  SET first_at = LEAST(lead_first_contacts.first_at, EXCLUDED.first_at),
      channel = CASE WHEN EXCLUDED.first_at < lead_first_contacts.first_at THEN EXCLUDED.channel ELSE lead_first_contacts.channel END;

-- Instagram outreach is optional: its queue table exists only where it was installed.
DO $$
BEGIN
  IF to_regclass('public.instagram_outreach_queue') IS NOT NULL THEN
    INSERT INTO lead_first_contacts (organization_id, person_id, first_at, channel)
    SELECT DISTINCT ON (organization_id, person_id) organization_id, person_id, attempted_at, 'instagram'
      FROM instagram_outreach_queue
     WHERE status IN ('sending', 'sent', 'uncertain') AND attempted_at IS NOT NULL AND person_id IS NOT NULL
     ORDER BY organization_id, person_id, attempted_at
    ON CONFLICT (organization_id, person_id) DO UPDATE
      SET first_at = LEAST(lead_first_contacts.first_at, EXCLUDED.first_at),
          channel = CASE WHEN EXCLUDED.first_at < lead_first_contacts.first_at THEN EXCLUDED.channel ELSE lead_first_contacts.channel END;
  END IF;
END $$;
