-- The assistant's remote browser sessions (TinyFish Browser over CDP,
-- src/lib/browser/). Additive and re-runnable.

CREATE TABLE IF NOT EXISTS browser_sessions (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid,
  provider text NOT NULL DEFAULT 'tinyfish',
  provider_session_id text,
  encrypted_cdp_url text,
  usage_id uuid,
  status text NOT NULL DEFAULT 'opening',
  current_url text,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  minutes_used integer,
  CONSTRAINT browser_sessions_status_chk CHECK (status IN ('opening', 'open', 'closed', 'failed'))
);
CREATE INDEX IF NOT EXISTS browser_sessions_org_status_idx ON browser_sessions (organization_id, status, started_at);
