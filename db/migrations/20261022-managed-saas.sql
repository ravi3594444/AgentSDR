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
