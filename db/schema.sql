-- AgentSDR database schema — GENERATED, do not edit by hand.
--
-- Regenerate with `bun run db:schema:dump` after applying a migration;
-- apply to an empty database with `bun run db:setup`.
-- The migrations that built it, in order, are in scripts/ (see CLAUDE.md).

--
-- PostgreSQL database dump
--

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;

--
-- Name: AccountStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."AccountStatus" AS ENUM (
    'CONNECTED',
    'DISCONNECTED'
);

--
-- Name: CampaignStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."CampaignStatus" AS ENUM (
    'ACTIVE',
    'PAUSED'
);

--
-- Name: CampaignType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."CampaignType" AS ENUM (
    'REGULAR',
    'PERSONAL'
);

--
-- Name: LeadStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."LeadStatus" AS ENUM (
    'PENDING',
    'REQUEST_SENT',
    'CONNECTED',
    'ACCEPT_MESSAGE_SENT',
    'FOLLOW_UP_1_SENT',
    'FOLLOW_UP_2_SENT',
    'REPLIED',
    'FAILED',
    'FOLLOW_UP_3_SENT',
    'COMPLETED',
    'CANCELLED'
);

--
-- Name: MessageType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."MessageType" AS ENUM (
    'INVITATION',
    'ACCEPTANCE',
    'FOLLOW_UP_1',
    'FOLLOW_UP_2',
    'RECEIVED',
    'CUSTOM_SENT',
    'FOLLOW_UP_3'
);

--
-- Name: SearchBatchKind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."SearchBatchKind" AS ENUM (
    'SINGLE',
    'BULK'
);

--
-- Name: SearchQueryStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."SearchQueryStatus" AS ENUM (
    'QUEUED',
    'RUNNING',
    'PAUSED_LIMIT',
    'COMPLETED',
    'FAILED',
    'CANCELLED'
);

--
-- Name: crm_categories_protect_system_rows(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_categories_protect_system_rows() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'system CRM categories cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.key IS DISTINCT FROM NEW.key
     OR OLD.label IS DISTINCT FROM NEW.label
     OR OLD.sort_order IS DISTINCT FROM NEW.sort_order
     OR OLD.is_system IS DISTINCT FROM NEW.is_system THEN
    RAISE EXCEPTION 'system CRM categories cannot be changed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: crm_classifications_validate_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_classifications_validate_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  record_pipeline_id uuid;
BEGIN
  SELECT pipeline_id INTO record_pipeline_id
    FROM crm_records
   WHERE id = NEW.crm_record_id;

  IF NOT EXISTS (
    SELECT 1
      FROM crm_conversation_messages message
      JOIN crm_conversations conversation ON conversation.id = message.conversation_id
     WHERE message.id = NEW.message_id
       AND message.direction = 'inbound'
       AND conversation.crm_record_id = NEW.crm_record_id
  ) THEN
    RAISE EXCEPTION 'classification message must be inbound and belong to its CRM record'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.previous_subcategory_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM crm_subcategories
     WHERE id = NEW.previous_subcategory_id
       AND pipeline_id = record_pipeline_id
       AND category_key = NEW.previous_category_key
  ) THEN
    RAISE EXCEPTION 'previous classification subcategory does not match its category and pipeline'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.proposed_subcategory_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM crm_subcategories
     WHERE id = NEW.proposed_subcategory_id
       AND pipeline_id = record_pipeline_id
       AND category_key = NEW.proposed_category_key
  ) THEN
    RAISE EXCEPTION 'proposed classification subcategory does not match its category and pipeline'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.applied_subcategory_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM crm_subcategories
     WHERE id = NEW.applied_subcategory_id
       AND pipeline_id = record_pipeline_id
       AND category_key = NEW.applied_category_key
  ) THEN
    RAISE EXCEPTION 'applied classification subcategory does not match its category and pipeline'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: crm_conversation_messages_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_conversation_messages_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'crm_conversation_messages is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

--
-- Name: crm_conversations_immutable_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_conversations_immutable_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.crm_record_id IS DISTINCT FROM NEW.crm_record_id
     OR OLD.person_id IS DISTINCT FROM NEW.person_id
     OR OLD.channel IS DISTINCT FROM NEW.channel
     OR OLD.account_ref IS DISTINCT FROM NEW.account_ref THEN
    RAISE EXCEPTION
      'crm_conversations id, crm_record_id, person_id, channel, and account_ref are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: crm_drafts_validate_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_drafts_validate_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE conversation_channel text;
BEGIN
  SELECT channel INTO conversation_channel FROM crm_conversations
   WHERE id = NEW.conversation_id AND crm_record_id = NEW.crm_record_id;
  IF conversation_channel IS NULL OR conversation_channel <> NEW.channel THEN
    RAISE EXCEPTION 'draft channel and record must match its conversation'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reply_for_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM crm_conversation_messages
     WHERE id = NEW.reply_for_message_id AND conversation_id = NEW.conversation_id AND direction = 'inbound'
  ) THEN
    RAISE EXCEPTION 'reply draft target must be inbound in its conversation'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.sequence_step_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM crm_sequence_step_runs step_run
      JOIN crm_sequence_runs run ON run.id = step_run.sequence_run_id
     WHERE step_run.id = NEW.sequence_step_run_id
       AND run.crm_record_id = NEW.crm_record_id
       AND run.conversation_id = NEW.conversation_id
  ) THEN
    RAISE EXCEPTION 'draft step run must belong to its record and conversation'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: crm_events_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_events_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'crm_events is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

--
-- Name: crm_jobs_validate_entity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_jobs_validate_entity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.entity_type = 'message'
     AND NOT EXISTS (SELECT 1 FROM crm_conversation_messages WHERE id = NEW.entity_id) THEN
    RAISE EXCEPTION 'classification job message does not exist' USING ERRCODE = 'foreign_key_violation';
  ELSIF NEW.entity_type = 'classification'
     AND NOT EXISTS (SELECT 1 FROM crm_classifications WHERE id = NEW.entity_id) THEN
    RAISE EXCEPTION 'initial draft job classification does not exist' USING ERRCODE = 'foreign_key_violation';
  ELSIF NEW.entity_type = 'sequence_step_run'
     AND NOT EXISTS (SELECT 1 FROM crm_sequence_step_runs WHERE id = NEW.entity_id) THEN
    RAISE EXCEPTION 'follow-up draft job step run does not exist' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: crm_knowledge_documents_validate_latest(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_knowledge_documents_validate_latest() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE maximum_version integer;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.latest_version < OLD.latest_version THEN
    RAISE EXCEPTION 'Knowledge latest version cannot move backwards' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.latest_version IS DISTINCT FROM OLD.latest_version THEN
    SELECT max(version) INTO maximum_version
      FROM crm_knowledge_document_versions WHERE document_id = NEW.id;
    IF maximum_version IS NULL OR NEW.latest_version <> maximum_version THEN
      RAISE EXCEPTION 'latest_version must point at the newest Knowledge version'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: crm_knowledge_versions_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_knowledge_versions_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Knowledge document versions are append-only' USING ERRCODE = 'restrict_violation';
END;
$$;

--
-- Name: crm_knowledge_versions_validate_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_knowledge_versions_validate_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE expected_version integer;
BEGIN
  SELECT COALESCE(max(version), 0) + 1 INTO expected_version
    FROM crm_knowledge_document_versions WHERE document_id = NEW.document_id;
  IF NEW.version <> expected_version THEN
    RAISE EXCEPTION 'Knowledge versions must be consecutive; expected %', expected_version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: crm_knowledge_versions_validate_owner_latest(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_knowledge_versions_validate_owner_latest() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE owner_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.document_id ELSE NEW.document_id END;
        declared_latest integer; maximum_version integer;
BEGIN
  SELECT latest_version INTO declared_latest FROM crm_knowledge_documents WHERE id = owner_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT max(version) INTO maximum_version
    FROM crm_knowledge_document_versions WHERE document_id = owner_id;
  IF declared_latest IS DISTINCT FROM maximum_version THEN
    RAISE EXCEPTION 'Knowledge latest_version must identify its newest version'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

--
-- Name: crm_records_validate_latest_inbound(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_records_validate_latest_inbound() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.latest_inbound_message_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM crm_conversation_messages message
      JOIN crm_conversations conversation ON conversation.id = message.conversation_id
     WHERE message.id = NEW.latest_inbound_message_id
       AND message.direction = 'inbound'
       AND message.person_id = NEW.person_id
       AND conversation.crm_record_id = NEW.id
  ) THEN
    RAISE EXCEPTION
      'latest_inbound_message_id must reference an inbound message for this CRM record'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: crm_send_attempts_protect_terminal(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_send_attempts_protect_terminal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status IN ('sent', 'reconciled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a terminal send attempt cannot change status'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'delivery_uncertain'
     AND NEW.status NOT IN ('delivery_uncertain', 'reconciled') THEN
    RAISE EXCEPTION 'delivery-uncertain attempts require reconciliation'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: crm_send_attempts_validate_account(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_send_attempts_validate_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM crm_drafts draft
      JOIN crm_conversations conversation ON conversation.id = draft.conversation_id
     WHERE draft.id = NEW.draft_id AND conversation.account_ref = NEW.account_ref
  ) THEN
    RAISE EXCEPTION 'send attempt account must match the draft conversation account'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: crm_sequence_runs_validate_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_sequence_runs_validate_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE record_pipeline uuid; conversation_channel text;
BEGIN
  SELECT pipeline_id INTO record_pipeline FROM crm_records WHERE id = NEW.crm_record_id;
  SELECT channel INTO conversation_channel FROM crm_conversations
   WHERE id = NEW.conversation_id AND crm_record_id = NEW.crm_record_id;
  IF conversation_channel IS NULL THEN
    RAISE EXCEPTION 'sequence run conversation must belong to its CRM record'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crm_sequence_versions
     WHERE id = NEW.sequence_version_id AND sequence_id = NEW.sequence_id AND status = 'published'
  ) THEN
    RAISE EXCEPTION 'sequence runs must pin a published version'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crm_subcategories WHERE id = NEW.subcategory_id AND pipeline_id = record_pipeline
  ) THEN
    RAISE EXCEPTION 'sequence run subcategory must belong to its record pipeline'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crm_conversation_messages
     WHERE id = NEW.trigger_message_id AND conversation_id = NEW.conversation_id AND direction = 'inbound'
  ) THEN
    RAISE EXCEPTION 'sequence run trigger must be an inbound message in its conversation'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crm_sequence_steps
     WHERE sequence_version_id = NEW.sequence_version_id AND position = NEW.start_step_position
  ) THEN
    RAISE EXCEPTION 'sequence run start step must exist in the pinned version'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: crm_sequence_step_runs_validate_scope(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_sequence_step_runs_validate_scope() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE pinned_version uuid; run_conversation uuid;
BEGIN
  SELECT sequence_version_id, conversation_id INTO pinned_version, run_conversation
    FROM crm_sequence_runs WHERE id = NEW.sequence_run_id;
  IF NOT EXISTS (
    SELECT 1 FROM crm_sequence_steps WHERE id = NEW.sequence_step_id AND sequence_version_id = pinned_version
  ) THEN
    RAISE EXCEPTION 'step run step must belong to the run pinned version'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.sent_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM crm_conversation_messages
     WHERE id = NEW.sent_message_id AND conversation_id = run_conversation AND direction = 'outbound'
  ) THEN
    RAISE EXCEPTION 'sent message must be outbound in the sequence run conversation'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: crm_sequence_steps_require_draft(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_sequence_steps_require_draft() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE target_version_id uuid := COALESCE(NEW.sequence_version_id, OLD.sequence_version_id);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM crm_sequence_versions WHERE id = target_version_id AND status = 'draft') THEN
    RAISE EXCEPTION 'sequence steps can be changed only on a draft version'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: crm_sequence_versions_protect_published(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_sequence_versions_protect_published() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status = 'published' THEN
    RAISE EXCEPTION 'published sequence versions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'published' THEN
    RAISE EXCEPTION 'published sequence versions are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'published' AND OLD.status = 'draft' AND NOT EXISTS (
    SELECT 1 FROM crm_sequence_steps
     WHERE sequence_version_id = NEW.id AND position = 1 AND step_type = 'reply' AND delay_minutes = 0
  ) THEN
    RAISE EXCEPTION 'a sequence cannot be published without an immediate reply step'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD.id IS DISTINCT FROM NEW.id OR OLD.sequence_id IS DISTINCT FROM NEW.sequence_id
    OR OLD.version IS DISTINCT FROM NEW.version
  ) THEN
    RAISE EXCEPTION 'sequence version identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: crm_sequence_versions_validate_owner_pointers(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_sequence_versions_validate_owner_pointers() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE owner_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.sequence_id ELSE NEW.sequence_id END;
        current_draft uuid; current_published uuid; expected_published uuid;
BEGIN
  SELECT draft_version_id, latest_published_version_id
    INTO current_draft, current_published FROM crm_sequences WHERE id = owner_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crm_sequence_versions
     WHERE id = current_draft AND sequence_id = owner_id AND status = 'draft'
  ) THEN
    RAISE EXCEPTION 'sequence must point to its mutable draft version'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT id INTO expected_published FROM crm_sequence_versions
   WHERE sequence_id = owner_id AND status = 'published'
   ORDER BY version DESC LIMIT 1;
  IF current_published IS DISTINCT FROM expected_published THEN
    RAISE EXCEPTION 'sequence must point to its newest published version'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

--
-- Name: crm_sequences_validate_version_pointers(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_sequences_validate_version_pointers() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE current_draft uuid; current_published uuid; expected_published uuid;
BEGIN
  SELECT draft_version_id, latest_published_version_id
    INTO current_draft, current_published
    FROM crm_sequences WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM crm_sequence_versions
     WHERE id = current_draft AND sequence_id = NEW.id AND status = 'draft'
  ) THEN
    RAISE EXCEPTION 'draft_version_id must identify this sequence draft version'
      USING ERRCODE = 'check_violation';
  END IF;
  IF current_published IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM crm_sequence_versions
     WHERE id = current_published AND sequence_id = NEW.id AND status = 'published'
  ) THEN
    RAISE EXCEPTION 'latest_published_version_id must identify this sequence published version'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT id INTO expected_published FROM crm_sequence_versions
   WHERE sequence_id = NEW.id AND status = 'published'
   ORDER BY version DESC LIMIT 1;
  IF current_published IS DISTINCT FROM expected_published THEN
    RAISE EXCEPTION 'latest_published_version_id must identify the newest published version'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

--
-- Name: crm_subcategories_immutable_fields(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_subcategories_immutable_fields() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.key IS DISTINCT FROM NEW.key
     OR OLD.pipeline_id IS DISTINCT FROM NEW.pipeline_id
     OR OLD.category_key IS DISTINCT FROM NEW.category_key THEN
    RAISE EXCEPTION
      'crm_subcategories key, pipeline_id, and category_key are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: Campaign; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Campaign" (
    id text NOT NULL,
    name text NOT NULL,
    description text,
    status public."CampaignStatus" DEFAULT 'ACTIVE'::public."CampaignStatus" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    type public."CampaignType" DEFAULT 'REGULAR'::public."CampaignType" NOT NULL,
    "invitationMessage" text,
    "acceptanceMessage" text,
    "followUp1Message" text,
    "followUp2Message" text,
    "followUp3Message" text,
    "organizationId" uuid NOT NULL
);

--
-- Name: CampaignAccount; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."CampaignAccount" (
    "campaignId" text NOT NULL,
    "linkedinAccountId" text NOT NULL
);

--
-- Name: Connection; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Connection" (
    id text NOT NULL,
    "providerId" text NOT NULL,
    name text,
    headline text,
    "profilePictureUrl" text,
    "linkedinUrl" text,
    "chatId" text,
    "leadId" text,
    "linkedinAccountId" text,
    "connectedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "organizationId" uuid NOT NULL
);

--
-- Name: JobLog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."JobLog" (
    id text NOT NULL,
    "jobRunId" text NOT NULL,
    level text NOT NULL,
    message text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

--
-- Name: JobRun; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."JobRun" (
    id text NOT NULL,
    job text NOT NULL,
    status text DEFAULT 'RUNNING'::text NOT NULL,
    "startedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "finishedAt" timestamp(3) without time zone,
    error text
);

--
-- Name: Lead; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Lead" (
    id text NOT NULL,
    "linkedinUrl" text,
    status public."LeadStatus" DEFAULT 'PENDING'::public."LeadStatus" NOT NULL,
    "requestSentAt" timestamp(3) without time zone,
    "invitationMessage" text,
    "acceptanceMessage" text,
    "followUp1Message" text,
    "followUp1SentAt" timestamp(3) without time zone,
    "followUp2Message" text,
    "followUp2SentAt" timestamp(3) without time zone,
    "linkedinAccountId" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "providerId" text,
    "leadData" jsonb,
    "profilePictureUrl" text,
    headline text,
    location text,
    name text,
    "campaignId" text,
    "acceptMessageSentAt" timestamp(3) without time zone,
    "inviteRetryCount" integer DEFAULT 0 NOT NULL,
    "followUp3Message" text,
    "followUp3SentAt" timestamp(3) without time zone,
    "personId" uuid NOT NULL,
    "sourceLinkedinIdentifier" text,
    "sourceLinkedinApi" text,
    "resolveRetryCount" integer DEFAULT 0 NOT NULL,
    "resolveNextAttemptAt" timestamp(3) without time zone,
    "resolveLastError" text,
    "supersededByLeadId" text,
    "organizationId" uuid NOT NULL
);

--
-- Name: LinkedInAccount; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."LinkedInAccount" (
    id text NOT NULL,
    "linkedinId" text NOT NULL,
    username text NOT NULL,
    status public."AccountStatus" DEFAULT 'CONNECTED'::public."AccountStatus" NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "limitReached" boolean DEFAULT false NOT NULL,
    name text,
    headline text,
    "profileData" jsonb,
    "profilePictureUrl" text,
    "isPremium" boolean DEFAULT false NOT NULL,
    "workTimezone" text,
    "workStartTime" text,
    "workEndTime" text,
    "workDays" text,
    "nextAllowedRun" timestamp(3) without time zone,
    "searchLeadsToday" integer DEFAULT 0 NOT NULL,
    "organizationId" uuid NOT NULL,
    "dailyInviteLimit" integer
);

--
-- Name: Message; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."Message" (
    id text NOT NULL,
    type public."MessageType" NOT NULL,
    text text NOT NULL,
    "connectionId" text,
    "leadId" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "linkedinMessageId" text,
    seen boolean DEFAULT false NOT NULL,
    "duplicateOfMessageId" text,
    "organizationId" uuid NOT NULL
);

--
-- Name: SearchBatch; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SearchBatch" (
    id text NOT NULL,
    name text NOT NULL,
    kind public."SearchBatchKind" DEFAULT 'BULK'::public."SearchBatchKind" NOT NULL,
    "accountIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "organizationId" uuid NOT NULL
);

--
-- Name: SearchQuery; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SearchQuery" (
    id text NOT NULL,
    url text NOT NULL,
    status public."SearchQueryStatus" DEFAULT 'QUEUED'::public."SearchQueryStatus" NOT NULL,
    cursor text,
    "totalCount" integer,
    "leadsFetched" integer DEFAULT 0 NOT NULL,
    "lastError" text,
    "currentAccountId" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "startedAt" timestamp(3) without time zone,
    "completedAt" timestamp(3) without time zone,
    "companyName" text,
    "batchId" text NOT NULL
);

--
-- Name: SearchResult; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."SearchResult" (
    id text NOT NULL,
    "searchQueryId" text NOT NULL,
    "linkedinUrl" text NOT NULL,
    name text,
    headline text,
    location text,
    "profilePictureUrl" text,
    "networkDistance" text,
    "followersCount" integer,
    "sharedConnectionsCount" integer,
    raw jsonb,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "sourceLinkedinApi" text
);

--
-- Name: WebhookEvent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."WebhookEvent" (
    id text NOT NULL,
    event text NOT NULL,
    "accountType" text,
    "accountId" text,
    "senderId" text,
    "chatId" text,
    "messageText" text,
    "rawBody" jsonb NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "connectionId" text,
    "processingLog" jsonb,
    "processingStatus" text,
    "providerEventKey" text,
    "processingAttempt" integer DEFAULT 0 NOT NULL,
    "processingStartedAt" timestamp(3) without time zone,
    "nextAttemptAt" timestamp(3) without time zone,
    "processedAt" timestamp(3) without time zone,
    "organizationId" uuid NOT NULL
);

--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id uuid NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    password text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: apify_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.apify_runs (
    organization_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid,
    request_id text,
    actor_key text NOT NULL,
    actor_id text NOT NULL,
    apify_run_id text,
    dataset_id text,
    status text DEFAULT 'starting'::text NOT NULL,
    max_charge_usd double precision NOT NULL,
    max_items integer NOT NULL,
    usage_usd double precision,
    items_read integer DEFAULT 0 NOT NULL,
    partial boolean DEFAULT false NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT apify_runs_status_chk CHECK ((status = ANY (ARRAY['starting'::text, 'running'::text, 'succeeded'::text, 'partial'::text, 'failed'::text, 'refused'::text])))
);

--
-- Name: apify_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.apify_settings (
    organization_id uuid NOT NULL,
    encrypted_token text,
    token_hint text,
    approved_actors text[] DEFAULT '{}'::text[] NOT NULL,
    monthly_budget_usd double precision DEFAULT 10 NOT NULL,
    max_charge_per_run_usd double precision DEFAULT 2 NOT NULL,
    max_results_per_run integer DEFAULT 100 NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT apify_settings_limits_chk CHECK (((monthly_budget_usd >= (0)::double precision) AND (max_charge_per_run_usd > (0)::double precision) AND ((max_results_per_run >= 1) AND (max_results_per_run <= 500))))
);

--
-- Name: assistant_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assistant_jobs (
    organization_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    stage text DEFAULT 'queued'::text NOT NULL,
    thread_id uuid,
    audience_id uuid,
    run_id uuid,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    progress jsonb DEFAULT '{}'::jsonb NOT NULL,
    result jsonb,
    error text,
    external_id text,
    attempts integer DEFAULT 0 NOT NULL,
    run_after timestamp with time zone DEFAULT now() NOT NULL,
    locked_by text,
    heartbeat_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT assistant_jobs_kind_chk CHECK ((kind = ANY (ARRAY['discovery'::text, 'outreach_start'::text, 'linkedin_search'::text, 'web_discovery'::text, 'apify_instagram'::text]))),
    CONSTRAINT assistant_jobs_status_chk CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);

--
-- Name: assistant_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assistant_messages (
    organization_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    thread_id uuid NOT NULL,
    role text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    tool text,
    tool_input jsonb,
    tool_result jsonb,
    status text,
    attachments jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT assistant_messages_role_chk CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'tool'::text, 'event'::text]))),
    CONSTRAINT assistant_messages_status_chk CHECK (((status IS NULL) OR (status = ANY (ARRAY['running'::text, 'ok'::text, 'error'::text]))))
);

--
-- Name: assistant_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assistant_profiles (
    organization_id uuid NOT NULL,
    profile jsonb DEFAULT '{}'::jsonb NOT NULL,
    knowledge_document_id uuid,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: assistant_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assistant_threads (
    organization_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text DEFAULT 'Conversation'::text NOT NULL,
    created_by uuid,
    busy_since timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: assistant_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assistant_usage (
    organization_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    model text,
    cost_usd numeric(12,6),
    input_tokens integer,
    output_tokens integer,
    run_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: autopilot_replies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.autopilot_replies (
    organization_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    draft_id uuid NOT NULL,
    revision integer NOT NULL,
    conversation_id uuid NOT NULL,
    run_id uuid,
    person_id uuid,
    status text NOT NULL,
    reason text,
    "check" jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT autopilot_replies_status_chk CHECK ((status = ANY (ARRAY['reserved'::text, 'sent'::text, 'failed'::text, 'held'::text])))
);

--
-- Name: autopilot_takeovers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.autopilot_takeovers (
    organization_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    reason text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: call_campaign_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_campaign_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    person_id uuid NOT NULL,
    stage text DEFAULT 'to_call'::text NOT NULL,
    status text DEFAULT 'new'::text NOT NULL,
    status_updated_at timestamp with time zone,
    follow_up_at timestamp with time zone,
    notes text,
    call_count integer DEFAULT 0 NOT NULL,
    last_called_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    call_status text DEFAULT 'new'::text NOT NULL,
    unanswered_attempts integer DEFAULT 0 NOT NULL,
    CONSTRAINT call_campaign_contacts_call_count_chk CHECK ((call_count >= 0)),
    CONSTRAINT call_campaign_contacts_call_status_chk CHECK ((call_status = ANY (ARRAY['new'::text, 'calling'::text, 'no_answer'::text, 'busy'::text, 'connected'::text, 'not_on_whatsapp'::text, 'wrong_number'::text, 'failed'::text]))),
    CONSTRAINT call_campaign_contacts_stage_chk CHECK ((stage = ANY (ARRAY['to_call'::text, 'follow_up'::text, 'done'::text]))),
    CONSTRAINT call_campaign_contacts_unanswered_attempts_chk CHECK ((unanswered_attempts >= 0))
);

--
-- Name: call_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    organization_id uuid NOT NULL,
    CONSTRAINT call_campaigns_name_chk CHECK ((length(btrim(name)) > 0)),
    CONSTRAINT call_campaigns_status_chk CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text])))
);

--
-- Name: call_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    person_id uuid NOT NULL,
    campaign_contact_id uuid,
    call_session_id uuid,
    phone text NOT NULL,
    body text NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    CONSTRAINT call_messages_body_chk CHECK ((length(btrim(body)) > 0))
);

--
-- Name: call_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    person_id uuid NOT NULL,
    crm_record_id uuid,
    phone text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    upload_token_hash text NOT NULL,
    token_expires_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    duration_ms integer,
    recording_key text,
    recording_bytes integer,
    recording_content_type text,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    campaign_contact_id uuid,
    disposition text,
    transcript_status text DEFAULT 'none'::text NOT NULL,
    transcript jsonb,
    transcript_error text,
    transcribed_at timestamp with time zone,
    recording_offset_ms integer,
    organization_id uuid NOT NULL,
    CONSTRAINT call_sessions_duration_chk CHECK (((duration_ms IS NULL) OR (duration_ms >= 0))),
    CONSTRAINT call_sessions_recording_chk CHECK (((status = 'recorded'::text) = (recording_key IS NOT NULL))),
    CONSTRAINT call_sessions_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'recorded'::text, 'no_recording'::text, 'failed'::text]))),
    CONSTRAINT call_sessions_transcript_status_chk CHECK ((transcript_status = ANY (ARRAY['none'::text, 'pending'::text, 'done'::text, 'failed'::text])))
);

--
-- Name: campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    input_mode text NOT NULL,
    filters jsonb,
    job_titles text[],
    target_lead_count integer DEFAULT 3000 NOT NULL,
    accumulated_lead_count integer DEFAULT 0 NOT NULL,
    apollo_link text,
    status text DEFAULT 'building'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    target_mode text DEFAULT 'leads'::text NOT NULL,
    target_domain_count integer,
    organization_id uuid NOT NULL
);

--
-- Name: channel_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_settings (
    organization_id uuid NOT NULL,
    channel text NOT NULL,
    "values" jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: clean_domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clean_domains (
    domain text NOT NULL,
    merchant_name text,
    platform text,
    rank bigint,
    country_code text,
    annual_sales numeric,
    categories text,
    installed_apps text,
    installed_apps_names text,
    emails text,
    phones text,
    c1 text,
    c2 text,
    c3 text,
    installed_apps_array text[]
);

--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.companies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    domain text NOT NULL,
    name text,
    linkedin_url text,
    raw jsonb DEFAULT '{}'::jsonb NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL
);

--
-- Name: crm_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_categories (
    key text NOT NULL,
    label text NOT NULL,
    sort_order integer NOT NULL,
    is_system boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_categories_is_system_chk CHECK ((is_system IS TRUE)),
    CONSTRAINT crm_categories_key_chk CHECK ((key = ANY (ARRAY['customer'::text, 'interested'::text, 'not_interested'::text, 'other'::text]))),
    CONSTRAINT crm_categories_label_chk CHECK ((length(btrim(label)) > 0))
);

--
-- Name: crm_classifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_classifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    crm_record_id uuid NOT NULL,
    message_id uuid NOT NULL,
    expected_context_version integer NOT NULL,
    previous_category_key text,
    previous_subcategory_id uuid,
    proposed_category_key text,
    proposed_subcategory_id uuid,
    applied_category_key text,
    applied_subcategory_id uuid,
    confidence numeric(5,4),
    reasoning text,
    status text NOT NULL,
    provider text,
    model text,
    request jsonb,
    response jsonb,
    error text,
    acknowledged_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_classifications_confidence_chk CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
    CONSTRAINT crm_classifications_context_version_chk CHECK ((expected_context_version >= 0)),
    CONSTRAINT crm_classifications_failed_confidence_chk CHECK (((status = 'failed'::text) OR (confidence IS NOT NULL))),
    CONSTRAINT crm_classifications_status_chk CHECK ((status = ANY (ARRAY['proposed'::text, 'auto_applied'::text, 'accepted'::text, 'rejected'::text, 'overridden'::text, 'stale'::text, 'failed'::text])))
);

--
-- Name: crm_conversation_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_conversation_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    person_id uuid NOT NULL,
    channel text NOT NULL,
    account_ref text NOT NULL,
    direction text NOT NULL,
    idempotency_key text NOT NULL,
    provider_message_id text,
    subject text,
    body_text text NOT NULL,
    body_html text,
    raw jsonb,
    sent_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_conversation_messages_body_chk CHECK ((length(btrim(body_text)) > 0)),
    CONSTRAINT crm_conversation_messages_channel_chk CHECK ((channel = ANY (ARRAY['email'::text, 'linkedin'::text, 'whatsapp'::text, 'instagram'::text]))),
    CONSTRAINT crm_conversation_messages_direction_chk CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text]))),
    CONSTRAINT crm_conversation_messages_idempotency_chk CHECK ((length(btrim(idempotency_key)) > 0))
);

--
-- Name: crm_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    crm_record_id uuid NOT NULL,
    person_id uuid NOT NULL,
    channel text NOT NULL,
    account_ref text NOT NULL,
    provider_thread_id text,
    provider_contact_id text,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    CONSTRAINT crm_conversations_account_ref_chk CHECK ((length(btrim(account_ref)) > 0)),
    CONSTRAINT crm_conversations_channel_chk CHECK ((channel = ANY (ARRAY['email'::text, 'linkedin'::text, 'whatsapp'::text, 'instagram'::text]))),
    CONSTRAINT crm_conversations_status_chk CHECK ((status = ANY (ARRAY['active'::text, 'closed'::text])))
);

--
-- Name: crm_draft_knowledge_citations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_draft_knowledge_citations (
    draft_id uuid NOT NULL,
    document_version_id uuid NOT NULL,
    excerpt text NOT NULL,
    excerpt_hash text NOT NULL,
    rank numeric NOT NULL,
    CONSTRAINT crm_draft_knowledge_citations_excerpt_chk CHECK ((length(btrim(excerpt)) > 0)),
    CONSTRAINT crm_draft_knowledge_citations_hash_chk CHECK ((length(btrim(excerpt_hash)) > 0)),
    CONSTRAINT crm_draft_knowledge_citations_rank_chk CHECK ((rank >= (0)::numeric))
);

--
-- Name: crm_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_drafts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    crm_record_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    reply_for_message_id uuid,
    sequence_step_run_id uuid,
    expected_context_version integer NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    channel text NOT NULL,
    subject text,
    ai_body_text text,
    ai_body_html text,
    edited_body_text text,
    edited_body_html text,
    status text DEFAULT 'generating'::text NOT NULL,
    provider text,
    model text,
    request jsonb,
    response jsonb,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_drafts_channel_chk CHECK ((channel = ANY (ARRAY['email'::text, 'linkedin'::text, 'whatsapp'::text, 'instagram'::text]))),
    CONSTRAINT crm_drafts_context_chk CHECK ((expected_context_version >= 0)),
    CONSTRAINT crm_drafts_instagram_subject_chk CHECK (((channel <> 'instagram'::text) OR (subject IS NULL))),
    CONSTRAINT crm_drafts_linkedin_subject_chk CHECK (((channel <> 'linkedin'::text) OR (subject IS NULL))),
    CONSTRAINT crm_drafts_revision_chk CHECK ((revision > 0)),
    CONSTRAINT crm_drafts_status_chk CHECK ((status = ANY (ARRAY['generating'::text, 'awaiting_review'::text, 'sending'::text, 'sent'::text, 'discarded'::text, 'stale'::text, 'failed'::text, 'delivery_uncertain'::text]))),
    CONSTRAINT crm_drafts_whatsapp_subject_chk CHECK (((channel <> 'whatsapp'::text) OR (subject IS NULL)))
);

--
-- Name: crm_email_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_email_drafts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    reply_for_message_id uuid,
    subject text,
    body_html text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: crm_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    person_id uuid NOT NULL,
    crm_record_id uuid,
    pipeline_id uuid,
    event_type text NOT NULL,
    actor_type text NOT NULL,
    actor_ref text,
    from_data jsonb,
    to_data jsonb,
    meta jsonb,
    context_version integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    CONSTRAINT crm_events_actor_type_chk CHECK ((actor_type = ANY (ARRAY['ai'::text, 'human'::text, 'system'::text, 'integration'::text, 'authenticated_operator'::text]))),
    CONSTRAINT crm_events_context_version_chk CHECK (((context_version IS NULL) OR (context_version >= 0))),
    CONSTRAINT crm_events_event_type_chk CHECK ((length(btrim(event_type)) > 0)),
    CONSTRAINT crm_events_record_scope_chk CHECK ((((crm_record_id IS NULL) AND (pipeline_id IS NULL)) OR ((crm_record_id IS NOT NULL) AND (pipeline_id IS NOT NULL))))
);

--
-- Name: crm_identity_exceptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_identity_exceptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel text NOT NULL,
    account_ref text NOT NULL,
    source_event_key text NOT NULL,
    identity_value text,
    reason text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    resolved_person_id uuid,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    CONSTRAINT crm_identity_exceptions_channel_chk CHECK ((channel = ANY (ARRAY['email'::text, 'linkedin'::text, 'whatsapp'::text, 'instagram'::text]))),
    CONSTRAINT crm_identity_exceptions_reason_chk CHECK ((length(btrim(reason)) > 0)),
    CONSTRAINT crm_identity_exceptions_resolution_chk CHECK ((((status = 'open'::text) AND (resolved_person_id IS NULL) AND (resolved_at IS NULL)) OR ((status = 'resolved'::text) AND (resolved_person_id IS NOT NULL) AND (resolved_at IS NOT NULL)) OR ((status = 'ignored'::text) AND (resolved_person_id IS NULL) AND (resolved_at IS NOT NULL)))),
    CONSTRAINT crm_identity_exceptions_status_chk CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text, 'ignored'::text])))
);

--
-- Name: crm_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    run_after timestamp with time zone DEFAULT now() NOT NULL,
    locked_at timestamp with time zone,
    locked_by text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    failed_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    CONSTRAINT crm_jobs_attempts_chk CHECK (((attempts >= 0) AND (max_attempts > 0) AND (attempts <= max_attempts))),
    CONSTRAINT crm_jobs_completion_chk CHECK (((status = ANY (ARRAY['succeeded'::text, 'failed'::text])) = (completed_at IS NOT NULL))),
    CONSTRAINT crm_jobs_entity_type_chk CHECK ((entity_type = ANY (ARRAY['message'::text, 'classification'::text, 'sequence_step_run'::text, 'draft'::text]))),
    CONSTRAINT crm_jobs_failure_chk CHECK ((((status = 'failed'::text) = (failed_at IS NOT NULL)) AND ((status <> 'failed'::text) OR (length(btrim(last_error)) > 0)))),
    CONSTRAINT crm_jobs_idempotency_chk CHECK ((length(btrim(idempotency_key)) > 0)),
    CONSTRAINT crm_jobs_kind_chk CHECK ((kind = ANY (ARRAY['classification'::text, 'initial_draft'::text, 'due_followup_draft'::text, 'auto_send'::text]))),
    CONSTRAINT crm_jobs_kind_entity_chk CHECK ((((kind = 'classification'::text) AND (entity_type = 'message'::text)) OR ((kind = 'initial_draft'::text) AND (entity_type = 'classification'::text)) OR ((kind = 'due_followup_draft'::text) AND (entity_type = 'sequence_step_run'::text)) OR ((kind = 'auto_send'::text) AND (entity_type = 'draft'::text)))),
    CONSTRAINT crm_jobs_lock_chk CHECK ((((status = 'running'::text) AND (locked_at IS NOT NULL) AND (locked_by IS NOT NULL) AND (started_at IS NOT NULL)) OR ((status <> 'running'::text) AND (locked_at IS NULL) AND (locked_by IS NULL)))),
    CONSTRAINT crm_jobs_status_chk CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text])))
);

--
-- Name: crm_knowledge_document_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_knowledge_document_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    version integer NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_knowledge_document_versions_content_chk CHECK ((length(btrim(content)) > 0)),
    CONSTRAINT crm_knowledge_document_versions_version_chk CHECK ((version > 0))
);

--
-- Name: crm_knowledge_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_knowledge_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    kind text NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    always_include boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL,
    latest_version integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    CONSTRAINT crm_knowledge_documents_kind_chk CHECK ((kind = ANY (ARRAY['company'::text, 'product'::text, 'pricing'::text, 'faq'::text, 'case_study'::text, 'objection'::text, 'scheduling'::text, 'custom'::text]))),
    CONSTRAINT crm_knowledge_documents_latest_version_chk CHECK ((latest_version > 0)),
    CONSTRAINT crm_knowledge_documents_title_chk CHECK ((length(btrim(title)) > 0))
);

--
-- Name: crm_lead_ccs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_lead_ccs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    lead_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: crm_leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_leads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    first_name text,
    last_name text,
    company text,
    domain text,
    smartlead_lead_id text,
    smartlead_campaign_id text,
    campaign_id uuid,
    current_status_key text,
    previous_status_key text,
    state text DEFAULT 'pending'::text NOT NULL,
    followups_sent integer DEFAULT 0 NOT NULL,
    next_action_at timestamp with time zone,
    last_reply_at timestamp with time zone,
    last_action_at timestamp with time zone,
    do_not_contact boolean DEFAULT false NOT NULL,
    ai_confidence numeric,
    needs_review boolean DEFAULT false NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    mailbox text,
    organization_id uuid NOT NULL
);

--
-- Name: crm_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    direction text NOT NULL,
    smartlead_message_id text,
    subject text,
    body_text text,
    body_html text,
    from_email text,
    to_email text,
    sent_at timestamp with time zone,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now(),
    important boolean DEFAULT false NOT NULL,
    opened_at timestamp with time zone
);

--
-- Name: crm_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid,
    title text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    organization_id uuid NOT NULL
);

--
-- Name: crm_person_contact_policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_person_contact_policies (
    person_id uuid NOT NULL,
    do_not_contact boolean DEFAULT false NOT NULL,
    reason text,
    source text,
    set_at timestamp with time zone,
    cleared_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_person_contact_policies_reason_chk CHECK (((reason IS NULL) OR (length(btrim(reason)) > 0))),
    CONSTRAINT crm_person_contact_policies_source_chk CHECK (((source IS NULL) OR (source = ANY (ARRAY['human'::text, 'integration'::text, 'inbound_request'::text])))),
    CONSTRAINT crm_person_contact_policies_state_chk CHECK ((((do_not_contact IS TRUE) AND (source IS NOT NULL) AND (set_at IS NOT NULL) AND (cleared_at IS NULL)) OR ((do_not_contact IS FALSE) AND (source IS NOT NULL) AND (set_at IS NOT NULL) AND (cleared_at IS NOT NULL)) OR ((do_not_contact IS FALSE) AND (source IS NULL) AND (set_at IS NULL) AND (cleared_at IS NULL)))),
    CONSTRAINT crm_person_contact_policies_timestamp_chk CHECK (((set_at IS NULL) OR (cleared_at IS NULL) OR (cleared_at >= set_at)))
);

--
-- Name: crm_pipelines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_pipelines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    CONSTRAINT crm_pipelines_name_chk CHECK ((length(btrim(name)) > 0))
);

--
-- Name: crm_record_sequence_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_record_sequence_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    crm_record_id uuid NOT NULL,
    sequence_id uuid NOT NULL,
    source text NOT NULL,
    effective_at timestamp with time zone DEFAULT now() NOT NULL,
    cleared_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_record_sequence_overrides_source_chk CHECK ((source = ANY (ARRAY['human'::text, 'integration'::text]))),
    CONSTRAINT crm_record_sequence_overrides_time_chk CHECK (((cleared_at IS NULL) OR (cleared_at >= effective_at)))
);

--
-- Name: crm_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    person_id uuid NOT NULL,
    pipeline_id uuid NOT NULL,
    category_key text,
    subcategory_id uuid,
    workflow_state text DEFAULT 'unclassified'::text NOT NULL,
    category_source text,
    category_locked boolean DEFAULT false NOT NULL,
    active_channel text,
    latest_inbound_message_id uuid,
    context_version integer DEFAULT 0 NOT NULL,
    last_inbound_at timestamp with time zone,
    last_outbound_at timestamp with time zone,
    last_interaction_at timestamp with time zone,
    next_action_at timestamp with time zone,
    closed_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    CONSTRAINT crm_records_active_channel_chk CHECK (((active_channel IS NULL) OR (active_channel = ANY (ARRAY['email'::text, 'linkedin'::text, 'whatsapp'::text, 'instagram'::text])))),
    CONSTRAINT crm_records_category_lock_chk CHECK (((category_locked IS FALSE) OR (NOT (category_key IS DISTINCT FROM 'customer'::text)))),
    CONSTRAINT crm_records_category_source_chk CHECK (((category_source IS NULL) OR (category_source = ANY (ARRAY['ai'::text, 'human'::text, 'integration'::text])))),
    CONSTRAINT crm_records_category_source_presence_chk CHECK (((category_key IS NULL) = (category_source IS NULL))),
    CONSTRAINT crm_records_closed_reason_chk CHECK (((closed_reason IS NULL) OR (length(btrim(closed_reason)) > 0))),
    CONSTRAINT crm_records_context_version_chk CHECK ((context_version >= 0)),
    CONSTRAINT crm_records_subcategory_category_chk CHECK (((subcategory_id IS NULL) OR (category_key IS NOT NULL))),
    CONSTRAINT crm_records_workflow_state_chk CHECK ((workflow_state = ANY (ARRAY['unclassified'::text, 'classifying'::text, 'action_required'::text, 'waiting'::text, 'idle'::text, 'paused'::text, 'closed'::text, 'error'::text])))
);

--
-- Name: crm_send_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_send_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    draft_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    status text DEFAULT 'prepared'::text NOT NULL,
    actor_type text DEFAULT 'authenticated_operator'::text NOT NULL,
    request_id text NOT NULL,
    provider text NOT NULL,
    account_ref text NOT NULL,
    provider_request_id text,
    provider_message_id text,
    request jsonb,
    response jsonb,
    error text,
    reconciled_at timestamp with time zone,
    reconciliation_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_send_attempts_account_chk CHECK ((length(btrim(account_ref)) > 0)),
    CONSTRAINT crm_send_attempts_actor_chk CHECK ((actor_type = 'authenticated_operator'::text)),
    CONSTRAINT crm_send_attempts_idempotency_chk CHECK ((length(btrim(idempotency_key)) > 0)),
    CONSTRAINT crm_send_attempts_provider_chk CHECK ((length(btrim(provider)) > 0)),
    CONSTRAINT crm_send_attempts_reconciliation_chk CHECK (((status <> 'reconciled'::text) OR ((reconciled_at IS NOT NULL) AND (length(btrim(reconciliation_note)) > 0)))),
    CONSTRAINT crm_send_attempts_request_id_chk CHECK ((length(btrim(request_id)) > 0)),
    CONSTRAINT crm_send_attempts_status_chk CHECK ((status = ANY (ARRAY['prepared'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'delivery_uncertain'::text, 'reconciled'::text])))
);

--
-- Name: crm_sequence_channel_migration_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.crm_sequence_channel_migration_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: crm_sequence_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_sequence_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    crm_record_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    sequence_id uuid NOT NULL,
    sequence_version_id uuid NOT NULL,
    subcategory_id uuid NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    current_step_position integer DEFAULT 1 NOT NULL,
    start_step_position integer DEFAULT 1 NOT NULL,
    started_by text NOT NULL,
    trigger_message_id uuid NOT NULL,
    last_inbound_at_start timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    CONSTRAINT crm_sequence_runs_positions_chk CHECK (((start_step_position > 0) AND (current_step_position >= start_step_position))),
    CONSTRAINT crm_sequence_runs_started_by_chk CHECK ((started_by = ANY (ARRAY['ai_assignment'::text, 'human_override'::text]))),
    CONSTRAINT crm_sequence_runs_status_chk CHECK ((status = ANY (ARRAY['active'::text, 'interrupted'::text, 'paused'::text, 'completed'::text, 'cancelled'::text])))
);

--
-- Name: crm_sequence_step_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_sequence_step_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sequence_run_id uuid NOT NULL,
    sequence_step_id uuid NOT NULL,
    status text DEFAULT 'scheduled'::text NOT NULL,
    due_at timestamp with time zone NOT NULL,
    draft_id uuid,
    sent_message_id uuid,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_error text,
    expected_context_version integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_sequence_step_runs_attempts_chk CHECK ((attempt_count >= 0)),
    CONSTRAINT crm_sequence_step_runs_context_chk CHECK ((expected_context_version >= 0)),
    CONSTRAINT crm_sequence_step_runs_sent_message_chk CHECK (((status <> 'sent'::text) OR (sent_message_id IS NOT NULL))),
    CONSTRAINT crm_sequence_step_runs_status_chk CHECK ((status = ANY (ARRAY['scheduled'::text, 'drafting'::text, 'awaiting_review'::text, 'sent'::text, 'skipped'::text, 'cancelled'::text, 'failed'::text])))
);

--
-- Name: crm_sequence_steps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_sequence_steps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sequence_version_id uuid NOT NULL,
    "position" integer NOT NULL,
    step_type text NOT NULL,
    name text NOT NULL,
    delay_minutes integer NOT NULL,
    subject_template text,
    body_template text,
    ai_instructions text NOT NULL,
    knowledge_tags text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_sequence_steps_ai_instructions_chk CHECK ((length(btrim(ai_instructions)) > 0)),
    CONSTRAINT crm_sequence_steps_delay_chk CHECK ((delay_minutes >= 0)),
    CONSTRAINT crm_sequence_steps_name_chk CHECK ((length(btrim(name)) > 0)),
    CONSTRAINT crm_sequence_steps_position_chk CHECK (("position" > 0)),
    CONSTRAINT crm_sequence_steps_semantics_chk CHECK (((("position" = 1) AND (step_type = 'reply'::text) AND (delay_minutes = 0)) OR (("position" > 1) AND (step_type = 'follow_up'::text))))
);

--
-- Name: crm_sequence_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_sequence_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sequence_id uuid NOT NULL,
    version integer NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_sequence_versions_published_at_chk CHECK ((((status = 'draft'::text) AND (published_at IS NULL)) OR ((status = 'published'::text) AND (published_at IS NOT NULL)))),
    CONSTRAINT crm_sequence_versions_status_chk CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text]))),
    CONSTRAINT crm_sequence_versions_version_chk CHECK ((version > 0))
);

--
-- Name: crm_sequences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_sequences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    status text DEFAULT 'active'::text NOT NULL,
    draft_version_id uuid NOT NULL,
    latest_published_version_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    CONSTRAINT crm_sequences_name_chk CHECK ((length(btrim(name)) > 0)),
    CONSTRAINT crm_sequences_status_chk CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))
);

--
-- Name: crm_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_settings (
    pipeline_id uuid NOT NULL,
    auto_apply_confidence numeric(4,3) DEFAULT 0.85 NOT NULL,
    review_other boolean DEFAULT true NOT NULL,
    customer_requires_review boolean DEFAULT true NOT NULL,
    human_send_only boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    draft_instructions jsonb,
    classification_instructions jsonb,
    CONSTRAINT crm_settings_confidence_chk CHECK (((auto_apply_confidence >= (0)::numeric) AND (auto_apply_confidence <= (1)::numeric))),
    CONSTRAINT crm_settings_human_send_only_chk CHECK ((human_send_only IS TRUE)),
    CONSTRAINT crm_settings_instructions_shape_chk CHECK ((((draft_instructions IS NULL) OR ((jsonb_typeof(draft_instructions) = 'array'::text) AND (length((draft_instructions)::text) <= 60000))) AND ((classification_instructions IS NULL) OR ((jsonb_typeof(classification_instructions) = 'array'::text) AND (length((classification_instructions)::text) <= 60000)))))
);

--
-- Name: crm_status_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_status_config (
    status_key text NOT NULL,
    label text NOT NULL,
    status_group text NOT NULL,
    pending_action text NOT NULL,
    followup_plan jsonb NOT NULL,
    closing_action text,
    is_terminal boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL
);

--
-- Name: crm_subcategories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_subcategories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pipeline_id uuid NOT NULL,
    category_key text NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    description text,
    classification_guidance text,
    active boolean DEFAULT true NOT NULL,
    review_required boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    stage_rank integer,
    CONSTRAINT crm_subcategories_key_chk CHECK ((key ~ '^[a-z][a-z0-9_]*$'::text)),
    CONSTRAINT crm_subcategories_name_chk CHECK ((length(btrim(name)) > 0)),
    CONSTRAINT crm_subcategories_sort_order_chk CHECK ((sort_order >= 0)),
    CONSTRAINT crm_subcategories_stage_rank_chk CHECK (((stage_rank IS NULL) OR (stage_rank >= 1)))
);

--
-- Name: crm_subcategory_sequence_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_subcategory_sequence_assignments (
    subcategory_id uuid NOT NULL,
    sequence_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: crm_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid,
    name text NOT NULL,
    description text,
    is_completed boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    organization_id uuid NOT NULL
);

--
-- Name: crm_webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.crm_webhook_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text DEFAULT 'smartlead'::text NOT NULL,
    event_type text,
    payload jsonb NOT NULL,
    processed boolean DEFAULT false NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now(),
    title text,
    status text DEFAULT 'ok'::text NOT NULL,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    organization_id uuid NOT NULL
);

--
-- Name: daily_summaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.daily_summaries (
    organization_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    day text NOT NULL,
    time_zone text NOT NULL,
    data jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.domains (
    domain text NOT NULL,
    about_us_url text,
    aliases text,
    android_app_id text,
    average_product_price numeric,
    average_product_price_usd numeric,
    average_product_weight numeric,
    brands_page_url text,
    categories text,
    city text,
    cluster_domains text,
    combined_avgrating numeric,
    combined_followers bigint,
    combined_reviews bigint,
    common_crawl_centrality numeric,
    common_crawl_pagerank numeric,
    company_ids text,
    company_location text,
    contact_page_url text,
    country_code text,
    created text,
    currency text,
    description text,
    domain_count bigint,
    domain_tld1 text,
    domain_url text,
    emails text,
    employee_count bigint,
    estimated_monthly_pageviews bigint,
    estimated_monthly_sales text,
    estimated_monthly_visits bigint,
    estimated_yearly_sales text,
    facebook text,
    facebook_group text,
    facebook_group_url text,
    facebook_url text,
    faq_page_url text,
    favicon_url text,
    features text,
    financing_page_url text,
    has_cms boolean,
    headless boolean,
    instagram text,
    instagram_url text,
    installed_apps text,
    installed_apps_count bigint,
    installed_apps_names text,
    ios_app_id text,
    judgeme_avgrating numeric,
    judgeme_reviews bigint,
    language_code text,
    last_plan text,
    last_plan_changed text,
    last_platform text,
    last_platform_changed text,
    last_theme text,
    last_theme_changed text,
    linkedin_account text,
    linkedin_url text,
    loox_avgrating numeric,
    loox_reviews bigint,
    maximum_product_price numeric,
    maximum_product_weight numeric,
    merchant_name text,
    meta_description text,
    meta_keywords text,
    minimum_product_price numeric,
    minimum_product_weight numeric,
    monthly_app_spend numeric,
    most_recent_product_image_url text,
    most_recent_product_title text,
    most_recent_product_url text,
    notes text,
    okendo_avgrating numeric,
    okendo_reviews bigint,
    open_graph_image_url text,
    phones text,
    pinterest text,
    pinterest_followers bigint,
    pinterest_followers_30d bigint,
    pinterest_followers_90d bigint,
    pinterest_posts bigint,
    pinterest_url text,
    plan text,
    platform text,
    platform_domain text,
    platform_rank bigint,
    platform_rank_percentile numeric,
    platform_version text,
    product_images bigint,
    product_images_created_30 bigint,
    product_images_created_365 bigint,
    product_images_created_90 bigint,
    product_to_vendor numeric,
    product_variants bigint,
    products_created_30 bigint,
    products_created_365 bigint,
    products_created_90 bigint,
    products_sold bigint,
    rank bigint,
    rank_percentile numeric,
    region text,
    retailer_url text,
    returns_page_url text,
    rio_avgrating numeric,
    rio_reviews bigint,
    sales_channel_abound text,
    sales_channel_amazon text,
    sales_channel_chownow text,
    sales_channel_doordash text,
    sales_channel_ebay text,
    sales_channel_etsy text,
    sales_channel_grubhub text,
    sales_channel_postmates text,
    sales_channel_ubereats text,
    sales_channels text,
    shipping_carriers text,
    ships_to_countries text,
    stamped_avgrating numeric,
    stamped_reviews bigint,
    state text,
    status text,
    store_locator_url text,
    street_address text,
    subregion text,
    tags text,
    technologies text,
    technologies_count bigint,
    theme text,
    theme_change_30 bigint,
    theme_change_90 bigint,
    theme_spend numeric,
    theme_style text,
    theme_vendor text,
    tiktok text,
    tiktok_followers bigint,
    tiktok_followers_30d bigint,
    tiktok_followers_90d bigint,
    tiktok_url text,
    title text,
    tracking_page_url text,
    trustpilot_avgrating numeric,
    trustpilot_reviews bigint,
    twitter text,
    twitter_followers bigint,
    twitter_followers_30d bigint,
    twitter_followers_90d bigint,
    twitter_posts bigint,
    twitter_url text,
    vendor_count bigint,
    warranty_page_url text,
    whatsapp text,
    whatsapp_url text,
    yotpo_avgrating numeric,
    yotpo_reviews bigint,
    youtube text,
    youtube_channel_url text,
    youtube_followers bigint,
    youtube_followers_30d bigint,
    youtube_followers_90d bigint,
    youtube_url text,
    zip text,
    annual_sales numeric
);

--
-- Name: entity_columns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_columns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity text NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    pg_type text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_core boolean DEFAULT false NOT NULL,
    "position" double precision NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL
);

--
-- Name: grid_cell_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grid_cell_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    table_id uuid NOT NULL,
    row_id uuid NOT NULL,
    column_key text NOT NULL,
    provider text,
    outcome text NOT NULL,
    cost_cents numeric(12,6) DEFAULT 0 NOT NULL,
    latency_ms integer,
    request jsonb,
    response jsonb,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: grid_columns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grid_columns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    table_id uuid NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    depends_on text[] DEFAULT '{}'::text[] NOT NULL,
    "position" double precision NOT NULL,
    auto_run boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

--
-- Name: grid_folders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grid_folders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    parent_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    organization_id uuid NOT NULL
);

--
-- Name: grid_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grid_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    table_id uuid NOT NULL,
    row_id uuid NOT NULL,
    column_key text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    run_after timestamp with time zone DEFAULT now(),
    locked_at timestamp with time zone,
    error text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    provider_state jsonb
);

--
-- Name: grid_provider_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grid_provider_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id uuid NOT NULL,
    encrypted_payload text NOT NULL,
    encryption_version text DEFAULT 'v1'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

--
-- Name: grid_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grid_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    base_url text,
    auth_env_var text,
    default_cost_cents numeric(12,6) DEFAULT 0 NOT NULL,
    rate_limit_per_min integer,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    organization_id uuid NOT NULL
);

--
-- Name: grid_row_version_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.grid_row_version_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: grid_rows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grid_rows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    table_id uuid NOT NULL,
    "position" double precision NOT NULL,
    cells jsonb DEFAULT '{}'::jsonb NOT NULL,
    cell_meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    version bigint DEFAULT nextval('public.grid_row_version_seq'::regclass) NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

--
-- Name: grid_tables; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grid_tables (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    auto_run boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    "position" double precision NOT NULL,
    workbook_id uuid NOT NULL,
    view jsonb DEFAULT '{}'::jsonb NOT NULL,
    organization_id uuid NOT NULL
);

--
-- Name: grid_workbooks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grid_workbooks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    folder_id uuid,
    organization_id uuid NOT NULL
);

--
-- Name: import_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text NOT NULL,
    grid_table_id uuid,
    filename text,
    destination text NOT NULL,
    mapping jsonb NOT NULL,
    stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    destination_campaign_id text,
    organization_id uuid NOT NULL
);

--
-- Name: inquiries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inquiries (
    organization_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text NOT NULL,
    endpoint_id uuid,
    instagram_chat_id uuid,
    dedupe_key text NOT NULL,
    person_id uuid,
    name text,
    email text,
    phone text,
    message text,
    fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    page_url text,
    historical boolean DEFAULT false NOT NULL,
    status text DEFAULT 'received'::text NOT NULL,
    reason text,
    submitted_at timestamp with time zone,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    raw jsonb,
    CONSTRAINT inquiries_source_chk CHECK ((source = ANY (ARRAY['website_form'::text, 'instagram'::text]))),
    CONSTRAINT inquiries_status_chk CHECK ((status = ANY (ARRAY['received'::text, 'unusable'::text])))
);

--
-- Name: instagram_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instagram_accounts (
    organization_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unipile_account_id text NOT NULL,
    username text,
    name text,
    provider_user_id text,
    status text DEFAULT 'connected'::text NOT NULL,
    connected_at timestamp with time zone,
    history_cutoff_at timestamp with time zone,
    connected_by uuid,
    inquiry_intake boolean DEFAULT false NOT NULL,
    last_synced_at timestamp with time zone,
    last_imported_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT instagram_accounts_status_chk CHECK ((status = ANY (ARRAY['connected'::text, 'disconnected'::text, 'credentials'::text, 'error'::text])))
);

--
-- Name: instagram_chats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instagram_chats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    unipile_chat_id text NOT NULL,
    provider_id text,
    username text,
    name text,
    person_id uuid,
    first_seen_via text DEFAULT 'webhook'::text NOT NULL,
    last_message_at timestamp with time zone,
    last_message_preview text,
    last_direction text,
    unread_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT instagram_chats_first_seen_chk CHECK ((first_seen_via = ANY (ARRAY['webhook'::text, 'import'::text, 'send'::text]))),
    CONSTRAINT instagram_chats_last_direction_chk CHECK (((last_direction IS NULL) OR (last_direction = ANY (ARRAY['inbound'::text, 'outbound'::text])))),
    CONSTRAINT instagram_chats_unread_chk CHECK ((unread_count >= 0))
);

--
-- Name: instagram_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instagram_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chat_id uuid NOT NULL,
    unipile_message_id text,
    direction text NOT NULL,
    origin text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    attachments jsonb DEFAULT '[]'::jsonb NOT NULL,
    sent_at timestamp with time zone NOT NULL,
    historical boolean DEFAULT false NOT NULL,
    crm_conversation_message_id uuid,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT instagram_messages_direction_chk CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text]))),
    CONSTRAINT instagram_messages_origin_chk CHECK ((origin = ANY (ARRAY['lead'::text, 'agentsdr'::text, 'phone'::text]))),
    CONSTRAINT instagram_messages_origin_direction_chk CHECK (((direction = 'inbound'::text) = (origin = 'lead'::text)))
);

--
-- Name: intake_endpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.intake_endpoints (
    organization_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    token_hash text NOT NULL,
    token_hint text NOT NULL,
    field_map jsonb DEFAULT '{}'::jsonb NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_by uuid,
    last_received_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    email text NOT NULL,
    role text,
    team_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    inviter_id uuid NOT NULL
);

--
-- Name: lead_audience_member_insights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lead_audience_member_insights (
    member_id uuid NOT NULL,
    match_reason text,
    signals jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: lead_audience_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lead_audience_members (
    organization_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    audience_id uuid NOT NULL,
    person_id uuid,
    company_id uuid,
    name text NOT NULL,
    status text NOT NULL,
    reason text,
    channels text[] DEFAULT ARRAY[]::text[] NOT NULL,
    source text NOT NULL,
    source_url text,
    evidence jsonb DEFAULT '[]'::jsonb NOT NULL,
    facts jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lead_audience_members_status_chk CHECK ((status = ANY (ARRAY['eligible'::text, 'excluded'::text])))
);

--
-- Name: lead_audiences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lead_audiences (
    organization_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    thread_id uuid,
    name text NOT NULL,
    source text NOT NULL,
    criteria jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lead_audiences_source_chk CHECK ((source = ANY (ARRAY['discovery'::text, 'list'::text])))
);

--
-- Name: lead_research; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lead_research (
    organization_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    kind text NOT NULL,
    question text NOT NULL,
    status text NOT NULL,
    answer text,
    sources jsonb DEFAULT '[]'::jsonb NOT NULL,
    provider text,
    model text,
    cost_usd numeric(12,6),
    error text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT lead_research_kind_chk CHECK ((kind = ANY (ARRAY['company'::text, 'website'::text, 'parent'::text, 'question'::text]))),
    CONSTRAINT lead_research_status_chk CHECK ((status = ANY (ARRAY['succeeded'::text, 'not_found'::text, 'failed'::text])))
);

--
-- Name: members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: organization_features; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization_features (
    organization_id uuid NOT NULL,
    key text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_features_key_chk CHECK ((key = ANY (ARRAY['instagram'::text, 'web_discovery'::text, 'inquiry_intake'::text, 'apify_discovery'::text])))
);

--
-- Name: organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    logo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata text
);

--
-- Name: outreach_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outreach_campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    sequence jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    organization_id uuid NOT NULL
);

--
-- Name: outreach_emails; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outreach_emails (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    mailbox_id uuid,
    step_number integer NOT NULL,
    subject text,
    body text,
    status text DEFAULT 'scheduled'::text NOT NULL,
    sent_at timestamp with time zone,
    gmail_message_id text,
    message_id text,
    thread_id text,
    in_reply_to text,
    "references" text[],
    error text,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: outreach_leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outreach_leads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    email text,
    first_name text,
    last_name text,
    company text,
    custom_fields jsonb DEFAULT '{}'::jsonb,
    sequence_status text DEFAULT 'pending'::text NOT NULL,
    current_step integer DEFAULT 0 NOT NULL,
    next_send_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    mailbox_id uuid,
    person_id uuid NOT NULL
);

--
-- Name: outreach_mailbox_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outreach_mailbox_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    mailbox_id uuid NOT NULL,
    lead_id uuid NOT NULL,
    "position" integer NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: outreach_mailboxes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outreach_mailboxes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email_address text NOT NULL,
    display_name text,
    status text DEFAULT 'connecting'::text NOT NULL,
    last_error text,
    last_tested_at timestamp with time zone,
    last_history_id text,
    daily_send_limit integer DEFAULT 30 NOT NULL,
    today_emails_sent integer DEFAULT 0 NOT NULL,
    send_counter_reset_at timestamp with time zone,
    next_email_time timestamp with time zone,
    signature_html text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    working_hours jsonb DEFAULT '{"days": {"friday": {"to": "18:00", "from": "09:00", "enabled": true}, "monday": {"to": "18:00", "from": "09:00", "enabled": true}, "sunday": {"to": "18:00", "from": "09:00", "enabled": false}, "tuesday": {"to": "18:00", "from": "09:00", "enabled": true}, "saturday": {"to": "18:00", "from": "09:00", "enabled": false}, "thursday": {"to": "18:00", "from": "09:00", "enabled": true}, "wednesday": {"to": "18:00", "from": "09:00", "enabled": true}}, "timezone": "America/New_York"}'::jsonb NOT NULL,
    organization_id uuid NOT NULL,
    provider text DEFAULT 'google'::text NOT NULL,
    unipile_account_id text,
    CONSTRAINT outreach_mailboxes_provider_chk CHECK ((provider = ANY (ARRAY['google'::text, 'unipile'::text])))
);

--
-- Name: outreach_run_leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outreach_run_leads (
    organization_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    person_id uuid NOT NULL,
    channel text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    stop_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT outreach_run_leads_channel_chk CHECK ((channel = ANY (ARRAY['email'::text, 'whatsapp'::text, 'linkedin'::text, 'instagram'::text]))),
    CONSTRAINT outreach_run_leads_status_chk CHECK ((status = ANY (ARRAY['active'::text, 'stopped'::text, 'opted_out'::text])))
);

--
-- Name: outreach_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outreach_runs (
    organization_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    thread_id uuid,
    audience_id uuid NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    channels text[] DEFAULT ARRAY[]::text[] NOT NULL,
    plan jsonb NOT NULL,
    campaigns jsonb DEFAULT '{}'::jsonb NOT NULL,
    autopilot boolean DEFAULT false NOT NULL,
    error text,
    approved_by uuid,
    approved_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    paused_at timestamp with time zone,
    stopped_at timestamp with time zone,
    CONSTRAINT outreach_runs_status_chk CHECK ((status = ANY (ARRAY['proposed'::text, 'starting'::text, 'running'::text, 'paused'::text, 'stopped'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])))
);

--
-- Name: outreach_suppression_list; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outreach_suppression_list (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    reason text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now(),
    organization_id uuid NOT NULL
);

--
-- Name: owner_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.owner_decisions (
    organization_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    reason text NOT NULL,
    decision text NOT NULL,
    lead_message text,
    person_id uuid,
    crm_record_id uuid,
    conversation_id uuid,
    draft_id uuid,
    run_id uuid,
    answer text,
    answered_by uuid,
    answered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    brief text,
    handover_sent_at timestamp with time zone,
    alerted_at timestamp with time zone,
    reminded_at timestamp with time zone,
    CONSTRAINT owner_decisions_kind_chk CHECK ((kind = ANY (ARRAY['missing_info'::text, 'complaint'::text, 'negotiation'::text, 'commitment'::text, 'uncertain'::text, 'meeting'::text, 'opt_out'::text, 'interested'::text, 'ready'::text, 'person'::text, 'limit'::text]))),
    CONSTRAINT owner_decisions_status_chk CHECK ((status = ANY (ARRAY['open'::text, 'answered'::text, 'resolved'::text])))
);

--
-- Name: people; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.people (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text,
    linkedin_url text,
    first_name text,
    last_name text,
    full_name text,
    title text,
    company_id uuid,
    raw jsonb DEFAULT '{}'::jsonb NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    profile_picture_url text,
    phone text,
    organization_id uuid NOT NULL,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL
);

--
-- Name: qualification_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qualification_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    domains_processed integer DEFAULT 0 NOT NULL,
    domains_qualified integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone DEFAULT now(),
    finished_at timestamp with time zone,
    requested_limit integer,
    current_domain text,
    last_heartbeat_at timestamp with time zone
);

--
-- Name: scheduled_job_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduled_job_runs (
    job text NOT NULL,
    slot timestamp with time zone NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    error text
);

--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ip_address text,
    user_agent text,
    user_id uuid NOT NULL,
    active_organization_id text,
    active_team_id text
);

--
-- Name: targeted_domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.targeted_domains (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    domain text NOT NULL,
    campaign_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    is_live boolean,
    is_running_ads boolean,
    apollo_org_id text,
    apollo_lead_count integer,
    apollo_org_employee_estimate integer,
    expected_employee_count integer,
    coverage_ratio numeric,
    parent_company text,
    parent_domain text,
    reason text,
    checked_at timestamp with time zone DEFAULT now(),
    verified_employee_count integer,
    parent_pending boolean DEFAULT false NOT NULL,
    all_lead_count integer,
    parent_id uuid,
    qualification_debug jsonb,
    is_parent_company boolean DEFAULT false NOT NULL,
    revenue numeric,
    organization_id uuid NOT NULL
);

--
-- Name: team_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid NOT NULL,
    membership_key text,
    created_at timestamp with time zone DEFAULT now()
);

--
-- Name: teams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teams (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    member_count integer DEFAULT 0 NOT NULL,
    organization_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone
);

--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: whatsapp_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    unipile_account_id text NOT NULL,
    name text,
    phone text,
    status text DEFAULT 'connected'::text NOT NULL,
    connected_at timestamp with time zone,
    is_default boolean DEFAULT false NOT NULL,
    last_synced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_id uuid NOT NULL,
    new_chats_per_day integer,
    CONSTRAINT whatsapp_accounts_status_chk CHECK ((status = ANY (ARRAY['connected'::text, 'disconnected'::text, 'credentials'::text, 'error'::text])))
);

--
-- Name: whatsapp_campaign_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_campaign_accounts (
    campaign_id uuid NOT NULL,
    account_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: whatsapp_campaign_leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_campaign_leads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    person_id uuid NOT NULL,
    phone text NOT NULL,
    custom_fields jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    current_step integer DEFAULT 0 NOT NULL,
    next_send_at timestamp with time zone,
    account_id uuid,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    last_sent_at timestamp with time zone,
    replied_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT whatsapp_campaign_leads_status_chk CHECK ((status = ANY (ARRAY['queued'::text, 'in_sequence'::text, 'completed'::text, 'replied'::text, 'stopped'::text, 'failed'::text]))),
    CONSTRAINT whatsapp_campaign_leads_step_chk CHECK ((current_step >= 0))
);

--
-- Name: whatsapp_campaign_sends; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_campaign_sends (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lead_id uuid NOT NULL,
    step integer NOT NULL,
    step_id text,
    status text DEFAULT 'sending'::text NOT NULL,
    account_id uuid,
    whatsapp_message_id uuid,
    body text,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT whatsapp_campaign_sends_status_chk CHECK ((status = ANY (ARRAY['sending'::text, 'sent'::text, 'failed'::text])))
);

--
-- Name: whatsapp_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_campaigns (
    organization_id uuid NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    status text DEFAULT 'paused'::text NOT NULL,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT whatsapp_campaigns_status_chk CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text])))
);

--
-- Name: whatsapp_chats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_chats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    unipile_chat_id text NOT NULL,
    provider_id text,
    phone text,
    person_id uuid,
    name text,
    last_message_at timestamp with time zone,
    last_message_preview text,
    last_direction text,
    unread_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT whatsapp_chats_last_direction_chk CHECK (((last_direction IS NULL) OR (last_direction = ANY (ARRAY['inbound'::text, 'outbound'::text])))),
    CONSTRAINT whatsapp_chats_unread_chk CHECK ((unread_count >= 0))
);

--
-- Name: whatsapp_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chat_id uuid NOT NULL,
    unipile_message_id text,
    direction text NOT NULL,
    origin text NOT NULL,
    body text DEFAULT ''::text NOT NULL,
    attachments jsonb DEFAULT '[]'::jsonb NOT NULL,
    sent_at timestamp with time zone NOT NULL,
    delivered_at timestamp with time zone,
    read_at timestamp with time zone,
    crm_conversation_message_id uuid,
    call_session_id uuid,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT whatsapp_messages_direction_chk CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text]))),
    CONSTRAINT whatsapp_messages_origin_chk CHECK ((origin = ANY (ARRAY['lead'::text, 'agentsdr'::text, 'phone'::text]))),
    CONSTRAINT whatsapp_messages_origin_direction_chk CHECK (((direction = 'inbound'::text) = (origin = 'lead'::text)))
);

--
-- Name: CampaignAccount CampaignAccount_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CampaignAccount"
    ADD CONSTRAINT "CampaignAccount_pkey" PRIMARY KEY ("campaignId", "linkedinAccountId");

--
-- Name: Campaign Campaign_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Campaign"
    ADD CONSTRAINT "Campaign_pkey" PRIMARY KEY (id);

--
-- Name: Connection Connection_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Connection"
    ADD CONSTRAINT "Connection_pkey" PRIMARY KEY (id);

--
-- Name: JobLog JobLog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."JobLog"
    ADD CONSTRAINT "JobLog_pkey" PRIMARY KEY (id);

--
-- Name: JobRun JobRun_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."JobRun"
    ADD CONSTRAINT "JobRun_pkey" PRIMARY KEY (id);

--
-- Name: Lead Lead_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Lead"
    ADD CONSTRAINT "Lead_pkey" PRIMARY KEY (id);

--
-- Name: LinkedInAccount LinkedInAccount_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LinkedInAccount"
    ADD CONSTRAINT "LinkedInAccount_pkey" PRIMARY KEY (id);

--
-- Name: Message Message_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_pkey" PRIMARY KEY (id);

--
-- Name: SearchBatch SearchBatch_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SearchBatch"
    ADD CONSTRAINT "SearchBatch_pkey" PRIMARY KEY (id);

--
-- Name: SearchQuery SearchQuery_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SearchQuery"
    ADD CONSTRAINT "SearchQuery_pkey" PRIMARY KEY (id);

--
-- Name: SearchResult SearchResult_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SearchResult"
    ADD CONSTRAINT "SearchResult_pkey" PRIMARY KEY (id);

--
-- Name: WebhookEvent WebhookEvent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WebhookEvent"
    ADD CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY (id);

--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);

--
-- Name: apify_runs apify_runs_apify_run_id_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apify_runs
    ADD CONSTRAINT apify_runs_apify_run_id_uq UNIQUE (apify_run_id);

--
-- Name: apify_runs apify_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apify_runs
    ADD CONSTRAINT apify_runs_pkey PRIMARY KEY (id);

--
-- Name: apify_settings apify_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apify_settings
    ADD CONSTRAINT apify_settings_pkey PRIMARY KEY (organization_id);

--
-- Name: assistant_jobs assistant_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_jobs
    ADD CONSTRAINT assistant_jobs_pkey PRIMARY KEY (id);

--
-- Name: assistant_messages assistant_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_messages
    ADD CONSTRAINT assistant_messages_pkey PRIMARY KEY (id);

--
-- Name: assistant_profiles assistant_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_profiles
    ADD CONSTRAINT assistant_profiles_pkey PRIMARY KEY (organization_id);

--
-- Name: assistant_threads assistant_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_threads
    ADD CONSTRAINT assistant_threads_pkey PRIMARY KEY (id);

--
-- Name: assistant_usage assistant_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_usage
    ADD CONSTRAINT assistant_usage_pkey PRIMARY KEY (id);

--
-- Name: autopilot_replies autopilot_replies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_replies
    ADD CONSTRAINT autopilot_replies_pkey PRIMARY KEY (id);

--
-- Name: autopilot_takeovers autopilot_takeovers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_takeovers
    ADD CONSTRAINT autopilot_takeovers_pkey PRIMARY KEY (id);

--
-- Name: call_campaign_contacts call_campaign_contacts_campaign_person_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_campaign_contacts
    ADD CONSTRAINT call_campaign_contacts_campaign_person_uq UNIQUE (campaign_id, person_id);

--
-- Name: call_campaign_contacts call_campaign_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_campaign_contacts
    ADD CONSTRAINT call_campaign_contacts_pkey PRIMARY KEY (id);

--
-- Name: call_campaigns call_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_campaigns
    ADD CONSTRAINT call_campaigns_pkey PRIMARY KEY (id);

--
-- Name: call_messages call_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_messages
    ADD CONSTRAINT call_messages_pkey PRIMARY KEY (id);

--
-- Name: call_sessions call_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_sessions
    ADD CONSTRAINT call_sessions_pkey PRIMARY KEY (id);

--
-- Name: campaigns campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_pkey PRIMARY KEY (id);

--
-- Name: channel_settings channel_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_settings
    ADD CONSTRAINT channel_settings_pkey PRIMARY KEY (organization_id, channel);

--
-- Name: clean_domains clean_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clean_domains
    ADD CONSTRAINT clean_domains_pkey PRIMARY KEY (domain);

--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);

--
-- Name: crm_categories crm_categories_label_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_categories
    ADD CONSTRAINT crm_categories_label_uq UNIQUE (label);

--
-- Name: crm_categories crm_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_categories
    ADD CONSTRAINT crm_categories_pkey PRIMARY KEY (key);

--
-- Name: crm_categories crm_categories_sort_order_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_categories
    ADD CONSTRAINT crm_categories_sort_order_uq UNIQUE (sort_order);

--
-- Name: crm_classifications crm_classifications_message_context_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_classifications
    ADD CONSTRAINT crm_classifications_message_context_uq UNIQUE (message_id, expected_context_version);

--
-- Name: crm_classifications crm_classifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_classifications
    ADD CONSTRAINT crm_classifications_pkey PRIMARY KEY (id);

--
-- Name: crm_conversation_messages crm_conversation_messages_channel_account_idempotency_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_conversation_messages
    ADD CONSTRAINT crm_conversation_messages_channel_account_idempotency_uq UNIQUE (channel, account_ref, idempotency_key);

--
-- Name: crm_conversation_messages crm_conversation_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_conversation_messages
    ADD CONSTRAINT crm_conversation_messages_pkey PRIMARY KEY (id);

--
-- Name: crm_conversations crm_conversations_id_person_channel_account_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_conversations
    ADD CONSTRAINT crm_conversations_id_person_channel_account_uq UNIQUE (id, person_id, channel, account_ref);

--
-- Name: crm_conversations crm_conversations_id_record_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_conversations
    ADD CONSTRAINT crm_conversations_id_record_uq UNIQUE (id, crm_record_id);

--
-- Name: crm_conversations crm_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_conversations
    ADD CONSTRAINT crm_conversations_pkey PRIMARY KEY (id);

--
-- Name: crm_draft_knowledge_citations crm_draft_knowledge_citations_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_draft_knowledge_citations
    ADD CONSTRAINT crm_draft_knowledge_citations_pk PRIMARY KEY (draft_id, document_version_id, excerpt_hash);

--
-- Name: crm_drafts crm_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_drafts
    ADD CONSTRAINT crm_drafts_pkey PRIMARY KEY (id);

--
-- Name: crm_email_drafts crm_email_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_email_drafts
    ADD CONSTRAINT crm_email_drafts_pkey PRIMARY KEY (id);

--
-- Name: crm_events crm_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_events
    ADD CONSTRAINT crm_events_pkey PRIMARY KEY (id);

--
-- Name: crm_identity_exceptions crm_identity_exceptions_event_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_identity_exceptions
    ADD CONSTRAINT crm_identity_exceptions_event_uq UNIQUE (channel, account_ref, source_event_key);

--
-- Name: crm_identity_exceptions crm_identity_exceptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_identity_exceptions
    ADD CONSTRAINT crm_identity_exceptions_pkey PRIMARY KEY (id);

--
-- Name: crm_jobs crm_jobs_entity_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_jobs
    ADD CONSTRAINT crm_jobs_entity_uq UNIQUE (kind, entity_type, entity_id);

--
-- Name: crm_jobs crm_jobs_idempotency_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_jobs
    ADD CONSTRAINT crm_jobs_idempotency_uq UNIQUE (idempotency_key);

--
-- Name: crm_jobs crm_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_jobs
    ADD CONSTRAINT crm_jobs_pkey PRIMARY KEY (id);

--
-- Name: crm_knowledge_document_versions crm_knowledge_document_versions_document_version_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_knowledge_document_versions
    ADD CONSTRAINT crm_knowledge_document_versions_document_version_uq UNIQUE (document_id, version);

--
-- Name: crm_knowledge_document_versions crm_knowledge_document_versions_id_document_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_knowledge_document_versions
    ADD CONSTRAINT crm_knowledge_document_versions_id_document_uq UNIQUE (id, document_id);

--
-- Name: crm_knowledge_document_versions crm_knowledge_document_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_knowledge_document_versions
    ADD CONSTRAINT crm_knowledge_document_versions_pkey PRIMARY KEY (id);

--
-- Name: crm_knowledge_documents crm_knowledge_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_knowledge_documents
    ADD CONSTRAINT crm_knowledge_documents_pkey PRIMARY KEY (id);

--
-- Name: crm_lead_ccs crm_lead_ccs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_ccs
    ADD CONSTRAINT crm_lead_ccs_pkey PRIMARY KEY (id);

--
-- Name: crm_leads crm_leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_leads
    ADD CONSTRAINT crm_leads_pkey PRIMARY KEY (id);

--
-- Name: crm_messages crm_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_messages
    ADD CONSTRAINT crm_messages_pkey PRIMARY KEY (id);

--
-- Name: crm_notes crm_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_notes
    ADD CONSTRAINT crm_notes_pkey PRIMARY KEY (id);

--
-- Name: crm_person_contact_policies crm_person_contact_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_person_contact_policies
    ADD CONSTRAINT crm_person_contact_policies_pkey PRIMARY KEY (person_id);

--
-- Name: crm_pipelines crm_pipelines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_pipelines
    ADD CONSTRAINT crm_pipelines_pkey PRIMARY KEY (id);

--
-- Name: crm_record_sequence_overrides crm_record_sequence_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_record_sequence_overrides
    ADD CONSTRAINT crm_record_sequence_overrides_pkey PRIMARY KEY (id);

--
-- Name: crm_records crm_records_id_person_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_records
    ADD CONSTRAINT crm_records_id_person_uq UNIQUE (id, person_id);

--
-- Name: crm_records crm_records_id_pipeline_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_records
    ADD CONSTRAINT crm_records_id_pipeline_uq UNIQUE (id, pipeline_id);

--
-- Name: crm_records crm_records_person_pipeline_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_records
    ADD CONSTRAINT crm_records_person_pipeline_uq UNIQUE (person_id, pipeline_id);

--
-- Name: crm_records crm_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_records
    ADD CONSTRAINT crm_records_pkey PRIMARY KEY (id);

--
-- Name: crm_send_attempts crm_send_attempts_idempotency_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_send_attempts
    ADD CONSTRAINT crm_send_attempts_idempotency_uq UNIQUE (idempotency_key);

--
-- Name: crm_send_attempts crm_send_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_send_attempts
    ADD CONSTRAINT crm_send_attempts_pkey PRIMARY KEY (id);

--
-- Name: crm_sequence_runs crm_sequence_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_runs
    ADD CONSTRAINT crm_sequence_runs_pkey PRIMARY KEY (id);

--
-- Name: crm_sequence_step_runs crm_sequence_step_runs_id_run_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_step_runs
    ADD CONSTRAINT crm_sequence_step_runs_id_run_uq UNIQUE (id, sequence_run_id);

--
-- Name: crm_sequence_step_runs crm_sequence_step_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_step_runs
    ADD CONSTRAINT crm_sequence_step_runs_pkey PRIMARY KEY (id);

--
-- Name: crm_sequence_step_runs crm_sequence_step_runs_run_step_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_step_runs
    ADD CONSTRAINT crm_sequence_step_runs_run_step_uq UNIQUE (sequence_run_id, sequence_step_id);

--
-- Name: crm_sequence_steps crm_sequence_steps_id_version_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_steps
    ADD CONSTRAINT crm_sequence_steps_id_version_uq UNIQUE (id, sequence_version_id);

--
-- Name: crm_sequence_steps crm_sequence_steps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_steps
    ADD CONSTRAINT crm_sequence_steps_pkey PRIMARY KEY (id);

--
-- Name: crm_sequence_steps crm_sequence_steps_version_position_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_steps
    ADD CONSTRAINT crm_sequence_steps_version_position_uq UNIQUE (sequence_version_id, "position");

--
-- Name: crm_sequence_versions crm_sequence_versions_id_sequence_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_versions
    ADD CONSTRAINT crm_sequence_versions_id_sequence_uq UNIQUE (id, sequence_id);

--
-- Name: crm_sequence_versions crm_sequence_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_versions
    ADD CONSTRAINT crm_sequence_versions_pkey PRIMARY KEY (id);

--
-- Name: crm_sequence_versions crm_sequence_versions_sequence_version_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_versions
    ADD CONSTRAINT crm_sequence_versions_sequence_version_uq UNIQUE (sequence_id, version);

--
-- Name: crm_sequences crm_sequences_id_draft_version_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequences
    ADD CONSTRAINT crm_sequences_id_draft_version_uq UNIQUE (id, draft_version_id);

--
-- Name: crm_sequences crm_sequences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequences
    ADD CONSTRAINT crm_sequences_pkey PRIMARY KEY (id);

--
-- Name: crm_settings crm_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_settings
    ADD CONSTRAINT crm_settings_pkey PRIMARY KEY (pipeline_id);

--
-- Name: crm_status_config crm_status_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_status_config
    ADD CONSTRAINT crm_status_config_pkey PRIMARY KEY (status_key);

--
-- Name: crm_subcategories crm_subcategories_pipeline_key_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_subcategories
    ADD CONSTRAINT crm_subcategories_pipeline_key_uq UNIQUE (pipeline_id, key);

--
-- Name: crm_subcategories crm_subcategories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_subcategories
    ADD CONSTRAINT crm_subcategories_pkey PRIMARY KEY (id);

--
-- Name: crm_subcategories crm_subcategories_target_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_subcategories
    ADD CONSTRAINT crm_subcategories_target_uq UNIQUE (id, pipeline_id, category_key);

--
-- Name: crm_subcategory_sequence_assignments crm_subcategory_sequence_assignments_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_subcategory_sequence_assignments
    ADD CONSTRAINT crm_subcategory_sequence_assignments_pk PRIMARY KEY (subcategory_id);

--
-- Name: crm_tasks crm_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_tasks
    ADD CONSTRAINT crm_tasks_pkey PRIMARY KEY (id);

--
-- Name: crm_webhook_events crm_webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_webhook_events
    ADD CONSTRAINT crm_webhook_events_pkey PRIMARY KEY (id);

--
-- Name: daily_summaries daily_summaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_summaries
    ADD CONSTRAINT daily_summaries_pkey PRIMARY KEY (id);

--
-- Name: domains domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domains
    ADD CONSTRAINT domains_pkey PRIMARY KEY (domain);

--
-- Name: entity_columns entity_columns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_columns
    ADD CONSTRAINT entity_columns_pkey PRIMARY KEY (id);

--
-- Name: grid_cell_runs grid_cell_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_cell_runs
    ADD CONSTRAINT grid_cell_runs_pkey PRIMARY KEY (id);

--
-- Name: grid_columns grid_columns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_columns
    ADD CONSTRAINT grid_columns_pkey PRIMARY KEY (id);

--
-- Name: grid_columns grid_columns_table_key_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_columns
    ADD CONSTRAINT grid_columns_table_key_uq UNIQUE (table_id, key);

--
-- Name: grid_folders grid_folders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_folders
    ADD CONSTRAINT grid_folders_pkey PRIMARY KEY (id);

--
-- Name: grid_jobs grid_jobs_cell_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_jobs
    ADD CONSTRAINT grid_jobs_cell_uq UNIQUE (row_id, column_key);

--
-- Name: grid_jobs grid_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_jobs
    ADD CONSTRAINT grid_jobs_pkey PRIMARY KEY (id);

--
-- Name: grid_provider_credentials grid_provider_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_provider_credentials
    ADD CONSTRAINT grid_provider_credentials_pkey PRIMARY KEY (id);

--
-- Name: grid_provider_credentials grid_provider_credentials_provider_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_provider_credentials
    ADD CONSTRAINT grid_provider_credentials_provider_id_key UNIQUE (provider_id);

--
-- Name: grid_providers grid_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_providers
    ADD CONSTRAINT grid_providers_pkey PRIMARY KEY (id);

--
-- Name: grid_rows grid_rows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_rows
    ADD CONSTRAINT grid_rows_pkey PRIMARY KEY (id);

--
-- Name: grid_tables grid_tables_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_tables
    ADD CONSTRAINT grid_tables_pkey PRIMARY KEY (id);

--
-- Name: grid_workbooks grid_workbooks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_workbooks
    ADD CONSTRAINT grid_workbooks_pkey PRIMARY KEY (id);

--
-- Name: import_runs import_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_runs
    ADD CONSTRAINT import_runs_pkey PRIMARY KEY (id);

--
-- Name: inquiries inquiries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inquiries
    ADD CONSTRAINT inquiries_pkey PRIMARY KEY (id);

--
-- Name: instagram_accounts instagram_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_accounts
    ADD CONSTRAINT instagram_accounts_pkey PRIMARY KEY (id);

--
-- Name: instagram_accounts instagram_accounts_unipile_account_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_accounts
    ADD CONSTRAINT instagram_accounts_unipile_account_uq UNIQUE (unipile_account_id);

--
-- Name: instagram_chats instagram_chats_account_chat_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_chats
    ADD CONSTRAINT instagram_chats_account_chat_uq UNIQUE (account_id, unipile_chat_id);

--
-- Name: instagram_chats instagram_chats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_chats
    ADD CONSTRAINT instagram_chats_pkey PRIMARY KEY (id);

--
-- Name: instagram_messages instagram_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_messages
    ADD CONSTRAINT instagram_messages_pkey PRIMARY KEY (id);

--
-- Name: intake_endpoints intake_endpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intake_endpoints
    ADD CONSTRAINT intake_endpoints_pkey PRIMARY KEY (id);

--
-- Name: intake_endpoints intake_endpoints_token_hash_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intake_endpoints
    ADD CONSTRAINT intake_endpoints_token_hash_uq UNIQUE (token_hash);

--
-- Name: invitations invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);

--
-- Name: lead_audience_member_insights lead_audience_member_insights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_audience_member_insights
    ADD CONSTRAINT lead_audience_member_insights_pkey PRIMARY KEY (member_id);

--
-- Name: lead_audience_members lead_audience_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_audience_members
    ADD CONSTRAINT lead_audience_members_pkey PRIMARY KEY (id);

--
-- Name: lead_audiences lead_audiences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_audiences
    ADD CONSTRAINT lead_audiences_pkey PRIMARY KEY (id);

--
-- Name: lead_research lead_research_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_research
    ADD CONSTRAINT lead_research_pkey PRIMARY KEY (id);

--
-- Name: members members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_pkey PRIMARY KEY (id);

--
-- Name: organization_features organization_features_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_features
    ADD CONSTRAINT organization_features_pkey PRIMARY KEY (organization_id, key);

--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);

--
-- Name: organizations organizations_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_slug_key UNIQUE (slug);

--
-- Name: outreach_campaigns outreach_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_campaigns
    ADD CONSTRAINT outreach_campaigns_pkey PRIMARY KEY (id);

--
-- Name: outreach_emails outreach_emails_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_emails
    ADD CONSTRAINT outreach_emails_pkey PRIMARY KEY (id);

--
-- Name: outreach_leads outreach_leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_leads
    ADD CONSTRAINT outreach_leads_pkey PRIMARY KEY (id);

--
-- Name: outreach_mailbox_queue outreach_mailbox_queue_mailbox_id_lead_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_mailbox_queue
    ADD CONSTRAINT outreach_mailbox_queue_mailbox_id_lead_id_key UNIQUE (mailbox_id, lead_id);

--
-- Name: outreach_mailbox_queue outreach_mailbox_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_mailbox_queue
    ADD CONSTRAINT outreach_mailbox_queue_pkey PRIMARY KEY (id);

--
-- Name: outreach_mailboxes outreach_mailboxes_email_address_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_mailboxes
    ADD CONSTRAINT outreach_mailboxes_email_address_key UNIQUE (email_address);

--
-- Name: outreach_mailboxes outreach_mailboxes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_mailboxes
    ADD CONSTRAINT outreach_mailboxes_pkey PRIMARY KEY (id);

--
-- Name: outreach_run_leads outreach_run_leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_run_leads
    ADD CONSTRAINT outreach_run_leads_pkey PRIMARY KEY (id);

--
-- Name: outreach_runs outreach_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_runs
    ADD CONSTRAINT outreach_runs_pkey PRIMARY KEY (id);

--
-- Name: outreach_suppression_list outreach_suppression_list_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_suppression_list
    ADD CONSTRAINT outreach_suppression_list_pkey PRIMARY KEY (id);

--
-- Name: owner_decisions owner_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.owner_decisions
    ADD CONSTRAINT owner_decisions_pkey PRIMARY KEY (id);

--
-- Name: people people_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people
    ADD CONSTRAINT people_pkey PRIMARY KEY (id);

--
-- Name: qualification_jobs qualification_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qualification_jobs
    ADD CONSTRAINT qualification_jobs_pkey PRIMARY KEY (id);

--
-- Name: scheduled_job_runs scheduled_job_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_job_runs
    ADD CONSTRAINT scheduled_job_runs_pkey PRIMARY KEY (job, slot);

--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

--
-- Name: sessions sessions_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_key UNIQUE (token);

--
-- Name: targeted_domains targeted_domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.targeted_domains
    ADD CONSTRAINT targeted_domains_pkey PRIMARY KEY (id);

--
-- Name: team_members team_members_membership_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_membership_key_key UNIQUE (membership_key);

--
-- Name: team_members team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_pkey PRIMARY KEY (id);

--
-- Name: teams teams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_pkey PRIMARY KEY (id);

--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);

--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

--
-- Name: verifications verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verifications
    ADD CONSTRAINT verifications_pkey PRIMARY KEY (id);

--
-- Name: whatsapp_accounts whatsapp_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_accounts
    ADD CONSTRAINT whatsapp_accounts_pkey PRIMARY KEY (id);

--
-- Name: whatsapp_accounts whatsapp_accounts_unipile_account_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_accounts
    ADD CONSTRAINT whatsapp_accounts_unipile_account_uq UNIQUE (unipile_account_id);

--
-- Name: whatsapp_campaign_accounts whatsapp_campaign_accounts_pk; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_campaign_accounts
    ADD CONSTRAINT whatsapp_campaign_accounts_pk PRIMARY KEY (campaign_id, account_id);

--
-- Name: whatsapp_campaign_leads whatsapp_campaign_leads_campaign_person_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_campaign_leads
    ADD CONSTRAINT whatsapp_campaign_leads_campaign_person_uq UNIQUE (campaign_id, person_id);

--
-- Name: whatsapp_campaign_leads whatsapp_campaign_leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_campaign_leads
    ADD CONSTRAINT whatsapp_campaign_leads_pkey PRIMARY KEY (id);

--
-- Name: whatsapp_campaign_sends whatsapp_campaign_sends_lead_step_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_campaign_sends
    ADD CONSTRAINT whatsapp_campaign_sends_lead_step_uq UNIQUE (lead_id, step);

--
-- Name: whatsapp_campaign_sends whatsapp_campaign_sends_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_campaign_sends
    ADD CONSTRAINT whatsapp_campaign_sends_pkey PRIMARY KEY (id);

--
-- Name: whatsapp_campaigns whatsapp_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_campaigns
    ADD CONSTRAINT whatsapp_campaigns_pkey PRIMARY KEY (id);

--
-- Name: whatsapp_chats whatsapp_chats_account_chat_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_chats
    ADD CONSTRAINT whatsapp_chats_account_chat_uq UNIQUE (account_id, unipile_chat_id);

--
-- Name: whatsapp_chats whatsapp_chats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_chats
    ADD CONSTRAINT whatsapp_chats_pkey PRIMARY KEY (id);

--
-- Name: whatsapp_messages whatsapp_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_messages
    ADD CONSTRAINT whatsapp_messages_pkey PRIMARY KEY (id);

--
-- Name: Campaign_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Campaign_organization_idx" ON public."Campaign" USING btree ("organizationId");

--
-- Name: Connection_leadId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Connection_leadId_key" ON public."Connection" USING btree ("leadId");

--
-- Name: Connection_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Connection_organization_idx" ON public."Connection" USING btree ("organizationId");

--
-- Name: Connection_providerId_linkedinAccountId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Connection_providerId_linkedinAccountId_key" ON public."Connection" USING btree ("providerId", "linkedinAccountId");

--
-- Name: Lead_linkedinUrl_campaignId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Lead_linkedinUrl_campaignId_key" ON public."Lead" USING btree ("linkedinUrl", "campaignId");

--
-- Name: Lead_linkedinUrl_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Lead_linkedinUrl_idx" ON public."Lead" USING btree ("linkedinUrl");

--
-- Name: Lead_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Lead_organization_idx" ON public."Lead" USING btree ("organizationId");

--
-- Name: Lead_personId_campaignId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Lead_personId_campaignId_key" ON public."Lead" USING btree ("personId", "campaignId");

--
-- Name: Lead_providerId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Lead_providerId_idx" ON public."Lead" USING btree ("providerId");

--
-- Name: Lead_sourceLinkedinIdentifier_campaignId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Lead_sourceLinkedinIdentifier_campaignId_key" ON public."Lead" USING btree ("sourceLinkedinIdentifier", COALESCE("sourceLinkedinApi", ''::text), "campaignId") WHERE ("sourceLinkedinIdentifier" IS NOT NULL);

--
-- Name: Lead_supersededByLeadId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Lead_supersededByLeadId_idx" ON public."Lead" USING btree ("supersededByLeadId");

--
-- Name: Lead_unresolvedLinkedin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Lead_unresolvedLinkedin_idx" ON public."Lead" USING btree ("sourceLinkedinIdentifier", "createdAt") WHERE ("sourceLinkedinIdentifier" IS NOT NULL);

--
-- Name: Lead_unresolvedLinkedin_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Lead_unresolvedLinkedin_lookup_idx" ON public."Lead" USING btree (lower("sourceLinkedinIdentifier"), "sourceLinkedinApi") WHERE (("sourceLinkedinIdentifier" IS NOT NULL) AND ("personId" IS NOT NULL));

--
-- Name: LinkedInAccount_linkedinId_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "LinkedInAccount_linkedinId_key" ON public."LinkedInAccount" USING btree ("linkedinId");

--
-- Name: LinkedInAccount_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "LinkedInAccount_organization_idx" ON public."LinkedInAccount" USING btree ("organizationId");

--
-- Name: Message_automated_lead_type_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "Message_automated_lead_type_uq" ON public."Message" USING btree ("leadId", type) WHERE (("leadId" IS NOT NULL) AND ("duplicateOfMessageId" IS NULL) AND (type = ANY (ARRAY['INVITATION'::public."MessageType", 'ACCEPTANCE'::public."MessageType", 'FOLLOW_UP_1'::public."MessageType", 'FOLLOW_UP_2'::public."MessageType", 'FOLLOW_UP_3'::public."MessageType"])));

--
-- Name: Message_duplicateOfMessageId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Message_duplicateOfMessageId_idx" ON public."Message" USING btree ("duplicateOfMessageId");

--
-- Name: Message_leadId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Message_leadId_idx" ON public."Message" USING btree ("leadId") WHERE ("leadId" IS NOT NULL);

--
-- Name: Message_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "Message_organization_idx" ON public."Message" USING btree ("organizationId");

--
-- Name: SearchBatch_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SearchBatch_organization_idx" ON public."SearchBatch" USING btree ("organizationId");

--
-- Name: SearchQuery_batchId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "SearchQuery_batchId_idx" ON public."SearchQuery" USING btree ("batchId");

--
-- Name: SearchResult_searchQueryId_linkedinUrl_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "SearchResult_searchQueryId_linkedinUrl_key" ON public."SearchResult" USING btree ("searchQueryId", "linkedinUrl");

--
-- Name: WebhookEvent_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "WebhookEvent_organization_idx" ON public."WebhookEvent" USING btree ("organizationId");

--
-- Name: WebhookEvent_providerEventKey_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "WebhookEvent_providerEventKey_uq" ON public."WebhookEvent" USING btree ("providerEventKey") WHERE ("providerEventKey" IS NOT NULL);

--
-- Name: WebhookEvent_retry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "WebhookEvent_retry_idx" ON public."WebhookEvent" USING btree ("processingStatus", "nextAttemptAt", "createdAt");

--
-- Name: accounts_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX accounts_user_id_idx ON public.accounts USING btree (user_id);

--
-- Name: apify_runs_org_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX apify_runs_org_created_idx ON public.apify_runs USING btree (organization_id, created_at);

--
-- Name: assistant_jobs_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assistant_jobs_claim_idx ON public.assistant_jobs USING btree (status, run_after);

--
-- Name: assistant_jobs_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assistant_jobs_organization_idx ON public.assistant_jobs USING btree (organization_id, created_at);

--
-- Name: assistant_messages_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assistant_messages_organization_idx ON public.assistant_messages USING btree (organization_id);

--
-- Name: assistant_messages_thread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assistant_messages_thread_idx ON public.assistant_messages USING btree (thread_id, created_at);

--
-- Name: assistant_threads_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assistant_threads_organization_idx ON public.assistant_threads USING btree (organization_id, updated_at);

--
-- Name: assistant_usage_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assistant_usage_organization_idx ON public.assistant_usage USING btree (organization_id, created_at);

--
-- Name: autopilot_replies_conversation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX autopilot_replies_conversation_idx ON public.autopilot_replies USING btree (conversation_id);

--
-- Name: autopilot_replies_draft_revision_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX autopilot_replies_draft_revision_uq ON public.autopilot_replies USING btree (draft_id, revision);

--
-- Name: autopilot_replies_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX autopilot_replies_organization_idx ON public.autopilot_replies USING btree (organization_id, created_at);

--
-- Name: autopilot_takeovers_conversation_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX autopilot_takeovers_conversation_uq ON public.autopilot_takeovers USING btree (conversation_id);

--
-- Name: autopilot_takeovers_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX autopilot_takeovers_organization_idx ON public.autopilot_takeovers USING btree (organization_id);

--
-- Name: call_campaign_contacts_campaign_stage_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_campaign_contacts_campaign_stage_idx ON public.call_campaign_contacts USING btree (campaign_id, stage);

--
-- Name: call_campaigns_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_campaigns_organization_idx ON public.call_campaigns USING btree (organization_id);

--
-- Name: call_messages_campaign_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_messages_campaign_contact_idx ON public.call_messages USING btree (campaign_contact_id, opened_at);

--
-- Name: call_messages_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_messages_organization_idx ON public.call_messages USING btree (organization_id);

--
-- Name: call_sessions_campaign_contact_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_sessions_campaign_contact_idx ON public.call_sessions USING btree (campaign_contact_id);

--
-- Name: call_sessions_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_sessions_organization_idx ON public.call_sessions USING btree (organization_id);

--
-- Name: call_sessions_person_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX call_sessions_person_created_idx ON public.call_sessions USING btree (person_id, created_at);

--
-- Name: campaigns_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX campaigns_organization_idx ON public.campaigns USING btree (organization_id);

--
-- Name: companies_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX companies_name_idx ON public.companies USING btree (lower(name));

--
-- Name: companies_org_domain_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX companies_org_domain_uq ON public.companies USING btree (organization_id, domain);

--
-- Name: companies_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX companies_organization_idx ON public.companies USING btree (organization_id);

--
-- Name: crm_classifications_record_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_classifications_record_created_idx ON public.crm_classifications USING btree (crm_record_id, created_at);

--
-- Name: crm_conversation_messages_conversation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_conversation_messages_conversation_idx ON public.crm_conversation_messages USING btree (conversation_id, sent_at);

--
-- Name: crm_conversation_messages_provider_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_conversation_messages_provider_id_uq ON public.crm_conversation_messages USING btree (channel, account_ref, provider_message_id) WHERE (provider_message_id IS NOT NULL);

--
-- Name: crm_conversations_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_conversations_organization_idx ON public.crm_conversations USING btree (organization_id);

--
-- Name: crm_conversations_provider_thread_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_conversations_provider_thread_uq ON public.crm_conversations USING btree (channel, account_ref, provider_thread_id) WHERE (provider_thread_id IS NOT NULL);

--
-- Name: crm_conversations_record_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_conversations_record_idx ON public.crm_conversations USING btree (crm_record_id);

--
-- Name: crm_drafts_record_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_drafts_record_status_idx ON public.crm_drafts USING btree (crm_record_id, status);

--
-- Name: crm_drafts_step_run_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_drafts_step_run_uq ON public.crm_drafts USING btree (sequence_step_run_id) WHERE (sequence_step_run_id IS NOT NULL);

--
-- Name: crm_events_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_events_organization_idx ON public.crm_events USING btree (organization_id);

--
-- Name: crm_events_person_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_events_person_created_idx ON public.crm_events USING btree (person_id, created_at);

--
-- Name: crm_events_record_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_events_record_created_idx ON public.crm_events USING btree (crm_record_id, created_at);

--
-- Name: crm_identity_exceptions_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_identity_exceptions_organization_idx ON public.crm_identity_exceptions USING btree (organization_id);

--
-- Name: crm_identity_exceptions_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_identity_exceptions_status_created_idx ON public.crm_identity_exceptions USING btree (status, created_at);

--
-- Name: crm_jobs_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_jobs_claim_idx ON public.crm_jobs USING btree (status, run_after, priority);

--
-- Name: crm_jobs_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_jobs_organization_idx ON public.crm_jobs USING btree (organization_id);

--
-- Name: crm_jobs_stale_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_jobs_stale_claim_idx ON public.crm_jobs USING btree (status, locked_at);

--
-- Name: crm_knowledge_documents_active_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_knowledge_documents_active_kind_idx ON public.crm_knowledge_documents USING btree (active, kind);

--
-- Name: crm_knowledge_documents_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_knowledge_documents_organization_idx ON public.crm_knowledge_documents USING btree (organization_id);

--
-- Name: crm_leads_org_email_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_leads_org_email_uq ON public.crm_leads USING btree (organization_id, email);

--
-- Name: crm_leads_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_leads_organization_idx ON public.crm_leads USING btree (organization_id);

--
-- Name: crm_messages_provider_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_messages_provider_id_uq ON public.crm_messages USING btree (smartlead_message_id) WHERE (smartlead_message_id IS NOT NULL);

--
-- Name: crm_notes_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_notes_organization_idx ON public.crm_notes USING btree (organization_id);

--
-- Name: crm_person_contact_policies_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_person_contact_policies_updated_idx ON public.crm_person_contact_policies USING btree (updated_at);

--
-- Name: crm_pipelines_org_name_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_pipelines_org_name_uq ON public.crm_pipelines USING btree (organization_id, name);

--
-- Name: crm_pipelines_org_one_default_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_pipelines_org_one_default_uq ON public.crm_pipelines USING btree (organization_id) WHERE (is_default IS TRUE);

--
-- Name: crm_pipelines_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_pipelines_organization_idx ON public.crm_pipelines USING btree (organization_id);

--
-- Name: crm_record_sequence_overrides_active_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_record_sequence_overrides_active_uq ON public.crm_record_sequence_overrides USING btree (crm_record_id) WHERE (cleared_at IS NULL);

--
-- Name: crm_record_sequence_overrides_record_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_record_sequence_overrides_record_idx ON public.crm_record_sequence_overrides USING btree (crm_record_id);

--
-- Name: crm_records_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_records_organization_idx ON public.crm_records USING btree (organization_id);

--
-- Name: crm_records_person_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_records_person_idx ON public.crm_records USING btree (person_id);

--
-- Name: crm_records_pipeline_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_records_pipeline_state_idx ON public.crm_records USING btree (pipeline_id, workflow_state);

--
-- Name: crm_send_attempts_draft_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_send_attempts_draft_created_idx ON public.crm_send_attempts USING btree (draft_id, created_at);

--
-- Name: crm_send_attempts_one_terminal_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_send_attempts_one_terminal_uq ON public.crm_send_attempts USING btree (draft_id) WHERE (status = ANY (ARRAY['sent'::text, 'delivery_uncertain'::text, 'reconciled'::text]));

--
-- Name: crm_sequence_runs_one_active_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_sequence_runs_one_active_uq ON public.crm_sequence_runs USING btree (crm_record_id) WHERE (status = 'active'::text);

--
-- Name: crm_sequence_runs_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_sequence_runs_organization_idx ON public.crm_sequence_runs USING btree (organization_id);

--
-- Name: crm_sequence_runs_record_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_sequence_runs_record_created_idx ON public.crm_sequence_runs USING btree (crm_record_id, created_at);

--
-- Name: crm_sequence_step_runs_draft_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_sequence_step_runs_draft_uq ON public.crm_sequence_step_runs USING btree (draft_id) WHERE (draft_id IS NOT NULL);

--
-- Name: crm_sequence_step_runs_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_sequence_step_runs_due_idx ON public.crm_sequence_step_runs USING btree (status, due_at);

--
-- Name: crm_sequence_versions_one_draft_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX crm_sequence_versions_one_draft_uq ON public.crm_sequence_versions USING btree (sequence_id) WHERE (status = 'draft'::text);

--
-- Name: crm_sequences_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_sequences_organization_idx ON public.crm_sequences USING btree (organization_id);

--
-- Name: crm_sequences_status_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_sequences_status_name_idx ON public.crm_sequences USING btree (status, name);

--
-- Name: crm_subcategories_pipeline_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_subcategories_pipeline_category_idx ON public.crm_subcategories USING btree (pipeline_id, category_key);

--
-- Name: crm_subcategory_sequence_assignments_sequence_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_subcategory_sequence_assignments_sequence_idx ON public.crm_subcategory_sequence_assignments USING btree (sequence_id);

--
-- Name: crm_tasks_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_tasks_organization_idx ON public.crm_tasks USING btree (organization_id);

--
-- Name: crm_webhook_events_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX crm_webhook_events_organization_idx ON public.crm_webhook_events USING btree (organization_id);

--
-- Name: daily_summaries_organization_day_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX daily_summaries_organization_day_uq ON public.daily_summaries USING btree (organization_id, day);

--
-- Name: entity_columns_entity_pos_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_columns_entity_pos_idx ON public.entity_columns USING btree (entity, "position") WHERE (archived_at IS NULL);

--
-- Name: entity_columns_org_entity_key_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX entity_columns_org_entity_key_uq ON public.entity_columns USING btree (organization_id, entity, key);

--
-- Name: entity_columns_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_columns_organization_idx ON public.entity_columns USING btree (organization_id);

--
-- Name: grid_cell_runs_cell_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grid_cell_runs_cell_idx ON public.grid_cell_runs USING btree (row_id, column_key);

--
-- Name: grid_cell_runs_table_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grid_cell_runs_table_created_idx ON public.grid_cell_runs USING btree (table_id, created_at);

--
-- Name: grid_columns_table_pos_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grid_columns_table_pos_idx ON public.grid_columns USING btree (table_id, "position");

--
-- Name: grid_folders_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grid_folders_organization_idx ON public.grid_folders USING btree (organization_id);

--
-- Name: grid_folders_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grid_folders_parent_idx ON public.grid_folders USING btree (parent_id);

--
-- Name: grid_jobs_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grid_jobs_claim_idx ON public.grid_jobs USING btree (status, run_after);

--
-- Name: grid_jobs_table_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grid_jobs_table_status_idx ON public.grid_jobs USING btree (table_id, status);

--
-- Name: grid_providers_org_key_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX grid_providers_org_key_uq ON public.grid_providers USING btree (organization_id, key);

--
-- Name: grid_providers_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grid_providers_organization_idx ON public.grid_providers USING btree (organization_id);

--
-- Name: grid_rows_table_pos_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grid_rows_table_pos_idx ON public.grid_rows USING btree (table_id, "position");

--
-- Name: grid_rows_table_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grid_rows_table_version_idx ON public.grid_rows USING btree (table_id, version);

--
-- Name: grid_tables_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grid_tables_organization_idx ON public.grid_tables USING btree (organization_id);

--
-- Name: grid_tables_workbook_pos_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grid_tables_workbook_pos_idx ON public.grid_tables USING btree (workbook_id, "position");

--
-- Name: grid_workbooks_folder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grid_workbooks_folder_idx ON public.grid_workbooks USING btree (folder_id);

--
-- Name: grid_workbooks_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grid_workbooks_organization_idx ON public.grid_workbooks USING btree (organization_id);

--
-- Name: idx_clean_country_c1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clean_country_c1 ON public.clean_domains USING btree (country_code, c1) WHERE (c1 IS NOT NULL);

--
-- Name: idx_clean_country_c1_c2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clean_country_c1_c2 ON public.clean_domains USING btree (country_code, c1, c2) WHERE (c2 IS NOT NULL);

--
-- Name: idx_clean_domains_apps_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clean_domains_apps_gin ON public.clean_domains USING gin (installed_apps_array);

--
-- Name: idx_clean_domains_categories; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clean_domains_categories ON public.clean_domains USING btree (categories);

--
-- Name: idx_clean_domains_country_platform; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clean_domains_country_platform ON public.clean_domains USING btree (country_code, platform);

--
-- Name: idx_clean_domains_country_rank; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clean_domains_country_rank ON public.clean_domains USING btree (country_code, rank);

--
-- Name: idx_clean_domains_country_revenue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clean_domains_country_revenue ON public.clean_domains USING btree (country_code, annual_sales DESC NULLS LAST);

ALTER TABLE public.clean_domains CLUSTER ON idx_clean_domains_country_revenue;

--
-- Name: idx_crm_email_drafts_lead; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_email_drafts_lead ON public.crm_email_drafts USING btree (lead_id);

--
-- Name: idx_crm_lead_ccs_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_lead_ccs_email ON public.crm_lead_ccs USING btree (email);

--
-- Name: idx_crm_lead_ccs_lead; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_lead_ccs_lead ON public.crm_lead_ccs USING btree (lead_id);

--
-- Name: idx_crm_leads_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_leads_domain ON public.crm_leads USING btree (domain);

--
-- Name: idx_crm_leads_mailbox; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_leads_mailbox ON public.crm_leads USING btree (mailbox);

--
-- Name: idx_crm_leads_state_next_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_leads_state_next_action ON public.crm_leads USING btree (state, next_action_at);

--
-- Name: idx_crm_leads_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_leads_status ON public.crm_leads USING btree (current_status_key);

--
-- Name: idx_crm_messages_lead; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_messages_lead ON public.crm_messages USING btree (lead_id);

--
-- Name: idx_crm_messages_smartlead_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_crm_messages_smartlead_id ON public.crm_messages USING btree (smartlead_message_id) WHERE (smartlead_message_id IS NOT NULL);

--
-- Name: idx_crm_notes_lead; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_notes_lead ON public.crm_notes USING btree (lead_id);

--
-- Name: idx_crm_tasks_lead; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_tasks_lead ON public.crm_tasks USING btree (lead_id);

--
-- Name: idx_crm_webhook_events_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_webhook_events_created_at ON public.crm_webhook_events USING btree (created_at DESC);

--
-- Name: idx_crm_webhook_events_processed_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_crm_webhook_events_processed_created ON public.crm_webhook_events USING btree (processed, created_at);

--
-- Name: idx_domains_categories; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_domains_categories ON public.domains USING btree (categories);

--
-- Name: idx_domains_country_annual_sales; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_domains_country_annual_sales ON public.domains USING btree (country_code, annual_sales DESC NULLS LAST);

--
-- Name: idx_domains_country_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_domains_country_code ON public.domains USING btree (country_code);

--
-- Name: idx_domains_country_platform; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_domains_country_platform ON public.domains USING btree (country_code, platform);

--
-- Name: idx_domains_country_rank; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_domains_country_rank ON public.domains USING btree (country_code, rank);

--
-- Name: idx_outreach_emails_gmail_message_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_outreach_emails_gmail_message_id ON public.outreach_emails USING btree (gmail_message_id) WHERE (gmail_message_id IS NOT NULL);

--
-- Name: idx_outreach_emails_lead; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outreach_emails_lead ON public.outreach_emails USING btree (lead_id);

--
-- Name: idx_outreach_leads_campaign; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outreach_leads_campaign ON public.outreach_leads USING btree (campaign_id);

--
-- Name: idx_outreach_leads_next_send; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outreach_leads_next_send ON public.outreach_leads USING btree (sequence_status, next_send_at);

--
-- Name: idx_outreach_mailbox_queue_mailbox_position; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outreach_mailbox_queue_mailbox_position ON public.outreach_mailbox_queue USING btree (mailbox_id, "position");

--
-- Name: idx_targeted_domains_campaign; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_targeted_domains_campaign ON public.targeted_domains USING btree (campaign_id);

--
-- Name: idx_targeted_domains_parent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_targeted_domains_parent_id ON public.targeted_domains USING btree (parent_id);

--
-- Name: idx_targeted_domains_parent_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_targeted_domains_parent_pending ON public.targeted_domains USING btree (parent_pending);

--
-- Name: idx_targeted_domains_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_targeted_domains_status ON public.targeted_domains USING btree (status);

--
-- Name: import_runs_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_runs_created_idx ON public.import_runs USING btree (created_at DESC);

--
-- Name: import_runs_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_runs_organization_idx ON public.import_runs USING btree (organization_id);

--
-- Name: inquiries_org_source_dedupe_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX inquiries_org_source_dedupe_uq ON public.inquiries USING btree (organization_id, source, dedupe_key);

--
-- Name: inquiries_organization_received_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inquiries_organization_received_idx ON public.inquiries USING btree (organization_id, received_at);

--
-- Name: inquiries_person_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inquiries_person_idx ON public.inquiries USING btree (person_id);

--
-- Name: instagram_accounts_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX instagram_accounts_organization_idx ON public.instagram_accounts USING btree (organization_id);

--
-- Name: instagram_chats_account_last_message_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX instagram_chats_account_last_message_idx ON public.instagram_chats USING btree (account_id, last_message_at);

--
-- Name: instagram_chats_person_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX instagram_chats_person_idx ON public.instagram_chats USING btree (person_id);

--
-- Name: instagram_chats_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX instagram_chats_provider_idx ON public.instagram_chats USING btree (provider_id);

--
-- Name: instagram_messages_chat_sent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX instagram_messages_chat_sent_idx ON public.instagram_messages USING btree (chat_id, sent_at);

--
-- Name: instagram_messages_unipile_message_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX instagram_messages_unipile_message_uq ON public.instagram_messages USING btree (unipile_message_id) WHERE (unipile_message_id IS NOT NULL);

--
-- Name: intake_endpoints_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX intake_endpoints_organization_idx ON public.intake_endpoints USING btree (organization_id);

--
-- Name: invitations_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invitations_email_idx ON public.invitations USING btree (email);

--
-- Name: invitations_organization_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invitations_organization_id_idx ON public.invitations USING btree (organization_id);

--
-- Name: lead_audience_members_audience_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lead_audience_members_audience_idx ON public.lead_audience_members USING btree (audience_id, status);

--
-- Name: lead_audience_members_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lead_audience_members_organization_idx ON public.lead_audience_members USING btree (organization_id);

--
-- Name: lead_audience_members_person_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX lead_audience_members_person_uq ON public.lead_audience_members USING btree (audience_id, person_id) WHERE (person_id IS NOT NULL);

--
-- Name: lead_audiences_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lead_audiences_organization_idx ON public.lead_audiences USING btree (organization_id, created_at);

--
-- Name: lead_person_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lead_person_idx ON public."Lead" USING btree ("personId");

--
-- Name: lead_research_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lead_research_company_idx ON public.lead_research USING btree (company_id, created_at);

--
-- Name: lead_research_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lead_research_organization_idx ON public.lead_research USING btree (organization_id, created_at);

--
-- Name: members_organization_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX members_organization_id_idx ON public.members USING btree (organization_id);

--
-- Name: members_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX members_user_id_idx ON public.members USING btree (user_id);

--
-- Name: outreach_campaigns_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outreach_campaigns_organization_idx ON public.outreach_campaigns USING btree (organization_id);

--
-- Name: outreach_emails_lead_step_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX outreach_emails_lead_step_uq ON public.outreach_emails USING btree (lead_id, step_number);

--
-- Name: outreach_leads_person_campaign_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX outreach_leads_person_campaign_uq ON public.outreach_leads USING btree (person_id, campaign_id);

--
-- Name: outreach_leads_person_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outreach_leads_person_idx ON public.outreach_leads USING btree (person_id);

--
-- Name: outreach_mailbox_queue_lead_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX outreach_mailbox_queue_lead_uq ON public.outreach_mailbox_queue USING btree (lead_id);

--
-- Name: outreach_mailboxes_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outreach_mailboxes_organization_idx ON public.outreach_mailboxes USING btree (organization_id);

--
-- Name: outreach_mailboxes_unipile_account_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX outreach_mailboxes_unipile_account_uq ON public.outreach_mailboxes USING btree (unipile_account_id) WHERE (unipile_account_id IS NOT NULL);

--
-- Name: outreach_run_leads_person_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outreach_run_leads_person_idx ON public.outreach_run_leads USING btree (organization_id, person_id);

--
-- Name: outreach_run_leads_run_person_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX outreach_run_leads_run_person_uq ON public.outreach_run_leads USING btree (run_id, person_id);

--
-- Name: outreach_runs_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outreach_runs_organization_idx ON public.outreach_runs USING btree (organization_id, created_at);

--
-- Name: outreach_suppression_list_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outreach_suppression_list_organization_idx ON public.outreach_suppression_list USING btree (organization_id);

--
-- Name: outreach_suppression_org_email_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX outreach_suppression_org_email_uq ON public.outreach_suppression_list USING btree (organization_id, email);

--
-- Name: owner_decisions_conversation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX owner_decisions_conversation_idx ON public.owner_decisions USING btree (conversation_id) WHERE (status = 'open'::text);

--
-- Name: owner_decisions_draft_kind_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX owner_decisions_draft_kind_uq ON public.owner_decisions USING btree (draft_id, kind) WHERE ((draft_id IS NOT NULL) AND (status = 'open'::text));

--
-- Name: owner_decisions_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX owner_decisions_organization_idx ON public.owner_decisions USING btree (organization_id, status, created_at);

--
-- Name: people_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX people_company_idx ON public.people USING btree (company_id);

--
-- Name: people_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX people_created_idx ON public.people USING btree (created_at DESC);

--
-- Name: people_email_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX people_email_lookup_idx ON public.people USING btree (lower(email)) WHERE (email IS NOT NULL);

--
-- Name: people_linkedin_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX people_linkedin_lookup_idx ON public.people USING btree (linkedin_url) WHERE (linkedin_url IS NOT NULL);

--
-- Name: people_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX people_name_idx ON public.people USING btree (lower(full_name));

--
-- Name: people_org_email_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX people_org_email_uq ON public.people USING btree (organization_id, lower(email)) WHERE (email IS NOT NULL);

--
-- Name: people_org_linkedin_url_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX people_org_linkedin_url_uq ON public.people USING btree (organization_id, linkedin_url) WHERE (linkedin_url IS NOT NULL);

--
-- Name: people_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX people_organization_idx ON public.people USING btree (organization_id);

--
-- Name: people_phone_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX people_phone_lookup_idx ON public.people USING btree (phone) WHERE (phone IS NOT NULL);

--
-- Name: sessions_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_id_idx ON public.sessions USING btree (user_id);

--
-- Name: targeted_domains_org_domain_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX targeted_domains_org_domain_uq ON public.targeted_domains USING btree (organization_id, domain);

--
-- Name: targeted_domains_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX targeted_domains_organization_idx ON public.targeted_domains USING btree (organization_id);

--
-- Name: team_members_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_members_team_id_idx ON public.team_members USING btree (team_id);

--
-- Name: team_members_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_members_user_id_idx ON public.team_members USING btree (user_id);

--
-- Name: teams_organization_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX teams_organization_id_idx ON public.teams USING btree (organization_id);

--
-- Name: verifications_identifier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX verifications_identifier_idx ON public.verifications USING btree (identifier);

--
-- Name: whatsapp_accounts_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_accounts_organization_idx ON public.whatsapp_accounts USING btree (organization_id);

--
-- Name: whatsapp_campaign_accounts_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_campaign_accounts_account_idx ON public.whatsapp_campaign_accounts USING btree (account_id);

--
-- Name: whatsapp_campaign_leads_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_campaign_leads_due_idx ON public.whatsapp_campaign_leads USING btree (status, next_send_at);

--
-- Name: whatsapp_campaign_leads_person_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_campaign_leads_person_idx ON public.whatsapp_campaign_leads USING btree (person_id);

--
-- Name: whatsapp_campaigns_organization_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_campaigns_organization_idx ON public.whatsapp_campaigns USING btree (organization_id);

--
-- Name: whatsapp_chats_account_last_message_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_chats_account_last_message_idx ON public.whatsapp_chats USING btree (account_id, last_message_at);

--
-- Name: whatsapp_chats_person_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_chats_person_idx ON public.whatsapp_chats USING btree (person_id);

--
-- Name: whatsapp_chats_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_chats_phone_idx ON public.whatsapp_chats USING btree (phone);

--
-- Name: whatsapp_messages_chat_sent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_messages_chat_sent_idx ON public.whatsapp_messages USING btree (chat_id, sent_at);

--
-- Name: whatsapp_messages_unipile_message_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX whatsapp_messages_unipile_message_uq ON public.whatsapp_messages USING btree (unipile_message_id) WHERE (unipile_message_id IS NOT NULL);

--
-- Name: crm_categories crm_categories_protect_system_rows_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_categories_protect_system_rows_trg BEFORE DELETE OR UPDATE ON public.crm_categories FOR EACH ROW EXECUTE FUNCTION public.crm_categories_protect_system_rows();

--
-- Name: crm_classifications crm_classifications_validate_scope_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_classifications_validate_scope_trg BEFORE INSERT OR UPDATE ON public.crm_classifications FOR EACH ROW EXECUTE FUNCTION public.crm_classifications_validate_scope();

--
-- Name: crm_conversation_messages crm_conversation_messages_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_conversation_messages_append_only_trg BEFORE DELETE OR UPDATE ON public.crm_conversation_messages FOR EACH ROW EXECUTE FUNCTION public.crm_conversation_messages_append_only();

--
-- Name: crm_conversations crm_conversations_immutable_identity_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_conversations_immutable_identity_trg BEFORE UPDATE ON public.crm_conversations FOR EACH ROW EXECUTE FUNCTION public.crm_conversations_immutable_identity();

--
-- Name: crm_drafts crm_drafts_validate_scope_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_drafts_validate_scope_trg BEFORE INSERT OR UPDATE ON public.crm_drafts FOR EACH ROW EXECUTE FUNCTION public.crm_drafts_validate_scope();

--
-- Name: crm_events crm_events_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_events_append_only_trg BEFORE DELETE OR UPDATE ON public.crm_events FOR EACH ROW EXECUTE FUNCTION public.crm_events_append_only();

--
-- Name: crm_jobs crm_jobs_validate_entity_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_jobs_validate_entity_trg BEFORE INSERT OR UPDATE OF entity_type, entity_id ON public.crm_jobs FOR EACH ROW EXECUTE FUNCTION public.crm_jobs_validate_entity();

--
-- Name: crm_knowledge_documents crm_knowledge_documents_validate_latest_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_knowledge_documents_validate_latest_trg BEFORE INSERT OR UPDATE ON public.crm_knowledge_documents FOR EACH ROW EXECUTE FUNCTION public.crm_knowledge_documents_validate_latest();

--
-- Name: crm_knowledge_document_versions crm_knowledge_versions_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_knowledge_versions_append_only_trg BEFORE DELETE OR UPDATE ON public.crm_knowledge_document_versions FOR EACH ROW EXECUTE FUNCTION public.crm_knowledge_versions_append_only();

--
-- Name: crm_knowledge_document_versions crm_knowledge_versions_validate_insert_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_knowledge_versions_validate_insert_trg BEFORE INSERT ON public.crm_knowledge_document_versions FOR EACH ROW EXECUTE FUNCTION public.crm_knowledge_versions_validate_insert();

--
-- Name: crm_knowledge_document_versions crm_knowledge_versions_validate_owner_latest_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER crm_knowledge_versions_validate_owner_latest_trg AFTER INSERT OR DELETE OR UPDATE ON public.crm_knowledge_document_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.crm_knowledge_versions_validate_owner_latest();

--
-- Name: crm_records crm_records_validate_latest_inbound_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_records_validate_latest_inbound_trg BEFORE INSERT OR UPDATE OF latest_inbound_message_id ON public.crm_records FOR EACH ROW EXECUTE FUNCTION public.crm_records_validate_latest_inbound();

--
-- Name: crm_send_attempts crm_send_attempts_protect_terminal_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_send_attempts_protect_terminal_trg BEFORE UPDATE ON public.crm_send_attempts FOR EACH ROW EXECUTE FUNCTION public.crm_send_attempts_protect_terminal();

--
-- Name: crm_send_attempts crm_send_attempts_validate_account_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_send_attempts_validate_account_trg BEFORE INSERT OR UPDATE ON public.crm_send_attempts FOR EACH ROW EXECUTE FUNCTION public.crm_send_attempts_validate_account();

--
-- Name: crm_sequence_runs crm_sequence_runs_validate_scope_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_sequence_runs_validate_scope_trg BEFORE INSERT OR UPDATE ON public.crm_sequence_runs FOR EACH ROW EXECUTE FUNCTION public.crm_sequence_runs_validate_scope();

--
-- Name: crm_sequence_step_runs crm_sequence_step_runs_validate_scope_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_sequence_step_runs_validate_scope_trg BEFORE INSERT OR UPDATE ON public.crm_sequence_step_runs FOR EACH ROW EXECUTE FUNCTION public.crm_sequence_step_runs_validate_scope();

--
-- Name: crm_sequence_steps crm_sequence_steps_require_draft_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_sequence_steps_require_draft_trg BEFORE INSERT OR DELETE OR UPDATE ON public.crm_sequence_steps FOR EACH ROW EXECUTE FUNCTION public.crm_sequence_steps_require_draft();

--
-- Name: crm_sequence_versions crm_sequence_versions_protect_published_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_sequence_versions_protect_published_trg BEFORE DELETE OR UPDATE ON public.crm_sequence_versions FOR EACH ROW EXECUTE FUNCTION public.crm_sequence_versions_protect_published();

--
-- Name: crm_sequence_versions crm_sequence_versions_validate_owner_pointers_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER crm_sequence_versions_validate_owner_pointers_trg AFTER INSERT OR DELETE OR UPDATE ON public.crm_sequence_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.crm_sequence_versions_validate_owner_pointers();

--
-- Name: crm_sequences crm_sequences_validate_version_pointers_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER crm_sequences_validate_version_pointers_trg AFTER INSERT OR UPDATE ON public.crm_sequences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.crm_sequences_validate_version_pointers();

--
-- Name: crm_subcategories crm_subcategories_immutable_fields_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER crm_subcategories_immutable_fields_trg BEFORE UPDATE ON public.crm_subcategories FOR EACH ROW EXECUTE FUNCTION public.crm_subcategories_immutable_fields();

--
-- Name: CampaignAccount CampaignAccount_campaignId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CampaignAccount"
    ADD CONSTRAINT "CampaignAccount_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES public."Campaign"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: CampaignAccount CampaignAccount_linkedinAccountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."CampaignAccount"
    ADD CONSTRAINT "CampaignAccount_linkedinAccountId_fkey" FOREIGN KEY ("linkedinAccountId") REFERENCES public."LinkedInAccount"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: Campaign Campaign_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Campaign"
    ADD CONSTRAINT "Campaign_organization_fk" FOREIGN KEY ("organizationId") REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: Connection Connection_leadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Connection"
    ADD CONSTRAINT "Connection_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES public."Lead"(id) ON UPDATE CASCADE ON DELETE SET NULL;

--
-- Name: Connection Connection_linkedinAccountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Connection"
    ADD CONSTRAINT "Connection_linkedinAccountId_fkey" FOREIGN KEY ("linkedinAccountId") REFERENCES public."LinkedInAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;

--
-- Name: Connection Connection_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Connection"
    ADD CONSTRAINT "Connection_organization_fk" FOREIGN KEY ("organizationId") REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: JobLog JobLog_jobRunId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."JobLog"
    ADD CONSTRAINT "JobLog_jobRunId_fkey" FOREIGN KEY ("jobRunId") REFERENCES public."JobRun"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: Lead Lead_campaignId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Lead"
    ADD CONSTRAINT "Lead_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES public."Campaign"(id) ON UPDATE CASCADE ON DELETE SET NULL;

--
-- Name: Lead Lead_linkedinAccountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Lead"
    ADD CONSTRAINT "Lead_linkedinAccountId_fkey" FOREIGN KEY ("linkedinAccountId") REFERENCES public."LinkedInAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;

--
-- Name: Lead Lead_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Lead"
    ADD CONSTRAINT "Lead_organization_fk" FOREIGN KEY ("organizationId") REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: Lead Lead_personId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Lead"
    ADD CONSTRAINT "Lead_personId_fkey" FOREIGN KEY ("personId") REFERENCES public.people(id) ON DELETE RESTRICT;

--
-- Name: LinkedInAccount LinkedInAccount_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."LinkedInAccount"
    ADD CONSTRAINT "LinkedInAccount_organization_fk" FOREIGN KEY ("organizationId") REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: Message Message_connectionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES public."Connection"(id) ON UPDATE CASCADE ON DELETE SET NULL;

--
-- Name: Message Message_leadId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES public."Lead"(id) ON UPDATE CASCADE ON DELETE SET NULL;

--
-- Name: Message Message_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."Message"
    ADD CONSTRAINT "Message_organization_fk" FOREIGN KEY ("organizationId") REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: SearchBatch SearchBatch_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SearchBatch"
    ADD CONSTRAINT "SearchBatch_organization_fk" FOREIGN KEY ("organizationId") REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: SearchQuery SearchQuery_batchId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SearchQuery"
    ADD CONSTRAINT "SearchQuery_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES public."SearchBatch"(id) ON DELETE CASCADE;

--
-- Name: SearchQuery SearchQuery_currentAccountId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SearchQuery"
    ADD CONSTRAINT "SearchQuery_currentAccountId_fkey" FOREIGN KEY ("currentAccountId") REFERENCES public."LinkedInAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;

--
-- Name: SearchResult SearchResult_searchQueryId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."SearchResult"
    ADD CONSTRAINT "SearchResult_searchQueryId_fkey" FOREIGN KEY ("searchQueryId") REFERENCES public."SearchQuery"(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: WebhookEvent WebhookEvent_connectionId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WebhookEvent"
    ADD CONSTRAINT "WebhookEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES public."Connection"(id) ON UPDATE CASCADE ON DELETE SET NULL;

--
-- Name: WebhookEvent WebhookEvent_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."WebhookEvent"
    ADD CONSTRAINT "WebhookEvent_organization_fk" FOREIGN KEY ("organizationId") REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: accounts accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: apify_runs apify_runs_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apify_runs
    ADD CONSTRAINT apify_runs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: apify_settings apify_settings_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.apify_settings
    ADD CONSTRAINT apify_settings_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: assistant_jobs assistant_jobs_audience_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_jobs
    ADD CONSTRAINT assistant_jobs_audience_id_fkey FOREIGN KEY (audience_id) REFERENCES public.lead_audiences(id) ON DELETE SET NULL;

--
-- Name: assistant_jobs assistant_jobs_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_jobs
    ADD CONSTRAINT assistant_jobs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: assistant_jobs assistant_jobs_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_jobs
    ADD CONSTRAINT assistant_jobs_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.assistant_threads(id) ON DELETE SET NULL;

--
-- Name: assistant_messages assistant_messages_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_messages
    ADD CONSTRAINT assistant_messages_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: assistant_messages assistant_messages_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_messages
    ADD CONSTRAINT assistant_messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.assistant_threads(id) ON DELETE CASCADE;

--
-- Name: assistant_profiles assistant_profiles_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_profiles
    ADD CONSTRAINT assistant_profiles_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: assistant_threads assistant_threads_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_threads
    ADD CONSTRAINT assistant_threads_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: assistant_usage assistant_usage_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assistant_usage
    ADD CONSTRAINT assistant_usage_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: autopilot_replies autopilot_replies_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_replies
    ADD CONSTRAINT autopilot_replies_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: autopilot_takeovers autopilot_takeovers_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.autopilot_takeovers
    ADD CONSTRAINT autopilot_takeovers_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: call_campaign_contacts call_campaign_contacts_campaign_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_campaign_contacts
    ADD CONSTRAINT call_campaign_contacts_campaign_fk FOREIGN KEY (campaign_id) REFERENCES public.call_campaigns(id) ON DELETE CASCADE;

--
-- Name: call_campaign_contacts call_campaign_contacts_person_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_campaign_contacts
    ADD CONSTRAINT call_campaign_contacts_person_fk FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE RESTRICT;

--
-- Name: call_campaigns call_campaigns_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_campaigns
    ADD CONSTRAINT call_campaigns_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: call_messages call_messages_call_session_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_messages
    ADD CONSTRAINT call_messages_call_session_fk FOREIGN KEY (call_session_id) REFERENCES public.call_sessions(id) ON DELETE SET NULL;

--
-- Name: call_messages call_messages_campaign_contact_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_messages
    ADD CONSTRAINT call_messages_campaign_contact_fk FOREIGN KEY (campaign_contact_id) REFERENCES public.call_campaign_contacts(id) ON DELETE CASCADE;

--
-- Name: call_messages call_messages_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_messages
    ADD CONSTRAINT call_messages_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: call_messages call_messages_person_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_messages
    ADD CONSTRAINT call_messages_person_fk FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE RESTRICT;

--
-- Name: call_sessions call_sessions_campaign_contact_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_sessions
    ADD CONSTRAINT call_sessions_campaign_contact_fk FOREIGN KEY (campaign_contact_id) REFERENCES public.call_campaign_contacts(id) ON DELETE SET NULL;

--
-- Name: call_sessions call_sessions_crm_record_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_sessions
    ADD CONSTRAINT call_sessions_crm_record_fk FOREIGN KEY (crm_record_id) REFERENCES public.crm_records(id) ON DELETE SET NULL;

--
-- Name: call_sessions call_sessions_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_sessions
    ADD CONSTRAINT call_sessions_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: call_sessions call_sessions_person_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_sessions
    ADD CONSTRAINT call_sessions_person_fk FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE RESTRICT;

--
-- Name: campaigns campaigns_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campaigns
    ADD CONSTRAINT campaigns_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: channel_settings channel_settings_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_settings
    ADD CONSTRAINT channel_settings_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: companies companies_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: crm_classifications crm_classifications_applied_category_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_classifications
    ADD CONSTRAINT crm_classifications_applied_category_fk FOREIGN KEY (applied_category_key) REFERENCES public.crm_categories(key) ON DELETE RESTRICT;

--
-- Name: crm_classifications crm_classifications_applied_subcategory_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_classifications
    ADD CONSTRAINT crm_classifications_applied_subcategory_fk FOREIGN KEY (applied_subcategory_id) REFERENCES public.crm_subcategories(id) ON DELETE RESTRICT;

--
-- Name: crm_classifications crm_classifications_message_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_classifications
    ADD CONSTRAINT crm_classifications_message_fk FOREIGN KEY (message_id) REFERENCES public.crm_conversation_messages(id) ON DELETE RESTRICT;

--
-- Name: crm_classifications crm_classifications_previous_category_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_classifications
    ADD CONSTRAINT crm_classifications_previous_category_fk FOREIGN KEY (previous_category_key) REFERENCES public.crm_categories(key) ON DELETE RESTRICT;

--
-- Name: crm_classifications crm_classifications_previous_subcategory_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_classifications
    ADD CONSTRAINT crm_classifications_previous_subcategory_fk FOREIGN KEY (previous_subcategory_id) REFERENCES public.crm_subcategories(id) ON DELETE RESTRICT;

--
-- Name: crm_classifications crm_classifications_proposed_category_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_classifications
    ADD CONSTRAINT crm_classifications_proposed_category_fk FOREIGN KEY (proposed_category_key) REFERENCES public.crm_categories(key) ON DELETE RESTRICT;

--
-- Name: crm_classifications crm_classifications_proposed_subcategory_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_classifications
    ADD CONSTRAINT crm_classifications_proposed_subcategory_fk FOREIGN KEY (proposed_subcategory_id) REFERENCES public.crm_subcategories(id) ON DELETE RESTRICT;

--
-- Name: crm_classifications crm_classifications_record_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_classifications
    ADD CONSTRAINT crm_classifications_record_fk FOREIGN KEY (crm_record_id) REFERENCES public.crm_records(id) ON DELETE RESTRICT;

--
-- Name: crm_conversation_messages crm_conversation_messages_conversation_identity_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_conversation_messages
    ADD CONSTRAINT crm_conversation_messages_conversation_identity_fk FOREIGN KEY (conversation_id, person_id, channel, account_ref) REFERENCES public.crm_conversations(id, person_id, channel, account_ref) ON DELETE RESTRICT;

--
-- Name: crm_conversations crm_conversations_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_conversations
    ADD CONSTRAINT crm_conversations_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: crm_conversations crm_conversations_record_person_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_conversations
    ADD CONSTRAINT crm_conversations_record_person_fk FOREIGN KEY (crm_record_id, person_id) REFERENCES public.crm_records(id, person_id) ON DELETE RESTRICT;

--
-- Name: crm_draft_knowledge_citations crm_draft_knowledge_citations_draft_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_draft_knowledge_citations
    ADD CONSTRAINT crm_draft_knowledge_citations_draft_fk FOREIGN KEY (draft_id) REFERENCES public.crm_drafts(id) ON DELETE RESTRICT;

--
-- Name: crm_draft_knowledge_citations crm_draft_knowledge_citations_version_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_draft_knowledge_citations
    ADD CONSTRAINT crm_draft_knowledge_citations_version_fk FOREIGN KEY (document_version_id) REFERENCES public.crm_knowledge_document_versions(id) ON DELETE RESTRICT;

--
-- Name: crm_drafts crm_drafts_conversation_record_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_drafts
    ADD CONSTRAINT crm_drafts_conversation_record_fk FOREIGN KEY (conversation_id, crm_record_id) REFERENCES public.crm_conversations(id, crm_record_id) ON DELETE RESTRICT;

--
-- Name: crm_drafts crm_drafts_record_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_drafts
    ADD CONSTRAINT crm_drafts_record_fk FOREIGN KEY (crm_record_id) REFERENCES public.crm_records(id) ON DELETE RESTRICT;

--
-- Name: crm_drafts crm_drafts_reply_message_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_drafts
    ADD CONSTRAINT crm_drafts_reply_message_fk FOREIGN KEY (reply_for_message_id) REFERENCES public.crm_conversation_messages(id) ON DELETE RESTRICT;

--
-- Name: crm_drafts crm_drafts_step_run_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_drafts
    ADD CONSTRAINT crm_drafts_step_run_fk FOREIGN KEY (sequence_step_run_id) REFERENCES public.crm_sequence_step_runs(id) ON DELETE RESTRICT;

--
-- Name: crm_email_drafts crm_email_drafts_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_email_drafts
    ADD CONSTRAINT crm_email_drafts_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.crm_leads(id) ON DELETE CASCADE;

--
-- Name: crm_email_drafts crm_email_drafts_reply_for_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_email_drafts
    ADD CONSTRAINT crm_email_drafts_reply_for_message_id_fkey FOREIGN KEY (reply_for_message_id) REFERENCES public.crm_messages(id) ON DELETE CASCADE;

--
-- Name: crm_events crm_events_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_events
    ADD CONSTRAINT crm_events_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: crm_events crm_events_person_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_events
    ADD CONSTRAINT crm_events_person_fk FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE RESTRICT;

--
-- Name: crm_events crm_events_pipeline_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_events
    ADD CONSTRAINT crm_events_pipeline_fk FOREIGN KEY (pipeline_id) REFERENCES public.crm_pipelines(id) ON DELETE RESTRICT;

--
-- Name: crm_events crm_events_record_person_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_events
    ADD CONSTRAINT crm_events_record_person_fk FOREIGN KEY (crm_record_id, person_id) REFERENCES public.crm_records(id, person_id) ON DELETE RESTRICT;

--
-- Name: crm_events crm_events_record_pipeline_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_events
    ADD CONSTRAINT crm_events_record_pipeline_fk FOREIGN KEY (crm_record_id, pipeline_id) REFERENCES public.crm_records(id, pipeline_id) ON DELETE RESTRICT;

--
-- Name: crm_identity_exceptions crm_identity_exceptions_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_identity_exceptions
    ADD CONSTRAINT crm_identity_exceptions_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: crm_identity_exceptions crm_identity_exceptions_person_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_identity_exceptions
    ADD CONSTRAINT crm_identity_exceptions_person_fk FOREIGN KEY (resolved_person_id) REFERENCES public.people(id) ON DELETE RESTRICT;

--
-- Name: crm_jobs crm_jobs_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_jobs
    ADD CONSTRAINT crm_jobs_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: crm_knowledge_document_versions crm_knowledge_document_versions_document_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_knowledge_document_versions
    ADD CONSTRAINT crm_knowledge_document_versions_document_fk FOREIGN KEY (document_id) REFERENCES public.crm_knowledge_documents(id) ON DELETE RESTRICT;

--
-- Name: crm_knowledge_documents crm_knowledge_documents_latest_version_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_knowledge_documents
    ADD CONSTRAINT crm_knowledge_documents_latest_version_fk FOREIGN KEY (id, latest_version) REFERENCES public.crm_knowledge_document_versions(document_id, version) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

--
-- Name: crm_knowledge_documents crm_knowledge_documents_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_knowledge_documents
    ADD CONSTRAINT crm_knowledge_documents_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: crm_lead_ccs crm_lead_ccs_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_lead_ccs
    ADD CONSTRAINT crm_lead_ccs_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.crm_leads(id) ON DELETE CASCADE;

--
-- Name: crm_leads crm_leads_current_status_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_leads
    ADD CONSTRAINT crm_leads_current_status_key_fkey FOREIGN KEY (current_status_key) REFERENCES public.crm_status_config(status_key);

--
-- Name: crm_leads crm_leads_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_leads
    ADD CONSTRAINT crm_leads_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: crm_messages crm_messages_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_messages
    ADD CONSTRAINT crm_messages_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.crm_leads(id) ON DELETE CASCADE;

--
-- Name: crm_notes crm_notes_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_notes
    ADD CONSTRAINT crm_notes_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.crm_leads(id) ON DELETE CASCADE;

--
-- Name: crm_notes crm_notes_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_notes
    ADD CONSTRAINT crm_notes_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: crm_person_contact_policies crm_person_contact_policies_person_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_person_contact_policies
    ADD CONSTRAINT crm_person_contact_policies_person_fk FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE RESTRICT;

--
-- Name: crm_pipelines crm_pipelines_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_pipelines
    ADD CONSTRAINT crm_pipelines_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: crm_record_sequence_overrides crm_record_sequence_overrides_record_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_record_sequence_overrides
    ADD CONSTRAINT crm_record_sequence_overrides_record_fk FOREIGN KEY (crm_record_id) REFERENCES public.crm_records(id) ON DELETE RESTRICT;

--
-- Name: crm_record_sequence_overrides crm_record_sequence_overrides_sequence_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_record_sequence_overrides
    ADD CONSTRAINT crm_record_sequence_overrides_sequence_fk FOREIGN KEY (sequence_id) REFERENCES public.crm_sequences(id) ON DELETE RESTRICT;

--
-- Name: crm_records crm_records_category_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_records
    ADD CONSTRAINT crm_records_category_fk FOREIGN KEY (category_key) REFERENCES public.crm_categories(key) ON DELETE RESTRICT;

--
-- Name: crm_records crm_records_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_records
    ADD CONSTRAINT crm_records_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: crm_records crm_records_person_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_records
    ADD CONSTRAINT crm_records_person_fk FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE RESTRICT;

--
-- Name: crm_records crm_records_pipeline_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_records
    ADD CONSTRAINT crm_records_pipeline_fk FOREIGN KEY (pipeline_id) REFERENCES public.crm_pipelines(id) ON DELETE RESTRICT;

--
-- Name: crm_records crm_records_subcategory_target_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_records
    ADD CONSTRAINT crm_records_subcategory_target_fk FOREIGN KEY (subcategory_id, pipeline_id, category_key) REFERENCES public.crm_subcategories(id, pipeline_id, category_key) ON DELETE RESTRICT;

--
-- Name: crm_send_attempts crm_send_attempts_draft_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_send_attempts
    ADD CONSTRAINT crm_send_attempts_draft_fk FOREIGN KEY (draft_id) REFERENCES public.crm_drafts(id) ON DELETE RESTRICT;

--
-- Name: crm_sequence_runs crm_sequence_runs_conversation_record_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_runs
    ADD CONSTRAINT crm_sequence_runs_conversation_record_fk FOREIGN KEY (conversation_id, crm_record_id) REFERENCES public.crm_conversations(id, crm_record_id) ON DELETE RESTRICT;

--
-- Name: crm_sequence_runs crm_sequence_runs_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_runs
    ADD CONSTRAINT crm_sequence_runs_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: crm_sequence_runs crm_sequence_runs_record_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_runs
    ADD CONSTRAINT crm_sequence_runs_record_fk FOREIGN KEY (crm_record_id) REFERENCES public.crm_records(id) ON DELETE RESTRICT;

--
-- Name: crm_sequence_runs crm_sequence_runs_subcategory_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_runs
    ADD CONSTRAINT crm_sequence_runs_subcategory_fk FOREIGN KEY (subcategory_id) REFERENCES public.crm_subcategories(id) ON DELETE RESTRICT;

--
-- Name: crm_sequence_runs crm_sequence_runs_trigger_message_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_runs
    ADD CONSTRAINT crm_sequence_runs_trigger_message_fk FOREIGN KEY (trigger_message_id) REFERENCES public.crm_conversation_messages(id) ON DELETE RESTRICT;

--
-- Name: crm_sequence_runs crm_sequence_runs_version_sequence_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_runs
    ADD CONSTRAINT crm_sequence_runs_version_sequence_fk FOREIGN KEY (sequence_version_id, sequence_id) REFERENCES public.crm_sequence_versions(id, sequence_id) ON DELETE RESTRICT;

--
-- Name: crm_sequence_step_runs crm_sequence_step_runs_draft_id_crm_drafts_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_step_runs
    ADD CONSTRAINT crm_sequence_step_runs_draft_id_crm_drafts_id_fk FOREIGN KEY (draft_id) REFERENCES public.crm_drafts(id) ON DELETE RESTRICT;

--
-- Name: crm_sequence_step_runs crm_sequence_step_runs_run_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_step_runs
    ADD CONSTRAINT crm_sequence_step_runs_run_fk FOREIGN KEY (sequence_run_id) REFERENCES public.crm_sequence_runs(id) ON DELETE RESTRICT;

--
-- Name: crm_sequence_step_runs crm_sequence_step_runs_sent_message_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_step_runs
    ADD CONSTRAINT crm_sequence_step_runs_sent_message_fk FOREIGN KEY (sent_message_id) REFERENCES public.crm_conversation_messages(id) ON DELETE RESTRICT;

--
-- Name: crm_sequence_step_runs crm_sequence_step_runs_step_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_step_runs
    ADD CONSTRAINT crm_sequence_step_runs_step_fk FOREIGN KEY (sequence_step_id) REFERENCES public.crm_sequence_steps(id) ON DELETE RESTRICT;

--
-- Name: crm_sequence_steps crm_sequence_steps_version_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_steps
    ADD CONSTRAINT crm_sequence_steps_version_fk FOREIGN KEY (sequence_version_id) REFERENCES public.crm_sequence_versions(id) ON DELETE RESTRICT;

--
-- Name: crm_sequence_versions crm_sequence_versions_sequence_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequence_versions
    ADD CONSTRAINT crm_sequence_versions_sequence_fk FOREIGN KEY (sequence_id) REFERENCES public.crm_sequences(id) ON DELETE RESTRICT;

--
-- Name: crm_sequences crm_sequences_draft_version_id_crm_sequence_versions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequences
    ADD CONSTRAINT crm_sequences_draft_version_id_crm_sequence_versions_id_fk FOREIGN KEY (draft_version_id) REFERENCES public.crm_sequence_versions(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

--
-- Name: crm_sequences crm_sequences_latest_published_version_id_crm_sequence_versions; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequences
    ADD CONSTRAINT crm_sequences_latest_published_version_id_crm_sequence_versions FOREIGN KEY (latest_published_version_id) REFERENCES public.crm_sequence_versions(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

--
-- Name: crm_sequences crm_sequences_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_sequences
    ADD CONSTRAINT crm_sequences_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: crm_settings crm_settings_pipeline_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_settings
    ADD CONSTRAINT crm_settings_pipeline_fk FOREIGN KEY (pipeline_id) REFERENCES public.crm_pipelines(id) ON DELETE RESTRICT;

--
-- Name: crm_subcategories crm_subcategories_category_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_subcategories
    ADD CONSTRAINT crm_subcategories_category_fk FOREIGN KEY (category_key) REFERENCES public.crm_categories(key) ON DELETE RESTRICT;

--
-- Name: crm_subcategories crm_subcategories_pipeline_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_subcategories
    ADD CONSTRAINT crm_subcategories_pipeline_fk FOREIGN KEY (pipeline_id) REFERENCES public.crm_pipelines(id) ON DELETE RESTRICT;

--
-- Name: crm_subcategory_sequence_assignments crm_subcategory_sequence_assignments_sequence_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_subcategory_sequence_assignments
    ADD CONSTRAINT crm_subcategory_sequence_assignments_sequence_fk FOREIGN KEY (sequence_id) REFERENCES public.crm_sequences(id) ON DELETE RESTRICT;

--
-- Name: crm_subcategory_sequence_assignments crm_subcategory_sequence_assignments_subcategory_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_subcategory_sequence_assignments
    ADD CONSTRAINT crm_subcategory_sequence_assignments_subcategory_fk FOREIGN KEY (subcategory_id) REFERENCES public.crm_subcategories(id) ON DELETE RESTRICT;

--
-- Name: crm_tasks crm_tasks_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_tasks
    ADD CONSTRAINT crm_tasks_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.crm_leads(id) ON DELETE CASCADE;

--
-- Name: crm_tasks crm_tasks_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_tasks
    ADD CONSTRAINT crm_tasks_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: crm_webhook_events crm_webhook_events_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.crm_webhook_events
    ADD CONSTRAINT crm_webhook_events_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: daily_summaries daily_summaries_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.daily_summaries
    ADD CONSTRAINT daily_summaries_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: entity_columns entity_columns_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_columns
    ADD CONSTRAINT entity_columns_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: grid_cell_runs grid_cell_runs_row_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_cell_runs
    ADD CONSTRAINT grid_cell_runs_row_id_fkey FOREIGN KEY (row_id) REFERENCES public.grid_rows(id) ON DELETE CASCADE;

--
-- Name: grid_cell_runs grid_cell_runs_table_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_cell_runs
    ADD CONSTRAINT grid_cell_runs_table_id_fkey FOREIGN KEY (table_id) REFERENCES public.grid_tables(id) ON DELETE CASCADE;

--
-- Name: grid_columns grid_columns_table_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_columns
    ADD CONSTRAINT grid_columns_table_id_fkey FOREIGN KEY (table_id) REFERENCES public.grid_tables(id) ON DELETE CASCADE;

--
-- Name: grid_folders grid_folders_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_folders
    ADD CONSTRAINT grid_folders_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: grid_folders grid_folders_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_folders
    ADD CONSTRAINT grid_folders_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.grid_folders(id) ON DELETE CASCADE;

--
-- Name: grid_jobs grid_jobs_row_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_jobs
    ADD CONSTRAINT grid_jobs_row_id_fkey FOREIGN KEY (row_id) REFERENCES public.grid_rows(id) ON DELETE CASCADE;

--
-- Name: grid_jobs grid_jobs_table_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_jobs
    ADD CONSTRAINT grid_jobs_table_id_fkey FOREIGN KEY (table_id) REFERENCES public.grid_tables(id) ON DELETE CASCADE;

--
-- Name: grid_provider_credentials grid_provider_credentials_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_provider_credentials
    ADD CONSTRAINT grid_provider_credentials_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.grid_providers(id) ON DELETE CASCADE;

--
-- Name: grid_providers grid_providers_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_providers
    ADD CONSTRAINT grid_providers_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: grid_rows grid_rows_table_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_rows
    ADD CONSTRAINT grid_rows_table_id_fkey FOREIGN KEY (table_id) REFERENCES public.grid_tables(id) ON DELETE CASCADE;

--
-- Name: grid_tables grid_tables_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_tables
    ADD CONSTRAINT grid_tables_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: grid_tables grid_tables_workbook_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_tables
    ADD CONSTRAINT grid_tables_workbook_fk FOREIGN KEY (workbook_id) REFERENCES public.grid_workbooks(id) ON DELETE CASCADE;

--
-- Name: grid_workbooks grid_workbooks_folder_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_workbooks
    ADD CONSTRAINT grid_workbooks_folder_fk FOREIGN KEY (folder_id) REFERENCES public.grid_folders(id) ON DELETE SET NULL;

--
-- Name: grid_workbooks grid_workbooks_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_workbooks
    ADD CONSTRAINT grid_workbooks_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: import_runs import_runs_grid_table_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_runs
    ADD CONSTRAINT import_runs_grid_table_id_fkey FOREIGN KEY (grid_table_id) REFERENCES public.grid_tables(id) ON DELETE SET NULL;

--
-- Name: import_runs import_runs_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_runs
    ADD CONSTRAINT import_runs_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: inquiries inquiries_endpoint_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inquiries
    ADD CONSTRAINT inquiries_endpoint_id_fkey FOREIGN KEY (endpoint_id) REFERENCES public.intake_endpoints(id) ON DELETE SET NULL;

--
-- Name: inquiries inquiries_instagram_chat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inquiries
    ADD CONSTRAINT inquiries_instagram_chat_id_fkey FOREIGN KEY (instagram_chat_id) REFERENCES public.instagram_chats(id) ON DELETE SET NULL;

--
-- Name: inquiries inquiries_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inquiries
    ADD CONSTRAINT inquiries_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: inquiries inquiries_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inquiries
    ADD CONSTRAINT inquiries_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE SET NULL;

--
-- Name: instagram_accounts instagram_accounts_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_accounts
    ADD CONSTRAINT instagram_accounts_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: instagram_chats instagram_chats_account_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_chats
    ADD CONSTRAINT instagram_chats_account_fk FOREIGN KEY (account_id) REFERENCES public.instagram_accounts(id) ON DELETE CASCADE;

--
-- Name: instagram_chats instagram_chats_person_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_chats
    ADD CONSTRAINT instagram_chats_person_fk FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE SET NULL;

--
-- Name: instagram_messages instagram_messages_chat_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_messages
    ADD CONSTRAINT instagram_messages_chat_fk FOREIGN KEY (chat_id) REFERENCES public.instagram_chats(id) ON DELETE CASCADE;

--
-- Name: instagram_messages instagram_messages_crm_message_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instagram_messages
    ADD CONSTRAINT instagram_messages_crm_message_fk FOREIGN KEY (crm_conversation_message_id) REFERENCES public.crm_conversation_messages(id) ON DELETE SET NULL;

--
-- Name: intake_endpoints intake_endpoints_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intake_endpoints
    ADD CONSTRAINT intake_endpoints_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: invitations invitations_inviter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_inviter_id_fkey FOREIGN KEY (inviter_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: invitations invitations_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

--
-- Name: lead_audience_member_insights lead_audience_member_insights_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_audience_member_insights
    ADD CONSTRAINT lead_audience_member_insights_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.lead_audience_members(id) ON DELETE CASCADE;

--
-- Name: lead_audience_members lead_audience_members_audience_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_audience_members
    ADD CONSTRAINT lead_audience_members_audience_id_fkey FOREIGN KEY (audience_id) REFERENCES public.lead_audiences(id) ON DELETE CASCADE;

--
-- Name: lead_audience_members lead_audience_members_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_audience_members
    ADD CONSTRAINT lead_audience_members_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;

--
-- Name: lead_audience_members lead_audience_members_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_audience_members
    ADD CONSTRAINT lead_audience_members_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: lead_audience_members lead_audience_members_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_audience_members
    ADD CONSTRAINT lead_audience_members_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE CASCADE;

--
-- Name: lead_audiences lead_audiences_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_audiences
    ADD CONSTRAINT lead_audiences_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: lead_audiences lead_audiences_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_audiences
    ADD CONSTRAINT lead_audiences_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.assistant_threads(id) ON DELETE SET NULL;

--
-- Name: lead_research lead_research_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_research
    ADD CONSTRAINT lead_research_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;

--
-- Name: lead_research lead_research_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_research
    ADD CONSTRAINT lead_research_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: members members_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

--
-- Name: members members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.members
    ADD CONSTRAINT members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: organization_features organization_features_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization_features
    ADD CONSTRAINT organization_features_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: outreach_campaigns outreach_campaigns_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_campaigns
    ADD CONSTRAINT outreach_campaigns_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: outreach_emails outreach_emails_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_emails
    ADD CONSTRAINT outreach_emails_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.outreach_leads(id) ON DELETE CASCADE;

--
-- Name: outreach_emails outreach_emails_mailbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_emails
    ADD CONSTRAINT outreach_emails_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES public.outreach_mailboxes(id);

--
-- Name: outreach_leads outreach_leads_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_leads
    ADD CONSTRAINT outreach_leads_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.outreach_campaigns(id) ON DELETE CASCADE;

--
-- Name: outreach_leads outreach_leads_mailbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_leads
    ADD CONSTRAINT outreach_leads_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES public.outreach_mailboxes(id);

--
-- Name: outreach_leads outreach_leads_person_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_leads
    ADD CONSTRAINT outreach_leads_person_fk FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE RESTRICT;

--
-- Name: outreach_mailbox_queue outreach_mailbox_queue_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_mailbox_queue
    ADD CONSTRAINT outreach_mailbox_queue_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.outreach_leads(id) ON DELETE CASCADE;

--
-- Name: outreach_mailbox_queue outreach_mailbox_queue_mailbox_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_mailbox_queue
    ADD CONSTRAINT outreach_mailbox_queue_mailbox_id_fkey FOREIGN KEY (mailbox_id) REFERENCES public.outreach_mailboxes(id) ON DELETE CASCADE;

--
-- Name: outreach_mailboxes outreach_mailboxes_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_mailboxes
    ADD CONSTRAINT outreach_mailboxes_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: outreach_run_leads outreach_run_leads_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_run_leads
    ADD CONSTRAINT outreach_run_leads_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: outreach_run_leads outreach_run_leads_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_run_leads
    ADD CONSTRAINT outreach_run_leads_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE CASCADE;

--
-- Name: outreach_run_leads outreach_run_leads_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_run_leads
    ADD CONSTRAINT outreach_run_leads_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.outreach_runs(id) ON DELETE CASCADE;

--
-- Name: outreach_runs outreach_runs_audience_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_runs
    ADD CONSTRAINT outreach_runs_audience_id_fkey FOREIGN KEY (audience_id) REFERENCES public.lead_audiences(id) ON DELETE RESTRICT;

--
-- Name: outreach_runs outreach_runs_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_runs
    ADD CONSTRAINT outreach_runs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: outreach_runs outreach_runs_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_runs
    ADD CONSTRAINT outreach_runs_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.assistant_threads(id) ON DELETE SET NULL;

--
-- Name: outreach_suppression_list outreach_suppression_list_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outreach_suppression_list
    ADD CONSTRAINT outreach_suppression_list_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: owner_decisions owner_decisions_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.owner_decisions
    ADD CONSTRAINT owner_decisions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: people people_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people
    ADD CONSTRAINT people_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE SET NULL;

--
-- Name: people people_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people
    ADD CONSTRAINT people_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: qualification_jobs qualification_jobs_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qualification_jobs
    ADD CONSTRAINT qualification_jobs_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id);

--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: targeted_domains targeted_domains_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.targeted_domains
    ADD CONSTRAINT targeted_domains_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id);

--
-- Name: targeted_domains targeted_domains_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.targeted_domains
    ADD CONSTRAINT targeted_domains_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: team_members team_members_team_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_team_id_fkey FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE CASCADE;

--
-- Name: team_members team_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: teams teams_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teams
    ADD CONSTRAINT teams_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

--
-- Name: whatsapp_accounts whatsapp_accounts_organization_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_accounts
    ADD CONSTRAINT whatsapp_accounts_organization_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;

--
-- Name: whatsapp_campaign_accounts whatsapp_campaign_accounts_account_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_campaign_accounts
    ADD CONSTRAINT whatsapp_campaign_accounts_account_fk FOREIGN KEY (account_id) REFERENCES public.whatsapp_accounts(id) ON DELETE CASCADE;

--
-- Name: whatsapp_campaign_accounts whatsapp_campaign_accounts_campaign_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_campaign_accounts
    ADD CONSTRAINT whatsapp_campaign_accounts_campaign_fk FOREIGN KEY (campaign_id) REFERENCES public.whatsapp_campaigns(id) ON DELETE CASCADE;

--
-- Name: whatsapp_campaign_leads whatsapp_campaign_leads_account_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_campaign_leads
    ADD CONSTRAINT whatsapp_campaign_leads_account_fk FOREIGN KEY (account_id) REFERENCES public.whatsapp_accounts(id) ON DELETE SET NULL;

--
-- Name: whatsapp_campaign_leads whatsapp_campaign_leads_campaign_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_campaign_leads
    ADD CONSTRAINT whatsapp_campaign_leads_campaign_fk FOREIGN KEY (campaign_id) REFERENCES public.whatsapp_campaigns(id) ON DELETE CASCADE;

--
-- Name: whatsapp_campaign_leads whatsapp_campaign_leads_person_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_campaign_leads
    ADD CONSTRAINT whatsapp_campaign_leads_person_fk FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE CASCADE;

--
-- Name: whatsapp_campaign_sends whatsapp_campaign_sends_account_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_campaign_sends
    ADD CONSTRAINT whatsapp_campaign_sends_account_fk FOREIGN KEY (account_id) REFERENCES public.whatsapp_accounts(id) ON DELETE SET NULL;

--
-- Name: whatsapp_campaign_sends whatsapp_campaign_sends_lead_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_campaign_sends
    ADD CONSTRAINT whatsapp_campaign_sends_lead_fk FOREIGN KEY (lead_id) REFERENCES public.whatsapp_campaign_leads(id) ON DELETE CASCADE;

--
-- Name: whatsapp_campaign_sends whatsapp_campaign_sends_message_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_campaign_sends
    ADD CONSTRAINT whatsapp_campaign_sends_message_fk FOREIGN KEY (whatsapp_message_id) REFERENCES public.whatsapp_messages(id) ON DELETE SET NULL;

--
-- Name: whatsapp_campaigns whatsapp_campaigns_organization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_campaigns
    ADD CONSTRAINT whatsapp_campaigns_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

--
-- Name: whatsapp_chats whatsapp_chats_account_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_chats
    ADD CONSTRAINT whatsapp_chats_account_fk FOREIGN KEY (account_id) REFERENCES public.whatsapp_accounts(id) ON DELETE CASCADE;

--
-- Name: whatsapp_chats whatsapp_chats_person_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_chats
    ADD CONSTRAINT whatsapp_chats_person_fk FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE SET NULL;

--
-- Name: whatsapp_messages whatsapp_messages_call_session_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_messages
    ADD CONSTRAINT whatsapp_messages_call_session_fk FOREIGN KEY (call_session_id) REFERENCES public.call_sessions(id) ON DELETE SET NULL;

--
-- Name: whatsapp_messages whatsapp_messages_chat_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_messages
    ADD CONSTRAINT whatsapp_messages_chat_fk FOREIGN KEY (chat_id) REFERENCES public.whatsapp_chats(id) ON DELETE CASCADE;

--
-- Name: whatsapp_messages whatsapp_messages_crm_message_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_messages
    ADD CONSTRAINT whatsapp_messages_crm_message_fk FOREIGN KEY (crm_conversation_message_id) REFERENCES public.crm_conversation_messages(id) ON DELETE SET NULL;

--
-- PostgreSQL database dump complete
--
