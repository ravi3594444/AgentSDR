-- Wrong number: a contact route recorded as reaching someone other than the
-- intended lead (src/lib/crm/wrongNumber.ts, wrongRoutes.ts), and the
-- "Wrong Number" reply subcategory for every existing pipeline (new
-- pipelines get it from src/lib/crm/defaults.ts). Additive and re-runnable.

CREATE TABLE IF NOT EXISTS crm_wrong_routes (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid REFERENCES people(id) ON DELETE SET NULL,
  channel text NOT NULL,
  route text NOT NULL,
  crm_record_id uuid,
  conversation_id uuid,
  message_id uuid,
  source text NOT NULL,
  reason text,
  ack_status text NOT NULL DEFAULT 'none',
  ack_reason text,
  ack_draft_id uuid,
  ack_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crm_wrong_routes_channel_chk CHECK (channel IN ('email', 'whatsapp', 'linkedin', 'instagram')),
  CONSTRAINT crm_wrong_routes_route_chk CHECK (length(btrim(route)) > 0),
  CONSTRAINT crm_wrong_routes_source_chk CHECK (source IN ('reply_agent', 'classifier', 'human')),
  CONSTRAINT crm_wrong_routes_ack_status_chk CHECK (ack_status IN ('none', 'drafted', 'reserved', 'sending', 'sent', 'failed', 'uncertain', 'blocked'))
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_wrong_routes_org_route_uq ON crm_wrong_routes (organization_id, channel, route);
CREATE INDEX IF NOT EXISTS crm_wrong_routes_person_idx ON crm_wrong_routes (organization_id, person_id);
CREATE UNIQUE INDEX IF NOT EXISTS crm_wrong_routes_ack_draft_uq ON crm_wrong_routes (ack_draft_id) WHERE ack_draft_id IS NOT NULL;

INSERT INTO crm_subcategories (pipeline_id, category_key, key, name, description, classification_guidance, sort_order, stage_rank)
SELECT p.id, 'other', 'wrong_number', 'Wrong Number',
  'The number, address or profile reached someone other than the intended lead.',
  'Use when the person who replied says this is a wrong number or that they are not the person we meant to reach, without referring us to the right contact. Outreach to this route stops; at most one brief apology is sent, never a sales message. If they also ask to stop or unsubscribe, use Do Not Contact instead.',
  15, NULL
FROM crm_pipelines p
ON CONFLICT (pipeline_id, key) DO NOTHING;
