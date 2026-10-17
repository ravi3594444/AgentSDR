ALTER TABLE public.instagram_accounts ADD COLUMN IF NOT EXISTS outreach_next_send_at timestamptz;
CREATE TABLE IF NOT EXISTS public.instagram_outreach_queue (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES public.organizations(id),
 run_id uuid NOT NULL REFERENCES public.outreach_runs(id) ON DELETE CASCADE,
 person_id uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
 account_id uuid NOT NULL REFERENCES public.instagram_accounts(id),
 username text NOT NULL,
 messaging_id text,
 body text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CONSTRAINT instagram_outreach_status_chk CHECK (status IN ('queued','resolving','sending','sent','failed','uncertain','cancelled')),
 locked_until timestamptz,
 locked_by text,
 attempted_at timestamptz,
 sent_at timestamptz,
 chat_id text,
 message_id text,
 error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT instagram_outreach_run_person_uq UNIQUE(run_id,person_id)
);
CREATE INDEX IF NOT EXISTS instagram_outreach_due_idx ON public.instagram_outreach_queue(status,created_at);
CREATE INDEX IF NOT EXISTS instagram_outreach_org_account_idx ON public.instagram_outreach_queue(organization_id,account_id,attempted_at);
