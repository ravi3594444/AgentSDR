-- Managed SaaS (docs/plans/MANAGED_SAAS_IMPLEMENTATION_2026-10-22.md).
--
-- Additive and re-runnable: deploy.sh runs it on every deploy.

-- platform_operators: the people who run this AgentSDR instance. GLOBAL.
-- Granted and revoked only by scripts/grant-platform-operator.ts; owning or
-- creating a customer organization never grants it. Nobody is added here.
CREATE TABLE IF NOT EXISTS platform_operators (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  granted_by text NOT NULL,
  note text,
  granted_at timestamptz NOT NULL DEFAULT now()
);

-- platform_credentials: the platform's own key for each Included service,
-- encrypted with INTEGRATION_CREDENTIALS_KEY like every integration
-- credential. GLOBAL. Stored, replaced and removed only by a platform
-- operator (the /platform panel). config holds non-secret values and masked
-- hints only; fingerprint is a sha256 of the secret, never the secret.
CREATE TABLE IF NOT EXISTS platform_credentials (
  provider text PRIMARY KEY,
  encrypted_payload text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  fingerprint text NOT NULL,
  source_organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_credentials_provider_chk
    CHECK (provider IN ('unipile', 'openrouter', 'aimlapi', 'anthropic', 'tinyfish', 'tavily', 'brightdata', 'apify'))
);

-- platform_settings: platform-wide choices (key 'ai': the Included AI engine
-- and its default model configuration). GLOBAL.
CREATE TABLE IF NOT EXISTS platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- provider_credential_modes: each organization's explicit choice per
-- service, Included service ('managed') or My own provider ('own'). Scoped.
CREATE TABLE IF NOT EXISTS provider_credential_modes (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  service text NOT NULL,
  mode text NOT NULL,
  reason text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_credential_modes_pkey PRIMARY KEY (organization_id, service),
  CONSTRAINT provider_credential_modes_service_chk CHECK (service IN ('ai', 'unipile', 'tinyfish', 'tavily', 'brightdata', 'apify')),
  CONSTRAINT provider_credential_modes_mode_chk CHECK (mode IN ('managed', 'own'))
);

-- Older installs may not have run the optional intake/discovery migration
-- that introduced Tavily. deploy.sh's predecessors do not create this table,
-- so initialise it before the credential backfill reads it. This matches
-- the fresh-install schema and leaves existing keys and settings untouched.
CREATE TABLE IF NOT EXISTS tavily_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  encrypted_key text,
  key_hint text,
  daily_searches integer NOT NULL DEFAULT 100,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tavily_settings_daily_chk CHECK (daily_searches BETWEEN 1 AND 2000)
);

-- Every organization that saved its own credentials keeps them: "My own
-- provider", explicitly. Never overwrites a choice made since (DO NOTHING),
-- so a re-run on the next deploy changes nothing.
INSERT INTO provider_credential_modes (organization_id, service, mode, reason)
SELECT DISTINCT organization_id, 'ai', 'own', 'had its own AI connection before Included services'
FROM grid_providers WHERE config ? 'aiProviderKey'
ON CONFLICT (organization_id, service) DO NOTHING;

INSERT INTO provider_credential_modes (organization_id, service, mode, reason)
SELECT DISTINCT organization_id, 'unipile', 'own', 'had its own Unipile connection before Included services'
FROM grid_providers WHERE key = 'platform-unipile'
ON CONFLICT (organization_id, service) DO NOTHING;

INSERT INTO provider_credential_modes (organization_id, service, mode, reason)
SELECT organization_id, 'tinyfish', 'own', 'had its own TinyFish key before Included services'
FROM tinyfish_settings WHERE encrypted_key IS NOT NULL
ON CONFLICT (organization_id, service) DO NOTHING;

INSERT INTO provider_credential_modes (organization_id, service, mode, reason)
SELECT organization_id, 'tavily', 'own', 'had its own Tavily key before Included services'
FROM tavily_settings WHERE encrypted_key IS NOT NULL
ON CONFLICT (organization_id, service) DO NOTHING;

INSERT INTO provider_credential_modes (organization_id, service, mode, reason)
SELECT organization_id, 'brightdata', 'own', 'had its own Bright Data key before Included services'
FROM brightdata_settings WHERE encrypted_key IS NOT NULL
ON CONFLICT (organization_id, service) DO NOTHING;

INSERT INTO provider_credential_modes (organization_id, service, mode, reason)
SELECT organization_id, 'apify', 'own', 'had its own Apify token before Included services'
FROM apify_settings WHERE encrypted_token IS NOT NULL
ON CONFLICT (organization_id, service) DO NOTHING;

-- Usage attribution: whose credentials did the work. 'managed' rows are an
-- Included service and count against the allowances
-- (src/lib/managed/allowances.ts); every earlier row was the organization's
-- own key. cost_usd: what the call cost (reported or estimated, see
-- detail.costEstimated), the amount held while reserved.
ALTER TABLE provider_usage ADD COLUMN IF NOT EXISTS credential_source text NOT NULL DEFAULT 'own';
ALTER TABLE provider_usage ADD COLUMN IF NOT EXISTS cost_usd numeric(14,6);
ALTER TABLE provider_usage DROP CONSTRAINT IF EXISTS provider_usage_credential_source_chk;
ALTER TABLE provider_usage ADD CONSTRAINT provider_usage_credential_source_chk
  CHECK (credential_source IN ('managed', 'own'));
CREATE INDEX IF NOT EXISTS provider_usage_managed_idx ON provider_usage (provider, created_at) WHERE credential_source = 'managed';

ALTER TABLE apify_runs ADD COLUMN IF NOT EXISTS credential_source text NOT NULL DEFAULT 'own';
ALTER TABLE apify_runs DROP CONSTRAINT IF EXISTS apify_runs_credential_source_chk;
ALTER TABLE apify_runs ADD CONSTRAINT apify_runs_credential_source_chk
  CHECK (credential_source IN ('managed', 'own'));

-- unipile_account_owners: which organization owns each Unipile account. The
-- authority every list, sync, send and webhook is filtered by
-- (src/lib/unipile/ownership.server.ts). The account id stays globally
-- unique (a provider identity; inbound webhooks find the organization
-- through it). Rows are written only by a verified hosted-auth callback, by
-- a sync on the organization's own Unipile key, by an operator command, or by
-- the backfill below. Never reassigned: a released account keeps its row.
CREATE TABLE IF NOT EXISTS unipile_account_owners (
  account_id text PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  channel text NOT NULL,
  credential_source text NOT NULL,
  claimed_via text NOT NULL,
  claimed_by uuid,
  -- The Unipile v2 Scope the account is assigned to, once Scopes are used (not yet).
  scope_id text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  CONSTRAINT unipile_account_owners_channel_chk CHECK (channel IN ('linkedin', 'whatsapp', 'instagram', 'email')),
  CONSTRAINT unipile_account_owners_source_chk CHECK (credential_source IN ('managed', 'own')),
  CONSTRAINT unipile_account_owners_via_chk CHECK (claimed_via IN ('hosted_auth', 'existing', 'own_sync', 'operator')),
  CONSTRAINT unipile_account_owners_status_chk CHECK (status IN ('active', 'released'))
);
CREATE INDEX IF NOT EXISTS unipile_account_owners_org_idx ON unipile_account_owners (organization_id, channel, status);

-- unipile_connect_states: one hosted-auth link the server minted for a
-- signed-in workspace. Its id is the link's opaque `name`; the notify_url
-- carries a per-link secret token whose sha256 is stored here. A callback
-- is honoured only for a pending, unexpired state with the right token.
CREATE TABLE IF NOT EXISTS unipile_connect_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL,
  channel text NOT NULL,
  kind text NOT NULL,
  reconnect_account_id text,
  credential_source text NOT NULL,
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  account_id text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  CONSTRAINT unipile_connect_states_channel_chk CHECK (channel IN ('linkedin', 'whatsapp', 'instagram', 'email')),
  CONSTRAINT unipile_connect_states_kind_chk CHECK (kind IN ('create', 'reconnect')),
  CONSTRAINT unipile_connect_states_source_chk CHECK (credential_source IN ('managed', 'own')),
  CONSTRAINT unipile_connect_states_status_chk CHECK (status IN ('pending', 'claimed', 'rejected', 'expired'))
);
CREATE INDEX IF NOT EXISTS unipile_connect_states_org_idx ON unipile_connect_states (organization_id, created_at);

-- Every account an organization already holds gets its ownership row, for
-- that organization (idempotent: an account already owned keeps its owner).
-- A conflict (the same account id held by two organizations' tables) is
-- not resolved here: scripts/add-managed-saas.ts reports it after this runs.
INSERT INTO unipile_account_owners (account_id, organization_id, channel, credential_source, claimed_via)
SELECT "linkedinId", "organizationId", 'linkedin', 'own', 'existing' FROM "LinkedInAccount"
WHERE coalesce("linkedinId", '') <> ''
ON CONFLICT (account_id) DO NOTHING;

INSERT INTO unipile_account_owners (account_id, organization_id, channel, credential_source, claimed_via)
SELECT unipile_account_id, organization_id, 'whatsapp', 'own', 'existing' FROM whatsapp_accounts
WHERE coalesce(unipile_account_id, '') <> ''
ON CONFLICT (account_id) DO NOTHING;

INSERT INTO unipile_account_owners (account_id, organization_id, channel, credential_source, claimed_via)
SELECT unipile_account_id, organization_id, 'instagram', 'own', 'existing' FROM instagram_accounts
WHERE coalesce(unipile_account_id, '') <> ''
ON CONFLICT (account_id) DO NOTHING;

INSERT INTO unipile_account_owners (account_id, organization_id, channel, credential_source, claimed_via)
SELECT unipile_account_id, organization_id, 'email', 'own', 'existing' FROM outreach_mailboxes
WHERE coalesce(unipile_account_id, '') <> ''
ON CONFLICT (account_id) DO NOTHING;
