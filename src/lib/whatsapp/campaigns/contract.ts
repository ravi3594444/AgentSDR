/**
 * WhatsApp message campaigns: the shapes the API, the pages and the sender
 * loop share. Client-safe and import-free. See docs/whatsapp-campaigns/plan.md.
 */

export const WHATSAPP_CAMPAIGN_STATUSES = ["active", "paused"] as const;
export type WhatsappCampaignStatus = (typeof WHATSAPP_CAMPAIGN_STATUSES)[number];

/**
 * queued       — enrolled, first message not sent yet
 * in_sequence  — at least one message sent, more to come
 * completed    — every step sent, no reply
 * replied      — the lead answered (on any channel); the sequence stopped
 * stopped      — stopped by a person, or the lead is Do Not Contact
 * failed       — WhatsApp refused the number or the message; see lastError
 */
export const WHATSAPP_CAMPAIGN_LEAD_STATUSES = ["queued", "in_sequence", "completed", "replied", "stopped", "failed"] as const;
export type WhatsappCampaignLeadStatus = (typeof WHATSAPP_CAMPAIGN_LEAD_STATUSES)[number];

/** Statuses the sender still works on. */
export const WHATSAPP_CAMPAIGN_OPEN_LEAD_STATUSES = ["queued", "in_sequence"] as const satisfies readonly WhatsappCampaignLeadStatus[];

export type WhatsappCampaignSendStatus = "sending" | "sent" | "failed";

export type WhatsappCampaignStep = {
  /** Stable id, so the editor can key steps and stats can follow a step across edits. */
  id: string;
  body: string;
  /** Hours after the previous message. Ignored for the first step. */
  delayHours: number;
};

export const WHATSAPP_CAMPAIGN_MAX_STEPS = 6;
export const WHATSAPP_CAMPAIGN_MIN_DELAY_HOURS = 1;
export const WHATSAPP_CAMPAIGN_MAX_DELAY_HOURS = 24 * 30;
export const WHATSAPP_CAMPAIGN_DEFAULT_DELAY_HOURS = 48;
/** sendWhatsapp's own limit. */
export const WHATSAPP_CAMPAIGN_MAX_BODY_LENGTH = 4096;
export const WHATSAPP_CAMPAIGN_MAX_IMPORT_ROWS = 5000;

/** The spreadsheet fields a column can map to; `phone` is the only required one. */
export const WHATSAPP_CAMPAIGN_IMPORT_FIELDS = [
  { key: "phone", label: "Phone number", required: true },
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "fullName", label: "Full name" },
  { key: "email", label: "Email" },
  { key: "title", label: "Job title" },
  { key: "companyName", label: "Company name" },
  { key: "companyDomain", label: "Company website" },
  { key: "linkedinUrl", label: "LinkedIn URL" },
] as const;
export type WhatsappCampaignImportField = (typeof WHATSAPP_CAMPAIGN_IMPORT_FIELDS)[number]["key"];

export type WhatsappCampaignSender = {
  accountId: string;
  name: string | null;
  phone: string | null;
  status: string;
};

/** Lead counts by status, plus messages actually delivered to WhatsApp. */
/**
 * A campaign's leads by where they are now, plus two counts from durable
 * evidence that a stop, a pause or a later failure does not erase:
 * `contacted`, leads sent at least one message (last_sent_at) or that
 * replied, and `messagesSent`, the messages themselves (several per lead).
 */
export type WhatsappCampaignStats = Record<WhatsappCampaignLeadStatus, number> & {
  total: number;
  contacted: number;
  messagesSent: number;
};

export type WhatsappCampaignSummary = {
  id: string;
  name: string;
  description: string | null;
  status: WhatsappCampaignStatus;
  stepCount: number;
  senders: WhatsappCampaignSender[];
  stats: WhatsappCampaignStats;
  createdAt: string;
  updatedAt: string;
};

export type WhatsappCampaignDetail = WhatsappCampaignSummary & {
  steps: WhatsappCampaignStep[];
  /** Messages sent per step id, for the sequence and overview. */
  sentByStep: Record<string, number>;
};

export type WhatsappCampaignLead = {
  id: string;
  personId: string;
  name: string | null;
  phone: string;
  companyName: string | null;
  title: string | null;
  status: WhatsappCampaignLeadStatus;
  /** Messages sent so far (0 = none). */
  currentStep: number;
  nextSendAt: string | null;
  lastSentAt: string | null;
  repliedAt: string | null;
  lastError: string | null;
  /** The number the sequence is on, once the first message went. */
  accountId: string | null;
  /** The WhatsApp chat, for a link to Messages. */
  chatId: string | null;
  createdAt: string;
};

// --- requests / responses -------------------------------------------------------------

export type ListWhatsappCampaignsResponse = { campaigns: WhatsappCampaignSummary[] };

export type CreateWhatsappCampaignRequest = {
  name: string;
  description?: string | null;
  accountIds?: string[];
  steps?: WhatsappCampaignStep[];
};

export type UpdateWhatsappCampaignRequest = {
  name?: string;
  description?: string | null;
  accountIds?: string[];
  steps?: WhatsappCampaignStep[];
  /** "active" launches or resumes: needs a connected number, a lead and a non-empty first step. */
  status?: WhatsappCampaignStatus;
};

export type ListWhatsappCampaignLeadsQuery = {
  status?: WhatsappCampaignLeadStatus;
  q?: string;
  page?: number;
  pageSize?: number;
};

export type ListWhatsappCampaignLeadsResponse = {
  leads: WhatsappCampaignLead[];
  total: number;
  page: number;
  pageSize: number;
};

export type AddWhatsappCampaignPeopleRequest = { personIds: string[] };
export type AddWhatsappCampaignPeopleResponse = {
  added: number;
  skippedDuplicate: number;
  skippedMissingPhone: number;
};

/** `POST /[id]/upload` with `mode=preview`. */
export type WhatsappCampaignUploadPreview = {
  headers: string[];
  rows: string[][];
  totalRows: number;
  suggestedMapping: Record<string, string>;
};

/** `POST /[id]/upload` with `mapping` (field key → column header). */
export type WhatsappCampaignImportResponse = {
  added: number;
  alreadyInCampaign: number;
  /** "row N: reason", capped. */
  skipped: string[];
};

export type UpdateWhatsappCampaignLeadRequest = { action: "stop" | "resume" };

export type WhatsappCampaignMergeField = { token: string; label: string };
export type WhatsappCampaignMergeFieldsResponse = {
  fields: WhatsappCampaignMergeField[];
  leads: { id: string; name: string | null; phone: string }[];
};

export type PreviewWhatsappCampaignStepRequest = { body: string; leadId?: string };
export type PreviewWhatsappCampaignStepResponse = {
  rendered: string;
  unresolved: string[];
  lead: { id: string; name: string | null; phone: string };
};

// --- pure helpers -------------------------------------------------------------------------

/** Why a sequence cannot be saved, or null. Pure, shared by the editor and the API. */
export function whatsappCampaignStepsError(steps: WhatsappCampaignStep[]): string | null {
  if (steps.length > WHATSAPP_CAMPAIGN_MAX_STEPS) return `A sequence has at most ${WHATSAPP_CAMPAIGN_MAX_STEPS} messages`;
  const ids = new Set<string>();
  for (const [index, step] of steps.entries()) {
    const label = index === 0 ? "The first message" : `Follow-up ${index}`;
    if (!step.id || ids.has(step.id)) return `${label} needs a unique id`;
    ids.add(step.id);
    if (!step.body.trim()) return `${label} is empty`;
    if (step.body.length > WHATSAPP_CAMPAIGN_MAX_BODY_LENGTH) return `${label} is longer than ${WHATSAPP_CAMPAIGN_MAX_BODY_LENGTH} characters`;
    if (index > 0) {
      if (!Number.isInteger(step.delayHours)) return `${label}'s wait must be whole hours`;
      if (step.delayHours < WHATSAPP_CAMPAIGN_MIN_DELAY_HOURS || step.delayHours > WHATSAPP_CAMPAIGN_MAX_DELAY_HOURS) {
        return `${label} must wait between ${WHATSAPP_CAMPAIGN_MIN_DELAY_HOURS} hour and ${WHATSAPP_CAMPAIGN_MAX_DELAY_HOURS / 24} days`;
      }
    }
  }
  return null;
}

/** Steps as saved: bodies kept verbatim, the first step's delay zeroed. */
export function normalizeWhatsappCampaignSteps(steps: WhatsappCampaignStep[]): WhatsappCampaignStep[] {
  return steps.map((step, index) => ({ id: step.id, body: step.body, delayHours: index === 0 ? 0 : step.delayHours }));
}
