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
