-- Durable completion reports for the assistant's background jobs
-- (src/lib/assistant/worker.ts): the report key, written with a job's
-- terminal status, and when its report was posted to the chat (in the same
-- transaction as the event). The worker posts any report a restart lost.
-- Jobs finished before this migration have no report key and are never
-- reported again. Additive and re-runnable.

ALTER TABLE assistant_jobs ADD COLUMN IF NOT EXISTS report_key text;
ALTER TABLE assistant_jobs ADD COLUMN IF NOT EXISTS reported_at timestamptz;
CREATE INDEX IF NOT EXISTS assistant_jobs_unreported_idx ON assistant_jobs (finished_at)
  WHERE report_key IS NOT NULL AND reported_at IS NULL;
