-- Activity (src/lib/activity/): when each person last looked at the replies
-- list, for the "new replies" badge. Additive and re-runnable.

CREATE TABLE IF NOT EXISTS activity_seen (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL,
  replies_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activity_seen_pkey PRIMARY KEY (organization_id, user_id)
);
