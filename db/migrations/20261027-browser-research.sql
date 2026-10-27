-- Connected-browser research: a person's own Chrome paired with the
-- workspace (browser_connections) and the commands the assistant queues for
-- it (browser_commands), src/lib/browser/connected/. Additive and re-runnable.

CREATE TABLE IF NOT EXISTS browser_connections (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  pairing_code_hash text,
  pairing_expires_at timestamptz,
  token_hash text,
  device_id text,
  device_label text,
  extension_version text,
  sites text[] NOT NULL DEFAULT ARRAY[]::text[],
  shared_tabs jsonb NOT NULL DEFAULT '[]'::jsonb,
  attention jsonb,
  paused boolean NOT NULL DEFAULT false,
  command_seq bigint NOT NULL DEFAULT 0,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  paired_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT browser_connections_status_chk CHECK (status IN ('pending', 'active', 'revoked'))
);
CREATE INDEX IF NOT EXISTS browser_connections_org_user_idx ON browser_connections (organization_id, user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS browser_connections_token_uq ON browser_connections (token_hash) WHERE token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS browser_connections_pairing_uq ON browser_connections (pairing_code_hash) WHERE pairing_code_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS browser_commands (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES browser_connections(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  thread_id uuid,
  request_id uuid NOT NULL,
  action jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz NOT NULL,
  CONSTRAINT browser_commands_status_chk CHECK (status IN ('pending', 'delivered', 'done', 'failed', 'expired'))
);
CREATE UNIQUE INDEX IF NOT EXISTS browser_commands_connection_seq_uq ON browser_commands (connection_id, seq);
CREATE INDEX IF NOT EXISTS browser_commands_connection_status_idx ON browser_commands (connection_id, status, seq);
CREATE INDEX IF NOT EXISTS browser_commands_org_idx ON browser_commands (organization_id, created_at);
