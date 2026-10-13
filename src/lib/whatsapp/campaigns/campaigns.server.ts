import "server-only";

import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { withLeadTransaction } from "@/lib/leads/records";
import { organizationPhoneCountry } from "@/lib/calls/phone.server";
import { findOrCreateContactPerson, resolveImportRow } from "@/lib/calls/campaigns";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { WhatsappApiError } from "../errors";
import { chatInOrg, visibleChat } from "../messages";
import {
  whatsappAccounts,
  whatsappCampaignAccounts,
  whatsappCampaignLeads,
  whatsappCampaignSends,
  whatsappCampaigns,
  whatsappChats,
} from "../schema";
import {
  normalizeWhatsappCampaignSteps,
  WHATSAPP_CAMPAIGN_IMPORT_FIELDS,
  WHATSAPP_CAMPAIGN_LEAD_STATUSES,
  WHATSAPP_CAMPAIGN_MAX_IMPORT_ROWS,
  whatsappCampaignStepsError,
  type AddWhatsappCampaignPeopleResponse,
  type CreateWhatsappCampaignRequest,
  type ListWhatsappCampaignLeadsQuery,
  type ListWhatsappCampaignLeadsResponse,
  type PreviewWhatsappCampaignStepRequest,
  type PreviewWhatsappCampaignStepResponse,
  type UpdateWhatsappCampaignLeadRequest,
  type UpdateWhatsappCampaignRequest,
  type WhatsappCampaignDetail,
  type WhatsappCampaignImportResponse,
  type WhatsappCampaignLead,
  type WhatsappCampaignMergeFieldsResponse,
  type WhatsappCampaignSender,
  type WhatsappCampaignStats,
  type WhatsappCampaignStatus,
  type WhatsappCampaignSummary,
  type WhatsappCampaignUploadPreview,
} from "./contract";
import {
  importMappingError,
  mapImportRow,
  campaignPhoneProblem,
  normalizeCampaignPhone,
  parseImportSheet,
  suggestWhatsappMapping,
  type ImportMapping,
} from "./importMapping";
import { IN_FLIGHT_CLAIM_MS } from "./engineRules";
import { campaignLeadVariables, renderCampaignStep, unresolvedMergeFields } from "./render";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SKIPPED_REPORTED = 50;
const MAX_MERGE_FIELD_LEADS = 250;
const MERGE_FIELD_PICKER_LEADS = 20;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_ADD_PEOPLE = 5000;
const LEAD_SOURCE = "whatsapp-campaign-lead";

type CampaignRow = typeof whatsappCampaigns.$inferSelect;
type LeadRow = typeof whatsappCampaignLeads.$inferSelect;
type PersonRow = typeof people.$inferSelect;
type CompanyRow = typeof companies.$inferSelect;

/** A malformed id reads as 404, the same as one in another organization. */
function assertUuidShape(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) throw new WhatsappApiError(404, `${label} not found`);
}

/**
 * whatsapp_campaign_leads has no organization column: it belongs to its
 * campaign's organization. This is the filter that says so.
 */
export function campaignLeadInOrg(): SQL {
  return inArray(whatsappCampaignLeads.campaignId, db.select({ id: whatsappCampaigns.id }).from(whatsappCampaigns).where(inOrg(whatsappCampaigns)));
}

/** A live (not archived) campaign of this organization, or 404. */
async function loadCampaignRow(campaignId: string): Promise<CampaignRow> {
  assertUuidShape(campaignId, "Campaign");
  const [row] = await db
    .select()
    .from(whatsappCampaigns)
    .where(and(inOrg(whatsappCampaigns), eq(whatsappCampaigns.id, campaignId), sql`${whatsappCampaigns.archivedAt} IS NULL`))
    .limit(1);
  if (!row) throw new WhatsappApiError(404, "Campaign not found");
  return row;
}

// --- summaries ---------------------------------------------------------------------------

function emptyStats(): WhatsappCampaignStats {
  return { queued: 0, in_sequence: 0, completed: 0, replied: 0, stopped: 0, failed: 0, total: 0, messagesSent: 0 };
}

async function loadStats(campaignIds: string[]): Promise<Map<string, WhatsappCampaignStats>> {
  const stats = new Map<string, WhatsappCampaignStats>(campaignIds.map((id) => [id, emptyStats()]));
  if (!campaignIds.length) return stats;
  const [byStatus, sent] = await Promise.all([
    db
      .select({ campaignId: whatsappCampaignLeads.campaignId, status: whatsappCampaignLeads.status, n: count() })
      .from(whatsappCampaignLeads)
      .where(and(campaignLeadInOrg(), inArray(whatsappCampaignLeads.campaignId, campaignIds)))
      .groupBy(whatsappCampaignLeads.campaignId, whatsappCampaignLeads.status),
    db
      .select({ campaignId: whatsappCampaignLeads.campaignId, n: count() })
      .from(whatsappCampaignSends)
      .innerJoin(whatsappCampaignLeads, eq(whatsappCampaignSends.leadId, whatsappCampaignLeads.id))
      .where(and(campaignLeadInOrg(), inArray(whatsappCampaignLeads.campaignId, campaignIds), eq(whatsappCampaignSends.status, "sent")))
      .groupBy(whatsappCampaignLeads.campaignId),
  ]);
  for (const row of byStatus) {
    const entry = stats.get(row.campaignId);
    if (!entry || !(WHATSAPP_CAMPAIGN_LEAD_STATUSES as readonly string[]).includes(row.status)) continue;
    entry[row.status] = row.n;
    entry.total += row.n;
  }
  for (const row of sent) {
    const entry = stats.get(row.campaignId);
    if (entry) entry.messagesSent = row.n;
  }
  return stats;
}

async function loadSenders(campaignIds: string[]): Promise<Map<string, WhatsappCampaignSender[]>> {
  const senders = new Map<string, WhatsappCampaignSender[]>(campaignIds.map((id) => [id, []]));
  if (!campaignIds.length) return senders;
  const rows = await db
    .select({
      campaignId: whatsappCampaignAccounts.campaignId,
      accountId: whatsappAccounts.id,
      name: whatsappAccounts.name,
      phone: whatsappAccounts.phone,
      status: whatsappAccounts.status,
    })
    .from(whatsappCampaignAccounts)
    .innerJoin(whatsappAccounts, eq(whatsappCampaignAccounts.accountId, whatsappAccounts.id))
    .where(and(inOrg(whatsappAccounts), inArray(whatsappCampaignAccounts.campaignId, campaignIds)))
    .orderBy(asc(whatsappAccounts.createdAt), asc(whatsappAccounts.id));
  for (const row of rows) {
    senders.get(row.campaignId)?.push({ accountId: row.accountId, name: row.name, phone: row.phone, status: row.status });
  }
  return senders;
}

function toSummary(row: CampaignRow, senders: WhatsappCampaignSender[], stats: WhatsappCampaignStats): WhatsappCampaignSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    stepCount: row.steps.length,
    senders,
    stats,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function summariesFor(rows: CampaignRow[]): Promise<WhatsappCampaignSummary[]> {
  const ids = rows.map((row) => row.id);
  const [stats, senders] = await Promise.all([loadStats(ids), loadSenders(ids)]);
  return rows.map((row) => toSummary(row, senders.get(row.id) ?? [], stats.get(row.id) ?? emptyStats()));
}

async function detailFor(row: CampaignRow): Promise<WhatsappCampaignDetail> {
  const [[summary], sentRows] = await Promise.all([
    summariesFor([row]),
    db
      .select({ stepId: whatsappCampaignSends.stepId, n: count() })
      .from(whatsappCampaignSends)
      .innerJoin(whatsappCampaignLeads, eq(whatsappCampaignSends.leadId, whatsappCampaignLeads.id))
      .where(and(campaignLeadInOrg(), eq(whatsappCampaignLeads.campaignId, row.id), eq(whatsappCampaignSends.status, "sent")))
      .groupBy(whatsappCampaignSends.stepId),
  ]);
  const sentByStep: Record<string, number> = {};
  for (const step of row.steps) sentByStep[step.id] = 0;
  for (const sent of sentRows) if (sent.stepId) sentByStep[sent.stepId] = sent.n;
  return { ...summary!, steps: row.steps, sentByStep };
}

// --- campaign CRUD -------------------------------------------------------------------------

export async function listWhatsappCampaigns(): Promise<WhatsappCampaignSummary[]> {
  const rows = await db
    .select()
    .from(whatsappCampaigns)
    .where(and(inOrg(whatsappCampaigns), sql`${whatsappCampaigns.archivedAt} IS NULL`))
    .orderBy(desc(whatsappCampaigns.createdAt), desc(whatsappCampaigns.id));
  return summariesFor(rows);
}

/** Dedupes and checks that every number is one of this organization's; 400 otherwise. */
async function assertAccountsInOrg(accountIds: string[]): Promise<string[]> {
  const unique = [...new Set(accountIds)];
  if (!unique.length) return unique;
  if (unique.some((id) => !UUID_PATTERN.test(id))) throw new WhatsappApiError(400, "Unknown WhatsApp number");
  const found = await db
    .select({ id: whatsappAccounts.id })
    .from(whatsappAccounts)
    .where(and(inOrg(whatsappAccounts), inArray(whatsappAccounts.id, unique)));
  if (found.length !== unique.length) throw new WhatsappApiError(400, "Unknown WhatsApp number");
  return unique;
}

function assertSteps(steps: CreateWhatsappCampaignRequest["steps"]): void {
  const error = whatsappCampaignStepsError(steps ?? []);
  if (error) throw new WhatsappApiError(400, error);
}

export async function createWhatsappCampaign(input: CreateWhatsappCampaignRequest): Promise<WhatsappCampaignSummary> {
  const accountIds = await assertAccountsInOrg(input.accountIds ?? []);
  assertSteps(input.steps);
  const steps = normalizeWhatsappCampaignSteps(input.steps ?? []);
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(whatsappCampaigns)
      .values({
        organizationId: currentOrganizationId(),
        name: input.name,
        description: input.description ?? null,
        status: "paused",
        steps,
      })
      .returning();
    if (!row) throw new Error("whatsapp_campaigns insert returned no row");
    if (accountIds.length) {
      await tx.insert(whatsappCampaignAccounts).values(accountIds.map((accountId) => ({ campaignId: row.id, accountId })));
    }
    return row;
  });
  return (await summariesFor([created]))[0]!;
}

export async function getWhatsappCampaignDetail(campaignId: string): Promise<WhatsappCampaignDetail> {
  return detailFor(await loadCampaignRow(campaignId));
}

export async function updateWhatsappCampaign(campaignId: string, input: UpdateWhatsappCampaignRequest): Promise<WhatsappCampaignDetail> {
  const existing = await loadCampaignRow(campaignId);
  const accountIds = input.accountIds === undefined ? undefined : await assertAccountsInOrg(input.accountIds);
  if (input.steps !== undefined) assertSteps(input.steps);
  const steps = input.steps === undefined ? undefined : normalizeWhatsappCampaignSteps(input.steps);

  await db.transaction(async (tx) => {
    // Lock the row so a launch check and a concurrent edit cannot interleave.
    const [locked] = await tx
      .select({ id: whatsappCampaigns.id })
      .from(whatsappCampaigns)
      .where(and(inOrg(whatsappCampaigns), eq(whatsappCampaigns.id, campaignId), sql`${whatsappCampaigns.archivedAt} IS NULL`))
      .for("update");
    if (!locked) throw new WhatsappApiError(404, "Campaign not found");

    const set: Partial<typeof whatsappCampaigns.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) set.name = input.name;
    if (input.description !== undefined) set.description = input.description;
    if (steps !== undefined) set.steps = steps;
    if (input.status !== undefined) set.status = input.status;
    await tx.update(whatsappCampaigns).set(set).where(and(inOrg(whatsappCampaigns), eq(whatsappCampaigns.id, campaignId)));

    if (accountIds !== undefined) {
      await tx.delete(whatsappCampaignAccounts).where(eq(whatsappCampaignAccounts.campaignId, campaignId));
      if (accountIds.length) await tx.insert(whatsappCampaignAccounts).values(accountIds.map((accountId) => ({ campaignId, accountId })));
    }

    const resultingStatus: WhatsappCampaignStatus = input.status ?? existing.status;
    const touched = input.status !== undefined || accountIds !== undefined || steps !== undefined;
    if (resultingStatus === "active" && touched) {
      const finalSteps = steps ?? existing.steps;
      if (!finalSteps.some((step) => step.body.trim())) throw new WhatsappApiError(400, "Write a first message before launching");
      const [connected] = await tx
        .select({ n: count() })
        .from(whatsappCampaignAccounts)
        .innerJoin(whatsappAccounts, eq(whatsappCampaignAccounts.accountId, whatsappAccounts.id))
        .where(and(inOrg(whatsappAccounts), eq(whatsappCampaignAccounts.campaignId, campaignId), eq(whatsappAccounts.status, "connected")));
      if (!connected?.n) throw new WhatsappApiError(400, "Assign at least one connected WhatsApp number before launching");
      const [leadCount] = await tx.select({ n: count() }).from(whatsappCampaignLeads).where(eq(whatsappCampaignLeads.campaignId, campaignId));
      if (!leadCount?.n) throw new WhatsappApiError(400, "Add at least one lead before launching");
    }
  });
  return getWhatsappCampaignDetail(campaignId);
}

/** Archives: hidden from the list and never sent again. Leads and history stay. */
export async function archiveWhatsappCampaign(campaignId: string): Promise<void> {
  await loadCampaignRow(campaignId);
  const now = new Date();
  await db
    .update(whatsappCampaigns)
    .set({ archivedAt: now, status: "paused", updatedAt: now })
    .where(and(inOrg(whatsappCampaigns), eq(whatsappCampaigns.id, campaignId)));
}

// --- leads ----------------------------------------------------------------------------------

type LeadJoin = { lead: LeadRow; person: PersonRow; company: CompanyRow | null };

function personName(person: PersonRow): string | null {
  return person.fullName?.trim() || [person.firstName, person.lastName].filter(Boolean).join(" ").trim() || null;
}

async function hydrateLeads(rows: LeadJoin[]): Promise<WhatsappCampaignLead[]> {
  const phones = [...new Set(rows.map((row) => row.lead.phone))];
  const chatByPhone = new Map<string, { id: string; accountId: string }[]>();
  if (phones.length) {
    const chats = await db
      .select({ id: whatsappChats.id, accountId: whatsappChats.accountId, phone: whatsappChats.phone })
      .from(whatsappChats)
      .where(and(chatInOrg(), visibleChat, inArray(whatsappChats.phone, phones)))
      .orderBy(sql`${whatsappChats.lastMessageAt} DESC NULLS LAST`, desc(whatsappChats.createdAt));
    for (const chat of chats) {
      if (!chat.phone) continue;
      const list = chatByPhone.get(chat.phone) ?? [];
      list.push({ id: chat.id, accountId: chat.accountId });
      chatByPhone.set(chat.phone, list);
    }
  }
  return rows.map(({ lead, person, company }) => {
    const chats = chatByPhone.get(lead.phone) ?? [];
    const chat = chats.find((candidate) => candidate.accountId === lead.accountId) ?? chats[0];
    return {
      id: lead.id,
      personId: lead.personId,
      name: personName(person),
      phone: lead.phone,
      companyName: company?.name ?? null,
      title: person.title,
      status: lead.status,
      currentStep: lead.currentStep,
      nextSendAt: lead.nextSendAt?.toISOString() ?? null,
      lastSentAt: lead.lastSentAt?.toISOString() ?? null,
      repliedAt: lead.repliedAt?.toISOString() ?? null,
      lastError: lead.lastError,
      accountId: lead.accountId,
      chatId: chat?.id ?? null,
      createdAt: lead.createdAt.toISOString(),
    };
  });
}

function leadSelect() {
  return db
    .select({ lead: whatsappCampaignLeads, person: people, company: companies })
    .from(whatsappCampaignLeads)
    .innerJoin(people, and(eq(whatsappCampaignLeads.personId, people.id), inOrg(people)))
    .leftJoin(companies, and(eq(people.companyId, companies.id), inOrg(companies)));
}

async function loadLead(campaignId: string, leadId: string): Promise<WhatsappCampaignLead> {
  assertUuidShape(leadId, "Lead");
  const [row] = await leadSelect()
    .where(and(campaignLeadInOrg(), eq(whatsappCampaignLeads.campaignId, campaignId), eq(whatsappCampaignLeads.id, leadId)))
    .limit(1);
  if (!row) throw new WhatsappApiError(404, "Lead not found");
  return (await hydrateLeads([row]))[0]!;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export async function listWhatsappCampaignLeads(
  campaignId: string,
  query: ListWhatsappCampaignLeadsQuery,
): Promise<ListWhatsappCampaignLeadsResponse> {
  await loadCampaignRow(campaignId);
  const pageSize = Math.min(Math.max(Math.trunc(query.pageSize ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const page = Math.max(Math.trunc(query.page ?? 1) || 1, 1);
  const filters: (SQL | undefined)[] = [campaignLeadInOrg(), eq(whatsappCampaignLeads.campaignId, campaignId)];
  if (query.status) filters.push(eq(whatsappCampaignLeads.status, query.status));
  const q = query.q?.trim();
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    filters.push(
      or(
        ilike(people.fullName, pattern),
        ilike(people.firstName, pattern),
        ilike(people.lastName, pattern),
        ilike(sql`concat_ws(' ', ${people.firstName}, ${people.lastName})`, pattern),
        ilike(whatsappCampaignLeads.phone, pattern),
        ilike(companies.name, pattern),
      ),
    );
  }
  const where = and(...filters);
  const [rows, [totalRow]] = await Promise.all([
    leadSelect()
      .where(where)
      .orderBy(desc(whatsappCampaignLeads.createdAt), desc(whatsappCampaignLeads.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ n: count() })
      .from(whatsappCampaignLeads)
      .innerJoin(people, and(eq(whatsappCampaignLeads.personId, people.id), inOrg(people)))
      .leftJoin(companies, and(eq(people.companyId, companies.id), inOrg(companies)))
      .where(where),
  ]);
  return { leads: await hydrateLeads(rows), total: totalRow?.n ?? 0, page, pageSize };
}

export async function addPeopleToWhatsappCampaign(campaignId: string, personIds: string[]): Promise<AddWhatsappCampaignPeopleResponse> {
  await loadCampaignRow(campaignId);
  const unique = [...new Set(personIds)];
  if (unique.length > MAX_ADD_PEOPLE) throw new WhatsappApiError(400, `Add at most ${MAX_ADD_PEOPLE} people at a time`);
  if (unique.some((id) => !UUID_PATTERN.test(id))) throw new WhatsappApiError(404, "Person not found");
  const result: AddWhatsappCampaignPeopleResponse = { added: 0, skippedDuplicate: 0, skippedMissingPhone: 0 };
  if (!unique.length) return result;

  const country = await organizationPhoneCountry();
  const found = await db.select({ id: people.id, phone: people.phone }).from(people).where(and(inOrg(people), inArray(people.id, unique)));
  if (found.length !== unique.length) throw new WhatsappApiError(404, "Person not found");

  const existing = new Set(
    (
      await db
        .select({ personId: whatsappCampaignLeads.personId })
        .from(whatsappCampaignLeads)
        .where(and(campaignLeadInOrg(), eq(whatsappCampaignLeads.campaignId, campaignId), inArray(whatsappCampaignLeads.personId, unique)))
    ).map((row) => row.personId),
  );
  const now = new Date();
  const values: (typeof whatsappCampaignLeads.$inferInsert)[] = [];
  for (const person of found) {
    const phone = person.phone ? normalizeCampaignPhone(person.phone, country) : null;
    if (!phone) result.skippedMissingPhone += 1;
    else if (existing.has(person.id)) result.skippedDuplicate += 1;
    else values.push({ campaignId, personId: person.id, phone, status: "queued", nextSendAt: now });
  }
  if (values.length) {
    const inserted = await db
      .insert(whatsappCampaignLeads)
      .values(values)
      .onConflictDoNothing({ target: [whatsappCampaignLeads.campaignId, whatsappCampaignLeads.personId] })
      .returning({ id: whatsappCampaignLeads.id });
    result.added = inserted.length;
    result.skippedDuplicate += values.length - inserted.length;
  }
  return result;
}

export async function updateWhatsappCampaignLead(
  campaignId: string,
  leadId: string,
  input: UpdateWhatsappCampaignLeadRequest,
): Promise<WhatsappCampaignLead> {
  await loadCampaignRow(campaignId);
  assertUuidShape(leadId, "Lead");
  await db.transaction(async (tx) => {
    const [lead] = await tx
      .select()
      .from(whatsappCampaignLeads)
      .where(and(campaignLeadInOrg(), eq(whatsappCampaignLeads.campaignId, campaignId), eq(whatsappCampaignLeads.id, leadId)))
      .for("update");
    if (!lead) throw new WhatsappApiError(404, "Lead not found");
    const now = new Date();

    if (input.action === "stop") {
      if (lead.status !== "queued" && lead.status !== "in_sequence") {
        throw new WhatsappApiError(409, "Only leads still in the sequence can be stopped");
      }
      await tx
        .update(whatsappCampaignLeads)
        .set({ status: "stopped", nextSendAt: null, updatedAt: now })
        .where(eq(whatsappCampaignLeads.id, leadId));
      return;
    }

    if (lead.status !== "stopped" && lead.status !== "failed") {
      throw new WhatsappApiError(409, "Only stopped or failed leads can be resumed");
    }
    const [claim] = await tx
      .select({ id: whatsappCampaignSends.id, status: whatsappCampaignSends.status, createdAt: whatsappCampaignSends.createdAt })
      .from(whatsappCampaignSends)
      .where(and(eq(whatsappCampaignSends.leadId, leadId), eq(whatsappCampaignSends.step, lead.currentStep)));
    if (claim?.status === "sending" && now.getTime() - claim.createdAt.getTime() < IN_FLIGHT_CLAIM_MS) {
      throw new WhatsappApiError(409, "This lead's last message may still be sending. Try again in a few minutes.");
    }
    // A failed claim is the step's own attempt, and a stale `sending` one a
    // send whose outcome is unknown: drop either so the step can run again.
    // `attempts: 1` makes the sender look for that message in the chat
    // before sending, so an uncertain one that did arrive is not repeated.
    if (claim && claim.status !== "sent") await tx.delete(whatsappCampaignSends).where(eq(whatsappCampaignSends.id, claim.id));
    await tx
      .update(whatsappCampaignLeads)
      .set({
        status: lead.currentStep === 0 ? "queued" : "in_sequence",
        nextSendAt: now,
        attempts: claim?.status === "sending" ? 1 : 0,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(whatsappCampaignLeads.id, leadId));
  });
  return loadLead(campaignId, leadId);
}

export async function removeWhatsappCampaignLead(campaignId: string, leadId: string): Promise<void> {
  await loadCampaignRow(campaignId);
  assertUuidShape(leadId, "Lead");
  const deleted = await db
    .delete(whatsappCampaignLeads)
    .where(and(campaignLeadInOrg(), eq(whatsappCampaignLeads.campaignId, campaignId), eq(whatsappCampaignLeads.id, leadId)))
    .returning({ id: whatsappCampaignLeads.id });
  if (!deleted.length) throw new WhatsappApiError(404, "Lead not found");
}

// --- spreadsheet import --------------------------------------------------------------------------

function readSheet(buffer: ArrayBuffer) {
  try {
    return parseImportSheet(buffer);
  } catch (error) {
    throw new WhatsappApiError(400, error instanceof Error ? error.message : "Unable to parse file");
  }
}

export async function previewWhatsappCampaignUpload(campaignId: string, buffer: ArrayBuffer): Promise<WhatsappCampaignUploadPreview> {
  await loadCampaignRow(campaignId);
  const sheet = readSheet(buffer);
  return {
    headers: sheet.headers,
    rows: sheet.rows.slice(0, 5),
    totalRows: sheet.rows.length,
    suggestedMapping: suggestWhatsappMapping(sheet.headers),
  };
}

export async function importWhatsappCampaignLeads(
  campaignId: string,
  buffer: ArrayBuffer,
  rawMapping: unknown,
): Promise<WhatsappCampaignImportResponse> {
  await loadCampaignRow(campaignId);
  const sheet = readSheet(buffer);
  const mappingError = importMappingError(rawMapping, sheet.headers);
  if (mappingError) throw new WhatsappApiError(400, mappingError);
  const mapping: ImportMapping = {};
  for (const field of WHATSAPP_CAMPAIGN_IMPORT_FIELDS) {
    const header = (rawMapping as Record<string, unknown>)[field.key];
    if (typeof header === "string" && header) mapping[field.key] = header;
  }
  if (sheet.rows.length > WHATSAPP_CAMPAIGN_MAX_IMPORT_ROWS) {
    throw new WhatsappApiError(400, `Too many rows (max ${WHATSAPP_CAMPAIGN_MAX_IMPORT_ROWS})`);
  }

  const country = await organizationPhoneCountry();
  const normalize = (input: string) => normalizeCampaignPhone(input, country);
  let added = 0;
  let alreadyInCampaign = 0;
  const skipped: string[] = [];
  const skip = (message: string) => {
    if (skipped.length < MAX_SKIPPED_REPORTED) skipped.push(message);
  };

  for (let index = 0; index < sheet.rows.length; index += 1) {
    const rowNumber = sheet.rowNumbers[index]!;
    const { person, customFields } = mapImportRow(sheet.rows[index]!, sheet.headers, mapping);
    const resolved = resolveImportRow(person, rowNumber, normalize, (input) => campaignPhoneProblem(input, country));
    if (!resolved.ok) {
      skip(resolved.message);
      continue;
    }
    try {
      const inserted = await withLeadTransaction(async (tx) => {
        const found = await findOrCreateContactPerson(
          tx,
          {
            fullName: resolved.fullName,
            phone: resolved.phone,
            companyName: resolved.companyName,
            companyDomain: resolved.companyDomain,
            title: resolved.title,
            email: resolved.email,
            linkedinUrl: resolved.linkedinUrl,
          },
          LEAD_SOURCE,
        );
        const [row] = await tx
          .insert(whatsappCampaignLeads)
          .values({ campaignId, personId: found.id, phone: resolved.phone, customFields, status: "queued", nextSendAt: new Date() })
          .onConflictDoNothing({ target: [whatsappCampaignLeads.campaignId, whatsappCampaignLeads.personId] })
          .returning({ id: whatsappCampaignLeads.id });
        return Boolean(row);
      });
      if (inserted) added += 1;
      else alreadyInCampaign += 1;
    } catch (error) {
      skip(`row ${rowNumber}: ${error instanceof Error ? error.message : "could not be added"}`);
    }
  }
  return { added, alreadyInCampaign, skipped };
}

// --- merge fields and preview --------------------------------------------------------------------

const DEFAULT_MERGE_FIELDS = [
  { token: "firstName", label: "First name" },
  { token: "lastName", label: "Last name" },
  { token: "fullName", label: "Full name" },
  { token: "title", label: "Job title" },
  { token: "company", label: "Company" },
];

export async function whatsappCampaignMergeFields(campaignId: string): Promise<WhatsappCampaignMergeFieldsResponse> {
  await loadCampaignRow(campaignId);
  const rows = await leadSelect()
    .where(and(campaignLeadInOrg(), eq(whatsappCampaignLeads.campaignId, campaignId)))
    .orderBy(asc(whatsappCampaignLeads.createdAt), asc(whatsappCampaignLeads.id))
    .limit(MAX_MERGE_FIELD_LEADS);
  const defaults = new Set(DEFAULT_MERGE_FIELDS.map((field) => field.token.toLowerCase()));
  const extra = new Map<string, string>();
  for (const { lead, person, company } of rows) {
    for (const key of Object.keys(campaignLeadVariables(person, company, lead.customFields ?? {}))) {
      const lower = key.toLowerCase();
      if (!defaults.has(lower) && !extra.has(lower)) extra.set(lower, key);
    }
  }
  const fields = [
    ...DEFAULT_MERGE_FIELDS,
    ...[...extra.values()].sort((a, b) => a.localeCompare(b)).map((key) => ({ token: key, label: key })),
  ];
  return {
    fields,
    leads: rows.slice(0, MERGE_FIELD_PICKER_LEADS).map(({ lead, person }) => ({ id: lead.id, name: personName(person), phone: lead.phone })),
  };
}

export async function previewWhatsappCampaignStep(
  campaignId: string,
  input: PreviewWhatsappCampaignStepRequest,
): Promise<PreviewWhatsappCampaignStepResponse> {
  await loadCampaignRow(campaignId);
  const conditions: (SQL | undefined)[] = [campaignLeadInOrg(), eq(whatsappCampaignLeads.campaignId, campaignId)];
  if (input.leadId) {
    assertUuidShape(input.leadId, "Lead");
    conditions.push(eq(whatsappCampaignLeads.id, input.leadId));
  }
  const [row] = await leadSelect()
    .where(and(...conditions))
    .orderBy(asc(whatsappCampaignLeads.createdAt), asc(whatsappCampaignLeads.id))
    .limit(1);
  if (!row) throw new WhatsappApiError(404, input.leadId ? "Lead not found" : "Add a lead to preview");
  const variables = campaignLeadVariables(row.person, row.company, row.lead.customFields ?? {});
  return {
    rendered: renderCampaignStep(input.body, variables),
    unresolved: unresolvedMergeFields(input.body, variables),
    lead: { id: row.lead.id, name: personName(row.person), phone: row.lead.phone },
  };
}
