-- Turn the WhatsApp new-chat warm-up off for existing workspaces once (the
-- owner's decision, 23 Oct 2026). The rule's default is now 0 hours; a value
-- an organization stored is removed so it follows that default. The marker
-- keeps a warm-up an owner sets later intact on subsequent deploys. Nothing
-- else is touched: daily new-chat limits, spacing, counts and campaigns stay.
DO $migration$
BEGIN
  INSERT INTO platform_settings (key, value)
  VALUES ('whatsapp-warmup-off-v1', jsonb_build_object('appliedAt', now()))
  ON CONFLICT (key) DO NOTHING;

  IF FOUND THEN
    UPDATE channel_settings
       SET values = values - 'warmupHours', updated_at = now()
     WHERE channel = 'whatsapp'
       AND values ? 'warmupHours';
  END IF;
END $migration$;
