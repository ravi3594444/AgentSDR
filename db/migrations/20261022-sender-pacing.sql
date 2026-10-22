-- Adopt the requested 30-second sender gap for existing workspaces once.
-- The marker keeps future explicit settings intact on subsequent deploys.
-- No sending count, queue claim, campaign status or follow-up date is reset.
DO $migration$
DECLARE
  adopted boolean;
BEGIN
  INSERT INTO platform_settings (key, value)
  VALUES ('sender-pacing-30s-v1', jsonb_build_object('appliedAt', now()))
  ON CONFLICT (key) DO NOTHING;
  adopted := FOUND;

  IF adopted THEN
    UPDATE channel_settings
       SET values = values - 'sendGapMinutes' - 'secondsBetweenSends', updated_at = now()
     WHERE channel IN ('email', 'whatsapp', 'instagram')
       AND (values ? 'sendGapMinutes' OR values ? 'secondsBetweenSends');
  END IF;

  -- The explicit post-switch refresh also catches a long timer the old
  -- process wrote while the upgrade ran. Ordinary re-runs touch nothing.
  IF adopted OR current_setting('agentsdr.refresh_sender_pacing', true) = 'on' THEN
    -- Only next_email_time is sender pacing. outreach_leads.next_send_at is
    -- a scheduled message/follow-up and must never be brought forward here.
    UPDATE outreach_mailboxes m
       SET next_email_time = greatest(coalesce((
             SELECT max(coalesce(e.sent_at, e.created_at))
               FROM outreach_emails e
              WHERE e.mailbox_id = m.id AND e.status <> 'failed'
           ), now()) + interval '30 seconds', now()), updated_at = now()
     WHERE m.next_email_time > greatest(coalesce((
             SELECT max(coalesce(e.sent_at, e.created_at))
               FROM outreach_emails e
              WHERE e.mailbox_id = m.id AND e.status <> 'failed'
           ), now()) + interval '30 seconds', now());

    -- Outbound Instagram is optional on older installations.
    IF to_regclass('public.instagram_outreach_queue') IS NOT NULL THEN
      UPDATE instagram_accounts a
         SET outreach_next_send_at = greatest(coalesce((
               SELECT max(q.attempted_at)
                 FROM instagram_outreach_queue q
                WHERE q.account_id = a.id
                  AND q.organization_id = a.organization_id
             ), now()) + interval '30 seconds', now())
       WHERE a.outreach_next_send_at > greatest(coalesce((
               SELECT max(q.attempted_at)
                 FROM instagram_outreach_queue q
                WHERE q.account_id = a.id
                  AND q.organization_id = a.organization_id
             ), now()) + interval '30 seconds', now());
    END IF;
  END IF;
END $migration$;
