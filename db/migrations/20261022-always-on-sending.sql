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
