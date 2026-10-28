-- Website access for connected browsers: a selected-sites connection may
-- list specific websites by domain beside the site switches. All websites
-- is every site key in `sites`, as before. Safe to re-run.
ALTER TABLE browser_connections ADD COLUMN IF NOT EXISTS domains text[] NOT NULL DEFAULT ARRAY[]::text[];
