-- Research sources (src/lib/research/sources/): the organization's record of
-- Reddit's approval. Recording it does not enable reading Reddit; no reader
-- is built. Hacker News and Stack Exchange need no settings (their quotas
-- are in provider_quota_state and provider_usage). Additive and re-runnable.

CREATE TABLE IF NOT EXISTS research_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  reddit_approval_recorded_at timestamptz,
  reddit_approval_note text,
  reddit_client_hint text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
