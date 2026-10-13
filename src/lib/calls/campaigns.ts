import "server-only";

import { and, asc, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import {
  createProvisionalPerson,
  resolvePersonNames,
  upsertCompany,
  upsertPerson,
  withLeadTransaction,
  type LeadExecutor,
} from "@/lib/leads/records";
import { personCompanyName } from "@/lib/leads/companyName";
import {
  inferCompanyDomainFromEmail,
  normalizeCompanyDomain,
  normalizeEmail,
  normalizeLinkedinSlug,
} from "@/lib/leads/identity";
import { parseImportRows, type ImportRow } from "@/lib/leads/importRows";
import type { ManualPersonInput } from "@/lib/leads/manualImport";
import {
  type AddCampaignContactRequest,
  type CallMessageSummary,
  type CampaignStats,
  MAX_PHOTO_BYTES,
  type CampaignContact,
  type CampaignContactCrm,
  type CampaignContactDetailResponse,
  type CampaignContactStage,
  type CampaignDetailResponse,
  type CampaignSummary,
  type CreateCampaignRequest,
  type ImportCampaignContactsResponse,
  type ListCampaignsResponse,
  type LogCallMessageRequest,
  type LogCallMessageResponse,
  type UpdateCampaignContactPersonRequest,
  type UpdateCampaignContactRequest,
  type UpdateCampaignRequest,
} from "./contract";
import { callCampaignContacts, callCampaigns, callMessages, callSessions } from "./schema";
import { normalizePhone } from "./phone";
import { organizationPhoneCountry } from "@/lib/calls/phone.server";
import { photoExtensionFor, photoKey, putPhoto } from "./storage";
import { CallApiError, expireStaleCalls, toCallDetail, toCallSummary } from "./sessions";
import { nextContactCallState, stateOf } from "./contactCallStatus";
import { crmStageForPeople } from "./leadStage";
import { syncCallFollowUpSafely } from "./crmFollowUp";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { BRAND } from "@/lib/brand";

/**
 * call_campaign_contacts has no organization column: it belongs to its
 * campaign's organization. This is the filter that says so.
 */
export function contactInOrg() {
  return inArray(callCampaignContacts.campaignId, db.select({ id: callCampaigns.id }).from(callCampaigns).where(inOrg(callCampaigns)));
}

// Every route under src/app/api/calling reaches for this the same way the
// existing /api/calls routes reach for sessions.ts's copy — re-exported here
// so those routes only need one import from this module.
export { callApiErrorResponse } from "./sessions";

const MAX_IMPORT_ROWS = 5000;
const PHONE_HINT = "Enter the number with its country code, e.g. +91…";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A malformed id reads as 404, matching sessions.ts's own convention for
 * this domain (getCall, getCallForDownload) rather than the wider CRM
 * routes' 400 — and it's what keeps a bad id from reaching a `uuid` column
 * and throwing a raw Postgres syntax error instead of a clean response.
 */
function assertUuidShape(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) throw new CallApiError(404, `${label} not found`);
}

type CallCampaignRow = typeof callCampaigns.$inferSelect;
type CallCampaignContactRow = typeof callCampaignContacts.$inferSelect;
type PersonRow = typeof people.$inferSelect;
type CompanyRow = typeof companies.$inferSelect;
type CallMessageRow = typeof callMessages.$inferSelect;
type CallSessionRow = typeof callSessions.$inferSelect;

const EMPTY_COUNTS: Record<CampaignContactStage, number> = { to_call: 0, follow_up: 0, done: 0 };
const EMPTY_STATS: CampaignStats = { leads: 0, called: 0, connected: 0, interested: 0 };

// --- mapping ------------------------------------------------------------

function toCampaignSummary(
  row: CallCampaignRow,
  counts: Record<CampaignContactStage, number>,
  stats: CampaignStats,
): CampaignSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    counts,
    stats,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * CampaignStats per campaign, in one grouped query: leads called, leads who
 * picked up at least once (a recorded call), and leads whose CRM stage is
 * Interested or Customer in any pipeline.
 */
async function campaignStats(campaignIds?: string[]): Promise<Map<string, CampaignStats>> {
  if (campaignIds && !campaignIds.length) return new Map();
  const contact = callCampaignContacts;
  const rows = await db
    .select({
      campaignId: contact.campaignId,
      leads: count(),
      called: sql<number>`count(*) filter (where ${contact.callCount} > 0)`.mapWith(Number),
      // Spelled out with table names: drizzle renders a column interpolated
      // here unqualified, and inside the subquery "id" would bind to the
      // subquery's own table.
      connected: sql<number>`count(*) filter (where exists (
        select 1 from call_sessions s
        where s.campaign_contact_id = call_campaign_contacts.id and s.status = 'recorded'
          and s.organization_id = ${currentOrganizationId()}
      ))`.mapWith(Number),
      interested: sql<number>`count(*) filter (where exists (
        select 1 from crm_records r
        where r.person_id = call_campaign_contacts.person_id and r.category_key in ('interested', 'customer')
          and r.organization_id = ${currentOrganizationId()}
      ))`.mapWith(Number),
    })
    .from(contact)
    .where(and(contactInOrg(), campaignIds ? inArray(contact.campaignId, campaignIds) : undefined))
    .groupBy(contact.campaignId);
  return new Map(
    rows.map((row) => [
      row.campaignId,
      { leads: Number(row.leads), called: row.called, connected: row.connected, interested: row.interested },
    ]),
  );
}

function toCampaignContact(
  contact: CallCampaignContactRow,
  person: PersonRow,
  company: CompanyRow | null,
  lastCall: CallSessionRow | null,
  crm: CampaignContactCrm | null,
): CampaignContact {
  return {
    id: contact.id,
    campaignId: contact.campaignId,
    stage: contact.stage,
    callStatus: contact.callStatus,
    statusUpdatedAt: contact.statusUpdatedAt ? contact.statusUpdatedAt.toISOString() : null,
    unansweredAttempts: contact.unansweredAttempts,
    crm,
    followUpAt: contact.followUpAt ? contact.followUpAt.toISOString() : null,
    notes: contact.notes,
    callCount: contact.callCount,
    lastCalledAt: contact.lastCalledAt ? contact.lastCalledAt.toISOString() : null,
    person: {
      id: person.id,
      fullName: person.fullName,
      firstName: person.firstName,
      title: person.title,
      companyName: personCompanyName(person.raw, company?.name),
      companyWebsite: company?.domain ?? null,
      linkedinUrl: linkedinProfileUrl(person.linkedinUrl),
      profilePictureUrl: person.profilePictureUrl,
      email: person.email,
      phone: person.phone,
    },
    lastCall: lastCall ? toCallSummary(lastCall) : null,
  };
}

function toCallMessageSummary(row: CallMessageRow): CallMessageSummary {
  return {
    id: row.id,
    callSessionId: row.callSessionId,
    phone: row.phone,
    body: row.body,
    openedAt: row.openedAt.toISOString(),
  };
}

// --- pure logic (unit-tested) ------------------------------------------

/** people.linkedin_url holds the vanity slug ("priya-nair"); a link needs the URL. */
export function linkedinProfileUrl(slug: string | null): string | null {
  if (!slug) return null;
  return /^https?:\/\//i.test(slug) ? slug : `https://www.linkedin.com/in/${encodeURIComponent(slug)}`;
}

/** Logging a follow-up message reopens a contact that's already Done; anything else stays put in Follow-up. */
export function nextStageAfterMessage(currentStage: CampaignContactStage): CampaignContactStage {
  return currentStage === "done" ? currentStage : "follow_up";
}

export type ResolvedImportRow =
  | {
      ok: true;
      phone: string;
      fullName: string | null;
      companyName: string | null;
      companyDomain: string | null;
      title: string | null;
      email: string | null;
      linkedinUrl: string | null;
    }
  | { ok: false; message: string };

/**
 * The per-row decision for the Calling contacts import, isolated from the
 * DB and the file parsing so it's unit-testable: only a phone number is
 * mandatory (contract.ts's ImportCampaignContactsResponse — "row N: no
 * valid phone number" is the one skip reason it documents). `rowNumber` is
 * 1-based against the original file, including the header row, matching
 * what a spreadsheet's row numbers would show.
 */
export function resolveImportRow(
  row: ManualPersonInput,
  rowNumber: number,
  normalize: (input: string) => string | null = normalizePhone,
  /** Why a phone was refused (e.g. checkPhone's reason); the generic message otherwise. */
  explain?: (input: string | null | undefined) => string,
): ResolvedImportRow {
  const phone = row.phone ? normalize(row.phone) : null;
  if (!phone) {
    const reason = explain?.(row.phone);
    return { ok: false, message: `row ${rowNumber}: ${reason || "no valid phone number"}` };
  }
  const fullName = row.fullName ?? ([row.firstName, row.lastName].filter(Boolean).join(" ") || null);
  return {
    ok: true,
    phone,
    fullName,
    companyName: row.companyName ?? null,
    // Lenient too: a website that isn't a domain just isn't linked.
    companyDomain: websiteDomain(row.companyDomain),
    title: row.title ?? null,
    // Lenient on purpose: unlike the People import (where email is an
    // identity field), a malformed email here shouldn't sink an otherwise
    // valid phone-only row — it's just dropped, the same way manualImport.ts
    // drops an unparsable phone number.
    email: normalizeEmail(row.email),
    // Lenient the same way: a LinkedIn column that isn't a profile is dropped.
    linkedinUrl: normalizeLinkedinSlug(row.linkedinUrl),
  };
}

/**
 * A company website as the domain companies are keyed by ("https://www.Acme.com/x"
 * → "acme.com"), or null when it isn't one. normalizeCompanyDomain is lenient
 * enough to turn free text into something domain-shaped; a real domain has a
 * dot.
 */
export function websiteDomain(value: string | null | undefined): string | null {
  const domain = normalizeCompanyDomain(value);
  return domain && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : null;
}

export type ResolvedContactPersonUpdate =
  | {
      ok: true;
      fullName?: string;
      phone?: string;
      email?: string | null;
      companyName?: string | null;
      /** Normalized domain; null clears the website. */
      companyDomain?: string | null;
      title?: string | null;
      profilePictureUrl?: string | null;
    }
  | { ok: false; message: string };

/**
 * Validates and normalizes a PATCH .../person body, isolated from the DB the
 * same way resolveImportRow is: only the keys the caller actually gave move
 * (`undefined` in ⇒ absent from the result), fullName rejects blank-after-
 * trim, phone goes through the same normalizer (and hint) sessions.ts uses,
 * and email is normalized or rejected — never silently dropped, unlike the
 * import row above, since here it's an explicit edit the rep is making.
 */
export function resolveContactPersonUpdate(
  input: UpdateCampaignContactPersonRequest,
  normalize: (value: string) => string | null = normalizePhone,
): ResolvedContactPersonUpdate {
  let fullName: string | undefined;
  if (input.fullName !== undefined) {
    const trimmed = input.fullName.trim();
    if (!trimmed) return { ok: false, message: "Enter a name" };
    fullName = trimmed;
  }

  let phone: string | undefined;
  if (input.phone !== undefined) {
    const normalized = normalize(input.phone);
    if (!normalized) return { ok: false, message: PHONE_HINT };
    phone = normalized;
  }

  let email: string | null | undefined;
  if (input.email !== undefined) {
    if (input.email === null) {
      email = null;
    } else {
      const normalized = normalizeEmail(input.email);
      if (!normalized) return { ok: false, message: "Enter a valid email address" };
      email = normalized;
    }
  }

  let companyDomain: string | null | undefined;
  if (input.companyWebsite !== undefined) {
    if (input.companyWebsite === null || !input.companyWebsite.trim()) {
      companyDomain = null;
    } else {
      companyDomain = websiteDomain(input.companyWebsite);
      if (!companyDomain) return { ok: false, message: "Enter the company's website, like acme.com" };
    }
  }

  let profilePictureUrl: string | null | undefined;
  if (input.profilePictureUrl !== undefined) {
    if (input.profilePictureUrl === null || !input.profilePictureUrl.trim()) {
      profilePictureUrl = null;
    } else {
      profilePictureUrl = photoLink(input.profilePictureUrl);
      if (!profilePictureUrl) return { ok: false, message: "Enter a link to an image, starting with https://" };
    }
  }

  return {
    ok: true,
    fullName,
    phone,
    email,
    companyName: input.companyName,
    companyDomain,
    title: input.title,
    profilePictureUrl,
  };
}

/**
 * A photo link as the rep may set it: an https URL, or the path of a photo
 * already uploaded here (what uploadContactPhoto stores), so saving the edit
 * form unchanged keeps it. Null for anything else.
 */
export function photoLink(value: string): string | null {
  const trimmed = value.trim();
  if (/^\/api\/calling\/photos\/[0-9a-f-]{36}\/[^/?#]+$/i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" && trimmed.length <= 2000 ? url.toString() : null;
  } catch {
    return null;
  }
}

// --- person linking -------------------------------------------------------

export type ContactPersonInput = {
  fullName: string | null;
  phone: string;
  companyName: string | null;
  /** Normalized; what links a real company record (companies are keyed by domain). */
  companyDomain: string | null;
  title: string | null;
  email: string | null;
  /** Normalized slug; with an email, what identifies a person across AgentSDR. */
  linkedinUrl?: string | null;
};

/**
 * Finds or creates the Person behind a campaign contact, reusing the same
 * upsert the People import and manual entry use (src/lib/leads/records.ts,
 * src/lib/leads/manualImport.ts) rather than a parallel implementation.
 *
 * Matching is by email, else LinkedIn profile, exactly like upsertPerson
 * elsewhere in the app: given either, an existing Person with it keeps their
 * identity and this call's phone/company/title are merged in (upsertPerson's
 * normal "given value wins" rule — same as every other importer). That is
 * what links a lead already worked on LinkedIn or email to the same Person.
 *
 * With neither, the phone is the only identity a cold-calling list has, so
 * an existing Person with the same E.164 number is reused — otherwise
 * uploading the same sheet twice would create everyone twice, and the
 * campaign's (campaign, person) uniqueness could not catch it. people.phone
 * is deliberately not unique (a switchboard is shared), so this takes the
 * oldest match under an advisory lock rather than relying on a constraint.
 * Only when nothing matches is a new provisional Person created.
 */
export async function findOrCreateContactPerson(
  tx: LeadExecutor,
  input: ContactPersonInput,
  source = "call-campaign-contact",
): Promise<PersonRow> {
  const company =
    input.companyName || input.companyDomain ? { name: input.companyName, domain: input.companyDomain } : null;
  if (!input.email && !input.linkedinUrl) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`person:phone:${input.phone}`}, 0))`);
    const [existing] = await tx
      .select()
      .from(people)
      .where(and(inOrg(people), eq(people.phone, input.phone)))
      .orderBy(asc(people.createdAt))
      .limit(1);
    if (existing) {
      // A known person with no company yet gets the one given now, when it
      // can be linked; an existing link is left alone.
      if (!existing.companyId && input.companyDomain) {
        const linked = await upsertCompany(tx, {
          name: input.companyName,
          domain: input.companyDomain,
          source,
        });
        if (linked) {
          const [updated] = await tx
            .update(people)
            .set({ companyId: linked.id, updatedAt: new Date() })
            .where(and(inOrg(people), eq(people.id, existing.id)))
            .returning();
          return updated ?? existing;
        }
      }
      return existing;
    }
  }
  if (input.email || input.linkedinUrl) {
    return upsertPerson(tx, {
      email: input.email,
      linkedinUrl: input.linkedinUrl,
      fullName: input.fullName,
      title: input.title,
      phone: input.phone,
      company,
      source,
    });
  }
  return createProvisionalPerson(tx, {
    fullName: input.fullName,
    title: input.title,
    phone: input.phone,
    company,
    source,
  });
}

export async function loadCampaignContact(contactId: string): Promise<CampaignContact> {
  const [row] = await db
    .select({ contact: callCampaignContacts, person: people, company: companies })
    .from(callCampaignContacts)
    .innerJoin(people, eq(callCampaignContacts.personId, people.id))
    .leftJoin(companies, eq(people.companyId, companies.id))
    .where(and(inOrg(people), contactInOrg(), eq(callCampaignContacts.id, contactId)))
    .limit(1);
  if (!row) throw new CallApiError(404, "Contact not found");
  const [[lastCall], crm] = await Promise.all([
    db
      .select()
      .from(callSessions)
      .where(and(inOrg(callSessions), eq(callSessions.campaignContactId, contactId)))
      .orderBy(desc(callSessions.createdAt))
      .limit(1),
    crmStageForPeople([row.person.id]),
  ]);
  return toCampaignContact(row.contact, row.person, row.company, lastCall ?? null, crm.get(row.person.id) ?? null);
}

async function insertCampaignContact(
  campaignId: string,
  input: ContactPersonInput,
): Promise<{ contact: CampaignContact; alreadyInCampaign: boolean }> {
  const { personId, contactId } = await withLeadTransaction(async (tx) => {
    const person = await findOrCreateContactPerson(tx, input);
    const [row] = await tx
      .insert(callCampaignContacts)
      .values({ campaignId, personId: person.id })
      .onConflictDoNothing({ target: [callCampaignContacts.campaignId, callCampaignContacts.personId] })
      .returning();
    return { personId: person.id, contactId: row?.id ?? null };
  });

  if (!contactId) {
    const [existing] = await db
      .select({ id: callCampaignContacts.id })
      .from(callCampaignContacts)
      .where(and(contactInOrg(), eq(callCampaignContacts.campaignId, campaignId), eq(callCampaignContacts.personId, personId)))
      .limit(1);
    if (!existing) throw new Error("call_campaign_contacts row missing after a conflicting insert");
    return { contact: await loadCampaignContact(existing.id), alreadyInCampaign: true };
  }
  return { contact: await loadCampaignContact(contactId), alreadyInCampaign: false };
}

async function assertCampaignExists(campaignId: string): Promise<void> {
  assertUuidShape(campaignId, "Campaign");
  const [row] = await db.select({ id: callCampaigns.id }).from(callCampaigns).where(and(inOrg(callCampaigns), eq(callCampaigns.id, campaignId))).limit(1);
  if (!row) throw new CallApiError(404, "Campaign not found");
}

async function campaignContactCounts(campaignId: string): Promise<Record<CampaignContactStage, number>> {
  const rows = await db
    .select({ stage: callCampaignContacts.stage, total: count() })
    .from(callCampaignContacts)
    .where(and(contactInOrg(), eq(callCampaignContacts.campaignId, campaignId)))
    .groupBy(callCampaignContacts.stage);
  const counts = { ...EMPTY_COUNTS };
  for (const row of rows) counts[row.stage] = Number(row.total);
  return counts;
}

// --- campaigns ------------------------------------------------------------

export async function listCampaigns(): Promise<ListCampaignsResponse["campaigns"]> {
  const [campaignRows, counts, stats] = await Promise.all([
    db.select().from(callCampaigns).where(and(inOrg(callCampaigns), sql`${callCampaigns.archivedAt} is null`)).orderBy(desc(callCampaigns.createdAt)),
    db
      .select({ campaignId: callCampaignContacts.campaignId, stage: callCampaignContacts.stage, total: count() })
      .from(callCampaignContacts)
      .where(contactInOrg())
      .groupBy(callCampaignContacts.campaignId, callCampaignContacts.stage),
    campaignStats(),
  ]);
  const countsByCampaign = new Map<string, Record<CampaignContactStage, number>>();
  for (const row of counts) {
    const bucket = countsByCampaign.get(row.campaignId) ?? { ...EMPTY_COUNTS };
    bucket[row.stage] = Number(row.total);
    countsByCampaign.set(row.campaignId, bucket);
  }
  return campaignRows.map((row) =>
    toCampaignSummary(row, countsByCampaign.get(row.id) ?? { ...EMPTY_COUNTS }, stats.get(row.id) ?? { ...EMPTY_STATS }),
  );
}

export async function createCampaign(input: CreateCampaignRequest): Promise<CampaignSummary> {
  const [row] = await db
    .insert(callCampaigns)
    .values({ organizationId: currentOrganizationId(), name: input.name, description: input.description ?? null })
    .returning();
  if (!row) throw new Error("call_campaigns insert did not return a row");
  return toCampaignSummary(row, { ...EMPTY_COUNTS }, { ...EMPTY_STATS });
}

export async function updateCampaign(campaignId: string, input: UpdateCampaignRequest): Promise<CampaignSummary> {
  assertUuidShape(campaignId, "Campaign");
  const [row] = await db
    .select()
    .from(callCampaigns)
    .where(and(inOrg(callCampaigns), eq(callCampaigns.id, campaignId), sql`${callCampaigns.archivedAt} is null`))
    .limit(1);
  if (!row) throw new CallApiError(404, "Campaign not found");

  const updates: Partial<typeof callCampaigns.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.status !== undefined) updates.status = input.status;

  const [updated] = await db.update(callCampaigns).set(updates).where(and(inOrg(callCampaigns), eq(callCampaigns.id, campaignId))).returning();
  if (!updated) throw new Error("call_campaigns update did not return a row");
  const [counts, stats] = await Promise.all([campaignContactCounts(campaignId), campaignStats([campaignId])]);
  return toCampaignSummary(updated, counts, stats.get(campaignId) ?? { ...EMPTY_STATS });
}

/**
 * Soft-deletes a campaign by stamping archived_at. Idempotent: archiving an
 * already-archived campaign is a no-op rather than a 404 — only a campaign
 * id that never existed 404s.
 */
export async function archiveCampaign(campaignId: string): Promise<void> {
  assertUuidShape(campaignId, "Campaign");
  const [row] = await db.select({ id: callCampaigns.id }).from(callCampaigns).where(and(inOrg(callCampaigns), eq(callCampaigns.id, campaignId))).limit(1);
  if (!row) throw new CallApiError(404, "Campaign not found");
  const archived = await db
    .update(callCampaigns)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(inOrg(callCampaigns), eq(callCampaigns.id, campaignId), sql`${callCampaigns.archivedAt} is null`))
    .returning({ id: callCampaigns.id });
  if (!archived.length) return;
  // Its follow-ups are no longer due anywhere; Action required should agree.
  const members = await db
    .select({ personId: callCampaignContacts.personId })
    .from(callCampaignContacts)
    .where(and(contactInOrg(), eq(callCampaignContacts.campaignId, campaignId)));
  for (const { personId } of members) await syncCallFollowUpSafely(personId);
}

export async function getCampaignDetail(campaignId: string): Promise<CampaignDetailResponse> {
  await expireStaleCalls();
  assertUuidShape(campaignId, "Campaign");
  const [campaignRow] = await db.select().from(callCampaigns).where(and(inOrg(callCampaigns), eq(callCampaigns.id, campaignId))).limit(1);
  if (!campaignRow || campaignRow.archivedAt) throw new CallApiError(404, "Campaign not found");

  const rows = await db
    .select({ contact: callCampaignContacts, person: people, company: companies })
    .from(callCampaignContacts)
    .innerJoin(people, eq(callCampaignContacts.personId, people.id))
    .leftJoin(companies, eq(people.companyId, companies.id))
    .where(and(inOrg(people), contactInOrg(), eq(callCampaignContacts.campaignId, campaignId)))
    .orderBy(sql`${callCampaignContacts.followUpAt} nulls last`, asc(callCampaignContacts.createdAt));

  // Each contact's latest call, in one query rather than one per contact:
  // DISTINCT ON folds call_sessions down to a single (most recent) row per
  // campaign_contact_id, scoped to just the contacts on this page.
  const contactIds = rows.map((row) => row.contact.id);
  const [latestCalls, crmByPerson, stats] = await Promise.all([
    contactIds.length
      ? db
          .selectDistinctOn([callSessions.campaignContactId])
          .from(callSessions)
          .where(and(inOrg(callSessions), inArray(callSessions.campaignContactId, contactIds)))
          .orderBy(callSessions.campaignContactId, desc(callSessions.createdAt))
      : Promise.resolve([]),
    crmStageForPeople(rows.map((row) => row.person.id)),
    campaignStats([campaignId]),
  ]);
  const latestCallByContact = new Map(latestCalls.map((call) => [call.campaignContactId as string, call]));

  const counts: Record<CampaignContactStage, number> = { ...EMPTY_COUNTS };
  for (const row of rows) counts[row.contact.stage] += 1;

  return {
    campaign: toCampaignSummary(campaignRow, counts, stats.get(campaignId) ?? { ...EMPTY_STATS }),
    contacts: rows.map((row) =>
      toCampaignContact(
        row.contact,
        row.person,
        row.company,
        latestCallByContact.get(row.contact.id) ?? null,
        crmByPerson.get(row.person.id) ?? null,
      ),
    ),
  };
}

// --- contacts ---------------------------------------------------------------

export async function addCampaignContact(campaignId: string, input: AddCampaignContactRequest): Promise<CampaignContact> {
  await assertCampaignExists(campaignId);
  const phone = normalizePhone(input.phone, await organizationPhoneCountry());
  if (!phone) throw new CallApiError(400, PHONE_HINT);
  // Typed into the form, so a website that isn't one is an error to fix,
  // not dropped the way an import's is.
  const companyDomain = websiteDomain(input.companyWebsite);
  if (input.companyWebsite?.trim() && !companyDomain) {
    throw new CallApiError(400, "Enter the company's website, like acme.com");
  }

  const { contact, alreadyInCampaign } = await insertCampaignContact(campaignId, {
    fullName: input.fullName,
    phone,
    companyName: input.companyName ?? null,
    companyDomain,
    title: input.title ?? null,
    email: normalizeEmail(input.email ?? null),
  });
  if (alreadyInCampaign) throw new CallApiError(409, "Already in this campaign");
  return contact;
}

export async function importCampaignContacts(campaignId: string, buffer: ArrayBuffer): Promise<ImportCampaignContactsResponse> {
  await assertCampaignExists(campaignId);
  let rows: ImportRow[];
  try {
    rows = parseImportRows(buffer);
  } catch (error) {
    throw new CallApiError(400, error instanceof Error ? error.message : "Unable to parse file");
  }
  if (rows.length > MAX_IMPORT_ROWS) throw new CallApiError(400, `Too many rows (max ${MAX_IMPORT_ROWS})`);

  let added = 0;
  let alreadyInCampaign = 0;
  const skipped: string[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const resolved = resolveImportRow(rows[index], rows[index].rowNumber);
    if (!resolved.ok) {
      skipped.push(resolved.message);
      continue;
    }
    try {
      const result = await insertCampaignContact(campaignId, {
        fullName: resolved.fullName,
        phone: resolved.phone,
        companyName: resolved.companyName,
        companyDomain: resolved.companyDomain,
        title: resolved.title,
        email: resolved.email,
        linkedinUrl: resolved.linkedinUrl,
      });
      if (result.alreadyInCampaign) alreadyInCampaign += 1;
      else added += 1;
    } catch (error) {
      skipped.push(`row ${index + 2}: ${error instanceof Error ? error.message : "could not be added"}`);
    }
  }

  return { added, alreadyInCampaign, skipped };
}

export async function getCampaignContactDetail(contactId: string): Promise<CampaignContactDetailResponse> {
  await expireStaleCalls();
  assertUuidShape(contactId, "Contact");
  const [row] = await db
    .select({ contact: callCampaignContacts, person: people, company: companies })
    .from(callCampaignContacts)
    .innerJoin(people, eq(callCampaignContacts.personId, people.id))
    .leftJoin(companies, eq(people.companyId, companies.id))
    .where(and(inOrg(people), contactInOrg(), eq(callCampaignContacts.id, contactId)))
    .limit(1);
  if (!row) throw new CallApiError(404, "Contact not found");

  const [calls, messages, crm] = await Promise.all([
    db.select().from(callSessions).where(and(inOrg(callSessions), eq(callSessions.campaignContactId, contactId))).orderBy(desc(callSessions.createdAt)),
    db.select().from(callMessages).where(and(inOrg(callMessages), eq(callMessages.campaignContactId, contactId))).orderBy(desc(callMessages.openedAt)),
    crmStageForPeople([row.person.id]),
  ]);

  return {
    contact: toCampaignContact(row.contact, row.person, row.company, calls[0] ?? null, crm.get(row.person.id) ?? null),
    calls: calls.map(toCallDetail),
    messages: messages.map(toCallMessageSummary),
  };
}

export async function updateCampaignContact(contactId: string, input: UpdateCampaignContactRequest): Promise<CampaignContact> {
  assertUuidShape(contactId, "Contact");
  const [contactRow] = await db.select().from(callCampaignContacts).where(and(contactInOrg(), eq(callCampaignContacts.id, contactId))).limit(1);
  if (!contactRow) throw new CallApiError(404, "Contact not found");

  const now = new Date();
  const updates: Partial<typeof callCampaignContacts.$inferInsert> = { updatedAt: now };

  // A rep's correction follows the same rules as a call's result (the retry
  // schedule, done for a wrong number); an explicit stage or date then wins.
  if (input.callStatus && input.callStatus !== contactRow.callStatus) {
    Object.assign(updates, nextContactCallState(stateOf(contactRow), input.callStatus, now, { manual: true }));
    updates.statusUpdatedAt = now;
  }
  if (input.stage) updates.stage = input.stage;
  if (input.followUpAt !== undefined) updates.followUpAt = input.followUpAt ? new Date(input.followUpAt) : null;
  if (input.notes !== undefined) updates.notes = input.notes;

  await db.update(callCampaignContacts).set(updates).where(and(contactInOrg(), eq(callCampaignContacts.id, contactId)));
  await syncCallFollowUpSafely(contactRow.personId);
  return loadCampaignContact(contactId);
}

/**
 * Takes a person off a campaign. call_messages cascade-delete with the
 * contact row (schema.ts's ON DELETE CASCADE); call_sessions keep the person
 * and get campaign_contact_id set NULL by their own FK — the calls,
 * recordings and transcripts stay on the person.
 */
export async function removeCampaignContact(contactId: string): Promise<void> {
  assertUuidShape(contactId, "Contact");
  const [deleted] = await db
    .delete(callCampaignContacts)
    .where(and(contactInOrg(), eq(callCampaignContacts.id, contactId)))
    .returning({ id: callCampaignContacts.id, personId: callCampaignContacts.personId });
  if (!deleted) throw new CallApiError(404, "Contact not found");
  await syncCallFollowUpSafely(deleted.personId);
}

/**
 * Edits the People record behind a campaign contact — shared across
 * AgentSDR, not a campaign-local copy — reusing records.ts's own building
 * blocks (upsertCompany for the company link, resolvePersonNames for the
 * first/last split) rather than a parallel implementation. Unlike
 * upsertPerson/enrichPersonById, an email that already belongs to another
 * Person is rejected with a 409 instead of merging into their identity —
 * the rep is editing this specific person's record, not resolving a dedupe.
 */
export async function updateCampaignContactPerson(
  contactId: string,
  input: UpdateCampaignContactPersonRequest,
): Promise<CampaignContact> {
  assertUuidShape(contactId, "Contact");
  const [contactRow] = await db.select().from(callCampaignContacts).where(and(contactInOrg(), eq(callCampaignContacts.id, contactId))).limit(1);
  if (!contactRow) throw new CallApiError(404, "Contact not found");
  const [personRow] = await db.select().from(people).where(and(inOrg(people), eq(people.id, contactRow.personId))).limit(1);
  if (!personRow) throw new CallApiError(404, "Contact not found");

  const resolved = resolveContactPersonUpdate(input);
  if (!resolved.ok) throw new CallApiError(400, resolved.message);
  const { fullName, phone, email } = resolved;

  await withLeadTransaction(async (tx) => {
    if (email && email !== personRow.email) {
      const [conflict] = await tx
        .select({ id: people.id })
        .from(people)
        .where(and(inOrg(people), sql`lower(${people.email}) = ${email}`, ne(people.id, personRow.id)))
        .limit(1);
      if (conflict) throw new CallApiError(409, `Another person in ${BRAND.shortName} already has this email`);
    }

    // The company path records.ts's own callers use: link/create it via
    // upsertCompany, keyed by domain — the website given, else the linked
    // company's own, else one inferred from the person's email. Without any
    // domain no company row can be identified, so, exactly as records.ts
    // does for importers, the name is kept on the person (raw.company /
    // raw.companyName, read back by personCompanyName) and the old link
    // dropped: the rep said the company is now this one.
    let companyId: string | null | undefined;
    let raw: Record<string, unknown> | undefined;
    if (input.companyName !== undefined || resolved.companyDomain !== undefined) {
      const { company: _oldName, companyName: _oldCompanyName, ...rawWithoutCompany } = personRow.raw ?? {};
      void _oldName;
      void _oldCompanyName;
      const [linked] = personRow.companyId
        ? await tx.select().from(companies).where(and(inOrg(companies), eq(companies.id, personRow.companyId))).limit(1)
        : [];
      const name = input.companyName !== undefined ? input.companyName : personCompanyName(personRow.raw, linked?.name);
      const domain =
        resolved.companyDomain !== undefined
          ? resolved.companyDomain
          : (linked?.domain ?? inferCompanyDomainFromEmail(email !== undefined ? email : personRow.email));
      if (!name && !domain) {
        companyId = null;
        raw = rawWithoutCompany;
      } else {
        const company = domain
          ? await upsertCompany(tx, { name, domain, source: "call-campaign-contact" })
          : null;
        companyId = company ? company.id : null;
        raw = company || !name ? rawWithoutCompany : { ...rawWithoutCompany, company: name, companyName: name };
      }
    }

    const names = fullName !== undefined ? resolvePersonNames({ fullName }, personRow, { replaceExisting: true }) : null;

    const updates: Partial<typeof people.$inferInsert> = { updatedAt: new Date() };
    if (email !== undefined) updates.email = email;
    if (phone !== undefined) updates.phone = phone;
    if (names) {
      updates.firstName = names.firstName;
      updates.lastName = names.lastName;
      updates.fullName = names.fullName;
    }
    if (input.title !== undefined) updates.title = input.title;
    if (resolved.profilePictureUrl !== undefined) updates.profilePictureUrl = resolved.profilePictureUrl;
    if (companyId !== undefined) updates.companyId = companyId;
    if (raw !== undefined) updates.raw = raw;

    await tx.update(people).set(updates).where(and(inOrg(people), eq(people.id, personRow.id)));
  });

  return loadCampaignContact(contactId);
}

/**
 * Stores an uploaded photo in R2 and makes it the person's photo. It is
 * served back through /api/calling/photos/<personId>/<file>, behind the
 * app's own auth, as a short-lived R2 link.
 */
export async function uploadContactPhoto(contactId: string, file: File): Promise<CampaignContact> {
  assertUuidShape(contactId, "Contact");
  const extension = photoExtensionFor(file.type);
  if (!extension) throw new CallApiError(400, "Upload a JPG, PNG, WebP or GIF image");
  if (file.size > MAX_PHOTO_BYTES) throw new CallApiError(413, "The photo must be 5 MB or smaller");
  const [contactRow] = await db
    .select({ personId: callCampaignContacts.personId })
    .from(callCampaignContacts)
    .where(and(contactInOrg(), eq(callCampaignContacts.id, contactId)))
    .limit(1);
  if (!contactRow) throw new CallApiError(404, "Contact not found");

  const name = `${crypto.randomUUID()}.${extension}`;
  await putPhoto(photoKey(contactRow.personId, name), new Uint8Array(await file.arrayBuffer()), file.type);
  await db
    .update(people)
    .set({ profilePictureUrl: `/api/calling/photos/${contactRow.personId}/${name}`, updatedAt: new Date() })
    .where(and(inOrg(people), eq(people.id, contactRow.personId)));
  return loadCampaignContact(contactId);
}

export async function logCallMessage(contactId: string, input: LogCallMessageRequest): Promise<LogCallMessageResponse> {
  assertUuidShape(contactId, "Contact");
  const [contactRow] = await db.select().from(callCampaignContacts).where(and(contactInOrg(), eq(callCampaignContacts.id, contactId))).limit(1);
  if (!contactRow) throw new CallApiError(404, "Contact not found");
  const [person] = await db.select().from(people).where(and(inOrg(people), eq(people.id, contactRow.personId))).limit(1);
  if (!person?.phone) throw new CallApiError(400, "This lead has no phone number");

  if (input.callId) {
    const [call] = await db
      .select({ id: callSessions.id, campaignContactId: callSessions.campaignContactId })
      .from(callSessions)
      .where(and(inOrg(callSessions), eq(callSessions.id, input.callId)))
      .limit(1);
    if (!call || call.campaignContactId !== contactId) throw new CallApiError(400, "callId does not belong to this contact");
  }

  const [message] = await db
    .insert(callMessages)
    .values({
      organizationId: currentOrganizationId(),
      personId: person.id,
      campaignContactId: contactId,
      callSessionId: input.callId ?? null,
      phone: person.phone,
      body: input.body,
    })
    .returning();
  if (!message) throw new Error("call_messages insert did not return a row");

  const nextStage = nextStageAfterMessage(contactRow.stage);
  if (nextStage !== contactRow.stage) {
    await db.update(callCampaignContacts).set({ stage: nextStage, updatedAt: new Date() }).where(and(contactInOrg(), eq(callCampaignContacts.id, contactId)));
  }

  return { message: toCallMessageSummary(message), contact: await loadCampaignContact(contactId) };
}

/** 404 unless the person belongs to the current organization (photo links are keyed by person id). */
export async function assertPersonInOrg(personId: string): Promise<void> {
  assertUuidShape(personId, "Photo");
  const [row] = await db.select({ id: people.id }).from(people).where(and(inOrg(people), eq(people.id, personId))).limit(1);
  if (!row) throw new CallApiError(404, "Photo not found");
}
