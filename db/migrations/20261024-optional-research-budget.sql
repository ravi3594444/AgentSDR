-- No request-level spending cap unless the owner supplies one.
-- Existing requests keep their recorded caps; only the nullability changes.
ALTER TABLE assistant_objectives ALTER COLUMN spend_cap_usd DROP NOT NULL;
