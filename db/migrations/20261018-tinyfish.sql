-- TinyFish as the organization's web access, and provider quotas
-- (src/lib/tinyfish/, src/lib/quota/). Additive and re-runnable.

CREATE TABLE IF NOT EXISTS tinyfish_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  encrypted_key text,
  key_hint text,
  key_scope text,
  use_for_web_search boolean NOT NULL DEFAULT true,
  browser_minutes_per_day integer NOT NULL DEFAULT 0,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tinyfish_settings_browser_chk CHECK (browser_minutes_per_day BETWEEN 0 AND 240)
);

-- Global by design: one row per provider quota scope (a key's sha256) and
-- product, holding counters and a wait only, shared by every organization
-- that saved the same key.
CREATE TABLE IF NOT EXISTS provider_quota_state (
  scope_key text NOT NULL,
  product text NOT NULL,
  minute_start timestamptz,
  minute_used integer NOT NULL DEFAULT 0,
  hour_start timestamptz,
  hour_used integer NOT NULL DEFAULT 0,
  day_start timestamptz,
  day_used integer NOT NULL DEFAULT 0,
  blocked_until timestamptz,
  blocked_reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_quota_state_pkey PRIMARY KEY (scope_key, product)
);

CREATE TABLE IF NOT EXISTS provider_usage (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  product text NOT NULL,
  scope_key text,
  units integer NOT NULL,
  used_units integer,
  status text NOT NULL DEFAULT 'reserved',
  job_id uuid,
  thread_id uuid,
  detail jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT provider_usage_status_chk CHECK (status IN ('reserved', 'settled', 'failed', 'uncertain'))
);
CREATE INDEX IF NOT EXISTS provider_usage_org_product_idx ON provider_usage (organization_id, provider, product, created_at);
