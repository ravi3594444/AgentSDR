-- Bright Data research (src/lib/brightdata/, src/lib/discovery/socialResearch*.ts).
--
-- brightdata_settings: one organization's Bright Data key (encrypted), its
-- monthly credit limit, the most records one research job may collect, an
-- optional SERP API zone, and whether Reddit research is on. Its
-- collections are rows of provider_usage (provider 'brightdata').
--
-- organization_features key 'brightdata': the switch that turns it on.
--
-- assistant_jobs kind 'social_research': the job that searches Reddit and
-- reads X, Instagram and Facebook posts, profiles and pages through it.
--
-- Additive and re-runnable.

CREATE TABLE IF NOT EXISTS brightdata_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  encrypted_key text,
  key_hint text,
  monthly_credits integer NOT NULL DEFAULT 1000,
  max_records_per_search integer NOT NULL DEFAULT 60,
  serp_zone text,
  reddit_enabled boolean NOT NULL DEFAULT false,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT brightdata_settings_limits_chk CHECK (monthly_credits BETWEEN 0 AND 100000 AND max_records_per_search BETWEEN 5 AND 300)
);

-- Finding a job's collection again by its key (a retried step) and summing the month's credits.
CREATE INDEX IF NOT EXISTS provider_usage_job_idx ON provider_usage (job_id) WHERE job_id IS NOT NULL;

ALTER TABLE assistant_jobs DROP CONSTRAINT IF EXISTS assistant_jobs_kind_chk;
ALTER TABLE assistant_jobs ADD CONSTRAINT assistant_jobs_kind_chk
  CHECK (kind IN ('discovery', 'outreach_start', 'linkedin_search', 'web_discovery', 'apify_instagram', 'objective', 'social_research'));

ALTER TABLE organization_features DROP CONSTRAINT IF EXISTS organization_features_key_chk;
ALTER TABLE organization_features ADD CONSTRAINT organization_features_key_chk
  CHECK (key IN ('instagram', 'web_discovery', 'inquiry_intake', 'apify_discovery', 'treg', 'brightdata'));
