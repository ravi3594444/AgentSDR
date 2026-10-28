-- Optional operator-managed Exa key. Additive, re-runnable; no existing credentials or settings change.
ALTER TABLE platform_credentials DROP CONSTRAINT IF EXISTS platform_credentials_provider_chk;
ALTER TABLE platform_credentials ADD CONSTRAINT platform_credentials_provider_chk
  CHECK (provider IN ('unipile', 'openrouter', 'aimlapi', 'anthropic', 'tinyfish', 'tavily', 'brightdata', 'apify', 'exa'));
